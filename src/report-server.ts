import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { marked } from 'marked';
import { Logger } from './logger';

interface ReportEntry {
  type: string;
  name: string;
  relPath: string;
  absPath: string;
  mtime: number;
}

/**
 * Local-only HTTP server that renders markdown reports as HTML.
 * Bound to 127.0.0.1 with a per-process token for basic auth.
 */
export class ReportServer {
  private server: http.Server | null = null;
  private logger = new Logger('ReportServer');
  private readonly token: string;
  private readonly reportsDir: string;
  private actualPort: number = 0;

  constructor(reportsDir: string) {
    this.reportsDir = path.resolve(reportsDir);
    this.token = crypto.randomBytes(16).toString('hex');
  }

  async start(preferredPort: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const tryPort = (port: number, attempt: number) => {
        const server = http.createServer((req, res) => this.handle(req, res));
        server.once('error', (err: NodeJS.ErrnoException) => {
          if (err.code === 'EADDRINUSE' && attempt < 5) {
            tryPort(port + 1, attempt + 1);
          } else {
            reject(err);
          }
        });
        server.listen(port, '127.0.0.1', () => {
          this.server = server;
          this.actualPort = port;
          this.logger.info(`Listening on http://127.0.0.1:${port}`);
          resolve();
        });
      };
      tryPort(preferredPort, 0);
    });
  }

  stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  /** Build a URL pointing to a specific report file (relPath = "<type>/<file>.md") */
  buildReportUrl(relPath: string): string {
    return `http://127.0.0.1:${this.actualPort}/report/${encodeURI(relPath)}?t=${this.token}`;
  }

  /** Build a URL pointing to the index page */
  buildIndexUrl(): string {
    return `http://127.0.0.1:${this.actualPort}/?t=${this.token}`;
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    try {
      const url = new URL(req.url || '/', `http://127.0.0.1:${this.actualPort}`);
      if (url.searchParams.get('t') !== this.token) {
        res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Unauthorized');
        return;
      }

      if (url.pathname === '/' || url.pathname === '/index.html') {
        this.serveIndex(res);
        return;
      }
      if (url.pathname.startsWith('/report/')) {
        this.serveReport(decodeURIComponent(url.pathname.slice('/report/'.length)), res);
        return;
      }
      if (url.pathname === '/favicon.ico') {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
    } catch (error) {
      this.logger.error('Request handler failed', error);
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Internal error');
    }
  }

  private listReports(): ReportEntry[] {
    if (!fs.existsSync(this.reportsDir)) return [];
    const entries: ReportEntry[] = [];
    for (const dir of fs.readdirSync(this.reportsDir)) {
      if (dir === 'archived') continue;
      const subdir = path.join(this.reportsDir, dir);
      if (!fs.statSync(subdir).isDirectory()) continue;
      for (const fname of fs.readdirSync(subdir)) {
        if (!fname.endsWith('.md') || fname === '.gitkeep') continue;
        const absPath = path.join(subdir, fname);
        try {
          const stat = fs.statSync(absPath);
          entries.push({
            type: dir,
            name: fname,
            relPath: `${dir}/${fname}`,
            absPath,
            mtime: stat.mtimeMs,
          });
        } catch {
          // skip unreadable files
        }
      }
    }
    return entries.sort((a, b) => b.mtime - a.mtime);
  }

  private serveIndex(res: http.ServerResponse): void {
    const reports = this.listReports();
    const grouped = new Map<string, ReportEntry[]>();
    for (const r of reports) {
      const arr = grouped.get(r.type) ?? [];
      arr.push(r);
      grouped.set(r.type, arr);
    }
    const sections = Array.from(grouped.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([type, files]) => {
        const items = files.map(f => {
          const url = `/report/${encodeURI(f.relPath)}?t=${this.token}`;
          const date = new Date(f.mtime).toISOString().slice(0, 16).replace('T', ' ');
          return `<li><a href="${url}">${escapeHtml(f.name)}</a> <span class="muted">${date}</span></li>`;
        }).join('\n');
        return `<section><h2>${escapeHtml(type)}</h2><ul>${items}</ul></section>`;
      })
      .join('\n');

    const html = wrapHtml('Reports', sections || '<p class="muted">No reports yet.</p>');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  }

  private serveReport(relPath: string, res: http.ServerResponse): void {
    const requested = path.resolve(this.reportsDir, relPath);
    if (!requested.startsWith(this.reportsDir + path.sep) || !requested.endsWith('.md')) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Forbidden');
      return;
    }
    if (!fs.existsSync(requested)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Report not found');
      return;
    }
    const md = fs.readFileSync(requested, 'utf-8');
    const body = marked.parse(md, { async: false }) as string;
    const html = wrapHtml(relPath, `<article class="markdown">${body}</article>`);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

function wrapHtml(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 920px; margin: 2rem auto; padding: 0 1.25rem; line-height: 1.6; }
  h1, h2, h3 { line-height: 1.25; }
  .muted { color: #888; font-size: 0.85em; }
  .markdown pre { background: rgba(127,127,127,0.12); padding: 0.75rem; border-radius: 6px; overflow-x: auto; }
  .markdown code { background: rgba(127,127,127,0.12); padding: 0.1em 0.3em; border-radius: 3px; }
  .markdown pre code { background: transparent; padding: 0; }
  .markdown blockquote { border-left: 3px solid #888; margin: 0; padding-left: 1rem; color: #aaa; }
  .markdown table { border-collapse: collapse; }
  .markdown th, .markdown td { border: 1px solid rgba(127,127,127,0.4); padding: 0.4rem 0.7rem; }
  ul { padding-left: 1.5rem; }
  a { color: #4a9eff; }
  section { margin-bottom: 2rem; }
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
${body}
</body>
</html>`;
}
