/**
 * Agent SDK 두 개를 PC 에 설치된 Claude Code 판에 맞춘다 — 봇의 TypeScript SDK · 파이썬 SDK.
 *
 *   node scripts/sdk-update.mjs --check                  판 대조만 · JSON 한 줄(봇의 주간 점검이 부른다)
 *   node scripts/sdk-update.mjs --run --dry-run          점검(브랜치·커밋 안 된 파일·원격과 같은가·목표 판)까지만 · 당겨 오지 않음
 *   node scripts/sdk-update.mjs --run                    올리기 — 시험 · 실제 호출 · 커밋 · 푸시 · 봇 재시작
 *   node scripts/sdk-update.mjs --busy                   「다른 작업 중」인지만 · JSON 한 줄(버튼을 누른 순간 봇이 부른다)
 *   node scripts/sdk-update.mjs --run --request <파일>   봇 버튼이 pm2 한 번짜리 앱으로 부르는 모양
 *   … --no-push --no-restart                             저장소 사본에서 끝까지 돌려 볼 때(커밋까지만)
 *   환경 변수 LLM_PLAYBOOK_ROOT                            llm-playbook 위치를 바꿀 때(사본 시험) · 없으면 설치본에서 찾음
 *
 * **왜** — SDK 는 Claude Code 실행 파일을 띄우는 부품이고 판마다 짝 CLI 판이 정해져 있다(TypeScript
 * `claudeCodeVersion` · 파이썬 `__cli_version__`). Claude Code 는 스스로 업데이트되므로 SDK 를 그대로 두면 판이
 * 벌어진다. 실장 결정(2026-09-29): 가능하면 판을 맞춘다 · 주 1회 버튼 · 누르면 반영.
 *
 * **다른 작업을 섞지 않는다**(재검토 2026-09-29 반영) —
 * - 시작: 두 저장소 모두 기본 브랜치 · 커밋 안 된 파일 없음 · **원격과 똑같음**(당겨 오지 않는다 — 당기면 남의 커밋까지
 *   빌드·배포한다 · llm-playbook 은 편집 설치라 당기는 순간 모든 파이썬 호출에 반영된다)
 * - 커밋 직전: 시작 때 그대로인가(기본 브랜치 · 시작한 뒤 커밋이 안 늘었나 · 판 맞춤이 안 건드린 파일이 안 바뀌었나)
 * - 푸시 직전: **우리 커밋 하나만** 원격보다 앞섬 · 공개 저장소 검사(`public-push-gate.py --repo`) · 기본 브랜치로만 올림
 * - 재시작 직전: 봇 폴더가 기본 브랜치 · 깨끗함 · 재시작은 pm2 저장 환경을 안 건드리게(`restart.mjs --keep-env`)
 * - 어느 단계든 넘어지면 그 단계를 **마지막 커밋에서** 되돌리고 되돌린 판이 맞는지 확인한다 · 결과는 늘 남긴다
 *
 * 결과는 `~/.claude/state/sdk-update-result.json`(봇이 읽어 버튼을 누른 스레드에 알린다) · 기록은
 * `~/.claude/state/sdk-update.log`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  bumpPyproject, busyReason, guardReason, normalizeNpmView, pickTarget, requestFresh,
} from './lib/sdk-update-lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE = path.join(os.homedir(), '.claude', 'state');
const RESULT = process.env.SDK_UPDATE_RESULT || path.join(STATE, 'sdk-update-result.json');
const LOG = path.join(STATE, 'sdk-update.log');
const PY = process.env.PYTHON || 'python';
const PY_HELPER = path.join(ROOT, 'scripts', 'lib', 'sdk_py_versions.py');
const PUSH_GATE = path.join(os.homedir(), '.claude', 'hooks', 'public-push-gate.py');
const TS_PKG = '@anthropic-ai/claude-agent-sdk';
const TS_FILES = ['package.json', 'package-lock.json'];
const PY_PKG = 'claude-agent-sdk';
const APP = 'claude-slack-bot';
const WIN = process.platform === 'win32';
const PY_PROBE = [
  'from llm_playbook.backends import claude_sdk as c',
  "r = c.call_messages(model='sonnet', system=None, user='한 단어로만 답해: 네', timeout=180, effort='low')",
  "assert r['text'].strip(), 'empty reply'",
  "print(r['model'])",
].join('\n');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const iso = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lastLine = (s) => String(s ?? '').trim().split('\n').filter(Boolean).pop() ?? '';
const msgOf = (e) => String(e?.message ?? e).slice(0, 160);

function log(line) {
  try {
    fs.mkdirSync(STATE, { recursive: true });
    fs.appendFileSync(LOG, `[${iso()}] ${line}\n`);
  } catch { /* 기록 실패로 일을 멈추지 않는다 */ }
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf-8');
  fs.renameSync(tmp, file);
}

/**
 * 명령 하나. `npm`·`pm2` 는 윈도에서 `.cmd` 라 셸로만 뜬다 — 그때 `>`·빈칸 든 인자는 따옴표로 감싼다.
 * `quiet` 면 출력을 기록에 안 남긴다(`pm2 jlist` 는 봇 환경 값 — 토큰 — 을 통째로 싣는다).
 */
function sh(cmd, args, { cwd = ROOT, timeout = 600_000, env, quiet = false } = {}) {
  const shell = WIN && (cmd === 'npm' || cmd === 'pm2');
  const a = shell ? args.map((x) => (/[\s<>|&^]/.test(x) ? `"${x}"` : x)) : args;
  const r = spawnSync(cmd, a, {
    cwd, encoding: 'utf-8', windowsHide: true, timeout, shell, env: env ? { ...process.env, ...env } : process.env,
  });
  const stdout = r.stdout ?? '';
  const stderr = r.stderr ?? '';
  log(`$ ${path.basename(cmd)} ${args.join(' ').slice(0, 300)} (${path.basename(cwd)}) → ${r.status}`
    + `${r.error ? ` ${r.error.message}` : ''}${quiet ? '' : `\n${`${stdout}${stderr}`.slice(-1500)}`}`);
  return { ok: r.status === 0, stdout, stderr };
}

const git = (cwd, ...args) => sh('git', args, { cwd, timeout: 300_000 });

// --- 판 ---------------------------------------------------------------------

/** 봇이 띄우는 것과 같은 실행 파일 — `CLAUDE_CLI_PATH` 가 먼저(`src/sdk-handler.ts` `resolveClaudeExecutable`). */
function cliVersion() {
  const envp = process.env.CLAUDE_CLI_PATH;
  const r = sh(envp && fs.existsSync(envp) ? envp : 'claude', ['--version'], { timeout: 60_000 });
  return (r.ok && /(\d+\.\d+\.\d+)/.exec(r.stdout)?.[1]) || null;
}

function tsInstalled() {
  const p = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', TS_PKG, 'package.json'), 'utf-8'));
  return { version: p.version, pair: p.claudeCodeVersion };
}

function pyInstalled() {
  const r = sh(PY, ['-X', 'utf8', PY_HELPER, '--installed'], { timeout: 60_000 });
  if (!r.ok) throw new Error('파이썬 SDK 판을 못 읽음');
  const [version, pair] = JSON.parse(r.stdout);
  return { version, pair };
}

function check() {
  const cli = cliVersion();
  if (!cli) throw new Error('claude --version 실패');
  const ts = tsInstalled();
  const v = sh('npm', ['view', `${TS_PKG}@>=${ts.version}`, 'version', 'claudeCodeVersion', '--json'], { timeout: 120_000 });
  if (!v.ok) throw new Error('npm view 실패');
  const tsT = pickTarget(normalizeNpmView(JSON.parse(v.stdout)), cli, ts.version);
  const py = pyInstalled();
  const n = sh(PY, ['-X', 'utf8', PY_HELPER, '--newer', py.version], { timeout: 300_000 });
  if (!n.ok) throw new Error('PyPI 조회 실패');
  const pyT = pickTarget(JSON.parse(n.stdout), cli, py.version);
  return {
    cli,
    ts: { ...ts, target: tsT?.version ?? null, targetPair: tsT?.pair ?? null },
    py: { ...py, target: pyT?.version ?? null, targetPair: pyT?.pair ?? null },
    needed: Boolean(tsT || pyT),
  };
}

// --- 저장소 -----------------------------------------------------------------

function llmRoot() {
  const env = process.env.LLM_PLAYBOOK_ROOT;
  if (env) {
    if (!fs.existsSync(path.join(env, 'pyproject.toml'))) throw new Error('LLM_PLAYBOOK_ROOT 에 pyproject.toml 이 없음');
    return env;
  }
  const r = sh(PY, ['-c', 'import llm_playbook,os;print(os.path.dirname(os.path.dirname(os.path.abspath(llm_playbook.__file__))))'],
    { timeout: 60_000 });
  const dir = r.stdout.trim();
  if (!r.ok || !fs.existsSync(path.join(dir, 'pyproject.toml'))) throw new Error('llm-playbook 저장소를 못 찾음');
  return dir;
}

function defaultBranch(cwd) {
  const r = git(cwd, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD');
  return r.ok ? r.stdout.trim().replace(/^origin\//, '') : 'main';
}

function repoState(cwd) {
  return {
    want: defaultBranch(cwd),
    branch: git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD').stdout.trim(),
    head: git(cwd, 'rev-parse', 'HEAD').stdout.trim(),
    porcelain: git(cwd, 'status', '--porcelain').stdout,
  };
}

function busy(cwd) {
  const s = repoState(cwd);
  return busyReason(s.branch, s.want, s.porcelain);
}

/** 원격을 **가져오기만** 하고 같은지 본다(당기지 않는다). 다르면 이유. */
function remoteDiff(cwd) {
  const want = defaultBranch(cwd);
  if (!git(cwd, 'fetch', '-q', 'origin', want).ok) return '원격을 못 가져옴';
  const head = git(cwd, 'rev-parse', 'HEAD').stdout.trim();
  const remote = git(cwd, 'rev-parse', `origin/${want}`).stdout.trim();
  if (head === remote) return '';
  const ahead = git(cwd, 'rev-list', '--count', `origin/${want}..HEAD`).stdout.trim();
  const behind = git(cwd, 'rev-list', '--count', `HEAD..origin/${want}`).stdout.trim();
  return `원격과 다름(앞섬 ${ahead} · 뒤짐 ${behind}) — 먼저 맞춰 두세요`;
}

function commit(cwd, files, message) {
  const msg = path.join(os.tmpdir(), `sdk-update-msg-${process.pid}.txt`);
  fs.writeFileSync(msg, message, 'utf-8');
  const ok = git(cwd, 'add', ...files).ok && git(cwd, 'commit', '-q', '-F', msg).ok;
  fs.rmSync(msg, { force: true });
  return ok ? git(cwd, 'rev-parse', '--short', 'HEAD').stdout.trim() : null;
}

/**
 * 커밋하고 올린다. `{ sha, pushed, undo }` — `undo` 면 부르는 쪽이 설치를 되돌린다(커밋 전에 멈춘 경우).
 * 커밋 직전·푸시 직전에 **시작 때 그대로인지** 다시 본다.
 */
function commitPush(cwd, files, message, base, label, step) {
  const g = guardReason({ ...repoState(cwd), allowed: files, base });
  if (g) { step(`${label} 커밋`, false, `멈춤 — ${g}`); return { sha: null, pushed: false, undo: true }; }
  const sha = commit(cwd, files, message);
  if (!sha) { step(`${label} 커밋`, false, '커밋 실패'); return { sha: null, pushed: false, undo: true }; }
  if (has('--no-push')) { step(`${label} 커밋`, true, `${sha} (푸시 안 함)`); return { sha, pushed: false, undo: false }; }
  const s = repoState(cwd);
  const ahead = git(cwd, 'rev-list', '--count', `origin/${s.want}..HEAD`).stdout.trim();
  const parent = git(cwd, 'rev-parse', 'HEAD^').stdout.trim();
  if (s.branch !== s.want || ahead !== '1' || parent !== base) {
    step(`${label} 푸시`, false, `멈춤 — 우리 커밋 하나만 올라가는 상태가 아님(브랜치 ${s.branch} · 원격보다 ${ahead}개 앞섬) · `
      + `커밋 ${sha} 는 이 PC 에만`);
    return { sha, pushed: false, undo: false };
  }
  if (fs.existsSync(PUSH_GATE) && !sh(PY, ['-X', 'utf8', PUSH_GATE, '--repo', cwd], { cwd, timeout: 300_000 }).ok) {
    step(`${label} 푸시`, false, `공개 저장소 검사가 막음 · 커밋 ${sha} 는 이 PC 에만`);
    return { sha, pushed: false, undo: false };
  }
  if (!git(cwd, 'push', 'origin', `HEAD:refs/heads/${s.want}`).ok) {
    step(`${label} 푸시`, false, `커밋 ${sha} 는 됐고 푸시 실패 — 손으로 git push`);
    return { sha, pushed: false, undo: false };
  }
  step(`${label} 커밋·푸시`, true, sha);
  return { sha, pushed: true, undo: false };
}

// --- 단계 -------------------------------------------------------------------

function npmTest() {
  // 한 번 더 — 시험 하나가 우연히 떨어져 판 맞춤 전체가 멈추지 않게. 두 번 다 떨어지면 진짜로 본다.
  return sh('npm', ['test'], { timeout: 900_000 }).ok || sh('npm', ['test'], { timeout: 900_000 }).ok;
}

/** 봇 SDK 되돌림 — **마지막 커밋에서** 파일을 되살리고(스테이지에서 되살리면 `git add` 뒤엔 새 판 그대로다) 판을 확인한다. */
function tsRestore(c, step) {
  git(ROOT, 'checkout', 'HEAD', '--', ...TS_FILES);
  const ok = sh('npm', ['install', '--no-audit', '--no-fund']).ok && sh('npm', ['run', 'build']).ok;
  let now = null;
  try { now = tsInstalled(); } catch { /* 아래에서 실패로 */ }
  if (!ok || now?.version !== c.ts.version) {
    step('봇 SDK 되돌림', false, `되돌림 실패 — 설치 판 ${now?.version ?? '?'} · 손으로 npm install · npm run build 확인`);
  }
}

/** 파이썬 SDK 되돌림 — 앞 판으로 다시 깔고 pyproject 를 마지막 커밋에서 되살린 뒤 판을 확인한다. */
function pyRestore(c, llm, step) {
  sh(PY, ['-m', 'pip', 'install', '-q', `${PY_PKG}==${c.py.version}`], { timeout: 600_000 });
  git(llm, 'checkout', 'HEAD', '--', 'pyproject.toml');
  let now = null;
  try { now = pyInstalled(); } catch { /* 아래에서 실패로 */ }
  if (now?.version !== c.py.version) {
    step('파이썬 SDK 되돌림', false, `되돌림 실패 — 설치 판 ${now?.version ?? '?'} · 손으로 pip install ${PY_PKG}==${c.py.version}`);
  }
}

/** 봇 SDK. `'pushed' | 'committed'(커밋만 · 이 PC 에 설치됨) | 'failed'`. */
function tsStage(c, step, base) {
  const t = c.ts.target;
  const fail = (name, detail) => { tsRestore(c, step); step(name, false, `${detail} · 되돌림`); return 'failed'; };
  try {
    if (!sh('npm', ['install', `${TS_PKG}@${t}`, '--save', '--no-audit', '--no-fund']).ok) return fail('봇 SDK 설치', `${t} 설치 실패`);
    const now = tsInstalled();
    if (now.version !== t || now.pair !== c.ts.targetPair) {
      return fail('봇 SDK 설치', `설치 뒤 판이 다름(${now.version} · 짝 ${now.pair})`);
    }
    step('봇 SDK 설치', true, `${c.ts.version} → ${t} (짝 ${now.pair})`);
    if (!sh('npm', ['run', 'build']).ok) return fail('봇 빌드', '빌드 실패');
    if (!npmTest()) return fail('봇 시험', '두 번 다 실패');
    step('봇 빌드·시험', true, '통과');
    if (!sh(process.execPath, [path.join('scripts', 'probe-warm-live.mjs')], { timeout: 300_000 }).ok) {
      return fail('봇 실제 호출', '미리 띄운 세션이 안 끝남');
    }
    step('봇 실제 호출', true, '미리 띄운 세션 통과');
    const r = commitPush(ROOT, TS_FILES,
      `chore(deps): Agent SDK ${c.ts.version} → ${t} — Claude Code(${c.cli})와 판을 맞춤\n\n`
      + '주간 판 대조 → 스탠리 버튼으로 반영(scripts/sdk-update.mjs) · 빌드 · 시험 · 미리 띄운 세션 실제 호출 통과.\n',
      base, '봇', step);
    if (r.undo) { tsRestore(c, step); return 'failed'; }
    return r.pushed ? 'pushed' : 'committed';
  } catch (e) {
    return fail('봇 SDK', `예상 못 한 오류 — ${msgOf(e)}`);
  }
}

/** 파이썬 SDK. `'pushed' | 'committed' | 'failed'`(최소 판이 이미 이 판이면 커밋 없이 'pushed' 로 친다). */
function pyStage(c, llm, step, base) {
  const t = c.py.target;
  const pyproj = path.join(llm, 'pyproject.toml');
  const fail = (name, detail) => { pyRestore(c, llm, step); step(name, false, `${detail} · 되돌림`); return 'failed'; };
  try {
    if (!sh(PY, ['-m', 'pip', 'install', '-q', `${PY_PKG}==${t}`], { timeout: 600_000 }).ok) return fail('파이썬 SDK 설치', `${t} 설치 실패`);
    const now = pyInstalled();
    if (now.version !== t || now.pair !== c.py.targetPair) {
      return fail('파이썬 SDK 설치', `설치 뒤 판이 다름(${now.version} · 짝 ${now.pair})`);
    }
    step('파이썬 SDK 설치', true, `${c.py.version} → ${t} (짝 ${now.pair})`);
    // 최소 판이 이미 이 판이면 파일이 안 바뀐다 — 그때 커밋하면 「바뀐 것 없음」으로 실패해 멀쩡한 판 맞춤을
    // 되돌린다(사본 시험 준비 중 발견 2026-09-29). 시험·호출은 하고 커밋만 건너뛴다.
    const before = fs.readFileSync(pyproj, 'utf-8');
    const after = bumpPyproject(before, t, now.pair);
    if (after !== before) fs.writeFileSync(pyproj, after, 'utf-8');
    const test = sh(PY, ['-X', 'utf8', '-m', 'pytest', '-q'], { cwd: llm, timeout: 900_000 });
    if (!test.ok) return fail('llm-playbook 시험', lastLine(test.stdout));
    step('llm-playbook 시험', true, lastLine(test.stdout));
    const probe = sh(PY, ['-X', 'utf8', '-c', PY_PROBE], { cwd: llm, timeout: 300_000 });
    if (!probe.ok) return fail('파이썬 실제 호출', '응답 없음');
    step('파이썬 실제 호출', true, lastLine(probe.stdout));
    if (after === before) { step('llm-playbook 최소 판', true, `이미 ${t} — 커밋 없음`); return 'pushed'; }
    const r = commitPush(llm, ['pyproject.toml'],
      `sdk 최소 판 ${c.py.version} → ${t} — Claude Code(${c.cli})와 판을 맞춤\n\n`
      + '주간 판 대조 → 스탠리 버튼으로 반영(claude-code-slack-bot scripts/sdk-update.mjs) · pytest · 실제 호출 통과.\n',
      base, 'llm-playbook', step);
    if (r.undo) { pyRestore(c, llm, step); return 'failed'; }
    return r.pushed ? 'pushed' : 'committed';
  } catch (e) {
    return fail('파이썬 SDK', `예상 못 한 오류 — ${msgOf(e)}`);
  }
}

function pm2Bot() {
  const r = sh('pm2', ['jlist'], { timeout: 60_000, quiet: true });
  try {
    const p = JSON.parse(r.stdout).find((x) => x.name === APP);
    return p ? { status: p.pm2_env?.status, restarts: p.pm2_env?.restart_time, since: p.pm2_env?.pm_uptime } : null;
  } catch { return null; }
}

/**
 * 재시작 — 돌던 일이 있으면 `restart.mjs` 가 멈춘다. 2분마다 다시, 열 번까지. 판 맞춤 자신이 부른다는 표시
 * (`SDK_UPDATE_SELF=1`)를 달고 pm2 저장 환경은 그대로(`--keep-env`). 뜬 뒤 30초 넘게 멀쩡한지 본다.
 */
async function restartBot(step) {
  const why = busy(ROOT);
  if (why) return step('봇 재시작', false, `안 함 — 봇 폴더에서 다른 작업 중(${why}) · 끝난 뒤 npm run restart`);
  const before = pm2Bot();
  let done = false;
  for (let i = 0; i < 10 && !done; i++) {
    done = sh(process.execPath, [path.join('scripts', 'restart.mjs'), '--keep-env'],
      { timeout: 300_000, env: { SDK_UPDATE_SELF: '1' } }).ok;
    if (!done) { log('재시작 보류(돌던 일) — 2분 뒤 다시'); await sleep(120_000); }
  }
  if (!done) return step('봇 재시작', false, '여러 번 다시 해도 돌던 일이 안 끝남 — 손으로 npm run restart');
  const end = Date.now() + 150_000;
  while (Date.now() < end) {
    await sleep(10_000);
    const p = pm2Bot();
    if (p?.status === 'online' && (p.restarts ?? 0) > (before?.restarts ?? -1) && Date.now() - (p.since ?? Date.now()) > 30_000) {
      return step('봇 재시작', true, '떠서 30초 넘게 멀쩡함');
    }
  }
  return step('봇 재시작', false, '재시작 뒤 봇이 멀쩡히 안 뜸 — pm2 logs claude-slack-bot 확인');
}

function describe(c) {
  const part = (label, s) => `${label} ${s.version}(짝 ${s.pair})${s.target ? ` → ${s.target}` : ''}`;
  return `Claude Code ${c.cli} · ${part('봇 SDK', c.ts)} · ${part('파이썬 SDK', c.py)}`;
}

async function steps(res, step) {
  const llm = llmRoot();
  const base = {};
  for (const [label, cwd] of [['봇 저장소', ROOT], ['llm-playbook', llm]]) {
    const why = busy(cwd);
    if (why) { res.busy = true; step('점검', false, `다른 작업 중(${label}) — ${why}`); return 'failed'; }
    const diff = remoteDiff(cwd);
    if (diff) { step('점검', false, `${label} — ${diff}`); return 'failed'; }
    base[cwd] = git(cwd, 'rev-parse', 'HEAD').stdout.trim();
  }
  step('점검', true, '두 저장소 모두 기본 브랜치 · 깨끗함 · 원격과 같음');

  const c = check();
  res.before = c;
  step('판 대조', true, describe(c));
  if (!c.needed) { step('할 일', true, '이미 맞음'); return 'done'; }
  if (res.dryRun) { step('미리 보기', true, '여기까지 — 설치·커밋 안 함'); return 'done'; }

  const ts = c.ts.target ? tsStage(c, step, base[ROOT]) : 'skip';
  const py = c.py.target ? pyStage(c, llm, step, base[llm]) : 'skip';
  // **봇 SDK 가 커밋됐으면 파이썬 결과와 상관없이 재시작한다** — 안 하면 설치·빌드된 새 판이 안 도는 채 남는다(검토).
  const restarted = (ts === 'pushed' || ts === 'committed') && !has('--no-restart') ? await restartBot(step) : true;
  return [ts, py].every((x) => x === 'pushed' || x === 'skip') && restarted ? 'done' : 'failed';
}

async function run() {
  const reqPath = val('--request');
  let req = null;
  if (reqPath) {
    try { req = JSON.parse(fs.readFileSync(reqPath, 'utf-8')); } catch { req = null; }
    if (!requestFresh(req, Date.now())) {
      log('요청이 없거나 낡음 — 안 돈다(되살아난 pm2 앱일 수 있음)');
      return 0;
    }
    writeJson(reqPath, { ...req, consumed: true });
  }
  const res = {
    id: req?.id ?? `manual-${Date.now()}`, thread: req?.thread ?? null, startedAt: iso(), status: 'running',
    dryRun: has('--dry-run'), steps: [], before: null,
  };
  const save = () => { try { writeJson(RESULT, res); } catch (e) { log(`결과를 못 적음 — ${msgOf(e)}`); } };
  const step = (name, ok, detail = '') => { res.steps.push({ name, ok, detail }); save(); return ok; };
  save();
  // **어떤 경로로 끝나도 최종 결과를 남긴다** — `running` 인 채로 죽으면 봇이 알리지도 못한다(검토).
  try {
    res.status = await steps(res, step);
  } catch (e) {
    step('예상 못 한 오류', false, msgOf(e));
    res.status = 'failed';
  } finally {
    if (res.status === 'running') res.status = 'failed';
    res.finishedAt = iso();
    save();
  }
  return res.status === 'done' ? 0 : 1;
}

if (has('--check')) {
  try {
    console.log(JSON.stringify(check()));
  } catch (e) {
    console.log(JSON.stringify({ error: String(e.message ?? e) }));
    process.exitCode = 1;
  }
} else if (has('--busy')) {
  // 버튼을 누른 그 자리에서 봇이 묻는다 — 「다른 작업 중」 규칙을 여기 한 곳에만 두려고.
  try {
    let reason = '';
    for (const [label, cwd] of [['봇 저장소', ROOT], ['llm-playbook', llmRoot()]]) {
      const why = busy(cwd);
      if (why) { reason = `다른 작업 중(${label}) — ${why}`; break; }
    }
    console.log(JSON.stringify({ reason }));
  } catch (e) {
    console.log(JSON.stringify({ reason: `점검 실패 — ${e.message ?? e}` }));
  }
} else if (has('--run')) {
  process.exitCode = await run();
} else {
  console.error('사용: --check | --busy | --run [--dry-run] [--request <파일>]');
  process.exitCode = 2;
}
