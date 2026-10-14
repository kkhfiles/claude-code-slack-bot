/**
 * 가짜 codex — 검사가 **진짜 codex 를 부르지 않고** codex 한 차례(`codexTurn`)를 실행으로 재게 한다.
 *
 *   const fake = makeFakeCodex();
 *   process.env.BOARD_NARROW_CODEX_BIN = fake.bin;
 *   process.env.FAKE_CODEX_MODE = 'ok';          // ok · usage-event · usage-stderr · fail
 *   … 부른 뒤 fake.calls() 로 받은 인자 · 환경 변수를 본다
 *
 * 받은 것을 한 줄 JSON 으로 남긴다 — 인자 전부 · 부르는 쪽이 얹은 환경 변수 둘(`CLAUDE_SCHEDULED` ·
 * `WORK_ASSISTANT_CAPTURE_FILE`) · API 키가 넘어왔나. 답은 `-o` 파일과 `--json` 이벤트 둘로 낸다.
 * **한도 글의 모양은 지어낸 것이다** — codex 가 실제로 한도에 걸린 글은 아직 봇 로그에 없다.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCRIPT = String.raw`
import fs from 'node:fs';
const argv = process.argv.slice(2);
const mode = process.env.FAKE_CODEX_MODE || 'ok';
fs.appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({
  argv, mode,
  env: {
    CLAUDE_SCHEDULED: process.env.CLAUDE_SCHEDULED ?? null,
    WORK_ASSISTANT_CAPTURE_FILE: process.env.WORK_ASSISTANT_CAPTURE_FILE ?? null,
  },
  apiKey: Object.keys(process.env).some((k) => k.toUpperCase() === 'ANTHROPIC_API_KEY'),
}) + '\n');
const out = argv[argv.indexOf('-o') + 1];
const ev = (o) => process.stdout.write(JSON.stringify(o) + '\n');
ev({ type: 'thread.started', thread_id: 't-fake' });
ev({ type: 'turn.started' });
if (mode === 'ok') {
  ev({ type: 'item.started', item: { id: 'c1', type: 'command_execution', command: 'python -X utf8 bin/tasks.py log --id TSK-1 --text 진행', status: 'in_progress' } });
  ev({ type: 'item.completed', item: { id: 'c1', type: 'command_execution', command: 'python -X utf8 bin/tasks.py log --id TSK-1 --text 진행', exit_code: 0, status: 'completed' } });
  ev({ type: 'item.started', item: { id: 'c2', type: 'command_execution', command: 'x'.repeat(300), status: 'in_progress' } });
  ev({ type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: '이벤트 쪽 답' } });
  ev({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } });
  if (out && process.env.FAKE_CODEX_NO_OUT !== '1') fs.writeFileSync(out, '☀️ codex 답', 'utf-8');
  process.exit(0);
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
  return {
    bin,
    log,
    dir,
    /** 지금까지 받은 호출들. */
    calls() {
      if (!fs.existsSync(log)) return [];
      return fs.readFileSync(log, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    },
    cleanup() { fs.rmSync(dir, { recursive: true, force: true }); },
  };
}
