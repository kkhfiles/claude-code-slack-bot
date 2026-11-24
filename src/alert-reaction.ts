/**
 * 슬랙 알림 DM 에 단 반응 이모지 → 세나 차례(2026-11-24 실장님 결정 슬랙답 「스레드와 이모지」).
 *
 * 실장님이 세나가 보낸 알림 글(세션 지시 결과, 한 시간 점검)에 👀 ✅ ❌ 를 달면 그 글에 단 짧은 답으로 받는다. 대상은 글에
 * 안 보이게 실린 번호표로만 정한다 — 결과 DM 은 알림 번호(r-…, `dm-context.ts` `ALERT_REF_EVENT`), 점검 DM 은 물음 번호와
 * 세션 앞 8자(`WAKE_REF_EVENT`). 번호표가 없는 글의 반응은 무시한다(무엇에 단 것인지 짐작하지 않는다).
 *
 * 무엇을 할지는 세나가 정한다 — 서랍의 「알림 답」과 같은 길(`[알림 답: … (<번호>)]`, work-assistant `prompts/drawer-answer.md`).
 */
import { SlackMsg, alertRefOf, wakeRefsOf } from './dm-context';

/** 받는 이모지와 뜻 — 이 밖의 반응은 무시(사람이 그냥 단 반응을 일로 만들지 않는다). */
export const REACTIONS: Record<string, string> = {
  eyes: '👀 나중에',
  white_check_mark: '✅ 됨',
  heavy_check_mark: '✅ 됨',
  x: '❌ 필요 없음',
};

/** 슬랙 링크 문법 `<주소|글>` 은 글만, 줄바꿈은 한 칸으로. */
function plain(text: string): string {
  return text.replace(/<([^|>]+)\|([^>]+)>/g, '$2').replace(/\s+/g, ' ').trim();
}

/** 세나에게 넘길 말 — 넘길 것이 없으면 ''. */
export function reactionTurn(emoji: string, m: SlackMsg): string {
  const label = REACTIONS[emoji];
  if (!label) return '';
  const text = plain(String(m.text ?? ''));
  const alert = alertRefOf(m);
  if (alert) {
    // 머리의 알림 글은 괄호와 대괄호를 빼고 40자 — 서랍이 짓는 머리와 같은 꼴(`40-drawer.js` submit)
    const short = text.replace(/[[\]()]+/g, ' ').trim().slice(0, 40);
    return `[알림 답: ${short} (${alert})]\n${label} — 실장님이 슬랙 알림에 단 반응`;
  }
  const refs = wakeRefsOf(m);
  if (refs) {
    return `${label} — 실장님이 슬랙에서 아래 세나 글에 단 반응\n[그 글] ${text.slice(0, 300)}\n`
      + `[번호표 — 대상은 이 번호로만 정한다: ${refs.replace(/\n+/g, ' / ')}]`;
  }
  return '';
}
