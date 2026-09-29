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
  eq('그 밖은 역할 없음', [r(40), r(41), r(42), r(5)], [null, null, null, null]);
  const noLock = W.classifyRoles(ROWS, { botPid: BOT, pipelinePid: null });
  eq('잠금 파일이 없으면 러너 계보를 모른다', noLock.get(32) ?? null, null);
}

// ── 판정 ──────────────────────────────────────────────────────────────
const C = (pid, name, mb, role = null, growth = 0) => ({ pid, name, commitMB: mb, startTicks: '1', role, growthMB: growth, parent: '', cmd: '' });
const base = { processThresholdMB: 7168, runawayDelaySec: 180, systemDelaySec: 600, lineageKnown: true };
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
async function oneRound({ reviewer, pctSeq, top, delaySec = 600 }) {
  const sent = [];
  const updated = [];
  const lock = path.join(tmp, `lock-${Math.random()}.json`);
  fs.writeFileSync(lock, JSON.stringify({ pid: 30 }));
  const wd = new W.ProcessMemoryWatchdog(90, 180, delaySec, 7168,
    async (text) => { sent.push(text); return `ts${sent.length}`; },
    async (ts, text) => { updated.push(text); },
    undefined,
    { reviewer, pipelineLockFile: lock, runawayDelaySec: 0.05 });
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
  });
  await wd.checkMemory();
  ok('③ AI 가 고른 브라우저로 종료 예약', wd.pendingKills.has(40) && sent[0].includes('chrome'));
  await new Promise((r) => setTimeout(r, 400));
  ok(`④ 쏘기 직전 89.4% → 취소 · 안 죽임 (${updated.join(' / ')})`, kills.length === 0 && updated.some((u) => u.includes('압박이 풀려')));
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
  const lines = fs.readFileSync(process.env.MEMORY_WATCHDOG_EVENTS_FILE, 'utf-8').trim().split('\n').map(JSON.parse);
  ok('판정 · 취소 · 자동 종료가 기록에 남는다', ['decide', 'cancel', 'auto-kill'].every((p) => lines.some((l) => l.phase === p)));
}

fs.rmSync(tmp, { recursive: true, force: true });
if (fails.length) {
  console.error(`\n실패 ${fails.length}건\n\n  ✗ ${fails.join('\n\n  ✗ ')}\n`);
  process.exitCode = 1;
} else {
  console.log('통과 — 메모리 감시기 (상시 작업 보호 · 폭주는 끊음 · AI 는 규칙 안 · 쏘기 직전 재확인 · 조상 제외 · 봉우리당 한 번 · 기록)');
}
