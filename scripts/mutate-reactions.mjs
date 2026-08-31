/**
 * 반응 줄 세우기 문이 진짜 잡는지 — dist 를 잠깐 망가뜨려 본다.
 *
 *   node scripts/mutate-reactions.mjs
 *
 * **검사가 통과하는 것만으로는 문이 선 것을 못 보인다.** 다 지나가는 검사는
 * 아무것도 안 세는 검사와 화면이 같다. 그래서 넣은 문마다 대응하는 고장을
 * 만들어 보고, 안 잡히는 것이 있으면 그 문은 헛돈 것이다.
 *
 * ⚠️ **원본은 반드시 되돌린다** — 도중에 죽어도 `process.on('exit')` 이 되돌린다.
 * 이 파일은 검사 목록(`check:*`)에 넣지 않는다. 사람이 손으로 부르는 확인이고,
 * dist 를 건드리므로 다른 검사와 같이 돌면 서로를 방해한다.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist', 'slack-handler.js');
const original = fs.readFileSync(DIST, 'utf8');

let restored = false;
function restore() {
  if (restored) return;
  restored = true;
  fs.writeFileSync(DIST, original);
}
process.on('exit', restore);

const CHAIN = `        const prev = this.reactionChain.get(sessionKey) ?? Promise.resolve();
        const next = prev.then(work).catch(() => { });
        this.reactionChain.set(sessionKey, next);`;

const mutations = [
  {
    name: '기다리게 되돌림 — 줄을 안 세우고 바로 부른다',
    from: CHAIN,
    to: `        void sessionKey;
        return work();`,
  },
  {
    name: '실패를 안 삼킴 — 한 번 터지면 그 세션 반응이 통째로 죽는다',
    from: CHAIN,
    to: `        const prev = this.reactionChain.get(sessionKey) ?? Promise.resolve();
        const next = prev.then(work);
        this.reactionChain.set(sessionKey, next);`,
  },
  {
    name: '줄을 세션마다 안 나눔 — 남의 느린 반응이 내 차례를 민다',
    from: CHAIN,
    to: `        const prev = this.reactionChain.get('*') ?? Promise.resolve();
        const next = prev.then(work).catch(() => { });
        this.reactionChain.set('*', next);
        this.reactionChain.set(sessionKey, next);`,
  },
  {
    name: '앞의 것을 안 기다림 — 순서가 뒤집힌다',
    from: CHAIN,
    to: `        const next = Promise.resolve().then(work).catch(() => { });
        const prevAll = this.reactionChain.get(sessionKey) ?? Promise.resolve();
        this.reactionChain.set(sessionKey, Promise.all([prevAll, next]).then(() => { }));`,
  },
];

let missed = 0;
for (const m of mutations) {
  if (!original.includes(m.from)) {
    console.log(`  ??   ${m.name} — 바꿀 대목을 못 찾음 (dist 가 낡았거나 코드가 바뀜)`);
    missed += 1;
    continue;
  }
  fs.writeFileSync(DIST, original.replace(m.from, m.to));
  let caught = false;
  try {
    execFileSync('node', [path.join(ROOT, 'scripts', 'check-reaction-queue.mjs')], { stdio: 'pipe' });
  } catch {
    caught = true;
  }
  fs.writeFileSync(DIST, original);
  console.log(`  ${caught ? 'OK  ' : 'FAIL'} ${m.name}${caught ? '' : ' — 안 잡힘'}`);
  if (!caught) missed += 1;
}

restore();
console.log(missed ? `\n${missed}건이 안 잡힙니다` : `\n변이 ${mutations.length}건 전부 잡음`);
process.exitCode = missed ? 1 : 0;
