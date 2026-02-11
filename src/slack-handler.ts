import { App } from '@slack/bolt';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ClaudeHandler, type SDKMessage, type Query, type CanUseTool, type PermissionMode, type PermissionResult } from './claude-handler';
import { Logger } from './logger';
import { WorkingDirectoryManager } from './working-directory-manager';
import { FileHandler, ProcessedFile } from './file-handler';
import { TodoManager, Todo } from './todo-manager';
import { McpManager } from './mcp-manager';
import { config } from './config';

interface MessageEvent {
  user: string;
  channel: string;
  thread_ts?: string;
  ts: string;
  text?: string;
  files?: Array<{
    id: string;
    name: string;
    mimetype: string;
    filetype: string;
    url_private: string;
    url_private_download: string;
    size: number;
  }>;
}

export class SlackHandler {
  private app: App;
  private claudeHandler: ClaudeHandler;
  private logger = new Logger('SlackHandler');
  private workingDirManager: WorkingDirectoryManager;
  private fileHandler: FileHandler;
  private todoManager: TodoManager;
  private mcpManager: McpManager;

  // Active query tracking (for interrupt/stop)
  private activeQueries: Map<string, Query> = new Map();
  private activeControllers: Map<string, AbortController> = new Map();

  // UI state
  private todoMessages: Map<string, string> = new Map();
  private originalMessages: Map<string, { channel: string; ts: string }> = new Map();
  private currentReactions: Map<string, string> = new Map();

  // Per-channel settings
  private channelModels: Map<string, string> = new Map();
  private channelBudgets: Map<string, number> = new Map();
  private channelPermissionModes: Map<string, PermissionMode> = new Map();
  private lastQueryCosts: Map<string, { cost: number; duration: number; model: string; sessionId: string }> = new Map();

  // Interactive approval for canUseTool
  private pendingApprovals: Map<string, {
    resolve: (result: PermissionResult) => void;
    timeout: ReturnType<typeof setTimeout>;
  }> = new Map();

  // Rate limit retry
  private pendingRetries: Map<string, { prompt: string; channel: string; threadTs: string; user: string }> = new Map();

  // Plan mode: store session info for "Execute" button
  private pendingPlans: Map<string, { sessionId: string; prompt: string; channel: string; threadTs: string; user: string }> = new Map();

  private botUserId: string | null = null;

  constructor(app: App, claudeHandler: ClaudeHandler, mcpManager: McpManager) {
    this.app = app;
    this.claudeHandler = claudeHandler;
    this.mcpManager = mcpManager;
    this.workingDirManager = new WorkingDirectoryManager();
    this.fileHandler = new FileHandler();
    this.todoManager = new TodoManager();
  }

  async handleMessage(event: MessageEvent, say: any) {
    const { user, channel, thread_ts, ts, text, files } = event;

    // Process any attached files
    let processedFiles: ProcessedFile[] = [];
    if (files && files.length > 0) {
      this.logger.info('Processing uploaded files', { count: files.length });
      processedFiles = await this.fileHandler.downloadAndProcessFiles(files);

      if (processedFiles.length > 0) {
        await say({
          text: `📎 Processing ${processedFiles.length} file(s): ${processedFiles.map(f => f.name).join(', ')}`,
          thread_ts: thread_ts || ts,
        });
      }
    }

    // If no text and no files, nothing to process
    if (!text && processedFiles.length === 0) return;

    this.logger.debug('Received message from Slack', {
      user,
      channel,
      thread_ts,
      ts,
      text: text ? text.substring(0, 100) + (text.length > 100 ? '...' : '') : '[no text]',
      fileCount: processedFiles.length,
    });

    // --- Command routing ---

    // Working directory commands
    const setDirPath = text ? this.workingDirManager.parseSetCommand(text) : null;
    if (setDirPath) {
      const isDM = channel.startsWith('D');
      const result = this.workingDirManager.setWorkingDirectory(channel, setDirPath, thread_ts, isDM ? user : undefined);
      if (result.success) {
        const context = thread_ts ? 'this thread' : (isDM ? 'this conversation' : 'this channel');
        await say({ text: `✅ Working directory set for ${context}: \`${result.resolvedPath}\``, thread_ts: thread_ts || ts });
      } else {
        await say({ text: `❌ ${result.error}`, thread_ts: thread_ts || ts });
      }
      return;
    }

    if (text && this.workingDirManager.isGetCommand(text)) {
      const isDM = channel.startsWith('D');
      const directory = this.workingDirManager.getWorkingDirectory(channel, thread_ts, isDM ? user : undefined);
      const context = thread_ts ? 'this thread' : (isDM ? 'this conversation' : 'this channel');
      await say({ text: this.workingDirManager.formatDirectoryMessage(directory, context), thread_ts: thread_ts || ts });
      return;
    }

    // MCP commands
    if (text && this.isMcpInfoCommand(text)) {
      await say({ text: this.mcpManager.formatMcpInfo(), thread_ts: thread_ts || ts });
      return;
    }
    if (text && this.isMcpReloadCommand(text)) {
      const reloaded = this.mcpManager.reloadConfiguration();
      await say({
        text: reloaded
          ? `✅ MCP configuration reloaded successfully.\n\n${this.mcpManager.formatMcpInfo()}`
          : `❌ Failed to reload MCP configuration. Check the mcp-servers.json file.`,
        thread_ts: thread_ts || ts,
      });
      return;
    }

    // Stop command (interrupt running query)
    if (text && this.isStopCommand(text)) {
      const sessionKey = this.claudeHandler.getSessionKey(user, channel, thread_ts || ts);
      const activeQuery = this.activeQueries.get(sessionKey);
      const controller = this.activeControllers.get(sessionKey);
      if (activeQuery) {
        try {
          await activeQuery.interrupt();
        } catch {
          controller?.abort();
        }
        this.activeQueries.delete(sessionKey);
        this.activeControllers.delete(sessionKey);
        await say({ text: `⏹️ Stopped.`, thread_ts: thread_ts || ts });
      } else {
        await say({ text: `ℹ️ No active query to stop.`, thread_ts: thread_ts || ts });
      }
      return;
    }

    // Help command
    if (text && this.isHelpCommand(text)) {
      await say({ text: this.getHelpText(), thread_ts: thread_ts || ts });
      return;
    }

    // Reset command
    if (text && this.isResetCommand(text)) {
      this.claudeHandler.removeSession(user, channel, thread_ts || ts);
      this.lastQueryCosts.delete(channel);
      await say({
        text: `🔄 Session reset. Next message will start a new conversation.`,
        thread_ts: thread_ts || ts,
      });
      return;
    }

    // Model command
    if (text) {
      const modelArg = this.parseModelCommand(text);
      if (modelArg !== null) {
        if (modelArg === '') {
          const current = this.channelModels.get(channel) || 'default (determined by Claude Code)';
          await say({ text: `🤖 Current model: \`${current}\``, thread_ts: thread_ts || ts });
        } else {
          this.channelModels.set(channel, modelArg);
          await say({ text: `🤖 Model set to \`${modelArg}\``, thread_ts: thread_ts || ts });
        }
        return;
      }
    }

    // Budget command
    if (text) {
      const budgetArg = this.parseBudgetCommand(text);
      if (budgetArg !== null) {
        if (budgetArg === -1) {
          const current = this.channelBudgets.get(channel);
          await say({
            text: current ? `💰 Max budget: $${current.toFixed(2)} per query` : `💰 No budget limit set`,
            thread_ts: thread_ts || ts,
          });
        } else if (budgetArg === 0) {
          this.channelBudgets.delete(channel);
          await say({ text: `💰 Budget limit removed`, thread_ts: thread_ts || ts });
        } else {
          this.channelBudgets.set(channel, budgetArg);
          await say({ text: `💰 Max budget set to $${budgetArg.toFixed(2)} per query`, thread_ts: thread_ts || ts });
        }
        return;
      }
    }

    // Permission mode commands: -safe / -trust
    if (text && this.isSafeCommand(text)) {
      this.channelPermissionModes.set(channel, 'acceptEdits');
      await say({ text: `🛡️ Safe mode ON — Bash commands will require approval.\nUse \`-trust\` to switch back.`, thread_ts: thread_ts || ts });
      return;
    }
    if (text && this.isTrustCommand(text)) {
      this.channelPermissionModes.set(channel, 'bypassPermissions');
      await say({ text: `⚡ Trust mode ON — All tools auto-approved.\nUse \`-safe\` to require approvals.`, thread_ts: thread_ts || ts });
      return;
    }

    // Sessions command
    if (text && this.isSessionsCommand(text)) {
      const isDMForSessions = channel.startsWith('D');
      const cwdForSessions = this.workingDirManager.getWorkingDirectory(channel, thread_ts, isDMForSessions ? user : undefined);
      if (cwdForSessions) {
        const sessions = this.listSessions(cwdForSessions);
        await say({ text: this.formatSessionsList(sessions), thread_ts: thread_ts || ts });
      } else {
        await say({ text: `⚠️ Set a working directory first (\`-cwd <path>\`) to list sessions.`, thread_ts: thread_ts || ts });
      }
      return;
    }

    // Cost command
    if (text && this.isCostCommand(text)) {
      const costInfo = this.lastQueryCosts.get(channel);
      if (costInfo) {
        let msg = `💵 *Last query*\n`;
        msg += `• Cost: $${costInfo.cost.toFixed(4)}\n`;
        msg += `• Duration: ${(costInfo.duration / 1000).toFixed(1)}s\n`;
        msg += `• Model: \`${costInfo.model}\`\n`;
        msg += `• Session ID: \`${costInfo.sessionId}\``;
        await say({ text: msg, thread_ts: thread_ts || ts });
      } else {
        await say({ text: `ℹ️ No query cost data yet.`, thread_ts: thread_ts || ts });
      }
      return;
    }

    // Resume/continue command
    const resumeParsed = text ? this.parseResumeCommand(text) : null;

    // Plan command: -plan <prompt>
    const planParsed = text ? this.parsePlanCommand(text) : null;

    // --- Working directory check ---
    const isDM = channel.startsWith('D');
    const workingDirectory = this.workingDirManager.getWorkingDirectory(channel, thread_ts, isDM ? user : undefined);

    if (!workingDirectory) {
      let errorMessage = `⚠️ No working directory set. `;
      if (!isDM && !this.workingDirManager.hasChannelWorkingDirectory(channel)) {
        errorMessage += `Please set a default working directory for this channel first using:\n`;
        if (config.baseDirectory) {
          errorMessage += `\`-cwd project-name\` or \`-cwd /absolute/path\`\n\nBase directory: \`${config.baseDirectory}\``;
        } else {
          errorMessage += `\`-cwd /path/to/directory\``;
        }
      } else if (thread_ts) {
        errorMessage += `You can set a thread-specific working directory using:\n\`-cwd /path/to/directory\``;
      } else {
        errorMessage += `Please set one first using:\n\`-cwd /path/to/directory\``;
      }
      await say({ text: errorMessage, thread_ts: thread_ts || ts });
      return;
    }

    // --- Main query execution ---
    const sessionKey = this.claudeHandler.getSessionKey(user, channel, thread_ts || ts);
    const originalMessageTs = thread_ts || ts;
    this.originalMessages.set(sessionKey, { channel, ts: originalMessageTs });

    // Cancel any existing request for this conversation
    const existingQuery = this.activeQueries.get(sessionKey);
    if (existingQuery) {
      this.logger.debug('Cancelling existing request for session', { sessionKey });
      try { await existingQuery.interrupt(); } catch { /* ignore */ }
    }

    const abortController = new AbortController();
    this.activeControllers.set(sessionKey, abortController);

    let session = this.claudeHandler.getSession(user, channel, thread_ts || ts);
    if (!session) {
      session = this.claudeHandler.createSession(user, channel, thread_ts || ts);
    }

    // Determine prompt
    const basePrompt = planParsed
      ? planParsed.prompt
      : resumeParsed
        ? (resumeParsed.prompt || 'Continue where you left off.')
        : (text || '');
    const finalPrompt = processedFiles.length > 0
      ? await this.fileHandler.formatFilePrompt(processedFiles, basePrompt)
      : basePrompt;

    // Determine permission mode
    const isPlanMode = !!planParsed;
    const permissionMode: PermissionMode = isPlanMode
      ? 'plan'
      : (this.channelPermissionModes.get(channel) || 'bypassPermissions');

    // Create canUseTool callback for interactive permission
    const canUseTool = (permissionMode === 'acceptEdits')
      ? this.createCanUseTool(channel, thread_ts || ts)
      : undefined;

    let currentMessages: string[] = [];
    let statusMessageTs: string | undefined;
    const channelModel = this.channelModels.get(channel);

    try {
      this.logger.info('Sending query to Claude Code SDK', {
        prompt: finalPrompt.substring(0, 200) + (finalPrompt.length > 200 ? '...' : ''),
        sessionId: session.sessionId,
        workingDirectory,
        permissionMode,
        fileCount: processedFiles.length,
      });

      const statusEmoji = isPlanMode ? '📝' : '🤔';
      const statusText = isPlanMode ? '*Planning...*' : '*Thinking...*';
      const statusResult = await say({ text: `${statusEmoji} ${statusText}`, thread_ts: thread_ts || ts });
      statusMessageTs = statusResult.ts;
      await this.updateMessageReaction(sessionKey, statusEmoji);

      const activeQuery = this.claudeHandler.buildQuery(finalPrompt, {
        session,
        abortController,
        workingDirectory,
        resumeOptions: resumeParsed?.resumeOptions,
        model: channelModel,
        maxBudgetUsd: this.channelBudgets.get(channel),
        permissionMode,
        canUseTool,
      });

      this.activeQueries.set(sessionKey, activeQuery);

      for await (const message of activeQuery) {
        if (abortController.signal.aborted) break;

        // Session init tracking
        if (message.type === 'system' && (message as any).subtype === 'init') {
          const initMsg = message as any;
          if (session) {
            session.sessionId = initMsg.session_id;
            this.logger.info('Session initialized', {
              sessionId: initMsg.session_id,
              model: initMsg.model,
              tools: initMsg.tools?.length || 0,
            });
          }
          continue;
        }

        // Stream events: show current tool in status
        if (message.type === 'stream_event') {
          const event = (message as any).event;
          if (event?.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
            const toolName = event.content_block.name;
            if (statusMessageTs) {
              await this.app.client.chat.update({
                channel,
                ts: statusMessageTs,
                text: `⚙️ *Using ${toolName}...*`,
              }).catch(() => {});
            }
            await this.updateMessageReaction(sessionKey, '⚙️');
          }
          continue;
        }

        if (message.type === 'assistant') {
          const hasToolUse = message.message.content?.some((part: any) => part.type === 'tool_use');

          if (hasToolUse) {
            if (statusMessageTs) {
              await this.app.client.chat.update({ channel, ts: statusMessageTs, text: '⚙️ *Working...*' }).catch(() => {});
            }
            await this.updateMessageReaction(sessionKey, '⚙️');

            const todoTool = message.message.content?.find((part: any) =>
              part.type === 'tool_use' && part.name === 'TodoWrite'
            );
            if (todoTool) {
              await this.handleTodoUpdate(todoTool.input, sessionKey, session?.sessionId, channel, thread_ts || ts, say);
            }

            const toolContent = this.formatToolUse(message.message.content);
            if (toolContent) {
              await say({ text: toolContent, thread_ts: thread_ts || ts });
            }
          } else {
            const content = this.extractTextContent(message);
            if (content) {
              currentMessages.push(content);
              await say({ text: this.formatMessage(content, false), thread_ts: thread_ts || ts });
            }
          }
        } else if (message.type === 'result') {
          const resultData = message as any;
          this.logger.info('Received result from Claude SDK', {
            subtype: resultData.subtype,
            totalCost: resultData.total_cost_usd,
            duration: resultData.duration_ms,
          });

          // Store cost info
          if (resultData.total_cost_usd !== undefined && session?.sessionId) {
            this.lastQueryCosts.set(channel, {
              cost: resultData.total_cost_usd,
              duration: resultData.duration_ms || 0,
              model: channelModel || 'default',
              sessionId: session.sessionId,
            });
          }

          if (resultData.subtype === 'success' && resultData.result) {
            if (!currentMessages.includes(resultData.result)) {
              await say({ text: this.formatMessage(resultData.result, true), thread_ts: thread_ts || ts });
            }
          }
        }
      }

      // Completed
      const doneEmoji = isPlanMode ? '📋' : '✅';
      const doneText = isPlanMode ? '*Plan ready*' : '*Task completed*';
      if (statusMessageTs) {
        await this.app.client.chat.update({ channel, ts: statusMessageTs, text: `${doneEmoji} ${doneText}` }).catch(() => {});
      }
      await this.updateMessageReaction(sessionKey, doneEmoji);

      // If plan mode, offer Execute button
      if (isPlanMode && session?.sessionId) {
        const planId = `plan-${Date.now()}`;
        this.pendingPlans.set(planId, {
          sessionId: session.sessionId,
          prompt: basePrompt,
          channel,
          threadTs: thread_ts || ts,
          user,
        });
        setTimeout(() => this.pendingPlans.delete(planId), 30 * 60 * 1000);

        await say({
          thread_ts: thread_ts || ts,
          text: `📋 Plan complete. Execute?`,
          blocks: [
            { type: 'section', text: { type: 'mrkdwn', text: `📋 *Plan ready.* Execute this plan?` } },
            {
              type: 'actions',
              elements: [
                {
                  type: 'button',
                  text: { type: 'plain_text', text: 'Execute' },
                  action_id: 'execute_plan',
                  value: planId,
                  style: 'primary',
                },
                {
                  type: 'button',
                  text: { type: 'plain_text', text: 'Cancel' },
                  action_id: 'cancel_plan',
                  value: planId,
                },
              ],
            },
          ],
        });
      }

      // Clean up temp files
      if (processedFiles.length > 0) {
        await this.fileHandler.cleanupTempFiles(processedFiles);
      }
    } catch (error: any) {
      if (error.name !== 'AbortError') {
        this.logger.error('Error handling message', error);

        if (statusMessageTs) {
          await this.app.client.chat.update({ channel, ts: statusMessageTs, text: '❌ *Error occurred*' }).catch(() => {});
        }
        await this.updateMessageReaction(sessionKey, '❌');

        // Rate limit detection
        if (this.isRateLimitError(error)) {
          const retryAfter = this.parseRetryAfterSeconds(error);
          const retryTime = new Date(Date.now() + retryAfter * 1000);
          const retryTimeStr = retryTime.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit' });
          const retryId = `retry-${Date.now()}`;

          this.pendingRetries.set(retryId, { prompt: finalPrompt, channel, threadTs: thread_ts || ts, user });
          setTimeout(() => this.pendingRetries.delete(retryId), 10 * 60 * 1000);

          await say({
            thread_ts: thread_ts || ts,
            text: `⏳ *Rate limit reached.* Estimated retry: ${retryTimeStr}`,
            blocks: [
              { type: 'section', text: { type: 'mrkdwn', text: `⏳ *Rate limit reached.*\nEstimated retry: *${retryTimeStr}* (${Math.round(retryAfter / 60)}분 후)\n\n다음 세션에 예약 메시지로 재실행할까요?` } },
              {
                type: 'actions',
                elements: [
                  { type: 'button', text: { type: 'plain_text', text: `예약 (${retryTimeStr})` }, action_id: 'schedule_retry', value: JSON.stringify({ retryId, retryAfter }), style: 'primary' },
                  { type: 'button', text: { type: 'plain_text', text: '취소' }, action_id: 'cancel_retry', value: retryId },
                ],
              },
            ],
          });
        } else {
          await say({ text: `Error: ${error.message || 'Something went wrong'}`, thread_ts: thread_ts || ts });
        }
      } else {
        this.logger.debug('Request was aborted', { sessionKey });
        if (statusMessageTs) {
          await this.app.client.chat.update({ channel, ts: statusMessageTs, text: '⏹️ *Cancelled*' }).catch(() => {});
        }
        await this.updateMessageReaction(sessionKey, '⏹️');
      }

      if (processedFiles.length > 0) {
        await this.fileHandler.cleanupTempFiles(processedFiles);
      }
    } finally {
      this.activeQueries.delete(sessionKey);
      this.activeControllers.delete(sessionKey);

      if (session?.sessionId) {
        setTimeout(() => {
          this.todoManager.cleanupSession(session.sessionId!);
          this.todoMessages.delete(sessionKey);
          this.originalMessages.delete(sessionKey);
          this.currentReactions.delete(sessionKey);
        }, 5 * 60 * 1000);
      }
    }
  }

  // --- canUseTool callback factory ---

  private createCanUseTool(channel: string, threadTs: string): CanUseTool {
    return async (toolName: string, input: Record<string, unknown>, options: { signal: AbortSignal; suggestions?: any[] }): Promise<PermissionResult> => {
      // Auto-approve safe/read-only tools
      const safeTools = ['Read', 'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch', 'Task', 'TodoRead', 'TodoWrite', 'NotebookRead'];
      if (safeTools.includes(toolName) || toolName.startsWith('mcp__')) {
        return { behavior: 'allow', updatedInput: input };
      }

      // For Bash and other potentially destructive tools, ask user
      const approvalId = `approval-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      const toolDesc = this.formatToolApprovalMessage(toolName, input);

      return new Promise<PermissionResult>((resolve) => {
        const timeout = setTimeout(() => {
          this.pendingApprovals.delete(approvalId);
          this.logger.info('Tool approval auto-approved (timeout)', { approvalId, toolName });
          resolve({ behavior: 'allow', updatedInput: input });
        }, 120_000);

        this.pendingApprovals.set(approvalId, { resolve, timeout });

        this.app.client.chat.postMessage({
          channel,
          thread_ts: threadTs,
          text: toolDesc,
          blocks: [
            { type: 'section', text: { type: 'mrkdwn', text: toolDesc } },
            {
              type: 'actions',
              elements: [
                { type: 'button', text: { type: 'plain_text', text: 'Approve' }, action_id: 'approve_tool_use', value: JSON.stringify({ approvalId, input, suggestions: options.suggestions }), style: 'primary' },
                { type: 'button', text: { type: 'plain_text', text: 'Deny' }, action_id: 'deny_tool_use', value: approvalId, style: 'danger' },
              ],
            },
            { type: 'context', elements: [{ type: 'mrkdwn', text: '_Auto-approves in 2 minutes_' }] },
          ],
        }).catch((err) => {
          this.logger.error('Failed to post approval message', err);
          clearTimeout(timeout);
          this.pendingApprovals.delete(approvalId);
          resolve({ behavior: 'allow', updatedInput: input });
        });
      });
    };
  }

  private formatToolApprovalMessage(toolName: string, input: Record<string, unknown>): string {
    switch (toolName) {
      case 'Bash':
        return `🔐 *Approve Bash command?*\n\`\`\`\n${input.command || '(no command)'}\n\`\`\``;
      case 'Edit':
      case 'MultiEdit':
        return `🔐 *Approve edit to* \`${input.file_path || '?'}\`?`;
      case 'Write':
        return `🔐 *Approve creating* \`${input.file_path || '?'}\`?`;
      default:
        return `🔐 *Approve ${toolName}?*\n\`\`\`json\n${JSON.stringify(input, null, 2).substring(0, 500)}\n\`\`\``;
    }
  }

  // --- Message content helpers ---

  private extractTextContent(message: SDKMessage): string | null {
    if (message.type === 'assistant' && message.message.content) {
      const textParts = message.message.content
        .filter((part: any) => part.type === 'text')
        .map((part: any) => part.text);
      return textParts.join('');
    }
    return null;
  }

  private formatToolUse(content: any[]): string {
    const parts: string[] = [];
    for (const part of content) {
      if (part.type === 'text') {
        parts.push(part.text);
      } else if (part.type === 'tool_use') {
        const toolName = part.name;
        const input = part.input;
        switch (toolName) {
          case 'Edit':
          case 'MultiEdit':
            parts.push(this.formatEditTool(toolName, input));
            break;
          case 'Write':
            parts.push(this.formatWriteTool(input));
            break;
          case 'Read':
            parts.push(this.formatReadTool(input));
            break;
          case 'Bash':
            parts.push(this.formatBashTool(input));
            break;
          case 'TodoWrite':
            return '';
          default:
            parts.push(this.formatGenericTool(toolName, input));
        }
      }
    }
    return parts.join('\n\n');
  }

  private formatEditTool(toolName: string, input: any): string {
    const filePath = input.file_path;
    const edits = toolName === 'MultiEdit' ? input.edits : [{ old_string: input.old_string, new_string: input.new_string }];
    let result = `📝 *Editing \`${filePath}\`*\n`;
    for (const edit of edits) {
      result += '\n```diff\n';
      result += `- ${this.truncateString(edit.old_string, 200)}\n`;
      result += `+ ${this.truncateString(edit.new_string, 200)}\n`;
      result += '```';
    }
    return result;
  }

  private formatWriteTool(input: any): string {
    return `📄 *Creating \`${input.file_path}\`*\n\`\`\`\n${this.truncateString(input.content, 300)}\n\`\`\``;
  }

  private formatReadTool(input: any): string {
    return `👁️ *Reading \`${input.file_path}\`*`;
  }

  private formatBashTool(input: any): string {
    return `🖥️ *Running command:*\n\`\`\`bash\n${input.command}\n\`\`\``;
  }

  private formatGenericTool(toolName: string, _input: any): string {
    return `🔧 *Using ${toolName}*`;
  }

  private truncateString(str: string, maxLength: number): string {
    if (!str) return '';
    if (str.length <= maxLength) return str;
    return str.substring(0, maxLength) + '...';
  }

  private formatMessage(text: string, _isFinal: boolean): string {
    return text
      .replace(/```(\w+)?\n([\s\S]*?)```/g, (_, _lang, code) => '```' + code + '```')
      .replace(/`([^`]+)`/g, '`$1`')
      .replace(/\*\*([^*]+)\*\*/g, '*$1*')
      .replace(/__([^_]+)__/g, '_$1_');
  }

  // --- Todo handling ---

  private async handleTodoUpdate(input: any, sessionKey: string, sessionId: string | undefined, channel: string, threadTs: string, say: any): Promise<void> {
    if (!sessionId || !input.todos) return;
    const newTodos: Todo[] = input.todos;
    const oldTodos = this.todoManager.getTodos(sessionId);

    if (this.todoManager.hasSignificantChange(oldTodos, newTodos)) {
      this.todoManager.updateTodos(sessionId, newTodos);
      const todoList = this.todoManager.formatTodoList(newTodos);
      const existingTodoMessageTs = this.todoMessages.get(sessionKey);

      if (existingTodoMessageTs) {
        try {
          await this.app.client.chat.update({ channel, ts: existingTodoMessageTs, text: todoList });
        } catch {
          await this.createNewTodoMessage(todoList, channel, threadTs, sessionKey, say);
        }
      } else {
        await this.createNewTodoMessage(todoList, channel, threadTs, sessionKey, say);
      }

      const statusChange = this.todoManager.getStatusChange(oldTodos, newTodos);
      if (statusChange) {
        await say({ text: `🔄 *Task Update:*\n${statusChange}`, thread_ts: threadTs });
      }
      await this.updateTaskProgressReaction(sessionKey, newTodos);
    }
  }

  private async createNewTodoMessage(todoList: string, channel: string, threadTs: string, sessionKey: string, say: any): Promise<void> {
    const result = await say({ text: todoList, thread_ts: threadTs });
    if (result?.ts) {
      this.todoMessages.set(sessionKey, result.ts);
    }
  }

  // --- Reactions ---

  private async updateMessageReaction(sessionKey: string, emoji: string): Promise<void> {
    const originalMessage = this.originalMessages.get(sessionKey);
    if (!originalMessage) return;

    const currentEmoji = this.currentReactions.get(sessionKey);
    if (currentEmoji === emoji) return;

    try {
      if (currentEmoji) {
        try {
          await this.app.client.reactions.remove({ channel: originalMessage.channel, timestamp: originalMessage.ts, name: currentEmoji });
        } catch { /* might not exist */ }
      }
      await this.app.client.reactions.add({ channel: originalMessage.channel, timestamp: originalMessage.ts, name: emoji });
      this.currentReactions.set(sessionKey, emoji);
    } catch (error) {
      this.logger.warn('Failed to update message reaction', error);
    }
  }

  private async updateTaskProgressReaction(sessionKey: string, todos: Todo[]): Promise<void> {
    if (todos.length === 0) return;
    const completed = todos.filter(t => t.status === 'completed').length;
    const inProgress = todos.filter(t => t.status === 'in_progress').length;
    const total = todos.length;
    const emoji = completed === total ? '✅' : inProgress > 0 ? '🔄' : '📋';
    await this.updateMessageReaction(sessionKey, emoji);
  }

  // --- Command parsers ---

  private isStopCommand(text: string): boolean {
    return /^-(stop|cancel|중단)$/i.test(text.trim());
  }

  private isHelpCommand(text: string): boolean {
    return /^-?(help|commands|도움말)(\?)?$/i.test(text.trim());
  }

  private isResetCommand(text: string): boolean {
    return /^-(reset|새로시작)$/i.test(text.trim());
  }

  private isSafeCommand(text: string): boolean {
    return /^-safe$/i.test(text.trim());
  }

  private isTrustCommand(text: string): boolean {
    return /^-trust$/i.test(text.trim());
  }

  private parseModelCommand(text: string): string | null {
    const match = text.trim().match(/^-model(?:\s+(\S+))?$/i);
    if (match) return match[1] || '';
    return null;
  }

  private parseBudgetCommand(text: string): number | null {
    const match = text.trim().match(/^-budget(?:\s+([\d.]+|off|reset))?$/i);
    if (!match) return null;
    const val = match[1];
    if (!val) return -1;
    if (val === 'off' || val === 'reset') return 0;
    return parseFloat(val);
  }

  private isCostCommand(text: string): boolean {
    return /^-cost$/i.test(text.trim());
  }

  private isSessionsCommand(text: string): boolean {
    return /^-sessions?(\s+list)?$/i.test(text.trim());
  }

  private parsePlanCommand(text: string): { prompt: string } | null {
    const match = text.trim().match(/^-plan\s+(.+)$/is);
    if (match) return { prompt: match[1].trim() };
    return null;
  }

  private parseResumeCommand(text: string): { resumeOptions: { continueLastSession?: boolean; resumeSessionId?: string }; prompt?: string } | null {
    const trimmed = text.trim();
    const continueMatch = trimmed.match(/^-continue(?:\s+(.+))?$/is);
    if (continueMatch) {
      return { resumeOptions: { continueLastSession: true }, prompt: continueMatch[1]?.trim() || undefined };
    }
    const resumeMatch = trimmed.match(/^-resume(?:\s+`?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})`?)?(?:\s+(.+))?$/is);
    if (resumeMatch) {
      const sessionId = resumeMatch[1];
      const prompt = resumeMatch[2]?.trim() || undefined;
      if (sessionId) return { resumeOptions: { resumeSessionId: sessionId }, prompt };
      return { resumeOptions: { continueLastSession: true }, prompt };
    }
    return null;
  }

  private isRateLimitError(error: any): boolean {
    const msg = error?.message || '';
    return /rate.?limit|overloaded|429|too many requests|capacity|usage limit/i.test(msg);
  }

  private parseRetryAfterSeconds(error: any): number {
    const msg = error?.message || '';
    const match = msg.match(/retry.?after[:\s]+(\d+)/i);
    if (match) return parseInt(match[1], 10);
    const minMatch = msg.match(/(\d+)\s*minutes?/i);
    if (minMatch) return parseInt(minMatch[1], 10) * 60;
    return 5 * 60 * 60;
  }

  private isMcpInfoCommand(text: string): boolean {
    return /^-mcp(\s+(info|list|status))?(\?)?$/i.test(text.trim());
  }

  private isMcpReloadCommand(text: string): boolean {
    return /^-mcp\s+(reload|refresh)$/i.test(text.trim());
  }

  // --- Session listing ---

  private getProjectsDir(cwd: string): string {
    const encoded = cwd.replace(/[^a-zA-Z0-9]/g, '-');
    return path.join(os.homedir(), '.claude', 'projects', encoded);
  }

  private listSessions(cwd: string, limit: number = 10): Array<{ id: string; date: Date; summary: string; preview: string }> {
    const projectsDir = this.getProjectsDir(cwd);
    if (!fs.existsSync(projectsDir)) return [];

    const files = fs.readdirSync(projectsDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => {
        const fullPath = path.join(projectsDir, f);
        return { name: f, path: fullPath, mtime: fs.statSync(fullPath).mtime };
      })
      .sort((a, b) => b.mtime.getTime() - a.mtime.getTime())
      .slice(0, limit);

    const sessions: Array<{ id: string; date: Date; summary: string; preview: string }> = [];
    for (const file of files) {
      const sessionId = file.name.replace('.jsonl', '');
      let summary = '';
      let preview = '';
      try {
        const content = fs.readFileSync(file.path, 'utf-8');
        const lines = content.split('\n').slice(0, 100);
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.type === 'summary' && msg.summary && !summary) summary = msg.summary;
            if (msg.type === 'user' && !msg.isMeta && !preview) {
              const msgContent = msg.message?.content;
              if (Array.isArray(msgContent)) {
                const textPart = msgContent.find((p: any) => p.type === 'text' && p.text);
                if (textPart) preview = textPart.text;
              } else if (typeof msgContent === 'string') {
                preview = msgContent;
              }
            }
            if (summary && preview) break;
          } catch { /* skip */ }
        }
      } catch { /* skip */ }
      sessions.push({ id: sessionId, date: file.mtime, summary, preview: preview.substring(0, 100) + (preview.length > 100 ? '...' : '') });
    }
    return sessions;
  }

  private formatSessionsList(sessions: Array<{ id: string; date: Date; summary: string; preview: string }>): string {
    if (sessions.length === 0) return `ℹ️ No sessions found for this working directory.`;
    let msg = `*Recent Sessions*\n\n`;
    for (const s of sessions) {
      const dateStr = s.date.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      const title = s.summary || s.preview || '(no preview)';
      msg += `• \`${s.id}\`\n  ${dateStr} — ${title}\n\n`;
    }
    msg += `_Use \`-resume <session-id>\` to resume a session._`;
    return msg;
  }

  // --- Help text ---

  private getHelpText(): string {
    let help = `*Claude Code Bot — Commands*\n\n`;
    help += `*Working Directory*\n`;
    help += `\`-cwd <path>\` — Set working directory (relative or absolute)\n`;
    help += `\`-cwd\` — Show current working directory\n\n`;
    help += `*Session*\n`;
    help += `\`-continue [message]\` — Resume last CLI session\n`;
    help += `\`-resume <session-id> [message]\` — Resume a specific session\n`;
    help += `\`-sessions\` — List recent sessions for current cwd\n`;
    help += `\`-stop\` — Cancel the running query (graceful interrupt)\n`;
    help += `\`-reset\` — End current session (next message starts fresh)\n\n`;
    help += `*Plan & Permissions*\n`;
    help += `\`-plan <prompt>\` — Plan only (read-only, no execution)\n`;
    help += `\`-safe\` — Safe mode: Bash commands require approval\n`;
    help += `\`-trust\` — Trust mode: all tools auto-approved (default)\n\n`;
    help += `*Settings*\n`;
    help += `\`-model [name]\` — Get/set model (\`sonnet\`, \`opus\`, \`haiku\`)\n`;
    help += `\`-budget [amount|off]\` — Get/set/remove max budget per query (USD)\n`;
    help += `\`-cost\` — Show last query cost and session ID\n\n`;
    help += `*MCP*\n`;
    help += `\`-mcp\` — Show MCP server status\n`;
    help += `\`-mcp reload\` — Reload MCP configuration\n\n`;
    help += `*Tips*\n`;
    help += `• Same thread = session auto-continues (no command needed)\n`;
    help += `• Drag & drop files to upload and analyze\n`;
    help += `• Rate limit → bot offers scheduled retry\n`;
    help += `• \`help\` or \`-help\` — Show this message\n`;
    return help;
  }

  // --- Bot user ID ---

  private async getBotUserId(): Promise<string> {
    if (!this.botUserId) {
      try {
        const response = await this.app.client.auth.test();
        this.botUserId = response.user_id as string;
      } catch (error) {
        this.logger.error('Failed to get bot user ID', error);
        this.botUserId = '';
      }
    }
    return this.botUserId;
  }

  // --- Channel join ---

  private async handleChannelJoin(channelId: string, say: any): Promise<void> {
    try {
      const channelInfo = await this.app.client.conversations.info({ channel: channelId });
      const channelName = (channelInfo.channel as any)?.name || 'this channel';

      let welcomeMessage = `👋 Hi! I'm Claude Code, your AI coding assistant.\n\n`;
      welcomeMessage += `To get started, I need to know the default working directory for #${channelName}.\n\n`;
      if (config.baseDirectory) {
        welcomeMessage += `You can use:\n`;
        welcomeMessage += `• \`-cwd project-name\` (relative to base directory: \`${config.baseDirectory}\`)\n`;
        welcomeMessage += `• \`-cwd /absolute/path/to/project\` (absolute path)\n\n`;
      } else {
        welcomeMessage += `Please set it using:\n• \`-cwd /path/to/project\`\n\n`;
      }
      welcomeMessage += `This will be the default working directory for this channel. `;
      welcomeMessage += `You can always override it for specific threads with \`-cwd\`.\n\n`;
      welcomeMessage += `Type \`-help\` to see all available commands.`;

      await say({ text: welcomeMessage });
      this.logger.info('Sent welcome message to channel', { channelId, channelName });
    } catch (error) {
      this.logger.error('Failed to handle channel join', error);
    }
  }

  // --- Event handlers ---

  setupEventHandlers() {
    // Handle direct messages
    this.app.message(async ({ message, say }) => {
      if (message.subtype === undefined && 'user' in message) {
        this.logger.info('Handling direct message event');
        const msg = message as MessageEvent;
        if (msg.text) {
          msg.text = msg.text.replace(/<@[^>]+>/g, '').trim();
        }
        await this.handleMessage(msg, say);
      }
    });

    // Handle app mentions
    this.app.event('app_mention', async ({ event, say }) => {
      this.logger.info('Handling app mention event');
      const text = event.text.replace(/<@[^>]+>/g, '').trim();
      await this.handleMessage({ ...event, text } as MessageEvent, say);
    });

    // Handle file uploads in threads
    this.app.event('message', async ({ event, say }) => {
      if (event.subtype === 'file_share' && 'user' in event && event.files) {
        this.logger.info('Handling file upload event');
        await this.handleMessage(event as MessageEvent, say);
      }
    });

    // Handle bot being added to channels
    this.app.event('member_joined_channel', async ({ event, say }) => {
      if (event.user === await this.getBotUserId()) {
        this.logger.info('Bot added to channel', { channel: event.channel });
        await this.handleChannelJoin(event.channel, say);
      }
    });

    // --- Interactive button handlers ---

    // Tool approval (safe mode)
    this.app.action('approve_tool_use', async ({ ack, body, respond }) => {
      await ack();
      try {
        const actionValue = JSON.parse((body as any).actions[0].value);
        const approval = this.pendingApprovals.get(actionValue.approvalId);
        if (approval) {
          clearTimeout(approval.timeout);
          this.pendingApprovals.delete(actionValue.approvalId);
          approval.resolve({
            behavior: 'allow',
            updatedInput: actionValue.input,
            updatedPermissions: actionValue.suggestions,
          });
          await respond({ response_type: 'ephemeral', text: '✅ Approved' });
        } else {
          await respond({ response_type: 'ephemeral', text: '⚠️ Approval expired (already auto-approved)' });
        }
      } catch (error) {
        this.logger.error('Error handling tool approval', error);
      }
    });

    this.app.action('deny_tool_use', async ({ ack, body, respond }) => {
      await ack();
      const approvalId = (body as any).actions[0].value;
      const approval = this.pendingApprovals.get(approvalId);
      if (approval) {
        clearTimeout(approval.timeout);
        this.pendingApprovals.delete(approvalId);
        approval.resolve({ behavior: 'deny', message: 'User denied this tool use.' });
        await respond({ response_type: 'ephemeral', text: '❌ Denied' });
      }
    });

    // Plan execution
    this.app.action('execute_plan', async ({ ack, body, respond }) => {
      await ack();
      const planId = (body as any).actions[0].value;
      const planInfo = this.pendingPlans.get(planId);
      if (!planInfo) {
        await respond({ response_type: 'ephemeral', text: '⚠️ Plan expired. Please re-run.' });
        return;
      }
      this.pendingPlans.delete(planId);

      await respond({ response_type: 'in_channel', text: '🚀 *Executing plan...*' });

      // Execute by resuming the plan session with acceptEdits mode
      const { channel, threadTs, user, sessionId, prompt } = planInfo;
      const event: MessageEvent = { user, channel, thread_ts: threadTs, ts: threadTs, text: `-resume ${sessionId} Execute the plan you created.` };
      const say = async (msg: any) => {
        return this.app.client.chat.postMessage({ channel, ...msg });
      };
      // Temporarily set permission mode to acceptEdits for execution
      const prevMode = this.channelPermissionModes.get(channel);
      this.channelPermissionModes.set(channel, this.channelPermissionModes.get(channel) || 'bypassPermissions');
      await this.handleMessage(event, say);
      if (prevMode) {
        this.channelPermissionModes.set(channel, prevMode);
      }
    });

    this.app.action('cancel_plan', async ({ ack, body, respond }) => {
      await ack();
      const planId = (body as any).actions[0].value;
      this.pendingPlans.delete(planId);
      await respond({ response_type: 'ephemeral', text: '취소되었습니다.' });
    });

    // Rate limit retry
    this.app.action('schedule_retry', async ({ ack, body, respond }) => {
      await ack();
      try {
        const actionValue = JSON.parse((body as any).actions[0].value);
        const retryInfo = this.pendingRetries.get(actionValue.retryId);
        if (!retryInfo) {
          await respond({ response_type: 'ephemeral', text: '⚠️ Retry info expired. Please resend your message manually.' });
          return;
        }
        const postAt = Math.floor(Date.now() / 1000) + actionValue.retryAfter;
        await this.app.client.chat.scheduleMessage({
          channel: retryInfo.channel,
          text: retryInfo.prompt,
          post_at: postAt,
          thread_ts: retryInfo.threadTs,
        });
        const retryTime = new Date(postAt * 1000).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit' });
        this.pendingRetries.delete(actionValue.retryId);
        await respond({ response_type: 'in_channel', text: `✅ ${retryTime}에 재실행이 예약되었습니다.` });
      } catch (error) {
        this.logger.error('Failed to schedule retry', error);
        await respond({ response_type: 'ephemeral', text: `❌ Failed to schedule: ${(error as any).message}` });
      }
    });

    this.app.action('cancel_retry', async ({ ack, body, respond }) => {
      await ack();
      const retryId = (body as any).actions[0].value;
      this.pendingRetries.delete(retryId);
      await respond({ response_type: 'ephemeral', text: '취소되었습니다.' });
    });

    // Cleanup inactive sessions periodically
    setInterval(() => {
      this.logger.debug('Running session cleanup');
      this.claudeHandler.cleanupInactiveSessions();
    }, 5 * 60 * 1000);
  }
}
