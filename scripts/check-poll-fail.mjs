/**
 * 2분 점검 셋(알림 `scheduler:remind`, 보류 지시 `scheduler:held`, 세나 각성 `sena:wake`)이 실패를 실패로 적는가.
 *
 *   node scripts/check-poll-fail.mjs
 *
 * 왜 재나 — 셋 다 실패하면 빈 목록이나 그냥 `return` 으로 끝나 타이머 기록(`bot-timers.json`)에 성공으로 남았다.
 * 안쪽 파이썬 일(지시 결과, 저절로 닫기, 답 보내기, 탭 닫기 등)이 터져도 표준 오류로만 나갔다(2026-11-26 구조 검토 2-1).
 * 지금은 파이썬이 결과 JSON 의 `errors` 에 일 이름을 싣고, 봇은 rc · JSON · `errors` 중 하나라도 어긋나면 `RunFailure` 를 돌려준다.
 */
import './lib/fresh-dist.mjs';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { pollJson } = require(path.join(ROOT, 'dist', 'work-assistant.js'));
const { config } = require(path.join(ROOT, 'dist', 'config.js'));
const WA_ROOT = process.env.WORK_ASSISTANT_ROOT || 'P:/github/work-assistant';
// 작업 트리처럼 형제 폴더가 없는 곳에서도 돌게 — 시험 스크립트는 절대 경로라 이 폴더는 `bin/tasks.py` 가 있는지만 본다
config.workAssistant.root = WA_ROOT;

let pass = 0;
const fails = [];
const check = (name, ok, got) => {
  if (ok) { pass++; console.log(`PASS ${name}`); return; }
  fails.push(name);
  console.log(`FAIL ${name} — 받음 ${JSON.stringify(got)}`);
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poll-fail-'));
const script = (name, body) => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, body, 'utf-8');
  return p;
};

if (fs.existsSync(path.join(WA_ROOT, 'bin', 'tasks.py'))) {
  const ok = await pollJson([], 30_000, script('ok.py', 'import json\nprint(json.dumps({"items": [{"id": "a"}]}))\n'));
  check('정상이면 줄만, 실패 없음', ok.items.length === 1 && !ok.fail, ok);
  const rc = await pollJson([], 30_000, script('rc.py', 'import sys\nsys.exit(3)\n'));
  check('rc 가 0 이 아니면 rc 실패', rc.fail === 'rc' && rc.items.length === 0, rc);
  const bad = await pollJson([], 30_000, script('bad.py', 'print("깨진 글")\n'));
  check('JSON 이 깨지면 json 실패', bad.fail === 'json', bad);
  const inner = await pollJson([], 30_000, script('inner.py',
    'import json\nprint(json.dumps({"items": [{"id": "b"}], "errors": ["results", "close"]}))\n'));
  check('안쪽 일이 터지면 inner 실패 — 받은 줄은 그대로 돌려줌',
    inner.fail === 'inner' && inner.items.length === 1 && inner.errors.join() === 'results,close', inner);
} else {
  console.log('(건너뜀) 업무 비서가 없는 PC — pollJson 실행 시험');
}

// 세 타이머가 실패를 돌려주는 꼴인지 소스로 본다 — 누가 빈 return 으로 되돌리면 깨진다
const src = (f) => fs.readFileSync(path.join(ROOT, 'src', f), 'utf-8');
const sched = src('assistant-scheduler.ts');
check('알림 점검이 RunFailure 를 돌려줌', /private async runRemindPoll\(\): Promise<void \| RunFailure>/.test(sched));
check('알림 점검이 fail 을 실패로 바꿈', /const failure: RunFailure \| undefined = fail \?/.test(sched));
check('보류 점검이 RunFailure 를 돌려줌', /async runHeldPoll\(\): Promise<number \| RunFailure>/.test(sched) && /return \{ ok: false, code: fail \}/.test(sched));
const wake = src('sena-wake.ts');
check('각성이 rc 실패를 실패로 적음', /return \{ ok: false, code: 'rc' \}/.test(wake) && /return \{ ok: false, code: 'spawn' \}/.test(wake));

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} 통과 · ${fails.length} 실패`);
if (fails.length) process.exit(1);
