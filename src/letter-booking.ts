import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { App } from '@slack/bolt';
import { Logger } from './logger';

/**
 * 레터의 **1on1 신청 창구** — 반기 정기 1on1 말고, 하고 싶을 때 여는 자리.
 *
 * 결정과 근거는 1on1 워크스페이스의 `README.md` §7 에 있다. 코드가 지켜야 하는 것:
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

/** 넣는 쪽. **실장도 이걸로 넣는다** — 자기 창구를 직접 써 봐야 무엇이 불편한지 안다. */
const COMMAND = '/1on1';
/** 받는 쪽(실장 전용). 넣는 명령과 나눠 둔 것은 실장도 신청을 해 볼 수 있게 하기 위해서다. */
const LIST_COMMAND = '/1on1-list';

const ASK = 'booking_ask';
const CANCEL = 'booking_cancel';
const DONE = 'booking_done';
const TELL = 'booking_tell';
const TELL_SEND = 'booking_tell_send';
const NUDGE_OPEN = 'booking_nudge_open';
/** 커피콩이 실장에게 넘긴 DM 을 1on1 신청으로 올리는 버튼. */
const FROM_DM = 'booking_from_dm';
const FROM_DM_HINT = 'booking_from_dm_hint';

/**
 * 기다린 지 이만큼 지나면 실장에게 **다시** 알린다.
 *
 * 넣은 그 자리에서 재촉하지 않는다 — 신청이 들어오면 그 즉시 한 번 알리므로 몇 시간
 * 만에 또 부르면 알림이 둘로 늘 뿐이다. 하루가 지나도 그대로면 그때는 잊힌 쪽에 가깝다.
 */
const NUDGE_AFTER_MS = 24 * 60 * 60 * 1000;
/** 이 시각 이후에만 부른다. 이른 아침·밤에 오는 재촉은 재촉이 아니라 방해다. */
const NUDGE_AT = '10:00';

const BLOCK_WHEN = 'when';
const BLOCK_NOTE = 'note';
const BLOCK_MEMO = 'memo';
const MAX_TEXT = 500;
/** 신청자가 시간 하나를 고르는 버튼 · 「다 안 돼요」. */
const PICK = 'booking_pick';
const PICK_RE = /^booking_pick_\d+$/;
const DECLINE = 'booking_decline';
/**
 * 한 번에 보낼 수 있는 시간 수. **하나만 보내면 성사되기 어렵다**(실장 2026-09-30) — 안 맞으면
 * 다시 사람끼리 주고받게 되고, 그건 이 창구가 없애려던 일이다. 너무 많으면 고르기가 일이 된다.
 */
const SLOT_MAX = 5;
/**
 * 캘린더 일정의 끝 시각에만 쓰는 길이. **사람에게는 안 묻고 안 보인다** — 실장 2026-09-30
 * 「길이는 빼고 시작 시간만 정하면 될 것 같다」(길이는 만나서 정한다 · 캘린더는 끝 시각이 있어야 한다).
 */
const EVENT_MINUTES = 60;
/** 캘린더 일정 제목 — **이름을 안 넣는다.** 화면을 옆에서 볼 수 있다(누구인지는 설명 칸에). */
const EVENT_TITLE = '1:1 미팅';

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

export interface LetterBookingOptions {
  /** 신청을 받는 사람(실장). 비면 기능이 꺼진다. */
  managerUserId: string;
  /** 신청할 수 있는 사람. 비면 기능이 꺼진다. */
  members: string[];
  /** 신청 기록. `turn.py` 옆 `bots/letter/data/` 를 그대로 쓴다. */
  logPath: string;
  /**
   * 「아직 기다립니다」를 오늘 이미 알렸는지. **신청 기록과 파일을 나눈다** — 주인이
   * 다른 값을 한 파일에 두면 한쪽의 초기화가 남의 칸을 지운다(2026-08-07 에 겪었다).
   */
  nudgePath: string;
  /**
   * 실원에게 열렸는가. **기본은 닫힘** — 닫혀 있으면 실장만 쓸 수 있다.
   * 만들어 둔 것과 실원에게 연 것은 다른 일이다. 여는 쪽이 기본값이면 시험해 보는 동안
   * 실원 신청이 들어오고, **들어온 신청은 없던 일이 안 된다.**
   */
  open: boolean;
  /**
   * 확정된 1on1 을 넣을 캘린더 — **실장 본인만 보는 기본 캘린더**(`CalendarPoller.addPrivateEvent`).
   * 부를 때마다 묻는다(캘린더 연동이 늦게 뜨거나 꺼질 수 있다). 없으면 「직접 넣어 주세요」로 알린다.
   */
  calendar?: () => PrivateCalendar | null;
}

export interface PrivateCalendar {
  add(ev: { start: Date; minutes: number; title: string; description?: string }): Promise<string | null>;
  remove(id: string): Promise<boolean>;
}

interface Entry {
  ts: string;
  /**
   * `ask` 신청 · `cancel` 무름 · `done` 실장이 내림(시간을 적었으면 `when`) ·
   * `propose` 실장이 시간 여럿을 보냄 · `pick` 신청자가 하나를 고름 · `decline` 다 안 된다고 함
   */
  action: 'ask' | 'cancel' | 'done' | 'propose' | 'pick' | 'decline';
  /** 신청 하나를 가리키는 열쇠. 신청한 순간의 시각을 그대로 쓴다. */
  id: string;
  user: string;
  user_name: string;
  when?: string;
  note?: string;
  /** `propose` — 보낸 시작 시각들(ISO) · 받는 분께 가는 덧붙인 말 · 판 번호. */
  slots?: string[];
  memo?: string;
  /**
   * 제안의 판 번호. **기록 시각으로 대신하지 않는다** — 같은 밀리초에 두 번 보내면 판 번호가
   * 같아져 옛 메시지의 버튼이 살아난다(검사가 실제로 잡았다). 신청자가 누른 버튼에 이 값이 실린다.
   */
  v?: string;
  /** `pick` — 고른 시작 시각(ISO) · 넣은 캘린더 일정. */
  at?: string;
  calendar?: string;
}

/** 살아 있는 신청 하나. `done` 이면 시간까지 잡힌 것이고, `fixed` 가 그 시각이다. */
interface Alive {
  entry: Entry;
  done: boolean;
  fixed?: string;
  /** 보내 놓고 고르기를 기다리는 제안. **다시 보내면 바뀐다 — `ts` 가 판 번호다**(옛 메시지의 버튼을 막는다). */
  proposal?: { ts: string; v: string; slots: string[]; memo?: string };
  /** 신청자가 「다 안 돼요」를 눌렀다 — 실장이 다시 보낼 차례다. */
  declined?: boolean;
  /** 캘린더에 넣은 일정(무르면 같이 뺀다). */
  calendar?: string;
}

export class LetterBooking {
  private logger = new Logger('Letter:1on1');
  private names = new Map<string, string>();
  private nudgeTimer?: NodeJS.Timeout;

  constructor(private readonly opts: LetterBookingOptions) {}

  get enabled(): boolean {
    return Boolean(this.opts.managerUserId) && this.opts.members.length > 0;
  }

  /**
   * 커피콩이 대화 명단 밖 DM 을 실장에게 넘길 때 붙이는 버튼(`ChatHost` 의 `bypassBlocks`).
   *
   * **신청을 `/1on1` 이 아니라 DM 으로 보낸 실원이 있었다**(2026-09-30) — 그 말은 실장 DM 으로
   * 넘어갔지만 기록에 안 남아 `/1on1-list` 가 비어 있었다. 그래서 실장이 누르면 그 말을 신청으로
   * 올린다. 낱말로 알아서 올리지 않는 것은 「면담」이 들어간 말이 다 신청은 아니어서다.
   *
   * **넘긴 말은 실장 DM 과 실장만 보는 목록 밖으로 안 나간다**(실장 2026-09-30 「DM 이나 콩에게
   * 전달한 말이 타인이나 채널에 공유되면 절대 안 됨」). 버튼 값에 실린 말은 그 메시지 안에만
   * 있고, 누르면 메모 칸으로만 간다 — 메모는 실장 알림·목록에만 보이고 방 답 빗장
   * (`privacy_gate.py`)이 원문 조각으로 막는 칸이다. 본인에게 가는 알림에는 말을 다시 싣지 않는다.
   *
   * 신청할 수 있는 사람의 말에만 붙는다. 실장 자신의 DM 은 넘어오지 않으므로 뺀다.
   */
  dmBlocks = (user: string, text: string): any[] | undefined => {
    if (!this.enabled || user === this.opts.managerUserId || !this.allowed(user)) return undefined;
    return [
      {
        type: 'context', block_id: FROM_DM_HINT,
        elements: [{
          type: 'mrkdwn',
          text: `면담 신청이면 아래 버튼으로 1on1 목록에 올릴 수 있어요. \`${LIST_COMMAND}\` 에서 가능한 시간을 `
            + '보내시면 본인이 고르고, 확정까지 제가 나릅니다.',
        }],
      },
      {
        type: 'actions', block_id: FROM_DM,
        elements: [{
          type: 'button', action_id: FROM_DM, style: 'primary',
          text: { type: 'plain_text', text: '1on1 신청으로 올리기' },
          // 말까지 싣는 것은 누를 때 파일을 다시 뒤지지 않기 위해서다 — 값은 이 메시지에만 있다.
          value: JSON.stringify({ u: user, t: text.slice(0, MAX_TEXT) }),
          confirm: {
            title: { type: 'plain_text', text: '1on1 신청으로 올릴까요?' },
            text: {
              type: 'plain_text',
              text: '이 말을 1on1 신청으로 올리고, 본인에게는 신청이 들어갔다고만 알립니다(보낸 말은 다시 싣지 않습니다).',
            },
            confirm: { type: 'plain_text', text: '올리기' },
            deny: { type: 'plain_text', text: '그만두기' },
          },
        }],
      },
    ];
  };

  /** 지금 이 사람이 신청할 수 있는가. 안 열렸으면 실장뿐이다. */
  private allowed(user: string): boolean {
    if (user === this.opts.managerUserId) return true;
    return this.opts.open && this.opts.members.includes(user);
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
      // **슬래시 명령은 만든 순간 워크스페이스 전원의 자동완성에 뜬다**(사용자별로 숨기는
      // 설정이 슬랙에 없다). 그래서 보이는 것은 못 막고, **동작하는 것을 여기서 막는다.**
      // 아직 안 열었으면 실장만 쓸 수 있다.
      if (!this.allowed(me)) {
        this.logger.info(`${me} 가 ${COMMAND} 를 불렀지만 ${this.opts.open ? '명단에 없습니다' : '아직 안 열었습니다'}`);
        await respond({
          response_type: 'ephemeral',
          text: this.opts.open
            ? '이 명령은 Dynamic실 실원만 쓸 수 있습니다.'
            : '아직 준비 중인 기능입니다. 준비되면 안내드리겠습니다.',
        });
        return;
      }
      try {
        await client.views.open({ trigger_id: command.trigger_id, view: this.memberView(me) });
      } catch (error) {
        this.logger.warn('신청 창을 못 열었습니다', error);
        await respond({
          response_type: 'ephemeral',
          text: `신청 창을 열지 못했습니다. 한 번 더 시도해 주세요.\n\`${String(error).slice(0, 200)}\``,
        });
      }
    });

    app.command(LIST_COMMAND, async ({ command, ack, respond, client }) => {
      await ack();
      if (command.user_id !== this.opts.managerUserId) {
        this.logger.info(`${command.user_id} 가 ${LIST_COMMAND} 를 불렀지만 실장이 아닙니다`);
        await respond({
          response_type: 'ephemeral',
          text: `이 명령은 실장만 쓸 수 있습니다. 신청은 \`${COMMAND}\` 입니다.`,
        });
        return;
      }
      try {
        await client.views.open({ trigger_id: command.trigger_id, view: this.managerView() });
      } catch (error) {
        this.logger.warn('신청 목록 창을 못 열었습니다', error);
        await respond({
          response_type: 'ephemeral',
          text: `목록을 열지 못했습니다. 한 번 더 시도해 주세요.\n\`${String(error).slice(0, 200)}\``,
        });
      }
    });

    app.view(ASK, async ({ ack, body, view, client }) => {
      const me = body.user.id;
      // 창을 열어둔 채로 닫히는 수도 있다(재시작 사이에 설정이 바뀌면). 넣기 직전에 다시 본다.
      if (!this.allowed(me)) { await ack({ response_action: 'clear' }); return; }
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
        '1on1 신청이 들어갔습니다. 실장이 가능한 시간을 보내 드리면 하나를 고르시면 됩니다.\n'
        + `취소하시려면 \`${COMMAND}\` 를 다시 부르세요. 이유는 안 물어봅니다.`);
      await this.tell(client, this.opts.managerUserId,
        `*1on1 신청 · ${name}*\n`
        + `${when ? `편한 때: ${when}\n` : '편한 때: 안 적음\n'}`
        + `${note ? `> ${note}\n` : ''}`
        + `\`${LIST_COMMAND}\` 에서 가능한 시간을 보내 주시면 됩니다.`);
    });

    // 넘긴 DM 을 신청으로 — 실장 DM 에만 뜨는 버튼이지만 누른 사람을 한 번 더 본다.
    app.action({ action_id: FROM_DM }, async ({ ack, body, client }) => {
      await ack();
      const payload = body as any;
      if (payload.user?.id !== this.opts.managerUserId) return;
      let value: { u?: string; t?: string } = {};
      try { value = JSON.parse(payload.actions?.[0]?.value ?? '{}'); } catch { /* 아래에서 막힌다 */ }
      const done = await this.fromDm(client, value.u ?? '', value.t ?? '', payload.message?.ts);

      // 버튼을 결과 한 줄로 바꾼다 — 두 번 눌러 두 건이 되지 않게(두 번째는 한 달 제한에도 걸린다).
      const channel = payload.channel?.id as string | undefined;
      const ts = payload.message?.ts as string | undefined;
      if (!channel || !ts) return;
      const kept = (payload.message?.blocks ?? [])
        .filter((b: any) => b.block_id !== FROM_DM && b.block_id !== FROM_DM_HINT);
      try {
        await client.chat.update({
          channel, ts, text: payload.message?.text ?? '',
          blocks: [...kept, { type: 'context', elements: [{ type: 'mrkdwn', text: done }] }],
        });
      } catch (error) {
        this.logger.warn('넘긴 DM 의 버튼을 못 바꿨습니다', error);
      }
    });

    // 취소 — 되돌릴 수 있는 일이라 확인 단계를 두지 않는다. 한 단계를 더 붙이면
    // "취소도 봇으로" 를 만든 이유가 없어진다.
    app.action({ action_id: CANCEL }, async ({ ack, body, client }) => {
      await ack();
      const payload = body as any;
      const me = payload.user?.id as string;
      const id = payload.actions?.[0]?.value as string;
      if (!me || !id) return;

      const asked = this.cancellable(id);
      // 본인 것만 무른다. 실장이 남의 신청을 없애는 것은 '처리함'(DONE) 쪽이다.
      if (!asked || asked.entry.user !== me) {
        this.logger.info(`${me} 가 남의(또는 없는) 신청을 취소하려 했습니다 — 무시`);
        return;
      }
      const name = await this.person(client, me);
      this.note({ ts: new Date().toISOString(), action: 'cancel', id, user: me, user_name: name });
      this.logger.info(`무름 ← ${name}${asked.done ? ' (시간이 잡혀 있던 건)' : ''}`);
      // 캘린더에 넣어 둔 것도 뺀다 — 무른 약속이 실장 달력에 남아 있으면 그 시간을 비워 두게 된다.
      let calLine = '';
      if (asked.calendar) {
        const removed = await (this.opts.calendar?.()?.remove(asked.calendar) ?? Promise.resolve(false)).catch(() => false);
        calLine = removed ? ' 캘린더에서도 뺐습니다.' : ' 캘린더 일정은 직접 지워 주세요.';
      }

      const when = asked.fixed ? ` (${asked.fixed})` : '';
      await this.refresh(client, payload.view?.id, this.memberView(me, asked.done
        ? '잡혀 있던 1on1 을 취소했습니다. 실장에게 알렸습니다.'
        : '신청을 취소했습니다. 이번 달에 다시 넣으실 수 있습니다.'));
      // **무른 사람에게도 한 줄 남긴다.** 넣을 때는 남기고 무를 때는 안 남기면, 창을
      // 닫은 뒤 정말 취소됐는지 확인할 길이 없다. 취소가 더 불안한 쪽이다.
      await this.tell(client, me, asked.done
        ? `잡혀 있던 1on1 을 취소했습니다${when}. 실장에게 알렸습니다 — 이유는 안 물어봅니다.`
        : '1on1 신청을 취소했습니다. 이번 달에 다시 넣으실 수 있습니다.');
      await this.tell(client, this.opts.managerUserId, asked.done
        ? `1on1 *무름* · *${name}* — 시간까지 잡혔던 건입니다${when}.${calLine}`
        : `1on1 신청 무름 · *${name}*${asked.proposal ? ' — 보낸 시간을 고르기 전에 물렀습니다.' : ''}`);
    });

    // 시간 제안하기 — 실장이 **가능한 시간을 여럿** 보내면 신청자가 고른다(2026-09-30 실장
    // 「시간을 딱 하나만 전달하는건 성사되기 어렵다」). 나르는 것은 봇이다 — 사람이 사람에게 말
    // 거는 구간을 만들지 않는 것이 이 창구의 설계다(2026-08-03). 실장이 직접 말했으면 아래 DONE.
    app.action({ action_id: TELL }, async ({ ack, body, client }) => {
      await ack();
      const payload = body as any;
      if (payload.user?.id !== this.opts.managerUserId) return;
      const id = payload.actions?.[0]?.value as string;
      const asked = this.pending().find((entry) => entry.id === id);
      // **목록에서 사라진 건이다.** 조용히 넘어가면 버튼이 고장 난 것처럼 보인다.
      if (!asked) {
        await this.refresh(client, payload.view?.id, this.managerView(this.goneWhy(id)));
        return;
      }
      try {
        await client.views.push({ trigger_id: payload.trigger_id, view: this.proposeView(asked) });
      } catch (error) {
        this.logger.warn('시간 제안 창을 못 열었습니다', error);
      }
    });

    app.view(TELL_SEND, async ({ ack, body, view, client }) => {
      if (body.user.id !== this.opts.managerUserId) { await ack(); return; }
      const values = view.state.values as Record<string, Record<string, any>>;
      const now = Date.now();
      const picked: { block: string; ms: number }[] = [];
      for (let i = 0; i < SLOT_MAX; i++) {
        const sec = values[`slot${i}`]?.[`slot${i}`]?.selected_date_time;
        if (typeof sec === 'number') picked.push({ block: `slot${i}`, ms: sec * 1000 });
      }
      const errors: Record<string, string> = {};
      if (!picked.length) errors.slot0 = '가능한 시간을 하나 이상 골라 주세요.';
      for (const p of picked) {
        if (p.ms < now + 5 * 60 * 1000) errors[p.block] = '지난 시각이거나 너무 가깝습니다.';
      }
      const memo = String(values[BLOCK_MEMO]?.[BLOCK_MEMO]?.value ?? '').trim();
      if (memo.length > MAX_TEXT) errors[BLOCK_MEMO] = `${MAX_TEXT}자까지만 됩니다 (지금 ${memo.length}자).`;
      if (Object.keys(errors).length) {
        await ack({ response_action: 'errors', errors });
        return;
      }
      await ack({ response_action: 'clear' });
      // 같은 시각을 두 칸에 골랐으면 하나로 · 이른 순서로
      const slots = [...new Set(picked.map((p) => p.ms))].sort((a, b) => a - b)
        .map((ms) => new Date(ms).toISOString());

      let who: { id: string; user: string; name: string };
      try {
        who = JSON.parse((body.view.private_metadata || '{}') as string);
      } catch {
        this.logger.warn('누구 신청인지 못 읽었습니다 — 아무것도 안 보냅니다');
        return;
      }
      if (!who.id || !who.user) return;
      // **보낼 수 없는 건이다.** 창은 이미 닫혔으므로 여기서 아무 말도 안 하면, 시각을
      // 적어 보낸 쪽은 알린 줄 안다 — 정작 상대에게는 아무것도 안 갔는데.
      //
      // **왜 못 보내는지를 갈라서 말한다.** 「없음」과 「이미 알림」은 다른 일인데
      // 뭉뚱그리면 두 번 보냈을 때 「그새 취소했다」는 거짓말을 하게 된다.
      const still = this.alive().get(who.id);
      if (!still || still.done) {
        const why = still
          ? '이미 시간이 잡힌 건입니다.'
          : '그새 신청을 취소했습니다.';
        this.logger.info(`보내지 않았습니다 (${who.name}) — ${why}`);
        await this.tell(client, this.opts.managerUserId,
          `*${who.name}* 님 — ${why} *아무것도 보내지 않았습니다.*`);
        return;
      }

      const v = crypto.randomBytes(6).toString('hex');
      this.note({ ts: new Date().toISOString(), action: 'propose', id: who.id, user: who.user, user_name: who.name,
                  slots, memo: memo || undefined, v });
      this.logger.info(`시간 제안 → ${who.name} (${slots.length}개)`);
      await this.tell(client, who.user, this.offerText(slots, memo, Boolean(still.proposal || still.declined)),
        this.offerBlocks(who.id, v, slots));
      await this.tell(client, this.opts.managerUserId,
        `보냈습니다 · *${who.name}* · ${slots.map((s) => this.slotLabel(s)).join(' / ')}\n`
        + '_하나를 고르면 확정해 알려 드리고 본인만 보는 캘린더에 넣습니다. 다 안 되면 다시 보내 달라고 알려 드립니다._');
    });

    // 신청자가 시간 하나를 고름 — **그 자리에서 확정**한다(다시 묻지 않는다).
    // 한 줄에 버튼이 여럿이라 이름이 겹치면 안 된다(`booking_pick_0` …) — 앞머리로 받는다.
    app.action({ action_id: PICK_RE }, async ({ ack, body, client }) => {
      await ack();
      const payload = body as any;
      let v: { id?: string; v?: string; i?: number } = {};
      try { v = JSON.parse(payload.actions?.[0]?.value ?? '{}'); } catch { /* 아래에서 막힌다 */ }
      const result = await this.pick(client, payload.user?.id ?? '', v.id ?? '', v.v ?? '', Number(v.i));
      await this.settleOffer(client, payload, result);
    });

    // 「다 안 돼요」 — 실장에게 다시 보내 달라고 알린다. 이유는 안 묻는다.
    app.action({ action_id: DECLINE }, async ({ ack, body, client }) => {
      await ack();
      const payload = body as any;
      let v: { id?: string; v?: string } = {};
      try { v = JSON.parse(payload.actions?.[0]?.value ?? '{}'); } catch { /* 아래에서 막힌다 */ }
      const result = await this.decline(client, payload.user?.id ?? '', v.id ?? '', v.v ?? '');
      await this.settleOffer(client, payload, result);
    });

    // 그냥 내리기 — 실장이 이미 직접 말했을 때. **신청자에게는 아무 말도 안 간다**
    // (같은 말이 두 번 가지 않게).
    app.action({ action_id: DONE }, async ({ ack, body, client }) => {
      await ack();
      const payload = body as any;
      const me = payload.user?.id as string;
      const id = payload.actions?.[0]?.value as string;
      if (me !== this.opts.managerUserId || !id) return;

      const asked = this.pending().find((entry) => entry.id === id);
      if (!asked) {
        await this.refresh(client, payload.view?.id, this.managerView(this.goneWhy(id)));
        return;
      }
      this.note({ ts: new Date().toISOString(), action: 'done', id, user: asked.user, user_name: asked.user_name });
      this.logger.info(`처리함 · ${asked.user_name}`);

      await this.refresh(client, payload.view?.id, this.managerView(`${asked.user_name} 님 신청을 내렸습니다.`));
    });

    // 「아직 기다립니다」에 딸린 버튼. 목록 창을 그 자리에서 연다 — 명령을 다시 치게 하면
    // 그 한 걸음에서 또 미룬다.
    app.action({ action_id: NUDGE_OPEN }, async ({ ack, body, client }) => {
      await ack();
      const payload = body as any;
      if (payload.user?.id !== this.opts.managerUserId) return;
      try {
        await client.views.open({ trigger_id: payload.trigger_id, view: this.managerView() });
      } catch (error) {
        this.logger.warn('목록 창을 못 열었습니다', error);
        await this.tell(client, this.opts.managerUserId,
          `목록 창을 열지 못했습니다. \`${LIST_COMMAND}\` 로 열어 주세요.\n\`${String(error).slice(0, 200)}\``);
      }
    });

    this.startNudge(app);

    this.logger.info(`${COMMAND}·${LIST_COMMAND} 준비됨 — ${this.opts.open
      ? `실원에게 열림 (신청 가능 ${this.opts.members.length}명 · 한 달 한 번)`
      : '아직 안 열림 (실장만 · 열려면 LETTER_1ON1_OPEN=1)'} · 하루 지나면 ${NUDGE_AT} 알림`);
  };

  // ── 아직 기다리는 신청 ─────────────────────────────────────────────────
  /**
   * **신청이 들어왔는데 아무 일도 안 일어나는 자리를 남기지 않는다.**
   *
   * 넣은 사람은 넣고 나면 할 수 있는 것이 없다 — 재촉하지 않아도 되게 만든 창구라서,
   * 실장이 잊으면 그대로 묻힌다. 그러면 「말 안 해도 되는 창구」가 「말해도 안 되는
   * 창구」가 되고, 그건 창구가 없느니만 못하다.
   */
  private startNudge(app: App): void {
    if (this.nudgeTimer) return;
    this.nudgeTimer = setInterval(() => {
      void this.maybeNudge(app).catch((error) => this.logger.warn('알림에서 넘어졌습니다', error));
    }, 60 * 1000);
    this.nudgeTimer.unref?.();
  }

  /** `now` 를 밖에서 받는다 — 안 그러면 검사가 몇 시에 돌렸는지에 따라 결과가 달라진다. */
  private async maybeNudge(app: App, now: Date = new Date()): Promise<void> {
    const day = now.getDay();
    if (day === 0 || day === 6) return;      // 주말에 알려도 할 수 있는 것이 없다
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    if (hhmm < NUDGE_AT) return;

    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    let seen: { day?: string } = {};
    try { seen = JSON.parse(fs.readFileSync(this.opts.nudgePath, 'utf-8')); } catch { seen = {}; }
    if (seen.day === today) return;

    // **실장 차례인 것만** — 시간을 보내 놓고 고르기를 기다리는 건은 실장이 할 것이 없다.
    const waited = this.managerTurn()
      .filter((entry) => now.getTime() - new Date(entry.ts).getTime() >= NUDGE_AFTER_MS)
      .sort((a, b) => a.ts.localeCompare(b.ts));
    // **없으면 도장을 안 찍는다.** 찍어 두면 오늘 낮에 하루를 넘기는 건이 생겨도 내일로
    // 밀린다 — 조용히 넘어가는 것과 하루를 통째로 건너뛰는 것은 다르다.
    if (waited.length === 0) return;

    const oldest = waited[0];
    const days = Math.max(1, Math.floor((now.getTime() - new Date(oldest.ts).getTime()) / (24 * 60 * 60 * 1000)));
    const who = waited.length === 1
      ? `*${oldest.user_name}* 님이 ${days}일째 기다리고 계십니다.`
      : `*${oldest.user_name}* 님 외 ${waited.length - 1}분이 기다리고 계십니다 (가장 오래된 것은 ${days}일째).`;
    try {
      await this.tell(app.client, this.opts.managerUserId,
        `:hourglass_flowing_sand: *1on1 신청 ${waited.length}건이 그대로 있습니다*\n${who}\n`
        + '*시간 제안하기* 로 가능한 시간을 보내시거나, 이미 직접 말씀하셨으면 *그냥 내리기* 를 눌러 주세요.',
        [{
          type: 'actions',
          elements: [{
            type: 'button', action_id: NUDGE_OPEN, style: 'primary',
            text: { type: 'plain_text', text: '보기' },
          }],
        }]);
      fs.writeFileSync(this.opts.nudgePath, JSON.stringify({ day: today }), 'utf-8');
      this.logger.info(`기다리는 신청 ${waited.length}건을 알렸습니다 (가장 오래된 것 ${days}일째)`);
    } catch (error) {
      // **기록을 남기지 않는다** — 다음 주기가 다시 시도한다.
      this.logger.warn('알림을 못 보냈습니다 — 다음 주기에 다시 합니다', error);
    }
  }

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
          text: mine.done
            ? `*잡힌 1on1*\n${mine.fixed || '실장이 따로 알려드렸습니다'}`
            : `*넣어 두신 신청*\n${this.day(mine.entry.ts)} 신청`
              + `${mine.entry.when ? `\n편한 때: ${mine.entry.when}` : ''}`
              + `${mine.proposal
                ? `\n받은 시간: ${mine.proposal.slots.map((s) => this.slotLabel(s)).join(' / ')} — 봇 DM 의 버튼으로 골라 주세요.`
                : mine.declined ? '\n다 안 된다고 알려 두었습니다. 실장이 다른 시간을 보내 드립니다.' : ''}`,
        },
        accessory: {
          type: 'button', action_id: CANCEL, value: mine.entry.id,
          text: { type: 'plain_text', text: '취소' },
        },
      });
      blocks.push({
        type: 'context',
        elements: [{
          type: 'mrkdwn',
          text: mine.done
            ? '못 가시게 되면 여기서 취소하시면 됩니다. 이유는 안 물어봅니다.'
            : '실장이 가능한 시간을 보내 드리면 하나를 고르시면 됩니다. 취소하셔도 이유는 안 물어봅니다.',
        }],
      });
      return this.modal(blocks);
    }

    blocks.push(
      {
        type: 'section',
        text: { type: 'mrkdwn', text: '실장과 1on1 시간을 잡습니다.' },
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
        elements: [{ type: 'mrkdwn', text: '한 달에 한 번 넣으실 수 있습니다. 취소하면 그 달에 다시 넣으실 수 있습니다.' }],
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
      const states = this.alive();
      for (const entry of waiting) {
        const st = states.get(entry.id);
        const state = st?.proposal
          ? `:hourglass_flowing_sand: 시간 ${st.proposal.slots.length}개 보냄 · 고르는 중 (${this.day(st.proposal.ts)} 보냄)\n`
          : st?.declined
            ? ':warning: 보낸 시간이 다 안 된다고 함 · *다시 보내 주세요*\n'
            : '';
        blocks.push({
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*${entry.user_name}* · ${this.day(entry.ts)} 신청\n${state}`
              + `${entry.when ? `편한 때: ${entry.when}\n` : '편한 때: 안 적음\n'}`
              + `${entry.note ? `> ${entry.note}` : ''}`,
          },
        });
        blocks.push({
          type: 'actions',
          elements: [
            {
              type: 'button', action_id: TELL, value: entry.id, ...(st?.proposal ? {} : { style: 'primary' }),
              text: { type: 'plain_text', text: st?.proposal || st?.declined ? '다시 제안' : '시간 제안하기' },
            },
            {
              type: 'button', action_id: DONE, value: entry.id,
              text: { type: 'plain_text', text: '그냥 내리기' },
            },
          ],
        });
      }
    }
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `*시간 제안하기* 로 가능한 시간을 여럿 보내면 받는 분이 고르고, 고르면 확정·알림·캘린더 등록까지 봇이 합니다. 이미 직접 말씀하셨으면 *그냥 내리기* 를 쓰세요(그때는 아무 말도 안 갑니다).\n신청은 \`${COMMAND}\` — 실장도 그쪽으로 넣습니다.` }],
    });
    return this.modal(blocks, undefined, undefined, '들어온 1on1 신청');
  }

  /** 실장이 가능한 시간을 여럿 고르는 창. 첫 칸만 반드시 · 나머지는 비워도 된다. */
  private proposeView(entry: Entry): any {
    const cur = this.alive().get(entry.id);
    const blocks: any[] = [{
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${entry.user_name}* 님께 가능한 시간을 보냅니다. 받는 분이 하나를 고르면 그 자리에서 확정되고, `
          + '본인만 보는 캘린더에 넣습니다.'
          + `${entry.when ? `\n적어 주신 편한 때: ${entry.when}` : ''}`
          + `${cur?.declined ? '\n_앞서 보낸 시간은 다 안 된다고 했습니다._' : ''}`
          + `${cur?.proposal ? `\n_앞서 보낸 것(${cur.proposal.slots.map((s) => this.slotLabel(s)).join(' / ')})은 새로 보내면 고를 수 없게 됩니다._` : ''}`,
      },
    }];
    for (let i = 0; i < SLOT_MAX; i++) {
      blocks.push({
        type: 'input', block_id: `slot${i}`, optional: i > 0,
        label: { type: 'plain_text', text: `가능한 시작 시간 ${i + 1}` },
        element: { type: 'datetimepicker', action_id: `slot${i}` },
      });
    }
    blocks.push({
      type: 'input', block_id: BLOCK_MEMO, optional: true,
      label: { type: 'plain_text', text: '덧붙일 말 (안 적으셔도 됩니다)' },
      hint: { type: 'plain_text', text: '받는 분께 그대로 갑니다. 예: 회의실은 따로 알려드릴게요' },
      element: { type: 'plain_text_input', action_id: BLOCK_MEMO },
    });
    return {
      type: 'modal',
      callback_id: TELL_SEND,
      private_metadata: JSON.stringify({ id: entry.id, user: entry.user, name: entry.user_name }),
      title: { type: 'plain_text', text: '시간 제안하기' },
      submit: { type: 'plain_text', text: '보내기' },
      close: { type: 'plain_text', text: '취소' },
      blocks,
    };
  }

  /** 신청자에게 가는 제안 글. 신청 메모는 싣지 않는다(실장 말만). */
  private offerText(slots: string[], memo: string, again: boolean): string {
    return `${again ? '실장이 1on1 시간을 다시 보냈습니다.' : '실장이 1on1 가능한 시간을 보냈습니다.'} 편한 시작 시간을 하나 골라 주세요.`
      + `${memo ? `\n> ${memo.replace(/\n/g, '\n> ')}` : ''}`;
  }

  /** 시간마다 버튼 하나 + 「다 안 돼요」. 값에 제안의 판 번호(`v`)를 실어 옛 메시지의 버튼을 막는다. */
  private offerBlocks(id: string, version: string, slots: string[]): any[] {
    return [
      {
        type: 'actions',
        elements: [
          ...slots.map((s, i) => ({
            type: 'button', action_id: `${PICK}_${i}`, value: JSON.stringify({ id, v: version, i }),
            text: { type: 'plain_text', text: this.slotLabel(s) },
          })),
          {
            type: 'button', action_id: DECLINE, value: JSON.stringify({ id, v: version }),
            text: { type: 'plain_text', text: '다 안 돼요' },
          },
        ],
      },
      {
        type: 'context',
        elements: [{
          type: 'mrkdwn',
          text: '고르면 바로 확정되고 실장에게 알려 드립니다. 다 안 되면 *다 안 돼요* — 이유는 안 물어봅니다.',
        }],
      },
    ];
  }

  private picking = new Set<string>();

  /**
   * 고름을 확정한다. 돌려주는 것은 신청자 메시지의 버튼 대신 남길 한 줄(`null` 이면 그대로 둔다).
   * **먼저 캘린더에 넣고 기록한다** — 기록이 먼저면 캘린더가 늦는 사이 무른 건에 일정이 생긴다.
   */
  private async pick(client: App['client'], me: string, id: string, version: string, i: number): Promise<string | null> {
    const cur = this.alive().get(id);
    const stale = this.offerStale(cur, me, version);
    if (stale) return stale;
    const offer = cur!.proposal!;
    const at = offer.slots[i];
    if (!at) return '고른 시간을 못 찾았습니다 — 가장 최근 메시지에서 다시 골라 주세요.';
    if (this.picking.has(id)) return null;
    this.picking.add(id);
    try {
      const label = this.slotLabel(at);
      const name = cur!.entry.user_name;
      const cal = this.opts.calendar?.() ?? null;
      let eventId: string | null = null;
      if (cal) {
        // 설명 칸에는 이름만 — 신청 메모는 캘린더에 안 옮긴다(사본을 늘리지 않는다).
        eventId = await cal.add({
          start: new Date(at), minutes: EVENT_MINUTES, title: EVENT_TITLE,
          description: `신청: ${name}\n커피콩 1on1 창구에서 확정`,
        }).catch(() => null);
      }
      this.note({ ts: new Date().toISOString(), action: 'pick', id, user: me, user_name: name,
                  when: label, at, calendar: eventId ?? undefined });
      this.logger.info(`1on1 확정 ← ${name} (${label})${eventId ? ' · 캘린더' : ' · 캘린더 없음'}`);
      await this.tell(client, this.opts.managerUserId,
        `:white_check_mark: 1on1 확정 · *${name}* · ${label}\n`
        + (eventId
          ? `_본인만 보는 캘린더에 넣었습니다 — 제목 「${EVENT_TITLE}」 · 이름은 설명 칸._`
          : '_캘린더에는 못 넣었습니다 — 직접 넣어 주세요._'));
      return `:white_check_mark: *${label}* 로 잡혔습니다. 실장에게 알렸습니다.\n`
        + `안 되시면 \`${COMMAND}\` 에서 취소하시면 됩니다. 이유는 안 물어봅니다.`;
    } finally {
      this.picking.delete(id);
    }
  }

  /** 「다 안 돼요」. 실장에게 다시 보내 달라고 알린다. */
  private async decline(client: App['client'], me: string, id: string, version: string): Promise<string | null> {
    const cur = this.alive().get(id);
    const stale = this.offerStale(cur, me, version);
    if (stale) return stale;
    const name = cur!.entry.user_name;
    this.note({ ts: new Date().toISOString(), action: 'decline', id, user: me, user_name: name });
    this.logger.info(`제안 시간 다 안 됨 ← ${name}`);
    await this.tell(client, this.opts.managerUserId,
      `:calendar: *${name}* 님 — 보낸 시간이 다 안 된다고 합니다. 다른 시간을 보내 주세요.`,
      [{
        type: 'actions',
        elements: [{ type: 'button', action_id: NUDGE_OPEN, style: 'primary', text: { type: 'plain_text', text: '목록 열기' } }],
      }]);
    return '실장에게 알렸습니다. 다른 시간을 다시 보내 드립니다. 이유는 안 물어봅니다.';
  }

  /** 이 제안에 지금 답할 수 있나. 못 하면 그 까닭(버튼 대신 남길 한 줄). */
  private offerStale(cur: Alive | undefined, me: string, version: string): string | null {
    if (!cur || cur.entry.user !== me) return '그새 취소된 신청입니다.';
    if (cur.done) return `이미 잡힌 1on1 입니다${cur.fixed ? ` · *${cur.fixed}*` : ''}.`;
    if (!cur.proposal || cur.proposal.v !== version) {
      return cur.declined
        ? '다 안 된다고 알려 두었습니다. 실장이 다른 시간을 보내 드립니다.'
        : '실장이 시간을 다시 보냈습니다 — 가장 최근 메시지에서 골라 주세요.';
    }
    return null;
  }

  /** 누른 메시지의 버튼을 결과 한 줄로 바꾼다 — 두 번 눌러 두 번 확정되지 않게. */
  private async settleOffer(client: App['client'], payload: any, line: string | null): Promise<void> {
    if (!line) return;
    const channel = payload.channel?.id as string | undefined;
    const ts = payload.message?.ts as string | undefined;
    if (!channel || !ts) { await this.tell(client, payload.user?.id, line); return; }
    const kept = (payload.message?.blocks ?? []).filter((b: any) => b.type !== 'actions' && b.type !== 'context');
    try {
      await client.chat.update({
        channel, ts, text: payload.message?.text ?? line,
        blocks: [...kept, { type: 'context', elements: [{ type: 'mrkdwn', text: line }] }],
      });
    } catch (error) {
      this.logger.warn('시간 제안 메시지를 못 바꿨습니다 — 한 줄로 따로 알립니다', error);
      await this.tell(client, payload.user?.id, line);
    }
  }

  private modal(blocks: any[], callback?: string, submit?: string, title?: string): any {
    const view: any = {
      type: 'modal',
      title: { type: 'plain_text', text: title ?? '1on1 신청' },
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
   * 아직 실장이 안 내린 신청들. 파일은 붙여 쓰기만 하므로(누가 언제 넣고 취소했는지가
   * 그대로 남는다) 앞에서부터 되짚어 지금 상태를 만든다.
   */
  /**
   * 살아 있는 신청들. 파일은 붙여 쓰기만 하므로(누가 언제 넣고 취소했는지가 그대로
   * 남는다) 앞에서부터 되짚어 지금 상태를 만든다.
   *
   * **되짚기는 한 곳에만 둔다.** 예전에는 목록·달 제한·취소가 각자 되짚었고 서로
   * 다른 답을 냈다 — 화면은 시간이 잡힌 건에도 「취소」를 그렸는데 누름을 받는 쪽은
   * 그 건이 이미 내려갔다고 보아 **아무 일도 안 일어났다**(눌린 사람 눈에는 취소된
   * 것처럼 보인다). 취소는 사람이 가장 말 꺼내기 어려운 자리라 조용히 실패하면 안 된다.
   */
  private alive(): Map<string, Alive> {
    const alive = new Map<string, Alive>();
    for (const entry of this.history()) {
      if (entry.action === 'ask') { alive.set(entry.id, { entry, done: false }); continue; }
      if (entry.action === 'cancel') { alive.delete(entry.id); continue; }
      const cur = alive.get(entry.id);
      if (!cur) continue;
      if (entry.action === 'done') {
        // 시간이 잡힌 것도 **살아 있다** — 실장 목록에서만 내려간다.
        alive.set(entry.id, { ...cur, done: true, fixed: entry.when || cur.fixed, proposal: undefined, declined: false });
      } else if (entry.action === 'propose' && !cur.done && entry.slots?.length) {
        alive.set(entry.id, {
          ...cur, declined: false,
          proposal: { ts: entry.ts, v: entry.v ?? entry.ts, slots: entry.slots, memo: entry.memo },
        });
      } else if (entry.action === 'pick' && !cur.done) {
        alive.set(entry.id, {
          ...cur, done: true, fixed: entry.when, proposal: undefined, declined: false, calendar: entry.calendar,
        });
      } else if (entry.action === 'decline' && !cur.done) {
        alive.set(entry.id, { ...cur, proposal: undefined, declined: true });
      }
    }
    return alive;
  }

  /** 아직 실장이 안 내린 신청들(보내 놓고 고르기를 기다리는 것도 포함 — 목록에서 상태로 보인다). */
  private pending(): Entry[] {
    return [...this.alive().values()].filter((a) => !a.done).map((a) => a.entry)
      .sort((a, b) => a.ts.localeCompare(b.ts));
  }

  /**
   * **실장 차례인** 신청들 — 아직 시간을 안 보냈거나, 보낸 것이 다 안 된다고 돌아온 것.
   * 보내 놓고 고르기를 기다리는 것은 뺀다(그때 실장을 재촉하면 할 수 있는 것이 없다).
   */
  private managerTurn(): Entry[] {
    return [...this.alive().values()].filter((a) => !a.done && !a.proposal).map((a) => a.entry)
      .sort((a, b) => a.ts.localeCompare(b.ts));
  }

  /** 시각 하나를 사람이 읽는 꼴로 — 「10월 2일(목) 14:00」. 봇이 도는 PC 의 시간대(한국)로 읽는다. */
  private slotLabel(iso: string): string {
    const d = new Date(iso);
    return `${d.getMonth() + 1}월 ${d.getDate()}일(${WEEKDAYS[d.getDay()]}) `
      + `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  /**
   * 넘긴 DM 을 신청으로 올린다(`dmBlocks` 의 버튼). 돌려주는 것은 버튼 대신 남길 한 줄.
   *
   * 신청 시각은 **넘긴 메시지의 시각**이다 — 실장이 다음 날 눌러도 그 사람이 말한 날로 센다.
   * 한 달 한 번은 `/1on1` 과 같게 막는다(창구가 둘이라고 몫이 둘이 되면 안 된다).
   */
  private async fromDm(client: App['client'], user: string, text: string, at?: string): Promise<string> {
    if (!user || user === this.opts.managerUserId || !this.allowed(user)) {
      return '신청할 수 있는 사람이 아니라 올리지 않았어요.';
    }
    if (this.thisMonth(user)) {
      return `이번 달 신청이 이미 있어 올리지 않았어요 — \`${LIST_COMMAND}\` 에서 보세요.`;
    }
    const sec = Number(at);
    const ts = (Number.isFinite(sec) && sec > 0 ? new Date(sec * 1000) : new Date()).toISOString();
    const name = await this.person(client, user);
    const note = text.trim().slice(0, MAX_TEXT);
    this.note({ ts, action: 'ask', id: ts, user, user_name: name, note: note || undefined });
    this.logger.info(`신청 ← ${name} (넘긴 DM 을 실장이 올림)`);
    // 보낸 말은 다시 싣지 않는다 — 본인 DM 이라도 알림 미리보기로 옆 사람 화면에 뜰 수 있다.
    await this.tell(client, user,
      '보내 주신 말을 1on1 신청으로 받았습니다. 실장이 가능한 시간을 보내 드리면 하나를 고르시면 됩니다.\n'
      + `취소하시려면 \`${COMMAND}\` 를 부르세요. 이유는 안 물어봅니다.`);
    return `:white_check_mark: 1on1 목록에 올렸어요 — \`${LIST_COMMAND}\` 에서 가능한 시간을 보내시면 본인이 고릅니다.`;
  }

  /**
   * 이 사람이 **이번 달에 쓴** 신청. 취소한 것은 안 쓴 것으로 친다(그래서 다시 넣을 수 있다).
   * 실장이 처리한 것은 **쓴 것으로 친다** — 그 달 만남이 이미 잡혔다는 뜻이다.
   */
  /**
   * 이 사람이 **이번 달에** 넣어 둔 것.
   *
   * ⚠️ **UTC 로 세지 않는다** — 기록은 `toISOString()`(UTC)으로 적히는데 사람은
   * 한국 시각으로 산다. UTC 로 자르면 **한국 시각 자정~오전 9시 동안 달이 전달로
   * 보인다** — 그 아홉 시간에 넣은 신청이 지난달 몫으로 계산되어, 이번 달에 또
   * 넣을 수 있게 되거나 반대로 막힌다. 달이 바뀌는 날에만, 조용히 틀린다
   * (2026-09-01 에 자가 검사가 실제로 잡았다).
   *
   * 오늘도 기록도 **같은 자로** 잰다 — 한쪽만 고치면 어긋나는 것은 그대로다.
   */
  private thisMonth(user: string): Alive | null {
    const month = localMonth(new Date());
    for (const a of this.alive().values()) {
      if (a.entry.user === user && localMonth(new Date(a.entry.ts)) === month) return a;
    }
    return null;
  }

  /**
   * 목록에서 사라진 까닭. **「없음」과 「이미 처리됨」은 다른 일이다** —
   * 뭉뚱그리면 시간 알림을 두 번 보냈을 때 「그새 취소했다」는 거짓말을 하게 된다.
   */
  private goneWhy(id: string): string {
    return this.alive().has(id)
      ? '이미 시간을 알려드린 건이라 목록에서 내려갔습니다.'
      : '그새 취소되어 목록에서 내려갔습니다.';
  }

  /** 무를 수 있는 건인가. **시간이 잡힌 것도 무를 수 있다** — 그게 가장 어려운 자리다. */
  private cancellable(id: string): Alive | null {
    return this.alive().get(id) ?? null;
  }

  /**
   * **망가진 줄은 그 줄만 건너뛴다.** 예전에는 한 줄이라도 못 읽으면 파일 전체를 빈 것으로
   * 봤다 — 그러면 `/1on1-list` 가 「기다리는 신청이 없습니다」를 띄운다. 신청이 있는데 없다고
   * 말하는 것이 이 창구에서 가장 나쁜 실패다(2026-09-30 「목록이 안 뜬다」를 짚다가 찾음).
   */
  private history(): Entry[] {
    let raw = '';
    try {
      raw = fs.readFileSync(this.opts.logPath, 'utf-8');
    } catch {
      return [];   // 아직 아무도 안 넣었다.
    }
    const out: Entry[] = [];
    let broken = 0;
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line) as Entry); } catch { broken++; }
    }
    if (broken) this.logger.warn(`신청 기록에 못 읽는 줄이 ${broken}개 있어 건너뜁니다 — ${this.opts.logPath}`);
    return out;
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
  private async tell(client: App['client'], user: string, text: string, blocks?: any[]): Promise<void> {
    try {
      const im = await client.conversations.open({ users: user });
      if (!im.channel?.id) return;
      await client.chat.postMessage({
        channel: im.channel.id, text,
        // 버튼을 붙일 때도 `text` 를 같이 보낸다 — 알림 미리보기와 접근성 읽기가 그걸 쓴다.
        ...(blocks ? { blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }, ...blocks] } : {}),
      });
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

/** 그 시각이 **지역 시각으로** 몇 년 몇 월인가 (`YYYY-MM`). */
export function localMonth(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
