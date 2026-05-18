import {
  query,
  type Query,
  type SDKMessage,
  type CanUseTool,
  type PermissionMode as SdkPermissionMode,
} from '@anthropic-ai/claude-agent-sdk';
import { Logger } from './logger';
import { McpManager } from './mcp-manager';
import { errorCollector } from './error-collector';
import type {
  CliEvent,
  CliInitEvent,
  CliAssistantEvent,
  CliUserEvent,
  CliRateLimitEvent,
  CliResultEvent,
} from './cli-handler';
import type { ConversationSession } from './types';

// --- Feature flag --------------------------------------------------------

/**
 * SLACKBOT_SDK_ENABLED token format: `<tok1>[,+]<tok2>...`
 *
 * Tokens map to scopes the caller passes (e.g. `analysis:kg-skill-update`,
 * `briefing`, `calendar`). A category token (`analysis`) matches any scope
 * starting with that category. `all` matches everything.
 *
 * SLACKBOT_FORCE_CLI=1 hard-disables every SDK path (emergency rollback).
 */
export function shouldUseSdk(scope: string): boolean {
  if (process.env.SLACKBOT_FORCE_CLI === '1') return false;
  const flag = (process.env.SLACKBOT_SDK_ENABLED || '').trim();
  if (!flag) return false;
  if (flag === 'all' || flag === '1' || flag === 'true') return true;
  const tokens = flag.split(/[,+]/).map(s => s.trim()).filter(Boolean);
  if (tokens.includes(scope)) return true;
  const colonIdx = scope.indexOf(':');
  if (colonIdx > 0) {
    const category = scope.substring(0, colonIdx);
    if (tokens.includes(category)) return true;
  }
  return false;
}

// --- SDK message → CliEvent translation -----------------------------------

/**
 * SDK 0.3.143 message stream → CliEvent shape (Phase 1.5 §6 interpretSdkEvents).
 *
 * SDKMessage `type` values mostly mirror stream-json types so we cast through.
 * Partial / stream_event / hook events are dropped (caller already worked
 * without them under cli-handler).
 */
export function interpretSdkMessage(msg: SDKMessage): CliEvent | null {
  const t = (msg as any).type as string | undefined;
  if (!t) return null;
  switch (t) {
    case 'system':
      return msg as unknown as CliInitEvent;
    case 'assistant':
      return msg as unknown as CliAssistantEvent;
    case 'user':
      return msg as unknown as CliUserEvent;
    case 'rate_limit_event':
      return msg as unknown as CliRateLimitEvent;
    case 'result':
      return msg as unknown as CliResultEvent;
    default:
      return null;
  }
}

// --- SdkProcess: mirrors CliProcess interface -----------------------------

export class SdkProcess {
  private query: Query;
  private abortController: AbortController;
  private done = false;
  private logger = new Logger('SdkProcess');

  constructor(q: Query, abortController: AbortController) {
    this.query = q;
    this.abortController = abortController;
  }

  async *[Symbol.asyncIterator](): AsyncIterableIterator<CliEvent> {
    try {
      for await (const sdkMsg of this.query) {
        const event = interpretSdkMessage(sdkMsg);
        if (event) yield event;
      }
    } catch (err: any) {
      const isAbort = err?.name === 'AbortError' || /abort/i.test(String(err?.message || ''));
      if (!isAbort) {
        this.logger.error('SDK query threw', err);
        errorCollector.add('SdkHandler', `SDK query 실패: ${err?.message || err}`);
      }
      yield {
        type: 'result',
        subtype: isAbort ? 'error_timeout' : 'error',
        session_id: '',
        total_cost_usd: 0,
        duration_ms: 0,
        permission_denials: [],
        is_error: true,
        result: isAbort ? 'aborted' : String(err?.message || err),
      } as CliResultEvent;
    } finally {
      this.done = true;
    }
  }

  interrupt(): void {
    if (!this.done) this.abortController.abort();
  }

  kill(): void {
    this.interrupt();
  }

  get pid(): number | undefined {
    return undefined;
  }

  get isDone(): boolean {
    return this.done;
  }
}

// --- SdkHandler: mirrors CliHandler.runQuery interface --------------------

export interface SdkRunOptions {
  workingDirectory?: string;
  session?: ConversationSession;
  resumeSessionId?: string;
  continueLastSession?: boolean;
  model?: string;
  permissionMode?: 'default' | 'safe' | 'trust' | 'plan';
  allowedTools?: string[];
  appendSystemPrompt?: string;
  systemPrompt?: string;
  env?: Record<string, string>;
  maxBudgetUsd?: number;
  skipMcp?: boolean;
  noSessionPersistence?: boolean;
  tools?: string[];
  // SDK-specific extensions:
  canUseTool?: CanUseTool;
  thinkingBudgetTokens?: number;
}

export class SdkHandler {
  private logger = new Logger('SdkHandler');
  private mcpManager: McpManager;

  constructor(mcpManager: McpManager) {
    this.mcpManager = mcpManager;
  }

  runQuery(prompt: string, opts: SdkRunOptions): SdkProcess {
    const abortController = new AbortController();

    const sdkPermissionMode: SdkPermissionMode =
      opts.permissionMode === 'trust' ? 'bypassPermissions' :
      opts.permissionMode === 'plan'  ? 'plan' :
                                         'default';

    const sdkOptions: any = {
      permissionMode: sdkPermissionMode,
      settingSources: ['project'],
      persistSession: false,
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      includePartialMessages: false,
      abortController,
    };

    if (sdkPermissionMode === 'bypassPermissions') {
      sdkOptions.allowDangerouslySkipPermissions = true;
    }

    if (opts.model) sdkOptions.model = opts.model;
    if (opts.maxBudgetUsd && opts.maxBudgetUsd > 0) sdkOptions.maxBudgetUsd = opts.maxBudgetUsd;
    if (opts.workingDirectory) sdkOptions.cwd = opts.workingDirectory;
    if (opts.env) sdkOptions.env = opts.env;
    if (opts.canUseTool) sdkOptions.canUseTool = opts.canUseTool;

    if (opts.thinkingBudgetTokens && opts.thinkingBudgetTokens > 0) {
      sdkOptions.thinking = { type: 'enabled', budgetTokens: opts.thinkingBudgetTokens };
    }

    // System prompt: replace > append (matches cli-handler precedence)
    if (opts.systemPrompt) {
      sdkOptions.systemPrompt = opts.systemPrompt;
    } else if (opts.appendSystemPrompt) {
      sdkOptions.appendSystemPrompt = opts.appendSystemPrompt;
    }

    // Tools: explicit override > allowedTools. Empty tools[] = no tools.
    let resolvedAllowedTools: string[] | undefined;
    if (opts.tools !== undefined) {
      resolvedAllowedTools = opts.tools;
    } else if (opts.allowedTools && opts.allowedTools.length > 0 && sdkPermissionMode !== 'bypassPermissions') {
      resolvedAllowedTools = opts.allowedTools;
    }

    // MCP
    if (!opts.skipMcp) {
      const mcpServers = this.mcpManager.getServerConfiguration();
      if (mcpServers && Object.keys(mcpServers).length > 0) {
        sdkOptions.mcpServers = mcpServers;
        if (!resolvedAllowedTools) {
          const defaultMcpTools = this.mcpManager.getDefaultAllowedTools();
          if (defaultMcpTools.length > 0) resolvedAllowedTools = defaultMcpTools;
        }
      }
    }

    if (resolvedAllowedTools) sdkOptions.allowedTools = resolvedAllowedTools;

    // Resume
    if (opts.resumeSessionId) {
      sdkOptions.resume = opts.resumeSessionId;
    } else if (opts.continueLastSession) {
      sdkOptions.continue = true;
    } else if (opts.session?.sessionId) {
      sdkOptions.resume = opts.session.sessionId;
      if (opts.session.lastAssistantUuid) {
        sdkOptions.resumeSessionAt = opts.session.lastAssistantUuid;
      }
    }

    this.logger.info('Building SDK query', {
      prompt: prompt.substring(0, 200) + (prompt.length > 200 ? '...' : ''),
      permissionMode: sdkPermissionMode,
      resumeSessionId: opts.resumeSessionId,
      continueLastSession: opts.continueLastSession,
      sessionId: opts.session?.sessionId,
      model: opts.model,
      allowedToolsCount: resolvedAllowedTools?.length,
      cwd: opts.workingDirectory,
      thinkingBudget: opts.thinkingBudgetTokens,
    });

    const q = query({ prompt, options: sdkOptions });
    return new SdkProcess(q, abortController);
  }
}
