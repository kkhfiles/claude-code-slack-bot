/**
 * 설정 다시 읽기 — 2부 1번(계획 「2부 재검토」).
 *
 *   npm run build
 *   npm run check:rearm
 *
 * **타이머를 실제로 안 기다린다** — `setTimeout` · `setInterval` 을 가짜로 바꿔 끼워 콜백을 손으로 부른다.
 *
 *   ① 형식은 맞고 묶음이 빠진 설정(2026-03-25 모양)을 다시 읽어도 봇이 안 끝나고, 앞 설정과 예약이
 *      그대로 남고, 상태 파일에 실패가 남는다. 고친 설정은 다시 읽힌다
 *   ② 새 설정을 걸다 던지면 앞 설정으로 되돌려 다시 건다
 */
import './lib/fresh-dist.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rearm-check-'));
process.env.REPORT_LOG_STATE = path.join(TMP, 'report-log-state');
process.env.REPORT_LOG_REPO = path.join(TMP, 'report-log-없는-클론');
process.env.WORK_EVENTS_FILE = path.join(TMP, 'events.jsonl');
process.env.WORK_ASSISTANT_STATE = path.join(TMP, 'wa-state');
process.env.WORK_ASSISTANT_ROOT = path.join(TMP, 'wa-없는-폴더');
process.env.ASSISTANT_COSTS_FILE = path.join(TMP, 'costs.json');
process.env.ACTIONS_RESUME_FILE = path.join(TMP, 'actions-resume.json');
process.env.ANALYSIS_RETRY_FILE = path.join(TMP, 'analysis-retry.json');
process.env.ENGINE_STATE_FILE = path.join(TMP, 'engine-state.json');
process.env.BRIEFING_DELIVERED_FILE = path.join(TMP, 'briefing-delivered.json');
const CFG = path.join(TMP, 'repo', 'assistant');
fs.mkdirSync(path.join(CFG, 'prompts'), { recursive: true });
const GOOD = (time) => ({
  briefing: { time, enabled: true, excludeCalendars: [] },
  reminders: { enabled: false, beforeMinutes: 15, pollingIntervalMinutes: 5,
    workingHoursStart: '08:00', workingHoursEnd: '20:00' },
  analysis: {
    schedule: 'saturday-00:00',
    defaults: { allowedTools: ['Read'], writablePaths: ['reports/'], maxRetries: 1 },
    types: { probe: { enabled: true, model: 'sonnet', effort: 'low' } },
  },
});
const writeConfig = (cfg) => fs.writeFileSync(path.join(CFG, 'config.json'), JSON.stringify(cfg), 'utf-8');
writeConfig(GOOD('08:00'));

const fails = [];
const ok = (label, cond) => { if (!cond) fails.push(label); };

// ── 가짜 타이머 — 건 것을 장부에 적고, 콜백은 손으로 부른다 ─────────────────
const real = {
  setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
  setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval,
  watchFile: fs.watchFile, unwatchFile: fs.unwatchFile,
};
const pending = new Map();
let seq = 0;
const fakeHandle = () => ({ id: ++seq, unref() { return this; }, ref() { return this; }, hasRef: () => false });
globalThis.setTimeout = (fn, _ms, ...a) => { const h = fakeHandle(); pending.set(h, () => fn(...a)); return h; };
globalThis.clearTimeout = (h) => { pending.delete(h); };
globalThis.setInterval = () => fakeHandle();
globalThis.clearInterval = () => {};
let watcher = null;
fs.watchFile = (_p, _o, fn) => { watcher = fn; };
fs.unwatchFile = () => {};
/** 장부에서 그 핸들의 콜백을 부른다. 던지면 봇이 끝나는 것과 같다 — 던진 것을 돌려준다. */
const fire = (h) => {
  const fn = pending.get(h);
  pending.delete(h);
  if (!fn) return new Error('장부에 없는 타이머');
  try { fn(); } catch (err) { return err; }
  return null;
};
const wait = (ms) => new Promise((r) => real.setTimeout(r, ms));

const require = createRequire(import.meta.url);
const R = require('../dist/recurring.js');
const { AssistantScheduler } = require('../dist/assistant-scheduler.js');
const live = (name) => R.snapshot()[name]?.live ?? 0;
const configState = () => (typeof R.configState === 'function' ? R.configState() : undefined);

const sched = new AssistantScheduler(
  async () => {},
  async () => { throw new Error('시험이 세션을 불렀다'); },
  CFG, undefined,
  { reportLog: async () => ({ error: '시험 — report-log 를 안 부른다' }) },
);

/** 감시가 알린 뒤 1초 미룬 다시 읽기를 부른다 — 운영의 감시 콜백과 같은 길. */
const reloadViaWatcher = () => {
  watcher();
  return fire(sched.watchDebounceTimer);
};

try {
  sched.loadConfig();
  sched.scheduleAll();
  sched.startConfigWatcher();
  ok('시험 준비 — 감시가 안 걸렸다', typeof watcher === 'function');
  ok('시험 준비 — 브리핑 예약이 없다', live('scheduler:briefing') === 1);
  ok('시험 준비 — 분석 예약이 없다', live('scheduler:analysis:saturday-00:00') === 1);

  // ① 03-25 모양 — briefing 묶음이 빠진 설정
  const broken = GOOD('08:00');
  delete broken.briefing;
  writeConfig(broken);
  const thrown = reloadViaWatcher();
  ok(`① 묶음이 빠진 설정을 다시 읽다 던졌다(${thrown?.message}) — 운영에서는 봇이 끝난다`, !thrown);
  ok('① 묶음이 빠진 설정을 받아들였다 — 앞 설정을 지켜야 한다', sched.config?.briefing?.time === '08:00');
  ok(`① 묶음이 빠진 설정을 읽은 뒤 브리핑 예약 ${live('scheduler:briefing')}개 — 지금 예약이 그대로(1개)여야 한다`,
    live('scheduler:briefing') === 1);
  ok(`① 묶음이 빠진 설정을 읽은 뒤 분석 예약 ${live('scheduler:analysis:saturday-00:00')}개 — 그대로(1개)여야 한다`,
    live('scheduler:analysis:saturday-00:00') === 1);
  ok(`① 실패가 상태 파일에 안 남는다 (${JSON.stringify(configState())})`, configState()?.ok === false);

  writeConfig(GOOD('09:00'));
  const thrown2 = reloadViaWatcher();
  ok(`① 고친 설정을 다시 읽다 던졌다(${thrown2?.message})`, !thrown2);
  ok(`① 고친 설정이 안 읽힌다 (브리핑 ${sched.config?.briefing?.time})`, sched.config?.briefing?.time === '09:00');
  ok(`① 고친 설정을 읽은 뒤 브리핑 예약 ${live('scheduler:briefing')}개`, live('scheduler:briefing') === 1);
  ok(`① 고친 설정을 읽은 뒤에도 실패로 남는다 (${JSON.stringify(configState())})`, configState()?.ok === true);

  // ② 검사는 통과했는데 거는 중에 던짐 — 앞 설정으로 되돌려 다시 건다
  const orig = sched.scheduleAnalysis;
  sched.scheduleAnalysis = function () { sched.scheduleAnalysis = orig; throw new Error('시험 — 거는 중 던짐'); };
  writeConfig(GOOD('10:00'));
  const thrown3 = reloadViaWatcher();
  sched.scheduleAnalysis = orig;
  ok(`② 거는 중 던진 것이 밖으로 나왔다(${thrown3?.message}) — 운영에서는 봇이 끝난다`, !thrown3);
  ok(`② 거는 중 던진 설정을 그대로 쓴다 (브리핑 ${sched.config?.briefing?.time}) — 앞 설정(09:00)으로 되돌려야 한다`,
    sched.config?.briefing?.time === '09:00');
  ok(`② 되돌린 뒤 브리핑 예약 ${live('scheduler:briefing')}개 · 분석 예약 ${live('scheduler:analysis:saturday-00:00')}개 — 각 1개`,
    live('scheduler:briefing') === 1 && live('scheduler:analysis:saturday-00:00') === 1);
  ok(`② 실패가 상태 파일에 안 남는다 (${JSON.stringify(configState())})`, configState()?.ok === false);

} finally {
  sched.stop();
  globalThis.setTimeout = real.setTimeout;
  globalThis.clearTimeout = real.clearTimeout;
  globalThis.setInterval = real.setInterval;
  globalThis.clearInterval = real.clearInterval;
  fs.watchFile = real.watchFile;
  fs.unwatchFile = real.unwatchFile;
  fs.rmSync(TMP, { recursive: true, force: true });
}

if (fails.length) {
  console.error('설정 다시 읽기 · 시각 예약 다시 걸기가 안 맞는다\n' + fails.map((f) => `  ✗ ${f}`).join('\n'));
  process.exitCode = 1;
} else {
  console.log('통과 — 묶음 빠진 설정(앞 설정 · 예약 유지 · 실패 기록) · 거는 중 던짐(되돌림)'
);
}
