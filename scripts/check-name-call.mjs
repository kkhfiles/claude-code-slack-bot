/**
 * 「시험 방에서 이름으로 부른 말」 검사 — 주인이 멘션 없이 봇 이름을 넣어 시킨 말을 부른 말로 받나.
 *
 *   npm run check:namecall
 *
 * 왜 재나 — 시험 방에서 주인이 「소인아 … 물어보거나 해야 하지 않겠니?」「물어봐」라고 했는데 멘션이 없어 끼어들기 판단
 * 턴으로 갔고, 그 턴에는 다른 방에 글을 올리는 행동이 안 열려 봇은 말만 하고 아무 일도 안 했다(2026-10-20).
 * 그 모양 그대로 재고, 넓어지면 안 되는 곳도 같이 잰다:
 *   - 주인이 아닌 사람 · 이름이 없는 말 · 설정에 이름이 없는 봇 → 그대로(끼어들기 판단)
 *   - 사람들이 쓰는 방 — 주인이 이름을 넣은 말은 부른 말(2026-10-23) · 이름 없는 이어 받기는 시험 방에만
 *   - 멘션은 지금처럼 누구든 부른 말
 */
import './lib/fresh-dist.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'namecall-'));
process.env.BOT_ACTIVITY_DIR = path.join(tmp, 'activity');

const { ChatHost } = await import('../dist/chat-host.js');

let pass = 0;
const fails = [];
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log(`PASS ${name}`); return; }
  fails.push(name);
  console.log(`FAIL ${name}`);
  if (detail !== undefined) console.log(`     ${JSON.stringify(detail)}`);
};

const ME = 'UTESTBOT';
const MGR = 'U_MGR';
const TEST = 'C_TEST';   // 시험 방(rules)
const PLAY = 'C_PLAY';   // 사람들이 쓰는 방

function profileFor(cfg) {
  const root = path.join(tmp, `p${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(path.join(root, 'bots', 'lunch'), { recursive: true });
  fs.writeFileSync(path.join(root, 'bots', 'lunch', 'config.json'), JSON.stringify(cfg), 'utf-8');
  fs.mkdirSync(path.join(root, 'bots', 'letter'), { recursive: true });
  fs.writeFileSync(path.join(root, 'bots', 'letter', 'config.json'), JSON.stringify({ call_names: ['커피콩', '콩아'] }), 'utf-8');
  return path.join(root, 'turn.py');
}

function make(cfg) {
  const host = new ChatHost({
    name: 'lunch', botToken: '', appToken: '', python: '', script: profileFor(cfg),
    surfaces: ['channel', 'dm'], channels: [TEST, PLAY], managerUserId: MGR,
    buttIn: { quietMinutes: 0, dailyCap: 0 },        // 끼어들기 한도 0 — 부른 말만 지나간다
  });
  host['selfUserId'] = ME;
  return host;
}

const ON = { call_names: ['소인'], rooms: { [TEST]: { rules: true }, [PLAY]: {} } };
const host = make(ON);
for (const [name, ch, user, text, want] of [
  ['시험 방 · 주인 · 이름 — 부른 말(오늘 장면)', TEST, MGR, '소인아 해피런치 예약 가능 여부와 언제 나갈지 물어봐야 하지 않겠니?', true],
  ['멘션은 누구든 부른 말', PLAY, 'U2', `<@${ME}> 점심 뭐야`, true],
  ['시험 방이라도 주인이 아니면 이름만으로는 안 부른 것', TEST, 'U2', '소인아 물어봐', false],
  // 2026-10-23 주인 — 사람들이 쓰는 방에서 「소인 … 준비해야 하지 않을까?」라고 하면 나서서 진행하게
  ['사람들이 쓰는 방에서도 주인이 이름을 넣으면 부른 말', PLAY, MGR, '소인 실데이 준비해야하지 않을까?', true],
  ['사람들이 쓰는 방에서 주인이 아닌 사람이 이름을 넣으면 안 부른 것', PLAY, 'U2', '소인 실데이 준비해야하지 않을까?', false],
  ['이름이 없는 말은 안 부른 것(커피콩에게 한 말에 같이 안 답하게)', TEST, MGR, '콩아 공지 올려', false],
]) {
  check(name, host['isCalledIn'](ch, user, text) === want, { ch, user, text });
}
check('설정에 이름이 없는 봇은 이름으로 안 불림',
  make({ rooms: { [TEST]: { rules: true } } })['isCalledIn'](TEST, MGR, '소인아 물어봐') === false);

// 이어 받기 — 오늘 둘째 말 「물어봐」에는 이름이 없었다
{
  const h = make(ON);
  check('봇이 말한 적 없으면 이름 없는 주인 말은 안 부른 것', h['isCalledIn'](TEST, MGR, '물어봐') === false);
  h['lastSpoke'].set(TEST, Date.now() - 60 * 1000);
  check('봇이 방금(10분 안) 말했으면 이름 없는 주인 말도 이 봇에게 한 말(오늘 「물어봐」)',
    h['isCalledIn'](TEST, MGR, '물어봐') === true);
  check('이어 받기도 시험 방 · 주인만', h['isCalledIn'](TEST, 'U2', '물어봐') === false
    && (h['lastSpoke'].set(PLAY, Date.now()), h['isCalledIn'](PLAY, MGR, '물어봐')) === false);
  // 2026-10-20 — 「@커피콩 넌 지금은 신경 안써도 돼」를 소인이 1분 전에 말했다는 이유로 제 말로 받아 답했다
  check('다른 봇을 멘션한 말은 이어 받지 않는다(그쪽에 한 말)',
    h['isCalledIn'](TEST, MGR, '<@ULETTERBOT> 넌 지금은 신경 안써도 돼') === false);
  check('다른 봇 이름을 부른 말도 이어 받지 않는다', h['isCalledIn'](TEST, MGR, '콩아 넌 신경 안 써도 돼') === false);
  check('내 멘션과 남의 멘션이 같이 있으면 부른 말', h['isCalledIn'](TEST, MGR, `<@${ME}> <@ULETTERBOT> 둘이 정리해`) === true);
  h['siblingSpoke'].set(TEST, Date.now());
  check('그 뒤 형제 봇이 끼었으면 이어 받지 않는다(그 봇에게 한 말일 수 있다)', h['isCalledIn'](TEST, MGR, '물어봐') === false);
  h['siblingSpoke'].delete(TEST);
  h['lastSpoke'].set(TEST, Date.now() - 11 * 60 * 1000);
  check('10분이 지나면 이어 받지 않는다', h['isCalledIn'](TEST, MGR, '물어봐') === false);
}

// 살아 있는 길 — 부른 말이면 끼어들기 한도(0)에 안 걸리고 「부른 턴」으로 띄운다
{
  const kicked = [];
  const h = make(ON);
  h['kick'] = (_c, _k, _ch, forced) => kicked.push(forced);
  const client = { users: { info: async () => ({ user: { profile: { display_name: '실장' } } }) } };
  await h['onChannelMessage'](client, MGR, TEST, '100.1', undefined, '물어봐 소인아');
  await h['onChannelMessage'](client, 'U2', TEST, '100.2', undefined, '소인아 물어봐');
  check('살아 있는 길 — 시험 방 주인이 이름으로 부르면 부른 턴으로 띄우고, 한도 0에서 다른 사람 말은 버린다',
    JSON.stringify(kicked) === JSON.stringify([true]), kicked);
}

// 2026-10-30 시험 방 — 실장이 소인을 불러 결정을 알리고(소인 답) 8분 뒤 이름 없이 「이 내용 노는거 채널에 공유해줘」. 커피콩이
// 끼어들기 턴으로 「제가 준비해 둘게요」라고 답했고, 두 봇이 인사를 세 번 주고받았다. 커피콩 자리에서 그 모양 그대로 잰다.
{
  const kicked = [];
  const h = make({ call_names: ['커피콩'], rooms: { [TEST]: { rules: true }, [PLAY]: {} } });
  h['opts'].buttIn = { quietMinutes: 0, dailyCap: 10 };   // 끼어들기가 열린 상태 — 막는 것은 차례 규칙뿐이어야 한다
  h['kick'] = (_c, _k, _ch, forced) => kicked.push(forced);
  const client = { users: { info: async () => ({ user: { profile: { display_name: '실장' } } }) } };
  h['siblingSpoke'].set(TEST, Date.now() - 8 * 60 * 1000);     // 소인이 8분 전에 답했다 · 커피콩은 그 뒤로 말 안 함
  await h['onChannelMessage'](client, MGR, TEST, '200.1', undefined, '이 내용 노는거 채널에 공유해줘');
  check('시험 방 — 형제 봇이 방금 답한 뒤의 이름 없는 실장 말에는 끼어들지 않는다(그 봇 차례)', kicked.length === 0, kicked);
  await h['onChannelMessage'](client, MGR, TEST, '200.2', undefined, '커피콩 이건 네가 해');
  check('시험 방 — 그래도 이름으로 부르면 받는다', JSON.stringify(kicked) === JSON.stringify([true]), kicked);
  h['siblingSpoke'].delete(TEST);
  kicked.length = 0;
  await h['onChannelMessage'](client, MGR, TEST, '200.3', undefined, '이 내용 노는거 채널에 공유해줘');
  check('시험 방에서는 형제 봇이 안 끼었어도 먼저 끼어들지 않는다 (부른 말만)', kicked.length === 0, kicked);
  await h['onChannelMessage'](client, MGR, PLAY, '200.4', undefined, '이 내용 노는거 채널에 공유해줘');
  check('사람들이 쓰는 방의 끼어들기는 그대로 열린다(넓게 막지 않았나)', JSON.stringify(kicked) === JSON.stringify([false]), kicked);
  // 판정이 「내게 한 말(2)」이라 해도 — 시험 방에서 남을 부른 말 · 남의 차례인 말은 부른 말이 아니다
  h['judgeOn'] = () => true;
  h['judged'].set(`${TEST}:300.1`, Promise.resolve(2));
  h['judged'].set(`${TEST}:300.2`, Promise.resolve(2));
  h['judged'].set(`${TEST}:300.3`, Promise.resolve(2));
  check('시험 방 — 소인을 멘션한 실장 말은 판정이 2여도 커피콩이 안 받는다',
    await h['calledBy'](TEST, MGR, '300.1', '<@ULUNCHBOT> 실데이 회의에서 확정한 내용 공유함') === false);
  h['siblingSpoke'].set(TEST, Date.now() - 60 * 1000);
  check('시험 방 — 소인이 방금 답한 뒤의 이름 없는 지시는 판정이 2여도 커피콩이 안 받는다',
    await h['calledBy'](TEST, MGR, '300.2', '이 내용 노는거 채널에 공유해줘') === false);
  check('시험 방 — 그때도 커피콩 이름을 넣으면 받는다', await h['calledBy'](TEST, MGR, '300.3', '커피콩 이건 네가 공유해') === true);
  h['siblingSpoke'].delete(TEST);
  h['judged'].set(`${TEST}:300.4`, Promise.resolve(2));
  check('시험 방 — 남의 차례가 아니면 판정 2는 그대로 부른 말', await h['calledBy'](TEST, MGR, '300.4', '이 내용 공유해줘') === true);
  h['siblingSpoke'].set(TEST, Date.now());
  h['lastSpoke'].set(TEST, Date.now() + 1);
  check('내가 형제 봇보다 나중에 말했으면 차례 규칙은 안 막는다', h['othersTurn'](TEST) === false);
  h['siblingSpoke'].set(PLAY, Date.now());
  check('사람들이 쓰는 방에는 차례 규칙을 안 건다', h['othersTurn'](PLAY) === false);
  h['siblingSpoke'].set(TEST, Date.now() - 11 * 60 * 1000);
  h['lastSpoke'].delete(TEST);
  check('형제 봇이 말한 지 10분이 지나면 차례 규칙은 풀린다', h['othersTurn'](TEST) === false);
}
// 형제 봇 말 — 시험 방에서는 나를 부를 때만 받는다(소인의 「…준비해 둘게요」류 답에 맞장구친 줄을 막는다)
{
  const h = make({ call_names: ['소인'], rooms: { [TEST]: { rules: true }, [PLAY]: {} } });
  check('나를 부르는 글 — 이름이나 멘션', h['namesMe']('소인님 혹시 같이 보실래요?') && h['namesMe'](`<@${ME}> 봐 주세요`)
    && !h['namesMe']('네, 규황님! 노는거 채널에 공유하실 수 있게 바로 준비해 둘게요.'));
  check('시험 방 판정', h['isRulesRoom'](TEST) === true && h['isRulesRoom'](PLAY) === false);
  const src = fs.readFileSync(new URL('../src/chat-host.ts', import.meta.url), 'utf-8');
  const at = src.indexOf('if (fromSibling) say = this.botTalkTurn(channel, text);');
  check('형제 봇 말을 받기 전에 시험 방에서는 나를 부르는지 본다 (봇끼리 세기 전에)',
    at > 0 && src.slice(Math.max(0, at - 400), at).includes('fromSibling && this.isRulesRoom(channel) && !this.namesMe(text)) return;'));
}
// 후속(카드 없이 올리는 말) — 방이 먼저 말 걸지 말라고 한 상태면 안 돌고, 돌 때는 상주 turn.py 로(재검토 2026-10-30)
{
  const h = make({ call_names: ['소인'], rooms: { [TEST]: { rules: true }, [PLAY]: {} } });
  const ran = [];
  h['runTurn'] = async (key, _n, _t, decide, manager, extra) => { ran.push({ key, decide, manager, extra }); return { reply: '다시 여쭈옵니다', error: null }; };
  h['runTurnOnce'] = async () => { ran.push({ once: true }); return { reply: '', error: null }; };
  const f = { room: PLAY, title: '실데이', q: '가고 싶은 곳' };
  const r1 = await h.follow(f);
  check('후속은 상주 turn.py 로 그 방 턴(실원 · 판단 꼴)으로 돈다', r1.reply === '다시 여쭈옵니다' && ran.length === 1 && ran[0].key === PLAY
    && ran[0].decide === true && ran[0].manager === false && ran[0].extra.follow === f, ran);
  for (const [why, set] of [['「그만」', () => h['buttInHushed'].add(PLAY)], ['「대답하지 마」', () => h['hushed'].add(PLAY)],
    ['방금 조용히', () => h['noReplyAt'].set(PLAY, Date.now())]]) {
    h['buttInHushed'].clear(); h['hushed'].clear(); h['noReplyAt'].clear();
    set();
    ran.length = 0;
    const r = await h.follow(f);
    check(`후속 — ${why} 뒤에는 안 돈다`, r.speak === false && ran.length === 0, { r, ran });
  }
  h['buttInHushed'].clear(); h['hushed'].clear(); h['noReplyAt'].clear();
  h['opts'].quietRooms = [PLAY];
  ran.length = 0;
  check('후속 — 부르면 답하는 방(조용한 방)에서는 안 돈다', (await h.follow(f)).speak === false && ran.length === 0);
  check('맡지 않은 방은 안 돈다', (await h.follow({ ...f, room: 'C_ELSE' })).error === '맡은 방이 아님');
  check('실장 턴 요청에는 실장 ID 가 따로 실린다 (채널 턴은 user 가 비어 온다)',
    h['turnBody'](TEST, '실장', '말', false, true).manager === MGR && h['turnBody'](TEST, '누구', '말', false, false).manager === undefined);
}

console.log('');
console.log(`통과 ${pass} / 실패 ${fails.length}`);
if (fails.length) { console.log(fails.map((f) => `  - ${f}`).join('\n')); process.exit(1); }
