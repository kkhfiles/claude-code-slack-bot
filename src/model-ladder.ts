/**
 * 등급 사다리 — llm-playbook 의 모델 표와 사다리를 봇에서 쓰는 곳 하나.
 *
 * **모델 표는 이 저장소에 다시 적지 않는다.** 어느 Claude 모델이 어느 등급이고, 그 등급의 codex·agy
 * 모델이 무엇인지는 llm-playbook(`models.json` + 사용자 설정)이 정본이다. 봇은
 * `python -m llm_playbook.ladder --show --json` 으로 합쳐진 표를 받아 쓰기만 한다 — 여기 모델 이름을
 * 적으면 판올림 때 이쪽만 낡는다. 실제로 그랬다(2026-09-23 점검): 예약 세션의 codex 폴백이 1차 등급과
 * 무관하게 늘 같은 모델로 갔다.
 *
 * 주는 것:
 * - `sameTier(Claude 모델, 백엔드)` — 도구를 쓰는 세션의 codex 폴백이 같은 등급 모델로 가게.
 * - `ladderText(…)` — 도구 없이 글만 주고받는 회차를 사다리(읽기 전용 codex → agy, 같은 등급)로.
 * - `ladderEventLines(…)` — 폴백 기록 파일(사용자 설정 `event_log`)에서 최근 폴백을 아침 브리핑용 줄로.
 *
 * 파이썬이나 패키지가 없으면 조용히 옛 동작(기본 codex 모델 · 사다리 없음)으로 물러난다 — 대신 한 번은
 * 경고를 남긴다. 파이썬 경로는 `LADDER_PYTHON`(기본 `python`).
 */
import { spawn, execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Logger } from './logger';
import { withoutApiKey } from './child-env';
import { modelsFile } from './engine-notice';
import type { Engine } from './engine-state';
import { DM_LADDER_AGY } from './engine-ladder';

const logger = new Logger('ModelLadder');

// ---------------------------------------------------------------- 서비스 폴백 대응표

/**
 * 서비스(스탠리 · Dispatch 판)의 폴백 모델 — `models.json` 의 `service_fallback`(2026-10-14 사용자 결정).
 * `tiers` 와 별개다. **정본은 사용자가 정한 대응표** — 1차 Claude 의 모델과 사고 깊이마다 GPT 「별칭-깊이」
 * 한 칸(예: opus medium → sol-high · haiku xhigh → sol-low). 1차 깊이를 모르면 high 줄(Claude 기본 깊이).
 * 옛 모양(모델마다 별칭 하나 + `effort_up`)도 읽는다. `after_agy` 칸은 부서 대화 봇 몫이라 여기서 안 읽는다.
 *
 * 표에 그 칸이 없거나 못 읽으면 `null` — 부르는 쪽이 옛 길(`sameTier` · 기본 모델)로 물러난다(한 번 WARN).
 * 파일이 바뀌었을 때만 다시 읽는다(고친 시각으로 견줌).
 */
export interface ServiceTable {
  /** 모델마다 별칭 하나(옛 모양) 또는 깊이마다 「별칭-깊이」. */
  codex: Record<string, string | Record<string, string>>;
  agy: string[];
  codexIds: Record<string, string>;
  /** 별칭마다 받는 깊이 — 낮은 것부터. */
  codexEfforts: Record<string, string[]>;
  /** 별칭마다 1차 깊이를 몇 단계 올리나. */
  effortUp: Record<string, number>;
  claudeAliases: Record<string, string>;
  /** 이름 붙은 사다리의 칸 목록(`ladders.<이름>.rungs` · 「백엔드[:별칭]」) — 목록으로 적힌 것만. */
  ladders: Record<string, string[]>;
  /** agy 별칭 → 표시 이름(`agy.models`) — 사다리 칸을 엔진 열쇠로 가를 때 쓴다. */
  agyLabels: Record<string, string>;
}

let serviceCache: { file: string; mtimeMs: number; table: ServiceTable | null } | null = null;
let serviceWarned = false;

export function serviceFallbackTable(file: string = modelsFile()): ServiceTable | null {
  let mtimeMs = -1;
  try { mtimeMs = fs.statSync(file).mtimeMs; } catch { /* 없다 */ }
  if (serviceCache && serviceCache.file === file && serviceCache.mtimeMs === mtimeMs) return serviceCache.table;
  let table: ServiceTable | null = null;
  try {
    const t = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const sf = t?.service_fallback;
    if (sf && typeof sf.codex === 'object' && sf.codex) {
      const codexIds: Record<string, string> = {};
      const codexEfforts: Record<string, string[]> = {};
      for (const [k, v] of Object.entries(t?.codex?.models ?? {})) {
        if (typeof (v as any)?.id === 'string') codexIds[k] = (v as any).id;
        if (Array.isArray((v as any)?.efforts)) codexEfforts[k] = (v as any).efforts.filter((x: unknown) => typeof x === 'string');
      }
      const effortUp: Record<string, number> = {};
      for (const [k, v] of Object.entries(sf.effort_up ?? {})) {
        if (Number.isInteger(v) && (v as number) > 0) effortUp[k] = v as number;
      }
      table = {
        codex: Object.fromEntries(Object.entries(sf.codex).filter(([k, v]) => !k.startsWith('_')
          && (typeof v === 'string' || (!!v && typeof v === 'object' && !Array.isArray(v))))) as ServiceTable['codex'],
        agy: Array.isArray(sf.agy) ? sf.agy.filter((x: unknown) => typeof x === 'string') : [],
        codexIds,
        codexEfforts,
        effortUp,
        claudeAliases: (t?.claude?.aliases ?? {}) as Record<string, string>,
        ladders: Object.fromEntries(Object.entries(t?.ladders ?? {})
          .filter(([k, v]) => !k.startsWith('_') && Array.isArray((v as any)?.rungs)
            && (v as any).rungs.every((x: unknown) => typeof x === 'string'))
          .map(([k, v]) => [k, [...(v as any).rungs]])),
        agyLabels: Object.fromEntries(Object.entries(t?.agy?.models ?? {})
          .filter(([, v]) => typeof v === 'string')) as Record<string, string>,
      };
    }
  } catch {
    table = null;
  }
  if (!table && !serviceWarned) {
    serviceWarned = true;
    logger.warn('모델 표에 service_fallback 이 없어 옛 대응(같은 등급 · 기본 codex 모델)으로 폴백합니다');
  }
  serviceCache = { file, mtimeMs, table };
  return table;
}

// ---------------------------------------------------------------- 이름 붙은 사다리

/** 봇이 읽는 사다리 — DM(`dm`) · 예약 일(`scheduled`). 칸 순서의 정본은 `models.json` 의 `ladders`(2026-10-19). */
export type ServiceLadderName = 'dm' | 'scheduled';

/**
 * 표를 못 읽을 때의 칸 — 2026-10-19 까지 봇에 박혀 있던 순서 그대로(Claude → GPT → agy Gemini → agy Claude).
 * **이 값으로 도는 동안은 표를 고쳐도 안 따라온다** — 그래서 까닭마다 한 번 WARN.
 */
export const LADDER_DEFAULT: Readonly<Record<ServiceLadderName, readonly Engine[]>> = {
  dm: DM_LADDER_AGY,
  scheduled: DM_LADDER_AGY,
};

const ladderWarned = new Set<string>();

/**
 * 칸 하나(「백엔드[:별칭]」) → 엔진 열쇠. agy 는 별칭의 표시 이름으로 쿼터 풀을 가른다(파이썬 `agy.model_pool` 과
 * 같은 기준 — 「Claude …」 · Argon 이 아닌 「Gemini …」). 봇이 못 맡는 칸(Argon · 모르는 별칭)이면 undefined.
 */
export function rungEngine(spec: string, agyLabels: Record<string, string>): Engine | undefined {
  const i = spec.indexOf(':');
  const backend = i < 0 ? spec : spec.slice(0, i);
  const alias = i < 0 ? '' : spec.slice(i + 1);
  if (backend === 'claude' || backend === 'codex') return backend;
  if (backend !== 'agy' || !alias) return undefined;
  const label = (agyLabels[alias] ?? '').toLowerCase();
  if (label.startsWith('claude ')) return 'agy-claude';
  if (label.startsWith('gemini ') && !label.includes('argon')) return 'agy-gemini';
  return undefined;
}

/**
 * 사다리의 엔진 차례 — `models.json` 의 `ladders.<이름>.rungs` 를 엔진 열쇠로. **부를 때마다 본다**(파일이 바뀌었을
 * 때만 다시 읽음) — 칸을 빼면 다음 차례부터 따라온다.
 *
 * 표를 못 읽거나 · 그 사다리가 없거나 · 첫 칸이 Claude 가 아니거나 · 모르는 칸 · 겹친 칸이 있으면 `LADDER_DEFAULT`
 * (WARN 한 번) — **DM 을 멈추지 않는다.** 첫 칸이 Claude 여야 하는 까닭은 고르는 함수(`engine-ladder.ts`)가 Claude
 * 다음 칸부터 찾기 때문이다(세션 · 모아 둔 차례가 Claude 에 묶여 있다).
 */
export function serviceLadder(name: ServiceLadderName, file: string = modelsFile()): readonly Engine[] {
  const t = serviceFallbackTable(file);
  const rungs = t?.ladders[name];
  let why = '';
  const out: Engine[] = [];
  if (!t) why = '표를 못 읽음';
  else if (!rungs || !rungs.length) why = `ladders.${name} 가 없음`;
  else {
    for (const r of rungs) {
      const e = rungEngine(r, t.agyLabels);
      if (!e) { why = `모르는 칸 ${r}`; break; }
      if (out.includes(e)) { why = `겹친 칸 ${r}`; break; }
      out.push(e);
    }
    if (!why && out[0] !== 'claude') why = '첫 칸이 Claude 가 아님';
  }
  if (!why) return out;
  const key = `${file}|${name}|${why}`;
  if (!ladderWarned.has(key)) {
    ladderWarned.add(key);
    logger.warn(`사다리 ${name} 을 표에서 못 읽어(${why}) 기본 차례로 돕니다 — ${LADDER_DEFAULT[name].join(' → ')}`);
  }
  return LADDER_DEFAULT[name];
}

/** Claude 모델 이름(별칭 · id · `[1m]` 꼬리)이 표의 어느 칸인가 — opus · sonnet · haiku. 모르면 undefined. */
export function claudeFamily(name: string | undefined, t: ServiceTable): string | undefined {
  if (!name) return undefined;
  const n = name.toLowerCase().replace(/\[.*\]$/, '');
  for (const key of Object.keys(t.codex)) {
    const id = (t.claudeAliases[key] ?? '').toLowerCase();
    if (n === key || (id && (n === id || n.startsWith(id))) || n.includes(key)) return key;
  }
  return undefined;
}

/**
 * 이 Claude 모델이 막혔을 때 쓸 codex 모델 — 별칭 · 실제 id · 깊이. 표가 없거나 모르는 모델이면 `null`.
 * 대응표 모양이면 1차 깊이(`effort` · 없으면 high)의 칸을 그대로. 옛 모양이면 1차 깊이를 `effort_up` 만큼 올린다.
 */
export function serviceCodex(claudeModel: string | undefined, effort?: string, file?: string):
  { alias: string; model: string; effort?: string } | null {
  const t = serviceFallbackTable(file);
  if (!t) return null;
  const fam = claudeFamily(claudeModel, t);
  const cell = fam ? t.codex[fam] : undefined;
  if (cell && typeof cell === 'object') {
    const spec = cell[effort && cell[effort] ? effort : PRIMARY_DEFAULT_EFFORT];
    const hit = typeof spec === 'string' ? splitCodexSpec(spec, t) : null;
    return hit ? { alias: hit.alias, model: t.codexIds[hit.alias], ...(hit.effort ? { effort: hit.effort } : {}) } : null;
  }
  const alias = typeof cell === 'string' ? cell : undefined;
  const model = alias ? t.codexIds[alias] : undefined;
  if (!alias || !model) return null;
  return { alias, model, ...(effort ? { effort: raiseEffort(effort, t.effortUp[alias] ?? 0, t.codexEfforts[alias] ?? []) } : {}) };
}

/** 1차 깊이를 모를 때 쓰는 대응표 줄 — Claude 의 기본 사고 깊이. */
export const PRIMARY_DEFAULT_EFFORT = 'high';

/** 「sol-high」 → 별칭 sol · 깊이 high. 별칭은 `codex.models` 에 있는 것 중 가장 긴 앞머리 · 없으면 null. */
export function splitCodexSpec(spec: string, t: Pick<ServiceTable, 'codexIds'>): { alias: string; effort?: string } | null {
  const alias = Object.keys(t.codexIds).filter((k) => spec === k || spec.startsWith(`${k}-`))
    .sort((a, b) => b.length - a.length)[0];
  if (!alias) return null;
  const effort = spec.slice(alias.length + 1);
  return effort ? { alias, effort } : { alias };
}

/** 깊이를 목록을 따라 `up` 단계 올린다 — 끝(max)에서 멈춤 · 목록에 없는 깊이는 그대로. */
export function raiseEffort(effort: string, up: number, efforts: readonly string[]): string {
  const i = efforts.indexOf(effort);
  if (i < 0 || up <= 0) return effort;
  return efforts[Math.min(efforts.length - 1, i + up)];
}

export interface LadderCell {
  backend: string;
  alias: string;
  model: string;
  available: boolean;
  effort?: string | null;
}

interface LadderTable {
  order: string[];
  tiers: Record<string, LadderCell[]>;
  event_log: string | null;
}

/** 표를 못 읽었을 때 다시 해 보기까지. 파이썬이 잠깐 넘어진 것 때문에 봇이 끝까지 옛 동작으로 돌지 않게. */
const RETRY_MS = 10 * 60_000;
let cached: { at: number; table: LadderTable | null } | null = null;

function runLadder(args: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(process.env.LADDER_PYTHON || 'python', ['-X', 'utf8', '-m', 'llm_playbook.ladder', ...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        // 사다리의 claude 칸은 Claude Code 를 띄운다 — 키가 넘어가면 구독 대신 그 키로 과금된다.
        env: withoutApiKey({ ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8', CLAUDE_SCHEDULED: '1' }),
      });
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: String(err) });
      return;
    }
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (c: Buffer) => { stdout += c.toString('utf-8'); });
    proc.stderr?.on('data', (c: Buffer) => { stderr += c.toString('utf-8'); });
    const killTimer = setTimeout(() => {
      // 자식(codex·agy)까지 트리째 — 파이썬만 죽이면 모델 프로세스가 고아로 남는다.
      try {
        if (process.platform === 'win32' && proc.pid) execSync(`taskkill /F /T /PID ${proc.pid}`, { stdio: 'ignore' });
        else proc.kill('SIGKILL');
      } catch { /* 이미 끝났다 */ }
    }, timeoutMs);
    proc.on('error', (err) => { clearTimeout(killTimer); resolve({ code: -1, stdout, stderr: stderr + String(err) }); });
    proc.on('close', (code) => { clearTimeout(killTimer); resolve({ code: code ?? -1, stdout, stderr }); });
  });
}

/** 합쳐진 표. 못 읽으면 null(RETRY_MS 뒤 다시 해 본다). */
export async function ladderTable(): Promise<LadderTable | null> {
  if (cached && (cached.table || Date.now() - cached.at < RETRY_MS)) return cached.table;
  const r = await runLadder(['--show', '--json'], 60_000);
  let table: LadderTable | null = null;
  if (r.code === 0) {
    try { table = JSON.parse(r.stdout) as LadderTable; } catch { table = null; }
  }
  if (!table) {
    logger.warn(`등급 사다리 표를 못 읽었습니다 — codex 폴백은 기본 모델로, 사다리는 건너뜀 (rc ${r.code}: ${r.stderr.trim().slice(-200)})`);
  }
  cached = { at: Date.now(), table };
  return table;
}

/** Claude 모델(별칭·ID)과 같은 등급의 `backend` 칸. 모르면 undefined. */
export async function sameTier(claudeModel: string | undefined, backend: string): Promise<LadderCell | undefined> {
  if (!claudeModel) return undefined;
  const t = await ladderTable();
  if (!t) return undefined;
  for (const cells of Object.values(t.tiers)) {
    if (cells.some((c) => c.backend === 'claude' && (c.alias === claudeModel || c.model === claudeModel))) {
      return cells.find((c) => c.backend === backend);
    }
  }
  return undefined;
}

/**
 * 도구 없이 글만 주고받는 회차를 사다리로 — `model` 은 1차가 쓰던 Claude 모델(그 등급을 탄다).
 * 기본은 Claude 를 빼고(1차가 방금 실패했다) codex(읽기 전용) → agy. 못 하면 null.
 *
 * **codex 칸은 서비스 폴백 대응표를 따른다**(`service_fallback` · 2026-10-14) — 1차 등급이 아니라 표의 codex
 * 모델(예: opus → sol)로 먼저 한 번 부르고(`--tier <별칭>` · 깊이는 `effort` = 1차의 것), 못 하면 남은 칸(agy)을
 * 예전처럼 1차 등급으로. 표가 없으면 예전 그대로 한 번에.
 */
export async function ladderText(
  label: string,
  prompt: string,
  opts: { model: string; system?: string; vendors?: string[]; timeoutMs?: number; effort?: string },
): Promise<{ text: string; backend: string; model: string } | null> {
  const vendors = opts.vendors ?? ['codex', 'agy'];
  const svc = vendors.includes('codex') ? serviceCodex(opts.model, opts.effort) : null;
  if (svc) {
    const got = await ladderOnce(label, prompt, { ...opts, model: svc.alias, vendors: ['codex'], effort: svc.effort ?? opts.effort });
    if (got) return got;
    const rest = vendors.filter((v) => v !== 'codex');
    return rest.length ? ladderOnce(label, prompt, { ...opts, vendors: rest, effort: undefined }) : null;
  }
  return ladderOnce(label, prompt, { ...opts, vendors });
}

async function ladderOnce(
  label: string,
  prompt: string,
  opts: { model: string; system?: string; vendors: string[]; timeoutMs?: number; effort?: string },
): Promise<{ text: string; backend: string; model: string } | null> {
  const id = Math.random().toString(16).slice(2, 10);
  const dir = os.tmpdir();
  const pf = path.join(dir, `ladder-${id}.txt`);
  const sf = path.join(dir, `ladder-${id}.sys.txt`);
  const of = path.join(dir, `ladder-${id}.out.txt`);
  const budget = opts.timeoutMs ?? 600_000;
  try {
    fs.writeFileSync(pf, prompt, 'utf-8');
    const args = ['--tier', opts.model, '--prompt-file', pf, '--out', of, '--label', label,
      '--vendors', opts.vendors.join(','),
      // 칸 하나의 제한 — 두 칸이 다 돌아도 전체 예산 안에 들게
      '--timeout', String(Math.max(60, Math.floor(budget / 1000 / 2))),
      ...(opts.effort ? ['--effort', opts.effort] : [])];
    if (opts.system) {
      fs.writeFileSync(sf, opts.system, 'utf-8');
      args.push('--system-file', sf);
    }
    const r = await runLadder(args, budget + 30_000);
    const last = r.stdout.trim().split('\n').pop() || '';
    let summary: { backend?: string; model?: string; attempts?: { backend: string; why: string }[] } = {};
    try { summary = JSON.parse(last); } catch { /* 요약이 없으면 아래에서 실패로 */ }
    if (r.code === 0 && fs.existsSync(of)) {
      const text = fs.readFileSync(of, 'utf-8').trim();
      if (text) return { text, backend: summary.backend || '?', model: summary.model || '?' };
    }
    const whys = (summary.attempts || []).map((a) => `${a.backend}: ${a.why}`).join(' | ');
    logger.warn(`${label} 사다리도 못 했습니다 (rc ${r.code}) ${whys || r.stderr.trim().slice(-200)}`);
    return null;
  } catch (err) {
    logger.warn(`${label} 사다리를 못 불렀습니다`, err);
    return null;
  } finally {
    for (const f of [pf, sf, of]) {
      try { fs.unlinkSync(f); } catch { /* 없다 */ }
    }
  }
}

/**
 * 폴백 기록 파일에서 최근 `hours` 시간의 폴백을 라벨별 한 줄로 — 아침 브리핑 「시스템 이슈」에 싣는다.
 * 표를 아직 못 읽었거나 기록 파일이 없으면 빈 목록(판단 불가면 침묵).
 */
export function ladderEventLines(hours = 24, now = Date.now(), file = cached?.table?.event_log): string[] {
  if (!file || !fs.existsSync(file)) return [];
  const since = now - hours * 3_600_000;
  const byLabel = new Map<string, { n: number; failed: number; served: Map<string, number> }>();
  for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    let ev: { ts?: string; label?: string; ok?: boolean; served_by?: string | null; model?: string | null };
    try { ev = JSON.parse(line); } catch { continue; }
    const at = Date.parse(ev.ts || '');
    if (!Number.isFinite(at) || at < since || ev.label === 'probe') continue;
    const key = ev.label || '(이름 없음)';
    const g = byLabel.get(key) || { n: 0, failed: 0, served: new Map<string, number>() };
    g.n += 1;
    if (!ev.ok) g.failed += 1;
    else if (ev.served_by) {
      const who = `${ev.served_by}${ev.model ? ` ${ev.model}` : ''}`;
      g.served.set(who, (g.served.get(who) || 0) + 1);
    }
    byLabel.set(key, g);
  }
  return [...byLabel.entries()].map(([label, g]) => {
    const parts = [...g.served.entries()].map(([who, n]) => `${who} ${n}`);
    if (g.failed) parts.push(`전부 실패 ${g.failed}`);
    return `${label} ${g.n}건(${parts.join(' · ')})`;
  });
}
