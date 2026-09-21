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

const { LetterInitiative } = await import('../dist/letter-initiative.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-initiative-'));
const script = path.join(dir, 'fake_pulse.py');
fs.writeFileSync(script, [
  'import json, os, sys',
  'if os.environ.get("FAKE_PULSE_FAIL") == "1": sys.exit(3)',
  'print(json.dumps({"workday": os.environ.get("FAKE_WORKDAY", "1") == "1", "week_first": os.environ.get("FAKE_WEEK_FIRST", "1") == "1", "brief": "[네 현황판 · 가짜]"}))',
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
// 방의 지난 7일 — 사람 말 둘, 커피콩 글 하나(답글 둘: 사람 하나·커피콩 하나), 소인 말 하나, 들어옴 하나.
const ROOM = [
  { ts: '5', user: 'U_HGD', text: '회의가 길어지는 게 <@U_CS> 말대로 문제예요' },
  { ts: '4', user: 'U_BEAN', bot_id: 'B1', text: '요즘 회의 어떠세요? 한 줄만 남겨 주세요', reply_count: 2 },
  { ts: '3', user: 'U_SOIN', bot_id: 'B2', text: '오늘 점심은 김치찌개!' },
  { ts: '2', user: 'U_CS', text: '저는 아침 회의가 좋아요 <#C_CHAT|coffee>' },
  { ts: '1', user: 'U_HGD', subtype: 'channel_join', text: 'has joined' },
];
const REPLIES = {
  4: [{ ts: '4', user: 'U_BEAN', bot_id: 'B1', text: '요즘 회의 어떠세요?' },
      { ts: '4.1', user: 'U_CS', text: '짧게만 하면 좋겠어요' },
      { ts: '4.2', user: 'U_BEAN', bot_id: 'B1', text: '고마워요!' }],
};
function fakeClient(extra = {}) {
  const dm = [];
  return {
    dm,
    auth: { test: async () => ({ user_id: 'U_BEAN' }) },
    users: { info: async ({ user }) => ({ user: { profile: { real_name: user === 'U_HGD' ? '홍길동' : '김철수', display_name: '' } } }) },
    conversations: {
      open: async ({ users }) => ({ channel: { id: `DM_${users}` } }),
      history: async () => ({ messages: ROOM }),
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

// ── 시각 · 창 · 하루 한 번 ──────────────────────────────────────────────────
{
  const { it, host, offered } = make();
  ok('시각 전에는 안 돈다', (await it.tick(fakeClient(), new Date(2026, 8, 21, 12, 59))) === 'not-time');
  ok('창(두 시간)이 지나면 그날은 안 돈다 — 저녁 재시작이 낮의 일을 대신 안 한다',
    (await it.tick(fakeClient(), new Date(2026, 8, 21, 15, 0))) === 'not-time' && host.calls.length === 0);
  const first = await it.tick(fakeClient(), MON);
  ok('시각이 되면 돈다', first === 'proposed' && offered.length === 1, first);
  ok('같은 날 다시는 안 돈다 (도중에 깨져도 두 번 안 돌게 먼저 적는다)',
    (await it.tick(fakeClient(), new Date(2026, 8, 21, 13, 5))) === 'done-today' && offered.length === 1);
}
{
  // 상태 파일을 못 쓰는 PC — 폴더를 파일 자리에 둬서 흉내 낸다. 그래도 하루 한 번이어야 한다.
  const { it, host, offered } = make({ statePath: path.join(dir, 'state-dir-as-file') });
  fs.mkdirSync(it['opts'].statePath, { recursive: true });
  await it.tick(fakeClient(), MON);
  await it.tick(fakeClient(), new Date(2026, 8, 21, 13, 1));
  await it.tick(fakeClient(), new Date(2026, 8, 21, 13, 2));
  ok('상태 파일을 못 써도 하루 한 번만 돈다 (메모리 표시)', offered.length === 1 && host.calls.length === 1, host.calls.length);
}

// ── 공휴일 · 실장이 끈 것 · 현황판 실패 ────────────────────────────────────
{
  process.env.FAKE_WORKDAY = '0';
  const { it, host } = make();
  ok('쉬는 날에는 안 온다 (모델도 안 부른다)', (await it.runOnce(fakeClient(), MON)) === 'holiday' && host.calls.length === 0);
  delete process.env.FAKE_WORKDAY;
}
{
  // 주 첫 업무일 판정은 파이썬 몫 — 월요일이 쉬면 화요일이 첫날이다. 여기서는 그 답만 받는다.
  process.env.FAKE_WEEK_FIRST = '0';
  const { it, host } = make();
  ok('그 주 첫 업무일이 아니면 안 온다 (모델도 안 부른다)',
    (await it.runOnce(fakeClient(), new Date(2026, 8, 22, 13, 0))) === 'not-week-first' && host.calls.length === 0);
  delete process.env.FAKE_WEEK_FIRST;
}
{
  // 옛 파이썬(week_first 칸 없음)이면 돌지 않는다 — 매일 도는 것보다 안 도는 쪽이 낫고, 로그에 남는다.
  const old = path.join(dir, 'old_pulse.py');
  fs.writeFileSync(old, 'import json; print(json.dumps({"workday": True, "brief": "[네 현황판 · 옛 판]"}))', 'utf-8');
  const { it, host } = make({ script: old });
  ok('현황판에 week_first 가 없으면(옛 파이썬) 안 돈다', (await it.runOnce(fakeClient(), MON)) === 'no-brief' && host.calls.length === 0);
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
  ok('커피콩 글 아래 답글은 어느 글에 단 답인지와 함께 · 커피콩 자신의 답글은 뺀다',
    brief.includes('(네 글 「요즘 회의 어떠세요? 한 줄만 남겨 주세요」에 단 답) 짧게만 하면 좋겠어요') && !brief.includes('고마워요!'), brief);
  ok('다른 봇(소인)의 말과 들어옴 같은 것은 뺀다', !brief.includes('김치찌개') && !brief.includes('has joined'), brief);
  ok('커피콩 자신의 글은 사람 말로 안 싣는다', !brief.includes('- 요즘 회의 어떠세요? 한 줄만'), brief);
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
