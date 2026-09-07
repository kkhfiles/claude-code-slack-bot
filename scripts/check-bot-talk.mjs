/**
 * 봇끼리 대화 굴레 검사 — **세는 자리를 실제로 돌려 본다.**
 *
 *   npm run check:bottalk
 *
 * 왜 소스를 읽는 검사로 안 하나 — 여기서 틀리면 증상이 「무한 반복」이다. 봇 둘이
 * 서로를 부르면 조용한 시간·하루 한도가 통째로 건너뛰어지므로, 이 셈이 안 물면
 * 사람이 「그만」을 치는 사이에도 계속 오가고 외부 모델 할당량이 그 속도로 탄다.
 * 「상한을 적어 뒀다」와 「상한이 문다」는 다른 말이라, 눈으로 무는 것을 봐야 한다.
 *
 * 기록 폴더를 임시 자리로 돌려 놓고 돈다 — 검사가 진짜 활동 기록에 줄을 남기면
 * 돌지도 않은 대화가 돈 것처럼 보인다.
 */
import './lib/fresh-dist.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bottalk-'));
process.env.BOT_ACTIVITY_DIR = tmp;

const { ChatHost } = await import('../dist/chat-host.js');

let pass = 0;
const fails = [];
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log(`PASS ${name}`); return; }
  fails.push(name);
  console.log(`FAIL ${name}`);
  if (detail !== undefined) console.log(`     ${JSON.stringify(detail)}`);
};

const ROOM = 'C_TEST';
const make = (rule) => new ChatHost({
  name: 'check', botToken: '', appToken: '', python: '', script: '',
  surfaces: ['channel'], channels: [ROOM], botTalk: rule,
});

// --- 굴레를 안 켰으면 봇 말은 통째로 안 듣는다 -----------------------------------
check('안 켜면 봇이 한 말은 한 번도 안 받는다',
  make(null)['botTalkTurn'](ROOM, '안녕') === null);

// --- 오간 말을 통째로 센다 -------------------------------------------------------
// **각자는 상대 말만 받는다.** 그것만 세면 스무 번을 셌을 때 방에는 마흔 마디가
// 지나간 뒤다 — 실제 길이의 절반만 보고 끊는 셈이라, 상대 말 하나를 둘로 센다.
const h = make({ softTurns: 10, hardTurns: 20 });
const said = [];
for (let i = 1; i <= 15; i++) said.push(h['botTalkTurn'](ROOM, `말${i}`));

check('넉 번째까지는 그냥 넘긴다 — 여덟 마디 (한마디 안 붙는다)',
  said.slice(0, 4).every((s) => s && !s.includes('마무리')), said.slice(0, 4));
check('다섯 번째에 열 마디가 되어 마무리하라고 이른다',
  said[4]?.includes('마무리하세요'), said[4]);
check('그 뒤로도 계속 이른다',
  said.slice(4, 10).every((s) => s && s.includes('마무리하세요')));
// **이 한마디는 형제가 한 말 바로 뒤에 붙는다** — 줄을 그어 떼어 놓고 옮겨 적지 말라고
// 못을 박지 않으면, 형제가 그렇게 말한 줄 알거나 그대로 베껴서 방에 찍는다(실측 선례 있음).
check('앞말과 줄을 그어 떼어 놓는다', said[4]?.includes('\n---\n'), said[4]);
check('옮겨 적지 말라고 못을 박는다', said[4]?.includes('옮겨 적지 마세요'), said[4]);
check('열한 번째부터 끊는다 — 스무 마디는 살아 있고 스물둘부터 끊긴다',
  said[9] !== null && said[10] === null && said[14] === null,
  { 스무마디: said[9] && '있음', 스물둘: said[10], 그뒤: said[14] });

// --- 사람이 한 마디 하면 처음으로 돌아간다 --------------------------------------
h['humanSpoke'](ROOM, '둘이 뭐 하니');
const after = h['botTalkTurn'](ROOM, '다시');
check('사람이 말하면 셈이 처음으로 돌아간다',
  after === '다시', after);

// --- 방마다 따로 센다 ------------------------------------------------------------
// 이르는 문턱은 안 걸리게 높이 둔다 — 여기서 보려는 것은 **방이 서로 안 섞이는가**다.
const h2 = make({ softTurns: 100, hardTurns: 4 });
for (let i = 0; i < 3; i++) h2['botTalkTurn']('C_A', 'a');
check('한 방이 끊겨도 다른 방은 멀쩡하다',
  h2['botTalkTurn']('C_A', 'a') === null && h2['botTalkTurn']('C_B', 'b') === 'b');

// --- 사람이 치는 멈춤·풀기 ------------------------------------------------------
const h3 = make({ softTurns: 10, hardTurns: 20 });
h3['humanSpoke'](ROOM, '자 이제 그만');
check('사람이 그만하라면 그 자리에서 막는다',
  h3['botTalkTurn'](ROOM, '그래도 한마디') === null);
h3['humanSpoke'](ROOM, '심심한데 다시 해봐');
check('다시 하라면 풀린다 (재시작해야 풀리면 안 된다)',
  h3['botTalkTurn'](ROOM, '네') === '네');

// **멈춘 방에서도 사람에게는 답한다** — 막는 것은 봇끼리지 사람이 아니다.
const h4 = make({ softTurns: 10, hardTurns: 20 });
h4['humanSpoke'](ROOM, '그만');
h4['humanSpoke'](ROOM, '점심 뭐 먹지');
check('멈춘 뒤에도 사람 말은 셈에 안 걸린다 (봇끼리만 막는다)',
  h4['hushed'].has(ROOM) && h4['botTurns'].get(ROOM) === undefined);

// --- 「그만」은 먼저 끼어드는 것도 멈춘다 -----------------------------------------
// 봇끼리만 막던 것을 넓혔다(2026-09-07). 먼저 끼어드는 길이 둘(낱말·훑기)이라
// 세는 자리 한 곳에서 물려야 한쪽으로 안 샌다.
const h5 = new ChatHost({
  name: 'check', botToken: '', appToken: '', python: '', script: '',
  surfaces: ['channel'], channels: [ROOM],
  buttIn: { quietMinutes: 0, dailyCap: 100, sweepMinutes: 0 },
});
h5['selfUserId'] = 'UBOT';
check('그만하기 전에는 먼저 끼어든다', h5['withinLimits'](ROOM) === true);

// **지나가는 말은 안 듣는다.** 낱말은 「그만큼 맛있었어요」·「오늘 그만 먹을래」에도
// 걸린다. 봇끼리 대화를 끊는 데는 오탐이 나도 손해가 없지만, 이것으로 봇을 재우면
// 아무도 청한 적 없는데 조용해지고 사람 눈에는 고장으로 보인다.
h5['humanSpoke'](ROOM, '어제 그만큼 시켰는데 남았어');
check('지나가는 말에는 안 멈춘다 (부르지 않은 「그만」)',
  h5['withinLimits'](ROOM) === true);
h5['humanSpoke'](ROOM, '오늘은 그만 먹을래');
check('점심 이야기에도 안 멈춘다', h5['withinLimits'](ROOM) === true);

h5['humanSpoke'](ROOM, '<@UBOT> 이제 그만');
check('부른 턴에 그만하라면 먼저 끼어드는 것을 멈춘다',
  h5['withinLimits'](ROOM) === false);
h5['humanSpoke'](ROOM, '다시 얘기해');
check('푸는 것은 부르지 않아도 된다 (잘못 재워졌을 때 깨울 길이 있어야 한다)',
  h5['withinLimits'](ROOM) === true);

// 봇끼리 멈추는 쪽은 그대로 느슨하다 — 봇 둘이 주고받을 때 누구든 한마디로 끊는다.
const h6 = make({ softTurns: 10, hardTurns: 20 });
h6['humanSpoke'](ROOM, '그만');
check('봇끼리 멈추기는 부르지 않아도 듣는다 (안전 밸브)',
  h6['botTalkTurn'](ROOM, '한마디') === null);

// --- 기록이 진짜 자리로 새지 않았나 ---------------------------------------------
check('검사가 진짜 활동 기록을 안 건드렸다',
  fs.readdirSync(tmp).every((f) => f === '읽기전.md' || f.startsWith('check-')),
  fs.readdirSync(tmp));

fs.rmSync(tmp, { recursive: true, force: true });

console.log('\n' + '='.repeat(52));
console.log(`통과 ${pass} / 실패 ${fails.length}`);
if (fails.length) { fails.forEach((f) => console.log(`  - ${f}`)); process.exitCode = 1; }
else console.log('모두 통과.');
