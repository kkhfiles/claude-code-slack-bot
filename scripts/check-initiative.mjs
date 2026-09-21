/**
 * 커피콩 주간 시계(`letter-initiative.ts`)를 슬랙·모델 없이 센다.
 *
 *     npm run check:initiative   (dist 가 낡았으면 멈춘다)
 *
 * 말은 가짜 호스트가 돌려주고, 현황판은 임시 파이썬 파일이 낸다. 보는 것 — 꺼짐 조건 ·
 * 시각·창·하루 한 번 · 공휴일 · **주 첫 업무일이 아니면 안 돎** · 실장이 말로 끈 것 · 현황판
 * 실패 · **방의 지난 7일을 글쓴이 없이 들고 감** · **방에 직접 올리는 길이 없음**(카드로만) ·
 * 실장 DM 인사 · 이름 빗장 · 길이 · 조용한 주.
 */
import './lib/fresh-dist.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { LetterInitiative, lastWeekMonday, mondayOf } = await import('../dist/letter-initiative.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-initiative-'));
const script = path.join(dir, 'fake_pulse.py');
fs.writeFileSync(script, [
  'import json, os, sys',
  'if os.environ.get("FAKE_PULSE_FAIL") == "1": sys.exit(3)',
  'print(json.dumps({"workday": os.environ.get("FAKE_WORKDAY", "1") == "1", "brief": "[네 현황판 · 가짜]"}))',
  '',
].join('\n'), 'utf-8');

let fail = 0;
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) { fail++; if (detail) console.log(`      ${String(detail).slice(0, 300)}`); }
};

const PROPOSAL = '요즘 커피챗 어떠셨어요? 이번 주에 한 번씩만 남겨 볼까요?';
// 가짜 호스트 — 무슨 말을 할지는 각 검사가 정한다.
function fakeHost() {
  const calls = [];
  let next = { reply: '방이 조용해서 오늘 가볍게 말 걸어 볼게요.', speak: true, error: null,
               ask: [{ name: 'pulse', text: PROPOSAL }] };
  return {
    calls,
    set: (r) => { next = r; },
    initiate: async (_c, key, brief, name) => { calls.push({ key, brief, name }); return next; },
  };
}
// 방의 이력 — ts 는 실제 슬랙 꼴(초). 지난주 월요일(9/14) 0시를 기준으로 그 뒤 것이 「말」이고,
// 뿌리는 3주 전까지 훑되 답만 지난주부터 싣는다.
const T = (d, h = 9) => String(new Date(2026, 8, d, h).getTime() / 1000);
// 사람 말 둘 · 커피콩 글 하나(답글 둘: 사람·커피콩) · 소인 말 하나(답글 있음) · 들어옴 하나 ·
// **2주 전 커피콩 글**(답글 하나는 지난주에, 하나는 그 전에) · **지난주보다 오래된 사람 말** · 팀 멘션.
const ROOM = [
  { ts: T(18), user: 'U_HGD', text: '회의가 길어지는 게 <@U_CS> 말대로 문제예요 <!subteam^S1|@dyn> <!here>' },
  { ts: T(16), user: 'U_BEAN', bot_id: 'B1', text: '요즘 회의 어떠세요? 한 줄만 남겨 주세요', reply_count: 2, latest_reply: T(17) },
  { ts: T(15), user: 'U_SOIN', bot_id: 'B2', text: '오늘 점심은 김치찌개!', reply_count: 1, latest_reply: T(15, 10) },
  { ts: T(14, 8), user: 'U_CS', text: '저는 아침 회의가 좋아요 <#C_CHAT|coffee>', reply_count: 1, latest_reply: T(14, 9) },
  { ts: T(14, 7), user: 'U_HGD', subtype: 'channel_join', text: 'has joined' },
  { ts: T(7), user: 'U_BEAN', bot_id: 'B1', text: '지난달 회고 어떠셨어요?', reply_count: 2, latest_reply: T(15, 11) },
  { ts: T(11), user: 'U_CS', text: '이건 지난주보다 오래된 말' },
];
const REPLIES = {
  [T(16)]: [{ ts: T(16), user: 'U_BEAN', bot_id: 'B1', text: '요즘 회의 어떠세요?' },
            { ts: T(16, 10), user: 'U_CS', text: '짧게만 하면 좋겠어요' },
            { ts: T(17), user: 'U_BEAN', bot_id: 'B1', text: '고마워요!' }],
  [T(14, 8)]: [{ ts: T(14, 8), user: 'U_CS', text: '저는 아침 회의가 좋아요' },
               { ts: T(14, 9), user: 'U_HGD', text: '저는 오후가 낫던데요' }],
  [T(15)]: [{ ts: T(15), user: 'U_SOIN', bot_id: 'B2', text: '오늘 점심은 김치찌개!' },
            { ts: T(15, 10), user: 'U_HGD', text: '김치찌개 좋죠' }],
  [T(7)]: [{ ts: T(7), user: 'U_BEAN', bot_id: 'B1', text: '지난달 회고 어떠셨어요?' },
           { ts: T(8), user: 'U_CS', text: '그 전 주에 단 옛 답' },
           { ts: T(15, 11), user: 'U_HGD', text: '늦었지만 회고는 짧아서 좋았어요' }],
};
const seenOldest = [];
// 이력은 **두 장**으로 준다 — 새 것부터 넷, 그다음 나머지. 한 장만 읽으면 2주 전 글이 빠진다.
const PAGE = 4;
const historyPages = (all) => (args) => {
  seenOldest.push(args.oldest);
  const sorted = [...all].sort((a, b) => Number(b.ts) - Number(a.ts));
  const from = args.cursor ? Number(args.cursor) : 0;
  const slice = sorted.slice(from, from + PAGE);
  const next = from + PAGE < sorted.length ? String(from + PAGE) : '';
  return { messages: slice, response_metadata: { next_cursor: next } };
};
function fakeClient(extra = {}) {
  const dm = [];
  return {
    dm,
    auth: { test: async () => ({ user_id: 'U_BEAN' }) },
    users: { info: async ({ user }) => ({ user: { profile: { real_name: user === 'U_HGD' ? '홍길동' : '김철수', display_name: '' } } }) },
    conversations: {
      open: async ({ users }) => ({ channel: { id: `DM_${users}` } }),
      history: async (args) => historyPages(ROOM)(args),
      replies: async ({ ts }) => ({ messages: REPLIES[ts] || [] }),
    },
    chat: { postMessage: async (m) => { dm.push(m); return { ts: '1' }; } },
    ...extra,
  };
}
let n = 0;
const make = (extra = {}, host = fakeHost()) => {
  n += 1;
  const offered = [];
  const it = new LetterInitiative({
    enabled: true, at: '13:00', room: 'C_CHAT', managerUserId: 'U_BOSS', managerName: '실장',
    python: 'python', script,
    statePath: path.join(dir, `state${n}.json`), controlPath: path.join(dir, `control${n}.json`),
    host, offer: async (_c, asks, from) => { offered.push({ asks, from }); }, ...extra,
  });
  return { it, host, offered };
};
const MON = new Date(2026, 8, 21, 13, 0);   // 월요일 13:00

// ── 꺼짐 ────────────────────────────────────────────────────────────────────
ok('LETTER_INITIATIVE 가 1이 아니면 꺼진다', make({ enabled: false }).it.enabled === false);
ok('방이 비면 꺼진다', make({ room: '' }).it.enabled === false);
ok('실장이 비면 꺼진다', make({ managerUserId: '' }).it.enabled === false);
ok('카드 길(offer)이 없으면 꺼진다 — 「카드 드리겠다」고 답해 놓고 카드가 안 오면 안 된다', make({ offer: undefined }).it.enabled === false);
{
  const { it, host } = make({ enabled: false });
  ok('꺼졌으면 돌지 않는다', (await it.runOnce(fakeClient(), MON)) === 'off' && host.calls.length === 0);
}

// ── 시각 · 창 · 한 주에 한 번 ─────────────────────────────────────────────
{
  const { it, host, offered } = make();
  ok('시각 전에는 안 돈다', (await it.tick(fakeClient(), new Date(2026, 8, 21, 12, 59))) === 'not-time');
  ok('창(두 시간)이 지나면 그날은 안 돈다 — 저녁 재시작이 낮의 일을 대신 안 한다',
    (await it.tick(fakeClient(), new Date(2026, 8, 21, 15, 0))) === 'not-time' && host.calls.length === 0);
  const first = await it.tick(fakeClient(), MON);
  ok('시각이 되면 돈다', first === 'proposed' && offered.length === 1, first);
  ok('같은 날 다시는 안 돈다 (도중에 깨져도 두 번 안 돌게 먼저 적는다)',
    (await it.tick(fakeClient(), new Date(2026, 8, 21, 13, 5))) === 'done-this-week' && offered.length === 1);
  ok('같은 주 화요일에도 안 돈다 — 한 주에 한 번',
    (await it.tick(fakeClient(), new Date(2026, 8, 22, 13, 0))) === 'done-this-week' && offered.length === 1);
  ok('다음 주 월요일에는 다시 돈다',
    (await it.tick(fakeClient(), new Date(2026, 8, 28, 13, 0))) === 'proposed' && offered.length === 2);
}
{
  // 월요일 창을 통째로 놓쳤다(PC 꺼짐) — 화요일 같은 창에서 돈다. 한 주 손해가 안 되게(검토 2026-09-21).
  const { it, host, offered } = make();
  ok('월요일을 놓치면 화요일 13:00 에 돈다', (await it.tick(fakeClient(), new Date(2026, 8, 22, 13, 0))) === 'proposed' && offered.length === 1);
  ok('그 뒤 수요일에는 안 돈다', (await it.tick(fakeClient(), new Date(2026, 8, 23, 13, 0))) === 'done-this-week' && host.calls.length === 1);
}
{
  // 월요일이 쉬는 날 — 그날은 매분 파이썬을 안 부르고, 화요일에 돈다.
  process.env.FAKE_WORKDAY = '0';
  const { it, host, offered } = make();
  ok('쉬는 월요일은 holiday', (await it.tick(fakeClient(), MON)) === 'holiday' && host.calls.length === 0);
  ok('쉬는 날은 그날 다시 안 본다', (await it.tick(fakeClient(), new Date(2026, 8, 21, 13, 1))) === 'done-today');
  delete process.env.FAKE_WORKDAY;
  ok('쉬는 월요일 다음 화요일에 돈다', (await it.tick(fakeClient(), new Date(2026, 8, 22, 13, 0))) === 'proposed' && offered.length === 1);
}
{
  // 현황판을 못 만든 분 — 모델도 DM 도 없었으니 표시를 되돌려 다음 분에 다시. 한 번 넘어진 것이 한 주를 먹지 않게.
  process.env.FAKE_PULSE_FAIL = '1';
  const { it, host, offered } = make();
  ok('현황판 실패는 no-brief', (await it.tick(fakeClient(), MON)) === 'no-brief' && host.calls.length === 0);
  delete process.env.FAKE_PULSE_FAIL;
  ok('다음 분에 다시 해서 돈다', (await it.tick(fakeClient(), new Date(2026, 8, 21, 13, 1))) === 'proposed' && offered.length === 1);
}
{
  // 상태 파일을 못 쓰는 PC — 폴더를 파일 자리에 둬서 흉내 낸다. 그래도 한 주에 한 번이어야 한다.
  const { it, host, offered } = make({ statePath: path.join(dir, 'state-dir-as-file') });
  fs.mkdirSync(it['opts'].statePath, { recursive: true });
  await it.tick(fakeClient(), MON);
  await it.tick(fakeClient(), new Date(2026, 8, 21, 13, 1));
  await it.tick(fakeClient(), new Date(2026, 8, 22, 13, 0));
  ok('상태 파일을 못 써도 한 주에 한 번만 돈다 (메모리 표시)', offered.length === 1 && host.calls.length === 1, host.calls.length);
}

// ── 공휴일 · 실장이 끈 것 · 현황판 실패 ────────────────────────────────────
{
  process.env.FAKE_WORKDAY = '0';
  const { it, host } = make();
  ok('쉬는 날에는 안 온다 (모델도 안 부른다)', (await it.runOnce(fakeClient(), MON)) === 'holiday' && host.calls.length === 0);
  delete process.env.FAKE_WORKDAY;
}
{
  const { it, host } = make();
  fs.writeFileSync(it['opts'].controlPath, JSON.stringify({ always: { initiative: false } }), 'utf-8');
  ok('실장이 말로 꺼 두면 안 돈다', (await it.runOnce(fakeClient(), MON)) === 'off' && host.calls.length === 0);
}
{
  const { it, host } = make();
  fs.writeFileSync(it['opts'].controlPath, JSON.stringify({ today: { date: '2026-09-21', initiative: false } }), 'utf-8');
  ok('「오늘만 꺼」는 그날만 먹는다', (await it.runOnce(fakeClient(), MON)) === 'off' && host.calls.length === 0);
  ok('어제 걸어 둔 「오늘만 꺼」는 오늘 안 먹는다', (await it.runOnce(fakeClient(), new Date(2026, 8, 22, 13, 0))) === 'proposed');
}
{
  const { it, host } = make();
  fs.writeFileSync(it['opts'].controlPath, '{ "always": { "initiative": fal', 'utf-8');   // 다시 쓰는 도중 · 깨진 파일
  ok('설정 파일이 깨져 있으면 꺼진 쪽으로 (「자율 꺼」를 놓치지 않게)', (await it.runOnce(fakeClient(), MON)) === 'off' && host.calls.length === 0);
}
{
  const { it } = make();
  ok('설정 파일이 아예 없으면 켜진 것 (끈 적이 없다)', (await it.runOnce(fakeClient(), MON)) === 'proposed');
}
{
  process.env.FAKE_PULSE_FAIL = '1';
  const { it, host } = make();
  ok('현황판을 못 만들면 안 온다', (await it.runOnce(fakeClient(), MON)) === 'no-brief' && host.calls.length === 0);
  delete process.env.FAKE_PULSE_FAIL;
}

// ── 아침 DM — 실장에게 말하고, 방에 걸 글은 카드로만 ──────────────────────────
{
  const { it, host, offered } = make();
  const c = fakeClient();
  const r = await it.runOnce(c, MON);
  ok('현황판을 들고 **주간 전용 대화**(실장 DM 과 따로)로 턴을 부른다 — 실장 DM 기억을 안 안고 돈다',
    host.calls[0]?.key === 'U_BOSS-morning' && host.calls[0]?.brief.includes('네 현황판') && host.calls[0]?.name === '실장', host.calls);
  // 취합할 재료 — 방의 지난 7일. 글쓴이 없이 · 멘션 지우고 · 커피콩 글 아래 답은 그 글과 짝지어.
  const brief = host.calls[0]?.brief || '';
  ok('방에서 사람들이 한 말이 현황판 뒤에 붙는다 (글쓴이는 없다)',
    brief.includes('회의가 길어지는') && brief.includes('아침 회의가 좋아요') && !brief.includes('U_HGD') && !brief.includes('U_CS'), brief);
  ok('멘션·방 링크는 지운다', brief.includes('@누군가 말대로') && brief.includes('#coffee') && !brief.includes('<@') && !brief.includes('<#'), brief);
  ok('팀 멘션·@here 도 지운다', brief.includes('@어느 팀') && brief.includes('@모두') && !brief.includes('<!'), brief);
  ok('커피콩 글 아래 답글은 어느 글에 단 답인지와 함께 · 커피콩 자신의 답글은 뺀다',
    brief.includes('(네 글 「요즘 회의 어떠세요? 한 줄만 남겨 주세요」에 단 답) 짧게만 하면 좋겠어요') && !brief.includes('고마워요!'), brief);
  ok('다른 봇(소인)의 말과 그 스레드, 들어옴 같은 것은 뺀다', !brief.includes('김치찌개') && !brief.includes('has joined'), brief);
  ok('남의 글 아래 스레드도 읽는다 — 어느 글에 단 답인지와 함께',
    brief.includes('(위 「저는 아침 회의가 좋아요 #coffee」에 단 답) 저는 오후가 낫던데요'), brief);
  ok('커피콩 자신의 글은 사람 말로 안 싣는다', !brief.includes('- 요즘 회의 어떠세요? 한 줄만'), brief);
  // 뿌리는 **3주 전 월요일부터** 훑고(2주 전 물음에 지난주 달린 답을 읽으려고), 말은 지난주 월요일 0시부터.
  const want = String(Math.floor(new Date(2026, 8, 0, 0, 0).getTime() / 1000));   // 8/31 월
  ok('방 이력은 3주 전 월요일부터 읽는다', seenOldest[seenOldest.length - 1] === want, [seenOldest[seenOldest.length - 1], want]);
  ok('이력이 여러 장이면 끝까지 넘긴다 (한 장만 읽으면 오래된 뿌리부터 빠진다)',
    brief.includes('늦었지만 회고는 짧아서 좋았어요'), brief);
  ok('2주 전 물음에 지난주 달린 답은 싣고, 그 전에 달린 답은 안 싣는다',
    brief.includes('(네 글 「지난달 회고 어떠셨어요?」에 단 답) 늦었지만') && !brief.includes('그 전 주에 단 옛 답'), brief);
  ok('지난주보다 오래된 사람 말은 안 싣는다', !brief.includes('지난주보다 오래된 말'), brief);
  ok('lastWeekMonday — 화요일에 물어도 · 월요일 0시 직후에 물어도 · 일요일 밤에 물어도 지난주 월요일',
    lastWeekMonday(new Date(2026, 8, 22, 13, 0)).getTime() === new Date(2026, 8, 14).getTime()
    && lastWeekMonday(new Date(2026, 8, 21, 0, 1)).getTime() === new Date(2026, 8, 14).getTime()
    && lastWeekMonday(new Date(2026, 8, 27, 23, 59)).getTime() === new Date(2026, 8, 14).getTime());
  ok('mondayOf — 이번 주·3주 전', mondayOf(MON).getTime() === new Date(2026, 8, 21).getTime()
    && mondayOf(MON, 3).getTime() === new Date(2026, 7, 31).getTime());
  ok('실장에게 하는 말이 DM 으로 간다', c.dm.some((m) => m.channel === 'DM_U_BOSS' && m.text.includes('가볍게 말 걸어 볼게요')), c.dm);
  ok('방에 걸 글은 카드(offer)로만 간다', r === 'proposed' && offered.length === 1 && offered[0].asks[0].text === PROPOSAL, offered);
  ok('카드는 실장 이름으로, DM 자리로', offered[0].from.user === 'U_BOSS' && offered[0].from.channel === 'DM');
  ok('방에 직접 올리는 길이 없다 (DM 말고는 아무 데도 안 보냈다)', c.dm.every((m) => m.channel === 'DM_U_BOSS'));
}
{
  const { it, host } = make();
  const c = fakeClient({ conversations: { open: async ({ users }) => ({ channel: { id: `DM_${users}` } }), history: async () => { throw new Error('missing_scope'); } } });
  const r = await it.runOnce(c, MON);
  ok('방의 지난 7일을 못 읽어도 숫자만 들고 돈다 (턴을 거르지 않는다)',
    r === 'proposed' && host.calls[0]?.brief === '[네 현황판 · 가짜]', [r, host.calls[0]?.brief]);
}
{
  const { it, host, offered } = make();
  host.set({ reply: '오늘은 조용히 있을게요.', speak: true, error: null, ask: [] });
  const c = fakeClient();
  ok('걸 글이 없으면 인사만 하고 카드는 없다',
    (await it.runOnce(c, MON)) === 'quiet' && offered.length === 0 && c.dm.some((m) => m.text.includes('조용히')));
}
{
  const { it, host, offered } = make();
  host.set({ reply: '', speak: false, error: null });
  const c = fakeClient();
  ok('아무 말도 없으면 조용하다', (await it.runOnce(c, MON)) === 'quiet' && offered.length === 0 && c.dm.length === 0);
}
{
  const { it, host, offered } = make();
  host.set({ reply: '오늘은 이렇게요.', speak: true, error: null, ask: [{ name: 'notice', text: '철수님 생일 축하해요!' }] });
  ok('다른 갈래도 카드로 간다 (파이썬이 「카드 드리겠다」고 답했으니) · 이름 빗장은 pulse 에만',
    (await it.runOnce(fakeClient(), MON)) === 'proposed' && offered.length === 1 && offered[0].asks[0].name === 'notice', offered);
}
{
  const { it, host, offered } = make();
  host.set({ reply: '오늘은 이렇게요.', speak: true, error: null, ask: [{ name: 'pulse', text: '길동님은 아직 안 남기셨네요' }] });
  ok('이름·숫자 빗장은 여기가 아니라 카드 쪽(LetterNotice.guard)이 건다 — 시계는 그대로 카드로 넘긴다',
    (await it.runOnce(fakeClient(), MON)) === 'proposed' && offered.length === 1);
}
{
  const { it, host, offered } = make();
  host.set({ reply: '오늘은 이렇게요.', speak: true, error: null, ask: [{ name: 'pulse', text: 42 }, { name: 7 }, null] });
  let crashed = false;
  try { await it.runOnce(fakeClient(), MON); } catch { crashed = true; }
  ok('모델이 엉뚱한 꼴의 부탁을 줘도 시계가 안 죽는다', crashed === false && offered.length === 1 && offered[0].asks.length === 1);
}
{
  const { it, host, offered } = make();
  host.set({ reply: '', speak: true, error: 'turn.py 응답 없음' });
  const c = fakeClient();
  ok('턴이 실패하면 아무것도 안 나간다', (await it.runOnce(c, MON)) === 'error' && offered.length === 0 && c.dm.length === 0);
}

console.log(`\n${fail ? `실패 ${fail}건` : '모두 통과.'}`);
fs.rmSync(dir, { recursive: true, force: true });
process.exitCode = fail ? 1 : 0;
