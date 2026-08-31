/**
 * 처리 못 하고 끝난 차례가 캡처에 자국을 남기는가 — 슬랙도 네트워크도 안 탄다.
 *
 *   npm run check:capfail
 *
 * **일부러 실패를 주입한다.** 실제로 막힌 것이 봇 로그 전체에서 1건이라
 * (2026-08-31 실측 · 정상 265 · 경고 27 · 거절 1), 자연 발생을 기다리면
 * 이 길은 영영 검증되지 않는다. 그리고 이 길은 **조용히 틀린다** — 자국이
 * 안 남으면 밀린 것이 아무 데도 안 뜨고, 오류도 로그도 없다.
 */
import './lib/fresh-dist.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fails = [];
const eq = (label, got, want) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    fails.push(`${label}\n    받음 ${JSON.stringify(got)}\n    기대 ${JSON.stringify(want)}`);
  }
};

// 가짜 볼트 — 실제 캡처 큐를 안 건드린다.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'capfail-'));
const ASSIST = process.env.WORK_ASSISTANT_DIR
  || path.join(path.dirname(ROOT), 'work-assistant');
fs.writeFileSync(path.join(HOME, 'inbox.jsonl'), '', 'utf-8');

// 설정은 진짜 것을 복사한다 — 이 검사는 캡처 큐만 보므로 값은 안 쓰지만,
// `tasks.py` 가 뜰 때 그 파일을 읽는다.
fs.copyFileSync(path.join(ASSIST, 'config.json'), path.join(HOME, 'config.json'));

const py = (...args) => execFileSync('python', ['-X', 'utf8', path.join(ASSIST, 'bin', 'tasks.py'), ...args],
  { cwd: ASSIST, encoding: 'utf-8', env: { ...process.env, WORK_ASSISTANT_HOME: HOME, PYTHONDONTWRITEBYTECODE: '1' } });

const rows = () => fs.readFileSync(path.join(HOME, 'inbox.jsonl'), 'utf-8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l));
const pending = () => JSON.parse(py('inbox', 'pending'));

try {
  const id = py('inbox', 'add', '--text', '판에서 온 말', '--source', 'slack').trim();
  eq('처음에는 돌릴 것이 없다', pending().run.length, 0);

  py('inbox', 'fail', '--id', id, '--why', 'limit');
  eq('실패를 적으면 돌릴 것이 된다', pending().run.map((r) => r.id), [id]);
  eq('원문을 같이 준다', pending().run[0].text, '판에서 온 말');

  // **이유를 안 가린다** — 셋 다 같은 자국이다.
  for (const why of ['error', 'interrupted']) {
    py('inbox', 'fail', '--id', id, '--why', why);
    eq(`${why} 도 돌릴 것이 된다`, pending().run.length, 1);
  }

  // 시도 상한 — 같은 이유로 계속 실패하면 되풀이가 소음이다.
  py('inbox', 'tried', '--id', id);
  py('inbox', 'tried', '--id', id);
  eq('상한 아래면 아직 돌린다', pending().run.length, 1);
  py('inbox', 'tried', '--id', id);
  eq('상한을 넘으면 안 돌린다', pending().run.length, 0);
  eq('대신 사람에게 낸다', pending().tell.map((t) => t.id), [id]);

  // 닫힌 것 — 「닫힘」은 「다 했다」가 아니라 「무언가 썼다」다.
  const id2 = py('inbox', 'add', '--text', '일하다 끊긴 말', '--source', 'slack').trim();
  py('inbox', 'fail', '--id', id2, '--why', 'limit');
  py('inbox', 'resolve', '--id', id2, '--task', 'TSK-9');
  eq('닫힌 것은 안 돌린다', pending().run.map((r) => r.id), []);
  eq('닫힌 것도 사람에게는 낸다',
     pending().tell.find((t) => t.id === id2)?.why, '끊긴 채 닫힘');

  // 실패 표시가 없는 캡처(조회·잡담)는 애초에 대상이 아니다.
  const id3 = py('inbox', 'add', '--text', '현황 알려줘', '--source', 'slack').trim();
  eq('조회는 안 돌린다', pending().run.map((r) => r.id).includes(id3), false);
  eq('조회는 사람에게도 안 낸다', pending().tell.map((t) => t.id).includes(id3), false);

  // 봇이 부르는 이름이 실제로 있는가 — 계약이 갈리면 조용히 안 남는다.
  const bridge = fs.readFileSync(path.join(ROOT, 'src', 'work-assistant.ts'), 'utf-8');
  const m = bridge.match(/'inbox',\s*'fail',\s*'--id',\s*id,\s*'--why',\s*why/);
  eq('봇이 부르는 명령이 그대로다', Boolean(m), true);

  // 세 자리에서 다 부르는가 — 하나라도 빠지면 그 갈래만 조용히 샌다.
  const h = fs.readFileSync(path.join(ROOT, 'src', 'slack-handler.ts'), 'utf-8');
  const calls = h.match(/markCaptureFailed\(/g) || [];
  eq('실패 세 자리에서 다 부른다', calls.length, 3);
  eq('재시작 갈래는 inflight 의 캡처를 쓴다',
     /markCaptureFailed\(r\.captureId \?\? '', 'interrupted'\)/.test(h), true);
  eq('inflight 가 캡처를 싣는다', /startedAt: new Date\(\)\.toISOString\(\), captureId/.test(h), true);
} finally {
  fs.rmSync(HOME, { recursive: true, force: true });
}

if (fails.length) {
  console.error('실패 ' + fails.length + '건\n');
  for (const f of fails) console.error('  ✗ ' + f);
  process.exitCode = 1;
} else {
  console.log('통과 — 처리 못 한 차례 (자국 남김 · 이유 안 가림 · 시도 상한 · 닫힌 것 제외 '
    + '· 조회 제외 · 봇이 부르는 이름 · 세 자리 배선)');
}
