/**
 * Shared rate limit detection utilities.
 * Used by slack-handler (user sessions), assistant-scheduler, and calendar-poller.
 */

const RATE_LIMIT_PATTERN = /rate.?limit|overloaded|429|too many requests|capacity|usage limit|spending.?cap|hit your limit|resets\s+\d{1,2}\s*(am|pm)/i;

export function isRateLimitText(text: string): boolean {
  return RATE_LIMIT_PATTERN.test(text);
}

/** `isSessionRateLimited` 가 보는 것 — 세션 하나의 결말. */
export interface LimitVerdictInput {
  /** `rate_limit_event.status === 'rejected'` 로 세운 구조화 신호. */
  rateLimited?: boolean;
  /** result 이벤트의 `is_error`. */
  isError?: boolean;
  /** 세션의 마지막 응답 본문. */
  text?: string;
}

/**
 * 이 세션이 **바깥 한도**에 막혔나 — 판정은 여기 한 곳에서만 한다.
 *
 * **정상 완료한 세션의 본문은 보지 않는다.** 예전에는 세 곳이 제각각
 * `isRateLimitText(result.text)` 를 불렀는데, 이 봇이 돌리는 분석의 주제가
 * 「사용량·한도·실패」라 보고서가 잘 나올수록 `429`·`usage limit` 이 요약문에
 * 들어간다. 그래서 2026-05-22~08-22 사이 13번을 오탐했고(전부 `subtype: success`,
 * 보고서도 이미 나온 뒤였다) 그때마다 그룹 뒤쪽 분석이 통째로 날아갔다.
 * 감지 어휘와 분석 주제가 같은 공간을 쓰는 한 정규식을 다듬어도 안 갈린다.
 *
 * 텍스트 검사는 **에러일 때만** 연다 — 구조화 신호가 없던 옛 CLI 응답을 위한
 * 뒷문이고, 정상 완료에는 닿지 않는다.
 *
 * **자기 예산 상한(`error_max_budget_usd`)은 여기 안 넣는다.** 그건 스스로 건
 * 값이라 「막혔다」와 뜻이 다르고, 부르는 쪽마다 대응이 갈린다(분석은 재시도,
 * 브리핑은 있는 만큼 전달).
 */
export function isSessionRateLimited(r: LimitVerdictInput): boolean {
  if (r.rateLimited === true) return true;
  return r.isError === true && isRateLimitText(r.text ?? '');
}

export function isRateLimitError(error: any): boolean {
  const msg = error?.message || '';
  return isRateLimitText(msg);
}

// --- 엔진 상태에 적을 판정 (2026-10-14) ---------------------------------------
//
// 위 판정은 「막혔나」만 가른다. 엔진 상태(`engine-state.ts`)는 **무엇에 막혔나**까지 알아야
// 다시 해 볼 시각을 정한다 — 사용량 소진은 서버가 알려 준 시각까지, 과부하는 10분부터.
// 이 둘을 한 갈래로 묶었던 것이 2026-08-24 에 과부하를 5시간 들고 있던 까닭이다.

/**
 * 사용량 소진. 봇 로그에 실제로 온 글 —
 * 「You've hit your session limit · resets 4:10pm (Asia/Seoul)」 ·
 * 「You've hit your limit · resets 1pm (Asia/Seoul)」 ·
 * 「You've hit your weekly limit · resets Oct 5, 10am (Asia/Seoul)」.
 */
const USAGE_PATTERN = /hit your (?:[a-z]+ )?limit|usage limit|session limit|weekly limit|spending.?cap/i;
/** 서버 과부하 — 「API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment.」 */
const OVERLOAD_PATTERN = /overloaded|\b529\b|capacity/i;
/**
 * 그 밖의 빈도 제한 — 「429 {"type":"error","error":{"type":"rate_limit_error","message":"This request
 * would exceed your account's rate limit. Please try again later."}}」. 풀리는 시각이 없어 사용량
 * 소진으로 적되 한 시간 뒤에 다시 본다(`engine-state.ts` `REPROBE_SEC`).
 */
const RATE_PATTERN = /rate.?limit|too many requests|\b429\b|resets\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)/i;

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** 그 시각대가 UTC 보다 몇 밀리초 앞서나. 시각대를 모르면 이 PC 의 것을 쓴다. */
function tzOffsetMs(tz: string | undefined, atMs: number): number {
  const local = -new Date(atMs).getTimezoneOffset() * 60_000;
  if (!tz) return local;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric',
    } as Intl.DateTimeFormatOptions).formatToParts(new Date(atMs));
    const g = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    const asUtc = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second'));
    return asUtc - Math.floor(atMs / 1000) * 1000;
  } catch {
    return local;
  }
}

/**
 * 글에 적힌 「풀리는 시각」을 epoch 초로. 못 읽으면 `null`.
 *
 * - `resets 4:10pm (Asia/Seoul)` · `resets 1pm` — 오늘 그 시각, 이미 지났으면 내일
 * - `resets Oct 5, 10am (Asia/Seoul)` — 그 날짜(하루 넘게 지났으면 내년)
 * - `retry after 30` (초) · `in 5 minutes`
 */
export function parseResetAt(text: string, nowMs: number = Date.now()): number | null {
  const m = text.match(/resets\s+(?:([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)(?:\s*\(([^)]+)\))?/i);
  if (m) {
    const [, mon, day, hh, mm, ampm, tz] = m;
    const off = tzOffsetMs(tz?.trim(), nowMs);
    const wall = new Date(nowMs + off);
    const hour = (Number(hh) % 12) + (ampm.toLowerCase() === 'pm' ? 12 : 0);
    const min = mm ? Number(mm) : 0;
    const year = wall.getUTCFullYear();
    const mi = mon ? MONTHS.indexOf(mon.toLowerCase()) : -1;
    if (mi >= 0) {
      let t = Date.UTC(year, mi, Number(day), hour, min) - off;
      if (t <= nowMs - 86_400_000) t = Date.UTC(year + 1, mi, Number(day), hour, min) - off;
      return Math.floor(t / 1000);
    }
    let t = Date.UTC(year, wall.getUTCMonth(), wall.getUTCDate(), hour, min) - off;
    if (t <= nowMs) t += 86_400_000;
    return Math.floor(t / 1000);
  }
  const after = text.match(/retry.?after[:\s]+(\d+)/i);
  if (after) return Math.floor(nowMs / 1000) + Number(after[1]);
  const inN = text.match(/(?:in|after)\s+(\d+)\s*(seconds?|minutes?|hours?)\b/i);
  if (inN) {
    const unit = inN[2].toLowerCase().startsWith('h') ? 3600 : inN[2].toLowerCase().startsWith('m') ? 60 : 1;
    return Math.floor(nowMs / 1000) + Number(inN[1]) * unit;
  }
  return null;
}

/** `rate_limit_event` 하나의 판정 — 막힘(있으면)과 사용률(실려 왔으면). */
export interface ClaudeEventVerdict {
  block: { kind: 'usage'; until?: number; limitType?: string } | null;
  util?: { limitType: string; utilization: number };
}

/**
 * `rate_limit_event` 를 가른다. **`rejected` 만 막힘이다** — `allowed_warning` 은 한도에 가까워졌다는
 * 예고일 뿐 요청은 통과했다. 곁의 `overageStatus` 는 안 본다(정액 초과분 거절이라 `allowed` 와
 * 함께 늘 온다).
 */
export function classifyClaudeEvent(ev: any): ClaudeEventVerdict {
  const info = ev?.rate_limit_info ?? ev ?? {};
  const util = typeof info.utilization === 'number' && typeof info.rateLimitType === 'string'
    ? { limitType: info.rateLimitType, utilization: info.utilization } : undefined;
  if (info.status !== 'rejected') return { block: null, ...(util ? { util } : {}) };
  return {
    block: {
      kind: 'usage',
      ...(typeof info.resetsAt === 'number' ? { until: info.resetsAt } : {}),
      ...(typeof info.rateLimitType === 'string' ? { limitType: info.rateLimitType } : {}),
    },
    ...(util ? { util } : {}),
  };
}

/**
 * 오류 글을 가른다 — 사용량 소진(`usage` · 풀리는 시각을 읽으면 `until`)인가, 서버 과부하
 * (`overload` · 시각은 엔진 상태가 정한다)인가. 둘 다 아니면 `null`.
 *
 * **오류 글에만 쓴다** — 정상으로 끝난 세션의 본문은 넣지 않는다(`isSessionRateLimited` 와 같은 까닭:
 * 이 봇이 돌리는 분석의 주제가 「사용량·한도」라 보고서 본문에 그 낱말이 들어간다).
 * 「hit your … limit」을 과부하보다 먼저 본다 — 그 글이 있으면 서버가 계정을 막은 것이 확실하다.
 */
export function classifyClaudeErrorText(
  text: string, nowMs: number = Date.now(),
): { kind: 'usage' | 'overload'; until?: number } | null {
  if (!text) return null;
  if (USAGE_PATTERN.test(text) || (!OVERLOAD_PATTERN.test(text) && RATE_PATTERN.test(text))) {
    const until = parseResetAt(text, nowMs);
    return until !== null ? { kind: 'usage', until } : { kind: 'usage' };
  }
  if (OVERLOAD_PATTERN.test(text)) return { kind: 'overload' };
  return null;
}
