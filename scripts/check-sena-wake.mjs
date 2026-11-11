/**
 * 세나 각성 타이머 — 끄는 문이 듣는지, 부르는 명령이 업무 비서에 실제로 있는지 잰다.
 *
 *   node scripts/check-sena-wake.mjs
 *
 * 왜 재나 — 타이머는 조용히 실패한다. 부르는 하위 명령이 업무 비서 쪽에 없으면 10분마다 rc 2 를 로그에만 남기고 각성은 영영 안 돈다.
 */
import './lib/fresh-dist.mjs';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { wakeEnabled, WAKE_POLL_MS, WAKE_TIMEOUT_MS } = require(path.join(ROOT, 'dist', 'sena-wake.js'));

let pass = 0;
const fails = [];
const check = (name, ok, got) => {
  if (ok) { pass++; console.log(`PASS ${name}`); return; }
  fails.push(name);
  console.log(`FAIL ${name} — 받음 ${JSON.stringify(got)}`);
};

check('기본은 켜짐(A4 관찰 기간 없음)', wakeEnabled({}));
check('SENA_WAKE=off 면 꺼짐(대소문자 무관)', !wakeEnabled({ SENA_WAKE: 'OFF' }));
check('한 번 깨움 상한이 타이머 간격보다 짧음 — 겹쳐 돌지 않게', WAKE_TIMEOUT_MS < WAKE_POLL_MS, [WAKE_TIMEOUT_MS, WAKE_POLL_MS]);
const wa = process.env.WORK_ASSISTANT_ROOT || 'P:/github/work-assistant';
const py = path.join(wa, 'bin', 'sena_wake.py');
if (fs.existsSync(py)) {
  const src = fs.readFileSync(py, 'utf-8');
  check('업무 비서 sena_wake.py 에 tick 하위 명령이 있음', /add_parser\('tick'\)/.test(src));
} else {
  console.log(`(건너뜀) ${py} 없음 — 업무 비서가 없는 PC`);
}

console.log(`\n${pass} 통과 · ${fails.length} 실패`);
if (fails.length) process.exit(1);
