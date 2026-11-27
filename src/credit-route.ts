/**
 * API 크레딧 물길 — 봇이 띄우는 Claude 세션을 **어느 돈으로** 띄우나를 정하는 곳은 이 파일 하나다(2026-11-27 사용자 결정 「크레딧물꼬」).
 *
 * **스위치는 장부 하나** — `~/.config/llm-playbook/api-credits.json` 의 물길(`route`: `site` | `all`)과 켜는 문 · 키별 만료 · 막힘.
 * 고르는 판단은 파이썬 한 곳(`python -m llm_playbook.credits pick`)에 있고 봇은 그 답만 받는다 — 만료 · 부여 · 막힘을 여기서 다시
 * 짜지 않는다(2026-10-22 ~ 11-05 의 「크레딧 먼저」는 같은 판단을 TypeScript 로 다시 짜서 두 벌이 어긋났다). 물길을 `site` 로 돌리거나
 * 크레딧을 끄면(`credits off`) `pick` 이 `null` 을 주어 봇의 모든 세션이 저절로 구독으로 간다 — 봇 쪽에서 고칠 곳이 없다.
 *
 * 이 파일이 하는 일:
 * - **고르기** — `pick` 의 답을 들고 있다(60초마다 뒤에서 다시 물음 · 처음 한 번만 기다림). 명령이 실패하거나 시간을 넘기면 `null`(구독)
 * - **환경** — 고른 키의 파일을 읽어 세션 환경에 넣는다(`creditEnv` · 키 값은 로그에 안 찍는다)
 * - **쓴 금액** — 크레딧으로 띄운 세션의 결과마다 늘어난 만큼 `credits record`(차례를 안 붙잡음 · 실패는 WARN)
 * - **크레딧 오류** — 크레딧 소진 · 지출 한도 · 키 거부면 `credits block` 으로 그 키를 막고, **아직 아무것도 내보내지 않았으면 같은 차례를
 *   구독으로 한 번 다시** 띄운다(`creditStream`). 이 오류가 구독 Claude 의 막힘(엔진 상태 `claude`)으로 적히지 않게 하는 곳도 여기다
 *
 * 부르는 곳은 `sdk-handler.ts` 의 `buildOptions`(환경)와 `runQuery`(흐름) 두 자리뿐이다.
 */
import { execFile, spawnSync } from 'child_process';
import { ApiKeyFileError, withApiKey, withoutApiKey } from './child-env';
import { Logger } from './logger';
import { pythonCommand } from './python-command';
import { every, type Task } from './recurring';

const logger = new Logger('CreditRoute');

/** 장부가 고른 키 — 이름과 키 파일 경로(키 값이 아님). */
export interface CreditPick { name: string; keyFile: string }

/**
 * 어느 돈으로 띄우나 — 생략하면 **장부의 물길대로**, `'subscription'` 은 늘 구독(크레딧 오류 뒤 다시 띄울 때),
 * `'api'` 는 크레딧을 명시한 길(월 API 크레딧 칸 `claude-api` · 물길이 `site` 여도 장부가 켜져 있으면 키를 씀).
 */
export type Billing = 'api' | 'subscription' | undefined;

/** 다시 묻는 간격 · 한 번 묻는 시간 상한. */
export const REFRESH_MS = 60_000;
export const ASK_TIMEOUT_MS = 8_000;

/**
 * 파이썬 명령을 부르는 손잡이 — **시험이 바꿔 끼운다**(진짜 장부 · 진짜 키를 안 건드리게). `sync` 면 결과를 바로 돌려준다.
 * 돌려주는 값은 표준 출력 글(실패면 `null`).
 */
export const runner = {
  run(args: string[], sync: boolean): string | null | Promise<string | null> {
    const py = pythonCommand(process.env.CREDIT_ROUTE_PYTHON || 'python');
    const argv = ['-X', 'utf8', '-m', 'llm_playbook.credits', ...args];
    // 파이썬 자식에도 API 키를 안 넘긴다 — 장부 명령은 API 를 안 부른다
    const env = { ...withoutApiKey({ ...process.env }), PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' };
    if (sync) {
      const r = spawnSync(py, argv, { env, encoding: 'utf-8', timeout: ASK_TIMEOUT_MS, windowsHide: true });
      return r.status === 0 ? String(r.stdout ?? '') : null;
    }
    return new Promise((resolve) => {
      execFile(py, argv, { env, encoding: 'utf-8', timeout: ASK_TIMEOUT_MS, windowsHide: true },
        (err, stdout) => resolve(err ? null : String(stdout ?? '')));
    });
  },
};

/** `pick` 의 한 줄을 읽는다 — 모양이 틀리면 `null`(구독). */
export function parsePick(out: string | null): CreditPick | null {
  if (!out) return null;
  const line = out.trim().split(/\r?\n/).filter(Boolean).pop() ?? '';
  try {
    const v = JSON.parse(line);
    if (v && typeof v.name === 'string' && /^[\w.-]+$/.test(v.name) && typeof v.key_file === 'string' && v.key_file) {
      return { name: v.name, keyFile: v.key_file };
    }
  } catch { /* 모양이 틀림 */ }
  return null;
}

/** 물어 둔 답 — `route`(장부의 물길대로) · `forced`(크레딧을 명시한 길 · `pick --credits true`). */
type Flag = 'route' | 'forced';
const cache = new Map<Flag, { pick: CreditPick | null; at: number }>();
/** 이 프로세스가 방금 막은 키 — 장부에 막힘이 적히고 다시 물을 때까지 그 키를 다시 고르지 않는다. */
const justBlocked = new Set<string>();
/** 뒤에서 도는 장부 명령 — 시험이 끝을 기다린다(`settle`). */
const pending = new Set<Promise<unknown>>();
let timer: Task | null = null;

const pickArgs = (flag: Flag): string[] => (flag === 'forced' ? ['pick', '--credits', 'true'] : ['pick']);

function track<T>(p: Promise<T>): Promise<T> {
  pending.add(p);
  void p.finally(() => pending.delete(p));
  return p;
}

function refresh(flag: Flag): Promise<void> {
  return track(Promise.resolve(runner.run(pickArgs(flag), false)).then((out) => {
    cache.set(flag, { pick: parsePick(out), at: Date.now() });
  }, () => { cache.set(flag, { pick: null, at: Date.now() }); }));
}

function startTimer(): void {
  if (timer) return;
  timer = every({ name: 'credit-route', everyMs: REFRESH_MS, unref: true, run: () => Promise.all([...cache.keys()].map(refresh)) });
}

/** 지금 쓸 키 — 처음 한 번은 기다려 묻고, 그 뒤로는 들고 있는 답(60초마다 뒤에서 갱신). 실패 · 시간 초과는 `null`. */
export function currentPick(flag: Flag): CreditPick | null {
  let have = cache.get(flag);
  if (!have) {
    let out: string | null = null;
    try { out = runner.run(pickArgs(flag), true) as string | null; } catch { out = null; }
    have = { pick: parsePick(out), at: Date.now() };
    cache.set(flag, have);
    startTimer();
  } else if (Date.now() - have.at > REFRESH_MS) {
    void refresh(flag);
  }
  return have.pick && !justBlocked.has(have.pick.name) ? have.pick : null;
}

/**
 * 세션 환경 — 장부가 키를 주면 그 키(구독 토큰을 뺌), 아니면 구독(API 키를 뺌). **세션 환경을 정하는 곳은 여기 하나다.**
 *
 * - 크레딧을 명시한 길(`'api'`)에 쓸 키가 없거나 키 파일을 못 읽으면 던진다(`ApiKeyFileError` · 그 칸이 다음 칸으로 넘긴다)
 * - 보통 길은 키 파일을 못 읽으면 이 차례를 구독으로 띄운다(WARN · 장부는 안 고침)
 */
export function creditEnv(base: Record<string, string | undefined>, billing: Billing):
    { env: Record<string, string>; credit: CreditPick | null } {
  const credit = billing === 'subscription' ? null : currentPick(billing === 'api' ? 'forced' : 'route');
  if (billing === 'api' && !credit) throw new ApiKeyFileError('쓸 API 크레딧 키가 없음 — 크레딧 장부');
  if (!credit) return { env: withoutApiKey(base), credit: null };
  try {
    return { env: withApiKey(base, credit.keyFile), credit };
  } catch (err: any) {
    if (billing === 'api') throw err;
    logger.warn('크레딧 키 파일을 못 읽음 — 이 차례는 구독으로 띄웁니다', { key: credit.name, err: String(err?.message ?? err) });
    return { env: withoutApiKey(base), credit: null };
  }
}

/** 그 키를 막는다 — 장부에 적고(뒤에서) 다시 묻는다. 그 사이에는 이 키를 안 고른다. */
export function blockKey(name: string, why: string): void {
  justBlocked.add(name);
  logger.warn('크레딧 키를 막습니다', { key: name, why });
  void track(Promise.resolve(runner.run(['block', '--key', name, '--why', why.slice(0, 160)], false)).then((out) => {
    if (out === null) logger.warn('크레딧 장부에 막힘을 못 적음 — 이 프로세스에서는 계속 안 씀', { key: name });
    return Promise.all([...cache.keys()].map(refresh));
  }).then(() => {
    // 장부가 막힘을 받아 다른 답을 주면 표시를 걷는다(사람이 `set` 으로 다시 열면 그 키를 다시 쓸 수 있게)
    if (![...cache.values()].some((c) => c.pick?.name === name)) justBlocked.delete(name);
  }, () => { /* 다음 회차에 다시 묻는다 */ }));
}

/** 쓴 금액을 적는다 — 차례를 안 붙잡고, 못 적으면 WARN 만. */
export function recordSpend(name: string, usd: number, o: { session?: string; model?: string; caller: string }): void {
  if (!(usd > 0)) return;
  const args = ['record', '--key', name, '--usd', usd.toFixed(6), '--caller', o.caller];
  if (o.session) args.push('--session', o.session);
  if (o.model) args.push('--model', o.model);
  void track(Promise.resolve(runner.run(args, false)).then((out) => {
    if (out === null) logger.warn('크레딧 사용액을 못 적음', { key: name, usd });
  }));
}

/**
 * 세션별 마지막 누적 비용 — `total_cost_usd` 는 그 세션의 **누적**이라 이어 받은 세션은 늘어난 만큼만 더한다
 * (2026-10-23 누적을 그대로 더해 27~29배로 부풀었다). 이 프로세스가 본 적 없는 이어 받은 세션은 크레딧 몫을 몰라 안 센다.
 */
const lastCost = new Map<string, number>();
const LAST_COST_MAX = 500;

export function turnCost(session: string, cumulative: number, resumed: boolean): number {
  if (!(cumulative > 0) || !session) return 0;
  const last = lastCost.get(session);
  lastCost.delete(session);
  lastCost.set(session, cumulative);
  while (lastCost.size > LAST_COST_MAX) lastCost.delete(lastCost.keys().next().value as string);
  const delta = last === undefined ? (resumed ? 0 : cumulative) : Math.max(0, cumulative - last);
  return Math.round(delta * 1e6) / 1e6;
}

// ---------------------------------------------------------------- 크레딧 오류

/**
 * 크레딧 소진 — 「Your credit balance is too low …」 · 「Credit balance too low · Add funds」 — 와 지출 한도
 * 「You have reached your specified API usage limits」. 키 거부 — 「Invalid API key」 · `authentication_error` · 401.
 */
const CREDIT_EXHAUSTED = /credit balance (?:is )?too low|specified API usage limits?\b/i;
const KEY_REJECTED = /invalid (?:x-)?api[ -]key|authentication_error|failed to authenticate|\b401\b/i;
/** SDK 가 대신 만든 API 오류 글의 머리 — 보통 글에 「401」이 나와도 안 잡히게 이 머리나 `error` 칸이 있을 때만 본다. */
const API_ERROR_HEAD = /^\s*API Error: \d{3}\b/;

export function isCreditFailureText(text: string): boolean {
  return CREDIT_EXHAUSTED.test(text) || KEY_REJECTED.test(text);
}

/** 이 이벤트가 크레딧 세션의 크레딧 오류인가 — SDK 가 대신 만든 오류 메시지(`error` 칸)와 오류 결과. */
export function creditFailure(ev: any): boolean {
  if (ev?.type === 'assistant') {
    const err = ev.error;
    if (err === 'billing_error' || err === 'authentication_failed') return true;
    const text = (ev.message?.content ?? []).map((b: any) => b?.text ?? '').join(' ');
    if (!err && !API_ERROR_HEAD.test(text)) return false;
    return isCreditFailureText(text);
  }
  if (ev?.type === 'result' && ev.is_error) return isCreditFailureText(String(ev.result ?? ''));
  return false;
}

/**
 * 도구를 돌린 뒤 크레딧이 끊긴 차례의 결과 글 — 원래 글(「credit balance too low」 · 「usage limits」)을 그대로 두면 엔진 상태가
 * **구독 Claude 의 사용량 소진**으로 적고 DM 사다리가 한도 길로 간다. 보통 오류로 끝나게 한도 낱말이 없는 글로 바꾼다.
 */
export const MIDTURN_FAILURE_TEXT = 'API 크레딧 키가 차례 도중에 거절되어 멈췄습니다 — 그 키를 막았고 다음 차례부터 다른 키나 구독으로 띄웁니다. '
  + '이미 한 일이 있을 수 있어 자동으로 다시 하지 않았습니다.';

const why = (ev: any): string => (ev?.type === 'result'
  ? String(ev.result ?? '')
  : String(ev?.error ?? '') + ' ' + (ev?.message?.content ?? []).map((b: any) => b?.text ?? '').join(' ')).trim().slice(0, 160);

/** 아직 「내보냄」이 아닌 것 — 시작 알림 · 한도 알림 · 훅 같은 시스템 글. 크레딧 오류는 첫 API 호출에서 오므로 그 앞만 들고 있는다. */
const preamble = (ev: any): boolean => ev?.type === 'system' || ev?.type === 'rate_limit_event';

export interface CreditStreamOptions {
  /** 이 차례의 중단 신호 — 구독으로 다시 띄운 세션도 같이 끊는다. */
  signal: AbortSignal;
  /** 이어 받은 세션인가 — 쓴 금액 계산(`turnCost`). */
  resumed: boolean;
  /** 장부 내역의 `caller`. */
  caller: string;
  /**
   * 같은 차례를 구독으로 다시 띄우는 법 — 있으면 보통 길(엔진 `claude`): 내보내기 전의 크레딧 오류는 다시 띄우고, 내보낸 뒤의 것은
   * 한도 낱말 없는 오류로 바꾼다. 없으면 크레딧을 명시한 길(`claude-api`): 키만 막고 이벤트는 그대로 낸다(그 칸이 다음 칸으로 넘긴다).
   */
  retry?: () => { q: AsyncIterable<any>; ac: AbortController };
}

/**
 * 크레딧으로 띄운 세션의 흐름 — 쓴 금액을 적고 크레딧 오류를 가른다. `credit` 이 없으면 그대로 돌려준다.
 *
 * **다시 띄우는 것은 아무것도 내보내기 전뿐이다** — 어시스턴트 글 · 부분 메시지 · 도구 결과가 하나라도 나갔으면 이미 한 일이 있을 수
 * 있어 다시 하면 쓰기가 두 번 들어간다. 그 앞의 시작 알림(`system`)은 들고 있다가 버린다 — 다시 띄운 세션의 시작 알림이 세션 id 를 새로 준다.
 */
export function creditStream(q: AsyncIterable<any>, credit: CreditPick | null, o: CreditStreamOptions): AsyncIterable<any> {
  if (!credit) return q;
  return (async function* () {
    const held: any[] = [];
    let out = false;
    let blocked = false;
    let model: string | undefined;
    const block = (ev: any) => { if (!blocked) { blocked = true; blockKey(credit.name, `bot: ${why(ev) || 'credit failure'}`); } };
    const spend = (ev: any) => {
      if (ev?.type === 'system' && ev.subtype === 'init' && typeof ev.model === 'string') model = ev.model;
      if (ev?.type !== 'result') return;
      const usd = turnCost(String(ev.session_id ?? ''), Number(ev.total_cost_usd ?? 0), o.resumed);
      recordSpend(credit.name, usd, { session: ev.session_id || undefined, model, caller: o.caller });
    };
    const restart = async function* (ev: any): AsyncGenerator<any> {
      block(ev);
      if (o.signal.aborted) return;
      logger.warn('크레딧 오류 — 같은 차례를 구독으로 다시 띄웁니다', { key: credit.name, caller: o.caller });
      const r = o.retry!();
      o.signal.addEventListener('abort', () => r.ac.abort(), { once: true });
      yield* r.q;
    };
    try {
      for await (const ev of q) {
        spend(ev);
        if (!out) {
          if (preamble(ev)) { held.push(ev); continue; }
          if (creditFailure(ev)) {
            if (o.retry) { yield* restart(ev); return; }
            block(ev);
          }
          out = true;
          yield* held.splice(0);
          yield ev;
          continue;
        }
        if (!creditFailure(ev)) { yield ev; continue; }
        block(ev);
        if (!o.retry) { yield ev; continue; }
        // 보통 길에서 내보낸 뒤 — 대신 만든 오류 메시지는 버리고, 결과 글은 한도 낱말 없는 글로
        if (ev.type === 'result') yield { ...ev, result: MIDTURN_FAILURE_TEXT };
      }
      yield* held.splice(0);
    } catch (err: any) {
      const text = String(err?.message ?? err);
      if (!isCreditFailureText(text)) { yield* held.splice(0); throw err; }
      if (!out && o.retry) { yield* restart({ type: 'result', result: text }); return; }
      block({ type: 'result', result: text });
      yield* held.splice(0);
      if (o.retry) throw new Error(MIDTURN_FAILURE_TEXT);
      throw err;
    }
  })();
}

/** 장부 내역의 `caller` — 무엇이 이 세션을 불렀나(부르는 곳마다 옵션을 붙이지 않고 이미 있는 표시로 가른다). */
export function callerOf(o: { billing?: Billing; env?: Record<string, string> }): string {
  if (o.billing === 'api') return 'bot:claude-api';
  const mode = o.env?.ASSISTANT_MODE;
  if (mode && /^[\w-]+$/.test(mode)) return `bot:${mode}`;
  if (o.env?.WORK_ASSISTANT_CAPTURE_FILE) return 'bot:chat';
  return 'bot:session';
}

/** 시험용 — 들고 있는 답과 표시를 지운다. */
export function forget(): void {
  cache.clear();
  justBlocked.clear();
  lastCost.clear();
  if (timer) { timer.stop('forget'); timer = null; }
}

/** 시험용 — 뒤에서 도는 장부 명령이 다 끝날 때까지. */
export async function settle(): Promise<void> {
  while (pending.size) await Promise.allSettled([...pending]);
}
