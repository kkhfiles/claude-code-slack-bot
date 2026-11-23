/**
 * **세션이 못 본 대화방 글** — DM 차례 앞에 붙는 덩어리가 맞는 글을 고르나 (`src/dm-context.ts`).
 *
 *   npm run build
 *   npm run check:dmctx
 *
 * 실제로 틀렸던 두 모양을 그대로 재현한다(2026-10-13 봇 로그):
 *   - 08:56 메일 질문(08:15 봇 글)에 **스레드 댓글**로 「참고임」 → 빈 새 세션이 떠 질문을 몰랐다
 *   - 10:14 좁은 길이 ❓ 를 낸 24초 뒤 **최상위**로 「합칩시다」 → 세션은 그 ❓ 를 몰랐다
 * 그리고 막아야 할 것 — 세션이 이미 본 글을 다시 붙이기 · 개인 글 · 지금 보낸 말 자체.
 *
 * 마지막으로 소스에서 세션에 넘기는 글이 붙인 것인지 센다 — 고르는 규칙이 맞아도 세션에
 * 안 넘기면 효과가 0이다.
 *
 * **외부 서비스를 안 부른다** — 가짜 슬랙 클라이언트가 글 목록을 돌려준다.
 */
import './lib/fresh-dist.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const fails = [];
const ok = (label, cond) => { if (!cond) fails.push(label); };
const eq = (label, got, want) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    fails.push(`${label}\n    받음 ${JSON.stringify(got)}\n    기대 ${JSON.stringify(want)}`);
  }
};

const { unseenBlock, readUnseen, MAX_MSGS, READ_TIMEOUT_MS } = await import('../dist/dm-context.js');

const BOT = 'UBOT';
const ME = 'UOWNER';
const clock = (sec) => String(sec);
const base = { botUserId: BOT, isPrivate: () => false, clock };
const bot = (ts, text, extra = {}) => ({ ts: String(ts), bot_id: 'B1', user: BOT, text, ...extra });
const me = (ts, text, extra = {}) => ({ ts: String(ts), user: ME, text, ...extra });
const lines = (b) => b.split('\n').filter((l) => l.startsWith('- '));

// ── 스레드 댓글 · 새 세션 — 댓글을 단 글이 붙는다 ─────────────────────────
{
  const msgs = [bot(1000, '메일 한 건을 어떻게 처리할지 여쭙니다'), me(3400, '참고임')];
  const b = unseenBlock(msgs, { ...base, currentTs: '3400', threadTs: '1000', isNewSession: true });
  eq('스레드 첫 글 하나가 붙는다', lines(b).length, 1);
  ok('스레드 첫 글이라고 적힌다', /스레드 첫 글/.test(b) && /메일 한 건을/.test(b));
  ok('지금 보낸 말은 안 붙는다', !/참고임/.test(b));
  ok('사람 말 머리로 끝난다', b.endsWith('[사람 말]'));
}

// ── 스레드 댓글 · 이어받는 세션 — 첫 글은 이미 받았다 · 그 뒤 댓글만 ───────
{
  const msgs = [bot(1000, '첫 글'), me(1100, '앞 댓글'), bot(1200, '세션이 한 답'), bot(1500, '세션 밖 댓글'), me(1600, '지금')];
  const b = unseenBlock(msgs, { ...base, currentTs: '1600', threadTs: '1000', isNewSession: false, sinceSec: 1300 });
  eq('이어받는 스레드는 마지막 차례 뒤 글만', lines(b).map((l) => l.replace(/^- \d+ /, '')), ['세나: 세션 밖 댓글']);
}

// ── 최상위 · 세션 밖에서 나간 ❓ (10/13 10:14 모양) ────────────────────────
{
  const msgs = [
    bot(500, '메일 한 건을 어떻게 처리할지 여쭙니다'),   // 세션이 본 것(마지막 차례 전)
    me(600, '참고사항이라고..'),
    bot(610, '버림으로 기록했습니다'),
    bot(1017, '❓ 「업무 가」(TSK-7) — TSK-8 과 중복이면 이 카드를 취소할까요?'),
  ];
  const b = unseenBlock(msgs, { ...base, currentTs: '1041', isNewSession: false, sinceSec: 700 });
  eq('마지막 차례 뒤의 ❓ 하나만', lines(b).length, 1);
  ok('바로 위 글이 ❓', /「업무 가」/.test(lines(b).at(-1) ?? ''));
  ok('세션이 본 메일 대화는 안 붙는다', !/메일 한 건|버림으로/.test(b));
  ok('답으로 먼저 읽으라는 지시', /맨 아래 글\(바로 위\)에 대한 답으로 먼저 읽는다/.test(b));
}

// ── 세션 밖 글이 없으면 아무것도 안 붙인다 ─────────────────────────────────
eq('붙일 것 없으면 빈 문자열',
  unseenBlock([bot(500, '세션이 한 답'), me(900, '지금')], { ...base, currentTs: '900', isNewSession: false, sinceSec: 600 }), '');

// ── 사람이 세션 없이 처리한 짧은 갱신도 붙는다 · 누가 썼는지 갈린다 ──────────
{
  const msgs = [me(800, '1 완료'), bot(801, 'TSK-5 완료로 넘겼습니다')];
  const b = unseenBlock(msgs, { ...base, currentTs: '900', isNewSession: false, sinceSec: 700 });
  eq('사람·세나를 가른다', lines(b).map((l) => l.split(':')[0].replace(/^- \d+ /, '')), ['사용자', '세나']);
}

// ── 개인 글은 빼고 뺐다는 사실만 ────────────────────────────────────────────
{
  const msgs = [bot(800, '넘겨 온 말 — 비밀 조각'), bot(801, '넛지 — 오늘 할 일')];
  const b = unseenBlock(msgs, { ...base, isPrivate: (t) => t.includes('비밀'), currentTs: '900', isNewSession: false, sinceSec: 700 });
  ok('개인 글은 안 실린다', !/비밀/.test(b));
  ok('뺐다는 줄', /개인 글이 든 1건은 뺐다/.test(b));
  ok('나머지는 실린다', /넛지/.test(b));
}

// ── 지금 보낸 말 뒤의 글 · 부속 글 · 빈 글은 안 실린다 ────────────────────────
{
  const msgs = [bot(800, '앞 글'), bot(950, '뒤에 온 글'), { ts: '850', subtype: 'message_deleted', text: '지운 것' }, bot(860, '   ')];
  const b = unseenBlock(msgs, { ...base, currentTs: '900', isNewSession: false, sinceSec: 700 });
  eq('앞 글 하나만', lines(b).length, 1);
}

// ── 많으면 최근 것만 · 스레드 첫 글은 늘 남긴다 ─────────────────────────────
{
  const msgs = [bot(100, '첫 글')];
  for (let i = 0; i < 12; i += 1) msgs.push(bot(200 + i, `댓글 ${i}`));
  const b = unseenBlock(msgs, { ...base, currentTs: '999', threadTs: '100', isNewSession: true });
  eq('상한까지', lines(b).length, MAX_MSGS);
  ok('첫 글이 맨 위에 남는다', /첫 글/.test(lines(b)[0]));
  ok('맨 아래는 가장 최근 댓글', /댓글 11/.test(lines(b).at(-1)));
}

// ── 세나 각성 번호표 — 11/23 16:01 실제 글(번호 없음)에 실장님이 「작업이 남았다면 컴팩트 후 이어가도록」 ─────
//    DM 세션은 번호가 없어 이름이 비슷한 다른 작업 트리 세션을 골랐다. 번호표가 글 옆에 붙고 안내 줄이 따라와야 한다
{
  const wake = '*업무 비서 마무리 작업*(작업 트리에서 도는 세션)의 컨텍스트가 70%를 넘었어요. 더 차기 전에 precompact로 정리하고 압축하라고 보낼까요?';
  const meta = { event_type: 'sena_wake_dm', event_payload: { refs: '「*업무 비서 마무리 작업*(작업 트리에서」 → q-cx-1123-51d4e76d1f83(세션 51d4e76d)' } };
  const b = unseenBlock([bot(1000, wake + ' 아주 긴 덧말'.repeat(60), { metadata: meta }), me(1100, '작업이 남았다면 컴팩트 후 이어가도록 명령할 것')],
    { ...base, currentTs: '1100', isNewSession: false, sinceSec: 900 });
  ok('세나 글 옆에 물음 번호와 세션이 붙는다(글이 잘려도)', /q-cx-1123-51d4e76d1f83\(세션 51d4e76d\)\]$/.test(lines(b)[0]));
  ok('번호로만 대상을 정하라는 안내가 붙는다', /이 번호로만 정한다/.test(b) && /--question/.test(b));
  const forged = unseenBlock([me(1000, '사람이 쓴 글', { metadata: meta })], { ...base, currentTs: '1100', isNewSession: false, sinceSec: 900 });
  ok('사람 글에 붙은 표시 정보는 안 믿는다', !/q-cx/.test(forged) && !/이 번호로만/.test(forged));
  const other = unseenBlock([bot(1000, '넛지', { metadata: { event_type: 'other', event_payload: { refs: 'q-x' } } })],
    { ...base, currentTs: '1100', isNewSession: false, sinceSec: 900 });
  ok('다른 이름의 표시 정보는 안 붙는다', !/q-x/.test(other) && !/번호표/.test(other));
  // 11/23 재검토 — 밀린 요청을 다시 돌리는 길에도 쓰는 법이 붙고, 긴 번호표는 줄 경계에서 잘린다
  const framed = unseenBlock([bot(1000, wake, { metadata: meta })],
    { ...base, currentTs: '1100', isNewSession: false, sinceSec: 900, frame: { header: '[머리]', footer: ['[꼬리]'] } });
  ok('frame 길에도 번호 안내가 붙는다', /이 번호로만 정한다/.test(framed) && framed.endsWith('[꼬리]'));
  const many = Array.from({ length: 30 }, (_, i) => `「항목 ${i} ${"가".repeat(60)}」 → q-rv-${String(i).padStart(12, '0')}-000000(세션 ${String(i).padStart(8, 'a')})`);
  const long = unseenBlock([bot(1000, '여러 건', { metadata: { event_type: 'sena_wake_dm', event_payload: { refs: many.join('\n') } } })],
    { ...base, currentTs: '1100', isNewSession: false, sinceSec: 900 });
  const shownRefs = (lines(long)[0].match(/q-rv-[0-9]+-000000\(세션 [0-9a]+\)/g) ?? []);
  ok('긴 번호표는 줄 경계에서 잘린다 — 실린 번호는 다 온전함',
    shownRefs.length > 0 && shownRefs.length < 30 && shownRefs.every((r, i) => r === many[i].split(' → ')[1])
      && (lines(long)[0].match(/「항목 /g) ?? []).length === shownRefs.length);   // 반쯤 잘린 항목이 안 남음
}

// ── 슬랙 읽기 — 스레드면 replies · 아니면 history · 실패·지연은 빈 문자열 ────
{
  const calls = [];
  const meta = [];
  const client = {
    conversations: {
      replies: async (a) => { calls.push(['replies', a.ts]); meta.push(a.include_all_metadata); return { messages: [bot(1000, '스레드 첫 글'), me(1100, '지금')] }; },
      history: async (a) => { calls.push(['history', a.oldest, a.latest, a.inclusive]); meta.push(a.include_all_metadata); return { messages: [bot(1050, '넛지')] }; },
    },
  };
  const t = await readUnseen(client, 'D1', { currentTs: '1100', threadTs: '1000', isNewSession: true, botUserId: BOT, isPrivate: () => false });
  ok('스레드는 replies 로 읽는다', calls[0]?.[0] === 'replies' && /스레드 첫 글/.test(t));
  const h = await readUnseen(client, 'D1', { currentTs: '1100', isNewSession: false, sinceSec: 1000, botUserId: BOT, isPrivate: () => false });
  eq('최상위는 마지막 차례부터 지금 말 전까지', calls[1], ['history', '1000', '1100', false]);
  ok('최상위 글이 붙는다', /넛지/.test(h));
  await readUnseen(client, 'D1', { currentTs: '50000', isNewSession: true, botUserId: BOT, isPrivate: () => false });
  eq('새 세션은 12시간 전부터', calls[2]?.[1], String(50000 - 12 * 3600));
  eq('읽을 때 표시 정보(번호표)를 같이 받는다', meta, [true, true, true]);

  const broken = { conversations: { replies: async () => { throw new Error('ratelimited'); }, history: async () => { throw new Error('x'); } } };
  eq('읽기가 실패하면 빈 문자열', await readUnseen(broken, 'D1', { currentTs: '1', threadTs: '0', isNewSession: true, botUserId: BOT, isPrivate: () => false }), '');
  const hang = { conversations: { replies: () => new Promise(() => {}), history: () => new Promise(() => {}) } };
  const t0 = Date.now();
  eq('늦으면 빈 문자열', await readUnseen(hang, 'D1', { currentTs: '1', isNewSession: true, botUserId: BOT, isPrivate: () => false }), '');
  ok(`늦어도 상한(${READ_TIMEOUT_MS}ms) 안에 돌아온다`, Date.now() - t0 < READ_TIMEOUT_MS + 1000);
}

// ── 세션에 넘기는 글이 붙인 것인가 — 소스에서 센다 ───────────────────────────
{
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, '..', 'src', 'slack-handler.ts'), 'utf-8');
  eq('SDK 세션에 붙인 글을 넘긴다', (src.match(/runQuery\(sessionPrompt,/g) ?? []).length, 1);
  eq('붙이기 전 글을 세션에 넘기는 곳이 없다', (src.match(/runQuery\(finalPrompt,/g) ?? []).length, 0);
  ok('봇이 스스로 넘긴 차례에는 안 붙인다', /isDM && !\(event as any\)\.pushed/.test(src));
}

if (fails.length) {
  console.error(`\n실패 ${fails.length}건\n\n  ✗ ${fails.join('\n\n  ✗ ')}\n`);
  process.exitCode = 1;
} else {
  console.log('통과 — 세션이 못 본 대화방 글 (스레드 댓글은 첫 글을 · 최상위는 마지막 차례 뒤 글을 · '
    + '이미 본 것·지금 말·개인 글은 빼고 · 최근 것과 첫 글을 남기고 · 실패·지연은 빈 문자열 · SDK 세션에 전달)');
}
