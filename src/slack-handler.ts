import { App } from '@slack/bolt';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CliHandler, type CliEvent, type CliProcess, type CliAssistantEvent, type CliResultEvent, type CliRateLimitEvent } from './cli-handler';
import { PendingDenial } from './types';
import { Logger } from './logger';
import { WorkingDirectoryManager } from './working-directory-manager';
import { FileHandler, ProcessedFile } from './file-handler';
import { TodoManager, Todo } from './todo-manager';
import { McpManager } from './mcp-manager';
import { SessionScanner, SessionInfo, formatRelativeTime } from './session-scanner';
import { ScheduleManager } from './schedule-manager';
import { config } from './config';
import { Locale, t, formatTime, formatDateTime, getHelpText as getHelpTextI18n } from './messages';

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
  private cliHandler: CliHandler;
  private logger = new Logger('SlackHandler');
  private workingDirManager: WorkingDirectoryManager;
  private fileHandler: FileHandler;
  private todoManager: TodoManager;
  private mcpManager: McpManager;

  // Active CLI process tracking (for interrupt/stop)
  private activeProcesses: Map<string, CliProcess> = new Map();

  // UI state
  private todoMessages: Map<string, string> = new Map();
  private originalMessages: Map<string, { channel: string; ts: string }> = new Map();
  private currentReactions: Map<string, Set<string>> = new Map();

  // Thread hint tracking (show command hint once per thread)
  private hintShownThreads: Set<string> = new Set();

  // Per-channel settings
  private channelModels: Map<string, string> = new Map();
  private channelBudgets: Map<string, number> = new Map();
  private channelPermissionModes: Map<string, 'default' | 'safe' | 'trust'> = new Map();
  private channelAlwaysApproveTools: Map<string, Set<string>> = new Map();
  private lastQueryCosts: Map<string, { cost: number; duration: number; model: string; sessionId: string }> = new Map();

  // Permission denial tracking (CLI mode)
  private pendingDenials: Map<string, PendingDenial> = new Map();
  // One-time approved tools (consumed on next handleMessage call)
  private pendingOneTimeTools: Map<string, string[]> = new Map();

  // Rate limit retry
  private pendingRetries: Map<string, { prompt: string; channel: string; threadTs: string; user: string; notifyScheduledId?: string }> = new Map();

  // Plan mode: store session info for "Execute" button
  private pendingPlans: Map<string, { sessionId: string; prompt: string; channel: string; threadTs: string; user: string }> = new Map();

  // Session picker
  private sessionScanner: SessionScanner = new SessionScanner();
  private pendingPickers: Map<string, {
    sessions: SessionInfo[];
    channel: string;
    threadTs: string;
    user: string;
    messageTs: string;
    timeout: ReturnType<typeof setTimeout>;
    shownCount: number;
    locale: Locale;
  }> = new Map();

  private botUserId: string | null = null;
  private userLocales: Map<string, Locale> = new Map();

  // API key management
  private userApiKeys: Map<string, string> = new Map();
  private apiKeyActive: Map<string, { userId: string; resetTimerId: ReturnType<typeof setTimeout> }> = new Map();
  private readonly API_KEYS_FILE = path.join(__dirname, '..', '.api-keys.json');

  // Session schedule
  private scheduleManager = new ScheduleManager();

  constructor(app: App, cliHandler: CliHandler, mcpManager: McpManager) {
    this.app = app;
    this.cliHandler = cliHandler;
    this.mcpManager = mcpManager;
    this.workingDirManager = new WorkingDirectoryManager();
    this.fileHandler = new FileHandler();
    this.todoManager = new TodoManager();
    this.loadApiKeys();
  }

  private async getUserLocale(userId: string): Promise<Locale> {
    const cached = this.userLocales.get(userId);
    if (cached) return cached;
    try {
      const response = await this.app.client.users.info({ user: userId, include_locale: true });
      const slackLocale = (response.user as any)?.locale || 'en-US';
      const locale: Locale = slackLocale.startsWith('ko') ? 'ko' : 'en';
      this.userLocales.set(userId, locale);
      return locale;
    } catch {
      return 'en';
    }
  }

  async handleMessage(event: MessageEvent, say: any) {
    const { user, channel, thread_ts, ts, text, files } = event;
    const locale = await this.getUserLocale(user);

    // Process any attached files
    let processedFiles: ProcessedFile[] = [];
    if (files && files.length > 0) {
      this.logger.info('Processing uploaded files', { count: files.length });
      processedFiles = await this.fileHandler.downloadAndProcessFiles(files);

      if (processedFiles.length > 0) {
        await say({
          text: `📎 ${t('file.processing', locale, { count: processedFiles.length, names: processedFiles.map(f => f.name).join(', ') })}`,
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
        const context = thread_ts ? t('cwd.context.thread', locale) : (isDM ? t('cwd.context.dm', locale) : t('cwd.context.channel', locale));
        await say({ text: `✅ ${t('cwd.set', locale, { context, path: result.resolvedPath! })}`, thread_ts: thread_ts || ts });
      } else {
        await say({ text: `❌ ${result.error}`, thread_ts: thread_ts || ts });
      }
      return;
    }

    if (text && this.workingDirManager.isGetCommand(text)) {
      const isDM = channel.startsWith('D');
      const directory = this.workingDirManager.getWorkingDirectory(channel, thread_ts, isDM ? user : undefined);
      const context = thread_ts ? t('cwd.context.thread', locale) : (isDM ? t('cwd.context.dm', locale) : t('cwd.context.channel', locale));
      await say({ text: this.workingDirManager.formatDirectoryMessage(directory, context, locale), thread_ts: thread_ts || ts });
      return;
    }

    // MCP commands
    if (text && this.isMcpInfoCommand(text)) {
      await say({ text: this.mcpManager.formatMcpInfo(locale), thread_ts: thread_ts || ts });
      return;
    }
    if (text && this.isMcpReloadCommand(text)) {
      const reloaded = this.mcpManager.reloadConfiguration();
      await say({
        text: reloaded
          ? `✅ ${t('cmd.mcp.reloadSuccess', locale)}\n\n${this.mcpManager.formatMcpInfo(locale)}`
          : `❌ ${t('cmd.mcp.reloadFailed', locale)}`,
        thread_ts: thread_ts || ts,
      });
      return;
    }

    // API key command — show button to open modal
    if (text && this.isApiKeyCommand(text)) {
      await say({
        thread_ts: thread_ts || ts,
        text: t('apiKey.modalBody', locale),
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: `🔑 ${t('apiKey.modalBody', locale)}` } },
          {
            type: 'actions',
            elements: [
              { type: 'button', text: { type: 'plain_text', text: t('apiKey.modalSubmit', locale) }, action_id: 'open_apikey_modal', value: JSON.stringify({}), style: 'primary' },
            ],
          },
        ],
      });
      return;
    }

    // Schedule command
    if (text) {
      const scheduleParsed = this.parseScheduleCommand(text);
      if (scheduleParsed) {
        await this.handleScheduleCommand(scheduleParsed, channel, thread_ts || ts, user, locale, say);
        return;
      }
    }

    // Stop command (interrupt running CLI process)
    if (text && this.isStopCommand(text)) {
      const sessionKey = this.cliHandler.getSessionKey(user, channel, thread_ts || ts);
      const activeProcess = this.activeProcesses.get(sessionKey);
      if (activeProcess) {
        activeProcess.interrupt();
        this.activeProcesses.delete(sessionKey);
        await say({ text: `⏹️ ${t('cmd.stop.stopped', locale)}`, thread_ts: thread_ts || ts });
      } else {
        await say({ text: `ℹ️ ${t('cmd.stop.noActive', locale)}`, thread_ts: thread_ts || ts });
      }
      return;
    }

    // Help command
    if (text && this.isHelpCommand(text)) {
      await say({ text: getHelpTextI18n(locale), thread_ts: thread_ts || ts });
      return;
    }

    // Reset command
    if (text && this.isResetCommand(text)) {
      this.cliHandler.removeSession(user, channel, thread_ts || ts);
      this.lastQueryCosts.delete(channel);
      this.channelAlwaysApproveTools.delete(channel);
      await say({
        text: `🔄 ${t('cmd.reset.done', locale)}`,
        thread_ts: thread_ts || ts,
      });
      return;
    }

    // Model command
    if (text) {
      const modelArg = this.parseModelCommand(text);
      if (modelArg !== null) {
        if (modelArg === '') {
          const current = this.channelModels.get(channel) || t('cmd.model.default', locale);
          await say({ text: `🤖 ${t('cmd.model.current', locale, { model: current })}`, thread_ts: thread_ts || ts });
        } else {
          this.channelModels.set(channel, modelArg);
          await say({ text: `🤖 ${t('cmd.model.set', locale, { model: modelArg })}`, thread_ts: thread_ts || ts });
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
            text: current ? `💰 ${t('cmd.budget.current', locale, { amount: current.toFixed(2) })}` : `💰 ${t('cmd.budget.none', locale)}`,
            thread_ts: thread_ts || ts,
          });
        } else if (budgetArg === 0) {
          this.channelBudgets.delete(channel);
          await say({ text: `💰 ${t('cmd.budget.removed', locale)}`, thread_ts: thread_ts || ts });
        } else {
          this.channelBudgets.set(channel, budgetArg);
          await say({ text: `💰 ${t('cmd.budget.set', locale, { amount: budgetArg.toFixed(2) })}`, thread_ts: thread_ts || ts });
        }
        return;
      }
    }

    // Permission mode commands: -default / -safe / -trust
    if (text && this.isDefaultModeCommand(text)) {
      this.channelPermissionModes.delete(channel);
      this.channelAlwaysApproveTools.delete(channel);
      await say({ text: `🔒 ${t('cmd.defaultMode', locale)}`, thread_ts: thread_ts || ts });
      return;
    }
    if (text && this.isSafeCommand(text)) {
      this.channelPermissionModes.set(channel, 'safe');
      await say({ text: `🛡️ ${t('cmd.safeMode', locale)}`, thread_ts: thread_ts || ts });
      return;
    }
    if (text && this.isTrustCommand(text)) {
      this.channelPermissionModes.set(channel, 'trust');
      await say({ text: `⚡ ${t('cmd.trustMode', locale)}`, thread_ts: thread_ts || ts });
      return;
    }

    // Sessions command
    if (text && this.isSessionsCommand(text)) {
      // -sessions all → cross-project picker
      if (/^-sessions?\s+(all|전체)$/i.test(text.trim())) {
        await this.showSessionPicker(channel, thread_ts || ts, user, say, locale);
        return;
      }
      // -sessions → current cwd sessions
      const isDMForSessions = channel.startsWith('D');
      const cwdForSessions = this.workingDirManager.getWorkingDirectory(channel, thread_ts, isDMForSessions ? user : undefined);
      if (cwdForSessions) {
        const sessions = this.listSessions(cwdForSessions);
        await say({ text: this.formatSessionsList(sessions, locale), thread_ts: thread_ts || ts });
      } else {
        await say({ text: `⚠️ ${t('cmd.sessions.noCwd', locale)}`, thread_ts: thread_ts || ts });
      }
      return;
    }

    // Cost command
    if (text && this.isCostCommand(text)) {
      const costInfo = this.lastQueryCosts.get(channel);
      if (costInfo) {
        let msg = `💵 ${t('cmd.cost.header', locale)}\n`;
        msg += `• ${t('cmd.cost.costLine', locale, { cost: costInfo.cost.toFixed(4) })}\n`;
        msg += `• ${t('cmd.cost.durationLine', locale, { duration: (costInfo.duration / 1000).toFixed(1) })}\n`;
        msg += `• ${t('cmd.cost.modelLine', locale, { model: costInfo.model })}\n`;
        msg += `• ${t('cmd.cost.sessionLine', locale, { sessionId: costInfo.sessionId })}`;
        await say({ text: msg, thread_ts: thread_ts || ts });
      } else {
        await say({ text: `ℹ️ ${t('cmd.cost.noData', locale)}`, thread_ts: thread_ts || ts });
      }
      return;
    }

    // Resume/continue command
    const resumeParsed = text ? this.parseResumeCommand(text) : null;

    // Session picker: -r or -resume (no args) — works without cwd
    if (resumeParsed?.mode === 'picker') {
      await this.showSessionPicker(channel, thread_ts || ts, user, say, locale);
      return;
    }

    // Plan command: -plan <prompt>
    const planParsed = text ? this.parsePlanCommand(text) : null;

    // --- Working directory check ---
    const isDM = channel.startsWith('D');
    const workingDirectory = this.workingDirManager.getWorkingDirectory(channel, thread_ts, isDM ? user : undefined);

    if (!workingDirectory) {
      let errorMessage = `⚠️ ${t('cwd.noCwd', locale)}`;
      if (!isDM && !this.workingDirManager.hasChannelWorkingDirectory(channel)) {
        errorMessage += `${t('cwd.noCwd.channel', locale)}\n`;
        if (config.baseDirectory) {
          errorMessage += t('cwd.noCwd.relativeHint', locale, { baseDir: config.baseDirectory });
        } else {
          errorMessage += t('cwd.noCwd.absoluteHint', locale);
        }
      } else if (thread_ts) {
        errorMessage += t('cwd.noCwd.thread', locale);
      } else {
        errorMessage += t('cwd.noCwd.generic', locale);
      }
      await say({ text: errorMessage, thread_ts: thread_ts || ts });
      return;
    }

    // --- Main query execution ---
    const sessionKey = this.cliHandler.getSessionKey(user, channel, thread_ts || ts);
    const originalMessageTs = thread_ts || ts;
    this.originalMessages.set(sessionKey, { channel, ts: originalMessageTs });

    // Cancel any existing CLI process for this conversation
    const existingProcess = this.activeProcesses.get(sessionKey);
    if (existingProcess) {
      this.logger.debug('Cancelling existing CLI process for session', { sessionKey });
      existingProcess.interrupt();
    }

    let session = this.cliHandler.getSession(user, channel, thread_ts || ts);
    const isNewSession = !session;
    if (!session) {
      session = this.cliHandler.createSession(user, channel, thread_ts || ts);
    }

    // Determine prompt
    const resumeData = (resumeParsed && 'resumeOptions' in resumeParsed) ? resumeParsed : null;
    const basePrompt = planParsed
      ? planParsed.prompt
      : resumeData
        ? (resumeData.prompt || t('misc.continuePrompt', locale))
        : (text || '');
    const finalPrompt = processedFiles.length > 0
      ? await this.fileHandler.formatFilePrompt(processedFiles, basePrompt)
      : basePrompt;

    // Determine permission mode
    const isPlanMode = !!planParsed;
    const botPermLevel = this.channelPermissionModes.get(channel) || 'default';

    // Build allowed tools list for CLI --allowedTools
    const allowedTools = this.buildAllowedTools(channel, botPermLevel, sessionKey);

    let currentMessages: string[] = [];
    let statusMessageTs: string | undefined;
    let rateLimitInfo: { retryAfterSec: number; resetsAt: number; rateLimitType: string } | null = null;
    let rateLimitMessageText: string | undefined;
    let lastStatusText = '';
    let statusRepeatCount = 0;
    const toolUsageCounts = new Map<string, number>();
    const channelModel = this.channelModels.get(channel);

    try {
      this.logger.info('Spawning Claude CLI process', {
        prompt: finalPrompt.substring(0, 200) + (finalPrompt.length > 200 ? '...' : ''),
        sessionId: session.sessionId,
        workingDirectory,
        permissionMode: isPlanMode ? 'plan' : botPermLevel,
        fileCount: processedFiles.length,
      });

      const statusEmoji = isPlanMode ? '📝' : '🤔';
      const statusText = isPlanMode ? t('status.planning', locale) : t('status.thinking', locale);
      const statusResult = await say({ text: `${statusEmoji} ${statusText}`, thread_ts: thread_ts || ts });
      statusMessageTs = statusResult.ts;

      // Add anchor reaction first to prevent line jumping when progress reactions change
      await this.addAnchorReaction(sessionKey);
      await this.updateMessageReaction(sessionKey, statusEmoji);

      // Show command hint on first message in a new thread
      const threadKey = `${channel}:${thread_ts || ts}`;
      if (isNewSession && !this.hintShownThreads.has(threadKey)) {
        this.hintShownThreads.add(threadKey);
        await this.app.client.chat.postMessage({
          channel,
          thread_ts: thread_ts || ts,
          text: t('hint.threadStart', locale),
          blocks: [
            { type: 'context', elements: [{ type: 'mrkdwn', text: t('hint.threadStart', locale) }] },
          ],
        }).catch(() => {});
      }

      // Check if API key mode is active for this channel
      const apiKeyState = this.apiKeyActive.get(channel);
      let queryEnv: Record<string, string> | undefined;
      if (apiKeyState) {
        const apiKey = this.userApiKeys.get(apiKeyState.userId);
        if (apiKey) {
          queryEnv = { ANTHROPIC_API_KEY: apiKey };
        }
      }

      const resumeSessionId = resumeData?.mode === 'uuid' ? resumeData.resumeOptions.resumeSessionId : undefined;
      const continueLastSession = resumeData?.mode === 'continue' ? true : undefined;

      const cliProcess = this.cliHandler.runQuery(finalPrompt, {
        session,
        workingDirectory,
        resumeSessionId,
        continueLastSession,
        model: channelModel,
        maxBudgetUsd: this.channelBudgets.get(channel),
        permissionMode: isPlanMode ? 'plan' : botPermLevel,
        allowedTools,
        env: queryEnv,
      });

      this.activeProcesses.set(sessionKey, cliProcess);

      for await (const event of cliProcess) {
        // Session init tracking
        if (event.type === 'system' && (event as any).subtype === 'init') {
          const initEvent = event as any;
          if (session) {
            session.sessionId = initEvent.session_id;
            this.cliHandler.scheduleSave();
            this.logger.info('Session initialized', {
              sessionId: initEvent.session_id,
              model: initEvent.model,
              tools: initEvent.tools?.length || 0,
            });
          }
          continue;
        }

        // Stream events: show current tool in status
        if (event.type === 'stream_event') {
          const streamEvent = (event as CliEvent & { event: any }).event;
          if (streamEvent?.type === 'content_block_start' && streamEvent.content_block?.type === 'tool_use') {
            const toolName = streamEvent.content_block.name;
            toolUsageCounts.set(toolName, (toolUsageCounts.get(toolName) || 0) + 1);
            const toolEmoji = this.getToolReactionEmoji(toolName);
            if (statusMessageTs) {
              const newStatusText = `${toolEmoji} ${t('status.usingTool', locale, { toolName })}`;
              if (newStatusText === lastStatusText) {
                statusRepeatCount++;
                await this.app.client.chat.update({
                  channel,
                  ts: statusMessageTs,
                  text: `${toolEmoji} ${t('status.usingToolCount', locale, { toolName, count: statusRepeatCount })}`,
                }).catch(() => {});
              } else {
                lastStatusText = newStatusText;
                statusRepeatCount = 1;
                await this.app.client.chat.update({
                  channel,
                  ts: statusMessageTs,
                  text: newStatusText,
                }).catch(() => {});
              }
            }
            await this.updateMessageReaction(sessionKey, toolEmoji);
          }
          continue;
        }

        // Rate limit event from CLI
        if (event.type === 'rate_limit_event') {
          const rlEvent = event as CliRateLimitEvent;
          const info = rlEvent.rate_limit_info;
          if (info.status !== 'allowed') {
            const retryAfterSec = Math.max(60, info.resetsAt - Math.floor(Date.now() / 1000));
            rateLimitInfo = { retryAfterSec, resetsAt: info.resetsAt, rateLimitType: info.rateLimitType };
          }
          continue;
        }

        if (event.type === 'assistant') {
          const assistantEvent = event as CliAssistantEvent;

          // Track last assistant message UUID for session continuity
          if (assistantEvent.uuid && session) {
            session.lastAssistantUuid = assistantEvent.uuid;
            this.cliHandler.scheduleSave();
          }

          const contentParts = assistantEvent.message.content || [];
          const hasToolUse = contentParts.some((part: any) => part.type === 'tool_use');

          this.logger.debug('Assistant message received', {
            hasToolUse,
            partTypes: contentParts.map((p: any) => p.type),
            textPreview: contentParts.filter((p: any) => p.type === 'text').map((p: any) => p.text?.substring(0, 80)),
          });

          if (hasToolUse) {
            const todoTool = contentParts.find((part: any) =>
              part.type === 'tool_use' && part.name === 'TodoWrite'
            );
            if (todoTool) {
              await this.handleTodoUpdate(todoTool.input, sessionKey, session?.sessionId, channel, thread_ts || ts, say, locale);
            }

            const toolContent = this.formatToolUse(contentParts, locale);
            if (toolContent) {
              await say({ text: toolContent, thread_ts: thread_ts || ts });
            }
          } else {
            const content = this.extractTextFromContent(contentParts);
            if (content) {
              // NOTE: Do NOT check isRateLimitText on assistant text content here.
              // It causes false positives when Claude mentions "rate limit" in normal conversation.
              // Rate limits are reliably detected via rate_limit_event (line ~524) and result.is_error (line ~616).
              currentMessages.push(content);
              if (statusMessageTs) {
                const newStatusText = `✍️ ${t('status.writing', locale)}`;
                if (newStatusText !== lastStatusText) {
                  lastStatusText = newStatusText;
                  statusRepeatCount = 1;
                  await this.app.client.chat.update({ channel, ts: statusMessageTs, text: newStatusText }).catch(() => {});
                }
              }
              await this.updateMessageReaction(sessionKey, '✍️');
              await say({ text: this.formatMessage(content, false), thread_ts: thread_ts || ts });
            }
          }
        } else if (event.type === 'result') {
          const resultEvent = event as CliResultEvent;
          this.logger.info('Received result from CLI', {
            subtype: resultEvent.subtype,
            totalCost: resultEvent.total_cost_usd,
            duration: resultEvent.duration_ms,
            isError: resultEvent.is_error,
            denials: resultEvent.permission_denials?.length || 0,
            denialDetails: JSON.stringify(resultEvent.permission_denials),
          });

          // Store cost info
          if (resultEvent.total_cost_usd !== undefined && session?.sessionId) {
            this.lastQueryCosts.set(channel, {
              cost: resultEvent.total_cost_usd,
              duration: resultEvent.duration_ms || 0,
              model: channelModel || 'default',
              sessionId: session.sessionId,
            });
          }

          // Handle permission denials — show approval buttons (skip in plan mode)
          const denials = resultEvent.permission_denials || [];
          if (!isPlanMode && denials.length > 0 && (resultEvent.session_id || session?.sessionId)) {
            const sid = resultEvent.session_id || session?.sessionId || '';
            await this.showPermissionDenialButtons(
              channel, thread_ts || ts, user,
              denials, sid, say, locale
            );
          }

          // Handle rate limit from result
          if (resultEvent.is_error && !rateLimitInfo) {
            const resultText = resultEvent.result || '';
            if (this.isRateLimitText(resultText)) {
              rateLimitMessageText = resultText;
            }
          }

          if (resultEvent.subtype === 'success' && resultEvent.result) {
            if (!currentMessages.includes(resultEvent.result)) {
              await say({ text: this.formatMessage(resultEvent.result, true), thread_ts: thread_ts || ts });
            }
          }
        }
      }

      // Update session activity timestamp and flush to disk
      if (session) {
        session.lastActivity = new Date();
        this.cliHandler.saveNow();
      }

      // Completed
      const doneEmoji = isPlanMode ? '📋' : '✅';
      const doneLabel = isPlanMode ? t('status.planReady', locale) : t('status.taskCompleted', locale);
      const toolSummary = toolUsageCounts.size > 0
        ? ' (' + Array.from(toolUsageCounts.entries()).map(([name, count]) => count > 1 ? `${name} ×${count}` : name).join(', ') + ')'
        : '';
      if (statusMessageTs) {
        await this.app.client.chat.update({ channel, ts: statusMessageTs, text: `${doneEmoji} ${doneLabel}${toolSummary}` }).catch(() => {});
      }
      await this.updateMessageReaction(sessionKey, doneEmoji);
      await this.removeAnchorReaction(sessionKey);

      // Register session in sessions-index.json for CLI compatibility
      if (session?.sessionId && workingDirectory) {
        this.sessionScanner.registerSession({
          sessionId: session.sessionId,
          projectPath: workingDirectory,
          firstPrompt: basePrompt.substring(0, 100),
        });
      }

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
          text: `📋 ${t('plan.complete', locale)}`,
          blocks: [
            { type: 'section', text: { type: 'mrkdwn', text: `📋 ${t('plan.readyExecute', locale)}` } },
            {
              type: 'actions',
              elements: [
                {
                  type: 'button',
                  text: { type: 'plain_text', text: t('plan.execute', locale) },
                  action_id: 'execute_plan',
                  value: planId,
                  style: 'primary',
                },
                {
                  type: 'button',
                  text: { type: 'plain_text', text: t('plan.cancel', locale) },
                  action_id: 'cancel_plan',
                  value: planId,
                },
              ],
            },
          ],
        });
      }

      // Handle rate limit (from rate_limit_event or error text)
      if (rateLimitInfo || rateLimitMessageText) {
        const retryAfter = rateLimitInfo
          ? rateLimitInfo.retryAfterSec
          : this.parseRetryAfterSeconds({ message: rateLimitMessageText });
        await this.handleRateLimitUI(channel, thread_ts || ts, user, finalPrompt, retryAfter, locale, say);
      }

      // Clean up temp files
      if (processedFiles.length > 0) {
        await this.fileHandler.cleanupTempFiles(processedFiles);
      }
    } catch (error: any) {
      this.logger.error('Error handling message', error);

      if (statusMessageTs) {
        await this.app.client.chat.update({ channel, ts: statusMessageTs, text: `❌ ${t('status.errorOccurred', locale)}` }).catch(() => {});
      }
      await this.updateMessageReaction(sessionKey, '❌');
      await this.removeAnchorReaction(sessionKey);

      // Rate limit detection from error
      const rateLimitSource = rateLimitMessageText
        ? { message: rateLimitMessageText }
        : this.isRateLimitError(error) ? error : null;

      if (rateLimitSource) {
        const retryAfter = rateLimitInfo
          ? rateLimitInfo.retryAfterSec
          : this.parseRetryAfterSeconds(rateLimitSource);
        await this.handleRateLimitUI(channel, thread_ts || ts, user, finalPrompt, retryAfter, locale, say);
      } else {
        await say({ text: t('error.generic', locale, { message: error.message || t('error.somethingWrong', locale) }), thread_ts: thread_ts || ts });
      }

      if (processedFiles.length > 0) {
        await this.fileHandler.cleanupTempFiles(processedFiles);
      }
    } finally {
      this.activeProcesses.delete(sessionKey);

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

  // --- Build allowed tools list for CLI ---

  private buildAllowedTools(channel: string, permLevel: 'default' | 'safe' | 'trust', sessionKey?: string): string[] {
    if (permLevel === 'trust') return []; // --dangerously-skip-permissions used instead

    // Read-only tools (always allowed)
    const tools = [
      'Read', 'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch',
      'Task', 'TaskOutput', 'TodoRead', 'TodoWrite', 'NotebookRead',
      'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode',
      'Skill', 'TaskStop', 'EnterWorktree',
    ];

    // Safe mode: add edit tools
    if (permLevel === 'safe') {
      tools.push('Edit', 'MultiEdit', 'Write', 'NotebookEdit');
    }

    // Channel-specific always-approved tools
    const alwaysApproved = this.channelAlwaysApproveTools.get(channel);
    if (alwaysApproved) {
      for (const tool of alwaysApproved) {
        if (!tools.includes(tool)) tools.push(tool);
      }
    }

    // One-time approved tools (consumed after use)
    if (sessionKey) {
      const oneTime = this.pendingOneTimeTools.get(sessionKey);
      if (oneTime) {
        for (const tool of oneTime) {
          if (!tools.includes(tool)) tools.push(tool);
        }
        this.pendingOneTimeTools.delete(sessionKey);
      }
    }

    // MCP tools (mcp__ prefix pattern)
    const mcpTools = this.mcpManager.getDefaultAllowedTools();
    tools.push(...mcpTools);

    return tools;
  }

  // --- Permission denial UI (CLI mode) ---

  private async showPermissionDenialButtons(
    channel: string, threadTs: string, user: string,
    denials: Array<{ tool_name: string; tool_use_id: string; tool_input?: any }>,
    sessionId: string, say: any, locale: Locale
  ): Promise<void> {
    // Deduplicate tools
    const uniqueTools = [...new Set(denials.map(d => d.tool_name))];
    const denialId = `denial-${Date.now()}`;

    this.pendingDenials.set(denialId, {
      sessionId, deniedTools: uniqueTools,
      channel, threadTs, user,
    });
    setTimeout(() => this.pendingDenials.delete(denialId), 10 * 60 * 1000);

    const toolList = uniqueTools.map(tl => `\`${tl}\``).join(', ');
    const elements: any[] = [
      // Per-tool "Allow" buttons (max 3)
      ...uniqueTools.slice(0, 3).map(tool => ({
        type: 'button',
        text: { type: 'plain_text', text: t('permission.allowTool', locale, { toolName: tool }) },
        action_id: `allow_denied_tool_${tool}`,
        value: JSON.stringify({ denialId, tool }),
      })),
      // "Allow All & Resume" button
      {
        type: 'button',
        text: { type: 'plain_text', text: t('permission.allowAllAndResume', locale) },
        action_id: 'allow_all_denied_tools',
        value: JSON.stringify({ denialId }),
        style: 'primary',
      },
    ];

    await say({
      thread_ts: threadTs,
      text: t('permission.denied', locale, { tools: toolList }),
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: `🔐 ${t('permission.denied', locale, { tools: toolList })}` } },
        { type: 'actions', elements },
      ],
    });
  }

  // --- Rate limit UI helper ---

  private async handleRateLimitUI(
    channel: string, threadTs: string, user: string,
    prompt: string, retryAfterSec: number, locale: Locale, say: any
  ): Promise<void> {
    const postAt = Math.floor(Date.now() / 1000) + retryAfterSec;
    const retryTimeStr = formatTime(new Date(postAt * 1000), locale);
    const retryId = `retry-${Date.now()}`;

    this.pendingRetries.set(retryId, { prompt, channel, threadTs, user });
    setTimeout(async () => {
      const expiredRetry = this.pendingRetries.get(retryId);
      if (expiredRetry?.notifyScheduledId) {
        await this.app.client.chat.deleteScheduledMessage({
          channel: expiredRetry.channel,
          scheduled_message_id: expiredRetry.notifyScheduledId,
        }).catch(() => {});
      }
      this.pendingRetries.delete(retryId);
    }, 10 * 60 * 1000);

    // Auto-schedule a mention notification at reset time
    try {
      const notifyResult = await this.app.client.chat.scheduleMessage({
        channel,
        text: t('rateLimit.notify', locale, { user }),
        post_at: postAt,
        thread_ts: threadTs,
      });
      const retryInfo = this.pendingRetries.get(retryId);
      if (retryInfo && notifyResult.scheduled_message_id) {
        retryInfo.notifyScheduledId = notifyResult.scheduled_message_id;
      }
    } catch (notifyError) {
      this.logger.warn('Failed to schedule rate limit notification', notifyError);
    }

    const promptPreview = prompt.length > 200
      ? prompt.substring(0, 200) + '...'
      : prompt;

    await say({
      thread_ts: threadTs,
      text: `⏳ ${t('rateLimit.reached', locale)} ${t('rateLimit.retryEstimate', locale, { time: retryTimeStr, minutes: Math.round(retryAfterSec / 60) })}`,
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: `⏳ ${t('rateLimit.reached', locale)}\n${t('rateLimit.retryEstimate', locale, { time: retryTimeStr, minutes: Math.round(retryAfterSec / 60) })}` } },
        { type: 'context', elements: [{ type: 'mrkdwn', text: t('rateLimit.prompt', locale, { prompt: promptPreview }) }] },
        {
          type: 'actions',
          elements: [
            { type: 'button', text: { type: 'plain_text', text: t('rateLimit.continueWithApiKey', locale) }, action_id: 'continue_with_apikey', value: JSON.stringify({ retryId, retryAfter: retryAfterSec }), style: 'primary' },
            { type: 'button', text: { type: 'plain_text', text: t('rateLimit.schedule', locale, { time: retryTimeStr }) }, action_id: 'schedule_retry', value: JSON.stringify({ retryId, postAt, retryTimeStr }) },
            { type: 'button', text: { type: 'plain_text', text: t('rateLimit.cancel', locale) }, action_id: 'cancel_retry', value: retryId },
          ],
        },
        { type: 'context', elements: [{ type: 'mrkdwn', text: t('rateLimit.autoNotify', locale) }] },
      ],
    });
  }

  // --- Message content helpers ---

  private extractTextFromContent(content: Array<{ type: string; text?: string; [key: string]: any }>): string | null {
    const textParts = content
      .filter((part: any) => part.type === 'text')
      .map((part: any) => part.text);
    const result = textParts.join('');
    return result || null;
  }

  // Tools that only show in the status message (no separate say() needed)
  private static readonly STATUS_ONLY_TOOLS = new Set([
    'Read', 'Grep', 'Glob', 'LS', 'WebSearch', 'WebFetch',
    'ListMcpResourcesTool', 'ReadMcpResourceTool',
    'TodoRead', 'TodoWrite', 'NotebookRead',
  ]);

  private formatToolUse(content: any[], locale: Locale): string {
    const parts: string[] = [];
    for (const part of content) {
      if (part.type === 'text') {
        parts.push(part.text);
      } else if (part.type === 'tool_use') {
        const toolName = part.name;
        const input = part.input;

        // Skip tools already shown in status message
        if (SlackHandler.STATUS_ONLY_TOOLS.has(toolName)) continue;

        switch (toolName) {
          case 'Edit':
          case 'MultiEdit':
            parts.push(this.formatEditTool(toolName, input, locale));
            break;
          case 'Write':
            parts.push(this.formatWriteTool(input, locale));
            break;
          case 'Bash':
            parts.push(this.formatBashTool(input, locale));
            break;
          default:
            parts.push(this.formatGenericTool(toolName, input, locale));
        }
      }
    }
    return parts.join('\n\n');
  }

  private formatEditTool(toolName: string, input: any, locale: Locale): string {
    const filePath = input.file_path;
    const edits = toolName === 'MultiEdit' ? input.edits : [{ old_string: input.old_string, new_string: input.new_string }];
    let result = `📝 ${t('tool.editing', locale, { path: filePath })}\n`;
    for (const edit of edits) {
      result += '\n```diff\n';
      result += `- ${this.truncateString(edit.old_string, 200)}\n`;
      result += `+ ${this.truncateString(edit.new_string, 200)}\n`;
      result += '```';
    }
    return result;
  }

  private formatWriteTool(input: any, locale: Locale): string {
    return `📄 ${t('tool.creating', locale, { path: input.file_path })}\n\`\`\`\n${this.truncateString(input.content, 300)}\n\`\`\``;
  }

  private formatBashTool(input: any, locale: Locale): string {
    return `🖥️ ${t('tool.running', locale)}\n\`\`\`bash\n${input.command}\n\`\`\``;
  }

  private formatGenericTool(toolName: string, _input: any, locale: Locale): string {
    return `🔧 ${t('tool.using', locale, { toolName })}`;
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

  private async handleTodoUpdate(input: any, sessionKey: string, sessionId: string | undefined, channel: string, threadTs: string, say: any, locale: Locale = 'en'): Promise<void> {
    if (!sessionId || !input.todos) return;
    const newTodos: Todo[] = input.todos;
    const oldTodos = this.todoManager.getTodos(sessionId);

    if (this.todoManager.hasSignificantChange(oldTodos, newTodos)) {
      this.todoManager.updateTodos(sessionId, newTodos);
      const todoList = this.todoManager.formatTodoList(newTodos, locale);
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

      const statusChange = this.todoManager.getStatusChange(oldTodos, newTodos, locale);
      if (statusChange) {
        await say({ text: `🔄 ${t('tool.taskUpdate', locale)}\n${statusChange}`, thread_ts: threadTs });
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

  // Unicode emoji → Slack reaction shortcode mapping
  private readonly emojiToReaction: Record<string, string> = {
    '📝': 'memo',
    '🤔': 'thinking_face',
    '⚙️': 'gear',
    '📋': 'clipboard',
    '✅': 'white_check_mark',
    '❌': 'x',
    '⏹️': 'stop_button',
    '🔄': 'arrows_counterclockwise',
    '🔍': 'mag',
    '✏️': 'pencil2',
    '💻': 'computer',
    '🌐': 'globe_with_meridians',
    '🤖': 'robot_face',
    '🔌': 'electric_plug',
    '✍️': 'writing_hand',
  };

  private getToolReactionEmoji(toolName: string): string {
    if (['Read', 'Glob', 'Grep', 'LS'].includes(toolName)) return '🔍';
    if (['Edit', 'MultiEdit', 'Write', 'NotebookEdit'].includes(toolName)) return '✏️';
    if (toolName === 'Bash') return '💻';
    if (['WebFetch', 'WebSearch'].includes(toolName)) return '🌐';
    if (toolName === 'Task') return '🤖';
    if (toolName.startsWith('mcp__')) return '🔌';
    return '⚙️';
  }

  // Conflicting reaction groups: within each group, only one should be shown at a time
  private readonly conflictingReactionGroups: string[][] = [
    // Terminal states conflict with each other and with in-progress states
    ['white_check_mark', 'x', 'stop_button', 'clipboard'],
    // In-progress states conflict with each other and with terminal states
    ['thinking_face', 'memo', 'mag', 'pencil2', 'computer', 'globe_with_meridians', 'robot_face', 'electric_plug', 'gear', 'writing_hand', 'arrows_counterclockwise'],
  ];

  // Get all reactions that conflict with the given reaction (from all groups it belongs to, plus the other group)
  private getConflictingReactions(reactionName: string): Set<string> {
    const conflicts = new Set<string>();
    // All status reactions are mutually conflicting — collect from all groups
    for (const group of this.conflictingReactionGroups) {
      for (const r of group) {
        if (r !== reactionName) conflicts.add(r);
      }
    }
    return conflicts;
  }

  private readonly ANCHOR_REACTION = 'hourglass_flowing_sand'; // ⏳

  private async addAnchorReaction(sessionKey: string): Promise<void> {
    const originalMessage = this.originalMessages.get(sessionKey);
    if (!originalMessage) return;
    try {
      await this.app.client.reactions.add({ channel: originalMessage.channel, timestamp: originalMessage.ts, name: this.ANCHOR_REACTION });
    } catch { /* ignore */ }
  }

  private async removeAnchorReaction(sessionKey: string): Promise<void> {
    const originalMessage = this.originalMessages.get(sessionKey);
    if (!originalMessage) return;
    try {
      await this.app.client.reactions.remove({ channel: originalMessage.channel, timestamp: originalMessage.ts, name: this.ANCHOR_REACTION });
    } catch { /* ignore */ }
  }

  private async updateMessageReaction(sessionKey: string, emoji: string): Promise<void> {
    const originalMessage = this.originalMessages.get(sessionKey);
    if (!originalMessage) return;

    const reactionName = this.emojiToReaction[emoji] || emoji;
    let activeReactions = this.currentReactions.get(sessionKey);
    if (!activeReactions) {
      activeReactions = new Set();
      this.currentReactions.set(sessionKey, activeReactions);
    }

    // Already showing this exact reaction — nothing to do
    if (activeReactions.has(reactionName)) {
      // Still remove any conflicting ones that shouldn't be there
      const conflicts = this.getConflictingReactions(reactionName);
      for (const conflict of conflicts) {
        if (activeReactions.has(conflict)) {
          try {
            await this.app.client.reactions.remove({ channel: originalMessage.channel, timestamp: originalMessage.ts, name: conflict });
          } catch { /* might not exist */ }
          activeReactions.delete(conflict);
        }
      }
      return;
    }

    try {
      // Remove all conflicting reactions first
      const conflicts = this.getConflictingReactions(reactionName);
      for (const conflict of conflicts) {
        if (activeReactions.has(conflict)) {
          try {
            await this.app.client.reactions.remove({ channel: originalMessage.channel, timestamp: originalMessage.ts, name: conflict });
          } catch { /* might not exist */ }
          activeReactions.delete(conflict);
        }
      }

      // Add the new reaction
      await this.app.client.reactions.add({ channel: originalMessage.channel, timestamp: originalMessage.ts, name: reactionName });
      activeReactions.add(reactionName);
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

  private isDefaultModeCommand(text: string): boolean {
    return /^-default$/i.test(text.trim());
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
    return /^-sessions?(\s+(list|all|전체))?$/i.test(text.trim());
  }

  private parsePlanCommand(text: string): { prompt: string } | null {
    const match = text.trim().match(/^-plan\s+(.+)$/is);
    if (match) return { prompt: match[1].trim() };
    return null;
  }

  private parseResumeCommand(text: string): { mode: 'picker' } | { mode: 'uuid'; resumeOptions: { resumeSessionId: string }; prompt?: string } | { mode: 'continue'; resumeOptions: { continueLastSession: true }; prompt?: string } | null {
    const trimmed = text.trim();

    // -continue [message]
    const continueMatch = trimmed.match(/^-continue(?:\s+(.+))?$/is);
    if (continueMatch) {
      return { mode: 'continue', resumeOptions: { continueLastSession: true }, prompt: continueMatch[1]?.trim() || undefined };
    }

    // -resume <UUID> [message]
    const resumeUuidMatch = trimmed.match(/^-resume\s+`?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})`?(?:\s+(.+))?$/is);
    if (resumeUuidMatch) {
      return { mode: 'uuid', resumeOptions: { resumeSessionId: resumeUuidMatch[1] }, prompt: resumeUuidMatch[2]?.trim() || undefined };
    }

    // -r, -resume, resume, continue, keep going, 계속, 계속하자 (no args) → session picker
    if (/^-(r|resume)$/i.test(trimmed) || /^(resume|continue|keep\s*going|계속(하자)?)$/i.test(trimmed)) {
      return { mode: 'picker' };
    }

    // Natural language resume: short messages (≤30 chars) with resume-intent keywords
    if (trimmed.length <= 30) {
      const resumePatterns = /^(let'?s?\s*go|go\s*ahead|carry\s*on|pick\s*up|let'?s?\s*work|go|gg|start|일하자|하자|이어서|다시|시작|진행|작업|고고|ㄱㄱ)!?\.?$/i;
      if (resumePatterns.test(trimmed)) {
        return { mode: 'picker' };
      }
    }

    return null;
  }

  // --- Schedule command ---

  private parseScheduleCommand(text: string): { action: string; time?: string } | null {
    const trimmed = text.trim();
    if (/^`?-schedule`?$/i.test(trimmed)) return { action: 'status' };
    const addMatch = trimmed.match(/^`?-schedule`?\s+add\s+(\d{1,2}:\d{2})`?$/i);
    if (addMatch) return { action: 'add', time: addMatch[1] };
    const rmMatch = trimmed.match(/^`?-schedule`?\s+(?:remove|rm|del|delete)\s+(\d{1,2}:\d{2})`?$/i);
    if (rmMatch) return { action: 'remove', time: rmMatch[1] };
    if (/^`?-schedule`?\s+clear`?$/i.test(trimmed)) return { action: 'clear' };
    if (/^`?-schedule`?\s+channel`?$/i.test(trimmed)) return { action: 'channel' };
    return null;
  }

  private async handleScheduleCommand(
    parsed: { action: string; time?: string },
    channel: string,
    threadTs: string,
    userId: string,
    locale: Locale,
    say: any,
  ): Promise<void> {
    const { action, time } = parsed;

    if (action === 'status') {
      const cfg = this.scheduleManager.getConfig();
      if (!cfg || cfg.times.length === 0) {
        await say({ text: `📅 ${t('schedule.noConfig', locale)}`, thread_ts: threadTs });
        return;
      }
      const nextFires = this.scheduleManager.getNextFireTimes();
      const timesStr = cfg.times.join(', ');
      let msg = `📅 ${t('schedule.status.header', locale)}\n`;
      msg += `• ${t('schedule.status.channel', locale, { channel: cfg.channel })}\n`;
      msg += `• ${t('schedule.status.times', locale, { times: timesStr })}\n`;
      const soonest = nextFires.reduce((a, b) => a.nextFire < b.nextFire ? a : b);
      const minsUntil = Math.round((soonest.nextFire.getTime() - Date.now()) / 60000);
      msg += `• ${t('schedule.status.next', locale, { time: soonest.time, minutes: minsUntil.toString() })}`;
      await say({ text: msg, thread_ts: threadTs });
      return;
    }

    if (action === 'add') {
      const normalized = this.scheduleManager.addTime(time!, channel, userId);
      if (!normalized) {
        await say({ text: `❌ ${t('schedule.invalidTime', locale)}`, thread_ts: threadTs });
        return;
      }
      this.restartScheduler();
      await say({ text: `${t('schedule.added', locale, { time: normalized, channel })}`, thread_ts: threadTs });
      return;
    }

    if (action === 'remove') {
      const validTime = this.scheduleManager.normalizeTime(time!);
      if (!validTime) {
        await say({ text: `❌ ${t('schedule.invalidTime', locale)}`, thread_ts: threadTs });
        return;
      }
      const removed = this.scheduleManager.removeTime(validTime);
      if (!removed) {
        await say({ text: `⚠️ ${t('schedule.notFound', locale, { time: validTime })}`, thread_ts: threadTs });
        return;
      }
      this.restartScheduler();
      await say({ text: `${t('schedule.removed', locale, { time: removed })}`, thread_ts: threadTs });
      return;
    }

    if (action === 'clear') {
      this.scheduleManager.clearTimes();
      await say({ text: `${t('schedule.cleared', locale)}`, thread_ts: threadTs });
      return;
    }

    if (action === 'channel') {
      const updated = this.scheduleManager.updateChannel(channel, userId);
      if (!updated) {
        await say({ text: `⚠️ ${t('schedule.noConfigForChannel', locale)}`, thread_ts: threadTs });
        return;
      }
      this.restartScheduler();
      await say({ text: `${t('schedule.channelUpdated', locale, { channel })}`, thread_ts: threadTs });
    }
  }

  private restartScheduler(): void {
    this.scheduleManager.scheduleAll((ch, uid, time) => {
      this.runScheduledGreeting(ch, uid, time).catch(err =>
        this.logger.error('Scheduled greeting failed', err),
      );
    });
  }

  private async runScheduledGreeting(channel: string, userId: string, time: string): Promise<void> {
    const locale = await this.getUserLocale(userId).catch(() => 'ko' as Locale);

    // Post session start notification as top-level message
    const postResult = await this.app.client.chat.postMessage({
      channel,
      text: `🌅 ${t('schedule.sessionStart', locale)} (${time})`,
    });

    if (!postResult.ok || !postResult.ts) {
      this.logger.error('Failed to post scheduled greeting message');
      return;
    }

    const ts = postResult.ts as string;

    // Suppress thread hint for automated messages
    this.hintShownThreads.add(`${channel}:${ts}`);

    // Create say callback for this thread
    const say = async (args: any) => {
      if (typeof args === 'string') {
        return this.app.client.chat.postMessage({ channel, thread_ts: ts, text: args });
      }
      return this.app.client.chat.postMessage({ channel, ...args });
    };

    // Build synthetic event
    const event: MessageEvent = { user: userId, channel, ts, text: 'hi' };

    // Force haiku model for minimal token usage, restore after
    const prevModel = this.channelModels.get(channel);
    this.channelModels.set(channel, 'claude-haiku-4-5-20251001');
    try {
      await this.handleMessage(event, say);
    } finally {
      if (prevModel !== undefined) {
        this.channelModels.set(channel, prevModel);
      } else {
        this.channelModels.delete(channel);
      }
    }
  }

  private isRateLimitError(error: any): boolean {
    const msg = error?.message || '';
    return this.isRateLimitText(msg);
  }

  private isRateLimitText(text: string): boolean {
    return /rate.?limit|overloaded|429|too many requests|capacity|usage limit|spending.?cap|hit your limit|resets\s+\d{1,2}\s*(am|pm)/i.test(text);
  }

  // Extra buffer after reset time to avoid hitting limit again immediately
  private readonly RETRY_BUFFER_SECONDS = 3 * 60; // 3 minutes

  private parseRetryAfterSeconds(error: any): number {
    const msg = error?.message || '';
    const match = msg.match(/retry.?after[:\s]+(\d+)/i);
    if (match) return parseInt(match[1], 10) + this.RETRY_BUFFER_SECONDS;
    const minMatch = msg.match(/(\d+)\s*minutes?/i);
    if (minMatch) return parseInt(minMatch[1], 10) * 60 + this.RETRY_BUFFER_SECONDS;
    // "Spending cap reached resets 1pm" / "resets 2am" format
    const resetsMatch = msg.match(/resets\s+(\d{1,2})\s*(am|pm)/i);
    if (resetsMatch) {
      let hour = parseInt(resetsMatch[1], 10);
      if (resetsMatch[2].toLowerCase() === 'pm' && hour < 12) hour += 12;
      if (resetsMatch[2].toLowerCase() === 'am' && hour === 12) hour = 0;
      const now = new Date();
      const resetTime = new Date(now);
      resetTime.setHours(hour, 0, 0, 0);
      if (resetTime <= now) resetTime.setDate(resetTime.getDate() + 1);
      return Math.max(60, Math.floor((resetTime.getTime() - now.getTime()) / 1000) + this.RETRY_BUFFER_SECONDS);
    }
    return 5 * 60 * 60;
  }

  // --- API key management ---

  private loadApiKeys(): void {
    try {
      if (!fs.existsSync(this.API_KEYS_FILE)) return;
      const raw = fs.readFileSync(this.API_KEYS_FILE, 'utf-8');
      const data: Record<string, { apiKey: string; savedAt: string }> = JSON.parse(raw);
      for (const [userId, entry] of Object.entries(data)) {
        this.userApiKeys.set(userId, entry.apiKey);
      }
      this.logger.info(`Loaded ${this.userApiKeys.size} API key(s) from disk`);
    } catch (error) {
      this.logger.error('Failed to load API keys from disk', error);
    }
  }

  private saveApiKeys(): void {
    try {
      const data: Record<string, { apiKey: string; savedAt: string }> = {};
      for (const [userId, apiKey] of this.userApiKeys.entries()) {
        data[userId] = { apiKey, savedAt: new Date().toISOString() };
      }
      fs.writeFileSync(this.API_KEYS_FILE, JSON.stringify(data, null, 2), 'utf-8');
    } catch (error) {
      this.logger.error('Failed to save API keys to disk', error);
    }
  }

  private isApiKeyCommand(text: string): boolean {
    return /^`?-apikey`?$/i.test(text.trim());
  }

  private activateApiKey(channel: string, threadTs: string, userId: string, retryAfterSec: number, locale: Locale): void {
    // Clear any existing timer for this channel
    const existing = this.apiKeyActive.get(channel);
    if (existing?.resetTimerId) clearTimeout(existing.resetTimerId);

    const resetTimerId = setTimeout(async () => {
      this.apiKeyActive.delete(channel);
      try {
        await this.app.client.chat.postMessage({
          channel,
          thread_ts: threadTs,
          text: `🔄 ${t('apiKey.switchingToSubscription', locale)}`,
        });
      } catch (err) {
        this.logger.error('Failed to post subscription switch message', err);
      }
    }, retryAfterSec * 1000);

    this.apiKeyActive.set(channel, { userId, resetTimerId });
  }

  private isMcpInfoCommand(text: string): boolean {
    return /^-mcp(\s+(info|list|status))?(\?)?$/i.test(text.trim());
  }

  private isMcpReloadCommand(text: string): boolean {
    return /^-mcp\s+(reload|refresh)$/i.test(text.trim());
  }

  // --- Session picker ---

  private readonly PICKER_PAGE_SIZE = 5;
  private readonly MAX_PICKER_SESSIONS = 15; // 3*15+5=50 blocks, Slack hard limit

  private buildPickerBlocks(sessions: SessionInfo[], pickerId: string, shownCount: number, locale: Locale): any[] {
    const visible = sessions.slice(0, shownCount);
    const blocks: any[] = [
      { type: 'section', text: { type: 'mrkdwn', text: `📂 ${t('picker.title', locale)}` } },
    ];

    visible.forEach((s, index) => {
      const title = s.summary || s.firstPrompt || t('picker.noTitle', locale);
      const label = s.projectLabel;
      const branch = s.gitBranch;
      const relTime = formatRelativeTime(s.modified, locale);
      const projectInfo = branch ? `*${label}* · \`${branch}\`` : `*${label}*`;
      const shortId = s.sessionId.substring(0, 8);

      blocks.push({ type: 'divider' });
      blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `${projectInfo} · _${relTime}_ · \`${shortId}\`\n${title}\n\`${s.projectPath}\`` }],
      });
      blocks.push({
        type: 'actions',
        elements: [{
          type: 'button',
          text: { type: 'plain_text', text: t('picker.resume', locale) },
          action_id: `pick_${index + 1}`,
          value: JSON.stringify({ pickerId, index }),
        }],
      });
    });

    // "Show more" or cap-reached guidance
    if (shownCount < sessions.length) {
      blocks.push({ type: 'divider' });
      if (shownCount < this.MAX_PICKER_SESSIONS) {
        blocks.push({
          type: 'actions',
          elements: [{
            type: 'button',
            text: { type: 'plain_text', text: t('picker.showMore', locale, { count: Math.min(this.PICKER_PAGE_SIZE, sessions.length - shownCount) }) },
            action_id: 'picker_show_more',
            value: JSON.stringify({ pickerId }),
          }],
        });
      } else {
        const remaining = sessions.length - shownCount;
        blocks.push({
          type: 'context',
          elements: [{ type: 'mrkdwn', text: t('picker.moreAvailable', locale, { remaining: remaining.toString() }) }],
        });
      }
    }

    blocks.push({ type: 'divider' });
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `${t('picker.footer', locale)} (${shownCount}/${sessions.length})` }] });

    return blocks;
  }

  private async showSessionPicker(channel: string, threadTs: string, user: string, say: any, locale: Locale = 'en'): Promise<void> {
    const knownPaths = this.workingDirManager.getKnownPathsMap();
    const sessions = this.sessionScanner.listRecentSessions(30, knownPaths);

    if (sessions.length === 0) {
      await say({ text: `ℹ️ ${t('picker.noSessions', locale)}`, thread_ts: threadTs });
      return;
    }

    const pickerId = `picker-${Date.now()}`;
    const shownCount = Math.min(this.PICKER_PAGE_SIZE, sessions.length);
    const blocks = this.buildPickerBlocks(sessions, pickerId, shownCount, locale);

    const result = await say({ text: `📂 ${t('picker.title', locale)}`, blocks, thread_ts: threadTs });

    // Store picker state
    const timeout = setTimeout(() => {
      this.pendingPickers.delete(pickerId);
      this.app.client.chat.update({
        channel, ts: result.ts,
        text: `📂 ${t('picker.expired', locale)}`,
        blocks: [],
      }).catch(() => {});
    }, 300_000); // 5 minutes

    this.pendingPickers.set(pickerId, {
      sessions,
      channel,
      threadTs,
      user,
      messageTs: result.ts,
      timeout,
      shownCount,
      locale,
    });
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

  private formatSessionsList(sessions: Array<{ id: string; date: Date; summary: string; preview: string }>, locale: Locale = 'en'): string {
    if (sessions.length === 0) return `ℹ️ ${t('sessions.noSessions', locale)}`;
    let msg = `${t('sessions.title', locale)}\n\n`;
    for (const s of sessions) {
      const dateStr = formatDateTime(s.date, locale);
      const title = s.summary || s.preview || t('sessions.noPreview', locale);
      msg += `• \`${s.id}\`\n  ${dateStr} — ${title}\n\n`;
    }
    msg += t('sessions.resumeHint', locale);
    return msg;
  }

  // getHelpText is now provided by messages.ts (getHelpTextI18n)

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

  private async handleChannelJoin(channelId: string, say: any, locale: Locale = 'en'): Promise<void> {
    try {
      const channelInfo = await this.app.client.conversations.info({ channel: channelId });
      const channelName = (channelInfo.channel as any)?.name || 'this channel';

      let welcomeMessage = `👋 ${t('welcome.greeting', locale)}\n\n`;
      welcomeMessage += `${t('welcome.needCwd', locale, { channel: channelName })}\n\n`;
      if (config.baseDirectory) {
        welcomeMessage += `${t('welcome.useRelative', locale, { baseDir: config.baseDirectory })}\n\n`;
      } else {
        welcomeMessage += `${t('welcome.useAbsolute', locale)}\n\n`;
      }
      welcomeMessage += `${t('welcome.channelDefault', locale)}\n\n`;
      welcomeMessage += t('welcome.helpHint', locale);

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

    // Start session scheduler
    this.restartScheduler();

    // --- Interactive button handlers ---

    // Permission denial: "Allow All & Resume" — approve all denied tools and resume
    this.app.action('allow_all_denied_tools', async ({ ack, body, respond }) => {
      await ack();
      try {
        const actionLocale = await this.getUserLocale((body as any).user.id);
        const actionValue = JSON.parse((body as any).actions[0].value);
        const denial = this.pendingDenials.get(actionValue.denialId);
        if (!denial) {
          await respond({ response_type: 'ephemeral', text: `⚠️ ${t('approval.expired', actionLocale)}` });
          return;
        }

        // Register each denied tool as always-approved for this channel
        let toolSet = this.channelAlwaysApproveTools.get(denial.channel);
        if (!toolSet) { toolSet = new Set(); this.channelAlwaysApproveTools.set(denial.channel, toolSet); }
        for (const tool of denial.deniedTools) toolSet.add(tool);
        this.pendingDenials.delete(actionValue.denialId);

        await respond({ response_type: 'in_channel', text: `🔓 ${t('permission.resuming', actionLocale)}` });

        // Resume the session — tell Claude the tools are now approved so it retries
        const toolNames = denial.deniedTools.join(', ');
        const resumePrompt = `The following tools have been approved: ${toolNames}. Please retry the previously denied operation.`;
        const event: MessageEvent = {
          user: denial.user, channel: denial.channel,
          thread_ts: denial.threadTs, ts: denial.threadTs,
          text: `-resume ${denial.sessionId} ${resumePrompt}`,
        };
        const sayCb = async (msg: any) => this.app.client.chat.postMessage({ channel: denial.channel, ...msg });
        await this.handleMessage(event, sayCb);
      } catch (error) {
        this.logger.error('Error handling allow_all_denied_tools', error);
      }
    });

    // Permission denial: "Allow <tool>" — one-time approve and resume
    this.app.action(/^allow_denied_tool_/, async ({ ack, body, respond }) => {
      await ack();
      try {
        const actionLocale = await this.getUserLocale((body as any).user.id);
        const actionValue = JSON.parse((body as any).actions[0].value);
        const denial = this.pendingDenials.get(actionValue.denialId);
        if (!denial) {
          await respond({ response_type: 'ephemeral', text: `⚠️ ${t('approval.expired', actionLocale)}` });
          return;
        }

        // Track one-time approved tools for this denial (not channel-wide)
        if (!denial.approvedTools) denial.approvedTools = new Set();
        denial.approvedTools.add(actionValue.tool);

        await respond({ response_type: 'ephemeral', text: `✅ ${t('permission.allowTool', actionLocale, { toolName: actionValue.tool })}` });

        // Check if all denied tools are now approved (one-time or channel-wide)
        const channelSet = this.channelAlwaysApproveTools.get(denial.channel) || new Set();
        const allApproved = denial.deniedTools.every(tl => denial.approvedTools!.has(tl) || channelSet.has(tl));
        if (allApproved) {
          this.pendingDenials.delete(actionValue.denialId);

          await this.app.client.chat.postMessage({
            channel: denial.channel,
            thread_ts: denial.threadTs,
            text: `🔓 ${t('permission.resuming', actionLocale)}`,
          });

          // Resume with one-time + channel-wide approved tools
          const oneTimeTools = [...(denial.approvedTools || [])];
          const toolNames = denial.deniedTools.join(', ');
          const resumePrompt = `The following tools have been approved: ${toolNames}. Please retry the previously denied operation.`;
          const event: MessageEvent = {
            user: denial.user, channel: denial.channel,
            thread_ts: denial.threadTs, ts: denial.threadTs,
            text: `-resume ${denial.sessionId} ${resumePrompt}`,
          };
          const sayCb = async (msg: any) => this.app.client.chat.postMessage({ channel: denial.channel, ...msg });
          // Store one-time tools temporarily so handleMessage can pick them up
          this.pendingOneTimeTools.set(`${denial.user}-${denial.channel}-${denial.threadTs || 'direct'}`, oneTimeTools);
          await this.handleMessage(event, sayCb);
        }
      } catch (error) {
        this.logger.error('Error handling allow_denied_tool', error);
      }
    });

    // Plan execution
    this.app.action('execute_plan', async ({ ack, body, respond }) => {
      await ack();
      const actionLocale = await this.getUserLocale((body as any).user.id);
      const planId = (body as any).actions[0].value;
      const planInfo = this.pendingPlans.get(planId);
      if (!planInfo) {
        await respond({ response_type: 'ephemeral', text: `⚠️ ${t('plan.expired', actionLocale)}` });
        return;
      }
      this.pendingPlans.delete(planId);

      await respond({ response_type: 'in_channel', text: `🚀 ${t('plan.executing', actionLocale)}` });

      // Execute by resuming the plan session with acceptEdits mode
      const { channel, threadTs, user, sessionId, prompt } = planInfo;
      const event: MessageEvent = { user, channel, thread_ts: threadTs, ts: threadTs, text: `-resume ${sessionId} Execute the plan you created.` };
      const say = async (msg: any) => {
        return this.app.client.chat.postMessage({ channel, ...msg });
      };
      // Execute with the channel's current permission mode (defaults to 'default' with interactive approval)
      await this.handleMessage(event, say);
    });

    this.app.action('cancel_plan', async ({ ack, body, respond }) => {
      await ack();
      const actionLocale = await this.getUserLocale((body as any).user.id);
      const planId = (body as any).actions[0].value;
      this.pendingPlans.delete(planId);
      await respond({ response_type: 'ephemeral', text: t('plan.cancelled', actionLocale) });
    });

    // Session picker "Show more" button
    this.app.action('picker_show_more', async ({ ack, body }) => {
      await ack();
      try {
        const actionValue = JSON.parse((body as any).actions[0].value);
        const picker = this.pendingPickers.get(actionValue.pickerId);
        if (!picker) return;

        // Expand by PICKER_PAGE_SIZE (capped by MAX_PICKER_SESSIONS)
        picker.shownCount = Math.min(picker.shownCount + this.PICKER_PAGE_SIZE, picker.sessions.length, this.MAX_PICKER_SESSIONS);
        const blocks = this.buildPickerBlocks(picker.sessions, actionValue.pickerId, picker.shownCount, picker.locale);

        await this.app.client.chat.update({
          channel: picker.channel,
          ts: picker.messageTs,
          text: `📂 ${t('picker.title', picker.locale)}`,
          blocks,
        }).catch(() => {});
      } catch (error) {
        this.logger.error('Error handling picker show more', error);
      }
    });

    // Session picker buttons
    this.app.action(/^pick_\d+$/, async ({ ack, body }) => {
      await ack();
      try {
        const actionLocale = await this.getUserLocale((body as any).user?.id);
        const actionValue = JSON.parse((body as any).actions[0].value);
        const picker = this.pendingPickers.get(actionValue.pickerId);
        if (!picker) {
          await this.app.client.chat.postEphemeral({
            channel: (body as any).channel?.id,
            user: (body as any).user?.id,
            text: `⚠️ ${t('picker.expiredAction', actionLocale)}`,
          });
          return;
        }

        const session = picker.sessions[actionValue.index];
        if (!session) return;

        clearTimeout(picker.timeout);
        this.pendingPickers.delete(actionValue.pickerId);

        // 1. Auto-switch cwd to the session's project path
        if (session.projectPath && path.isAbsolute(session.projectPath)) {
          this.workingDirManager.setWorkingDirectory(
            picker.channel, session.projectPath, picker.threadTs, picker.user
          );
        }

        // 2. Update picker message to show selection
        const title = session.summary || session.firstPrompt || t('picker.noTitle', actionLocale);
        const cwdNote = path.isAbsolute(session.projectPath) ? `\n_cwd → ${session.projectPath}_` : '';
        await this.app.client.chat.update({
          channel: picker.channel,
          ts: picker.messageTs,
          text: `📂 ${t('picker.resuming', actionLocale, { title })}${cwdNote}`,
          blocks: [],
        }).catch(() => {});

        // Show terminal coexistence tip
        await this.app.client.chat.postMessage({
          channel: picker.channel,
          thread_ts: picker.threadTs,
          text: t('hint.resumeTerminal', actionLocale),
          blocks: [
            { type: 'context', elements: [{ type: 'mrkdwn', text: t('hint.resumeTerminal', actionLocale) }] },
          ],
        }).catch(() => {});

        // 3. Resume session in the same thread
        const event: MessageEvent = {
          user: picker.user,
          channel: picker.channel,
          thread_ts: picker.threadTs,
          ts: picker.threadTs,
          text: `-resume ${session.sessionId}`,
        };
        const sayCb = async (msg: any) => this.app.client.chat.postMessage({ channel: picker.channel, ...msg });
        await this.handleMessage(event, sayCb);
      } catch (error) {
        this.logger.error('Error handling session picker selection', error);
      }
    });


    // Rate limit retry — open modal with editable prompt
    this.app.action('schedule_retry', async ({ ack, body }) => {
      await ack();
      try {
        const actionLocale = await this.getUserLocale((body as any).user.id);
        const actionValue = JSON.parse((body as any).actions[0].value);
        const retryInfo = this.pendingRetries.get(actionValue.retryId);
        if (!retryInfo) {
          await this.app.client.chat.postEphemeral({
            channel: (body as any).channel?.id || '',
            user: (body as any).user.id,
            text: `⚠️ ${t('rateLimit.retryExpired', actionLocale)}`,
          }).catch(() => {});
          return;
        }

        const { postAt, retryTimeStr } = actionValue;

        await this.app.client.views.open({
          trigger_id: (body as any).trigger_id,
          view: {
            type: 'modal',
            callback_id: 'schedule_retry_modal',
            private_metadata: JSON.stringify({ retryId: actionValue.retryId, postAt }),
            title: { type: 'plain_text', text: t('rateLimit.modalTitle', actionLocale) },
            submit: { type: 'plain_text', text: t('rateLimit.modalSubmit', actionLocale, { time: retryTimeStr }) },
            close: { type: 'plain_text', text: t('rateLimit.modalClose', actionLocale) },
            blocks: [
              {
                type: 'section',
                text: { type: 'mrkdwn', text: t('rateLimit.modalBody', actionLocale, { time: retryTimeStr }) },
              },
              {
                type: 'input',
                block_id: 'retry_prompt_block',
                label: { type: 'plain_text', text: t('rateLimit.modalLabel', actionLocale) },
                element: {
                  type: 'plain_text_input',
                  action_id: 'retry_prompt_input',
                  multiline: true,
                  initial_value: retryInfo.prompt,
                },
              },
            ],
          },
        });
      } catch (error) {
        this.logger.error('Failed to open retry modal', error);
      }
    });

    // Modal submission — schedule the message
    this.app.view('schedule_retry_modal', async ({ ack, view }) => {
      await ack();
      try {
        const metadata = JSON.parse(view.private_metadata);
        const retryInfo = this.pendingRetries.get(metadata.retryId);
        if (!retryInfo) return;

        const viewLocale = await this.getUserLocale(retryInfo.user);
        const editedPrompt = view.state.values.retry_prompt_block.retry_prompt_input.value || retryInfo.prompt;
        const postAt = metadata.postAt;

        await this.app.client.chat.scheduleMessage({
          channel: retryInfo.channel,
          text: editedPrompt,
          post_at: postAt,
          thread_ts: retryInfo.threadTs,
        });

        const retryTimeStr = formatTime(new Date(postAt * 1000), viewLocale);

        // Cancel auto-notification (retry will auto-execute instead)
        if (retryInfo.notifyScheduledId) {
          await this.app.client.chat.deleteScheduledMessage({
            channel: retryInfo.channel,
            scheduled_message_id: retryInfo.notifyScheduledId,
          }).catch(() => {});
        }
        this.pendingRetries.delete(metadata.retryId);

        await this.app.client.chat.postMessage({
          channel: retryInfo.channel,
          thread_ts: retryInfo.threadTs,
          text: `✅ ${t('rateLimit.scheduled', viewLocale, { time: retryTimeStr })}`,
        });
      } catch (error) {
        this.logger.error('Failed to schedule retry from modal', error);
      }
    });

    this.app.action('cancel_retry', async ({ ack, body, respond }) => {
      await ack();
      const actionLocale = await this.getUserLocale((body as any).user.id);
      const retryId = (body as any).actions[0].value;
      const retryInfo = this.pendingRetries.get(retryId);
      // Cancel auto-notification
      if (retryInfo?.notifyScheduledId) {
        await this.app.client.chat.deleteScheduledMessage({
          channel: retryInfo.channel,
          scheduled_message_id: retryInfo.notifyScheduledId,
        }).catch(() => {});
      }
      this.pendingRetries.delete(retryId);
      await respond({ response_type: 'ephemeral', text: t('misc.cancelled', actionLocale) });
    });

    // Continue with API key on rate limit
    this.app.action('continue_with_apikey', async ({ ack, body }) => {
      await ack();
      try {
        const userId = (body as any).user.id;
        const actionLocale = await this.getUserLocale(userId);
        const actionValue = JSON.parse((body as any).actions[0].value);
        const { retryId, retryAfter } = actionValue;
        const retryInfo = this.pendingRetries.get(retryId);
        if (!retryInfo) {
          await this.app.client.chat.postEphemeral({
            channel: (body as any).channel?.id || '',
            user: userId,
            text: `⚠️ ${t('rateLimit.retryExpired', actionLocale)}`,
          }).catch(() => {});
          return;
        }

        const apiKey = this.userApiKeys.get(userId);
        if (apiKey) {
          // Cancel auto-notification
          if (retryInfo.notifyScheduledId) {
            await this.app.client.chat.deleteScheduledMessage({
              channel: retryInfo.channel,
              scheduled_message_id: retryInfo.notifyScheduledId,
            }).catch(() => {});
          }

          // Activate API key mode for this channel
          this.activateApiKey(retryInfo.channel, retryInfo.threadTs, userId, retryAfter, actionLocale);

          await this.app.client.chat.postMessage({
            channel: retryInfo.channel,
            thread_ts: retryInfo.threadTs,
            text: `🔑 ${t('apiKey.switchingToApiKey', actionLocale)}`,
          });

          // Retry with API key
          const { channel, threadTs, user, prompt } = retryInfo;
          this.pendingRetries.delete(retryId);
          const event: MessageEvent = { user, channel, thread_ts: threadTs, ts: threadTs, text: prompt };
          const sayCb = async (msg: any) => this.app.client.chat.postMessage({ channel, ...msg });
          await this.handleMessage(event, sayCb);
        } else {
          // No key registered — open modal to enter one
          await this.app.client.views.open({
            trigger_id: (body as any).trigger_id,
            view: {
              type: 'modal',
              callback_id: 'apikey_modal',
              private_metadata: JSON.stringify({ retryId, retryAfter }),
              title: { type: 'plain_text', text: t('apiKey.modalTitle', actionLocale) },
              submit: { type: 'plain_text', text: t('apiKey.modalSubmit', actionLocale) },
              close: { type: 'plain_text', text: t('apiKey.modalClose', actionLocale) },
              blocks: [
                { type: 'section', text: { type: 'mrkdwn', text: t('apiKey.modalBody', actionLocale) } },
                {
                  type: 'input',
                  block_id: 'apikey_block',
                  label: { type: 'plain_text', text: t('apiKey.modalLabel', actionLocale) },
                  element: {
                    type: 'plain_text_input',
                    action_id: 'apikey_input',
                    placeholder: { type: 'plain_text', text: 'sk-ant-...' },
                  },
                },
              ],
            },
          });
        }
      } catch (error) {
        this.logger.error('Error handling continue_with_apikey', error);
      }
    });

    // Open API key modal (from -apikey command button)
    this.app.action('open_apikey_modal', async ({ ack, body }) => {
      await ack();
      try {
        const userId = (body as any).user.id;
        const actionLocale = await this.getUserLocale(userId);
        const existingKey = this.userApiKeys.get(userId);

        await this.app.client.views.open({
          trigger_id: (body as any).trigger_id,
          view: {
            type: 'modal',
            callback_id: 'apikey_modal',
            private_metadata: JSON.stringify({}),
            title: { type: 'plain_text', text: t('apiKey.modalTitle', actionLocale) },
            submit: { type: 'plain_text', text: t('apiKey.modalSubmit', actionLocale) },
            close: { type: 'plain_text', text: t('apiKey.modalClose', actionLocale) },
            blocks: [
              { type: 'section', text: { type: 'mrkdwn', text: t('apiKey.modalBody', actionLocale) } },
              {
                type: 'input',
                block_id: 'apikey_block',
                label: { type: 'plain_text', text: t('apiKey.modalLabel', actionLocale) },
                element: {
                  type: 'plain_text_input',
                  action_id: 'apikey_input',
                  placeholder: { type: 'plain_text', text: existingKey ? `Already set (...${existingKey.slice(-4)})` : 'sk-ant-...' },
                },
              },
            ],
          },
        });
      } catch (error) {
        this.logger.error('Failed to open API key modal', error);
      }
    });

    // API key modal submission
    this.app.view('apikey_modal', async ({ ack, view, body }) => {
      await ack();
      try {
        const userId = body.user.id;
        if (!userId) return;
        const viewLocale = await this.getUserLocale(userId);
        const apiKey = view.state.values.apikey_block.apikey_input.value?.trim();
        if (!apiKey) return;

        // Save key
        this.userApiKeys.set(userId, apiKey);
        this.saveApiKeys();

        const metadata = JSON.parse(view.private_metadata || '{}');

        if (metadata.retryId) {
          // Called from rate limit flow — activate API key and retry
          const retryInfo = this.pendingRetries.get(metadata.retryId);
          if (retryInfo) {
            // Cancel auto-notification
            if (retryInfo.notifyScheduledId) {
              await this.app.client.chat.deleteScheduledMessage({
                channel: retryInfo.channel,
                scheduled_message_id: retryInfo.notifyScheduledId,
              }).catch(() => {});
            }

            this.activateApiKey(retryInfo.channel, retryInfo.threadTs, userId, metadata.retryAfter, viewLocale);

            await this.app.client.chat.postMessage({
              channel: retryInfo.channel,
              thread_ts: retryInfo.threadTs,
              text: `🔑 ${t('apiKey.savedAndRetrying', viewLocale)}`,
            });

            // Retry
            const { channel, threadTs, user, prompt } = retryInfo;
            this.pendingRetries.delete(metadata.retryId);
            const event: MessageEvent = { user, channel, thread_ts: threadTs, ts: threadTs, text: prompt };
            const sayCb = async (msg: any) => this.app.client.chat.postMessage({ channel, ...msg });
            await this.handleMessage(event, sayCb);
          }
        } else {
          // Called from -apikey command — just confirm save
          // Post DM to the user
          try {
            const dm = await this.app.client.conversations.open({ users: userId });
            if (dm.channel?.id) {
              await this.app.client.chat.postMessage({
                channel: dm.channel.id,
                text: `✅ ${t('apiKey.saved', viewLocale)}`,
              });
            }
          } catch {
            // Can't DM, just log
            this.logger.debug('Could not DM user after API key save');
          }
        }
      } catch (error) {
        this.logger.error('Error handling API key modal submission', error);
      }
    });

    // Cleanup inactive sessions periodically
    setInterval(() => {
      this.logger.debug('Running session cleanup');
      this.cliHandler.cleanupInactiveSessions(24 * 60 * 60 * 1000); // 24 hours
    }, 5 * 60 * 1000);
  }
}
