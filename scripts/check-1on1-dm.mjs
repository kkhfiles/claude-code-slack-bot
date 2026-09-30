/**
 * 커피콩이 넘긴 DM 을 「1on1 신청으로 올리기」 버튼으로 신청에 올리는 길을 슬랙 없이 확인한다.
 *
 *     npm run build && npm run check:1on1dm
 *
 * **왜 있나** — 2026-09-30 에 실원이 신청을 `/1on1` 이 아니라 커피콩 DM 으로 보냈고, 그 말은
 * 실장 DM 으로 넘어갔지만 기록에 안 남아 `/1on1-list` 가 비어 있었다. 그래서 넘길 때 버튼을
 * 붙였다.
 *
 * **가장 먼저 지킬 것은 개인정보다**(실장 2026-09-30 「DM 이나 콩에게 전달한 말이 타인이나 채널에
 * 공유되면 절대 안 됨」). 그래서 여기서는 버튼이 붙는지보다 **보낸 말이 실장 DM 말고 어디에도
 * 안 실리는지**를 먼저 센다 — 본인에게 가는 알림에도 다시 싣지 않는다.
 *
 * 기록 파일은 임시 폴더에만 쓴다 — 운영 기록을 절대 건드리지 않는다.
 */
import './lib/fresh-dist.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ChatHost } = await import('../dist/chat-host.js');
const { LetterBooking } = require('../dist/letter-booking.js');

const BOSS = 'UBOSS';
const MEMBER = 'UMEMBER';
const OUTSIDER = 'UOUT';
const SECRET = '면담 요청드려요 (둘만 아는 사정)';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'check-1on1-dm-'));
const log = path.join(tmp, '1on1.jsonl');

let fail = 0;
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !extra ? '' : ` — ${extra}`}`);
  if (!cond) fail++;
};

/** 보낸 것을 전부 적는 가짜 슬랙. DM 채널 이름이 곧 받는 사람이다(`D-<사람>`). */
function fakeClient({ failBlocksOnce = false } = {}) {
  const calls = [];
  let blocksFailed = false;
  return {
    calls,
    conversations: { open: async ({ users }) => ({ channel: { id: `D-${users}` } }) },
    users: { info: async ({ user }) => ({ user: { profile: { real_name: user === MEMBER ? '가나다' : user } } }) },
    chat: {
      postMessage: async (a) => {
        if (failBlocksOnce && a.blocks && !blocksFailed) {
          blocksFailed = true;
          throw new Error('invalid_blocks');
        }
        calls.push({ kind: 'post', ...a });
        return { ok: true, ts: '1.1' };
      },
      update: async (a) => { calls.push({ kind: 'update', ...a }); return { ok: true }; },
    },
  };
}

/** 이 호출이 싣고 간 글 전부(글 칸 + 블록 + 버튼 값). */
const carried = (c) => JSON.stringify({ text: c.text, blocks: c.blocks ?? [] });

const makeBooking = (extra = {}) => new LetterBooking({
  managerUserId: BOSS, members: [MEMBER], logPath: log, nudgePath: path.join(tmp, 'nudge.json'), open: true, ...extra,
});

function makeHost(bypassBlocks) {
  const root = path.join(tmp, 'letter');
  fs.mkdirSync(path.join(root, 'bots', 'letter'), { recursive: true });
  fs.writeFileSync(path.join(root, 'bots', 'letter', 'config.json'), '{}', 'utf-8');
  const host = new ChatHost({
    name: 'letter', botToken: '', appToken: '', python: '', script: path.join(root, 'turn.py'),
    surfaces: ['dm'], allowUsers: [BOSS], managerUserId: BOSS, bypassBlocks,
  });
  host['loadProfile']();
  return host;
}

// ── 1. 버튼이 붙는 사람 ────────────────────────────────────────────────────
{
  const b = makeBooking();
  ok('신청할 수 있는 실원의 말에는 버튼이 붙는다', Array.isArray(b.dmBlocks(MEMBER, SECRET)));
  ok('명단 밖 사람의 말에는 안 붙는다', b.dmBlocks(OUTSIDER, SECRET) === undefined);
  ok('실장 자신에게는 안 붙는다', b.dmBlocks(BOSS, SECRET) === undefined);
  ok('창구를 안 열었으면 실원에게도 안 붙는다', makeBooking({ open: false }).dmBlocks(MEMBER, SECRET) === undefined);
  const btn = b.dmBlocks(MEMBER, SECRET).flatMap((x) => x.elements ?? []).find((e) => e.type === 'button');
  ok('버튼에는 누르기 전 확인 창이 있다', !!btn?.confirm);
  ok('버튼 값은 슬랙 한도(2,000자) 안이다',
    btn.value.length <= 2000 && makeBooking().dmBlocks(MEMBER, '가'.repeat(5000))
      .flatMap((x) => x.elements ?? []).find((e) => e.type === 'button').value.length <= 2000);
}

// ── 2. 넘기기 — 보낸 말은 실장 DM 에만 ───────────────────────────────────
{
  const b = makeBooking();
  const host = makeHost(b.dmBlocks);
  const client = fakeClient();
  await host['bypassToManager'](client, MEMBER, `D-${MEMBER}`, SECRET);
  const toBoss = client.calls.filter((c) => c.channel === `D-${BOSS}`);
  const elsewhere = client.calls.filter((c) => c.channel !== `D-${BOSS}` && carried(c).includes('둘만 아는'));
  ok('넘긴 글이 실장 DM 에 간다', toBoss.length === 1 && carried(toBoss[0]).includes('둘만 아는'));
  ok('⛔ 보낸 말은 실장 DM 말고 어디에도 안 실린다', elsewhere.length === 0,
    elsewhere.map((c) => c.channel).join(', '));
  ok('본인에게는 받았다는 한 줄만 간다',
    client.calls.filter((c) => c.channel === `D-${MEMBER}`).every((c) => !carried(c).includes('둘만 아는')));
  ok('실장 DM 에 버튼이 붙는다', carried(toBoss[0]).includes('booking_from_dm'));
  ok('못 하는 일(한 사람에게 따로 전하기)을 약속하지 않는다', !carried(toBoss[0]).includes('맡기셔도'));
}

// ── 3. 버튼 없는 봇(소인 등)·명단 밖 사람은 예전처럼 글만 ────────────────────
{
  const host = makeHost(undefined);
  const client = fakeClient();
  await host['bypassToManager'](client, MEMBER, `D-${MEMBER}`, SECRET);
  const toBoss = client.calls.filter((c) => c.channel === `D-${BOSS}`);
  ok('버튼 없는 봇은 글만 넘긴다', toBoss.length === 1 && !toBoss[0].blocks);
  const host2 = makeHost(makeBooking().dmBlocks);
  const client2 = fakeClient();
  await host2['bypassToManager'](client2, OUTSIDER, `D-${OUTSIDER}`, SECRET);
  ok('명단 밖 사람의 말은 버튼 없이 넘어간다',
    client2.calls.filter((c) => c.channel === `D-${BOSS}`).every((c) => !c.blocks));
}

// ── 4. 블록이 안 받혀도 넘기기는 실패하지 않는다 ────────────────────────────
{
  const host = makeHost(makeBooking().dmBlocks);
  const client = fakeClient({ failBlocksOnce: true });
  await host['bypassToManager'](client, MEMBER, `D-${MEMBER}`, SECRET);
  const toBoss = client.calls.filter((c) => c.channel === `D-${BOSS}`);
  ok('버튼이 막혀도 글은 넘어간다', toBoss.length === 1 && carried(toBoss[0]).includes('둘만 아는'));
  ok('그때 본인에게 「못 넘겼다」가 안 간다',
    !client.calls.some((c) => c.channel === `D-${MEMBER}` && /못 만들겠/.test(c.text ?? '')));
}

// ── 5. 버튼 누르기 ─────────────────────────────────────────────────────────
{
  try { fs.unlinkSync(log); } catch {}
  const b = makeBooking();
  const handlers = {};
  const app = {
    command: () => {}, view: () => {},
    action: (sel, fn) => { handlers[typeof sel === 'string' ? sel : sel.action_id] = fn; },
  };
  b.register(app);
  if (b['nudgeTimer']) { clearInterval(b['nudgeTimer']); clearTimeout(b['nudgeTimer']); }
  // 넘긴 메시지의 시각 — **이번 달 안이어야** 한 달 한 번 검사가 어느 날 돌려도 같은 답을 낸다.
  const forwardedMs = Date.now() - 60_000;
  const press = async (user, client, value = { u: MEMBER, t: SECRET }) => {
    const blocks = [
      { type: 'section', text: { type: 'mrkdwn', text: '넘긴 글' } },
      ...b.dmBlocks(MEMBER, SECRET),
    ];
    await handlers.booking_from_dm({
      ack: async () => {}, client,
      body: {
        user: { id: user }, channel: { id: `D-${BOSS}` },
        message: { ts: (forwardedMs / 1000).toFixed(6), text: '넘긴 글', blocks },
        actions: [{ value: JSON.stringify(value) }],
      },
    });
  };

  const stranger = fakeClient();
  await press(MEMBER, stranger);
  ok('실장 말고 다른 사람이 누르면 아무 일도 없다', stranger.calls.length === 0 && makeBooking().pending().length === 0);

  const client = fakeClient();
  await press(BOSS, client);
  const list = makeBooking().pending();
  ok('누르면 목록에 한 건 뜬다', list.length === 1 && list[0].user === MEMBER);
  ok('보낸 말이 메모 칸에 남는다(실장 전용 칸)', list[0]?.note === SECRET);
  ok('신청 시각은 넘긴 메시지의 시각이다(누른 시각이 아님)',
    Math.abs(Date.parse(list[0]?.ts) - forwardedMs) < 5);
  const toMember = client.calls.filter((c) => c.channel === `D-${MEMBER}`);
  ok('본인에게 신청이 들어갔다고 알린다', toMember.length === 1 && /1on1 신청으로 받았습니다/.test(toMember[0].text));
  ok('⛔ 본인 알림에 보낸 말을 다시 싣지 않는다', toMember.every((c) => !carried(c).includes('둘만 아는')));
  ok('⛔ 실장 DM·본인 DM 말고는 아무 데도 안 보낸다',
    client.calls.every((c) => c.channel === `D-${BOSS}` || c.channel === `D-${MEMBER}`),
    client.calls.map((c) => c.channel).join(', '));
  const upd = client.calls.find((c) => c.kind === 'update');
  ok('버튼 자리가 결과 한 줄로 바뀐다',
    !!upd && !carried(upd).includes('booking_from_dm') && carried(upd).includes('목록에 올렸어요'));

  const again = fakeClient();
  await press(BOSS, again);
  ok('두 번 눌러도 한 건이다(한 달 한 번)', makeBooking().pending().length === 1);
  ok('두 번째는 이미 있다고만 말한다',
    again.calls.some((c) => c.kind === 'update' && carried(c).includes('이미 있어'))
    && !again.calls.some((c) => c.channel === `D-${MEMBER}`));

  const outsider = fakeClient();
  await press(BOSS, outsider, { u: OUTSIDER, t: SECRET });
  ok('명단 밖 사람은 실장이 눌러도 안 올라간다',
    makeBooking().pending().length === 1 && !outsider.calls.some((c) => c.channel === `D-${OUTSIDER}`));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(fail ? `\n실패 ${fail}건` : '\n전부 통과 — 넘긴 DM 을 1on1 신청으로');
process.exit(fail ? 1 : 0);
