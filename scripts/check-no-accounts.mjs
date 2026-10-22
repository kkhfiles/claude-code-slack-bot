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

// ── ③ SDK 환경에서 API 키 제거 ─────────────────────────────────────────────
for (const f of ['sdk-handler.ts', 'model-ladder.ts']) {
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

  const { SdkHandler, CREDIT_RESUME_NOTE } = require(path.join(DIST, 'sdk-handler.js'));
  const h = new SdkHandler({ getServerConfiguration: () => ({}), getDefaultAllowedTools: () => [] });
  for (const [label, extra] of [['env 없음', {}], ['env 있음', { env: { CLAUDE_CODE_OAUTH_TOKEN: 'oauth-check' } }]]) {
    const { sdkOptions } = h.buildOptions('확인', { workingDirectory: os.tmpdir(), ...extra });
    ok(`SDK(${label}): 세션 환경을 안 넘긴다 — SDK 가 process.env 를 그대로 쓴다`, !!sdkOptions.env);
    ok(`SDK(${label}): 세션 환경에 API 키가 샌다`, leaks(sdkOptions.env).length === 0);
    ok(`SDK(${label}): 나머지 환경(PATH)이 빠졌다`, hasPath(sdkOptions.env));
    if (extra.env) ok('SDK: 넘긴 토큰이 빠졌다', sdkOptions.env?.CLAUDE_CODE_OAUTH_TOKEN === 'oauth-check');
  }

  // ── ④ 월 API 크레딧 칸(2026-10-21) — 키는 `billing: 'api'` 한 길에서만 들어간다 ──────────
  const keyFile = path.join(os.tmpdir(), `check-noaccounts-key-${process.pid}`);
  // 가짜 키 — 소스에 키 모양 글자를 두지 않는다(공개 저장소 검사가 자격 증명으로 본다).
  const KEY = ['sk', 'ant', 'check', 'only', 'x'.repeat(40)].join('-');
  const beforeFile = process.env.CLAUDE_API_KEY_FILE;
  process.env.CLAUDE_API_KEY_FILE = keyFile;
  const realQuery = SdkHandler.queryFn;
  let spawned = 0;
  SdkHandler.queryFn = () => { spawned += 1; return (async function* () { /* 띄운 척 */ })(); };
  try {
    fs.writeFileSync(keyFile, KEY + '\n');
    const env = { CLAUDE_CODE_OAUTH_TOKEN: 'oauth-check', ANTHROPIC_AUTH_TOKEN: 'auth-check' };
    const { sdkOptions } = h.buildOptions('확인', { workingDirectory: os.tmpdir(), env, billing: 'api' });
    ok('API 칸: 키 파일의 키가 안 들어갔다', sdkOptions.env?.ANTHROPIC_API_KEY === KEY);
    ok('API 칸: 키가 한 벌이 아니다(대소문자 겹침)', leaks(sdkOptions.env).length === 1);
    ok('API 칸: 구독 토큰이 남았다 — Claude Code 가 키보다 그것을 먼저 쓸 수 있다',
       !('CLAUDE_CODE_OAUTH_TOKEN' in sdkOptions.env) && !('ANTHROPIC_AUTH_TOKEN' in sdkOptions.env));
    ok('API 칸: 나머지 환경(PATH)이 빠졌다', hasPath(sdkOptions.env));

    h.prewarm({ workingDirectory: os.tmpdir(), billing: 'api' });
    ok(`API 칸: 미리 띄웠다 — 키를 든 프로세스가 대기 자리에 남는다(띄움 ${spawned} · 자리 ${h.warmCount})`,
       spawned === 0 && h.warmCount === 0);
    const proc = h.runQuery('확인', { workingDirectory: os.tmpdir(), billing: 'api' });
    ok(`API 칸: 엔진 상태를 claude-api 에 안 적는다(${proc.engine})`, proc.engine === 'claude-api');
    ok('보통 차례: 엔진 상태를 claude 에 안 적는다', h.runQuery('확인', { workingDirectory: os.tmpdir() }).engine === 'claude');

    // ── ⑤ 크레딧 먼저(2026-10-22) — 장부가 켜져 있고 쓸 키가 있을 때만 그 키 · 아니면 구독 ──────────
    const ledger = path.join(os.tmpdir(), `check-noaccounts-ledger-${process.pid}.json`);
    const beforeLedger = process.env.LLM_PLAYBOOK_CREDITS;
    process.env.LLM_PLAYBOOK_CREDITS = ledger;
    const future = new Date(Date.now() + 10 * 86400_000).toISOString().slice(0, 10);
    const writeLedger = (enabled) => fs.writeFileSync(ledger, JSON.stringify({ v: 1, enabled, margin: 0.03,
      keys: { max: { key_file: keyFile, grant_usd: 10, expires: future, spent_usd: 0, daily: {} } } }));
    try {
      writeLedger(false);
      let o = h.buildOptions('확인', { workingDirectory: os.tmpdir(), env });
      ok('크레딧 꺼짐: 키가 들어갔다 — 구독이어야 한다', leaks(o.sdkOptions.env).length === 0 && o.credit === null);
      writeLedger(true);
      o = h.buildOptions('확인', { workingDirectory: os.tmpdir(), env });
      ok('크레딧 켜짐: 장부 키가 안 들어갔다', o.sdkOptions.env?.ANTHROPIC_API_KEY === KEY && o.credit?.name === 'max');
      ok('크레딧 켜짐: 구독 토큰이 남았다', !('CLAUDE_CODE_OAUTH_TOKEN' in o.sdkOptions.env));
      o = h.buildOptions('확인', { workingDirectory: os.tmpdir(), env, billing: 'subscription' });
      ok('구독 고정: 키가 들어갔다', leaks(o.sdkOptions.env).length === 0 && o.credit === null);

      // 결과마다 쓴 금액을 적고, 크레딧 부족이면 그 키를 막는다
      SdkHandler.queryFn = () => (async function* () {
        yield { type: 'result', subtype: 'success', is_error: false, result: '답', total_cost_usd: 0.5, session_id: 's' };
      })();
      for await (const _ of h.runQuery('확인', { workingDirectory: os.tmpdir() })) { /* 끝까지 */ }
      let st = JSON.parse(fs.readFileSync(ledger, 'utf-8'));
      ok(`크레딧 세션: 쓴 금액을 장부에 안 적었다(${st.keys.max.spent_usd})`, st.keys.max.spent_usd === 0.5);
      SdkHandler.queryFn = () => (async function* () {
        yield { type: 'result', subtype: 'success', is_error: true, total_cost_usd: 0, session_id: 's',
          result: 'Credit balance too low · Add funds: https://platform.claude.com/settings/billing' };
      })();
      for await (const _ of h.runQuery('확인', { workingDirectory: os.tmpdir() })) { /* 끝까지 */ }
      st = JSON.parse(fs.readFileSync(ledger, 'utf-8'));
      ok('크레딧 세션: 크레딧 부족인데 키를 안 막았다', !!st.keys.max.blocked);
      o = h.buildOptions('확인', { workingDirectory: os.tmpdir(), env });
      ok('막힌 키: 그래도 키가 들어갔다 — 구독으로 돌아가야 한다', leaks(o.sdkOptions.env).length === 0);

      // ── ⑥ 크레딧이 도중에 바닥난 차례는 다음 키나 구독으로 한 번 더(2026-10-22 사용자 결정) ──────────
      // 첫 띄우기는 SDK 가 대신 만든 오류 메시지(billing_error)와 오류 결과, 다음 띄우기는 성공 — 부른 옵션을 적어 둔다.
      const billing = [
        { type: 'assistant', error: 'billing_error', message: { content: [{ type: 'text', text: 'Credit balance too low · Add funds' }] } },
        { type: 'result', subtype: 'success', is_error: true, total_cost_usd: 0, session_id: 's1', result: 'Credit balance too low · Add funds' },
      ];
      const scripted = (first) => {
        const calls = [];
        SdkHandler.queryFn = ({ prompt, options }) => {
          calls.push({ prompt, resume: options.resume, key: leaks(options.env).length > 0 });
          const evs = calls.length === 1 ? first
            : [{ type: 'result', subtype: 'success', is_error: false, result: '다시 한 답', total_cost_usd: 0, session_id: 's2' }];
          return (async function* () { for (const e of evs) yield e; })();
        };
        return calls;
      };
      const drain = async (proc) => { const out = []; for await (const e of proc) out.push(e); return out; };
      const texts = (evs) => evs.map((e) => e.result ?? e.message?.content?.[0]?.text ?? '').join(' | ');

      writeLedger(true);
      let calls = scripted(billing);
      let evs = await drain(h.runQuery('확인', { workingDirectory: os.tmpdir(), env }));
      ok(`도중 소진(도구 안 돎): 다시 안 띄웠다 · 같은 말로 · 구독으로(${JSON.stringify(calls)})`,
        calls.length === 2 && calls[1].prompt === '확인' && calls[0].key && !calls[1].key);
      ok(`도중 소진: 오류 글이 밖으로 나갔다 — 다시 한 답만 나가야 한다(${texts(evs)})`,
        texts(evs) === '다시 한 답' && !evs.some((e) => e.error));
      st = JSON.parse(fs.readFileSync(ledger, 'utf-8'));
      ok('도중 소진: 그 키를 안 막았다', !!st.keys.max.blocked);

      writeLedger(true);
      const withTool = [
        { type: 'system', subtype: 'init', session_id: 's1' },
        { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] } },
        ...billing,
      ];
      calls = scripted(withTool);
      evs = await drain(h.runQuery('확인', { workingDirectory: os.tmpdir(), env }));
      ok(`도중 소진(도구 돎): 그 세션을 「이미 한 일은 다시 하지 말라」로 잇지 않았다(${JSON.stringify(calls)})`,
        calls.length === 2 && calls[1].resume === 's1' && calls[1].prompt === CREDIT_RESUME_NOTE && !calls[1].key);
      ok('도중 소진(도구 돎): 앞서 낸 이벤트를 다시 냈거나 빠뜨렸다', evs.length === 3 && evs[2].result === '다시 한 답');

      writeLedger(true);
      calls = scripted(withTool);
      evs = await drain(h.runQuery('확인', { workingDirectory: os.tmpdir(), env, noSessionPersistence: true }));
      ok(`도중 소진(도구 돎 · 저장 안 함): 다시 띄웠다 — 같은 쓰기가 두 번 들어간다(${calls.length})`,
        calls.length === 1 && evs.some((e) => e.is_error));

      writeLedger(true);
      calls = scripted(billing);
      evs = await drain(h.runQuery('확인', { workingDirectory: os.tmpdir(), env, billing: 'subscription' }));
      ok(`구독 세션: 크레딧 글에 다시 띄웠다(${calls.length})`, calls.length === 1);

      // 다시 띄운 세션도 소진이면 다음으로 — 상한(두 번)을 넘으면 원래 오류를 낸다
      writeLedger(true);
      let n = 0;
      SdkHandler.queryFn = () => { n++; return (async function* () { for (const e of billing) yield e; })(); };
      const fs2 = fs.readFileSync(ledger, 'utf-8');
      fs.writeFileSync(ledger, JSON.stringify({ ...JSON.parse(fs2), keys: { ...JSON.parse(fs2).keys,
        team: { key_file: keyFile, grant_usd: 10, expires: future, spent_usd: 0, daily: {} } } }));
      evs = await drain(h.runQuery('확인', { workingDirectory: os.tmpdir(), env }));
      ok(`연달아 소진: max → team → 구독 세 번이 아니다(${n})`, n === 3);
      ok('연달아 소진: 마지막 구독 세션의 오류는 그대로 나가야 한다', evs.some((e) => e.is_error));
    } finally {
      fs.rmSync(ledger, { force: true });
      if (beforeLedger === undefined) delete process.env.LLM_PLAYBOOK_CREDITS;
      else process.env.LLM_PLAYBOOK_CREDITS = beforeLedger;
    }

    fs.writeFileSync(keyFile, 'not-a-key-but-secret-looking');
    let threw = null;
    try { h.buildOptions('확인', { workingDirectory: os.tmpdir(), billing: 'api' }); } catch (e) { threw = e; }
    ok('API 칸: 모양이 틀린 키 파일로 띄웠다', threw?.name === 'Error' || threw instanceof Error);
    ok('API 칸: 오류 글에 키 파일 내용이 실렸다', !String(threw?.message ?? '').includes('secret-looking'));
  } finally {
    SdkHandler.queryFn = realQuery;
    fs.rmSync(keyFile, { force: true });
    if (beforeFile === undefined) delete process.env.CLAUDE_API_KEY_FILE;
    else process.env.CLAUDE_API_KEY_FILE = beforeFile;
  }

} finally {
  if (before === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = before;
}

// 키를 넣는 함수는 SDK 처리기의 `billing: 'api'` 한 곳에서만 — 다른 곳에서 부르면 그 길이 구독 대신 과금된다.
const addAt = files.filter((f) => f !== HELPER && /withApiKey\(/.test(all[f]));
ok(`키를 넣는 함수(withApiKey)를 sdk-handler.ts 밖에서 부른다 — ${addAt.join(' · ')}`,
   addAt.length === 1 && addAt[0] === 'sdk-handler.ts');
ok('sdk-handler.ts 가 키를 넣는 함수를 `billing === \'api\'` 또는 장부 키 갈래 밖에서 부른다',
   /opts\.billing === 'api' \|\| credit\s*\n\s*\? withApiKey\(/.test(all['sdk-handler.ts'] ?? '')
   && (all['sdk-handler.ts'].match(/withApiKey\(/g) ?? []).length === 1);
// 객체 속성으로 쓴 것만 센다 — 주석의 `billing: 'api'` 는 띄우는 곳이 아니다.
const billAt = files.filter((f) => /[{,]\s*billing: 'api'/.test(all[f]));
ok(`API 크레딧 세션(billing: 'api')을 slack-handler.ts 밖에서 띄운다 — ${billAt.join(' · ')}`,
   billAt.every((f) => f === 'slack-handler.ts'));

if (fails.length) {
  console.log(`실패 ${fails.length}건\n`);
  for (const f of fails) console.log('  ✗ ' + f);
  process.exitCode = 1;
} else {
  console.log(`통과 — 걷은 이름 ${GONE.length}개 없음 · 토큰 동기화 유지 · SDK 환경의 API 키 제거 (src ${files.length}개)`);
}
