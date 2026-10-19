/**
 * DM 사다리 — 이 차례를 **누구에게 맡기나**를 정하는 순수 함수 하나(2026-10-14 · 엔진 폴백 5단계).
 *
 * 사용자 결정(2026-10-14): 「중단보다 품질이 조금 떨어져도 이어가는 것이 낫다」. 그래서 Claude 가
 * 막히면 다음 엔진이 이어 받는다 — 5단계는 GPT(codex) 한 칸, 6단계는 그 뒤에 agy Gemini · agy Claude(Sonnet)
 * (`DM_FALLBACK_AGY=on` · 차례는 `models.json` 의 `ladders.dm`). 다 막히면 모아 두고(`hold`) 회복 때 다시 돌린다.
 *
 * **여기서는 파일도 슬랙도 안 본다** — 부르는 쪽이 엔진 상태를 읽어(codex 는 한도 조회까지 옮긴 뒤)
 * 막힘 표를 넘긴다. 그래서 검사가 모든 조합을 그대로 돌린다(`scripts/check-dm-fallback.mjs`).
 *
 * 넘기지 않는 차례(늘 Claude · 막혔으면 모아 둠):
 *   - 채널(여럿이 보는 방) · 계획 모드 · 세션을 직접 고른 이어 가기(`-r <id>` · `-continue`)
 *   - 작업 디렉터리가 업무 비서 뿌리가 아님 — 대체 엔진의 규칙·쓰기 범위가 그 뿌리에 맞춰져 있다
 *
 * **개인 글 조각이 든 말도 넘긴다**(2026-10-19 실장 확인) — 세 구독(Claude Code · Codex · agy) 모두 학습에 안 쓰게
 * 설정돼 있어, 그 대화를 맡는 엔진에 보내는 것은 「나간다」가 아니다(`AGENTS.md` 「개인 글」). 방 · 다른 사람 DM 으로
 * 나가는 답은 여전히 개인 글 문(`privacy-guard.ts`)이 막는다.
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

/**
 * **실제 차례의 정본은 `models.json` 의 `ladders.dm`**(2026-10-19 · `model-ladder.ts` `serviceLadder` 가 읽고
 * `dm-fallback.ts` `dmLadder` 가 켜는 문을 얹는다). 아래 둘은 표를 못 읽을 때의 기본값이자 고르는 함수의 기본 인자다.
 */
/** agy 칸을 뺀 차례(5단계 · Claude → GPT) — `DM_FALLBACK_AGY` 가 꺼졌을 때와 같다. */
export const DM_LADDER: readonly Engine[] = ['claude', 'codex'];
/**
 * agy 두 칸을 codex 뒤에 붙인 차례(6단계) — **Gemini(flash-high) 먼저, 그다음 agy 의 Claude Sonnet**. agy 의 Opus 는
 * 안 쓴다(그 풀이 너무 작다 · 2026-10-14 사용자 결정). agy 는 도구가 없어 JSON 계획만 내고
 * 봇이 허용 목록 명령만 실행한다(`agy-actions.ts`) — 그래서 첨부를 읽어야 하는 차례 · Claude·GPT 몫으로
 * 남긴 차례(`needsFull`)는 agy 칸을 건너뛴다.
 */
export const DM_LADDER_AGY: readonly Engine[] = ['claude', 'codex', 'agy-gemini', 'agy-claude'];

export function isAgyRung(e: Engine | LadderPick): e is 'agy-claude' | 'agy-gemini' {
  return e === 'agy-claude' || e === 'agy-gemini';
}

export interface PickInput {
  origin: DmOrigin;
  planMode: boolean;
  /** 사람이 세션을 골라 잇는 명령(`-r <id>` · `-continue`) — 모아 둔 것을 잇는 것은 아님. */
  resumeCmd: boolean;
  /** 첨부 — codex 는 로컬 경로로 받는다(막지 않음). agy 칸은 파일을 못 읽어 건너뛴다. */
  hasFiles: boolean;
  /** agy 가 「Claude·GPT 몫」으로 남긴 차례(`needs_full`)를 다시 돌림 — agy 칸을 건너뛴다. */
  needsFull?: boolean;
  cwdIsWorkAssistant: boolean;
  /** 엔진별 지금 막혔나(엔진 상태 · codex 는 한도 조회를 옮긴 뒤). 없는 칸은 안 막힘. */
  blocked: Partial<Record<Engine, boolean>>;
  claudeOutcome?: ClaudeOutcome;
  /** Claude 가 쓰기 도구를 돌렸나 — 고르는 데는 안 쓴다(넘길 때 프롬프트만 바뀐다). */
  writeRan?: boolean;
}

/** 이 차례를 다른 엔진에 넘겨도 되나 — 안 되면 늘 Claude(막혔으면 모아 둠). */
export function fallbackEligible(i: Pick<PickInput, 'origin' | 'planMode' | 'resumeCmd' | 'cwdIsWorkAssistant'>): boolean {
  return i.origin !== 'channel' && !i.planMode && !i.resumeCmd && i.cwdIsWorkAssistant;
}

/**
 * `after` 다음 칸에서 맡을 수 있는 첫 엔진 — 다 막혔으면 `hold`. 첨부 · `needsFull` 이면 agy 칸을 건너뛴다.
 */
function nextRung(i: Pick<PickInput, 'blocked' | 'hasFiles' | 'needsFull'>, ladder: readonly Engine[],
                  after: Engine = 'claude'): LadderPick {
  const from = ladder.indexOf(after);
  if (from < 0) return 'hold';
  for (const e of ladder.slice(from + 1)) {
    if (i.blocked[e]) continue;
    if (isAgyRung(e) && (i.hasFiles || i.needsFull)) continue;
    return e;
  }
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
  if (o === 'notRun') return i.blocked.claude ? nextRung(i, ladder) : 'claude';
  if (o === 'limited' || o === 'overload') return nextRung(i, ladder);
  return 'claude';
}

/**
 * 대체 칸 하나가 못 했을 때(막힘 · 실패) 그다음 칸 — 6단계. `failed` 뒤에서만 찾는다(실패한 칸이 막힘으로
 * 안 적혔어도 같은 차례에 다시 안 부른다). 넘기지 않는 차례면 `hold`.
 */
export function pickAfter(i: PickInput, failed: Engine, ladder: readonly Engine[]): LadderPick {
  if (!fallbackEligible(i)) return 'hold';
  return nextRung(i, ladder, failed);
}
