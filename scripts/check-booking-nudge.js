/**
 * 「1on1 신청이 그대로 있습니다」 알림 검증. **슬랙에 붙지 않는다** — 보내는 자리를
 * 가짜로 갈아 끼우고, 시각도 손으로 준다.
 *
 *     node scripts/check-booking-nudge.js
 *
 * 이 알림은 하루가 지나야 걸려서 **눈으로 보려면 하루를 기다려야 한다.** 그래서 여기서
 * 문턱과 시각을 손으로 놓고 본다.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { LetterBooking } = require('../dist/letter-booking');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nudge-'));
const MANAGER = 'UMANAGER';

let passed = 0;
const failed = [];
function check(name, ok, detail) {
  if (ok) { passed += 1; console.log('PASS', name); return; }
  failed.push([name, detail]);
  console.log('FAIL', name, '\n     ', JSON.stringify(detail).slice(0, 300));
}

/** 신청 기록 하나를 만든다. `hoursAgo` 만큼 전에 넣은 것으로. */
function logWith(entries) {
  const p = path.join(TMP, `1on1-${Math.random().toString(36).slice(2)}.jsonl`);
  fs.writeFileSync(p, entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf-8');
  return p;
}

function ask(hoursAgo, user = 'U1', name = '서현지') {
  const ts = new Date(Date.now() - hoursAgo * 3600 * 1000).toISOString();
  return { ts, action: 'ask', id: ts, user, user_name: name };
}

/** 보낸 것을 담아 두는 가짜 슬랙. */
function fakeApp(sent) {
  return {
    client: {
      conversations: { open: async () => ({ channel: { id: 'D1' } }) },
      chat: { postMessage: async (m) => { sent.push(m); } },
    },
  };
}

async function run(entries, now, { nudgeSeen } = {}) {
  const nudgePath = path.join(TMP, `nudge-${Math.random().toString(36).slice(2)}.json`);
  if (nudgeSeen) fs.writeFileSync(nudgePath, JSON.stringify({ day: nudgeSeen }), 'utf-8');
  const b = new LetterBooking({
    managerUserId: MANAGER, members: ['U1', 'U2'],
    logPath: logWith(entries), nudgePath, open: true,
  });
  const sent = [];
  await b.maybeNudge(fakeApp(sent), now);
  return { sent, nudgePath };
}

// 화요일 오전 11시 / 오전 9시 / 토요일 — 손으로 놓는다.
const TUE_11 = new Date('2026-08-11T11:00:00+09:00');
const TUE_09 = new Date('2026-08-11T09:00:00+09:00');
const SAT_11 = new Date('2026-08-15T11:00:00+09:00');

(async () => {
  let r = await run([ask(30)], TUE_11);
  check('하루 넘게 기다린 신청이 있으면 알린다', r.sent.length === 1, r.sent);
  check('누가 며칠째 기다리는지 적는다',
    r.sent[0] && /서현지/.test(r.sent[0].text) && /1일째/.test(r.sent[0].text),
    r.sent[0] && r.sent[0].text);
  check('바로 열 수 있는 버튼을 붙인다',
    r.sent[0] && JSON.stringify(r.sent[0].blocks || []).includes('booking_nudge_open'), r.sent[0]);
  check('보냈으면 오늘 도장을 찍는다 (하루 한 번)',
    JSON.parse(fs.readFileSync(r.nudgePath, 'utf-8')).day === '2026-08-11',
    fs.readFileSync(r.nudgePath, 'utf-8'));

  r = await run([ask(3)], TUE_11);
  check('갓 들어온 신청에는 재촉하지 않는다 (들어올 때 이미 한 번 알렸다)',
    r.sent.length === 0, r.sent);
  check('알릴 것이 없으면 도장을 안 찍는다 (낮에 하루를 넘기는 건이 생긴다)',
    !fs.existsSync(r.nudgePath), r.nudgePath);

  r = await run([ask(30)], TUE_11, { nudgeSeen: '2026-08-11' });
  check('오늘 이미 알렸으면 다시 안 보낸다', r.sent.length === 0, r.sent);

  r = await run([ask(30)], TUE_09);
  check('이른 아침에는 안 보낸다', r.sent.length === 0, r.sent);

  r = await run([ask(30)], SAT_11);
  check('주말에는 안 보낸다 (알려도 할 수 있는 것이 없다)', r.sent.length === 0, r.sent);

  const old = ask(50);
  r = await run([old, { ...old, action: 'done', ts: new Date().toISOString() }], TUE_11);
  check('이미 내린 신청은 안 센다', r.sent.length === 0, r.sent);

  const cancelled = ask(50, 'U2', '홍창기');
  r = await run([cancelled, { ...cancelled, action: 'cancel', ts: new Date().toISOString() }], TUE_11);
  check('취소한 신청은 안 센다', r.sent.length === 0, r.sent);

  r = await run([ask(50, 'U1', '서현지'), ask(30, 'U2', '홍창기')], TUE_11);
  check('여럿이면 가장 오래 기다린 사람을 앞에 쓴다',
    r.sent[0] && /서현지.*외 1분/.test(r.sent[0].text), r.sent[0] && r.sent[0].text);

  console.log('\n' + '='.repeat(60));
  console.log(`통과 ${passed} / 실패 ${failed.length}`);
  if (failed.length) { failed.forEach(([n]) => console.log('  -', n)); process.exitCode = 1; }
  else console.log('모두 통과.');
})();
