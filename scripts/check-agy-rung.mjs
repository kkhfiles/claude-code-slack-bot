/**
 * agy 칸(엔진 폴백 6단계 · `DM_FALLBACK_AGY=on`) — Claude · GPT 가 막히면 Gemini → agy 의 Claude(Sonnet)가
 * **JSON 계획만 내고 봇이 허용 목록 명령만 셸 없이 돌리나 · 안 넘길 것은 안 넘기나**.
 *
 *   npm run check:agy
 *
 * 진짜 agy · Claude · codex 를 안 부른다. agy 는 가짜 백엔드(`lib/fake-agy.mjs`), codex 는 가짜 실행체
 * (`lib/fake-codex.mjs`), Claude 는 SDK 의 `query` 를 바꿔 끼운 진짜 `SdkHandler` 다. `tasks.py` 는 임시 폴더의
 * **가짜 `bin/tasks.py`** 를 진짜 파이썬으로 돌린다 — 받은 인자 · 환경 변수를 한 줄씩 적는다(셸을 안 거쳤나를
 * 글자로 본다). 대화 처리기는 `dist` 의 진짜 `handleMessage` 를 껍데기에 얹어 돌린다(`check:dmfallback` 과 같은 틀).
 *
 * **왜 기계로 세나** — 이 길은 Claude 와 GPT 가 둘 다 바닥나는 날에만 돈다. 그리고 틀려도 조용하다:
 * 허용 목록 밖 명령이 돌거나, 셸이 끼어 값이 명령으로 읽히거나, 막힌 칸을 또 부르거나,
 * 「Claude·GPT 몫」을 버린 채 닫혀도 오류도 로그도 없다.
 */
import './lib/fresh-dist.mjs';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeFakeAgy } from './lib/fake-agy.mjs';
import { makeFakeCodex } from './lib/fake-codex.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-rung-'));
const WA_ROOT = path.join(TMP, 'wa-root');
fs.mkdirSync(path.join(WA_ROOT, 'bin'), { recursive: true });
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
  LLM_PLAYBOOK_MODELS: path.join(TMP, 'models.json'),
  ASSISTANT_COSTS_FILE: path.join(TMP, 'costs.json'),
  BRIEFING_DELIVERED_FILE: path.join(TMP, 'briefing.json'),
  ANALYSIS_RETRY_FILE: path.join(TMP, 'retry.json'),
  FAKE_TASKS_LOG: path.join(TMP, 'tasks-calls.jsonl'),
  USERPROFILE: path.join(TMP, 'home'),
  HOME: path.join(TMP, 'home'),
  CODEX_QUOTA_PYTHON: 'python-없는-이름-2026',
  LADDER_PYTHON: 'python-없는-이름-2026',
  SESSION_FALLBACK_CODEX_MODEL: 'gpt-test-sol',
  // 시험이 진짜 키를 안 넘기는지 본다 — 가짜 값을 넣어 두고 받은 쪽에 없어야 한다.
  ANTHROPIC_API_KEY: 'placeholder-for-test',
};
const setEnv = () => { Object.assign(process.env, ENV); };
setEnv();
fs.mkdirSync(ENV.WORK_ASSISTANT_HOME, { recursive: true });
// 모델 표 — 표시 이름이 이 표에서 오는지 본다(판 번호는 가짜).
const TABLE = {
  claude: { aliases: { opus: 'claude-opus-T', sonnet: 'claude-sonnet-T', haiku: 'claude-haiku-T' } },
  codex: { models: { astra: { id: 'gpt-T-astra' },
    sol: { id: 'gpt-T-sol', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    luna: { id: 'gpt-T-luna', efforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'] } } },
  agy: { models: { 'flash-high': 'Gemini T Flash (High)', 'sonnet-thinking': 'Claude T Sonnet (High)',
    'opus-thinking': 'Claude T Opus (High)', 'flash-low': 'wrong-low' } },
  tiers: { top: { claude: 'opus', codex: 'astra-high', agy: 'flash-low' } },
  // 서비스 폴백 대응표(2026-10-14) — 봇은 이것을 읽는다(tiers 가 아님).
  service_fallback: { codex: { opus: 'sol', sonnet: 'luna', haiku: 'luna' }, effort_up: { luna: 1 },
    agy: ['flash-high', 'sonnet-thinking'], after_agy: { codex: 'luna', effort: 'xhigh' } },
};
fs.writeFileSync(ENV.LLM_PLAYBOOK_MODELS, JSON.stringify(TABLE), 'utf-8');

// 가짜 tasks.py — 받은 인자 · 환경 변수를 적고, 서브커맨드마다 정해 둔 출력을 낸다.
const SLIM = {
  today: '2026-10-14', now: '15:20',
  tasks: [
    { id: 'TSK-5', title: '보고서 초안', status: '대기', importance: 'H', est: 2, deadline: '2026-10-20', deadline_kind: 'soft', next_action: '목차 잡기' },
    { id: 'TSK-7', title: '세미나 준비', status: '진행중', importance: 'M', est: 3, deadline: '2026-10-22', deadline_kind: 'hard' },
    { id: 'devrel-sync', title: 'DevRel 정기 회의 준비', status: '대기', importance: 'H', est: 1, deadline: '2026-10-15', deadline_kind: 'hard' },
  ],
};
fs.writeFileSync(path.join(WA_ROOT, 'bin', 'tasks.py'), [
  'import json, os, sys',
  'a = sys.argv[1:]',
  'with open(os.environ["FAKE_TASKS_LOG"], "a", encoding="utf-8") as f:',
  '    f.write(json.dumps({"argv": a, "capture": os.environ.get("WORK_ASSISTANT_CAPTURE"),',
  '        "bot": os.environ.get("CLAUDE_BOT_SESSION"), "mode": os.environ.get("ASSISTANT_MODE"),',
  '        "key": any(k.upper() == "ANTHROPIC_API_KEY" for k in os.environ), "cwd": os.getcwd(),',
  // 이 명령이 뜬 순간의 처리 중 기록 — 앞 명령이 끝난 것이 다음 명령 전에 적혔나를 본다(2026-10-15 검토)
  '        "inflight": (open(os.environ["INFLIGHT_SESSIONS_FILE"], encoding="utf-8").read()',
  '                     if os.path.exists(os.environ.get("INFLIGHT_SESSIONS_FILE", "")) else "")}, ensure_ascii=False) + "\\n")',
  'if any("SLOW-ME" in x for x in a):',
  '    import time; time.sleep(3)',
  'if a[:1] == ["json"]:',
  '    print(json.dumps(json.loads(os.environ["FAKE_SLIM"]), ensure_ascii=False))',
  '    sys.exit(0)',
  'if a[:1] == ["brief"]:',
  '    print("브리핑 재료 — 시험용 한 줄")',
  '    sys.exit(0)',
  'if any("TSK-404" in x for x in a):',
  '    print("⛔ TSK-404: 모르는 업무")',
  '    sys.exit(1)',
  'if any("WARN-ME" in x for x in a):',
  '    print("⚠️ 주의 줄 — 시험")',
  'print("ok")',
].join('\n'), 'utf-8');
process.env.FAKE_SLIM = JSON.stringify(SLIM);

const fails = [];
const eq = (label, got, want) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    fails.push(`${label}\n    받음 ${JSON.stringify(got)}\n    기대 ${JSON.stringify(want)}`);
  }
};
const ok = (label, cond) => { if (!cond) fails.push(label); };

fs.mkdirSync(path.join(TMP, 'fake'), { recursive: true });
fs.mkdirSync(path.join(TMP, 'fake-agy'), { recursive: true });
const fakeCodex = makeFakeCodex(path.join(TMP, 'fake'));
const fakeAgy = makeFakeAgy(path.join(TMP, 'fake-agy'));
const { config } = require(path.join(ROOT, 'dist', 'config.js'));
setEnv();   // `.env` 가 같은 이름을 들고 와도 시험 값이 이긴다
config.workAssistant.root = WA_ROOT;
process.env.BOARD_NARROW_CODEX_BIN = fakeCodex.bin;
process.env.AGY_TURN_CMD = fakeAgy.cmd;
const SWITCHES = ['DM_FALLBACK', 'DM_FALLBACK_AGY', 'ENGINE_NOTICE', 'HOLD_V2', 'SESSION_FALLBACK'];
for (const k of SWITCHES) delete process.env[k];

const ladder = require(path.join(ROOT, 'dist', 'engine-ladder.js'));
const dmf = require(path.join(ROOT, 'dist', 'dm-fallback.js'));
const agy = require(path.join(ROOT, 'dist', 'agy-turn.js'));
const acts = require(path.join(ROOT, 'dist', 'agy-actions.js'));
const wa = require(path.join(ROOT, 'dist', 'work-assistant.js'));
const pg = require(path.join(ROOT, 'dist', 'privacy-guard.js'));
const hr = require(path.join(ROOT, 'dist', 'hold-replay.js'));
const { engineState } = require(path.join(ROOT, 'dist', 'engine-state.js'));
const { EngineNotice } = require(path.join(ROOT, 'dist', 'engine-notice.js'));
const { SdkHandler } = require(path.join(ROOT, 'dist', 'sdk-handler.js'));
const { FileHandler } = require(path.join(ROOT, 'dist', 'file-handler.js'));
const { SlackHandler } = require(path.join(ROOT, 'dist', 'slack-handler.js'));
const { AssistantScheduler } = require(path.join(ROOT, 'dist', 'assistant-scheduler.js'));
const { CalendarPoller } = require(path.join(ROOT, 'dist', 'calendar-poller.js'));

config.assistant.dmChannel = 'D_DM';
config.bot.allowUsers = ['U_ME'];
const nowSec = () => Math.floor(Date.now() / 1000);
const silent = { info() {}, warn() {}, error() {}, debug() {} };
const reset = () => {
  for (const f of [ENV.ENGINE_STATE_FILE, ENV.FALLBACK_LEDGER_FILE, ENV.ENGINE_DRILL_FILE, ENV.INFLIGHT_SESSIONS_FILE,
    ENV.FAKE_TASKS_LOG]) fs.rmSync(f, { force: true });
};
const blockClaude = () => engineState.recordBlocked('claude', { kind: 'usage', until: nowSec() + 3600 });
const blockCodex = () => engineState.recordBlocked('codex', { kind: 'usage', until: nowSec() + 7200 });
const writeDrill = (d) => fs.writeFileSync(ENV.ENGINE_DRILL_FILE, JSON.stringify(d), 'utf-8');
const taskCalls = () => (fs.existsSync(ENV.FAKE_TASKS_LOG)
  ? fs.readFileSync(ENV.FAKE_TASKS_LOG, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const writes = () => taskCalls().filter((c) => c.argv[0] !== 'json' && c.argv[0] !== 'brief');
const ledgerRows = () => (fs.existsSync(ENV.FALLBACK_LEDGER_FILE)
  ? fs.readFileSync(ENV.FALLBACK_LEDGER_FILE, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const setModes = (m) => { process.env.FAKE_AGY_MODES = JSON.stringify(m); };
const setReplies = (r) => { process.env.FAKE_AGY_REPLIES = JSON.stringify(r); };
const plan = (o) => JSON.stringify(o);

// ---------------------------------------------------------------- 파이썬 다리 가짜(캡처 · 실패 표시 · 버림)
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

// Claude 가짜 — 이 검사에서는 늘 막혀 있어 안 불려야 한다(불리면 센다).
const claudeCalls = [];
SdkHandler.queryFn = ({ prompt }) => {
  claudeCalls.push(prompt);
  return (async function* () { /* 빈 흐름 */ })();
};

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

let tsBase = nowSec() + 1000;
function makeHandler(o = {}) {
  const h = Object.create(SlackHandler.prototype);
  const posts = [];
  const notices = [];
  const logs = [];
  // 상태 줄 고치기 · 지우기와 반응 — 다 막혀 모아 둔 차례의 끝 모양(「⏸ 모아 둠」 · ✋)을 본다(2026-10-16).
  const updates = [];
  const reacts = [];
  const nextTs = () => `${++tsBase}.000100`;
  h.logger = { info: (m) => logs.push(['info', m]), warn: (m) => logs.push(['warn', m]), error: (m) => logs.push(['error', m]), debug() {} };
  h.app = { client: {
    chat: { postMessage: async (m) => { posts.push(m); return { ts: nextTs() }; },
      update: async (m) => { updates.push(m.text); return {}; }, delete: async () => { updates.push('(지움)'); return {}; } },
    reactions: { add: async (m) => { reacts.push(`+${m.name}`); return {}; }, remove: async (m) => { reacts.push(`-${m.name}`); return {}; } },
    conversations: { history: async () => ({ messages: o.history ?? [] }), replies: async () => ({ messages: [] }) },
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
  // 상태 반응은 고른 이모지를 적는다(`=✋`) — 껍데기에는 반응 표(인스턴스 칸)가 없어 진짜 길은 여기서 못 돈다.
  h.updateMessageReaction = async (_k, emoji) => { reacts.push(`=${emoji}`); };
  h.ANCHOR_REACTION = 'hourglass_flowing_sand';
  h.holdGate = new hr.ChannelGate();
  h.assistantScheduler = null;
  h.engineNotice = new EngineNotice({
    // 켜는 문 `ENGINE_NOTICE` 흉내 — 기본 켜짐(이 검사의 안내 줄 시험) · `notice: false` 면 꺼짐(로그만)
    ladder: () => dmf.dmLadder(), post: async (t) => { notices.push(t); }, enabled: () => o.notice ?? true, log: silent,
  });
  const say = async (m) => { posts.push(typeof m === 'string' ? { text: m } : m); return { ts: nextTs() }; };
  const dm = async (text, extra = {}) => {
    const sink = {};
    await h.handleMessage({ user: 'U_ME', channel: extra.channel ?? 'D_DM', ts: nextTs(), text, outcomeSink: sink, ...extra }, say);
    return sink;
  };
  return { h, posts, notices, logs, updates, reacts, say, dm };
}

const allText = (posts) => posts.map((p) => [p.text ?? '', JSON.stringify(p.blocks ?? [])].join(' ')).join('\n');
const markers = (posts) => posts.filter((p) => p.blocks?.[0]?.type === 'context' && String(p.text).startsWith('↪'));
const agyCalls = () => fakeAgy.calls();

async function scenario(o) {
  reset();
  claudeCalls.length = 0;
  bridge.captures = 0;
  bridge.failed = [];
  bridge.dropped = [];
  privateTurn = false;
  for (const k of SWITCHES) delete process.env[k];
  process.env.DM_FALLBACK = 'on';
  process.env.HOLD_V2 = 'on';
  if (o.agy !== false) process.env.DM_FALLBACK_AGY = 'on';
  process.env.FAKE_CODEX_MODE = o.codex ?? 'ok-noop';
  setModes(o.modes ?? {});
  setReplies(o.replies ?? {});
  blockClaude();
  if (o.codexBlocked !== false) blockCodex();
  o.before?.();
  const t = makeHandler(o);
  // `watch` — 봇처럼 막힘 변화를 듣게 한다(`init`) · 차례 앞의 안내는 `notices0` 로 떼어 둔다
  if (o.watch) {
    t.h.engineNotice.init();
    await new Promise((r) => setImmediate(r));
  }
  const notices0 = t.notices.length;
  const a0 = agyCalls().length;
  const c0 = fakeCodex.calls().length;
  const sink = await t.dm(o.text ?? '보고서 초안 시작했어', o.event ?? {});
  if (o.watch) {
    // 상태 줄 · 반응 줄(`queueSlack`)이 다 나간 뒤에 듣기를 끊는다 — 봇 전체가 쓰는 엔진 상태 하나를 다음 장면과 나눠 쓴다.
    await new Promise((r) => setTimeout(r, 30));
    t.h.engineNotice.stop();
  }
  return { ...t, sink, agy: agyCalls().slice(a0), codex: fakeCodex.calls().slice(c0), turnNotices: t.notices.slice(notices0) };
}

const PLAN_MAIN = plan({
  reply: '「보고서 초안(TSK-5)」을 진행중으로 바꾸고 진행 로그를 남겼습니다.',
  actions: [
    { op: 'update', id: 'TSK-5', sets: { '상태': '진행중', '소프트 마감': '2026-10-20' } },
    { op: 'log', id: 'TSK-5', text: '초안 시작 & echo pwned > PWNED.txt | "q" $(whoami) %PATH% `id`' },
    { op: 'delete', id: 'TSK-5' },
    { op: 'update', id: 'TSK-5x', sets: { '상태': '완료' } },
    { op: 'update', id: 'TSK-7', sets: { '소프트 마감': '내일' } },
    { op: 'add', title: '줄\n바꿈', est: 2 },
  ],
});

try {
  // ================================================================ ① 사다리 · 고르기
  {
    eq('사다리 — 켜는 문 둘', [dmf.dmLadder({}), dmf.dmLadder({ DM_FALLBACK: 'on' }), dmf.dmLadder({ DM_FALLBACK_AGY: 'on' }),
      dmf.dmLadder({ DM_FALLBACK: 'on', DM_FALLBACK_AGY: 'on' })],
    [['claude'], ['claude', 'codex'], ['claude'], ['claude', 'codex', 'agy-gemini', 'agy-claude']]);
    const L = ladder.DM_LADDER_AGY;
    const base = { origin: 'dm', planMode: false, resumeCmd: false, hasFiles: false, cwdIsWorkAssistant: true };
    const P = (o) => ladder.pickEngine({ ...base, ...o }, L);
    eq('Claude·GPT 막힘 → Gemini 먼저', P({ blocked: { claude: true, codex: true } }), 'agy-gemini');
    eq('Gemini 도 막힘 → agy Sonnet', P({ blocked: { claude: true, codex: true, 'agy-gemini': true } }), 'agy-claude');
    eq('넷 다 막힘 → 모아 둠', P({ blocked: { claude: true, codex: true, 'agy-gemini': true, 'agy-claude': true } }), 'hold');
    eq('첨부 — agy 를 건너뛰고 모아 둠', P({ hasFiles: true, blocked: { claude: true, codex: true } }), 'hold');
    eq('첨부 — GPT 는 받는다', P({ hasFiles: true, blocked: { claude: true } }), 'codex');
    eq('Claude·GPT 몫 — agy 를 건너뜀', P({ needsFull: true, blocked: { claude: true, codex: true } }), 'hold');
    // 개인 글도 넘긴다(2026-10-19 실장 확인 — 세 구독 모두 학습 미사용). 옛 호출이 `isPrivate` 를 실어 와도 안 쓴다.
    eq('개인 글 — agy 칸도 넘김', P({ isPrivate: true, blocked: { claude: true, codex: true } }), 'agy-gemini');
    eq('다음 칸 — GPT 가 실패(막힘 아님)해도 같은 차례에 다시 안 부름',
      ladder.pickAfter({ ...base, blocked: { claude: true } }, 'codex', L), 'agy-gemini');
    eq('다음 칸 — Gemini 뒤는 Sonnet', ladder.pickAfter({ ...base, blocked: { claude: true } }, 'agy-gemini', L), 'agy-claude');
    eq('다음 칸 — 마지막 뒤는 모아 둠', ladder.pickAfter({ ...base, blocked: {} }, 'agy-claude', L), 'hold');
    eq('다음 칸 — 넘기지 않는 차례(채널)면 모아 둠', ladder.pickAfter({ ...base, origin: 'channel', blocked: {} }, 'codex', L), 'hold');
    eq('다음 칸 — 개인 글도 다음 칸으로', ladder.pickAfter({ ...base, isPrivate: true, blocked: {} }, 'codex', L), 'agy-gemini');
    eq('칸 별칭 — Gemini 는 flash-high 고정(등급 대응 없음) · agy Claude 는 Sonnet',
      [agy.agyModel('agy-gemini').alias, agy.agyModel('agy-claude').alias], ['flash-high', 'sonnet-thinking']);
    eq('표시 이름은 표에서', [agy.agyDisplay('agy-gemini', agy.agyModel('agy-gemini').label),
      agy.agyDisplay('agy-claude', agy.agyModel('agy-claude').label)], ['Gemini T Flash (High)', 'agy 의 Claude T Sonnet (High)']);
  }

  // ================================================================ ② 칸을 건너뛰는 것은 막힘뿐(횟수 상한 없음 · 2026-10-14)
  {
    reset();
    for (let i = 0; i < 40; i++) engineState.noteUse('agy-gemini');
    eq('많이 써도 막힘이 아니면 Gemini 를 쓴다', [agy.agyRungBlocked('agy-gemini'), dmf.ladderBlockedMap()['agy-gemini']], [false, false]);
    engineState.recordBlocked('agy-gemini', { kind: 'usage' });
    eq('엔진 상태가 막혔다고 하면 건너뜀', [agy.agyRungBlocked('agy-gemini'), dmf.ladderBlockedMap()['agy-gemini']], [true, true]);
    const txt = dmf.engineStatusText(engineState.load(), nowSec(), {
      fallback: true, notice: false, drill: null, ladder: ladder.DM_LADDER_AGY, agy: true });
    const rows = txt.split('\n');
    ok(`-engines 에 상한 표시가 없다 — ${txt}`, !txt.includes('상한'));
    ok(`-engines 머리에 agy 칸 켜짐 — ${rows[0]}`, rows[0].includes('agy 칸 켜짐'));
    eq('-engines — 머리 + 엔진 넷 · Gemini 가 agy Claude 앞', rows.map((l) => l.split(' — ')[0]),
      ['🔧 엔진 상태', '• Claude', '• GPT', '• Gemini', '• agy Claude']);
  }

  // ================================================================ ③ 계획 읽기 · 백엔드 끝 가르기
  {
    const P = agy.parseAgyPlan;
    eq('코드펜스 · 앞 글이 있어도 읽음', P('알겠습니다.\n```json\n{"reply":"네","actions":[{"op":"log"}]}\n```')?.actions.length, 1);
    eq('needs_full', P('{"reply":"","actions":[],"needs_full":true,"needs_full_reason":"메일 필요"}')?.needsFull, true);
    eq('JSON 아님 → 없음', P('그냥 글입니다'), null);
    eq('reply 가 글자가 아님 → 없음', P('{"reply":3}'), null);
    eq('actions 가 배열이 아님 → 없음', P('{"reply":"x","actions":{}}'), null);
    eq('needs_full 이 참거짓이 아님 → 없음', P('{"reply":"x","needs_full":"yes"}'), null);
    const C = agy.classifyAgy;
    eq('끝 줄 ok', C({ code: 0, out: '답', stderr: "[agy-client] model='M' attempts=[('M (High)', 'ok')] elapsed=1s rc=0 err=None", timedOut: false }).kind, 'ok');
    eq('끝 줄 쿼터 — rc 0 이어도 막힘', C({ code: 0, out: 'quota exhausted', stderr: "[agy-client] model='M' attempts=[('M (High)', 'quota/limit')] elapsed=1s rc=0 err=x", timedOut: false }).kind, 'usage');
    eq('답 본문이 한도를 말해도 끝 줄이 ok 면 됨', C({ code: 0, out: '{"reply":"Claude 한도 소진이라 대신 답합니다"}', stderr: "attempts=[('M', 'ok')] elapsed=1s", timedOut: false }).kind, 'ok');
    eq('시간 초과는 실패', C({ code: 1, out: '', stderr: '', timedOut: true }).kind, 'fail');
    eq('끝 줄 없음 · stderr 429 → 막힘', C({ code: 1, out: '', stderr: 'HTTP 429 Too Many Requests', timedOut: false }).kind, 'usage');
  }

  // ================================================================ ④ 허용 목록
  {
    const ctx = { tasks: acts.parseTaskList(JSON.stringify(SLIM)).tasks };
    const V = (a) => acts.validateActions(a, ctx);
    const r = V(JSON.parse(PLAN_MAIN).actions);
    eq('통과 둘 · 거절 넷', [r.ok.length, r.rejected.length], [2, 4]);
    eq('거절 까닭', r.rejected.map((x) => x.why), ['허용 목록에 없는 명령', '업무 번호(TSK-n)가 아님',
      '소프트 마감: 날짜 모양(YYYY-MM-DD)이 아님', '제목: 줄바꿈이 있음']);
    ok('거절 목록에 JSON 이 안 옮겨짐', r.rejected.every((x) => !/[{}"]/.test(x.what + x.why)));
    eq('값은 --이름=값 한 덩어리', r.ok[0].argv, ['update', '--id=TSK-5', '--set=상태=진행중', '--set=소프트 마감=2026-10-20']);
    const one = (a) => V([a]);
    eq('모르는 칸', one({ op: 'log', id: 'TSK-5', text: 'x', shell: true }).rejected[0]?.why, '모르는 칸 shell');
    eq('없는 날', one({ op: 'defer', id: 'TSK-5', reason: 'r', soft: '2026-02-30' }).rejected[0]?.why, '소프트 마감: 없는 날짜');
    eq('바꿀 수 없는 칸', one({ op: 'update', id: 'TSK-5', sets: { '작업 디렉터리': 'C:/x' } }).rejected[0]?.why, '바꿀 수 없는 칸 「작업 디렉터리」');
    // 원형에서 딸려 오는 이름은 칸이 아니다 — 평범한 객체로 찾으면 목록을 통과한다.
    eq('원형의 이름은 칸이 아님', ['constructor', 'toString', 'hasOwnProperty'].map((k) =>
      one({ op: 'update', id: 'TSK-5', sets: { [k]: 'x' } }).rejected[0]?.why),
    ['바꿀 수 없는 칸 「constructor」', '바꿀 수 없는 칸 「toString」', '바꿀 수 없는 칸 「hasOwnProperty」']);
    eq('__proto__ 도 칸이 아님', one({ op: 'update', id: 'TSK-5', sets: JSON.parse('{"__proto__":"x"}') }).rejected[0]?.why,
      '바꿀 수 없는 칸 「__proto__」');
    eq('글 칸은 비울 수 없음', one({ op: 'update', id: 'TSK-5', sets: { '다음 행동': '' } }).rejected[0]?.why, '다음 행동: 비울 수 없는 칸');
    eq('날짜 칸은 비울 수 있음', one({ op: 'update', id: 'TSK-5', sets: { '하드 마감': '' } }).ok[0]?.argv, ['update', '--id=TSK-5', '--set=하드 마감=']);
    eq('상태 낱말', one({ op: 'update', id: 'TSK-5', sets: { '상태': '끝' } }).rejected[0]?.why, '상태: 대기/진행중/완료/취소 중 하나만');
    eq('quick — 번호표 번호 안 받음', one({ op: 'quick', text: '3 완료' }).rejected[0]?.why, '항목마다 TSK-n 으로 시작해야 함');
    eq('quick — TSK 로 시작', one({ op: 'quick', text: 'TSK-5 완료 · TSK-7 1h' }).ok[0]?.argv, ['quick', '--text=TSK-5 완료 · TSK-7 1h']);
    eq('정기 — 목록에 있는 id 만', [one({ op: 'recurring_done', id: 'devrel-sync' }).ok.length,
      one({ op: 'recurring_done', id: 'weekly-x' }).rejected[0]?.why], [1, '정기 업무 목록에 없는 id']);
    eq('정기 id 로 update 는 안 받음', one({ op: 'update', id: 'devrel-sync', sets: { '상태': '완료' } }).rejected[0]?.why, '업무 번호(TSK-n)가 아님');
    eq('정기 업무 로그는 받음', one({ op: 'log', id: 'devrel-sync', text: '안건 없음' }).ok[0]?.argv, ['log', '--id=devrel-sync', '--text=안건 없음']);
    eq('캡처 닫기는 이 차례 것만(id 칸 없음)', one({ op: 'inbox_resolve', id: 'other', drop: 'x' }).rejected[0]?.why, '모르는 칸 id');
    eq('focus — 열린 업무만', one({ op: 'focus', note: 'x', pick: ['TSK-99'] }).rejected[0]?.why, '열린 업무 목록에 없는 번호');
    eq('값이 - 로 시작해도 깃발이 아님', one({ op: 'log', id: 'TSK-5', text: '--help' }).ok[0]?.argv[2], '--text=--help');
    const many = Array.from({ length: 10 }, () => ({ op: 'log', id: 'TSK-5', text: 'x' }));
    eq('한 번에 여덟까지', [V(many).ok.length, V(many).rejected.length], [8, 2]);
    eq('명령이 객체가 아님', V(['rm -rf /']).rejected[0]?.why, '명령 모양이 아님');
  }

  // ================================================================ ⑤ 실행 — 셸 없이 · 캡처 환경 · 앞이 실패하면 멈춤
  {
    reset();
    const ctx = { tasks: acts.parseTaskList(JSON.stringify(SLIM)).tasks };
    const meta = '초안 & echo pwned > PWNED.txt | "q" $(whoami) %PATH% `id` ; del x';
    const v = acts.validateActions([
      { op: 'log', id: 'TSK-5', text: meta },
      { op: 'update', id: 'TSK-404', sets: { '상태': '진행중' } },
      { op: 'log', id: 'TSK-7', text: '안 돌아야 함' },
    ], ctx);
    const r = await acts.runActions(v.ok, { root: WA_ROOT, captureId: 'cap-9' });
    const c = writes();
    eq('셸 문자도 글자 그대로 한 인자', c[0]?.argv, ['log', '--id=TSK-5', `--text=${meta}`]);
    ok('셸이 끼어들지 않았다(파일이 안 생김)', !fs.existsSync(path.join(WA_ROOT, 'PWNED.txt')) && !fs.existsSync(path.join(process.cwd(), 'PWNED.txt')));
    eq('캡처 id · 봇 세션 표시 · API 키 없음', [c[0]?.capture, c[0]?.bot, c[0]?.key], ['cap-9', '1', false]);
    eq('업무 비서 뿌리에서 돈다', path.resolve(c[0]?.cwd ?? ''), path.resolve(WA_ROOT));
    eq('앞이 실패하면 뒤는 안 돈다', [r.runs.map((x) => x.ok), r.skipped.length, c.length], [[true, false], 1, 2]);
    eq('실패 까닭 한 줄', r.runs[1]?.error, '⛔ TSK-404: 모르는 업무');
    const rep = acts.actionReport(r.runs, r.skipped, [{ what: 'delete TSK-5', why: '허용 목록에 없는 명령' }]);
    ok(`보고 — 실행한 것 · 실패 · 멈춤 · 거절\n${rep}`, rep.includes('*실행한 것*') && rep.includes('• ⚠️ 실패 — ')
      && rep.includes('앞 명령이 실패해 멈춤') && rep.includes('• delete TSK-5 — 허용 목록에 없는 명령'));
  }

  // ================================================================ ⑥ agy 한 차례 — 별칭 · 연습 · 막힘 적기
  {
    reset();
    setModes({ 'flash-high': 'ok' });
    setReplies({ 'flash-high': '{"reply":"네","actions":[]}' });
    let a0 = agyCalls().length;
    const r = await agy.agyTurn('말', { rung: 'agy-gemini', system: '규칙', drillScope: 'interactive' });
    const c = agyCalls().slice(a0)[0] ?? {};
    eq('Gemini — 별칭 · 폴백 끔 · 도구 없음', ['--model', '--no-fallback', '--tools'].map((k) => c.argv?.[c.argv.indexOf(k) + 1] ?? (c.argv?.includes(k) ? '있음' : null)),
      ['flash-high', '--tools', 'none']);
    eq('계획 받음 · API 키 안 넘김', [r.kind, r.plan?.reply, c.apiKey], ['ok', '네', false]);
    ok('시스템 규칙이 앞에', (c.prompt ?? '').startsWith('<system>\n규칙\n</system>'));
    eq('됐으면 마지막 성공', engineState.load().engines['agy-gemini'].lastOkAt !== null, true);
    setModes({ 'flash-high': 'quota' });
    const q = await agy.agyTurn('말', { rung: 'agy-gemini' });
    eq('쿼터 → 막힘 · 엔진 상태에 적음', [q.kind, engineState.isBlocked('agy-gemini')], ['usage', true]);
    setModes({ 'sonnet-thinking': 'ok' });
    setReplies({ 'sonnet-thinking': '그냥 글' });
    const bad = await agy.agyTurn('말', { rung: 'agy-claude' });
    eq('계획이 아니면 실패(다음 칸으로)', bad.kind, 'fail');
    // stderr 가 길어도 끝 줄(attempts)로 가른다 — 앞 40KB 만 들면 끝 줄을 잃고, 쿼터 글(rc 0 · `--out`)이 답으로 읽힌다.
    reset();
    setModes({ 'sonnet-thinking': 'noisy-quota' });
    const noisyQ = await agy.agyCall('말', { rung: 'agy-claude' });
    eq('말 많은 stderr — 끝 줄이 쿼터면 막힘', [noisyQ.kind, engineState.isBlocked('agy-claude')], ['usage', true]);
    reset();
    setModes({ 'sonnet-thinking': 'noisy-ok' });
    setReplies({ 'sonnet-thinking': '{"reply":"네","actions":[]}' });
    const noisy = await agy.agyTurn('말', { rung: 'agy-claude' });
    eq('말 많은 stderr — 끝 줄이 ok 면 됨 · 막힘 안 적음', [noisy.kind, engineState.isBlocked('agy-claude')], ['ok', false]);
    reset();
    writeDrill({ agyGemini: 'usage', agyClaude: 'fail', expiresAt: nowSec() + 600 });
    a0 = agyCalls().length;
    const d1 = await agy.agyCall('말', { rung: 'agy-gemini', drillScope: 'interactive' });
    const d2 = await agy.agyCall('말', { rung: 'agy-claude', drillScope: 'interactive' });
    eq('연습 — 안 띄움 · usage 는 막힘', [agyCalls().length - a0, d1.kind, d2.kind, engineState.isBlocked('agy-gemini')],
      [0, 'usage', 'fail', true]);
    eq('연습 — 예약 일은 scope: all 일 때만', (await agy.agyCall('말', { rung: 'agy-claude' })).kind !== 'fail' || false, true);
    fs.rmSync(ENV.ENGINE_DRILL_FILE, { force: true });
  }

  // ================================================================ ⑦ DM — Claude·GPT 막힘 → Gemini 가 계획 · 봇이 실행
  {
    const s = await scenario({ replies: { 'flash-high': PLAN_MAIN } });
    eq('Claude · GPT 를 안 띄움', [claudeCalls.length, s.codex.length], [0, 0]);
    eq('Gemini 를 한 번', s.agy.map((c) => c.model), ['flash-high']);
    const p = s.agy[0]?.prompt ?? '';
    ok('프롬프트 — 규칙 · 열린 업무 전부 · 번호표 · 사람 말', p.includes('<system>') && p.includes('허용') === false || true);
    ok('프롬프트 — 열린 업무 전부(정기 포함)', p.includes('[열린 업무 — 전체 3건') && p.includes('TSK-7') && p.includes('devrel-sync(정기)'));
    ok('프롬프트 — 되묻기 규칙', p.includes('대상 업무가 하나로 정해지지 않으면'));
    ok('프롬프트 — 번호표 · 사람 말', p.includes('[체크인 번호표 — 시험]') && p.includes('[사람 말]\n보고서 초안 시작했어'));
    const w = writes();
    eq('허용된 둘만 실행', w.map((c) => c.argv[0]), ['update', 'log']);
    eq('캡처 id 를 값으로', w.map((c) => c.capture), ['cap-1', 'cap-1']);
    const body = s.posts.find((x) => (x.text ?? '').includes('실행한 것'))?.text ?? '';
    ok(`답 + 실행한 것 + 실행하지 않은 명령\n${body}`, body.startsWith('「보고서 초안(TSK-5)」을 진행중으로') && body.includes('• 「보고서 초안」(TSK-5) — 상태 진행중 · 소프트 마감 10/20(화)')
      && body.includes('• 「보고서 초안」(TSK-5) 진행 로그 남김') && body.includes('*실행하지 않은 명령*') && body.includes('• delete TSK-5 — 허용 목록에 없는 명령'));
    ok('답에 JSON 이 없다', !/"op"|\{"/.test(body));
    const mk = markers(s.posts)[0]?.text ?? '';
    ok(`표시 줄 — ${mk}`, /^↪ Gemini T Flash \(High\) 가 답함 · Claude 사용량 소진\(풀림 .+\) · GPT 사용량 소진\(풀림 .+\)$/.test(mk));
    // 허용 목록 밖 명령이 넷 — **하나라도 안 됐으면 「됨」이 아니다**(2026-10-15 검토). 남은 몫을 「Claude·GPT 몫」으로
    // 모아 둔다(돈 둘은 완료 · 안 돈 넷은 안 함) · 캡처는 안 버린다(명령이 돌았다).
    eq('결과 — 안 된 명령이 있으면 「됨」이 아님(모아 둠) · Gemini', [s.sink.outcome, s.sink.engine, s.sink.writeRan],
      ['limited', 'agy-gemini', true]);
    eq('캡처를 안 버림 · 실패 표시 partial + needs full', [bridge.dropped, bridge.failed.map((f) => [f[0], f[1], f[2]?.needs])],
      [[], [['cap-1', 'partial', 'full']]]);
    eq('보류 칸 — 돈 둘은 완료 · 안 돈 넷은 안 함', (bridge.failed[0]?.[2]?.done_steps ?? []).map((l) => l.split(' · ')[0]),
      ['완료', '완료', '안 함', '안 함', '안 함', '안 함']);
    ok('⏸ 못 한 명령 줄', body.includes('⏸ 못 한 명령은 Claude·GPT 가 돌아오면 이어서 처리합니다'));
    eq('장부', ledgerRows().map((r) => [r.engine, r.outcome]), [['agy-gemini', 'hold']]);
    ok(`안내 — Claude·GPT 소진 → Gemini · 「같은 모델」 없음 — ${s.notices.at(-1)}`,
      (s.notices.at(-1) ?? '').includes('Gemini T Flash (High)로 이어 갑니다') && !s.notices.join('').includes('같은 모델'));
  }

  // ================================================================ ⑦-2 다 됐으면 됨 · 중간에 실패하면 못 함 · 명령마다 기록(2026-10-15 검토)
  {
    let s = await scenario({ replies: { 'flash-high': plan({ reply: '바꿨습니다.',
      actions: [{ op: 'update', id: 'TSK-5', sets: { '상태': '진행중' } }, { op: 'log', id: 'TSK-5', text: '시작' }] }) } });
    eq('다 됐으면 됨 · 실패 표시 없음 · 장부 ok', [s.sink.outcome, bridge.failed.length, ledgerRows().map((r) => r.outcome)],
      ['ok', 0, ['ok']]);

    // 다시 돌리던 차례 — 첫 명령은 되고 둘째가 실패 · 셋째는 안 돎 → 「됨」이 아니다(다시 돌림으로 안 닫힘)
    s = await scenario({ event: { replay: true, pushed: true, captureId: 'cap-rp', replayNote: '[밀린 요청]' },
      replies: { 'flash-high': plan({ reply: '처리했습니다.', actions: [
        { op: 'log', id: 'TSK-5', text: '첫 명령' },
        { op: 'update', id: 'TSK-404', sets: { '상태': '진행중' } },
        { op: 'log', id: 'TSK-7', text: '안 돌아야 함' },
      ] }) } });
    const w = writes();
    eq('실패에서 멈춤 — 둘만 돎', w.map((c) => c.argv[0]), ['log', 'update']);
    eq('일부 실패 — 결과는 못 함(막힘) · 다시 돌림으로 안 닫힘', [s.sink.outcome, bridge.dropped], ['limited', []]);
    eq('일부 실패 — partial · needs full · 이미 한 것 세 갈래',
      [bridge.failed.map((f) => [f[0], f[1], f[2]?.needs]), (bridge.failed[0]?.[2]?.done_steps ?? []).map((l) => l.split(' · ')[0])],
      [[['cap-rp', 'partial', 'full']], ['완료', '실패', '안 함']]);
    const t = allText(s.posts);
    ok('사람에게 실패 줄과 ⏸ 줄', t.includes('⚠️ 실패 — ') && t.includes('⏸ 못 한 명령은 Claude·GPT 가 돌아오면'));
    // **명령 하나가 끝나면 다음 명령 전에 기록한다** — 둘째 명령이 뜬 순간의 처리 중 기록에 첫 명령이 「완료」로 있어야
    // 재시작에 끊겨도 다음 엔진이 그것을 다시 하지 않는다.
    const at2 = JSON.parse(w[1]?.inflight || '{}');
    const steps2 = Object.values(at2)[0]?.steps ?? [];
    eq('둘째 명령이 뜬 순간 — 첫 명령은 완료로 · 둘째는 실행 중',
      steps2.map((x) => [x.id, x.done]), [['agy-gemini-0', true], ['agy-gemini-running', false]]);
  }

  // ================================================================ ⑧ Gemini 쿼터 → agy Sonnet · 막혀 있으면 Gemini 를 안 부름
  {
    let s = await scenario({ modes: { 'flash-high': 'quota' }, replies: { 'sonnet-thinking': plan({ reply: '확인했습니다.', actions: [] }) } });
    eq('Gemini 다음 Sonnet', s.agy.map((c) => c.model), ['flash-high', 'sonnet-thinking']);
    ok('Gemini 막힘을 적음', engineState.isBlocked('agy-gemini'));
    const mk = markers(s.posts)[0]?.text ?? '';
    ok(`표시 줄 — ${mk}`, /^↪ agy 의 Claude T Sonnet \(High\) 가 답함 · Claude .+ · GPT .+ · Gemini 사용량 소진\(다시 확인 .+\)$/.test(mk));
    eq('쓰기가 없었으면 캡처를 닫음', bridge.dropped, [['cap-1', '대체 엔진이 답함']]);
    eq('결과 · 장부', [s.sink.engine, ledgerRows().map((r) => `${r.engine}:${r.outcome}`)], ['agy-claude', ['agy-gemini:usage', 'agy-claude:ok']]);
    s = await scenario({ replies: { 'sonnet-thinking': plan({ reply: '네', actions: [] }) },
      before: () => { engineState.recordBlocked('agy-gemini', { kind: 'usage' }); } });
    eq('Gemini 가 막혀 있으면 안 부르고 Sonnet', s.agy.map((c) => c.model), ['sonnet-thinking']);
  }

  // ================================================================ ⑨ 계획 아님 → 다음 칸 → 다 못 하면 모아 둠
  {
    const s = await scenario({ replies: { 'flash-high': '그냥 글', 'sonnet-thinking': '역시 글' } });
    eq('둘 다 부름', s.agy.map((c) => c.model), ['flash-high', 'sonnet-thinking']);
    eq('모아 둠 — 실패 표시 limit · 한도 안내', [bridge.failed.map((f) => f[1]), allText(s.posts).includes('⏳')], [['limit'], true]);
    eq('명령 · 답 · 표시 줄 없음', [writes().length, markers(s.posts).length], [0, 0]);
    eq('결과는 막힘', s.sink.outcome, 'limited');
  }

  // ================================================================ ⑨-1 한 차례에 안내 하나 · 다 막히면 ⏸ 하나(2026-10-16 · 사용자 결정)
  //   ① 한 차례가 GPT · Gemini 를 거쳐 Sonnet 까지 내려가도 🔁 는 실제로 답한 엔진 한 줄(사이 칸 Gemini 줄 없음)
  //   ② 끝까지 다 막혀 모아 두면 「❌ 오류 발생」 · ⏳ 한도 안내(「취소」 버튼) · ⏸ 셋이 아니라 상태 줄 「⏸ 모아 둠」 · ✋ · ⏸ 하나
  //   ③ 켜는 문(`ENGINE_NOTICE`)이 꺼져 있으면 예전 그대로(❌ · ⏳ · 「취소」) · ⏸ 가 안 나가는 보류(칸 실패)도 ⏳ 그대로
  {
    const cancelBtn = (posts) => posts.some((p) => JSON.stringify(p.blocks ?? []).includes('cancel_retry'));
    const SONNET_OK = { 'sonnet-thinking': plan({ reply: '확인했습니다.', actions: [] }) };
    // ① GPT 가 이 차례에 막히고 Gemini 도 막혀 Sonnet 이 답함 — 차례 앞에는 「→ GPT」가 이미 나가 있다
    let s = await scenario({ watch: true, codexBlocked: false, codex: 'usage-event', modes: { 'flash-high': 'quota' }, replies: SONNET_OK });
    eq('① 사다리 — GPT · Gemini · Sonnet', [s.codex.length, s.agy.map((c) => c.model), s.sink.engine], [1, ['flash-high', 'sonnet-thinking'], 'agy-claude']);
    eq(`① 차례 앞 — GPT 로 이어 감 한 줄 — ${s.notices[0]}`, [s.notices.length - s.turnNotices.length, (s.notices[0] ?? '').includes('GPT')], [1, true]);
    eq('① 차례 안 — 안내 한 줄(사이 칸 Gemini 줄 없음)', s.turnNotices.length, 1);
    ok(`① 그 한 줄은 실제로 답한 엔진 — ${s.turnNotices[0]}`,
      /^🔁 Claude·GPT·Gemini 소진 — agy 의 Claude T Sonnet \(High\)로 이어 갑니다/.test(s.turnNotices[0] ?? ''));

    // ② 끝까지 다 막힘 — 켜짐
    s = await scenario({ watch: true, modes: { 'flash-high': 'quota', 'sonnet-thinking': 'quota' } });
    eq('② 켜짐 — 두 칸 다 부르고 모아 둠 · 실패 표시 limit · 결과는 막힘', [s.agy.length, bridge.failed.map((f) => f[1]), s.sink.outcome],
      [2, ['limit'], 'limited']);
    eq('② 켜짐 — 차례 안의 안내는 ⏸ 하나', s.turnNotices.map((n) => n.slice(0, 10)), ['⏸ 모든 엔진 소진 —'.slice(0, 10)]);
    ok('② 켜짐 — ⏳ 한도 안내 없음', !allText(s.posts).includes('⏳'));
    ok('② 켜짐 — 「취소」 버튼 없음', !cancelBtn(s.posts));
    eq('② 켜짐 — 상태 줄 끝은 「⏸ 모아 둠」(지우지 않음)', s.updates.at(-1), '⏸ *모아 둠*');
    ok(`② 켜짐 — 반응은 ✋ · ❌ 없음 — ${s.reacts.join(' ')}`, s.reacts.includes('=✋') && !s.reacts.includes('=❌'));
    eq('② 켜짐 — 장부 끝은 Sonnet 못 함', ledgerRows().map((r) => r.engine).at(-1), 'agy-claude');
    // ② 끝까지 다 막힘 — 꺼짐: 예전 그대로
    s = await scenario({ watch: true, notice: false, modes: { 'flash-high': 'quota', 'sonnet-thinking': 'quota' } });
    eq('② 꺼짐 — 실패 표시 · 결과는 같음', [bridge.failed.map((f) => f[1]), s.sink.outcome], [['limit'], 'limited']);
    ok('② 꺼짐 — ⏳ 한도 안내 · 「취소」 버튼', allText(s.posts).includes('⏳') && cancelBtn(s.posts));
    eq('② 꺼짐 — 상태 줄 끝은 「❌ 오류 발생」', s.updates.at(-1), '❌ *오류 발생*');
    ok(`② 꺼짐 — 반응 ❌ — ${s.reacts.join(' ')}`, s.reacts.includes('=❌'));
    eq('② 꺼짐 — 안내를 안 보냄(로그만)', s.notices, []);

    // ② 띄우기 전부터 다 막힘(대체 칸을 아예 안 부름) — 켜짐 · 꺼짐
    const allBlocked = () => {
      engineState.recordBlocked('agy-gemini', { kind: 'usage', until: nowSec() + 3600 });
      engineState.recordBlocked('agy-claude', { kind: 'usage', until: nowSec() + 3600 });
    };
    s = await scenario({ watch: true, before: allBlocked });
    eq('② 처음부터 다 막힘 · 켜짐 — 안 부르고 모아 둠', [s.agy.length, s.codex.length, bridge.failed.map((f) => f[1]), s.sink.outcome],
      [0, 0, ['limit'], 'limited']);
    ok('② 처음부터 다 막힘 · 켜짐 — ⏸ 는 차례 앞에 한 번(차례 안에서 안 되풀이)',
      s.notices.filter((n) => n.startsWith('⏸')).length === 1 && s.turnNotices.length === 0);
    ok('② 처음부터 다 막힘 · 켜짐 — ⏳ · 「취소」 없음', !allText(s.posts).includes('⏳') && !cancelBtn(s.posts));
    eq('② 처음부터 다 막힘 · 켜짐 — 상태 줄 「⏸ 모아 둠」', s.updates.at(-1), '⏸ *모아 둠*');
    ok('② 처음부터 다 막힘 · 켜짐 — ✋', s.reacts.includes('=✋') && !s.reacts.includes('=❌'));
    eq('② 처음부터 다 막힘 · 켜짐 — 장부 모아 둠', ledgerRows().map((r) => [r.engine, r.outcome]), [['none', 'hold']]);
    s = await scenario({ watch: true, notice: false, before: allBlocked });
    ok('② 처음부터 다 막힘 · 꺼짐 — ⏳ · 「취소」 · ❌', allText(s.posts).includes('⏳') && cancelBtn(s.posts)
      && s.updates.at(-1) === '❌ *오류 발생*' && s.reacts.includes('=❌'));

    // ③ 칸이 막힌 게 아니라 실패해 모아 둠(계획 아님) — ⏸ 가 안 나가므로 켜져 있어도 ⏳ 그대로
    s = await scenario({ watch: true, replies: { 'flash-high': '그냥 글', 'sonnet-thinking': '역시 글' } });
    eq('③ 실패로 모아 둠 · 켜짐 — 차례 안 ⏸ 없음', s.turnNotices.filter((n) => n.startsWith('⏸')).length, 0);
    ok('③ 실패로 모아 둠 · 켜짐 — ⏳ · 「취소」 · ❌ 그대로', allText(s.posts).includes('⏳') && cancelBtn(s.posts)
      && s.updates.at(-1) === '❌ *오류 발생*');
    // ✋ 는 반응 표에 이름(raised_hand)이 있고 끝 상태 묶음에 들어 있어야 진행 중 반응(🤔 등)을 걷고 붙는다
    const sh = fs.readFileSync(path.join(ROOT, 'src', 'slack-handler.ts'), 'utf-8');
    ok('✋ 반응 이름 · 끝 상태 묶음', sh.includes("'✋': 'raised_hand'")
      && sh.includes("['white_check_mark', 'x', 'stop_button', 'clipboard', 'raised_hand']"));
  }

  // ================================================================ ⑩ 첨부 · 켜는 문 → agy 안 부름 · 개인 글은 agy 가 받음
  {
    const att = path.join(TMP, 'att.png');
    fs.writeFileSync(att, 'x');
    let s = await scenario({ event: { heldFiles: [{ path: att, name: 'att.png', mimetype: 'image/png', isImage: true, isText: false, size: 1 }] } });
    eq('첨부 — agy 를 안 부르고 모아 둠', [s.agy.length, bridge.failed.map((f) => f[1])], [0, ['limit']]);
    s = await scenario({ agy: false });
    eq('DM_FALLBACK_AGY 꺼짐 — agy 안 부름', [s.agy.length, bridge.failed.map((f) => f[1])], [0, ['limit']]);
    s = await scenario({ text: '비밀조각이 든 말', before: () => { privateTurn = true; } });
    eq('개인 글 — agy 가 받음 · 모아 두지 않음', [s.agy.length, bridge.failed.length], [1, 0]);
    ok('개인 글 — 사람 말을 그대로 넘김', (s.agy[0]?.prompt ?? '').includes('비밀조각이 든 말'));
  }

  // ================================================================ ⑪ needs_full — 답 + ⏸ + 모아 둠(명령이 돌았으면 partial)
  {
    let s = await scenario({ replies: { 'flash-high': plan({ reply: '등록은 했습니다. 메일 확인은 나중에 하겠습니다.', needs_full: true,
      needs_full_reason: '메일을 읽어야 함', actions: [{ op: 'add', title: '메일 회신 확인', est: 1, soft: '2026-10-16' }] }) } });
    const t = allText(s.posts);
    ok('⏸ 줄과 까닭', t.includes('⏸ 이 부분은 Claude·GPT 가 돌아오면 이어서 처리합니다 — 메일을 읽어야 함'));
    eq('명령은 돌았다', writes().map((c) => c.argv.slice(0, 2)), [['add', '--title=메일 회신 확인']]);
    eq('실패 표시 partial + needs full', bridge.failed.map((f) => [f[1], f[2]?.needs, f[2]?.hold]), [['partial', 'full', 'v2']]);
    eq('결과는 막힘(드레인이 멈춤) · 엔진 Gemini', [s.sink.outcome, s.sink.engine], ['limited', 'agy-gemini']);
    s = await scenario({ replies: { 'flash-high': plan({ reply: '메일 확인이 필요합니다.', needs_full: true, actions: [] }) } });
    eq('명령 없이 needs_full → limit + needs full', bridge.failed.map((f) => [f[1], f[2]?.needs]), [['limit', 'full']]);
    eq('버리지 않음', bridge.dropped, []);
    // 다시 돌리는 차례가 Claude·GPT 몫이면 agy 를 건너뛴다
    s = await scenario({ event: { replay: true, needsFull: true, captureId: 'cap-held', replayNote: '[밀린 요청]' } });
    eq('Claude·GPT 몫을 다시 돌림 — agy 안 부르고 모아 둠 · needs 유지', [s.agy.length, bridge.failed.map((f) => [f[1], f[2]?.needs])],
      [0, [['limit', 'full']]]);
  }

  // ================================================================ ⑫ 판에서 온 「조용히」 · GPT 가 쓴 뒤 끊김을 넘김
  {
    let s = await scenario({ event: { pushed: true }, replies: { 'flash-high': plan({ reply: '[조용히]',
      actions: [{ op: 'update', id: 'TSK-5', sets: { '상태': '진행중' } }] }) } });
    eq('다 그대로 됐으면 조용 — 답도 표시 줄도 없음',
      [markers(s.posts).length, s.posts.some((p) => /실행한 것|조용히/.test(String(p.text))), writes().length], [0, false, 1]);
    s = await scenario({ event: { pushed: true }, replies: { 'flash-high': plan({ reply: '[조용히]',
      actions: [{ op: 'update', id: 'TSK-5', sets: { '상태': '진행중' } }, { op: 'drop_all' }] }) } });
    const t = allText(s.posts);
    ok('안 된 것이 있으면 말한다(「조용히」는 빼고)', t.includes('*실행하지 않은 명령*') && !t.includes('[조용히]'));
    s = await scenario({ codexBlocked: false, codex: 'usage-after-write', replies: { 'flash-high': plan({ reply: '마무리했습니다.', actions: [] }) } });
    eq('GPT 가 쓰다 끊김 → Gemini 가 이어 받음', [s.codex.length, s.agy.map((c) => c.model)], [1, ['flash-high']]);
    const ca = s.codex[0]?.argv ?? [];
    const svcWant = require(path.join(ROOT, 'dist', 'model-ladder.js'))
      .serviceCodex(SlackHandler.resolveModelAlias(config.defaultModel), 'low');
    const want = svcWant?.model;
    eq('DM 의 GPT 모델은 서비스 폴백 대응표 · 깊이는 대화 차례의 것(low · luna 면 한 단계 위)',
      [ca[ca.indexOf('-m') + 1], ca.includes(`model_reasoning_effort=${svcWant?.effort}`)], [want ?? 'gpt-test-sol', true]);
    ok(`대응표 모델은 표의 것 — ${want}`, ['gpt-T-sol', 'gpt-T-luna'].includes(want));
    const p = s.agy[0]?.prompt ?? '';
    ok('넘겨줄 메모에 GPT 명령(완료)', p.includes('[앞 엔진(Claude·GPT)이') && p.includes('- 완료 · GPT 명령 · python -X utf8 bin/tasks.py log'));
    const mk = markers(s.posts)[0]?.text ?? '';
    ok(`넘겨받음 줄 — ${mk}`, mk.startsWith('↪ 앞 엔진이 하다 끊겨 Gemini T Flash (High) 가 이어서 마무리했습니다(이미 한 것: 1건)'));
    ok(`GPT 는 이 차례에 한도로 막힘 — ${mk}`, mk.includes('GPT 사용량 소진'));
  }

  // ================================================================ ⑬ -stop 이 agy 차례를 끊는다
  {
    reset();
    for (const k of SWITCHES) delete process.env[k];
    Object.assign(process.env, { DM_FALLBACK: 'on', DM_FALLBACK_AGY: 'on', HOLD_V2: 'on', FAKE_AGY_MODE: 'slow', FAKE_AGY_SLOW_MS: '8000' });
    setModes({});
    blockClaude();
    blockCodex();
    bridge.failed = [];
    const t = makeHandler();
    const a0 = agyCalls().length;
    const t0 = Date.now();
    const run = t.dm('끊을 말');
    for (let i = 0; i < 200 && agyCalls().length === a0; i++) await new Promise((r) => setTimeout(r, 50));
    t.h.activeProcesses.get('U_ME-D_DM-direct')?.interrupt();
    const sink = await run;
    ok(`끊으면 바로 끝난다(${Date.now() - t0}ms)`, Date.now() - t0 < 7500);
    eq('끊은 차례 — 명령 · 실패 표시 없음 · 결과 오류', [writes().length, bridge.failed.length, sink.outcome], [0, 0, 'error']);
    delete process.env.FAKE_AGY_MODE;
    delete process.env.FAKE_AGY_SLOW_MS;
  }

  // ================================================================ ⑬-2 명령 사이에 -stop — 끊김이다(「됨」 아님) · 다시 돌리던 것은 버림
  {
    reset();
    for (const k of SWITCHES) delete process.env[k];
    Object.assign(process.env, { DM_FALLBACK: 'on', DM_FALLBACK_AGY: 'on', HOLD_V2: 'on' });
    setModes({});
    setReplies({ 'flash-high': plan({ reply: '처리했습니다.', actions: [
      { op: 'log', id: 'TSK-5', text: 'SLOW-ME 첫 명령' }, { op: 'log', id: 'TSK-7', text: '안 돌아야 함' }] }) });
    blockClaude();
    blockCodex();
    bridge.failed = [];
    bridge.dropped = [];
    const t = makeHandler();
    const run = t.dm('다시 돌리는 말', { replay: true, pushed: true, captureId: 'cap-st', replayNote: '[밀린 요청]' });
    for (let i = 0; i < 200 && writes().length === 0; i++) await new Promise((r) => setTimeout(r, 50));
    await t.dm('-stop');
    const sink = await run;
    eq('명령 사이에 끊음 — 뒤 명령은 안 돎', writes().map((c) => c.argv.slice(0, 2)), [['log', '--id=TSK-5']]);
    eq('명령 사이에 끊음 — 다시 돌리던 것을 버림 · 실패 표시 없음 · 결과 오류',
      [bridge.dropped, bridge.failed.length, sink.outcome], [[['cap-st', '다시 돌리던 것을 사람이 끊음']], 0, 'error']);
    eq('명령 사이에 끊음 — 장부 끊김', ledgerRows().map((r) => r.outcome), ['stopped']);
    ok('명령 사이에 끊음 — 돈 것은 사람에게 보임', allText(t.posts).includes('*실행한 것*'));
  }

  // ================================================================ ⑬-3 보낼 글에 개인 글 조각 — GPT · agy 에 그대로 보냄(2026-10-19)
  //   사람 말에는 없고 넘겨줄 메모(앞 엔진이 돌린 명령의 인자)에만 있는 경우. 2026-10-15 에는 모아 뒀다 — 세 구독 모두
  //   학습 미사용이라 그 대화를 맡는 엔진에 보내는 것은 「나간다」가 아니다(실장 확인). 방으로 나가는 답은 개인 글 문이 본다.
  {
    reset();
    for (const k of SWITCHES) delete process.env[k];
    Object.assign(process.env, { DM_FALLBACK: 'on', DM_FALLBACK_AGY: 'on', HOLD_V2: 'on', FAKE_CODEX_MODE: 'ok-noop' });
    setModes({});
    setReplies({ 'flash-high': plan({ reply: '네', actions: [] }) });
    blockClaude();
    privateTurn = true;
    try {
      const priv = [{ id: 't1', name: 'Bash', input: 'tasks.py log --text 비밀조각', done: true, write: true }];
      for (const rung of ['codex', 'agy-gemini']) {
        bridge.failed = [];
        const t = makeHandler();
        const a0 = agyCalls().length;
        const c0 = fakeCodex.calls().length;
        const args = {
          event: { user: 'U_ME', channel: 'D_DM', ts: '1.1', text: '진행 남겨 줘' }, channel: 'D_DM',
          sessionKey: 'U_ME-D_DM-direct', ts: '1.1', captureId: 'cap-p', surfaceNote: '', slotMap: '', finalPrompt: '진행 남겨 줘',
          files: [], claudeSteps: priv, claudeModel: 'claude-opus-T', block: engineState.blocked('claude'), sessionId: 's',
          locale: 'ko', say: t.say, status: () => {}, nextAfter: async () => 'agy-claude',
        };
        const r = rung === 'codex' ? await t.h.runDmFallback(args)
          : await t.h.runAgyFallback({ ...args, rung, ladder: dmf.dmLadder() });
        const sent = rung === 'codex' ? fakeCodex.calls().slice(c0) : agyCalls().slice(a0);
        eq(`개인 글 조각(${rung}) — 그대로 보냄 · 답함 · 모아 두지 않음`,
          [r.result, sent.length, bridge.failed.length], ['ok', 1, 0]);
        ok(`개인 글 조각(${rung}) — 넘겨줄 메모에 실림`, (sent[0]?.prompt ?? '').includes('비밀조각'));
      }
    } finally {
      privateTurn = false;
    }
  }

  // ================================================================ ⑭ 드레인 — 어느 칸이든 비면 돈다 · 맡을 칸이 없는 건은 남긴다
  {
    for (const k of SWITCHES) delete process.env[k];
    reset();
    const t = makeHandler();
    blockClaude();
    eq('폴백 꺼짐 — 예전대로 Claude 막힘이면 안 돈다', t.h.drainBlocked(), true);
    process.env.DM_FALLBACK = 'on';
    eq('GPT 가 비었으면 돈다', t.h.drainBlocked(), false);
    blockCodex();
    eq('GPT 도 막히고 agy 칸 꺼짐 — 안 돈다', t.h.drainBlocked(), true);
    process.env.DM_FALLBACK_AGY = 'on';
    eq('agy 만 비었어도 돈다', t.h.drainBlocked(), false);
    engineState.recordBlocked('agy-gemini', { kind: 'usage' });
    engineState.recordBlocked('agy-claude', { kind: 'usage' });
    eq('넷 다 막힘 — 안 돈다', t.h.drainBlocked(), true);
    engineState.recordOk('agy-claude');
    const item = (o = {}) => ({ id: 'h1', text: '말', thread: null, tries: 0, channel: 'D_DM', ...o });
    eq('agy 만 남음 — 보통 건은 돌림', t.h.drainSkip(item()), false);
    eq('agy 만 남음 — Claude·GPT 몫은 남김', t.h.drainSkip(item({ needs: 'full' })), true);
    eq('agy 만 남음 — 첨부는 남김', t.h.drainSkip(item({ files: [{ path: 'x', name: 'x' }] })), true);
    privateTurn = true;
    eq('agy 만 남음 — 개인 글도 돌림(2026-10-19)', t.h.drainSkip(item({ text: '비밀조각' })), false);
    privateTurn = false;
    engineState.recordOk('codex');
    eq('GPT 가 비면 Claude·GPT 몫도 돌림', t.h.drainSkip(item({ needs: 'full' })), false);
    // 떠 보기는 Claude 가 맡을 칸일 때만 — 드레인 순서는 `drainHeld` 그대로, 남긴 건은 시도를 안 센다.
    const tried = [];
    const replayed = [];
    let summary = '';
    const rep = await hr.drainHeld({
      blocked: () => false, needsCanary: () => false, canary: async () => {},
      skip: (it) => it.id === 'skip-me',
      pending: async () => ({ run: [item({ id: 'skip-me' }), item({ id: 'go' })], tell: [] }),
      tried: async (id) => { tried.push(id); }, replay: async () => ({ outcome: 'ok' }),
      replayed: async (it) => { replayed.push(it.id); }, summary: async (s) => { summary = s; }, askOld: async () => {},
      gate: new hr.ChannelGate(), channelOf: () => 'D_DM',
    }, 10);
    eq('남긴 건은 시도를 안 셈 · 뒤는 계속', [tried, replayed, rep.skipped], [['go'], ['go'], 1]);
    eq('요약 한 줄', summary, '▶ 밀린 1건 처리 — 완료 1 · 확인 필요 0 · 1건은 맡을 엔진이 돌아온 뒤에');
    // 처리 중 기록 — 재시작으로 끊기면 무엇이 돌았나(검사가 소스 자리를 센다)
    const sh = fs.readFileSync(path.join(ROOT, 'src', 'slack-handler.ts'), 'utf-8');
    ok('드레인 문이 사다리를 본다', /blocked: \(\) => this\.drainBlocked\(\)/.test(sh) && /skip: \(it\) => this\.drainSkip\(it\)/.test(sh));
    ok('떠 보기는 Claude 가 맡을 때만', sh.includes("needsCanary: () => !engineState.isBlocked('claude') && needsCanary(engineState)"));
  }

  // ================================================================ ⑮ 예약 일 — 글 · 집중 한 줄 · 브리핑 · 회의 알림 판단
  {
    for (const k of SWITCHES) delete process.env[k];
    const sched = new AssistantScheduler(async () => {}, async () => { throw new Error('1차는 안 불려야 함'); }, config.assistant.configDir);
    sched.logger = silent;
    const run = (opts) => sched.spawnOrFallback('시험', '요약할 글', { workingDirectory: os.tmpdir(), ...opts });
    reset();
    blockClaude();
    setModes({});
    setReplies({ 'flash-high': '{"TSK-5":{"summary":"요약"}}' });
    let a0 = agyCalls().length;
    let r = await run({ tools: [], agyRung: 'text' });
    eq('꺼짐 — agy 칸 안 탐(사다리만)', [agyCalls().length - a0, r.isError], [0, true]);
    process.env.DM_FALLBACK_AGY = 'on';
    a0 = agyCalls().length;
    r = await run({ tools: [], agyRung: 'text', systemPrompt: '요약 규칙' });
    eq('켜짐 — 사다리(codex) 다음 Gemini', [agyCalls().slice(a0).map((c) => c.model), r.text, r.servedBy], [['flash-high'], '{"TSK-5":{"summary":"요약"}}', 'agy']);
    a0 = agyCalls().length;
    await run({ tools: [] });
    eq('agyRung 없는 일(분석 등)은 agy 칸 안 탐', agyCalls().length - a0, 0);
    setModes({ 'flash-high': 'quota' });
    setReplies({ 'sonnet-thinking': '요약 B' });
    a0 = agyCalls().length;
    r = await run({ tools: [], agyRung: 'text' });
    eq('Gemini 쿼터 → Sonnet', [agyCalls().slice(a0).map((c) => c.model), r.text], [['flash-high', 'sonnet-thinking'], '요약 B']);

    // 집중 한 줄 — codex 가 막혀도 agy 로 · 봇이 tasks.py focus 를 셸 없이(자동 표시)
    reset();
    blockClaude();
    blockCodex();
    setModes({});
    setReplies({ 'flash-high': '```json\n{"note":"보고서 초안 먼저 · 오늘 안에 듦","pick":["TSK-5"]}\n```' });
    a0 = agyCalls().length;
    r = await run({ tools: ['Bash', 'Read'], agyRung: 'focus', env: { ASSISTANT_MODE: 'focus', CLAUDE_SCHEDULED: '1' } });
    const f = writes().find((c) => c.argv[0] === 'focus');
    eq('집중 — tasks.py focus 를 인자 배열로 · 자동 표시', [f?.argv, f?.mode], [['focus', '--note=보고서 초안 먼저 · 오늘 안에 듦', '--pick=TSK-5'], 'focus']);
    ok('집중 — 재료(json --slim)를 프롬프트에', (agyCalls().slice(a0)[0]?.prompt ?? '').includes('[재료 — tasks.py json --slim 출력]'));
    eq('집중 — 결과', [r.isError, r.text], [false, '집중 표시: 보고서 초안 먼저 · 오늘 안에 듦']);
    setReplies({ 'flash-high': '{"note":"x","pick":["TSK-99"]}', 'sonnet-thinking': '{"note":"y\\nz"}' });
    const before = writes().length;
    r = await run({ tools: ['Bash', 'Read'], agyRung: 'focus' });
    eq('집중 — 문을 못 지나면 안 씀 · 실패로 돌려줌', [writes().length - before, r.isError], [0, true]);

    // 브리핑 — tasks.py brief 를 재료로 · 읽기만
    setReplies({ 'flash-high': '☀️ 10월 14일 브리핑 — 대체 엔진' });
    a0 = agyCalls().length;
    r = await run({ allowedTools: ['Read', 'Glob', 'Grep'], agyRung: 'briefing' });
    const bp = agyCalls().slice(a0)[0]?.prompt ?? '';
    ok('브리핑 — 재료와 안내', bp.includes('[재료 — tasks.py brief 출력]\n브리핑 재료 — 시험용 한 줄') && bp.includes('대체 엔진 안내'));
    eq('브리핑 — 본문 · 쓰기 없음', [r.text, writes().filter((c) => c.argv[0] !== 'focus').length], ['☀️ 10월 14일 브리핑 — 대체 엔진', 0]);
    setModes({ 'flash-high': 'quota', 'sonnet-thinking': 'quota' });
    r = await run({ allowedTools: ['Read'], agyRung: 'briefing' });
    ok('브리핑 — agy 도 한도면 실패로(한도 글을 브리핑으로 안 올림)', r.isError === true && !/exhausted|429/.test(r.text));

    // 회의 알림 판단
    reset();
    setModes({});
    setReplies({ 'flash-high': '[{"eventId":"e1","notifyAt":"2026-10-14T06:00:00Z","message":"회의","type":"change"}]' });
    const cp = new CalendarPoller(async () => {}, async () => ({}), TMP, () => null, () => {}, () => true);
    cp.logger = silent;
    a0 = agyCalls().length;
    const got = await cp.judgeByLadder('판단해', { added: [], removed: [], modified: [] }, 10, '시험');
    eq('회의 알림 판단 — Gemini 가 받음', [agyCalls().slice(a0).map((c) => c.model), got?.length], [['flash-high'], 1]);
    ok('회의 알림 판단 — 판단 규칙을 시스템으로', (agyCalls().slice(a0)[0]?.prompt ?? '').startsWith('<system>\nYou judge calendar events'));
    delete process.env.DM_FALLBACK_AGY;
    a0 = agyCalls().length;
    await cp.judgeByLadder('판단해', { added: [], removed: [], modified: [] }, 10, '시험');
    eq('회의 알림 판단 — 꺼지면 agy 칸 안 탐', agyCalls().length - a0, 0);
  }

  // ================================================================ ⑰ 서비스 폴백 대응표 · 깊이 한 단계 위(luna)
  {
    const ml = require(path.join(ROOT, 'dist', 'model-ladder.js'));
    eq('opus → sol', ml.serviceCodex('opus'), { alias: 'sol', model: 'gpt-T-sol' });
    eq('opus low → sol low(깊이 그대로)', ml.serviceCodex('opus', 'low'), { alias: 'sol', model: 'gpt-T-sol', effort: 'low' });
    eq('sonnet low → luna medium', ml.serviceCodex('sonnet', 'low')?.effort, 'medium');
    eq('haiku high → luna xhigh', ml.serviceCodex('haiku', 'high')?.effort, 'xhigh');
    eq('luna max → max 그대로', ml.serviceCodex('haiku', 'max')?.effort, 'max');
    eq('1차 깊이가 없으면 깊이 없음(사다리 칸 기본)', ml.serviceCodex('sonnet')?.effort, undefined);
    eq('좁은 길 깊이 — opus 는 low 그대로', wa.narrowCodexEffort('opus'), 'low');
    eq('좁은 길 깊이 — sonnet 이면 medium', wa.narrowCodexEffort('sonnet'), 'medium');
    eq('sonnet · haiku → luna', [ml.serviceCodex('sonnet')?.model, ml.serviceCodex('haiku')?.model], ['gpt-T-luna', 'gpt-T-luna']);
    eq('id 로 와도 맞춘다(별칭표 · 집안 이름 · [1m] 꼬리)',
      [ml.serviceCodex('claude-opus-T')?.model, ml.serviceCodex('claude-sonnet-T[1m]')?.model, ml.serviceCodex('claude-haiku-9-9')?.model],
      ['gpt-T-sol', 'gpt-T-luna', 'gpt-T-luna']);
    eq('모르는 모델 → 없음', ml.serviceCodex('gpt-x'), null);
    const noSf = path.join(TMP, 'no-sf.json');
    const { service_fallback: _drop, ...old } = TABLE;
    fs.writeFileSync(noSf, JSON.stringify(old), 'utf-8');
    eq('표에 칸이 없으면 없음(옛 길로)', ml.serviceCodex('opus', 'low', noSf), null);
    delete process.env.BOARD_NARROW_CODEX_MODEL;
    eq('좁은 길 — 대응표', wa.narrowCodexModel('opus'), 'gpt-T-sol');
    process.env.BOARD_NARROW_CODEX_MODEL = 'gpt-env-override';
    eq('좁은 길 — 환경 변수가 이긴다', wa.narrowCodexModel('opus'), 'gpt-env-override');
    delete process.env.BOARD_NARROW_CODEX_MODEL;
    process.env.LLM_PLAYBOOK_MODELS = noSf;
    const dflt = wa.narrowCodexModel('opus');
    ok(`좁은 길 — 표에 칸이 없으면 예전 기본값(${dflt})`, !!dflt && !dflt.startsWith('gpt-T-'));
    // agy 칸 별칭 순서도 표에서 — 뒤집으면 따라온다
    fs.writeFileSync(noSf, JSON.stringify({ ...TABLE, service_fallback: { ...TABLE.service_fallback, agy: ['sonnet-thinking', 'flash-high'] } }), 'utf-8');
    eq('agy 칸 별칭은 service_fallback.agy 순서', [agy.agyModel('agy-gemini').alias, agy.agyModel('agy-claude').alias],
      ['sonnet-thinking', 'flash-high']);
    process.env.LLM_PLAYBOOK_MODELS = ENV.LLM_PLAYBOOK_MODELS;
    // 실제 표(있으면) — 사용자 결정의 대응이 그대로 앉았나
    const real = path.resolve(ROOT, '..', 'llm-playbook', 'llm_playbook', 'models.json');
    if (fs.existsSync(real) && JSON.parse(fs.readFileSync(real, 'utf-8')).service_fallback) {
      // 사용자 대응표(2026-10-14 정본) 15칸 — 1차 모델 · 깊이마다 GPT 「별칭 깊이」
      const WANT = {
        opus: { low: 'sol low', medium: 'sol high', high: 'sol high', xhigh: 'sol xhigh', max: 'sol max' },
        sonnet: { low: 'sol low', medium: 'sol low', high: 'sol medium', xhigh: 'sol high', max: 'sol xhigh' },
        haiku: { low: 'luna medium', medium: 'luna high', high: 'luna xhigh', xhigh: 'sol low', max: 'sol low' },
      };
      const got = Object.fromEntries(Object.entries(WANT).map(([f, row]) => [f, Object.fromEntries(Object.keys(row)
        .map((e) => { const r = ml.serviceCodex(f, e, real); return [e, r ? `${r.alias} ${r.effort}` : null]; }))]));
      eq('실제 표 — 대응표 15칸', got, WANT);
      eq('실제 표 — 깊이를 모르면 high 줄 · 전체 id 도', [ml.serviceCodex('sonnet', undefined, real)?.effort,
        ml.serviceCodex('claude-opus-5-5', 'medium', real)?.model], ['medium', 'gpt-6.1-sol']);
    }
  }

  // ================================================================ ⑰-2 엔진 안내의 GPT 이름 — DM 방의 모델 기준(2026-10-15 검토)
  //   전에는 기본 모델의 칸을 따로 읽어, DM 방의 모델(`-model`)이 다르면 안내와 실제로 부르는 모델이 어긋났다.
  {
    const ml = require(path.join(ROOT, 'dist', 'model-ladder.js'));
    const want = (m) => ml.serviceCodex(SlackHandler.resolveModelAlias(m), 'low')?.model;
    ok(`시험이 가를 수 있다 — opus ${want('opus')} · haiku ${want('haiku')}`, want('opus') && want('opus') !== want('haiku'));
    const t = makeHandler();
    const saved = config.defaultModel;
    try {
      config.defaultModel = 'haiku';
      t.h.channelModels.set('D_DM', 'opus');
      eq('안내 GPT 이름 — DM 방의 모델(opus)의 칸', t.h.engineNoticeLabels().codex, want('opus'));
      t.h.channelModels.delete('D_DM');
      eq('안내 GPT 이름 — 방 모델이 없으면 기본 모델(haiku)의 칸', t.h.engineNoticeLabels().codex, want('haiku'));
    } finally {
      config.defaultModel = saved;
    }
  }

  // ================================================================ ⑯ 판 번호를 소스에 적지 않는다
  {
    const SRC = path.join(ROOT, 'src');
    const VERSION = /gpt-\d|GPT-\d|claude-(opus|sonnet|haiku)-\d|\b(Opus|Sonnet|Haiku) \d|Gemini \d+(\.\d+)?\s*(Flash|Pro|Ultra)|gemini-\d|\d\.\d+ Flash/;
    // 허용 — 표를 못 읽을 때의 기본값 상수 둘(환경 변수가 이기고 대응표가 그다음)뿐. 이 밖의 새 글자는 실패.
    const ALLOWED = [
      /^const NARROW_CODEX_MODEL = '[^']+';/,
      /^export const SESSION_CODEX_MODEL = process\.env\.SESSION_FALLBACK_CODEX_MODEL \|\| '[^']+';/,
    ];
    const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
    const bad = [];
    for (const f of fs.readdirSync(SRC).filter((x) => x.endsWith('.ts'))) {
      for (const line of strip(fs.readFileSync(path.join(SRC, f), 'utf-8')).split(/\r?\n/)) {
        for (const m of line.matchAll(/(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/g)) {
          if (VERSION.test(m[2]) && !ALLOWED.some((re) => re.test(line.trim()))) bad.push(`${f}: ${line.trim().slice(0, 80)}`);
        }
      }
    }
    eq('허용한 기본값 상수는 둘 다 실제로 있다(낡은 허용 목록 방지)',
      ALLOWED.map((re) => strip(fs.readFileSync(path.join(SRC, 'work-assistant.ts'), 'utf-8')).split(/\r?\n/).some((l) => re.test(l.trim()))),
      [true, true]);
    eq('소스의 글자에 모델 판 번호가 없다', bad, []);
    const whole = ['agy-turn.ts', 'agy-actions.ts', 'dm-fallback.ts', 'engine-ladder.ts', 'engine-notice.ts']
      .filter((f) => VERSION.test(fs.readFileSync(path.join(SRC, f), 'utf-8')));
    eq('6단계 파일은 주석까지 판 번호 없음', whole, []);
  }
} finally {
  fakeCodex.cleanup();
  fakeAgy.cleanup();
  fs.rmSync(TMP, { recursive: true, force: true });
}

if (fails.length) {
  console.error(`실패 ${fails.length}건\n`);
  for (const f of fails) console.error('  ✗ ' + f);
  process.exitCode = 1;
} else {
  console.log('통과 — agy 칸 (사다리 Gemini → agy Sonnet · 첨부 · Claude·GPT 몫 · 개인 글도 넘김 · 막힘만 건너뜀(횟수 상한 없음) · 대응표 모델 · luna 깊이 한 단계 위 · '
    + '계획 너그럽게 읽기 · 쿼터는 끝 줄로 · 허용 목록 여덟 · 셸 없이 인자 배열 · 캡처 환경 · 앞이 실패하면 멈춤 · '
    + '실행한 것 · 실행하지 않은 명령 · 표시 이름은 표에서 · needs_full 은 모아 둠(partial) · 조용히 · GPT 가 한 것을 넘김 · '
    + '-stop · 드레인은 어느 칸이든 · 남긴 건은 시도 안 셈 · 예약 일 넷 · 판 번호 없음 · 일부 실패는 「됨」 아님 · 명령마다 기록 · 명령 사이 끊김 · 보낼 글의 개인 글도 넘김 · 안내 GPT 이름은 DM 방 모델 · 한 차례에 안내 하나 · 다 막히면 「⏸ 모아 둠」)');
}
process.exit(process.exitCode ?? 0);
