/**
 * 반응 줄 세우기 자가 검사 — 슬랙을 타지 않는다.
 *
 *   npm run build
 *   npm run check:reactions
 *
 * **왜 있나** (2026-08-31). 반응 하나가 슬랙 왕복 한두 번인데 그 결과를 읽는 곳이
 * 없다. 그런데 차례의 앞뒤 양쪽에서 기다리고 있었다 — 띄우기 전 0.52초, 차례 끝
 * 2.16초 중 대부분. 그래서 **순서는 그대로 두고 기다리는 것만** 걷어냈다.
 *
 * ⚠️ **그냥 안 기다리면 조용히 깨진다.** 반응을 바꾸는 함수가 `activeReactions` 를
 * await 뒤에 고치므로, 두 호출이 겹치면 서로의 중간 상태를 보고 충돌 반응을 안
 * 지우거나 같은 것을 두 번 단다. 화면에는 그냥 이상한 이모지가 남을 뿐이라
 * **아무도 버그로 안 읽는다** — 그래서 순서를 기계가 센다.
 *
 * 생성자가 무거워 `Object.create` 로 껍데기를 만들고 반응이 쓰는 칸만 채운다.
 * 도는 것은 `dist` 의 진짜 메서드다. 이모지 표는 이 검사의 대상이 아니라
 * 재료라서 최소한만 둔다 — 여기서 보는 것은 **순서와 대기** 둘뿐이다.
 */
import './lib/fresh-dist.mjs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { SlackHandler } = require(path.join(ROOT, 'dist', 'slack-handler.js'));

const KEY = 'C1:1700000000.000100';
const ANCHOR = 'hourglass_flowing_sand';

let failed = 0;
function ok(name, cond, detail = '') {
  if (cond) {
    console.log(`  OK   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** 반응만 쓰는 껍데기. `calls` 에 부른 순서가 쌓이고, `gate` 로 응답을 붙든다. */
function makeHandler({ delayFor = () => 0 } = {}) {
  const calls = [];
  const api = (kind) => async (arg) => {
    calls.push(`${kind}:${arg.name}`);
    const ms = delayFor(arg.name);
    if (ms) await new Promise((r) => setTimeout(r, ms));
  };
  const h = Object.create(SlackHandler.prototype);
  h.app = { client: { reactions: { add: api('add'), remove: api('remove') } } };
  h.logger = { warn() {}, info() {}, error() {}, debug() {} };
  h.originalMessages = new Map([[KEY, { channel: 'C1', ts: '1700000000.000100' }]]);
  h.currentReactions = new Map();
  h.reactionChain = new Map();
  h.ANCHOR_REACTION = ANCHOR;
  h.emojiToReaction = { '🔍': 'mag', '✅': 'white_check_mark', '🤔': 'thinking_face' };
  h.conflictingReactionGroups = [
    ['white_check_mark', 'x'],
    ['thinking_face', 'mag'],
  ];
  return { h, calls };
}

/** 줄이 다 빠질 때까지 기다린다 — 검사만 쓰는 길이다. */
async function drain(h) {
  for (let i = 0; i < 50; i += 1) {
    await (h.reactionChain.get(KEY) ?? Promise.resolve());
    await new Promise((r) => setImmediate(r));
  }
}

/** 안 풀리면 실패로 떨어뜨린다 — 옛 코드로 되돌리면 여기서 영원히 매달린다. */
function withDeadline(p, ms, what) {
  return Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} — ${ms}ms 안에 안 풀림`)), ms)),
  ]);
}

async function main() {
  console.log('반응 줄 세우기');

  // ① **부르는 쪽이 슬랙을 안 기다린다.** 이것이 이 변경의 전부다.
  //    옛 코드는 응답이 올 때까지 붙들었으므로 여기서 시한에 걸려 죽는다.
  {
    const { h } = makeHandler({ delayFor: () => 5_000 });
    const t0 = Date.now();
    await withDeadline(h.updateMessageReaction(KEY, '🤔'), 1_000, '반응 대기');
    ok('슬랙 응답을 기다리지 않는다', Date.now() - t0 < 500, `${Date.now() - t0}ms`);
  }

  // ② **순서는 그대로다.** 앞의 것이 느려도 뒤의 것이 앞지르지 않는다 —
  //    앞지르면 「생각 중」이 「완료」 뒤에 붙어 끝난 차례가 도는 것처럼 보인다.
  {
    const { h, calls } = makeHandler({ delayFor: (n) => (n === 'mag' ? 80 : 0) });
    await h.updateMessageReaction(KEY, '🔍');
    await h.updateMessageReaction(KEY, '✅');
    await drain(h);
    const added = calls.filter((c) => c.startsWith('add:'));
    ok('느린 것이 먼저여도 순서가 안 바뀐다',
      added[0] === 'add:mag' && added[1] === 'add:white_check_mark',
      added.join(' → '));
  }

  // ③ **충돌 반응을 지우고 단다.** 겹쳐 돌면 이 짝이 어긋나 이모지 둘이 남는다.
  {
    const { h, calls } = makeHandler({ delayFor: (n) => (n === 'mag' ? 40 : 0) });
    await h.updateMessageReaction(KEY, '🔍');
    await h.updateMessageReaction(KEY, '✅');
    await drain(h);
    ok('앞 반응을 지운 뒤에 새 것을 단다',
      calls.includes('remove:mag') && calls.indexOf('remove:mag') < calls.indexOf('add:white_check_mark'),
      calls.join(' → '));
    ok('마지막에 남는 것은 하나뿐',
      [...(h.currentReactions.get(KEY) ?? [])].join(',') === 'white_check_mark',
      [...(h.currentReactions.get(KEY) ?? [])].join(','));
  }

  // ④ **앵커가 먼저 붙는다.** 뒤에 붙으면 진행 반응이 바뀔 때마다 줄이 튄다 —
  //    원래 코드가 앵커를 먼저 부른 이유가 그것이다.
  {
    const { h, calls } = makeHandler({ delayFor: (n) => (n === ANCHOR ? 60 : 0) });
    await h.addAnchorReaction(KEY);
    await h.updateMessageReaction(KEY, '🤔');
    await drain(h);
    ok('앵커가 진행 반응보다 먼저', calls[0] === `add:${ANCHOR}`, calls.join(' → '));
  }

  // ⑤ **하나가 터져도 다음이 돈다.** 줄을 이을 때 실패를 안 삼키면 그 세션의
  //    반응이 **그때부터 통째로 조용히 죽는다** — 에러도 안 남는다.
  {
    const { h, calls } = makeHandler();
    h.queueReaction(KEY, async () => { throw new Error('일부러'); });
    await h.updateMessageReaction(KEY, '✅');
    await drain(h);
    ok('앞의 것이 터져도 뒤의 것이 돈다', calls.includes('add:white_check_mark'), calls.join(' → '));
  }

  // ⑥ **세션마다 줄이 따로 선다.** 한 줄로 묶으면 남의 느린 반응이 내 차례를 민다.
  {
    const { h, calls } = makeHandler({ delayFor: (n) => (n === 'mag' ? 60 : 0) });
    const OTHER = 'C1:1700000000.000200';
    h.originalMessages.set(OTHER, { channel: 'C1', ts: '1700000000.000200' });
    await h.updateMessageReaction(KEY, '🔍');
    await h.updateMessageReaction(OTHER, '✅');
    await new Promise((r) => setTimeout(r, 20));
    ok('다른 세션은 안 기다린다', calls.includes('add:white_check_mark'), calls.join(' → '));
    await drain(h);
  }

  console.log(failed ? `\n${failed}건 실패` : '\n전부 통과');
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => {
  console.error(e?.message ?? e);
  process.exitCode = 1;
});
