/**
 * 매일 개선 제안 — 메시지 모양 · 켜는 문 · 배선 (2026-10-02).
 *
 *   npm run build
 *   npm run check:improve
 *
 * **세션을 안 띄우고 슬랙에 안 보낸다.** 만드는 쪽(재료 · 검사 · 장부 · 업무 등록)은 work-assistant 의
 * `selftest` · `regress` 가 본다. 여기는 봇 쪽 셋을 본다.
 *   ① 메시지 — 버튼 셋 · 결정된 것은 버튼 대신 한 줄 · 0건이면 안 보냄 · 처리 제안의 `markDecided` 와 맞물림
 *   ② 켜는 문 — 기본 꺼짐. 꺼져 있으면 06:30 타이머를 안 걸고 브리핑에 안 붙인다
 *   ③ 배선 — 브리핑 셋이 다 붙임 · 버튼 갈래가 처리 제안과 다름 · 세션에 도구가 없음
 */
import './lib/fresh-dist.mjs';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
delete process.env.DAILY_IMPROVE;
const m = require(path.join(ROOT, 'dist', 'improve-message.js'));
const { markDecided } = require(path.join(ROOT, 'dist', 'action-pipeline.js'));

const fails = [];
const eq = (label, got, want) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    fails.push(`${label}\n    받음 ${JSON.stringify(got)}\n    기대 ${JSON.stringify(want)}`);
  }
};

const item = (n, state = 'proposed') => ({
  id: `P-20261005-${n}`, date: '2026-10-05', title: `제안 ${n} <꺾쇠>`, area: '성능',
  evidence: [{ label: '누름 → 화면 중앙값', value: '3500ms', compare: '7일 2900ms', key: 'board.press' }],
  why: '누른 뒤 3.5초 · 늘어남', next: '구간 나눠 재기', est: 1.5, state,
});

// ① 메시지
{
  const blocks = m.buildImproveBlocks({ date: '2026-10-05', posted: null, note: '첫날', items: [item(1), item(2, 'held')] });
  const acts = blocks.filter((b) => b.type === 'actions');
  eq('결정 전 제안만 버튼이 있다', acts.length, 1);
  eq('버튼 셋 — 등록 · 보류 · 폐기', acts[0].elements.map((e) => [e.action_id, e.text.text, e.value]),
     [['improve_register', '업무로 등록', 'P-20261005-1'], ['improve_hold', '보류', 'P-20261005-1'],
      ['improve_drop', '폐기', 'P-20261005-1']]);
  eq('결정된 제안은 한 줄', blocks.filter((b) => b.block_id === 'actd_P-20261005-2').length, 1);
  const text = m.improvePreviewText(blocks);
  eq('근거 줄에 사람이 읽는 이름 · 값 · 비교', text.includes('근거 — 누름 → 화면 중앙값 *3500ms* (7일 2900ms)'), true);
  eq('칸 경로(key)는 안 보인다', text.includes('board.press'), false);
  eq('제목의 꺾쇠를 걷는다(슬랙 링크 문법)', text.includes('<꺾쇠>'), false);
  eq('맨 아래에 한계 한 줄', text.trim().split('\n').pop().startsWith('첫날 · 처음 2주는 등록까지만'), true);
  const after = markDecided(blocks, 'P-20261005-1', '*업무로 등록 — TSK-120*');
  eq('누른 제안의 버튼 줄만 결과 한 줄로', after.filter((b) => b.type === 'actions').length, 0);
  eq('0건이면 아무것도 안 보낸다', m.buildImproveBlocks({ date: 'x', posted: null, note: '', items: [] }), null);
  eq('못 읽었으면 아무것도 안 보낸다', m.buildImproveBlocks(null), null);
}

// ② 켜는 문
{
  eq('기본은 꺼짐', m.improveEnabled(), false);
  process.env.DAILY_IMPROVE = 'on';
  eq('on 이면 켜짐', m.improveEnabled(), true);
  process.env.DAILY_IMPROVE = '1';
  eq('on 말고는 꺼짐', m.improveEnabled(), false);
  delete process.env.DAILY_IMPROVE;
}

// ③ 배선 — 소스를 대조한다(진짜로 돌리면 세션이 뜨고 슬랙에 나간다)
{
  const src = fs.readFileSync(path.join(ROOT, 'src', 'assistant-scheduler.ts'), 'utf-8');
  const fn = (name) => {
    const head = src.search(new RegExp(`(private |async |private async )+${name}\\(`));
    return head < 0 ? '' : src.slice(head, src.indexOf('\n  }\n', head));
  };
  eq('타이머는 켜는 문 뒤에서만 건다', /if \(improveEnabled\(\)\) this\.scheduleImprove\(\);/.test(fn('scheduleAll')), true);
  eq('브리핑에 붙이는 것도 켜는 문을 본다', /if \(!improveEnabled\(\)\) return null;/.test(fn('improveForBriefing')), true);
  eq('예약 · 놓친 브리핑 둘이 아침 제안을 붙인다', (src.match(/await this\.postMorningProposals\(\);/g) || []).length, 2);
  eq('올렸다는 표시는 보낸 뒤에', /sendMessage\('💡 개선 제안', blocks\);\s*await this\.markImprovePosted\(\);/.test(fn('postImproveDigest')), true);
  const run = fn('runImprove');
  eq('세션에 도구가 없다', /tools: \[\],\s*allowedTools: \[\],\s*settingSources: \[\],/.test(run), true);
  eq('구독 세션 sonnet · 사고 낮음', /const IMPROVE_MODEL = 'sonnet';\s*const IMPROVE_EFFORT = 'low' as const;/.test(src), true);
  eq('06:30', /const IMPROVE_TIME = '06:30';/.test(src), true);
  const sh = fs.readFileSync(path.join(ROOT, 'src', 'slack-handler.ts'), 'utf-8');
  eq('수동 브리핑도 붙인다', /improveForBriefing\(\)[\s\S]{0,200}markImprovePosted\(\)/.test(sh), true);
  eq('버튼 갈래가 처리 제안과 따로', /this\.action\(\/\^improve_\(register\|hold\|drop\)\$\//.test(sh), true);
  const trig = sh.slice(sh.indexOf("if (type === '@improve') {"), sh.indexOf('return done;'));
  eq('로컬 트리거는 DM 을 안 보낸다', trig.length > 30 && trig.length < 400 && !trig.includes('postMessage'), true);
}

if (fails.length) {
  console.log(`실패 ${fails.length}건\n`);
  for (const f of fails) console.log('  ✗ ' + f);
  process.exitCode = 1;
} else {
  console.log('통과 — 매일 개선 제안 (버튼 셋 · 결정된 것은 한 줄 · 사람이 읽는 근거 · 칸 경로 숨김 · 꺾쇠 걷음 · '
    + '0건이면 안 보냄 · 처리 제안 결과 줄과 맞물림 · 기본 꺼짐 · 타이머·브리핑 셋이 문 뒤 · 보낸 뒤 표시 · '
    + '도구 없는 sonnet 낮음 06:30 · 버튼 갈래 따로 · 트리거는 DM 없음)');
}
