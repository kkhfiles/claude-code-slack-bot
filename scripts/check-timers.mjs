/**
 * 타이머 짝 검사 — 지우기만 하고 다시 안 거는 것을 찾는다. ①~⑤ 는 **소스만 읽는다.**
 * ⑥ 은 분석 그룹 타이머를 실제로 돌려 센다(세션 · report-log 는 안 부른다).
 *
 *   npm run build
 *   npm run check:timers
 *
 * `clearAllTimers()` 는 설정을 저장할 때마다 돈다. 거기서 지운 타이머를
 * `scheduleAll()` 이 다시 걸지 않으면 **그 기능은 에러도 로그도 없이 사라진다** —
 * 봇은 멀쩡히 돌고 그 알림만 영영 안 온다. 2026-07-15 에 다우 세션 keep-alive 가
 * 이렇게 끊겨 닷새 뒤에야 드러났고, 그 교훈은 지금 소스 주석에만 있다.
 *
 * 주석은 다음 사람이 안 읽는다. 그래서 여기서 센다.
 */
import './lib/fresh-dist.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src', 'assistant-scheduler.ts');

/** 타이머 이름 → 그것을 거는 함수. **새 타이머를 넣으면 여기에도 한 줄 는다.** */
const REGISTRAR = {
  briefingTimer: 'scheduleBriefing',
  workNudgeTimer: 'scheduleWorkNudge',
  notionWatchTimer: 'startNotionWatch',
  boardQueueTimer: 'startBoardQueuePoller',
  daouKeepAliveTimer: 'scheduleDaouKeepAlive',
  focusTimer: 'scheduleFocus',
  summaryTimer: 'scheduleSummary',
  improveTimer: 'scheduleImprove',
  offsitePushTimer: 'scheduleOffsitePush',
  mailPollTimer: 'startMailPoller',
  remindTimer: 'startRemindPoller',
  actionsTimer: 'startActionsTicker',
  runSweepTimer: 'startRunSweeper',
};

/**
 * 한 타이머 자리에서 **같이** 하기로 한 일.
 *
 * 타이머는 하나인데 하는 일이 둘 이상이면 뒤엣것이 빠져도 아래 검사 셋이 전부
 * 통과한다 — 타이머는 여전히 걸리고 지워지고 스스로 재예약하니까. 20:00 자리가
 * 그렇다(커밋 걷기 다음에 밖으로 내보내기). 그래서 하는 일을 따로 센다.
 */
const ALSO_DOES = {
  scheduleOffsitePush: ['runCommitHarvest', 'runOffsitePush'],
};

/**
 * 타이머가 아닌 **상시 연결** → 그것을 여는 함수 (2026-10-01 판 알림).
 *
 * 이름이 `…Timer` 가 아니라 위 검사 셋이 못 본다. 그런데 짝이 깨지는 모양은 같다 —
 * 멈추기만 하고 다시 안 열면 알림이 조용히 끊기고 안전망 주기로만 돈다(느려질 뿐 에러는
 * 없다). 거꾸로 안 멈추면 설정을 저장할 때마다 연결이 하나씩 쌓여 같은 알림을 여러 번 받는다.
 */
const CONNECTIONS = {
  boardPush: 'startBoardQueuePoller',
};

/** 소스에서 그 함수의 본문만 떼어 온다. 못 찾으면 멈춘다 — 조용히 빈 문자열을
 *  돌려주면 「아무것도 안 걸려 있다」가 아니라 「검사가 안 돌았다」가 된다. */
function body(src, name) {
  const head = src.search(new RegExp(`private (async )?${name}\\(`));
  if (head < 0) throw new Error(`${name}() 을 못 찾았다 — 이름이 바뀌었나`);
  const rest = src.slice(head + name.length);
  const next = rest.search(/\n {2}(private|public|\/\*\*)/);
  return next < 0 ? rest : rest.slice(0, next);
}

const src = fs.readFileSync(SRC, 'utf-8');
const fails = [];

const cleared = new Set(
  [...body(src, 'clearAllTimers').matchAll(/this\.(\w+Timer)\b/g)].map((m) => m[1]),
);
const declared = new Set(
  [...src.matchAll(/private (\w+Timer): ReturnType/g)].map((m) => m[1]),
);
const scheduleAll = body(src, 'scheduleAll');

// ① 선언한 타이머는 전부 지워져야 한다 — 안 지우면 설정을 저장할 때마다 하나씩
//    쌓여 같은 알림이 두 번, 세 번 온다.
for (const t of declared) {
  if (t === 'watchDebounceTimer' || t === 'midnightTimer') continue; // 각자 자기 자리에서 지운다
  if (!cleared.has(t)) fails.push(`${t} — 선언은 했는데 clearAllTimers() 가 안 지운다`);
}

// ② 지운 타이머는 전부 다시 걸려야 한다. **이게 조용한 누수 지점이다.**
for (const t of cleared) {
  const fn = REGISTRAR[t];
  if (!fn) { fails.push(`${t} — 무엇이 거는지 이 검사가 모른다 (REGISTRAR 에 한 줄 넣을 것)`); continue; }
  if (!scheduleAll.includes(`this.${fn}(`)) {
    fails.push(`${t} — 지우기만 하고 scheduleAll() 이 ${fn}() 을 다시 안 부른다`);
  }
}

// ③ 다시 거는 함수는 스스로를 또 예약해야 한다 — `setTimeout` 은 한 번만 터진다.
for (const [timer, fn] of Object.entries(REGISTRAR)) {
  if (!cleared.has(timer)) continue;
  const b = body(src, fn);
  if (b.includes('setInterval')) continue;              // 되풀이는 그쪽이 알아서
  if (!b.includes(`this.${fn}()`)) {
    fails.push(`${fn}() — 한 번 터지고 끝난다 (자기를 다시 안 예약한다)`);
  }
}

// ④ 그 자리에서 하기로 한 일이 다 불리는가.
for (const [fn, jobs] of Object.entries(ALSO_DOES)) {
  const b = body(src, fn);
  for (const job of jobs) {
    if (!b.includes(`this.${job}(`)) {
      fails.push(`${fn}() — ${job}() 을 안 부른다 (그 자리에서 같이 하기로 한 일)`);
    }
  }
}

// ⑤ 상시 연결도 같은 짝 — clearAllTimers() 가 멈추고, 여는 함수가 scheduleAll() 에서
//    다시 불리고, 그 함수가 실제로 연다.
const clearBody = body(src, 'clearAllTimers');
for (const [conn, fn] of Object.entries(CONNECTIONS)) {
  if (!new RegExp(`this\\.${conn}\\.stop\\(\\)`).test(clearBody)) {
    fails.push(`${conn} — clearAllTimers() 가 안 멈춘다 (설정 저장마다 연결이 쌓인다)`);
  }
  if (!scheduleAll.includes(`this.${fn}(`)) {
    fails.push(`${conn} — 여는 ${fn}() 을 scheduleAll() 이 안 부른다`);
  }
  if (!new RegExp(`this\\.${conn}\\.start\\(\\)`).test(body(src, fn))) {
    fails.push(`${conn} — ${fn}() 이 연결을 안 연다 (멈추기만 하고 다시 안 엶)`);
  }
}

// ⑥ 분석 그룹 타이머 — **돌려서 센다.** 위 넷은 이름이 `…Timer` 인 칸만 보는데 분석 타이머는
//    맵(`analysisTimers`)이라 안 걸렸다. 그래서 「그룹이 도는 사이 설정을 다시 읽으면 다음 회차
//    타이머가 둘이 되어 같은 그룹이 두 번 돈다」(2026-10-07 검토 K1)를 못 잡았다. 짝이 깨지는 곳이
//    타이머 콜백 안이라 소스 글자로는 못 가른다.
//    상태 경로는 모듈을 읽기 전에 임시 폴더로 돌린다 · 업무 비서 타이머는 안 건다(없는 폴더).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'timers-check-'));
process.env.REPORT_LOG_STATE = path.join(TMP, 'report-log-state');
process.env.REPORT_LOG_REPO = path.join(TMP, 'report-log-없는-클론');
process.env.WORK_EVENTS_FILE = path.join(TMP, 'events.jsonl');
process.env.WORK_ASSISTANT_STATE = path.join(TMP, 'wa-state');
process.env.WORK_ASSISTANT_ROOT = path.join(TMP, 'wa-없는-폴더');
process.env.ASSISTANT_COSTS_FILE = path.join(TMP, 'costs.json');
process.env.ACTIONS_RESUME_FILE = path.join(TMP, 'actions-resume.json');
const CFG = path.join(TMP, 'repo', 'assistant');
fs.mkdirSync(path.join(CFG, 'prompts'), { recursive: true });
const writeConfig = (enabled) => fs.writeFileSync(path.join(CFG, 'config.json'), JSON.stringify({
  briefing: { time: '08:00', enabled: false, excludeCalendars: [] },
  reminders: { enabled: false, beforeMinutes: 15, pollingIntervalMinutes: 5,
    workingHoursStart: '08:00', workingHoursEnd: '20:00' },
  analysis: {
    schedule: 'saturday-00:00',
    defaults: { allowedTools: ['Read'], writablePaths: ['reports/'], maxRetries: 1 },
    types: { probe: { enabled, model: 'sonnet', effort: 'low' } },
  },
}), 'utf-8');
writeConfig(true);

// 걸린 타이머 장부 — 맵에서 빠졌어도 살아 있는 타이머를 센다(그것이 곧 두 번째 실행이다).
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const live = new Set();
globalThis.setTimeout = (fn, ms, ...args) => {
  const h = realSetTimeout(() => { live.delete(h); fn(...args); }, ms);
  live.add(h);
  return h;
};
globalThis.clearTimeout = (h) => { live.delete(h); realClearTimeout(h); };
const wait = (ms) => new Promise((r) => realSetTimeout(r, ms));
const waitFor = async (cond) => { for (let i = 0; i < 200 && !cond(); i++) await wait(10); };

const require = createRequire(import.meta.url);
const { AssistantScheduler } = require('../dist/assistant-scheduler.js');
const DAY = 86_400_000;
const GROUP = 'saturday-00:00';
let nextIn = 20;
const runs = [];
let release = () => {};
const sched = new AssistantScheduler(
  async () => {},
  async () => { throw new Error('시험이 세션을 불렀다'); },
  CFG, undefined,
  { reportLog: async () => ({ error: '시험 — report-log 를 안 부른다' }) },
);
sched.getNextAnalysisTime = () => new Date(Date.now() + nextIn);
// 첫 실행은 문이 열릴 때까지 붙든다 — 「그룹이 도는 사이」를 만든다.
sched.runAnalysisGroup = async (schedule) => {
  runs.push(schedule);
  if (runs.length === 1) await new Promise((r) => { release = r; });
};
/** 설정 파일 감시가 하는 그대로 — 지우고 · 다시 읽고 · 다시 건다. */
const reload = () => { sched.clearAllTimers(); sched.loadConfig(); sched.scheduleAll(); };
/** 다우 keep-alive 를 뺀 살아 있는 타이머 — 이 설정에서는 분석 타이머만 남는다. */
const analysisLive = () => [...live].filter((h) => h !== sched.daouKeepAliveTimer);
/** 한 판 — 그룹이 도는 사이에 `during()` 을 하고 그룹을 끝낸다. */
const round = async (during) => {
  runs.length = 0;
  nextIn = 20;
  writeConfig(true);
  sched.loadConfig();
  sched.scheduleAll();
  await waitFor(() => runs.length === 1);
  nextIn = DAY;
  during();
  release();
  await wait(30);
};
try {
  // 대조 — 아무 일 없으면 끝난 그룹이 다음 회차를 스스로 건다(지나치게 막아 그룹이 끊기면 안 된다).
  await round(() => {});
  const own = analysisLive();
  if (own.length !== 1 || own[0] !== sched.analysisTimers.get(GROUP)) {
    fails.push(`⑥ 끝난 그룹이 다음 회차를 안 건다 (타이머 ${own.length}개) — 그룹이 한 번 돌고 끊긴다`);
  }
  sched.stop();

  await round(reload);
  const left = analysisLive();
  if (runs.length !== 1) fails.push(`⑥ 그룹이 한 번 돌아야 하는데 ${runs.length}번`);
  if (left.length !== 1 || left[0] !== sched.analysisTimers.get(GROUP)) {
    fails.push(`⑥ 그룹이 도는 사이 설정을 다시 읽으면 다음 회차 타이머가 ${left.length}개 — 하나(맵에 있는 것)여야 한다`
      + ' (맵에서 빠진 타이머가 다음 예정 시각에 같은 그룹을 한 번 더 돌린다)');
  }
  sched.stop();

  await round(() => { writeConfig(false); reload(); });
  if (analysisLive().length !== 0) {
    fails.push(`⑥ 도는 사이 그 그룹을 끈 설정을 읽었는데 끝난 그룹이 자기를 다시 건다 (타이머 ${analysisLive().length}개)`);
  }
  sched.stop();

  await round(() => sched.stop());
  if (live.size !== 0) fails.push(`⑥ 봇을 끄는 사이 끝난 그룹이 타이머를 다시 건다 (남은 타이머 ${live.size}개)`);

  // ⑦ 한도 재시도 — 설정을 다시 읽어도 살아남는다 · 봇을 끄면 풀린다 · 같은 스케줄 둘을 둘 다 쥔다.
  //    재시도가 `analysisTimers` 에 있던 동안 설정을 다시 읽으면 지워지고 아무도 다시 안 걸어, 열린
  //    회차를 6시간 뒤 정리 작업이 반쪽으로 닫았다(2026-10-07 검토 K2).
  const retried = [];
  sched.runAnalysisRetry = async (schedule, origin, queue) => { retried.push(queue.map((q) => q.type).join(',')); };
  const origin = { slot: '2026-10-03', trigger: 'scheduled' };
  const retryIn = (type, ms) => sched.scheduleAnalysisRetry(GROUP, origin, [{ type, run: null }], new Date(Date.now() + ms));
  nextIn = DAY;
  writeConfig(true);
  sched.loadConfig();
  sched.scheduleAll();
  retryIn('a', 40);
  reload();
  await wait(120);
  if (retried.join(' ') !== 'a') fails.push(`⑦ 설정을 다시 읽은 뒤 한도 재시도가 안 돈다 (돈 것: ${JSON.stringify(retried)})`);

  retryIn('b', 40);
  sched.stop();
  await wait(120);
  if (retried.includes('b')) fails.push('⑦ 봇을 껐는데 한도 재시도가 돈다');
  if (live.size !== 0) fails.push(`⑦ 봇을 끈 뒤 남은 타이머 ${live.size}개 — 재시도도 풀려야 한다`);

  sched.scheduleAll();
  retryIn('c', 30);
  retryIn('d', DAY);   // 같은 스케줄 둘째 — 앞엣것이 장부에서 빠지거나, 먼저 돈 것이 이것을 지우면 안 된다
  await wait(120);
  if (!retried.includes('c')) fails.push('⑦ 같은 스케줄 재시도가 둘일 때 앞엣것이 안 돈다');
  sched.stop();
  if (live.size !== 0) {
    fails.push(`⑦ 같은 스케줄 재시도가 둘이면 봇을 꺼도 하나가 남는다 (${live.size}개) — 먼저 돈 재시도가 뒤엣것의 칸을 지웠거나 덮어써 놓쳤다`);
  }
} finally {
  sched.stop();
  for (const h of live) realClearTimeout(h);
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
  fs.rmSync(TMP, { recursive: true, force: true });
}

if (fails.length) {
  console.error('타이머 짝이 안 맞는다\n' + fails.map((f) => `  ✗ ${f}`).join('\n'));
  process.exitCode = 1;
} else {
  const jobs = Object.values(ALSO_DOES).flat().length;
  console.log(`통과 — 타이머 ${cleared.size}개: 지움·다시 걺·자기 재예약 셋 다`
    + ` · 한자리에서 같이 하는 일 ${jobs}개 · 상시 연결 ${Object.keys(CONNECTIONS).length}개`
    + ' · 분석 그룹 타이머(도는 사이 설정 다시 읽기 · 그룹 끔 · 봇 끔)'
    + ' · 한도 재시도(설정 다시 읽기에 살아남음 · 봇 끄면 풀림 · 같은 스케줄 둘)');
}
