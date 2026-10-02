/**
 * GPT Pro 계정 현황판 칸과 끝날 때의 알림 글 — 정원(한 계정을 같은 시간에 여럿)이 들어온 뒤에도
 * 정원 1 계정의 현황판 글은 전과 같고, 같이 쓰는 계정은 쓰는 사람을 모두 · 남은 자리를 적는지 본다.
 * 알림은 계정 전환(정오 끝 11:55 · 자정 끝 17:55)과 긴 예약 미리 알림(08:00·15:00)의 글을 본다.
 *
 *   npm run check:proboard
 *
 * 2026-09-30 검토에서 이 글을 만드는 코드를 어느 검사도 안 부른다는 것이 드러나 만들었다.
 */
import './lib/fresh-dist.mjs';

const { proFieldText, bookingEndingText, bookingHeadsupText } = await import('../dist/premium-seat.js');

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
  { account: 'pro-a@example.com', current: { display_name: '가', until: '오늘 오후까지' }, next: null },
  { account: 'pro-b@example.com', current: null, next: { display_name: '나', label: '내일 오전' } },
] };
const oldText = proFieldText(old);
check('정원 1 · 쓰는 중', oldText.includes(`${BUSY} *pro-a*  가 · 오늘 오후까지`), oldText);
check('정원 1 · 비어 있음과 다음 예약', oldText.includes(`${FREE} *pro-b*  비어 있음 · 다음 내일 오전 나`), oldText);
check('정원 1 · 제목에 동시 인원 없음 · 자리 표시 없음', !oldText.includes('동시') && !oldText.includes('자리'), oldText);
const same = proFieldText({ accounts: [
  { account: 'pro-a@example.com', capacity: 1, users: [{ display_name: '가', until: '오늘 오후까지' }], current: { display_name: '가', until: '오늘 오후까지' }, next: null },
  { account: 'pro-b@example.com', capacity: 1, users: [], current: null, next: { display_name: '나', label: '내일 오전' } },
] });
check('정원 1 · 새 자료도 예전 자료와 같은 글', same === oldText, [same, oldText]);

// 정원 2 — 한 사람이면 노란 원과 남은 자리 · 두 사람이면 빨간 원과 둘 다
const shared = proFieldText({ accounts: [
  { account: 'pro-a@example.com', capacity: 2, users: [{ display_name: '가', until: '오늘 오후까지' }], next: null },
  { account: 'pro-b@example.com', capacity: 2, users: [{ display_name: '나', until: '오늘 오후까지' }, { display_name: '다', until: '내일 오전까지' }], next: null },
  { account: 'pro-c@example.com', capacity: 2, users: [], next: null },
] });
check('정원 2 · 제목에 동시 인원', shared.includes('*GPT Pro 계정* (계정마다 동시 2명)'), shared);
check('정원 2 · 한 사람이면 노란 원 · 1자리 남음', shared.includes(`${PART} *pro-a*  가 · 오늘 오후까지  (1자리 남음)`), shared);
check('정원 2 · 두 사람이면 빨간 원 · 둘 다', shared.includes(`${BUSY} *pro-b*  나 · 오늘 오후까지  /  다 · 내일 오전까지`) && !shared.includes('*pro-b*  나 · 오늘 오후까지  /  다 · 내일 오전까지  ('), shared);
check('정원 2 · 아무도 없으면 초록 원', shared.includes(`${FREE} *pro-c*  비어 있음`), shared);

// 끝날 때의 알림(2026-09-30 실장) — 계정 전환: 정오 끝 11:55 · 자정 끝 17:55(밤에는 안 보냄) · 긴 예약 미리 알림: 08:00·15:00
const next = { display_name: '나', label: '오늘 오후' };
const A = 'pro-a@example.com';
const lines = (t) => t.split('\n');
const noonNext = bookingEndingText({ account: A, end_word: '정오', next, next_is_adjacent: true });
check('전환 · 정오 · 바로 뒤 사람', lines(noonNext)[0] === '*pro-a* 계정 예약이 5분 뒤 정오에 끝납니다.'
  && lines(noonNext)[1] === '정오부터 나 님이 씁니다. 다른 계정으로 전환해 주세요.', noonNext);
const noonFree = bookingEndingText({ account: A, end_word: '정오', next: null });
check('전환 · 정오 · 바로 뒤 빔', lines(noonFree)[1] === '끝나면 다른 계정으로 전환해 주세요. 바로 뒤 자리가 비어 있어 더 쓰시려면 TurnTable에서 늘려 주세요.', noonFree);
const eveNext = bookingEndingText({ account: A, end_word: '자정', next, next_is_adjacent: true });
check('전환 · 자정 끝(17:55) · 「5분 뒤」라 하지 않음', lines(eveNext)[0] === '*pro-a* 계정 예약이 오늘 자정에 끝납니다.'
  && lines(eveNext)[1] === '자정부터 나 님이 씁니다. 오늘 사용을 마치면 다른 계정으로 전환해 주세요.', eveNext);
const eveFree = bookingEndingText({ account: A, end_word: '자정', next: null });
check('전환 · 자정 끝 · 바로 뒤 빔', lines(eveFree)[1] === '오늘 사용을 마치면 다른 계정으로 전환해 주세요. 바로 뒤 자리가 비어 있어 더 쓰시려면 TurnTable에서 늘려 주세요.', eveFree);
check('전환 · 옛 자료(end_word 없음)는 정오로', lines(bookingEndingText({ account: A, next: null }))[0] === '*pro-a* 계정 예약이 5분 뒤 정오에 끝납니다.');
const full = bookingEndingText({ account: A, end_word: '정오', capacity: 2, next, next_is_adjacent: true, after_full: true });
check('전환 · 정원 2 · 뒤 자리 다 참(이어받는다고 안 함)', lines(full)[1] === '정오부터 이 계정 자리가 다 찹니다. 다른 계정으로 전환해 주세요.' && !full.includes('나 님'), full);
const room = bookingEndingText({ account: A, end_word: '정오', capacity: 2, next, next_is_adjacent: true, after_full: false });
check('전환 · 정원 2 · 뒤 자리 남음(누가 와도 늘릴 수 있음)', room.includes('늘려 주세요') && !room.includes('나 님'), room);
const headNoon = bookingHeadsupText({ account: A, end_word: '정오', label: '9/28(월) 오전 ~ 오늘 오전', next, next_is_adjacent: true });
check('미리 알림 · 정오 끝(08:00) · 바로 뒤 사람', headNoon === '*pro-a* 계정 예약(9/28(월) 오전 ~ 오늘 오전)이 오늘 정오에 끝납니다.\n정오부터 나 님이 씁니다. 그 전에 마무리해 주세요.', headNoon);
const headEve = bookingHeadsupText({ account: A, end_word: '자정', label: '9/29(화) 오후 ~ 오늘 오후', next: null });
check('미리 알림 · 자정 끝(15:00) · 바로 뒤 빔', headEve.endsWith('바로 뒤 자리가 비어 있어 더 쓰시려면 TurnTable에서 미리 늘려 주세요.') && headEve.includes('오늘 자정에 끝납니다'), headEve);

if (fails) {
  console.log(`\n실패 ${fails}건`);
  process.exitCode = 1;
} else {
  console.log('\n통과');
}
