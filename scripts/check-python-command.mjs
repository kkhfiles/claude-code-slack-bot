import './lib/fresh-dist.mjs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wp = require(path.join(ROOT, 'dist', 'python-command.js'));

const fails = [];
const eq = (label, got, want) => {
  if (got !== want) {
    fails.push(`${label}: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  }
};

if (process.platform === 'win32') {
  // pythonw 로 바꾸지 않는다 — 콘솔 없는 pythonw 아래의 git, codex 가 새 창을 띄운다(2026-10-23 실측, src/python-command.ts).
  eq('defaults to python', wp.pythonCommand(), 'python');
  eq('empty string stays empty', wp.pythonCommand(''), '');
  eq('whitespace-only stays empty', wp.pythonCommand('   '), '');
  eq('python stays python', wp.pythonCommand('python'), 'python');
  eq('quoted python loses quotes', wp.pythonCommand('"python"'), 'python');
  eq('single-quoted python.exe loses quotes', wp.pythonCommand("'python.exe'"), 'python.exe');
  eq('quoted venv python.exe loses quotes only',
    wp.pythonCommand('"C:\\work\\app\\.venv\\Scripts\\python.exe"'),
    'C:\\work\\app\\.venv\\Scripts\\python.exe');
  for (const v of ['python', 'python.exe', 'python3', 'PYTHON.EXE',
    'C:\\work\\app\\.venv\\Scripts\\python.exe',
    'C:\\Tools\\Python\\python.exe']) {
    eq(`never pythonw — ${v}`, /pythonw/i.test(wp.pythonCommand(v)), false);
  }
  eq('nonexistent path falls back to unquoted original',
    wp.pythonCommand('"C:\\nonexistent\\dir\\python.exe"'),
    'C:\\nonexistent\\dir\\python.exe');
} else {
  eq('non-win32 preserves pythonBin', wp.pythonCommand('python'), 'python');
}

if (fails.length) {
  console.error(`실패 ${fails.length}건:\n  ${fails.join('\n  ')}`);
  process.exit(1);
}

console.log('통과 — pythonCommand (따옴표만 벗기고 pythonw 로 안 바꿈)');
