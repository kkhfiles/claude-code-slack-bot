/**
 * 차례 구간 시계 검사 — 띄우기, 모델, 도구 구간과 이름만 남기기.
 *
 *   npm run build
 *   npm run check:turntiming
 */
import './lib/fresh-dist.mjs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { TurnTimer, commandName } = require(path.join(ROOT, 'dist', 'turn-timing.js'));

const fails = [];
const eq = (label, got, want) => {
  const a = JSON.stringify(got); const b = JSON.stringify(want);
  if (a !== b) fails.push(`${label}: got ${a}, expected ${b}`);
};

let now = 0;
const t = new TurnTimer(() => now);
now = 3300; t.see({ type: 'system', subtype: 'init' });
now = 5600; t.see({ type: 'assistant', message: { content: [{ type: 'thinking' }] } });
now = 5600; t.see({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a', name: 'Bash',
  input: { command: 'python -X utf8 bin/stanley_sessions.py --json "실장님 글"' } }] } });
now = 8600; t.see({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a' }] } });
now = 17700; t.see({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'b', name: 'Write', input: { file_path: 'x' } }] } });
now = 17800; t.see({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'b' }] } });
now = 19800; t.see({ type: 'assistant', message: { content: [{ type: 'text', text: '서랍에 답했어요' }] } });
now = 20400;
const s = t.summary({ where: 'drawer' });
eq('띄우기', s.spawn_s, 3.3);
eq('합계', s.total_s, 20.4);
eq('도구 시간', s.tool_s, 3.1);
eq('모델 시간', s.model_s, 13.4);
eq('구간', s.steps.map((x) => `${x.k}:${x.name}:${x.s}`), [
  'model:thinking:2.3', 'tool:Bash:stanley_sessions.py:3', 'model:tool_use:9.1', 'tool:Write:0.1', 'model:text:2']);
eq('글과 인자는 안 남김', /실장님|서랍에 답|--json/.test(JSON.stringify(s)), false);
eq('스크립트 이름', commandName('cd x && python -X utf8 P:/a/b/tasks.py brief'), 'tasks.py');
eq('스크립트 없으면 첫 낱말', commandName('git -C P:/x status'), 'git');
eq('문자열 아님', commandName(undefined), '');

if (fails.length) {
  console.error(`check:turntiming FAIL (${fails.length})\n` + fails.join('\n'));
  process.exitCode = 1;
} else {
  console.log('check:turntiming OK');
}
