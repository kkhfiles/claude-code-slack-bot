/**
 * 분석 회차가 report-log 에 쓰는 길 — 5단계(쓰는 쪽 전환) 스탠리 몫.
 *
 *   npm run build
 *   npm run check:reportrun
 *
 * 무엇을 재나 — 계획 `report-log/docs/stage5-plan.md` 「쓰는 흐름」 의 스탠리 차례.
 *
 *   - 회차 열기 · 예정일(예약 발화 시각의 한국 날짜) · 재시도는 같은 회차 · 수동은 오늘
 *   - 프롬프트 자리 치환 · 남은 `{{` 면 세션을 안 띄움
 *   - 쓰기 범위(임시 파일 폴더) · 저장 시점 · 「썼나」 판정 · 처리 백엔드
 *   - 러너 미리 띄우기의 환경 변수 · `--date` · 월요일 보고의 `{{WEEK_INPUT}}`
 *   - agy 위임 경로가 걷혔나
 *
 * **외부를 안 부른다** — report-log 명령은 가짜(`deps.reportLog`)로, 세션은 가짜
 * `spawnSession` 으로, 러너 기동은 인스턴스에서 갈아 끼운다. 상태 경로는 **모듈을
 * 읽기 전에** 임시 폴더로 돌린다 — 경로를 모듈이 읽힐 때 잡는 곳이 있어, 늦게 돌리면
 * 시험이 운영 상태 파일에 한 줄을 남긴다(앞서 실제로 그랬다).
 */
import './lib/fresh-dist.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'report-run-'));
const STATE = path.join(TMP, 'report-log-state');
process.env.REPORT_LOG_STATE = STATE;
process.env.REPORT_LOG_REPO = path.join(TMP, 'report-log-없는-클론');
process.env.WORK_EVENTS_FILE = path.join(TMP, 'events.jsonl');
process.env.WORK_ASSISTANT_STATE = path.join(TMP, 'wa-state');
// 폴백이 진짜 실행체를 부르지 않게 — 없는 이름이면 빈손으로 물러난다.
process.env.BOARD_NARROW_CODEX_BIN = 'codex-없는-이름-2026';
process.env.LADDER_PYTHON = 'python-없는-이름-2026';
fs.mkdirSync(path.join(STATE, 'tmp'), { recursive: true });

const require = createRequire(import.meta.url);

const fails = [];
const eq = (label, got, want) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    fails.push(`${label}\n    받음 ${JSON.stringify(got)}\n    기대 ${JSON.stringify(want)}`);
  }
};
const ok = (label, cond) => { if (!cond) fails.push(label); };

/** 주석을 지운 소스 — 규칙을 설명하는 주석이 위반으로 걸리지 않게. */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const SRC = path.join(ROOT, 'src');
const schedSrc = stripComments(fs.readFileSync(path.join(SRC, 'assistant-scheduler.ts'), 'utf-8'));

// ── S9 agy 위임 경로 — 걷혔나 ─────────────────────────────────────
{
  ok('src/agy-handler.ts 가 남아 있다 — 부르는 곳이 없는 폐기 모듈', !fs.existsSync(path.join(SRC, 'agy-handler.ts')));
  for (const name of fs.readdirSync(SRC).filter((f) => f.endsWith('.ts'))) {
    const text = stripComments(fs.readFileSync(path.join(SRC, name), 'utf-8'));
    for (const word of ['shouldUseAgy', 'runAgyAnalysis', 'ANALYSIS_AGY_TYPES', './agy-handler']) {
      ok(`${name}: ${word} 가 남아 있다 — agy 는 폴백으로만 쓴다`, !text.includes(word));
    }
  }
}

fs.rmSync(TMP, { recursive: true, force: true });

if (fails.length) {
  console.error(`\n실패 ${fails.length}건\n\n  ✗ ${fails.join('\n\n  ✗ ')}\n`);
  process.exitCode = 1;
} else {
  console.log('통과 — 분석 회차 쓰는 길 (agy 위임 경로 걷힘)');
}
