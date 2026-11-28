/**
 * 다우 세션 만료 → 로그인 버튼 알림이 **한 만료에 한 번**, 해소되면 **메시지를 고치는지**
 * 슬랙·파이썬 없이 확인한다.
 *
 *     npm run check:daou   (dist 가 낡았으면 멈춘다)
 *
 * 보는 것 — 마커가 있으면 버튼 달린 알림 한 번 · 같은 만료(same `since`)는 다시 안 보냄 ·
 * 마커가 걷히면 그 메시지를 「해소」로 고치고 버튼을 뗌 · 해소 뒤 다음 만료(다른 `since`)는
 * 새 알림 · 버튼이 눌리는 동안 다시 누르면 창을 또 안 띄움 · **쉬는 날과 업무일 08시 전에는
 * 안 보내고 다음 업무일 08시에 한 번** (사고 ic-20261128-1 — 토요일 10:03 에 DM 이 나갔다).
 * 상태 파일은 임시 폴더에만 쓴다.
 */
import './lib/fresh-dist.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'check-daou-'));
process.env.USERPROFILE = home;   // 상태 폴더를 임시로 돌린다 — 운영 큐를 절대 건드리지 않는다
// 개인 휴가 달력도 임시로 — 봇 설정이 이 값을 불러올 때 읽으므로 import 앞에 둔다.
const waRoot = path.join(home, 'work-assistant');
fs.mkdirSync(path.join(waRoot, 'bin'), { recursive: true });
fs.writeFileSync(path.join(waRoot, 'bin', 'tasks.py'), '# 있는 척');
fs.writeFileSync(path.join(waRoot, 'config.json'), JSON.stringify({ holidays: ['2026-12-01'] }));
process.env.WORK_ASSISTANT_ROOT = waRoot;

const { DaouLoginNotifier, ACTION_ID } = await import('../dist/daou-login.js');
const stateDir = path.join(home, '.claude', 'state');
fs.mkdirSync(stateDir, { recursive: true });
const queue = path.join(stateDir, 'operator-action-needed.json');
const setAlert = (since) => fs.writeFileSync(queue, JSON.stringify(since
  ? [{ id: 'daou-session', severity: 'action', title: '다우 세션 만료', since, source: 'groupware' }]
  : []), 'utf-8');

let fail = 0;
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) { fail++; if (detail) console.log(`      ${String(detail).slice(0, 300)}`); }
};
const buttonOf = (blocks) => (blocks || []).flatMap((b) => b.elements || []).find((e) => e.type === 'button');

const sent = []; const updated = [];
let n = 0;
// 아래 기존 검사는 업무일 낮에 도는 것으로 못 박는다 — 오늘이 주말이어도 같은 답이 나오게.
const notifier = new DaouLoginNotifier(
  async (text, blocks) => { sent.push({ text, blocks }); return `170000000${++n}.000`; },
  async (ts, text, blocks) => { updated.push({ ts, text, blocks }); },
  300,
  { now: () => new Date(2026, 8, 21, 10, 0) },
);

(async () => {
  // ── 쉬는 날에는 안 보내고 다음 업무일 08시에 한 번 (ic-20261128-1) ─────────
  // 시계만 바꿔 끼우고 달력은 실제 판정(주말, 한국 공휴일, config.json 의 개인 휴가)을 쓴다.
  let clock = new Date(2026, 10, 28, 10, 3);   // 2026-11-28(토) 10:03 — 사고 그 시각
  const offSent = [];
  const off = new DaouLoginNotifier(
    async (text, blocks) => { offSent.push({ text, blocks }); return `190000000${offSent.length}.000`; },
    async () => {},
    300,
    { now: () => clock },
  );
  setAlert('2026-11-28');
  await off.poll();
  ok('토요일 10:03 감지 — DM 안 보냄 (사고 재현)', offSent.length === 0, JSON.stringify(offSent));
  clock = new Date(2026, 10, 29, 13, 0);       // 일요일 낮
  await off.poll();
  ok('일요일에도 안 보냄', offSent.length === 0);
  clock = new Date(2026, 10, 30, 7, 55);       // 월요일 08시 전
  await off.poll();
  ok('다음 업무일 08시 전에는 안 보냄', offSent.length === 0);
  clock = new Date(2026, 10, 30, 8, 0);
  await off.poll(); await off.poll();
  ok('다음 업무일 08:00 에 한 번 보냄', offSent.length === 1, JSON.stringify(offSent));

  clock = new Date(2026, 11, 1, 10, 0);        // 2026-12-01(화) — 임시 config.json 의 개인 휴가
  setAlert('2026-12-01');
  await off.poll();
  ok('개인 휴가(config.json holidays)에는 안 보냄', offSent.length === 1, JSON.stringify(offSent));
  clock = new Date(2026, 11, 25, 10, 0);       // 2026-12-25(금) 성탄절 — config.json 에 없는 법정 공휴일
  setAlert('2026-12-25');
  await off.poll();
  ok('법정 공휴일(date-holidays)에는 안 보냄', offSent.length === 1, JSON.stringify(offSent));
  clock = new Date(2026, 11, 28, 8, 1);        // 다음 업무일 월요일
  await off.poll();
  ok('휴일 뒤 첫 업무일 08시에 보냄', offSent.length === 2, JSON.stringify(offSent));

  // 쉬는 날 사이에 다른 길로 로그인해 마커가 걷혔으면 업무일이 와도 안 보낸다.
  clock = new Date(2027, 0, 2, 10, 0);         // 2027-01-02(토)
  setAlert('2027-01-02');
  await off.poll();
  setAlert(null);
  clock = new Date(2027, 0, 4, 8, 0);          // 월요일
  await off.poll();
  ok('쉬는 날 사이 해소된 만료는 업무일에도 안 보냄', offSent.length === 2, JSON.stringify(offSent));

  // ── 알림은 한 만료에 한 번 ─────────────────────────────────────────────
  setAlert('2026-09-19');
  await notifier.poll();
  ok('마커가 있으면 알림 한 건', sent.length === 1, JSON.stringify(sent));
  ok('알림에 로그인 버튼이 달림', buttonOf(sent[0]?.blocks)?.action_id === ACTION_ID);
  await notifier.poll(); await notifier.poll();
  ok('같은 만료는 다시 안 보냄 (하루 뒤에 눌러도 되는 이유)', sent.length === 1);

  // ── 다른 길로 로그인해 마커가 걷히면 메시지를 고친다 ───────────────────
  setAlert(null);
  await notifier.poll();
  ok('해소되면 원래 메시지를 고침', updated.length === 1 && updated[0].ts === '1700000001.000', JSON.stringify(updated));
  ok('해소 메시지에 버튼이 없음', updated[0] && !buttonOf(updated[0].blocks) && /해소/.test(updated[0].text));
  await notifier.poll();
  ok('해소는 한 번만 고침', updated.length === 1);

  // ── 다음 만료는 새 알림 ────────────────────────────────────────────────
  setAlert('2026-09-26');
  await notifier.poll();
  ok('새 since 는 새 알림', sent.length === 2);

  // ── 버튼 겹눌림 — 진행 중이면 창을 또 안 띄움 ─────────────────────────
  // probeAlive/runLogin 은 파이썬을 부르므로 여기서는 막아 둔다 — 보는 것은 겹눌림 가드뿐.
  notifier.probeAlive = async () => { await new Promise((r) => setTimeout(r, 300)); return true; };
  notifier.clearAlert = async () => {};
  const first = notifier.handleAction('1700000002.000');
  await new Promise((r) => setTimeout(r, 50));
  await notifier.handleAction('1700000002.000');
  await first;
  const busy = updated.filter((u) => /로그인 창이 이미 열려/.test(u.text));
  ok('진행 중에 다시 누르면 「이미 열려 있음」', busy.length === 1, JSON.stringify(updated.slice(-3)));
  ok('살아 있으면 창 없이 「이미 살아 있음」', updated.some((u) => /이미 살아 있음/.test(u.text)));

  // ── 소인 DM 버튼 — 그 앱의 메시지를 고치고, 「곧 끊김」(renew)은 살아 있어도 창을 연다 ──────────
  let logins = 0;
  notifier.runLogin = async () => { logins++; return { ok: false, timedOut: true }; };
  const lunch = [];
  const lunchUpdate = async (ts, text, blocks) => { lunch.push({ ts, text, blocks }); };
  const before = updated.length;
  await notifier.handleAction('1800000001.000', { value: 'renew', update: lunchUpdate });
  ok('renew — 살아 있어도 로그인 창을 엶', logins === 1, JSON.stringify(lunch));
  ok('renew — 고치는 것은 소인 DM 메시지뿐(스탠리 DM 은 그대로)',
     updated.length === before && lunch.length >= 2 && lunch.every((u) => u.ts === '1800000001.000'));
  ok('renew — 5분 넘겨 닫히면 다시 누를 버튼도 renew', buttonOf(lunch.at(-1)?.blocks)?.value === 'renew',
     JSON.stringify(lunch.at(-1)));
  lunch.length = 0;
  await notifier.handleAction('1800000002.000', { value: 'daou-session', update: lunchUpdate });
  ok('끊김 버튼 — 그새 살아났으면 창 없이 「이미 살아 있음」', logins === 1 && /이미 살아 있음/.test(lunch.at(-1)?.text || ''),
     JSON.stringify(lunch));

  fs.rmSync(home, { recursive: true, force: true });
  if (fail) { console.log(`\n실패 ${fail}건`); process.exit(1); }
  console.log('\n통과 — 다우 로그인 버튼 (한 만료에 한 알림 · 해소 시 메시지 고침 · 새 만료는 새 알림 · 겹눌림 가드 · 소인 DM 버튼)');
})();
