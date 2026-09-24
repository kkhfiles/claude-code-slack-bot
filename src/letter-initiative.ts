import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { App } from '@slack/bolt';
import { Logger } from './logger';
import type { TurnAsk, TurnResult } from './chat-host';

/**
 * 커피콩의 **주간 시계** — 주 첫 업무일 13:00, 현황판(코드가 센 숫자)과 지난주부터 방에서 오간
 * 말(글쓴이는 뺀 것)을 들고 실장 DM 에 와서 「이번 주 이렇게 할까요」를 말한다. 커피챗 방에
 * 걸고 싶은 말이 있으면 **확인 카드**로 — 실장이 창에서 보고 「보내기」를 눌러야 방에 오른다.
 * 이 시계는 방에 아무것도 안 올린다.
 *
 * 실장 결정(2026-09-18): 「먼저 나한테 DM 으로 이렇게 할까요 물어보고 나서 진행. 개인정보
 * 보호는 다중 안전장치.」 (2026-09-21): 「월요일 오후 1시쯤 · 부서 내 커뮤니케이션 개선이라는
 * 목적 하에 커피콩이 스스로 의견도 묻고 취합하고 아이디어도 내면서 주도해야 한다.」 취합하려면
 * 사람들이 한 말을 알아야 하므로 방의 지난주부터의 말을 같이 준다 — **방에 공개된 말만**, 글쓴이와
 * 멘션은 지우고. 커피챗 원문·1:1·1on1 은 여전히 숫자로만 간다. 그래서 겹이 이렇다.
 *
 *   ① 자료 층    `comm_pulse.py` 는 숫자만 낸다 — 커피챗 원문·1:1·이름·아이디가 모델에 안 간다.
 *                방의 지난주부터의 말(`recent`)은 방에 이미 공개된 말이고, 글쓴이·멘션은 지운다
 *   ② 안내 층    `turn.py` 의 MORNING_NOTE — 목적·취합·지목·집계·원문 금지를 모델에게 이른다
 *   ③ 빗장 층 A  `privacy_gate.py` — 방에 걸 글(`pulse`)이 멘션·아이디·집계·숫자·원문 조각이면
 *                카드 자체가 안 만들어지고 실장에게 까닭만 간다
 *   ④ 빗장 층 B  `letter-notice.ts` 의 `guard` — 실원 **이름**·멘션·집계·숫자·길이. 카드를 만들 때와
 *                실장이 창에서 고친 뒤 보낼 때 둘 다. 자료가 다른 두 겹
 *   ⑤ 사람 층    **실장이 창에서 보고 「보내기」** — 대화·시계만으로는 방에 아무것도 안 간다
 *   ⑧ 대화 분리   주간 턴은 실장 DM 대화가 아니라 **따로 둔 대화**(`<실장>-morning`)에서 돈다 — 실장이
 *                DM 에서 한 사람 이야기를 안고 돌면 그 뜻이 글에 스밀 수 있다(외부 검토 2026-09-18).
 *                실장 DM 대화에는 이번 주 낸 것을 파일(`morning-today.md`)로 알린다
 *   ⑥ 횟수 층    **한 주에 한 번** — 월요일 13:00 뒤 두 시간 창. 그날 못 돌면(쉬는 날 · PC 꺼짐 ·
 *                현황판 실패) 그 주 다음 업무일 같은 창에서. 놓친 주는 되찾지 않는다(검토 2026-09-21)
 *   ⑦ 끄는 층    `LETTER_INITIATIVE=0` 또는 실장이 말로 「자율 꺼」(control 파일)
 *
 * **소인도 같은 시계를 쓴다**(실장 2026-09-24 「봇 모두 주체적 판단은 주 1회 후 나에게 DM 으로 제안 · 필요하면
 * 뉴스·웹 검색」). 다른 것은 넷 — 읽을 방(`rooms` · 점심원정대·친목 방) · 방 이력을 읽는 클라이언트(`reader` · 소인
 * 토큰 — 커피콩 앱은 그 방에 없다) · 현황판(`lunch_pulse.py` · `pulseArgs`) · DM 머리(`prefix`). DM 과 카드는 둘 다
 * 커피콩 앱으로 간다(소인 앱에는 실장 DM 이 없다) — 카드를 「보내기」하면 소인 이름으로 오른다(`LetterNotice` 의
 * `poster`). 판단 턴은 파이썬이 웹 검색을 열고(`WEB_NOTE`) 제안만 받는다.
 */

const DEFAULT_AT = '13:00';
/** 시각 뒤 이만큼 안에서만 돈다 — 저녁 재시작이 낮의 일을 대신 하지 않게. */
const WINDOW_MIN = 120;
/** 방에서 읽어 오는 말의 상한 — 줄 수와 줄 길이. 넘치면 오래된 것부터 버린다. */
const RECENT_MAX_LINES = 25;
const RECENT_MAX_CHARS = 280;
/** 방 이력을 넘길 최대 장수(장당 200) — 3주치 커피챗 방이면 한두 장이다. */
const HISTORY_PAGES = 5;
/** 파이썬 `control.actions` 에서 방에 걸 글의 이름. 다른 이름은 이 시계가 안 다룬다. */
const PULSE = 'pulse';

export interface InitiativeHost {
  /** `key` 대화에서 실장 턴으로 현황판을 넣는다. `name` 은 실장 표시 이름. */
  initiate(client: App['client'], key: string, brief: string, name: string): Promise<TurnResult>;
}

export interface LetterInitiativeOptions {
  /** `LETTER_INITIATIVE=1`. 기본은 꺼짐 — 만든 것과 켠 것은 다른 일이다. */
  enabled: boolean;
  /** 이 시각에 한 주 한 번 (HH:MM) — 월요일이 기본이고 못 돌면 다음 업무일. */
  at: string;
  /** 커피챗 방 — 현황판을 셀 방이자 지난주부터의 말을 읽을 방. `rooms` 가 없고 이것도 비면 기능이 꺼진다. */
  room?: string;
  /** 지난주부터의 말을 읽을 방 여럿(이름과 함께). 없으면 `room` 하나(커피챗). */
  rooms?: { id: string; label: string }[];
  /** 방 이력을 읽는 클라이언트 — 그 방에 들어가 있는 봇의 것. 없으면 이 앱. `auth.test` 로 「네 글」을 가린다. */
  reader?: Pick<App['client'], 'auth' | 'conversations'>;
  /** 현황판 스크립트 인자. 없으면 `--room <room>`(커피콩 `comm_pulse.py`). */
  pulseArgs?: string[];
  /** 실장 DM 에 붙는 머리. 없으면 `:coffee: `. */
  prefix?: string;
  /** 실장 — 주간 DM 을 받는 사람. 비면 기능이 꺼진다. */
  managerUserId: string;
  /** 실장 표시 이름 — 주간 대화의 첫 줄(「지금 말을 거는 사람은 ○○님이다」)에 쓴다. */
  managerName: string;
  python: string;
  /** `comm_pulse.py` */
  script: string;
  /** 이번 주 돌았는지(`week`) · 오늘 쉬는 날로 봤는지(`day`) `initiative-state.json` */
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
  | 'off' | 'not-time' | 'done-today' | 'done-this-week' | 'holiday' | 'no-brief'
  | 'quiet' | 'proposed' | 'error';

export class LetterInitiative {
  private logger: Logger;
  private timer: NodeJS.Timeout | null = null;
  /** 이번 주 돌았다는 표시를 메모리에도 둔다 — 상태 파일을 못 쓰면 두 시간 동안 매분 돌게 된다(검토 2026-09-18). */
  private ranWeek = '';
  /** 오늘을 쉬는 날로 봤다는 표시 — 쉬는 날에 두 시간 동안 매분 파이썬을 부르지 않게. */
  private restDay = '';

  constructor(private readonly opts: LetterInitiativeOptions) {
    this.logger = opts.logger ?? new Logger('Letter:initiative');
  }

  get enabled(): boolean {
    return this.opts.enabled && this.rooms().length > 0 && Boolean(this.opts.managerUserId)
      && Boolean(this.opts.offer);
  }

  private rooms(): { id: string; label: string }[] {
    return this.opts.rooms ?? (this.opts.room ? [{ id: this.opts.room, label: '커피챗' }] : []);
  }

  /** `ChatHost` 의 `attach` 로 넘긴다. */
  register = (app: App): void => {
    if (!this.enabled) {
      this.logger.info(`꺼짐 — ${!this.opts.enabled ? '켜는 설정(…_INITIATIVE)이 1이 아님' : '방이나 실장 ID 가 비어 있음'}`);
      return;
    }
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick(app.client).catch((error) => this.logger.warn('주간 턴에서 넘어졌습니다', error));
    }, 60 * 1000);
    this.timer.unref?.();
    this.logger.info(`준비됨 — 월요일(못 돌면 다음 업무일) ${this.opts.at} 실장 DM 으로 「이번 주 이렇게 할까요」 · 방에는 카드를 거쳐야만`);
  };

  /**
   * 분마다 — 그 시각이고 이번 주 아직이면 한 번 돈다. **창은 두 시간이다** — 저녁에 재시작하면
   * 「13:00 이 지났으니」 그 자리에서 도는 일이 없게.
   *
   * **주 단위로 센다.** 월요일 창을 놓치면(PC 꺼짐 · 쉬는 날 · 현황판 실패) 그 주 다음 업무일
   * 같은 창에서 돈다 — 하루 한 번이던 때는 하루 손해였는데 주 한 번이 되면서 한 주 손해가
   * 됐다(검토 2026-09-21). 아무 일도 안 한 결과(현황판 실패 · 쉬는 날)는 표시를 되돌리고,
   * 모델을 부른 뒤의 결과는 되돌리지 않는다 — 되돌리면 매분 모델을 부른다.
   */
  async tick(client: App['client'], now = new Date()): Promise<Outcome> {
    const [h, m] = this.opts.at.split(':').map((x) => parseInt(x, 10));
    const atMin = (h || 0) * 60 + (m || 0);
    const nowMin = now.getHours() * 60 + now.getMinutes();
    if (nowMin < atMin || nowMin >= atMin + WINDOW_MIN) return 'not-time';
    const today = localDay(now);
    const week = localDay(mondayOf(now));
    const st = this.state();
    if (this.ranWeek === week || st.week === week) return 'done-this-week';
    if (this.restDay === today || st.day === today) return 'done-today';
    // **먼저 적고 돈다** — 도중에 넘어져도 같은 주에 두 번 돌지 않는다.
    this.ranWeek = week;
    this.saveState({ week });
    const out = await this.runOnce(client, now);
    if (out === 'holiday') {
      // 오늘은 쉬는 날 — 이번 주 표시는 되돌리고(다음 업무일에 돈다) 오늘 표시만 남긴다.
      this.ranWeek = '';
      this.restDay = today;
      this.saveState({ day: today });
    } else if (out === 'no-brief') {
      // 현황판을 못 만들었다 — 모델도 DM 도 없었으니 되돌려 다음 분에 다시 해 본다.
      this.ranWeek = '';
      this.saveState({});
    }
    return out;
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

    // 취합할 재료 — 방의 지난주부터. 못 읽으면 숫자만 들고 간다(주간 턴을 거르지는 않는다).
    const recent = await this.recent(client, now);
    const brief = recent ? `${pulse.brief}\n\n${recent}` : pulse.brief;

    let result: TurnResult;
    try {
      // ⑧ 실장 DM 대화(`U…`)가 아니라 주간 전용 대화(`U…-morning`)에서 돈다.
      result = await this.opts.host.initiate(client, `${this.opts.managerUserId}-morning`, brief,
                                             this.opts.managerName);
    } catch (error) {
      this.logger.warn('주간 턴이 깨졌습니다', error);
      return 'error';
    }
    if (result.error) {
      this.logger.warn(`주간 턴 실패: ${result.error}`);
      return 'error';
    }
    // 실장에게 하는 말 — 그 자체는 카드가 아니다. 방에 걸 글은 아래 `ask` 로만 간다.
    const said = (result.reply || '').trim();
    if (said) await this.tell(client, `${this.opts.prefix ?? ':coffee: '}${said}`);

    // 갈래를 가리지 않는다 — 파이썬이 「카드 드리겠다」고 이미 답했으니 전부 카드로 간다. 빗장(이름·
    // 멘션·집계·숫자·길이)은 카드 쪽(`LetterNotice.guard`)이 봇이 쓴 갈래에 건다 — 카드를 만들 때와
    // 실장이 고친 뒤 보낼 때 둘 다.
    const asks = (result.ask || []).filter((a) => a && typeof a.name === 'string');
    if (!asks.length) {
      this.logger.info(said ? '이번 주는 방에 걸 글 없이 실장에게 말만' : '이번 주는 조용히');
      return 'quiet';
    }
    // ⑤ 사람 층 — 카드. 실장이 「보내기」를 눌러야 방에 오른다.
    await this.opts.offer!(client, asks, { user: this.opts.managerUserId, channel: 'DM' });
    this.logger.info(`이번 주 제안 ${asks.length}건 — 카드로 실장에게`);
    return 'proposed';
  }

  /**
   * 방의 지난주부터 **사람이 한 말**을 모은다 — 글쓴이는 안 싣고 멘션은 지운다. 스레드는
   * **누구 글 아래든** 읽는다(처음엔 커피콩 글만 읽었다 — 물음과 답을 짝지으려고. 그런데 취합
   * 재료로는 남의 글 아래 오간 말도 같은 값이다 · 실장 물음 2026-09-21). 답글에는 「어느 글에
   * 단 답인지」를 붙이고, 그 글이 커피콩 것이면 「네 글」이라고 적는다. 다른 봇(소인)의 말과
   * 그 스레드는 뺀다. 방에 이미 공개된 말만이고, 이 글은 실장 DM 과 카드로만 간다.
   *
   * 무엇이든 못 읽으면 빈 글자 — 주간 턴은 숫자만 들고 돈다. 취합이 빠지는 것이 턴이 빠지는
   * 것보다 낫다.
   */
  private async recent(client: App['client'], now: Date): Promise<string> {
    const reader = this.opts.reader ?? client;
    let me: string | undefined;
    try {
      me = (await reader.auth.test()).user_id as string | undefined;
    } catch (error) {
      this.logger.warn('방 이력을 읽을 봇을 못 알아봤습니다 — 숫자만 들고 갑니다', error);
      return '';
    }
    if (!me) return '';
    const parts: string[] = [];
    for (const room of this.rooms()) {
      const got = await this.recentRoom(reader, room, me, now);
      if (got) parts.push(got);
    }
    return parts.join('\n\n');
  }

  /** 방 하나의 지난주부터 — 못 읽으면 빈 글자(다른 방·숫자는 그대로 간다). */
  private async recentRoom(
    client: Pick<App['client'], 'conversations'>, room: { id: string; label: string }, me: string, now: Date,
  ): Promise<string> {
    try {
      // **말은 지난주 월요일 0시부터, 뿌리 글은 3주 전 월요일부터.** 「지금부터 7일」로 잡으면
      // 지난주 월요일 08:30 에 나간 한 조각이 이번 주 월요일 13:00 창에서 4시간 반 차이로 빠지고,
      // 뿌리를 지난주부터만 보면 그 전 주 물음에 지난주 달린 답이 안 보인다 — persona 는 「답은
      // 다음 주까지 온다」고 하는데 정작 그 답을 못 읽는다(검토 2026-09-21). 스레드 답글은 뿌리
      // 글을 거쳐야 읽히므로 뿌리는 넓게 훑고 답은 날짜로 거른다.
      const since = mondayOf(now, 1).getTime() / 1000;
      const oldest = String(Math.floor(mondayOf(now, 3).getTime() / 1000));
      const msgs: MessageLike[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < HISTORY_PAGES; page++) {
        // 슬랙은 새 것부터 주므로 한 장으로 끊으면 **가장 오래된 뿌리(지난주 월요일 한 조각)부터** 떨어진다.
        const hist = await client.conversations.history({ channel: room.id, oldest, limit: 200, cursor });
        msgs.push(...((hist.messages || []) as MessageLike[]));
        cursor = hist.response_metadata?.next_cursor || undefined;
        if (!cursor) break;
      }
      const lines: string[] = [];
      for (const m of msgs.reverse()) {                                // 오래된 것부터
        if (m.subtype) continue;                                       // 들어옴·나감·핀 같은 것
        const mine = m.user === me;
        if (!mine && m.bot_id) continue;                               // 다른 봇의 말 — 그 스레드도
        const fresh = Number(m.ts) >= since;
        if (!mine && m.text && fresh) lines.push(`- ${scrub(m.text)}`);
        // 답이 지난주보다 오래된 스레드는 안 연다 — `latest_reply` 가 있으면 그것으로 미리 거른다.
        if (m.reply_count && m.ts && !(m.latest_reply && Number(m.latest_reply) < since)) {
          const rep = await client.conversations.replies({ channel: room.id, ts: m.ts, limit: 50 });
          const head = scrub(m.text || '').slice(0, 30);
          for (const r of ((rep.messages || []) as MessageLike[]).slice(1)) {
            if (r.user === me || r.bot_id || !r.text || Number(r.ts) < since) continue;
            lines.push(`- (${mine ? '네 글' : '위'} 「${head}」에 단 답) ${scrub(r.text)}`);
          }
        }
      }
      if (!lines.length) return '';
      const kept = lines.slice(-RECENT_MAX_LINES);
      return `[지난주부터 ${room.label} 방에서 사람들이 한 말 — 누가 했는지는 뺐다 · 방에 공개된 말이다]\n${kept.join('\n')}`;
    } catch (error) {
      this.logger.warn(`${room.label} 방의 지난주부터를 못 읽었습니다 — 그 방은 빼고 갑니다`, error);
      return '';
    }
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
    const args = this.opts.pulseArgs ?? ['--room', this.opts.room ?? ''];
    const r = spawnSync(this.opts.python, ['-X', 'utf8', this.opts.script, ...args], {
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

  private state(): { week?: string; day?: string } {
    try {
      return JSON.parse(fs.readFileSync(this.opts.statePath, 'utf-8'));
    } catch {
      return {};
    }
  }

  private saveState(s: { week?: string; day?: string }): void {
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

/** `back` 주 전 월요일 0시(이 PC 시간). 0 이면 이번 주 월요일. 월요일이 쉬는 주여도 월요일부터. */
export function mondayOf(now: Date, back = 0): Date {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7) - 7 * back);
  return d;
}

/** 지난주 월요일 0시 — 방에서 「사람들이 한 말」을 읽기 시작하는 때. */
export function lastWeekMonday(now: Date): Date {
  return mondayOf(now, 1);
}

/** 슬랙 이력의 한 줄 — 여기서 보는 칸만. */
interface MessageLike {
  ts?: string; user?: string; bot_id?: string; subtype?: string; text?: string;
  reply_count?: number; latest_reply?: string;
}

function localDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 멘션·팀 멘션·방 링크·URL 라벨을 지우고 한 줄로. **글 속에 적힌 이름은 못 지운다**(「철수님 말대로」) —
 * 이 글은 실장에게만 가고, 방에 걸 글은 카드 쪽 이름 빗장이 막는다. 그 선을 README 에 적어 뒀다.
 */
function scrub(text: string): string {
  return text
    .replace(/<@[^>]+>/g, '@누군가')
    .replace(/<!subteam\^[^>]+>/g, '@어느 팀')
    .replace(/<![a-z]+(\|[^>]*)?>/g, '@모두')
    .replace(/<#[^|>]+\|([^>]*)>/g, '#$1')
    .replace(/<([^|>]+)\|([^>]*)>/g, '$2')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, RECENT_MAX_CHARS);
}

export { DEFAULT_AT };
