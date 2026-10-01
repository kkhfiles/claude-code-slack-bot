/**
 * 판 알림 연결(`board-push.ts`) 자가 검사 — 가짜 소켓으로 돈다. 망을 안 탄다.
 *
 *   npm run build
 *   npm run check:push
 *
 * 실제 도메인·로컬 워커로 여는 것은 `check:board` 가 본다. 여기는 **끊기고 다시 붙는
 * 순서**를 본다 — 그쪽은 손으로 재현하기 어렵고, 틀려도 화면이 멀쩡해 보인다(알림이
 * 끊기면 안전망 주기로만 돌아 느려질 뿐 에러가 없다).
 *
 * 시간은 진짜로 흐른다 — 간격을 수십~수백 ms 로 줄여 넣어 전체가 5초 안에 끝난다.
 * **간격을 40ms 아래로 내리지 않는다** — Windows 타이머는 15.6ms 단위라 20ms 가 31ms 로 재진다.
 */
import './lib/fresh-dist.mjs';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { BoardPush } = require(path.join(ROOT, 'dist', 'board-push.js'));

const fails = [];
const eq = (label, got, want) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    fails.push(`${label}\n    받음 ${JSON.stringify(got)}\n    기대 ${JSON.stringify(want)}`);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 진짜 WebSocket 처럼 close() 의 onclose 는 다음 차례에 온다. */
class FakeSocket {
  constructor(url, headers) {
    this.url = url; this.headers = headers;
    this.readyState = 0; this.sent = []; this.closed = false;
    this.onopen = this.onmessage = this.onclose = this.onerror = null;
  }
  send(d) { this.sent.push(d); }
  close() {
    if (this.closed) return;
    this.closed = true; this.readyState = 3;
    setTimeout(() => this.onclose?.({ code: 1000 }), 0);
  }
  /* 시험이 부르는 쪽 */
  open() { this.readyState = 1; this.onopen?.(); }
  msg(d) { this.onmessage?.({ data: d }); }
  drop() { this.readyState = 3; this.closed = true; this.onclose?.({ code: 1006 }); }
}

function rig(over = {}) {
  const sockets = [];
  const made = [];
  const news = [];
  const t0 = Date.now();
  const push = new BoardPush({
    target: () => ({ url: 'wss://board.test/api/ws', headers: { 'CF-Access-Client-Id': 'x' } }),
    onNew: () => news.push(Date.now() - t0),
    socket: (url, headers) => { const s = new FakeSocket(url, headers); sockets.push(s); made.push(Date.now() - t0); return s; },
    pingMs: 120, pongGraceMs: 60, backoffMs: [40, 120, 300], authBackoffMs: 600,
    jitter: () => 0,
    ...over,
  });
  return { push, sockets, made, news, t0 };
}

// ① 붙자마자 한 번 가져간다 · 주소와 열쇠가 그대로 · 정상
{
  const { push, sockets, news } = rig();
  push.start();
  push.start(); // 두 번 불러도 연결은 하나
  eq('시작하면 소켓 하나', sockets.length, 1);
  eq('주소 그대로', sockets[0].url, 'wss://board.test/api/ws');
  eq('열쇠 헤더 그대로', sockets[0].headers['CF-Access-Client-Id'], 'x');
  eq('열리기 전에는 정상 아님', push.healthy(), false);
  sockets[0].open();
  eq('붙자마자 한 번 가져간다', news.length, 1);
  eq('열리면 정상', push.healthy(), true);
  sockets[0].msg('{"t":"new"}');
  eq('알림마다 가져간다', news.length, 2);
  sockets[0].msg('pong');
  sockets[0].msg('아무 말');
  eq('pong · 모르는 말은 안 가져간다', news.length, 2);
  push.stop();
  eq('멈추면 닫는다', sockets[0].closed, true);
  eq('멈추면 정상 아님', push.healthy(), false);
  await sleep(120);
  eq('멈춘 뒤에는 다시 안 붙는다', sockets.length, 1);
}

// ② 서버가 끊으면 다시 붙고, 다시 붙으면 또 한 번 가져간다 · 성공하면 간격이 처음으로
{
  const { push, sockets, news } = rig();
  push.start();
  sockets[0].open();
  sockets[0].drop();
  eq('끊기면 정상 아님', push.healthy(), false);
  await sleep(15);
  eq('간격 전에는 안 붙는다', sockets.length, 1);
  await sleep(60);
  eq('간격 뒤 다시 붙는다', sockets.length, 2);
  sockets[1].open();
  eq('다시 붙으면 또 가져간다(끊긴 사이 것)', news.length, 2);
  sockets[1].drop();
  await sleep(75);
  eq('성공 뒤 실패는 다시 첫 간격', sockets.length, 3);
  push.stop();
}

// ③ 잇달아 실패하면 간격이 는다 — 40 · 120 · 300 · 300(끝에서 멈춤)
{
  const { push, sockets, made } = rig();
  push.start();
  for (let i = 0; i < 4; i += 1) {
    const want = sockets.length + 1;
    sockets[sockets.length - 1].drop();
    for (let w = 0; w < 100 && sockets.length < want; w += 1) await sleep(5);
  }
  push.stop();
  const gaps = made.slice(1).map((t, i) => t - made[i]);
  const steps = gaps.map((g) => (g < 80 ? 40 : g < 210 ? 120 : 300));
  eq('잇단 실패 간격', steps, [40, 120, 300, 300]);
}

// ④ 옛 연결이 늦게 내는 신호는 버린다 — 세대 번호
{
  const { push, sockets, news } = rig();
  push.start();
  sockets[0].open();
  const old = sockets[0];
  old.drop();
  await sleep(70);
  sockets[1].open();
  const before = news.length;
  old.msg('{"t":"new"}');
  eq('옛 연결의 알림은 버린다', news.length, before);
  old.onclose?.({ code: 1006 });
  await sleep(100);
  eq('옛 연결의 close 로 또 붙지 않는다', sockets.length, 2);
  eq('지금 연결은 정상', push.healthy(), true);
  push.stop();
}

// ⑤ 겉으로만 열린 연결 — 핑에 답이 없으면 끊고 다시 붙는다
{
  const { push, sockets } = rig();
  push.start();
  sockets[0].open();
  await sleep(150); // 핑 120ms 한 번 · 답 기한(+60ms) 전
  eq('핑을 보낸다', sockets[0].sent.includes('ping'), true);
  await sleep(70); // 답 기한 넘김
  eq('답이 없으면 닫는다', sockets[0].closed, true);
  await sleep(75);
  eq('닫은 뒤 다시 붙는다', sockets.length, 2);
  push.stop();
}

// ⑥ 핑에 답하면 계속 정상
{
  const { push, sockets } = rig();
  push.start();
  sockets[0].open();
  const s = sockets[0];
  const send = s.send.bind(s);
  s.send = (d) => { send(d); if (d === 'ping') setTimeout(() => s.msg('pong'), 5); };
  await sleep(400);
  eq('답하면 안 닫는다', s.closed, false);
  eq('답하면 정상', push.healthy(), true);
  eq('답하면 새로 안 붙는다', sockets.length, 1);
  push.stop();
}

// ⑦ 정상의 기준은 「열림」이 아니라 최근 답 — 핑 주기 + 기한이 지나면 정상 아님
{
  const { push, sockets } = rig({ pingMs: 10_000 });
  push.start();
  sockets[0].open();
  eq('방금 열렸으면 정상', push.healthy(), true);
  eq('답 없이 핑 주기+기한이 지나면 정상 아님', push.healthy(Date.now() + 10_061), false);
  push.stop();
}

// ⑧ 인증 거절 — 빨리 두드리지 않는다(긴 간격) · 통과하면 다시 짧은 간격
{
  let auth = true;
  const { push, sockets } = rig({ authBroken: async () => auth });
  push.start();
  sockets[0].drop();
  await sleep(200);
  eq('인증 거절이면 짧은 간격으로 안 붙는다', sockets.length, 1);
  await sleep(500);
  eq('긴 간격 뒤 다시 본다', sockets.length, 2);
  auth = false;
  sockets[1].open();
  sockets[1].drop();
  await sleep(75);
  eq('인증이 풀리면 짧은 간격', sockets.length, 3);
  push.stop();
}

// ⑨ 주소가 없으면 소켓을 안 만들고 긴 간격으로 다시 본다
{
  let target = null;
  const { push, sockets } = rig({ target: () => target });
  push.start();
  eq('주소 없으면 안 만든다', sockets.length, 0);
  target = { url: 'wss://board.test/api/ws', headers: {} };
  await sleep(650);
  eq('주소가 생기면 붙는다', sockets.length, 1);
  push.stop();
}

// ⑩ 소켓을 못 만들면(예외) 짧은 간격으로 다시
{
  let n = 0;
  const { push } = rig({ socket: () => { n += 1; throw new Error('없음'); } });
  push.start();
  await sleep(75);
  eq('만들다 터지면 다시 시도', n >= 2, true);
  push.stop();
  const at = n;
  await sleep(150);
  eq('멈추면 시도도 멈춘다', n, at);
}

// ⑪ 멈춘 뒤 다시 시작하면 처음부터 붙는다 (설정 저장 = clearAllTimers → startBoardQueuePoller)
{
  const { push, sockets, news } = rig();
  push.start();
  sockets[0].open();
  push.stop();
  push.start();
  eq('다시 시작하면 새 소켓', sockets.length, 2);
  sockets[1].open();
  eq('다시 시작해도 붙자마자 가져간다', news.length, 2);
  push.stop();
}

// ⑫ 스케줄러 배선 — **소스를 대조한다.** 몸통(`tickBoardQueue`)은 진짜 판 주소로 나가서
//    여기서 돌릴 수 없다. 대신 깨지면 조용히 느려지기만 하는 네 군데를 글자로 묶는다.
{
  const src = fs.readFileSync(path.join(ROOT, 'src', 'assistant-scheduler.ts'), 'utf-8');
  const fn = (name) => {
    const head = src.search(new RegExp(`private (async )?${name}\\(`));
    return head < 0 ? '' : src.slice(head, src.indexOf('\n  }', head));
  };
  const start = fn('startBoardQueuePoller');
  const tick = fn('tickBoardQueue');
  eq('알림이 오면 주기를 건너뛰고 돈다', /onNew: \(\) => \{ void this\.tickBoardQueue\(true\); \}/.test(start), true);
  eq('끄는 문 BOARD_PUSH=off', /if \(process\.env\.BOARD_PUSH !== 'off'\)/.test(start), true);
  eq('알림이 깨운 것은 주기 판정을 안 탄다', /if \(!force && now - this\.boardQueueLast/.test(tick), true);
  eq('도는 중에 온 알림은 적어 둔다', /if \(this\.boardQueueBusy\) \{\s*if \(force\) this\.boardQueueAgain = true;/.test(tick), true);
  eq('끝난 뒤 한 번 더 돈다', /if \(this\.boardQueueAgain\) \{\s*this\.boardQueueAgain = false;\s*void this\.tickBoardQueue\(true\);/.test(tick), true);
}

if (fails.length) {
  console.log(`실패 ${fails.length}건\n`);
  for (const f of fails) console.log('  ✗ ' + f);
  process.exitCode = 1;
} else {
  console.log('통과 — 판 알림 연결 (붙자마자 가져감 · 알림마다 가져감 · 끊기면 다시 붙음 · '
    + '잇단 실패 간격 40/120/300/300 · 옛 연결 신호 버림 · 핑 답 없으면 끊고 다시 · 답하면 유지 · '
    + '정상 = 최근 답 · 인증 거절은 긴 간격 · 주소 없으면 대기 · 만들다 터져도 다시 · 멈춤/다시 시작 · '
    + '스케줄러 배선 5곳)');
}
process.exit(process.exitCode ?? 0);
