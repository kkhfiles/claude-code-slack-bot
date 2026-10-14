/**
 * DM 폴백 — Claude 가 막히면 같은 DM 차례를 GPT(codex)가 이어 받는다(2026-10-14 · 엔진 폴백 5단계).
 * 켜는 문은 `DM_FALLBACK=on` 하나 · 꺼져 있으면 예전 그대로(막히면 모아 두고 회복 때 다시 돌림).
 *
 * 누구에게 맡기나는 `engine-ladder.ts`(`pickEngine`), 차례를 돌리는 것은 대화 처리기(`slack-handler.ts`)
 * 이고 여기는 그 사이의 글과 기록이다 — 표시 줄 · 넘겨줄 메모 · 기록 장부 · `-engines` 표.
 *
 * **장부(`.fallback-ledger.jsonl` · Git 추적 제외)에는 말을 안 적는다** — 언제 · 어느 방 · 어느 엔진 ·
 * 모델 · 캡처 id · 결과만. Claude 가 돌아온 첫 차례가 「막힌 동안 다른 엔진이 몇 건 처리했나」를
 * 여기서 센다(내용은 세션 앞에 붙는 「못 본 대화방 글」이 이미 싣는다).
 */
import * as fs from 'fs';
import * as path from 'path';
import { ENGINES, type Block, type Engine, type EngineStateData } from './engine-state';
import { DM_LADDER } from './engine-ladder';
import { formatKst } from './engine-notice';
import type { Drill } from './engine-drill';
import type { TurnStep } from './turn-outcome';
import type { CodexStep } from './work-assistant';

/** 켜는 문 — 부를 때마다 읽는다(검사가 환경 변수를 바꿔 끼운다). */
export function dmFallbackOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.DM_FALLBACK === 'on';
}

/** 지금 DM 을 맡는 칸 — 폴백이 꺼져 있으면 Claude 하나(막히면 곧 모아 둠). */
export function dmLadder(env: NodeJS.ProcessEnv = process.env): readonly Engine[] {
  return dmFallbackOn(env) ? DM_LADDER : ['claude'];
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

const SHORT: Record<Engine, string> = { claude: 'Claude', codex: 'GPT', 'agy-claude': 'agy Claude', 'agy-gemini': 'Gemini' };

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

/** 판에서 온 차례가 「조용히」로 답했나 — 그러면 표시 줄도 안 올린다(답이 안 보이는데 줄만 뜬다). */
export function isQuietReply(text: string): boolean {
  return /^\s*\[조용히\]\s*$/.test((text.split('\n')[0] ?? ''));
}

// ---------------------------------------------------------------- 넘겨줄 메모

/**
 * 쓰기 도구가 돈 뒤 끊긴 차례를 넘길 때 앞에 붙이는 메모 — 이미 한 것(다시 하지 말 것)과
 * 결과를 못 받은 것(먼저 확인). 쓰기가 없으면 빈 글자.
 */
export function handoverNote(steps: readonly TurnStep[]): string {
  const writes = steps.filter((s) => s.write);
  if (!writes.length) return '';
  return [
    '[앞 엔진(Claude)이 이 요청을 처리하다 한도 · 과부하로 끊겼다 — 이어서 마무리한다]',
    '이미 한 것 — 다시 하지 말 것 · 결과를 못 받은 것은 확인부터:',
    ...writes.map((s) => `- ${s.done ? '완료' : '결과 모름 — 먼저 확인'} · ${[s.name, s.input].filter(Boolean).join(' · ')}`),
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
  return steps.map((s, i) => ({ id: `codex-${i}`, name: 'GPT 명령', input: s.cmd, done: s.done, write: true }));
}

/** 재시작으로 끊길 때를 위한 자리표 — GPT 차례는 도는 동안 무엇을 했는지 안 보이므로 「했을 수 있음」으로 둔다. */
export const CODEX_INFLIGHT_STEP: TurnStep = {
  id: 'codex-inflight', name: 'GPT 명령', input: '(GPT 가 이어 받던 차례 — 무엇을 했는지 모름)', done: false, write: true,
};

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
    return 0;
  }
  let n = 0;
  for (const l of text.split('\n')) {
    let r: any;
    try { r = JSON.parse(l); } catch { continue; }
    if (r?.channel === channel && r.outcome === 'ok' && r.engine !== 'claude' && Number(r.at) > sinceSec) n += 1;
  }
  return n;
}

/** Claude 가 돌아온 첫 차례 앞에 붙이는 한 줄. */
export function ledgerNote(n: number): string {
  return n > 0 ? `[Claude 가 막힌 동안 다른 엔진이 처리한 것 — ${n}건 · 자세한 내용은 위 대화방 글]` : '';
}

// ---------------------------------------------------------------- `-engines`

const KIND: Record<string, string> = { usage: '사용량 소진', overload: '과부하', auth: '인증 오류', unknown: '응답 오류' };

function drillLabel(d: Drill): string {
  const parts = [d.claude ? `Claude ${d.claude}` : '', d.codex ? `GPT ${d.codex}` : ''].filter(Boolean);
  return `연습 중(${parts.join(' · ')}${d.scope === 'all' ? ' · 예약 일 포함' : ''} · ${formatKst(d.expiresAt)}까지)`;
}

/** `-engines` 의 답 — 머리 한 줄 + 엔진 넷(막힘 · 풀리는 시각 · 마지막 성공 · 사용률). */
export function engineStatusText(st: EngineStateData, nowSec: number, o: {
  fallback: boolean; notice: boolean; drill: Drill | null; ladder: readonly Engine[];
}): string {
  const head = `🔧 엔진 상태 — DM 폴백 ${o.fallback ? '켜짐' : '꺼짐'} · 엔진 안내 ${o.notice ? '켜짐' : '꺼짐'}`
    + ` · ${o.drill ? drillLabel(o.drill) : '연습 없음'}`;
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
