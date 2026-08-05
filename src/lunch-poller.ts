import { spawn } from 'child_process';
import * as path from 'path';
import Holidays from 'date-holidays';
import { Logger } from './logger';

/**
 * Periodically runs the lunch bot script (`lunch_bot.py tick`).
 *
 * The script decides for itself what to do based on the clock — post the
 * recruitment message, attach vote emoji to new proposals, or tally and
 * announce the result. This poller only decides *whether it is worth asking*:
 * weekdays, outside Korean public holidays, within the daily window.
 *
 * The script owns its own Slack token and channel (a separate bot identity),
 * so nothing here touches this bot's Slack client.
 */
export class LunchPoller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private logger = new Logger('LunchPoller');
  private holidays = new Holidays('KR');

  constructor(
    private readonly pythonPath: string,
    private readonly scriptPath: string,
    private readonly intervalMinutes: number,
    private readonly windowStart: string,   // "HH:MM"
    private readonly windowEnd: string,     // "HH:MM"
  ) {}

  start(): void {
    if (this.timer) return;

    const intervalMs = Math.max(1, this.intervalMinutes) * 60 * 1000;
    this.timer = setInterval(() => {
      this.tick().catch((error) => this.logger.warn('Lunch tick failed', error));
    }, intervalMs);

    this.logger.info('Lunch poller started', {
      script: this.scriptPath,
      everyMinutes: this.intervalMinutes,
      window: `${this.windowStart}~${this.windowEnd}`,
    });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.logger.info('Lunch poller stopped');
    }
  }

  /** Weekend or Korean public holiday — the office is closed, so no lunch run. */
  private isNonWorkingDay(date: Date): string | null {
    const day = date.getDay();
    if (day === 0) return 'Sunday';
    if (day === 6) return 'Saturday';

    const result = this.holidays.isHoliday(date);
    if (Array.isArray(result)) {
      const publicHoliday = result.find((h) => h.type === 'public');
      if (publicHoliday) return publicHoliday.name;
    }
    return null;
  }

  private static hhmm(date: Date): string {
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  }

  private async tick(): Promise<void> {
    // A previous run has not finished (network stall). Skip rather than pile up.
    if (this.running) {
      this.logger.debug('Previous lunch run still in progress, skipping');
      return;
    }

    const now = new Date();
    const closed = this.isNonWorkingDay(now);
    if (closed) return;

    const nowHhmm = LunchPoller.hhmm(now);
    if (nowHhmm < this.windowStart || nowHhmm > this.windowEnd) return;

    this.running = true;
    try {
      await this.runScript();
    } finally {
      this.running = false;
    }
  }

  private runScript(): Promise<void> {
    return new Promise((resolve) => {
      const child = spawn(this.pythonPath, [this.scriptPath, 'tick'], {
        cwd: path.dirname(this.scriptPath),
        env: {
          ...process.env,
          // The script prints Korean; without this Windows defaults to cp949
          // and the captured output comes back mangled.
          PYTHONIOENCODING: 'utf-8',
        },
        windowsHide: true,
      });

      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

      // A hung request should not block the next tick forever.
      const killTimer = setTimeout(() => child.kill(), 90 * 1000);

      child.on('error', (error) => {
        clearTimeout(killTimer);
        this.logger.warn('Failed to run lunch script', error);
        resolve();
      });

      child.on('close', (code) => {
        clearTimeout(killTimer);
        const output = stdout.trim();
        if (code === 0) {
          // Quiet by design: the script prints nothing on an idle tick.
          if (output) this.logger.info(`Lunch: ${output}`);
        } else {
          this.logger.warn(`Lunch script exited with ${code}`, {
            stdout: output,
            stderr: stderr.trim(),
          });
        }
        resolve();
      });
    });
  }
}
