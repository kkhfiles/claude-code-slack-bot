/**
 * 전송 탭 — Claude 의 SDK·CLI 이벤트가 봇의 이벤트 흐름으로 바뀌는 그 자리에서 엔진 상태를 적는다.
 *
 * **적는 곳은 여기 하나다.** 대화 차례 · 예약 세션 · 분석 · 좁은 길이 모두 `SdkProcess`·`CliProcess`
 * 를 지나므로 그 둘의 이벤트 내보내기에 붙이면 빠지는 길이 없다. 부르는 쪽마다 따로 적게 두면 한
 * 곳이 빠진다 — 예약 세션(`runAssistantSession`)은 막혀도 아무 데도 안 적었다.
 *
 * - `rate_limit_event` — `rejected` 면 사용량 소진(서버가 준 풀리는 시각) · 사용률이 실려 오면 적음
 * - `result` — 오류가 아니면 「됐다」(막힘을 지움) · 오류 글이 사용량 소진·과부하로 갈리면 「막혔다」
 *
 * **흐름 하나에 막힘은 한 번만 적는다** — 한 번 막힌 차례가 결과를 두 번 낸다(세션이 낸 오류 결과 +
 * SDK 가 던진 것을 `SdkProcess` 가 다시 결과로 감싼 것 · 실측 2026-08-31). 두 번 적으면 과부하
 * 한 번이 두 단계(20분)로 세어진다.
 *
 * **절대 안 던진다** — 이것은 기록이지 차례의 일부가 아니다. 터지면 WARN 한 줄만 남긴다.
 */
import { Logger } from './logger';
import { engineState, type Block, type Engine, type EngineState } from './engine-state';
import { classifyClaudeErrorText, classifyClaudeEvent } from './rate-limit-utils';

const logger = new Logger('EngineTap');

export class ClaudeTap {
  /** 이 흐름에서 이미 막힘을 적었나. */
  private blockedHere = false;

  /**
   * `engine` — 이 흐름이 어느 엔진의 것인가. 월 API 크레딧 세션(`claude-api`)은 같은 SDK 를 지나지만 구독 Claude 와
   * 막힘을 따로 센다 — 같은 열쇠에 적으면 API 세션이 된 것이 구독 Claude 의 막힘을 지운다.
   */
  constructor(private store: EngineState = engineState, private engine: Engine = 'claude') {}

  see(ev: any): void {
    try {
      if (ev?.type === 'rate_limit_event') {
        const v = classifyClaudeEvent(ev);
        if (v.util) this.store.recordUtil(this.engine, v.util);
        if (v.block && !this.blockedHere) {
          this.blockedHere = true;
          this.store.recordBlocked(this.engine, { ...v.block, why: `rate_limit_event ${JSON.stringify(ev.rate_limit_info ?? {})}` });
        }
        return;
      }
      if (ev?.type !== 'result') return;
      if (ev.is_error !== true) {
        // ⚠️ 막힌 흐름의 결과는 「됐다」가 아니다 — 거절 이벤트 뒤에도 `subtype: success` 가 온다.
        if (!this.blockedHere) this.store.recordOk(this.engine);
        return;
      }
      if (this.blockedHere) return;
      const c = classifyClaudeErrorText(String(ev.result ?? ''));
      if (c) {
        this.blockedHere = true;
        this.store.recordBlocked(this.engine, { ...c, why: `result ${String(ev.result ?? '')}` });
      }
    } catch (err: any) {
      logger.warn('엔진 상태를 못 적었습니다 — 차례는 그대로 갑니다', { err: String(err?.message ?? err) });
    }
  }
}

/**
 * 지금 Claude 의 막힘 — 한도 안내가 「언제 다시」를 정할 때 쓴다.
 *
 * 전송 탭이 이미 적었으면 그것을 돌려준다(다시 적으면 과부하가 두 단계로 세어진다). 탭이 못 본
 * 실패(이벤트 밖에서 던진 오류)면 여기서 가려 적는다 — 갈래를 못 정하면 `unknown`(한 시간 뒤).
 */
export function currentClaudeBlock(
  resetsAt?: number, text?: string, store: EngineState = engineState,
): Block {
  const b = store.blocked('claude');
  if (b && store.isBlocked('claude')) return b;
  const c = resetsAt ? { kind: 'usage' as const, until: resetsAt } : classifyClaudeErrorText(text ?? '', store.nowSec() * 1000);
  return store.recordBlocked('claude', { ...(c ?? { kind: 'unknown' as const }), why: `notice ${text ?? ''}` });
}

/**
 * 차례가 **던진** 오류에서 Claude 의 막힘을 가린다 — Claude 한도·과부하 글로 읽힐 때만 적고,
 * 아니면 `null`(보통 오류로 처리).
 *
 * 던진 오류는 Claude 스트림 밖에서도 온다. 슬랙 API 의 빈도 제한(`slack_webapi_rate_limited_error`)은
 * 글이 「A rate-limit has been reached」라 한도 낱말에 걸리는데, 그것을 Claude 막힘으로 적으면
 * 엔진 사다리가 한 시간 동안 Claude 를 건너뛴다(2026-10-14 검토에서 막음).
 */
export function thrownClaudeBlock(error: any, store: EngineState = engineState): Block | null {
  if (typeof error?.code === 'string' && error.code.startsWith('slack_')) return null;
  const b = store.blocked('claude');
  if (b && store.isBlocked('claude')) return b;
  const c = classifyClaudeErrorText(String(error?.message ?? error ?? ''), store.nowSec() * 1000);
  return c ? store.recordBlocked('claude', { ...c, why: `thrown ${String(error?.message ?? error ?? '')}` }) : null;
}
