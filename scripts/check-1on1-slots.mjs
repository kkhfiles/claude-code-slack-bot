/**
 * 1on1 「시간 여럿 제안 → 신청자가 고름 → 확정·캘린더」 흐름을 슬랙 없이 확인한다.
 *
 *     npm run build && npm run check:1on1slots
 *
 * **왜 있나** — 실장 2026-09-30 「시간을 딱 하나만 전달하는건 성사되기 어렵다」. 그래서 실장이
 * 가능한 시간을 여럿 보내고 신청자가 고르게 바꿨다. 여기서 세는 것:
 *   - 고르면 **한 번만** 확정되고(두 번 눌러도) 캘린더에 **한 번만** 들어간다
 *   - 다시 보내면 옛 메시지의 버튼은 못 쓴다(판 번호)
 *   - 「다 안 돼요」면 실장 차례로 돌아가고, 고르는 중인 건으로는 실장을 재촉하지 않는다
 *   - 무르면 캘린더에서도 빠진다
 *   - **신청 메모는 신청자에게 가는 글에도, 캘린더에도 안 실린다**(개인 글 사본을 늘리지 않는다)
 *
 * 기록 파일은 임시 폴더에만 쓴다 — 운영 기록을 절대 건드리지 않는다.
 */
import './lib/fresh-dist.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { LetterBooking } = require('../dist/letter-booking.js');

const BOSS = 'UBOSS';
const NOTE = '팀 이동 고민이 있어서 조용히 말씀드리고 싶어요';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'check-1on1-slots-'));
const log = path.join(tmp, '1on1.jsonl');
const DAY = 24 * 60 * 60 * 1000;

let fail = 0;
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !extra ? '' : ` — ${extra}`}`);
  if (!cond) fail++;
};

// ── 가짜 슬랙 · 가짜 캘린더 ─────────────────────────────────────────────────
const calls = [];
const client = {
  conversations: { open: async ({ users }) => ({ channel: { id: `D-${users}` } }) },
  users: { info: async ({ user }) => ({ user: { profile: { real_name: { UA: '가가', UB: '나나', UC: '다다' }[user] ?? user } } }) },
  chat: {
    postMessage: async (a) => { calls.push({ kind: 'post', ...a }); return { ok: true, ts: String(calls.length) }; },
    update: async (a) => { calls.push({ kind: 'update', ...a }); return { ok: true }; },
  },
  views: {
    push: async (a) => { calls.push({ kind: 'push', ...a }); return { ok: true }; },
    open: async (a) => { calls.push({ kind: 'open', ...a }); return { ok: true }; },
    update: async (a) => { calls.push({ kind: 'vupdate', ...a }); return { ok: true }; },
  },
};
const cal = { added: [], removed: [], up: true };
const calendar = () => (cal.up ? {
  add: async (ev) => { cal.added.push(ev); return `ev${cal.added.length}`; },
  remove: async (id) => { cal.removed.push(id); return true; },
} : null);

const b = new LetterBooking({
  managerUserId: BOSS, members: ['UA', 'UB', 'UC'], logPath: log,
  nudgePath: path.join(tmp, 'nudge.json'), open: true, calendar,
});
const H = {};
b.register({
  command: () => {},
  view: (id, fn) => { H[id] = fn; },
  action: (sel, fn) => { H[sel.action_id instanceof RegExp ? 'pick' : sel.action_id] = fn; },
  client,
});
if (b['nudgeTimer']) clearInterval(b['nudgeTimer']);

const since = () => calls.length;
const after = (n) => calls.slice(n);
const toUser = (u, n) => after(n).filter((c) => c.kind === 'post' && c.channel === `D-${u}`);
const carried = (c) => JSON.stringify({ t: c.text, b: c.blocks ?? [] });
const ask = (user, daysAgo = 0, note) => {
  const ts = new Date(Date.now() - daysAgo * DAY).toISOString();
  b.note({ ts, action: 'ask', id: ts, user, user_name: { UA: '가가', UB: '나나', UC: '다다' }[user], ...(note ? { note } : {}) });
  return ts;
};

/** 한국 시각으로 `days` 날 뒤 `hhmm` 의 밀리초 — 창의 시각 목록(07:00~19:00 · 30분)에 있는 값만 쓴다. */
const at = (days, hhmm) => Date.parse(
  `${new Date(Date.now() + days * DAY + 9 * 3600e3).toISOString().slice(0, 10)}T${hhmm}:00+09:00`);
/** 밀리초 → 창의 두 칸(날짜 · 시각) 값. 한국 시각으로 가른다. */
const cells = (ms) => {
  const k = new Date(ms + 9 * 3600e3).toISOString();
  return { date: k.slice(0, 10), time: k.slice(11, 16) };
};

/** 실장이 창에서 시간을 골라 보낸다(`slots` 는 밀리초 또는 {date, time}). 돌려주는 것은 ack 에 넘긴 것. */
async function propose(entryId, user, slots, extra = {}, by = BOSS) {
  const values = {};
  slots.forEach((s, i) => {
    const c = typeof s === 'number' ? cells(s) : s;
    if (c.date) values[`date${i}`] = { [`date${i}`]: { selected_date: c.date } };
    if (c.time) values[`time${i}`] = { [`time${i}`]: { selected_option: { value: c.time } } };
  });
  values.memo = { memo: { value: extra.memo ?? '' } };
  let acked;
  await H.booking_tell_send({
    ack: async (a) => { acked = a; }, client,
    body: { user: { id: by }, view: { private_metadata: JSON.stringify({ id: entryId, user, name: 'x' }) } },
    view: { state: { values } },
  });
  return acked;
}

/** 신청자 DM 에 온 가장 최근 제안 메시지의 버튼들. */
function offerButtons(user) {
  const msg = [...calls].reverse().find((c) => c.kind === 'post' && c.channel === `D-${user}`
    && (c.blocks ?? []).some((x) => x.type === 'actions'));
  return { msg, buttons: (msg?.blocks ?? []).flatMap((x) => (x.type === 'actions' ? x.elements : [])) };
}

async function press(user, button, msg) {
  const handler = button.action_id === 'booking_decline' ? H.booking_decline : H.pick;
  await handler({
    ack: async () => {}, client,
    body: { user: { id: user }, channel: { id: `D-${user}` }, message: { ts: msg?.ts ?? '9', text: msg?.text, blocks: msg?.blocks }, actions: [{ value: button.value }] },
  });
}

// ── 1. 창 ─────────────────────────────────────────────────────────────────
const idA = ask('UA', 0, NOTE);
{
  const n = since();
  await H.booking_tell({ ack: async () => {}, client, body: { user: { id: BOSS }, trigger_id: 't', actions: [{ value: idA }] } });
  const view = after(n).find((c) => c.kind === 'push')?.view;
  const dates = (view?.blocks ?? []).filter((x) => x.element?.type === 'datepicker');
  const times = (view?.blocks ?? []).filter((x) => /^time\d$/.test(x.block_id ?? ''));
  ok('실장 창에 후보 다섯 개 — 날짜 칸 · 시각 칸', dates.length === 5 && times.length === 5);
  ok('첫 후보만 반드시다', dates[0]?.optional === false && times[0]?.optional === false
    && dates.slice(1).every((x) => x.optional) && times.slice(1).every((x) => x.optional));
  // 실장 2026-09-30 「오전 7시부터 오후 7시 정도 범위만 보이게」 — 슬랙 날짜·시각 칸은 범위를 못 좁혀 목록으로.
  const opts = (times[0]?.element?.options ?? []).map((o) => o.value);
  ok('시각은 07:00 부터 19:00 까지만 · 30분 단위', opts[0] === '07:00' && opts.at(-1) === '19:00' && opts.length === 25,
    `${opts[0]}~${opts.at(-1)} · ${opts.length}개`);
  ok('범위를 못 좁히는 날짜·시각 칸은 안 쓴다', !(view?.blocks ?? []).some((x) => x.element?.type === 'datetimepicker'));
  // 실장 2026-09-30 「길이는 빼고 시작 시간만」 — 길이를 묻는 칸이 없어야 한다.
  ok('길이는 안 묻는다(시작 시간만)', !(view?.blocks ?? []).some((x) => /길이/.test(x.label?.text ?? '')));
}

// ── 2. 보내기 — 막히는 것 ────────────────────────────────────────────────────
{
  const n = since();
  const none = await propose(idA, 'UA', []);
  ok('시간을 하나도 안 고르면 막는다', none?.response_action === 'errors' && !!none.errors.date0);
  const past = await propose(idA, 'UA', [at(1, '10:00'), at(-1, '10:00')]);
  ok('지난 시각이 있으면 그 칸을 짚어 막는다', past?.response_action === 'errors' && !!past.errors.date1);
  const half = await propose(idA, 'UA', [at(1, '10:00'), { date: cells(at(2, '10:00')).date }]);
  ok('날짜만 고르면 시각 칸을 짚어 막는다', half?.response_action === 'errors' && !!half.errors.time1);
  const early = await propose(idA, 'UA', [{ ...cells(at(1, '10:00')), time: '06:00' }]);
  ok('목록 밖 시각(06:00)이 와도 막는다', early?.response_action === 'errors' && !!early.errors.time0);
  const long = await propose(idA, 'UA', [at(1, '10:00')], { memo: '가'.repeat(501) });
  ok('덧붙일 말이 너무 길면 막는다', long?.response_action === 'errors' && !!long.errors.memo);
  await propose(idA, 'UA', [at(1, '10:00')], {}, 'UA');
  ok('실장 말고는 못 보낸다', toUser('UA', n).length === 0);
}

// ── 3. 보내기 — 신청자가 받는 것 ────────────────────────────────────────────
const t1 = at(2, '13:00');
const t2 = at(1, '10:30');
{
  const n = since();
  const acked = await propose(idA, 'UA', [t1, t2, t1], { memo: '회의실은 따로 알려드릴게요' });
  ok('보내면 창이 닫힌다', acked?.response_action === 'clear');
  const { msg, buttons } = offerButtons('UA');
  const picks = buttons.filter((x) => /^booking_pick_\d+$/.test(x.action_id));
  ok('같은 시각은 하나로 · 버튼 둘', picks.length === 2);
  ok('이른 시각이 먼저', JSON.parse(picks[0].value).i === 0 && picks[0].text.text.includes(String(new Date(t2).getDate())));
  ok('버튼 이름이 서로 다르다(한 줄에 겹치면 슬랙이 거부)', new Set(buttons.map((x) => x.action_id)).size === buttons.length);
  ok('「다 안 돼요」 버튼이 있다', buttons.some((x) => x.action_id === 'booking_decline'));
  ok('덧붙인 말이 신청자에게 간다', carried(msg).includes('회의실은 따로'));
  ok('⛔ 신청 메모는 신청자에게 가는 글에 안 실린다', toUser('UA', n).every((c) => !carried(c).includes('팀 이동')));
  ok('실장에게 「보냈습니다」가 간다', toUser(BOSS, n).some((c) => /보냈습니다/.test(c.text)));
  ok('고르는 중인 건은 실장 차례가 아니다(재촉 안 함)', b['managerTurn']().every((e) => e.id !== idA));
  const mv = JSON.stringify(b['managerView']());
  ok('실장 목록에 「고르는 중」과 「다시 제안」이 보인다', mv.includes('고르는 중') && mv.includes('다시 제안'));
}

// ── 4. 고르기 — 확정 · 캘린더 한 번 ────────────────────────────────────────
{
  const { msg, buttons } = offerButtons('UA');
  const second = buttons.find((x) => x.action_id === 'booking_pick_1');
  const n = since();
  await press('UA', second, msg);
  const st = b['alive']().get(idA);
  ok('고르면 확정된다', st?.done === true && !!st.fixed);
  ok('캘린더에 한 번 들어간다', cal.added.length === 1);
  ok('고른 그 시각으로 들어간다', cal.added[0]?.start.getTime() === Math.floor(t1 / 1000) * 1000);
  ok('캘린더에는 끝 시각용으로 한 시간을 둔다(사람에게는 안 보임)', cal.added[0]?.minutes === 60);
  ok('신청자에게 가는 글에 길이가 없다', !/분\)|길이/.test(offerButtons('UA').msg?.text ?? ''));
  ok('캘린더 제목에 이름이 없다(화면을 옆에서 볼 수 있다)', cal.added[0]?.title === '1:1 미팅');
  ok('⛔ 캘린더에 신청 메모가 안 들어간다', !JSON.stringify(cal.added[0]).includes('팀 이동'));
  ok('일정 id 가 기록된다(무를 때 뺀다)', st?.calendar === 'ev1');
  const upd = after(n).find((c) => c.kind === 'update');
  ok('누른 메시지의 버튼이 결과 한 줄로 바뀐다', !!upd && !carried(upd).includes('booking_pick') && carried(upd).includes('잡혔습니다'));
  ok('실장에게 확정과 캘린더를 알린다', toUser(BOSS, n).some((c) => /확정/.test(c.text) && /캘린더에 넣었습니다/.test(c.text)));
  ok('확정한 건은 그 달 몫을 쓴 것이다', b['thisMonth']('UA') !== null);

  const n2 = since();
  await press('UA', buttons.find((x) => x.action_id === 'booking_pick_0'), msg);
  ok('두 번 눌러도 캘린더는 한 번', cal.added.length === 1);
  ok('두 번째는 「이미 잡힌 1on1」', after(n2).some((c) => c.kind === 'update' && carried(c).includes('이미 잡힌')));
}

// ── 5. 다시 보내면 옛 버튼은 못 쓴다 ───────────────────────────────────────
const idB = ask('UB', 0);
{
  await propose(idB, 'UB', [at(1, '10:00')]);
  const old = offerButtons('UB');
  await propose(idB, 'UB', [at(3, '09:00'), at(4, '15:30')]);
  const neu = offerButtons('UB');
  ok('다시 보내면 「다시 보냈습니다」로 간다', carried(neu.msg).includes('다시 보냈습니다'));
  const n = since();
  await press('UB', old.buttons.find((x) => /^booking_pick/.test(x.action_id)), old.msg);
  ok('옛 메시지의 버튼으로는 확정 안 된다', b['alive']().get(idB)?.done === false && cal.added.length === 1);
  ok('옛 버튼을 누르면 「다시 보냈습니다」를 알린다', after(n).some((c) => carried(c).includes('다시 보냈습니다')));
  await press('UB', neu.buttons.find((x) => x.action_id === 'booking_pick_0'), neu.msg);
  ok('새 버튼으로는 확정된다', b['alive']().get(idB)?.done === true && cal.added.length === 2);
}

// ── 6. 다 안 돼요 ─────────────────────────────────────────────────────────
const idC = ask('UC', 2);
{
  await propose(idC, 'UC', [at(1, '11:00'), at(2, '16:00')]);
  const { msg, buttons } = offerButtons('UC');
  const n = since();
  await press('UC', buttons.find((x) => x.action_id === 'booking_decline'), msg);
  const st = b['alive']().get(idC);
  ok('「다 안 돼요」면 실장 차례로 돌아간다', st?.declined === true && !st.proposal && b['managerTurn']().some((e) => e.id === idC));
  ok('실장에게 다시 보내 달라고 알린다(목록 열기 버튼)',
    toUser(BOSS, n).some((c) => /다 안 된다고/.test(c.text) && carried(c).includes('booking_nudge_open')));
  ok('실장 목록에 「다시 보내 주세요」가 보인다', JSON.stringify(b['managerView']()).includes('다시 보내 주세요'));
  const n2 = since();
  await press('UC', buttons.find((x) => x.action_id === 'booking_pick_0'), msg);
  ok('다 안 된다고 한 뒤 옛 버튼은 안 먹는다', b['alive']().get(idC)?.done === false && cal.added.length === 2
    && after(n2).some((c) => carried(c).includes('다 안 된다고 알려 두었습니다')));
}

// ── 7. 재촉 — 실장 차례인 것만 ─────────────────────────────────────────────
{
  const n = since();
  await b['maybeNudge']({ client }, new Date(new Date().setHours(11, 0, 0, 0)));
  const nudges = toUser(BOSS, n).filter((c) => /그대로 있습니다/.test(c.text ?? ''));
  const weekend = [0, 6].includes(new Date().getDay());
  ok('다 안 된다고 돌아온 건(이틀째)은 재촉한다', weekend || (nudges.length === 1 && /다다/.test(nudges[0].text)));
}

// ── 8. 무르기 — 캘린더에서도 뺀다 ──────────────────────────────────────────
{
  const n = since();
  await H.booking_cancel({ ack: async () => {}, client, body: { user: { id: 'UA' }, actions: [{ value: idA }] } });
  ok('잡힌 1on1 을 무르면 캘린더에서 뺀다', cal.removed.includes('ev1'));
  ok('실장에게 「캘린더에서도 뺐습니다」', toUser(BOSS, n).some((c) => /캘린더에서도 뺐습니다/.test(c.text)));
}

// ── 9. 캘린더가 없어도 확정은 된다 ─────────────────────────────────────────
{
  cal.up = false;
  const idD = ask('UA', 0);    // 무른 뒤라 그 달에 다시 넣을 수 있다
  await propose(idD, 'UA', [at(1, '10:00')]);
  const { msg, buttons } = offerButtons('UA');
  const n = since();
  await press('UA', buttons.find((x) => x.action_id === 'booking_pick_0'), msg);
  ok('캘린더가 없어도 확정은 된다', b['alive']().get(idD)?.done === true);
  ok('그때는 「직접 넣어 주세요」', toUser(BOSS, n).some((c) => /직접 넣어 주세요/.test(c.text)));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(fail ? `\n실패 ${fail}건` : '\n전부 통과 — 1on1 시간 여럿 제안');
process.exit(fail ? 1 : 0);
