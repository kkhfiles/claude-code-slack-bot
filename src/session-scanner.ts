import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

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

      // Try sessions-index.json first
      const indexPath = path.join(dirPath, 'sessions-index.json');
      if (fs.existsSync(indexPath)) {
        try {
          const indexData = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
          const entries: IndexEntry[] = indexData.entries || [];

          for (const entry of entries) {
            if (entry.isSidechain) continue;
            const modified = entry.modified
              ? new Date(entry.modified)
              : entry.fileMtime
                ? new Date(entry.fileMtime)
                : new Date(0);

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
          continue; // Skip file scanning if index exists
        } catch { /* fall through to file scanning */ }
      }

      // Fallback: scan .jsonl files by mtime
      try {
        const jsonlFiles = fs.readdirSync(dirPath)
          .filter(f => f.endsWith('.jsonl'))
          .map(f => {
            const fullPath = path.join(dirPath, f);
            try {
              return { name: f, path: fullPath, mtime: fs.statSync(fullPath).mtime };
            } catch {
              return null;
            }
          })
          .filter((f): f is NonNullable<typeof f> => f !== null)
          .sort((a, b) => b.mtime.getTime() - a.mtime.getTime())
          .slice(0, 5); // Only top 5 per project without index

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

    // Sort by modified date (newest first) and take top N
    return allSessions
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
    if (projectPath.includes('\\') || projectPath.includes('/')) {
      return path.basename(projectPath);
    }
    // For encoded dir names like "P--github-claude-code-slack-bot",
    // extract the last meaningful segment
    const parts = projectPath.split('--');
    return parts[parts.length - 1] || projectPath;
  }
}

/**
 * Format a date as a relative time string in Korean.
 */
export function formatRelativeTime(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHour = Math.floor(diffMs / 3600000);
  const diffDay = Math.floor(diffMs / 86400000);

  if (diffMin < 1) return '방금 전';
  if (diffMin < 60) return `${diffMin}분 전`;
  if (diffHour < 24) return `${diffHour}시간 전`;
  if (diffDay < 7) return `${diffDay}일 전`;

  return date.toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' });
}
