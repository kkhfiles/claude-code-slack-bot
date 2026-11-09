/**
 * 브리핑 「⚠️ 시스템 이슈」 줄이기(2026-11-09 실장 결정 V4) — 한도 오류 원문은 「Claude 한도 N번」, 폴백 기록은
 * 「다른 엔진이 대신 처리 N건」 한 줄. 그 밖의 출처는 그대로. 입력은 11/09 아침 브리핑에 실제로 실린 줄.
 */
import './lib/fresh-dist.mjs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { summarizeIssues } = require(path.join(ROOT, 'dist', 'issue-summary.js'));

const fails = [];
const ok = (name, cond) => { if (!cond) fails.push(name); };
const eq = (name, a, b) => ok(`${name} — ${JSON.stringify(a)}`, JSON.stringify(a) === JSON.stringify(b));

const nov9 = [
  { source: 'SdkHandler', messages: [
    "SDK query 실패: Claude Code returned an error result: You've hit your 5-hour limit · resets 11am (Asia/Seoul)",
    "SDK query 실패: Claude Code returned an error result: You've hit your weekly limit · resets Nov 9, 10am (Asia/Seoul)",
  ] },
  { source: '폴백', messages: [
    '분석 — Claude claude-blocked → codex gpt-6.1-terra workspace-write 가 받음',
    '처리 제안 정밀 검토 — Claude claude-blocked → codex gpt-6.1-sol workspace-write 가 받음',
    '아침 브리핑 — Claude claude-blocked → codex gpt-6.1-terra read-only 가 받음',
    'KG 추출 50건(codex gpt-6.1-terra 50)',
    '메일 공유성 라벨 1건(codex gpt-6-astra 1)',
  ] },
];
const s = summarizeIssues(nov9);
eq('11/09 — 두 줄로', s, [
  { source: 'Claude 한도', messages: ['2번 걸림'] },
  { source: '폴백', messages: ['다른 엔진이 대신 처리 54건(GPT 54)'] },
]);

const mixed = summarizeIssues([
  { source: '처리 제안', messages: ['요약을 못 읽음 — rc 1'] },
  { source: '폴백', messages: ['분석 — Claude usage · codex 도 한도라 폴백 안 함', '배치 3건(agy flash 1 · 전부 실패 2)'] },
]);
eq('다른 출처는 그대로 · 넘긴 것과 못 넘긴 것', mixed, [
  { source: '폴백', messages: ['다른 엔진이 대신 처리 1건(agy 1) · 못 넘김 3건'] },
  { source: '처리 제안', messages: ['요약을 못 읽음 — rc 1'] },
]);
eq('한도 줄만 있던 출처는 사라지고 한도 한 줄', summarizeIssues([{ source: 'CLI', messages: ["You've hit your session limit"] }]),
  [{ source: 'Claude 한도', messages: ['1번 걸림'] }]);
eq('빈 입력', summarizeIssues([]), []);

if (fails.length) {
  console.error(`실패 ${fails.length}건\n`);
  for (const f of fails) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log('통과 — 시스템 이슈 줄이기(한도 원문은 횟수 한 줄 · 폴백은 대신 처리 건수 한 줄 · 그 밖 출처는 그대로)');
