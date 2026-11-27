/**
 * 계정 전환 · API 키 전환이 다시 안 들어오고, 계정 하나의 토큰 동기화는 남아 있는가.
 *
 *   npm run check:noaccounts     (먼저 `npm run build`)
 *
 * 2026-10-14 사용자 결정으로 여러 계정 사이 전환 · 「API 키로 계속」 · 인사 예약을 걷었다.
 * 한도 소진은 엔진 폴백(좁은 길 · 예약 세션)과 보류 재실행(캡처 큐 드레인)이 대신한다.
 *
 * **걷은 것만 세면 반쪽이다** — 토큰 동기화까지 같이 지워지면 봇 세션이 터미널 로그인을
 * 못 따라가 조용히 인증 실패로 넘어진다. 그래서 없어야 할 것과 있어야 할 것을 같이 센다.
 *
 * **API 키는 나가는 문에서 뺀다** — PC 환경 변수에 키가 남아 있으면 세션이 구독 대신 그 키로
 * 과금된다. SDK 옵션에 시험용 키를 심어 제거 여부를 확인한다. 진짜 세션은 실행하지 않는다.
 *
 * **키를 넣는 것은 크레딧 장부가 키를 줄 때뿐**(2026-11-27 「크레딧물꼬」) — 고르기 · 환경 · 장부 명령이 `credit-route.ts` 한 곳에만
 * 있는지 소스에서 센다. 크레딧 오류 · 다시 띄우기 · 쓴 금액 장면은 `check:creditroute`.
 */
import './lib/fresh-dist.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');
const HELPER = 'child-env.ts';

const fails = [];
const ok = (label, cond) => { if (!cond) fails.push(label); };

const files = fs.readdirSync(SRC).filter((f) => f.endsWith('.ts'));
// 줄바꿈을 맞춘다 — 작업 트리가 CRLF 여도 아래 본문 자르기가 같게 돈다.
const all = Object.fromEntries(files.map((f) => [f, fs.readFileSync(path.join(SRC, f), 'utf-8').replace(/\r\n/g, '\n')]));

// ── ① 걷은 것이 다시 안 들어왔나 — 버튼 · 함수 · 파일 이름 ─────────────────
const GONE = [
  'switch_account_retry', 'continue_with_apikey', 'open_apikey_modal', 'apikey_modal',
  'account_switch_btn', 'account_use_btn', 'account_set_btn', 'account_unset_btn',
  'account_setup_next', 'account_setup_cancel', 'schedule_retry',
  'getNextAccount', 'switchTo(', 'captureForSlot', 'apiKeyActive', 'userApiKeys',
  'pendingRetries', '.bot-api-keys.json', 'schedule-manager', 'ScheduleManager',
];
for (const name of GONE) {
  const where = files.filter((f) => all[f].includes(name));
  ok(`「${name}」 이 남았다 — ${where.join(' · ')}`, where.length === 0);
}
ok('src/schedule-manager.ts 가 남았다', !fs.existsSync(path.join(SRC, 'schedule-manager.ts')));
// 키 이름은 빼는 함수 한 곳에만 — 다른 곳에 있으면 그것이 키를 넣는 길이다.
ok(`빼는 함수 파일(${HELPER})이 없다`, files.includes(HELPER));
const keyAt = files.filter((f) => f !== HELPER && all[f].includes('ANTHROPIC_API_KEY'));
ok(`API 키 이름이 ${HELPER} 밖에 있다 — ${keyAt.join(' · ')}`, keyAt.length === 0);

// ── ② 계정 하나의 토큰 동기화는 남았나 ──────────────────────────────────────
const am = all['account-manager.ts'] ?? '';
for (const sig of ['async getAccessToken(', 'syncFromCredentialsFile(): void', 'async checkTokenHealth(',
                   'private startCredentialsWatcher(', 'private syncToCredentialsFile(', 'destroy(): void']) {
  ok(`account-manager.ts 에서 「${sig}」 이 빠졌다`, am.includes(sig));
}
// 지금 쓰는 파일이 그대로 읽혀야 한다 — 자리 이름 · 파일 이름이 바뀌면 토큰이 없는 것으로 보인다.
ok('토큰 자리 이름(account-1)이 바뀌었다', am.includes("'account-1'"));
ok('토큰 파일 이름(.bot-accounts.json)이 바뀌었다', am.includes("'.bot-accounts.json'"));

const sh = all['slack-handler.ts'] ?? '';
/** 메서드 본문 — 시그니처부터 같은 들여쓰기의 닫는 괄호까지. */
const body = (src, sig) => {
  const at = src.indexOf(sig);
  if (at < 0) return '';
  const end = src.indexOf('\n  }\n', at);
  return src.slice(at, end < 0 ? undefined : end);
};
for (const [label, sig] of [['대화 세션', '  async handleMessage('], ['비서 세션', 'private async runAssistantSession(']]) {
  const b = body(sh, sig);
  ok(`${label}: 본문을 못 찾았다(${sig.trim()})`, b.length > 0);
  ok(`${label}: 띄우기 전에 터미널 토큰을 안 맞춘다(syncFromCredentialsFile)`, b.includes('this.accountManager.syncFromCredentialsFile()'));
  ok(`${label}: 토큰을 안 가져온다(getAccessToken)`, b.includes('this.accountManager.getAccessToken()'));
  ok(`${label}: 토큰을 세션에 안 넣는다(CLAUDE_CODE_OAUTH_TOKEN)`, b.includes('CLAUDE_CODE_OAUTH_TOKEN'));
}
ok('대화 세션: 토큰 주입이 아직 다른 모드에 묶여 있다(`!queryEnv`)', !body(sh, '  async handleMessage(').includes('!queryEnv'));

ok('한도 안내의 「취소」 처리기가 빠졌다(cancel_retry)', sh.includes("this.action('cancel_retry'"));
ok('한도 안내에 「취소」 버튼이 안 붙는다', /action_id: 'cancel_retry'/.test(sh));
ok('취소가 캡처를 안 버린다', sh.includes("dropCapture(captureId, '사람이 취소함')"));
ok('토큰 점검이 빠졌다(checkTokenHealth)', sh.includes('this.accountManager.checkTokenHealth()'));

const msgs = all['messages.ts'] ?? '';
const expired = msgs.split('\n').find((l) => l.includes("'account.tokenExpired'")) ?? '';
ok('토큰 만료 안내 문구가 없다', expired.length > 0);
ok('토큰 만료 안내가 걷은 명령(-account)을 가리킨다', !expired.includes('-account'));
const stale = ['-apikey', '-limit', '-account', '-schedule'].filter((c) => msgs.includes(c));
ok(`도움말 · 문구에 걷은 명령이 남았다 — ${stale.join(' · ')}`, stale.length === 0);

// ── ③ SDK 환경에서 API 키 제거 — 세션 환경은 credit-route.ts 가 고른다(구독이면 withoutApiKey) ──
for (const f of ['credit-route.ts', 'model-ladder.ts']) {
  const src = all[f] ?? '';
  ok(`${f} 가 빼는 함수를 안 불러온다`, /import \{[^}]*\bwithoutApiKey\b[^}]*\} from '\.\/child-env'/.test(src));
  ok(`${f} 가 빼는 함수를 안 부른다`, /withoutApiKey\(/.test(src.replace(/^import .*$/gm, '')));
}

// 글자로만 보면 부르고도 결과를 안 쓰는 것을 못 잡는다 — 키를 심고 실제로 지어 본다.
const hasPath = (env) => Object.keys(env ?? {}).some((k) => k.toUpperCase() === 'PATH');
const leaks = (env) => Object.keys(env ?? {}).filter((k) => k.toUpperCase() === 'ANTHROPIC_API_KEY');
const FAKE = 'check-only-not-a-real-key';
const before = process.env.ANTHROPIC_API_KEY;
process.env.ANTHROPIC_API_KEY = FAKE;
try {
  const { withoutApiKey } = require(path.join(DIST, 'child-env.js'));
  const out = withoutApiKey({ ANTHROPIC_API_KEY: 'a', anthropic_api_key: 'b', PATH: 'p', GONE: undefined });
  ok(`빼는 함수가 키를 남긴다(대소문자 무관) — ${JSON.stringify(Object.keys(out))}`,
     JSON.stringify(Object.keys(out)) === JSON.stringify(['PATH']));

  const { SdkHandler } = require(path.join(DIST, 'sdk-handler.js'));
  const h = new SdkHandler({ getServerConfiguration: () => ({}), getDefaultAllowedTools: () => [] });
  for (const [label, extra] of [['env 없음', {}], ['env 있음', { env: { CLAUDE_CODE_OAUTH_TOKEN: 'oauth-check' } }]]) {
    const { sdkOptions } = h.buildOptions('확인', { workingDirectory: os.tmpdir(), ...extra });
    ok(`SDK(${label}): 세션 환경을 안 넘긴다 — SDK 가 process.env 를 그대로 쓴다`, !!sdkOptions.env);
    ok(`SDK(${label}): 세션 환경에 API 키가 샌다`, leaks(sdkOptions.env).length === 0);
    ok(`SDK(${label}): 나머지 환경(PATH)이 빠졌다`, hasPath(sdkOptions.env));
    if (extra.env) ok('SDK: 넘긴 토큰이 빠졌다', sdkOptions.env?.CLAUDE_CODE_OAUTH_TOKEN === 'oauth-check');
  }

  // ── ④ API 크레딧 — 세션 환경은 크레딧 장부가 정한다(2026-11-27 「크레딧물꼬」 · 상세 장면은 check:creditroute) ──────────
  // 장부 명령(`python -m llm_playbook.credits pick`)은 바꿔 끼운다 — 진짜 장부 · 진짜 키를 안 건드린다.
  const cr = require(path.join(DIST, 'credit-route.js'));
  const keyFile = path.join(os.tmpdir(), `check-noaccounts-key-${process.pid}`);
  // 가짜 키 — 소스에 키 모양 글자를 두지 않는다(공개 저장소 검사가 자격 증명으로 본다).
  const KEY = ['sk', 'ant', 'check', 'only', 'x'.repeat(40)].join('-');
  const realRun = cr.runner.run;
  const realQuery = SdkHandler.queryFn;
  let answer = null;
  const asked = [];
  cr.runner.run = (args, sync) => {
    asked.push(args.join(' '));
    const out = args[0] === 'pick' ? JSON.stringify(answer) : '';
    return sync ? out : Promise.resolve(out);
  };
  let spawned = 0;
  SdkHandler.queryFn = () => { spawned += 1; return (async function* () { /* 띄운 척 */ })(); };
  const fresh = (a) => { cr.forget(); answer = a; asked.length = 0; };
  try {
    fs.writeFileSync(keyFile, KEY + '\n');
    const env = { CLAUDE_CODE_OAUTH_TOKEN: 'oauth-check', ANTHROPIC_AUTH_TOKEN: 'auth-check' };

    fresh(null);
    let o = h.buildOptions('확인', { workingDirectory: os.tmpdir(), env });
    ok('장부 null: 세션에 키가 들어갔다 — 구독이어야 한다', leaks(o.sdkOptions.env).length === 0);
    ok('장부 null: 구독 토큰이 빠졌다', o.sdkOptions.env?.CLAUDE_CODE_OAUTH_TOKEN === 'oauth-check');
    ok(`장부 null: 물길대로 묻지 않았다(${asked.join(' / ')})`, asked[0] === 'pick');

    fresh({ name: 'max', key_file: keyFile });
    o = h.buildOptions('확인', { workingDirectory: os.tmpdir(), env });
    ok('장부 키: 그 키 파일의 키가 안 들어갔다', o.sdkOptions.env?.ANTHROPIC_API_KEY === KEY);
    ok('장부 키: 키가 한 벌이 아니다(대소문자 겹침)', leaks(o.sdkOptions.env).length === 1);
    ok('장부 키: 구독 토큰이 남았다 — Claude Code 가 키보다 그것을 먼저 쓸 수 있다',
       !('CLAUDE_CODE_OAUTH_TOKEN' in o.sdkOptions.env) && !('ANTHROPIC_AUTH_TOKEN' in o.sdkOptions.env));
    ok('장부 키: 나머지 환경(PATH)이 빠졌다', hasPath(o.sdkOptions.env));
    ok('장부 키: subscription 을 명시해도 키가 들어갔다',
       leaks(h.buildOptions('확인', { workingDirectory: os.tmpdir(), env, billing: 'subscription' }).sdkOptions.env).length === 0);

    // 크레딧을 명시한 칸(`claude-api`) — 물길과 상관없이 크레딧을 묻는다 · 키가 없으면 던진다 · 미리 안 띄운다
    fresh({ name: 'team', key_file: keyFile });
    o = h.buildOptions('확인', { workingDirectory: os.tmpdir(), env, billing: 'api' });
    ok(`API 칸: 크레딧 명시로 묻지 않았다(${asked.join(' / ')})`, asked.includes('pick --credits true'));
    ok('API 칸: 키가 안 들어갔다', o.sdkOptions.env?.ANTHROPIC_API_KEY === KEY);
    h.prewarm({ workingDirectory: os.tmpdir(), billing: 'api' });
    ok(`API 칸: 미리 띄웠다(띄움 ${spawned} · 자리 ${h.warmCount})`, spawned === 0 && h.warmCount === 0);
    const proc = h.runQuery('확인', { workingDirectory: os.tmpdir(), billing: 'api' });
    ok(`API 칸: 엔진 상태를 claude-api 에 안 적는다(${proc.engine})`, proc.engine === 'claude-api');
    ok('보통 차례: 엔진 상태를 claude 에 안 적는다(장부가 키를 줘도 구독 Claude 칸)',
       h.runQuery('확인', { workingDirectory: os.tmpdir() }).engine === 'claude');
    fresh(null);
    let threw = null;
    try { h.buildOptions('확인', { workingDirectory: os.tmpdir(), billing: 'api' }); } catch (e) { threw = e; }
    ok('API 칸: 쓸 키가 없는데 띄웠다', threw instanceof Error);

    // 키 파일 모양이 틀림 — API 칸은 던지고(내용을 안 싣고) 보통 차례는 구독으로
    fs.writeFileSync(keyFile, 'not-a-key-but-secret-looking');
    fresh({ name: 'max', key_file: keyFile });
    threw = null;
    try { h.buildOptions('확인', { workingDirectory: os.tmpdir(), billing: 'api' }); } catch (e) { threw = e; }
    ok('API 칸: 모양이 틀린 키 파일로 띄웠다', threw instanceof Error);
    ok('API 칸: 오류 글에 키 파일 내용이 실렸다', !String(threw?.message ?? '').includes('secret-looking'));
    o = h.buildOptions('확인', { workingDirectory: os.tmpdir(), env });
    ok('보통 차례: 키 파일이 틀렸는데 구독으로 안 돌았다', leaks(o.sdkOptions.env).length === 0
       && o.sdkOptions.env?.CLAUDE_CODE_OAUTH_TOKEN === 'oauth-check');

    // ── ⑤ Claude 막힘은 구독 엔진 상태만 따른다 — 장부를 안 본다 ──────────────────────────
    const { EngineState, engineState: liveState } = require(path.join(DIST, 'engine-state.js'));
    const dmf = require(path.join(DIST, 'dm-fallback.js'));
    const rlu = require(path.join(DIST, 'rate-limit-until.js'));
    const esDir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-noaccounts-engine-'));
    try {
      const es = new EngineState(path.join(esDir, '.engine-state.json'));
      es.recordBlocked('claude', { kind: 'usage', until: Math.floor(Date.now() / 1000) + 3600 });
      ok('구독 막힘: DM 사다리 막힘 표가 Claude 를 안 막힘으로 본다', dmf.ladderBlockedMap(es).claude === true);
      es.recordOk('claude');
      ok('구독 풀림: DM 사다리 막힘 표가 Claude 를 막힘으로 본다', dmf.ladderBlockedMap(es).claude === false);
    } finally {
      fs.rmSync(esDir, { recursive: true, force: true });
    }
    liveState.recordBlocked('claude', { kind: 'usage', until: Math.floor(Date.now() / 1000) + 3600 });
    ok('구독 막힘: 보류 드레인이 막힘으로 안 본다', rlu.stillBlocked() === true);
    liveState.recordOk('claude');
    ok('구독 풀림: 보류 드레인이 막힘으로 본다', rlu.stillBlocked() === false);
  } finally {
    SdkHandler.queryFn = realQuery;
    cr.runner.run = realRun;
    cr.forget();
    h.dropAllWarm('검사 끝');
    fs.rmSync(keyFile, { force: true });
  }
} finally {
  if (before === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = before;
}

// 크레딧 판단은 한 곳(`credit-route.ts`) — 키를 넣는 함수 · 장부 명령 · 세션 환경 고르기가 거기 밖에 생기면 그 길이 장부를 안 거친다.
const addAt = files.filter((f) => f !== HELPER && /withApiKey\(/.test(all[f]));
ok(`키를 넣는 함수(withApiKey)를 credit-route.ts 밖에서 부른다 — ${addAt.join(' · ')}`,
   addAt.length === 1 && addAt[0] === 'credit-route.ts');
const askAt = files.filter((f) => /'llm_playbook\.credits'/.test(all[f]));
ok(`크레딧 장부 명령을 credit-route.ts 밖에서 부른다 — ${askAt.join(' · ')}`,
   askAt.length === 1 && askAt[0] === 'credit-route.ts');
const envAt = files.filter((f) => /creditEnv\(/.test(all[f]) && f !== 'credit-route.ts');
ok(`세션 환경 고르기(creditEnv)를 sdk-handler.ts 밖에서 부른다 — ${envAt.join(' · ')}`,
   envAt.length === 1 && envAt[0] === 'sdk-handler.ts');
ok('sdk-handler.ts 가 세션 환경을 creditEnv 로 안 고른다', /sdkOptions\.env = route\.env;/.test(all['sdk-handler.ts'] ?? ''));
// 객체 속성으로 쓴 것만 센다 — 주석의 `billing: 'api'` 는 띄우는 곳이 아니다.
const billAt = files.filter((f) => /[{,]\s*billing: 'api'/.test(all[f]));
ok(`API 크레딧 칸(billing: 'api')을 slack-handler.ts 밖에서 띄운다 — ${billAt.join(' · ')}`,
   billAt.every((f) => f === 'slack-handler.ts'));

if (fails.length) {
  console.log(`실패 ${fails.length}건\n`);
  for (const f of fails) console.log('  ✗ ' + f);
  process.exitCode = 1;
} else {
  console.log(`통과 — 걷은 이름 ${GONE.length}개 없음 · 토큰 동기화 유지 · SDK 환경의 API 키 제거 (src ${files.length}개)`);
}
