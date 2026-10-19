/**
 * 「자기 글 답글」과 「실장께 알리기」 검사.
 *
 *   npm run check:ownthreads
 *
 * 왜 재나 — 한 방에서 사람들이 「스레드에 올렸잖아」·「이 스레드 직접 봐」라고 했는데 봇은 답글 수만 받아 「볼 수 없다」고만
 * 했고, 주인은 방을 직접 읽고서야 알았다(2026-10-19). 그 모양 그대로 잰다:
 *   - 맡은 방 턴 · 말에 스레드 이야기 → 봇 글에 달린 답글을 넘긴다(남의 글 스레드는 안 읽는다)
 *   - 1:1 · 맡지 않은 방 · 스레드 이야기 없음 · 설정 꺼짐 → 아무것도 안 읽는다
 *   - 실장께 알리기는 같은 방이면 30분에 한 번 · 주인 DM 으로만
 */
import './lib/fresh-dist.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ownthreads-'));
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
const ROOM = 'C_ROOM';
const OTHER = 'C_OTHER';   // 맡지 않은 방

function profileFor(cfg) {
  const root = path.join(tmp, `p${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(path.join(root, 'bots', 'lunch'), { recursive: true });
  fs.writeFileSync(path.join(root, 'bots', 'lunch', 'config.json'), JSON.stringify(cfg), 'utf-8');
  return path.join(root, 'turn.py');
}

const now = Date.now() / 1000;
const HISTORY = [   // 슬랙처럼 새것부터
  { ts: String(now - 60), user: ME, text: '투표를 엽니다' },
  { ts: String(now - 3600), user: 'U2', text: '사람 글', reply_count: 4 },
  { ts: String(now - 7200), user: ME, text: '수요일 모임 후보를 받습니다', reply_count: 3 },
];
const REPLIES = {
  [HISTORY[2].ts]: [HISTORY[2],
    { ts: String(now - 7100), user: 'U2', text: '<https://example.com/a|example.com/a>' },
    { ts: String(now - 7000), user: 'U3', text: `<@${ME}> 여기 휴무래요` },
    { ts: String(now - 6900), user: ME, text: '알겠습니다' }],
  [HISTORY[1].ts]: [HISTORY[1], { ts: String(now - 3500), user: 'U4', text: '잡담' }],
};
const read = { history: [], replies: [] };
const sent = [];
const client = {
  users: { info: async ({ user }) => ({ user: { profile: { display_name: { U2: '홍길동', U3: '김철수' }[user] ?? '' } } }) },
  conversations: {
    history: async ({ channel }) => { read.history.push(channel); return { messages: HISTORY }; },
    replies: async ({ ts }) => { read.replies.push(ts); return { messages: REPLIES[ts] ?? [] }; },
    open: async () => ({ channel: { id: 'D_MGR' } }),
  },
  chat: { postMessage: async (m) => { sent.push(m); return { ok: true }; } },
};

function make(cfg) {
  const host = new ChatHost({
    name: 'lunch', botToken: '', appToken: '', python: '', script: profileFor(cfg),
    surfaces: ['channel', 'dm'], channels: [ROOM], managerUserId: MGR,
    buttIn: { quietMinutes: 0, dailyCap: 99 },
  });
  host['selfUserId'] = ME;
  return host;
}
const reset = () => { read.history.length = 0; read.replies.length = 0; };

{
  reset();
  const got = await make({ own_threads: true })['ownThreads'](client, ROOM, '홍길동: @소인 우리가 쓰레드에 올렸잖아');
  const t = got.own_threads ?? [];
  check('맡은 방 · 스레드 이야기 — 봇 글에 달린 답글을 넘긴다', t.length === 1 && t[0].replies.length === 3, got);
  check('남의 글 스레드는 안 읽는다', !read.replies.includes(HISTORY[1].ts), read.replies);
  check('답글 수가 없는 봇 글은 안 읽는다', !read.replies.includes(HISTORY[0].ts), read.replies);
  const lines = JSON.stringify(t);
  check('멘션은 이름으로 바꿔 아이디가 안 간다 · 링크는 보이는 글자로', !lines.includes(ME) && lines.includes('example.com/a'), t);
  check('누가 썼는지 이름이 붙고 봇 자신은 표시만', t[0]?.replies[0]?.who === '홍길동' && t[0]?.replies[2]?.self === true, t);
}
for (const [name, cfg, key, said] of [
  ['스레드 이야기가 없으면 안 읽는다', { own_threads: true }, ROOM, '홍길동: 점심 뭐 먹어요'],
  ['1:1 에서는 안 읽는다', { own_threads: true }, MGR, '쓰레드 봐 줘'],
  ['맡지 않은 방은 안 읽는다', { own_threads: true }, OTHER, '쓰레드 봐 줘'],
  ['설정을 끄면 안 읽는다', {}, ROOM, '쓰레드 봐 줘'],
]) {
  reset();
  const got = await make(cfg)['ownThreads'](client, key, said);
  check(name, !got.own_threads && read.history.length === 0, { got, read });
}

{
  sent.length = 0;
  const host = make({});
  await host['tellManager'](client, ROOM, '투표가 스레드 추천을 빠뜨림');
  await host['tellManager'](client, ROOM, '같은 방 두 번째');
  check('실장께 알리기 — 주인 DM 으로 · 같은 방은 30분에 한 번',
    sent.length === 1 && sent[0].channel === 'D_MGR' && sent[0].text.includes('빠뜨림'), sent);
  await host['tellManager'](client, 'C_ELSE', '다른 방');
  check('다른 방이면 따로 센다', sent.length === 2, sent);
}

console.log('');
console.log(`통과 ${pass} / 실패 ${fails.length}`);
if (fails.length) { console.log(fails.map((f) => `  - ${f}`).join('\n')); process.exit(1); }
