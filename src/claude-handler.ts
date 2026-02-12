import { query, type SDKMessage, type Query, type CanUseTool, type PermissionMode, type PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { ConversationSession } from './types';
import { Logger } from './logger';
import { McpManager } from './mcp-manager';

export { type SDKMessage, type Query, type CanUseTool, type PermissionMode, type PermissionResult };

export class ClaudeHandler {
  private sessions: Map<string, ConversationSession> = new Map();
  private logger = new Logger('ClaudeHandler');
  private mcpManager: McpManager;

  constructor(mcpManager: McpManager) {
    this.mcpManager = mcpManager;
  }

  getSessionKey(userId: string, channelId: string, threadTs?: string): string {
    return `${userId}-${channelId}-${threadTs || 'direct'}`;
  }

  getSession(userId: string, channelId: string, threadTs?: string): ConversationSession | undefined {
    return this.sessions.get(this.getSessionKey(userId, channelId, threadTs));
  }

  createSession(userId: string, channelId: string, threadTs?: string): ConversationSession {
    const session: ConversationSession = {
      userId,
      channelId,
      threadTs,
      isActive: true,
      lastActivity: new Date(),
    };
    this.sessions.set(this.getSessionKey(userId, channelId, threadTs), session);
    return session;
  }

  removeSession(userId: string, channelId: string, threadTs?: string): boolean {
    const key = this.getSessionKey(userId, channelId, threadTs);
    return this.sessions.delete(key);
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
      this.logger.debug('Resuming Slack session', { sessionId: session.sessionId });
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
    }
  }
}
