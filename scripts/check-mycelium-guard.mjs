/**
 * Mycelium 알림 버튼 검사 — 슬랙을 타지 않는다.
 *
 *   npm run build
 *   npm run check:myceliumguard
 *
 * 남이 만든 버튼 값이 파이썬까지 가지 않는지, 막기와 닫기가 한 번 더 묻는지, 결과가 버튼 자리에
 * 앉는지, 실행기에 `id` 와 `who` 만 넘기는지 본다. 실행기는 임시 폴더의 가짜 `sena_mycelium.py` 다.
 */
import './lib/fresh-dist.mjs';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myc-guard-'));
fs.mkdirSync(path.join(tmp, 'notify'));
fs.mkdirSync(path.join(tmp, 'bin'));
fs.writeFileSync(path.join(tmp, 'bin', 'tasks.py'), '');  // workAssistantRoot() 가 레포로 알아보는 표식
fs.writeFileSync(path.join(tmp, 'notify', 'sena_mycelium.py'),
  "import json,sys\nprint('noise')\nprint(json.dumps({'ok': sys.argv[2] != 'close', 'message': ' '.join(sys.argv[1:])}))\n");
process.env.WORK_ASSISTANT_ROOT = tmp;
const require = createRequire(import.meta.url);
const g = require(path.join(ROOT, 'dist', 'mycelium-guard.js'));

const fails = [];
const eq = (label, got, want) => {
  const a = JSON.stringify(got); const b = JSON.stringify(want);
  if (a !== b) fails.push(`${label}: got ${a}, expected ${b}`);
};
const WHO = 'u-0123456789abcdef';
const val = (o) => JSON.stringify(o);

// 1. 버튼 값 — 모양이 틀리면 null
eq('ok block', g.parsePick(val({ id: 'block', who: WHO })), { id: 'block', who: WHO });
eq('ok status no who', g.parsePick(val({ id: 'status', who: null })), { id: 'status', who: null });
for (const [label, v] of [
  ['unknown id', val({ id: 'test-alert', who: null })],
  ['unblock not a button', val({ id: 'unblock', who: WHO })],
  ['block without who', val({ id: 'block', who: null })],
  ['bad who', val({ id: 'block', who: 'u-0123456789ABCDEF' })],
  ['who with tail', val({ id: 'block', who: WHO + ' --site x' })],
  ['not json', 'block'],
  ['not string', 42],
  ['too long', val({ id: 'status', who: null, pad: 'x'.repeat(300) })],
]) eq(`reject ${label}`, g.parsePick(v), null);

// 2. 묻기와 되돌리기
eq('confirm block', g.needsConfirm('block'), true);
eq('confirm close', g.needsConfirm('close'), true);
eq('no confirm status', g.needsConfirm('status'), false);
const ask = g.confirmTail({ id: 'close', who: null });
eq('ask has yes/no', ask[1].elements.map(e => e.action_id), ['mycelium_guard_yes', 'mycelium_guard_no']);
eq('ask carries only id and who', Object.keys(JSON.parse(ask[1].elements[0].value)).sort(), ['id', 'who']);
eq('buttons without who drop block', g.buttonsTail(null)[0].elements.map(e => e.action_id),
  ['mycelium_guard_close', 'mycelium_guard_open', 'mycelium_guard_status']);
eq('buttons with who', g.buttonsTail(WHO)[0].elements.length, 4);
for (const id of ['block', 'close', 'open', 'status', 'yes', 'no']) eq(`action re ${id}`, g.GUARD_ACTION.test(`mycelium_guard_${id}`), true);
eq('action re rejects others', g.GUARD_ACTION.test('mycelium_guard_unblock'), false);

// 3. 꼬리 바꾸기 — 알림 본문은 남고 버튼 쪽만 바뀜
const original = [
  { type: 'section', text: { type: 'mrkdwn', text: '🚨 알림' } },
  { type: 'context', elements: [] },
  ...g.buttonsTail(WHO),
];
const asked = g.swapTail(original, g.confirmTail({ id: 'block', who: WHO }));
eq('ask keeps body', asked.slice(0, 2), original.slice(0, 2));
eq('ask replaces buttons', asked.length, 4);
const back = g.swapTail(asked, g.buttonsTail(WHO));
eq('no restores', back, original);
const done = g.swapTail(asked, g.resultTail('사이트 닫기', { ok: false, message: 'x' }));
eq('result replaces ask', done.length, 3);
eq('failure says so first', done[2].text.text.startsWith('❌ 사이트 닫기 실행 실패'), true);

// 4. 실행기 — id, (막기면) who, 사유만 넘김
const r1 = await g.runGuard({ id: 'block', who: WHO }, '세나 버튼');
eq('run block args', r1, { ok: true, message: `run block ${WHO} --reason 세나 버튼` });
const r2 = await g.runGuard({ id: 'status', who: WHO }, '세나 버튼');
eq('run status drops who', r2, { ok: true, message: 'run status --reason 세나 버튼' });
const r3 = await g.runGuard({ id: 'close', who: null }, '세나 버튼');
eq('run failure passes through', r3.ok, false);
fs.writeFileSync(path.join(tmp, 'notify', 'sena_mycelium.py'), "print('not json')\n");
const r4 = await g.runGuard({ id: 'open', who: null }, '세나 버튼');
eq('unreadable result is failure', [r4.ok, r4.message.startsWith('결과를 못 읽음')], [false, true]);

fs.rmSync(tmp, { recursive: true, force: true });
if (fails.length) {
  console.error(`check:myceliumguard FAIL (${fails.length})\n` + fails.join('\n'));
  process.exitCode = 1;
} else {
  console.log('check:myceliumguard OK');
}
