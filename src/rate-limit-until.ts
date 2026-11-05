/**
 * 한도가 언제 풀리나 — **옛 이름을 그대로 두는 얇은 층**이다(2026-10-14 엔진 상태로 옮김).
 *
 * 값은 이제 엔진 상태(`engine-state.ts` · `.engine-state.json`)의 Claude 칸에 있다. 옛 파일
 * `.rate-limit-until.json` 은 엔진 상태가 처음 뜰 때 한 번 옮겨 오고 손대지 않는다.
 *
 * 예전에는 여기에 막힌 요청까지 쌓아 두고 사람에게 「지금 실행 / 마지막 것만 / 버림」을 물었다.
 * **그 목록이 캡처 큐와 어긋났다** — 2026-08/24 의 서버 과부하(529)를 5시간짜리 한도로 잡아
 * 이레를 들고 있는 동안 캡처 큐는 같은 건을 그날 안에 제대로 닫았다. **같은 일을 하는 목록이
 * 둘이면 한쪽이 조용히 낡는다.** 밀린 것의 정본은 캡처 큐 하나다(`inbox.jsonl`) — 여기 남은
 * 몫은 **언제 다시 해 볼지**뿐이다.
 */
import { engineState } from './engine-state';

/** 한도가 풀리는 시각(epoch 초). 모르면 `null`. */
export function getUntil(): number | null {
  return engineState.blockedUntil('claude');
}

/**
 * 풀리는 시각을 적는다(사용량 소진). **늦은 쪽으로만 민다** — 요청이 연달아 막히면 저마다
 * 조금씩 다른 시각을 들고 오는데, 이른 쪽을 잡으면 아직 안 풀린 채로 다시 해 보고 또 막힌다.
 */
export function setUntil(until: number): void {
  engineState.recordBlocked('claude', { kind: 'usage', until });
}

/** 지금도 막혀 있나. 시각을 모르면 **안 막힌 것으로 본다** — 모른다고 멈추면 한 번 잘못 적힌
 *  값이 드레인을 영영 재운다. */
export function stillBlocked(now = Date.now()): boolean {
  return engineState.isBlocked('claude', Math.floor(now / 1000));
}

/** 풀렸다 — 막힘을 지운다(된 것과 같다). */
export function clearUntil(): void {
  engineState.recordOk('claude');
}
