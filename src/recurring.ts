/**
 * 반복 타이머 공통 장치 — 봇이 거는 반복 타이머를 이름으로 감싸고, 각 타이머의 최근 실행을 상태 파일에 남긴다.
 *
 * **지금(1부)은 감싸기만 한다.** 하는 일, 시각, 오류 결과는 직접 `setInterval` · `setTimeout` 을 걸 때와 같다.
 *   - 같은 ms 로 거는 순간에 `setInterval` · `setTimeout` 을 부르고, 타이머가 울리면 같은 순간에 `run` 을 부른다.
 *   - 앞 회차가 아직 돌면 둘 다 돈다(겹친 횟수만 센다). 같은 이름을 두 번 걸어도 둘 다 산다(살아 있는 수만 센다).
 *   - `run` 이 던지면 기록한 뒤 같은 오류를 다시 던지고, 거부하면 기록한 뒤 같은 거부를 남긴다.
 *   - 기록은 절대 던지지 않는다 — 기록이 실패해도 타이머 동작은 그대로다.
 * 고치는 일(겹침 건너뛰기, 갈라짐 막기)은 2부에서 하나씩 한다. 계획 = `P:/bot-timers-plan-20261103.md`.
 *
 * **상태 파일은 운영 진입점만 켠다**(`setStatusFile`) — 검사를 하나씩 돌려도 실제 파일에 안 쓴다.
 * PC 점검기(`~/.claude/assets/pc-jobs.py`)가 이 파일로 멈춤 · 놓침 · 사라짐 · 연속 실패를 본다.
 * 담는 것은 이름, 시각, 횟수, 오류 종류(정해진 글자만)뿐 — 오류 문구 · 인자 · 대화 내용은 안 담는다.
 */
import fs from 'fs';
import path from 'path';
import { Logger } from './logger';

/** `run` 이 실패를 알리는 꼴 — 안에서 오류를 받아 정상으로 끝나는 함수가 쓴다. */
export interface RunFailure { ok: false; code?: string }

export interface Task {
  readonly name: string;
  /** 타이머를 지운다. `reason` 은 상태 파일에 남는다 — `reload`(설정 다시 읽기) · `stop`(기능 끔) 등. */
  stop(reason?: string): void;
}

interface Entry {
  kind: 'every' | 'once';
  everyMs?: number;
  dueAt?: string;
  unref: boolean;
  runs: number;
  fails: number;
  overlaps: number;
  running: number;
  runningSince?: string;
  lastStart?: string;
  lastEnd?: string;
  lastMs?: number;
  maxMs: number;
  lastOk?: boolean;
  lastCode?: string;
  lastOutcome?: string;
  live: number;
  stoppedAt?: string;
  stopReason?: string;
}

const SAFE = /^[A-Za-z0-9_.-]{1,40}$/;
const WRITE_EVERY_MS = 30_000;

const logger = new Logger('Recurring');
const entries = new Map<string, Entry>();
let statusFile: string | null = null;
let lastWrite = 0;
let dirty = false;
let writeWarned = false;
const bootAt = new Date().toISOString();

const safe = (v: unknown): string | undefined =>
  (typeof v === 'string' && SAFE.test(v) ? v : v === undefined || v === null ? undefined : 'other');

function entry(name: string, kind: Entry['kind'], unref: boolean): Entry {
  let e = entries.get(name);
  if (!e) {
    e = { kind, unref, runs: 0, fails: 0, overlaps: 0, running: 0, maxMs: 0, live: 0 };
    entries.set(name, e);
  }
  e.kind = kind;
  e.unref = unref;
  return e;
}

/** 이 회차의 결과를 센다. `value` 가 `{ ok: false }` 면 실패, 정해진 글자의 문자열이면 결과 이름으로 남긴다. */
function finish(e: Entry, started: number, ok: boolean, err?: unknown, value?: unknown): void {
  try {
    const now = Date.now();
    e.running = Math.max(0, e.running - 1);
    if (!e.running) e.runningSince = undefined;
    e.lastEnd = new Date(now).toISOString();
    e.lastMs = now - started;
    e.maxMs = Math.max(e.maxMs, e.lastMs);
    let code: string | undefined;
    if (ok && value && typeof value === 'object' && (value as RunFailure).ok === false) {
      ok = false;
      code = safe((value as RunFailure).code) ?? 'failed';
    } else if (!ok) {
      const x = err as { code?: unknown; name?: unknown } | undefined;
      code = safe(x?.code) ?? safe(x?.name) ?? 'other';
    }
    e.lastOk = ok;
    e.lastCode = ok ? undefined : code;
    e.fails = ok ? 0 : e.fails + 1;
    if (typeof value === 'string') e.lastOutcome = safe(value);
    touch();
  } catch {
    // 기록은 던지지 않는다
  }
}

function begin(e: Entry): number {
  const now = Date.now();
  try {
    if (e.running > 0) e.overlaps += 1;
    else e.runningSince = new Date(now).toISOString();
    e.running += 1;
    e.runs += 1;
    e.lastStart = new Date(now).toISOString();
    touch();
  } catch {
    // 기록은 던지지 않는다
  }
  return now;
}

/** `run` 을 부르고 결과를 센다. 던짐과 거부는 기록한 뒤 그대로 내보낸다(직접 건 타이머와 같은 결과). */
function fire(e: Entry, run: () => unknown): void {
  const started = begin(e);
  let r: unknown;
  try {
    r = run();
  } catch (err) {
    finish(e, started, false, err);
    throw err;
  }
  if (r && typeof (r as PromiseLike<unknown>).then === 'function') {
    void (r as Promise<unknown>).then(
      (v) => finish(e, started, true, undefined, v),
      (err) => { finish(e, started, false, err); throw err; },
    );
  } else {
    finish(e, started, true, undefined, r);
  }
}

function stopped(name: string, e: Entry, reason: string): void {
  try {
    e.live = Math.max(0, e.live - 1);
    if (!e.live) {
      e.stoppedAt = new Date().toISOString();
      e.stopReason = safe(reason) ?? 'other';
    }
    touch();
  } catch {
    // 기록은 던지지 않는다
  }
}

function armed(e: Entry): void {
  e.live += 1;
  e.stoppedAt = undefined;
  e.stopReason = undefined;
}

/**
 * 일정한 주기 — `setInterval(run, everyMs)` 와 같다.
 * `unref` 는 지금 그 타이머가 `unref` 하던 곳만 `true` 로 준다.
 */
export function every(opts: { name: string; everyMs: number; run: () => unknown; unref?: boolean }): Task {
  const e = entry(opts.name, 'every', !!opts.unref);
  e.everyMs = opts.everyMs;
  e.dueAt = undefined;
  armed(e);
  const handle = setInterval(() => fire(e, opts.run), opts.everyMs);
  if (opts.unref) (handle as { unref?: () => void })?.unref?.();
  touch();
  let done = false;
  return {
    name: opts.name,
    stop(reason = 'stop') {
      if (done) return;
      done = true;
      clearInterval(handle);
      stopped(opts.name, e, reason);
    },
  };
}

/**
 * 한 번 — `setTimeout(run, ms)` 와 같다. 다시 걸기는 부르는 쪽이 지금처럼 `run` 안에서 한다.
 * 예정 시각(지금 + ms)을 상태 파일에 남겨 점검기가 「예정 시각을 놓침」을 본다.
 */
export function once(opts: { name: string; ms: number; run: () => unknown; unref?: boolean }): Task {
  const e = entry(opts.name, 'once', !!opts.unref);
  e.everyMs = undefined;
  e.dueAt = new Date(Date.now() + Math.max(0, opts.ms)).toISOString();
  armed(e);
  let done = false;
  const handle = setTimeout(() => {
    if (!done) {
      done = true;
      try { e.live = Math.max(0, e.live - 1); } catch { /* 기록은 던지지 않는다 */ }
    }
    fire(e, opts.run);
  }, opts.ms);
  if (opts.unref) (handle as { unref?: () => void })?.unref?.();
  touch();
  return {
    name: opts.name,
    stop(reason = 'stop') {
      if (done) return;
      done = true;
      clearTimeout(handle);
      stopped(opts.name, e, reason);
    },
  };
}

/** 운영 진입점(`index.ts`)만 부른다. 부르지 않으면 상태 파일을 쓰지 않는다. */
export function setStatusFile(file: string | null): void {
  statusFile = file;
  lastWrite = 0;
  touch();
}

/** 지금 기록 — 검사가 본다. */
export function snapshot(): Record<string, Readonly<Entry>> {
  return Object.fromEntries([...entries].map(([k, v]) => [k, { ...v }]));
}

/** 검사 전용 — 기록을 비운다. */
export function resetForTest(): void {
  entries.clear();
  statusFile = null;
  lastWrite = 0;
  dirty = false;
  writeWarned = false;
}

/** 바뀐 것을 표시하고, 마지막으로 쓴 지 30초가 지났으면 쓴다. 장치 자신의 타이머는 두지 않는다. */
function touch(): void {
  dirty = true;
  if (!statusFile) return;
  const now = Date.now();
  if (lastWrite && now - lastWrite < WRITE_EVERY_MS) return;
  write(now);
}

function write(now: number): void {
  const file = statusFile;
  if (!file || !dirty) return;
  lastWrite = now;
  dirty = false;
  try {
    const body = JSON.stringify({
      pid: process.pid,
      bootAt,
      writtenAt: new Date(now).toISOString(),
      tasks: snapshot(),
    }, null, 1);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, body, 'utf-8');
    try {
      fs.renameSync(tmp, file);
    } catch {
      // Windows 에서 점검기가 열고 있으면 이름 바꾸기가 EPERM · EBUSY 로 실패한다 — 덮어쓴다
      fs.writeFileSync(file, body, 'utf-8');
      try { fs.rmSync(tmp, { force: true }); } catch { /* 남아도 다음 회차가 덮는다 */ }
    }
  } catch (err: any) {
    if (!writeWarned) {
      writeWarned = true;
      logger.warn('타이머 상태 파일을 못 썼습니다', { code: safe(err?.code) ?? 'other' });
    }
  }
}
