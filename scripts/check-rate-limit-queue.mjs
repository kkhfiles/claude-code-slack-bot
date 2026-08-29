/**
 * 한도 큐 자가 검사 — 슬랙도 네트워크도 타지 않는다.
 *
 *   npm run build && node scripts/check-rate-limit-queue.mjs
 *
 * **여기 케이스는 지어낸 것이 아니라 2026-08-07 검토에서 실제로 잡힌 것들이다.**
 * 회복 시각을 늘 덮어쓰면 아직 안 풀린 채로 깨우고, 취소를 큐에 반영하지 않으면
 * 취소해 놓은 것이 몇 시간 뒤 다시 올라온다. 둘 다 조용히 틀린다.
 */
import './lib/fresh-dist.mjs';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// **운영 큐 파일에 쓰지 않는다.** 예전에는 그 파일을 그대로 썼는데, 밀린 요청이
// 있으면 검사가 스스로 물러섰다 — 지우면 사용자가 보낸 원문이 날아가니 지울 수도
// 없었다. 그 사이 이 검사가 푸시 전 관문에 걸려 **한도에 걸린 동안 무관한 변경까지
// 푸시가 막혔다**(2026-08-24 실측). 임시 자리로 돌려놓으면 둘 다 사라진다.
const FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rlq-')), 'queue.json');
process.env.RATE_LIMIT_QUEUE_FILE = FILE;
const MOD = path.join(ROOT, 'dist', 'rate-limit-queue.js');

if (!fs.existsSync(MOD)) {
  console.error('dist 가 없습니다 — 먼저 `npm run build`');
  process.exit(1);
}

const fails = [];
const eq = (label, got, want) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    fails.push(`${label}\n    받음 ${JSON.stringify(got)}\n    기대 ${JSON.stringify(want)}`);
  }
};

// **검사가 진짜 큐를 안 건드리는지부터 잰다.** 자리를 옮긴 것이 이 검사의 전제라,
// 그 전제가 깨지면 나머지 결과가 사용자 원문을 지우고 나온 것이 된다.
const REAL = path.join(ROOT, '.rate-limit-queue.json');
const realBefore = fs.existsSync(REAL) ? fs.readFileSync(REAL, 'utf-8') : null;

const q = require(MOD);
const now = Math.floor(Date.now() / 1000);

eq('파일이 없으면 빈 큐', q.peek(), { resetsAt: null, items: [] });

const a = q.enqueue({ channel: 'D1', threadTs: '1', user: 'U1', text: '주간보고 초안' }, now + 600);
eq('첫 건은 first', [a.first, a.size], [true, 1]);

const b = q.enqueue({ channel: 'D1', threadTs: '2', user: 'U1', text: '그거 말고 회의 메모로' }, now + 300);
eq('두 번째부터는 조용히', [b.first, b.size], [false, 2]);
eq('회복 시각은 늦은 쪽으로만 민다', b.resetsAt, now + 600);

const c = q.enqueue({ channel: 'D1', threadTs: '3', user: 'U1', text: 'TSK-5 완료' }, now + 900);
eq('더 늦은 값이 오면 갱신', c.resetsAt, now + 900);

eq('순서가 보존된다', q.peek().items.map((x) => x.text),
   ['주간보고 초안', '그거 말고 회의 메모로', 'TSK-5 완료']);

// 재시작 흉내 — 파일에서 그대로 읽힌다
delete require.cache[require.resolve(MOD)];
const q2 = require(MOD);
eq('재시작해도 남는다', q2.peek().items.length, 3);

eq('꺼내면 다 나온다', q2.takeAll().length, 3);
eq('꺼내면 비워진다', q2.peek(), { resetsAt: null, items: [] });

// 「취소」는 그 한 건만 뺀다 — 안 빼면 취소해 놓고도 회복 시각에 다시 올라온다
const x = q2.enqueue({ channel: 'D1', threadTs: '4', user: 'U1', text: '취소할 것' }, now + 60);
q2.enqueue({ channel: 'D1', threadTs: '5', user: 'U1', text: '남을 것' }, now + 60);
q2.remove(x.id);
eq('취소한 건만 빠진다', q2.peek().items.map((i) => i.text), ['남을 것']);
eq('남은 게 있으면 회복 시각도 남는다', q2.peek().resetsAt, now + 60);
q2.remove(q2.peek().items[0].id);
eq('마지막 건을 빼면 회복 시각도 지운다', q2.peek().resetsAt, null);

q2.enqueue({ channel: 'D1', threadTs: '6', user: 'U1', text: '또' }, now + 60);
q2.clear();
eq('버리면 비워진다', q2.peek().items.length, 0);


// --- 다시 알린 자취는 재시작을 넘겨야 한다 -----------------------------------------
// 메모리에만 뒀더니 재시작마다 0 으로 돌아가, 저녁에 네 번 재시작하는 사이 같은 알림이
// **넉 장 그대로 쌓였다**(앞 것을 지울 대상을 몰라서). 횟수도 매번 초기화돼 「얼마나
// 기다렸는지」가 한 번도 안 붙고 상한도 안 걸렸다. 2026-08-25 실측.
q2.enqueue({ channel: 'D9', threadTs: '9', user: 'U1', text: '밀린 것' }, now + 60);
q2.setNotice({ channel: 'D9', ts: '111.1', count: 2 });
eq('자취가 남는다', q2.getNotice(), { channel: 'D9', ts: '111.1', count: 2 });

delete require.cache[require.resolve(MOD)];
const q3 = require(MOD);
eq('재시작해도 자취가 남는다', q3.getNotice(), { channel: 'D9', ts: '111.1', count: 2 });

// **사람이 처리하면 자취도 같이 사라져야 한다.** 안 지우면 다음 건에서 없는 글을
// 지우려 들고, 횟수를 물려받아 한 번도 다시 안 알린다.
q3.takeAll();
eq('꺼내면 자취도 사라진다', q3.getNotice(), undefined);

q3.enqueue({ channel: 'D9', threadTs: '9', user: 'U1', text: '또' }, now + 60);
q3.setNotice({ channel: 'D9', ts: '222.2', count: 1 });
q3.clear();
eq('버리면 자취도 사라진다', q3.getNotice(), undefined);

// 밀린 것이 없는데 자취만 남기지 않는다 — 지울 글도 셀 횟수도 없다.
q3.setNotice({ channel: 'D9', ts: '333.3', count: 1 });
eq('빈 큐에는 자취를 안 남긴다', q3.getNotice(), undefined);


// --- 다시 알릴지 정하는 규칙 -------------------------------------------------------
// 한 번 알리고 마는 구조라 자리를 비운 사이 그대로 묻혔다 — 2026-08-24 에 20:10 에
// 한 번 알리고 **22시간을 기다렸다.** 되풀이는 세 가지로 조용히 틀린다:
// 밤사이에 상한이 닳아 아침에 한 번도 안 알리거나, 처리한 뒤에도 두드리거나,
// 끝없이 두드려 사람이 알림 자체를 안 보게 되거나.
const { nudgeDecision } = require(path.join(ROOT, 'dist', 'rlq-nudge.js'));
const NB = { fromHour: 8, toHour: 20, max: 5 };
const dec = (o) => nudgeDecision({ ...NB, ...o });

eq('밀린 것이 없으면 그만둔다', dec({ pending: 0, hour: 10, nudges: 0 }), 'stop');
eq('깨어 있는 시간이면 알린다', dec({ pending: 1, hour: 10, nudges: 0 }), 'post');
eq('시작 시각이 되면 알린다', dec({ pending: 1, hour: 8, nudges: 0 }), 'post');
// **밤에는 세지 않는다.** 여기서 횟수를 쓰면 밤사이에 상한이 다 닳아 아침에 한 번도
// 안 알린다 — 다시 알리기를 넣은 이유 자체가 사라진다.
eq('자는 시간에는 미룬다', dec({ pending: 1, hour: 3, nudges: 0 }), 'wait');
eq('끝 시각부터는 미룬다', dec({ pending: 1, hour: 20, nudges: 0 }), 'wait');
eq('밤에는 횟수를 다 썼어도 미루기다 (그만두기가 아니다)',
   dec({ pending: 1, hour: 3, nudges: 99 }), 'wait');
eq('상한 직전까지는 알린다', dec({ pending: 1, hour: 10, nudges: 4 }), 'post');
eq('상한에 닿으면 그만둔다', dec({ pending: 1, hour: 10, nudges: 5 }), 'stop');
// 밀린 것이 없는 쪽이 먼저다 — 사람이 처리했으면 시각과 무관하게 끝이다.
eq('처리했으면 자는 시간에도 그만둔다', dec({ pending: 0, hour: 3, nudges: 0 }), 'stop');

fs.rmSync(FILE, { force: true });

// **진짜 큐가 그대로인가.** 여기가 틀리면 위의 통과는 사용자 원문을 지우고 얻은 것이다.
const realAfter = fs.existsSync(REAL) ? fs.readFileSync(REAL, 'utf-8') : null;
eq('진짜 큐 파일은 건드리지 않는다', realAfter, realBefore);

if (fails.length) {
  console.log(`실패 ${fails.length}건\n`);
  for (const f of fails) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log('통과 — 한도 큐 (쌓기 · 회복 시각 · 순서 · 재시작 · 꺼내기 · 취소 · 버리기 · 다시 알리기)');
