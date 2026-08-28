/**
 * 「업데이트 요청」을 어느 모델·어느 사고 깊이로 처리해야 하는지 재는 자리.
 *
 *     node scripts/model-bench.mjs [--models a,b] [--efforts low,high] [--only A|B]
 *
 * **왜 봇의 핸들러를 그대로 쓰나.** 실제 세션은 도구 49개·스킬·프로젝트 규칙을
 * 들고 뜬다. 벗겨 놓고 재면 숫자가 실제로 안 옮겨지므로, 슬랙 DM 이 부르는 그
 * 경로(`SdkHandler.runQuery`)를 같은 인자로 부른다 — 다른 것은 모델과 effort 뿐이다.
 *
 * **노션에 아무것도 안 쓴다.** `WORK_ASSISTANT_DRY=1` 로 띄우면 `tasks.py` 가
 * 읽기는 진짜로 하고 쓰기는 「무엇을 쓸지」만 찍는다. 그 줄이 채점의 정답지라
 * 파일로도 받아 둔다(`WORK_ASSISTANT_DRY_LOG`).
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKDIR = 'P:/github/work-assistant';
const OUT = path.join(ROOT, '.bench');
// win32 는 `P:/…` 를 프로토콜로 읽는다 — 절대 경로는 file:// URL 로 넘겨야 한다.
const { SdkHandler } = await import(pathToFileURL(path.join(ROOT, 'dist', 'sdk-handler.js')).href);

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};

const MODELS = arg('models', 'claude-opus-5,claude-sonnet-5,claude-haiku-4-5-20251001').split(',');
const EFFORTS = arg('efforts', 'low,medium,high').split(',');
const ONLY = arg('only', '');

/**
 * 슬랙 DM 세션이 받는 것과 같은 안내. 이게 빠지면 세션이 자기가 어디 있는지
 * 몰라 터미널용 답을 내고, 그러면 재려던 것과 다른 것을 재게 된다.
 */
const SURFACE = [
  '이 세션은 **슬랙 DM**에서 열렸다 (터미널이 아니다).',
  '',
  '- **슬랙 문법으로 쓴다** — `*굵게*` · `_기울임_` · `<주소|글자>` · 목록은 `•`.',
  '  표준 마크다운(`##` 제목, `**굵게**`, `[글자](주소)`)은 슬랙이 렌더링하지 않고',
  '  **기호를 글자 그대로 보여준다.** 표도 깨진다.',
  '- **짧게** — 답 5줄 안팎. 목록 낭독 금지.',
  '- **존댓말**로 맺는다.',
  '- 도구가 슬랙용 출력을 내주면(예: `tasks.py board --slack`) **그대로 붙인다** —',
  '  다시 쓰지 않는다. 링크가 사라지면 폰에서 눌러 고칠 수 없다.',
].join('\n');

/**
 * 사례. **A 는 업무를 짚어 준 것**(판에서 온 말), **B 는 안 짚어 준 것**
 * (슬랙에 그냥 한 말) — B 는 대상을 스스로 찾아야 하고, 못 찾으면 되물어야 한다.
 *
 * `want` 는 사람이 채점할 때 보는 기준이지 자동 판정이 아니다. 자동으로 매기면
 * 「형식이 달라서 틀림」이 「판단이 틀림」으로 섞인다.
 */
const CASES = [
  { id: 'A1', kind: 'A', want: 'TSK-14 · 소프트 마감 08/14 · 다음 행동',
    text: '[진행판] TSK-14 「전현빈 선임과 DVERA 레벨 하네스 구축 계획 싱크」\n이건 이번주 금요일까지이다. 오늘 오후에 한번더 싱크 예정.' },
  { id: 'A2', kind: 'A', want: 'TSK-30 · 진행 로그(발표 접수)',
    text: '[진행판] TSK-30 「8/26 연구소 세미나 신청자 모집」\n전현빈 선임 세미나 주제 AI Slop: 쓰레기 속에서 보석 찾기 15분 예상.' },
  { id: 'A3', kind: 'A', want: 'TSK-25 · 소프트 마감 오늘 · 다음 행동',
    text: '[진행판] TSK-25 「[로드맵] B2A 레지스트리·마켓플레이스 목록 조사·준비 (DVERA, ALIRA)」\n오늘 오후2시 회의 전까지 준비' },
  { id: 'B1', kind: 'B', want: 'TSK-8(PAS 8800 백서) 를 스스로 찾아 진행 로그',
    text: '백서 초안 방향 서현지 책임한테 전달했습니다. 다음주에 중간 리뷰 볼 예정.' },
  { id: 'B2', kind: 'B', want: 'TSK-33(HCL 앱스캔) 를 찾아 상태 진행중 또는 로그',
    text: '앱스캔 조사 오늘 시작했어요.' },
  { id: 'B3', kind: 'B', want: '**모호함** — 어느 업무인지 되물어야 맞음',
    text: '아까 그 건 정리해서 넘겼습니다.' },
];

// MCP 서버는 붙이지 않는다(`skipMcp`) — 재려는 것은 판·업무 갱신이고 그 길은
// `tasks.py` 하나뿐이라 MCP 가 답을 바꾸지 않는다. 붙이면 실험마다 외부 서버가
// 깨어나 시간이 그쪽으로 새고, 그 편차가 모델 차이를 덮는다.
const sdk = new SdkHandler({ getServerConfiguration: () => ({}) });

async function run(model, effort, kase) {
  const tag = `${kase.id}-${model.split('-').slice(0, 2).join('')}-${effort}`;
  const dryLog = path.join(OUT, `${tag}.dry`);
  writeFileSync(dryLog, '');
  const started = Date.now();
  const out = { model, effort, ...kase, tag, cost: null, ms: null, reply: '',
                tools: 0, calls: [], error: null };
  try {
    const proc = sdk.runQuery(kase.text, {
      workingDirectory: WORKDIR,
      model,
      effort,
      permissionMode: 'auto',
      skills: 'all',
      appendSystemPrompt: SURFACE,
      noSessionPersistence: true,
      skipMcp: true,
      env: { WORK_ASSISTANT_DRY: '1', WORK_ASSISTANT_DRY_LOG: dryLog },
    });
    for await (const ev of proc) {
      if (ev.type === 'assistant') {
        for (const part of ev.message?.content ?? []) {
          if (part.type === 'tool_use') {
            out.tools += 1;
            // **세션의 말을 믿지 않는다.** 「기록했습니다」라고 하고 아무것도 안
            // 부른 판이 첫 시험에서 바로 나왔다 — 채점은 부른 명령으로 한다.
            out.calls.push(part.name === 'Bash'
              ? String(part.input?.command ?? '').replace(/\s+/g, ' ').slice(0, 200)
              : `${part.name} ${JSON.stringify(part.input ?? {}).slice(0, 90)}`);
          }
          if (part.type === 'text') out.reply += part.text;
        }
      } else if (ev.type === 'result') {
        out.cost = ev.total_cost_usd ?? null;
        out.ms = ev.duration_ms ?? (Date.now() - started);
      }
    }
  } catch (e) {
    out.error = String(e).slice(0, 200);
  }
  out.ms ??= Date.now() - started;
  out.dry = readFileSync(dryLog, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  rmSync(dryLog, { force: true });
  return out;
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const cases = CASES.filter((c) => !ONLY || c.kind === ONLY);
const total = MODELS.length * EFFORTS.length * cases.length;
console.log(`모델 ${MODELS.length} × 사고 ${EFFORTS.length} × 사례 ${cases.length} = ${total}회\n`);

const rows = [];
let n = 0;
for (const model of MODELS) {
  for (const effort of EFFORTS) {
    for (const kase of cases) {
      n += 1;
      process.stdout.write(`  [${String(n).padStart(2)}/${total}] ${kase.id} ${model} ${effort} … `);
      const r = await run(model, effort, kase);
      rows.push(r);
      console.log(
        `${(r.ms / 1000).toFixed(1)}초 · $${(r.cost ?? 0).toFixed(3)} · 도구 ${r.tools}회`
        + (r.error ? ` · 실패 ${r.error}` : ''),
      );
      writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(rows, null, 2));
    }
  }
}
console.log(`\n결과: ${path.join(OUT, 'result.json')}`);
