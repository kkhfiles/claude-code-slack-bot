/**
 * 판 큐 폴러가 워커 무료 한도를 얼마나 쓰나 — **세어서 천장 아래인지 본다.**
 *
 *   npm run check:budget
 *
 * 2026-08-29 에 큐 확인을 5초 → 2초로 내렸다. 하루 17,280 → 43,200회다.
 * 이틀 뒤 Cloudflare 가 **하루 한도 100,000회의 76%**를 알렸다 — 아무도 판을
 * 안 눌러도 이 폴러 하나가 43%를 쓰고 있었다. 한도에 닿으면 워커가 실패하고
 * **판이 죽는다.**
 *
 * ⚠️ **주기를 눈으로 읽어 곱하지 않는다.** 밤에 건너뛰는 규칙이 붙으면서
 * 「주기 하나 × 86,400초」가 더는 답이 아니다. 그래서 **하루를 실제로 돌려 센다** —
 * 규칙을 어떻게 고치든 이 검사는 그 결과를 그대로 본다.
 */
import './lib/fresh-dist.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src', 'assistant-scheduler.ts');

/**
 * 천장. 한도의 절반에 **여유를 두고** 잡는다 — 지문 확인·판 열기·발행이 같은
 * 한도를 쓰고, 그쪽은 사람이 얼마나 보느냐에 달려 여기서 못 센다.
 */
const CEILING = 35_000;
/** 타이머가 실제로 도는 간격. 건너뛰기는 이 위에 얹힌다. */
const TICK_MS = 2_000;

const { boardQueueGapMs, boardQueueDailyCalls } =
  await import(pathToFileURL(path.join(ROOT, 'dist', 'assistant-scheduler.js')).href);

const fails = [];
const eq = (what, got, want) => {
  if (got !== want) fails.push(`${what} — ${JSON.stringify(got)} (기대 ${JSON.stringify(want)})`);
};

// ① 시각마다 얼마나 벌리나. **경계를 양쪽에서 짚는다** — 07 시가 낮이고 06 시가
//    밤이며, 22 시가 낮이고 23 시가 밤이다. 한쪽만 보면 부등호가 뒤집혀도 통과한다.
const at = (h) => boardQueueGapMs(new Date(2026, 8, 1, h, 30, 0));
for (const h of [7, 8, 12, 18, 22]) eq(`${h}시는 낮 주기`, at(h), 2_000);
for (const h of [23, 0, 3, 6]) eq(`${h}시는 밤 주기`, at(h), 30_000);

// ② 하루를 실제로 돌려 센다. 타이머는 2초마다 깨고, 지난 시간이 그때의 주기보다
//    짧으면 건너뛴다 — 운영 코드와 같은 규칙이다.
let polls = 0;
let last = 0;
const day0 = new Date(2026, 8, 1, 0, 0, 0).getTime();
for (let t = day0; t < day0 + 86_400_000; t += TICK_MS) {
  if (t - last < boardQueueGapMs(new Date(t))) continue;
  last = t;
  polls += 1;
}

if (polls > CEILING) {
  fails.push(`하루 ${polls.toLocaleString()}회 — 천장 ${CEILING.toLocaleString()} 을 넘는다`);
}
// 세어 본 값과 코드가 스스로 말하는 값이 어긋나면, 로그에 찍히는 숫자가 거짓이다.
const claimed = boardQueueDailyCalls();
if (Math.abs(claimed - polls) > polls * 0.02) {
  fails.push(`boardQueueDailyCalls() 가 ${claimed} 이라는데 실제로 세면 ${polls} 이다`);
}

// ③ 폴러가 그 문을 실제로 쓰는가. **함수 몸통 안에서만 찾는다** — 파일 어딘가에
//    이름이 있는 것과 그 자리에서 불리는 것은 다르다(2026-09-01 에 이 실수를
//    변이 시험이 잡았다).
const src = fs.readFileSync(SRC, 'utf-8');
const head = src.indexOf('private startBoardQueuePoller');
const body = head < 0 ? '' : src.slice(head, src.indexOf('\n  }', head));
if (!body) {
  fails.push('startBoardQueuePoller() 를 못 찾았다');
} else {
  if (!body.includes('boardQueueGapMs()')) {
    fails.push('폴러가 boardQueueGapMs() 를 안 본다 — 밤에도 2초마다 돈다');
  }
  if (!/this\.boardQueueLast\s*=\s*now/.test(body)) {
    fails.push('폴러가 boardQueueLast 를 안 적는다 — 건너뛰기가 영영 안 걸린다');
  }
}

if (fails.length) {
  console.error('큐 예산이 안 맞는다\n' + fails.map((f) => `  ✗ ${f}`).join('\n'));
  process.exitCode = 1;
} else {
  const was = Math.round(86_400_000 / TICK_MS);
  console.log(`통과 — 하루 ${polls.toLocaleString()}회 (밤을 안 벌리면 `
    + `${was.toLocaleString()}회 · 천장 ${CEILING.toLocaleString()})`
    + ` · 시각별 주기 9개 · 폴러 배선 2개`);
}
