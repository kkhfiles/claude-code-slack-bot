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
 *
 * ⛔ **이 검사가 못 보는 것 하나** — 진짜 SDK 가 답을 끝낸 뒤 표준입력을 닫는가.
 * 안 닫으면 읽는 쪽의 `for await` 이 영영 안 끝나 **슬랙 대화가 통째로 멈춘다.**
 * 가짜 `query` 로는 재현이 안 되므로 진짜 호출로 따로 확인한다:
 *
 *     node scripts/probe-warm-live.mjs        (실측 2026-08-29: 2.8초에 끝남)
 *
 * 구독 한도를 쓰는 진짜 호출이라 `npm test` 에 안 넣었다. 미리 띄우기 쪽을
 * 손대면 그때 한 번 돌린다.
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

const { SdkHandler, warmKey, warmDiff, pushableInput } = require(MOD);

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

// 9. ⭐ **캡처 id 가 옵션에 안 박힌다.** 박히면 차례마다 지문이 달라져 미리 띄운
//    것을 **영영 못 쓴다** — 08-29 에 실제로 그랬고, 그래서 미리 띄우기를 통째로
//    걷었다. 값이 아니라 방마다 고정된 파일 경로를 넘긴다.
{
  const src = fs.readFileSync(path.join(ROOT, 'dist', 'slack-handler.js'), 'utf8');
  eq('캡처 값을 env 에 안 박는다', /WORK_ASSISTANT_CAPTURE:/.test(src), false);
  eq('캡처 경로를 넘긴다', /WORK_ASSISTANT_CAPTURE_FILE:/.test(src), true);
  // 시스템 프롬프트에도 안 박는다 — 거기 박혀도 지문이 갈린다(08-29 에 세 곳).
  eq('안내에 캡처 id 를 안 끼운다', /캡처 \$\{/.test(src), false);
}

// 10. **같은 방의 두 차례는 같은 지문** — 캡처 경로가 방마다 고정이라 그렇다.
{
  const one = { env: { WORK_ASSISTANT_CAPTURE_FILE: '/s/work-capture-D1.json' }, cwd: 'x' };
  eq('두 차례가 같은 지문', warmKey(one) === warmKey({ ...one }), true);
  eq('다른 방은 다른 지문',
    warmKey(one) === warmKey({ ...one, env: { WORK_ASSISTANT_CAPTURE_FILE: '/s/work-capture-D2.json' } }),
    false);
}

// 11. **왜 안 맞았는지 칸 이름으로 말한다** — 08-29 에 「옵션이 다름」만 남아
//     원인을 짚으려고 탐침을 따로 짜야 했다.
eq('갈린 칸 이름을 낸다', warmDiff(warmKey({ a: 1, b: 2 }), warmKey({ a: 1, b: 3 })), 'b');
eq('값은 안 찍는다', /2|3/.test(warmDiff(warmKey({ a: 1, b: 2 }), warmKey({ a: 1, b: 3 }))), false);

// 12. ⭐ **세션을 이어받는 옵션 그대로 띄워야 맞는다.**
//
//     ⛔ 옛 코드는 여기서 세션을 떼고 띄웠다(`session`·`resumeSessionId` 를
//     `undefined` 로). 그러면 **실제 차례와 영영 안 맞는다** — 실제 차례는 늘 그
//     방의 대화를 이어받기 때문이다. 미리 띄우기가 실물에서 한 번도 안 쓰인
//     진짜 원인이 이것이고, 08-29 에는 캡처 id 만 보고 절반만 짚었다.
const SESSION_OPTS = {
  ...OPTS, session: { sessionId: 'abc-123', lastAssistantUuid: 'u-9' },
};
{
  h = new SdkHandler(mcp);
  calls.length = 0;
  h.prewarm(SESSION_OPTS);
  h.runQuery('판에서 온 말', SESSION_OPTS);
  eq('세션을 이어받는 차례도 미리 띄운 것을 쓴다', calls.length, 1);
}

// 13. **떼고 띄우면 못 쓴다** — 옛 코드가 하던 그대로 재현한다. 12번이 진짜로
//     무엇을 보는지 이 짝이 증명한다(안 그러면 늘 통과하는 문일 수 있다).
{
  h = new SdkHandler(mcp);
  calls.length = 0;
  h.prewarm({ ...SESSION_OPTS, session: undefined, resumeSessionId: undefined });
  h.runQuery('판에서 온 말', SESSION_OPTS);
  eq('세션을 떼고 띄우면 못 쓴다', calls.length, 2);
}

// 14. **부르는 쪽이 옵션을 안 고친다** — 한 칸만 덧씌워도 12번이 무의미해진다.
//     실제로 되살릴 때 `resumeSessionId` 를 덧씌워 `resumeSessionAt` 이 갈렸다.
{
  const src = fs.readFileSync(path.join(ROOT, 'dist', 'slack-handler.js'), 'utf8');
  const m = src.match(/sdkHandler\.prewarm\(([^)]*)\)/);
  eq('미리 띄우기에 옵션을 그대로 넘긴다', m && m[1].trim(), 'sdkOptsForWarm');
}

if (fails.length) {
  console.log(`실패 ${fails.length}건\n`);
  for (const f of fails) console.log('  ✗ ' + f);
  process.exitCode = 1;
} else {
  console.log('통과 — 미리 띄우기 (하나 뜸 · 같은 옵션이면 재사용 · 프롬프트가 그리로 들어감 · '
    + '한 번 쓰면 사라짐 · 옵션이 다르면 버림 · 세션 id 는 다른 지문 · 낡으면 안 씀 · '
    + '터져도 평소대로 · 넣고 닫힘 · 캡처 id 가 옵션에 안 박힘 · 갈린 칸을 말함 · '
    + '세션을 이어받는 차례도 맞음 · 떼면 못 씀 · 부르는 쪽이 옵션을 안 고침)');
}
