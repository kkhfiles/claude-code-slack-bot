/**
 * 이어 갈 지점(`resumeSessionAt`) — 끊긴 차례가 대화를 망가뜨리지 않게(2026-11-19).
 *
 * 그날 08:47 서랍 차례가 도구를 부르다 끊겼고, 봇은 그 끊긴 메시지를 세션의 이어 갈 지점으로 적었다. Claude 는 대화를
 * 읽을 때 결과 없는 도구 호출을 빼므로 「No message found with message.uuid」로 그 대화의 다음 차례가 전부 글 없이
 * 끝났다(서랍 답이 「생각 중」으로 굳음). 여기서 보는 것:
 * - `SdkProcess` — 그 오류(던짐이든 오류 결과든)면 지점 없이 한 번 다시 띄우고, 그 오류는 내보내지 않음
 * - 이미 무엇을 내보낸 뒤의 오류, 다른 오류, 다시 띄우는 길이 없는 경우는 예전대로 오류를 내보냄
 * - 다시 띄우는 것은 한 번뿐
 * - 배선 — 봇은 성공한 결과에서만 이어 갈 지점을 옮기고, 지점을 준 차례에만 다시 띄우는 길을 붙임
 */
import './lib/fresh-dist.mjs';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 시험이 운영 엔진 상태 파일을 안 건드리게(`engine-state.ts`)
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-point-'));
process.env.ENGINE_STATE_FILE = path.join(TMP, 'engine-state.json');
const { SdkProcess } = require(path.join(ROOT, 'dist', 'sdk-handler.js'));

const fails = [];
const ok = (name, cond) => { if (!cond) fails.push(name); };

const MISSING = 'Claude Code returned an error result: No message found with message.uuid of: 0ed017a8';
const errResult = (text) => ({ type: 'result', subtype: 'error_during_execution', is_error: true, result: text,
  session_id: 's', total_cost_usd: 0, duration_ms: 0, permission_denials: [] });
const assistant = { type: 'assistant', uuid: 'u-new', message: { content: [{ type: 'text', text: '답' }] } };
const success = { type: 'result', subtype: 'success', is_error: false, result: '답',
  session_id: 's', total_cost_usd: 0, duration_ms: 1, permission_denials: [] };

// 실제 SDK 모양 그대로 — 무엇보다 먼저 시작 알림(init)이 온다. 이것을 빼고 쟀더니 시험은 통과하고 운영에서는 한 번도
// 다시 띄우지 않았다(7cee60b · 10:43 메일 차례)
const init = { type: 'system', subtype: 'init', session_id: 's', model: 'opus', tools: [] };
async function* gen(events, throwMsg) {
  yield init;
  for (const e of events) yield e;
  if (throwMsg) throw new Error(throwMsg);
}
let made = 0;
const freshOk = () => { made++; return { q: gen([assistant, success]), ac: new AbortController() }; };
const freshMissing = () => { made++; return { q: gen([errResult('')], MISSING), ac: new AbortController() }; };

async function run(q, retry) {
  const out = [];
  for await (const ev of new SdkProcess(q, new AbortController(), 'claude', retry)) out.push(ev);
  return out;
}
const isErr = (out) => out.some((e) => e.type === 'result' && e.is_error);
const isOk = (out) => out.some((e) => e.type === 'result' && e.subtype === 'success');

{
  made = 0;
  const out = await run(gen([errResult('')], MISSING), freshOk);
  ok('던진 「No message found」 — 다시 띄움', made === 1);
  ok('던진 「No message found」 — 오류를 안 내보내고 새 답만', !isErr(out) && isOk(out));
}
{
  made = 0;
  const out = await run(gen([errResult(MISSING)]), freshOk);
  ok('오류 결과로만 온 「No message found」 — 다시 띄움', made === 1 && !isErr(out) && isOk(out));
}
{
  made = 0;
  const out = await run(gen([errResult('')], MISSING), freshMissing);
  ok('다시 띄워도 같은 오류 — 한 번만 다시 함', made === 1);
  ok('다시 띄워도 같은 오류 — 오류를 내보냄', isErr(out));
}
{
  made = 0;
  const out = await run(gen([assistant], MISSING), freshOk);
  ok('이미 글을 내보낸 뒤의 오류 — 다시 안 띄움', made === 0 && isErr(out));
}
{
  made = 0;
  const out = await run(gen([errResult('')], 'Claude Code returned an error result: overloaded'), freshOk);
  ok('다른 오류 — 다시 안 띄움', made === 0 && isErr(out));
}
{
  const out = await run(gen([errResult('')], MISSING), undefined);
  ok('다시 띄우는 길이 없으면 — 예전대로 오류', isErr(out));
}
{
  const out = await run(gen([assistant, success]), freshOk);
  ok('평소 차례 — 그대로', isOk(out) && !isErr(out) && out.length === 3);
}

// 배선
const handler = fs.readFileSync(path.join(ROOT, 'src', 'slack-handler.ts'), 'utf-8');
const sets = [...handler.matchAll(/session\.lastAssistantUuid\s*=\s*([^;]+);/g)].map((m) => m[1].trim());
ok(`봇은 이어 갈 지점을 성공한 결과의 값과 되돌리기 값으로만 적음 — ${JSON.stringify(sets)}`,
  sets.length === 2 && sets.includes('pendingAssistantUuid') && sets.includes('restoreSession.uuid'));
ok('성공한 결과에서만 옮김',
  /subtype === 'success' && !resultEvent\.is_error && pendingAssistantUuid/.test(handler));
const sdk = fs.readFileSync(path.join(ROOT, 'src', 'sdk-handler.ts'), 'utf-8');
ok('지점을 준 차례에만 다시 띄우는 길을 붙임', /resumeSessionAt \? \(\) =>/.test(sdk)
  && /new SdkProcess\(q, ac, 'claude', retry\)/.test(sdk));

// 같은 사고의 다른 고리 둘(2026-11-19) — 오류로 끝난 봇 차례가 조용히 사라지지 않게
ok('봇이 넣은 차례(메일 · 판)가 Claude 오류로 끝나면 실패로 적음(드레인이 다시 돌림)',
  /else if \(cliError && !fallbackDone && !claudeStopped && captureId && \(event as any\)\.pushed && !event\.drawer\) \{[\s\S]{0,600}?markTurnFailed\(captureId, 'error'/.test(handler));
const sched = fs.readFileSync(path.join(ROOT, 'src', 'assistant-scheduler.ts'), 'utf-8');
ok('서랍 차례가 빈 답으로 끝나면 빈 말풍선 대신 오류로 씀',
  /last\.trim\(\)\s*\?\s*await finishDrawerTurn\(item\.reply\.tid, \{ answer: last \}\)\s*:\s*await finishDrawerTurn\(item\.reply\.tid, \{ error: /.test(sched));

fs.rmSync(TMP, { recursive: true, force: true });
if (fails.length) {
  console.error(`❌ 이어 갈 지점 ${fails.length}건 실패`);
  for (const f of fails) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('✅ 이어 갈 지점 — 끊긴 메시지를 안 적고, 못 찾으면 지점 없이 한 번 다시 띄움');
