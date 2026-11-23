/**
 * 세나 각성 타이머 — 끄는 문이 듣는지, 부르는 명령이 업무 비서에 실제로 있는지 잰다.
 *
 *   node scripts/check-sena-wake.mjs
 *
 * 왜 재나 — 타이머는 조용히 실패한다. 부르는 하위 명령이 업무 비서 쪽에 없으면 10분마다 rc 2 를 로그에만 남기고 각성은 영영 안 돈다.
 */
import './lib/fresh-dist.mjs';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { wakeEnabled, dmOf, postWithRetry, refsMetadata, WAKE_POLL_MS, WAKE_TIMEOUT_MS } = require(path.join(ROOT, 'dist', 'sena-wake.js'));

let pass = 0;
const fails = [];
const check = (name, ok, got) => {
  if (ok) { pass++; console.log(`PASS ${name}`); return; }
  fails.push(name);
  console.log(`FAIL ${name} — 받음 ${JSON.stringify(got)}`);
};

check('기본은 켜짐(A4 관찰 기간 없음)', wakeEnabled({}));
check('SENA_WAKE=off 면 꺼짐(대소문자 무관)', !wakeEnabled({ SENA_WAKE: 'OFF' }));
check('한 번 깨움 상한이 타이머 간격보다 짧음 — 겹쳐 돌지 않게', WAKE_TIMEOUT_MS < WAKE_POLL_MS, [WAKE_TIMEOUT_MS, WAKE_POLL_MS]);
check('tick 출력의 dm 을 보낼 글로 꺼냄', dmOf('{"slot": "x", "dm": "세나 각성 10:07\\n• ① 무엇"}') === '세나 각성 10:07\n• ① 무엇');
check('dm 이 없거나 건너뜀이면 안 보냄', dmOf('{"skip": "시간 밖"}') === '' && dmOf('') === '' && dmOf('깨진 글') === '');
check('여러 줄 출력이면 마지막 JSON 줄만 봄', dmOf('경고 한 줄\n{"dm": "끝"}') === '끝');
{
  // 11/11 재검토 — 보내기가 한 번 실패하면 그 알림은 그날 안 갔다(파이썬은 이미 「보냄」으로 적음)
  let n = 0;
  const flaky = { chat: { postMessage: async () => { n++; if (n === 1) throw new Error('slack 일시 오류'); return { ok: true }; } } };
  check('DM 보내기 한 번 실패하면 한 번 더 보냄', await postWithRetry(flaky, 'D1', '글', 0) === true && n === 2, n);
  let m = 0;
  const down = { chat: { postMessage: async () => { m++; throw new Error('계속 실패'); } } };
  check('두 번 실패하면 그만둠(무한 재시도 없음)', await postWithRetry(down, 'D1', '글', 0) === false && m === 2, m);
  // 11/23 실장님 결정 「메일실험 → 막기먼저」 — 미리보기는 슬랙이 글 속 주소를 부르는 바깥 요청이다
  let sent;
  await postWithRetry({ chat: { postMessage: async (a) => { sent = a; return { ok: true }; } } }, 'D1', '<https://x.example|x>', 0);
  check('각성 DM 은 링크 미리보기를 끔', sent && sent.unfurl_links === false && sent.unfurl_media === false, sent);
}
{
  // 11/23 오조준 — 「precompact 보낼까요」 글에 번호가 없어 DM 세션이 이름이 비슷한 다른 세션을 골랐다. 번호표는 안 보이는 표시 정보로
  const tick = JSON.stringify({ dm: '*업무 비서 마무리 작업*(작업 트리에서 도는 세션)의 컨텍스트가 70%를 넘었어요.',
    dm_refs: [{ head: '*업무 비서 마무리 작업*(작업 트리에서 도는 세션)의 컨텍스트가', ref: 'q-cx-1123-51d4e76d1f83(세션 51d4e76d)' },
      { head: '다른 일', ref: '' }, 'x', null] });
  const meta = refsMetadata(tick);
  check('tick 의 dm_refs 를 번호표 표시 정보로 꺼냄(빈 번호와 깨진 항목은 뺌)',
    meta && meta.event_type === 'sena_wake_dm'
      && meta.event_payload.refs === '「*업무 비서 마무리 작업*(작업 트리에서 도는 세션)의 컨텍스트가」 → q-cx-1123-51d4e76d1f83(세션 51d4e76d)', meta);
  check('번호표가 없으면 표시 정보도 없음', refsMetadata('{"dm": "글"}') === undefined && refsMetadata('깨짐') === undefined);
  let got;
  await postWithRetry({ chat: { postMessage: async (a) => { got = a; return { ok: true }; } } }, 'D1', '글', 0, meta);
  check('번호표는 글이 아니라 metadata 로 실림 — 실장님 글은 그대로', got && got.text === '글' && got.metadata === meta, got);
  const calls = [];
  const picky = { chat: { postMessage: async (a) => {
    calls.push(Boolean(a.metadata));
    if (a.metadata) { const e = new Error('x'); e.data = { error: 'invalid_metadata_format' }; throw e; }
    return { ok: true };
  } } };
  check('슬랙이 번호표를 거절하면 번호표 없이 바로 다시 보냄(알림은 안 잃음)',
    await postWithRetry(picky, 'D1', '글', 0, meta) === true && JSON.stringify(calls) === '[true,false]', calls);
  const seen = [];
  const scope = { chat: { postMessage: async (a) => {
    seen.push(Boolean(a.metadata));
    if (a.metadata) { const e = new Error('x'); e.data = { error: 'missing_scope' }; throw e; }
    return { ok: true };
  } } };
  check('이름에 metadata 가 없는 거절이어도 두 번째는 번호표 없이 보냄(11/23 재검토)',
    await postWithRetry(scope, 'D1', '글', 0, meta) === true && JSON.stringify(seen) === '[true,false]', seen);
  const src = fs.readFileSync(path.join(ROOT, 'src', 'sena-wake.ts'), 'utf8');
  check('타이머가 번호표를 실어 보냄', src.includes('refsMetadata(out)'));
}
{
  // 같은 결정 — 메일 후보 차례(남이 쓴 메일 본문이 든 차례)는 웹 도구를 막는다. 소스에서 이음새 셋을 센다
  const src = (f) => fs.readFileSync(path.join(ROOT, 'src', f), 'utf8');
  check('메일 후보 차례가 noWeb 을 넘김', src('assistant-scheduler.ts').includes("'', { single: true, noWeb: true });"));
  check('noWeb 차례는 WebFetch, WebSearch 를 막음',
    src('slack-handler.ts').includes("...(event.noWeb ? { disallowedTools: ['WebFetch', 'WebSearch'] } : {}),"));
  check('SDK 에 disallowedTools 가 실림', src('sdk-handler.ts').includes('sdkOptions.disallowedTools = opts.disallowedTools'));
}
const wa = process.env.WORK_ASSISTANT_ROOT || 'P:/github/work-assistant';
const py = path.join(wa, 'bin', 'sena_wake.py');
if (fs.existsSync(py)) {
  const src = fs.readFileSync(py, 'utf-8');
  check('업무 비서 sena_wake.py 에 tick 하위 명령이 있음', /add_parser\('tick'\)/.test(src));
} else {
  console.log(`(건너뜀) ${py} 없음 — 업무 비서가 없는 PC`);
}

console.log(`\n${pass} 통과 · ${fails.length} 실패`);
if (fails.length) process.exit(1);
