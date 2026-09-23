/**
 * 등급 사다리(`src/model-ladder.ts`) — 표 읽기 · 같은 등급 찾기 · 브리핑 줄.
 *
 *   npm run build
 *   npm run check:ladder
 *
 * **모델을 안 부른다.** 표는 `python -m llm_playbook.ladder --show --json`(모델 호출 없음)로 읽고,
 * 파이썬·llm-playbook 이 없는 컴퓨터에서는 그 칸을 「안 봄」으로 적고 넘어간다(통과가 아니라 안 본 것).
 *
 *   ① 기록 파일 → 브리핑 줄: 지난 24시간만 · probe 제외 · 라벨별로 누가 받았나 · 전부 실패 수
 *   ② 같은 등급 찾기: Claude 별칭·ID 로 같은 등급의 codex 칸 · 모르는 이름은 undefined
 *   ③ 파이썬이 없으면 표도 사다리도 null — 던지지 않는다
 */
import './lib/fresh-dist.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const fails = [];
const notes = [];
const eq = (label, got, want) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    fails.push(`${label}\n    받음 ${JSON.stringify(got)}\n    기대 ${JSON.stringify(want)}`);
  }
};
const ok = (label, cond) => { if (!cond) fails.push(label); };

// ① 브리핑 줄 — 경로를 주입해 진짜 기록 파일을 안 읽는다
{
  const { ladderEventLines } = await import('../dist/model-ladder.js');
  const now = Date.parse('2026-09-23T12:00:00');
  const iso = (h) => new Date(now - h * 3_600_000).toISOString().slice(0, 19);
  const file = path.join(os.tmpdir(), `ladder-ev-${Date.now()}.jsonl`);
  const rows = [
    { ts: iso(1), label: 'KG 추출', ok: true, served_by: 'codex', model: 'luna-low' },
    { ts: iso(2), label: 'KG 추출', ok: true, served_by: 'codex', model: 'luna-low' },
    { ts: iso(3), label: 'KG 추출', ok: false, served_by: null, model: null },
    { ts: iso(5), label: '카드 요약', ok: true, served_by: 'agy', model: 'Gemini' },
    { ts: iso(30), label: '카드 요약', ok: true, served_by: 'codex', model: 'sol' },   // 24시간 밖
    { ts: iso(1), label: 'probe', ok: false },                                        // 확인용 — 뺀다
  ];
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
  eq('지난 24시간 · 라벨별 · 누가 받았나 · 전부 실패 수', ladderEventLines(24, now, file), [
    'KG 추출 3건(codex luna-low 2 · 전부 실패 1)',
    '카드 요약 1건(agy Gemini 1)',
  ]);
  eq('기록 파일이 없으면 침묵', ladderEventLines(24, now, path.join(os.tmpdir(), '없는-기록.jsonl')), []);
  fs.unlinkSync(file);
}

// ② 같은 등급 찾기 — 이 컴퓨터에 llm-playbook 이 있을 때만
{
  const probe = spawnSync('python', ['-X', 'utf8', '-m', 'llm_playbook.ladder', '--show', '--json'],
    { encoding: 'utf-8', windowsHide: true, timeout: 60_000 });
  if (probe.status !== 0) {
    notes.push('llm-playbook 이 없어 같은 등급 찾기를 못 봤다 — 통과가 아니라 안 본 것');
  } else {
    const { sameTier } = await import('../dist/model-ladder.js');
    const table = JSON.parse(probe.stdout);
    const top = table.tiers.top.find((c) => c.backend === 'codex');
    const low = table.tiers.low.find((c) => c.backend === 'codex');
    const lowClaude = table.tiers.low.find((c) => c.backend === 'claude');
    eq('별칭 opus → top 등급 codex 칸', (await sameTier('opus', 'codex'))?.model, top?.model);
    eq('모델 ID 로도 찾는다(low 의 Claude ID → low codex)', (await sameTier(lowClaude?.model, 'codex'))?.model, low?.model);
    eq('모르는 이름은 undefined', await sameTier('없는-모델', 'codex'), undefined);
  }
}

// ③ 파이썬이 없으면 null — 던지지 않는다(새 프로세스에서: 표를 캐시하므로)
{
  const code = `
    process.env.LADDER_PYTHON = 'python-없는-이름-2026';
    const m = await import('./dist/model-ladder.js');
    const t = await m.ladderTable();
    const r = await m.ladderText('시험', '물음', { model: 'haiku', timeoutMs: 5000 });
    console.log(JSON.stringify([t, r, await m.sameTier('opus', 'codex')]));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code],
    { encoding: 'utf-8', windowsHide: true, timeout: 60_000, cwd: path.resolve(import.meta.dirname, '..') });
  const last = (r.stdout || '').trim().split('\n').pop() || '';
  eq('파이썬이 없으면 표·사다리·같은 등급 모두 빈손', last, '[null,null,null]');
}

if (notes.length) for (const n of notes) console.log(`  · ${n}`);
if (fails.length) {
  console.log(`실패 ${fails.length}건`);
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exitCode = 1;
} else {
  console.log('통과 — 브리핑 줄 · 같은 등급 찾기 · 파이썬 없을 때 물러남');
}
