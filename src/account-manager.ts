import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Logger } from './logger';
import { errorCollector } from './error-collector';

// 계정 하나의 OAuth 토큰만 든다. 여러 계정 사이 전환은 2026-10-14 사용자 결정으로 걷었다 —
// 한도 소진은 엔진 폴백 · 보류 재실행이 대신한다. 파일 모양(`currentAccount` · `accounts`)은 그대로 둔다.

interface OAuthTokenData {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes?: string[];
  subscriptionType?: string;
  rateLimitTier?: string;
  email?: string;
  oauthAccount?: Record<string, unknown>; // Full ~/.claude.json oauthAccount (kept as stored)
}

interface AccountsFileData {
  currentAccount: string;
  accounts: Partial<Record<string, OAuthTokenData>>;
}

/** 토큰이 들어 있는 자리. 옛 파일과 같은 이름이라 지금 파일이 그대로 읽힌다. */
const SLOT = 'account-1';
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const TOKEN_EXPIRY_BUFFER_MS = 90 * 60 * 1000; // Refresh 90 minutes before expiry (> 1h health check interval)

export class AccountManager {
  private logger = new Logger('AccountManager');
  private readonly claudeDir = path.join(os.homedir(), '.claude');
  private readonly credentialsFile: string;
  private readonly accountsFile: string;

  private watchDebounceTimer?: ReturnType<typeof setTimeout>;

  constructor() {
    this.credentialsFile = path.join(this.claudeDir, '.credentials.json');
    this.accountsFile = path.join(this.claudeDir, '.bot-accounts.json');
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
        if (!data.accounts) data.accounts = {};
        data.currentAccount = SLOT;
        return data;
      }
    } catch { /* 깨진 파일 — 빈 것으로 본다 */ }
    return { currentAccount: SLOT, accounts: {} };
  }

  private saveAccounts(data: AccountsFileData): void {
    try {
      fs.writeFileSync(this.accountsFile, JSON.stringify(data, null, 2), 'utf-8');
    } catch (error) {
      errorCollector.add('AccountManager', `계정 파일 저장 실패: ${(error as Error).message}`);
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
        errorCollector.add('AccountManager', `토큰 갱신 실패 (HTTP ${response.status})`);
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
      errorCollector.add('AccountManager', `토큰 갱신 에러: ${(error as Error).message}`);
      this.logger.error('Token refresh error', error);
      return null;
    }
  }

  // --- Public API ---

  /**
   * After refreshing a token, sync it to .credentials.json if the stored account
   * is the one active on the terminal (matched by email from ~/.claude.json).
   * Ensures any refresh — health check, CLI spawn, etc. — propagates to all consumers.
   */
  private syncToCredentialsIfActive(data: AccountsFileData): void {
    try {
      const tokenData = data.accounts[SLOT];
      if (!tokenData?.email) return;
      if (tokenData.email === this.getTerminalActiveEmail()) {
        this.syncToCredentialsFile(data);
      }
    } catch { /* non-fatal */ }
  }

  /** Get a valid access token for the stored account. Refreshes if expired. */
  async getAccessToken(): Promise<string | null> {
    const data = this.loadAccounts();
    const tokenData = data.accounts[SLOT];
    if (!tokenData?.accessToken) return null;

    // Check expiry (with proactive buffer)
    if (tokenData.expiresAt && tokenData.expiresAt - TOKEN_EXPIRY_BUFFER_MS < Date.now()) {
      // Skip proactive refresh for terminal's active account if token is still valid —
      // our refresh would invalidate the terminal's in-memory refresh token via OAuth rotation
      const terminalEmail = this.getTerminalActiveEmail();
      if (tokenData.email && tokenData.email === terminalEmail && tokenData.expiresAt > Date.now()) {
        this.logger.debug('Skipping proactive refresh for terminal active account');
        return tokenData.accessToken;
      }

      if (!tokenData.refreshToken) {
        this.logger.warn('Token expired but no refresh token available');
        return null;
      }
      this.logger.info('Token expired, refreshing');
      const refreshed = await this.refreshOAuthToken(tokenData.refreshToken);
      if (refreshed) {
        data.accounts[SLOT] = { ...tokenData, ...refreshed };
        this.saveAccounts(data);
        this.syncToCredentialsIfActive(data);
        this.logger.info('Token refreshed successfully');
        return refreshed.accessToken;
      }
      this.logger.warn('Token refresh failed, token is unusable');
      return null;
    }

    return tokenData.accessToken;
  }

  /**
   * Check the stored account's token health by attempting refresh if expired.
   * Syncs from .credentials.json first to pick up any external token updates.
   * Returns the account if its token is invalid (refresh failed), else an empty list.
   */
  async checkTokenHealth(): Promise<Array<{ id: string; email?: string }>> {
    this.syncFromCredentialsFile();

    const data = this.loadAccounts();
    const tokenData = data.accounts[SLOT];
    if (!tokenData?.accessToken) return []; // Not configured, skip

    // Don't proactively refresh terminal's active account if its token is still valid —
    // terminal manages its own refresh, and our refresh would invalidate its in-memory
    // refresh token via OAuth rotation
    const terminalEmail = this.getTerminalActiveEmail();
    if (tokenData.email && tokenData.email === terminalEmail
        && tokenData.expiresAt && tokenData.expiresAt > Date.now()) {
      this.logger.debug('Health check: skipping terminal active account');
      return [];
    }

    // Check if token is expired or about to expire
    if (tokenData.expiresAt && tokenData.expiresAt - TOKEN_EXPIRY_BUFFER_MS < Date.now()) {
      if (!tokenData.refreshToken) return [{ id: SLOT, email: tokenData.email }];
      const refreshed = await this.refreshOAuthToken(tokenData.refreshToken);
      if (refreshed) {
        data.accounts[SLOT] = { ...tokenData, ...refreshed };
        this.saveAccounts(data);
        this.syncToCredentialsIfActive(data);
        this.logger.info('Token health check: refreshed successfully');
      } else {
        this.logger.warn('Token health check: refresh failed', { email: tokenData.email });
        return [{ id: SLOT, email: tokenData.email }];
      }
    }

    return [];
  }

  /**
   * Write the stored account's OAuth token to ~/.claude/.credentials.json
   * so that terminal CLI picks up the bot's refresh.
   * Preserves other fields (e.g. mcpOAuth) in the credentials file.
   */
  private syncToCredentialsFile(accountsData?: AccountsFileData): void {
    try {
      const data = accountsData || this.loadAccounts();
      const tokenData = data.accounts[SLOT];
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
      this.logger.info('Synced credentials file');
    } catch (error) {
      errorCollector.add('AccountManager', `자격 증명 파일 동기화 실패: ${(error as Error).message}`);
      this.logger.error('Failed to sync credentials file (non-fatal)', error);
    }
  }

  /** Read terminal's active account email from ~/.claude.json */
  private getTerminalActiveEmail(): string | null {
    try {
      const claudeJsonPath = path.join(os.homedir(), '.claude.json');
      const claudeJson = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8'));
      return (claudeJson.oauthAccount?.emailAddress as string) || null;
    } catch {
      return null;
    }
  }

  /**
   * Sync tokens FROM .credentials.json into .bot-accounts.json (terminal→bot).
   * Reads email from ~/.claude.json and only absorbs tokens of the same account.
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

      const data = this.loadAccounts();
      const stored = data.accounts[SLOT];
      if (!stored || stored.email !== email) return; // Terminal is on another account

      // Skip if tokens are already the same
      if (stored.accessToken === oauth.accessToken && stored.refreshToken === oauth.refreshToken) return;

      // Absorb the newer tokens from .credentials.json
      data.accounts[SLOT] = {
        ...stored,
        accessToken: oauth.accessToken,
        refreshToken: oauth.refreshToken,
        expiresAt: oauth.expiresAt,
      };
      this.saveAccounts(data);
      this.logger.info('Synced tokens from credentials file (terminal→bot)');
    } catch (error) {
      const msg = (error as Error).message || '';
      if (msg.includes('ENOENT')) {
        this.logger.debug('Credentials file not found (non-fatal)', { path: this.credentialsFile });
      } else {
        errorCollector.add('AccountManager', `자격 증명 역동기화 실패: ${msg}`);
        this.logger.error('Failed to sync from credentials file (non-fatal)', error);
      }
    }
  }

  destroy(): void {
    fs.unwatchFile(this.credentialsFile);
    if (this.watchDebounceTimer) clearTimeout(this.watchDebounceTimer);
  }
}
