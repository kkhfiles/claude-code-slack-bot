import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Logger } from './logger';

export type AccountId = 'account-1' | 'account-2' | 'account-3';

export interface AccountInfo {
  id: AccountId;
  file: string;
  exists: boolean;
}

const ACCOUNT_CHAIN: AccountId[] = ['account-1', 'account-2', 'account-3'];

export class AccountManager {
  private logger = new Logger('AccountManager');
  private readonly claudeDir = path.join(os.homedir(), '.claude');
  private readonly credentialsFile: string;
  private readonly stateFile: string;

  private currentAccount: AccountId = 'account-1';
  private watcher: fs.FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private isSwitching = false;
  private syncPaused = false;

  constructor() {
    this.credentialsFile = path.join(this.claudeDir, '.credentials.json');
    this.stateFile = path.join(path.resolve(__dirname, '..'), '.account-state.json');
    this.loadState();
    this.startWatcher();
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
      this.currentAccount = 'account-1';
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
    return path.join(this.claudeDir, `.credentials.${accountId}.json`);
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

  /** Pause auto-sync during guided setup. */
  pauseSync(): void { this.syncPaused = true; }

  /** Resume auto-sync and immediately flush current credentials to active account backup. */
  resumeSync(): void {
    this.syncPaused = false;
    this.syncBackupFile();
  }

  private syncBackupFile(): void {
    if (this.isSwitching || this.syncPaused) return;
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

  /** Update the tracked active account without any file operations. */
  setCurrentAccount(id: AccountId): void {
    this.currentAccount = id;
    this.saveState();
  }

  getAccountList(): AccountInfo[] {
    return ACCOUNT_CHAIN.map(id => ({
      id,
      file: this.getBackupFile(id),
      exists: fs.existsSync(this.getBackupFile(id)),
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

  /** Read the accessToken from the current credentials file (for change detection). */
  readCurrentToken(): string | null {
    try {
      const data = JSON.parse(fs.readFileSync(this.credentialsFile, 'utf-8'));
      return data.claudeAiOauth?.accessToken || null;
    } catch { return null; }
  }

  /** Copy current credentials.json to the given slot's backup file. */
  captureForSlot(slot: AccountId): boolean {
    try {
      fs.copyFileSync(this.credentialsFile, this.getBackupFile(slot));
      this.logger.info('Captured credentials for slot', { slot });
      return true;
    } catch (error) {
      this.logger.error('Failed to capture slot credentials', error);
      return false;
    }
  }

  /** Switch to the next available account. Returns the new AccountId, or null if exhausted. */
  switchToNext(): AccountId | null {
    const next = this.getNextAccount();
    if (!next) return null;
    return this.switchTo(next) ? next : null;
  }

  /** Delete the credentials backup file for a slot. */
  unsetAccount(id: AccountId): boolean {
    const file = this.getBackupFile(id);
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file);
      if (this.currentAccount === id) {
        this.currentAccount = 'account-1';
        this.saveState();
      }
      this.logger.info('Account unset', { id });
      return true;
    } catch (error) {
      this.logger.error('Failed to unset account', error);
      return false;
    }
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
