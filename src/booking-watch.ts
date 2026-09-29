/**
 * 통합 예약 회차를 언제 돌릴지.
 *
 * 1분마다 판·기록을 통째로 받아 오던 것을 「가벼운 확인은 자주, 무거운 일은 필요할 때만」으로 바꿨다
 * (2026-09-29 실장). 슬랙 봇은 15초마다 사이트의 **변경 번호**(예약·바꾸기·취소마다 오름)와 **지금 칸**
 * (날짜:오전·오후)만 보고, 아래일 때만 파이썬 회차(`booking tick`)를 돈다.
 *
 *   changed  변경 번호가 올랐다 — 누가 웹에서 잡거나 바꾸거나 취소했다
 *   slot     칸이 바뀌었다 — 자정·정오. 현황판의 「오늘·내일」·「사용 중」을 다시 그린다
 *   timed    11:50 — 정오에 끝나는 예약 알림
 *   safety   10분 — 명단·계정 올리기·공휴일, 그리고 번호 확인이 틀렸을 때의 안전망
 *   fallback 번호를 못 읽음 — 예전처럼 1분마다
 *   first    처음
 *
 * 판단만 여기 두고 부르는 쪽(`premium-seat.ts`)이 시각을 넘긴다 — 시각을 흉내 내 시험할 수 있게.
 */

export interface BookingVersion {
  lastEvent: number;
  slot: string;
}

export interface BookingWatch {
  lastEvent: number | null;
  slot: string | null;
  lastTickAt: number;
  nextTimedAt: number;
}

export const SAFETY_MS = 10 * 60_000;
export const FALLBACK_MS = 60_000;
const KST_MS = 9 * 3600_000;
const DAY_MS = 86_400_000;

/** 다음 11:50(서울) — 5초 뒤로 둬서 파이썬이 「11:50 이 됐다」로 본다. */
export function nextTimedAt(now: number): number {
  const kstDay = Math.floor((now + KST_MS) / DAY_MS) * DAY_MS;
  let at = kstDay + (11 * 60 + 50) * 60_000 + 5_000 - KST_MS;
  if (at <= now) at += DAY_MS;
  return at;
}

export function initialWatch(now: number): BookingWatch {
  return { lastEvent: null, slot: null, lastTickAt: 0, nextTimedAt: nextTimedAt(now) };
}

/** 지금 회차를 돌릴 까닭. 없으면 null. */
export function bookingTickReason(w: BookingWatch, v: BookingVersion | null, now: number): string | null {
  if (now >= w.nextTimedAt) return 'timed';
  if (!v) return now - w.lastTickAt >= FALLBACK_MS ? 'fallback' : null;
  if (w.lastEvent === null) return 'first';
  if (v.lastEvent !== w.lastEvent) return 'changed';
  if (v.slot !== w.slot) return 'slot';
  if (now - w.lastTickAt >= SAFETY_MS) return 'safety';
  return null;
}

/** 회차를 돈 뒤의 상태 — 회차 전에 읽은 번호를 적는다(도는 사이에 또 바뀌었으면 다음 확인이 잡는다). */
export function afterBookingTick(w: BookingWatch, v: BookingVersion | null, now: number): BookingWatch {
  return {
    lastEvent: v ? v.lastEvent : w.lastEvent,
    slot: v ? v.slot : w.slot,
    lastTickAt: now,
    nextTimedAt: now >= w.nextTimedAt ? nextTimedAt(now) : w.nextTimedAt,
  };
}
