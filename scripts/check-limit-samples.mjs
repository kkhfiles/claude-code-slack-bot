/**
 * 막힘 판정 공유 시료 — llm-playbook 의 `tests/limit_samples.json` 을 봇의 판정이 같게 읽나. 슬랙도 네트워크도 안 탄다.
 *
 *   npm run check:limitsamples     (먼저 `npm run build`)
 *
 * **왜 있나** — 봇과 파이썬(llm-playbook `limits.py`)이 같은 엔진 상태 파일에 막힘을 적는다. 같은 글을 두 쪽이
 * 다르게 읽으면 한쪽이 막힌 엔진을 계속 부른다. 시료는 한 벌이고 두 구현이 같은 파일로 시험한다 — 규칙을
 * 고치면 시료부터 고친다.
 *
 * 시료 자리 — `LLM_PLAYBOOK_ROOT`(기본은 이 저장소 옆의 `llm-playbook`). **파일이 없으면 「건너뜀」** — 실패가
 * 아니라 안 본 것이다(그 저장소가 없는 PC).
 *
 * 보는 판정 — Claude: `classifyClaudeErrorText` · `thrownClaudeBlock` · `currentClaudeBlock`(한도 · 과부하 시료만 —
 * 이미 막혔다고 아는 차례에 부르는 것이라 못 가르면 `unknown` 이 맞다) / codex: `classifyCodexErrorText` /
 * agy: `classifyAgy`(시료 글을 백엔드 stderr 끝으로). 봇은 로그인(auth)을 안 가른다 — auth 시료는 none 으로 읽어도 된다.
 *
 * 변이 시험 — ① 이벤트 이름 지우기를 걷음(성공 줄이 사용량 소진이 됨) ② codex 의 `resets_in_seconds` 를 안 읽음
 * ③ agy 의 「시간 초과」를 한도로 읽음 — 셋 다 이 검사가 실패해야 한다.
 */
import './lib/fresh-dist.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const PLAYBOOK = process.env.LLM_PLAYBOOK_ROOT || path.resolve(ROOT, '..', 'llm-playbook');
const SAMPLES = path.join(PLAYBOOK, 'tests', 'limit_samples.json');

if (!fs.existsSync(SAMPLES)) {
  console.log(`건너뜀 — 공유 시료가 없습니다(${SAMPLES}) · LLM_PLAYBOOK_ROOT 로 자리를 알려 주면 봅니다`);
  process.exit(0);
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'limit-samples-'));
// ⚠️ dist 를 부르기 **전에** 자리를 옮긴다 — 봇 전체가 쓰는 하나(`engineState`)가 운영 파일을 안 건드리게.
process.env.ENGINE_STATE_FILE = path.join(TMP, 'singleton.json');
process.env.RATE_LIMIT_UNTIL_FILE = path.join(TMP, 'singleton-legacy.json');

const { classifyClaudeErrorText, classifyCodexErrorText } = require(path.join(DIST, 'rate-limit-utils.js'));
const { thrownClaudeBlock, currentClaudeBlock } = require(path.join(DIST, 'engine-tap.js'));
const { EngineState } = require(path.join(DIST, 'engine-state.js'));
const { classifyAgy } = require(path.join(DIST, 'agy-turn.js'));

const data = JSON.parse(fs.readFileSync(SAMPLES, 'utf-8'));
const NOW = data.now;
const cases = Array.isArray(data.cases) ? data.cases : [];
const fails = [];
const fail = (c, what) => fails.push(`[${c.backend}] ${c.note}\n    ${what}`);

/** 시료가 바라는 풀리는 시각 — `null` 이면 못 읽어야 한다. */
function wantUntil(rule) {
  if (rule === null || rule === undefined) return null;
  if (typeof rule.epoch === 'number') return rule.epoch;
  if (typeof rule.after_now_s === 'number') return NOW + rule.after_now_s;
  if (typeof rule.pc_local_next === 'string') {
    const [hh, mm] = rule.pc_local_next.split(':').map(Number);
    const d = new Date(NOW * 1000);
    d.setHours(hh, mm, 0, 0);
    if (d.getTime() <= NOW * 1000) d.setDate(d.getDate() + 1);
    return Math.floor(d.getTime() / 1000);
  }
  return undefined; // 모르는 규칙 — 아래에서 실패로 낸다
}

/** 봇의 판정 갈래 — auth 를 안 가르는 쪽은 none 으로 읽어도 맞다. */
const kindOk = (want, got) => got === want || (want === 'auth' && got === 'none');

let n = 0;
const store = () => new EngineState({
  file: path.join(TMP, `s${++n}.json`), legacyFile: path.join(TMP, `none${n}.json`), now: () => NOW * 1000,
});

const seen = new Set();
try {
  if (!cases.length) fails.push('시료가 하나도 없습니다 — 0건 통과는 안 본 것');
  for (const c of cases) {
    seen.add(c.backend);
    const want = wantUntil(c.until_rule);
    if (want === undefined) { fail(c, `모르는 until_rule ${JSON.stringify(c.until_rule)}`); continue; }

    if (c.backend === 'claude') {
      // ① 글 판정
      const v = classifyClaudeErrorText(c.text, NOW * 1000);
      const kind = v?.kind ?? 'none';
      if (!kindOk(c.kind, kind)) fail(c, `classifyClaudeErrorText 갈래 ${kind} · 기대 ${c.kind}`);
      const until = v?.until ?? null;
      if (until !== want) fail(c, `classifyClaudeErrorText 시각 ${until} · 기대 ${want}`);
      // ② 던진 오류 — 적힌 막힘(시각을 못 읽었으면 규칙이 정한 「다시 볼 시각」 · untilKnown 거짓)
      const s = store();
      const b = thrownClaudeBlock(new Error(c.text), s);
      const tk = b?.kind ?? 'none';
      if (!kindOk(c.kind, tk)) fail(c, `thrownClaudeBlock 갈래 ${tk} · 기대 ${c.kind}`);
      if (b && want !== null && (b.until !== want || b.untilKnown !== true)) {
        fail(c, `thrownClaudeBlock 시각 ${b.until}(서버 값 ${b.untilKnown}) · 기대 ${want}`);
      }
      if (b && want === null && b.untilKnown !== false) fail(c, 'thrownClaudeBlock — 못 읽은 시각을 서버 값이라 적음');
      // ③ 탭이 못 본 결과 — 한도 · 과부하 시료만
      if (c.kind === 'usage' || c.kind === 'overload') {
        const cb = currentClaudeBlock(undefined, c.text, store());
        if (cb.kind !== c.kind) fail(c, `currentClaudeBlock 갈래 ${cb.kind} · 기대 ${c.kind}`);
        if (want !== null && cb.until !== want) fail(c, `currentClaudeBlock 시각 ${cb.until} · 기대 ${want}`);
      }
    } else if (c.backend === 'codex') {
      const v = classifyCodexErrorText(c.text, NOW * 1000);
      const kind = v?.kind ?? 'none';
      if (!kindOk(c.kind, kind)) fail(c, `classifyCodexErrorText 갈래 ${kind} · 기대 ${c.kind}`);
      const until = v?.until ?? null;
      if (until !== want) fail(c, `classifyCodexErrorText 시각 ${until} · 기대 ${want}`);
    } else if (c.backend === 'agy') {
      // 끝 줄 없는 실패(rc 1 · 답 없음) — 시료 글이 stderr 끝에 온 모양. agy 는 시각을 안 읽는다.
      const r = classifyAgy({ code: 1, out: '', stderr: c.text, timedOut: false });
      const kind = r.kind === 'usage' ? r.block : 'none';
      if (!kindOk(c.kind, kind)) fail(c, `classifyAgy 갈래 ${kind} · 기대 ${c.kind}`);
      if (want !== null) fail(c, `agy 는 풀리는 시각을 안 읽음 — 시료가 시각(${want})을 바람`);
    } else {
      fail(c, `모르는 backend ${c.backend}`);
    }
  }
  for (const b of ['claude', 'codex', 'agy']) if (!seen.has(b)) fails.push(`${b} 시료가 없습니다 — 그 판정은 안 본 것`);
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

if (fails.length) {
  console.error(`실패 ${fails.length}건 (시료 ${cases.length}건 · ${SAMPLES})\n`);
  for (const f of fails) console.error('  ✗ ' + f);
  process.exitCode = 1;
} else {
  console.log(`통과 — 공유 시료 ${cases.length}건을 파이썬과 같게 읽음 (Claude 글 · 던진 오류 · 탭 밖 결과 · codex · agy)`);
}
