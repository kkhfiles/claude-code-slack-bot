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
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync,
         writeFileSync } from 'node:fs';
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
/*
 * ⚠️ **사례는 살아 있는 업무를 가리킨다 — 그 업무가 닫히면 낡는다.**
 * 2026-09-02 에 12건으로 넓혔다(6건 1회씩으로는 6/6 대 6/6 을 못 가른다).
 * 갈래마다 한 건씩 둔다 — 하드 마감을 새로 만드는가 · 마감과 내 차례를 같이
 * 쓰는가 · 안 시킨 날짜를 건드리는가 · 모호할 때 원문을 남기는가.
 * 2026-09-01 에 여섯 중 셋이 이미 완료된 업무를 가리키고 있었다(TSK-30·8·33).
 * 닫힌 업무는 세션이 못 찾으므로 **모델이 아니라 자료 탓으로 틀린다.**
 * 다시 돌리기 전에 볼트에서 `status` 를 확인한다.
 */
const CASES = [
  // ── A: 업무를 짚어 준 것 (판에서 온 말) ──────────────────────────────
  { id: 'A1', kind: 'A', want: 'TSK-61 · 소프트 마감 09/08(화) · **하드 마감을 새로 만들지 않음** · 진행 로그',
    text: '[진행판] TSK-61 「PAS 8800 백서 작성 진행 확인 (작성: 서현지 책임)」\n초안은 다음주 화요일까지 받기로 했습니다.' },
  { id: 'A2', kind: 'A', want: 'TSK-23 · 하드 마감이 이미 있으므로 그것을 09/14(월)로 옮김 · 연기 사유',
    text: '[진행판] TSK-23 「ax사업개발실 영업회의 — KAI 고객사 요구사항 논의」\n영업회의가 한 주 더 밀렸습니다.' },
  { id: 'A3', kind: 'A', want: 'TSK-50 · 소프트 마감과 내 차례를 **둘 다** 09/11(금) · 진행 로그',
    text: '[진행판] TSK-50 「SOSC 하반기 운영 변경 — 박정은 전임이 RT 담당 박승렬과 사전 점검」\n박정은 전임이 다음주 금요일 주간회의에서 결과 공유하기로 했습니다. 그때까지 제가 할 건 없습니다.' },
  { id: 'A4', kind: 'A', want: 'TSK-11 · 소프트 마감 09/04(금) **하나만** · 내 차례는 안 건드림 · 다음 행동',
    text: '[진행판] TSK-11 「CT 2026.12 회의 — 다음 할일·운영 방식 언질 준비」\n금요일 회의 전까지 정리해서 올리겠습니다.' },
  { id: 'A5', kind: 'A', want: 'TSK-16 · 소프트 마감 09/03(목) · 알림 09/03 15:00 · 다음 행동',
    text: '[진행판] TSK-16 「CT 2026.12 라이선스 정책 확정 (DVERA 호출 형태)」\n목요일 오후 3시에 정회운 팀장과 통화해서 정하기로 했습니다.' },
  { id: 'A6', kind: 'A', want: 'TSK-54 · 진행 로그만 · **날짜 칸을 하나도 안 건드림**',
    text: '[진행판] TSK-54 「GPT·Claude 프리미엄 시트 수요 조사」\n설문 초안 만들었습니다. 15명 정도 응답 예상.' },
  { id: 'A7', kind: 'A', want: 'TSK-49 · 상대가 쥐고 있고 돌아올 날을 모름 — 내 차례만 손대거나 로그만 · **마감을 새로 만들지 않음**',
    text: '[진행판] TSK-49 「KAI 상무 보고 자료 — CT 내용 검토·개선」\n최우혁 팀장이 자료 만드는 중입니다. 나오면 알려주기로 했습니다.' },
  { id: 'A8', kind: 'A', want: 'TSK-47 · 단계가 넘어갔으므로 제목을 바꿈 · 진행 로그 · 안 시킨 날짜는 안 건드림',
    text: '[진행판] TSK-47 「DR 회의 후속 — 실장 대상 설문 제작·devrel 공유」\n설문은 만들어서 공유 끝났고, 이제 회신 취합해서 분석하는 일이 남았습니다.' },
  // ── B: 업무를 안 짚어 준 것 (슬랙에 그냥 한 말) ───────────────────────
  { id: 'B1', kind: 'B', want: 'TSK-61(PAS 8800 백서) 를 스스로 찾아 진행 로그 · **안 시킨 날짜 칸을 안 건드림**',
    text: '백서 초안 방향 서현지 책임한테 전달했습니다. 다음주에 중간 리뷰 볼 예정.' },
  { id: 'B2', kind: 'B', want: 'TSK-20(하반기 평가지표) 를 찾아 진행 로그 (상태는 도구가 올림)',
    text: '평가지표 기준 오늘 두 번 리뷰했습니다.' },
  { id: 'B3', kind: 'B', want: '**모호함** — 캡처에 원문을 남기고 되물어야 맞음',
    text: '아까 그 건 정리해서 넘겼습니다.' },
  { id: 'B4', kind: 'B', want: 'TSK-11 을 완료로 · 얼마나 걸렸는지 같이 물음(막는 물음 아님) · 진행 로그',
    text: 'TSK-11 회의 자료 다 만들어서 공유했고 이 건은 종료합니다.' },
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

// ⚠️ **앞 판을 지우기 전에 옮겨 둔다** (2026-09-02). 그전에는 폴더를 통째로
// 날려서, 한 모델만 다시 재면 **다른 모델의 원본이 같이 사라졌다** — 실제로
// 났고(opus 24회분), 폴더 안에 손으로 떠 둔 사본까지 함께 지워졌다.
// 이 스크립트는 한 벌씩 나눠 돌리는 것이 정상 쓰임이라 그때마다 앞 판을 잃는다.
const prev = path.join(ROOT, '.bench-prev.json');
if (existsSync(path.join(OUT, 'result.json'))) {
  copyFileSync(path.join(OUT, 'result.json'), prev);
  console.log(`앞 판을 ${path.relative(ROOT, prev)} 로 옮겨 뒀습니다
`);
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
