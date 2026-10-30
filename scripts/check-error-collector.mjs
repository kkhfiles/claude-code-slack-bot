#!/usr/bin/env node
/**
 * 봇 실패 기록이 재시작을 넘기는지 — `src/error-collector.ts`(2026-10-30 · 그전에는 메모리에만 있어 다시 띄우면 사라졌다).
 *
 * node scripts/check-error-collector.mjs
 *
 * 임시 파일(`BOT_ERRORS_FILE`)에만 쓴다. 「다시 띄움」은 새 node 프로세스로 같은 파일을 읽어 흉내 낸다.
 */
import './lib/fresh-dist.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-errors-'));
const FILE = path.join(DIR, 'bot-errors.jsonl');
const bad = [];

function run(code) {
  const r = spawnSync(process.execPath, ['-e', `const { errorCollector: c } = require(${JSON.stringify(path.join(ROOT, 'dist', 'error-collector.js'))});\n${code}`],
    { env: { ...process.env, BOT_ERRORS_FILE: FILE }, encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
}

function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` — ${JSON.stringify(got)} ≠ ${JSON.stringify(want)}`}`);
  if (!ok) bad.push(name);
}

try {
  run(`c.add('mail', 'first'); c.add('board', 'second');`);
  eq('다시 띄워도 남아 있음', JSON.parse(run(`console.log(JSON.stringify(c.getAndClear().map((e) => e.source)))`)), ['mail', 'board']);
  eq('브리핑이 가져간 뒤에는 비어 있음', run(`console.log(c.hasErrors())`), 'false');
  run(`c.add('dm', 'x'.repeat(2000));`);
  const lines = fs.readFileSync(FILE, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
  eq('지우지 않고 쌓음(오류 셋 + 가져감 하나)', lines.map((l) => l.source ?? 'cleared'), ['mail', 'board', 'cleared', 'dm']);
  eq('긴 글은 500자에서 자름', lines[3].message.length, 500);
  fs.writeFileSync(FILE, 'not json\n' + fs.readFileSync(FILE, 'utf-8'));
  eq('깨진 줄은 건너뜀', JSON.parse(run(`console.log(JSON.stringify(c.getAndClear().map((e) => e.source)))`)), ['dm']);
  // 폴더 자리에 파일이 있어 만들 수 없는 경로
  fs.writeFileSync(path.join(DIR, 'blocker'), '');
  const r = spawnSync(process.execPath, ['-e', `const { errorCollector: c } = require(${JSON.stringify(path.join(ROOT, 'dist', 'error-collector.js'))}); c.add('x','y'); console.log(c.hasErrors())`],
    { env: { ...process.env, BOT_ERRORS_FILE: path.join(DIR, 'blocker', 'bot-errors.jsonl') }, encoding: 'utf-8' });
  eq('못 쓰는 경로여도 메모리로 돎', r.stdout.trim(), 'true');
} finally {
  fs.rmSync(DIR, { recursive: true, force: true });
}

if (bad.length) { console.log(`\n실패 ${bad.length}건`); process.exitCode = 1; } else console.log('\n통과');
