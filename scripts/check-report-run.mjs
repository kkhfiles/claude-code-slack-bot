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
 *   - 쓰기 범위(임시 파일 폴더) · 저장 시점 · 「썼나」 판정 · 저장 시점 · 러너 환경 · 처리 백엔드
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
// 폴백 둘을 시험 내내 빈손으로 — 시험이 엇나가 1차가 터져도 진짜 codex · 사다리를 띄우지 않게.
// (없는 실행체 이름이 두 번째 문이다.) 폴백을 재는 절만 잠깐 갈아 끼운다.
const quietCodex = async () => '';
const quietLadder = async () => null;
wa.codexSession = quietCodex;
ladder.ladderText = quietLadder;

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
let fakeSeq = 0;
function fakeReportLog(o = {}) {
  const calls = [];
  let n = 0;
  // 임시 파일 이름은 가짜마다 다르게 — 회차 번호가 같아도(r1) 앞 시험이 남긴 파일을 이번 성과로
  // 읽지 않게(진짜 report-log 는 번호에 무작위 꼬리가 붙는다).
  const tag = `f${++fakeSeq}`;
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
      return { run_id: runId, out: path.join(STATE, 'tmp', `${tag}-${runId}.md`), type, slot };
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

/** 프롬프트에 박힌 회차 임시 파일 경로(`{{REPORT_OUT}}` 자리) — 가짜 세션이 거기에 쓴다. */
const outIn = (prompt) => {
  const tmp = path.join(STATE, 'tmp').replace(/\\/g, '/');
  const m = new RegExp(`${tmp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/[^\\s]+?\\.md`).exec(prompt || '');
  return m ? m[0] : null;
};
/** 가짜 세션 — 받은 프롬프트의 임시 파일에 `body` 를 쓰고 `result` 를 돌려준다. */
const writes = (body, result = WORKED) => (prompt) => {
  const out = outIn(prompt);
  if (!out) throw new Error('프롬프트에 임시 파일 경로가 없다');
  fs.writeFileSync(out, body, 'utf-8');
  return { ...result };
};

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

// ── S2 프롬프트 자리 치환 · 남은 `{{` 거부 ────────────────────────────
{
  const f = S.fillPrompt('A {{SLOT}} B {{REPORT_OUT}}', { SLOT: '2026-10-03', REPORT_OUT: 'C:/x/y.md' });
  eq('아는 자리는 다 채운다', f, { text: 'A 2026-10-03 B C:/x/y.md', left: [] });
  eq('값이 없는 자리는 남김으로 센다', S.fillPrompt('{{SLOT}} {{FOO}}', { SLOT: 'd' }).left, ['{{FOO}}']);
  eq('이름 모양이 아닌 {{ 도 남김', S.fillPrompt('x {{ foo }} y', {}).left, ['{{ foo }}']);
  const v = S.fillPrompt('{{PREV_REPORT}}', { PREV_REPORT: '본문에 {{SLOT}} 과 {{ 가 있다' });
  eq('넣은 값 안의 {{ 는 세지 않고 다시 바꾸지도 않는다', v, { text: '본문에 {{SLOT}} 과 {{ 가 있다', left: [] });
  eq('$ 가 든 값도 그대로', S.fillPrompt('{{SLOT}}', { SLOT: '$& $1' }).text, '$& $1');
  eq('경로는 / 로', S.slashPath('C:\\Users\\a\\.report-log\\tmp\\r.md'), 'C:/Users/a/.report-log/tmp/r.md');

  ok('직전 보고서 없음', S.renderPrevReport(null).includes('직전 보고서 없음'));
  const prev = S.renderPrevReport({ id: 'cli-usage/2026-09-26', slot: '2026-09-26', status: 'complete', title: 'CLI 사용 분석', body: '# 본문\n내용' });
  ok(`직전 보고서 머리 · 본문 — 받음 ${prev}`, prev.includes('cli-usage/2026-09-26') && prev.includes('complete')
    && prev.includes('CLI 사용 분석') && prev.includes('# 본문\n내용'));
  const long = S.renderPrevReport({ id: 'a/b', slot: 's', status: 'complete', body: 'x'.repeat(13_000) });
  ok('긴 본문은 상한에서 자른다', long.length < 12_400 && long.includes('1000자 생략'));
  eq('피할 권고 없음', S.renderAvoidList([]), '(피할 권고 없음)');
  eq('피할 권고 목록', S.renderAvoidList([{ id: 'a-20260926-01', title: '훅 추가', state: 'rejected' },
    { id: 'a-20260926-02', title: '정리', state: 'held' }]), '- a-20260926-01 · 거절 · 훅 추가\n- a-20260926-02 · 보류 · 정리');
  const wk = S.renderWeekInput([{ type: 'cli-usage', slot: '2026-09-26', status: 'complete', title: 'CLI', actions: '## 권장 액션\n- [ ] 하나' }]);
  ok(`그 주 판 목록 — 받음 ${wk}`, wk.includes('cli-usage · 2026-09-26 · complete — CLI') && wk.includes('- [ ] 하나'));
  eq('그 주 판 없음', S.renderWeekInput([]), '(이 기간에 저장된 판 없음)');
  ok('모르는 모양은 JSON 그대로', S.renderWeekInput({ odd: 1 }).includes('"odd": 1'));
}
{
  // 다섯 자리를 다 쓰는 틀 — 값이 본문에 들어가고 남은 `{{` 가 없다.
  writePrompt('probe', '# probe\n\n출력 {{REPORT_OUT}} · 예정일 {{SLOT}}\n\n## 직전\n{{PREV_REPORT}}\n\n## 피할 것\n{{AVOID_LIST}}\n\n## 그 주\n{{WEEK_INPUT}}\n');
  const rl = fakeReportLog({
    context: { prev: { id: 'probe/2026-09-26', slot: '2026-09-26', status: 'complete', title: '지난주', body: '지난주 본문 {{SLOT}}' },
      avoid: [{ id: 'a-20260926-01', title: '훅 추가', state: 'rejected' }] },
    week: [{ type: 'second', slot: '2026-10-03', status: 'complete', title: '둘째', actions: '- [ ] 권고' }],
  });
  const { sched, spawns } = harness({ rl, results: [WORKED] });
  const run = { runId: 'r-probe', out: path.join(STATE, 'tmp', 'r-probe.md'), type: 'probe', slot: '2026-10-03' };
  await sched.runSingleAnalysis('probe', undefined, false, { slot: '2026-10-03', run });
  const p = spawns[0]?.prompt ?? '';
  ok('출력 자리 = 회차 임시 파일(/ 경로)', p.includes(`출력 ${S.slashPath(run.out)}`));
  ok('예정일 자리', p.includes('예정일 2026-10-03'));
  ok('직전 보고서 본문이 들어간다', p.includes('지난주 본문 {{SLOT}}'));
  ok('피할 권고가 들어간다', p.includes('a-20260926-01 · 거절 · 훅 추가'));
  ok('그 주 판 목록이 들어간다', p.includes('second · 2026-10-03 · complete — 둘째') && p.includes('- [ ] 권고'));
  ok('틀의 자리는 남지 않는다', !/\{\{(REPORT_OUT|SLOT|PREV_REPORT|AVOID_LIST|WEEK_INPUT)\}\}/.test(p.replace('지난주 본문 {{SLOT}}', '')));
  eq('prompt-context 는 종류로 묻는다', rl.of('prompt-context').map((c) => argOf(c, '--type')), ['probe']);
  eq('week-input 은 예정일 7일 전부터', rl.of('week-input').map((c) => argOf(c, '--since')), ['2026-09-26']);
  // 안 쓰는 자리는 안 묻는다
  writePrompt('second', '# second\n\n{{REPORT_OUT}} {{SLOT}}\n');
  const rl2 = fakeReportLog();
  const { sched: s2 } = harness({ rl: rl2, results: [WORKED] });
  await s2.runSingleAnalysis('second', undefined, false, { slot: '2026-10-03', run: { ...run, type: 'second' } });
  eq('틀에 없는 자리는 report-log 에 안 묻는다', rl2.calls.length, 0);
}
{
  // 남은 `{{` → 세션을 안 띄움 · 오류
  writePrompt('third', '# third\n\n{{REPORT_OUT}} {{SLOT}} {{FOO}}\n');
  const { sched, spawns } = harness({ results: [WORKED] });
  const run = { runId: 'r3', out: path.join(STATE, 'tmp', 'r3.md'), type: 'third', slot: '2026-10-03' };
  let err = null;
  try { await sched.runSingleAnalysis('third', undefined, false, { slot: '2026-10-03', run }); } catch (e) { err = e; }
  eq('모르는 자리가 남으면 세션을 안 띄운다', spawns.length, 0);
  ok(`오류로 끝난다 — 받음 ${err && err.message}`, !!err && /\{\{FOO\}\}/.test(err.message));
  writePrompt('third', '# third\n\n보고서를 {{REPORT_OUT}} 에 쓴다. 예정일 {{SLOT}}.\n');

  // 회차를 못 열면 출력 자리가 비어 → 세션을 안 띄움 · 그룹은 오류 결과로 적는다
  resetJournal();
  const rl = fakeReportLog({ openError: '잠금 없음 시험' });
  const g = harness({ rl, results: [WORKED, WORKED, WORKED] });
  await g.sched.runAnalysisGroup('saturday-00:00', ['third'], { slot: '2026-10-03', trigger: 'scheduled' });
  eq('회차를 못 열면 세션 0회', g.spawns.length, 0);
  eq('그룹은 오류 결과를 남긴다', journal().filter((r) => r.kind === 'outcome').map((r) => [r.type, r.outcome]), [['third', 'error']]);

  // prompt-context 가 실패하면 직전 보고서 자리가 비어 → 안 띄움
  writePrompt('third', '# third\n\n{{REPORT_OUT}} {{SLOT}}\n{{PREV_REPORT}}\n');
  const rl3 = fakeReportLog({ context: { error: 'rc 1 · 시험' } });
  const h3 = harness({ rl: rl3, results: [WORKED] });
  let err3 = null;
  try { await h3.sched.runSingleAnalysis('third', undefined, false, { slot: '2026-10-03', run }); } catch (e) { err3 = e; }
  ok('prompt-context 실패면 안 띄운다', h3.spawns.length === 0 && !!err3 && err3.message.includes('{{PREV_REPORT}}'));

  // 이어받는 회차는 채울 것이 없다 — 'continue' 한 낱말 · report-log 를 안 부른다
  const rl4 = fakeReportLog();
  const h4 = harness({ rl: rl4, results: [WORKED] });
  await h4.sched.runSingleAnalysis('third', 'resume-1', false, { slot: '2026-10-03', run });
  eq('이어받기는 continue 그대로', [h4.spawns[0]?.prompt, rl4.calls.length], ['continue', 0]);
  writePrompt('third', '# third\n\n보고서를 {{REPORT_OUT}} 에 쓴다. 예정일 {{SLOT}}.\n');
}

// ── S3 쓰기 범위 — 임시 파일 폴더 ───────────────────────────────────
{
  const TMPDIR_RL = path.join(STATE, 'tmp');
  eq('옛 보고서 폴더만 빼고 임시 파일 폴더를 더한다',
    S.analysisWritable(['reports/', 'references/', 'reports/eval/', 'reports'], TMPDIR_RL),
    ['references/', 'reports/eval/', S.slashPath(TMPDIR_RL)]);

  const { sched, spawns } = harness({ results: [WORKED] });
  const run = { runId: 'r-s3', out: path.join(TMPDIR_RL, 'r-s3.md'), type: 'second', slot: '2026-10-03' };
  await sched.runSingleAnalysis('second', undefined, false, { slot: '2026-10-03', run });
  const o = spawns[0].opts;
  eq('Claude 추가 폴더 = 임시 파일 폴더', o.additionalDirectories, [TMPDIR_RL]);
  ok('Codex 쓰기 허용에 임시 파일 폴더', o.fallbackScope && o.fallbackScope.writable.includes(TMPDIR_RL));
  eq('Codex 작업 폴더는 그대로', o.fallbackScope && o.fallbackScope.cwd, REPO);
  ok(`시스템 문구의 쓰기 허용 = 설정(reports/ 뺌) + 임시 파일 폴더 — 받음 ${o.appendSystemPrompt.split('\n')[0]}`,
    o.appendSystemPrompt.startsWith(`CRITICAL: references/, ${S.slashPath(TMPDIR_RL)} 디렉토리에만`));
  ok('예약 실행 지시는 그대로 붙는다', o.appendSystemPrompt.includes('사람이 없는 예약 실행'));

  // 폴더가 아직 없으면 실행체에 안 넘긴다(넘기면 넘어진다) — 시스템 문구에는 남는다.
  const saved = process.env.REPORT_LOG_STATE;
  process.env.REPORT_LOG_STATE = path.join(TMP, 'tmp-없는-상태');
  try {
    const h = harness({ results: [WORKED] });
    await h.sched.runSingleAnalysis('second', undefined, false, { slot: '2026-10-03', run });
    eq('없는 폴더는 추가 폴더로 안 넘긴다', h.spawns[0].opts.additionalDirectories, []);
  } finally {
    process.env.REPORT_LOG_STATE = saved;
  }
}

// ── S5 「썼나」 판정 — 회차 임시 파일 ─────────────────────────────────
{
  const dir = path.join(STATE, 'tmp');
  const put = (name, body, ageMs = 0) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, body, 'utf-8');
    if (ageMs) { const t = new Date(Date.now() - ageMs); fs.utimesSync(p, t, t); }
    return p;
  };
  const since = Date.now();
  ok('없는 파일은 안 냄', !S.reportProduced(path.join(dir, '없음.md'), since));
  ok('세션 시작 뒤 쓴 본문은 냄', S.reportProduced(put('p-a.md', '# 보고서\n본문\n'), since));
  ok('세션 시작 전 파일(앞 세션 · 앞 시도)은 안 냄', !S.reportProduced(put('p-b.md', '# 옛것\n본문\n', 3_600_000), since));
  ok('빈 파일은 안 냄', !S.reportProduced(put('p-c.md', '  \n'), since));
  ok('머리말만 있으면 안 냄', !S.reportProduced(put('p-d.md', '---\ntype: x\n---\n\n'), since));
  ok('대기 표식이 남은 기계본은 안 냄', !S.reportProduced(put('p-e.md', `# 기계본\n${S.PENDING_MARK}\n`), since));
  ok('자리표시자가 남은 본문은 안 냄', !S.reportProduced(put('p-f.md', '# kg-health\n_(filled in by analysis-kg-health prompt)_\n'), since));
}
{
  // 러너 종류 — 러너가 세션 도중 기계본을 썼는데(시각은 새것) 세션이 한도로 끊김 → 「안 냄」 · 이어받기.
  const LIM = { ...WORKED, sessionId: 'sK', rateLimited: true, rateLimitResetsAt: Math.floor(Date.now() / 1000) + 600 };
  const run = { runId: 'r-kgr', out: path.join(STATE, 'tmp', 'r-kgr.md'), type: 'kg-regression', slot: '2026-10-03' };
  const h = harness({ results: [writes(`# 기계본\n${S.PENDING_MARK}\n수치\n`, LIM)] });
  const r = await h.sched.runSingleAnalysis('kg-regression', undefined, false, { slot: '2026-10-03', run });
  eq('러너 종류 — 대기 표식이 남으면 한도 그대로(이어받음)', [r.rateLimited, r.produced], [true, false]);
  const h2 = harness({ results: [writes('# 판정본\n수치 · 판정\n', LIM)] });
  const r2 = await h2.sched.runSingleAnalysis('kg-regression', undefined, false, { slot: '2026-10-03', run });
  eq('대기 표식을 지운 판정본이면 백스톱이 완료로', [r2.rateLimited, r2.produced], [false, true]);
  // 회차가 없으면(못 엶) 낸 것이 없다
  const h3 = harness({ results: [WORKED] });
  writePrompt('second', '# second\n\n고정 문구 — 자리 없음\n');
  const r3 = await h3.sched.runSingleAnalysis('second', undefined, false, { slot: '2026-10-03', run: null });
  eq('회차가 없으면 produced=false', r3.produced, false);
  writePrompt('second', '# second\n\n보고서를 {{REPORT_OUT}} 에 쓴다. 예정일 {{SLOT}}.\n');
}

// ── S4 저장 시점 · --partial · 이어받을 때 저장 안 함 · 잠금 재시도 ────────
const commitsOf = (rl) => rl.of('commit').map((c) => [argOf(c, '--run'), argOf(c, '--backend'), c.includes('--partial')]);
{
  const P = S.commitPlan;
  const n = { runner: false, empty: false, produced: true };
  eq('완료 + 냄 → 그대로', P('completed', n), { partial: false });
  eq('완료인데 이번 세션이 안 냄 → partial', P('completed', { ...n, produced: false }), { partial: true });
  eq('이어받을 예정 → 저장 안 함', P('resume', n), null);
  eq('손도 안 댐 → 저장 안 함', P('not-tried', n), null);
  eq('마지막 시도까지 실패 → partial', P('failed', { ...n, produced: false }), { partial: true });
  eq('되물음 → 저장(비었으면 report-log 가 no-output)', P('no-output', { ...n, empty: true, produced: false }), { partial: true });
  eq('러너 종류 · 빈 임시 파일 → 저장 안 함(러너가 아직 씀)', P('failed', { runner: true, empty: true, produced: false }), null);
  eq('러너 종류 · 기계본 있음 → partial(report-log 가 machine 으로)', P('completed', { runner: true, empty: false, produced: false }), { partial: true });
  ok('빈 파일 판정 — 없는 파일', S.outIsEmpty(path.join(STATE, 'tmp', '없음.md')));
}
const LIMIT = (sid = 'sL') => ({ ...WORKED, sessionId: sid, rateLimited: true, rateLimitResetsAt: Math.floor(Date.now() / 1000) + 600 });
{
  // 완료 → --partial 없이 · 처리 백엔드
  const rl = fakeReportLog();
  const { sched } = harness({ rl, results: [writes('# probe\n본문\n')] });
  writePrompt('probe', '# probe\n\n보고서를 {{REPORT_OUT}} 에 쓴다. 예정일 {{SLOT}}.\n');
  await sched.runAnalysisGroup('saturday-00:00', ['probe'], { slot: '2026-10-03', trigger: 'scheduled' });
  eq('완료는 그대로 저장 · --backend claude', commitsOf(rl), [['2026-10-03-probe-r1', 'claude', false]]);
}
{
  // 한도로 이어받을 예정 → 당사자도 뒤쪽도 지금은 저장 안 함 → 재시도에서 저장.
  // (한도에 걸린 세션이 판정까지 된 본문을 남겼으면 백스톱이 완료로 친다 — 여기서는 안 남긴다.)
  const rl = fakeReportLog();
  let resumedOut = null;
  const { sched } = harness({
    rl,
    results: [
      LIMIT(),
      () => { fs.writeFileSync(resumedOut, '# probe 이어받아 끝\n', 'utf-8'); return { ...WORKED }; },
      writes('# second\n'),
    ],
  });
  let q = null;
  sched.scheduleAnalysisRetry = (schedule, origin, queue) => { q = { schedule, origin, queue }; };
  await sched.runAnalysisGroup('saturday-00:00', ['probe', 'second'], { slot: '2026-10-03', trigger: 'scheduled' });
  eq('이어받을 예정이면 저장 안 함', rl.of('commit').length, 0);
  resumedOut = q.queue[0].run.out;
  await sched.runAnalysisRetry(q.schedule, q.origin, q.queue);
  eq('재시도가 끝나면 같은 회차로 저장', commitsOf(rl),
    [['2026-10-03-probe-r1', 'claude', false], ['2026-10-03-second-r2', 'claude', false]]);
}
{
  // 재시도가 또 막히면 그 칸은 --partial · 손도 안 댄 칸은 남김
  const rl = fakeReportLog();
  const { sched } = harness({ rl, results: [LIMIT(), LIMIT('sL2')] });
  let q = null;
  sched.scheduleAnalysisRetry = (schedule, origin, queue) => { q = { schedule, origin, queue }; };
  await sched.runAnalysisGroup('saturday-00:00', ['probe', 'second'], { slot: '2026-10-03', trigger: 'scheduled' });
  await sched.runAnalysisRetry(q.schedule, q.origin, q.queue);
  eq('재시도도 막힘 → 당사자만 --partial · 미시도 칸은 저장 안 함', commitsOf(rl), [['2026-10-03-probe-r1', 'claude', true]]);
}
{
  // 데일리(재시도 안 잡음) 한도 → 마지막 시도 → --partial
  writeConfig({ probe: { enabled: true, schedule: 'daily-12:00', model: 'sonnet', effort: 'low' } });
  const rl = fakeReportLog();
  const { sched } = harness({ rl, results: [LIMIT()] });
  let scheduled = false;
  sched.scheduleAnalysisRetry = () => { scheduled = true; };
  await sched.runAnalysisGroup('daily-12:00', ['probe'], { slot: '2026-10-03', trigger: 'scheduled' });
  eq('재시도를 안 잡는 한도는 마지막 시도 → --partial', [scheduled, commitsOf(rl)], [false, [['2026-10-03-probe-r1', 'claude', true]]]);
  writeConfig();
}
{
  // 타임아웃 — 시도가 남으면 저장 안 하고 다시 · 마지막이면 --partial
  const rl = fakeReportLog();
  const TO = { ...WORKED, subtype: 'error_timeout' };
  const { sched, spawns } = harness({ rl, results: [writes('# 1차 반쪽\n', TO), writes('# 2차 반쪽\n', TO)] });
  await sched.runAnalysisGroup('saturday-00:00', ['probe'], { slot: '2026-10-03', trigger: 'scheduled' });
  eq('타임아웃 두 번(maxRetries 1) → 한 번만 --partial 저장', [spawns.length, commitsOf(rl)], [2, [['2026-10-03-probe-r1', 'claude', true]]]);
}
{
  // 되물음 두 번(아무것도 안 씀) → 저장(빈 파일 → report-log 가 no-output)
  const rl = fakeReportLog();
  const ASK = { ...WORKED, toolCalls: 0, text: 'what would you like me to do?' };
  const { sched } = harness({ rl, results: [ASK, ASK] });
  await sched.runAnalysisGroup('saturday-00:00', ['probe'], { slot: '2026-10-03', trigger: 'scheduled' });
  eq('되물음 → 저장한다(--partial · 비었으므로 no-output 판정은 report-log)', commitsOf(rl), [['2026-10-03-probe-r1', 'claude', true]]);
}
{
  // 잠금 실패 → 한 번 더 · 그래도 실패면 그대로 둔다(정리 작업 몫)
  const LOCK = { error: '잠금을 120초 안에 못 얻음: …/lock' };
  const rl = fakeReportLog({ commits: [LOCK, { run_id: 'x', status: 'complete' }] });
  const { sched } = harness({ rl, results: [writes('# probe\n')] });
  await sched.runAnalysisGroup('saturday-00:00', ['probe'], { slot: '2026-10-03', trigger: 'scheduled' });
  eq('잠금 실패면 한 번 더 부른다', rl.of('commit').length, 2);
  const rl2 = fakeReportLog({ commits: [LOCK, LOCK, LOCK] });
  const h2 = harness({ rl: rl2, results: [writes('# probe\n')] });
  await h2.sched.runAnalysisGroup('saturday-00:00', ['probe'], { slot: '2026-10-03', trigger: 'scheduled' });
  eq('두 번째도 잠금이면 거기서 멈춘다(세 번째 없음)', rl2.of('commit').length, 2);
  const rl3 = fakeReportLog({ commits: [{ error: 'downgrade — complete 를 낮추려 함' }] });
  const h3 = harness({ rl: rl3, results: [writes('# probe\n')] });
  await h3.sched.runAnalysisGroup('saturday-00:00', ['probe'], { slot: '2026-10-03', trigger: 'scheduled' });
  eq('잠금이 아닌 실패는 다시 안 부른다', rl3.of('commit').length, 1);
}
{
  // 러너 종류 — 임시 파일이 비었으면 저장 안 함(러너가 아직 씀) · 기계본만 있으면 --partial(→ machine)
  const rl = fakeReportLog();
  const h = harness({ rl, results: [{ ...WORKED, subtype: 'error_timeout' }, { ...WORKED, subtype: 'error_timeout' }] });
  await h.sched.runAnalysisGroup('saturday-00:00', ['kg-regression'], { slot: '2026-10-03', trigger: 'scheduled' });
  eq('러너 종류 · 빈 임시 파일 → 저장 안 함', rl.of('commit').length, 0);
  const rl2 = fakeReportLog();
  const h2 = harness({ rl: rl2, results: [writes(`# 기계본\n${S.PENDING_MARK}\n`)] });
  await h2.sched.runAnalysisGroup('saturday-00:00', ['kg-regression'], { slot: '2026-10-03', trigger: 'scheduled' });
  eq('러너 종류 · 판정 안 된 기계본 → --partial', commitsOf(rl2), [['2026-10-03-kg-regression-r1', 'claude', true]]);
}
{
  // 수동 단일 — 결과 메시지에 저장 상태
  const rl = fakeReportLog();
  const { sched } = harness({ rl, results: [writes('# probe\n본문\n')] });
  const msg = await sched.runAnalysisManual('probe');
  ok(`수동 결과 메시지에 저장 상태 — 받음 ${msg}`, msg.includes('저장 complete') && msg.includes('처리 claude'));
  eq('수동도 저장한다', rl.of('commit').length, 1);
}

// ── S7 러너 미리 띄우기 — 환경 변수 · --date ────────────────────────
{
  const run = { runId: 'r-ds', out: path.join(STATE, 'tmp', 'r-ds.md'), type: 'data-sync', slot: '2026-10-03' };
  const spec = { argv: ['-m', 'batch.kg_regression_weekly', '--detach'], cwdSub: 'mycelium' };
  const L = S.runnerLaunch(spec, REPO, { slot: '2026-10-03', run });
  eq('인자 — 원래 argv 뒤에 --date <예정일>', L.args, ['-X', 'utf8', '-m', 'batch.kg_regression_weekly', '--detach', '--date', '2026-10-03']);
  eq('폴더 — cwdSub', L.cwd, path.join(REPO, 'mycelium'));
  eq('환경 — 회차 넷', [L.env.REPORT_RUN, L.env.REPORT_OUT, L.env.REPORT_SLOT, L.env.REPORT_TYPE],
    ['r-ds', run.out, '2026-10-03', 'data-sync']);
  eq('환경 — 파이썬 설정은 그대로', [L.env.PYTHONDONTWRITEBYTECODE, L.env.PYTHONIOENCODING], ['1', 'utf-8']);
  // 회차가 없으면 REPORT_* 를 지운다 — 바깥 환경에 남은 값이 새지 않게(러너가 스스로 연다)
  process.env.REPORT_OUT = path.join(TMP, '바깥에-남은-값.md');
  try {
    const L2 = S.runnerLaunch(spec, REPO, { slot: '2026-10-03', run: null });
    eq('회차 없음 → REPORT_* 없음 · --date 는 있음', [L2.env.REPORT_OUT, L2.env.REPORT_RUN, L2.args.at(-1)], [undefined, undefined, '2026-10-03']);
  } finally {
    delete process.env.REPORT_OUT;
  }

  // 분석 한 번 — 러너를 회차 문맥으로 띄우고, 세션에도 회차를 알린다
  const h = harness({ results: [writes('# 판정본\n')] });
  const runK = { runId: 'r-kgr2', out: path.join(STATE, 'tmp', 'r-kgr2.md'), type: 'kg-regression', slot: '2026-10-03' };
  await h.sched.runSingleAnalysis('kg-regression', undefined, false, { slot: '2026-10-03', run: runK });
  eq('러너 종류는 회차 문맥으로 띄운다', h.launches.map(([t, sp, ctx]) => [t, sp.argv.at(-1), ctx.slot, ctx.run && ctx.run.runId]),
    [['kg-regression', '--detach', '2026-10-03', 'r-kgr2']]);
  const env = h.spawns[0].opts.env;
  eq('세션 환경에도 회차', [env.REPORT_RUN, env.REPORT_OUT, env.REPORT_SLOT, env.REPORT_TYPE],
    ['r-kgr2', runK.out, '2026-10-03', 'kg-regression']);
  const h2 = harness({ results: [writes('# s\n')] });
  await h2.sched.runSingleAnalysis('second', undefined, false, { slot: '2026-10-03', run: { ...runK, type: 'second' } });
  eq('러너 없는 종류는 안 띄운다', h2.launches.length, 0);
}

// ── S6 처리 백엔드 — servedBy ───────────────────────────────────────
{
  // 1차가 해냄 → claude
  const { sched } = harness({ results: [WORKED] });
  const r = await sched.spawnOrFallback('시험', '아무 말', { workingDirectory: TMP });
  eq('1차가 해내면 servedBy=claude', r.servedBy, 'claude');

  // 1차가 도구 0회로 실패 → codex 가 받음 → codex
  const prevCodex = wa.codexSession;
  // codex 가 보고서를 남겼다고 친다 — 안 남기면 도구 0회 재시도(되물음)가 Claude 로 다시 돈다.
  wa.codexSession = async (prompt) => {
    const out = outIn(prompt);
    if (out) fs.writeFileSync(out, '# codex 보고서\n', 'utf-8');
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
    wa.codexSession = prevCodex;
  }

  // 도구 없는 회차가 사다리의 agy 로 넘어가면 → agy
  const prevLadder = ladder.ladderText;
  ladder.ladderText = async () => ({ text: 'agy 가 답함', backend: 'agy', model: 'm' });
  try {
    const { sched: s4 } = harness({ results: [{ ...WORKED, text: '', isError: true, subtype: 'error', toolCalls: 0 }] });
    const r4 = await s4.spawnOrFallback('시험', '아무 말', { workingDirectory: TMP, tools: [] });
    eq('사다리의 agy 가 받으면 servedBy=agy', r4.servedBy, 'agy');
  } finally {
    ladder.ladderText = prevLadder;
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
  console.log('통과 — 분석 회차 쓰는 길 (회차 열기 · 예정일 · 재시도 같은 회차 · 수동 manual · 프롬프트 자리 · 남은 {{ 거부 · 쓰기 범위 · 「썼나」 판정 · 저장 시점 · 러너 환경 · 처리 백엔드 · agy 위임 경로 걷힘)');
}
