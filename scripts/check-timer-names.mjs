/**
 * 스케줄러 타이머 이름 — 기동 · 설정 다시 읽기 · 봇 끔을 지나도 공통 장치 등록부의 이름이 맞는가.
 *
 *   npm run build
 *   npm run check:timernames
 *
 * **켜는 문을 모두 연다** — 업무 비서(가짜 폴더), 브리핑, 처리 제안, 분석 그룹 셋, 개선 제안, 판 대기열(닿지 않는
 * 주소, 판 알림 연결은 끔), report-log 클론(가짜). 타이머는 가짜라 아무 일도 안 돈다(세션 · 슬랙 · 네트워크 없음).
 *
 * 왜 — 지금까지의 짝 검사(`check:timers`)는 소스 글자를 읽어서, 켜는 문이 꺼진 시험 설정에서는 업무 비서 쪽 타이머를
 * 한 번도 실제로 안 건다. 이 검사는 `start()` 를 실제로 부르고 공통 장치 등록부(`snapshot()`)로 센다.
 *   ① 기동 직후 — 기대 이름이 모두 살아 있고 모르는 이름이 없다
 *   ② 설정 다시 읽기(clearAllTimers → loadConfig → scheduleAll) — 같은 이름이 다시 살고, 겹쳐 둘이 된 이름이 없다
 *   ③ 봇 끔(stop) — 모두 멈추고 까닭이 stop 이다
 */
import './lib/fresh-dist.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'timer-names-check-'));
const env = {
  REPORT_LOG_STATE: 'report-log-state', REPORT_LOG_REPO: 'report-log', WORK_EVENTS_FILE: 'events.jsonl',
  WORK_ASSISTANT_STATE: 'wa-state', WORK_ASSISTANT_ROOT: 'wa', ASSISTANT_COSTS_FILE: 'costs.json',
  ACTIONS_RESUME_FILE: 'actions-resume.json', ANALYSIS_RETRY_FILE: 'analysis-retry.json',
  ENGINE_STATE_FILE: 'engine-state.json', BRIEFING_DELIVERED_FILE: 'briefing-delivered.json',
};
for (const [k, v] of Object.entries(env)) process.env[k] = path.join(TMP, v);
process.env.DAILY_IMPROVE = 'on';
process.env.BOARD_FOCUS = 'on';   // 기본 꺼짐(2026-11-05) — 켰을 때 다시 걸리는지는 계속 본다
process.env.BOARD_PUSH = 'off';
fs.mkdirSync(path.join(TMP, 'wa', 'bin'), { recursive: true });
fs.writeFileSync(path.join(TMP, 'wa', 'bin', 'tasks.py'), '', 'utf-8');
fs.writeFileSync(path.join(TMP, 'wa', 'config.json'), JSON.stringify({ board_url: 'http://127.0.0.1:9/' }), 'utf-8');
fs.mkdirSync(path.join(TMP, 'report-log', 'tools'), { recursive: true });
fs.writeFileSync(path.join(TMP, 'report-log', 'tools', 'flow.py'), '', 'utf-8');
const CFG = path.join(TMP, 'assistant');
fs.mkdirSync(path.join(CFG, 'prompts'), { recursive: true });
fs.writeFileSync(path.join(CFG, 'config.json'), JSON.stringify({
  briefing: { time: '08:00', enabled: true, excludeCalendars: [] },
  reminders: { enabled: false, beforeMinutes: 15, pollingIntervalMinutes: 5, workingHoursStart: '08:00', workingHoursEnd: '20:00' },
  actions: { enabled: true },
  analysis: {
    schedule: 'saturday-00:00',
    defaults: { allowedTools: ['Read'], writablePaths: ['reports/'], maxRetries: 1 },
    types: {
      weekly: { enabled: true, model: 'sonnet', effort: 'low' },
      daily: { enabled: true, model: 'sonnet', effort: 'low', schedule: 'daily-02:00' },
      midweek: { enabled: true, model: 'sonnet', effort: 'low', schedule: 'wednesday-20:00' },
    },
  },
}), 'utf-8');

/** 이 설정에서 살아 있어야 하는 이름. **새 타이머를 공통 장치로 걸면 여기에도 한 줄 는다.** */
const EXPECTED = [
  'scheduler:actions', 'scheduler:board-queue', 'scheduler:held', 'scheduler:mail', 'scheduler:notion-watch',
  'scheduler:remind', 'scheduler:run-sweep', 'scheduler:vault-sweep',
  'scheduler:briefing', 'scheduler:work-nudge', 'scheduler:summary', 'scheduler:improve', 'scheduler:offsite-push',
  'scheduler:focus', 'scheduler:daou-keepalive', 'scheduler:midnight',
  'scheduler:analysis:saturday-00:00', 'scheduler:analysis:daily-02:00', 'scheduler:analysis:wednesday-20:00',
].sort();
/** 설정 다시 읽기가 안 지우는 것 — 자정 정리는 start() 에서만 걸리고 stop() 이 지운다. */
const NOT_RELOADED = new Set(['scheduler:midnight']);

const real = { setTimeout, setInterval, clearTimeout, clearInterval };
const fakeHandle = () => ({ unref() { return this; }, ref() { return this; }, hasRef() { return true; } });
const require = createRequire(import.meta.url);
const R = require(path.join(ROOT, 'dist', 'recurring.js'));
const fails = [];
const eq = (label, got, want) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    fails.push(`${label}\n    받음 ${JSON.stringify(got)}\n    기대 ${JSON.stringify(want)}`);
  }
};
const alive = () => Object.entries(R.snapshot()).filter(([, e]) => e.live > 0).map(([n]) => n).sort();
const doubled = () => Object.entries(R.snapshot()).filter(([, e]) => e.live > 1).map(([n]) => n);

let sched;
try {
  globalThis.setTimeout = () => fakeHandle();
  globalThis.setInterval = () => fakeHandle();
  globalThis.clearTimeout = () => {};
  globalThis.clearInterval = () => {};
  R.resetForTest();
  const { AssistantScheduler } = require(path.join(ROOT, 'dist', 'assistant-scheduler.js'));
  sched = new AssistantScheduler(async () => {}, async () => { throw new Error('시험 — 세션 안 부름'); }, CFG, undefined,
    { reportLog: async () => ({ error: '시험 — report-log 안 부름' }) });
  sched.start();
  await new Promise((r) => real.setTimeout(r, 300));   // 노션 감시처럼 await 뒤에 거는 것

  eq('① 기동 직후 살아 있는 이름', alive(), EXPECTED);
  eq('① 겹쳐 둘이 된 이름 없음', doubled(), []);

  sched.clearAllTimers();
  const stoppedByReload = Object.entries(R.snapshot()).filter(([, e]) => e.stopReason === 'reload').map(([n]) => n).sort();
  eq('② 설정 다시 읽기가 지운 이름(자정 정리 빼고 전부)', stoppedByReload, EXPECTED.filter((n) => !NOT_RELOADED.has(n)));
  sched.loadConfig();
  sched.scheduleAll();
  await new Promise((r) => real.setTimeout(r, 300));
  eq('② 다시 읽은 뒤 살아 있는 이름', alive(), EXPECTED);
  eq('② 다시 읽은 뒤 겹쳐 둘이 된 이름 없음', doubled(), []);
  eq('② 다시 읽은 뒤 멈춤 표시가 남은 이름 없음',
    Object.entries(R.snapshot()).filter(([, e]) => e.live > 0 && e.stopReason).map(([n]) => n), []);

  sched.stop();
  eq('③ 봇을 끄면 살아 있는 이름 없음', alive(), []);
  eq('③ 끈 까닭은 모두 stop',
    Object.entries(R.snapshot()).filter(([, e]) => e.stopReason !== 'stop').map(([n]) => n), []);
} finally {
  Object.assign(globalThis, real);
  try { fs.unwatchFile(path.join(CFG, 'config.json')); } catch { /* 감시가 없었으면 그만 */ }
  R.resetForTest();
  fs.rmSync(TMP, { recursive: true, force: true });
}

if (fails.length) {
  console.error('스케줄러 타이머 이름이 어긋난다\n' + fails.map((f) => `  ✗ ${f}`).join('\n'));
  process.exitCode = 1;
} else {
  console.log(`통과 — 스케줄러 타이머 ${EXPECTED.length}개: 기동 · 설정 다시 읽기 · 봇 끔을 지나도 이름이 맞고 겹치지 않음`);
}
process.exit(process.exitCode ?? 0);
