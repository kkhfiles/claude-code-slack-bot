/**
 * 서랍 진행 단계 검사 — 도구 호출을 사람 말 한 줄로, 서랍 차례 id 뽑기(2026-11-04 N6 시안 04).
 *
 *   npm run build
 *   npm run check:drawerprogress
 */
import './lib/fresh-dist.mjs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { stepLabel, drawerTidOf } = require(path.join(ROOT, 'dist', 'drawer-progress.js'));

const fails = [];
const eq = (label, got, want) => {
  const a = JSON.stringify(got); const b = JSON.stringify(want);
  if (a !== b) fails.push(`${label}: got ${a}, expected ${b}`);
};

eq('업무 판 조회', stepLabel('Bash', { command: 'python -X utf8 bin/tasks.py brief' }), '업무 판 보는 중');
eq('업무 판 쓰기', stepLabel('Bash', { command: 'python -X utf8 bin/tasks.py update --id TSK-5 --set "상태=완료"' }), '업무 판에 적는 중');
eq('서랍 답 쓰기가 앞섬', stepLabel('Bash', { command: 'python -X utf8 bin/sena_drawer.py reply --turn x --file a.json' }), '답을 서랍에 정리하는 중');
eq('세션 목록', stepLabel('PowerShell', { command: 'python -X utf8 bin/stanley_sessions.py' }), 'PC 세션 목록 보는 중');
eq('모르는 명령', stepLabel('Bash', { command: 'ls -la' }), '명령 실행하는 중');
eq('명령 칸 없음', stepLabel('Bash', null), '명령 실행하는 중');
eq('파일 읽기', stepLabel('Read', { file_path: 'P:/x.md' }), '파일 읽는 중');
eq('연결 도구', stepLabel('mcp__claude_ai_Google_Calendar__list_events', {}), '연결된 도구 쓰는 중');
eq('모르는 도구', stepLabel('Frobnicate', {}), '작업하는 중');
// 인자(업무 이름, 검색어)는 줄에 안 실린다
eq('인자를 싣지 않음', stepLabel('Bash', { command: 'python bin/tasks.py find "연봉 협상"' }).includes('연봉'), false);

const tid = '0123456789abcdef0123456789abcdef';
eq('서랍 차례 id', drawerTidOf(`[서랍 차례 ${tid}]\n오늘 할 일`), tid);
eq('서랍 차례 아님', drawerTidOf('오늘 할 일'), '');
eq('id 모양이 아니면 빈 값', drawerTidOf('[서랍 차례 x;rm]\n말'), '');
eq('없으면 빈 값', drawerTidOf(undefined), '');

if (fails.length) {
  console.error(`check:drawerprogress FAIL (${fails.length})\n` + fails.join('\n'));
  process.exitCode = 1;
} else {
  console.log('check:drawerprogress OK');
}
