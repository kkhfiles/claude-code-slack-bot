/**
 * 「이 턴을 실장 본인이 한 말로 볼 수 있나」 검사.
 *
 *   npm run check:manager
 *
 * 왜 재나 — 설정을 말로 바꾸는 길(대화 층 `control`)이 **실장만** 열린다. 그 판정을
 * 여기서 만들어 넘기므로, 여기가 틀리면 두 가지로 잘못된다.
 *
 *   1. **방에서 영영 안 열린다** — 예전 판정은 `key === managerUserId` 였는데 방의
 *      열쇠는 채널 ID(`C…`)라 사람 ID 와 같을 수가 없다. 1:1 에서만 맞는 식이었고,
 *      그대로 두면 「방에서도 된다」고 적어 놓고 실제로는 안 되는 기능이 된다.
 *   2. **남의 청이 실장 이름으로 먹는다** — 방에서는 한 턴이 여러 사람의 말을 합친
 *      것일 수 있다. 「실장도 끼어 있으니 실장」으로 보면 다른 분이 흘린 말이
 *      실장의 청으로 처리된다. 되돌릴 수 없는 종류의 잘못이다.
 */
import './lib/fresh-dist.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-'));
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
const BOSS = 'U_BOSS';
const OTHER = 'U_OTHER';
const SIBLING = 'B_OTHERBOT';

function profileFor() {
  const root = path.join(tmp, 'lunch');
  fs.mkdirSync(path.join(root, 'bots', 'lunch'), { recursive: true });
  fs.writeFileSync(path.join(root, 'bots', 'lunch', 'config.json'),
    JSON.stringify({ reaction: 'cow', interest: ['점심'] }), 'utf-8');
  return path.join(root, 'turn.py');
}

function make(managerUserId = BOSS) {
  const host = new ChatHost({
    name: 'lunch', botToken: '', appToken: '', python: '', script: profileFor(),
    surfaces: ['channel', 'dm'],
    channels: [ROOM],
    managerUserId,
    buttIn: { quietMinutes: 0, dailyCap: 99 },
  });
  host['loadProfile']();
  return host;
}

const judge = (host, users) => host['isManagerTurn'](new Set(users));

// --- 누가 말했나로 가른다 ---------------------------------------------------------
{
  const host = make();
  check('실장 혼자 말했으면 실장 턴이다', judge(host, [BOSS]) === true);
  check('다른 분이 말했으면 아니다', judge(host, [OTHER]) === false);
  check('둘이 섞이면 아니다 (남의 청이 실장 이름으로 먹으면 안 된다)',
    judge(host, [BOSS, OTHER]) === false);
  check('형제 봇의 말이 섞여도 아니다', judge(host, [BOSS, SIBLING]) === false);
  check('말한 사람을 모르면 아니다 (인사처럼 사람이 한 말이 아닌 것)',
    judge(host, ['']) === false);
  check('빈 묶음이면 아니다', judge(host, []) === false);
  check('아예 없으면 아니다', host['isManagerTurn'](undefined) === false);
}

// --- 설정이 비어 있으면 아무도 실장이 아니다 ---------------------------------------
// 안전한 쪽으로 넘어져야 한다 — `LETTER_MANAGER_USER_ID` 를 안 넣은 PC 에서
// **빈 문자열끼리 같아져** 모두가 실장이 되는 일이 없어야 한다.
{
  const host = make('');
  check('실장 ID 를 안 넣었으면 아무도 실장이 아니다', judge(host, [BOSS]) === false);
  check('말한 사람을 몰라도 실장이 되지 않는다', judge(host, ['']) === false);
}

// --- 대기열이 말한 사람을 실제로 모으나 --------------------------------------------
// 판정 함수만 맞고 모으는 쪽이 비어 있으면 **늘 거짓**이 된다 — 조용히 안 되는 모양이다.
{
  const host = make();
  host['selfUserId'] = 'U_BOT';
  host['kick'] = () => {};
  await host['onChannelMessage'](client(), BOSS, ROOM, '100.1', undefined,
    '<@U_BOT> 성사 인원 2명으로', false);
  const users = host['pending'].get(ROOM)?.users;
  check('방에서 들어온 말이 누가 했는지 남긴다',
    !!users && users.has(BOSS), { 모인사람: [...(users ?? [])] });
  check('그 묶음이 실장 턴으로 잡힌다', host['isManagerTurn'](users) === true);

  await host['onChannelMessage'](client(), OTHER, ROOM, '100.2', undefined,
    '저도 점심 같이 가요', false);   // 관심 낱말이 있어야 대기열에 담긴다
  const both = host['pending'].get(ROOM)?.users;
  check('다른 분이 이어 말하면 그 묶음은 실장 턴이 아니게 된다',
    host['isManagerTurn'](both) === false, { 모인사람: [...(both ?? [])] });
}

function client() {
  return {
    reactions: { add: async () => {}, remove: async () => {} },
    chat: { postMessage: async () => ({ ok: true }), postEphemeral: async () => ({ ok: true }) },
    users: { info: async () => ({ user: { profile: { display_name: '규황' } } }) },
    conversations: {
      open: async () => ({ channel: { id: 'D1' } }),
      history: async () => ({ messages: [] }),
    },
  };
}

console.log(`\n통과 ${pass} / 실패 ${fails.length}`);
if (fails.length) {
  for (const name of fails) console.log(`  - ${name}`);
  process.exitCode = 1;
}
