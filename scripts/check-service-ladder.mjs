/**
 * 사다리 차례를 모델 표에서 읽나 — `models.json` 의 `ladders.dm` · `ladders.scheduled`(2026-10-19).
 *
 *   npm run build
 *   npm run check:servladder
 *
 * **모델을 안 부른다.** 표는 llm-playbook 의 `models.json`(`LLM_PLAYBOOK_MODELS` 가 있으면 그것)을 읽고, 바꿔 본 표는
 * 임시 폴더에 사본으로 둔다 — 정본 파일을 안 건드린다.
 *
 *   ① 지금 표 → 오늘의 차례 그대로(Claude → GPT → agy Gemini → agy Claude) · 켜는 문이 agy 칸을 빼고 붙인다
 *   ② 표에서 칸을 빼거나 순서를 바꾸면 차례가 따라온다(DM · 예약 일의 agy 칸) · 파일을 고치면 다시 읽는다
 *   ③ 표를 못 읽거나 이상하면(없음 · 깨짐 · 사다리 없음 · 첫 칸이 Claude 아님 · 모르는 칸 · Argon) 기본 차례 — 던지지 않는다
 *   ④ 파이썬 llm-playbook 이 보는 엔진 차례와 같다(파이썬이 없으면 「안 봄」 · 통과가 아니다)
 *
 * **왜 기계로 세나** — 차례가 틀려도 조용하다. 표에서 칸을 뺐는데 봇이 옛 상수로 돌면 아무도 모르고,
 * 표를 못 읽어 DM 이 멈추면 Claude 가 바닥나는 날에만 드러난다.
 */
import './lib/fresh-dist.mjs';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const ml = require('../dist/model-ladder.js');
const dmf = require('../dist/dm-fallback.js');
const agy = require('../dist/agy-turn.js');
const { modelsFile } = require('../dist/engine-notice.js');

const fails = [];
const notes = [];
const eq = (label, got, want) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    fails.push(`${label}\n    받음 ${JSON.stringify(got)}\n    기대 ${JSON.stringify(want)}`);
  }
};

const TODAY = ['claude', 'codex', 'agy-gemini', 'agy-claude'];
const ON = { DM_FALLBACK: 'on', DM_FALLBACK_AGY: 'on' };
const REAL = modelsFile();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'service-ladder-'));
let n = 0;
/** 지금 표의 사본을 고쳐 임시 파일로 — 경로를 돌려준다. 파일마다 이름이 달라 읽은 값이 섞이지 않는다. */
const variant = (mutate) => {
  const t = JSON.parse(fs.readFileSync(REAL, 'utf-8'));
  mutate(t);
  const p = path.join(TMP, `models-${++n}.json`);
  fs.writeFileSync(p, JSON.stringify(t, null, 2));
  return p;
};

try {
  // ① 지금 표
  eq('① DM 차례 — 표에서', ml.serviceLadder('dm', REAL), TODAY);
  eq('① 예약 일 차례 — 표에서', ml.serviceLadder('scheduled', REAL), TODAY);
  eq('① 예약 일의 agy 칸 — Gemini 먼저', agy.agyRungOrder(REAL), ['agy-gemini', 'agy-claude']);
  eq('① 켜는 문 — 꺼짐 · GPT 까지 · agy 까지 · agy 만 켬',
    [dmf.dmLadder({}, REAL), dmf.dmLadder({ DM_FALLBACK: 'on' }, REAL), dmf.dmLadder(ON, REAL),
      dmf.dmLadder({ DM_FALLBACK_AGY: 'on' }, REAL)],
    [['claude'], ['claude', 'codex'], TODAY, ['claude']]);
  eq('① 기본 인자(운영 경로)도 같은 표', dmf.dmLadder(ON), TODAY);
  eq('① 표를 못 읽을 때의 값도 오늘 차례', [ml.LADDER_DEFAULT.dm, ml.LADDER_DEFAULT.scheduled], [TODAY, TODAY]);

  // ② 표를 고치면 따라온다
  const noSonnet = variant((t) => { t.ladders.dm.rungs = t.ladders.dm.rungs.filter((r) => r !== 'agy:sonnet-low'); });
  eq('② DM 에서 agy Claude 칸을 빼면 빠진다', ml.serviceLadder('dm', noSonnet), ['claude', 'codex', 'agy-gemini']);
  eq('② 그 표로 켜는 문도', dmf.dmLadder(ON, noSonnet), ['claude', 'codex', 'agy-gemini']);
  eq('② DM 칸을 빼도 예약 일은 그대로', agy.agyRungOrder(noSonnet), ['agy-gemini', 'agy-claude']);
  const noCodex = variant((t) => { t.ladders.dm.rungs = t.ladders.dm.rungs.filter((r) => r !== 'codex'); });
  eq('② DM 에서 GPT 칸을 빼면 빠진다', dmf.dmLadder(ON, noCodex), ['claude', 'agy-gemini', 'agy-claude']);
  const swapped = variant((t) => { t.ladders.scheduled.rungs = ['claude', 'codex', 'agy:sonnet-low', 'agy:flash-high']; });
  eq('② 예약 일의 agy 칸 순서를 바꾸면 바뀐다', agy.agyRungOrder(swapped), ['agy-claude', 'agy-gemini']);
  const schedNoGemini = variant((t) => { t.ladders.scheduled.rungs = ['claude', 'codex', 'agy:sonnet-low']; });
  eq('② 예약 일에서 Gemini 칸을 빼면 안 부른다', agy.agyRungOrder(schedNoGemini), ['agy-claude']);

  // 같은 파일을 고치면 다시 읽는다(고친 시각으로 견줌)
  const live = variant(() => {});
  eq('② 고치기 전', ml.serviceLadder('dm', live), TODAY);
  const t = JSON.parse(fs.readFileSync(live, 'utf-8'));
  t.ladders.dm.rungs = ['claude', 'codex'];
  fs.writeFileSync(live, JSON.stringify(t));
  const later = new Date(Date.now() + 5_000);
  fs.utimesSync(live, later, later);
  eq('② 고친 뒤 — 다음 차례부터 따라옴', ml.serviceLadder('dm', live), ['claude', 'codex']);

  // ③ 이상한 표 → 기본 차례 · 안 던짐
  const broken = path.join(TMP, 'broken.json');
  fs.writeFileSync(broken, '{ 깨진');
  const odd = {
    '파일 없음': path.join(TMP, 'none.json'),
    '깨진 JSON': broken,
    '사다리 칸 없음': variant((t) => { delete t.ladders; }),
    'dm 사다리 없음': variant((t) => { delete t.ladders.dm; }),
    '빈 칸 목록': variant((t) => { t.ladders.dm.rungs = []; }),
    '첫 칸이 Claude 아님': variant((t) => { t.ladders.dm.rungs = ['codex', 'claude', 'agy:flash-high']; }),
    '모르는 별칭': variant((t) => { t.ladders.dm.rungs = ['claude', 'codex', 'agy:없는-모델']; }),
    'Argon 은 봇이 못 맡음': variant((t) => { t.ladders.dm.rungs = ['claude', 'codex', 'agy:argon']; }),
    '모르는 백엔드': variant((t) => { t.ladders.dm.rungs = ['claude', 'gemini:flash']; }),
    '같은 엔진 두 번': variant((t) => { t.ladders.dm.rungs = ['claude', 'codex', 'agy:flash-high', 'agy:flash-medium']; }),
    'rungs 가 tiers': variant((t) => { t.ladders.dm.rungs = 'tiers'; }),
  };
  for (const [label, file] of Object.entries(odd)) {
    let got;
    try { got = dmf.dmLadder(ON, file); } catch (e) { got = `던짐: ${e?.message}`; }
    eq(`③ ${label} → 기본 차례`, got, TODAY);
  }
  let gotAgy;
  try { gotAgy = agy.agyRungOrder(path.join(TMP, 'none.json')); } catch (e) { gotAgy = `던짐: ${e?.message}`; }
  eq('③ 예약 일 agy 칸 — 표를 못 읽으면 기본', gotAgy, ['agy-gemini', 'agy-claude']);
  eq('③ 칸 → 엔진 열쇠', ['claude', 'codex:luna-medium', 'agy:flash-high', 'agy:sonnet-low', 'agy:argon', 'agy', 'x']
    .map((r) => ml.rungEngine(r, { 'flash-high': 'Gemini 3.8 Flash (High)', 'sonnet-low': 'Claude Sonnet 5.5 (Low)', argon: 'Gemini 4 Argon (Medium)' }) ?? null),
  ['claude', 'codex', 'agy-gemini', 'agy-claude', null, null, null]);

  // ④ 파이썬이 보는 차례와 같은가
  const py = process.env.LADDER_PYTHON || 'python';
  const r = spawnSync(py, ['-X', 'utf8', '-m', 'llm_playbook.ladder', '--show', '--json'],
    { encoding: 'utf-8', timeout: 60_000, env: { ...process.env, LLM_PLAYBOOK_MODELS: REAL } });
  let shown = null;
  try { shown = r.status === 0 ? JSON.parse(r.stdout) : null; } catch { shown = null; }
  if (!shown?.ladders) {
    notes.push('④ 안 봄 — 파이썬 llm-playbook 이 사다리 표를 안 냄(없음 · 옛 판)');
  } else {
    for (const name of ['dm', 'scheduled']) {
      eq(`④ 파이썬과 같은 차례 — ${name}`, (shown.ladders[name]?.rungs ?? []).map((c) => c.engine), ml.serviceLadder(name, REAL));
    }
  }
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

for (const x of notes) console.log(`  ※ ${x}`);
if (fails.length) {
  console.error(`사다리 표 읽기 — ${fails.length}건 실패\n  ` + fails.join('\n  '));
  process.exit(1);
}
console.log('사다리 표 읽기 — 통과');
