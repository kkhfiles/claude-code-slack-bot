/**
 * API 크레딧 장부 — 봇 쪽(2026-10-22 사용자 결정). **정본 규칙은 llm-playbook `llm_playbook/credits.py`** 이고 같은 파일을
 * 같은 규약으로 쓴다(`<파일>.lock` 을 `'wx'` 로 잡고 임시 파일에 써서 바꿔 끼움 · `engine-state.ts` 와 같은 잠금).
 *
 * 자동으로 도는 Claude 세션(DM · 예약 일 · 좁은 길 · 달력 판정)은 크레딧이 있는 동안 API 키로 먼저 띄우고, 소진되거나
 * 만료되면 구독으로 띄운다. 새 크레딧은 사람이 `python -m llm_playbook.credits set …` 으로 등록한다.
 *
 * **고르는 규칙**(파이썬과 같다 — 바꾸면 둘을 같이 바꾼다)
 *   - 장부의 `enabled` 가 참일 때만(기본 꺼짐 — 과금 경로를 켜는 것은 사람이 정한다)
 *   - 만료가 이른 키부터 · 못 쓰는 키 = 막힘 표시 · 만료일 0시(한국 시각) 지남 · 쓴 금액 ≥ 받은 금액 × (1 − 여유)
 *   - **장부를 못 읽거나 깨졌으면 쓸 키가 없다** — 이상한 장부로 과금 쪽에 가지 않는다(구독으로 띄운다)
 *
 * 쓴 금액은 SDK 가 결과에 실어 주는 `total_cost_usd` 다. 서버가 「credit balance is too low」를 내면 그 키를 막는다.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Logger } from './logger';
import { engineState, sleepSync, takeLock, type EngineState } from './engine-state';

const logger = new Logger('ApiCredits');

const DEFAULT_MARGIN = 0.03;
const KST_OFFSET_MS = 9 * 3600 * 1000;
const RECORD_LOCK_WAIT_MS = 3_000;
const REPLACE_TRIES = 25;
const DEFAULT_KEY_FILES: Record<string, string> = {
  max: '~/.config/llm-playbook/.anthropic-api-key',
  team: '~/.config/llm-playbook/.anthropic-api-key-team',
};

export interface CreditKey { name: string; keyFile: string }

interface KeyRecord {
  key_file?: string; grant_usd?: number; expires?: string; spent_usd?: number;
  daily?: Record<string, number>; blocked?: { why: string; at: number } | null; [extra: string]: unknown;
}
interface Ledger { v: number; enabled?: boolean; margin?: number; keys: Record<string, KeyRecord>; [extra: string]: unknown }

export function ledgerFile(): string {
  return process.env.LLM_PLAYBOOK_CREDITS || path.join(os.homedir(), '.config', 'llm-playbook', 'api-credits.json');
}

function expand(p: string): string {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

/** 장부 — 없으면 빈 장부, 깨졌으면 null(쓸 키 없음). */
function load(file = ledgerFile()): Ledger | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch (err: any) {
    return err?.code === 'ENOENT' ? { v: 1, keys: {} } : null;
  }
  try {
    const st = JSON.parse(raw);
    return st && typeof st === 'object' && st.keys && typeof st.keys === 'object' ? st as Ledger : null;
  } catch {
    return null;
  }
}

/** 만료일 → 멈출 시각(그날 0시 한국 시각 · epoch 밀리초). 모양이 틀리면 NaN. */
export function stopAt(expires: string | undefined): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(expires ?? '');
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) - KST_OFFSET_MS : NaN;
}

function usable(rec: KeyRecord, margin: number, nowMs: number): boolean {
  if (rec.blocked) return false;
  const grant = Number(rec.grant_usd ?? 0);
  const stop = stopAt(rec.expires);
  if (!(grant > 0) || !Number.isFinite(stop) || nowMs >= stop) return false;
  return Number(rec.spent_usd ?? 0) < grant * (1 - margin);
}

/** 지금 쓸 키 — 없으면 null(꺼짐 포함). 만료가 이른 것부터. */
export function pickCreditKey(nowMs: number = Date.now(), file = ledgerFile()): CreditKey | null {
  const st = load(file);
  if (!st || st.enabled !== true) return null;
  const margin = Number(st.margin ?? DEFAULT_MARGIN);
  const ok = Object.entries(st.keys)
    .filter(([, rec]) => rec && typeof rec === 'object' && usable(rec, margin, nowMs))
    .sort(([, a], [, b]) => stopAt(a.expires) - stopAt(b.expires));
  if (!ok.length) return null;
  const [name, rec] = ok[0];
  return { name, keyFile: expand(rec.key_file || DEFAULT_KEY_FILES[name] || '') };
}

/**
 * Claude 를 띄울 수 없나 — **구독이 막혔고 크레딧 키도 없을 때만**(2026-10-22). 크레딧이 있으면 그 세션은 API 키로
 * 뜨므로(`sdk-handler.ts` 의 자동 billing) 구독 막힘만 보고 건너뛰면 안 된다. 「띄울지 말지」를 정하는 곳은 이것을 본다.
 */
export function claudeBlocked(store: EngineState = engineState, nowMs: number = Date.now()): boolean {
  return store.isBlocked('claude', Math.floor(nowMs / 1000)) && !pickCreditKey(nowMs);
}

/** 잠그고 읽고 고치고 바꿔 끼운다. 못 하면 WARN 하고 false — **안 던진다**(기록이지 차례의 일부가 아니다). */
function mutate(fn: (st: Ledger) => void, file = ledgerFile()): boolean {
  const lock = `${file}.lock`;
  if (!takeLock(lock, RECORD_LOCK_WAIT_MS)) {
    logger.warn('크레딧 장부 잠금을 못 잡아 기록을 건너뜁니다', { file });
    return false;
  }
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    const st = load(file);
    if (!st) {
      logger.warn('크레딧 장부가 깨져 있어 덮어쓰지 않습니다', { file });
      return false;
    }
    fn(st);
    fs.writeFileSync(tmp, JSON.stringify(st, null, 2), 'utf-8');
    for (let i = 0; i < REPLACE_TRIES; i++) {
      try {
        fs.renameSync(tmp, file);
        return true;
      } catch (err: any) {
        if (err?.code !== 'EPERM' && err?.code !== 'EBUSY' && err?.code !== 'EACCES') throw err;
        sleepSync(20 * (1 + (i % 5)));
      }
    }
    return false;
  } catch (err: any) {
    logger.warn('크레딧 장부를 못 썼습니다', { file, err: String(err?.message ?? err) });
    return false;
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 다음 쓰기가 덮는다 */ }
    try { fs.rmSync(lock, { force: true }); } catch { /* 다음 잡는 쪽이 묵은 것으로 지운다 */ }
  }
}

/** 쓴 금액을 더한다(날짜별 합도 · 한국 날짜). */
export function recordCreditSpend(name: string, usd: number, nowMs: number = Date.now(), file = ledgerFile()): void {
  if (!(usd > 0)) return;
  const day = new Date(nowMs + KST_OFFSET_MS).toISOString().slice(0, 10);
  mutate((st) => {
    const rec = st.keys[name];
    if (!rec) return;
    rec.spent_usd = Math.round((Number(rec.spent_usd ?? 0) + usd) * 1e6) / 1e6;
    const daily = (rec.daily ??= {});
    daily[day] = Math.round((Number(daily[day] ?? 0) + usd) * 1e6) / 1e6;
  }, file);
}

/** 그 키를 막는다 — 서버가 크레딧 부족 · 키 거부를 냈다. 새로 `set` 하면 풀린다. */
export function blockCreditKey(name: string, why: string, nowMs: number = Date.now(), file = ledgerFile()): void {
  mutate((st) => {
    const rec = st.keys[name];
    if (rec && !rec.blocked) rec.blocked = { why, at: nowMs / 1000 };
  }, file);
  logger.warn('크레딧 키를 막았습니다', { name, why });
}
