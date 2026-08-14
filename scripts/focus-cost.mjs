/**
 * 진행판 맨 위 한 줄에 실제로 얼마가 드는지 재는 자리.
 *
 *     node scripts/focus-cost.mjs
 *
 * **왜 따로 재나.** 예약된 자리(`assistant-scheduler.runFocus`)는 두 시간에 한 번만
 * 도는데, 문맥을 줄인 효과는 그때까지 기다려야 보인다. 같은 인자로 한 번 부른다 —
 * 다른 것이 하나라도 있으면 재려던 것과 다른 것을 재게 된다.
 *
 *     node scripts/focus-cost.mjs --model=claude-haiku-4-5-20251001 --dry
 *
 * **얼마나 들고 시작하나만 볼 때는 위 두 손잡이를 쓴다.** 캐시 쓰기·읽기 토큰은
 * 모델이 바뀌어도 같은 값이라, 값싼 모델로 재도 문맥 크기는 그대로 보인다.
 * `--dry` 는 `tasks.py` 가 읽기는 진짜로 하고 쓰기는 「무엇을 쓸지」만 찍게 한다.
 *
 * ⚠️ **손잡이 없이 부르면 진짜로 한 줄을 쓴다.** 돈이 나가고 판이 갱신된다 —
 * 그래서 자동으로 도는 것에 걸어 두지 않는다.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKDIR = 'P:/github/work-assistant';
const PROMPT = 'P:/github/claude-workflow/assistant/prompts/focus.md';
const { SdkHandler } = await import(pathToFileURL(path.join(ROOT, 'dist', 'sdk-handler.js')).href);

const arg = (n, d) => (process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3)) ?? d;
const DRY = process.argv.includes('--dry');

// 예약된 자리와 **같은 인자**. 여기 값을 바꿀 때는 저쪽도 같이 바꾼다.
const OPTS = {
  workingDirectory: WORKDIR,
  model: arg('model', 'opus'),
  effort: 'low',
  permissionMode: 'default',
  tools: ['Bash', 'Read'],
  allowedTools: ['Bash', 'Read'],
  settingSources: [],
  settings: { permissions: { allow: ['Bash(python:*)', 'Read'] } },
  appendSystemPrompt: 'tasks.py 의 json·focus 두 서브커맨드만 쓴다. 그 외 쓰기·발신 금지.',
  env: {
    ASSISTANT_MODE: 'focus', CLAUDE_SCHEDULED: '1',
    ...(DRY ? { WORK_ASSISTANT_DRY: '1' } : {}),
  },
  skipMcp: true,
  noSessionPersistence: true,
};

const sdk = new SdkHandler({ getServerConfiguration: () => ({}) });
const started = Date.now();
let cost = null, usage = null, reply = '';
const calls = [];

for await (const ev of sdk.runQuery(readFileSync(PROMPT, 'utf8'), OPTS)) {
  if (ev.type === 'assistant') {
    for (const part of ev.message?.content ?? []) {
      if (part.type === 'tool_use') {
        calls.push(part.name === 'Bash'
          ? String(part.input?.command ?? '').replace(/\s+/g, ' ').slice(0, 160)
          : part.name);
      }
      if (part.type === 'text') reply += part.text;
    }
  } else if (ev.type === 'result') {
    cost = ev.total_cost_usd ?? null;
    usage = ev.usage ?? null;
  }
}

console.log(`\n든 값 $${cost?.toFixed(4) ?? '?'} · ${((Date.now() - started) / 1000).toFixed(1)}초`);
if (usage) {
  console.log(`캐시 쓰기 ${usage.cache_creation_input_tokens?.toLocaleString()} · `
    + `캐시 읽기 ${usage.cache_read_input_tokens?.toLocaleString()} · `
    + `출력 ${usage.output_tokens?.toLocaleString()}`);
}
console.log(`부른 것 ${calls.length}회`);
for (const c of calls) console.log('  ·', c);
console.log('\n답:', reply.trim().slice(0, 300));
