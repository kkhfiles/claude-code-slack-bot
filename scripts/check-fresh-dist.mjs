/**
 * `dist` 를 읽는 검사가 낡음 가드를 다 걸었나.
 *
 * ⛔ **규칙을 적어 두는 것으로는 안 막힌다** — 새 검사를 쓰는 사람이 그 규칙을
 * 읽었는지가 통과·실패를 가르면, 언젠가 안 읽은 하나가 조용히 거짓 통과를 낸다.
 * 그래서 커버리지를 기계로 센다.
 *
 * ⚠️ `.js`(CommonJS) 검사는 이 모듈을 못 불러온다(ESM). 그쪽은 목록에 적어 두고
 * **왜 빠졌는지 여기 남긴다** — 조용히 빼면 다음 사람이 빠뜨린 줄 안다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'scripts');
const GUARD = "import './lib/fresh-dist.mjs'";

/** CommonJS 라 ESM 가드를 못 붙이는 것들. 옮기면 목록에서 뺀다. */
const CJS_EXEMPT = new Set(['check-1on1.js', 'check-booking-nudge.js']);

const READS_DIST = /require\(MOD\)|require\([^)]*dist|from ['"][^'"]*dist|join\(ROOT, ['"]dist['"]\)/;

const fails = [];
let checked = 0;
for (const name of fs.readdirSync(DIR)) {
  if (!name.startsWith('check-') || !/\.(mjs|js)$/.test(name)) continue;
  if (name === 'check-fresh-dist.mjs') continue;
  const body = fs.readFileSync(path.join(DIR, name), 'utf-8');
  if (!READS_DIST.test(body)) continue;
  checked += 1;
  if (CJS_EXEMPT.has(name)) continue;
  if (!body.includes(GUARD)) {
    fails.push(`${name} 가 dist 를 읽는데 낡음 가드가 없습니다 — 맨 위에 ${GUARD}; 한 줄`);
  }
}

if (!checked) {
  // 0개면 통과가 아니라 **못 찾은 것**이다 — 정규식이 낡았을 수 있다.
  console.error('dist 를 읽는 검사를 하나도 못 찾았습니다 — 찾는 규칙을 보세요');
  process.exit(1);
}

if (fails.length) {
  console.log(`실패 ${fails.length}건\n`);
  for (const f of fails) console.log('  ✗ ' + f);
  process.exitCode = 1;
} else {
  console.log(`통과 — 낡은 dist 가드 (dist 를 읽는 검사 ${checked}개 · `
    + `CommonJS 예외 ${CJS_EXEMPT.size}개는 목록에 적힘)`);
}
