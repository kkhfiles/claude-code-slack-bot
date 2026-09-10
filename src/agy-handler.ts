/**
 * agy (Antigravity CLI) handler — **폐기됐다. 되살리기 전에 이 머리말을 다 읽을 것.**
 *
 * ⛔ **2026-09-10 로 호출을 막았다.** 아래 `runAgy` 는 곧바로 예외를 던지고, 옛 본문은
 *    이 파일 아래쪽에 주석으로 남겨 두었다(무슨 인자를 넘겼는지 보려면 그것을 읽는다 ·
 *    git 이력에도 그대로 있다).
 *
 * **왜 막았나 — 셋이 겹쳤다**
 *
 * 1. **부르던 실행체가 폐기됐다.** `agy_pty_runner.py` 는 agy 1.0 시절 ConPTY 로 콘솔
 *    출력을 훔쳐 오던 것이다. agy 1.1.25 는 표준 파이프로 정상 출력하므로 그 우회가
 *    필요 없고, PC 정본은 `~/.claude/skills/code-review/lib/agy_client.py` 하나다.
 *    정본에만 있는 것 — 모델 체인 폴백 · file-artifact 해석 · 응답 쓸모 판정.
 *    이 핸들러는 그 셋을 다 우회했다.
 * 2. **원래 사유가 없어졌다.** 「Agent SDK $100 크레딧 풀을 아끼려고 외부 정보 분석은
 *    agy 로 위임한다」였는데, 그 크레딧 정책은 2026-06-22 에 번복돼 시행되지 않았다.
 * 3. **품질 대가를 실제로 치렀다.** 2026-09-05 경쟁도구 보고서가 벤더 원문에 없는
 *    제품명을 지어냈고 그 산출물은 노션으로 발행된다. agy 가 주는 Claude 는 4.6
 *    세대뿐이라 이 경로에는 최신 모델이 아예 없다.
 *
 * **되살리려면 순서가 이렇다**
 *
 * 1. 이 핸들러를 공통 클라이언트로 옮긴다 — `agy_client.py` 를 `--prompt-file`·`--out`·
 *    `--model`·`--timeout` 인자로 부른다(옛 실행체와 인자가 호환된다).
 * 2. 지어낸 사실 문제에 답을 낸다. 발행되는 산출물이라 「빠르고 싸다」로는 안 된다.
 * 3. 그 다음에 `ANALYSIS_AGY_TYPES` 를 채운다. 지금은 비어 있어 실행 0건이다.
 *
 * ⚠️ **막아도 야간 분석은 안 죽는다** — `assistant-scheduler.runAgyAnalysis` 가
 *    try/catch 로 감싸 예외를 `errorCollector` 에 적고 넘어간다. 그래서 실수로
 *    `ANALYSIS_AGY_TYPES` 를 채우면 조용히 옛 경로로 도는 대신 **오류로 드러난다.**
 *
 * 비용 추적: agy 는 자체 quota(Pool A ~50/5h, Pool B ~25/5h)로 차감, costUsd=0.
 */

import type { Logger } from './logger';

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

/**
 * ⛔ **부르면 예외가 난다.** 위 머리말의 「되살리려면 순서가 이렇다」를 먼저 밟는다.
 *
 * 인자를 그대로 받아 두는 까닭은 부르는 쪽(`assistant-scheduler`)이 그대로 컴파일되게
 * 두려는 것이다 — 그쪽을 함께 고치는 것은 되살릴 때 할 일이다.
 */
export async function runAgy(_opts: AgyRunOptions): Promise<AgyRunResult> {
  throw new Error(
    'agy-handler 는 2026-09-10 에 막혔다 — 폐기된 agy_pty_runner.py 를 부르던 경로다. ' +
    '공통 클라이언트(~/.claude/skills/code-review/lib/agy_client.py)로 옮긴 뒤 다시 켠다. ' +
    '경위와 순서는 src/agy-handler.ts 머리말.',
  );
}

// ---------------------------------------------------------------------------
// 옛 본문 — 2026-09-10 이전까지 돌던 것. **고치지 말고 참고만 한다.**
// 되살릴 때는 아래를 되살리는 것이 아니라, 같은 인자를 공통 클라이언트에 넘기는
// 새 본문을 쓴다. `--prompt-file`·`--out`·`--add-dir`·`--timeout` 은 그대로 통한다.
// ---------------------------------------------------------------------------
//
// import { spawn } from 'child_process';
// import * as fs from 'fs';
// import * as path from 'path';
//
// const DEFAULT_TIMEOUT_S = 600;
// const DEFAULT_QUIET_S = 30;
//
// function defaultRunnerPath(): string {
//   const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
//   return path
//     .join(home, '.claude/skills/code-review/lib/agy_pty_runner.py')
//     .replace(/\\/g, '/');
// }
//
// export async function runAgy(opts: AgyRunOptions): Promise<AgyRunResult> {
//   const runnerPath = process.env.AGY_PTY_RUNNER ?? defaultRunnerPath();
//   if (!fs.existsSync(runnerPath)) {
//     throw new Error(`agy_pty_runner.py not found: ${runnerPath} — set AGY_PTY_RUNNER`);
//   }
//   if (!fs.existsSync(opts.promptPath)) {
//     throw new Error(`prompt file not found: ${opts.promptPath}`);
//   }
//
//   fs.mkdirSync(path.dirname(opts.outPath), { recursive: true });
//
//   const timeoutS = opts.timeoutSeconds ?? DEFAULT_TIMEOUT_S;
//   const quietS = opts.quietSecs ?? DEFAULT_QUIET_S;
//
//   const startTime = Date.now();
//   const args = [
//     runnerPath,
//     '--prompt-file', opts.promptPath,
//     '--out', opts.outPath,
//     '--add-dir', opts.workingDirectory,
//     '--timeout', String(timeoutS),
//     '--quiet-secs', String(quietS),
//   ];
//
//   opts.logger?.info('Spawning agy_pty_runner', {
//     runnerPath,
//     prompt: path.basename(opts.promptPath),
//     workingDirectory: opts.workingDirectory,
//   });
//
//   return new Promise<AgyRunResult>((resolve, reject) => {
//     const proc = spawn('python', args, {
//       cwd: opts.workingDirectory,
//       stdio: ['ignore', 'pipe', 'pipe'],
//       shell: process.platform === 'win32',
//       // 이것이 없으면 실행마다 콘솔 창이 화면에 번쩍인다. python 은 콘솔 프로그램이고
//       // 윈도우에서 `shell: true` 는 cmd.exe 를 거치므로, 둘 다 OS 가 창을 준다.
//       windowsHide: true,
//     });
//
//     let stdoutBuf = '';
//     let stderrBuf = '';
//     proc.stdout?.on('data', (chunk: Buffer) => { stdoutBuf += chunk.toString('utf-8'); });
//     proc.stderr?.on('data', (chunk: Buffer) => { stderrBuf += chunk.toString('utf-8'); });
//
//     // runner 자체 timeout 이 1차 방어, 외부 SIGKILL 은 2차 (+60s margin)
//     const killTimer = setTimeout(() => {
//       try { proc.kill('SIGKILL'); } catch {}
//     }, (timeoutS + 60) * 1000);
//
//     proc.on('error', (err) => {
//       clearTimeout(killTimer);
//       reject(err);
//     });
//
//     proc.on('close', (code) => {
//       clearTimeout(killTimer);
//       const durationMs = Date.now() - startTime;
//       const timedOut = durationMs >= timeoutS * 1000;
//
//       let rawText = stdoutBuf;
//       try {
//         if (fs.existsSync(opts.outPath)) {
//           rawText = fs.readFileSync(opts.outPath, 'utf-8');
//         }
//       } catch {}
//
//       const generatedFiles = findGeneratedReports(opts.workingDirectory, startTime);
//
//       if (code !== 0 || stderrBuf.length > 0) {
//         opts.logger?.warn('agy run anomaly', {
//           exitCode: code,
//           stderrPreview: stderrBuf.substring(0, 300),
//         });
//       }
//
//       resolve({
//         exitCode: code ?? -1,
//         durationMs,
//         rawText,
//         generatedFiles,
//         timedOut,
//         stderr: stderrBuf,
//       });
//     });
//   });
// }
//
// /** workspace/reports/<...> 아래 .md 중 sinceMs 이후 mtime (archived 제외). */
// function findGeneratedReports(workspace: string, sinceMs: number): string[] {
//   const reportsDir = path.join(workspace, 'reports');
//   if (!fs.existsSync(reportsDir)) return [];
//   const found: string[] = [];
//
//   const walk = (dir: string) => {
//     let entries: fs.Dirent[];
//     try {
//       entries = fs.readdirSync(dir, { withFileTypes: true });
//     } catch {
//       return;
//     }
//     for (const entry of entries) {
//       if (entry.name === 'archived') continue;
//       const full = path.join(dir, entry.name);
//       if (entry.isDirectory()) {
//         walk(full);
//       } else if (entry.name.endsWith('.md') && entry.name !== '.gitkeep') {
//         try {
//           const stat = fs.statSync(full);
//           if (stat.mtimeMs >= sinceMs) found.push(full);
//         } catch {}
//       }
//     }
//   };
//   walk(reportsDir);
//   return found;
// }
