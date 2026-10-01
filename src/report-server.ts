import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { Logger } from './logger';

/**
 * Local-only HTTP server — 업무 칸반(`/board`)과 수동 분석 실행(`POST /trigger`).
 * Bound to 127.0.0.1 with a per-process token for basic auth.
 *
 * 보고서 목록 · 본문 페이지는 뺐다(report-log 4단계 · 읽는 쪽 전환). 보고서는 report-log 저장소에
 * 회차별로 쌓이고 desk 사이트가 그린다. 옛 주소는 칸반으로 돌리거나 옮겼다고 알린다.
 */
export class ReportServer {
  private server: http.Server | null = null;
  private logger = new Logger('ReportServer');
  private readonly token: string;
  private actualPort: number = 0;
  private triggerCallback?: (type: string) => Promise<unknown>;

  constructor() {
    this.token = crypto.randomBytes(16).toString('hex');
  }

  /** Wire a fire-and-forget analysis trigger. Bound to POST /trigger?type=... on the loopback port
   *  (`type=@group` runs the default schedule group — the callback decides). */
  setTriggerCallback(cb: (type: string) => Promise<unknown>): void {
    this.triggerCallback = cb;
  }

  /** Port the loopback HTTP server bound to (0 until start resolves). */
  get port(): number {
    return this.actualPort;
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
          this.writeBoardUrl(port);
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

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    try {
      const url = new URL(req.url || '/', `http://127.0.0.1:${this.actualPort}`);

      // Loopback-only trigger endpoint; no token required because the server is
      // bound to 127.0.0.1 in start(). Used for Phase 1.7/1.8 manual analysis runs.
      if (url.pathname === '/trigger' && req.method === 'POST') {
        const type = url.searchParams.get('type') || '';
        if (!this.triggerCallback) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'trigger not wired' }));
          return;
        }
        if (!type) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'missing type' }));
          return;
        }
        this.logger.info('Trigger received', { type });
        this.triggerCallback(type).catch(err => this.logger.error('Trigger callback failed', err));
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, type, accepted: true }));
        return;
      }

      if (url.searchParams.get('t') !== this.token) {
        res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Unauthorized');
        return;
      }

      // 옛 보고서 목록 주소 — 즐겨찾기가 남아 있을 수 있어 칸반으로 돌린다.
      if (url.pathname === '/' || url.pathname === '/index.html') {
        res.writeHead(302, { Location: `/board?t=${this.token}` });
        res.end();
        return;
      }
      // 업무 칸반. bin/tasks.py 가 업무를 고칠 때마다 이 파일을 다시 쓰므로
      // 여기서는 그대로 흘려보내기만 하면 **항상 최신**이다. 아티팩트로 올리는
      // 것은 세션 턴에서만 되지만, 이 경로는 그 제약을 받지 않는다.
      if (url.pathname === '/board') {
        this.serveBoard(res);
        return;
      }
      if (url.pathname.startsWith('/report/')) {
        res.writeHead(410, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('보고서는 report-log 로 옮겼습니다 — 슬랙에서 -report 로 desk 링크를 받으세요.');
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

  /**
   * 칸반 주소를 파일로 남긴다.
   *
   * 토큰이 부팅마다 새로 생기고 로그에도 안 찍혀서, 남기지 않으면 사람이 주소를
   * 알 방법이 없다. 서버는 127.0.0.1 에만 묶여 있으므로 이 파일이 새는 것은
   * 그 PC 를 이미 쓸 수 있는 사람에게만 의미가 있다.
   */
  private writeBoardUrl(port: number): void {
    try {
      const dir = path.join(
        process.env.USERPROFILE || process.env.HOME || '', '.claude', 'state');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'work-board-url.txt'),
        `http://127.0.0.1:${port}/board?t=${this.token}
`, 'utf-8');
    } catch {
      // 주소를 못 남겨도 서버는 떠야 한다.
    }
  }

  private serveBoard(res: http.ServerResponse): void {
    const file = path.join(
      process.env.USERPROFILE || process.env.HOME || '',
      '.claude', 'state', 'work-board.html');
    if (!fs.existsSync(file)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('아직 생성되지 않았습니다 — tasks.py board 를 한 번 실행하세요.');
      return;
    }
    const body = fs.readFileSync(file, 'utf-8');
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      // 파일이 수시로 바뀐다 — 새로고침이 옛 사본을 보면 이 경로의 존재 이유가 없다.
      'Cache-Control': 'no-store',
    });
    res.end('<!doctype html><html lang="ko"><head><meta charset="utf-8">'
      + '<meta name="viewport" content="width=device-width,initial-scale=1">'
      + '<title>업무 칸반</title></head><body>' + body + '</body></html>');
  }
}
