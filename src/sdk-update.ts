import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import Holidays from 'date-holidays';
import { Logger } from './logger';
import { offDays, ymd } from './work-assistant';

/**
 * Agent SDK 판 맞춤 — 주 1회 판을 대조해 어긋나면 스탠리 DM 에 [업데이트] 버튼을 띄운다.
 *
 * **왜** — SDK 는 Claude Code 실행 파일을 띄우는 부품이고 판마다 짝 CLI 판이 있다. Claude Code 는 스스로
 * 업데이트되므로(새 판이 거의 매일) SDK 를 그대로 두면 판이 벌어진다. 어긋날 때마다 알리면 매일 DM 이 가서
 * 안 보게 되므로 **주 첫 업무일에 한 번** 묻는다(실장 결정 2026-09-29 · 「버튼만 누르면 반영」).
 *
 * 실제 일은 `scripts/sdk-update.mjs` 가 한다 — 여기는 묻고(카드) · 띄우고(pm2 한 번짜리 앱) · 알린다(결과).
 * **pm2 로 띄우는 까닭** — 마지막에 봇을 재시작하는데, 봇의 자식으로 띄우면 그때 같이 죽는다.
 */

export interface SdkSide { version: string; pair: string; target: string | null; targetPair: string | null }
export interface SdkCheck { cli: string; ts: SdkSide; py: SdkSide; needed: boolean }
interface ResultStep { name: string; ok: boolean; detail?: string }
interface UpdateResult {
  id: string; thread: string | null; status: 'running' | 'done' | 'failed';
  startedAt: string; finishedAt?: string; busy?: boolean; dryRun?: boolean; steps: ResultStep[];
}

export const RUN_ACTION = 'sdk_update_run';
export const SKIP_ACTION = 'sdk_update_skip';
const PM2_APP = 'claude-sdk-update';
/** 이 시각부터 두 시간 — 저녁에 재시작해도 그 자리에서 돌지 않게(주간 제안과 같은 규칙). */
const WINDOW_MIN = 120;
/** 판 대조가 실패하면(네트워크 등) 이만큼 뒤에 다시 — 창 안에서 매분 npm·PyPI 를 두드리지 않게. */
const RETRY_MS = 15 * 60 * 1000;
/** 결과가 이보다 오래 `running` 이면 멈춘 것으로 본다 — 다시 누를 수 있게. */
const STALE_RUN_MS = 60 * 60 * 1000;

export interface SdkUpdateOptions {
  at: string;
  repoRoot: string;
  dmChannel: string;
  send: (text: string, blocks: any[]) => Promise<string | undefined>;
  reply: (threadTs: string, text: string) => Promise<void>;
  update: (ts: string, text: string, blocks: any[]) => Promise<void>;
  stateDir?: string;
  logger?: Logger;
  // 시험에서 바꿔 끼운다.
  runCheck?: () => Promise<SdkCheck | null>;
  busyReason?: () => Promise<string>;
  launch?: (requestPath: string) => Promise<void>;
  isWorkday?: (d: Date) => boolean;
}

export class SdkUpdate {
  private logger: Logger;
  private timer: NodeJS.Timeout | null = null;
  private ranWeek = '';
  private restDay = '';
  private retryAt = 0;
  private readonly dir: string;
  private readonly holidays = new Holidays('KR');

  constructor(private readonly opts: SdkUpdateOptions) {
    this.logger = opts.logger ?? new Logger('SdkUpdate');
    this.dir = opts.stateDir ?? path.join(os.homedir(), '.claude', 'state');
  }

  private get statePath() { return path.join(this.dir, 'sdk-update-state.json'); }
  get resultPath() { return path.join(this.dir, 'sdk-update-result.json'); }
  get requestPath() { return path.join(this.dir, 'sdk-update-request.json'); }
  private get sentPath() { return path.join(this.dir, 'sdk-update-sent.json'); }
  private get script() { return path.join(this.opts.repoRoot, 'scripts', 'sdk-update.mjs'); }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch((e) => this.logger.warn('판 대조에서 넘어졌습니다', e));
      void this.watchResult().catch((e) => this.logger.warn('결과 알림에서 넘어졌습니다', e));
    }, 60 * 1000);
    this.timer.unref?.();
    this.logger.info(`준비됨 — 주 첫 업무일 ${this.opts.at} 에 Agent SDK 판 대조 · 어긋나면 DM 에 [업데이트] 버튼`);
  }

  /** 분마다 — 그 시각 창이고 이번 주 아직이면 한 번. 쉬는 날이면 다음 업무일로 넘긴다. */
  async tick(now = new Date()): Promise<'not-time' | 'done-this-week' | 'rest' | 'retry-later' | 'failed' | 'aligned' | 'asked'> {
    const [h, m] = this.opts.at.split(':').map((x) => parseInt(x, 10));
    const atMin = (h || 0) * 60 + (m || 0);
    const nowMin = now.getHours() * 60 + now.getMinutes();
    if (nowMin < atMin || nowMin >= atMin + WINDOW_MIN) return 'not-time';
    const today = ymd(now);
    const week = ymd(mondayOf(now));
    const st = this.state();
    if (this.ranWeek === week || st.week === week) return 'done-this-week';
    if (this.restDay === today || st.day === today) return 'rest';
    if (!(this.opts.isWorkday ?? ((d: Date) => this.isWorkday(d)))(now)) {
      this.restDay = today;
      this.saveState({ day: today });
      return 'rest';
    }
    if (now.getTime() < this.retryAt) return 'retry-later';
    // 먼저 적고 돈다 — 도중에 넘어져도 같은 주에 카드가 두 번 가지 않게.
    this.ranWeek = week;
    this.saveState({ week });
    const c = await (this.opts.runCheck ?? (() => this.check()))();
    if (!c) {
      this.ranWeek = '';
      this.saveState({});
      this.retryAt = now.getTime() + RETRY_MS;
      return 'failed';
    }
    if (!c.needed) {
      this.logger.info(`판이 맞습니다 — Claude Code ${c.cli} · 봇 SDK 짝 ${c.ts.pair} · 파이썬 SDK 짝 ${c.py.pair}`);
      return 'aligned';
    }
    await this.opts.send(cardText(c), cardBlocks(c));
    return 'asked';
  }

  /** [업데이트] — DM 에서 온 것만. 다른 작업 중이면 버튼을 남겨 두고 이유만 스레드에. */
  async onRun({ ack, body }: { ack: () => Promise<void>; body: any }): Promise<void> {
    await ack();
    const ts: string | undefined = body?.message?.ts;
    if (body?.channel?.id !== this.opts.dmChannel || !ts) return;
    const cur = this.result();
    if (cur?.status === 'running' && Date.now() - Date.parse(cur.startedAt) < STALE_RUN_MS) {
      await this.opts.reply(ts, '이미 판 맞춤이 돌고 있습니다 — 끝나면 그 스레드에 알립니다.');
      return;
    }
    const busy = await (this.opts.busyReason ?? (() => this.busy()))();
    if (busy) {
      await this.opts.reply(ts, `지금은 못 올립니다. ${busy}. 끝난 뒤 버튼을 다시 누르세요.`);
      return;
    }
    const req = { id: `btn-${Date.now()}`, requestedAt: new Date().toISOString(), thread: ts, consumed: false };
    writeJson(this.requestPath, req);
    await (this.opts.launch ?? ((p: string) => this.launchPm2(p)))(this.requestPath);
    const text = `${textOf(body)}\n\n⏳ 시작했습니다 — 몇 분 걸립니다. 끝나면 이 스레드에 알립니다.`;
    await this.opts.update(ts, text, [section(text)]);
    this.logger.info('판 맞춤을 띄웠습니다', { id: req.id });
  }

  /** [이번 주 건너뛰기]. */
  async onSkip({ ack, body }: { ack: () => Promise<void>; body: any }): Promise<void> {
    await ack();
    const ts: string | undefined = body?.message?.ts;
    if (body?.channel?.id !== this.opts.dmChannel || !ts) return;
    const text = `${textOf(body)}\n\n이번 주는 건너뜁니다 — 다음 주에 다시 묻습니다.`;
    await this.opts.update(ts, text, [section(text)]);
  }

  /** 결과가 끝났고 아직 안 알렸으면 버튼을 누른 스레드에 한 번. 보낸 표시는 봇만 쓴다(스크립트와 한 파일을 안 나눈다). */
  async watchResult(): Promise<boolean> {
    const r = this.result();
    if (!r || r.status === 'running' || !r.thread) return false;
    const sent = this.sent();
    if (sent.includes(r.id)) return false;
    await this.opts.reply(r.thread, formatResult(r));
    writeJson(this.sentPath, [...sent, r.id].slice(-50));
    if (!this.opts.launch) this.pm2(['delete', PM2_APP]);
    return true;
  }

  // --- 기본 부품(시험에서는 옵션으로 바꿔 끼운다) --------------------------------

  private isWorkday(d: Date): boolean {
    const day = d.getDay();
    if (day === 0 || day === 6) return false;
    if (offDays().has(ymd(d))) return false;
    const h = this.holidays.isHoliday(d);
    return !(Array.isArray(h) && h.some((x) => x.type === 'public'));
  }

  private node(args: string[], timeout: number): Promise<string> {
    return new Promise((resolve) => {
      execFile(process.execPath, [this.script, ...args], { cwd: this.opts.repoRoot, timeout, windowsHide: true },
        (_err, stdout) => resolve(String(stdout ?? '')));
    });
  }

  private async check(): Promise<SdkCheck | null> {
    const out = (await this.node(['--check'], 5 * 60 * 1000)).trim();
    try {
      const got = JSON.parse(out);
      if (got.error) { this.logger.warn(`판 대조 실패 — ${got.error}`); return null; }
      return got as SdkCheck;
    } catch {
      this.logger.warn('판 대조 결과가 JSON 이 아닙니다');
      return null;
    }
  }

  private async busy(): Promise<string> {
    try {
      return String(JSON.parse((await this.node(['--busy'], 60 * 1000)).trim()).reason ?? '');
    } catch {
      return '작업 중인지 확인하지 못함';
    }
  }

  private pm2(args: string[]): Promise<boolean> {
    // `pm2` 는 윈도에서 `.cmd` 라 셸로만 뜬다 — 경로 인자는 따옴표로.
    const cmd = ['pm2', ...args.map((a) => (/[\s<>|&^]/.test(a) || a.includes(path.sep) ? `"${a}"` : a))].join(' ');
    return new Promise((resolve) => {
      execFile(process.platform === 'win32' ? 'cmd.exe' : 'sh',
        process.platform === 'win32' ? ['/d', '/s', '/c', cmd] : ['-c', cmd],
        { windowsHide: true, timeout: 60 * 1000, windowsVerbatimArguments: true },
        (err) => resolve(!err));
    });
  }

  private async launchPm2(requestPath: string): Promise<void> {
    await this.pm2(['delete', PM2_APP]);  // 지난주 것이 멈춘 채 남아 있으면 같은 이름으로 못 띄운다
    const ok = await this.pm2(['start', this.script, '--name', PM2_APP, '--no-autorestart',
      '--', '--run', '--request', requestPath]);
    if (!ok) throw new Error('pm2 로 판 맞춤을 못 띄웠습니다');
  }

  private result(): UpdateResult | null {
    try { return JSON.parse(fs.readFileSync(this.resultPath, 'utf-8')); } catch { return null; }
  }

  private sent(): string[] {
    try {
      const v = JSON.parse(fs.readFileSync(this.sentPath, 'utf-8'));
      return Array.isArray(v) ? v : [];
    } catch { return []; }
  }

  private state(): { week?: string; day?: string } {
    try { return JSON.parse(fs.readFileSync(this.statePath, 'utf-8')); } catch { return {}; }
  }

  private saveState(s: { week?: string; day?: string }): void {
    try { writeJson(this.statePath, s); } catch (e) { this.logger.warn('상태를 못 적었습니다', e); }
  }
}

// --- 글 ------------------------------------------------------------------------

export function cardText(c: SdkCheck): string {
  const line = (label: string, s: SdkSide) =>
    `• ${label} ${s.version} (짝 ${s.pair})${s.target ? ` → *${s.target}*` : ' — 그대로'}`;
  return [
    `:arrows_counterclockwise: *Agent SDK 판 맞춤* — Claude Code 가 ${c.cli} 로 올라 SDK 판이 벌어졌습니다.`,
    line('봇 SDK', c.ts),
    line('파이썬 SDK', c.py),
    '누르면 설치 → 시험 → 실제 호출 → 커밋·푸시 → 봇 재시작까지 합니다(몇 분). 실패하면 그 단계에서 되돌립니다.',
  ].join('\n');
}

export function cardBlocks(c: SdkCheck): any[] {
  return [
    section(cardText(c)),
    {
      type: 'actions',
      elements: [
        { type: 'button', text: { type: 'plain_text', text: '업데이트' }, style: 'primary', action_id: RUN_ACTION, value: 'run' },
        { type: 'button', text: { type: 'plain_text', text: '이번 주 건너뛰기' }, action_id: SKIP_ACTION, value: 'skip' },
      ],
    },
  ];
}

export function formatResult(r: UpdateResult): string {
  const secs = r.finishedAt ? Math.round((Date.parse(r.finishedAt) - Date.parse(r.startedAt)) / 1000) : 0;
  const took = secs >= 60 ? `${Math.floor(secs / 60)}분 ${secs % 60}초` : `${secs}초`;
  const lines = r.steps.map((s) => `${s.ok ? '✓' : '✗'} ${s.name}${s.detail ? ` — ${s.detail}` : ''}`);
  if (r.status === 'done') return [`✅ 판 맞춤 끝 (${took})`, ...lines].join('\n');
  if (r.busy) {
    const why = r.steps.find((s) => !s.ok)?.detail ?? '';
    return `⏸ 못 올렸습니다. ${why}. 끝난 뒤 카드의 [업데이트]를 다시 누르세요.`;
  }
  const bad = r.steps.find((s) => !s.ok);
  return [`❌ 「${bad?.name ?? '?'}」에서 멈췄습니다 (${took})`, ...lines].join('\n');
}

function section(text: string): any {
  return { type: 'section', text: { type: 'mrkdwn', text } };
}

/** 카드 원문 — 버튼 줄을 빼고 글만 다시 쓰려고. */
function textOf(body: any): string {
  const blocks: any[] = body?.message?.blocks ?? [];
  const sec = blocks.find((b) => b?.type === 'section');
  return String(sec?.text?.text ?? body?.message?.text ?? '');
}

function writeJson(file: string, obj: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf-8');
  fs.renameSync(tmp, file);
}

/** 이번 주 월요일 0시(이 PC 시간). */
function mondayOf(now: Date): Date {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}
