/**
 * agy (Antigravity CLI) handler — Gemini Flash 등 외부 모델로 외부 정보 수집 분석 위임.
 *
 * 2026-06-15 정책 이후 Max 5x 플랜 Agent SDK 호출이 별도 $100 크레딧 풀로 분리.
 * ai-practice·competitors 같이 컨텍스트가 외부 정보(WebSearch)인 분석은
 * agy로 위임해 크레딧 풀을 보존.
 *
 * 호출 경로:
 *   spawn('python', [agy_pty_runner.py, --prompt-file, --out, --add-dir, ...])
 *   agy_pty_runner.py는 ConPTY pseudo-tty로 agy 띄워 출력을 캡처
 *   (agy 1.0+는 WriteConsoleW로 콘솔에 직접 쓰므로 PIPE 캡처 불가)
 *
 * runner 위치: claude-workflow skill (code-review/lib/agy_pty_runner.py).
 * env override: AGY_PTY_RUNNER.
 *
 * 비용 추적: agy는 자체 quota(Pool A ~50/5h, Pool B ~25/5h)로 차감, costUsd=0.
 * .assistant-costs.json 우회 — quota 모니터링은 별도(agy 인터랙티브 `/usage`).
 */
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from './logger';

export interface AgyRunOptions {
  promptPath: string;        // analysis-*.md 절대 경로
  workingDirectory: string;  // --add-dir 로 노출. agy 가 read·write
  outPath: string;           // raw agy 응답 저장
  timeoutSeconds?: number;   // 전체 한계 (default 600)
  quietSecs?: number;        // 무출력 종료 (default 30)
  logger?: Logger;
}

export interface AgyRunResult {
  exitCode: number;
  durationMs: number;
  rawText: string;           // 캡처된 응답 (post-processed)
  generatedFiles: string[];  // workspace/reports/ 중 호출 후 mtime 신규/갱신된 .md
  timedOut: boolean;
  stderr: string;
}

const DEFAULT_TIMEOUT_S = 600;
const DEFAULT_QUIET_S = 30;

function defaultRunnerPath(): string {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
  return path
    .join(home, '.claude/skills/code-review/lib/agy_pty_runner.py')
    .replace(/\\/g, '/');
}

export async function runAgy(opts: AgyRunOptions): Promise<AgyRunResult> {
  const runnerPath = process.env.AGY_PTY_RUNNER ?? defaultRunnerPath();
  if (!fs.existsSync(runnerPath)) {
    throw new Error(`agy_pty_runner.py not found: ${runnerPath} — set AGY_PTY_RUNNER`);
  }
  if (!fs.existsSync(opts.promptPath)) {
    throw new Error(`prompt file not found: ${opts.promptPath}`);
  }

  fs.mkdirSync(path.dirname(opts.outPath), { recursive: true });

  const timeoutS = opts.timeoutSeconds ?? DEFAULT_TIMEOUT_S;
  const quietS = opts.quietSecs ?? DEFAULT_QUIET_S;

  const startTime = Date.now();
  const args = [
    runnerPath,
    '--prompt-file', opts.promptPath,
    '--out', opts.outPath,
    '--add-dir', opts.workingDirectory,
    '--timeout', String(timeoutS),
    '--quiet-secs', String(quietS),
  ];

  opts.logger?.info('Spawning agy_pty_runner', {
    runnerPath,
    prompt: path.basename(opts.promptPath),
    workingDirectory: opts.workingDirectory,
  });

  return new Promise<AgyRunResult>((resolve, reject) => {
    const proc = spawn('python', args, {
      cwd: opts.workingDirectory,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });

    let stdoutBuf = '';
    let stderrBuf = '';
    proc.stdout?.on('data', (chunk: Buffer) => { stdoutBuf += chunk.toString('utf-8'); });
    proc.stderr?.on('data', (chunk: Buffer) => { stderrBuf += chunk.toString('utf-8'); });

    // runner 자체 timeout이 1차 방어, 외부 SIGKILL은 2차 (+60s margin)
    const killTimer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch {}
    }, (timeoutS + 60) * 1000);

    proc.on('error', (err) => {
      clearTimeout(killTimer);
      reject(err);
    });

    proc.on('close', (code) => {
      clearTimeout(killTimer);
      const durationMs = Date.now() - startTime;
      const timedOut = durationMs >= timeoutS * 1000;

      let rawText = stdoutBuf;
      try {
        if (fs.existsSync(opts.outPath)) {
          rawText = fs.readFileSync(opts.outPath, 'utf-8');
        }
      } catch {}

      const generatedFiles = findGeneratedReports(opts.workingDirectory, startTime);

      if (code !== 0 || stderrBuf.length > 0) {
        opts.logger?.warn('agy run anomaly', {
          exitCode: code,
          stderrPreview: stderrBuf.substring(0, 300),
        });
      }

      resolve({
        exitCode: code ?? -1,
        durationMs,
        rawText,
        generatedFiles,
        timedOut,
        stderr: stderrBuf,
      });
    });
  });
}

/** workspace/reports/<...>/*.md 중 sinceMs 이후 mtime (archived 제외). */
function findGeneratedReports(workspace: string, sinceMs: number): string[] {
  const reportsDir = path.join(workspace, 'reports');
  if (!fs.existsSync(reportsDir)) return [];
  const found: string[] = [];

  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === 'archived') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.md') && entry.name !== '.gitkeep') {
        try {
          const stat = fs.statSync(full);
          if (stat.mtimeMs >= sinceMs) found.push(full);
        } catch {}
      }
    }
  };
  walk(reportsDir);
  return found;
}
