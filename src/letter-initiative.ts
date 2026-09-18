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
 *   ③ 빗장 층 A  `privacy_gate.py` — 방에 걸 글(`pulse`)이 멘션·아이디·집계·원문 조각이면
 *                카드 자체가 안 만들어지고 실장에게 까닭만 간다
 *   ④ 빗장 층 B  여기(TS) — 실원 **이름**·멘션·길이. 자료가 다른 두 겹
 *   ⑤ 사람 층    **실장이 창에서 보고 「보내기」** — 대화·시계만으로는 방에 아무것도 안 간다
 *   ⑥ 횟수 층    평일 08:30 뒤 두 시간 창 안에서 하루 한 번 · 공휴일 제외
 *   ⑦ 끄는 층    `LETTER_INITIATIVE=0` 또는 실장이 말로 「자율 꺼」(control 파일)
 *
 * 수요일이면 같은 턴에 주간 보고(현황·눈에 띄는 것·general 제안)가 붙는다 — 안내 층이 한다.
 */

const DEFAULT_AT = '08:30';
const MAX_LEN = 1200;
/** 시각 뒤 이만큼 안에서만 돈다 — 저녁 재시작이 아침 일을 대신 하지 않게. */
const WINDOW_MIN = 120;
/** 파이썬 `control.actions` 에서 방에 걸 글의 이름. 다른 이름은 이 시계가 안 다룬다. */
const PULSE = 'pulse';

export interface InitiativeHost {
  initiate(client: App['client'], key: string, brief: string): Promise<TurnResult>;
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
  /** 실원 명단 — 이름 빗장에 쓴다(`users.info` 로 이름을 받아 둔다). */
  members: string[];
  python: string;
  /** `comm_pulse.py` */
  script: string;
  /** 오늘 돌았는지 `initiative-state.json` */
  statePath: string;
  /** 실장이 말로 끄는 값이 적히는 파일(`control.json` · `always.initiative === false` 면 꺼짐). */
  controlPath: string;
  host: InitiativeHost;
  /** 확인 카드를 띄우는 곳(`LetterNotice.offer`). 방에 걸 글은 전부 여기로만 간다. */
  offer: (client: App['client'], asks: TurnAsk[], from: { user: string; channel: string }) => Promise<void>;
  logger?: Logger;
}

export type Outcome =
  | 'off' | 'not-time' | 'done-today' | 'holiday' | 'no-brief'
  | 'quiet' | 'blocked' | 'proposed' | 'error';

export class LetterInitiative {
  private logger: Logger;
  private timer: NodeJS.Timeout | null = null;
  private names = new Map<string, string[]>();

  constructor(private readonly opts: LetterInitiativeOptions) {
    this.logger = opts.logger ?? new Logger('Letter:initiative');
  }

  get enabled(): boolean {
    return this.opts.enabled && Boolean(this.opts.room) && Boolean(this.opts.managerUserId);
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
    if (this.state().day === today) return 'done-today';
    // **먼저 적고 돈다** — 도중에 넘어져도 같은 날 두 번 돌지 않는다.
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
      result = await this.opts.host.initiate(client, this.opts.managerUserId, pulse.brief);
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

    const asks = (result.ask || []).filter((a) => a.name === PULSE);
    if (!asks.length) {
      this.logger.info(said ? '오늘은 방에 걸 글 없이 인사만' : '오늘은 조용히');
      return 'quiet';
    }
    // ④ 호스트 빗장 — 실장이 창에서 보기 전에 한 번 더. 자료가 다른 겹이다.
    const clean: TurnAsk[] = [];
    for (const ask of asks) {
      const text = (ask.text || '').trim();
      const hit = await this.nameHit(client, text);
      if (hit || text.length > MAX_LEN) {
        const why = hit ? `실원 이름·지목(「${hit}」)` : `너무 김(${text.length}자)`;
        this.logger.warn(`호스트 빗장에 막힘 — ${why}`);
        await this.tell(client, `:no_entry_sign: 방에 걸려던 글이 *빗장에 막혀 카드를 안 만들었습니다* — ${why}`);
        continue;
      }
      clean.push(ask);
    }
    if (!clean.length) return 'blocked';
    // ⑤ 사람 층 — 카드. 실장이 「보내기」를 눌러야 방에 오른다.
    await this.opts.offer(client, clean, { user: this.opts.managerUserId, channel: 'DM' });
    this.logger.info(`오늘 제안 ${clean.length}건 — 카드로 실장에게`);
    return 'proposed';
  }

  // ── 층들 ──────────────────────────────────────────────────────────────
  private switchedOff(now = new Date()): boolean {
    try {
      const raw = JSON.parse(fs.readFileSync(this.opts.controlPath, 'utf-8'));
      if (raw?.always?.initiative === false) return true;
      // 「오늘만 꺼」는 그 날짜일 때만 — 어제 걸어 둔 것이 오늘까지 먹으면 안 된다.
      return raw?.today?.initiative === false && raw?.today?.date === localDay(now);
    } catch {
      return false;
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

  /** 실원 이름(성 포함·성 뺀 것)이나 멘션이 글에 있으면 그 조각. */
  private async nameHit(client: App['client'], text: string): Promise<string> {
    const m = text.match(/<@[^>]+>/);
    if (m) return m[0];
    for (const id of this.opts.members) {
      for (const name of await this.namesOf(client, id)) {
        if (name && text.includes(name)) return name;
      }
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
        // 「강규황」→「규황」. 두 자 이름은 성을 떼면 한 자라 못 쓴다.
        if (/^[가-힣]{3,4}$/.test(name)) out.add(name.slice(1));
      }
    } catch (error) {
      this.logger.debug(`users.info 실패 (${id})`, error);
    }
    const names = [...out];
    this.names.set(id, names);
    return names;
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
      fs.writeFileSync(this.opts.statePath, JSON.stringify(s), 'utf-8');
    } catch (error) {
      this.logger.warn('상태를 못 적었습니다', error);
    }
  }
}

function localDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export { DEFAULT_AT };
