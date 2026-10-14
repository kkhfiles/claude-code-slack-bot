/**
 * 회복 타이머 — 막힌 엔진이 풀리는 시각에 깨어나 밀린 것을 다시 돌린다. **타이머는 하나다.**
 *
 * 전에는 대화 처리기(`slack-handler.ts`)가 한도 안내를 올릴 때 메모리에만 타이머를 걸었다. 그래서
 * **재시작하면 타이머가 사라지고 다시 거는 곳이 없었다** — 기동 드레인은 아직 안 풀렸다며 쉬고,
 * 회복 시각이 와도 아무도 안 깨웠다. 이제 시각의 정본은 엔진 상태 파일이고, 여기서는
 *   - 기동 때(`init`) 파일에서 다시 걸고
 *   - 막힘이 바뀔 때마다(`subscribe`) 다시 건다.
 *
 * **정각이 아니라 1분 뒤에 깨운다** — 회복 시각에 딱 맞춰 부르면 아직 안 풀린 채로 또 막혀 한 판을
 * 헛돈다. 회복 시각 전에 막힘이 풀리면(어느 차례가 성공함) 1분 뒤에 돌린다 — 기다리던 것이 있었는데
 * 타이머만 거두면 밀린 것이 다음 기동까지 남는다.
 *
 * 깨어나서 하는 일 — 한도 안내 키를 비우고(다음 막힘에 다시 안내) 부른 쪽이 준 일(드레인)을 한다.
 */
import { Logger } from './logger';
import { engineState, type EngineState } from './engine-state';

/** 회복 시각에서 이만큼 뒤에 깨운다. */
export const RECOVERY_SLACK_MS = 60_000;
/** `setTimeout` 이 받는 가장 긴 값(약 24.8일). 넘으면 그만큼만 자고 다시 건다. */
const MAX_TIMER_MS = 2 ** 31 - 1;

export interface EngineRecoveryOptions {
  /** 깨어나서 할 일 — 봇에서는 밀린 것 드레인. */
  onRecover: (why: string) => unknown;
  store?: EngineState;
  /** 시험이 바꿔 끼운다. 기본은 `unref` 한 `setTimeout` — 봇은 다른 연결이 살려 둔다. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
  now?: () => number;
  slackMs?: number;
}

export class EngineRecovery {
  private logger = new Logger('EngineRecovery');
  private store: EngineState;
  private handle: unknown = null;
  /** 깨어날 시각(ms) — 걸린 것이 없으면 `null`. 시험·로그가 본다. */
  armedFor: number | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(private opts: EngineRecoveryOptions) {
    this.store = opts.store ?? engineState;
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  private get slackMs(): number {
    return this.opts.slackMs ?? RECOVERY_SLACK_MS;
  }

  /** 기동 때 한 번 — 파일에서 다시 걸고 막힘이 바뀔 때마다 다시 걸게 한다. */
  init(): void {
    if (!this.unsubscribe) this.unsubscribe = this.store.subscribe(() => this.arm());
    this.arm();
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.cancel();
  }

  /** 지금 상태로 다시 건다. */
  arm(): void {
    try {
      const next = this.store.nextRecoveryAt(Math.floor(this.now() / 1000));
      const waiting = this.handle !== null;
      this.cancel();
      if (next !== null) {
        this.schedule(next * 1000 + this.slackMs, 'until');
      } else if (waiting) {
        // 기다리던 막힘이 회복 시각 전에 풀렸다 — 밀린 것을 곧 돌린다.
        this.schedule(this.now() + this.slackMs, 'cleared');
      }
    } catch (err: any) {
      this.logger.warn('회복 타이머를 못 걸었습니다', { err: String(err?.message ?? err) });
    }
  }

  private cancel(): void {
    if (this.handle !== null) {
      const clear = this.opts.clearTimer ?? ((h: unknown) => clearTimeout(h as NodeJS.Timeout));
      clear(this.handle);
    }
    this.handle = null;
    this.armedFor = null;
  }

  private schedule(at: number, why: string): void {
    const delay = Math.min(MAX_TIMER_MS, Math.max(0, at - this.now()));
    const set = this.opts.setTimer ?? ((fn: () => void, ms: number) => {
      const h = setTimeout(fn, ms);
      h.unref?.();
      return h;
    });
    this.armedFor = at;
    this.handle = set(() => this.fire(at), delay);
    this.logger.info('회복 타이머', { at: new Date(at).toISOString(), inMinutes: Math.round(delay / 60_000), why });
  }

  /** 깨어남 — 너무 긴 대기라 일찍 깼으면 다시 잔다. */
  private fire(at: number): void {
    this.handle = null;
    this.armedFor = null;
    if (this.now() < at - 1000) { this.arm(); return; }
    try {
      // **Claude 가 풀렸을 때만 한도 안내 열쇠를 지운다** — 다른 엔진(codex 등)이 깨어나도 Claude 가
      // 아직 막혀 있으면 같은 막힘 구간이라, 지우면 다음 DM 에 같은 안내가 또 나간다(4단계 검토).
      if (!this.store.isBlocked('claude')) this.store.clearNotice();
      Promise.resolve(this.opts.onRecover('한도 회복'))
        .catch((err) => this.logger.error('회복 뒤 일이 터졌습니다', err));
    } catch (err) {
      this.logger.error('회복 뒤 일이 터졌습니다', err);
    }
    this.arm();
  }
}
