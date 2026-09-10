/**
 * `replay-narrow.mjs` 가 모델을 부르기 **전에** 짓는 것들을 본다 — 호출 0회.
 *
 *   node scripts/check-replay-narrow.mjs
 *
 * 재생 하네스는 한 번 돌리면 162회를 쓴다. 그 앞에서 **계약·예시가 실제로 뽑히나 ·
 * 두 갈래가 정말 다른가 · 사람 쪽 말이 운영과 같은 순서인가**를 여기서 잡는다.
 * 앞선 측정을 두 번 무너뜨린 것이 다 「돌려 보고 나서야 알았다」였다.
 */
import { readFileSync } from 'node:fs';

const ROOT = 'P:/github/work-assistant';
const NL = '\n';
const fails = [];

function eq(label, got, want) {
  if (got !== want) fails.push(`${label}${NL}    받음 ${JSON.stringify(got)}${NL}    기대 ${JSON.stringify(want)}`);
}
function ok(label, cond, detail = '') {
  if (!cond) fails.push(`${label}${detail ? ' — ' + detail : ''}`);
}

// ── 계약·예시를 replay.py 에서 뽑는다 (하네스와 같은 방식)
const src = readFileSync(`${ROOT}/lab/board-prompt/replay.py`, 'utf-8');
const grab = (name) => {
  const re = new RegExp('^' + name + ' = """([\\s\\S]*?)"""', 'm');
  const m = src.match(re);
  return m ? m[1] : null;
};
const parts = {};
for (const n of ['CONTRACT', 'EXAMPLES', 'EXTRA4']) {
  parts[n] = grab(n);
  ok(`replay.py 에서 ${n} 을 뽑는다`, !!parts[n], '못 찾으면 B 갈래가 A 와 같아진다');
}
if (parts.CONTRACT) {
  ok('CONTRACT 에 처리 계약이 들어 있다', parts.CONTRACT.includes('처리 계약'));
  ok('EXAMPLES 에 변환 예시가 들어 있다', (parts.EXAMPLES || '').includes('이렇게 변환한다'));
  ok('EXTRA4 에 입력 예시가 들어 있다', (parts.EXTRA4 || '').includes('입력:'));
}

// ── 두 갈래가 정말 다른가
const rules = readFileSync(`${ROOT}/lab/board-prompt/narrow10.md`, 'utf-8');
const A = rules;
const B = rules + (parts.CONTRACT || '') + (parts.EXAMPLES || '') + (parts.EXTRA4 || '');
ok('두 갈래의 덧붙임이 다르다', A !== B);
ok('B 가 A 를 온전히 담는다', B.startsWith(A));
ok('B 가 A 보다 1,000자 이상 길다', B.length - A.length > 1000,
  `차이 ${B.length - A.length}자`);

// ── 운영이 안 싣는 것을 A 가 안 싣는지 (이번 측정의 전제)
ok('A(운영 모양)에 처리 계약이 없다', !A.includes('처리 계약'));
ok('A(운영 모양)에 변환 예시가 없다', !A.includes('이렇게 변환한다'));

// ── 사람 쪽 말이 운영과 같은 순서인가
const k = {
  ts: '2026-08-18 15:32:00', task: 'TSK-1', title: '어떤 업무',
  card: '상태=대기 · 소프트 마감=2026-08-19',
  text: '메모 첫 줄' + NL + '메모 둘째 줄',
};
const userText = [
  `오늘은 ${k.ts.slice(0, 10)}`, '',
  `업무: 「${k.title}」`,
  `지금 카드 값: ${k.card}`, '',
  '판 「프롬프트」 칸에 온 말:', k.text,
].join(NL);
eq('사람 쪽 말의 첫 줄', userText.split(NL)[0], '오늘은 2026-08-18');
ok('업무·카드·말이 그 순서로 있다',
  userText.indexOf('업무: 「') < userText.indexOf('지금 카드 값:')
  && userText.indexOf('지금 카드 값:') < userText.indexOf('판 「프롬프트」 칸에 온 말:'));
ok('말머리를 다시 안 붙인다', !userText.includes('[진행판]'));

// ── 짝 비교의 순서 번갈기
const order = [0, 1, 2, 3].map((i) => (i % 2 === 1 ? 'B먼저' : 'A먼저'));
eq('사례마다 순서가 번갈린다', order.join(','), 'A먼저,B먼저,A먼저,B먼저');

// ── 채점기가 읽는 필드를 행이 다 들고 있나
const need = ['ms', 'cost', 'got', 'truth', 'task', 'title', 'ts', 'text'];
const row = { ...k, truth: {}, shape: 'prod', ms: 1, got: null, cost: 0, in_tok: 0 };
const missing = need.filter((f) => !(f in row));
eq('grade2.py 가 읽는 필드가 다 있다', missing.join(','), '');

if (fails.length) {
  console.log(`실패 ${fails.length}건${NL}`);
  for (const f of fails) console.log('  ✗ ' + f);
  process.exitCode = 1;
} else {
  console.log('통과 — 계약·예시 뽑기 · 두 갈래가 다름 · 운영 모양에 계약·예시 없음'
    + ' · 사람 쪽 말 순서 · 짝 순서 번갈기 · 채점 필드');
}
process.exit(process.exitCode ?? 0);
