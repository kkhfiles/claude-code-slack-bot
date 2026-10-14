/**
 * 봇이 띄우는 Claude Code 세션(SDK · CLI 두 길)에 넘길 환경 변수 — **API 키는 늘 뺀다.**
 *
 * 2026-10-14 사용자 결정으로 「API 키로 계속」을 걷었다 — 한도에 걸리면 엔진 폴백과
 * 보류 재실행이 대신한다. 그런데 PC 환경 변수에 키가 남아 있으면 세션이 구독 토큰 대신
 * 그 키로 **말없이 과금된다.** 키를 넣는 길을 지우는 것만으로는 안 막혀서 나가는 문에서 뺀다.
 *
 * 윈도우의 환경 변수 이름은 대소문자를 안 가리므로 대문자로 맞춰 견준다.
 * 두 길이 이 함수를 부르는지는 `npm run check:noaccounts` 가 본다.
 */
export function withoutApiKey(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || k.toUpperCase() === 'ANTHROPIC_API_KEY') continue;
    out[k] = v;
  }
  return out;
}
