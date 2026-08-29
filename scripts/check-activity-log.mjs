/**
 * 활동 기록이 **남의 방 대화를 안 적는지** 잰다.
 *
 *   npm run check:activity
 *
 * 왜 재나 — 슬랙 앱에 message 이벤트 구독을 켜면 **우리가 안 맡은 방의 말까지 들어온다.**
 * 그 원문을 그대로 적고 있었다: 2026-08-27 실측으로 무관한 업무 방 한 곳에서만 110건,
 * 전 봇 합쳐 12,922자였다. 오류도 경고도 안 난다 — 조용히 쌓일 뿐이다.
 *
 * 그날 한 번 고쳤다고 보고했는데 **다른 경로가 계속 적고 있었다.** 물러섬 기록만 막고
 * 길목(`processEvent`)은 안 봤다. 그래서 이 검사를 둔다.
 */
import './lib/fresh-dist.mjs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { redactForeign, tagRooms } = require(path.join(ROOT, 'dist', 'activity-log.js'));

let pass = 0;
const fails = [];
const check = (name, ok, got) => {
  if (ok) { pass++; console.log(`PASS ${name}`); return; }
  fails.push(name);
  console.log(`FAIL ${name} — 받음 ${JSON.stringify(got)}`);
};

const MINE = 'C_MINE';
const FOREIGN = 'C_FOREIGN';
const DM = 'D_ME';
tagRooms('lunch', [MINE]);

const heard = (channel) => ({ 누가: 'U1', 어디: channel, 무엇: 'message', 말: '남의 업무 이야기' });

// --- 안 맡은 방 -------------------------------------------------------------------
{
  const out = redactForeign('lunch', '들음', heard(FOREIGN));
  check('안 맡은 방의 말은 원문이 안 남는다', !('말' in out), out);
  check('대신 몇 글자였는지는 남는다', out.글자수 === '남의 업무 이야기'.length, out);
  check('어느 방·누구인지는 남는다 (몇 번인지 셀 수 있어야 한다)',
    out.어디 === FOREIGN && out.누가 === 'U1', out);
}

// --- 맡은 방 · 1:1 ----------------------------------------------------------------
{
  const out = redactForeign('lunch', '들음', heard(MINE));
  check('맡은 방의 말은 그대로 남는다', out.말 === '남의 업무 이야기', out);
}
{
  const out = redactForeign('lunch', '들음', heard(DM));
  check('1:1 은 그대로 남는다 (우리에게 건 말이다)', out.말 === '남의 업무 이야기', out);
}

// --- 우리에게 건 말은 방을 안 따진다 ------------------------------------------------
// 부름·명령·버튼은 안 맡은 방에서 와도 우리를 향한 말이라 남긴다. 안 남기면 「나 모르게
// 불려서 활동하면 안 된다」를 되짚을 근거가 사라진다.
for (const kind of ['부름받음', '명령', '버튼', '창 제출']) {
  const out = redactForeign('lunch', kind, heard(FOREIGN));
  check(`${kind} 은 안 맡은 방에서도 그대로 남는다`, out.말 === '남의 업무 이야기', out);
}

// --- 방을 안 알려 준 봇 -------------------------------------------------------------
// 모르는 쪽으로 기울일 때는 **안 남기는 편**이 맞다.
{
  const out = redactForeign('없는봇', '들음', heard(MINE));
  check('맡은 방을 안 알려 준 봇은 아무 방도 안 맡은 것으로 본다', !('말' in out), out);
}

// --- 길목이 이 함수를 실제로 쓰는가 --------------------------------------------------
// 순수 함수만 맞고 길목이 안 부르면 아무것도 안 막힌다 — 그게 이번에 겪은 그대로다.
const src = require('node:fs').readFileSync(path.join(ROOT, 'src', 'activity-log.ts'), 'utf-8');
const wired = /processEvent[\s\S]{0,600}?redactForeign\(/.test(src);
check('들어오는 말을 적는 길목이 이 함수를 거친다', wired);
const registers = /tagRooms\(this\.opts\.name/.test(
  require('node:fs').readFileSync(path.join(ROOT, 'src', 'chat-host.ts'), 'utf-8'));
check('대화 봇이 맡은 방을 알려 준다', registers);

console.log(`\n통과 ${pass} / 실패 ${fails.length}`);
if (fails.length) process.exitCode = 1;
