/**
 * 검사를 다 돌린다.
 *
 *   npm test
 *
 * **목록을 손으로 안 적는다** — `package.json` 의 `check:*` 를 그대로 읽는다.
 * 검사를 새로 만들면 저절로 들어오고, 이름을 바꿔도 따라온다. 손으로 적으면
 * 그 목록이 낡고, **낡은 목록은 「다 돌렸다」고 말하면서 새 검사를 빼먹는다.**
 *
 * **첫 실패에서 안 멈춘다** — `&&` 로 이으면 하나 깨졌을 때 뒤를 못 본다.
 * 다 돌리고 끝에 모아 낸다.
 *
 * 왜 만들었나 — 검사 아홉 개가 있는데 묶는 자리도 훅도 없었다. 어느 것을
 * 돌릴지가 사람 기억에 달려 있었고, 실제로 하나(`check:board`)가 못 도는 채로
 * 남아 있었다(2026-08-23).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PER_CHECK_MS = 300_000;

const scripts = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'),
).scripts ?? {};
const names = Object.keys(scripts).filter((k) => k.startsWith('check:')).sort();

if (!names.length) {
  // 0개면 통과가 아니라 **안 본 것**이다. 조용히 넘기면 이 자리는 있으나 마나다.
  console.error('검사를 하나도 못 찾았습니다 — package.json 의 check:* 를 보세요');
  process.exit(1);
}

// dist 를 쓰는 검사가 여럿이라 먼저 짓는다 — 안 지으면 「dist 가 없습니다」가
// 진짜 실패인 것처럼 줄줄이 뜬다.
process.stdout.write('빌드… ');
const built = spawnSync('npm', ['run', '--silent', 'build'], {
  cwd: ROOT, shell: true, encoding: 'utf-8',
});
if (built.status !== 0) {
  console.log('실패');
  console.log((built.stdout || '') + (built.stderr || ''));
  process.exit(1);
}
console.log('됨');

const failed = [];
for (const name of names) {
  process.stdout.write(`${name} … `);
  const r = spawnSync('npm', ['run', '--silent', name], {
    cwd: ROOT, shell: true, encoding: 'utf-8', timeout: PER_CHECK_MS,
  });
  const out = ((r.stdout || '') + (r.stderr || '')).trimEnd();
  if (r.status === 0) {
    console.log('○');
  } else {
    console.log(r.signal === 'SIGTERM' ? `✗ (${PER_CHECK_MS / 1000}초 넘김)` : '✗');
    failed.push({ name, out });
  }
}

console.log('');
if (failed.length) {
  for (const { name, out } of failed) {
    console.log(`── ${name} ──`);
    console.log(out.split('\n').slice(-12).join('\n'));
    console.log('');
  }
  console.log(`검사 ${names.length}개 중 ${failed.length}개 실패 —`
    + ` ${failed.map((f) => f.name).join(' · ')}`);
  process.exitCode = 1;
} else {
  console.log(`통과 — 검사 ${names.length}개 (${names.join(' · ')})`);
}
