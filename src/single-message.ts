/**
 * 한 통으로 모으는 차례(메일 후보)의 마지막 메시지 — 머리 줄 + 답 + 엔진 표시 줄을 한 통으로(2026-11-09 실장 결정 V2
 * 「답 한 통만」). 전에는 머리 줄을 먼저 올리고 그 스레드에 명령어 안내 · 답 · 엔진 줄이 따로 붙어 차례마다 네 통이었다.
 *
 * 모으는 쪽은 `slack-handler.ts` `singleSay` — 버튼이 든 글은 그 자리에서 따로 올리고 나머지는 마지막 글만 든다.
 */
import { isQuietReply } from './dm-fallback';

/** 진행 상태 한 줄(「🤔 *생각 중...*」) — 답이 아니다. 상태 줄은 `say` 로 처음 한 번 올라온다. */
export function isStatusLine(text: string): boolean {
  return /^\S{1,4} \*[^*\n]+\*$/.test(text.trim());
}

/**
 * 슬랙에 올릴 한 통. 답이 `[조용히]` 이거나 비었거나 상태 줄뿐이면 머리 줄만 — 메일 차례가 자국 없이 사라지지 않게.
 * 엔진 표시 줄은 작은 글(context)로 아래에 붙인다.
 */
export function singleMessage(channel: string, head: string, text: string, marker: string): {
  channel: string; text: string; blocks?: unknown[];
} {
  const body = text.trim() && !isQuietReply(text) && !isStatusLine(text) ? text.trim() : '';
  const full = body ? `${head}\n${body}` : head;
  if (!marker.trim()) return { channel, text: full };
  return {
    channel,
    text: `${full}\n${marker}`,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: full.slice(0, 2900) } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: marker }] },
    ],
  };
}
