/**
 * DM 폴백 — Claude 가 막히면 같은 DM 차례를 GPT(codex)가 이어 받는다(2026-10-14 · 엔진 폴백 5단계).
 * 켜는 문은 `DM_FALLBACK=on` 하나 · 꺼져 있으면 예전 그대로(막히면 모아 두고 회복 때 다시 돌림).
 * `DM_FALLBACK_AGY=on` 이면 GPT 뒤에 agy Claude · agy Gemini 두 칸이 붙는다(6단계 · `agy-turn.ts` · `agy-actions.ts`).
 *
 * 누구에게 맡기나는 `engine-ladder.ts`(`pickEngine`), 차례를 돌리는 것은 대화 처리기(`slack-handler.ts`)
 * 이고 여기는 그 사이의 글과 기록이다 — 표시 줄 · 넘겨줄 메모 · 기록 장부 · `-engines` 표.
 *
 * **장부(`.fallback-ledger.jsonl` · Git 추적 제외)에는 말을 안 적는다** — 언제 · 어느 방 · 어느 엔진 ·
 * 모델 · 캡처 id · 결과만. Claude 가 돌아온 첫 차례가 「막힌 동안 다른 엔진이 몇 건 처리했나」를
 * 여기서 센다(내용은 세션 앞에 붙는 「못 본 대화방 글」이 이미 싣는다).
 */
import { claudeBlocked } from './api-credits';
import * as fs from 'fs';
import * as path from 'path';
import { ENGINES, engineState, type Block, type Engine, type EngineState, type EngineStateData } from './engine-state';
import { isAgyRung } from './engine-ladder';
import { formatKst } from './engine-notice';
import { agyRungsOn } from './agy-turn';
import { serviceLadder } from './model-ladder';
import type { Drill } from './engine-drill';
import { stepState, type StepState, type TurnStep } from './turn-outcome';
import type { CodexStep } from './work-assistant';

/** 켜는 문 — 부를 때마다 읽는다(검사가 환경 변수를 바꿔 끼운다). */
export function dmFallbackOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.DM_FALLBACK === 'on';
}

/**
 * 지금 DM 을 맡는 칸 — 폴백이 꺼져 있으면 Claude 하나(막히면 곧 모아 둠) · `DM_FALLBACK_AGY=on` 이면
 * GPT 뒤에 agy 두 칸(6단계). 엔진 안내 · `-engines` · 드레인이 다 이것을 본다.
 * **칸 차례는 `models.json` 의 `ladders.dm`** 이 정한다(`model-ladder.ts` `serviceLadder` · 못 읽으면 기본 차례).
 * 켜는 문은 그대로다 — `DM_FALLBACK_AGY` 가 꺼져 있으면 표에 agy 칸이 있어도 뺀다.
 */
export function dmLadder(env: NodeJS.ProcessEnv = process.env, file?: string): readonly Engine[] {
  if (!dmFallbackOn(env)) return ['claude'];
  const all = serviceLadder('dm', file);
  return agyRungsOn(env) ? all : all.filter((e) => !isAgyRung(e));
}

/**
 * 엔진별 「지금 못 맡나」 — 엔진 상태의 막힘(진짜 · 연습)뿐. codex 는 부르는 쪽이 한도 조회를 먼저 옮겨 둔다.
 */
export function ladderBlockedMap(store: EngineState = engineState): Partial<Record<Engine, boolean>> {
  // Claude 칸은 크레딧이 있으면 막힌 것이 아니다 — 그 세션은 API 키로 뜬다(2026-10-22).
  return Object.fromEntries(ENGINES.map((e) => [e, e === 'claude' ? claudeBlocked(store) : store.isBlocked(e)])) as Record<Engine, boolean>;
}

/** 대체 차례 하나의 상한 — 실측 16초 안팎(2026-10-14) · 넘으면 트리째 죽이고 모아 둔다. */
export const FALLBACK_TIMEOUT_MS = 180_000;
export const FALLBACK_EFFORT = 'low';

/**
 * 대체 차례에 얹는 환경 변수 — 캡처 id 는 **값으로**(방마다 하나인 가리킴 파일은 다음 차례가 갈아 끼운다) ·
 * 봇이 띄운 세션이라는 표시(codex 시작 훅이 투영 동기화를 건너뛴다). Claude 세션에는 값을 안 박는다 —
 * 미리 띄운 세션의 지문이 차례마다 달라진다(`check:prewarm`).
 */
export function fallbackEnv(captureId: string): Record<string, string> {
  return { WORK_ASSISTANT_CAPTURE: captureId, CLAUDE_BOT_SESSION: '1' };
}

// ---------------------------------------------------------------- 표시 줄

const SHORT: Record<Engine, string> = {
  claude: 'Claude', 'claude-api': 'Claude API', codex: 'GPT', 'agy-claude': 'agy Claude', 'agy-gemini': 'Gemini',
};

/** 「Claude 사용량 소진(풀림 10/14(화) 16:10)」 — 왜 Claude 가 아닌가. */
export function claudeWhy(b: Block | null): string {
  if (!b) return 'Claude 막힘';
  if (b.kind === 'overload') return 'Claude 과부하';
  const when = b.until === null ? '' : b.untilKnown ? `(풀림 ${formatKst(b.until)})` : `(다시 확인 ${formatKst(b.until)})`;
  return `Claude ${b.kind === 'usage' ? '사용량 소진' : b.kind === 'auth' ? '인증 오류' : '응답 오류'}${when}`;
}

/**
 * 대체 엔진이 답했다는 작은 줄(슬랙 context 블록) — 넘겨받았으면 그 줄이 먼저.
 * `handover` 는 Claude 가 이미 한 쓰기 건수(넘겨받지 않았으면 생략).
 */
export function markerLines(o: { model: string; block: Block | null; handover?: number }): string[] {
  const lines: string[] = [];
  if (o.handover !== undefined) {
    lines.push(`↪ Claude 가 하다 끊겨 GPT 가 이어서 마무리했습니다(이미 한 것: ${o.handover}건)`);
  }
  lines.push(`↪ GPT(${o.model}) 가 답함 · ${claudeWhy(o.block)}`);
  return lines;
}

/** 월 API 크레딧 칸(`claude-api`)이 답했다는 작은 줄 — 「↪ Claude API(Sonnet) 가 답함 · <왜 Claude 가 아닌가>」. */
export function claudeApiMarkerLines(o: { block: Block | null; handover?: number }): string[] {
  const lines: string[] = [];
  if (o.handover !== undefined) {
    lines.push(`↪ Claude 가 하다 끊겨 Claude API(Sonnet)가 이어서 마무리했습니다(이미 한 것: ${o.handover}건)`);
  }
  lines.push(`↪ Claude API(Sonnet) 가 답함 · ${claudeWhy(o.block)}`);
  return lines;
}

/** GPT 는 막힘이 아니라 실패로 끝났을 수 있다 — 그때는 「응답 실패」. */
function engineWhy(e: Engine, b: Block | null, nowSec: number): string {
  if (!b || b.until === null || b.until <= nowSec) return `${SHORT[e]} 응답 실패`;
  if (b.kind === 'overload') return `${SHORT[e]} 과부하`;
  const when = b.untilKnown ? `(풀림 ${formatKst(b.until)})` : `(다시 확인 ${formatKst(b.until)})`;
  return `${SHORT[e]} ${b.kind === 'usage' ? '사용량 소진' : b.kind === 'auth' ? '인증 오류' : '응답 오류'}${when}`;
}

/**
 * agy 칸이 답했다는 작은 줄(6단계) — 「↪ agy 의 <표시 이름> 가 답함 · <무엇이 막혔나>」. 표시 이름은
 * `models.json` 에서(`agyDisplay`). 앞 엔진이 쓰기를 하다 끊겼으면 그 줄이 먼저.
 * `above` 는 이 칸 앞의 엔진들(Claude 는 이 차례의 막힘 `claudeBlock` 으로 말한다).
 */
export function agyMarkerLines(o: {
  display: string; claudeBlock: Block | null; above: readonly Engine[]; st: EngineStateData; nowSec: number;
  handover?: number;
}): string[] {
  const lines: string[] = [];
  if (o.handover !== undefined) {
    lines.push(`↪ 앞 엔진이 하다 끊겨 ${o.display} 가 이어서 마무리했습니다(이미 한 것: ${o.handover}건)`);
  }
  const why = o.above.map((e) => (e === 'claude' ? claudeWhy(o.claudeBlock) : engineWhy(e, o.st.engines[e].blocked, o.nowSec)));
  lines.push(`↪ ${o.display} 가 답함 · ${why.join(' · ')}`);
  return lines;
}

/** Claude·GPT 가 돌아오면 이어서 처리할 몫이 남았다는 줄(`needs_full`). */
export const NEEDS_FULL_LINE = '⏸ 이 부분은 Claude·GPT 가 돌아오면 이어서 처리합니다';
/** agy 칸의 명령이 일부 안 됐다는 줄 — 실패 · 허용 목록 밖 · 앞이 실패해 안 돈 것이 있을 때(2026-10-15 검토). */
export const INCOMPLETE_LINE = '⏸ 못 한 명령은 Claude·GPT 가 돌아오면 이어서 처리합니다';

/** agy 칸이 안 돌린 명령을 보류 칸의 「안 함」 줄로 — 쓰기가 아니다(`write: false`). */
export function notRunSteps(rung: string, summaries: readonly string[]): TurnStep[] {
  return summaries.map((s, i) => ({
    id: `${rung}-notrun-${i}`, name: `${rung} 명령`, input: s.slice(0, 120), done: false, write: false, notRun: true,
  }));
}

/** 판에서 온 차례가 「조용히」로 답했나 — 그러면 표시 줄도 안 올린다(답이 안 보이는데 줄만 뜬다). */
export function isQuietReply(text: string): boolean {
  return /^\s*\[조용히\]\s*$/.test((text.split('\n')[0] ?? ''));
}

// ---------------------------------------------------------------- 넘겨줄 메모

/** 넘겨줄 메모의 줄 머리 — 세 갈래(2026-10-15 검토 · 오류로 돌아온 것을 「완료」로 넘기면 필요한 일을 건너뛴다). */
const HANDOVER_HEAD: Record<StepState, string> = {
  done: '완료',
  failed: '실패(다시 해도 됨 — 결과를 확인)',
  unknown: '결과 모름 — 먼저 확인',
  notRun: '안 함 — 앞 엔진이 못 돌린 것(필요하면 한다)',
};

/**
 * 쓰기 도구가 돈 뒤 끊긴 차례를 넘길 때 앞에 붙이는 메모 — 이미 한 것(다시 하지 말 것) · 오류로 끝난 것(결과를
 * 확인하고 다시 해도 됨) · 결과를 못 받은 것(먼저 확인). 쓰기가 없으면 빈 글자.
 */
export function handoverNote(steps: readonly TurnStep[], from = 'Claude'): string {
  const writes = steps.filter((s) => s.write || s.notRun);
  if (!writes.some((s) => s.write)) return '';
  return [
    `[앞 엔진(${from})이 이 요청을 처리하다 한도 · 과부하로 끊겼다 — 이어서 마무리한다]`,
    '이미 한 것 — 다시 하지 말 것 · 결과를 못 받은 것은 확인부터 · 실패한 것은 결과를 확인하고 다시 해도 됨:',
    ...writes.map((s) => `- ${HANDOVER_HEAD[stepState(s)]} · ${[s.name, s.input].filter(Boolean).join(' · ')}`),
    '',
  ].join('\n');
}

/** 첨부의 로컬 경로 — 대체 엔진은 파일을 직접 읽는다. */
export function filesNote(files: ReadonlyArray<{ name: string; path: string }>): string {
  if (!files.length) return '';
  return ['', '[첨부 — 이 PC 의 파일 경로(필요하면 읽는다)]', ...files.map((f) => `- ${f.name}: ${f.path}`)].join('\n');
}

/** codex 가 돌린 명령을 보류 칸의 도구 줄로 — 명령은 다 쓰기로 본다(`codexTurn` 과 같은 규칙). */
export function codexSteps(steps: readonly CodexStep[]): TurnStep[] {
  return steps.map((s, i) => ({ id: `codex-${i}`, name: 'GPT 명령', input: s.cmd, done: s.done, write: true,
    ...(s.failed ? { failed: true } : {}) }));
}

/** 재시작으로 끊길 때를 위한 자리표 — GPT 차례는 도는 동안 무엇을 했는지 안 보이므로 「했을 수 있음」으로 둔다. */
export const CODEX_INFLIGHT_STEP: TurnStep = {
  id: 'codex-inflight', name: 'GPT 명령', input: '(GPT 가 이어 받던 차례 — 무엇을 했는지 모름)', done: false, write: true,
};

/**
 * agy 칸이 명령을 실행하는 동안의 자리표 — agy 를 부르는 동안은 아무것도 안 쓰므로 안 붙이고, 명령을
 * 띄우기 직전에만 붙인다(재시작에 끊기면 그 명령은 「결과 모름」).
 */
export function agyRunningStep(rung: string, summary: string): TurnStep {
  return { id: `${rung}-running`, name: `${rung} 명령`, input: `(실행 중 — 결과 모름) ${summary}`.slice(0, 120), done: false, write: true };
}

// ---------------------------------------------------------------- 장부

export interface LedgerEntry {
  /** epoch 초(밀리초까지 소수로) — 세션의 마지막 차례 시각과 견준다. */
  at: number;
  channel: string;
  /** 맡은 엔진 — 다 막혀 모아 두었으면 `none`. */
  engine: Engine | 'none';
  model: string;
  captureId: string;
  /** `ok` · `usage` · `fail` · `hold` · `stopped` */
  outcome: string;
}

/** 장부 자리 — 검사는 `FALLBACK_LEDGER_FILE` 로 옮긴다. */
export function ledgerFile(): string {
  return process.env.FALLBACK_LEDGER_FILE || path.join(__dirname, '..', '.fallback-ledger.jsonl');
}

/** 한 줄 덧붙인다 — **말은 안 싣는다**(칸을 골라 적는다). 실패해도 차례를 막지 않는다. */
export function appendLedger(e: Omit<LedgerEntry, 'at'> & { at?: number }, file: string = ledgerFile()): void {
  const row: LedgerEntry = {
    at: e.at ?? Date.now() / 1000, channel: e.channel, engine: e.engine,
    model: e.model, captureId: e.captureId, outcome: e.outcome,
  };
  try {
    fs.appendFileSync(file, JSON.stringify(row) + '\n', 'utf-8');
  } catch {
    /* 기록이 빠질 뿐 — 차례는 간다 */
  }
}

/** 장부 꼬리만 읽는다 — 쌓여도 차례마다 통째로 안 읽게. */
const LEDGER_TAIL_BYTES = 64 * 1024;

/** 이 방에서 `sinceSec` 뒤에 다른 엔진이 끝까지 처리한 건수. */
export function ledgerServedSince(channel: string, sinceSec: number, file: string = ledgerFile()): number {
  return ledgerTail(file).filter((r) => r?.channel === channel && r.outcome === 'ok' && r.engine !== 'claude'
    && Number(r.at) > sinceSec).length;
}

/**
 * 이 방에서 `sinceSec` 뒤에 장부에 적힌 차례가 있나 — 결과를 안 가린다(답함 · 모아 둠 · 끊김).
 * Claude 를 안 거친 차례는 세션 시각을 안 밀므로, 세션 정리가 이것을 「쓰는 중」으로 센다.
 */
export function ledgerActiveSince(channel: string, sinceSec: number, file: string = ledgerFile()): boolean {
  return ledgerTail(file).some((r) => r?.channel === channel && Number(r.at) > sinceSec);
}

/** 장부 꼬리의 줄들 — 못 읽으면 빈 목록. */
function ledgerTail(file: string): any[] {
  let text = '';
  try {
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, 'r');
    try {
      const len = Math.min(size, LEDGER_TAIL_BYTES);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      text = buf.toString('utf-8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
  const rows: any[] = [];
  for (const l of text.split('\n')) {
    try { rows.push(JSON.parse(l)); } catch { /* 잘린 첫 줄 · 빈 줄 */ }
  }
  return rows;
}

/** Claude 가 돌아온 첫 차례 앞에 붙이는 한 줄. */
export function ledgerNote(n: number): string {
  return n > 0 ? `[Claude 가 막힌 동안 다른 엔진이 처리한 것 — ${n}건 · 자세한 내용은 위 대화방 글]` : '';
}

// ---------------------------------------------------------------- `-engines`

const KIND: Record<string, string> = { usage: '사용량 소진', overload: '과부하', auth: '인증 오류', unknown: '응답 오류' };

function drillLabel(d: Drill): string {
  const parts = [d.claude ? `Claude ${d.claude}` : '', d.codex ? `GPT ${d.codex}` : '',
    d.agyClaude ? `agy Claude ${d.agyClaude}` : '', d.agyGemini ? `Gemini ${d.agyGemini}` : ''].filter(Boolean);
  return `연습 중(${parts.join(' · ')}${d.scope === 'all' ? ' · 예약 일 포함' : ''} · ${formatKst(d.expiresAt)}까지)`;
}

/** `-engines` 의 답 — 머리 한 줄 + 엔진 넷(막힘 · 풀리는 시각 · 마지막 성공 · 사용률). */
export function engineStatusText(st: EngineStateData, nowSec: number, o: {
  fallback: boolean; notice: boolean; drill: Drill | null; ladder: readonly Engine[]; agy?: boolean;
}): string {
  const head = `🔧 엔진 상태 — DM 폴백 ${o.fallback ? '켜짐' : '꺼짐'} · agy 칸 ${o.agy ? '켜짐' : '꺼짐'}`
    + ` · 엔진 안내 ${o.notice ? '켜짐' : '꺼짐'} · ${o.drill ? drillLabel(o.drill) : '연습 없음'}`;
  const lines = ENGINES.map((e) => {
    const r = st.engines[e];
    const b = r.blocked;
    const live = b && b.until !== null && b.until > nowSec;
    const state = live
      ? `막힘(${KIND[b!.kind] ?? b!.kind} · ${b!.untilKnown ? '풀림' : '다시 확인'} ${formatKst(b!.until!)})`
      : '막힘 없음';
    const ok = r.lastOkAt ? `마지막 성공 ${formatKst(r.lastOkAt)}` : '마지막 성공 없음';
    const util = [
      typeof r.util?.five_hour === 'number' ? `5시간 ${Math.round(r.util.five_hour * 100)}%` : '',
      typeof r.util?.seven_day === 'number' ? `7일 ${Math.round(r.util.seven_day * 100)}%` : '',
    ].filter(Boolean);
    const off = o.ladder.includes(e) ? [] : ['DM 사다리 밖'];
    return `• ${SHORT[e]} — ${[state, ok, ...util, ...off].join(' · ')}`;
  });
  return [head, ...lines].join('\n');
}
