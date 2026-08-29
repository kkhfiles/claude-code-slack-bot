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
import { runAgy } from './agy-handler';
import { listNasQueue, buildNasQueueBlocks } from './nas-confirm';
import { isWorkAssistantEnabled, briefShort, briefNudge, checkinNudge, quickUpdate,
  noteUpdate, summaryCandidates, summaryApply,
  refreshBoardIfChanged, isQuietPeriod, sessionFocusWithin, currentStore,
  offsitePush, commitHarvest, remindDue, remindDone,
  workAssistantRoot, mailCandidates, mailMark, boardOutputToTell,
  offDays, ymd } from './work-assistant';
import { boardLabel, boardQueueEnabled, drain } from './board-queue';

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
 */
const BOARD_QUEUE_POLL_MS = 2_000;
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
/**
 * 시각 알림을 보는 간격. **이 값이 곧 늦게 울릴 수 있는 최대 시간이다** —
 * 「11시에」 부탁한 것이 11:02 에 오는 것은 괜찮지만 11:10 은 늦다.
 *
 * 다음 울릴 시각을 계산해 한 번만 예약하는 편이 싸 보이지만, 그러면 **그 사이에
 * 새로 걸린 알림을 못 본다** — 예약을 다시 잡을 자리가 어디에도 없다(판에서도
 * 세션에서도 걸 수 있다). 2분마다 보는 값이 그 구멍보다 싸다.
 */
const REMIND_POLL_MS = 120_000;
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
      tools?: string[];            // type-specific data (e.g. competitors.tools)
      allowedTools?: string[];
      writablePaths?: string[];
      sessionBudgetUsd?: number;
      maxDurationMinutes?: number;
      maxRetries?: number;
      /** 이 타입의 보고서가 떨어지는 디렉터리 이름. 생략하면 타입 이름과 같다.
       *  둘이 갈리는 타입이 있어서 둔다(`product-docs-sync` → `product-docs`).
       *  같은 값을 파이썬 쪽 감시 검사도 읽는다 — 규칙을 두 곳에서 추측하면
       *  한쪽이 조용히 틀린다(M12가 그렇게 3종을 상시 오탐했다). */
      reportDir?: string;
      [key: string]: unknown;
    }>;
  };
}

/** 분석 한 종을 돌린 결과. `resetsAt` 은 리미트가 풀리는 시각(epoch sec)으로,
 *  있으면 재시도를 그 시각 기준으로 잡는다(없으면 종전대로 다음 정시+5분). */
export interface AnalysisRunResult {
  rateLimited: boolean;
  timedOut: boolean;
  sessionId?: string;
  costUsd: number;
  resetsAt?: number;
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
  /** 사고 깊이 — 유일한 사고 손잡이. 생략하면 SDK 기본값 `'high'`(sdk-handler 주석). */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
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
}

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
  via?: 'cli' | 'sdk';
  /** **폭주는 값이 아니라 횟수로 보인다.** 회당 $45 회차가 같은 명령을 900번
   *  되불러서였는데, 원장에 값만 있어 그것을 세는 길이 금지된 자료뿐이었다. */
  turns?: number;
  toolCalls?: number;
}

const COST_FILE = path.join(__dirname, '..', '.assistant-costs.json');
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
  private boardQueueTimer: ReturnType<typeof setInterval> | null = null;
  private mailPollTimer: ReturnType<typeof setInterval> | null = null;
  private mailPollBusy = false;
  private remindTimer: ReturnType<typeof setInterval> | null = null;
  private remindBusy = false;
  /** 이 프로세스에서 이미 보낸 알림. **자국을 못 찍었을 때의 퓨즈다** — 파일
   *  자국이 정본이고 이것은 그 자국이 실패했을 때 2분마다 같은 DM 이 무한히
   *  나가는 것을 막는다(하루 08~20시면 360통). 재시작하면 비므로 한 번은 다시
   *  울릴 수 있는데, 그것이 「영영 안 울림」보다 싸다. */
  private remindSent = new Set<string>();
  /** 한 판이 끝나기 전에 다음 판이 겹치지 않게. 노션 왕복이 폴링 간격보다 길 수 있다. */
  private boardQueueBusy = false;
  private boardQueueFailures = 0;

  // File watcher debounce (account-manager.ts:59-62 pattern)
  private watchDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  // Calendar poller (replaces MCP-based reminder polling)
  private calendarPoller: CalendarPoller | null = null;

  // Cost tracking
  private costEntries: CostEntry[] = [];

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
  ) {
    this.configPath = path.join(configDir, 'config.json');
    this.promptsDir = path.join(configDir, 'prompts');
    this.workingDir = path.resolve(configDir, '..');
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
  async runBriefing(): Promise<{ text: string; hasReports: boolean }> {
    if (!this.config?.briefing.enabled) {
      return { text: 'Briefing is disabled in config.', hasReports: false };
    }
    // 업무 조회를 브리핑 세션과 **동시에** 시작한다 (workBriefBlock 주석 참조).
    const work = this.workBriefBlock();
    const result = await this.executeBriefing();
    this.recordSessionCost('briefing', result);
    return {
      text: result.text + await work +
        this.formatErrorReport() + this.formatCostLine(),
      hasReports: this.hasUnreadReports(),
    };
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
      try {
        const result = await this.runSingleAnalysis(type);
        if (result.timedOut) return `⏱️ 분석 타임아웃: ${type}`;
        if (result.rateLimited) return `⚠️ 세션 리미트 초과: ${type}`;
        return `✅ 분석 완료: ${type} ($${result.costUsd.toFixed(4)})`;
      } catch (error) {
        return `❌ 분석 실패 (${type}): ${(error as Error).message}`;
      }
    }

    // All types — run the default schedule group
    const defaultSchedule = this.config.analysis.schedule;
    const groups = this.groupTypesBySchedule();
    const defaultTypes = groups.get(defaultSchedule) || [];
    if (defaultTypes.length === 0) return '⚠️ No types in default schedule.';

    await this.runAnalysisGroup(defaultSchedule, defaultTypes);
    return '✅ 분석 실행 완료 — 결과는 위 메시지 참고';
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
    } catch (error) {
      errorCollector.add('AssistantScheduler', `비용 데이터 로드 실패: ${(error as Error).message}`);
      this.logger.error('Failed to load cost data', error);
    }
  }

  private saveCosts(): void {
    try {
      fs.writeFileSync(COST_FILE, JSON.stringify({ entries: this.costEntries }, null, 2), 'utf-8');
    } catch (error) {
      errorCollector.add('AssistantScheduler', `비용 데이터 저장 실패: ${(error as Error).message}`);
      this.logger.error('Failed to save cost data', error);
    }
  }

  private recordSessionCost(type: string, result: SessionResult): void {
    this.recordCost(type, result.costUsd, result.sessionId, {
      usage: result.usage,
      via: result.usage ? 'sdk' : 'cli',
      turns: result.turns,
      toolCalls: result.toolCalls,
    });
  }

  private recordCost(
    type: string,
    costUsd: number,
    sessionId: string,
    extras?: { usage?: SessionUsage; via?: 'cli' | 'sdk'; turns?: number; toolCalls?: number },
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
    });
  }

  private formatCostLine(): string {
    const stats = this.getCostStats();
    let line = `\n\n💰 *비용* — 오늘: $${stats.daily.toFixed(2)} | 이번 주: $${stats.weekly.toFixed(2)} | 이번 달: $${stats.monthly.toFixed(2)}`;
    if (stats.analysisMonthly > 0) {
      line += `\n📊 *분석* — 이번 주: $${stats.analysisWeekly.toFixed(2)} | 이번 달: $${stats.analysisMonthly.toFixed(2)}`;
    }
    return line;
  }

  /**
   * Check if there are unread regular reports.
   * Scans only reports/scheduled-reports/<type>/ — the same scope the briefing
   * prompt uses (CLAUDE.md §9). Ad-hoc work reports under reports/<other>/ are
   * intentionally excluded so they never leak into the briefing surface.
   */
  private hasUnreadReports(): boolean {
    const reportsDir = path.join(this.workingDir, 'reports', 'scheduled-reports');
    if (!fs.existsSync(reportsDir)) return false;
    for (const dir of fs.readdirSync(reportsDir)) {
      if (dir === 'archived') continue;
      const subdir = path.join(reportsDir, dir);
      if (!fs.statSync(subdir).isDirectory()) continue;
      for (const fname of fs.readdirSync(subdir)) {
        if (fname.endsWith('.md') && fname !== '.gitkeep' && fname !== 'README.md') return true;
      }
    }
    return false;
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
    }

    if (this.getEnabledAnalysisTypes().length > 0) {
      this.scheduleAnalysis();
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
    if (this.mailPollTimer) {
      clearInterval(this.mailPollTimer);
      this.mailPollTimer = null;
    }
    if (this.remindTimer) {
      clearInterval(this.remindTimer);
      this.remindTimer = null;
    }
    if (this.focusTimer) {
      clearTimeout(this.focusTimer);
      this.focusTimer = null;
    }
    if (this.summaryTimer) {
      clearTimeout(this.summaryTimer);
      this.summaryTimer = null;
    }
    if (this.offsitePushTimer) {
      clearTimeout(this.offsitePushTimer);
      this.offsitePushTimer = null;
    }
  }

  // --- 업무 (work-assistant) ---

  /**
   * 브리핑 꼬리에 붙일 업무 요약. **절대 던지지 않는다** — 업무 조회가 실패했다고
   * 날씨·일정·보고서까지 사라지면 안 된다.
   *
   * **브리핑 세션과 동시에 시작한다**(호출자가 `await` 를 미룬다). 브리핑이 끝난
   * 뒤에 부르면 노션 왕복이 「세션 종료」와 「메시지 발송」 사이에 끼어 그 창만큼
   * 브리핑 전체를 잃을 위험이 커진다 — 2026-08-06 에 실제로 브리핑 완료 1 초 뒤
   * 봇이 재시작해 그 창에 걸렸다. 세션이 수십 초 걸리므로 동시에 돌리면 추가
   * 지연이 0 이다.
   */
  private async workBriefBlock(): Promise<string> {
    if (!isWorkAssistantEnabled()) return '';
    try {
      const text = await briefShort();
      return text ? `\n\n${text}` : '';
    } catch (error) {
      this.logger.warn('Work brief failed', error);
      return '\n\n⚠️ 업무 요약을 못 불러왔습니다 — 세션에서 `brief` 로 확인하세요.';
    }
  }

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
          // **진행을 걷어들이는 자리는 체크인 하나뿐이다.** 급한 것 넛지와 같은
          // 시각에 붙여 슬롯을 늘리지 않는다 — 물을 게 없으면 알아서 빈다.
          const ask = await checkinNudge(false);
          if (ask) await this.sendMessage(ask);
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
    const result = await this.spawnSession(body, {
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
    const result = await this.spawnSession(fs.readFileSync(promptPath, 'utf-8'), {
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

  private startBoardQueuePoller(): void {
    if (!boardQueueEnabled()) {
      this.logger.info('Board queue poller off (주소나 열쇠 없음)');
      return;
    }
    this.logger.info('Started board queue poller', { everyMs: BOARD_QUEUE_POLL_MS });
    this.boardQueueTimer = setInterval(async () => {
      if (this.boardQueueBusy) return;
      this.boardQueueBusy = true;
      try {
        const r = await drain(quickUpdate, this.askFromBoard ?? null, undefined, noteUpdate);
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
    }, BOARD_QUEUE_POLL_MS);
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
        const work = this.workBriefBlock();   // 세션과 동시에 시작
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
          // Append work summary + error report + cost stats line
          await this.sendMessage(result.text + await work +
            this.formatErrorReport() + this.formatCostLine());

          // If reports exist, add a button to view them
          if (this.hasUnreadReports()) {
            await this.sendMessage('📄 대기 중인 보고서가 있습니다.', [{
              type: 'section',
              text: { type: 'mrkdwn', text: '📄 대기 중인 보고서가 있습니다.' },
            }, {
              type: 'actions',
              elements: [{
                type: 'button',
                text: { type: 'plain_text', text: '📄 보고서 확인' },
                action_id: 'briefing_view_reports',
              }],
            }]).catch(() => {});
          }

          // NAS 이동 컨펌 큐 — 항목별 결정 버튼 (inbox auto-classify company 분류분)
          try {
            const nasBlocks = await buildNasQueueBlocks(await listNasQueue());
            if (nasBlocks) {
              await this.sendMessage('📦 NAS 이동 컨펌 대기', nasBlocks).catch(() => {});
            }
          } catch (err) {
            this.logger.warn('NAS confirm queue check failed', err);
          }
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
      .find(e => e.type === 'briefing');

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
      const work = this.workBriefBlock();   // 세션과 동시에 시작
      const result = await this.executeBriefing();
      this.recordSessionCost('briefing', result);
      await this.sendMessage(result.text + await work +
        this.formatErrorReport() + this.formatCostLine());

      if (this.hasUnreadReports()) {
        await this.sendMessage('', [{
          type: 'actions',
          elements: [{
            type: 'button',
            text: { type: 'plain_text', text: '📄 보고서 확인' },
            action_id: 'briefing_view_reports',
          }],
        }]).catch(() => {});
      }
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

    // Monday: inject weekly summary prompt
    if (new Date().getDay() === 1) {
      const mondayExtra = path.join(this.promptsDir, 'monday-briefing-extra.md');
      if (fs.existsSync(mondayExtra)) {
        prompt += '\n\n' + fs.readFileSync(mondayExtra, 'utf-8');
      }
    }

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
    const result = await this.spawnSession(prompt, {
      workingDirectory: this.workingDir,
      model: 'claude-haiku-4-5-20251001',
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

    const timer = setTimeout(async () => {
      try {
        await this.runAnalysisGroup(schedule, types);
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
   * 비용 원장은 대안이 못 된다 — agy 백엔드로 도는 타입은 Claude 세션 비용이 0이라
   * 원장에 흔적이 아예 없다(2026-08-18 실측: competitors는 단 한 번도 없음).
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

  private async runAnalysisGroup(schedule: string, types: string[]): Promise<void> {
    if (!this.config) return;

    const isDaily = schedule.startsWith('daily');
    const defaults = this.config.analysis.defaults;
    const completedTypes: string[] = [];
    const skippedTypes: { type: string; reason: string }[] = [];
    const timedOutTypes: string[] = [];
    // `sessionId` 가 있으면 그 세션을 이어받고(리미트에 걸린 당사자), 없으면 새로
    // 돌린다(중단 때문에 **아예 못 돈** 뒤쪽 타입). 둘을 한 큐에 담아야 중단과
    // 재개가 대칭이 된다 — 예전에는 당사자만 큐에 들어가서, 뒤쪽 타입은 재시도
    // 대상에도 안 들고 저널에도 안 남아 그 주 산출물이 통째로 사라졌다.
    const failedRetryTypes: { type: string; sessionId?: string }[] = [];
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
      planned: runnableTypes,
      skipped: skippedTypes,
    });

    for (const type of runnableTypes) {
      const typeConfig = this.config.analysis.types[type];
      const maxRetries = (typeConfig?.maxRetries as number | undefined)
        ?? defaults.maxRetries ?? 2;

      let succeeded = false;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          const result = await this.runSingleAnalysis(type);

          if (result.timedOut) {
            if (attempt < maxRetries) {
              this.logger.warn(`Analysis ${type} timed out, retry ${attempt + 1}/${maxRetries}`);
              continue; // Retry with fresh session (same WebFetch may hang again on resume)
            }
            this.logger.error(`Analysis ${type} timed out after ${attempt + 1} attempts`);
            errorCollector.add('AssistantScheduler', `분석 타임아웃 (${type}): ${maxRetries}회 재시도 후 포기`);
            timedOutTypes.push(type);
            this.appendAnalysisJournal(schedule, { kind: 'outcome', type, outcome: 'timeout' });
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
                ? { type, sessionId: result.sessionId }
                : { type });
            }
            // **뒤쪽 타입도 같은 큐에 넣는다.** 리미트는 그룹 전체를 끊는데
            // 재시도는 당사자만 돌리던 비대칭이 2026-08-22에 보고서 4종을
            // 통째로 날렸다(kg-regression 광역 게이트 포함). 못 돈 것은
            // 「나중에 돌 것」이지 「없던 일」이 아니다.
            if (shouldRetry) {
              deferredTypes = runnableTypes.slice(runnableTypes.indexOf(type) + 1);
              for (const rest of deferredTypes) failedRetryTypes.push({ type: rest });
            }
            if (result.resetsAt) limitResetsAt = result.resetsAt;
            this.appendAnalysisJournal(schedule, {
              kind: 'outcome', type, outcome: 'rate_limited',
              sessionId: result.sessionId, willRetry: shouldRetry,
              deferred: deferredTypes,
            });
            break; // Stop remaining types in this group (rate limit affects all)
          }

          succeeded = true;
          completedTypes.push(type);
          this.appendAnalysisJournal(schedule, { kind: 'outcome', type, outcome: 'completed' });
          break;
        } catch (error) {
          const msg = (error as Error).message || '';
          if (isRateLimitText(msg)) {
            this.logger.warn(`Analysis ${type} hit rate limit, stopping group`);
            this.appendAnalysisJournal(schedule, {
              kind: 'outcome', type, outcome: 'rate_limited', viaThrow: true,
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
            kind: 'outcome', type, outcome: 'error', error: msg.slice(0, 300),
          });
          break;
        }
      }

      // Rate limit breaks the entire group
      if (failedRetryTypes.length > 0) break;
    }

    // data-sync(daily-00:00)=야간, data-sync-noon(daily-12:00)=정오. 둘 다 startsWith('daily').
    const label = !isDaily ? '주간 분석' : (schedule === 'daily-12:00' ? '정오 동기화' : '야간 동기화');
    const parts = [`📊 ${label} 완료: ${completedTypes.join(', ') || '(없음)'}`];
    if (timedOutTypes.length > 0) {
      parts.push(`⏱️ 타임아웃: ${timedOutTypes.join(', ')}`);
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
      const msUntil = retryTime.getTime() - Date.now();
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

      const retryTimerKey = `retry-${schedule}`;
      const retryTimer = setTimeout(async () => {
        this.analysisTimers.delete(retryTimerKey);
        // **재시도 결과도 저널에 남긴다.** 예전에는 재시도가 저널에 아무것도 안
        // 적어서, 감시 검사(M12)가 재시도로 살아난 타입까지 「무기록」으로 셌다.
        const done: string[] = [];
        const failed: string[] = [];
        let stoppedAt = -1;
        for (let i = 0; i < failedRetryTypes.length; i++) {
          const { type, sessionId } = failedRetryTypes[i];
          try {
            this.logger.info(`Retrying analysis: ${type}`, { sessionId });
            const r = await this.runSingleAnalysis(type, sessionId);
            const outcome = r.rateLimited ? 'rate_limited' : r.timedOut ? 'timeout' : 'completed';
            (outcome === 'completed' ? done : failed).push(type);
            this.appendAnalysisJournal(schedule, {
              kind: 'outcome', type, outcome, viaRetry: true, sessionId: r.sessionId,
            });
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
              error: ((error as Error).message || '').slice(0, 300),
            });
          }
        }
        // 멈춘 뒤로 아예 손도 안 댄 것 — 저널에 남기지 않는다(무기록이 곧
        // M12 의 「그룹 중단」 신호다). 다만 사람에게는 적는다.
        const notTried = stoppedAt >= 0
          ? failedRetryTypes.slice(stoppedAt + 1).map(f => f.type) : [];
        // **성공한 것만 완료라고 적는다.** 예전에는 무엇이 어찌 됐든 「재시도 완료」
        // 한 줄이라, 아무 일도 안 한 회차가 성공으로 읽혔다(2026-08-22).
        const lines = [`📊 재시도 완료: ${done.join(', ') || '(없음)'}`];
        if (failed.length > 0) lines.push(`⚠️ 재시도 실패: ${failed.join(', ')}`);
        if (notTried.length > 0) {
          lines.push(`🚧 한도가 안 풀려 미시도: ${notTried.join(', ')}`);
        }
        await this.sendMessage(lines.join('\n')).catch(() => {});
      }, msUntil);

      this.analysisTimers.set(retryTimerKey, retryTimer);
    }
  }

  /** Calculate next hour + 5 minutes (retry buffer). */
  private getNextHourPlus5Min(): Date {
    const next = new Date();
    next.setHours(next.getHours() + 1, 5, 0, 0);
    return next;
  }

  /** 이 타입의 보고서가 떨어지는 디렉터리 이름 (config 우선, 없으면 타입 이름). */
  private reportDirFor(type: string): string {
    const configured = this.config?.analysis.types[type]?.reportDir;
    return typeof configured === 'string' && configured ? configured : type;
  }

  /**
   * `sinceMs` 이후에 쓰인 이 타입의 보고서를 찾아 경로를 돌려준다(없으면 null).
   *
   * **존재만으로는 근거가 못 된다** — 사람이 같은 창에 수동으로 돌려 둔 파일이
   * 그대로 걸린다. 그래서 세션 시작 시각을 기준선으로 받아 그 뒤에 쓰인 것만 센다.
   * 감시가 감시 대상을 죽이면 안 되므로 어떤 예외도 밖으로 내보내지 않는다.
   */
  private reportWrittenSince(type: string, sinceMs: number): string | null {
    const dir = this.reportDirFor(type);
    for (const base of [
      path.join(this.workingDir, 'reports', 'scheduled-reports', dir),
      path.join(this.workingDir, 'reports', 'archived', dir),
    ]) {
      try {
        if (!fs.existsSync(base)) continue;
        for (const name of fs.readdirSync(base)) {
          if (!name.toLowerCase().endsWith('.md')) continue;
          const full = path.join(base, name);
          if (fs.statSync(full).mtimeMs >= sinceMs) return full;
        }
      } catch {
        // 읽기 실패는 「산출물 없음」으로 두고 넘어간다 — 백스톱이 판정을
        // 뒤집는 쪽이라, 못 읽었을 때는 원래 판정을 살리는 것이 안전하다.
      }
    }
    return null;
  }

  private async runSingleAnalysis(
    type: string,
    resumeSessionId?: string,
  ): Promise<AnalysisRunResult> {
    const promptPath = path.join(this.promptsDir, `analysis-${type}.md`);
    if (!fs.existsSync(promptPath)) {
      this.logger.warn(`Analysis prompt not found: ${promptPath}`);
      return { rateLimited: false, timedOut: false, costUsd: 0 };
    }

    // 외부 정보 수집 분석(ai-practice, competitors)은 agy로 위임 — 6/15 이후
    // Agent SDK $100 크레딧 풀 보존. agy는 세션 resume 미지원이므로 retry 시는
    // 기존 SDK/CLI 경로로 자연 폴백.
    if (!resumeSessionId && this.shouldUseAgy(type)) {
      return this.runAgyAnalysis(type, promptPath);
    }

    const prompt = fs.readFileSync(promptPath, 'utf-8');
    const defaults = this.config!.analysis.defaults;
    const typeConfig = this.config!.analysis.types[type];
    const allowedTools = typeConfig?.allowedTools ?? defaults.allowedTools;
    const writablePaths = typeConfig?.writablePaths ?? defaults.writablePaths;
    const maxDurationMinutes = (typeConfig?.maxDurationMinutes as number | undefined)
      ?? defaults.maxDurationMinutes ?? 60;

    const useSdk = shouldUseSdk(`analysis:${type}`);
    // Pin model explicitly so future SDK default changes can't silently promote
    // analyses to Opus (which would burn the $100/mo credit fast).
    // Override per-type via config.analysis.types[type].model or ANALYSIS_MODEL env.
    const analysisModel = (typeConfig as any)?.model
      ?? process.env.ANALYSIS_MODEL
      ?? 'claude-sonnet-4-6';

    // 산출물 백스톱의 기준선 — **이 시각 이후에 쓰인 파일만** 이 세션의 성과다.
    const startedAtMs = Date.now();

    const result = await this.spawnSession(
      resumeSessionId ? 'continue' : prompt,
      {
        workingDirectory: this.workingDir,
        model: analysisModel,
        permissionMode: 'default',
        allowedTools,
        appendSystemPrompt: `CRITICAL: ${writablePaths.join(', ')} 디렉토리에만 새 파일 생성/수정. 그 외 파일 수정/삭제 금지.`,
        env: { ASSISTANT_MODE: 'analysis', CLAUDE_SCHEDULED: '1' },
        resumeSessionId,
        skipMcp: true,
        maxDurationMs: maxDurationMinutes * 60_000,
        useSdk,
        // 주간 분석은 깊게 읽고 쓰는 자리라 기본값 'high' 를 그대로 쓴다. 앞서
        // 여기 걸려 있던 `thinkingBudgetTokens: 5000` 은 적응형 사고를 끄는
        // 구형 경로였다 — 깊게 하려던 설정이 오히려 얕게 묶고 있었다(2026-08-06).
      },
    );

    this.recordSessionCost(`analysis-${type}`, result);

    this.logger.info('Analysis session completed', {
      type,
      subtype: result.subtype,
      costUsd: result.costUsd.toFixed(4),
      via: useSdk ? 'sdk' : 'cli',
      cacheRead: result.usage?.cacheReadTokens,
      textPreview: result.text?.substring(0, 600),
    });

    // Timeout detection
    if (result.subtype === 'error_timeout') {
      return { rateLimited: false, timedOut: true, sessionId: result.sessionId, costUsd: result.costUsd };
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
    // 수동으로 돌려 둔 것을 이 세션의 성과로 착각한다.
    if (flaggedLimit) {
      const produced = this.reportWrittenSince(type, startedAtMs);
      if (produced) {
        this.logger.warn('리미트로 찍혔지만 이번 세션이 보고서를 남겼다 — 완료로 처리', {
          type, produced, subtype: result.subtype, rateLimitEvent: result.rateLimited === true,
        });
        return { rateLimited: false, timedOut: false, sessionId: result.sessionId, costUsd: result.costUsd };
      }
      return {
        rateLimited: true, timedOut: false, sessionId: result.sessionId,
        costUsd: result.costUsd, resetsAt: result.rateLimitResetsAt,
      };
    }

    return { rateLimited: false, timedOut: false, sessionId: result.sessionId, costUsd: result.costUsd };
  }

  /**
   * agy(외부 모델)로 위임할 분석 type 여부.
   * 기본: ai-practice, competitors (외부 정보 수집 — WebSearch 의존).
   * ANALYSIS_AGY_TYPES env로 override (콤마 구분).
   */
  private shouldUseAgy(type: string): boolean {
    const raw = process.env.ANALYSIS_AGY_TYPES ?? 'ai-practice,competitors';
    return raw.split(',').map(s => s.trim()).filter(Boolean).includes(type);
  }

  private async runAgyAnalysis(
    type: string,
    promptPath: string,
  ): Promise<AnalysisRunResult> {
    const dateStr = new Date().toISOString().substring(0, 10);
    const outDir = path.join(this.workingDir, 'reports', type);
    const outPath = path.join(outDir, `.agy-raw-${dateStr}.txt`);
    const sessionId = `agy-${dateStr}-${type}`;

    this.logger.info('Running agy analysis', { type, promptPath, outPath });

    try {
      const result = await runAgy({
        promptPath,
        workingDirectory: this.workingDir,
        outPath,
        timeoutSeconds: 600,
        quietSecs: 30,
        logger: this.logger,
      });

      this.logger.info('agy analysis completed', {
        type,
        via: 'agy',
        sessionId,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        generatedFiles: result.generatedFiles,
        timedOut: result.timedOut,
      });

      if (result.exitCode !== 0 || result.timedOut) {
        errorCollector.add(
          'AssistantScheduler',
          `agy ${type} 실패: exitCode=${result.exitCode}, timedOut=${result.timedOut}`,
        );
        return { rateLimited: false, timedOut: result.timedOut, sessionId, costUsd: 0 };
      }

      return { rateLimited: false, timedOut: false, sessionId, costUsd: 0 };
    } catch (error) {
      this.logger.error('agy analysis exception', error);
      errorCollector.add('AssistantScheduler', `agy ${type} 예외: ${(error as Error).message}`);
      return { rateLimited: false, timedOut: false, costUsd: 0 };
    }
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
