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

// 한 번만 읽어 둔다 — 사례마다 다시 읽으면 도중에 파일이 바뀌면 두 갈래가 달라진다.
const APPEND_PLAIN = rulesText;
const APPEND_EXTRAS = rulesText + labExtras();

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

/**
 * ★ **짝 비교 (`--paired`)** — 두 갈래를 **같은 사례에서** 돌린다.
 *
 * 총점만 견주면 판별 차이를 못 가른다(앞선 측정에서 같은 프롬프트 두 벌이 42%와
 * 46%로 갈렸다). 판단은 **엇갈린 사례 수**로 해야 하고, 그러려면 사례마다 두
 * 갈래의 정오가 짝으로 있어야 한다.
 *
 * **순서를 사례마다 번갈아 둔다** — 한 갈래를 늘 먼저 돌리면 캐시 상태·서버 조건이
 * 그 갈래에 유리하게 쏠린다. 갈래별로 파일을 갈라 두면 `grade2.py` 를 그대로 쓴다.
 */
const PAIRED = process.argv.includes('--paired');
const rowsB = [];

/**
 * ★ **여러 판 견주기 (`--arms a.md,b.md,...`)** — 판별 순위를 **한 환경에서** 다시 낸다.
 *
 * ⛔ **옛 판 점수와 새 판 점수를 섞어 견주면 안 된다** — 환경이 갈리면 그 차이가
 *    판 차이로 읽힌다. 순위를 보려면 **모든 판을 같은 조건에서 다시** 돌려야 한다.
 *    (2026-09-10 검토 지적. 옛 자료는 정답의 값칸 수도 달라 견줄 수 없다.)
 *
 * 순서는 사례마다 한 칸씩 돌린다 — 한 판이 늘 첫 번째면 그 판에만 캐시가 식은
 * 회차가 몰린다. 판별로 파일을 갈라 두어 `grade2.py`·`pair_compare.py` 를 그대로 쓴다.
 */
const ARMS = (arg('--arms', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
const armRules = new Map();
for (const a of ARMS) armRules.set(a, readFileSync(path.join(ROOT, a), 'utf-8'));
const armRows = new Map(ARMS.map((a) => [a, []]));
const armName = (a) => path.basename(a, '.md');

console.log(`재생할 것 ${picked.length}건 · `
  + (ARMS.length
    ? `판 ${ARMS.length}갈래 견주기 — ${ARMS.map(armName).join(' · ')}`
    : `규칙 ${RULES} · ${PAIRED ? '짝 비교 — 판만 대 판+계약·예시'
      : (EXTRAS ? '계약·예시 실음' : '운영 모양(판만)')} → ${OUT}`));

async function once(k, useExtras, override) {
  const t0 = Date.now();
  let text = '';
  let usage = null;
  let cost = 0;
  let subtype = 'success';
  let isError = false;
  let turns = 0;
  try {
    const proc = handler.runQuery(userText(k), {
      ...NARROW_OPTS,
      appendSystemPrompt: override ?? (useExtras ? APPEND_EXTRAS : APPEND_PLAIN),
      env: scrubbedEnv(),
    });
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
  return {
    ...k, shape: override !== undefined ? 'arm' : (useExtras ? 'prod+extras' : 'prod'),
    ms, got, cost, in_tok: inTok, usage, subtype, turns, raw: text.slice(0, 4000),
  };
}

const med = (xs) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;

function line(idx, tag, r) {
  console.log(`  ${String(idx + 1).padStart(2)}/${picked.length} ${tag}`
    + ` ${(r.task || '?').padEnd(8)} ${(r.ms / 1000).toFixed(1)}s`
    + ` 입력 ${r.in_tok.toLocaleString().padStart(7)}`
    + ` $${r.cost.toFixed(4)} ${r.got ? '○' : '✗'}`);
}

for (const [idx, k] of picked.entries()) {
  if (ARMS.length) {
    // 순서를 사례마다 한 칸 돌린다 — 첫 번째 판에만 식은 회차가 몰리지 않게.
    const order = ARMS.map((_, i) => ARMS[(i + idx) % ARMS.length]);
    for (const a of order) {
      const r = await once(k, false, armRules.get(a));
      r.shape = armName(a);
      armRows.get(a).push(r);
      line(idx, armName(a).padEnd(9), r);
    }
    continue;
  }
  if (!PAIRED) {
    const r = await once(k, EXTRAS);
    rows.push(r);
    line(idx, EXTRAS ? 'B' : 'A', r);
    continue;
  }
  // 순서를 사례마다 번갈아 — 한 갈래가 늘 먼저 돌면 그쪽에 조건이 쏠린다.
  const extrasFirst = idx % 2 === 1;
  const first = await once(k, extrasFirst);
  const second = await once(k, !extrasFirst);
  for (const r of [first, second]) (r.shape === 'prod' ? rows : rowsB).push(r);
  line(idx, extrasFirst ? 'B' : 'A', first);
  line(idx, extrasFirst ? 'A' : 'B', second);
}

if (!existsSync(TMP)) mkdirSync(TMP, { recursive: true });

function save(name, rs) {
  if (!rs.length) return;
  writeFileSync(path.join(TMP, name), rs.map((r) => JSON.stringify(r)).join(NL) + NL, 'utf-8');
  const ok = rs.filter((r) => r.got).length;
  console.log(`남김 ${name} (${rs.length}건) · JSON 성공 ${ok}/${rs.length}`
    + ` · 회당 총 입력 중앙 ${med(rs.map((r) => r.in_tok)).toLocaleString()}`
    + ` · 값 중앙 $${med(rs.map((r) => r.cost)).toFixed(4)}`);
}

console.log('');
if (ARMS.length) {
  for (const a of ARMS) save(OUT.replace('.jsonl', `-${armName(a)}.jsonl`), armRows.get(a));
  console.log('판별 순위 — pair_compare.py 로 판을 둘씩 맞대고 엇갈린 사례로 판정한다');
} else if (PAIRED) {
  save(OUT, rows);
  save(OUT.replace('.jsonl', '-extras.jsonl'), rowsB);
  console.log('짝 비교 채점 — grade2.py 를 파일마다 돌리고 사례별 정오는 pair_compare.py 로 본다');
} else {
  save(OUT, rows);
}
console.log('운영 실측 대조 — 총 입력 9,241 (33회 중앙 · 최소 9,151 · 최대 9,600) · 값 $0.10');
