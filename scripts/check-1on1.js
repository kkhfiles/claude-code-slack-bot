/**
 * 1on1 신청 창구의 셈 부분을 슬랙 없이 확인한다.
 *
 *     npm run build && npm run check:1on1
 *
 * 여기서 보는 것은 화면이 아니라 **기록을 되짚어 지금 상태를 만드는 부분**이다.
 * 달이 바뀌는 자리·무른 뒤·실장이 내린 뒤가 조용히 어긋나기 쉬워서 박아 둔다.
 * 기록 파일은 임시 폴더에만 쓴다 — 운영 기록을 절대 건드리지 않는다.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { LetterBooking } = require('../dist/letter-booking.js');

const log = path.join(os.tmpdir(), `check-1on1-${process.pid}.jsonl`);
let fail = 0;
const ok = (name, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) fail++;
};
const make = (extra = {}) => new LetterBooking({
  managerUserId: 'UBOSS', members: ['UA', 'UB'], logPath: log, open: true, ...extra,
});
const put = (b, action, id, user, extra = {}) =>
  b.note({ ts: id, action, id, user, user_name: user === 'UA' ? '가' : '나', ...extra });

try { fs.unlinkSync(log); } catch {}
const now = new Date();
const at = (day, hh) => new Date(now.getFullYear(), now.getMonth(), day, hh).toISOString();
const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 15, 10).toISOString();

// ── 꺼짐 조건 — 비어 있으면 기능이 통째로 꺼져야 한다 ──────────────────────
ok('명단이 비면 꺼진다', make({ members: [] }).enabled === false);
ok('실장이 없으면 꺼진다', make({ managerUserId: '' }).enabled === false);
ok('둘 다 있으면 켜진다', make().enabled === true);

// ── 아직 안 열었을 때 — 실장만 쓸 수 있어야 한다 ──────────────────────────
const shut = make({ open: false });
ok('안 열었으면 실원은 못 쓴다', shut.allowed('UA') === false);
ok('안 열었어도 실장은 쓴다', shut.allowed('UBOSS') === true);
ok('열면 실원도 쓴다', make().allowed('UA') === true);
ok('열어도 명단 밖은 못 쓴다', make().allowed('U외부') === false);

// ── 신청 ─────────────────────────────────────────────────────────────────
const b = make();
ok('처음엔 기다리는 것이 없다', b.pending().length === 0);
ok('처음엔 이번 달 신청이 없다', b.thisMonth('UA') === null);

const first = at(1, 9);
put(b, 'ask', first, 'UA', { when: '다음 주 오후' });
ok('신청이 기다리는 목록에 뜬다', make().pending().length === 1);
ok('이번 달 신청으로 잡힌다', make().thisMonth('UA') !== null);
ok('남의 이번 달은 비어 있다', make().thisMonth('UB') === null);
ok('편한 때가 남는다', make().pending()[0].when === '다음 주 오후');

// ── 한 달 한 번 — **기록 파일을 따로 쓴다**(같은 파일이면 뒤 검사 건수가 흐려진다) ──
const sideLog = `${log}.side`;
const side = make({ logPath: sideLog });
put(side, 'ask', lastMonth, 'UB');
ok('지난달 신청은 이번 달을 막지 않는다', side.thisMonth('UB') === null);
ok('지난달 신청도 실장이 안 내렸으면 계속 기다린다', side.pending().length === 1);
try { fs.unlinkSync(sideLog); } catch {}

// ── 무르기 ───────────────────────────────────────────────────────────────
put(b, 'cancel', first, 'UA');
ok('무르면 기다리는 목록에서 빠진다', make().pending().length === 0);
ok('무르면 그 달에 다시 넣을 수 있다', make().thisMonth('UA') === null);

const second = at(2, 9);
put(b, 'ask', second, 'UA');
ok('다시 넣으면 또 뜬다', make().pending().length === 1);

// ── 실장이 내림 ──────────────────────────────────────────────────────────
// 시간을 알려서 내리든(when 이 붙는다) 그냥 내리든 상태는 같다.
put(b, 'done', second, 'UA', { when: '8월 7일(금) 16:00' });
ok('내리면 목록에서 빠진다', make().pending().length === 0);
ok('내려도 그 달 몫은 쓴 것이다', make().thisMonth('UA') !== null);
ok('알린 시각이 기록에 남는다',
  make().history().some((e) => e.action === 'done' && e.when === '8월 7일(금) 16:00'));

// ── 여러 사람 ────────────────────────────────────────────────────────────
try { fs.unlinkSync(log); } catch {}
const c = make();
put(c, 'ask', at(3, 15), 'UB');
put(c, 'ask', at(3, 9), 'UA');
const order = make().pending().map((e) => e.user);
ok('먼저 넣은 순서로 보인다', order[0] === 'UA' && order[1] === 'UB');
ok('두 사람이 각각 잡힌다', make().pending().length === 2);

// ── 망가진 기록 ──────────────────────────────────────────────────────────
fs.appendFileSync(log, '{망가진 줄\n');
let threw = false;
try { make().pending(); } catch { threw = true; }
// ── 달이 바뀌는 날 ────────────────────────────────────────────────────────
//
// **UTC 로 달을 세면 한국 시각 자정~오전 9시가 전달로 보인다.** 기록은
// `toISOString()`(UTC)으로 적히는데 사람은 한국 시각으로 산다. 그 아홉 시간에
// 넣은 신청이 지난달 몫으로 계산되어, 이번 달에 또 넣을 수 있게 된다.
// **달이 바뀌는 날에만, 조용히 틀린다** — 2026-09-01 에 이 검사가 실제로 잡았다.
//
// ⚠️ **증상이 났던 그 모양으로 잰다** — 낮 시간으로만 재면 UTC 와 지역 시각의
// 달이 같아 **원래 안 나는 경우**다. 안 나는 모양으로 재고 「안 난다」고 적으면
// 맞는 진단을 지운다.
{
  const { localMonth } = require('../dist/letter-booking.js');
  // 9월 1일 오전 8시(한국) = 8월 31일 23시(UTC)
  const dawn = new Date(2026, 8, 1, 8, 0);
  ok('달이 바뀌는 날 새벽도 그 달로 센다', localMonth(dawn) === '2026-09');
  ok('UTC 로 세면 전달이 되는 것이 맞다', dawn.toISOString().slice(0, 7) === '2026-08');
  ok('낮에는 둘이 같다', localMonth(new Date(2026, 8, 1, 15, 0)) === '2026-09');
  ok('달 끝도 그 달이다', localMonth(new Date(2026, 7, 31, 23, 30)) === '2026-08');
}

ok('기록에 망가진 줄이 있어도 터지지 않는다', !threw);

try { fs.unlinkSync(log); } catch {}
console.log(fail ? `\n실패 ${fail}건` : '\n전부 통과');
process.exit(fail ? 1 : 0);
