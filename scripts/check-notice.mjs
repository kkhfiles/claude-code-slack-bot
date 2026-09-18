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

const { LetterNotice, coffeeKinds } = await import('../dist/letter-notice.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-notice-'));
const logPath = path.join(dir, 'notice.jsonl');
const pendingPath = path.join(dir, 'notice-pending.json');
let fail = 0;
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) { fail++; if (detail) console.log(`      ${String(detail).slice(0, 300)}`); }
};

const agendaPath = path.join(dir, 'agenda.md');
// 실제 커피콩 갈래 그대로 — 전할 말은 general·bot_test, 안건은 커피챗·bot_test·general.
const KINDS = coffeeKinds({ general: 'C_GENERAL', chat: 'C_CHAT', test: 'C_TEST' }, { agenda: agendaPath });
const make = (extra = {}) => new LetterNotice({
  managerUserId: 'UBOSS', members: ['U_HGD', 'U_CS'], kinds: KINDS, logPath, pendingPath, ...extra,
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
    users: { info: async ({ user }) => ({ user: { profile: { real_name: user === 'U_HGD' ? '홍길동' : '김철수', display_name: '' } } }) },
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
  ok('올릴 방이 없으면 꺼진다', make({ kinds: coffeeKinds({}) }).enabled === false);
  ok('방이 빠진 갈래는 그 갈래만 꺼진다 (general 없음 → 전할 말은 시험 방으로만)',
    coffeeKinds({ test: 'C_TEST' }).notice.rooms.map((r) => r.label).join() === 'bot_test'
    && coffeeKinds({ test: 'C_TEST' }).agenda.rooms.map((r) => r.label).join() === 'bot_test');
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
  const submit = async (client, user, to, text, id = btn.value, kind = 'notice', handlers = app) => {
    const acks = [];
    await handlers.views.notice_confirm({
      ack: async (a) => { acks.push(a); }, client,
      body: { user: { id: user }, view: { private_metadata: JSON.stringify({ id, kind }) } },
      view: { state: { values: { to: { to: { selected_option: to ? { value: to } : undefined } },
                                 body: { body: { value: text } } } } },
    });
    return acks;
  };
  c = fakeClient();
  await submit(c, 'UBOSS', 'C_TEST', '내일 회의 10시로 옮깁니다', btn.value, '');
  ok('갈래를 모르면 안 나간다 (창이 갈래를 잃어버린 경우)',
    c.posted.every((m) => m.channel !== 'C_TEST') && n.pendingCount() === 1, c.posted);
  c = fakeClient();
  await submit(c, 'UBOSS', 'C_CHAT', '내일 회의 10시로 옮깁니다');
  ok('전할 말은 커피챗 방으로 못 간다 (그 갈래의 방 목록에 없다)',
    c.posted.every((m) => m.channel !== 'C_CHAT') && n.pendingCount() === 1, c.posted);
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
  ok('카드는 한 번 쓰는 표다 — 거절돼도 닫힌다', n.pendingCount() === 0);
  c = fakeClient();
  await submit(c, 'UBOSS', 'C_GENERAL', EDITED, btn2.value);
  ok('닫힌 카드로는 다른 방으로도 못 보낸다 (제출 때 카드를 다시 본다)',
    !c.posted.some((m) => m.channel === 'C_GENERAL') && c.posted.some((m) => String(m.text).includes('만료됐거나 이미 처리')), c.posted);
  c = fakeClient();
  await n.offer(c, [{ name: 'notice', text: EDITED }], { user: 'UBOSS', channel: 'DM' });
  const btn2b = buttonOf(c.posted[c.posted.length - 1]);
  c = fakeClient();
  await submit(c, 'UBOSS', 'C_GENERAL', EDITED, btn2b.value);
  ok('새 카드로는 다른 방으로 나간다', c.posted.some((m) => m.channel === 'C_GENERAL'));

  // ── 제출 때 카드를 다시 본다 — 갈래가 다르거나 · 없거나 · 시각이 깨졌으면 안 나간다 ──
  c = fakeClient();
  await n.offer(c, [{ name: 'notice', text: '갈래 대조용 글입니다' }], { user: 'UBOSS', channel: 'DM' });
  const btnK = buttonOf(c.posted[0]);
  c = fakeClient();
  await submit(c, 'UBOSS', 'C_TEST', '갈래 대조용 글입니다', btnK.value, 'agenda');
  ok('창의 갈래가 카드와 다르면 안 나간다', c.posted.every((m) => m.channel !== 'C_TEST') && c.posted.some((m) => String(m.text).includes('만료됐거나')));
  ok('갈래가 다른 제출은 카드도 지운다 (한 번 쓰는 표)', n.pendingCount() === 0);
  c = fakeClient();
  await submit(c, 'UBOSS', 'C_TEST', '아무 글', 'no-such-id');
  ok('없는 카드로는 안 나간다', c.posted.every((m) => m.channel !== 'C_TEST'));
  c = fakeClient();
  await n.offer(c, [{ name: 'notice', text: '시각 깨진 카드' }], { user: 'UBOSS', channel: 'DM' });
  const btnN = buttonOf(c.posted[0]);
  n['pending'].get(btnN.value).at = 'not-a-date';
  c = fakeClient();
  await submit(c, 'UBOSS', 'C_TEST', '시각 깨진 카드', btnN.value);
  ok('시각이 깨진 카드는 만료로 본다 (영영 살아 있지 않게)', c.posted.every((m) => m.channel !== 'C_TEST') && n.pendingCount() === 0);
  // 창을 둘 열어 같이 누르면 둘째는 걸린다
  c = fakeClient();
  await n.offer(c, [{ name: 'notice', text: '두 번 누른 글' }], { user: 'UBOSS', channel: 'DM' });
  const btnD = buttonOf(c.posted[0]);
  c = fakeClient();
  await Promise.all([submit(c, 'UBOSS', 'C_TEST', '두 번 누른 글', btnD.value), submit(c, 'UBOSS', 'C_TEST', '두 번 누른 글', btnD.value)]);
  ok('같은 카드를 동시에 두 번 제출해도 한 번만 나간다', c.posted.filter((m) => m.channel === 'C_TEST').length === 1, c.posted.filter((m) => m.channel === 'C_TEST').length);

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
    body: { user: { id: 'UBOSS' }, view: { private_metadata: JSON.stringify({ id: btn4.value, kind: 'notice' }) } },
    view: { state: { values: { to: { to: { selected_option: { value: 'C_GENERAL' } } },
                               body: { body: { value: '점심 12시' } } } } },
  });
  ok('못 올렸을 수 있으면 방을 확인하라 알리고 카드는 닫는다 (다시 눌러 두 번 올리지 않게)',
    c.posted.some((m) => String(m.text).includes('방을 먼저 확인')) && n2.pendingCount() === 0, c.posted);
  ok('기록은 올리기 전에 남아 같은 글은 10분 안에 다시 안 나간다',
    fs.existsSync(path.join(dir, 'other.jsonl')) && fs.readFileSync(path.join(dir, 'other.jsonl'), 'utf-8').includes('"to":"C_GENERAL"'));

  // ── 안건 던지기 — 커피콩이 쓴 초안 · 머리말 없음 · 커피챗 방이 먼저 · 던진 것을 기억 ──
  const na = make({ logPath: path.join(dir, 'agenda.jsonl'), pendingPath: path.join(dir, 'agenda-pending.json') });
  const appA = fakeApp();
  na.register(appA);
  c = fakeClient();
  await na.offer(c, [{ name: 'agenda', text: '요즘 커피챗 어떠셨어요? 한 줄씩만 남겨 주세요!' }],
    { user: 'UBOSS', channel: 'DM' });
  ok('안건도 카드는 실장 DM 으로만 간다', c.posted.length === 1 && c.posted[0].channel === 'DM_UBOSS', c.posted);
  ok('카드에 커피콩이 쓴 초안임을 밝힌다', JSON.stringify(c.posted[0].blocks).includes('초안'));
  const btnA = buttonOf(c.posted[0]);
  c = fakeClient();
  await appA.actions.notice_open({
    ack: async () => {}, client: c,
    body: { user: { id: 'UBOSS' }, trigger_id: 'ta', actions: [{ value: btnA.value }] },
  });
  const viewA = c.opened[0].view;
  const toA = viewA.blocks.find((b) => b.block_id === 'to');
  ok('안건 창은 커피챗 방이 먼저, 시험 방·general 순',
    toA.element.options.map((o) => o.value).join(',') === 'C_CHAT,C_TEST,C_GENERAL', toA.element.options);
  ok('안건 창은 갈래를 들고 간다', JSON.parse(viewA.private_metadata).kind === 'agenda');
  ok('안건 창의 안내는 머리말이 없다고 말한다', String(viewA.blocks[1].hint.text).includes('머리말 없음'));

  c = fakeClient();
  const AGENDA = '요즘 커피챗 어떠셨어요? 이번 주에 한 번씩만 남겨 볼까요?';
  await submit(c, 'UBOSS', 'C_CHAT', AGENDA, btnA.value, 'agenda', appA);
  const outA = c.posted.find((m) => m.channel === 'C_CHAT');
  ok('안건은 커피챗 방에 오른다', Boolean(outA), c.posted);
  ok('안건은 머리말 없이 커피콩 말로 그대로 나간다', outA && outA.text === AGENDA, outA && outA.text);
  ok('던진 안건을 파일에 적는다 (봇이 매 턴 보는 파일)',
    fs.existsSync(agendaPath) && fs.readFileSync(agendaPath, 'utf-8').includes(AGENDA)
    && fs.readFileSync(agendaPath, 'utf-8').includes('커피챗 방'), fs.existsSync(agendaPath) && fs.readFileSync(agendaPath, 'utf-8'));
  ok('기록에 갈래가 남는다', fs.readFileSync(path.join(dir, 'agenda.jsonl'), 'utf-8').includes('"kind":"agenda"'));

  // 안건은 최근 셋만 기억한다 — 매 턴 붙는 글이라 길어지면 대화 값을 먹는다.
  for (const w of ['하나', '둘', '셋']) {
    c = fakeClient();
    await na.offer(c, [{ name: 'agenda', text: `안건 ${w}째 이야기` }], { user: 'UBOSS', channel: 'DM' });
    const b = buttonOf(c.posted[0]);
    ok(`안건 ${w} 카드가 만들어진다`, Boolean(b), c.posted);
    c = fakeClient();
    await submit(c, 'UBOSS', 'C_CHAT', `안건 ${w}째 이야기`, b.value, 'agenda', appA);
  }
  const mem = fs.readFileSync(agendaPath, 'utf-8');
  ok('최근 셋만 남고 가장 새 것이 맨 위다',
    (mem.match(/^## /gm) || []).length === 3 && mem.indexOf('안건 셋째') < mem.indexOf('안건 둘째') && !mem.includes(AGENDA), mem);
  // 시험 방·general 로 보낸 글은 기억 파일에 안 적힌다 — 그 파일은 모든 턴에 붙는다.
  c = fakeClient();
  await na.offer(c, [{ name: 'agenda', text: '시험 방에만 보낸 안건' }], { user: 'UBOSS', channel: 'DM' });
  const bT = buttonOf(c.posted[0]);
  c = fakeClient();
  await submit(c, 'UBOSS', 'C_TEST', '시험 방에만 보낸 안건', bT.value, 'agenda', appA);
  ok('시험 방에 보낸 글은 기억 파일에 안 적힌다 (다른 방에서 되풀이되지 않게)',
    c.posted.some((m) => m.channel === 'C_TEST') && !fs.readFileSync(agendaPath, 'utf-8').includes('시험 방에만'));

  // ── 봇이 쓴 갈래의 빗장 — 카드 전과 보내기 직전 둘 다 ─────────────────────────
  for (const [why, text] of [['멘션', '<@U_HGD> 어떠세요?'], ['이름(성 뗀 것)', '길동님 이번 주 어떠셨어요?'], ['이름', '김철수 님 고마워요'],
                             ['집계', '세 분만 남기셨어요'], ['비율', '참여율이 27%네요'], ['숫자', '3개 팀이 모여요']]) {
    c = fakeClient();
    await na.offer(c, [{ name: 'agenda', text }], { user: 'UBOSS', channel: 'DM' });
    ok(`봇이 쓴 글에 ${why}이(가) 들어가면 카드를 안 만들고 까닭을 알린다`,
      !c.posted.some((m) => buttonOf(m)) && c.posted.some((m) => String(m.text).includes('빗장')), c.posted);
  }
  c = fakeClient();
  await na.offer(c, [{ name: 'agenda', text: '1on1 은 10시 반에도 돼요. 9/22 에 봬요!' }], { user: 'UBOSS', channel: 'DM' });
  ok('시각·날짜·1on1 의 숫자는 둔다', c.posted.some((m) => buttonOf(m)), c.posted);
  const bG = buttonOf(c.posted[0]);
  c = fakeClient();
  await submit(c, 'UBOSS', 'C_CHAT', '1on1 은 10시 반에도 돼요. 길동님도요!', bG.value, 'agenda', appA);   // 창에서 이름을 넣었다
  ok('실장이 창에서 이름을 넣어도 보내기 직전 빗장이 막는다',
    c.posted.every((m) => m.channel !== 'C_CHAT') && c.posted.some((m) => String(m.text).includes('빗장')), c.posted);
  ok('막힌 뒤 카드는 닫혀 있다', na.pendingCount() === 0);
  c = fakeClient();
  await n.offer(c, [{ name: 'notice', text: '길동님 생일 축하해요! 세 분 모여요' }], { user: 'UBOSS', channel: 'DM' });
  ok('실장 말 그대로인 전할 말에는 이름·숫자 빗장을 안 건다', c.posted.some((m) => buttonOf(m)), c.posted);
  // 이름을 못 받아 오면 막는다 — 이름을 아직 안 받아 둔 새 인스턴스에서
  const nb = make({ logPath: path.join(dir, 'nb.jsonl'), pendingPath: path.join(dir, 'nb-pending.json') });
  nb.register(fakeApp());
  c = fakeClient();
  c.users.info = async () => { throw new Error('ratelimited'); };
  await nb.offer(c, [{ name: 'agenda', text: '요즘 어떠세요?' }], { user: 'UBOSS', channel: 'DM' });
  ok('실원 이름을 못 받아 오면 봇이 쓴 글은 막는다 (못 본 채 통과시키지 않는다)',
    !c.posted.some((m) => buttonOf(m)) && c.posted.some((m) => String(m.text).includes('못 받아 옴')), c.posted);

  ok('전할 말은 안건 파일에 안 적힌다',
    !fs.readFileSync(agendaPath, 'utf-8').includes('회의 10시'));

  // ── 아침 말 걸기(`pulse`) — 안건과 같은 관문·같은 기억 파일, 방은 커피챗·bot_test 만 ──
  c = fakeClient();
  await na.offer(c, [{ name: 'pulse', text: '좋은 아침이에요! 이번 주 고마웠던 순간 하나씩 나눠 볼까요?' }],
    { user: 'UBOSS', channel: 'DM' });
  ok('아침 말 걸기도 카드는 실장 DM 으로만', c.posted.length === 1 && c.posted[0].channel === 'DM_UBOSS');
  ok('카드에 아침 현황을 보고 쓴 글임을 밝힌다', JSON.stringify(c.posted[0].blocks).includes('아침 현황'));
  const btnP = buttonOf(c.posted[0]);
  c = fakeClient();
  await appA.actions.notice_open({
    ack: async () => {}, client: c,
    body: { user: { id: 'UBOSS' }, trigger_id: 'tp', actions: [{ value: btnP.value }] },
  });
  const viewP = c.opened[0].view;
  ok('아침 말 걸기 창은 커피챗·bot_test 만 (general 없음)',
    viewP.blocks.find((b) => b.block_id === 'to').element.options.map((o) => o.value).join(',') === 'C_CHAT,C_TEST');
  c = fakeClient();
  await submit(c, 'UBOSS', 'C_CHAT', '좋은 아침이에요! 이번 주 고마웠던 순간 하나씩 나눠 볼까요?', btnP.value, 'pulse', appA);
  const outP = c.posted.find((m) => m.channel === 'C_CHAT');
  ok('머리말 없이 커피콩 말로 나간다', outP && outP.text.startsWith('좋은 아침이에요!'), outP);
  ok('올린 글이 기억 파일에 적힌다 (다음 턴에 자기가 한 말을 안다)',
    fs.readFileSync(agendaPath, 'utf-8').includes('고마웠던 순간'));
  ok('기록에 갈래 pulse 가 남는다 (현황판이 「먼저 올린 글」로 센다)',
    fs.readFileSync(path.join(dir, 'agenda.jsonl'), 'utf-8').includes('"kind":"pulse"'));

  console.log(`\n${fail ? `실패 ${fail}건` : '모두 통과.'}`);
  fs.rmSync(dir, { recursive: true, force: true });
  process.exitCode = fail ? 1 : 0;
})();
