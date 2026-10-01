/**
 * 타이머 짝 검사 — 지우기만 하고 다시 안 거는 것을 찾는다. **소스만 읽는다.**
 *
 *   npm run check:timers
 *
 * `clearAllTimers()` 는 설정을 저장할 때마다 돈다. 거기서 지운 타이머를
 * `scheduleAll()` 이 다시 걸지 않으면 **그 기능은 에러도 로그도 없이 사라진다** —
 * 봇은 멀쩡히 돌고 그 알림만 영영 안 온다. 2026-07-15 에 다우 세션 keep-alive 가
 * 이렇게 끊겨 닷새 뒤에야 드러났고, 그 교훈은 지금 소스 주석에만 있다.
 *
 * 주석은 다음 사람이 안 읽는다. 그래서 여기서 센다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src', 'assistant-scheduler.ts');

/** 타이머 이름 → 그것을 거는 함수. **새 타이머를 넣으면 여기에도 한 줄 는다.** */
const REGISTRAR = {
  briefingTimer: 'scheduleBriefing',
  workNudgeTimer: 'scheduleWorkNudge',
  notionWatchTimer: 'startNotionWatch',
  boardQueueTimer: 'startBoardQueuePoller',
  daouKeepAliveTimer: 'scheduleDaouKeepAlive',
  focusTimer: 'scheduleFocus',
  summaryTimer: 'scheduleSummary',
  offsitePushTimer: 'scheduleOffsitePush',
  mailPollTimer: 'startMailPoller',
  remindTimer: 'startRemindPoller',
  actionsTimer: 'startActionsTicker',
};

/**
 * 한 타이머 자리에서 **같이** 하기로 한 일.
 *
 * 타이머는 하나인데 하는 일이 둘 이상이면 뒤엣것이 빠져도 아래 검사 셋이 전부
 * 통과한다 — 타이머는 여전히 걸리고 지워지고 스스로 재예약하니까. 20:00 자리가
 * 그렇다(커밋 걷기 다음에 밖으로 내보내기). 그래서 하는 일을 따로 센다.
 */
const ALSO_DOES = {
  scheduleOffsitePush: ['runCommitHarvest', 'runOffsitePush'],
};

/**
 * 타이머가 아닌 **상시 연결** → 그것을 여는 함수 (2026-10-01 판 알림).
 *
 * 이름이 `…Timer` 가 아니라 위 검사 셋이 못 본다. 그런데 짝이 깨지는 모양은 같다 —
 * 멈추기만 하고 다시 안 열면 알림이 조용히 끊기고 안전망 주기로만 돈다(느려질 뿐 에러는
 * 없다). 거꾸로 안 멈추면 설정을 저장할 때마다 연결이 하나씩 쌓여 같은 알림을 여러 번 받는다.
 */
const CONNECTIONS = {
  boardPush: 'startBoardQueuePoller',
};

/** 소스에서 그 함수의 본문만 떼어 온다. 못 찾으면 멈춘다 — 조용히 빈 문자열을
 *  돌려주면 「아무것도 안 걸려 있다」가 아니라 「검사가 안 돌았다」가 된다. */
function body(src, name) {
  const head = src.search(new RegExp(`private (async )?${name}\\(`));
  if (head < 0) throw new Error(`${name}() 을 못 찾았다 — 이름이 바뀌었나`);
  const rest = src.slice(head + name.length);
  const next = rest.search(/\n {2}(private|public|\/\*\*)/);
  return next < 0 ? rest : rest.slice(0, next);
}

const src = fs.readFileSync(SRC, 'utf-8');
const fails = [];

const cleared = new Set(
  [...body(src, 'clearAllTimers').matchAll(/this\.(\w+Timer)\b/g)].map((m) => m[1]),
);
const declared = new Set(
  [...src.matchAll(/private (\w+Timer): ReturnType/g)].map((m) => m[1]),
);
const scheduleAll = body(src, 'scheduleAll');

// ① 선언한 타이머는 전부 지워져야 한다 — 안 지우면 설정을 저장할 때마다 하나씩
//    쌓여 같은 알림이 두 번, 세 번 온다.
for (const t of declared) {
  if (t === 'watchDebounceTimer' || t === 'midnightTimer') continue; // 각자 자기 자리에서 지운다
  if (!cleared.has(t)) fails.push(`${t} — 선언은 했는데 clearAllTimers() 가 안 지운다`);
}

// ② 지운 타이머는 전부 다시 걸려야 한다. **이게 조용한 누수 지점이다.**
for (const t of cleared) {
  const fn = REGISTRAR[t];
  if (!fn) { fails.push(`${t} — 무엇이 거는지 이 검사가 모른다 (REGISTRAR 에 한 줄 넣을 것)`); continue; }
  if (!scheduleAll.includes(`this.${fn}(`)) {
    fails.push(`${t} — 지우기만 하고 scheduleAll() 이 ${fn}() 을 다시 안 부른다`);
  }
}

// ③ 다시 거는 함수는 스스로를 또 예약해야 한다 — `setTimeout` 은 한 번만 터진다.
for (const [timer, fn] of Object.entries(REGISTRAR)) {
  if (!cleared.has(timer)) continue;
  const b = body(src, fn);
  if (b.includes('setInterval')) continue;              // 되풀이는 그쪽이 알아서
  if (!b.includes(`this.${fn}()`)) {
    fails.push(`${fn}() — 한 번 터지고 끝난다 (자기를 다시 안 예약한다)`);
  }
}

// ④ 그 자리에서 하기로 한 일이 다 불리는가.
for (const [fn, jobs] of Object.entries(ALSO_DOES)) {
  const b = body(src, fn);
  for (const job of jobs) {
    if (!b.includes(`this.${job}(`)) {
      fails.push(`${fn}() — ${job}() 을 안 부른다 (그 자리에서 같이 하기로 한 일)`);
    }
  }
}

// ⑤ 상시 연결도 같은 짝 — clearAllTimers() 가 멈추고, 여는 함수가 scheduleAll() 에서
//    다시 불리고, 그 함수가 실제로 연다.
const clearBody = body(src, 'clearAllTimers');
for (const [conn, fn] of Object.entries(CONNECTIONS)) {
  if (!new RegExp(`this\\.${conn}\\.stop\\(\\)`).test(clearBody)) {
    fails.push(`${conn} — clearAllTimers() 가 안 멈춘다 (설정 저장마다 연결이 쌓인다)`);
  }
  if (!scheduleAll.includes(`this.${fn}(`)) {
    fails.push(`${conn} — 여는 ${fn}() 을 scheduleAll() 이 안 부른다`);
  }
  if (!new RegExp(`this\\.${conn}\\.start\\(\\)`).test(body(src, fn))) {
    fails.push(`${conn} — ${fn}() 이 연결을 안 연다 (멈추기만 하고 다시 안 엶)`);
  }
}

if (fails.length) {
  console.error('타이머 짝이 안 맞는다\n' + fails.map((f) => `  ✗ ${f}`).join('\n'));
  process.exitCode = 1;
} else {
  const jobs = Object.values(ALSO_DOES).flat().length;
  console.log(`통과 — 타이머 ${cleared.size}개: 지움·다시 걺·자기 재예약 셋 다`
    + ` · 한자리에서 같이 하는 일 ${jobs}개 · 상시 연결 ${Object.keys(CONNECTIONS).length}개`);
}
