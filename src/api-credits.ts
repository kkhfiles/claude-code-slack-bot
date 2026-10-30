/**
 * API 크레딧 장부 — 봇 쪽(2026-10-22 사용자 결정). **정본 규칙은 llm-playbook `llm_playbook/credits.py`** 이고 같은 파일을
 * 같은 규약으로 쓴다(`<파일>.lock` 을 `'wx'` 로 잡고 임시 파일에 써서 바꿔 끼움 · `engine-state.ts` 와 같은 잠금).
 *
 * 자동으로 도는 Claude 세션(DM · 예약 일 · 좁은 길 · 달력 판정)은 크레딧이 있는 동안 API 키로 먼저 띄우고, 소진되거나
 * 만료되면 구독으로 띄운다. 새 크레딧은 사람이 `python -m llm_playbook.credits set …` 으로 등록한다.
 *
 * **고르는 규칙**(파이썬과 같다 — 바꾸면 둘을 같이 바꾼다)
 *   - 장부의 `enabled` 가 참일 때만(기본 꺼짐 — 과금 경로를 켜는 것은 사람이 정한다)
 *   - 만료가 이른 키부터 · 못 쓰는 키 = 막힘 표시(서버가 잔액 부족이라 했거나 사람이 막음), 만료일 0시(한국 시각) 지남
 *   - **장부를 못 읽거나 깨졌으면 쓸 키가 없다** — 이상한 장부로 과금 쪽에 가지 않는다(구독으로 띄운다)
 *
 * **쓴 금액은 참고 값이다 — 이 값으로 멈추지 않는다**(2026-10-23 사용자 결정 「실제 값과 같다고 보장이 안 되니 멈추면 중단」).
 * 전에는 결과의 `total_cost_usd`(그 세션의 **누적** 비용, 이어 받은 세션은 옛 비용까지)를 차례마다 통째로 더해 27~29배로
 * 부풀었고, 두 키가 「소진(추정)」으로 잠겨 하루 동안 크레딧을 안 썼다(실제 team $19.34 · max $3.67). 지금은 세션마다
 * 앞 차례보다 늘어난 만큼만 더한다(`turnCost`). 멈추는 신호는 서버의 「credit balance is too low」와 지출 한도(「specified API usage limits」)다(`blockCreditKey`).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Logger } from './logger';
import { engineState, sleepSync, takeLock, type EngineState } from './engine-state';

const logger = new Logger('ApiCredits');

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

/** 쓸 수 있나 — 막힘 · 만료 · 받은 금액 없음만 본다. 쓴 금액(추정)은 안 본다(머리말). */
function usable(rec: KeyRecord, nowMs: number): boolean {
  if (rec.blocked) return false;
  const grant = Number(rec.grant_usd ?? 0);
  const stop = stopAt(rec.expires);
  return grant > 0 && Number.isFinite(stop) && nowMs < stop;
}

/** 지금 쓸 키 — 없으면 null(꺼짐 포함). 만료가 이른 것부터. */
export function pickCreditKey(nowMs: number = Date.now(), file = ledgerFile()): CreditKey | null {
  const st = load(file);
  if (!st || st.enabled !== true) return null;
  const ok = Object.entries(st.keys)
    .filter(([, rec]) => rec && typeof rec === 'object' && usable(rec, nowMs))
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

/** 사용 내역 한 줄에 같이 남길 것 — 세션 번호(같은 세션이 여러 번 더해졌나) · 인증 출처(정말 API 키로 돌았나). */
export interface SpendNote { session?: string | null; auth?: string | null; model?: string | null; caller?: string | null }

/**
 * 사용 내역 — 장부 옆 `<장부 이름>.history.jsonl` 에 더할 때마다 한 줄(파이썬 `credits.record` 와 같은 모양).
 * 2026-10-23: 장부가 하루 $226 을 셌는데 Console 은 $10 이었고, 합계만 있어 누가 더했는지 못 갈랐다. **안 던진다.**
 */
function noteSpend(name: string, usd: number, nowMs: number, file: string, note: SpendNote): void {
  try {
    const d = new Date(nowMs + KST_OFFSET_MS).toISOString().slice(0, 19);
    const line = {
      at: `${d}+09:00`, by: 'bot', pid: process.pid, key: name, usd,
      session: note.session ?? null, auth: note.auth ?? null, model: note.model ?? null, caller: note.caller ?? null,
    };
    fs.appendFileSync(file.replace(/\.json$/, '') + '.history.jsonl', JSON.stringify(line) + '\n');
  } catch (err: any) {
    logger.warn('크레딧 사용 내역을 못 적었습니다', { err: String(err?.message ?? err) });
  }
}

/** 쓴 금액을 더한다(날짜별 합도 · 한국 날짜). */
export function recordCreditSpend(name: string, usd: number, nowMs: number = Date.now(), file = ledgerFile(),
  note: SpendNote = {}): void {
  if (!(usd > 0)) return;
  const day = new Date(nowMs + KST_OFFSET_MS).toISOString().slice(0, 10);
  let added = false;
  // 내역은 장부에 실제로 들어간 뒤에만 — 바꿔 끼우기가 실패하면 내역만 남아 장부와 어긋난다.
  const wrote = mutate((st) => {
    const rec = st.keys[name];
    if (!rec) return;
    added = true;
    rec.spent_usd = Math.round((Number(rec.spent_usd ?? 0) + usd) * 1e6) / 1e6;
    const daily = (rec.daily ??= {});
    daily[day] = Math.round((Number(daily[day] ?? 0) + usd) * 1e6) / 1e6;
  }, file);
  if (wrote && added) noteSpend(name, usd, nowMs, file, note);
}

/** 세션마다 마지막으로 본 누적 비용 — 장부 옆 `<장부 이름>.sessions.json`(봇만 씀). 오래된 것은 걷는다. */
const SESSION_KEEP_MS = 14 * 86_400_000;

function sessionsFile(file: string): string {
  return file.replace(/\.json$/, '') + '.sessions.json';
}

/**
 * 이번 차례에 실제로 쓴 몫 — 결과의 `total_cost_usd` 는 그 세션의 **누적** 비용이다(이어 받은 세션은 옛 차례까지 ·
 * 2026-10-23 실측: 같은 세션이 $44.00 → $44.20 → $46.36 으로 적혀 셋 다 더해졌다). 마지막으로 본 값과의 차이만 낸다.
 *
 * - 처음 보는 세션 — 새로 띄운 것이면 그 값 전부(0 에서 시작했다). **이어 받은 것이면 0** 을 내고 기준만 적는다: 그 누적에
 *   구독으로 돈 옛 차례가 섞여 있어 얼마가 크레딧 몫인지 모른다(조금 덜 세는 쪽을 고름 · 이 값은 참고용)
 * - **같은 프로세스의 둘째 차례부터는 그 프로세스가 앞서 낸 값과의 차이**(`prev`) — 한 프로세스 안의 누적은 줄지 않는다
 * - 다른 프로세스가 앞서 적은 기준과 비교할 때 누적이 줄었으면 0 — 2026-10-30 실측: 한 세션을 두 프로세스가 번갈아
 *   이어 받아 기준이 들쭉날쭉했고, 그전 규칙(「줄었으면 그 값 전부」)이 매번 누적 전체를 더해 실제 $37.08 을 $102.62 로 셌다
 * - 기준 파일을 못 읽거나 못 쓰면 0 — 장부를 부풀리지 않는다
 */
export function turnCost(session: string | null | undefined, cumulative: number, resumed: boolean,
  nowMs: number = Date.now(), file = ledgerFile(), prev?: number): number {
  if (!(cumulative > 0) || !session) return 0;
  const sf = sessionsFile(file);
  let seen: Record<string, { c: number; at: number }> = {};
  try {
    seen = JSON.parse(fs.readFileSync(sf, 'utf-8')) ?? {};
  } catch (err: any) {
    if (err?.code !== 'ENOENT') return 0;
  }
  const last = seen[session]?.c;
  const delta = prev !== undefined ? Math.max(0, cumulative - prev)
    : last === undefined ? (resumed ? 0 : cumulative)
    : Math.max(0, cumulative - last);
  seen[session] = { c: cumulative, at: nowMs };
  for (const [k, v] of Object.entries(seen)) if (!v || nowMs - Number(v.at) > SESSION_KEEP_MS) delete seen[k];
  try {
    const tmp = `${sf}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(seen));
    fs.renameSync(tmp, sf);
  } catch (err: any) {
    logger.warn('세션 누적 비용 기준을 못 적었습니다 — 이번 차례는 안 셉니다', { err: String(err?.message ?? err) });
    return 0;
  }
  return Math.round(delta * 1e6) / 1e6;
}

/** 그 키를 막는다 — 서버가 크레딧 부족 · 키 거부를 냈다. 새로 `set` 하면 풀린다. */
export function blockCreditKey(name: string, why: string, nowMs: number = Date.now(), file = ledgerFile()): void {
  mutate((st) => {
    const rec = st.keys[name];
    if (rec && !rec.blocked) rec.blocked = { why, at: nowMs / 1000 };
  }, file);
  logger.warn('크레딧 키를 막았습니다', { name, why });
}
