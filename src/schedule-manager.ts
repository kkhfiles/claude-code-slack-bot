import * as fs from 'fs';
import * as path from 'path';
import { Logger } from './logger';

interface ScheduleConfig {
  times: string[];  // "HH:MM" 24-hour format, sorted
  channel: string;  // Slack channel ID to post to
  userId: string;   // Slack user ID who set it up (for locale)
}

/**
 * Manages scheduled session start times.
 * At each scheduled time, fires a callback to send a "hi" greeting to Claude
 * using the haiku model, starting a new 5-hour session window.
 */
export class ScheduleManager {
  private config: ScheduleConfig | null = null;
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly configFile: string;
  private logger = new Logger('ScheduleManager');

  constructor() {
    this.configFile = path.join(__dirname, '..', '.schedule-config.json');
    this.load();
  }

  private load(): void {
    try {
      if (fs.existsSync(this.configFile)) {
        const raw = fs.readFileSync(this.configFile, 'utf-8');
        this.config = JSON.parse(raw) as ScheduleConfig;
        this.logger.info('Loaded schedule config', { times: this.config.times, channel: this.config.channel });
      }
    } catch (error) {
      this.logger.error('Failed to load schedule config', error);
    }
  }

  private save(): void {
    try {
      if (this.config) {
        fs.writeFileSync(this.configFile, JSON.stringify(this.config, null, 2), 'utf-8');
      }
    } catch (error) {
      this.logger.error('Failed to save schedule config', error);
    }
  }

  getConfig(): ScheduleConfig | null {
    return this.config;
  }

  /** Add a time. Returns normalized "HH:MM" or null if invalid. */
  addTime(time: string, channel: string, userId: string): string | null {
    const normalized = this.normalizeTime(time);
    if (!normalized) return null;
    if (!this.config) {
      this.config = { times: [normalized], channel, userId };
    } else {
      if (!this.config.times.includes(normalized)) {
        this.config.times.push(normalized);
        this.config.times.sort();
      }
      this.config.channel = channel;
      this.config.userId = userId;
    }
    this.save();
    return normalized;
  }

  /** Remove a time. Returns normalized "HH:MM" if removed, null if not found or invalid. */
  removeTime(time: string): string | null {
    if (!this.config) return null;
    const normalized = this.normalizeTime(time);
    if (!normalized) return null;
    const before = this.config.times.length;
    this.config.times = this.config.times.filter(t => t !== normalized);
    if (this.config.times.length === before) return null;
    this.save();
    return normalized;
  }

  clearTimes(): void {
    this.cancelAll();
    if (this.config) {
      this.config.times = [];
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
    const match = time.match(/^(\d{1,2}):(\d{2})$/);
    if (!match) return null;
    const h = parseInt(match[1], 10);
    const m = parseInt(match[2], 10);
    if (h < 0 || h > 23 || m < 0 || m > 59) return null;
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
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

  /** Start all timers. Cancels existing timers first. */
  scheduleAll(callback: (channel: string, userId: string, time: string) => void): void {
    this.cancelAll();
    if (!this.config || this.config.times.length === 0) return;
    for (const time of this.config.times) {
      this.scheduleOne(time, this.config.channel, this.config.userId, callback);
    }
  }

  private scheduleOne(
    time: string,
    channel: string,
    userId: string,
    callback: (channel: string, userId: string, time: string) => void,
  ): void {
    const nextFire = this.getNextFireTime(time);
    const msUntil = nextFire.getTime() - Date.now();
    this.logger.info(`Scheduled session start`, { time, nextFire: nextFire.toISOString() });

    const timer = setTimeout(() => {
      this.logger.info(`Firing scheduled session start: ${time}`);
      try {
        callback(channel, userId, time);
      } catch (error) {
        this.logger.error(`Error in scheduled callback for ${time}`, error);
      }
      // Reschedule for the next day
      const cfg = this.config;
      if (cfg && cfg.times.includes(time)) {
        this.scheduleOne(time, cfg.channel, cfg.userId, callback);
      }
    }, msUntil);

    this.timers.set(time, timer);
  }

  cancelAll(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }

  getNextFireTimes(): Array<{ time: string; nextFire: Date }> {
    if (!this.config) return [];
    return this.config.times.map(time => ({ time, nextFire: this.getNextFireTime(time) }));
  }
}
