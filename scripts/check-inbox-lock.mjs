/**
 * 캡처를 덧붙일 때 파이썬과 같은 잠금을 잡는가 — 슬랙도 네트워크도 안 탄다.
 *
 *   npm run check:inboxlock     (먼저 `npm run build`)
 *
 * **왜 있나.** 파이썬(`tasks.py`)은 `inbox.jsonl` 을 통째로 다시 쓰는데(실패 표시 · 시도 횟수 · 닫기),
 * 그 사이에 봇이 덧붙인 줄은 덮여 **사라진다** — 받은 말을 잃는다. 2026-10-14 에 파이썬 쪽이 잠금
 * 파일(`<inbox>.lock`)을 걸었고, 봇도 같은 파일 · 같은 규칙(30초 지나면 묵은 것 · 덧붙이기는 2초만
 * 기다리고 못 잡아도 붙임)으로 잡는다.
 *
 * 실제 캡처 큐를 안 건드린다 — `WORK_ASSISTANT_HOME` 을 임시 폴더로 돌린다(파이썬과 같은 규칙).
 *
 * 변이 시험 — 잠금 잡기를 빼면 ①(2초 기다림)과 ③(덧붙이는 순간 잠금이 있음)이 실패해야 한다.
 */
import './lib/fresh-dist.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSIST = process.env.WORK_ASSISTANT_DIR || path.join(path.dirname(ROOT), 'work-assistant');
const TASKS = path.join(ASSIST, 'bin', 'tasks.py');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'inboxlock-'));
const INBOX = path.join(HOME, 'inbox.jsonl');
const LOCK = `${INBOX}.lock`;

// 봇은 `WORK_ASSISTANT_ROOT/bin/tasks.py` 가 있어야 캡처를 켠다. 진짜 레포가 없으면 빈 자리를 세운다.
let root = ASSIST;
if (!fs.existsSync(TASKS)) {
  root = path.join(HOME, 'root');
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'bin', 'tasks.py'), '');
}
// ⚠️ dist 를 부르기 **전에** 세운다 — 설정은 불러올 때 한 번 읽힌다.
process.env.WORK_ASSISTANT_ROOT = root;
process.env.WORK_ASSISTANT_HOME = HOME;
fs.writeFileSync(INBOX, '', 'utf-8');

const fails = [];
const eq = (label, got, want) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    fails.push(`${label}\n    받음 ${JSON.stringify(got)}\n    기대 ${JSON.stringify(want)}`);
  }
};
const ok = (label, cond) => { if (!cond) fails.push(label); };

const { captureToInbox, INBOX_ADD_WAIT_MS, INBOX_LOCK_STALE_MS } =
  require(path.join(ROOT, 'dist', 'work-assistant.js'));

const ids = () => fs.readFileSync(INBOX, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l).id);

// 경고를 센다 — `Logger.warn` 은 `console.warn` 으로 나간다. 글은 안 찍는다(건수만).
const warns = [];
const warnSaved = console.warn;
console.warn = (msg) => { warns.push(String(msg)); };

// 덧붙이는 순간 잠금 파일이 있었나 — 잠금 안에서 붙였다는 증거.
const fsMod = require('fs');
const appendSaved = fsMod.appendFileSync;
const sawLock = [];
fsMod.appendFileSync = function (file, ...rest) {
  if (String(file) === INBOX) sawLock.push(fs.existsSync(LOCK));
  return appendSaved.call(this, file, ...rest);
};

const timed = (fn) => { const t = performance.now(); const out = fn(); return [out, performance.now() - t]; };

try {
  eq('파이썬과 같은 묵은 기준(30초)', INBOX_LOCK_STALE_MS, 30_000);
  eq('파이썬과 같은 덧붙이기 대기(2초)', INBOX_ADD_WAIT_MS, 2_000);

  // ① 남이 막 잡은 잠금 — 2초 기다리고, 못 잡아도 붙이고, 경고를 남긴다. 남의 잠금은 안 지운다.
  {
    fs.writeFileSync(LOCK, 'other\n');
    warns.length = 0;
    const [rec, ms] = timed(() => captureToInbox('잠금 시험 하나'));
    ok(`① 잠금을 기다리지 않았다 — ${Math.round(ms)}ms (기대: 약 ${INBOX_ADD_WAIT_MS}ms)`, ms >= INBOX_ADD_WAIT_MS - 150);
    ok(`① 너무 오래 기다렸다 — ${Math.round(ms)}ms`, ms < INBOX_ADD_WAIT_MS + 1500);
    ok('① 못 잡아도 덧붙인다 — 받은 말을 잃었다', rec && ids().includes(rec.id));
    ok('① 경고를 안 남겼다', warns.some((w) => w.includes('[WARN]') && w.includes('잠금')));
    ok('① 남의 잠금을 지웠다', fs.existsSync(LOCK));
    fs.rmSync(LOCK, { force: true });
  }

  // ② 묵은 잠금(60초 전) — 지우고 바로 잡는다.
  {
    fs.writeFileSync(LOCK, 'dead\n');
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(LOCK, past, past);
    warns.length = 0;
    const [rec, ms] = timed(() => captureToInbox('잠금 시험 둘'));
    ok(`② 묵은 잠금에 오래 기다렸다 — ${Math.round(ms)}ms`, ms < 1000);
    ok('② 덧붙이지 않았다', rec && ids().includes(rec.id));
    ok('② 묵은 잠금이 남았다', !fs.existsSync(LOCK));
    ok('② 묵은 잠금인데 경고를 냈다', !warns.some((w) => w.includes('[WARN]')));
  }

  // ③ 평소 — 잠금 안에서 붙이고 다 붙이면 놓는다. 앞 시험이 남긴 잠금을 먼저 치운다 — 남아 있으면
  //    「붙이는 순간 잠금이 있었다」가 남의 잠금 덕에 참이 된다(변이 시험에서 실제로 그랬다).
  {
    fs.rmSync(LOCK, { force: true });
    sawLock.length = 0;
    const [rec, ms] = timed(() => captureToInbox('잠금 시험 셋'));
    ok(`③ 평소인데 오래 걸렸다 — ${Math.round(ms)}ms`, ms < 1000);
    eq('③ 덧붙이는 순간 잠금을 쥐고 있다', sawLock, [true]);
    ok('③ 다 붙인 뒤 잠금을 놓는다', !fs.existsSync(LOCK));
    ok('③ 덧붙였다', rec && ids().includes(rec.id));
  }

  // ④ 실제 동시 실행 — 파이썬이 다시 쓰는 사이 봇이 50줄을 붙인다.
  //    ⚠️ 연기 시험(smoke test)이지 증명이 아니다 — 겹치는 순간이 매번 같지 않다. 잠금이 빠지면
  //    대개 여기서 줄이 사라지지만, 안 사라진 판이 「안전하다」는 뜻은 아니다. 증명은 ①·③ 이 맡는다.
  const py = spawnSync('python', ['--version'], { encoding: 'utf-8' });
  if (py.status !== 0 || !fs.existsSync(TASKS)) {
    console.log('④ 건너뜀 — python 또는 work-assistant 의 tasks.py 를 못 찾음(①~③ 은 봤다)');
  } else {
    fs.copyFileSync(path.join(ASSIST, 'config.json'), path.join(HOME, 'config.json'));
    const X = 'lockx001';
    fs.appendFileSync(INBOX, JSON.stringify({
      id: X, ts: new Date().toISOString(), source: 'check', text: '시도 횟수 시험', thread: null,
      status: 'open', task: null, note: null,
    }) + '\n');
    const N = 8;
    const env = { ...process.env, WORK_ASSISTANT_HOME: HOME, WORK_ASSISTANT_NO_BOARD: '1', PYTHONDONTWRITEBYTECODE: '1' };
    const kids = Array.from({ length: N }, () => new Promise((resolve) => {
      const c = spawn('python', ['-X', 'utf8', TASKS, 'inbox', 'tried', '--id', X],
        { cwd: ASSIST, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let err = '';
      c.stderr.on('data', (d) => { err += d; });
      c.stdout.on('data', () => {});
      c.on('exit', (code) => resolve({ code, err: err.slice(-200) }));
      c.on('error', (e) => resolve({ code: -1, err: String(e) }));
    }));
    const mine = [];
    for (let i = 0; i < 50; i++) {
      const rec = captureToInbox(`동시 시험 ${i}`);
      if (rec) mine.push(rec.id);
      await new Promise((r) => setTimeout(r, 40));
    }
    const done = await Promise.all(kids);
    eq('④ 파이썬 여덟이 다 끝났다', done.map((d) => d.code), Array(N).fill(0));
    const rows = fs.readFileSync(INBOX, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const have = new Set(rows.map((r) => r.id));
    eq('④ 봇이 붙인 50줄이 하나도 안 사라졌다', mine.filter((id) => !have.has(id)).length, 0);
    eq('④ 봇이 50줄을 붙였다', mine.length, 50);
    eq('④ 파이썬의 다시 쓰기도 안 사라졌다(시도 8회)', rows.find((r) => r.id === X)?.tries, N);
    ok('④ 잠금이 남았다', !fs.existsSync(LOCK));
  }
} finally {
  console.warn = warnSaved;
  fsMod.appendFileSync = appendSaved;
  fs.rmSync(HOME, { recursive: true, force: true });
}

if (fails.length) {
  console.error(`실패 ${fails.length}건\n`);
  for (const f of fails) console.error('  ✗ ' + f);
  process.exitCode = 1;
} else {
  console.log('통과 — 캡처 큐 잠금 (파이썬과 같은 기준 · 남의 잠금은 2초 기다리고 붙임 + 경고 · 묵은 잠금은 지움'
    + ' · 잠금 안에서 붙이고 놓음 · 파이썬과 동시 실행 연기 시험)');
}
