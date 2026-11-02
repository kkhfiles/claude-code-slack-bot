#!/usr/bin/env node
/**
 * 슬랙 DM 세션에 세나 정체성이 실리는지 — `src/persona.ts`(2026-10-31).
 *
 * node scripts/check-persona.mjs
 *
 * 임시 폴더에 가짜 업무 비서 레포(`bin/stanley_persona.md`)와 유머 설정 파일을 만들어 읽힌다.
 * 진짜 정체성 파일이 있으면 그것도 한 번 읽어 대원칙 줄이 실리는지 본다.
 */
import './lib/fresh-dist.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { personaNote, readHumor, HUMOR_DEFAULT } = require(path.join(ROOT, 'dist', 'persona.js'));
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-'));
const bad = [];

function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` — ${JSON.stringify(got)} ≠ ${JSON.stringify(want)}`}`);
  if (!ok) bad.push(name);
}

try {
  const repo = path.join(DIR, 'wa');
  fs.mkdirSync(path.join(repo, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'bin', 'stanley_persona.md'), '세나는 실장님 한 사람의 개인 비서다.\n', 'utf-8');
  const humor = path.join(DIR, 'chat.settings.json');

  eq('설정 파일이 없으면 유머 50', readHumor(humor), HUMOR_DEFAULT);
  fs.writeFileSync(humor, JSON.stringify({ humor: 83 }), 'utf-8');
  eq('설정 파일의 유머 값을 읽음', readHumor(humor), 83);
  for (const v of [101, -1, 50.5, '50', true]) {
    fs.writeFileSync(humor, JSON.stringify({ humor: v }), 'utf-8');
    eq(`잘못된 값(${JSON.stringify(v)})은 50`, readHumor(humor), HUMOR_DEFAULT);
  }
  fs.writeFileSync(humor, 'not json', 'utf-8');
  eq('깨진 설정 파일은 50', readHumor(humor), HUMOR_DEFAULT);

  fs.writeFileSync(humor, JSON.stringify({ humor: 20 }), 'utf-8');
  const note = personaNote(repo, humor);
  eq('정체성 글이 맨 앞 제목 뒤에 실림', note.includes('세나는 실장님 한 사람의 개인 비서다.'), true);
  eq('슬랙에서는 유머 값이 줄로 실림', note.includes('지금 유머 값: 20'), true);
  eq('업무 비서 레포가 없으면 빈 글', personaNote(null, humor), '');
  eq('정체성 파일이 없으면 빈 글', personaNote(path.join(DIR, 'none'), humor), '');

  fs.writeFileSync(path.join(repo, 'bin', 'stanley_persona.md'), '세나는 바뀐 정체성이다.\n', 'utf-8');
  eq('파일을 고치면 다음 차례부터 걸림(다시 읽음)', personaNote(repo, humor).includes('바뀐 정체성'), true);

  const real = process.env.WORK_ASSISTANT_ROOT || 'P:/github/work-assistant';
  if (fs.existsSync(path.join(real, 'bin', 'stanley_persona.md'))) {
    eq('진짜 정체성 파일의 대원칙이 실림', personaNote(real, humor).includes('장난은 쳐도 팩트는 틀리지 않는다'), true);
  }
  // 모듈만 맞고 끼우는 줄이 빠지면 슬랙 세나는 다시 정체성 없이 돈다
  const handler = fs.readFileSync(path.join(ROOT, 'src', 'slack-handler.ts'), 'utf-8');
  eq('DM 차례에만 덧붙이는 지시 맨 앞에 정체성', /const surfaceNote = \[\s*isDM \? personaNote\(workAssistantRoot\(\)\) : '',\s*SLACK_SURFACE_NOTE,/.test(handler), true);
  eq('슬랙 안내가 반영 약속을 막음', personaNote(repo, humor).includes('「반영했습니다」라고 하지 않는다'), true);
  // 정해진 형식을 만드는 차례(2026-11-02 결정 F 「전부」) — 형식이 위트보다 앞선다
  const out = personaNote(repo, humor, 'output');
  eq('형식 차례에는 형식 우선 안내', out.includes('출력 형식은 아래 지시가 정한다') && !out.includes('슬랙에서 이 정체성을'), true);
  eq('형식 차례에도 유머 값', out.includes('지금 유머 값: 20'), true);
  const sched = fs.readFileSync(path.join(ROOT, 'src', 'assistant-scheduler.ts'), 'utf-8');
  eq('카드 요약, 개선 제안, 집중 줄, 아침 브리핑 — 네 곳에 정체성', (sched.match(/appendSystemPrompt: withSena\(/g) || []).length, 4);
  eq('좁은 길은 규칙 글을 읽는 자리에서 정체성을 붙임(1차와 폴백이 같은 글)', /const rulesText = withSena\(fs\.readFileSync\(rules/.test(sched), true);
  eq('agy 대체 엔진에도 정체성', /system: \[personaNote\(workAssistantRoot\(\), undefined, 'output'\), AGY_DM_RULES\]/.test(handler), true);
} finally {
  fs.rmSync(DIR, { recursive: true, force: true });
}

if (bad.length) { console.log(`\n실패 ${bad.length}건`); process.exit(1); }
console.log('\n통과');
