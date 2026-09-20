/**
 * 다우 세션 만료 → 로그인 버튼 알림이 **한 만료에 한 번**, 해소되면 **메시지를 고치는지**
 * 슬랙·파이썬 없이 확인한다.
 *
 *     npm run check:daou   (dist 가 낡았으면 멈춘다)
 *
 * 보는 것 — 마커가 있으면 버튼 달린 알림 한 번 · 같은 만료(same `since`)는 다시 안 보냄 ·
 * 마커가 걷히면 그 메시지를 「해소」로 고치고 버튼을 뗌 · 해소 뒤 다음 만료(다른 `since`)는
 * 새 알림 · 버튼이 눌리는 동안 다시 누르면 창을 또 안 띄움. 상태 파일은 임시 폴더에만 쓴다.
 */
import './lib/fresh-dist.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { DaouLoginNotifier, ACTION_ID } = await import('../dist/daou-login.js');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'check-daou-'));
process.env.USERPROFILE = home;   // 상태 폴더를 임시로 돌린다 — 운영 큐를 절대 건드리지 않는다
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
const notifier = new DaouLoginNotifier(
  async (text, blocks) => { sent.push({ text, blocks }); return `170000000${++n}.000`; },
  async (ts, text, blocks) => { updated.push({ ts, text, blocks }); },
);

(async () => {
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
  const busy = updated.filter((u) => /이미 로그인 창이 열려/.test(u.text));
  ok('진행 중에 다시 누르면 「이미 열려 있음」', busy.length === 1, JSON.stringify(updated.slice(-3)));
  ok('살아 있으면 창 없이 「이미 살아 있음」', updated.some((u) => /이미 살아 있습니다/.test(u.text)));

  fs.rmSync(home, { recursive: true, force: true });
  if (fail) { console.log(`\n실패 ${fail}건`); process.exit(1); }
  console.log('\n통과 — 다우 로그인 버튼 (한 만료에 한 알림 · 해소 시 메시지 고침 · 새 만료는 새 알림 · 겹눌림 가드)');
})();
