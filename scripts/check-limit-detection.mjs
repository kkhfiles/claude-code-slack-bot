/**
 * 한도 판정 자가 검사 — 슬랙도 네트워크도 타지 않는다.
 *
 *   npm run build && node scripts/check-limit-detection.mjs
 *
 * **여기 본문은 지어낸 것이 아니라 실제로 오탐을 낸 그 글이다.** 2026-05-22 부터
 * 08-22 까지 「세션 리미트 초과」가 14번 떴는데 13번이 `subtype: success` 였고,
 * 그때마다 그룹 뒤쪽 분석이 통째로 안 돌았다(08-22 에는 kg-regression 광역 게이트를
 * 포함해 4종). 원인은 정상 완료한 세션의 **본문**을 정규식에 넣은 것이었다 —
 * 이 봇이 돌리는 분석의 주제가 「사용량·한도·실패」라 보고서가 잘 나올수록
 * `429`·`usage limit` 이 요약문에 들어간다.
 *
 * 그래서 이 검사는 **정상 완료한 글이 리미트로 읽히지 않는가**를 먼저 본다.
 */
import './lib/fresh-dist.mjs';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MOD = path.join(ROOT, 'dist', 'rate-limit-utils.js');

if (!fs.existsSync(MOD)) {
  console.error('dist 가 없습니다 — 먼저 `npm run build`');
  process.exit(1);
}

const { isSessionRateLimited, isRateLimitText } = require(MOD);

const fails = [];
const eq = (label, got, want) => {
  if (got !== want) fails.push(`${label}\n    받음 ${got}\n    기대 ${want}`);
};

// 2026-08-22 00:41 에 「세션 리미트 초과」를 띄운 바로 그 본문(로그 발췌).
// 보고서는 00:40 에 이미 쓰였고 세션은 27턴 만에 정상으로 끝났다.
const CLI_USAGE_08_22 = [
  '보고서가 생성됐습니다. 주요 분석 결과를 요약합니다.',
  '',
  '**2026-08-22 CLI 사용 분석 결과**',
  '',
  '**전체**: 4.5개월 2294건, 실패율 0.65% (15건).',
  '',
  '**실패 5종 재분류:**',
  '- ChromaDB 불안정(5건) · 인코딩(3건) · OpenAI 429(2건) → **모두 자연 해소**',
].join('\n');

// 브리핑·회의판단도 같은 함수를 쓴다. 한도를 다루는 글이 본문에 실릴 수 있다.
const BRIEFING_TEXT = '오늘의 브리핑 — cli-usage 보고서에 OpenAI 429 쿼터 초과 2건이 자연 해소로 정리됨.';
const REGULATION_TEXT = '사규 문의 답변: 초과근무 usage limit 관련 규정은 없습니다.';

eq('정상 완료한 분석 요약은 리미트가 아니다',
   isSessionRateLimited({ text: CLI_USAGE_08_22, isError: false }), false);
eq('정상 완료한 브리핑 본문은 리미트가 아니다',
   isSessionRateLimited({ text: BRIEFING_TEXT, isError: false }), false);
eq('정상 완료한 회의 판단 본문은 리미트가 아니다',
   isSessionRateLimited({ text: REGULATION_TEXT, isError: false }), false);

// 위 셋이 통과하는 이유가 「정규식이 못 찾아서」면 이 검사는 헛것이다.
// 본문에 낱말이 **실제로 들어 있는데도** 안 걸리는 것을 확인한다.
eq('그 본문에 낱말은 분명히 들어 있다', isRateLimitText(CLI_USAGE_08_22), true);
eq('브리핑 본문에도 들어 있다', isRateLimitText(BRIEFING_TEXT), true);

// 진짜 신호 — SDK 가 보내는 rate_limit_event(status: 'rejected')에서 세운 값.
eq('구조화 신호가 서면 본문과 무관하게 리미트',
   isSessionRateLimited({ rateLimited: true, text: '보고서 작성 완료' }), true);

// 옛 CLI 응답용 뒷문 — 에러일 때만 열린다.
eq('에러 + 한도 문구면 리미트',
   isSessionRateLimited({ isError: true, text: 'Claude usage limit reached. resets 3am' }), true);
eq('에러지만 한도와 무관하면 리미트 아님',
   isSessionRateLimited({ isError: true, text: 'ENOENT: no such file' }), false);
eq('에러 + 빈 본문은 리미트 아님',
   isSessionRateLimited({ isError: true, text: '' }), false);
eq('본문이 없어도 터지지 않는다', isSessionRateLimited({ isError: true }), false);
eq('빈 결말은 리미트 아님', isSessionRateLimited({}), false);

// `allowed_warning` 은 한도에 가까워졌다는 예고일 뿐 요청은 통과했다.
// 그 값은 `rateLimited` 를 세우지 않으므로 여기 입력은 false 로 온다.
eq('경고 단계는 리미트가 아니다',
   isSessionRateLimited({ rateLimited: false, isError: false, text: 'approaching usage limit' }), false);

// --- 소스 구조 검사 — 옛 모양이 되돌아오는 것을 막는다 -----------------------
//
// 위 단위 검사는 함수 하나가 맞게 판정하는지만 본다. 부르는 쪽이 그 함수를
// 안 쓰고 예전처럼 본문을 직접 훑으면 단위 검사는 통과한 채로 같은 사고가 난다.

const SRC_DIR = path.join(ROOT, 'src');
/** 주석을 지우고 본다 — 안 지우면 **금지 패턴을 설명하는 주석 자체가 위반으로
 *  걸린다**(실제로 처음 돌렸을 때 정의부 JSDoc이 걸렸다). 그러면 규칙을 적어 둘
 *  수가 없어지고, 사람은 검사를 끄는 쪽으로 간다. */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const sources = fs.readdirSync(SRC_DIR)
  .filter((f) => f.endsWith('.ts'))
  .map((f) => [f, stripComments(fs.readFileSync(path.join(SRC_DIR, f), 'utf-8'))]);

/** 소스에서 그 함수의 본문만 떼어 온다. 못 찾으면 멈춘다 — 조용히 빈 문자열을
 *  돌려주면 「위반 없음」이 아니라 「검사가 안 돌았다」가 된다. */
function body(src, name) {
  const head = src.search(new RegExp(`private (async )?${name}\\(`));
  if (head < 0) throw new Error(`${name}() 을 못 찾았다 — 이름이 바뀌었나`);
  const rest = src.slice(head + name.length);
  const next = rest.search(/\n {2}(private|public|\/\*\*)/);
  return next < 0 ? rest : rest.slice(0, next);
}

// ① **정상 완료한 세션의 본문을 정규식에 직접 넣지 않는다.** 이 한 줄이
//    2026-05~08 오탐 13회의 원인이었다. `catch` 로 받은 에러 메시지(`msg`)는
//    정당한 입력이라 건드리지 않는다.
for (const [name, text] of sources) {
  for (const m of text.matchAll(/isRateLimitText\(\s*([\w.]+)\s*\)/g)) {
    const arg = m[1];
    const ok = arg === 'msg' || arg === 'text' || arg === 'resultText'
      || arg === 'r.text' || arg.endsWith('?? \'\'');
    if (arg === 'result.text') {
      fails.push(`${name}: isRateLimitText(result.text) — 정상 완료한 본문을 훑고 있다.`
                 + ' isSessionRateLimited(result) 를 쓸 것');
    } else if (!ok) {
      fails.push(`${name}: isRateLimitText(${arg}) — 본 적 없는 입력이다. `
                 + '정상 완료한 본문이면 안 된다(사람이 확인할 것)');
    }
  }
}

// ② 세 소비처가 실제로 공용 판정을 쓰는가 — 규칙을 써 두는 것과 적용되는 것은 다르다.
const sched = fs.readFileSync(path.join(SRC_DIR, 'assistant-scheduler.ts'), 'utf-8');
const poller = fs.readFileSync(path.join(SRC_DIR, 'calendar-poller.ts'), 'utf-8');
if (!body(sched, 'runSingleAnalysis').includes('isSessionRateLimited('))
  fails.push('runSingleAnalysis() 가 공용 판정을 안 쓴다');
if (!body(poller, 'getAIJudgment').includes('isSessionRateLimited('))
  fails.push('calendar-poller 의 AI 판단이 공용 판정을 안 쓴다');
if (!sched.includes("this.logger.warn('Briefing hit rate limit')"))
  fails.push('브리핑 리미트 분기를 못 찾았다 — 이름이 바뀌었나');

// ③ **중단과 재개는 대칭이어야 한다.** 리미트로 그룹을 끊으면 그 뒤 타입은
//    「나중에 돌 것」이지 「없던 일」이 아니다. 2026-08-22 에 재시도 큐가 당사자만
//    담아서 보고서 4종(광역 회귀 게이트 포함)이 그 주에 통째로 사라졌다.
const group = body(sched, 'runAnalysisGroup');
if (!/deferredTypes\s*=\s*runnableTypes\.slice\(/.test(group))
  fails.push('runAnalysisGroup() 이 중단 뒤 잔여 타입을 안 세운다');
if (!/for \(const rest of deferredTypes\) failedRetryTypes\.push\(/.test(group))
  fails.push('잔여 타입이 재시도 큐에 안 들어간다 — 중단만 하고 재개를 안 한다');
if (!group.includes('중단으로 미실행'))
  fails.push('종료 메시지가 미실행 타입을 안 적는다 — 계획 대비 누락이 안 보인다');
// 큐가 1건에서 그룹 크기로 늘었으므로, 재시도 때 또 막히면 거기서 멈춰야 한다.
// 안 멈추면 한도가 안 풀린 창에서 그룹 전체를 그대로 낭비한다.
if (!/if \(r\.rateLimited\) \{ stoppedAt = i; break; \}/.test(group))
  fails.push('재시도가 또 막혀도 안 멈춘다 — 한도 미해제 창에서 큐 전체를 낭비한다');
if (!group.includes('한도가 안 풀려 미시도'))
  fails.push('멈춘 뒤 손도 안 댄 타입을 사람에게 안 알린다');

// ④ 산출물 백스톱 — 판정이 틀려도 일을 마친 세션은 완료로 둔다.
if (!body(sched, 'runSingleAnalysis').includes('reportWrittenSince('))
  fails.push('산출물 백스톱이 빠졌다 — 보고서를 낸 세션이 리미트로 찍힐 수 있다');
// 없으면 **보고**한다. 여기서 던지면 앞서 모은 위반이 화면에 못 뜬 채로 죽는다.
if (!sched.includes('private reportWrittenSince('))
  fails.push('reportWrittenSince() 가 없다 — 산출물 백스톱 자체가 빠졌다');
else if (!body(sched, 'reportWrittenSince').includes('mtimeMs'))
  fails.push('백스톱이 파일 존재만 본다 — 사람이 수동으로 돌려 둔 것을 성과로 센다');

if (fails.length) {
  console.log(`실패 ${fails.length}건\n`);
  for (const f of fails) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log('통과 — 한도 판정 (정상 완료 본문 · 구조화 신호 · 에러 뒷문 · 경고 단계'
            + ' · 소비처 배선 · 중단↔재개 대칭 · 산출물 백스톱)');
