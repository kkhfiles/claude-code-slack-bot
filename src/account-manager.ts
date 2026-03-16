import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Logger } from './logger';

export type AccountId = 'account-1' | 'account-2' | 'account-3';

export interface AccountInfo {
  id: AccountId;
  exists: boolean;
  email?: string;
}

interface OAuthTokenData {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes?: string[];
  subscriptionType?: string;
  rateLimitTier?: string;
  email?: string;
  oauthAccount?: Record<string, unknown>; // Full ~/.claude.json oauthAccount for terminal sync
}

interface AccountsFileData {
  currentAccount: AccountId;
  accounts: Partial<Record<AccountId, OAuthTokenData>>;
}

const ACCOUNT_CHAIN: AccountId[] = ['account-1', 'account-2', 'account-3'];
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const TOKEN_EXPIRY_BUFFER_MS = 90 * 60 * 1000; // Refresh 90 minutes before expiry (> 1h health check interval)

export class AccountManager {
  private logger = new Logger('AccountManager');
  private readonly claudeDir = path.join(os.homedir(), '.claude');
  private readonly credentialsFile: string;
  private readonly accountsFile: string;

  private currentAccount: AccountId = 'account-1';
  private watchDebounceTimer?: ReturnType<typeof setTimeout>;

  constructor() {
    this.credentialsFile = path.join(this.claudeDir, '.credentials.json');
    this.accountsFile = path.join(this.claudeDir, '.bot-accounts.json');
    this.loadAccounts();
    this.startCredentialsWatcher();
  }

  /**
   * Watch .credentials.json for changes (terminal login, CLI refresh, etc.)
   * and auto-sync new tokens into .bot-accounts.json.
   * Polls every 10s — catches any token update regardless of source.
   */
  private startCredentialsWatcher(): void {
    try {
      fs.watchFile(this.credentialsFile, { interval: 10_000 }, () => {
        if (this.watchDebounceTimer) clearTimeout(this.watchDebounceTimer);
        this.watchDebounceTimer = setTimeout(() => {
          this.syncFromCredentialsFile();
        }, 1000);
      });
      this.logger.info('Started credentials file watcher');
    } catch (error) {
      this.logger.warn('Failed to start credentials watcher', error);
    }
  }

  // --- Accounts file persistence ---

  private loadAccounts(): AccountsFileData {
    try {
      if (fs.existsSync(this.accountsFile)) {
        const data: AccountsFileData = JSON.parse(fs.readFileSync(this.accountsFile, 'utf-8'));
        if (ACCOUNT_CHAIN.includes(data.currentAccount)) {
          this.currentAccount = data.currentAccount;
        }
        return data;
      }
    } catch {
      this.currentAccount = 'account-1';
    }
    return { currentAccount: this.currentAccount, accounts: {} };
  }

  private saveAccounts(data: AccountsFileData): void {
    try {
      fs.writeFileSync(this.accountsFile, JSON.stringify(data, null, 2), 'utf-8');
    } catch (error) {
      this.logger.error('Failed to save accounts file', error);
    }
  }

  // --- OAuth token refresh ---

  private async refreshOAuthToken(refreshToken: string): Promise<OAuthTokenData | null> {
    try {
      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: CLIENT_ID,
      });
      const response = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
      if (!response.ok) {
        this.logger.error('Token refresh failed', { status: response.status, statusText: response.statusText });
        return null;
      }
      const result = await response.json() as Record<string, unknown>;
      return {
        accessToken: result.access_token as string,
        refreshToken: result.refresh_token as string || refreshToken,
        expiresAt: Date.now() + (result.expires_in as number) * 1000,
      };
    } catch (error) {
      this.logger.error('Token refresh error', error);
      return null;
    }
  }

  // --- Public API ---

  getCurrentAccount(): AccountId {
    return this.currentAccount;
  }

  /** Update the tracked active account without any file operations. */
  setCurrentAccount(id: AccountId): void {
    const data = this.loadAccounts();
    this.currentAccount = id;
    data.currentAccount = id;
    this.saveAccounts(data);
  }

  getAccountList(): AccountInfo[] {
    const data = this.loadAccounts();
    return ACCOUNT_CHAIN.map(id => ({
      id,
      exists: !!data.accounts[id]?.accessToken,
      email: data.accounts[id]?.email,
    }));
  }

  /** Returns the next account in the chain that has credentials, or null if exhausted. */
  getNextAccount(): AccountId | null {
    const data = this.loadAccounts();
    const current = ACCOUNT_CHAIN.indexOf(this.currentAccount);
    for (let i = current + 1; i < ACCOUNT_CHAIN.length; i++) {
      const candidate = ACCOUNT_CHAIN[i];
      if (data.accounts[candidate]?.accessToken) {
        return candidate;
      }
    }
    return null;
  }

  /** Get a valid access token for the given account (or current account). Refreshes if expired. */
  async getAccessToken(id?: AccountId): Promise<string | null> {
    const accountId = id || this.currentAccount;
    const data = this.loadAccounts();
    const tokenData = data.accounts[accountId];
    if (!tokenData?.accessToken) return null;

    // Check expiry (with 5-minute buffer)
    if (tokenData.expiresAt && tokenData.expiresAt - TOKEN_EXPIRY_BUFFER_MS < Date.now()) {
      if (!tokenData.refreshToken) {
        this.logger.warn('Token expired but no refresh token available', { accountId });
        return null;
      }
      this.logger.info('Token expired, refreshing', { accountId });
      const refreshed = await this.refreshOAuthToken(tokenData.refreshToken);
      if (refreshed) {
        data.accounts[accountId] = { ...tokenData, ...refreshed };
        this.saveAccounts(data);
        // Sync refreshed token to .credentials.json so terminal also gets it (bot→terminal)
        if (accountId === this.currentAccount) {
          this.syncToCredentialsFile(accountId, data);
        }
        this.logger.info('Token refreshed successfully', { accountId });
        return refreshed.accessToken;
      }
      this.logger.warn('Token refresh failed, token is unusable', { accountId });
      return null;
    }

    return tokenData.accessToken;
  }

  /**
   * Check all configured accounts' token health by attempting refresh if expired.
   * Syncs from .credentials.json first to pick up any external token updates.
   * Returns list of accounts whose tokens are invalid (refresh failed).
   */
  async checkTokenHealth(): Promise<Array<{ id: AccountId; email?: string }>> {
    this.syncFromCredentialsFile();

    const data = this.loadAccounts();
    const unhealthy: Array<{ id: AccountId; email?: string }> = [];

    for (const id of ACCOUNT_CHAIN) {
      const tokenData = data.accounts[id];
      if (!tokenData?.accessToken) continue; // Not configured, skip

      // Check if token is expired or about to expire
      if (tokenData.expiresAt && tokenData.expiresAt - TOKEN_EXPIRY_BUFFER_MS < Date.now()) {
        if (!tokenData.refreshToken) {
          unhealthy.push({ id, email: tokenData.email });
          continue;
        }
        const refreshed = await this.refreshOAuthToken(tokenData.refreshToken);
        if (refreshed) {
          data.accounts[id] = { ...tokenData, ...refreshed };
          this.saveAccounts(data);
          this.logger.info('Token health check: refreshed successfully', { accountId: id });
        } else {
          unhealthy.push({ id, email: tokenData.email });
          this.logger.warn('Token health check: refresh failed', { accountId: id, email: tokenData.email });
        }
      }
    }

    return unhealthy;
  }

  /**
   * Switch to a specific account. Syncs token to .credentials.json and
   * oauthAccount to ~/.claude.json for terminal CLI.
   * No refresh here — bot and terminal share the same token to avoid
   * token rotation invalidating either side.
   */
  async switchTo(accountId: AccountId): Promise<boolean> {
    const data = this.loadAccounts();
    const tokenData = data.accounts[accountId];
    if (!tokenData?.accessToken) {
      this.logger.warn('Account not configured', { accountId });
      return false;
    }
    const prev = this.currentAccount;
    this.currentAccount = accountId;
    data.currentAccount = accountId;
    this.saveAccounts(data);

    // Sync token to .credentials.json + oauthAccount to ~/.claude.json
    this.syncToCredentialsFile(accountId, data);
    this.syncClaudeJson(tokenData);
    this.logger.info('Account switched', { from: prev, to: accountId });

    return true;
  }

  /**
   * Sync the given account's OAuth token to ~/.claude/.credentials.json
   * so that terminal CLI also uses the switched account.
   * Preserves other fields (e.g. mcpOAuth) in the credentials file.
   */
  private syncToCredentialsFile(accountId: AccountId, accountsData?: AccountsFileData): void {
    try {
      const data = accountsData || this.loadAccounts();
      const tokenData = data.accounts[accountId];
      if (!tokenData?.accessToken) return;

      // Read existing credentials file to preserve other fields (e.g. mcpOAuth)
      let credData: Record<string, unknown> = {};
      try {
        credData = JSON.parse(fs.readFileSync(this.credentialsFile, 'utf-8'));
      } catch {
        // File doesn't exist or is invalid — start fresh
      }

      // Replace only claudeAiOauth, preserve everything else
      credData.claudeAiOauth = {
        accessToken: tokenData.accessToken,
        refreshToken: tokenData.refreshToken,
        expiresAt: tokenData.expiresAt,
        ...(tokenData.scopes && { scopes: tokenData.scopes }),
        ...(tokenData.subscriptionType && { subscriptionType: tokenData.subscriptionType }),
        ...(tokenData.rateLimitTier && { rateLimitTier: tokenData.rateLimitTier }),
      };

      // Atomic write: temp file + rename to prevent JSON corruption
      const tmpFile = this.credentialsFile + '.tmp';
      fs.writeFileSync(tmpFile, JSON.stringify(credData, null, 2), 'utf-8');
      fs.renameSync(tmpFile, this.credentialsFile);
      this.logger.info('Synced credentials file', { accountId });
    } catch (error) {
      this.logger.error('Failed to sync credentials file (non-fatal)', error);
    }
  }

  /** Sync oauthAccount to ~/.claude.json so terminal shows the correct account info. */
  private syncClaudeJson(tokenData: OAuthTokenData): void {
    if (!tokenData.oauthAccount) return;
    try {
      const claudeJsonPath = path.join(os.homedir(), '.claude.json');
      let claudeJson: Record<string, unknown> = {};
      try {
        claudeJson = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8'));
      } catch { /* start fresh */ }
      claudeJson.oauthAccount = tokenData.oauthAccount;
      const tmpFile = claudeJsonPath + '.tmp';
      fs.writeFileSync(tmpFile, JSON.stringify(claudeJson, null, 2), 'utf-8');
      fs.renameSync(tmpFile, claudeJsonPath);
    } catch (error) {
      this.logger.error('Failed to sync claude.json (non-fatal)', error);
    }
  }

  /** Read the accessToken from the current credentials file (for Set wizard login detection). */
  readCurrentToken(): string | null {
    try {
      const data = JSON.parse(fs.readFileSync(this.credentialsFile, 'utf-8'));
      return data.claudeAiOauth?.accessToken || null;
    } catch { return null; }
  }

  /**
   * Sync tokens FROM .credentials.json into .bot-accounts.json (terminal→bot).
   * Reads email from ~/.claude.json to identify which account was refreshed.
   * Call before CLI spawn to pick up terminal's token refreshes.
   */
  syncFromCredentialsFile(): void {
    try {
      const credData = JSON.parse(fs.readFileSync(this.credentialsFile, 'utf-8'));
      const oauth = credData.claudeAiOauth;
      if (!oauth?.accessToken) return;

      // Read email from ~/.claude.json to identify the account
      let email: string | undefined;
      try {
        const claudeJsonPath = path.join(os.homedir(), '.claude.json');
        const claudeJson = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8'));
        email = claudeJson.oauthAccount?.emailAddress as string | undefined;
      } catch { return; } // Can't identify account without email
      if (!email) return;

      // Find matching account by email
      const data = this.loadAccounts();
      const matchingId = ACCOUNT_CHAIN.find(id => data.accounts[id]?.email === email);
      if (!matchingId) return; // No matching account

      const stored = data.accounts[matchingId]!;
      // Skip if tokens are already the same
      if (stored.accessToken === oauth.accessToken && stored.refreshToken === oauth.refreshToken) return;

      // Absorb the newer tokens from .credentials.json
      data.accounts[matchingId] = {
        ...stored,
        accessToken: oauth.accessToken,
        refreshToken: oauth.refreshToken,
        expiresAt: oauth.expiresAt,
      };
      this.saveAccounts(data);
      this.logger.info('Synced tokens from credentials file (terminal→bot)', { accountId: matchingId, email });
    } catch (error) {
      this.logger.error('Failed to sync from credentials file (non-fatal)', error);
    }
  }

  /**
   * Capture current .credentials.json token data into the given account slot.
   * Shares token chain with terminal — the file watcher keeps tokens in sync
   * when either side refreshes.
   */
  async captureForSlot(slot: AccountId): Promise<boolean> {
    try {
      const credData = JSON.parse(fs.readFileSync(this.credentialsFile, 'utf-8'));
      const oauth = credData.claudeAiOauth;
      if (!oauth?.accessToken) {
        this.logger.error('No OAuth data in credentials file');
        return false;
      }
      // Read full oauthAccount from ~/.claude.json (updated by Claude on login)
      let oauthAccount: Record<string, unknown> | undefined;
      let email: string | undefined;
      try {
        const claudeJsonPath = path.join(os.homedir(), '.claude.json');
        const claudeJson = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8'));
        oauthAccount = claudeJson.oauthAccount;
        email = oauthAccount?.emailAddress as string | undefined;
      } catch { /* ignore */ }

      const data = this.loadAccounts();
      data.accounts[slot] = {
        accessToken: oauth.accessToken,
        refreshToken: oauth.refreshToken,
        expiresAt: oauth.expiresAt,
        scopes: oauth.scopes,
        subscriptionType: oauth.subscriptionType,
        rateLimitTier: oauth.rateLimitTier,
        email,
        oauthAccount,
      };
      this.saveAccounts(data);
      this.logger.info('Captured credentials for slot', { slot, email });

      return true;
    } catch (error) {
      this.logger.error('Failed to capture slot credentials', error);
      return false;
    }
  }

  /** Switch to the next available account. Returns the new AccountId, or null if exhausted. */
  async switchToNext(): Promise<AccountId | null> {
    const next = this.getNextAccount();
    if (!next) return null;
    return (await this.switchTo(next)) ? next : null;
  }

  /** Remove credentials for a slot. */
  unsetAccount(id: AccountId): boolean {
    try {
      const data = this.loadAccounts();
      delete data.accounts[id];
      if (this.currentAccount === id) {
        this.currentAccount = 'account-1';
        data.currentAccount = 'account-1';
      }
      this.saveAccounts(data);
      this.logger.info('Account unset', { id });
      return true;
    } catch (error) {
      this.logger.error('Failed to unset account', error);
      return false;
    }
  }

  destroy(): void {
    fs.unwatchFile(this.credentialsFile);
    if (this.watchDebounceTimer) clearTimeout(this.watchDebounceTimer);
  }
}
