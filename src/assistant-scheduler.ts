import * as fs from 'fs';
import * as path from 'path';
import Holidays from 'date-holidays';
import { Logger } from './logger';

interface AssistantConfig {
  briefing: {
    time: string;        // "HH:MM"
    enabled: boolean;
    calendars: string[];
  };
  reminders: {
    beforeMinutes: number;
    pollingIntervalMinutes: number;
    enabled: boolean;
    workingHoursStart: string;  // "HH:00"
    workingHoursEnd: string;    // "HH:00"
  };
  analysis: {
    schedule: string;    // "saturday-03:00"
    deliveryTime: string;
    enabled: Record<string, boolean>;
    competitors: { tools: string[] };
  };
}

export interface SpawnOpts {
  workingDirectory: string;
  model?: string;
  permissionMode?: 'default' | 'plan' | 'trust';
  allowedTools?: string[];
  appendSystemPrompt?: string;
  env?: Record<string, string>;
}

// Google Calendar MCP tools available via Claude.ai platform OAuth
const GCAL_READ_TOOLS = [
  'mcp__claude_ai_Google_Calendar__gcal_list_events',
  'mcp__claude_ai_Google_Calendar__gcal_list_calendars',
  'mcp__claude_ai_Google_Calendar__gcal_get_event',
  'mcp__claude_ai_Google_Calendar__gcal_find_my_free_time',
  'mcp__claude_ai_Google_Calendar__gcal_find_meeting_times',
];

const GCAL_WRITE_TOOLS = [
  'mcp__claude_ai_Google_Calendar__gcal_create_event',
  'mcp__claude_ai_Google_Calendar__gcal_update_event',
  'mcp__claude_ai_Google_Calendar__gcal_delete_event',
  'mcp__claude_ai_Google_Calendar__gcal_respond_to_event',
];

const GCAL_ALL_TOOLS = [...GCAL_READ_TOOLS, ...GCAL_WRITE_TOOLS];

export class AssistantScheduler {
  private config: AssistantConfig | null = null;
  private readonly configPath: string;
  private readonly promptsDir: string;
  private readonly workingDir: string;

  // Timers
  private briefingTimer: ReturnType<typeof setTimeout> | null = null;
  private reminderInterval: ReturnType<typeof setInterval> | null = null;
  private analysisTimer: ReturnType<typeof setTimeout> | null = null;
  private midnightTimer: ReturnType<typeof setTimeout> | null = null;

  // File watcher debounce (account-manager.ts:59-62 pattern)
  private watchDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  // Reminder dedup (event text key, cleared at midnight)
  private remindedEvents = new Set<string>();

  // MCP auth failure tracking
  private consecutiveAuthFailures = 0;
  private reminderPaused = false;

  private logger = new Logger('AssistantScheduler');
  private holidays = new Holidays('KR');

  constructor(
    private sendMessage: (text: string) => Promise<void>,
    private spawnSession: (prompt: string, opts: SpawnOpts) => Promise<string>,
    configDir: string,
  ) {
    this.configPath = path.join(configDir, 'config.json');
    this.promptsDir = path.join(configDir, 'prompts');
    this.workingDir = path.resolve(configDir, '..');
  }

  // --- Public API ---

  start(): void {
    this.loadConfig();
    this.scheduleAll();
    this.startConfigWatcher();
    this.scheduleMidnightCleanup();
    this.logger.info('AssistantScheduler started', {
      configPath: this.configPath,
      workingDir: this.workingDir,
    });
  }

  stop(): void {
    this.clearAllTimers();
    this.stopConfigWatcher();
    if (this.midnightTimer) {
      clearTimeout(this.midnightTimer);
      this.midnightTimer = null;
    }
    this.logger.info('AssistantScheduler stopped');
  }

  /** Manual trigger for -briefing command. */
  async runBriefing(): Promise<string> {
    if (!this.config?.briefing.enabled) {
      return 'Briefing is disabled in config.';
    }
    return this.executeBriefing();
  }

  /** Return current config for -assistant config command. */
  getConfig(): AssistantConfig | null {
    return this.config;
  }

  /** Update config fields and save. Triggers fs.watchFile → auto-reload. */
  updateConfig(patch: Partial<{ briefingTime: string; reminderMinutes: number }>): void {
    if (!this.config) return;
    if (patch.briefingTime) {
      this.config.briefing.time = patch.briefingTime;
    }
    if (patch.reminderMinutes !== undefined) {
      this.config.reminders.beforeMinutes = patch.reminderMinutes;
    }
    this.saveConfig();
  }

  // --- Config management ---

  private loadConfig(): void {
    try {
      if (fs.existsSync(this.configPath)) {
        const raw = fs.readFileSync(this.configPath, 'utf-8');
        this.config = JSON.parse(raw);
        this.logger.info('Loaded assistant config', {
          briefingTime: this.config?.briefing.time,
          reminderEnabled: this.config?.reminders.enabled,
          analysisSchedule: this.config?.analysis.schedule,
        });
      } else {
        this.logger.warn('Assistant config not found', { path: this.configPath });
      }
    } catch (error) {
      this.logger.error('Failed to load assistant config', error);
    }
  }

  private saveConfig(): void {
    if (!this.config) return;
    try {
      fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), 'utf-8');
    } catch (error) {
      this.logger.error('Failed to save assistant config', error);
    }
  }

  /** fs.watchFile + debounce pattern (account-manager.ts:56-68). */
  private startConfigWatcher(): void {
    try {
      fs.watchFile(this.configPath, { interval: 10_000 }, () => {
        if (this.watchDebounceTimer) clearTimeout(this.watchDebounceTimer);
        this.watchDebounceTimer = setTimeout(() => {
          this.logger.info('Config file changed, reloading');
          this.clearAllTimers();
          this.loadConfig();
          this.scheduleAll();
        }, 1000);
      });
      this.logger.info('Started config file watcher');
    } catch (error) {
      this.logger.warn('Failed to start config watcher', error);
    }
  }

  private stopConfigWatcher(): void {
    try {
      fs.unwatchFile(this.configPath);
    } catch {
      // Ignore
    }
  }

  // --- Timer orchestration ---

  private scheduleAll(): void {
    if (!this.config) return;

    if (this.config.briefing.enabled) {
      this.scheduleBriefing();
    }
    if (this.config.reminders.enabled) {
      this.startReminderPolling();
    }
    if (Object.values(this.config.analysis.enabled).some(v => v)) {
      this.scheduleAnalysis();
    }
  }

  private clearAllTimers(): void {
    if (this.briefingTimer) {
      clearTimeout(this.briefingTimer);
      this.briefingTimer = null;
    }
    if (this.reminderInterval) {
      clearInterval(this.reminderInterval);
      this.reminderInterval = null;
    }
    if (this.analysisTimer) {
      clearTimeout(this.analysisTimer);
      this.analysisTimer = null;
    }
  }

  // --- Briefing ---

  /** Schedule next briefing on next working day (schedule-manager.ts:289-324 pattern). */
  private scheduleBriefing(): void {
    if (!this.config) return;
    const nextFire = this.getNextWorkingDay(this.config.briefing.time);
    const msUntil = nextFire.getTime() - Date.now();

    this.logger.info('Scheduled briefing', {
      time: this.config.briefing.time,
      nextFire: nextFire.toISOString(),
    });

    this.briefingTimer = setTimeout(async () => {
      // Double-check working day at fire time
      const nonWorking = this.isNonWorkingDay();
      if (nonWorking.skip) {
        this.logger.info(`Skipping briefing (${nonWorking.reason})`);
        this.scheduleBriefing();
        return;
      }

      try {
        const result = await this.executeBriefing();
        await this.sendMessage(result);
      } catch (error) {
        this.logger.error('Briefing failed', error);
        await this.sendMessage('❌ Morning briefing failed. Check logs for details.').catch(() => {});
      }

      // Reschedule for next working day
      this.scheduleBriefing();
    }, msUntil);
  }

  private async executeBriefing(): Promise<string> {
    const promptPath = path.join(this.promptsDir, 'morning-briefing.md');
    const prompt = fs.readFileSync(promptPath, 'utf-8');

    return this.spawnSession(prompt, {
      workingDirectory: this.workingDir,
      model: 'claude-sonnet-4-6',
      permissionMode: 'default',
      allowedTools: [
        'Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch',
        ...GCAL_ALL_TOOLS,
      ],
    });
  }

  // --- Calendar reminders ---

  private startReminderPolling(): void {
    if (!this.config) return;
    const intervalMs = this.config.reminders.pollingIntervalMinutes * 60 * 1000;

    this.reminderInterval = setInterval(() => {
      this.pollCalendar().catch(error => {
        this.logger.error('Calendar poll failed', error);
      });
    }, intervalMs);

    this.logger.info('Started reminder polling', {
      intervalMinutes: this.config.reminders.pollingIntervalMinutes,
    });
  }

  private async pollCalendar(): Promise<void> {
    if (!this.config) return;
    if (!this.isWorkingHours()) return;
    if (this.reminderPaused) return;

    try {
      const promptPath = path.join(this.promptsDir, 'calendar-reminder.md');
      let prompt = fs.readFileSync(promptPath, 'utf-8');
      prompt = prompt.replace(/\{beforeMinutes\}/g, String(this.config.reminders.beforeMinutes));

      const result = await this.spawnSession(prompt, {
        workingDirectory: this.workingDir,
        model: 'claude-haiku-4-5-20251001',
        permissionMode: 'plan',
        allowedTools: [
          ...GCAL_READ_TOOLS,
        ],
      });

      // Reset auth failure count on success
      this.consecutiveAuthFailures = 0;

      // Skip if no upcoming events
      if (result.includes('NONE')) return;

      // Dedup by event text
      const eventKey = result.trim().substring(0, 200);
      if (this.remindedEvents.has(eventKey)) return;
      this.remindedEvents.add(eventKey);

      await this.sendMessage(result);
    } catch (error) {
      this.consecutiveAuthFailures++;
      this.logger.warn('Calendar poll error', {
        consecutiveFailures: this.consecutiveAuthFailures,
        error,
      });

      if (this.consecutiveAuthFailures >= 3) {
        this.reminderPaused = true;
        await this.sendMessage('⚠️ 캘린더 인증 갱신 필요 — 리마인더 일시 중지됨').catch(() => {});
      }
    }
  }

  private isWorkingHours(): boolean {
    if (!this.config) return false;
    const nonWorking = this.isNonWorkingDay();
    if (nonWorking.skip) return false;

    const now = new Date();
    const hour = now.getHours();
    const startHour = parseInt(this.config.reminders.workingHoursStart, 10);
    const endHour = parseInt(this.config.reminders.workingHoursEnd, 10);
    return hour >= startHour && hour < endHour;
  }

  // --- Analysis ---

  /** Schedule next analysis run (e.g., "saturday-03:00"). */
  private scheduleAnalysis(): void {
    if (!this.config) return;

    const nextFire = this.getNextAnalysisTime();
    const msUntil = nextFire.getTime() - Date.now();

    this.logger.info('Scheduled analysis', {
      schedule: this.config.analysis.schedule,
      nextFire: nextFire.toISOString(),
    });

    this.analysisTimer = setTimeout(async () => {
      try {
        await this.runAnalysis();
      } catch (error) {
        this.logger.error('Analysis run failed', error);
      }
      // Reschedule for next week
      this.scheduleAnalysis();
    }, msUntil);
  }

  private async runAnalysis(): Promise<void> {
    if (!this.config) return;
    const enabledTypes = Object.entries(this.config.analysis.enabled)
      .filter(([, enabled]) => enabled)
      .map(([type]) => type);

    for (const type of enabledTypes) {
      try {
        await this.runSingleAnalysis(type);
      } catch (error) {
        this.logger.error(`Analysis failed for type: ${type}`, error);
      }
    }

    // Notify completion
    await this.sendMessage(`📊 주간 분석 완료: ${enabledTypes.join(', ')}`).catch(() => {});
  }

  private async runSingleAnalysis(type: string): Promise<void> {
    const promptPath = path.join(this.promptsDir, `analysis-${type}.md`);
    if (!fs.existsSync(promptPath)) {
      this.logger.warn(`Analysis prompt not found: ${promptPath}`);
      return;
    }

    const prompt = fs.readFileSync(promptPath, 'utf-8');

    await this.spawnSession(prompt, {
      workingDirectory: this.workingDir,
      permissionMode: 'default',
      allowedTools: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'Write'],
      appendSystemPrompt: 'CRITICAL: reports/ 디렉토리에만 새 파일 생성. 기존 파일 수정/삭제 금지.',
      env: { ASSISTANT_MODE: 'analysis' },
    });
  }

  // --- Date/time utilities ---

  /** Check if today is a non-working day (schedule-manager.ts:231-241 pattern). */
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

  /** Get next occurrence of HH:MM on a working day (schedule-manager.ts:243-252 pattern). */
  private getNextWorkingDay(time: string): Date {
    const [h, m] = time.split(':').map(Number);
    const now = new Date();
    const next = new Date(now);
    next.setHours(h, m, 0, 0);

    // If time already passed today, start from tomorrow
    if (next <= now) {
      next.setDate(next.getDate() + 1);
    }

    // Skip non-working days
    while (this.isNonWorkingDay(next).skip) {
      next.setDate(next.getDate() + 1);
    }

    return next;
  }

  /** Get next analysis time based on schedule like "saturday-03:00". */
  private getNextAnalysisTime(): Date {
    if (!this.config) return new Date();

    const [dayStr, timeStr] = this.config.analysis.schedule.split('-');
    const [h, m] = timeStr.split(':').map(Number);
    const targetDay = this.dayNameToNumber(dayStr);

    const now = new Date();
    const next = new Date(now);
    next.setHours(h, m, 0, 0);

    // Find the next occurrence of target day
    const currentDay = now.getDay();
    let daysUntil = targetDay - currentDay;
    if (daysUntil < 0 || (daysUntil === 0 && next <= now)) {
      daysUntil += 7;
    }
    next.setDate(next.getDate() + daysUntil);

    return next;
  }

  private dayNameToNumber(day: string): number {
    const days: Record<string, number> = {
      sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
      thursday: 4, friday: 5, saturday: 6,
    };
    return days[day.toLowerCase()] ?? 6; // Default to Saturday
  }

  /** Schedule midnight cleanup for remindedEvents dedup set. */
  private scheduleMidnightCleanup(): void {
    const now = new Date();
    const midnight = new Date(now);
    midnight.setHours(24, 0, 0, 0);
    const msUntil = midnight.getTime() - now.getTime();

    this.midnightTimer = setTimeout(() => {
      this.remindedEvents.clear();
      this.logger.debug('Cleared remindedEvents at midnight');
      this.scheduleMidnightCleanup();
    }, msUntil);
  }
}
