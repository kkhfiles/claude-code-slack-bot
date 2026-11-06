#!/usr/bin/env node
/**
 * 세나 일지(`src/episodes.ts`) — 차례 시작과 끝 두 줄, 출처 표지는 코드가, 날짜별 파일, 끼우는 줄(2026-11-06).
 *
 * node scripts/check-episodes.mjs
 */
import './lib/fresh-dist.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'episodes-'));
process.env.SENA_EPISODES_DIR = DIR;
const ep = require(path.join(ROOT, 'dist', 'episodes.js'));
const bad = [];
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` — ${JSON.stringify(got)} ≠ ${JSON.stringify(want)}`}`);
  if (!ok) bad.push(name);
}

try {
  eq('어디서 — 서랍', ep.whereOf(`[서랍 차례 ${'a'.repeat(32)}]\n오늘 할 일`, true), 'drawer');
  eq('어디서 — 판', ep.whereOf('[진행판] TSK-3 「x」\n완료', true), 'board');
  eq('어디서 — 메일', ep.whereOf('[메일] 후보 2건', true), 'mail');
  eq('어디서 — 사람 DM', ep.whereOf('지금 뭐하니?', false), 'slack');
  eq('업무 번호는 한 번씩', ep.tasksIn('TSK-3 와 TSK-12', 'TSK-3 완료'), ['TSK-3', 'TSK-12']);

  const id = ep.startEpisode({ ts: '1762400000.123456', text: 'TSK-48 판 고쳐 줘', pushed: false });
  ep.endEpisode(id, {
    steps: [{ name: 'Bash', input: 'python -X utf8 bin/tasks.py log --id TSK-48 --text "x"', done: true }, { name: 'Read', input: 'a'.repeat(400), done: false }],
    writeRan: true, engine: 'claude', outcome: 'ok', answer: '\n고쳤어요 — 판에 반영했습니다.\n다음 줄', session: 's1',
  });
  const files = fs.readdirSync(DIR);
  eq('날짜별 파일 하나', files.length === 1 && /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(files[0]), true);
  const rows = fs.readFileSync(path.join(DIR, files[0]), 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
  eq('두 줄 — 시작과 끝, 같은 번호', rows.map((r) => [r.kind, r.id]), [['turn-start', id], ['turn-end', id]]);
  eq('시작 — 사람 말은 「실장 말씀」, 원문과 업무 번호', [rows[0].source, rows[0].text, rows[0].tasks], ['실장 말씀', 'TSK-48 판 고쳐 줘', ['TSK-48']]);
  eq('끝 — 출처는 「봇 기록」, 답은 첫 줄만', [rows[1].source, rows[1].answer_head], ['봇 기록', '고쳤어요 — 판에 반영했습니다.']);
  eq('끝 — 도구 입력은 잘라서', rows[1].steps[1].input.length, ep.INPUT_MAX);
  eq('끝 — 도구 입력의 업무 번호', rows[1].tasks, ['TSK-48']);
  const pushedId = ep.startEpisode({ ts: '1762400001.000001', text: '[진행판] TSK-9 「y」\n완료', pushed: true });
  const last = JSON.parse(fs.readFileSync(path.join(DIR, files[0]), 'utf-8').trim().split('\n').pop());
  eq('봇이 넘긴 말은 「봇이 넘김」', [last.id, last.source, last.where], [pushedId, '봇이 넘김', 'board']);

  // 끼우는 줄 — 모듈만 맞고 빠지면 일지가 조용히 안 쌓인다
  const handler = fs.readFileSync(path.join(ROOT, 'src', 'slack-handler.ts'), 'utf-8');
  eq('시작 줄 — DM 차례, 다시 돌리기 아님, 세션 띄우기 전',
     /const episode = isDM && text\?\.trim\(\) && !event\.replay\s*\? startEpisode\(/.test(handler)
     && handler.indexOf('startEpisode(') < handler.indexOf('const sdkOpts'), true);
  eq('끝 줄 — finally 의 결과 돌려주기 뒤', /if \(episode\) \{\s*endEpisode\(episode,/.test(handler), true);
} finally {
  fs.rmSync(DIR, { recursive: true, force: true });
}
if (bad.length) { console.log(`\n실패 ${bad.length}건`); process.exit(1); }
console.log('\n통과 — 세나 일지(어디서 · 업무 번호 · 시작과 끝 · 출처 표지 · 자르기 · 끼우는 줄)');
