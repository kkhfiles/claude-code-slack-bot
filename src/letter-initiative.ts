import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { App } from '@slack/bolt';
import { Logger } from './logger';
import type { TurnResult } from './chat-host';

/**
 * 커피콩이 **스스로 움직이는** 시계 — 평일 아침 한 번, 현황판을 들고 커피챗 방에 먼저 말을
 * 걸지 정하고(수요일에는 실장에게 주간 보고도), 걸기로 했으면 빗장을 거쳐 올린다.
 *
 * 실장 결정(2026-09-18): 「커피챗 채널에선 주체적으로 나서도 된다. 단 개인정보 보호만
 * 중요하게 다중 안전장치를 두라.」 그래서 이 파일은 **말을 만드는 곳이 아니라 빗장을 세는
 * 곳**이다. 말은 `turn.py` 가 만들고, 여기는 아래를 거쳐야만 방에 올린다.
 *
 *   ① 자료 층    `comm_pulse.py` 는 숫자만 낸다 — 원문·이름·아이디가 모델에 안 간다
 *   ② 안내 층    `turn.py` 의 INITIATE_NOTE — 지목·집계·원문 금지를 모델에게 이른다
 *   ③ 빗장 층 A  `privacy_gate.py`(파이썬) — 멘션·아이디·집계·원문 조각이면 침묵
 *   ④ 빗장 층 B  여기(TS) — 실원 **이름**·멘션. 자료가 다른 두 겹이라 한쪽 구멍이 다른 쪽에 걸린다
 *   ⑤ 횟수 층    하루 1번 · 주 2번 · 평일만 · 공휴일 제외
 *   ⑥ 끄는 층    `LETTER_INITIATIVE=0` 또는 실장이 말로 「자율 꺼」(control 파일)
 *   ⑦ 사본 층    **방에 올린 글은 그대로 실장 DM 으로 사본이 간다** — 「나 모르게」가 없게.
 *                막힌 것도 까닭과 함께 간다
 *
 * 어느 층도 다른 층을 믿고 느슨해지지 않는다.
 */

const DEFAULT_AT = '10:00';
const DAILY_CAP = 1;
const WEEKLY_CAP = 2;
const MAX_LEN = 1200;
/** 시각 뒤 이만큼 안에서만 돈다 — 저녁 재시작이 아침 일을 대신 하지 않게. */
const WINDOW_MIN = 120;

export interface InitiativeHost {
  initiate(client: App['client'], key: string, brief: string): Promise<TurnResult>;
  post(client: App['client'], channel: string, text: string): Promise<boolean>;
}

export interface LetterInitiativeOptions {
  /** `LETTER_INITIATIVE=1`. 기본은 꺼짐 — 만든 것과 켠 것은 다른 일이다. */
  enabled: boolean;
  /** 평일 이 시각에 한 번 (HH:MM). */
  at: string;
  /** 커피챗 방. 비면 기능이 꺼진다. */
  room: string;
  /** 실장 — 사본과 막힌 알림을 받고, 수요일 주간 보고를 받는다. 비면 기능이 꺼진다. */
  managerUserId: string;
  /** 실원 명단 — 이름 빗장에 쓴다(`users.info` 로 이름을 받아 둔다). */
  members: string[];
  python: string;
  /** `comm_pulse.py` */
  script: string;
  /** 방에 올린 기록 `initiative.jsonl` — 상한도 여기서 센다. */
  logPath: string;
  /** 오늘 돌았는지 `initiative-state.json` */
  statePath: string;
  /** 실장이 말로 끄는 값이 적히는 파일(`control.json` · `always.initiative === false` 면 꺼짐). */
  controlPath: string;
  /** 주간 보고 요일 (0=일 … 3=수). */
  reportDay: number;
  host: InitiativeHost;
  logger?: Logger;
}

export type Outcome =
  | 'off' | 'not-time' | 'done-today' | 'holiday' | 'cap' | 'no-brief'
  | 'quiet' | 'blocked' | 'spoke' | 'error';

interface Sent {
  ts: string;
  to: string;
  chars: number;
  head: string;
  sha: string;
}

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
      void this.tick(app.client).catch((error) => this.logger.warn('먼저 말 걸기에서 넘어졌습니다', error));
    }, 60 * 1000);
    this.timer.unref?.();
    this.logger.info(`준비됨 — 평일 ${this.opts.at} · 하루 ${DAILY_CAP}번 · 주 ${WEEKLY_CAP}번 · 방 ${this.opts.room} · 사본 → 실장`);
  };

  /**
   * 분마다 — 그 시각이고 오늘 아직이면 한 번 돈다. **창은 두 시간이다** — 저녁에 재시작하면
   * 「10:00 이 지났으니」 그 자리에서 도는 일이 없게. 놓친 날은 그냥 넘어간다.
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

    // 수요일 — 실장에게 주간 보고. 방에 말 거는 것과 따로 센다(상한은 방 것만).
    if (now.getDay() === this.opts.reportDay) await this.report(client, pulse.brief);

    const { today, week } = this.counts(now);
    if (today >= DAILY_CAP || week >= WEEKLY_CAP) {
      this.logger.info(`상한 — 오늘 ${today}번 · 이번 주 ${week}번. 안 겁니다`);
      return 'cap';
    }

    let result: TurnResult;
    try {
      result = await this.opts.host.initiate(client, this.opts.room, pulse.brief);
    } catch (error) {
      this.logger.warn('먼저 말 걸기 턴이 깨졌습니다', error);
      return 'error';
    }
    if (result.error) {
      this.logger.warn(`먼저 말 걸기 턴 실패: ${result.error}`);
      return 'error';
    }
    if (result.blocked?.length) {
      // 파이썬 빗장이 막았다 — 실장에게 까닭을 알린다(글은 안 보낸다 · 막힌 글이다).
      await this.tell(client, `:no_entry_sign: 커피챗 방에 먼저 말을 걸려다 *빗장에 막혔습니다* — ${result.blocked.join(' · ')}\n_아무것도 안 나갔습니다._`);
      return 'blocked';
    }
    const text = (result.reply || '').trim();
    if (result.speak === false || !text) {
      this.logger.info('오늘은 안 걸기로 했습니다');
      return 'quiet';
    }
    const hit = await this.nameHit(client, text);
    if (hit || text.length > MAX_LEN) {
      const why = hit ? `실원 이름·지목(「${hit}」)` : `너무 김(${text.length}자)`;
      this.logger.warn(`호스트 빗장에 막힘 — ${why}`);
      await this.tell(client, `:no_entry_sign: 커피챗 방에 먼저 말을 걸려다 *빗장에 막혔습니다* — ${why}\n_아무것도 안 나갔습니다._`);
      return 'blocked';
    }
    const posted = await this.opts.host.post(client, this.opts.room, text);
    if (!posted) return 'error';
    this.note({ ts: now.toISOString(), to: this.opts.room, chars: text.length,
                head: text.slice(0, 30), sha: sha16(text) });
    this.logger.info(`커피챗 방에 먼저 말을 걸었습니다 (${text.length}자)`);
    // ⑦ 사본 — 방에 올린 글 그대로. 「나 모르게」가 없게 하는 층이다.
    await this.tell(client, `:speech_balloon: 커피챗 방에 먼저 말을 걸었습니다 (오늘 ${today + 1}번째 · 이번 주 ${week + 1}번째)\n${text.split('\n').map((l) => `> ${l}`).join('\n')}`);
    return 'spoke';
  }

  // ── 실장 주간 보고 ───────────────────────────────────────────────────────
  private async report(client: App['client'], brief: string): Promise<void> {
    try {
      const r = await this.opts.host.initiate(client, this.opts.managerUserId, brief);
      const text = (r.reply || '').trim();
      if (r.error || !text) {
        this.logger.warn(`주간 보고 턴 실패: ${r.error || '빈 답'}`);
        return;
      }
      await this.tell(client, `:clipboard: *주간 현황 (커피콩)*\n${text}`);
    } catch (error) {
      this.logger.warn('주간 보고에서 넘어졌습니다', error);
    }
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

  private counts(now: Date): { today: number; week: number } {
    const day = localDay(now);
    const monday = new Date(now);
    monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
    const weekStart = localDay(monday);
    let today = 0; let week = 0;
    for (const past of this.history()) {
      const d = localDay(new Date(past.ts));
      if (d === day) today++;
      if (d >= weekStart) week++;
    }
    return { today, week };
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
      this.logger.warn('실장에게 알리지 못했습니다', error);
    }
  }

  // ── 기록 ──────────────────────────────────────────────────────────────
  private note(record: Sent): void {
    try {
      fs.mkdirSync(path.dirname(this.opts.logPath), { recursive: true });
      fs.appendFileSync(this.opts.logPath, `${JSON.stringify(record)}\n`, 'utf-8');
    } catch (error) {
      this.logger.warn('기록을 못 남겼습니다', error);
    }
  }

  private history(): Sent[] {
    try {
      return fs.readFileSync(this.opts.logPath, 'utf-8').trim().split('\n')
        .filter(Boolean).map((line) => JSON.parse(line) as Sent);
    } catch {
      return [];
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

const sha16 = (text: string): string =>
  crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);

function localDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export { DAILY_CAP, WEEKLY_CAP, DEFAULT_AT };
