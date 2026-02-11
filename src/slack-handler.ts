import { App } from '@slack/bolt';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ClaudeHandler } from './claude-handler';
import { SDKMessage } from './claude-handler';
import { Logger } from './logger';
import { WorkingDirectoryManager } from './working-directory-manager';
import { FileHandler, ProcessedFile } from './file-handler';
import { TodoManager, Todo } from './todo-manager';
import { McpManager } from './mcp-manager';
// Permission server disabled on Windows - stub out the approval calls
const permissionServer = {
  resolveApproval: (_id: string, _approved: boolean) => {},
};
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
  private activeControllers: Map<string, AbortController> = new Map();
  private logger = new Logger('SlackHandler');
  private workingDirManager: WorkingDirectoryManager;
  private fileHandler: FileHandler;
  private todoManager: TodoManager;
  private mcpManager: McpManager;
  private todoMessages: Map<string, string> = new Map(); // sessionKey -> messageTs
  private originalMessages: Map<string, { channel: string; ts: string }> = new Map(); // sessionKey -> original message info
  private currentReactions: Map<string, string> = new Map(); // sessionKey -> current emoji
  private channelModels: Map<string, string> = new Map(); // channelId -> model name
  private channelBudgets: Map<string, number> = new Map(); // channelId -> max budget USD
  private lastQueryCosts: Map<string, { cost: number; duration: number; model: string; sessionId: string }> = new Map(); // channelId -> last cost
  private pendingRetries: Map<string, { prompt: string; channel: string; threadTs: string; user: string }> = new Map(); // approvalId -> retry info
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

    // Check if this is a working directory command (only if there's text)
    const setDirPath = text ? this.workingDirManager.parseSetCommand(text) : null;
    if (setDirPath) {
      const isDM = channel.startsWith('D');
      const result = this.workingDirManager.setWorkingDirectory(
        channel,
        setDirPath,
        thread_ts,
        isDM ? user : undefined
      );

      if (result.success) {
        const context = thread_ts ? 'this thread' : (isDM ? 'this conversation' : 'this channel');
        await say({
          text: `✅ Working directory set for ${context}: \`${result.resolvedPath}\``,
          thread_ts: thread_ts || ts,
        });
      } else {
        await say({
          text: `❌ ${result.error}`,
          thread_ts: thread_ts || ts,
        });
      }
      return;
    }

    // Check if this is a get directory command (only if there's text)
    if (text && this.workingDirManager.isGetCommand(text)) {
      const isDM = channel.startsWith('D');
      const directory = this.workingDirManager.getWorkingDirectory(
        channel,
        thread_ts,
        isDM ? user : undefined
      );
      const context = thread_ts ? 'this thread' : (isDM ? 'this conversation' : 'this channel');
      
      await say({
        text: this.workingDirManager.formatDirectoryMessage(directory, context),
        thread_ts: thread_ts || ts,
      });
      return;
    }

    // Check if this is an MCP info command (only if there's text)
    if (text && this.isMcpInfoCommand(text)) {
      await say({
        text: this.mcpManager.formatMcpInfo(),
        thread_ts: thread_ts || ts,
      });
      return;
    }

    // Check if this is an MCP reload command (only if there's text)
    if (text && this.isMcpReloadCommand(text)) {
      const reloaded = this.mcpManager.reloadConfiguration();
      if (reloaded) {
        await say({
          text: `✅ MCP configuration reloaded successfully.\n\n${this.mcpManager.formatMcpInfo()}`,
          thread_ts: thread_ts || ts,
        });
      } else {
        await say({
          text: `❌ Failed to reload MCP configuration. Check the mcp-servers.json file.`,
          thread_ts: thread_ts || ts,
        });
      }
      return;
    }

    // Check if this is a help command
    if (text && this.isHelpCommand(text)) {
      await say({ text: this.getHelpText(), thread_ts: thread_ts || ts });
      return;
    }

    // Check if this is a reset command
    if (text && this.isResetCommand(text)) {
      const sessionKey = this.claudeHandler.getSessionKey(user, channel, thread_ts || ts);
      const removed = this.claudeHandler.removeSession(user, channel, thread_ts || ts);
      this.lastQueryCosts.delete(channel);
      await say({
        text: removed
          ? `🔄 Session reset. Next message will start a new conversation.`
          : `ℹ️ No active session to reset.`,
        thread_ts: thread_ts || ts,
      });
      return;
    }

    // Check if this is a model command
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

    // Check if this is a budget command
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

    // Check if this is a sessions command
    if (text && this.isSessionsCommand(text)) {
      const isDMForSessions = channel.startsWith('D');
      const cwdForSessions = this.workingDirManager.getWorkingDirectory(
        channel,
        thread_ts,
        isDMForSessions ? user : undefined
      );
      if (cwdForSessions) {
        const sessions = this.listSessions(cwdForSessions);
        await say({ text: this.formatSessionsList(sessions), thread_ts: thread_ts || ts });
      } else {
        await say({ text: `⚠️ Set a working directory first (\`-cwd <path>\`) to list sessions.`, thread_ts: thread_ts || ts });
      }
      return;
    }

    // Check if this is a cost command
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

    // Check if this is a resume/continue command (only if there's text)
    const resumeParsed = text ? this.parseResumeCommand(text) : null;

    // Check if we have a working directory set
    const isDM = channel.startsWith('D');
    const workingDirectory = this.workingDirManager.getWorkingDirectory(
      channel,
      thread_ts,
      isDM ? user : undefined
    );

    // Working directory is always required
    if (!workingDirectory) {
      let errorMessage = `⚠️ No working directory set. `;
      
      if (!isDM && !this.workingDirManager.hasChannelWorkingDirectory(channel)) {
        errorMessage += `Please set a default working directory for this channel first using:\n`;
        if (config.baseDirectory) {
          errorMessage += `\`-cwd project-name\` or \`-cwd /absolute/path\`\n\n`;
          errorMessage += `Base directory: \`${config.baseDirectory}\``;
        } else {
          errorMessage += `\`-cwd /path/to/directory\``;
        }
      } else if (thread_ts) {
        errorMessage += `You can set a thread-specific working directory using:\n`;
        errorMessage += `\`-cwd /path/to/directory\``;
      } else {
        errorMessage += `Please set one first using:\n\`-cwd /path/to/directory\``;
      }
      
      await say({
        text: errorMessage,
        thread_ts: thread_ts || ts,
      });
      return;
    }

    const sessionKey = this.claudeHandler.getSessionKey(user, channel, thread_ts || ts);
    
    // Store the original message info for status reactions
    const originalMessageTs = thread_ts || ts;
    this.originalMessages.set(sessionKey, { channel, ts: originalMessageTs });
    
    // Cancel any existing request for this conversation
    const existingController = this.activeControllers.get(sessionKey);
    if (existingController) {
      this.logger.debug('Cancelling existing request for session', { sessionKey });
      existingController.abort();
    }

    const abortController = new AbortController();
    this.activeControllers.set(sessionKey, abortController);

    let session = this.claudeHandler.getSession(user, channel, thread_ts || ts);
    if (!session) {
      this.logger.debug('Creating new session', { sessionKey });
      session = this.claudeHandler.createSession(user, channel, thread_ts || ts);
    } else {
      this.logger.debug('Using existing session', { sessionKey, sessionId: session.sessionId });
    }

    let currentMessages: string[] = [];
    let statusMessageTs: string | undefined;

    // Prepare the prompt outside try so it's accessible in catch for retry
    const basePrompt = resumeParsed ? (resumeParsed.prompt || 'Continue where you left off.') : (text || '');
    const finalPrompt = processedFiles.length > 0
      ? await this.fileHandler.formatFilePrompt(processedFiles, basePrompt)
      : basePrompt;

    try {
      this.logger.info('Sending query to Claude Code SDK', {
        prompt: finalPrompt.substring(0, 200) + (finalPrompt.length > 200 ? '...' : ''),
        sessionId: session.sessionId,
        workingDirectory,
        fileCount: processedFiles.length,
        resumeOptions: resumeParsed?.resumeOptions,
      });

      // Send initial status message
      const statusResult = await say({
        text: '🤔 *Thinking...*',
        thread_ts: thread_ts || ts,
      });
      statusMessageTs = statusResult.ts;

      // Add thinking reaction to original message (but don't spam if already set)
      await this.updateMessageReaction(sessionKey, '🤔');
      
      // Create Slack context for permission prompts
      const slackContext = {
        channel,
        threadTs: thread_ts,
        user
      };
      
      // Gather extra options (model, budget)
      const extraOptions: { model?: string; maxBudgetUsd?: number } = {};
      const channelModel = this.channelModels.get(channel);
      if (channelModel) extraOptions.model = channelModel;
      const channelBudget = this.channelBudgets.get(channel);
      if (channelBudget) extraOptions.maxBudgetUsd = channelBudget;

      for await (const message of this.claudeHandler.streamQuery(finalPrompt, session, abortController, workingDirectory, slackContext, resumeParsed?.resumeOptions, extraOptions)) {
        if (abortController.signal.aborted) break;

        this.logger.debug('Received message from Claude SDK', {
          type: message.type,
          subtype: (message as any).subtype,
          message: message,
        });

        if (message.type === 'assistant') {
          // Check if this is a tool use message
          const hasToolUse = message.message.content?.some((part: any) => part.type === 'tool_use');
          
          if (hasToolUse) {
            // Update status to show working
            if (statusMessageTs) {
              await this.app.client.chat.update({
                channel,
                ts: statusMessageTs,
                text: '⚙️ *Working...*',
              });
            }

            // Update reaction to show working
            await this.updateMessageReaction(sessionKey, '⚙️');

            // Check for TodoWrite tool and handle it specially
            const todoTool = message.message.content?.find((part: any) => 
              part.type === 'tool_use' && part.name === 'TodoWrite'
            );

            if (todoTool) {
              await this.handleTodoUpdate(todoTool.input, sessionKey, session?.sessionId, channel, thread_ts || ts, say);
            }

            // For other tool use messages, format them immediately as new messages
            const toolContent = this.formatToolUse(message.message.content);
            if (toolContent) { // Only send if there's content (TodoWrite returns empty string)
              await say({
                text: toolContent,
                thread_ts: thread_ts || ts,
              });
            }
          } else {
            // Handle regular text content
            const content = this.extractTextContent(message);
            if (content) {
              currentMessages.push(content);
              
              // Send each new piece of content as a separate message
              const formatted = this.formatMessage(content, false);
              await say({
                text: formatted,
                thread_ts: thread_ts || ts,
              });
            }
          }
        } else if (message.type === 'result') {
          const resultData = message as any;
          this.logger.info('Received result from Claude SDK', {
            subtype: message.subtype,
            hasResult: message.subtype === 'success' && !!resultData.result,
            totalCost: resultData.total_cost_usd,
            duration: resultData.duration_ms,
          });

          // Store cost info for the `cost` command
          if (resultData.total_cost_usd !== undefined && session?.sessionId) {
            this.lastQueryCosts.set(channel, {
              cost: resultData.total_cost_usd,
              duration: resultData.duration_ms || 0,
              model: channelModel || 'default',
              sessionId: session.sessionId,
            });
          }

          if (message.subtype === 'success' && resultData.result) {
            const finalResult = resultData.result;
            if (finalResult && !currentMessages.includes(finalResult)) {
              const formatted = this.formatMessage(finalResult, true);
              await say({
                text: formatted,
                thread_ts: thread_ts || ts,
              });
            }
          }
        }
      }

      // Update status to completed
      if (statusMessageTs) {
        await this.app.client.chat.update({
          channel,
          ts: statusMessageTs,
          text: '✅ *Task completed*',
        });
      }

      // Update reaction to show completion
      await this.updateMessageReaction(sessionKey, '✅');

      this.logger.info('Completed processing message', {
        sessionKey,
        messageCount: currentMessages.length,
      });

      // Clean up temporary files
      if (processedFiles.length > 0) {
        await this.fileHandler.cleanupTempFiles(processedFiles);
      }
    } catch (error: any) {
      if (error.name !== 'AbortError') {
        this.logger.error('Error handling message', error);

        // Update status to error
        if (statusMessageTs) {
          await this.app.client.chat.update({
            channel,
            ts: statusMessageTs,
            text: '❌ *Error occurred*',
          });
        }

        await this.updateMessageReaction(sessionKey, '❌');

        // Check if this is a rate limit error → offer scheduled retry
        if (this.isRateLimitError(error)) {
          const retryAfter = this.parseRetryAfterSeconds(error);
          const retryTime = new Date(Date.now() + retryAfter * 1000);
          const retryTimeStr = retryTime.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit' });
          const retryId = `retry-${Date.now()}`;

          // Store retry info
          this.pendingRetries.set(retryId, {
            prompt: finalPrompt,
            channel,
            threadTs: thread_ts || ts,
            user,
          });

          // Auto-clean after 10 minutes
          setTimeout(() => this.pendingRetries.delete(retryId), 10 * 60 * 1000);

          await say({
            thread_ts: thread_ts || ts,
            text: `⏳ *Rate limit reached.* Estimated retry: ${retryTimeStr} (${Math.round(retryAfter / 60)}분 후)`,
            blocks: [
              {
                type: 'section',
                text: {
                  type: 'mrkdwn',
                  text: `⏳ *Rate limit reached.*\nEstimated retry: *${retryTimeStr}* (${Math.round(retryAfter / 60)}분 후)\n\n다음 세션에 예약 메시지로 재실행할까요?`,
                },
              },
              {
                type: 'actions',
                elements: [
                  {
                    type: 'button',
                    text: { type: 'plain_text', text: `예약 (${retryTimeStr})` },
                    action_id: 'schedule_retry',
                    value: JSON.stringify({ retryId, retryAfter }),
                    style: 'primary',
                  },
                  {
                    type: 'button',
                    text: { type: 'plain_text', text: '취소' },
                    action_id: 'cancel_retry',
                    value: retryId,
                  },
                ],
              },
            ],
          });
        } else {
          await say({
            text: `Error: ${error.message || 'Something went wrong'}`,
            thread_ts: thread_ts || ts,
          });
        }
      } else {
        this.logger.debug('Request was aborted', { sessionKey });
        
        // Update status to cancelled
        if (statusMessageTs) {
          await this.app.client.chat.update({
            channel,
            ts: statusMessageTs,
            text: '⏹️ *Cancelled*',
          });
        }

        // Update reaction to show cancellation
        await this.updateMessageReaction(sessionKey, '⏹️');
      }

      // Clean up temporary files in case of error too
      if (processedFiles.length > 0) {
        await this.fileHandler.cleanupTempFiles(processedFiles);
      }
    } finally {
      this.activeControllers.delete(sessionKey);
      
      // Clean up todo tracking if session ended
      if (session?.sessionId) {
        // Don't immediately clean up - keep todos visible for a while
        setTimeout(() => {
          this.todoManager.cleanupSession(session.sessionId!);
          this.todoMessages.delete(sessionKey);
          this.originalMessages.delete(sessionKey);
          this.currentReactions.delete(sessionKey);
        }, 5 * 60 * 1000); // 5 minutes
      }
    }
  }

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
            // Handle TodoWrite separately - don't include in regular tool output
            return this.handleTodoWrite(input);
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
    const filePath = input.file_path;
    const preview = this.truncateString(input.content, 300);
    
    return `📄 *Creating \`${filePath}\`*\n\`\`\`\n${preview}\n\`\`\``;
  }

  private formatReadTool(input: any): string {
    return `👁️ *Reading \`${input.file_path}\`*`;
  }

  private formatBashTool(input: any): string {
    return `🖥️ *Running command:*\n\`\`\`bash\n${input.command}\n\`\`\``;
  }

  private formatGenericTool(toolName: string, input: any): string {
    return `🔧 *Using ${toolName}*`;
  }

  private truncateString(str: string, maxLength: number): string {
    if (!str) return '';
    if (str.length <= maxLength) return str;
    return str.substring(0, maxLength) + '...';
  }

  private handleTodoWrite(input: any): string {
    // TodoWrite tool doesn't produce visible output - handled separately
    return '';
  }

  private async handleTodoUpdate(
    input: any, 
    sessionKey: string, 
    sessionId: string | undefined, 
    channel: string, 
    threadTs: string, 
    say: any
  ): Promise<void> {
    if (!sessionId || !input.todos) {
      return;
    }

    const newTodos: Todo[] = input.todos;
    const oldTodos = this.todoManager.getTodos(sessionId);
    
    // Check if there's a significant change
    if (this.todoManager.hasSignificantChange(oldTodos, newTodos)) {
      // Update the todo manager
      this.todoManager.updateTodos(sessionId, newTodos);
      
      // Format the todo list
      const todoList = this.todoManager.formatTodoList(newTodos);
      
      // Check if we already have a todo message for this session
      const existingTodoMessageTs = this.todoMessages.get(sessionKey);
      
      if (existingTodoMessageTs) {
        // Update existing todo message
        try {
          await this.app.client.chat.update({
            channel,
            ts: existingTodoMessageTs,
            text: todoList,
          });
          this.logger.debug('Updated existing todo message', { sessionKey, messageTs: existingTodoMessageTs });
        } catch (error) {
          this.logger.warn('Failed to update todo message, creating new one', error);
          // If update fails, create a new message
          await this.createNewTodoMessage(todoList, channel, threadTs, sessionKey, say);
        }
      } else {
        // Create new todo message
        await this.createNewTodoMessage(todoList, channel, threadTs, sessionKey, say);
      }

      // Send status change notification if there are meaningful changes
      const statusChange = this.todoManager.getStatusChange(oldTodos, newTodos);
      if (statusChange) {
        await say({
          text: `🔄 *Task Update:*\n${statusChange}`,
          thread_ts: threadTs,
        });
      }

      // Update reaction based on overall progress
      await this.updateTaskProgressReaction(sessionKey, newTodos);
    }
  }

  private async createNewTodoMessage(
    todoList: string, 
    channel: string, 
    threadTs: string, 
    sessionKey: string, 
    say: any
  ): Promise<void> {
    const result = await say({
      text: todoList,
      thread_ts: threadTs,
    });
    
    if (result?.ts) {
      this.todoMessages.set(sessionKey, result.ts);
      this.logger.debug('Created new todo message', { sessionKey, messageTs: result.ts });
    }
  }

  private async updateMessageReaction(sessionKey: string, emoji: string): Promise<void> {
    const originalMessage = this.originalMessages.get(sessionKey);
    if (!originalMessage) {
      return;
    }

    // Check if we're already showing this emoji
    const currentEmoji = this.currentReactions.get(sessionKey);
    if (currentEmoji === emoji) {
      this.logger.debug('Reaction already set, skipping', { sessionKey, emoji });
      return;
    }

    try {
      // Remove the current reaction if it exists
      if (currentEmoji) {
        try {
          await this.app.client.reactions.remove({
            channel: originalMessage.channel,
            timestamp: originalMessage.ts,
            name: currentEmoji,
          });
          this.logger.debug('Removed previous reaction', { sessionKey, emoji: currentEmoji });
        } catch (error) {
          this.logger.debug('Failed to remove previous reaction (might not exist)', { 
            sessionKey, 
            emoji: currentEmoji,
            error: (error as any).message 
          });
        }
      }

      // Add the new reaction
      await this.app.client.reactions.add({
        channel: originalMessage.channel,
        timestamp: originalMessage.ts,
        name: emoji,
      });

      // Track the current reaction
      this.currentReactions.set(sessionKey, emoji);

      this.logger.debug('Updated message reaction', { 
        sessionKey, 
        emoji, 
        previousEmoji: currentEmoji,
        channel: originalMessage.channel, 
        ts: originalMessage.ts 
      });
    } catch (error) {
      this.logger.warn('Failed to update message reaction', error);
    }
  }

  private async updateTaskProgressReaction(sessionKey: string, todos: Todo[]): Promise<void> {
    if (todos.length === 0) {
      return;
    }

    const completed = todos.filter(t => t.status === 'completed').length;
    const inProgress = todos.filter(t => t.status === 'in_progress').length;
    const total = todos.length;

    let emoji: string;
    if (completed === total) {
      emoji = '✅'; // All tasks completed
    } else if (inProgress > 0) {
      emoji = '🔄'; // Tasks in progress
    } else {
      emoji = '📋'; // Tasks pending
    }

    await this.updateMessageReaction(sessionKey, emoji);
  }

  private isHelpCommand(text: string): boolean {
    return /^-(help|commands|도움말)(\?)?$/i.test(text.trim());
  }

  private getHelpText(): string {
    let help = `*Claude Code Bot — Commands*\n\n`;
    help += `*Working Directory*\n`;
    help += `\`-cwd <path>\` — Set working directory (relative or absolute)\n`;
    help += `\`-cwd\` — Show current working directory\n\n`;
    help += `*Session*\n`;
    help += `\`-sessions\` — List recent sessions for current working directory\n`;
    help += `\`-continue\` — Resume the last CLI session\n`;
    help += `\`-resume <session-id>\` — Resume a specific session\n`;
    help += `\`-resume <session-id> <message>\` — Resume with a follow-up message\n`;
    help += `\`-reset\` — End current session (next message starts a new one)\n\n`;
    help += `*Settings*\n`;
    help += `\`-model [name]\` — Get/set model (\`sonnet\`, \`opus\`, \`haiku\`, or full name)\n`;
    help += `\`-budget [amount]\` — Get/set max budget per query (USD)\n`;
    help += `\`-cost\` — Show last query cost and session ID\n\n`;
    help += `*MCP*\n`;
    help += `\`-mcp\` — Show MCP server status\n`;
    help += `\`-mcp reload\` — Reload MCP configuration\n\n`;
    help += `*Other*\n`;
    help += `\`-help\` — Show this help message\n`;
    return help;
  }

  private isResetCommand(text: string): boolean {
    return /^-(reset|새로시작)$/i.test(text.trim());
  }

  private parseModelCommand(text: string): string | null {
    const match = text.trim().match(/^-model(?:\s+(\S+))?$/i);
    if (match) return match[1] || ''; // empty string = show current
    return null;
  }

  private parseBudgetCommand(text: string): number | null {
    const match = text.trim().match(/^-budget(?:\s+([\d.]+|off|reset))?$/i);
    if (!match) return null;
    const val = match[1];
    if (!val) return -1; // show current
    if (val === 'off' || val === 'reset') return 0; // disable
    return parseFloat(val);
  }

  private isCostCommand(text: string): boolean {
    return /^-cost$/i.test(text.trim());
  }

  private isSessionsCommand(text: string): boolean {
    return /^-sessions?(\s+list)?$/i.test(text.trim());
  }

  private getProjectsDir(cwd: string): string {
    const encoded = cwd.replace(/[^a-zA-Z0-9]/g, '-');
    return path.join(os.homedir(), '.claude', 'projects', encoded);
  }

  private listSessions(cwd: string, limit: number = 10): Array<{ id: string; date: Date; summary: string; preview: string }> {
    const projectsDir = this.getProjectsDir(cwd);

    if (!fs.existsSync(projectsDir)) {
      return [];
    }

    const files = fs.readdirSync(projectsDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => {
        const fullPath = path.join(projectsDir, f);
        return {
          name: f,
          path: fullPath,
          mtime: fs.statSync(fullPath).mtime,
        };
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

            // Extract summary title
            if (msg.type === 'summary' && msg.summary && !summary) {
              summary = msg.summary;
            }

            // Extract first user message as preview
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
          } catch { /* skip unparseable lines */ }
        }
      } catch { /* skip unreadable files */ }

      sessions.push({
        id: sessionId,
        date: file.mtime,
        summary,
        preview: preview.substring(0, 100) + (preview.length > 100 ? '...' : ''),
      });
    }

    return sessions;
  }

  private formatSessionsList(sessions: Array<{ id: string; date: Date; summary: string; preview: string }>): string {
    if (sessions.length === 0) {
      return `ℹ️ No sessions found for this working directory.`;
    }

    let msg = `*Recent Sessions*\n\n`;
    for (const s of sessions) {
      const dateStr = s.date.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      const title = s.summary || s.preview || '(no preview)';
      msg += `• \`${s.id}\`\n`;
      msg += `  ${dateStr} — ${title}\n\n`;
    }
    msg += `_Use \`-resume <session-id>\` to resume a session._`;
    return msg;
  }

  private parseResumeCommand(text: string): { resumeOptions: { continueLastSession?: boolean; resumeSessionId?: string }; prompt?: string } | null {
    const trimmed = text.trim();

    // "-continue" or "-continue <prompt>"
    const continueMatch = trimmed.match(/^-continue(?:\s+(.+))?$/is);
    if (continueMatch) {
      return {
        resumeOptions: { continueLastSession: true },
        prompt: continueMatch[1]?.trim() || undefined,
      };
    }

    // "-resume <session-id>" or "-resume <session-id> <prompt>" or just "-resume"
    // Allow optional backticks around UUID (Slack inline code formatting)
    const resumeMatch = trimmed.match(/^-resume(?:\s+`?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})`?)?(?:\s+(.+))?$/is);
    if (resumeMatch) {
      const sessionId = resumeMatch[1];
      const prompt = resumeMatch[2]?.trim() || undefined;

      if (sessionId) {
        return {
          resumeOptions: { resumeSessionId: sessionId },
          prompt,
        };
      }
      // "resume" without session ID → same as "continue"
      return {
        resumeOptions: { continueLastSession: true },
        prompt,
      };
    }

    return null;
  }

  private isRateLimitError(error: any): boolean {
    const msg = error?.message || '';
    return /rate.?limit|overloaded|429|too many requests|capacity|usage limit/i.test(msg);
  }

  private parseRetryAfterSeconds(error: any): number {
    const msg = error?.message || '';
    // Try to extract retry-after from error message (e.g., "retry after 300 seconds")
    const match = msg.match(/retry.?after[:\s]+(\d+)/i);
    if (match) return parseInt(match[1], 10);
    // Try to find minutes (e.g., "try again in 5 minutes")
    const minMatch = msg.match(/(\d+)\s*minutes?/i);
    if (minMatch) return parseInt(minMatch[1], 10) * 60;
    // Default: suggest 5 hours (Claude Pro session window)
    return 5 * 60 * 60;
  }

  private isMcpInfoCommand(text: string): boolean {
    return /^-mcp(\s+(info|list|status))?(\?)?$/i.test(text.trim());
  }

  private isMcpReloadCommand(text: string): boolean {
    return /^-mcp\s+(reload|refresh)$/i.test(text.trim());
  }

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

  private async handleChannelJoin(channelId: string, say: any): Promise<void> {
    try {
      // Get channel info
      const channelInfo = await this.app.client.conversations.info({
        channel: channelId,
      });

      const channelName = (channelInfo.channel as any)?.name || 'this channel';
      
      let welcomeMessage = `👋 Hi! I'm Claude Code, your AI coding assistant.\n\n`;
      welcomeMessage += `To get started, I need to know the default working directory for #${channelName}.\n\n`;
      
      if (config.baseDirectory) {
        welcomeMessage += `You can use:\n`;
        welcomeMessage += `• \`-cwd project-name\` (relative to base directory: \`${config.baseDirectory}\`)\n`;
        welcomeMessage += `• \`-cwd /absolute/path/to/project\` (absolute path)\n\n`;
      } else {
        welcomeMessage += `Please set it using:\n`;
        welcomeMessage += `• \`-cwd /path/to/project\`\n\n`;
      }

      welcomeMessage += `This will be the default working directory for this channel. `;
      welcomeMessage += `You can always override it for specific threads with \`-cwd\`.\n\n`;
      welcomeMessage += `Type \`-help\` to see all available commands.`;

      await say({
        text: welcomeMessage,
      });

      this.logger.info('Sent welcome message to channel', { channelId, channelName });
    } catch (error) {
      this.logger.error('Failed to handle channel join', error);
    }
  }

  private formatMessage(text: string, isFinal: boolean): string {
    // Convert markdown code blocks to Slack format
    let formatted = text
      .replace(/```(\w+)?\n([\s\S]*?)```/g, (_, lang, code) => {
        return '```' + code + '```';
      })
      .replace(/`([^`]+)`/g, '`$1`')
      .replace(/\*\*([^*]+)\*\*/g, '*$1*')
      .replace(/__([^_]+)__/g, '_$1_');

    return formatted;
  }

  setupEventHandlers() {
    // Handle direct messages
    this.app.message(async ({ message, say }) => {
      if (message.subtype === undefined && 'user' in message) {
        this.logger.info('Handling direct message event');
        // Strip bot mentions in DMs (same as app_mention handler)
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
      await this.handleMessage({
        ...event,
        text,
      } as MessageEvent, say);
    });

    // Handle file uploads in threads
    this.app.event('message', async ({ event, say }) => {
      // Only handle file uploads that are not from bots and have files
      if (event.subtype === 'file_share' && 'user' in event && event.files) {
        this.logger.info('Handling file upload event');
        await this.handleMessage(event as MessageEvent, say);
      }
    });

    // Handle bot being added to channels
    this.app.event('member_joined_channel', async ({ event, say }) => {
      // Check if the bot was added to the channel
      if (event.user === await this.getBotUserId()) {
        this.logger.info('Bot added to channel', { channel: event.channel });
        await this.handleChannelJoin(event.channel, say);
      }
    });

    // Handle permission approval button clicks
    this.app.action('approve_tool', async ({ ack, body, respond }) => {
      await ack();
      const approvalId = (body as any).actions[0].value;
      this.logger.info('Tool approval granted', { approvalId });
      
      permissionServer.resolveApproval(approvalId, true);
      
      await respond({
        response_type: 'ephemeral',
        text: '✅ Tool execution approved'
      });
    });

    // Handle permission denial button clicks
    this.app.action('deny_tool', async ({ ack, body, respond }) => {
      await ack();
      const approvalId = (body as any).actions[0].value;
      this.logger.info('Tool approval denied', { approvalId });
      
      permissionServer.resolveApproval(approvalId, false);
      
      await respond({
        response_type: 'ephemeral',
        text: '❌ Tool execution denied'
      });
    });

    // Handle scheduled retry button clicks
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

        await respond({
          response_type: 'in_channel',
          text: `✅ ${retryTime}에 재실행이 예약되었습니다.`,
        });

        this.logger.info('Scheduled retry message', { retryTime, channel: retryInfo.channel });
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
    }, 5 * 60 * 1000); // Every 5 minutes
  }
}