/**
 * 판 큐 알림을 받는 상시 연결 (2026-10-01).
 *
 * **2초마다 묻던 것을 알림 한 마디가 대신한다.** 판에서 누르면 워커의 저장소가 이 연결로
 * `{"t":"new"}` 만 보내고(내용은 안 실음), 봇은 늘 하던 `pull` 로 가져간다. 누른 뒤 봇이 받기까지
 * 평균 1.45초(2초 주기의 기다림 1.0 + 묻는 왕복 0.45)가 실측 0.42초가 됐다. 저장소는 대기 모드라
 * 기다리는 동안 과금 시간이 안 쌓이고, 핑은 런타임이 저장소를 안 깨우고 답한다.
 *
 * **알림은 빠르게 하는 장치이지 유일한 길이 아니다** — 놓쳐도 잃는 것이 없게 짰다.
 *  - 붙자마자(다시 붙을 때도) 한 번 가져간다 — 끊긴 사이에 담긴 것
 *  - 안전망 확인은 남는다 — 연결이 정상이면 60초 · 아니면 예전 주기(`boardQueueGapMs`)
 *  - 정상의 기준은 「열림」이 아니라 **최근 핑에 답이 왔나**다 — 겉으로만 열린 연결을 믿지 않는다
 *
 * 점검 기록(실제 도메인 · 시험 경로): Access 뒤 서비스 토큰으로 열림 · 출처가 붙으면 403 ·
 * 90분 끊김 0 · 핑 135/135 · 배포 때 0.8초 뒤 close 1006 → 다시 붙음. 설계 검토는 GPT 6.1 sol
 * (세대 번호 · 무작위 편차 · 인증 오류를 가려 빠른 반복을 멈춤 · 안전망 60/2초).
 * 근거 = work-assistant `docs/design.md` 「확정 전 마지막 시험」.
 */
import { Logger } from './logger';

/** 기본 WebSocket(Node 22 · undici)과 시험용 가짜가 같이 맞추는 모양. */
export interface PushSocket {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((ev?: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev?: unknown) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
}
export type SocketFactory = (url: string, headers: Record<string, string>) => PushSocket;

/** 핑을 보내는 간격. 답이 이 + `PONG_GRACE` 안에 없으면 겉으로만 열린 것으로 본다. */
export const PUSH_PING_MS = 30_000;
export const PUSH_PONG_GRACE_MS = 10_000;
/** 다시 붙는 간격 — 잇달아 실패하면 늘린다. 실제로는 여기에 0~30% 무작위를 더한다. */
export const PUSH_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
/** 인증이 거절되면(Access 302·401·403) 이만큼 기다린다 — 빠르게 두드려 봐야 같은 답이다. */
export const PUSH_AUTH_BACKOFF_MS = 5 * 60_000;

export interface BoardPushDeps {
  /** 붙을 곳 — 없으면(주소·열쇠 없음) 붙지 않는다. */
  target: () => { url: string; headers: Record<string, string> } | null;
  /** 새것이 있다 — 큐를 비우라는 요청. 붙자마자 한 번 · 알림마다 한 번. */
  onNew: () => void;
  /** 연결이 안 될 때 인증 탓인가(`boardPushAuthBroken`). 없으면 늘 망 탓으로 본다. */
  authBroken?: () => Promise<boolean>;
  /** 시험이 바꿔 끼운다. 없으면 기본 WebSocket. */
  socket?: SocketFactory;
  pingMs?: number;
  pongGraceMs?: number;
  backoffMs?: number[];
  authBackoffMs?: number;
  /** 무작위 편차 — 시험은 0 을 준다. */
  jitter?: () => number;
}

const defaultSocket: SocketFactory = (url, headers) => {
  const WS = (globalThis as any).WebSocket;
  if (!WS) throw new Error('이 Node 에 기본 WebSocket 이 없습니다');
  return new WS(url, { headers }) as PushSocket;
};

export class BoardPush {
  private logger = new Logger('BoardPush');
  private ws: PushSocket | null = null;
  /** 연결마다 하나씩 올린다 — 옛 연결이 늦게 내는 신호(close 등)를 버리는 표. */
  private gen = 0;
  private attempt = 0;
  private lastPong = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private authWarned = false;
  /** 몇 번 붙었나 · 알림 몇 번 받았나 — 로그와 시험이 본다. */
  opens = 0;
  notices = 0;

  constructor(private deps: BoardPushDeps) {}

  private get pingMs() { return this.deps.pingMs ?? PUSH_PING_MS; }
  private get graceMs() { return this.deps.pongGraceMs ?? PUSH_PONG_GRACE_MS; }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
    this.pingTimer = setInterval(() => this.heartbeat(), this.pingMs);
    this.pingTimer.unref?.();
  }

  /** 멈춘다 — 타이머를 다 걷고 연결을 닫는다. 다시 `start` 하면 처음부터 붙는다. */
  stop(): void {
    this.stopped = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.pingTimer = null;
    this.reconnectTimer = null;
    const w = this.ws;
    this.ws = null;
    this.gen += 1;
    try { w?.close(); } catch { /* 이미 닫힘 */ }
  }

  /**
   * **정상인가** — 열려 있고 최근 핑에 답이 왔다. 안전망 확인 주기를 이것으로 정한다
   * (정상이면 60초 · 아니면 예전 주기). 「열림」만 보면 겉으로만 열린 연결을 믿게 된다.
   */
  healthy(now: number = Date.now()): boolean {
    return !this.stopped && !!this.ws && this.ws.readyState === 1
      && now - this.lastPong < this.pingMs + this.graceMs;
  }

  private connect(): void {
    if (this.stopped) return;
    const t = this.deps.target();
    if (!t) { this.schedule(this.deps.authBackoffMs ?? PUSH_AUTH_BACKOFF_MS); return; }
    const gen = ++this.gen;
    let ws: PushSocket;
    try {
      ws = (this.deps.socket ?? defaultSocket)(t.url, t.headers);
    } catch (err) {
      this.logger.warn('판 알림 연결을 못 만들었습니다', { reason: String((err as Error)?.message ?? err) });
      void this.fail(gen);
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (gen !== this.gen) return;
      this.attempt = 0;
      this.lastPong = Date.now();
      this.opens += 1;
      if (this.authWarned) this.logger.info('판 알림 — 인증이 다시 통과했습니다');
      this.authWarned = false;
      this.logger.info('판 알림 연결됨', { opens: this.opens });
      // **붙자마자 한 번 가져간다** — 끊긴 사이에 담긴 것을 안 놓친다.
      this.deps.onNew();
    };
    ws.onmessage = (ev) => {
      if (gen !== this.gen) return;
      const d = String(ev?.data ?? '');
      if (d === 'pong') { this.lastPong = Date.now(); return; }
      if (d.includes('"new"')) { this.notices += 1; this.deps.onNew(); }
    };
    ws.onclose = () => { if (gen === this.gen) void this.fail(gen); };
    ws.onerror = () => { /* close 가 뒤따른다 — 다시 붙는 것은 거기서 */ };
  }

  /** 끊겼다 — 원인을 가르고 다시 붙을 때를 잡는다. 같은 연결의 두 번째 신호는 버린다. */
  private async fail(gen: number): Promise<void> {
    if (gen !== this.gen || this.stopped) return;
    this.ws = null;
    this.gen += 1;
    let auth = false;
    try { auth = (await this.deps.authBroken?.()) ?? false; } catch { auth = false; }
    if (this.stopped) return;
    if (auth) {
      // **같은 경고를 되풀이하지 않는다** — 고칠 때까지 5분마다 조용히 다시 본다.
      if (!this.authWarned) {
        this.logger.warn('판 알림 — Access 가 거절했습니다(302·401·403) · 서비스 토큰을 확인하세요 · 5분마다 다시 시도');
        this.authWarned = true;
      }
      this.schedule(this.deps.authBackoffMs ?? PUSH_AUTH_BACKOFF_MS);
      return;
    }
    const steps = this.deps.backoffMs ?? PUSH_BACKOFF_MS;
    const base = steps[Math.min(this.attempt, steps.length - 1)];
    this.attempt += 1;
    const jitter = this.deps.jitter ? this.deps.jitter() : Math.random() * 0.3;
    this.schedule(Math.round(base * (1 + jitter)));
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.connect(); }, ms);
    this.reconnectTimer.unref?.();
  }

  /** 핑을 보내고, 답이 `PONG_GRACE` 안에 안 오면 끊고 다시 붙는다(겉으로만 열린 연결). */
  private heartbeat(): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1) return;
    const sentAt = Date.now();
    const gen = this.gen;
    try { ws.send('ping'); } catch { /* 닫히는 중 */ }
    const check = setTimeout(() => {
      if (gen !== this.gen || this.stopped) return;
      if (this.lastPong < sentAt) {
        this.logger.warn('판 알림 — 핑에 답이 없습니다 · 끊고 다시 붙습니다');
        try { ws.close(); } catch { /* 이미 */ }
        void this.fail(gen);
      }
    }, this.graceMs);
    check.unref?.();
  }
}
