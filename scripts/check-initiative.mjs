/**
 * 커피콩이 스스로 말을 거는 시계(`letter-initiative.ts`)의 빗장을 슬랙·모델 없이 센다.
 *
 *     npm run check:initiative   (dist 가 낡았으면 멈춘다)
 *
 * 말은 가짜 호스트가 돌려주고, 현황판은 임시 파이썬 파일이 낸다. 보는 것 — 꺼짐 조건 ·
 * 시각·하루 한 번 · 공휴일 · 실장이 말로 끈 것 · 침묵 · 파이썬 빗장이 막은 것 · 이름 빗장 ·
 * 길이 · 상한(하루 1·주 2) · 방에 올린 글이 실장 DM 으로 사본이 가는 것 · 수요일 주간 보고.
 */
import './lib/fresh-dist.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { LetterInitiative, DAILY_CAP, WEEKLY_CAP } = await import('../dist/letter-initiative.js');

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

// 가짜 호스트 — 무슨 말을 할지는 각 검사가 정한다.
function fakeHost() {
  const calls = []; const posted = [];
  let next = { reply: '요즘 커피챗 어떠셨어요? 이번 주에 한 번씩만 남겨 볼까요?', speak: true, error: null };
  return {
    calls, posted,
    set: (r) => { next = r; },
    initiate: async (_c, key, brief) => { calls.push({ key, brief }); return next; },
    post: async (_c, channel, text) => { posted.push({ channel, text }); return true; },
  };
}
function fakeClient() {
  const dm = [];
  return {
    dm,
    users: { info: async ({ user }) => ({ user: { profile: { real_name: user === 'U_KKH' ? '강규황' : '김철수', display_name: '' } } }) },
    conversations: { open: async ({ users }) => ({ channel: { id: `DM_${users}` } }) },
    chat: { postMessage: async (m) => { dm.push(m); return { ts: '1' }; } },
  };
}
let n = 0;
const make = (extra = {}, host = fakeHost()) => {
  n += 1;
  const it = new LetterInitiative({
    enabled: true, at: '10:00', room: 'C_CHAT', managerUserId: 'U_BOSS', members: ['U_KKH', 'U_CS'],
    python: 'python', script,
    logPath: path.join(dir, `log${n}.jsonl`), statePath: path.join(dir, `state${n}.json`),
    controlPath: path.join(dir, `control${n}.json`), reportDay: 3, host, ...extra,
  });
  return { it, host };
};
const MON = new Date(2026, 8, 21, 10, 0);   // 월요일 10:00
const WED = new Date(2026, 8, 23, 10, 0);   // 수요일

// ── 꺼짐 ────────────────────────────────────────────────────────────────────
ok('LETTER_INITIATIVE 가 1이 아니면 꺼진다', make({ enabled: false }).it.enabled === false);
ok('방이 비면 꺼진다', make({ room: '' }).it.enabled === false);
ok('실장이 비면 꺼진다', make({ managerUserId: '' }).it.enabled === false);
{
  const { it, host } = make({ enabled: false });
  ok('꺼졌으면 돌지 않는다', (await it.runOnce(fakeClient(), MON)) === 'off' && host.calls.length === 0);
}

// ── 시각 · 하루 한 번 ───────────────────────────────────────────────────────
{
  const { it, host } = make();
  ok('시각 전에는 안 돈다', (await it.tick(fakeClient(), new Date(2026, 8, 21, 9, 59))) === 'not-time');
  ok('창(두 시간)이 지나면 그날은 안 돈다 — 저녁 재시작이 아침 일을 대신 안 한다',
    (await it.tick(fakeClient(), new Date(2026, 8, 21, 12, 0))) === 'not-time' && host.calls.length === 0);
  const first = await it.tick(fakeClient(), MON);
  ok('시각이 되면 돈다', first === 'spoke' && host.posted.length === 1, first);
  ok('같은 날 다시는 안 돈다 (도중에 깨져도 두 번 안 돌게 먼저 적는다)',
    (await it.tick(fakeClient(), new Date(2026, 8, 21, 10, 5))) === 'done-today' && host.posted.length === 1);
}

// ── 공휴일 · 실장이 끈 것 · 현황판 실패 ────────────────────────────────────
{
  process.env.FAKE_WORKDAY = '0';
  const { it, host } = make();
  ok('쉬는 날에는 안 건다 (모델도 안 부른다)', (await it.runOnce(fakeClient(), MON)) === 'holiday' && host.calls.length === 0);
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
  ok('어제 걸어 둔 「오늘만 꺼」는 오늘 안 먹는다', (await it.runOnce(fakeClient(), new Date(2026, 8, 22, 10, 0))) === 'spoke');
}
{
  process.env.FAKE_PULSE_FAIL = '1';
  const { it, host } = make();
  ok('현황판을 못 만들면 안 건다', (await it.runOnce(fakeClient(), MON)) === 'no-brief' && host.calls.length === 0);
  delete process.env.FAKE_PULSE_FAIL;
}

// ── 침묵 · 파이썬 빗장 · 이름 빗장 · 길이 ────────────────────────────────────
{
  const { it, host } = make();
  host.set({ reply: '', speak: false, error: null });
  const c = fakeClient();
  ok('안 걸기로 하면 조용하고 실장에게도 안 알린다', (await it.runOnce(c, MON)) === 'quiet' && host.posted.length === 0 && c.dm.length === 0);
}
{
  const { it, host } = make();
  host.set({ reply: '오늘은 조용히 있을게요 (혼잣말)', speak: false, error: null });
  ok('`speak:false` 면 글이 있어도 안 올린다', (await it.runOnce(fakeClient(), MON)) === 'quiet' && host.posted.length === 0);
}
{
  const { it, host } = make();
  host.set({ reply: '', speak: false, error: null, blocked: ['사람 지목(멘션)'] });
  const c = fakeClient();
  const r = await it.runOnce(c, MON);
  ok('파이썬 빗장이 막으면 안 올리고 실장에게 까닭을 알린다',
    r === 'blocked' && host.posted.length === 0 && c.dm.some((m) => m.channel === 'DM_U_BOSS' && m.text.includes('사람 지목')), c.dm);
}
{
  const { it, host } = make();
  host.set({ reply: '규황님은 아직 안 남기셨네요, 이번 주엔 어떠세요?', speak: true, error: null });
  const c = fakeClient();
  const r = await it.runOnce(c, MON);
  ok('실원 이름(성 뗀 것)이 들어가면 호스트 빗장이 막는다',
    r === 'blocked' && host.posted.length === 0 && c.dm.some((m) => m.text.includes('규황')), { r, dm: c.dm });
}
{
  const { it, host } = make();
  host.set({ reply: '김철수 님 고마워요!', speak: true, error: null });
  ok('실원 이름(성 포함)도 막는다', (await it.runOnce(fakeClient(), MON)) === 'blocked' && host.posted.length === 0);
}
{
  const { it, host } = make();
  host.set({ reply: '<@U_KKH> 어떠세요?', speak: true, error: null });
  ok('멘션은 호스트 빗장에서도 막는다 (두 겹)', (await it.runOnce(fakeClient(), MON)) === 'blocked' && host.posted.length === 0);
}
{
  const { it, host } = make();
  host.set({ reply: '가'.repeat(1300), speak: true, error: null });
  ok('너무 긴 글은 막는다', (await it.runOnce(fakeClient(), MON)) === 'blocked' && host.posted.length === 0);
}
{
  const { it, host } = make();
  host.set({ reply: '', speak: true, error: 'turn.py 응답 없음' });
  const c = fakeClient();
  ok('턴이 실패하면 아무것도 안 나간다', (await it.runOnce(c, MON)) === 'error' && host.posted.length === 0);
}

// ── 올림 · 사본 · 기록 ──────────────────────────────────────────────────────
{
  const { it, host } = make();
  const c = fakeClient();
  const TEXT = '요즘 커피챗 어떠셨어요?\n이번 주에 한 번씩만 남겨 볼까요?';
  host.set({ reply: TEXT, speak: true, error: null });
  const r = await it.runOnce(c, MON);
  ok('깨끗한 글은 커피챗 방에 올라간다', r === 'spoke' && host.posted[0]?.channel === 'C_CHAT' && host.posted[0]?.text === TEXT, host.posted);
  ok('현황판을 들고 그 방 열쇠로 턴을 부른다', host.calls[0]?.key === 'C_CHAT' && host.calls[0]?.brief.includes('네 현황판'), host.calls);
  const copy = c.dm.find((m) => m.channel === 'DM_U_BOSS');
  ok('올린 글 그대로 실장 DM 에 사본이 간다 (「나 모르게」가 없게)',
    copy && copy.text.includes('> 요즘 커피챗 어떠셨어요?') && copy.text.includes('> 이번 주에 한 번씩만'), copy);
  const log = fs.readFileSync(it['opts'].logPath, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
  ok('기록에 방·글자 수·앞머리·지문이 남고 글 전체는 안 남는다',
    log.length === 1 && log[0].to === 'C_CHAT' && log[0].chars === TEXT.length && log[0].head.length === 30 && !JSON.stringify(log[0]).includes('남겨 볼까요'), log);
  // 하루 상한 — 같은 날 또 돌리면 모델을 부르지도 않는다.
  const before = host.calls.length;
  ok(`하루 ${DAILY_CAP}번을 넘기지 않는다 (모델도 안 부른다)`,
    (await it.runOnce(fakeClient(), new Date(2026, 8, 21, 15, 0))) === 'cap' && host.calls.length === before);
  // 주 상한 — 다음 날 한 번 더는 되고, 그다음 날은 안 된다.
  ok('다음 날은 된다', (await it.runOnce(fakeClient(), new Date(2026, 8, 22, 10, 0))) === 'spoke');
  ok(`주 ${WEEKLY_CAP}번을 넘기지 않는다`, (await it.runOnce(fakeClient(), new Date(2026, 8, 24, 10, 0))) === 'cap');
  ok('다음 주 월요일은 다시 된다', (await it.runOnce(fakeClient(), new Date(2026, 8, 28, 10, 0))) === 'spoke');
}

// ── 수요일 주간 보고 ────────────────────────────────────────────────────────
{
  const { it, host } = make();
  const c = fakeClient();
  host.set({ reply: '이번 주 커피챗 4건이에요. 방이 조용해서 오늘 제가 말 걸어 볼게요.', speak: true, error: null });
  const r = await it.runOnce(c, WED);
  ok('수요일에는 실장 DM 보고 턴을 먼저 부른다 (실장 열쇠로)',
    host.calls[0]?.key === 'U_BOSS' && host.calls[1]?.key === 'C_CHAT', host.calls.map((x) => x.key));
  ok('보고가 실장 DM 으로 간다', c.dm.some((m) => m.channel === 'DM_U_BOSS' && m.text.includes('주간 현황')), c.dm);
  ok('보고한 뒤 방에도 건다 (상한은 방 것만 센다)', r === 'spoke' && host.posted.length === 1);
}
{
  const { it, host } = make();
  const c = fakeClient();
  await it.runOnce(c, MON);
  ok('월요일에는 보고 턴이 없다', host.calls.every((x) => x.key === 'C_CHAT') && !c.dm.some((m) => m.text.includes('주간 현황')));
}

console.log(`\n${fail ? `실패 ${fail}건` : '모두 통과.'}`);
fs.rmSync(dir, { recursive: true, force: true });
process.exitCode = fail ? 1 : 0;
