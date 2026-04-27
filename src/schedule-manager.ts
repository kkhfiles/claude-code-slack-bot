import * as fs from 'fs';
import * as path from 'path';
import Holidays from 'date-holidays';
import { Logger } from './logger';
import { errorCollector } from './error-collector';

export interface ScheduleEntry {
  time: string;     // "HH:MM" 24-hour format
  account: string;  // AccountId (e.g., 'account-1')
}

interface PendingFollowUp {
  time: string;     // Original schedule time
  account: string;
  fireAt: number;   // Unix timestamp ms
}

interface ScheduleConfig {
  entries: ScheduleEntry[];
  channel: string;  // Slack channel ID to post to
  userId: string;   // Slack user ID who set it up (for locale)
  pendingFollowUps?: PendingFollowUp[];
  rotationEnabled?: boolean;  // Swap accounts on alternating days for balanced usage
}

/**
 * Manages scheduled session start times.
 * At each scheduled time (with random jitter), fires a callback to start
 * a new Claude session using the haiku model with a randomized greeting.
 * Each schedule entry is associated with an account for token injection.
 */
export class ScheduleManager {
  private config: ScheduleConfig | null = null;
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly configFile: string;
  private logger = new Logger('ScheduleManager');
  private holidays = new Holidays('KR');

  // Jitter range: actual fire time = scheduled time + random(0~10 min)
  private static readonly MIN_JITTER_MS = 0;
  private static readonly MAX_JITTER_MS = 10 * 60 * 1000;

  private static readonly SAY_WORDS: string[] = [
    'hi', 'ok', 'hey', 'yo', 'go', 'yes', 'hm', 'ah', 'sup', 'wow',
  ];

  /** Pick a random greeting: 50% say "word", 50% random addition */
  static getRandomGreeting(): string {
    if (Math.random() < 0.5) {
      const words = ScheduleManager.SAY_WORDS;
      return `say "${words[Math.floor(Math.random() * words.length)]}"`;
    } else {
      const a = Math.floor(Math.random() * 9) + 1;
      const b = Math.floor(Math.random() * 9) + 1;
      return `${a}+${b}`;
    }
  }

  constructor() {
    this.configFile = path.join(__dirname, '..', '.schedule-config.json');
    this.load();
  }

  private load(): void {
    try {
      if (fs.existsSync(this.configFile)) {
        const raw = JSON.parse(fs.readFileSync(this.configFile, 'utf-8'));
        // Migrate old format: { times: string[] } → { entries: ScheduleEntry[] }
        if (raw.times && !raw.entries) {
          raw.entries = (raw.times as string[]).map((time: string) => ({ time, account: 'account-1' }));
          delete raw.times;
        }
        this.config = raw as ScheduleConfig;
        this.logger.info('Loaded schedule config', { entries: this.config.entries, channel: this.config.channel });
      }
    } catch (error) {
      errorCollector.add('ScheduleManager', `설정 파일 로드 실패: ${(error as Error).message}`);
      this.logger.error('Failed to load schedule config', error);
    }
  }

  private save(): void {
    try {
      if (this.config) {
        fs.writeFileSync(this.configFile, JSON.stringify(this.config, null, 2), 'utf-8');
      }
    } catch (error) {
      errorCollector.add('ScheduleManager', `설정 파일 저장 실패: ${(error as Error).message}`);
      this.logger.error('Failed to save schedule config', error);
    }
  }

  getConfig(): ScheduleConfig | null {
    return this.config;
  }

  getEntries(): ScheduleEntry[] {
    return this.config?.entries ?? [];
  }

  /** Whether daily rotation is enabled. */
  isRotationEnabled(): boolean {
    return this.config?.rotationEnabled === true;
  }

  /** Toggle daily rotation on/off. */
  setRotation(enabled: boolean): void {
    if (!this.config) return;
    this.config.rotationEnabled = enabled;
    this.save();
  }

  /** Check if today is a "swapped" day (odd day-of-year). */
  isSwapDay(date: Date = new Date()): boolean {
    const start = new Date(date.getFullYear(), 0, 0);
    const diff = date.getTime() - start.getTime();
    const dayOfYear = Math.floor(diff / 86400000);
    return dayOfYear % 2 === 1;
  }

  /** Get effective account after applying rotation swap. Only works with exactly 2 accounts. */
  getEffectiveAccount(account: string, date?: Date): string {
    if (!this.config?.rotationEnabled) return account;
    const uniqueAccounts = [...new Set(this.config.entries.map(e => e.account))].sort();
    if (uniqueAccounts.length !== 2) return account;
    if (!this.isSwapDay(date)) return account;
    return account === uniqueAccounts[0] ? uniqueAccounts[1] : uniqueAccounts[0];
  }

  /** Get today's effective entries (with rotation applied). */
  getEffectiveEntries(date?: Date): ScheduleEntry[] {
    return this.getEntries().map(e => ({
      ...e,
      account: this.getEffectiveAccount(e.account, date),
    }));
  }

  private static readonly SESSION_WINDOW_HOURS = 5;

  /**
   * Check if a new time falls within an existing session's 5-hour window for the SAME account.
   * Different accounts can have overlapping times.
   * Returns the conflicting time if found, null if no conflict.
   */
  findConflictingTime(time: string, account: string): string | null {
    const normalized = this.normalizeTime(time);
    if (!normalized || !this.config) return null;
    const [newH, newM] = normalized.split(':').map(Number);
    const newMinutes = newH * 60 + newM;
    for (const entry of this.config.entries) {
      if (entry.account !== account) continue; // only check same account
      if (entry.time === normalized) continue; // same time = duplicate, not conflict
      const [exH, exM] = entry.time.split(':').map(Number);
      const exMinutes = exH * 60 + exM;
      const windowEnd = exMinutes + ScheduleManager.SESSION_WINDOW_HOURS * 60;
      // Check if new time falls within [existing, existing + 5h)
      if (windowEnd <= 24 * 60) {
        if (newMinutes > exMinutes && newMinutes < windowEnd) return entry.time;
      } else {
        // Wraps past midnight (e.g., 22:00 → window ends at 03:00)
        if (newMinutes > exMinutes || newMinutes < windowEnd - 24 * 60) return entry.time;
      }
    }
    return null;
  }

  /** Add a time with associated account. Returns normalized "HH:MM" or null if invalid. */
  addTime(time: string, channel: string, userId: string, account: string): string | null {
    const normalized = this.normalizeTime(time);
    if (!normalized) return null;
    if (!this.config) {
      this.config = { entries: [{ time: normalized, account }], channel, userId };
    } else {
      const existing = this.config.entries.find(e => e.time === normalized && e.account === account);
      if (!existing) {
        this.config.entries.push({ time: normalized, account });
        this.config.entries.sort((a, b) => a.time.localeCompare(b.time) || a.account.localeCompare(b.account));
      }
      this.config.channel = channel;
      this.config.userId = userId;
    }
    this.save();
    return normalized;
  }

  /** Remove a time+account entry. Returns normalized "HH:MM" if removed, null if not found or invalid. */
  removeTime(time: string, account?: string): string | null {
    if (!this.config) return null;
    const normalized = this.normalizeTime(time);
    if (!normalized) return null;
    const before = this.config.entries.length;
    this.config.entries = this.config.entries.filter(e =>
      account ? !(e.time === normalized && e.account === account) : e.time !== normalized,
    );
    if (this.config.entries.length === before) return null;
    this.save();
    return normalized;
  }

  clearTimes(): void {
    this.cancelAll();
    if (this.config) {
      this.config.entries = [];
      this.save();
    }
  }

  /** Update target channel without changing times. Returns false if no config exists. */
  updateChannel(channel: string, userId: string): boolean {
    if (!this.config) return false;
    this.config.channel = channel;
    this.config.userId = userId;
    this.save();
    return true;
  }

  normalizeTime(time: string): string | null {
    // Accept hour-only ("6", "16") or HH:MM ("6:00", "16:30")
    const hourOnly = time.match(/^(\d{1,2})$/);
    if (hourOnly) {
      const h = parseInt(hourOnly[1], 10);
      if (h < 0 || h > 23) return null;
      return `${h.toString().padStart(2, '0')}:00`;
    }
    const match = time.match(/^(\d{1,2}):(\d{2})$/);
    if (!match) return null;
    const h = parseInt(match[1], 10);
    const m = parseInt(match[2], 10);
    if (h < 0 || h > 23 || m < 0 || m > 59) return null;
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
  }

  /** Check if a date is a non-working day (weekend or Korean public holiday). */
  private isNonWorkingDay(date: Date = new Date()): { skip: boolean; reason?: string } {
    const day = date.getDay();
    if (day === 0) return { skip: true, reason: 'Sunday' };
    if (day === 6) return { skip: true, reason: 'Saturday' };
    const result = this.holidays.isHoliday(date);
    if (Array.isArray(result)) {
      const publicHoliday = result.find(h => h.type === 'public');
      if (publicHoliday) return { skip: true, reason: publicHoliday.name };
    }
    return { skip: false };
  }

  getNextFireTime(time: string): Date {
    const [h, m] = time.split(':').map(Number);
    const now = new Date();
    const next = new Date(now);
    next.setHours(h, m, 0, 0);
    if (next <= now) {
      next.setDate(next.getDate() + 1);
    }
    return next;
  }

  /** Start all timers. Cancels existing timers first. Restores persisted follow-ups. */
  scheduleAll(callback: (channel: string, userId: string, time: string, account: string) => void): void {
    this.cancelAll();
    if (!this.config || this.config.entries.length === 0) return;
    for (const entry of this.config.entries) {
      this.scheduleOne(entry.time, this.config.channel, this.config.userId, entry.account, callback);
    }
    // Restore persisted follow-ups (survives pm2 restart)
    this.restoreFollowUps(callback);
  }

  private scheduleOne(
    time: string,
    channel: string,
    userId: string,
    account: string,
    callback: (channel: string, userId: string, time: string, account: string) => void,
  ): void {
    const timerKey = `${time}_${account}`;

    const nextFire = this.getNextFireTime(time);
    const baseMs = nextFire.getTime() - Date.now();
    const jitterMs = Math.floor(
      ScheduleManager.MIN_JITTER_MS + Math.random() * (ScheduleManager.MAX_JITTER_MS - ScheduleManager.MIN_JITTER_MS),
    );
    const msUntil = baseMs + jitterMs;
    const actualFireTime = new Date(Date.now() + msUntil);
    this.logger.info(`Scheduled session start`, {
      time,
      account,
      nextFire: nextFire.toISOString(),
      jitterMin: Math.round(jitterMs / 60000),
      actualFireTime: actualFireTime.toISOString(),
    });

    const timer = setTimeout(() => {
      // Skip on weekends and Korean public holidays
      const nonWorking = this.isNonWorkingDay();
      if (nonWorking.skip) {
        this.logger.info(`Skipping scheduled session (${nonWorking.reason})`, { time, account });
        const cfg = this.config;
        const entry = cfg?.entries.find(e => e.time === time && e.account === account);
        if (cfg && entry) {
          this.scheduleOne(time, cfg.channel, cfg.userId, entry.account, callback);
        }
        return;
      }

      const effectiveAccount = this.getEffectiveAccount(account);
      this.logger.info(`Firing scheduled session start: ${time} (account: ${account}, effective: ${effectiveAccount}, actual: ${new Date().toISOString()})`);
      try {
        callback(channel, userId, time, effectiveAccount);
      } catch (error) {
        errorCollector.add('ScheduleManager', `스케줄 콜백 에러 (${time}): ${(error as Error).message}`);
        this.logger.error(`Error in scheduled callback for ${time}`, error);
      }

      const cfg = this.config;
      const entry = cfg?.entries.find(e => e.time === time && e.account === account);
      if (cfg && entry) {
        // Schedule a follow-up 5 hours later to cover the next session window.
        const followUpJitterMs = Math.floor(
          ScheduleManager.MIN_JITTER_MS + Math.random() * (ScheduleManager.MAX_JITTER_MS - ScheduleManager.MIN_JITTER_MS),
        );
        const followUpMs = ScheduleManager.SESSION_WINDOW_HOURS * 60 * 60 * 1000 + followUpJitterMs;
        const followUpFireAt = Date.now() + followUpMs;
        this.scheduleFollowUp(time, account, followUpFireAt, callback);

        // Reschedule primary for the next day
        this.scheduleOne(time, cfg.channel, cfg.userId, entry.account, callback);
      }
    }, msUntil);

    this.timers.set(timerKey, timer);
  }

  /** Schedule a follow-up and persist it to disk so it survives restarts. */
  private scheduleFollowUp(
    time: string,
    account: string,
    fireAt: number,
    callback: (channel: string, userId: string, time: string, account: string) => void,
  ): void {
    const timerKey = `${time}_${account}`;
    const followUpKey = `${timerKey}-followup`;

    // Cancel existing follow-up if any (e.g., from previous day)
    const existing = this.timers.get(followUpKey);
    if (existing) {
      clearTimeout(existing);
      this.timers.delete(followUpKey);
    }

    const msUntil = fireAt - Date.now();
    if (msUntil <= 0) return; // Already past

    this.logger.info(`Scheduling follow-up session start for ${time}`, {
      account,
      followUpFireTime: new Date(fireAt).toISOString(),
    });

    // Persist to disk
    this.addPendingFollowUp({ time, account, fireAt });

    const followUpTimer = setTimeout(() => {
      // Skip on weekends and Korean public holidays
      const nonWorking = this.isNonWorkingDay();
      if (nonWorking.skip) {
        this.logger.info(`Skipping follow-up session (${nonWorking.reason})`, { time, account });
        this.timers.delete(followUpKey);
        this.removePendingFollowUp(time, account);
        return;
      }

      const effectiveAccount = this.getEffectiveAccount(account);
      this.logger.info(`Firing follow-up session start for ${time} (account: ${account}, effective: ${effectiveAccount}, actual: ${new Date().toISOString()})`);
      const currentCfg = this.config;
      const currentEntry = currentCfg?.entries.find(e => e.time === time && e.account === account);
      if (currentCfg && currentEntry) {
        try {
          callback(currentCfg.channel, currentCfg.userId, time, effectiveAccount);
        } catch (error) {
          errorCollector.add('ScheduleManager', `팔로우업 콜백 에러 (${time}): ${(error as Error).message}`);
          this.logger.error(`Error in follow-up callback for ${time}`, error);
        }
      }
      this.timers.delete(followUpKey);
      this.removePendingFollowUp(time, account);
    }, msUntil);
    this.timers.set(followUpKey, followUpTimer);
  }

  /** Restore persisted follow-ups after restart. */
  private restoreFollowUps(callback: (channel: string, userId: string, time: string, account: string) => void): void {
    if (!this.config?.pendingFollowUps || this.config.pendingFollowUps.length === 0) return;
    const now = Date.now();
    const valid: PendingFollowUp[] = [];
    for (const fu of this.config.pendingFollowUps) {
      if (fu.fireAt > now) {
        this.scheduleFollowUp(fu.time, fu.account, fu.fireAt, callback);
        valid.push(fu);
      } else {
        // Expired while offline — fire immediately
        const effectiveAccount = this.getEffectiveAccount(fu.account);
        this.logger.info(`Firing missed follow-up for ${fu.time} (account: ${fu.account}, effective: ${effectiveAccount})`);
        const entry = this.config.entries.find(e => e.time === fu.time && e.account === fu.account);
        if (entry) {
          try {
            callback(this.config.channel, this.config.userId, fu.time, effectiveAccount);
          } catch (error) {
            this.logger.error(`Error in missed follow-up callback for ${fu.time}`, error);
          }
        }
      }
    }
    // Clean up expired entries
    this.config.pendingFollowUps = valid;
    this.save();
  }

  private addPendingFollowUp(fu: PendingFollowUp): void {
    if (!this.config) return;
    if (!this.config.pendingFollowUps) this.config.pendingFollowUps = [];
    // Replace existing for same time+account
    this.config.pendingFollowUps = this.config.pendingFollowUps.filter(
      f => !(f.time === fu.time && f.account === fu.account),
    );
    this.config.pendingFollowUps.push(fu);
    this.save();
  }

  private removePendingFollowUp(time: string, account: string): void {
    if (!this.config?.pendingFollowUps) return;
    this.config.pendingFollowUps = this.config.pendingFollowUps.filter(
      f => !(f.time === time && f.account === account),
    );
    this.save();
  }

  cancelAll(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }

  getNextFireTimes(): Array<{ time: string; account: string; nextFire: Date }> {
    if (!this.config) return [];
    return this.config.entries.map(entry => ({
      time: entry.time,
      account: entry.account,
      nextFire: this.getNextFireTime(entry.time),
    }));
  }
}
