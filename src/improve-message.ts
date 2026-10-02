/**
 * 매일 개선 제안 — 스탠리가 올리는 메시지 모양 (2026-10-02).
 *
 * **처리 제안(report-log)과 같은 모양 · 다른 버튼이다.** 처리 제안의 「진행」은 실행 준비 → 실행으로
 * 이어지지만, 개선 제안은 처음 2주 동안 **승인 = 업무로 등록**뿐이다(사용자 결정 · 봇이 자기 코드를
 * 고치는 일이라 제안의 질부터 본다). 같은 버튼을 쓰면 그 경계가 버튼 하나에 걸린다.
 *
 * 켜는 문은 `DAILY_IMPROVE=on` 하나 — **기본은 꺼짐**이다(시안 확인 뒤에 켠다). 꺼져 있으면 06:30 에
 * 안 만들고 08:00 에 안 올린다. 손으로 한 번 만드는 길(로컬 트리거 `@improve`)은 켜는 문과 무관하다.
 */
import type { ImproveDay, ImproveItem } from './work-assistant';

export const IMPROVE_DECISIONS = ['register', 'hold', 'drop'] as const;
export const IMPROVE_ID_RE = /^P-\d{8}-\d+$/;
const LABEL: Record<string, string> = { register: '업무로 등록', hold: '보류', drop: '폐기' };

export function improveEnabled(): boolean {
  return process.env.DAILY_IMPROVE === 'on';
}

function plain(text: string): string {
  return String(text || '').replace(/[<>|*_~`]/g, ' ').trim();
}

function evidenceLine(it: ImproveItem): string {
  return it.evidence
    .map((e) => `${plain(e.label)} *${plain(e.value)}*${e.compare ? ` (${plain(e.compare)})` : ''}`)
    .join(' · ');
}

function itemBlocks(it: ImproveItem, n: number): unknown[] {
  const lines = [
    `*${n}. ${plain(it.title)}*  _${plain(it.area)} · 추정 ${it.est}h_`,
    `근거 — ${evidenceLine(it)}`,
    plain(it.why),
    `첫 걸음 — ${plain(it.next)}`,
  ];
  const blocks: unknown[] = [
    { type: 'section', block_id: `imps_${it.id}`, text: { type: 'mrkdwn', text: lines.join('\n') } },
  ];
  if (it.state === 'proposed') {
    blocks.push({
      type: 'actions',
      // 처리 제안의 `markDecided` 가 이 번호로 버튼 줄만 결과 한 줄로 바꾼다.
      block_id: `actb_${it.id}`,
      elements: IMPROVE_DECISIONS.map((d) => ({
        type: 'button',
        text: { type: 'plain_text', text: LABEL[d] },
        action_id: `improve_${d}`,
        value: it.id,
        ...(d === 'register' ? { style: 'primary' } : d === 'drop' ? { style: 'danger' } : {}),
      })),
    });
  } else {
    const done = it.state === 'registered' ? '업무로 등록함' : it.state === 'held' ? '보류함' : '폐기함';
    blocks.push({ type: 'context', block_id: `actd_${it.id}`, elements: [{ type: 'mrkdwn', text: done }] });
  }
  return blocks;
}

/** 올릴 블록. 제안이 없으면 null — **0건이면 아무것도 안 보낸다**(약한 제안을 채우지 않는 것과 같은 까닭). */
export function buildImproveBlocks(day: ImproveDay | null): unknown[] | null {
  const items = day?.items ?? [];
  if (!items.length) return null;
  const blocks: unknown[] = [{
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `*💡 개선 제안* — 지난 7일 기록에서 ${items.length}건 · 「업무로 등록」을 누르면 판에 업무로 들어갑니다`,
    },
  }];
  items.forEach((it, i) => blocks.push(...itemBlocks(it, i + 1)));
  const tail = ['처음 2주는 등록까지만 · 고치는 일은 등록된 업무로 합니다'];
  if (day?.note) tail.unshift(plain(day.note));
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: tail.join(' · ') }] });
  return blocks;
}

/** 블록을 사람이 읽는 글로 — 알림 미리보기 · 시안 보고에 쓴다. */
export function improvePreviewText(blocks: unknown[] | null): string {
  if (!blocks) return '';
  const out: string[] = [];
  for (const b of blocks as any[]) {
    if (b.type === 'section') out.push(b.text.text);
    else if (b.type === 'actions') out.push(b.elements.map((e: any) => `[${e.text.text}]`).join(' '));
    else if (b.type === 'context') out.push(b.elements.map((e: any) => e.text).join(' '));
  }
  return out.join('\n');
}
