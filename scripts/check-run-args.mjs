/**
 * 파이썬에 넘기는 인자가 온전히 도착하는가.
 *
 *   npm run build
 *   npm run check:args
 *
 * **공백이 든 값이 조용히 두 조각으로 도착한다.** 윈도우에서는 `shell: true` 로
 * 부르므로 node 가 argv 를 따옴표 없이 이어 붙이고, cmd.exe 가 그 줄을 공백에서
 * 다시 쪼갠다 — `--ts 2026-08-19 06:55` 가 `--ts 2026-08-19` + 떠도는 `06:55` 가
 * 되어 argparse 가 rc 2 로 죽는다.
 *
 * 2026-08-18 에 메일 워터마크가 이렇게 하루 종일 안 찍혔다. **에러도 안 보였다** —
 * 부르는 쪽이 `mailMark` 의 결과를 버리고 있어서, 같은 후보가 10분마다 다시 나가
 * 세션이 다섯 번 떴다.
 *
 * 여기서는 **증상이 났던 그 모양으로** 잰다 — 공백이 든 시각을 실제 `mail.py mark`
 * 에 넘겨 워터마크 파일에 그대로 들어갔는지 본다. 사용자의 진짜 워터마크를 건드리지
 * 않도록 홈 디렉터리를 임시 폴더로 돌려 놓는다.
 */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MOD = path.join(ROOT, 'dist', 'work-assistant.js');

if (!fs.existsSync(MOD)) {
  console.error('dist 가 없습니다 — 먼저 `npm run build`');
  process.exit(1);
}
const wa = require(MOD);
const root = wa.workAssistantRoot();
if (!root) {
  console.error('work-assistant 를 못 찾았습니다 — 설정의 workAssistant.root');
  process.exit(1);
}

const fails = [];
const eq = (label, got, want) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    fails.push(`${label}\n    받음 ${JSON.stringify(got)}\n    기대 ${JSON.stringify(want)}`);
  }
};

// ── ① 따옴표 규칙 자체 ────────────────────────────────────────────────────
eq('공백 없는 값은 그대로', wa.quoteForShell('--json'), '--json');
eq('공백이 있으면 감싼다', wa.quoteForShell('2026-08-19 06:55'), '"2026-08-19 06:55"');
// **공백만 보면 모자란다** — cmd.exe 는 `&` 에서도 줄을 끊는다. 「R&D회의」처럼
// 붙어 오는 값이 메일 제목에 실제로 있다.
for (const c of ['R&D회의', 'a|b', 'c>d', 'e^f', 'g(h)']) {
  eq(`셸 기호가 붙은 값도 감싼다 — ${c}`, wa.quoteForShell(c), `"${c}"`);
}
try {
  wa.quoteForShell('그는 "말했다"');
  fails.push('따옴표가 든 값은 멈춰야 한다 — 조용히 넘기면 명령줄이 깨진다');
} catch { /* 멈추는 것이 맞다 */ }

// ── ② 실물 — 공백이 든 시각이 mail.py 에 온전히 닿는가 ──────────────────
const TS = '2026-08-19 06:55';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-args-'));

/** `runTasks` 와 같은 모양으로 부른다. 홈만 임시 폴더로 돌려 놓는다. */
function run(args, { quote }) {
  const useShell = process.platform === 'win32';
  const argv = useShell && quote ? args.map(wa.quoteForShell) : args;
  return new Promise((resolve) => {
    const proc = spawn('python', ['-X', 'utf8', 'bin/mail.py', ...argv], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: useShell,
      env: { ...process.env, HOME: home, USERPROFILE: home, PYTHONIOENCODING: 'utf-8' },
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (c) => { stdout += c.toString('utf-8'); });
    proc.stderr.on('data', (c) => { stderr += c.toString('utf-8'); });
    proc.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

const seenFile = path.join(home, '.claude', 'state', 'work-mail-seen.json');
const readSeen = () => {
  try { return JSON.parse(fs.readFileSync(seenFile, 'utf-8')).ts; } catch { return null; }
};

const ok = await run(['mark', '--ts', TS], { quote: true });
eq('공백이 든 시각이 rc 0 으로 들어간다', ok.code, 0);
eq('워터마크에 시각이 통째로 적힌다', readSeen(), TS);

// **안 고친 모양도 재 본다.** 이 줄이 통과하면 위 검사는 아무것도 안 재고 있다 —
// 원래 안 깨지는 것을 「안 깨진다」고 확인하는 검사가 된다.
fs.rmSync(seenFile, { force: true });
const raw = await run(['mark', '--ts', TS], { quote: false });
if (process.platform === 'win32' && raw.code === 0) {
  fails.push('감싸지 않아도 통과한다 — 이 검사는 아무것도 재고 있지 않다');
}

fs.rmSync(home, { recursive: true, force: true });

if (fails.length) {
  console.error(`실패 ${fails.length}건\n\n  ${fails.join('\n\n  ')}`);
  process.exit(1);
}
console.log('통과 — 따옴표 규칙(공백·셸 기호·따옴표) · 공백이 든 시각이 mail.py 워터마크에 온전히 · 안 감싸면 실제로 깨짐');
