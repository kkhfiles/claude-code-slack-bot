import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Logger } from './logger';

export type AccountId = 'primary' | 'account-1' | 'account-2' | 'account-3';

export interface AccountInfo {
  id: AccountId;
  file: string;
  exists: boolean;
}

const ACCOUNT_CHAIN: AccountId[] = ['primary', 'account-1', 'account-2', 'account-3'];

export class AccountManager {
  private logger = new Logger('AccountManager');
  private readonly claudeDir = path.join(os.homedir(), '.claude');
  private readonly credentialsFile: string;
  private readonly stateFile: string;

  private currentAccount: AccountId = 'primary';
  private watcher: fs.FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private isSwitching = false;

  constructor() {
    this.credentialsFile = path.join(this.claudeDir, '.credentials.json');
    this.stateFile = path.join(path.resolve(__dirname, '..'), '.account-state.json');
    this.loadState();
    this.startWatcher();
    // Ensure primary backup exists on startup
    this.ensurePrimaryBackup();
  }

  // --- State persistence ---

  private loadState(): void {
    try {
      if (fs.existsSync(this.stateFile)) {
        const data = JSON.parse(fs.readFileSync(this.stateFile, 'utf-8'));
        if (ACCOUNT_CHAIN.includes(data.currentAccount)) {
          this.currentAccount = data.currentAccount;
        }
      }
    } catch {
      this.currentAccount = 'primary';
    }
  }

  private saveState(): void {
    try {
      fs.writeFileSync(this.stateFile, JSON.stringify({ currentAccount: this.currentAccount }, null, 2), 'utf-8');
    } catch (error) {
      this.logger.error('Failed to save account state', error);
    }
  }

  // --- Backup file paths ---

  private getBackupFile(accountId: AccountId): string {
    if (accountId === 'primary') {
      return path.join(this.claudeDir, '.credentials.primary-backup.json');
    }
    return path.join(this.claudeDir, `.credentials.${accountId}.json`);
  }

  private ensurePrimaryBackup(): void {
    const backupFile = this.getBackupFile('primary');
    if (!fs.existsSync(backupFile) && fs.existsSync(this.credentialsFile) && this.currentAccount === 'primary') {
      try {
        fs.copyFileSync(this.credentialsFile, backupFile);
        this.logger.info('Created primary credentials backup');
      } catch (error) {
        this.logger.warn('Failed to create primary credentials backup', error);
      }
    }
  }

  // --- File watcher (sync backup when token is refreshed) ---

  private startWatcher(): void {
    if (!fs.existsSync(this.claudeDir)) {
      this.logger.warn('~/.claude directory not found, watcher not started');
      return;
    }
    try {
      // Watch directory rather than file — handles atomic rename-based writes
      this.watcher = fs.watch(this.claudeDir, (eventType, filename) => {
        if (filename !== '.credentials.json') return;
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => this.syncBackupFile(), 500);
      });
      this.logger.info('Credentials watcher started', { account: this.currentAccount });
    } catch (error) {
      this.logger.warn('Failed to start credentials watcher', error);
    }
  }

  private syncBackupFile(): void {
    if (this.isSwitching) return; // Don't sync during account switch
    try {
      if (!fs.existsSync(this.credentialsFile)) return;
      const backupFile = this.getBackupFile(this.currentAccount);
      fs.copyFileSync(this.credentialsFile, backupFile);
      this.logger.debug('Synced credentials to backup', { account: this.currentAccount });
    } catch (error) {
      this.logger.warn('Failed to sync credentials backup', error);
    }
  }

  // --- Public API ---

  getCurrentAccount(): AccountId {
    return this.currentAccount;
  }

  getAccountList(): AccountInfo[] {
    return ACCOUNT_CHAIN.map(id => ({
      id,
      file: this.getBackupFile(id),
      exists: id === 'primary'
        ? fs.existsSync(this.getBackupFile('primary'))
        : fs.existsSync(this.getBackupFile(id)),
    }));
  }

  /** Returns the next account in the chain that has a credentials file, or null if exhausted. */
  getNextAccount(): AccountId | null {
    const current = ACCOUNT_CHAIN.indexOf(this.currentAccount);
    for (let i = current + 1; i < ACCOUNT_CHAIN.length; i++) {
      const candidate = ACCOUNT_CHAIN[i];
      if (fs.existsSync(this.getBackupFile(candidate))) {
        return candidate;
      }
    }
    return null;
  }

  /** Switch to a specific account. Returns true on success. */
  switchTo(accountId: AccountId): boolean {
    const backupFile = this.getBackupFile(accountId);
    if (!fs.existsSync(backupFile)) {
      this.logger.warn('Account credentials file not found', { accountId, file: backupFile });
      return false;
    }

    this.isSwitching = true;
    try {
      // Flush current credentials to current account's backup before switching
      if (fs.existsSync(this.credentialsFile)) {
        fs.copyFileSync(this.credentialsFile, this.getBackupFile(this.currentAccount));
      }
      // Copy new account credentials
      fs.copyFileSync(backupFile, this.credentialsFile);
      const prev = this.currentAccount;
      this.currentAccount = accountId;
      this.saveState();
      this.logger.info('Account switched', { from: prev, to: accountId });
      return true;
    } catch (error) {
      this.logger.error('Failed to switch account', error);
      return false;
    } finally {
      // Delay flag reset to suppress watcher events triggered by the file copy
      setTimeout(() => { this.isSwitching = false; }, 1000);
    }
  }

  /** Switch to the next available account. Returns the new AccountId, or null if exhausted. */
  switchToNext(): AccountId | null {
    const next = this.getNextAccount();
    if (!next) return null;
    return this.switchTo(next) ? next : null;
  }

  destroy(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
  }
}
