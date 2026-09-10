/**
 * 상주 `turn.py` 를 한 번만 띄우고 답을 id 로 맞추는가.
 *
 *   npm run check:turnserve     (먼저 `npm run build`)
 *
 * **진짜 turn.py 를 안 띄운다** — `child_process.spawn` 을 바꿔 끼워 규칙만 잰다.
 * 진짜로 띄우면 agy 를 부르고 구독 한도를 먹는다.
 *
 * 왜 상주인가 — 말마다 프로세스를 띄우면 그 아래 agy 가 매 턴 새로 뜨고 그 기동이
 * 5초다(실측 n=9 · 중앙값 5.0 · 모델 무관). 한 번 띄워 두면 turn.py 가 대화별 agy
 * 워커를 들고 있어 그 5초가 사라진다 — 실측 첫 턴 18.0초 · 2턴째 2.61초.
 *
 * 여기서 지키려는 것은 속도가 아니라 **안 섞이고 안 매달리는 것**이다.
 * ① 프로세스를 하나만 띄우는가 ② 답을 요청 id 로 맞추는가(순서가 바뀌어도)
 * ③ 프로세스가 죽었을 때 기다리던 것 전부에 실패를 알리는가 — 안 알리면 그 대화는
 *   다시 말을 걸어도 「생각 중」에서 안 벗어난다 ④ 못 띄우면 예전 단발로 내려가는가.
 */
import './lib/fresh-dist.mjs';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cp = require('node:child_process');
const { ChatHost } = require(path.join(ROOT, 'dist', 'chat-host.js'));

const fails = [];
const ok = (label, cond, detail = '') => {
  if (!cond) fails.push(`${label}${detail ? `\n    ${detail}` : ''}`);
};

/** 가짜 자식 프로세스 — stdin 에 들어온 줄을 모아 두고, 답은 시험이 직접 흘린다. */
class FakeChild extends EventEmitter {
  constructor(args) {
    super();
    this.args = args;
    this.killed = false;
    this.exitCode = null;
    this.signalCode = null;
    this.pid = 4242;
    this.lines = [];
    this.stdout = new EventEmitter();
    this.stdout.setEncoding = () => {};
    this.stderr = new EventEmitter();
    this.stderr.setEncoding = () => {};
    this.stdin = {
      write: (chunk, _enc, cb) => { this.lines.push(String(chunk)); cb?.(null); return true; },
      end: () => {},
    };
  }
  say(obj) { this.stdout.emit('data', `${JSON.stringify(obj)}\n`); }
  die(code = 1) { this.exitCode = code; this.emit('close', code, null); }
  kill() { this.killed = true; }
}

const spawned = [];
const realSpawn = cp.spawn;
cp.spawn = (cmd, args) => {
  const child = new FakeChild(args ?? []);
  spawned.push(child);
  return child;
};

const host = new ChatHost({
  name: 'zz', python: 'python', script: 'C:/nowhere/turn.py',
  surfaces: ['dm'], managerUserId: 'UMGR',
});

// ── ① 프로세스 하나 · --serve 로 뜨는가 ──────────────────────────────────────
const p1 = host.runTurn('U1', '갑', '안녕', false, false);
const p2 = host.runTurn('U2', '을', '반가워', false, false);
ok('프로세스를 하나만 띄운다', spawned.length === 1, `띄운 수 ${spawned.length}`);
ok('--serve 로 띄운다', (spawned[0]?.args ?? []).includes('--serve'),
   JSON.stringify(spawned[0]?.args));
ok('요청마다 한 줄씩 쓴다', spawned[0]?.lines.length === 2,
   `쓴 줄 ${spawned[0]?.lines.length}`);
ok('요청 한 줄에 줄바꿈이 하나뿐이다',
   spawned[0]?.lines.every((l) => l.endsWith('\n') && l.indexOf('\n') === l.length - 1),
   JSON.stringify(spawned[0]?.lines));

const ids = spawned[0].lines.map((l) => JSON.parse(l).id);
ok('요청마다 다른 id 를 붙인다', new Set(ids).size === 2, JSON.stringify(ids));

// ── ② 답을 id 로 맞춘다 (순서를 뒤집어 본다) ─────────────────────────────────
spawned[0].say({ id: ids[1], reply: '둘째', speak: true });
spawned[0].say({ id: ids[0], reply: '첫째', speak: true });
const [r1, r2] = await Promise.all([p1, p2]);
ok('먼저 보낸 요청이 자기 답을 받는다', r1.reply === '첫째', JSON.stringify(r1));
ok('나중 요청이 자기 답을 받는다', r2.reply === '둘째', JSON.stringify(r2));

// 늦게 온 답 · 모르는 id · JSON 아닌 줄에 안 터진다
spawned[0].say({ id: 'ghost', reply: 'x' });
spawned[0].stdout.emit('data', '[turn] 사람이 읽을 로그\n');
ok('모르는 id 와 JSON 아닌 줄을 흘린다', true);

// ── ③ 프로세스가 죽으면 기다리던 것에 실패를 알린다 ──────────────────────────
const p3 = host.runTurn('U3', '병', '살아 있나', false, false);
spawned[0].die(9);
const r3 = await p3;
ok('죽으면 기다리던 요청에 실패를 알린다', Boolean(r3.error), JSON.stringify(r3));
ok('죽은 뒤 다음 요청은 새 프로세스를 띄운다',
   (() => { host.runTurn('U4', '정', '또', false, false); return spawned.length === 2; })(),
   `띄운 수 ${spawned.length}`);

// ── ④ 못 띄우면 예전 단발로 내려간다 ────────────────────────────────────────
cp.spawn = () => { throw new Error('띄우기 실패(시험이 일부러)'); };
const host2 = new ChatHost({
  name: 'zz', python: 'python', script: 'C:/nowhere/turn.py',
  surfaces: ['dm'], managerUserId: 'UMGR',
});
const r5 = await host2.runTurn('U5', '무', '안녕', false, false);
ok('상주를 못 띄우면 단발로 내려가 실패를 JSON 으로 돌려준다',
   Boolean(r5.error) && r5.reply === '', JSON.stringify(r5));

cp.spawn = realSpawn;

if (fails.length) {
  console.error(`실패 ${fails.length}건`);
  for (const f of fails) console.error(`  - ${f}`);
  process.exitCode = 1;
} else {
  console.log('통과 — 상주 turn.py (프로세스 하나 · id 대응 · 죽음 통보 · 단발 폴백)');
}
