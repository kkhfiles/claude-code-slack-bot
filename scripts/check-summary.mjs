/**
 * 카드 요약이 돌려받은 글을 어떻게 읽나 — **여기서 틀리면 그날 요약이 통째로
 * 안 들어간다.**
 *
 *   npm run build
 *   npm run check:summary
 *
 * 증상이 조용한 것이 이 자리의 성격이다. 세션은 성공으로 끝나고 비용도 나가고
 * 로그도 남는데, 파싱만 빗나가면 볼트에는 아무것도 안 앉는다 — 판을 열어 보기
 * 전까지 아무도 모른다.
 *
 * **울타리를 관대하게 벗기는 것이 요점이다.** 프롬프트가 코드 울타리를 붙이지
 * 말라고 하지만 붙여 오는 회차는 반드시 생기고, 그때 통째로 버리면 그날치가
 * 사라진다. 반대로 **모양이 아닌 것을 빈 값으로 삼키면** 「형식이 어긋났다」와
 * 「쓸 것이 없다」를 부르는 쪽이 못 가른다.
 */
import './lib/fresh-dist.mjs';
import { parseSummaryReply as P } from '../dist/assistant-scheduler.js';

const fails = [];
const eq = (label, got, want) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    fails.push(`${label}\n    받음 ${JSON.stringify(got)}\n    기대 ${JSON.stringify(want)}`);
  }
};

const TWO = { 'TSK-5': '첫 줄\n둘째 줄', 'TSK-9': '한 줄' };
/** 파이썬에 넘어가는 모양 — 요약은 늘 덩이 안에 든다. */
const WRAP = {
  'TSK-5': { summary: TWO['TSK-5'] },
  'TSK-9': { summary: TWO['TSK-9'] },
};

eq('맨 JSON 을 읽는다', P(JSON.stringify(WRAP)), WRAP);

eq('코드 울타리를 벗긴다',
  P('```json\n' + JSON.stringify(WRAP) + '\n```'), WRAP);

eq('앞뒤 군말이 붙어도 읽는다',
  P('요약 두 건입니다.\n' + JSON.stringify(WRAP) + '\n이상입니다.'), WRAP);

eq('줄바꿈이 그대로 온다',
  P(JSON.stringify(WRAP))['TSK-5'].summary.split('\n').length, 2);

// **글자 하나로 온 것도 받는다** — 요약만 있고 제목이 없던 옛 모양이다. 뜻이
// 어긋나지 않으므로 버리는 것보다 받아 주는 편이 싸다(버리면 그날치가 사라진다).
eq('글자 하나로 와도 받는다', P(JSON.stringify(TWO)), WRAP);

// ⛔ **제목은 안 나른다** (2026-08-26) — 이름을 바꾸는 자리는 프롬프트를 받은
// 세션 하나다. 모델이 옛 프롬프트를 보고 `title` 을 실어 보내도 여기서 버린다:
// 파이썬도 버리지만, 안 닿는 값을 나르면 읽는 사람이 이 길로 흐른다고 읽는다.
eq('제목이 와도 안 싣는다',
  P('{"TSK-5":{"summary":"요약","title":"세미나 결과 정리"}}'),
  { 'TSK-5': { summary: '요약' } });

// **모양이 아니면 `null`** — 빈 객체와 갈라야 부르는 쪽이 다르게 말할 수 있다.
eq('JSON 이 아니면 null', P('요약을 만들지 못했습니다'), null);
eq('빈 글이면 null', P(''), null);
eq('괄호가 거꾸로면 null', P('} 닫힘이 먼저 나오고 {'), null);
eq('망가진 JSON 이면 null', P('{"TSK-5": "안 닫힘'), null);

// 빈 객체는 **모양은 맞고 내용이 없는 것**이라 `null` 이 아니다.
eq('빈 객체는 null 이 아니다', P('{}'), {});

// 모양이 어긋난 값은 **그 칸만 버린다** — 한 칸이 이상하다고 나머지 열한 건을
// 같이 버리면 그날 요약이 통째로 없어진다.
eq('어긋난 덩이만 버린다',
  P('{"TSK-5":{"summary":"삽니다"},"TSK-9":{"title":"제목만"},'
    + '"TSK-3":123,"TSK-1":null,"TSK-2":[]}'),
  { 'TSK-5': { summary: '삽니다' } });

if (fails.length) {
  console.log(`실패 ${fails.length}건\n`);
  for (const f of fails) console.log('  ✗ ' + f);
  process.exitCode = 1;
} else {
  console.log('통과 — 카드 요약 응답 읽기 (맨 JSON · 울타리 · 군말 · 줄바꿈 · '
    + '옛 모양 · 제목 셋 · 모양 아님 넷 · 빈 객체 · 어긋난 덩이)');
}
