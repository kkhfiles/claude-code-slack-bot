/**
 * 한도가 언제 풀리나 — **그 한 값만** 든다.
 *
 * 예전에는 여기에 막힌 요청까지 쌓아 두고 사람에게 「지금 실행 / 마지막 것만 /
 * 버림」을 물었다. **그 목록이 캡처 큐와 어긋났다** — 2026-08/24 의 서버
 * 과부하(529)를 5시간짜리 한도로 잡아 이레를 들고 있는 동안 캡처 큐는 같은
 * 건을 그날 안에 제대로 닫았고, 08/31 에는 이미 끝난 일을 「밀렸다」로 들고
 * 있었다. **같은 일을 하는 목록이 둘이면 한쪽이 조용히 낡는다.**
 *
 * 이제 밀린 것의 정본은 캡처 큐 하나다(`inbox.jsonl`) — 이유를 안 가리고
 * 쌓이며 처리되면 스스로 닫힌다. 여기 남은 몫은 **언제 다시 해 볼지**뿐이다.
 *
 * **왜 파일인가** — 봇이 재시작해도 살아남아야 한다. 안 그러면 기동 드레인이
 * 아직 안 풀린 한도에 곧바로 다시 부딪혀 **시도 횟수만 태운다.**
 */
import * as fs from 'fs';
import * as path from 'path';

/** 검사가 운영 파일을 안 건드리게 자리를 옮길 수 있어야 한다. */
const FILE = process.env.RATE_LIMIT_UNTIL_FILE
  || path.join(__dirname, '..', '.rate-limit-until.json');

/** 한도가 풀리는 시각(epoch 초). 모르면 `null`. */
export function getUntil(): number | null {
  try {
    const v = JSON.parse(fs.readFileSync(FILE, 'utf-8')).until;
    return typeof v === 'number' ? v : null;
  } catch {
    return null;
  }
}

/**
 * 풀리는 시각을 적는다. **늦은 쪽으로만 민다** — 요청이 연달아 막히면 저마다
 * 조금씩 다른 시각을 들고 오는데, 이른 쪽을 잡으면 아직 안 풀린 채로 다시 해
 * 보고 그 자리에서 또 막힌다.
 */
export function setUntil(until: number): void {
  try {
    const now = getUntil();
    if (now && now >= until) return;
    fs.writeFileSync(FILE, JSON.stringify({ until }), 'utf-8');
  } catch {
    /* 안전망이라 실패해도 본 차례를 막지 않는다 — 드레인이 한 번 헛돌 뿐이다 */
  }
}

/** 지금도 막혀 있나. 시각을 모르면 **안 막힌 것으로 본다** — 모른다고 멈추면
 *  한 번 잘못 적힌 값이 드레인을 영영 재운다. */
export function stillBlocked(now = Date.now()): boolean {
  const until = getUntil();
  return until !== null && until * 1000 > now;
}

export function clearUntil(): void {
  try {
    fs.rmSync(FILE, { force: true });
  } catch {
    /* 다음 `setUntil` 이 덮는다 */
  }
}
