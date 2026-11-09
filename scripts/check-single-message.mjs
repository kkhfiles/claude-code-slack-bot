/**
 * 메일 차례는 한 통으로(2026-11-09 실장 결정 V2 「답 한 통만」) — 전에는 머리 줄 + 명령어 안내 + 답 + 엔진 줄로
 * 차례마다 네 통이었다. 여기서 보는 것:
 * - `singleMessage` — 머리 줄 + 답 한 통, 엔진 줄은 작은 글로 같은 통에. `[조용히]` · 빈 답 · 상태 줄뿐이면 머리 줄만
 * - `isStatusLine` — 「🤔 *생각 중...*」 같은 진행 상태 줄은 답으로 안 셈
 * - 배선 — 메일 폴러가 `single` 로 넘기고, 봇이 넘긴 차례(`pushed`)에는 명령어 안내 줄을 안 붙임
 */
import './lib/fresh-dist.mjs';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { singleMessage, isStatusLine } = require(path.join(ROOT, 'dist', 'single-message.js'));

const fails = [];
const ok = (name, cond) => { if (!cond) fails.push(name); };
const eq = (name, a, b) => ok(`${name} — ${JSON.stringify(a)}`, JSON.stringify(a) === JSON.stringify(b));

const HEAD = '📬 메일 후보 2건 — 「Remind: 웨비나 진행 안내」 외 1건';
{
  const m = singleMessage('D1', HEAD, '• 웨비나 — 11/10(화) 기한을 기존 업무에 기록했어요.', '');
  eq('답이 있으면 머리 줄 + 답 한 통', m.text, `${HEAD}\n• 웨비나 — 11/10(화) 기한을 기존 업무에 기록했어요.`);
  ok('엔진 줄이 없으면 블록 없이 글만', m.blocks === undefined);
}
{
  const marker = '↪ GPT(gpt-6.1-sol) 가 답함 · Claude 사용량 소진(풀림 11/09(월) 10:00)';
  const m = singleMessage('D1', HEAD, '답', marker);
  eq('엔진 줄은 같은 통의 작은 글(context)', m.blocks.map((b) => b.type), ['section', 'context']);
  ok('엔진 줄 글이 그대로', m.blocks[1].elements[0].text === marker);
  ok('알림 글에도 엔진 줄', m.text.endsWith(marker));
}
eq('[조용히] 답이면 머리 줄만', singleMessage('D1', HEAD, '[조용히]', '').text, HEAD);
eq('빈 답이면 머리 줄만', singleMessage('D1', HEAD, '  ', '').text, HEAD);
eq('상태 줄뿐이면 머리 줄만', singleMessage('D1', HEAD, '🤔 *생각 중...*', '').text, HEAD);
eq('상태 줄 판정', ['🤔 *생각 중...*', '✍️ *작성 중...*', '🔧 *Bash 사용 중... (3)*', '• *웨비나* — 기록했어요'].map(isStatusLine),
  [true, true, true, false]);
ok('굵은 글로 시작하는 답은 상태 줄 아님', !isStatusLine('*처리 결과* 둘 다 반영했어요'));

// 배선 — 소스에서 본다(슬랙 통로를 띄우지 않고)
const sched = fs.readFileSync(path.join(ROOT, 'src', 'assistant-scheduler.ts'), 'utf-8');
const handler = fs.readFileSync(path.join(ROOT, 'src', 'slack-handler.ts'), 'utf-8');
ok('메일 폴러가 한 통으로 넘김(single)', /📬 메일 후보 \$\{r\.threads\.length\}건`, '', \{ single: true \}\)/.test(sched));
ok('봇이 넘긴 차례에는 명령어 안내를 안 붙임', /isNewSession && !event\.drawer && !\(event as any\)\.pushed && !this\.hintShownThreads/.test(handler));
ok('한 통 길은 끝에 singleMessage 한 번', /chat\.postMessage\(singleMessage\(channel, head, lastText, lastMarker\)\)/.test(handler));

if (fails.length) {
  console.error(`실패 ${fails.length}건\n`);
  for (const f of fails) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log('통과 — 메일 차례 한 통(머리 줄 + 답 · 엔진 줄은 같은 통 · 조용히와 상태 줄은 머리 줄만 · 메일 폴러 배선 · 봇이 넘긴 차례에 안내 줄 없음)');
