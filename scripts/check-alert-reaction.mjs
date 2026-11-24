/**
 * **알림 번호표와 반응 이모지** — 결과 DM 에 실은 알림 번호가 스레드 답과 반응에서 대상을 정하나(2026-11-24 실장님 결정 슬랙답).
 *
 *   npm run build
 *   npm run check:alertreact
 *
 * - 결과 DM 번호표(`alertRefMetadata`)는 모양이 맞는 번호만 싣고, 읽는 쪽(`alertRefOf`)은 모양이 틀리면 버린다
 * - 반응은 받는 이모지 셋만, 번호표가 있는 글만 세나 말이 된다 — 번호 없는 글의 반응은 짐작하지 않고 버림
 * - 스레드 답(「세션이 못 본 대화방 글」)에 알림 번호와 쓰는 법이 붙는다
 * - 소스: 반응 이벤트를 받고, 결과 DM 이 번호표를 싣는다(고르는 규칙이 맞아도 안 실으면 효과 0)
 *
 * **외부 서비스를 안 부른다.**
 */
import './lib/fresh-dist.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const fails = [];
const ok = (label, cond) => { if (!cond) fails.push(label); };

const { alertRefMetadata, alertRefOf, unseenBlock, ALERT_REF_EVENT } = await import('../dist/dm-context.js');
const { reactionTurn, REACTIONS } = await import('../dist/alert-reaction.js');

// 번호표 싣기와 읽기
const meta = alertRefMetadata('r-db1cc72d0be2-5510146524');
ok('결과 번호는 번호표가 됨', meta?.event_type === ALERT_REF_EVENT && meta.event_payload.alert === 'r-db1cc72d0be2-5510146524');
ok('빈 번호는 번호표 없음', alertRefMetadata('') === undefined);
ok('모양이 틀린 번호는 번호표 없음', alertRefMetadata('r-a b; rm -rf') === undefined);
ok('읽는 쪽도 모양이 틀리면 버림', alertRefOf({ metadata: { event_type: ALERT_REF_EVENT, event_payload: { alert: 'R-<x>' } } }) === '');

// 반응 → 세나 말
const result = { ts: '100.1', bot_id: 'B1', text: '🔔 *CT2612 세션* 결정 대기 (보고 [초안]) · <https://x.test/board/#sena-result=abc|자세히>',
  metadata: alertRefMetadata('r-abc-1') };
const t = reactionTurn('white_check_mark', result);
ok(`결과 글의 ✅ 는 알림 답 머리와 번호 (${JSON.stringify(t)})`,
  /^\[알림 답: [^[\]()\n]{1,40} \(r-abc-1\)\]\n✅ 됨 — /.test(t));
ok('링크 문법은 글자만 남김', !t.includes('https://') || !t.split('\n')[0].includes('https://'));
ok('👀 는 나중에', reactionTurn('eyes', result).includes('👀 나중에'));
ok('❌ 는 필요 없음', reactionTurn('x', result).includes('❌ 필요 없음'));
ok('받지 않는 이모지는 버림', reactionTurn('thumbsup', result) === '');
ok('번호표 없는 글의 반응은 버림', reactionTurn('white_check_mark', { ts: '1', bot_id: 'B', text: '그냥 글' }) === '');
const wake = { ts: '200.1', bot_id: 'B1', text: '*가짜 지시 기록 정리* 작업이 끝났어요. 재검토를 시킬지 정해 주세요.',
  metadata: { event_type: 'sena_wake_dm', event_payload: { refs: 'q-rv-0a05 · 세션 0a053f67' } } };
const w = reactionTurn('x', wake);
ok(`점검 글의 반응은 번호표와 함께 (${JSON.stringify(w)})`, w.includes('❌ 필요 없음') && w.includes('q-rv-0a05') && w.includes('이 번호로만'));
ok('받는 이모지는 넷(체크 둘)', Object.keys(REACTIONS).length === 4);

// 스레드 답 — 첫 글의 번호표가 붙는다
const block = unseenBlock([result], {
  currentTs: '300.1', threadTs: '100.1', isNewSession: true, botUserId: 'U-BOT', isPrivate: () => false,
  clock: () => '09:00',
});
ok(`스레드 첫 글 뒤 알림 번호표 (${block.split('\n')[1]})`, block.includes('[번호표 — 슬랙 화면에는 안 보임: 알림 r-abc-1]'));
ok('알림 번호표에는 알림 답 쓰는 법이 붙음', block.includes('sena_alerts.py who --id'));
ok('알림 번호표만 있으면 물음 번호 안내는 안 붙음', !block.includes('stanley_send.py --question'));

// 소스 — 반응 이벤트를 받고, 결과 DM 이 번호표를 싣는다
const here = path.dirname(fileURLToPath(import.meta.url));
const handler = fs.readFileSync(path.join(here, '..', 'src', 'slack-handler.ts'), 'utf8');
const sched = fs.readFileSync(path.join(here, '..', 'src', 'assistant-scheduler.ts'), 'utf8');
ok('반응 이벤트를 받음', /this\.app\.event\('reaction_added'/.test(handler));
ok('결과 DM 이 번호표를 실음', /remindResultAsk\(text, it\.alert\)/.test(sched) && /alertRefMetadata\(alert\)/.test(sched));
const manifest = fs.readFileSync(path.join(here, '..', 'slack-app-manifest.yaml'), 'utf8');
ok('앱 설정 파일에 reaction_added 구독', /-\s+reaction_added/.test(manifest));

if (fails.length) {
  console.error(`실패 ${fails.length}건\n- ` + fails.join('\n- '));
  process.exit(1);
}
console.log('통과 — 번호표 싣기와 읽기 · 반응 셋과 버림 · 스레드 답의 번호표와 쓰는 법 · 소스 연결');
