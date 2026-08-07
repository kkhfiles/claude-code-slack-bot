/**
 * 진행판 폴러 자가 검사 — 슬랙도 노션도 타지 않는다.
 *
 *   터미널 A:  cd P:/github/artifact-host  &&  npm run dev
 *   터미널 B:  npm run build
 *              npm run check:board
 *
 * **여기 케이스는 설계에서 갈렸던 자리들이다.** 두 번 반영하면 진행 로그가 두 줄이
 * 되고, 일시 실패한 것을 지워 버리면 누른 것이 조용히 사라지며, 문법이 아닌 것을
 * 안 버리면 30초마다 영원히 되돌아온다. 셋 다 화면은 멀쩡해 보인다.
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MOD = path.join(ROOT, 'dist', 'board-queue.js');
const BASE = process.env.QUEUE_BASE ?? 'http://127.0.0.1:8787';

if (!fs.existsSync(MOD)) {
  console.error('dist 가 없습니다 — 먼저 `npm run build`');
  process.exit(1);
}
try {
  await fetch(`${BASE}/api/pending`);
} catch {
  console.error(`진행판 dev 서버가 없습니다 (${BASE}) — artifact-host 에서 \`npm run dev\``);
  process.exit(1);
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

/** 문자열로 결과를 정한다 — 「ok…」 성공 · 「nq…」 문법 아님 · 「fail…」 일시 실패. */
const applied = [];
const apply = async (text) => {
  applied.push(text);
  if (text.startsWith('nq')) return { kind: 'not-quick' };
  if (text.startsWith('fail')) return { kind: 'failed', message: '노션이 안 열립니다' };
  return { kind: 'ok', output: `✅ ${text}` };
};

async function clear() {
  const items = await pending();
  if (items.length) await post('ack', { ids: items.map((i) => i.id) });
  fs.rmSync(DONE, { force: true });
  applied.length = 0;
}

// 1. 빈 큐
await clear();
eq('빈 큐면 아무 일도 없다', await q.drain(apply, BASE),
   { applied: [], dropped: [], retry: [], duplicates: 0 });
eq('빈 큐면 부르지도 않는다', applied.length, 0);

// 2. 반영하고 지운다
await clear();
await post('act', { text: 'ok TSK-5 완료', label: '백서' });
let r = await q.drain(apply, BASE);
eq('반영한다', [r.applied.length, r.applied[0]?.output], [1, '✅ ok TSK-5 완료']);
eq('반영한 것은 큐에서 사라진다', (await pending()).length, 0);

// 3. 이미 반영한 것을 다시 만나면 — ack 이 못 갔던 경우다. 두 번 쓰지 않는다.
await clear();
const dup = await post('act', { text: 'ok TSK-6 완료' });
fs.writeFileSync(DONE, JSON.stringify([dup.id]), 'utf-8');
r = await q.drain(apply, BASE);
eq('**두 번 반영하지 않는다**', [r.duplicates, r.applied.length, applied.length], [1, 0, 0]);
eq('그래도 큐에서는 지운다', (await pending()).length, 0);

// 4. 문법이 아니면 버린다 — 안 버리면 30초마다 영원히 돌아온다
await clear();
await post('act', { text: 'nq 이건 문법이 아니다', label: '이상한 것' });
r = await q.drain(apply, BASE);
eq('문법이 아니면 버린다', [r.dropped.length, r.applied.length], [1, 0]);
eq('버린 것은 큐에서 사라진다', (await pending()).length, 0);

// 5. 일시 실패는 **남겨 둔다** — 노션이 돌아오면 저절로 반영된다
await clear();
await post('act', { text: 'fail TSK-7 완료' });
r = await q.drain(apply, BASE);
eq('일시 실패는 다시 시도한다', [r.retry.length, r.applied.length, r.dropped.length], [1, 0, 0]);
eq('**일시 실패는 큐에 남는다**', (await pending()).length, 1);

// 6. 섞여 들어와도 성공한 것만 지운다
await clear();
await post('act', { text: 'ok TSK-8 완료' });
await post('act', { text: 'fail TSK-9 완료' });
await post('act', { text: 'ok TSK-10 완료' });
r = await q.drain(apply, BASE);
eq('성공 둘 · 남길 것 하나', [r.applied.length, r.retry.length], [2, 1]);
eq('남은 것은 실패한 그것뿐', (await pending()).map((i) => i.text), ['fail TSK-9 완료']);

// 7. 남은 것이 다음 판에 성공하면 그때 지운다
r = await q.drain(async () => ({ kind: 'ok', output: '✅ 나중에 됐다' }), BASE);
eq('복구되면 저절로 반영된다', [r.applied.length, (await pending()).length], [1, 0]);

await clear();
fs.rmSync(DONE, { force: true });

if (fails.length) {
  console.log(`실패 ${fails.length}건\n`);
  for (const f of fails) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log('통과 — 진행판 폴러 (빈 큐 · 반영 · 중복 방지 · 문법 아님 버리기 · '
  + '일시 실패 남기기 · 섞인 판 · 복구 후 반영)');
