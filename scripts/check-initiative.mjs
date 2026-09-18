/**
 * 커피콩 아침 시계(`letter-initiative.ts`)를 슬랙·모델 없이 센다.
 *
 *     npm run check:initiative   (dist 가 낡았으면 멈춘다)
 *
 * 말은 가짜 호스트가 돌려주고, 현황판은 임시 파이썬 파일이 낸다. 보는 것 — 꺼짐 조건 ·
 * 시각·창·하루 한 번 · 공휴일 · 실장이 말로 끈 것 · 현황판 실패 · **방에 직접 올리는 길이
 * 없음**(카드로만) · 실장 DM 인사 · 이름 빗장 · 길이 · 조용한 날.
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
    initiate: async (_c, key, brief) => { calls.push({ key, brief }); return next; },
  };
}
function fakeClient() {
  const dm = [];
  return {
    dm,
    users: { info: async ({ user }) => ({ user: { profile: { real_name: user === 'U_HGD' ? '홍길동' : '김철수', display_name: '' } } }) },
    conversations: { open: async ({ users }) => ({ channel: { id: `DM_${users}` } }) },
    chat: { postMessage: async (m) => { dm.push(m); return { ts: '1' }; } },
  };
}
let n = 0;
const make = (extra = {}, host = fakeHost()) => {
  n += 1;
  const offered = [];
  const it = new LetterInitiative({
    enabled: true, at: '08:30', room: 'C_CHAT', managerUserId: 'U_BOSS', members: ['U_HGD', 'U_CS'],
    python: 'python', script,
    statePath: path.join(dir, `state${n}.json`), controlPath: path.join(dir, `control${n}.json`),
    host, offer: async (_c, asks, from) => { offered.push({ asks, from }); }, ...extra,
  });
  return { it, host, offered };
};
const MON = new Date(2026, 8, 21, 8, 30);   // 월요일 08:30

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
  ok('시각 전에는 안 돈다', (await it.tick(fakeClient(), new Date(2026, 8, 21, 8, 29))) === 'not-time');
  ok('창(두 시간)이 지나면 그날은 안 돈다 — 저녁 재시작이 아침 일을 대신 안 한다',
    (await it.tick(fakeClient(), new Date(2026, 8, 21, 10, 30))) === 'not-time' && host.calls.length === 0);
  const first = await it.tick(fakeClient(), MON);
  ok('시각이 되면 돈다', first === 'proposed' && offered.length === 1, first);
  ok('같은 날 다시는 안 돈다 (도중에 깨져도 두 번 안 돌게 먼저 적는다)',
    (await it.tick(fakeClient(), new Date(2026, 8, 21, 8, 35))) === 'done-today' && offered.length === 1);
}
{
  // 상태 파일을 못 쓰는 PC — 폴더를 파일 자리에 둬서 흉내 낸다. 그래도 하루 한 번이어야 한다.
  const { it, host, offered } = make({ statePath: path.join(dir, 'state-dir-as-file') });
  fs.mkdirSync(it['opts'].statePath, { recursive: true });
  await it.tick(fakeClient(), MON);
  await it.tick(fakeClient(), new Date(2026, 8, 21, 8, 31));
  await it.tick(fakeClient(), new Date(2026, 8, 21, 8, 32));
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
  const { it, host } = make();
  fs.writeFileSync(it['opts'].controlPath, JSON.stringify({ always: { initiative: false } }), 'utf-8');
  ok('실장이 말로 꺼 두면 안 돈다', (await it.runOnce(fakeClient(), MON)) === 'off' && host.calls.length === 0);
}
{
  const { it, host } = make();
  fs.writeFileSync(it['opts'].controlPath, JSON.stringify({ today: { date: '2026-09-21', initiative: false } }), 'utf-8');
  ok('「오늘만 꺼」는 그날만 먹는다', (await it.runOnce(fakeClient(), MON)) === 'off' && host.calls.length === 0);
  ok('어제 걸어 둔 「오늘만 꺼」는 오늘 안 먹는다', (await it.runOnce(fakeClient(), new Date(2026, 8, 22, 8, 30))) === 'proposed');
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
  ok('현황판을 들고 **실장 열쇠**로 턴을 부른다 (방 열쇠가 아니다)',
    host.calls[0]?.key === 'U_BOSS' && host.calls[0]?.brief.includes('네 현황판'), host.calls);
  ok('실장에게 하는 말이 DM 으로 간다', c.dm.some((m) => m.channel === 'DM_U_BOSS' && m.text.includes('가볍게 말 걸어 볼게요')), c.dm);
  ok('방에 걸 글은 카드(offer)로만 간다', r === 'proposed' && offered.length === 1 && offered[0].asks[0].text === PROPOSAL, offered);
  ok('카드는 실장 이름으로, DM 자리로', offered[0].from.user === 'U_BOSS' && offered[0].from.channel === 'DM');
  ok('방에 직접 올리는 길이 없다 (DM 말고는 아무 데도 안 보냈다)', c.dm.every((m) => m.channel === 'DM_U_BOSS'));
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
  host.set({ reply: '오늘은 이렇게요.', speak: true, error: null, ask: [{ name: 'pulse', text: '길동님은 아직 안 남기셨네요, 이번 주엔 어떠세요?' }] });
  const c = fakeClient();
  const r = await it.runOnce(c, MON);
  ok('실원 이름(성 뗀 것)이 들어가면 카드를 안 만들고 실장에게 까닭을 말한다',
    r === 'blocked' && offered.length === 0 && c.dm.some((m) => m.text.includes('길동') && m.text.includes('막혀')), { r, dm: c.dm });
}
{
  const { it, host, offered } = make();
  host.set({ reply: '오늘은 이렇게요.', speak: true, error: null, ask: [{ name: 'pulse', text: '김철수 님 고마워요!' }] });
  ok('실원 이름(성 포함)도 막는다', (await it.runOnce(fakeClient(), MON)) === 'blocked' && offered.length === 0);
}
{
  const { it, host, offered } = make();
  host.set({ reply: '오늘은 이렇게요.', speak: true, error: null, ask: [{ name: 'pulse', text: '<@U_HGD> 어떠세요?' }] });
  ok('멘션은 호스트 빗장에서도 막는다 (두 겹)', (await it.runOnce(fakeClient(), MON)) === 'blocked' && offered.length === 0);
}
{
  const { it, host, offered } = make();
  host.set({ reply: '오늘은 이렇게요.', speak: true, error: null, ask: [{ name: 'pulse', text: PROPOSAL }] });
  let failing = true;
  const c = fakeClient();
  c.users.info = async ({ user }) => {
    if (failing) throw new Error('ratelimited');
    return { user: { profile: { real_name: user === 'U_HGD' ? '홍길동' : '김철수', display_name: '' } } };
  };
  const r1 = await it.runOnce(c, MON);
  ok('실원 이름을 못 받아 오면 막는다 (이름 빗장은 이 겹뿐이라 못 본 채 통과시키지 않는다)',
    r1 === 'blocked' && offered.length === 0 && c.dm.some((m) => m.text.includes('못 받아 옴')), { r1, dm: c.dm });
  failing = false;
  const r2 = await it.runOnce(c, new Date(2026, 8, 22, 8, 30));
  ok('실패는 캐시하지 않는다 — 다음 날 이름을 받아 오면 다시 돈다', r2 === 'proposed' && offered.length === 1, r2);
}
{
  const { it, host, offered } = make();
  host.set({ reply: '오늘은 이렇게요.', speak: true, error: null, ask: [{ name: 'pulse', text: '가'.repeat(1300) }] });
  ok('너무 긴 글은 막는다', (await it.runOnce(fakeClient(), MON)) === 'blocked' && offered.length === 0);
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
