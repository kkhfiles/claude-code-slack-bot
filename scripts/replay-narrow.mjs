/**
 * 좁은 길을 **운영 코드로** 재생한다 — 흉내내지 않는다.
 *
 *   node scripts/replay-narrow.mjs --truth truth81.jsonl --out replay10-prod.jsonl
 *                                  [--n 3] [--rules lab/board-prompt/narrow10.md]
 *                                  [--extras] [--tag a]
 *
 * ⛔ **왜 파이썬 하네스를 안 쓰나** (2026-09-10) — `lab/board-prompt/replay.py` 가
 *    운영과 아홉 곳에서 갈려 있었고, 맞춰도 회당 총 입력이 운영 9,241 대 하네스
 *    23,701 로 안 붙었다. 원인 하나는 **하네스를 돌리는 세션의 `CLAUDE*`
 *    환경변수가 6,872 토큰을 더 싣는 것**이고, 남은 약 2,700 은 못 찾았다.
 *    그래서 옵션을 다시 짓는 대신 **운영이 쓰는 `SdkHandler.runQuery` 를 그대로
 *    부른다.** 그러면 `buildOptions` 를 통과하는 옵션이 정의상 운영과 같다.
 *    경위 = work-assistant `docs/design.md` §5.17 「재측정을 하려다 알아낸 것 넷」.
 *
 * **정렬은 토큰 산수로 증명하지 않는다** — `SdkHandler` 가 스스로 찍는
 * 「Building SDK query」 덩어리를 운영 로그의 그것과 대조한다. `--n 1` 로 한 건만
 * 돌리면 그 덩어리가 stderr 로 나온다.
 *
 * ⚠️ **`CLAUDE*` 를 걷어내고 넘긴다** — pm2 로 도는 운영에는 그 변수가 없다.
 *    걷지 않으면 이 하네스도 옛 측정과 같은 함정에 빠진다.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { SdkHandler } from '../dist/sdk-handler.js';
import { McpManager } from '../dist/mcp-manager.js';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};

const ROOT = 'P:/github/work-assistant';
const TMP = path.join(process.env.TEMP, 'perf');
const TRUTH = arg('--truth', 'truth81.jsonl');
const RULES = arg('--rules', 'lab/board-prompt/narrow10.md');
// **계약·예시는 기본으로 안 싣는다** — 운영이 안 싣기 때문이다. `--extras` 는
// 「넣으면 나아지나」를 재는 갈래이고, 그때는 산출물 이름이 갈린다.
const EXTRAS = process.argv.includes('--extras');
const N = Number(arg('--n', '0')) || 0;
let OUT = arg('--out', 'replay-prod.jsonl');
if (EXTRAS) OUT = OUT.replace('.jsonl', '-extras.jsonl');
const TAG = arg('--tag', '');
if (TAG) OUT = OUT.replace('.jsonl', `-${TAG}.jsonl`);

const NL = '\n';
const rulesText = readFileSync(path.join(ROOT, RULES), 'utf-8');

// 계약·예시는 실험 하네스가 쓰던 것과 **같은 글자**여야 한다 — 안 그러면
// 「넣으면 나아지나」가 다른 것을 잰다. `replay.py` 에서 뽑아 온다.
function labExtras() {
  const src = readFileSync(path.join(ROOT, 'lab/board-prompt/replay.py'), 'utf-8');
  const grab = (name) => {
    const m = src.match(new RegExp(`^${name} = """([\\s\\S]*?)"""`, 'm'));
    if (!m) throw new Error(`replay.py 에서 ${name} 을 못 찾았다`);
    return m[1];
  };
  return grab('CONTRACT') + grab('EXAMPLES') + grab('EXTRA4');
}

const append = EXTRAS ? rulesText + labExtras() : rulesText;

// ── 운영과 같은 옵션 (`assistant-scheduler.narrowFromBoard`) ────────────────
// 이 덩어리를 고칠 때는 그쪽도 같이 본다. 한쪽만 고치면 정렬이 조용히 풀린다.
const NARROW_OPTS = {
  workingDirectory: ROOT,
  model: 'opus',
  effort: 'low',
  permissionMode: 'default',
  tools: [],
  allowedTools: [],
  settingSources: [],
  appendSystemPrompt: append,
  skipMcp: true,
  noSessionPersistence: true,
  maxDurationMs: 90_000,
};

/**
 * ⛔ **`opts.env` 에 안 담는 것으로는 안 걷힌다** (2026-09-10 실측) —
 * `buildOptions` 가 `{ ...process.env, ...opts.env }` 로 **process.env 를 먼저
 * 펴므로**, 넘기는 쪽에서 빼기만 하면 그 변수가 그대로 되살아난다.
 * **이 프로세스의 `process.env` 에서 지워야** 실제로 안 실린다.
 */
function scrubProcessEnv() {
  const gone = [];
  for (const k of Object.keys(process.env)) {
    if (/^CLAUDE/i.test(k)) { gone.push(k); delete process.env[k]; }
  }
  return gone;
}

const scrubbed = scrubProcessEnv();
console.log(`걷어낸 세션 변수 ${scrubbed.length}개: ${scrubbed.join(' ') || '없음'}`);

function scrubbedEnv() {
  // 운영이 넘기는 것과 같은 두 개만 준다 — 나머지는 위에서 프로세스에서 지웠다.
  return { ASSISTANT_MODE: 'narrow', CLAUDE_SCHEDULED: '1' };
}

function userText(k) {
  return [
    `오늘은 ${k.ts.slice(0, 10)}`, '',
    `업무: 「${k.title}」`,
    `지금 카드 값: ${k.card}`, '',
    '판 「프롬프트」 칸에 온 말:', k.text,
  ].join(NL);
}

/** 운영의 파싱과 같게 — 계약에 「JSON 만」이라고 적어도 모델은 감싼다. */
function parseLoose(t) {
  if (!t) return null;
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fence ? fence[1] : t;
  const i = body.indexOf('{');
  const j = body.lastIndexOf('}');
  if (i < 0 || j <= i) return null;
  try { return JSON.parse(body.slice(i, j + 1)); } catch { return null; }
}

const cases = readFileSync(path.join(TMP, TRUTH), 'utf-8')
  .split(NL).filter((x) => x.trim()).map((x) => JSON.parse(x))
  .filter((k) => k.title);
const picked = N ? cases.slice(0, N) : cases;

const handler = new SdkHandler(new McpManager());
const rows = [];

console.log(`재생할 것 ${picked.length}건 · 규칙 ${RULES}`
  + ` · ${EXTRAS ? '계약·예시 실음' : '운영 모양(판만)'} → ${OUT}`);

for (const [idx, k] of picked.entries()) {
  const t0 = Date.now();
  let text = '';
  let usage = null;
  let cost = 0;
  let subtype = 'success';
  let isError = false;
  let turns = 0;
  try {
    const proc = handler.runQuery(userText(k), { ...NARROW_OPTS, env: scrubbedEnv() });
    for await (const ev of proc) {
      if (ev.type === 'assistant') {
        turns += 1;
        const parts = ev.message?.content || [];
        const got = parts.filter((p) => p?.type === 'text').map((p) => p.text).join('');
        if (got) text = got;   // 운영과 같다 — 마지막 차례만 남긴다
      }
      if (ev.type === 'result') {
        cost = ev.total_cost_usd || 0;
        subtype = ev.subtype || 'success';
        isError = ev.is_error === true;
        usage = ev.usage || null;
        break;
      }
    }
  } catch (err) {
    subtype = 'threw';
    isError = true;
    text = '';
    console.log(`  터짐: ${err.message.slice(0, 90)}`);
  }
  const inTok = (usage?.input_tokens ?? 0) + (usage?.cache_creation_input_tokens ?? 0)
    + (usage?.cache_read_input_tokens ?? 0);
  const ms = Date.now() - t0;
  const got = isError ? null : parseLoose(text);
  rows.push({
    ...k, shape: EXTRAS ? 'prod+extras' : 'prod', ms, got,
    cost, in_tok: inTok, usage, subtype, turns, raw: text.slice(0, 4000),
  });
  console.log(`  ${String(idx + 1).padStart(2)}/${picked.length} ${(k.task || '?').padEnd(8)}`
    + ` ${(ms / 1000).toFixed(1)}s 입력 ${inTok.toLocaleString().padStart(7)}`
    + ` $${cost.toFixed(4)} ${got ? '○' : '✗'}`);
}

if (!existsSync(TMP)) mkdirSync(TMP, { recursive: true });
writeFileSync(path.join(TMP, OUT), rows.map((r) => JSON.stringify(r)).join(NL) + NL, 'utf-8');

const ok = rows.filter((r) => r.got).length;
const med = (xs) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
console.log('');
console.log(`남김 ${OUT} (${rows.length}건) · JSON 성공 ${ok}/${rows.length}`
  + ` · 회당 총 입력 중앙 ${med(rows.map((r) => r.in_tok)).toLocaleString()}`
  + ` · 값 중앙 $${med(rows.map((r) => r.cost)).toFixed(4)}`);
console.log('운영 실측 대조 — 총 입력 9,241 (33회 중앙 · 최소 9,151 · 최대 9,600) · 값 $0.10');
