/**
 * AI 시트 관리자 세션 만료와 복구 알림이 세나 DM 으로 가는지 — 슬랙과 파이썬 없이 확인한다.
 *
 *     npm run check:seatoutlet   (dist 가 낡았으면 멈춘다)
 *
 * 보는 것 — 세나 출구가 걸리면 만료 알림이 세나 DM 에 세나 말투와 로그인 버튼으로 한 번 · 같은 만료는 다시 안 감 ·
 * 살아나면 복구 알림도 세나 DM · 출구가 없으면 예전처럼 소인 DM. 운영알림을 소인(친목)에서 세나로 옮김(2026-11-20).
 */
import './lib/fresh-dist.mjs';

const { PremiumSeatSlack, SEAT_TEXT_SENA, SEAT_LOGIN_ACTION } = await import('../dist/premium-seat.js');

let fail = 0;
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) { fail++; if (detail) console.log(`      ${String(detail).slice(0, 300)}`); }
};

const fakeClient = (log) => ({
  conversations: { open: async () => ({ channel: { id: 'D_LUNCH' } }) },
  chat: {
    postMessage: async (m) => { log.push(m); return { channel: m.channel, ts: '1' }; },
    update: async () => ({}), postEphemeral: async () => ({}),
  },
});

function seat(alive) {
  const s = new PremiumSeatSlack({ managerUserIds: ['U_BOSS'], channelId: 'C_SEAT', python: 'x', workerDir: '.' });
  s.run = async () => ({ result: { alive: alive.value } });   // 파이썬 세션 점검 대신
  return s;
}

{
  const sena = [], lunch = [], alive = { value: false };
  const s = seat(alive);
  s.app = { client: fakeClient(lunch) };
  s.useManagerOutlet({ client: fakeClient(sena) }, 'D_SENA');
  await s.checkSessionsAndNotify();
  ok('만료 알림은 세나 DM 으로 한 통', sena.length >= 1 && sena.every((m) => m.channel === 'D_SENA') && lunch.length === 0,
    JSON.stringify({ sena: sena.length, lunch: lunch.length }));
  const first = sena[0] ?? {};
  ok('세나 말투 첫 줄', String(first.text).startsWith('실장님, AI 시트'), first.text);
  const btn = (first.blocks ?? []).flatMap((b) => b.elements ?? []).find((e) => e.action_id === SEAT_LOGIN_ACTION);
  ok('로그인 버튼이 달림', !!btn, JSON.stringify(first.blocks));
  const n = sena.length;
  await s.checkSessionsAndNotify();
  ok('같은 만료는 다시 안 감', sena.length === n, sena.length);
  alive.value = true;
  await s.checkSessionsAndNotify();
  ok('살아나면 복구 알림도 세나 DM', sena.length === 2 * n && sena.slice(n).every((m) => m.text.startsWith('실장님, AI 시트') && m.text.includes('다시 살아났습니다')),
    sena.slice(n).map((m) => m.text).join(' | '));
  ok('복구 문구는 표와 같음', sena[n]?.text === SEAT_TEXT_SENA.recovered(sena[n]?.text.match(/\*(.+?)\*/)?.[1] ?? ''), sena[n]?.text);
}

{
  const lunch = [], alive = { value: false };
  const s = seat(alive);
  s.app = { client: fakeClient(lunch) };
  await s.checkSessionsAndNotify();
  ok('출구가 없으면 예전처럼 소인 DM', lunch.length >= 1 && lunch.every((m) => m.channel === 'D_LUNCH' && m.text.startsWith('소인')),
    lunch.map((m) => m.text).join(' | '));
}

console.log(fail ? `\n실패 ${fail}` : '\n통과');
process.exit(fail ? 1 : 0);
