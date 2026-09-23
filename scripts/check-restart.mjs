/**
 * 재시작 감쌈이 실제로 막는가.
 *
 *   npm run check:restart
 *
 * **막는 시늉만 하는 문은 없느니만 못하다** — 있다고 믿고 안 세게 된다.
 * 그래서 걸려야 하는 두 자리를 실제로 걸어 본다. 전부 `--dry` 라 봇은 안 건드린다.
 *
 *   ① 아직 반영 안 된 사람 말(지금 도는 차례)이 있으면 멈추는가
 *   ①-c 오래 열린 캡처(차례가 끝난 질문·조회)는 막지 않고 알리기만 하는가 — 2026-09-23 오탐
 *   ①-d 오래됐어도 포인터에 있으면(긴 차례가 도는 중) 멈추는가
 *   ② 큐가 방금 움직였으면 기다리는가
 *   ③ 아무것도 안 걸리면 통과시키는가 (막기만 하는 문도 고장이다)
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'restart.mjs');
const fails = [];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-check-'));

/** 깨끗한 판 — 캡처 없음 · 큐 조용함. 여기서 출발해 한 가지씩 더럽힌다. */
const cleanRoot = path.join(tmp, 'clean');
fs.mkdirSync(cleanRoot);
fs.writeFileSync(path.join(cleanRoot, 'inbox.jsonl'),
  JSON.stringify({ id: 'a1', ts: '2026-08-21T10:00', text: '끝난 것', status: 'filed' }) + '\n');

const quietLog = path.join(tmp, 'quiet.log');
fs.writeFileSync(quietLog, '[2020-01-01T00:00:00.000Z] [INFO] [BoardQueue] 반영 — 오래된 것\n');

const busyLog = path.join(tmp, 'busy.log');
const justNow = new Date().toISOString();
fs.writeFileSync(busyLog, `[${justNow}] [INFO] [BoardQueue] 큐에서 1건 가져옴: c-test(ask) 방금\n`);

const dirtyRoot = path.join(tmp, 'dirty');
fs.mkdirSync(dirtyRoot);
fs.writeFileSync(path.join(dirtyRoot, 'inbox.jsonl'),
  JSON.stringify({ id: 'b2', ts: new Date().toISOString(), text: '[진행판] 아직 안 된 말', status: 'open' }) + '\n');

/** 두 시간 전에 붙고 안 닫힌 질문 — 판에 쓸 것이 없어 차례가 끝나도 열린 채 남는 꼴. */
const staleRoot = path.join(tmp, 'stale');
fs.mkdirSync(staleRoot);
fs.writeFileSync(path.join(staleRoot, 'inbox.jsonl'),
  JSON.stringify({ id: 'c3', ts: new Date(Date.now() - 2 * 3600_000).toISOString(), text: '규정 알려줘 — 오래된 질문', status: 'open' }) + '\n');

/** 포인터 폴더 — **진짜 `~/.claude/state` 를 안 읽게** 비운 것과, c3 이 도는 중인 것 둘. */
const noLive = path.join(tmp, 'state-empty');
fs.mkdirSync(noLive);
const liveC3 = path.join(tmp, 'state-live');
fs.mkdirSync(liveC3);
fs.writeFileSync(path.join(liveC3, 'work-capture-D1.json'), JSON.stringify({ id: 'c3', at: '2026-09-23T10:00:00' }));

function run(env, extra = []) {
  const r = spawnSync(process.execPath, [SCRIPT, '--dry', ...extra], {
    encoding: 'utf-8',
    timeout: 30_000,
    env: { ...process.env, WORK_CAPTURE_STATE_DIR: noLive, ...env },
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

// ③ 깨끗하면 통과 — 이게 먼저다. 늘 막는 문이면 ①②가 통과해도 의미가 없다.
const clean = run({ WORK_ASSISTANT_ROOT: cleanRoot, BOT_LOG_PATH: quietLog });
if (clean.code !== 0) {
  fails.push(`걸릴 것이 없는데 막았다 (rc ${clean.code}) — ${clean.out.trim().split('\n').pop()}`);
}

// ① 반영 안 된 사람 말이 있으면 멈춘다
const dirty = run({ WORK_ASSISTANT_ROOT: dirtyRoot, BOT_LOG_PATH: quietLog });
if (dirty.code === 0) {
  fails.push('아직 반영 안 된 사람 말이 있는데 그냥 재시작한다 — 2026-08-21 에 말을 죽인 그 자리');
} else if (!dirty.out.includes('진행판')) {
  fails.push('막기는 했는데 무엇이 걸렸는지 안 보여준다 — 사람이 다음에 뭘 할지 모른다');
}

// ①-c 오래 열린 캡처는 막지 않는다 — 차례가 끝난 질문·조회라 재시작과 무관하다(2026-09-23 오탐)
const stale = run({ WORK_ASSISTANT_ROOT: staleRoot, BOT_LOG_PATH: quietLog });
if (stale.code !== 0) {
  fails.push('차례가 끝난 오래된 캡처 하나로 재시작을 막는다 — 2026-09-23 의 오탐');
} else if (!stale.out.includes('오래 열린')) {
  fails.push('오래 열린 캡처를 막지 않되 알리지도 않는다 — 조용히 쌓인다');
}

// ①-d 오래됐어도 포인터에 있으면 도는 차례다 — 30분 넘게 도는 긴 차례를 죽이면 안 된다
const liveOld = run({ WORK_ASSISTANT_ROOT: staleRoot, BOT_LOG_PATH: quietLog, WORK_CAPTURE_STATE_DIR: liveC3 });
if (liveOld.code === 0) {
  fails.push('포인터에 있는(지금 도는) 캡처를 오래됐다는 이유로 그냥 재시작한다');
}

// ①-b `--force` 는 뚫려야 한다. 못 뚫으면 급할 때 스크립트를 우회하게 되고,
//      우회하는 순간 검사는 없는 것이 된다.
const forced = run({ WORK_ASSISTANT_ROOT: dirtyRoot, BOT_LOG_PATH: quietLog }, ['--force']);
if (forced.code !== 0) {
  fails.push('--force 로도 못 지나간다 — 급하면 스크립트를 건너뛰게 된다');
}

// ② 큐가 방금 움직였으면 기다린다 (여기서는 기다리기 시작하는 것까지만 본다)
const busy = run({ WORK_ASSISTANT_ROOT: cleanRoot, BOT_LOG_PATH: busyLog });
if (!busy.out.includes('기다립니다')) {
  fails.push('큐가 방금 움직였는데 안 기다린다 — 도는 세션을 죽인다');
}

fs.rmSync(tmp, { recursive: true, force: true });

if (fails.length) {
  console.log(`실패 ${fails.length}건`);
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exitCode = 1;
} else {
  console.log('통과 — 깨끗하면 지나가고 · 도는 사람 말이 있으면 멈추고 · 끝난 오래된 캡처는 알리기만 · 큐가 돌면 기다리고 · --force 는 뚫린다');
}
