/**
 * DM 사다리 — 이 차례를 **누구에게 맡기나**를 정하는 순수 함수 하나(2026-10-14 · 엔진 폴백 5단계).
 *
 * 사용자 결정(2026-10-14): 「중단보다 품질이 조금 떨어져도 이어가는 것이 낫다」. 그래서 Claude 가
 * 막히면 다음 엔진이 이어 받는다 — 이번 단계는 GPT(codex) 한 칸이고, agy Claude · agy Gemini 는
 * 6단계가 `DM_LADDER` 의 codex 뒤에 넣는다. 다 막히면 모아 두고(`hold`) 회복 때 다시 돌린다.
 *
 * **여기서는 파일도 슬랙도 안 본다** — 부르는 쪽이 엔진 상태를 읽어(codex 는 한도 조회까지 옮긴 뒤)
 * 막힘 표를 넘긴다. 그래서 검사가 모든 조합을 그대로 돌린다(`scripts/check-dm-fallback.mjs`).
 *
 * 넘기지 않는 차례(늘 Claude · 막혔으면 모아 둠):
 *   - 채널(여럿이 보는 방) · 계획 모드 · 세션을 직접 고른 이어 가기(`-r <id>` · `-continue`)
 *   - 개인 글 조각이 든 말(`privacy-guard.ts` `containsPrivate`) — 밖(OpenAI)으로 안 보낸다
 *   - 작업 디렉터리가 업무 비서 뿌리가 아님 — 대체 엔진의 규칙·쓰기 범위가 그 뿌리에 맞춰져 있다
 *
 * **쓰기가 돌았어도 넘긴다**(사용자 결정) — 막혀 끊긴 차례를 다음 엔진이 곧바로 이어 받고, 쓰기가
 * 돌았다는 것은 프롬프트만 바꾼다(「이미 한 것 — 다시 하지 말 것」). Claude 의 보통 오류(한도 ·
 * 과부하가 아님)는 넘기지 않는다 — 예전 오류 길 그대로.
 */
import type { Engine } from './engine-state';

/** 차례가 어디서 왔나 — 사람 DM · 판·메일이 민 것 · 모아 둔 것을 다시 돌림 · 채널. */
export type DmOrigin = 'dm' | 'pushed' | 'replay' | 'channel';
/** Claude 가 이 차례에서 어떻게 끝났나 — 아직 안 띄웠으면 `notRun`(또는 생략). */
export type ClaudeOutcome = 'ok' | 'limited' | 'overload' | 'error' | 'notRun';
export type LadderPick = Engine | 'hold';

/** DM 을 맡는 차례 — 앞에서부터. **6단계가 agy 두 칸을 codex 뒤에 넣는다.** */
export const DM_LADDER: readonly Engine[] = ['claude', 'codex'];

export interface PickInput {
  origin: DmOrigin;
  planMode: boolean;
  /** 사람이 세션을 골라 잇는 명령(`-r <id>` · `-continue`) — 모아 둔 것을 잇는 것은 아님. */
  resumeCmd: boolean;
  /** 첨부 — codex 는 로컬 경로로 받는다(막지 않음). agy 칸이 붙으면 거기서 가른다. */
  hasFiles: boolean;
  isPrivate: boolean;
  cwdIsWorkAssistant: boolean;
  /** 엔진별 지금 막혔나(엔진 상태 · codex 는 한도 조회를 옮긴 뒤). 없는 칸은 안 막힘. */
  blocked: Partial<Record<Engine, boolean>>;
  claudeOutcome?: ClaudeOutcome;
  /** Claude 가 쓰기 도구를 돌렸나 — 고르는 데는 안 쓴다(넘길 때 프롬프트만 바뀐다). */
  writeRan?: boolean;
}

/** 이 차례를 다른 엔진에 넘겨도 되나 — 안 되면 늘 Claude(막혔으면 모아 둠). */
export function fallbackEligible(i: Pick<PickInput, 'origin' | 'planMode' | 'resumeCmd' | 'isPrivate' | 'cwdIsWorkAssistant'>): boolean {
  return i.origin !== 'channel' && !i.planMode && !i.resumeCmd && !i.isPrivate && i.cwdIsWorkAssistant;
}

/** Claude 다음 칸에서 막히지 않은 첫 엔진 — 다 막혔으면 `hold`. */
function nextRung(blocked: PickInput['blocked'], ladder: readonly Engine[]): LadderPick {
  for (const e of ladder.slice(1)) if (!blocked[e]) return e;
  return 'hold';
}

/**
 * 고른다. 두 번 부른다 — Claude 를 띄우기 전(`claudeOutcome` 없음 · `notRun`)과 Claude 가 끝난 뒤.
 *
 * - 띄우기 전: `claude` = Claude 를 띄움 · 그 밖 = Claude 를 건너뛰고 그 엔진으로(또는 모아 둠)
 * - 끝난 뒤: `claude` = 더 할 것 없음(됐거나 예전 오류 길 · 넘기지 않는 차례가 막혔으면 예전 한도 길) ·
 *   그 밖 = 그 엔진으로 넘김(또는 모아 둠)
 */
export function pickEngine(i: PickInput, ladder: readonly Engine[] = DM_LADDER): LadderPick {
  if (!fallbackEligible(i)) return 'claude';
  const o = i.claudeOutcome ?? 'notRun';
  if (o === 'notRun') return i.blocked.claude ? nextRung(i.blocked, ladder) : 'claude';
  if (o === 'limited' || o === 'overload') return nextRung(i.blocked, ladder);
  return 'claude';
}
