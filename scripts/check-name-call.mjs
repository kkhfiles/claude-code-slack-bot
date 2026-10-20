/**
 * 「시험 방에서 이름으로 부른 말」 검사 — 주인이 멘션 없이 봇 이름을 넣어 시킨 말을 부른 말로 받나.
 *
 *   npm run check:namecall
 *
 * 왜 재나 — 시험 방에서 주인이 「소인아 … 물어보거나 해야 하지 않겠니?」「물어봐」라고 했는데 멘션이 없어 끼어들기 판단
 * 턴으로 갔고, 그 턴에는 다른 방에 글을 올리는 행동이 안 열려 봇은 말만 하고 아무 일도 안 했다(2026-10-20).
 * 그 모양 그대로 재고, 넓어지면 안 되는 곳도 같이 잰다:
 *   - 주인이 아닌 사람 · 시험 방이 아닌 방 · 이름이 없는 말 · 설정에 이름이 없는 봇 → 그대로(끼어들기 판단)
 *   - 멘션은 지금처럼 누구든 부른 말
 */
import './lib/fresh-dist.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'namecall-'));
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
const MGR = 'U_MGR';
const TEST = 'C_TEST';   // 시험 방(rules)
const PLAY = 'C_PLAY';   // 사람들이 쓰는 방

function profileFor(cfg) {
  const root = path.join(tmp, `p${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(path.join(root, 'bots', 'lunch'), { recursive: true });
  fs.writeFileSync(path.join(root, 'bots', 'lunch', 'config.json'), JSON.stringify(cfg), 'utf-8');
  return path.join(root, 'turn.py');
}

function make(cfg) {
  const host = new ChatHost({
    name: 'lunch', botToken: '', appToken: '', python: '', script: profileFor(cfg),
    surfaces: ['channel', 'dm'], channels: [TEST, PLAY], managerUserId: MGR,
    buttIn: { quietMinutes: 0, dailyCap: 0 },        // 끼어들기 한도 0 — 부른 말만 지나간다
  });
  host['selfUserId'] = ME;
  return host;
}

const ON = { call_names: ['소인'], rooms: { [TEST]: { rules: true }, [PLAY]: {} } };
const host = make(ON);
for (const [name, ch, user, text, want] of [
  ['시험 방 · 주인 · 이름 — 부른 말(오늘 장면)', TEST, MGR, '소인아 해피런치 예약 가능 여부와 언제 나갈지 물어봐야 하지 않겠니?', true],
  ['멘션은 누구든 부른 말', PLAY, 'U2', `<@${ME}> 점심 뭐야`, true],
  ['시험 방이라도 주인이 아니면 이름만으로는 안 부른 것', TEST, 'U2', '소인아 물어봐', false],
  ['사람들이 쓰는 방에서는 주인이 이름을 넣어도 안 부른 것(지금처럼)', PLAY, MGR, '소인아 물어봐', false],
  ['이름이 없는 말은 안 부른 것(커피콩에게 한 말에 같이 안 답하게)', TEST, MGR, '콩아 공지 올려', false],
]) {
  check(name, host['isCalledIn'](ch, user, text) === want, { ch, user, text });
}
check('설정에 이름이 없는 봇은 이름으로 안 불림',
  make({ rooms: { [TEST]: { rules: true } } })['isCalledIn'](TEST, MGR, '소인아 물어봐') === false);

// 이어 받기 — 오늘 둘째 말 「물어봐」에는 이름이 없었다
{
  const h = make(ON);
  check('봇이 말한 적 없으면 이름 없는 주인 말은 안 부른 것', h['isCalledIn'](TEST, MGR, '물어봐') === false);
  h['lastSpoke'].set(TEST, Date.now() - 60 * 1000);
  check('봇이 방금(10분 안) 말했으면 이름 없는 주인 말도 이 봇에게 한 말(오늘 「물어봐」)',
    h['isCalledIn'](TEST, MGR, '물어봐') === true);
  check('이어 받기도 시험 방 · 주인만', h['isCalledIn'](TEST, 'U2', '물어봐') === false
    && (h['lastSpoke'].set(PLAY, Date.now()), h['isCalledIn'](PLAY, MGR, '물어봐')) === false);
  h['siblingSpoke'].set(TEST, Date.now());
  check('그 뒤 형제 봇이 끼었으면 이어 받지 않는다(그 봇에게 한 말일 수 있다)', h['isCalledIn'](TEST, MGR, '물어봐') === false);
  h['siblingSpoke'].delete(TEST);
  h['lastSpoke'].set(TEST, Date.now() - 11 * 60 * 1000);
  check('10분이 지나면 이어 받지 않는다', h['isCalledIn'](TEST, MGR, '물어봐') === false);
}

// 살아 있는 길 — 부른 말이면 끼어들기 한도(0)에 안 걸리고 「부른 턴」으로 띄운다
{
  const kicked = [];
  const h = make(ON);
  h['kick'] = (_c, _k, _ch, forced) => kicked.push(forced);
  const client = { users: { info: async () => ({ user: { profile: { display_name: '실장' } } }) } };
  await h['onChannelMessage'](client, MGR, TEST, '100.1', undefined, '물어봐 소인아');
  await h['onChannelMessage'](client, 'U2', TEST, '100.2', undefined, '소인아 물어봐');
  check('살아 있는 길 — 시험 방 주인이 이름으로 부르면 부른 턴으로 띄우고, 한도 0에서 다른 사람 말은 버린다',
    JSON.stringify(kicked) === JSON.stringify([true]), kicked);
}

console.log('');
console.log(`통과 ${pass} / 실패 ${fails.length}`);
if (fails.length) { console.log(fails.map((f) => `  - ${f}`).join('\n')); process.exit(1); }
