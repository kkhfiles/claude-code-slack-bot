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
  CliStreamEvent,
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

/**
 * Strip CLI-style permission pattern off a tool name.
 *   'Bash(python:*)' → 'Bash'
 *   'Read'           → 'Read'
 *   'mcp__x__y'      → 'mcp__x__y'
 */
function toBaseToolName(entry: string): string {
  const idx = entry.indexOf('(');
  return idx > 0 ? entry.substring(0, idx) : entry;
}

// --- SDK message → CliEvent translation -----------------------------------

/**
 * SDK 0.3.143 message stream → CliEvent shape (Phase 1.5 §6 interpretSdkEvents).
 *
 * SDKMessage `type` values mostly mirror stream-json types so we cast through.
 * SDKPartialAssistantMessage carries `type: 'stream_event'` and is structurally
 * compatible with CliStreamEvent (same `event.type`/`content_block`/`delta`/
 * `index` shape) — used by interactive Slack chat for real-time tool status.
 * Hook events remain dropped.
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
    case 'stream_event':
      return msg as unknown as CliStreamEvent;
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
  permissionMode?: 'default' | 'safe' | 'trust' | 'plan' | 'auto';
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
  /**
   * 사고 깊이. **사고를 조절하는 손잡이는 이것 하나다.**
   *
   * 지금 모델(Claude 5)은 적응형 사고 — 턴마다 얼마나 생각할지 모델이 스스로
   * 정하고, `effort` 가 그 깊이를 안내한다. 기본값은 `'high'`.
   *
   * SDK 의 `thinking: {type:'enabled', budgetTokens}` 는 쓰지 않는다. 타입 주석이
   * "older models" 라고 못박은 고정 예산 경로라, 넘기는 순간 적응형이 꺼져
   * **쉬운 턴에서 알아서 줄이는 성질까지 잃는다**(2026-08-05).
   */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /**
   * 설정을 **덧씌우는 층**(SDK 의 "flag settings"). 사용자·프로젝트·로컬 설정을
   * 지우지 않고 그 위에 얹히므로, 여기 몇 개만 넣어도 허용 목록은 그대로 산다.
   */
  settings?: Record<string, unknown>;
  /**
   * 설정을 **어디서 읽나**. 생략하면 `['user','project','local']` 셋 다 — 대화형
   * 세션의 기본값이다. `[]` 로 비우면 규칙 파일(CLAUDE.md)까지 안 읽으므로,
   * 프롬프트 하나로 끝나는 자동 세션은 여기서 들고 시작하는 값을 크게 줄인다.
   * **허용 규칙도 같이 사라진다** — `settings` 로 필요한 것만 직접 준다.
   */
  settingSources?: ('user' | 'project' | 'local')[];
  /**
   * Skill catalog injected into the system prompt so the model can invoke the
   * `Skill` tool by name. SDK Options docs say "omitted = no SDK auto-config",
   * which in headless (`-p`) mode means user-level `~/.claude/skills/` are not
   * surfaced to the model unless this is explicit. Pass `'all'` to expose every
   * discovered skill or a list of skill names to scope.
   */
  skills?: 'all' | string[];
}

export class SdkHandler {
  private logger = new Logger('SdkHandler');
  private mcpManager: McpManager;

  constructor(mcpManager: McpManager) {
    this.mcpManager = mcpManager;
  }

  /**
   * ⛔ **미리 띄워 두던 자리 — 2026-08-29 에 걷었다.**
   *
   * 실물에서 **한 번도 안 쓰였다.** 판 프롬프트마다 새 캡처가 생기고 그 id 가
   * 시스템 프롬프트와 `env` 양쪽에 박히는데, 둘 다 프로세스를 띄울 때 굳어
   * 나중에 갈아 끼울 수 없다. 세션 id 는 원인이 아니었다(두 차례가 같았다).
   *
   * **억지로 쓰면 앞 차례의 캡처를 닫고 이번 것이 큐에 남는다** — 원문 유실을
   * 막는 마지막 안전망을 깨는 거래다.
   *
   * **값도 작았다** — 판 한 건 23.1초 중 프로세스 띄우기 3.3초 · **모델 차례
   * 21.5초**(75건 중앙값). 줄일 곳은 여기가 아니라 무엇을 싣고 부르나다.
   * 근거·재는 법 = work-assistant `docs/design.md` §5.17.
   */
  runQuery(prompt: string, opts: SdkRunOptions): SdkProcess {
    const built = this.buildOptions(prompt, opts);
    const q = query({ prompt, options: built.sdkOptions });
    return new SdkProcess(q, built.abortController);
  }

  private buildOptions(prompt: string, opts: SdkRunOptions):
      { sdkOptions: any; abortController: AbortController } {
    const abortController = new AbortController();

    // 'default' would prompt the user for risky tool calls, but background
    // analyses cannot answer prompts and the call hangs/denies. 'dontAsk' uses
    // pre-approved permission patterns from settings (via settingSources) and
    // silently denies anything else — matches CLI --print behavior with settings.local.json.
    const sdkPermissionMode: SdkPermissionMode =
      opts.permissionMode === 'trust' ? 'bypassPermissions' :
      opts.permissionMode === 'plan'  ? 'plan' :
      // 'auto' = 읽기 전용은 분류기가 통과시키고 나머지는 설정의 허용 목록이
      // 정한다. 대화형 슬랙 세션의 기본값 — 'dontAsk' 는 허용 목록에 없는
      // 것을 조용히 거부해서, 업무 등록·수정 같은 정상 작업이 말없이 안 된다.
      opts.permissionMode === 'auto'  ? 'auto' :
                                         'dontAsk';

    const sdkOptions: any = {
      permissionMode: sdkPermissionMode,
      // 'project' alone misses .claude/settings.local.json where operator-only
      // permissions live (e.g. Bash(python:*) for analysis scripts). CLI auto-merges
      // all three; SDK requires explicit listing. Precedence: user < project < local.
      settingSources: ['user', 'project', 'local'],
      // CLI persists sessions by default; opt out only when caller asks. Previously
      // hardcoded to false, so the interface field was a lie and analysis sessions
      // never showed up in ~/.claude/projects/ when run via SDK.
      persistSession: !opts.noSessionPersistence,
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      // Interactive Slack chat shows "Using <tool>" status by listening to
      // content_block_start stream events. SDKPartialAssistantMessage carries
      // these; assistant-scheduler/calendar paths just ignore unrecognised
      // events, so flipping this on is safe across all callers.
      includePartialMessages: true,
      abortController,
    };

    if (sdkPermissionMode === 'bypassPermissions') {
      sdkOptions.allowDangerouslySkipPermissions = true;
    }

    if (opts.model) sdkOptions.model = opts.model;
    if (opts.maxBudgetUsd && opts.maxBudgetUsd > 0) sdkOptions.maxBudgetUsd = opts.maxBudgetUsd;
    if (opts.workingDirectory) sdkOptions.cwd = opts.workingDirectory;
    // SDK destructures Options as `env: H = {...process.env}` — passing opts.env REPLACES
    // process.env entirely, dropping PATH/HOME/TZ/USERPROFILE etc. Merge instead so the
    // subprocess keeps standard env and only opts.env overrides on top.
    if (opts.env) sdkOptions.env = { ...process.env, ...opts.env };
    if (opts.canUseTool) sdkOptions.canUseTool = opts.canUseTool;

    if (opts.effort) sdkOptions.effort = opts.effort;
    if (opts.settings) sdkOptions.settings = opts.settings;
    // 설정을 어디서 읽나. **이 목록이 곧 CLAUDE.md 를 읽느냐다** — 규칙 파일은
    // 설정과 같은 출처를 따라오므로, 두 CLAUDE.md 가 6.8만 자(한글이라 토큰은 그
    // 이상)인 이 PC 에서는 세션 하나가 들고 시작하는 값이 여기서 갈린다. 대신
    // 허용 규칙도 같이 사라지니 `settings` 로 필요한 만큼만 직접 준다.
    if (opts.settingSources) sdkOptions.settingSources = opts.settingSources;

    if (opts.skills !== undefined) sdkOptions.skills = opts.skills;

    // System prompt: replace > append (matches cli-handler precedence)
    // Top-level `appendSystemPrompt` is NOT a public SDK option — silently dropped.
    // The public surface is systemPrompt: { type:'preset', preset:'claude_code', append }.
    if (opts.systemPrompt) {
      sdkOptions.systemPrompt = opts.systemPrompt;
    } else if (opts.appendSystemPrompt) {
      sdkOptions.systemPrompt = {
        type: 'preset',
        preset: 'claude_code',
        append: opts.appendSystemPrompt,
      };
    }

    // SDK separates two concepts that the CLI bridges through one variadic flag:
    //   - `tools`: base set of built-in tools the model can see at all. [] disables all.
    //   - `allowedTools`: tools auto-approved without a permission prompt.
    // Previously opts.tools was misrouted into allowedTools, so `tools: []` (calendar
    // judgment) only worked because dontAsk mode silently denied unlisted tools, not
    // because tools were actually unavailable. Route each option to its real target.
    // CLI accepts permission patterns ('Bash(python:*)'); SDK expects bare names.
    if (opts.tools !== undefined) {
      sdkOptions.tools = opts.tools.length === 0 ? [] : opts.tools.map(toBaseToolName);
    }

    let resolvedAllowedTools: string[] | undefined;
    if (opts.allowedTools && opts.allowedTools.length > 0 && sdkPermissionMode !== 'bypassPermissions') {
      resolvedAllowedTools = Array.from(new Set(opts.allowedTools.map(toBaseToolName)));
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
      effort: sdkOptions.effort,
    });

    return { sdkOptions, abortController };
  }
}

