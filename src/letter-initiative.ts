import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { App } from '@slack/bolt';
import { Logger } from './logger';
import type { TurnAsk, TurnResult } from './chat-host';

/**
 * 커피콩의 **아침 시계** — 평일 08:30, 현황판(코드가 센 숫자)을 들고 실장 DM 에 와서
 * 「오늘 이렇게 할까요」를 말한다. 커피챗 방에 걸고 싶은 말이 있으면 **확인 카드**로 —
 * 실장이 창에서 보고 「보내기」를 눌러야 방에 오른다. 이 시계는 방에 아무것도 안 올린다.
 *
 * 실장 결정(2026-09-18): 「10시가 아니라 8시 반에 먼저 나한테 DM 으로 이렇게 할까요
 * 물어보고 나서 진행. 개인정보 보호는 다중 안전장치.」 그래서 겹이 이렇다.
 *
 *   ① 자료 층    `comm_pulse.py` 는 숫자만 낸다 — 원문·이름·아이디가 모델에 안 간다
 *   ② 안내 층    `turn.py` 의 MORNING_NOTE — 지목·집계·원문 금지를 모델에게 이른다
 *   ③ 빗장 층 A  `privacy_gate.py` — 방에 걸 글(`pulse`)이 멘션·아이디·집계·숫자·원문 조각이면
 *                카드 자체가 안 만들어지고 실장에게 까닭만 간다
 *   ④ 빗장 층 B  `letter-notice.ts` 의 `guard` — 실원 **이름**·멘션·집계·숫자·길이. 카드를 만들 때와
 *                실장이 창에서 고친 뒤 보낼 때 둘 다. 자료가 다른 두 겹
 *   ⑤ 사람 층    **실장이 창에서 보고 「보내기」** — 대화·시계만으로는 방에 아무것도 안 간다
 *   ⑧ 대화 분리   아침 턴은 실장 DM 대화가 아니라 **따로 둔 대화**(`<실장>-morning`)에서 돈다 — 실장이
 *                DM 에서 한 사람 이야기를 안고 돌면 그 뜻이 글에 스밀 수 있다(외부 검토 2026-09-18).
 *                실장 DM 대화에는 오늘 낸 것을 파일(`morning-today.md`)로 알린다
 *   ⑥ 횟수 층    평일 08:30 뒤 두 시간 창 안에서 하루 한 번 · 공휴일 제외
 *   ⑦ 끄는 층    `LETTER_INITIATIVE=0` 또는 실장이 말로 「자율 꺼」(control 파일)
 *
 * 수요일이면 같은 턴에 주간 보고(현황·눈에 띄는 것·general 제안)가 붙는다 — 안내 층이 한다.
 */

const DEFAULT_AT = '08:30';
/** 시각 뒤 이만큼 안에서만 돈다 — 저녁 재시작이 아침 일을 대신 하지 않게. */
const WINDOW_MIN = 120;
/** 파이썬 `control.actions` 에서 방에 걸 글의 이름. 다른 이름은 이 시계가 안 다룬다. */
const PULSE = 'pulse';

export interface InitiativeHost {
  /** `key` 대화에서 실장 턴으로 현황판을 넣는다. `name` 은 실장 표시 이름. */
  initiate(client: App['client'], key: string, brief: string, name: string): Promise<TurnResult>;
}

export interface LetterInitiativeOptions {
  /** `LETTER_INITIATIVE=1`. 기본은 꺼짐 — 만든 것과 켠 것은 다른 일이다. */
  enabled: boolean;
  /** 평일 이 시각에 한 번 (HH:MM). */
  at: string;
  /** 커피챗 방 — 현황판을 셀 방. 비면 기능이 꺼진다. */
  room: string;
  /** 실장 — 아침 DM 을 받는 사람. 비면 기능이 꺼진다. */
  managerUserId: string;
  /** 실장 표시 이름 — 아침 대화의 첫 줄(「지금 말을 거는 사람은 ○○님이다」)에 쓴다. */
  managerName: string;
  python: string;
  /** `comm_pulse.py` */
  script: string;
  /** 오늘 돌았는지 `initiative-state.json` */
  statePath: string;
  /** 실장이 말로 끄는 값이 적히는 파일(`control.json` · `always.initiative === false` 면 꺼짐). */
  controlPath: string;
  host: InitiativeHost;
  /** 확인 카드를 띄우는 곳(`LetterNotice.offer`). 방에 걸 글은 전부 여기로만 간다. **비면 이 시계도 꺼진다** —
   *  카드 길이 없는데 돌면 파이썬이 「카드 드리겠다」고 답해 놓고 카드는 안 온다. */
  offer?: (client: App['client'], asks: TurnAsk[], from: { user: string; channel: string }) => Promise<void>;
  logger?: Logger;
}

export type Outcome =
  | 'off' | 'not-time' | 'done-today' | 'holiday' | 'no-brief'
  | 'quiet' | 'proposed' | 'error';

export class LetterInitiative {
  private logger: Logger;
  private timer: NodeJS.Timeout | null = null;
  /** 오늘 돌았다는 표시를 메모리에도 둔다 — 상태 파일을 못 쓰면 두 시간 동안 매분 돌게 된다(검토 2026-09-18). */
  private ranDay = '';

  constructor(private readonly opts: LetterInitiativeOptions) {
    this.logger = opts.logger ?? new Logger('Letter:initiative');
  }

  get enabled(): boolean {
    return this.opts.enabled && Boolean(this.opts.room) && Boolean(this.opts.managerUserId)
      && Boolean(this.opts.offer);
  }

  /** `ChatHost` 의 `attach` 로 넘긴다. */
  register = (app: App): void => {
    if (!this.enabled) {
      this.logger.info(`꺼짐 — ${!this.opts.enabled ? 'LETTER_INITIATIVE 가 1이 아님' : '방이나 실장 ID 가 비어 있음'}`);
      return;
    }
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick(app.client).catch((error) => this.logger.warn('아침 턴에서 넘어졌습니다', error));
    }, 60 * 1000);
    this.timer.unref?.();
    this.logger.info(`준비됨 — 평일 ${this.opts.at} 실장 DM 으로 「오늘 이렇게 할까요」 · 방에는 카드를 거쳐야만`);
  };

  /**
   * 분마다 — 그 시각이고 오늘 아직이면 한 번 돈다. **창은 두 시간이다** — 저녁에 재시작하면
   * 「08:30 이 지났으니」 그 자리에서 도는 일이 없게. 놓친 날은 그냥 넘어간다.
   */
  async tick(client: App['client'], now = new Date()): Promise<Outcome> {
    const [h, m] = this.opts.at.split(':').map((x) => parseInt(x, 10));
    const atMin = (h || 0) * 60 + (m || 0);
    const nowMin = now.getHours() * 60 + now.getMinutes();
    if (nowMin < atMin || nowMin >= atMin + WINDOW_MIN) return 'not-time';
    const today = localDay(now);
    if (this.ranDay === today || this.state().day === today) return 'done-today';
    // **먼저 적고 돈다** — 도중에 넘어져도 같은 날 두 번 돌지 않는다.
    this.ranDay = today;
    this.saveState({ day: today });
    return this.runOnce(client, now);
  }

  /** 한 번 돈다. 시각·「오늘 했나」는 안 본다(검사에서 바로 부른다). */
  async runOnce(client: App['client'], now = new Date()): Promise<Outcome> {
    if (!this.enabled) return 'off';
    if (this.switchedOff(now)) {
      this.logger.info('실장이 말로 꺼 두었습니다 — 안 돕니다');
      return 'off';
    }
    const pulse = this.pulse();
    if (!pulse) return 'no-brief';
    if (!pulse.workday) return 'holiday';

    let result: TurnResult;
    try {
      // ⑧ 실장 DM 대화(`U…`)가 아니라 아침 전용 대화(`U…-morning`)에서 돈다.
      result = await this.opts.host.initiate(client, `${this.opts.managerUserId}-morning`, pulse.brief,
                                             this.opts.managerName);
    } catch (error) {
      this.logger.warn('아침 턴이 깨졌습니다', error);
      return 'error';
    }
    if (result.error) {
      this.logger.warn(`아침 턴 실패: ${result.error}`);
      return 'error';
    }
    // 실장에게 하는 말 — 그 자체는 카드가 아니다. 방에 걸 글은 아래 `ask` 로만 간다.
    const said = (result.reply || '').trim();
    if (said) await this.tell(client, `:sunrise: ${said}`);

    // 갈래를 가리지 않는다 — 파이썬이 「카드 드리겠다」고 이미 답했으니 전부 카드로 간다. 빗장(이름·
    // 멘션·집계·숫자·길이)은 카드 쪽(`LetterNotice.guard`)이 봇이 쓴 갈래에 건다 — 카드를 만들 때와
    // 실장이 고친 뒤 보낼 때 둘 다.
    const asks = (result.ask || []).filter((a) => a && typeof a.name === 'string');
    if (!asks.length) {
      this.logger.info(said ? '오늘은 방에 걸 글 없이 인사만' : '오늘은 조용히');
      return 'quiet';
    }
    // ⑤ 사람 층 — 카드. 실장이 「보내기」를 눌러야 방에 오른다.
    await this.opts.offer!(client, asks, { user: this.opts.managerUserId, channel: 'DM' });
    this.logger.info(`오늘 제안 ${asks.length}건 — 카드로 실장에게`);
    return 'proposed';
  }

  // ── 층들 ──────────────────────────────────────────────────────────────
  private switchedOff(now = new Date()): boolean {
    let text: string;
    try {
      text = fs.readFileSync(this.opts.controlPath, 'utf-8');
    } catch (error) {
      // 파일이 없으면 끈 적이 없는 것. **있는데 못 읽으면 꺼진 쪽으로** — 「자율 꺼」를 놓치는 것이
      // 하루 조용한 것보다 나쁘다(검토 2026-09-18).
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      this.logger.warn('설정 파일을 못 읽어 오늘은 안 돕니다', error);
      return true;
    }
    try {
      const raw = JSON.parse(text);
      if (raw?.always?.initiative === false) return true;
      // 「오늘만 꺼」는 그 날짜일 때만 — 어제 걸어 둔 것이 오늘까지 먹으면 안 된다.
      return raw?.today?.initiative === false && raw?.today?.date === localDay(now);
    } catch (error) {
      // turn.py 가 다시 쓰는 도중이거나 깨진 파일 — 꺼진 쪽으로.
      this.logger.warn('설정 파일이 JSON 이 아니라 오늘은 안 돕니다', error);
      return true;
    }
  }

  private pulse(): { workday: boolean; brief: string } | null {
    const r = spawnSync(this.opts.python, ['-X', 'utf8', this.opts.script, '--room', this.opts.room], {
      encoding: 'utf-8', windowsHide: true, timeout: 30_000,
    });
    if (r.status !== 0) {
      this.logger.warn(`현황판을 못 만들었습니다 (rc=${r.status}) ${(r.stderr || '').slice(-300)}`);
      return null;
    }
    try {
      const got = JSON.parse((r.stdout || '').trim());
      if (typeof got.brief !== 'string' || !got.brief) return null;
      return { workday: Boolean(got.workday), brief: got.brief };
    } catch {
      this.logger.warn('현황판이 JSON 이 아닙니다');
      return null;
    }
  }

  private async tell(client: App['client'], text: string): Promise<void> {
    try {
      const im = await client.conversations.open({ users: this.opts.managerUserId });
      if (im.channel?.id) await client.chat.postMessage({ channel: im.channel.id, text });
    } catch (error) {
      this.logger.warn('실장에게 말하지 못했습니다', error);
    }
  }

  private state(): { day?: string } {
    try {
      return JSON.parse(fs.readFileSync(this.opts.statePath, 'utf-8'));
    } catch {
      return {};
    }
  }

  private saveState(s: { day: string }): void {
    try {
      fs.mkdirSync(path.dirname(this.opts.statePath), { recursive: true });
      const tmp = `${this.opts.statePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(s), 'utf-8');
      fs.renameSync(tmp, this.opts.statePath);
    } catch (error) {
      this.logger.warn('상태를 못 적었습니다', error);
    }
  }
}

function localDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export { DEFAULT_AT };
