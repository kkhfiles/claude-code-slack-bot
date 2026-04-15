import { exec } from 'child_process';
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
}

/** Pending kill confirmation state */
interface PendingKill {
  pid: number;
  name: string;
  commitMB: number;
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
    private sendMessage: SendMessageFn,
    private updateMessage: UpdateMessageFn,
    private onProcessKilled?: OnProcessKilledFn,
  ) {}

  start(): void {
    if (process.platform !== 'win32') {
      this.logger.info('Memory watchdog is Windows-only, skipping');
      return;
    }
    this.logger.info(`Memory watchdog started (threshold: ${this.thresholdPct}%, interval: ${this.checkIntervalSec}s, autoKill: ${this.autoKillDelaySec}s)`);
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

  /** Called from Slack action handler when user clicks [Kill] */
  async handleKillAction(pid: number): Promise<void> {
    const pending = this.pendingKills.get(pid);
    if (!pending) return;

    clearTimeout(pending.timer);
    this.pendingKills.delete(pid);

    const killed = this.killProcess(pid);
    const text = killed
      ? t('watchdog.killed', this.locale, { pid: String(pid), name: pending.name, commitMB: String(pending.commitMB) })
      : t('watchdog.alreadyGone', this.locale, { pid: String(pid), name: pending.name });

    await this.updateMessage(pending.messageTs, text).catch(e =>
      this.logger.error('Failed to update watchdog message', e),
    );

    if (killed) {
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

  private async checkMemory(): Promise<void> {
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

    if (status.usagePct < this.thresholdPct) {
      this.logger.debug(`System commit: ${status.committedMB.toLocaleString()}/${status.limitMB.toLocaleString()} MB (${status.usagePct}%) — OK`);
      return;
    }

    // Threshold breached
    this.logger.warn(`System commit HIGH: ${status.committedMB.toLocaleString()}/${status.limitMB.toLocaleString()} MB (${status.usagePct}%) — threshold ${this.thresholdPct}%`);

    const processes = await this.getTopProcesses(20);
    if (processes.length === 0) return;

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

    if (candidates.length === 0) {
      this.logger.warn('No killable candidates found despite high commit usage');
      return;
    }

    // Target the largest process
    const target = candidates[0]; // already sorted descending by commitMB
    await this.sendKillConfirmation(target, status);
  }

  private async sendKillConfirmation(target: ProcessInfo, status: CommitStatus): Promise<void> {
    const text = t('watchdog.confirm', this.locale, {
      committedMB: status.committedMB.toLocaleString(),
      limitMB: status.limitMB.toLocaleString(),
      pct: String(status.usagePct),
      pid: String(target.pid),
      name: target.name,
      commitMB: String(target.commitMB.toLocaleString()),
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

      const killed = this.killProcess(target.pid);
      const autoText = killed
        ? t('watchdog.autoKill', this.locale, { pid: String(target.pid), name: target.name, commitMB: String(target.commitMB), minutes: String(Math.round(this.autoKillDelaySec / 60)) })
        : t('watchdog.alreadyGone', this.locale, { pid: String(target.pid), name: target.name });

      await this.updateMessage(pending.messageTs, autoText).catch(e =>
        this.logger.error('Failed to update watchdog auto-kill message', e),
      );

      if (killed) {
        this.onProcessKilled?.(target.pid, target.name);
        errorCollector.add('MemoryWatchdog', `Auto-killed ${target.name} (PID ${target.pid}, ${target.commitMB} MB) after ${this.autoKillDelaySec}s timeout`);
      }
    }, this.autoKillDelaySec * 1000);

    this.pendingKills.set(target.pid, {
      pid: target.pid,
      name: target.name,
      commitMB: target.commitMB,
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
        { timeout: 10_000 },
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
        { timeout: 10_000 },
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
      const { stdout } = await execAsync(
        `powershell -NoProfile -Command "Get-Process | Where-Object { $_.PM -gt 100MB } | Sort-Object PM -Descending | Select-Object -First ${count} Id,Name,PM | ConvertTo-Csv -NoTypeInformation"`,
        { timeout: 15_000 },
      );
      const lines = stdout.trim().split('\n');
      if (lines.length < 2) return []; // header only or empty

      const results: ProcessInfo[] = [];
      // Skip header line ("Id","Name","PM")
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        // CSV: "pid","name","pm_bytes"
        const match = line.match(/^"(\d+)","([^"]+)","(\d+)"$/);
        if (match) {
          results.push({
            pid: parseInt(match[1], 10),
            name: match[2],
            commitMB: Math.round(parseInt(match[3], 10) / (1024 * 1024)),
          });
        }
      }
      return results;
    } catch (e) {
      this.logger.error('Failed to query top processes', e);
      return [];
    }
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
