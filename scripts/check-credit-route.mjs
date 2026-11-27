/**
 * API 크레딧 물길 — 봇 세션이 크레딧 장부 하나의 답대로 띄워지고, 크레딧 오류가 구독 Claude 의 막힘으로 안 보이는가.
 *
 *   npm run build
 *   npm run check:creditroute
 *
 * 2026-11-27 사용자 결정 「크레딧물꼬」 — 크레딧을 쓸지는 장부(`~/.config/llm-playbook/api-credits.json`)의 물길 하나가 정한다.
 * 봇은 `python -m llm_playbook.credits pick` 의 답만 받는다(`src/credit-route.ts`). 여기서 재는 것:
 *
 *   ① 장부가 null → 세션은 구독(키 없음 · 구독 토큰 그대로)
 *   ② 장부가 키 → 그 키 파일의 키 · 구독 토큰 없음
 *   ③ 아무것도 내보내기 전의 크레딧 오류 → 그 키를 막고 같은 차례를 구독으로 다시 · 구독 Claude(`claude`)는 안 막힘
 *   ④ 도구를 돌린 뒤의 크레딧 오류 → 다시 안 띄움 · 키는 막음 · 결과 글에 한도 낱말이 없어 `claude` 를 안 막음
 *   ⑤ 쓴 금액 → 키 이름과 함께 `credits record` · 이어 받은 세션은 늘어난 만큼만
 *   ⑥ 크레딧을 명시한 칸(`billing: 'api'`) → 다시 안 띄우고 키만 막음 · 엔진 `claude-api`
 *   ⑦ 진짜 파이썬 명령 + 임시 장부 — `pick` 의 한 줄을 읽음(물길 all → 키 · site → null)
 *
 * **진짜 장부 · 진짜 키 · 외부 API 를 안 쓴다** — 장부 명령은 바꿔 끼우고(⑦만 임시 장부에 진짜 파이썬), SDK 는 가짜 흐름이다.
 */
import './lib/fresh-dist.mjs';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const fails = [];
const ok = (label, cond) => { if (!cond) fails.push(label); };
const eq = (label, got, want) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) fails.push(`${label}\n    받음 ${JSON.stringify(got)}\n    기대 ${JSON.stringify(want)}`);
};

const cr = require(path.join(DIST, 'credit-route.js'));
const { SdkHandler } = require(path.join(DIST, 'sdk-handler.js'));
const { engineState } = require(path.join(DIST, 'engine-state.js'));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'check-credit-route-'));
const keyFile = path.join(TMP, 'key');
// 가짜 키 — 소스에 키 모양 글자를 두지 않는다(공개 저장소 검사가 자격 증명으로 본다).
const KEY = ['sk', 'ant', 'check', 'only', 'r'.repeat(40)].join('-');
fs.writeFileSync(keyFile, KEY);
const isKey = (k) => k.toUpperCase() === 'ANTHROPIC_API_KEY';
const keyOf = (env) => Object.entries(env ?? {}).find(([k]) => isKey(k))?.[1];

// ── 장부 명령 바꿔 끼우기 — 물길대로(`pick`)와 크레딧 명시(`pick --credits true`)의 답을 따로 준다 ──────────
const ledger = { route: null, forced: null };
const calls = [];
const realRun = cr.runner.run;
cr.runner.run = (args, sync) => {
  calls.push(args);
  let out = '';
  if (args[0] === 'pick') out = JSON.stringify(args.includes('--credits') ? ledger.forced : ledger.route);
  return sync ? out : Promise.resolve(out);
};
const blocks = () => calls.filter((a) => a[0] === 'block').map((a) => a[a.indexOf('--key') + 1]);
const records = () => calls.filter((a) => a[0] === 'record').map((a) => ({
  key: a[a.indexOf('--key') + 1], usd: Number(a[a.indexOf('--usd') + 1]),
  caller: a[a.indexOf('--caller') + 1], session: a.includes('--session') ? a[a.indexOf('--session') + 1] : null,
}));

// ── 가짜 SDK — 띄운 옵션을 적고, 차례마다 정해 둔 흐름을 낸다 ───────────────────────────────────────
const spawned = [];
let scripts = [];
SdkHandler.queryFn = ({ prompt, options }) => {
  const evs = scripts.shift() ?? [];
  spawned.push({ prompt, key: keyOf(options.env), oauth: options.env?.CLAUDE_CODE_OAUTH_TOKEN, resume: options.resume ?? null });
  return (async function* () { for (const e of evs) yield e; })();
};
const h = new SdkHandler({ getServerConfiguration: () => ({}), getDefaultAllowedTools: () => [] });

const init = (sid) => ({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-check' });
const say = (t, sid) => ({ type: 'assistant', session_id: sid, message: { content: [{ type: 'text', text: t }] } });
const tool = (sid) => ({ type: 'assistant', session_id: sid, message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: {} }] } });
const toolResult = (sid) => ({ type: 'user', session_id: sid, message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }] } });
const ok_ = (t, sid, cost) => ({ type: 'result', subtype: 'success', is_error: false, result: t, session_id: sid, total_cost_usd: cost });
const CREDIT = 'Credit balance too low · Add funds: https://platform.claude.com/settings/billing';
const SPEND = 'API Error: 400 You have reached your specified API usage limits. You will regain access on 2026-12-01';
const creditMsg = (sid, text = CREDIT) => ({ type: 'assistant', error: 'billing_error', session_id: sid, message: { content: [{ type: 'text', text }] } });
const creditResult = (sid, text = CREDIT) => ({ type: 'result', subtype: 'success', is_error: true, result: text, session_id: sid, total_cost_usd: 0 });

const env = { CLAUDE_CODE_OAUTH_TOKEN: 'oauth-check' };
const opts = (extra = {}) => ({ workingDirectory: os.tmpdir(), env: { ...env, WORK_ASSISTANT_CAPTURE_FILE: 'x' }, ...extra });
const reset = (route, forced = route) => {
  cr.forget();
  ledger.route = route; ledger.forced = forced;
  calls.length = 0; spawned.length = 0; scripts = [];
  engineState.recordOk('claude');
  engineState.recordOk('claude-api');
};
const drain = async (proc) => { const out = []; for await (const e of proc) out.push(e); await cr.settle(); return out; };
const MAX = { name: 'max', key_file: keyFile };

try {
  // ① 장부 null → 구독 ---------------------------------------------------------------------------------
  reset(null, MAX);
  scripts = [[init('s1'), say('답', 's1'), ok_('답', 's1', 0.4)]];
  let evs = await drain(h.runQuery('말', opts()));
  eq('① 장부 null — 키 없이 구독 토큰 그대로', [spawned.length, spawned[0]?.key ?? null, spawned[0]?.oauth], [1, null, 'oauth-check']);
  eq('① 장부 null — 쓴 금액을 안 적음 · 막지 않음', [records().length, blocks().length], [0, 0]);
  eq('① 장부 null — 흐름 그대로', evs.map((e) => e.type), ['system', 'assistant', 'result']);

  // ② 장부가 키 → 그 키 ----------------------------------------------------------------------------------
  reset(MAX, null);
  scripts = [[init('s2'), say('답', 's2'), ok_('답', 's2', 0.25)]];
  evs = await drain(h.runQuery('말', opts()));
  eq('② 장부 키 — 그 키 파일의 키 · 구독 토큰 없음', [spawned[0]?.key === KEY, spawned[0]?.oauth ?? null], [true, null]);
  eq('② 장부 키 — 흐름 그대로(시작 알림 포함)', evs.map((e) => e.type), ['system', 'assistant', 'result']);
  // ⑤ 쓴 금액 — 키 이름과 함께
  eq('⑤ 쓴 금액 — 키 이름 · 금액 · 부른 곳 · 세션', records(), [{ key: 'max', usd: 0.25, caller: 'bot:chat', session: 's2' }]);

  // ⑤ 이어 받은 세션 — 처음 보는 세션은 안 세고, 본 세션은 늘어난 만큼만
  reset(MAX, null);
  const sess = { sessionId: 'old-1', lastAssistantUuid: undefined };
  scripts = [[init('old-1'), ok_('a', 'old-1', 3.0)], [init('old-1'), ok_('b', 'old-1', 3.5)]];
  await drain(h.runQuery('말', opts({ session: sess })));
  await drain(h.runQuery('말', opts({ session: sess })));
  eq('⑤ 이어 받은 세션 — 처음은 0 · 다음은 늘어난 0.5', records().map((r) => r.usd), [0.5]);

  // ③ 내보내기 전 크레딧 오류 → 키 막고 같은 차례를 구독으로 ----------------------------------------------
  reset(MAX, null);
  scripts = [
    [init('c1'), { type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }, creditMsg('c1'), creditResult('c1')],
    [init('sub1'), say('구독 답', 'sub1'), ok_('구독 답', 'sub1', 0.3)],
  ];
  evs = await drain(h.runQuery('같은 말', opts()));
  eq('③ 띄운 수 · 둘째는 구독 · 같은 말', [spawned.length, spawned[1]?.key ?? null, spawned[1]?.oauth, spawned[1]?.prompt],
    [2, null, 'oauth-check', '같은 말']);
  eq('③ 그 키를 막음', blocks(), ['max']);
  ok('③ 크레딧 글이 밖으로 안 나감', !JSON.stringify(evs).includes('Credit balance'));
  eq('③ 내보낸 것은 구독 세션의 것만', evs.filter((e) => e.type === 'system').map((e) => e.session_id), ['sub1']);
  eq('③ 구독 답이 결과', evs.filter((e) => e.type === 'result').map((e) => e.result), ['구독 답']);
  eq('③ 구독 Claude 는 안 막힘', engineState.isBlocked('claude'), false);
  eq('③ 구독 세션의 금액은 크레딧에 안 적음', records().length, 0);
  // 막은 뒤 같은 키를 다시 안 고름(장부가 아직 그 키를 줘도)
  scripts = [[init('n1'), ok_('x', 'n1', 0.1)]];
  await drain(h.runQuery('다음 말', opts()));
  eq('③ 다음 차례는 막은 키를 안 씀', spawned[2]?.key ?? null, null);

  // ③-2 지출 한도 글(결과만 · error 칸 없이)도 같은 길
  reset(MAX, null);
  scripts = [[init('c2'), creditResult('c2', SPEND)], [init('sub2'), ok_('구독', 'sub2', 0.1)]];
  evs = await drain(h.runQuery('말', opts()));
  eq('③-2 지출 한도 — 막고 구독으로 다시', [blocks(), spawned.length, engineState.isBlocked('claude')], [['max'], 2, false]);

  // ③-3 SDK 가 던진 크레딧 오류(내보내기 전)도 같은 길
  reset(MAX, null);
  let threwOnce = true;
  const realQ = SdkHandler.queryFn;
  SdkHandler.queryFn = (a) => {
    if (threwOnce) {
      threwOnce = false;
      spawned.push({ prompt: a.prompt, key: keyOf(a.options.env) });
      return (async function* () { yield init('t1'); throw new Error('Invalid API key · Please run /login'); })();
    }
    return realQ(a);
  };
  scripts = [[init('sub3'), ok_('구독', 'sub3', 0.1)]];
  evs = await drain(h.runQuery('말', opts()));
  SdkHandler.queryFn = realQ;
  eq('③-3 던진 키 거부 — 막고 구독으로', [blocks(), spawned.length, spawned[1]?.key ?? null, evs.at(-1)?.result], [['max'], 2, null, '구독']);
  eq('③-3 구독 Claude 는 안 막힘', engineState.isBlocked('claude'), false);

  // ④ 도구를 돌린 뒤 크레딧 오류 → 다시 안 띄움 --------------------------------------------------------
  reset(MAX, null);
  scripts = [[init('w1'), tool('w1'), toolResult('w1'), creditMsg('w1', SPEND), creditResult('w1', SPEND)]];
  evs = await drain(h.runQuery('쓰는 말', opts()));
  eq('④ 다시 안 띄움', spawned.length, 1);
  eq('④ 그 키를 막음', blocks(), ['max']);
  const r4 = evs.filter((e) => e.type === 'result');
  eq('④ 결과는 오류로 끝남', r4.map((e) => e.is_error), [true]);
  ok('④ 결과 글에 한도 · 크레딧 원문이 없음', !/usage limit|credit balance/i.test(String(r4[0]?.result ?? '')));
  ok('④ 대신 만든 오류 메시지는 안 내보냄', !evs.some((e) => e.type === 'assistant' && e.error));
  eq('④ 구독 Claude 는 안 막힘', engineState.isBlocked('claude'), false);

  // ④-2 크레딧 오류가 아닌 오류(과부하)는 그대로 — 다시 안 띄우고 막지 않음 · 엔진 상태가 그대로 받음
  reset(MAX, null);
  scripts = [[init('o1'), { type: 'result', subtype: 'success', is_error: true, result: 'API Error: 529 Overloaded', session_id: 'o1', total_cost_usd: 0 }]];
  evs = await drain(h.runQuery('말', opts()));
  eq('④-2 과부하 — 그대로 · 키 안 막음 · 구독 Claude 과부하로 적힘',
    [spawned.length, blocks().length, engineState.blocked('claude')?.kind], [1, 0, 'overload']);

  // ⑥ 크레딧을 명시한 칸 — 다시 안 띄우고 키만 막음 · 엔진 claude-api ------------------------------------
  reset(null, MAX);
  scripts = [[init('a1'), creditMsg('a1'), creditResult('a1')]];
  const p6 = h.runQuery('말', opts({ billing: 'api', model: 'sonnet' }));
  evs = await drain(p6);
  eq('⑥ API 칸 — 크레딧 명시로 묻고 키로 띄움', [calls.some((a) => a.join(' ') === 'pick --credits true'), spawned[0]?.key === KEY], [true, true]);
  eq('⑥ API 칸 — 다시 안 띄움 · 키 막음', [spawned.length, blocks()], [1, ['max']]);
  eq('⑥ API 칸 — claude-api 만 막힘', [engineState.isBlocked('claude-api'), engineState.isBlocked('claude')], [true, false]);
  ok('⑥ API 칸 — 오류 결과는 그대로(그 칸이 다음 칸으로 넘김)', evs.some((e) => e.type === 'result' && String(e.result).includes('Credit balance')));

  // 중단 — 크레딧 오류 뒤 이미 끊긴 차례는 다시 안 띄움
  reset(MAX, null);
  scripts = [[init('x1'), creditResult('x1')], [ok_('안 와야 함', 'x2', 0)]];
  const p7 = h.runQuery('말', opts());
  p7.interrupt();
  await drain(p7);
  eq('끊긴 차례 — 다시 안 띄움', spawned.length, 1);

  // 미리 띄운 세션 — 장부가 키를 주면 같은 키로 띄우고 맞으면 씀, 장부가 바뀌면 안 맞음
  reset(MAX, null);
  h.prewarm(opts({ noSessionPersistence: true }));
  scripts = [[init('pw'), ok_('답', 'pw', 0.1)]];
  await drain(h.runQuery('말', opts({ noSessionPersistence: true })));
  eq('미리 띄움 — 키로 띄우고 그 자리를 씀', [spawned.length, spawned[0]?.key === KEY, h.warmCount], [1, true, 0]);
  h.prewarm(opts({ noSessionPersistence: true }));
  cr.forget(); ledger.route = null;
  scripts = [[], [init('pw2'), ok_('답', 'pw2', 0.1)]];
  await drain(h.runQuery('말', opts({ noSessionPersistence: true })));
  eq('미리 띄움 — 장부가 구독으로 돌면 키 든 자리를 안 씀', [spawned.length, spawned.at(-1)?.key ?? null], [3, null]);
  h.dropAllWarm('검사 끝');

  // ⑦ 진짜 파이썬 명령 + 임시 장부 -------------------------------------------------------------------------
  cr.runner.run = realRun;
  const py = spawnSync('python', ['-X', 'utf8', '-c', 'import llm_playbook.credits'], { encoding: 'utf-8', windowsHide: true });
  if (py.status !== 0) {
    fails.push('⑦ llm_playbook 을 못 불러옴 — 진짜 명령 장면을 못 잼(판정 불가)');
  } else {
    const ledgerFile = path.join(TMP, 'api-credits.json');
    const before = process.env.LLM_PLAYBOOK_CREDITS;
    process.env.LLM_PLAYBOOK_CREDITS = ledgerFile;
    const future = new Date(Date.now() + 10 * 86400_000).toISOString().slice(0, 10);
    const write = (route) => fs.writeFileSync(ledgerFile, JSON.stringify({ v: 1, enabled: true, route, keys: {
      max: { key_file: keyFile, grant_usd: 100, expires: future, spent_usd: 0, daily: {} } } }));
    try {
      write('all');
      cr.forget();
      eq('⑦ 물길 all — 진짜 pick 이 키를 줌', cr.currentPick('route'), { name: 'max', keyFile });
      write('site');
      cr.forget();
      eq('⑦ 물길 site — 물길대로는 null(구독)', cr.currentPick('route'), null);
      eq('⑦ 물길 site — 크레딧 명시는 키', cr.currentPick('forced')?.name, 'max');
      cr.recordSpend('max', 0.125, { caller: 'check' });
      await cr.settle();
      eq('⑦ record — 장부에 더해짐', JSON.parse(fs.readFileSync(ledgerFile, 'utf-8')).keys.max.spent_usd, 0.125);
      cr.blockKey('max', 'check');
      await cr.settle();
      ok('⑦ block — 장부에 막힘', !!JSON.parse(fs.readFileSync(ledgerFile, 'utf-8')).keys.max.blocked);
      eq('⑦ block 뒤 — 크레딧 명시도 null', cr.currentPick('forced'), null);
      process.env.CREDIT_ROUTE_PYTHON = path.join(TMP, 'no-such-python.exe');
      cr.forget();
      eq('⑦ 명령 실패 — null(구독)', cr.currentPick('route'), null);
      delete process.env.CREDIT_ROUTE_PYTHON;
    } finally {
      if (before === undefined) delete process.env.LLM_PLAYBOOK_CREDITS;
      else process.env.LLM_PLAYBOOK_CREDITS = before;
    }
  }
} finally {
  cr.runner.run = realRun;
  cr.forget();
  await cr.settle();
  fs.rmSync(TMP, { recursive: true, force: true });
}

if (fails.length) {
  console.log(`실패 ${fails.length}건\n`);
  for (const f of fails) console.log('  ✗ ' + f);
  process.exitCode = 1;
} else {
  console.log('통과 — 장부 null 은 구독 · 키는 그 키 · 내보내기 전 크레딧 오류는 키 막고 구독으로 다시 · 도구 뒤는 다시 안 함 · 쓴 금액 기록 · 진짜 pick 읽기');
}
