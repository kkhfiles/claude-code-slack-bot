import { query, type SDKMessage, type Query, type CanUseTool, type PermissionMode, type PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { ConversationSession } from './types';
import { Logger } from './logger';
import { McpManager } from './mcp-manager';
import * as fs from 'fs';
import * as path from 'path';

export { type SDKMessage, type Query, type CanUseTool, type PermissionMode, type PermissionResult };

interface PersistedSession {
  sessionId: string;
  lastAssistantUuid?: string;
  savedAt: string;
}

export class ClaudeHandler {
  private sessions: Map<string, ConversationSession> = new Map();
  private logger = new Logger('ClaudeHandler');
  private mcpManager: McpManager;

  private readonly SESSION_STATE_FILE = path.join(__dirname, '..', '.session-state.json');
  private readonly SESSION_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(mcpManager: McpManager) {
    this.mcpManager = mcpManager;
    this.loadFromDisk();
  }

  getSessionKey(userId: string, channelId: string, threadTs?: string): string {
    return `${userId}-${channelId}-${threadTs || 'direct'}`;
  }

  getSession(userId: string, channelId: string, threadTs?: string): ConversationSession | undefined {
    return this.sessions.get(this.getSessionKey(userId, channelId, threadTs));
  }

  createSession(userId: string, channelId: string, threadTs?: string): ConversationSession {
    const key = this.getSessionKey(userId, channelId, threadTs);

    // Check if a persisted session exists for this key
    const existing = this.sessions.get(key);
    if (existing?.sessionId) {
      this.logger.info('Restoring persisted session', { sessionId: existing.sessionId, key });
      existing.isActive = true;
      existing.lastActivity = new Date();
      return existing;
    }

    const session: ConversationSession = {
      userId,
      channelId,
      threadTs,
      isActive: true,
      lastActivity: new Date(),
    };
    this.sessions.set(key, session);
    return session;
  }

  removeSession(userId: string, channelId: string, threadTs?: string): boolean {
    const key = this.getSessionKey(userId, channelId, threadTs);
    const deleted = this.sessions.delete(key);
    if (deleted) this.saveToDisk();
    return deleted;
  }

  /**
   * Save session state to disk (debounced — at most once per 5 seconds).
   */
  scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveToDisk();
    }, 5000);
  }

  /**
   * Save session state to disk immediately.
   */
  saveNow(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.saveToDisk();
  }

  /**
   * Build and return a Query object for direct iteration.
   * The caller is responsible for iterating the Query, handling session init,
   * and storing the Query reference for interrupt().
   */
  buildQuery(
    prompt: string,
    opts: {
      session?: ConversationSession;
      abortController?: AbortController;
      workingDirectory?: string;
      resumeOptions?: { continueLastSession?: boolean; resumeSessionId?: string };
      model?: string;
      maxBudgetUsd?: number;
      permissionMode?: PermissionMode;
      canUseTool?: CanUseTool;
    } = {}
  ): Query {
    const permissionMode = opts.permissionMode || 'default';
    const options: any = {
      permissionMode,
      includePartialMessages: true,
      systemPrompt: { type: 'preset', preset: 'claude_code' },
    };

    // Required for bypassPermissions mode in new SDK
    if (permissionMode === 'bypassPermissions') {
      options.allowDangerouslySkipPermissions = true;
    }

    if (opts.model) options.model = opts.model;
    if (opts.maxBudgetUsd && opts.maxBudgetUsd > 0) {
      options.maxBudgetUsd = opts.maxBudgetUsd;
    }
    if (opts.workingDirectory) options.cwd = opts.workingDirectory;
    if (opts.canUseTool) options.canUseTool = opts.canUseTool;
    if (opts.abortController) options.abortController = opts.abortController;

    // Add MCP server configuration if available
    const mcpServers = this.mcpManager.getServerConfiguration();
    if (mcpServers && Object.keys(mcpServers).length > 0) {
      options.mcpServers = mcpServers;

      const defaultMcpTools = this.mcpManager.getDefaultAllowedTools();
      if (defaultMcpTools.length > 0) {
        options.allowedTools = defaultMcpTools;
      }

      this.logger.debug('Added MCP configuration to options', {
        serverCount: Object.keys(options.mcpServers).length,
        servers: Object.keys(options.mcpServers),
        allowedTools: defaultMcpTools,
      });
    }

    // Resume priority: explicit resumeOptions > Slack session
    const { session, resumeOptions } = opts;
    if (resumeOptions?.resumeSessionId) {
      options.resume = resumeOptions.resumeSessionId;
      this.logger.info('Resuming external session', { sessionId: resumeOptions.resumeSessionId });
    } else if (resumeOptions?.continueLastSession) {
      options.continue = true;
      this.logger.info('Continuing last CLI session');
    } else if (session?.sessionId) {
      options.resume = session.sessionId;
      if (session.lastAssistantUuid) {
        options.resumeSessionAt = session.lastAssistantUuid;
        this.logger.debug('Resuming Slack session at message', { sessionId: session.sessionId, resumeAt: session.lastAssistantUuid });
      } else {
        this.logger.debug('Resuming Slack session', { sessionId: session.sessionId });
      }
    } else {
      this.logger.debug('Starting new Claude conversation');
    }

    this.logger.debug('Claude query options', options);

    return query({ prompt, options });
  }

  cleanupInactiveSessions(maxAge: number = 0) {
    if (maxAge <= 0) return; // Disabled by default
    const now = Date.now();
    let cleaned = 0;
    for (const [key, session] of this.sessions.entries()) {
      if (now - session.lastActivity.getTime() > maxAge) {
        this.sessions.delete(key);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      this.logger.info(`Cleaned up ${cleaned} inactive sessions`);
      this.saveToDisk();
    }
  }

  private loadFromDisk(): void {
    try {
      if (!fs.existsSync(this.SESSION_STATE_FILE)) return;
      const raw = fs.readFileSync(this.SESSION_STATE_FILE, 'utf-8');
      const data: Record<string, PersistedSession> = JSON.parse(raw);
      const now = Date.now();
      let loaded = 0;
      let skipped = 0;

      for (const [key, persisted] of Object.entries(data)) {
        const savedAt = new Date(persisted.savedAt).getTime();
        if (now - savedAt > this.SESSION_MAX_AGE) {
          skipped++;
          continue;
        }

        // Parse key: userId-channelId-threadTs
        const parts = key.split('-');
        if (parts.length < 2) continue;
        const userId = parts[0];
        const channelId = parts[1];
        const threadTs = parts.slice(2).join('-');

        this.sessions.set(key, {
          userId,
          channelId,
          threadTs: threadTs === 'direct' ? undefined : threadTs,
          sessionId: persisted.sessionId,
          lastAssistantUuid: persisted.lastAssistantUuid,
          isActive: false,
          lastActivity: new Date(persisted.savedAt),
        });
        loaded++;
      }

      if (loaded > 0 || skipped > 0) {
        this.logger.info(`Loaded session state from disk`, { loaded, skipped });
      }
    } catch (error) {
      this.logger.error('Failed to load session state from disk', error);
    }
  }

  private saveToDisk(): void {
    try {
      const data: Record<string, PersistedSession> = {};
      for (const [key, session] of this.sessions.entries()) {
        if (!session.sessionId) continue; // Only persist sessions with a sessionId
        data[key] = {
          sessionId: session.sessionId,
          lastAssistantUuid: session.lastAssistantUuid,
          savedAt: session.lastActivity.toISOString(),
        };
      }
      fs.writeFileSync(this.SESSION_STATE_FILE, JSON.stringify(data, null, 2), 'utf-8');
    } catch (error) {
      this.logger.error('Failed to save session state to disk', error);
    }
  }
}
