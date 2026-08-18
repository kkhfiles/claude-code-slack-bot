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
  checkinPmTimer: 'scheduleCheckinPm',
  notionWatchTimer: 'startNotionWatch',
  boardQueueTimer: 'startBoardQueuePoller',
  daouKeepAliveTimer: 'scheduleDaouKeepAlive',
  focusTimer: 'scheduleFocus',
  vaultPushTimer: 'scheduleVaultPush',
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

if (fails.length) {
  console.error('타이머 짝이 안 맞는다\n' + fails.map((f) => `  ✗ ${f}`).join('\n'));
  process.exitCode = 1;
} else {
  console.log(`통과 — 타이머 ${cleared.size}개: 지움·다시 걺·자기 재예약 셋 다`);
}
