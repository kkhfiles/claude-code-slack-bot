/**
 * 예약 일의 빈틈 — **막혔다 풀린 날에 아침 브리핑 · 한도 재시도가 사라지지 않나** (2026-10-14 · 엔진 폴백 4단계).
 *
 *   npm run build
 *   npm run check:schedgaps
 *
 * 메운 빈틈 넷을 실행으로 잰다.
 *   ① 브리핑 「올린 날」 자국 — **올린 뒤에만** 찍힌다. 놓친 브리핑은 이것을 본다(전에는 비용 원장의
 *      「돌았다」라, 한도에 막힌 회차도 「돌았다」로 쳐서 그날 브리핑이 영영 안 나갔다)
 *   ② 놓친 브리핑 · 수동 `-briefing` 이 **한도 · 오류 글을 브리핑인 양 올리지 않는다**
 *   ③ 한도가 풀리면(회복 타이머) 그날 못 올린 브리핑을 다시 돌린다 — 업무일 · 브리핑 시각 뒤 · 정오 전만
 *   ④ 분석 한도 재시도 계획이 **파일에 남아** 재시작 뒤 다시 걸린다 · 때가 지났으면 Claude 가 풀렸을 때만 돈다
 *
 * **외부를 안 부른다** — 세션은 가짜(`executeBriefing` · `runAnalysisRetry` 를 갈아 끼움), 상태 파일은
 * 전부 **모듈을 읽기 전에** 임시 폴더로 돌린다.
 */
import './lib/fresh-dist.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-gaps-'));
const MARK = path.join(TMP, 'briefing-delivered.json');
const PLANS = path.join(TMP, 'analysis-retry.json');
const ENGINE = path.join(TMP, 'engine-state.json');
process.env.BRIEFING_DELIVERED_FILE = MARK;
process.env.ANALYSIS_RETRY_FILE = PLANS;
process.env.ENGINE_STATE_FILE = ENGINE;
process.env.ASSISTANT_COSTS_FILE = path.join(TMP, 'costs.json');
process.env.WORK_EVENTS_FILE = path.join(TMP, 'events.jsonl');
process.env.REPORT_LOG_STATE = path.join(TMP, 'report-log-state');
process.env.REPORT_LOG_REPO = path.join(TMP, 'report-log-없는-클론');
process.env.WORK_ASSISTANT_STATE = path.join(TMP, 'wa-state');
process.env.BOARD_NARROW_CODEX_BIN = 'codex-없는-이름-2026';
process.env.LADDER_PYTHON = 'python-없는-이름-2026';

const require = createRequire(import.meta.url);
const { AssistantScheduler } = require('../dist/assistant-scheduler.js');
const { engineState } = require('../dist/engine-state.js');

const fails = [];
const eq = (label, got, want) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    fails.push(`${label}\n    받음 ${JSON.stringify(got)}\n    기대 ${JSON.stringify(want)}`);
  }
};
const ok = (label, cond) => { if (!cond) fails.push(label); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (cond) => { for (let i = 0; i < 200 && !cond(); i++) await wait(10); };

/** 설정 둘 — 놓친 브리핑은 실제 시계로 돌아 브리핑 시각이 00:00 이어야 언제 돌려도 「지났다」. */
const cfgDir = (time) => {
  const d = path.join(TMP, `cfg-${time.replace(':', '')}`);
  fs.mkdirSync(path.join(d, 'prompts'), { recursive: true });
  fs.writeFileSync(path.join(d, 'config.json'), JSON.stringify({
    briefing: { time, enabled: true, excludeCalendars: [] },
    reminders: { enabled: false, beforeMinutes: 15, pollingIntervalMinutes: 5, workingHoursStart: '08:00', workingHoursEnd: '20:00' },
    analysis: { schedule: 'saturday-00:00', defaults: {}, types: {} },
  }));
  return d;
};
const CFG_MIDNIGHT = cfgDir('00:00');
const CFG_EIGHT = cfgDir('08:00');

const OK = { text: '☀️ 오늘 브리핑', costUsd: 0, sessionId: 's', subtype: 'success', isError: false, toolCalls: 3, servedBy: 'claude' };
const LIMITED = { text: "You've hit your limit · resets 1pm (Asia/Seoul)", costUsd: 0, sessionId: 's',
  subtype: 'success', isError: true, rateLimited: true, toolCalls: 0, servedBy: 'claude' };
const ERRORED = { text: 'API Error: 500 {"type":"error","error":{"type":"api_error"}}', costUsd: 0, sessionId: 's',
  subtype: 'error_during_execution', isError: true, toolCalls: 0, servedBy: 'claude' };
const RAW = /hit your limit|API Error/;

/** 브리핑 세션만 갈아 끼운 스케줄러 — 세션 · report-log · 처리 제안 · 비용 원장은 안 부른다. */
function brief(result, { cfg = CFG_MIDNIGHT, send } = {}) {
  const sent = [];
  let runs = 0;
  const s = new AssistantScheduler(send ?? (async (t) => { sent.push(t); }),
    async () => { throw new Error('시험이 세션을 불렀다'); }, cfg, undefined,
    { reportLog: async () => ({ error: '시험 — report-log 를 안 부른다' }) });
  s.loadConfig();
  s.saveCosts = () => {};
  s.recordSessionCost = () => {};
  s.isNonWorkingDay = () => ({ skip: false });
  s.executeBriefing = async () => { runs += 1; return { ...result }; };
  s.postMorningProposals = async () => {};
  s.postNasQueue = async () => {};
  return { s, sent, runs: () => runs };
}
const mark = () => (fs.existsSync(MARK) ? JSON.parse(fs.readFileSync(MARK, 'utf-8')) : null);
const today = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
const clearMark = () => fs.rmSync(MARK, { force: true });

// ── ① · ② 놓친 브리핑 — 올린 뒤에만 자국 · 한도/오류 글을 안 올림 ───────────────
{
  clearMark();
  const a = brief(OK);
  await a.s.catchUpBriefingIfNeeded();
  ok(`놓친 브리핑이 돌아 올라간다 (받음 ${JSON.stringify(a.sent)})`, a.sent.some((t) => t.startsWith('☀️ 오늘 브리핑')));
  eq('올린 뒤 그날 자국 · 어느 길로', [mark()?.date, mark()?.how, mark()?.via], [today(), 'catch-up', 'claude']);
  const again = brief(OK);
  await again.s.catchUpBriefingIfNeeded();
  eq('자국이 오늘이면 다시 안 돈다', again.runs(), 0);

  for (const [label, r] of [['한도', LIMITED], ['오류', ERRORED]]) {
    clearMark();
    const c = brief(r);
    await c.s.catchUpBriefingIfNeeded();
    ok(`놓친 브리핑 ${label} — 그 글을 브리핑으로 안 올린다 (받음 ${JSON.stringify(c.sent)})`, !c.sent.some((t) => RAW.test(t)));
    eq(`놓친 브리핑 ${label} — 자국 없음`, mark(), null);
  }
  clearMark();
  const lim = brief(LIMITED);
  await lim.s.catchUpBriefingIfNeeded();
  ok('놓친 브리핑 한도 — 한 줄 안내', lim.sent.some((t) => t.startsWith('⏳')));

  // 보내기가 실패하면 자국이 없다 — 자국을 먼저 찍으면 못 올린 날이 「올렸다」가 된다.
  clearMark();
  const unsent = brief(OK, { send: async () => { throw new Error('슬랙 보내기 실패(시험)'); } });
  await unsent.s.catchUpBriefingIfNeeded();
  eq('보내기가 실패하면 자국을 안 찍는다', mark(), null);

  // 자국 파일이 아직 없는 첫날 — 옛 기준(원장)을 한 번 쓴다(이미 나간 브리핑을 재시작이 또 올리지 않게).
  clearMark();
  const legacy = brief(OK);
  legacy.s.costEntries = [{ timestamp: new Date().toISOString(), type: 'briefing', costUsd: 0.1, sessionId: 's' }];
  await legacy.s.catchUpBriefingIfNeeded();
  eq('자국이 없는 첫날은 원장으로 — 오늘 돌았으면 안 돈다', legacy.runs(), 0);
  const legacyFail = brief(OK);
  legacyFail.s.costEntries = [{ timestamp: new Date().toISOString(), type: 'briefing', costUsd: 0, sessionId: '', via: 'codex', ok: false }];
  await legacyFail.s.catchUpBriefingIfNeeded();
  eq('원장의 실패한 폴백 회차는 「돌았다」가 아니다', legacyFail.runs(), 1);
  fs.writeFileSync(MARK, JSON.stringify({ date: '2026-01-01', how: 'scheduled' }));
  const stale = brief(OK);
  stale.s.costEntries = [{ timestamp: new Date().toISOString(), type: 'briefing', costUsd: 0.1, sessionId: 's' }];
  await stale.s.catchUpBriefingIfNeeded();
  eq('자국이 한 번 생기면 원장은 안 본다(자국이 어제면 돈다)', stale.runs(), 1);
}

// ── 예약 브리핑 — 한도면 한 줄 안내만 · 올렸을 때만 자국 ──────────────────────
{
  for (const [label, r, wantMark] of [['한도', LIMITED, null], ['오류', ERRORED, null], ['정상', OK, 'scheduled']]) {
    clearMark();
    const b = brief(r);
    let armed = 0;
    b.s.getNextWorkingDay = () => new Date(Date.now() + (armed++ === 0 ? 5 : 86_400_000));
    b.s.scheduleBriefing();
    await waitFor(() => armed >= 2);
    b.s.stop();
    ok(`예약 브리핑 ${label} — 한도 · 오류 글을 안 올린다 (받음 ${JSON.stringify(b.sent)})`, !b.sent.some((t) => RAW.test(t)));
    eq(`예약 브리핑 ${label} — 자국`, mark()?.how ?? null, wantMark);
    if (r === LIMITED) ok(`예약 브리핑 한도 — 회복 뒤 다시 돌린다는 안내 (받음 ${b.sent[0]})`, /정오/.test(b.sent[0] ?? ''));
  }
}

// ── 수동 `-briefing` — 한도 · 오류 글을 돌려주지 않는다 · 올린 뒤 자국은 대화 처리기가 ─────
{
  for (const [label, r, want] of [['한도', LIMITED, false], ['오류', ERRORED, false], ['정상', OK, true]]) {
    const m = brief(r);
    const got = await m.s.runBriefing();
    eq(`수동 브리핑 ${label} — ok`, got.ok, want);
    ok(`수동 브리핑 ${label} — 그 글을 안 돌려준다 (받음 ${got.text.slice(0, 60)})`, !RAW.test(got.text));
  }
  const handler = fs.readFileSync(path.join(ROOT, 'src', 'slack-handler.ts'), 'utf-8');
  const at = handler.indexOf('this.assistantScheduler.runBriefing()');
  const seg = handler.slice(at, at + 600);
  const said = seg.indexOf('await say({ text: result.text');
  const marked = seg.indexOf("if (result.ok) this.assistantScheduler.markBriefingDelivered('manual'");
  ok('수동 브리핑은 올린 뒤(say 다음) ok 일 때만 자국', at > 0 && said > 0 && marked > said);
}

// ── ③ 한도가 풀리면 그날 못 올린 브리핑을 다시 — 업무일 · 브리핑 시각 뒤 · 정오 전 ─────
{
  const ymd = today().split('-').map(Number);
  /** 오늘(한국 날짜) 그 시각(한국 시각)을 실제 시각으로. */
  const kstAt = (h, m = 0) => new Date(Date.UTC(ymd[0], ymd[1] - 1, ymd[2], h - 9, m));
  const cases = [
    ['10:00 · 못 올림 → 돈다', kstAt(10), true, OK, null],
    ['12:30 → 정오가 지나 안 돈다', kstAt(12, 30), false, OK, null],
    ['07:30 → 브리핑 시각(08:00) 전이라 안 돈다', kstAt(7, 30), false, OK, null],
    ['10:00 · 이미 올림 → 안 돈다', kstAt(10), false, OK, { date: today(), how: 'scheduled' }],
    ['10:00 · 또 한도 → 못 올림', kstAt(10), false, LIMITED, null],
  ];
  for (const [label, now, want, r, pre] of cases) {
    clearMark();
    if (pre) fs.writeFileSync(MARK, JSON.stringify(pre));
    const c = brief(r, { cfg: CFG_EIGHT });
    const got = await c.s.recoverBriefingIfNeeded('시험', now);
    eq(`회복 뒤 브리핑 ${label}`, got, want);
    if (want) eq('회복 뒤 올린 브리핑 — 자국', mark()?.how, 'recovery');
    if (r === LIMITED) eq('회복 뒤 또 막히면 아무것도 안 올린다(08시에 이미 알렸다)', c.sent, []);
  }
  clearMark();
  const off = brief(OK, { cfg: CFG_EIGHT });
  off.s.isNonWorkingDay = () => ({ skip: true, reason: '시험' });
  eq('회복 뒤 브리핑 — 쉬는 날이면 안 돈다', await off.s.recoverBriefingIfNeeded('시험', kstAt(10)), false);

  // 회복 타이머가 부르는 입구 — 둘 다 부르고 · 기다리지 않고 · 안쪽이 터져도 안 던진다
  const viaRecover = brief(OK);
  const called = [];
  viaRecover.s.recoverBriefingIfNeeded = async (why) => { called.push(`브리핑:${why}`); throw new Error('터짐(시험)'); };
  viaRecover.s.runDueAnalysisRetries = async (why) => { called.push(`재시도:${why}`); };
  let threw = null;
  try { viaRecover.s.onEngineRecover('한도 회복'); } catch (e) { threw = e; }
  await wait(20);
  eq('onEngineRecover — 브리핑 · 한도 재시도를 다 부르고 안 던진다', [threw, called.sort()], [null, ['브리핑:한도 회복', '재시도:한도 회복']]);

  const handler = fs.readFileSync(path.join(ROOT, 'src', 'slack-handler.ts'), 'utf-8');
  const rec = handler.slice(handler.indexOf('new EngineRecovery({'), handler.indexOf('new EngineRecovery({') + 700);
  ok('회복 타이머가 예약 쪽(onEngineRecover)을 부른다', rec.includes('this.assistantScheduler?.onEngineRecover(why)'));
  ok('회복 타이머는 여전히 밀린 것을 드레인한다', rec.includes("await this.drainStuck('한도 회복')"));
}

// ── ④ 한도 재시도 계획 — 파일에 남고 · 재시작 뒤 다시 걸리고 · Claude 가 풀렸을 때만 돈다 ─────
{
  const plans = () => (fs.existsSync(PLANS) ? JSON.parse(fs.readFileSync(PLANS, 'utf-8')).plans : []);
  const resetEngine = () => fs.rmSync(ENGINE, { force: true });
  const mk = () => {
    const s = new AssistantScheduler(async () => {}, async () => { throw new Error('시험이 세션을 불렀다'); },
      CFG_MIDNIGHT, undefined, { reportLog: async () => ({ error: '시험' }) });
    const ran = [];
    s.runAnalysisRetry = async (schedule, origin, queue) => {
      // 돌리는 동안 그 계획은 이미 파일에 없다 — 도중에 죽어도 두 번 안 돈다(재시도는 한 번).
      ran.push({ schedule, slot: origin.slot, trigger: origin.trigger, queue, inFile: plans().length });
    };
    return { s, ran };
  };
  const RUN = { runId: '2026-10-10-probe-r1', out: path.join(TMP, 'probe.md'), type: 'probe', slot: '2026-10-10' };
  const QUEUE = [{ type: 'probe', sessionId: 'sess-1', run: RUN }, { type: 'second', run: null }];
  const ORIGIN = { slot: '2026-10-10', trigger: 'scheduled' };
  const shape = (r) => [r.schedule, r.slot, r.trigger, r.queue.map((q) => [q.type, q.sessionId ?? null, q.run?.runId ?? null])];

  fs.rmSync(PLANS, { force: true });
  resetEngine();
  const a = mk();
  a.s.scheduleAnalysisRetry('saturday-00:00', ORIGIN, QUEUE, new Date(Date.now() + 3_600_000));
  eq('재시도 계획이 파일에 남는다', plans().map((p) => [p.schedule, p.origin.slot, p.queue.map((q) => q.type)]),
     [['saturday-00:00', '2026-10-10', ['probe', 'second']]]);
  a.s.stop();
  eq('봇을 꺼도(재시작) 계획은 남는다', plans().length, 1);

  // 재시작 — 때가 안 됐으면 타이머만 다시 건다
  const b = mk();
  await b.s.rearmAnalysisRetries();
  eq('기동 — 때가 안 됐으면 타이머만', [b.ran.length, b.s.analysisRetryTimers.size], [0, 1]);
  b.s.stop();

  // 때가 지났고 Claude 가 막혀 있으면 안 돌리고 파일에 둔다
  const later = Date.now() + 2 * 3_600_000;
  engineState.recordBlocked('claude', { kind: 'usage', until: Math.floor(later / 1000) + 3600 });
  const c = mk();
  await c.s.rearmAnalysisRetries(later);
  eq('때가 지났어도 Claude 가 막혀 있으면 안 돈다 · 파일에 남음', [c.ran.length, plans().length], [0, 1]);
  // 풀리면 회복 타이머가 부르는 입구로 돈다 — 같은 큐 · 같은 회차
  resetEngine();
  await c.s.runDueAnalysisRetries('한도 회복', later);
  eq('풀리면 지금 돈다 · 같은 큐 · 같은 회차', c.ran.map(shape),
     [['saturday-00:00', '2026-10-10', 'scheduled', [['probe', 'sess-1', '2026-10-10-probe-r1'], ['second', null, null]]]]);
  eq('돌리기 전에 파일에서 뺀다(재시도는 한 번)', [c.ran[0]?.inFile, plans().length], [0, 0]);
  c.s.stop();

  // 기동 때 때가 지났고 Claude 가 풀려 있으면 바로 돈다
  fs.writeFileSync(PLANS, JSON.stringify({ v: 1, plans: [{ id: 'p-old', schedule: 'saturday-00:00', origin: ORIGIN,
    queue: QUEUE, due: Date.now() - 60_000 }] }));
  const d = mk();
  await d.s.rearmAnalysisRetries();
  eq('기동 — 때가 지난 계획은 바로 돈다', [d.ran.length, plans().length], [1, 0]);
  d.s.stop();

  // 예약 시각에 Claude 가 막혀 있으면 타이머도 안 돌리고 회복을 기다린다 → 회복(onEngineRecover)에 돈다
  engineState.recordBlocked('claude', { kind: 'usage', until: Math.floor(Date.now() / 1000) + 3600 });
  const e = mk();
  e.s.scheduleAnalysisRetry('saturday-00:00', ORIGIN, QUEUE, new Date(Date.now() + 20));
  await wait(120);
  eq('예약 시각에 막혀 있으면 안 돈다 · 파일에 남음', [e.ran.length, plans().length], [0, 1]);
  resetEngine();
  e.s.onEngineRecover('한도 회복');
  await waitFor(() => e.ran.length > 0);
  eq('회복 타이머가 부르면 돈다', [e.ran.length, plans().length], [1, 0]);
  e.s.stop();

  // 기동이 다시 걸기를 부르나 — 부르지 않으면 위 모든 것이 운영에서는 안 돈다
  const src = fs.readFileSync(path.join(ROOT, 'src', 'assistant-scheduler.ts'), 'utf-8');
  const start = src.slice(src.indexOf('  start(): void {'), src.indexOf('  stop(): void {'));
  ok('start() 가 한도 재시도 계획을 다시 건다', start.includes('this.rearmAnalysisRetries('));
}

fs.rmSync(TMP, { recursive: true, force: true });

if (fails.length) {
  console.log(`실패 ${fails.length}건\n`);
  for (const f of fails) console.log('  ✗ ' + f);
  process.exitCode = 1;
} else {
  console.log('통과 — 예약 일의 빈틈 (브리핑 자국은 올린 뒤에만 · 놓친 · 예약 · 수동 브리핑이 한도/오류 글을 안 올림 · '
    + '회복 뒤 브리핑은 업무일 · 브리핑 시각 뒤 · 정오 전만 · 한도 재시도 계획 파일 · 재시작 뒤 다시 걸림 · '
    + 'Claude 가 막혀 있으면 기다림)');
}
