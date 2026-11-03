/**
 * 반복 타이머 직접 호출 금지 — 새 반복 타이머는 공통 장치(`src/recurring.ts` 의 `every` · `once`)로 건다.
 *
 *   npm run check:timerdirect
 *
 * **소스만 읽는다.** 두 모양을 잡는다.
 *   ① `setInterval(` — 어디서든
 *   ② 자기를 다시 거는 `setTimeout(` — 콜백 안에서 감싼 메서드를 다시 부르는 것(`this.<그 메서드>(`)
 * 한 번만 도는 지연(`setTimeout` 으로 몇 초 뒤 한 번)은 반복이 아니라 안 잡는다.
 *
 * 왜 — 직접 건 반복 타이머는 상태 파일에 안 나타나, 멈춰도 PC 점검기가 모른다(2026-11-03 전환 계획).
 * 지금 남은 것은 아래 목록이고, 옮길 때마다 목록에서 지운다. 목록에 있는데 소스에서 사라진 것도 실패다 —
 * 지우는 것을 잊으면 목록이 새 직접 호출을 덮어 준다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');

/** 아직 안 옮긴 `setInterval` — `파일:메서드` → 그 메서드 안의 개수. 옮기면 지운다. */
const INTERVAL_LEFT = new Map([
  ['board-push.ts:start', 1],
  ['calendar-poller.ts:start', 2],
  ['chat-host.ts:start', 1],
  ['daou-login.ts:start', 1],
  ['engine-state.ts:startWatch', 1],
  ['letter-booking.ts:startNudge', 1],
  ['letter-coffeechat.ts:startTimer', 1],
  ['letter-initiative.ts:rooms', 1],
  ['lunch-poller.ts:start', 1],
  ['premium-seat.ts:every', 1],
  ['process-memory-watchdog.ts:start', 1],
  ['sdk-update.ts:start', 1],
  ['slack-handler.ts:setupEventHandlers', 3],
]);

/** 아직 안 옮긴 자기 재예약 `setTimeout` — `파일:메서드`. 옮기면 지운다. */
const REARM_LEFT = new Set([
  'assistant-scheduler.ts:scheduleAnalysisGroup',
  'assistant-scheduler.ts:scheduleBriefing',
  'assistant-scheduler.ts:scheduleDaouKeepAlive',
  'assistant-scheduler.ts:scheduleFocus',
  'assistant-scheduler.ts:scheduleImprove',
  'assistant-scheduler.ts:scheduleMidnightCleanup',
  'assistant-scheduler.ts:scheduleOffsitePush',
  'assistant-scheduler.ts:scheduleSummary',
  'assistant-scheduler.ts:scheduleWorkNudge',
]);

/**
 * 옮기지 않기로 한 것 — 일이 생길 때만 다시 거는 예약 4개(엔진 회복, 분석 한도 재시도, 판 알림 재연결,
 * 처리 제안 한도 회복)는 콜백이 감싼 메서드를 다시 부르는 모양이 아니라 ② 에 안 걸린다. 그래서 목록이 비어 있다.
 * ② 에 걸리는 것을 옮기지 않기로 하면 여기 적고 까닭을 단다.
 */
const KEEP = new Set([]);

const METHOD = /^\s{2}(?:private |public |protected |static |async )*(\w+)\s*\(/gm;

/** 여는 괄호 다음부터 짝이 맞는 닫는 괄호까지. */
function argsText(s, i) {
  let depth = 1;
  const start = i;
  while (i < s.length && depth) {
    const c = s[i];
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') depth -= 1;
    i += 1;
  }
  return s.slice(start, i - 1);
}

const found = { interval: new Map(), rearm: new Set() };
for (const name of fs.readdirSync(SRC).filter((n) => n.endsWith('.ts')).sort()) {
  if (name === 'recurring.ts') continue;
  const s = fs.readFileSync(path.join(SRC, name), 'utf-8');
  const heads = [...s.matchAll(METHOD)].map((m) => [m.index, m[1]]);
  const methodAt = (pos) => {
    let n = '?';
    for (const [p, m] of heads) { if (p < pos) n = m; else break; }
    return n;
  };
  for (const m of s.matchAll(/(?<![.\w])(setInterval|setTimeout)\(/g)) {
    const meth = methodAt(m.index);
    const key = `${name}:${meth}`;
    if (m[1] === 'setInterval') found.interval.set(key, (found.interval.get(key) ?? 0) + 1);
    else if (argsText(s, m.index + m[0].length).includes(`this.${meth}(`)) found.rearm.add(key);
  }
}

const fails = [];
for (const [k, n] of found.interval) {
  const left = INTERVAL_LEFT.get(k) ?? 0;
  if (n > left) fails.push(`${k} — setInterval 직접 호출 ${n - left}개. 공통 장치 every({ name, everyMs, run }) 로 건다`);
}
for (const k of found.rearm) {
  if (!REARM_LEFT.has(k) && !KEEP.has(k)) fails.push(`${k} — 자기를 다시 거는 setTimeout. 공통 장치 once({ name, ms, run }) 로 건다`);
}
for (const [k, n] of INTERVAL_LEFT) if ((found.interval.get(k) ?? 0) < n) fails.push(`${k} — 목록에는 ${n}개인데 소스에 ${found.interval.get(k) ?? 0}개. INTERVAL_LEFT 를 줄인다`);
for (const k of REARM_LEFT) if (!found.rearm.has(k)) fails.push(`${k} — 목록에 남았는데 소스에 없음. REARM_LEFT 에서 지운다`);
for (const k of KEEP) if (!found.rearm.has(k)) fails.push(`${k} — 고정 예외인데 소스에서 못 찾음. 이름이 바뀌었으면 KEEP 을 고친다`);

if (process.argv.includes('--list')) {
  console.log(JSON.stringify({ interval: Object.fromEntries([...found.interval].sort()), rearm: [...found.rearm].sort() }, null, 1));
}
if (fails.length) {
  console.error('반복 타이머 직접 호출\n' + fails.map((f) => `  ✗ ${f}`).join('\n'));
  process.exitCode = 1;
} else {
  const left = [...INTERVAL_LEFT.values()].reduce((a, b) => a + b, 0);
  console.log(`통과 — 직접 건 반복 타이머: 남은 setInterval ${left}개 · 남은 자기 재예약 ${REARM_LEFT.size}곳 · 고정 예외 ${KEEP.size}곳`);
}
