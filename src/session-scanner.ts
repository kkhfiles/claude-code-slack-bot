import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Locale, t, formatShortDate } from './messages';
import { Logger } from './logger';

export interface SessionInfo {
  sessionId: string;
  projectPath: string;
  projectLabel: string;
  summary: string;
  firstPrompt: string;
  gitBranch: string;
  modified: Date;
}

interface IndexEntry {
  sessionId: string;
  summary?: string;
  firstPrompt?: string;
  gitBranch?: string;
  projectPath?: string;
  modified?: string;
  fileMtime?: number;
  isSidechain?: boolean;
}

export class SessionScanner {
  private readonly projectsBaseDir: string;
  private logger = new Logger('SessionScanner');

  constructor() {
    this.projectsBaseDir = path.join(os.homedir(), '.claude', 'projects');
  }

  /**
   * Scan all projects and return recent sessions sorted by modified date (newest first).
   */
  listRecentSessions(limit: number = 10, knownPaths?: Map<string, string>): SessionInfo[] {
    if (!fs.existsSync(this.projectsBaseDir)) return [];

    const allSessions: SessionInfo[] = [];

    const projectDirs = fs.readdirSync(this.projectsBaseDir, { withFileTypes: true })
      .filter(d => d.isDirectory());

    for (const dir of projectDirs) {
      const dirPath = path.join(this.projectsBaseDir, dir.name);
      const projectPath = this.decodeProjectPath(dir.name, knownPaths);
      const projectLabel = this.getProjectLabel(projectPath);

      // Collect indexed session IDs
      const indexedSessionIds = new Set<string>();

      // Try sessions-index.json first
      const indexPath = path.join(dirPath, 'sessions-index.json');
      if (fs.existsSync(indexPath)) {
        try {
          const indexData = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
          const entries: IndexEntry[] = indexData.entries || [];

          for (const entry of entries) {
            if (entry.isSidechain) continue;
            indexedSessionIds.add(entry.sessionId);

            // Use actual file mtime if available (more accurate than index timestamps)
            let modified: Date;
            const jsonlFullPath = path.join(dirPath, `${entry.sessionId}.jsonl`);
            try {
              modified = fs.statSync(jsonlFullPath).mtime;
            } catch {
              modified = entry.modified
                ? new Date(entry.modified)
                : entry.fileMtime
                  ? new Date(entry.fileMtime)
                  : new Date(0);
            }

            allSessions.push({
              sessionId: entry.sessionId,
              projectPath: entry.projectPath || projectPath,
              projectLabel: entry.projectPath ? this.getProjectLabel(entry.projectPath) : projectLabel,
              summary: entry.summary || '',
              firstPrompt: entry.firstPrompt || '',
              gitBranch: entry.gitBranch || '',
              modified,
            });
          }
        } catch { /* fall through to file scanning */ }
      }

      // Scan .jsonl files not in index (catches newly created sessions)
      try {
        const jsonlFiles = fs.readdirSync(dirPath)
          .filter(f => f.endsWith('.jsonl'))
          .map(f => {
            const sessionId = f.replace('.jsonl', '');
            if (indexedSessionIds.has(sessionId)) return null;
            const fullPath = path.join(dirPath, f);
            try {
              return { name: f, path: fullPath, mtime: fs.statSync(fullPath).mtime };
            } catch {
              return null;
            }
          })
          .filter((f): f is NonNullable<typeof f> => f !== null)
          .sort((a, b) => b.mtime.getTime() - a.mtime.getTime())
          .slice(0, 5);

        for (const file of jsonlFiles) {
          const sessionId = file.name.replace('.jsonl', '');
          const meta = this.extractSessionMetadata(file.path);

          allSessions.push({
            sessionId,
            projectPath: meta.projectPath || projectPath,
            projectLabel: meta.projectPath ? this.getProjectLabel(meta.projectPath) : projectLabel,
            summary: meta.summary,
            firstPrompt: meta.firstPrompt,
            gitBranch: meta.gitBranch,
            modified: file.mtime,
          });
        }
      } catch { /* skip unreadable directories */ }
    }

    // Filter out empty sessions (no conversation content) and sort by modified date
    return allSessions
      .filter(s => s.summary || s.firstPrompt)
      .sort((a, b) => b.modified.getTime() - a.modified.getTime())
      .slice(0, limit);
  }

  /**
   * Extract summary, first prompt, and git branch from a JSONL session file.
   */
  private extractSessionMetadata(filePath: string): { summary: string; firstPrompt: string; gitBranch: string; projectPath: string } {
    let summary = '';
    let firstPrompt = '';
    let gitBranch = '';
    let projectPath = '';

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n').slice(0, 50);

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);

          if (msg.type === 'summary' && msg.summary && !summary) {
            summary = msg.summary;
          }

          if (msg.type === 'user' && !msg.isMeta && !firstPrompt) {
            const msgContent = msg.message?.content;
            if (Array.isArray(msgContent)) {
              const textPart = msgContent.find((p: any) => p.type === 'text' && p.text);
              if (textPart) firstPrompt = textPart.text;
            } else if (typeof msgContent === 'string') {
              firstPrompt = msgContent;
            }
          }

          if (msg.type === 'user' && msg.gitBranch && !gitBranch) {
            gitBranch = msg.gitBranch;
          }

          if (msg.type === 'user' && msg.cwd && !projectPath) {
            projectPath = msg.cwd;
          }

          if (summary && firstPrompt && gitBranch && projectPath) break;
        } catch { /* skip malformed lines */ }
      }
    } catch { /* skip unreadable files */ }

    return { summary, firstPrompt: firstPrompt.substring(0, 100) + (firstPrompt.length > 100 ? '...' : ''), gitBranch, projectPath };
  }

  /**
   * Decode an encoded project directory name back to a real path.
   */
  private decodeProjectPath(encodedDir: string, knownPaths?: Map<string, string>): string {
    // Use known paths mapping if available
    if (knownPaths?.has(encodedDir)) {
      return knownPaths.get(encodedDir)!;
    }

    // Fallback: return the encoded name as-is (best-effort display)
    return encodedDir;
  }

  /**
   * Get a short display label from a project path.
   */
  private getProjectLabel(projectPath: string): string {
    // If it's a decoded real path, use basename
    if (path.isAbsolute(projectPath)) {
      return path.basename(projectPath);
    }
    // For encoded dir names like "P--github-claude-code-slack-bot",
    // extract the last meaningful segment
    const parts = projectPath.split('--');
    return parts[parts.length - 1] || projectPath;
  }

  /**
   * Encode a project path to the directory name format used by Claude CLI.
   * Non-alphanumeric characters are replaced with '-'.
   */
  private encodeProjectPath(projectPath: string): string {
    return projectPath.replace(/[^a-zA-Z0-9]/g, '-');
  }

  /**
   * Register a session in sessions-index.json so that `claude -c` can find it.
   */
  registerSession(opts: {
    sessionId: string;
    projectPath: string;
    firstPrompt: string;
    messageCount?: number;
  }): void {
    try {
      const encodedDir = this.encodeProjectPath(opts.projectPath);
      const dirPath = path.join(this.projectsBaseDir, encodedDir);
      const indexPath = path.join(dirPath, 'sessions-index.json');
      const jsonlPath = path.join(dirPath, `${opts.sessionId}.jsonl`);

      // Verify the session file exists
      if (!fs.existsSync(jsonlPath)) {
        this.logger.warn('Session file not found, skipping index registration', { sessionId: opts.sessionId, jsonlPath });
        return;
      }

      const fileStat = fs.statSync(jsonlPath);
      const meta = this.extractSessionMetadata(jsonlPath);
      const now = new Date().toISOString();

      const newEntry = {
        sessionId: opts.sessionId,
        fullPath: jsonlPath,
        fileMtime: fileStat.mtime.getTime(),
        firstPrompt: meta.firstPrompt || opts.firstPrompt.substring(0, 100) || 'No prompt',
        summary: meta.summary || '',
        messageCount: opts.messageCount || 0,
        created: now,
        modified: now,
        gitBranch: meta.gitBranch || '',
        projectPath: opts.projectPath,
        isSidechain: false,
      };

      // Read existing index or create new one
      let indexData: { version: number; entries: any[] } = { version: 1, entries: [] };
      if (fs.existsSync(indexPath)) {
        try {
          indexData = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
        } catch { /* start fresh if corrupt */ }
      }

      // Update existing entry or append
      const existingIdx = indexData.entries.findIndex((e: any) => e.sessionId === opts.sessionId);
      if (existingIdx >= 0) {
        indexData.entries[existingIdx] = { ...indexData.entries[existingIdx], ...newEntry, created: indexData.entries[existingIdx].created };
      } else {
        indexData.entries.push(newEntry);
      }

      fs.writeFileSync(indexPath, JSON.stringify(indexData, null, 2), 'utf-8');
      this.logger.info('Registered session in index', { sessionId: opts.sessionId, indexPath });
    } catch (error) {
      this.logger.error('Failed to register session in index', error);
    }
  }
}

/**
 * Format a date as a relative time string.
 */
export function formatRelativeTime(date: Date, locale: Locale = 'en'): string {
  const diffMs = Date.now() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHour = Math.floor(diffMs / 3600000);
  const diffDay = Math.floor(diffMs / 86400000);

  if (diffMin < 1) return t('time.justNow', locale);
  if (diffMin < 60) return t('time.minutesAgo', locale, { n: diffMin });
  if (diffHour < 24) return t('time.hoursAgo', locale, { n: diffHour });
  if (diffDay < 7) return t('time.daysAgo', locale, { n: diffDay });

  return formatShortDate(date, locale);
}
