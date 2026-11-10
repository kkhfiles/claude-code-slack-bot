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
  /** 밑의 `setInterval` · `setTimeout` 핸들 — 시험이 가짜 타이머 장부와 대조할 때만 쓴다. */
  readonly handle: unknown;
  /** 타이머를 지운다. `reason` 은 상태 파일에 남는다 — `reload`(설정 다시 읽기) · `stop`(기능 끔) 등. */
  stop(reason?: string): void;
}

interface Entry {
  kind: 'every' | 'once';
  everyMs?: number;
  dueAt?: string;
  unref: boolean;
  runs: number;
  /** 연속 실패 — 성공하면 0. 점검기의 「연속 실패」 판정이 본다. */
  fails: number;
  /** 누적 실패 — 이 기동에서 실패한 회차 수. 이력 파일로 실패 빈도를 센다. */
  failsTotal: number;
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
/** 이미 거부를 다시 낸 Promise — `fire` 가 본다. */
const rethrown = new WeakSet<object>();
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
    e = { kind, unref, runs: 0, fails: 0, failsTotal: 0, overlaps: 0, running: 0, maxMs: 0, live: 0 };
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
    if (!ok) e.failsTotal += 1;
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
    // 거부는 Promise 하나당 한 번만 다시 낸다 — `run` 이 회차마다 같은 Promise 를 돌려주는 곳(처리 제안의
    // `pumping`)에서 회차 수만큼 처리 안 된 거부가 늘지 않게. 두 번째부터는 기록만 한다.
    const first = !rethrown.has(r as object);
    if (first) rethrown.add(r as object);
    void (r as Promise<unknown>).then(
      (v) => finish(e, started, true, undefined, v),
      (err) => { finish(e, started, false, err); if (first) throw err; },
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
    handle,
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
  // 숫자가 아닌 대기(NaN · Infinity)도 `setTimeout` 은 1ms 로 받는다 — 기록이 그 앞에서 던지지 않게 거른다
  e.dueAt = Number.isFinite(opts.ms) ? new Date(Date.now() + Math.max(0, opts.ms)).toISOString() : undefined;
  armed(e);
  let done = false;
  let fired = false;
  const handle = setTimeout(() => {
    if (!done) {
      done = true;
      fired = true;
      try { e.live = Math.max(0, e.live - 1); } catch { /* 기록은 던지지 않는다 */ }
    }
    fire(e, opts.run);
  }, opts.ms);
  if (opts.unref) (handle as { unref?: () => void })?.unref?.();
  touch();
  return {
    name: opts.name,
    handle,
    stop(reason = 'stop') {
      // 이미 울린 예약을 지우면 셀 것은 없지만 까닭은 남긴다 — 도는 사이 설정에서 그 기능을 꺼
      // 끝난 회차가 다시 안 걸면, 까닭이 없을 때 점검기가 「사라진 타이머」로 잡는다(2부 2번).
      // 다시 걸면 `armed` 가 지운다.
      if (fired) { fired = false; noteStop(e, reason); return; }
      if (done) return;
      done = true;
      clearTimeout(handle);
      stopped(opts.name, e, reason);
    },
  };
}

function noteStop(e: Entry, reason: string): void {
  try {
    if (e.live) return;
    e.stoppedAt = new Date().toISOString();
    e.stopReason = safe(reason) ?? 'other';
    touch();
  } catch {
    // 기록은 던지지 않는다
  }
}

interface ConfigState { at: string; ok: boolean; code?: string }
let configLoad: ConfigState | undefined;

/**
 * 설정을 읽은 결과를 남긴다 — 실패하면 앞 설정과 예약을 그대로 두므로 겉으로는 멀쩡해 보인다.
 * 점검기가 상태 파일의 `config` 로 「설정 읽기 실패」를 본다. `code` 는 정해진 글자만 담는다.
 */
export function noteConfig(ok: boolean, code?: string): void {
  try {
    configLoad = { at: new Date().toISOString(), ok, ...(ok ? {} : { code: safe(code) ?? 'other' }) };
    touch();
  } catch {
    // 기록은 던지지 않는다
  }
}

/** 마지막 설정 읽기 결과 — 검사가 본다. */
export function configState(): Readonly<ConfigState> | undefined {
  return configLoad ? { ...configLoad } : undefined;
}

/** 운영 진입점(`index.ts`)만 부른다. 부르지 않으면 상태 파일을 쓰지 않는다. */
export function setStatusFile(file: string | null): void {
  if (file) keepPrevious(file);
  statusFile = file;
  lastWrite = 0;
  touch();
}

const HISTORY_KEEP = 60;

/**
 * 앞 봇이 남긴 상태 파일을 같은 폴더의 `bot-timers-history/` 에 복사한다 — 기동마다 덮여 관찰 자료가
 * 안 남던 것(2026-11-04~09 재시작 14회 · 2부 재검토). **옮기지 않고 복사한다** — 옮기면 새 봇이 못 쓸 때
 * 파일이 없어져 점검기의 「뜬 지 N분인데 상태 파일에 안 씀」이 「판단 불가」로 바뀐다.
 * 이름은 앞 봇의 기동 시각 + pid(12초 간격 재시작도 안 겹침). 자기 pid 파일은 안 넣는다. 최근 60개만 둔다.
 * 쓰기가 30초 간격이라 앞 봇의 마지막 30초 안쪽은 빠진다. 기록은 던지지 않는다.
 */
function keepPrevious(file: string): void {
  try {
    const prev = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!prev || prev.pid === process.pid || typeof prev.bootAt !== 'string') return;
    const name = `${safe(prev.bootAt.replace(/:/g, '-')) ?? 'other'}-${Number(prev.pid) || 0}.json`;
    const dir = path.join(path.dirname(file), 'bot-timers-history');
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(file, path.join(dir, name));
    const all = fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort();
    for (const old of all.slice(0, Math.max(0, all.length - HISTORY_KEEP))) {
      fs.rmSync(path.join(dir, old), { force: true });
    }
  } catch {
    // 앞 파일이 없거나 못 읽으면 그만 — 기록은 던지지 않는다
  }
}

/** 지금 기록 — 검사가 본다. */
export function snapshot(): Record<string, Readonly<Entry>> {
  return Object.fromEntries([...entries].map(([k, v]) => [k, { ...v }]));
}

/** 검사 전용 — 기록을 비운다. */
export function resetForTest(): void {
  entries.clear();
  configLoad = undefined;
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
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    const body = JSON.stringify({
      pid: process.pid,
      bootAt,
      writtenAt: new Date(now).toISOString(),
      ...(configLoad ? { config: configLoad } : {}),
      tasks: snapshot(),
    }, null, 1);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, body, 'utf-8');
    try {
      fs.renameSync(tmp, file);
    } catch {
      // Windows 에서 점검기가 열고 있으면 이름 바꾸기가 EPERM · EBUSY 로 실패한다 — 덮어쓴다
      fs.writeFileSync(file, body, 'utf-8');
    }
  } catch (err: any) {
    if (!writeWarned) {
      writeWarned = true;
      logger.warn('타이머 상태 파일을 못 썼습니다', { code: safe(err?.code) ?? 'other' });
    }
  } finally {
    // 임시 파일은 어느 갈래로 끝나도 지운다 — 남기면 재시작으로 pid 가 바뀔 때마다 하나씩 쌓인다
    try { fs.rmSync(tmp, { force: true }); } catch { /* 지울 수 없으면 그만 */ }
  }
}
