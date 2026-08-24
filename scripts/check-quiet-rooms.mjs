/**
 * 「부른 것만 받는 방」 검사 — **부르면 답하고 안 부르면 조용한지** 실제로 돌려 본다.
 *
 *   npm run check:quiet
 *
 * 왜 재나 — 이 방(식단 알림 방)은 두 가지로 다 망가질 수 있고, **둘 다 조용히 망가진다.**
 *   - 너무 닫히면: 불러도 답이 없다. 2026-08-24 에 실제로 그랬고, 아무 표시가 안 나서
 *     고장으로 보였다(로그에는 「대화는 안 하는 아는 방」으로 물러선 기록만 남는다).
 *   - 너무 열리면: 사람들끼리 하는 말에 끼어들어 **알림 방이 잡담 방이 된다.** 이건
 *     슬랙을 열어 보기 전에는 아무도 모른다.
 *
 * 길이 둘이라(살아 있는 이벤트·1분마다 훑기) **한쪽만 막으면 다른 쪽으로 샌다.**
 * 그래서 둘 다 잰다.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'quiet-'));
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

const LOUD = 'C_LOUD';      // 점심원정대 — 먼저 말 걸어도 되는 방
const QUIET = 'C_QUIET';    // 일용할-양식 — 부른 것만 받는 방
const ME = 'U_BOT';

function profileFor() {
  const root = path.join(tmp, 'lunch');
  fs.mkdirSync(path.join(root, 'bots', 'lunch'), { recursive: true });
  fs.writeFileSync(path.join(root, 'bots', 'lunch', 'config.json'),
    JSON.stringify({ reaction: 'cow', interest: ['점심'] }), 'utf-8');
  return path.join(root, 'turn.py');
}

const client = {
  reactions: { add: async () => {}, remove: async () => {} },
  chat: { postMessage: async () => ({ ok: true }), postEphemeral: async () => ({ ok: true }) },
  users: { info: async () => ({ user: { profile: { display_name: '규황' } } }) },
  conversations: { open: async () => ({ channel: { id: 'D1' } }) },
};

function make({ quiet = true } = {}) {
  const host = new ChatHost({
    name: 'lunch', botToken: '', appToken: '', python: '', script: profileFor(),
    surfaces: ['channel'],
    channels: [LOUD, QUIET],
    quietRooms: quiet ? [QUIET] : [],
    // 굴레는 활짝 열어 둔다 — 여기서 재려는 것은 **방 규칙**이지 굴레가 아니다.
    buttIn: { quietMinutes: 0, dailyCap: 99 },
  });
  host['loadProfile']();
  host['selfUserId'] = ME;
  const kicked = [];
  host['kick'] = (_c, _k, ch, forced) => { kicked.push([ch, !!forced]); };
  return { host, kicked };
}

const said = (host, room) => (host['pending'].get(room)?.texts ?? []).length;

// --- 살아 있는 길 ------------------------------------------------------------------
{
  const { host, kicked } = make();
  await host['onChannelMessage'](client, 'U1', QUIET, '1.1', undefined, '점심 뭐 먹지', false);
  check('조용한 방에서는 관심 낱말이 걸려도 안 끼어든다',
    said(host, QUIET) === 0 && kicked.length === 0, { 담김: said(host, QUIET), kicked });
}
{
  const { host, kicked } = make();
  await host['onChannelMessage'](client, 'U1', QUIET, '2.2', undefined, `<@${ME}> 왜 늦었느냐`, false);
  check('조용한 방에서도 부르면 답한다',
    said(host, QUIET) === 1 && kicked.length === 1, { 담김: said(host, QUIET), kicked });
  check('부른 것은 곧바로 물어본다 (굴레를 안 탄다)',
    kicked[0]?.[1] === true, kicked);
}
{
  // 형제 봇의 말은 다른 방에서는 안 버리는데(두 번째 기회가 없다), 이 방은 예외다 —
  // 사람이 알림을 보러 오는 자리라 봇끼리 주고받기 시작하면 알림이 묻힌다.
  const { host, kicked } = make();
  await host['onChannelMessage'](client, 'U2', QUIET, '3.3', undefined, '소인아 밥 먹자', true);
  check('조용한 방에서는 형제 봇의 말도 안 받는다',
    said(host, QUIET) === 0 && kicked.length === 0, { 담김: said(host, QUIET), kicked });
}
{
  // **다른 방까지 조용해지면 안 된다** — 여기서 틀리면 점심원정대가 통째로 벙어리가 된다.
  const { host, kicked } = make();
  await host['onChannelMessage'](client, 'U1', LOUD, '4.4', undefined, '점심 뭐 먹지', false);
  check('열린 방은 그대로 먼저 말을 건다',
    said(host, LOUD) === 1 && kicked.length === 1, { 담김: said(host, LOUD), kicked });
}
{
  const { host, kicked } = make({ quiet: false });
  await host['onChannelMessage'](client, 'U1', QUIET, '5.5', undefined, '점심 뭐 먹지', false);
  check('조용한 방으로 안 적으면 그 방도 열린 방이다',
    said(host, QUIET) === 1 && kicked.length === 1, { 담김: said(host, QUIET), kicked });
}

// --- 훑는 길 ----------------------------------------------------------------------
// 살아 있는 이벤트에만 굴레를 걸고 훑기를 비워 두면, 이벤트가 안 오는 앱에서는
// 그 방이 그냥 열린 방이 된다. 같은 규칙이 두 길에 다 걸려야 한다.
function sweepable(messages) {
  const { host, kicked } = make();
  host['sawLive'] = true;      // 「이벤트가 안 온다」 헛경고를 막는다
  const cl = {
    ...client,
    conversations: {
      ...client.conversations,
      history: async () => ({ messages }),
    },
  };
  return { host, kicked, cl };
}
const now = Date.now() / 1000;
{
  const { host, kicked, cl } = sweepable([{ ts: String(now), user: 'U1', text: '점심 뭐 먹지' }]);
  await host['sweepChannel'](cl, QUIET);
  check('훑기도 조용한 방에서는 안 끼어든다', kicked.length === 0, kicked);
}
{
  const { host, kicked, cl } = sweepable([{ ts: String(now), user: 'U1', text: `<@${ME}> 왜 늦었느냐` }]);
  await host['sweepChannel'](cl, QUIET);
  check('훑기가 조용한 방의 부름은 집어 온다', kicked.length === 1, kicked);
  check('훑어 온 부름도 부른 것으로 넘긴다', kicked[0]?.[1] === true, kicked);
}
{
  const { host, kicked, cl } = sweepable([{ ts: String(now), user: 'U1', text: '점심 뭐 먹지' }]);
  await host['sweepChannel'](cl, LOUD);
  check('훑기는 열린 방에서는 그대로 집어 온다', kicked.length === 1, kicked);
}

// --- 설정이 실제로 그 방을 가리키나 -------------------------------------------------
// 「적어 뒀다」와 「적용된다」는 다른 말이다. 조용한 방이 `channels` 에 없으면 부름조차
// 안 들리고(방이 안 열린다), `channels` 에만 있고 `quietRooms` 에 없으면 활짝 열린다.
{
  const src = fs.readFileSync(new URL('../src/slack-handler.ts', import.meta.url), 'utf-8');
  const lunch = src.slice(src.indexOf("name: 'lunch'"), src.indexOf("name: 'lunch'") + 1400);
  const qi = lunch.indexOf('quietRooms:');
  check('그 방을 조용한 방으로 적는다',
    qi > 0 && /quietRooms:[\s\S]{0,140}readLunchAnnounceChannel/.test(lunch), lunch.slice(0, 400));
  // **`channels:` 의 값 안에 있어야 한다.** 「어딘가 근처에 그 이름이 보인다」로 재면
  // 옆줄의 `knownRooms` 가 대신 걸려서, 방이 안 열린 채로도 통과한다(실제로 그랬다).
  const chan = qi > 0 ? lunch.slice(lunch.indexOf('channels:'), qi) : '';
  check('식단 알림 방을 대화하는 방 목록에도 넣는다',
    /readLunchAnnounceChannel/.test(chan), chan);
}

// --- 반만 적으면 어떻게 되나 --------------------------------------------------------
// `quietRooms` 에만 적고 `channels` 에 안 넣는 것이 이 기능의 함정이다 — 설정 파일에는
// 그 방이 **적혀 있는데** 봇은 불러도 안 온다. 위 두 검사가 지키는 것이 이 상태다.
{
  const host = new ChatHost({
    name: 'lunch', botToken: '', appToken: '', python: '', script: profileFor(),
    surfaces: ['channel'], channels: [LOUD], quietRooms: [QUIET],
    buttIn: { quietMinutes: 0, dailyCap: 99 },
  });
  host['loadProfile']();
  host['selfUserId'] = ME;
  const kicked = [];
  host['kick'] = (_c, _k, ch) => { kicked.push(ch); };
  // **`onEvent` 로 들어가야 한다.** 방 목록 관문은 그 위에 있어서, 안쪽
  // (`onChannelMessage`)을 직접 부르면 관문을 건너뛴 채로 재게 된다 — 처음에 그렇게
  // 짰다가 「안 열린다」고 적어 둔 것이 실은 열려 있는 것으로 나왔다.
  await host['onEvent'](client, {
    channel: QUIET, user: 'U1', ts: '9.9', text: `<@${ME}> 있느냐`,
  });
  check('조용한 방으로만 적고 대화 목록에 안 넣으면 불러도 안 온다',
    kicked.length === 0 && said(host, QUIET) === 0, { kicked, 담김: said(host, QUIET) });
}

console.log(`\n통과 ${pass} / 실패 ${fails.length}`);
if (fails.length) { console.log(fails.join('\n')); process.exitCode = 1; }
