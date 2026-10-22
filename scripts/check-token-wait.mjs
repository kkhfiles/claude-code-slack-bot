/**
 * 예약 세션 앞의 토큰 대기 — 토큰이 세션 상한 안에 끝나면 갱신을 기다렸다 띄우나(2026-10-22).
 *
 *   npm run check:tokenwait     (먼저 `npm run build`)
 *
 * 10/19~10/21 밤 22:00 분석이 띄울 때 받은 토큰으로 돌다 22:07~22:16 의 터미널 갱신에 그 토큰이 폐기되어
 * 「OAuth token revoked」로 끊겼다. 그 밤의 시각 그대로 한 장면을 돌린다. 진짜 세션은 안 띄우고 시계는 가짜다.
 */
import './lib/fresh-dist.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { waitForFreshToken } = require(path.join(ROOT, 'dist', 'token-wait.js'));

const fails = [];
const eq = (label, got, want) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) fails.push(`${label}\n    받음 ${JSON.stringify(got)}\n    기대 ${JSON.stringify(want)}`);
};
const ok = (label, cond) => { if (!cond) fails.push(label); };

const MIN = 60_000;
/** 가짜 시계 — sleep 이 시계를 민다. `refreshAt` 에 이르면 만료 시각이 8시간 뒤로 바뀐다. */
function world({ now, exp, refreshAt = null, throwRefresh = false }) {
  const w = { now, exp, sleeps: 0, refreshes: 0, waited: null };
  w.deps = {
    now: () => w.now,
    sleep: async (ms) => { w.sleeps += 1; w.now += ms; },
    expiresAt: () => w.exp,
    refresh: async () => {
      w.refreshes += 1;
      if (throwRefresh) throw new Error('받아 오기 실패');
      if (refreshAt !== null && w.now >= refreshAt) w.exp = w.now + 8 * 60 * MIN;
    },
    onWait: (ms) => { w.waited = Math.round(ms / MIN); },
  };
  return w;
}

const T = Date.UTC(2026, 9, 21, 13, 0, 0); // 10/21(화) 22:00 KST — 분석이 뜨는 때

{
  const w = world({ now: T, exp: T + 5 * 60 * MIN });
  eq('넉넉함 — 안 기다림', [await waitForFreshToken(60 * MIN, w.deps), w.sleeps, w.waited], ['enough', 0, null]);
}
{
  const w = world({ now: T, exp: null });
  eq('만료 시각 모름 — 안 기다림', [await waitForFreshToken(60 * MIN, w.deps), w.sleeps], ['unknown', 0]);
  eq('상한 없음 — 안 기다림', await waitForFreshToken(undefined, world({ now: T, exp: T + MIN }).deps), 'unknown');
}
{
  // 그 밤 그대로 — 상한 60분 · 토큰 22:10:44 만료 · 터미널 갱신을 22:10:44 에 받음
  const w = world({ now: T, exp: T + 10 * MIN + 44_000, refreshAt: T + 10 * MIN + 44_000 });
  const r = await waitForFreshToken(60 * MIN, w.deps);
  eq('그 밤 — 기다렸다 갱신된 토큰으로', [r, w.waited], ['refreshed', 11]);
  ok(`그 밤 — 갱신 직후에 띄움(${(w.now - T) / MIN}분 뒤)`, w.now >= T + 10 * MIN + 44_000 && w.now <= T + 11 * MIN + 30_000);
  ok('그 밤 — 새 토큰이 상한보다 오래 삶', w.exp - w.now >= 60 * MIN);
}
{
  // 끝내 안 바뀜 — 만료 + 10분에 그대로 띄운다(멈추지 않는다)
  const w = world({ now: T, exp: T + 20 * MIN });
  const r = await waitForFreshToken(60 * MIN, w.deps);
  eq('안 바뀜 — 포기하고 띄움', r, 'gave-up');
  ok(`안 바뀜 — 만료 + 10분 안팎에 멈춤(${(w.now - T) / MIN}분)`, w.now >= T + 30 * MIN && w.now < T + 31 * MIN);
}
{
  // 받아 오기가 던져도 다음 회차에 다시 본다
  const w = world({ now: T, exp: T + 2 * MIN, throwRefresh: true });
  eq('받아 오기 실패 — 던지지 않고 끝까지 봄', [await waitForFreshToken(60 * MIN, w.deps), w.refreshes > 1], ['gave-up', true]);
}
{
  // 이미 만료된 지 오래 — 기다리지 않고 바로 띄운다
  const w = world({ now: T, exp: T - 60 * MIN });
  eq('오래전 만료 — 바로 띄움', [await waitForFreshToken(60 * MIN, w.deps), w.sleeps], ['gave-up', 0]);
}

// 배선 — 예약 세션이 토큰을 고르기 전에 기다린다
{
  const src = fs.readFileSync(path.join(ROOT, 'src', 'slack-handler.ts'), 'utf-8').replace(/\r\n/g, '\n');
  const at = src.indexOf('private async runAssistantSession(');
  const body = src.slice(at, src.indexOf('\n  }\n', at));
  const wait = body.indexOf('waitForFreshToken(opts.maxDurationMs');
  const take = body.indexOf('this.accountManager.getAccessToken();\n    const env');
  ok('예약 세션이 세션 상한으로 토큰 대기를 부른다', wait > 0);
  ok('토큰 대기가 토큰을 고르기 전에 온다', wait > 0 && take > wait);
}

if (fails.length) {
  console.log(`실패 ${fails.length}건\n`);
  for (const f of fails) console.log('  ✗ ' + f);
  process.exitCode = 1;
} else {
  console.log('통과 — 토큰 대기 (넉넉하면 안 기다림 · 모르면 안 기다림 · 10/21 밤 그대로 기다렸다 띄움 · 안 바뀌면 만료 + 10분에 띄움 · 받아 오기 실패에 안 넘어짐 · 배선)');
}
