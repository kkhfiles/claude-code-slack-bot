import * as fs from 'fs';
import { spawn } from 'child_process';
import { App } from '@slack/bolt';
import { Logger } from './logger';

/**
 * 커피콩의 **커피챗 창구** — 실원이 남긴 이야기를 받아 두었다가, 주에 한 번 실장이
 * 골라서 내보낸다.
 *
 * 코드가 지켜야 하는 것:
 *
 *   1. **받는 사람에게 작성자를 전하지 않는다.** 기록에는 남긴다(누가 냈는지 실장은
 *      본다). 그래서 창에 적는 말도 「익명입니다」가 아니라 **「받는 분께는 누가 썼는지
 *      전하지 않습니다」** 여야 한다 — 없는 익명을 약속하면 그 말을 믿은 사람이 다친다.
 *   2. **봇이 스스로 내보내지 않는다.** 금요일에 하는 일은 실장에게 알리는 것까지고,
 *      내보내는 것은 매번 사람이 고른다. 나간 말은 되돌릴 수 없다.
 *   3. **칭찬만 나간다.** 개선·불만은 여기서 내보내는 길이 아예 없다. 실장이 따로 들고
 *      가는 것이고, 목록에서만 본다.
 *   4. **원문은 밖으로 나가지 않는다.** 대화(모델 경유)와 이 저장소는 완전히 다른 길이다 —
 *      봇 설정의 `context_files` 에 이 파일을 넣지 않는다.
 *   5. **못 했으면 못 했다고 말한다.** 창이 닫혔는데 아무 일도 안 일어나면 사람은 됐다고
 *      믿는다(2026-08-07 에 같은 종류로 네 자리를 고쳤다).
 */

const COMMAND = '/coffeechat';
const LIST_COMMAND = '/coffeechat-list';

const WRITE = 'cc_write';
const OPEN_REVIEW = 'cc_open_review';
const REVIEW = 'cc_review';

const BLOCK_KIND = 'kind';
const BLOCK_TO = 'to';
const BLOCK_TEXT = 'text';
const MAX_LEN = 1500;
/** 한 화면에 올리는 건수. 슬랙 창은 블록 100개까지라 넉넉히 잡아도 이 언저리가 한계다. */
const PAGE = 12;

const KIND_LABEL: Record<string, string> = { praise: '칭찬·고마움', improve: '개선하고 싶은 것' };

const INTRO = ':coffee: *커피챗으로 들어온 이야기예요.*\n누가 남겼는지는 전해 드리지 않기로 되어 있어요. 편하게 읽어 주세요.';

export interface LetterCoffeechatOptions {
  /** 받는 사람(실장). 비면 기능이 꺼진다. */
  managerUserId: string;
  /** 쓸 수 있고 받을 수도 있는 사람(실원 전체). 비면 꺼진다. */
  members: string[];
  /** 접수 기록. `bots/letter/data/` 안에 둔다(원격 저장소에 안 나간다). */
  logPath: string;
  /** 주간 알림을 이미 보냈는지. 접수 기록과 **파일을 나눈다** — 주인이 다른 값을 한 파일에 두면 날짜 초기화가 남의 칸을 지운다. */
  digestPath: string;
  /** 실원에게 열렸는가. **기본은 닫힘.** 만들어 둔 것과 연 것은 다른 일이다. */
  open: boolean;
  /** 금요일 몇 시에 알릴까 (HH:MM). */
  digestAt: string;
  /** 노션에 목록을 남길 데이터베이스 id. 비면 노션 쪽은 통째로 건너뛴다. */
  notionDb?: string;
  notionScript?: string;
  notionPython?: string;
}

interface Entry {
  ts: string;
  action: 'new' | 'sent' | 'later' | 'dropped';
  id: string;
  kind?: 'praise' | 'improve';
  from?: string;
  from_name?: string;
  to?: string;
  to_name?: string;
  text?: string;
}

/** 아직 실장이 처리하지 않은 한 건. `later` 면 지난 회차에서 넘어온 것이다. */
interface Live {
  entry: Entry;
  later: boolean;
}

export class LetterCoffeechat {
  private logger = new Logger('Letter:커피챗');
  private names = new Map<string, string>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: LetterCoffeechatOptions) {}

  get enabled(): boolean {
    return Boolean(this.opts.managerUserId) && this.opts.members.length > 0;
  }

  private allowed(user: string): boolean {
    if (user === this.opts.managerUserId) return true;
    return this.opts.open && this.opts.members.includes(user);
  }

  register = (app: App): void => {
    if (!this.enabled) {
      this.logger.info('꺼짐 — 실장 ID 나 명단이 비어 있습니다');
      return;
    }

    // ── 넣기 ────────────────────────────────────────────────────────────
    app.command(COMMAND, async ({ command, ack, respond, client }) => {
      await ack();
      const me = command.user_id;
      // 슬래시 명령은 만든 순간 워크스페이스 전원의 자동완성에 뜬다(숨기는 설정이 없다).
      // 보이는 것은 못 막으니 **동작을 여기서 막는다.**
      if (!this.allowed(me)) {
        await respond({
          response_type: 'ephemeral',
          text: this.opts.open
            ? '이 명령은 Dynamic실 실원만 쓸 수 있습니다.'
            : '아직 준비 중인 기능입니다. 준비되면 안내드리겠습니다.',
        });
        return;
      }
      try {
        await client.views.open({ trigger_id: command.trigger_id, view: this.writeView(me) });
      } catch (error) {
        this.logger.warn('쓰는 창을 못 열었습니다', error);
        await respond({
          response_type: 'ephemeral',
          text: `창을 열지 못했습니다. 한 번 더 시도해 주세요.\n\`${String(error).slice(0, 200)}\``,
        });
      }
    });

    app.view(WRITE, async ({ ack, body, view, client }) => {
      const me = body.user.id;
      if (!this.allowed(me)) { await ack({ response_action: 'clear' }); return; }
      const kind = view.state.values[BLOCK_KIND]?.[BLOCK_KIND]?.selected_option?.value ?? '';
      const to = view.state.values[BLOCK_TO]?.[BLOCK_TO]?.selected_option?.value ?? '';
      const text = (view.state.values[BLOCK_TEXT]?.[BLOCK_TEXT]?.value ?? '').trim();

      if (!text) {
        await ack({ response_action: 'errors', errors: { [BLOCK_TEXT]: '남기실 이야기를 적어 주세요.' } });
        return;
      }
      if (text.length > MAX_LEN) {
        await ack({
          response_action: 'errors',
          errors: { [BLOCK_TEXT]: `${MAX_LEN}자까지만 됩니다 (지금 ${text.length}자).` },
        });
        return;
      }
      // **칭찬은 받을 사람이 있어야 한다.** 개선은 받을 사람이 없다(실장이 들고 간다).
      if (kind === 'praise' && !to) {
        await ack({ response_action: 'errors', errors: { [BLOCK_TO]: '누구에게 전할 이야기인지 골라 주세요.' } });
        return;
      }

      await ack({ response_action: 'clear' });
      const now = new Date().toISOString();
      const name = await this.person(client, me);
      const toName = to ? await this.person(client, to) : '';
      this.note({
        ts: now, action: 'new', id: now,
        kind: kind === 'improve' ? 'improve' : 'praise',
        from: me, from_name: name,
        to: to || undefined, to_name: toName || undefined,
        text,
      });
      this.logger.info(`접수 ← ${name} (${kind === 'improve' ? '개선' : `칭찬 → ${toName}`}, ${text.length}자)`);

      await this.tell(client, me, kind === 'improve'
        ? '남겨 주신 이야기 잘 받았습니다. 실장에게 전해 두겠습니다 — 이 방에서 다시 꺼내지 않습니다.'
        : `${toName} 님께 전할 이야기로 받아 두었습니다.\n주에 한 번 모아서 전해지고, **누가 썼는지는 전하지 않습니다.**`);

      // 개선은 실장이 바로 알아야 할 수 있다 — 주간 묶음에 안 들어가므로 여기서 한 번 알린다.
      if (kind === 'improve') {
        await this.tell(client, this.opts.managerUserId,
          `*커피챗 · 개선하고 싶은 것*\n> ${text.slice(0, 300)}${text.length > 300 ? '…' : ''}\n`
          + `\`${LIST_COMMAND}\` 에서 전체를 보실 수 있습니다.`);
      }
      void this.toNotion(kind === 'improve' ? 'improve' : 'praise', toName, text, '대기');
    });

    // ── 보기 ────────────────────────────────────────────────────────────
    app.command(LIST_COMMAND, async ({ command, ack, respond, client }) => {
      await ack();
      if (command.user_id !== this.opts.managerUserId) {
        await respond({ response_type: 'ephemeral', text: `이 명령은 실장만 쓸 수 있습니다. 남기실 때는 \`${COMMAND}\` 입니다.` });
        return;
      }
      try {
        await client.views.open({ trigger_id: command.trigger_id, view: this.reviewView() });
      } catch (error) {
        this.logger.warn('목록 창을 못 열었습니다', error);
        await respond({ response_type: 'ephemeral', text: `목록을 열지 못했습니다.\n\`${String(error).slice(0, 200)}\`` });
      }
    });

    app.action({ action_id: OPEN_REVIEW }, async ({ ack, body, client }) => {
      await ack();
      const payload = body as any;
      if (payload.user?.id !== this.opts.managerUserId) return;
      try {
        await client.views.open({ trigger_id: payload.trigger_id, view: this.reviewView() });
      } catch (error) {
        this.logger.warn('검토 창을 못 열었습니다', error);
        await this.tell(client, this.opts.managerUserId,
          `검토 창을 열지 못했습니다. \`${LIST_COMMAND}\` 로 열어 주세요.\n\`${String(error).slice(0, 200)}\``);
      }
    });

    // ── 내보내기 ────────────────────────────────────────────────────────
    app.view(REVIEW, async ({ ack, body, view, client }) => {
      if (body.user.id !== this.opts.managerUserId) { await ack(); return; }
      await ack({ response_action: 'clear' });

      const live = this.live();
      const picks: Array<{ id: string; how: string }> = [];
      for (const [id] of live) {
        const chosen = view.state.values[`pick:${id}`]?.[`pick:${id}`]?.selected_option?.value;
        if (chosen) picks.push({ id, how: chosen });
      }
      const send = picks.filter((p) => p.how === 'send')
        .map((p) => live.get(p.id)!.entry).filter((e) => e.kind === 'praise' && e.to);
      const drop = picks.filter((p) => p.how === 'drop');

      if (send.length === 0 && drop.length === 0) {
        // **아무것도 안 골랐다.** 조용히 넘어가면 보낸 줄 알고 넘어간다.
        await this.tell(client, this.opts.managerUserId, '고르신 것이 없어 *아무것도 보내지 않았습니다.* 남은 것은 그대로 있습니다.');
        return;
      }

      // 한 사람에게 여러 건이면 **묶어서 한 번**에. DM 이 세 번 오는 것보다 낫다.
      const byTo = new Map<string, Entry[]>();
      for (const e of send) byTo.set(e.to!, [...(byTo.get(e.to!) ?? []), e]);

      const okIds: string[] = [];
      const failed: string[] = [];
      for (const [to, items] of byTo) {
        const body2 = `${INTRO}\n\n${items.map((e) => `> ${(e.text ?? '').replace(/\n/g, '\n> ')}`).join('\n\n')}`;
        try {
          const im = await client.conversations.open({ users: to });
          const channel = im.channel?.id;
          if (!channel) throw new Error('DM 방을 못 열었습니다');
          await client.chat.postMessage({ channel, text: body2 });
          okIds.push(...items.map((e) => e.id));
          this.logger.info(`전달 완료 → ${items[0].to_name} (${items.length}건)`);
        } catch (error) {
          this.logger.warn(`전달 실패 → ${items[0].to_name}`, error);
          failed.push(`${items[0].to_name} (${items.length}건)`);
        }
      }

      const stamp = new Date().toISOString();
      for (const id of okIds) this.note({ ts: stamp, action: 'sent', id });
      for (const p of drop) this.note({ ts: stamp, action: 'dropped', id: p.id });
      // **고르지 않은 것은 건드리지 않는다** — 다음 회차에 그대로 다시 올라온다.

      const lines = [
        okIds.length ? `보냈습니다 · ${okIds.length}건 (${byTo.size}명)` : '',
        drop.length ? `버렸습니다 · ${drop.length}건` : '',
        failed.length ? `*보내지 못했습니다* · ${failed.join(' · ')} — 그대로 남아 있으니 다시 시도해 주세요.` : '',
      ].filter(Boolean);
      await this.tell(client, this.opts.managerUserId, lines.join('\n'));

      // 남긴 사람에게 닿았다고 알린다 — 허공에 던진 것이 아니라는 것이 다음 한 줄을 부른다.
      for (const e of send.filter((x) => okIds.includes(x.id))) {
        if (e.from) await this.tell(client, e.from, `남겨 주신 이야기를 ${e.to_name} 님께 전해 드렸습니다. 고맙습니다 :coffee:`);
      }
      for (const id of okIds) void this.toNotion('praise', live.get(id)?.entry.to_name ?? '', live.get(id)?.entry.text ?? '', '보냄');
    });

    this.startTimer(app);
    this.logger.info(`${COMMAND}·${LIST_COMMAND} 준비됨 — ${this.opts.open
      ? `실원에게 열림 (${this.opts.members.length}명)`
      : '아직 안 열림 (실장만 · 열려면 LETTER_CC_OPEN=1)'} · 금요일 ${this.opts.digestAt} 알림`);
  };

  // ── 주간 알림 ──────────────────────────────────────────────────────────
  /**
   * 금요일 그 시각이 지나면 **한 번만** 알린다.
   *
   * 토·일에도 조건을 열어 둔다 — 금요일 저녁에 봇이 꺼져 있었으면 그 주가 통째로
   * 사라지기 때문이다(ISO 주는 월~일이라 토·일도 같은 주다). 놓친 것은 다음 회차에
   * 그대로 다시 올라오므로 없어지지는 않는다.
   */
  private startTimer(app: App): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.maybeDigest(app).catch((error) => this.logger.warn('주간 알림에서 넘어졌습니다', error));
    }, 60 * 1000);
    this.timer.unref?.();
  }

  private async maybeDigest(app: App): Promise<void> {
    const now = new Date();
    const day = now.getDay();                       // 금=5 · 토=6 · 일=0
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    if (!(day === 6 || day === 0 || (day === 5 && hhmm >= this.opts.digestAt))) return;

    const week = isoWeek(now);
    let seen: { week?: string } = {};
    try { seen = JSON.parse(fs.readFileSync(this.opts.digestPath, 'utf-8')); } catch { seen = {}; }
    if (seen.week === week) return;

    const live = this.live();
    const praise = [...live.values()].filter((v) => v.entry.kind === 'praise');
    const improve = [...live.values()].filter((v) => v.entry.kind === 'improve');
    // **없으면 조용히 넘어간다.** 매주 「0건」이 오면 그 알림을 안 보게 된다.
    if (praise.length === 0) {
      fs.writeFileSync(this.opts.digestPath, JSON.stringify({ week }), 'utf-8');
      return;
    }

    try {
      await this.tell(app.client, this.opts.managerUserId,
        `:coffee: *이번 주 커피챗* — 전할 칭찬 ${praise.length}건${improve.length ? ` · 들고 계신 개선 ${improve.length}건` : ''}\n`
        + '아래에서 하나씩 보시고 고르시면 됩니다. *고르시기 전에는 아무것도 안 나갑니다.*',
        [{
          type: 'actions',
          elements: [{
            type: 'button', action_id: OPEN_REVIEW, style: 'primary',
            text: { type: 'plain_text', text: '검토하기' },
          }],
        }]);
      fs.writeFileSync(this.opts.digestPath, JSON.stringify({ week }), 'utf-8');
      this.logger.info(`주간 알림 보냄 (칭찬 ${praise.length} · 개선 ${improve.length})`);
    } catch (error) {
      // **기록을 남기지 않는다** — 다음 주기가 다시 시도한다.
      this.logger.warn('주간 알림을 못 보냈습니다 — 다음 주기에 다시 합니다', error);
    }
  }

  // ── 화면 ──────────────────────────────────────────────────────────────
  private writeView(me: string): any {
    const others = this.opts.members.filter((u) => u !== me);
    return {
      type: 'modal', callback_id: WRITE,
      title: { type: 'plain_text', text: '커피챗' },
      submit: { type: 'plain_text', text: '남기기' },
      close: { type: 'plain_text', text: '닫기' },
      blocks: [
        {
          type: 'input', block_id: BLOCK_KIND,
          label: { type: 'plain_text', text: '어떤 이야기인가요' },
          element: {
            type: 'static_select', action_id: BLOCK_KIND,
            initial_option: opt('칭찬·고마움', 'praise'),
            options: [opt('칭찬·고마움', 'praise'), opt('개선하고 싶은 것', 'improve')],
          },
        },
        {
          type: 'input', block_id: BLOCK_TO, optional: true,
          label: { type: 'plain_text', text: '누구에게 (칭찬일 때만)' },
          hint: { type: 'plain_text', text: '개선하고 싶은 것이면 비워 두세요. 실장이 따로 봅니다.' },
          element: {
            type: 'static_select', action_id: BLOCK_TO,
            placeholder: { type: 'plain_text', text: '고르기' },
            options: others.map((u) => opt(this.names.get(u) ?? u, u)),
          },
        },
        {
          type: 'input', block_id: BLOCK_TEXT,
          label: { type: 'plain_text', text: '남기실 이야기' },
          element: { type: 'plain_text_input', action_id: BLOCK_TEXT, multiline: true },
        },
        {
          type: 'context',
          elements: [{
            type: 'mrkdwn',
            // **없는 익명을 약속하지 않는다.** 다만 「실장은 볼 수 있다」까지 적지는 않는다 —
            // 이 봇을 만든 사람이 실장이라는 것을 다 아는 사람들이라 그건 군말이다.
            text: '받는 분께는 *누가 썼는지 전하지 않습니다.*\n'
              + '칭찬은 주에 한 번 모아서 전해지고, 개선하고 싶은 것은 전해지지 않고 실장이 따로 봅니다.',
          }],
        },
      ],
    };
  }

  private reviewView(): any {
    const live = [...this.live().values()].sort((a, b) => a.entry.ts.localeCompare(b.entry.ts));
    const praise = live.filter((v) => v.entry.kind === 'praise');
    const improve = live.filter((v) => v.entry.kind === 'improve');
    const blocks: any[] = [];

    if (praise.length === 0) {
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '전할 칭찬이 아직 없습니다.' } });
    }
    for (const v of praise.slice(0, PAGE)) {
      const e = v.entry;
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*→ ${e.to_name}*${v.later ? '  _(지난 회차에서 넘어옴)_' : ''}\n`
            + `> ${(e.text ?? '').replace(/\n/g, '\n> ')}\n`
            + `_남긴 사람: ${e.from_name} · ${this.day(e.ts)}_`,
        },
      });
      blocks.push({
        type: 'input', block_id: `pick:${e.id}`, optional: true,
        label: { type: 'plain_text', text: ' ' },
        element: {
          type: 'radio_buttons', action_id: `pick:${e.id}`,
          // **기본은 「다음에」** — 무심코 제출해도 아무것도 안 나가야 한다.
          initial_option: opt('다음에', 'keep'),
          options: [opt('보내기', 'send'), opt('다음에', 'keep'), opt('버리기', 'drop')],
        },
      });
      blocks.push({ type: 'divider' });
    }
    if (praise.length > PAGE) {
      blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `_${praise.length - PAGE}건은 자리가 모자라 다음에 보여 드립니다._` }] });
    }
    if (improve.length) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*들고 계신 개선 ${improve.length}건* — 여기서는 안 나갑니다.\n`
            + improve.slice(0, 10).map((v) => `• ${(v.entry.text ?? '').split('\n')[0].slice(0, 80)}`).join('\n'),
        },
      });
    }
    return {
      type: 'modal', callback_id: REVIEW,
      title: { type: 'plain_text', text: '이번 주 커피챗' },
      submit: { type: 'plain_text', text: '고른 대로 하기' },
      close: { type: 'plain_text', text: '닫기' },
      blocks,
    };
  }

  // ── 기록 ──────────────────────────────────────────────────────────────
  /**
   * 아직 처리하지 않은 것들. **되짚기는 여기 한 곳에만 둔다** — 화면·알림·내보내기가
   * 각자 되짚으면 서로 다른 답을 내고, 그러면 보이는 것과 눌렀을 때가 어긋난다.
   */
  private live(): Map<string, Live> {
    const live = new Map<string, Live>();
    for (const e of this.history()) {
      if (e.action === 'new') live.set(e.id, { entry: e, later: false });
      else if (e.action === 'later') {
        const cur = live.get(e.id);
        if (cur) live.set(e.id, { ...cur, later: true });
      } else live.delete(e.id);        // sent · dropped
    }
    return live;
  }

  private history(): Entry[] {
    try {
      return fs.readFileSync(this.opts.logPath, 'utf-8').trim().split('\n')
        .filter(Boolean).map((line) => JSON.parse(line) as Entry);
    } catch {
      return [];
    }
  }

  private note(entry: Entry): void {
    try {
      fs.mkdirSync(require('path').dirname(this.opts.logPath), { recursive: true });
      fs.appendFileSync(this.opts.logPath, `${JSON.stringify(entry)}\n`, 'utf-8');
    } catch (error) {
      this.logger.warn('기록을 남기지 못했습니다', error);
    }
  }

  /**
   * 노션에 한 줄. **없어도 본 흐름은 계속 간다** — 목록은 사람이 보는 사본이지 정본이 아니다.
   * 정본은 위 기록 파일이고, 노션이 막혀도 접수·전달은 그대로 돌아야 한다.
   *
   * **작성자는 안 넣는다** — 처리에 필요 없고, 페이지를 누구와 볼지 모른다.
   */
  private toNotion(kind: string, to: string, text: string, status: string): void {
    if (!this.opts.notionDb || !this.opts.notionScript) return;
    const args = [
      '-X', 'utf8', this.opts.notionScript, '--profile', 'personal', 'row-create',
      '--db', this.opts.notionDb,
      '--set', `이름=${text.split('\n')[0].slice(0, 60)}`,
      '--set', `종류=${KIND_LABEL[kind] ?? kind}`,
      '--set', `상태=${status}`,
      '--set', `내용=${text.slice(0, 1800)}`,
    ];
    if (to) args.push('--set', `대상=${to}`);
    try {
      const proc = spawn(this.opts.notionPython ?? 'python', args, { windowsHide: true });
      let err = '';
      proc.stderr.on('data', (c) => { err += c.toString(); });
      proc.on('close', (code) => {
        if (code !== 0) this.logger.warn(`노션에 못 남겼습니다 (rc=${code}) ${err.slice(-200)}`);
      });
      proc.on('error', (error) => this.logger.warn('노션 스크립트를 못 띄웠습니다', error));
    } catch (error) {
      this.logger.warn('노션에 못 남겼습니다', error);
    }
  }

  // ── 자잘한 것 ─────────────────────────────────────────────────────────
  private async person(client: App['client'], user: string): Promise<string> {
    const known = this.names.get(user);
    if (known) return known;
    try {
      const res = await client.users.info({ user });
      const p = res.user?.profile;
      const name = p?.display_name || p?.real_name || res.user?.name || user;
      this.names.set(user, name);
      return name;
    } catch {
      return user;
    }
  }

  private async tell(client: App['client'], user: string, text: string, blocks?: any[]): Promise<void> {
    try {
      const im = await client.conversations.open({ users: user });
      if (im.channel?.id) {
        await client.chat.postMessage({ channel: im.channel.id, text, ...(blocks ? { blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }, ...blocks] } : {}) });
      }
    } catch (error) {
      this.logger.warn('DM 을 못 보냈습니다', error);
    }
  }

  private day(iso: string): string {
    const d = new Date(iso);
    return `${d.getMonth() + 1}월 ${d.getDate()}일`;
  }
}

function opt(text: string, value: string): any {
  return { text: { type: 'plain_text', text: text.slice(0, 75) }, value };
}

/** ISO 주 도장(`2026-W32`). **두 자리로 적는다** — 사람이 눈으로 대조할 값이다. */
function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dow = t.getUTCDay() || 7;              // 월=1 … 일=7
  t.setUTCDate(t.getUTCDate() + 4 - dow);      // 그 주의 목요일이 해를 정한다
  const year = t.getUTCFullYear();
  const jan1 = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil(((t.getTime() - jan1.getTime()) / 86400000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}
