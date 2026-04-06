import * as fs from 'fs';
import * as path from 'path';
import Holidays from 'date-holidays';
import { Logger } from './logger';
import { CalendarPoller } from './calendar-poller';
import { errorCollector } from './error-collector';
import { isRateLimitText } from './rate-limit-utils';

export interface AssistantConfig {
  briefing: {
    time: string;        // "HH:MM"
    enabled: boolean;
    calendars?: string[];  // Deprecated: ignored, all calendars are fetched
    excludeCalendars?: string[];
    maxBudgetUsd?: number;
  };
  reminders: {
    beforeMinutes: number;
    pollingIntervalMinutes: number;
    enabled: boolean;
    workingHoursStart: string;  // "HH:00"
    workingHoursEnd: string;    // "HH:00"
    maxBudgetUsd?: number;
  };
  analysis: {
    schedule: string;    // "saturday-03:00"
    deliveryTime: string;
    budgetUsd?: number;
    defaults: {
      sessionBudgetUsd: number;
      allowedTools: string[];
      writablePaths: string[];
    };
    types: Record<string, {
      enabled: boolean;
      schedule?: string;           // per-type schedule override (e.g. "daily-02:00")
      tools?: string[];            // type-specific data (e.g. competitors.tools)
      allowedTools?: string[];
      writablePaths?: string[];
      sessionBudgetUsd?: number;
      [key: string]: unknown;
    }>;
  };
}

export interface SpawnOpts {
  workingDirectory: string;
  model?: string;
  permissionMode?: 'default' | 'plan' | 'trust';
  allowedTools?: string[];
  appendSystemPrompt?: string;
  systemPrompt?: string;
  env?: Record<string, string>;
  maxBudgetUsd?: number;
  resumeSessionId?: string;
  skipMcp?: boolean;
  noSessionPersistence?: boolean;
  tools?: string[];
}

export interface SessionResult {
  text: string;
  costUsd: number;
  sessionId: string;
  subtype: string;  // 'success' | 'error_max_budget_usd' | ...
}

// Google Calendar MCP tools via local @cocal/google-calendar-mcp server
const GCAL_READ_TOOLS = [
  'mcp__google-calendar__list-events',
  'mcp__google-calendar__list-calendars',
  'mcp__google-calendar__get-event',
  'mcp__google-calendar__search-events',
  'mcp__google-calendar__get-freebusy',
  'mcp__google-calendar__get-current-time',
];

const GCAL_WRITE_TOOLS = [
  'mcp__google-calendar__create-event',
  'mcp__google-calendar__create-events',
  'mcp__google-calendar__update-event',
  'mcp__google-calendar__delete-event',
  'mcp__google-calendar__respond-to-event',
];

const GCAL_ALL_TOOLS = [...GCAL_READ_TOOLS, ...GCAL_WRITE_TOOLS];

// --- Cost tracking ---

interface CostEntry {
  timestamp: string;
  type: string;
  costUsd: number;
  sessionId: string;
}

const COST_FILE = path.join(__dirname, '..', '.assistant-costs.json');
const COST_RETENTION_DAYS = 30;

export class AssistantScheduler {
  private config: AssistantConfig | null = null;
  private readonly configPath: string;
  private readonly promptsDir: string;
  private readonly workingDir: string;

  // Timers
  private briefingTimer: ReturnType<typeof setTimeout> | null = null;
  private analysisTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private midnightTimer: ReturnType<typeof setTimeout> | null = null;

  // File watcher debounce (account-manager.ts:59-62 pattern)
  private watchDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  // Calendar poller (replaces MCP-based reminder polling)
  private calendarPoller: CalendarPoller | null = null;

  // Cost tracking
  private costEntries: CostEntry[] = [];

  private logger = new Logger('AssistantScheduler');
  private holidays = new Holidays('KR');

  constructor(
    private sendMessage: (text: string, blocks?: unknown[]) => Promise<void>,
    private spawnSession: (prompt: string, opts: SpawnOpts) => Promise<SessionResult>,
    configDir: string,
  ) {
    this.configPath = path.join(configDir, 'config.json');
    this.promptsDir = path.join(configDir, 'prompts');
    this.workingDir = path.resolve(configDir, '..');
  }

  // --- Public API ---

  start(): void {
    this.loadConfig();
    this.loadCosts();
    this.scheduleAll();
    this.startConfigWatcher();
    this.scheduleMidnightCleanup();
    this.logger.info('AssistantScheduler started', {
      configPath: this.configPath,
      workingDir: this.workingDir,
    });

    // Catch-up briefing if missed today (e.g. bot restarted after briefing time)
    setTimeout(() => this.catchUpBriefingIfNeeded().catch(e =>
      this.logger.error('Catch-up briefing failed', e)), 15_000);
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

  /** Expose working hours check for CalendarPoller callback. */
  isWorkingHoursCheck(): boolean {
    return this.isWorkingHours();
  }

  /** Manual trigger for -briefing command. */
  async runBriefing(): Promise<{ text: string; hasReports: boolean }> {
    if (!this.config?.briefing.enabled) {
      return { text: 'Briefing is disabled in config.', hasReports: false };
    }
    const result = await this.executeBriefing();
    this.recordCost('briefing', result.costUsd, result.sessionId);
    return {
      text: result.text + this.formatErrorReport() + this.formatCostLine(),
      hasReports: this.hasUnreadReports(),
    };
  }

  /** Access CalendarPoller instance (for mute actions, etc.). */
  getCalendarPoller(): CalendarPoller | null {
    return this.calendarPoller;
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

  /** Return cost statistics for display. */
  getCostStats(): { daily: number; weekly: number; monthly: number; analysisWeekly: number; analysisMonthly: number } {
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    let daily = 0, weekly = 0, monthly = 0;
    let analysisWeekly = 0, analysisMonthly = 0;

    for (const entry of this.costEntries) {
      const age = now - new Date(entry.timestamp).getTime();
      const isAnalysis = entry.type.startsWith('analysis-');
      if (age <= dayMs) daily += entry.costUsd;
      if (age <= 7 * dayMs) {
        weekly += entry.costUsd;
        if (isAnalysis) analysisWeekly += entry.costUsd;
      }
      if (age <= 30 * dayMs) {
        monthly += entry.costUsd;
        if (isAnalysis) analysisMonthly += entry.costUsd;
      }
    }

    return { daily, weekly, monthly, analysisWeekly, analysisMonthly };
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
      errorCollector.add('AssistantScheduler', `설정 파일 로드 실패: ${(error as Error).message}`);
      this.logger.error('Failed to load assistant config', error);
    }
  }

  private saveConfig(): void {
    if (!this.config) return;
    try {
      fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), 'utf-8');
    } catch (error) {
      errorCollector.add('AssistantScheduler', `설정 파일 저장 실패: ${(error as Error).message}`);
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
      errorCollector.add('AssistantScheduler', `설정 파일 감시 실패: ${(error as Error).message}`);
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

  // --- Cost tracking ---

  private loadCosts(): void {
    try {
      if (fs.existsSync(COST_FILE)) {
        const raw = fs.readFileSync(COST_FILE, 'utf-8');
        const data = JSON.parse(raw);
        const cutoff = Date.now() - COST_RETENTION_DAYS * 24 * 60 * 60 * 1000;
        this.costEntries = (data.entries || []).filter(
          (e: CostEntry) => new Date(e.timestamp).getTime() > cutoff,
        );
      }
    } catch (error) {
      errorCollector.add('AssistantScheduler', `비용 데이터 로드 실패: ${(error as Error).message}`);
      this.logger.error('Failed to load cost data', error);
    }
  }

  private saveCosts(): void {
    try {
      fs.writeFileSync(COST_FILE, JSON.stringify({ entries: this.costEntries }, null, 2), 'utf-8');
    } catch (error) {
      errorCollector.add('AssistantScheduler', `비용 데이터 저장 실패: ${(error as Error).message}`);
      this.logger.error('Failed to save cost data', error);
    }
  }

  private recordCost(type: string, costUsd: number, sessionId: string): void {
    if (costUsd <= 0) return;
    this.costEntries.push({
      timestamp: new Date().toISOString(),
      type,
      costUsd,
      sessionId,
    });
    this.saveCosts();
    this.logger.info('Recorded cost', { type, costUsd: costUsd.toFixed(4), sessionId });
  }

  private formatCostLine(): string {
    const stats = this.getCostStats();
    let line = `\n\n💰 *비용* — 오늘: $${stats.daily.toFixed(2)} | 이번 주: $${stats.weekly.toFixed(2)} | 이번 달: $${stats.monthly.toFixed(2)}`;
    if (stats.analysisMonthly > 0) {
      line += `\n📊 *분석* — 이번 주: $${stats.analysisWeekly.toFixed(2)} | 이번 달: $${stats.analysisMonthly.toFixed(2)}`;
    }
    return line;
  }

  /** Check if there are unarchived reports in reports/ subdirectories. */
  private hasUnreadReports(): boolean {
    const reportsDir = path.join(this.workingDir, 'reports');
    if (!fs.existsSync(reportsDir)) return false;
    for (const dir of fs.readdirSync(reportsDir)) {
      if (dir === 'archived') continue;
      const subdir = path.join(reportsDir, dir);
      if (!fs.statSync(subdir).isDirectory()) continue;
      for (const fname of fs.readdirSync(subdir)) {
        if (fname.endsWith('.md') && fname !== '.gitkeep') return true;
      }
    }
    return false;
  }

  // --- Timer orchestration ---

  private scheduleAll(): void {
    if (!this.config) return;

    if (this.config.briefing.enabled) {
      this.scheduleBriefing();
    }
    if (this.config.reminders.enabled) {
      this.startCalendarPoller();
    }
    if (this.getEnabledAnalysisTypes().length > 0) {
      this.scheduleAnalysis();
    }
  }

  private clearAllTimers(): void {
    if (this.briefingTimer) {
      clearTimeout(this.briefingTimer);
      this.briefingTimer = null;
    }
    if (this.calendarPoller) {
      this.calendarPoller.stop();
      this.calendarPoller = null;
    }
    for (const timer of this.analysisTimers.values()) {
      clearTimeout(timer);
    }
    this.analysisTimers.clear();
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
        this.recordCost('briefing', result.costUsd, result.sessionId);

        // Check rate limit in result text
        if (isRateLimitText(result.text)) {
          this.logger.warn('Briefing hit rate limit');
          await this.sendMessage('⏳ 브리핑 실행 중 rate limit 도달. 다음 업무일에 재시도합니다.').catch(() => {});
        } else {
          // Append error report + cost stats line
          await this.sendMessage(result.text + this.formatErrorReport() + this.formatCostLine());

          // If reports exist, add a button to view them
          if (this.hasUnreadReports()) {
            await this.sendMessage('📄 대기 중인 보고서가 있습니다.', [{
              type: 'section',
              text: { type: 'mrkdwn', text: '📄 대기 중인 보고서가 있습니다.' },
            }, {
              type: 'actions',
              elements: [{
                type: 'button',
                text: { type: 'plain_text', text: '📄 보고서 확인' },
                action_id: 'briefing_view_reports',
              }],
            }]).catch(() => {});
          }
        }
      } catch (error) {
        const msg = (error as Error).message || '';
        if (isRateLimitText(msg)) {
          this.logger.warn('Briefing hit rate limit');
          await this.sendMessage('⏳ 브리핑 실행 중 rate limit 도달. 다음 업무일에 재시도합니다.').catch(() => {});
        } else {
          this.logger.error('Briefing failed', error);
          await this.sendMessage('❌ Morning briefing failed. Check logs for details.').catch(() => {});
        }
      }

      // Reschedule for next working day
      this.scheduleBriefing();
    }, msUntil);
  }

  /** If briefing was missed today (e.g. bot restarted after briefing time), run it now. */
  private async catchUpBriefingIfNeeded(): Promise<void> {
    if (!this.config?.briefing.enabled) return;
    if (this.isNonWorkingDay().skip) return;

    // Check if briefing already ran today (KST)
    const todayKST = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
    const lastBriefing = [...this.costEntries]
      .reverse()
      .find(e => e.type === 'briefing');

    if (lastBriefing) {
      const lastDateKST = new Date(new Date(lastBriefing.timestamp).getTime() + 9 * 3600_000)
        .toISOString().slice(0, 10);
      if (lastDateKST === todayKST) return; // Already ran today
    }

    // Check if briefing time has passed
    const [h, m] = this.config.briefing.time.split(':').map(Number);
    const nowKST = new Date(Date.now() + 9 * 3600_000);
    if (nowKST.getUTCHours() < h || (nowKST.getUTCHours() === h && nowKST.getUTCMinutes() < m)) return;

    this.logger.info('Catch-up briefing: missed today, running now');
    try {
      const result = await this.executeBriefing();
      this.recordCost('briefing', result.costUsd, result.sessionId);
      await this.sendMessage(result.text + this.formatErrorReport() + this.formatCostLine());

      if (this.hasUnreadReports()) {
        await this.sendMessage('', [{
          type: 'actions',
          elements: [{
            type: 'button',
            text: { type: 'plain_text', text: '📄 보고서 확인' },
            action_id: 'briefing_view_reports',
          }],
        }]).catch(() => {});
      }
    } catch (error) {
      const msg = (error as Error).message || '';
      if (isRateLimitText(msg)) {
        await this.sendMessage('⏳ Catch-up 브리핑 중 rate limit 도달.').catch(() => {});
      } else {
        this.logger.error('Catch-up briefing failed', error);
      }
    }
  }

  private async executeBriefing(): Promise<SessionResult> {
    const promptPath = path.join(this.promptsDir, 'morning-briefing.md');
    let prompt = fs.readFileSync(promptPath, 'utf-8');

    // Inject exclude calendars list
    const excludeList = this.config?.briefing.excludeCalendars;
    if (excludeList && excludeList.length > 0) {
      prompt = prompt.replace(/\{excludeCalendars\}/g, excludeList.map(c => `\`${c}\``).join(', '));
    } else {
      prompt = prompt.replace(/\{excludeCalendars\}/g, '(없음)');
    }

    // Monday: inject weekly summary prompt
    if (new Date().getDay() === 1) {
      const mondayExtra = path.join(this.promptsDir, 'monday-briefing-extra.md');
      if (fs.existsSync(mondayExtra)) {
        prompt += '\n\n' + fs.readFileSync(mondayExtra, 'utf-8');
      }
    }

    // Inject cached calendar data if available (saves MCP cost)
    const cache = this.calendarPoller?.getCache();
    let allowedTools: string[];

    if (cache && cache.events.length >= 0) {
      const eventList = cache.events.map(e => {
        const time = e.isAllDay ? '종일' : `${this.formatTimeFromISO(e.startTime)} ~ ${this.formatTimeFromISO(e.endTime)}`;
        const loc = e.location ? ` — ${e.location}` : '';
        return `- ${time} ${e.title}${loc} _${e.calendarName}_`;
      }).join('\n') || '(일정 없음)';

      prompt += `\n\n## 오늘의 캘린더 데이터 (캐시)\n${eventList}\n\n위 데이터를 사용하세요. 캘린더 도구를 호출하지 마세요.`;
      allowedTools = ['Read', 'Glob', 'Grep']; // No GCAL tools needed
    } else {
      // Fallback to MCP if no cache
      allowedTools = ['Read', 'Glob', 'Grep', ...GCAL_READ_TOOLS];
    }

    const result = await this.spawnSession(prompt, {
      workingDirectory: this.workingDir,
      model: 'claude-haiku-4-5-20251001',
      permissionMode: 'default',
      maxBudgetUsd: this.config?.briefing.maxBudgetUsd || 1.00,
      allowedTools,
      noSessionPersistence: true,
      skipMcp: true,
      env: { CLAUDE_SCHEDULED: '1' },
    });

    // Extract only the final briefing output (starts with ☀️), dropping intermediate explanation text
    const briefingStart = result.text.lastIndexOf('☀️');
    if (briefingStart > 0) {
      result.text = result.text.substring(briefingStart);
    }

    return result;
  }

  /** Format HH:MM from ISO datetime string. */
  private formatTimeFromISO(iso: string): string {
    try {
      const d = new Date(iso);
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    } catch {
      return iso;
    }
  }

  // --- Calendar poller (direct HTTP, replaces MCP-based polling) ---

  private startCalendarPoller(): void {
    if (this.calendarPoller) {
      this.calendarPoller.stop();
    }

    this.calendarPoller = new CalendarPoller(
      this.sendMessage,
      this.spawnSession,
      this.promptsDir,
      () => this.config,
      (type, costUsd, sessionId) => this.recordCost(type, costUsd, sessionId),
      () => this.isWorkingHours(),
    );

    this.calendarPoller.start();
  }

  // --- Error reporting ---

  /** Format collected bot errors for briefing output. */
  private formatErrorReport(): string {
    const errors = errorCollector.getAndClear();
    if (errors.length === 0) return '';

    // Group by source
    const grouped = new Map<string, string[]>();
    for (const err of errors) {
      const list = grouped.get(err.source) || [];
      list.push(err.message);
      grouped.set(err.source, list);
    }

    let report = '\n\n⚠️ *시스템 이슈*';
    for (const [source, messages] of grouped) {
      // Deduplicate identical messages
      const unique = [...new Set(messages)];
      report += `\n• _${source}_: ${unique.join(', ')}`;
    }
    return report;
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

  /** Schedule analysis runs, grouping types by their schedule. */
  private scheduleAnalysis(): void {
    if (!this.config) return;

    // Group enabled types by schedule
    const groups = this.groupTypesBySchedule();

    for (const [schedule, types] of groups) {
      const nextFire = this.getNextAnalysisTime(schedule);
      const msUntil = nextFire.getTime() - Date.now();

      this.logger.info('Scheduled analysis group', {
        schedule,
        types,
        nextFire: nextFire.toISOString(),
      });

      const timer = setTimeout(async () => {
        try {
          await this.runAnalysisGroup(types);
        } catch (error) {
          this.logger.error('Analysis run failed', { schedule, error });
        }
        // Reschedule this group
        this.analysisTimers.delete(schedule);
        this.scheduleAnalysisGroup(schedule, types);
      }, msUntil);

      this.analysisTimers.set(schedule, timer);
    }
  }

  /** Schedule a single analysis group (used for rescheduling after completion). */
  private scheduleAnalysisGroup(schedule: string, types: string[]): void {
    const nextFire = this.getNextAnalysisTime(schedule);
    const msUntil = nextFire.getTime() - Date.now();

    this.logger.info('Rescheduled analysis group', {
      schedule,
      types,
      nextFire: nextFire.toISOString(),
    });

    const timer = setTimeout(async () => {
      try {
        await this.runAnalysisGroup(types);
      } catch (error) {
        this.logger.error('Analysis run failed', { schedule, error });
      }
      this.analysisTimers.delete(schedule);
      this.scheduleAnalysisGroup(schedule, types);
    }, msUntil);

    this.analysisTimers.set(schedule, timer);
  }

  /** Group enabled analysis types by their schedule string. */
  private groupTypesBySchedule(): Map<string, string[]> {
    if (!this.config) return new Map();
    const defaultSchedule = this.config.analysis.schedule;
    const groups = new Map<string, string[]>();

    for (const [type, cfg] of Object.entries(this.config.analysis.types)) {
      if (!cfg.enabled) continue;
      const schedule = cfg.schedule || defaultSchedule;
      const list = groups.get(schedule) || [];
      list.push(type);
      groups.set(schedule, list);
    }
    return groups;
  }

  /** Get enabled analysis types from either new (types) or legacy (enabled) config format. */
  private getEnabledAnalysisTypes(): string[] {
    if (!this.config) return [];
    return Object.entries(this.config.analysis.types)
      .filter(([, cfg]) => cfg.enabled)
      .map(([type]) => type);
  }

  private async runAnalysisGroup(types: string[]): Promise<void> {
    if (!this.config) return;

    // Single-type group uses its own sessionBudget; multi-type group shares analysis.budgetUsd
    const isSingle = types.length === 1;
    const typeConfig = isSingle ? this.config.analysis.types[types[0]] : undefined;
    let remainingBudget = isSingle
      ? (typeConfig?.sessionBudgetUsd ?? this.config.analysis.defaults.sessionBudgetUsd)
      : (this.config.analysis.budgetUsd ?? 5.00);

    const completedTypes: string[] = [];

    for (const type of types) {
      if (remainingBudget <= 0.01) {
        this.logger.warn(`Analysis budget exhausted, skipping: ${type}`, {
          remainingBudget,
        });
        break;
      }

      try {
        remainingBudget = await this.runSingleAnalysis(type, remainingBudget);
        if (remainingBudget < 0) {
          remainingBudget = 0;
          break;
        }
        completedTypes.push(type);
      } catch (error) {
        const msg = (error as Error).message || '';
        if (isRateLimitText(msg)) {
          this.logger.warn(`Analysis ${type} hit rate limit, stopping all analyses`);
          break;
        }
        errorCollector.add('AssistantScheduler', `분석 실행 실패 (${type}): ${msg}`);
        this.logger.error(`Analysis failed for type: ${type}`, error);
      }
    }

    const label = isSingle ? '야간 동기화' : '주간 분석';
    await this.sendMessage(
      `📊 ${label} 완료: ${completedTypes.join(', ') || '(없음)'}`,
    ).catch(() => {});
  }

  private async runSingleAnalysis(type: string, remainingBudget: number): Promise<number> {
    const promptPath = path.join(this.promptsDir, `analysis-${type}.md`);
    if (!fs.existsSync(promptPath)) {
      this.logger.warn(`Analysis prompt not found: ${promptPath}`);
      return remainingBudget;
    }

    const prompt = fs.readFileSync(promptPath, 'utf-8');
    const analysis = this.config!.analysis;
    const defaults = analysis.defaults;
    const typeConfig = analysis.types[type];
    const sessionBudget = typeConfig?.sessionBudgetUsd ?? defaults.sessionBudgetUsd;
    const allowedTools = typeConfig?.allowedTools ?? defaults.allowedTools;
    const writablePaths = typeConfig?.writablePaths ?? defaults.writablePaths;
    let sessionId: string | undefined;

    while (remainingBudget > 0.01) {
      const perSession = Math.min(remainingBudget, sessionBudget);

      const result = await this.spawnSession(
        sessionId ? 'continue' : prompt,
        {
          workingDirectory: this.workingDir,
          permissionMode: 'default',
          maxBudgetUsd: perSession,
          allowedTools,
          appendSystemPrompt: `CRITICAL: ${writablePaths.join(', ')} 디렉토리에만 새 파일 생성/수정. 그 외 파일 수정/삭제 금지.`,
          env: { ASSISTANT_MODE: 'analysis', CLAUDE_SCHEDULED: '1' },
          resumeSessionId: sessionId,
          skipMcp: true,
        },
      );

      remainingBudget -= result.costUsd;
      this.recordCost(`analysis-${type}`, result.costUsd, result.sessionId);
      sessionId = result.sessionId;

      this.logger.info(`Analysis session completed`, {
        type,
        subtype: result.subtype,
        costUsd: result.costUsd.toFixed(4),
        remainingBudget: remainingBudget.toFixed(2),
      });

      // Rate limit → stop all analyses (return negative to signal caller)
      if (isRateLimitText(result.text)) {
        this.logger.warn(`Analysis ${type} hit rate limit, stopping all analyses`);
        return -1;
      }
      // Normal completion
      if (result.subtype === 'success') break;
      // Budget hit → resume if budget remains
      if (result.subtype === 'error_max_budget_usd') continue;
      // Other error → stop
      break;
    }

    return remainingBudget;
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

  /** Get next analysis time based on schedule like "saturday-03:00" or "daily-02:00". */
  private getNextAnalysisTime(schedule: string): Date {
    // Split on first '-' only: "daily-02:00" → ["daily", "02:00"], "wednesday-20:00" → ["wednesday", "20:00"]
    const dashIdx = schedule.indexOf('-');
    const dayStr = schedule.substring(0, dashIdx);
    const timeStr = schedule.substring(dashIdx + 1);
    const [h, m] = timeStr.split(':').map(Number);

    const now = new Date();
    const next = new Date(now);
    next.setHours(h, m, 0, 0);

    if (dayStr.toLowerCase() === 'daily') {
      // Daily: next working day at the specified time
      if (next <= now) {
        next.setDate(next.getDate() + 1);
      }
      while (this.isNonWorkingDay(next).skip) {
        next.setDate(next.getDate() + 1);
      }
    } else {
      // Weekly: next occurrence of target day
      const targetDay = this.dayNameToNumber(dayStr);
      const currentDay = now.getDay();
      let daysUntil = targetDay - currentDay;
      if (daysUntil < 0 || (daysUntil === 0 && next <= now)) {
        daysUntil += 7;
      }
      next.setDate(next.getDate() + daysUntil);
    }

    return next;
  }

  private dayNameToNumber(day: string): number {
    const days: Record<string, number> = {
      sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
      thursday: 4, friday: 5, saturday: 6,
    };
    return days[day.toLowerCase()] ?? 6; // Default to Saturday
  }

  /** Schedule midnight cleanup (reserved for future per-day state resets). */
  private scheduleMidnightCleanup(): void {
    const now = new Date();
    const midnight = new Date(now);
    midnight.setHours(24, 0, 0, 0);
    const msUntil = midnight.getTime() - now.getTime();

    this.midnightTimer = setTimeout(() => {
      this.logger.debug('Midnight cleanup');
      this.scheduleMidnightCleanup();
    }, msUntil);
  }
}
