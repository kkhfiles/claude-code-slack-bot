/**
 * 가짜 agy 백엔드 — 검사가 **진짜 agy 를 부르지 않고** agy 한 차례(`agyCall` · `agyTurn`)를 실행으로 재게 한다.
 *
 *   const fake = makeFakeAgy();
 *   process.env.AGY_TURN_CMD = fake.cmd;               // 봇이 띄울 명령(JSON 배열)
 *   process.env.FAKE_AGY_MODES = JSON.stringify({ 'flash-high': 'quota', 'sonnet-thinking': 'ok' });
 *   process.env.FAKE_AGY_REPLIES = JSON.stringify({ 'sonnet-thinking': '{"reply":"…"}' });
 *   … 부른 뒤 fake.calls() 로 받은 인자 · 환경 변수 · 프롬프트를 본다
 *
 * 모양은 llm-playbook 의 agy 백엔드(`python -m llm_playbook.backends.agy`) CLI 를 따른다 — 답은 `--out` 파일,
 * 진단은 stderr 끝 줄 `[agy-client] model=… attempts=[(…, 'ok')] elapsed=… rc=… err=…`.
 * **쿼터는 진짜처럼** 쿼터 글을 `--out` 에 쓰고 rc 0 으로 끝난다(백엔드가 그렇게 한다 · attempts 가 정본).
 *
 * 갈래(별칭마다 · 없으면 `FAKE_AGY_MODE` · 기본 ok): ok · quota · fail · slow(`FAKE_AGY_SLOW_MS` 쉬었다 ok)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCRIPT = String.raw`
import fs from 'node:fs';
const argv = process.argv.slice(2);
const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const model = arg('--model') || '';
const modes = JSON.parse(process.env.FAKE_AGY_MODES || '{}');
const replies = JSON.parse(process.env.FAKE_AGY_REPLIES || '{}');
const mode = modes[model] || process.env.FAKE_AGY_MODE || 'ok';
let prompt = '';
try { prompt = fs.readFileSync(arg('--prompt-file'), 'utf-8'); } catch { /* 없다 */ }
fs.appendFileSync(process.env.FAKE_AGY_LOG, JSON.stringify({
  argv, model, mode, prompt,
  env: {
    WORK_ASSISTANT_CAPTURE: process.env.WORK_ASSISTANT_CAPTURE ?? null,
    CLAUDE_BOT_SESSION: process.env.CLAUDE_BOT_SESSION ?? null,
  },
  apiKey: Object.keys(process.env).some((k) => k.toUpperCase() === 'ANTHROPIC_API_KEY'),
  at: Date.now(),
}) + '\n');
const out = arg('--out');
const label = model === 'flash-high' ? 'Gemini Fake Flash (High)' : 'Claude Fake Sonnet (High)';
const tail = (why, rc) => process.stderr.write("[agy-client] model='" + label + "' attempts=[('" + label + "', '" + why + "')] elapsed=0.1s rc=" + rc + ' err=None\n');
if (mode === 'quota') {
  const q = 'Resource has been exhausted (e.g. check quota). 429';
  if (out) fs.writeFileSync(out, q, 'utf-8');
  process.stderr.write("[agy-client] model='" + label + "': quota/limit signal — cross-pool fallback\n");
  process.stderr.write("[agy-client] all models failed\n");
  tail('quota/limit', 0);
  process.stdout.write(q + '\n');
  process.exit(0);
}
if (mode === 'fail') {
  process.stderr.write("[agy-client] model='" + label + "' attempts=[('" + label + "', 'no-output/rc=1 stderr=boom')] elapsed=0.1s rc=1 err=rc=1\n");
  process.exit(1);
}
if (mode === 'slow') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.FAKE_AGY_SLOW_MS || 1500));
const reply = replies[model] ?? process.env.FAKE_AGY_REPLY ?? '{"reply":"가짜 agy 답입니다.","actions":[]}';
if (out) fs.writeFileSync(out, reply, 'utf-8');
tail('ok', 0);
process.stdout.write(reply + '\n');
process.exit(0);
`;

/** 임시 폴더에 가짜 agy 를 짓는다. `cmd` 를 `AGY_TURN_CMD` 에 넣는다(셸 없이 노드로 띄움). */
export function makeFakeAgy(dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-agy-'))) {
  const js = path.join(dir, 'fake-agy.mjs');
  const log = path.join(dir, 'calls.jsonl');
  fs.writeFileSync(js, SCRIPT, 'utf-8');
  process.env.FAKE_AGY_LOG = log;
  const read = () => (fs.existsSync(log)
    ? fs.readFileSync(log, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  return {
    cmd: JSON.stringify([process.execPath, js]),
    log,
    dir,
    calls: read,
    cleanup() { fs.rmSync(dir, { recursive: true, force: true }); },
  };
}
