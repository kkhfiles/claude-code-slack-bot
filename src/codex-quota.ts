/**
 * codex 한도 조회 — 폴백으로 codex 를 부르기 **전에** 남은 양을 본다 (2026-10-14 · 엔진 폴백 4단계).
 *
 * codex 가 다 쓴 날에도 폴백은 codex 를 띄우고, 한도 글을 받고서야 물러났다 — 차례마다 그만큼 늦고,
 * 한도 글의 모양은 아직 실측 전이라 못 가를 수도 있다. 그래서 구독 잔량을 직접 묻는다.
 *
 *   python -m llm_playbook.backends.codex_sdk --quota --json
 *   → {plan, primary: {used_percent, window_mins, resets_at}, secondary: {…}, reached, reset_credits, error}
 *
 * 모델을 부르지 않아 한도를 안 쓴다. 대신 app-server 를 띄워 몇 초 걸리므로 **5분에 한 번만** 묻고
 * 그 사이는 앞 답을 쓴다(동시에 물으면 한 번만 띄운다).
 *
 * 읽은 것은 엔진 상태로 간다 — 사용률(`codex` 의 five_hour · seven_day, 0~1)과, 창 하나라도 100% 면
 * 그 창이 풀리는 시각까지 막힘(`usage`). **판단은 엔진 상태 한 곳에서 한다** — 부르는 쪽은
 * `refresh()` 뒤에 `engineState.isBlocked('codex')` 만 본다.
 *
 * **못 읽으면 「모름」이다 — 막지 않는다.** 파이썬 · 패키지가 없거나 조회가 실패하면 폴백은 예전처럼
 * codex 를 불러 본다(모른다고 멈추면 조회 하나가 고장 나 폴백 전체가 선다). **절대 안 던진다.**
 * 못 읽었을 때는 막힘을 지우지도 않는다. 읽었고 남은 양이 있으면 사용량 소진 막힘만 지운다(`applyQuota`).
 */
import { spawn, execSync } from 'child_process';
import { pythonCommand } from './python-command';
import { Logger } from './logger';
import { engineState, type EngineState } from './engine-state';

const logger = new Logger('CodexQuota');

export interface CodexQuotaWindow {
  used_percent: number;
  window_mins?: number | null;
  resets_at?: number | null;
}

export interface CodexQuotaData {
  plan?: string | null;
  primary?: CodexQuotaWindow | null;
  secondary?: CodexQuotaWindow | null;
  reached?: string | null;
  error?: string | null;
}

export type QuotaVerdict = 'exhausted' | 'ok' | 'unknown';

/** 한 번 물은 답을 쓰는 동안. */
export const QUOTA_TTL_MS = 5 * 60_000;
/** 조회 한 번의 상한 — 넘으면 트리째 죽이고 「모름」. */
export const QUOTA_TIMEOUT_MS = 20_000;

/**
 * 조회 결과를 엔진 상태에 옮긴다. 창 하나라도 100% 이거나 `reached` 가 차 있으면 `exhausted` —
 * 풀리는 시각은 다 쓴 창들 가운데 가장 늦은 것(아는 것만).
 */
export function applyQuota(q: CodexQuotaData | null, store: EngineState = engineState): QuotaVerdict {
  if (!q || q.error) return 'unknown';
  const wins: Array<[string, CodexQuotaWindow | null | undefined]> = [['five_hour', q.primary], ['seven_day', q.secondary]];
  const until: number[] = [];
  let full = false;
  let seen = false;
  const read = new Set<string>();
  for (const [limitType, w] of wins) {
    if (!w || typeof w.used_percent !== 'number') continue;
    seen = true;
    read.add(limitType);
    store.recordUtil('codex', { limitType, utilization: w.used_percent / 100 });
    if (w.used_percent >= 100) {
      full = true;
      if (typeof w.resets_at === 'number' && w.resets_at > 0) until.push(w.resets_at);
    }
  }
  if (full || q.reached) {
    store.recordBlocked('codex', {
      kind: 'usage', ...(until.length ? { until: Math.max(...until) } : {}),
      ...(q.reached ? { limitType: String(q.reached) } : {}),
    });
    return 'exhausted';
  }
  if (!seen) return 'unknown';
  // **남은 양이 있다고 읽혔으면 사용량 소진 막힘을 지운다** — 그 막힘은 느슨한 글 판정이나 일찍 풀린 창에서 왔을
  // 수 있고, 안 지우면 남은 양이 있는데도 시각까지 GPT 를 건너뛴다. 막힌 창을 이번에 못 읽었으면 그대로 둔다.
  // 틀렸으면 다음 차례가 다시 막혀 적을 뿐이다(한 번 헛걸음). 마지막 성공은 안 고친다 — 된 차례가 없었다.
  const b = store.blocked('codex');
  if (b?.kind === 'usage' && !(b.limitType && QUOTA_WINDOWS.has(b.limitType) && !read.has(b.limitType))) {
    store.clearBlocked('codex', 'usage');
  }
  return 'ok';
}

/** 한도 조회가 읽는 창 이름 — 막힘의 `limitType` 이 이것이면 그 창을 읽었을 때만 막힘을 지운다. */
const QUOTA_WINDOWS: ReadonlySet<string> = new Set(['five_hour', 'seven_day']);

/** 파이썬 경로 — 사다리와 같은 것을 쓴다(`LADDER_PYTHON`). 한도 조회만 바꾸려면 `CODEX_QUOTA_PYTHON`. */
function quotaPython(): string {
  return process.env.CODEX_QUOTA_PYTHON || process.env.LADDER_PYTHON || 'python';
}

/** `--quota --json` 한 번. 못 하면 `null`. */
export function fetchCodexQuota(timeoutMs: number = QUOTA_TIMEOUT_MS): Promise<CodexQuotaData | null> {
  return new Promise((resolve) => {
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(pythonCommand(quotaPython()),
        ['-X', 'utf8', '-m', 'llm_playbook.backends.codex_sdk', '--quota', '--json'], {
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8', CLAUDE_SCHEDULED: '1' },
        });
    } catch {
      resolve(null);
      return;
    }
    let out = '';
    proc.stdout?.on('data', (c: Buffer) => { if (out.length < 20_000) out += c.toString('utf-8'); });
    proc.stderr?.on('data', () => { /* 버린다 — 실패는 결과의 error 칸 · rc 로 본다 */ });
    const killTimer = setTimeout(() => {
      // app-server 까지 트리째 — 파이썬만 죽이면 codex 프로세스가 고아로 남는다.
      try {
        if (process.platform === 'win32' && proc.pid) execSync(`taskkill /F /T /PID ${proc.pid}`, { stdio: 'ignore', windowsHide: true });
        else proc.kill('SIGKILL');
      } catch { /* 이미 끝났다 */ }
    }, timeoutMs);
    const done = (v: CodexQuotaData | null) => { clearTimeout(killTimer); resolve(v); };
    proc.on('error', () => done(null));
    proc.on('close', () => {
      const last = out.trim().split(/\r?\n/).pop() || '';
      try {
        const q = JSON.parse(last);
        done(q && typeof q === 'object' ? q as CodexQuotaData : null);
      } catch {
        done(null);
      }
    });
  });
}

export interface CodexQuotaOptions {
  fetch?: () => Promise<CodexQuotaData | null>;
  store?: EngineState;
  now?: () => number;
  ttlMs?: number;
}

export class CodexQuota {
  private last: { at: number; verdict: QuotaVerdict } | null = null;
  private inflight: Promise<QuotaVerdict> | null = null;

  /** 시험이 갈아 끼운다 — 운영은 `fetchCodexQuota`. */
  fetch: () => Promise<CodexQuotaData | null>;

  constructor(private opts: CodexQuotaOptions = {}) {
    this.fetch = opts.fetch ?? (() => fetchCodexQuota());
  }

  /** 앞 답을 잊는다 — 시험이 쓴다. */
  forget(): void {
    this.last = null;
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  /** 마지막 판정(묻지 않음) — 아직 안 물었으면 `unknown`. */
  get verdict(): QuotaVerdict {
    return this.last?.verdict ?? 'unknown';
  }

  /**
   * 5분이 지났으면 다시 묻고 엔진 상태에 옮긴다 — 판정을 돌려준다. **절대 안 던진다.**
   * 실패도 5분 동안 기억한다(고장 난 조회를 차례마다 20초씩 기다리지 않게).
   */
  async refresh(): Promise<QuotaVerdict> {
    const ttl = this.opts.ttlMs ?? QUOTA_TTL_MS;
    if (this.last && this.now() - this.last.at < ttl) return this.last.verdict;
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      let verdict: QuotaVerdict = 'unknown';
      try {
        verdict = applyQuota(await this.fetch(), this.opts.store ?? engineState);
      } catch (err: any) {
        logger.warn('codex 한도를 못 읽었습니다 — 모름으로 봅니다', { err: String(err?.message ?? err) });
      }
      this.last = { at: this.now(), verdict };
      if (verdict === 'exhausted') logger.warn('codex 한도 소진 — 풀릴 때까지 codex 폴백을 건너뜁니다');
      return verdict;
    })();
    try {
      return await this.inflight;
    } finally {
      this.inflight = null;
    }
  }
}

/** 봇 전체가 쓰는 하나. */
export const codexQuota = new CodexQuota();
