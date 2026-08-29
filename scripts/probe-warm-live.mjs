/**
 * 미리 띄운 세션이 **진짜 SDK 로도 끝나는지** 한 번 확인한다.
 *
 * ⚠️ `check:prewarm` 은 가짜 `query` 를 쓰므로 이것을 못 본다. 프롬프트를 흐름으로
 * 주면 SDK 가 「대화가 이어진다」고 보아 답이 끝나도 표준입력을 안 닫을 수 있고,
 * 그러면 읽는 쪽의 `for await` 이 **영영 안 끝난다** — 슬랙 대화가 통째로 멈춘다.
 *
 * 진짜 호출이라 구독 한도를 쓴다. 그래서 검사에 안 넣고 손으로 한 번 돌린다.
 */
import './lib/fresh-dist.mjs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { SdkHandler } = require(path.join(ROOT, 'dist', 'sdk-handler.js'));

const mcp = { getServerConfiguration: () => ({}), getDefaultAllowedTools: () => [] };
const OPTS = {
  model: 'claude-haiku-4-5-20251001',
  effort: 'low',
  permissionMode: 'dontAsk',
  tools: [], allowedTools: [], skills: [], settingSources: [],
  skipMcp: true,
  systemPrompt: '한 낱말로만 답한다.',
};

const h = new SdkHandler(mcp);
h.prewarm(OPTS);
await new Promise((r) => setTimeout(r, 3000));   // 뜰 시간을 준다

const t = Date.now();
const p = h.runQuery('ok 라고만 답하세요', OPTS);

let sawResult = false, texts = [];
const timer = setTimeout(() => {
  console.log('⛔ 20초 안에 안 끝났습니다 — 표준입력이 안 닫힙니다');
  process.exit(1);
}, 20000);

for await (const ev of p) {
  if (ev.type === 'assistant') {
    for (const b of (ev.message?.content || [])) if (b.type === 'text') texts.push(b.text);
  }
  if (ev.type === 'result') sawResult = true;
}
clearTimeout(timer);

const secs = ((Date.now() - t) / 1000).toFixed(1);
console.log(`${sawResult ? '○' : '✗'} 결과를 받고 흐름이 끝났습니다 — ${secs}초`);
console.log(`  답: ${texts.join('').trim().slice(0, 60)}`);
process.exit(sawResult ? 0 : 1);
