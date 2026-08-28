import { exec } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { Logger } from './logger';
import { errorCollector } from './error-collector';
import { t, Locale } from './messages';

const execAsync = promisify(exec);

/** Process info from OS query */
interface ProcessInfo {
  pid: number;
  name: string;
  commitMB: number;
  /** 프로세스 인스턴스 식별자. PID 는 재사용되므로 이것과 짝지어야 같은 놈인지 안다.
   *
   *  **문자열이다.** ticks 는 19자리라 JS 의 안전 정수 범위(2^53)를 넘어, 숫자로 받으면
   *  값이 뭉개져 원래 값과 다시 비교했을 때 늘 어긋난다 — 그러면 감시기가 겉보기엔
   *  멀쩡한데 아무것도 못 죽인다(실측으로 잡았다).
   *  빈 문자열·'0' = 읽지 못함(권한). 확인 못 한 것은 죽이지 않는다. */
  startTicks: string;
}

/** Pending kill confirmation state */
interface PendingKill {
  pid: number;
  name: string;
  commitMB: number;
  startTicks: string;
  messageTs: string;
  timer: ReturnType<typeof setTimeout>;
}

/** System commit memory status */
interface CommitStatus {
  committedMB: number;
  limitMB: number;
  usagePct: number;
}

/** Callback types */
type SendMessageFn = (text: string, blocks?: any[]) => Promise<string>;
type UpdateMessageFn = (ts: string, text: string, blocks?: any[]) => Promise<void>;
type OnProcessKilledFn = (pid: number, name: string) => void;

/**
 * 알림에 붙는 조치 버튼. **한 번 눌러 되돌릴 수 있는 것만** 버튼으로 낸다.
 *
 * 없는 것에 이유가 있다 — 핸들 누수(`winhealth-handles`)는 2026-08-28 사건에서
 * 누수 주체가 사내 네트워크 접근 제어 서비스였고 표준 사용자에게 중지 권한이
 * 없었다. 버튼으로 끊으면 네트워크가 잠깐 끊기므로 사람이 절차를 보고 판단한다.
 * 메모리 고갈 이벤트도 이미 일어난 일의 기록이라 되돌릴 대상이 아니다.
 *
 * **가동 일수에는 알림 자체가 없다**(2026-08-28 폐기). 오래 켜 둔 것은 고장이 아니라
 * 상관 지표라, 실제로 나빠진 것이 없는데도 재부팅할 때까지 계속 뜨는 경고가 됐다.
 * 재시작 버튼은 재시작이 실제로 고치는 항목(커밋 압박)에만 남긴다.
 *
 * 재시작은 두 단계다. 슬랙 버튼은 휴대폰에서 잘못 눌리고, 그 한 번이 저장 안 한
 * 작업을 날린다. 예약 뒤에도 지연 시간 안에는 취소 버튼이 남는다.
 */
const HEALTH_FIX_BUTTONS: Record<string, Array<{
  label: string; actionId: string; style?: 'primary' | 'danger';
}>> = {
  'winhealth-explorer': [
    { label: '🧹 유령 Explorer 정리', actionId: 'health_fix_explorer', style: 'primary' },
  ],
  'winhealth-watchers': [
    { label: '🧹 오래된 감시 프로세스 정리', actionId: 'health_fix_watchers', style: 'primary' },
  ],
  'winhealth-commit': [
    { label: '🧹 유령 Explorer 정리', actionId: 'health_fix_explorer', style: 'primary' },
    { label: '🧹 감시 프로세스 정리', actionId: 'health_fix_watchers' },
    { label: '🔄 재시작 예약', actionId: 'health_reboot_ask', style: 'danger' },
  ],
};

// System processes that must never be killed
const PROTECTED_PROCESSES = new Set([
  'system', 'idle', 'smss', 'csrss', 'wininit', 'winlogon',
  'lsass', 'services', 'svchost', 'dwm', 'fontdrvhost',
  'sihost', 'ctfmon', 'conhost', 'wudfhost', 'taskhostw',
  'runtimebroker', 'searchhost', 'startmenuexperiencehost',
  'textinputhost', 'shellexperiencehost', 'memory compression',
  'registry', 'secure system', 'ntoskrnl',
]);

export class ProcessMemoryWatchdog {
  private checkTimer: ReturnType<typeof setInterval> | null = null;
  private pendingKills: Map<number, PendingKill> = new Map();
  private excludedPids: Set<number> = new Set();
  private cachedCommitLimitMB: number = 0;
  private logger = new Logger('MemoryWatchdog');
  private locale: Locale = 'ko';

  constructor(
    private thresholdPct: number,
    private checkIntervalSec: number,
    private autoKillDelaySec: number,
    private processThresholdMB: number,
    private sendMessage: SendMessageFn,
    private updateMessage: UpdateMessageFn,
    private onProcessKilled?: OnProcessKilledFn,
  ) {}

  start(): void {
    if (process.platform !== 'win32') {
      this.logger.info('Memory watchdog is Windows-only, skipping');
      return;
    }
    this.logger.info(`Memory watchdog started (threshold: ${this.thresholdPct}%, processThreshold: ${this.processThresholdMB} MB, interval: ${this.checkIntervalSec}s, autoKill: ${this.autoKillDelaySec}s)`);
    // Run first check after a short delay
    setTimeout(() => this.checkMemory().catch(e => this.logger.error('Memory check failed', e)), 10_000);
    this.checkTimer = setInterval(
      () => this.checkMemory().catch(e => this.logger.error('Memory check failed', e)),
      this.checkIntervalSec * 1000,
    );
  }

  stop(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
    for (const [, pending] of this.pendingKills) {
      clearTimeout(pending.timer);
    }
    this.pendingKills.clear();
    this.logger.info('Memory watchdog stopped');
  }

  /**
   * 알림 버튼 처리. 실제 조치는 파이썬 쪽(`windows_health_fix`)이 한다 — 대상을
   * 고르는 규칙(주 탐색기 보존·나이 기준)이 점검 쪽과 한 벌이어야 하는데, 여기에
   * 옮겨 적으면 둘이 갈라진다.
   *
   * 결과는 원래 메시지를 **고쳐서** 보여 준다. 새 메시지를 붙이면 버튼이 남아 두 번
   * 눌리고, 이미 정리한 것을 또 정리하려 든다.
   */
  async handleHealthFixAction(actionId: string, messageTs: string): Promise<void> {
    const ACTIONS: Record<string, { arg: string; apply: boolean; label: string }> = {
      health_fix_explorer: { arg: 'explorer', apply: true, label: '유령 Explorer 정리' },
      health_fix_watchers: { arg: 'watchers', apply: true, label: '감시 프로세스 정리' },
      health_reboot_confirm: { arg: 'reboot', apply: true, label: '재시작 예약' },
      health_reboot_cancel: { arg: 'reboot-cancel', apply: true, label: '재시작 취소' },
    };
    const spec = ACTIONS[actionId];
    if (!spec) return;

    await this.updateMessage(messageTs, `⏳ ${spec.label} 중…`).catch(() => {});

    let line: string;
    try {
      line = await this.runHealthFix(spec.arg, spec.apply);
    } catch (e) {
      line = `⚠️ ${spec.label} 실패 — ${(e as Error).message}`;
    }

    // 재시작을 예약했으면 지연 시간 안에 되돌릴 길을 같은 메시지에 남긴다.
    const blocks: any[] = [{ type: 'section', text: { type: 'mrkdwn', text: line } }];
    if (actionId === 'health_reboot_confirm' && !line.startsWith('⚠️')) {
      blocks.push({ type: 'actions', elements: [{
        type: 'button', text: { type: 'plain_text', text: '↩️ 재시작 취소' },
        action_id: 'health_reboot_cancel', value: 'cancel',
      }] });
    }
    await this.updateMessage(messageTs, line, blocks).catch(e =>
      this.logger.error('Failed to update health fix message', e as Error));
    this.logger.info('Health fix action done', { actionId, result: line });
  }

  /** 재시작은 두 단계. 첫 버튼은 묻기만 하고 아무것도 예약하지 않는다. */
  async handleRebootAsk(messageTs: string): Promise<void> {
    const text = [
      '🔄 *재시작을 예약할까요?*',
      '',
      '예약하면 60초 뒤에 이 PC가 재시작합니다. 저장 안 한 작업이 있으면 먼저 저장하세요.',
      '예약 뒤에도 60초 안에는 취소 버튼으로 되돌릴 수 있습니다.',
    ].join('\n');
    const blocks = [
      { type: 'section', text: { type: 'mrkdwn', text } },
      { type: 'actions', elements: [
        { type: 'button', text: { type: 'plain_text', text: '🔄 60초 뒤 재시작' },
          style: 'danger', action_id: 'health_reboot_confirm', value: 'confirm' },
        { type: 'button', text: { type: 'plain_text', text: '취소' },
          action_id: 'health_dismiss', value: 'dismiss' },
      ] },
    ];
    await this.updateMessage(messageTs, text, blocks).catch(e =>
      this.logger.error('Failed to ask reboot', e as Error));
  }

  /** 버튼을 거둔다. 조치는 안 한다. */
  async handleHealthDismiss(messageTs: string): Promise<void> {
    await this.updateMessage(messageTs, '조치하지 않았습니다. 아침 브리핑에 계속 뜹니다.')
      .catch(() => {});
  }

  private runHealthFix(action: string, apply: boolean): Promise<string> {
    const repo = process.env.MYCELIUM_REPO || 'P:/github/claude-workflow';
    const argv = ['-X', 'utf8', '-m', 'mycelium.batch.windows_health_fix', action];
    if (apply) argv.push('--apply');
    return new Promise((resolve, reject) => {
      execAsync(`python ${argv.join(' ')}`, { cwd: repo, timeout: 180_000 })
        .then(({ stdout }) => resolve(stdout.trim() || '(출력 없음)'))
        .catch(err => reject(err));
    });
  }

  /** Called from Slack action handler when user clicks [Kill] */
  async handleKillAction(pid: number): Promise<void> {
    const pending = this.pendingKills.get(pid);
    if (!pending) return;

    clearTimeout(pending.timer);
    this.pendingKills.delete(pid);

    // 버튼은 그 메시지가 남아 있는 한 언제든 눌린다 — 잡아 둘 때와 같은 프로세스인지
    // 지금 다시 본다.
    const outcome = this.killIfSame(pid, pending.name, pending.startTicks);
    const text = outcome === 'killed'
      ? t('watchdog.killed', this.locale, { pid: String(pid), name: pending.name, commitMB: String(pending.commitMB) })
      : outcome === 'gone'
        ? t('watchdog.alreadyGone', this.locale, { pid: String(pid), name: pending.name })
        : outcome === 'recycled'
          ? `PID ${pid} 은 이제 다른 프로세스입니다 — ${pending.name} 은 이미 끝났고 번호가 재사용됐습니다. 죽이지 않았습니다.`
          : `PID ${pid} (${pending.name}) 종료 실패 — 권한이거나 확인이 안 됐습니다.`;

    await this.updateMessage(pending.messageTs, text).catch(e =>
      this.logger.error('Failed to update watchdog message', e),
    );

    if (outcome === 'killed') {
      this.onProcessKilled?.(pid, pending.name);
      this.logger.info(`Process killed by user: ${pending.name} (PID ${pid}, ${pending.commitMB} MB)`);
    }
  }

  /** Called from Slack action handler when user clicks [Ignore] */
  async handleIgnoreAction(pid: number): Promise<void> {
    const pending = this.pendingKills.get(pid);
    if (!pending) return;

    clearTimeout(pending.timer);
    this.pendingKills.delete(pid);

    const text = t('watchdog.ignored', this.locale, { pid: String(pid), name: pending.name });
    await this.updateMessage(pending.messageTs, text).catch(e =>
      this.logger.error('Failed to update watchdog message', e),
    );
    this.logger.info(`Process kept by user: ${pending.name} (PID ${pid})`);
  }

  /** Called from Slack action handler when user clicks [Exclude] */
  async handleExcludeAction(pid: number): Promise<void> {
    const pending = this.pendingKills.get(pid);
    if (!pending) return;

    clearTimeout(pending.timer);
    this.pendingKills.delete(pid);

    this.excludedPids.add(pid);

    const text = t('watchdog.excluded', this.locale, { pid: String(pid), name: pending.name });
    await this.updateMessage(pending.messageTs, text).catch(e =>
      this.logger.error('Failed to update watchdog message', e),
    );
    this.logger.info(`PID ${pid} (${pending.name}) excluded from watchdog`);
  }

  // --- Private methods ---

  /**
   * 데일리 시스템 점검(`mycelium.batch.windows_health_check`)이 남긴 큐를 읽어
   * **이미 메모리에 진단·절차가 적힌 문제**만 알린다.
   *
   * 왜 여기냐 — 이 감시기가 이미 「시스템 이상 → 스탠리」 경로를 갖고 있다. 두 번째
   * 발송 경로를 만들면 토큰과 채널 설정이 두 군데가 된다.
   *
   * 왜 나눠 보나 — 이 감시기가 보는 것은 **한 프로세스가 임계를 넘는 급성 상태**다.
   * 커밋 80%에 140MB짜리 프로세스가 55개인 상태는 여기 안 걸린다(2026-08-28 사건이
   * 그랬고, 이 감시기는 그때 `— OK`를 찍었다). 그 축은 파이썬 점검이 재고 결과만
   * 여기로 온다.
   *
   * 처음 보는 증상은 큐에 안 들어온다 — 절차가 없으면 즉시 알려도 할 수 있는 일이
   * 조사뿐이라, 그건 아침 브리핑 몫이다.
   */
  private async reportKnownIssues(): Promise<void> {
    const stateDir = path.join(
      process.env.USERPROFILE || process.env.HOME || '', '.claude', 'state');
    const queueFile = path.join(stateDir, 'windows-health-latest.json');
    const sentFile = path.join(stateDir, 'stanley-notified.json');

    let queue: any;
    try {
      queue = JSON.parse(fs.readFileSync(queueFile, 'utf-8'));
    } catch {
      return;   // 점검이 아직 안 돌았거나 파일이 깨졌다. 알림은 부수 신호라 조용히 넘긴다.
    }
    const items: any[] = Array.isArray(queue?.notify) ? queue.notify : [];
    if (items.length === 0) return;

    // 보낸 표시는 **봇만** 쓴다. 파이썬이 같은 파일을 고치면 어느 쪽 쓰기가 이기는지가
    // 타이밍에 달리고, 그러면 알림이 사라지거나 두 번 간다.
    let sent: string[] = [];
    try {
      const parsed = JSON.parse(fs.readFileSync(sentFile, 'utf-8'));
      if (Array.isArray(parsed)) sent = parsed;
    } catch {
      sent = [];
    }
    const sentSet = new Set(sent);
    const fresh = items.filter(i => i?.key && !sentSet.has(i.key));
    if (fresh.length === 0) return;

    for (const item of fresh) {
      const mark = item.severity === 'action' ? '🔴' : '🟡';
      const refs: string[] = (item.refs || [])
        .map((r: any) => `• 진단·복구 절차: \`${r.path}\``);
      const text = [
        `${mark} *시스템 점검 — 전에 진단해 둔 문제가 다시 잡혔습니다*`,
        '',
        `*${item.title}*`,
        item.detail,
        '',
        `현재 상태: ${item.summary}`,
        ...refs,
      ].join('\n');

      const blocks: any[] = [{ type: 'section', text: { type: 'mrkdwn', text } }];
      const buttons = HEALTH_FIX_BUTTONS[item.id];
      if (buttons?.length) {
        blocks.push({ type: 'actions', elements: buttons.map(b => ({
          type: 'button',
          text: { type: 'plain_text', text: b.label },
          ...(b.style ? { style: b.style } : {}),
          action_id: b.actionId,
          value: item.key,
        })) });
      }

      try {
        await this.sendMessage(text, blocks.length > 1 ? blocks : undefined);
        sentSet.add(item.key);
        this.logger.info('Known issue reported to Slack', { key: item.key });
      } catch (e) {
        // 못 보냈으면 보낸 표시를 하지 않는다 — 다음 회차에 다시 시도한다.
        this.logger.error('Failed to report known issue', e as Error);
      }
    }

    // 키에 날짜가 들어 있어 무한히 늘지 않지만, 지난 날짜가 쌓이면 파일만 커진다.
    const today = new Date();
    const cutoff = new Date(today.getTime() - 14 * 86_400_000)
      .toISOString().slice(0, 10);
    const kept = Array.from(sentSet).filter(k => (k.split(':')[1] || '') >= cutoff);
    try {
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(sentFile, JSON.stringify(kept, null, 2), 'utf-8');
    } catch {
      // 표시를 못 남기면 다음 회차에 한 번 더 간다. 안 가는 것보다 낫다.
    }
  }

  private async checkMemory(): Promise<void> {
    // 파이썬 점검 결과를 먼저 흘려보낸다. 아래 급성 판정과는 보는 축이 달라
    // 서로의 결과에 기대지 않는다 — 한쪽이 실패해도 다른 쪽은 그대로 돈다.
    await this.reportKnownIssues().catch(e =>
      this.logger.error('Known issue report failed', e as Error));

    // Clean up pendingKills for processes that have already exited
    for (const [pid, pending] of this.pendingKills) {
      const alive = await this.isProcessAlive(pid);
      if (!alive) {
        clearTimeout(pending.timer);
        this.pendingKills.delete(pid);
        await this.updateMessage(pending.messageTs,
          t('watchdog.alreadyGone', this.locale, { pid: String(pid), name: pending.name }),
        ).catch(() => {});
      }
    }

    const status = await this.getSystemCommitStatus();
    if (!status) return;

    const systemHigh = status.usagePct >= this.thresholdPct;

    const processes = await this.getTopProcesses(20);
    if (processes.length === 0) {
      if (!systemHigh) {
        this.logger.debug(`System commit: ${status.committedMB.toLocaleString()}/${status.limitMB.toLocaleString()} MB (${status.usagePct}%) — OK`);
      }
      return;
    }

    // Clean up excluded PIDs for processes that have exited
    for (const pid of this.excludedPids) {
      if (!processes.some(p => p.pid === pid)) {
        this.excludedPids.delete(pid);
      }
    }

    // Filter out protected processes, excluded PIDs, our own PID, and already-pending PIDs
    const myPid = process.pid;
    const candidates = processes.filter(p =>
      p.pid !== myPid &&
      !PROTECTED_PROCESSES.has(p.name.toLowerCase()) &&
      !this.excludedPids.has(p.pid) &&
      !this.pendingKills.has(p.pid),
    );

    const target = candidates[0]; // already sorted descending by commitMB
    const processHigh = target !== undefined && target.commitMB >= this.processThresholdMB;

    if (!systemHigh && !processHigh) {
      this.logger.debug(`System commit: ${status.committedMB.toLocaleString()}/${status.limitMB.toLocaleString()} MB (${status.usagePct}%) — OK`);
      return;
    }

    if (systemHigh) {
      this.logger.warn(`System commit HIGH: ${status.committedMB.toLocaleString()}/${status.limitMB.toLocaleString()} MB (${status.usagePct}%) — threshold ${this.thresholdPct}%`);
    }
    if (processHigh && !systemHigh) {
      this.logger.warn(`Process commit HIGH: ${target!.name} (PID ${target!.pid}, ${target!.commitMB} MB) — threshold ${this.processThresholdMB} MB`);
    }

    if (!target) {
      this.logger.warn('No killable candidates found despite high commit usage');
      return;
    }

    await this.sendKillConfirmation(target, status, processHigh && !systemHigh);
  }

  private async sendKillConfirmation(target: ProcessInfo, status: CommitStatus, processOnly: boolean): Promise<void> {
    const text = t(processOnly ? 'watchdog.confirmProcess' : 'watchdog.confirm', this.locale, {
      committedMB: status.committedMB.toLocaleString(),
      limitMB: status.limitMB.toLocaleString(),
      pct: String(status.usagePct),
      pid: String(target.pid),
      name: target.name,
      commitMB: String(target.commitMB.toLocaleString()),
      processThresholdMB: this.processThresholdMB.toLocaleString(),
      minutes: String(Math.round(this.autoKillDelaySec / 60)),
    });

    const blocks = [
      {
        type: 'section',
        text: { type: 'mrkdwn', text },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: '🔴 Kill' },
            style: 'danger',
            action_id: 'watchdog_kill',
            value: String(target.pid),
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: '⏸️ Ignore' },
            action_id: 'watchdog_ignore',
            value: String(target.pid),
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: '🚫 Exclude' },
            action_id: 'watchdog_exclude',
            value: String(target.pid),
          },
        ],
      },
    ];

    const messageTs = await this.sendMessage(text, blocks);

    // Auto-kill timer
    const timer = setTimeout(async () => {
      const pending = this.pendingKills.get(target.pid);
      if (!pending) return;
      this.pendingKills.delete(target.pid);

      // 기본 10분 뒤에 도는 자리다. 그 사이 PID 가 재사용됐으면 쏘지 않는다.
      const outcome = this.killIfSame(target.pid, target.name, target.startTicks);
      const autoText = outcome === 'killed'
        ? t('watchdog.autoKill', this.locale, { pid: String(target.pid), name: target.name, commitMB: String(target.commitMB), minutes: String(Math.round(this.autoKillDelaySec / 60)) })
        : outcome === 'gone'
          ? t('watchdog.alreadyGone', this.locale, { pid: String(target.pid), name: target.name })
          : outcome === 'recycled'
            ? `PID ${target.pid} 은 이제 다른 프로세스입니다 — ${target.name} 은 이미 끝났습니다. 죽이지 않았습니다.`
            : `PID ${target.pid} (${target.name}) 자동 종료 실패.`;

      await this.updateMessage(pending.messageTs, autoText).catch(e =>
        this.logger.error('Failed to update watchdog auto-kill message', e),
      );

      if (outcome === 'killed') {
        this.onProcessKilled?.(target.pid, target.name);
        errorCollector.add('MemoryWatchdog', `Auto-killed ${target.name} (PID ${target.pid}, ${target.commitMB} MB) after ${this.autoKillDelaySec}s timeout`);
      }
    }, this.autoKillDelaySec * 1000);

    this.pendingKills.set(target.pid, {
      pid: target.pid,
      name: target.name,
      commitMB: target.commitMB,
      startTicks: target.startTicks,
      messageTs,
      timer,
    });

    this.logger.info(`Kill confirmation sent for ${target.name} (PID ${target.pid}, ${target.commitMB} MB)`);
  }

  private async getSystemCommitStatus(): Promise<CommitStatus | null> {
    // Cache commit limit (doesn't change without reboot/pagefile resize)
    if (this.cachedCommitLimitMB === 0) {
      const limit = await this.queryCommitLimit();
      if (limit === null) return null;
      this.cachedCommitLimitMB = limit;
    }

    const committed = await this.queryCommittedBytes();
    if (committed === null) return null;

    const usagePct = Math.round(committed / this.cachedCommitLimitMB * 1000) / 10;
    return { committedMB: Math.round(committed), limitMB: Math.round(this.cachedCommitLimitMB), usagePct };
  }

  private async queryCommitLimit(): Promise<number | null> {
    try {
      const { stdout } = await execAsync(
        'powershell -NoProfile -Command "(Get-CimInstance Win32_OperatingSystem).TotalVirtualMemorySize"',
        { timeout: 10_000, windowsHide: true },
      );
      const kb = parseInt(stdout.trim(), 10);
      if (isNaN(kb)) return null;
      return kb / 1024; // KB → MB
    } catch (e) {
      this.logger.error('Failed to query commit limit', e);
      return null;
    }
  }

  private async queryCommittedBytes(): Promise<number | null> {
    try {
      // Use Get-CimInstance (faster than Get-Counter, no admin needed)
      const { stdout } = await execAsync(
        'powershell -NoProfile -Command "$os = Get-CimInstance Win32_OperatingSystem; $os.TotalVirtualMemorySize - $os.FreeVirtualMemory"',
        { timeout: 10_000, windowsHide: true },
      );
      const kb = parseInt(stdout.trim(), 10);
      if (isNaN(kb)) return null;
      return kb / 1024; // KB → MB
    } catch (e) {
      this.logger.error('Failed to query committed bytes', e);
      return null;
    }
  }

  private async getTopProcesses(count: number): Promise<ProcessInfo[]> {
    try {
      // StartTime 을 함께 걷는다 — 죽일 때 같은 프로세스인지 확인할 유일한 근거다.
      // 보호 프로세스는 StartTime 읽기가 거부되는데, 그건 0 으로 두고 죽이지 않는다.
      const ps = `Get-Process | Where-Object { $_.PM -gt 100MB } | Sort-Object PM -Descending | Select-Object -First ${count} | ForEach-Object { $tk = 0; try { $tk = $_.StartTime.Ticks } catch { }; '{0}|{1}|{2}|{3}' -f $_.Id, $_.Name, $_.PM, $tk }`;
      const { stdout } = await execAsync(
        `powershell -NoProfile -Command "${ps.replace(/"/g, '\\"')}"`,
        { timeout: 15_000, windowsHide: true },
      );
      const results: ProcessInfo[] = [];
      for (const raw of stdout.trim().split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        const match = line.match(/^(\d+)\|(.+)\|(\d+)\|(\d+)$/);
        if (match) {
          results.push({
            pid: parseInt(match[1], 10),
            name: match[2],
            commitMB: Math.round(parseInt(match[3], 10) / (1024 * 1024)),
            startTicks: match[4],   // 문자열 그대로 — 숫자로 바꾸면 정밀도가 깨진다
          });
        }
      }
      return results;
    } catch (e) {
      this.logger.error('Failed to query top processes', e);
      return [];
    }
  }

  /**
   * **PID 만으로 쏘지 않는다.** 이 감시기는 후보를 잡아 두고 한참 뒤에 죽인다 —
   * 자동 종료는 기본 10분 뒤이고, 슬랙 버튼은 그 메시지가 남아 있는 한 언제든
   * 눌린다. 그 사이에 대상이 스스로 끝나고 Windows 가 같은 번호를 다른 프로세스에
   * 내주면, PID 로 쏜 `SIGKILL`/`taskkill /F` 가 그것을 맞힌다.
   *
   * 이름과 시작시각이 잡아 둘 때와 같을 때만 죽인다. 시작시각을 못 읽었으면(0)
   * 신원 확인이 안 된 것이라 죽이지 않는다.
   *
   * 반환값은 무슨 일이 있었는지 그대로 낸다 — 예전에는 `taskkill` 이 도는 데
   * 성공했는지만 봐서, 이미 사라진 것도 「죽였다」로 보고했다.
   */
  private killIfSame(pid: number, name: string, startTicks: string):
      'killed' | 'gone' | 'recycled' | 'failed' {
    if (!startTicks || startTicks === '0') return 'recycled';   // 확인 못 한 것은 건드리지 않는다
    try {
      const check = require('child_process').execSync(
        `powershell -NoProfile -Command "$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; `
        + `if (-not $p) { 'gone' } else { $tk = 0; try { $tk = $p.StartTime.Ticks } catch { }; `
        + `if ($p.Name -ne '${name.replace(/'/g, "''")}' -or $tk -ne ${startTicks}) { 'recycled' } else { 'same' } }"`,
        { timeout: 15_000, encoding: 'utf-8', windowsHide: true },
      ).toString().trim();
      if (check === 'gone') return 'gone';
      if (check !== 'same') return 'recycled';
    } catch {
      return 'failed';   // 확인 자체가 실패했으면 쏘지 않는다
    }
    return this.killProcess(pid) ? 'killed' : 'failed';
  }

  private killProcess(pid: number): boolean {
    try {
      process.kill(pid, 'SIGKILL');
      return true;
    } catch {
      // process.kill failed (might be elevated or already dead), try taskkill
      try {
        require('child_process').execSync(`taskkill /PID ${pid} /F`, {
          timeout: 10_000,
          stdio: 'ignore',
        });
        return true;
      } catch {
        this.logger.warn(`Failed to kill PID ${pid} — process may have already exited`);
        return false;
      }
    }
  }

  private async isProcessAlive(pid: number): Promise<boolean> {
    try {
      process.kill(pid, 0); // Signal 0 = check existence
      return true;
    } catch {
      return false;
    }
  }

}
