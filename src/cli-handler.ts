import { ChildProcess, spawn } from 'child_process';
import { ConversationSession } from './types';
import { Logger } from './logger';
import { McpManager } from './mcp-manager';
import * as fs from 'fs';
import * as path from 'path';

// --- stream-json event types ---

export interface CliInitEvent {
  type: 'system';
  subtype: 'init';
  session_id: string;
  model: string;
  tools: string[];
  permissionMode: string;
  uuid: string;
}

export interface CliStreamEvent {
  type: 'stream_event';
  event: {
    type: 'content_block_start' | 'content_block_delta' | 'content_block_stop'
        | 'message_start' | 'message_delta' | 'message_stop';
    content_block?: { type: string; name?: string; input?: any; id?: string };
    delta?: { type: string; text?: string; partial_json?: string };
    index?: number;
  };
  session_id: string;
  uuid: string;
  parent_tool_use_id: string | null;
}

export interface CliAssistantEvent {
  type: 'assistant';
  message: {
    role: 'assistant';
    content: Array<{ type: string; text?: string; name?: string; input?: any; id?: string }>;
  };
  session_id: string;
  uuid: string;
}

export interface CliUserEvent {
  type: 'user';
  message: { role: 'user'; content: any[] };
  session_id: string;
  uuid: string;
  tool_use_result?: { stdout: string; stderr: string; interrupted: boolean };
}

export interface CliRateLimitEvent {
  type: 'rate_limit_event';
  rate_limit_info: {
    status: string;
    resetsAt: number;
    rateLimitType: string;
    overageStatus: string;
  };
  session_id: string;
}

export interface CliResultEvent {
  type: 'result';
  subtype: string; // 'success' | 'error_max_budget_usd' | etc
  session_id: string;
  total_cost_usd: number;
  duration_ms: number;
  permission_denials: Array<{ tool_name: string; tool_use_id: string; tool_input?: any }>;
  is_error: boolean;
  result?: string;
  modelUsage?: Record<string, { inputTokens: number; outputTokens: number; costUSD: number }>;
}

export type CliEvent = CliInitEvent | CliStreamEvent | CliAssistantEvent | CliUserEvent
                     | CliRateLimitEvent | CliResultEvent | { type: string; [key: string]: any };

// --- CliProcess: wraps a child_process and provides AsyncIterable<CliEvent> ---

export class CliProcess {
  private proc: ChildProcess;
  private events: CliEvent[] = [];
  private done = false;
  private processError: Error | null = null;
  private pendingResolve: ((value: IteratorResult<CliEvent>) => void) | null = null;
  private logger = new Logger('CliProcess');
  private stderrChunks: string[] = [];

  constructor(proc: ChildProcess) {
    this.proc = proc;
    this.setupStdoutParser();
    this.setupStderrCapture();
    this.setupExitHandler();
  }

  private setupStdoutParser(): void {
    let buffer = '';
    this.proc.stdout!.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop()!; // preserve last incomplete line
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event: CliEvent = JSON.parse(line);
          this.pushEvent(event);
        } catch (e) {
          this.logger.debug('Failed to parse stream-json line', { line: line.substring(0, 200) });
        }
      }
    });
  }

  private setupStderrCapture(): void {
    this.proc.stderr!.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      this.stderrChunks.push(text);
      this.logger.debug('CLI stderr', { text: text.substring(0, 500) });
    });
  }

  private setupExitHandler(): void {
    this.proc.on('exit', (code, signal) => {
      this.logger.debug('CLI process exited', { code, signal });
      // Always enqueue error event for non-zero exits (even if iterator isn't waiting)
      if (code !== 0 && code !== null && !this.done) {
        const stderr = this.stderrChunks.join('');
        const errorEvent = { type: 'result', subtype: 'error', session_id: '', total_cost_usd: 0, duration_ms: 0, permission_denials: [], is_error: true, result: stderr || `CLI process exited with code ${code}` } as CliResultEvent;
        this.events.push(errorEvent);
      }
      this.done = true;
      if (this.pendingResolve) {
        const resolve = this.pendingResolve;
        this.pendingResolve = null;
        if (this.events.length > 0) {
          resolve({ value: this.events.shift()!, done: false });
        } else {
          resolve({ value: undefined as any, done: true });
        }
      }
    });

    this.proc.on('error', (err) => {
      this.logger.error('CLI process error', err);
      const errorEvent = { type: 'result', subtype: 'error', session_id: '', total_cost_usd: 0, duration_ms: 0, permission_denials: [], is_error: true, result: err.message } as CliResultEvent;
      this.events.push(errorEvent);
      this.done = true;
      if (this.pendingResolve) {
        const resolve = this.pendingResolve;
        this.pendingResolve = null;
        resolve({ value: this.events.shift()!, done: false });
      }
    });
  }

  private pushEvent(event: CliEvent): void {
    if (this.pendingResolve) {
      const resolve = this.pendingResolve;
      this.pendingResolve = null;
      resolve({ value: event, done: false });
    } else {
      this.events.push(event);
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterableIterator<CliEvent> {
    while (true) {
      // Drain buffered events first
      if (this.events.length > 0) {
        yield this.events.shift()!;
        continue;
      }

      // If done and no more events
      if (this.done) {
        return;
      }

      // Wait for next event
      const result = await new Promise<IteratorResult<CliEvent>>((resolve) => {
        this.pendingResolve = resolve;
      });

      if (result.done) {
        return;
      }

      yield result.value;
    }
  }

  /** Send SIGINT for graceful interrupt */
  interrupt(): void {
    if (!this.done) {
      // On Windows, SIGINT doesn't work well for child processes.
      // Use tree-kill pattern: write to stdin to signal, then kill.
      if (process.platform === 'win32') {
        this.proc.kill();
      } else {
        this.proc.kill('SIGINT');
      }
    }
  }

  /** Force kill */
  kill(): void {
    if (!this.done) {
      this.proc.kill('SIGKILL');
    }
  }

  /** Get the process PID */
  get pid(): number | undefined {
    return this.proc.pid;
  }
}

// --- Persisted session state ---

interface PersistedSession {
  sessionId: string;
  lastAssistantUuid?: string;
  savedAt: string;
}

// --- CliHandler: manages sessions and spawns CLI processes ---

export class CliHandler {
  private sessions: Map<string, ConversationSession> = new Map();
  private logger = new Logger('CliHandler');
  private mcpManager: McpManager;

  private readonly SESSION_STATE_FILE = path.join(__dirname, '..', '.session-state.json');
  private readonly SESSION_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(mcpManager: McpManager) {
    this.mcpManager = mcpManager;
    this.loadFromDisk();
  }

  // --- Session management (same as ClaudeHandler) ---

  getSessionKey(userId: string, channelId: string, threadTs?: string): string {
    return `${userId}-${channelId}-${threadTs || 'direct'}`;
  }

  getSession(userId: string, channelId: string, threadTs?: string): ConversationSession | undefined {
    return this.sessions.get(this.getSessionKey(userId, channelId, threadTs));
  }

  createSession(userId: string, channelId: string, threadTs?: string): ConversationSession {
    const key = this.getSessionKey(userId, channelId, threadTs);

    // Check if a persisted session exists for this key
    const existing = this.sessions.get(key);
    if (existing?.sessionId) {
      this.logger.info('Restoring persisted session', { sessionId: existing.sessionId, key });
      existing.isActive = true;
      existing.lastActivity = new Date();
      return existing;
    }

    const session: ConversationSession = {
      userId,
      channelId,
      threadTs,
      isActive: true,
      lastActivity: new Date(),
    };
    this.sessions.set(key, session);
    return session;
  }

  removeSession(userId: string, channelId: string, threadTs?: string): boolean {
    const key = this.getSessionKey(userId, channelId, threadTs);
    const deleted = this.sessions.delete(key);
    if (deleted) this.saveToDisk();
    return deleted;
  }

  scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveToDisk();
    }, 5000);
  }

  saveNow(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.saveToDisk();
  }

  cleanupInactiveSessions(maxAge: number = 0) {
    if (maxAge <= 0) return;
    const now = Date.now();
    let cleaned = 0;
    for (const [key, session] of this.sessions.entries()) {
      if (now - session.lastActivity.getTime() > maxAge) {
        this.sessions.delete(key);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      this.logger.info(`Cleaned up ${cleaned} inactive sessions`);
      this.saveToDisk();
    }
  }

  // --- Core: spawn CLI process ---

  runQuery(prompt: string, opts: {
    workingDirectory?: string;
    session?: ConversationSession;
    resumeSessionId?: string;
    continueLastSession?: boolean;
    model?: string;
    maxBudgetUsd?: number;
    permissionMode?: 'default' | 'safe' | 'trust' | 'plan';
    allowedTools?: string[];
    appendSystemPrompt?: string;
    env?: Record<string, string>;
  }): CliProcess {
    const args = ['-p', '--output-format', 'stream-json', '--verbose'];

    // Permission mode
    if (opts.permissionMode === 'trust') {
      args.push('--dangerously-skip-permissions');
    } else if (opts.permissionMode === 'plan') {
      args.push('--permission-mode', 'plan');
    } else {
      args.push('--permission-mode', 'default');
    }

    // Pre-approved tools (--allowedTools)
    if (opts.allowedTools && opts.allowedTools.length > 0 && opts.permissionMode !== 'trust') {
      args.push('--allowedTools', ...opts.allowedTools);
    }

    // Model
    if (opts.model) args.push('--model', opts.model);

    // Budget
    if (opts.maxBudgetUsd && opts.maxBudgetUsd > 0) {
      args.push('--max-budget-usd', opts.maxBudgetUsd.toString());
    }

    // Session resume
    if (opts.resumeSessionId) {
      args.push('--resume', opts.resumeSessionId);
    } else if (opts.continueLastSession) {
      args.push('--continue');
    } else if (opts.session?.sessionId) {
      args.push('--resume', opts.session.sessionId);
    }

    // MCP config
    const mcpConfigPath = this.mcpManager.getConfigPath();
    if (mcpConfigPath) {
      args.push('--mcp-config', mcpConfigPath);
    }

    // System prompt
    if (opts.appendSystemPrompt) {
      args.push('--append-system-prompt', opts.appendSystemPrompt);
    }

    // Prompt is passed via stdin (not positional arg)
    // because --allowedTools is variadic and consumes all remaining args

    // Environment
    const spawnEnv: Record<string, string> = {
      ...process.env as Record<string, string>,
      CLAUDECODE: '', // prevent nesting
    };
    if (opts.env) Object.assign(spawnEnv, opts.env);

    this.logger.info('Spawning CLI process', {
      prompt: prompt.substring(0, 200) + (prompt.length > 200 ? '...' : ''),
      permissionMode: opts.permissionMode,
      resumeSessionId: opts.resumeSessionId,
      continueLastSession: opts.continueLastSession,
      sessionId: opts.session?.sessionId,
      model: opts.model,
      allowedToolsCount: opts.allowedTools?.length,
      cwd: opts.workingDirectory,
    });

    const proc = spawn('claude', args, {
      cwd: opts.workingDirectory || process.cwd(),
      env: spawnEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32', // Use shell on Windows for PATH resolution
    });

    // Write prompt to stdin and close it
    proc.stdin!.write(prompt);
    proc.stdin!.end();

    return new CliProcess(proc);
  }

  // --- Persistence ---

  private loadFromDisk(): void {
    try {
      if (!fs.existsSync(this.SESSION_STATE_FILE)) return;
      const raw = fs.readFileSync(this.SESSION_STATE_FILE, 'utf-8');
      const data: Record<string, PersistedSession> = JSON.parse(raw);
      const now = Date.now();
      let loaded = 0;
      let skipped = 0;

      for (const [key, persisted] of Object.entries(data)) {
        const savedAt = new Date(persisted.savedAt).getTime();
        if (now - savedAt > this.SESSION_MAX_AGE) {
          skipped++;
          continue;
        }

        // Parse key: userId-channelId-threadTs
        const parts = key.split('-');
        if (parts.length < 2) continue;
        const userId = parts[0];
        const channelId = parts[1];
        const threadTs = parts.slice(2).join('-');

        this.sessions.set(key, {
          userId,
          channelId,
          threadTs: threadTs === 'direct' ? undefined : threadTs,
          sessionId: persisted.sessionId,
          lastAssistantUuid: persisted.lastAssistantUuid,
          isActive: false,
          lastActivity: new Date(persisted.savedAt),
        });
        loaded++;
      }

      if (loaded > 0 || skipped > 0) {
        this.logger.info(`Loaded session state from disk`, { loaded, skipped });
      }
    } catch (error) {
      this.logger.error('Failed to load session state from disk', error);
    }
  }

  private saveToDisk(): void {
    try {
      const data: Record<string, PersistedSession> = {};
      for (const [key, session] of this.sessions.entries()) {
        if (!session.sessionId) continue;
        data[key] = {
          sessionId: session.sessionId,
          lastAssistantUuid: session.lastAssistantUuid,
          savedAt: session.lastActivity.toISOString(),
        };
      }
      fs.writeFileSync(this.SESSION_STATE_FILE, JSON.stringify(data, null, 2), 'utf-8');
    } catch (error) {
      this.logger.error('Failed to save session state to disk', error);
    }
  }
}
