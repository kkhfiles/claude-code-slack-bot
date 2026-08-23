/**
 * Work Board 폴러 자가 검사 — 슬랙도 노션도 타지 않는다.
 *
 *   npm run build
 *   npm run check:board
 *
 * **검사가 서버를 직접 띄우고 트리째 내린다.** 전에는 다른 터미널에서 사람이
 * `wrangler dev` 를 띄워 두기를 요구했는데, **사람이 기억해야 하는 구조는
 * 실패한다** — 검사 아홉 중 이것 하나만 못 도는 상태로 있었다(2026-08-23).
 * 이미 떠 있으면 그것을 쓰고, 없으면 띄웠다가 끝에 내린다.
 *
 * 포트는 **사람이 쓰는 8787 과 다르게** 8788 이다 — 사람이 보던 화면을 검사가
 * 뺏지 않는다. 판을 내주는 곳은 `work-assistant/config.json` 의
 * `board_publish_dir` 에서 읽는다(공개 레포에 남의 디스크 경로를 안 박는다).
 *
 * **여기 케이스는 설계에서 갈렸던 자리들이다.** 두 번 반영하면 진행 로그가 두 줄이
 * 되고, 일시 실패한 것을 지워 버리면 누른 것이 조용히 사라지며, 문법이 아닌 것을
 * 안 버리면 30초마다 영원히 되돌아온다. 셋 다 화면은 멀쩡해 보인다.
 */
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MOD = path.join(ROOT, 'dist', 'board-queue.js');
const PORT = Number(process.env.QUEUE_PORT ?? 8788);
const BASE = process.env.QUEUE_BASE ?? `http://127.0.0.1:${PORT}`;
const READY_MS = 120_000;

if (!fs.existsSync(MOD)) {
  console.error('dist 가 없습니다 — 먼저 `npm run build`');
  process.exit(1);
}

// **띄운 것은 반드시 내린다.** `process.on('exit')` 는 `process.exit()` 로 나갈
// 때도 도니 어느 길로 끝나든 한 번은 지나간다. 두 번 불러도 안전하다.
let server = null;
function stopServer() {
  if (!server) return;
  const { pid } = server;
  server = null;
  try {
    if (process.platform === 'win32') {
      // 자식 트리째 — wrangler 가 workerd 를 또 띄운다. **PID 로만 부른다**
      // (이미지 이름으로 부르면 사람이 쓰던 것까지 같이 죽는다).
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch { /* 이미 죽었으면 그만 */ }
}
process.on('exit', stopServer);

const alive = () => fetch(`${BASE}/api/pending`).then(() => true, () => false);

if (!(await alive())) {
  const boardDir = (() => {
    try {
      const wa = require(path.join(ROOT, 'dist', 'work-assistant.js'));
      const root = wa.workAssistantRoot();
      if (!root) return null;
      const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf-8'));
      return cfg.board_publish_dir || null;
    } catch { return null; }
  })();
  if (!boardDir || !fs.existsSync(boardDir)) {
    console.error('판을 내주는 곳을 못 찾았습니다 —'
      + ' work-assistant/config.json 의 board_publish_dir 를 확인하세요');
    process.exit(1);
  }
  console.log(`Work Board dev 서버를 띄웁니다 (포트 ${PORT}) — 끝나면 내립니다`);
  server = spawn('npm', ['run', 'dev', '--', '--port', String(PORT)], {
    cwd: boardDir,
    shell: true,
    stdio: 'ignore',
    detached: process.platform !== 'win32',
  });
  server.on('error', () => { server = null; });
  const deadline = Date.now() + READY_MS;
  let ready = false;
  while (Date.now() < deadline) {
    if (await alive()) { ready = true; break; }
    if (!server) break;              // 띄우다 죽었으면 더 기다릴 것이 없다
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!ready) {
    console.error(`서버가 ${READY_MS / 1000}초 안에 안 떴습니다 —`
      + ` ${boardDir} 에서 \`npm run dev\` 가 도는지 보세요`);
    process.exit(1);
  }
}

// **실제 상태 파일을 건드리지 않는다.** 여기서 처리한 id 를 진짜 파일에 적으면
// 다음에 같은 클릭이 조용히 무시된다.
const DONE = path.join(os.tmpdir(), `board-queue-done-${process.pid}.json`);
process.env.BOARD_QUEUE_DONE_FILE = DONE;

const q = require(MOD);

const fails = [];
const eq = (label, got, want) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    fails.push(`${label}\n    받음 ${JSON.stringify(got)}\n    기대 ${JSON.stringify(want)}`);
  }
};

const post = (op, body) => fetch(`${BASE}/api/${op}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-board': '1' },
  body: JSON.stringify(body),
}).then((r) => r.json());
const pending = () => fetch(`${BASE}/api/pending`).then((r) => r.json()).then((j) => j.items);

/**
 * 문자열로 결과를 정한다 — 「ok…」 성공 · 「nq…」 문법 아님 · 「fail…」 일시 실패.
 *
 * **여러 건을 한 줄로 받는다** — 진짜 `quick` 이 「A · B · C」 를 한 번에
 * 처리하고 **한 조각이라도 틀리면 덩어리 전체가 rc 2** 라, 가짜도 조각을
 * 나눠 보고 같은 규칙으로 답해야 한다. 건별로 판정하는 가짜를 두면
 * 묶음 경로가 실제와 다른 답을 받아 검사가 거짓말을 한다.
 */
const applied = [];
const apply = async (text) => {
  applied.push(text);
  const parts = text.split(' · ').map((x) => x.trim()).filter(Boolean);
  if (parts.some((x) => x.startsWith('fail'))) {
    return { kind: 'failed', message: '노션이 안 열립니다' };
  }
  if (parts.some((x) => x.startsWith('nq'))) return { kind: 'not-quick' };
  return { kind: 'ok', output: `✅ ${text}` };
};

/** 사람 말을 받는 쪽. 「askfail…」이면 넘기다 넘어진 것으로 친다. */
const asked = [];
const ask = async (text) => {
  asked.push(text);
  if (text.startsWith('askfail')) throw new Error('비서가 안 받았습니다');
};

async function clear() {
  const items = await pending();
  if (items.length) await post('ack', { ids: items.map((i) => i.id) });
  fs.rmSync(DONE, { force: true });
  applied.length = 0;
  asked.length = 0;
}

// 1. 빈 큐
await clear();
eq('빈 큐면 아무 일도 없다', await q.drain(apply, ask, BASE),
   { applied: [], dropped: [], retry: [], lost: [], duplicates: 0 });
eq('빈 큐면 부르지도 않는다', applied.length, 0);

// 2. 반영하고 지운다
await clear();
await post('act', { text: 'ok TSK-5 완료', label: '백서' });
let r = await q.drain(apply, ask, BASE);
eq('반영한다', [r.applied.length, r.applied[0]?.output], [1, '✅ ok TSK-5 완료']);
eq('반영한 것은 큐에서 사라진다', (await pending()).length, 0);

// 3. 이미 반영한 것을 다시 만나면 — ack 이 못 갔던 경우다. 두 번 쓰지 않는다.
await clear();
const dup = await post('act', { text: 'ok TSK-6 완료' });
fs.writeFileSync(DONE, JSON.stringify([dup.id]), 'utf-8');
r = await q.drain(apply, ask, BASE);
eq('**두 번 반영하지 않는다**', [r.duplicates, r.applied.length, applied.length], [1, 0, 0]);
eq('그래도 큐에서는 지운다', (await pending()).length, 0);

// 4. 문법이 아니면 버린다 — 안 버리면 30초마다 영원히 돌아온다
await clear();
await post('act', { text: 'nq 이건 문법이 아니다', label: '이상한 것' });
r = await q.drain(apply, ask, BASE);
eq('문법이 아니면 버린다', [r.dropped.length, r.applied.length], [1, 0]);
eq('버린 것은 큐에서 사라진다', (await pending()).length, 0);

// 5. 일시 실패는 **남겨 둔다** — 노션이 돌아오면 저절로 반영된다
await clear();
await post('act', { text: 'fail TSK-7 완료' });
r = await q.drain(apply, ask, BASE);
eq('일시 실패는 다시 시도한다', [r.retry.length, r.applied.length, r.dropped.length], [1, 0, 0]);
eq('**일시 실패는 큐에 남는다**', (await pending()).length, 1);

// 6. **여러 건은 한 번에 묶어 보낸다.** 건마다 부르면 건마다 볼트 쓰기·다시
//    그리기·올리기가 돌고, 열려 있는 화면은 **올라온 판 수만큼 다시 읽는다**
//    — 두 건이면 2초 간격으로 두 번 깜빡였다(2026-08-18 실측).
await clear();
await post('act', { text: 'ok TSK-8 완료' });
await post('act', { text: 'ok TSK-10 완료' });
await post('act', { text: 'ok TSK-11 완료' });
r = await q.drain(apply, ask, BASE);
eq('세 건이 한 번에 반영된다', [r.applied.length, r.retry.length], [3, 0]);
eq('**quick 을 한 번만 부른다**', applied.length, 1);
eq('조각을 이어 붙인다', applied[0], 'ok TSK-8 완료 · ok TSK-10 완료 · ok TSK-11 완료');
eq('답은 한 번만 낸다', r.applied.filter((x) => x.output).length, 1);

// 6-b. **묶음이 문법에 안 맞으면 건별로 다시 시도한다.** 묶으면 전부 아니면
//    전무라, 그것만으로 끝내면 성한 것까지 버려진다.
await clear();
await post('act', { text: 'ok TSK-8 완료' });
await post('act', { text: 'nq 문법 밖' });
await post('act', { text: 'ok TSK-10 완료' });
r = await q.drain(apply, ask, BASE);
eq('성한 둘은 살고 틀린 하나만 버린다',
  [r.applied.length, r.dropped.length, r.retry.length], [2, 1, 0]);
eq('묶음 한 번 + 건별 셋 = 네 번', applied.length, 4);
eq('큰 것도 작은 것도 남지 않는다', (await pending()).length, 0);

// 7. **일시 실패는 묶음 통짜로 다시 시도한다.** 진짜 `quick` 은 한 번의 프로세스라
//    그 실패는 덩어리 전체의 실패다 — 쉽다 살아남는 조각이 없다.
await clear();
await post('act', { text: 'ok TSK-8 완료' });
await post('act', { text: 'fail TSK-9 완료' });
r = await q.drain(apply, ask, BASE);
eq('한 조각이 안 되면 둘 다 남는다', [r.applied.length, r.retry.length], [0, 2]);
eq('둘 다 큐에 남는다', (await pending()).length, 2);
r = await q.drain(async () => ({ kind: 'ok', output: '✅ 나중에 됐다' }), ask, BASE);
eq('복구되면 저절로 반영된다', [r.applied.length, (await pending()).length], [2, 0]);

// 8. 사람 말은 짧은 문법 쪽으로 가지 않는다 — 가면 문법이 아니라고 버려진다
await clear();
await post('act', { text: '[진행판] TSK-5 「백서」\n오늘 초안 넘김', kind: 'ask', label: '백서' });
r = await q.drain(apply, ask, BASE);
eq('사람 말은 비서가 받는다', [asked.length, applied.length], [1, 0]);
eq('받은 것은 큐에서 사라진다', (await pending()).length, 0);

// 9. **넘기다 넘어져도 다시 부르지 않는다.** 비서는 노션에 쓰고 슬랙에 답하는
//    부작용이 있어, 되풀이하면 그 일이 두 번 일어난다. 대신 원문을 돌려준다.
await clear();
await post('act', { text: 'askfail 넘기다 넘어질 것', kind: 'ask' });
r = await q.drain(apply, ask, BASE);
eq('실패해도 원문은 돌아온다', [r.lost.length, r.retry.length], [1, 0]);
eq('**다시 부르지 않는다** — 큐에서 지워진다', (await pending()).length, 0);
r = await q.drain(apply, ask, BASE);
eq('다음 판에도 안 돌아온다', [r.lost.length, asked.length], [0, 1]);

// 10. 받을 곳이 없으면 **버리지 않고 남긴다** — 사람 말은 다시 만들 수 없다
await clear();
await post('act', { text: '받을 곳이 없을 때', kind: 'ask' });
r = await q.drain(apply, null, BASE);
eq('받을 곳이 없으면 남긴다', [r.retry.length, r.lost.length, r.dropped.length], [1, 0, 0]);
eq('큐에 그대로 있다', (await pending()).length, 1);

await clear();
fs.rmSync(DONE, { force: true });

// **`process.exit` 대신 `exitCode`** — 여기서 즉시 나가면 뒷정리를 건너뛴다.
if (fails.length) {
  console.log(`실패 ${fails.length}건\n`);
  for (const f of fails) console.log('  ✗ ' + f);
  process.exitCode = 1;
} else {
  console.log('통과 — Work Board 폴러 (빈 큐 · 반영 · 중복 방지 · 문법 아님 버리기 · '
    + '일시 실패 남기기 · 섞인 판 · 복구 후 반영 · 사람 말 넘기기 · 한 번만 시도 · 받을 곳 없음)');
}
stopServer();
