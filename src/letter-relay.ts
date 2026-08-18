import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { App } from '@slack/bolt';
import { Logger } from './logger';
import { coffeechatMessage } from './coffeechat-message';

/**
 * 레터의 **칭찬 전달** — 커피챗에 동료가 남긴 긍정 피드백을 당사자에게 나른다.
 *
 * 설계와 그 근거는 1on1 워크스페이스의 `letter-relay-design.md` 에 있다.
 * 여기서는 코드가 지켜야 하는 것만 적는다.
 *
 * **작성자는 절대 노출되지 않는다.** 이것이 이 기능의 목적이고, 아래가 전부 거기서 나온다.
 *
 *   1. **모델을 안 거친다.** 전달문은 사람이 쓴 그대로 간다 — 모델이 다듬으면 실장이
 *      본 것과 나가는 것이 달라지고, 말투 프리셋까지 얹히면 칭찬이 그 주의 말투로 나간다
 *      (아첨하는 말투가 걸린 주에는 동료가 쓰지도 않은 찬사가 붙는다).
 *   2. **받는 사람은 목록에서 고른다.** 이름을 글로 받아 맞춰 보는 순간 동명이인·오타가 들어온다.
 *   3. **마지막으로 본 글자가 그대로 나간다.** 확인 화면이 들고 있는 글을 보낸다 —
 *      다시 읽거나 다시 만들지 않는다.
 *   4. **대화와 다른 길로 간다.** 슬래시 명령과 모달만 쓴다. 말로 시킬 수 없어야
 *      잡담 중에 오발이 나지 않는다.
 *
 * 실장이 확인 화면에서 **문장을 고칠 수 있다.** 원문 보존이 원칙이 아니라 작성자가
 * 안 짚이게 만드는 것이 원칙이다 — 둘이 부딪히면 익명이 이긴다.
 */

const COMMAND = '/praise';
const COMPOSE = 'relay_compose';
const CONFIRM = 'relay_confirm';

const BLOCK_TO = 'to';
const BLOCK_TEXT = 'body';
const MAX_LEN = 2500;

export interface LetterRelayOptions {
  /** 이 사람만 쓴다. 비면 기능 자체가 꺼진다. */
  managerUserId: string;
  /** 받는 사람 후보. 비면 기능 자체가 꺼진다 — 목록이 없으면 고를 수가 없다. */
  members: string[];
  /** 보낸 기록을 남길 곳. `turn.py` 옆 `bots/letter/data/` 를 그대로 쓴다. */
  logPath: string;
}

interface Sent {
  ts: string;
  to: string;
  to_name: string;
  chars: number;
  head: string;
  sha: string;
}

export class LetterRelay {
  private logger = new Logger('Letter:relay');
  private names = new Map<string, { label: string; handle: string }>();

  constructor(private readonly opts: LetterRelayOptions) {}

  get enabled(): boolean {
    return Boolean(this.opts.managerUserId) && this.opts.members.length > 0;
  }

  /** `ChatHost` 의 `attach` 로 넘긴다 — 소켓을 열기 전에 불린다. */
  register = (app: App): void => {
    if (!this.enabled) {
      this.logger.info('꺼짐 — 실장 ID 나 받는 사람 목록이 비어 있습니다');
      return;
    }

    app.command(COMMAND, async ({ command, ack, respond, client }) => {
      await ack();
      // 슬래시 명령은 앱이 깔린 사람 **모두에게 보인다.** 조용히 무시하면 고장 난 것처럼
      // 보이므로, 쓸 수 없다는 것만 본인에게만 알린다(다른 사람에겐 안 보인다).
      if (command.user_id !== this.opts.managerUserId) {
        this.logger.info(`${command.user_id} 가 ${COMMAND} 를 불렀지만 실장이 아닙니다`);
        await respond({ response_type: 'ephemeral', text: '이 명령은 실장만 쓸 수 있습니다.' });
        return;
      }
      try {
        await client.views.open({
          trigger_id: command.trigger_id,
          view: await this.composeView(client),
        });
      } catch (error) {
        // 창이 안 뜨면 슬랙 쪽에는 아무 일도 안 일어난다 — 로그만 남기면 왜 안 되는지
        // 알 길이 없다. 사람 이름을 처음 받아오는 순간이라 3초 제한에 걸릴 수 있는 자리다.
        this.logger.warn('전달 창을 못 열었습니다', error);
        await respond({
          response_type: 'ephemeral',
          text: `전달 창을 열지 못했습니다. 한 번 더 시도해 주세요.\n\`${String(error).slice(0, 200)}\``,
        });
      }
    });

    // 1단계 제출 → 확인 화면을 **위에 쌓는다**(push). 뒤로 가면 쓴 것이 그대로 남아 고칠 수 있다.
    app.view(COMPOSE, async ({ ack, view, client }) => {
      const to = view.state.values[BLOCK_TO]?.[BLOCK_TO]?.selected_option?.value ?? '';
      const text = (view.state.values[BLOCK_TEXT]?.[BLOCK_TEXT]?.value ?? '').trim();

      if (!to || !text) {
        await ack({ response_action: 'errors', errors: { [BLOCK_TEXT]: '전달할 글을 적어 주세요.' } });
        return;
      }
      if (text.length > MAX_LEN) {
        await ack({
          response_action: 'errors',
          errors: { [BLOCK_TEXT]: `${MAX_LEN}자까지만 됩니다 (지금 ${text.length}자).` },
        });
        return;
      }
      await ack({ response_action: 'push', view: this.confirmView(to, await this.label(client, to), text) });
    });

    // 2단계 제출 = 보내기. **화면의 칸에 있던 글을 그대로 보낸다** —
    // 실장이 방금 고쳤을 수 있으므로 원문을 다시 꺼내 쓰지 않는다.
    app.view(CONFIRM, async ({ ack, body, view, client }) => {
      const text = (view.state.values[BLOCK_TEXT]?.[BLOCK_TEXT]?.value ?? '').trim();
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
      // **창을 통째로 닫는다.** 빈 응답은 이 화면만 닫고 아래 첫 화면을 남기는데,
      // 그러면 보냈다는 표시가 없어 한 번 더 누르게 되고(실측: 19초에 세 번),
      // 남아 있던 앞사람 글이 다음 사람에게 그대로 갈 수도 있다.
      await ack({ response_action: 'clear' });

      // **창은 이미 닫혔다.** 여기서 조용히 돌아서면 보낸 줄 알고 넘어간다 —
      // 「안 갔다」는 사실은 반드시 손에 쥐여 줘야 한다. 글도 같이 돌려준다.
      let who: { to: string; name: string } | null = null;
      try {
        who = JSON.parse((body.view.private_metadata || '{}') as string);
      } catch {
        who = null;
      }
      if (!who?.to) {
        this.logger.warn('받는 사람을 못 읽었습니다 — 아무것도 보내지 않습니다');
        await this.tell(client, body.user.id,
          '받는 사람을 잃어버려서 *아무것도 보내지 않았습니다.* 아래 글을 그대로 다시 넣어 주세요.\n'
          + `> ${text.slice(0, 60)}${text.length > 60 ? '…' : ''}`);
        return;
      }
      await this.send(client, body.user.id, who.to, who.name, text);
    });

    this.logger.info(`${COMMAND} 준비됨 (받는 사람 후보 ${this.opts.members.length}명)`);
  };

  // ── 화면 ──────────────────────────────────────────────────────────────
  private async composeView(client: App['client']): Promise<any> {
    const options = await Promise.all(this.opts.members.map(async (id) => {
      const { label } = await this.person(client, id);
      return { text: { type: 'plain_text', text: label.slice(0, 75) }, value: id };
    }));

    return {
      type: 'modal',
      callback_id: COMPOSE,
      title: { type: 'plain_text', text: '칭찬 전달' },
      submit: { type: 'plain_text', text: '다음' },
      close: { type: 'plain_text', text: '취소' },
      blocks: [
        {
          type: 'input', block_id: BLOCK_TO,
          label: { type: 'plain_text', text: '받는 사람' },
          element: {
            type: 'static_select', action_id: BLOCK_TO,
            placeholder: { type: 'plain_text', text: '고르세요' },
            options,
          },
        },
        {
          type: 'input', block_id: BLOCK_TEXT,
          label: { type: 'plain_text', text: '전달할 글' },
          hint: { type: 'plain_text', text: '작성자가 짚이지 않게 여기서 고쳐도 됩니다. 적은 그대로 나갑니다.' },
          element: {
            type: 'plain_text_input', action_id: BLOCK_TEXT, multiline: true,
            placeholder: { type: 'plain_text', text: '커피챗에서 옮겨 붙이고, 필요하면 다듬으세요' },
          },
        },
      ],
    };
  }

  private confirmView(to: string, name: string, text: string): any {
    const before = this.sentBefore(to, text);
    const blocks: any[] = [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*받는 사람*\n${name} · <@${to}>` },
      },
      // **읽는 칸이 아니라 고치는 칸이다.** 여기 있는 글이 그대로 나가므로,
      // 화면에서 본 것과 나가는 것이 어긋날 자리가 없다.
      {
        type: 'input', block_id: BLOCK_TEXT,
        label: { type: 'plain_text', text: '보낼 글 (여기서 고칠 수 있습니다)' },
        hint: { type: 'plain_text', text: '이 칸에 있는 그대로 나갑니다. 다듬어도 됩니다.' },
        element: {
          type: 'plain_text_input', action_id: BLOCK_TEXT, multiline: true,
          initial_value: text,
        },
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: '*이 문장으로 누가 썼는지 짚이지 않습니까?*' },
      },
    ];
    if (before) {
      blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `⚠️ 같은 글을 이 사람에게 보낸 기록이 있습니다 (${before})` }],
      });
    }
    return {
      type: 'modal',
      callback_id: CONFIRM,
      // 받는 사람만 들고 간다. 글은 화면의 칸이 정본이다 — 두 군데 두면 어긋난다.
      private_metadata: JSON.stringify({ to, name }),
      title: { type: 'plain_text', text: '이대로 보낼까요' },
      submit: { type: 'plain_text', text: '보내기' },
      close: { type: 'plain_text', text: '취소' },
      blocks,
    };
  }

  // ── 보내기 ────────────────────────────────────────────────────────────
  private async send(
    client: App['client'], manager: string, to: string, name: string, text: string,
  ): Promise<void> {
    // 방금 같은 글을 같은 사람에게 보냈으면 **보내지 않는다.** 화면이 닫히게 고쳤지만,
    // 되돌릴 수 없는 일에는 마지막 빗장이 하나 더 있어야 한다. 같은 글을 몇 분 안에
    // 두 번 보내는 것은 실수 말고는 이유가 없다.
    const again = this.sentJustNow(to, text);
    if (again) {
      this.logger.info(`같은 글이 ${again}초 전에 나갔습니다 — 다시 보내지 않습니다 (${name})`);
      await this.tell(client, manager,
        // 슬랙 굵게는 별표 하나다 — `**…**` 로 쓰면 별표가 그대로 보인다.
        `방금 ${again}초 전에 같은 글을 ${name} 님에게 보냈습니다. *다시 보내지 않았습니다.*`);
      return;
    }
    try {
      const im = await client.conversations.open({ users: to });
      const channel = im.channel?.id;
      if (!channel) throw new Error('DM 방을 못 열었습니다');

      await client.chat.postMessage({ channel, ...coffeechatMessage([text]) });

      const record: Sent = {
        ts: new Date().toISOString(),
        to, to_name: name,
        chars: text.length,
        head: text.slice(0, 30),
        sha: crypto.createHash('sha256').update(text).digest('hex').slice(0, 16),
      };
      this.note(record);
      this.logger.info(`전달 완료 → ${name} (${text.length}자)`);

      await this.tell(client, manager, `보냈습니다 · ${name} · ${text.length}자\n> ${record.head}${text.length > 30 ? '…' : ''}`);
    } catch (error) {
      this.logger.warn('전달 실패', error);
      await this.tell(client, manager, `보내지 못했습니다 (${name}). 그대로 남아 있으니 다시 시도해 주세요.\n\`${String(error).slice(0, 200)}\``);
    }
  }

  /** 실장에게만 가는 영수증. 여기서 또 실패해도 전달은 이미 끝났다. */
  private async tell(client: App['client'], user: string, text: string): Promise<void> {
    try {
      const im = await client.conversations.open({ users: user });
      if (im.channel?.id) await client.chat.postMessage({ channel: im.channel.id, text });
    } catch (error) {
      this.logger.debug('영수증을 못 보냈습니다', error);
    }
  }

  // ── 기록 ──────────────────────────────────────────────────────────────
  /** 글 자체는 남기지 않는다 — 지문(해시)과 앞머리면 두 번 보낸 것을 알아보기에 충분하다. */
  private note(record: Sent): void {
    try {
      fs.mkdirSync(path.dirname(this.opts.logPath), { recursive: true });
      fs.appendFileSync(this.opts.logPath, `${JSON.stringify(record)}\n`, 'utf-8');
    } catch (error) {
      this.logger.warn('보낸 기록을 못 남겼습니다', error);
    }
  }

  /** 같은 글을 같은 사람에게 보낸 지 10분이 안 됐으면 몇 초 전이었는지. 아니면 null. */
  private sentJustNow(to: string, text: string): number | null {
    const sha = crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
    for (const past of this.history()) {
      if (past.to !== to || past.sha !== sha) continue;
      const ago = (Date.now() - Date.parse(past.ts)) / 1000;
      return ago >= 0 && ago < 600 ? Math.round(ago) : null;
    }
    return null;
  }

  private history(): Sent[] {
    try {
      return fs.readFileSync(this.opts.logPath, 'utf-8').trim().split('\n')
        .filter(Boolean).reverse().map((line) => JSON.parse(line) as Sent);
    } catch {
      return [];   // 기록이 아직 없다 — 처음 보내는 것이다.
    }
  }

  private sentBefore(to: string, text: string): string | null {
    const sha = crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
    for (const past of this.history()) {
      if (past.to === to && past.sha === sha) return past.ts.slice(0, 10);
    }
    return null;
  }

  // ── 이름 ──────────────────────────────────────────────────────────────
  /** 목록에 계정까지 같이 띄운다. 이름만 보여주면 잘못 고른 것을 못 알아챈다. */
  private async person(client: App['client'], id: string): Promise<{ label: string; handle: string }> {
    const cached = this.names.get(id);
    if (cached) return cached;
    let label = id;
    let handle = '';
    try {
      const res = await client.users.info({ user: id });
      const profile = res.user?.profile as { display_name?: string; real_name?: string } | undefined;
      const name = profile?.real_name || profile?.display_name || res.user?.real_name || id;
      handle = (res.user?.name as string) ?? '';
      label = handle ? `${name} (@${handle})` : name;
    } catch (error) {
      this.logger.debug(`users.info 실패 (${id})`, error);
    }
    const found = { label, handle };
    this.names.set(id, found);
    return found;
  }

  private async label(client: App['client'], id: string): Promise<string> {
    return (await this.person(client, id)).label;
  }
}
