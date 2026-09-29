/**
 * Agent SDK 두 개를 PC 에 설치된 Claude Code 판에 맞춘다 — 봇의 TypeScript SDK · 파이썬 SDK.
 *
 *   node scripts/sdk-update.mjs --check                  판 대조만 · JSON 한 줄(봇의 주간 점검이 부른다)
 *   node scripts/sdk-update.mjs --run --dry-run          점검(브랜치·커밋 안 된 파일·목표 판)까지만
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
 * **다른 작업 중이면 멈춘다** — 봇 폴더를 다른 세션이 기능 브랜치로 쓰는 동안 빌드·재시작하면 그 세션의
 * 작성 중인 코드가 운영에 섞인다(2026-09-29 실제로 그 상황이었다). 기본 브랜치 · 커밋 안 된 파일 없음일 때만 돈다.
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
  bumpPyproject, busyReason, normalizeNpmView, pickTarget, requestFresh,
} from './lib/sdk-update-lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE = path.join(os.homedir(), '.claude', 'state');
const RESULT = process.env.SDK_UPDATE_RESULT || path.join(STATE, 'sdk-update-result.json');
const LOG = path.join(STATE, 'sdk-update.log');
const PY = process.env.PYTHON || 'python';
const PY_HELPER = path.join(ROOT, 'scripts', 'lib', 'sdk_py_versions.py');
const TS_PKG = '@anthropic-ai/claude-agent-sdk';
const PY_PKG = 'claude-agent-sdk';
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

/** 명령 하나. `npm`·`pm2` 는 윈도에서 `.cmd` 라 셸로만 뜬다 — 그때 `>`·빈칸 든 인자는 따옴표로 감싼다. */
function sh(cmd, args, { cwd = ROOT, timeout = 600_000 } = {}) {
  const shell = WIN && (cmd === 'npm' || cmd === 'pm2');
  const a = shell ? args.map((x) => (/[\s<>|&^]/.test(x) ? `"${x}"` : x)) : args;
  const r = spawnSync(cmd, a, { cwd, encoding: 'utf-8', windowsHide: true, timeout, shell });
  const stdout = r.stdout ?? '';
  const stderr = r.stderr ?? '';
  log(`$ ${path.basename(cmd)} ${args.join(' ').slice(0, 300)} (${path.basename(cwd)}) → ${r.status}`
    + `${r.error ? ` ${r.error.message}` : ''}\n${`${stdout}${stderr}`.slice(-1500)}`);
  return { ok: r.status === 0, stdout, stderr };
}

const git = (cwd, ...args) => sh('git', args, { cwd, timeout: 300_000 });

// --- 판 ---------------------------------------------------------------------

function cliVersion() {
  const r = sh('claude', ['--version'], { timeout: 60_000 });
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

function busy(cwd) {
  const want = defaultBranch(cwd);
  const branch = git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD').stdout.trim();
  return busyReason(branch, want, git(cwd, 'status', '--porcelain').stdout);
}

function commit(cwd, files, message) {
  const msg = path.join(os.tmpdir(), `sdk-update-msg-${process.pid}.txt`);
  fs.writeFileSync(msg, message, 'utf-8');
  const ok = git(cwd, 'add', ...files).ok && git(cwd, 'commit', '-q', '-F', msg).ok;
  fs.rmSync(msg, { force: true });
  return ok ? git(cwd, 'rev-parse', '--short', 'HEAD').stdout.trim() : null;
}

// --- 단계 -------------------------------------------------------------------

function npmTest() {
  // 한 번 더 — 시험 하나가 우연히 떨어져 판 맞춤 전체가 멈추지 않게. 두 번 다 떨어지면 진짜로 본다.
  return sh('npm', ['test'], { timeout: 900_000 }).ok || sh('npm', ['test'], { timeout: 900_000 }).ok;
}

function tsStage(c, step) {
  const t = c.ts.target;
  const restore = () => {
    git(ROOT, 'checkout', '--', 'package.json', 'package-lock.json');
    sh('npm', ['install', '--no-audit', '--no-fund']);
    sh('npm', ['run', 'build']);
  };
  if (!sh('npm', ['install', `${TS_PKG}@${t}`, '--save', '--no-audit', '--no-fund']).ok) {
    restore();
    return step('봇 SDK 설치', false, `${t} 설치 실패 · 되돌림`);
  }
  const now = tsInstalled();
  if (now.version !== t || now.pair !== c.ts.targetPair) {
    restore();
    return step('봇 SDK 설치', false, `설치 뒤 판이 다름(${now.version} · 짝 ${now.pair}) · 되돌림`);
  }
  step('봇 SDK 설치', true, `${c.ts.version} → ${t} (짝 ${now.pair})`);
  if (!sh('npm', ['run', 'build']).ok) { restore(); return step('봇 빌드', false, '빌드 실패 · 되돌림'); }
  if (!npmTest()) { restore(); return step('봇 시험', false, '두 번 다 실패 · 되돌림'); }
  step('봇 빌드·시험', true, '통과');
  if (!sh(process.execPath, [path.join('scripts', 'probe-warm-live.mjs')], { timeout: 300_000 }).ok) {
    restore();
    return step('봇 실제 호출', false, '미리 띄운 세션이 안 끝남 · 되돌림');
  }
  step('봇 실제 호출', true, '미리 띄운 세션 통과');
  const sha = commit(ROOT, ['package.json', 'package-lock.json'],
    `chore(deps): Agent SDK ${c.ts.version} → ${t} — Claude Code(${c.cli})와 판을 맞춤\n\n`
    + '주간 판 대조 → 스탠리 버튼으로 반영(scripts/sdk-update.mjs) · 빌드 · 시험 · 미리 띄운 세션 실제 호출 통과.\n');
  if (!sha) { restore(); return step('봇 커밋', false, '커밋 실패 · 되돌림'); }
  if (has('--no-push')) return step('봇 커밋', true, `${sha} (푸시 안 함)`);
  if (!git(ROOT, 'push', 'origin', 'HEAD').ok) {
    return step('봇 푸시', false, `커밋 ${sha} 는 됐고 푸시 실패 — 손으로 git push 뒤 npm run restart`);
  }
  return step('봇 커밋·푸시', true, sha);
}

function pyStage(c, llm, step) {
  const t = c.py.target;
  const prev = c.py.version;
  const pyproj = path.join(llm, 'pyproject.toml');
  const restore = () => {
    sh(PY, ['-m', 'pip', 'install', '-q', `${PY_PKG}==${prev}`], { timeout: 600_000 });
    git(llm, 'checkout', '--', 'pyproject.toml');
  };
  if (!sh(PY, ['-m', 'pip', 'install', '-q', `${PY_PKG}==${t}`], { timeout: 600_000 }).ok) {
    restore();
    return step('파이썬 SDK 설치', false, `${t} 설치 실패 · 되돌림`);
  }
  const now = pyInstalled();
  if (now.version !== t || now.pair !== c.py.targetPair) {
    restore();
    return step('파이썬 SDK 설치', false, `설치 뒤 판이 다름(${now.version} · 짝 ${now.pair}) · 되돌림`);
  }
  step('파이썬 SDK 설치', true, `${prev} → ${t} (짝 ${now.pair})`);
  // 최소 판이 이미 이 판이면 파일이 안 바뀐다 — 그때 커밋하면 「바뀐 것 없음」으로 실패해 멀쩡한 판 맞춤을
  // 되돌린다(사본 시험 준비 중 발견 2026-09-29). 시험·호출은 하고 커밋만 건너뛴다.
  let changed = false;
  try {
    const before = fs.readFileSync(pyproj, 'utf-8');
    const after = bumpPyproject(before, t, now.pair);
    changed = after !== before;
    if (changed) fs.writeFileSync(pyproj, after, 'utf-8');
  } catch (e) {
    restore();
    return step('llm-playbook 최소 판', false, `${e.message} · 되돌림`);
  }
  const test = sh(PY, ['-X', 'utf8', '-m', 'pytest', '-q'], { cwd: llm, timeout: 900_000 });
  if (!test.ok) { restore(); return step('llm-playbook 시험', false, `${lastLine(test.stdout)} · 되돌림`); }
  step('llm-playbook 시험', true, lastLine(test.stdout));
  const probe = sh(PY, ['-X', 'utf8', '-c', PY_PROBE], { cwd: llm, timeout: 300_000 });
  if (!probe.ok) { restore(); return step('파이썬 실제 호출', false, '응답 없음 · 되돌림'); }
  step('파이썬 실제 호출', true, lastLine(probe.stdout));
  if (!changed) return step('llm-playbook 최소 판', true, `이미 ${t} — 커밋 없음`);
  const sha = commit(llm, ['pyproject.toml'],
    `sdk 최소 판 ${prev} → ${t} — Claude Code(${c.cli})와 판을 맞춤\n\n`
    + '주간 판 대조 → 스탠리 버튼으로 반영(claude-code-slack-bot scripts/sdk-update.mjs) · pytest · 실제 호출 통과.\n');
  if (!sha) { restore(); return step('llm-playbook 커밋', false, '커밋 실패 · 되돌림'); }
  if (has('--no-push')) return step('llm-playbook 커밋', true, `${sha} (푸시 안 함)`);
  if (!git(llm, 'push', 'origin', 'HEAD').ok) return step('llm-playbook 푸시', false, `커밋 ${sha} 는 됐고 푸시 실패`);
  return step('llm-playbook 커밋·푸시', true, sha);
}

/** 재시작 — 돌던 일이 있으면 `restart.mjs` 가 멈춘다. 2분마다 다시, 30분까지. */
async function restartBot(step) {
  for (let i = 0; i < 15; i++) {
    if (sh(process.execPath, [path.join('scripts', 'restart.mjs')], { timeout: 300_000 }).ok) {
      return step('봇 재시작', true, i ? `${i + 1}번째 시도에 됨` : '');
    }
    log('재시작 보류(돌던 일) — 2분 뒤 다시');
    await sleep(120_000);
  }
  return step('봇 재시작', false, '30분 동안 돌던 일이 안 끝남 — 손으로 npm run restart');
}

function describe(c) {
  const part = (label, s) => `${label} ${s.version}(짝 ${s.pair})${s.target ? ` → ${s.target}` : ''}`;
  return `Claude Code ${c.cli} · ${part('봇 SDK', c.ts)} · ${part('파이썬 SDK', c.py)}`;
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
  const save = () => writeJson(RESULT, res);
  const step = (name, ok, detail = '') => { res.steps.push({ name, ok, detail }); save(); return ok; };
  const finish = (status) => { res.status = status; res.finishedAt = iso(); save(); return status === 'done' ? 0 : 1; };
  save();

  let llm;
  try { llm = llmRoot(); } catch (e) { step('점검', false, e.message); return finish('failed'); }
  for (const [label, cwd] of [['봇 저장소', ROOT], ['llm-playbook', llm]]) {
    const why = busy(cwd);
    if (why) { res.busy = true; step('점검', false, `다른 작업 중(${label}) — ${why}`); return finish('failed'); }
  }
  for (const [label, cwd] of [['봇 저장소', ROOT], ['llm-playbook', llm]]) {
    if (!git(cwd, 'pull', '--ff-only', '-q').ok) { step('점검', false, `최신으로 못 당김(${label})`); return finish('failed'); }
  }
  step('점검', true, '두 저장소 모두 기본 브랜치 · 깨끗함 · 최신');

  let c;
  try { c = check(); } catch (e) { step('판 대조', false, e.message); return finish('failed'); }
  res.before = c;
  step('판 대조', true, describe(c));
  if (!c.needed) { step('할 일', true, '이미 맞음'); return finish('done'); }
  if (res.dryRun) { step('미리 보기', true, '여기까지 — 설치·커밋 안 함'); return finish('done'); }

  if (c.ts.target && !tsStage(c, step)) return finish('failed');
  if (c.py.target && !pyStage(c, llm, step)) return finish('failed');
  if (c.ts.target && !has('--no-restart') && !(await restartBot(step))) return finish('failed');
  return finish('done');
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
