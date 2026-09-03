/**
 * 좁은 길의 폴백 — **터져도 본 경로를 안 막나**, **한 번만 부르나.**
 *
 *   npm run build
 *   npm run check:narrow
 *
 * 이 자리가 조용히 고장 나는 모양이 둘이다.
 *
 * ① **폴백이 예외를 던진다** — 1차가 빈손일 때만 도는 코드라 평소에는 아무도
 *    안 지난다. 그러다 진짜 필요한 날(전면 장애) 그 자리에서 터지면, 폴백이
 *    없는 것보다 나쁘다 — 세션으로 떨어지지도 못하고 사람 말이 사라진다.
 *
 * ② **폴백이 늘 돈다** — `if (!said)` 밖으로 새면 1차가 멀쩡히 답한 건까지
 *    두 번 부른다. 결과는 같아 보이는데 시간과 돈만 두 배가 되고, 로그를
 *    안 세면 아무도 모른다.
 *
 * **외부 서비스를 부르지 않는다.** 실제 codex 호출은 10초가 걸려 푸시 문에
 * 못 둔다 — 여기서는 없는 실행체를 넣어 「빈손으로 물러나나」만 잰다.
 */
import './lib/fresh-dist.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { narrowCodex } from '../dist/work-assistant.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fails = [];
const eq = (label, got, want) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    fails.push(`${label}\n    받음 ${JSON.stringify(got)}\n    기대 ${JSON.stringify(want)}`);
  }
};
const ok = (label, cond) => { if (!cond) fails.push(label); };

// ── ① 꺼 두면 아무것도 안 한다 ──────────────────────────────────
process.env.BOARD_NARROW_FALLBACK = 'off';
eq('꺼 두면 빈손으로 곧바로 돌아온다', await narrowCodex('규칙', '말'), '');
delete process.env.BOARD_NARROW_FALLBACK;

// ── ② 실행체가 없어도 안 던진다 ────────────────────────────────
process.env.BOARD_NARROW_CODEX_BIN = 'codex-없는-이름-2026';
const t = Date.now();
let threw = null;
let got = null;
try {
  got = await narrowCodex('규칙', '말', 15_000);
} catch (e) {
  threw = e;
}
delete process.env.BOARD_NARROW_CODEX_BIN;
eq('실행체가 없으면 던지지 않고 빈손', [threw && String(threw), got], [null, '']);
ok(`실행체가 없을 때 곧바로 물러난다 (${Date.now() - t}ms · 상한 15초를 안 기다림)`,
   Date.now() - t < 12_000);

// ── ③ 폴백은 1차가 빈손일 때만 부른다 ──────────────────────────
//
// **소스 모양으로 본다** — 이 판정에 필요한 것은 「어느 조건 안에 있나」이고,
// 그것을 실행으로 재려면 세션 하나를 통째로 가짜로 만들어야 한다.
const sched = fs.readFileSync(
  path.join(ROOT, 'src', 'assistant-scheduler.ts'), 'utf-8');
const calls = [...sched.matchAll(/narrowCodex\s*\(/g)];
eq('부르는 곳은 한 군데', calls.length, 1);

if (calls.length === 1) {
  // 부르는 줄 바로 앞 300자 안에 `if (!said)` 가 있어야 한다.
  const before = sched.slice(Math.max(0, calls[0].index - 300), calls[0].index);
  ok('`if (!said)` 안에서만 부른다 — 1차가 답한 건은 안 건드림',
     /if\s*\(!said\)\s*\{/.test(before));
}

// **두 엔진이 같은 규칙을 받는다** — 한쪽만 고치면 폴백이 다른 일을 한다.
ok('1차와 폴백이 같은 규칙 글자를 받는다',
   /appendSystemPrompt:\s*rulesText/.test(sched)
   && /narrowCodex\(rulesText,/.test(sched));

// **규칙 파일을 두 번 안 읽는다** — 읽는 사이에 파일이 바뀌면 두 엔진이
// 다른 규칙으로 돈다(드물지만 재현이 안 되는 갈래다).
eq('규칙 파일은 한 번만 읽는다',
   [...sched.matchAll(/readFileSync\(rules/g)].length, 1);

if (fails.length) {
  console.error(`\n실패 ${fails.length}건\n\n  ✗ ${fails.join('\n\n  ✗ ')}\n`);
  process.exitCode = 1;
} else {
  console.log('통과 — 좁은 길 폴백 (꺼짐 · 실행체 없음 · 부르는 조건 · 같은 규칙)');
}
