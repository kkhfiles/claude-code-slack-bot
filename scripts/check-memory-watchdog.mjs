/**
 * 메모리 감시기 — 상시 작업을 지키는가 · 폭주는 끊는가.
 *
 *   npm run build
 *   npm run check:watchdog
 *
 * **OS 를 안 건드린다** — 프로세스 조회 · 종료를 가짜로 바꿔 끼워 판정만 잰다.
 *
 * 여기서 지키려는 것(2026-09-29 실측 평가):
 *   ① 시스템 90% 경로는 상시 작업(스탠리 계보 · 동기화 파이프라인)을 안 죽인다
 *      — 9/29 00:15 감시기가 동기화 커밋 데몬을 죽여 반영이 끊겼다(8~9월 같은 일 4번)
 *   ② 폭주(프로세스 기준 초과)는 상시 작업이어도 끊는다 — 실제 고갈 22일 중 19일이 폭주 하나
 *   ③ AI 는 규칙 안에서만 고른다 · 실패하면 시스템 경로는 알림만 · 폭주 경로는 규칙대로
 *   ④ 쏘기 직전에 다시 재서 압박이 풀렸으면 안 쏜다 — 9/29 종료 순간 89.4% 였다
 *   ⑤ 스탠리를 띄운 쪽(pm2 등)은 후보로도 안 보인다
 *   ⑥ 한 봉우리에 한 번만 판정한다 — 전에는 3분마다 다음 큰 것을 겨눴다
 */
import './lib/fresh-dist.mjs';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-check-'));
process.env.MEMORY_WATCHDOG_EVENTS_FILE = path.join(tmp, 'events.jsonl');
const W = require(path.join(ROOT, 'dist', 'process-memory-watchdog.js'));

const fails = [];
const eq = (label, got, want) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    fails.push(`${label}\n    받음 ${JSON.stringify(got)}\n    기대 ${JSON.stringify(want)}`);
  }
};
const ok = (label, cond) => { if (!cond) fails.push(label); };

// ── 계보 ──────────────────────────────────────────────────────────────
const BOT = 20;
const ROWS = [
  { pid: 1, ppid: 0, name: 'wininit', cmd: '' },
  { pid: 10, ppid: 1, name: 'node', cmd: 'node pm2 God Daemon' },          // 스탠리를 띄운 쪽
  { pid: BOT, ppid: 10, name: 'node', cmd: 'node dist/index.js' },          // 스탠리
  { pid: 21, ppid: BOT, name: 'claude', cmd: 'claude --print (예약 분석)' },
  { pid: 22, ppid: 21, name: 'python', cmd: 'python tasks.py' },
  { pid: 30, ppid: 999, name: 'python', cmd: 'python -m mycelium.batch.daily_pipeline_run' }, // 부모 없음(DETACHED)
  { pid: 31, ppid: 30, name: 'python', cmd: 'python -m sync_v2.cli run' },
  { pid: 32, ppid: 31, name: 'python', cmd: 'python -m sync_v2.commit_daemon' },
  { pid: 5, ppid: 1, name: 'explorer', cmd: '' },
  { pid: 40, ppid: 5, name: 'chrome', cmd: 'chrome.exe' },
  { pid: 41, ppid: 5, name: 'WindowsTerminal', cmd: '' },
  { pid: 42, ppid: 41, name: 'claude', cmd: 'claude (대화형)' },
];
{
  const roles = W.classifyRoles(ROWS, { botPid: BOT, pipelinePid: 30 });
  const r = (pid) => roles.get(pid) ?? null;
  eq('스탠리를 띄운 쪽 = host', r(10), 'host');
  eq('스탠리 자신은 역할 없음(따로 제외)', r(BOT), null);
  eq('스탠리 세션과 그 자식 = stanley', [r(21), r(22)], ['stanley', 'stanley']);
  eq('러너와 그 자손(커밋 데몬 포함) = pipeline', [r(30), r(31), r(32)], ['pipeline', 'pipeline', 'pipeline']);
  eq('터미널과 그 안의 세션 = interactive', [r(41), r(42)], ['interactive', 'interactive']);
  eq('그 밖은 역할 없음', [r(40), r(5)], [null, null]);
  const noLock = W.classifyRoles(ROWS, { botPid: BOT, pipelinePid: null });
  eq('잠금 파일이 없으면 러너 계보를 모른다', noLock.get(32) ?? null, null);
}

// ── 판정 ──────────────────────────────────────────────────────────────
const C = (pid, name, mb, role = null, growth = 0) => ({ pid, name, commitMB: mb, startTicks: '1', role, growthMB: growth, parent: '', cmd: '' });
const base = { processThresholdMB: 7168, runawayDelaySec: 180, systemDelaySec: 600, lineageKnown: true, systemPct: 91 };
const DAEMON = C(32, 'python', 4364, 'pipeline');
const CHROME = C(40, 'chrome', 1200);
{
  const sys = (verdict) => W.decide({ ...base, path: 'system', candidates: [DAEMON, CHROME], verdict, systemHigh: true });
  const a = sys(null);
  eq('① 9/29 재현 — AI 실패 · 시스템 경로 → 알림만(커밋 데몬 안 죽임)', [a.kind, a.source], ['alert', 'none']);
  const b = sys({ action: 'kill', pid: 32, reason: '가장 큼' });
  eq('① AI 가 동기화 커밋 데몬을 골라도 거절 → 알림만', [b.kind, !!b.target], ['alert', false]);
  const c = sys({ action: 'kill', pid: 40, reason: '브라우저' });
  eq('③ AI 가 상시 작업 밖을 고르면 그것 · 시스템 유예', [c.kind, c.target?.pid, c.delaySec, c.source], ['kill', 40, 600, 'ai']);
  const d = sys({ action: 'wait', pid: null, reason: '봉우리' });
  eq('③ AI 가 기다리라면 알림만', [d.kind, d.source], ['alert', 'ai']);
  const e = W.decide({ ...base, lineageKnown: false, path: 'system', candidates: [DAEMON, CHROME],
                       verdict: { action: 'kill', pid: 40, reason: 'x' }, systemHigh: true });
  eq('① 계보를 못 읽으면 시스템 경로는 아무것도 안 죽인다', e.kind, 'alert');
}
{
  const PY33 = C(50, 'python', 33900, 'pipeline', 8000);
  const run = (verdict, systemHigh) => W.decide({ ...base, path: 'runaway', candidates: [PY33, CHROME], verdict, systemHigh });
  const a = run(null, true);
  eq('② 폭주는 상시 작업이어도 끊는다(AI 실패 → 규칙) · 폭주 유예', [a.kind, a.target?.pid, a.delaySec, a.source], ['kill', 50, 180, 'rule']);
  const b = run({ action: 'wait', pid: null, reason: '정상 작업' }, true);
  eq('② 시스템도 기준을 넘었으면 폭주에 기다림 거절 → 규칙', [b.kind, b.source], ['kill', 'rule']);
  const c = run({ action: 'wait', pid: null, reason: '정상 작업' }, false);
  eq('② 시스템이 기준 아래면 폭주도 기다릴 수 있다', c.kind, 'alert');
  const d = run({ action: 'kill', pid: 999, reason: '표에 없는 것' }, true);
  eq('③ 표에 없는 PID 는 거절 → 규칙', [d.target?.pid, d.source], [50, 'rule']);
  const h = W.decide({ ...base, path: 'runaway', candidates: [C(10, 'node', 12000, 'host')], verdict: null, systemHigh: true });
  eq('⑤ 스탠리를 띄운 쪽은 폭주여도 안 끊는다(끊으면 감시기도 죽는다)', h.kind, 'alert');
}

// ── 대화형 터미널 — 폭주여도 심각할 때만(2026-09-29 사용자 결정) ─────────
{
  const TERM = (mb) => C(41, 'WindowsTerminal', mb, 'interactive', 500);
  const t = (mb, pct, verdict = null) => W.decide({ ...base, systemPct: pct, systemHigh: pct >= 90,
    path: 'runaway', candidates: [TERM(mb)], verdict });
  const a = t(11468, 95.4, { action: 'kill', pid: 41, reason: '터미널 폭주' });
  eq('⑦ 9/2 재현 — 터미널 11.2GB · 95.4% 는 AI 가 골라도 두고 본다', [a.kind, a.source], ['alert', 'rule']);
  ok('⑦ 두고 보는 까닭을 알린다', /심각/.test(a.reason));
  const b = t(11468, 97.2);
  eq('⑦ 커밋 97% 이상이면 심각 → 끊는다 · 유예 1분', [b.kind, b.target?.pid, b.delaySec], ['kill', 41, 60]);
  const c = t(17000, 85);
  eq('⑦ 한 프로세스 16GB 이상이면 심각 → 끊는다', [c.kind, c.target?.pid], ['kill', 41]);
  const d = W.decide({ ...base, path: 'system', candidates: [TERM(4137), CHROME],
                       verdict: { action: 'kill', pid: 41, reason: '가장 큼' }, systemHigh: true });
  eq('⑦ 시스템 경로에서는 터미널을 안 죽인다(AI 가 골라도 거절)', d.kind, 'alert');
  const e = W.decide({ ...base, systemPct: 95.4, systemHigh: true, path: 'runaway', candidates: [TERM(11468), CHROME],
                       verdict: { action: 'kill', pid: 40, reason: '터미널 대신 브라우저로 압박을 던다' } });
  eq('⑦ 터미널은 두고 상시 작업 밖의 브라우저를 끊을 수 있다', [e.kind, e.target?.pid], ['kill', 40]);
  const f = W.decide({ ...base, systemPct: 95.4, systemHigh: true, path: 'runaway', candidates: [TERM(11468), CHROME], verdict: null });
  eq('⑦ AI 가 없으면 규칙은 폭주가 아닌 것을 대신 끊지 않는다', f.kind, 'alert');
  const th = { thresholdPct: 90, processThresholdMB: 7168 };
  eq('⑦ 쏘기 직전 — 여전히 심각해야 쏜다', [
    W.stillWarranted('runaway', { usagePct: 95, targetMB: 11000 }, th, true),
    W.stillWarranted('runaway', { usagePct: 97.5, targetMB: 11000 }, th, true),
    W.stillWarranted('runaway', { usagePct: 95, targetMB: 11000 }, th, false),
  ], [false, true, true]);
}

// ── AI 답 해석 · 쏘기 직전 재확인 ─────────────────────────────────────
eq('답 해석 — 앞뒤 글이 붙어도 JSON 만', W.parseVerdict('판정:\n```json\n{"action":"kill","pid":40,"reason":"브라우저"}\n```'),
   { action: 'kill', pid: 40, reason: '브라우저' });
eq('답 해석 — 모르는 행동은 실패', W.parseVerdict('{"action":"restart","pid":1}'), null);
eq('답 해석 — kill 인데 pid 없음은 실패', W.parseVerdict('{"action":"kill","reason":"?"}'), null);
eq('답 해석 — 빈 답은 실패', W.parseVerdict(''), null);
const TH = { thresholdPct: 90, processThresholdMB: 7168 };
eq('④ 9/29 00:15 재현 — 89.4% 면 안 쏜다', W.stillWarranted('system', { usagePct: 89.4, targetMB: null }, TH), false);
eq('④ 여전히 넘으면 쏜다', W.stillWarranted('system', { usagePct: 91, targetMB: null }, TH), true);
eq('④ 못 재면 안 쏜다', W.stillWarranted('system', { usagePct: null, targetMB: null }, TH), false);
eq('④ 폭주가 기준 아래로 줄었으면 안 쏜다', W.stillWarranted('runaway', { usagePct: null, targetMB: 6000 }, TH), false);
{
  const p = W.buildReviewPrompt({ path: 'system', status: { committedMB: 44500, limitMB: 48914, usagePct: 91 },
    thresholdPct: 90, processThresholdMB: 7168, candidates: [DAEMON, CHROME], pipelineRunning: true, delaySec: 600 });
  ok('프롬프트에 보호 표시가 실린다', p.includes('보호 — 자정 · 정오 동기화'));
  ok('프롬프트가 JSON 답 모양을 적는다', p.includes('"action"'));
}

// ── 감시기 한 회차(가짜 OS) ───────────────────────────────────────────
async function oneRound({ reviewer, pctSeq, top, delaySec = 600, aiActs = false }) {
  const sent = [];
  const updated = [];
  const lock = path.join(tmp, `lock-${Math.random()}.json`);
  fs.writeFileSync(lock, JSON.stringify({ pid: 30 }));
  const wd = new W.ProcessMemoryWatchdog(90, 180, delaySec, 7168,
    async (text) => { sent.push(text); return `ts${sent.length}`; },
    async (ts, text) => { updated.push(text); },
    undefined,
    { reviewer, pipelineLockFile: lock, runawayDelaySec: 0.05, aiActs });
  const seq = [...pctSeq];
  wd.getSystemCommitStatus = async () => ({ committedMB: 44000, limitMB: 48914, usagePct: seq.length > 1 ? seq.shift() : seq[0] });
  wd.getTopProcesses = async () => top;
  wd.getProcessTable = async () => ROWS.map((r) => (r.pid === BOT ? { ...r, pid: process.pid } : r.ppid === BOT ? { ...r, ppid: process.pid } : r));
  wd.reportKnownIssues = async () => {};
  wd.isProcessAlive = async () => true;
  const kills = [];
  wd.killIfSame = (pid) => { kills.push(pid); return 'killed'; };
  return { wd, sent, updated, kills };
}
const TOP = [
  { pid: 32, name: 'python', commitMB: 4364, startTicks: '1' },
  { pid: 40, name: 'chrome', commitMB: 1200, startTicks: '1' },
];
{
  const { wd, sent, kills } = await oneRound({ reviewer: async () => null, pctSeq: [91.4] , top: TOP });
  await wd.checkMemory();
  ok(`① AI 실패 · 90% → 알림 한 통 · 종료 예약 없음 (${sent.length}통)`, sent.length === 1 && wd.pendingKills.size === 0 && kills.length === 0);
  await wd.checkMemory();
  eq('⑥ 같은 봉우리에서 다시 판정하지 않는다', sent.length, 1);
  wd.stop();
}
{
  const { wd, sent, updated, kills } = await oneRound({
    reviewer: async () => '{"action":"kill","pid":40,"reason":"브라우저 탭"}', pctSeq: [91.4, 89.4], top: TOP, delaySec: 0.05,
    aiActs: true,
  });
  await wd.checkMemory();
  ok('③ AI 가 고른 브라우저로 종료 예약', wd.pendingKills.has(40) && sent[0].includes('chrome'));
  await new Promise((r) => setTimeout(r, 400));
  ok(`④ 쏘기 직전 89.4% → 취소 · 안 죽임 (${updated.join(' / ')})`, kills.length === 0 && updated.some((u) => u.includes('압박이 풀려')));
  wd.stop();
}
{
  // ⑧ 관찰 모드(기본) — AI 가 브라우저를 골라도 실행하지 않고 알림 · 「AI 대로였다면」을 기록
  const { wd, sent, kills } = await oneRound({
    reviewer: async () => '{"action":"kill","pid":40,"reason":"브라우저 탭"}', pctSeq: [91.4], top: TOP,
  });
  await wd.checkMemory();
  ok(`⑧ 관찰 모드는 AI 판정을 실행하지 않는다 (예약 ${wd.pendingKills.size} · ${sent.length}통)`,
     wd.pendingKills.size === 0 && kills.length === 0 && sent.length === 1);
  ok('⑧ DM 에 AI 판정을 관찰로 보인다', /관찰/.test(sent[0] || '') && /PID 40/.test(sent[0] || ''));
  const last = fs.readFileSync(process.env.MEMORY_WATCHDOG_EVENTS_FILE, 'utf-8').trim().split('\n').map(JSON.parse)
    .filter((l) => l.phase === 'decide').pop();
  eq('⑧ 기록에 실제 결정과 AI 대로였다면을 둘 다', [last.aiActs, last.decision.kind, last.aiWould.kind, last.aiWould.target?.pid],
     [false, 'alert', 'kill', 40]);
  wd.stop();
}
{
  const RUN = [{ pid: 32, name: 'python', commitMB: 33900, startTicks: '1' }, ...TOP.slice(1)];
  const { wd, kills } = await oneRound({ reviewer: async () => null, pctSeq: [96.5], top: RUN });
  wd.getProcessMB = async () => 34000;
  await wd.checkMemory();
  await new Promise((r) => setTimeout(r, 400));
  eq('② 폭주 33GB(동기화 계보) → AI 실패여도 규칙대로 끊는다', kills, [32]);
  wd.stop();
}
{
  // ⑦ 터미널 11.2GB — 95% 에서는 알림만 · 같은 크기로 97% 가 되면 다시 판정해 끊는다
  const TERM = [{ pid: 41, name: 'WindowsTerminal', commitMB: 11468, startTicks: '1' }, ...TOP.slice(1)];
  const { wd, sent, kills } = await oneRound({ reviewer: async () => null, pctSeq: [95.4], top: TERM });
  await wd.checkMemory();
  ok(`⑦ 95.4% 에서는 알림만 (${sent.length}통 · 예약 ${wd.pendingKills.size})`, sent.length === 1 && wd.pendingKills.size === 0);
  await wd.checkMemory();
  eq('⑦ 커지지 않으면 3분마다 다시 알리지 않는다', sent.length, 1);
  wd.getSystemCommitStatus = async () => ({ committedMB: 47500, limitMB: 48914, usagePct: 97.3 });
  wd.getProcessMB = async () => 11500;
  await wd.checkMemory();
  ok('⑦ 97% 를 넘으면 다시 판정해 종료 예약', wd.pendingKills.has(41));
  await new Promise((r) => setTimeout(r, 1500));
  wd.stop();
}
{
  const lines = fs.readFileSync(process.env.MEMORY_WATCHDOG_EVENTS_FILE, 'utf-8').trim().split('\n').map(JSON.parse);
  ok('판정 · 취소 · 자동 종료가 기록에 남는다', ['decide', 'cancel', 'auto-kill'].every((p) => lines.some((l) => l.phase === p)));
}

// ── 분석과 대안 버튼 (2026-10-27) ─────────────────────────────────────
//   ⑧ AI 가 무엇을 쓰든 실행할 수 있는 것만 남는다 — 보호 대상 · 스냅샷에 없는 pid · 자손에 보호 대상이 있는 통째 종료는 버린다
//   ⑨ 대화형 세션은 대안이 될 수 있다(사람이 눌러야 실행) · 끄는 버튼은 확인 창을 단다 · 직접 할 일은 버튼이 없다
//   ⑩ 버튼을 누르면 같은 프로세스인지 보고 끄고 · 결과를 그 줄에 붙이고 · 그 버튼만 걷는다
const A = require(path.join(ROOT, 'dist', 'memory-analysis.js'));
const SNAP = {
  summary: {
    measured_at: '2026-10-27T10:00:00', boot: '2026-10-26T18:00:00', committed: 44 * 2 ** 30, limit: 48 * 2 ** 30,
    available: 2 * 2 ** 30, pct: 91.7, process_private: 20 * 2 ** 30, kernel_pools: 18 * 2 ** 30, remainder: 6 * 2 ** 30,
    ai_total: 3 * 2 ** 30,
    ai_sessions: [{ pid: 42, name: 'claude', host: 'windowsterminal', tag: 'korean', created: '2026-10-27T08:00:00',
      ticks: '639286000000000000', procs: 3, priv: 2 ** 30, cpu: 100, children: {} }],
    non_ai_by_exe: [], pool_tags: [],
  },
  top_procs: [
    { pid: 40, ppid: 5, name: 'chrome.exe', parent: 'explorer.exe', priv: 2 ** 30, created: '', ticks: '639286000000000001', cmd: 'chrome.exe' },
    { pid: 32, ppid: 31, name: 'python.exe', parent: 'python.exe', priv: 4 * 2 ** 30, created: '', ticks: '639286000000000002', cmd: 'sync' },
    { pid: 5, ppid: 1, name: 'explorer.exe', parent: 'wininit.exe', priv: 2 ** 29, created: '', ticks: '639286000000000003', cmd: '' },
    { pid: 41, ppid: 5, name: 'WindowsTerminal.exe', parent: 'explorer.exe', priv: 4 * 2 ** 30, created: '', ticks: '639286000000000004', cmd: '' },
  ],
  baseline: { file: 'b.json', from: '2026-10-27T09:00:00', to: '2026-10-27T10:00:00', minutes: 60,
    deltas: { committed: 22 * 2 ** 30, process_private: 6 * 2 ** 30, kernel_pools: 13 * 2 ** 30, remainder: 3 * 2 ** 30, ai_total: 0 },
    sessions: [], exe_growth: [], pool_tag_growth: [{ tag: 'FMfn', hint: '필터 관리자 파일 이름', delta: 5 * 2 ** 30, now: 6 * 2 ** 30 }] },
  previous: { file: 'p.json', from: '', to: '', minutes: 30, deltas: {}, exe_growth: [], pool_tag_growth: [],
    sessions: [{ pid: 42, name: 'claude', host: 'windowsterminal', tag: 'korean', priv: 2 ** 30, priv_delta: 0, cpu_delta: 0.4 }] },
  file: 'now.json',
};
{
  const roles = W.classifyRoles(ROWS, { botPid: BOT, pipelinePid: 30 });
  const kids = new Map([[5, [40, 41, 42]], [41, [42]], [30, [31, 32]]]);
  const descendants = (pid) => { const out = []; const st = [...(kids.get(pid) || [])]; while (st.length) { const c = st.pop(); out.push(c); st.push(...(kids.get(c) || [])); } return out; };
  const answer = JSON.stringify({ action: 'wait', pid: null, reason: 'x', analysis: '커널 풀이 13GB 늘었다',
    options: [
      { action: 'kill_tree', pid: 42, label: '쉬는 korean 세션', reason: 'CPU 0', expect_gb: 1, loss: 'claude -r korean' },
      { action: 'kill', pid: 32, label: '동기화', reason: '큼', expect_gb: 4 },
      { action: 'kill', pid: 999, label: '없는 것', reason: '' },
      { action: 'kill_tree', pid: 30, label: '러너', reason: '' },
      { action: 'kill', pid: 5, label: '탐색기', reason: '' },
      { action: 'shell', label: '아무 명령', reason: '' },
      { action: 'reboot', label: '재시작', reason: '커널 풀', expect_gb: 13 },
      { action: 'manual', label: '검색 중단', reason: '홈 전체 검색' },
      { action: 'kill', pid: 40, label: '크롬', reason: '' },
      { action: 'kill', pid: 41, label: '터미널', reason: '' },
    ] });
  const v = A.vetOptions(answer, { snap: SNAP, roles, botPid: BOT, descendants });
  eq('⑧ 남는 대안(보호 · 없는 pid · 시스템 · 모르는 갈래 버림 · 넷까지)', v.options.map((o) => o.label), ['쉬는 korean 세션', '재시작', '검색 중단', '크롬']);
  ok(`⑧ 버린 사유가 남는다 (${v.dropped.join(' / ')})`, v.dropped.some((d) => d.includes('보호')) && v.dropped.some((d) => d.includes('스냅샷에 없는')));
  eq('⑧ 세션 대안은 이름과 생성 시각을 스냅샷에서 받는다', [v.options[0].name, v.options[0].ticks], ['claude', '639286000000000000']);
  const tree5 = A.vetOptions(JSON.stringify({ options: [{ action: 'kill_tree', pid: 41, label: '터미널 통째', reason: '' }] }),
    { snap: SNAP, roles: new Map([...roles, [42, 'stanley']]), botPid: BOT, descendants });
  eq('⑧ 자손에 보호 대상이 있으면 통째 종료 버림', tree5.options.length, 0);
  const wz = W.classifyRoles([{ pid: 60, ppid: 1, name: 'wezterm-gui', cmd: '' }, { pid: 61, ppid: 60, name: 'claude', cmd: 'claude -r a' }],
    { botPid: BOT, pipelinePid: null });
  eq('⑧ WezTerm 안의 세션도 대화형 — 시스템 경로 자동 종료 후보가 아니다', wz.get(61), 'interactive');
  eq('⑧ 답이 JSON 이 아니면 빈 대안', A.vetOptions('모르겠음', { snap: SNAP, roles, botPid: BOT, descendants }).options.length, 0);

  const btn = A.optionButtons('g1', v);
  const els = btn.elements;
  eq('⑨ 버튼 — 직접 할 일은 빼고 「그대로 둠」을 끝에', els.map((e) => e.value), ['g1:0', 'g1:1', 'g1:3', 'g1:x']);
  ok('⑨ 끄는 버튼은 확인 창과 빨간색', els[0].confirm && els[0].style === 'danger' && !els[1].confirm);
  ok('⑨ action_id 가 버튼마다 다르다', new Set(els.map((e) => e.action_id)).size === els.length);
  const dig = A.snapshotDigest(SNAP, roles);
  ok('⑨ 프롬프트 내역에 기준 대비 · 쉬는 세션 · 보호 표시', dig.includes('커널 풀 +13.0') && dig.includes('| 42 | claude | korean') && dig.includes('보호(pipeline)'));
  ok('⑨ 사람에게 보이는 첫 줄', A.snapshotHeadline(SNAP).includes('커밋 +22.0GB') && A.snapshotHeadline(SNAP).includes('커널 풀 +13.0'));
}
{
  process.env.MEMORY_WATCHDOG_OPTIONS_FILE = path.join(tmp, 'options.json');
  const snapAnswer = JSON.stringify({ action: 'wait', pid: null, reason: '주범 없음', analysis: '세션이 쉼',
    options: [{ action: 'kill_tree', pid: 42, label: '쉬는 korean 세션', reason: 'CPU 0', expect_gb: 1 },
      { action: 'kill', pid: 40, label: '크롬', reason: '탭', expect_gb: 1 }] });
  const sentBlocks = [];
  const updates = [];
  const wd = new W.ProcessMemoryWatchdog(90, 180, 600, 7168,
    async (text, blocks) => { sentBlocks.push(blocks); return 'ts1'; },
    async (ts, text, blocks) => { updates.push({ text, blocks }); },
    undefined,
    { reviewer: async () => snapAnswer, pipelineLockFile: path.join(tmp, 'nolock.json'), analysis: true, snapshotTool: 'x' });
  wd.getSystemCommitStatus = async () => ({ committedMB: 44000, limitMB: 48914, usagePct: 91.4 });
  wd.getTopProcesses = async () => TOP;
  wd.getProcessTable = async () => ROWS.map((r) => (r.pid === BOT ? { ...r, pid: process.pid } : r.ppid === BOT ? { ...r, ppid: process.pid } : r));
  wd.reportKnownIssues = async () => {};
  wd.takeSnapshot = async () => SNAP;
  const killed = [];
  wd.killIfSameCreated = (pid, name, ticks, tree) => { killed.push([pid, name, tree]); return 'killed'; };
  await wd.checkMemory();
  const acts = (sentBlocks[0] || []).find((b) => b.type === 'actions');
  ok(`⑩ 경고에 대안 버튼이 붙는다 (${JSON.stringify(acts?.elements?.map((e) => e.value))})`, acts && acts.elements.length === 3);
  const realSetTimeout = global.setTimeout;
  global.setTimeout = (fn) => realSetTimeout(fn, 0);
  await wd.handleOptionAction(acts.elements[0].value, 'ts1');
  global.setTimeout = realSetTimeout;
  eq('⑩ 세션 대안은 자식까지 끈다', killed, [[42, 'claude', true]]);
  const last = updates.at(-1);
  const left = last.blocks.find((b) => b.type === 'actions');
  ok(`⑩ 결과가 그 줄에 붙고 그 버튼만 걷힌다 (${left?.elements.map((e) => e.value)})`,
    last.text.includes('종료함') && last.text.includes('커밋 91.4%') && left.elements.length === 2);
  await wd.handleOptionAction(acts.elements[0].value, 'ts1');
  eq('⑩ 같은 버튼을 두 번 눌러도 한 번만', killed.length, 1);
  await wd.handleOptionAction('없는그룹:0', 'ts1');
  ok('⑩ 모르는 그룹은 「만료」', updates.at(-1).text.includes('만료'));
  const ev = fs.readFileSync(process.env.MEMORY_WATCHDOG_EVENTS_FILE, 'utf-8').trim().split('\n').map(JSON.parse);
  ok('⑩ 판정 기록에 분석 · 대안 · 버튼 실행이 남는다',
    ev.some((e) => e.phase === 'decide' && e.options?.length === 2) && ev.some((e) => e.phase === 'option' && e.pid === 42));
  wd.stop();
}
// ⑪ 자동 종료 확인에 붙은 대안 — Slack 은 글만 주고 블록을 빼면 블록을 지운다(chat.update 문서).
//   Kill · Ignore 로 메시지를 고쳐도 분석과 남은 버튼이 살아 있고 · 「그대로 둠」은 Kill · Ignore 를 안 지우고 ·
//   통째 종료는 누르는 지금 자식에 상시 작업이 있으면 안 끄고 · 동시에 두 번 눌러도 한 번만
{
  process.env.MEMORY_WATCHDOG_OPTIONS_FILE = path.join(tmp, 'options11.json');
  const sent = [];
  const updates = [];
  const wd = new W.ProcessMemoryWatchdog(90, 180, 600, 7168,
    async (text, blocks) => { sent.push(blocks); return `ts${sent.length}`; },
    async (ts, text, blocks) => { updates.push({ ts, text, blocks }); },
    undefined, { pipelineLockFile: path.join(tmp, 'nolock.json'), analysis: true, snapshotTool: 'x' });
  wd.getSystemCommitStatus = async () => ({ committedMB: 44000, limitMB: 48914, usagePct: 91.4 });
  const killed = [];
  wd.killIfSameCreated = (pid) => { killed.push(pid); return 'killed'; };
  const extra = { head: '📊 머리', analysis: { text: '세션이 쉼', options: [
    { action: 'kill_tree', label: '쉬는 세션', reason: 'CPU 0', pid: 42, name: 'claude', ticks: '639286000000000000' },
    { action: 'kill', label: '크롬', reason: '탭', pid: 40, name: 'chrome', ticks: '639286000000000001' }] } };
  const killRow = { type: 'actions', elements: [{ action_id: 'watchdog_kill', value: '77' }, { action_id: 'watchdog_ignore', value: '77' }] };
  const pend = (pid, ts) => wd.pendingKills.set(pid, { pid, name: 'chrome', commitMB: 9000, startTicks: '1', messageTs: ts,
    timer: setTimeout(() => {}, 60_000) });
  const ids = (blocks) => (blocks || []).filter((b) => b.type === 'actions').flatMap((b) => b.elements.map((e) => e.action_id));
  const gidOf = (blocks) => blocks.find((b) => b.elements?.some((e) => e.action_id === 'watchdog_opt_x')).elements[0].value.split(':')[0];

  const tsA = await wd.sendWithOptions('확인 글', extra, [killRow], 77);
  pend(77, tsA);
  await wd.handleIgnoreAction(77);
  const u1 = updates.at(-1);
  ok(`⑪ Ignore 뒤에도 분석과 대안 버튼이 남는다 (${ids(u1.blocks)})`,
    u1.text.includes('세션이 쉼') && ids(u1.blocks).includes('watchdog_opt_0') && !ids(u1.blocks).includes('watchdog_ignore'));

  const tsB = await wd.sendWithOptions('확인 글', extra, [killRow], 78);
  pend(78, tsB);
  await wd.handleOptionAction(`${gidOf(sent.at(-1))}:x`, tsB);
  const u2 = updates.at(-1);
  ok(`⑪ 「그대로 둠」은 자동 종료가 기다리는 동안 Kill · Ignore 를 남긴다 (${ids(u2.blocks)})`,
    ids(u2.blocks).includes('watchdog_ignore') && !ids(u2.blocks).includes('watchdog_opt_0'));
  clearTimeout(wd.pendingKills.get(78).timer);
  wd.pendingKills.delete(78);

  const realSetTimeout = global.setTimeout;
  global.setTimeout = (fn) => realSetTimeout(fn, 0);
  await wd.sendWithOptions('경고 글', extra, []);
  const gC = gidOf(sent.at(-1));
  wd.getProcessTable = async () => [{ pid: 42, ppid: 1, name: 'claude', cmd: '' }, { pid: process.pid, ppid: 42, name: 'node', cmd: 'dist/index.js' }];
  // 두 대안을 함께 누르고 같은 버튼은 두 번 — 결과가 5초 뒤에 적히는 사이의 겹침
  await Promise.all([wd.handleOptionAction(`${gC}:0`, 'tsC'), wd.handleOptionAction(`${gC}:1`, 'tsC'),
    wd.handleOptionAction(`${gC}:1`, 'tsC')]);
  global.setTimeout = realSetTimeout;
  eq('⑪ 통째 종료는 누를 때 자식에 스탠리가 있으면 안 끈다 · 같은 버튼을 동시에 두 번 눌러도 한 번만', killed, [40]);
  const last = updates.at(-1);
  ok('⑪ 두 대안의 결과가 다 남는다(나중 것이 앞 것을 안 덮음)', last.text.includes('끄지 않음') && last.text.includes('종료함'));
  wd.stop();
}

fs.rmSync(tmp, { recursive: true, force: true });
if (fails.length) {
  console.error(`\n실패 ${fails.length}건\n\n  ✗ ${fails.join('\n\n  ✗ ')}\n`);
  process.exitCode = 1;
} else {
  console.log('통과 — 메모리 감시기 (상시 작업 보호 · 폭주는 끊음 · AI 는 규칙 안 · 쏘기 직전 재확인 · 조상 제외 · 봉우리당 한 번 · 기록)');
}
