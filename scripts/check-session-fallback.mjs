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
 * codex 한 차례(`codexTurn` · 2026-10-14)도 여기서 잰다 — 가짜 codex(`lib/fake-codex.mjs`)로
 * 환경 변수가 닿나 · 모래상자 깃발 · 이벤트에서 한 일 · 한도 글 → 엔진 상태 · Claude 가 막혔으면 1차를
 * 안 띄움 · codex 한도 조회가 소진이면 codex 를 안 부름.
 *
 * **외부 서비스를 안 부른다** — 없는 실행체나 가짜 codex 를 넣어 「부르러 갔나」만 잰다.
 */
import './lib/fresh-dist.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeFakeCodex } from './lib/fake-codex.mjs';

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
// 엔진 상태 · 브리핑 자국 · 재시도 계획도 임시로 — 운영 파일을 읽으면 그날 막힘에 따라 결과가 바뀌고,
// 쓰면 운영 봇이 codex 를 건너뛴다.
const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sessionfb-'));
const engineFile = path.join(STATE_DIR, 'engine-state.json');
process.env.ENGINE_STATE_FILE = engineFile;
process.env.BRIEFING_DELIVERED_FILE = path.join(STATE_DIR, 'briefing-delivered.json');
process.env.ANALYSIS_RETRY_FILE = path.join(STATE_DIR, 'analysis-retry.json');
// 업무 비서 홈도 임시로 — 쓰기 차례가 끝나면 봇이 볼트를 대신 커밋한다(2026-10-19). 홈이 운영 레포면 **진짜 볼트**에
// 커밋한다. 임시 홈의 설정이 가리키는 볼트는 시험용 git 저장소다(⑧).
const WA_HOME = path.join(STATE_DIR, 'wa-home');
const VAULT = path.join(STATE_DIR, 'vault');
fs.mkdirSync(WA_HOME, { recursive: true });
fs.mkdirSync(VAULT, { recursive: true });
fs.writeFileSync(path.join(WA_HOME, 'config.json'), JSON.stringify({ vault_dir: VAULT }), 'utf-8');
process.env.WORK_ASSISTANT_HOME = WA_HOME;
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

// ── ②-2 읽기 도구만 돌린 뒤 실패 → 넘긴다 · 쓰기 도구가 하나라도 돌았으면 안 넘긴다 (2026-10-15 검토) ──
//   예약 일도 다음 엔진으로 넘기는 것이 사용자 결정이다. 읽기만 했으면 다시 해도 생기는 일이 없다.
{
  const { ev } = await run({ ...OKR, text: '', isError: true, subtype: 'error', toolCalls: 3, writeToolCalls: 0 });
  eq('읽기 도구만 돈 뒤 실패면 폴백을 부르러 간다', ev.map((e) => [e.skipped ?? null, e.why]), [[null, 'error']]);
  const w = await run({ ...OKR, text: '', isError: true, subtype: 'error', toolCalls: 3, writeToolCalls: 1 });
  eq('쓰기 도구가 하나라도 돌았으면 안 넘긴다', w.ev.map((e) => [e.skipped, e.writeToolCalls]), [['tools-ran', 1]]);
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

// ── codex 한 차례 — 가짜 codex 로 실행해서 잰다 (2026-10-14) ─────────────
const fake = makeFakeCodex();
const wa = await import('../dist/work-assistant.js');
const { engineState } = await import('../dist/engine-state.js');
const { codexQuota, applyQuota } = await import('../dist/codex-quota.js');
const { primaryReadOnly } = await import('../dist/assistant-scheduler.js');
const resetEngine = () => fs.rmSync(engineFile, { force: true });
// 부르는 쪽이 얹은 값만 닿아야 한다 — 이 프로세스에 같은 이름이 있으면 「닿았다」를 못 가른다.
delete process.env.CLAUDE_SCHEDULED;
delete process.env.WORK_ASSISTANT_CAPTURE_FILE;
// 가짜 값 — codex 에 넘어가면 안 된다(`child-env.ts`).
process.env.ANTHROPIC_API_KEY = 'test-not-a-key';
process.env.BOARD_NARROW_CODEX_BIN = fake.bin;
codexQuota.forget();
const FAIL0 = { ...OKR, text: '', isError: true, subtype: 'error', toolCalls: 0 };
const ENV = { CLAUDE_SCHEDULED: '1', WORK_ASSISTANT_CAPTURE_FILE: 'cap-시험.json' };
const WRITE = { ...OPTS, allowedTools: ['Read', 'Write', 'Bash'], env: ENV };
const turn = (sandbox, extra = {}) => wa.codexTurn('말', { workingDirectory: os.tmpdir(), sandbox, writableDirs: [], ...extra });
try {
  // ① 부르는 쪽 환경 변수가 codex 까지 닿는다 · API 키는 안 닿는다 · 쓰기 차례 깃발
  {
    resetEngine();
    process.env.FAKE_CODEX_MODE = 'ok';
    const n0 = fake.calls().length;
    const { out } = await run(FAIL0, WRITE);
    const c = fake.calls().slice(n0);
    eq('가짜 codex 를 한 번 부른다', c.length, 1);
    eq('부르는 쪽 환경 변수(CLAUDE_SCHEDULED · 캡처 파일)가 codex 까지 닿는다', c[0]?.env, ENV);
    eq('API 키는 codex 에 안 넘긴다', c[0]?.apiKey, false);
    const a = c[0]?.argv ?? [];
    ok(`쓰기 차례는 --approve-for-me 만 (받음 ${a.join(' ')})`, a.includes('--approve-for-me') && !a.includes('-s'));
    ok('이벤트를 읽게 --json', a.includes('--json'));
    eq('codex 가 받은 답 · 처리 백엔드', [out.text, out.servedBy], ['☀️ codex 답', 'codex']);
    ok('된 차례는 엔진 상태에 「됐다」', engineState.load().engines.codex.lastOkAt !== null);
  }

  // ② 1차가 읽기 도구뿐이면 읽기 전용 모래상자 — 쓰기 폴더도 안 연다(폴백이 1차보다 넓게 안 씀)
  {
    const n0 = fake.calls().length;
    await run(FAIL0, { ...OPTS, allowedTools: ['Read', 'Glob', 'Grep'], env: ENV });
    const a = fake.calls().slice(n0)[0]?.argv ?? [];
    ok(`읽기 전용 1차 → -s read-only (받음 ${a.join(' ')})`, a[a.indexOf('-s') + 1] === 'read-only');
    ok('읽기 전용이면 --approve-for-me 없음', a.length > 0 && !a.includes('--approve-for-me'));
    ok('읽기 전용이면 쓰기 폴더(--add-dir)를 안 연다', a.length > 0 && !a.includes('--add-dir'));
    eq('브리핑 도구(Read · Glob · Grep · 달력 읽기)는 읽기 전용',
       primaryReadOnly({ allowedTools: ['Read', 'Glob', 'Grep', 'mcp__google-calendar__list-events'] }), true);
    eq('쓰기 도구가 하나라도 있으면 읽기 전용 아님', primaryReadOnly({ allowedTools: ['Read', 'Write'] }), false);
    eq('도구 목록이 없으면 읽기 전용 아님', primaryReadOnly({}), false);
    eq('trust 는 allowedTools 로 못 막아 읽기 전용 아님', primaryReadOnly({ allowedTools: ['Read'], permissionMode: 'trust' }), false);
    eq('tools 가 읽기뿐이면 읽기 전용', primaryReadOnly({ tools: ['Read', 'Grep'] }), true);
  }

  // ③ 이벤트에서 한 일 · 썼을 수 있나 · 답
  {
    process.env.FAKE_CODEX_MODE = 'ok';
    const w = await turn('workspace-write');
    eq('명령마다 한 줄 · 끝났나', w.steps.map((s) => [s.cmd.slice(0, 31), s.done]),
       [['python -X utf8 bin/tasks.py log', true], ['xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', false]]);
    ok(`긴 명령은 120자 안으로 (받음 ${w.steps[1]?.cmd.length})`, (w.steps[1]?.cmd.length ?? 999) <= 120);
    eq('쓰기 차례에서 명령이 시작했으면 writeRan', [w.kind, w.writeRan], ['ok', true]);
    const r = await turn('read-only');
    eq('읽기 전용 차례는 writeRan 아님', [r.kind, r.writeRan, r.steps.length], ['ok', false, 2]);
    process.env.FAKE_CODEX_NO_OUT = '1';
    const e = await turn('read-only');
    eq('-o 파일이 비면 마지막 agent_message 가 답', e.text, '이벤트 쪽 답');
    delete process.env.FAKE_CODEX_NO_OUT;
  }

  // ④ 한도 글 → 엔진 상태에 codex 막힘 · 그 밖의 실패는 안 적음
  {
    resetEngine();
    process.env.FAKE_CODEX_MODE = 'fail';
    const f = await turn('read-only');
    eq('그 밖의 실패는 fail · 답 없음 · 막힘 안 적음', [f.kind, f.text, engineState.isBlocked('codex')], ['fail', '', false]);
    process.env.FAKE_CODEX_MODE = 'usage-event';
    const t0 = Math.floor(Date.now() / 1000);
    const u = await turn('read-only');
    eq('한도 이벤트(turn.failed) → usage · 답 없음', [u.kind, u.text], ['usage', '']);
    ok(`풀리는 시각을 글에서 읽는다(2시간 5분 · 받음 ${u.resetsAt ? u.resetsAt - t0 : '없음'}초)`,
       typeof u.resetsAt === 'number' && Math.abs(u.resetsAt - t0 - 7500) < 30);
    ok('엔진 상태에 codex 막힘(그 시각까지)', engineState.isBlocked('codex') && engineState.blocked('codex')?.until === u.resetsAt);
    resetEngine();
    process.env.FAKE_CODEX_MODE = 'usage-stderr';
    const s = await turn('read-only');
    eq('표준 오류의 429 → usage', s.kind, 'usage');
    ok('시각을 모르면 엔진 상태가 정한 다시 볼 시각까지 막힘',
       engineState.isBlocked('codex') && engineState.blocked('codex')?.untilKnown === false);
  }

  // ⑤ codex 가 막혀 있으면 폴백을 안 부른다(④ 의 막힘이 남아 있다)
  {
    process.env.FAKE_CODEX_MODE = 'ok';
    const n0 = fake.calls().length;
    const { out, ev } = await run(FAIL0, WRITE);
    eq('codex 가 막혔으면 부르지 않는다', fake.calls().length - n0, 0);
    eq('건너뛴 까닭을 남긴다', ev.map((e) => e.skipped), ['codex-blocked']);
    ok('1차 결과를 그대로 돌려준다', out.isError === true && out.servedBy === 'claude');
  }

  // ⑥ 한도 조회가 소진이면 codex 를 안 부른다 · 못 읽으면 「모름」이라 부른다
  {
    resetEngine();
    const now = Math.floor(Date.now() / 1000);
    codexQuota.forget();
    codexQuota.fetch = async () => ({ plan: 'team', primary: { used_percent: 100, window_mins: 300, resets_at: now + 3600 },
      secondary: { used_percent: 40, window_mins: 10080, resets_at: now + 86400 }, reached: null, error: null });
    const n0 = fake.calls().length;
    const { ev } = await run(FAIL0, WRITE);
    eq('한도 조회가 소진이면 codex 를 안 부른다', [fake.calls().length - n0, ev.map((e) => e.skipped)], [0, ['codex-blocked']]);
    eq('막힘은 다 쓴 창이 풀리는 시각까지', engineState.blocked('codex')?.until, now + 3600);
    const util = engineState.load().engines.codex.util ?? {};
    eq('사용률도 적는다(0~1)', [util.five_hour, util.seven_day], [1, 0.4]);
    let asked = 0;
    codexQuota.fetch = async () => { asked += 1; return null; };
    await codexQuota.refresh();
    eq('5분 안에는 다시 안 묻고 앞 답을 쓴다', asked, 0);

    resetEngine();
    codexQuota.forget();
    codexQuota.fetch = async () => ({ error: '조회 실패(시험)' });
    const n1 = fake.calls().length;
    const { out } = await run(FAIL0, WRITE);
    eq('조회를 못 하면 모름 — codex 를 부른다', [fake.calls().length - n1, out.servedBy], [1, 'codex']);
    codexQuota.forget();
    codexQuota.fetch = async () => { throw new Error('터짐(시험)'); };
    eq('조회가 던져도 모름(안 던진다)', await codexQuota.refresh(), 'unknown');
    resetEngine();
    eq('reached 만 차 있어도 소진', applyQuota({ primary: { used_percent: 50 }, reached: 'workspace_owner_credits_depleted' }), 'exhausted');
    // 남은 양이 있다고 읽히면 사용량 소진 막힘을 지운다 — 마지막 성공은 안 고친다 · 과부하는 그대로
    resetEngine();
    const later = Math.floor(Date.now() / 1000) + 3600;
    engineState.recordBlocked('codex', { kind: 'usage', until: later });
    eq('남은 양이 있으면 사용량 막힘을 지움', [applyQuota({ primary: { used_percent: 30 }, secondary: { used_percent: 40 } }),
      engineState.isBlocked('codex'), engineState.load().engines.codex.lastOkAt], ['ok', false, null]);
    engineState.recordBlocked('codex', { kind: 'usage', until: later, limitType: 'seven_day' });
    applyQuota({ primary: { used_percent: 30 } });
    eq('막힌 창(7일)을 이번에 못 읽었으면 그대로', engineState.isBlocked('codex'), true);
    resetEngine();
    engineState.recordBlocked('codex', { kind: 'overload' });
    applyQuota({ primary: { used_percent: 30 }, secondary: { used_percent: 40 } });
    eq('과부하는 한도 조회로 안 지움', engineState.blocked('codex')?.kind, 'overload');
    resetEngine();
    codexQuota.forget();
    codexQuota.fetch = async () => null;
  }

  // ⑦ Claude 가 막혀 있다고 엔진 상태가 말하면 1차를 안 띄운다
  {
    resetEngine();
    engineState.recordBlocked('claude', { kind: 'usage', until: Math.floor(Date.now() / 1000) + 3600 });
    let spawned = 0;
    const sched = new AssistantScheduler(async () => {}, async () => { spawned += 1; return OKR; }, config.assistant.configDir);
    process.env.FAKE_CODEX_MODE = 'ok';
    const r = await sched.spawnOrFallback('시험', '말', WRITE);
    eq('Claude 가 막혀 있으면 1차를 안 띄우고 codex 가 받는다', [spawned, r.servedBy, r.text], [0, 'codex', '☀️ codex 답']);
    const rr = await sched.spawnOrFallback('시험', 'continue', { ...OPTS, resumeSessionId: 'abc' });
    eq('이어받는 회차는 한도 결과로 돌아간다(1차도 폴백도 없음)', [spawned, rr.rateLimited, rr.isError], [0, true, true]);
    resetEngine();
    const r2 = await sched.spawnOrFallback('시험', '말', WRITE);
    eq('풀리면 1차를 띄운다', [spawned, r2.servedBy], [1, 'claude']);
  }

  // ⑧ 쓰기 차례가 끝나면 봇이 볼트를 대신 커밋한다(2026-10-19) — codex 모래상자는 `.git` 을 읽기 전용으로 둬서
  //    `tasks.py` 의 커밋이 넘어진다. 바뀐 것이 있을 때만 · 읽기 전용 차례는 안 함 · `GIT_DIR` 이 남아 있어도 볼트에.
  {
    const { spawnSync } = await import('node:child_process');
    const git = (...a) => spawnSync('git', ['-C', VAULT, ...a], { encoding: 'utf-8' });
    const count = () => Number(git('rev-list', '--count', 'HEAD').stdout.trim());
    const dirty = () => git('status', '--porcelain').stdout.trim() !== '';
    git('init', '-q');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'test');
    git('commit', '-q', '--allow-empty', '-m', 'init');
    resetEngine();
    process.env.FAKE_CODEX_MODE = 'ok';
    fs.writeFileSync(path.join(VAULT, 'TSK-1.md'), '진행 로그\n', 'utf-8');
    const w = await turn('workspace-write', { label: '시험 볼트' });
    eq('쓰기 차례 뒤 커밋 안 된 변경 → 봇이 커밋', [w.writeRan, count(), dirty()], [true, 2, false]);
    eq('메시지는 [GPT 대신 커밋] <이름>', git('log', '-1', '--format=%s').stdout.trim(), '[GPT 대신 커밋] 시험 볼트');
    const again = await turn('workspace-write', { label: '시험 볼트' });
    eq('커밋할 것이 없으면 새 커밋 없음 · 차례는 그대로 ok', [again.kind, count()], ['ok', 2]);
    eq('커밋할 것이 없으면 nothing', await wa.commitVaultAfterCodex('시험', VAULT), 'nothing');
    fs.writeFileSync(path.join(VAULT, 'TSK-2.md'), '읽기만\n', 'utf-8');
    await turn('read-only');
    eq('읽기 전용 차례는 대신 커밋 안 함', [count(), dirty()], [2, true]);
    process.env.FAKE_CODEX_MODE = 'usage-after-write';
    const prevGitDir = process.env.GIT_DIR;
    process.env.GIT_DIR = path.join(STATE_DIR, 'not-a-repo');
    const u = await turn('workspace-write', { label: '시험 볼트' });
    if (prevGitDir === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = prevGitDir;
    eq('쓰다가 한도에 걸린 차례도 커밋 · GIT_DIR 이 남아 있어도 볼트에', [u.kind, u.writeRan, count(), dirty()], ['usage', true, 3, false]);
    eq('저장소가 아니면 failed(안 던짐)', await wa.commitVaultAfterCodex('시험', path.join(STATE_DIR, 'no-such-vault')), 'failed');
    eq('볼트를 모르면 skipped', await wa.commitVaultAfterCodex('시험', null), 'skipped');
    resetEngine();
  }
} finally {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.FAKE_CODEX_MODE;
  fake.cleanup();
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
  const { codexWritableDirs, codexTurnArgs } = await import('../dist/work-assistant.js');
  const dirs = codexWritableDirs();
  // 여기가 비면 폴백이 도는 것처럼 보이면서 `tasks.py` 마다 넘어진다 —
  // `analyze()` 가 상태 파일을 쓰기 때문이다.
  ok(`작업 디렉터리 밖에 쓸 곳을 찾는다 (${dirs.length}곳)`, dirs.length >= 1);

  // 실제로 넘기는 깃발 묶음 그대로(`codexTurnArgs`) — 쓰기 · 읽기 전용 둘 다. 손으로 다시 적으면
  // 코드와 어긋난 묶음을 재게 된다.
  const outFile = path.join(STATE_DIR, 'flag-check.out.txt');
  for (const sandbox of ['workspace-write', 'read-only']) {
    const flags = codexTurnArgs({ workingDirectory: os.tmpdir(), sandbox, model: 'gpt-6.1-sol', effort: 'low' }, outFile);
    ok(`${sandbox} — --sandbox 와 --approve-for-me 를 같이 안 준다`, !(flags.includes('-s') && flags.includes('--approve-for-me')));
    const r = spawnSync('codex', flags, {
      input: '', encoding: 'utf-8', shell: process.platform === 'win32', timeout: 30_000,
    });
    const err = `${r.stderr || ''}${r.stdout || ''}`;
    if (r.error && r.error.code === 'ENOENT') {
      notes.push('codex 가 없어 깃발 검증을 못 했다 — 통과가 아니라 안 본 것');
      break;
    }
    const first = err.trim().split('\n')[0];
    ok(`${sandbox} — 깃발이 서로 안 부딪힌다 (rc ${r.status} · ${first})`,
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
  // 놓친 브리핑은 이제 「올린 날」 자국으로 본다(`check:briefing`). 자국이 아직 없는 첫날만 옛 기준(원장)을
  // 쓰는데, 그때도 폴백이 돌다 실패한 브리핑을 「오늘 돌았다」로 읽으면 재시작 뒤 따라잡기가 안 돈다.
  ok('옛 기준(원장)은 실패한 폴백 회차를 「돌았다」로 안 친다',
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

fs.rmSync(STATE_DIR, { recursive: true, force: true });

if (notes.length) console.log('\n⚠️  ' + notes.join('\n⚠️  '));
if (fails.length) {
  console.error(`\n실패 ${fails.length}건\n\n  ✗ ${fails.join('\n\n  ✗ ')}\n`);
  process.exitCode = 1;
} else {
  console.log('통과 — 주 작업 폴백 (도구 돌린 뒤 · 몇 번인지 모름 · 이어받기 셋 다 안 함 · '
    + '던짐·빈손·도구 0회는 부르러 감 · 새는 호출 없음 · codex 환경 변수 · 모래상자 · 한 일 · '
    + '한도 → 엔진 상태 · Claude 막힘이면 1차 안 띄움 · codex 소진이면 안 부름 · 읽기 도구만 돌았으면 넘김)');
}
