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

const logger = new Logger('ModelLadder');

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
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8', CLAUDE_SCHEDULED: '1' },
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
 */
export async function ladderText(
  label: string,
  prompt: string,
  opts: { model: string; system?: string; vendors?: string[]; timeoutMs?: number },
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
      '--vendors', (opts.vendors ?? ['codex', 'agy']).join(','),
      // 칸 하나의 제한 — 두 칸이 다 돌아도 전체 예산 안에 들게
      '--timeout', String(Math.max(60, Math.floor(budget / 1000 / 2)))];
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
