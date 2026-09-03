/**
 * 좁은 길의 폴백 — **정작 필요한 날에 도나.**
 *
 *   npm run build
 *   npm run check:narrow
 *
 * 이 자리가 조용히 고장 나는 모양이 넷이다. 셋은 실제로 겪었다(2026-09-03).
 *
 * ① **1차가 던지는 길로 새어 나간다** — 구독 만료·인증 실패는 스트림에 오류를
 *    실어 보내는 것이 아니라 **토큰을 가져오다 던진다.** 그 호출이 try 밖에
 *    있으면 폴백을 통째로 건너뛴다. **이 폴백을 만든 바로 그 상황에서만 안 도는**
 *    장치가 된다 — 첫 판이 실제로 그랬다.
 * ② **오류 표시를 안 본다** — 한도에 걸린 회차가 부분 응답을 들고 오면 그것을
 *    성공으로 읽어 반쪽짜리 판단이 카드에 앉는다.
 * ③ **폴백이 예외를 던진다** — 평소에는 아무도 안 지나는 코드라, 진짜 필요한 날
 *    거기서 터지면 폴백이 없는 것보다 나쁘다(세션으로 떨어지지도 못한다).
 * ④ **폴백이 늘 돈다** — `if (!said)` 밖으로 새면 1차가 멀쩡히 답한 건까지 두 번
 *    부른다. 결과는 같아 보이는데 시간과 돈만 두 배다.
 *
 * **외부 서비스를 안 부른다.** 실제 codex 호출은 10초가 걸려 푸시 문에 못 둔다 —
 * 없는 실행체를 넣어 「부르러 갔나」와 「빈손으로 물러나나」만 잰다.
 */
import './lib/fresh-dist.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { narrowCodex, workAssistantRoot } from '../dist/work-assistant.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fails = [];
const notes = [];
const eq = (label, got, want) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    fails.push(`${label}\n    받음 ${JSON.stringify(got)}\n    기대 ${JSON.stringify(want)}`);
  }
};
const ok = (label, cond) => { if (!cond) fails.push(label); };

const NOBIN = 'codex-없는-이름-2026';

// ── ③ 꺼 두면 아무것도 안 한다 ──────────────────────────────────
process.env.BOARD_NARROW_FALLBACK = 'off';
eq('꺼 두면 빈손으로 곧바로 돌아온다', await narrowCodex('규칙', '말'), '');
delete process.env.BOARD_NARROW_FALLBACK;

// ── ③ 실행체가 없어도 안 던진다 ────────────────────────────────
process.env.BOARD_NARROW_CODEX_BIN = NOBIN;
const t0 = Date.now();
let threw = null;
let got = null;
try {
  got = await narrowCodex('규칙', '말', 15_000);
} catch (e) {
  threw = e;
}
eq('실행체가 없으면 던지지 않고 빈손', [threw && String(threw), got], [null, '']);
ok(`실행체가 없을 때 곧바로 물러난다 (${Date.now() - t0}ms · 상한 15초를 안 기다림)`,
   Date.now() - t0 < 12_000);

// ── ① 1차가 **던져도** 폴백을 부르러 가나 (실행으로 잰다) ──────
//
// 소스 모양이 아니라 실제로 지나가는지를 본다 — 첫 판이 소스로는 멀쩡해
// 보였는데 `spawnSession` 이 try 밖에 있어 이 길이 통째로 막혀 있었다.
const evFile = path.join(os.tmpdir(), `wa-ev-${Date.now()}.jsonl`);
process.env.WORK_EVENTS_FILE = evFile;
const { AssistantScheduler } = await import('../dist/assistant-scheduler.js');
const { config } = await import('../dist/config.js');

if (!workAssistantRoot()) {
  notes.push('업무 비서 뿌리가 없어 ① 을 못 쟀다 — 통과가 아니라 안 본 것');
} else {
  const sched = new AssistantScheduler(
    async () => {},
    async () => { throw new Error('토큰을 못 가져왔다(시험)'); },
    config.assistant.configDir,
  );
  // 열린 업무를 하나 집는다 — 재료(`tasks.py narrow --card`)가 실물이어야 한다.
  //
  // **던지는 것도 받아 낸다** — 1차를 안 감싸 두면 여기로 그 예외가 그대로
  // 올라온다. 그때 스택으로 뻗으면 무엇이 깨졌는지 안 보여서, 이름을 붙여 센다.
  let out = null;
  let up = null;
  try {
    out = await sched.narrowFromBoard('[진행판] TSK-48 「시험」\n폴백 배선 시험입니다.');
  } catch (e) {
    up = e;
  }
  ok(`1차가 던진 것이 폴백을 못 거치고 그대로 올라왔다 — try 밖이다 (${up})`, !up);
  // 폴백도 빈손이라(없는 실행체) 세션으로 물러나는 것이 정답이다.
  // **앉히지 않는다** — `narrowApply` 까지 안 가므로 볼트를 안 건드린다.
  if (!up) eq('1차가 던지면 폴백을 거쳐 세션으로 물러난다', out.kind, 'not-quick');

  const lines = fs.existsSync(evFile)
    ? fs.readFileSync(evFile, 'utf-8').trim().split('\n').filter(Boolean).map(JSON.parse)
    : [];
  const fb = lines.filter((x) => x.kind === 'narrow-fallback');
  eq('폴백을 지난 것이 관찰 기록에 한 줄 남는다', fb.length, 1);
  if (fb.length === 1) {
    eq('던진 것을 `threw` 로 적는다', [fb[0].why, fb[0].ok], ['threw', false]);
  }
}
delete process.env.BOARD_NARROW_CODEX_BIN;
delete process.env.WORK_EVENTS_FILE;
try { fs.unlinkSync(evFile); } catch { /* 없으면 그만 */ }

// ── ②④ 소스 모양 ───────────────────────────────────────────────
const sched = fs.readFileSync(
  path.join(ROOT, 'src', 'assistant-scheduler.ts'), 'utf-8');

const calls = [...sched.matchAll(/narrowCodex\s*\(/g)];
eq('부르는 곳은 한 군데', calls.length, 1);
if (calls.length === 1) {
  const before = sched.slice(Math.max(0, calls[0].index - 300), calls[0].index);
  ok('`if (!said)` 안에서만 부른다 — 1차가 답한 건은 안 건드림',
     /if\s*\(!said\)\s*\{/.test(before));
}

// ② 오류 표시를 본다 — 부분 응답을 성공으로 읽지 않는다.
ok('1차의 `isError`·`rateLimited` 를 본다',
   /result\.isError\s*\|\|\s*result\.rateLimited/.test(sched));

// 두 엔진이 같은 규칙을 받는다 — 한쪽만 고치면 폴백이 다른 일을 한다.
ok('1차와 폴백이 같은 규칙 글자를 받는다',
   /appendSystemPrompt:\s*rulesText/.test(sched) && /narrowCodex\(rulesText,/.test(sched));

// 규칙 파일을 두 번 안 읽는다 — 읽는 사이에 바뀌면 두 엔진이 다른 규칙으로 돈다.
eq('규칙 파일은 한 번만 읽는다',
   [...sched.matchAll(/readFileSync\(rules/g)].length, 1);

if (notes.length) console.log(`\n⚠️  ${notes.join('\n⚠️  ')}`);
if (fails.length) {
  console.error(`\n실패 ${fails.length}건\n\n  ✗ ${fails.join('\n\n  ✗ ')}\n`);
  process.exitCode = 1;
} else {
  console.log('통과 — 좁은 길 폴백 (꺼짐 · 실행체 없음 · **던져도 닿음** · '
    + '오류 표시 · 부르는 조건 · 같은 규칙 · 관찰 기록)');
}
