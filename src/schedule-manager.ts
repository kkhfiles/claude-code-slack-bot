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
 * At each scheduled time (with random jitter), fires a callback to start
 * a new Claude session using the haiku model with a randomized greeting.
 */
export class ScheduleManager {
  private config: ScheduleConfig | null = null;
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly configFile: string;
  private logger = new Logger('ScheduleManager');

  // Jitter range: actual fire time = scheduled time + random(5~25 min)
  private static readonly MIN_JITTER_MS = 5 * 60 * 1000;
  private static readonly MAX_JITTER_MS = 25 * 60 * 1000;

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

  private static readonly SESSION_WINDOW_HOURS = 5;

  /**
   * Check if a new time falls within an existing session's 5-hour window.
   * Returns the conflicting time if found, null if no conflict.
   */
  findConflictingTime(time: string): string | null {
    const normalized = this.normalizeTime(time);
    if (!normalized || !this.config) return null;
    const [newH, newM] = normalized.split(':').map(Number);
    const newMinutes = newH * 60 + newM;
    for (const existing of this.config.times) {
      if (existing === normalized) continue; // same time = duplicate, not conflict
      const [exH, exM] = existing.split(':').map(Number);
      const exMinutes = exH * 60 + exM;
      const windowEnd = exMinutes + ScheduleManager.SESSION_WINDOW_HOURS * 60;
      // Check if new time falls within [existing, existing + 5h)
      if (windowEnd <= 24 * 60) {
        if (newMinutes > exMinutes && newMinutes < windowEnd) return existing;
      } else {
        // Wraps past midnight (e.g., 22:00 → window ends at 03:00)
        if (newMinutes > exMinutes || newMinutes < windowEnd - 24 * 60) return existing;
      }
    }
    return null;
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
    const baseMs = nextFire.getTime() - Date.now();
    const jitterMs = Math.floor(
      ScheduleManager.MIN_JITTER_MS + Math.random() * (ScheduleManager.MAX_JITTER_MS - ScheduleManager.MIN_JITTER_MS),
    );
    const msUntil = baseMs + jitterMs;
    const actualFireTime = new Date(Date.now() + msUntil);
    this.logger.info(`Scheduled session start`, {
      time,
      nextFire: nextFire.toISOString(),
      jitterMin: Math.round(jitterMs / 60000),
      actualFireTime: actualFireTime.toISOString(),
    });

    const timer = setTimeout(() => {
      this.logger.info(`Firing scheduled session start: ${time} (actual: ${new Date().toISOString()})`);
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
