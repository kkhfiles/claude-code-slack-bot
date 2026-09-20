import { exec } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { Logger } from './logger';

const execAsync = promisify(exec);

type SendMessageFn = (text: string, blocks?: any[]) => Promise<string>;
type UpdateMessageFn = (ts: string, text: string, blocks?: any[]) => Promise<void>;

/** `operator-action-needed.json` 의 다우 항목. `since` 는 첫 감지일이라 한 만료 = 한 키. */
const ALERT_ID = 'daou-session';
export const ACTION_ID = 'daou_login';
const NOTICE_FILE = 'daou-login-notice.json';

interface Notice {
  key: string;        // `daou-session:<since>` — 만료 한 번에 알림 한 번
  ts: string;         // 버튼이 달린 메시지. 하루 뒤에 눌러도 이 메시지를 고쳐 쓴다
  resolvedAt?: string;
}

/**
 * **다우 세션이 죽은 것을 확인한 시점에 로그인 버튼을 띄운다.** (2026-09-21 사용자 결정)
 *
 * 만료는 파이썬(`groupware_daily`)이 자정·정오·13시 keepalive 에서 감지해 큐 파일에
 * 마커를 쓴다. 여기서는 그 마커를 보고 한 번만 알리고, 버튼이 눌리면 **이 PC 에**
 * 로그인 창을 띄운다(자동 재로그인은 안 한다 — 보안문자·자격증명 저장·계정 잠금).
 *
 * **버튼은 하루 뒤에 눌려도 된다.** 그래서
 * - 버튼 `value` 에 만료 없는 키만 싣고, 눌릴 때마다 지금 상태를 다시 잰다 —
 *   그사이 터미널에서 로그인했으면 창을 안 띄우고 「이미 살아 있음」으로 답한다.
 * - 5분 안에 로그인이 없으면 창을 닫고 버튼을 **그대로 남긴다** — 다시 누르면 다시 연다.
 * - 마커가 사라지면(다른 길로 로그인) 알림 메시지를 「해소」로 고쳐 낡은 🔴 가 안 남게 한다.
 * - 같은 만료에 두 번 누르면 두 창이 뜨지 않게 진행 중 표시를 둔다.
 */
export class DaouLoginNotifier {
  private logger = new Logger('DaouLogin');
  private inFlight = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private sendMessage: SendMessageFn,
    private updateMessage: UpdateMessageFn,
    private intervalSec = 300,
  ) {}

  /**
   * 메모리 감시기와 같은 위치(봇 기동)에서 한 번 등록한다 — 스케줄러의
   * `clearAllTimers()` 가 걷는 타이머가 아니라 설정 재로드에 안 죽는다(7/20 교훈).
   */
  start(): void {
    if (this.timer) return;
    setTimeout(() => this.poll().catch(e => this.logger.error('다우 알림 점검 실패', e)), 20_000);
    this.timer = setInterval(
      () => this.poll().catch(e => this.logger.error('다우 알림 점검 실패', e)),
      this.intervalSec * 1000,
    );
    this.logger.info(`다우 세션 알림 시작 (${this.intervalSec}s)`);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private get stateDir(): string {
    return path.join(process.env.USERPROFILE || process.env.HOME || '', '.claude', 'state');
  }

  private get repo(): string {
    return process.env.MYCELIUM_REPO || 'P:/github/claude-workflow';
  }

  private readNotice(): Notice | null {
    try {
      const n = JSON.parse(fs.readFileSync(path.join(this.stateDir, NOTICE_FILE), 'utf-8'));
      return n && n.key && n.ts ? n : null;
    } catch {
      return null;
    }
  }

  private writeNotice(n: Notice): void {
    try {
      fs.mkdirSync(this.stateDir, { recursive: true });
      fs.writeFileSync(path.join(this.stateDir, NOTICE_FILE), JSON.stringify(n, null, 2), 'utf-8');
    } catch (e) {
      // 못 적으면 다음 회차에 한 번 더 알린다 — 안 알리는 것보다 낫다.
      this.logger.warn('알림 표시를 못 적었습니다', e as Error);
    }
  }

  private readAlert(): { since: string; detail: string } | null {
    try {
      const items = JSON.parse(
        fs.readFileSync(path.join(this.stateDir, 'operator-action-needed.json'), 'utf-8'));
      const it = Array.isArray(items) ? items.find((i: any) => i?.id === ALERT_ID) : null;
      return it ? { since: String(it.since || ''), detail: String(it.detail || '') } : null;
    } catch {
      return null;   // 큐가 아직 없거나 깨졌다 — 알림은 부수 신호라 조용히 넘긴다.
    }
  }

  /** 버튼 없는 본문 — `blocks` 를 안 주면 슬랙이 이전 블록(버튼)을 그대로 두므로 명시한다. */
  private plainBlocks(text: string): any[] {
    return [{ type: 'section', text: { type: 'mrkdwn', text } }];
  }

  private buttonBlocks(text: string): any[] {
    return [
      { type: 'section', text: { type: 'mrkdwn', text } },
      { type: 'actions', elements: [{
        type: 'button', style: 'primary',
        text: { type: 'plain_text', text: '🔑 다우 로그인' },
        action_id: ACTION_ID, value: ALERT_ID,
      }] },
    ];
  }

  /** 감시기 주기(몇 분)마다 불린다. 파일 두 개를 읽을 뿐이라 싸다. */
  async poll(): Promise<void> {
    const alert = this.readAlert();
    const notice = this.readNotice();

    if (!alert) {
      // 마커가 걷혔다 — 열려 있던 알림을 해소로 고친다(하루 뒤에 보는 사람이 옛 🔴 를 안 믿게).
      if (notice && !notice.resolvedAt) {
        const when = new Date().toISOString().slice(11, 16);
        const done = `✅ 다우 세션 살아 있음 — 해소 (${when})`;
        await this.updateMessage(notice.ts, done, this.plainBlocks(done)).catch(() => {});
        this.writeNotice({ ...notice, resolvedAt: new Date().toISOString() });
      }
      return;
    }

    const key = `${ALERT_ID}:${alert.since || 'unknown'}`;
    if (notice && notice.key === key) return;   // 이 만료는 이미 알렸다

    const text = [
      '🔴 *다우 세션 만료* — 그룹웨어 적재가 멈춰 있습니다',
      '버튼을 누르면 *이 PC 에* 로그인 창이 뜹니다 · 5분 안에 계정·비밀번호·보안문자',
      '지금 당장이 아니어도 됩니다 — 나중에 눌러도 그때 상태를 다시 보고 엽니다',
    ].join('\n');
    try {
      const ts = await this.sendMessage(text, this.buttonBlocks(text));
      this.writeNotice({ key, ts });
      this.logger.info('다우 세션 만료 알림', { key });
    } catch (e) {
      this.logger.error('다우 만료 알림을 못 보냈습니다', e as Error);
    }
  }

  /** 버튼. `ack()` 는 부르는 쪽이 먼저 보낸다. */
  async handleAction(messageTs: string): Promise<void> {
    if (this.inFlight) {
      const busy = '⏳ 이미 로그인 창이 열려 있습니다 — 그 창에서 로그인하세요';
      await this.updateMessage(messageTs, busy, this.plainBlocks(busy)).catch(() => {});
      return;
    }
    this.inFlight = true;
    try {
      // 하루 뒤에 눌렀을 수 있다 — 그사이 다른 길로 로그인했으면 창을 띄울 이유가 없다.
      const alive = await this.probeAlive();
      if (alive) {
        const already = '✅ 다우 세션이 이미 살아 있습니다 (다른 곳에서 로그인됨) — 알림을 내립니다';
        await this.updateMessage(messageTs, already, this.plainBlocks(already));
        await this.clearAlert();
        return;
      }

      const opened = '⏳ 이 PC 에 로그인 창을 띄웠습니다 — 5분 안에 계정·비밀번호·보안문자를 넣으세요';
      await this.updateMessage(messageTs, opened, this.plainBlocks(opened));
      const result = await this.runLogin();
      if (!result.ok) {
        const text = result.timedOut
          ? '⚠️ 5분 안에 로그인이 없어 창을 닫았습니다 — 다시 누르면 다시 엽니다'
          : `⚠️ 로그인 창을 못 띄웠습니다 — ${result.error}\n다시 누르면 다시 시도합니다`;
        await this.updateMessage(messageTs, text, this.buttonBlocks(text));
        return;
      }

      const when = new Date().toISOString().slice(11, 16);
      const head = `✅ 다우 로그인 됨 (${when}) · 쿠키 ${result.cookies ?? '?'}개`;
      await this.updateMessage(messageTs, `${head} · 밀린 적재 확인 중…`,
        this.plainBlocks(`${head} · 밀린 적재 확인 중…`));
      const sync = await this.runCatchUp();
      await this.updateMessage(messageTs, `${head} · ${sync}`, this.plainBlocks(`${head} · ${sync}`));
      const notice = this.readNotice();
      if (notice && notice.ts === messageTs) {
        this.writeNotice({ ...notice, resolvedAt: new Date().toISOString() });
      }
    } catch (e) {
      const text = `⚠️ 처리 중 오류 — ${(e as Error).message}\n다시 누르면 다시 시도합니다`;
      await this.updateMessage(messageTs, text, this.buttonBlocks(text)).catch(() => {});
    } finally {
      this.inFlight = false;
    }
  }

  private async probeAlive(): Promise<boolean> {
    try {
      const { stdout } = await execAsync(
        'python -X utf8 -m mycelium.utils.daou_auth alive', { cwd: this.repo, timeout: 60_000 });
      return Boolean(JSON.parse(stdout.trim().split('\n').pop() || '{}').alive);
    } catch {
      return false;   // rc 1 = 만료. 예외도 만료로 본다 — 창을 띄우는 쪽이 안전하다.
    }
  }

  /**
   * 헤드 브라우저를 띄우고 로그인을 기다린다. 파이썬 쪽 `wait_for_url` 이 5분이라
   * 여기 상한은 그보다 넉넉히 둔다 — 여기서 먼저 끊으면 창만 남고 아무도 안 닫는다.
   */
  private async runLogin(): Promise<{ ok: boolean; timedOut?: boolean; error?: string; cookies?: number }> {
    try {
      const { stdout } = await execAsync(
        'python -X utf8 -m mycelium.utils.daou_auth login', { cwd: this.repo, timeout: 360_000 });
      const m = /Saved (\d+) cookies/.exec(stdout);
      return { ok: /로그인 성공/.test(stdout), cookies: m ? Number(m[1]) : undefined,
               error: /로그인 성공/.test(stdout) ? undefined : stdout.trim().slice(-200) };
    } catch (e: any) {
      const out = String(e?.stdout || '') + String(e?.stderr || '');
      if (/Timeout 300000ms exceeded/.test(out) || e?.killed) return { ok: false, timedOut: true };
      return { ok: false, error: (out.trim().split('\n').pop() || String(e?.message || e)).slice(0, 200) };
    }
  }

  /** 로그인 뒤 그날 몫을 바로 적재하고 마커를 걷는다. 러너와 같은 cwd·모듈 경로. */
  private async runCatchUp(): Promise<string> {
    try {
      const { stdout } = await execAsync('python -X utf8 -m sync.groupware_daily --json',
        { cwd: path.join(this.repo, 'mycelium'), timeout: 900_000 });
      const r = JSON.parse(stdout.trim().split('\n').pop() || '{}');
      if (r.session_expired) return '⚠️ 적재 단계에서 세션이 다시 만료로 읽혔습니다 — 다음 회차에 확인';
      return `적재 새 글 ${r.fetched_new ?? 0}건 · 문서 ${r.ingested_docs ?? 0}건 · 알림 해소`;
    } catch (e) {
      // 적재는 다음 회차가 메운다 — 마커만이라도 걷어 옛 🔴 가 안 남게 한다.
      await this.clearAlert();
      return `적재는 못 돌렸습니다(${(e as Error).message.slice(0, 80)}) — 다음 회차가 메웁니다 · 알림 해소`;
    }
  }

  private async clearAlert(): Promise<void> {
    try {
      await execAsync('python -X utf8 -m sync.groupware_daily --keepalive --json',
        { cwd: path.join(this.repo, 'mycelium'), timeout: 120_000 });
    } catch (e) {
      this.logger.warn('마커 해소(keepalive) 실패 — 다음 정기 핑이 걷는다', e as Error);
    }
  }
}
