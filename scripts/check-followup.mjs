/**
 * 먼저 말 꺼내기(후속) 한 바퀴(`ChatHost.followupSweep`)를 슬랙·모델 없이 센다.
 *
 *     npm run check:followup   (dist 가 낡았으면 멈춘다)
 *
 * 실장(2026-09-24) 「먼저 말 꺼내기 전에 내게 DM 으로 확인받기」. 보는 것 — 평일 창 안에서만 돎 ·
 * 기한 조회는 모델 없는 `ask: due` · **맡은 방만** 후속 턴 · 후속 턴의 글은 **방에 안 올리고 `onAsk`(실장 DM
 * 카드)로만** · 겹쳐 안 돎 · 한 번 넘어져도 다음 바퀴는 돎 · 멈추면 시계가 풀림.
 */
import './lib/fresh-dist.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'followup-'));
process.env.BOT_ACTIVITY_DIR = path.join(tmp, 'activity');

const { ChatHost } = await import('../dist/chat-host.js');

let fail = 0;
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) { fail++; if (detail) console.log(`      ${String(detail).slice(0, 300)}`); }
};

const PLAY = 'C_PLAY';
const RULE = { everyMin: 60, start: '10:00', end: '17:00' };
// 2026-09-24 은 목요일 · 09-26 은 토요일.
const THU = (h, m = 0) => new Date(2026, 8, 24, h, m);
const SAT = new Date(2026, 8, 26, 11, 0);
const ASK = [{ name: 'followup-lunch', text: '팀데이 날짜를 이번 주에 정해 볼까요?', room: PLAY, why: '팀데이' }];

// 가짜 호스트 — 파이썬 대신 `runTurn` 을 갈아 끼우고, 방에 올린 것은 `posted` 에 모은다.
function make({ onAsk = true, due = [{ key: PLAY, titles: ['팀데이'] }, { key: 'C_OTHER', titles: ['남의 방 일'] }],
                reply = { reply: '', error: null, ask: ASK }, turn } = {}) {
  const asked = [];
  const calls = [];
  const posted = [];
  const host = new ChatHost({
    name: 'lunch', botToken: '', appToken: '', python: '', script: path.join(tmp, 'turn.py'),
    surfaces: ['channel'], channels: [PLAY],
    followup: RULE,
    onAsk: onAsk ? async (_c, asks, from) => { asked.push({ asks, from }); } : undefined,
  });
  host['app'] = { client: { chat: { postMessage: async (m) => { posted.push(m); return { ts: '1' }; } } } };
  host['runTurn'] = turn ?? (async (key, name, text, decide, manager, extra) => {
    calls.push({ key, name, text, decide, manager, extra });
    if (extra.ask === 'due') return { reply: '', error: null, due };
    return reply;
  });
  return { host, asked, calls, posted };
}

// ── 창 밖이면 안 돈다 ────────────────────────────────────────────────────
{
  const { host, calls } = make();
  const n = [await host.followupSweep(SAT), await host.followupSweep(THU(9, 59)), await host.followupSweep(THU(17, 0))];
  ok('토요일 · 10시 전 · 17시부터는 안 돈다 (파이썬도 안 부름)', n.every((x) => x === 0) && calls.length === 0, JSON.stringify(calls));
}
{
  const { host, calls } = make({ onAsk: false });
  ok('카드 창구(onAsk)가 없으면 안 돈다 — 방에 바로 올릴 길이 없다',
    (await host.followupSweep(THU(11))) === 0 && calls.length === 0);
}

// ── 창 안 — 조회 → 맡은 방만 후속 턴 → 실장 DM 카드 ─────────────────────────
{
  const { host, asked, calls, posted } = make();
  const n = await host.followupSweep(THU(10, 0));
  ok('10시 정각부터 돈다 · 카드 한 장', n === 1, n);
  ok('처음은 모델 없는 기한 조회(`ask: due`)', calls[0]?.extra.ask === 'due' && calls[0]?.key === '', JSON.stringify(calls[0]));
  const fu = calls.filter((c) => c.extra.followup);
  ok('후속 턴은 맡은 방에만 (남의 방은 조회에 나와도 안 돌림)', fu.length === 1 && fu[0].key === PLAY, JSON.stringify(fu));
  ok('후속 턴은 실장 턴이 아니고 정하기 턴도 아님', fu[0] && fu[0].manager === false && fu[0].decide === false, JSON.stringify(fu[0]));
  ok('글은 실장 DM 카드(onAsk)로만 — 말한 사람 없음 · 그 방',
    asked.length === 1 && asked[0].from.user === '' && asked[0].from.channel === PLAY && asked[0].asks[0].room === PLAY,
    JSON.stringify(asked));
  ok('방에는 아무것도 안 올린다', posted.length === 0, JSON.stringify(posted));
}
{
  const { host, asked } = make({ reply: { reply: '', error: null } });
  ok('후속 턴이 꺼낼 말이 없으면 카드도 없다', (await host.followupSweep(THU(14))) === 0 && asked.length === 0);
}
{
  const { host, calls } = make({ due: [] });
  ok('기한 지난 일이 없으면 후속 턴을 안 돌린다', (await host.followupSweep(THU(14))) === 0 && calls.length === 1);
}

// ── 겹쳐 안 돎 · 넘어져도 다음 바퀴 ─────────────────────────────────────────
{
  let release;
  const gate = new Promise((r) => { release = r; });
  let dueCalls = 0;
  const { host } = make({
    turn: async (_k, _n, _t, _d, _m, extra) => {
      if (extra.ask === 'due') { dueCalls++; await gate; return { reply: '', error: null, due: [] }; }
      return { reply: '', error: null };
    },
  });
  const first = host.followupSweep(THU(11));
  const second = await host.followupSweep(THU(11));
  release();
  await first;
  ok('앞 바퀴가 도는 중이면 다음 바퀴는 건너뛴다 (조회 한 번)', second === 0 && dueCalls === 1, dueCalls);
}
{
  let n = 0;
  const { host, asked } = make({
    turn: async (_k, _n, _t, _d, _m, extra) => {
      if (extra.ask === 'due' && ++n === 1) throw new Error('파이썬 넘어짐');
      if (extra.ask === 'due') return { reply: '', error: null, due: [{ key: PLAY, titles: ['팀데이'] }] };
      return { reply: '', error: null, ask: ASK };
    },
  });
  let threw = false;
  try { await host.followupSweep(THU(11)); } catch { threw = true; }
  const again = await host.followupSweep(THU(12));
  ok('한 번 넘어져도 두 번째 바퀴는 돈다 (겹침 표시가 풀림)', threw && again === 1 && asked.length === 1, `${threw} ${again}`);
}

// ── 멈추면 시계가 풀린다 ───────────────────────────────────────────────────
{
  const { host } = make();
  host['app'] = null;
  host['followTimer'] = setInterval(() => {}, 3_600_000);
  await host.stop();
  ok('stop() 이 후속 시계를 푼다 (다시 켤 때 둘이 되지 않게)', host['followTimer'] === null);
}

console.log(`\n${fail ? `실패 ${fail}건` : '모두 통과.'}`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exitCode = fail ? 1 : 0;
