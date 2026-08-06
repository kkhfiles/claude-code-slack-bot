import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { App } from '@slack/bolt';
import { Logger } from './logger';

/**
 * agy 위에 얹은 슬랙 대화 계층. **봇 여러 개가 이 한 클래스를 같이 쓴다.**
 *
 * 각 봇은 자기 슬랙 앱(=자기 정체성과 토큰)을 쓰므로 소켓 연결도 따로 연다.
 * **한 앱에는 연결 하나뿐이다** — 자리가 늘어도 호스트를 더 만들지 않는다.
 * 말을 만드는 일은 외부 파이썬(`turn.py`)이 하고 여기는 슬랙 쪽만 맡는다 —
 * 그 이음매 덕에 대화는 워크스페이스 없이도 시험할 수 있다.
 *
 * 자리는 두 가지고, **한 봇이 둘 다 열 수 있다**(`surfaces`).
 *   - `dm`      개인이 봇과 1:1 로 말한다. 대화 열쇠 = 사람
 *   - `channel` 여러 사람이 있는 방에 봇이 상주한다. 대화 열쇠 = 방
 *
 * 시간이 걸려서 생기는 문제는 전부 이쪽 몫이다.
 *   - 🤔 를 부른 메시지에 붙였다가 답하면서 뗀다. 성공이든 실패든 반드시 뗀다.
 *   - 한 번 답하는 데 10초쯤 걸린다(모델이 아니라 agy 기동 시간이라 모델을 바꿔도 안 빨라진다).
 *     그 사이 들어온 말은 "처리 중"이라 하지 않고 **모아서 다음 답에 합친다.**
 *   - 전체 동시 실행은 **봇을 통틀어** 3개까지.
 */

/** 동시 실행은 봇마다가 아니라 **PC 전체로** 센다. agy 는 한 번에 여러 개가 무겁다. */
let globalRunning = 0;
const CONCURRENCY_CAP = 3;

const MAX_MERGED_LINES = 20;
const TURN_TIMEOUT_MS = 150 * 1000;   // turn.py 가 agy 를 90초에 끊고, 그 위에 여유
const THINKING = 'thinking_face';
/**
 * 훑을 때 채널을 얼마나 거슬러 읽나. 하루 종일 조용하다 한 마디 올라온 자리에서
 * 어제 얘기까지 끌어오지 않게 잘라 둔다. 봇이 그 사이 말을 했으면 어차피 거기서 끊긴다.
 */
const SWEEP_LOOKBACK_MS = 30 * 60 * 1000;

const BUSY_TEXT = '지금 다른 얘기를 듣고 있어서 조금만 기다려 주세요. 끝나는 대로 바로 답할게요.';
const FAIL_TEXT = '죄송해요, 지금은 답을 못 만들겠어요. 잠시 뒤에 다시 말 걸어 주시겠어요?';
const NOT_YET_TEXT = '아직 준비 중이에요. 조금만 기다려 주세요 🙂';

/**
 * 채널에서 **먼저** 말을 걸 조건.
 *
 * 양이 아니라 **내용**으로 거른다. "새 말이 N개 쌓이면"으로 재면 "뭐 맛있는 거 없나?"
 * 같은 한 마디짜리 순간을 놓친다 — 그 사이 대화는 이미 지나가 있다. 사람이라면 그 한
 * 마디에 바로 대답하지, 넉 줄이 쌓일 때까지 기다리지 않는다.
 *
 * 판단하는 길은 둘이다.
 *
 *   낱말(`interest`)  걸리면 **그 자리에서** 바로 — 싸고 빠르다
 *   훑기(`sweepMinutes`)  몇 분마다 **쌓인 말을 통째로** 모델에게 보여 주고 물어본다
 *
 * 훑기가 필요한 이유: 「애가 됐네」·「신분이 내시인가요」처럼 **앞 글을 가리키는 말**은
 * 어떤 낱말 목록으로도 못 잡는데, 정작 그런 자리가 봇이 껴야 할 자리다(실측: 안 부른
 * 글 11건 중 6건이 그 종류였고 낱말을 늘려도 여전히 안 걸렸다). 한 줄만 보면 못 풀고
 * 대화를 봐야 풀린다.
 *
 * 나머지 둘은 수다스러움을 막는 굴레다.
 */
export interface ButtInRule {
  quietMinutes: number;   // 마지막으로 입을 연 지 이만큼은 조용히
  dailyCap: number;       // 하루 이만큼까지만
  sweepMinutes?: number;  // 이만큼마다 쌓인 말을 통째로 보고 낄지 다시 본다 (0=끔)
}

export interface ChatBotOptions {
  name: string;           // turn.py 의 봇 이름이자 로그 이름
  botToken: string;
  appToken: string;
  python: string;
  script: string;         // turn.py 경로
  /**
   * 이 봇이 여는 자리. **둘 다여도 연결은 하나다.**
   *
   * 자리마다 호스트를 하나씩 두면 같은 앱에 소켓이 두 번 열리고, 슬랙은 들어온 것을
   * 연결 하나에만 주므로 **부름의 절반이 흔적 없이 사라진다**(2026-08-06에 반나절을
   * 태운 사고). 그래서 자리는 여기서 늘리고 연결은 안 늘린다.
   */
  surfaces: Array<'dm' | 'channel'>;
  allowUsers?: string[];  // dm: 여기 적힌 사람만. **비면 아무도 못 쓴다**
  managerUserId?: string;
  channels?: string[];    // channel: 여기 적힌 방에서만
  buttIn?: ButtInRule | null;   // channel: null 이면 불렀을 때만 답한다
  /**
   * 같은 슬랙 앱에 **대화가 아닌 기능**을 얹을 자리(레터의 칭찬 전달).
   *
   * 앱 하나에 소켓을 두 번 열면 안 된다 — 슬랙은 들어온 것을 연결 하나에만 주므로,
   * 명령이 핸들러 없는 쪽으로 가면 조용히 실패한다. 그래서 이 앱을 그대로 넘긴다.
   */
  attach?: (app: App) => void;
}

interface Waiting {
  channel: string;
  threadTs?: string;
  texts: string[];
  reactTs: string[];
  toldBusy: boolean;
  /** 이미 담은 글의 ts. 훑기가 채널에서 다시 읽어 와도 같은 말을 두 번 안 담게. */
  seen: Set<string>;
}

interface TurnResult {
  reply: string;
  speak?: boolean;
  error: string | null;
  elapsed_s?: number;
}

export class ChatHost {
  private app: App | null = null;
  private logger: Logger;
  private selfUserId = '';
  /** 이 봇이 관심 있는 화제. 여기 안 걸리면 **그 자리에서는** 말을 걸지 않는다. */
  private interest: RegExp | null = null;
  /** 쌓인 말을 주기적으로 훑어보는 타이머. */
  private sweeper: NodeJS.Timeout | null = null;

  /** 지금 턴이 도는 열쇠 — 그쪽으로 새로 온 말은 뒤에 줄서지 않고 합쳐진다. */
  private active = new Set<string>();
  /** 말했지만 아직 답하지 않은 것, 열쇠별로. */
  private pending = new Map<string, Waiting>();
  /** 채널에서 우리가 마지막으로 입을 연 시각·횟수. */
  private lastSpoke = new Map<string, number>();
  private spokenToday = new Map<string, { day: string; count: number }>();
  /** 한 사람에게 한 번만 알린다 — 지나가던 사람이 같은 말을 반복해 듣지 않게. */
  private toldNotYet = new Set<string>();
  /** 아직 초대 안 된 방 — 같은 말을 1분마다 찍지 않으려고 한 번만 알린다. */
  private toldNotInChannel = new Set<string>();
  private names = new Map<string, string>();

  constructor(private readonly opts: ChatBotOptions) {
    this.logger = new Logger(`Chat:${opts.name}`);
  }

  private get servesDm(): boolean { return this.opts.surfaces.includes('dm'); }
  private get servesChannel(): boolean { return this.opts.surfaces.includes('channel'); }
  /**
   * 이 대화 열쇠가 DM 인가. **열쇠 자체가 안다** — DM 은 사람(`U…`), 채널은 방(`C…`)이라
   * 호스트 설정을 볼 필요가 없다. 한 봇이 두 자리를 다 받으므로 「이 봇은 DM 봇」 같은
   * 판단은 이제 틀린 답을 준다.
   */
  private isDmKey(key: string): boolean { return key.startsWith('U'); }

  /**
   * 이 열쇠의 답을 이 자리에 내도 되나. **개인 것은 개인 방에만.**
   *
   * 사람과의 대화(`U…`)는 개인 대화방(`D…`)으로만 나가고, 방과의 대화(`C…`)는
   * **바로 그 방으로만** 나간다. 둘이 엇갈리면 답을 버린다 — 늦게 답하는 것과
   * 엉뚱한 데 떠드는 것은 무게가 다르다.
   */
  private canSay(key: string, channel: string): boolean {
    return this.isDmKey(key) ? channel.startsWith('D') : channel === key;
  }

  async start(): Promise<void> {
    if (this.app) return;
    const app = new App({
      token: this.opts.botToken, appToken: this.opts.appToken, socketMode: true,
    });

    this.interest = this.loadInterest();

    // 대화 말고 다른 것을 얹을 것이 있으면 **소켓을 열기 전에** 붙인다.
    if (this.opts.attach) {
      try {
        this.opts.attach(app);
      } catch (error) {
        this.logger.warn('attach 실패 — 대화는 그대로 뜹니다', error);
      }
    }

    app.event('message', async ({ event, client }) => {
      try {
        await this.onEvent(client, event as unknown as Record<string, unknown>);
      } catch (error) {
        this.logger.warn('Failed to handle a message', error);
      }
    });

    try {
      await app.start();
      this.app = app;
      // 채널에서는 자기를 부른 것인지 알아야 한다. 멘션은 본문에 <@봇ID> 로 들어온다.
      try {
        const me = await app.client.auth.test();
        this.selfUserId = (me.user_id as string) ?? '';
      } catch (error) {
        this.logger.warn('auth.test failed — mentions will not be recognised', error);
      }
      const every = this.opts.buttIn?.sweepMinutes ?? 0;
      if (this.servesChannel && this.opts.buttIn && every > 0) {
        // **비동기라 try/catch 로는 못 잡는다** — 채널을 읽어 오는 사이에 나는 실패는
        // 되돌아온 약속(promise)에 담겨 오므로 거기서 받아야 타이머가 안 죽는다.
        this.sweeper = setInterval(() => {
          void this.sweep().catch((error) =>
            this.logger.warn('훑어보다 넘어졌습니다', error));
        }, every * 60 * 1000);
        this.sweeper.unref?.();
      }
      const where: string[] = [];
      if (this.servesDm) where.push(`DM ${this.opts.allowUsers?.length ?? 0}명 허용`);
      if (this.servesChannel) {
        where.push(`채널 ${this.opts.channels?.length ?? 0}곳, 먼저 말 걸기 ${
          this.opts.buttIn ? `on · ${every > 0 ? `${every}분마다 훑어봄` : '낱말만'}` : 'off'}`);
      }
      // **연결 수를 같이 찍는다** — 자리가 둘인데 연결도 둘이면 그게 사고다.
      this.logger.info(`listening (연결 1개 · ${where.join(' + ') || '자리 없음'})`);
    } catch (error) {
      this.logger.warn('failed to start', error);
    }
  }

  /**
   * 봇 프로필(`bots/<이름>/config.json`)의 `interest` 를 읽어 하나의 패턴으로 만든다.
   * 파이썬 쪽과 **같은 파일**을 본다 — 봇의 성격을 정하는 것이 두 군데로 갈리면
   * 한쪽만 고쳐 놓고 왜 안 되는지 찾게 된다.
   */
  private loadInterest(): RegExp | null {
    if (!this.servesChannel) return null;
    const configPath = path.join(
      path.dirname(this.opts.script), 'bots', this.opts.name, 'config.json');
    try {
      const words = JSON.parse(fs.readFileSync(configPath, 'utf-8'))?.interest;
      if (!Array.isArray(words) || words.length === 0) return null;
      const escaped = words.map((w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      this.logger.info(`관심 낱말 ${escaped.length}개를 읽었습니다`);
      return new RegExp(escaped.join('|'));
    } catch (error) {
      this.logger.warn(`관심 낱말을 못 읽었습니다 (${configPath}) — 먼저 말 걸기는 화제를 안 가립니다`, error);
      return null;
    }
  }

  async stop(): Promise<void> {
    if (this.sweeper) {
      clearInterval(this.sweeper);
      this.sweeper = null;
    }
    if (!this.app) return;
    try {
      await this.app.stop();
    } catch (error) {
      this.logger.warn('failed to stop', error);
    }
    this.app = null;
  }

  private async onEvent(client: App['client'], m: Record<string, unknown>): Promise<void> {
    const channel = m.channel as string | undefined;
    const user = m.user as string | undefined;
    const ts = m.ts as string | undefined;
    const text = ((m.text as string) ?? '').trim();
    // 편집·입퇴장 알림과 봇이 한 말은 사람의 발화가 아니다.
    if (m.subtype || m.bot_id || !channel || !user || !ts || !text) return;
    if (user === this.selfUserId) return;

    // **어느 자리인지는 들어온 것이 정한다.** 호스트의 설정으로 가르면 자리가 늘 때마다
    // 호스트를(그러니까 연결을) 하나 더 열게 된다 — 그게 소켓 이중 연결 사고의 뿌리다.
    if (m.channel_type === 'im') {
      if (!this.servesDm) return;
      await this.onDirectMessage(client, user, channel, ts, text);
      return;
    }
    if (!this.servesChannel) return;
    if (!(this.opts.channels ?? []).includes(channel)) return;
    await this.onChannelMessage(client, user, channel, ts,
      m.thread_ts as string | undefined, text);
  }

  // ── DM ────────────────────────────────────────────────────────────────
  private async onDirectMessage(
    client: App['client'], user: string, channel: string, ts: string, text: string,
  ): Promise<void> {
    // 명단이 비면 아무도 아니다. 실제 워크스페이스에 사는 봇이라 기본값은 침묵이어야 한다.
    if (!(this.opts.allowUsers ?? []).includes(user)) {
      this.logger.info(`Ignoring DM from ${user} (not on the allowlist)`);
      if (!this.toldNotYet.has(user)) {
        this.toldNotYet.add(user);
        await this.say(client, channel, NOT_YET_TEXT);
      }
      return;
    }
    this.enqueue(user, { channel, text, ts });
    await this.react(client, 'add', channel, ts);
    this.kick(client, user, channel, true);
  }

  // ── 채널 ──────────────────────────────────────────────────────────────
  private async onChannelMessage(
    client: App['client'], user: string, channel: string, ts: string,
    threadTs: string | undefined, text: string,
  ): Promise<void> {
    const called = text.includes(`<@${this.selfUserId}>`);
    // **바로 반응할 자리에서만 담는다.** 나머지는 훑기가 채널에서 직접 읽어 온다 —
    // 여기서 다 쌓아 두면 재시작 한 번에 통째로 사라지고, 소켓이 흘린 말은 애초에
    // 담기지도 않는다. 둘 다 실제로 겪었다.
    if (!called && !this.shouldButtIn(channel, text)) return;

    const name = await this.displayName(client, user);
    // 방에서는 누가 한 말인지가 곧 맥락이다. 한 줄에 이름을 붙여 넘긴다.
    this.enqueue(channel, {
      channel, threadTs, ts,
      text: `${name || user}: ${text}`,
      // 부른 것이 아니면 🤔 를 붙이지 않는다 — 방 사람들의 모든 말에 이모지가 붙는다.
      react: called,
    });

    if (called) {
      await this.react(client, 'add', channel, ts);
      this.kick(client, channel, channel, true);
      return;
    }
    // 낱말이 걸린 자리 — 훑기를 기다리지 않고 그 자리에서 묻는다.
    this.kick(client, channel, channel, false);
  }

  /**
   * 먼저 말을 걸어도 되는 자리인가. 여기서 통과해야 모델에게 낄지 물어본다.
   *
   * **자기 얘기가 아니면 바로 빠진다** — 그 판단은 낱말로 하는 것이 싸고 확실하다.
   * 매번 모델에게 물으면 한 번에 10초씩 걸리고 쿼터도 금방 마른다.
   */
  private shouldButtIn(channel: string, text: string): boolean {
    if (this.interest && !this.interest.test(text)) return false;
    return this.withinLimits(channel);
  }

  /** 낱말과 무관한 굴레만. 훑기도 같은 굴레를 쓴다 — 길이 둘이어도 한도는 하나다. */
  private withinLimits(channel: string): boolean {
    const rule = this.opts.buttIn;
    if (!rule || this.active.has(channel)) return false;
    const since = Date.now() - (this.lastSpoke.get(channel) ?? 0);
    if (since < rule.quietMinutes * 60 * 1000) return false;
    const day = new Date().toISOString().slice(0, 10);
    const seen = this.spokenToday.get(channel);
    const count = seen && seen.day === day ? seen.count : 0;
    return count < rule.dailyCap;
  }

  /**
   * 몇 분마다 한 번, **쌓인 말을 통째로 보고** 낄지 모델에게 묻는다.
   *
   * 새 말이 없으면 아무것도 하지 않는다 — 조용한 시간에는 모델을 안 부른다.
   * 모델이 안 끼기로 하면 쌓인 말은 그 턴에서 비워지므로, 같은 대화를 두고
   * 몇 분마다 되묻지 않는다.
   */
  private async sweep(): Promise<void> {
    const client = this.app?.client;
    if (!client) return;
    for (const channel of this.opts.channels ?? []) {
      if (!this.withinLimits(channel)) continue;
      try {
        await this.sweepChannel(client, channel);
      } catch (error) {
        this.logger.warn(`훑어보다 넘어졌습니다 (${channel})`, error);
      }
    }
  }

  /**
   * 방을 **채널에서 직접 읽어** 훑는다. 메모리에 쌓아 둔 것을 보지 않는다.
   *
   * 쌓아 두면 **재시작 한 번에 방금 오간 대화를 통째로 잊는다** — 실제로 그렇게
   * 잊었고, 사람들이 「파업 ㅋㅋ」 하는 동안 봇은 볼 것이 없었다. 소켓이 이벤트를
   * 흘려도 마찬가지다(그것도 실제로 겪었다). 채널을 읽으면 둘 다 저절로 따라잡힌다.
   *
   * 어디부터 보나: **봇이 마지막으로 말한 뒤**의 사람 글만. 기준을 채널이 들고 있으니
   * 따로 기억할 것이 없고, 이미 답한 말을 다시 집지도 않는다.
   */
  private async sweepChannel(client: App['client'], channel: string): Promise<void> {
    let res;
    try {
      res = await client.conversations.history({
        channel,
        oldest: ((Date.now() - SWEEP_LOOKBACK_MS) / 1000).toFixed(6),
        limit: 60,
      });
    } catch (error) {
      // **아직 방에 초대되지 않았다** — 설정에 방을 적어 두고 초대는 나중에 하는 것이
      // 정상 순서다. 그동안 1분마다 실패를 찍으면 로그가 그것으로 덮인다. 한 번만
      // 알리고 조용히 기다린다(초대되면 저절로 풀린다).
      if (String((error as { data?: { error?: string } })?.data?.error) === 'not_in_channel') {
        if (!this.toldNotInChannel.has(channel)) {
          this.toldNotInChannel.add(channel);
          this.logger.info(`${channel} 에 아직 초대되지 않았습니다 — 초대되면 훑기가 시작됩니다`);
        }
        return;
      }
      throw error;
    }
    this.toldNotInChannel.delete(channel);
    const msgs = ((res.messages ?? []) as Record<string, unknown>[]).slice().reverse();

    let after: Record<string, unknown>[] = [];
    for (const m of msgs) {
      // 봇이 입을 연 자리에서 끊는다 — 그 앞은 이미 지나간 이야기다.
      if (m.bot_id || m.user === this.selfUserId) { after = []; continue; }
      if (m.subtype || !((m.text as string) ?? '').trim()) continue;
      after.push(m);
    }
    if (after.length === 0) return;

    for (const m of after.slice(-MAX_MERGED_LINES)) {
      const user = m.user as string;
      const name = await this.displayName(client, user);
      this.enqueue(channel, {
        channel, ts: m.ts as string,
        text: `${name || user}: ${(m.text as string).trim()}`,
        react: false,      // 부른 것이 아니다 — 🤔 를 붙이지 않는다
      });
    }
    const waiting = this.pending.get(channel);
    if (!waiting || waiting.texts.length === 0) return;
    this.logger.info(`훑어보는 중 (${channel}, ${waiting.texts.length}줄)`);
    this.kick(client, channel, channel, false);
  }

  private noteSpoke(key: string): void {
    this.lastSpoke.set(key, Date.now());
    const day = new Date().toISOString().slice(0, 10);
    const seen = this.spokenToday.get(key);
    this.spokenToday.set(key, {
      day, count: seen && seen.day === day ? seen.count + 1 : 1,
    });
  }

  // ── 공통 ──────────────────────────────────────────────────────────────
  /**
   * 대기열에 넣는다. **중간에 기다리는 구간이 없어야 한다** — 사람은 두 줄을 연달아
   * 보내는데, 읽고 쓰는 사이에 기다림이 끼면 두 번째 말이 첫 번째를 덮어써서
   * 첫 줄이 사라지고 그 메시지의 🤔 도 영영 남는다.
   */
  private enqueue(key: string, item: {
    channel: string; text: string; ts: string; threadTs?: string; react?: boolean;
  }): void {
    const waiting = this.pending.get(key)
      ?? { channel: item.channel, texts: [], reactTs: [], toldBusy: false, seen: new Set<string>() };
    if (waiting.seen.has(item.ts)) return;      // 훑기가 다시 읽어 온 같은 말
    waiting.seen.add(item.ts);
    waiting.channel = item.channel;
    if (item.threadTs) waiting.threadTs = item.threadTs;
    // 답을 기다리는 동안 말이 계속 쌓일 수 있다. 최근 것만 남긴다 — 끝없이 합치면
    // agy 를 띄우는 명령줄 길이 한도에 걸려 답하는 대신 실패한다.
    if (waiting.texts.length >= MAX_MERGED_LINES) waiting.texts.shift();
    waiting.texts.push(item.text);
    if (item.react !== false) waiting.reactTs.push(item.ts);
    this.pending.set(key, waiting);
  }

  private kick(client: App['client'], key: string, channel: string, forced: boolean): void {
    if (this.active.has(key)) return;   // 도는 중이면 합쳐진다
    if (globalRunning >= CONCURRENCY_CAP) {
      const waiting = this.pending.get(key);
      // 방에서는 "기다려 달라"고 하지 않는다. 부르지도 않았는데 시끄럽다.
      if (forced && this.isDmKey(key) && waiting && !waiting.toldBusy) {
        waiting.toldBusy = true;
        void this.say(client, channel, BUSY_TEXT);
      }
      return;
    }
    void this.pump(client, key, forced);
  }

  /** 한 열쇠에 대해 새 말이 없어질 때까지 턴을 돈다. */
  private async pump(client: App['client'], key: string, forced: boolean): Promise<void> {
    this.active.add(key);
    globalRunning += 1;
    try {
      for (;;) {
        const waiting = this.pending.get(key);
        if (!waiting || waiting.texts.length === 0) break;
        this.pending.delete(key);

        // **개인에게 갈 말이 방으로 나가는 일은 없어야 한다.** 지금 구조로는 답이 그 말이
        // 들어온 자리로만 가지만, 한 봇이 DM 과 채널을 같이 받게 된 이상 이건 지켜지길
        // 바라는 성질이 아니라 **못 어기게 막을 성질**이다. 앞으로 누가 이 언저리를
        // 고치다 어긋내면 새는 대신 여기서 걸린다.
        if (!this.canSay(key, waiting.channel)) {
          this.logger.warn(
            `자리가 어긋나 답을 버렸습니다 (열쇠 ${key} → ${waiting.channel})`);
          break;
        }

        const merged = waiting.texts.join('\n');
        let result: TurnResult;
        try {
          result = await this.runTurn(key, await this.displayName(client, key), merged, !forced);
        } catch (error) {
          this.logger.warn('Turn crashed', error);
          result = { reply: '', error: String(error) };
        } finally {
          for (const ts of waiting.reactTs) {
            await this.react(client, 'remove', waiting.channel, ts);
          }
        }

        if (result.error) {
          this.logger.warn(`Turn failed for ${key}: ${result.error}`);
          if (forced) await this.say(client, waiting.channel, FAIL_TEXT, waiting.threadTs);
        } else if (result.speak === false || !result.reply) {
          // 먼저 말 걸 자리가 아니라고 스스로 판단했다. 조용히 넘어간다.
          this.logger.info(`Stayed quiet in ${key}`);
        } else {
          this.logger.info(`Answered ${key} in ${result.elapsed_s ?? '?'}s`);
          await this.say(client, waiting.channel, result.reply, waiting.threadTs);
          this.noteSpoke(key);
        }
        // 먼저 말 거는 턴은 한 번만 돈다. 남은 말은 다음 조건이 찰 때 본다.
        if (!forced) break;
      }
    } finally {
      this.active.delete(key);
      globalRunning -= 1;
      this.drain(client);
    }
  }

  /** 자리가 났다 — 기다리던 사람을 집어 든다. */
  private drain(client: App['client']): void {
    for (const key of this.pending.keys()) {
      if (globalRunning >= CONCURRENCY_CAP) return;
      if (this.active.has(key)) continue;
      const waiting = this.pending.get(key);
      // 채널에서 조용히 쌓이던 것은 자리가 났다고 발화하지 않는다 — 조건은 따로다.
      if (!this.isDmKey(key) && !waiting?.toldBusy && !waiting?.reactTs.length) continue;
      void this.pump(client, key, true);
    }
  }

  /** 슬랙이 이름을 안다 — 파이썬 쪽이 명단을 들고 있을 이유가 없다. */
  private async displayName(client: App['client'], user: string): Promise<string> {
    if (!user.startsWith('U')) return '';   // 채널 열쇠는 사람이 아니다
    const cached = this.names.get(user);
    if (cached !== undefined) return cached;
    let name = '';
    try {
      const res = await client.users.info({ user });
      const profile = res.user?.profile as { display_name?: string; real_name?: string } | undefined;
      name = profile?.display_name || profile?.real_name || res.user?.real_name || '';
    } catch (error) {
      this.logger.debug('users.info failed', error);
    }
    this.names.set(user, name);
    return name;
  }

  private runTurn(key: string, name: string, text: string, decide: boolean): Promise<TurnResult> {
    const payload = JSON.stringify({
      bot: this.opts.name,
      key,
      user: key.startsWith('U') ? key : '',
      user_name: name,
      role: key === this.opts.managerUserId ? 'manager' : 'member',
      // 같은 봇이 DM 과 채널을 다 받으므로 **어느 자리인지 알려준다.** 둘의 태도가
      // 달라야 하는데(DM 은 조심스럽게, 채널은 앞장서서) 프롬프트가 그걸 모르면
      // 한쪽에 맞춘 성격이 다른 쪽에서 어긋난다.
      where: this.isDmKey(key) ? 'dm' : 'channel',
      decide,
      text,
    });

    return new Promise<TurnResult>((resolve) => {
      const child = spawn(this.opts.python, ['-X', 'utf8', this.opts.script], {
        cwd: path.dirname(this.opts.script),
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
        windowsHide: true,
      });

      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

      const killTimer = setTimeout(() => child.kill(), TURN_TIMEOUT_MS);

      child.on('error', (error) => {
        clearTimeout(killTimer);
        resolve({ reply: '', error: `spawn 실패: ${error.message}` });
      });

      child.on('close', () => {
        clearTimeout(killTimer);
        // 종료 코드는 판정 근거가 아니다 — turn.py 는 실패도 JSON 안에 적어 내보낸다.
        const line = stdout.trim().split('\n').filter(Boolean).pop() ?? '';
        try {
          resolve(JSON.parse(line) as TurnResult);
        } catch {
          resolve({ reply: '', error: `응답 파싱 실패: ${(line || stderr).slice(-300)}` });
        }
      });

      child.stdin.write(payload, 'utf-8');
      child.stdin.end();
    });
  }

  private async say(
    client: App['client'], channel: string, text: string, threadTs?: string,
  ): Promise<void> {
    try {
      await client.chat.postMessage({ channel, text, thread_ts: threadTs });
    } catch (error) {
      this.logger.warn('Failed to post a message', error);
    }
  }

  /** 이모지는 장식이다 — 여기서 실패해도 답이 가라앉으면 안 된다. */
  private async react(
    client: App['client'], op: 'add' | 'remove', channel: string, ts: string,
  ): Promise<void> {
    try {
      if (op === 'add') {
        await client.reactions.add({ channel, timestamp: ts, name: THINKING });
      } else {
        await client.reactions.remove({ channel, timestamp: ts, name: THINKING });
      }
    } catch (error) {
      this.logger.debug(`reactions.${op} failed`, error);
    }
  }
}
