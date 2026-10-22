/**
 * 예약 세션을 띄우기 전에 토큰이 그 세션보다 오래 사는지 본다 — 아니면 갱신될 때까지 기다린다(2026-10-22).
 *
 * 구독 토큰은 8시간마다 바뀐다. 봇은 토큰을 따로 갱신하지 않고 터미널이 갱신한 것을 받아 오기만 하는데
 * (`account-manager.ts` 「터미널 보호」), 세션은 띄울 때 받은 토큰을 환경 변수로 쥔 채 돈다. 그래서 세션이
 * 도는 도중에 갱신이 오면 옛 토큰이 폐기되어 다음 호출이 「OAuth token revoked」로 넘어진다. 10/19 부터 갱신이
 * 22:07~22:16 에 떨어져 22:00 분석이 사흘 내리 쓰기 도구를 돌린 뒤 끊겼다.
 *
 * 규칙 — 세션 상한(`maxDurationMs`) 안에 토큰이 끝나면 띄우지 않고 기다린다. 「새 토큰이 상한보다 오래 삶」이 되면
 * 띄우고, 만료 + `GRACE_MS` 까지 안 바뀌면 그대로 띄운다(멈추지 않는다). 토큰을 고르고 갱신하는 것은 부르는 쪽
 * (`refresh` — 터미널 토큰을 받아 오고, 터미널이 없으면 봇이 갱신함)이 한다. 여기는 기다리기만 한다.
 */
export const TOKEN_WAIT_POLL_MS = 30_000;
export const TOKEN_WAIT_GRACE_MS = 10 * 60_000;

export interface TokenWaitDeps {
  /** 지금 토큰의 만료 시각(epoch 밀리초) — 모르면 null(기다리지 않는다). */
  expiresAt: () => number | null;
  /** 터미널 토큰을 받아 오고 필요하면 갱신한다 — 실패해도 던지지 않는다. */
  refresh: () => Promise<void>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  graceMs?: number;
  /** 기다리기 시작할 때 한 번 — 로그용. */
  onWait?: (expiresInMs: number) => void;
}

export type TokenWaitResult = 'enough' | 'unknown' | 'refreshed' | 'gave-up';

export async function waitForFreshToken(spanMs: number | undefined, d: TokenWaitDeps): Promise<TokenWaitResult> {
  const now = d.now ?? Date.now;
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const exp = d.expiresAt();
  if (!spanMs || exp === null) return 'unknown';
  if (exp - now() >= spanMs) return 'enough';
  const deadline = exp + (d.graceMs ?? TOKEN_WAIT_GRACE_MS);
  d.onWait?.(exp - now());
  while (now() < deadline) {
    await sleep(d.pollMs ?? TOKEN_WAIT_POLL_MS);
    try { await d.refresh(); } catch { /* 받아 오기 실패 — 다음에 다시 본다 */ }
    const next = d.expiresAt();
    if (next !== null && next - now() >= spanMs) return 'refreshed';
  }
  return 'gave-up';
}
