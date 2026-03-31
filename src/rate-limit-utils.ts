/**
 * Shared rate limit detection utilities.
 * Used by slack-handler (user sessions), assistant-scheduler, and calendar-poller.
 */

const RATE_LIMIT_PATTERN = /rate.?limit|overloaded|429|too many requests|capacity|usage limit|spending.?cap|hit your limit|resets\s+\d{1,2}\s*(am|pm)/i;

export function isRateLimitText(text: string): boolean {
  return RATE_LIMIT_PATTERN.test(text);
}

export function isRateLimitError(error: any): boolean {
  const msg = error?.message || '';
  return isRateLimitText(msg);
}
