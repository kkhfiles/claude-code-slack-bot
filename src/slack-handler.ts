import { App } from '@slack/bolt';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CliHandler, type CliEvent, type CliProcess, type CliAssistantEvent, type CliInitEvent, type CliResultEvent, type CliRateLimitEvent } from './cli-handler';
import { PendingDenial } from './types';
import { Logger } from './logger';
import { WorkingDirectoryManager } from './working-directory-manager';
import { FileHandler, ProcessedFile } from './file-handler';
import { TodoManager, Todo } from './todo-manager';
import { McpManager } from './mcp-manager';
import { SessionScanner, SessionInfo, formatRelativeTime } from './session-scanner';
import { ScheduleManager } from './schedule-manager';
import { AccountManager, AccountId } from './account-manager';
import { AssistantScheduler, SpawnOpts, SessionResult } from './assistant-scheduler';
import { CalendarPoller } from './calendar-poller';
import { config } from './config';
import { Locale, t, formatTime, formatDateTime, getHelpText as getHelpTextI18n } from './messages';
import { getVersionInfo, checkForUpdates } from './version';
import { isRateLimitText as isRateLimitTextUtil, isRateLimitError as isRateLimitErrorUtil } from './rate-limit-utils';

interface MessageEvent {
  user: string;
  channel: string;
  thread_ts?: string;
  ts: string;
  text?: string;
  accountId?: string; // Override account for token injection (used by scheduled sessions)
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
  private apiKeyActive: Map<string, { userId: string; resetTimerId: ReturnType<typeof setTimeout>; totalCost: number; limit?: number }> = new Map();
  private channelApiKeyLimits: Map<string, number> = new Map();
  private readonly API_KEYS_FILE = path.join(os.homedir(), '.claude', '.bot-api-keys.json');

  // Session schedule
  private scheduleManager = new ScheduleManager();

  // Assistant scheduler
  private assistantScheduler: AssistantScheduler | null = null;

  // Multi-account management
  private accountManager = new AccountManager();
  private pendingAccountSetups: Map<string, { slot: AccountId; originalToken: string | null; locale: Locale }> = new Map();
  private notifiedUnhealthyAccounts = new Set<string>(); // Prevent repeated token expiry notifications

  constructor(app: App, cliHandler: CliHandler, mcpManager: McpManager) {
    this.app = app;
    this.cliHandler = cliHandler;
    this.mcpManager = mcpManager;
    this.workingDirManager = new WorkingDirectoryManager();
    this.fileHandler = new FileHandler();
    this.todoManager = new TodoManager();
    this.loadApiKeys();

    // Initialize assistant scheduler if configured
    if (config.assistant.dmChannel && config.assistant.configDir) {
      this.assistantScheduler = new AssistantScheduler(
        async (text, blocks?) => {
          await this.app.client.chat.postMessage({
            channel: config.assistant.dmChannel,
            text,
            ...(blocks ? { blocks } : {}),
          });
        },
        async (prompt, opts) => this.runAssistantSession(prompt, opts),
        config.assistant.configDir,
      );
    }
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
        await say({ text: `✅ ${t('cwd.set', locale, { context, path: result.resolvedPath! })}`, thread_ts: thread_ts });
      } else {
        await say({ text: `❌ ${result.error}`, thread_ts: thread_ts });
      }
      return;
    }

    if (text && this.workingDirManager.isGetCommand(text)) {
      const isDM = channel.startsWith('D');
      const directory = this.workingDirManager.getWorkingDirectory(channel, thread_ts, isDM ? user : undefined);
      const context = thread_ts ? t('cwd.context.thread', locale) : (isDM ? t('cwd.context.dm', locale) : t('cwd.context.channel', locale));
      await say({ text: this.workingDirManager.formatDirectoryMessage(directory, context, locale), thread_ts: thread_ts });
      return;
    }

    // MCP commands
    if (text && this.isMcpInfoCommand(text)) {
      await say({ text: this.mcpManager.formatMcpInfo(locale), thread_ts: thread_ts });
      return;
    }
    if (text && this.isMcpReloadCommand(text)) {
      const reloaded = this.mcpManager.reloadConfiguration();
      await say({
        text: reloaded
          ? `✅ ${t('cmd.mcp.reloadSuccess', locale)}\n\n${this.mcpManager.formatMcpInfo(locale)}`
          : `❌ ${t('cmd.mcp.reloadFailed', locale)}`,
        thread_ts: thread_ts,
      });
      return;
    }

    // API key command — show button to open modal
    if (text && this.isApiKeyCommand(text)) {
      await say({
        thread_ts: thread_ts,
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

    // Limit command
    if (text) {
      const limitParsed = this.parseLimitCommand(text);
      if (limitParsed) {
        await this.handleLimitCommand(limitParsed, channel, thread_ts, locale, say);
        return;
      }
    }

    // Account command
    if (text && this.isAccountCommand(text)) {
      await this.handleAccountCommand(text, channel, thread_ts, locale, say);
      return;
    }

    // Schedule command
    if (text && this.isScheduleCommand(text)) {
      await this.handleScheduleCommand(channel, thread_ts, user, locale, say);
      return;
    }

    // Briefing command
    if (text && this.isBriefingCommand(text)) {
      if (!this.assistantScheduler) {
        await say({ text: t('assistant.notConfigured', locale), thread_ts: thread_ts || ts });
        return;
      }
      await say({ text: t('assistant.briefingRunning', locale), thread_ts: thread_ts || ts });
      try {
        const result = await this.assistantScheduler.runBriefing();
        await say({ text: result, thread_ts: thread_ts || ts });
      } catch (error) {
        this.logger.error('Manual briefing failed', error);
        await say({ text: '❌ Briefing failed.', thread_ts: thread_ts || ts });
      }
      return;
    }

    // Report command
    if (text && this.isReportCommand(text)) {
      if (!this.assistantScheduler) {
        await say({ text: t('assistant.notConfigured', locale), thread_ts: thread_ts || ts });
        return;
      }
      const { type } = this.parseReportCommand(text);
      await this.handleReportCommand(type, channel, thread_ts || ts, locale, say);
      return;
    }

    // Assistant command
    if (text && this.isAssistantCommand(text)) {
      if (!this.assistantScheduler) {
        await say({ text: t('assistant.notConfigured', locale), thread_ts: thread_ts || ts });
        return;
      }
      const parsed = this.parseAssistantCommand(text);
      if (parsed) {
        await this.handleAssistantSubcommand(parsed, thread_ts || ts, locale, say);
      }
      return;
    }

    // Stop command (interrupt running CLI process)
    if (text && this.isStopCommand(text)) {
      const sessionKey = this.cliHandler.getSessionKey(user, channel, thread_ts || ts);
      const activeProcess = this.activeProcesses.get(sessionKey);
      if (activeProcess) {
        activeProcess.interrupt();
        this.activeProcesses.delete(sessionKey);
        await say({ text: `⏹️ ${t('cmd.stop.stopped', locale)}`, thread_ts: thread_ts });
      } else {
        await say({ text: `ℹ️ ${t('cmd.stop.noActive', locale)}`, thread_ts: thread_ts });
      }
      return;
    }

    // Help command
    if (text && this.isHelpCommand(text)) {
      await say({ text: getHelpTextI18n(locale), thread_ts: thread_ts });
      return;
    }

    // Reset command
    if (text && this.isResetCommand(text)) {
      this.cliHandler.removeSession(user, channel, thread_ts || ts);
      this.lastQueryCosts.delete(channel);
      this.channelAlwaysApproveTools.delete(channel);
      await say({
        text: `🔄 ${t('cmd.reset.done', locale)}`,
        thread_ts: thread_ts,
      });
      return;
    }

    // Model command
    if (text) {
      const modelArg = this.parseModelCommand(text);
      if (modelArg !== null) {
        if (modelArg === '') {
          const current = this.channelModels.get(channel) || t('cmd.model.default', locale);
          await say({ text: `🤖 ${t('cmd.model.current', locale, { model: current })}`, thread_ts: thread_ts });
        } else {
          this.channelModels.set(channel, modelArg);
          await say({ text: `🤖 ${t('cmd.model.set', locale, { model: modelArg })}`, thread_ts: thread_ts });
        }
        return;
      }
    }


    // Permission mode commands: -default / -safe / -trust
    if (text && this.isDefaultModeCommand(text)) {
      this.channelPermissionModes.delete(channel);
      this.channelAlwaysApproveTools.delete(channel);
      await say({ text: `🔒 ${t('cmd.defaultMode', locale)}`, thread_ts: thread_ts });
      return;
    }
    if (text && this.isSafeCommand(text)) {
      this.channelPermissionModes.set(channel, 'safe');
      await say({ text: `🛡️ ${t('cmd.safeMode', locale)}`, thread_ts: thread_ts });
      return;
    }
    if (text && this.isTrustCommand(text)) {
      this.channelPermissionModes.set(channel, 'trust');
      await say({ text: `⚡ ${t('cmd.trustMode', locale)}`, thread_ts: thread_ts });
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
        await say({ text: this.formatSessionsList(sessions, locale), thread_ts: thread_ts });
      } else {
        await say({ text: `⚠️ ${t('cmd.sessions.noCwd', locale)}`, thread_ts: thread_ts });
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
        await say({ text: msg, thread_ts: thread_ts });
      } else {
        await say({ text: `ℹ️ ${t('cmd.cost.noData', locale)}`, thread_ts: thread_ts });
      }
      return;
    }

    // Version command
    if (text && this.isVersionCommand(text)) {
      const info = getVersionInfo();
      let msg = `${t('cmd.version.title', locale)}\n`;
      msg += `• ${t('cmd.version.version', locale, { version: info.version })}\n`;
      if (info.gitHash) {
        msg += `• ${t('cmd.version.commit', locale, { hash: info.gitHash, date: info.gitDate ?? '' })}`;
      } else {
        msg += `• ${t('cmd.version.commitUnknown', locale)}`;
      }
      await say({ text: msg, thread_ts: thread_ts });

      // Async update check — send follow-up message
      checkForUpdates().then(async (result) => {
        let updateMsg: string;
        if (result && result.behindBy === 0) {
          updateMsg = t('cmd.version.upToDate', locale);
        } else if (result && result.behindBy > 0) {
          updateMsg = t('cmd.version.updateAvailable', locale, { count: result.behindBy, hash: result.latestHash });
        } else {
          updateMsg = t('cmd.version.checkFailed', locale);
        }
        try {
          await say({ text: updateMsg, thread_ts: thread_ts });
        } catch (err) {
          this.logger.error('Failed to send update check result', err);
        }
      }).catch(() => {
        // Silently ignore
      });
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
    let apiKeyCostInfo: { queryCost: number; totalCost: number } | null = null;
    let cliError = false;

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

      // Sync tokens from terminal CLI before spawning (terminal→bot)
      if (!queryEnv) {
        this.accountManager.syncFromCredentialsFile();
      }

      // Inject OAuth token (when not in API key mode)
      // Use event.accountId if specified (scheduled sessions), otherwise current account
      if (!queryEnv) {
        const targetAccount = event.accountId || undefined;
        const oauthToken = await this.accountManager.getAccessToken(targetAccount as any);
        if (oauthToken) {
          queryEnv = { CLAUDE_CODE_OAUTH_TOKEN: oauthToken };
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

          // API key cost accumulation
          const apiKeyStateForCost = this.apiKeyActive.get(channel);
          if (apiKeyStateForCost && resultEvent.total_cost_usd !== undefined) {
            apiKeyStateForCost.totalCost += resultEvent.total_cost_usd;
            apiKeyCostInfo = { queryCost: resultEvent.total_cost_usd, totalCost: apiKeyStateForCost.totalCost };
            // Check spending limit
            if (apiKeyStateForCost.limit !== undefined && apiKeyStateForCost.totalCost >= apiKeyStateForCost.limit) {
              clearTimeout(apiKeyStateForCost.resetTimerId);
              this.apiKeyActive.delete(channel);
              await say({
                text: `⚠️ ${t('cmd.limit.exceeded', locale, { limit: apiKeyStateForCost.limit.toFixed(2), cost: apiKeyStateForCost.totalCost.toFixed(4) })}`,
                thread_ts: thread_ts || ts,
              });
            }
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

          // Track error state
          if (resultEvent.is_error) {
            cliError = true;
            // Handle rate limit from result
            if (!rateLimitInfo) {
              const resultText = resultEvent.result || '';
              if (this.isRateLimitText(resultText)) {
                rateLimitMessageText = resultText;
              }
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
      const doneEmoji = cliError ? '❌' : isPlanMode ? '📋' : '✅';
      const doneLabel = cliError ? t('status.errorOccurred', locale) : isPlanMode ? t('status.planReady', locale) : t('status.taskCompleted', locale);
      const toolSummary = toolUsageCounts.size > 0
        ? ' (' + Array.from(toolUsageCounts.entries()).map(([name, count]) => count > 1 ? `${name} ×${count}` : name).join(', ') + ')'
        : '';
      const costSuffix = apiKeyCostInfo
        ? t('apiKey.costSuffix', locale, { queryCost: apiKeyCostInfo.queryCost.toFixed(4), totalCost: apiKeyCostInfo.totalCost.toFixed(4) })
        : '';
      if (statusMessageTs) {
        await this.app.client.chat.update({ channel, ts: statusMessageTs, text: `${doneEmoji} ${doneLabel}${toolSummary}${costSuffix}` }).catch(() => {});
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

        const nextAccount = this.accountManager.getNextAccount();
        await this.handleRateLimitUI(channel, thread_ts || ts, user, finalPrompt, retryAfter, locale, say, nextAccount ?? undefined);
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

        const nextAccountOnError = this.accountManager.getNextAccount();
        await this.handleRateLimitUI(channel, thread_ts || ts, user, finalPrompt, retryAfter, locale, say, nextAccountOnError ?? undefined);
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
    prompt: string, retryAfterSec: number, locale: Locale, say: any,
    nextAccount?: AccountId
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

    const buttons: any[] = [];
    if (nextAccount) {
      buttons.push({
        type: 'button',
        text: { type: 'plain_text', text: t('rateLimit.switchAccount', locale, { account: nextAccount }) },
        action_id: 'switch_account_retry',
        value: JSON.stringify({ retryId, account: nextAccount }),
        style: 'primary',
      });
    }
    buttons.push(
      { type: 'button', text: { type: 'plain_text', text: t('rateLimit.continueWithApiKey', locale) }, action_id: 'continue_with_apikey', value: JSON.stringify({ retryId, retryAfter: retryAfterSec }), style: nextAccount ? undefined : 'primary' },
      { type: 'button', text: { type: 'plain_text', text: t('rateLimit.schedule', locale, { time: retryTimeStr }) }, action_id: 'schedule_retry', value: JSON.stringify({ retryId, postAt, retryTimeStr }) },
      { type: 'button', text: { type: 'plain_text', text: t('rateLimit.cancel', locale) }, action_id: 'cancel_retry', value: retryId },
    );

    await say({
      thread_ts: threadTs,
      text: `⏳ ${t('rateLimit.reached', locale)} ${t('rateLimit.retryEstimate', locale, { time: retryTimeStr, minutes: Math.round(retryAfterSec / 60) })}`,
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: `⏳ ${t('rateLimit.reached', locale)}\n${t('rateLimit.retryEstimate', locale, { time: retryTimeStr, minutes: Math.round(retryAfterSec / 60) })}` } },
        { type: 'context', elements: [{ type: 'mrkdwn', text: t('rateLimit.prompt', locale, { prompt: promptPreview }) }] },
        { type: 'actions', elements: buttons },
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
    return /^-(reset|새로시작)$|^초기화$/i.test(text.trim());
  }

  private isDefaultModeCommand(text: string): boolean {
    return /^-(?:default|d)$|^기본$/i.test(text.trim());
  }

  private isSafeCommand(text: string): boolean {
    return /^-safe$|^안전$/i.test(text.trim());
  }

  private isTrustCommand(text: string): boolean {
    return /^-trust$|^신뢰$/i.test(text.trim());
  }

  private parseModelCommand(text: string): string | null {
    const match = text.trim().match(/^-(?:model|m)(?:\s+(\S+))?$|^모델(?:\s+(\S+))?$/i);
    if (match) return match[1] || match[2] || '';
    return null;
  }

  private isCostCommand(text: string): boolean {
    return /^-cost$|^비용$/i.test(text.trim());
  }

  private isVersionCommand(text: string): boolean {
    return /^`?-(?:version|v)`?$|^버전$/i.test(text.trim());
  }

  private isSessionsCommand(text: string): boolean {
    return /^-(?:sessions?|s)(\s+(list|all|전체))?$|^세션(\s+(all|전체))?$/i.test(text.trim());
  }

  private parsePlanCommand(text: string): { prompt: string } | null {
    const match = text.trim().match(/^-plan\s+(.+)$|^계획\s+(.+)$/is);
    if (match) return { prompt: (match[1] || match[2]).trim() };
    return null;
  }

  private parseResumeCommand(text: string): { mode: 'picker' } | { mode: 'uuid'; resumeOptions: { resumeSessionId: string }; prompt?: string } | { mode: 'continue'; resumeOptions: { continueLastSession: true }; prompt?: string } | null {
    const trimmed = text.trim();

    // -continue / -c [message]
    const continueMatch = trimmed.match(/^-(?:continue|c)(?:\s+(.+))?$/is);
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

  private isScheduleCommand(text: string): boolean {
    return /^`?-(?:schedule|sc)`?(?:\s|$)|^스케줄/i.test(text.trim());
  }

  // --- Assistant commands ---

  private isBriefingCommand(text: string): boolean {
    return /^`?-(?:briefing|br)`?$/i.test(text.trim()) || /^브리핑$/i.test(text.trim());
  }

  private isReportCommand(text: string): boolean {
    return /^`?-(?:report|rp)`?(?:\s|$)/i.test(text.trim());
  }

  private parseReportCommand(text: string): { type?: string } {
    const match = text.trim().match(/^`?-(?:report|rp)`?\s*(.*)$/i);
    return { type: match?.[1]?.trim() || undefined };
  }

  private isAssistantCommand(text: string): boolean {
    return /^`?-(?:assistant|as)`?\s/i.test(text.trim());
  }

  private parseAssistantCommand(text: string): { subcommand: string; args?: string } | null {
    const match = text.trim().match(/^`?-(?:assistant|as)`?\s+(\S+)(?:\s+(.+))?$/i);
    if (!match) return null;
    return { subcommand: match[1].toLowerCase(), args: match[2]?.trim() };
  }

  private async handleScheduleCommand(
    channel: string,
    threadTs: string | undefined,
    userId: string,
    locale: Locale,
    say: any,
  ): Promise<void> {
    const { text, blocks } = this.buildScheduleBlocks(locale, channel, userId);
    await say({ text, blocks, thread_ts: threadTs });
  }

  private async handleReportCommand(type: string | undefined, channel: string, threadTs: string, locale: Locale, say: any): Promise<void> {
    const reportsDir = path.join(config.assistant.configDir, '..', 'reports');
    if (!fs.existsSync(reportsDir)) {
      await say({ text: t('assistant.reportNotFound', locale, { type: type || 'all' }), thread_ts: threadTs });
      return;
    }

    // Scan subdirectories for .md files: reports/<type>/<date>.md
    const files: { relPath: string; absPath: string; type: string; name: string }[] = [];
    for (const dir of fs.readdirSync(reportsDir)) {
      const subdir = path.join(reportsDir, dir);
      if (!fs.statSync(subdir).isDirectory()) continue;
      for (const fname of fs.readdirSync(subdir)) {
        if (!fname.endsWith('.md') || fname === '.gitkeep') continue;
        files.push({
          relPath: `${dir}/${fname}`,
          absPath: path.resolve(path.join(subdir, fname)),
          type: dir,
          name: fname,
        });
      }
    }

    // Filter by type if specified
    const filtered = type ? files.filter(f => f.type.includes(type) || f.name.includes(type)) : files;

    if (filtered.length === 0) {
      const types = [...new Set(files.map(f => f.type))];
      const hint = types.length > 0
        ? `\n${t('assistant.reportAvailableTypes', locale)}: ${types.join(', ')}`
        : '';
      await say({ text: t('assistant.reportNotFound', locale, { type: type || 'all' }) + hint, thread_ts: threadTs });
      return;
    }

    // Get the most recent file (by name, which includes date)
    filtered.sort((a, b) => b.name.localeCompare(a.name));
    const latest = filtered[0];
    const content = fs.readFileSync(latest.absPath, 'utf-8');

    // Upload as .md file to Slack (viewable + downloadable) with summary
    const firstLines = content.split('\n').filter(l => l.trim()).slice(0, 3).join('\n');
    try {
      await this.app.client.filesUploadV2({
        channel_id: channel,
        thread_ts: threadTs,
        filename: latest.relPath.replace('/', '_'),
        content,
        title: `📄 ${latest.relPath}`,
        initial_comment: `\`${latest.absPath}\`\n>${firstLines.split('\n').join('\n>')}`,
      });
    } catch (error) {
      // Fallback to text if upload fails
      this.logger.warn('File upload failed, falling back to text', error);
      const maxLen = 3900;
      const truncated = content.length > maxLen ? content.substring(0, maxLen) + '\n\n…(truncated)' : content;
      await say({ text: `📄 *${latest.relPath}*\n\`${latest.absPath}\`\n\n${truncated}`, thread_ts: threadTs });
    }
  }

  private async handleAssistantSubcommand(
    parsed: { subcommand: string; args?: string },
    threadTs: string,
    locale: Locale,
    say: any,
  ): Promise<void> {
    switch (parsed.subcommand) {
      case 'config': {
        const cfg = this.assistantScheduler?.getConfig();
        if (!cfg) {
          await say({ text: t('assistant.notConfigured', locale), thread_ts: threadTs });
          return;
        }
        await say({
          text: `${t('assistant.configShow', locale)}\n\`\`\`${JSON.stringify(cfg, null, 2)}\`\`\``,
          thread_ts: threadTs,
        });
        break;
      }
      case 'briefing': {
        if (parsed.args && /^\d{1,2}:\d{2}$/.test(parsed.args)) {
          this.assistantScheduler?.updateConfig({ briefingTime: parsed.args });
          await say({ text: t('assistant.configUpdated', locale), thread_ts: threadTs });
        } else {
          await say({ text: 'Usage: `-as briefing HH:MM`', thread_ts: threadTs });
        }
        break;
      }
      case 'reminder': {
        const minutes = parsed.args ? parseInt(parsed.args, 10) : NaN;
        if (!isNaN(minutes) && minutes > 0) {
          this.assistantScheduler?.updateConfig({ reminderMinutes: minutes });
          await say({ text: t('assistant.configUpdated', locale), thread_ts: threadTs });
        } else {
          await say({ text: 'Usage: `-as reminder <minutes>`', thread_ts: threadTs });
        }
        break;
      }
      default:
        await say({ text: 'Unknown subcommand. Use: `config`, `briefing`, `reminder`', thread_ts: threadTs });
    }
  }

  private buildScheduleBlocks(locale: Locale, channel?: string, userId?: string, note?: string): { text: string; blocks: any[] } {
    const entries = this.scheduleManager.getEntries();
    const accounts = this.accountManager.getAccountList();
    const configuredAccounts = accounts.filter(a => a.exists);
    const blocks: any[] = [];

    if (note) {
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: note } });
      blocks.push({ type: 'divider' });
    }

    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `📅 ${t('schedule.status.header', locale)}` } });

    if (entries.length === 0) {
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: t('schedule.noConfig', locale) } });
    } else {
      const nextFires = this.scheduleManager.getNextFireTimes();
      for (const entry of entries) {
        const email = accounts.find(a => a.id === entry.account)?.email;
        const label = email ? `${entry.account} (${email})` : entry.account;
        const nf = nextFires.find(f => f.time === entry.time && f.account === entry.account);
        const minsUntil = nf ? Math.round((nf.nextFire.getTime() - Date.now()) / 60000) : 0;
        const timeInfo = nf ? ` _(${minsUntil}m)_` : '';
        blocks.push({
          type: 'section',
          text: { type: 'mrkdwn', text: `• \`${entry.time}\` → ${label}${timeInfo}` },
          accessory: {
            type: 'button',
            text: { type: 'plain_text', text: '✕' },
            action_id: `schedule_remove_btn_${entry.time.replace(':', '')}_${entry.account}`,
            value: JSON.stringify({ time: entry.time, account: entry.account }),
            style: 'danger',
          },
        });
      }
    }

    // Rotation status (only when 2 accounts in schedule and rotation enabled)
    const uniqueAccountsInEntries = [...new Set(entries.map(e => e.account))];
    const showRotation = uniqueAccountsInEntries.length === 2;

    if (showRotation && this.scheduleManager.isRotationEnabled()) {
      const isSwapped = this.scheduleManager.isSwapDay();
      const status = isSwapped ? t('schedule.rotation.swapped', locale) : t('schedule.rotation.normal', locale);
      blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: t('schedule.rotation.status', locale, { status }) }],
      });
      // Show today's effective pattern
      const effectiveEntries = this.scheduleManager.getEffectiveEntries();
      const pattern = effectiveEntries.map(e => {
        const email = accounts.find(a => a.id === e.account)?.email || e.account;
        return `\`${e.time}\` ${email}`;
      }).join(', ');
      blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: t('schedule.rotation.effective', locale, { pattern }) }],
      });
    }

    // Add buttons: one per configured account
    if (configuredAccounts.length > 0) {
      blocks.push({ type: 'divider' });
      const addButtons = configuredAccounts.map(acc => {
        const label = acc.email ? `+ ${acc.email}` : `+ ${acc.id}`;
        return {
          type: 'button',
          text: { type: 'plain_text', text: label },
          action_id: `schedule_add_btn_${acc.id}`,
          value: JSON.stringify({ account: acc.id, channel, userId }),
        };
      });
      // Rotation toggle button (only when 2 accounts in entries)
      if (showRotation) {
        const rotLabel = this.scheduleManager.isRotationEnabled()
          ? t('schedule.rotation.disableBtn', locale)
          : t('schedule.rotation.enableBtn', locale);
        addButtons.push({
          type: 'button',
          text: { type: 'plain_text', text: rotLabel },
          action_id: 'schedule_rotation_btn',
          value: this.scheduleManager.isRotationEnabled() ? 'disable' : 'enable',
        } as any);
      }
      // Clear all button (only when entries exist)
      if (entries.length > 0) {
        addButtons.push({
          type: 'button',
          text: { type: 'plain_text', text: t('schedule.clearBtn', locale) },
          action_id: 'schedule_clear_btn',
          value: 'clear',
        } as any);
      }
      blocks.push({ type: 'actions', elements: addButtons });
    } else {
      blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: t('schedule.noAccounts', locale) }] });
    }

    return { text: `📅 ${t('schedule.status.header', locale)}`, blocks };
  }

  private restartScheduler(): void {
    this.scheduleManager.scheduleAll((ch, uid, time, account) => {
      this.runScheduledGreeting(ch, uid, time, account).catch(err =>
        this.logger.error('Scheduled greeting failed', err),
      );
    });
  }

  private async runScheduledGreeting(channel: string, userId: string, time: string, account: string): Promise<void> {
    const locale = await this.getUserLocale(userId).catch(() => 'ko' as Locale);

    // Post session start notification as top-level message
    const accountEmail = this.accountManager.getAccountList().find(a => a.id === account)?.email;
    const accountLabel = accountEmail ? `${account} (${accountEmail})` : account;
    const postResult = await this.app.client.chat.postMessage({
      channel,
      text: `🌅 ${t('schedule.sessionStart', locale)} (${time}) — ${accountLabel}`,
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

    // Build synthetic event with randomized greeting
    const greeting = ScheduleManager.getRandomGreeting();
    this.logger.debug('Scheduled greeting message', { time, greeting });
    const event: MessageEvent = { user: userId, channel, ts, text: greeting, accountId: account };

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

  /**
   * Run a Claude session and return the result text (one-shot, no streaming to Slack).
   * Used by AssistantScheduler for briefing, reminders, and analysis.
   * Reuses OAuth injection (line 500-506) + for-await loop (line 525) + extractTextFromContent (line 987).
   */
  private async runAssistantSession(prompt: string, opts: SpawnOpts): Promise<SessionResult> {
    // OAuth token injection — handleMessage pattern (line 494-506)
    this.accountManager.syncFromCredentialsFile();
    const oauthToken = await this.accountManager.getAccessToken();
    const env: Record<string, string> = { ...(opts.env || {}) };
    if (oauthToken) env.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;

    const cliProcess = this.cliHandler.runQuery(prompt, {
      workingDirectory: opts.workingDirectory,
      model: opts.model,
      permissionMode: opts.permissionMode,
      allowedTools: opts.allowedTools,
      appendSystemPrompt: opts.appendSystemPrompt,
      systemPrompt: opts.systemPrompt,
      maxBudgetUsd: opts.maxBudgetUsd,
      resumeSessionId: opts.resumeSessionId,
      skipMcp: opts.skipMcp,
      noSessionPersistence: opts.noSessionPersistence,
      tools: opts.tools,
      env,
    });

    // Collect text, sessionId, cost, and subtype from CLI events
    let text = '';
    let sessionId = '';
    let costUsd = 0;
    let subtype = 'success';

    for await (const event of cliProcess) {
      if (event.type === 'system' && (event as any).subtype === 'init') {
        sessionId = (event as CliInitEvent).session_id;
      }
      if (event.type === 'assistant') {
        const assistantEvent = event as CliAssistantEvent;
        const content = assistantEvent.message.content || [];
        const extracted = this.extractTextFromContent(content);
        if (extracted) text = extracted;  // Keep only last assistant turn (drop intermediate explanations)
      }
      if (event.type === 'result') {
        const resultEvent = event as CliResultEvent;
        costUsd = resultEvent.total_cost_usd || 0;
        subtype = resultEvent.subtype || 'success';
      }
    }

    return { text, costUsd, sessionId, subtype };
  }

  /**
   * Cancel all pending scheduled messages created by this bot.
   * Prevents orphaned rate limit notifications from firing after pm2 restart.
   */
  private async cancelOrphanedScheduledMessages(): Promise<void> {
    const result = await this.app.client.chat.scheduledMessages.list({});
    const messages = (result as any).scheduled_messages;
    if (!messages || messages.length === 0) return;
    this.logger.info(`Found ${messages.length} orphaned scheduled message(s), cancelling`);
    for (const msg of messages) {
      try {
        await this.app.client.chat.deleteScheduledMessage({
          channel: msg.channel_id,
          scheduled_message_id: msg.id,
        });
        this.logger.debug('Cancelled orphaned scheduled message', { id: msg.id, channel: msg.channel_id });
      } catch (err) {
        this.logger.warn('Failed to cancel scheduled message', { id: msg.id, error: err });
      }
    }
  }

  private isRateLimitError(error: any): boolean {
    return isRateLimitErrorUtil(error);
  }

  private isRateLimitText(text: string): boolean {
    return isRateLimitTextUtil(text);
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
    return /^`?-(?:apikey|key)`?$|^키$/i.test(text.trim());
  }

  private parseLimitCommand(text: string): { action: 'status' } | { action: 'set'; amount: number } | { action: 'clear' } | null {
    const trimmed = text.trim();
    if (/^`?-limit`?$|^한도$/i.test(trimmed)) return { action: 'status' };
    if (/^`?-limit`?\s+(clear|off|reset)`?$|^한도\s+(?:clear|초기화)$/i.test(trimmed)) return { action: 'clear' };
    const setMatch = trimmed.match(/^`?-limit`?\s+([\d.]+)`?$|^한도\s+([\d.]+)$/i);
    if (setMatch) {
      const amount = parseFloat(setMatch[1] || setMatch[2]);
      if (!isNaN(amount) && amount > 0) return { action: 'set', amount };
    }
    return null;
  }

  private async handleLimitCommand(
    parsed: { action: 'status' } | { action: 'set'; amount: number } | { action: 'clear' },
    channel: string,
    threadTs: string | undefined,
    locale: Locale,
    say: any,
  ): Promise<void> {
    if (parsed.action === 'set') {
      this.channelApiKeyLimits.set(channel, parsed.amount);
      // Update active session limit if running
      const active = this.apiKeyActive.get(channel);
      if (active) active.limit = parsed.amount;
      await say({ text: `✅ ${t('cmd.limit.set', locale, { amount: parsed.amount.toFixed(2) })}`, thread_ts: threadTs });
      return;
    }

    if (parsed.action === 'clear') {
      this.channelApiKeyLimits.delete(channel);
      const active = this.apiKeyActive.get(channel);
      if (active) active.limit = undefined;
      await say({ text: `✅ ${t('cmd.limit.cleared', locale)}`, thread_ts: threadTs });
      return;
    }

    // Status
    const active = this.apiKeyActive.get(channel);
    const configuredLimit = this.channelApiKeyLimits.get(channel);
    if (active) {
      const limitStr = active.limit !== undefined ? `$${active.limit.toFixed(2)}` : (locale === 'ko' ? '없음' : 'none');
      let msg = `💰 *${locale === 'ko' ? 'API 키 모드 활성 중' : 'API key mode active'}*\n`;
      msg += `• ${locale === 'ko' ? '이번 세션 사용' : 'Spent'}: $${active.totalCost.toFixed(4)}\n`;
      msg += `• ${locale === 'ko' ? '한도' : 'Limit'}: ${limitStr}\n`;
      msg += locale === 'ko'
        ? '_`-limit <금액>`으로 변경, `-limit clear`로 초기화_'
        : '_Use `-limit <amount>` to change, `-limit clear` to remove_';
      await say({ text: msg, thread_ts: threadTs });
    } else if (configuredLimit !== undefined) {
      let msg = `ℹ️ ${locale === 'ko' ? 'API 키 모드 비활성.' : 'API key mode not active.'}\n`;
      msg += `• ${locale === 'ko' ? '설정된 한도' : 'Configured limit'}: $${configuredLimit.toFixed(2)}\n`;
      msg += locale === 'ko'
        ? '_Rate limit 시 API 키 모드 전환 시 자동 적용됩니다._'
        : '_Will apply automatically when API key mode is activated._';
      await say({ text: msg, thread_ts: threadTs });
    } else {
      await say({ text: `ℹ️ ${t('cmd.limit.none', locale)}`, thread_ts: threadTs });
    }
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

    this.apiKeyActive.set(channel, {
      userId,
      resetTimerId,
      totalCost: 0,
      limit: this.channelApiKeyLimits.get(channel),
    });
  }

  // --- Account management commands ---

  private isAccountCommand(text: string): boolean {
    return /^`?-(?:account|ac)(`?\s*.*)?$|^계정(\s.*)?$/i.test(text.trim());
  }

  private async handleAccountCommand(text: string, _channel: string, threadTs: string | undefined, locale: Locale, say: any): Promise<void> {
    const trimmed = text.trim().replace(/^`|`$/g, '');
    const argMatch = trimmed.match(/^-(?:account|ac)\s+(.+)$/i) || trimmed.match(/^계정\s+(.+)$/);
    const raw = argMatch ? argMatch[1].trim().toLowerCase() : '';

    // -account <id> — direct switch (always run switchTo to re-sync .credentials.json)
    const targetId = raw ? this.parseAccountId(raw) : null;
    if (targetId) {
      const ok = await this.accountManager.switchTo(targetId);
      if (!ok) {
        const { text: statusText, blocks } = this.buildAccountStatusBlocks(locale);
        await say({ text: statusText, blocks, thread_ts: threadTs });
        return;
      }
      const note = t('account.switchedTerminalGuide', locale, { account: targetId });
      const { text: statusText, blocks } = this.buildAccountStatusBlocks(locale, note);
      await say({ text: statusText, blocks, thread_ts: threadTs });
      return;
    }

    // No args (or unrecognized) — show unified status + buttons
    const { text: statusText, blocks } = this.buildAccountStatusBlocks(locale);
    await say({ text: statusText, blocks, thread_ts: threadTs });
  }

  private parseAccountId(raw: string): AccountId | null {
    if (raw === '1' || raw === 'account-1') return 'account-1';
    if (raw === '2' || raw === 'account-2') return 'account-2';
    if (raw === '3' || raw === 'account-3') return 'account-3';
    return null;
  }

  private buildAccountStatusBlocks(locale: Locale, note?: string): { text: string; blocks: any[] } {
    const current = this.accountManager.getCurrentAccount();
    const accounts = this.accountManager.getAccountList();
    const blocks: any[] = [];

    if (note) {
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: note } });
      blocks.push({ type: 'divider' });
    }

    const currentEmail = accounts.find(a => a.id === current)?.email;
    const currentLabel = currentEmail ? `${current} (${currentEmail})` : current;
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: t('account.current', locale, { account: currentLabel }) } });

    for (const acc of accounts) {
      const emailSuffix = acc.email ? ` — ${acc.email}` : '';
      if (acc.exists) {
        // Configured account: Use / Set / Unset (Use re-syncs .credentials.json even if already active)
        const statusText = acc.id === current
          ? t('account.entryActive', locale, { id: acc.id }) + emailSuffix
          : t('account.entryAvailable', locale, { id: acc.id }) + emailSuffix;
        blocks.push({ type: 'section', text: { type: 'mrkdwn', text: statusText } });
        blocks.push({
          type: 'actions',
          elements: [
            { type: 'button', text: { type: 'plain_text', text: t('account.useBtn', locale) }, action_id: 'account_use_btn', value: acc.id, style: 'primary' },
            { type: 'button', text: { type: 'plain_text', text: t('account.setBtn', locale) }, action_id: 'account_set_btn', value: acc.id },
            { type: 'button', text: { type: 'plain_text', text: t('account.unsetBtn', locale) }, action_id: 'account_unset_btn', value: acc.id, style: 'danger' },
          ],
        });
      } else {
        // Not configured: Set only
        blocks.push({
          type: 'section',
          text: { type: 'mrkdwn', text: t('account.entryMissing', locale, { id: acc.id }) },
          accessory: {
            type: 'button',
            text: { type: 'plain_text', text: t('account.setBtn', locale) },
            action_id: 'account_set_btn',
            value: acc.id,
          },
        });
      }
    }

    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: t('account.hint', locale) }] });

    return { text: t('account.current', locale, { account: current }), blocks };
  }

  private buildCaptureNewBlocks(setupId: string, slot: AccountId, locale: Locale): { text: string; blocks: any[] } {
    const text = t('account.setup.captureNew.title', locale, { slot });
    return {
      text,
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text } },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: t('account.setup.captureNew.doneBtn', locale) },
              action_id: 'account_setup_next',
              value: setupId,
              style: 'primary',
            },
            {
              type: 'button',
              text: { type: 'plain_text', text: t('account.setup.cancelBtn', locale) },
              action_id: 'account_setup_cancel',
              value: setupId,
            },
          ],
        },
      ],
    };
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

    // Cancel any orphaned scheduled notifications from previous runs
    this.cancelOrphanedScheduledMessages().catch(err =>
      this.logger.warn('Failed to cancel orphaned scheduled messages', err),
    );

    // Start session scheduler
    this.restartScheduler();

    // Start assistant scheduler (briefing, reminders, analysis)
    this.assistantScheduler?.start();

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

    // Account status view: "Switch" button
    this.app.action('account_switch_btn', async ({ ack, body, respond }) => {
      await ack();
      const actionLocale = await this.getUserLocale((body as any).user.id);
      const accountId = (body as any).actions[0].value as AccountId;
      const ok = await this.accountManager.switchTo(accountId);
      const note = ok
        ? t('account.switchedTerminalGuide', actionLocale, { account: accountId })
        : t('account.notFound', actionLocale, { account: accountId });
      const { text, blocks } = this.buildAccountStatusBlocks(actionLocale, note);
      await respond({ replace_original: true, text, blocks });
    });

    // Account status view: "Use" button → switch account
    this.app.action('account_use_btn', async ({ ack, body, respond }) => {
      await ack();
      const actionLocale = await this.getUserLocale((body as any).user.id);
      const accountId = (body as any).actions[0].value as AccountId;
      const ok = await this.accountManager.switchTo(accountId);
      const note = ok
        ? t('account.switchedTerminalGuide', actionLocale, { account: accountId })
        : t('account.notFound', actionLocale, { account: accountId });
      const { text, blocks } = this.buildAccountStatusBlocks(actionLocale, note);
      await respond({ replace_original: true, text, blocks });
    });

    // Account status view: "Set" button → guide user to login with target account
    this.app.action('account_set_btn', async ({ ack, body, respond }) => {
      await ack();
      const actionLocale = await this.getUserLocale((body as any).user.id);
      const slot = (body as any).actions[0].value as AccountId;

      const originalToken = this.accountManager.readCurrentToken();
      const setupId = `setup-${Date.now()}`;
      this.pendingAccountSetups.set(setupId, { slot, originalToken, locale: actionLocale });
      setTimeout(() => {
        const s = this.pendingAccountSetups.get(setupId);
        if (s) { this.pendingAccountSetups.delete(setupId); }
      }, 30 * 60 * 1000);

      const { text, blocks } = this.buildCaptureNewBlocks(setupId, slot, actionLocale);
      await respond({ replace_original: true, text, blocks });
    });

    // Account status view: "Unset" button → remove credentials backup
    this.app.action('account_unset_btn', async ({ ack, body, respond }) => {
      await ack();
      const actionLocale = await this.getUserLocale((body as any).user.id);
      const accountId = (body as any).actions[0].value as AccountId;
      this.accountManager.unsetAccount(accountId);
      const { text, blocks } = this.buildAccountStatusBlocks(actionLocale, t('account.unset.done', actionLocale, { id: accountId }));
      await respond({ replace_original: true, text, blocks });
    });

    // Account setup: "Done" button — capture token for the target slot
    this.app.action('account_setup_next', async ({ ack, body, respond }) => {
      await ack();
      const actionLocale = await this.getUserLocale((body as any).user.id);
      try {
        const setupId = (body as any).actions[0].value as string;
        const setup = this.pendingAccountSetups.get(setupId);
        if (!setup) {
          await respond({ response_type: 'ephemeral', text: t('account.setup.expired', actionLocale) });
          return;
        }

        const currentToken = this.accountManager.readCurrentToken();
        if (currentToken === setup.originalToken) {
          await respond({ response_type: 'ephemeral', text: t('account.setup.captureNew.notChanged', actionLocale) });
          return;
        }

        await this.accountManager.captureForSlot(setup.slot);
        this.pendingAccountSetups.delete(setupId);
        const doneBlocks = this.buildAccountStatusBlocks(actionLocale, t('account.setup.done', actionLocale, { slot: setup.slot }));
        await respond({ replace_original: true, ...doneBlocks });
      } catch (error) {
        this.logger.error('Error in account_setup_next', error);
        await respond({ response_type: 'ephemeral', text: '❌ An error occurred. Please try again.' });
      }
    });

    // Account setup: "Cancel" button
    this.app.action('account_setup_cancel', async ({ ack, body, respond }) => {
      await ack();
      const actionLocale = await this.getUserLocale((body as any).user.id);
      const setupId = (body as any).actions[0].value;
      const setup = this.pendingAccountSetups.get(setupId);
      if (setup) {
        this.pendingAccountSetups.delete(setupId);
        // No cleanup needed — watcher removed
      }
      // Return to status view with cancel note
      const { text, blocks } = this.buildAccountStatusBlocks(actionLocale, t('account.setup.cancelled', actionLocale));
      await respond({ replace_original: true, text, blocks });
    });

    // Schedule: "Add" button → open modal for time input
    this.app.action(/^schedule_add_btn_/, async ({ ack, body }) => {
      await ack();
      try {
        const actionLocale = await this.getUserLocale((body as any).user.id);
        const value = JSON.parse((body as any).actions[0].value);
        const { account, channel: ch, userId: uid } = value;
        const messageTs = (body as any).message?.ts;
        const accInfo = this.accountManager.getAccountList().find(a => a.id === account);
        const label = accInfo?.email ? `${account} (${accInfo.email})` : account;

        await this.app.client.views.open({
          trigger_id: (body as any).trigger_id,
          view: {
            type: 'modal',
            callback_id: 'schedule_add_modal',
            private_metadata: JSON.stringify({ account, channel: ch, userId: uid, messageTs }),
            title: { type: 'plain_text', text: t('schedule.modal.title', actionLocale) },
            submit: { type: 'plain_text', text: t('schedule.modal.submit', actionLocale) },
            close: { type: 'plain_text', text: t('schedule.modal.close', actionLocale) },
            blocks: [
              { type: 'section', text: { type: 'mrkdwn', text: t('schedule.modal.body', actionLocale, { account: label }) } },
              {
                type: 'input',
                block_id: 'schedule_time_block',
                label: { type: 'plain_text', text: t('schedule.modal.label', actionLocale) },
                element: {
                  type: 'plain_text_input',
                  action_id: 'schedule_time_input',
                  placeholder: { type: 'plain_text', text: '5, 11, 16:30' },
                },
              },
            ],
          },
        });
      } catch (error) {
        this.logger.error('Failed to open schedule add modal', error);
      }
    });

    // Schedule: modal submission → add time
    this.app.view('schedule_add_modal', async ({ ack, view, body }) => {
      const metadata = JSON.parse(view.private_metadata);
      const timeInput = view.state.values.schedule_time_block.schedule_time_input.value || '';
      const viewLocale = await this.getUserLocale(body.user.id);

      // Validate
      const normalized = this.scheduleManager.normalizeTime(timeInput);
      if (!normalized) {
        await ack({ response_action: 'errors', errors: { schedule_time_block: t('schedule.invalidTime', viewLocale) } });
        return;
      }
      const conflict = this.scheduleManager.findConflictingTime(normalized, metadata.account);
      if (conflict) {
        const existingHour = conflict.split(':')[0];
        await ack({ response_action: 'errors', errors: { schedule_time_block: t('schedule.conflictWithExisting', viewLocale, { time: normalized, existing: conflict, existingHour }) } });
        return;
      }

      await ack();
      this.scheduleManager.addTime(normalized, metadata.channel, metadata.userId, metadata.account);
      this.restartScheduler();

      // Update original schedule message in-place
      try {
        const { text, blocks } = this.buildScheduleBlocks(viewLocale, metadata.channel, metadata.userId);
        if (metadata.messageTs) {
          await this.app.client.chat.update({
            channel: metadata.channel,
            ts: metadata.messageTs,
            text,
            blocks,
          });
        } else {
          await this.app.client.chat.postMessage({
            channel: metadata.channel,
            text,
            blocks,
          });
        }
      } catch (err) {
        this.logger.error('Failed to update schedule view after add', err);
      }
    });

    // Schedule: "Remove" button
    this.app.action(/^schedule_remove_btn_/, async ({ ack, body, respond }) => {
      await ack();
      const actionLocale = await this.getUserLocale((body as any).user.id);
      const ch = (body as any).channel?.id;
      const uid = (body as any).user.id;
      const { time, account } = JSON.parse((body as any).actions[0].value);
      this.scheduleManager.removeTime(time, account);
      this.restartScheduler();
      const { text, blocks } = this.buildScheduleBlocks(actionLocale, ch, uid);
      await respond({ replace_original: true, text, blocks });
    });

    // Schedule: "Clear all" button
    this.app.action('schedule_clear_btn', async ({ ack, body, respond }) => {
      await ack();
      const actionLocale = await this.getUserLocale((body as any).user.id);
      const ch = (body as any).channel?.id;
      const uid = (body as any).user.id;
      this.scheduleManager.clearTimes();
      const { text, blocks } = this.buildScheduleBlocks(actionLocale, ch, uid);
      await respond({ replace_original: true, text, blocks });
    });

    // Schedule: "Rotation" toggle button
    this.app.action('schedule_rotation_btn', async ({ ack, body, respond }) => {
      await ack();
      const actionLocale = await this.getUserLocale((body as any).user.id);
      const ch = (body as any).channel?.id;
      const uid = (body as any).user.id;
      const value = (body as any).actions[0].value;
      this.scheduleManager.setRotation(value === 'enable');
      const { text, blocks } = this.buildScheduleBlocks(actionLocale, ch, uid);
      await respond({ replace_original: true, text, blocks });
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

    // Switch account on rate limit
    this.app.action('switch_account_retry', async ({ ack, body, respond }) => {
      await ack();
      try {
        const userId = (body as any).user.id;
        const actionLocale = await this.getUserLocale(userId);
        const { retryId, account } = JSON.parse((body as any).actions[0].value) as { retryId: string; account: AccountId };
        const retryInfo = this.pendingRetries.get(retryId);
        if (!retryInfo) {
          await respond({ response_type: 'ephemeral', text: `⚠️ ${t('rateLimit.retryExpired', actionLocale)}` });
          return;
        }

        // Cancel auto-notification
        if (retryInfo.notifyScheduledId) {
          await this.app.client.chat.deleteScheduledMessage({
            channel: retryInfo.channel,
            scheduled_message_id: retryInfo.notifyScheduledId,
          }).catch(() => {});
        }

        const ok = await this.accountManager.switchTo(account);
        if (!ok) {
          await respond({ response_type: 'ephemeral', text: t('account.notFound', actionLocale, { account }) });
          return;
        }

        // Replace rate limit message (remove buttons) + show switch confirmation
        await respond({
          replace_original: true,
          text: t('account.switchedTerminalGuide', actionLocale, { account }),
        });

        // Retry original query with new account
        const { channel, threadTs, user: retryUser, prompt } = retryInfo;
        this.pendingRetries.delete(retryId);
        const event: MessageEvent = { user: retryUser, channel, thread_ts: threadTs, ts: threadTs, text: prompt };
        const sayCb = async (msg: any) => this.app.client.chat.postMessage({ channel, ...msg });
        await this.handleMessage(event, sayCb);
      } catch (error) {
        this.logger.error('Error handling switch_account_retry', error);
      }
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
              private_metadata: JSON.stringify({ retryId, retryAfter, channel: retryInfo.channel }),
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
                {
                  type: 'input',
                  block_id: 'limit_block',
                  optional: true,
                  label: { type: 'plain_text', text: t('apiKey.limitLabel', actionLocale) },
                  element: {
                    type: 'plain_text_input',
                    action_id: 'limit_input',
                    placeholder: { type: 'plain_text', text: t('apiKey.limitPlaceholder', actionLocale) },
                    initial_value: this.channelApiKeyLimits.has(retryInfo.channel) ? String(this.channelApiKeyLimits.get(retryInfo.channel)) : undefined,
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
        const modalChannel = (body as any).channel?.id || (body as any).container?.channel_id || '';

        await this.app.client.views.open({
          trigger_id: (body as any).trigger_id,
          view: {
            type: 'modal',
            callback_id: 'apikey_modal',
            private_metadata: JSON.stringify({ channel: modalChannel }),
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
              {
                type: 'input',
                block_id: 'limit_block',
                optional: true,
                label: { type: 'plain_text', text: t('apiKey.limitLabel', actionLocale) },
                element: {
                  type: 'plain_text_input',
                  action_id: 'limit_input',
                  placeholder: { type: 'plain_text', text: t('apiKey.limitPlaceholder', actionLocale) },
                  initial_value: modalChannel && this.channelApiKeyLimits.has(modalChannel) ? String(this.channelApiKeyLimits.get(modalChannel)) : undefined,
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

        // Save spending limit if provided
        const limitValue = view.state.values.limit_block?.limit_input?.value?.trim();
        const metaChannel = metadata.channel as string | undefined;
        if (metaChannel) {
          if (limitValue) {
            const limitAmount = parseFloat(limitValue);
            if (!isNaN(limitAmount) && limitAmount > 0) {
              this.channelApiKeyLimits.set(metaChannel, limitAmount);
              const active = this.apiKeyActive.get(metaChannel);
              if (active) active.limit = limitAmount;
            }
          } else {
            // Blank = clear limit
            this.channelApiKeyLimits.delete(metaChannel);
            const active = this.apiKeyActive.get(metaChannel);
            if (active) active.limit = undefined;
          }
        }

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

    // Calendar notification mute button
    this.app.action('calendar_mute_event', async ({ ack, body, respond }) => {
      await ack();
      const baseEventId = (body as any).actions?.[0]?.value;
      if (!baseEventId || !this.assistantScheduler) return;

      const poller = this.assistantScheduler.getCalendarPoller();
      if (!poller) return;

      // Find event title from cache for display
      const cache = poller.getCache();
      const event = cache?.events.find(e => CalendarPoller.getBaseEventId(e.id) === baseEventId);
      const title = event?.title || baseEventId;

      poller.muteEvent(baseEventId, title);

      try {
        await respond({
          replace_original: true,
          text: `🔇 *${title}* — 이 일정의 알림을 껐습니다.`,
        });
      } catch (error) {
        this.logger.error('Failed to respond to mute action', error);
      }
    });

    // Cleanup inactive sessions periodically
    setInterval(() => {
      this.logger.debug('Running session cleanup');
      this.cliHandler.cleanupInactiveSessions(24 * 60 * 60 * 1000); // 24 hours
    }, 5 * 60 * 1000);

    // Periodic token health check (every 1 hour)
    setInterval(() => {
      this.checkTokenHealth().catch(err =>
        this.logger.error('Token health check failed', err),
      );
    }, 60 * 60 * 1000);
    // Run once at startup (after 30 seconds to let Slack connect)
    setTimeout(() => {
      this.checkTokenHealth().catch(err =>
        this.logger.error('Initial token health check failed', err),
      );
    }, 30 * 1000);
  }

  private async checkTokenHealth(): Promise<void> {
    const unhealthy = await this.accountManager.checkTokenHealth();

    // Clear notification state for accounts that recovered (e.g., user re-logged in)
    for (const id of this.notifiedUnhealthyAccounts) {
      if (!unhealthy.find(a => a.id === id)) {
        this.notifiedUnhealthyAccounts.delete(id);
      }
    }

    // Filter out already-notified accounts
    const newUnhealthy = unhealthy.filter(a => !this.notifiedUnhealthyAccounts.has(a.id));
    if (newUnhealthy.length === 0) return;

    // Find a channel/user to send the notification to
    const scheduleConfig = this.scheduleManager.getConfig();
    if (!scheduleConfig) return; // No schedule = no one to notify

    const locale = await this.getUserLocale(scheduleConfig.userId).catch(() => 'ko' as Locale);
    const accountLabels = newUnhealthy.map(a => `\`${a.id}\` (${a.email || '?'})`).join(', ');
    const message = t('account.tokenExpired', locale, { accounts: accountLabels });

    await this.app.client.chat.postMessage({
      channel: scheduleConfig.channel,
      text: message,
    });

    for (const a of newUnhealthy) {
      this.notifiedUnhealthyAccounts.add(a.id);
    }
    this.logger.info('Sent token expiry notification', { accounts: newUnhealthy.map(a => a.id) });
  }
}
