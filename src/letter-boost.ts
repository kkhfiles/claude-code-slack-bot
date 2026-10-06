/**
 * 「이번 주 한 조각」 후보에서 하나를 고르는 버튼과 버리는 버튼.
 *
 * **버리면 다시는 후보로 안 올라온다** — 그 자리를 통의 다음 편으로 채우고 목록을 고치는 것까지
 * 파이썬(`drop`)이 한다. 여기서는 부르기만 하고, 실패했을 때만 그 글 답글로 알린다.
 *
 * **여기서 글을 만들지 않는다.** 통을 읽고 고르고 내보내는 일은 전부 파이썬
 * (`chatbot/weekly_boost.py`)이 한다. 이쪽이 하는 일은 버튼을 받아 그 스크립트를
 * 부르고, 누른 사람에게 결과를 보여 주는 것까지다 — 같은 판단이 두 곳에 있으면
 * 화면과 실제로 나가는 것이 갈린다.
 *
 * **누를 수 있는 사람은 실장뿐이다.** 이 글은 실장 DM 으로만 가지만, 막는 것은
 * 프롬프트가 아니라 코드여야 한다.
 */
import { spawn } from 'child_process';
import type { App } from '@slack/bolt';

const PICK = 'boost_pick';
const DROP = 'boost_drop';

export interface LetterBoostOptions {
  managerUserId: string;
  python: string;
  /** `weekly_boost.py` 경로 */
  script: string;
  logger?: { info: (m: string, ...a: any[]) => void; warn: (m: string, ...a: any[]) => void };
}

export class LetterBoost {
  constructor(private opts: LetterBoostOptions) {}

  register(app: App): void {
    app.action({ action_id: PICK }, async ({ ack, body, client }) => {
      await ack();
      const payload = body as any;
      if (payload.user?.id !== this.opts.managerUserId) return;
      const id = payload.actions?.[0]?.value as string;
      if (!id) return;

      const out = await this.run(['choose', '--id', id]);
      // **버튼을 지우고 결과로 바꾼다.** 그대로 두면 눌렸는지 알 수 없어 또 누르게 되고,
      // 다음 주에 지난주 후보 버튼이 남아 있으면 엉뚱한 편이 나간다.
      const said = out.ok
        ? (out.text.trim().split('\n').filter(Boolean).pop() || '골랐습니다.')
        : `고른 것을 저장하지 못했습니다 — ${out.text.slice(-200)}`;
      try {
        await client.chat.update({
          channel: payload.channel?.id,
          ts: payload.message?.ts,
          text: said,
          blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `☕ ${said}` } }],
        });
      } catch (error) {
        this.opts.logger?.warn('고른 결과를 화면에 못 바꿨습니다', error);
      }
      this.opts.logger?.info(`이번 주 한 조각 · 고름 ${id} · ${out.ok ? 'ok' : 'fail'}`);
    });
    app.action({ action_id: DROP }, async ({ ack, body, client }) => {
      await ack();
      const payload = body as any;
      if (payload.user?.id !== this.opts.managerUserId) return;
      const id = payload.actions?.[0]?.value as string;
      if (!id) return;

      // **화면은 파이썬이 고친다** — 다음 편을 고르는 판단과 목록 모양이 거기 있다. 여기서 또
      // 고치면 두 곳이 서로 덮는다. 성공이면 목록이 이미 바뀌어 있으므로 아무 말도 안 한다.
      const out = await this.run(['drop', '--id', id]);
      if (!out.ok) {
        try {
          await client.chat.postMessage({
            channel: payload.channel?.id,
            thread_ts: payload.message?.ts,
            text: `버리지 못했습니다 — ${out.text.slice(-200)}`,
          });
        } catch (error) {
          this.opts.logger?.warn('버리기 실패를 못 알렸습니다', error);
        }
      }
      this.opts.logger?.info(`이번 주 한 조각 · 버림 ${id} · ${out.ok ? 'ok' : 'fail'}`);
    });
    // **켜졌다는 것을 시작 로그에 남긴다.** 다른 모듈은 다 남기는데 이것만 조용하면,
    // 버튼이 안 먹을 때 「안 붙은 것」과 「눌러도 아무 일이 없는 것」을 못 가른다.
    this.opts.logger?.info(
      `[Letter:한조각] 후보 버튼(고르기·버리기) 준비됨 — 누를 수 있는 사람 1명 · ${this.opts.script}`);
  }

  private run(args: string[]): Promise<{ ok: boolean; text: string }> {
    return new Promise((resolve) => {
      const child = spawn(this.opts.python, ['-X', 'utf8', this.opts.script, ...args], {
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
        windowsHide: true,
      });
      let text = '';
      child.stdout.on('data', (c) => { text += c.toString(); });
      child.stderr.on('data', (c) => { text += c.toString(); });
      // 버튼 응답은 이미 `ack()` 으로 끝냈으므로 여기서 오래 걸려도 슬랙은 안 탄다.
      // 그래도 영영 안 끝나는 것은 막는다.
      const kill = setTimeout(() => child.kill(), 60_000);
      child.on('error', (e) => { clearTimeout(kill); resolve({ ok: false, text: String(e) }); });
      child.on('close', (code) => { clearTimeout(kill); resolve({ ok: code === 0, text }); });
    });
  }
}
