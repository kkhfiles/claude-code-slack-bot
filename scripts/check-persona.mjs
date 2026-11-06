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
const { personaNote, readHumor, HUMOR_DEFAULT, humorReminder, humorValueLine } = require(path.join(ROOT, 'dist', 'persona.js'));
const { identityNotice, recordSnapshot } = require(path.join(ROOT, 'dist', 'identity-note.js'));
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
  // 값은 시스템 프롬프트에 안 둔다(2026-11-06) — 이어 가는 세션은 그것을 첫 차례 것으로 고정한다. 말 끝 줄이 값을 싣는다
  eq('슬랙 정체성에는 유머 값이 안 실림(말 끝 줄을 가리킴)', !note.includes('지금 유머 값: 20') && note.includes('「[지금 유머 값: N]」'), true);
  eq('말 끝 유머 값 줄', humorValueLine(humor), '[지금 유머 값: 20]');
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
  eq('DM 차례에만 덧붙이는 지시 맨 앞에 정체성', /const stableNote = \[isDM \? personaNote\(workAssistantRoot\(\)\) : '', SLACK_SURFACE_NOTE\]/.test(handler), true);
  // 이어 가는 세션(11/06) — Claude 세션의 시스템 프롬프트는 안 바뀌는 것만, 바뀌는 것은 말 끝에, 바뀐 정체성은 알림으로
  eq('Claude 세션의 시스템 프롬프트는 stableNote', /appendSystemPrompt: stableNote,/.test(handler) && !/appendSystemPrompt: surfaceNote,\n\s*settings: \{ autoCompactWindow/.test(handler), true);
  eq('말 끝에 유머 값, 캡처 안내, 번호표, 정체성 알림',
     /const turnNote = \[\s*isDM \? humorValueLine\(\) : '',\s*capture \? CAPTURE_NOTE : '',\s*slotMap,\s*isDM \? identityNotice\(resumingId, resuming, stableNote\) : '',/.test(handler), true);
  eq('새 세션의 첫 차례와 압축 뒤에 판을 적음', /if \(isDM && !resuming\) recordSnapshot\(initEvent\.session_id, stableNote\)/.test(handler)
     && /subtype === 'compact_boundary'\) \{\s*recordSnapshot\(/.test(handler), true);
  eq('슬랙 안내가 반영 약속을 막음', personaNote(repo, humor).includes('「반영했습니다」라고 하지 않는다'), true);
  eq('슬랙에서 유머를 바꾸는 명령을 알림', personaNote(repo, humor).includes('bin/sena_humor.py'), true);
  // 정해진 형식을 만드는 차례(2026-11-02 결정 F 「전부」) — 형식이 위트보다 앞선다
  const out = personaNote(repo, humor, 'output');
  eq('형식 차례에는 형식 우선 안내', out.includes('출력 형식은 아래 지시가 정한다') && !out.includes('슬랙에서 이 정체성을'), true);
  eq('형식 차례에도 유머 값', out.includes('지금 유머 값: 20'), true);
  const sched = fs.readFileSync(path.join(ROOT, 'src', 'assistant-scheduler.ts'), 'utf-8');
  eq('카드 요약, 개선 제안, 집중 줄, 아침 브리핑 — 네 곳에 정체성', (sched.match(/appendSystemPrompt: withSena\(/g) || []).length, 4);
  eq('좁은 길은 규칙 글을 읽는 자리에서 정체성을 붙임(1차와 폴백이 같은 글)', /const rulesText = withSena\(fs\.readFileSync\(rules/.test(sched), true);
  eq('agy 대체 엔진에도 정체성', /system: \[personaNote\(workAssistantRoot\(\), undefined, 'output'\), AGY_DM_RULES\]/.test(handler), true);
  // 차례 끝 유머 상기(2026-11-05) — 값마다 눈금, 0 과 끄는 문에서는 빈 글, 사람 DM 과 서랍 차례의 말 끝에만
  fs.writeFileSync(humor, JSON.stringify({ humor: 100 }), 'utf-8');
  const r100 = humorReminder(humor);
  eq('유머 100 상기 — 블록 제목도 농담, 길이 고정, 새 사실 금지', r100.includes('[유머 100]') && r100.includes('블록 제목도 농담')
    && r100.includes('줄을 더하지 않는다') && r100.includes('새 사실은 농담에도 넣지 않는다'), true);
  eq('유머 100 상기 — 서랍 facts 칸은 건조하게(시안 04c)', r100.includes('facts 칸만 건조하게'), true);
  fs.writeFileSync(humor, JSON.stringify({ humor: 50 }), 'utf-8');
  eq('유머 50 상기 — 어울릴 때 한 마디', humorReminder(humor).includes('어울릴 때 한 마디'), true);
  fs.writeFileSync(humor, JSON.stringify({ humor: 0 }), 'utf-8');
  eq('유머 0 이면 상기 없음', humorReminder(humor), '');
  fs.writeFileSync(humor, JSON.stringify({ humor: 100 }), 'utf-8');
  process.env.HUMOR_REMIND = 'off';
  eq('HUMOR_REMIND=off 면 상기 없음', humorReminder(humor), '');
  delete process.env.HUMOR_REMIND;
  eq('상기는 말 끝에, 사람 DM 과 서랍 차례에만', /const remind = \(isDM && !\(event as any\)\.pushed\) \|\| \/\^\\\[서랍 차례 \[0-9a-f\]\{32\}\\\]\/\.test\(finalPrompt\) \? humorReminder\(\) : '';/.test(handler)
    && /finalPrompt \+ \(turnNote \? `\\n\\n\$\{turnNote\}` : ''\) \+ remind\]/.test(handler), true);

  // 정체성 판(`identity-note.ts`) — 바뀌면 바뀐 줄을 한 번, 압축 뒤에는 다시 안 알림, 처음 보는 세션은 전문 한 번
  process.env.SENA_IDENTITY_DIR = path.join(DIR, 'identity');
  const v1 = '규칙 가\n규칙 나\n', v2 = '규칙 가\n규칙 다\n';
  recordSnapshot('s1', v1);
  eq('정체성 — 같은 판이면 알림 없음', identityNotice('s1', true, v1), '');
  const n2 = identityNotice('s1', true, v2);
  eq('정체성 — 바뀌면 더한 줄과 지운 줄', n2.includes('더하거나 바뀐 줄:\n규칙 다') && n2.includes('지운 줄(이제 따르지 않음):\n규칙 나') && !n2.includes('규칙 가'), true);
  eq('정체성 — 이미 알렸으면 다시 안 붙임', identityNotice('s1', true, v2), '');
  recordSnapshot('s1', v2);
  eq('정체성 — 압축 뒤(기록이 지금 판)에는 알림 없음', identityNotice('s1', true, v2), '');
  eq('정체성 — 새 세션은 알릴 것 없음', identityNotice('s2', false, v2), '');
  eq('정체성 — 처음 보는 이어 가는 세션은 전문 한 번', identityNotice('old', true, v2).includes('지금 판 전문:\n규칙 가\n규칙 다'), true);
  eq('정체성 — 그 뒤로는 다시 안 붙임', identityNotice('old', true, v2), '');
  delete process.env.SENA_IDENTITY_DIR;
} finally {
  fs.rmSync(DIR, { recursive: true, force: true });
}

if (bad.length) { console.log(`\n실패 ${bad.length}건`); process.exit(1); }
console.log('\n통과');
