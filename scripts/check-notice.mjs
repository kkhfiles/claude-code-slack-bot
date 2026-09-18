/**
 * 실장이 말로 시킨 「전해 줘」가 **버튼을 거쳐야만** 방에 오르는지 슬랙 없이 확인한다.
 *
 *     npm run check:notice   (dist 가 낡았으면 멈춘다)
 *
 * 보는 것 — 카드는 실장 DM 에만 · 실장 아닌 턴은 버림 · 버튼 → 창에 글이 그대로 · 창의 글이
 * 그대로 방에(머리말 한 줄만 붙음) · 같은 글 10분 안 두 번은 거절 · 재시작 뒤에도 카드가 살아
 * 있음. 기록 파일은 임시 폴더에만 쓴다 — 운영 기록을 절대 건드리지 않는다.
 */
import './lib/fresh-dist.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { LetterNotice } = await import('../dist/letter-notice.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-notice-'));
const logPath = path.join(dir, 'notice.jsonl');
const pendingPath = path.join(dir, 'notice-pending.json');
let fail = 0;
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) { fail++; if (detail) console.log(`      ${String(detail).slice(0, 300)}`); }
};

const ROOMS = [{ id: 'C_GENERAL', label: 'general' }, { id: 'C_TEST', label: 'bot_test' }];
const make = (extra = {}) => new LetterNotice({
  managerUserId: 'UBOSS', rooms: ROOMS, logPath, pendingPath, ...extra,
});

// 가짜 앱 — 핸들러를 모아 두고 검사에서 직접 부른다.
function fakeApp() {
  const actions = {}; const views = {};
  return {
    action: (id, fn) => { actions[id] = fn; },
    view: (id, fn) => { views[id] = fn; },
    actions, views,
  };
}
// 가짜 클라이언트 — 보낸 것을 전부 모은다.
function fakeClient() {
  const posted = []; const opened = [];
  return {
    posted, opened,
    conversations: { open: async ({ users }) => ({ channel: { id: `DM_${users}` } }) },
    chat: {
      postMessage: async (msg) => { posted.push(msg); return { ts: '1700000000.000100' }; },
      getPermalink: async () => ({ permalink: 'https://slack.example/p/1' }),
    },
    views: { open: async (v) => { opened.push(v); } },
  };
}
const buttonOf = (msg) => (msg.blocks || []).flatMap((b) => b.elements || []).find((e) => e.type === 'button');

(async () => {
  // ── 꺼짐 조건 ───────────────────────────────────────────────────────────
  ok('실장이 없으면 꺼진다', make({ managerUserId: '' }).enabled === false);
  ok('올릴 방이 없으면 꺼진다', make({ rooms: [] }).enabled === false);
  ok('둘 다 있으면 켜진다', make().enabled === true);

  // ── 카드 — 실장 DM 에만, 실장 턴에만 ──────────────────────────────────────
  const n = make();
  const app = fakeApp();
  n.register(app);
  ok('버튼과 창 핸들러가 걸린다', app.actions.notice_open && app.views.notice_confirm);

  let c = fakeClient();
  await n.offer(c, [{ name: 'notice', text: '내일 회의 10시' }], { user: 'UA', channel: 'C_CHAT' });
  ok('실장이 아닌 턴의 부탁은 버린다 (카드 없음)', c.posted.length === 0 && n.pendingCount() === 0);
  await n.offer(c, [{ name: 'notice', text: '내일 회의 10시' }], { user: '', channel: 'C_CHAT' });
  ok('여러 사람이 섞인 턴(사람 비어 옴)도 버린다', c.posted.length === 0);
  await n.offer(c, [{ name: 'wipe', text: '다 지워' }], { user: 'UBOSS', channel: 'DM' });
  ok('모르는 부탁은 버린다', c.posted.length === 0 && n.pendingCount() === 0);

  await n.offer(c, [{ name: 'notice', text: '내일 회의 10시로 옮깁니다' }], { user: 'UBOSS', channel: 'C_CHAT' });
  ok('실장 턴이면 카드를 띄운다', c.posted.length === 1);
  const card = c.posted[0];
  ok('카드는 실장 DM 으로 간다 (방으로 안 간다)', card.channel === 'DM_UBOSS', card.channel);
  ok('카드에 글이 보인다', JSON.stringify(card.blocks).includes('내일 회의 10시로 옮깁니다'));
  const btn = buttonOf(card);
  ok('카드에 「확인 창 열기」 버튼이 있다', btn && btn.action_id === 'notice_open' && btn.value, btn);
  ok('기다리는 카드 하나', n.pendingCount() === 1);
  ok('아직 방에는 아무것도 안 갔다', c.posted.every((m) => m.channel === 'DM_UBOSS'));

  // ── 버튼 → 창 ───────────────────────────────────────────────────────────
  c = fakeClient();
  await app.actions.notice_open({
    ack: async () => {}, client: c,
    body: { user: { id: 'UA' }, trigger_id: 't1', actions: [{ value: btn.value }] },
  });
  ok('실장이 아니면 버튼이 안 먹는다', c.opened.length === 0);
  await app.actions.notice_open({
    ack: async () => {}, client: c,
    body: { user: { id: 'UBOSS' }, trigger_id: 't1', actions: [{ value: 'no-such-id' }] },
  });
  ok('모르는 카드는 창을 안 열고 만료라고 알린다',
    c.opened.length === 0 && c.posted.some((m) => String(m.text).includes('만료')), c.posted);
  await app.actions.notice_open({
    ack: async () => {}, client: c,
    body: { user: { id: 'UBOSS' }, trigger_id: 't1', actions: [{ value: btn.value }] },
  });
  ok('실장이 누르면 창이 뜬다', c.opened.length === 1);
  const view = c.opened[0].view;
  const textBlock = (view.blocks || []).find((b) => b.block_id === 'body');
  const toBlock = (view.blocks || []).find((b) => b.block_id === 'to');
  ok('창의 글 칸에 카드의 글이 그대로 들어 있다',
    textBlock && textBlock.element.initial_value === '내일 회의 10시로 옮깁니다', textBlock);
  ok('창에서 방을 고른다 (general·bot_test)',
    toBlock && toBlock.element.options.map((o) => o.value).join(',') === 'C_GENERAL,C_TEST', toBlock);
  ok('창은 카드 ID 만 들고 간다 (글은 칸이 정본)',
    JSON.parse(view.private_metadata).id === btn.value && !view.private_metadata.includes('회의'));

  // ── 창 제출 = 보내기 ─────────────────────────────────────────────────────
  const submit = async (client, user, to, text, id = btn.value) => {
    const acks = [];
    await app.views.notice_confirm({
      ack: async (a) => { acks.push(a); }, client,
      body: { user: { id: user }, view: { private_metadata: JSON.stringify({ id }) } },
      view: { state: { values: { to: { to: { selected_option: to ? { value: to } : undefined } },
                                 body: { body: { value: text } } } } },
    });
    return acks;
  };
  c = fakeClient();
  let acks = await submit(c, 'UBOSS', '', '내일 회의 10시로 옮깁니다');
  ok('방을 안 고르면 안 나간다', acks[0].response_action === 'errors' && c.posted.length === 0);
  acks = await submit(c, 'UBOSS', 'C_TEST', '   ');
  ok('빈 글은 안 나간다', acks[0].response_action === 'errors' && c.posted.length === 0);
  acks = await submit(c, 'UA', 'C_TEST', '내일 회의 10시로 옮깁니다');
  ok('실장이 아니면 제출해도 안 나간다', c.posted.length === 0 && n.pendingCount() === 1);
  acks = await submit(c, 'UBOSS', 'C_ELSE', '내일 회의 10시로 옮깁니다');
  ok('목록에 없는 방으로는 안 나간다', c.posted.every((m) => m.channel !== 'C_ELSE') && n.pendingCount() === 1);

  c = fakeClient();
  const EDITED = '내일 회의 10시 반으로 옮깁니다. 자료는 오늘 안에 올려 주시면 고맙겠습니다.';   // 창에서 고쳤다 (30자 넘게)
  acks = await submit(c, 'UBOSS', 'C_TEST', EDITED);
  ok('창을 통째로 닫는다', acks[0].response_action === 'clear');
  const out = c.posted.find((m) => m.channel === 'C_TEST');
  ok('고른 방에 올라간다', Boolean(out), c.posted);
  ok('창의 칸에 있던 글이 그대로 나간다 (카드의 글이 아니라)',
    out && out.text.endsWith(EDITED), out && out.text);
  ok('머리말 한 줄만 붙는다', out && out.text.startsWith(':mega: *실장님 말씀을 전합니다*\n\n'), out && out.text);
  ok('실장에게 영수증이 간다 (링크 포함)',
    c.posted.some((m) => m.channel === 'DM_UBOSS' && String(m.text).includes('올렸습니다') && String(m.text).includes('slack.example')));
  ok('보낸 뒤 카드가 지워진다', n.pendingCount() === 0);
  const log = fs.readFileSync(logPath, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
  ok('기록에 방·글자 수·앞머리·지문이 남는다',
    log.length === 1 && log[0].to === 'C_TEST' && log[0].chars === EDITED.length && log[0].sha && log[0].head, JSON.stringify(log));
  ok('기록에 글 전체는 안 남는다 (앞머리 30자와 지문뿐)',
    log[0].head.length === 30 && !JSON.stringify(log[0]).includes('고맙겠습니다'), JSON.stringify(log[0]));

  // ── 같은 글 두 번 ─────────────────────────────────────────────────────────
  await n.offer(c, [{ name: 'notice', text: EDITED }], { user: 'UBOSS', channel: 'DM' });
  const btn2 = buttonOf(c.posted[c.posted.length - 1]);
  c = fakeClient();
  await submit(c, 'UBOSS', 'C_TEST', EDITED, btn2.value);
  ok('같은 글을 같은 방에 10분 안에 또 보내면 거절한다',
    !c.posted.some((m) => m.channel === 'C_TEST') && c.posted.some((m) => String(m.text).includes('다시 보내지 않았습니다')), c.posted);
  ok('거절한 카드는 남아 있다 (다른 방으로는 보낼 수 있게)', n.pendingCount() === 1);
  c = fakeClient();
  await submit(c, 'UBOSS', 'C_GENERAL', EDITED, btn2.value);
  ok('다른 방으로는 나간다', c.posted.some((m) => m.channel === 'C_GENERAL'));

  // ── 재시작 뒤에도 카드가 살아 있다 ────────────────────────────────────────
  c = fakeClient();
  await n.offer(c, [{ name: 'notice', text: '금요일 회식' }], { user: 'UBOSS', channel: 'DM' });
  const btn3 = buttonOf(c.posted[0]);
  const again = make();               // 새 프로세스처럼 파일에서 읽는다
  ok('안 보낸 카드는 파일에서 되살아난다', again.pendingCount() === 1);
  const app2 = fakeApp();
  again.register(app2);
  c = fakeClient();
  await app2.actions.notice_open({
    ack: async () => {}, client: c,
    body: { user: { id: 'UBOSS' }, trigger_id: 't2', actions: [{ value: btn3.value }] },
  });
  ok('되살아난 카드의 버튼이 먹는다', c.opened.length === 1 && c.opened[0].view.blocks[1].element.initial_value === '금요일 회식');

  // 만료 — 파일의 시각을 이틀 전으로 밀면 안 살아난다.
  const raw = JSON.parse(fs.readFileSync(pendingPath, 'utf-8'));
  for (const k of Object.keys(raw)) raw[k].at = new Date(Date.now() - 2 * 86400e3).toISOString();
  fs.writeFileSync(pendingPath, JSON.stringify(raw), 'utf-8');
  ok('하루 지난 카드는 되살아나지 않는다', make().pendingCount() === 0);

  // 떠 있는 프로세스 안에서 하루가 지난 카드 — 버튼을 눌러도 창이 안 뜬다.
  c = fakeClient();
  await again.offer(c, [{ name: 'notice', text: '오래된 카드' }], { user: 'UBOSS', channel: 'DM' });
  const btnOld = buttonOf(c.posted[0]);
  again['pending'].get(btnOld.value).at = new Date(Date.now() - 2 * 86400e3).toISOString();
  const before = again.pendingCount();
  c = fakeClient();
  await app2.actions.notice_open({
    ack: async () => {}, client: c,
    body: { user: { id: 'UBOSS' }, trigger_id: 't3', actions: [{ value: btnOld.value }] },
  });
  ok('하루 지난 카드는 눌러도 창이 안 뜨고 만료라고 알린다',
    c.opened.length === 0 && c.posted.some((m) => String(m.text).includes('만료')), c.posted);
  ok('만료된 카드는 그 자리에서 지워진다 (다른 카드는 그대로)', again.pendingCount() === before - 1);

  // ── 방에 못 올렸을 때 ─────────────────────────────────────────────────────
  const n2 = make({ logPath: path.join(dir, 'other.jsonl'), pendingPath: path.join(dir, 'other-pending.json') });
  const app3 = fakeApp();
  n2.register(app3);
  c = fakeClient();
  await n2.offer(c, [{ name: 'notice', text: '점심 12시' }], { user: 'UBOSS', channel: 'DM' });
  const btn4 = buttonOf(c.posted[0]);
  c = fakeClient();
  c.chat.postMessage = async (msg) => {
    if (msg.channel === 'C_GENERAL') throw new Error('not_in_channel');
    c.posted.push(msg); return { ts: '1' };
  };
  await app3.views.notice_confirm({
    ack: async () => {}, client: c,
    body: { user: { id: 'UBOSS' }, view: { private_metadata: JSON.stringify({ id: btn4.value }) } },
    view: { state: { values: { to: { to: { selected_option: { value: 'C_GENERAL' } } },
                               body: { body: { value: '점심 12시' } } } } },
  });
  ok('못 올리면 실장에게 알리고 카드를 남긴다',
    c.posted.some((m) => String(m.text).includes('올리지 못했습니다')) && n2.pendingCount() === 1, c.posted);

  console.log(`\n${fail ? `실패 ${fail}건` : '모두 통과.'}`);
  fs.rmSync(dir, { recursive: true, force: true });
  process.exitCode = fail ? 1 : 0;
})();
