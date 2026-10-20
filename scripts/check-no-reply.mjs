/**
 * 「대답하지 마」 검사 — 봇에게 하지 말라고 하면 한동안 먼저 나서지 않고, 그때 만들던 답도 버리나.
 *
 *   npm run check:noreply
 *
 * 왜 재나 — 한 방에서 사람이 「소인아 대답하지마」·「으아악 대답하지마」라고 했는데 봇이 두 번 다 답했다(2026-10-20).
 * 두 말 다 봇이 답을 만드는 도중에 와서 턴에 실리지 않았다. 그 모양 그대로 잰다:
 *   - 이름을 부르며 · 답을 만드는 도중에(이름 없이) · 방금 말한 뒤에 한 「대답하지 마」 → 멈춤, 만들던 답 버림
 *   - 사람끼리 한 「말하지 마」(봇과 무관) → 그대로 · 부른 턴(멘션)의 답은 그대로 냄 · 「다시 해」로 풀림 · 한 시간 뒤 풀림
 */
import './lib/fresh-dist.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'noreply-'));
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

function make() {
  const root = path.join(tmp, `p${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(path.join(root, 'bots', 'lunch'), { recursive: true });
  fs.writeFileSync(path.join(root, 'bots', 'lunch', 'config.json'), JSON.stringify({ call_names: ['소인'] }), 'utf-8');
  const host = new ChatHost({
    name: 'lunch', botToken: '', appToken: '', python: '', script: path.join(root, 'turn.py'),
    surfaces: ['channel'], channels: [ROOM], managerUserId: 'U_MGR',
    buttIn: { quietMinutes: 0, dailyCap: 99 },
  });
  host['selfUserId'] = ME;
  return host;
}

{
  const h = make();
  check('처음에는 먼저 말 걸 수 있다', h['withinLimits'](ROOM) === true);
  h['humanSpoke'](ROOM, '소인아 대답하지마');
  check('이름을 부르며 「대답하지마」 — 먼저 말 걸지 않는다(오늘 첫 장면)', h['withinLimits'](ROOM) === false);
  h['humanSpoke'](ROOM, '소인 다시 해');
  check('「다시 해」로 풀린다', h['withinLimits'](ROOM) === true);
  h['humanSpoke'](ROOM, '소인아 끼지 마');
  h['noReplyAt'].set(ROOM, Date.now() - 61 * 60 * 1000);
  check('한 시간이 지나면 풀린다', h['withinLimits'](ROOM) === true);
}
{
  const h = make();
  h['humanSpoke'](ROOM, '그거 팀장님께는 말하지마');
  check('봇과 무관한 사람끼리의 「말하지 마」에는 안 조용해진다', h['withinLimits'](ROOM) === true);
  h['active'].add(ROOM);
  h['humanSpoke'](ROOM, '으아악 대답하지마');
  h['active'].delete(ROOM);
  check('봇이 답을 만드는 도중이면 이름 없는 「대답하지마」도 봇에게 한 말(오늘 둘째 장면)', h['withinLimits'](ROOM) === false);
}
{
  const h = make();
  h['lastSpoke'].set(ROOM, Date.now() - 60 * 1000);
  h['humanSpoke'](ROOM, '대답 하지 마요');
  check('봇이 방금 말한 뒤의 「대답 하지 마」도 봇에게 한 말', (h['noReplyAt'].get(ROOM) ?? 0) > 0);
}

// 만들던 답 — 턴이 도는 사이 「대답하지마」가 오면 먼저 나선 답은 버리고, 부른 답은 낸다
for (const forced of [false, true]) {
  const h = make();
  const said = [];
  h['say'] = async (_c, _ch, text) => { said.push(text); };
  h['react'] = async () => {};
  h['runTurn'] = async () => {
    h['humanSpoke'](ROOM, '으아악 대답하지마');          // 답을 만드는 도중에 온다
    return { reply: '3층을 예약하여 음식을 시켜 모신다면…', speak: true, error: null };
  };
  const client = { users: { info: async () => ({ user: { profile: { display_name: '사람' } } }) } };
  h['enqueue'](ROOM, { channel: ROOM, ts: '100.1', text: '사람: 3층 예약하고 시켜먹기....도 있습니다', react: forced, user: 'U2' });
  h['active'].add(ROOM);
  await h['pump'](client, ROOM, forced);
  check(forced ? '부른 턴(멘션)의 답은 「대답하지마」가 와도 낸다'
               : '먼저 나선 턴은 도중에 「대답하지마」가 오면 만든 답을 버린다(오늘 둘째 장면)',
        forced ? said.length === 1 : said.length === 0, said);
}

console.log('');
console.log(`통과 ${pass} / 실패 ${fails.length}`);
if (fails.length) { console.log(fails.map((f) => `  - ${f}`).join('\n')); process.exit(1); }
