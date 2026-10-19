/**
 * agy 한 차례 — DM 폴백의 agy 두 칸(agy 의 Claude · Gemini)과 예약 일의 agy 칸이 다 여기를 지난다
 * (2026-10-14 · 엔진 폴백 6단계 · 켜는 문 `DM_FALLBACK_AGY=on`).
 *
 * - **llm-playbook 의 agy 백엔드를 한 번 부른다** — `python -m llm_playbook.backends.agy --prompt-file …
 *   --out … --model <별칭> --no-fallback --tools none`. 별칭과 표시 이름은 `models.json` 에서 읽는다
 *   (판 번호를 여기 적지 않는다 · 표를 못 읽으면 별칭 그대로)
 * - **agy 에는 쓰기 도구가 없다**(`--tools none` · 백엔드의 `agy_guard`) — DM 칸은 JSON 계획만 받고
 *   실행은 봇이 허용 목록으로 한다(`agy-actions.ts`)
 * - **한도** — 백엔드가 stderr 끝 줄에 남기는 `attempts=[(…, 'quota/limit')]` 또는 짧은 쿼터 글이면 엔진
 *   상태에 막힘을 적는다. agy 는 풀리는 시각을 안 알려 줘 60분 뒤 다시 본다(`REPROBE_SEC`)
 * - **칸을 건너뛰는 것은 엔진 상태의 막힘뿐**(진짜 · 연습) — Gemini 횟수 상한은 두지 않는다(2026-10-14 사용자 결정)
 * - **연습 파일**의 `agyClaude` · `agyGemini`(`usage` · `fail`)를 받는다 — codex 와 같은 규칙
 * - API 키는 뺀다(`child-env.ts`) · **셸을 안 거친다**(인자 배열) · `-stop` 이 끊을 손잡이를 넘긴다(트리째)
 * - **절대 안 던진다** — 무엇이 나든 `fail` 로 물러난다
 *
 * 실측(0단계 · 2026-10-14): 한 번에 agy Claude 13.7~14.5초 · Gemini 21~36.5초. 상한은 그 여섯 배 안팎.
 * 칸 순서는 Gemini(`flash-high`) 먼저, agy 의 Claude Sonnet(`sonnet-thinking`) 다음(2026-10-14 사용자 결정).
 */
import { spawn, execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { withoutApiKey } from './child-env';
import { agyDrill, drillBlockUntil, type DrillScope } from './engine-drill';
import { modelsFile } from './engine-notice';
import { isAgyRung } from './engine-ladder';
import { engineState, type BlockKind, type EngineState } from './engine-state';
import { Logger } from './logger';
import { serviceLadder } from './model-ladder';

const logger = new Logger('AgyTurn');

export type AgyRung = 'agy-claude' | 'agy-gemini';

/**
 * 예약 일의 agy 칸 차례 — `models.json` 의 `ladders.scheduled` 에서 agy 칸만(앞에서부터 · `model-ladder.ts`
 * `serviceLadder` · 못 읽으면 Gemini → agy Claude). **부를 때마다 본다** — 표에서 칸을 빼면 다음 회차부터 안 부른다.
 */
export function agyRungOrder(file?: string): AgyRung[] {
  return serviceLadder('scheduled', file).filter(isAgyRung);
}

/** 켜는 문 — DM 의 agy 두 칸(`DM_FALLBACK=on` 도 있어야 함)과 예약 일 넷의 agy 칸. 부를 때마다 읽는다. */
export function agyRungsOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.DM_FALLBACK_AGY === 'on';
}

/** 칸 하나의 상한(밀리초). 넘으면 트리째 죽이고 `fail`. */
export const AGY_TIMEOUT_MS: Record<AgyRung, number> = { 'agy-claude': 90_000, 'agy-gemini': 150_000 };

/** 백엔드 stderr 를 들고 있는 상한 — 끝쪽만 남긴다(판정 줄이 마지막이다). */
const STDERR_KEEP = 40_000;

/**
 * 칸마다 별칭 하나 — **정본은 `models.json` 의 `service_fallback.agy`**(앞 = Gemini 칸 · 뒤 = agy Claude 칸).
 * 1차 모델 등급과 무관하다(agy 칸은 등급 대응을 안 한다). **agy 의 Opus 는 안 쓴다** — 그 풀이 너무 작다
 * (2026-10-14 사용자 결정). 아래는 표에 그 칸이 없을 때만 쓰는 값이다.
 */
export const AGY_ALIAS: Record<AgyRung, string> = { 'agy-claude': 'sonnet-thinking', 'agy-gemini': 'flash-high' };

/** 표의 `service_fallback.agy` 에서 칸의 별칭 — 없으면 `AGY_ALIAS`. */
function aliasFromTable(t: any, rung: AgyRung): string {
  const list = Array.isArray(t?.service_fallback?.agy) ? t.service_fallback.agy : [];
  const v = list[rung === 'agy-gemini' ? 0 : 1];
  return typeof v === 'string' && v ? v : AGY_ALIAS[rung];
}

export interface AgyModel {
  /** 백엔드에 넘기는 별칭. */
  alias: string;
  /** `models.json` 의 표시 이름 — 못 읽으면 빈 글자. */
  label: string;
}

/**
 * 칸의 별칭과 표시 이름(`AGY_ALIAS` · 엔진 안내와 같은 규칙). 표시 이름은 `models.json` 에서 —
 * **부를 때마다 읽는다** — 표를 고치면 다음 차례부터 따라온다.
 */
export function agyModel(rung: AgyRung, file: string = modelsFile()): AgyModel {
  let alias = AGY_ALIAS[rung];
  let label = '';
  try {
    const t = JSON.parse(fs.readFileSync(file, 'utf-8'));
    alias = aliasFromTable(t, rung);
    const m = t?.agy?.models?.[alias];
    if (typeof m === 'string') label = m;
  } catch {
    /* 표가 없다 — 별칭 그대로 부른다 */
  }
  return { alias, label };
}

/** 사람에게 보이는 이름 — 「agy 의 <표시 이름>」 · 「<표시 이름>」. 표를 못 읽으면 판 없이. */
export function agyDisplay(rung: AgyRung, label: string): string {
  if (rung === 'agy-claude') return `agy 의 ${label || 'Claude'}`;
  return label || 'Gemini';
}

/** 이 칸을 지금 못 쓰나 — 엔진 상태의 막힘(진짜 · 연습)뿐. */
export function agyRungBlocked(rung: AgyRung, store: EngineState = engineState): boolean {
  return store.isBlocked(rung);
}

// ---------------------------------------------------------------- 띄우기

/**
 * 띄울 명령 — 기본은 PATH 의 파이썬으로 llm-playbook 의 agy 백엔드. **검사가 가짜 백엔드를 끼우는 문**이
 * `AGY_TURN_CMD`(JSON 배열)다 — 진짜 agy 를 안 부르고 실행으로 잰다.
 */
function agyCommand(): string[] {
  const raw = process.env.AGY_TURN_CMD;
  if (raw) {
    try {
      const a = JSON.parse(raw);
      if (Array.isArray(a) && a.length && a.every((x) => typeof x === 'string' && x)) return a;
    } catch {
      /* 깨진 값 — 기본으로 */
    }
  }
  return [process.env.AGY_PYTHON || process.env.LADDER_PYTHON || 'python', '-X', 'utf8', '-m', 'llm_playbook.backends.agy'];
}

/** 백엔드가 「쓸 만한 답이 아님 · 쿼터」로 가르는 글 — `agy.py` 의 `_QUOTA_RE` 와 같은 갈래. */
const QUOTA_RE = /(quota|rate.?limit|429|exhaust|usage limit|limit reach|too many request|한도|사용량.{0,4}초과)/i;
const OVERLOAD_RE = /(overload|unavailable|503|529|try again later)/i;

function clip(s: string, max = 200): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

export type AgyKind = 'ok' | 'usage' | 'fail';

export interface AgyCallResult {
  kind: AgyKind;
  /** `ok` 일 때만 채운다 — 한도 · 실패 글이 답으로 새지 않게. */
  text: string;
  rung: AgyRung;
  model: AgyModel;
  ms: number;
  /** 실패 까닭 한 줄 — 로그용. */
  detail?: string;
}

/**
 * 끝난 백엔드를 가른다 — **답 본문으로 한도를 가리지 않는다**(답이 한도를 이야기하면 막힘으로 둔갑한다).
 * 백엔드는 쿼터 글도 `--out` 에 쓰고 rc 0 으로 끝나므로 stderr 의 `attempts` 줄이 정본이다.
 */
export function classifyAgy(r: { code: number; out: string; stderr: string; timedOut: boolean }):
  { kind: AgyKind; block?: BlockKind; detail?: string } {
  if (r.timedOut) return { kind: 'fail', detail: '시간 초과' };
  const attempts = /attempts=\[([^\n]*?)\]\s+elapsed=/.exec(r.stderr)?.[1];
  if (attempts !== undefined) {
    if (/'ok'\)/.test(attempts) && r.out.trim()) return { kind: 'ok' };
    const quota = /quota\/limit/.test(attempts) || (/no-output/.test(attempts) && QUOTA_RE.test(attempts));
    if (quota || (/no-output/.test(attempts) && OVERLOAD_RE.test(attempts))) {
      const why = `${attempts} ${r.out}`;
      return { kind: 'usage', block: OVERLOAD_RE.test(why) && !QUOTA_RE.test(why) ? 'overload' : 'usage', detail: clip(attempts) };
    }
    return { kind: 'fail', detail: clip(attempts) };
  }
  // 끝 줄이 없다(옛 판 · 가짜) — rc 와 `--out` 으로 가르고, 한도는 stderr 에서만 본다.
  if (r.code === 0 && r.out.trim()) return { kind: 'ok' };
  const tail = r.stderr.slice(-600);
  if (QUOTA_RE.test(tail)) return { kind: 'usage', block: 'usage', detail: clip(tail) };
  if (OVERLOAD_RE.test(tail)) return { kind: 'usage', block: 'overload', detail: clip(tail) };
  return { kind: 'fail', detail: `rc ${r.code} ${clip(tail)}`.trim() };
}

export interface AgyCallOpts {
  rung: AgyRung;
  /** 앞에 `<system>` 으로 붙인다 — 백엔드의 `--system` 과 같은 모양(긴 글을 인자로 안 넘긴다). */
  system?: string;
  timeoutMs?: number;
  store?: EngineState;
  /** 엔진 연습을 받는 차례인가 — 대화 차례는 `interactive`(생략하면 예약 일). */
  drillScope?: DrillScope;
  /** 띄운 직후 죽이는 손잡이를 넘긴다(`-stop`). */
  onSpawn?: (kill: () => void) => void;
  env?: Record<string, string>;
  /** 모델 표 — 검사가 바꿔 끼운다. */
  modelsFile?: string;
}

function runBackend(argv: string[], o: { timeoutMs: number; env?: Record<string, string>;
  onSpawn?: (kill: () => void) => void }): Promise<{ code: number; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const [bin, ...pre] = agyCommand();
    let proc: ReturnType<typeof spawn>;
    try {
      // ⚠️ **셸을 안 거친다** — 인자 배열 그대로. 프롬프트는 파일로 넘겨 인자에 사람 말이 안 실린다.
      proc = spawn(bin, [...pre, ...argv], {
        stdio: ['ignore', 'ignore', 'pipe'],
        shell: false,
        windowsHide: true,
        env: withoutApiKey({
          ...process.env, ...(o.env ?? {}), PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1',
        }),
      });
    } catch (err) {
      resolve({ code: -1, stderr: String(err), timedOut: false });
      return;
    }
    let err = '';
    let timedOut = false;
    proc.stderr?.setEncoding('utf8');
    // **끝을 남긴다** — 판정의 정본(`attempts=[…]`)이 마지막 줄이다. 앞을 남기면 말 많은 차례에서 그 줄을 잃는다.
    proc.stderr?.on('data', (c: string) => { err += c; if (err.length > STDERR_KEEP) err = err.slice(-STDERR_KEEP); });
    const kill = () => {
      // 트리째 — 파이썬만 죽이면 그 아래 agy(노드)가 고아로 남는다.
      try {
        if (process.platform === 'win32' && proc.pid) execSync(`taskkill /F /T /PID ${proc.pid}`, { stdio: 'ignore' });
        else proc.kill('SIGKILL');
      } catch { /* 이미 끝났다 */ }
    };
    try { o.onSpawn?.(kill); } catch { /* 손잡이를 받는 쪽의 사고가 차례를 막지 않는다 */ }
    const timer = setTimeout(() => { timedOut = true; kill(); }, o.timeoutMs);
    proc.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, stderr: err + String(e), timedOut }); });
    proc.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? -1, stderr: err, timedOut }); });
  });
}

/** agy 한 번 — 글로 받는다(예약 일의 글 · 회의 알림 판단 · DM 칸의 계획). */
export async function agyCall(prompt: string, opts: AgyCallOpts): Promise<AgyCallResult> {
  const t0 = Date.now();
  const store = opts.store ?? engineState;
  const model = agyModel(opts.rung, opts.modelsFile);
  const done = (kind: AgyKind, text = '', detail?: string): AgyCallResult =>
    ({ kind, text, rung: opts.rung, model, ms: Date.now() - t0, ...(detail ? { detail } : {}) });
  // 엔진 연습 — 안 띄우고 막힌 모양만. 사용량 소진은 진짜처럼 엔진 상태에 적는다.
  const drill = agyDrill(opts.rung, opts.drillScope);
  if (drill === 'usage') {
    store.recordBlocked(opts.rung, { kind: 'usage', until: drillBlockUntil() });
    return done('usage', '', '연습 주입(usage)');
  }
  if (drill === 'fail') return done('fail', '', '연습 주입(fail)');

  const id = Math.random().toString(16).slice(2, 10);
  const pf = path.join(os.tmpdir(), `agy-turn-${id}.txt`);
  const of = path.join(os.tmpdir(), `agy-turn-${id}.out.txt`);
  const timeoutMs = opts.timeoutMs ?? AGY_TIMEOUT_MS[opts.rung];
  try {
    const body = opts.system ? `<system>\n${opts.system}\n</system>\n\n<user>\n${prompt}\n</user>` : prompt;
    fs.writeFileSync(pf, body, 'utf-8');
    const r = await runBackend([
      '--prompt-file', pf, '--out', of, '--model', model.alias, '--no-fallback', '--tools', 'none',
      '--timeout', String(Math.max(10, Math.floor(timeoutMs / 1000) - 5)),
    ], { timeoutMs, env: opts.env, onSpawn: opts.onSpawn });
    let out = '';
    try { out = fs.existsSync(of) ? fs.readFileSync(of, 'utf-8').trim() : ''; } catch { /* 없으면 빈 답 */ }
    const c = classifyAgy({ code: r.code, out, stderr: r.stderr, timedOut: r.timedOut });
    if (c.kind === 'ok') {
      store.recordOk(opts.rung);
      return done('ok', out);
    }
    if (c.kind === 'usage') {
      store.recordBlocked(opts.rung, { kind: c.block ?? 'usage' });
      return done('usage', '', c.detail);
    }
    return done('fail', '', c.detail);
  } catch (err) {
    logger.warn('agy 한 차례가 터졌습니다 — 물러납니다', err);
    return done('fail', '', clip(String((err as Error)?.message ?? err)));
  } finally {
    for (const f of [pf, of]) {
      try { fs.unlinkSync(f); } catch { /* 이미 없다 */ }
    }
  }
}

// ---------------------------------------------------------------- DM 칸의 계획

export interface AgyPlan {
  reply: string;
  /** 모양은 아직 안 본 명령들 — `agy-actions.ts` 의 허용 목록이 가른다. */
  actions: unknown[];
  needsFull: boolean;
  needsFullReason: string;
}

const PLAN_FENCE = /```(?:json)?\s*([\s\S]*?)```/;
/** 답 글의 상한 — 5줄 안팎을 시켰지만 넘쳐도 슬랙 한 메시지를 안 넘게. */
export const REPLY_MAX = 3000;

/**
 * 계획을 건져 낸다 — 코드펜스 · 앞뒤 한 줄은 너그럽게(모델은 시켜도 감싼다), 모양이 다르면 `null`.
 * `reply` 는 글자여야 하고 `actions` 는 배열(없으면 빈 배열) · `needs_full` 은 참거짓.
 */
export function parseAgyPlan(text: string): AgyPlan | null {
  let t = (text || '').trim();
  const f = PLAN_FENCE.exec(t);
  if (f) t = f[1].trim();
  const i = t.indexOf('{');
  const j = t.lastIndexOf('}');
  if (i < 0 || j <= i) return null;
  let o: any;
  try { o = JSON.parse(t.slice(i, j + 1)); } catch { return null; }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  if (typeof o.reply !== 'string') return null;
  const actions = o.actions === undefined || o.actions === null ? [] : o.actions;
  if (!Array.isArray(actions)) return null;
  if (o.needs_full !== undefined && o.needs_full !== null && typeof o.needs_full !== 'boolean') return null;
  const reply = o.reply.trim();
  return {
    reply: reply.length > REPLY_MAX ? `${reply.slice(0, REPLY_MAX - 1)}…` : reply,
    actions,
    needsFull: o.needs_full === true,
    needsFullReason: typeof o.needs_full_reason === 'string' ? clip(o.needs_full_reason, 200) : '',
  };
}

export interface AgyTurnResult extends AgyCallResult {
  plan: AgyPlan | null;
}

/**
 * DM 칸 한 차례 — 계획(JSON)을 받는다. 엔진은 됐는데 계획이 아니면 `fail`(다음 칸으로) · 할 말도 명령도
 * 없는 빈 계획도 `fail`.
 */
export async function agyTurn(prompt: string, opts: AgyCallOpts): Promise<AgyTurnResult> {
  const r = await agyCall(prompt, opts);
  if (r.kind !== 'ok') return { ...r, plan: null };
  const plan = parseAgyPlan(r.text);
  if (!plan) return { ...r, kind: 'fail', text: '', plan: null, detail: `계획(JSON)이 아님 — 꼬리 ${clip(r.text.slice(-120), 120)}` };
  if (!plan.reply && !plan.actions.length && !plan.needsFull) {
    return { ...r, kind: 'fail', text: '', plan: null, detail: '빈 계획' };
  }
  return { ...r, plan };
}

// ---------------------------------------------------------------- 예약 일

/**
 * 도구 없는 예약 일의 agy 칸 — `ladders.scheduled` 의 agy 칸 차례(지금 Gemini → agy 의 Claude Sonnet · 막혔으면
 * 건너뜀). 답 글을 돌려준다 · 못 하면 `null`. 부르는 쪽이 켜는 문(`agyRungsOn`)을 본다.
 */
export async function agyText(label: string, prompt: string, opts: {
  system?: string; store?: EngineState; drillScope?: DrillScope; modelsFile?: string;
} = {}): Promise<{ text: string; rung: AgyRung; model: AgyModel } | null> {
  const store = opts.store ?? engineState;
  for (const rung of agyRungOrder(opts.modelsFile)) {
    if (agyRungBlocked(rung, store)) {
      logger.info(`${label} — ${rung} 건너뜀(막힘)`);
      continue;
    }
    const r = await agyCall(prompt, { rung, system: opts.system, store, drillScope: opts.drillScope, modelsFile: opts.modelsFile });
    if (r.kind === 'ok' && r.text.trim()) return { text: r.text.trim(), rung, model: r.model };
    logger.warn(`${label} — ${rung} 못 함(${r.kind}${r.detail ? ` · ${r.detail}` : ''})`);
  }
  return null;
}
