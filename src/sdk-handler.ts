import {
  query,
  type Query,
  type SDKMessage,
  type CanUseTool,
  type PermissionMode as SdkPermissionMode,
} from '@anthropic-ai/claude-agent-sdk';
import { existsSync, statSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
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

/**
 * SDK 가 띄울 Claude Code 실행 파일 — **시스템에 깔린 것을 먼저** 쓴다.
 *
 * SDK 패키지에 딸린 실행 파일은 패키지를 올리기 전까지 낡은 채로 남고, 모델 별칭(`sonnet`·`opus`)을
 * 푸는 것이 그 실행 파일이다. 실측 2026-09-29: 딸린 2.1.280 은 `sonnet` 을 한 세대 전 모델로 풀었고,
 * 사람이 올리는 시스템 쪽 2.1.284 는 새 세대로 풀었다. `CLAUDE_CLI_PATH` → PATH 의 `claude` 순서로
 * 찾고, 못 찾으면 `undefined` 를 줘서 SDK 가 자기 것을 쓰게 둔다. 윈도에서는 `.exe` 만 본다 —
 * npm 의 `claude.cmd` 는 셸 없이 띄울 수 없다.
 *
 * **부를 때마다 다시 찾는다** — 한 번 찾은 값을 붙들면 Claude Code 가 스스로 업데이트하는 사이 파일이
 * 잠깐 없을 때 띄우기가 실패하고, 못 찾은 값을 붙들면 재시작 전까지 한 세대 전 모델에 머문다.
 * 결과가 바뀔 때만 기록하고, 못 찾으면 **경고**로 남긴다(조용한 판내림이라서).
 */
let lastExecutable: string | undefined | null = null;
export function resolveClaudeExecutable(): string | undefined {
  const envp = process.env.CLAUDE_CLI_PATH;
  const names = process.platform === 'win32' ? ['claude.exe'] : ['claude'];
  const found = envp && existsSync(envp) ? envp
    : (process.env.PATH || '').split(path.delimiter).filter(Boolean)
        .flatMap(dir => names.map(n => path.join(dir, n)))
        .find(p => existsSync(p));
  if (found !== lastExecutable) {
    const log = new Logger('SdkHandler');
    if (found) log.info('Claude Code 실행 파일 — 시스템 것을 씀', { path: found });
    else log.warn('Claude Code 실행 파일 — 못 찾아 SDK 에 딸린 것을 씀 · 모델 별칭이 한 세대 전으로 풀릴 수 있음');
    lastExecutable = found;
  }
  return found;
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
  /** 작업 폴더 밖에 읽고 쓸 폴더 — CLI 의 `--add-dir` 와 같다. */
  additionalDirectories?: string[];
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
   * 미리 띄워 둔 세션 — **옵션이 한 글자도 안 다를 때만 쓴다.**
   *
   * 실측 (2026-08-29 · 시스템 프롬프트 140KB · opus-5 · effort low):
   *   매번 새로 8.3초 · 미리 이어만 둠 5.0초 · 이어 두고 한 마디로 데움 4.7초
   * **데우는 한 마디는 안 쓴다** — 92%를 이어 두는 것만으로 벌고, 그 한 마디가
   * 대화에 남으면 판단이 달라질 수 있다(정확도가 첫째다).
   *
   * ⛔ **08-29 저녁에 걷었다가 08-31 에 되살렸다.** 걷은 이유는 실물에서 한 번도
   * 안 쓰였기 때문이고, 원인은 **캡처 id 가 시스템 프롬프트와 `env` 양쪽에 박혀
   * 프로세스를 띄울 때 굳는 것**이었다. 08-31 에 그 id 를 파일로 넘기게 바꿔
   * (`WORK_ASSISTANT_CAPTURE_FILE`) 옵션이 차례마다 같아졌다.
   *
   * ⚠️ **배관을 안 고치고 되살리면 안전망이 깨진다** — 억지로 쓰면 앞 차례의
   * 캡처를 닫고 이번 것이 큐에 남는다(원문 유실을 막는 마지막 장치).
   */
  /**
   * **옵션 지문별 자리** (2026-10-01) — 전에는 자리가 하나라 옵션이 다른 호출(좁은 길)이
   * 오면 대화용으로 띄워 둔 것을 **버렸다**(8/31 이후 「못 씀」 25번 중 9번). 이제 지문마다
   * 따로 두고 다른 옵션의 호출은 남의 자리를 안 건드린다. 자리는 `MAX_WARM` 까지 —
   * 대화형 하나(커밋 약 830MB · MCP 서버 포함)와 좁은 길형 하나(약 460MB).
   */
  private warms = new Map<string, {
    key: string; q: Query; send: (t: string) => void;
    abortController: AbortController; bornAt: number; ttlMs: number;
  }>();

  /**
   * 미리 띄운 것을 얼마나 들고 있나. 넘으면 버리고 새로 띄운다. **띄운 때부터 잰다 —
   * 다른 호출로 늘리지 않는다.** 10분 → 30분(2026-10-01): 다음 차례까지 간격 중앙이
   * 대화 30분 · 판 프롬프트 20분이라 10분은 대부분 놓쳤다(적중 25%). 60분은 더 얻는
   * 몫(12~13%p)보다 메모리를 오래 쥐는 값이 커서 안 골랐다(GPT 6.1 sol 검토와 같음).
   */
  static WARM_TTL_MS = 30 * 60_000;
  /** 동시에 들고 있는 미리 띄운 프로세스 수. 차면 가장 오래된 것을 버린다. */
  static MAX_WARM = 2;

  /** 메모리 문 — 감시기가 잰 커밋 비율을 넣는다(`observe`). */
  memoryGate = new WarmMemoryGate();
  /**
   * **메모리가 높은가** — 높으면 미리 띄우지 않는다. 기본은 메모리 문을 본다 — 감시기가
   * 없는 PC(시험 포함)에서는 아무도 안 채워 「안 높음」으로 그대로 돈다.
   */
  memoryHigh: () => boolean = () => this.memoryGate.high;
  /**
   * **띄우기 직전에 메모리를 한 번 잰다**(있으면). 커밋을 재는 것이 PowerShell 한 번이라
   * 주기로 자주 재지 않고 띄울 때만 잰다 — 띄우기는 차례가 끝난 뒤라 응답을 안 늦춘다.
   * 감시기의 정기 측정(3분)은 들고 있던 것을 버리는 쪽에 쓴다(`dropAllWarm`).
   */
  memorySample?: () => Promise<number | null>;

  /** 미리 띄운 것과 실제 호출을 맞대는 지문 — 옵션 + 띄울 때 읽은 파일들의 시각. */
  private keyOf(sdkOptions: any): string {
    return warmKey({ ...sdkOptions, __ctx: contextStamp(sdkOptions?.cwd) });
  }

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
  prewarm(opts: SdkRunOptions, ttlMs: number = SdkHandler.WARM_TTL_MS): void {
    // 메모리를 잴 수단이 있으면 재고 띄운다(비동기) · 없으면 곧바로(시험이 이 길이다).
    if (this.memorySample) {
      this.memorySample()
        .then((pct) => { if (pct !== null) this.memoryGate.observe(pct); })
        .catch(() => { /* 못 재면 마지막 판정을 그대로 쓴다 */ })
        .finally(() => this.prewarmNow(opts, ttlMs));
      return;
    }
    this.prewarmNow(opts, ttlMs);
  }

  private prewarmNow(opts: SdkRunOptions, ttlMs: number): void {
    try {
      // **메모리가 높으면 안 띄우고 들고 있던 것도 버린다** — 빠르게 하는 장치가 감시기의
      // 종료 문턱(90%)을 앞당기면 안 된다. 미리 띄운 것은 다시 띄우면 그만인 것이다.
      if (this.memoryHigh()) {
        if (this.warms.size) this.dropAllWarm('메모리가 높음');
        return;
      }
      const built = this.buildOptions('', opts);
      const key = this.keyOf(built.sdkOptions);
      const have = this.warms.get(key);
      if (have && Date.now() - have.bornAt < have.ttlMs) return;
      if (have) this.dropWarm(key);
      // 자리가 차면 가장 오래된 것을 버린다(Map 은 넣은 순서를 지킨다).
      while (this.warms.size >= SdkHandler.MAX_WARM) {
        const oldest = this.warms.keys().next().value as string;
        this.dropWarm(oldest);
      }
      const input = pushableInput();
      const q = SdkHandler.queryFn({ prompt: input.stream, options: built.sdkOptions });
      const mine = {
        key, q, send: input.send,
        abortController: built.abortController, bornAt: Date.now(), ttlMs,
      };
      this.warms.set(key, mine);
      // ⚠️ **안 쓰이면 스스로 죽는다.** 다음 호출이 와야 낡은 것을 버린다면,
      // 조용한 밤에는 프로세스 하나(커밋 수백 MB)가 아침까지 앉아 있는다.
      setTimeout(() => { if (this.warms.get(key) === mine) this.dropWarm(key); },
        ttlMs).unref?.();
      this.logger.info('세션을 미리 띄워 둠', { slots: this.warms.size, ttlMin: Math.round(ttlMs / 60_000) });
    } catch (err) {
      this.logger.error('미리 띄우기 실패 (평소대로 돕니다)', err);
    }
  }

  /** 들고 있던 것 하나를 버린다 — 낡았거나 자리가 찼을 때. */
  private dropWarm(key: string): void {
    const w = this.warms.get(key);
    this.warms.delete(key);
    if (!w) return;
    try { w.abortController.abort(); } catch { /* 이미 죽었다 */ }
  }

  /** 들고 있던 것을 다 버린다 — 메모리가 높을 때(감시기가 부른다). */
  dropAllWarm(why: string): void {
    if (!this.warms.size) return;
    const n = this.warms.size;
    for (const key of [...this.warms.keys()]) this.dropWarm(key);
    this.logger.info('미리 띄운 것을 다 버림', { why, n });
  }

  /** 지금 들고 있는 자리 수 — 시험과 로그가 본다. */
  get warmCount(): number { return this.warms.size; }

  runQuery(prompt: string, opts: SdkRunOptions): SdkProcess {
    const built = this.buildOptions(prompt, opts);
    const key = this.keyOf(built.sdkOptions);

    // **미리 띄운 것이 맞으면 그것을 쓴다.** 지문이 같은 자리만 본다 — 남의 옵션으로 뜬
    // 세션에 이 대화를 밀어 넣으면 조용히 다른 규칙으로 답한다.
    const w = this.warms.get(key);
    if (w) {
      if (Date.now() - w.bornAt < w.ttlMs) {
        this.warms.delete(key);
        this.logger.info('미리 띄운 세션을 씀', { agedMs: Date.now() - w.bornAt });
        w.send(prompt);
        return new SdkProcess(w.q, w.abortController);
      }
      this.logger.info('미리 띄운 것을 못 씀 — 새로 띄웁니다', { reason: '낡음' });
      this.dropWarm(key);
    } else if (this.warms.size) {
      // **다른 옵션의 자리는 그대로 둔다** — 버리면 그 자리의 다음 차례가 새로 뜬다.
      // ⚠️ **왜 안 맞았는지 같이 남긴다** — 08-29 에 이 줄이 「옵션이 다름」만 말해서,
      // 원인을 짚으려고 탐침을 따로 짜야 했다. 가장 최근 자리와 견준다.
      const last = [...this.warms.values()].pop()!;
      this.logger.info('미리 띄운 것과 옵션이 다름 — 그대로 두고 새로 띄웁니다',
        { reason: '옵션이 다름', diff: warmDiff(last.key, key) });
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
      // 프롬프트 속 `@경로` 펼침·슬래시 명령을 끈다 — 메일 본문 같은 남의 글이 들어오는데, 끄지 않으면
      // 글 속 `@C:/…` 가 그 파일 내용을 모델에 붙인다(도구를 꺼도 붙는다 · 실측 2026-09-29). 슬랙 대화에서
      // `@파일` 을 쓰는 일은 없다(사용자 · 기록된 프롬프트 3,162건 중 `/`·`@경로` 로 기대는 것 0).
      // 설명서는 첫 턴 스킬 목록·CLAUDE.md 도 빠질 수 있다고 하나, 이 설정으로 재 보니 셋 다 보였다.
      verbatimPrompts: true,
      abortController,
    };
    const exe = resolveClaudeExecutable();
    if (exe) sdkOptions.pathToClaudeCodeExecutable = exe;

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
    if (opts.additionalDirectories?.length) sdkOptions.additionalDirectories = opts.additionalDirectories;

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
 * `query()` 는 만들자마자 프로세스를 띄운다(읽기를 시작하지 않아도 뜬다). 그래서
 * 프롬프트를 흐름으로 주면 **띄워 놓고 나중에 말을 넣을 수 있다** — 미리 띄우기가
 * 서는 자리다.
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

/**
 * **미리 띄운 프로세스가 띄울 때 읽은 것** — 규칙 파일(`CLAUDE.md`) · 설정 · 실행 파일의
 * 수정 시각. 지문에 같이 넣어, 그 사이 바뀌었으면 옛 규칙으로 답하는 것을 안 쓴다
 * (2026-10-01 · GPT 6.1 sol 검토). 내용 대신 시각만 본다 — 지문을 만들 때마다 읽는다.
 * MCP 설정은 내용째 옵션(`mcpServers`)에 이미 들어 있다.
 *
 * **`AGENTS.md` 도 본다**(2026-10-02) — 다른 사람과 쓰는 저장소는 규칙 본문을 `AGENTS.md` 에 두고
 * `CLAUDE.md` 는 그것을 불러오는 한 줄(`@AGENTS.md`)만 둔다. 그러면 규칙을 고쳐도 `CLAUDE.md` 의
 * 시각은 그대로라, 이것을 안 보면 미리 띄운 프로세스가 옛 규칙으로 답한다.
 */
export function contextStamp(cwd?: string): string {
  const home = os.homedir();
  const files = [
    cwd && path.join(cwd, 'CLAUDE.md'),
    cwd && path.join(cwd, 'AGENTS.md'),
    cwd && path.join(cwd, '.claude', 'settings.json'),
    cwd && path.join(cwd, '.claude', 'settings.local.json'),
    path.join(home, '.claude', 'CLAUDE.md'),
    path.join(home, '.claude', 'settings.json'),
    resolveClaudeExecutable(),
  ].filter(Boolean) as string[];
  return files.map((f) => {
    try { return String(Math.round(statSync(f).mtimeMs)); } catch { return '0'; }
  }).join('.');
}

/** 시스템 커밋이 이만큼이면 미리 띄우지 않고 들고 있던 것도 버린다. */
export const WARM_MEMORY_HIGH_PCT = 85;
/** 다시 띄우는 것은 이 아래가 **두 번 잇달아** 잡힌 뒤 — 경계에서 띄웠다 버렸다를 막는다. */
export const WARM_MEMORY_RESUME_PCT = 80;

/** 메모리 문 — 85% 에서 닫고 80% 이하 두 번에 연다(이력 현상). */
export class WarmMemoryGate {
  high = false;
  private lowStreak = 0;
  observe(pct: number): boolean {
    if (pct >= WARM_MEMORY_HIGH_PCT) { this.high = true; this.lowStreak = 0; }
    else if (pct <= WARM_MEMORY_RESUME_PCT) {
      this.lowStreak += 1;
      if (this.lowStreak >= 2) this.high = false;
    } else this.lowStreak = 0;
    return this.high;
  }
}

/**
 * 두 지문이 **어느 칸에서** 갈렸나. 로그 한 줄에 담을 만큼만 낸다.
 *
 * ⚠️ **값을 안 찍는다** — 지문에는 OAuth 토큰과 시스템 프롬프트가 들어 있다.
 * 칸 이름만으로도 원인을 짚기에 충분하다(08-29 에 필요했던 것이 그것이다).
 */
export function warmDiff(a: string, b: string): string {
  let x: any, y: any;
  try { x = JSON.parse(a); y = JSON.parse(b); } catch { return '읽을 수 없음'; }
  const keys = [...new Set([...Object.keys(x ?? {}), ...Object.keys(y ?? {})])];
  const off = keys.filter((k) => JSON.stringify(x?.[k]) !== JSON.stringify(y?.[k]));
  return off.length ? off.join(',') : '(같은데 안 맞음)';
}
