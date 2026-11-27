/**
 * 봇을 띄운 세션의 변수가 봇 자식과 pm2 로 안 넘어가는가.
 *
 *   npm run check:sessionenv     (먼저 `npm run build`)
 *
 * pm2 데몬과 앱이 Claude Code · Codex 세션에서 띄워져 그 세션의 변수(`CLAUDECODE`, 메시지 통로 등)를 들고 있었고,
 * 봇이 띄우는 claude · codex · agy 가 그것을 물려받았다(2026-11-02 확인). 막는 곳은 셋 — 봇이 뜰 때 지우기(`index.ts`),
 * 나가는 문(`child-env.ts`), 재시작 스크립트가 pm2 에 넘기는 환경(`restart.mjs`). 목록 정본은 `src/session-env.json`.
 *
 *   ① 나가는 문 두 함수가 목록 이름(대소문자 무관)과 `ANTIGRAVITY_` 로 시작하는 것을 빼는가
 *   ② 같은 접두사라도 봇이 읽는 변수(`CLAUDE_CODE_USE_BEDROCK`, `CODEX_QUOTA_PYTHON` 등)는 남기는가
 *   ③ `index.ts` 가 다른 일보다 먼저 지우는가 — 봇을 띄우지 않고 글자로 본다
 *   ④ 재시작 스크립트가 실제로 부른 pm2 에 목록 변수가 안 갔는가 — 가짜 `pm2.cmd` 가 받은 이름을 적는다(값은 안 적음)
 */
import './lib/fresh-dist.mjs';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const fails = [];
const ok = (msg, cond) => { if (!cond) fails.push(msg); };

const LIST = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'session-env.json'), 'utf-8'));
const SESSION = { CLAUDECODE: '1', claude_code_messaging_token: 't', CODEX_THREAD_ID: 'x', ANTIGRAVITY_CSRF_TOKEN: 'c' };
const KEEP = { CLAUDE_CODE_USE_BEDROCK: '0', CLAUDE_CODE_USE_VERTEX: '0', CODEX_QUOTA_PYTHON: 'py',
  CLAUDE_CODE_USE_POWERSHELL_TOOL: '1', AGY_CLI_DISABLE_AUTO_UPDATE: '1', CLAUDE_BOT_SESSION: '1', PATH: 'p' };

// ── ①② 나가는 문 ─────────────────────────────────────────────────────────
const dist = path.join(ROOT, 'dist', 'child-env.js');
if (!fs.existsSync(dist)) {
  console.error('dist 가 없습니다 — 먼저 npm run build');
  process.exit(1);
}
const { withoutApiKey, withApiKey, isSessionEnv } = require(dist);
const allNames = Object.fromEntries(LIST.names.map((n) => [n, 'v']));
const out = withoutApiKey({ ...allNames, ...SESSION, ...KEEP });
ok(`withoutApiKey 가 세션 변수를 남긴다 — ${Object.keys(out).filter(isSessionEnv)}`,
   Object.keys(out).every((k) => !(k.toUpperCase() in allNames) && !(k in SESSION)));
for (const k of Object.keys(KEEP)) ok(`withoutApiKey 가 ${k} 를 뺐다`, out[k] === KEEP[k]);

const keyFile = path.join(os.tmpdir(), `check-sessionenv-key-${process.pid}`);
fs.writeFileSync(keyFile, ['sk', 'ant', 'check', 'only', 'x'.repeat(40)].join('-'));
try {
  const withKey = withApiKey({ ...SESSION, ...KEEP }, keyFile);
  ok('withApiKey 가 세션 변수를 남긴다', Object.keys(SESSION).every((k) => !(k in withKey)));
  ok('withApiKey 가 PATH 를 뺐다', withKey.PATH === 'p');
} finally {
  fs.rmSync(keyFile, { force: true });
}

// ── ③ 봇이 뜰 때 지우기 ──────────────────────────────────────────────────
const index = fs.readFileSync(path.join(ROOT, 'src', 'index.ts'), 'utf-8');
const scrubAt = index.search(/Object\.keys\(process\.env\)\.filter\(isSessionEnv\)/);
ok('index.ts 가 세션 변수를 안 지운다', scrubAt >= 0);
ok('index.ts 가 start() 뒤에 지운다 — 먼저 지워야 그 안에서 띄우는 자식이 깨끗하다',
   scrubAt >= 0 && scrubAt < index.indexOf('async function start'));

// ── ④ 재시작 스크립트가 pm2 에 넘기는 환경 ───────────────────────────────
const restart = fs.readFileSync(path.join(ROOT, 'scripts', 'restart.mjs'), 'utf-8');
const calls = restart.match(/execSync\([^;]*\)/g) ?? [];
ok('restart.mjs 의 execSync 를 못 찾음', calls.length > 0);
for (const c of calls) ok(`restart.mjs 의 pm2 호출이 세션 변수를 뺀 환경을 안 넘긴다 — ${c.slice(0, 60)}`, /env: PM2_ENV/.test(c));

if (process.platform === 'win32') {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'check-sessionenv-'));
  const record = path.join(tmp, 'names');
  // 받은 변수의 **이름만** 적는다 — 값을 파일에 남기지 않는다. jlist 는 빈 목록이라 스크립트가 「없음」 길로 재시작을 부른다.
  fs.writeFileSync(path.join(tmp, 'pm2.cmd'), [
    '@echo off',
    `for /f "delims==" %%a in ('set') do echo %%a>>"${record}.%1"`,
    'if "%1"=="jlist" echo []',
    '',
  ].join('\r\n'));
  const env = { ...process.env, ...SESSION, ...KEEP, PATH: `${tmp};${process.env.PATH}` };
  const run = (extra) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'restart.mjs'), ...extra], {
    cwd: ROOT, env, encoding: 'utf-8', windowsHide: true, timeout: 60_000,
  });
  const got = (verb) => {
    try { return fs.readFileSync(`${record}.${verb}`, 'utf-8').split(/\r?\n/).filter(Boolean); } catch { return null; }
  };
  // **가짜가 잡히는지 --dry 로 먼저 본다** — 안 잡힌 채 재시작 길을 돌리면 진짜 봇이 내려간다.
  let r = run(['--dry']);
  const verbs = ['jlist'];
  if (got('jlist') !== null) {
    r = run([]);
    verbs.push('restart');
  }
  for (const verb of verbs) {
    const names = got(verb);
    ok(`가짜 pm2 ${verb} 가 안 불렸다 — rc=${r.status} ${(r.stderr || '').slice(0, 200)}`, names !== null);
    if (!names) continue;
    const leaked = names.filter((n) => n.toUpperCase() in Object.fromEntries(Object.keys(SESSION).map((k) => [k.toUpperCase(), 1])));
    ok(`pm2 ${verb} 에 세션 변수가 갔다 — ${leaked}`, leaked.length === 0);
    ok(`pm2 ${verb} 에 CLAUDE_CODE_USE_BEDROCK 이 안 갔다`, names.some((n) => n.toUpperCase() === 'CLAUDE_CODE_USE_BEDROCK'));
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

if (fails.length) {
  console.log(`❌ ${fails.length}건`);
  for (const f of fails) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('✅ 세션 변수가 봇 자식과 pm2 로 안 넘어감');
