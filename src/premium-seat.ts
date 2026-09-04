import { spawn } from 'child_process';
import { App } from '@slack/bolt';
import { Logger } from './logger';

/**
 * Premium 좌석 관리 — 슬랙 표면.
 *
 * 이 모듈은 화면과 타이머만 맡는다. 상태·매칭·판정은 전부 파이썬 도메인이 하고,
 * 여기서는 명령을 부르고 결과를 슬랙에 옮긴다. 좌석을 바꾸는 경로는 없다 —
 * 실제 변경은 관리자가 관리 화면에서 직접 한다.
 *
 * 설계 정본: D:/management/ai-premium-seat-manager/premium-seat-manager-design.md
 */

export interface PremiumSeatOptions {
  python: string;
  workerDir: string;
  channelId: string;
  managerUserIds: string[];
  openToTeam: boolean;
  /** 파이썬에 넘길 환경변수. 설정 정본은 이쪽이 아니라 프로세스 환경이다. */
  env?: NodeJS.ProcessEnv;
  jobPollSeconds?: number;
  /** 시험용. 채우면 팀원 DM 이 전부 이 사람에게 간다. 운영에서는 비운다. */
  dmRedirectTo?: string;
}

interface Envelope {
  ok: boolean;
  operation_id?: string | null;
  entity?: { type?: string; id?: string; state?: string; service?: string; auto_execute?: boolean };
  result?: any;
  applied?: any;
  jobs_created?: string[];
  swaps_created?: string[];
  dashboard_dirty?: boolean;
  error?: { code: string; message: string; retryable: boolean };
}

const SERVICE_LABEL: Record<string, string> = {
  CHATGPT: 'ChatGPT Business',
  CLAUDE: 'Claude Team',
};

const SERVICE_ICON: Record<string, string> = {
  CHATGPT: ':speech_balloon:',
  CLAUDE: ':sparkles:',
};

/** 두 열로 나란히 놓으므로 서비스 이름은 짧은 쪽을 쓴다. */
const SERVICE_SHORT: Record<string, string> = {
  CHATGPT: 'ChatGPT',
  CLAUDE: 'Claude',
};

/**
 * 좌석 상태 기호는 두 벌이고 몫이 다르다.
 * 눈금(색)은 몇 석인지 한눈에 세는 몫, 이름 앞 기호는 뜻을 싣는 몫이다.
 * 범례에서 둘을 한 항목으로 묶어 같은 뜻을 두 번 설명하지 않는다.
 */
const KEEP_ICON = '\u{1F512}';   // 자물쇠 · 유지 필요
const GIVE_ICON = '\u{1F91D}';   // 악수 · 양도 가능
const KEEP_TICK = '\u{1F7E6}';   // 파란 눈금
const GIVE_TICK = '\u{1F7E9}';   // 초록 눈금
const SWAP_ICON = '\u{1F504}';   // 바꾸는 중
const WAIT_ICON = '\u{23F3}';    // 기다리는 사람
const CLOCK_ICON = '\u{1F553}';

/** 라디오에서 「바꾸지 않음」을 나타내는 값. 슬랙이 빈 문자열을 안 받는다. */
const KEEP_AS_IS = '__keep__';

const SELF_TITLE = 'Premium 요청';

const TIER_LABEL: Record<string, string> = {
  PREMIUM: 'Premium',
  STANDARD: '스탠다드',
  NONE: '좌석 없음',
};

/**
 * 서울 기준 `09/02 16:32`. ko-KR 기본 서식은 `26. 9. 2. 오후 4:32` 로 나와
 * 좁은 범례 줄에서 자리를 많이 먹고 읽기도 나쁘다.
 */
function seoulStamp(ms: number): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Seoul',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(ms));
  const at = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${at('month')}/${at('day')} ${at('hour')}:${at('minute')}`;
}

const SWAP_STATE_LABEL: Record<string, string> = {
  AWAITING_ADMIN: '실장 승인 대기',
  HELD: '실장 보류 중',
  APPLYING: '실장이 바꾸는 중',
  NEEDS_ADMIN: ':warning: 실장 확인 필요',
};

/** 오류 코드마다 고정 한글 문구. 파이썬 message 를 그대로 노출하지 않는다 (§13.4). */
const ERROR_TEXT: Record<string, string> = {
  NOT_A_MEMBER: '대응표에 등록되지 않은 사용자입니다. 실장에게 알려 주세요.',
  ALREADY_REQUESTED: '이미 요청이 들어가 있습니다.',
  ALREADY_PREMIUM: '이미 Premium 좌석을 쓰고 계십니다.',
  NOT_PREMIUM: 'Premium 좌석 보유자만 바꿀 수 있습니다.',
  STALE_SNAPSHOT: '좌석 상태를 확인하는 중입니다. 잠시 뒤 다시 눌러 주세요.',
  SWAP_IN_PROGRESS: '이미 양도가 진행 중입니다. 실장에게 문의해 주세요.',
  NO_ACTIVE_REQUEST: '진행 중인 요청이 없습니다.',
  SERVICE_LOCKED: '해당 서비스는 실장 확인 중입니다.',
  BAD_REQUEST: '요청을 이해하지 못했습니다.',
  OPERATION_RUNNING: '앞선 요청을 처리하는 중입니다. 잠시 뒤 다시 눌러 주세요.',
  NOT_A_MANAGER: '실장만 할 수 있는 일입니다.',
  NOT_OPEN: '아직 준비 중입니다. 실장이 열면 쓰실 수 있습니다.',
  NO_SEAT: '이 서비스에 좌석이 없어 Premium 교환 대상이 아닙니다. 실장에게 스탠다드 좌석을 먼저 요청해 주세요.',
  SOURCE_DECLARED: '이 서비스는 실장이 직접 반영합니다. 따로 확인할 것이 없습니다.',
  SOURCE_UNAVAILABLE: '아직 준비되지 않은 방식입니다. 실장에게 알려 주세요.',
};

const SWAP_ACTION_DONE: Record<string, string> = {
  start: '양도를 시작했습니다. 관리 화면에서 바꾸신 뒤 「완료했습니다」를 눌러 주세요.',
  hold: '보류했습니다. 좌석도 양도 의사도 그대로입니다. 나중에 다시 알려 드립니다.',
  complete: '좌석 변경을 반영했습니다.',
  abort: '이 교환을 멈췄습니다.',
  verify: '실제 상태를 다시 확인하도록 예약했습니다.',
};

const SWAP_ACTION_FAILED: Record<string, string> = {
  NOT_A_MANAGER: '관리자만 누를 수 있습니다.',
  NOT_STARTABLE: '이미 처리된 교환입니다.',
  NOT_HOLDABLE: '이미 시작한 교환입니다. 「이 교환 중단」을 쓰세요.',
  NOT_COMPLETABLE: '이미 처리된 교환입니다.',
  NOT_ABORTABLE: '멈출 수 있는 상태가 아닙니다.',
  NEEDS_VERIFY: '실제 상태를 읽어 확인하는 중입니다. 잠시 뒤 결과가 옵니다.',
  NOT_FOUND: '없는 교환 번호입니다.',
};

const TIMEOUT_STATE_MS = 10_000;
/**
 * 창을 띄우기 전 읽기에만 쓰는 짧은 기한.
 *
 * 쓰기에는 안 쓴다 — 시한이 지나면 파이썬을 죽이는데, 좌석을 바꾸는 명령을
 * 도중에 죽이면 무엇까지 반영됐는지 알 수 없다. 창에 답하는 기한은 아래
 * `MODAL_DEADLINE_MS` 가 따로 재고, 일 자체는 끝까지 돈다.
 */
const MODAL_RUN_MS = 2_000;
const MODAL_DEADLINE_MS = 2_400;

/** 창에 그대로 띄울 처리 결과. */
interface Outcome {
  ok: boolean;
  lines: string[];
}
const TIMEOUT_READ_MS = 90_000;
const TIMEOUT_SWAP_MS = 300_000;

export class PremiumSeatSlack {
  private logger = new Logger('PremiumSeat');
  private app: App | null = null;
  private timers: NodeJS.Timeout[] = [];
  private children = new Set<ReturnType<typeof spawn>>();
  private registered = false;
  private jobBusy = false;
  private dashboardPending: NodeJS.Timeout | null = null;
  private notifyPending: NodeJS.Timeout | null = null;
  private notifiedExpiredServices = new Set<string>();
  private loginBusy = new Set<string>();
  private lastSessionCheckAt = 0;

  constructor(private opts: PremiumSeatOptions) {}

  // ------------------------------------------------------------- 등록
  register(app: App): void {
    // 인스턴스마다 한 벌만 — 두 벌이면 타이머가 겹쳐 같은 작업을 두 번 집는다.
    if (this.registered) {
      this.logger.warn('register() called twice; timers stay as they are');
      return;
    }
    this.registered = true;
    this.app = app;

    app.action('premium_request_open', async ({ ack, body, client }) => {
      await ack();
      await this.openModal(client, body, 'request');
    });
    // 실장 전용 창은 더보기 메뉴에 둔다. 버튼 줄에 같이 놓으면 팀원 셋에게
    // 자기가 못 쓰는 버튼이 하나 늘어난다.
    app.action('premium_more', async ({ ack, body, client, action }) => {
      await ack();
      const val = (action as any)?.selected_option?.value;
      if (val === 'check_session') {
        const user = this.userOf(body);
        if (!this.isManager(user)) {
          await this.onlyYou(body, '실장만 쓸 수 있습니다.');
          return;
        }
        await this.onlyYou(body, '소인, 관리자 세션 상태를 점검하고 있사옵니다. 잠시 후 DM으로 결과를 올리겠사옵니다.');
        void this.checkSessionsAndNotify(user);
      } else {
        await this.openModal(client, body, 'admin');
      }
    });
    // 관리자 브라우저 원클릭 로그인
    app.action('premium_open_login_browser', async ({ ack, body, action }) => {
      await ack();
      const service = (action as any)?.value as string;
      const user = this.userOf(body);
      if (!this.isManager(user)) {
        await this.onlyYou(body, '관리자만 로그인 창을 열 수 있습니다.');
        return;
      }
      void this.launchInteractiveLogin(service, body);
    });
    // 알림 글의 한 번 누르기 — 누른 사람 자신을 양도 가능으로 바꾼다.
    app.action('premium_offer', async ({ ack, body, action }) => {
      await ack();
      void this.offerSeat(body, (action as any).value as string);
    });
    app.action('premium_my_status', async ({ ack, body, client }) => {
      await ack();
      void this.openMyStatus(client, body);
    });
    // 창 안의 요청 취소. 누른 자리에서 창을 다시 그린다.
    app.action('premium_request_cancel', async ({ ack, body, action, client }) => {
      await ack();
      void this.cancelFromModal(client, body, (action as any).value as string);
    });

    // 제출 결과를 그 창에 그대로 보여 준다. 창에서 한 일의 답이 DM 으로 가면
    // 어디를 봐야 하는지 알 수 없다. 슬랙은 제출 뒤 3초 안에 답해야 하므로
    // 늦어지면 안내만 띄우고 나머지는 뒤에서 마저 돌린다.
    app.view('premium_request_submit', async ({ ack, body, view }) => {
      const work = this.handleRequest(body.user.id, this.picked(view, 'service'));
      await ack(await this.resultAck('Premium 요청', work, body.user.id));
    });
    app.view('premium_my_status', async ({ ack, body, view }) => {
      await ack(await this.resultAck('내 상태 확인 및 변경', this.saveWishes(body.user.id, view), body.user.id));
    });
    app.view('premium_admin_submit', async ({ ack, body, view }) => {
      const work = this.handleAvailability(body.user.id, {
        service: this.picked(view, 'service'),
        target: this.picked(view, 'target') || body.user.id,
        tier: this.picked(view, 'tier'),
        status: this.picked(view, 'status'),
        request: this.picked(view, 'request'),
        quiet: this.checked(view, 'quiet'),
      });
      await ack(await this.resultAck('좌석·상태 고치기', work, body.user.id));
    });

    // 관리자 버튼. 누른 사람이 관리자인지는 파이썬이 다시 본다 — 화면만 믿지 않는다.
    app.action(/^premium_swap_(start|hold|complete|abort|verify)$/, async ({ ack, body, action }) => {
      await ack();
      const actionId = (action as any).action_id as string;
      const swapId = (action as any).value as string;
      void this.handleSwapAction(actionId.replace('premium_swap_', ''), swapId, body);
    });

    const jobEvery = (this.opts.jobPollSeconds ?? 10) * 1000;
    this.every(60_000, () => this.pumpNudges());
    this.every(jobEvery, () => this.pumpJobs());
    this.every(60_000, () => this.pumpNotifications());
    this.every(60_000, () => this.syncAnnouncements());
    this.every(60_000, () => this.scheduleReconciles());
    // 06:00~18:00 사이 2시간 간격 세션 점검
    this.every(600_000, () => this.pumpSessionCheck());
    setTimeout(() => {
      void this.pumpSessionCheck();
    }, 60_000).unref?.();

    this.logger.info('Premium seat feature attached (sharing the chat connection)');
    void this.refreshDashboard();
  }

  dispose(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    if (this.dashboardPending) clearTimeout(this.dashboardPending);
    if (this.notifyPending) clearTimeout(this.notifyPending);
    for (const child of this.children) {
      try {
        child.kill();
      } catch {
        /* 이미 끝났으면 그만이다 */
      }
    }
    this.children.clear();
    this.registered = false;
  }

  private every(ms: number, fn: () => void): void {
    const timer = setInterval(() => {
      try {
        fn();
      } catch (error) {
        this.logger.warn('timer body threw', error);
      }
    }, ms);
    timer.unref?.();
    this.timers.push(timer);
  }

  // ------------------------------------------------------------- 파이썬
  /**
   * 도메인 명령 하나를 부르고 봉투를 받는다.
   *
   * 종료 코드만 믿지 않는다 — 0 으로 끝나도 ok 가 아니면 실패로 본다(§18.1).
   */
  private run(command: string, payload: Record<string, unknown>, timeoutMs = TIMEOUT_STATE_MS): Promise<Envelope> {
    return new Promise((resolve) => {
      const child = spawn(this.opts.python, ['-X', 'utf8', '-m', 'premium_seat_manager.cli', ...command.split(' ')], {
        cwd: this.opts.workerDir,
        env: { ...process.env, ...this.opts.env, PYTHONIOENCODING: 'utf-8' },
        windowsHide: true,
      });
      this.children.add(child);

      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (c) => { stdout += c.toString(); });
      child.stderr.on('data', (c) => { stderr += c.toString(); });

      const killTimer = setTimeout(() => {
        this.logger.warn(`premium ${command} timed out after ${timeoutMs}ms`);
        child.kill();
      }, timeoutMs);

      const finish = (envelope: Envelope) => {
        clearTimeout(killTimer);
        this.children.delete(child);
        resolve(envelope);
      };

      child.on('error', (error) => {
        this.logger.warn(`premium ${command} failed to start`, error);
        finish({ ok: false, error: { code: 'SPAWN_FAILED', message: String(error), retryable: true } });
      });

      child.on('close', () => {
        const text = stdout.trim();
        if (!text) {
          this.logger.warn(`premium ${command} produced no output`, { stderr: stderr.trim() });
          finish({ ok: false, error: { code: 'NO_OUTPUT', message: stderr.trim(), retryable: true } });
          return;
        }
        try {
          finish(JSON.parse(text) as Envelope);
        } catch (error) {
          this.logger.warn(`premium ${command} output was not JSON`, { stdout: text.slice(0, 400) });
          finish({ ok: false, error: { code: 'BAD_OUTPUT', message: String(error), retryable: false } });
        }
      });

      child.stdin.write(JSON.stringify({ operation_id: cryptoRandom(), ...payload }));
      child.stdin.end();
    });
  }

  // ------------------------------------------------------------- 타이머 몫
  /** 읽기 작업을 한 건씩 집어 돌린다. 앞 작업이 살아 있으면 이번 회차는 건너뛴다. */
  private async pumpJobs(): Promise<void> {
    if (this.jobBusy) return;
    this.jobBusy = true;
    try {
      const claim = await this.run('job claim', { owner: 'slack' });
      const job = claim.result?.claimed;
      if (!job) return;
      const timeout = job.kind === 'EXECUTE_SWAP' ? TIMEOUT_SWAP_MS : TIMEOUT_READ_MS;
      const out = await this.run('job run', { job_id: job.id, lease_token: job.lease_token }, timeout);
      if (!out.ok) {
        this.logger.warn(`job run failed (${job.service})`, out.error);
      }
      if (out.dashboard_dirty) this.markDashboardDirty();
    } finally {
      this.jobBusy = false;
    }
  }

  /** 때가 된 재알림 회차를 만든다. 회차 시각이 고유 키라 두 번 생기지 않는다. */
  private async pumpNudges(): Promise<void> {
    const out = await this.run('nudge tick', {});
    if (out.dashboard_dirty) this.markDashboardDirty();
  }

  /** 대기 중인 알림을 보낸다. 보내기 직전에 아직 보낼 것이 맞는지 다시 본다. */
  private async pumpNotifications(): Promise<void> {
    const claim = await this.run('notification claim', { owner: 'slack', limit: 10 });
    const rows: any[] = claim.result?.claimed ?? [];
    for (const row of rows) {
      const check = await this.run('notification validate', { id: row.id, lease_token: row.lease_token });
      if (!check.result?.send) continue;
      try {
        const posted = await this.postNotification(row);
        await this.run('notification ack', {
          id: row.id,
          lease_token: row.lease_token,
          channel: posted?.channel,
          ts: posted?.ts,
        });
      } catch (error) {
        this.logger.warn(`notification ${row.kind} failed`, error);
        await this.run('notification fail', { id: row.id, lease_token: row.lease_token, error: String(error) });
      }
    }
  }

  /** 관측이 오래되면 확인을 예약한다. 이미 대기 중이면 파이썬이 새로 만들지 않는다. */
  private async scheduleReconciles(): Promise<void> {
    const model = await this.run('dashboard model', {});
    const services = model.result?.services ?? {};
    const maxAge = model.result?.snapshot_max_age_minutes ?? 60;
    for (const [service, view] of Object.entries<any>(services)) {
      // DECLARED 는 바깥을 안 읽는다. 그런데도 예약하면 30분마다 작업이 서고
      // 돌자마자 SOURCE_DECLARED 로 실패한다 — 실측으로 실패 6건이 쌓여 있었다.
      if (view.source === 'DECLARED') continue;
      const observed = view.observed_at ? Date.parse(view.observed_at) : 0;
      const ageMin = observed ? (Date.now() - observed) / 60000 : Number.POSITIVE_INFINITY;
      if (ageMin >= maxAge) await this.run('reconcile enqueue', { service });
    }
  }

  // ------------------------------------------------------------- 화면
  /**
   * 줄 세운 알림을 곧바로 보낸다.
   *
   * 60초 타이머만 믿으면 승인 요청이 최대 1분 뒤에 뜬다. 사람이 방금 누른 일의
   * 결과가 1분 뒤에 오면 고장 난 것처럼 보인다. 짧게 모았다가 한 번 보낸다.
   */
  private kickNotifications(): void {
    if (this.notifyPending) return;
    this.notifyPending = setTimeout(() => {
      this.notifyPending = null;
      void this.pumpNotifications();
    }, 400);
    this.notifyPending.unref?.();
  }

  private markDashboardDirty(): void {
    this.kickNotifications();
    // 2초 동안 여러 신호를 모아 한 번만 갱신한다 (§18.3).
    if (this.dashboardPending) return;
    this.dashboardPending = setTimeout(() => {
      this.dashboardPending = null;
      void this.refreshDashboard();
      void this.syncAnnouncements();
    }, 2000);
    this.dashboardPending.unref?.();
  }

  /**
   * 현황판을 다시 그린다.
   *
   * `bump` 면 같은 자리를 고치지 않고 방 맨 아래에 새로 올린 뒤 옛 메시지를 지운다.
   * 고치기만 하면 알림이 안 울리고, 아래에 다른 글이 쌓이면 현황판이 위로 밀려
   * 스크롤해야 보인다. 기다리는 사람이 생겼을 때만 옮긴다 — 매번 옮기면 그게 소음이다.
   */
  async refreshDashboard(bump = false): Promise<{ channel: string; ts: string } | null> {
    if (!this.app) return null;
    const model = await this.run('dashboard model', {});
    if (!model.ok) return null;
    const blocks = this.dashboardBlocks(model.result);
    const text = 'AI Premium 좌석 현황';
    const saved = model.result?.message;
    const channel = this.opts.channelId;

    if (!bump && saved?.ts) {
      try {
        await this.app.client.chat.update({ channel: saved.channel ?? channel, ts: saved.ts, text, blocks });
        return { channel: saved.channel ?? channel, ts: saved.ts };
      } catch (error) {
        this.logger.warn('dashboard update failed; posting a new one', error);
      }
    }

    let posted;
    try {
      posted = await this.app.client.chat.postMessage({ channel, text, blocks });
    } catch (error) {
      this.logger.warn('dashboard post failed', error);
      return null;
    }
    if (!posted?.ts) return null;
    await this.run('dashboard placed', { channel, ts: posted.ts });

    // 옛 현황판을 지운다. 남겨 두면 갱신 안 되는 현황판이 둘이 된다.
    if (saved?.ts && saved.ts !== posted.ts) {
      try {
        await this.app.client.chat.delete({ channel: saved.channel ?? channel, ts: saved.ts });
      } catch (error) {
        this.logger.warn('old dashboard delete failed', error);
      }
    }
    return { channel, ts: posted.ts as string };
  }

  /**
   * 현황판 블록. Standard 는 넣지 않는다 — 이 도구가 다루는 것은 Premium 좌석뿐이다.
   *
   * 두 서비스를 좌우 두 열로 놓고, 열마다 눈금 · 좌석 수 · 보유자를 쌓는다.
   * 범례는 화면에 실제로 있는 기호만 설명한다.
   */
  private dashboardBlocks(model: any): any[] {
    const maxAge = model?.snapshot_max_age_minutes ?? 60;
    const blocks: any[] = [
      { type: 'header', text: { type: 'plain_text', text: '\u{1F3AB} AI Premium 좌석', emoji: true } },
    ];

    const fields: any[] = [];
    const moving: string[] = [];
    const waitingLines: string[] = [];
    const waitingServices: string[] = [];
    const warnings: string[] = [];
    const seenBy: Array<{ short: string; seen: string; declared: boolean }> = [];

    for (const key of ['CHATGPT', 'CLAUDE']) {
      const view = model?.services?.[key];
      if (!view) continue;
      const short = SERVICE_SHORT[key] ?? key;
      const holders: any[] = view.premium ?? [];
      const waiting: string[] = view.waiting ?? [];

      const gauge = holders
        .map((h) => (h.availability === 'TRANSFERABLE' ? GIVE_TICK : KEEP_TICK))
        .join('');
      const names = holders.length
        ? holders
            .map((h) => `${h.availability === 'TRANSFERABLE' ? GIVE_ICON : KEEP_ICON} ${h.display_name}`)
            .join('\n')
        : '보유자 없음';
      const lock = view.locked ? '\n:warning: 실장 확인 중' : '';
      fields.push({
        type: 'mrkdwn',
        text: `${SERVICE_ICON[key] ?? ''} *${short}*${lock}\n${gauge}\nPremium *${holders.length}명*\n\n${names}`,
      });

      if (view.swap) {
        moving.push(
          `${SWAP_ICON} *${short}*  ${view.swap.from_name} \u2192 ${view.swap.to_name}  \u00b7  ` +
            `${SWAP_STATE_LABEL[view.swap.state] ?? view.swap.state}`,
        );
      }
      if (waiting.length) {
        waitingLines.push(`${WAIT_ICON} *${short}*  ${waiting.join(' \u00b7 ')} 님이 기다립니다`);
        waitingServices.push(key);
      }

      const observed = view.observed_at ? Date.parse(view.observed_at) : 0;
      // DECLARED 는 대조할 바깥 정본이 없어 낡을 일이 없다.
      const stale = view.source !== 'DECLARED' && (!observed || (Date.now() - observed) / 60000 >= maxAge);
      if (stale) warnings.push(`:warning: *${short}* 확인 지연`);
      if (view.unknown_email_count) warnings.push(`:warning: *${short}* 대응표 미등록 ${view.unknown_email_count}명`);
      seenBy.push({ short, seen: observed ? seoulStamp(observed) : '없음', declared: view.source === 'DECLARED' });
    }

    if (fields.length) blocks.push({ type: 'section', fields });

    if (moving.length || waitingLines.length) {
      blocks.push({ type: 'divider' });
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: [...moving, ...waitingLines].join('\n') } });
    }
    if (waitingServices.length) {
      // 기다리는 사람이 있을 때만 나온다. 방 전체에 던지는 부탁이라 여기 둔다.
      // 요청한 사람 한 명만 쓰는 취소는 「내 상태 확인 및 변경」 창 안에 있다 — 현황판은 방에
      // 하나뿐인 메시지라 보는 사람마다 다르게 그릴 수 없고, 한 사람용 버튼을
      // 열 명에게 보이면 그것이 소음이다.
      blocks.push({
        type: 'actions',
        elements: waitingServices.map((key) =>
          this.button(
            waitingServices.length > 1 ? `${SERVICE_SHORT[key]} 좌석 양보` : '제 좌석 양보하겠습니다',
            'premium_offer',
            'primary',
            key,
          ),
        ),
      });
    }
    if (warnings.length) {
      blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: warnings.join('  \u00b7  ') }] });
    }

    // 내용과 범례 사이의 구분선.
    blocks.push({ type: 'divider' });

    // 버튼은 늘 보인다. 팀에 열기 전이면 실장이 아닌 사람이 눌렀을 때 안내만 간다 —
    // 현황판은 방에 하나뿐인 메시지라 보는 사람마다 다르게 그릴 수 없다.
    blocks.push({
      type: 'actions',
      elements: [
        this.button('Premium 요청', 'premium_request_open', 'primary'),
        // 보기와 바꾸기를 한 창으로 합쳤다. Premium 좌석이 있으면 그 창에서
        // 바로 양도 의사를 고르고, 요청이 있으면 거기서 취소한다.
        this.button('내 상태 확인 및 변경', 'premium_my_status'),
        {
          type: 'overflow',
          action_id: 'premium_more',
          options: [
            { text: { type: 'plain_text', text: '좌석·상태 고치기 (실장)' }, value: 'admin' },
            { text: { type: 'plain_text', text: '관리자 세션 점검 (실장)' }, value: 'check_session' },
          ],
        },
      ],
    });
    if (!this.opts.openToTeam) {
      blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: '아직 준비 중입니다. 지금은 실장만 쓸 수 있습니다.' }],
      });
    }

    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: this.legend(moving, waitingLines, seenBy) }] });
    return blocks;
  }

  /** 범례 — 화면에 있는 기호만 설명한다. 좌석 상태 두 항목은 눈금이 늘 쓰므로 항상 넣는다. */
  private legend(
    moving: string[],
    waitingLines: string[],
    seenBy: Array<{ short: string; seen: string; declared: boolean }>,
  ): string {
    const items = [`${KEEP_TICK}${KEEP_ICON} 유지 필요`, `${GIVE_TICK}${GIVE_ICON} 양도 가능`];
    // 승인 대기·보류도 이 기호로 뜬다. 「바꾸는 중」이라고 적으면
    // 아무것도 안 바뀐 교환까지 움직이는 것처럼 읽힌다.
    if (moving.length) items.push(`${SWAP_ICON} 좌석 교환`);
    if (waitingLines.length) items.push(`${WAIT_ICON} 기다리는 사람`);

    // DECLARED 는 바깥을 읽지 않는다. 그때 이 시각은 「언제 확인했나」가 아니라
    // 「좌석이 마지막으로 바뀐 때」다 — 「기준」이라고만 적으면 요청만 오간 날에도
    // 화면이 낡은 것처럼 읽힌다.
    const head = seenBy.every((x) => x.declared) ? '좌석 마지막 변경' : '확인';
    const times = new Set(seenBy.map((x) => x.seen));
    const when =
      times.size === 1
        ? `${[...times][0]}`
        : seenBy.map((x) => `${x.short} ${x.seen}`).join('  \u00b7  ');
    return `${items.join('  \u00b7  ')}\n${CLOCK_ICON} ${head} ${when}`;
  }

  // --------------------------------------------------------- 기다리는 사람
  /**
   * 기다리는 사람이 새로 생겼으면 현황판을 방 맨 아래로 옮긴다.
   *
   * 현황판은 같은 메시지를 고쳐 쓰므로 알림이 안 울린다. 방을 안 보는 사람에게는
   * 아무 일도 안 일어난 것과 같아서, 그 사실만은 한 번 떠 줘야 한다. 요청 한 건에
   * 한 번만 옮긴다 — 이미 옮긴 요청은 다시 옮기지 않는다.
   */
  private async syncAnnouncements(): Promise<void> {
    if (!this.app) return;
    const out = await this.run('announce pending', {});
    if (!out.ok) return;

    for (const item of out.result?.to_close ?? []) {
      await this.run('announce closed', { request_id: item.request_id });
    }

    const fresh = out.result?.to_post ?? [];
    if (!fresh.length) return;
    const placed = await this.refreshDashboard(true);
    if (!placed) return;
    for (const item of fresh) {
      await this.run('announce placed', {
        request_id: item.request_id,
        channel: placed.channel,
        ts: placed.ts,
      });
    }
  }

  /** 알림 글의 한 번 누르기. 누른 사람이 그 서비스 Premium 보유자라야 한다. */
  private async offerSeat(body: any, service: string): Promise<void> {
    if (!(await this.openToMe(body))) return;
    const user = this.userOf(body);
    const out = await this.run('availability set', {
      service,
      slack_user_id: user,
      status: 'TRANSFERABLE',
    });
    if (!out.ok) return void this.onlyYou(body, this.errorText(out));
    const r = out.result ?? {};
    if (!r.changed) return void this.onlyYou(body, this.errorText(out, r.reason));
    const swapped = (out.swaps_created ?? []).length > 0;
    await this.onlyYou(
      body,
      `고맙습니다. ${SERVICE_LABEL[service] ?? service} 좌석을 「양도 가능」으로 바꿨습니다.` +
        (swapped ? ' 기다리던 분과 이어졌고 실장이 확인합니다.' : ''),
    );
    if (out.dashboard_dirty) this.markDashboardDirty();
  }

  private button(label: string, actionId: string, style?: 'primary' | 'danger', value?: string): any {
    const b: any = { type: 'button', text: { type: 'plain_text', text: label, emoji: true }, action_id: actionId };
    if (style) b.style = style;
    if (value) b.value = value;
    return b;
  }

  /**
   * 팀에 열기 전이면 실장 말고는 못 쓴다.
   *
   * 현황판은 방에 하나뿐이라 버튼을 감출 수 없으니, 누른 뒤에 여기서 막는다.
   * 좌석을 건드리는 길은 전부 이 문을 지난다 — 창 열기든 한 번 누르기든.
   */
  private async openToMe(body: any): Promise<boolean> {
    if (this.opts.openToTeam || this.isManager(this.userOf(body))) return true;
    // 누른 그 방에서 그 사람에게만 보이는 쪽지로 답한다 — DM 으로 보내면
    // 버튼을 누른 곳과 답이 오는 곳이 갈린다.
    await this.onlyYou(body, '아직 준비 중입니다. 실장이 열면 쓰실 수 있습니다.');
    return false;
  }

  private async openModal(client: any, body: any, kind: 'request' | 'admin'): Promise<void> {
    const user = this.userOf(body);
    const manager = this.isManager(user);
    if (kind === 'admin' && !manager) {
      await this.onlyYou(body, '「좌석·상태 고치기」는 실장만 쓸 수 있습니다.');
      return;
    }
    if (!(await this.openToMe(body))) return;

    const view = kind === 'admin' ? await this.adminView(user) : await this.requestView(user);
    try {
      await client.views.open({ trigger_id: body.trigger_id, view });
    } catch (error) {
      this.logger.warn('views.open failed', error);
    }
  }

  /**
   * 「Premium 요청」 창. 그 사람의 실제 좌석을 보고 짓는다.
   *
   * 할 수 없는 일을 물어본 뒤 제출에서 거절하면, 사람은 무엇이 잘못됐는지 모른 채
   * 창을 두 번 연다. 고를 것이 하나면 묻지 않고, 없으면 왜 없는지 적는다.
   */
  private async requestView(userId: string): Promise<any> {
    const out = await this.run('my status', { slack_user_id: userId }, MODAL_RUN_MS);
    if (!out.ok) return this.noticeView(SELF_TITLE, { ok: false, lines: [this.errorText(out)] });
    const services = out.result?.services ?? {};

    const usable: string[] = [];
    const reasons: string[] = [];
    for (const key of ['CHATGPT', 'CLAUDE']) {
      const view = services[key];
      if (!view) continue;
      const name = SERVICE_LABEL[key] ?? key;
      if (view.request) reasons.push(`*${name}* — 이미 요청이 들어가 있습니다`);
      else if (view.tier === 'PREMIUM') reasons.push(`*${name}* — 이미 Premium 을 쓰고 계십니다`);
      else if (view.tier !== 'STANDARD') reasons.push(`*${name}* — 좌석이 없어 교환 대상이 아닙니다`);
      else usable.push(key);
    }

    if (!usable.length) {
      return this.noticeView(SELF_TITLE, {
        ok: false,
        lines: [...reasons, '', '좌석이 없으시면 실장에게 스탠다드 좌석을 먼저 요청해 주세요.'],
      });
    }

    const blocks: any[] = [];
    if (usable.length === 1) {
      // 고를 것이 하나뿐이면 묻지 않는다. 무엇에 대한 창인지만 적는다.
      const key = usable[0];
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `${SERVICE_ICON[key] ?? ''} *${SERVICE_LABEL[key] ?? key}*` },
      });
    } else {
      blocks.push(this.radio('service', '서비스', usable.map((key) => ({
        label: SERVICE_LABEL[key] ?? key,
        value: key,
      }))));
    }

    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: '양도 가능한 좌석이 나오면 순서대로 이어 드립니다.' }],
    });
    if (reasons.length) {
      blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: reasons.join('  ·  ') }] });
    }

    return {
      type: 'modal',
      callback_id: 'premium_request_submit',
      // 서비스를 안 물었을 때 어느 서비스인지는 여기 실어 보낸다.
      private_metadata: usable.length === 1 ? usable[0] : '',
      title: { type: 'plain_text', text: SELF_TITLE },
      submit: { type: 'plain_text', text: '요청' },
      blocks,
    };
  }

  private async adminView(user: string): Promise<any> {
    const blocks: any[] = [this.radio('service', '서비스', [
      { label: 'ChatGPT Business', value: 'CHATGPT' },
      { label: 'Claude Team', value: 'CLAUDE' },
    ])];
    const roster = await this.roster(user);
    if (roster.length) blocks.push(this.select('target', '대상', roster));
    blocks.push(this.radio('tier', '좌석 배정', [
      { label: '바꾸지 않음', value: '' },
      { label: 'Premium', value: 'PREMIUM' },
      { label: '스탠다드', value: 'STANDARD' },
      { label: '좌석 없음', value: 'NONE' },
    ], true));
    blocks.push(this.radio('request', '요청', [
      { label: '바꾸지 않음', value: '' },
      { label: '이 사람 대신 요청 넣기', value: 'CREATE' },
      { label: '이 사람의 요청 취소', value: 'CANCEL' },
    ], true));
    blocks.push(this.radio('status', '양도 의사', [
      { label: '바꾸지 않음', value: '' },
      { label: '유지 필요', value: 'REQUIRED' },
      { label: '양도 가능', value: 'TRANSFERABLE' },
    ], true));
    blocks.push(this.quietBlock());
    return {
      type: 'modal',
      callback_id: 'premium_admin_submit',
      title: { type: 'plain_text', text: '좌석·상태 고치기' },
      submit: { type: 'plain_text', text: '변경' },
      blocks,
    };
  }

  /** 대상 고르기에 넣을 명단. 부르는 사람을 맨 위에 둔다. */
  private async roster(self: string): Promise<Array<{ label: string; value: string }>> {
    const out = await this.run('members list', {});
    const rows: any[] = out.result?.members ?? [];
    const seatOf = (m: any) => {
      const bits = ['CHATGPT', 'CLAUDE']
        .filter((k) => m.seats?.[k] && m.seats[k] !== 'NONE')
        .map((k) => `${SERVICE_SHORT[k]} ${m.seats[k] === 'PREMIUM' ? 'Premium' : 'Std'}`);
      return bits.length ? ` (${bits.join(' · ')})` : '';
    };
    return rows
      .sort((a, b) => (a.slack_user_id === self ? -1 : b.slack_user_id === self ? 1 : 0))
      .map((m) => ({
        label: `${m.display_name}${m.slack_user_id === self ? ' · 나' : ''}${seatOf(m)}`.slice(0, 75),
        value: m.slack_user_id,
      }));
  }

  private radio(
    blockId: string,
    label: string,
    options: Array<{ label: string; value: string }>,
    optional = false,
    initial?: string,
  ): any {
    // 슬랙은 빈 값을 안 받는다. 「바꾸지 않음」은 따로 표시해 두고 읽을 때 지운다.
    const choices = options.map((o) => ({
      text: { type: 'plain_text', text: o.label },
      value: o.value || KEEP_AS_IS,
    }));
    const keep = choices.find((c) => c.value === (initial ?? KEEP_AS_IS));
    return {
      type: 'input',
      block_id: blockId,
      optional,
      label: { type: 'plain_text', text: label },
      element: {
        type: 'radio_buttons',
        action_id: 'value',
        options: choices,
        // 「바꾸지 않음」이 있으면 그것을 미리 골라 둔다 — 안 그러면 아무것도 안
        // 골라진 채로 열려 무엇이 기본인지 안 보인다.
        ...(keep ? { initial_option: keep } : {}),
      },
    };
  }

  private select(blockId: string, label: string, options: Array<{ label: string; value: string }>): any {
    const picks = options.slice(0, 100).map((o) => ({
      text: { type: 'plain_text', text: o.label },
      value: o.value,
    }));
    return {
      type: 'input',
      block_id: blockId,
      label: { type: 'plain_text', text: label },
      element: {
        type: 'static_select',
        action_id: 'value',
        options: picks,
        // 본인을 미리 골라 둔다 — 대상은 필수인데 기본이 없으면 매번 찾아 눌러야 한다.
        ...(picks.length ? { initial_option: picks[0] } : {}),
      },
    };
  }

  private quietBlock(): any {
    return {
      type: 'input',
      block_id: 'quiet',
      optional: true,
      label: { type: 'plain_text', text: '알림' },
      element: {
        type: 'checkboxes',
        action_id: 'value',
        options: [{ text: { type: 'plain_text', text: '당사자에게 알리지 않음' }, value: 'quiet' }],
      },
    };
  }

  // ------------------------------------------------------------- 처리
  /** 「Premium 요청」 — 늘 본인 몫이다. */
  /**
   * 제출 결과를 창으로 돌려준다.
   *
   * 슬랙은 `view_submission` 에 3초 안에 답하라고 요구한다. 파이썬 호출은 한 번에
   * 0.1초쯤이라 보통 넉넉하지만, 늦어질 때 아무 답도 못 하면 창에 슬랙의 기본
   * 오류가 뜬다. 그래서 기한을 두고, 넘기면 안내 화면을 띄운 뒤 나머지는 계속 돌린다.
   */
  private async resultAck(title: string, work: Promise<Outcome>, userId: string): Promise<any> {
    const late: Outcome = { ok: true, lines: ['처리하고 있습니다. 현황판이 곧 바뀝니다.'] };
    const outcome = await Promise.race([
      work,
      new Promise<Outcome>((resolve) => setTimeout(() => resolve(late), MODAL_DEADLINE_MS)),
    ]);
    if (outcome === late) {
      // 창은 이미 닫혔다. 늦게 끝난 일이 실패였으면 그때는 DM 말고는 알릴 길이 없다.
      void work.then((real) => {
        if (!real.ok) void this.dm(userId, real.lines.join('\n'));
      });
    }
    return { response_action: 'update', view: this.noticeView(title, outcome) };
  }

  private noticeView(title: string, outcome: Outcome): any {
    const mark = outcome.ok ? ':white_check_mark:' : ':warning:';
    return {
      type: 'modal',
      callback_id: 'premium_notice',
      title: { type: 'plain_text', text: title },
      close: { type: 'plain_text', text: '닫기' },
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: `${mark} ${outcome.lines.join('\n')}` } },
      ],
    };
  }

  /** 「Premium 요청」 — 늘 본인 몫이다. */
  private async handleRequest(userId: string, service: string): Promise<Outcome> {
    const out = await this.run('request create', { service, slack_user_id: userId });
    if (!out.ok) return { ok: false, lines: [this.errorText(out)] };
    const r = out.result ?? {};
    if (!r.created) return { ok: false, lines: [this.errorText(out, r.reason)] };

    if (out.dashboard_dirty) this.markDashboardDirty();
    const swapped = (out.swaps_created ?? []).length > 0;
    return {
      ok: true,
      lines: [
        `*${SERVICE_LABEL[service]}* Premium 요청을 넣었습니다.`,
        swapped ? '양도자를 찾았고 실장 승인을 기다립니다.' : '양도 가능한 좌석이 나오면 알려 드립니다.',
        // 취소 버튼을 현황판에서 뺐으니 어디에 있는지는 여기서 알려 준다.
        '취소하시려면 현황판의 「내 상태 확인 및 변경」을 눌러 주세요.',
      ],
    };
  }

  /**
   * 좌석 배정 · 요청 · 양도 의사를 한 창에서 받는다.
   *
   * 요청 취소 → 좌석 배정 → 요청 넣기 → 양도 의사 차례다. 대기 요청이 교환까지
   * 잡아 두었으면 먼저 닫아야 좌석 배정이 안 막히고, 좌석을 준 뒤라야 대신 넣는
   * 요청이 `NO_SEAT` 에 안 걸리며, 스탠다드인 사람은 양도 가능으로 못 둔다.
   */
  private async handleAvailability(
    actor: string,
    form: { service: string; target: string; tier: string; status: string; request: string; quiet: boolean },
  ): Promise<Outcome> {
    const { service, target } = form;
    const done: string[] = [];
    const fail = (out: Envelope, reason?: string): Outcome => ({
      ok: false,
      lines: done.length ? [...done, `:warning: ${this.errorText(out, reason)}`] : [this.errorText(out, reason)],
    });

    if (form.request === 'CANCEL') {
      const out = await this.run('request cancel', { service, slack_user_id: target, actor, quiet: form.quiet });
      if (!out.ok) return fail(out);
      const r = out.result ?? {};
      if (!r.cancelled) return fail(out, r.reason);
      done.push('요청을 취소했습니다.');
      if (out.dashboard_dirty) this.markDashboardDirty();
    }

    if (form.tier) {
      const out = await this.run('seat set', { service, slack_user_id: target, tier: form.tier, actor });
      if (!out.ok) return fail(out);
      done.push(`좌석 배정을 「${TIER_LABEL[form.tier] ?? form.tier}」로 바꿨습니다.`);
      if (out.dashboard_dirty) this.markDashboardDirty();
    }

    if (form.request === 'CREATE') {
      const out = await this.run('request create', { service, slack_user_id: target, actor, quiet: form.quiet });
      if (!out.ok) return fail(out);
      const r = out.result ?? {};
      if (!r.created) return fail(out, r.reason);
      const swapped = (out.swaps_created ?? []).length > 0;
      done.push('요청을 대신 넣었습니다.' + (swapped ? ' 양도자를 찾았고 승인을 기다립니다.' : ''));
      if (out.dashboard_dirty) this.markDashboardDirty();
    }

    if (form.status) {
      const out = await this.run('availability set', { service, slack_user_id: target, status: form.status, actor, quiet: form.quiet });
      if (!out.ok) return fail(out);
      const r = out.result ?? {};
      if (!r.changed) return fail(out, r.reason);
      const label = form.status === 'TRANSFERABLE' ? '양도 가능' : '유지 필요';
      const swapped = (out.swaps_created ?? []).length > 0;
      done.push(`양도 의사를 「${label}」로 바꿨습니다.` + (swapped ? ' 기다리던 분과 이어졌고 실장 승인을 기다립니다.' : ''));
      if (out.dashboard_dirty) this.markDashboardDirty();
    }

    if (!done.length) return { ok: false, lines: ['바꿀 것을 하나도 고르지 않으셨습니다.'] };
    const who = target === actor ? '' : '해당 팀원의 ';
    return { ok: true, lines: [`${who}*${SERVICE_LABEL[service]}*`, ...done] };
  }

  /** 「내 상태 확인 및 변경」 — DM 이 아니라 창으로 띄운다. 누른 사람만 본다. */
  private async openMyStatus(client: any, body: any): Promise<void> {
    // 읽기만 하던 창이 이제 양도 의사도 바꾼다 — 열기 전에는 실장만 쓴다.
    if (!(await this.openToMe(body))) return;
    const user = this.userOf(body);
    const view = await this.myStatusView(user);
    try {
      await client.views.open({ trigger_id: body.trigger_id, view });
    } catch (error) {
      this.logger.warn('views.open failed', error);
    }
  }

  /** 창 안에서 요청을 취소하고 그 창을 다시 그린다. */
  private async cancelFromModal(client: any, body: any, service: string): Promise<void> {
    const user = this.userOf(body);
    const out = await this.run('request cancel', { service, slack_user_id: user });
    const note = out.ok && out.result?.cancelled
      ? `${SERVICE_SHORT[service] ?? service} 요청을 취소했습니다.`
      : this.errorText(out, out.result?.reason);
    if (out.dashboard_dirty) this.markDashboardDirty();
    try {
      await client.views.update({
        view_id: body.view?.id,
        view: await this.myStatusView(user, note),
      });
    } catch (error) {
      this.logger.warn('views.update failed', error);
    }
  }

  /**
   * 「내 상태 확인 및 변경」 — 보는 것과 바꾸는 것을 한 창에서 한다.
   *
   * Premium 좌석이 있으면 그 서비스마다 양도 의사 라디오가 붙고, 기다리는 요청이
   * 있으면 취소 버튼이 붙는다. 바꿀 것이 하나도 없는 사람에게는 제출 단추 없이
   * 읽는 창으로만 뜬다 — 못 하는 일을 버튼으로 보여 주지 않는다.
   */
  private async myStatusView(userId: string, note?: string): Promise<any> {
    const out = await this.run('my status', { slack_user_id: userId });
    const blocks: any[] = [];
    // 제출 때 「무엇이 바뀌었나」를 가리려면 열 때의 값이 필요하다. 안 바뀐 것까지
    // 다시 쓰면 기록만 늘고 「마지막 변경」 시각이 흔들린다.
    const before: Record<string, string> = {};

    if (!out.ok) {
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: this.errorText(out) } });
    } else {
      if (note) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `:white_check_mark: ${note}` }] });
      const services = out.result?.services ?? {};
      for (const key of ['CHATGPT', 'CLAUDE']) {
        const view = services[key];
        if (!view) continue;
        blocks.push({
          type: 'section',
          text: { type: 'mrkdwn', text: `${SERVICE_ICON[key] ?? ''} *${SERVICE_LABEL[key] ?? key}*\n${this.myLines(view).join('\n')}` },
        });
        // 교환이 걸려 있는 좌석은 못 바꾼다 — 라디오를 띄우면 눌러 놓고 거절당한다.
        if (view.tier === 'PREMIUM' && !view.swap) {
          const now = view.availability === 'TRANSFERABLE' ? 'TRANSFERABLE' : 'REQUIRED';
          before[key] = now;
          blocks.push(this.radio(`wish_${key}`, '양도 의사', [
            { label: `${KEEP_ICON} 유지 필요`, value: 'REQUIRED' },
            { label: `${GIVE_ICON} 양도 가능`, value: 'TRANSFERABLE' },
          ], false, now));
        }
        if (view.request?.status === 'WAITING') {
          blocks.push({
            type: 'actions',
            elements: [this.button('이 요청 취소', 'premium_request_cancel', 'danger', key)],
          });
        }
        blocks.push({ type: 'divider' });
      }
      blocks.pop();
    }

    const changeable = Object.keys(before).length > 0;
    return {
      type: 'modal',
      callback_id: 'premium_my_status',
      private_metadata: JSON.stringify(before),
      title: { type: 'plain_text', text: '내 상태 확인 및 변경' },
      ...(changeable ? { submit: { type: 'plain_text', text: '저장' } } : {}),
      close: { type: 'plain_text', text: '닫기' },
      blocks: blocks.length ? blocks : [{ type: 'section', text: { type: 'mrkdwn', text: '보여 드릴 것이 없습니다.' } }],
    };
  }

  /** 「내 상태 확인 및 변경」 창의 저장. 열었을 때와 달라진 좌석만 바꾼다. */
  private async saveWishes(userId: string, view: any): Promise<Outcome> {
    let before: Record<string, string> = {};
    try {
      before = JSON.parse(view?.private_metadata || '{}');
    } catch {
      before = {};
    }

    const done: string[] = [];
    for (const [key, was] of Object.entries(before)) {
      const now = view?.state?.values?.[`wish_${key}`]?.value?.selected_option?.value ?? '';
      if (!now || now === was) continue;
      const out = await this.run('availability set', { service: key, slack_user_id: userId, status: now });
      const r = out.result ?? {};
      if (!out.ok || !r.changed) {
        return { ok: false, lines: [...done, `:warning: ${this.errorText(out, r.reason)}`] };
      }
      if (out.dashboard_dirty) this.markDashboardDirty();
      const label = now === 'TRANSFERABLE' ? '양도 가능' : '유지 필요';
      const swapped = (out.swaps_created ?? []).length > 0;
      done.push(`*${SERVICE_LABEL[key] ?? key}* 좌석을 「${label}」로 바꿨습니다.`
        + (swapped ? ' 기다리던 분과 이어졌고 실장이 확인합니다.' : ''));
    }

    if (!done.length) return { ok: true, lines: ['바뀐 것이 없습니다.'] };
    return { ok: true, lines: done };
  }

  /** 서비스 한 곳의 내 좌석 · 요청 · 진행 중 교환. */
  private myLines(view: any): string[] {
    const lines: string[] = [];
    if (view.tier === 'PREMIUM') {
      const wish = view.availability === 'TRANSFERABLE' ? `${GIVE_ICON} 양도 가능` : `${KEEP_ICON} 유지 필요`;
      lines.push(`좌석: Premium  ·  ${wish}`);
    } else {
      lines.push(`좌석: ${TIER_LABEL[view.tier] ?? view.tier}`);
    }

    if (view.request?.status === 'WAITING') {
      lines.push(`${WAIT_ICON} 요청 대기 중  ·  내 차례 ${view.request.position}번째`);
    } else if (view.request?.status === 'SWAP_PENDING') {
      lines.push(`${SWAP_ICON} 요청이 양도자와 이어졌습니다`);
    } else {
      lines.push('요청: 없음');
    }

    if (view.swap) {
      const role = view.swap.role === 'HOLDER' ? '넘기는 쪽' : '받는 쪽';
      lines.push(`${SWAP_ICON} ${view.swap.from_name} \u2192 ${view.swap.to_name}  ·  ${role}  ·  ${SWAP_STATE_LABEL[view.swap.state] ?? view.swap.state}`);
    }
    return lines;
  }

  /**
   * 관리자 버튼 하나를 파이썬에 넘기고, 누른 메시지를 그 자리에서 갱신한다.
   *
   * 오래된 버튼은 파이썬이 상태를 보고 거절한다 — 화면이 낡았을 뿐 상태는 안 바뀐다.
   */
  private async handleSwapAction(kind: string, swapId: string, body: any): Promise<void> {
    const actor = this.userOf(body);
    const command = kind === 'verify' ? 'swap verify' : `swap ${kind}`;
    const out = await this.run(command, { swap_id: swapId, actor });

    const isAuto = Boolean(out.entity?.auto_execute ?? (out as any).result?.auto_execute);
    const reason = out.error?.code ?? (out as any).result?.reason ?? '';
    let line = out.ok
      ? SWAP_ACTION_DONE[kind] ?? '처리했습니다.'
      : SWAP_ACTION_FAILED[reason] ?? this.errorText(out);

    if (out.ok && kind === 'start' && isAuto) {
      line = '소인, 브라우저에서 좌석을 자동으로 교환하고 있사옵니다. 잠시만 기다려 주시옵소서 (약 30~60초 소요).';
    }

    const channel = body?.channel?.id;
    const ts = body?.message?.ts;
    if (channel && ts) {
      // 성공했으면 다음에 눌러야 할 버튼을 그 자리에 둔다.
      // 자동 실행(isAuto) 중일 때는 브라우저가 직접 완료하므로 [완료했습니다] 버튼을 두지 않는다.
      const next = out.ok
        ? this.swapActions(swapId, out.entity?.state, undefined, isAuto)
        : this.swapActions(swapId, undefined, body.message.blocks);
      try {
        await this.app!.client.chat.update({
          channel,
          ts,
          text: line,
          blocks: [
            ...(body.message.blocks ?? []).filter((b: any) => b.type !== 'actions'),
            { type: 'context', elements: [{ type: 'mrkdwn', text: `${out.ok ? ':white_check_mark:' : ':warning:'} ${line}` }] },
            ...(next ? [next] : []),
          ].filter(Boolean),
        });
      } catch (error) {
        this.logger.warn('failed to update the admin message', error);
      }
    }
    if (out.dashboard_dirty) this.markDashboardDirty();
  }

  /**
   * 그 교환 상태에서 다음에 누를 수 있는 버튼.
   *
   * 끝난 교환에는 아무것도 안 단다. `previous` 는 실패했을 때 방금 누른 버튼을
   * 그대로 살리는 데 쓴다 — 화면이 낡았을 뿐 다시 누르면 되는 경우가 있다.
   */
  private swapActions(swapId: string, state?: string, previous?: any[], isAuto = false): any | null {
    if (previous) {
      return (previous ?? []).find((b: any) => b.type === 'actions') ?? null;
    }
    switch (state) {
      // 아직 좌석을 안 건드린 상태다. 멈출 것이 없어 「이 교환 중단」은 안 단다 —
      // 파이썬도 이 두 상태에서는 중단을 거절한다.
      case 'AWAITING_ADMIN':
      case 'HELD':
        return {
          type: 'actions',
          elements: [
            this.button('양도 진행', 'premium_swap_start', 'primary', swapId),
            this.button('나중에', 'premium_swap_hold', undefined, swapId),
          ],
        };
      case 'APPLYING':
        if (isAuto) {
          // 자동 교환 모드에서는 사람이 [완료했습니다]를 누를 필요가 없으므로 버튼을 비워둔다.
          return null;
        }
        return {
          type: 'actions',
          elements: [
            this.button('완료했습니다', 'premium_swap_complete', 'primary', swapId),
            this.button('이 교환 중단', 'premium_swap_abort', 'danger', swapId),
          ],
        };
      case 'NEEDS_ADMIN':
        return {
          type: 'actions',
          elements: [
            this.button('다시 진행', 'premium_swap_start', 'primary', swapId),
            this.button('실제 상태 다시 확인', 'premium_swap_verify', undefined, swapId),
            this.button('이 교환 중단', 'premium_swap_abort', 'danger', swapId),
          ],
        };
      default:
        return null;
    }
  }

  // ------------------------------------------------------------- 알림 전송
  private async postNotification(row: any): Promise<{ channel?: string; ts?: string } | null> {
    const text = this.notificationText(row);
    if (!text) return null;
    const blocks: any[] = [{ type: 'section', text: { type: 'mrkdwn', text } }];
    const buttons = this.notificationButtons(row);
    if (buttons) blocks.push(buttons);

    // 시험 중에는 동료 대신 실장이 받는다. 원래 받을 사람을 머리에 적어 둔다.
    const to = this.opts.dmRedirectTo || row.recipient_slack_id;
    if (to !== row.recipient_slack_id) {
      blocks.unshift({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `\u{1F9EA} 시험 — 원래 받을 사람 <@${row.recipient_slack_id}>` }],
      });
    }

    let targetChannel = to;
    if (to.startsWith('U') || to.startsWith('W')) {
      try {
        const im = await this.app!.client.conversations.open({ users: to });
        if (im.channel?.id) targetChannel = im.channel.id;
      } catch (err) {
        this.logger.warn(`conversations.open failed for ${to}`, err);
      }
    }

    const res = await this.app!.client.chat.postMessage({
      channel: targetChannel,
      text,
      blocks,
    });
    return { channel: res.channel as string, ts: res.ts as string };
  }

  /** 관리자에게 가는 알림에만 버튼을 단다. 팀원 알림은 읽는 것으로 끝난다. */
  private notificationButtons(row: any): any | null {
    const id = row.payload?.swap_id;
    if (!id) return null;
    switch (row.kind) {
      case 'SWAP_APPROVAL':
        return {
          type: 'actions',
          elements: [
            this.button('양도 진행', 'premium_swap_start', 'primary', id),
            this.button('나중에', 'premium_swap_hold', undefined, id),
          ],
        };
      case 'APPLY_PENDING':
        return {
          type: 'actions',
          elements: [
            this.button('완료했습니다', 'premium_swap_complete', 'primary', id),
            this.button('이 교환 중단', 'premium_swap_abort', 'danger', id),
          ],
        };
      case 'SWAP_NEEDS_ADMIN':
        return {
          type: 'actions',
          elements: [
            this.button('다시 진행', 'premium_swap_start', 'primary', id),
            this.button('실제 상태 다시 확인', 'premium_swap_verify', undefined, id),
            this.button('이 교환 중단', 'premium_swap_abort', 'danger', id),
          ],
        };
      default:
        return null;
    }
  }

  private notificationText(row: any): string {
    const p = row.payload ?? {};
    const svc = SERVICE_LABEL[p.service] ?? p.service;
    switch (row.kind) {
      case 'SWAP_APPROVAL':
        return [
          `*${svc} Premium 양도 승인 필요*`,
          '',
          `보유자: ${p.holder?.name} (${p.holder?.email})`,
          `요청자: ${p.recipient?.name} (${p.recipient?.email})`,
          `교환 번호: ${p.swap_id}`,
          '',
          ...this.applySteps(p),
        ].join('\n');
      case 'APPLY_PENDING':
        return [
          `*${svc} Premium 양도 · 바꾸는 중*`,
          '',
          `${p.holder?.name} → ${p.recipient?.name}`,
          `교환 번호: ${p.swap_id}`,
          '',
          ...this.applySteps(p),
          '',
          '다 바꾸셨으면 아래 「완료했습니다」를 눌러 주세요.',
        ].join('\n');
      case 'SWAP_NEEDS_ADMIN': {
        const lines = [
          `*${svc} Premium 양도 · 확인 필요*`,
          '',
          `${p.holder?.name} → ${p.recipient?.name}`,
          `교환 번호: ${p.swap_id}`,
          '',
        ];
        if (p.error_detail || p.error_code) {
          lines.push(`오류: \`${p.error_code ?? 'FAILED'}\``);
          if (p.error_detail) {
            lines.push(`> ${p.error_detail}`);
          }
          lines.push('');
        }
        lines.push('좌석이 중간 상태로 남아 있습니다. 관리 화면을 보고 이어서 바꾸거나 되돌려 주세요.');
        return lines.join('\n');
      }
      case 'SWAP_COMPLETED':
        return `${svc} Premium 좌석 변경이 끝났습니다. ${p.holder?.name} → ${p.recipient?.name}`;
      default:
        return '';
    }
  }

  /** 관리 화면에서 밟을 순서 — 설계서 §3.1·§3.2 고정 문구. */
  private applySteps(p: any): string[] {
    const holder = p.holder?.name ?? '보유자';
    const recipient = p.recipient?.name ?? '요청자';
    if (p.service === 'CHATGPT') {
      return [
        '관리 화면 순서',
        `1. ${recipient} 행의 Seat type 에서 Premium 선택`,
        '2. Swap a seat 선택 뒤 Continue',
        `3. ${holder} 선택 뒤 Continue`,
      ];
    }
    return [
      '관리 화면 순서',
      `1. ${recipient} 의 티어를 「할당된 좌석 없음」으로 변경`,
      `2. ${holder} 의 티어를 「스탠다드」로 변경`,
      `3. ${recipient} 의 티어를 「Premium」으로 변경`,
    ];
  }

  // ------------------------------------------------------------- 잡일
  private userOf(body: any): string {
    return body?.user?.id ?? '';
  }

  private isManager(userId: string): boolean {
    return this.opts.managerUserIds.includes(userId);
  }

  /** 라디오·선택 한 칸의 값. 「바꾸지 않음」은 빈 문자열로 돌려준다. */
  private picked(view: any, blockId: string): string {
    const value = view?.state?.values?.[blockId]?.value?.selected_option?.value ?? '';
    if (value === KEEP_AS_IS) return '';
    // 고를 것이 하나뿐이라 안 물어본 서비스는 창에 실어 보냈다.
    if (!value && blockId === 'service') return view?.private_metadata ?? '';
    return value;
  }

  private checked(view: any, blockId: string): boolean {
    return (view?.state?.values?.[blockId]?.value?.selected_options ?? []).length > 0;
  }

  private errorText(out: Envelope, reason?: string): string {
    // 막힌 이유는 두 곳에 실려 온다. 예외는 error.code 로, 「안 바꿨다」는
    // 거절은 result.reason 으로 온다. 뒤쪽을 안 보면 안내가 늘 뭉뚱그려진다.
    const code = reason ?? out.error?.code ?? (out as any).result?.reason ?? '';
    return ERROR_TEXT[code] ?? '처리하지 못했습니다. 실장에게 알려 주세요.';
  }

  /** 누른 그 방에서 그 사람에게만 보이는 쪽지. 방이 없으면 DM 으로 물러선다. */
  private async onlyYou(body: any, text: string): Promise<void> {
    const channel = body?.channel?.id ?? this.opts.channelId;
    const user = this.userOf(body);
    if (!this.app || !user) return;
    try {
      await this.app.client.chat.postEphemeral({ channel, user, text });
      return;
    } catch (error) {
      this.logger.warn('postEphemeral failed; falling back to a DM', error);
    }
    await this.dm(user, text);
  }

  /** 사용자 ID 로 1:1 DM 방을 열어 메시지를 보낸다. */
  private async dm(userId: string, text: string): Promise<void> {
    if (!this.app || !userId) return;
    try {
      let channelId = userId;
      if (userId.startsWith('U') || userId.startsWith('W')) {
        const im = await this.app.client.conversations.open({ users: userId });
        if (im.channel?.id) channelId = im.channel.id;
      }
      await this.app.client.chat.postMessage({ channel: channelId, text });
    } catch (error) {
      this.logger.warn(`DM to ${userId} failed`, error);
    }
  }

  /** 사용자 ID 로 1:1 DM 방을 열어 블록 메시지를 보낸다. */
  private async dmBlocks(userId: string, text: string, blocks: any[]): Promise<{ channel?: string; ts?: string } | null> {
    if (!this.app || !userId) return null;
    try {
      let channelId = userId;
      if (userId.startsWith('U') || userId.startsWith('W')) {
        const im = await this.app.client.conversations.open({ users: userId });
        if (im.channel?.id) channelId = im.channel.id;
      }
      const res = await this.app.client.chat.postMessage({ channel: channelId, text, blocks });
      return { channel: res.channel as string, ts: res.ts as string };
    } catch (error) {
      this.logger.warn(`DM blocks to ${userId} failed`, error);
      return null;
    }
  }

  private seoulHour(): number {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Seoul',
      hour: 'numeric',
      hour12: false,
    }).formatToParts(new Date());
    const h = parts.find((p) => p.type === 'hour')?.value ?? '0';
    return parseInt(h, 10);
  }

  /** 06:00~18:00 사이 2시간 간격으로 세션을 점검한다. */
  private async pumpSessionCheck(): Promise<void> {
    const hour = this.seoulHour();
    if (hour < 6 || hour > 18) return;
    const now = Date.now();
    // 2시간(110분 오차 고려) 간격
    if (now - this.lastSessionCheckAt < 110 * 60 * 1000) return;
    this.lastSessionCheckAt = now;
    await this.checkSessionsAndNotify();
  }

  /**
   * 세션 상태를 확인하고 만료 시 실장님 DM으로 버튼을 포함한 알림을 발송한다.
   * manualUserId가 주어지면(수동 점검) 항상 상세 결과를 해당 사용자에게 회신한다.
   */
  private async checkSessionsAndNotify(manualUserId?: string): Promise<void> {
    const managerId = manualUserId || this.opts.managerUserIds[0];
    if (!managerId) return;

    const results: Record<string, { alive: boolean; reason?: string }> = {};
    for (const svc of ['CHATGPT', 'CLAUDE']) {
      try {
        const out = await this.run('session check', { service: svc }, 30_000);
        const alive = Boolean(out.result?.alive);
        results[svc] = {
          alive,
          reason: out.result?.reason ?? out.error?.message,
        };
      } catch (err) {
        results[svc] = { alive: false, reason: String(err) };
      }
    }

    if (manualUserId) {
      const lines = [
        '소인 여쭙사옵니다. 관리자 세션 상태를 점검하여 보고 올립니다.',
        '',
      ];
      const buttons: any[] = [];
      for (const svc of ['CHATGPT', 'CLAUDE']) {
        const info = results[svc];
        const name = SERVICE_LABEL[svc] ?? svc;
        if (info?.alive) {
          lines.push(`• :white_check_mark: *${name}*: 정상 연결 중`);
          this.notifiedExpiredServices.delete(svc);
        } else {
          lines.push(`• :warning: *${name}*: 세션 만료 (로그인 필요)`);
          this.notifiedExpiredServices.add(svc);
          buttons.push(
            this.button(
              `🖥️ ${SERVICE_SHORT[svc] ?? svc} 로그인 창 열기`,
              'premium_open_login_browser',
              'primary',
              svc,
            ),
          );
        }
      }

      const blocks: any[] = [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: lines.join('\n'),
          },
        },
      ];
      if (buttons.length) {
        blocks.push({
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: '관리자 세션이 만료되면 자동 좌석 교환이 대기 상태에 머물게 되옵니다.\n호스트 PC에서 로그인을 진행하시려면 아래 버튼을 눌러 주시옵소서.',
            },
          ],
        });
        blocks.push({
          type: 'actions',
          elements: buttons,
        });
      }
      await this.dmBlocks(manualUserId, lines.join('\n'), blocks);
      return;
    }

    // 2시간 주기 자동 점검
    for (const svc of ['CHATGPT', 'CLAUDE']) {
      const info = results[svc];
      const name = SERVICE_LABEL[svc] ?? svc;
      if (!info?.alive) {
        if (!this.notifiedExpiredServices.has(svc)) {
          this.notifiedExpiredServices.add(svc);
          const text = `소인 여쭙사옵니다. :warning: *${name}* 관리자 세션이 만료되었사옵니다.\n관리자 로그인이 갱신되지 않으면 자동 좌석 교환 작업이 대기 상태에 머물게 되옵니다.\n\n호스트 PC에서 관리자 로그인을 진행하시겠사옵니까?`;
          const blocks = [
            {
              type: 'section',
              text: { type: 'mrkdwn', text },
            },
            {
              type: 'actions',
              elements: [
                this.button(
                  `🖥️ ${SERVICE_SHORT[svc] ?? svc} 로그인 창 열기`,
                  'premium_open_login_browser',
                  'primary',
                  svc,
                ),
              ],
            },
          ];
          await this.dmBlocks(managerId, text, blocks);
        }
      } else {
        if (this.notifiedExpiredServices.has(svc)) {
          this.notifiedExpiredServices.delete(svc);
          await this.dm(
            managerId,
            `소인 여쭙사옵니다. :white_check_mark: *${name}* 관리자 세션이 정상 복구되었음을 확인하였사옵니다.`,
          );
        }
      }
    }
  }

  /**
   * 실장님이 버튼을 눌렀을 때 호스트 PC 화면에 대화형 브라우저를 띄워 로그인을 대기한다.
   */
  private async launchInteractiveLogin(service: string, body: any): Promise<void> {
    const serviceLabel = SERVICE_LABEL[service] ?? service;
    const serviceShort = SERVICE_SHORT[service] ?? service;
    const channel = body?.channel?.id;
    const ts = body?.message?.ts;
    const user = this.userOf(body);

    if (this.loginBusy.has(service)) {
      await this.onlyYou(body, `이미 호스트 PC에 *${serviceLabel}* 로그인 창이 열려 있사옵니다.`);
      return;
    }
    this.loginBusy.add(service);

    // 낙관적 UI 갱신: 중복 클릭 방지 및 상태 안내
    if (channel && ts) {
      try {
        await this.app!.client.chat.update({
          channel,
          ts,
          text: `⏳ 소인, 호스트 PC에 *${serviceLabel}* 로그인 창을 띄웠사옵니다...`,
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `⏳ 소인, 호스트 PC에 *${serviceLabel}* 로그인 창을 띄웠사옵니다.\n화면에 브라우저가 뜨면 관리자 계정으로 로그인을 완료해 주시옵소서.\n\n_(로그인 후 회원 목록 표가 감지되면 자동으로 창이 닫히고 완료 보고를 올리겠사옵니다)_`,
              },
            },
          ],
        });
      } catch (err) {
        this.logger.warn('Failed to update message optimistically', err);
      }
    }

    // 대화형 브라우저 기동 (windowsHide: false, 타임아웃 10분)
    const child = spawn(
      this.opts.python,
      ['-X', 'utf8', '-m', 'premium_seat_manager.interactive_login', service, '600'],
      {
        cwd: this.opts.workerDir,
        env: { ...process.env, ...this.opts.env, PYTHONIOENCODING: 'utf-8' },
        windowsHide: false,
      },
    );
    this.children.add(child);

    let stderr = '';
    child.stderr.on('data', (c) => {
      stderr += c.toString();
    });

    const timeout = setTimeout(() => {
      this.logger.warn(`interactive login for ${service} timed out after 600s`);
      try {
        child.kill();
      } catch {}
    }, 600_000);

    child.on('close', async (code) => {
      clearTimeout(timeout);
      this.children.delete(child);
      this.loginBusy.delete(service);

      if (code === 0) {
        this.notifiedExpiredServices.delete(service);
        const doneText = `🎉 소인, *${serviceLabel}* 관리자 로그인이 확인되어 세션을 정상 갱신하였사옵니다!`;
        if (channel && ts) {
          try {
            await this.app!.client.chat.update({
              channel,
              ts,
              text: doneText,
              blocks: [
                {
                  type: 'section',
                  text: {
                    type: 'mrkdwn',
                    text: doneText,
                  },
                },
              ],
            });
          } catch (err) {
            this.logger.warn('Failed to update success message', err);
            await this.dm(user, doneText);
          }
        } else {
          await this.dm(user, doneText);
        }
        // 대기 중인 큐가 있으면 즉시 진행
        void this.pumpJobs();
        this.markDashboardDirty();
      } else {
        this.logger.warn(`interactive login for ${service} exited with code ${code}`, { stderr: stderr.trim() });
        const failText = `⚠️ 소인, *${serviceLabel}* 로그인 창이 완료되지 못하고 닫혔거나 제한 시간(10분)이 초과되었사옵니다.\n다시 진행하시려면 아래 버튼을 눌러 주시옵소서.`;
        const retryBlocks = [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: failText,
            },
          },
          {
            type: 'actions',
            elements: [
              this.button(
                `🖥️ ${serviceShort} 로그인 창 열기`,
                'premium_open_login_browser',
                'primary',
                service,
              ),
            ],
          },
        ];
        if (channel && ts) {
          try {
            await this.app!.client.chat.update({
              channel,
              ts,
              text: failText,
              blocks: retryBlocks,
            });
          } catch (err) {
            this.logger.warn('Failed to update failure message', err);
            await this.dmBlocks(user, failText, retryBlocks);
          }
        } else {
          await this.dmBlocks(user, failText, retryBlocks);
        }
      }
    });
  }
}

function cryptoRandom(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
