/**
 * 가짜 codex — 검사가 **진짜 codex 를 부르지 않고** codex 한 차례(`codexTurn`)를 실행으로 재게 한다.
 *
 *   const fake = makeFakeCodex();
 *   process.env.BOARD_NARROW_CODEX_BIN = fake.bin;
 *   process.env.FAKE_CODEX_MODE = 'ok';          // ok · ok-noop · slow · usage-after-write · usage-event · usage-stderr · fail
 *   … 부른 뒤 fake.calls() 로 받은 인자 · 환경 변수를 본다
 *
 * 받은 것을 한 줄 JSON 으로 남긴다 — 인자 전부 · 부르는 쪽이 얹은 환경 변수 둘(`CLAUDE_SCHEDULED` ·
 * `WORK_ASSISTANT_CAPTURE_FILE`) · DM 폴백이 얹는 둘(`dmEnv` — `WORK_ASSISTANT_CAPTURE` · `CLAUDE_BOT_SESSION`) ·
 * API 키가 넘어왔나 · 받은 프롬프트(표준 입력) · 띄운 시각. 답은 `-o` 파일과 `--json` 이벤트 둘로 낸다
 * (`FAKE_CODEX_REPLY` 로 답 글을 바꾼다). `slow` 는 `FAKE_CODEX_SLOW_MS`(기본 1500) 쉬었다 답하고, 끝난 시각을
 * 따로 남긴다(`fake.ends()`) — 같은 방의 두 차례가 겹치는지 잰다.
 * **한도 글의 모양은 지어낸 것이다** — codex 가 실제로 한도에 걸린 글은 아직 봇 로그에 없다.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCRIPT = String.raw`
import fs from 'node:fs';
const argv = process.argv.slice(2);
const mode = process.env.FAKE_CODEX_MODE || 'ok';
let prompt = '';
try { prompt = fs.readFileSync(0, 'utf-8'); } catch { /* 표준 입력이 없다 */ }
const startedAt = Date.now();
fs.appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({
  argv, mode,
  env: {
    CLAUDE_SCHEDULED: process.env.CLAUDE_SCHEDULED ?? null,
    WORK_ASSISTANT_CAPTURE_FILE: process.env.WORK_ASSISTANT_CAPTURE_FILE ?? null,
  },
  dmEnv: {
    WORK_ASSISTANT_CAPTURE: process.env.WORK_ASSISTANT_CAPTURE ?? null,
    CLAUDE_BOT_SESSION: process.env.CLAUDE_BOT_SESSION ?? null,
  },
  apiKey: Object.keys(process.env).some((k) => k.toUpperCase() === 'ANTHROPIC_API_KEY'),
  prompt,
  at: startedAt,
}) + '\n');
const out = argv[argv.indexOf('-o') + 1];
const reply = process.env.FAKE_CODEX_REPLY || '☀️ codex 답';
const ev = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const cmd = 'python -X utf8 bin/tasks.py log --id TSK-1 --text 진행';
ev({ type: 'thread.started', thread_id: 't-fake' });
ev({ type: 'turn.started' });
if (mode === 'ok') {
  ev({ type: 'item.started', item: { id: 'c1', type: 'command_execution', command: cmd, status: 'in_progress' } });
  ev({ type: 'item.completed', item: { id: 'c1', type: 'command_execution', command: cmd, exit_code: 0, status: 'completed' } });
  ev({ type: 'item.started', item: { id: 'c2', type: 'command_execution', command: 'x'.repeat(300), status: 'in_progress' } });
  ev({ type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: '이벤트 쪽 답' } });
  ev({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } });
  if (out && process.env.FAKE_CODEX_NO_OUT !== '1') fs.writeFileSync(out, reply, 'utf-8');
  process.exit(0);
}
if (mode === 'ok-noop' || mode === 'slow') {
  if (mode === 'slow') {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.FAKE_CODEX_SLOW_MS || 1500));
  }
  ev({ type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: reply } });
  ev({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } });
  if (out) fs.writeFileSync(out, reply, 'utf-8');
  fs.appendFileSync(process.env.FAKE_CODEX_LOG + '.ends', JSON.stringify({ startedAt, at: Date.now() }) + '\n');
  process.exit(0);
}
if (mode === 'usage-after-write') {
  ev({ type: 'item.started', item: { id: 'c1', type: 'command_execution', command: cmd, status: 'in_progress' } });
  ev({ type: 'item.completed', item: { id: 'c1', type: 'command_execution', command: cmd, exit_code: 0, status: 'completed' } });
  const m = "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro) or try again in 2 hours 5 minutes.";
  ev({ type: 'error', message: m });
  ev({ type: 'turn.failed', error: { message: m } });
  process.exit(1);
}
if (mode === 'fail-cmd-usage') {
  // 명령이 실패(종료 코드 1)로 끝난 뒤 한도 — 보류 칸에 「완료」가 아니라 「실패」로 가야 한다(2026-10-15 검토).
  ev({ type: 'item.started', item: { id: 'c1', type: 'command_execution', command: cmd, status: 'in_progress' } });
  ev({ type: 'item.completed', item: { id: 'c1', type: 'command_execution', command: cmd, exit_code: 1, status: 'failed' } });
  const m = "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro) or try again in 2 hours 5 minutes.";
  ev({ type: 'error', message: m });
  ev({ type: 'turn.failed', error: { message: m } });
  process.exit(1);
}
if (mode === 'usage-event') {
  const m = "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro) or try again in 2 hours 5 minutes.";
  ev({ type: 'error', message: m });
  ev({ type: 'turn.failed', error: { message: m } });
  process.exit(1);
}
if (mode === 'usage-stderr') {
  process.stderr.write('ERROR: exceeded retry limit, last status: 429 Too Many Requests\n');
  process.exit(1);
}
process.stderr.write('ERROR: stream disconnected before completion: 연결 끊김(시험)\n');
ev({ type: 'turn.failed', error: { message: 'stream disconnected before completion' } });
process.exit(1);
`;

/** 임시 폴더에 가짜 codex 를 짓는다. `bin` 을 `BOARD_NARROW_CODEX_BIN` 에 넣는다. */
export function makeFakeCodex(dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-codex-'))) {
  const js = path.join(dir, 'fake-codex.mjs');
  const log = path.join(dir, 'calls.jsonl');
  fs.writeFileSync(js, SCRIPT, 'utf-8');
  let bin;
  if (process.platform === 'win32') {
    // 봇은 윈도에서 셸을 끼워 띄운다 — `.cmd` 가 그 길로 뜬다.
    bin = path.join(dir, 'codex.cmd');
    fs.writeFileSync(bin, `@"${process.execPath}" "${js}" %*\r\n`, 'utf-8');
  } else {
    bin = path.join(dir, 'codex');
    fs.writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${js}" "$@"\n`, 'utf-8');
    fs.chmodSync(bin, 0o755);
  }
  process.env.FAKE_CODEX_LOG = log;
  const read = (f) => (fs.existsSync(f)
    ? fs.readFileSync(f, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  return {
    bin,
    log,
    dir,
    /** 지금까지 받은 호출들. */
    calls() { return read(log); },
    /** `slow` · `ok-noop` 이 끝난 시각들(띄운 시각과 짝). */
    ends() { return read(`${log}.ends`); },
    cleanup() { fs.rmSync(dir, { recursive: true, force: true }); },
  };
}
