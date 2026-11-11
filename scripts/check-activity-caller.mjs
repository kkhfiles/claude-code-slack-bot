/**
 * 활동 기록의 「부른곳」 — 실장 DM 으로 나간 글을 **보낸 코드 자리**로 가를 수 있는지 잰다.
 *
 *   node scripts/check-activity-caller.mjs
 *
 * 왜 재나 — 세나 알림 문 1단계(2026-11-11)가 이 칸으로 갈래별 하루 건수를 센다. 개인 글 문(`privacy-guard`)이
 * 길목을 **async 로 한 겹 더 감싸고 먼저 await 한다** — 그 뒤 안쪽에서 잰 스택에 부른 자리가 남는지가 관건이다.
 * 남지 않으면 갈래가 전부 빈칸이 되는데 오류는 안 난다.
 */
import './lib/fresh-dist.mjs';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'check-caller-'));
process.env.BOT_ACTIVITY_DIR = TMP;
const { callerOf, installActivityLog, installCallerProbe, tagToken } = require(path.join(ROOT, 'dist', 'activity-log.js'));
const { WebClient } = require('@slack/web-api');

let pass = 0;
const fails = [];
const check = (name, ok, got) => {
  if (ok) { pass++; console.log(`PASS ${name}`); return; }
  fails.push(name);
  console.log(`FAIL ${name} — 받음 ${JSON.stringify(got)}`);
};

// --- 글 모양 ------------------------------------------------------------------------
check('메서드 이름이 있으면 파일:함수',
  callerOf('Error\n    at patched (C:\\bot\\dist\\activity-log.js:270:20)\n    at SlackHandler.postNudge (C:\\bot\\dist\\slack-handler.js:812:7)')
    === 'slack-handler.ts:postNudge');
check('라이브러리와 길목은 건너뜀',
  callerOf('Error\n    at x (C:\\bot\\node_modules\\@slack\\web-api\\dist\\WebClient.js:1:1)\n    at guarded (C:\\bot\\dist\\privacy-guard.js:3:3)\n    at async AssistantScheduler.briefing (C:\\bot\\dist\\assistant-scheduler.js:40:9)')
    === 'assistant-scheduler.ts:briefing');
check('이름 없는 함수는 파일:줄', callerOf('Error\n    at C:\\bot\\dist\\mail-poll.js:55:3') === 'mail-poll.ts:55');
check('못 찾으면 빈 글', callerOf('Error\n    at node:internal/process:1:1') === '');
check('공통 도우미를 지나면 그것을 부른 자리까지 두 단(11/11 — 첫 단만 적으면 예약 작업이 다 sendMessage 였다)',
  callerOf('Error\n    at probe (C:\\bot\\dist\\activity-log.js:1:1)\n    at SlackHandler.sendMessage (C:\\bot\\dist\\slack-handler.js:3:3)\n'
    + '    at async AssistantScheduler.runResultPoll (C:\\bot\\dist\\assistant-scheduler.js:9:9)\n    at async x (C:\\bot\\dist\\index.js:1:1)')
    === 'slack-handler.ts:sendMessage ← assistant-scheduler.ts:runResultPoll');
check('같은 자리가 이어지면 한 번만', callerOf('Error\n    at a (C:\\bot\\dist\\x.js:1:1)\n    at a (C:\\bot\\dist\\x.js:1:1)') === 'x.ts:a');

// --- 실제 길목 — async 로 감싸고 먼저 await 하는 바깥 문이 있어도 부른 자리가 남나 --------------------
WebClient.prototype.apiCall = async function fake(method) { return { ok: true, method }; };
installActivityLog();
// 바깥 문 — privacy-guard 와 같은 모양(async, 먼저 await)을 같은 파일 이름으로 둔다(그 파일 줄은 건너뛰는 규칙이라)
const guardFile = path.join(TMP, 'privacy-guard.js');
fs.writeFileSync(guardFile, `module.exports = (W) => { const inner = W.prototype.apiCall;
  W.prototype.apiCall = async function guarded(method, options) { await new Promise((r) => setTimeout(r, 5)); return inner.call(this, method, options); }; };`);
require(guardFile)(WebClient);
tagToken('xoxb-test', 'assistant');   // 봇 이름이 없으면 파일 이름이 「?-…」가 되어 Windows 에서 못 쓴다
const client = new WebClient('xoxb-test');
const rows = () => fs.readdirSync(TMP).filter((f) => f.endsWith('.jsonl'))
  .flatMap((f) => fs.readFileSync(path.join(TMP, f), 'utf-8').trim().split('\n').map((l) => JSON.parse(l)));
const sentText = (t) => rows().find((r) => r.kind === '보냄' && r.말 === t);

async function sendMorningNudge() {
  await client.chat.postMessage({ channel: 'D_ME', text: '시험 넛지' });
}
await sendMorningNudge();
await new Promise((r) => setTimeout(r, 30));
check('바깥 문이 먼저 await 해도 기다리는 호출은 부른 자리가 남는다',
  String(sentText('시험 넛지')?.부른곳).startsWith('check-activity-caller.mjs:sendMorningNudge'), sentText('시험 넛지'));

function fireAndForget() {   // 기다리지 않고 던져 두는 발신 — async 스택이 안 이어진다
  client.chat.postMessage({ channel: 'D_ME', text: '던져 둔 알림' }).catch(() => {});
}
fireAndForget();
await new Promise((r) => setTimeout(r, 30));
check('바깥 재기 없이는 던져 둔 발신의 부른 자리를 잃는다(이 검사가 재는 것이 맞는지)',
  !String(sentText('던져 둔 알림')?.부른곳).startsWith('check-activity-caller.mjs:fireAndForget'), sentText('던져 둔 알림'));

installCallerProbe();
// 클라이언트는 메서드를 만들 때 그때의 apiCall 을 묶는다 — 운영도 길목을 다 건 뒤에 App 을 만든다(index.ts)
const client2 = new WebClient('xoxb-test');
function fireAndForget2() {
  client2.chat.postMessage({ channel: 'D_ME', text: '던져 둔 알림 2' }).catch(() => {});
}
fireAndForget2();
await new Promise((r) => setTimeout(r, 30));
check('가장 바깥 재기가 있으면 던져 둔 발신도 부른 자리가 남는다',
  String(sentText('던져 둔 알림 2')?.부른곳).startsWith('check-activity-caller.mjs:fireAndForget2'), sentText('던져 둔 알림 2'));
async function viaHelper() {   // 운영처럼 공통 도우미를 지나는 발신 — 두 단이 다 남나
  const helper = async (text) => { await client2.chat.postMessage({ channel: 'D_ME', text }); };
  await helper('도우미 지남');
}
await viaHelper();
await new Promise((r) => setTimeout(r, 30));
check('공통 도우미를 지나도 부른 쪽 함수가 남는다(실제 길목)',
  String(sentText('도우미 지남')?.부른곳).includes('← check-activity-caller.mjs:viaHelper'), sentText('도우미 지남'));
await sendMorningNudge();
await new Promise((r) => setTimeout(r, 30));
check('들어오지 않은 다른 메서드는 부른곳을 안 적는다',
  !rows().some((r) => r.무엇 !== 'chat.postMessage' && r.부른곳), rows().map((r) => r.무엇));

console.log(`\n${pass} 통과 · ${fails.length} 실패`);
if (fails.length) process.exit(1);
