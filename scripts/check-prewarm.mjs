/**
 * 미리 띄워 둔 세션을 언제 쓰고 언제 안 쓰나.
 *
 *   npm run check:prewarm     (먼저 `npm run build`)
 *
 * **진짜 프로세스를 안 띄운다** — `SdkHandler.queryFn` 을 바꿔 끼워 규칙만 잰다.
 * 진짜로 띄우면 한 번에 몇 초씩 들고 구독 한도를 먹는다.
 *
 * 여기서 지키려는 것은 속도가 아니라 **안 섞이는 것**이다. 남의 옵션으로 뜬
 * 세션에 이 대화를 밀어 넣으면 조용히 다른 규칙으로 답하고, 세션 id 가 붙은 채로
 * 뜬 것을 재사용하면 **다음 사람의 말이 남의 대화에 붙는다.**
 */
import './lib/fresh-dist.mjs';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MOD = path.join(ROOT, 'dist', 'sdk-handler.js');
// dist 가 없거나 낡았으면 맨 위 `./lib/fresh-dist.mjs` 가 이미 멈춘다.

const { SdkHandler, warmKey, pushableInput } = require(MOD);

const fails = [];
function eq(label, got, want) {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a !== b) fails.push(`${label}\n    받음 ${a}\n    기대 ${b}`);
}

// --- 가짜 query — 부른 횟수와 받은 프롬프트만 적는다 ----------------------
const calls = [];
function fakeQuery({ prompt, options }) {
  const rec = { prompt, options, pushed: [] };
  calls.push(rec);
  if (prompt && typeof prompt !== 'string') {
    // 흐름으로 받은 것 — 나중에 밀어 넣는 그 모양이다. 읽어서 적어 둔다.
    (async () => {
      for await (const m of prompt) rec.pushed.push(m?.message?.content);
    })().catch(() => {});
  }
  return {
    async *[Symbol.asyncIterator]() { /* 아무것도 안 낸다 */ },
    interrupt() { rec.interrupted = true; },
  };
}
SdkHandler.queryFn = fakeQuery;

const mcp = {
  getServerConfiguration: () => ({}),
  getDefaultAllowedTools: () => [],
};
const OPTS = { workingDirectory: 'P:/github/work-assistant', model: 'claude-opus-5',
               effort: 'low', permissionMode: 'auto', skills: 'all' };

const tick = () => new Promise((r) => setImmediate(r));

// 1. 미리 띄우면 프로세스가 하나 뜬다 — 프롬프트는 아직 없다
let h = new SdkHandler(mcp);
calls.length = 0;
h.prewarm(OPTS);
eq('미리 띄우면 하나 뜬다', calls.length, 1);
eq('프롬프트는 아직 안 정해졌다', typeof calls[0].prompt === 'string', false);

// 2. 옵션이 같으면 그것을 쓴다 — 새로 안 띄운다
const p = h.runQuery('판에서 온 말', OPTS);
eq('같은 옵션이면 새로 안 띄운다', calls.length, 1);
await tick();
eq('프롬프트가 그 세션으로 들어간다', calls[0].pushed, ['판에서 온 말']);
eq('돌려주는 것이 있다', !!p, true);

// 3. 한 번 쓰면 사라진다 — 다음 것은 새로 띄운다
h.runQuery('그 다음 말', OPTS);
eq('한 번 쓰면 다음은 새로', calls.length, 2);
eq('새로 띄운 것은 문자열 프롬프트', calls[1].prompt, '그 다음 말');

// 4. **옵션이 다르면 안 쓴다** — 남의 규칙으로 뜬 세션에 말을 밀어 넣지 않는다
h = new SdkHandler(mcp);
calls.length = 0;
h.prewarm(OPTS);
h.runQuery('다른 방', { ...OPTS, workingDirectory: 'P:/github/other' });
eq('옵션이 다르면 새로 띄운다', calls.length, 2);
// **버리는 길은 중단 신호다** — `interrupt()` 가 아니라 `abortController`.
// SDK 가 그 신호로 프로세스를 내린다. 처음에 `interrupt()` 를 봤다가 못 잡았다.
eq('미리 띄운 것은 버린다', calls[0].options.abortController.signal.aborted, true);

// 5. **세션 id 가 붙으면 지문이 달라진다** — 이걸 놓치면 다음 사람의 말이
//    남의 대화에 붙는다. 미리 띄울 때 세션을 떼는 이유다.
const bare = warmKey({ a: 1 });
const resumed = warmKey({ a: 1, resume: 'abc-123' });
eq('세션을 이어받는 옵션은 다른 지문', bare === resumed, false);

// 6. 낡으면 안 쓴다
h = new SdkHandler(mcp);
calls.length = 0;
const keep = SdkHandler.WARM_TTL_MS;
SdkHandler.WARM_TTL_MS = -1;          // 태어나자마자 낡음
h.prewarm(OPTS);
h.runQuery('낡은 것 뒤', OPTS);
eq('낡으면 새로 띄운다', calls.length, 2);
SdkHandler.WARM_TTL_MS = keep;

// 7. **미리 띄우기가 터져도 평소대로 돈다** — 빠르게 하는 장치이지 반영이 아니다
h = new SdkHandler(mcp);
calls.length = 0;
SdkHandler.queryFn = () => { throw new Error('띄우기 실패'); };
h.prewarm(OPTS);                       // 여기서 안 터져야 한다
SdkHandler.queryFn = fakeQuery;
h.runQuery('그래도 간다', OPTS);
eq('미리 띄우기가 터져도 평소대로', calls.length, 1);

// 8. **넣고 곧바로 닫는다** — 안 닫으면 답이 끝나도 읽는 쪽이 안 끝난다
{
  const io = pushableInput();
  io.send('한 마디');
  const got = [];
  for await (const m of io.stream) got.push(m?.message?.content);
  eq('넣은 것이 한 번 나오고 끝난다', got, ['한 마디']);
}

if (fails.length) {
  console.log(`실패 ${fails.length}건\n`);
  for (const f of fails) console.log('  ✗ ' + f);
  process.exitCode = 1;
} else {
  console.log('통과 — 미리 띄우기 (하나 뜸 · 같은 옵션이면 재사용 · 프롬프트가 그리로 들어감 · '
    + '한 번 쓰면 사라짐 · 옵션이 다르면 버림 · 세션 id 는 다른 지문 · 낡으면 안 씀 · '
    + '터져도 평소대로 · 넣고 닫힘)');
}
