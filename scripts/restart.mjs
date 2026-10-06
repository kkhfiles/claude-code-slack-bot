/**
 * 재시작하기 전에 도는 일을 한 번 세고 간다.
 *
 *   npm run restart          -- 안전하면 재시작, 아니면 멈추고 무엇이 걸렸는지 말함
 *   npm run restart -- --force   -- 다 알고 그냥 함
 *   npm run restart -- --dry     -- 세기만 하고 재시작은 안 함
 *   npm run restart -- --keep-env   -- pm2 에 저장된 환경을 그대로 두고 재시작(`--update-env` 없이)
 *
 * `--keep-env` 는 SDK 판 맞춤(`sdk-update.mjs`)이 쓴다 — 그 프로세스는 봇 환경(`.env` 를 읽은 값)을 물려받아서,
 * `--update-env` 로 재시작하면 그 값이 pm2 저장 환경에 박혀 이후 `.env` 를 고쳐도 안 먹는다(검토 2026-09-29).
 * **SDK 판 맞춤이 도는 동안은 멈춘다** — `node_modules`·`dist` 가 반쯤 바뀐 채로 뜨면 시험 안 한 것이 돈다.
 * 판 맞춤 자신이 부른 재시작만 통과한다(`SDK_UPDATE_SELF=1`).
 *
 * **왜 있나.** 2026-08-21 에 판을 고치던 세션이 판을 쓰는 사람의 말을 죽였다.
 * 큐가 17:46:28 에 TSK-35 메모를 세션에 넘겼고, 6초 뒤 `pm2 restart` 가 그
 * 세션을 죽였다. 다시 가져왔을 때는 **부르기 전에 찍어 둔 처리 표시** 때문에
 * 「이미 반영한 것」으로 버려졌다(`board-queue.ts` 의 「한 번만 시도한다」).
 * 원문은 캡처 큐에 살아 있었지만, 그 사실을 말해 주는 것은 다음 브리핑의 ⛔
 * 하나뿐이라 14시간 뒤였다.
 *
 * **규칙 파일에 「재시작 전에 확인할 것」이라고 적지 않는다** — 사람이 기억해야
 * 하는 구조는 실패한다(실측 선례: 나흘 살아남은 개발 서버). 재시작하는 길
 * 자체에 검사를 붙여 잊을 수가 없게 한다.
 *
 * **두 가지를 센다.**
 *
 *   ① 열린 캡처 중 **지금 도는 차례** — 있으면 **멈춘다**. 아직 반영 안 된 사람 말이
 *      있다는 뜻이고, 재시작한다고 해결되지 않는다(오히려 지금 도는 것을 또 죽인다).
 *      「도는 차례」는 봇이 차례 동안 적어 두는 포인터에 id 가 있거나, 붙은 지
 *      `IN_FLIGHT_MS` 안인 것(차례를 기다리는 말)이다.
 *
 *      ⚠️ **열린 캡처를 전부 세면 오탐이다**(2026-09-23 고침). 판에 아무것도 안 쓰는
 *      질문·조회는 캡처가 안 닫힌 채 남는다(닫히는 길이 「쓰기 성공」뿐이라).
 *      그래서 18시간 전 질문 하나가 재시작을 막았고, 9/7·9/8·9/22 에 사람이 손으로
 *      버렸다. 그런 캡처는 차례가 이미 끝난 것이라 재시작과 무관하다 — 알리기만 한다.
 *   ② 방금 큐가 움직였나 — 마지막 `[BoardQueue]` 줄이 최근이면 **기다린다**.
 *      곧 끝나므로 멈출 것 없이 몇 초 쉬었다 다시 본다.
 *   ③ 지금 떠 있는 봇이 연 분석 회차가 아직 안 닫혔나 — 있으면 **멈춘다**(아래 `openAnalysisRuns`).
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const APP = 'claude-slack-bot';
/**
 * 붙은 지 이 안인 열린 캡처는 도는 차례(또는 차례를 기다리는 말)로 본다.
 * 파이썬이 포인터를 믿는 시간(`tasks.py` 의 `CAPTURE_FILE_TTL_MIN` 30분)과 같게 둔다 —
 * 그보다 오래된 차례는 쓰기를 해도 그 캡처를 못 닫으므로 시스템 스스로 끝난 것으로 본다.
 */
const IN_FLIGHT_MS = 30 * 60_000;
/** 큐가 이 안에 움직였으면 도는 중으로 본다. 한 건 처리에 20~30초 걸린다. */
const QUEUE_QUIET_MS = 45_000;
/** 조용해지기를 이만큼까지 기다린다. 넘으면 사람에게 넘긴다. */
const WAIT_MAX_MS = 180_000;
const POLL_MS = 5_000;

const args = new Set(process.argv.slice(2));
const force = args.has('--force');
const dry = args.has('--dry');
const RESTART_CMD = `pm2 restart ${APP}${args.has('--keep-env') ? '' : ' --update-env'}`;
/** SDK 판 맞춤 결과 — 이보다 오래 `running` 이면 멈춘 것으로 보고 막지 않는다. */
const SDK_UPDATE_STALE_MS = 2 * 60 * 60_000;

/** 도는 SDK 판 맞춤(`~/.claude/state/sdk-update-result.json` 의 `running`). 없거나 판 맞춤 자신이면 null. */
function activeSdkUpdate() {
  if (process.env.SDK_UPDATE_SELF === '1') return null;
  const file = process.env.SDK_UPDATE_RESULT || path.join(os.homedir(), '.claude', 'state', 'sdk-update-result.json');
  try {
    const r = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (r?.status === 'running' && Date.now() - Date.parse(r.startedAt) < SDK_UPDATE_STALE_MS) return r;
  } catch { /* 없으면 도는 것도 없다 */ }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pm2Info() {
  try {
    const list = JSON.parse(execSync('pm2 jlist', { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }));
    return list.find((p) => p.name === APP) || null;
  } catch {
    return null;
  }
}

/**
 * 지금 차례를 돌고 있는 캡처 id — 봇이 차례 동안 방마다 적어 두고 끝나면 지우는 포인터
 * (`slack-handler.ts` 의 `capturePointer`). **검사가 진짜 상태를 안 읽게 경로를 넣을 수 있다.**
 */
function liveCaptureIds() {
  const dir = process.env.WORK_CAPTURE_STATE_DIR || path.join(os.homedir(), '.claude', 'state');
  const ids = new Set();
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!/^work-capture-.*\.json$/.test(name)) continue;
      try {
        const id = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf-8')).id;
        if (id) ids.add(id);
      } catch { /* 깨진 포인터는 없는 것으로 */ }
    }
  } catch { /* 폴더가 없으면 도는 차례가 없다 */ }
  return ids;
}

/**
 * 열린 캡처를 둘로 가른다 — `inFlight` 는 재시작을 막고, `stale` 은 알리기만 한다.
 * **못 읽으면 빈 목록** — 검사 때문에 재시작이 막히면 안 된다.
 */
function openCaptures() {
  const root = process.env.WORK_ASSISTANT_ROOT || 'P:/github/work-assistant';
  const file = path.join(root, 'inbox.jsonl');
  let open = [];
  try {
    open = fs.readFileSync(file, 'utf-8')
      .split('\n').filter((l) => l.trim())
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      // ⚠️ **실패 자국이 있는 것은 안 센다** — 이 문이 막는 것은 「지금 돌고
      // 있는 차례」이지 「이미 죽은 차례」가 아니다. 밀린 것은 기동 때 드레인이
      // 다시 돌리므로, 여기서 붙잡으면 **고칠 것이 고치는 길을 막는다**
      // (2026-09-01 에 실제로 그랬다 — 밀린 한 건이 재시작을 통째로 막았다).
      .filter((r) => r && r.status === 'open' && !r.failed);
  } catch {
    return { inFlight: [], stale: [] };
  }
  const live = liveCaptureIds();
  const now = Date.now();
  const inFlight = [];
  const stale = [];
  for (const r of open) {
    const at = Date.parse(r.ts || '');
    if (live.has(r.id) || (Number.isFinite(at) && now - at < IN_FLIGHT_MS)) inFlight.push(r);
    else stale.push(r);
  }
  return { inFlight, stale };
}

/**
 * 도는 중인 처리 제안 세션 — report-log 의 작업 잡기 표시(`jobs/active.json`). 없거나 제한 시간이
 * 지났으면 null. 재시작하면 그 세션이 죽고, 표시는 제한 시간이 지나야 풀려 그동안 모든 제안이 멈춘다.
 * **검사가 진짜 상태를 안 읽게 경로를 넣을 수 있다.**
 */
function activeActionJob() {
  const dir = process.env.REPORT_LOG_STATE || path.join(os.homedir(), '.report-log');
  try {
    const a = JSON.parse(fs.readFileSync(path.join(dir, 'jobs', 'active.json'), 'utf-8'));
    if (a && Date.parse(a.deadline) > Date.now()) return a;
  } catch { /* 없으면 도는 세션도 없다 */ }
  return null;
}

/**
 * 아직 안 닫힌 분석 회차 — report-log 회차 기록(`runs/*.json`)의 `open` · `editing` 을 둘로 가른다.
 *
 * - `live` — 지금 떠 있는 봇이 연 것(연 시각 ≥ 봇 시작 시각). 재시작하면 그 세션이 죽고 회차는
 *   판정 없이 남아 정리 작업(`sweep`)이 6시간 뒤에야 기계 초안으로 저장한다 · 그룹이면 뒤 차례
 *   종류는 아예 안 돈다. 2026-10-02 에 두 번 — 00:53 자정 그룹 뒤 차례 · 12:26 정오 판정.
 *   한도 뒤 재시도를 기다리는 회차도 여기 든다 — 재시작하면 재시도 예약이 사라지므로 막는 것이 맞다.
 * - `orphan` — 봇이 뜨기 전에 열린 것. 주인 세션이 이미 없어 재시작과 무관하다 — 알리기만 한다.
 *
 * 봇 시작 시각은 pm2 의 `pm_uptime` · 시험은 `BOT_STARTED_AT` 으로 넣는다. **회차 기록 폴더를 못
 * 읽으면 빈 목록 · 봇 시작 시각을 모르면 전부 `orphan`(알리기만)** — 검사 때문에 재시작이 막히면 안 된다.
 * 봇이 뜬 뒤 명령줄로 손수 연 회차도 `live` 로 센다 — 가를 표지가 없어 막는 쪽을 골랐다(`--force`).
 * **검사가 진짜 상태를 안 읽게 경로를 넣을 수 있다.**
 */
function openAnalysisRuns(startedAtMs) {
  const dir = path.join(process.env.REPORT_LOG_STATE || path.join(os.homedir(), '.report-log'), 'runs');
  const live = [];
  const orphan = [];
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch {
    return { live, orphan };
  }
  for (const name of names) {
    let r;
    try { r = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf-8')); } catch { continue; }
    if (!r || (r.status !== 'open' && r.status !== 'editing')) continue;
    const at = Date.parse(r.opened_at || '');
    if (Number.isFinite(at) && Number.isFinite(startedAtMs) && at >= startedAtMs) live.push(r);
    else orphan.push(r);
  }
  return { live, orphan };
}

/** 로그 꼬리에서 마지막 큐 활동 시각. 없으면 null. 파일이 19MB 라 끝만 읽는다. */
function lastQueueActivity(logPath) {
  if (!logPath) return null;
  try {
    const size = fs.statSync(logPath).size;
    const start = Math.max(0, size - 64 * 1024);
    const fd = fs.openSync(logPath, 'r');
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    const lines = buf.toString('utf-8').split('\n');
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (!lines[i].includes('[BoardQueue]')) continue;
      const m = lines[i].match(/^\[(\d{4}-\d\d-\d\dT[\d:.]+Z)\]/);
      if (m) return { at: new Date(m[1]), line: lines[i].slice(0, 120) };
    }
  } catch {
    return null;
  }
  return null;
}

const proc = pm2Info();
if (!proc) {
  console.log(`⚠️ pm2 에 ${APP} 이 없습니다 — 셀 것이 없어 그냥 넘깁니다`);
  if (!dry) execSync(RESTART_CMD, { stdio: 'inherit' });
  process.exit(0);
}

const stuck = (() => {
  const root = process.env.WORK_ASSISTANT_ROOT || 'P:/github/work-assistant';
  try {
    return fs.readFileSync(path.join(root, 'inbox.jsonl'), 'utf-8')
      .split('\n').filter((l) => l.trim())
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((r) => r && r.status === 'open' && r.failed).length;
  } catch { return 0; }
})();
if (stuck) console.log(`↻ 처리 못 하고 밀린 ${stuck}건 — 기동하면 다시 돌립니다`);

const { inFlight: captures, stale } = openCaptures();
if (stale.length) {
  console.log(`· 오래 열린 캡처 ${stale.length}건 — 차례가 이미 끝난 것이라 재시작을 막지 않습니다`
    + ' (판에 쓰기가 없던 질문·조회는 안 닫힌 채 남습니다 · 정리: python -X utf8 bin/tasks.py inbox list)');
  for (const c of stale) {
    console.log(`   ${c.id}  ${c.ts?.slice(0, 16)}  ${(c.text || '').slice(0, 70).replace(/\n/g, ' ')}`);
  }
}
if (captures.length && !force) {
  console.log(`⛔ 아직 반영 안 된 사람 말 ${captures.length}건(지금 도는 차례) — 재시작하지 않았습니다`);
  for (const c of captures) {
    console.log(`   ${c.id}  ${c.ts?.slice(0, 16)}  ${(c.text || '').slice(0, 70).replace(/\n/g, ' ')}`);
  }
  console.log('\n   처리하거나 버린 뒤에 다시 하세요 —');
  console.log('     python -X utf8 bin/tasks.py inbox list');
  console.log('   그래도 지금 해야 하면 —  npm run restart -- --force');
  process.exit(1);
}

const actionJob = activeActionJob();
if (actionJob && !force) {
  console.log(`⛔ 처리 제안 세션이 도는 중입니다(${actionJob.id} · ${actionJob.job} · `
    + `${String(actionJob.started_at || '').slice(11, 16)} 시작 · ${String(actionJob.deadline).slice(11, 16)} 까지) — 재시작하지 않았습니다`);
  console.log('   끝난 뒤에 다시 하세요 · 그래도 지금 해야 하면 —  npm run restart -- --force');
  process.exit(1);
}

const botStartedAt = process.env.BOT_STARTED_AT
  ? Date.parse(process.env.BOT_STARTED_AT) : Number(proc.pm2_env?.pm_uptime);
const runs = openAnalysisRuns(botStartedAt);
const runLine = (r) => `   ${r.type}  ${r.slot}  ${String(r.opened_at || '').slice(11, 16)} 시작  ${r.status}  ${r.run_id}`;
if (runs.orphan.length) {
  console.log(`· 봇이 뜨기 전에 열린 분석 회차 ${runs.orphan.length}건 — 주인 세션이 이미 없어 재시작을 막지 않습니다`
    + ' (정리 작업이 6시간 뒤 받습니다)');
  for (const r of runs.orphan) console.log(runLine(r));
}
if (runs.live.length && !force) {
  console.log(`⛔ 분석 회차 ${runs.live.length}건이 도는 중입니다 — 재시작하지 않았습니다`);
  for (const r of runs.live) console.log(runLine(r));
  console.log('\n   끝난 뒤에 다시 하세요 —');
  console.log('     python -X utf8 ~/.report-log/repo/tools/report_log.py runs --since <오늘>');
  console.log('   그래도 지금 해야 하면 —  npm run restart -- --force');
  console.log('   (그 회차는 판정 없이 열린 채 남고 정리 작업이 6시간 뒤 기계 초안으로 저장 · 그룹이면 뒤 차례는 안 돎)');
  process.exit(1);
}
if (runs.live.length && force) {
  console.log(`⚠️ 분석 회차 ${runs.live.length}건이 도는 중인데 --force 라 그냥 합니다 — 판정 없이 남습니다`);
}

const sdkUpdate = activeSdkUpdate();
if (sdkUpdate && !force) {
  console.log(`⛔ SDK 판 맞춤이 도는 중입니다(${sdkUpdate.id} · ${String(sdkUpdate.startedAt || '').slice(11, 16)} 시작) `
    + '— 재시작하지 않았습니다(판 맞춤이 끝에 스스로 재시작합니다)');
  console.log('   그래도 지금 해야 하면 —  npm run restart -- --force');
  process.exit(1);
}

// **검사가 진짜 로그를 안 건드리게 경로를 넣을 수 있게 둔다.** 검사가 실제
// 산출물에 쓰면 돌지도 않은 실행이 완주로 보인다(글로벌 규칙).
const logPath = process.env.BOT_LOG_PATH || proc.pm2_env?.pm_out_log_path;
const waitStart = Date.now();
for (;;) {
  const last = lastQueueActivity(logPath);
  const age = last ? Date.now() - last.at.getTime() : Infinity;
  if (!last || age > QUEUE_QUIET_MS || force) {
    if (last && age <= QUEUE_QUIET_MS && force) console.log('⚠️ 큐가 도는 중인데 --force 라 그냥 합니다');
    break;
  }
  if (Date.now() - waitStart > WAIT_MAX_MS) {
    console.log(`⛔ ${Math.round(WAIT_MAX_MS / 1000)}초를 기다려도 큐가 안 멈춥니다 — 재시작하지 않았습니다`);
    console.log(`   마지막 활동: ${last.line}`);
    console.log('   그래도 해야 하면 —  npm run restart -- --force');
    process.exit(1);
  }
  console.log(`⏳ 큐가 ${Math.round(age / 1000)}초 전에 움직였습니다 — 조용해지기를 기다립니다`);
  await sleep(POLL_MS);
}

if (dry) {
  console.log('✅ 걸리는 것 없음 (--dry 라 재시작은 안 했습니다)');
  process.exit(0);
}
console.log('✅ 걸리는 것 없음 — 재시작합니다');
execSync(RESTART_CMD, { stdio: 'inherit' });
