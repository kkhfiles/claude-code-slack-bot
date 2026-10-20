/**
 * 「대답하지 마」 모델 판정 검사(`HUSH_JUDGE`) — 모델 대신 판정 결과를 바꿔 끼워, 호스트가 그 결과로 맞게 움직이나.
 *
 *   npm run check:hushjudge
 *
 * 왜 재나 — 2026-10-20 실장 「규칙으로 하지 말고 가장 싼 모델로」. 낱말 규칙은 「@커피콩 넌 지금은 신경 안써도 돼」를 놓쳤다.
 * 판정은 `chatbot/hush.py` 가 하고(모델 시험은 그쪽), 여기서는 호스트가 지키는 것만 본다:
 *   - 켜는 값 셋(on · test · 없음) · 켜진 방에서는 낱말 규칙이 안 걸린다
 *   - 1 이면 멈추고 한 줄을 그 자리에 올린다 · 이미 답했으면 한 줄을 안 덧붙인다 · 0 이면 아무것도 안 한다
 *   - 판정이 끝나길 기다렸다가, 그 말 뒤로 쌓인 묶음의 답은 부른 답이라도 버린다 · 그 앞 말의 답은 낸다
 *   - 멈춘 방에서도 「멈추라는 말인가」부터 묻고(거듭하면 멈춤을 늘림 · 한 줄은 또 안 함) 0 이면 「다시 말해도 되나」 · 1 이면 풀린다
 *   - 방마다 따로 줄을 선다 · 판정 프로세스를 못 띄우면 0
 */
import './lib/fresh-dist.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hushjudge-'));
process.env.BOT_ACTIVITY_DIR = path.join(tmp, 'activity');

const { ChatHost } = await import('../dist/chat-host.js');

let pass = 0;
const fails = [];
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log(`PASS ${name}`); return; }
  fails.push(name);
  console.log(`FAIL ${name}`);
  if (detail !== undefined) console.log(`     ${JSON.stringify(detail)}`);
};

const ME = 'UTESTBOT';
const ROOM = 'C_ROOM';
const TEST = 'C_TEST';

function make(judged = []) {
  const root = path.join(tmp, `p${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(path.join(root, 'bots', 'lunch'), { recursive: true });
  fs.writeFileSync(path.join(root, 'bots', 'lunch', 'config.json'),
    JSON.stringify({ call_names: ['소인'], rooms: { [TEST]: { rules: true } } }), 'utf-8');
  const host = new ChatHost({
    name: 'lunch', botToken: '', appToken: '', python: path.join(root, 'no-such-python.exe'),
    script: path.join(root, 'turn.py'),
    surfaces: ['channel'], channels: [ROOM, TEST], managerUserId: 'U_MGR',
    buttIn: { quietMinutes: 0, dailyCap: 99 },
  });
  host['selfUserId'] = ME;
  host['hushLines'] = async () => [];
  host['displayName'] = async () => '실원';
  host['plainText'] = async (_c, t) => t;
  host['react'] = async () => {};
  // 판정 결과를 차례로 돌려준다
  host['runHush'] = async (req) => { host.__reqs = [...(host.__reqs ?? []), req]; return judged.shift() ?? { ans: 0 }; };
  return host;
}
const wait = (h, ch) => Promise.all([...(h['hushInFlight'].get(ch) ?? [])]);

// ── 켜는 값 ──
{
  const h = make();
  delete process.env.HUSH_JUDGE;
  check('값이 없으면 판정을 안 쓴다', !h['judgeOn'](ROOM) && !h['judgeOn'](TEST));
  process.env.HUSH_JUDGE = 'test';
  check('test 면 시험 방만', !h['judgeOn'](ROOM) && h['judgeOn'](TEST));
  process.env.HUSH_JUDGE = 'on';
  check('on 이면 맡은 방 전부', h['judgeOn'](ROOM) && h['judgeOn'](TEST));
  h['humanSpoke'](ROOM, '소인아 대답하지마');
  check('켜진 방에서는 낱말 규칙이 안 걸린다(판정이 정한다)', h['withinLimits'](ROOM) === true);
}

// ── 1 이면 멈추고 한 줄 · 0 이면 그대로 ──
{
  process.env.HUSH_JUDGE = 'on';
  const h = make([{ ans: 1, reply: '예, 물러나 있겠사옵니다.', model: 'flash' }, { ans: 0 }, { ans: 0 }]);
  const said = [];
  h['say'] = async (_c, ch, text, th) => { said.push({ ch, text, th }); };
  h['startJudge'](null, ROOM, 'U1', '100.000100', '99.000000', '소인아 대답하지마');
  await wait(h, ROOM);
  check('1 이면 먼저 말 걸지 않는다', h['withinLimits'](ROOM) === false);
  check('1 이면 그 한 줄을 그 말이 있던 스레드에 올린다',
    said.length === 1 && said[0].text === '예, 물러나 있겠사옵니다.' && said[0].th === '99.000000', said);
  check('판정에 「멈추라는 말인가」로 물었다', h.__reqs[0].mode === 'stop' && h.__reqs[0].key === ROOM);

  h['startJudge'](null, ROOM, 'U2', '101.000000', undefined, '그럼 갓잇으로 갈까');
  await wait(h, ROOM);
  check('멈춘 방에서도 「멈추라는 말인가」부터 묻고, 0 이면 「다시 말해도 되나」를 잇는다',
    h.__reqs[1].mode === 'stop' && h.__reqs[2].mode === 'resume', h.__reqs.map((r) => r.mode));
  check('그 답이 0 이면 그대로 멈춰 있다', h['withinLimits'](ROOM) === false);
}
{
  // 멈춘 방에서 거듭한 「대답하지 마」 — 멈춤을 그 말까지 늘리고, 한 줄은 또 하지 않는다(검토 2026-10-20)
  process.env.HUSH_JUDGE = 'on';
  const h = make([{ ans: 1, reply: '물러나 있겠사옵니다.' }, { ans: 1, reply: '또 물러나 있겠사옵니다.' }]);
  const said = [];
  h['say'] = async (_c, _ch, text) => { said.push(text); };
  h['startJudge'](null, ROOM, 'U1', '100.000000', undefined, '소인 대답하지 마');
  h['startJudge'](null, ROOM, 'U1', '150.000000', undefined, '@소인 아니 진짜 대답하지 마');
  await wait(h, ROOM);
  check('거듭한 「대답하지 마」는 멈춤을 그 말까지 늘린다', h['noReplyTs'].get(ROOM) === 150 && h.__reqs.length === 2
    && h.__reqs.every((r) => r.mode === 'stop'), h.__reqs);
  check('이미 멈춘 방이면 한 줄을 또 하지 않는다', said.length === 1, said);
}
{
  // 방마다 따로 줄을 선다 — 한 방 판정이 안 끝나도 다른 방 답은 기다리지 않는다
  process.env.HUSH_JUDGE = 'on';
  const h = make();
  let release;
  h['runHush'] = async (req) => (req.key === TEST ? new Promise((r) => { release = r; }) : { ans: 0 });
  h['startJudge'](null, TEST, 'U1', '100.000000', undefined, '오래 걸리는 판정');
  h['startJudge'](null, ROOM, 'U1', '100.000000', undefined, '다른 방 말');
  const done = await Promise.race([wait(h, ROOM).then(() => 'room'), new Promise((r) => setTimeout(() => r('timeout'), 500))]);
  check('한 방 판정이 걸려 있어도 다른 방 판정은 끝난다', done === 'room', done);
  release({ ans: 0 });
  await wait(h, TEST);
}
{
  // 물러나며 한 한 줄은 형제 봇이 받아치지 않게 적힌다(2026-10-20 커피콩 「네, 조용히 있을게요!」에 소인이 맞장구)
  process.env.HUSH_JUDGE = 'on';
  const h = make([{ ans: 1, reply: '네, 조용히 & 있을게요!' }]);
  h['say'] = async () => {};
  h['startJudge'](null, TEST, 'U1', '100.000000', undefined, '@커피콩 넌 지금은 신경 안써도 돼');
  await wait(h, TEST);
  check('물러나며 한 한 줄은 형제 봇이 받아치지 않는다(슬랙이 바꿔 적은 글도)',
    ChatHost['isHushAck'](TEST, '네, 조용히 &amp; 있을게요!') && !ChatHost['isHushAck'](TEST, '다른 말')
    && !ChatHost['isHushAck'](ROOM, '네, 조용히 & 있을게요!'));
}
{
  process.env.HUSH_JUDGE = 'on';
  const h = make([{ ans: 0 }]);
  const said = [];
  h['say'] = async (_c, _ch, text) => { said.push(text); };
  h['startJudge'](null, ROOM, 'U1', '100.000000', undefined, '아 말하지 마 스포야');
  await wait(h, ROOM);
  check('0 이면 아무것도 안 한다', h['withinLimits'](ROOM) === true && said.length === 0);
}
{
  process.env.HUSH_JUDGE = 'on';
  const h = make([{ ans: 1, reply: '' }, { ans: 0 }, { ans: 1 }]);
  const said = [];
  h['say'] = async (_c, _ch, text) => { said.push(text); };
  h['startJudge'](null, ROOM, 'U1', '100.000000', undefined, '소인 대답하지 마');
  await wait(h, ROOM);
  check('한 줄이 빈 글이면 말없이 빠진다', said.length === 0 && h['withinLimits'](ROOM) === false);
  h['startJudge'](null, ROOM, 'U1', '102.000000', undefined, '소인 이제 말해도 돼');
  await wait(h, ROOM);
  check('「다시 말해도 된다」가 1 이면 풀린다', h['withinLimits'](ROOM) === true);
}
{
  process.env.HUSH_JUDGE = 'on';
  const h = make([{ ans: 1, reply: '알겠사옵니다.' }]);
  const said = [];
  h['say'] = async (_c, _ch, text) => { said.push(text); };
  h['lastSpoke'].set(ROOM, 200 * 1000);   // 그 말(100초) 뒤에 이미 답했다
  h['startJudge'](null, ROOM, 'U1', '100.000000', undefined, '소인아 대답하지마');
  await wait(h, ROOM);
  check('그 말 뒤로 이미 답했으면 한 줄을 덧붙이지 않는다', said.length === 0 && h['withinLimits'](ROOM) === false);
}

// ── 만들던 답 — 판정을 기다렸다가 버리거나 낸다 ──
for (const [name, stopTs, forced, dropped] of [
  ['부른 말 뒤에 「신경 안 써도 돼」 → 부른 답도 버린다', '300.000000', true, true],
  ['먼저 나선 답도 버린다', '300.000000', false, true],
  ['멈춤이 그 묶음보다 앞이면(그 뒤에 부름) 부른 답은 낸다', '250.000000', true, false],
]) {
  process.env.HUSH_JUDGE = 'on';
  const h = make([{ ans: 1, reply: '' }]);
  const said = [];
  h['say'] = async (_c, _ch, text) => { said.push(text); };
  h['runTurn'] = async () => {
    // 답을 만드는 도중에 그 말이 오고 판정이 걸린다(판정은 턴보다 늦게 끝나도 된다)
    h['startJudge'](null, ROOM, 'U1', stopTs, undefined, '소인 넌 신경 안 써도 돼');
    return { reply: '답입니다', speak: true };
  };
  h['enqueue'](ROOM, { channel: ROOM, text: '실원: @소인 이거 알려줘', ts: '280.000000', react: forced, user: 'U1' });
  await h['pump'](null, ROOM, forced);
  check(name, dropped ? !said.includes('답입니다') : said.includes('답입니다'), said);
}

// ── 판정 프로세스를 못 띄우면 0 ──
{
  process.env.HUSH_JUDGE = 'on';
  const h = make();
  delete h['runHush'];   // 바꿔 끼운 것을 걷고 진짜를 부른다(없는 파이썬)
  const out = await h['runHush']({ bot: 'lunch', key: ROOM });
  check('판정 프로세스를 못 띄우면 0', out.ans === 0 && typeof out.error === 'string', out);
}

// ── 읽기 전에 끝나는 판정 프로세스 — 쓰기의 EPIPE 가 호스트를 죽이지 않는다 ──
{
  const h = make();
  delete h['runHush'];
  // node 를 파이썬 자리에 두면 `-X` 를 모른다며 입력을 안 읽고 바로 끝난다 — 큰 입력을 쓰는 동안 파이프가 닫힌다
  h['opts'].python = process.execPath;
  let crashed = null;
  const onErr = (e) => { crashed = e; };
  process.on('uncaughtException', onErr);
  const out = await h['runHush']({ bot: 'lunch', key: ROOM, lines: [{ text: '가'.repeat(2_000_000) }] });
  await new Promise((r) => setTimeout(r, 200));
  process.off('uncaughtException', onErr);
  check('판정 프로세스가 입력을 읽기 전에 끝나도 호스트가 안 죽고 0', !crashed && out.ans === 0, { crashed: String(crashed), out });
}

delete process.env.HUSH_JUDGE;
console.log(`\n${pass} 통과 · ${fails.length} 실패`);
if (fails.length) process.exitCode = 1;
