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
const BLOCK_FIXED = 'fixed';
const MAX_TEXT = 500;

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

/** 살아 있는 신청 하나. `done` 이면 시간까지 잡힌 것이고, `fixed` 가 그 시각이다. */
interface Alive {
  entry: Entry;
  done: boolean;
  fixed?: string;
}

export class LetterBooking {
  private logger = new Logger('Letter:1on1');
  private names = new Map<string, string>();
  private nudgeTimer?: NodeJS.Timeout;

  constructor(private readonly opts: LetterBookingOptions) {}

  get enabled(): boolean {
    return Boolean(this.opts.managerUserId) && this.opts.members.length > 0;
  }

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
        '1on1 신청이 들어갔습니다. 실장이 시간을 잡아 다시 알려드립니다.\n'
        + `취소하시려면 \`${COMMAND}\` 를 다시 부르세요. 이유는 안 물어봅니다.`);
      await this.tell(client, this.opts.managerUserId,
        `*1on1 신청 · ${name}*\n`
        + `${when ? `편한 때: ${when}\n` : '편한 때: 안 적음\n'}`
        + `${note ? `> ${note}\n` : ''}`
        + `\`${LIST_COMMAND}\` 에서 시간을 알려주시면 됩니다.`);
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
        ? `1on1 *무름* · *${name}* — 시간까지 잡혔던 건입니다${when}.`
        : `1on1 신청 무름 · *${name}*`);
    });

    // 시간 알리기 — 실장이 정한 시각을 **봇이 나른다.** 사람이 사람에게 말 거는 구간을
    // 만들지 않는 것이 이 창구의 설계다(2026-08-03 결정). 실장이 직접 말했으면 아래 DONE 을 쓴다.
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
        await client.views.push({ trigger_id: payload.trigger_id, view: this.tellView(asked) });
      } catch (error) {
        this.logger.warn('시간 알림 창을 못 열었습니다', error);
      }
    });

    app.view(TELL_SEND, async ({ ack, body, view, client }) => {
      if (body.user.id !== this.opts.managerUserId) { await ack(); return; }
      const fixed = (view.state.values[BLOCK_FIXED]?.[BLOCK_FIXED]?.value ?? '').trim();
      if (!fixed) {
        await ack({ response_action: 'errors', errors: { [BLOCK_FIXED]: '언제로 잡았는지 적어 주세요.' } });
        return;
      }
      if (fixed.length > MAX_TEXT) {
        await ack({
          response_action: 'errors',
          errors: { [BLOCK_FIXED]: `${MAX_TEXT}자까지만 됩니다 (지금 ${fixed.length}자).` },
        });
        return;
      }
      await ack({ response_action: 'clear' });

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
          ? '이미 시간을 알려드린 건입니다.'
          : '그새 신청을 취소했습니다.';
        this.logger.info(`보내지 않았습니다 (${who.name}) — ${why}`);
        await this.tell(client, this.opts.managerUserId,
          `*${who.name}* 님 — ${why} *아무것도 보내지 않았습니다.*`);
        return;
      }

      this.note({ ts: new Date().toISOString(), action: 'done', id: who.id, user: who.user, user_name: who.name, when: fixed });
      this.logger.info(`시간 알림 → ${who.name} (${fixed})`);
      // **취소하는 길도 봇으로 알린다.** 「실장에게 말씀 주세요」로 보내면, 사람에게
      // 취소를 말하는 부담을 없애려고 만든 창구가 마지막 한 걸음에서 그 부담을 돌려준다.
      await this.tell(client, who.user,
        `1on1 시간이 잡혔습니다 · *${fixed}*\n안 되시면 \`${COMMAND}\` 에서 취소하시면 됩니다. 이유는 안 물어봅니다.`);
      await this.tell(client, this.opts.managerUserId, `알려드렸습니다 · *${who.name}* · ${fixed}`);
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

    const waited = this.pending()
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
        + '시간을 잡으셨으면 *시간 알리기*, 이미 직접 말씀하셨으면 *그냥 내리기* 를 눌러 주세요.',
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
              + `${mine.entry.when ? `\n편한 때: ${mine.entry.when}` : ''}`,
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
            : '실장이 시간을 잡아 알려드립니다. 취소하셔도 이유는 안 물어봅니다.',
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
      for (const entry of waiting) {
        blocks.push({
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*${entry.user_name}* · ${this.day(entry.ts)} 신청\n`
              + `${entry.when ? `편한 때: ${entry.when}\n` : '편한 때: 안 적음\n'}`
              + `${entry.note ? `> ${entry.note}` : ''}`,
          },
        });
        blocks.push({
          type: 'actions',
          elements: [
            {
              type: 'button', action_id: TELL, value: entry.id, style: 'primary',
              text: { type: 'plain_text', text: '시간 알리기' },
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
      elements: [{ type: 'mrkdwn', text: `*시간 알리기* 는 봇이 대신 알려 드립니다. 이미 직접 말씀하셨으면 *그냥 내리기* 를 쓰세요(그때는 아무 말도 안 갑니다).\n신청은 \`${COMMAND}\` — 실장도 그쪽으로 넣습니다.` }],
    });
    return this.modal(blocks, undefined, undefined, '들어온 1on1 신청');
  }

  /** 실장이 정한 시각을 적는 창. 이 칸에 적은 그대로 신청자에게 간다. */
  private tellView(entry: Entry): any {
    return {
      type: 'modal',
      callback_id: TELL_SEND,
      private_metadata: JSON.stringify({ id: entry.id, user: entry.user, name: entry.user_name }),
      title: { type: 'plain_text', text: '시간 알리기' },
      submit: { type: 'plain_text', text: '보내기' },
      close: { type: 'plain_text', text: '취소' },
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*${entry.user_name}* 님께 보냅니다.`
              + `${entry.when ? `\n적어 주신 편한 때: ${entry.when}` : ''}`,
          },
        },
        {
          type: 'input', block_id: BLOCK_FIXED,
          label: { type: 'plain_text', text: '언제로 잡으셨나요' },
          hint: { type: 'plain_text', text: '적으신 그대로 갑니다. 예: 8월 7일(금) 16:00, 회의실은 따로 알려드릴게요' },
          element: { type: 'plain_text_input', action_id: BLOCK_FIXED },
        },
      ],
    };
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
      if (entry.action === 'ask') alive.set(entry.id, { entry, done: false });
      else if (entry.action === 'cancel') alive.delete(entry.id);
      else if (entry.action === 'done') {
        // 시간이 잡힌 것도 **살아 있다** — 실장 목록에서만 내려간다.
        const cur = alive.get(entry.id);
        if (cur) alive.set(entry.id, { ...cur, done: true, fixed: entry.when || cur.fixed });
      }
    }
    return alive;
  }

  /** 아직 실장이 안 내린 신청들. */
  private pending(): Entry[] {
    return [...this.alive().values()].filter((a) => !a.done).map((a) => a.entry)
      .sort((a, b) => a.ts.localeCompare(b.ts));
  }

  /**
   * 이 사람이 **이번 달에 쓴** 신청. 취소한 것은 안 쓴 것으로 친다(그래서 다시 넣을 수 있다).
   * 실장이 처리한 것은 **쓴 것으로 친다** — 그 달 만남이 이미 잡혔다는 뜻이다.
   */
  private thisMonth(user: string): Alive | null {
    const month = new Date().toISOString().slice(0, 7);
    for (const a of this.alive().values()) {
      if (a.entry.user === user && a.entry.ts.slice(0, 7) === month) return a;
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
