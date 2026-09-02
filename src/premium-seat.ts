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
}

interface Envelope {
  ok: boolean;
  operation_id?: string | null;
  entity?: { type?: string; id?: string; state?: string };
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
};

const TIMEOUT_STATE_MS = 10_000;
const TIMEOUT_READ_MS = 90_000;

export class PremiumSeatSlack {
  private logger = new Logger('PremiumSeat');
  private app: App | null = null;
  private timers: NodeJS.Timeout[] = [];
  private children = new Set<ReturnType<typeof spawn>>();
  private registered = false;
  private jobBusy = false;
  private dashboardPending: NodeJS.Timeout | null = null;

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
    app.action('premium_availability_open', async ({ ack, body, client }) => {
      await ack();
      await this.openModal(client, body, 'availability');
    });
    app.action('premium_my_requests', async ({ ack, body }) => {
      await ack();
      void this.showMyRequests(this.userOf(body));
    });

    app.view('premium_request_submit', async ({ ack, body, view }) => {
      await ack();
      const service = this.pickedService(view, 'service');
      void this.handleRequest(body.user.id, service);
    });
    app.view('premium_availability_submit', async ({ ack, body, view }) => {
      await ack();
      const service = this.pickedService(view, 'service');
      const status = this.pickedService(view, 'status');
      void this.handleAvailability(body.user.id, service, status);
    });

    const jobEvery = (this.opts.jobPollSeconds ?? 10) * 1000;
    this.every(jobEvery, () => this.pumpJobs());
    this.every(60_000, () => this.pumpNotifications());
    this.every(60_000, () => this.scheduleReconciles());

    this.logger.info('Premium seat feature attached (sharing the chat connection)');
    void this.refreshDashboard();
  }

  dispose(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    if (this.dashboardPending) clearTimeout(this.dashboardPending);
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
      const out = await this.run('job run', { job_id: job.id, lease_token: job.lease_token }, TIMEOUT_READ_MS);
      if (!out.ok) {
        this.logger.warn(`job run failed (${job.service})`, out.error);
      }
      if (out.dashboard_dirty) this.markDashboardDirty();
    } finally {
      this.jobBusy = false;
    }
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
      const observed = view.observed_at ? Date.parse(view.observed_at) : 0;
      const ageMin = observed ? (Date.now() - observed) / 60000 : Number.POSITIVE_INFINITY;
      if (ageMin >= maxAge) await this.run('reconcile enqueue', { service });
    }
  }

  // ------------------------------------------------------------- 화면
  private markDashboardDirty(): void {
    // 2초 동안 여러 신호를 모아 한 번만 갱신한다 (§18.3).
    if (this.dashboardPending) return;
    this.dashboardPending = setTimeout(() => {
      this.dashboardPending = null;
      void this.refreshDashboard();
    }, 2000);
    this.dashboardPending.unref?.();
  }

  async refreshDashboard(): Promise<void> {
    if (!this.app) return;
    const model = await this.run('dashboard model', {});
    if (!model.ok) return;
    const blocks = this.dashboardBlocks(model.result);
    const text = 'AI Premium 좌석 현황';
    const saved = model.result?.message;
    const channel = this.opts.channelId;

    try {
      if (saved?.ts) {
        await this.app.client.chat.update({ channel: saved.channel ?? channel, ts: saved.ts, text, blocks });
        return;
      }
    } catch (error) {
      this.logger.warn('dashboard update failed; posting a new one', error);
    }
    try {
      const posted = await this.app.client.chat.postMessage({ channel, text, blocks });
      if (posted.ts) await this.run('dashboard placed', { channel, ts: posted.ts });
    } catch (error) {
      this.logger.warn('dashboard post failed', error);
    }
  }

  private dashboardBlocks(model: any): any[] {
    const lines: string[] = [];
    const maxAge = model?.snapshot_max_age_minutes ?? 60;
    for (const key of ['CHATGPT', 'CLAUDE']) {
      const view = model?.services?.[key];
      if (!view) continue;
      const counts = view.counts ?? {};
      const transferable = (view.premium ?? []).filter((p: any) => p.availability === 'TRANSFERABLE').length;
      const head = `*${SERVICE_LABEL[key] ?? key}* · Premium ${counts.premium ?? '?'}명 · 양도 가능 ${transferable}명 · 대기 ${(view.waiting ?? []).length}명${view.locked ? ' · 실장 확인 중' : ''}`;
      lines.push(head);
      for (const holder of view.premium ?? []) {
        const mark = holder.availability === 'TRANSFERABLE' ? '양도 가능' : '유지 필요';
        lines.push(`• ${holder.display_name}  ${mark}`);
      }
      if ((view.waiting ?? []).length) lines.push(`대기: ${view.waiting.join(' · ')}`);
      const observed = view.observed_at ? Date.parse(view.observed_at) : 0;
      const stale = !observed || (Date.now() - observed) / 60000 >= maxAge;
      lines.push(`마지막 확인: ${observed ? new Date(observed).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) : '없음'}${stale ? ' · 확인 지연' : ''}`);
      if (view.unknown_email_count) lines.push(`대응표 미등록 ${view.unknown_email_count}명`);
      lines.push('');
    }

    const blocks: any[] = [
      { type: 'header', text: { type: 'plain_text', text: 'AI Premium 좌석', emoji: true } },
      { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n').trim() || '아직 확인된 좌석이 없습니다.' } },
    ];
    if (this.opts.openToTeam) {
      blocks.push({
        type: 'actions',
        elements: [
          this.button('Premium 요청', 'premium_request_open'),
          this.button('내 상태 변경', 'premium_availability_open'),
          this.button('내 요청 보기', 'premium_my_requests'),
        ],
      });
    } else {
      blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: '아직 준비 중입니다. 실장이 열면 버튼이 나옵니다.' }],
      });
    }
    return blocks;
  }

  private button(label: string, actionId: string): any {
    return { type: 'button', text: { type: 'plain_text', text: label, emoji: true }, action_id: actionId };
  }

  private async openModal(client: any, body: any, kind: 'request' | 'availability'): Promise<void> {
    if (!this.opts.openToTeam && !this.isManager(this.userOf(body))) {
      await this.dm(this.userOf(body), '아직 준비 중입니다.');
      return;
    }
    const serviceBlock = {
      type: 'input',
      block_id: 'service',
      label: { type: 'plain_text', text: '서비스' },
      element: {
        type: 'radio_buttons',
        action_id: 'value',
        options: [
          { text: { type: 'plain_text', text: 'ChatGPT Business' }, value: 'CHATGPT' },
          { text: { type: 'plain_text', text: 'Claude Team' }, value: 'CLAUDE' },
        ],
      },
    };
    const view =
      kind === 'request'
        ? {
            type: 'modal',
            callback_id: 'premium_request_submit',
            title: { type: 'plain_text', text: 'Premium 요청' },
            submit: { type: 'plain_text', text: '요청' },
            blocks: [serviceBlock],
          }
        : {
            type: 'modal',
            callback_id: 'premium_availability_submit',
            title: { type: 'plain_text', text: '내 상태 변경' },
            submit: { type: 'plain_text', text: '변경' },
            blocks: [
              serviceBlock,
              {
                type: 'input',
                block_id: 'status',
                label: { type: 'plain_text', text: '변경 상태' },
                element: {
                  type: 'radio_buttons',
                  action_id: 'value',
                  options: [
                    { text: { type: 'plain_text', text: '유지 필요' }, value: 'REQUIRED' },
                    { text: { type: 'plain_text', text: '양도 가능' }, value: 'TRANSFERABLE' },
                  ],
                },
              },
            ],
          };
    try {
      await client.views.open({ trigger_id: body.trigger_id, view });
    } catch (error) {
      this.logger.warn('views.open failed', error);
    }
  }

  // ------------------------------------------------------------- 처리
  private async handleRequest(userId: string, service: string): Promise<void> {
    const out = await this.run('request create', { service, slack_user_id: userId });
    if (!out.ok) return void this.dm(userId, this.errorText(out));
    const r = out.result ?? {};
    if (!r.created) return void this.dm(userId, this.errorText(out, r.reason));
    const swapped = (out.swaps_created ?? []).length > 0;
    await this.dm(
      userId,
      swapped
        ? `${SERVICE_LABEL[service]} Premium 요청을 넣었습니다. 양도자를 찾았고 실장 승인을 기다립니다.`
        : `${SERVICE_LABEL[service]} Premium 요청을 넣었습니다. 양도 가능한 좌석이 나오면 알려 드립니다.`,
    );
    if (out.dashboard_dirty) this.markDashboardDirty();
  }

  private async handleAvailability(userId: string, service: string, status: string): Promise<void> {
    const out = await this.run('availability set', { service, slack_user_id: userId, status });
    if (!out.ok) return void this.dm(userId, this.errorText(out));
    const r = out.result ?? {};
    if (!r.changed) return void this.dm(userId, this.errorText(out, r.reason));
    const label = status === 'TRANSFERABLE' ? '양도 가능' : '유지 필요';
    const swapped = (out.swaps_created ?? []).length > 0;
    await this.dm(
      userId,
      `${SERVICE_LABEL[service]} 좌석을 「${label}」로 바꿨습니다.${swapped ? ' 기다리던 분과 이어졌고 실장 승인을 기다립니다.' : ''}`,
    );
    if (out.dashboard_dirty) this.markDashboardDirty();
  }

  private async showMyRequests(userId: string): Promise<void> {
    const model = await this.run('dashboard model', {});
    const services = model.result?.services ?? {};
    const mine: string[] = [];
    for (const [key, view] of Object.entries<any>(services)) {
      for (const holder of view.premium ?? []) {
        if (holder.slack_user_id === userId) {
          const mark = holder.availability === 'TRANSFERABLE' ? '양도 가능' : '유지 필요';
          mine.push(`${SERVICE_LABEL[key]} · Premium 보유 · ${mark}`);
        }
      }
    }
    await this.dm(userId, mine.length ? mine.join('\n') : '지금 보유한 Premium 좌석이 없습니다.');
  }

  // ------------------------------------------------------------- 알림 전송
  private async postNotification(row: any): Promise<{ channel?: string; ts?: string } | null> {
    const text = this.notificationText(row);
    if (!text) return null;
    const res = await this.app!.client.chat.postMessage({
      channel: row.recipient_slack_id,
      text,
    });
    return { channel: res.channel as string, ts: res.ts as string };
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
      case 'MATCHED_HOLDER':
        return `${svc} Premium 좌석을 ${p.recipient?.name} 님에게 넘기는 건으로 이어졌습니다. 추가로 하실 일은 없습니다.`;
      case 'MATCHED_RECIPIENT':
        return `${svc} Premium 좌석을 ${p.holder?.name} 님이 양도해 주기로 했습니다. 실장 승인을 기다립니다.`;
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

  private pickedService(view: any, blockId: string): string {
    return view?.state?.values?.[blockId]?.value?.selected_option?.value ?? '';
  }

  private errorText(out: Envelope, reason?: string): string {
    const code = reason ?? out.error?.code ?? '';
    return ERROR_TEXT[code] ?? '처리하지 못했습니다. 실장에게 알려 주세요.';
  }

  /** `chat.postMessage` 에 사용자 ID 를 그대로 넘긴다 — `conversations.open` 을 쓰지 않는다. */
  private async dm(userId: string, text: string): Promise<void> {
    if (!this.app || !userId) return;
    try {
      await this.app.client.chat.postMessage({ channel: userId, text });
    } catch (error) {
      this.logger.warn(`DM to ${userId} failed`, error);
    }
  }
}

function cryptoRandom(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
