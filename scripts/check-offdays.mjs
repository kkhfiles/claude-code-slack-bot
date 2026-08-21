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
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
  const gate = src.slice(src.indexOf('private isNonWorkingDay('));
  const body = gate.slice(0, gate.indexOf('\n  /**', 1));
  if (!body.includes('offDays()')) {
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

  if (fails.length) {
    console.log(`실패 ${fails.length}건`);
    for (const f of fails) console.log(`  ✗ ${f}`);
    process.exitCode = 1;
  } else {
    console.log(`통과 — 봇이 config.json 을 본다 · 앞으로 ${HORIZON_DAYS}일 안에`
      + ` 빠진 공휴일 없음 (등록된 쉬는 날 ${listed.size}건)`);
  }
}
