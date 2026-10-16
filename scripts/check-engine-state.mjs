/**
 * 엔진 상태 — 막힘 적기 · 회복 타이머 · 한도 안내 한 번 · 엔진 안내 문구. 슬랙도 네트워크도 안 탄다.
 *
 *   npm run check:engine     (먼저 `npm run build`)
 *
 * **운영 파일을 안 건드린다** — 상태 파일 · 옛 파일 · 모델 표를 전부 임시 자리로 옮긴 뒤에 dist 를
 * 불러온다(봇 전체가 쓰는 하나도 부를 때마다 환경 변수에서 자리를 정한다).
 *
 * 여기 본문의 오류 글은 지어낸 것이 아니라 봇 로그에 실제로 온 한도 문구다(사용자 글은 안 실음).
 * 「4:10pm (Asia/Seoul)」을 읽은 값이 같은 차례의 `resetsAt`(1788160200)과 같아야 한다.
 *
 * 변이 시험(임시 사본에서) — ① 과부하 대기를 5시간으로 ② 됐을 때 막힘을 안 지움 ③ 기동 때 다시
 * 안 걺 ④ 모델 이름을 표 대신 글자로 박음 — 넷 다 이 검사가 실패해야 한다.
 */
import './lib/fresh-dist.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-state-'));

// ⚠️ dist 를 부르기 **전에** 자리를 옮긴다 — 봇 전체가 쓰는 하나(`engineState`)가 이 자리를 쓴다.
process.env.ENGINE_STATE_FILE = path.join(TMP, 'singleton.json');
process.env.RATE_LIMIT_UNTIL_FILE = path.join(TMP, 'singleton-legacy.json');
process.env.LLM_PLAYBOOK_MODELS = path.join(TMP, 'models.json');
delete process.env.ENGINE_NOTICE;

const fails = [];
const eq = (label, got, want) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    fails.push(`${label}\n    받음 ${JSON.stringify(got)}\n    기대 ${JSON.stringify(want)}`);
  }
};
const ok = (label, cond) => { if (!cond) fails.push(label); };

const {
  EngineState, OVERLOAD_FIRST_SEC, REPROBE_SEC, engineState,
} = require(path.join(DIST, 'engine-state.js'));
const { classifyClaudeEvent, classifyClaudeErrorText } = require(path.join(DIST, 'rate-limit-utils.js'));
const { ClaudeTap, currentClaudeBlock, thrownClaudeBlock } = require(path.join(DIST, 'engine-tap.js'));
const { EngineRecovery, RECOVERY_SLACK_MS } = require(path.join(DIST, 'engine-recovery.js'));
const {
  EngineNotice, composeTransition, dmRung, formatKst, loadModelLabels,
} = require(path.join(DIST, 'engine-notice.js'));
const { SdkProcess } = require(path.join(DIST, 'sdk-handler.js'));
const { CliProcess } = require(path.join(DIST, 'cli-handler.js'));

/** 실제로 온 한도 문구(봇 로그) — 사용자 글은 없다. */
const LOG = {
  session: "You've hit your session limit · resets 4:10pm (Asia/Seoul)",
  sessionWrapped: "Claude Code returned an error result: You've hit your session limit · resets 4:10pm (Asia/Seoul)",
  plain: "You've hit your limit · resets 1pm (Asia/Seoul)",
  weekly: "You've hit your weekly limit · resets Oct 5, 10am (Asia/Seoul)",
  night: "You've hit your session limit · resets 2:40am (Asia/Seoul)",
  overload: 'API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment. If it persists, check status.claude.com.',
  overloadWrapped: 'Claude Code returned an error result: API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment.',
  rate429: 'Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}',
};
/** 같은 차례(2026-08-31 16:04 KST)의 거절 이벤트가 실어 온 `resetsAt`. */
const SESSION_RESETS_AT = 1788160200;

const T0 = Date.UTC(2026, 9, 14, 1, 0, 0); // 2026-10-14(수) 10:00 KST
let nowMs = T0;
const clock = () => nowMs;
/** 운영 상태 파일 — 검사 앞뒤로 같아야 한다(안 만들고 안 고침). */
const PROD = path.join(ROOT, '.engine-state.json');
const prodStamp = () => (fs.existsSync(PROD) ? fs.statSync(PROD).mtimeMs : null);
const prodBefore = prodStamp();
const nowSec = () => Math.floor(nowMs / 1000);
let n = 0;
const fresh = (extra = {}) => new EngineState({
  file: path.join(TMP, `s${++n}.json`), legacyFile: path.join(TMP, `none${n}.json`), now: clock, ...extra,
});

try {
  // ---------- 사용량 소진 ----------
  {
    const s = fresh();
    const U = nowSec() + 3600;
    s.recordBlocked('claude', { kind: 'usage', until: U, limitType: 'five_hour' });
    eq('사용량 소진: 막혔다', s.isBlocked('claude'), true);
    eq('사용량 소진: 서버가 준 시각 그대로', s.blockedUntil('claude'), U);
    eq('사용량 소진: 서버가 준 시각이라고 적는다', s.blocked('claude').untilKnown, true);
    eq('사용량 소진: 창 종류를 적는다', s.blocked('claude').limitType, 'five_hour');
    s.recordBlocked('claude', { kind: 'usage', until: U - 1800 });
    eq('앞당기지 않는다', s.blockedUntil('claude'), U);
    s.recordBlocked('claude', { kind: 'usage', until: U + 600 });
    eq('늦은 쪽으로는 민다', s.blockedUntil('claude'), U + 600);
    s.recordBlocked('claude', { kind: 'usage' });
    eq('시각 없는 새 실패가 서버 시각을 안 덮는다', s.blockedUntil('claude'), U + 600);
    eq('다른 엔진은 그대로', s.isBlocked('codex'), false);
    s.recordOk('claude');
    eq('됐으면 막힘을 지운다', s.blocked('claude'), null);
    eq('됐으면 안 막혔다', s.isBlocked('claude'), false);
    eq('된 시각을 적는다', s.load().engines.claude.lastOkAt, nowSec());

    // 짐작(시각 모름) 뒤에 서버 시각이 오면 이르더라도 서버 값.
    const g = fresh();
    g.recordBlocked('claude', { kind: 'usage' });
    eq('시각 모르는 사용량 소진은 한 시간 뒤에 다시 본다', g.blockedUntil('claude') - nowSec(), REPROBE_SEC);
    g.recordBlocked('claude', { kind: 'usage', until: nowSec() + 900 });
    eq('짐작보다 서버 시각이 이긴다', g.blockedUntil('claude'), nowSec() + 900);

    // 갈래가 달라도 서버가 준 사용량 시각이 남아 있으면 그대로.
    const x = fresh();
    x.recordBlocked('claude', { kind: 'usage', until: nowSec() + 7200 });
    x.recordBlocked('claude', { kind: 'overload' });
    eq('남은 사용량 시각을 과부하가 앞당기지 않는다', x.blocked('claude').kind, 'usage');
    eq('남은 사용량 시각 그대로', x.blockedUntil('claude'), nowSec() + 7200);
  }

  // ---------- 과부하 — 10 → 20 → 40 → 60 → 60분 · 되면 처음으로 ----------
  {
    const s = fresh();
    const waits = [];
    for (let i = 0; i < 5; i++) {
      const b = s.recordBlocked('claude', { kind: 'overload' });
      waits.push((b.until - nowSec()) / 60);
      nowMs = b.until * 1000 + 60_000; // 다시 해 보는 때 — 또 과부하
    }
    eq('과부하 대기가 두 배씩 늘다 60분에서 멈춘다', waits, [10, 20, 40, 60, 60]);
    eq('과부하는 5시간을 안 든다', waits.every((w) => w <= 60), true);
    s.recordOk('claude');
    const b = s.recordBlocked('claude', { kind: 'overload' });
    eq('한 번 되면 과부하가 처음(10분)으로', (b.until - nowSec()) / 60, 10);
    eq('첫 과부하 대기 상수', OVERLOAD_FIRST_SEC, 600);
    nowMs = T0;
  }

  // ---------- auth · unknown — 60분 ----------
  {
    const s = fresh();
    eq('unknown 은 60분 뒤', s.recordBlocked('codex', { kind: 'unknown' }).until - nowSec(), 3600);
    eq('auth 는 60분 뒤', s.recordBlocked('agy-claude', { kind: 'auth' }).until - nowSec(), 3600);
    eq('시각을 모른다고 적는다', s.blocked('codex').untilKnown, false);
  }

  // ---------- 가장 이른 회복 시각 ----------
  {
    const s = fresh();
    eq('막힌 것이 없으면 없다', s.nextRecoveryAt(), null);
    s.recordBlocked('claude', { kind: 'usage', until: nowSec() + 7200 });
    s.recordBlocked('codex', { kind: 'unknown' });
    s.recordBlocked('agy-gemini', { kind: 'usage', until: nowSec() - 10 });
    eq('가장 이른 「아직 안 온」 시각', s.nextRecoveryAt(), nowSec() + 3600);
    eq('지난 막힘은 안 센다', s.isBlocked('agy-gemini'), false);
    eq('시각을 주면 그때 기준', s.nextRecoveryAt(nowSec() + 3601), nowSec() + 7200);
  }

  // ---------- 옛 파일에서 한 번 옮겨 오기 ----------
  {
    const file = path.join(TMP, 'mig.json');
    const legacy = path.join(TMP, 'mig-legacy.json');
    const U = nowSec() + 900;
    fs.writeFileSync(legacy, JSON.stringify({ until: U }));
    const s = new EngineState({ file, legacyFile: legacy, now: clock });
    eq('옛 until 을 Claude 사용량 소진으로 옮긴다', s.blocked('claude')?.kind, 'usage');
    eq('옛 until 그대로', s.blockedUntil('claude'), U);
    eq('옮기면서 상태 파일을 만든다', fs.existsSync(file), true);
    eq('옛 파일은 그대로 둔다', JSON.parse(fs.readFileSync(legacy, 'utf-8')).until, U);
    fs.writeFileSync(legacy, JSON.stringify({ until: U + 9999 }));
    eq('한 번만 옮긴다 — 뒤에 옛 파일이 바뀌어도 안 따라간다', s.blockedUntil('claude'), U);

    const file2 = path.join(TMP, 'mig2.json');
    const legacy2 = path.join(TMP, 'mig2-legacy.json');
    fs.writeFileSync(legacy2, JSON.stringify({ until: nowSec() - 60 }));
    const s2 = new EngineState({ file: file2, legacyFile: legacy2, now: clock });
    eq('지난 until 은 안 옮긴다', s2.blocked('claude'), null);
    eq('옮길 것이 없으면 파일을 안 만든다', fs.existsSync(file2), false);

    const bad = path.join(TMP, 'bad.json');
    fs.writeFileSync(bad, '{깨진');
    const s3 = new EngineState({ file: bad, legacyFile: legacy, now: clock });
    eq('깨진 파일은 빈 상태로 본다(안 던짐)', s3.isBlocked('claude'), false);
  }

  // ---------- 쓴 횟수 — 5시간 창 ----------
  {
    const s = fresh();
    const t0 = nowMs;
    for (const hr of [0, 1, 4]) { nowMs = t0 + hr * 3600_000; s.noteUse('agy-gemini'); }
    nowMs = t0 + 5 * 3600_000 + 1000;
    eq('5시간 창 밖은 안 센다', s.usesInWindow('agy-gemini'), 2);
    s.noteUse('agy-gemini');
    eq('적을 때 창 밖을 버린다', s.load().engines['agy-gemini'].uses.length, 3);
    eq('창을 좁히면 그만큼만', s.usesInWindow('agy-gemini', 3600), 1);
    nowMs = t0;
  }

  // ---------- 판정 — 실제로 온 글 ----------
  {
    const rej = { type: 'rate_limit_event', rate_limit_info: {
      status: 'rejected', rateLimitType: 'five_hour', resetsAt: SESSION_RESETS_AT, overageStatus: 'rejected' } };
    eq('거절 이벤트는 사용량 소진 · 서버 시각', classifyClaudeEvent(rej).block,
       { kind: 'usage', until: SESSION_RESETS_AT, limitType: 'five_hour' });
    const allowed = { type: 'rate_limit_event', rate_limit_info: {
      status: 'allowed', rateLimitType: 'five_hour', utilization: 0.42, overageStatus: 'rejected' } };
    eq('허용은 막힘이 아니다', classifyClaudeEvent(allowed).block, null);
    eq('허용이 실어 온 사용률', classifyClaudeEvent(allowed).util, { limitType: 'five_hour', utilization: 0.42 });
    eq('경고 단계도 막힘이 아니다', classifyClaudeEvent({ rate_limit_info: { status: 'allowed_warning' } }).block, null);

    const at = Date.parse('2026-08-31T07:04:52Z'); // 그 거절이 온 시각
    eq('「4:10pm (Asia/Seoul)」 = 같은 차례의 resetsAt', classifyClaudeErrorText(LOG.session, at),
       { kind: 'usage', until: SESSION_RESETS_AT });
    eq('SDK 가 감싼 글도 같다', classifyClaudeErrorText(LOG.sessionWrapped, at),
       { kind: 'usage', until: SESSION_RESETS_AT });
    eq('「1pm」 — 오늘 13:00 KST', classifyClaudeErrorText(LOG.plain, nowMs),
       { kind: 'usage', until: Date.UTC(2026, 9, 14, 4, 0) / 1000 });
    eq('「Oct 5, 10am」 — 그 날짜', classifyClaudeErrorText(LOG.weekly, Date.parse('2026-10-01T00:00:00Z')),
       { kind: 'usage', until: Date.UTC(2026, 9, 5, 1, 0) / 1000 });
    eq('「2:40am」 — 이미 지났으면 다음 날', classifyClaudeErrorText(LOG.night, Date.UTC(2026, 9, 14, 14, 0)),
       { kind: 'usage', until: Date.UTC(2026, 9, 14, 17, 40) / 1000 });
    eq('529 Overloaded 는 과부하(시각은 상태가 정함)', classifyClaudeErrorText(LOG.overload), { kind: 'overload' });
    eq('감싼 과부하도 과부하', classifyClaudeErrorText(LOG.overloadWrapped), { kind: 'overload' });
    eq('429 rate_limit_error 는 사용량(시각 모름)', classifyClaudeErrorText(LOG.rate429), { kind: 'usage' });
    for (const plain of ['ENOENT: no such file or directory', 'aborted', 'CLI process exited with code 1', '']) {
      eq(`평범한 오류는 막힘이 아니다 — ${plain || '(빈 글)'}`, classifyClaudeErrorText(plain), null);
    }
  }

  // ---------- 전송 탭 — 소스 배선 ----------
  {
    for (const f of ['sdk-handler.ts', 'cli-handler.ts']) {
      const src = fs.readFileSync(path.join(SRC, f), 'utf-8').replace(/\r\n/g, '\n');
      const at = src.indexOf('async *[Symbol.asyncIterator]()');
      ok(`${f}: 이벤트를 내보내는 곳을 못 찾았다`, at >= 0);
      const body = src.slice(at, src.indexOf('\n  }\n', at));
      ok(`${f}: 흐름마다 탭을 만든다`, body.includes('new ClaudeTap()'));
      const yields = [...body.matchAll(/yield ([^;]+);/g)];
      ok(`${f}: 내보내는 곳이 없다`, yields.length > 0);
      for (const y of yields) {
        const before = body.slice(Math.max(0, y.index - 160), y.index);
        ok(`${f}: 「yield ${y[1]}」 앞에 탭이 없다 — 이 이벤트는 엔진 상태에 안 적힌다`,
           before.includes(`tap.see(${y[1]});`));
      }
    }
  }

  // ---------- 전송 탭 — 동작 ----------
  {
    const s = fresh();
    const tap = new ClaudeTap(s);
    tap.see({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: nowSec() + 4000, rateLimitType: 'five_hour' } });
    eq('탭: 거절 이벤트 → 막힘', s.isBlocked('claude'), true);
    eq('탭: 서버 시각', s.blockedUntil('claude'), nowSec() + 4000);
    // 거절 뒤에도 `subtype: success` + `is_error: true` 결과가 온다(실측) — 「됐다」가 아니다.
    tap.see({ type: 'result', subtype: 'success', is_error: true, result: LOG.session });
    tap.see({ type: 'result', subtype: 'success', is_error: false, result: '' });
    eq('탭: 막힌 흐름의 결과가 막힘을 안 지운다', s.isBlocked('claude'), true);
    new ClaudeTap(s).see({ type: 'result', subtype: 'success', is_error: false, result: '답' });
    eq('탭: 다음 차례가 되면 지운다', s.isBlocked('claude'), false);

    // 과부하 한 번 = 결과 둘(세션 결과 + SDK 가 감싼 것) — 한 단계로만 센다.
    const o = fresh();
    const t2 = new ClaudeTap(o);
    t2.see({ type: 'result', subtype: 'success', is_error: true, result: LOG.overload });
    t2.see({ type: 'result', subtype: 'error', is_error: true, result: LOG.overloadWrapped });
    eq('탭: 과부하 한 번은 10분', o.blockedUntil('claude') - nowSec(), 600);
    eq('탭: 평범한 오류는 안 적는다', (() => {
      const p = fresh(); new ClaudeTap(p).see({ type: 'result', is_error: true, result: 'aborted' }); return p.blocked('claude');
    })(), null);
    const u = fresh();
    new ClaudeTap(u).see({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'seven_day', utilization: 0.7 } });
    eq('탭: 사용률을 적는다', u.load().engines.claude.util?.seven_day, 0.7);

    let threw = null;
    const boom = { recordBlocked() { throw new Error('x'); }, recordOk() { throw new Error('x'); }, recordUtil() { throw new Error('x'); } };
    const warnSaved = console.warn; console.warn = () => {};
    try {
      const b = new ClaudeTap(boom);
      b.see({ type: 'result', is_error: false });
      b.see({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', utilization: 1, rateLimitType: 'five_hour' } });
    } catch (e) { threw = e; } finally { console.warn = warnSaved; }
    eq('탭: 적기가 터져도 안 던진다', threw, null);

    // 실제 두 길 — 봇 전체가 쓰는 하나(임시 자리)에 적히나.
    const RESET = Math.floor(Date.now() / 1000) + 5400;
    const fakeQuery = (async function* () {
      yield { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: RESET, rateLimitType: 'five_hour' }, session_id: 's' };
      yield { type: 'result', subtype: 'success', is_error: true, result: LOG.session, session_id: 's' };
    })();
    for await (const _ of new SdkProcess(fakeQuery, new AbortController())) { /* 다 읽는다 */ }
    eq('SDK 길: 거절 이벤트가 엔진 상태에 적힌다', engineState.blockedUntil('claude'), RESET);
    engineState.recordOk('claude');

    const proc = new EventEmitter();
    proc.stdout = new PassThrough();
    proc.stderr = new PassThrough();
    proc.kill = () => {};
    const cli = new CliProcess(proc);
    proc.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: LOG.overload }) + '\n');
    setTimeout(() => proc.emit('exit', 0, null), 20);
    for await (const _ of cli) { /* 다 읽는다 */ }
    eq('CLI 길: 과부하 결과가 엔진 상태에 적힌다', engineState.blocked('claude')?.kind, 'overload');
    engineState.recordOk('claude');
    eq('봇 전체가 쓰는 하나가 임시 자리에 썼다', fs.existsSync(process.env.ENGINE_STATE_FILE), true);
  }

  // ---------- 과부하에 5시간이 안 붙는다 — 한도 안내가 쓰는 시각 ----------
  {
    const s = fresh();
    const b = currentClaudeBlock(undefined, LOG.overloadWrapped, s);
    eq('한도 안내: 과부하면 10분', b.until - nowSec(), 600);
    const again = currentClaudeBlock(undefined, LOG.overloadWrapped, s);
    eq('한도 안내: 탭이 이미 적은 막힘은 다시 안 센다', again.until - nowSec(), 600);
    const r = fresh();
    eq('한도 안내: 거절 이벤트 시각', currentClaudeBlock(nowSec() + 1234, '', r).until, nowSec() + 1234);
    const q = fresh();
    eq('한도 안내: 못 가르면 한 시간', currentClaudeBlock(undefined, 'too many things', q).until - nowSec(), 3600);
    const sh = fs.readFileSync(path.join(SRC, 'slack-handler.ts'), 'utf-8');
    // 셋째 자리는 DM 폴백(엔진 폴백 5단계) — 넘길 때 표시 줄 · 한도 안내가 같은 막힘을 쓴다.
    eq('한도 안내 두 자리 · DM 폴백 한 자리가 엔진 상태에서 시각을 받는다', (sh.match(/currentClaudeBlock\(/g) ?? []).length, 3);
    ok('5시간 기본값이 남았다(parseRetryAfterSeconds)', !/parseRetryAfterSeconds|5 \* 60 \* 60/.test(sh));
    // 던진 오류 — 슬랙의 빈도 제한은 Claude 막힘이 아니다(글에 「rate-limit」이 있어도)
    const sl = fresh();
    const slackErr = Object.assign(new Error('A rate-limit has been reached, you may retry this request in 30 seconds'),
      { code: 'slack_webapi_rate_limited_error' });
    eq('던진 오류: 슬랙 빈도 제한은 막힘으로 안 적는다', thrownClaudeBlock(slackErr, sl), null);
    eq('던진 오류: 슬랙 빈도 제한 뒤에도 Claude 는 안 막힘', sl.isBlocked('claude'), false);
    const ov = fresh();
    eq('던진 오류: Claude 과부하 글은 과부하로 적는다', thrownClaudeBlock(new Error(LOG.overloadWrapped), ov)?.kind, 'overload');
    const un = fresh();
    eq('던진 오류: 한도·과부하 글이 아니면 막힘 없음', thrownClaudeBlock(new Error('ECONNRESET socket hang up'), un), null);
    ok('한도 안내 열쇠는 막힘이 시작된 시각 — 과부하가 늘어도 안내가 다시 안 나간다',
      /noticeOnce\(`claude:\$\{block\.kind\}:\$\{block\.since\}`\)/.test(sh));
  }

  // ---------- 한도 안내는 구간마다 한 번 ----------
  {
    const file = path.join(TMP, 'notice.json');
    const a = new EngineState({ file, legacyFile: path.join(TMP, 'none-n.json'), now: clock });
    eq('처음 막힘은 안내한다', a.noticeOnce('claude:usage:100'), true);
    eq('같은 막힘은 다시 안 한다', a.noticeOnce('claude:usage:100'), false);
    const b = new EngineState({ file, legacyFile: path.join(TMP, 'none-n.json'), now: clock });
    eq('재시작해도 같은 막힘은 다시 안 한다', b.noticeOnce('claude:usage:100'), false);
    eq('풀리는 시각이 바뀌면 다시 안내한다', b.noticeOnce('claude:usage:200'), true);
    b.clearNotice();
    eq('지우면 같은 키도 다시 안내한다', b.noticeOnce('claude:usage:200'), true);
    const sh = fs.readFileSync(path.join(SRC, 'slack-handler.ts'), 'utf-8');
    ok('한도 안내가 엔진 상태의 키로 한 번만 올리지 않는다',
       sh.includes('engineState.noticeOnce(`claude:${block.kind}:${block.since}`)'));
    ok('죽은 깃발(limitNoticed)이 남았다', !sh.includes('limitNoticed'));
  }

  // ---------- 회복 타이머 — 기동 때 파일에서 다시 건다 ----------
  {
    const file = path.join(TMP, 'rec.json');
    const s = new EngineState({ file, legacyFile: path.join(TMP, 'none-r.json'), now: clock });
    const U = nowSec() + 7200;
    s.recordBlocked('claude', { kind: 'usage', until: U });
    s.noticeOnce(`claude:usage:${U}`);

    // 재시작 — 새 인스턴스가 같은 파일을 읽는다.
    const s2 = new EngineState({ file, legacyFile: path.join(TMP, 'none-r.json'), now: clock });
    const timers = [];
    const cleared = [];
    const recovered = [];
    const r = new EngineRecovery({
      store: s2, now: clock,
      onRecover: (why) => { recovered.push(why); },
      setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
      clearTimer: (h) => { cleared.push(h); },
    });
    r.init();
    eq('기동: 회복 시각 + 1분에 건다', r.armedFor, U * 1000 + RECOVERY_SLACK_MS);
    eq('기동: 그만큼 잔다', timers.at(-1)?.ms, U * 1000 + RECOVERY_SLACK_MS - nowMs);

    s2.recordBlocked('codex', { kind: 'unknown' });
    eq('막힘이 바뀌면 다시 건다 — 더 이른 쪽', r.armedFor, (nowSec() + 3600) * 1000 + RECOVERY_SLACK_MS);
    eq('앞 타이머는 거둔다', cleared.length >= 1, true);

    nowMs = (nowSec() + 3600) * 1000 + RECOVERY_SLACK_MS;
    timers.at(-1).fn();
    eq('깨어나면 드레인을 부른다', recovered, ['한도 회복']);
    // codex 만 깨어나고 Claude 는 아직 막힘 — 같은 막힘 구간이라 안내 열쇠를 남긴다(4단계 검토)
    eq('다른 엔진만 깨면 Claude 한도 안내 키는 남긴다', s2.load().notice?.key, `claude:usage:${U}`);
    {
      const s3 = new EngineState({ file: path.join(TMP, 'notice-clear.json'), legacyFile: path.join(TMP, 'none-c.json'), now: clock });
      s3.recordBlocked('claude', { kind: 'usage', until: nowSec() + 60 });
      s3.noticeOnce('claude:usage:x');
      const t3 = [];
      const r3 = new EngineRecovery({ store: s3, now: clock, onRecover: () => {},
        setTimer: (fn, ms) => { t3.push({ fn, ms }); return t3.length; }, clearTimer: () => {} });
      r3.init();
      nowMs = (nowSec() + 120) * 1000 + RECOVERY_SLACK_MS;
      t3.at(-1).fn();
      eq('Claude 가 풀려 깨어나면 한도 안내 키를 비운다', s3.load().notice, null);
    }
    eq('깨어난 뒤 남은 막힘으로 다시 건다', r.armedFor, U * 1000 + RECOVERY_SLACK_MS);

    // 회복 시각 전에 풀림(어느 차례가 됨) — 1분 뒤에 돌린다.
    s2.recordOk('claude');
    eq('일찍 풀리면 1분 뒤에 돌린다', r.armedFor, nowMs + RECOVERY_SLACK_MS);
    nowMs += RECOVERY_SLACK_MS;
    timers.at(-1).fn();
    eq('일찍 풀린 뒤에도 드레인', recovered.length, 2);
    eq('기다릴 것이 없으면 안 건다', r.armedFor, null);
    r.stop();
    nowMs = T0;

    const sh = fs.readFileSync(path.join(SRC, 'slack-handler.ts'), 'utf-8').replace(/\r\n/g, '\n');
    const boot = sh.match(/setTimeout\([\s\S]{0,300}?drainStuck\('기동'\)[\s\S]{0,160}?\d[\d_]*\);/);
    ok('기동 드레인을 예약하는 줄이 없다', Boolean(boot));
    ok('기동 드레인 뒤에 엔진 감시를 안 켠다', Boolean(boot) && /drainStuck\('기동'\)[\s\S]*startEngineWatch\(\)/.test(boot[0]));
    const watch = sh.slice(sh.indexOf('private startEngineWatch'), sh.indexOf('\n  }\n', sh.indexOf('private startEngineWatch')));
    ok('엔진 감시가 회복 타이머를 파일에서 안 건다', watch.includes('this.engineRecovery.init()'));
  }

  // ---------- 엔진 안내 — 문구는 표에서 ----------
  {
    const writeTable = (codexId, agyClaude, gemini) => fs.writeFileSync(process.env.LLM_PLAYBOOK_MODELS, JSON.stringify({
      claude: { aliases: { opus: 'x' } },
      codex: { models: { astra: { id: codexId }, 'astra-mini': { id: 'wrong-mini' }, sol: { id: 'wrong-sol' } } },
      agy: { models: { 'flash-high': gemini, 'sonnet-thinking': agyClaude, 'opus-thinking': 'wrong-opus', 'flash-low': 'wrong-low' } },
      tiers: { top: { claude: 'opus', codex: 'astra-high', agy: 'flash-high' } },
    }));
    writeTable('gpt-T1-astra', 'Claude Sonnet T1 (High)', 'Gemini T1 Flash (High)');
    eq('표에서 이름 셋을 읽는다', loadModelLabels(),
       { codex: 'gpt-T1-astra', agyClaude: 'Claude Sonnet T1 (High)', gemini: 'Gemini T1 Flash (High)' });
    eq('표를 못 읽으면 판 없는 빈 이름', loadModelLabels(path.join(TMP, 'no-table.json')),
       { codex: '', agyClaude: '', gemini: '' });
    eq('한국 시각 · 요일', formatKst(Date.UTC(2026, 9, 19, 1, 0) / 1000), '10/19(월) 10:00');

    const s = fresh();
    const U = Date.UTC(2026, 9, 19, 1, 0) / 1000; // 10/19(월) 10:00 KST
    const L = loadModelLabels();
    eq('평소 차례는 Claude', dmRung(s.load(), nowSec()), 'claude');
    s.recordBlocked('claude', { kind: 'usage', until: U });
    eq('Claude 가 막히면 GPT 차례', dmRung(s.load(), nowSec()), 'codex');
    eq('Claude 소진 → GPT',
       composeTransition('claude', 'codex', s.load(), L, nowSec()),
       '🔁 Claude 사용량 소진(풀림 10/19(월) 10:00) — GPT(gpt-T1-astra)로 이어 갑니다');
    s.recordBlocked('codex', { kind: 'usage', until: U + 3600 });
    // 6단계 순서(2026-10-14 사용자 결정) — Gemini 먼저, 그다음 agy 의 Claude Sonnet. 「같은 모델」이라고 안 쓴다.
    eq('Claude·GPT 소진 → Gemini',
       composeTransition('codex', 'agy-gemini', s.load(), L, nowSec()),
       '🔁 Claude·GPT 사용량 소진 — Gemini T1 Flash (High)로 이어 갑니다 · 답이 느리고 업무 조회·등록·수정까지'
       + ' · 지시문이 달라 답이 다를 수 있습니다');
    eq('Claude·GPT 가 막히면 Gemini 차례', dmRung(s.load(), nowSec()), 'agy-gemini');
    s.recordBlocked('agy-gemini', { kind: 'usage', until: U + 7200 });
    eq('Gemini 도 소진 → agy Sonnet',
       composeTransition('agy-gemini', 'agy-claude', s.load(), L, nowSec()),
       '🔁 Claude·GPT·Gemini 소진 — agy 의 Claude Sonnet T1 (High)로 이어 갑니다 · 업무 조회·등록·수정까지'
       + ' · 지시문이 달라 답이 다를 수 있습니다');
    ok('안내에 「같은 모델」이 없다', !fs.readFileSync(path.join(SRC, 'engine-notice.ts'), 'utf-8').includes('같은 모델'));
    s.recordBlocked('agy-claude', { kind: 'unknown' }); // 지금 + 60분 = 10/14(수) 11:00 이 가장 빠르다
    eq('다 막히면 없음', dmRung(s.load(), nowSec()), 'none');
    eq('모두 소진 → 모아 두기',
       composeTransition('agy-claude', 'none', s.load(), L, nowSec()),
       '⏸ 모든 엔진 소진 — 받은 말은 모아 두고 가장 빠른 회복(10/14(수) 11:00)에 차례대로 처리합니다'
       + ' · 다시 보내지 않으셔도 됩니다');
    eq('Claude 회복', composeTransition('none', 'claude', s.load(), L, nowSec()), '✅ Claude 회복 — 돌아왔습니다');
    eq('차례가 같으면 안내 없음', composeTransition('codex', 'codex', s.load(), L, nowSec()), null);

    const o = fresh();
    o.recordBlocked('claude', { kind: 'overload' });
    eq('과부하는 「서버 과부하 · 다시 확인」',
       composeTransition('claude', 'codex', o.load(), L, nowSec()),
       '🔁 Claude 서버 과부하(다시 확인 10/14(수) 10:10) — GPT(gpt-T1-astra)로 이어 갑니다');

    // 표를 바꾸면 다음 안내부터 따라온다 — 글자로 박았으면 여기서 걸린다.
    writeTable('gpt-T2-zeta', 'Claude Sonnet T2 (High)', 'Gemini T2 Flash (High)');
    const L2 = loadModelLabels();
    const swapped = [
      composeTransition('claude', 'codex', s.load(), L2, nowSec()),
      composeTransition('codex', 'agy-gemini', s.load(), L2, nowSec()),
      composeTransition('agy-gemini', 'agy-claude', s.load(), L2, nowSec()),
    ].join('\n');
    ok('표를 바꿔도 GPT 모델 이름이 안 따라온다', swapped.includes('GPT(gpt-T2-zeta)') && !swapped.includes('T1'));
    ok('표를 바꿔도 agy Claude 이름이 안 따라온다', swapped.includes('Claude Sonnet T2 (High)'));
    ok('표를 바꿔도 Gemini 이름이 안 따라온다', swapped.includes('Gemini T2 Flash (High)'));
    const notice = fs.readFileSync(path.join(SRC, 'engine-notice.ts'), 'utf-8');
    ok('안내 문구에 모델 판 번호가 박혀 있다', !/gpt-\d|Opus \d|Flash \(|Gemini \d/.test(notice));

    // 꺼짐(기본) — 보내지 않고 로그만 · 같은 차례는 한 번 · 재시작해도 안 되풀이.
    const file = path.join(TMP, 'notice-ladder.json');
    const st = new EngineState({ file, legacyFile: path.join(TMP, 'none-l.json'), now: clock });
    st.recordBlocked('claude', { kind: 'usage', until: U });
    const posts = [];
    const logs = [];
    const log = { info: (m, d) => logs.push(d?.line ?? m), warn: (m, d) => logs.push(`WARN ${m} ${JSON.stringify(d)}`) };
    // `.env` 에 켜 두었으면 dist 를 부를 때 dotenv 가 다시 채운다 — 재기 직전에 지운다.
    delete process.env.ENGINE_NOTICE;
    eq('기본은 꺼짐', new EngineNotice({ store: st }).enabled, false);
    process.env.ENGINE_NOTICE = 'on';
    eq('ENGINE_NOTICE=on 이면 켜짐', new EngineNotice({ store: st }).enabled, true);
    delete process.env.ENGINE_NOTICE;
    const off = new EngineNotice({ store: st, post: async (t) => { posts.push(t); }, log });
    const line = await off.check();
    eq('꺼짐: 지은 줄을 돌려준다', line, '🔁 Claude 사용량 소진(풀림 10/19(월) 10:00) — GPT(gpt-T2-zeta)로 이어 갑니다');
    eq('꺼짐: 안 보낸다', posts, []);
    eq('꺼짐: 로그에만 남긴다', logs, [line]);
    eq('같은 차례는 다시 안 짓는다', await off.check(), null);
    const restarted = new EngineNotice({ store: new EngineState({ file, legacyFile: path.join(TMP, 'none-l.json'), now: clock }), post: async (t) => { posts.push(t); }, log });
    eq('재시작해도 같은 안내를 되풀이하지 않는다', await restarted.check(), null);
    const on = new EngineNotice({ store: st, post: async (t) => { posts.push(t); }, log, enabled: () => true });
    on.init();
    st.recordOk('claude');
    await new Promise((r) => setImmediate(r));
    eq('켜짐: 회복을 한 줄 보낸다', posts, ['✅ Claude 회복 — 돌아왔습니다']);
    on.stop();

    // 막힘 시각이 지난 것만으로는 「회복」을 안 보낸다(2026-10-15 검토) — 된 차례(`recordOk`)가 막힘을 지울 때 한 번.
    {
      const s4 = new EngineState({ file: path.join(TMP, 'notice-expiry.json'), legacyFile: path.join(TMP, 'none-x.json'), now: clock });
      const p4 = [];
      const n4 = new EngineNotice({ store: s4, ladder: () => ['claude', 'codex'], enabled: () => true,
        labels: () => ({ codex: 'gpt-x', agyClaude: '', gemini: '' }), post: async (t) => { p4.push(t); },
        log: { info() {}, warn() {} } });
      s4.recordBlocked('claude', { kind: 'usage', until: nowSec() + 60 });
      await n4.check();
      nowMs += 120_000;
      eq('막힘 시각만 지나면 회복 안내 없음', await n4.check(), null);
      eq('막힘 시각만 지나면 차례도 안 적음(된 뒤에 다시 봄)', s4.ladderRung(), 'codex');
      s4.recordBlocked('claude', { kind: 'usage', until: nowSec() + 600 });
      eq('되기 전에 다시 막히면 아무 줄도 없음', await n4.check(), null);
      nowMs += 700_000;
      s4.recordOk('claude');
      eq('된 뒤에 회복 한 줄', await n4.check(), '✅ Claude 회복 — 돌아왔습니다');
      eq('같은 회복은 다시 안 냄', await n4.check(), null);
      eq('보낸 것 — GPT 로 넘김 · 회복 하나', p4.length, 2);
      nowMs = T0;
    }

    // 한 차례가 사다리를 여러 칸 내려가면 실제로 답한 엔진 한 줄만(2026-10-16 · 사용자 결정) — `hold` 동안은 미루고
    // 차례도 안 적는다 · 놓을 때 한 번 · 놓지 못해도 상한에 스스로 놓는다 · 차례 밖의 변화는 바로 나간다.
    {
      const s5 = new EngineState({ file: path.join(TMP, 'notice-hold.json'), legacyFile: path.join(TMP, 'none-h.json'), now: clock });
      const p5 = [];
      const n5 = new EngineNotice({ store: s5, ladder: () => ['claude', 'codex', 'agy-gemini', 'agy-claude'], enabled: () => true,
        labels: () => ({ codex: 'gpt-h', agyClaude: 'Sonnet H', gemini: 'Flash H' }), post: async (t) => { p5.push(t); },
        log: { info() {}, warn() {} } });
      n5.init();
      s5.recordBlocked('claude', { kind: 'usage', until: nowSec() + 3600 });
      await new Promise((r) => setImmediate(r));
      eq('차례 밖 — 막힘은 바로 한 줄', p5.length, 1);
      const release = n5.hold();
      s5.recordBlocked('codex', { kind: 'usage', until: nowSec() + 3600 });
      s5.recordBlocked('agy-gemini', { kind: 'usage', until: nowSec() + 3600 });
      await new Promise((r) => setImmediate(r));
      eq('미루는 동안 — 안 보냄 · 차례도 안 적음', [p5.length, s5.ladderRung()], [1, 'codex']);
      eq('미루는 동안 — 지금 차례는 agy Claude', n5.rungNow(), 'agy-claude');
      const second = n5.hold();
      release();
      await new Promise((r) => setImmediate(r));
      eq('다른 차례가 아직 내려가는 중이면 계속 미룸', p5.length, 1);
      second();
      second();
      await new Promise((r) => setImmediate(r));
      eq('마지막을 놓으면 한 줄 — 사이 칸(Gemini) 없이 실제로 맡는 엔진', p5.slice(1),
        ['🔁 Claude·GPT·Gemini 소진 — agy 의 Sonnet H로 이어 갑니다 · 업무 조회·등록·수정까지 · 지시문이 달라 답이 다를 수 있습니다']);
      eq('놓은 뒤 차례를 적음', s5.ladderRung(), 'agy-claude');
      // 끝까지 다 막혀 모아 둠 — ⏸ 한 줄 · 놓지 못하고 넘어진 차례도 상한에 스스로 놓는다
      const leaked = n5.hold(30);
      s5.recordBlocked('agy-claude', { kind: 'usage', until: nowSec() + 3600 });
      await new Promise((r) => setImmediate(r));
      eq('미루는 동안 — ⏸ 도 안 보냄 · 지금 차례는 none', [p5.length, n5.rungNow()], [2, 'none']);
      await new Promise((r) => setTimeout(r, 80));
      ok(`놓지 못해도 상한에 ⏸ 한 줄 — ${p5[2]}`, p5.length === 3 && (p5[2] ?? '').startsWith('⏸ 모든 엔진 소진'));
      leaked();
      await new Promise((r) => setImmediate(r));
      eq('상한에 풀린 것을 늦게 놓아도 다시 안 보냄', p5.length, 3);
      // 차례 밖 — 회복은 바로
      s5.recordOk('claude');
      await new Promise((r) => setImmediate(r));
      eq('차례 밖 — 회복은 바로 한 줄', p5.slice(3), ['✅ Claude 회복 — 돌아왔습니다']);
      n5.stop();
    }
  }

  // ---------- 공개 저장소 — 상태 파일은 안 올린다 ----------
  {
    const gi = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf-8');
    ok('.gitignore 에 .engine-state.json 이 없다', /^\.engine-state\.json/m.test(gi));
    ok('.gitignore 에 .engine-drill.json 이 없다', /^\.engine-drill\.json/m.test(gi));
    eq('운영 상태 파일을 안 건드렸다', prodStamp(), prodBefore);
  }
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

if (fails.length) {
  console.error(`실패 ${fails.length}건\n`);
  for (const f of fails) console.error('  ✗ ' + f);
  process.exitCode = 1;
} else {
  console.log('통과 — 엔진 상태 (사용량 시각 · 앞당기지 않음 · 됐으면 지움 · 과부하 10→60분 · 60분 다시 봄'
    + ' · 가장 이른 회복 · 옛 파일 한 번 옮김 · 5시간 창 · 실제 문구 판정 · 탭 배선·동작 · 과부하에 5시간 없음'
    + ' · 안내 한 번 · 기동 때 다시 걺 · 안내 문구는 표에서 · 꺼짐은 로그만 · 회복 안내는 된 뒤에 · 차례 안에서는 미뤘다 한 줄)');
}
