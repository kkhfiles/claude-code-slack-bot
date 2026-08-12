import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn, execSync } from 'child_process';
import Holidays from 'date-holidays';
import { Logger } from './logger';
import { CalendarPoller } from './calendar-poller';
import { errorCollector } from './error-collector';
import { isRateLimitText } from './rate-limit-utils';
import { shouldUseSdk } from './sdk-handler';
import { runAgy } from './agy-handler';
import { listNasQueue, buildNasQueueBlocks } from './nas-confirm';
import { isWorkAssistantEnabled, briefShort, briefNudge, checkinNudge, quickUpdate,
  refreshBoardIfChanged } from './work-assistant';
import { boardQueueEnabled, drain } from './board-queue';

/**
 * 업무 넛지 시각. 09:00 데일리 미팅 직전이라는 것이 이 값의 전부다 —
 * 설정으로 뺄 이유가 생기면 그때 뺀다.
 */
const WORK_NUDGE_TIME = '08:55';
/**
 * 오후 체크인 넛지 시각. **진행이 들어오는 유일한 입구가 체크인인데**, 그것이
 * 「그날 첫 접촉」에만 걸려 있어 슬랙을 안 여는 날은 아무것도 안 들어왔다.
 *
 * 아침(08:55)은 어제 것을, 오후는 오늘 것을 묻는다 — **같은 질문을 두 번 밀지
 * 않는다.** 재촉은 무시를 부르고, 무시되기 시작한 장치는 죽는다.
 *
 * 17:00 인 이유: 하루가 끝나기 전이되 아직 자리에 있을 시각. 무시되기 시작하면
 * 시각을 옮기지 말고 **오후 것부터 끈다**(그게 이 값의 유일한 조정 방향이다).
 */
const CHECKIN_PM_TIME = '17:00';
/** 진행판 큐를 가져오는 간격. **이 값이 곧 「무르기」 창의 길이다.** */
const BOARD_QUEUE_POLL_MS = 30_000;
/**
 * 노션이 직접 고쳐졌는지 보는 간격. **이 값이 곧 화면이 낡아 있을 수 있는
 * 최대 시간이다.** 안 바뀌었으면 1행 질의(0.5초)로 끝나므로 짧게 잡아도
 * 싸다 — 3분이면 하루 160회, 노션 한도(초당 3회 평균) 근처에도 못 간다.
 */
const NOTION_WATCH_MS = 180_000;

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
      maxDurationMinutes?: number;
      maxRetries?: number;
    };
    types: Record<string, {
      enabled: boolean;
      schedule?: string;           // per-type schedule override (e.g. "daily-02:00")
      cadence?: 'weekly' | 'biweekly' | 'monthly';  // default 'weekly'
      cadenceFrom?: string;        // biweekly anchor date (ISO YYYY-MM-DD)
      monthlyWeek?: 'first' | 'last';  // monthly: which week's Saturday
      mode?: 'change-detection';   // reports optional (no-file-generated is OK)
      tools?: string[];            // type-specific data (e.g. competitors.tools)
      allowedTools?: string[];
      writablePaths?: string[];
      sessionBudgetUsd?: number;
      maxDurationMinutes?: number;
      maxRetries?: number;
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
  maxDurationMs?: number;
  useSdk?: boolean;
  /** 사고 깊이 — 유일한 사고 손잡이. 생략하면 SDK 기본값 `'high'`(sdk-handler 주석). */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

export interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreateTokens: number;
  cacheReadTokens: number;
}

export interface SessionResult {
  text: string;
  costUsd: number;
  sessionId: string;
  subtype: string;  // 'success' | 'error_max_budget_usd' | ...
  usage?: SessionUsage;
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
  inputTokens?: number;
  outputTokens?: number;
  cacheCreateTokens?: number;
  cacheReadTokens?: number;
  via?: 'cli' | 'sdk';
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
  private workNudgeTimer: ReturnType<typeof setTimeout> | null = null;
  private checkinPmTimer: ReturnType<typeof setTimeout> | null = null;
  private notionWatchTimer: ReturnType<typeof setInterval> | null = null;
  private notionWatchBusy = false;
  private notionWatchFailures = 0;
  private daouKeepAliveTimer: ReturnType<typeof setTimeout> | null = null;
  private boardQueueTimer: ReturnType<typeof setInterval> | null = null;
  /** 한 판이 끝나기 전에 다음 판이 겹치지 않게. 노션 왕복이 폴링 간격보다 길 수 있다. */
  private boardQueueBusy = false;
  private boardQueueFailures = 0;

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
    /**
     * 진행판에서 온 **사람 말**을 이 방의 대화로 들여보내는 길. 없으면 그런 항목은
     * 큐에 남는다 — 짧은 문법과 달리 다시 만들 수 없는 글이라 버리지 않는다.
     */
    private askFromBoard?: (text: string) => Promise<void>,
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

    // Catch-up spinner fresh batch if missing (e.g. PC off at 00:00 data-sync → no novelty).
    // Lightweight: only fresh_pool_generator + build_daily_pool, not the full data-sync.
    setTimeout(() => this.catchUpSpinnerFreshIfNeeded().catch(e =>
      this.logger.error('Catch-up spinner fresh failed', e)), 20_000);

    // Daou session keep-alive — runs EVERY calendar day (incl. weekends/holidays), unlike the
    // working-day-gated data-sync. The Daou session dies from server-side idle timeout (~2-3d);
    // the weekday data-sync's /app/asset ping resets it Mon-Fri, but weekends have no ping →
    // session dies over the weekend → manual re-login every Monday (auto-relogin is CAPTCHA-blocked).
    // A daily ping on the always-on PC keeps one manual login alive indefinitely. Best-effort ping
    // on startup (covers a bot restart) + a recurring daily timer.
    // (the recurring daily timer itself is registered by scheduleAll() above)
    setTimeout(() => this.runDaouKeepAlive().catch(e =>
      this.logger.error('Daou keep-alive (startup) failed', e)), 25_000);
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
    // 업무 조회를 브리핑 세션과 **동시에** 시작한다 (workBriefBlock 주석 참조).
    const work = this.workBriefBlock();
    const result = await this.executeBriefing();
    this.recordSessionCost('briefing', result);
    return {
      text: result.text + await work +
        this.formatErrorReport() + this.formatCostLine(),
      hasReports: this.hasUnreadReports(),
    };
  }

  /** Manual trigger for -analyze command. Run single type or all default-schedule types. */
  async runAnalysisManual(type?: string): Promise<string> {
    if (!this.config) return '⚠️ Config not loaded.';
    const enabledTypes = this.getEnabledAnalysisTypes();
    if (enabledTypes.length === 0) return '⚠️ No analysis types enabled.';

    if (type) {
      // Single type
      if (!this.config.analysis.types[type]) {
        return `⚠️ Unknown analysis type: ${type}\nAvailable: ${enabledTypes.join(', ')}`;
      }
      if (!this.config.analysis.types[type].enabled) {
        return `⚠️ Analysis type '${type}' is disabled.`;
      }
      try {
        const result = await this.runSingleAnalysis(type);
        if (result.timedOut) return `⏱️ 분석 타임아웃: ${type}`;
        if (result.rateLimited) return `⚠️ 세션 리미트 초과: ${type}`;
        return `✅ 분석 완료: ${type} ($${result.costUsd.toFixed(4)})`;
      } catch (error) {
        return `❌ 분석 실패 (${type}): ${(error as Error).message}`;
      }
    }

    // All types — run the default schedule group
    const defaultSchedule = this.config.analysis.schedule;
    const groups = this.groupTypesBySchedule();
    const defaultTypes = groups.get(defaultSchedule) || [];
    if (defaultTypes.length === 0) return '⚠️ No types in default schedule.';

    await this.runAnalysisGroup(defaultSchedule, defaultTypes);
    return '✅ 분석 실행 완료 — 결과는 위 메시지 참고';
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

  private recordSessionCost(type: string, result: SessionResult): void {
    this.recordCost(type, result.costUsd, result.sessionId, {
      usage: result.usage,
      via: result.usage ? 'sdk' : 'cli',
    });
  }

  private recordCost(
    type: string,
    costUsd: number,
    sessionId: string,
    extras?: { usage?: SessionUsage; via?: 'cli' | 'sdk' },
  ): void {
    if (costUsd <= 0) return;
    const entry: CostEntry = {
      timestamp: new Date().toISOString(),
      type,
      costUsd,
      sessionId,
    };
    if (extras?.usage) {
      entry.inputTokens = extras.usage.inputTokens;
      entry.outputTokens = extras.usage.outputTokens;
      entry.cacheCreateTokens = extras.usage.cacheCreateTokens;
      entry.cacheReadTokens = extras.usage.cacheReadTokens;
    }
    if (extras?.via) entry.via = extras.via;
    this.costEntries.push(entry);
    this.saveCosts();
    this.logger.info('Recorded cost', {
      type,
      costUsd: costUsd.toFixed(4),
      sessionId,
      via: extras?.via,
      cacheRead: extras?.usage?.cacheReadTokens,
    });
  }

  private formatCostLine(): string {
    const stats = this.getCostStats();
    let line = `\n\n💰 *비용* — 오늘: $${stats.daily.toFixed(2)} | 이번 주: $${stats.weekly.toFixed(2)} | 이번 달: $${stats.monthly.toFixed(2)}`;
    if (stats.analysisMonthly > 0) {
      line += `\n📊 *분석* — 이번 주: $${stats.analysisWeekly.toFixed(2)} | 이번 달: $${stats.analysisMonthly.toFixed(2)}`;
    }
    return line;
  }

  /**
   * Check if there are unread regular reports.
   * Scans only reports/scheduled-reports/<type>/ — the same scope the briefing
   * prompt uses (CLAUDE.md §9). Ad-hoc work reports under reports/<other>/ are
   * intentionally excluded so they never leak into the briefing surface.
   */
  private hasUnreadReports(): boolean {
    const reportsDir = path.join(this.workingDir, 'reports', 'scheduled-reports');
    if (!fs.existsSync(reportsDir)) return false;
    for (const dir of fs.readdirSync(reportsDir)) {
      if (dir === 'archived') continue;
      const subdir = path.join(reportsDir, dir);
      if (!fs.statSync(subdir).isDirectory()) continue;
      for (const fname of fs.readdirSync(subdir)) {
        if (fname.endsWith('.md') && fname !== '.gitkeep' && fname !== 'README.md') return true;
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
    // Unconditional — not gated by any config section. Must live here (not only in start())
    // because clearAllTimers() kills daouKeepAliveTimer on every config reload; scheduleAll()
    // is its re-registration counterpart. Omitting it silently ended the keep-alive chain on
    // the first config write after startup (2026-07-15 → session died 5 days later).
    this.scheduleDaouKeepAlive();
    // 위 keep-alive 와 같은 이유로 여기 있어야 한다 — clearAllTimers() 가 설정 저장마다
    // 이 타이머를 지우므로, 재등록 지점이 scheduleAll() 이다.
    if (isWorkAssistantEnabled()) {
      this.scheduleWorkNudge();
      this.scheduleCheckinPm();
      this.startBoardQueuePoller();
      this.startNotionWatch();
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
    if (this.daouKeepAliveTimer) {
      clearTimeout(this.daouKeepAliveTimer);
      this.daouKeepAliveTimer = null;
    }
    if (this.workNudgeTimer) {
      clearTimeout(this.workNudgeTimer);
      this.workNudgeTimer = null;
    }
    if (this.checkinPmTimer) {
      clearTimeout(this.checkinPmTimer);
      this.checkinPmTimer = null;
    }
    if (this.notionWatchTimer) {
      clearInterval(this.notionWatchTimer);
      this.notionWatchTimer = null;
    }
    if (this.boardQueueTimer) {
      clearInterval(this.boardQueueTimer);
      this.boardQueueTimer = null;
    }
  }

  // --- 업무 (work-assistant) ---

  /**
   * 브리핑 꼬리에 붙일 업무 요약. **절대 던지지 않는다** — 업무 조회가 실패했다고
   * 날씨·일정·보고서까지 사라지면 안 된다.
   *
   * **브리핑 세션과 동시에 시작한다**(호출자가 `await` 를 미룬다). 브리핑이 끝난
   * 뒤에 부르면 노션 왕복이 「세션 종료」와 「메시지 발송」 사이에 끼어 그 창만큼
   * 브리핑 전체를 잃을 위험이 커진다 — 2026-08-06 에 실제로 브리핑 완료 1 초 뒤
   * 봇이 재시작해 그 창에 걸렸다. 세션이 수십 초 걸리므로 동시에 돌리면 추가
   * 지연이 0 이다.
   */
  private async workBriefBlock(): Promise<string> {
    if (!isWorkAssistantEnabled()) return '';
    try {
      const text = await briefShort();
      return text ? `\n\n${text}` : '';
    } catch (error) {
      this.logger.warn('Work brief failed', error);
      return '\n\n⚠️ 업무 요약을 못 불러왔습니다 — 세션에서 `brief` 로 확인하세요.';
    }
  }

  /**
   * 08:55 업무 넛지 — 09:00 데일리 미팅 직전 1회.
   *
   * **브리핑과 별개 장치다.** 브리핑(08:00)은 내용을 보여주고, 넛지는 세션을 열게 한다.
   * 그래서 목록을 다시 보내지 않고 급한 1~2건만 근거로 싣는다.
   *
   * 침묵 조건은 **하나뿐이다 — 댈 근거가 없을 때.** 아침 인사를 했는지는 안 본다
   * (2026-08-05 사용자 확정): 넛지의 목적이 데일리 직전에 한 번 보는 것이라,
   * 이미 세션을 열었더라도 08:55 의 목록은 따로 값이 있다. 판정은 `tasks.py` 가
   * 한다(봇에 로직을 복제하지 않는다).
   *
   * **catch-up 은 일부러 없다.** 봇이 09:30 에 뜨면 이 넛지는 이미 의미가 없다 —
   * 데일리가 지난 뒤의 "곧 데일리입니다" 는 소음이다.
   */
  private scheduleWorkNudge(): void {
    const nextFire = this.getNextWorkingDay(WORK_NUDGE_TIME);
    this.logger.info('Scheduled work nudge', { time: WORK_NUDGE_TIME, nextFire: nextFire.toISOString() });

    this.workNudgeTimer = setTimeout(async () => {
      try {
        const nonWorking = this.isNonWorkingDay();
        if (nonWorking.skip) {
          this.logger.info(`Skipping work nudge (${nonWorking.reason})`);
        } else {
          const text = await briefNudge();
          if (text) {
            await this.sendMessage(text);
          } else {
            this.logger.info('Skipping work nudge (nothing urgent)');
          }
          // **진행을 걷어들이는 자리는 체크인 하나뿐이다.** 급한 것 넛지와 같은
          // 시각에 붙여 슬롯을 늘리지 않는다 — 물을 게 없으면 알아서 빈다.
          const ask = await checkinNudge(false);
          if (ask) await this.sendMessage(ask);
        }
      } catch (error) {
        // **실패는 알린다.** 넛지는 "급한 게 없으면 침묵" 이라, 조회가 깨져서 못 온
        // 것과 보낼 게 없어서 안 온 것이 받는 쪽에서 똑같아 보인다. 그러면 안전망이
        // 죽은 날에도 정상으로 읽힌다(2026-08-06: 노션 연결이 사내망에서 끊기는
        // 것을 확인 — 실패율 50% 이상). 하루 한 번뿐이라 소음이 되지 않는다.
        this.logger.error('Work nudge failed', error);
        await this.sendMessage(
          '⏰ 업무 조회가 안 됩니다 — 넛지를 못 만들었습니다. 노션 연결을 확인하세요.',
        ).catch(() => { });
      }
      this.scheduleWorkNudge();
    }, nextFire.getTime() - Date.now());
  }

  /**
   * 오후 체크인 넛지 — 오늘까지의 진행을 걷는다.
   *
   * **아침 것과 묻는 대상이 다르다**(어제 vs 오늘). 오늘 이미 답을 받았거나
   * 물을 게 없거나 「조용히」 기간이면 `tasks.py` 가 빈 출력을 주고, 그러면
   * 아무것도 보내지 않는다 — 판정을 봇에 복제하지 않는다.
   *
   * **catch-up 은 없다.** 봇이 밤에 뜨면 "지금까지 뭐 됐나요"는 이미 늦다.
   */
  private scheduleCheckinPm(): void {
    const nextFire = this.getNextWorkingDay(CHECKIN_PM_TIME);
    this.logger.info('Scheduled afternoon check-in', {
      time: CHECKIN_PM_TIME, nextFire: nextFire.toISOString(),
    });

    this.checkinPmTimer = setTimeout(async () => {
      try {
        const nonWorking = this.isNonWorkingDay();
        if (nonWorking.skip) {
          this.logger.info(`Skipping afternoon check-in (${nonWorking.reason})`);
        } else {
          const ask = await checkinNudge(true);
          if (ask) {
            await this.sendMessage(ask);
          } else {
            this.logger.info('Skipping afternoon check-in (nothing to ask)');
          }
        }
      } catch (error) {
        // 조용히 넘긴다 — 08:55 넛지가 같은 조회 실패를 이미 시끄럽게 알린다.
        this.logger.error('Afternoon check-in failed', error);
      }
      this.scheduleCheckinPm();
    }, nextFire.getTime() - Date.now());
  }

  /**
   * 노션에서 **직접** 고친 것을 따라잡는다 — 3분마다.
   *
   * 수정은 진행판과 스탠리에서 한다는 것이 규율이지만 노션은 막을 수 없다.
   * 막는 대신 따라잡는다: 안 따라잡으면 화면이 최대 8시간 낡고, **낡은 화면은
   * 조용히 틀린다**(사람은 최신인 줄 알고 본다).
   *
   * 바뀐 게 없으면 `tasks.py` 가 1행 질의만 하고 끝낸다 — 그래서 3분이 싸다.
   * 판정·갱신·배포 순서는 전부 파이썬에 있다(봇에 복제하지 않는다).
   *
   * **「조용히」와 무관하다.** 화면을 최신으로 두는 것은 미는 알림이 아니라서,
   * 출장 중에도 열어 보면 최신이어야 한다.
   */
  private startNotionWatch(): void {
    this.logger.info('Started Notion watch', { everyMs: NOTION_WATCH_MS });
    this.notionWatchTimer = setInterval(async () => {
      // 앞판이 아직 도는 중이면 건너뛴다 — 다시 그리는 데 몇 초 걸린다.
      if (this.notionWatchBusy) return;
      this.notionWatchBusy = true;
      try {
        const redrew = await refreshBoardIfChanged();
        if (redrew) {
          this.logger.info('Notion changed outside the board — 진행판을 다시 올렸습니다');
        }
        if (this.notionWatchFailures) {
          this.logger.info(`Notion watch recovered (${this.notionWatchFailures}회 실패 뒤)`);
          this.notionWatchFailures = 0;
        }
      } catch (error) {
        // **이유를 메시지에 넣는다.** 로거가 Error 를 `{}` 로 찍어서, 따로 넣지
        // 않으면 이유 없는 경고만 쌓인다(2026-08-07 에 그렇게 9분을 날렸다).
        this.notionWatchFailures += 1;
        if (this.notionWatchFailures === 1 || this.notionWatchFailures % 20 === 0) {
          const why = error instanceof Error ? error.message : String(error);
          this.logger.warn(`Notion watch failed (${this.notionWatchFailures}회째): ${why}`);
        }
      } finally {
        this.notionWatchBusy = false;
      }
    }, NOTION_WATCH_MS);
  }

  /**
   * 진행판에서 누른 것을 가져와 반영한다 — 30초마다.
   *
   * **폴링 간격이 곧 무르는 창이다.** 가져가기 전이면 화면에서 뺄 수 있고, 가져간
   * 뒤에는 못 무른다(그때는 이미 노션에 쓰고 있을 수 있다). 확인 대화상자를 안
   * 두는 이유가 이것이다 — 폰에서 한 번 더 누르게 만들면 안 쓰게 된다.
   *
   * **반영한 것은 DM 한 줄로 알린다.** 큐는 눈에 안 보여서, 알리지 않으면 눌렀는데
   * 됐는지를 진행판이 다시 그려질 때까지 알 수 없다. 알리는 것이라 봇의 수신 관문은
   * 건드리지 않는다.
   *
   * 실패는 여기서 시끄럽게 하지 않는다 — 30초마다 도는 자리라 네트워크가 한 번
   * 튈 때마다 DM 이 오면 무시하는 습관이 든다. 반영이 밀리는 것은 `brief` 의 ⛔ 가
   * 잡는다(폴러 밖에 있어야 폴러가 죽어도 보인다).
   */
  private startBoardQueuePoller(): void {
    if (!boardQueueEnabled()) {
      this.logger.info('Board queue poller off (주소나 열쇠 없음)');
      return;
    }
    this.logger.info('Started board queue poller', { everyMs: BOARD_QUEUE_POLL_MS });
    this.boardQueueTimer = setInterval(async () => {
      if (this.boardQueueBusy) return;
      this.boardQueueBusy = true;
      try {
        const r = await drain(quickUpdate, this.askFromBoard ?? null);
        if (this.boardQueueFailures) {
          this.logger.info(`Board queue recovered (${this.boardQueueFailures}회 실패 뒤)`);
          this.boardQueueFailures = 0;
        }
        if (r.duplicates) {
          this.logger.info(`이미 반영한 것 ${r.duplicates}건을 지웠습니다`);
        }
        for (const { output } of r.applied) {
          if (output) await this.sendMessage(output).catch(() => { });
        }
        for (const item of r.dropped) {
          // **원인을 좁혀 말하지 않는다.** rc 2 는 「업무를 못 찾음」과 「형식이
          // 안 맞음」을 함께 뜻하는데, 봇이 둘을 가르려면 판정을 복제해야 한다.
          // 대신 **다음에 무엇을 할지**를 준다 — 받는 쪽에 필요한 것은 그것이다.
          await this.sendMessage(
            `⚠️ 진행판에서 누른 「${item.label || item.text}」을 반영하지 못했습니다 ` +
            '— 그 업무를 찾지 못했거나 형식이 맞지 않습니다.\n' +
            '누른 것은 취소됐습니다. 진행판을 새로고침해 다시 누르거나, ' +
            '업무 제목을 눌러 노션에서 바로 바꾸세요.',
          ).catch(() => { });
        }
        for (const item of r.lost) {
          // **원문을 그대로 돌려준다.** 한 번만 시도하는 대가라, 여기서 안 돌려주면
          // 사람이 쓴 글이 조용히 사라진다. 붙여넣기만 하면 다시 갈 수 있게 둔다.
          await this.sendMessage(
            '⚠️ 진행판에서 보낸 말을 넘기지 못했습니다. 원문은 아래 그대로입니다 ' +
            '— 다시 보내시려면 이 방에 붙여넣으세요.\n\n' + item.text,
          ).catch(() => { });
        }
      } catch (error) {
        // **이유를 본문에 넣는다.** Error 객체를 그대로 넘기면 로거가
        // `JSON.stringify` 로 `{}` 를 찍어, 실패는 보이는데 왜인지가 안 남는다 —
        // 2026-08-07 에 워커를 올리기 전 9분 동안 이유 없는 경고만 쌓였다.
        //
        // **매번 찍지 않는다.** 30초마다 도는 자리라 하루 못 고치면 로그가 같은
        // 줄로 덮인다. 처음과 10분마다만 남긴다.
        this.boardQueueFailures += 1;
        if (this.boardQueueFailures === 1 || this.boardQueueFailures % 20 === 0) {
          const why = error instanceof Error ? error.message : String(error);
          this.logger.warn(
            `Board queue drain failed (${this.boardQueueFailures}회째): ${why}`);
        }
      } finally {
        this.boardQueueBusy = false;
      }
    }, BOARD_QUEUE_POLL_MS);
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
        const work = this.workBriefBlock();   // 세션과 동시에 시작
        const result = await this.executeBriefing();
        this.recordSessionCost('briefing', result);

        // Check rate limit in result text
        if (isRateLimitText(result.text)) {
          this.logger.warn('Briefing hit rate limit');
          await this.sendMessage('⏳ 브리핑 실행 중 rate limit 도달. 다음 업무일에 재시도합니다.').catch(() => {});
        } else {
          // Append work summary + error report + cost stats line
          await this.sendMessage(result.text + await work +
            this.formatErrorReport() + this.formatCostLine());

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

          // NAS 이동 컨펌 큐 — 항목별 결정 버튼 (inbox auto-classify company 분류분)
          try {
            const nasBlocks = await buildNasQueueBlocks(await listNasQueue());
            if (nasBlocks) {
              await this.sendMessage('📦 NAS 이동 컨펌 대기', nasBlocks).catch(() => {});
            }
          } catch (err) {
            this.logger.warn('NAS confirm queue check failed', err);
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
      const work = this.workBriefBlock();   // 세션과 동시에 시작
      const result = await this.executeBriefing();
      this.recordSessionCost('briefing', result);
      await this.sendMessage(result.text + await work +
        this.formatErrorReport() + this.formatCostLine());

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

  /**
   * If today's spinner fresh batch is missing, generate it now.
   *
   * The daily-00:00 data-sync (which runs fresh_pool_generator) has no catch-up: if the
   * PC/bot is down at 00:00 the run is silently skipped, leaving morning sessions on the
   * baseline+categorical pool with no novelty until the noon data-sync (12:00) fills it.
   * This closes that 00:00→12:00 morning gap on bot startup. Best-effort — any failure
   * leaves the pool on its graceful baseline fallback.
   */
  private async catchUpSpinnerFreshIfNeeded(): Promise<void> {
    if (this.isNonWorkingDay().skip) return; // fresh not generated on holidays/weekends

    const spinnerDir = path.join(os.homedir(), '.claude', 'spinner-verbs');
    const todayKST = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
    const freshPath = path.join(spinnerDir, `daily-fresh-${todayKST}.yaml`);
    if (fs.existsSync(freshPath)) return; // 00:00 ran, or an earlier catch-up already did it

    this.logger.info('Catch-up spinner fresh: today batch missing, generating now', { freshPath });
    try {
      const gen = await this.runSpinnerScript('fresh_pool_generator.py', spinnerDir, 240_000);
      if (gen.code !== 0 || !fs.existsSync(freshPath)) {
        // fresh_pool_generator is graceful (exit 0 + no file on agy/parse failure) — leave baseline.
        this.logger.warn('Catch-up spinner fresh: generator produced no batch (graceful skip)', {
          code: gen.code,
          stderrTail: gen.stderr.trim().split('\n').slice(-3).join(' | '),
        });
        return;
      }
      await this.runSpinnerScript('build_daily_pool.py', spinnerDir, 60_000);
      this.logger.info('Catch-up spinner fresh: done');
    } catch (error) {
      this.logger.error('Catch-up spinner fresh failed', error);
    }
  }

  /** Run a spinner-verbs python script in its own dir. Mirrors nas-confirm.ts spawn pattern. */
  private runSpinnerScript(
    script: string,
    cwd: string,
    timeoutMs: number,
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const proc = spawn('python', ['-X', 'utf8', script], {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8' },
        // 콘솔 창이 화면에 깜빡이지 않게 한다. 이 프로세스에는 콘솔이 없어서
        // 윈도우가 자식마다 새 콘솔을 만들어 주고, `shell: true` 는 cmd.exe 를
        // 거치므로 특히 필요하다. 출력은 이미 파이프로 받고 있어 잃는 것이 없다.
        windowsHide: true,
      });
      let stdout = '';
      let stderr = '';
      proc.stdout?.on('data', (c: Buffer) => { stdout += c.toString('utf-8'); });
      proc.stderr?.on('data', (c: Buffer) => { stderr += c.toString('utf-8'); });
      const killTimer = setTimeout(() => {
        try {
          if (process.platform === 'win32' && proc.pid) {
            execSync(`taskkill /F /T /PID ${proc.pid}`, { stdio: 'ignore' });
          } else {
            proc.kill('SIGKILL');
          }
        } catch {}
      }, timeoutMs);
      proc.on('error', (err) => { clearTimeout(killTimer); reject(err); });
      proc.on('close', (code) => { clearTimeout(killTimer); resolve({ code: code ?? -1, stdout, stderr }); });
    });
  }

  /**
   * Ping Daou to reset its server-side idle timer, keeping the operator's session alive.
   * Reuses groupware_daily's --keepalive mode (session_alive() + alert upsert, no fetch/worker),
   * run from the claude-workflow repo root (this.workingDir). Best-effort — never throws.
   */
  private runDaouKeepAlive(): Promise<void> {
    return new Promise((resolve) => {
      const proc = spawn(
        'python',
        ['-X', 'utf8', '-m', 'mycelium.sync.groupware_daily', '--keepalive', '--json'],
        {
          cwd: this.workingDir,
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: process.platform === 'win32',
          env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8' },
          // 콘솔 창이 화면에 깜빡이지 않게 한다. 이 프로세스에는 콘솔이 없어서
          // 윈도우가 자식마다 새 콘솔을 만들어 주고, `shell: true` 는 cmd.exe 를
          // 거치므로 특히 필요하다. 출력은 이미 파이프로 받고 있어 잃는 것이 없다.
          windowsHide: true,
        },
      );
      let stdout = '';
      let stderr = '';
      proc.stdout?.on('data', (c: Buffer) => { stdout += c.toString('utf-8'); });
      proc.stderr?.on('data', (c: Buffer) => { stderr += c.toString('utf-8'); });
      const killTimer = setTimeout(() => {
        try {
          if (process.platform === 'win32' && proc.pid) {
            execSync(`taskkill /F /T /PID ${proc.pid}`, { stdio: 'ignore' });
          } else {
            proc.kill('SIGKILL');
          }
        } catch {}
      }, 60_000);
      proc.on('error', (err) => {
        clearTimeout(killTimer);
        this.logger.error('Daou keep-alive spawn error', err);
        resolve();
      });
      proc.on('close', () => {
        clearTimeout(killTimer);
        const alive = /"session_alive":\s*true/.test(stdout);
        this.logger.info('Daou keep-alive ping', {
          alive,
          out: (stdout.trim() || stderr.trim()).slice(0, 200),
        });
        resolve();
      });
    });
  }

  /** Schedule the Daou keep-alive at 13:00 EVERY calendar day (no working-day skip). */
  private scheduleDaouKeepAlive(): void {
    // Idempotent: drop any existing timer so a double-call can't fork the self-rescheduling chain.
    if (this.daouKeepAliveTimer) clearTimeout(this.daouKeepAliveTimer);
    const nextFire = this.getNextEveryDayTime('13:00');
    const msUntil = Math.max(0, nextFire.getTime() - Date.now());
    this.logger.info('Scheduled Daou keep-alive', { nextFire: nextFire.toISOString() });
    this.daouKeepAliveTimer = setTimeout(async () => {
      await this.runDaouKeepAlive().catch(e => this.logger.error('Daou keep-alive failed', e));
      this.scheduleDaouKeepAlive();
    }, msUntil);
  }

  /** Next occurrence of HH:MM on ANY day — unlike getNextWorkingDay, does not skip weekends/holidays. */
  private getNextEveryDayTime(time: string): Date {
    const [h, m] = time.split(':').map(Number);
    const now = new Date();
    const next = new Date(now);
    next.setHours(h, m, 0, 0);
    if (next <= now) {
      next.setDate(next.getDate() + 1);
    }
    return next;
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
    // Validate cache is from today — stale cache shows yesterday's events
    // Use local timezone (KST), not UTC — at 08:00 KST, UTC date is still yesterday
    const toLocalDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const todayLocal = toLocalDate(new Date());
    let cache = this.calendarPoller?.getCache();
    if (cache && toLocalDate(new Date(cache.fetchedAt)) !== todayLocal) {
      this.logger.info('Calendar cache is stale (not today), refreshing...');
      cache = await this.calendarPoller?.refreshCache() ?? null;
    }
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

    const useSdk = shouldUseSdk('briefing');
    const result = await this.spawnSession(prompt, {
      workingDirectory: this.workingDir,
      model: 'claude-haiku-4-5-20251001',
      permissionMode: 'default',
      allowedTools,
      noSessionPersistence: true,
      skipMcp: true,
      env: { CLAUDE_SCHEDULED: '1' },
      useSdk,
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
      (type, result) => this.recordSessionCost(type, result),
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
      this.scheduleAnalysisGroup(schedule, types);
    }
  }

  /** Schedule a single analysis group (used for initial scheduling and rescheduling). */
  private scheduleAnalysisGroup(schedule: string, types: string[]): void {
    const nextFire = this.getNextAnalysisTime(schedule);
    const msUntil = nextFire.getTime() - Date.now();

    this.logger.info('Scheduled analysis group', {
      schedule,
      types,
      nextFire: nextFire.toISOString(),
    });

    const timer = setTimeout(async () => {
      try {
        await this.runAnalysisGroup(schedule, types);
      } catch (error) {
        this.logger.error('Analysis run failed', { schedule, error });
      }
      // Reschedule for next regular occurrence
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

  private async runAnalysisGroup(schedule: string, types: string[]): Promise<void> {
    if (!this.config) return;

    const isDaily = schedule.startsWith('daily');
    const defaults = this.config.analysis.defaults;
    const completedTypes: string[] = [];
    const skippedTypes: { type: string; reason: string }[] = [];
    const timedOutTypes: string[] = [];
    const failedRetryTypes: { type: string; sessionId: string }[] = [];

    // Filter by cadence (weekly / biweekly / monthly)
    const today = new Date();
    const runnableTypes = types.filter(type => {
      const decision = this.shouldRunToday(type, today);
      if (!decision.run) {
        skippedTypes.push({ type, reason: decision.reason || 'cadence' });
        this.logger.info(`Cadence skip: ${type}`, { reason: decision.reason });
        return false;
      }
      return true;
    });

    if (skippedTypes.length > 0) {
      this.logger.info(`Cadence filter: ${runnableTypes.length}/${types.length} types will run`, {
        skipped: skippedTypes.map(s => `${s.type} (${s.reason})`).join('; '),
      });
    }

    for (const type of runnableTypes) {
      const typeConfig = this.config.analysis.types[type];
      const maxRetries = (typeConfig?.maxRetries as number | undefined)
        ?? defaults.maxRetries ?? 2;

      let succeeded = false;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          const result = await this.runSingleAnalysis(type);

          if (result.timedOut) {
            if (attempt < maxRetries) {
              this.logger.warn(`Analysis ${type} timed out, retry ${attempt + 1}/${maxRetries}`);
              continue; // Retry with fresh session (same WebFetch may hang again on resume)
            }
            this.logger.error(`Analysis ${type} timed out after ${attempt + 1} attempts`);
            errorCollector.add('AssistantScheduler', `분석 타임아웃 (${type}): ${maxRetries}회 재시도 후 포기`);
            timedOutTypes.push(type);
            break;
          }

          if (result.rateLimited) {
            this.logger.warn(`Analysis ${type} hit session limit`);
            // Daily: 기본 no retry (data-sync 등) — 단, retryOnLimit=true면 +1h 단발 예약 재시도 1회 허용
            //        (2026-06-24: API 529·타임아웃으로 데일리 통째 누락 방지. 단발 지연 재시도라 7-spawn 사고와 무관)
            // Weekly: 기본 retry (retryOnLimit=false면 차단)
            const shouldRetry = typeConfig?.retryOnLimit === true
              || (!isDaily && typeConfig?.retryOnLimit !== false);
            if (shouldRetry && result.sessionId) {
              failedRetryTypes.push({ type, sessionId: result.sessionId });
            }
            break; // Stop remaining types in this group (rate limit affects all)
          }

          succeeded = true;
          completedTypes.push(type);
          break;
        } catch (error) {
          const msg = (error as Error).message || '';
          if (isRateLimitText(msg)) {
            this.logger.warn(`Analysis ${type} hit rate limit, stopping group`);
            break;
          }
          if (attempt < maxRetries) {
            this.logger.warn(`Analysis ${type} failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying`, { error: msg });
            continue;
          }
          errorCollector.add('AssistantScheduler', `분석 실행 실패 (${type}): ${msg}`);
          this.logger.error(`Analysis failed for type: ${type}`, error);
          break;
        }
      }

      // Rate limit breaks the entire group
      if (failedRetryTypes.length > 0) break;
    }

    // data-sync(daily-00:00)=야간, data-sync-noon(daily-12:00)=정오. 둘 다 startsWith('daily').
    const label = !isDaily ? '주간 분석' : (schedule === 'daily-12:00' ? '정오 동기화' : '야간 동기화');
    const parts = [`📊 ${label} 완료: ${completedTypes.join(', ') || '(없음)'}`];
    if (timedOutTypes.length > 0) {
      parts.push(`⏱️ 타임아웃: ${timedOutTypes.join(', ')}`);
    }
    if (skippedTypes.length > 0) {
      parts.push(`⏭️ cadence 스킵: ${skippedTypes.map(s => s.type).join(', ')}`);
    }
    await this.sendMessage(parts.join('\n')).catch(() => {});

    // Schedule retry for session-limit failures (weekly only)
    if (failedRetryTypes.length > 0) {
      const retryTime = this.getNextHourPlus5Min();
      const msUntil = retryTime.getTime() - Date.now();
      const retryTypes = failedRetryTypes.map(f => f.type);

      this.logger.info('Scheduling retry for session-limited types', {
        types: retryTypes,
        retryTime: retryTime.toISOString(),
      });
      await this.sendMessage(
        `⏳ 세션 리미트 초과: ${retryTypes.join(', ')} → ${retryTime.toLocaleTimeString('ko-KR')} 재시도 예정`,
      ).catch(() => {});

      const retryTimerKey = `retry-${schedule}`;
      const retryTimer = setTimeout(async () => {
        this.analysisTimers.delete(retryTimerKey);
        for (const { type, sessionId } of failedRetryTypes) {
          try {
            this.logger.info(`Retrying analysis: ${type}`, { sessionId });
            await this.runSingleAnalysis(type, sessionId);
          } catch (error) {
            this.logger.error(`Retry failed for: ${type}`, error);
          }
        }
        await this.sendMessage(
          `📊 재시도 완료: ${retryTypes.join(', ')}`,
        ).catch(() => {});
      }, msUntil);

      this.analysisTimers.set(retryTimerKey, retryTimer);
    }
  }

  /** Calculate next hour + 5 minutes (retry buffer). */
  private getNextHourPlus5Min(): Date {
    const next = new Date();
    next.setHours(next.getHours() + 1, 5, 0, 0);
    return next;
  }

  private async runSingleAnalysis(
    type: string,
    resumeSessionId?: string,
  ): Promise<{ rateLimited: boolean; timedOut: boolean; sessionId?: string; costUsd: number }> {
    const promptPath = path.join(this.promptsDir, `analysis-${type}.md`);
    if (!fs.existsSync(promptPath)) {
      this.logger.warn(`Analysis prompt not found: ${promptPath}`);
      return { rateLimited: false, timedOut: false, costUsd: 0 };
    }

    // 외부 정보 수집 분석(ai-practice, competitors)은 agy로 위임 — 6/15 이후
    // Agent SDK $100 크레딧 풀 보존. agy는 세션 resume 미지원이므로 retry 시는
    // 기존 SDK/CLI 경로로 자연 폴백.
    if (!resumeSessionId && this.shouldUseAgy(type)) {
      return this.runAgyAnalysis(type, promptPath);
    }

    const prompt = fs.readFileSync(promptPath, 'utf-8');
    const defaults = this.config!.analysis.defaults;
    const typeConfig = this.config!.analysis.types[type];
    const allowedTools = typeConfig?.allowedTools ?? defaults.allowedTools;
    const writablePaths = typeConfig?.writablePaths ?? defaults.writablePaths;
    const maxDurationMinutes = (typeConfig?.maxDurationMinutes as number | undefined)
      ?? defaults.maxDurationMinutes ?? 60;

    const useSdk = shouldUseSdk(`analysis:${type}`);
    // Pin model explicitly so future SDK default changes can't silently promote
    // analyses to Opus (which would burn the $100/mo credit fast).
    // Override per-type via config.analysis.types[type].model or ANALYSIS_MODEL env.
    const analysisModel = (typeConfig as any)?.model
      ?? process.env.ANALYSIS_MODEL
      ?? 'claude-sonnet-4-6';

    const result = await this.spawnSession(
      resumeSessionId ? 'continue' : prompt,
      {
        workingDirectory: this.workingDir,
        model: analysisModel,
        permissionMode: 'default',
        allowedTools,
        appendSystemPrompt: `CRITICAL: ${writablePaths.join(', ')} 디렉토리에만 새 파일 생성/수정. 그 외 파일 수정/삭제 금지.`,
        env: { ASSISTANT_MODE: 'analysis', CLAUDE_SCHEDULED: '1' },
        resumeSessionId,
        skipMcp: true,
        maxDurationMs: maxDurationMinutes * 60_000,
        useSdk,
        // 주간 분석은 깊게 읽고 쓰는 자리라 기본값 'high' 를 그대로 쓴다. 앞서
        // 여기 걸려 있던 `thinkingBudgetTokens: 5000` 은 적응형 사고를 끄는
        // 구형 경로였다 — 깊게 하려던 설정이 오히려 얕게 묶고 있었다(2026-08-06).
      },
    );

    this.recordSessionCost(`analysis-${type}`, result);

    this.logger.info('Analysis session completed', {
      type,
      subtype: result.subtype,
      costUsd: result.costUsd.toFixed(4),
      via: useSdk ? 'sdk' : 'cli',
      cacheRead: result.usage?.cacheReadTokens,
      textPreview: result.text?.substring(0, 600),
    });

    // Timeout detection
    if (result.subtype === 'error_timeout') {
      return { rateLimited: false, timedOut: true, sessionId: result.sessionId, costUsd: result.costUsd };
    }

    // Rate limit / session limit detection
    if (isRateLimitText(result.text) || result.subtype === 'error_max_budget_usd') {
      return { rateLimited: true, timedOut: false, sessionId: result.sessionId, costUsd: result.costUsd };
    }

    return { rateLimited: false, timedOut: false, sessionId: result.sessionId, costUsd: result.costUsd };
  }

  /**
   * agy(외부 모델)로 위임할 분석 type 여부.
   * 기본: ai-practice, competitors (외부 정보 수집 — WebSearch 의존).
   * ANALYSIS_AGY_TYPES env로 override (콤마 구분).
   */
  private shouldUseAgy(type: string): boolean {
    const raw = process.env.ANALYSIS_AGY_TYPES ?? 'ai-practice,competitors';
    return raw.split(',').map(s => s.trim()).filter(Boolean).includes(type);
  }

  private async runAgyAnalysis(
    type: string,
    promptPath: string,
  ): Promise<{ rateLimited: boolean; timedOut: boolean; sessionId?: string; costUsd: number }> {
    const dateStr = new Date().toISOString().substring(0, 10);
    const outDir = path.join(this.workingDir, 'reports', type);
    const outPath = path.join(outDir, `.agy-raw-${dateStr}.txt`);
    const sessionId = `agy-${dateStr}-${type}`;

    this.logger.info('Running agy analysis', { type, promptPath, outPath });

    try {
      const result = await runAgy({
        promptPath,
        workingDirectory: this.workingDir,
        outPath,
        timeoutSeconds: 600,
        quietSecs: 30,
        logger: this.logger,
      });

      this.logger.info('agy analysis completed', {
        type,
        via: 'agy',
        sessionId,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        generatedFiles: result.generatedFiles,
        timedOut: result.timedOut,
      });

      if (result.exitCode !== 0 || result.timedOut) {
        errorCollector.add(
          'AssistantScheduler',
          `agy ${type} 실패: exitCode=${result.exitCode}, timedOut=${result.timedOut}`,
        );
        return { rateLimited: false, timedOut: result.timedOut, sessionId, costUsd: 0 };
      }

      return { rateLimited: false, timedOut: false, sessionId, costUsd: 0 };
    } catch (error) {
      this.logger.error('agy analysis exception', error);
      errorCollector.add('AssistantScheduler', `agy ${type} 예외: ${(error as Error).message}`);
      return { rateLimited: false, timedOut: false, costUsd: 0 };
    }
  }

  // --- Date/time utilities ---

  /**
   * Check if a type should run today based on cadence config.
   * - weekly (default): always true
   * - biweekly: every 14 days from cadenceFrom
   * - monthly + monthlyWeek='first': only first Saturday of the month
   * - monthly + monthlyWeek='last': only last Saturday of the month
   */
  private shouldRunToday(type: string, today: Date = new Date()): { run: boolean; reason?: string } {
    const cfg = this.config?.analysis.types[type];
    if (!cfg) return { run: true };
    const cadence = cfg.cadence ?? 'weekly';

    if (cadence === 'weekly') return { run: true };

    if (cadence === 'biweekly') {
      if (!cfg.cadenceFrom) return { run: true, reason: 'biweekly without cadenceFrom, treating as weekly' };
      const from = new Date(cfg.cadenceFrom + 'T00:00:00');
      const todayMidnight = new Date(today.getFullYear(), today.getMonth(), today.getDate());
      const diffDays = Math.floor((todayMidnight.getTime() - from.getTime()) / 86_400_000);
      if (diffDays < 0) return { run: false, reason: `biweekly not started (from=${cfg.cadenceFrom})` };
      if (diffDays % 14 === 0) return { run: true };
      return { run: false, reason: `biweekly off-cycle (day ${diffDays} from ${cfg.cadenceFrom})` };
    }

    if (cadence === 'monthly') {
      const day = today.getDay();       // 6 = Saturday
      const date = today.getDate();
      if (day !== 6) return { run: false, reason: 'monthly: not Saturday' };

      if (cfg.monthlyWeek === 'first') {
        if (date <= 7) return { run: true };
        return { run: false, reason: 'monthly-first: not first Saturday' };
      }
      if (cfg.monthlyWeek === 'last') {
        const nextWeek = new Date(today);
        nextWeek.setDate(date + 7);
        if (nextWeek.getMonth() !== today.getMonth()) return { run: true };
        return { run: false, reason: 'monthly-last: not last Saturday' };
      }
      // monthly without monthlyWeek → treat as first
      return date <= 7 ? { run: true } : { run: false, reason: 'monthly: not first Saturday (default)' };
    }

    return { run: true };
  }

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
