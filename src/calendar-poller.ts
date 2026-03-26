/**
 * CalendarPoller — direct HTTP polling for Google Calendar events.
 *
 * Replaces MCP-based AI polling with:
 * 1. Direct Google Calendar REST API calls (Node 22 native fetch)
 * 2. Deterministic diff algorithm (no AI cost)
 * 3. AI judgment only when diff detected (Haiku model, ~$0.005/call)
 * 4. Notification queue with 1-minute dispatch timer
 *
 * Shares OAuth tokens with @cocal/google-calendar-mcp via
 * ~/.config/google-calendar-mcp/tokens.json
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { Logger } from './logger';
import { errorCollector } from './error-collector';
import type { SpawnOpts, SessionResult } from './assistant-scheduler';

// --- Types ---

export interface GCalEvent {
  id: string;
  calendarId: string;
  calendarName: string;
  title: string;
  location: string;
  startTime: string;      // ISO 8601 or "all-day:YYYY-MM-DD"
  endTime: string;
  isAllDay: boolean;
  status: string;
  updated: string;
}

export interface CalendarCache {
  fetchedAt: string;
  events: GCalEvent[];
}

interface CalendarDiff {
  added: GCalEvent[];
  removed: GCalEvent[];
  modified: Array<{ previous: GCalEvent; current: GCalEvent; changes: string[] }>;
}

export interface CalendarNotification {
  eventId: string;
  notifyAt: string;
  message: string;
  type: 'upcoming' | 'change' | 'cancel';
  delivered: boolean;
  createdAt: string;
}

interface GCalTokens {
  normal: {
    access_token: string;
    refresh_token: string;
    expiry_date: number;
  };
}

interface AssistantConfig {
  briefing: {
    calendars?: string[];  // Deprecated: ignored, all calendars are fetched
    excludeCalendars?: string[];
  };
  reminders: {
    beforeMinutes: number;
    pollingIntervalMinutes: number;
    enabled: boolean;
    workingHoursStart: string;
    workingHoursEnd: string;
    maxBudgetUsd?: number;
  };
}

// --- CalendarPoller ---

export class CalendarPoller {
  private logger = new Logger('CalendarPoller');

  // Timers
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private dispatchTimer: ReturnType<typeof setInterval> | null = null;

  // Token paths (shared with @cocal/google-calendar-mcp)
  private readonly tokensPath = path.join(
    os.homedir(), '.config', 'google-calendar-mcp', 'tokens.json',
  );
  private readonly credentialsPath = path.join(
    os.homedir(), '.claude', 'google-calendar-credentials.json',
  );

  // Data files (project root)
  private readonly cacheFile: string;
  private readonly notificationsFile: string;

  // Auth failure tracking
  private consecutiveAuthFailures = 0;
  private paused = false;

  // Diff dedup
  private lastDiffHash = '';
  private lastPollDate = '';

  constructor(
    private sendMessage: (text: string) => Promise<void>,
    private spawnSession: (prompt: string, opts: SpawnOpts) => Promise<SessionResult>,
    private promptsDir: string,
    private getConfig: () => AssistantConfig | null,
    private recordCost: (type: string, costUsd: number, sessionId: string) => void,
    private isWorkingHours: () => boolean,
  ) {
    const projectRoot = path.join(__dirname, '..');
    this.cacheFile = path.join(projectRoot, '.calendar-cache.json');
    this.notificationsFile = path.join(projectRoot, '.calendar-notifications.json');
  }

  // --- Public API ---

  start(): void {
    const config = this.getConfig();
    if (!config?.reminders.enabled) {
      this.logger.info('Calendar reminders disabled, skipping poller start');
      return;
    }

    const intervalMs = (config.reminders.pollingIntervalMinutes || 5) * 60 * 1000;

    // Initial poll after 30 seconds (let everything else initialize)
    setTimeout(() => {
      this.poll().catch(err => {
        this.logger.error('Initial poll failed', err);
      });
    }, 30_000);

    // Regular polling
    this.pollTimer = setInterval(() => {
      this.poll().catch(err => {
        this.logger.error('Poll failed', err);
      });
    }, intervalMs);

    // Dispatch timer: every 1 minute
    this.dispatchTimer = setInterval(() => {
      this.dispatchNotifications().catch(err => {
        this.logger.error('Dispatch failed', err);
      });
    }, 60_000);

    this.logger.info('CalendarPoller started', {
      intervalMinutes: config.reminders.pollingIntervalMinutes,
    });
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.dispatchTimer) {
      clearInterval(this.dispatchTimer);
      this.dispatchTimer = null;
    }
    this.logger.info('CalendarPoller stopped');
  }

  restart(): void {
    this.stop();
    this.start();
  }

  /** Get cached calendar data for briefing (includes all-day events). */
  getCache(): CalendarCache | null {
    try {
      if (fs.existsSync(this.cacheFile)) {
        return JSON.parse(fs.readFileSync(this.cacheFile, 'utf-8'));
      }
    } catch (error) {
      errorCollector.add('CalendarPoller', `캐시 로드 실패: ${(error as Error).message}`);
      this.logger.error('Failed to load cache', error);
    }
    return null;
  }

  // --- Token management ---

  private loadTokens(): GCalTokens | null {
    try {
      if (!fs.existsSync(this.tokensPath)) {
        return null;
      }
      return JSON.parse(fs.readFileSync(this.tokensPath, 'utf-8'));
    } catch (error) {
      errorCollector.add('CalendarPoller', `토큰 파일 로드 실패: ${(error as Error).message}`);
      return null;
    }
  }

  private loadCredentials(): { client_id: string; client_secret: string } | null {
    try {
      const data = JSON.parse(fs.readFileSync(this.credentialsPath, 'utf-8'));
      const installed = data.installed || data.web;
      if (!installed?.client_id || !installed?.client_secret) {
        errorCollector.add('CalendarPoller', '자격 증명 파일에 client_id/client_secret 없음');
        return null;
      }
      return { client_id: installed.client_id, client_secret: installed.client_secret };
    } catch (error) {
      errorCollector.add('CalendarPoller', `자격 증명 파일 로드 실패: ${(error as Error).message}`);
      return null;
    }
  }

  private async getAccessToken(): Promise<string | null> {
    const tokens = this.loadTokens();
    if (!tokens?.normal) {
      errorCollector.add('CalendarPoller', '토큰 파일 없음 또는 normal 키 없음');
      return null;
    }

    // Token still valid (with 5 min buffer)
    if (tokens.normal.expiry_date > Date.now() + 5 * 60 * 1000) {
      return tokens.normal.access_token;
    }

    // Need refresh
    const creds = this.loadCredentials();
    if (!creds) return null;

    try {
      const response = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: creds.client_id,
          client_secret: creds.client_secret,
          refresh_token: tokens.normal.refresh_token,
          grant_type: 'refresh_token',
        }),
      });

      if (!response.ok) {
        errorCollector.add('CalendarPoller', `토큰 갱신 실패 (HTTP ${response.status})`);
        this.logger.error('Token refresh failed', { status: response.status });
        return null;
      }

      const result = await response.json() as Record<string, unknown>;
      tokens.normal.access_token = result.access_token as string;
      tokens.normal.expiry_date = Date.now() + (result.expires_in as number) * 1000;
      if (result.refresh_token) {
        tokens.normal.refresh_token = result.refresh_token as string;
      }

      fs.writeFileSync(this.tokensPath, JSON.stringify(tokens, null, 2), 'utf-8');
      this.logger.info('Google Calendar token refreshed');
      return tokens.normal.access_token;
    } catch (error) {
      errorCollector.add('CalendarPoller', `토큰 갱신 에러: ${(error as Error).message}`);
      this.logger.error('Token refresh error', error);
      return null;
    }
  }

  // --- Event fetching ---

  private async fetchCalendarEvents(
    accessToken: string,
    calendarId: string,
    timeMin: string,
    timeMax: string,
  ): Promise<GCalEvent[]> {
    const encodedId = encodeURIComponent(calendarId);
    const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodedId}/events`);
    url.searchParams.set('timeMin', timeMin);
    url.searchParams.set('timeMax', timeMax);
    url.searchParams.set('singleEvents', 'true');
    url.searchParams.set('orderBy', 'startTime');
    url.searchParams.set('maxResults', '50');

    const response = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!response.ok) {
      throw new Error(`Calendar API error for ${calendarId}: HTTP ${response.status}`);
    }

    const data = await response.json() as Record<string, unknown>;
    const items = (data.items || []) as Array<Record<string, unknown>>;
    const calendarName = (data.summary || calendarId) as string;

    return items
      .filter(item => item.status !== 'cancelled')
      .map(item => {
        const start = item.start as Record<string, string> | undefined;
        const end = item.end as Record<string, string> | undefined;
        const isAllDay = !!start?.date && !start?.dateTime;

        return {
          id: item.id as string,
          calendarId,
          calendarName,
          title: (item.summary || '(제목 없음)') as string,
          location: (item.location || '') as string,
          startTime: isAllDay ? `all-day:${start!.date}` : (start?.dateTime || ''),
          endTime: isAllDay ? `all-day:${end?.date || start!.date}` : (end?.dateTime || ''),
          isAllDay,
          status: (item.status || 'confirmed') as string,
          updated: (item.updated || '') as string,
        };
      });
  }

  /**
   * Fetch all calendar IDs from the user's calendar list,
   * excluding calendars specified in config.briefing.excludeCalendars.
   */
  private async getAllCalendarIds(accessToken: string): Promise<{ id: string; name: string }[]> {
    const config = this.getConfig();
    const excludeNames = new Set(
      (config?.briefing.excludeCalendars || []).map((n: string) => n.toLowerCase()),
    );

    try {
      const response = await fetch('https://www.googleapis.com/calendar/v3/users/me/calendarList', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!response.ok) {
        errorCollector.add('CalendarPoller', `캘린더 목록 조회 실패 (HTTP ${response.status})`);
        return [];
      }

      const data = await response.json() as Record<string, unknown>;
      const items = (data.items || []) as Array<Record<string, unknown>>;

      const calendars: { id: string; name: string }[] = [];
      for (const item of items) {
        const id = item.id as string;
        if (!id) continue;
        const name = (item.summaryOverride || item.summary || id) as string;
        if (excludeNames.has(name.toLowerCase())) continue;
        calendars.push({ id, name });
      }

      this.logger.debug('Fetching calendars', {
        total: items.length,
        excluded: excludeNames.size,
        active: calendars.map(c => c.name),
      });

      return calendars;
    } catch (error) {
      errorCollector.add('CalendarPoller', '캘린더 목록 조회 실패');
      this.logger.warn('Calendar list fetch failed', error);
      return [];
    }
  }

  private async fetchAllEvents(accessToken: string): Promise<GCalEvent[]> {
    const calendars = await this.getAllCalendarIds(accessToken);
    if (calendars.length === 0) return [];

    // Today 00:00 ~ 23:59 in local timezone
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
    const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
    const timeMin = todayStart.toISOString();
    const timeMax = todayEnd.toISOString();

    const results = await Promise.allSettled(
      calendars.map(c => this.fetchCalendarEvents(accessToken, c.id, timeMin, timeMax)),
    );

    const allEvents: GCalEvent[] = [];
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === 'fulfilled') {
        allEvents.push(...result.value);
      } else {
        const cal = calendars[i];
        const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
        errorCollector.add('CalendarPoller', `캘린더 조회 실패 (${cal.name}): ${reason}`);
        this.logger.warn('Calendar fetch failed', { calendarId: cal.id, calendarName: cal.name, reason });
      }
    }

    // Sort by start time
    allEvents.sort((a, b) => {
      if (a.isAllDay && !b.isAllDay) return -1;
      if (!a.isAllDay && b.isAllDay) return 1;
      return a.startTime.localeCompare(b.startTime);
    });

    return allEvents;
  }

  // --- Cache management ---

  private loadCache(): CalendarCache | null {
    try {
      if (fs.existsSync(this.cacheFile)) {
        return JSON.parse(fs.readFileSync(this.cacheFile, 'utf-8'));
      }
    } catch {
      // Corrupt cache — treat as empty
    }
    return null;
  }

  private saveCache(events: GCalEvent[]): void {
    const cache: CalendarCache = {
      fetchedAt: new Date().toISOString(),
      events,
    };
    try {
      fs.writeFileSync(this.cacheFile, JSON.stringify(cache, null, 2), 'utf-8');
    } catch (error) {
      errorCollector.add('CalendarPoller', `캐시 저장 실패: ${(error as Error).message}`);
      this.logger.error('Failed to save cache', error);
    }
  }

  // --- Diff algorithm ---

  /**
   * Compare previous and current events for meaningful changes.
   * Only considers future, non-all-day events (reminders only care about upcoming).
   */
  private computeDiff(previous: GCalEvent[], current: GCalEvent[]): CalendarDiff {
    const now = new Date().toISOString();

    // Filter to future non-all-day events only
    const filterRelevant = (events: GCalEvent[]) =>
      events.filter(e => !e.isAllDay && e.endTime > now);

    const prev = filterRelevant(previous);
    const curr = filterRelevant(current);

    const prevMap = new Map(prev.map(e => [e.id, e]));
    const currMap = new Map(curr.map(e => [e.id, e]));

    const added: GCalEvent[] = [];
    const removed: GCalEvent[] = [];
    const modified: CalendarDiff['modified'] = [];

    // Find added and modified
    for (const [id, event] of currMap) {
      const prevEvent = prevMap.get(id);
      if (!prevEvent) {
        added.push(event);
      } else {
        const changes: string[] = [];
        if (prevEvent.startTime !== event.startTime || prevEvent.endTime !== event.endTime) {
          changes.push('time');
        }
        if (prevEvent.location !== event.location) {
          changes.push('location');
        }
        // Title changes are tracked but won't trigger notification by themselves
        if (prevEvent.title !== event.title) {
          changes.push('title');
        }
        // Only add to modified if there are meaningful changes (not title-only)
        const meaningfulChanges = changes.filter(c => c !== 'title');
        if (meaningfulChanges.length > 0) {
          modified.push({ previous: prevEvent, current: event, changes });
        }
      }
    }

    // Find removed
    for (const [id, event] of prevMap) {
      if (!currMap.has(id)) {
        removed.push(event);
      }
    }

    return { added, removed, modified };
  }

  private isDiffEmpty(diff: CalendarDiff): boolean {
    return diff.added.length === 0 && diff.removed.length === 0 && diff.modified.length === 0;
  }

  private hashDiff(diff: CalendarDiff): string {
    const content = JSON.stringify({
      added: diff.added.map(e => e.id),
      removed: diff.removed.map(e => e.id),
      modified: diff.modified.map(m => `${m.current.id}:${m.changes.join(',')}`),
    });
    return crypto.createHash('md5').update(content).digest('hex');
  }

  // --- AI judgment ---

  private async getAIJudgment(diff: CalendarDiff): Promise<CalendarNotification[]> {
    const config = this.getConfig();
    if (!config) return [];

    const promptPath = path.join(this.promptsDir, 'calendar-judgment.md');
    if (!fs.existsSync(promptPath)) {
      errorCollector.add('CalendarPoller', 'calendar-judgment.md 프롬프트 파일 없음');
      return [];
    }

    let prompt = fs.readFileSync(promptPath, 'utf-8');

    // Inject context
    const now = new Date();
    prompt = prompt.replace(/\{currentTime\}/g, now.toISOString());
    prompt = prompt.replace(/\{beforeMinutes\}/g, String(config.reminders.beforeMinutes));

    const formatEvents = (events: GCalEvent[]) =>
      events.length === 0
        ? '(없음)'
        : events.map(e => `- [${e.id}] \`${e.startTime}\` ${e.title} — ${e.location || '(장소 없음)'} _${e.calendarName}_`).join('\n');

    prompt = prompt.replace(/\{addedEvents\}/g, formatEvents(diff.added));
    prompt = prompt.replace(/\{removedEvents\}/g, formatEvents(diff.removed));

    const modifiedText = diff.modified.length === 0
      ? '(없음)'
      : diff.modified.map(m => {
          const changes = m.changes.map(c => {
            if (c === 'time') return `시간: ${m.previous.startTime} → ${m.current.startTime}`;
            if (c === 'location') return `장소: ${m.previous.location || '없음'} → ${m.current.location || '없음'}`;
            return c;
          }).join(', ');
          return `- [${m.current.id}] ${m.current.title} — 변경: ${changes}`;
        }).join('\n');
    prompt = prompt.replace(/\{modifiedEvents\}/g, modifiedText);

    // Inject existing notifications for dedup
    const existing = this.loadNotifications().filter(n => !n.delivered);
    const existingText = existing.length === 0
      ? '(없음)'
      : existing.map(n => `- [${n.eventId}] type=${n.type} notifyAt=${n.notifyAt} "${n.message}"`).join('\n');
    prompt = prompt.replace(/\{existingNotifications\}/g, existingText);

    try {
      const workingDir = path.join(__dirname, '..');
      const result = await this.spawnSession(prompt, {
        workingDirectory: workingDir,
        model: 'claude-haiku-4-5-20251001',
        permissionMode: 'default',
        maxBudgetUsd: config.reminders.maxBudgetUsd || 0.02,
        allowedTools: [],
        skipMcp: true,
        env: { CLAUDE_SCHEDULED: '1' },
      });

      this.recordCost('reminder-judgment', result.costUsd, result.sessionId);

      // Parse JSON from response
      return this.parseJudgmentResponse(result.text);
    } catch (error) {
      errorCollector.add('CalendarPoller', `AI 판단 실패: ${(error as Error).message}`);
      this.logger.error('AI judgment failed', error);
      return [];
    }
  }

  private parseJudgmentResponse(text: string): CalendarNotification[] {
    try {
      // Extract JSON array from response (may have surrounding text)
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        // Empty array is valid (no notifications needed)
        if (text.trim() === '[]' || text.includes('[]')) return [];
        this.logger.warn('No JSON array found in AI judgment response', { text: text.substring(0, 200) });
        return [];
      }

      const parsed = JSON.parse(jsonMatch[0]) as Array<Record<string, unknown>>;
      if (!Array.isArray(parsed)) return [];

      const now = new Date().toISOString();
      return parsed
        .filter(item =>
          typeof item.eventId === 'string' &&
          typeof item.notifyAt === 'string' &&
          typeof item.message === 'string' &&
          typeof item.type === 'string' &&
          ['upcoming', 'change', 'cancel'].includes(item.type as string),
        )
        .map(item => ({
          eventId: item.eventId as string,
          notifyAt: item.notifyAt as string,
          message: item.message as string,
          type: item.type as 'upcoming' | 'change' | 'cancel',
          delivered: false,
          createdAt: now,
        }));
    } catch (error) {
      errorCollector.add('CalendarPoller', `AI 판단 응답 파싱 실패: ${(error as Error).message}`);
      this.logger.error('Failed to parse AI judgment response', error);
      return [];
    }
  }

  // --- Notification queue ---

  private loadNotifications(): CalendarNotification[] {
    try {
      if (fs.existsSync(this.notificationsFile)) {
        return JSON.parse(fs.readFileSync(this.notificationsFile, 'utf-8'));
      }
    } catch {
      // Corrupt file — start fresh
    }
    return [];
  }

  private saveNotifications(notifications: CalendarNotification[]): void {
    // Clean up: remove delivered notifications older than 24 hours
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const cleaned = notifications.filter(n =>
      !n.delivered || new Date(n.createdAt).getTime() > cutoff,
    );

    try {
      fs.writeFileSync(this.notificationsFile, JSON.stringify(cleaned, null, 2), 'utf-8');
    } catch (error) {
      errorCollector.add('CalendarPoller', `알림 큐 저장 실패: ${(error as Error).message}`);
      this.logger.error('Failed to save notifications', error);
    }
  }

  private addNotifications(newNotifications: CalendarNotification[]): void {
    const existing = this.loadNotifications();

    // Dedup: skip if same eventId + type is already pending
    const pendingKeys = new Set(
      existing
        .filter(n => !n.delivered)
        .map(n => `${n.eventId}:${n.type}`),
    );

    const unique = newNotifications.filter(n => !pendingKeys.has(`${n.eventId}:${n.type}`));
    if (unique.length === 0) return;

    existing.push(...unique);
    this.saveNotifications(existing);
    this.logger.info('Added notifications to queue', { count: unique.length });
  }

  private async dispatchNotifications(): Promise<void> {
    const notifications = this.loadNotifications();
    const now = new Date().toISOString();
    let dispatched = 0;

    for (const notification of notifications) {
      if (notification.delivered) continue;
      if (notification.notifyAt > now) continue;

      try {
        await this.sendMessage(notification.message);
        notification.delivered = true;
        dispatched++;
      } catch (error) {
        this.logger.error('Failed to dispatch notification', {
          eventId: notification.eventId,
          error,
        });
      }
    }

    if (dispatched > 0) {
      this.saveNotifications(notifications);
      this.logger.info('Dispatched notifications', { count: dispatched });
    }
  }

  // --- Poll loop ---

  private async poll(): Promise<void> {
    if (!this.isWorkingHours()) return;
    if (this.paused) return;

    // Date change detection — reset diff hash
    const today = new Date().toISOString().substring(0, 10);
    if (today !== this.lastPollDate) {
      this.lastDiffHash = '';
      this.lastPollDate = today;
    }

    // 1. Get access token
    const accessToken = await this.getAccessToken();
    if (!accessToken) {
      this.consecutiveAuthFailures++;
      if (this.consecutiveAuthFailures >= 3 && !this.paused) {
        this.paused = true;
        errorCollector.add('CalendarPoller', '인증 연속 3회 실패 — 폴링 일시 중지');
        await this.sendMessage('⚠️ 캘린더 인증 갱신 필요 — 리마인더 일시 중지됨').catch(() => {});
      }
      return;
    }
    this.consecutiveAuthFailures = 0;
    if (this.paused) {
      this.paused = false;
      this.logger.info('CalendarPoller resumed after auth recovery');
    }

    // 2. Fetch all events for today
    let currentEvents: GCalEvent[];
    try {
      currentEvents = await this.fetchAllEvents(accessToken);
    } catch (error) {
      errorCollector.add('CalendarPoller', `이벤트 조회 실패: ${(error as Error).message}`);
      this.logger.error('Failed to fetch events', error);
      return;
    }

    // 3. Load previous cache
    const previousCache = this.loadCache();
    const previousEvents = previousCache?.events || [];

    // 4. Always save current cache (for briefing and next diff)
    this.saveCache(currentEvents);

    // 5. Compute diff (future non-all-day events only)
    const diff = this.computeDiff(previousEvents, currentEvents);

    // 6. No diff → done
    if (this.isDiffEmpty(diff)) return;

    // 7. Check diff hash for dedup
    const diffHash = this.hashDiff(diff);
    if (diffHash === this.lastDiffHash) return;
    this.lastDiffHash = diffHash;

    this.logger.info('Calendar diff detected', {
      added: diff.added.length,
      removed: diff.removed.length,
      modified: diff.modified.length,
    });

    // 8. AI judgment → notification queue
    const notifications = await this.getAIJudgment(diff);
    if (notifications.length > 0) {
      this.addNotifications(notifications);
    }
  }
}
