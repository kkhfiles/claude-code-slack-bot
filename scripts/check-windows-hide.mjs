// 봇이 프로그램을 띄우는 곳마다 `windowsHide: true` 가 있나 — 빠지면 사용자 화면에 터미널 창이 떴다 사라진다.
//
// 봇 프로세스에는 콘솔이 없어서 콘솔 프로그램(python, git, cmd, powershell)을 띄울 때마다 윈도우가 새 콘솔을
// 만들어 준다. `windowsHide: true` 가 그 콘솔을 숨긴다. 같은 함정에 세 번 걸려서(2026-10-23 확인) 글이 아니라
// 이 검사로 옮겼다.
//   - tasks.py 가 배포를 DETACHED_PROCESS 로 띄워 쓰기마다 창이 깜빡임(work-assistant `bin/publish_board.py` 머리말)
//   - `exec('python …')` 이 숨김 없이 돌던 다우 확인과 메모리 감시
//   - python 을 콘솔 없는 pythonw 로 바꿔 그 아래 git, codex 가 창을 받음(`src/python-command.ts`)
//
// 보는 것: `src/*.ts` 의 spawn, spawnSync, exec, execSync, execFile, execFileSync 와 그 promisify 이름(…Async) 호출.
// 호출 괄호 안에 `windowsHide` 글자가 있어야 통과한다 — 옵션 객체를 변수로만 넘기면 걸리므로 그 자리에 적는다.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function missingHide(text) {
  const out = [];
  const call = /\b(spawn|spawnSync|exec|execSync|execFile|execFileSync|execAsync|execFileAsync)\s*\(/g;
  const lines = text.split('\n');
  let m;
  while ((m = call.exec(text))) {
    if (text[m.index - 1] === '.') continue;          // 정규식의 .exec(…)
    const lineNo = text.slice(0, m.index).split('\n').length;
    const line = lines[lineNo - 1].trim();
    if (line.startsWith('//') || line.startsWith('*')) continue;
    if (/\bfunction\s+\w+\s*\($/.test(text.slice(Math.max(0, m.index - 20), m.index + m[0].length))) continue;
    let depth = 0;
    let i = m.index + m[0].length - 1;
    for (; i < text.length; i += 1) {
      if (text[i] === '(') depth += 1;
      else if (text[i] === ')') { depth -= 1; if (depth === 0) break; }
    }
    const body = text.slice(m.index, i + 1);
    if (!/windowsHide/.test(body)) out.push({ line: lineNo, text: line.slice(0, 110) });
  }
  return out;
}

const fails = [];
// 검사 자체가 잡는지 — 숨김이 있는 호출은 통과, 없는 호출은 걸림
const self = [
  ["spawn('git', ['status'], { windowsHide: true })", 0],
  ["spawn('git', ['status'], { cwd })", 1],
  ["const r = /a/.exec(s);", 0],
  ["execSync(`taskkill /F /T /PID ${p}`, { stdio: 'ignore' })", 1],
  ["await execFileAsync(py, argv, {\n  cwd, windowsHide: true,\n})", 0],
];
for (const [code, want] of self) {
  const got = missingHide(code).length;
  if (got !== want) fails.push(`검사 자체: ${JSON.stringify(code)} — 걸림 ${got}건, 기대 ${want}건`);
}

const src = path.join(ROOT, 'src');
for (const name of fs.readdirSync(src).filter((n) => n.endsWith('.ts')).sort()) {
  for (const hit of missingHide(fs.readFileSync(path.join(src, name), 'utf-8'))) {
    fails.push(`src/${name}:${hit.line} — windowsHide 없음: ${hit.text}`);
  }
}

if (fails.length) {
  console.error(`실패 ${fails.length}건 — 프로그램을 띄우는 곳에 windowsHide: true 를 넣으십시오:\n  ${fails.join('\n  ')}`);
  process.exit(1);
}
console.log('통과 — src 의 프로그램 띄우는 곳이 모두 windowsHide: true');
