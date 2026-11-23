#!/usr/bin/env node
/**
 * 세나 DM 답의 내부 번호 점검 — `src/internal-labels.ts`(2026-11-23 · 사고 ic-20261123-4).
 *
 *   npm run build
 *   npm run check:labels
 *
 * 17:09 답 「답 대기에 `q-1123-mistake-rule`로 걸어 뒀어요」 그대로를 넣어 본다 — 봇이 붙잡고, Stop 훅이 같은 차례 안에서
 * 돌려보내고, 다시 쓴 답만 올라가는지. 훅이 봇보다 먼저 도는 겨루기 두 갈래와 훅이 아예 안 도는 경우(답을 잃지 않음),
 * 거르지 않는 차례(판, 서랍, 채널, 번호를 묻는 말), 미리 띄우기 지문이 안 흔들리는지, 옵션이 SDK 까지 가는지도 본다.
 *
 * 번호 모양은 업무 비서 레포 `bin/sena_labels.json` 이 정본이다 — 환경 변수 `SENA_LABELS_FILE` 이 있으면 그것을,
 * 없으면 이웃한 업무 비서 레포(`../work-assistant`)의 것을 읽는다. **진짜 모델을 안 부른다.**
 */
import './lib/fresh-dist.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const L = require(path.join(ROOT, 'dist', 'internal-labels.js'));
const { SdkHandler } = require(path.join(ROOT, 'dist', 'sdk-handler.js'));

const RULES = process.env.SENA_LABELS_FILE || path.resolve(ROOT, '..', 'work-assistant', 'bin', 'sena_labels.json');
if (!fs.existsSync(RULES)) {
  console.error(`번호 모양 정본이 없습니다: ${RULES} — SENA_LABELS_FILE 로 알려 주세요`);
  process.exit(1);
}
L.setRulesFileForTest(RULES);

const fails = [];
const eq = (label, got, want) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a !== b) fails.push(`${label}\n    받음 ${a}\n    기대 ${b}`);
};
const ok = (label, cond) => { if (!cond) fails.push(label); };

const INCIDENT = '문안은 이렇게 정해 두고, 답 대기에 `q-1123-mistake-rule`로 걸어 뒀어요. 승인하시면 반영할게요.';
const REWRITE = '고칠 문안을 드렸고, 실장님이 반영하라고 하시면 바로 고칠게요.';
const USER = '실수는 계속 고칠 수 있도록 기록해야함. 같은 실수를 반복하지 않는 것이 최우선임. 명시해둘 것.';
const stop = (sid, last, active = false) => L.labelStopHook({ hook_event_name: 'Stop', session_id: sid, stop_hook_active: active, last_assistant_message: last });

// 1. 찾기 — 사고 문장, 안 거를 글, 번호를 묻는 말
eq('17:09 답의 물음 번호', L.findLabels(INCIDENT), ['q-1123-mistake-rule']);
eq('한글 바로 뒤 번호', L.findLabels('물음q-1123-mistake-rule로'), ['q-1123-mistake-rule']);
eq('지시, 사고, 커밋 번호', L.findLabels('지시 90ea6219196b 를 사고 ic-20261123-4 에 이었고 `f56d3c8` 로 고쳤어요'),
  ['90ea6219196b', 'ic-20261123-4', 'f56d3c8']);
for (const t of ['TSK-141 은 오늘 마감이에요', '<https://dispatchflow.cc/board/3aa7487f9d2181ba8627fab6e496335d|판에서 보기>',
  '<!here> 확인했어요', '11/23(월) 17:09 에 보냈어요', '20261123 기준 3건']) eq(`안 거름: ${t}`, L.findLabels(t), []);
eq('번호를 물으신 말', L.findLabels(INCIDENT, '그 물음 번호 뭐야'), []);

// 2. 거르는 차례
eq('사람이 친 DM', L.wantGuard({ isDM: true, pushed: false, drawer: false, userText: USER }), true);
eq('판·메일이 넘긴 차례', L.wantGuard({ isDM: true, pushed: true, drawer: false, userText: USER }), false);
eq('서랍 차례', L.wantGuard({ isDM: true, pushed: false, drawer: true, userText: USER }), false);
eq('채널', L.wantGuard({ isDM: false, pushed: false, drawer: false, userText: USER }), false);
eq('번호를 묻는 DM', L.wantGuard({ isDM: true, pushed: false, drawer: false, userText: '근거 번호 알려 줘' }), false);
process.env.LABEL_GUARD = 'off';
eq('끄는 문', L.wantGuard({ isDM: true, pushed: false, drawer: false, userText: USER }), false);
delete process.env.LABEL_GUARD;

// 3. 사고 그대로 — 붙잡고, 돌려보내고, 다시 쓴 답만 올라감
{
  const sid = 's-incident';
  eq('번호 든 답은 안 올림', L.noteText(sid, INCIDENT, true, USER), 'hold');
  const r = await stop(sid, INCIDENT);
  eq('훅이 돌려보냄', r.decision, 'block');
  ok('돌려보내는 말에 붙잡은 번호와 답이 있음', r.reason?.includes('q-1123-mistake-rule') && r.reason?.includes(INCIDENT));
  eq('같은 글이 결과로 다시 와도 안 올림', L.noteText(sid, INCIDENT, true, USER), 'hold');
  eq('다시 쓴 답은 올림', L.noteText(sid, REWRITE, true, USER), 'post');
  eq('두 번째 멈춤은 그냥 둠', await stop(sid, REWRITE, true), {});
  eq('차례 끝에 따로 올릴 것 없음', L.finishTurn(sid), []);
}

// 4. 다시 쓴 답에도 번호가 남으면 그대로 올림(다시 돌려보낼 길이 없어 답을 잃지 않게)
{
  const sid = 's-stubborn';
  L.noteText(sid, INCIDENT, true, USER);
  await stop(sid, INCIDENT);
  eq('다시 쓴 답에 번호가 남아도 올림', L.noteText(sid, '여전히 q-1123-mistake-rule 이에요', true, USER), 'post');
  eq('차례 끝 남은 것 없음', L.finishTurn(sid), []);
}

// 5. 겨루기 — 훅이 봇보다 먼저 돌고, 기다리는 사이 봇이 읽음
{
  const sid = 's-race-a';
  const p = stop(sid, INCIDENT);   // 아직 봇은 그 세션의 글을 못 읽음 — 기록조차 없음
  // 기록이 없는 세션은 거르지 않는 세션이다 — 첫 글이 먼저 와야 한다. 앞 글 하나를 읽은 상태로 다시 잰다
  eq('기록 없는 세션은 그냥 멈춤', await p, {});
  L.noteText(sid, '확인해 볼게요', true, USER);
  const q = stop(sid, INCIDENT);
  await new Promise((r) => setTimeout(r, 100));
  eq('기다리는 사이 읽은 번호 답은 안 올림', L.noteText(sid, INCIDENT, true, USER), 'hold');
  const r = await q;
  eq('훅이 그 글을 보고 돌려보냄', r.decision, 'block');
  eq('차례 끝 남은 것 없음', L.finishTurn(sid), []);
}

// 6. 겨루기 — 기다려도 봇이 못 읽으면 훅이 그 글만 보고 돌려보내고, 뒤늦게 온 글은 안 올림
{
  const sid = 's-race-b';
  L.noteText(sid, '확인해 볼게요', true, USER);
  const t0 = Date.now();
  const r = await stop(sid, INCIDENT);
  eq('못 읽었어도 돌려보냄', r.decision, 'block');
  ok(`기다린 시간이 상한 안(${Date.now() - t0}ms)`, Date.now() - t0 < L.SEEN_WAIT_MS + 500);
  eq('뒤늦게 온 같은 글은 안 올림', L.noteText(sid, INCIDENT, true, USER), 'hold');
  eq('다시 쓴 답은 올림', L.noteText(sid, REWRITE, true, USER), 'post');
  eq('차례 끝 남은 것 없음', L.finishTurn(sid), []);
}

// 7. 훅이 아예 안 돌면(한도로 끊김 등) 붙잡은 답을 차례 끝에 그대로 돌려줌 — 답을 잃지 않음
{
  const sid = 's-nohook';
  L.noteText(sid, INCIDENT, true, USER);
  eq('붙잡은 답을 돌려줌', L.finishTurn(sid), [INCIDENT.trim()]);
}

// 8. 거르지 않는 차례는 번호가 있어도 올리고 훅도 그냥 둠
{
  const sid = 's-off';
  eq('거르지 않는 차례', L.noteText(sid, INCIDENT, false, USER), 'post');
  eq('훅은 그냥 둠', await stop(sid, INCIDENT), {});
}

// 9. 미리 띄우기 지문과 SDK 옵션 — 훅 객체는 늘 같고 SDK 까지 간다
eq('지문에 찍히는 모양', JSON.parse(JSON.stringify(L.LABEL_HOOKS)), { Stop: [{ hooks: [null] }] });
{
  let seen = null;
  SdkHandler.queryFn = ({ options }) => { seen = options; return { async *[Symbol.asyncIterator]() {}, interrupt() {} }; };
  const h = new SdkHandler({ getServerConfiguration: () => ({}), getDefaultAllowedTools: () => [] });
  h.runQuery('x', { workingDirectory: ROOT, hooks: L.LABEL_HOOKS });
  ok('훅이 SDK 옵션에 실림', seen?.hooks === L.LABEL_HOOKS);
}

if (fails.length) {
  console.error(`실패 ${fails.length}건:\n  ${fails.join('\n  ')}`);
  process.exit(1);
}
console.log('check:labels — 통과');
