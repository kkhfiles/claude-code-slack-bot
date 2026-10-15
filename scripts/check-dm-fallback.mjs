/**
 * DM 폴백(엔진 폴백 5단계) — Claude 가 막히면 같은 DM 차례를 GPT(codex)가 **이어 받나 · 안 넘길 것은 안 넘기나**.
 *
 *   npm run check:dmfallback
 *
 * 슬랙도 Claude 도 진짜 codex 도 안 부른다. 고르는 함수(`pickEngine`)는 모든 조합을 그대로 돌리고, 대화 처리기는
 * **`dist` 의 진짜 `handleMessage`** 를 껍데기(`Object.create`)에 얹어 돌린다 — Claude 는 SDK 의 `query` 를 바꿔
 * 끼운 진짜 `SdkHandler`(연습 주입도 그 안에서 돈다), codex 는 가짜 실행체(`lib/fake-codex.mjs`)다.
 * 파이썬을 부르는 다리(`work-assistant.js`의 캡처 · 실패 표시 · 버림)만 가짜로 바꿔 부른 것을 적는다.
 *
 * **왜 기계로 세나** — 이 길은 Claude 가 바닥나는 날에만 돈다. 그리고 틀려도 조용하다: 한도 글이 그대로 나가거나,
 * GPT 가 답했는데 실패로 적혀 같은 일이 두 번 돌거나, 개인 글이 밖으로 나가도 오류도 로그도 없다.
 *
 * 상태 파일은 전부 임시 폴더로 옮긴다(엔진 상태 · 장부 · 처리 중 기록 · 연습 파일 · 홈) — 운영 파일을 안 건드린다.
 */
import './lib/fresh-dist.mjs';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeFakeCodex } from './lib/fake-codex.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-fallback-'));
const WA_ROOT = path.join(TMP, 'wa-root');
fs.mkdirSync(WA_ROOT, { recursive: true });
fs.mkdirSync(path.join(TMP, 'home'), { recursive: true });
const ENV = {
  ENGINE_STATE_FILE: path.join(TMP, 'engine-state.json'),
  RATE_LIMIT_UNTIL_FILE: path.join(TMP, 'rate-limit-until.json'),
  HELD_FILES_DIR: path.join(TMP, 'held'),
  WORK_ASSISTANT_HOME: path.join(TMP, 'wa-home'),
  WORK_EVENTS_FILE: path.join(TMP, 'events.jsonl'),
  INFLIGHT_SESSIONS_FILE: path.join(TMP, 'inflight.json'),
  FALLBACK_LEDGER_FILE: path.join(TMP, 'ledger.jsonl'),
  ENGINE_DRILL_FILE: path.join(TMP, 'drill.json'),
  // 캡처 가리킴 파일(`~/.claude/state`)이 운영 홈에 안 생기게.
  USERPROFILE: path.join(TMP, 'home'),
  HOME: path.join(TMP, 'home'),
  // 한도 조회 · 등급 표는 없는 실행체로 — 빈손(모름)으로 물러난다.
  CODEX_QUOTA_PYTHON: 'python-없는-이름-2026',
  LADDER_PYTHON: 'python-없는-이름-2026',
  // 모델 표도 없는 자리로 — 서비스 폴백 대응표가 없을 때의 옛 길(기본 모델)을 잰다. 대응표 쪽은 `check:agy`.
  LLM_PLAYBOOK_MODELS: path.join(TMP, 'no-models.json'),
  SLACKBOT_SDK_ENABLED: 'all',
  SESSION_FALLBACK_CODEX_MODEL: 'gpt-test-sol',
};
const setEnv = () => { Object.assign(process.env, ENV); };
setEnv();
fs.mkdirSync(ENV.WORK_ASSISTANT_HOME, { recursive: true });

const fails = [];
const eq = (label, got, want) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    fails.push(`${label}\n    받음 ${JSON.stringify(got)}\n    기대 ${JSON.stringify(want)}`);
  }
};
const ok = (label, cond) => { if (!cond) fails.push(label); };

fs.mkdirSync(path.join(TMP, 'fake'), { recursive: true });
const fake = makeFakeCodex(path.join(TMP, 'fake'));
const { config } = require(path.join(ROOT, 'dist', 'config.js'));
setEnv();   // `.env` 가 같은 이름을 들고 와도 시험 값이 이긴다
process.env.BOARD_NARROW_CODEX_BIN = fake.bin;
// agy 칸(6단계)은 `check:agy` 가 잰다 — `.env` 가 켜 두었어도 여기서는 끈다(안 끄면 「GPT 다음은 모아 둠」이 agy 로 간다).
for (const k of ['DM_FALLBACK', 'DM_FALLBACK_AGY', 'ENGINE_NOTICE', 'HOLD_V2', 'SLACKBOT_FORCE_CLI']) delete process.env[k];

const ladder = require(path.join(ROOT, 'dist', 'engine-ladder.js'));
const dmf = require(path.join(ROOT, 'dist', 'dm-fallback.js'));
const drill = require(path.join(ROOT, 'dist', 'engine-drill.js'));
const wa = require(path.join(ROOT, 'dist', 'work-assistant.js'));
const pg = require(path.join(ROOT, 'dist', 'privacy-guard.js'));
const { engineState, EngineState } = require(path.join(ROOT, 'dist', 'engine-state.js'));
const { EngineNotice } = require(path.join(ROOT, 'dist', 'engine-notice.js'));
const { ChannelGate } = require(path.join(ROOT, 'dist', 'hold-replay.js'));
const { SdkHandler } = require(path.join(ROOT, 'dist', 'sdk-handler.js'));
const { CliProcess } = require(path.join(ROOT, 'dist', 'cli-handler.js'));
const { FileHandler } = require(path.join(ROOT, 'dist', 'file-handler.js'));
const { SlackHandler } = require(path.join(ROOT, 'dist', 'slack-handler.js'));

config.assistant.dmChannel = 'D_DM';
config.bot.allowUsers = ['U_ME'];
const nowSec = () => Math.floor(Date.now() / 1000);
const silent = { info() {}, warn() {}, error() {}, debug() {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const reset = () => {
  for (const f of [ENV.ENGINE_STATE_FILE, ENV.FALLBACK_LEDGER_FILE, ENV.ENGINE_DRILL_FILE, ENV.INFLIGHT_SESSIONS_FILE]) {
    fs.rmSync(f, { force: true });
  }
};
const blockClaude = () => engineState.recordBlocked('claude', { kind: 'usage', until: nowSec() + 3600 });
const blockCodex = () => engineState.recordBlocked('codex', { kind: 'usage', until: nowSec() + 7200 });
const writeDrill = (d) => fs.writeFileSync(ENV.ENGINE_DRILL_FILE, JSON.stringify(d), 'utf-8');

// ---------------------------------------------------------------- 파이썬 다리 가짜
const bridge = { captures: 0, failed: [], dropped: [] };
wa.isWorkAssistantEnabled = () => true;
wa.workAssistantRoot = () => WA_ROOT;
wa.captureToInbox = () => ({ id: `cap-${++bridge.captures}` });
wa.checkinMap = async () => '[체크인 번호표 — 시험]';
wa.quickUpdate = async () => ({ kind: 'not-quick' });
wa.markCaptureFailed = async (id, why, extra) => { bridge.failed.push([id, why, extra ?? null]); };
wa.dropCapture = async (id, why) => { bridge.dropped.push([id, why]); };
let privateTurn = false;
pg.containsPrivate = (t) => privateTurn && String(t).includes('비밀조각');

// ---------------------------------------------------------------- Claude 가짜(SDK 의 query 를 바꿔 끼움)
const SID = 'sess-1';
const ev = {
  init: { type: 'system', subtype: 'init', session_id: SID, tools: [] },
  text: (t) => ({ type: 'assistant', session_id: SID, message: { role: 'assistant', content: [{ type: 'text', text: t }] } }),
  tool: (id, cmd) => ({ type: 'assistant', session_id: SID,
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: cmd } }] } }),
  res: (id) => ({ type: 'user', session_id: SID, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } }),
  ok: (t = 'Claude 답') => ({ type: 'result', subtype: 'success', is_error: false, result: t, session_id: SID,
    total_cost_usd: 0, duration_ms: 1, permission_denials: [] }),
};
const CMD1 = 'python -X utf8 bin/tasks.py log --id TSK-1 --text 시작';
const CMD2 = 'python -X utf8 bin/tasks.py update --id TSK-1 --set 상태=진행';
const SCRIPTS = {
  ok: () => [ev.init, ev.text('Claude 답'), ev.ok()],
  limited: () => [ev.init, ev.text('확인해 보겠습니다'), ...drill.limitTail(SID)],
  'limited-after-write': () => [ev.init, ev.tool('t1', CMD1), ev.res('t1'), ev.tool('t2', CMD2), ...drill.limitTail(SID)],
  overload: () => drill.claudeDrillEvents('overload', SID),
  error: () => [ev.init, { type: 'result', subtype: 'error_during_execution', is_error: true, result: '도구가 넘어졌습니다',
    session_id: SID, total_cost_usd: 0, duration_ms: 1, permission_denials: [] }],
  // 연습 `usage-after-tool` 이 끼우는 자리 — 도구 결과 뒤에 오는 것은 안 나가야 한다.
  'tool-then-more': () => [ev.init, ev.tool('t1', CMD1), ev.res('t1'), ev.text('끼운 뒤에 안 나가야 할 글'), ev.ok('끝')],
};
let claudeScript = 'ok';
const claudeCalls = [];
SdkHandler.queryFn = ({ prompt, options }) => {
  claudeCalls.push({ prompt: typeof prompt === 'string' ? prompt : '(흐름)', options });
  const events = SCRIPTS[claudeScript]();
  return (async function* () {
    for (const e of events) {
      if (options?.abortController?.signal?.aborted) return;
      await new Promise((r) => setImmediate(r));
      yield e;
    }
  })();
};

// ---------------------------------------------------------------- 대화 처리기 껍데기
function sessionStore() {
  const m = new Map();
  return {
    getSessionKey: (u, c, t) => `${u}-${c}-${t || 'direct'}`,
    getSession(u, c, t) { return m.get(this.getSessionKey(u, c, t)); },
    createSession(u, c, t) {
      const s = { userId: u, channelId: c, threadTs: t, isActive: true, lastActivity: new Date() };
      m.set(this.getSessionKey(u, c, t), s);
      return s;
    },
    removeSession() { return true; }, scheduleSave() {}, saveNow() {},
    runQuery() { throw new Error('CLI 길은 이 검사에서 안 씀'); },
  };
}

// 슬랙 ts 는 지금보다 앞서게 — 세션 시각(실제 지금) 뒤에 올라온 글로 읽혀야 「못 본 글」이 된다.
let tsBase = nowSec() + 1000;
function makeHandler(o = {}) {
  const h = Object.create(SlackHandler.prototype);
  const posts = [];
  const notices = [];
  const logs = [];
  const nextTs = () => `${++tsBase}.000100`;
  h.logger = {
    info: (m) => logs.push(['info', m]), warn: (m) => logs.push(['warn', m]),
    error: (m) => logs.push(['error', m]), debug() {},
  };
  h.app = { client: {
    chat: {
      postMessage: async (m) => { posts.push(m); return { ts: nextTs() }; },
      update: async () => ({}), delete: async () => ({}),
    },
    reactions: { add: async () => ({}), remove: async () => ({}) },
    conversations: {
      history: async () => ({ messages: o.history ?? [] }),
      replies: async () => ({ messages: [] }),
    },
    users: { info: async () => ({ user: { locale: 'ko-KR' } }) },
    auth: { test: async () => ({ user_id: 'UBOT' }) },
  } };
  h.botUserId = 'UBOT';
  h.userLocales = new Map([['U_ME', 'ko']]);
  h.workingDirManager = {
    parseSetCommand: () => null, isGetCommand: () => false,
    getWorkingDirectory: () => o.cwd ?? WA_ROOT, hasChannelWorkingDirectory: () => true,
  };
  h.mcpManager = {};
  h.fileHandler = new FileHandler();
  h.fileHandler.cleanupTempFiles = async () => {};
  h.todoManager = { cleanupSession() {} };
  h.sessionScanner = { registerSession() {} };
  h.accountManager = { syncFromCredentialsFile() {}, getAccessToken: async () => null };
  h.cliHandler = sessionStore();
  h.sdkHandler = new SdkHandler({ getServerConfiguration: () => ({}), getDefaultAllowedTools: () => [] });
  h.sdkHandler.prewarm = () => {};
  for (const k of ['activeProcesses', 'fallbackRuns', 'todoMessages', 'originalMessages', 'currentReactions', 'slackChain',
    'channelModels', 'channelPermissionModes', 'channelAlwaysApproveTools', 'lastQueryCosts', 'pendingDenials',
    'pendingOneTimeTools', 'pendingPlans']) h[k] = new Map();
  h.hintShownThreads = new Set();
  h.emojiToReaction = {};
  h.ANCHOR_REACTION = 'hourglass_flowing_sand';
  h.holdGate = new ChannelGate();
  h.assistantScheduler = null;
  h.engineNotice = new EngineNotice({
    ladder: () => dmf.dmLadder(), post: async (t) => { notices.push(t); }, enabled: () => true, log: silent,
  });
  const say = async (m) => { posts.push(typeof m === 'string' ? { text: m } : m); return { ts: nextTs() }; };
  const dm = async (text, extra = {}) => {
    const sink = {};
    await h.handleMessage({ user: 'U_ME', channel: extra.channel ?? 'D_DM', ts: nextTs(), text, outcomeSink: sink, ...extra }, say);
    return sink;
  };
  return { h, posts, notices, logs, say, dm };
}

const allText = (posts) => posts.map((p) => [p.text ?? '', JSON.stringify(p.blocks ?? [])].join(' ')).join('\n');
const markers = (posts) => posts.filter((p) => p.blocks?.[0]?.type === 'context' && String(p.text).startsWith('↪'));
const calls = () => fake.calls();
const LIMIT_TEXT = /hit your session limit/;

async function scenario(o) {
  reset();
  claudeCalls.length = 0;
  bridge.captures = 0;
  bridge.failed = [];
  bridge.dropped = [];
  privateTurn = false;
  for (const k of ['DM_FALLBACK', 'HOLD_V2']) delete process.env[k];
  if (o.fallback !== false) process.env.DM_FALLBACK = 'on';
  if (o.hold) process.env.HOLD_V2 = 'on';
  process.env.FAKE_CODEX_MODE = o.codex ?? 'ok-noop';
  claudeScript = o.claude ?? 'ok';
  o.before?.();
  const t = makeHandler(o);
  const n0 = calls().length;
  const sink = await t.dm(o.text ?? '오늘 할 일 알려 줘', o.event ?? {});
  return { ...t, sink, codex: calls().slice(n0) };
}

try {
  // ================================================================ ① 고르는 함수 — 모든 조합
  {
    const base = { origin: 'dm', planMode: false, resumeCmd: false, hasFiles: false, isPrivate: false,
      cwdIsWorkAssistant: true, blocked: {} };
    const P = (o) => ladder.pickEngine({ ...base, ...o });
    const origins = ['dm', 'pushed', 'replay', 'channel'];
    const outcomes = [undefined, 'notRun', 'ok', 'limited', 'overload', 'error'];
    const blocks = [{}, { claude: true }, { codex: true }, { claude: true, codex: true }];
    const flags = [{}, { planMode: true }, { resumeCmd: true }, { hasFiles: true }, { isPrivate: true }, { cwdIsWorkAssistant: false }];
    let n = 0;
    const bad = [];
    for (const origin of origins) for (const f of flags) for (const claudeOutcome of outcomes)
      for (const blocked of blocks) for (const writeRan of [false, true]) {
        n += 1;
        const i = { origin, ...f, claudeOutcome, blocked, writeRan };
        const eligible = origin !== 'channel' && !f.planMode && !f.resumeCmd && !f.isPrivate && f.cwdIsWorkAssistant !== false;
        const next = blocked.codex ? 'hold' : 'codex';
        let want = 'claude';
        if (eligible) {
          if (!claudeOutcome || claudeOutcome === 'notRun') want = blocked.claude ? next : 'claude';
          else if (claudeOutcome === 'limited' || claudeOutcome === 'overload') want = next;
        }
        const got = P(i);
        if (got !== want) bad.push(`${JSON.stringify(i)} → ${got} (기대 ${want})`);
      }
    eq(`고르기 — ${n}개 조합이 다 규칙대로`, bad.slice(0, 5), []);
    eq('쓰기가 돌았어도 넘긴다(넘길 때 프롬프트만 바뀐다)', P({ claudeOutcome: 'limited', writeRan: true }), 'codex');
    eq('Claude 의 보통 오류는 안 넘긴다', P({ claudeOutcome: 'error' }), 'claude');
    eq('개인 글은 안 넘긴다', P({ claudeOutcome: 'limited', isPrivate: true }), 'claude');
    eq('사다리 배열 — 6단계가 뒤에 칸을 붙인다', ladder.DM_LADDER, ['claude', 'codex']);
    eq('사다리에 칸이 붙으면 그리로', ladder.pickEngine({ ...base, claudeOutcome: 'limited', blocked: { codex: true } },
      ['claude', 'codex', 'agy-claude']), 'agy-claude');
    eq('켜는 문 — on 일 때만', [dmf.dmFallbackOn({}), dmf.dmFallbackOn({ DM_FALLBACK: '1' }), dmf.dmFallbackOn({ DM_FALLBACK: 'on' })],
      [false, false, true]);
    eq('꺼져 있으면 DM 사다리는 Claude 하나', [dmf.dmLadder({}), dmf.dmLadder({ DM_FALLBACK: 'on' })], [['claude'], ['claude', 'codex']]);
  }

  // ================================================================ ② 꺼짐 — 예전 그대로
  {
    const s = await scenario({ fallback: false, claude: 'limited' });
    eq('꺼짐 — codex 를 안 부른다', s.codex.length, 0);
    // 한도 글은 폴백과 무관하게 안 올린다 — 한도 안내(⏳ · 한 번만)가 대신 말한다.
    ok('꺼짐 — Claude 의 한도 글을 안 올린다', !LIMIT_TEXT.test(allText(s.posts)));
    eq('꺼짐 — 실패 표시 limit', bridge.failed.map((f) => f[1]), ['limit']);
    ok('꺼짐 — 한도 안내', allText(s.posts).includes('⏳'));
    eq('꺼짐 — 결과는 막힘', [s.sink.outcome, s.sink.engine], ['limited', 'claude']);
    const s2 = await scenario({ fallback: false, claude: 'ok', before: blockClaude });
    eq('꺼짐 — 막혀 있어도 Claude 를 띄운다(예전 그대로)', [claudeCalls.length, s2.codex.length], [1, 0]);
    ok('꺼짐 — 막히지 않은 차례의 Claude 글은 그대로 올린다', allText(s2.posts).includes('Claude 답'));
    const s3 = await scenario({ fallback: false, claude: 'overload' });
    ok('꺼짐 — 과부하 원문(529)도 안 올리고 안내', !allText(s3.posts).includes('529') && allText(s3.posts).includes('⏳'));
  }

  // ================================================================ ③ 띄우기 전 — Claude 가 막혀 있으면 안 띄우고 GPT
  {
    const history = [{ ts: `${tsBase - 30}.000100`, bot_id: 'B1', text: '❓ 어느 업무에 남길까요?' }];
    const s = await scenario({ claude: 'ok', before: blockClaude, history, text: '오늘 할 일 알려 줘 — 원문 표시' });
    eq('막혀 있으면 Claude 를 안 띄운다', claudeCalls.length, 0);
    eq('GPT 를 한 번 부른다', s.codex.length, 1);
    const c = s.codex[0] ?? {};
    eq('캡처 id 를 값으로 · 봇 세션 표시', c.dmEnv, { WORK_ASSISTANT_CAPTURE: 'cap-1', CLAUDE_BOT_SESSION: '1' });
    eq('방마다 하나인 가리킴 파일은 안 넘긴다', c.env?.WORK_ASSISTANT_CAPTURE_FILE ?? null, null);
    const a = c.argv ?? [];
    ok('쓰기 모래상자 · 깊이 low · 업무 비서 뿌리', a.includes('--approve-for-me') && a.includes('model_reasoning_effort=low')
      && a[a.indexOf('-C') + 1] === WA_ROOT);
    eq('모델 — 등급 표를 못 읽으면 기본', a[a.indexOf('-m') + 1], 'gpt-test-sol');
    const p = c.prompt ?? '';
    ok('프롬프트 — 슬랙 표면 안내', p.includes('이 세션은 **슬랙 DM**에서 열렸다'));
    ok('프롬프트 — 캡처 안내', p.includes('캡처로 이미 저장돼 있다'));
    ok('프롬프트 — 체크인 번호표', p.includes('[체크인 번호표 — 시험]'));
    ok('프롬프트 — 못 본 대화방 글(새 세션처럼)', p.includes('[세션이 못 본 대화방 글') && p.includes('어느 업무에 남길까요'));
    ok('프롬프트 — 사람 말', p.includes('원문 표시'));
    ok('넘겨줄 메모는 없다(Claude 가 안 돌았다)', !p.includes('이미 한 것'));
    const texts = s.posts.map((x) => x.text ?? '');
    ok('GPT 답을 올린다', texts.includes('☀️ codex 답'));
    const mk = markers(s.posts);
    eq('표시 줄 하나(context 블록)', mk.length, 1);
    ok(`표시 줄 모양 — ${mk[0]?.text}`, /^↪ GPT\(gpt-test-sol\) 가 답함 · Claude 사용량 소진\(풀림 \d\d\/\d\d\(.\) \d\d:\d\d\)$/.test(mk[0]?.text ?? ''));
    ok('답 다음에 표시 줄', texts.indexOf('☀️ codex 답') < texts.indexOf(mk[0]?.text));
    eq('됐으면 실패 표시 없음', bridge.failed, []);
    eq('쓰기가 없었으면 캡처를 닫는다', bridge.dropped, [['cap-1', '대체 엔진이 답함']]);
    eq('결과 — 됨 · GPT', [s.sink.outcome, s.sink.engine], ['ok', 'codex']);
    ok('한도 안내는 없다', !allText(s.posts).includes('⏳'));
    const led = fs.readFileSync(ENV.FALLBACK_LEDGER_FILE, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    eq('장부 한 줄 · 칸은 여섯뿐', led.map((r) => Object.keys(r).sort()), [['at', 'captureId', 'channel', 'engine', 'model', 'outcome']]);
    eq('장부 — 엔진 · 결과', [led[0].engine, led[0].outcome, led[0].captureId], ['codex', 'ok', 'cap-1']);
    ok('장부에 말이 없다', !fs.readFileSync(ENV.FALLBACK_LEDGER_FILE, 'utf-8').includes('원문 표시'));

    // 돌아온 첫 Claude 차례 — 「막힌 동안 다른 엔진이 처리한 것」 한 줄 · 그다음 차례는 없다.
    // 첫 차례가 판에서 민 것이어도 못 본 대화방 글을 붙인다(안 붙이면 세션 시각이 밀려 그 글을 영영 못 받는다).
    engineState.recordOk('claude');
    claudeScript = 'ok';
    claudeCalls.length = 0;
    await s.dm('판에서 온 말', { pushed: true });
    const first = claudeCalls[0]?.prompt ?? '';
    ok('돌아온 첫 차례에 장부 한 줄', first.includes('[Claude 가 막힌 동안 다른 엔진이 처리한 것 — 1건 · 자세한 내용은 위 대화방 글]'));
    ok('판에서 민 첫 차례에도 못 본 대화방 글', first.includes('[세션이 못 본 대화방 글') && first.includes('어느 업무에 남길까요'));
    await s.dm('그다음 말', { pushed: true });
    const second = claudeCalls[1]?.prompt ?? '';
    ok('그다음 차례에는 없다', !second.includes('다른 엔진이 처리한 것'));
    ok('그다음 판 차례는 예전처럼 못 본 글을 안 붙인다', !second.includes('[세션이 못 본 대화방 글'));
  }

  // ================================================================ ④ 도는 중에 막힘 — 거절 뒤의 Claude 글은 안 올림
  {
    const s = await scenario({ claude: 'limited' });
    const t = allText(s.posts);
    ok('거절 전의 Claude 글은 올린다', t.includes('확인해 보겠습니다'));
    ok('거절 뒤의 한도 글은 안 올린다', !LIMIT_TEXT.test(t));
    eq('GPT 가 이어 받는다', s.codex.length, 1);
    ok('표시 줄', markers(s.posts).length === 1);
    ok('탭이 Claude 막힘을 적었다', engineState.isBlocked('claude'));
    eq('결과 — 됨 · GPT', [s.sink.outcome, s.sink.engine], ['ok', 'codex']);
    const o = await scenario({ claude: 'overload' });
    ok('과부하도 넘긴다 · 원문(529) 안 올림', o.codex.length === 1 && !allText(o.posts).includes('529'));
    ok(`과부하 표시 줄 — ${markers(o.posts)[0]?.text}`, (markers(o.posts)[0]?.text ?? '').endsWith('· Claude 과부하'));
    const e = await scenario({ claude: 'error' });
    eq('Claude 의 보통 오류는 안 넘긴다', e.codex.length, 0);
  }

  // ================================================================ ⑤ 쓰기가 돈 뒤 끊김 — 이미 한 것을 넘긴다
  {
    const s = await scenario({ claude: 'limited-after-write' });
    eq('쓰기가 돌았어도 넘긴다', s.codex.length, 1);
    const p = s.codex[0]?.prompt ?? '';
    ok('넘겨줄 메모 머리', p.includes('이미 한 것 — 다시 하지 말 것 · 결과를 못 받은 것은 확인부터'));
    ok('완료한 쓰기', p.includes(`- 완료 · Bash · ${CMD1}`));
    ok('결과 모름은 먼저 확인', p.includes(`- 결과 모름 — 먼저 확인 · Bash · ${CMD2}`));
    const mk = markers(s.posts)[0]?.text ?? '';
    ok(`넘겨받음 줄이 먼저 — ${mk}`, mk.split('\n')[0] === '↪ Claude 가 하다 끊겨 GPT 가 이어서 마무리했습니다(이미 한 것: 2건)'
      && mk.split('\n')[1]?.startsWith('↪ GPT(gpt-test-sol) 가 답함'));
    eq('Claude 가 썼으면 캡처를 안 버린다(tasks.py 가 닫았다)', bridge.dropped, []);
    eq('결과 — Claude 쓰기 + GPT', [s.sink.outcome, s.sink.writeRan], ['ok', true]);
  }

  // ================================================================ ⑥ GPT 도 못 함 — 모아 두고 한도 안내(원문 안 올림)
  {
    let s = await scenario({ claude: 'limited', codex: 'usage-event', hold: true });
    eq('GPT 한도 — 실패 표시 limit', bridge.failed.map((f) => [f[0], f[1]]), [['cap-1', 'limit']]);
    ok('GPT 한도 — 한도 안내', allText(s.posts).includes('⏳'));
    ok('GPT 한도 — codex 오류 글을 안 올린다', !/usage limit|Upgrade to Pro/.test(allText(s.posts)));
    ok('GPT 한도 — Claude 한도 글도 안 올린다', !LIMIT_TEXT.test(allText(s.posts)));
    eq('GPT 한도 — 표시 줄 없음', markers(s.posts).length, 0);
    ok('GPT 한도 — 엔진 상태에 codex 막힘', engineState.isBlocked('codex'));
    eq('GPT 한도 — 결과는 막힘(드레인이 멈춘다)', s.sink.outcome, 'limited');
    s = await scenario({ claude: 'limited', codex: 'usage-after-write', hold: true });
    eq('GPT 가 쓴 뒤 막힘 — partial', bridge.failed.map((f) => f[1]), ['partial']);
    ok('GPT 가 쓴 뒤 막힘 — 이미 한 것에 GPT 명령', (bridge.failed[0]?.[2]?.done_steps ?? []).some((l) => l.includes('GPT 명령')));
    s = await scenario({ claude: 'limited', codex: 'fail', hold: true });
    eq('GPT 실패(한도 아님) — 모아 둠', bridge.failed.map((f) => f[1]), ['limit']);
    ok('GPT 실패 — 원문 안 올림', !/stream disconnected|연결 끊김/.test(allText(s.posts)));
    // 둘 다 막혀 있으면 아무것도 안 띄우고 모아 둔다
    s = await scenario({ claude: 'ok', before: () => { blockClaude(); blockCodex(); }, hold: true });
    eq('둘 다 막힘 — Claude · GPT 안 띄움', [claudeCalls.length, s.codex.length], [0, 0]);
    eq('둘 다 막힘 — 실패 표시 limit · 한도 안내', [bridge.failed.map((f) => f[1]), allText(s.posts).includes('⏳')], [['limit'], true]);
    eq('둘 다 막힘 — 결과는 막힘', s.sink.outcome, 'limited');
    const led = fs.readFileSync(ENV.FALLBACK_LEDGER_FILE, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    eq('둘 다 막힘 — 장부에 모아 둠', led.map((r) => [r.engine, r.outcome]), [['none', 'hold']]);
  }

  // ================================================================ ⑦ 넘기지 않는 차례
  {
    let s = await scenario({ claude: 'limited', before: () => { privateTurn = true; }, text: '비밀조각이 든 말' });
    eq('개인 글 — GPT 안 부름', s.codex.length, 0);
    eq('개인 글 — 모아 둠', bridge.failed.map((f) => f[1]), ['limit']);
    // 넘기지 않는 차례는 폴백이 아예 안 끼어든다 — 장부도 안 적힌다. 한도 글은 안 올리고 한도 안내가 말한다.
    ok('개인 글 — 한도 글 안 올림 · 한도 안내', !LIMIT_TEXT.test(allText(s.posts)) && allText(s.posts).includes('⏳'));
    ok('개인 글 — 장부에 안 적음', !fs.existsSync(ENV.FALLBACK_LEDGER_FILE));
    s = await scenario({ claude: 'ok', before: () => { privateTurn = true; blockClaude(); }, text: '비밀조각이 든 말' });
    eq('개인 글 + Claude 막힘 — GPT 안 부름(Claude 길로)', [s.codex.length, claudeCalls.length], [0, 1]);
    ok('개인 글 + Claude 막힘 — Claude 가 답하면 그 글은 올린다', allText(s.posts).includes('Claude 답'));
    s = await scenario({ claude: 'limited', event: { channel: 'C_ROOM' } });
    eq('채널 — GPT 안 부름', s.codex.length, 0);
    ok('채널 — 한도 글 안 올림 · 한도 안내', !LIMIT_TEXT.test(allText(s.posts)) && allText(s.posts).includes('⏳'));
    s = await scenario({ claude: 'limited', text: '-plan 계획만 세워 줘' });
    eq('계획 모드 — GPT 안 부름', s.codex.length, 0);
    s = await scenario({ claude: 'limited', cwd: path.join(TMP, 'other-dir') });
    eq('작업 디렉터리가 업무 비서 뿌리가 아님 — GPT 안 부름', s.codex.length, 0);
  }

  // ================================================================ ⑧ 같은 방에서 한 줄로 — 새 DM 은 기다리고 GPT 를 안 끊는다
  {
    reset();
    claudeCalls.length = 0;
    bridge.failed = [];
    process.env.DM_FALLBACK = 'on';
    process.env.FAKE_CODEX_MODE = 'slow';
    process.env.FAKE_CODEX_SLOW_MS = '1500';
    claudeScript = 'ok';
    bridge.captures = 0;
    blockClaude();
    const t = makeHandler();
    const n0 = calls().length;
    const e0 = fake.ends().length;
    const first = t.dm('첫 말');
    for (let i = 0; i < 100 && calls().length === n0; i++) await sleep(50);
    const second = t.dm('둘째 말');
    await sleep(200);
    // 기다리는 동안 재시작해도 말이 남게 — 문에서 기다리기 **전에** 원문을 저장한다.
    eq('둘째가 기다리는 동안 이미 캡처됨(첫째는 아직 도는 중)', [bridge.captures, fake.ends().length - e0], [2, 0]);
    const [s1, s2] = await Promise.all([first, second]);
    eq('말 하나에 캡처 하나', bridge.captures, 2);
    const cs = calls().slice(n0);
    const es = fake.ends().slice(e0);
    eq('두 차례 다 GPT 가 받는다', [cs.length, s1.outcome, s2.outcome], [2, 'ok', 'ok']);
    ok('둘째는 첫째가 끝난 뒤에 시작', cs.length === 2 && es.length >= 1 && cs[1].at >= es[0].at);
    eq('첫째를 안 끊었다 — 답이 둘', t.posts.filter((p) => p.text === '☀️ codex 답').length, 2);
    ok('둘째가 문에서 기다렸다', t.logs.some((l) => l[1] === '밀린 것을 다시 돌리는 동안 기다렸습니다'));
    delete process.env.FAKE_CODEX_SLOW_MS;
  }

  // ================================================================ ⑨ -stop 이 GPT 차례를 끊는다(손잡이)
  {
    reset();
    bridge.failed = [];
    process.env.DM_FALLBACK = 'on';
    process.env.FAKE_CODEX_MODE = 'slow';
    process.env.FAKE_CODEX_SLOW_MS = '8000';
    blockClaude();
    const t = makeHandler();
    const n0 = calls().length;
    const t0 = Date.now();
    const run = t.dm('끊을 말');
    for (let i = 0; i < 100 && calls().length === n0; i++) await sleep(50);
    const handle = t.h.activeProcesses.get('U_ME-D_DM-direct');
    ok('GPT 차례가 손잡이를 걸었다', !!handle);
    // **명령 길 그대로** — DM 맨 위의 `-stop` 이 차례와 같은 키(`direct`)를 짓는지까지 본다.
    await t.dm('-stop');
    ok('-stop 이 끊었다고 답한다', t.posts.some((p) => (p.text ?? '').startsWith('⏹️')));
    const sink = await run;
    ok(`끊으면 바로 끝난다(${Date.now() - t0}ms)`, Date.now() - t0 < 7000);
    eq('끊은 차례 — 실패 표시 없음 · 답 없음', [bridge.failed.length, t.posts.some((p) => p.text === '☀️ codex 답')], [0, false]);
    eq('끊은 차례 — 결과 오류', sink.outcome, 'error');
    const led = fs.readFileSync(ENV.FALLBACK_LEDGER_FILE, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    eq('장부 — 끊김', led.map((r) => r.outcome), ['stopped']);
    // -reset 도 같은 키로 지운다
    const removed = [];
    t.h.cliHandler.removeSession = (u, c, th) => { removed.push(t.h.cliHandler.getSessionKey(u, c, th)); return true; };
    await t.dm('-reset');
    eq('-reset — DM 맨 위는 대화 세션(direct)을 지운다', removed, ['U_ME-D_DM-direct']);

    // 다시 돌리던 것을 사람이 끊으면 그 캡처를 버린다 — 남기면 다음 드레인이 「이미 한 것」 없이 또 돌린다.
    reset();
    bridge.failed = [];
    bridge.dropped = [];
    blockClaude();
    const t2 = makeHandler();
    const n1 = calls().length;
    const run2 = t2.dm('다시 돌리는 말', { replay: true, pushed: true, captureId: 'cap-r' });
    for (let i = 0; i < 100 && calls().length === n1; i++) await sleep(50);
    await t2.dm('-stop');
    await run2;
    eq('다시 돌리기를 끊음 — 실패 표시 없이 캡처를 버림', [bridge.failed.length, bridge.dropped],
      [0, [['cap-r', '다시 돌리던 것을 사람이 끊음']]]);
    delete process.env.FAKE_CODEX_SLOW_MS;
  }

  // ================================================================ ⑨-2 세션 시각 · 세션 정리 · 짧은 갱신
  {
    // Claude 가 띄워졌다 막혀 GPT 가 받았으면 세션 시각을 안 민다 — 돌아온 Claude 가 GPT 답을 「못 본 글」로 받게.
    reset();
    process.env.DM_FALLBACK = 'on';
    process.env.FAKE_CODEX_MODE = 'ok-noop';
    claudeScript = 'limited';
    const t = makeHandler();
    const s0 = t.h.cliHandler.createSession('U_ME', 'D_DM', undefined);
    const old = new Date(Date.now() - 3600_000);
    s0.lastActivity = old;
    s0.sessionId = 'sess-old';
    const sink = await t.dm('막히는 말');
    eq('막혀 GPT 가 받음 — 세션 시각 그대로', [sink.engine, s0.lastActivity.getTime()], ['codex', old.getTime()]);
    engineState.recordOk('claude');
    claudeScript = 'ok';
    await t.dm('다음 말');
    ok('Claude 가 답하면 세션 시각을 민다', s0.lastActivity.getTime() > old.getTime());

    // 세션 정리 — 장부에 그 방의 차례가 24시간 안에 있으면 쓰는 중
    const { CliHandler } = require(path.join(ROOT, 'dist', 'cli-handler.js'));
    const ch = Object.create(CliHandler.prototype);
    ch.logger = silent;
    ch.saveToDisk = () => {};
    const stale = (c) => ({ userId: 'U_ME', channelId: c, isActive: true, lastActivity: new Date(Date.now() - 30 * 3600_000) });
    const h = Object.create(SlackHandler.prototype);
    h.cliHandler = ch;
    reset();
    ch.sessions = new Map([['U_ME-D_DM-direct', stale('D_DM')], ['U_ME-C_X-1', stale('C_X')]]);
    dmf.appendLedger({ channel: 'D_DM', engine: 'none', model: '', captureId: 'c1', outcome: 'hold' });
    h.sweepSessions();
    eq('장부에 그 방 차례가 있으면 남김 · 없으면 지움', [...ch.sessions.keys()], ['U_ME-D_DM-direct']);
    reset();
    ch.sessions = new Map([['U_ME-D_DM-direct', stale('D_DM')]]);
    dmf.appendLedger({ channel: 'D_DM', engine: 'codex', model: 'm', captureId: 'c2', outcome: 'ok', at: nowSec() - 30 * 3600 });
    h.sweepSessions();
    eq('장부의 차례도 24시간 지났으면 지움', ch.sessions.size, 0);
    reset();

    // 짧은 갱신으로 끝난 다시 돌리기는 「처리함」 — 「못 함」으로 남으면 같은 갱신이 또 들어간다.
    const tq = makeHandler();
    wa.quickUpdate = async () => ({ kind: 'ok', output: '반영함' });
    const qs = { outcome: 'error' };
    await tq.h.handleMessage({ user: 'U_ME', channel: 'D_DM', ts: `${++tsBase}.000100`, text: 'TSK-1 완료',
      replay: true, pushed: true, captureId: 'cap-q', outcomeSink: qs }, tq.say);
    wa.quickUpdate = async () => ({ kind: 'not-quick' });
    eq('짧은 갱신으로 끝나면 결과는 됨', qs.outcome, 'ok');
  }

  // ================================================================ ⑩ 판에서 온 차례 · 조용히 · 첨부
  {
    process.env.FAKE_CODEX_REPLY = '[조용히]';
    let s = await scenario({ claude: 'ok', before: blockClaude, event: { pushed: true } });
    delete process.env.FAKE_CODEX_REPLY;
    eq('판에서 온 차례도 GPT 가 받는다', s.codex.length, 1);
    eq('「조용히」 답이면 표시 줄도 안 올린다', markers(s.posts).length, 0);
    const att = path.join(TMP, 'att.png');
    fs.writeFileSync(att, 'x');
    s = await scenario({ claude: 'ok', before: blockClaude, event: { heldFiles: [{ path: att, name: 'att.png', mimetype: 'image/png', isImage: true, isText: false, size: 1 }] } });
    ok('첨부 — 로컬 경로를 프롬프트에', (s.codex[0]?.prompt ?? '').includes(`- att.png: ${att}`));
  }

  // ================================================================ ⑪ 엔진 안내 — 바뀔 때 한 줄
  {
    const file = path.join(TMP, 'notice-state.json');
    const st = new EngineState({ file, legacyFile: path.join(TMP, 'none.json') });
    const posted = [];
    const labels = () => ({ codex: 'gpt-T-astra', agyClaude: '', gemini: '' });
    process.env.DM_FALLBACK = 'on';
    const n = new EngineNotice({ store: st, ladder: () => dmf.dmLadder(), labels, enabled: () => true,
      post: async (t) => { posted.push(t); }, log: silent });
    st.recordBlocked('claude', { kind: 'usage', until: nowSec() + 3600 });
    await n.check();
    st.recordBlocked('codex', { kind: 'usage', until: nowSec() + 7200 });
    await n.check();
    st.recordOk('codex');
    await n.check();
    st.recordOk('claude');
    await n.check();
    ok(`Claude → GPT — ${posted[0]}`, /^🔁 Claude 사용량 소진\(풀림 .+\) — GPT\(gpt-T-astra\)로 이어 갑니다$/.test(posted[0] ?? ''));
    ok(`GPT → 모아 둠 — ${posted[1]}`, (posted[1] ?? '').startsWith('⏸ 모든 엔진 소진'));
    ok(`모아 둠 → GPT 가 풀림: 「회복」이 아니라 지금 모양 — ${posted[2]}`,
      /^🔁 Claude 사용량 소진\(풀림 .+\) — GPT\(gpt-T-astra\)로 이어 갑니다$/.test(posted[2] ?? ''));
    eq('Claude 회복', posted.slice(3), ['✅ Claude 회복 — 돌아왔습니다']);
    // Claude 가 막힌 채로 폴백을 켬(차례가 모아 둠 → GPT) — GPT 는 막힌 적이 없으니 「GPT 회복」이 아님
    {
      const f2 = path.join(TMP, 'notice-switch.json');
      const s2 = new EngineState({ file: f2, legacyFile: path.join(TMP, 'none.json') });
      const p2 = [];
      let lad = ['claude'];
      const n2 = new EngineNotice({ store: s2, ladder: () => lad, labels, enabled: () => true,
        post: async (t) => { p2.push(t); }, log: silent });
      s2.recordBlocked('claude', { kind: 'usage', until: nowSec() + 3600 });
      await n2.check();
      lad = ['claude', 'codex'];
      await n2.check();
      ok(`폴백을 켜는 순간 — ${p2[1]}`, /^🔁 Claude 사용량 소진\(풀림 .+\) — GPT\(gpt-T-astra\)로 이어 갑니다$/.test(p2[1] ?? ''));
      fs.rmSync(f2, { force: true });
    }
    // 폴백이 꺼져 있으면 안 붙은 GPT 를 「이어 갑니다」로 알리지 않는다
    delete process.env.DM_FALLBACK;
    fs.rmSync(file, { force: true });
    posted.length = 0;
    st.recordBlocked('claude', { kind: 'usage', until: nowSec() + 3600 });
    await n.check();
    ok(`꺼짐 — Claude 가 막히면 모아 둠 — ${posted[0]}`, (posted[0] ?? '').startsWith('⏸'));
  }

  // ================================================================ ⑫ 연습 파일
  {
    reset();
    const now = nowSec();
    eq('없으면 무시', drill.readDrill(now), null);
    writeDrill({ claude: 'usage', expiresAt: now + 600 });
    eq('있으면 받음', drill.readDrill(now), { expiresAt: now + 600, claude: 'usage' });
    writeDrill({ claude: 'usage', expiresAt: now - 1 });
    eq('지났으면 무시', drill.readDrill(now), null);
    writeDrill({ claude: 'usage', expiresAt: now + 3 * 3600 });
    eq('2시간 넘게 남았으면 무시', drill.readDrill(now), null);
    fs.writeFileSync(ENV.ENGINE_DRILL_FILE, '{깨짐', 'utf-8');
    eq('깨졌으면 무시', drill.readDrill(now), null);
    fs.writeFileSync(ENV.ENGINE_DRILL_FILE, `﻿${JSON.stringify({ codex: 'fail', expiresAt: now + 600 })}`, 'utf-8');
    eq('BOM 이 붙어도 읽음(PowerShell 5.1)', drill.readDrill(now), { expiresAt: now + 600, codex: 'fail' });
    writeDrill({ claude: 'usage', codex: 'usage', expiresAt: now + 600 });
    eq('예약 일에는 안 넣는다', [drill.claudeDrill('scheduled'), drill.codexDrill(undefined)], [null, null]);
    eq('대화 차례에는 넣는다', [drill.claudeDrill('interactive'), drill.codexDrill('interactive')], ['usage', 'usage']);
    writeDrill({ claude: 'usage', expiresAt: now + 600, scope: 'all' });
    eq('scope: all 이면 예약 일에도', drill.claudeDrill('scheduled'), 'usage');

    // SDK 길 — 처음부터 막힘: 진짜를 안 띄우고 엔진 상태에 진짜처럼 적힌다
    reset();
    writeDrill({ claude: 'usage', expiresAt: nowSec() + 600 });
    const sdk = new SdkHandler({ getServerConfiguration: () => ({}), getDefaultAllowedTools: () => [] });
    claudeCalls.length = 0;
    const got = [];
    for await (const e of sdk.runQuery('말', { workingDirectory: os.tmpdir(), drillScope: 'interactive', session: { sessionId: 'keep' } })) got.push(e);
    eq('연습 usage — 진짜를 안 띄움', claudeCalls.length, 0);
    eq('연습 usage — 재생 순서', got.map((e) => e.type), ['system', 'rate_limit_event', 'assistant', 'result']);
    eq('연습 usage — 세션 id 를 안 바꾼다', got[0].session_id, 'keep');
    ok('연습 usage — 메시지 uuid 를 안 단다', got.every((e) => e.uuid === undefined));
    const b = engineState.blocked('claude');
    // 막힘은 연습보다 오래 안 간다 — 20분 뒤와 연습 파일 expiresAt 중 이른 쪽(여기서는 10분 뒤)
    ok(`연습 usage — 막힘이 연습 파일과 함께 끝남 (${b?.until - nowSec()}초)`, b?.kind === 'usage' && b.untilKnown && Math.abs(b.until - nowSec() - 600) <= 2);
    eq('연습 막힘 상한 20분 — 연습 파일이 더 길게 남아도',
      (() => { const n = nowSec(); writeDrill({ claude: 'usage', expiresAt: n + 3600 }); return drill.drillBlockUntil(n) - n; })(), 1200);
    writeDrill({ claude: 'usage', expiresAt: nowSec() + 600 });
    // 예약 일(연습 범위 밖)은 진짜로
    for await (const _ of sdk.runQuery('말', { workingDirectory: os.tmpdir() })) { /* 진짜(가짜 query) */ }
    eq('예약 일은 연습을 안 받는다', claudeCalls.length, 1);

    // SDK 길 — 첫 도구 결과까지 진짜 · 그 뒤에 꼬리
    reset();
    writeDrill({ claude: 'usage-after-tool', expiresAt: nowSec() + 600 });
    claudeScript = 'tool-then-more';
    claudeCalls.length = 0;
    const got2 = [];
    for await (const e of sdk.runQuery('말', { workingDirectory: os.tmpdir(), drillScope: 'interactive' })) got2.push(e);
    eq('도구 뒤 — 진짜를 띄운다', claudeCalls.length, 1);
    eq('도구 뒤 — 도구 결과 다음에 꼬리', got2.map((e) => e.type), ['system', 'assistant', 'user', 'rate_limit_event', 'assistant', 'result']);
    ok('도구 뒤 — 그 뒤의 진짜 글은 안 나감', !JSON.stringify(got2).includes('끼운 뒤에 안 나가야 할 글'));
    ok('도구 뒤 — 진짜를 멈췄다', claudeCalls[0]?.options?.abortController?.signal?.aborted === true);

    // CLI 길 — 가짜 자식이 같은 줄을 낸다
    reset();
    const cp = new CliProcess(drill.drillChild(drill.claudeDrillEvents('overload', 's-cli')));
    const got3 = [];
    for await (const e of cp) got3.push(e.type);
    eq('CLI 연습 overload — 줄 순서', got3, ['system', 'assistant', 'result']);
    eq('CLI 연습 overload — 엔진 상태에 과부하', engineState.blocked('claude')?.kind, 'overload');

    // codex — 안 띄우고 막힘을 적는다 · 예약 일은 그대로
    reset();
    writeDrill({ codex: 'usage', expiresAt: nowSec() + 600 });
    process.env.FAKE_CODEX_MODE = 'ok-noop';
    const n0 = calls().length;
    const r1 = await wa.codexTurn('말', { workingDirectory: os.tmpdir(), sandbox: 'read-only', drillScope: 'interactive' });
    eq('codex 연습 — 안 띄움 · 사용량 소진', [calls().length - n0, r1.kind], [0, 'usage']);
    ok('codex 연습 — 엔진 상태에 막힘', engineState.isBlocked('codex'));
    const r2 = await wa.codexTurn('말', { workingDirectory: os.tmpdir(), sandbox: 'read-only' });
    eq('codex 연습 — 예약 일은 그대로', [calls().length - n0, r2.kind], [1, 'ok']);
    writeDrill({ codex: 'fail', expiresAt: nowSec() + 600 });
    eq('codex 연습 fail', (await wa.codexTurn('말', { workingDirectory: os.tmpdir(), sandbox: 'read-only', drillScope: 'interactive' })).kind, 'fail');

    // 대화 차례 전체 — 연습 usage 로 Claude 를 막고 GPT 가 받는다(D1)
    reset();
    writeDrill({ claude: 'usage', expiresAt: nowSec() + 600 });
    claudeCalls.length = 0;
    const s = await scenario({ claude: 'ok', before: () => writeDrill({ claude: 'usage', expiresAt: nowSec() + 600 }) });
    eq('D1 — 진짜 Claude 를 안 띄우고 GPT 가 받음', [claudeCalls.length, s.codex.length, s.sink.engine], [0, 1, 'codex']);
    ok('D1 — 한도 글 안 올림', !LIMIT_TEXT.test(allText(s.posts)));
    // 대화 차례 전체 — 도구 뒤 끊김을 넘김(D7)
    const s7 = await scenario({ claude: 'tool-then-more', before: () => writeDrill({ claude: 'usage-after-tool', expiresAt: nowSec() + 600 }) });
    ok('D7 — 넘겨줄 메모에 도구', (s7.codex[0]?.prompt ?? '').includes(`- 완료 · Bash · ${CMD1}`));
    ok('D7 — 넘겨받음 줄', (markers(s7.posts)[0]?.text ?? '').startsWith('↪ Claude 가 하다 끊겨 GPT 가 이어서 마무리했습니다(이미 한 것: 1건)'));
    // 대화 차례 전체 — 둘 다 막힘(D4)
    const s4 = await scenario({ claude: 'ok', hold: true,
      before: () => writeDrill({ claude: 'usage', codex: 'usage', expiresAt: nowSec() + 600 }) });
    eq('D4 — GPT 를 안 띄우고 모아 둠', [s4.codex.length, bridge.failed.map((f) => f[1]), s4.sink.outcome], [0, ['limit'], 'limited']);
    reset();
  }

  // ================================================================ ⑬ -engines
  {
    const s = await scenario({ claude: 'ok', text: '-engines', before: () => {
      blockClaude();
      writeDrill({ claude: 'usage', expiresAt: nowSec() + 600 });
    } });
    const reply = s.posts.find((p) => (p.text ?? '').startsWith('🔧'))?.text ?? '';
    const lines = reply.split('\n');
    eq('-engines — 머리 한 줄 + 엔진 넷', lines.length, 5);
    ok(`-engines 머리 — ${lines[0]}`, lines[0].includes('DM 폴백 켜짐') && lines[0].includes('연습 중(Claude usage'));
    ok(`-engines Claude 줄 — ${lines[1]}`, /^• Claude — 막힘\(사용량 소진 · 풀림 .+\) · 마지막 성공 없음$/.test(lines[1] ?? ''));
    ok(`-engines agy 줄 — ${lines[3]}`, (lines[3] ?? '').includes('DM 사다리 밖'));
    eq('-engines — 세션을 안 띄움', [claudeCalls.length, s.codex.length], [0, 0]);
  }

  // ================================================================ ⑭ 공개 저장소 — 장부 · 연습 파일은 안 올린다
  {
    const gi = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf-8');
    ok('.gitignore 에 .fallback-ledger.jsonl', /^\.fallback-ledger\.jsonl/m.test(gi));
    ok('.gitignore 에 .engine-drill.json', /^\.engine-drill\.json/m.test(gi));
  }
} finally {
  fake.cleanup();
  fs.rmSync(TMP, { recursive: true, force: true });
}

if (fails.length) {
  console.error(`실패 ${fails.length}건\n`);
  for (const f of fails) console.error('  ✗ ' + f);
  process.exitCode = 1;
} else {
  console.log('통과 — DM 폴백 (고르기 전 조합 · 꺼짐이면 예전 그대로 · 막혀 있으면 Claude 안 띄움 · 거절 뒤 한도 글 안 올림 · '
    + '캡처 id 값으로 · 봇 세션 표시 · 답과 표시 줄 · 됐으면 실패 표시 없음 · 쓰기 뒤 끊김은 이미 한 것과 함께 · '
    + 'GPT 도 못 하면 모아 둠(원문 안 올림) · 개인 글 · 채널 · 계획 · 다른 디렉터리는 안 넘김 · 같은 방은 한 줄로 · '
    + '-stop · -reset 이 차례와 같은 키 · 끊은 다시 돌리기는 버림 · 기다리기 전에 캡처 · 넘기지 않는 차례도 한도 글 안 올림 · '
    + 'GPT 가 받으면 세션 시각 그대로 · 장부 차례는 세션 정리에서 남김 · 짧은 갱신은 됨 · '
    + '조용히 · 첨부 경로 · 엔진 안내 · 장부에 말 없음 · 돌아온 첫 차례 한 줄 · 연습 파일 · -engines)');
}
// 대화 처리기가 차례 뒤 정리를 5분 뒤로 걸어 둔다 — 기다리지 않고 끝낸다.
process.exit(process.exitCode ?? 0);
