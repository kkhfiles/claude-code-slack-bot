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
const notes = [];
const eq = (label, got, want) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    fails.push(`${label}\n    받음 ${JSON.stringify(got)}\n    기대 ${JSON.stringify(want)}`);
  }
};
const ok = (label, cond) => { if (!cond) fails.push(label); };

const evFile = path.join(os.tmpdir(), `wa-sev-${Date.now()}.jsonl`);
// 비용 원장도 임시 파일로 — **import 보다 먼저**(모듈이 읽을 때 경로를 굳힌다).
const costFile = path.join(os.tmpdir(), `wa-cost-${Date.now()}.json`);
process.env.ASSISTANT_COSTS_FILE = costFile;
process.env.WORK_EVENTS_FILE = evFile;
// 폴백이 실제로 불리는지만 보고 싶다 — 없는 실행체를 주면 빈손으로 돌아온다.
process.env.BOARD_NARROW_CODEX_BIN = 'codex-없는-이름-2026';
// 등급 사다리(파이썬)도 같은 까닭으로 — 없는 실행체면 표도 사다리도 빈손으로 물러난다(2026-09-23).
process.env.LADDER_PYTHON = 'python-없는-이름-2026';

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

// ── 어느 길로 넘기나 — 도구 없는 회차는 사다리, 도구를 쓰는 회차는 codex 세션 (2026-09-23) ──
// 도구 없는 회차를 codex 세션으로 넘기면 작업 폴더 쓰기 권한까지 붙어 1차보다 권한이 넓어진다.
{
  const { ev } = await run({ ...OKR, text: '', isError: true, subtype: 'error', toolCalls: 0 },
                           { ...OPTS, tools: [], model: 'sonnet' });
  eq('도구 없는 회차는 사다리로 간다(codex 세션을 안 부른다)', ev.map((e) => [e.ok, e.via]), [[false, '']]);
}
{
  const { ev } = await run({ ...OKR, text: '', isError: true, subtype: 'error', toolCalls: 0 },
                           { ...OPTS, model: 'opus' });
  ok(`도구를 쓰는 회차는 codex 세션으로 간다 (via ${ev[0] && ev[0].via})`,
     ev.length === 1 && String(ev[0].via).startsWith('codex'));
}

delete process.env.BOARD_NARROW_CODEX_BIN;
delete process.env.LADDER_PYTHON;
delete process.env.WORK_EVENTS_FILE;
try { fs.unlinkSync(evFile); } catch { /* 없으면 그만 */ }

// ── 실행체가 이 깃발 묶음을 받아 주나 (모델은 안 부른다) ──────
//
// **빈 입력을 준다** — codex 는 인자를 먼저 검증하므로, 깃발이 어긋나면
// rc 2 로 「cannot be used with」 를 내고 **모델을 안 부른다.** 정상이면
// 「No prompt provided via stdin」(rc 1)에서 멈춘다.
//
// 이 검사가 없어서 `-s workspace-write` 와 `--approve-for-me` 를 같이 준 판이
// **매번 rc 2 로 죽는 채로** 나갔다(2026-09-04). 앞선 검사는 없는 실행체로
// 「실패하면 빈손」만 봤지 **성공 경로를 한 번도 안 봤다.**
{
  const { spawnSync } = await import('node:child_process');
  const { codexWritableDirs } = await import('../dist/work-assistant.js');
  const dirs = codexWritableDirs();
  // 여기가 비면 폴백이 도는 것처럼 보이면서 `tasks.py` 마다 넘어진다 —
  // `analyze()` 가 상태 파일을 쓰기 때문이다.
  ok(`작업 디렉터리 밖에 쓸 곳을 찾는다 (${dirs.length}곳)`, dirs.length >= 1);

  const flags = [
    'exec', '--ephemeral', '--skip-git-repo-check',
    ...dirs.flatMap((d) => ['--add-dir', d]),
    '--approve-for-me', '--color', 'never',
    '-C', os.tmpdir(), '-m', 'gpt-6.1-sol',
    '-c', 'model_reasoning_effort=low', '-',
  ];
  const r = spawnSync('codex', flags, {
    input: '', encoding: 'utf-8', shell: process.platform === 'win32', timeout: 30_000,
  });
  const err = `${r.stderr || ''}${r.stdout || ''}`;
  if (r.error && r.error.code === 'ENOENT') {
    notes.push('codex 가 없어 깃발 검증을 못 했다 — 통과가 아니라 안 본 것');
  } else {
    const first = err.trim().split('\n')[0];
    ok(`깃발이 서로 안 부딪힌다 (rc ${r.status} · ${first})`,
       !/cannot be used with|unexpected argument|invalid value/i.test(err));
  }
}

// ── 폴백이 받은 회차도 원장에 남는다 (2026-10-02) ─────────────
// 구독이라 값이 0 이어서 원장이 통째로 걸렀다 — 원장만 보면 폴백이 한 번도 안 돈 것처럼 보였다.
// ⚠️ **진짜 원장에 안 쓴다** — 저장을 막고 메모리의 목록만 본다(기본 checkout 에서 돌면 진짜 파일이다).
{
  const sched = new AssistantScheduler(async () => {}, async () => OKR, config.assistant.configDir);
  sched.saveCosts = () => {};
  const n0 = sched.costEntries.length;
  sched.recordSessionCost('briefing', { text: '됨', costUsd: 0, sessionId: '', subtype: 'success',
    isError: false, servedBy: 'codex', timing: { resultMs: 1234 } });
  sched.recordSessionCost('briefing', { text: '', costUsd: 0, sessionId: '', subtype: 'error', isError: true });
  const got = sched.costEntries.slice(n0).map((e) => [e.type, e.costUsd, e.via, e.ok, e.resultMs]);
  eq('폴백 회차는 값 0 · 백엔드 · 성패 · 걸린 시간으로 남고, 값 0 인 1차 실패는 그대로 안 남는다',
     got, [['briefing', 0, 'codex', true, 1234]]);
  // 폴백이 돌다 실패한 브리핑을 「오늘 돌았다」로 읽으면 재시작 뒤 따라잡기가 안 돈다.
  ok('따라잡기는 실패한 폴백 회차를 「돌았다」로 안 친다',
     /e\.type === 'briefing' && e\.ok !== false/.test(
       fs.readFileSync(path.join(ROOT, 'src', 'assistant-scheduler.ts'), 'utf-8')));
}

// ── ⛔ 원장을 읽지 않은 스케줄러는 원장에 쓰지 않는다 (2026-10-02 사고) ──
// 시험이 `start()` 없이 만든 스케줄러가 폴백 회차를 남기다 운영 원장 382건을 1건으로 덮었다.
{
  const seed = [1, 2, 3].map((n) => ({ timestamp: new Date().toISOString(), type: `t${n}`, costUsd: 0.1, sessionId: `s${n}` }));
  fs.writeFileSync(costFile, JSON.stringify({ entries: seed }));
  const cold = new AssistantScheduler(async () => {}, async () => OKR, config.assistant.configDir);
  cold.recordFallbackRun('narrow', 'codex', 10, false);
  cold.recordCost('briefing', 0.5, 's9');
  eq('읽기 전에는 원장을 안 덮는다', JSON.parse(fs.readFileSync(costFile, 'utf-8')).entries.length, 3);
  const warm = new AssistantScheduler(async () => {}, async () => OKR, config.assistant.configDir);
  warm.loadCosts();
  warm.recordFallbackRun('narrow', 'codex', 10, false);
  eq('읽은 뒤에는 이어 쓴다', JSON.parse(fs.readFileSync(costFile, 'utf-8')).entries.map((e) => e.type),
     ['t1', 't2', 't3', 'narrow']);
  fs.writeFileSync(costFile, '깨진 원장');
  const broken = new AssistantScheduler(async () => {}, async () => OKR, config.assistant.configDir);
  broken.loadCosts();
  broken.recordFallbackRun('narrow', 'codex', 10, false);
  eq('읽다 실패한 원장도 안 덮는다', fs.readFileSync(costFile, 'utf-8'), '깨진 원장');
  fs.rmSync(costFile, { force: true });
}

// ── 소스: 예약 세션이 폴백을 안 거치고 새는 곳이 없나 ─────────
const src = fs.readFileSync(path.join(ROOT, 'src', 'assistant-scheduler.ts'), 'utf-8');
const direct = [...src.matchAll(/await this\.spawnSession\(/g)].length;
// 둘만 정상이다 — 좁은 길(제 폴백이 따로 있다)과 `spawnOrFallback` 자기 자신.
eq('폴백을 안 거치는 직접 호출은 둘뿐 (좁은 길 · 폴백 자신)', direct, 2);

if (notes.length) console.log('\n⚠️  ' + notes.join('\n⚠️  '));
if (fails.length) {
  console.error(`\n실패 ${fails.length}건\n\n  ✗ ${fails.join('\n\n  ✗ ')}\n`);
  process.exitCode = 1;
} else {
  console.log('통과 — 주 작업 폴백 (도구 돌린 뒤 · 몇 번인지 모름 · 이어받기 셋 다 안 함 · '
    + '던짐·빈손·도구 0회는 부르러 감 · 새는 호출 없음)');
}
