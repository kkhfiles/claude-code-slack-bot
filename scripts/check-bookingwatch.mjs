/**
 * 통합 예약 회차를 언제 돌리는가 — 판단(`src/booking-watch.ts`)을 시각을 흉내 내 본다.
 *
 *   npm run check:bookingwatch
 *
 * 1분마다 전부 받아 오던 것을 15초 변경 번호 확인으로 바꿨다(2026-09-29 실장). 판단이 틀리면
 * 조용히 틀린다 — 웹에서 바꾼 것이 슬랙에 안 뜨거나, 끝날 때의 알림이 안 나가거나, 자정에 「오늘·내일」이
 * 안 바뀐다. 그래서 까닭마다 한 번씩 본다.
 */
import './lib/fresh-dist.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { afterBookingTick, bookingTickReason, initialWatch, nextTimedAt, SAFETY_MS } = await import('../dist/booking-watch.js');

let fails = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `  — ${JSON.stringify(detail)}`}`);
  if (!ok) fails += 1;
}

// 서울 시각 → ms
const kst = (y, m, d, h, min = 0, s = 0) => Date.UTC(y, m - 1, d, h - 9, min, s);

// 알림 시각 — 08:00·15:00(긴 예약 미리 알림) · 11:55·17:55(계정 전환) · 밤에는 없음(2026-09-30 실장)
check('자정 직후(00:10)면 그날 08:00:05', nextTimedAt(kst(2026, 9, 30, 0, 10)) === kst(2026, 9, 30, 8, 0, 5));
check('10:00 이면 같은 날 11:55:05', nextTimedAt(kst(2026, 9, 29, 10)) === kst(2026, 9, 29, 11, 55, 5));
check('12:00 이면 같은 날 15:00:05', nextTimedAt(kst(2026, 9, 29, 12)) === kst(2026, 9, 29, 15, 0, 5));
check('16:00 이면 같은 날 17:55:05', nextTimedAt(kst(2026, 9, 29, 16)) === kst(2026, 9, 29, 17, 55, 5));
check('18:00 이면 다음 날 08:00:05(밤에는 안 돎)', nextTimedAt(kst(2026, 9, 29, 18)) === kst(2026, 9, 30, 8, 0, 5));

// 까닭
const t0 = kst(2026, 9, 29, 13);
let w = initialWatch(t0);
const v = (n, slot = '2026-09-29:PM') => ({ lastEvent: n, slot });
check('처음에는 돈다', bookingTickReason(w, v(5), t0) === 'first');
w = afterBookingTick(w, v(5), t0);
check('그대로면 안 돈다', bookingTickReason(w, v(5), t0 + 15_000) === null);
check('변경 번호가 오르면 돈다', bookingTickReason(w, v(6), t0 + 15_000) === 'changed');
check('자정·정오에 칸이 바뀌면 돈다', bookingTickReason(w, v(5, '2026-09-30:AM'), t0 + 15_000) === 'slot');
check('10분이 지나면 안전망으로 돈다', bookingTickReason(w, v(5), t0 + SAFETY_MS) === 'safety');
check('번호를 못 읽으면 1분이 안 됐을 때는 안 돈다', bookingTickReason(w, null, t0 + 30_000) === null);
check('번호를 못 읽으면 1분마다 돈다(예전처럼)', bookingTickReason(w, null, t0 + 60_000) === 'fallback');
const before1155 = afterBookingTick(initialWatch(kst(2026, 9, 29, 11, 40)), v(5), kst(2026, 9, 29, 11, 40));
check('11:55 가 되면 돈다', bookingTickReason(before1155, v(5), kst(2026, 9, 29, 11, 55, 5)) === 'timed');
const after1155 = afterBookingTick(before1155, v(5), kst(2026, 9, 29, 11, 55, 6));
check('11:55 회차 뒤에는 같은 날 15:00 으로 넘어간다', after1155.nextTimedAt === kst(2026, 9, 29, 15, 0, 5));
check('회차 전에 읽은 번호를 적는다(도는 사이 바뀐 것은 다음 확인이 잡는다)',
  bookingTickReason(afterBookingTick(w, v(6), t0 + 20_000), v(7), t0 + 35_000) === 'changed');

// 회귀 — 1분 회차로 되돌아가지 않았나
const src = fs.readFileSync(path.join(ROOT, 'src', 'premium-seat.ts'), 'utf-8');
check('예약 회차를 1분 타이머로 직접 걸지 않는다', !/every\(60_000,\s*\(\)\s*=>\s*this\.pumpBooking\(\)\)/.test(src));
check('15초 변경 번호 확인을 건다', /every\(15_000,\s*\(\)\s*=>\s*this\.watchBooking\(\)\)/.test(src));

if (fails) {
  console.log(`\n실패 ${fails}건`);
  process.exitCode = 1;
} else {
  console.log('\n통과');
}
