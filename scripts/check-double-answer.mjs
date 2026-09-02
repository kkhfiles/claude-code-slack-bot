/**
 * 「같은 말에 두 번 답하지 않는다」 검사.
 *
 *   npm run check:double
 *
 * 왜 재나 — 2026-09-02, 소인이 방에서 한 마디에 **두 번씩** 답했다. 사람이 먼저
 * 알아채고 물었다("왜 같은 말을 두번하나요"). 길은 이랬다.
 *
 *   1. 살아 있는 이벤트가 그 말을 대기열에 담는다
 *   2. `pump` 가 턴을 시작하며 **대기열 항목을 통째로 지운다**
 *   3. 답을 만드는 10~15초 사이에 훑기가 방을 다시 읽는다 — 봇이 아직 아무 말도
 *      안 올렸으니 그 말은 여전히 「답 안 한 글」로 보인다
 *   4. 이미 담았다는 기억이 2번에서 같이 지워졌으므로 **다시 담긴다**
 *   5. 턴이 끝나자마자 `pump` 의 반복문이 그걸 집어 한 번 더 답한다
 *
 * 그래서 **턴이 도는 사이에 훑기를 돌려 보는 것**이 이 검사의 전부다. 그 창을
 * 안 만들고 재면 아무 일도 안 일어난다 — 증상이 났던 그 모양으로 짠다.
 */
import './lib/fresh-dist.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'double-'));
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
const ME = 'U_BOT';
const CALL = `<@${ME}> 서현지가 내 사장은 아니야`;

function profileFor() {
  const root = path.join(tmp, 'lunch');
  fs.mkdirSync(path.join(root, 'bots', 'lunch'), { recursive: true });
  fs.writeFileSync(path.join(root, 'bots', 'lunch', 'config.json'),
    JSON.stringify({ reaction: 'cow', interest: ['점심'] }), 'utf-8');
  return path.join(root, 'turn.py');
}

/** 방에 남아 있는 글. 훑기는 이걸 새것부터 읽는다(슬랙과 같은 순서). */
let history = [];
const client = {
  reactions: { add: async () => {}, remove: async () => {} },
  chat: { postMessage: async () => ({ ok: true }), postEphemeral: async () => ({ ok: true }) },
  users: { info: async () => ({ user: { profile: { display_name: '규황' } } }) },
  conversations: {
    open: async () => ({ channel: { id: 'D1' } }),
    history: async () => ({ messages: history.slice().reverse() }),
  },
};

function make() {
  const host = new ChatHost({
    name: 'lunch', botToken: '', appToken: '', python: '', script: profileFor(),
    surfaces: ['channel'],
    channels: [ROOM],
    buttIn: { quietMinutes: 0, dailyCap: 99 },
  });
  host['loadProfile']();
  host['selfUserId'] = ME;
  const kicked = [];
  host['kick'] = (_c, _k, ch, forced) => { kicked.push([ch, !!forced]); };
  return { host, kicked };
}

const queued = (host) => (host['pending'].get(ROOM)?.texts ?? []).length;

/** 턴이 시작된 상태로 만든다 — `pump` 가 하는 두 가지가 이것이다. */
function turnStarts(host) {
  host['active'].add(ROOM);
  host['pending'].delete(ROOM);
}

// --- 증상 그대로 ------------------------------------------------------------------
{
  const { host } = make();
  history = [{ ts: '100.1', user: 'U1', text: CALL }];
  await host['onChannelMessage'](client, 'U1', ROOM, '100.1', undefined, CALL, false);
  check('부른 말이 대기열에 담긴다', queued(host) === 1, { 담김: queued(host) });

  turnStarts(host);
  await host['sweepChannel'](client, ROOM);
  check('턴이 도는 사이 훑기가 같은 말을 다시 담지 않는다',
    queued(host) === 0, { 다시담김: queued(host) });
}

// --- 막아 놓고 귀를 닫아 버리면 안 된다 ---------------------------------------------
{
  const { host, kicked } = make();
  history = [{ ts: '200.1', user: 'U1', text: CALL }];
  await host['onChannelMessage'](client, 'U1', ROOM, '200.1', undefined, CALL, false);
  turnStarts(host);
  // 답을 만드는 사이에 **새 말**이 왔다. 이건 반드시 집어야 한다.
  history.push({ ts: '200.9', user: 'U2', text: `<@${ME}> 나는 수석이야` });
  await host['sweepChannel'](client, ROOM);
  check('턴이 도는 사이에 온 새 말은 그대로 집는다',
    queued(host) === 1, { 담김: queued(host), kicked });
}

// --- 답한 뒤에도 안 되풀이한다 -------------------------------------------------------
{
  const { host } = make();
  history = [{ ts: '300.1', user: 'U1', text: CALL }];
  await host['onChannelMessage'](client, 'U1', ROOM, '300.1', undefined, CALL, false);
  turnStarts(host);
  host['active'].delete(ROOM);              // 턴이 끝났다
  // **슬랙이 방금 올린 봇의 말을 아직 안 돌려주는 창**이 있다. 그때 훑으면 사람 말이
  // 여전히 「답 안 한 글」로 보인다 — 여기서도 두 번째 답이 나가면 안 된다.
  await host['sweepChannel'](client, ROOM);
  check('봇의 답이 아직 방에 안 보이는 창에서도 다시 안 담는다',
    queued(host) === 0, { 다시담김: queued(host) });
}

// --- 기억이 끝없이 자라지 않는다 ------------------------------------------------------
{
  const { host } = make();
  const many = 800;
  for (let i = 0; i < many; i++) {
    host['enqueue'](ROOM, { channel: ROOM, ts: `9${i}.1`, text: `줄 ${i}` });
    host['pending'].delete(ROOM);
  }
  const size = host['taken']?.get(ROOM)?.size ?? -1;
  check('집어 간 글의 기억은 상한이 있다',
    size > 0 && size < many, { 기억: size, 넣은수: many });
}

console.log(`\n${pass}개 통과${fails.length ? ` · ${fails.length}개 실패: ${fails.join(', ')}` : ''}`);
process.exit(fails.length ? 1 : 0);
