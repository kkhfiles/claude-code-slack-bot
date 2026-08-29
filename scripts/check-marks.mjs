/**
 * 「생각 중」 표시 검사 — **붙였다 떼는 짝이 실제로 맞는지 돌려 본다.**
 *
 *   npm run check:marks
 *
 * 왜 눈으로 안 보고 재나 — 여기서 틀리면 증상이 **안 떼진 이모지가 방에 영영 남는 것**
 * 이다. 오류도 로그도 안 나고, 슬랙을 열어 보기 전에는 아무도 모른다. 게다가 답을
 * 내는 길이 넷이라(부름·낱말·훑기·인사) 하나만 손대도 다른 길에서 짝이 어긋난다.
 *
 * 이름이 봇마다 달라야 하는 것도 같이 잰다 — 한 방에 봇이 둘이면 같은 표시로는
 * **누가 생각 중인지 못 가려서** 이 기능이 있으나 마나가 된다.
 */
import './lib/fresh-dist.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'marks-'));
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

const ROOM = 'C_ROOM';

/** 봇 프로필을 임시 자리에 만든다 — `loadProfile` 이 보는 그 경로 그대로. */
function profileFor(bot, reaction) {
  const root = path.join(tmp, bot);
  fs.mkdirSync(path.join(root, 'bots', bot), { recursive: true });
  fs.writeFileSync(path.join(root, 'bots', bot, 'config.json'),
    JSON.stringify({ reaction, interest: ['점심'] }), 'utf-8');
  return path.join(root, 'turn.py');
}

/** 슬랙 대신 받아 적는 가짜 손. 실제로 부른 것만 남는다. */
function fakeClient(log) {
  return {
    reactions: {
      add: async ({ channel, timestamp, name }) => { log.push(['add', channel, timestamp, name]); },
      remove: async ({ channel, timestamp, name }) => { log.push(['remove', channel, timestamp, name]); },
    },
    chat: { postMessage: async () => ({ ok: true }) },
    users: { info: async () => ({ user: { profile: { display_name: '아무개' } } }) },
  };
}

function make(bot, reaction, reply = '네') {
  const log = [];
  const host = new ChatHost({
    name: bot, botToken: '', appToken: '', python: '', script: profileFor(bot, reaction),
    surfaces: ['channel'], channels: [ROOM],
  });
  host['loadProfile']();
  // 말을 짓는 일은 이 검사의 관심이 아니다 — 파이썬을 띄우지 않고 답만 돌려준다.
  host['runTurn'] = async () => (reply === null
    ? { reply: '', error: '일부러 낸 실패' }
    : { reply, error: null });
  host['say'] = async () => {};
  return { host, log, client: fakeClient(log) };
}

const marks = (log, op) => log.filter((r) => r[0] === op).map((r) => r[2]);

// --- 프로필에 적은 이름이 실제로 쓰이나 --------------------------------------------
// 「적어 뒀다」와 「적용된다」는 다른 말이다. 소비처가 안 읽으면 설정은 존재만 하고 효력 0.
{
  const { host } = make('lunch', 'cow');
  check('프로필의 reaction 이 실제 표시가 된다', host['mark'] === 'cow', host['mark']);
}
{
  const { host } = make('letter', ':beans:');
  check('콜론을 적어도 벗겨서 쓴다', host['mark'] === 'beans', host['mark']);
}
{
  const { host } = make('bare', undefined);
  check('안 적으면 기본값으로 간다', host['mark'] === 'thinking_face', host['mark']);
}
{
  // **한 방에 둘이면 서로 달라야 한다** — 같으면 누가 생각 중인지 못 가린다.
  const a = make('lunch2', 'cow').host['mark'];
  const b = make('letter2', 'beans').host['mark'];
  check('봇마다 다른 표시를 쓴다', a !== b, { 소인: a, 커피콩: b });
}

// --- 부른 자리 — 그 글에 붙었다 떼진다 ---------------------------------------------
{
  const { host, log, client } = make('called', 'cow');
  host['enqueue'](ROOM, { channel: ROOM, ts: '111.1', text: '규황: <@B> 안녕', react: true });
  await host['pump'](client, ROOM, true);
  check('부른 글에 붙었다 떼진다',
    JSON.stringify(log) === JSON.stringify([
      ['add', ROOM, '111.1', 'cow'], ['remove', ROOM, '111.1', 'cow']]), log);
}

// --- 안 부른 자리 — **가장 새 글 하나에만** ----------------------------------------
// 줄마다 붙으면 방 사람들의 모든 말에 이모지가 달리고, 하나도 안 붙으면 답이 오기까지
// 10~20초 동안 못 들은 것과 구분이 안 된다. 그 사이가 여기다.
{
  const { host, log, client } = make('sweep', 'cow');
  for (const ts of ['201.1', '202.2', '203.3']) {
    host['enqueue'](ROOM, { channel: ROOM, ts, text: `규황: 말 ${ts}`, react: false });
  }
  await host['pump'](client, ROOM, false);
  check('안 부른 자리는 가장 새 글 하나에만 붙는다',
    JSON.stringify(marks(log, 'add')) === JSON.stringify(['203.3']), marks(log, 'add'));
  check('그 하나도 반드시 떼진다',
    JSON.stringify(marks(log, 'remove')) === JSON.stringify(['203.3']), marks(log, 'remove'));
}

// --- 답을 못 만들어도 떼진다 --------------------------------------------------------
// 여기가 안 떼지면 **실패한 자리에만** 표시가 남아서, 하필 사람이 들여다보는 자리에 남는다.
{
  const { host, log, client } = make('failing', 'cow', null);
  host['enqueue'](ROOM, { channel: ROOM, ts: '301.1', text: '규황: 안녕', react: true });
  await host['pump'](client, ROOM, true);
  check('턴이 실패해도 떼진다',
    JSON.stringify(marks(log, 'remove')) === JSON.stringify(['301.1']), log);
}

// --- 여러 줄이 부름으로 들어오면 그 줄들이 다 붙고 다 떼진다 -----------------------
{
  const { host, log, client } = make('multi', 'cow');
  for (const ts of ['401.1', '402.2']) {
    host['enqueue'](ROOM, { channel: ROOM, ts, text: `규황: ${ts}`, react: true });
  }
  await host['pump'](client, ROOM, true);
  check('붙은 것은 하나도 안 남기고 다 떼진다',
    JSON.stringify(marks(log, 'add')) === JSON.stringify(marks(log, 'remove')),
    { 붙임: marks(log, 'add'), 뗌: marks(log, 'remove') });
}

// --- 「방의 말을 실시간으로 듣고 있나」를 세는 자리 ---------------------------------
// 표시와 같은 물음의 다른 각도다 — 표시는 「지금 답을 만드나」를 보여 주고, 이 값은
// **애초에 말이 닿기는 하나**를 센다. 여기가 틀리면 감시가 자기가 못 보는 것을 봤다고
// 하게 된다: 구독은 자리마다 따로 켜므로 `message.im` 만 있고 `message.channels` 가
// 빠진 조합이 성립하는데, 1:1 한 마디에 값이 켜지면 **잡으려던 그 상태에서 경고가
// 영영 안 뜬다.**
{
  const { host, client } = make('live', 'cow');
  host['selfUserId'] = 'B_SELF';
  host['onDirectMessage'] = async () => {};
  host['onChannelMessage'] = async () => {};

  await host['onEvent'](client, {
    channel: 'D_ROOM', channel_type: 'im', user: 'U1', ts: '1.1', text: '안녕',
  });
  check('1:1 한 마디는 「방의 말이 온다」의 증거가 아니다',
    host['sawLive'] === false, host['sawLive']);

  await host['onEvent'](client, {
    channel: ROOM, user: 'U1', ts: '2.2', text: '점심 뭐 먹지',
  });
  check('방의 말이 오면 그때 센다', host['sawLive'] === true, host['sawLive']);
}
{
  // **허락 안 한 방의 말도 증거다** — 구독이 살아 있다는 사실 자체는 방을 안 가린다.
  const { host, client } = make('live2', 'cow');
  host['selfUserId'] = 'B_SELF';
  host['onChannelMessage'] = async () => {};
  await host['onEvent'](client, {
    channel: 'C_OTHER', user: 'U1', ts: '3.3', text: '안녕',
  });
  check('낯선 방의 말도 구독이 살아 있다는 증거로 센다',
    host['sawLive'] === true, host['sawLive']);
}

// --- 형제 봇의 말은 안 버리되, 답할지는 모델이 정한다 -------------------------------
// **담는 것과 답하는 것은 다르다.** 봇 말에는 두 번째 기회가 없어서(훑기가 봇 말을
// 경계로 삼아 지운다) 여기서 빠지면 영영 없던 말이 되지만, 그렇다고 형제라서 무조건
// 받아치면 그건 대화가 아니라 반사다. 실측(2026-08-19 15:44): 턴이 도는 16초 사이에
// 온 형제의 말이 담기지도 않고 사라졌다.
{
  const { host, client } = make('busy', 'cow');
  host['selfUserId'] = 'B_SELF';
  const kicked = [];
  host['kick'] = (_c, key, _ch, forced) => { kicked.push({ key, forced }); };

  // 턴이 도는 중으로 만들어 둔다 — 사라졌던 그 조건 그대로.
  host['active'].add(ROOM);
  await host['onChannelMessage'](client, 'B_OTHER', ROOM, '9.9', undefined,
    '소인: 콩이님, 무슨 분부이신지', true);
  const waiting = host['pending'].get(ROOM);
  check('도는 중에 온 형제의 말도 대기열에 담긴다',
    !!waiting && waiting.texts.length === 1, waiting && waiting.texts);
  check('형제의 말이라고 부른 것으로 치지는 않는다 (낄지는 모델이 정한다)',
    kicked.length === 1 && kicked[0].forced === false, kicked);
  check('형제가 남긴 말이라고 표시해 둔다 (훑기가 못 집는 말이라서)',
    waiting?.hasSibling === true, waiting?.hasSibling);

  // 같은 조건에서 **사람 말**은 낱말·한도에 걸려 빠지는 것이 맞다(훑기가 다시 집어 온다).
  const plain = make('busy2', 'cow');
  plain.host['selfUserId'] = 'B_SELF';
  plain.host['kick'] = () => {};
  plain.host['active'].add(ROOM);
  await plain.host['onChannelMessage'](plain.client, 'U1', ROOM, '8.8', undefined,
    '규황: 점심 뭐 먹지', false);
  check('사람 말은 그대로 굴레를 받는다 (형제만 예외다)',
    plain.host['pending'].get(ROOM) === undefined, plain.host['pending'].get(ROOM));
}

// --- 자리가 나면 묻힌 형제 말을 집는다 ---------------------------------------------
// 여기서 안 집으면 그 말은 **사람이 입을 열 때까지** 대기열에 묻힌다 — 봇끼리만 말하는
// 자리에서는 영영이다. 집어는 오되 답할지는 여전히 모델이 정한다.
{
  const { host, client } = make('drain', 'cow');
  const pumped = [];
  host['pump'] = async (_c, key, forced) => { pumped.push({ key, forced }); };

  host['pending'].set(ROOM, { channel: ROOM, texts: ['소인: 안녕하시옵니까'], reactTs: [],
    toldBusy: false, hasSibling: true, seen: new Set(['1.1']) });
  host['drain'](client);
  check('자리가 나면 묻힌 형제 말을 집는다',
    pumped.length === 1 && pumped[0].key === ROOM, pumped);
  check('집어 와도 부른 것으로 치지 않는다',
    pumped[0]?.forced === false, pumped);

  // 형제 표시가 없는 채널 대기열은 그대로 둔다 — 훑기가 조건을 다시 보는 자리다.
  const quiet = make('drain2', 'cow');
  const p2 = [];
  quiet.host['pump'] = async (_c, key, forced) => { p2.push({ key, forced }); };
  quiet.host['pending'].set(ROOM, { channel: ROOM, texts: ['규황: 배고프다'], reactTs: [],
    toldBusy: false, seen: new Set(['2.2']) });
  quiet.host['drain'](quiet.client);
  check('조용히 쌓이던 사람 말은 자리가 났다고 꺼내지 않는다', p2.length === 0, p2);
}

// --- 훑을 때마다 묻힌 대기열을 깨운다 -----------------------------------------------
// 자리가 났는지 보는 일은 **자기 턴이 끝날 때만** 돌았다. 그런데 대기열이 막히는 흔한
// 이유는 자기 턴이 아니라 **다른 봇이 동시 실행 자리를 다 쓴 것**이고, 그때는 깨워 줄
// 자기 턴이 아예 없다. 형제 말에는 여기 말고 되집는 길이 없다.
{
  const { host } = make('wake', 'cow');
  const woke = [];
  host['drain'] = () => { woke.push('깨움'); };
  host['app'] = { client: {} };
  host['opts'].channels = [];      // 방은 안 훑고 깨우는 일만 본다
  await host['sweep']();
  check('훑을 때마다 묻힌 대기열을 먼저 깨운다', woke.length === 1, woke);
}

// --- 인사는 붙일 자리가 없다 --------------------------------------------------------
// `greet:` 는 지어낸 열쇠라 슬랙에 그런 글이 없다. 붙이려 들면 매번 실패만 찍는다.
{
  const { host, log, client } = make('greeting', 'cow');
  host['enqueue'](ROOM, { channel: ROOM, ts: `greet:${ROOM}`, text: '(인사해라)', react: false });
  await host['pump'](client, ROOM, true);
  check('인사에는 아무것도 안 붙인다', log.length === 0, log);
}

fs.rmSync(tmp, { recursive: true, force: true });

console.log('\n' + '='.repeat(52));
console.log(`통과 ${pass} / 실패 ${fails.length}`);
if (fails.length) { fails.forEach((f) => console.log(`  - ${f}`)); process.exitCode = 1; }
else console.log('모두 통과.');
