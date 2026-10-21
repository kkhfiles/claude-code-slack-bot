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

  const { SdkHandler } = require(path.join(DIST, 'sdk-handler.js'));
  const h = new SdkHandler({ getServerConfiguration: () => ({}), getDefaultAllowedTools: () => [] });
  for (const [label, extra] of [['env 없음', {}], ['env 있음', { env: { CLAUDE_CODE_OAUTH_TOKEN: 'oauth-check' } }]]) {
    const { sdkOptions } = h.buildOptions('확인', { workingDirectory: os.tmpdir(), ...extra });
    ok(`SDK(${label}): 세션 환경을 안 넘긴다 — SDK 가 process.env 를 그대로 쓴다`, !!sdkOptions.env);
    ok(`SDK(${label}): 세션 환경에 API 키가 샌다`, leaks(sdkOptions.env).length === 0);
    ok(`SDK(${label}): 나머지 환경(PATH)이 빠졌다`, hasPath(sdkOptions.env));
    if (extra.env) ok('SDK: 넘긴 토큰이 빠졌다', sdkOptions.env?.CLAUDE_CODE_OAUTH_TOKEN === 'oauth-check');
  }

} finally {
  if (before === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = before;
}

if (fails.length) {
  console.log(`실패 ${fails.length}건\n`);
  for (const f of fails) console.log('  ✗ ' + f);
  process.exitCode = 1;
} else {
  console.log(`통과 — 걷은 이름 ${GONE.length}개 없음 · 토큰 동기화 유지 · SDK 환경의 API 키 제거 (src ${files.length}개)`);
}
