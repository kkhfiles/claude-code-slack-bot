/**
 * 쉬는 날 달력이 두 쪽에서 같은 답을 내는가.
 *
 *   npm run check:offdays
 *
 * **봇과 파이썬이 서로 다른 달력을 보고 있었다** (2026-08-21 발견). 봇은
 * `date-holidays` 의 한국 공휴일만 봤고, 파이썬은 `work-assistant/config.json` 의
 * `holidays` 만 봤다. 그 목록은 이름만 공휴일이지 뜻은 「내가 일하지 않는 날」이라
 * **개인 휴가·건강검진**이 들어 있는데, 봇에게는 그런 날이 평범한 업무일로 보였다.
 * 2026-08-20 건강검진일에 메일 후보가 세 번 나갔고 사용자가 손으로 조용히를 켰다.
 *
 * 이 검사가 보는 것 둘.
 *
 *   ① 봇이 `config.json` 을 실제로 읽는가 — 소스에서 `offDays()` 호출을 찾는다.
 *      고쳐 놓고 지우면 아무 소리 없이 예전으로 돌아간다.
 *   ② 두 달력이 어긋나는 날이 앞으로 있는가 — `date-holidays` 가 공휴일이라는데
 *      `config.json` 에 없으면 **파이썬이 그날 착수하라고 말한다.** 봇은 조용해도
 *      마감 역산은 그날을 업무일로 세기 때문이다. 그 방향이 진짜 결함이다.
 *
 * ②는 「연말까지 넣어 둔 목록이 해를 넘겼다」를 잡는 자리다 — 조용히 틀리고,
 * 틀린 티가 안 난다.
 */
import './lib/fresh-dist.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Holidays from 'date-holidays';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src', 'assistant-scheduler.ts');

/** 앞으로 이만큼을 본다. 한 해 목록이 끊기는 것을 지나기 전에 잡을 만큼. */
const HORIZON_DAYS = 120;

const fails = [];

// --- 비서 레포를 찾는다. 없으면 검사할 것이 없다(있는 척하지 않는다).
function assistantRoot() {
  const env = process.env.WORK_ASSISTANT_ROOT;
  const guess = env || 'P:/github/work-assistant';
  return fs.existsSync(path.join(guess, 'config.json')) ? guess : null;
}

const root = assistantRoot();
if (!root) {
  console.log('⏭ work-assistant 를 못 찾아 건너뛴다 — 합격이 아니라 안 본 것이다');
  process.exitCode = 0;
} else {
  // --- ① 봇이 그 목록을 읽는가
  const src = fs.readFileSync(SRC, 'utf-8');
  // **못 찾으면 멈춘다.** 이름이 바뀌었는데 조용히 넘어가면 「안 본다」가 아니라
  // 「검사가 안 돌았다」인데, 둘이 화면에서 똑같아 보인다.
  const head = src.indexOf('private isNonWorkingDay(');
  const gate = head < 0 ? '' : src.slice(head);
  const tail = gate.indexOf('\n  /**', 1);
  if (head < 0) {
    fails.push('isNonWorkingDay() 을 못 찾았다 — 이름이 바뀌었나 (검사가 헛돈다)');
  } else if (tail < 0) {
    fails.push('isNonWorkingDay() 의 끝을 못 찾았다 — 다음 메서드 앞 주석이 사라졌나');
  } else if (!gate.slice(0, tail).includes('offDays()')) {
    fails.push('isNonWorkingDay() 가 config.json 의 쉬는 날을 안 본다 '
      + '— 개인 휴가에 봇이 말을 건다');
  }

  // --- ② 두 달력이 어긋나는 날
  const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf-8'));
  const listed = new Set(Array.isArray(cfg.holidays) ? cfg.holidays : []);
  if (!listed.size) {
    fails.push('config.json 의 holidays 가 비었다 — 목록이 통째로 사라졌나');
  }

  const hd = new Holidays('KR');
  const pad = (n) => String(n).padStart(2, '0');
  const missing = [];
  const cursor = new Date();
  cursor.setHours(12, 0, 0, 0);
  for (let i = 0; i < HORIZON_DAYS; i += 1) {
    const day = cursor.getDay();
    if (day !== 0 && day !== 6) {
      const found = hd.isHoliday(cursor);
      const pub = Array.isArray(found) ? found.find((h) => h.type === 'public') : null;
      if (pub) {
        const key = `${cursor.getFullYear()}-${pad(cursor.getMonth() + 1)}-${pad(cursor.getDate())}`;
        if (!listed.has(key)) missing.push(`${key} ${pub.name}`);
      }
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  for (const m of missing) {
    fails.push(`공휴일인데 config.json 에 없다 — 파이썬이 그날 착수하라고 말한다: ${m}`);
  }

  // --- ③ 캐시가 고친 파일을 다시 읽는가
  //
  // `offDays()` 는 `isWorkingHours()` 를 거쳐 30초 타이머에 걸려 있어 하루
  // 2,880번 불린다. 그래서 캐시를 뒀는데, **캐시가 안 풀리면 휴가를 넣어도
  // 봇이 모른다** — 고쳐 놓고 그날 아침에야 안 먹은 것을 알게 된다.
  const dist = path.join(ROOT, 'dist', 'work-assistant.js');
  if (!fs.existsSync(dist)) {
    console.log('⏭ dist 가 없어 캐시 검사는 건너뛴다 (npm run build 먼저)');
  } else {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'offdays-'));
    try {
      fs.mkdirSync(path.join(tmp, 'bin'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'bin', 'tasks.py'), '# 있는 척');
      const cfgPath = path.join(tmp, 'config.json');
      fs.writeFileSync(cfgPath, JSON.stringify({ holidays: ['2026-08-20'] }));
      process.env.WORK_ASSISTANT_ROOT = tmp;
      const { offDays } = await import(pathToFileURL(dist).href);
      if (!offDays().has('2026-08-20')) {
        fails.push('캐시 검사가 첫 읽기부터 실패했다 — 검사가 헛돈다');
      } else if (offDays() !== offDays()) {
        fails.push('캐시가 안 돈다 — 30초마다 config.json 을 다시 읽는다');
      } else {
        fs.writeFileSync(cfgPath, JSON.stringify({ holidays: ['2026-08-20', '2026-09-01'] }));
        if (!offDays().has('2026-09-01')) {
          fails.push('캐시가 안 풀린다 — 휴가를 넣어도 봇이 모른다');
        }
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  if (fails.length) {
    console.log(`실패 ${fails.length}건`);
    for (const f of fails) console.log(`  ✗ ${f}`);
    process.exitCode = 1;
  } else {
    console.log(`통과 — 봇이 config.json 을 본다 · 앞으로 ${HORIZON_DAYS}일 안에`
      + ` 빠진 공휴일 없음 (등록된 쉬는 날 ${listed.size}건)`);
  }
}
