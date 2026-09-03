/**
 * 주 작업(예약 세션)의 폴백 — **두 번 하지 않나.**
 *
 *   npm run build
 *   npm run check:sessionfb
 *
 * 좁은 길과 위험이 다르다. 좁은 길은 「글 → JSON → 파이썬이 반영」이라 엔진을
 * 갈아 끼워도 반영이 한 번뿐이지만, **예약 세션은 도구를 여러 번 돌린다.**
 * 중간에 죽으면 이미 쓴 것이 있을 수 있고, 같은 프롬프트를 다시 돌리면 그 일이
 * 두 번 일어난다 — 진행 로그가 두 줄, 공수가 두 번, 요약이 두 번.
 *
 * 그래서 문이 셋이다. **셋 다 여기서 실행으로 잰다** — 소스 모양만 보면
 * 「멀쩡해 보이는데 안 도는」 판을 못 잡는다(좁은 길에서 실제로 그랬다).
 *
 *   ① 도구를 하나라도 돌린 뒤 실패 → 폴백 **안 함**
 *   ② 몇 번 돌렸는지 **모름**(`undefined`) → 안 함. 모르는 것을 0 으로 읽으면 두 번 돈다
 *   ③ 이어받는 회차(`resumeSessionId`) → 안 함. 프롬프트가 `'continue'` 한 낱말이다
 *
 * **외부 서비스를 안 부른다** — 없는 실행체를 넣어 「부르러 갔나」만 잰다.
 */
import './lib/fresh-dist.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fails = [];
const eq = (label, got, want) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    fails.push(`${label}\n    받음 ${JSON.stringify(got)}\n    기대 ${JSON.stringify(want)}`);
  }
};
const ok = (label, cond) => { if (!cond) fails.push(label); };

const evFile = path.join(os.tmpdir(), `wa-sev-${Date.now()}.jsonl`);
process.env.WORK_EVENTS_FILE = evFile;
// 폴백이 실제로 불리는지만 보고 싶다 — 없는 실행체를 주면 빈손으로 돌아온다.
process.env.BOARD_NARROW_CODEX_BIN = 'codex-없는-이름-2026';

const { AssistantScheduler } = await import('../dist/assistant-scheduler.js');
const { config } = await import('../dist/config.js');

const OPTS = { workingDirectory: os.tmpdir() };

/** 1차가 이렇게 끝났다고 치고 한 번 돌린다. */
async function run(fake, opts = OPTS) {
  const before = readEvents().length;
  const sched = new AssistantScheduler(
    async () => {},
    async () => (typeof fake === 'function' ? fake() : fake),
    config.assistant.configDir,
  );
  const out = await sched.spawnOrFallback('시험', '아무 말', opts);
  return { out, ev: readEvents().slice(before) };
}

function readEvents() {
  if (!fs.existsSync(evFile)) return [];
  return fs.readFileSync(evFile, 'utf-8').trim().split('\n')
    .filter(Boolean).map(JSON.parse);
}

const OKR = { text: '잘 됐다', costUsd: 0, sessionId: 's', subtype: 'success', isError: false, toolCalls: 2 };

// ── 잘 된 회차는 그대로 돌려준다 (폴백을 안 부른다) ────────────
{
  const { out, ev } = await run(OKR);
  eq('잘 된 회차는 그대로', out.text, '잘 됐다');
  eq('잘 된 회차는 관찰 기록을 안 남긴다', ev.length, 0);
}

// ── ① 도구를 돌린 뒤 실패 → 폴백 안 함 ────────────────────────
{
  const { out, ev } = await run({ ...OKR, text: '', isError: true, subtype: 'error', toolCalls: 3 });
  eq('도구를 돌린 뒤 실패면 폴백 안 함', ev.map((e) => e.skipped), ['tools-ran']);
  eq('몇 번 돌렸는지 같이 남긴다', ev[0] && ev[0].toolCalls, 3);
  ok('1차 결과를 그대로 돌려준다', out.isError === true);
}

// ── ② 몇 번 돌렸는지 모르면 → 안 함 ───────────────────────────
{
  const { ev } = await run({ text: '', costUsd: 0, sessionId: 's', subtype: 'error', isError: true });
  eq('모르는 것을 0 으로 안 읽는다', ev.map((e) => e.skipped), ['tools-ran']);
  eq('모르는 것은 null 로 남긴다', ev[0] && ev[0].toolCalls, null);
}

// ── ③ 이어받는 회차 → 안 함 ───────────────────────────────────
{
  const { ev } = await run(
    { ...OKR, text: '', isError: true, subtype: 'error', toolCalls: 0 },
    { ...OPTS, resumeSessionId: 'abc' });
  eq('이어받는 회차는 폴백 안 함', ev.map((e) => e.skipped), ['resume']);
}

// ── 도구 0회로 실패 → 폴백을 부르러 간다 ──────────────────────
{
  const { ev } = await run({ ...OKR, text: '', isError: true, subtype: 'error', toolCalls: 0 });
  eq('도구 0회 실패는 폴백을 부르러 간다',
     ev.map((e) => [e.skipped ?? null, e.why, e.ok]), [[null, 'error', false]]);
}

// ── 1차가 던져도 폴백을 부르러 간다 ───────────────────────────
{
  const { ev } = await run(() => { throw new Error('토큰을 못 가져왔다(시험)'); });
  eq('던진 것도 폴백을 부르러 간다',
     ev.map((e) => [e.skipped ?? null, e.why, e.ok]), [[null, 'threw', false]]);
}

// ── 빈손으로 끝난 회차 ────────────────────────────────────────
{
  const { ev } = await run({ ...OKR, text: '   ', toolCalls: 0 });
  eq('빈손도 폴백을 부르러 간다', ev.map((e) => e.why), ['empty']);
}

delete process.env.BOARD_NARROW_CODEX_BIN;
delete process.env.WORK_EVENTS_FILE;
try { fs.unlinkSync(evFile); } catch { /* 없으면 그만 */ }

// ── 소스: 예약 세션이 폴백을 안 거치고 새는 곳이 없나 ─────────
const src = fs.readFileSync(path.join(ROOT, 'src', 'assistant-scheduler.ts'), 'utf-8');
const direct = [...src.matchAll(/await this\.spawnSession\(/g)].length;
// 둘만 정상이다 — 좁은 길(제 폴백이 따로 있다)과 `spawnOrFallback` 자기 자신.
eq('폴백을 안 거치는 직접 호출은 둘뿐 (좁은 길 · 폴백 자신)', direct, 2);

if (fails.length) {
  console.error(`\n실패 ${fails.length}건\n\n  ✗ ${fails.join('\n\n  ✗ ')}\n`);
  process.exitCode = 1;
} else {
  console.log('통과 — 주 작업 폴백 (도구 돌린 뒤 · 몇 번인지 모름 · 이어받기 셋 다 안 함 · '
    + '던짐·빈손·도구 0회는 부르러 감 · 새는 호출 없음)');
}
