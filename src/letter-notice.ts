import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { App } from '@slack/bolt';
import { Logger } from './logger';
import type { TurnAsk } from './chat-host';

/**
 * 커피콩의 **전달** — 실장이 대화에서 「실원들에게 ○○ 전해 줘」라고 하면 방(general)에
 * 올린다. 말로 시작하지만 **나가는 관문은 버튼이다.**
 *
 *   1. 파이썬(`turn.py`)이 실장 턴에서 그 부탁을 `ask` 칸에 실어 보낸다 — 방에 안 올린다.
 *   2. 여기서 실장 DM 에 **확인 카드**를 띄운다(글 + 「확인 창 열기」 버튼).
 *   3. 버튼을 누르면 창이 뜬다 — 방을 고르고, 글을 고칠 수 있다.
 *   4. 「보내기」를 눌러야 방에 오른다. **창의 칸에 있던 글이 그대로** 나간다.
 *
 * 칭찬 전달(`letter-relay.ts`)의 「말로 시킬 수 없어야 잡담 중에 오발이 나지 않는다」를
 * 「말로 시작은 하되 대화만으로는 안 나간다」로 지킨다. 모델은 초안을 채울 뿐이고,
 * 실장이 마지막으로 본 글자가 나간다. 말투·성격은 안 얹는다 — 머리말 한 줄만 붙는다.
 *
 * **DM 에서 오간 말이 방으로 새는 일이 없어야 한다.** 그래서 카드는 실장 DM 에만 가고,
 * 방에는 실장이 창에서 「보내기」를 누른 그 글만 간다.
 */

const ACTION_OPEN = 'notice_open';
const CONFIRM = 'notice_confirm';
const BLOCK_TO = 'to';
const BLOCK_TEXT = 'body';
/** 파이썬 `control.actions` 의 이름. 다른 이름이 오면 모르는 부탁이라 버린다. */
const ACTION_NAME = 'notice';
const HEADER_TEXT = '실장님 말씀을 전합니다';
const HEADER = `:mega: *${HEADER_TEXT}*`;
const MAX_LEN = 2500;
/** 카드를 띄운 지 이만큼 지나면 버튼이 안 먹는다 — 며칠 지난 글이 나가면 안 된다. */
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;
/** 같은 글을 같은 방에 이 안에 두 번 보내는 것은 실수뿐이다. */
const AGAIN_S = 600;

export interface LetterNoticeOptions {
  /** 이 사람만 쓴다. 비면 기능 자체가 꺼진다. */
  managerUserId: string;
  /** 올릴 수 있는 방. 창에서 고른다. 비면 기능 자체가 꺼진다 — 갈 곳이 없다. */
  rooms: Array<{ id: string; label: string }>;
  /** 보낸 기록. `bots/letter/data/notice.jsonl` */
  logPath: string;
  /** 아직 안 보낸 카드. 재시작해도 카드의 버튼이 살아 있게 파일에 둔다. */
  pendingPath: string;
}

interface Pending {
  id: string;
  text: string;
  at: string;
  from: string;
}

interface Sent {
  ts: string;
  to: string;
  to_label: string;
  chars: number;
  head: string;
  sha: string;
}

const sha16 = (text: string): string =>
  crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);

export class LetterNotice {
  private logger = new Logger('Letter:notice');
  private pending = new Map<string, Pending>();

  constructor(private readonly opts: LetterNoticeOptions) {
    this.load();
  }

  get enabled(): boolean {
    return Boolean(this.opts.managerUserId) && this.opts.rooms.length > 0;
  }

  /** `ChatHost` 의 `attach` 로 넘긴다 — 소켓을 열기 전에 불린다. */
  register = (app: App): void => {
    if (!this.enabled) {
      this.logger.info('꺼짐 — 실장 ID 나 올릴 방이 비어 있습니다');
      return;
    }

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
      if (!found || this.expired(found)) {
        this.pending.delete(id);
        this.save();
        await this.tell(client, user, '이 카드는 만료됐습니다 — *아무것도 보내지 않았습니다.* 다시 말씀해 주세요.');
        return;
      }
      try {
        await client.views.open({ trigger_id: (body as any).trigger_id, view: this.confirmView(found) });
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
      const room = this.opts.rooms.find((r) => r.id === to);
      if (!room) {
        this.logger.warn(`목록에 없는 방(${to}) — 보내지 않습니다`);
        await this.tell(client, body.user.id, '목록에 없는 방이라 *아무것도 보내지 않았습니다.*');
        return;
      }
      let meta: { id?: string } = {};
      try {
        meta = JSON.parse((body.view.private_metadata || '{}') as string);
      } catch {
        meta = {};
      }
      const sent = await this.send(client, body.user.id, room, text);
      if (sent && meta.id) {
        this.pending.delete(meta.id);
        this.save();
      }
    });

    this.logger.info(`전달 준비됨 (올릴 방 ${this.opts.rooms.map((r) => r.label).join('·')})`);
  };

  /**
   * `ChatHost.onAsk` 로 넘긴다. 파이썬이 실장 턴에서 실은 부탁을 받아 **실장 DM 에 카드를
   * 띄운다.** 여기서 방에 올리지 않는다.
   */
  offer = async (
    client: App['client'], asks: TurnAsk[], from: { user: string; channel: string },
  ): Promise<void> => {
    if (!this.enabled) return;
    // 파이썬이 이미 실장 턴에서만 싣지만 여기서 한 번 더 본다 — 두 겹이라야 한쪽을
    // 고치다 어긋나도 안 샌다. 방에서 여러 사람이 섞인 턴은 `user` 가 비어 오므로 걸린다.
    if (from.user !== this.opts.managerUserId) {
      this.logger.warn(`실장이 아닌 턴(${from.user || '?'} · ${from.channel})에 부탁이 실려 왔습니다 — 버립니다`);
      return;
    }
    for (const ask of asks) {
      if (ask.name !== ACTION_NAME) {
        this.logger.warn(`모르는 부탁(${ask.name}) — 버립니다`);
        continue;
      }
      const text = (ask.text || '').trim().slice(0, MAX_LEN);
      if (!text) continue;
      const item: Pending = {
        id: crypto.randomBytes(6).toString('hex'),
        text,
        at: new Date().toISOString(),
        from: from.channel,
      };
      this.pending.set(item.id, item);
      this.save();
      await this.card(client, item);
    }
  };

  // ── 화면 ──────────────────────────────────────────────────────────────
  private async card(client: App['client'], item: Pending): Promise<void> {
    const rooms = this.opts.rooms.map((r) => r.label).join(' · ');
    const shown = item.text.length > 600 ? `${item.text.slice(0, 600)}…` : item.text;
    try {
      const im = await client.conversations.open({ users: this.opts.managerUserId });
      if (!im.channel?.id) throw new Error('DM 방을 못 열었습니다');
      await client.chat.postMessage({
        channel: im.channel.id,
        text: `방에 올릴까요? — ${item.text.slice(0, 40)}`,
        blocks: [
          {
            type: 'section',
            text: { type: 'mrkdwn', text: '*이 글을 방에 올릴까요?* 아직 아무 데도 안 나갔습니다.' },
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

  private confirmView(item: Pending): any {
    const options = this.opts.rooms.map((r) => ({
      text: { type: 'plain_text', text: r.label.slice(0, 75) }, value: r.id,
    }));
    return {
      type: 'modal',
      callback_id: CONFIRM,
      // 카드 ID 만 들고 간다. 글은 화면의 칸이 정본이다 — 두 군데 두면 어긋난다.
      private_metadata: JSON.stringify({ id: item.id }),
      title: { type: 'plain_text', text: '방에 올리기' },
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
          },
        },
        // **읽는 칸이 아니라 고치는 칸이다.** 여기 있는 글이 그대로 나간다.
        {
          type: 'input', block_id: BLOCK_TEXT,
          label: { type: 'plain_text', text: '올릴 글 (여기서 고칠 수 있습니다)' },
          hint: { type: 'plain_text', text: `이 칸에 있는 그대로 나갑니다. 앞에 「${HEADER_TEXT}」 한 줄이 붙습니다.` },
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
    client: App['client'], manager: string, room: { id: string; label: string }, text: string,
  ): Promise<boolean> {
    const again = this.sentJustNow(room.id, text);
    if (again !== null) {
      this.logger.info(`같은 글이 ${again}초 전에 ${room.label} 에 나갔습니다 — 다시 보내지 않습니다`);
      await this.tell(client, manager,
        `방금 ${again}초 전에 같은 글을 ${room.label} 에 올렸습니다. *다시 보내지 않았습니다.*`);
      return false;
    }
    try {
      const posted = await client.chat.postMessage({
        channel: room.id,
        text: `${HEADER}\n\n${text}`,
      });
      const record: Sent = {
        ts: new Date().toISOString(),
        to: room.id, to_label: room.label,
        chars: text.length,
        head: text.slice(0, 30),
        sha: sha16(text),
      };
      this.note(record);
      this.logger.info(`전달 완료 → ${room.label} (${text.length}자)`);

      let link = '';
      try {
        const got = await client.chat.getPermalink({ channel: room.id, message_ts: String(posted.ts) });
        link = got.permalink ? ` · <${got.permalink}|보기>` : '';
      } catch {
        link = '';
      }
      await this.tell(client, manager,
        `올렸습니다 · ${room.label} · ${text.length}자${link}\n> ${record.head}${text.length > 30 ? '…' : ''}`);
      return true;
    } catch (error) {
      this.logger.warn('전달 실패', error);
      await this.tell(client, manager,
        `올리지 못했습니다 (${room.label}). 카드는 그대로 있으니 다시 눌러 주세요.\n\`${String(error).slice(0, 200)}\``);
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
    return Date.now() - Date.parse(item.at) > PENDING_TTL_MS;
  }

  private load(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.opts.pendingPath, 'utf-8')) as Record<string, Pending>;
      for (const item of Object.values(raw)) {
        if (item?.id && item.text && !this.expired(item)) this.pending.set(item.id, item);
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
      fs.writeFileSync(this.opts.pendingPath, JSON.stringify(keep, null, 2), 'utf-8');
    } catch (error) {
      this.logger.warn('안 보낸 카드를 못 적었습니다', error);
    }
  }

  /** 검사용 — 지금 기다리는 카드 수. */
  pendingCount(): number {
    return this.pending.size;
  }
}
