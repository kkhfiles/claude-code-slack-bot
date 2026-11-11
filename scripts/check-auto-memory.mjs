/**
 * 세나 세션만 Claude 자동 메모리를 끄는지 잰다(2026-11-11 실장님 「쓸데없는 건 막도록」).
 *
 *   node scripts/check-auto-memory.mjs
 *
 * 왜 재나 — 끄는 대상이 넓으면 다른 폴더에서 일하는 세션이 실장님 피드백 메모리를 못 읽고, 좁으면 세나가 다시 메모리에 쓴다.
 * 둘 다 오류 없이 조용히 틀린다.
 */
import './lib/fresh-dist.mjs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { withoutAutoMemory } = require(path.join(ROOT, 'dist', 'child-env.js'));

let pass = 0;
const fails = [];
const check = (name, ok, got) => {
  if (ok) { pass++; console.log(`PASS ${name}`); return; }
  fails.push(name);
  console.log(`FAIL ${name} — 받음 ${JSON.stringify(got)}`);
};
const WA = 'P:/github/work-assistant';
const base = { PATH: 'x' };
const off = (env) => env.CLAUDE_CODE_DISABLE_AUTO_MEMORY === '1';

check('업무 비서 폴더 세션은 끈다', off(withoutAutoMemory(base, WA, WA)));
check('경로 모양이 달라도 같은 폴더면 끈다(역슬래시, 끝 빗금, 대소문자)',
  off(withoutAutoMemory(base, 'p:\\github\\work-assistant\\', WA)));
check('다른 폴더 세션은 그대로', !off(withoutAutoMemory(base, 'P:/github/CT2612', WA)));
check('하위 폴더(작업 트리)도 그대로 — 세나가 아닌 개발 세션', !off(withoutAutoMemory(base, `${WA}/.claude/worktrees/x`, WA)));
check('업무 비서 루트를 모르면 그대로', !off(withoutAutoMemory(base, WA, undefined)));
check('나머지 변수는 그대로 둠', withoutAutoMemory(base, WA, WA).PATH === 'x' && base.CLAUDE_CODE_DISABLE_AUTO_MEMORY === undefined);

console.log(`\n${pass} 통과 · ${fails.length} 실패`);
if (fails.length) process.exit(1);
