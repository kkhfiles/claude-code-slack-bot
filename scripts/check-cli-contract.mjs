/**
 * 봇이 부르는 이름이 파이썬에 아직 있는가.
 *
 *   npm run check:cli      (또는 `npm test` 에 같이 들어간다)
 *
 * **레포 경계를 넘는 계약인데 정의가 공유되지 않는다.** 봇은 `tasks.py` 를
 * 서브커맨드와 플래그로 부르고, `tasks.py` 는 그것을 argparse 로 받는다.
 * 이름을 한쪽에서만 고치면 **부르는 그 순간까지 아무도 모른다** — 그리고
 * 그 순간은 대개 08:00 브리핑·08:55 넛지·17:00 체크인이라, 편집한 사람이
 * 아니라 사용자가 먼저 만난다.
 *
 * `tasks.py` 는 이 시스템에서 가장 자주 고치는 파일이다(최근 60커밋 중 22).
 *
 * **목록을 손으로 안 적는다** — 양쪽 소스에서 뽑아 맞춘다. 봇에 새 호출을
 * 넣거나 파이썬에서 플래그를 지우면 저절로 걸린다.
 *
 * ⚠️ **서브커맨드별로 센다.** 전체 플래그 집합으로 대조하면 `--slack` 처럼
 * 여러 서브커맨드에 따로 붙은 이름이 엉뚱한 곳에서도 통과한다.
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const wa = require(path.join(ROOT, 'dist', 'work-assistant.js'));
const waRoot = wa.workAssistantRoot();
if (!waRoot) {
  console.error('work-assistant 를 못 찾았습니다 — 설정의 workAssistant.root');
  process.exit(1);
}
const TASKS = path.join(waRoot, 'bin', 'tasks.py');
if (!fs.existsSync(TASKS)) {
  console.error(`tasks.py 가 없습니다: ${TASKS}`);
  process.exit(1);
}

// ---------- ① 파이썬이 받는 것 ----------
const allowed = new Map();          // 서브커맨드 → 플래그 집합
let cur = null;
for (const line of fs.readFileSync(TASKS, 'utf-8').split('\n')) {
  const sub = line.match(/add_parser\(\s*["']([a-z_-]+)["']/);
  if (sub) {
    cur = sub[1];
    if (!allowed.has(cur)) allowed.set(cur, new Set());
    continue;
  }
  const flag = line.match(/\.add_argument\(\s*["'](--[a-z0-9-]+)["']/);
  if (flag && cur) allowed.get(cur).add(flag[1]);
}
if (allowed.size < 10) {
  // 0 이나 몇 개면 통과가 아니라 **안 본 것**이다. 뽑는 규칙이 헛돌면 이
  // 검사는 조용히 늘 통과하고, 그 사실조차 안 보인다.
  console.error(`tasks.py 에서 뽑은 서브커맨드가 ${allowed.size}개뿐 — 뽑는 규칙이 헛돕니다`);
  process.exit(1);
}

// ---------- ② 봇이 부르는 것 ----------
// 배열 리터럴 중 **첫 칸이 아는 서브커맨드**인 것만 본다. 안의 변수는 건너뛰고
// 따옴표 친 토큰만 센다 — `['quick', '--file', file]` 이면 quick·--file 이다.
const calls = [];
const srcDir = path.join(ROOT, 'src');
for (const f of fs.readdirSync(srcDir).filter((x) => x.endsWith('.ts'))) {
  const text = fs.readFileSync(path.join(srcDir, f), 'utf-8');
  for (const m of text.matchAll(/\[([^[\]\n]*)\]/g)) {
    const toks = [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]);
    if (toks.length && allowed.has(toks[0])) calls.push({ file: f, toks });
  }
}

const fails = [];
if (!calls.length) {
  fails.push('봇에서 tasks.py 호출을 하나도 못 찾았습니다 — 찾는 규칙이 헛돕니다');
}
const seen = new Set();
for (const { file, toks } of calls) {
  const key = toks.join(' ');
  if (seen.has(key)) continue;
  seen.add(key);
  const ok = allowed.get(toks[0]);
  const miss = toks.slice(1).filter((x) => x.startsWith('--') && !ok.has(x));
  if (miss.length) {
    fails.push(`${file}: \`${key}\` — «${toks[0]}» 에 없는 플래그 ${miss.join(' ')}`
      + `\n    쓸 수 있는 것: ${[...ok].sort().join(' ') || '(없음)'}`);
  }
}

if (fails.length) {
  console.log(`실패 ${fails.length}건\n`);
  for (const f of fails) console.log('  ✗ ' + f);
  process.exitCode = 1;
} else {
  console.log(`통과 — 봇이 부르는 조합 ${seen.size}개가 tasks.py 서브커맨드`
    + ` ${allowed.size}개 안에 다 있음`);
}
