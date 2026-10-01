/**
 * 분석 회차가 report-log 에 쓰는 길 — 5단계(쓰는 쪽 전환) 스탠리 몫.
 *
 *   npm run build
 *   npm run check:reportrun
 *
 * 무엇을 재나 — 계획 `report-log/docs/stage5-plan.md` 「쓰는 흐름」 의 스탠리 차례.
 *
 *   - 회차 열기 · 예정일(예약 발화 시각의 한국 날짜) · 재시도는 같은 회차 · 수동은 오늘
 *   - 프롬프트 자리 치환 · 남은 `{{` 면 세션을 안 띄움
 *   - 쓰기 범위(임시 파일 폴더) · 저장 시점 · 「썼나」 판정 · 처리 백엔드
 *   - 러너 미리 띄우기의 환경 변수 · `--date` · 월요일 보고의 `{{WEEK_INPUT}}`
 *   - agy 위임 경로가 걷혔나
 *
 * **외부를 안 부른다** — report-log 명령은 가짜(`deps.reportLog`)로, 세션은 가짜
 * `spawnSession` 으로, 러너 기동은 인스턴스에서 갈아 끼운다. 상태 경로는 **모듈을
 * 읽기 전에** 임시 폴더로 돌린다 — 경로를 모듈이 읽힐 때 잡는 곳이 있어, 늦게 돌리면
 * 시험이 운영 상태 파일에 한 줄을 남긴다(앞서 실제로 그랬다).
 */
import './lib/fresh-dist.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'report-run-'));
const STATE = path.join(TMP, 'report-log-state');
process.env.REPORT_LOG_STATE = STATE;
process.env.REPORT_LOG_REPO = path.join(TMP, 'report-log-없는-클론');
process.env.WORK_EVENTS_FILE = path.join(TMP, 'events.jsonl');
process.env.WORK_ASSISTANT_STATE = path.join(TMP, 'wa-state');
// 폴백이 진짜 실행체를 부르지 않게 — 없는 이름이면 빈손으로 물러난다.
process.env.BOARD_NARROW_CODEX_BIN = 'codex-없는-이름-2026';
process.env.LADDER_PYTHON = 'python-없는-이름-2026';
fs.mkdirSync(path.join(STATE, 'tmp'), { recursive: true });

const require = createRequire(import.meta.url);

const fails = [];
const eq = (label, got, want) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    fails.push(`${label}\n    받음 ${JSON.stringify(got)}\n    기대 ${JSON.stringify(want)}`);
  }
};
const ok = (label, cond) => { if (!cond) fails.push(label); };

/** 주석을 지운 소스 — 규칙을 설명하는 주석이 위반으로 걸리지 않게. */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const SRC = path.join(ROOT, 'src');
const schedSrc = stripComments(fs.readFileSync(path.join(SRC, 'assistant-scheduler.ts'), 'utf-8'));

const S = require('../dist/assistant-scheduler.js');
const { AssistantScheduler } = S;
const wa = require('../dist/work-assistant.js');
const ladder = require('../dist/model-ladder.js');

// ── 임시 레포 모양 — assistant/config.json + prompts ─────────────────
const REPO = path.join(TMP, 'repo');
const CFG = path.join(REPO, 'assistant');
const PROMPTS = path.join(CFG, 'prompts');
fs.mkdirSync(PROMPTS, { recursive: true });
const writeConfig = (extra = {}) => fs.writeFileSync(path.join(CFG, 'config.json'), JSON.stringify({
  briefing: { time: '08:00', enabled: false, excludeCalendars: [] },
  reminders: { enabled: false, beforeMinutes: 15, pollingIntervalMinutes: 5,
    workingHoursStart: '08:00', workingHoursEnd: '20:00' },
  analysis: {
    schedule: 'saturday-00:00',
    defaults: { allowedTools: ['Read', 'Write'], writablePaths: ['reports/', 'references/'], maxRetries: 1 },
    types: {
      probe: { enabled: true, model: 'sonnet', effort: 'low' },
      second: { enabled: true, model: 'sonnet', effort: 'low' },
      third: { enabled: true, model: 'sonnet', effort: 'low' },
      'kg-regression': { enabled: true, model: 'sonnet', effort: 'low' },
      ...extra,
    },
  },
}), 'utf-8');
writeConfig();
const writePrompt = (type, body) => fs.writeFileSync(path.join(PROMPTS, `analysis-${type}.md`), body, 'utf-8');
for (const t of ['probe', 'second', 'third', 'kg-regression']) {
  writePrompt(t, `# ${t}\n\n보고서를 {{REPORT_OUT}} 에 쓴다. 예정일 {{SLOT}}.\n`);
}

const argOf = (args, flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };

/**
 * 가짜 report-log — 부른 명령을 모으고 약속대로 답한다. `commit` 답은 차례로 줄 수 있다
 * (잠금 실패 → 성공 같은 순서). 회차 번호는 부를 때마다 새로 짓는다.
 */
function fakeReportLog(o = {}) {
  const calls = [];
  let n = 0;
  const commits = [...(o.commits ?? [])];
  const fn = async (script, args) => {
    calls.push([script, ...args]);
    const cmd = args[0];
    if (cmd === 'open') {
      if (o.openError) return { error: o.openError };
      n += 1;
      const type = argOf(args, '--type');
      const slot = argOf(args, '--slot');
      const runId = `${slot}-${type}-r${n}`;
      return { run_id: runId, out: path.join(STATE, 'tmp', `${runId}.md`), type, slot };
    }
    if (cmd === 'commit') {
      if (commits.length) return commits.shift();
      return { run_id: argOf(args, '--run'), id: 'x/y', status: args.includes('--partial') ? 'partial' : 'complete' };
    }
    if (cmd === 'prompt-context') return o.context ?? { prev: null, avoid: [] };
    if (cmd === 'week-input') return o.week ?? [];
    return { error: `가짜 report-log 가 모르는 명령: ${cmd}` };
  };
  const of = (cmd) => calls.filter((c) => c[1] === cmd);
  return { fn, calls, of };
}

/** 회차마다 다른 결과를 주는 가짜 세션 · 가짜 report-log 를 꽂은 스케줄러. */
function harness({ results = [], rl = fakeReportLog(), onSpawn } = {}) {
  const spawns = [];
  const sent = [];
  const launches = [];
  const sched = new AssistantScheduler(
    async (text) => { sent.push(text); },
    async (prompt, opts) => {
      spawns.push({ prompt, opts });
      if (onSpawn) onSpawn(spawns.length, prompt, opts);
      const r = results.shift();
      if (!r) throw new Error('예상보다 많이 불렀다');
      return typeof r === 'function' ? r(prompt, opts) : { ...r };
    },
    CFG,
    undefined,
    { reportLog: rl.fn },
  );
  sched.loadConfig();
  sched.recordSessionCost = () => {};            // 비용 원장(실파일)에 안 남긴다
  sched.launchPipelineRunner = async (...a) => { launches.push(a); };  // 진짜 러너를 안 띄운다
  return { sched, spawns, sent, launches, rl };
}

const WORKED = { text: '보고서를 썼다', costUsd: 0.01, sessionId: 's1', subtype: 'success', isError: false, toolCalls: 4 };

const JOURNAL_DIR = path.join(REPO, 'reports', 'pipeline-runs');
/** 이 스케줄의 시도 기록(저널) 줄 — 회차 번호가 실렸는지 본다. */
function journal(schedule = 'saturday-00:00') {
  const slug = schedule.replace(/[^A-Za-z0-9]+/g, '-');
  const file = path.join(JOURNAL_DIR, `${S.kstDate(new Date())}-analysis-${slug}.jsonl`);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
const resetJournal = () => fs.rmSync(JOURNAL_DIR, { recursive: true, force: true });
const opensOf = (rl) => rl.of('open').map((c) => [argOf(c, '--type'), argOf(c, '--slot'), argOf(c, '--trigger')]);

// ── S1 회차 열기 · 예정일 · 시작 방식 ─────────────────────────────────
{
  // 예정일 = 한국 날짜. 자정(한국)을 넘는 순간 날짜가 바뀐다.
  eq('한국 자정 직전은 그날', S.kstDate(new Date('2026-10-02T14:59:59Z')), '2026-10-02');
  eq('한국 자정이면 다음 날', S.kstDate(new Date('2026-10-02T15:00:00Z')), '2026-10-03');
  eq('날짜 옮기기 — 7일 전', S.shiftDate('2026-10-03', -7), '2026-09-26');
  eq('날짜 옮기기 — 달 넘김', S.shiftDate('2026-03-01', -1), '2026-02-28');
}
{
  // 예약 그룹의 예정일은 **예약 발화 시각(nextFire)의 한국 날짜** — 실제로 돈 시각이 아니다.
  // 어제 23:59:30(한국)으로 잡힌 회차가 오늘 돌아도 예정일은 어제다.
  const today = S.kstDate(new Date());
  const lateFire = new Date(Date.parse(`${today}T00:00:00+09:00`) - 30_000);
  const { sched } = harness();
  let calls = 0;
  sched.getNextAnalysisTime = () => (calls++ === 0 ? lateFire : new Date(Date.now() + 86_400_000));
  const got = [];
  sched.runAnalysisGroup = async (schedule, types, origin) => { got.push(origin); };
  sched.scheduleAnalysisGroup('saturday-00:00', ['probe']);
  await new Promise((r) => setTimeout(r, 50));
  sched.stop();
  eq('예약 그룹은 nextFire 의 한국 날짜 · scheduled 로 돈다', got, [{ slot: S.kstDate(lateFire), trigger: 'scheduled' }]);
  ok('(전제) 늦게 깬 회차라 오늘 날짜와 다르다', S.kstDate(lateFire) !== today);
}
{
  // 그룹 — 첫 시도 전에 연다 · 타임아웃 재시도는 같은 회차를 쓴다.
  resetJournal();
  const order = [];
  const rl = fakeReportLog();
  const fn = rl.fn;
  rl.fn = async (script, args) => { if (args[0] === 'open') order.push(`open:${argOf(args, '--type')}`); return fn(script, args); };
  const { sched, spawns } = harness({
    rl,
    results: [{ ...WORKED, subtype: 'error_timeout' }, WORKED, WORKED],
    onSpawn: () => order.push('spawn'),
  });
  await sched.runAnalysisGroup('saturday-00:00', ['probe', 'second'], { slot: '2026-10-03', trigger: 'scheduled' });
  eq('세션 셋(타임아웃 재시도 포함)', spawns.length, 3);
  eq('회차는 종류마다 한 번 — 재시도가 새로 안 연다',
    opensOf(rl), [['probe', '2026-10-03', 'scheduled'], ['second', '2026-10-03', 'scheduled']]);
  eq('여는 것이 첫 시도보다 먼저', order, ['open:probe', 'spawn', 'spawn', 'open:second', 'spawn']);
  const j = journal();
  eq('계획 줄에 예정일 · 시작 방식', j.filter((r) => r.kind === 'plan').map((r) => [r.slot, r.trigger]), [['2026-10-03', 'scheduled']]);
  eq('결과 줄에 회차 번호', j.filter((r) => r.kind === 'outcome').map((r) => [r.type, r.runId]),
    [['probe', '2026-10-03-probe-r1'], ['second', '2026-10-03-second-r2']]);
}
{
  // 한도 → 재시도 큐가 회차를 들고 간다 · 못 돈 뒤쪽 종류도 회차를 연다 · 재시도는 새로 안 연다.
  resetJournal();
  const rl = fakeReportLog();
  const LIMITED = { ...WORKED, sessionId: 'sL', rateLimited: true, rateLimitResetsAt: Math.floor(Date.now() / 1000) + 600 };
  const { sched, spawns } = harness({ rl, results: [WORKED, LIMITED, WORKED, WORKED] });
  let captured = null;
  sched.scheduleAnalysisRetry = (schedule, origin, queue, when) => { captured = { schedule, origin, queue, when }; };
  await sched.runAnalysisGroup('saturday-00:00', ['probe', 'second', 'third'], { slot: '2026-10-03', trigger: 'scheduled' });
  ok('재시도를 예약했다', !!captured);
  eq('큐 — 당사자는 세션 · 회차 · 뒤쪽은 회차만',
    captured && captured.queue.map((q) => [q.type, q.sessionId ?? null, q.run && q.run.runId]),
    [['second', 'sL', '2026-10-03-second-r2'], ['third', null, '2026-10-03-third-r3']]);
  eq('못 돈 뒤쪽 종류도 원래 예정일 · 시작 방식으로 연다', opensOf(rl).at(-1), ['third', '2026-10-03', 'scheduled']);
  const opensBefore = rl.of('open').length;
  // 재시도가 다른 날 돈다고 쳐도 — 같은 회차 · 같은 예정일.
  await sched.runAnalysisRetry(captured.schedule, captured.origin, captured.queue);
  eq('재시도는 회차를 새로 안 연다', rl.of('open').length, opensBefore);
  eq('당사자는 이어받는다', [spawns[2].prompt, spawns[2].opts.resumeSessionId], ['continue', 'sL']);
  eq('재시도 결과 줄도 원래 회차 번호',
    journal().filter((r) => r.viaRetry).map((r) => [r.type, r.runId]),
    [['second', '2026-10-03-second-r2'], ['third', '2026-10-03-third-r3']]);
}
{
  // 원래 회차를 못 연 칸 — 재시도에서 처음 열 때만 `retry` · 예정일은 원래 것.
  const rl = fakeReportLog();
  const { sched } = harness({ rl, results: [WORKED] });
  await sched.runAnalysisRetry('saturday-00:00', { slot: '2026-10-03', trigger: 'scheduled' }, [{ type: 'probe', run: null }]);
  eq('회차 없는 칸은 retry 로 연다', opensOf(rl), [['probe', '2026-10-03', 'retry']]);
}
{
  // 수동 — 단일 · 그룹 모두 manual · 오늘(한국 날짜).
  const today = S.kstDate(new Date());
  const rl = fakeReportLog();
  const { sched } = harness({ rl, results: [WORKED] });
  await sched.runAnalysisManual('probe');
  eq('-analyze <종류> 는 manual · 오늘', opensOf(rl), [['probe', today, 'manual']]);

  const rl2 = fakeReportLog();
  const { sched: g } = harness({ rl: rl2, results: [WORKED, WORKED, WORKED, WORKED] });
  await g.runAnalysisManual();
  eq('-analyze(그룹)도 manual · 오늘', [...new Set(opensOf(rl2).map((o) => `${o[1]} ${o[2]}`))], [`${today} manual`]);
  eq('그룹 수동은 기본 스케줄의 종류마다 연다', opensOf(rl2).map((o) => o[0]).sort(),
    ['kg-regression', 'probe', 'second', 'third']);
}

// ── S6 처리 백엔드 — servedBy ───────────────────────────────────────
{
  // 1차가 해냄 → claude
  const { sched } = harness({ results: [WORKED] });
  const r = await sched.spawnOrFallback('시험', '아무 말', { workingDirectory: TMP });
  eq('1차가 해내면 servedBy=claude', r.servedBy, 'claude');

  // 1차가 도구 0회로 실패 → codex 가 받음 → codex
  const realCodex = wa.codexSession;
  // codex 가 보고서를 남겼다고 친다 — 안 남기면 도구 0회 재시도(되물음)가 Claude 로 다시 돈다.
  wa.codexSession = async () => {
    const dir = path.join(REPO, 'reports', 'scheduled-reports', 'probe');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'codex.md'), '# codex 보고서\n', 'utf-8');
    return 'codex 가 썼다';
  };
  try {
    const { sched: s2 } = harness({ results: [{ ...WORKED, text: '', isError: true, subtype: 'error', toolCalls: 0 }] });
    const r2 = await s2.spawnOrFallback('시험', '아무 말', { workingDirectory: TMP });
    eq('폴백(codex)이 받으면 servedBy=codex', [r2.text, r2.servedBy], ['codex 가 썼다', 'codex']);

    // 수동 실행 결과 메시지에 처리한 백엔드
    const { sched: s3 } = harness({ results: [{ ...WORKED, text: '', isError: true, subtype: 'error', toolCalls: 0 }] });
    const msg = await s3.runAnalysisManual('probe');
    ok(`수동 실행 메시지에 「처리 codex」 — 받음 ${msg}`, msg.includes('처리 codex'));
  } finally {
    wa.codexSession = realCodex;
  }

  // 도구 없는 회차가 사다리의 agy 로 넘어가면 → agy
  const realLadder = ladder.ladderText;
  ladder.ladderText = async () => ({ text: 'agy 가 답함', backend: 'agy', model: 'm' });
  try {
    const { sched: s4 } = harness({ results: [{ ...WORKED, text: '', isError: true, subtype: 'error', toolCalls: 0 }] });
    const r4 = await s4.spawnOrFallback('시험', '아무 말', { workingDirectory: TMP, tools: [] });
    eq('사다리의 agy 가 받으면 servedBy=agy', r4.servedBy, 'agy');
  } finally {
    ladder.ladderText = realLadder;
  }

  const { sched: s5 } = harness({ results: [WORKED] });
  const msg5 = await s5.runAnalysisManual('probe');
  ok(`수동 실행 메시지에 「처리 claude」 — 받음 ${msg5}`, msg5.includes('처리 claude'));
}

// ── S9 agy 위임 경로 — 걷혔나 ─────────────────────────────────────
{
  ok('src/agy-handler.ts 가 남아 있다 — 부르는 곳이 없는 폐기 모듈', !fs.existsSync(path.join(SRC, 'agy-handler.ts')));
  for (const name of fs.readdirSync(SRC).filter((f) => f.endsWith('.ts'))) {
    const text = stripComments(fs.readFileSync(path.join(SRC, name), 'utf-8'));
    for (const word of ['shouldUseAgy', 'runAgyAnalysis', 'ANALYSIS_AGY_TYPES', './agy-handler']) {
      ok(`${name}: ${word} 가 남아 있다 — agy 는 폴백으로만 쓴다`, !text.includes(word));
    }
  }
}

fs.rmSync(TMP, { recursive: true, force: true });

if (fails.length) {
  console.error(`\n실패 ${fails.length}건\n\n  ✗ ${fails.join('\n\n  ✗ ')}\n`);
  process.exitCode = 1;
} else {
  console.log('통과 — 분석 회차 쓰는 길 (회차 열기 · 예정일 · 재시도 같은 회차 · 수동 manual · 처리 백엔드 · agy 위임 경로 걷힘)');
}
