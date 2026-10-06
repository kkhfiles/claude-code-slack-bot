import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn, execSync } from 'child_process';
import Holidays from 'date-holidays';
import { Logger } from './logger';
import { CalendarPoller } from './calendar-poller';
import { errorCollector } from './error-collector';
import { isRateLimitText, isSessionRateLimited } from './rate-limit-utils';
import { shouldUseSdk } from './sdk-handler';
import { listNasQueue, buildNasQueueBlocks } from './nas-confirm';
import { isWorkAssistantEnabled, briefNudge, quickUpdate,
  noteUpdate, stageUpdate, summaryCandidates, summaryApply,
  refreshBoardIfChanged, isQuietPeriod, sessionFocusWithin, currentStore,
  offsitePush, commitHarvest, remindDue, remindDone,
  workAssistantRoot, mailCandidates, mailMark, boardOutputToTell,
  offDays, ymd, narrowTask, narrowCard, narrowApply, narrowCodex, codexSession, codexWritableDirs,
  improveGather, improveAccept, improveShow, improvePosted, improveDecide } from './work-assistant';
import type { QuickOutcome } from './work-assistant';
import { buildImproveBlocks, improveEnabled, improvePreviewText,
  IMPROVE_DECISIONS, IMPROVE_ID_RE } from './improve-message';
import { boardLabel, boardPushAuthBroken, boardPushTarget, boardQueueEnabled, drain, event as recordEvent } from './board-queue';
import { BoardPush } from './board-push';
import type { ContactItem } from './board-queue';
import { config } from './config';
import { ladderEventLines, ladderTable, ladderText, sameTier } from './model-ladder';
import { ActionPipeline, parseWindow, reportLogAvailable, reportLogState, runReportLog } from './action-pipeline';

/**
 * 처리 제안 타이머 간격. **이 값이 곧 멈춘 제안이 다시 움직이기까지의 최대 시간이다** —
 * 사용량 한도가 풀린 뒤 · 병합 대기 한 시간 뒤. 밤 검토도 이 타이머가 시간대 안에서 시작한다.
 */
const ACTIONS_TICK_MS = 3_600_000;

/**
 * 열린 채 남은 분석 회차를 report-log 정리 작업(`sweep`)에 넘기는 간격과 기준.
 *
 * **6시간인 까닭** — 세션 한 번(최대 60~90분)에 러너 기다림(~2시간)을 더한 것보다 길어, 돌고 있는
 * 회차를 닫지 않는다. 한도로 멈춘 회차가 그 사이 `partial` 로 저장돼도 손해가 없다 — 이어받은 세션이
 * 임시 파일을 다시 쓰면 report-log 가 그 회차를 정상 저장한다(빈 임시 파일일 때만 「이미 저장」 으로
 * 돌려준다 · partial → complete 는 허용). 처리 제안 타이머와 따로 둔다 — 처리 제안을 꺼도 정리는 돌아야 한다.
 */
const RUN_SWEEP_MS = 3_600_000;
const RUN_SWEEP_OLDER_THAN_HOURS = 6;

/**
 * 업무 넛지 시각. 09:00 데일리 미팅 직전이라는 것이 이 값의 전부다 —
 * 설정으로 뺄 이유가 생기면 그때 뺀다.
 */
const WORK_NUDGE_TIME = '08:55';
/**
 * PC 밖으로 사본을 내보내는 시각. **그날 일이 끝난 뒤 한 번**이라 20:00 이다
 * (자정·정오는 이 PC 의 데이터 동기화 일정이지 백업에 맞는 시각이 아니다).
 *
 * **쉬는 날도 돈다** — 주말에도 판을 누르므로 일하는 날만 하면 그 사이가
 * 통째로 밖에 없다.
 */
const OFFSITE_PUSH_TIME = '20:00';
/**
 * 오후 체크인 넛지 시각. **진행이 들어오는 유일한 입구가 체크인인데**, 그것이
 * 「그날 첫 접촉」에만 걸려 있어 슬랙을 안 여는 날은 아무것도 안 들어왔다.
 *
 * 아침(08:55)은 어제 것을, 오후는 오늘 것을 묻는다 — **같은 질문을 두 번 밀지
 * 않는다.** 재촉은 무시를 부르고, 무시되기 시작한 장치는 죽는다.
 *
 * 17:00 인 이유: 하루가 끝나기 전이되 아직 자리에 있을 시각. 무시되기 시작하면
 * 시각을 옮기지 말고 **오후 것부터 끈다**(그게 이 값의 유일한 조정 방향이다).
 */
// 17:00 오후 체크인은 2026-08-26 에 걷었다 — 「칸반에서 항목 보고 업데이트
// 요청하는 것이 훨씬 자연스럽고 편해졌다 · 복잡한 건만 스탠리와 이야기」(사용자).
// 넛지할 것이 있으면 판이 깜빡인다(`alarm_tasks`). 되살리려면 그 판단부터 뒤집는다.
/**
 * 판 큐를 가져오는 간격. **이 값이 곧 무를 수 있는 시간이다** — 빠르게 만드는
 * 것과 무를 수 있는 것은 같은 손잡이의 양끝이라, 30초에서 5초로 내리며 무르기를
 * 내주었다(2026-08-13).
 *
 * 무르기를 내줘도 되는 이유: 상태는 **반대 버튼이 이미 있다**(완료를 잘못 눌렀으면
 * 대기를 누른다). 잃는 것은 「노션에 아예 안 쓰이게」뿐이고 실제 손해는 진행 로그
 * 한 줄이다. **연기만 예외** — 연기 횟수는 안 내려간다.
 *
 * 값이 싼 이유: 큐 객체는 요청을 처리하는 동안만 과금되고 놀 때는 재워 두므로,
 * 자주 물어도 실행 시간 기준 무료분의 1% 안쪽이다.
 *
 * **5초에서 2초로 내렸다** (2026-08-29). 칸반 기준으로 끝에서 끝까지 재 보니
 * 판에서 누른 뒤 카드가 바뀌기까지 버튼은 7.0초 · 프롬프트는 21.9초인데, 그중
 * **평균 2.5초를 여기서 그냥 기다리고 있었다**(주기의 절반). 2초면 평균 1.0초다.
 *
 * ⚠️ **1초로는 안 내린다** — 24시간 도는 타이머라 하루 86,400회가 되어 워커 무료
 * 한도 100,000회에 닿는다. 판을 여는 요청·지문 확인이 같은 한도를 쓴다.
 * 2초면 43,200회로 절반 아래에 머문다.
 *
 * ⛔ **그 절반 아래가 76%까지 찼다** (2026-09-01 Cloudflare 알림 · 재는 기간은
 * 08/30 UTC 로 **새 주기의 첫 온전한 하루**였다). 위 계산이 틀린 것이 아니라
 * **43,200 을 혼자 쓰는 것이 이미 컸다** — 하루의 43%를 아무도 판을 안 눌러도
 * 쓴다. 한도에 닿으면 워커가 실패하고 **판이 죽는다.**
 */
const BOARD_QUEUE_POLL_MS = 2_000;
/**
 * 자는 동안에는 이만큼 벌린다. **낮은 한 글자도 안 느려진다** — 잃는 것은
 * 새벽에 누른 것이 최대 30초 뒤에 반영되는 것뿐이고, 그 시간대에 판을 누르는
 * 일이 드물다.
 *
 * 07~23 을 2초로 두면 하루 **43,200 → 29,760회**(−31%). 더 줄여야 하면 다음
 * 손잡이는 **낮 주기**다(3초면 20,160회 · −53% · 누른 뒤 평균 0.5초 손해).
 * 밤을 아예 끄지 않는 이유는 폰으로 늦게 누른 것이 아침까지 안 가기 때문이다.
 */
const BOARD_QUEUE_NIGHT_MS = 30_000;
const BOARD_QUEUE_AWAKE_FROM = 7;
const BOARD_QUEUE_AWAKE_TO = 23;
/**
 * 알림 연결(`board-push.ts`)이 정상일 때의 안전망 주기 (2026-10-01). 판에서 누르면
 * 워커가 알림을 보내 바로 가져가므로, 묻는 것은 알림을 놓쳤을 때를 위한 것뿐이다.
 * 하루 29,760회 → 1,440회. **연결이 이상하면 위 2초·30초로 저절로 돌아간다.**
 */
const BOARD_QUEUE_PUSH_SAFETY_MS = 60_000;

/**
 * 지금 몇 초마다 봐야 하나. **타이머는 그대로 2초로 두고 이 값으로 건너뛴다** —
 * 주기를 갈아 끼우면 시각이 바뀌는 순간 타이머를 다시 걸어야 하고, 다시 거는
 * 자리는 `clearAllTimers()` 와 짝이 안 맞으면 조용히 사라진다(`check:timers` 가
 * 세는 그 구멍이다). 건너뛰기는 짝이 하나뿐이라 그 위험이 없다.
 */
export function boardQueueGapMs(now: Date = new Date(), pushHealthy = false): number {
  // **알림 연결이 정상이면 안전망만 남긴다** — 새것은 알림이 바로 깨워 가져가고, 이
  // 주기는 알림을 놓쳤을 때 늦어도 이만큼 뒤에 줍는 몫이다(GPT 6.1 sol 검토 · 2026-10-01).
  if (pushHealthy) return BOARD_QUEUE_PUSH_SAFETY_MS;
  const h = now.getHours();
  const awake = h >= BOARD_QUEUE_AWAKE_FROM && h < BOARD_QUEUE_AWAKE_TO;
  return awake ? BOARD_QUEUE_POLL_MS : BOARD_QUEUE_NIGHT_MS;
}

/** 이 주기로 하루를 돌면 워커 요청이 몇 번인가. 검사가 천장을 이 값으로 본다.
 *  **알림 연결이 끊긴 날이 기준**이다 — 그날도 한도 안에 있어야 한다. */
export function boardQueueDailyCalls(): number {
  const awakeH = BOARD_QUEUE_AWAKE_TO - BOARD_QUEUE_AWAKE_FROM;
  return Math.round(awakeH * 3600_000 / BOARD_QUEUE_POLL_MS
    + (24 - awakeH) * 3600_000 / BOARD_QUEUE_NIGHT_MS);
}
/**
 * 메일을 얼마마다 보나 · 몇 시부터 몇 시까지 (2026-08-18 사용자 결정).
 *
 * **한 번 보는 데 1.3초**라 이 간격이 싼 것은 아니다 — Outlook 을 그냥 읽고
 * 망을 안 탄다. 비싼 것은 **후보가 나왔을 때 띄우는 세션**이고, 그것은
 * 하루 여섯 번쯤이다(거르개 통과가 하루 대여섯 통).
 *
 * 창 밖에는 숨만 돌고 아무것도 안 한다. 「조용히」 기간은 파이썬이 막는다.
 *
 * **쉬는 날에는 말을 안 건다** (2026-08-21 사용자 결정). 전에는 임원 메일이
 * 주말에도 온다는 이유로 가리지 않았는데, 그것 때문에 **건강검진일에 후보가
 * 세 번 나갔다.** 메일은 쌓아 두는 것이 안전하다 — 넘기기가 성공해야 표시가
 * 옮겨지므로 **안 넘기면 그대로 남아 있다가 다음 업무일에 한꺼번에 나온다.**
 * 거슬러 읽는 상한이 7일이라 나흘짜리 연휴까지는 통째로 들고 온다.
 *
 * 그래서 첫 회차를 **8시**로 내렸다 — 브리핑과 같은 시각이라 쉬는 날에 쌓인
 * 것이 아침 한자리에서 같이 읽힌다. 7시는 사람이 아직 화면 앞에 없는 시각이라
 * 한 시간 일찍 나가는 값이 없었다.
 */
const MAIL_POLL_MS = 600_000;
const MAIL_POLL_FROM_HOUR = 8;
const MAIL_POLL_TO_HOUR = 20;
/** 보고서 파일 시각을 세션 시작과 견줄 때의 여유 — `reportProduced` 참조. */
const MTIME_SLACK_MS = 50;
/**
 * 시각 알림을 보는 간격. **이 값이 곧 늦게 울릴 수 있는 최대 시간이다** —
 * 「11시에」 부탁한 것이 11:02 에 오는 것은 괜찮지만 11:10 은 늦다.
 *
 * 다음 울릴 시각을 계산해 한 번만 예약하는 편이 싸 보이지만, 그러면 **그 사이에
 * 새로 걸린 알림을 못 본다** — 예약을 다시 잡을 자리가 어디에도 없다(판에서도
 * 세션에서도 걸 수 있다). 되풀이해 보는 값이 그 구멍보다 싸다.
 *
 * ⚠️ **2분은 늦었다** (2026-09-22 사용자 「정시에 오지 않는다」). 실측 — 알림이
 * `08:38` 인데 울림 자국이 `08:39:10` 이었다(70초). 임의 시각에 시작하는
 * 되풀이라 **0~2분 늦고 평균 1분**이다.
 *
 * **값은 재 보고 정했다** — 한 번 도는 데 **0.17초**다(세션을 안 띄우고 볼트만
 * 읽어 돈이 안 든다). 30초면 12시간에 1,440번 · 합쳐 4분 남짓이라 1% 아래고,
 * 늦는 폭은 ≤30초가 된다. 「그 시각에 울린다」는 이름값은 그 정도면 한다.
 */
const REMIND_POLL_MS = 30_000;
const REMIND_FROM_HOUR = 8;
const REMIND_TO_HOUR = 20;
/**
 * 노션이 직접 고쳐졌는지 보는 간격. **이 값이 곧 화면이 낡아 있을 수 있는
 * 최대 시간이다.** 안 바뀌었으면 1행 질의(0.5초)로 끝나므로 짧게 잡아도
 * 싸다 — 3분이면 하루 160회, 노션 한도(초당 3회 평균) 근처에도 못 간다.
 */
const NOTION_WATCH_MS = 180_000;
/**
 * 판 맨 위 한 줄을 갱신하는 창. 업무일 **07·09·11·13·15·17·19시** 일곱 번.
 *
 * **여기만 돈이 든다.** 앞의 폴러들은 파일·HTTP 한 번이지만 이쪽은 세션 하나다.
 * 실제로 얼마 나갔는지는 `.assistant-costs.json` 의 `focus` 항목으로 센다.
 * **추정하지 말고 거기서 본다** — 첫 두 회 실측 **$0.93/회**로 추정($0.10~0.15)의
 * 여섯 배였다. 한 줄 쓰는 데 든 것이 아니라 **들고 시작한 문맥**이 컸다(캐시 쓰기
 * 7.7만 토큰). 그래서 이 세션은 보이는 도구를 두 개로 줄인다.
 *
 * **두 시간 간격인 이유는 시간이 흐르면 답이 바뀌기 때문이다.** 업무가 그대로여도
 * 오전 9시의 「오늘 안에 되는 것」과 오후 5시의 그것이 다르다. 매시간까지는 필요
 * 없다고 봤다 — 한 시간 만에 뒤집히는 판단이면 그건 판단이 아니라 소음이다.
 */
const FOCUS_FROM_HOUR = 7;
const FOCUS_TO_HOUR = 19;
const FOCUS_EVERY_HOURS = 2;
/**
 * 짧은 판단이지만 **틀리면 하루의 첫 결정이 틀어진다.** 모델 실험(2026-08-13)에서
 * 이 방의 판단은 `opus` + `low` 가 정확도·시간 모두 앞섰고, 같은 성격이라 그대로
 * 쓴다 — 「깊게 생각할 것은 적고 무엇을 고를지는 정확해야 하는」 자리다.
 */
const FOCUS_MODEL = 'opus';
const FOCUS_EFFORT = 'low' as const;

/**
 * 카드 요약 — **업무일 하루 한 번, 묶어서 한 호출.**
 *
 * ⚠️ **값을 정하는 것은 업무 수가 아니라 호출 수다**(2026-08-25 실측). 도구를
 * 다 끄고 설정도 안 읽는데 호출마다 밑바탕 6만 토큰이 실린다 — 재료는 2~5천
 * 토큰뿐이라, 건마다 부르면 그 밑바탕 값을 건 수만큼 낸다.
 *
 *   한 건씩 sonnet $0.238/건 · 5건 묶음 sonnet $0.250(건당 $0.050)
 *   → 하루 한 번 몰아서 약 $5/월 · 로그 붙을 때마다면 $16~26/월
 *
 * **벌은 sonnet**(2026-08-25 사용자). haiku 는 절반값인데 두 줄이 15~20자로
 * 짧아 카드가 이미 아는 것만 말했다.
 */
const SUMMARY_TIME = '19:30';
/**
 * 좁은 길 — 판의 「프롬프트」를 세션 없이 한 호출로 처리한다.
 *
 * **판 번호가 여기 한 줄이다.** 사본을 안 만든다 — 만들면 실험 기록과 갈라지고
 * 둘 중 하나는 반드시 낡는다. 다음 판을 올리는 일 = 이 줄을 고치는 일.
 *
 * `BOARD_NARROW=off` 로 끈다. 끄면 오늘까지와 완전히 같은 길(세션)로 돈다.
 *
 * **narrow12** (2026-10-01) — narrow10 에 「짧게 쓴다」 절 하나를 더했다. 99건 짝 비교에서
 * 정확도 같고 출력 −30% · 끝까지 −0.6초. 되돌리는 기준(work-assistant `docs/design.md`
 * 「확정 전 마지막 시험」): 틀린 반영이 한 건이라도 확인되거나 최근 50건에서 다음 행동·제목
 * 놓침이 5%p 넘게 늘면 이 줄을 narrow10 으로 되돌린다.
 */
const NARROW_RULES = 'lab/board-prompt/narrow12.md';
const NARROW_MODEL = 'opus';
const NARROW_EFFORT = 'low' as const;

const SUMMARY_MODEL = 'sonnet';
const SUMMARY_EFFORT = 'low' as const;
/**
 * 한 호출에 넣는 업무 수 상한. 넘치면 **남은 것은 내일 나온다** — 밀린 첫
 * 회차(23건)가 프롬프트를 통째로 부풀리지 않게 하는 문이다. 잘랐으면 로그에
 * 남긴다(조용히 자르면 「다 했다」로 읽힌다).
 *
 * ⚠️ **값보다 시간이 먼저 걸린다** — 12건이 161초였다(실측). 평소는 3~5건이라
 * 30~60초지만 밀린 회차는 상한에 닿으므로 아래 `maxDurationMs` 에 여유를 둔다.
 */
const SUMMARY_MAX = 10;

/**
 * 매일 개선 제안 — 업무일 06:30 에 만들고 08:00 브리핑 뒤에 올린다(2026-10-02 사용자).
 * 구독 세션 하루 한 번 · sonnet · 사고 낮음 · 도구 없음(재료는 본문 · 답은 JSON 글).
 * 켜는 문 `DAILY_IMPROVE=on`(기본 꺼짐 · `improve-message.ts`).
 */
const IMPROVE_TIME = '06:30';
const IMPROVE_MODEL = 'sonnet';
const IMPROVE_EFFORT = 'low' as const;

/**
 * 요약 세션이 돌려준 글 → `{업무 번호: 요약}`.
 *
 * **울타리를 관대하게 벗긴다** — 프롬프트가 코드 울타리를 붙이지 말라고 하지만
 * 붙여 오는 회차가 반드시 생기고, 그때 통째로 버리면 그날 요약이 하나도 안
 * 들어온다. 첫 `{` 와 마지막 `}` 사이만 본다.
 *
 * **모양이 아니면 `null`** — 빈 객체와 갈라야 부르는 쪽이 「형식이 어긋났다」와
 * 「쓸 것이 없다」를 다르게 말할 수 있다.
 */
/** 업무 하나에 대한 답. **요약뿐이다.**
 *
 * 제목은 2026-08-26 에 뺐다 — 「기존 항목에 모두 자동 적용할 필요는 없고,
 * 프롬프트로 업데이트 요청 시 자체 판단」(사용자). 이름을 바꾸는 자리는
 * 프롬프트를 받은 세션 하나이고, `tasks.py summary --apply` 는 `title` 이
 * 실려 와도 버린다. 여기서도 안 나른다 — 안 닿는 값을 나르면 다음에 읽는
 * 사람이 제목이 이 길로 흐른다고 읽는다.
 */
export interface SummaryReply {
  summary: string;
}

export function parseSummaryReply(text: string): Record<string, SummaryReply> | null {
  const s = text.indexOf('{');
  const e = text.lastIndexOf('}');
  if (s < 0 || e <= s) return null;
  try {
    // 잘라 낸 것은 **늘 `{` 로 시작해 `}` 로 끝난다** — 그러면 `JSON.parse` 는
    // 객체를 주거나 던지거나 둘 중 하나다. 배열·기본값을 거르는 문을 뒀었는데
    // 변이 시험에서 **한 번도 안 걸리는 줄**로 드러나 걷었다(2026-08-25).
    const d = JSON.parse(text.slice(s, e + 1)) as Record<string, unknown>;
    // 모양이 어긋난 값은 **그 칸만 버린다** — 한 칸이 이상하다고 나머지 열한
    // 건을 같이 버리면 그날 요약이 통째로 없어진다.
    //
    // **글자 하나로 온 것도 받는다** — 덩이가 아니라 요약 문자열만 온 모양이다.
    // 안 받으면 모델이 그 모양으로 답한 날은 그날치가 통째로 사라지는데,
    // 뜻이 어긋나지 않으므로 받아 주는 편이 싸다.
    const out: Record<string, SummaryReply> = {};
    for (const [k, v] of Object.entries(d)) {
      if (typeof v === 'string') { out[k] = { summary: v }; continue; }
      if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
      const o = v as Record<string, unknown>;
      if (typeof o.summary !== 'string') continue;
      // `title` 이 실려 와도 버린다 — 위 주석 참고.
      out[k] = { summary: o.summary };
    }
    return out;
  } catch {
    return null;
  }
}

export interface AssistantConfig {
  briefing: {
    time: string;        // "HH:MM"
    enabled: boolean;
    calendars?: string[];  // Deprecated: ignored, all calendars are fetched
    excludeCalendars?: string[];
    maxBudgetUsd?: number;
  };
  reminders: {
    beforeMinutes: number;
    pollingIntervalMinutes: number;
    enabled: boolean;
    workingHoursStart: string;  // "HH:00"
    workingHoursEnd: string;    // "HH:00"
    maxBudgetUsd?: number;
  };
  analysis: {
    schedule: string;    // "saturday-03:00"
    deliveryTime: string;
    budgetUsd?: number;
    defaults: {
      sessionBudgetUsd: number;
      allowedTools: string[];
      writablePaths: string[];
      maxDurationMinutes?: number;
      maxRetries?: number;
    };
    types: Record<string, {
      enabled: boolean;
      schedule?: string;           // per-type schedule override (e.g. "daily-02:00")
      cadence?: 'weekly' | 'biweekly' | 'monthly';  // default 'weekly'
      cadenceFrom?: string;        // biweekly anchor date (ISO YYYY-MM-DD)
      monthlyWeek?: 'first' | 'last';  // monthly: which week's Saturday
      mode?: 'change-detection';   // reports optional (no-file-generated is OK)
      /** 산출물 없음이 정상인 종류 — 조용한 날 · 변경 없는 달(`noOutputOkType` 참조). */
      noOutputOk?: boolean;
      tools?: string[];            // type-specific data (e.g. competitors.tools)
      allowedTools?: string[];
      writablePaths?: string[];
      sessionBudgetUsd?: number;
      maxDurationMinutes?: number;
      maxRetries?: number;
      [key: string]: unknown;
    }>;
  };
  /**
   * 처리 제안(report-log). **분석 종류로 두지 않는다** — 완주 검사가 분석 종류마다 보고서
   * 파일을 찾아 매일 「산출물 없음」을 낸다. 절이 없으면 타이머가 꺼지고 버튼 · 요약은 그대로 돈다.
   */
  actions?: {
    enabled?: boolean;        // 한 시간 타이머(이어 가기)
    nightlyReview?: boolean;  // 같은 타이머가 밤 검토도
    reviewWindow?: string;    // "02:00-07:00" — 이 안에서만 새 검토를 시작
  };
}

/** 분석 한 종을 돌린 결과. `resetsAt` 은 리미트가 풀리는 시각(epoch sec)으로,
 *  있으면 재시도를 그 시각 기준으로 잡는다(없으면 종전대로 다음 정시+5분). */
export interface AnalysisRunResult {
  rateLimited: boolean;
  timedOut: boolean;
  /** 세션이 도구 0회로 두 번 다 되묻고 끝남 — 산출물 없음. `completed` 로 적지 않는다. */
  noOutput?: boolean;
  sessionId?: string;
  costUsd: number;
  resetsAt?: number;
  /** 이 회차를 처리한 백엔드(`SessionResult.servedBy`). 세션을 안 띄웠으면 없다. */
  servedBy?: Backend;
  /** 이번 세션이 보고서를 냈나(`reportProduced`) — 저장 때 `--partial` 을 가른다. */
  produced?: boolean;
}

// ── report-log 회차 (5단계 — 쓰는 쪽) ────────────────────────────────
//
// 저장 주체는 스탠리 하나다(report-log `docs/stage5-plan.md` 「쓰는 흐름」). 스탠리가 회차를
// 열어 임시 파일 경로를 받고 → 세션 · 러너는 그 파일에 쓰기만 하고 → 스탠리가 결과에 따라
// 저장한다. 예정일 · 파일 이름은 스케줄이 정한다(모델이 정하지 않는다).

/** 로컬 서버 `POST /trigger?type=@group` — 종류 하나가 아니라 기본 스케줄 그룹을 수동으로. */
export const TRIGGER_GROUP = '@group';

/** 회차의 시작 방식. `retry` 는 원래 회차를 못 연 채 재시도 큐에서 처음 돌 때만 쓴다. */
export type RunTrigger = 'scheduled' | 'retry' | 'manual';

/** 열린 회차 하나 — `report_log.py open` 의 답. */
export interface ReportRun {
  runId: string;
  /** 임시 파일 — 세션 · 러너가 여기에 쓴다. */
  out: string;
  type: string;
  slot: string;
}

/** 분석 한 종을 돌릴 때의 회차 문맥. 회차를 못 열었으면 `run` 이 없다(예정일은 남는다). */
export interface AnalysisCtx {
  slot: string;
  run: ReportRun | null;
}

/** 시각의 한국 날짜(YYYY-MM-DD). 봇이 도는 PC 의 시간대와 무관하게 +9시간으로 센다. */
export function kstDate(d: Date): string {
  return new Date(d.getTime() + 9 * 3600_000).toISOString().slice(0, 10);
}

/** 날짜(YYYY-MM-DD)를 며칠 옮긴다. */
export function shiftDate(ymdText: string, days: number): string {
  const t = Date.parse(`${ymdText}T00:00:00Z`) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/** 러너가 쓴 기계본 표식 — 판정 세션이 지운다. report-log `PENDING_MARK` 와 같은 글자. */
export const PENDING_MARK = '<!-- judgment: pending -->';
/** 판정 세션이 채워야 하는 자리표시자가 남았다는 표식 — report-log `INCOMPLETE_MARKERS` 와 같다. */
const INCOMPLETE_MARKERS = ['_(filled in by'];
const FRONT_MATTER_RE = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;

/**
 * **이번 세션이 보고서를 냈나** — 「썼나」 판정. 셋 다 맞아야 한다.
 *
 *   - 임시 파일 수정 시각 ≥ 세션 시작 — 존재만 보면 앞 시도 · 앞 세션이 남긴 것을 이번 성과로 센다
 *   - 머리말을 뺀 본문이 있음
 *   - 대기 표식 · 자리표시자가 없음 — 러너가 쓴 기계본(대기 표식)이나 audit 의 빈 해설
 *     (자리표시자)은 세션이 판정을 얹기 **전** 모양이다. report-log 가 `complete` 로 저장할
 *     본문만 「냈다」로 친다(그쪽 `status_of` 와 같은 규칙 — 두 곳의 판정이 갈리지 않게).
 *
 * 감시가 감시 대상을 죽이면 안 되므로 어떤 예외도 밖으로 내보내지 않는다(못 읽으면 「안 냄」).
 */
export function reportProduced(out: string, sinceMs: number): boolean {
  try {
    // 여유 50ms — 파일 시각이 시계보다 이르게 찍힌다(실측 2026-09-29: 시계를 읽고 바로 쓴 파일
    // 2,000번 중 481번이 최대 1.52ms 앞섬). 없으면 세션 직후 쓴 보고서를 「전 것」으로 읽는다.
    if (fs.statSync(out).mtimeMs < sinceMs - MTIME_SLACK_MS) return false;
    const body = fs.readFileSync(out, 'utf-8').replace(FRONT_MATTER_RE, '');
    if (!body.trim()) return false;
    if (body.includes(PENDING_MARK)) return false;
    return !INCOMPLETE_MARKERS.some((k) => body.includes(k));
  } catch {
    return false;
  }
}

/** 임시 파일에 머리말을 뺀 본문이 없나(없는 파일 포함). */
export function outIsEmpty(out: string): boolean {
  try {
    return !fs.readFileSync(out, 'utf-8').replace(FRONT_MATTER_RE, '').trim();
  } catch {
    return true;
  }
}

/** 회차가 끝난 모양 — 저장 여부를 가른다(「쓰는 흐름」 5번). */
export type RunEnd =
  | 'completed'   // 세션이 정상으로 끝남(한도 백스톱으로 완료가 된 것 포함)
  | 'resume'      // 한도로 멈췄고 재시도가 이어받을 예정
  | 'failed'      // 마지막 시도까지 실패 · 타임아웃 · 더 이어받지 않는 한도 · 세션을 못 띄움
  | 'no-output'   // 두 번 다 되묻고 끝남
  | 'not-tried';  // 재시도 큐에서 한도가 안 풀려 손도 안 댐

/**
 * 저장할지 · `--partial` 을 붙일지. `null` 이면 **저장하지 않는다** — 정리 작업(`sweep`)의 몫.
 *
 *   - 이어받을 예정 · 손도 안 댐 → 저장 안 함(저장하면 회차가 닫히고 임시 파일이 지워져,
 *     이어받은 세션이 마저 쓴 것을 저장할 회차가 없다)
 *   - 러너 종류인데 임시 파일이 비었음 → 저장 안 함. 러너가 아직 기계본을 쓰는 중일 수 있고,
 *     지금 저장하면 `no-output` 으로 닫혀 뒤에 온 기계본이 버려진다(sweep 이 `machine` 으로 받는다)
 *   - 임시 파일이 비었음 → `--partial` 없이 저장 — report-log 가 `no-output` 으로 닫는다. 변경이
 *     없으면 안 쓰는 것이 정상인 종류(`noOutputOkType`)의 조용한 회차가 이 길이다
 *   - 완료이고 이번 세션이 냈음 → 그대로 저장(상태는 report-log 가 본문으로 가름)
 *   - 그 밖(실패 · 되물음 · 완료인데 이번 세션이 안 냄 — 내용은 있음) → `--partial`. 앞 시도가 남긴
 *     반쪽은 `partial` 로, 대기 표식이면 report-log 가 `machine` 으로 닫는다
 */
export function commitPlan(
  end: RunEnd, s: { runner: boolean; empty: boolean; produced: boolean },
): { partial: boolean } | null {
  if (end === 'resume' || end === 'not-tried') return null;
  if (s.runner && s.empty) return null;
  if (s.empty) return { partial: false };
  return { partial: !(end === 'completed' && s.produced) };
}

/**
 * 산출물 없음이 정상인 종류인가 — 설정의 `noOutputOk: true`(5단계 · 조용한 날 · 변경 없는 달) 또는
 * 옛 표기 `mode: 'change-detection'`. 이 종류는 빈 임시 파일이 실패가 아니라 `no-output` 이다.
 */
export function noOutputOkType(cfg: { noOutputOk?: unknown; mode?: unknown } | undefined): boolean {
  return cfg?.noOutputOk === true || cfg?.mode === 'change-detection';
}

/**
 * 저장 결과 한 마디 — 완료 메시지의 종류 옆 · 수동 결과 꼬리. 사람이 「돌았나」 와 「저장됐나」 를
 * 한 줄에서 갈라 읽게 한다(X1 #5 — 저장이 거부돼도 ✅ 로 끝나던 것).
 */
export function saveTag(run: ReportRun | null, saved: any | null, end?: RunEnd): string {
  if (!run) return '회차 없음';
  if (!saved) return end === 'resume' ? '저장 보류 → 재시도' : '저장 안 함 → sweep';
  if (saved.error) return `저장 실패${saved.code ? `(${saved.code})` : ''}`;
  return `저장 ${saved.status ?? '?'}`;
}

/** report-log 쓰기 잠금 실패인가 — 그때만 저장을 한 번 더 부른다. */
function isLockError(r: any): boolean {
  return r?.code === 'lock' || /잠금|\block\b/i.test(String(r?.error ?? ''));
}

/**
 * 분석 세션의 쓰기 허용 목록 — 설정의 `writablePaths` 에서 옛 보고서 폴더(`reports/`)를 빼고
 * 임시 파일 폴더를 더한다. 세션이 옛 경로에 쓰면 아무도 안 읽어 조용히 유실된다(5단계).
 * `reports/eval/` 같은 하위 폴더는 설정에 적혀 있으면 그대로 둔다.
 */
export function analysisWritable(writablePaths: string[], tmpDir: string): string[] {
  const old = (p: string) => slashPath(p).replace(/\/+$/, '') === 'reports';
  return [...writablePaths.filter((p) => !old(p)), slashPath(tmpDir)];
}

/** 회차를 세션 · 러너에 알리는 환경 변수(약속: `REPORT_RUN` · `REPORT_OUT` · `REPORT_SLOT` · `REPORT_TYPE`). */
export function reportRunEnv(run: ReportRun): Record<string, string> {
  // 경로는 `/` 로 — 프롬프트의 `{{REPORT_OUT}}` 과 같은 글자(셸 명령에 그대로 넣어도 역슬래시가 안 먹힌다).
  return { REPORT_RUN: run.runId, REPORT_OUT: slashPath(run.out), REPORT_SLOT: run.slot, REPORT_TYPE: run.type };
}

/**
 * 러너를 띄울 인자 · 폴더 · 환경. `--date <예정일>` 은 늘 붙인다 — 러너의 중복 기동 가드가 그
 * 날짜로 판단한다(다른 날 재시도가 그날 것을 새로 띄우지 않게). 회차가 있으면 `REPORT_*` 로
 * 알리고(러너는 기계본을 그 임시 파일에 쓰고 저장하지 않는다), 없으면 지운다 — 러너의 명령줄
 * 진입점이 스스로 회차를 연다.
 */
export function runnerLaunch(
  spec: { argv: string[]; cwdSub?: string }, workingDir: string, ctx: AnalysisCtx,
): { args: string[]; cwd: string; env: NodeJS.ProcessEnv } {
  const env: NodeJS.ProcessEnv = { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8' };
  for (const k of ['REPORT_RUN', 'REPORT_OUT', 'REPORT_SLOT', 'REPORT_TYPE']) delete env[k];
  if (ctx.run) Object.assign(env, reportRunEnv(ctx.run));
  return {
    args: ['-X', 'utf8', ...spec.argv, '--date', ctx.slot],
    cwd: spec.cwdSub ? path.join(workingDir, spec.cwdSub) : workingDir,
    env,
  };
}

/** 경로를 `/` 로 — 세션이 Bash 로 넘길 때 역슬래시가 이스케이프로 먹히지 않게(윈도에서도 파이썬 · Write 는 `/` 를 받는다). */
export function slashPath(p: string): string {
  return p.replace(/\\/g, '/');
}

// ── 프롬프트 자리 ────────────────────────────────────────────────────
//
// 값은 **프롬프트 본문에 직접** 넣는다 — Codex 폴백은 환경 변수를 못 받는다. 직전 보고서 ·
// 피할 권고를 세션이 읽게 두지 않고 여기서 넣는 까닭은 Bash 가 없는 종류(6종)도 받게 하려는 것이다.

/**
 * 이름 모양의 자리 — `{{REPORT_OUT}}` · `{{SLOT}}` · `{{PREV_REPORT}}` · `{{AVOID_LIST}}` · `{{WEEK_INPUT}}`,
 * 그리고 다른 종류의 직전 보고서 `{{PREV_REPORT:<종류>}}`(예: skill-review 가 session-efficiency 것을 본다).
 */
const PLACEHOLDER_RE = /\{\{([A-Z_]+(?::[a-z0-9]+(?:-[a-z0-9]+)*)?)\}\}/g;
/** 틀에 있는 `{{PREV_REPORT:<종류>}}` 의 종류들. */
const NAMED_PREV_RE = /\{\{PREV_REPORT:([a-z0-9]+(?:-[a-z0-9]+)*)\}\}/g;
/** 직전 보고서 본문을 프롬프트에 넣는 상한(글자) — report-log `prompt-context --max-chars` 기본값과 같다. */
const PREV_REPORT_MAX = 12_000;

/**
 * 틀의 자리를 값으로 채운다. `left` 는 **못 채운 자리** — 값이 없는 이름과 이름 모양이 아닌 `{{`.
 *
 * 판정은 틀에서 한다 — 넣은 값(직전 보고서 본문 등) 안에 `{{` 가 있어도 세지 않는다. 한 번에
 * 바꾸므로 넣은 값 안의 자리 이름이 다시 바뀌지도 않는다.
 */
export function fillPrompt(template: string, values: Record<string, string | undefined>): { text: string; left: string[] } {
  const text = template.replace(PLACEHOLDER_RE, (whole, name: string) => values[name] ?? whole);
  const residue = template.replace(PLACEHOLDER_RE, (whole, name: string) => (values[name] === undefined ? whole : ''));
  const left = [...new Set(residue.match(/\{\{[^}\n]{0,40}\}{0,2}/g) ?? [])];
  return { text, left };
}

/** `prompt-context` 의 `prev` → 읽을 수 있는 마크다운. 없으면 첫 회차라고 적는다. */
export function renderPrevReport(prev: any): string {
  if (!prev) return '(직전 보고서 없음 — 이 종류의 첫 회차입니다)';
  let body = String(prev.body ?? '').trim();
  if (body.length > PREV_REPORT_MAX) {
    body = `${body.slice(0, PREV_REPORT_MAX)}\n\n…(뒤 ${body.length - PREV_REPORT_MAX}자 생략)`;
  }
  const head = [`- 판: ${prev.id ?? '?'} · 예정일 ${prev.slot ?? '?'} · 상태 ${prev.status ?? '?'}`];
  if (prev.title) head.push(`- 제목: ${prev.title}`);
  return `${head.join('\n')}\n\n${body || '(본문 없음)'}`;
}

const AVOID_STATE_LABEL: Record<string, string> = { rejected: '거절', held: '보류' };

/** `prompt-context` 의 `avoid` → 목록. 비었으면 없다고 적는다. */
export function renderAvoidList(avoid: any): string {
  if (!Array.isArray(avoid) || avoid.length === 0) return '(피할 권고 없음)';
  return avoid.map((a: any) => {
    const state = AVOID_STATE_LABEL[a?.state] ?? a?.state ?? '?';
    return `- ${a?.id ?? '?'} · ${state} · ${a?.title ?? ''}`.trimEnd();
  }).join('\n');
}

/**
 * 마크다운 제목을 `by` 단계 내린다(최대 6단계) — 끼워 넣은 글의 제목이 바깥 목록의 머리와 같은
 * 단계로 읽히지 않게. 코드 울타리(```) 안은 건드리지 않는다.
 */
export function demoteHeadings(text: string, by = 2): string {
  let fenced = false;
  return text.split('\n').map((line) => {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; return line; }
    if (fenced) return line;
    return line.replace(/^(#{1,6})(?=\s)/, (h) => '#'.repeat(Math.min(6, h.length + by)));
  }).join('\n');
}

/**
 * `week-input` → 그 주 판 목록. 판마다 `## ` 머리 한 줄(종류 · 예정일 · 상태 · 제목)과 「권장 액션」 절
 * 원문 — 원문 안의 제목(`### 즉시` 등)은 두 단계 내려(`#####`) 판 머리 아래로 들어가게 한다.
 * 모양을 못 알아보면 JSON 그대로 싣는다 — 버리면 다이제스트가 빈 주로 읽는다.
 */
export function renderWeekInput(w: any): string {
  const list = Array.isArray(w) ? w
    : ['versions', 'items', 'reports'].map((k) => w?.[k]).find(Array.isArray);
  if (!list) return '```json\n' + JSON.stringify(w, null, 1) + '\n```';
  if (list.length === 0) return '(이 기간에 저장된 판 없음)';
  return list.map((v: any) => {
    const head = `## ${v?.type ?? '?'} · ${v?.slot ?? '?'} · ${v?.status ?? '?'}${v?.title ? ` — ${v.title}` : ''}`;
    const section = [v?.actions, v?.section, v?.recommended_actions].find((x) => typeof x === 'string') as string | undefined;
    return `${head}\n\n${section?.trim() ? demoteHeadings(section.trim()) : '(「권장 액션」 절 없음)'}`;
  }).join('\n\n');
}

/** 재시도 큐 한 칸. **회차를 같이 들고 간다** — 재시도 · 이어받기 · 다른 날 재시도가 같은 회차를 쓴다. */
interface RetryEntry {
  type: string;
  /** 있으면 그 세션을 이어받는다(한도에 걸린 당사자). 없으면 새로 돌린다. */
  sessionId?: string;
  run?: ReportRun | null;
}

/** 스케줄러가 밖에서 받는 것 — 시험이 가짜로 바꾼다. */
export interface SchedulerDeps {
  /** report-log 명령(`runReportLog` 와 같은 모양). 실패도 `{ error }` 로 — 던지지 않는다. */
  reportLog?: (script: 'flow' | 'report_log', args: string[]) => Promise<any>;
}

export interface SpawnOpts {
  workingDirectory: string;
  model?: string;
  permissionMode?: 'default' | 'plan' | 'trust';
  allowedTools?: string[];
  appendSystemPrompt?: string;
  systemPrompt?: string;
  env?: Record<string, string>;
  maxBudgetUsd?: number;
  resumeSessionId?: string;
  skipMcp?: boolean;
  noSessionPersistence?: boolean;
  tools?: string[];
  settings?: Record<string, unknown>;
  settingSources?: ('user' | 'project' | 'local')[];
  maxDurationMs?: number;
  useSdk?: boolean;
  /**
   * 끝나면 **같은 옵션으로 하나 미리 띄워 둔다**(SDK 길만 · 2026-10-01). 좁은 길이 켠다 —
   * 판 프롬프트는 다음까지 간격 중앙 20분이라 30분 유지면 절반 남짓이 맞는다(실측 −1.1초).
   */
  prewarmAfter?: boolean;
  /** 사고 깊이 — 유일한 사고 손잡이. 생략하면 SDK 기본값 `'high'`(sdk-handler 주석). */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** 작업 폴더 밖에 읽고 쓸 폴더. **Claude Code 는 작업 폴더 밖 편집을 허용 없이 못 한다** —
   *  결과 파일을 다른 폴더에 쓰는 세션(처리 흐름)은 여기에 그 폴더를 준다. */
  additionalDirectories?: string[];
  /** Codex 폴백이 쓸 수 있는 곳. 주면 **기본 폴더 목록(비서 · 볼트 · 판) 대신 이것만** 연다 —
   *  폴백이 1차보다 넓게 쓰지 않게(2026-09-29 사용자 결정). `null` 이면 폴백을 안 한다. */
  fallbackScope?: { cwd: string; writable: string[] } | null;
}

export interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreateTokens: number;
  cacheReadTokens: number;
}

export interface SessionResult {
  text: string;
  costUsd: number;
  sessionId: string;
  subtype: string;  // 'success' | 'error_max_budget_usd' | ...
  usage?: SessionUsage;
  /** 몇 번 말했나 · 도구를 몇 번 불렀나. **폭주는 값이 아니라 횟수로 보인다** —
   *  회당 $45 회차의 원인(같은 명령 900회)을 원장만으로는 볼 수 없었다. */
  turns?: number;
  toolCalls?: number;
  /** `rate_limit_event.status === 'rejected'` — **실제로 막혔다는 구조화 신호**.
   *  이 값이 없던 동안 스케줄러는 모델이 쓴 본문을 정규식으로 훑어 리미트를
   *  추정했고, 2026-05~08 사이 13번을 오탐했다(전부 `subtype: success`, 보고서도
   *  이미 나온 뒤였다). 분석 주제가 「사용량·한도·실패」라 보고서가 잘 나올수록
   *  `429`·`usage limit` 같은 낱말이 본문에 들어간다 — 감지 어휘와 분석 주제가
   *  같은 공간을 쓰는 한 정규식을 다듬어도 안 갈린다. 판정은 이 필드로 한다. */
  rateLimited?: boolean;
  /** 리미트 해제 시각(epoch sec). 재시도를 「다음 정시+5분」이 아니라 근거 있는
   *  시각에 잡으려고 같이 싣는다. */
  rateLimitResetsAt?: number;
  /** result 이벤트의 `is_error`. 본문 정규식 검사를 **에러일 때만** 열어 주는
   *  열쇠다(사용자 세션 경로가 이미 쓰는 형태 — slack-handler.ts의 NOTE 참조). */
  isError?: boolean;
  /** 띄우기 시작부터 잰 구간(ms) — 원장(`CostEntry`)에 그대로 옮긴다. */
  timing?: { initMs?: number; firstMs?: number; resultMs?: number };
  /**
   * 이 결과를 낸 백엔드 — `spawnOrFallback` 이 붙인다. **폴백이 받은 회차를 Claude 가 한
   * 것으로 읽지 않게** 둔다(5단계 확인에서 Codex 가 처리한 회차를 Claude 경로 확인으로 치면
   * 안 된다). report-log 회차 기록의 `--backend` 와 수동 실행 결과 메시지로 간다.
   */
  servedBy?: Backend;
}

/** 세션을 처리한 백엔드. */
export type Backend = 'claude' | 'codex' | 'agy';

// Google Calendar MCP tools via local @cocal/google-calendar-mcp server
const GCAL_READ_TOOLS = [
  'mcp__google-calendar__list-events',
  'mcp__google-calendar__list-calendars',
  'mcp__google-calendar__get-event',
  'mcp__google-calendar__search-events',
  'mcp__google-calendar__get-freebusy',
  'mcp__google-calendar__get-current-time',
];

const GCAL_WRITE_TOOLS = [
  'mcp__google-calendar__create-event',
  'mcp__google-calendar__create-events',
  'mcp__google-calendar__update-event',
  'mcp__google-calendar__delete-event',
  'mcp__google-calendar__respond-to-event',
];

const GCAL_ALL_TOOLS = [...GCAL_READ_TOOLS, ...GCAL_WRITE_TOOLS];

// --- Cost tracking ---

interface CostEntry {
  timestamp: string;
  type: string;
  costUsd: number;
  sessionId: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheCreateTokens?: number;
  cacheReadTokens?: number;
  /** 어느 길로 돌았나 — 폴백(`codex` · `agy`)이 받은 회차는 값이 0 이다(구독). */
  via?: string;
  /** 폴백 회차가 답을 냈나 — 값이 0 이라 값으로는 성패를 못 가른다. */
  ok?: boolean;
  /** **폭주는 값이 아니라 횟수로 보인다.** 회당 $45 회차가 같은 명령을 900번
   *  되불러서였는데, 원장에 값만 있어 그것을 세는 길이 금지된 자료뿐이었다. */
  turns?: number;
  toolCalls?: number;
  /** 띄우기 시작부터 잰 구간(ms) — 뜸(init) · 첫 글자 · 끝. **어디가 느린지는 합계로
   *  안 보인다** (2026-10-01) — 좁은 길 7.2초가 띄우기·첫 글자·써 내려가기 중 어디인지를
   *  운영에서 가를 길이 없어 따로 하네스를 짰다. 그 하네스는 운영과 입력 크기가 달랐다. */
  initMs?: number;
  firstMs?: number;
  resultMs?: number;
  /** 모델이 낸 글 길이 — 써 내려가는 시간이 이것에 비례한다(한글은 거의 글자당 1토큰). */
  textChars?: number;
}

/** 비용 원장. 시험은 `ASSISTANT_COSTS_FILE` 로 바꿔 끼운다 — 실제 원장을 건드리면 안 된다(2026-10-02 사고). */
const COST_FILE = process.env.ASSISTANT_COSTS_FILE || path.join(__dirname, '..', '.assistant-costs.json');
const COST_RETENTION_DAYS = 30;

export class AssistantScheduler {
  private config: AssistantConfig | null = null;
  private readonly configPath: string;
  private readonly promptsDir: string;
  private readonly workingDir: string;

  // Timers
  private briefingTimer: ReturnType<typeof setTimeout> | null = null;
  private analysisTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private midnightTimer: ReturnType<typeof setTimeout> | null = null;
  private workNudgeTimer: ReturnType<typeof setTimeout> | null = null;
  private offsitePushTimer: ReturnType<typeof setTimeout> | null = null;
  private notionWatchTimer: ReturnType<typeof setInterval> | null = null;
  private notionWatchBusy = false;
  private notionWatchFailures = 0;
  private daouKeepAliveTimer: ReturnType<typeof setTimeout> | null = null;
  private focusTimer: ReturnType<typeof setTimeout> | null = null;
  private focusBusy = false;
  private summaryTimer: ReturnType<typeof setTimeout> | null = null;
  private improveTimer: ReturnType<typeof setTimeout> | null = null;
  private boardQueueTimer: ReturnType<typeof setInterval> | null = null;
  private mailPollTimer: ReturnType<typeof setInterval> | null = null;
  private mailPollBusy = false;
  private remindTimer: ReturnType<typeof setInterval> | null = null;
  private remindBusy = false;
  private actionsTimer: ReturnType<typeof setInterval> | null = null;
  private runSweepTimer: ReturnType<typeof setInterval> | null = null;
  /** 한 차례가 끝나기 전에 다음 차례가 겹치지 않게 — 저장 · push 가 한 시간을 넘길 일은 드물지만 막아 둔다. */
  private runSweepBusy = false;
  private readonly actionPipeline: ActionPipeline;
  /** 이 프로세스에서 이미 보낸 알림. **자국을 못 찍었을 때의 퓨즈다** — 파일
   *  자국이 정본이고 이것은 그 자국이 실패했을 때 2분마다 같은 DM 이 무한히
   *  나가는 것을 막는다(하루 08~20시면 360통). 재시작하면 비므로 한 번은 다시
   *  울릴 수 있는데, 그것이 「영영 안 울림」보다 싸다. */
  private remindSent = new Set<string>();
  /** 한 판이 끝나기 전에 다음 판이 겹치지 않게. 노션 왕복이 폴링 간격보다 길 수 있다. */
  private boardQueueBusy = false;
  private boardQueueFailures = 0;
  /** 마지막으로 큐를 본 때. 밤에 건너뛰는 판정이 이 값 하나를 본다. */
  private boardQueueLast = 0;
  /** 판 알림 연결 — 타이머가 아니라 상시 연결이지만 짝은 같다(`clearAllTimers` 가 멈추고
   *  `startBoardQueuePoller` 가 다시 연다 · `check:timers` 가 센다). */
  private boardPush: BoardPush | null = null;
  /** 한 판이 도는 동안 알림이 오면 끝난 뒤 한 번 더 돈다 — 그 사이에 담긴 것을 안 놓친다. */
  private boardQueueAgain = false;

  // File watcher debounce (account-manager.ts:59-62 pattern)
  private watchDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  // Calendar poller (replaces MCP-based reminder polling)
  private calendarPoller: CalendarPoller | null = null;

  // Cost tracking
  private costEntries: CostEntry[] = [];
  /** 원장을 읽었나 — 안 읽었으면 저장하지 않는다(`saveCosts` 주석). */
  private costsLoaded = false;

  /** report-log 명령 — 분석 회차를 열고 저장하는 길. 시험은 `deps.reportLog` 로 바꾼다. */
  private readonly reportLog: NonNullable<SchedulerDeps['reportLog']>;

  private logger = new Logger('AssistantScheduler');
  private holidays = new Holidays('KR');

  constructor(
    private sendMessage: (text: string, blocks?: unknown[]) => Promise<void>,
    private spawnSession: (prompt: string, opts: SpawnOpts) => Promise<SessionResult>,
    configDir: string,
    /**
     * 판에서 온 **사람 말**을 이 방의 대화로 들여보내는 길. 없으면 그런 항목은
     * 큐에 남는다 — 짧은 문법과 달리 다시 만들 수 없는 글이라 버리지 않는다.
     */
    private askFromBoard?: (text: string, lead?: string, shown?: string) => Promise<void>,
    deps: SchedulerDeps = {},
  ) {
    this.reportLog = deps.reportLog ?? runReportLog;
    this.configPath = path.join(configDir, 'config.json');
    this.promptsDir = path.join(configDir, 'prompts');
    this.workingDir = path.resolve(configDir, '..');
    this.actionPipeline = new ActionPipeline({
      run: runReportLog,
      // 분석 세션과 같은 1차 · 폴백 경로 — 폴백 범위는 `next` 가 준 것만(`SpawnOpts.fallbackScope`).
      session: async (label, prompt, opts) => {
        const result = await this.spawnOrFallback(label, prompt, opts);
        this.recordSessionCost('actions', result);
        return result;
      },
      post: (text, blocks) => this.sendMessage(text, blocks),
      useSdk: shouldUseSdk('analysis:actions'),
      afterResume: () => this.postActionDigest(),
    });
  }

  // --- Public API ---

  start(): void {
    this.loadConfig();
    this.loadCosts();
    this.scheduleAll();
    this.startConfigWatcher();
    this.scheduleMidnightCleanup();
    this.logger.info('AssistantScheduler started', {
      configPath: this.configPath,
      workingDir: this.workingDir,
    });
    // 등급 사다리 표를 미리 읽어 둔다 — 첫 폴백이 표를 기다리지 않게, 브리핑이 기록 파일 경로를 알게.
    void ladderTable();

    // Catch-up briefing if missed today (e.g. bot restarted after briefing time)
    setTimeout(() => this.catchUpBriefingIfNeeded().catch(e =>
      this.logger.error('Catch-up briefing failed', e)), 15_000);

    // Catch-up spinner fresh batch if missing (e.g. PC off at 00:00 data-sync → no novelty).
    // Lightweight: only fresh_pool_generator + build_daily_pool, not the full data-sync.
    setTimeout(() => this.catchUpSpinnerFreshIfNeeded().catch(e =>
      this.logger.error('Catch-up spinner fresh failed', e)), 20_000);

    // Daou session keep-alive — runs EVERY calendar day (incl. weekends/holidays), unlike the
    // working-day-gated data-sync. The Daou session dies from server-side idle timeout (~2-3d);
    // the weekday data-sync's /app/asset ping resets it Mon-Fri, but weekends have no ping →
    // session dies over the weekend → manual re-login every Monday (auto-relogin is CAPTCHA-blocked).
    // A daily ping on the always-on PC keeps one manual login alive indefinitely. Best-effort ping
    // on startup (covers a bot restart) + a recurring daily timer.
    // (the recurring daily timer itself is registered by scheduleAll() above)
    setTimeout(() => this.runDaouKeepAlive().catch(e =>
      this.logger.error('Daou keep-alive (startup) failed', e)), 25_000);

    // 사본이 밖에 나갔는지 뜰 때 한 번 본다. **OS 예약에서 잃은 성질을 메우는
    // 자리다** — 20:00 에 봇이 꺼져 있었으면 그 회차는 통째로 없어지므로, 다시
    // 켤 때 따라잡는다. 나갈 것이 없으면 원격에 닿지도 않고 끝난다.
    // (매일 도는 타이머 자체는 위 scheduleAll() 이 건다)
    if (isWorkAssistantEnabled()) {
      setTimeout(() => void this.runOffsitePush('startup'), 30_000);
    }
  }

  stop(): void {
    this.clearAllTimers();
    this.stopConfigWatcher();
    if (this.midnightTimer) {
      clearTimeout(this.midnightTimer);
      this.midnightTimer = null;
    }
    this.logger.info('AssistantScheduler stopped');
  }

  /** Expose working hours check for CalendarPoller callback. */
  isWorkingHoursCheck(): boolean {
    return this.isWorkingHours();
  }

  /** Manual trigger for -briefing command. */
  async runBriefing(): Promise<{ text: string }> {
    if (!this.config?.briefing.enabled) {
      return { text: 'Briefing is disabled in config.' };
    }
    const result = await this.executeBriefing();
    this.recordSessionCost('briefing', result);
    return { text: result.text + this.formatErrorReport() + this.formatCostLine() };
  }

  /** Manual trigger for -analyze command. Run single type or all default-schedule types. */
  async runAnalysisManual(type?: string): Promise<string> {
    if (!this.config) return '⚠️ Config not loaded.';
    const enabledTypes = this.getEnabledAnalysisTypes();
    if (enabledTypes.length === 0) return '⚠️ No analysis types enabled.';

    if (type) {
      // Single type
      if (!this.config.analysis.types[type]) {
        return `⚠️ Unknown analysis type: ${type}\nAvailable: ${enabledTypes.join(', ')}`;
      }
      if (!this.config.analysis.types[type].enabled) {
        return `⚠️ Analysis type '${type}' is disabled.`;
      }
      // 수동 실행은 `manual` 회차 · 예정일은 오늘(한국 날짜) — `-analyze <종류>` 와 로컬 `POST /trigger` 가 이 길이다.
      const slot = kstDate(new Date());
      let run: ReportRun | null = null;
      try {
        run = await this.openReportRun(type, slot, 'manual');
        const result = await this.runSingleAnalysis(type, undefined, false, { slot, run });
        // 수동 실행은 재시도를 안 잡는다 — 한도 · 타임아웃도 마지막 시도다.
        const end: RunEnd = result.timedOut || result.rateLimited ? 'failed'
          : result.noOutput ? 'no-output' : 'completed';
        const saved = await this.finishReportRun(run, end, result);
        // **처리한 백엔드 · 저장 상태를 같이 적는다** — Codex 가 받은 회차를 Claude 경로 확인으로 읽지 않게.
        const tail = ` · 처리 ${result.servedBy ?? '(세션 없음)'}${this.savedNote(run, saved)}`;
        if (result.timedOut) return `⏱️ 분석 타임아웃: ${type}${tail}`;
        if (result.rateLimited) return `⚠️ 세션 리미트 초과: ${type}${tail}`;
        if (result.noOutput) return `🫥 분석 산출물 없음(세션이 되묻고 끝남): ${type}${tail}`;
        // **✅ 는 저장까지 된 것만** — 저장이 거부 · 실패했으면 세션이 끝났어도 그 판은 없다.
        if (saved?.error) return `❗ 분석은 끝났지만 저장 실패: ${type} ($${result.costUsd.toFixed(4)})${tail}`;
        if (!saved) return `⏳ 분석은 끝났고 저장은 정리 작업 몫: ${type} ($${result.costUsd.toFixed(4)})${tail}`;
        return `✅ 분석 완료: ${type} ($${result.costUsd.toFixed(4)})${tail}`;
      } catch (error) {
        const saved = await this.finishReportRun(run, 'failed', null);
        return `❌ 분석 실패 (${type}): ${(error as Error).message}${this.savedNote(run, saved)}`;
      }
    }

    // All types — run the default schedule group
    const defaultSchedule = this.config.analysis.schedule;
    const groups = this.groupTypesBySchedule();
    const defaultTypes = groups.get(defaultSchedule) || [];
    if (defaultTypes.length === 0) return '⚠️ No types in default schedule.';

    // 그룹 수동 실행도 `manual` 회차 · 예정일은 오늘 — 예약 회차와 섞이지 않게.
    await this.runAnalysisGroup(defaultSchedule, defaultTypes, { slot: kstDate(new Date()), trigger: 'manual' });
    return '✅ 분석 실행 완료 — 결과는 위 메시지 참고';
  }

  /**
   * 로컬 서버 `POST /trigger?type=<종류>` 의 입구. `@group` 이면 기본 스케줄 그룹을 수동으로 돌린다
   * (`-analyze` 와 같은 길 · `manual` 회차) — 그룹 경로(회차 재사용 · 시도 기록)를 이 세션 밖에서
   * 확인할 때 쓴다. 그 밖은 그 종류 하나.
   */
  async runAnalysisTrigger(type: string): Promise<string> {
    return this.runAnalysisManual(type === TRIGGER_GROUP ? undefined : type);
  }

  /** 수동 결과 메시지 꼬리 — 회차를 어떻게 저장했나(`saveTag` · 실패면 사유 · 저장됐으면 판 번호). */
  private savedNote(run: ReportRun | null, saved: any | null): string {
    if (!run) return ' · 회차 없음(못 엶)';
    if (saved?.error) return ` · ${saveTag(run, saved)}: ${String(saved.error).slice(0, 120)}`;
    return ` · ${saveTag(run, saved)}${saved?.id ? ` (${saved.id})` : ''}`;
  }

  /** Access CalendarPoller instance (for mute actions, etc.). */
  getCalendarPoller(): CalendarPoller | null {
    return this.calendarPoller;
  }

  /** Return current config for -assistant config command. */
  getConfig(): AssistantConfig | null {
    return this.config;
  }

  /** Update config fields and save. Triggers fs.watchFile → auto-reload. */
  updateConfig(patch: Partial<{ briefingTime: string; reminderMinutes: number }>): void {
    if (!this.config) return;
    if (patch.briefingTime) {
      this.config.briefing.time = patch.briefingTime;
    }
    if (patch.reminderMinutes !== undefined) {
      this.config.reminders.beforeMinutes = patch.reminderMinutes;
    }
    this.saveConfig();
  }

  /** Return cost statistics for display. */
  getCostStats(): { daily: number; weekly: number; monthly: number; analysisWeekly: number; analysisMonthly: number } {
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    let daily = 0, weekly = 0, monthly = 0;
    let analysisWeekly = 0, analysisMonthly = 0;

    for (const entry of this.costEntries) {
      const age = now - new Date(entry.timestamp).getTime();
      const isAnalysis = entry.type.startsWith('analysis-');
      if (age <= dayMs) daily += entry.costUsd;
      if (age <= 7 * dayMs) {
        weekly += entry.costUsd;
        if (isAnalysis) analysisWeekly += entry.costUsd;
      }
      if (age <= 30 * dayMs) {
        monthly += entry.costUsd;
        if (isAnalysis) analysisMonthly += entry.costUsd;
      }
    }

    return { daily, weekly, monthly, analysisWeekly, analysisMonthly };
  }

  // --- Config management ---

  private loadConfig(): void {
    try {
      if (fs.existsSync(this.configPath)) {
        const raw = fs.readFileSync(this.configPath, 'utf-8');
        this.config = JSON.parse(raw);
        this.logger.info('Loaded assistant config', {
          briefingTime: this.config?.briefing.time,
          reminderEnabled: this.config?.reminders.enabled,
          analysisSchedule: this.config?.analysis.schedule,
        });
      } else {
        this.logger.warn('Assistant config not found', { path: this.configPath });
      }
    } catch (error) {
      errorCollector.add('AssistantScheduler', `설정 파일 로드 실패: ${(error as Error).message}`);
      this.logger.error('Failed to load assistant config', error);
    }
  }

  private saveConfig(): void {
    if (!this.config) return;
    try {
      fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), 'utf-8');
    } catch (error) {
      errorCollector.add('AssistantScheduler', `설정 파일 저장 실패: ${(error as Error).message}`);
      this.logger.error('Failed to save assistant config', error);
    }
  }

  /** fs.watchFile + debounce pattern (account-manager.ts:56-68). */
  private startConfigWatcher(): void {
    try {
      fs.watchFile(this.configPath, { interval: 10_000 }, () => {
        if (this.watchDebounceTimer) clearTimeout(this.watchDebounceTimer);
        this.watchDebounceTimer = setTimeout(() => {
          this.logger.info('Config file changed, reloading');
          this.clearAllTimers();
          this.loadConfig();
          this.scheduleAll();
        }, 1000);
      });
      this.logger.info('Started config file watcher');
    } catch (error) {
      errorCollector.add('AssistantScheduler', `설정 파일 감시 실패: ${(error as Error).message}`);
      this.logger.warn('Failed to start config watcher', error);
    }
  }

  private stopConfigWatcher(): void {
    try {
      fs.unwatchFile(this.configPath);
    } catch {
      // Ignore
    }
  }

  // --- Cost tracking ---

  private loadCosts(): void {
    try {
      if (fs.existsSync(COST_FILE)) {
        const raw = fs.readFileSync(COST_FILE, 'utf-8');
        const data = JSON.parse(raw);
        const cutoff = Date.now() - COST_RETENTION_DAYS * 24 * 60 * 60 * 1000;
        this.costEntries = (data.entries || []).filter(
          (e: CostEntry) => new Date(e.timestamp).getTime() > cutoff,
        );
      }
      this.costsLoaded = true;
    } catch (error) {
      errorCollector.add('AssistantScheduler', `비용 데이터 로드 실패: ${(error as Error).message}`);
      this.logger.error('Failed to load cost data', error);
    }
  }

  /**
   * ⛔ **원장을 읽지 않은 스케줄러는 원장에 쓰지 않는다** (2026-10-02 사고). 원장은 통째로 다시 쓰는
   * 파일이라, 읽기 전의 빈 목록으로 쓰면 남은 기록이 다 지워진다. 시험이 `start()` 없이 만든 스케줄러가
   * 폴백 회차를 원장에 남기다 운영 원장(382건)을 1건으로 덮었다. 읽다 실패한 원장도 덮지 않는다(사람이 본다).
   */
  private saveCosts(): void {
    if (!this.costsLoaded) {
      this.logger.warn('비용 원장을 읽기 전이라 저장하지 않습니다(덮어쓰기 막음)');
      return;
    }
    try {
      fs.writeFileSync(COST_FILE, JSON.stringify({ entries: this.costEntries }, null, 2), 'utf-8');
    } catch (error) {
      errorCollector.add('AssistantScheduler', `비용 데이터 저장 실패: ${(error as Error).message}`);
      this.logger.error('Failed to save cost data', error);
    }
  }

  private recordSessionCost(type: string, result: SessionResult): void {
    // 폴백이 받은 회차는 값이 0 이라 아래에서 걸러진다 — 따로 남긴다.
    if (result.servedBy && result.servedBy !== 'claude') {
      this.recordFallbackRun(type, result.servedBy, result.timing?.resultMs, !result.isError);
      return;
    }
    this.recordCost(type, result.costUsd, result.sessionId, {
      usage: result.usage,
      via: result.usage ? 'sdk' : 'cli',
      turns: result.turns,
      toolCalls: result.toolCalls,
      timing: result.timing,
      textChars: result.text ? result.text.length : undefined,
    });
  }

  /**
   * **폴백(codex · agy)이 돈 회차를 원장에 남긴다** (2026-10-02). 구독이라 값이 0 이어서
   * `recordCost` 가 통째로 걸렀고, 그래서 원장만 보면 폴백이 한 번도 안 돈 것처럼 보였다.
   * 값 0 · 백엔드 · 걸린 시간 · 됐는지만 적는다(토큰 수는 그쪽이 안 준다).
   */
  recordFallbackRun(type: string, via: string, ms: number | undefined, ok: boolean): void {
    const entry: CostEntry = {
      timestamp: new Date().toISOString(), type, costUsd: 0, sessionId: '', via, ok,
    };
    if (ms !== undefined) entry.resultMs = ms;
    this.costEntries.push(entry);
    this.saveCosts();
    this.logger.info('Recorded fallback run', { type, via, ok, resultMs: ms });
  }

  private recordCost(
    type: string,
    costUsd: number,
    sessionId: string,
    extras?: { usage?: SessionUsage; via?: 'cli' | 'sdk'; turns?: number; toolCalls?: number;
               timing?: SessionResult['timing']; textChars?: number },
  ): void {
    if (costUsd <= 0) return;
    const entry: CostEntry = {
      timestamp: new Date().toISOString(),
      type,
      costUsd,
      sessionId,
    };
    if (extras?.usage) {
      entry.inputTokens = extras.usage.inputTokens;
      entry.outputTokens = extras.usage.outputTokens;
      entry.cacheCreateTokens = extras.usage.cacheCreateTokens;
      entry.cacheReadTokens = extras.usage.cacheReadTokens;
    }
    if (extras?.via) entry.via = extras.via;
    if (extras?.turns) entry.turns = extras.turns;
    if (extras?.toolCalls) entry.toolCalls = extras.toolCalls;
    if (extras?.timing?.initMs !== undefined) entry.initMs = extras.timing.initMs;
    if (extras?.timing?.firstMs !== undefined) entry.firstMs = extras.timing.firstMs;
    if (extras?.timing?.resultMs !== undefined) entry.resultMs = extras.timing.resultMs;
    if (extras?.textChars !== undefined) entry.textChars = extras.textChars;
    this.costEntries.push(entry);
    this.saveCosts();
    this.logger.info('Recorded cost', {
      type,
      costUsd: costUsd.toFixed(4),
      sessionId,
      via: extras?.via,
      cacheRead: extras?.usage?.cacheReadTokens,
      turns: extras?.turns,
      toolCalls: extras?.toolCalls,
      initMs: extras?.timing?.initMs,
      firstMs: extras?.timing?.firstMs,
      resultMs: extras?.timing?.resultMs,
      outputTokens: extras?.usage?.outputTokens,
      textChars: extras?.textChars,
    });
  }

  /**
   * 라벨은 셈과 같아야 한다 — `getCostStats` 는 달력이 아니라 **지금부터 거꾸로**
   * 24시간·7일·30일을 센다. 「이번 주」라고 적었더니 수→목에 $49.56→$48.84 로
   * 줄어 읽는 사람이 걸렸다(2026-09-16·17 브리핑). 달력 주간이면 불가능한 움직임이다.
   */
  private formatCostLine(): string {
    const stats = this.getCostStats();
    let line = `\n\n💰 *비용* — 24시간: $${stats.daily.toFixed(2)} | 7일: $${stats.weekly.toFixed(2)} | 30일: $${stats.monthly.toFixed(2)}`;
    if (stats.analysisMonthly > 0) {
      line += `\n📊 *분석* — 7일: $${stats.analysisWeekly.toFixed(2)} | 30일: $${stats.analysisMonthly.toFixed(2)}`;
    }
    return line;
  }

  // --- Timer orchestration ---

  private scheduleAll(): void {
    if (!this.config) return;

    if (this.config.briefing.enabled) {
      this.scheduleBriefing();
    }
    if (this.config.reminders.enabled) {
      this.startCalendarPoller();
    }
    // Unconditional — not gated by any config section. Must live here (not only in start())
    // because clearAllTimers() kills daouKeepAliveTimer on every config reload; scheduleAll()
    // is its re-registration counterpart. Omitting it silently ended the keep-alive chain on
    // the first config write after startup (2026-07-15 → session died 5 days later).
    this.scheduleDaouKeepAlive();
    // 위 keep-alive 와 같은 이유로 여기 있어야 한다 — clearAllTimers() 가 설정 저장마다
    // 이 타이머를 지우므로, 재등록 지점이 scheduleAll() 이다.
    if (isWorkAssistantEnabled()) {
      this.scheduleWorkNudge();
      this.startBoardQueuePoller();
      void this.startNotionWatch();
      this.scheduleFocus();
      this.scheduleSummary();
      this.scheduleOffsitePush();
      this.startMailPoller();
      this.startRemindPoller();
      // 켜는 문이 꺼져 있으면 안 건다 — 06:30 에 아무것도 안 만든다(시안 확인 전).
      if (improveEnabled()) this.scheduleImprove();
    }
    if (this.config.actions?.enabled) {
      this.startActionsTicker();
    }

    if (this.getEnabledAnalysisTypes().length > 0) {
      this.scheduleAnalysis();
      // 분석 회차를 여는 쪽이 정리도 건다 — clearAllTimers() 가 지우므로 다시 거는 자리가 여기다.
      this.startRunSweeper();
    }
  }

  private clearAllTimers(): void {
    if (this.briefingTimer) {
      clearTimeout(this.briefingTimer);
      this.briefingTimer = null;
    }
    if (this.calendarPoller) {
      this.calendarPoller.stop();
      this.calendarPoller = null;
    }
    for (const timer of this.analysisTimers.values()) {
      clearTimeout(timer);
    }
    this.analysisTimers.clear();
    if (this.daouKeepAliveTimer) {
      clearTimeout(this.daouKeepAliveTimer);
      this.daouKeepAliveTimer = null;
    }
    if (this.workNudgeTimer) {
      clearTimeout(this.workNudgeTimer);
      this.workNudgeTimer = null;
    }
    if (this.notionWatchTimer) {
      clearInterval(this.notionWatchTimer);
      this.notionWatchTimer = null;
    }
    if (this.boardQueueTimer) {
      clearInterval(this.boardQueueTimer);
      this.boardQueueTimer = null;
    }
    if (this.boardPush) {
      this.boardPush.stop();
      this.boardPush = null;
    }
    if (this.mailPollTimer) {
      clearInterval(this.mailPollTimer);
      this.mailPollTimer = null;
    }
    if (this.remindTimer) {
      clearInterval(this.remindTimer);
      this.remindTimer = null;
    }
    if (this.actionsTimer) {
      clearInterval(this.actionsTimer);
      this.actionsTimer = null;
    }
    this.actionPipeline.stopResume();
    if (this.runSweepTimer) {
      clearInterval(this.runSweepTimer);
      this.runSweepTimer = null;
    }
    if (this.focusTimer) {
      clearTimeout(this.focusTimer);
      this.focusTimer = null;
    }
    if (this.summaryTimer) {
      clearTimeout(this.summaryTimer);
      this.summaryTimer = null;
    }
    if (this.improveTimer) {
      clearTimeout(this.improveTimer);
      this.improveTimer = null;
    }
    if (this.offsitePushTimer) {
      clearTimeout(this.offsitePushTimer);
      this.offsitePushTimer = null;
    }
  }

  // --- 처리 제안 (report-log) ---

  /**
   * 처리 제안 타이머 — 한 시간마다. 이어 가기(사용량 한도 · 병합 대기로 멈춘 제안)는 늘,
   * 밤 검토는 업무일의 시간대 안에서만. 켜기 · 시간대는 `config.json` 의 `actions` 절.
   */
  private startActionsTicker(): void {
    if (!reportLogAvailable()) {
      this.logger.info('처리 제안 타이머 꺼짐 (report-log 자동 기록 클론 없음)');
      return;
    }
    const a = this.config?.actions;
    const window = parseWindow(a?.reviewWindow ?? '02:00-07:00');
    this.logger.info('처리 제안 타이머 시작', { nightlyReview: !!a?.nightlyReview, window: a?.reviewWindow });
    this.actionsTimer = setInterval(() => {
      void this.actionPipeline.tick({
        review: !!a?.nightlyReview, window, workingDay: !this.isNonWorkingDay().skip,
      });
    }, ACTIONS_TICK_MS);
    // 한도로 미뤄 둔 사람이 시킨 검토 — 재시작 · 설정 저장(clearAllTimers 가 지움) 뒤에 다시 건다.
    this.actionPipeline.restoreResume();
  }

  /**
   * 열린 채 남은 분석 회차 정리 — 한 시간마다 `report_log.py sweep --older-than 6`(「쓰는 흐름」 6번).
   * 세션이 저장 전에 죽었거나 · 재시작 · 설정 저장으로 재시도 예약이 사라졌거나 · 세션이 러너보다
   * 먼저 끝난 회차를 report-log 가 저장(`partial` · `machine`)하거나 `abandoned` 로 닫는다.
   */
  private startRunSweeper(): void {
    if (!reportLogAvailable()) {
      this.logger.info('분석 회차 정리 타이머 꺼짐 (report-log 자동 기록 클론 없음)');
      return;
    }
    this.runSweepTimer = setInterval(() => { void this.sweepReportRuns(); }, RUN_SWEEP_MS);
  }

  /** 정리 한 차례. **던지지 않는다** — 실패는 로그와 브리핑 「시스템 이슈」로만 남긴다. */
  async sweepReportRuns(): Promise<any | null> {
    if (this.runSweepBusy) return null;
    this.runSweepBusy = true;
    try {
      const r = await this.reportLog('report_log', ['sweep', '--older-than', String(RUN_SWEEP_OLDER_THAN_HOURS)]);
      if (!r || r.error) {
        const why = String(r?.error ?? '답 없음');
        this.logger.error('분석 회차 정리(sweep) 실패', { why });
        errorCollector.add('AssistantScheduler', `회차 정리(sweep) 실패: ${why.slice(0, 200)}`);
        return r ?? null;
      }
      const swept: any[] = Array.isArray(r.swept) ? r.swept : [];
      const of = (action: string) => swept.filter((x) => x?.action === action);
      const committed = of('committed').map((x) => `${x.id}(${x.status})`);
      const abandoned = of('abandoned').map((x) => x.id);
      const refused = of('refused').map((x) => x.id);
      const failed = of('error').map((x) => `${x.id}: ${String(x.error ?? '').slice(0, 120)}`);
      if (swept.length > 0) {
        this.logger.info('분석 회차 정리(sweep)', {
          committed, abandoned, refused, failed, recent: r.recent, pushed: r.pushed,
        });
      }
      if (failed.length > 0) {
        errorCollector.add('AssistantScheduler', `회차 정리(sweep) 일부 실패: ${failed.join(' · ').slice(0, 300)}`);
      }
      return r;
    } catch (err) {
      this.logger.error('분석 회차 정리(sweep) 예외', err);
      errorCollector.add('AssistantScheduler', `회차 정리(sweep) 예외: ${(err as Error).message}`);
      return null;
    } finally {
      this.runSweepBusy = false;
    }
  }

  /** `-report` 답 — 처리 제안 요약 + desk 보고서 링크. report-log 가 없거나 못 읽으면 null. */
  async reportReplyBlocks(type?: string): Promise<unknown[] | null> {
    if (!reportLogAvailable()) return null;
    return this.actionPipeline.reportReplyBlocks(type);
  }

  /** 처리 제안 아침 요약 블록 — 결정이 필요한 것 · 멈춘 것. 없거나 못 읽으면 null. */
  async actionDigestBlocks(): Promise<unknown[] | null> {
    if (!reportLogAvailable()) return null;
    return this.actionPipeline.digestBlocks();
  }

  /** 브리핑 셋(예약 · 놓친 것 · 수동 `-briefing`)이 같이 붙이는 요약. 실패해도 브리핑은 그대로. */
  private async postActionDigest(): Promise<void> {
    try {
      const blocks = await this.actionDigestBlocks();
      if (blocks) await this.sendMessage('🗂 처리 제안', blocks);
    } catch (err) {
      this.logger.warn('처리 제안 요약 실패', err);
    }
  }

  /** 버튼 결정 — 진행이면 곧바로 실행을 시작한다. */
  async decideAction(id: string, decision: string): Promise<{ ok: boolean; note: string }> {
    if (!reportLogAvailable()) return { ok: false, note: '⚠️ report-log 자동 기록 클론이 없습니다' };
    return this.actionPipeline.decide(id, decision);
  }

  /**
   * `-actions review|run` — 시간대와 무관하게 지금 한 차례. 끝나면 요약을 DM 으로.
   * 이미 도는 중이면 그 차례 뒤에 이어 돈다.
   */
  runActionsNow(kind: 'review' | 'run'): 'started' | 'queued' | 'unavailable' {
    if (!reportLogAvailable()) return 'unavailable';
    const busy = this.actionPipeline.isBusy();
    void this.actionPipeline.request(kind).then(() => this.postActionDigest());
    return busy ? 'queued' : 'started';
  }

  // --- 업무 (work-assistant) ---

  /*
   * 브리핑 꼬리의 업무 조망은 2026-09-02 에 뺐다(사용자 결정).
   *
   * 아침 브리핑이 길어 읽히지 않는 것이 원인이고, 그중 업무 블록이 8 줄로 가장
   * 컸다. 조망은 Dispatch 판이 늘 최신으로 들고 있고(refreshBoardIfChanged),
   * 급한 것은 08:55 넛지가 따로 민다 — 슬랙 아침 메시지가 그것을 또 나를 이유가
   * 없다. `briefShort()` 도 함께 지웠다(이 호출이 유일한 소비처였다).
   *
   * 되살릴 일이 생기면 브리핑 본문에 붙이지 말고 별도 메시지로 보낼 것. 붙이면
   * 브리핑이 다시 그만큼 길어진다.
   */

  /**
   * 08:55 업무 넛지 — 09:00 데일리 미팅 직전 1회.
   *
   * **브리핑과 별개 장치다.** 브리핑(08:00)은 내용을 보여주고, 넛지는 세션을 열게 한다.
   * 그래서 목록을 다시 보내지 않고 급한 1~2건만 근거로 싣는다.
   *
   * 침묵 조건은 **하나뿐이다 — 댈 근거가 없을 때.** 아침 인사를 했는지는 안 본다
   * (2026-08-05 사용자 확정): 넛지의 목적이 데일리 직전에 한 번 보는 것이라,
   * 이미 세션을 열었더라도 08:55 의 목록은 따로 값이 있다. 판정은 `tasks.py` 가
   * 한다(봇에 로직을 복제하지 않는다).
   *
   * **catch-up 은 일부러 없다.** 봇이 09:30 에 뜨면 이 넛지는 이미 의미가 없다 —
   * 데일리가 지난 뒤의 "곧 데일리입니다" 는 소음이다.
   */
  private scheduleWorkNudge(): void {
    const nextFire = this.getNextWorkingDay(WORK_NUDGE_TIME);
    this.logger.info('Scheduled work nudge', { time: WORK_NUDGE_TIME, nextFire: nextFire.toISOString() });

    this.workNudgeTimer = setTimeout(async () => {
      try {
        const nonWorking = this.isNonWorkingDay();
        if (nonWorking.skip) {
          this.logger.info(`Skipping work nudge (${nonWorking.reason})`);
        } else {
          const text = await briefNudge();
          if (text) {
            await this.sendMessage(text);
          } else {
            this.logger.info('Skipping work nudge (nothing urgent)');
          }
          // ⛔ **아침 체크인을 여기서 걷었다** (2026-09-02 사용자) — 넛지와
          // 합쳐 두 메시지 30줄이었고 「결국 안 읽게 된다」가 그 근거다.
          // 체크인 본문만 16줄이었다(어제 손댄 것 17건 + 접힌 11건).
          //
          // **판이 그 일을 이미 하고 있다** — 판 「프롬프트」로 온 갱신 42건
          // 대 체크인 물음 7건(관찰 기록 2026-09-02). 같은 근거로 오후
          // 체크인과 슬랙 첫 대화 체크인을 2026-08-26 에 이미 걷었고,
          // 이것이 마지막이다.
          //
          // **되살리려면** `tasks.py checkin --nudge --once --surface slack
          // --slack` 을 불러 빈 출력이 아니면 보낸다(이 커밋에서 지운
          // `checkinNudge` 가 그것이었다). 터미널 쪽 훅은 그대로 살아
          // 있다 — 사람이 세션을 연 것이라 밀려오는 알림이 아니다.
        }
      } catch (error) {
        // **실패는 알린다.** 넛지는 "급한 게 없으면 침묵" 이라, 조회가 깨져서 못 온
        // 것과 보낼 게 없어서 안 온 것이 받는 쪽에서 똑같아 보인다. 그러면 안전망이
        // 죽은 날에도 정상으로 읽힌다(2026-08-06: 노션 연결이 사내망에서 끊기는
        // 것을 확인 — 실패율 50% 이상). 하루 한 번뿐이라 소음이 되지 않는다.
        this.logger.error('Work nudge failed', error);
        await this.sendMessage(
          '⏰ 업무 조회가 안 됩니다 — 넛지를 못 만들었습니다. 노션 연결을 확인하세요.',
        ).catch(() => { });
      }
      this.scheduleWorkNudge();
    }, nextFire.getTime() - Date.now());
  }

  /**
   * 오후 체크인 넛지 — 오늘까지의 진행을 걷는다.
   *
   * **아침 것과 묻는 대상이 다르다**(어제 vs 오늘). 오늘 이미 답을 받았거나
   * 물을 게 없거나 「조용히」 기간이면 `tasks.py` 가 빈 출력을 주고, 그러면
   * 아무것도 보내지 않는다 — 판정을 봇에 복제하지 않는다.
   *
   * **catch-up 은 없다.** 봇이 밤에 뜨면 "지금까지 뭐 됐나요"는 이미 늦다.
   */
  /**
   * 매일 그 시각. **쉬는 날을 안 건너뛴다** — `getNextWorkingDay` 와 그것이
   * 다르다. 알림은 일하는 날에만 밀지만 백업은 달력을 안 가린다.
   */
  private getNextEveryDay(time: string): Date {
    const [h, m] = time.split(':').map(Number);
    const now = new Date();
    const next = new Date(now);
    next.setHours(h, m, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next;
  }

  /**
   * PC 밖으로 사본을 — 매일 20:00. 대상은 업무 볼트와 비서 레포 둘이고,
   * **목록은 파이썬 쪽 `config.json` 이 정본**이다(봇에 복제하지 않는다).
   *
   * **작업 스케줄러가 아니라 여기 있는 이유**(2026-08-18 사용자 결정): 예약을
   * OS 쪽에 두면 관리할 자리가 하나 더 는다. 봇이 죽으면 백업도 멈추지만,
   * **봇이 죽으면 어차피 여러 가지가 같이 멈추므로 조용한 실패가 아니다.**
   * 그리고 밀렸다는 판정(`brief` 맨 위 ⛔)은 봇 밖에 있어 봇이 죽어도 살아 있다.
   *
   * 대신 **놓친 회차를 다음에 켤 때 미는 성질**을 OS 예약에서 잃었다 — 봇이
   * 뜰 때 한 번 부르는 것(`start()`)이 그 자리를 메운다.
   *
   * **말을 걸지 않는다.** 성공도 실패도 로그까지다.
   */
  /**
   * 카드 요약 — **업무일 하루 한 번, 한 호출로 몰아서.**
   *
   * 「지금 집중할 것」과 갈리는 자리 둘 — ①두 시간마다가 아니라 하루 한 번이고
   * ②판단이 아니라 **글짓기**라 도구를 아예 안 쓴다. 값이 왜 이렇게 나뉘는지는
   * `SUMMARY_TIME` 위 주석에 실측으로 적어 뒀다.
   *
   * **말을 걸지 않는다.** 성공도 실패도 로그까지다 — 요약은 카드를 열면 보이는
   * 것이라 슬랙에 또 적을 이유가 없다.
   */
  private scheduleSummary(): void {
    const nextFire = this.getNextWorkingDay(SUMMARY_TIME);
    this.logger.info('Scheduled card summaries', {
      time: SUMMARY_TIME, nextFire: nextFire.toISOString(),
    });
    this.summaryTimer = setTimeout(async () => {
      try {
        const nonWorking = this.isNonWorkingDay();
        if (nonWorking.skip) {
          this.logger.info(`Skipping summaries (${nonWorking.reason})`);
        } else if (await isQuietPeriod()) {
          // 「조용히」는 **미는 것**을 멈추는 장치다. 요약은 밀지 않지만 돈이
          // 나가는 자리라, 사람이 자리에 없는 동안 매일 청구되게 두지 않는다.
          this.logger.info('Skipping summaries (조용히 기간)');
        } else {
          await this.runSummaries();
        }
      } catch (error) {
        this.logger.warn('Card summaries failed', {
          why: error instanceof Error ? error.message : String(error),
        });
      } finally {
        this.scheduleSummary();
      }
    }, nextFire.getTime() - Date.now());
  }

  /** 한 판 돈다. **절대 던지지 않는다** — 부르는 쪽의 `finally` 가 재예약한다. */
  private async runSummaries(): Promise<void> {
    // **나가는 길마다 한 줄 남긴다.** 조용히 돌아 나가면 「안 돌았다」와
    // 「돌았는데 쓸 것이 없었다」를 못 가른다 — 하루 한 번짜리라 그 차이를
    // 다음 날에야 눈치채고, 그때는 왜인지가 어디에도 안 남아 있다.
    const root = workAssistantRoot();
    if (!root) { this.logger.warn('Summaries: work-assistant 를 못 찾음'); return; }
    const all = await summaryCandidates();
    this.logger.info(`Summaries: 후보 ${all.length}건`);
    if (!all.length) return;
    const items = all.slice(0, SUMMARY_MAX);
    if (all.length > items.length) {
      // **자른 것을 말한다.** 조용히 자르면 「다 했다」로 읽힌다.
      this.logger.info(`Summaries: ${all.length}건 중 ${items.length}건만 이번 회차`
        + ` — 남은 ${all.length - items.length}건은 내일`);
    }
    // **`focus.md` 와 사는 곳이 다르다** — 이 글은 판의 요약 칸이 무엇인지를
    // 적은 것이라 그 칸을 만든 레포(`work-assistant`)에 둔다. 거기는 매일 밤
    // 밖으로 나가고, 카드·메모 규칙이 이미 그 옆에 있다.
    const promptPath = path.join(root, 'prompts', 'summary.md');
    if (!fs.existsSync(promptPath)) {
      this.logger.warn(`Summary prompt not found: ${promptPath}`);
      return;
    }
    const body = items
      .map((i) => `=== ${i.id} ===\n${i.material}`)
      .join('\n\n');
    const result = await this.spawnOrFallback('카드 요약',body, {
      workingDirectory: root,
      model: SUMMARY_MODEL,
      effort: SUMMARY_EFFORT,
      permissionMode: 'default',
      // **도구가 하나도 없다.** 이 세션은 받은 글을 읽고 글을 지을 뿐이고,
      // 볼트에 앉히는 것은 아래 파이썬이 한다 — 규칙이 그쪽 한 곳에 있다.
      tools: [],
      allowedTools: [],
      // 규칙 파일을 안 읽는다 — 두 CLAUDE.md 가 따라 들어오면 그것만으로
      // 건당 값이 몇 배가 된다(focus 에서 겪은 것).
      settingSources: [],
      appendSystemPrompt: fs.readFileSync(promptPath, 'utf-8'),
      env: { ASSISTANT_MODE: 'summary', CLAUDE_SCHEDULED: '1' },
      skipMcp: true,
      noSessionPersistence: true,
      // 12건이 161초였다 — 상한(10건)에 닿아도 두 배 넘게 남는다.
      maxDurationMs: 6 * 60_000,
      useSdk: true,
    });
    this.recordSessionCost('summary', result);

    const got = parseSummaryReply(result.text || '');
    if (!got) {
      // **원문 꼬리를 남긴다** — 형식이 어긋난 것이 그날의 유일한 단서다.
      this.logger.warn('Summaries: JSON 이 아니라 아무것도 못 썼습니다 · 꼬리 = '
        + (result.text || '').slice(-300));
      return;
    }
    // **보낸 번호만 받는다** — 세션이 없는 번호를 지어내면 그 글은 어느 업무의
    // 것도 아니다. 안 온 것은 세어서 로그에 남긴다.
    const use: Record<string, SummaryReply> = {};
    const missing: string[] = [];
    for (const it of items) {
      const one = got[it.id];
      if (one && one.summary.trim()) use[it.id] = one; else missing.push(it.id);
    }
    const detail = Object.keys(use).length
      ? await summaryApply(use)
      : '쓸 것 없음';
    this.logger.info(`Summaries: ${detail} · $${result.costUsd?.toFixed(4) ?? '?'}`
      + (missing.length ? ` · 안 온 것 ${missing.join(',')}` : ''));
  }

  // --- 매일 개선 제안 ---

  private scheduleImprove(): void {
    const nextFire = this.getNextWorkingDay(IMPROVE_TIME);
    this.logger.info('Scheduled improvement proposals', { time: IMPROVE_TIME, nextFire: nextFire.toISOString() });
    this.improveTimer = setTimeout(async () => {
      try {
        const nonWorking = this.isNonWorkingDay();
        if (nonWorking.skip) {
          this.logger.info(`개선 제안 건너뜀 (${nonWorking.reason})`);
        } else if (await isQuietPeriod()) {
          // 「조용히」는 미는 것을 멈추는 장치다 — 아무도 안 볼 제안에 구독 한도를 쓰지 않는다.
          this.logger.info('개선 제안 건너뜀 (조용히 기간)');
        } else {
          this.logger.info(`개선 제안 — ${await this.runImprove()}`);
        }
      } catch (error) {
        this.logger.warn('개선 제안 실패', { why: error instanceof Error ? error.message : String(error) });
      } finally {
        this.scheduleImprove();
      }
    }, nextFire.getTime() - Date.now());
  }

  /**
   * 한 번 만든다 — 재료(파이썬) → 세션 한 번(도구 없음) → 검사 · 장부(파이썬). 결과 한 줄을 돌려준다.
   * **절대 던지지 않는다.** 올리는 것은 여기서 안 한다 — 08:00 브리핑이 올린다.
   */
  private async runImprove(): Promise<string> {
    const root = workAssistantRoot();
    if (!root) return 'work-assistant 를 못 찾음';
    const promptPath = path.join(root, 'prompts', 'improve.md');
    if (!fs.existsSync(promptPath)) return `규칙 파일 없음 — ${promptPath}`;
    const pack = await improveGather();
    if (!pack) return '재료를 못 모음';
    const result = await this.spawnOrFallback('개선 제안', pack, {
      workingDirectory: root,
      model: IMPROVE_MODEL,
      effort: IMPROVE_EFFORT,
      permissionMode: 'default',
      // **도구가 하나도 없다** — 재료는 본문에 있고 장부에 올리는 것은 파이썬이 한다(카드 요약과 같은 모양).
      tools: [],
      allowedTools: [],
      settingSources: [],
      appendSystemPrompt: fs.readFileSync(promptPath, 'utf-8'),
      env: { ASSISTANT_MODE: 'improve', CLAUDE_SCHEDULED: '1' },
      skipMcp: true,
      noSessionPersistence: true,
      maxDurationMs: 5 * 60_000,
      useSdk: true,
    });
    this.recordSessionCost('improve', result);
    const said = (result.text || '').trim();
    if (!said) return `세션이 빈손 (${result.subtype})`;
    const got = await improveAccept(said);
    if (!got) return '결과를 장부에 못 올림';
    if (!got.ok) return `받지 않음 — ${got.why}`;
    const skipped = (got.skipped || []) as { why: string }[];
    return `${(got.items || []).length}건 · 거름 ${skipped.length}건`
      + (skipped.length ? ` (${skipped.map((s) => s.why).join(' / ')})` : '')
      + ` · $${result.costUsd?.toFixed(4) ?? '?'}`;
  }

  /** 로컬 트리거 `@improve` — 켜는 문과 무관하게 한 번 만든다. 올리지는 않는다(시안 확인용). */
  async runImproveNow(): Promise<string> {
    return this.runImprove();
  }

  /** 오늘 제안 블록 — 아직 안 올렸고 결정 전 제안이 있을 때만. 미리 보기용 글도 같이. */
  async improveDigest(): Promise<{ blocks: unknown[] | null; text: string; posted: boolean }> {
    const day = await improveShow();
    const blocks = buildImproveBlocks(day);
    return { blocks, text: improvePreviewText(blocks), posted: !!day?.posted };
  }

  /** 브리핑에 붙일 블록 — 켜는 문이 꺼져 있거나 이미 올렸거나 제안이 없으면 null. */
  async improveForBriefing(): Promise<unknown[] | null> {
    if (!improveEnabled()) return null;
    const d = await this.improveDigest();
    return d.blocks && !d.posted ? d.blocks : null;
  }

  /** 올렸다고 적는다 — **보낸 뒤에** 부른다(먼저 적으면 보내다 실패한 날 영영 안 올라간다). */
  async markImprovePosted(): Promise<void> {
    await improvePosted();
  }

  /** 브리핑 셋이 처리 제안 다음에 붙인다. 켜는 문이 꺼져 있거나 이미 올렸으면 아무것도 안 한다. */
  private async postImproveDigest(): Promise<void> {
    try {
      const blocks = await this.improveForBriefing();
      if (!blocks) return;
      await this.sendMessage('💡 개선 제안', blocks);
      await this.markImprovePosted();
    } catch (err) {
      this.logger.warn('개선 제안 올리기 실패', err);
    }
  }

  /** 아침 브리핑 뒤에 붙는 것 둘 — 처리 제안 · 개선 제안. 세 곳(예약 · 놓친 것 · 수동)이 같이 부른다. */
  async postMorningProposals(): Promise<void> {
    await this.postActionDigest();
    await this.postImproveDigest();
  }

  /** 버튼 결정 — 등록이면 업무가 하나 생긴다. 번호 · 결정 이름은 여기서도 다시 본다(버튼 값은 믿지 않는다). */
  async decideImprove(id: string, decision: string): Promise<{ ok: boolean; note: string }> {
    if (!IMPROVE_ID_RE.test(id) || !(IMPROVE_DECISIONS as readonly string[]).includes(decision)) {
      return { ok: false, note: '⚠️ 버튼 값이 올바르지 않습니다' };
    }
    const r = await improveDecide(id, decision);
    const at = new Date().toTimeString().slice(0, 5);
    return { ok: r.ok, note: r.ok ? `*${r.note}* · ${at}` : r.note };
  }

  private scheduleOffsitePush(): void {
    const nextFire = this.getNextEveryDay(OFFSITE_PUSH_TIME);
    this.logger.info('Scheduled vault push', {
      time: OFFSITE_PUSH_TIME, nextFire: nextFire.toISOString(),
    });

    this.offsitePushTimer = setTimeout(async () => {
      // **걷기가 내보내기보다 먼저다** — 순서를 뒤집으면 그날 걷은 커밋이
      // 하루를 꼬박 PC 안에만 머문다. 걷기가 실패해도 내보내기는 그대로 돈다
      // (백업이 다른 일 때문에 멈추면 방향이 거꾸로다).
      await this.runCommitHarvest();
      await this.runOffsitePush('daily');
      this.scheduleOffsitePush();
    }, nextFire.getTime() - Date.now());
  }

  /**
   * 커밋을 진행 로그로 한 번 걷는다. **절대 던지지 않는다** — 여기서 터지면
   * 뒤따르는 내보내기와 재예약이 같이 끊긴다.
   */
  private async runCommitHarvest(): Promise<void> {
    try {
      const r = await commitHarvest();
      // **나가는 길마다 한 줄 남긴다** — 조용히 돌아 나가면 「안 돌았다」와
      // 「돌았는데 걷을 것이 없었다」를 못 가른다.
      if (r.ok) this.logger.info(`Commit harvest — ${r.detail || '걷을 것 없음'}`);
      else this.logger.warn(`Commit harvest failed — ${r.detail}`);
    } catch (error) {
      this.logger.error('Commit harvest threw', error);
    }
  }

  /** 한 번 내보낸다. **절대 던지지 않는다** — 여기서 터지면 재예약이 끊긴다. */
  private async runOffsitePush(why: string): Promise<void> {
    try {
      const r = await offsitePush();
      if (r.ok) {
        this.logger.info(`Offsite push (${why}) — ${r.detail || '나갈 것 없음'}`);
      } else {
        this.logger.warn(`Offsite push (${why}) failed — ${r.detail}`);
      }
    } catch (error) {
      this.logger.error(`Offsite push (${why}) threw`, error);
    }
  }

  /**
   * 메일에서 업무 후보를 뽑아 **비서에게 넘긴다** (2026-08-18 사용자 결정).
   *
   * **여기서 판단하지 않는다.** 등록할지·어느 업무에 붙일지·버릴지는 비서 세션이
   * 정하고 사람이 슬랙에서 컨펌한다 — 판이 보내는 「메모」와 같은 입구로 넣어
   * 규칙(임의 등록 금지 · 원문 캡처 · 되묻기)이 그대로 걸리게 한다.
   *
   * **넘긴 뒤에 표시한다.** 넘기기 전에 찍으면 세션이 넘어졌을 때 후보가 사라진다
   * — 넘기기가 실패하면 표시를 안 찍어 다음 차례에 다시 나온다.
   *
   * ⚠️ **표시는 Outlook 을 다시 읽지 않고 찍는다**(`mailMark`). 다시 읽으면 그
   * 사이 도착한 메일까지 본 것으로 찍혀 조용히 건너뛴다.
   */
  /**
   * 시각 알림. **세션을 안 띄운다** — 판단할 것이 없고 사람이 정한 시각에 정한
   * 말을 그대로 내는 자리라, 돈이 드는 길로 보낼 이유가 없다.
   */
  private startRemindPoller(): void {
    this.logger.info('Started remind poller', {
      everyMs: REMIND_POLL_MS, window: `${REMIND_FROM_HOUR}~${REMIND_TO_HOUR}시`,
    });
    this.remindTimer = setInterval(() => {
      void this.runRemindPoll();
    }, REMIND_POLL_MS);
  }

  /** 한 판 돈다. **절대 던지지 않는다** — 여기서 터지면 조용히 안 울린다. */
  private async runRemindPoll(): Promise<void> {
    const h = new Date().getHours();
    if (h < REMIND_FROM_HOUR || h >= REMIND_TO_HOUR) return;
    // **쉬는 날과 「조용히」 기간에는 안 울린다** — 미는 것은 전부 멈춘다는 규칙을
    // 여기만 예외로 두지 않는다. 지난 알림은 **버려지지 않고** 자국이 없는 채로
    // 남아, 다음 업무일 첫 회차에 그대로 나온다.
    if (this.isNonWorkingDay().skip) return;
    if (await isQuietPeriod()) return;
    if (this.remindBusy) return;
    this.remindBusy = true;
    try {
      const due = await remindDue();
      if (!due.length) return;
      for (const it of due) {
        // 자국이 「그 값」이라 시각을 고치면 다시 울려야 한다 — 열쇠에 시각을 넣는다.
        const key = `${it.id}@${it.at}`;
        if (this.remindSent.has(key)) continue;
        const when = it.at.slice(11);
        await this.sendMessage(
          `⏰ ${when} — ${it.title}` + (it.next ? `\n다음 행동: ${it.next}` : ''));
        // **보낸 뒤에 찍는다** — 먼저 찍고 보내다 실패하면 영영 안 울린다.
        this.remindSent.add(key);
        if (!await remindDone(it.id)) {
          this.logger.warn(
            `Remind: 표시를 못 찍었습니다 — 이 프로세스에서는 안 울립니다 (${it.id})`);
        }
      }
      this.logger.info(`Remind — ${due.length}건 울림`);
    } catch (error) {
      this.logger.error('Remind poll threw', error);
    } finally {
      this.remindBusy = false;
    }
  }

  private startMailPoller(): void {
    this.logger.info('Started mail poller', {
      everyMs: MAIL_POLL_MS, window: `${MAIL_POLL_FROM_HOUR}~${MAIL_POLL_TO_HOUR}시`,
    });
    this.mailPollTimer = setInterval(() => {
      void this.runMailPoll();
    }, MAIL_POLL_MS);
  }

  /** 한 판 돈다. **절대 던지지 않는다** — 여기서 터지면 로그가 빈 채로 조용해진다. */
  private async runMailPoll(): Promise<void> {
    const h = new Date().getHours();
    if (h < MAIL_POLL_FROM_HOUR || h >= MAIL_POLL_TO_HOUR) return;
    // 쉬는 날에는 읽지도 않는다 — **읽고 안 넘기면 표시가 옮겨질 위험만 남는다.**
    const nonWorking = this.isNonWorkingDay();
    if (nonWorking.skip) return;
    if (this.mailPollBusy) return;
    this.mailPollBusy = true;
    try {
      const r = await mailCandidates(1);
      if (!r.ok) {
        // **실패를 삼키지 않는다.** 후보가 없어서 조용한 것과 못 읽어서 조용한
        // 것이 받는 쪽에서 똑같아 보인다 — 사람에게는 안 알리되(10분마다라
        // 소음이 된다) 로그에는 남긴다.
        this.logger.warn(`Mail poll failed — ${r.detail}`);
        return;
      }
      if (!r.threads.length) return;
      if (!this.askFromBoard) {
        this.logger.warn('Mail poll: 비서에게 넘길 길이 없습니다 — 표시를 안 찍고 둡니다');
        return;
      }
      // `[메일]` 은 판이 쓰는 `[진행판]` 과 같은 자리의 표식이다 — 비서 쪽 트리거
      // 표가 이 글자를 보고 무슨 절차를 밟을지 고른다. 이름이 아니라 행선지다.
      // **사람에게는 한 줄만 보인다.** 본문은 세션이 읽을 것이라 통계·머리표·지시가
      // 들어 있고, 그것을 그대로 채널에 붙이면 같은 내용이 두 번 뜬다(2026-08-19
      // 사용자 지적). 세 번째 인자가 빈 문자열이면 머리 줄만 남는다.
      await this.askFromBoard(
        `[메일] 후보 ${r.threads.length}건\n${r.text}`,
        r.lead || `📬 메일 후보 ${r.threads.length}건`, '');
      // **표시가 안 찍히면 큰 소리로 남긴다.** 결과를 버리면 넘기기는 되는데
      // 표시만 안 되는 상태가 조용히 이어져 **같은 후보가 10분마다 다시 나간다**
      // (2026-08-18 실측: 같은 스레드 셋 · 다음 날 아침 둘 · 세션 다섯 번).
      // 사람에게는 안 알린다 — 10분마다라 알림 자체가 소음이 된다.
      if (r.newest && !(await mailMark(r.newest))) {
        this.logger.warn(`Mail poll: 표시를 못 찍었습니다 — 같은 후보가 또 나옵니다 (${r.newest})`);
      }
      this.logger.info(`Mail poll — ${r.threads.length}건 비서에게 넘김`);
    } catch (error) {
      this.logger.error('Mail poll threw', error);
    } finally {
      this.mailPollBusy = false;
    }
  }


  /**
   * 노션에서 **직접** 고친 것을 따라잡는다 — 3분마다.
   *
   * 수정은 판과 스탠리에서 한다는 것이 규율이지만 노션은 막을 수 없다.
   * 막는 대신 따라잡는다: 안 따라잡으면 화면이 최대 8시간 낡고, **낡은 화면은
   * 조용히 틀린다**(사람은 최신인 줄 알고 본다).
   *
   * 바뀐 게 없으면 `tasks.py` 가 1행 질의만 하고 끝낸다 — 그래서 3분이 싸다.
   * 판정·갱신·배포 순서는 전부 파이썬에 있다(봇에 복제하지 않는다).
   *
   * **「조용히」와 무관하다.** 화면을 최신으로 두는 것은 미는 알림이 아니라서,
   * 출장 중에도 열어 보면 최신이어야 한다.
   */
  private async startNotionWatch(): Promise<void> {
    // **정본이 볼트면 감시할 것이 없다.** 이 장치는 「노션은 막을 수 없다」 하나
    // 때문에 있었고, 쓰는 주체가 하나가 된 뒤로는 하루 480회를 헛돈다.
    const store = await currentStore();
    if (store === 'vault') {
      this.logger.info('Notion watch skipped — 정본이 볼트라 밖에서 고칠 곳이 없다');
      return;
    }
    this.logger.info('Started Notion watch', { everyMs: NOTION_WATCH_MS });
    this.notionWatchTimer = setInterval(async () => {
      // 앞판이 아직 도는 중이면 건너뛴다 — 다시 그리는 데 몇 초 걸린다.
      if (this.notionWatchBusy) return;
      this.notionWatchBusy = true;
      try {
        const redrew = await refreshBoardIfChanged();
        if (redrew) {
          this.logger.info('Notion changed outside the board — 판을 다시 올렸습니다');
        }
        if (this.notionWatchFailures) {
          this.logger.info(`Notion watch recovered (${this.notionWatchFailures}회 실패 뒤)`);
          this.notionWatchFailures = 0;
        }
      } catch (error) {
        // **이유를 메시지에 넣는다.** 로거가 Error 를 `{}` 로 찍어서, 따로 넣지
        // 않으면 이유 없는 경고만 쌓인다(2026-08-07 에 그렇게 9분을 날렸다).
        this.notionWatchFailures += 1;
        if (this.notionWatchFailures === 1 || this.notionWatchFailures % 20 === 0) {
          const why = error instanceof Error ? error.message : String(error);
          this.logger.warn(`Notion watch failed (${this.notionWatchFailures}회째): ${why}`);
        }
      } finally {
        this.notionWatchBusy = false;
      }
    }, NOTION_WATCH_MS);
  }

  /**
   * 판에서 누른 것을 가져와 반영한다 — `BOARD_QUEUE_POLL_MS` 마다.
   *
   * **폴링 간격이 곧 무르는 창이다.** 가져가기 전이면 화면에서 뺄 수 있고, 가져간
   * 뒤에는 못 무른다(그때는 이미 노션에 쓰고 있을 수 있다). 확인 대화상자를 안
   * 두는 이유가 이것이다 — 폰에서 한 번 더 누르게 만들면 안 쓰게 된다.
   *
   * **반영한 것은 DM 한 줄로 알린다.** 큐는 눈에 안 보여서, 알리지 않으면 눌렀는데
   * 됐는지를 판이 다시 그려질 때까지 알 수 없다. 알리는 것이라 봇의 수신 관문은
   * 건드리지 않는다.
   *
   * 실패는 여기서 시끄럽게 하지 않는다 — 30초마다 도는 자리라 네트워크가 한 번
   * 튈 때마다 DM 이 오면 무시하는 습관이 든다. 반영이 밀리는 것은 `brief` 의 ⛔ 가
   * 잡는다(폴러 밖에 있어야 폴러가 죽어도 보인다).
   */
  /**
   * 판 맨 위 한 줄 — 업무일 07~19시 **정각마다**.
   *
   * **돈이 드는 유일한 폴러다.** 그래서 안 돌아도 되는 경우를 전부 앞에서 끊는다:
   * 창 밖 · 주말·공휴일 · 「조용히」 기간 · 앞판이 아직 도는 중. 판단이 안 서면
   * (`isQuietPeriod` 가 못 읽으면) **도는 쪽**으로 답한다 — 조용해지는 쪽으로
   * 틀리면 무언가 깨졌을 때 그게 정상으로 보인다.
   *
   * 실패는 조용히 넘긴다. 판에 안 뜨는 것이 곧 신호이고(낡으면 흐려진다),
   * 시각마다 오는 실패 쪽지는 곧 무시된다.
   */
  private scheduleFocus(): void {
    const next = new Date();
    next.setHours(next.getHours() + 1, 0, 5, 0);   // 정각 + 5초
    const waitMs = next.getTime() - Date.now();
    this.logger.info('Scheduled board focus', { nextFire: next.toISOString() });

    this.focusTimer = setTimeout(async () => {
      const hour = new Date().getHours();
      const nonWorking = this.isNonWorkingDay();
      try {
        if (this.focusBusy) {
          this.logger.info('Skipping board focus (앞판이 아직 돕니다)');
        } else if (hour < FOCUS_FROM_HOUR || hour > FOCUS_TO_HOUR
                   || (hour - FOCUS_FROM_HOUR) % FOCUS_EVERY_HOURS !== 0) {
          // 로그도 안 남긴다 — 하루 열일곱 번 「이 시각 아님」이 쌓이면 로그만 흐려진다
        } else if (nonWorking.skip) {
          this.logger.info(`Skipping board focus (${nonWorking.reason})`);
        } else if (await isQuietPeriod()) {
          this.logger.info('Skipping board focus (조용히 기간)');
        } else if (await sessionFocusWithin(FOCUS_EVERY_HOURS)) {
          // 아침 브리핑에서 사람과 같이 정한 줄이 아직 이 차례 안에 있다. 데이터만
          // 보는 이쪽이 그것을 덮으면 대화에서 정한 순서가 사라진다.
          this.logger.info('Skipping board focus (사람이 적은 줄이 아직 이 차례 안)');
        } else {
          this.focusBusy = true;
          await this.runFocus();
        }
      } catch (error) {
        this.logger.warn('Board focus failed', {
          why: error instanceof Error ? error.message : String(error),
        });
      } finally {
        this.focusBusy = false;
        this.scheduleFocus();
      }
    }, waitMs);
  }

  private async runFocus(): Promise<void> {
    const promptPath = path.join(this.promptsDir, 'focus.md');
    if (!fs.existsSync(promptPath)) {
      this.logger.warn(`Focus prompt not found: ${promptPath}`);
      return;
    }
    // ⚠️ **업무 비서 쪽에서 돈다.** 스케줄러의 기본 작업 디렉터리는 프롬프트가
    // 사는 곳이라, 그대로 두면 `bin/tasks.py` 가 없어 매시간 조용히 실패한다.
    const root = workAssistantRoot();
    if (!root) return;
    const result = await this.spawnOrFallback('지금 집중할 것',fs.readFileSync(promptPath, 'utf-8'), {
      workingDirectory: root,
      model: FOCUS_MODEL,
      effort: FOCUS_EFFORT,
      permissionMode: 'default',
      // 이 세션이 하는 일은 **읽고 한 줄 쓰기**뿐이다. 도구를 넓히면 매시간 도는
      // 자리에서 무엇이든 할 수 있게 된다.
      //
      // `tools` 와 `allowedTools` 는 다른 것이다 — 앞은 **모델에게 보이는 목록**,
      // 뒤는 물어보지 않고 허용하는 목록. 뒤만 좁히면 나머지 도구의 설명이 그대로
      // 문맥에 실려 매번 돈이 된다(첫 실측 $0.93/회 · 캐시 쓰기 7.7만 토큰).
      tools: ['Bash', 'Read'],
      allowedTools: ['Bash', 'Read'],
      // **규칙 파일을 안 읽는다.** 이 세션은 프롬프트 하나로 끝나고 그 프롬프트가
      // 곧 규칙인데, 설정을 읽는 순간 두 CLAUDE.md(6.8만 자)가 따라 들어온다 —
      // 첫 실측 $0.93/회의 대부분이 그것이었다. 대신 허용 규칙이 없어지므로
      // 파이썬 호출만 여기서 직접 열어 준다(그 밖은 조용히 거부된다).
      settingSources: [],
      settings: { permissions: { allow: ['Bash(python:*)', 'Read'] } },
      appendSystemPrompt:
        'tasks.py 의 json·focus 두 서브커맨드만 쓴다. 그 외 쓰기·발신 금지.',
      env: { ASSISTANT_MODE: 'focus', CLAUDE_SCHEDULED: '1' },
      skipMcp: true,
      noSessionPersistence: true,
      maxDurationMs: 3 * 60_000,
      useSdk: true,
    });
    this.recordSessionCost('focus', result);
    this.logger.info('Board focus updated', {
      costUsd: result.costUsd?.toFixed(4),
      text: result.text?.substring(0, 200),
    });
  }

  /**
   * **밖에서 온 문의를 DM 한 줄로 보여 준다.**
   *
   * 여기서 하는 일은 보여 주는 것 하나다. 이 글은 밖에서 온 사람이 썼다 —
   * `quick`·`ask` 로 넘기면 남이 내 업무를 고치고 내 돈으로 모델을 부른다.
   * 담기는 칸부터 판 큐와 다르고, 여기서도 해석하지 않는다.
   *
   * 글자를 그대로 붙이지 않는다. 밖에서 온 글이라 슬랙 문법이 섞여 있으면 화면이
   * 엉킨다 — 코드 블록에 넣어 글자 그대로 보인다. 코드 블록을 닫는 글자가 본문에
   * 들어 있으면 그것만 비슷한 모양으로 바꾼다.
   *
   * **참을 내야 큐에서 지워진다** — 슬랙이 한 번 튀면 다음 판에 다시 온다.
   */
  private tellContact = async (c: ContactItem): Promise<boolean> => {
    const who = [c.name, c.org].filter(Boolean).join(' · ') || '이름 안 적음';
    // 워커가 메일 모양을 이미 봤으므로 빈 값은 여기 못 온다. 그래도 옛 문의가
    // 큐에 남아 있을 수 있어 없는 경우를 지운 값으로 두지 않는다.
    const how = c.reply || '메일 안 적음 (옛 문의)';
    const body = c.text.split('```').join('ˋˋˋ');
    try {
      await this.sendMessage(
        `✉️ 문의 온 것 — ${who}` + '\n' + `메일: ${how}` + '\n' + '\n'
        + '```' + '\n' + body + '\n' + '```',
      );
      return true;
    } catch (error) {
      this.logger.warn('문의를 슬랙에 못 적었습니다', {
        reason: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  };

  private startBoardQueuePoller(): void {
    if (!boardQueueEnabled()) {
      this.logger.info('Board queue poller off (주소나 열쇠 없음)');
      return;
    }
    this.logger.info('Started board queue poller', {
      everyMs: BOARD_QUEUE_POLL_MS,
      nightMs: BOARD_QUEUE_NIGHT_MS,
      awake: `${BOARD_QUEUE_AWAKE_FROM}~${BOARD_QUEUE_AWAKE_TO}시`,
      dailyCalls: boardQueueDailyCalls(),
      push: process.env.BOARD_PUSH === 'off' ? 'off' : 'on',
    });
    this.boardQueueTimer = setInterval(() => { void this.tickBoardQueue(false); }, BOARD_QUEUE_POLL_MS);
    // **알림이 오면 주기를 안 기다리고 바로 돈다** (2026-10-01). 끄는 문은 `BOARD_PUSH=off`
    // 하나 — 끄면 위 타이머가 예전 주기(낮 2초 · 밤 30초)로 그대로 돈다.
    if (process.env.BOARD_PUSH !== 'off') {
      this.boardPush?.stop();
      this.boardPush = new BoardPush({
        target: () => boardPushTarget(),
        authBroken: () => boardPushAuthBroken(),
        onNew: () => { void this.tickBoardQueue(true); },
        // 끊김마다 한 줄 — 하루 활동 요약이 세고, 「경고 없이 끊김」 관찰(10/09)의 재료가 된다.
        onDrop: (d) => recordEvent('push-drop', { ...d }),
      });
      this.boardPush.start();
    }
  }

  /**
   * 큐를 한 번 비운다. `force` 는 알림이 깨운 것 — 주기 판정을 건너뛴다.
   *
   * **한 판이 도는 동안 온 알림은 버리지 않는다** — 끝난 뒤 한 번 더 돈다. 안 그러면
   * 세션 하나(20초)가 도는 사이에 누른 버튼이 안전망 주기(60초)까지 기다린다.
   */
  private async tickBoardQueue(force: boolean): Promise<void> {
    if (this.boardQueueBusy) {
      if (force) this.boardQueueAgain = true;
      return;
    }
    // 밤에는 건너뛴다 — 워커 무료 한도가 이 폴러 하나로 43%를 쓰고 있었다.
    // 알림 연결이 정상이면 낮에도 60초 — 그때 이 주기는 안전망일 뿐이다.
    const now = Date.now();
    if (!force && now - this.boardQueueLast
        < boardQueueGapMs(new Date(now), this.boardPush?.healthy(now) ?? false)) return;
    this.boardQueueLast = now;
    this.boardQueueBusy = true;
    try {
      const r = await drain(quickUpdate, this.askFromBoard ?? null, undefined,
        noteUpdate, stageUpdate, this.narrowFromBoard, this.tellContact);
      if (this.boardQueueFailures) {
        this.logger.info(`Board queue recovered (${this.boardQueueFailures}회 실패 뒤)`);
        this.boardQueueFailures = 0;
      }
      if (r.duplicates) {
        this.logger.info(`이미 반영한 것 ${r.duplicates}건을 지웠습니다`);
      }
      // **버튼으로 누른 것은 조용히 반영한다** (2026-08-19 사용자 결정).
      // 판에서 누른 사람은 판을 보고 있고 그 화면이 몇 초 뒤에 바뀐다 — 같은
      // 사실을 슬랙에 한 번 더 적으면 알림만 늘고 새로 아는 것이 없다. 버튼이
      // 만든 문자열은 화면이 지은 것이라 **해석이 끼어들 자리도 없다.**
      //
      // ⚠️ **말은 실패할 때만 한다** — 아래 `dropped`·`lost` 알림은 그대로다.
      // 조용한 것이 「됐다」는 뜻이 되려면 안 된 것은 반드시 말해야 한다.
      //
      // **경고만 골라 남긴다** — ✅ 줄은 판이 보여 주지만 「3회 연기」 같은 경고는
      // 판 어디에도 안 뜬다. 통째로 삼키면 일부러 만든 신호가 조용히 사라진다.
      for (const { output } of r.applied) {
        const tell = boardOutputToTell(output);
        if (tell) await this.sendMessage(tell).catch(() => { });
      }
      if (r.applied.length) {
        this.logger.info(`판에서 누른 것 ${r.applied.length}건 반영`);
      }
      if (r.contacts.length) {
        this.logger.info(`문의 ${r.contacts.length}건 전달`);
      }
      for (const item of r.dropped) {
        // **원인을 좁혀 말하지 않는다.** rc 2 는 「업무를 못 찾음」과 「형식이
        // 안 맞음」을 함께 뜻하는데, 봇이 둘을 가르려면 판정을 복제해야 한다.
        // 대신 **다음에 무엇을 할지**를 준다 — 받는 쪽에 필요한 것은 그것이다.
        await this.sendMessage(
          `⚠️ ${boardLabel()} 에서 누른 「${item.label || item.text}」을 반영하지 못했습니다 ` +
          '— 그 업무를 찾지 못했거나 형식이 맞지 않습니다.\n' +
          `누른 것은 취소됐습니다. ${boardLabel()} 을 새로고침해 다시 누르거나, ` +
          '카드를 눌러 편집창에서 바꾸세요.',
        ).catch(() => { });
      }
      for (const item of r.lost) {
        // **원문을 그대로 돌려준다.** 한 번만 시도하는 대가라, 여기서 안 돌려주면
        // 사람이 쓴 글이 조용히 사라진다. 붙여넣기만 하면 다시 갈 수 있게 둔다.
        await this.sendMessage(
          `⚠️ ${boardLabel()} 에서 보낸 말을 넘기지 못했습니다. 원문은 아래 그대로입니다 ` +
          '— 다시 보내시려면 이 방에 붙여넣으세요.\n\n' + item.text,
        ).catch(() => { });
      }
    } catch (error) {
      // **이유를 본문에 넣는다.** Error 객체를 그대로 넘기면 로거가
      // `JSON.stringify` 로 `{}` 를 찍어, 실패는 보이는데 왜인지가 안 남는다 —
      // 2026-08-07 에 워커를 올리기 전 9분 동안 이유 없는 경고만 쌓였다.
      //
      // **매번 찍지 않는다.** 30초마다 도는 자리라 하루 못 고치면 로그가 같은
      // 줄로 덮인다. 처음과 10분마다만 남긴다.
      this.boardQueueFailures += 1;
      if (this.boardQueueFailures === 1 || this.boardQueueFailures % 20 === 0) {
        const why = error instanceof Error ? error.message : String(error);
        this.logger.warn(
          `Board queue drain failed (${this.boardQueueFailures}회째): ${why}`);
      }
    } finally {
      this.boardQueueBusy = false;
    }
    if (this.boardQueueAgain) {
      this.boardQueueAgain = false;
      void this.tickBoardQueue(true);
    }
  }

  // --- Briefing ---

  /** Schedule next briefing on next working day (schedule-manager.ts:289-324 pattern). */
  private scheduleBriefing(): void {
    if (!this.config) return;
    const nextFire = this.getNextWorkingDay(this.config.briefing.time);
    const msUntil = nextFire.getTime() - Date.now();

    this.logger.info('Scheduled briefing', {
      time: this.config.briefing.time,
      nextFire: nextFire.toISOString(),
    });

    this.briefingTimer = setTimeout(async () => {
      // Double-check working day at fire time
      const nonWorking = this.isNonWorkingDay();
      if (nonWorking.skip) {
        this.logger.info(`Skipping briefing (${nonWorking.reason})`);
        this.scheduleBriefing();
        return;
      }

      try {
        const result = await this.executeBriefing();
        this.recordSessionCost('briefing', result);

        // **브리핑 본문을 정규식으로 훑지 않는다.** 브리핑은 그날의 보고서를 읽어
        // 요약하는데, 그 보고서 주제가 「사용량·한도·실패」다. 본문만 보고 판정하면
        // 「429가 적힌 보고서를 요약한 브리핑」이 통째로 삼켜지고 사용자는 그날
        // 브리핑 대신 「rate limit 도달」 한 줄만 받는다. 판정은 구조화 신호로 한다.
        if (isSessionRateLimited(result)) {
          this.logger.warn('Briefing hit rate limit');
          await this.sendMessage('⏳ 브리핑 실행 중 rate limit 도달. 다음 업무일에 재시도합니다.').catch(() => {});
        } else {
          // Append error report + cost stats line
          await this.sendMessage(result.text +
            this.formatErrorReport() + this.formatCostLine());

          // NAS 이동 컨펌 큐 — 항목별 결정 버튼 (inbox auto-classify company 분류분)
          try {
            const nasBlocks = await buildNasQueueBlocks(await listNasQueue());
            if (nasBlocks) {
              await this.sendMessage('📦 NAS 이동 컨펌 대기', nasBlocks).catch(() => {});
            }
          } catch (err) {
            this.logger.warn('NAS confirm queue check failed', err);
          }

          await this.postMorningProposals();
        }
      } catch (error) {
        const msg = (error as Error).message || '';
        if (isRateLimitText(msg)) {
          this.logger.warn('Briefing hit rate limit');
          await this.sendMessage('⏳ 브리핑 실행 중 rate limit 도달. 다음 업무일에 재시도합니다.').catch(() => {});
        } else {
          this.logger.error('Briefing failed', error);
          await this.sendMessage('❌ Morning briefing failed. Check logs for details.').catch(() => {});
        }
      }

      // Reschedule for next working day
      this.scheduleBriefing();
    }, msUntil);
  }

  /** If briefing was missed today (e.g. bot restarted after briefing time), run it now. */
  private async catchUpBriefingIfNeeded(): Promise<void> {
    if (!this.config?.briefing.enabled) return;
    if (this.isNonWorkingDay().skip) return;

    // Check if briefing already ran today (KST)
    const todayKST = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
    const lastBriefing = [...this.costEntries]
      .reverse()
      // 폴백이 돌다 실패한 회차(`ok: false`)는 「돌았다」로 안 친다 — 재시작 뒤에 다시 돌아야 한다.
      .find(e => e.type === 'briefing' && e.ok !== false);

    if (lastBriefing) {
      const lastDateKST = new Date(new Date(lastBriefing.timestamp).getTime() + 9 * 3600_000)
        .toISOString().slice(0, 10);
      if (lastDateKST === todayKST) return; // Already ran today
    }

    // Check if briefing time has passed
    const [h, m] = this.config.briefing.time.split(':').map(Number);
    const nowKST = new Date(Date.now() + 9 * 3600_000);
    if (nowKST.getUTCHours() < h || (nowKST.getUTCHours() === h && nowKST.getUTCMinutes() < m)) return;

    this.logger.info('Catch-up briefing: missed today, running now');
    try {
      const result = await this.executeBriefing();
      this.recordSessionCost('briefing', result);
      await this.sendMessage(result.text +
        this.formatErrorReport() + this.formatCostLine());

      await this.postMorningProposals();
    } catch (error) {
      const msg = (error as Error).message || '';
      if (isRateLimitText(msg)) {
        await this.sendMessage('⏳ Catch-up 브리핑 중 rate limit 도달.').catch(() => {});
      } else {
        this.logger.error('Catch-up briefing failed', error);
      }
    }
  }

  /**
   * If today's spinner fresh batch is missing, generate it now.
   *
   * The daily-00:00 data-sync (which runs fresh_pool_generator) has no catch-up: if the
   * PC/bot is down at 00:00 the run is silently skipped, leaving morning sessions on the
   * baseline+categorical pool with no novelty until the noon data-sync (12:00) fills it.
   * This closes that 00:00→12:00 morning gap on bot startup. Best-effort — any failure
   * leaves the pool on its graceful baseline fallback.
   */
  private async catchUpSpinnerFreshIfNeeded(): Promise<void> {
    if (this.isNonWorkingDay().skip) return; // fresh not generated on holidays/weekends

    const spinnerDir = path.join(os.homedir(), '.claude', 'spinner-verbs');
    const todayKST = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
    const freshPath = path.join(spinnerDir, `daily-fresh-${todayKST}.yaml`);
    if (fs.existsSync(freshPath)) return; // 00:00 ran, or an earlier catch-up already did it

    this.logger.info('Catch-up spinner fresh: today batch missing, generating now', { freshPath });
    try {
      const gen = await this.runSpinnerScript('fresh_pool_generator.py', spinnerDir, 240_000);
      if (gen.code !== 0 || !fs.existsSync(freshPath)) {
        // fresh_pool_generator is graceful (exit 0 + no file on agy/parse failure) — leave baseline.
        this.logger.warn('Catch-up spinner fresh: generator produced no batch (graceful skip)', {
          code: gen.code,
          stderrTail: gen.stderr.trim().split('\n').slice(-3).join(' | '),
        });
        return;
      }
      await this.runSpinnerScript('build_daily_pool.py', spinnerDir, 60_000);
      this.logger.info('Catch-up spinner fresh: done');
    } catch (error) {
      this.logger.error('Catch-up spinner fresh failed', error);
    }
  }

  /** Run a spinner-verbs python script in its own dir. Mirrors nas-confirm.ts spawn pattern. */
  private runSpinnerScript(
    script: string,
    cwd: string,
    timeoutMs: number,
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const proc = spawn('python', ['-X', 'utf8', script], {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8' },
        // 콘솔 창이 화면에 깜빡이지 않게 한다. 이 프로세스에는 콘솔이 없어서
        // 윈도우가 자식마다 새 콘솔을 만들어 주고, `shell: true` 는 cmd.exe 를
        // 거치므로 특히 필요하다. 출력은 이미 파이프로 받고 있어 잃는 것이 없다.
        windowsHide: true,
      });
      let stdout = '';
      let stderr = '';
      proc.stdout?.on('data', (c: Buffer) => { stdout += c.toString('utf-8'); });
      proc.stderr?.on('data', (c: Buffer) => { stderr += c.toString('utf-8'); });
      const killTimer = setTimeout(() => {
        try {
          if (process.platform === 'win32' && proc.pid) {
            execSync(`taskkill /F /T /PID ${proc.pid}`, { stdio: 'ignore' });
          } else {
            proc.kill('SIGKILL');
          }
        } catch {}
      }, timeoutMs);
      proc.on('error', (err) => { clearTimeout(killTimer); reject(err); });
      proc.on('close', (code) => { clearTimeout(killTimer); resolve({ code: code ?? -1, stdout, stderr }); });
    });
  }

  /**
   * 결정론 러너를 세션보다 **먼저** 띄우는 분석 종 — 무엇을 어디서 띄우나.
   *
   * 데일리 둘은 `daily_pipeline_run`(레포 루트에서 `-m mycelium.batch…`), 주간 셋은
   * `_detached_runner` 공통부를 쓰는 러너(`mycelium/` 에서 `-m batch.…`)라 cwd 가 다르다.
   *
   * 주간 셋은 2026-09-09 에 「아직 이 실패를 안 냈으므로」 빼 두었는데, 09-12 토요일에
   * archive-sync·product-docs 가 같은 모양으로 갔다(7초 · 도구 0회 · 되묻고 종료 ·
   * `completed` 기록). 이중 기동 가드는 `_detached_runner.Runner.already_launched` 로
   * 먼저 넣었다(2026-09-14) — 가드 없이 이 표에 넣으면 프롬프트의 두 번째 호출이
   * 「완주한다」는 거짓 성공 메시지를 세션에 주고 그 회차의 부팅 로그를 지운다.
   *
   * 여기 없는 종은 러너가 없는 종이다(세션이 직접 돌린다).
   */
  private static readonly RUNNER_PRELAUNCH_BY_TYPE: Record<string, { argv: string[]; cwdSub?: string }> = {
    'data-sync': { argv: ['-m', 'mycelium.batch.daily_pipeline_run', '--cycle', 'midnight', '--detach'] },
    'data-sync-noon': { argv: ['-m', 'mycelium.batch.daily_pipeline_run', '--cycle', 'noon', '--detach'] },
    'product-docs-sync': { argv: ['-m', 'batch.product_docs_weekly_sync', '--detach'], cwdSub: 'mycelium' },
    'archive-sync': { argv: ['-m', 'batch.archive_weekly_sync', '--detach'], cwdSub: 'mycelium' },
    'kg-regression': { argv: ['-m', 'batch.kg_regression_weekly', '--detach'], cwdSub: 'mycelium' },
  };

  /**
   * 결정론 러너를 detach 로 띄운다 — **세션이 뜨기 전에**.
   *
   * 프롬프트가 §3 에서 러너를 띄우도록 시키는 구조였고, 그것이 두 번 깨졌다.
   * 09-03 은 세션이 §3 을 건너뛰고 전날 기록으로 가짜 보고서를 냈고, 09-09 는 세션이
   * 9초 만에 도구 호출 0회로 되물으며 끝났다. **두 번 다 `subtype: success` 로
   * 기록됐다.** 그때마다 promote·발행 두 벌이 통째로 빠졌다.
   *
   * 09-03 처방은 프롬프트 문구였다. 같은 함정에 두 번 걸렸으므로 글이 아니라 기계로
   * 옮긴다 — 기동은 스케줄러가 하고, 세션은 폴링·판단·보고서만 맡는다. 세션이 무슨
   * 짓을 하든 데이터 작업은 이미 트리 밖에서 돌고 있다.
   *
   * 이중 기동은 러너 쪽 `--detach` 가드가 막는다(`daily_pipeline_run._already_launched` ·
   * `_detached_runner.Runner.already_launched`). 그래서 프롬프트의 `--detach` 호출을
   * 지우지 않아도 안전하고, 재시도 회차에서 다시 불러도 무해하다. Best-effort —
   * 던지지 않는다(기동 실패도 세션은 돌아야 한다).
   */
  private launchPipelineRunner(
    type: string, spec: { argv: string[]; cwdSub?: string }, ctx: AnalysisCtx,
  ): Promise<void> {
    // 회차(`REPORT_*`)와 예정일(`--date`)을 넘긴다 — `runnerLaunch` 주석.
    const launch = runnerLaunch(spec, this.workingDir, ctx);
    return new Promise((resolve) => {
      const proc = spawn(
        'python',
        launch.args,
        {
          cwd: launch.cwd,
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: process.platform === 'win32',
          env: launch.env,
          windowsHide: true,
        },
      );
      let stdout = '';
      let stderr = '';
      proc.stdout?.on('data', (c: Buffer) => { stdout += c.toString('utf-8'); });
      proc.stderr?.on('data', (c: Buffer) => { stderr += c.toString('utf-8'); });
      // 이 명령은 자식을 띄우고 바로 돌아온다 — 오래 걸릴 일이 없다.
      const killTimer = setTimeout(() => {
        try {
          if (process.platform === 'win32' && proc.pid) {
            execSync(`taskkill /F /T /PID ${proc.pid}`, { stdio: 'ignore' });
          } else {
            proc.kill('SIGKILL');
          }
        } catch {}
      }, 60_000);
      proc.on('error', (err) => {
        clearTimeout(killTimer);
        this.logger.error('Pipeline runner spawn error', err);
        resolve();
      });
      proc.on('close', (code) => {
        clearTimeout(killTimer);
        const out = (stdout.trim() || stderr.trim());
        this.logger.info('Pipeline runner pre-launched', {
          type,
          argv: launch.args.slice(2).join(' '),
          runId: ctx.run?.runId ?? null,
          code: code ?? -1,
          // 「detach 실행 pid=」면 이번에 띄운 것이고 「띄우지 않는다」면 이미 떠 있던 것이다.
          out: out.slice(0, 300),
        });
        resolve();
      });
    });
  }

  /**
   * Ping Daou to reset its server-side idle timer, keeping the operator's session alive.
   * Reuses groupware_daily's --keepalive mode (session_alive() + alert upsert, no fetch/worker),
   * run from the claude-workflow repo root (this.workingDir). Best-effort — never throws.
   */
  private runDaouKeepAlive(): Promise<void> {
    return new Promise((resolve) => {
      const proc = spawn(
        'python',
        ['-X', 'utf8', '-m', 'mycelium.sync.groupware_daily', '--keepalive', '--json'],
        {
          cwd: this.workingDir,
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: process.platform === 'win32',
          env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8' },
          // 콘솔 창이 화면에 깜빡이지 않게 한다. 이 프로세스에는 콘솔이 없어서
          // 윈도우가 자식마다 새 콘솔을 만들어 주고, `shell: true` 는 cmd.exe 를
          // 거치므로 특히 필요하다. 출력은 이미 파이프로 받고 있어 잃는 것이 없다.
          windowsHide: true,
        },
      );
      let stdout = '';
      let stderr = '';
      proc.stdout?.on('data', (c: Buffer) => { stdout += c.toString('utf-8'); });
      proc.stderr?.on('data', (c: Buffer) => { stderr += c.toString('utf-8'); });
      const killTimer = setTimeout(() => {
        try {
          if (process.platform === 'win32' && proc.pid) {
            execSync(`taskkill /F /T /PID ${proc.pid}`, { stdio: 'ignore' });
          } else {
            proc.kill('SIGKILL');
          }
        } catch {}
      }, 60_000);
      proc.on('error', (err) => {
        clearTimeout(killTimer);
        this.logger.error('Daou keep-alive spawn error', err);
        resolve();
      });
      proc.on('close', () => {
        clearTimeout(killTimer);
        const alive = /"session_alive":\s*true/.test(stdout);
        this.logger.info('Daou keep-alive ping', {
          alive,
          out: (stdout.trim() || stderr.trim()).slice(0, 200),
        });
        resolve();
      });
    });
  }

  /** Schedule the Daou keep-alive at 13:00 EVERY calendar day (no working-day skip). */
  private scheduleDaouKeepAlive(): void {
    // Idempotent: drop any existing timer so a double-call can't fork the self-rescheduling chain.
    if (this.daouKeepAliveTimer) clearTimeout(this.daouKeepAliveTimer);
    const nextFire = this.getNextEveryDayTime('13:00');
    const msUntil = Math.max(0, nextFire.getTime() - Date.now());
    this.logger.info('Scheduled Daou keep-alive', { nextFire: nextFire.toISOString() });
    this.daouKeepAliveTimer = setTimeout(async () => {
      await this.runDaouKeepAlive().catch(e => this.logger.error('Daou keep-alive failed', e));
      this.scheduleDaouKeepAlive();
    }, msUntil);
  }

  /** Next occurrence of HH:MM on ANY day — unlike getNextWorkingDay, does not skip weekends/holidays. */
  private getNextEveryDayTime(time: string): Date {
    const [h, m] = time.split(':').map(Number);
    const now = new Date();
    const next = new Date(now);
    next.setHours(h, m, 0, 0);
    if (next <= now) {
      next.setDate(next.getDate() + 1);
    }
    return next;
  }

  /**
   * 좁은 길 한 바퀴 — 재료(파이썬) → 모델 한 번 → 앉히기(파이썬).
   *
   * **업무 로직이 여기 없다.** 카드 값을 만드는 것도 앉히는 것도 `tasks.py` 가
   * 하고, 여기서는 그 둘 사이에 모델을 한 번 끼워 넣는다 — 규칙이 한 곳에 있다.
   *
   * 못 받으면 `not-quick` 으로 물러난다. 부르는 쪽이 평소 경로(세션)로 떨어뜨린다.
   */
  private narrowFromBoard = async (text: string, press?: string): Promise<QuickOutcome> => {
    if (process.env.BOARD_NARROW === 'off') return { kind: 'not-quick', code: 'off' };
    const root = workAssistantRoot();
    if (!root) return { kind: 'not-quick', code: 'no-root' };
    // 업무를 안 짚은 말(실측 10%)은 대상을 스스로 찾아야 해서 세션 몫이다.
    const task = narrowTask(text);
    if (!task) return { kind: 'not-quick', detail: '업무를 안 짚었다', code: 'no-task' };
    const rules = path.join(root, NARROW_RULES);
    if (!fs.existsSync(rules)) {
      this.logger.error(`좁은 길 규칙이 없습니다 — ${rules}`);
      return { kind: 'not-quick', detail: '규칙 파일 없음', code: 'no-rules' };
    }
    const card = await narrowCard(task);
    if (!card) return { kind: 'not-quick', detail: `${task} 재료를 못 만듦`, code: 'no-card' };
    // 두 엔진이 **같은 규칙**을 받아야 한다 — 한쪽만 고치면 폴백이 다른 일을 한다.
    const rulesText = fs.readFileSync(rules, 'utf-8');

    const today = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    const day = `${today.getFullYear()}-${p(today.getMonth() + 1)}-${p(today.getDate())}`;
    // 첫 줄은 말머리(`[진행판] TSK-5 「…」`)라 뺀다 — 규칙이 배운 모양이 본문뿐이다.
    const body = text.split('\n').slice(1).join('\n').trim() || text.trim();
    const user = [
      `오늘은 ${day}`, '',
      `업무: 「${card.title}」`,
      `지금 카드 값: ${card.card}`, '',
      '판 「프롬프트」 칸에 온 말:', body,
    ].join('\n');

    let said = '';
    // 왜 1차가 못 했나 — 관찰 기록에 그대로 실어 보낸다.
    let why = '';
    try {
      const result = await this.spawnSession(user, {
        workingDirectory: root,
        model: NARROW_MODEL,
        effort: NARROW_EFFORT,
        permissionMode: 'default',
        // **도구가 하나도 없다.** 읽기도 쓰기도 파이썬이 한다.
        tools: [],
        allowedTools: [],
        // 규칙 파일을 안 읽는다 — CLAUDE.md 가 따라 들어오면 좁은 길이 아니게 된다.
        settingSources: [],
        appendSystemPrompt: rulesText,
        env: { ASSISTANT_MODE: 'narrow', CLAUDE_SCHEDULED: '1' },
        skipMcp: true,
        noSessionPersistence: true,
        // 실측 중간값 3~4초 — 상한에 닿으면 세션으로 떨어지는 편이 낫다.
        maxDurationMs: 90_000,
        useSdk: true,
        // 다음 판 프롬프트를 위해 같은 옵션으로 하나 띄워 둔다(띄우기 약 1.5초를 앞당김).
        prewarmAfter: true,
      });
      this.recordSessionCost('narrow', result);
      said = (result.text || '').trim();
      // **답이 있어도 오류 표시가 붙었으면 안 믿는다** — 한도에 걸리거나 중간에
      // 끊긴 회차가 **부분 응답**을 들고 올 수 있고, 그것을 성공으로 읽으면
      // 반쪽짜리 판단이 카드에 앉는다. 폴백 한 번이 그보다 싸다.
      if (result.isError || result.rateLimited) {
        why = result.rateLimited ? 'rate-limited' : (result.subtype || 'error');
        said = '';
      } else if (!said) {
        why = 'empty';
      }
    } catch (err) {
      // ★ **여기가 이 폴백의 진짜 방아쇠다.** 구독 만료·인증 실패는 스트림에
      // 오류를 실어 보내는 것이 아니라 **토큰을 가져오다 던진다**
      // (`runAssistantSession` 이 `getAccessToken()` 을 먼저 부른다).
      // 감싸지 않으면 그 길로 새어 폴백을 통째로 건너뛴다 — 정작 필요한
      // 그날에만 안 도는 장치가 된다.
      why = 'threw';
      this.logger.warn('좁은 길 1차(Agent SDK)가 터졌습니다 — codex 로 갑니다', err);
    }

    // ★ **폴백 한 칸** (2026-09-03) — 1차가 빈손이면 codex 가 같은 일을 한다.
    //
    // **빈손일 때만 간다.** 말은 나왔는데 그 JSON 을 파이썬이 거절한 것이면
    // 내용 문제라 엔진을 갈아 끼워도 같은 답이 온다 — 그때는 오늘까지와 같이
    // 세션으로 떨어지는 편이 맞다. 여기서 또 부르면 돈과 시간만 두 배가 된다.
    //
    // **두 번 하기 위험이 없다** — 좁은 길은 「글 → JSON → 파이썬이 반영」이라
    // 반영은 아래 `narrowApply` 한 번뿐이다. 세션 경로에 같은 사다리를 놓으려면
    // 되돌리기 문이 따로 필요하다(도구를 여러 번 돌려 중간에 죽을 수 있다).
    if (!said) {
      const fb0 = Date.now();
      said = await narrowCodex(rulesText, user);
      // **센다.** 얼마나 도는지를 로그로만 알 수 있으면 아무도 안 센다 —
      // 이 레포에서 무시되는지·도는지를 세는 것은 `tasks.py events` 다.
      recordEvent('narrow-fallback', { why, ok: !!said, ms: Date.now() - fb0 });
      // **원장에도 남긴다** — 구독이라 값은 0 이지만 빈칸이면 폴백이 몇 번 돌았는지가 원장에서 안 보인다.
      this.recordFallbackRun('narrow', 'codex', Date.now() - fb0, !!said);
      if (said) this.logger.warn(`좁은 길 1차가 못 해서(${why}) codex 로 처리했습니다`);
      else this.logger.warn(`좁은 길 1차·폴백 둘 다 빈손(${why}) — 세션으로 갑니다`);
    }

    if (!said) return { kind: 'not-quick', detail: '좁은 길이 아무 말도 안 했다', code: 'empty' };
    return narrowApply(said, task, press);
  };

  /**
   * **예약 세션 한 번 — 1차 Agent SDK · 못 하면 codex** (2026-09-03).
   *
   * 좁은 길과 달리 여기는 **두 번 하기 위험이 있다.** 세션이 도구를 여러 번
   * 돌리므로 중간에 죽으면 이미 쓴 것이 있을 수 있고, 같은 프롬프트를 다시
   * 돌리면 그 일이 두 번 일어난다.
   *
   * **문은 `toolCalls` 다** — 하나라도 돌렸으면 폴백을 안 한다.
   *   - 던졌다 → 스트림을 열기 전이라 아무것도 안 돌았다 · 안전
   *   - 도구 0회로 실패 → 부작용이 없다 · 안전
   *   - 도구 1회 이상 뒤 실패 → **안 한다.** 무엇이 얼마나 됐는지 모른다
   *
   * ⚠️ **`toolCalls` 를 못 읽는 회차는 안 한 것으로 치지 않는다** — 값이 없으면
   * (`undefined`) 셋째 갈래로 본다. 모르는 것을 0 으로 읽으면 그 회차가 두 번 돈다.
   */
  private async spawnOrFallback(
    label: string, prompt: string, opts: SpawnOpts,
  ): Promise<SessionResult> {
    let result: SessionResult | null = null;
    let why = '';
    try {
      result = await this.spawnSession(prompt, opts);
      // 1차가 낸 결과는 실패든 성공이든 Claude 몫이다 — 폴백이 받을 때만 아래에서 바꾼다.
      result.servedBy = 'claude';
      const said = (result.text || '').trim();
      if (result.isError || result.rateLimited) {
        why = result.rateLimited ? 'rate-limited' : (result.subtype || 'error');
      } else if (!said) {
        why = 'empty';
      } else {
        return result;
      }
    } catch (err) {
      // 구독 만료·인증 실패는 여기로 온다 — 스트림을 열기 전이라 아무것도 안 돌았다.
      why = 'threw';
      this.logger.warn(`${label} 1차(Agent SDK)가 터졌습니다`, err);
    }

    // ⚠️ **이어받는 회차는 폴백을 안 한다** — 그때 프롬프트는 `'continue'` 한
    // 낱말이고 앞선 대화는 Claude 쪽 세션에만 있다. codex 에게 넘기면 문맥 없이
    // 「계속하라」는 말만 받는다.
    if (opts.resumeSessionId) {
      this.logger.warn(`${label} 폴백 안 함 — 이어받는 회차라 문맥이 저쪽에만 있음`);
      recordEvent('session-fallback', { label, why, skipped: 'resume' });
      return result ?? { text: '', costUsd: 0, sessionId: '', subtype: why, isError: true };
    }
    if (opts.fallbackScope === null) {
      recordEvent('session-fallback', { label, why, skipped: 'off' });
      return result ?? { text: '', costUsd: 0, sessionId: '', subtype: why, isError: true };
    }

    const ran = result ? result.toolCalls : 0;
    if (ran !== 0) {
      // 모르는 것(`undefined`)도 여기로 온다 — 0 으로 읽으면 두 번 돈다.
      this.logger.warn(`${label} 폴백 안 함 — 도구를 ${ran ?? '몇 번인지 모르게'} 돌린 뒤 실패`);
      recordEvent('session-fallback', { label, why, skipped: 'tools-ran', toolCalls: ran ?? null });
      return result ?? { text: '', costUsd: 0, sessionId: '', subtype: why, isError: true };
    }

    // **같은 등급으로 넘긴다**(2026-09-23) — 모델은 llm-playbook 의 등급 표에서(Opus → Astra ·
    // Sonnet → Sol · Haiku → Luna). 예전에는 1차 등급과 무관하게 늘 같은 codex 모델로 갔다.
    const primary = opts.model || config.defaultModel;
    const toolFree = Array.isArray(opts.tools) && opts.tools.length === 0;
    let said = '';
    let via = '';
    let servedBy: Backend = 'codex';
    const fb0 = Date.now();
    if (toolFree) {
      // **도구 없는 회차는 사다리로**(읽기 전용 codex → agy) — 글만 주고받는 일이다. codex 세션으로
      // 넘기면 작업 폴더 쓰기 권한까지 붙어 1차보다 권한이 넓어진다(2026-09-23 점검).
      const got = await ladderText(label, prompt, {
        model: primary,
        system: opts.systemPrompt ?? opts.appendSystemPrompt,
        timeoutMs: opts.maxDurationMs,
      });
      if (got) {
        said = got.text;
        via = `${got.backend} ${got.model}`;
        servedBy = got.backend === 'agy' ? 'agy' : 'codex';
      }
    } else {
      const cell = await sameTier(primary, 'codex');
      const scope = opts.fallbackScope;
      said = await codexSession(prompt, {
        workingDirectory: scope ? scope.cwd : opts.workingDirectory,
        // 범위를 받은 회차는 그 범위만 연다 — 작업 폴더(`-C`)는 이미 쓰기가 열려 있어 빼고 넘긴다.
        writableDirs: scope ? scope.writable.filter((d) => d !== scope.cwd) : undefined,
        appendSystemPrompt: opts.appendSystemPrompt,
        timeoutMs: opts.maxDurationMs,
        // **1차와 같은 깊이로 돈다** — 폴백이 얕게 돌면 「돌긴 돌았는데 쓸 게 없는」
        // 산출물이 나오고, 그건 실패보다 알아채기 어렵다(2026-09-08).
        effort: opts.effort,
        model: cell?.model,
      });
      via = `codex ${cell?.model ?? '(기본 모델)'}`;
      // 사다리를 안 거친 폴백은 기록 파일에 안 남으므로 브리핑 「시스템 이슈」로 직접 알린다.
      errorCollector.add('폴백', `${label} — Claude ${why} → ${said ? `${via} 가 받음` : '폴백도 실패'}`);
    }
    recordEvent('session-fallback', { label, why, ok: !!said, via });
    if (said) {
      this.logger.warn(`${label} 1차가 못 해서(${why}) ${via} 로 처리했습니다`);
      // 걸린 시간을 싣는다 — 원장(`recordFallbackRun`)이 폴백 회차의 길이를 이것으로 남긴다.
      return { text: said, costUsd: 0, sessionId: '', subtype: 'success', isError: false, toolCalls: 0, servedBy,
               timing: { resultMs: Date.now() - fb0 } };
    }
    this.logger.warn(`${label} 1차·폴백 둘 다 못 했습니다(${why})`);
    return result ?? { text: '', costUsd: 0, sessionId: '', subtype: why, isError: true };
  }

  private async executeBriefing(): Promise<SessionResult> {
    const promptPath = path.join(this.promptsDir, 'morning-briefing.md');
    let prompt = fs.readFileSync(promptPath, 'utf-8');

    // Inject exclude calendars list
    const excludeList = this.config?.briefing.excludeCalendars;
    if (excludeList && excludeList.length > 0) {
      prompt = prompt.replace(/\{excludeCalendars\}/g, excludeList.map(c => `\`${c}\``).join(', '));
    } else {
      prompt = prompt.replace(/\{excludeCalendars\}/g, '(없음)');
    }

    // 그 주 첫 업무일(보통 월요일): 주간 보고를 덧붙인다
    const mondayExtra = await this.mondayBriefingExtra();
    if (mondayExtra) prompt += '\n\n' + mondayExtra;

    // Inject cached calendar data if available (saves MCP cost)
    // Validate cache is from today — stale cache shows yesterday's events
    // Use local timezone (KST), not UTC — at 08:00 KST, UTC date is still yesterday
    const toLocalDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const todayLocal = toLocalDate(new Date());
    let cache = this.calendarPoller?.getCache();
    if (cache && toLocalDate(new Date(cache.fetchedAt)) !== todayLocal) {
      this.logger.info('Calendar cache is stale (not today), refreshing...');
      cache = await this.calendarPoller?.refreshCache() ?? null;
    }
    let allowedTools: string[];

    if (cache && cache.events.length >= 0) {
      const eventList = cache.events.map(e => {
        const time = e.isAllDay ? '종일' : `${this.formatTimeFromISO(e.startTime)} ~ ${this.formatTimeFromISO(e.endTime)}`;
        const loc = e.location ? ` — ${e.location}` : '';
        return `- ${time} ${e.title}${loc} _${e.calendarName}_`;
      }).join('\n') || '(일정 없음)';

      prompt += `\n\n## 오늘의 캘린더 데이터 (캐시)\n${eventList}\n\n위 데이터를 사용하세요. 캘린더 도구를 호출하지 마세요.`;
      allowedTools = ['Read', 'Glob', 'Grep']; // No GCAL tools needed
    } else {
      // Fallback to MCP if no cache
      allowedTools = ['Read', 'Glob', 'Grep', ...GCAL_READ_TOOLS];
    }

    const useSdk = shouldUseSdk('briefing');
    // **haiku 를 걷어냈다**(2026-09-08 사용자). 정기 작업의 바닥은 sonnet+low 다.
    // haiku 4.5 는 `effort` 자체를 안 받아 깊이 손잡이가 없었고, 브리핑은 하루
    // 한 번이라 등급을 올려도 값 차이가 거의 없다.
    const result = await this.spawnOrFallback('아침 브리핑',prompt, {
      workingDirectory: this.workingDir,
      model: 'sonnet',
      effort: 'low',
      permissionMode: 'default',
      allowedTools,
      noSessionPersistence: true,
      skipMcp: true,
      env: { CLAUDE_SCHEDULED: '1' },
      useSdk,
    });

    // Extract only the final briefing output (starts with ☀️), dropping intermediate explanation text
    const briefingStart = result.text.lastIndexOf('☀️');
    if (briefingStart > 0) {
      result.text = result.text.substring(briefingStart);
    }

    return result;
  }

  /**
   * 주간 보고를 붙이는 날이면 그 판 목록의 시작 날짜(그 주 월요일 7일 전), 아니면 null.
   *
   * **월요일이 아니라 그 주 첫 업무일이다** — 브리핑은 휴일 · 휴가를 건너뛰므로, 월요일만 보면
   * 월요일이 쉬는 주는 주간 보고가 아예 없었다(2026-10-05 대체공휴일). 월요일부터 어제까지가 모두
   * 쉬는 날이면 오늘이 그 주 첫 업무일이다. 월요일은 늘 붙는다(쉬는 월요일에 손으로 부른 브리핑 포함).
   * 기간은 월요일에 붙일 때와 같게 맞춘다.
   */
  private weekReportSince(now: Date): string | null {
    const day = now.getDay();
    if (day < 1 || day > 5) return null;
    for (let back = 1; back < day; back++) {
      const d = new Date(now);
      d.setDate(now.getDate() - back);
      if (!this.isNonWorkingDay(d).skip) return null;
    }
    return shiftDate(kstDate(now), -(7 + day - 1));
  }

  /**
   * 주간 보고 — 그 주 첫 업무일 브리핑에 덧붙이는 글(`monday-briefing-extra.md` · `weekReportSince`).
   * 붙이는 날이 아니면 빈 글자.
   *
   * `{{WEEK_INPUT}}` 를 그 주 판 목록(`week-input --since <그 주 월요일 7일 전>`)으로 채운다 — 세션이 옛
   * 보고서 폴더를 훑지 않게. **못 채우면(목록을 못 읽음 · 다른 자리가 남음) 덧붙임 없이** 빈
   * 글자를 돌려주고 오류를 남긴다 — 브리핑 본문은 그대로 나가고, 빈 자리를 받은 세션이 옛
   * 폴더를 훑거나 지어내지 않게 한다(브리핑 「시스템 이슈」로 보인다).
   */
  private async mondayBriefingExtra(now: Date = new Date()): Promise<string> {
    const since = this.weekReportSince(now);
    if (!since) return '';
    const file = path.join(this.promptsDir, 'monday-briefing-extra.md');
    if (!fs.existsSync(file)) return '';
    const text = fs.readFileSync(file, 'utf-8');
    const values: Record<string, string> = {};
    if (text.includes('{{WEEK_INPUT}}')) {
      const w = await this.reportLog('report_log', ['week-input', '--since', since]);
      if (w && !w.error) values.WEEK_INPUT = renderWeekInput(w);
    }
    const filled = fillPrompt(text, values);
    if (filled.left.length > 0) {
      const why = `주간 보고를 못 채워 덧붙임 없이 보냄: ${filled.left.join(', ')}`;
      this.logger.error(why);
      errorCollector.add('AssistantScheduler', why);
      return '';
    }
    return filled.text;
  }

  /** Format HH:MM from ISO datetime string. */
  private formatTimeFromISO(iso: string): string {
    try {
      const d = new Date(iso);
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    } catch {
      return iso;
    }
  }

  // --- Calendar poller (direct HTTP, replaces MCP-based polling) ---

  private startCalendarPoller(): void {
    if (this.calendarPoller) {
      this.calendarPoller.stop();
    }

    this.calendarPoller = new CalendarPoller(
      this.sendMessage,
      this.spawnSession,
      this.promptsDir,
      () => this.config,
      (type, result) => this.recordSessionCost(type, result),
      () => this.isWorkingHours(),
    );

    this.calendarPoller.start();
  }

  // --- Error reporting ---

  /** Format collected bot errors for briefing output. */
  private formatErrorReport(): string {
    // 사다리를 거친 폴백(파이썬 배치 · 도구 없는 회차)은 llm-playbook 기록 파일에 남는다 — 지난 24시간을 싣는다.
    for (const line of ladderEventLines(24)) errorCollector.add('폴백', line);
    const errors = errorCollector.getAndClear();
    if (errors.length === 0) return '';

    // Group by source
    const grouped = new Map<string, string[]>();
    for (const err of errors) {
      const list = grouped.get(err.source) || [];
      list.push(err.message);
      grouped.set(err.source, list);
    }

    let report = '\n\n⚠️ *시스템 이슈*';
    for (const [source, messages] of grouped) {
      // Deduplicate identical messages
      const unique = [...new Set(messages)];
      report += `\n• _${source}_: ${unique.join(', ')}`;
    }
    return report;
  }

  private isWorkingHours(): boolean {
    if (!this.config) return false;
    const nonWorking = this.isNonWorkingDay();
    if (nonWorking.skip) return false;

    const now = new Date();
    const hour = now.getHours();
    const startHour = parseInt(this.config.reminders.workingHoursStart, 10);
    const endHour = parseInt(this.config.reminders.workingHoursEnd, 10);
    return hour >= startHour && hour < endHour;
  }

  // --- Analysis ---

  /** Schedule analysis runs, grouping types by their schedule. */
  private scheduleAnalysis(): void {
    if (!this.config) return;

    // Group enabled types by schedule
    const groups = this.groupTypesBySchedule();

    for (const [schedule, types] of groups) {
      this.scheduleAnalysisGroup(schedule, types);
    }
  }

  /** Schedule a single analysis group (used for initial scheduling and rescheduling). */
  private scheduleAnalysisGroup(schedule: string, types: string[]): void {
    const nextFire = this.getNextAnalysisTime(schedule);
    const msUntil = nextFire.getTime() - Date.now();

    this.logger.info('Scheduled analysis group', {
      schedule,
      types,
      nextFire: nextFire.toISOString(),
    });

    // **예정일은 예약 발화 시각의 한국 날짜다** — 실제로 돈 시각이 아니다. 자정 회차가
    // 늦게 깨거나 그룹이 자정을 넘겨도 그 회차의 날짜는 그대로다.
    const slot = kstDate(nextFire);
    const timer = setTimeout(async () => {
      try {
        await this.runAnalysisGroup(schedule, types, { slot, trigger: 'scheduled' });
      } catch (error) {
        this.logger.error('Analysis run failed', { schedule, error });
      }
      // Reschedule for next regular occurrence
      this.analysisTimers.delete(schedule);
      this.scheduleAnalysisGroup(schedule, types);
    }, msUntil);

    this.analysisTimers.set(schedule, timer);
  }

  /** Group enabled analysis types by their schedule string. */
  private groupTypesBySchedule(): Map<string, string[]> {
    if (!this.config) return new Map();
    const defaultSchedule = this.config.analysis.schedule;
    const groups = new Map<string, string[]>();

    for (const [type, cfg] of Object.entries(this.config.analysis.types)) {
      if (!cfg.enabled) continue;
      const schedule = cfg.schedule || defaultSchedule;
      const list = groups.get(schedule) || [];
      list.push(type);
      groups.set(schedule, list);
    }
    return groups;
  }

  /** Get enabled analysis types from either new (types) or legacy (enabled) config format. */
  private getEnabledAnalysisTypes(): string[] {
    if (!this.config) return [];
    return Object.entries(this.config.analysis.types)
      .filter(([, cfg]) => cfg.enabled)
      .map(([type]) => type);
  }

  /**
   * 분석 그룹의 «시도 기록» 을 파일로 남긴다 — 「오늘 나왔어야 할 목록」의 신호원.
   *
   * cadence(weekly/biweekly/monthly)를 계산하는 곳은 여기뿐이라, 이 기록이 없으면
   * 소비자는 「보고서가 안 나왔다」와 「원래 오늘 안 도는 타입이다」를 구분할 수 없다.
   * 비용 원장은 대안이 못 된다 — 폴백(codex)이 받은 회차는 Claude 세션 비용이 0이라
   * 원장에 흔적이 없다(2026-08-18 실측: 그때 agy 로 돌던 competitors 는 단 한 번도 없었다).
   * agy 위임 경로는 5단계(2026-10)에 걷었다 — agy 는 폴백으로만 쓴다.
   *
   * plan 1줄 + 타입별 outcome 1줄 append. 그룹 도중 죽어도 「계획 N vs 기록 M」으로
   * 중단이 드러난다 — rate limit이 그룹 전체를 break하는 경로가 정확히 그 모양이라,
   * 그때 뒤쪽 타입은 completed도 skipped도 아닌 무기록으로 사라진다.
   *
   * best-effort — 절대 throw하지 않는다(감시 장치가 감시 대상을 죽이면 안 된다).
   */
  private appendAnalysisJournal(schedule: string, record: Record<string, unknown>): void {
    try {
      const dir = path.join(this.workingDir, 'reports', 'pipeline-runs');
      fs.mkdirSync(dir, { recursive: true });
      const slug = schedule.replace(/[^A-Za-z0-9]+/g, '-');
      const todayKST = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
      const file = path.join(dir, `${todayKST}-analysis-${slug}.jsonl`);
      const line = JSON.stringify({ ...record, ts: new Date().toISOString() });
      fs.appendFileSync(file, line + '\n', 'utf-8');
    } catch (error) {
      this.logger.warn('analysis journal append 실패(무시)', {
        error: (error as Error).message,
      });
    }
  }

  /**
   * report-log 회차를 연다 — 「쓰는 흐름」 1번. 못 열면 `null` 이고 사유를 남긴다.
   *
   * 못 열었다고 여기서 멈추지 않는다 — 러너 종류는 데이터 작업이 보고서보다 먼저라 러너는
   * 그대로 띄우고, 세션은 프롬프트의 `{{REPORT_OUT}}` 을 못 채워 안 띄운다(남은 `{{` 거부).
   */
  private async openReportRun(type: string, slot: string, trigger: RunTrigger): Promise<ReportRun | null> {
    const r = await this.reportLog('report_log', ['open', '--type', type, '--slot', slot, '--trigger', trigger]);
    if (!r || r.error || typeof r.run_id !== 'string' || typeof r.out !== 'string') {
      const why = String(r?.error ?? '답 없음');
      this.logger.error('report-log 회차를 못 열었습니다', { type, slot, trigger, why });
      errorCollector.add('AssistantScheduler', `회차 열기 실패 (${type} ${slot}): ${why.slice(0, 200)}`);
      return null;
    }
    this.logger.info('report-log 회차 열림', { type, slot, trigger, runId: r.run_id });
    return { runId: r.run_id, out: r.out, type, slot };
  }

  /**
   * 회차가 끝난 모양대로 저장한다 — 「쓰는 흐름」 5번(`commitPlan`). 저장하지 않으면 `null`.
   * 처리한 백엔드를 `--backend` 로 남긴다(세션을 못 띄웠으면 `claude` — 열려던 백엔드).
   */
  private async finishReportRun(
    run: ReportRun | null, end: RunEnd, result: AnalysisRunResult | null,
  ): Promise<any | null> {
    if (!run) return null;
    const runner = !!AssistantScheduler.RUNNER_PRELAUNCH_BY_TYPE[run.type];
    const plan = commitPlan(end, { runner, empty: outIsEmpty(run.out), produced: result?.produced === true });
    if (!plan) {
      this.logger.info('회차를 지금 저장하지 않음 — 이어받을 예정이거나 러너가 아직 쓰는 중(정리 작업 몫)', {
        type: run.type, slot: run.slot, runId: run.runId, end,
      });
      return null;
    }
    return this.commitReportRun(run, plan.partial, result?.servedBy ?? 'claude');
  }

  /**
   * `report_log.py commit` — 쓰기 잠금에 막히면 **한 번 더**, 그래도 실패면 그대로 둔다.
   * 회차가 열린 채 남으므로 정리 작업(`sweep`)이 임시 파일을 받아 저장한다.
   */
  private async commitReportRun(run: ReportRun, partial: boolean, backend: Backend): Promise<any> {
    const args = ['commit', '--run', run.runId, '--backend', backend];
    if (partial) args.push('--partial');
    let r = await this.reportLog('report_log', args);
    if (r?.error && isLockError(r)) {
      this.logger.warn('회차 저장이 잠금에 막힘 — 한 번 더', { runId: run.runId, error: r.error });
      r = await this.reportLog('report_log', args);
    }
    if (!r || r.error) {
      const why = String(r?.error ?? '답 없음');
      this.logger.error('회차 저장 실패 — 정리 작업(sweep)이 받는다', { runId: run.runId, why });
      errorCollector.add('AssistantScheduler', `회차 저장 실패 (${run.type} ${run.slot}): ${why.slice(0, 200)}`);
      return r ?? { error: why };
    }
    this.logger.info('회차 저장', { runId: run.runId, status: r.status, partial, backend, commit: r.commit });
    return r;
  }

  /**
   * 분석 그룹 한 번. `origin` 이 예정일과 시작 방식이다 — 예약이면 그 그룹의 예약 발화
   * 시각(`nextFire`)의 한국 날짜와 `scheduled`, 수동이면 오늘과 `manual`.
   */
  private async runAnalysisGroup(
    schedule: string, types: string[], origin: { slot: string; trigger: RunTrigger },
  ): Promise<void> {
    if (!this.config) return;

    const isDaily = schedule.startsWith('daily');
    const defaults = this.config.analysis.defaults;
    const completedTypes: string[] = [];
    const skippedTypes: { type: string; reason: string }[] = [];
    const timedOutTypes: string[] = [];
    /** 세션이 두 번 다 되묻고 끝나 산출물이 없는 타입 — 종료 메시지에 그대로 적는다. */
    const noOutputTypes: string[] = [];
    /** 종류마다 처리 백엔드 · 저장 결과 — 완료 메시지에서 이름 옆에 붙인다(`saveTag`). */
    const servedOf = new Map<string, Backend | undefined>();
    const saveOf = new Map<string, string>();
    // `sessionId` 가 있으면 그 세션을 이어받고(리미트에 걸린 당사자), 없으면 새로
    // 돌린다(중단 때문에 **아예 못 돈** 뒤쪽 타입). 둘을 한 큐에 담아야 중단과
    // 재개가 대칭이 된다 — 예전에는 당사자만 큐에 들어가서, 뒤쪽 타입은 재시도
    // 대상에도 안 들고 저널에도 안 남아 그 주 산출물이 통째로 사라졌다.
    // 칸마다 회차를 들고 간다 — 재시도 · 이어받기 · 다른 날 재시도가 같은 회차를 쓴다.
    const failedRetryTypes: RetryEntry[] = [];
    /** 중단 때문에 못 돈 타입 — 종료 메시지에 그대로 적는다. */
    let deferredTypes: string[] = [];
    /** 리미트 해제 시각(epoch sec) — 있으면 재시도를 그 시각 기준으로 잡는다. */
    let limitResetsAt: number | undefined;

    // Filter by cadence (weekly / biweekly / monthly)
    const today = new Date();
    const runnableTypes = types.filter(type => {
      const decision = this.shouldRunToday(type, today);
      if (!decision.run) {
        skippedTypes.push({ type, reason: decision.reason || 'cadence' });
        this.logger.info(`Cadence skip: ${type}`, { reason: decision.reason });
        return false;
      }
      return true;
    });

    if (skippedTypes.length > 0) {
      this.logger.info(`Cadence filter: ${runnableTypes.length}/${types.length} types will run`, {
        skipped: skippedTypes.map(s => `${s.type} (${s.reason})`).join('; '),
      });
    }

    // 계획을 먼저 박는다 — 그룹 도중 죽어도 「몇 종 하려 했나」가 남아야
    // 「스케줄러가 안 돌았다」와 「돌다 끊겼다」를 구분할 수 있다.
    this.appendAnalysisJournal(schedule, {
      kind: 'plan',
      schedule,
      slot: origin.slot,
      trigger: origin.trigger,
      planned: runnableTypes,
      skipped: skippedTypes,
    });

    for (const type of runnableTypes) {
      const typeConfig = this.config.analysis.types[type];
      const maxRetries = (typeConfig?.maxRetries as number | undefined)
        ?? defaults.maxRetries ?? 2;

      // 회차는 첫 시도 전에 한 번 연다 — 같은 종류의 다음 시도(타임아웃 · 오류 재시도)는
      // 같은 회차를 다시 쓴다. 열기가 실패했으면 다음 시도에서 다시 연다.
      let run: ReportRun | null = null;
      /** 시도들이 끝난 모양과 마지막 결과 — 루프를 나온 뒤 저장을 가른다(`finishReportRun`). */
      let end: RunEnd = 'failed';
      let last: AnalysisRunResult | null = null;
      let succeeded = false;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          run = run ?? await this.openReportRun(type, origin.slot, origin.trigger);
          const result = await this.runSingleAnalysis(type, undefined, false, { slot: origin.slot, run });
          last = result;

          if (result.timedOut) {
            if (attempt < maxRetries) {
              this.logger.warn(`Analysis ${type} timed out, retry ${attempt + 1}/${maxRetries}`);
              continue; // Retry with fresh session (same WebFetch may hang again on resume)
            }
            this.logger.error(`Analysis ${type} timed out after ${attempt + 1} attempts`);
            errorCollector.add('AssistantScheduler', `분석 타임아웃 (${type}): ${maxRetries}회 재시도 후 포기`);
            timedOutTypes.push(type);
            this.appendAnalysisJournal(schedule, { kind: 'outcome', type, outcome: 'timeout', runId: run?.runId });
            break;
          }

          if (result.rateLimited) {
            this.logger.warn(`Analysis ${type} hit session limit`);
            // Daily: 기본 no retry (data-sync 등) — 단, retryOnLimit=true면 +1h 단발 예약 재시도 1회 허용
            //        (2026-06-24: API 529·타임아웃으로 데일리 통째 누락 방지. 단발 지연 재시도라 7-spawn 사고와 무관)
            // Weekly: 기본 retry (retryOnLimit=false면 차단)
            const shouldRetry = typeConfig?.retryOnLimit === true
              || (!isDaily && typeConfig?.retryOnLimit !== false);
            // 세션 id 가 없으면(init 전에 죽은 회차 — 2026-04-24 처럼 CLI 가 3초 만에
            // rc=1 로 끝나는 모양) 이어받을 것이 없으니 **새로** 돌린다. 예전에는
            // 이 경우 큐가 비어 그 타입이 조용히 빠졌다.
            if (shouldRetry) {
              failedRetryTypes.push(result.sessionId
                ? { type, sessionId: result.sessionId, run }
                : { type, run });
              end = 'resume';
            }
            // **뒤쪽 타입도 같은 큐에 넣는다.** 리미트는 그룹 전체를 끊는데
            // 재시도는 당사자만 돌리던 비대칭이 2026-08-22에 보고서 4종을
            // 통째로 날렸다(kg-regression 광역 게이트 포함). 못 돈 것은
            // 「나중에 돌 것」이지 「없던 일」이 아니다.
            // 못 돈 뒤쪽 타입의 회차도 지금 연다(예정일 · 시작 방식은 이 그룹 것) — 재시도가 그
            // 회차를 쓰고, 재시작으로 재시도 예약이 사라져도 열린 회차가 남아 정리 작업(sweep)이
            // 그 공백을 기록한다.
            if (shouldRetry) {
              deferredTypes = runnableTypes.slice(runnableTypes.indexOf(type) + 1);
              for (const rest of deferredTypes) failedRetryTypes.push({ type: rest, run: await this.openReportRun(rest, origin.slot, origin.trigger) });
            }
            if (result.resetsAt) limitResetsAt = result.resetsAt;
            this.appendAnalysisJournal(schedule, {
              kind: 'outcome', type, outcome: 'rate_limited',
              sessionId: result.sessionId, willRetry: shouldRetry,
              deferred: deferredTypes, runId: run?.runId,
            });
            break; // Stop remaining types in this group (rate limit affects all)
          }

          if (result.noOutput) {
            // 되묻고 두 번 끝난 회차 — 「완료」가 아니다. 다음 타입으로 넘어간다
            // (리미트가 아니라 그룹을 끊을 이유가 없다).
            noOutputTypes.push(type);
            end = 'no-output';
            this.appendAnalysisJournal(schedule, {
              kind: 'outcome', type, outcome: 'no-output', sessionId: result.sessionId, runId: run?.runId,
            });
            break;
          }

          succeeded = true;
          end = 'completed';
          completedTypes.push(type);
          this.appendAnalysisJournal(schedule, { kind: 'outcome', type, outcome: 'completed', runId: run?.runId });
          break;
        } catch (error) {
          const msg = (error as Error).message || '';
          if (isRateLimitText(msg)) {
            this.logger.warn(`Analysis ${type} hit rate limit, stopping group`);
            this.appendAnalysisJournal(schedule, {
              kind: 'outcome', type, outcome: 'rate_limited', viaThrow: true, runId: run?.runId,
            });
            break;
          }
          if (attempt < maxRetries) {
            this.logger.warn(`Analysis ${type} failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying`, { error: msg });
            continue;
          }
          errorCollector.add('AssistantScheduler', `분석 실행 실패 (${type}): ${msg}`);
          this.logger.error(`Analysis failed for type: ${type}`, error);
          this.appendAnalysisJournal(schedule, {
            kind: 'outcome', type, outcome: 'error', error: msg.slice(0, 300), runId: run?.runId,
          });
          break;
        }
      }

      // **결과대로 저장한다** — 완료는 그대로 · 이어받을 예정이면 안 함 · 마지막 시도까지 실패면
      // `--partial` · 되물음은 비었으면 report-log 가 `no-output` 으로 닫는다(`commitPlan`).
      const saved = await this.finishReportRun(run, end, last);
      servedOf.set(type, last?.servedBy);
      saveOf.set(type, saveTag(run, saved, end));

      // Rate limit breaks the entire group
      if (failedRetryTypes.length > 0) break;
    }

    // data-sync(daily-00:00)=야간, data-sync-noon(daily-12:00)=정오. 둘 다 startsWith('daily').
    const label = !isDaily ? '주간 분석' : (schedule === 'daily-12:00' ? '정오 동기화' : '야간 동기화');
    // 이름 옆에 Claude 가 아닌 처리 백엔드와 저장 결과 — 「돌았다」 와 「저장됐다」 를 한 줄에서 가른다.
    const tagged = (ts: string[]) => ts.map((t) => {
      const bits = [servedOf.get(t), saveOf.get(t)].filter((b) => b && b !== 'claude');
      return bits.length > 0 ? `${t}(${bits.join(' · ')})` : t;
    }).join(', ');
    const parts = [`📊 ${label} 완료: ${tagged(completedTypes) || '(없음)'}`];
    if (timedOutTypes.length > 0) {
      parts.push(`⏱️ 타임아웃: ${tagged(timedOutTypes)}`);
    }
    if (noOutputTypes.length > 0) {
      parts.push(`🫥 산출물 없음(세션이 되묻고 끝남): ${tagged(noOutputTypes)}`);
    }
    if (skippedTypes.length > 0) {
      parts.push(`⏭️ cadence 스킵: ${skippedTypes.map(s => s.type).join(', ')}`);
    }
    // **계획을 기준으로 보고한다.** 「완료 5 · 스킵 5」만 적으면 계획이 10종이었다는
    // 것을 읽는 사람이 산술해서 알아내야 한다 — 2026-08-22에 4종이 그렇게 조용히
    // 빠졌다. 못 돈 것은 못 돌았다고 적는다.
    if (deferredTypes.length > 0) {
      parts.push(`🚧 중단으로 미실행: ${deferredTypes.join(', ')}`);
    }
    await this.sendMessage(parts.join('\n')).catch(() => {});

    // Schedule retry for session-limit failures (weekly only)
    if (failedRetryTypes.length > 0) {
      // 해제 시각을 받았으면 그 시각 +5분에 잡는다. 없으면 종전대로 다음 정시+5분
      // (근거가 없는 값이라 폴백으로만 남긴다). 어느 쪽이든 최소 1분은 띄운다.
      const retryTime = limitResetsAt
        ? new Date(Math.max(Date.now() + 60_000, limitResetsAt * 1000 + 5 * 60_000))
        : this.getNextHourPlus5Min();
      const retryTypes = failedRetryTypes.map(f => f.type);

      this.logger.info('Scheduling retry for session-limited types', {
        types: retryTypes,
        retryTime: retryTime.toISOString(),
        via: limitResetsAt ? 'resetsAt' : 'next-hour',
      });
      const deferredNote = deferredTypes.length > 0
        ? ` (중단으로 미실행 ${deferredTypes.length}종 포함)` : '';
      await this.sendMessage(
        `⏳ 세션 리미트 초과: ${retryTypes.join(', ')}${deferredNote}`
        + ` → ${retryTime.toLocaleTimeString('ko-KR')} 재시도 예정`,
      ).catch(() => {});

      this.scheduleAnalysisRetry(schedule, origin, failedRetryTypes, retryTime);
    }
  }

  /** 한도로 멈춘 그룹의 재시도를 예약한다 — 큐의 칸마다 회차를 같이 들고 간다. */
  private scheduleAnalysisRetry(
    schedule: string, origin: { slot: string; trigger: RunTrigger }, queue: RetryEntry[], retryTime: Date,
  ): void {
    const retryTimerKey = `retry-${schedule}`;
    const retryTimer = setTimeout(() => {
      this.analysisTimers.delete(retryTimerKey);
      this.runAnalysisRetry(schedule, origin, queue).catch((error) =>
        this.logger.error('Analysis retry failed', { schedule, error }));
    }, Math.max(0, retryTime.getTime() - Date.now()));
    this.analysisTimers.set(retryTimerKey, retryTimer);
  }

  /**
   * 재시도 큐를 돈다. **원래 회차 · 원래 예정일을 그대로 쓴다** — 재시도가 다른 날 돌아도
   * 그 보고서는 원래 예정일의 판이다.
   */
  private async runAnalysisRetry(
    schedule: string, origin: { slot: string; trigger: RunTrigger }, queue: RetryEntry[],
  ): Promise<void> {
    // **재시도 결과도 저널에 남긴다.** 예전에는 재시도가 저널에 아무것도 안
    // 적어서, 감시 검사(M12)가 재시도로 살아난 타입까지 「무기록」으로 셌다.
    const done: string[] = [];
    const failed: string[] = [];
    /** 종류마다 저장 결과 — 재시도 완료 메시지에서 이름 옆에 붙인다. */
    const saveOf = new Map<string, string>();
    let stoppedAt = -1;
    for (let i = 0; i < queue.length; i++) {
      const { type, sessionId } = queue[i];
      // 원래 회차를 못 열었던 칸만 여기서 연다 — 그때만 시작 방식이 `retry` 다.
      let run = queue[i].run ?? null;
      try {
        this.logger.info(`Retrying analysis: ${type}`, { sessionId, runId: run?.runId });
        run = run ?? await this.openReportRun(type, origin.slot, 'retry');
        const r = await this.runSingleAnalysis(type, sessionId, false, { slot: origin.slot, run });
        const outcome = r.rateLimited ? 'rate_limited'
          : r.timedOut ? 'timeout'
          : r.noOutput ? 'no-output'
          : 'completed';
        (outcome === 'completed' ? done : failed).push(type);
        this.appendAnalysisJournal(schedule, {
          kind: 'outcome', type, outcome, viaRetry: true, sessionId: r.sessionId, runId: run?.runId,
        });
        // 재시도 뒤에는 더 이어받지 않는다 — 또 막혀도 마지막 시도로 보고 `--partial` 로 저장한다.
        const end: RunEnd = outcome === 'completed' ? 'completed' : outcome === 'no-output' ? 'no-output' : 'failed';
        const saved = await this.finishReportRun(run, end, r);
        saveOf.set(type, [r.servedBy && r.servedBy !== 'claude' ? r.servedBy : '', saveTag(run, saved, end)]
          .filter(Boolean).join(' · '));
        // **또 막히면 거기서 멈춘다.** 큐에 잔여 타입까지 담게 되면서 큐 길이가
        // 1 에서 최대 그룹 크기로 늘었는데, 한도가 아직 안 풀린 상태로 전부
        // 돌리면 그만큼을 그대로 낭비한다. 한 번 막히면 그 시점의 한도는
        // 나머지에도 똑같이 걸린다.
        if (r.rateLimited) { stoppedAt = i; break; }
      } catch (error) {
        failed.push(type);
        this.logger.error(`Retry failed for: ${type}`, error);
        this.appendAnalysisJournal(schedule, {
          kind: 'outcome', type, outcome: 'error', viaRetry: true,
          error: ((error as Error).message || '').slice(0, 300), runId: run?.runId,
        });
        saveOf.set(type, saveTag(run, await this.finishReportRun(run, 'failed', null), 'failed'));
      }
    }
    // 한도로 멈춘 뒤 손도 안 댄 칸의 회차는 저장하지 않는다(열린 채 → 정리 작업이 `abandoned` 로).
    // 멈춘 뒤로 아예 손도 안 댄 것 — 저널에 남기지 않는다(무기록이 곧
    // M12 의 「그룹 중단」 신호다). 다만 사람에게는 적는다.
    const notTried = stoppedAt >= 0
      ? queue.slice(stoppedAt + 1).map(f => f.type) : [];
    // **성공한 것만 완료라고 적는다.** 예전에는 무엇이 어찌 됐든 「재시도 완료」
    // 한 줄이라, 아무 일도 안 한 회차가 성공으로 읽혔다(2026-08-22).
    const tagged = (ts: string[]) => ts.map((t) => (saveOf.get(t) ? `${t}(${saveOf.get(t)})` : t)).join(', ');
    const lines = [`📊 재시도 완료: ${tagged(done) || '(없음)'}`];
    if (failed.length > 0) lines.push(`⚠️ 재시도 실패: ${tagged(failed)}`);
    if (notTried.length > 0) {
      lines.push(`🚧 한도가 안 풀려 미시도: ${notTried.join(', ')}`);
    }
    await this.sendMessage(lines.join('\n')).catch(() => {});
  }

  /** Calculate next hour + 5 minutes (retry buffer). */
  private getNextHourPlus5Min(): Date {
    const next = new Date();
    next.setHours(next.getHours() + 1, 5, 0, 0);
    return next;
  }

  /**
   * 예약 세션에 붙는 시스템 프롬프트 한 줄 — **사람이 없다는 것을 모델에게 말한다.**
   *
   * 2026-09-08 분석 모델이 Sonnet 4.6 → Sonnet 5 로 바뀐 뒤 첫 토요일(09-12)에 13종 중
   * 5종이 일을 못 마쳤다. 둘은 프롬프트를 설명문으로 읽고 「what would you like me to
   * do?」로 되물으며 7초 만에 끝났고(도구 0회), 하나는 Edit 가 거부되자 Write 로 안
   * 넘어가고 사용자에게 물었고, 하나는 외부 요인(다우 세션 만료)에 막히자 보고서 없이
   * 끝났다. **전부 `subtype: success`.** 09-09 자정(#35)과 같은 유형이다.
   *
   * 제목+설명문으로 시작하는 프롬프트에서만 났고 명령문으로 시작하는 프롬프트는 전부
   * 정상이었다 — 그러나 같은 모양이라도 통과한 것이 있어 확률적이다. 프롬프트마다
   * 첫 줄을 고치는 대신 여기서 한 번에 말한다. 되묻는 것 자체를 막는 층이고, 그래도
   * 되물으면 `runSingleAnalysis` 의 도구 0회 재시도가 받는다.
   */
  private static readonly SCHEDULED_SESSION_DIRECTIVE = [
    '이 세션은 사람이 없는 예약 실행이다. 프롬프트는 설명이 아니라 지금 수행할 절차다.',
    '되묻지 않는다 — 질문으로 끝내면 이 회차는 산출물 없이 사라진다.',
    '도구 호출이 거부되면 허용된 다른 도구(Write·Bash)로 같은 결과를 낸다.',
    '외부 요인(세션 만료·자격증명 등)으로 막히면 막힌 단계와 사유를 보고서에 적고 끝낸다 — 보고서 없이 끝내지 않는다.',
  ].join(' ');

  /**
   * 도구 0회로 끝난 회차에 다시 주는 머리말. 본문은 같은 프롬프트다.
   */
  private static readonly NUDGE_PREAMBLE =
    '[지시] 아래는 지금 실행할 절차다. 되묻지 말고 첫 단계부터 수행한다.\n\n';

  /**
   * 프롬프트 자리의 값. **틀에 있는 자리만** report-log 에 묻는다 — 안 쓰는 종류가 명령을
   * 부르지 않게. 명령이 실패하면 그 자리는 값이 없다(→ 남은 `{{` 로 세션을 안 띄움).
   */
  private async promptValues(type: string, template: string, ctx: AnalysisCtx): Promise<Record<string, string>> {
    const values: Record<string, string> = { SLOT: ctx.slot };
    if (ctx.run) values.REPORT_OUT = slashPath(ctx.run.out);
    // 종류마다 한 번만 묻는다 — `{{PREV_REPORT}}` 와 `{{PREV_REPORT:<같은 종류>}}` 가 함께 있어도.
    const contexts = new Map<string, any | null>();
    const contextOf = async (t: string): Promise<any | null> => {
      if (!contexts.has(t)) {
        // 직전 보고서 = 이 예정일 **앞** 판 — 같은 예정일을 다시 쓰는 재시도 · 수동 재실행이 제 판을
        // 직전으로 읽지 않게. 다른 종류는 같은 예정일 것까지 본다(같은 그룹에서 먼저 돈 판이 가장 새 재료).
        const before = t === type ? ctx.slot : shiftDate(ctx.slot, 1);
        const c = await this.reportLog('report_log', ['prompt-context', '--type', t, '--before', before]);
        if (!c || c.error) {
          this.logger.warn('prompt-context 실패 — 직전 보고서 · 피할 권고 자리를 못 채움', { type: t, error: c?.error });
        }
        contexts.set(t, c && !c.error ? c : null);
      }
      return contexts.get(t);
    };
    if (template.includes('{{PREV_REPORT}}') || template.includes('{{AVOID_LIST}}')) {
      const c = await contextOf(type);
      if (c) {
        values.PREV_REPORT = renderPrevReport(c.prev);
        values.AVOID_LIST = renderAvoidList(c.avoid);
      }
    }
    for (const named of new Set([...template.matchAll(NAMED_PREV_RE)].map((m) => m[1]))) {
      const c = await contextOf(named);
      if (c) values[`PREV_REPORT:${named}`] = renderPrevReport(c.prev);
    }
    if (template.includes('{{WEEK_INPUT}}')) {
      const w = await this.reportLog('report_log', ['week-input', '--since', shiftDate(ctx.slot, -7)]);
      if (w && !w.error) values.WEEK_INPUT = renderWeekInput(w);
      else this.logger.warn('week-input 실패 — 그 주 판 목록 자리를 못 채움', { type, error: w?.error });
    }
    return values;
  }

  /**
   * 분석 한 종 한 번. `ctx` 는 회차 문맥이다 — 예정일과 열린 회차(못 열었으면 `null`).
   * 없으면 오늘 날짜 · 회차 없음으로 돈다(시험 · 옛 호출).
   */
  private async runSingleAnalysis(
    type: string,
    resumeSessionId?: string,
    nudged = false,
    ctx: AnalysisCtx = { slot: kstDate(new Date()), run: null },
  ): Promise<AnalysisRunResult> {
    const promptPath = path.join(this.promptsDir, `analysis-${type}.md`);
    if (!fs.existsSync(promptPath)) {
      this.logger.warn(`Analysis prompt not found: ${promptPath}`);
      return { rateLimited: false, timedOut: false, costUsd: 0 };
    }

    const template = fs.readFileSync(promptPath, 'utf-8');
    const defaults = this.config!.analysis.defaults;
    const typeConfig = this.config!.analysis.types[type];
    const allowedTools = typeConfig?.allowedTools ?? defaults.allowedTools;
    const writablePaths = typeConfig?.writablePaths ?? defaults.writablePaths;
    const maxDurationMinutes = (typeConfig?.maxDurationMinutes as number | undefined)
      ?? defaults.maxDurationMinutes ?? 60;

    const useSdk = shouldUseSdk(`analysis:${type}`);
    // **별칭으로 박는다** — `sonnet`·`opus` 는 세대가 바뀌어도 그 등급에 머문다.
    // 원래 취지(SDK 기본값이 조용히 Opus 로 올라가는 것 차단)는 그대로 지키면서
    // 세대만 따라간다. 앞서 박혀 있던 `claude-sonnet-4-6` 은 Sonnet 5 보다 낡은
    // 데다 $3/$15 로 **50% 더 비쌌다**(Sonnet 5 는 $2/$10 · 2026-09-08).
    //
    // 등급은 `config.analysis.types[type].model`·`.effort` 로 종마다 정한다.
    // 폭은 sonnet+low ~ opus+xhigh 이고 haiku 는 쓰지 않는다(2026-09-08 사용자).
    const analysisModel = (typeConfig as any)?.model
      ?? process.env.ANALYSIS_MODEL
      ?? 'sonnet';
    const analysisEffort = ((typeConfig as any)?.effort
      ?? process.env.ANALYSIS_EFFORT
      ?? 'low') as 'low' | 'medium' | 'high' | 'xhigh' | 'max';

    // **러너 기동을 세션에 맡기지 않는다.** 세션이 뜨기 전에 여기서 띄운다 —
    // 근거와 경위는 `launchPipelineRunner` 주석. 재시도 회차에서도 그대로 부른다
    // (러너 가드가 「이미 진행 중」이면 안 띄우므로, 첫 회차가 못 띄웠을 때만 뜬다).
    const prelaunch = AssistantScheduler.RUNNER_PRELAUNCH_BY_TYPE[type];
    if (prelaunch) {
      await this.launchPipelineRunner(type, prelaunch, ctx);
    }

    // **프롬프트 자리를 채운다** — 이어받는 회차는 `'continue'` 한 낱말이라 채울 것이 없다.
    // 못 채운 자리(`{{`)가 남으면 **세션을 안 띄운다.** 모르는 경로 · 빈 날짜로 돈 세션은
    // 보고서를 엉뚱한 곳에 쓰거나 날짜를 지어낸다 — 그것이 옛 흐름의 실패 모양이다.
    // 러너는 위에서 이미 띄웠다(데이터 작업은 보고서와 무관하게 돌아야 한다).
    let prompt = 'continue';
    if (!resumeSessionId) {
      const filled = fillPrompt(template, await this.promptValues(type, template, ctx));
      if (filled.left.length > 0) {
        const why = `프롬프트 자리를 못 채워 세션을 안 띄움 (${type}): ${filled.left.join(', ')}`;
        this.logger.error(why, { slot: ctx.slot, runId: ctx.run?.runId ?? null });
        errorCollector.add('AssistantScheduler', why);
        throw new Error(why);
      }
      prompt = (nudged ? AssistantScheduler.NUDGE_PREAMBLE : '') + filled.text;
    }

    // **쓰기 범위** — 보고서는 회차 임시 파일 폴더에만 쓴다. Claude 는 작업 폴더 밖을 허용
    // 없이 못 고치므로 추가 폴더로, Codex 폴백은 쓰기 허용 폴더로 연다(기존 폴더 목록에 더함).
    // 폴더가 아직 없으면(회차를 한 번도 못 엶) 열지 않는다 — 없는 폴더를 넘기면 실행체가 넘어진다.
    const tmpDir = path.join(reportLogState(), 'tmp');
    const tmpOpen = fs.existsSync(tmpDir) ? [tmpDir] : [];
    const writable = analysisWritable(writablePaths, tmpDir);

    // 산출물 백스톱의 기준선 — **이 시각 이후에 쓰인 파일만** 이 세션의 성과다.
    const startedAtMs = Date.now();

    const result = await this.spawnOrFallback('분석',
      prompt,
      {
        workingDirectory: this.workingDir,
        model: analysisModel,
        permissionMode: 'default',
        allowedTools,
        appendSystemPrompt: `CRITICAL: ${writable.join(', ')} 디렉토리에만 새 파일 생성/수정. 그 외 파일 수정/삭제 금지.\n`
          + AssistantScheduler.SCHEDULED_SESSION_DIRECTIVE,
        additionalDirectories: tmpOpen,
        fallbackScope: { cwd: this.workingDir, writable: [...codexWritableDirs(), ...tmpOpen] },
        // 회차를 세션에도 알린다(audit.py 처럼 세션이 부르는 스크립트가 `REPORT_OUT` 을 읽는다).
        // Codex 폴백은 환경 변수를 못 받으므로 프롬프트 본문의 `{{REPORT_OUT}}` 이 정본이다.
        env: { ASSISTANT_MODE: 'analysis', CLAUDE_SCHEDULED: '1', ...(ctx.run ? reportRunEnv(ctx.run) : {}) },
        resumeSessionId,
        skipMcp: true,
        maxDurationMs: maxDurationMinutes * 60_000,
        useSdk,
        // **종마다 다르게 준다** — 예전에는 안 넘겨 전부 기본값 'high' 로 돌았다.
        // 기계 산출물에 판단만 얹는 종은 그게 과하고, 웹을 훑어 판단까지 내는
        // 종은 모자랐다. 앞서 여기 걸려 있던 `thinkingBudgetTokens: 5000` 은
        // 적응형 사고를 끄는 구형 경로였다 — 깊게 하려던 설정이 오히려 얕게
        // 묶고 있었다(2026-08-06).
        effort: analysisEffort,
      },
    );

    this.recordSessionCost(`analysis-${type}`, result);
    // 「썼나」 — 회차 임시 파일이 이 세션 시작 뒤에 판정까지 된 본문으로 쓰였나(`reportProduced`).
    // 회차가 없으면(못 엶) 낸 것이 없다.
    const produced = ctx.run ? reportProduced(ctx.run.out, startedAtMs) : false;
    /** 돌려줄 때마다 붙는 것 — 세션 번호 · 비용 · 처리한 백엔드 · 냈나. */
    const base = { sessionId: result.sessionId, costUsd: result.costUsd, servedBy: result.servedBy, produced };

    this.logger.info('Analysis session completed', {
      type,
      slot: ctx.slot,
      runId: ctx.run?.runId,
      servedBy: result.servedBy,
      subtype: result.subtype,
      costUsd: result.costUsd.toFixed(4),
      via: useSdk ? 'sdk' : 'cli',
      cacheRead: result.usage?.cacheReadTokens,
      textPreview: result.text?.substring(0, 600),
    });

    // Timeout detection
    if (result.subtype === 'error_timeout') {
      return { rateLimited: false, timedOut: true, ...base };
    }

    // **되묻고 끝난 회차 — 도구 0회 + 보고서 없음.** 2026-09-12 archive-sync·product-docs
    // 가 7초 만에 「what would you like me to do?」로 끝났고 `completed` 로 기록됐다.
    // 도구를 하나도 안 돌렸으니 부작용이 없다 — 머리말을 붙여 **새 세션으로 한 번** 다시
    // 돌린다. `toolCalls` 를 못 읽는 회차(`undefined`)는 0 으로 읽지 않는다(모르는 것을
    // 0 으로 읽으면 두 번 돈다 — `spawnOrFallback` 과 같은 규칙). 보고서 검사는 codex
    // 폴백(`toolCalls: 0` 으로 돌아온다)이 이미 보고서를 남긴 경우를 거른다.
    // 이어받는 회차는 안 한다 — 그 프롬프트는 `'continue'` 한 낱말이다.
    // 산출물 없음이 정상인 종류(`noOutputOkType`)는 폴백(codex · 도구 횟수를 0 으로 돌려준다)이
    // 빈손으로 끝내도 되물음으로 치지 않는다 — 정말 바뀐 것이 없었을 수 있고, Claude 로 다시
    // 돌리면 1차가 막혀 폴백했던 그 회차를 또 부른다. 저장은 `no-output` 이다.
    const quietOk = noOutputOkType(typeConfig) && result.servedBy !== undefined
      && result.servedBy !== 'claude';
    if (!resumeSessionId && result.toolCalls === 0 && !result.isError && !produced && !quietOk) {
      if (!nudged) {
        this.logger.warn('분석 세션이 도구 0회로 끝났다(되물음) — 머리말 붙여 1회 재시도', {
          type, subtype: result.subtype, textPreview: result.text?.substring(0, 200),
        });
        recordEvent('analysis-askback', { type, retried: true });
        return this.runSingleAnalysis(type, undefined, true, ctx);
      }
      // 두 번째도 빈손 — 성공으로 적지 않는다. 저널의 `no-output` 이 M12 보다 하루 먼저
      // 「이 회차는 아무것도 안 했다」를 말해 준다.
      this.logger.error('분석 세션이 재시도에서도 도구 0회로 끝났다 — no-output', { type });
      recordEvent('analysis-askback', { type, retried: false });
      errorCollector.add('AssistantScheduler', `분석 산출물 없음 (${type}): 세션이 두 번 다 되묻고 끝남`);
      return { rateLimited: false, timedOut: false, noOutput: true, ...base };
    }

    // Rate limit / session limit detection
    //
    // **정상 완료한 세션의 본문은 보지 않는다.** 예전에는 `result.text` 를 그대로
    // 정규식에 넣었는데, 이 분석들이 다루는 주제가 「사용량·한도·실패」라 보고서가
    // 잘 나올수록 `429`·`usage limit` 이 요약문에 들어간다. 그래서 2026-05-22 부터
    // 08-22 까지 13번을 오탐했고, 그때마다 그룹 뒤쪽 타입이 통째로 날아갔다.
    // 사용자 세션 경로는 이미 같은 결론에 도달해 `is_error` 뒤로 텍스트 검사를
    // 가둬 뒀다(slack-handler.ts 의 NOTE) — 여기도 같은 형태로 맞춘다.
    // 자기 예산 상한은 여기서만 더한다 — 분석은 그때 재시도가 맞고,
    // 브리핑은 있는 만큼이라도 전달하는 것이 맞아서 대응이 갈린다.
    const flaggedLimit = isSessionRateLimited(result)
      || result.subtype === 'error_max_budget_usd';

    // **산출물 백스톱** — 판정이 무엇을 잘못 보든, 이번 세션이 보고서를 남겼으면
    // 그 세션은 일을 마친 것이다. 「성공으로 기록됨 ≠ 일을 마쳤음」의 반대 방향.
    // 시작 시각 이후에 쓰인 파일만 인정한다 — 그냥 존재만 보면 사람이 같은 창에
    // 수동으로 돌려 둔 것을 이 세션의 성과로 착각한다. 러너 종류는 대기 표식이 남아 있으면
    // (기계본만 있고 판정 전) 낸 것이 아니다 — 그대로 한도로 두어 이어받게 한다.
    if (flaggedLimit) {
      if (produced) {
        this.logger.warn('리미트로 찍혔지만 이번 세션이 보고서를 남겼다 — 완료로 처리', {
          type, out: ctx.run?.out, subtype: result.subtype, rateLimitEvent: result.rateLimited === true,
        });
        return { rateLimited: false, timedOut: false, ...base };
      }
      return { rateLimited: true, timedOut: false, ...base, resetsAt: result.rateLimitResetsAt };
    }

    return { rateLimited: false, timedOut: false, ...base };
  }

  // --- Date/time utilities ---

  /**
   * Check if a type should run today based on cadence config.
   * - weekly (default): always true
   * - biweekly: every 14 days from cadenceFrom
   * - monthly + monthlyWeek='first': only first Saturday of the month
   * - monthly + monthlyWeek='last': only last Saturday of the month
   */
  private shouldRunToday(type: string, today: Date = new Date()): { run: boolean; reason?: string } {
    const cfg = this.config?.analysis.types[type];
    if (!cfg) return { run: true };
    const cadence = cfg.cadence ?? 'weekly';

    if (cadence === 'weekly') return { run: true };

    if (cadence === 'biweekly') {
      if (!cfg.cadenceFrom) return { run: true, reason: 'biweekly without cadenceFrom, treating as weekly' };
      const from = new Date(cfg.cadenceFrom + 'T00:00:00');
      const todayMidnight = new Date(today.getFullYear(), today.getMonth(), today.getDate());
      const diffDays = Math.floor((todayMidnight.getTime() - from.getTime()) / 86_400_000);
      if (diffDays < 0) return { run: false, reason: `biweekly not started (from=${cfg.cadenceFrom})` };
      if (diffDays % 14 === 0) return { run: true };
      return { run: false, reason: `biweekly off-cycle (day ${diffDays} from ${cfg.cadenceFrom})` };
    }

    if (cadence === 'monthly') {
      const day = today.getDay();       // 6 = Saturday
      const date = today.getDate();
      if (day !== 6) return { run: false, reason: 'monthly: not Saturday' };

      if (cfg.monthlyWeek === 'first') {
        if (date <= 7) return { run: true };
        return { run: false, reason: 'monthly-first: not first Saturday' };
      }
      if (cfg.monthlyWeek === 'last') {
        const nextWeek = new Date(today);
        nextWeek.setDate(date + 7);
        if (nextWeek.getMonth() !== today.getMonth()) return { run: true };
        return { run: false, reason: 'monthly-last: not last Saturday' };
      }
      // monthly without monthlyWeek → treat as first
      return date <= 7 ? { run: true } : { run: false, reason: 'monthly: not first Saturday (default)' };
    }

    return { run: true };
  }

  /**
   * 오늘이 내가 일하지 않는 날인가 (schedule-manager.ts:231-241 pattern).
   *
   * 달력 **둘을 합친다.** `date-holidays` 는 해마다 바뀌는 한국 공휴일을 알고,
   * `config.json` 의 `holidays` 는 **개인 휴가·건강검진**을 안다 — 후자는 파이썬
   * 쪽 마감 역산이 이미 보던 목록인데 **봇만 안 보고 있었다**(2026-08-21 발견).
   */
  private isNonWorkingDay(date: Date = new Date()): { skip: boolean; reason?: string } {
    const day = date.getDay();
    if (day === 0) return { skip: true, reason: 'Sunday' };
    if (day === 6) return { skip: true, reason: 'Saturday' };
    if (offDays().has(ymd(date))) return { skip: true, reason: '휴가·휴일 (config.json)' };
    const result = this.holidays.isHoliday(date);
    if (Array.isArray(result)) {
      const publicHoliday = result.find(h => h.type === 'public');
      if (publicHoliday) return { skip: true, reason: publicHoliday.name };
    }
    return { skip: false };
  }

  /** Get next occurrence of HH:MM on a working day (schedule-manager.ts:243-252 pattern). */
  private getNextWorkingDay(time: string): Date {
    const [h, m] = time.split(':').map(Number);
    const now = new Date();
    const next = new Date(now);
    next.setHours(h, m, 0, 0);

    // If time already passed today, start from tomorrow
    if (next <= now) {
      next.setDate(next.getDate() + 1);
    }

    // Skip non-working days
    while (this.isNonWorkingDay(next).skip) {
      next.setDate(next.getDate() + 1);
    }

    return next;
  }

  /** Get next analysis time based on schedule like "saturday-03:00" or "daily-02:00". */
  private getNextAnalysisTime(schedule: string): Date {
    // Split on first '-' only: "daily-02:00" → ["daily", "02:00"], "wednesday-20:00" → ["wednesday", "20:00"]
    const dashIdx = schedule.indexOf('-');
    const dayStr = schedule.substring(0, dashIdx);
    const timeStr = schedule.substring(dashIdx + 1);
    const [h, m] = timeStr.split(':').map(Number);

    const now = new Date();
    const next = new Date(now);
    next.setHours(h, m, 0, 0);

    if (dayStr.toLowerCase() === 'daily') {
      // Daily: next working day at the specified time
      if (next <= now) {
        next.setDate(next.getDate() + 1);
      }
      while (this.isNonWorkingDay(next).skip) {
        next.setDate(next.getDate() + 1);
      }
    } else {
      // Weekly: next occurrence of target day
      const targetDay = this.dayNameToNumber(dayStr);
      const currentDay = now.getDay();
      let daysUntil = targetDay - currentDay;
      if (daysUntil < 0 || (daysUntil === 0 && next <= now)) {
        daysUntil += 7;
      }
      next.setDate(next.getDate() + daysUntil);
    }

    return next;
  }

  private dayNameToNumber(day: string): number {
    const days: Record<string, number> = {
      sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
      thursday: 4, friday: 5, saturday: 6,
    };
    return days[day.toLowerCase()] ?? 6; // Default to Saturday
  }

  /** Schedule midnight cleanup (reserved for future per-day state resets). */
  private scheduleMidnightCleanup(): void {
    const now = new Date();
    const midnight = new Date(now);
    midnight.setHours(24, 0, 0, 0);
    const msUntil = midnight.getTime() - now.getTime();

    this.midnightTimer = setTimeout(() => {
      this.logger.debug('Midnight cleanup');
      this.scheduleMidnightCleanup();
    }, msUntil);
  }
}
