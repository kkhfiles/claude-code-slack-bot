#!/usr/bin/env node
/**
 * 세나 0층 기억 카드와 미리 꺼내 붙이기(`src/memory-card.ts`, 2026-11-06).
 *
 * node scripts/check-memory-card.mjs
 */
import './lib/fresh-dist.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const mc = require(path.join(ROOT, 'dist', 'memory-card.js'));
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'card-'));
const bad = [];
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` — ${JSON.stringify(got)} ≠ ${JSON.stringify(want)}`}`);
  if (!ok) bad.push(name);
}

try {
  eq('카드 파일이 없으면 빈 글', mc.readCard(path.join(DIR, 'none.txt')), '');
  fs.writeFileSync(path.join(DIR, 'card.txt'), '[세나 기억 카드 11/06 19:00 기준 — 앞 카드를 대체]\n답 대기 1건\n', 'utf-8');
  eq('카드 파일을 그대로', mc.readCard(path.join(DIR, 'card.txt')), '[세나 기억 카드 11/06 19:00 기준 — 앞 카드를 대체]\n답 대기 1건');

  const now = new Date('2026-11-06T10:00:00Z');   // 한국 19:00
  eq('열쇠 — 업무 번호 둘까지', mc.prefetchKeys('TSK-1 TSK-2 TSK-3 TSK-1', now), ['TSK-1', 'TSK-2']);
  eq('열쇠 — 「어제」는 어제 날짜(한국)', mc.prefetchKeys('어제 뭐 했지', now), ['2026-11-05']);
  eq('열쇠 — 없으면 안 꺼냄', mc.prefetchKeys('오늘 뭐부터 할까?', now), []);

  const calls = [];
  const fake = async (args) => { calls.push(args); return { code: 0, stdout: `「${args[1]}」 — 1건\n- 11/06 13:55 [슬랙·실장 말씀] 「x」 → y`, stderr: '' }; };
  const note = await mc.prefetchNote('TSK-103 어떻게 됐어', fake);
  eq('미리 꺼냄 — recall 을 그 열쇠로', calls.map((c) => c.slice(0, 2)), [['recall', 'TSK-103']]);
  eq('미리 꺼냄 — 머리와 본문', note.startsWith('[일지에서 미리 꺼냄 — 이 말의 TSK-103') && note.includes('11/06 13:55'), true);
  eq('미리 꺼냄 — 열쇠가 없으면 부르지도 않음', [await mc.prefetchNote('안녕', async () => { throw new Error('불림'); })], ['']);
  eq('미리 꺼냄 — 실패하면 빈 글', await mc.prefetchNote('TSK-1', async () => ({ code: 2, stdout: '', stderr: 'x' })), '');
  const t0 = Date.now();
  // 상한 타이머는 봇 프로세스를 붙잡지 않게 unref 되어 있다 — 검사 프로세스가 먼저 끝나지 않게 따로 붙잡아 둔다
  const hold = setTimeout(() => { }, mc.PREFETCH_MS + 2000);
  const slow = await mc.prefetchNote('TSK-1', () => new Promise(() => { }));
  clearTimeout(hold);
  eq('미리 꺼냄 — 늦으면 상한에서 버림', [slow, Date.now() - t0 < mc.PREFETCH_MS + 1000], ['', true]);
  const long = await mc.prefetchNote('TSK-1', async () => ({ code: 0, stdout: Array.from({ length: 30 }, (_, i) => `줄 ${i}`).join('\n'), stderr: '' }));
  eq('미리 꺼냄 — 줄 수 상한', long.split('\n').length, mc.PREFETCH_LINES + 1);

  const handler = fs.readFileSync(path.join(ROOT, 'src', 'slack-handler.ts'), 'utf-8');
  eq('끼우는 줄 — 번호표와 나란히 미리 꺼냄(사람 DM, 서랍)',
     /const prefetchPending: Promise<string> = isDM && \(!\(event as any\)\.pushed \|\| DRAWER_TURN\.test\(text \|\| ''\)\)/.test(handler), true);
  eq('끼우는 줄 — 말 끝에 카드와 미리 꺼낸 것', /const turnNote = \[\s*isDM \? humorValueLine\(\) : '',\s*isDM \? readCard\(\) : '',\s*prefetched,/.test(handler), true);
  eq('끼우는 줄 — 차례 끝에 카드를 다시 씀', /if \(episode\) \{\s*refreshCard\(\);/.test(handler), true);
} finally {
  fs.rmSync(DIR, { recursive: true, force: true });
}
if (bad.length) { console.log(`\n실패 ${bad.length}건`); process.exit(1); }
console.log('\n통과 — 기억 카드(파일 읽기) · 미리 꺼내기(열쇠 · 실패 · 늦음 · 줄 수) · 끼우는 줄');
