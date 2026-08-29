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
   * 미리 띄워 둔 세션을 쓴다 — **옵션이 한 글자도 안 다를 때만**.
   *
   * 재는 값(2026-08-29, 시스템 프롬프트 140KB 로 실측):
   *   매번 새로 8.3초 · 미리 이어만 둠 5.0초 · 이어 두고 한 마디로 데움 4.7초
   * **데우는 한 마디는 안 쓴다** — 92%를 이어 두는 것만으로 벌고, 그 한 마디가
   * 대화에 남으면 판단이 달라질 수 있다(정확도가 첫째다).
   */
  private warm: {
    key: string; q: Query; send: (t: string) => void;
    abortController: AbortController; bornAt: number;
  } | null = null;

  /** 미리 띄운 것을 얼마나 들고 있나. 넘으면 버리고 새로 띄운다. */
  static WARM_TTL_MS = 10 * 60_000;

  /**
   * `query` 를 한 겹 감싸 둔다 — **시험이 바꿔 끼우려고**.
   *
   * 미리 띄우기의 값은 「언제 재사용하나」라는 규칙에 있는데, 진짜 프로세스를
   * 띄워 재면 한 번에 몇 초씩 들고 구독 한도를 먹는다. 여기를 바꿔 끼우면
   * 규칙만 따로 잴 수 있다.
   */
  static queryFn: typeof query = query;

  /**
   * 다음 호출을 위해 하나 띄워 둔다. **방금 쓴 것과 같은 옵션으로** 부르면
   * 판에서 오는 말처럼 모양이 같은 것이 이어질 때 그대로 맞는다.
   *
   * ⚠️ **여기서 터져도 아무 일도 없어야 한다** — 이것은 빠르게 하는 장치이지
   * 반영의 일부가 아니다.
   */
  prewarm(opts: SdkRunOptions): void {
    try {
      if (this.warm && Date.now() - this.warm.bornAt < SdkHandler.WARM_TTL_MS) return;
      this.dropWarm();
      const built = this.buildOptions('', opts);
      const input = pushableInput();
      const q = SdkHandler.queryFn({ prompt: input.stream, options: built.sdkOptions });
      this.warm = {
        key: warmKey(built.sdkOptions), q, send: input.send,
        abortController: built.abortController, bornAt: Date.now(),
      };
      // ⚠️ **안 쓰이면 스스로 죽는다.** 다음 호출이 와야 낡은 것을 버린다면,
      // 조용한 밤에는 프로세스 하나(350MB 안팎)가 아침까지 앉아 있는다.
      const mine = this.warm;
      setTimeout(() => { if (this.warm === mine) this.dropWarm(); },
        SdkHandler.WARM_TTL_MS).unref?.();
      this.logger.info('세션을 미리 띄워 둠');
    } catch (err) {
      this.logger.error('미리 띄우기 실패 (평소대로 돕니다)', err);
      this.warm = null;
    }
  }

  /** 들고 있던 것을 버린다 — 낡았거나 옵션이 다를 때. */
  private dropWarm(): void {
    const w = this.warm;
    this.warm = null;
    if (!w) return;
    try { w.abortController.abort(); } catch { /* 이미 죽었다 */ }
  }

  runQuery(prompt: string, opts: SdkRunOptions): SdkProcess {
    const built = this.buildOptions(prompt, opts);
    const key = warmKey(built.sdkOptions);

    // **미리 띄운 것이 맞으면 그것을 쓴다.** 옵션이 다르면 버리고 평소대로 —
    // 남의 옵션으로 뜬 세션에 이 대화를 밀어 넣으면 조용히 다른 규칙으로 답한다.
    if (this.warm) {
      const fresh = Date.now() - this.warm.bornAt < SdkHandler.WARM_TTL_MS;
      if (this.warm.key === key && fresh) {
        const w = this.warm;
        this.warm = null;
        this.logger.info('미리 띄운 세션을 씀', { agedMs: Date.now() - w.bornAt });
        w.send(prompt);
        return new SdkProcess(w.q, w.abortController);
      }
      this.logger.info('미리 띄운 것을 못 씀 — 새로 띄웁니다',
        { reason: fresh ? '옵션이 다름' : '낡음' });
      this.dropWarm();
    }

    const q = SdkHandler.queryFn({ prompt, options: built.sdkOptions });
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

/**
 * 프롬프트를 나중에 밀어 넣을 수 있는 입력 흐름.
 *
 * **이것이 미리 띄우기의 열쇠다** — `query()` 는 만들자마자 프로세스를 띄우는데
 * (실측 2026-08-29: 읽기를 시작하지 않아도 뜬다), 프롬프트를 문자열로 주면
 * 그때 이미 무엇을 물을지 정해야 한다. 흐름으로 주면 **띄워 놓고 나중에 넣는다.**
 *
 * ⚠️ **넣고 곧바로 닫는다.** 안 닫으면 SDK 가 「대화가 이어진다」고 보아 답이
 * 끝나도 표준입력을 안 닫고, 읽는 쪽의 `for await` 이 영영 안 끝난다.
 */
export function pushableInput(): { stream: AsyncIterable<any>; send: (t: string) => void } {
  const queue: any[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  const stream = (async function* () {
    for (;;) {
      if (queue.length) { yield queue.shift(); continue; }
      if (closed) return;
      await new Promise<void>((r) => { wake = r; });
    }
  })();
  return {
    stream,
    send(t: string) {
      queue.push({
        type: 'user',
        message: { role: 'user', content: t },
        parent_tool_use_id: null,
        session_id: '',
      });
      closed = true;
      const w = wake; wake = null; w?.();
    },
  };
}

/**
 * 옵션 지문. **다르면 미리 띄운 것을 안 쓴다.**
 *
 * 함수와 중단기는 뺀다 — 값이 없어 견줄 수 없고, 견줄 필요도 없다(모양이 같으면
 * 같은 자리에서 만들어진 것이다).
 */
export function warmKey(sdkOptions: any): string {
  return JSON.stringify(sdkOptions, (k, v) =>
    (k === 'abortController' || typeof v === 'function' ? undefined : v));
}
