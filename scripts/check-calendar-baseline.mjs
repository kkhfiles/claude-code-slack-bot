/**
 * 회의 알림 판단 — **판단을 못 한 변경을 다음 차례가 다시 보나** (2026-10-14 · 엔진 폴백 4단계).
 *
 *   npm run build
 *   npm run check:calbase
 *
 * 전에는 판단 **전에** 캐시를 새 일정으로 바꾸고 중복 표시도 먼저 옮겼다. Claude 도 사다리(codex · agy)도
 * 못 한 차례는 「알림 없음」(빈 목록)과 구분이 안 됐고, 다음 차례에는 비교할 변경이 남아 있지 않아
 * **그 변경의 알림이 영영 사라졌다.** 이제
 *   - 판단 결과가 둘로 갈린다 — 「판단했고 알릴 것 없음」(`[]`) · 「못 함」(`null`)
 *   - 못 했으면 비교 기준(`baseline`)과 중복 표시를 안 옮긴다 → 다음 차례에 같은 변경을 다시 판단
 *   - 캐시의 `events` 는 늘 지금 일정(브리핑이 읽는다) · 브리핑의 캐시 새로 받기도 기준을 안 지운다
 *
 * **외부를 안 부른다** — 달력 · 토큰은 인스턴스에서 갈아 끼우고, Claude 는 가짜, 사다리는 없는 파이썬.
 */
import './lib/fresh-dist.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cal-base-'));
// 사다리(codex · agy)가 못 하게 — 없는 파이썬이면 빈손으로 물러난다.
process.env.LADDER_PYTHON = 'python-없는-이름-2026';
process.env.ENGINE_STATE_FILE = path.join(TMP, 'engine-state.json');

const require = createRequire(import.meta.url);
const { CalendarPoller } = require('../dist/calendar-poller.js');
const { errorCollector } = require('../dist/error-collector.js');

const fails = [];
const eq = (label, got, want) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    fails.push(`${label}\n    받음 ${JSON.stringify(got)}\n    기대 ${JSON.stringify(want)}`);
  }
};
const ok = (label, cond) => { if (!cond) fails.push(label); };

const PROMPTS = path.join(TMP, 'prompts');
fs.mkdirSync(PROMPTS, { recursive: true });
fs.writeFileSync(path.join(PROMPTS, 'calendar-judgment.md'),
  '추가: {addedEvents}\n삭제: {removedEvents}\n변경: {modifiedEvents}\n기존: {existingNotifications}\n', 'utf-8');
const CFG = { reminders: { enabled: true, beforeMinutes: 10, pollingIntervalMinutes: 5, maxBudgetUsd: 0.15 } };

const H = 3_600_000;
const ev = (id, inMs) => ({
  id, calendarId: 'c', calendarName: '시험', title: `회의 ${id}`, location: '',
  startTime: new Date(Date.now() + inMs).toISOString(), endTime: new Date(Date.now() + inMs + H).toISOString(),
  isAllDay: false, description: '', status: 'confirmed', updated: '',
});
/** 같은 일정은 같은 값으로 — 부를 때마다 시각을 새로 재면 「시간 바뀜」으로 잡힌다. */
const E1 = ev('e1', 2 * H);
const FAILED = { text: '', costUsd: 0, sessionId: '', subtype: 'error_during_execution', isError: true };
const said = (arr) => ({ text: JSON.stringify(arr), costUsd: 0, sessionId: '', subtype: 'success', isError: false });
const upcoming = (id) => ({ eventId: id, notifyAt: new Date(Date.now() + H).toISOString(), message: `곧 ${id}`, type: 'upcoming' });

let reply = FAILED;
const prompts = [];
const p = new CalendarPoller(async () => {}, async (prompt) => { prompts.push(prompt); return reply; },
  PROMPTS, () => CFG, () => {}, () => true);
p.cacheFile = path.join(TMP, 'calendar-cache.json');
p.notificationsFile = path.join(TMP, 'calendar-notifications.json');
p.mutedEventsFile = path.join(TMP, 'calendar-muted.json');
let events = [];
p.getAccessToken = async () => 'tok-시험';
p.fetchAllEvents = async () => events.map((e) => ({ ...e }));
const cache = () => JSON.parse(fs.readFileSync(p.cacheFile, 'utf-8'));
const notes = () => (fs.existsSync(p.notificationsFile) ? JSON.parse(fs.readFileSync(p.notificationsFile, 'utf-8')) : []);

try {
  // ① 판단 결과 둘 — 못 함(null) · 판단했고 알릴 것 없음([])
  {
    const diff = { added: [ev('d1', 2 * H)], removed: [], modified: [] };
    reply = FAILED;
    eq('Claude · 사다리가 다 못 하면 null(「알릴 것 없음」과 다름)', await p.getAIJudgment(diff), null);
    reply = said([]);
    eq('판단했고 알릴 것 없음은 []', await p.getAIJudgment(diff), []);
  }

  // ② 판단을 못 한 차례 → 기준 · 중복 표시를 안 옮긴다 → 다음 차례에 같은 변경을 다시 판단
  {
    events = [E1];
    reply = FAILED;
    const n0 = prompts.length;
    await p.poll();
    eq('첫 차례 — 판단을 부른다', prompts.length - n0, 1);
    eq('캐시의 일정은 지금 것(브리핑이 읽는다)', cache().events.map((e) => e.id), ['e1']);
    eq('비교 기준은 판단 전 것 그대로', (cache().baseline ?? []).map((e) => e.id), []);
    eq('알림 없음', notes().length, 0);

    // 브리핑이 캐시를 새로 받아도 판단을 못 끝낸 기준은 남는다
    await p.refreshCache();
    ok('캐시를 새로 받아도 기준이 남는다', Array.isArray(cache().baseline) && cache().baseline.length === 0);

    await p.poll();
    eq('또 못 하면 또 다시 부른다', prompts.length - n0, 2);
    const lines = errorCollector.getAndClear().filter((e) => e.message.startsWith('회의 알림 판단 —'));
    eq('실패가 이어지는 동안 「시스템 이슈」는 한 줄', lines.length, 1);

    reply = said([upcoming('e1')]);
    await p.poll();
    eq('다음 차례에 같은 변경을 다시 판단한다', prompts.length - n0, 3);
    ok('다시 판단할 때 그 일정이 「추가」로 실린다', prompts.at(-1).includes('[e1]'));
    eq('이번엔 알림이 생긴다', notes().map((n) => [n.eventId, n.type]), [['e1', 'upcoming']]);
    eq('판단이 끝나면 기준을 지운다(지금 일정이 기준)', cache().baseline, undefined);

    await p.poll();
    eq('판단을 끝낸 변경은 다시 안 부른다', prompts.length - n0, 3);
  }

  // ③ 판단했고 알릴 것 없음([]) → 기준을 옮긴다(실패와 구분)
  {
    events = [E1, ev('e2', 3 * H)];
    reply = said([]);
    const n0 = prompts.length;
    await p.poll();
    eq('알릴 것 없음도 판단은 했다', prompts.length - n0, 1);
    eq('알릴 것 없음이면 기준을 옮긴다', [cache().baseline, cache().events.map((e) => e.id)], [undefined, ['e1', 'e2']]);
    await p.poll();
    eq('같은 일정이면 다시 안 부른다', prompts.length - n0, 1);
  }

  // ④ 답은 왔는데 JSON 목록이 아님 → 「알릴 것 없음」이 아니다(null) · 같은 변경에 세 번 이어지면 받는다
  {
    const prose = { text: '일정을 확인했습니다. 알릴 것이 있는지 살펴보겠습니다.', costUsd: 0, sessionId: '', subtype: 'success', isError: false };
    const diff = { added: [ev('d9', 2 * H)], removed: [], modified: [] };
    reply = prose;
    eq('글로만 답하면 null', await p.getAIJudgment(diff), null);
    reply = { ...prose, text: '[{"eventId": 깨짐]' };
    eq('JSON 이 깨졌으면 null', await p.getAIJudgment(diff), null);

    events = [E1, ev('e2', 3 * H), ev('e3', 4 * H)];
    reply = prose;
    const n0 = prompts.length;
    await p.poll();
    await p.poll();
    eq('두 번까지는 기준을 안 옮기고 다시 판단', [prompts.length - n0, (cache().baseline ?? []).map((e) => e.id)], [2, ['e1', 'e2']]);
    errorCollector.getAndClear();
    await p.poll();
    eq('세 번째 — 알림 없이 받고 기준을 옮김', [prompts.length - n0, cache().baseline], [3, undefined]);
    ok('받았다는 줄을 「시스템 이슈」에', errorCollector.getAndClear().some((e) => e.message.includes('JSON 이 아닌 답이 3번')));
    await p.poll();
    eq('받은 변경은 다시 안 부른다', prompts.length - n0, 3);
  }

  // ⑤ 겹쳐 돌지 않는다 — 앞 차례가 판단을 기다리는 동안 다음 폴링은 건너뜀
  {
    events = [E1, ev('e2', 3 * H), ev('e3', 4 * H), ev('e4', 5 * H)];
    let open;
    const gate = new Promise((r) => { open = r; });
    const n0 = prompts.length;
    const real = p.spawnSession;
    p.spawnSession = async (prompt) => { prompts.push(prompt); await gate; return said([]); };
    const first = p.poll();
    await new Promise((r) => setTimeout(r, 30));
    const second = p.poll();
    await new Promise((r) => setTimeout(r, 30));
    open();
    await Promise.all([first, second]);
    p.spawnSession = real;
    eq('도는 중이면 다음 폴링은 판단을 안 부른다', prompts.length - n0, 1);
  }
} finally {
  p.stop();
  fs.rmSync(TMP, { recursive: true, force: true });
}

if (fails.length) {
  console.log(`실패 ${fails.length}건\n`);
  for (const f of fails) console.log('  ✗ ' + f);
  process.exitCode = 1;
} else {
  console.log('통과 — 회의 알림 판단 기준 (못 함은 null · 알릴 것 없음은 [] · 못 한 차례는 기준을 안 옮겨 '
    + '다음 차례에 다시 판단 · 캐시 새로 받기도 기준을 안 지움 · JSON 아닌 답은 null · 같은 변경에 세 번이면 받음 · '
    + '겹쳐 돌지 않음)');
}
