/**
 * 반복 타이머 공통 장치(`src/recurring.ts`) — 직접 건 타이머와 결과가 같은가 · 기록이 맞는가.
 *
 *   npm run build
 *   npm run check:recurring
 *
 * **타이머를 실제로 안 기다린다** — `setInterval` · `setTimeout` 을 가짜로 바꿔 끼워 콜백을 손으로 부른다.
 * 장치가 타이머 함수를 부르는 순간에 찾는지도 이 바꿔 끼우기로 함께 본다(다른 검사들이 같은 방식으로 바꿔 낀다).
 *
 * 여기서 지키려는 것(1부 「옮기기」 — 동작 그대로):
 *   ① 같은 ms 로 거는 순간에 걸고, 울리면 같은 순간에 `run` 을 부른다 · `unref` 는 준 곳만
 *   ② 동기 오류는 같은 오류로 밖에 나온다 · 비동기 거부는 처리 안 된 거부 하나로 남는다(직접 건 것과 같은 수)
 *   ③ 앞 회차가 돌아도 다음 회차가 돈다(겹친 수만 셈) · 같은 이름을 두 번 걸면 둘 다 산다
 *   ④ `{ ok: false }` 는 실패로 세고, 성공하면 연속 실패가 0 으로 돌아간다
 *   ⑤ 상태 파일 — 켜지 않으면 안 씀 · 30초에 한 번까지 · 오류 문구는 안 담음 · 못 써도 안 던짐
 */
import './lib/fresh-dist.mjs';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const R = require(path.join(ROOT, 'dist', 'recurring.js'));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'recurring-check-'));

const fails = [];
const eq = (label, got, want) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    fails.push(`${label}\n    받음 ${JSON.stringify(got)}\n    기대 ${JSON.stringify(want)}`);
  }
};
const ok = (label, cond) => { if (!cond) fails.push(label); };

// ── 가짜 타이머 — 건 것과 지운 것을 적고, 콜백은 손으로 부른다 ─────────────────
const real = {
  setInterval: globalThis.setInterval, setTimeout: globalThis.setTimeout,
  clearInterval: globalThis.clearInterval, clearTimeout: globalThis.clearTimeout, now: Date.now,
};
let armedList = [];
let clearedList = [];
const fake = (kind) => (fn, ms) => {
  const h = { kind, fn, ms, unrefd: false, unref() { h.unrefd = true; return h; } };
  armedList.push(h);
  return h;
};
let NOW = Date.parse('2026-11-04T07:10:00+09:00');
const install = () => {
  globalThis.setInterval = fake('interval');
  globalThis.setTimeout = fake('timeout');
  globalThis.clearInterval = (h) => clearedList.push(h);
  globalThis.clearTimeout = (h) => clearedList.push(h);
  Date.now = () => NOW;
};
const restore = () => {
  globalThis.setInterval = real.setInterval;
  globalThis.setTimeout = real.setTimeout;
  globalThis.clearInterval = real.clearInterval;
  globalThis.clearTimeout = real.clearTimeout;
  Date.now = real.now;
};
const reset = () => { R.resetForTest(); armedList = []; clearedList = []; };

const rejections = [];
process.on('unhandledRejection', (reason) => rejections.push(reason));
const settle = () => new Promise((r) => real.setTimeout(r, 20));

try {
  install();

  // ① 거는 순간 · 같은 ms · 울리면 바로 run · unref 는 준 곳만
  {
    reset();
    let calls = 0;
    const t = R.every({ name: 'a', everyMs: 3_600_000, run: () => { calls += 1; } });
    eq('① every 는 거는 순간 setInterval 하나', armedList.map((h) => [h.kind, h.ms]), [['interval', 3_600_000]]);
    eq('① unref 를 안 주면 unref 안 함', armedList[0].unrefd, false);
    armedList[0].fn();
    eq('① 울리면 같은 순간에 run', calls, 1);
    R.every({ name: 'b', everyMs: 60_000, run: () => {}, unref: true });
    eq('① unref: true 면 unref 함', armedList[1].unrefd, true);
    t.stop('reload');
    eq('① stop 은 그 핸들을 clearInterval', clearedList, [armedList[0]]);
    t.stop('reload');
    eq('① 두 번 stop 해도 한 번만 지움', clearedList.length, 1);
    eq('① 멈춘 까닭이 남음', [R.snapshot().a.live, R.snapshot().a.stopReason], [0, 'reload']);

    reset();
    let fired = 0;
    const o = R.once({ name: 'c', ms: -5, run: () => { fired += 1; } });
    eq('① once 는 받은 ms 를 그대로(음수도) setTimeout 에', armedList.map((h) => [h.kind, h.ms]), [['timeout', -5]]);
    eq('① once 예정 시각 = 지금(음수는 지금으로)', R.snapshot().c.dueAt, new Date(NOW).toISOString());
    armedList[0].fn();
    eq('① once 가 울리면 run 하고 살아 있는 수 0', [fired, R.snapshot().c.live], [1, 0]);
    o.stop('reload');
    eq('① 이미 울린 once 의 stop 은 아무것도 안 지움', clearedList.length, 0);
    eq('① 울린 once 는 멈춤으로 안 적힘', R.snapshot().c.stopReason, undefined);
  }

  // ② 오류 결과가 직접 건 것과 같다
  {
    reset();
    const boom = Object.assign(new Error('비밀 문구 — 파일에 나가면 안 됨'), { code: 'ECONNRESET' });
    R.every({ name: 'sync', everyMs: 1000, run: () => { throw boom; } });
    let caught = null;
    try { armedList[0].fn(); } catch (e) { caught = e; }
    ok('② 동기 오류가 같은 오류 객체로 밖에 나옴', caught === boom);
    eq('② 동기 오류 기록', [R.snapshot().sync.fails, R.snapshot().sync.lastCode, R.snapshot().sync.lastOk], [1, 'ECONNRESET', false]);

    rejections.length = 0;
    const why = new TypeError('거부');
    void Promise.reject(why);   // 대조 — 직접 건 타이머 콜백이 거부를 흘리는 모양
    await settle();
    const direct = rejections.length;
    rejections.length = 0;
    R.every({ name: 'async', everyMs: 1000, run: () => Promise.reject(why) });
    armedList.at(-1).fn();
    await settle();
    eq('② 비동기 거부 — 처리 안 된 거부 수가 직접 건 것과 같음', rejections.length, direct);
    ok('② 비동기 거부 — 같은 거부 이유', rejections[0] === why);
    eq('② 비동기 거부 기록(code 없으면 name)', [R.snapshot().async.fails, R.snapshot().async.lastCode], [1, 'TypeError']);

    // 회차마다 같은 Promise 를 돌려주는 곳(처리 제안의 pumping) — 거부가 회차 수만큼 늘면 안 된다
    rejections.length = 0;
    const sharedDirect = Promise.reject(new Error('공유'));
    void sharedDirect; void sharedDirect;   // 대조 — 직접 건 콜백 두 회차가 같은 Promise 를 흘림
    await settle();
    const directShared = rejections.length;
    rejections.length = 0;
    const shared = Promise.reject(new Error('공유'));
    R.every({ name: 'shared', everyMs: 1000, run: () => shared });
    armedList.at(-1).fn();
    armedList.at(-1).fn();
    await settle();
    eq('② 같은 Promise 를 두 회차가 돌려줘도 처리 안 된 거부 수가 직접 건 것과 같음', rejections.length, directShared);
    eq('② 같은 Promise 두 회차 모두 실패로 셈', R.snapshot().shared.fails, 2);
  }

  // NaN 대기 — setTimeout 은 받으므로 기록이 그 앞에서 던지면 안 된다
  {
    reset();
    let threw = false;
    try { R.once({ name: 'nan', ms: Number.NaN, run: () => {} }); } catch { threw = true; }
    eq('① NaN 대기도 던지지 않고 setTimeout 에 그대로', [threw, armedList.length, Number.isNaN(armedList[0]?.ms)], [false, 1, true]);
  }

  // ③ 겹쳐도 돈다 · 같은 이름 둘
  {
    reset();
    let release;
    let calls = 0;
    R.every({ name: 'slow', everyMs: 1000, run: () => { calls += 1; return new Promise((r) => { release = r; }); } });
    armedList[0].fn();
    armedList[0].fn();
    eq('③ 앞 회차가 돌아도 다음 회차 run 이 불림', calls, 2);
    eq('③ 겹친 수와 도는 수', [R.snapshot().slow.overlaps, R.snapshot().slow.running], [1, 2]);
    ok('③ 도는 중이면 시작 시각이 있음', !!R.snapshot().slow.runningSince);
    release();
    await settle();

    reset();
    const t1 = R.every({ name: 'dup', everyMs: 1000, run: () => {} });
    const t2 = R.every({ name: 'dup', everyMs: 1000, run: () => {} });
    eq('③ 같은 이름을 두 번 걸면 둘 다 걸림', [armedList.length, R.snapshot().dup.live], [2, 2]);
    t1.stop('reload');
    eq('③ 하나만 멈추면 멈춤으로 안 적힘', [R.snapshot().dup.live, R.snapshot().dup.stopReason], [1, undefined]);
    t2.stop('stop');
    eq('③ 둘 다 멈추면 그때 적힘', [R.snapshot().dup.live, R.snapshot().dup.stopReason], [0, 'stop']);
  }

  // ④ { ok: false } · 결과 이름 · 성공하면 연속 실패 0
  {
    reset();
    const out = [{ ok: false, code: 'mail' }, { ok: false, code: '이상한 글자 abc' }, 'done-today', undefined];
    let i = 0;
    R.every({ name: 'm', everyMs: 1000, run: () => out[i++] });
    armedList[0].fn();
    eq('④ { ok: false, code } 는 실패', [R.snapshot().m.fails, R.snapshot().m.lastCode], [1, 'mail']);
    armedList[0].fn();
    eq('④ 정해진 글자가 아닌 code 는 other', [R.snapshot().m.fails, R.snapshot().m.lastCode], [2, 'other']);
    armedList[0].fn();
    eq('④ 성공하면 연속 실패 0, 결과 이름 남김', [R.snapshot().m.fails, R.snapshot().m.lastOk, R.snapshot().m.lastOutcome], [0, true, 'done-today']);
    armedList[0].fn();
    eq('④ 회차 수', R.snapshot().m.runs, 4);

    reset();
    let resolveIt;
    R.every({ name: 'p', everyMs: 1000, run: () => new Promise((r) => { resolveIt = r; }) });
    armedList[0].fn();
    NOW += 2500;
    resolveIt({ ok: false });
    await settle();
    eq('④ 비동기 { ok: false } 도 실패 · 걸린 시간', [R.snapshot().p.fails, R.snapshot().p.lastCode, R.snapshot().p.lastMs, R.snapshot().p.maxMs], [1, 'failed', 2500, 2500]);
  }

  // ⑤ 상태 파일
  {
    reset();
    const file = path.join(TMP, 'state', 'bot-timers.json');
    R.every({ name: 'off', everyMs: 1000, run: () => {} });
    armedList[0].fn();
    ok('⑤ setStatusFile 을 안 부르면 안 씀', !fs.existsSync(file));

    R.setStatusFile(file);
    ok('⑤ 켜면 바로 씀', fs.existsSync(file));
    const first = JSON.parse(fs.readFileSync(file, 'utf-8'));
    eq('⑤ 파일 머리', [first.pid, typeof first.bootAt, first.writtenAt], [process.pid, 'string', new Date(NOW).toISOString()]);
    ok('⑤ 타이머 기록이 들어감', first.tasks.off && first.tasks.off.everyMs === 1000);

    const boom = Object.assign(new Error('비밀 문구 — 파일에 나가면 안 됨'), { code: 'EACCES' });
    R.every({ name: 'secret', everyMs: 1000, run: () => { throw boom; } });
    NOW += 10_000;
    try { armedList.at(-1).fn(); } catch { /* 같은 오류가 나오는 것은 ② 에서 봄 */ }
    eq('⑤ 30초 안에는 다시 안 씀', JSON.parse(fs.readFileSync(file, 'utf-8')).writtenAt, first.writtenAt);
    NOW += 21_000;
    armedList[0].fn();
    const second = fs.readFileSync(file, 'utf-8');
    eq('⑤ 30초가 지나면 다시 씀', JSON.parse(second).writtenAt, new Date(NOW).toISOString());
    ok('⑤ 오류 문구가 파일에 없음', !second.includes('비밀 문구'));
    eq('⑤ 오류 종류는 남음', JSON.parse(second).tasks.secret.lastCode, 'EACCES');
    ok('⑤ 임시 파일이 안 남음', !fs.readdirSync(path.dirname(file)).some((n) => n.endsWith('.tmp')));

    // 쓸 수 없는 곳(폴더 자리) — 던지지 않고 타이머는 그대로 돈다
    const dirAsFile = path.join(TMP, 'is-a-dir');
    fs.mkdirSync(dirAsFile);
    R.setStatusFile(dirAsFile);
    let calls = 0;
    NOW += 31_000;
    R.every({ name: 'after', everyMs: 1000, run: () => { calls += 1; } });
    let threw = false;
    try { armedList.at(-1).fn(); } catch { threw = true; }
    eq('⑤ 못 써도 던지지 않고 run 은 돎', [threw, calls], [false, 1]);
    ok('⑤ 못 썼을 때도 임시 파일이 안 남음', !fs.readdirSync(TMP).some((n) => n.endsWith('.tmp')));
    R.setStatusFile(null);
  }
} finally {
  restore();
  R.resetForTest();
  fs.rmSync(TMP, { recursive: true, force: true });
}

if (fails.length) {
  console.error('반복 타이머 공통 장치가 어긋난다\n' + fails.map((f) => `  ✗ ${f}`).join('\n'));
  process.exitCode = 1;
} else {
  console.log('통과 — 공통 장치: 거는 순간 · 같은 ms · unref · 오류 결과 같음 · 겹쳐도 돎 · 같은 이름 둘 · 실패 셈 · 상태 파일(안 켜면 안 씀 · 30초 · 문구 없음 · 못 써도 안 던짐)');
}
