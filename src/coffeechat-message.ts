/**
 * 커피챗을 받는 사람에게 가는 글. **모양은 여기 한 곳에서만 만든다.**
 *
 * 나가는 길이 둘이다 — 실장이 폼에서 옮겨 보내는 `/praise`, 그리고 창구에 쌓인 것을
 * 목록에서 골라 보내는 길. 두 곳이 각자 글을 만들면 **서로 다른 말이 나간다**(실제로
 * 그랬다: 한쪽은 확정한 카드 모양이고 다른 쪽은 빼기로 한 안내 문구를 그대로 달고 있었다).
 *
 * 정한 모양(2026-08-07):
 *   - 머리는 축하하는 인사 — 칭찬이라는 성격이 첫 줄에서 드러난다
 *   - 원두색 띠가 **봇이 하는 말과 사람이 남긴 말을 가른다**
 *   - 상황과 이야기에 각각 다른 그림 — 눈이 글을 읽기 전에 먼저 나눈다
 *   - **안내 문구는 두지 않는다** — 받는 사람이 할 일이 없는 말은 글만 딱딱하게 만든다
 */

const HEAD = ':tada: *커피챗이 도착했어요* :clap:';
/** 원두 빛깔. */
const BEAN = '#6F4E37';
const WHEN_ICON = ':spiral_calendar_pad:';
const BODY_ICON = ':speech_balloon:';

/**
 * 폼에서 온 글은 첫 줄에 상황이 `-…-` 꼴로 붙어 온다. 그 줄을 떼어 **제목처럼 세운다** —
 * 안 떼면 이야기와 한 덩어리로 붙어서 어디부터가 칭찬인지 안 보인다.
 *
 * 그 꼴이 아니면 **손대지 않는다.** 형식을 못 알아봤다고 남의 글을 고치면 안 된다.
 */
export function splitWhen(text: string): { when: string; body: string } {
  const lines = (text ?? '').trim().split('\n');
  const m = /^-\s*(.+?)\s*-$/.exec((lines[0] ?? '').trim());
  if (!m) return { when: '', body: (text ?? '').trim() };
  return { when: m[1], body: lines.slice(1).join('\n').trim() };
}

/**
 * 이야기 여럿을 한 번에 전할 수 있다 — **한 사람에게 세 건이 몰리면 DM 세 번보다
 * 한 번이 낫다.** 이야기마다 카드를 하나씩 둔다(한 카드에 몰아 넣으면 어디까지가
 * 한 사람 이야기인지 다시 안 보인다).
 */
export function coffeechatMessage(bodies: string[]): {
  text: string; blocks: any[]; attachments: any[];
} {
  const cards = bodies.map((raw) => {
    const { when, body } = splitWhen(raw);
    return when
      ? `${WHEN_ICON}  *${when}*\n\n${BODY_ICON}  ${body}`
      : `${BODY_ICON}  ${body}`;
  });
  const first = splitWhen(bodies[0] ?? '');
  return {
    // 알림 미리보기용 한 줄. 화면에 보이는 것은 아래 머리말과 카드다.
    text: `커피챗이 도착했어요 — ${(first.when || first.body).slice(0, 40)}`,
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text: HEAD } }],
    attachments: cards.map((c) => ({
      color: BEAN,
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: c } }],
    })),
  };
}
