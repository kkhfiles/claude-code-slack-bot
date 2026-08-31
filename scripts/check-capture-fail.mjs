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

  // 일하다 끊긴 것 — **순서가 곧 뜻이다.** 「닫힘」은 「다 했다」가 아니라
  // 「무언가 썼다」라서(첫 쓰기에 닫힌다), 세션이 한 칸 쓰고 끊기면 **닫힌
  // 뒤에** 실패 표시가 붙는다. 08/31 TSK-47 이 실제로 그 순서였다.
  // ⚠️ 반대 순서로 재면 안 난다 — 그쪽은 「다시 돌려서 됐다」는 뜻이다.
  const id2 = py('inbox', 'add', '--text', '일하다 끊긴 말', '--source', 'slack').trim();
  py('inbox', 'resolve', '--id', id2, '--task', 'TSK-9');
  py('inbox', 'fail', '--id', id2, '--why', 'limit');
  eq('닫힌 것은 안 돌린다', pending().run.map((r) => r.id), []);
  eq('닫힌 뒤에 붙은 자국은 사람에게 낸다',
     pending().tell.find((t) => t.id === id2)?.why, '끊긴 채 닫힘');

  // **닫으면 자국이 지워진다** — 다시 돌려서 성공한 것이 브리핑에 영영 남으면
  // 안 된다. 위 id2 와 짝이다: 지우는 것은 닫는 쪽뿐이고, 닫힌 뒤에 붙는 것은
  // 그대로 남는다.
  const id4 = py('inbox', 'add', '--text', '다시 돌려서 된 말', '--source', 'slack').trim();
  py('inbox', 'fail', '--id', id4, '--why', 'limit');
  eq('돌릴 것이 된다', pending().run.map((r) => r.id).includes(id4), true);
  py('inbox', 'resolve', '--id', id4, '--task', 'TSK-8');
  eq('닫으면 돌릴 것에서 빠진다', pending().run.map((r) => r.id).includes(id4), false);
  eq('닫으면 사람에게도 안 낸다', pending().tell.map((t) => t.id).includes(id4), false);
  eq('자국이 실제로 지워졌다', rows().find((r) => r.id === id4).failed ?? null, null);

  // 실패 표시가 없는 캡처(조회·잡담)는 애초에 대상이 아니다.
  const id3 = py('inbox', 'add', '--text', '현황 알려줘', '--source', 'slack').trim();
  eq('조회는 안 돌린다', pending().run.map((r) => r.id).includes(id3), false);
  eq('조회는 사람에게도 안 낸다', pending().tell.map((t) => t.id).includes(id3), false);

  // ---------- 드레인 ----------
  //
  // **핵심은 「큐가 줄어드는가」다.** 다시 돌릴 때 캡처를 새로 붙이면 옛 것은
  // 열린 채 남고 새 것이 하나 더 생겨 **영영 안 줄어든다.** 원래 캡처 id 를
  // 그대로 넘겨야 하고, 그 계약이 배선에 실제로 박혀 있는지 센다.
  {
    const h = fs.readFileSync(path.join(ROOT, 'src', 'slack-handler.ts'), 'utf-8');
    eq('이벤트가 캡처 id 를 나른다', /captureId\?: string;/.test(h), true);
    eq('다시 돌리는 길은 캡처를 새로 안 붙인다',
       /event\.captureId[\s\S]{0,40}\{ id: event\.captureId \}/.test(h), true);
    eq('드레인이 원래 캡처를 넘긴다',
       /askFromBoard\([\s\S]{0,200}it\.id\)/.test(h), true);

    const from = h.indexOf('private async drainStuck');
    const body = h.slice(from, h.indexOf('\n  }', from));
    // **넘기기 전에 센다** — 뒤에 세면 또 터졌을 때 못 세고 끝없이 되풀이한다.
    // ⚠️ **있는지부터 본다** — `indexOf` 는 없으면 -1 이고 -1 은 무엇보다 앞이라,
    // 호출을 통째로 지우면 이 문이 통과한다(변이 시험이 실제로 뚫었다).
    const iTry = body.indexOf('markCaptureTried');
    const iAsk = body.indexOf('askFromBoard');
    eq('시도를 세기는 하나', iTry >= 0, true);
    eq('시도를 넘기기 전에 센다', iTry >= 0 && iAsk >= 0 && iTry < iAsk, true);
    eq('겹쳐 돌지 않게 막는다', /this\.draining = true;/.test(body), true);
    eq('한 건이 터져도 나머지는 간다', /catch \(err\)/.test(body), true);

    // 트리거 둘 — 하나라도 빠지면 그 길로 밀린 것이 영영 안 돈다.
    eq('기동 때 돈다', /this\.drainStuck\('기동'\)/.test(h), true);
    eq('한도 회복 때 돈다', /this\.drainStuck\('한도 회복'\)/.test(h), true);
    // **알리고 나서 돌린다** — 먼저 돌리면 끊긴 자국이 아직 안 찍혀 빠진다.
    // ⚠️ **예약하는 줄만 본다** — 파일 위쪽에 `reportInterruptedSessions` 의
    // 정의가 있어, 파일 전체에서 `indexOf` 로 찾으면 늘 그 정의가 잡혀 순서가
    // 뒤바뀌어도 통과한다(변이 시험이 실제로 뚫었다).
    const arm = h.match(/setTimeout\([\s\S]{0,300}?drainStuck\('기동'\)[\s\S]{0,120}?\d[\d_]*\);/);
    eq('기동 드레인을 예약하는 줄이 있다', Boolean(arm), true);
    if (arm) {
      const iRep = arm[0].indexOf('reportInterruptedSessions()');
      const iDrn = arm[0].indexOf("drainStuck('기동')");
      eq('끊긴 것을 알린 뒤에 돈다', iRep >= 0 && iRep < iDrn, true);
    }
  }

  // 봇이 부르는 이름이 실제로 있는가 — 계약이 갈리면 조용히 안 남는다.
  const bridge = fs.readFileSync(path.join(ROOT, 'src', 'work-assistant.ts'), 'utf-8');
  const m = bridge.match(/'inbox',\s*'fail',\s*'--id',\s*id,\s*'--why',\s*why/);
  eq('봇이 부르는 명령이 그대로다', Boolean(m), true);
  eq('밀린 목록을 부르는 이름이 그대로다',
     /'inbox',\s*'pending',\s*'--limit'/.test(bridge), true);
  eq('시도를 세는 이름이 그대로다',
     /'inbox',\s*'tried',\s*'--id',\s*id/.test(bridge), true);

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
    + '· 조회 제외 · 닫으면 자국 지움 · 드레인 배선 · 봇이 부르는 이름 · 세 자리 배선)');
}
