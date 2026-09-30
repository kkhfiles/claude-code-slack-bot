/**
 * GPT Pro 계정 현황판 칸과 11:50 「곧 끝납니다」 글 — 정원(한 계정을 같은 시간에 여럿)이 들어온 뒤에도
 * 정원 1 계정의 글은 전과 같고, 같이 쓰는 계정은 쓰는 사람을 모두 · 남은 자리를 적는지 본다.
 *
 *   npm run check:proboard
 *
 * 2026-09-30 검토에서 이 글을 만드는 코드를 어느 검사도 안 부른다는 것이 드러나 만들었다.
 */
import './lib/fresh-dist.mjs';

const { proFieldText, bookingEndingText } = await import('../dist/premium-seat.js');

let fails = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `  — ${JSON.stringify(detail)}`}`);
  if (!ok) fails += 1;
}

const BUSY = '\u{1F534}';
const FREE = '\u{1F7E2}';
const PART = '\u{1F7E1}';

// 정원 1 — 예전 자료(capacity·users 없음)와 새 자료가 같은 글
const old = { accounts: [
  { account: 'pro-a@ex.com', current: { display_name: '가', until: '오늘 오후까지' }, next: null },
  { account: 'pro-b@ex.com', current: null, next: { display_name: '나', label: '내일 오전' } },
] };
const oldText = proFieldText(old);
check('정원 1 · 쓰는 중', oldText.includes(`${BUSY} *pro-a*  가 · 오늘 오후까지`), oldText);
check('정원 1 · 비어 있음과 다음 예약', oldText.includes(`${FREE} *pro-b*  비어 있음 · 다음 내일 오전 나`), oldText);
check('정원 1 · 제목에 동시 인원 없음 · 자리 표시 없음', !oldText.includes('동시') && !oldText.includes('자리'), oldText);
const same = proFieldText({ accounts: [
  { account: 'pro-a@ex.com', capacity: 1, users: [{ display_name: '가', until: '오늘 오후까지' }], current: { display_name: '가', until: '오늘 오후까지' }, next: null },
  { account: 'pro-b@ex.com', capacity: 1, users: [], current: null, next: { display_name: '나', label: '내일 오전' } },
] });
check('정원 1 · 새 자료도 예전 자료와 같은 글', same === oldText, [same, oldText]);

// 정원 2 — 한 사람이면 노란 원과 남은 자리 · 두 사람이면 빨간 원과 둘 다
const shared = proFieldText({ accounts: [
  { account: 'pro-a@ex.com', capacity: 2, users: [{ display_name: '가', until: '오늘 오후까지' }], next: null },
  { account: 'pro-b@ex.com', capacity: 2, users: [{ display_name: '나', until: '오늘 오후까지' }, { display_name: '다', until: '내일 오전까지' }], next: null },
  { account: 'pro-c@ex.com', capacity: 2, users: [], next: null },
] });
check('정원 2 · 제목에 동시 인원', shared.includes('*GPT Pro 계정* (계정마다 동시 2명)'), shared);
check('정원 2 · 한 사람이면 노란 원 · 1자리 남음', shared.includes(`${PART} *pro-a*  가 · 오늘 오후까지  (1자리 남음)`), shared);
check('정원 2 · 두 사람이면 빨간 원 · 둘 다', shared.includes(`${BUSY} *pro-b*  나 · 오늘 오후까지  /  다 · 내일 오전까지`) && !shared.includes('*pro-b*  나 · 오늘 오후까지  /  다 · 내일 오전까지  ('), shared);
check('정원 2 · 아무도 없으면 초록 원', shared.includes(`${FREE} *pro-c*  비어 있음`), shared);

// 11:50 알림 — 정원 1 은 전과 같고, 같이 쓰는 계정은 「이어서 씁니다」 대신 오후 자리
const next = { display_name: '나', label: '오늘 오후' };
check('알림 · 정원 1 · 바로 이어 쓰는 사람', bookingEndingText({ account: 'pro-a@ex.com', next, next_is_adjacent: true }).endsWith('정오부터 나 님이 이어서 씁니다.'));
check('알림 · 정원 1 · 뒤 예약 없음', bookingEndingText({ account: 'pro-a@ex.com', next: null }).endsWith('뒤 예약이 없습니다. 오후에도 쓰시려면 TurnTable에서 오후를 잡아 주세요.'));
const full = bookingEndingText({ account: 'pro-a@ex.com', capacity: 2, next, next_is_adjacent: true, after_full: true });
check('알림 · 정원 2 · 오후 자리 다 참(이어받는다고 안 함)', full.endsWith('오후에는 자리가 다 찼습니다.') && !full.includes('이어서'), full);
const room = bookingEndingText({ account: 'pro-a@ex.com', capacity: 2, next, next_is_adjacent: true, after_full: false });
check('알림 · 정원 2 · 오후 자리 남음', room.endsWith('오후에도 쓰시려면 TurnTable에서 오후를 잡아 주세요.') && !room.includes('이어서'), room);

if (fails) {
  console.log(`\n실패 ${fails}건`);
  process.exitCode = 1;
} else {
  console.log('\n통과');
}
