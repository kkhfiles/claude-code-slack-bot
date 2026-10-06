/**
 * 「다른 방에서 최근 오간 말」 검사 — 실장이 1:1·시험 방에서 부를 때만 다른 방을 읽어 턴에 넘기나.
 *
 *   npm run check:xroom
 *
 * 왜 재나 — 방마다 대화가 따로라 시험 방의 봇이 다른 방에서 오간 말을 몰랐다(2026-10-06 실장 「다른 방에서
 * 이야기한 내용도 기억하고」). 다른 방 글을 넘기는 길은 **새는 길이 될 수 있어서** 넘기면 안 되는 자리를 같이 잰다:
 *   - 실원 턴 · 실원이 사는 방의 실장 턴에는 안 넘긴다
 *   - 시험 방은 누구나 볼 수 있는 공개 방이라 설정에서 공개로 표시한 방만 넘긴다(1:1 에는 맡은 방 전부)
 *   - 맡지 않은 방은 안 읽는다 · 멘션은 이름으로 바꿔 아이디가 프롬프트로 안 간다 · 설정을 끄면 아무것도 안 넘긴다
 */
import './lib/fresh-dist.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xroom-'));
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
const TEST = 'C_TEST';       // 시험 방(rules)
const PLAY = 'C_PLAY';       // 공개로 표시한 방
const SECRET = 'C_SECRET';   // 공개 표시 없는 방
const OTHER = 'C_OTHER';     // 맡지 않은 방(설정에도 없음)

function profileFor(cfg) {
  const root = path.join(tmp, `p${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(path.join(root, 'bots', 'lunch'), { recursive: true });
  fs.writeFileSync(path.join(root, 'bots', 'lunch', 'config.json'), JSON.stringify(cfg), 'utf-8');
  return path.join(root, 'turn.py');
}

const now = Date.now() / 1000;
const ROOM_MSGS = {
  [PLAY]: [   // 슬랙처럼 새것부터
    { ts: String(now - 60), user: ME, bot_id: 'B_ME', text: '방안을 올리옵니다' },
    { ts: String(now - 120), user: 'U2', text: `<@${ME}> 예약도 해 주나요`, reply_count: 2 },
    { ts: String(now - 180), user: 'U3', subtype: 'channel_join', text: '들어옴' },
  ],
  [SECRET]: [{ ts: String(now - 90), user: 'U4', text: '비밀 방 이야기' }],
  [OTHER]: [{ ts: String(now - 90), user: 'U5', text: '맡지 않은 방' }],
};
const read = [];
const client = {
  users: { info: async ({ user }) => ({ user: { profile: { display_name: { U2: '홍길동', U4: '김철수', [ME]: '소인' }[user] ?? '' } } }) },
  conversations: {
    history: async ({ channel }) => { read.push(channel); return { messages: ROOM_MSGS[channel] ?? [] }; },
  },
};

function make(cfg) {
  const host = new ChatHost({
    name: 'lunch', botToken: '', appToken: '', python: '', script: profileFor(cfg),
    surfaces: ['channel', 'dm'], channels: [TEST, PLAY, SECRET], managerUserId: MGR,
    buttIn: { quietMinutes: 0, dailyCap: 99 },
  });
  host['selfUserId'] = ME;
  return host;
}

const ON = { rooms_recent: true, rooms: { [TEST]: { rules: true }, [PLAY]: { public: true }, [SECRET]: {} } };
const rooms = (x) => (x.rooms_recent ?? []).map((r) => r.room).sort();

{
  read.length = 0;
  const got = await make(ON)['roomsRecent'](client, MGR, new Set([MGR]));
  check('실장 1:1 — 맡은 방 전부(공개 표시 없는 방도 · 지금 방 빼고)',
    JSON.stringify(rooms(got)) === JSON.stringify([PLAY, SECRET].sort()), got);
  check('맡지 않은 방은 읽지도 않는다', !read.includes(OTHER), read);
  const play = (got.rooms_recent ?? []).find((r) => r.room === PLAY)?.lines ?? [];
  check('오래된 것부터 · 입장 알림(subtype)은 뺀다',
    play.length === 2 && play[0].text.includes('예약도') && play[1].self === true, play);
  check('멘션은 이름으로 — 아이디가 프롬프트로 안 간다',
    play[0].text.includes('@소인') && !JSON.stringify(play).includes(ME) && play[0].who === '홍길동', play[0]);
  check('답글 수가 붙는다', play[0].replies === 2, play[0]);
}
{
  const got = await make(ON)['roomsRecent'](client, TEST, new Set([MGR]));
  check('시험 방 — 공개로 표시한 방만(누구나 보는 방이라)', JSON.stringify(rooms(got)) === JSON.stringify([PLAY]), got);
}
{
  const got = await make(ON)['roomsRecent'](client, PLAY, new Set([MGR]));
  check('실원이 사는 방에서는 실장 턴이어도 안 넘긴다', !got.rooms_recent, got);
}
{
  const got = await make(ON)['roomsRecent'](client, TEST, new Set([MGR, 'U2']));
  check('실원 말이 섞인 턴에는 안 넘긴다', !got.rooms_recent, got);
}
{
  const got = await make(ON)['roomsRecent'](client, 'U2', new Set(['U2']));
  check('실원 1:1 에는 안 넘긴다', !got.rooms_recent, got);
}
{
  const got = await make({ ...ON, rooms_recent: false })['roomsRecent'](client, MGR, new Set([MGR]));
  check('설정을 끈 봇은 아무것도 안 넘긴다', !got.rooms_recent, got);
}
{
  const broken = { ...client, conversations: { history: async ({ channel }) => {
    if (channel === SECRET) throw new Error('not_in_channel');
    return { messages: ROOM_MSGS[channel] ?? [] };
  } } };
  const got = await make(ON)['roomsRecent'](broken, MGR, new Set([MGR]));
  check('못 읽은 방은 빼고 나머지는 그대로', JSON.stringify(rooms(got)) === JSON.stringify([PLAY]), got);
}

console.log(`\n${pass}개 통과${fails.length ? ` · ${fails.length}개 실패: ${fails.join(', ')}` : ''}`);
process.exit(fails.length ? 1 : 0);
