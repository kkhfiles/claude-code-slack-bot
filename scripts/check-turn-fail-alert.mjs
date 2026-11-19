/**
 * 연속 오류 알림(`turn-fail-alert.ts`) — 같은 대화의 차례가 한도가 아닌 오류로 3차례 연달아 끝나면 DM 한 줄(2026-11-19).
 * 그날 08:47~11:09 같은 대화의 차례 여섯이 같은 오류로 끝났는데 알림이 없었다. 여기서 보는 것:
 * - 셋째 오류에 한 번, 같은 오류는 그날 다시 안 보냄(번호가 달라도 같은 오류), 다음 날은 다시 보냄
 * - 성공은 줄을 끊고, 한도와 과부하는 세지도 끊지도 않음
 * - 대화마다 따로 셈 — 다른 대화의 성공이 망가진 대화의 줄을 안 끊음
 * - 꺼져 있으면 안 보내고 로그만, 보내다 실패하면 다음 오류에 다시
 * - 배선 — 차례 끝에서 대화 열쇠와 결과로 부르고, 사람이 끊은 차례는 안 셈
 */
import './lib/fresh-dist.mjs';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-fail-alert-'));
process.env.TURN_FAIL_ALERT_FILE = path.join(TMP, 'sent.json');
const { TurnFailAlert, signature } = require(path.join(ROOT, 'dist', 'turn-fail-alert.js'));

const fails = [];
const ok = (name, cond) => { if (!cond) fails.push(name); };

const E1 = 'Claude Code returned an error result: No message found with message.uuid of: 0ed017a8-e856-4b88-bef2-5aeeb4a5f4c9';
const E2 = 'Claude Code returned an error result: No message found with message.uuid of: 9e301743-49c2-4827-b99e-9d6fee4299bd';
const OTHER = 'spawn ENOENT';

function make({ enabled = true, day = '2026-11-19T10:00:00', postFails = false } = {}) {
  const posts = [];
  const logs = [];
  let now = new Date(day);
  const a = new TurnFailAlert({
    post: async (t) => { if (postFails) throw new Error('slack down'); posts.push(t); },
    log: (t) => logs.push(t),
    enabled: () => enabled,
    now: () => now,
  });
  return { a, posts, logs, setNow: (d) => { now = new Date(d); } };
}
const reset = () => { try { fs.rmSync(process.env.TURN_FAIL_ALERT_FILE); } catch { } };

// 1. 셋째에 한 번, 같은 오류(번호만 다름)는 그날 다시 안 보냄, 다음 날 다시
reset();
{
  const { a, posts, setNow } = make();
  ok('1 첫째 오류 안 보냄', (await a.record('dm', 'error', 'DM 대화', E1)) === null);
  ok('1 둘째 오류 안 보냄', (await a.record('dm', 'error', 'DM 대화', E1)) === null);
  const t = await a.record('dm', 'error', 'DM 대화', E1);
  ok('1 셋째 오류에 보냄', posts.length === 1 && t === posts[0]);
  ok('1 글 모양 — 횟수, 대상, 오류 첫 줄', /^⚠️ 봇 차례 3회 연속 오류 — DM 대화 — 「Claude Code returned an error result: No message found/.test(posts[0] ?? ''));
  ok('1 로직 알림이라 말투 없음', !/(습니다|세요|니다)/.test(posts[0] ?? ''));
  await a.record('dm', 'error', 'DM 대화', E2);
  ok('1 번호만 다른 같은 오류는 그날 다시 안 보냄', posts.length === 1);
  ok('1 번호를 지운 모양이 같음', signature(E1) === signature(E2));
  await a.record('dm', 'error', 'DM 대화', OTHER);
  ok('1 다른 오류는 그날도 보냄', posts.length === 2);
  setNow('2026-11-20T09:00:00');
  await a.record('dm', 'error', 'DM 대화', E1);
  ok('1 다음 날은 다시 보냄', posts.length === 3);
}

// 2. 성공은 줄을 끊음
reset();
{
  const { a, posts } = make();
  await a.record('dm', 'error', 'DM 대화', E1);
  await a.record('dm', 'error', 'DM 대화', E1);
  await a.record('dm', 'ok', 'DM 대화');
  await a.record('dm', 'error', 'DM 대화', E1);
  await a.record('dm', 'error', 'DM 대화', E1);
  ok('2 성공 뒤 두 번은 안 보냄', posts.length === 0);
  await a.record('dm', 'error', 'DM 대화', E1);
  ok('2 성공 뒤 셋째에 보냄', posts.length === 1);
}

// 3. 한도와 과부하는 세지도 끊지도 않음
reset();
{
  const { a, posts } = make();
  await a.record('dm', 'error', 'DM 대화', E1);
  await a.record('dm', 'limited', 'DM 대화', "You've hit your 5-hour limit");
  await a.record('dm', 'overload', 'DM 대화', 'Overloaded');
  await a.record('dm', 'limited', 'DM 대화', "You've hit your 5-hour limit");
  ok('3 한도만으로는 안 보냄', posts.length === 0);
  await a.record('dm', 'error', 'DM 대화', E1);
  await a.record('dm', 'error', 'DM 대화', E1);
  ok('3 한도 사이에 둔 오류 셋에 보냄', posts.length === 1);
}

// 4. 대화마다 따로 — 다른 대화의 성공이 줄을 안 끊음
reset();
{
  const { a, posts } = make();
  await a.record('dm', 'error', 'DM 대화', E1);
  await a.record('ch', 'ok', '<#C1>');
  await a.record('dm', 'error', 'DM 대화', E1);
  await a.record('ch', 'error', '<#C1>', OTHER);
  await a.record('ch', 'ok', '<#C1>');
  await a.record('dm', 'error', 'DM 대화', E1);
  ok('4 다른 대화의 성공이 사이에 있어도 보냄', posts.length === 1 && posts[0].includes('DM 대화'));
}

// 5. 꺼져 있으면 안 보내고 로그만, 알린 날도 안 적음
reset();
{
  const { a, posts, logs } = make({ enabled: false });
  for (let i = 0; i < 3; i++) await a.record('dm', 'error', 'DM 대화', E1);
  ok('5 꺼져 있으면 안 보냄', posts.length === 0);
  ok('5 꺼져 있으면 로그에 보낼 줄', logs.some((l) => l.includes('꺼져 있어 안 보냄') && l.includes('3회 연속 오류')));
  ok('5 꺼져 있으면 알린 날을 안 적음', !fs.existsSync(process.env.TURN_FAIL_ALERT_FILE));
}

// 6. 보내다 실패하면 던지지 않고, 다음 오류에 다시
reset();
{
  const bad = make({ postFails: true });
  let threw = false;
  try { for (let i = 0; i < 3; i++) await bad.a.record('dm', 'error', 'DM 대화', E1); } catch { threw = true; }
  ok('6 보내기 실패에 던지지 않음', !threw);
  ok('6 보내기 실패는 알린 날로 안 적음', !fs.existsSync(process.env.TURN_FAIL_ALERT_FILE));
  // 같은 파일을 보는 새 장치(재시작)로 다음 오류 — 다시 보낸다
  const good = make();
  for (let i = 0; i < 3; i++) await good.a.record('dm', 'error', 'DM 대화', E1);
  ok('6 실패한 뒤 다음 오류 셋에 보냄', good.posts.length === 1);
  // 재시작해도 그날 같은 오류는 안 보냄(파일)
  const again = make();
  for (let i = 0; i < 3; i++) await again.a.record('dm', 'error', 'DM 대화', E1);
  ok('6 재시작 뒤에도 그날 같은 오류는 안 보냄', again.posts.length === 0);
}

// 7. 배선
{
  const src = fs.readFileSync(path.join(ROOT, 'src', 'slack-handler.ts'), 'utf-8');
  ok('7 차례 끝에서 대화 열쇠와 결과로 부름',
    /turnFailAlert\?\.record\(sessionKey, outcomeFrom\(turnBlock, cliError \|\| turnThrew\)/.test(src));
  ok('7 사람이 끊은 차례는 안 셈', /if \(!turnStopped\) \{[\s\S]{0,300}turnFailAlert\?\.record/.test(src));
  ok('7 오류 결과의 글을 받음', /cliError = true;\s*\n\s*if \(!turnErrorText\) turnErrorText =/.test(src));
  ok('7 던진 오류의 글을 받음', /turnErrorText = turnErrorText \|\| String\(error\?\.message/.test(src));
  ok('7 기본 꺼짐 — 켜는 문은 TURN_FAIL_ALERT',
    /process\.env\.TURN_FAIL_ALERT === 'on'/.test(fs.readFileSync(path.join(ROOT, 'src', 'turn-fail-alert.ts'), 'utf-8')));
}

fs.rmSync(TMP, { recursive: true, force: true });
if (fails.length) {
  console.error(`연속 오류 알림 검사 실패 ${fails.length}건:\n- ${fails.join('\n- ')}`);
  process.exit(1);
}
console.log('연속 오류 알림 검사 통과');
