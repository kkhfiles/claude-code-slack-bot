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
