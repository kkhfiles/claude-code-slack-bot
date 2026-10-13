/**
 * **세션이 못 본 대화방 글** — DM 차례를 띄우기 전에 슬랙에서 읽어 사람 말 앞에 붙인다 (2026-10-13).
 *
 * 사람은 슬랙 화면을 보고 말하는데 세션은 자기 기록만 본다. 둘이 어긋나는 길이 둘이었다
 * (9/13 ~ 10/13 봇 로그):
 *
 *   - **스레드 댓글** — DM 스레드는 세션 열쇠가 따로라 빈 새 세션이 뜨고, 사람이 댓글을 단
 *     그 글(대개 봇이 물은 말)을 모른다. 댓글 7건 중 3건이 그렇게 떴다 — 메일 질문에 단
 *     「참고임」이 「내용이 안 왔다」로 처리됐다(10/13 08:56).
 *   - **세션 밖에서 나간 봇 글** — 좁은 길의 ❓·💬 · 넛지 · 알림은 세션 기록에 없다. 그 글이
 *     15분 안에 있던 짧은 답 9건 중 3건이 되물음으로 돌아왔다(09/15 · 10/01 · 10/13 10:14).
 *     10/13 에는 「직전 되물음」 메모가 시스템 프롬프트에 있었는데도 세션은 이어받은 메일
 *     대화를 짚었다 — 그래서 **시스템 프롬프트가 아니라 사람 말 바로 앞에** 순서대로 붙인다.
 *
 * 고르는 규칙은 `unseenBlock` 하나이고 슬랙을 읽는 것은 `readUnseen` 이다. 읽기가 늦거나
 * 실패하면 빈 문자열 — 이 장치 때문에 차례가 막히면 안 된다.
 */
import { Logger } from './logger';

const logger = new Logger('DmContext');

export interface SlackMsg {
  ts?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  subtype?: string;
  thread_ts?: string;
}

export interface UnseenOpts {
  /** 사람이 지금 보낸 글 — 이것은 붙이지 않는다 */
  currentTs: string;
  /** 이 시각(슬랙 ts 초) 뒤에 올라온 글만 — 세션이 마지막 차례를 끝낸 때. 없으면 전부 */
  sinceSec?: number;
  /** 스레드 첫 글 ts — 스레드 댓글일 때. 세션이 처음이면 첫 글을 늘 붙인다 */
  threadTs?: string;
  /** 세션이 새로 뜨나 — 새 세션은 스레드 첫 글을 본 적이 없다 */
  isNewSession: boolean;
  botUserId: string;
  /** 개인 글 조각이 들었나 — 들었으면 뺀다(`privacy-guard.ts` `containsPrivate`) */
  isPrivate: (text: string) => boolean;
  /** 시각 표시 — 시험에서 시간대를 고정하려고 받는다 */
  clock?: (sec: number) => string;
}

/** 붙이는 글 수와 글마다 길이 — 넛지·좁은 길 답은 한두 줄이라 이 정도면 남는다. */
export const MAX_MSGS = 8;
export const MAX_CHARS = 500;
/** 새 세션이 최상위에서 뜰 때 거슬러 읽는 시간 — 그보다 옛 글은 「바로 위」가 아니다. */
export const NEW_SESSION_LOOKBACK_SEC = 12 * 3600;
/** 슬랙 읽기 상한 — 넘으면 안 붙이고 그냥 띄운다. */
export const READ_TIMEOUT_MS = 2500;

const kst = (sec: number): string => {
  const d = new Date((sec + 9 * 3600) * 1000);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
};

/**
 * 세션 앞에 붙일 덩어리. 붙일 것이 없으면 빈 문자열.
 *
 * - 사람이 지금 보낸 글 · 그보다 뒤의 글 · 삭제 표시 같은 부속 글 · 빈 글은 뺀다
 * - 스레드 첫 글은 **새 세션일 때만** 붙인다 — 이어받는 세션은 첫 차례에 이미 받았다
 * - 그 밖의 글은 세션이 마지막 차례를 끝낸 뒤의 것만 — 그 전 것은 세션 기록에 있다
 * - 개인 글 조각이 든 글은 빼고 뺐다는 사실만 적는다
 */
export function unseenBlock(msgs: SlackMsg[], o: UnseenOpts): string {
  const now = Number(o.currentTs);
  const clock = o.clock ?? kst;
  const picked: { sec: number; who: string; text: string; head: boolean }[] = [];
  let hidden = 0;
  const seen = new Set<string>();
  for (const m of msgs) {
    const ts = String(m.ts ?? '');
    const sec = Number(ts);
    if (!ts || seen.has(ts) || !Number.isFinite(sec)) continue;
    seen.add(ts);
    if (ts === o.currentTs || sec >= now) continue;
    if (m.subtype && m.subtype !== 'bot_message' && m.subtype !== 'thread_broadcast') continue;
    const text = String(m.text ?? '').trim();
    if (!text) continue;
    const head = Boolean(o.threadTs) && ts === o.threadTs;
    if (head ? !o.isNewSession : (o.sinceSec !== undefined && sec <= o.sinceSec)) continue;
    if (o.isPrivate(text)) { hidden += 1; continue; }
    const who = (m.bot_id || (o.botUserId && m.user === o.botUserId)) ? '스탠리' : '사용자';
    picked.push({ sec, who, text, head });
  }
  if (!picked.length && !hidden) return '';
  picked.sort((a, b) => a.sec - b.sec);
  // 첫 글은 늘 남기고 나머지는 최근 것부터 — 「바로 위」가 잘리면 이 장치가 할 일이 없다.
  const headMsg = picked.find((p) => p.head);
  const rest = picked.filter((p) => !p.head).slice(-(headMsg ? MAX_MSGS - 1 : MAX_MSGS));
  const shown = headMsg ? [headMsg, ...rest] : rest;
  const lines = [
    '[세션이 못 본 대화방 글 — 봇이 슬랙에서 읽어 붙임 · 오래된 것부터 · 맨 아래가 바로 위 글]',
  ];
  for (const p of shown) {
    const body = p.text.length > MAX_CHARS ? `${p.text.slice(0, MAX_CHARS)}…` : p.text;
    const tag = p.head ? `${p.who}(스레드 첫 글 — 사람이 이 글에 댓글을 달았다)` : p.who;
    lines.push(`- ${clock(p.sec)} ${tag}: ${body.replace(/\n+/g, ' / ')}`);
  }
  if (hidden) lines.push(`(개인 글이 든 ${hidden}건은 뺐다)`);
  lines.push(
    '아래 사람 말이 대상을 짚지 않았으면 **맨 아래 글(바로 위)에 대한 답으로 먼저 읽는다** — '
    + '그 글이 묻는 업무·메일에 반영하고, 이름이 비슷한 다른 대상을 짐작하지 않는다. '
    + '바로 위 글과 무관한 말이면 이 덩어리는 무시한다.',
    '',
    '[사람 말]',
  );
  return lines.join('\n');
}

interface HistoryClient {
  conversations: {
    history(a: { channel: string; oldest?: string; latest?: string; limit?: number; inclusive?: boolean }): Promise<{ messages?: SlackMsg[] }>;
    replies(a: { channel: string; ts: string; limit?: number }): Promise<{ messages?: SlackMsg[] }>;
  };
}

/**
 * 슬랙에서 읽어 `unseenBlock` 을 만든다. 늦거나 실패하면 빈 문자열.
 *
 * 스레드 댓글이면 그 스레드를, 아니면 대화방 최상위를 읽는다. 최상위는 세션이 마지막
 * 차례를 끝낸 뒤부터(새 세션이면 12시간 전부터) 사람이 지금 보낸 글 전까지.
 */
export async function readUnseen(
  client: HistoryClient, channel: string, o: Omit<UnseenOpts, 'clock'>,
): Promise<string> {
  const read = (async () => {
    if (o.threadTs) {
      const r = await client.conversations.replies({ channel, ts: o.threadTs, limit: 30 });
      return unseenBlock(r.messages ?? [], o);
    }
    const oldest = o.sinceSec ?? (Number(o.currentTs) - NEW_SESSION_LOOKBACK_SEC);
    const r = await client.conversations.history({
      channel, oldest: String(oldest), latest: o.currentTs, inclusive: false, limit: 20,
    });
    return unseenBlock(r.messages ?? [], { ...o, sinceSec: oldest });
  })();
  // **못 읽은 것은 로그에 남긴다** — 조용히 빈 문자열만 내면 권한이 빠져도 이 장치가
  // 아무 일도 안 하는 것을 아무도 모른다. 글은 안 남기고 까닭만.
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<string>((resolve) => {
    timer = setTimeout(() => {
      logger.warn('세션이 못 본 글을 제때 못 읽어 안 붙입니다', { ms: READ_TIMEOUT_MS });
      resolve('');
    }, READ_TIMEOUT_MS);
  });
  try {
    return await Promise.race([read.catch((error) => {
      logger.warn('세션이 못 본 글을 못 읽어 안 붙입니다', { why: String((error as any)?.data?.error ?? (error as Error)?.message ?? error) });
      return '';
    }), late]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
