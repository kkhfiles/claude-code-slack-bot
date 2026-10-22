/**
 * `dist` 가 `src` 보다 낡았으면 멈춘다.
 *
 * ⛔ **왜 있나** — 검사들은 `src` 가 아니라 `dist` 를 읽는데, 빌드는
 * `npm test`(check-all) 만 한다. 그래서 TypeScript 를 고치고 검사 하나만
 * 돌리면 **옛 코드가 통과 도장을 받는다.** 2026-08-29 에 실제로 겪었다 —
 * 새로 넣은 문 셋을 변이 시험으로 재 보니 셋 다 「못 잡음」이 나왔고,
 * 원인은 코드가 아니라 안 지어진 `dist` 였다.
 *
 * **통과가 거짓말을 하느니 멈추는 편이 낫다.**
 *
 * 쓰는 법 — 파일 맨 위에 한 줄. 부작용으로 돈다.
 *     import './lib/fresh-dist.mjs';
 *
 * 새 검사가 이것을 빠뜨리면 `check:fresh` 가 잡는다(사람 기억에 안 맡긴다).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 어느 디렉터리에서 가장 최근에 손댄 파일의 시각. 없으면 0. */
function newest(dir, ext) {
  let best = 0;
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(ext)) {
        const m = fs.statSync(p).mtimeMs;
        if (m > best) best = m;
      }
    }
  };
  walk(dir);
  return best;
}

const src = newest(path.join(ROOT, 'src'), '.ts');
const dist = newest(path.join(ROOT, 'dist'), '.js');

if (!dist) {
  console.error('dist 가 없습니다 — 먼저 `npm run build`');
  process.exit(1);
}
// 1초는 봐준다 — 빌드가 막 끝난 직후 파일 시각이 뒤집혀 보이는 일이 있다.
if (src > dist + 1000) {
  console.error('dist 가 src 보다 낡았습니다 — `npm run build` 뒤에 다시 도세요');
  process.exit(1);
}

// **검사는 진짜 크레딧 장부를 안 읽는다**(2026-10-22) — 장부(`~/.config/llm-playbook/api-credits.json`)가 켜져 있으면
// SDK 처리기가 세션을 API 키로 띄우므로, 장부를 켜는 순간 검사의 동작이 바뀐다. 따로 지정하지 않았으면 없는 파일로 돌린다.
if (!process.env.LLM_PLAYBOOK_CREDITS) {
  process.env.LLM_PLAYBOOK_CREDITS = path.join(os.tmpdir(), `check-no-credits-${process.pid}.json`);
}

// **검사는 운영 엔진 상태에 안 쓴다**(2026-10-23) — SDK 처리기를 지나는 검사(`check:noaccounts` 등)는 전송 탭이 막힘과
// 성공을 기본 자리(저장소 루트 `.engine-state.json`)에 적었다. 구독이 멀쩡한데 「Claude 사용량 소진」 안내가 나간 원인이다
// (같은 초에 성공과 막힘 · 검사를 돌린 시각마다). 엔진 상태 자리를 직접 정하는 검사는 이 값을 덮어쓴다 — 옛 검사처럼
// `RATE_LIMIT_UNTIL_FILE` 만 옮기는 검사도 그 옆으로 가게 그 값이 있으면 건드리지 않는다.
if (!process.env.ENGINE_STATE_FILE && !process.env.RATE_LIMIT_UNTIL_FILE) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-engine-state-'));
  process.env.ENGINE_STATE_FILE = path.join(dir, '.engine-state.json');
}
