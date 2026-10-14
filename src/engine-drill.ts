/**
 * 엔진 폴백 연습 — `.engine-drill.json` 이 있으면 Claude · codex 를 부르는 대신 **막힌 모양을 그대로 재생**한다
 * (2026-10-14 · 엔진 폴백 5단계). DM 폴백(`DM_FALLBACK`)을 켜기 전에 실제 봇에서 사다리를 돌려 보려고 둔다.
 *
 *   { "claude": "usage" | "usage-after-tool" | "overload",
 *     "codex": "usage" | "fail",
 *     "agyClaude": "usage" | "fail", "agyGemini": "usage" | "fail",   (6단계 · agy 두 칸 — codex 와 같은 규칙)
 *     "expiresAt": <epoch 초>, "scope": "all"(생략 = 대화 차례만) }
 *
 * - **대화 차례만** — 예약 일(브리핑 · 분석 · 좁은 길)은 `scope: "all"` 일 때만 받는다
 * - **안 받는 파일** — 없음 · 지남 · `expiresAt` 이 2시간 넘게 남음(잊고 둔 파일이 하루 내내 막지 않게)
 * - **주입할 때마다 WARN 한 줄** — 연습이 돌고 있다는 것이 로그에 늘 보이게
 * - **엔진 상태에는 진짜처럼 적힌다** — 재생한 이벤트가 전송 탭(`engine-tap.ts`)을 그대로 지나고,
 *   codex 는 여기서 막힘을 적는다. 막힘은 20분 뒤와 연습 파일의 `expiresAt` 중 이른 쪽에 풀린다
 *   (`drillBlockUntil`) — 연습 파일을 일찍 지우면 그 남은 시간만큼은 남는다
 *
 * Claude 갈래 셋:
 *   - `usage` — init → `rate_limit_event`(rejected · 5시간 창 · 20분 뒤 풀림) → 한도 글 → 오류 결과
 *   - `overload` — init → 「API Error: 529 Overloaded …」(`error: overloaded`) → 오류 결과
 *   - `usage-after-tool` — **진짜 차례**를 첫 도구 결과까지 돌린 뒤 거절 이벤트 · 한도 글 · 오류 결과를
 *     끼우고 진짜 프로세스를 멈춘다(쓰기 도구가 돈 뒤 끊긴 차례를 넘기는 길)
 *
 * 연습 이벤트에는 메시지 uuid 를 안 단다 — 대화 처리기가 그 값을 다음 차례의 이어 갈 자리로 적는다.
 */
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import type { ChildProcess } from 'child_process';
import { Logger } from './logger';

export type ClaudeDrill = 'usage' | 'usage-after-tool' | 'overload';
export type CodexDrill = 'usage' | 'fail';
export type DrillScope = 'interactive' | 'scheduled';

export interface Drill {
  claude?: ClaudeDrill;
  codex?: CodexDrill;
  /** agy 두 칸(6단계) — codex 와 같은 갈래 둘. */
  agyClaude?: CodexDrill;
  agyGemini?: CodexDrill;
  expiresAt: number;
  scope?: 'all';
}

/** 이보다 멀리 남은 연습 파일은 안 받는다. */
export const DRILL_MAX_AHEAD_SEC = 2 * 3600;
/** 연습이 적는 막힘 길이 — 실제 5시간 창 대신. */
export const DRILL_BLOCK_SEC = 20 * 60;

/**
 * 연습 막힘이 풀리는 시각 — 20분 뒤와 연습 파일의 `expiresAt` 중 이른 쪽. **막힘이 연습보다 오래 가지 않게**
 * 한다 — 안 그러면 연습이 끝난 뒤에도 남은 시간 동안 DM 이 Claude 를 건너뛰어 진짜 GPT 를 부른다(5단계 검토).
 */
export function drillBlockUntil(nowSec: number = Math.floor(Date.now() / 1000)): number {
  const d = readDrill(nowSec);
  return Math.min(nowSec + DRILL_BLOCK_SEC, d ? d.expiresAt : Infinity);
}

const CLAUDE_MODES: readonly string[] = ['usage', 'usage-after-tool', 'overload'];
const CODEX_MODES: readonly string[] = ['usage', 'fail'];

const logger = new Logger('EngineDrill');

/** 연습 파일 자리 — 검사는 `ENGINE_DRILL_FILE` 로 옮긴다. */
export function drillFile(): string {
  return process.env.ENGINE_DRILL_FILE || path.join(__dirname, '..', '.engine-drill.json');
}

/** 읽는다 — 받을 수 없는 파일이면 `null`. **절대 안 던진다.** */
export function readDrill(nowSec: number = Math.floor(Date.now() / 1000), file: string = drillFile()): Drill | null {
  let raw: any;
  try {
    if (!fs.existsSync(file)) return null;
    // 윈도 PowerShell 5.1 의 `-Encoding utf8` 은 BOM 을 붙인다 — 떼고 읽는다.
    raw = JSON.parse(fs.readFileSync(file, 'utf-8').replace(/^﻿/, ''));
  } catch {
    logger.warn('엔진 연습 파일을 못 읽어 무시합니다', { file: path.basename(file) });
    return null;
  }
  if (!raw || typeof raw.expiresAt !== 'number') {
    logger.warn('엔진 연습 파일에 expiresAt(epoch 초)이 없어 무시합니다');
    return null;
  }
  if (raw.expiresAt <= nowSec) return null;
  if (raw.expiresAt > nowSec + DRILL_MAX_AHEAD_SEC) {
    logger.warn('엔진 연습 파일의 expiresAt 이 2시간 넘게 남아 무시합니다');
    return null;
  }
  const d: Drill = { expiresAt: raw.expiresAt };
  if (CLAUDE_MODES.includes(raw.claude)) d.claude = raw.claude;
  if (CODEX_MODES.includes(raw.codex)) d.codex = raw.codex;
  if (CODEX_MODES.includes(raw.agyClaude)) d.agyClaude = raw.agyClaude;
  if (CODEX_MODES.includes(raw.agyGemini)) d.agyGemini = raw.agyGemini;
  if (raw.scope === 'all') d.scope = 'all';
  return d.claude || d.codex || d.agyClaude || d.agyGemini ? d : null;
}

function active(scope: DrillScope | undefined, nowSec: number): Drill | null {
  const d = readDrill(nowSec);
  if (!d) return null;
  if ((scope ?? 'scheduled') === 'scheduled' && d.scope !== 'all') return null;
  return d;
}

/** 이 차례에 Claude 연습을 넣나 — 넣으면 WARN 한 줄. */
export function claudeDrill(scope?: DrillScope, nowSec: number = Math.floor(Date.now() / 1000)): ClaudeDrill | null {
  const mode = active(scope, nowSec)?.claude ?? null;
  if (mode) {
    logger.warn(`엔진 연습 — Claude 에 「${mode}」 주입(${mode === 'usage-after-tool' ? '진짜 차례의 첫 도구 결과 뒤에' : '실제 호출 대신'})`,
      { scope: scope ?? 'scheduled' });
  }
  return mode;
}

/** 이 차례에 codex 연습을 넣나 — 넣으면 WARN 한 줄. */
export function codexDrill(scope?: DrillScope, nowSec: number = Math.floor(Date.now() / 1000)): CodexDrill | null {
  const mode = active(scope, nowSec)?.codex ?? null;
  if (mode) logger.warn(`엔진 연습 — codex 에 「${mode}」 주입(실제 호출 대신)`, { scope: scope ?? 'scheduled' });
  return mode;
}

/** 이 차례에 agy 칸 연습을 넣나 — 넣으면 WARN 한 줄. 연습이 막은 호출은 Gemini 상한에도 안 센다. */
export function agyDrill(rung: 'agy-claude' | 'agy-gemini', scope?: DrillScope,
                         nowSec: number = Math.floor(Date.now() / 1000)): CodexDrill | null {
  const d = active(scope, nowSec);
  const mode = (rung === 'agy-claude' ? d?.agyClaude : d?.agyGemini) ?? null;
  if (mode) logger.warn(`엔진 연습 — ${rung} 에 「${mode}」 주입(실제 호출 대신)`, { scope: scope ?? 'scheduled' });
  return mode;
}

/** 「4:10pm」 — 한국 시각. 실제 한도 글과 같은 모양이라 글로 읽는 길(`parseResetAt`)도 같은 시각을 낸다. */
function kstClock(sec: number): string {
  const d = new Date((sec + 9 * 3600) * 1000);
  const h = d.getUTCHours();
  return `${h % 12 || 12}:${String(d.getUTCMinutes()).padStart(2, '0')}${h < 12 ? 'am' : 'pm'}`;
}

const OVERLOAD_TEXT = 'API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment.';

/** 한도에 막힌 꼬리 — 거절 이벤트 · 한도 글 · 오류 결과. `usage-after-tool` 이 진짜 차례 뒤에 끼운다. */
export function limitTail(sessionId: string, nowSec: number = Math.floor(Date.now() / 1000)): any[] {
  const resetsAt = drillBlockUntil(nowSec);
  const text = `You've hit your session limit · resets ${kstClock(resetsAt)} (Asia/Seoul)`;
  return [
    { type: 'rate_limit_event', session_id: sessionId,
      rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt } },
    { type: 'assistant', session_id: sessionId, parent_tool_use_id: null,
      message: { role: 'assistant', content: [{ type: 'text', text }] } },
    { type: 'result', subtype: 'success', is_error: true, result: text, session_id: sessionId,
      total_cost_usd: 0, duration_ms: 0, permission_denials: [] },
  ];
}

/** 처음부터 막힌 차례 — `usage` · `overload`. */
export function claudeDrillEvents(mode: 'usage' | 'overload', sessionId: string,
                                  nowSec: number = Math.floor(Date.now() / 1000)): any[] {
  const init = { type: 'system', subtype: 'init', session_id: sessionId, model: 'drill', tools: [] };
  if (mode === 'usage') return [init, ...limitTail(sessionId, nowSec)];
  return [
    init,
    { type: 'assistant', session_id: sessionId, parent_tool_use_id: null, error: 'overloaded',
      message: { role: 'assistant', content: [{ type: 'text', text: OVERLOAD_TEXT }] } },
    { type: 'result', subtype: 'success', is_error: true, result: OVERLOAD_TEXT, session_id: sessionId,
      total_cost_usd: 0, duration_ms: 0, permission_denials: [] },
  ];
}

/** 도구 결과가 실린 이벤트인가 — `usage-after-tool` 이 끼울 때를 정한다. */
export function hasToolResult(ev: any): boolean {
  const parts = ev?.message?.content;
  return ev?.type === 'user' && Array.isArray(parts) && parts.some((p: any) => p?.type === 'tool_result');
}

// ---------------------------------------------------------------- SDK 길

/** 정해 둔 이벤트를 차례로 내는 가짜 `Query` — `SdkProcess` 가 그대로 돈다. 끊으면 멈춘다. */
export async function* drillQuery(events: readonly any[], signal: AbortSignal): AsyncGenerator<any> {
  for (const ev of events) {
    if (signal.aborted) return;
    await new Promise((r) => setImmediate(r));
    yield ev;
  }
}

/** 진짜 흐름을 첫 도구 결과까지 내고, 꼬리를 끼운 뒤 진짜를 멈춘다. */
export async function* afterFirstToolResult(
  real: AsyncIterable<any>, stop: () => void, tail: () => any[],
): AsyncGenerator<any> {
  const it = real[Symbol.asyncIterator]();
  for (;;) {
    const r = await it.next();
    if (r.done) return;
    yield r.value;
    if (hasToolResult(r.value)) {
      stop();
      // 멈춘 진짜 흐름을 닫는다 — 끊긴 흐름이 던지는 것은 삼킨다(이 차례는 꼬리로 끝난다).
      void Promise.resolve(it.return?.(undefined)).catch(() => { /* 이미 끊김 */ });
      for (const ev of tail()) yield ev;
      return;
    }
  }
}

// ---------------------------------------------------------------- CLI 길

type FakeChild = EventEmitter & {
  stdout: EventEmitter; stderr: EventEmitter;
  stdin: { write: (s: string) => boolean; end: () => void };
  kill: (sig?: string) => boolean; pid?: number;
};

function fakeChild(): FakeChild {
  const c = new EventEmitter() as FakeChild;
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  c.stdin = { write: () => true, end: () => { /* 받을 것 없음 */ } };
  c.kill = () => true;
  return c;
}

const line = (ev: any) => Buffer.from(`${JSON.stringify(ev)}\n`, 'utf-8');

/** 처음부터 막힌 차례를 stream-json 줄로 내는 가짜 자식 — `CliProcess` 가 그대로 읽는다. */
export function drillChild(events: readonly any[]): ChildProcess {
  const c = fakeChild();
  let killed = false;
  c.kill = () => { killed = true; return true; };
  setImmediate(() => {
    for (const ev of events) {
      if (killed) break;
      c.stdout.emit('data', line(ev));
    }
    c.emit('exit', 0, null);
  });
  return c as unknown as ChildProcess;
}

/** 진짜 `claude` 를 띄워 줄을 넘기다가 첫 도구 결과 뒤에 꼬리를 끼우고 진짜를 멈춘다. */
export function relayChild(spawnReal: () => ChildProcess, tail: () => any[]): ChildProcess {
  const real = spawnReal();
  const c = fakeChild();
  c.stdin = real.stdin as any;
  c.pid = real.pid;
  c.kill = (sig?: string) => real.kill(sig as any);
  let buf = '';
  let cut = false;
  real.stdout?.on('data', (chunk: Buffer) => {
    if (cut) return;
    buf += chunk.toString('utf-8');
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const l of lines) {
      if (cut) break;
      if (!l.trim()) continue;
      c.stdout.emit('data', Buffer.from(`${l}\n`, 'utf-8'));
      let ev: any = null;
      try { ev = JSON.parse(l); } catch { /* 줄이 아님 */ }
      if (ev && hasToolResult(ev)) {
        cut = true;
        for (const t of tail()) c.stdout.emit('data', line(t));
        try { real.kill(); } catch { /* 이미 끝남 */ }
        setImmediate(() => c.emit('exit', 0, null));
      }
    }
  });
  real.stderr?.on('data', (chunk: Buffer) => { if (!cut) c.stderr.emit('data', chunk); });
  real.on('exit', (code, signal) => { if (!cut) c.emit('exit', code, signal); });
  real.on('error', (err) => { if (!cut) c.emit('error', err); });
  return c as unknown as ChildProcess;
}
