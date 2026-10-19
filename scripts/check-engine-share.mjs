/**
 * 엔진 상태 공유 — 봇과 파이썬(llm-playbook `engine_state.py`)이 같은 파일을 같은 규약으로 쓰나. 슬랙도 네트워크도 안 탄다.
 *
 *   npm run check:engineshare     (먼저 `npm run build`)
 *
 * 앞 절(봇 혼자) — 모르는 열쇠 보존 · 깨진 파일은 안 덮음 · 잠금(쥐고 있으면 건너뜀 · 묵은 잠금은 지움 · 쓰고 나면
 * 풀음) · 들여다보기(남이 쓴 막힘 변화에만 알림 · 내 쓰기로는 안 알림) · 그 알림으로 회복 타이머가 다시 걸리고 안내는
 * 미루기(`hold`)를 지킴.
 *
 * 뒤 절(두 언어) — 봇이 적은 막힘을 파이썬이 읽고, 파이썬이 적은 막힘(`agy-argon` 포함)을 봇이 읽고, 봇의 다음 쓰기가
 * `agy-argon` 을 안 지우고, 둘이 동시에 150번씩 써도 잃는 기록이 없나. **파이썬이나 llm_playbook 을 못 부르면
 * 「건너뜀」** — 실패가 아니라 안 본 것이다. 파이썬은 `LLM_PLAYBOOK_ENGINE_STATE` 로 임시 파일을 본다.
 *
 * **운영 파일을 안 건드린다** — 상태 파일을 전부 임시 자리로 옮긴 뒤에 dist 를 부른다.
 *
 * 변이 시험 — ① 모르는 엔진 열쇠를 버림 ② 깨진 파일을 빈 상태로 덮음 ③ 잠금 없이 씀 ④ 들여다보기가 내 쓰기에도
 * 알림 — 넷 다 이 검사가 실패해야 한다.
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
const DIST = path.join(ROOT, 'dist');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-share-'));

// ⚠️ dist 를 부르기 **전에** 자리를 옮긴다 — 봇 전체가 쓰는 하나(`engineState`)가 운영 파일을 안 건드리게.
process.env.ENGINE_STATE_FILE = path.join(TMP, 'singleton.json');
process.env.RATE_LIMIT_UNTIL_FILE = path.join(TMP, 'singleton-legacy.json');

const { EngineState, LOCK_WAIT_MS, LOCK_STALE_MS } = require(path.join(DIST, 'engine-state.js'));
const { EngineRecovery, RECOVERY_SLACK_MS } = require(path.join(DIST, 'engine-recovery.js'));
const { EngineNotice } = require(path.join(DIST, 'engine-notice.js'));

const PROD = path.join(ROOT, '.engine-state.json');
const prodStamp = () => (fs.existsSync(PROD) ? fs.statSync(PROD).mtimeMs : null);
const prodBefore = prodStamp();

const fails = [];
const eq = (label, got, want) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    fails.push(`${label}\n    받음 ${JSON.stringify(got)}\n    기대 ${JSON.stringify(want)}`);
  }
};
const ok = (label, cond) => { if (!cond) fails.push(label); };
const raw = (f) => JSON.parse(fs.readFileSync(f, 'utf-8'));
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const tick = () => new Promise((r) => setImmediate(r));

let n = 0;
const fileOf = () => path.join(TMP, `s${++n}.json`);
const at = (file, extra = {}) => new EngineState({ file, legacyFile: path.join(TMP, `none${n}.json`), ...extra });
const nowSec = () => Math.floor(Date.now() / 1000);
let skipped = null;
let pyLine = '';

try {
  // ================================================================ 앞 절 — 봇 혼자
  // ---------- 모르는 열쇠를 지우지 않는다 ----------
  {
    const f = fileOf();
    const argon = { blocked: { kind: 'usage', until: nowSec() + 7200, untilKnown: true, since: 1 }, lastOkAt: null, uses: [] };
    fs.writeFileSync(f, JSON.stringify({
      v: 1,
      engines: { claude: { blocked: null, lastOkAt: null, uses: [], extraField: 7 }, 'agy-argon': argon },
      notice: null, ladder: null, future: { a: 1 },
    }));
    const s = at(f);
    s.recordOk('codex');
    s.recordBlocked('claude', { kind: 'overload' });
    const r = raw(f);
    eq('모르는 엔진(agy-argon)은 읽은 그대로', r.engines['agy-argon'], argon);
    eq('모르는 윗단 칸은 그대로', r.future, { a: 1 });
    eq('아는 엔진 기록 안의 모르는 칸도 그대로', r.engines.claude.extraField, 7);
    eq('아는 칸은 고쳐짐', [r.engines.codex.blocked, r.engines.claude.blocked?.kind], [null, 'overload']);
    eq('봇이 모르는 엔진은 회복 시각에 안 섞임', s.nextRecoveryAt() < nowSec() + 7000, true);
  }

  // ---------- 깨진 파일은 덮어쓰지 않는다 ----------
  for (const body of ['{깨진', '{"v":1,"engines":null}', '[1,2]']) {
    const f = fileOf();
    fs.writeFileSync(f, body);
    const s = at(f);
    const b = s.recordBlocked('claude', { kind: 'usage', until: nowSec() + 600 });
    eq(`깨진 파일(${body}) — 고친 값으로 답은 함`, b?.kind, 'usage');
    eq(`깨진 파일(${body}) — 그대로 둠`, fs.readFileSync(f, 'utf-8'), body);
    eq(`깨진 파일(${body}) — 읽기는 막힘 없음(fail-open)`, s.isBlocked('claude'), false);
    s.noticeOnce('k');
    eq(`깨진 파일(${body}) — 안내 열쇠도 안 씀`, fs.readFileSync(f, 'utf-8'), body);
  }

  // ---------- 잠금 ----------
  {
    // 남이 쥔 잠금 — 기다리다 건너뛰고(파일 안 만듦) 남의 잠금은 안 지운다
    const f = fileOf();
    fs.writeFileSync(`${f}.lock`, '99999\n');
    const s = at(f);
    const t0 = Date.now();
    const b = s.recordBlocked('claude', { kind: 'usage', until: nowSec() + 600 });
    const took = Date.now() - t0;
    eq('잠금이 쥐여 있으면 기록을 건너뜀(파일 안 생김)', fs.existsSync(f), false);
    eq('건너뛰어도 고친 값으로 답은 함', b?.kind, 'usage');
    ok(`기다린 시간 ${took}ms — ${LOCK_WAIT_MS}ms 안팎이어야`, took >= LOCK_WAIT_MS - 50 && took < LOCK_WAIT_MS + 1500);
    ok('남의 잠금은 안 지움', fs.existsSync(`${f}.lock`));
    ok(`기다림 상한은 2초 이하 — ${LOCK_WAIT_MS}`, LOCK_WAIT_MS <= 2000);
    eq('묵은 기준은 파이썬과 같은 30초', LOCK_STALE_MS, 30_000);

    // 묵은 잠금 — 지우고 쓴다
    const old = (Date.now() - LOCK_STALE_MS - 5000) / 1000;
    fs.utimesSync(`${f}.lock`, old, old);
    s.recordBlocked('claude', { kind: 'usage', until: nowSec() + 600 });
    eq('묵은 잠금은 지우고 씀', raw(f).engines.claude.blocked?.kind, 'usage');
    eq('쓰고 나면 잠금을 풀음', fs.existsSync(`${f}.lock`), false);
    eq('임시 파일이 안 남음', fs.readdirSync(TMP).filter((x) => x.endsWith('.tmp')), []);
  }

  // ---------- 들여다보기 — 남이 쓴 막힘 변화에만 알림 ----------
  {
    const f = fileOf();
    const me = at(f);
    const other = at(f); // 다른 프로세스 대신 — 지문을 따로 든다
    let heard = 0;
    me.subscribe(() => { heard++; });
    eq('처음 들여다보기는 기준만 잡음', me.pollFile(), false);
    me.recordBlocked('claude', { kind: 'usage', until: nowSec() + 600 });
    eq('내 쓰기 — 알림 한 번(쓰는 자리에서)', heard, 1);
    eq('내 쓰기 뒤 들여다보기 — 안 알림(되먹임 없음)', [me.pollFile(), heard], [false, 1]);
    other.recordBlocked('codex', { kind: 'usage', until: nowSec() + 900 });
    eq('남이 쓴 막힘 — 알림', [me.pollFile(), heard], [true, 2]);
    eq('같은 것을 다시 보면 안 알림', [me.pollFile(), heard], [false, 2]);
    other.noteUse('claude');
    eq('막힘이 아닌 칸만 바뀜 — 안 알림', [me.pollFile(), heard], [false, 2]);
    const r = raw(f);
    r.engines['agy-argon'] = { blocked: { kind: 'usage', until: nowSec() + 60, untilKnown: true, since: 1 }, lastOkAt: null, uses: [] };
    fs.writeFileSync(f, JSON.stringify(r));
    eq('봇이 모르는 엔진만 바뀜 — 안 알림', [me.pollFile(), heard], [false, 2]);
    const good = fs.readFileSync(f, 'utf-8');
    fs.writeFileSync(f, '{반쪽');
    eq('깨진 파일 — 「다 풀림」으로 안 알림', [me.pollFile(), heard], [false, 2]);
    fs.writeFileSync(f, good);
    eq('다시 성한 파일 — 막힘이 같으면 안 알림', [me.pollFile(), heard], [false, 2]);
    // 남이 쓴 뒤 내가 쓰면 그 쓰기에서 알림이 나감(남의 변화를 삼키지 않음)
    other.recordOk('claude');
    me.noteUse('agy-gemini');
    eq('남이 푼 막힘 — 내 다음 쓰기에서라도 알림', heard, 3);

    // 진짜 타이머 — 짧은 간격으로 켜서 남의 쓰기를 듣고 끔
    const stop = me.startWatch(40);
    other.recordBlocked('agy-gemini', { kind: 'overload' });
    const t0 = Date.now();
    while (heard < 4 && Date.now() - t0 < 2000) await new Promise((r2) => setTimeout(r2, 20));
    eq('startWatch — 남의 쓰기를 타이머가 들음', heard, 4);
    stop();
    other.recordOk('agy-gemini');
    await new Promise((r2) => setTimeout(r2, 150));
    eq('끄면 안 들음', heard, 4);
  }

  // ---------- 그 알림으로 회복 타이머가 다시 걸리고 · 안내는 미루기를 지킴 ----------
  {
    const f = fileOf();
    const me = at(f);
    const other = at(f);
    const timers = [];
    const rec = new EngineRecovery({
      store: me, onRecover: () => {},
      setTimer: (fn, ms) => { timers.push(ms); return timers.length; }, clearTimer: () => {},
    });
    rec.init();
    me.pollFile(); // 봇의 `startWatch` 가 켤 때 잡는 기준
    eq('막힘이 없으면 회복 타이머 없음', rec.armedFor, null);
    const U = nowSec() + 3600;
    other.recordBlocked('claude', { kind: 'usage', until: U });
    me.pollFile();
    eq('남이 적은 막힘 — 회복 타이머가 그 시각에 걸림', rec.armedFor, U * 1000 + RECOVERY_SLACK_MS);
    rec.stop();

    const posts = [];
    const notice = new EngineNotice({
      store: me, enabled: () => true, post: async (t) => { posts.push(t); },
      labels: () => ({ codex: '', agyClaude: '', gemini: '' }), ladder: () => ['claude', 'codex'],
      log: { info: () => {}, warn: () => {} },
    });
    notice.init();
    await tick();
    const startPosts = posts.length; // 기동 때 이미 막힌 Claude 를 한 번 알림
    const release = notice.hold(5000);
    other.recordBlocked('codex', { kind: 'usage', until: U });
    me.pollFile();
    await tick();
    eq('미루는 동안 — 남의 막힘으로도 안 보냄', posts.length, startPosts);
    release();
    await tick();
    eq('놓으면 지금 모양 한 줄', posts.length, startPosts + 1);
    ok(`그 줄은 다 막힘(⏸) — ${posts.at(-1)}`, (posts.at(-1) ?? '').startsWith('⏸'));
    notice.stop();
  }

  // ================================================================ 뒤 절 — 두 언어
  const PY = process.env.LADDER_PYTHON || 'python';
  const pyFile = path.join(TMP, 'py_side.py');
  fs.writeFileSync(pyFile, [
    'import json, sys, time',
    'from llm_playbook import engine_state as es',
    'cmd = sys.argv[1]',
    'if cmd == "probe":',
    '    print(json.dumps({"enabled": es.enabled()}))',
    'elif cmd == "read-and-write":',
    '    out = {"claude": es.is_blocked("claude"), "claude_until": (es.blocked("claude") or {}).get("until")}',
    '    out["codex"] = es.record_block("codex", "usage", until=int(sys.argv[2]))',
    '    out["argon"] = es.record_block("agy-argon", "usage", until=int(sys.argv[3]))',
    '    print(json.dumps(out))',
    'elif cmd == "check":',
    '    print(json.dumps({"argon": es.is_blocked("agy-argon"), "codex": es.is_blocked("codex")}))',
    'elif cmd == "ok-claude":',
    '    es.record_ok("claude")',
    '    print(json.dumps({"claude": es.is_blocked("claude")}))',
    'elif cmd == "hammer":',
    '    open(sys.argv[3], "w").close()',
    '    def bump(st):',
    '        st["pycount"] = st.get("pycount", 0) + 1',
    '        return True',
    '    skipped = 0',
    '    for i in range(int(sys.argv[2])):',
    '        if es._mutate(bump) is None:',
    '            skipped += 1',
    '        time.sleep(0.004)',
    '    print(json.dumps({"skipped": skipped}))',
    '',
  ].join(String.fromCharCode(10)));
  const py = (file, ...args) => {
    const r = spawnSync(PY, ['-X', 'utf8', pyFile, ...args], {
      encoding: 'utf-8', env: { ...process.env, LLM_PLAYBOOK_ENGINE_STATE: file }, timeout: 60_000,
    });
    if (r.status !== 0) throw new Error(`파이썬 rc=${r.status}: ${(r.stderr || r.error?.message || '').trim().split(String.fromCharCode(10)).pop()}`);
    return JSON.parse(r.stdout.trim().split(String.fromCharCode(10)).pop());
  };

  const probeFile = fileOf();
  try {
    const p = py(probeFile, 'probe');
    if (p.enabled !== true) skipped = 'llm_playbook 이 환경 변수의 상태 파일을 안 봄';
  } catch (err) {
    skipped = `파이썬이나 llm_playbook 을 못 부름 — ${err.message}`;
  }

  if (!skipped) {
    // ---------- 봇이 적고 파이썬이 읽고 · 파이썬이 적고 봇이 읽고 ----------
    const f = fileOf();
    const me = at(f);
    const U1 = nowSec() + 3600;
    const U2 = nowSec() + 7200;
    const U3 = nowSec() + 1800;
    me.recordBlocked('claude', { kind: 'usage', until: U1 });
    me.pollFile();
    const got = py(f, 'read-and-write', String(U2), String(U3));
    eq('파이썬이 봇의 막힘을 읽음', [got.claude, got.claude_until], [true, U1]);
    eq('파이썬이 적은 codex 막힘', [got.codex?.kind, got.codex?.until, got.codex?.untilKnown], ['usage', U2, true]);
    eq('봇이 파이썬의 codex 막힘을 읽음', [me.isBlocked('codex'), me.blockedUntil('codex'), me.blocked('codex')?.untilKnown], [true, U2, true]);
    let heard = 0;
    me.subscribe(() => { heard++; });
    eq('파이썬이 쓴 막힘 — 들여다보기가 알림', [me.pollFile(), heard], [true, 1]);
    const argon = raw(f).engines['agy-argon'];
    eq('파이썬이 적은 agy-argon', [argon?.blocked?.kind, argon?.blocked?.until], ['usage', U3]);
    me.noteUse('claude');
    me.recordOk('codex');
    eq('봇의 쓰기 뒤에도 agy-argon 은 그대로', raw(f).engines['agy-argon'], argon);
    eq('파이썬이 다시 읽음 — agy-argon 막힘 · codex 풀림', py(f, 'check'), { argon: true, codex: false });
    eq('파이썬이 Claude 성공을 적음', py(f, 'ok-claude'), { claude: false });
    eq('봇이 그 풀림을 읽음', me.isBlocked('claude'), false);
    ok('그 풀림도 들여다보기가 알림', me.pollFile() === true);

    // ---------- 동시에 150번씩 — 잃는 기록 0 ----------
    const g = fileOf();
    const mine = at(g);
    const N = 150;
    const marker = path.join(TMP, 'py-started');
    const child = spawn(PY, ['-X', 'utf8', pyFile, 'hammer', String(N), marker], {
      env: { ...process.env, LLM_PLAYBOOK_ENGINE_STATE: g }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const done = new Promise((r) => child.on('close', r));
    const t0 = Date.now();
    while (!fs.existsSync(marker) && Date.now() - t0 < 30_000) sleepSync(20);
    for (let i = 0; i < N; i++) { mine.noteUse('agy-gemini'); sleepSync(6); }
    const code = await done;
    eq(`파이썬 망치질이 끝남 — ${err.trim().split(String.fromCharCode(10)).pop() ?? ''}`, code, 0);
    const py150 = JSON.parse(out.trim().split(String.fromCharCode(10)).pop() || '{}');
    const r = raw(g);
    eq('동시 쓰기 — 파이썬이 건너뛴 기록 0', py150.skipped, 0);
    eq('동시 쓰기 — 파이썬 150번이 다 남음(봇이 안 지움)', r.pycount, N);
    eq('동시 쓰기 — 봇 150번이 다 남음(파이썬이 안 지움)', r.engines['agy-gemini'].uses.length, N);
    pyLine = ` · 동시 ${N}+${N}번 잃음 0`;
  }

  eq('운영 상태 파일을 안 건드렸다', prodStamp(), prodBefore);
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

if (fails.length) {
  console.error(`실패 ${fails.length}건\n`);
  for (const f of fails) console.error('  ✗ ' + f);
  process.exitCode = 1;
} else {
  console.log('통과 — 엔진 상태 공유 (모르는 열쇠 보존 · 깨진 파일 안 덮음 · 잠금 건너뜀·묵은 잠금 · 남의 쓰기만 알림'
    + ' · 회복 타이머 다시 걺 · 안내 미루기 지킴)'
    + (skipped ? ` · 두 언어 절 건너뜀(${skipped})` : ` · 두 언어 왕복${pyLine}`));
}
