import { query, type SDKMessage } from '@anthropic-ai/claude-code';
import { ConversationSession } from './types';
import { Logger } from './logger';
import { McpManager } from './mcp-manager';

export { type SDKMessage };

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

  async *streamQuery(
    prompt: string,
    session?: ConversationSession,
    abortController?: AbortController,
    workingDirectory?: string,
    slackContext?: { channel: string; threadTs?: string; user: string },
    resumeOptions?: { continueLastSession?: boolean; resumeSessionId?: string },
    extraOptions?: { model?: string; maxBudgetUsd?: number }
  ): AsyncGenerator<SDKMessage, void, unknown> {
    const options: any = {
      outputFormat: 'stream-json',
      // Permission MCP server not supported on Windows; bypass for now
      permissionMode: 'bypassPermissions',
    };

    if (extraOptions?.model) {
      options.model = extraOptions.model;
    }

    if (extraOptions?.maxBudgetUsd && extraOptions.maxBudgetUsd > 0) {
      options.maxBudgetUsd = extraOptions.maxBudgetUsd;
    }

    if (workingDirectory) {
      options.cwd = workingDirectory;
    }

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

    options.abortController = abortController || new AbortController();

    try {
      for await (const message of query({
        prompt,
        options,
      })) {
        if (message.type === 'system' && message.subtype === 'init') {
          if (session) {
            session.sessionId = message.session_id;
            this.logger.info('Session initialized', {
              sessionId: message.session_id,
              model: (message as any).model,
              tools: (message as any).tools?.length || 0,
            });
          }
        }
        yield message;
      }
    } catch (error) {
      this.logger.error('Error in Claude query', error);
      throw error;
    }
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
