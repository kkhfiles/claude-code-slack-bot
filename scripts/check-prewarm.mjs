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

// 관찰 기록은 임시 파일로 — 실제 파일에 쌓으면 「몇 번 맞았나」가 검사 횟수만큼 부푼다.
// **require 보다 먼저** 정한다(모듈이 읽을 때 경로를 굳힌다).
const EVENTS = path.join(fs.mkdtempSync(path.join(process.env.TEMP || '/tmp', 'warm-ev-')), 'ev.jsonl');
process.env.WORK_EVENTS_FILE = EVENTS;
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

// 4. **옵션이 다르면 안 쓴다** — 남의 규칙으로 뜬 세션에 말을 밀어 넣지 않는다.
//    ⭐ **그리고 버리지도 않는다** (2026-10-01) — 전에는 버려서, 좁은 길(다른 옵션)이 한 번
//    돌 때마다 대화용으로 띄워 둔 것이 사라졌다(8/31 이후 「못 씀」 25번 중 9번).
h = new SdkHandler(mcp);
calls.length = 0;
h.prewarm(OPTS);
h.runQuery('다른 방', { ...OPTS, workingDirectory: 'P:/github/other' });
eq('옵션이 다르면 새로 띄운다', calls.length, 2);
eq('남의 자리는 안 버린다', calls[0].options.abortController.signal.aborted, false);
h.runQuery('원래 방', OPTS);
eq('남겨 둔 자리를 원래 옵션이 쓴다', calls.length, 2);
await tick();
eq('원래 방의 말이 그 자리로 들어간다', calls[0].pushed, ['원래 방']);

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

// 15. **자리 둘이 같이 산다** — 대화형과 좁은 길형(2026-10-01).
const NARROW = { ...OPTS, tools: [], settingSources: [], skipMcp: true, appendSystemPrompt: '규칙' };
{
  h = new SdkHandler(mcp);
  calls.length = 0;
  h.prewarm(OPTS);
  h.prewarm(NARROW);
  eq('둘 다 띄운다', [calls.length, h.warmCount], [2, 2]);
  h.runQuery('좁은 길', NARROW);
  h.runQuery('대화', OPTS);
  eq('각자 제 자리를 쓴다', [calls.length, h.warmCount], [2, 0]);
  await tick();
  eq('말이 제 자리로 간다', [calls[0].pushed, calls[1].pushed], [['대화'], ['좁은 길']]);
}

// 16. **같은 지문을 또 띄우면 하나만** — 살아 있으면 그대로 둔다.
{
  h = new SdkHandler(mcp);
  calls.length = 0;
  h.prewarm(OPTS);
  h.prewarm(OPTS);
  eq('같은 지문은 한 자리', [calls.length, h.warmCount], [1, 1]);
}

// 17. **자리가 차면 가장 오래된 것을 버린다** — 프로세스가 끝없이 늘지 않게.
{
  h = new SdkHandler(mcp);
  calls.length = 0;
  h.prewarm(OPTS);
  h.prewarm(NARROW);
  h.prewarm({ ...OPTS, workingDirectory: 'P:/github/third' });
  eq('셋째를 띄우면 둘만 남는다', h.warmCount, SdkHandler.MAX_WARM);
  eq('가장 오래된 것을 버린다', calls[0].options.abortController.signal.aborted, true);
  eq('나중 것은 산다', calls[1].options.abortController.signal.aborted, false);
}

// 18. **메모리가 높으면 안 띄우고 들고 있던 것도 버린다** — 감시기의 종료 문턱을 앞당기지 않게.
{
  h = new SdkHandler(mcp);
  calls.length = 0;
  h.prewarm(OPTS);
  let high = false;
  h.memoryHigh = () => high;
  high = true;
  h.prewarm(NARROW);
  eq('메모리가 높으면 새로 안 띄운다', calls.length, 1);
  eq('들고 있던 것도 버린다', [h.warmCount, calls[0].options.abortController.signal.aborted], [0, true]);
  h.dropAllWarm('시험');   // 빈 채로 불러도 안 터진다
  high = false;
  h.prewarm(OPTS);
  eq('메모리가 내려가면 다시 띄운다', [calls.length, h.warmCount], [2, 1]);
}

// 19. **자리마다 유지 시간이 따로다** — 넘긴 값으로 낡음을 잰다.
{
  h = new SdkHandler(mcp);
  calls.length = 0;
  h.prewarm(OPTS, -1);           // 태어나자마자 낡음
  h.prewarm(NARROW, 60_000);
  h.runQuery('대화', OPTS);
  h.runQuery('좁은 길', NARROW);
  eq('낡은 자리는 안 쓰고 산 자리는 쓴다', calls.length, 3);
}

// 20. **메모리 문은 85% 에서 닫고 80% 이하 두 번에 연다** — 경계에서 띄웠다 버렸다를 막는다
//     (GPT 6.1 sol 검토가 낸 순서 84→86→84→79→79).
{
  const { WarmMemoryGate } = require(MOD);
  const g = new WarmMemoryGate();
  eq('메모리 문 84→86→84→79→79', [84, 86, 84, 79, 79].map((p) => g.observe(p)),
     [false, true, true, true, false]);
  const g2 = new WarmMemoryGate();
  eq('80~85 사이는 낮은 횟수를 잇지 않는다', [86, 79, 82, 79, 79].map((p) => g2.observe(p)),
     [true, true, true, true, false]);
}

// 21. **띄우기 직전에 재고, 높으면 안 띄운다**(감시기가 있는 운영 길).
{
  h = new SdkHandler(mcp);
  calls.length = 0;
  let pct = 90;
  h.memorySample = async () => pct;
  h.prewarm(OPTS);
  await tick(); await tick();
  eq('높게 재면 안 띄운다', [calls.length, h.memoryHigh()], [0, true]);
  pct = 70;
  h.prewarm(OPTS);
  await tick(); await tick();
  eq('한 번 내려간 것으로는 아직', calls.length, 0);
  h.prewarm(OPTS);
  await tick(); await tick();
  eq('두 번 내려가면 띄운다', [calls.length, h.memoryHigh()], [1, false]);
}

// 22. **띄운 뒤 규칙 파일이 바뀌면 그 프로세스를 안 쓴다** — 옛 규칙으로 답하지 않게.
{
  const os = await import('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warm-ctx-'));
  const md = path.join(dir, 'CLAUDE.md');
  fs.writeFileSync(md, '규칙 1');
  const C = { ...OPTS, workingDirectory: dir };
  h = new SdkHandler(mcp);
  calls.length = 0;
  h.prewarm(C);
  const later = new Date(Date.now() + 60_000);
  fs.utimesSync(md, later, later);
  h.runQuery('바뀐 뒤', C);
  eq('규칙 파일이 바뀌면 새로 띄운다', calls.length, 2);
  h.prewarm(C);
  h.runQuery('그대로', C);
  eq('안 바뀌면 쓴다', calls.length, 3);
  // 규칙 본문이 AGENTS.md 에 있고 CLAUDE.md 는 `@AGENTS.md` 한 줄인 저장소(2026-10-02) —
  // 본문을 고쳐도 CLAUDE.md 시각은 그대로라, AGENTS.md 를 안 보면 옛 규칙으로 답한다.
  const agents = path.join(dir, 'AGENTS.md');
  fs.writeFileSync(agents, '규칙 본문');
  h.prewarm(C);
  const later2 = new Date(Date.now() + 120_000);
  fs.utimesSync(agents, later2, later2);
  h.runQuery('본문만 바뀐 뒤', C);
  eq('AGENTS.md 가 바뀌어도 새로 띄운다', calls.length, 5);
  fs.rmSync(dir, { recursive: true, force: true });
}

// 23. **좁은 길은 끝나면 같은 옵션 객체로 미리 띄운다** — 다른 객체를 넘기면 지문이 갈린다.
{
  const sh = fs.readFileSync(path.join(ROOT, 'dist', 'slack-handler.js'), 'utf8');
  eq('세션을 같은 객체로 부른다', /sdkHandler\.runQuery\(prompt, sdkOpts\)/.test(sh), true);
  eq('끝나면 그 객체로 띄운다', /prewarmAfter[\s\S]{0,120}sdkHandler\.prewarm\(sdkOpts\)/.test(sh), true);
  const as = fs.readFileSync(path.join(ROOT, 'dist', 'assistant-scheduler.js'), 'utf8');
  eq('좁은 길이 켠다', /prewarmAfter: true/.test(as), true);
}

// 24. **맞았나 · 왜 안 맞았나가 관찰 기록에 남는다** (2026-10-02) — 하루 활동 요약이 센다.
//     미리 띄우기가 있는 두 길(좁은 길 · 대화)만 적는다 — 분석 세션까지 「없음」으로 적으면 맞힌
//     비율이 저절로 낮아 보인다. 값은 안 싣고 칸 이름만.
{
  fs.rmSync(EVENTS, { force: true });
  const NAR = { ...OPTS, env: { ASSISTANT_MODE: 'narrow' } };
  const hh = new SdkHandler(mcp);
  hh.prewarm(NAR);
  hh.runQuery('맞음', NAR);
  hh.prewarm(NAR);
  hh.runQuery('다름', { ...NAR, effort: 'high' });
  const h3 = new SdkHandler(mcp);
  h3.runQuery('대화 — 자리 없음', { ...OPTS, env: { WORK_ASSISTANT_CAPTURE_FILE: 'x.json' } });
  h3.runQuery('분석 — 안 적음', { ...OPTS, env: { ASSISTANT_MODE: 'analysis' } });
  const ev = fs.existsSync(EVENTS)
    ? fs.readFileSync(EVENTS, 'utf-8').split('\n').filter(Boolean).map((x) => JSON.parse(x)) : [];
  eq('맞음 · 다름 · 없음 셋만 남는다(분석은 안 적음)',
     ev.map((e) => [e.kind, e.hit, e.why ?? '', e.mode]),
     [['prewarm', true, '', 'narrow'], ['prewarm', false, 'diff', 'narrow'], ['prewarm', false, 'none', 'chat']]);
  eq('다른 까닭은 칸 이름으로', ev[1]?.diff, 'effort');
  eq('프롬프트 글은 안 싣는다', JSON.stringify(ev).includes('맞음') || JSON.stringify(ev).includes('다름'), false);
}

if (fails.length) {
  console.log(`실패 ${fails.length}건\n`);
  for (const f of fails) console.log('  ✗ ' + f);
  process.exitCode = 1;
} else {
  console.log('통과 — 미리 띄우기 (하나 뜸 · 같은 옵션이면 재사용 · 프롬프트가 그리로 들어감 · '
    + '한 번 쓰면 사라짐 · 옵션이 다르면 안 씀 · 세션 id 는 다른 지문 · 낡으면 안 씀 · '
    + '터져도 평소대로 · 넣고 닫힘 · 캡처 id 가 옵션에 안 박힘 · 갈린 칸을 말함 · '
    + '세션을 이어받는 차례도 맞음 · 떼면 못 씀 · 부르는 쪽이 옵션을 안 고침 · '
    + '남의 자리를 안 버림 · 자리 둘 · 같은 지문 한 자리 · 차면 오래된 것부터 · 메모리 높으면 안 띄움 · 자리별 유지 시간 · '
    + '메모리 문 85·80 이력 · 띄우기 직전 측정 · 규칙 파일이 바뀌면 안 씀 · 좁은 길이 같은 객체로 띄움)');
}
