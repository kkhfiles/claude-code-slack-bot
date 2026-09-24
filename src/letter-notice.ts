import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { App } from '@slack/bolt';
import { Logger } from './logger';
import type { TurnAsk } from './chat-host';

/**
 * 커피콩이 **실장 부탁으로 방에 글을 올리는 길** — 말로 시작하지만 **나가는 관문은 버튼이다.**
 *
 *   1. 파이썬(`turn.py`)이 실장 턴에서 그 부탁을 `ask` 칸에 실어 보낸다 — 방에 안 올린다.
 *   2. 여기서 실장 DM 에 **확인 카드**를 띄운다(글 + 「확인 창 열기」 버튼).
 *   3. 버튼을 누르면 창이 뜬다 — 방을 고르고, 글을 고칠 수 있다.
 *   4. 「보내기」를 눌러야 방에 오른다. **창의 칸에 있던 글이 그대로** 나간다.
 *
 * 부탁의 갈래(`kinds`)는 둘이고 글을 누가 쓰느냐가 다르다.
 *   - `notice` 「실원들에게 ○○ 전해 줘」 — 실장 말 그대로. 머리말 한 줄이 붙어 general 로.
 *   - `agenda` 「커피챗 활성화 안건 던져 줘」 — 주제만 받고 **커피콩이 초안을 쓴다.** 머리말
 *     없이 제 말로 커피챗 방에. 방에 올리는 것은 호스트라 대화 기억에 없으므로 **던진
 *     안건을 파일에 적어** 파이썬이 매 턴 붙이게 한다(`rememberPath`).
 *
 * 칭찬 전달(`letter-relay.ts`)의 「말로 시킬 수 없어야 잡담 중에 오발이 나지 않는다」를
 * 「말로 시작은 하되 대화만으로는 안 나간다」로 지킨다. 모델은 초안을 채울 뿐이고,
 * 실장이 마지막으로 본 글자가 나간다.
 *
 * **DM 에서 오간 말이 방으로 새는 일이 없어야 한다.** 그래서 카드는 실장 DM 에만 가고,
 * 방에는 실장이 창에서 「보내기」를 누른 그 글만 간다.
 */

const ACTION_OPEN = 'notice_open';
const CONFIRM = 'notice_confirm';
const BLOCK_TO = 'to';
const BLOCK_TEXT = 'body';
const MAX_LEN = 2500;
/** 카드를 띄운 지 이만큼 지나면 버튼이 안 먹는다 — 며칠 지난 글이 나가면 안 된다. */
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;
/** 같은 글을 같은 방에 이 안에 두 번 보내는 것은 실수뿐이다. */
const AGAIN_S = 600;
/** 던진 안건은 이만큼만 기억한다 — 매 턴 붙는 글이라 길면 대화 값을 먹는다. */
const REMEMBER_MAX = 3;

export interface NoticeRoom {
  id: string;
  label: string;
}

/** 부탁 한 갈래. 이름은 파이썬 `control.actions` 의 이름과 같아야 한다. */
export interface NoticeKind {
  /** 창 제목·카드 물음에 쓰는 이름. 「전할 말」·「안건」 */
  title: string;
  /** 카드의 물음 한 줄. */
  ask: string;
  /** 글 앞에 붙는 머리말(mrkdwn). 비면 안 붙는다 — 봇 제 말로 나간다. */
  header: string;
  /** 창의 글 칸 아래 안내 — 머리말이 붙는지, 제 말로 나가는지. */
  hint: string;
  /** 올릴 수 있는 방. 첫 것이 창에서 먼저 보인다. 비면 그 갈래는 꺼진다. */
  rooms: NoticeRoom[];
  /** 보낸 글을 적어 둘 파일 — 파이썬이 매 턴 붙여 봇이 「내가 던진 것」을 안다. 없으면 안 적는다. */
  rememberPath?: string;
  /** 기억 파일에 적는 방 — 여기 없는 방(시험 방·general)에 보낸 글은 안 적는다. 그 파일은 모든 턴에
   *  붙으므로 다른 방의 글이 섞이면 카드 없이 되풀이될 수 있다(외부 검토 2026-09-18). */
  rememberRooms?: string[];
  /** **봇이 쓴 글**(안건·아침 말 걸기)이면 참 — 카드를 만들 때와 **실장이 창에서 고친 뒤 보낼 때** 둘 다
   *  이름·멘션·집계·숫자·길이 빗장을 건다. 실장 말 그대로인 전할 말에는 안 건다. */
  guard?: boolean;
  /** 이 갈래의 글을 **다른 봇 이름으로** 올릴 때 그 봇의 클라이언트(소인의 주간 제안은 소인으로). 없으면 이 앱으로. */
  poster?: { chat: Pick<App['client']['chat'], 'postMessage' | 'getPermalink'> };
  /** 카드 머리에 보일 「누가 어느 방에 말을 꺼내려는지」의 봇 이름. 없으면 `ask` 한 줄. */
  speaker?: string;
}

export interface LetterNoticeOptions {
  /** 이 사람만 쓴다. 비면 기능 자체가 꺼진다. */
  managerUserId: string;
  /** 실원 명단 — `guard` 갈래의 이름 빗장에 쓴다(`users.info` 로 이름을 받아 둔다). */
  members?: string[];
  /** 갈래별 설정. 방이 하나도 없으면 기능 자체가 꺼진다 — 갈 곳이 없다. */
  kinds: Record<string, NoticeKind>;
  /** 보낸 기록. `bots/letter/data/notice.jsonl` */
  logPath: string;
  /** 아직 안 보낸 카드. 재시작해도 카드의 버튼이 살아 있게 파일에 둔다. */
  pendingPath: string;
}

interface Pending {
  id: string;
  kind: string;
  text: string;
  at: string;
  from: string;
  /** 주간 판단이 고른 방 — 창에서 먼저 골라 둔다. */
  room?: string;
}

interface Sent {
  ts: string;
  kind: string;
  to: string;
  to_label: string;
  chars: number;
  head: string;
  sha: string;
}

const sha16 = (text: string): string =>
  crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);

/** 봇이 쓴 글이 방에 갈 때의 빗장 — 파이썬 `privacy_gate` 와 같은 뜻을 다른 자료·언어로 한 번 더. */
const GUARD_MAX = 1200;
const MENTION = /<@[^>]+>/;
const NUM_KO = '(?:(?:열|스물|서른|마흔|쉰)(?:한|두|세|네|다섯|여섯|일곱|여덟|아홉)?|(?:한|두|세|네|다섯|여섯|일곱|여덟|아홉)|스무)';
const TALLY = new RegExp(`\\d+\\s*(?:명|건|%|퍼센트|배|위|등|번째)|${NUM_KO}\\s*(?:명|분)(?!화)|절반|과반|대다수|대부분|다수`);
const DIGIT_ALLOW = /1on1|\d{4}-\d{2}-\d{2}|\d{1,2}\s*\/\s*\d{1,2}|\d{1,2}\s*시(?:\s*\d{1,2}\s*분)?(?:\s*반)?|\d{1,2}\s*분|\d{1,2}\s*월|\d{1,2}\s*일|\d{1,2}\s*주|\d{4}\s*년/g;

export class LetterNotice {
  private logger = new Logger('Letter:notice');
  private pending = new Map<string, Pending>();
  private names = new Map<string, string[]>();
  /** 버튼 핸들러를 건 앱의 클라이언트. **카드는 이 앱으로 띄운다** — 다른 앱(소인)이 띄운 카드의 버튼은
   *  그 앱 소켓으로 가서 여기 핸들러에 안 닿는다(눌러도 아무 일 없음). */
  private home: App['client'] | null = null;

  constructor(private readonly opts: LetterNoticeOptions) {
    this.load();
  }

  get enabled(): boolean {
    return Boolean(this.opts.managerUserId) && this.kinds().length > 0;
  }

  /** 켜진 갈래 — 올릴 방이 하나라도 있는 것. */
  private kinds(): string[] {
    return Object.entries(this.opts.kinds).filter(([, k]) => k.rooms.length > 0).map(([n]) => n);
  }

  private kind(name: string): NoticeKind | null {
    const k = this.opts.kinds[name];
    return k && k.rooms.length > 0 ? k : null;
  }

  /** `ChatHost` 의 `attach` 로 넘긴다 — 소켓을 열기 전에 불린다. */
  register = (app: App): void => {
    if (!this.enabled) {
      this.logger.info('꺼짐 — 실장 ID 나 올릴 방이 비어 있습니다');
      return;
    }
    this.home = app.client ?? null;

    // 카드의 버튼 → 창. 창은 상호작용(trigger_id)에서만 열 수 있어서 카드가 한 단계 낀다.
    app.action(ACTION_OPEN, async ({ ack, body, client }) => {
      await ack();
      const user = body.user.id;
      if (user !== this.opts.managerUserId) {
        this.logger.info(`${user} 가 전달 카드를 눌렀지만 실장이 아닙니다`);
        return;
      }
      const id = String((body as any).actions?.[0]?.value ?? '');
      const found = this.pending.get(id);
      const kind = found ? this.kind(found.kind) : null;
      if (!found || !kind || this.expired(found)) {
        this.pending.delete(id);
        this.save();
        await this.tell(client, user, '이 카드는 만료됐습니다 — *아무것도 보내지 않았습니다.* 다시 말씀해 주세요.');
        return;
      }
      try {
        await client.views.open({ trigger_id: (body as any).trigger_id, view: this.confirmView(found, kind) });
      } catch (error) {
        this.logger.warn('확인 창을 못 열었습니다', error);
        await this.tell(client, user, `확인 창을 열지 못했습니다. 카드의 버튼을 한 번 더 눌러 주세요.\n\`${String(error).slice(0, 200)}\``);
      }
    });

    // 창 제출 = 보내기. **화면의 칸에 있던 글을 그대로 보낸다** — 실장이 방금 고쳤을 수
    // 있으므로 카드의 글을 다시 꺼내 쓰지 않는다.
    app.view(CONFIRM, async ({ ack, body, view, client }) => {
      const to = view.state.values[BLOCK_TO]?.[BLOCK_TO]?.selected_option?.value ?? '';
      const text = (view.state.values[BLOCK_TEXT]?.[BLOCK_TEXT]?.value ?? '').trim();
      if (!to) {
        await ack({ response_action: 'errors', errors: { [BLOCK_TO]: '올릴 방을 고르세요.' } });
        return;
      }
      if (!text) {
        await ack({ response_action: 'errors', errors: { [BLOCK_TEXT]: '빈 글은 보내지 않습니다.' } });
        return;
      }
      if (text.length > MAX_LEN) {
        await ack({
          response_action: 'errors',
          errors: { [BLOCK_TEXT]: `${MAX_LEN}자까지만 됩니다 (지금 ${text.length}자).` },
        });
        return;
      }
      // **창을 통째로 닫는다**(칭찬 전달과 같은 이유 — 남은 화면이 두 번 누르게 만든다).
      await ack({ response_action: 'clear' });

      if (body.user.id !== this.opts.managerUserId) {
        this.logger.warn(`${body.user.id} 가 전달 창을 제출했지만 실장이 아닙니다 — 보내지 않습니다`);
        return;
      }
      let meta: { id?: string; kind?: string } = {};
      try {
        meta = JSON.parse((body.view.private_metadata || '{}') as string);
      } catch {
        meta = {};
      }
      const kind = this.kind(meta.kind || '');
      const room = kind?.rooms.find((r) => r.id === to);
      if (!kind || !room) {
        this.logger.warn(`목록에 없는 갈래(${meta.kind})나 방(${to}) — 보내지 않습니다`);
        await this.tell(client, body.user.id, '목록에 없는 방이라 *아무것도 보내지 않았습니다.*');
        return;
      }
      // **제출할 때 카드를 다시 본다** — 창을 미리 열어 두고 카드가 만료·소진된 뒤에 눌러도 나가면
      // 안 된다(외부 검토 2026-09-18). 있고·같은 갈래고·안 지났으면 **먼저 소진한다**(선점) — 창을
      // 둘 열어 같이 누르면 둘째는 여기서 걸린다.
      const found = meta.id ? this.pending.get(meta.id) : undefined;
      if (!found || found.kind !== meta.kind || this.expired(found)) {
        if (meta.id) { this.pending.delete(meta.id); this.save(); }
        this.logger.warn(`카드가 없거나 만료됨(${meta.id}) — 보내지 않습니다`);
        await this.tell(client, body.user.id, '이 카드는 만료됐거나 이미 처리됐습니다 — *아무것도 보내지 않았습니다.* 다시 말씀해 주세요.');
        return;
      }
      this.pending.delete(found.id);
      this.save();
      // 봇이 쓴 글은 실장이 고친 뒤에도 빗장을 거친다 — 고치다 이름·숫자가 들어가는 것을 막는다.
      if (kind.guard) {
        const why = await this.guard(client, text);
        if (why) {
          this.logger.warn(`보내기 직전 빗장에 막힘 — ${why}`);
          await this.tell(client, body.user.id, `:no_entry_sign: 고친 글이 *빗장에 막혔습니다* — ${why}\n_아무것도 안 나갔습니다. 카드는 닫혔으니 다시 말씀해 주세요._`);
          return;
        }
      }
      await this.send(client, body.user.id, meta.kind || '', kind, room, text);
    });

    const rooms = this.kinds().map((n) => `${n}→${this.opts.kinds[n].rooms.map((r) => r.label).join('·')}`);
    this.logger.info(`전달 준비됨 (${rooms.join(' / ')})`);
  };

  /**
   * `ChatHost.onAsk` 로 넘긴다. 파이썬이 실장 턴에서 실은 부탁을 받아 **실장 DM 에 카드를
   * 띄운다.** 여기서 방에 올리지 않는다.
   */
  offer = async (
    client: App['client'], asks: TurnAsk[], from: { user: string; channel: string },
  ): Promise<void> => {
    if (!this.enabled) return;
    // 부른 쪽이 다른 앱(소인의 주간 시계)이어도 카드·빗장 조회는 버튼을 받는 앱으로.
    client = this.home ?? client;
    // 파이썬이 이미 실장 턴에서만 싣지만 여기서 한 번 더 본다 — 두 겹이라야 한쪽을
    // 고치다 어긋나도 안 샌다. 방에서 여러 사람이 섞인 턴은 `user` 가 비어 오므로 걸린다.
    if (from.user !== this.opts.managerUserId) {
      this.logger.warn(`실장이 아닌 턴(${from.user || '?'} · ${from.channel})에 부탁이 실려 왔습니다 — 버립니다`);
      return;
    }
    // **같은 갈래가 여럿이면 「후보 n/N — 하나만」으로 번호를 붙인다.** 주간 턴이 대화를 풀어 가는
    // 길을 두세 가지로 내고 실장이 고른다(실장 2026-09-21). 카드는 갈래마다 하나씩 그대로 —
    // 고르는 것은 그중 하나를 열어 보내는 일이고, 나머지는 두면 하루 뒤 만료된다.
    const total = new Map<string, number>();
    for (const a of asks) total.set(a.name, (total.get(a.name) ?? 0) + 1);
    const seen = new Map<string, number>();
    for (const ask of asks) {
      const kind = this.kind(ask.name);
      if (!kind) {
        this.logger.warn(`모르는 부탁(${ask.name}) — 버립니다`);
        continue;
      }
      const text = String(ask.text ?? '').trim().slice(0, MAX_LEN);
      if (!text) continue;
      if (kind.guard) {
        const why = await this.guard(client, text);
        if (why) {
          this.logger.warn(`카드 만들기 전 빗장에 막힘 — ${why}`);
          await this.tell(client, this.opts.managerUserId, `:no_entry_sign: ${kind.title} 글이 *빗장에 막혀 카드를 안 만들었습니다* — ${why}`);
          continue;
        }
      }
      const item: Pending = {
        id: crypto.randomBytes(6).toString('hex'),
        kind: ask.name,
        text,
        at: new Date().toISOString(),
        from: from.channel,
        ...(ask.room ? { room: String(ask.room) } : {}),
      };
      this.pending.set(item.id, item);
      this.save();
      const n = (seen.get(ask.name) ?? 0) + 1;
      seen.set(ask.name, n);
      await this.card(client, item, kind, (total.get(ask.name) ?? 1) > 1 ? { n, of: total.get(ask.name)! } : undefined);
    }
  };

  // ── 화면 ──────────────────────────────────────────────────────────────
  private async card(
    client: App['client'], item: Pending, kind: NoticeKind, alt?: { n: number; of: number },
  ): Promise<void> {
    const rooms = kind.rooms.map((r) => r.label).join(' · ');
    const shown = item.text.length > 600 ? `${item.text.slice(0, 600)}…` : item.text;
    const where = item.room ? kind.rooms.find((r) => r.id === item.room)?.label : '';
    const lead = kind.speaker ? `*${kind.speaker}이 ${where || '방'}에 먼저 말을 꺼내려 합니다.*` : `*${kind.ask}*`;
    const head = alt
      ? `${lead} 후보 ${alt.n}/${alt.of} — *하나만* 골라 보내세요. 나머지는 그냥 두면 하루 뒤 만료됩니다.`
      : `${lead} 아직 아무 데도 안 나갔습니다.`;
    try {
      const im = await client.conversations.open({ users: this.opts.managerUserId });
      if (!im.channel?.id) throw new Error('DM 방을 못 열었습니다');
      await client.chat.postMessage({
        channel: im.channel.id,
        text: `${kind.ask} — ${item.text.slice(0, 40)}`,
        blocks: [
          {
            type: 'section',
            text: { type: 'mrkdwn', text: head },
          },
          {
            type: 'section',
            text: { type: 'mrkdwn', text: shown.split('\n').map((l) => `> ${l}`).join('\n') },
          },
          {
            type: 'actions',
            elements: [{
              type: 'button', action_id: ACTION_OPEN, style: 'primary', value: item.id,
              text: { type: 'plain_text', text: '확인 창 열기' },
            }],
          },
          {
            type: 'context',
            elements: [{
              type: 'mrkdwn',
              text: `창에서 방(${rooms})을 고르고 글을 고칠 수 있습니다. 「보내기」를 눌러야 나갑니다. `
                + '안 올리려면 그냥 두세요 (하루 뒤 만료).',
            }],
          },
        ],
      });
    } catch (error) {
      this.logger.warn('확인 카드를 못 띄웠습니다', error);
    }
  }

  private confirmView(item: Pending, kind: NoticeKind): any {
    const options = kind.rooms.map((r) => ({
      text: { type: 'plain_text', text: r.label.slice(0, 75) }, value: r.id,
    }));
    return {
      type: 'modal',
      callback_id: CONFIRM,
      // 카드 ID 와 갈래만 들고 간다. 글은 화면의 칸이 정본이다 — 두 군데 두면 어긋난다.
      private_metadata: JSON.stringify({ id: item.id, kind: item.kind }),
      title: { type: 'plain_text', text: kind.title },
      submit: { type: 'plain_text', text: '보내기' },
      close: { type: 'plain_text', text: '취소' },
      blocks: [
        {
          type: 'input', block_id: BLOCK_TO,
          label: { type: 'plain_text', text: '올릴 방' },
          element: {
            type: 'static_select', action_id: BLOCK_TO,
            placeholder: { type: 'plain_text', text: '고르세요' },
            options,
            // 후속 부탁은 그 방을 먼저 골라 둔다 — 다른 방으로 바꿀 수는 있다.
            ...(item.room && options.some((o) => o.value === item.room)
              ? { initial_option: options.find((o) => o.value === item.room) } : {}),
          },
        },
        // **읽는 칸이 아니라 고치는 칸이다.** 여기 있는 글이 그대로 나간다.
        {
          type: 'input', block_id: BLOCK_TEXT,
          label: { type: 'plain_text', text: '올릴 글 (여기서 고칠 수 있습니다)' },
          hint: { type: 'plain_text', text: kind.hint },
          element: {
            type: 'plain_text_input', action_id: BLOCK_TEXT, multiline: true,
            initial_value: item.text,
          },
        },
      ],
    };
  }

  // ── 보내기 ────────────────────────────────────────────────────────────
  private async send(
    client: App['client'], manager: string, name: string, kind: NoticeKind, room: NoticeRoom,
    text: string,
  ): Promise<boolean> {
    const again = this.sentJustNow(room.id, text);
    if (again !== null) {
      this.logger.info(`같은 글이 ${again}초 전에 ${room.label} 에 나갔습니다 — 다시 보내지 않습니다`);
      await this.tell(client, manager,
        `방금 ${again}초 전에 같은 글을 ${room.label} 에 올렸습니다. *다시 보내지 않았습니다.*`);
      return false;
    }
    // **기록을 올리기 전에 남긴다.** 슬랙이 올려 놓고 응답만 늦어 예외가 나면, 기록이 없을 때는
    // 「다시 눌러」가 곧 두 번 올리기다(외부 검토 2026-09-18). 기록이 먼저 있으면 같은 글은
    // 10분 안에 안 나간다 — 닫힌 쪽이다.
    const record: Sent = {
      ts: new Date().toISOString(),
      kind: name,
      to: room.id, to_label: room.label,
      chars: text.length,
      head: text.slice(0, 30),
      sha: sha16(text),
    };
    this.note(record);
    // 다른 봇 이름으로 올리는 갈래(소인 방의 후속)는 그 봇의 클라이언트로 — 없으면 이 앱(커피콩)으로.
    const poster = kind.poster ?? client;
    try {
      const posted = await poster.chat.postMessage({
        channel: room.id,
        text: kind.header ? `${kind.header}\n\n${text}` : text,
      });
      if (kind.rememberPath && (kind.rememberRooms ?? []).includes(room.id)) {
        this.remember(kind.rememberPath, room, text, record.ts);
      }
      this.logger.info(`${kind.title} 완료 → ${room.label} (${text.length}자)`);

      let link = '';
      try {
        const got = await poster.chat.getPermalink({ channel: room.id, message_ts: String(posted.ts) });
        link = got.permalink ? ` · <${got.permalink}|보기>` : '';
      } catch {
        link = '';
      }
      await this.tell(client, manager,
        `올렸습니다 · ${room.label} · ${text.length}자${link}\n> ${record.head}${text.length > 30 ? '…' : ''}`);
      return true;
    } catch (error) {
      this.logger.warn(`${kind.title} 실패`, error);
      await this.tell(client, manager,
        `올리지 못했을 수 있습니다 (${room.label}) — *방을 먼저 확인해 주세요.* 카드는 닫혔고, 같은 글은 10분 안에 다시 안 나갑니다.\n\`${String(error).slice(0, 200)}\``);
      return false;
    }
  }

  /** 실장에게만 가는 영수증. */
  private async tell(client: App['client'], user: string, text: string): Promise<void> {
    try {
      const im = await client.conversations.open({ users: user });
      if (im.channel?.id) await client.chat.postMessage({ channel: im.channel.id, text });
    } catch (error) {
      this.logger.debug('영수증을 못 보냈습니다', error);
    }
  }

  // ── 기록 ──────────────────────────────────────────────────────────────
  /** 나간 글 자체는 남기지 않는다 — 지문(해시)과 앞머리면 두 번 보낸 것을 알아보기에 충분하다. */
  private note(record: Sent): void {
    try {
      fs.mkdirSync(path.dirname(this.opts.logPath), { recursive: true });
      fs.appendFileSync(this.opts.logPath, `${JSON.stringify(record)}\n`, 'utf-8');
    } catch (error) {
      this.logger.warn('보낸 기록을 못 남겼습니다', error);
    }
  }

  /**
   * 던진 글을 봇이 기억하게 적는다 — 파이썬이 `context_files` 로 매 턴 붙인다. 방에 올린
   * 것은 호스트라 대화 기억에 없고, 이 파일이 없으면 누가 답해도 무슨 안건인지 모른 채
   * 받는다. **글 전체가 들어간다**(기록과 달리) — 봇이 그 글을 알아야 하기 때문이다.
   * 최근 것부터 `REMEMBER_MAX` 개만 둔다.
   */
  private remember(file: string, room: NoticeRoom, text: string, ts: string): void {
    const head = '# 네가 방에 먼저 올린 글 — 안건·아침 말 걸기 (최근 것부터 · 네가 쓰고 실장이 보내기를 누른 글이다)';
    const entry = `## ${ts.slice(0, 16).replace('T', ' ')} · ${room.label} 방\n${text}`;
    let old: string[] = [];
    try {
      const body = fs.readFileSync(file, 'utf-8');
      old = body.split(/\n(?=## )/).slice(1).map((s) => s.trim()).filter(Boolean);
    } catch {
      old = [];
    }
    const entries = [entry, ...old].slice(0, REMEMBER_MAX);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${head}\n\n${entries.join('\n\n')}\n`, 'utf-8');
    } catch (error) {
      this.logger.warn('던진 안건을 못 적었습니다', error);
    }
  }

  private sentJustNow(to: string, text: string): number | null {
    const sha = sha16(text);
    for (const past of this.history()) {
      if (past.to !== to || past.sha !== sha) continue;
      const ago = (Date.now() - Date.parse(past.ts)) / 1000;
      return ago >= 0 && ago < AGAIN_S ? Math.round(ago) : null;
    }
    return null;
  }

  private history(): Sent[] {
    try {
      return fs.readFileSync(this.opts.logPath, 'utf-8').trim().split('\n')
        .filter(Boolean).reverse().map((line) => JSON.parse(line) as Sent);
    } catch {
      return [];
    }
  }

  // ── 안 보낸 카드 ───────────────────────────────────────────────────────
  private expired(item: Pending): boolean {
    const at = Date.parse(item.at);
    if (Number.isNaN(at)) return true;   // 시각이 깨진 카드는 만료로 — 영영 살아 있으면 안 된다
    return Date.now() - at > PENDING_TTL_MS;
  }

  // ── 봇이 쓴 글의 빗장 ───────────────────────────────────────────────────
  /** 막을 까닭 한 줄. 비면 통과. 이름을 못 받아 온 실원이 있으면 **막는다**(못 본 채 통과시키지 않는다). */
  private async guard(client: App['client'], text: string): Promise<string> {
    if (text.length > GUARD_MAX) return `너무 김(${text.length}자)`;
    const m = text.match(MENTION);
    if (m) return `사람 지목(${m[0]})`;
    const t = text.match(TALLY);
    if (t) return `집계·건수(「${t[0]}」)`;
    const rest = text.replace(DIGIT_ALLOW, '');
    const d = rest.match(/\d/);
    if (d && d.index !== undefined) return `숫자(「${rest.slice(Math.max(0, d.index - 3), d.index + 4).trim()}」)`;
    for (const id of this.opts.members ?? []) {
      const names = await this.namesOf(client, id);
      if (!names.length) return `이름을 못 받아 옴(${id}) — 빗장을 못 세워 막음`;
      for (const name of names) if (name && text.includes(name)) return `실원 이름(「${name}」)`;
    }
    return '';
  }

  private async namesOf(client: App['client'], id: string): Promise<string[]> {
    const cached = this.names.get(id);
    if (cached) return cached;
    const out = new Set<string>();
    try {
      const res = await client.users.info({ user: id });
      const profile = res.user?.profile as { display_name?: string; real_name?: string } | undefined;
      for (const raw of [profile?.real_name, profile?.display_name, res.user?.real_name]) {
        const name = (raw || '').trim();
        if (!name) continue;
        out.add(name);
        // 「홍길동」→「길동」. 두 자 이름은 성을 떼면 한 자라 못 쓴다.
        if (/^[가-힣]{3,4}$/.test(name)) out.add(name.slice(1));
      }
    } catch (error) {
      this.logger.warn(`users.info 실패 (${id}) — 이번엔 막고 다음에 다시 받아 온다`, error);
      return [];   // 실패는 캐시하지 않는다
    }
    const names = [...out];
    if (names.length) this.names.set(id, names);
    return names;
  }

  private load(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.opts.pendingPath, 'utf-8')) as Record<string, Pending>;
      for (const item of Object.values(raw)) {
        if (item?.id && item.text && item.kind && !this.expired(item)) this.pending.set(item.id, item);
      }
    } catch {
      // 아직 없다 — 처음이다.
    }
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.opts.pendingPath), { recursive: true });
      const keep: Record<string, Pending> = {};
      for (const [id, item] of this.pending) if (!this.expired(item)) keep[id] = item;
      // 임시 파일에 쓰고 바꿔 끼운다 — 쓰는 도중 죽어도 반 토막 파일이 안 남는다.
      const tmp = `${this.opts.pendingPath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(keep, null, 2), 'utf-8');
      fs.renameSync(tmp, this.opts.pendingPath);
    } catch (error) {
      this.logger.warn('안 보낸 카드를 못 적었습니다', error);
    }
  }

  /** 검사용 — 지금 기다리는 카드 수. */
  pendingCount(): number {
    return this.pending.size;
  }
}

/** 커피콩의 두 갈래를 만든다. 방이 비어 오면 그 갈래는 창에 안 뜬다. */
export function coffeeKinds(
  rooms: { general?: string; chat?: string; test?: string },
  files: { agenda?: string } = {},
): Record<string, NoticeKind> {
  const general = rooms.general ? [{ id: rooms.general, label: 'general' }] : [];
  const chat = rooms.chat ? [{ id: rooms.chat, label: '커피챗' }] : [];
  const test = rooms.test ? [{ id: rooms.test, label: 'bot_test' }] : [];
  return {
    notice: {
      title: '전할 말 올리기',
      ask: '이 글을 방에 올릴까요?',
      header: ':mega: *실장님 말씀을 전합니다*',
      hint: '이 칸에 있는 그대로 나갑니다. 앞에 「실장님 말씀을 전합니다」 한 줄이 붙습니다.',
      rooms: [...general, ...test],
    },
    agenda: {
      title: '안건 던지기',
      ask: '이 안건을 던질까요? (커피콩이 쓴 초안입니다)',
      header: '',
      hint: '이 칸에 있는 그대로 커피콩 말로 나갑니다 (머리말 없음). 마음에 안 들면 고치거나 취소하세요.',
      rooms: [...chat, ...test, ...general],
      rememberPath: files.agenda,
      rememberRooms: chat.map((r) => r.id),
      guard: true,
    },
    // 주간 시계(`letter-initiative.ts`)가 실은 「이번 주 커피챗 방에 걸 글」 — 대개 두세 후보가
    // 한꺼번에 온다. 안건과 같은 관문·같은 기억 파일이고, 파이썬 쪽 빗장(`gate`)을 이미 지난 글이다.
    pulse: {
      title: '커피챗 방에 먼저 말 걸기',
      ask: '이번 주 커피챗 방에 이렇게 말할까요? (주간 현황과 방의 지난주를 보고 커피콩이 쓴 글입니다)',
      header: '',
      hint: '이 칸에 있는 그대로 커피콩 말로 나갑니다 (머리말 없음). 마음에 안 들면 고치거나 취소하세요.',
      rooms: [...chat, ...test],
      rememberPath: files.agenda,
      rememberRooms: chat.map((r) => r.id),
      guard: true,
    },
  };
}
