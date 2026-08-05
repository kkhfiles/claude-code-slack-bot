import * as fs from 'fs';
import * as path from 'path';
import { App } from '@slack/bolt';
import { Logger } from './logger';

/**
 * 레터의 **1on1 신청 창구** — 반기 정기 1on1 말고, 하고 싶을 때 여는 자리.
 *
 * 결정과 근거는 `D:/management/1on1-h2-2026/README.md` §7 에 있다. 코드가 지켜야 하는 것:
 *
 *   1. **사람에게 말하지 않는다.** 실원은 봇에 넣고, 실장에게는 봇이 나른다. 창구를 만든
 *      이유가 "요청하는 압박"을 없애는 것이라, 압박이 붙는 자리는 봇이 계속 흡수한다.
 *   2. **용건을 안 적어도 된다.** 적는 칸은 있지만 비워도 들어간다.
 *   3. **취소도 봇으로 한다.** 사람에게 취소를 말하는 것이 신청보다 어렵다. 이유도 안 묻는다.
 *   4. **시간은 실장이 잡는다.** 매번 사정이 달라 미리 열어둔 칸이 안 맞는다(2026-08-05 결정).
 *      봇은 접수와 전달만 하고, 확정은 실장이 사람으로 한다.
 *   5. **한 사람당 한 달에 한 번.** 그 이상은 이 창구가 아니라 다른 길로 가는 게 맞다.
 *   6. **누가 넣었는지는 실장만 본다.** 다른 실원에게는 자기 것만 보인다.
 *
 * 길이는 정하지 않는다 — 설문에서 나온 길이 문제는 반기 1on1 이야기라 여기까지 미리
 * 조이지 않기로 했다.
 */

const COMMAND = '/1on1';
const ASK = 'booking_ask';
const CANCEL = 'booking_cancel';
const DONE = 'booking_done';

const BLOCK_WHEN = 'when';
const BLOCK_NOTE = 'note';
const MAX_TEXT = 500;

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

export interface LetterBookingOptions {
  /** 신청을 받는 사람(실장). 비면 기능이 꺼진다. */
  managerUserId: string;
  /** 신청할 수 있는 사람. 비면 기능이 꺼진다. */
  members: string[];
  /** 신청 기록. `turn.py` 옆 `bots/letter/data/` 를 그대로 쓴다. */
  logPath: string;
}

interface Entry {
  ts: string;
  action: 'ask' | 'cancel' | 'done';
  /** 신청 하나를 가리키는 열쇠. 신청한 순간의 시각을 그대로 쓴다. */
  id: string;
  user: string;
  user_name: string;
  when?: string;
  note?: string;
}

export class LetterBooking {
  private logger = new Logger('Letter:1on1');
  private names = new Map<string, string>();

  constructor(private readonly opts: LetterBookingOptions) {}

  get enabled(): boolean {
    return Boolean(this.opts.managerUserId) && this.opts.members.length > 0;
  }

  /** `ChatHost` 의 `attach` 로 넘긴다 — 소켓을 열기 전에 불린다. */
  register = (app: App): void => {
    if (!this.enabled) {
      this.logger.info('꺼짐 — 실장 ID 나 명단이 비어 있습니다');
      return;
    }

    app.command(COMMAND, async ({ command, ack, respond, client }) => {
      await ack();
      const me = command.user_id;
      // 슬래시 명령은 앱이 깔린 사람 모두에게 보인다. 명단 밖이면 조용히 무시하지 말고
      // 본인에게만 알린다 — 아무 반응이 없으면 고장으로 읽힌다.
      if (me !== this.opts.managerUserId && !this.opts.members.includes(me)) {
        this.logger.info(`${me} 가 ${COMMAND} 를 불렀지만 명단에 없습니다`);
        await respond({ response_type: 'ephemeral', text: '이 명령은 Dynamic실 실원만 쓸 수 있습니다.' });
        return;
      }
      try {
        await client.views.open({
          trigger_id: command.trigger_id,
          view: me === this.opts.managerUserId ? this.managerView() : this.memberView(me),
        });
      } catch (error) {
        this.logger.warn('신청 창을 못 열었습니다', error);
        await respond({
          response_type: 'ephemeral',
          text: `신청 창을 열지 못했습니다. 한 번 더 시도해 주세요.\n\`${String(error).slice(0, 200)}\``,
        });
      }
    });

    app.view(ASK, async ({ ack, body, view, client }) => {
      const me = body.user.id;
      const when = (view.state.values[BLOCK_WHEN]?.[BLOCK_WHEN]?.value ?? '').trim();
      const note = (view.state.values[BLOCK_NOTE]?.[BLOCK_NOTE]?.value ?? '').trim();

      const tooLong = [
        [BLOCK_WHEN, when] as const,
        [BLOCK_NOTE, note] as const,
      ].find(([, text]) => text.length > MAX_TEXT);
      if (tooLong) {
        await ack({
          response_action: 'errors',
          errors: { [tooLong[0]]: `${MAX_TEXT}자까지만 됩니다 (지금 ${tooLong[1].length}자).` },
        });
        return;
      }
      // **창을 연 뒤에 같은 사람이 다른 창에서 넣었을 수 있다.** 넣기 직전에 다시 본다.
      if (this.thisMonth(me)) {
        await ack({
          response_action: 'errors',
          errors: { [BLOCK_WHEN]: '이번 달 신청이 이미 들어가 있습니다. 창을 닫고 다시 열어 보세요.' },
        });
        return;
      }

      await ack({ response_action: 'clear' });
      const now = new Date().toISOString();
      const name = await this.person(client, me);
      this.note({ ts: now, action: 'ask', id: now, user: me, user_name: name, when: when || undefined, note: note || undefined });
      this.logger.info(`신청 ← ${name}${when ? ` (${when})` : ''}`);

      await this.tell(client, me,
        '1on1 신청이 들어갔습니다. 실장이 시간을 잡아 다시 알려드립니다.\n'
        + `무르시려면 \`${COMMAND}\` 를 다시 부르세요. 이유는 안 물어봅니다.`);
      await this.tell(client, this.opts.managerUserId,
        `*1on1 신청 · ${name}*\n`
        + `${when ? `편한 때: ${when}\n` : '편한 때: 안 적음\n'}`
        + `${note ? `> ${note}\n` : ''}`
        + `시간을 잡아 직접 알려주세요. 처리하신 뒤 \`${COMMAND}\` 에서 내리시면 됩니다.`);
    });

    // 무르기 — 되돌릴 수 있는 일이라 확인 단계를 두지 않는다. 한 단계를 더 붙이면
    // "취소도 봇으로" 를 만든 이유가 없어진다.
    app.action({ action_id: CANCEL }, async ({ ack, body, client }) => {
      await ack();
      const payload = body as any;
      const me = payload.user?.id as string;
      const id = payload.actions?.[0]?.value as string;
      if (!me || !id) return;

      const asked = this.pending().find((entry) => entry.id === id);
      // 본인 것만 무른다. 실장이 남의 신청을 없애는 것은 '처리함'(DONE) 쪽이다.
      if (!asked || asked.user !== me) {
        this.logger.info(`${me} 가 남의(또는 없는) 신청을 무르려 했습니다 — 무시`);
        return;
      }
      const name = await this.person(client, me);
      this.note({ ts: new Date().toISOString(), action: 'cancel', id, user: me, user_name: name });
      this.logger.info(`무름 ← ${name}`);

      await this.refresh(client, payload.view?.id, this.memberView(me, '신청을 물렀습니다. 이번 달에 다시 넣으실 수 있습니다.'));
      await this.tell(client, this.opts.managerUserId, `1on1 신청 무름 · *${name}*`);
    });

    // 처리함 — 실장이 시간을 잡아 알린 뒤 목록에서 내린다. **신청자에게는 안 알린다**
    // (이미 실장이 직접 말했으므로, 봇이 또 알리면 같은 말이 두 번 간다).
    app.action({ action_id: DONE }, async ({ ack, body, client }) => {
      await ack();
      const payload = body as any;
      const me = payload.user?.id as string;
      const id = payload.actions?.[0]?.value as string;
      if (me !== this.opts.managerUserId || !id) return;

      const asked = this.pending().find((entry) => entry.id === id);
      if (!asked) return;
      this.note({ ts: new Date().toISOString(), action: 'done', id, user: asked.user, user_name: asked.user_name });
      this.logger.info(`처리함 · ${asked.user_name}`);

      await this.refresh(client, payload.view?.id, this.managerView(`${asked.user_name} 님 신청을 내렸습니다.`));
    });

    this.logger.info(`${COMMAND} 준비됨 (신청 가능 ${this.opts.members.length}명 · 한 달 한 번)`);
  };

  // ── 화면 ──────────────────────────────────────────────────────────────
  private memberView(user: string, flash?: string): any {
    const mine = this.thisMonth(user);
    const blocks: any[] = [];
    if (flash) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: flash }] });

    if (mine) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*넣어 두신 신청*\n${this.day(mine.ts)} 신청`
            + `${mine.when ? `\n편한 때: ${mine.when}` : ''}`,
        },
        accessory: {
          type: 'button', action_id: CANCEL, value: mine.id,
          text: { type: 'plain_text', text: '무르기' },
        },
      });
      blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: '실장이 시간을 잡아 알려드립니다. 무르셔도 이유는 안 물어봅니다.' }],
      });
      return this.modal(blocks);
    }

    blocks.push(
      {
        type: 'section',
        text: { type: 'mrkdwn', text: '실장과 1on1 시간을 잡습니다. *용건은 없어도 됩니다.*' },
      },
      {
        type: 'input', block_id: BLOCK_WHEN, optional: true,
        label: { type: 'plain_text', text: '편한 때가 있으면 (안 적으셔도 됩니다)' },
        hint: { type: 'plain_text', text: '"다음 주 오후", "금요일 빼고" 처럼 적으셔도 됩니다.' },
        element: { type: 'plain_text_input', action_id: BLOCK_WHEN },
      },
      {
        type: 'input', block_id: BLOCK_NOTE, optional: true,
        label: { type: 'plain_text', text: '미리 알려두실 것 (안 적으셔도 됩니다)' },
        hint: { type: 'plain_text', text: '실장에게만 보입니다.' },
        element: { type: 'plain_text_input', action_id: BLOCK_NOTE, multiline: true },
      },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: '한 달에 한 번 넣으실 수 있습니다. 무르면 그 달에 다시 넣으실 수 있습니다.' }],
      },
    );
    return this.modal(blocks, ASK, '신청');
  }

  private managerView(flash?: string): any {
    const waiting = this.pending();
    const blocks: any[] = [];
    if (flash) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: flash }] });

    if (waiting.length === 0) {
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '*기다리는 신청이 없습니다.*' } });
    } else {
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*기다리는 신청 ${waiting.length}건*` } });
      for (const entry of waiting) {
        blocks.push({
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*${entry.user_name}* · ${this.day(entry.ts)} 신청\n`
              + `${entry.when ? `편한 때: ${entry.when}\n` : '편한 때: 안 적음\n'}`
              + `${entry.note ? `> ${entry.note}` : ''}`,
          },
          accessory: {
            type: 'button', action_id: DONE, value: entry.id,
            text: { type: 'plain_text', text: '처리함' },
          },
        });
      }
    }
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: '시간은 직접 잡아 알려주세요. 여기서 내려도 신청자에게는 아무 말도 안 갑니다.' }],
    });
    return this.modal(blocks);
  }

  private modal(blocks: any[], callback?: string, submit?: string): any {
    const view: any = {
      type: 'modal',
      title: { type: 'plain_text', text: '1on1 신청' },
      close: { type: 'plain_text', text: '닫기' },
      blocks,
    };
    if (callback) {
      view.callback_id = callback;
      view.submit = { type: 'plain_text', text: submit ?? '확인' };
    }
    return view;
  }

  /** 버튼을 누른 창을 새로 그린다. 실패해도 기록은 이미 남았으므로 로그만 남긴다. */
  private async refresh(client: App['client'], viewId: string | undefined, view: any): Promise<void> {
    if (!viewId) return;
    try {
      await client.views.update({ view_id: viewId, view });
    } catch (error) {
      this.logger.debug('화면 갱신 실패', error);
    }
  }

  // ── 기록 ──────────────────────────────────────────────────────────────
  /**
   * 아직 실장이 안 내린 신청들. 파일은 붙여 쓰기만 하므로(누가 언제 넣고 물렀는지가
   * 그대로 남는다) 앞에서부터 되짚어 지금 상태를 만든다.
   */
  private pending(): Entry[] {
    const alive = new Map<string, Entry>();
    for (const entry of this.history()) {
      if (entry.action === 'ask') alive.set(entry.id, entry);
      else alive.delete(entry.id);
    }
    return [...alive.values()].sort((a, b) => a.ts.localeCompare(b.ts));
  }

  /**
   * 이 사람이 **이번 달에 쓴** 신청. 무른 것은 안 쓴 것으로 친다(그래서 다시 넣을 수 있다).
   * 실장이 처리한 것은 **쓴 것으로 친다** — 그 달 만남이 이미 잡혔다는 뜻이다.
   */
  private thisMonth(user: string): Entry | null {
    const month = new Date().toISOString().slice(0, 7);
    const alive = new Map<string, Entry>();
    for (const entry of this.history()) {
      if (entry.action === 'ask') alive.set(entry.id, entry);
      else if (entry.action === 'cancel') alive.delete(entry.id);
      // 'done' 은 지우지 않는다 — 목록에서만 내려가고 그 달 몫은 쓴 것이다.
    }
    for (const entry of alive.values()) {
      if (entry.user === user && entry.ts.slice(0, 7) === month) return entry;
    }
    return null;
  }

  private history(): Entry[] {
    try {
      return fs.readFileSync(this.opts.logPath, 'utf-8').trim().split('\n')
        .filter(Boolean).map((line) => JSON.parse(line) as Entry);
    } catch {
      return [];   // 아직 아무도 안 넣었다.
    }
  }

  private note(entry: Entry): void {
    try {
      fs.mkdirSync(path.dirname(this.opts.logPath), { recursive: true });
      fs.appendFileSync(this.opts.logPath, `${JSON.stringify(entry)}\n`, 'utf-8');
    } catch (error) {
      this.logger.warn('신청 기록을 못 남겼습니다', error);
    }
  }

  private day(iso: string): string {
    const at = new Date(iso);
    if (Number.isNaN(at.getTime())) return iso.slice(0, 10);
    return `${at.getMonth() + 1}월 ${at.getDate()}일(${WEEKDAYS[at.getDay()]})`;
  }

  // ── 사람 ──────────────────────────────────────────────────────────────
  private async tell(client: App['client'], user: string, text: string): Promise<void> {
    try {
      const im = await client.conversations.open({ users: user });
      if (im.channel?.id) await client.chat.postMessage({ channel: im.channel.id, text });
    } catch (error) {
      this.logger.warn('알림을 못 보냈습니다', error);
    }
  }

  private async person(client: App['client'], id: string): Promise<string> {
    const cached = this.names.get(id);
    if (cached) return cached;
    let name = id;
    try {
      const res = await client.users.info({ user: id });
      const profile = res.user?.profile as { display_name?: string; real_name?: string } | undefined;
      name = profile?.real_name || profile?.display_name || res.user?.real_name || id;
    } catch (error) {
      this.logger.debug(`users.info 실패 (${id})`, error);
    }
    this.names.set(id, name);
    return name;
  }
}
