/**
 * DM 차례는 마지막 답만 올린다 — 도구 호출 사이의 중간 글(속생각)은 버린다(사고 ic-20261127-2).
 *
 *   npm run check:interim
 *
 * 왜 재나 — 2026-11-27 12:46 「왜 안된거야?」 차례에서 SDK 가 글과 도구 호출을 따로 내보냈고, 봇이 도구 호출 없는
 * 이벤트의 글 「Need the result body. Find the results ledger file.」을 받자마자 슬랙에 올렸다. 그래서 그 차례의
 * 이벤트 순서를 그대로 다시 흘려 본다(증상이 났던 모양 — 글 이벤트와 도구 이벤트가 따로).
 *
 * 보는 것
 * - `ReplyBuffer` — 도구 앞의 글은 버리고 마지막 도구 뒤의 글만, 두 번 불러도 한 번만, 붙잡은 글은 안 올림
 * - `forgetHeld` — 내부 번호 문이 붙잡은 중간 글은 차례 끝(`finishTurn`)에 남지 않음
 * - 배선 — DM 글은 받는 자리에서 바로 안 올리고 쥐며, 도구 호출에 버리고, 결과와 스트림 끝에서 올림
 */
import './lib/fresh-dist.mjs';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { ReplyBuffer } = require(path.join(ROOT, 'dist', 'interim-text.js'));
const labels = require(path.join(ROOT, 'dist', 'internal-labels.js'));

const fails = [];
const ok = (name, cond) => { if (!cond) fails.push(name); };
const eq = (name, a, b) => ok(`${name} — ${JSON.stringify(a)}`, JSON.stringify(a) === JSON.stringify(b));

/** 이벤트를 흘려 슬랙에 올라갈 글을 돌려준다 — 핸들러가 하는 일과 같은 순서 */
function replay(events) {
  const buf = new ReplyBuffer();
  const out = [];
  for (const e of events) {
    if (e === 'tool') buf.tool();
    else if (e === 'result') out.push(...buf.flush());
    else buf.text(e.text, !!e.held);
  }
  out.push(...buf.flush());  // 스트림 끝 — 결과에서 올렸으면 빈 목록
  return out;
}

const ANSWER = '그 세션은 검토를 맡긴 외부 모델 둘에게서 모두 답을 받지 못했어요.';
// ep-1795751184264939 의 순서(대화 기록 ac535d56): 도구 셋 → 중간 글 → 도구 넷 → 답 → 결과
eq('사고 차례 — 답만 나감', replay([
  'tool', 'tool', 'tool',
  { text: 'Need the result body. Find the results ledger file.' },
  'tool', 'tool', 'tool', 'tool',
  { text: ANSWER },
  'result',
]), [ANSWER]);

eq('도구 없는 차례 — 그대로', replay([{ text: '네, 넣었어요.' }, 'result']), ['네, 넣었어요.']);
eq('마지막 도구 뒤 글이 둘이면 둘 다', replay(['tool', { text: '가' }, { text: '나' }, 'result']), ['가', '나']);
eq('결과 이벤트 없이 끝나도 답을 잃지 않음', replay(['tool', { text: ANSWER }]), [ANSWER]);
eq('결과와 스트림 끝에서 두 번 올리지 않음', replay([{ text: ANSWER }, 'result']).length, 1);
eq('붙잡은 글은 안 올림(내부 번호 문 몫)', replay([{ text: 'TSK-3 넣었어요', held: true }, 'result']), []);
eq('도구로 끝난 차례 — 올릴 것 없음', replay([{ text: '찾아볼게요' }, 'tool', 'result']), []);

{
  const buf = new ReplyBuffer();
  buf.text('중간', true);
  eq('버린 글을 붙잡힘 표시와 함께 돌려줌', buf.tool(), [{ text: '중간', held: true }]);
}

// 내부 번호 문 — 붙잡은 중간 글은 차례 끝에 「못 풀고 그대로 올림」으로 새지 않는다
// 번호 모양 정본(`bin/sena_labels.json`)은 check:labels 와 같은 곳에서 읽는다 — 없으면 문이 안 붙잡아 이 갈래를 못 잰다
const RULES = process.env.SENA_LABELS_FILE || path.resolve(ROOT, '..', 'work-assistant', 'bin', 'sena_labels.json');
if (fs.existsSync(RULES)) labels.setRulesFileForTest(RULES);
{
  const sid = 'sid-interim-check';
  const NOTE = '답 대기에 `q-1123-mistake-rule`로 걸어 뒀어요. 이어서 확인할게요.';
  if (fs.existsSync(RULES)) {
    eq('번호 든 중간 글은 문이 붙잡음', labels.noteText(sid, NOTE, true, '왜 안된거야?'), 'hold');
    labels.forgetHeld(sid, NOTE);
    eq('붙잡은 중간 글을 빼면 차례 끝에 안 남음', labels.finishTurn(sid), []);
    labels.noteText(sid, NOTE, true, '왜 안된거야?');
    eq('빼지 않으면 차례 끝에 남음(대조)', labels.finishTurn(sid), [NOTE]);
  } else {
    fails.push(`번호 모양 정본이 없습니다: ${RULES} — SENA_LABELS_FILE 로 알려 주세요`);
  }
  labels.forgetHeld('없는-세션', 'x');  // 기록 없는 세션도 조용히
}

// 배선 — 핸들러가 DM 글을 받는 즉시 올리던 길이 되살아나지 않게
const src = fs.readFileSync(path.join(ROOT, 'src', 'slack-handler.ts'), 'utf-8');
ok('배선: DM 글은 쥔다', /if \(isDM\) replyBuf\.text\(content, decision === 'hold'\)/.test(src));
ok('배선: 채널만 바로 올린다', /else if \(decision === 'post'\) await say\(\{ text: this\.formatMessage\(content, false\)/.test(src));
ok('배선: 도구 호출에 버린다', /const dropped = replyBuf\.tool\(\);/.test(src));
ok('배선: 붙잡은 중간 글을 문에서 뺀다', /if \(d\.held\) forgetHeld\(labelSid, d\.text\)/.test(src));
ok('배선: 결과와 스트림 끝 두 곳에서 올린다',
  (src.match(/for \(const t of replyBuf\.flush\(\)\) await say\(/g) ?? []).length === 2);
ok('배선: 막힌 뒤의 글은 안 쥔다(쥐는 자리가 한도 분기 뒤)',
  src.indexOf("this.logger.info('막힌 뒤의 Claude 글을 올리지 않습니다')") < src.indexOf('if (isDM) replyBuf.text('));
ok('배선: 옛 길(받자마자 noteText 로 올림) 없음',
  !/if \(noteText\(labelSid, content, labelWant, text \|\| ''\) === 'post'\)/.test(src));

if (fails.length) {
  console.log(`FAIL ${fails.length}`);
  for (const f of fails) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('PASS check:interim — DM 은 마지막 답만, 중간 글은 버림');
