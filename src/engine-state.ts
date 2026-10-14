/**
 * 엔진 상태 — 어느 엔진이 언제까지 막혔나 · 마지막으로 된 때 · 얼마나 썼나. **정본은 이 모듈 하나다.**
 *
 * 스탠리는 Claude 사용량이 바닥나도 멈추면 안 된다(2026-10-14 사용자 결정). 다음 단계의 사다리
 * (Claude → GPT → agy Gemini → agy Claude(Sonnet) → 모아 두고 회복 때 처리)가 「지금 누구에게 맡기나」를
 * 여기서 읽는다. 이번 단계는 바탕만 깐다 — 적기(`engine-tap.ts`) · 회복 타이머(`engine-recovery.ts`) ·
 * 안내 한 곳(`engine-notice.ts`).
 *
 * **왜 파일인가** — 재시작해도 살아남아야 한다. 회복 타이머가 메모리에만 있을 때는 재시작이 타이머를
 * 지웠고 다시 거는 곳이 없었다. 임시 파일에 쓰고 바꿔 끼운다 — 쓰는 도중에 죽어도 반쪽 파일이 안 남게.
 *
 * **막힘의 갈래 넷** — 갈래마다 「언제 다시 해 볼지」를 정하는 규칙이 다르다.
 *   - usage    사용량 소진. 서버가 풀리는 시각을 알려 준다(`resetsAt`). 같은 갈래 안에서는 **앞당기지
 *              않는다** — 요청마다 조금씩 다른 시각이 오는데 이른 쪽을 잡으면 아직 안 풀린 채 또 막힌다
 *   - overload 서버 과부하(529). 10분 → 20분 → 40분 → 60분(멈춤) · 한 번이라도 되면 처음으로.
 *              **5시간을 들고 있지 않는다** — 2026-08-24 의 과부하를 5시간짜리 한도로 잡아 이레를 들고 있었다
 *   - auth · unknown  60분 뒤에 다시 본다
 *
 * 읽기·쓰기는 부를 때마다 파일을 읽고 고쳐 쓴다(작은 JSON 한 개) — 메모리 사본을 두지 않아야
 * 다시 읽은 값이 곧 재시작 뒤의 값이다.
 */
import * as fs from 'fs';
import * as path from 'path';

export type Engine = 'claude' | 'codex' | 'agy-claude' | 'agy-gemini';
/** DM 을 맡는 차례 — 앞이 막히면 다음으로 내려간다. 6단계부터 Gemini 가 agy 의 Claude(Sonnet)보다 앞이다. */
export const ENGINES: readonly Engine[] = ['claude', 'codex', 'agy-gemini', 'agy-claude'];
export type BlockKind = 'usage' | 'overload' | 'auth' | 'unknown';

export interface Block {
  kind: BlockKind;
  /** 다시 해 볼 시각(epoch 초). */
  until: number | null;
  /** 서버가 알려 준 시각인가 — 아니면 규칙으로 정한 「다시 볼 시각」. */
  untilKnown: boolean;
  /** 이 막힘 구간이 시작된 시각(epoch 초). */
  since: number;
  limitType?: string;
  /** 과부하가 잇달아 몇 번째인가 — 기다리는 시간이 두 배씩 는다. */
  step?: number;
}

export interface Util { five_hour?: number; seven_day?: number; at: number; }

export interface EngineRecord {
  blocked: Block | null;
  lastOkAt: number | null;
  /** `rate_limit_event` 가 실어 온 사용률(있을 때만). */
  util?: Util;
  /** 쓴 시각들(epoch 초) — 최근 5시간만 둔다. 다음 단계의 「Gemini 5시간당 상한」이 센다. */
  uses: number[];
}

export interface EngineStateData {
  v: 1;
  engines: Record<Engine, EngineRecord>;
  /** 한도 안내를 이번 구간에 이미 올렸나 — 키가 같으면 두 번째부터는 ✋ 만 붙인다. */
  notice: { key: string; at: number } | null;
  /** 엔진 안내가 마지막으로 알린 DM 차례 — 재시작해도 같은 안내를 되풀이하지 않게. */
  ladder: { rung: string; key: string; at: number } | null;
}

export interface BlockInput { kind: BlockKind; until?: number; limitType?: string; }

/** 과부하 첫 대기 · 상한 — 두 배씩 늘다가 상한에서 멈춘다. */
export const OVERLOAD_FIRST_SEC = 10 * 60;
export const OVERLOAD_MAX_SEC = 60 * 60;
/** 풀리는 시각을 모를 때 다시 보는 간격(auth · unknown · 시각 없는 사용량 소진). */
export const REPROBE_SEC = 60 * 60;
/** 쓴 횟수를 세는 창. */
export const USE_WINDOW_SEC = 5 * 60 * 60;

export function overloadBackoffSec(step: number): number {
  return Math.min(OVERLOAD_MAX_SEC, OVERLOAD_FIRST_SEC * 2 ** Math.max(0, step - 1));
}

const ROOT = path.join(__dirname, '..');

/**
 * 상태 파일 자리. **시험이 운영 파일을 안 건드리게** — `ENGINE_STATE_FILE` 로 옮기고, 옛 검사처럼
 * `RATE_LIMIT_UNTIL_FILE` 만 옮긴 경우에도 그 옆으로 따라간다(옮긴 쪽은 운영 파일을 안 건드릴 셈이었다).
 */
function defaultFile(): string {
  if (process.env.ENGINE_STATE_FILE) return process.env.ENGINE_STATE_FILE;
  if (process.env.RATE_LIMIT_UNTIL_FILE) {
    return path.join(path.dirname(process.env.RATE_LIMIT_UNTIL_FILE), '.engine-state.json');
  }
  return path.join(ROOT, '.engine-state.json');
}

/** 옛 파일 `{until}` — 한 번만 옮겨 오고 손대지 않는다. */
function defaultLegacy(): string {
  return process.env.RATE_LIMIT_UNTIL_FILE || path.join(ROOT, '.rate-limit-until.json');
}

function emptyRecord(): EngineRecord {
  return { blocked: null, lastOkAt: null, uses: [] };
}

function emptyState(): EngineStateData {
  const engines = {} as Record<Engine, EngineRecord>;
  for (const e of ENGINES) engines[e] = emptyRecord();
  return { v: 1, engines, notice: null, ladder: null };
}

/** 읽은 것을 모양에 맞춘다 — 손으로 고쳤거나 옛 판이어도 칸이 다 있게. */
function normalize(raw: any): EngineStateData {
  const st = emptyState();
  if (!raw || typeof raw !== 'object') return st;
  for (const e of ENGINES) {
    const r = raw.engines?.[e];
    if (!r || typeof r !== 'object') continue;
    const b = r.blocked;
    st.engines[e] = {
      blocked: b && typeof b === 'object' && typeof b.kind === 'string' ? {
        kind: b.kind,
        until: typeof b.until === 'number' ? b.until : null,
        untilKnown: b.untilKnown === true,
        since: typeof b.since === 'number' ? b.since : 0,
        ...(b.limitType ? { limitType: String(b.limitType) } : {}),
        ...(typeof b.step === 'number' ? { step: b.step } : {}),
      } : null,
      lastOkAt: typeof r.lastOkAt === 'number' ? r.lastOkAt : null,
      ...(r.util && typeof r.util === 'object' ? { util: r.util } : {}),
      uses: Array.isArray(r.uses) ? r.uses.filter((x: unknown) => typeof x === 'number') : [],
    };
  }
  if (raw.notice && typeof raw.notice.key === 'string') st.notice = raw.notice;
  if (raw.ladder && typeof raw.ladder.rung === 'string') st.ladder = raw.ladder;
  return st;
}

export interface EngineStateOptions {
  /** 상태 파일 — 함수면 부를 때마다 묻는다(환경 변수를 늦게 세우는 시험). */
  file?: string | (() => string);
  legacyFile?: string | (() => string);
  /** 시계(밀리초) — 시험이 바꿔 끼운다. */
  now?: () => number;
}

export class EngineState {
  private listeners = new Set<() => void>();

  constructor(private opts: EngineStateOptions = {}) {}

  get file(): string {
    const f = this.opts.file ?? defaultFile;
    return typeof f === 'function' ? f() : f;
  }

  private get legacyFile(): string {
    const f = this.opts.legacyFile ?? defaultLegacy;
    return typeof f === 'function' ? f() : f;
  }

  nowSec(): number {
    return Math.floor((this.opts.now ?? Date.now)() / 1000);
  }

  /**
   * 읽는다. **절대 안 던진다** — 깨진 파일이면 빈 상태로 본다(막힌 것이 없는 쪽이 안전하다:
   * 모른다고 멈추면 한 번 잘못 적힌 값이 드레인을 영영 재운다).
   *
   * 상태 파일이 아직 없으면 옛 파일(`.rate-limit-until.json`)의 `until` 을 한 번 옮겨 온다 —
   * 아직 안 지났을 때만. 옛 파일은 그대로 둔다.
   */
  load(): EngineStateData {
    const file = this.file;
    try {
      if (fs.existsSync(file)) return normalize(JSON.parse(fs.readFileSync(file, 'utf-8')));
    } catch {
      return emptyState();
    }
    const st = emptyState();
    try {
      const until = JSON.parse(fs.readFileSync(this.legacyFile, 'utf-8')).until;
      const now = this.nowSec();
      if (typeof until === 'number' && until > now) {
        st.engines.claude.blocked = { kind: 'usage', until, untilKnown: true, since: now };
        this.save(st);
      }
    } catch {
      /* 옛 파일이 없다 — 옮길 것이 없다 */
    }
    return st;
  }

  /** 임시 파일에 쓰고 바꿔 끼운다. 윈도가 바꿔 끼우기를 거절하면 그 자리에 쓴다. */
  save(st: EngineStateData): void {
    const file = this.file;
    const body = JSON.stringify(st, null, 2);
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, body, 'utf-8');
      try {
        fs.renameSync(tmp, file);
      } catch {
        fs.writeFileSync(file, body, 'utf-8');
        fs.rmSync(tmp, { force: true });
      }
    } catch {
      /* 안전망이라 실패해도 본 차례를 막지 않는다 — 다음 쓰기가 덮는다 */
    }
  }

  /** 막힘이 바뀌면(생김 · 풀림 · 시각 바뀜) 부른다. 돌려주는 함수로 끊는다. */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private emit(): void {
    for (const fn of [...this.listeners]) {
      try { fn(); } catch { /* 듣는 쪽의 사고가 적기를 막지 않는다 */ }
    }
  }

  /** 고치고 쓴다 — 막힘이 바뀌었으면 듣는 쪽에 알린다. */
  private mutate<T>(fn: (st: EngineStateData) => T): T {
    const st = this.load();
    const before = JSON.stringify(ENGINES.map((e) => st.engines[e].blocked));
    const out = fn(st);
    this.save(st);
    if (JSON.stringify(ENGINES.map((e) => st.engines[e].blocked)) !== before) this.emit();
    return out;
  }

  /** 됐다 — 막힘을 지운다(과부하 단계도 처음으로). */
  recordOk(engine: Engine): void {
    this.mutate((st) => {
      const r = st.engines[engine];
      r.blocked = null;
      r.lastOkAt = this.nowSec();
    });
  }

  /**
   * 막혔다. 갈래마다 다시 해 볼 시각을 정한다(파일 머리 주석). 정해진 막힘을 돌려준다.
   *
   * **갈래가 다르면 새 것이 이긴다** — 서버가 방금 새로 알려 준 것이라서다. 단 서버가 알려 준
   * 사용량 소진 시각이 아직 남아 있고 새 것보다 늦으면 그대로 둔다(그 시각이 정본이다).
   */
  recordBlocked(engine: Engine, input: BlockInput): Block {
    return this.mutate((st) => {
      const now = this.nowSec();
      const r = st.engines[engine];
      const prev = r.blocked;
      const known = typeof input.until === 'number' && input.until > 0;
      const same = prev?.kind === input.kind;
      let next: Block;

      if (input.kind === 'usage') {
        if (same && prev && prev.until !== null) {
          if (known && prev.untilKnown) {
            // 둘 다 서버가 준 시각 — 늦은 쪽으로만 민다.
            next = { ...prev, until: Math.max(prev.until, input.until!) };
          } else if (known) {
            // 앞은 짐작이었고 이제 서버가 알려 줬다 — 짐작보다 이르더라도 서버 값이 맞다.
            next = { ...prev, until: input.until!, untilKnown: true };
          } else if (prev.untilKnown && prev.until > now) {
            // 서버가 준 시각이 아직 남았다 — 시각 없는 새 실패가 그것을 덮지 않는다.
            next = prev;
          } else {
            next = { ...prev, until: Math.max(prev.until, now + REPROBE_SEC), untilKnown: false };
          }
        } else {
          next = known
            ? { kind: 'usage', until: input.until!, untilKnown: true, since: now }
            : { kind: 'usage', until: now + REPROBE_SEC, untilKnown: false, since: now };
        }
        if (input.limitType) next = { ...next, limitType: input.limitType };
      } else if (input.kind === 'overload') {
        const step = same && prev ? (prev.step ?? 1) + 1 : 1;
        const until = now + overloadBackoffSec(step);
        next = {
          kind: 'overload',
          until: same && prev?.until ? Math.max(prev.until, until) : until,
          untilKnown: false,
          since: same && prev ? prev.since : now,
          step,
        };
      } else {
        // auth · unknown — 시각을 알려 주면 그것을, 아니면 한 시간 뒤에 다시 본다.
        const until = known ? input.until! : now + REPROBE_SEC;
        next = {
          kind: input.kind,
          until: same && prev?.until ? Math.max(prev.until, until) : until,
          untilKnown: known,
          since: same && prev ? prev.since : now,
        };
      }

      if (!same && prev && prev.kind === 'usage' && prev.untilKnown
          && prev.until !== null && prev.until > now && (next.until ?? 0) < prev.until) {
        next = prev;
      }
      r.blocked = next;
      return next;
    });
  }

  /** 지금 막혀 있나. 다시 볼 시각을 모르면 **안 막힌 것으로 본다.** */
  isBlocked(engine: Engine, nowSec: number = this.nowSec()): boolean {
    const b = this.load().engines[engine].blocked;
    return !!b && b.until !== null && b.until > nowSec;
  }

  /** 적힌 막힘(지났어도 성공이 지우기 전까지 남는다 — 과부하 단계를 이어 세려고). */
  blocked(engine: Engine): Block | null {
    return this.load().engines[engine].blocked;
  }

  /** 적힌 다시 볼 시각 — 없으면 `null`. */
  blockedUntil(engine: Engine): number | null {
    return this.load().engines[engine].blocked?.until ?? null;
  }

  /** 막힌 엔진 가운데 가장 이른 「아직 안 온」 회복 시각. 없으면 `null`. */
  nextRecoveryAt(nowSec: number = this.nowSec()): number | null {
    const st = this.load();
    let best: number | null = null;
    for (const e of ENGINES) {
      const u = st.engines[e].blocked?.until;
      if (typeof u === 'number' && u > nowSec && (best === null || u < best)) best = u;
    }
    return best;
  }

  /** 한 번 썼다 — 5시간 창 밖은 버린다. */
  noteUse(engine: Engine): void {
    this.mutate((st) => {
      const now = this.nowSec();
      const r = st.engines[engine];
      r.uses = [...r.uses.filter((t) => t > now - USE_WINDOW_SEC), now];
    });
  }

  usesInWindow(engine: Engine, windowSec: number = USE_WINDOW_SEC): number {
    const now = this.nowSec();
    return this.load().engines[engine].uses.filter((t) => t > now - windowSec).length;
  }

  /** `rate_limit_event` 의 사용률을 적는다 — 5시간 · 7일 창만. */
  recordUtil(engine: Engine, u: { limitType: string; utilization: number }): void {
    if (u.limitType !== 'five_hour' && u.limitType !== 'seven_day') return;
    this.mutate((st) => {
      const r = st.engines[engine];
      r.util = { ...(r.util ?? {}), [u.limitType]: u.utilization, at: this.nowSec() } as Util;
    });
  }

  /**
   * 이 키로 안내한 적이 없으면 적고 `true` — 있으면 `false`. **안내를 올리기 전에** 부른다.
   * 재시작해도 남으므로 같은 구간에 안내가 두 번 안 나간다.
   */
  noticeOnce(key: string): boolean {
    return this.mutate((st) => {
      if (st.notice?.key === key) return false;
      st.notice = { key, at: this.nowSec() };
      return true;
    });
  }

  clearNotice(): void {
    this.mutate((st) => { st.notice = null; });
  }

  /** 엔진 안내가 마지막으로 알린 차례 — 적힌 것이 없으면 평소 차례(`claude`). */
  ladderRung(): string {
    return this.load().ladder?.rung ?? 'claude';
  }

  setLadder(rung: string, key: string): void {
    this.mutate((st) => { st.ladder = { rung, key, at: this.nowSec() }; });
  }
}

/** 봇 전체가 쓰는 하나 — 자리는 부를 때마다 환경 변수에서 정한다. */
export const engineState = new EngineState();
