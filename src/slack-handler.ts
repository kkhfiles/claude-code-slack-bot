import { App } from '@slack/bolt';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CliHandler, type CliEvent, type CliAssistantEvent, type CliInitEvent, type CliResultEvent, type CliRateLimitEvent } from './cli-handler';
import { SdkHandler, SdkProcess, SdkRunOptions } from './sdk-handler';
import { PendingDenial } from './types';
import { Logger } from './logger';
import { WorkingDirectoryManager } from './working-directory-manager';
import { FileHandler, ProcessedFile } from './file-handler';
import { TodoManager, Todo } from './todo-manager';
import { McpManager } from './mcp-manager';
import { SessionScanner, SessionInfo, formatRelativeTime } from './session-scanner';
import { AccountManager } from './account-manager';
import { AssistantScheduler, SpawnOpts, SessionResult, SessionUsage } from './assistant-scheduler';
import { CalendarPoller } from './calendar-poller';
import { config } from './config';
import { Locale, t, formatTime, formatDateTime, getHelpText as getHelpTextI18n } from './messages';
import { getVersionInfo, checkForUpdates } from './version';
import { isRateLimitText as isRateLimitTextUtil, isRateLimitError as isRateLimitErrorUtil } from './rate-limit-utils';
import { stillBlocked } from './rate-limit-until';
import { engineState, type Block, type Engine } from './engine-state';
import { currentClaudeBlock, thrownClaudeBlock } from './engine-tap';
import { EngineRecovery } from './engine-recovery';
import { EngineNotice, loadModelLabels, type ModelLabels } from './engine-notice';
import { ProcessMemoryWatchdog } from './process-memory-watchdog';
import { SdkUpdate, RUN_ACTION as SDK_UPDATE_RUN, SKIP_ACTION as SDK_UPDATE_SKIP } from './sdk-update';
import { DaouLoginNotifier, ACTION_ID as DAOU_LOGIN_ACTION } from './daou-login';
import { LunchPoller } from './lunch-poller';
import { LunchButtons, readLunchBotToken, readLunchAnnounceChannel } from './lunch-buttons';
import { ChatHost } from './chat-host';
import { LetterRelay } from './letter-relay';
import { LetterNotice, coffeeKinds, type NoticeKind } from './letter-notice';
import { WebClient } from '@slack/web-api';
import { LetterInitiative } from './letter-initiative';
import { LetterBooking } from './letter-booking';
import { LetterBoost } from './letter-boost';
import { PremiumSeatSlack } from './premium-seat';
import { LetterCoffeechat } from './letter-coffeechat';
import { ReportServer } from './report-server';
import { listNasQueue, buildNasQueueBlocks, confirmAndApply, rejectItems, retargetItem } from './nas-confirm';
import { decisionReply, noticeReply, reportLogAvailable } from './action-pipeline';
import type { ThreadApi } from './action-pipeline';
import { captureToInbox, checkinMap, checkinNow, codexTurn, dropCapture, isWorkAssistantEnabled,
  markCaptureFailed, markCaptureReplayed, markCaptureTold, markCaptureTried, pendingCaptures,
  pendingHeld, quickUpdate, SESSION_CODEX_MODEL, workAssistantRoot } from './work-assistant';
import { boardLabel } from './board-queue';
import { readUnseen } from './dm-context';
import { containsPrivate } from './privacy-guard';
import { ChannelGate, HOLD_SWEEP_MS, REPLAY_FRAME, buildHoldExtra, drainHeld, dropHeldFiles, holdV2On,
  leadText, markChoice, needsCanary, oldListMessage, receivedSec, replayNote, replayTarget,
  type HeldFile, type HeldItem } from './hold-replay';
import { StepLog, isHeldOutcome, isWriteTool, outcomeFrom, type TurnOutcome, type TurnStep } from './turn-outcome';
import { fallbackEligible, isAgyRung, pickAfter, pickEngine, type DmOrigin, type LadderPick, type PickInput } from './engine-ladder';
import { CODEX_INFLIGHT_STEP, FALLBACK_TIMEOUT_MS, INCOMPLETE_LINE, NEEDS_FULL_LINE, agyMarkerLines, agyRunningStep,
  appendLedger, codexSteps, dmFallbackOn, fallbackEnv, dmLadder, engineStatusText, filesNote, handoverNote, isQuietReply,
  ladderBlockedMap, ledgerActiveSince, ledgerNote, ledgerServedSince, markerLines, notRunSteps } from './dm-fallback';
import { codexQuota } from './codex-quota';
import { sameTier, serviceCodex } from './model-ladder';
import { readDrill } from './engine-drill';
import { agyDisplay, agyModel, agyRungsOn, agyTurn, type AgyRung } from './agy-turn';
import { AGY_DM_RULES, actionReport, actionSteps, agyDmPrompt, fetchTaskList, runActions, validateActions } from './agy-actions';

/**
 * 슬랙 대화 세션의 사고 깊이. SDK 기본값은 `'high'` 다.
 *
 * 슬랙은 오가며 한 줄 던지고 받는 곳이라 **응답 속도 자체가 기능**이고, 여기서
 * 오가는 일은 대부분 판단이 아니라 정해진 명령 실행이다(조회·상태 변경·진행 로그).
 *
 * **사고를 조절하는 손잡이는 `effort` 하나다.** 지금 모델(Claude 5)은 적응형 사고 —
 * 모델이 턴마다 얼마나 생각할지 스스로 정하고, `effort` 는 그 깊이를 안내한다.
 * `thinking: {budgetTokens}` 는 타입 주석이 "older models" 라고 못박은 경로라
 * 넘기는 순간 적응형이 꺼져, 쉬운 턴에서 알아서 줄이는 성질까지 같이 잃는다.
 *
 * **2026-08-13 에 모델까지 같이 쟀다** — 모델 3 × 깊이 3 × 사례 6 = 54회를 실제
 * 세션 조건으로 돌렸다(`scripts/model-bench.mjs`). `opus` + 이 값이 정확도 6/6 ·
 * 중간값 21초 · 건당 $0.60 으로 가장 좋았다. **깊이를 올려도 정확해지지 않고**
 * (opus low 6/6 > high 5/6), 작은 모델은 헤매느라 **더 느리면서 틀린다**(haiku
 * 2~3/6 에 20~26초). 표와 해석은 work-assistant `docs/design.md`.
 */
const INTERACTIVE_EFFORT = 'low' as const;

/**
 * 대화 세션에 **자기가 슬랙에 있다는 것**을 알린다.
 *
 * 이게 없으면 표면별 규칙이 통째로 죽는다. 프로젝트 `CLAUDE.md` 가 「터미널은
 * 이렇게, 슬랙은 저렇게」로 갈라놔도 세션은 어느 쪽인지 알 방법이 없어 먼저 적힌
 * 쪽을 고른다(2026-08-06 실측: 모델·effort 7개 조합 **전부** 터미널용 명령을 골랐다).
 * 규칙을 적어 둔 것과 규칙이 적용되는 것은 다르다.
 *
 * 문법을 여기 박는 이유는 **틀려도 조용하기 때문**이다. 슬랙은 표준 마크다운을
 * 렌더링하지 않고 기호를 글자 그대로 보여준다 — 오류가 아니라 지저분한 성공이라
 * 아무도 안 고친다.
 */
/**
 * 컨텍스트를 **40% 에서 압축**시키기 위한 값. 기본값은 96.7% 라 사실상 안 걸린다.
 *
 * DM 이 스레드를 안 만들면서 세션 키가 `direct` 로 고정됐다 — 대화가 이어지는
 * 대신 **컨텍스트가 하루 종일 쌓인다**. 창을 좁혀 일찍 접는다.
 *
 * **임계 = 지정한 창 − 33,000**(예약분). 실측으로 확인했다:
 * 지정 없음 → 967,000 · 400,000 지정 → 367,000. 모델 창이 1,000,000 이므로
 * 40%(=400,000)에 걸리게 하려면 433,000 을 준다.
 *
 * ⚠️ 스키마가 `int [100_000, 1_000_000]` 이고 **범위를 벗어나면 조용히 무시된다**
 * (`.catch(void 0)`). 값을 바꿀 때 로그로 임계를 확인하지 않으면 안 걸린 줄 모른다.
 */
const INTERACTIVE_COMPACT_WINDOW = 433_000;

/**
 * 처리 중인 대화를 디스크에 적어 둔다 — **재시작에 조용히 사라지지 않게.**
 *
 * 봇을 다시 올리면 진행 중이던 세션이 통째로 없어지는데, 오류도 안 나고 답도 안
 * 와서 받는 쪽에서는 무시당한 것과 구분되지 않는다. 2026-08-06 하루에만 세 번
 * 발생했다(레포를 두 세션이 같이 만지던 날). 프로세스가 강제 종료돼도 남아야
 * 하므로 종료 훅이 아니라 **파일**에 적고, 다음 기동 때 읽어 알린다.
 */
// 검사는 `INFLIGHT_SESSIONS_FILE` 로 옮긴다 — 대화 처리기를 통째로 돌리는 검사가 운영 파일을 안 건드리게.
const INFLIGHT_FILE = process.env.INFLIGHT_SESSIONS_FILE || path.join(__dirname, '..', '.inflight-sessions.json');

interface InflightRecord { channel: string; threadTs?: string; text: string;
  startedAt: string;
  /** 이 차례가 든 캡처. 재시작으로 끊기면 그 캡처에 표시를 남긴다. */
  captureId?: string;
  /**
   * 돈 도구(보류 v2) — 재시작으로 끊겼을 때 쓰기가 돌았나를 가른다. 도구가 시작할 때마다 고쳐
   * 쓴다(도구 하나에 한 번). 쓰기가 돌았으면 처음부터가 아니라 이 세션으로 이어 간다.
   */
  steps?: TurnStep[];
  sessionId?: string;
  /** 이 차례가 이어 가던 앞 차례의 「이미 한 것」 — 또 끊기면 합쳐서 넘긴다. */
  heldSteps?: string[];
  /** 첨부(임시 파일) — 끊기면 보관 폴더로 옮긴다. */
  files?: HeldFile[];
  /** 지금 맡은 엔진 — GPT 가 이어 받는 중이면 `codex`(DM 폴백) · agy 칸이면 그 칸(6단계). */
  engine?: Engine;
  /**
   * `waiting` — 원문은 캡처했는데 아직 차례를 안 띄움(같은 방의 문 · 대체 차례를 기다리는 중). 열쇠는
   * `wait:<캡처 id>`(도는 차례의 열쇠와 겹치지 않게). 재시작에 끊기면 기동이 `interrupted` 로 적어 드레인이 줍는다.
   */
  state?: 'waiting'; }

/** 기다리는 차례의 처리 중 기록 열쇠 — 같은 대화의 도는 차례(`sessionKey`)를 덮지 않게 캡처마다 따로. */
function waitKey(captureId: string): string {
  return `wait:${captureId}`;
}

/**
 * 지난 기동의 처리 중 기록 — **새 차례가 파일을 고치기 전에** 떠 둔다(생성자 · 2026-10-15 검토). 기동 뒤 12초에
 * 알리는데, 그 사이 같은 대화(DM 맨 위는 `direct` 하나)의 새 차례가 기록을 덮으면 끊긴 차례가 사라졌다.
 */
let bootInflight: Record<string, InflightRecord> | null = null;

/** 지금 처리 중 기록을 지난 기동의 것으로 떠 둔다 — 생성자가 부른다(검사는 직접 부른다). */
export function snapshotBootInflight(): void {
  bootInflight = readInflight();
}

/**
 * 대화 차례가 들고 있는 것 — Claude 프로세스 또는 GPT 대체 차례의 손잡이. `-stop` 과 새 차례가 끊고,
 * 메모리 감시기가 pid 로 찾는다.
 */
interface TurnHandle { interrupt(): void; readonly pid?: number }

/** 대체 칸 한 차례(GPT · agy 두 칸)에 넘기는 것 — 대화 처리기가 모은 그대로. */
interface FallbackArgs {
  event: MessageEvent; channel: string; sessionKey: string; replyTs?: string; ts: string; thread_ts?: string;
  captureId: string; surfaceNote: string; slotMap: string; finalPrompt: string; files: ProcessedFile[];
  /** 앞 칸들이 돌린 것(Claude 도구 · GPT 명령) — 넘겨줄 메모와 보류 칸이 된다. */
  claudeSteps: TurnStep[]; claudeModel: string; block: Block; sessionId?: string;
  locale: Locale; say: (msg: any) => Promise<{ ts?: string }>; status: (text: string) => void;
  /** 이 칸이 못 했을 때 그다음 칸 — `hold` 면 이 칸이 모아 두고 한도 안내를 낸다. */
  nextAfter: (failed: Engine) => Promise<LadderPick>;
}

/**
 * 대체 칸 한 차례의 끝 — `ok` 답함 · `held` 답했지만 「Claude·GPT 몫」을 모아 둠 · `failed` 못 해서 모아 둠 ·
 * `stopped` 사람이 끊음 · `next` 다음 칸(`next`)으로.
 */
interface FallbackResult {
  result: 'ok' | 'held' | 'failed' | 'stopped' | 'next';
  steps: TurnStep[]; writeRan: boolean; markDone?: Promise<void>; next?: LadderPick;
  /** 넘길 글에 개인 글 조각이 있어 모아 둠 — 막힘이 아니라 「못 함」으로 끝낸다(드레인이 뒤의 건을 계속 본다). */
  privateHold?: boolean;
}

/** Claude 를 건너뛴 차례(DM 폴백 · 엔진 상태가 막혔다고 함)의 빈 흐름 — 스트림 고리가 그냥 지나간다. */
function skippedTurn(): AsyncIterable<CliEvent> & TurnHandle {
  return {
    async *[Symbol.asyncIterator]() { /* 띄운 것이 없다 */ },
    interrupt() { /* 끊을 것이 없다 */ },
  };
}

/**
 * 차례의 답 위치이자 대화 단위 — DM 최상위는 `undefined`(세션 키 `direct`), 그 밖은 스레드(없으면 그 글).
 * `-stop` · `-reset` 도 이것으로 키를 짓는다 — 따로 지으면 DM 에서 키가 안 맞아 끊기지도 지워지지도 않는다.
 */
function turnThreadTs(channel: string, threadTs: string | undefined, ts: string): string | undefined {
  return channel.startsWith('D') ? threadTs : (threadTs || ts);
}

/** 이 프로세스가 뜬 시각 — 이보다 늦게 시작한 처리 중 기록은 지난 기동의 것이 아니다. */
const BOOT_MS = Date.now();

/** 대화 세션을 지우는 기준 — 이만큼 안 쓰면(장부의 다른 엔진 차례 포함) 지운다. */
const SESSION_IDLE_MS = 24 * 60 * 60 * 1000;

function readInflight(): Record<string, InflightRecord> {
  try { return JSON.parse(fs.readFileSync(INFLIGHT_FILE, 'utf-8')); } catch { return {}; }
}

function writeInflight(map: Record<string, InflightRecord>): void {
  try { fs.writeFileSync(INFLIGHT_FILE, JSON.stringify(map), 'utf-8'); } catch { /* 알림용이라 실패해도 본 작업을 막지 않는다 */ }
}

/** 첨부의 보관용 모양 — 임시 파일 자리(`tempPath`)는 뺀다. */
function heldFileOf(f: ProcessedFile): HeldFile {
  return { path: f.path, name: f.name, mimetype: f.mimetype, isImage: f.isImage, isText: f.isText, size: f.size };
}

/** 처리 중 기록 한 건을 고친다 — 없으면(이미 끝남) 안 만든다. */
function patchInflight(key: string, patch: Partial<InflightRecord>): void {
  const m = readInflight();
  if (!m[key]) return;
  m[key] = { ...m[key], ...patch };
  writeInflight(m);
}

const SLACK_SURFACE_NOTE = [
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
 * 원문은 **봇이 이미 저장했다**는 것과, 그래서 세션이 무엇을 해야 하는지.
 *
 * 캡처를 세션에 맡겼더니 안 했다(2026-08-06: 업무 서술을 받고도 `inbox` 가 0건).
 * 규칙은 `CLAUDE.md` 에 있었지만 적용되지 않았다 — 오늘만 세 번째 같은 실패다.
 * 그래서 저장은 **봇이 결정론적으로** 하고(파이썬·노션을 안 거치므로 노션이 죽어도
 * 세션이 끊겨도 원문은 남는다), 세션에는 **닫는 일만** 남긴다.
 *
 * 안 닫힌 항목이 곧 "받았는데 처리 안 된 메시지" 다 — 재시작으로 죽은 세션도
 * 여기 걸린다. 그래서 닫는 책임을 분명히 적어 둔다.
 *
 * ⚠️ **캡처 id 를 여기 안 박는다** (2026-08-31). 박으면 이 안내가 차례마다 달라져
 * **미리 띄운 세션을 다음 차례에 못 쓴다**(2026-08-29 에 그래서 미리 띄우기를
 * 통째로 걷었다). id 는 `WORK_ASSISTANT_CAPTURE_FILE` 로 넘기고, 파이썬이
 * 차례마다 그 파일에서 읽는다.
 */
const CAPTURE_NOTE = [
  '',
  '**이 메시지의 원문은 캡처로 이미 저장돼 있다** (봇이 남겼다).',
  '처리를 마쳤으면 **반드시 닫는다** — 안 닫으면 아침 브리핑 맨 위 ⛔ 에',
  '"미처리 캡처" 로 남아 처리된 것과 구분이 안 된다.',
  '- 업무로 등록했거나 기존 업무에 쓰기를 했으면: **아무것도 안 해도 스스로 닫힌다**',
  '- 조회·잡담이라 쓰기가 없었으면: `tasks.py inbox resolve --drop "사유"`',
].join('\n');

/**
 * 이번 차례의 캡처 id 가 적히는 곳. **방마다 하나로 고정**이라 세션 옵션이 안 바뀐다.
 *
 * ⚠️ **방 이름을 파일 이름에 그대로 안 쓴다** — 채널 id 는 안전하지만, 다른 방이
 * 같은 파일을 쓰면 서로의 캡처를 닫는다. 그래서 방마다 따로 둔다.
 */
function capturePointer(channel: string): string {
  const dir = path.join(os.homedir(), '.claude', 'state');
  return path.join(dir, `work-capture-${channel.replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
}

/**
 * 이번 차례의 캡처 id 를 적는다. 빈 값이면 지운다 — **차례가 끝나면 반드시 비운다.**
 *
 * ⚠️ **안 비우면 다음 쓰기가 앞 차례의 캡처를 닫는다.** 파이썬 쪽도 적힌 시각을
 * 보고 30분이 지난 것은 안 쓰지만(`CAPTURE_FILE_TTL_MIN`), 그것은 봇이 도중에
 * 죽었을 때의 안전망이지 평소에 기대는 길이 아니다.
 *
 * 여기서 터져도 차례는 그대로 간다 — 못 적으면 캡처가 안 닫힐 뿐이고, 그건
 * 아침 브리핑 ⛔ 에 남아 사람이 본다.
 */
function writeCapturePointer(channel: string, id: string): void {
  const file = capturePointer(channel);
  try {
    if (!id) { fs.rmSync(file, { force: true }); return; }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // ⚠️ **지역 시각으로 적는다** — 파이썬이 `datetime.now()` 와 견주므로
    // `toISOString()`(UTC)을 적으면 **늘 9시간 낡은 것으로 보여 통째로 버려진다.**
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    const at = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
      + `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    fs.writeFileSync(file, JSON.stringify({ id, at }));
  } catch { /* 캡처가 안 닫힐 뿐 — 차례를 막지 않는다 */ }
}

interface MessageEvent {
  user: string;
  channel: string;
  thread_ts?: string;
  ts: string;
  text?: string;
  /**
   * 다시 돌릴 때 **원래 캡처를 그대로 쓴다.**
   *
   * 이것이 없으면 `captureToInbox` 가 매번 새로 붙여, 다시 돌릴 때마다 큐가
   * **줄어드는 게 아니라 늘어난다** — 옛 것은 열린 채 남고 새 것이 하나 더 생긴다.
   */
  captureId?: string;
  /**
   * 보류 v2 — 다시 돌리는 차례가 싣는 것. 사람이 보낸 메시지에는 없다.
   *   - `outcomeSink` 차례가 끝나면 결과(`TurnOutcome`)를 여기에 채운다 — 부른 쪽이 「다시 막혔나」를 본다
   *   - `replay` 다시 돌리는 차례 — 방의 문(`holdGate`)을 기다리지 않는다(자기가 잡은 문이다)
   *   - `replayNote` 세션 앞에 붙일 메모(받은 시각 · 그 뒤의 글 · 이미 한 것)
   *   - `resumeSessionId` · `heldSteps` 일하다 끊긴 차례를 같은 세션으로 이어 감
   *   - `heldFiles` 보관해 둔 첨부
   */
  outcomeSink?: Partial<TurnOutcome>;
  replay?: boolean;
  replayNote?: string;
  resumeSessionId?: string;
  heldSteps?: string[];
  heldFiles?: HeldFile[];
  /** agy 칸이 「Claude·GPT 몫」으로 남긴 것을 다시 돌림(6단계) — agy 칸을 건너뛴다. */
  needsFull?: boolean;
  files?: Array<{
    id: string;
    name: string;
    mimetype: string;
    filetype: string;
    url_private: string;
    url_private_download: string;
    size: number;
  }>;
}

// result 이벤트 후 스트림이 닫히기를 기다리는 한계 (자식 프로세스/훅 hang 대비)
const RESULT_GRACE_MS = 120_000;

/** 한 회차에 다시 돌릴 상한. 실측 최대가 2건이라 넉넉하다(2026-08-31). */
const DRAIN_MAX = Number(process.env.DRAIN_MAX ?? 5);

export class SlackHandler {
  private app: App;
  private cliHandler: CliHandler;
  private sdkHandler: SdkHandler;
  private logger = new Logger('SlackHandler');
  private workingDirManager: WorkingDirectoryManager;
  private fileHandler: FileHandler;
  private todoManager: TodoManager;
  private mcpManager: McpManager;
  private reportServer?: ReportServer;

  // Active CLI process tracking (for interrupt/stop)
  private activeProcesses: Map<string, TurnHandle> = new Map();
  // GPT 대체 차례가 도는 대화 — 문을 안 기다리는 차례(다시 돌리기)도 끊지 않고 끝나기를 기다린다.
  private fallbackRuns: Map<string, Promise<void>> = new Map();

  // UI state
  private todoMessages: Map<string, string> = new Map();
  private originalMessages: Map<string, { channel: string; ts: string }> = new Map();
  private currentReactions: Map<string, Set<string>> = new Map();
  // **반응은 순서만 지키고 기다리지 않는다** (2026-08-31). 반응 하나가 슬랙 왕복
  // 한두 번인데 그 결과를 읽는 곳이 어디에도 없다. 그런데 차례의 앞뒤 양쪽에서
  // 기다리고 있었다 — 띄우기 전 0.52초, 차례 끝 2.16초 중 대부분(08/31 실측).
  //
  // ⚠️ **그냥 안 기다리면 순서가 깨진다** — 반응을 바꾸는 함수가 `activeReactions`
  // 를 **await 뒤에** 고치므로, 두 호출이 겹치면 서로의 중간 상태를 보고 충돌
  // 반응을 안 지우거나 같은 것을 두 번 단다. 그래서 세션마다 줄을 세워 **순서는
  // 그대로 두고 기다리는 것만 없앤다.**
  private slackChain: Map<string, Promise<void>> = new Map();

  // Thread hint tracking (show command hint once per thread)
  private hintShownThreads: Set<string> = new Set();

  // Per-channel settings
  private channelModels: Map<string, string> = new Map();
  private channelPermissionModes: Map<string, 'default' | 'safe' | 'trust' | 'auto'> = new Map();
  private channelAlwaysApproveTools: Map<string, Set<string>> = new Map();
  private lastQueryCosts: Map<string, { cost: number; duration: number; model: string; sessionId: string }> = new Map();

  // Permission denial tracking (CLI mode)
  private pendingDenials: Map<string, PendingDenial> = new Map();
  // One-time approved tools (consumed on next handleMessage call)
  private pendingOneTimeTools: Map<string, string[]> = new Map();

  // 한도 회복 시각에 깨어나는 타이머 하나 — 시각은 엔진 상태 파일에 있어 재시작 뒤에도 다시 건다
  // (`engine-recovery.ts`). 깨어나면 밀린 것을 드레인하고 엔진 안내를 다시 본다.
  private engineRecovery = new EngineRecovery({
    onRecover: async (why) => {
      await this.engineNotice.check();
      // 예약 쪽(못 올린 브리핑 · 미룬 한도 재시도) — 기다리지 않고 던지지 않는다(드레인을 안 막게).
      try {
        this.assistantScheduler?.onEngineRecover(why);
      } catch (err) {
        this.logger.warn('회복 뒤 예약 일을 못 걸었습니다', err);
      }
      await this.drainStuck('한도 회복');
    },
  });
  // DM 을 맡는 엔진이 바뀔 때 한 줄 안내 — 기본 꺼짐(`ENGINE_NOTICE=on`) · 꺼져 있으면 로그만.
  private engineNotice = new EngineNotice({
    // 실제로 붙은 칸만 — DM 폴백이 꺼져 있으면 Claude 하나(막히면 곧 모아 둠).
    ladder: () => dmLadder(),
    // GPT 이름은 실제로 부르는 모델(`engineNoticeLabels`) — 기본 모델이 아니라 DM 방의 모델과 차례가 고른 모델.
    labels: () => this.engineNoticeLabels(),
    post: async (text) => {
      if (!config.assistant.dmChannel) return;
      await this.app.client.chat.postMessage({ channel: config.assistant.dmChannel, text });
    },
  });
  /** GPT 칸이 마지막으로 실제로 부른 모델 — 대응표에 칸이 없을 때 엔진 안내가 이것을 쓴다. */
  private lastCodexModel: string | null = null;
  /** `-stop` 이 끊은 손잡이 — Claude 가 돌던 다시 돌리기도 GPT · agy 처럼 그 캡처를 버린다(2026-10-15 검토). */
  private stoppedTurns?: WeakSet<TurnHandle>;
  // 보류 v2 — 밀린 것을 다시 돌리는 동안 같은 방의 새 차례는 기다린다(`hold-replay.ts`). 대화 처리기는
  // 같은 대화의 새 차례가 오면 앞 차례를 끊는데, 다시 돌리는 차례가 끊기면 반쯤 쓴 채로 남는다.
  private holdGate = new ChannelGate();

  // Plan mode: store session info for "Execute" button
  private pendingPlans: Map<string, { sessionId: string; prompt: string; channel: string; threadTs: string | undefined; user: string }> = new Map();

  // Session picker
  private sessionScanner: SessionScanner = new SessionScanner();
  private pendingPickers: Map<string, {
    sessions: SessionInfo[];
    channel: string;
    threadTs: string;
    user: string;
    messageTs: string;
    timeout: ReturnType<typeof setTimeout>;
    shownCount: number;
    locale: Locale;
  }> = new Map();

  private botUserId: string | null = null;
  private userLocales: Map<string, Locale> = new Map();

  // Assistant scheduler
  private assistantScheduler: AssistantScheduler | null = null;

  // OAuth 토큰 하나를 터미널과 맞춰 세션에 넣는다. 계정 전환 · API 키 전환은 2026-10-14
  // 사용자 결정으로 걷었다 — 한도 소진은 엔진 폴백 · 보류 재실행(`drainStuck`)이 대신한다.
  private accountManager = new AccountManager();
  private notifiedUnhealthyAccounts = new Set<string>(); // Prevent repeated token expiry notifications

  // System memory watchdog
  private memoryWatchdog: ProcessMemoryWatchdog | null = null;
  // Agent SDK 판 맞춤 — 주 1회 DM 버튼
  private sdkUpdate: SdkUpdate | null = null;
  private daouLogin: DaouLoginNotifier | null = null;

  // Lunch recruitment bot (external script, its own Slack identity)
  private lunchPoller: LunchPoller | null = null;
  private lunchButtons: LunchButtons | null = null;

  // AI Premium 좌석 관리. 소인 앱의 연결에 얹혀 간다 — 자기 소켓을 열지 않는다.
  private premiumSeat: PremiumSeatSlack | null = null;

  // agy 대화 계층 (봇마다 자기 슬랙 앱 · 자기 소켓 연결)
  private chatHosts: ChatHost[] = [];

  constructor(app: App, cliHandler: CliHandler, mcpManager: McpManager, reportServer?: ReportServer) {
    // 지난 기동의 처리 중 기록을 **어떤 차례보다 먼저** 떠 둔다 — 알림(12초 뒤) 전에 새 차례가 덮을 수 있다.
    snapshotBootInflight();
    this.app = app;
    this.cliHandler = cliHandler;
    this.sdkHandler = new SdkHandler(mcpManager);
    this.mcpManager = mcpManager;
    this.reportServer = reportServer;
    this.workingDirManager = new WorkingDirectoryManager();
    this.fileHandler = new FileHandler();
    this.todoManager = new TodoManager();

    // Initialize assistant scheduler if configured
    if (config.assistant.dmChannel && config.assistant.configDir) {
      this.assistantScheduler = new AssistantScheduler(
        async (text, blocks?) => {
          await this.app.client.chat.postMessage({
            channel: config.assistant.dmChannel,
            text,
            ...(blocks ? { blocks } : {}),
          });
        },
        async (prompt, opts) => this.runAssistantSession(prompt, opts),
        config.assistant.configDir,
        async (text, lead, shown) => this.askFromBoard(text, lead, shown),
        { actionThreads: this.actionThreadApi() },
      );

      // Loopback trigger endpoint for manual analysis (Phase 1.7 / 1.8 / 1.9).
      // 결과 한 줄(처리한 백엔드 · 저장 상태)을 DM 으로 낸다 — 호출한 쪽은 202 만 받으므로
      // 여기서 안 내면 그 회차가 Codex 로 처리됐는지 아무 데도 안 보인다.
      if (this.reportServer) {
        const scheduler = this.assistantScheduler;
        // `?type=@group` 이면 기본 스케줄 그룹(`-analyze` 와 같음) — `runAnalysisTrigger` 주석.
        this.reportServer.setTriggerCallback(async (type: string) => {
          // `@improve` — 매일 개선 제안을 한 번 만든다(켜는 문과 무관 · 시안 확인용). **DM 을 안 보낸다** —
          // 만든 제안은 다음 브리핑이 올리고, 꺼져 있으면 안 올린다. 결과는 로그 한 줄.
          if (type === '@improve') {
            const done = await scheduler.runImproveNow();
            this.logger.info(`개선 제안(로컬 트리거) — ${done}`);
            return done;
          }
          const text = await scheduler.runAnalysisTrigger(type);
          await this.app.client.chat.postMessage({
            channel: config.assistant.dmChannel,
            text: `🔧 수동 실행(로컬 트리거) — ${text}`,
          });
          return text;
        });
      }
    }

    // Initialize lunch poller (only when a script path is configured)
    if (config.lunchBot.script) {
      this.lunchPoller = new LunchPoller(
        config.lunchBot.python,
        config.lunchBot.script,
        config.lunchBot.intervalMinutes,
        config.lunchBot.windowStart,
        config.lunchBot.windowEnd,
      );
      // Buttons ride on the channel chat host's connection (see below), so this
      // object holds the handler and does not open anything by itself. Without
      // the app token the message still works — the 🤖 emoji is the fallback.
      if (config.lunchBot.appToken) {
        this.lunchButtons = new LunchButtons(
          config.lunchBot.python,
          config.lunchBot.script,
          config.lunchBot.appToken,
        );
      }
    }

    // 좌석 기능. 채널과 관리자가 없으면 세우지 않는다 — 승인 경로가 없는 채로
    // 현황판만 뜨면 요청이 갈 곳이 없다.
    if (config.premiumSeat.enabled
        && config.premiumSeat.channelId
        && config.premiumSeat.managerUserIds.length
        && config.premiumSeat.workerDir) {
      this.premiumSeat = new PremiumSeatSlack({
        python: config.premiumSeat.python,
        workerDir: config.premiumSeat.workerDir,
        channelId: config.premiumSeat.channelId,
        managerUserIds: config.premiumSeat.managerUserIds,
        openToTeam: config.premiumSeat.open,
        jobPollSeconds: config.premiumSeat.jobPollSeconds,
        dmRedirectTo: config.premiumSeat.dmRedirectTo,
        bookingAuth: config.premiumSeat.bookingClientId && config.premiumSeat.bookingClientSecret
          ? { id: config.premiumSeat.bookingClientId, secret: config.premiumSeat.bookingClientSecret }
          : undefined,
      });
    } else if (config.premiumSeat.enabled) {
      this.logger.warn('Premium seat feature is on but not configured; staying closed');
    }

    // 대화 봇들 — 토큰과 turn.py 경로가 다 있을 때만 켠다. 하나라도 없으면 꺼진 채로 둔다.
    const turnScript = config.chat.turnScript;
    // 시험용 방은 **모든 대화 봇의 방 목록에 같이 들어간다.** 초대해 둔 봇이 어느 것인지
    // 몰라도 되게 — 실원 방을 건드려 가며 말투를 시험하지 않으려고 두는 자리다.
    const testRoom = config.chat.testChannel;
    // 봇이 사는 방은 쉼표로 여럿 적을 수 있다(점심 방 + 친목 방처럼). 방마다 하는 일은
    // 봇 설정의 `rooms` 가 가른다 — 여기 목록은 「이 방 말을 듣는다」만 정한다.
    const rooms = (main: string) => [...main.split(','), testRoom].map((s) => s.trim()).filter(Boolean);
    // 봇끼리 말 섞기는 **두 봇에 같이 건다** — 한쪽만 들으면 한쪽이 혼잣말을 한다.
    const botTalk = config.chat.botTalk.enabled ? config.chat.botTalk : null;
    // **봇의 주간 판단**(실장 2026-09-24 「봇 모두 주체적 판단은 주 1회 후 나에게 DM 으로 제안」) — 커피콩·소인 둘 다
    // 주 첫 업무일 오후에 스스로 판단해 실장 DM 에 제안하고, 방에 걸 글은 확인 카드로만 간다. 카드 창구는 실장 DM 이
    // 있는 커피콩 앱 하나다 — 소인의 제안도 거기 뜨고, 「보내기」를 누르면 **소인 이름으로** 그 방에 오른다(`poster`).
    // 방 이름은 봇 설정의 `rooms` 에서 읽는다. 소인 대화 호스트는 아래에서 만들어지므로 늦게 묶는다.
    let lunchHost: ChatHost | null = null;
    // 소인이 실장 턴에서 「다른 방에 올릴 글」을 실으면 같은 카드 창구로 받는다(2026-10-02 실장 「사람 비서처럼 다른 채널에서
    // 활동」). 카드 창구가 커피콩 앱에 있어 아래 커피콩 블록에서 정해지고, 더 아래 소인 대화 호스트가 받는다 — 전에는 소인
    // 호스트에 이 길이 없어 주간 판단 밖에서 실은 글이 말없이 버려졌다.
    let lunchAsk: LetterNotice['offer'] | undefined;
    const roomLabel = (bot: string, id: string): string => {
      try {
        const cfg = JSON.parse(fs.readFileSync(
          path.join(path.dirname(turnScript), 'bots', bot, 'config.json'), 'utf-8'));
        return String(cfg?.rooms?.[id]?.name || id);
      } catch {
        return id;
      }
    };
    const lunchToken = turnScript && config.lunchBot.script ? readLunchBotToken(config.lunchBot.script) : null;
    // 소인 이름으로 쓰고 소인이 사는 방을 읽는 클라이언트 — 커피콩 앱은 그 방에 없다.
    const lunchClient = lunchToken && config.lunchBot.chatChannel ? new WebClient(lunchToken) : null;
    if (turnScript && config.letter.enabled
        && config.letter.botToken && config.letter.appToken) {
      // 실장이 대화에서 「실원들에게 ○○ 전해 줘」·「○○ 안건 던져 줘」라고 한 것을 방에 올리는
      // 길. 대화(turn.py)가 `ask` 로 넘기면 실장 DM 에 확인 카드를 띄우고, 버튼·창을 거쳐야
      // 나간다. **대화만으로는 안 나간다.** 올릴 방은 창에서 고른다 — 전할 말은 general·시험 방,
      // 안건은 커피챗 방·시험 방·general. 던진 안건은 `agenda.md` 에 적어 파이썬이 매 턴 붙인다.
      const letterData = path.join(path.dirname(turnScript), 'bots', 'letter', 'data');
      const coffee = coffeeKinds(
        { general: config.letter.generalChannel, chat: config.letter.chatChannel, test: testRoom },
        { agenda: path.join(letterData, 'agenda.md') },
      );
      // 소인이 방에 걸 글(`lunch-pulse` — 주간 판단 · 실장이 시킨 것) — 점심원정대·친목 방·시험 방 · 소인 이름으로.
      const lunchKinds: Record<string, NoticeKind> = lunchClient ? {
        'lunch-pulse': {
          title: '소인이 방에 올릴 글', ask: '소인이 방에 글을 올리려 합니다.', header: '',
          hint: '소인 이름으로 나갑니다. 여기서 고칠 수 있습니다.',
          rooms: rooms(config.lunchBot.chatChannel).map((id) => ({ id, label: roomLabel('lunch', id) })),
          // 소인이 쓴 글이라 이름·멘션 빗장은 건다(카드 만들 때와 실장이 고친 뒤 둘 다) — 숫자는 모임 제안의 내용이라 둔다.
          guard: 'names', speaker: '소인', poster: lunchClient,
        },
      } : {};
      const letterNotice = new LetterNotice({
        managerUserId: config.letter.managerUserId,
        members: config.letter.members,
        kinds: { ...coffee, ...lunchKinds },
        logPath: path.join(letterData, 'notice.jsonl'),
        pendingPath: path.join(letterData, 'notice-pending.json'),
      });
      lunchAsk = letterNotice.enabled && lunchClient ? letterNotice.offer : undefined;
      // 커피콩의 주간 시계 — 주 첫 업무일 13:00 실장 DM 에 「이번 주 이렇게 할까요」. 말은 대화 봇(아래
      // ChatHost)이 만들고, 방에 걸 글은 위 확인 카드(`letterNotice.offer`)로만 간다. 호스트는 아래에서
      // 만들어지므로 늦게 묶는다.
      let letterHost: ChatHost | null = null;
      const initiative = new LetterInitiative({
        enabled: config.letter.initiative.enabled,
        at: config.letter.initiative.at,
        room: config.letter.chatChannel,
        managerUserId: config.letter.managerUserId,
        managerName: config.letter.managerName,
        python: config.chat.python,
        script: path.join(path.dirname(turnScript), 'comm_pulse.py'),
        statePath: path.join(letterData, 'initiative-state.json'),
        controlPath: path.join(letterData, 'control.json'),
        host: { initiate: (client, key, brief, name) => letterHost!.initiate(client, key, brief, name) },
        offer: letterNotice.enabled ? letterNotice.offer : undefined,
      });
      // 소인의 주간 시계 — 같은 장치를 커피콩 앱에 얹는다(실장 DM 과 카드가 이 앱으로 간다). 읽을 방은 시험 방 뺀
      // 소인의 방 · 방 이력은 소인 토큰으로 · 현황판은 `lunch_pulse.py` · 판단 턴은 소인 대화 호스트가 단발로 돈다.
      const lunchData = path.join(path.dirname(turnScript), 'bots', 'lunch', 'data');
      const lunchInitiative = new LetterInitiative({
        enabled: config.lunchBot.initiative.enabled && Boolean(lunchClient),
        at: config.lunchBot.initiative.at,
        rooms: rooms(config.lunchBot.chatChannel).filter((id) => id !== testRoom)
          .map((id) => ({ id, label: roomLabel('lunch', id) })),
        reader: lunchClient ?? undefined,
        pulseArgs: [],
        prefix: ':cow: *소인의 이번 주 제안*\n',
        managerUserId: config.letter.managerUserId,
        managerName: config.letter.managerName,
        python: config.chat.python,
        script: path.join(path.dirname(turnScript), 'lunch_pulse.py'),
        statePath: path.join(lunchData, 'initiative-state.json'),
        controlPath: path.join(lunchData, 'control.json'),
        host: {
          initiate: (client, key, brief, name) => (lunchHost
            ? lunchHost.initiate(client, key, brief, name)
            : Promise.resolve({ reply: '', error: '소인 대화 호스트가 없습니다' })),
        },
        offer: letterNotice.enabled ? letterNotice.offer : undefined,
        logger: new Logger('Lunch:initiative'),
      });
      // 1on1 신청 창구는 대화 호스트보다 먼저 만든다 — 명단 밖 DM 을 실장에게 넘길 때
      // 「1on1 신청으로 올리기」 버튼을 붙이는 것도 이 창구라서(`bypassBlocks`).
      const booking = config.letter.booking.enabled
        ? new LetterBooking({
          managerUserId: config.letter.managerUserId,
          members: config.letter.members,
          logPath: path.join(path.dirname(turnScript), 'bots', 'letter', 'data', '1on1.jsonl'),
          // 커피챗 주간 알림과 같은 이유로 파일을 나눈다 — 한쪽의 날짜 초기화가
          // 남의 칸을 지우면 안 된다.
          nudgePath: path.join(path.dirname(turnScript), 'bots', 'letter', 'data', '1on1-nudge.json'),
          open: config.letter.booking.open,
          // 확정된 1on1 은 **실장 본인만 보는 기본 캘린더**에 — 비서의 캘린더 연동을 부를 때마다
          // 찾는다(늦게 뜨거나 꺼질 수 있다). 없으면 「직접 넣어 주세요」로 알린다.
          calendar: () => {
            const poller = this.assistantScheduler?.getCalendarPoller();
            return poller
              ? {
                add: (ev) => poller.addPrivateEvent(ev),
                remove: (cal, id) => poller.removePrivateEvent(cal, id),
                setLocation: (cal, id, place) => poller.setPrivateEventLocation(cal, id, place),
              }
              : null;
          },
        })
        : null;
      letterHost = new ChatHost({
        name: 'letter',
        botToken: config.letter.botToken,
        appToken: config.letter.appToken,
        python: config.chat.python,
        script: turnScript,
        // **자리는 늘리고 연결은 안 늘린다.** 커피챗 방 ID 가 비어 있으면 DM 만 연다 —
        // 봇을 방에 초대하고 `LETTER_CHAT_CHANNEL` 을 채우는 두 가지가 다 돼야 열린다.
        surfaces: rooms(config.letter.chatChannel).length ? ['dm', 'channel'] : ['dm'],
        allowUsers: config.letter.allowUsers,
        channels: rooms(config.letter.chatChannel),
        botTalk,
        buttIn: config.letter.buttIn.enabled ? config.letter.buttIn : null,
        greetOnJoin: config.letter.greetOnJoin && !!config.letter.chatChannel,
        managerUserId: config.letter.managerUserId,
        onAsk: letterNotice.enabled ? letterNotice.offer : undefined,
        bypassBlocks: booking?.enabled ? booking.dmBlocks : undefined,
        // 칭찬 전달과 1on1 예약은 대화가 아니다 — 같은 앱에 슬래시 명령·모달로 따로 붙는다.
        // **앱은 하나뿐이다**(소켓을 두 번 열면 슬랙이 한쪽에만 보내 조용히 실패한다).
        // 그래서 둘 다 같은 앱에 얹는다.
        attach: (app) => {
          letterNotice.register(app);
          initiative.register(app);
          lunchInitiative.register(app);
          new LetterRelay({
            managerUserId: config.letter.managerUserId,
            members: config.letter.members,
            logPath: path.join(path.dirname(turnScript), 'bots', 'letter', 'data', 'relay.jsonl'),
          }).register(app);
          if (config.letter.coffeechat.enabled) {
            const dataDir = path.join(path.dirname(turnScript), 'bots', 'letter', 'data');
            new LetterCoffeechat({
              managerUserId: config.letter.managerUserId,
              members: config.letter.members,
              logPath: path.join(dataDir, 'coffeechat.jsonl'),
              // **주간 알림 기록은 파일을 나눈다** — 주인이 다른 값을 한 파일에 두면
              // 한쪽의 초기화가 남의 칸을 지운다(2026-08-07 에 그 사고를 겪었다).
              digestPath: path.join(dataDir, 'coffeechat-digest.json'),
              open: config.letter.coffeechat.open,
              digestAt: config.letter.coffeechat.digestAt,
              sendAt: config.letter.coffeechat.sendAt,
              notionDb: config.letter.coffeechat.notionDb,
              notionScript: config.letter.coffeechat.notionScript,
              notionPython: config.letter.coffeechat.notionPython,
            }).register(app);
          }
          booking?.register(app);
          // 주 첫 업무일 아침, 후보 다섯 중 하나를 고르는 버튼. **글을 만드는 일은
          // 전부 파이썬 쪽이고** 여기는 눌린 것을 넘겨 주기만 한다.
          new LetterBoost({
            managerUserId: config.letter.managerUserId,
            python: config.letter.python,
            script: path.join(path.dirname(turnScript), 'weekly_boost.py'),
            logger: this.logger,
          }).register(app);
        },
      });
      this.chatHosts.push(letterHost);
    }
    // 점심봇의 채널 대화. **버튼도 여기에 얹는다** — 커피챗과 같은 이유로, 앱 하나에
    // 소켓을 두 번 열면 슬랙이 이벤트를 한쪽에만 보낸다. 버튼이 자기 연결을 따로 열고
    // 있던 동안 부름(@멘션)의 절반쯤이 버튼 쪽으로 가서 흔적 없이 사라졌다 — 버튼은
    // 멀쩡하고 부르면 답이 없어서, 배선 문제가 아니라 봇이 삐친 것처럼 보였다.
    if (turnScript && config.lunchBot.appToken && config.lunchBot.chatChannel) {
      const token = readLunchBotToken(config.lunchBot.script);
      if (token) {
        const buttons = this.lunchButtons;
        // 좌석 기능도 이 앱에 얹는다. 소켓을 두 번 열면 슬랙이 이벤트를 한쪽에만
        // 보내고, 버튼 절반이 흔적 없이 사라진다(위 주석과 같은 이유).
        const premium = this.premiumSeat;
        lunchHost = new ChatHost({
          name: 'lunch',
          botToken: token,
          appToken: config.lunchBot.appToken,
          python: config.chat.python,
          script: turnScript,
          surfaces: ['channel'],
          // 식단 알림 방(`일용할-양식`)도 **부르면 답하는 방**으로 연다. `channels` 에
          // 없으면 부름조차 안 들리고, `quietRooms` 에만 있으면 방 자체가 안 열린다.
          channels: rooms(config.lunchBot.chatChannel)
            .concat([readLunchAnnounceChannel(config.lunchBot.script)].filter(Boolean)),
          // 다만 **먼저 끼어들지는 않는다** — 사람이 식단을 보러 오는 방이라 잡담이 끼면
          // 알림이 묻힌다. 부르면 답하고, 안 부르면 조용하다.
          quietRooms: [readLunchAnnounceChannel(config.lunchBot.script)].filter(Boolean),
          managerUserId: config.letter.managerUserId,
          botTalk,
          buttIn: config.chat.buttIn.enabled ? config.chat.buttIn : null,
          // 실장 턴에서 실은 「방에 올릴 글」 → 실장 DM 확인 카드(커피콩 앱 창구 · 「보내기」를 눌러야 소인 이름으로 나감).
          onAsk: lunchAsk,
          // **둘 중 하나라도 켜져 있으면 붙인다.** 점심 버튼 존재만 보고 정하면,
          // 버튼을 끈 날 좌석 기능이 오류도 로그도 없이 등록되지 않는다.
          attach: (buttons || premium)
            ? (app) => {
                buttons?.register(app);
                premium?.register(app);
              }
            : undefined,
        });
        this.chatHosts.push(lunchHost);
        // 대화 호스트가 버튼을 들고 가므로 자기 연결은 열지 않는다.
        this.lunchButtons = null;
      }
    }

    // Initialize system memory watchdog (Windows only)
    if (config.memoryWatchdog.enabled && process.platform === 'win32' && config.assistant.dmChannel) {
      this.memoryWatchdog = new ProcessMemoryWatchdog(
        config.memoryWatchdog.thresholdPct,
        config.memoryWatchdog.checkIntervalSec,
        config.memoryWatchdog.autoKillDelaySec,
        config.memoryWatchdog.processThresholdMB,
        async (text, blocks?) => {
          const result = await this.app.client.chat.postMessage({
            channel: config.assistant.dmChannel,
            text,
            ...(blocks ? { blocks } : {}),
          });
          return result.ts as string;
        },
        async (ts, text, blocks?) => {
          await this.app.client.chat.update({
            channel: config.assistant.dmChannel,
            ts,
            text,
            ...(blocks ? { blocks } : {}),
          });
        },
        (pid) => {
          // Clean up bot's active process if the killed PID matches
          for (const [key, proc] of this.activeProcesses) {
            if (proc.pid === pid) {
              this.activeProcesses.delete(key);
              break;
            }
          }
        },
        {
          reviewer: config.memoryWatchdog.aiReview ? (prompt) => this.reviewMemoryTarget(prompt) : undefined,
          // 자정 · 정오 파이프라인 러너의 잠금 파일 — 러너는 세션 밖에서 떨어져 돌아 계보로 못 잡는다
          pipelineLockFile: config.assistant.configDir
            ? path.join(config.assistant.configDir, '..', 'reports', 'pipeline-runs', '.lock-pipeline.json')
            : undefined,
          runawayDelaySec: config.memoryWatchdog.runawayKillDelaySec,
          aiActs: config.memoryWatchdog.aiActs,
          // 미리 띄운 세션의 메모리 문(2026-10-01) — 85% 를 넘으면 들고 있던 것을 버린다.
          onCommit: (pct) => {
            if (this.sdkHandler.memoryGate.observe(pct)) this.sdkHandler.dropAllWarm(`커밋 ${pct}%`);
          },
        },
      );
      // 띄우기 직전에 한 번 잰다 — 정기 측정(3분) 사이에 올라간 것을 놓치지 않게.
      const wd = this.memoryWatchdog;
      this.sdkHandler.memorySample = () => wd.sampleCommitPct();
    }

    // Agent SDK 판 맞춤 — 주 첫 업무일에 판을 대조해 어긋나면 DM 에 [업데이트] 버튼(2026-09-29).
    if (config.sdkUpdate.enabled && config.assistant.dmChannel) {
      const channel = config.assistant.dmChannel;
      this.sdkUpdate = new SdkUpdate({
        at: config.sdkUpdate.at,
        repoRoot: path.resolve(__dirname, '..'),
        dmChannel: channel,
        send: async (text, blocks) =>
          (await this.app.client.chat.postMessage({ channel, text, blocks })).ts as string | undefined,
        reply: async (threadTs, text) => {
          await this.app.client.chat.postMessage({ channel, thread_ts: threadTs, text });
        },
        update: async (ts, text, blocks) => {
          await this.app.client.chat.update({ channel, ts, text, blocks });
        },
      });
    }

    // 다우 세션 만료 → 로그인 버튼 (2026-09-21). 감시기와 같은 DM 채널·같은 콜백 모양.
    // 창은 이 PC 에 뜨므로 봇이 대화형 세션(session 1)에서 돌 때만 뜻이 있다 —
    // 서비스로 옮기면 버튼이 창을 못 띄운다(그때는 이 줄이 먼저 눈에 걸려야 한다).
    if (process.platform === 'win32' && config.assistant.dmChannel) {
      this.daouLogin = new DaouLoginNotifier(
        async (text, blocks?) => {
          const result = await this.app.client.chat.postMessage({
            channel: config.assistant.dmChannel,
            text,
            ...(blocks ? { blocks } : {}),
          });
          return result.ts as string;
        },
        async (ts, text, blocks?) => {
          await this.app.client.chat.update({
            channel: config.assistant.dmChannel,
            ts,
            text,
            ...(blocks ? { blocks } : {}),
          });
        },
      );
    }
  }

  private async getUserLocale(userId: string): Promise<Locale> {
    const cached = this.userLocales.get(userId);
    if (cached) return cached;
    try {
      const response = await this.app.client.users.info({ user: userId, include_locale: true });
      const slackLocale = (response.user as any)?.locale || 'en-US';
      const locale: Locale = slackLocale.startsWith('ko') ? 'ko' : 'en';
      this.userLocales.set(userId, locale);
      return locale;
    } catch {
      return 'en';
    }
  }

  /**
   * 이 봇을 쓸 수 있는 사람인가.
   *
   * 봇은 운영자 PC 의 Claude Code 세션을 그대로 내준다 — 개인 업무 목록·사내
   * 지식그래프·파일 접근이 딸려 있다. `app.message`(DM)와 `app_mention`(채널)
   * 어디에도 원래 검사가 없어, 워크스페이스의 누구든 부를 수 있었다.
   *
   * **명단이 비면 아무도 못 쓴다.** 열어두는 쪽이 기본값이면 안 되는 설정이라,
   * 설정 누락이 곧 개방이 되게 두지 않는다.
   */
  private isAllowedUser(user: string | undefined): boolean {
    return !!user && config.bot.allowUsers.includes(user);
  }

  /**
   * 처리 제안 스레드 통로 — 비서 DM 채널에 바깥 메시지 · 답글 · 고쳐 쓰기 · 링크(`ThreadApi`).
   * **던지지 않는다** — 못 하면 null · false 로 돌려줘 실행기가 예전처럼 한 통으로 보낸다.
   * 멘션은 봇을 쓰는 사람(허용 목록 첫 사람) — 봇이 연 스레드의 답글은 알림이 안 갈 수 있다.
   */
  private actionThreadApi(): ThreadApi {
    const channel = config.assistant.dmChannel;
    const client = this.app.client;
    return {
      post: async (text, blocks, threadTs) => {
        try {
          const r = await client.chat.postMessage({ channel, text, blocks: blocks as any, ...(threadTs ? { thread_ts: threadTs } : {}) });
          return r.ts ?? null;
        } catch (err) {
          this.logger.warn('처리 제안 스레드 메시지를 못 보냄', err);
          return null;
        }
      },
      update: async (ts, text, blocks) => {
        try {
          await client.chat.update({ channel, ts, text, blocks: blocks as any });
          return true;
        } catch (err) {
          // 지워졌을 때만 false — 다른 오류(한도 · 네트워크)까지 지워짐으로 보면 바깥 메시지를 새로 만들어 스레드가 갈린다
          if ((err as any)?.data?.error === 'message_not_found') return false;
          throw err;
        }
      },
      permalink: async (ts) => {
        try {
          const r = await client.chat.getPermalink({ channel, message_ts: ts });
          return r.permalink ?? null;
        } catch {
          return null;
        }
      },
      mention: config.bot.allowUsers[0],
    };
  }

  /**
   * 버튼 핸들러 등록 — 허용된 사람이 누른 것만 통과시킨다.
   *
   * 메시지 경로만 막으면 반쪽이다. 컨펌 블록이 채널에 뿌려지면 남이 그 버튼을
   * 누를 수 있고, 그중에는 도구 사용 승인처럼 세션 권한을 넓히는 것도 있다.
   * `this.app.action` 을 직접 부르지 말고 이걸 쓴다.
   *
   * 거부해도 `ack()` 은 한다 — 안 하면 슬랙이 3초 뒤 오류를 띄워 버튼이 고장난
   * 것처럼 보인다. 조용히 아무 일도 안 일어나는 쪽이 맞다.
   */
  private action(actionId: string | RegExp, fn: (args: any) => Promise<void>): void {
    this.app.action(actionId as any, async (args: any) => {
      const user = args?.body?.user?.id;
      if (!this.isAllowedUser(user)) {
        this.logger.warn('Rejected button from unauthorized user', { user, actionId });
        try { await args.ack(); } catch { /* 이미 응답됨 */ }
        return;
      }
      await fn(args);
    });
  }

  /**
   * 판에서 온 **사람 말**을 이 방의 대화로 들여보낸다.
   *
   * **해석을 여기서 하지 않는다.** 규칙(임의 등록 금지 · 제안 후 컨펌 · 원문 캡처)이
   * 이미 아래 경로에 붙어 있어서, 같은 입구로 넣으면 그것들이 그대로 걸린다.
   * 따로 세션을 띄우는 길도 있었지만 **되묻기가 끊긴다** — 답을 보고 사람이 이 방에
   * 대꾸하면 그 말은 다른 대화로 가기 때문이다.
   *
   * **스레드를 만들지 않는다.** 세션 키가 `thread_ts || 'direct'` 라, 스레드에 넣으면
   * 이 방에서 이어 가던 대화와 갈라진다.
   */
  private async askFromBoard(text: string, lead?: string, shown?: string,
                             captureId?: string): Promise<TurnOutcome> {
    const channel = config.assistant.dmChannel;
    const user = config.bot.allowUsers[0];
    if (!channel || !user) throw new Error('비서 방 또는 사용자가 설정되지 않았습니다');

    // 무엇에 대한 답인지 보이게 먼저 남긴다 — 이 줄이 없으면 답만 덩그러니 뜬다.
    // 봇이 쓴 것이라 메시지 핸들러가 되받지 않는다(`user` 가 없는 이벤트가 된다).
    //
    // **이 줄이 원문 사본이기도 하다.** 아래 `handleMessage` 는 오류를 안에서
    // 삼키고 채널에 알리므로, 세션이 넘어져도 폴러는 성공으로 안다 — 그때 사람에게
    // 남는 것은 이 줄뿐이라, 그대로 다시 보내면 복구가 된다.
    //
    // **`shown` 이 빈 문자열이면 머리 줄만 남긴다.** 판이 보내는 「메모」는 사람이
    // 쓴 글이라 그대로 보이는 것이 영수증이지만, 메일 후보처럼 **기계가 지은
    // 본문**은 세션이 읽을 것이라 통계·머리표·지시가 섞여 있다 — 그것을 채널에
    // 붙이면 같은 내용이 두 번 뜬다(2026-08-19 사용자 지적). 그때는 머리 줄이
    // 원문 사본 노릇을 대신하고, 메일은 어차피 메일함에 그대로 있다.
    const head = lead ?? `🗂 ${boardLabel()} 에서`;
    const body = shown ?? text;
    const posted = await this.app.client.chat.postMessage({
      channel,
      text: body ? `${head}\n${body}` : head,
    });

    // ⚠️ **응답을 되돌려줘야 한다.** 슬랙이 주는 `say` 는 API 응답을 돌려주고,
    // 아래 흐름은 그 `ts` 로 상태 메시지를 나중에 고쳐 쓴다. 안 돌려주면
    // `statusResult.ts` 에서 터진다 — 2026-08-12 에 첫 실사용이 그렇게 죽었다.
    //
    // **말한 대로 반영하기만 했으면 답하지 않는다** (2026-08-19 사용자 결정).
    // 판에서 한 줄 던진 사람은 그 화면을 보고 있고, 바뀐 것은 몇 초 뒤 카드에
    // 그대로 뜬다 — 같은 사실을 슬랙에 또 적으면 알림만 는다. 그래서 비서가
    // `[조용히]` 한 줄을 내면 여기서 삼킨다.
    //
    // ⚠️ **판단이 든 것은 그대로 말한다** — 해석해서 넣은 날짜, 되물을 것,
    // 못 한 것. 조용한 것이 「그대로 됐다」는 뜻이 되려면 그래야 한다.
    const say = this.pushedSay(channel);
    // `pushed` 는 **사람이 말을 건 것이 아니라는 표시**다 — 완료 줄을 남길지가
    // 여기서 갈린다(사람이 물었으면 「끝났다」이고, 안 물었으면 아무 말도 아니다).
    //
    // **결과를 돌려준다**(2026-10-14) — 드레인은 다시 막혔으면 멈추고, 메일 폴러는 표시를 안
    // 옮긴다. 결과가 비었으면(빠른 길 · 명령) 막힌 것도 터진 것도 없이 끝난 것이다.
    const outcomeSink: Partial<TurnOutcome> = {};
    await this.handleMessage(
      { type: 'message', channel, user, text, ts: String(posted.ts), pushed: true,
        captureId, outcomeSink } as unknown as MessageEvent,
      say,
    );
    return { outcome: 'ok', engine: 'claude', steps: [], writeRan: false, ...outcomeSink };
  }

  /**
   * 봇이 스스로 넘긴 차례의 `say` — 그 방에 올리되 비서가 `[조용히]` 한 줄을 내면 삼킨다.
   *
   * **말한 대로 반영하기만 했으면 답하지 않는다** (2026-08-19 사용자 결정) — 판에서 한 줄 던진
   * 사람은 그 화면을 보고 있다. 판단이 든 것(해석한 날짜 · 되물을 것 · 못 한 것)은 그대로 말한다.
   */
  private pushedSay(channel: string): (msg: any) => Promise<{ ts?: string }> {
    return async (msg: any) => {
      const text = typeof msg === 'string' ? msg : String(msg?.text ?? '');
      if (/^\s*\[조용히\]\s*$/m.test(text.split('\n')[0])) {
        this.logger.info('판에서 온 것을 조용히 처리 — 답을 안 보냅니다');
        return {};
      }
      return this.app.client.chat.postMessage(
        typeof msg === 'string' ? { channel, text: msg } : { channel, ...msg },
      );
    };
  }

  /**
   * `say` 는 **응답을 돌려줘야 한다** — 아래에서 상태 메시지의 `ts` 를 받아 나중에
   * 고쳐 쓴다. `any` 로 두었더니 응답을 안 돌려주는 가짜 `say` 가 컴파일을 통과해
   * 실행 시점에 죽었다(2026-08-12). 계약을 타입에 박아 컴파일러가 잡게 한다.
   */
  async handleMessage(event: MessageEvent, say: (msg: any) => Promise<{ ts?: string }>) {
    const { user, channel, thread_ts, ts, text, files } = event;

    if (!this.isAllowedUser(user)) {
      this.logger.warn('Rejected message from unauthorized user', { user, channel });
      // 봇이 무엇을 할 수 있는지 알리지 않는다 — 짧게 끊는다.
      await say({ text: '개인용 봇입니다.', thread_ts: thread_ts || ts });
      return;
    }

    const locale = await this.getUserLocale(user);

    // !o / !s / !h prefix — one-time model override for this single message
    if (text) {
      const prefixed = this.parseModelPrefix(text);
      if (prefixed) {
        const prevModel = this.channelModels.get(channel);
        this.channelModels.set(channel, prefixed.model);
        try {
          await this.handleMessage({ ...event, text: prefixed.prompt }, say);
        } finally {
          if (prevModel !== undefined) this.channelModels.set(channel, prevModel);
          else this.channelModels.delete(channel);
        }
        return;
      }
    }

    // Process any attached files
    let processedFiles: ProcessedFile[] = [];
    if (event.heldFiles?.length) {
      // 보관해 둔 첨부(보류 v2) — `tempPath` 를 안 달아 차례 끝의 정리가 안 지운다. 끝까지 가면
      // 드레인이 보관 폴더째 지운다(`dropHeldFiles`).
      processedFiles = event.heldFiles.filter((f) => fs.existsSync(f.path)).map((f) => ({ ...f }));
    } else if (files && files.length > 0) {
      this.logger.info('Processing uploaded files', { count: files.length });
      processedFiles = await this.fileHandler.downloadAndProcessFiles(files);

      if (processedFiles.length > 0) {
        await say({
          text: `📎 ${t('file.processing', locale, { count: processedFiles.length, names: processedFiles.map(f => f.name).join(', ') })}`,
          thread_ts: thread_ts || ts,
        });
      }
    }

    // If no text and no files, nothing to process
    if (!text && processedFiles.length === 0) return;

    this.logger.debug('Received message from Slack', {
      user,
      channel,
      thread_ts,
      ts,
      text: text ? text.substring(0, 100) + (text.length > 100 ? '...' : '') : '[no text]',
      fileCount: processedFiles.length,
    });

    // --- Command routing ---

    // Working directory commands
    const setDirPath = text ? this.workingDirManager.parseSetCommand(text) : null;
    if (setDirPath) {
      const isDM = channel.startsWith('D');
      const result = this.workingDirManager.setWorkingDirectory(channel, setDirPath, thread_ts, isDM ? user : undefined);
      if (result.success) {
        const context = thread_ts ? t('cwd.context.thread', locale) : (isDM ? t('cwd.context.dm', locale) : t('cwd.context.channel', locale));
        await say({ text: `✅ ${t('cwd.set', locale, { context, path: result.resolvedPath! })}`, thread_ts: thread_ts });
      } else {
        await say({ text: `❌ ${result.error}`, thread_ts: thread_ts });
      }
      return;
    }

    if (text && this.workingDirManager.isGetCommand(text)) {
      const isDM = channel.startsWith('D');
      const directory = this.workingDirManager.getWorkingDirectory(channel, thread_ts, isDM ? user : undefined);
      const context = thread_ts ? t('cwd.context.thread', locale) : (isDM ? t('cwd.context.dm', locale) : t('cwd.context.channel', locale));
      await say({ text: this.workingDirManager.formatDirectoryMessage(directory, context, locale), thread_ts: thread_ts });
      return;
    }

    // MCP commands
    if (text && this.isMcpInfoCommand(text)) {
      await say({ text: this.mcpManager.formatMcpInfo(locale), thread_ts: thread_ts });
      return;
    }
    if (text && this.isMcpReloadCommand(text)) {
      const reloaded = this.mcpManager.reloadConfiguration();
      await say({
        text: reloaded
          ? `✅ ${t('cmd.mcp.reloadSuccess', locale)}\n\n${this.mcpManager.formatMcpInfo(locale)}`
          : `❌ ${t('cmd.mcp.reloadFailed', locale)}`,
        thread_ts: thread_ts,
      });
      return;
    }

    // Briefing command
    if (text && this.isBriefingCommand(text)) {
      if (!this.assistantScheduler) {
        await say({ text: t('assistant.notConfigured', locale), thread_ts: thread_ts || ts });
        return;
      }
      await say({ text: t('assistant.briefingRunning', locale), thread_ts: thread_ts || ts });
      try {
        const result = await this.assistantScheduler.runBriefing();
        await say({ text: result.text, thread_ts: thread_ts || ts });
        // 올린 뒤에만 그날 자국 — 놓친 브리핑 · 회복 뒤 다시가 같은 브리핑을 또 올리지 않게.
        if (result.ok) this.assistantScheduler.markBriefingDelivered('manual', result.servedBy);
        // NAS 이동 컨펌 큐 버튼 (스케줄 브리핑 후처리와 동일)
        try {
          const nasBlocks = await buildNasQueueBlocks(await listNasQueue());
          if (nasBlocks) {
            await say({ text: '📦 NAS 이동 컨펌 대기', blocks: nasBlocks, thread_ts: thread_ts || ts });
          }
        } catch (err) {
          this.logger.warn('NAS confirm queue check failed (manual briefing)', err);
        }
        // 처리 제안 요약 (예약 · 놓친 브리핑과 같은 블록)
        const actionBlocks = await this.assistantScheduler.actionDigestBlocks().catch(() => null);
        if (actionBlocks) {
          await say({ text: '🗂 처리 제안', blocks: actionBlocks, thread_ts: thread_ts || ts });
        }
        // 매일 개선 제안 — 켜는 문(`DAILY_IMPROVE`)이 꺼져 있거나 이미 올렸으면 없음
        const improveBlocks = await this.assistantScheduler.improveForBriefing().catch(() => null);
        if (improveBlocks) {
          await say({ text: '💡 개선 제안', blocks: improveBlocks, thread_ts: thread_ts || ts });
          await this.assistantScheduler.markImprovePosted().catch(() => {});
        }
      } catch (error) {
        this.logger.error('Manual briefing failed', error);
        await say({ text: '❌ Briefing failed.', thread_ts: thread_ts || ts });
      }
      return;
    }

    // Report command
    if (text && this.isReportCommand(text)) {
      if (!this.assistantScheduler) {
        await say({ text: t('assistant.notConfigured', locale), thread_ts: thread_ts || ts });
        return;
      }
      const { type } = this.parseReportCommand(text);
      await this.handleReportCommand(type, thread_ts || ts, locale, say);
      return;
    }

    // NAS confirm command — inbox auto-classify company 분류분 결정 버튼
    if (text && this.isNasCommand(text)) {
      await this.handleNasCommand(thread_ts || ts, say);
      return;
    }

    // 처리 제안 — report-log 처리 흐름 (요약 · 지금 검토 · 지금 이어 가기)
    if (text && this.isActionsCommand(text)) {
      await this.handleActionsCommand(text, thread_ts || ts, locale, say);
      return;
    }

    // Analyze command
    if (text && this.isAnalyzeCommand(text)) {
      if (!this.assistantScheduler) {
        await say({ text: t('assistant.notConfigured', locale), thread_ts: thread_ts || ts });
        return;
      }
      const { type } = this.parseAnalyzeCommand(text);
      await say({ text: t('analysis.running', locale, { type: type || 'all' }), thread_ts: thread_ts || ts });
      try {
        const result = await this.assistantScheduler.runAnalysisManual(type);
        await say({ text: result, thread_ts: thread_ts || ts });
      } catch (error) {
        this.logger.error('Manual analysis failed', error);
        await say({ text: `❌ Analysis failed: ${(error as Error).message}`, thread_ts: thread_ts || ts });
      }
      return;
    }

    // Assistant command
    if (text && this.isAssistantCommand(text)) {
      if (!this.assistantScheduler) {
        await say({ text: t('assistant.notConfigured', locale), thread_ts: thread_ts || ts });
        return;
      }
      const parsed = this.parseAssistantCommand(text);
      if (parsed) {
        await this.handleAssistantSubcommand(parsed, thread_ts || ts, locale, say);
      }
      return;
    }

    // 엔진 상태(엔진 폴백 5단계) — 엔진마다 막힘 · 풀리는 시각 · 마지막 성공 · 사용률, 연습 중인가.
    // 버튼 없이 글만 — 고칠 것이 아니라 볼 것이다. 쓸 수 있는 사람은 위 `isAllowedUser` 가 이미 걸렀다.
    if (text && this.isEnginesCommand(text)) {
      await say({
        text: engineStatusText(engineState.load(), engineState.nowSec(), {
          fallback: dmFallbackOn(), notice: process.env.ENGINE_NOTICE === 'on', drill: readDrill(), ladder: dmLadder(),
          agy: agyRungsOn(),
        }),
        thread_ts: thread_ts,
      });
      return;
    }

    // Stop command (interrupt running CLI process)
    if (text && this.isStopCommand(text)) {
      // 차례와 같은 키로 — DM 최상위는 `direct` 다(아래 `turnThreadTs`). `thread_ts || ts` 면 영영 안 맞는다.
      const sessionKey = this.cliHandler.getSessionKey(user, channel, turnThreadTs(channel, thread_ts, ts));
      const activeProcess = this.activeProcesses.get(sessionKey);
      if (activeProcess) {
        // 사람이 끊었다는 표시 — 끊긴 차례가 다시 돌리던 것이면 그 캡처를 버린다(엔진을 안 가림 · 아래 `stoppedTurns`).
        (this.stoppedTurns ??= new WeakSet()).add(activeProcess);
        activeProcess.interrupt();
        this.activeProcesses.delete(sessionKey);
        await say({ text: `⏹️ ${t('cmd.stop.stopped', locale)}`, thread_ts: thread_ts });
      } else {
        await say({ text: `ℹ️ ${t('cmd.stop.noActive', locale)}`, thread_ts: thread_ts });
      }
      return;
    }

    // Help command
    if (text && this.isHelpCommand(text)) {
      await say({ text: getHelpTextI18n(locale), thread_ts: thread_ts });
      return;
    }

    // Reset command
    if (text && this.isResetCommand(text)) {
      this.cliHandler.removeSession(user, channel, turnThreadTs(channel, thread_ts, ts));
      this.lastQueryCosts.delete(channel);
      this.channelAlwaysApproveTools.delete(channel);
      await say({
        text: `🔄 ${t('cmd.reset.done', locale)}`,
        thread_ts: thread_ts,
      });
      return;
    }

    // Model command
    if (text) {
      const modelArg = this.parseModelCommand(text);
      if (modelArg !== null) {
        if (modelArg === '') {
          const stored = this.channelModels.get(channel);
          const current = stored
            ? `${stored} (channel)`
            : `${config.defaultModel} (${t('cmd.model.default', locale)})`;
          await say({ text: `🤖 ${t('cmd.model.current', locale, { model: current })}`, thread_ts: thread_ts });
        } else if (modelArg.toLowerCase() === 'default') {
          this.channelModels.delete(channel);
          await say({ text: `🤖 ${t('cmd.model.set', locale, { model: `${config.defaultModel} (${t('cmd.model.default', locale)})` })}`, thread_ts: thread_ts });
        } else {
          const resolved = SlackHandler.resolveModelAlias(modelArg);
          this.channelModels.set(channel, resolved);
          await say({ text: `🤖 ${t('cmd.model.set', locale, { model: resolved })}`, thread_ts: thread_ts });
        }
        return;
      }
    }


    // Permission mode commands: -default / -safe / -trust
    if (text && this.isDefaultModeCommand(text)) {
      this.channelPermissionModes.delete(channel);
      this.channelAlwaysApproveTools.delete(channel);
      await say({ text: `🔒 ${t('cmd.defaultMode', locale)}`, thread_ts: thread_ts });
      return;
    }
    if (text && this.isSafeCommand(text)) {
      this.channelPermissionModes.set(channel, 'safe');
      await say({ text: `🛡️ ${t('cmd.safeMode', locale)}`, thread_ts: thread_ts });
      return;
    }
    if (text && this.isTrustCommand(text)) {
      this.channelPermissionModes.set(channel, 'trust');
      await say({ text: `⚡ ${t('cmd.trustMode', locale)}`, thread_ts: thread_ts });
      return;
    }

    // Sessions command
    if (text && this.isSessionsCommand(text)) {
      // -sessions all → cross-project picker
      if (/^-sessions?\s+(all|전체)$/i.test(text.trim())) {
        await this.showSessionPicker(channel, thread_ts || ts, user, say, locale);
        return;
      }
      // -sessions → current cwd sessions
      const isDMForSessions = channel.startsWith('D');
      const cwdForSessions = this.workingDirManager.getWorkingDirectory(channel, thread_ts, isDMForSessions ? user : undefined);
      if (cwdForSessions) {
        const sessions = this.listSessions(cwdForSessions);
        await say({ text: this.formatSessionsList(sessions, locale), thread_ts: thread_ts });
      } else {
        await say({ text: `⚠️ ${t('cmd.sessions.noCwd', locale)}`, thread_ts: thread_ts });
      }
      return;
    }

    // Cost command
    if (text && this.isCostCommand(text)) {
      const costInfo = this.lastQueryCosts.get(channel);
      if (costInfo) {
        let msg = `💵 ${t('cmd.cost.header', locale)}\n`;
        msg += `• ${t('cmd.cost.costLine', locale, { cost: costInfo.cost.toFixed(4) })}\n`;
        msg += `• ${t('cmd.cost.durationLine', locale, { duration: (costInfo.duration / 1000).toFixed(1) })}\n`;
        msg += `• ${t('cmd.cost.modelLine', locale, { model: costInfo.model })}\n`;
        msg += `• ${t('cmd.cost.sessionLine', locale, { sessionId: costInfo.sessionId })}`;
        await say({ text: msg, thread_ts: thread_ts });
      } else {
        await say({ text: `ℹ️ ${t('cmd.cost.noData', locale)}`, thread_ts: thread_ts });
      }
      return;
    }

    // Version command
    if (text && this.isVersionCommand(text)) {
      const info = getVersionInfo();
      let msg = `${t('cmd.version.title', locale)}\n`;
      msg += `• ${t('cmd.version.version', locale, { version: info.version })}\n`;
      if (info.gitHash) {
        msg += `• ${t('cmd.version.commit', locale, { hash: info.gitHash, date: info.gitDate ?? '' })}`;
      } else {
        msg += `• ${t('cmd.version.commitUnknown', locale)}`;
      }
      await say({ text: msg, thread_ts: thread_ts });

      // Async update check — send follow-up message
      checkForUpdates().then(async (result) => {
        let updateMsg: string;
        if (result && result.behindBy === 0) {
          updateMsg = t('cmd.version.upToDate', locale);
        } else if (result && result.behindBy > 0) {
          updateMsg = t('cmd.version.updateAvailable', locale, { count: result.behindBy, hash: result.latestHash });
        } else {
          updateMsg = t('cmd.version.checkFailed', locale);
        }
        try {
          await say({ text: updateMsg, thread_ts: thread_ts });
        } catch (err) {
          this.logger.error('Failed to send update check result', err);
        }
      }).catch(() => {
        // Silently ignore
      });
      return;
    }

    // Resume/continue command
    const resumeParsed = text ? this.parseResumeCommand(text) : null;

    // Session picker: -r or -resume (no args) — works without cwd
    if (resumeParsed?.mode === 'picker') {
      await this.showSessionPicker(channel, thread_ts || ts, user, say, locale);
      return;
    }

    // Plan command: -plan <prompt>
    const planParsed = text ? this.parsePlanCommand(text) : null;

    // --- Working directory check ---
    const isDM = channel.startsWith('D');
    const workingDirectory = this.workingDirManager.getWorkingDirectory(channel, thread_ts, isDM ? user : undefined);

    if (!workingDirectory) {
      let errorMessage = `⚠️ ${t('cwd.noCwd', locale)}`;
      if (!isDM && !this.workingDirManager.hasChannelWorkingDirectory(channel)) {
        errorMessage += `${t('cwd.noCwd.channel', locale)}\n`;
        if (config.baseDirectory) {
          errorMessage += t('cwd.noCwd.relativeHint', locale, { baseDir: config.baseDirectory });
        } else {
          errorMessage += t('cwd.noCwd.absoluteHint', locale);
        }
      } else if (thread_ts) {
        errorMessage += t('cwd.noCwd.thread', locale);
      } else {
        errorMessage += t('cwd.noCwd.generic', locale);
      }
      await say({ text: errorMessage, thread_ts: thread_ts || ts });
      return;
    }

    // --- Main query execution ---
    //
    // **DM 은 스레드를 만들지 않는다** (2026-08-06). 개인 비서는 오가며 한 줄씩
    // 던지는 곳이라 답이 댓글로 접히면 매번 펼쳐야 한다. 채널에서는 반대다 —
    // 다른 사람이 있는 방이라 스레드가 소음을 막는다.
    //
    // 이 값 하나가 **답 위치와 대화 단위를 같이 정한다.** 세션 키가
    // `threadTs || 'direct'` 라(cli-handler), DM 최상위에서 undefined 를 넘기면
    // `direct` 로 고정돼 DM 전체가 한 대화가 된다. `thread_ts || ts` 를 그대로
    // 두면 메시지마다 ts 가 달라 매번 새 세션이 되고, 직전에 한 말을 기억 못 한다.
    // (24 시간 놀면 정리되고, 끊고 싶으면 `-clear`.)
    const replyTs = turnThreadTs(channel, thread_ts, ts);
    const sessionKey = this.cliHandler.getSessionKey(user, channel, replyTs);
    // 이건 답 위치가 아니라 **사용자 원본 메시지**다 — 반응(이모지)을 다는 대상이라
    // 언제나 실제 메시지 ts 여야 한다.
    const originalMessageTs = thread_ts || ts;

    // --- 「체크인」 한 마디 (DM · 사람이 직접 보낸 것만) ---
    //
    // 세션을 태우면 스킬을 거쳐 같은 출력이 나오지만 18초·$0.5 다. 판단이 하나도
    // 없는 요청이라 그 값을 치를 이유가 없다 — tasks.py 가 0.7 초에 끝낸다.
    // **문구가 딱 이것뿐일 때만** 잡는다. 「체크인 어떻게 하지?」 같은 질문은
    // 세션이 받아야 한다.
    if (isDM && isWorkAssistantEnabled() &&
      /^(체크인|checkin|check-?in|중간\s*점검)\s*(해줘|해주세요|하자|좀)?[.!]?$/i.test((text || '').trim())) {
      await say({ text: await checkinNow(), thread_ts: replyTs });
      if (event.outcomeSink) event.outcomeSink.outcome = 'ok';   // 처리했다(다시 돌리는 쪽이 닫는다)
      return;
    }

    // --- 빠른 갱신 경로 (DM · 사람이 직접 보낸 것만) ---
    //
    // 「1 완료 · 2 1h」 같은 짧은 갱신은 **세션을 띄우지 않는다.** 갱신 한 번이
    // 세션 한 번(18초·$0.5)이면 아무도 갱신하지 않고, 갱신이 없으면 이 시스템은
    // 사람이 무슨 일을 했는지 영영 모른다(2026-08-06 실측: 실사용 4일 · 진행중
    // 1건 · 실제 소요 0건).
    //
    // 문법 판정은 tasks.py 가 한다 — 문법이 아니면 rc 2 로 나오고 아래 평소
    // 경로로 그대로 흘러간다. **틀려도 잃는 것이 없다.**
    if (isDM && text?.trim() && isWorkAssistantEnabled()) {
      const quick = await quickUpdate(text);
      if (quick.kind === 'ok') {
        await this.app.client.reactions.add({
          channel, timestamp: originalMessageTs, name: 'white_check_mark',
        }).catch(() => { });
        await say({ text: quick.output, thread_ts: replyTs });
        // 반영까지 끝났다 — 다시 돌리는 쪽이 「못 함」으로 읽고 또 돌리면 같은 갱신이 두 번 들어간다.
        if (event.outcomeSink) event.outcomeSink.outcome = 'ok';
        return;  // 캡처하지 않는다 — 이미 등록까지 끝났다
      }
      if (quick.kind === 'failed') {
        // 문법은 맞는데 쓰기가 깨졌다. 세션으로 넘기면 같은 갱신을 두 번 쓸 수
        // 있으므로(앞 항목은 이미 반영됐을 수 있다) 여기서 멈추고 원문만 남긴다.
        captureToInbox(text, 'slack', thread_ts);
        await say({
          text: `⚠️ 갱신이 깨졌습니다 — ${quick.message}\n` +
            '원문은 캡처해 뒀습니다. 어디까지 반영됐는지 확인이 필요합니다.',
          thread_ts: replyTs,
        });
        return;
      }
    }

    // 첫 접촉에 걸던 「어제 진행 체크인」은 2026-08-26 에 걷었다 — 「칸반에서
    // 항목 보고 업데이트 요청하는 것이 훨씬 자연스럽고 편해졌다 · 복잡한 건만
    // 스탠리와 이야기하게 됨」(사용자). 말을 걸자마자 질문이 붙는 것이 바로
    // 그 「복잡한 건」 앞을 막고 있었다. 아침에 한 번 묻는 것은 08:55 넛지에
    // 남아 있고, 부르면 나오는 「체크인」도 그대로다.

    // **원문을 먼저 저장한다 — 아래 문에서 기다리기 전에, 세션을 띄우기 전에.** 순서가 규칙이다(work-assistant
    // CLAUDE.md): 저장(결정론) → 해석(세션) → 닫기. 파이썬도 노션도 안 거치고 JSONL 에 직접 붙이므로, 노션이
    // 막혀도 세션이 재시작에 죽어도 원문은 남는다. 세션에 맡겼더니 안 했다(2026-08-06: 캡처 0건) — 그래서 봇이 한다.
    // 문(`holdGate`) · 대체 차례에서 15분까지 기다릴 수 있다 — 그 뒤에 저장하면 그사이 재시작에 말이 사라진다.
    // 다시 돌리는 길이면 **원래 캡처를 쓴다** — 새로 붙이면 큐가 안 줄어든다. 메시지 하나에 캡처 하나.
    // 받은 대화방 · 메시지도 같이 적는다 — 밀린 것을 **받은 자리에서** 다시 돌린다(보류 v2).
    const capture = event.captureId
      ? { id: event.captureId }
      : (text?.trim() ? captureToInbox(text, 'slack', thread_ts, { channel, msgTs: ts }) : null);
    // **차례를 띄우기 전까지도 처리 중 기록을 둔다**(2026-10-15 검토) — 원문만 있고 기록도 실패 표시도 없으면, 문에서
    // 기다리다 재시작에 끊긴 말은 드레인 목록에 안 든다(실패 표시가 있는 것만 다시 돈다). 차례가 뜨면 아래에서 지운다.
    const waitRec = !event.replay && capture?.id ? waitKey(capture.id) : '';
    if (waitRec) {
      const m = readInflight();
      m[waitRec] = { channel, threadTs: replyTs, text: (text || '').slice(0, 160), startedAt: new Date().toISOString(),
        captureId: capture!.id, state: 'waiting' };
      writeInflight(m);
    }

    // **밀린 것을 다시 돌리는 중이면 이 방의 새 차례는 기다린다**(보류 v2 · `holdGate`). 아래에서
    // 같은 대화의 앞 차례를 끊는데, 다시 돌리는 차례가 끊기면 반쯤 쓴 채로 남는다. 문은 보류 v2
    // 드레인만 잡으므로 꺼져 있으면 지나간다. 기다리는 동안 ⏳ 를 달아 받았다는 것만 보인다.
    if (!event.replay && this.holdGate.isHeld(channel)) {
      const isHuman = !(event as any).pushed;
      if (isHuman) {
        await this.app.client.reactions.add({ channel, timestamp: originalMessageTs, name: 'hourglass_flowing_sand' })
          .catch(() => { });
      }
      const waited = await this.holdGate.wait(channel);
      this.logger.info('밀린 것을 다시 돌리는 동안 기다렸습니다', { channel, waited });
      if (isHuman) {
        await this.app.client.reactions.remove({ channel, timestamp: originalMessageTs, name: 'hourglass_flowing_sand' })
          .catch(() => { });
      }
    }

    // **GPT 대체 차례는 끊지 않는다**(DM 폴백) — 새 차례는 대개 위 문에서 기다리고, 문을 안 기다리는
    // 차례(다시 돌리기)가 겹치면 여기서 끝나기를 기다린다. 끊으면 쓰기를 하다 만 채로 남는다.
    const fallbackRun = this.fallbackRuns.get(sessionKey);
    if (fallbackRun) await fallbackRun;

    this.originalMessages.set(sessionKey, { channel, ts: originalMessageTs });

    // Cancel any existing CLI process for this conversation
    const existingProcess = this.activeProcesses.get(sessionKey);
    if (existingProcess) {
      this.logger.debug('Cancelling existing CLI process for session', { sessionKey });
      existingProcess.interrupt();
    }

    let session = this.cliHandler.getSession(user, channel, replyTs);
    const isNewSession = !session;
    if (!session) {
      session = this.cliHandler.createSession(user, channel, replyTs);
    }

    // Determine prompt
    const resumeData = (resumeParsed && 'resumeOptions' in resumeParsed) ? resumeParsed : null;
    const basePrompt = planParsed
      ? planParsed.prompt
      : resumeData
        ? (resumeData.prompt || t('misc.continuePrompt', locale))
        : (text || '');
    const finalPrompt = processedFiles.length > 0
      ? await this.fileHandler.formatFilePrompt(processedFiles, basePrompt)
      : basePrompt;
    // **세션이 못 본 대화방 글을 사람 말 앞에 붙인다** (2026-10-13 · `dm-context.ts`).
    // 스레드 댓글은 빈 새 세션이 떠서 댓글을 단 글을 모르고, 넛지·좁은 길의 ❓ 처럼
    // 세션 밖에서 나간 글은 세션 기록에 없다 — 짧은 답이 엉뚱하게 읽힌 까닭이 그 둘이었다.
    // 봇이 스스로 넘긴 차례(`pushed`)는 사람 말이 아니라 안 붙인다. 슬랙 왕복이라 아래
    // 준비와 같이 돌게 여기서 걸어 두고, 세션을 띄우기 직전에 받는다.
    //
    // **Claude 가 막힌 동안 다른 엔진이 받은 것이 있으면**(DM 폴백 장부) 돌아온 첫 차례가 판 · 메일이
    // 민 것이어도 붙인다 — 안 붙이면 그 차례가 세션 시각을 밀어 사람의 다음 차례도 그 글을 못 받는다.
    const served = isDM && !isNewSession ? ledgerServedSince(channel, session.lastActivity.getTime() / 1000) : 0;
    const attachUnseen = (isDM && !(event as any).pushed) || (isDM && served > 0 && !event.replay);
    const unseenPending: Promise<string> =
      (attachUnseen && !planParsed && !resumeData)
        ? this.getBotUserId().then((botUserId) => readUnseen(this.app.client as any, channel, {
            currentTs: ts,
            threadTs: thread_ts,
            isNewSession,
            sinceSec: isNewSession ? undefined : session!.lastActivity.getTime() / 1000,
            botUserId,
            isPrivate: containsPrivate,
          })).catch(() => '')
        : Promise.resolve('');

    // Determine permission mode
    const isPlanMode = !!planParsed;
    // 기본이 'auto' — 터미널 세션(~/.claude/settings.json 의 defaultMode)과 같은
    // 규칙으로 돈다. 'default' 는 Bash 를 아예 안 줘서 업무 등록조차 못 했다.
    const botPermLevel = this.channelPermissionModes.get(channel) || 'auto';

    // Build allowed tools list for CLI --allowedTools
    const allowedTools = this.buildAllowedTools(channel, botPermLevel, sessionKey);

    let currentMessages: string[] = [];
    let statusMessageTs: string | undefined;
    let rateLimitInfo: { retryAfterSec: number; resetsAt: number; rateLimitType: string } | null = null;
    let rateLimitMessageText: string | undefined;
    let lastStatusText = '';
    let statusRepeatCount = 0;
    const toolUsageCounts = new Map<string, number>();
    const channelModel = SlackHandler.resolveModelAlias(this.channelModels.get(channel) || config.defaultModel);
    let cliError = false;
    // **띄우기 전 준비가 얼마나 먹나** (2026-08-29). 판 한 건 23.1초 중 이 구간이
    // 1.12초인데(75건 중앙값) **안에 로그가 하나도 없어 무엇이 도는지 몰랐다.**
    // 줄일 값이 있는지는 재 봐야 안다 — 짐작으로 손대지 않는다.
    // 미리 띄우기는 차례가 **끝난 뒤**에 하므로, 그때 쓸 옵션을 여기 들어 둔다.
    let sdkOptsForWarm: SdkRunOptions | null = null;
    // **`try` 밖에 둔다** — 차례가 터졌을 때 `catch` 에서도 캡처에 표시를 남겨야
    // 한다. 안에 두면 그 자리에서 안 보여, 정작 실패한 차례가 자국을 못 남긴다.
    const captureId = capture?.id ?? '';
    const spawnT0 = Date.now();
    const lap: Record<string, number> = {};
    const mark = (k: string) => { lap[k] = Date.now() - spawnT0; };
    // **뒤처리 1.8초 안에도 로그가 하나도 없다** (2026-08-31). 결과를 받은 뒤
    // 세션 색인 등록까지가 그 구간인데, 그 사이에 슬랙 왕복 하나와 스트림이
    // 닫히기를 기다리는 대목이 섞여 있어 **무엇이 먹는지 못 갈랐다.**
    // 위 `mark` 와 같은 방식으로 잰다 — 짐작으로 손대지 않는다.
    let tailT0 = 0;
    const tail: Record<string, number> = {};
    const tmark = (k: string) => { if (tailT0) tail[k] = Date.now() - tailT0; };
    // **차례가 어떻게 끝났나 · 무엇을 돌렸나**(보류 v2 · `turn-outcome.ts`). 부른 쪽(드레인 · 메일
    // 폴러)이 `outcomeSink` 로 받는다. 실패 표시도 여기서 기다릴 수 있게 들어 둔다 — 부른 쪽이
    // 그 캡처를 곧바로 버리면(메일 폴러) 늦게 온 표시가 버린 것을 다시 「끊긴 채 닫힘」으로 만든다.
    const stepLog = new StepLog();
    let turnBlock: Block | null = null;
    let turnThrew = false;
    let markDone: Promise<void> | null = null;
    // 일하다 끊긴 차례를 같은 세션으로 이어 갔으면, 끝나고 이 대화의 세션을 원래대로 돌린다 —
    // 안 돌리면 이 방의 다음 차례가 옛 세션을 이어받아 그 사이의 대화를 잃는다.
    const restoreSession = event.resumeSessionId
      ? { sessionId: session.sessionId, uuid: session.lastAssistantUuid } : null;
    // **DM 폴백**(엔진 폴백 5단계 · `DM_FALLBACK=on`) — Claude 가 막히면 이 차례를 GPT 가 이어 받는다.
    // 넘겨도 되는 차례인지는 `engine-ladder.ts` 가 정한다. 개인 글 검사는 넘길 일이 생겼을 때 한 번만
    // 돌린다(긴 첨부에서 느리다). 꺼져 있으면 `fbOn()` 이 늘 거짓이라 예전 그대로 돈다.
    const origin: DmOrigin = !isDM ? 'channel' : event.replay ? 'replay' : (event as any).pushed ? 'pushed' : 'dm';
    const fbBase = dmFallbackOn() && fallbackEligible({
      origin, planMode: isPlanMode, resumeCmd: !!resumeData, isPrivate: false,
      cwdIsWorkAssistant: this.isWorkAssistantDir(workingDirectory),
    });
    let fbPrivate: boolean | undefined;
    const isPrivateTurn = (): boolean =>
      (fbPrivate ??= containsPrivate([finalPrompt, event.replayNote ?? ''].join('\n')));
    const fbOn = (): boolean => fbBase && !isPrivateTurn();
    /** 띄우기 전에 Claude 를 건너뛰었나(엔진 상태가 막혔다고 함) — 그러면 아래 스트림이 비어 있다. */
    let claudeSkipped = false;
    /** 이 차례의 손잡이 — 터졌을 때(`catch`) 사람이 끊은 것인지 가른다. */
    let turnHandle: TurnHandle | null = null;
    /** 거절 이벤트 · 한도/과부하 표시 메시지를 봤나 — 넘길 차례면 그 뒤의 Claude 글(한도 글)을 안 올린다. */
    let limitSeen = false;
    /** 폴백이 끝을 맡았나(답 · 실패 표시 · 한도 안내) — 그러면 아래 예전 한도 길은 건너뛴다. */
    let fallbackDone = false;
    let turnEngine: Engine = 'claude';
    let fallbackSteps: TurnStep[] = [];
    let fallbackWrote = false;
    /** 고르는 함수에 넘길 것 — 막힘은 부를 때마다 새로 읽는다(codex 한도 조회 포함). */
    const pickInput = async (o: Pick<PickInput, 'claudeOutcome' | 'writeRan'> = {}): Promise<PickInput> => ({
      origin, planMode: isPlanMode, resumeCmd: !!resumeData, hasFiles: processedFiles.length > 0,
      needsFull: !!event.needsFull, isPrivate: isPrivateTurn(), cwdIsWorkAssistant: this.isWorkAssistantDir(workingDirectory),
      blocked: await this.ladderBlocked(), ...o,
    });

    try {
      this.logger.info('Spawning Claude CLI process', {
        prompt: finalPrompt.substring(0, 200) + (finalPrompt.length > 200 ? '...' : ''),
        sessionId: session.sessionId,
        workingDirectory,
        permissionMode: isPlanMode ? 'plan' : botPermLevel,
        fileCount: processedFiles.length,
      });

      // **번호표를 먼저 걸어 둔다** — 파이썬을 한 번 띄우는 일이라 0.17초 걸리는데,
      // 그동안 아래의 토큰 동기화·조회가 어차피 돈다. 쓰는 곳은 저 아래
      // `surfaceNote` 한 곳뿐이라 거기서 받으면 된다.
      const slotMapPending: Promise<string> = isDM ? checkinMap() : Promise.resolve('');

      const statusEmoji = isPlanMode ? '📝' : '🤔';
      const statusText = isPlanMode ? t('status.planning', locale) : t('status.thinking', locale);
      // **보내 놓고 기다리지 않는다** (2026-08-31). 이 `ts` 를 처음 쓰는 곳은 스트림
      // 안(첫 도구 호출)이라 세션이 뜨는 3.7초 뒤다. 기다리면 슬랙 왕복 0.30초가
      // 그대로 차례 앞에 붙는다. **띄운 직후에 한 번 받아 둔다** — 거기서 기다리는
      // 것은 공짜다(어차피 첫 SDK 메시지를 기다리는 중이다).
      //
      // ⚠️ 실패하면 `statusMessageTs` 가 빈 채로 남는다. 쓰는 곳이 전부
      // `if (statusMessageTs)` 로 막혀 있어 조용히 건너뛴다 — 상태 한 줄 때문에
      // 차례를 죽이는 것보다 낫다(전에는 여기서 터지면 차례가 통째로 죽었다).
      const statusSent = say({ text: `${statusEmoji} ${statusText}`, thread_ts: replyTs })
        .then((r) => { statusMessageTs = r?.ts; })
        .catch(() => { /* 상태 한 줄은 장식 */ });
      mark('생각중 표시');

      // Add anchor reaction first to prevent line jumping when progress reactions change
      await this.addAnchorReaction(sessionKey);
      await this.updateMessageReaction(sessionKey, statusEmoji);
      mark('반응 달기');

      // Show command hint on first message in a new thread
      const threadKey = `${channel}:${replyTs}`;
      if (isNewSession && !this.hintShownThreads.has(threadKey)) {
        this.hintShownThreads.add(threadKey);
        await this.app.client.chat.postMessage({
          channel,
          thread_ts: replyTs,
          text: t('hint.threadStart', locale),
          blocks: [
            { type: 'context', elements: [{ type: 'mrkdwn', text: t('hint.threadStart', locale) }] },
          ],
        }).catch(() => {});
      }

      // Sync tokens from terminal CLI before spawning (terminal→bot), then inject the OAuth token
      this.accountManager.syncFromCredentialsFile();
      let queryEnv: Record<string, string> | undefined;
      const oauthToken = await this.accountManager.getAccessToken();
      if (oauthToken) {
        queryEnv = { CLAUDE_CODE_OAUTH_TOKEN: oauthToken };
      }

      // 일하다 끊긴 차례를 이어 가는 길(보류 v2)이면 그 세션을 잇는다 — 처음부터 다시 하면 같은
      // 쓰기가 두 번 들어간다. 이미 한 것은 `replayNote` 가 세션 앞에 적어 넘긴다.
      const resumeSessionId = resumeData?.mode === 'uuid'
        ? resumeData.resumeOptions.resumeSessionId : (event.resumeSessionId || undefined);
      const continueLastSession = resumeData?.mode === 'continue' ? true : undefined;

      const runOpts = {
        session,
        workingDirectory,
        resumeSessionId,
        continueLastSession,
        model: channelModel,
        permissionMode: isPlanMode ? 'plan' as const : botPermLevel,
        allowedTools,
        env: queryEnv,
        // 엔진 연습(`.engine-drill.json`)은 대화 차례에만 — 예약 일은 `scope: all` 일 때만 받는다.
        drillScope: 'interactive' as const,
      };
      // 원문 캡처는 위에서 했다(문에서 기다리기 전) — 여기서 다시 붙이지 않는다.
      // 체크인이 화면에 떠 있는데 답이 짧은 문법에 안 맞아 여기까지 왔다면,
      // **번호의 뜻을 같이 넘긴다.** 안 넘기면 세션이 추측하고, 업무 ID 와 숫자가
      // 겹쳐 그럴듯하게 틀린다(2026-08-06: 「3번 논의 완료」가 TSK-10 이 아니라
      // TSK-3 에 붙었다). 세션이 할 일은 번역 하나로 좁히고 쓰기는 quick 이 한다.
      // 위에서 미리 걸어 둔 것을 여기서 받는다 — 그동안 토큰 동기화가 돌았다.
      const slotMap = await slotMapPending;
      mark('체크인 번호표');
      const unseen = await unseenPending;
      mark('못 본 글');
      // 로그에는 글을 안 남긴다 — 몇 줄을 붙였는지만.
      if (unseen) this.logger.info('세션이 못 본 대화방 글을 붙임', { lines: unseen.split('\n').filter((l) => l.startsWith('- ')).length });
      // **Claude 가 막힌 동안 다른 엔진이 받은 것이 있으면 한 줄 알린다**(DM 폴백 · 위 `served`) — 내용은
      // 「못 본 대화방 글」이 싣는다. 세션이 마지막으로 돈 뒤의 장부만 세므로 돌아온 첫 차례에만 붙는다.
      // 다시 돌리는 차례면 그 메모(받은 시각 · 그 뒤의 글 · 이미 한 것)를 맨 앞에 — 보류 v2.
      const sessionPrompt = [event.replayNote, ledgerNote(served), unseen, finalPrompt].filter(Boolean).join('\n');
      const surfaceNote = [
        SLACK_SURFACE_NOTE,
        capture ? CAPTURE_NOTE : '',
        slotMap,
      ].filter(Boolean).join('\n');
      // **캡처 id 를 세션에 넘긴다.** 닫는 규칙을 세션에 맡겼더니 안 닫혔다
      // (2026-08-06: 업무 등록·로그·상호 링크까지 다 해 놓고 닫기만 빠져 두 건이
      // 큐에 남았다). 이제 tasks.py 의 쓰기 명령이 성공하면 스스로 닫는다 —
      // 세션이 기억해야 할 일이 하나 줄고, 큐는 「정말 처리 안 된 것」만 남는다.
      //
      // ⚠️ **값이 아니라 파일 경로를 넘긴다** (2026-08-31). 값을 `env` 에 박으면
      // 프로세스를 띄울 때 굳어 **미리 띄운 세션을 다음 차례에 못 쓴다.** 경로는
      // 방마다 하나로 고정이고, 그 안의 id 만 차례마다 갈아 끼운다.
      writeCapturePointer(channel, capture?.id ?? '');
      const sessionEnv = { ...(queryEnv ?? {}), WORK_ASSISTANT_CAPTURE_FILE: capturePointer(channel) };

      // skills: 'all' surfaces ~/.claude/skills/ to the model so it can invoke
      // domain skills (notion-publish, mycelium, bbapi, …) by name. SDK headless
      // mode does not auto-configure skills.
      //
      // **사고 깊이를 내린다.** 안 넘기면 기본값 `'high'` 가 걸려 도구를 부르기도
      // 전에 20 초를 생각한다(2026-08-05 실측: "업무" 한 마디에 44 초 중 20.5 초).
      // 모델을 내리는 것보다 여기를 먼저 조이는 이유는 잃는 것이 다르기 때문이다 —
      // 등록 해석(추정·중요도·마감)의 품질은 오래 생각해서가 아니라 모델이 맥락을
      // 아는 데서 나오고, 그 해석은 어차피 사용자 컨펌을 거친다.
      const sdkOpts: SdkRunOptions = {
        ...runOpts, env: sessionEnv, skills: 'all', effort: INTERACTIVE_EFFORT,
        appendSystemPrompt: surfaceNote,
        settings: { autoCompactWindow: INTERACTIVE_COMPACT_WINDOW },
      };
      // 차례가 끝나면 이 옵션 그대로 하나 띄워 둔다 — 아래 `finally` 에서 쓴다.
      sdkOptsForWarm = sdkOpts;
      // **띄우기 전 준비의 구간별 값.** 합이 23.1초 중 1.12초라 큰 몫은 아니지만,
      // 안에 로그가 없어 **무엇이 도는지조차 몰랐다**(2026-08-29). 재고 나서 정한다.
      mark('옵션 짓기');
      this.logger.info('띄우기 전 준비', { ms: lap });
      // **DM 폴백 — 띄우기 전**: 엔진 상태가 Claude 가 막혔다고 하면 안 띄운다(띄워도 한도 글만 받는다).
      // 다음 칸(GPT)이 비었으면 스트림 뒤에서 그리로 넘기고, 다 막혔으면 예전 한도 길로 모아 둔다.
      let pick: LadderPick = 'claude';
      if (engineState.isBlocked('claude') && fbOn()) {
        pick = pickEngine(await pickInput(), dmLadder());
        claudeSkipped = pick !== 'claude';
        if (claudeSkipped) this.logger.warn('Claude 가 막혀 있어 띄우지 않습니다(DM 폴백)', { next: pick });
      }
      const cliProcess: AsyncIterable<CliEvent> & TurnHandle = claudeSkipped
        ? skippedTurn()
        : this.sdkHandler.runQuery(sessionPrompt, sdkOpts);

      this.logger.info('Interactive session started', { via: claudeSkipped ? 'skipped' : 'sdk' });
      // 여기서 상태 한 줄의 `ts` 를 받는다 — 세션이 뜨기를 기다리는 중이라 공짜다.
      // 아래 스트림이 그 `ts` 로 상태를 고쳐 쓰므로 들어가기 전에 받아 둔다.
      await statusSent;
      this.activeProcesses.set(sessionKey, cliProcess);
      turnHandle = cliProcess;
      { const m = readInflight(); m[sessionKey] = { channel, threadTs: replyTs, text: (text || '').slice(0, 160), startedAt: new Date().toISOString(), captureId,
        ...(event.heldSteps?.length ? { heldSteps: event.heldSteps } : {}),
        ...(processedFiles.length ? { files: processedFiles.map(heldFileOf) } : {}) };
        // 기다리던 기록은 이 차례의 기록으로 넘어간다(같은 캡처 · 같은 파일 쓰기 한 번).
        if (waitRec) delete m[waitRec];
        writeInflight(m); }

      for await (const event of cliProcess) {
        // **돈 도구를 적는다**(보류 v2) — 새 도구가 시작할 때만 처리 중 기록을 고쳐 쓴다(도구 하나에
        // 한 번). 재시작으로 끊기면 기동이 이것으로 「쓰기가 돌았나」를 가른다.
        if (stepLog.see(event)) {
          patchInflight(sessionKey, { steps: stepLog.steps, sessionId: session?.sessionId });
        }
        // Session init tracking
        if (event.type === 'system' && (event as any).subtype === 'init') {
          const initEvent = event as any;
          if (session) {
            session.sessionId = initEvent.session_id;
            this.cliHandler.scheduleSave();
            this.logger.info('Session initialized', {
              sessionId: initEvent.session_id,
              model: initEvent.model,
              tools: initEvent.tools?.length || 0,
              // 이 세션이 칸반 아티팩트를 스스로 다시 올릴 수 있는지. SDK 타입에는
              // Artifact 도구가 있지만 실제로 붙는지는 세션마다 확인해야 안다 —
              // 「못 한다」고 문서에 적어 뒀던 것이 근거 없는 단정이었다(2026-08-06).
              hasArtifact: Array.isArray(initEvent.tools)
                ? initEvent.tools.includes('Artifact') : null,
            });
          }
          continue;
        }

        // Stream events: show current tool in status
        if (event.type === 'stream_event') {
          const streamEvent = (event as CliEvent & { event: any }).event;
          if (streamEvent?.type === 'content_block_start' && streamEvent.content_block?.type === 'tool_use') {
            const toolName = streamEvent.content_block.name;
            toolUsageCounts.set(toolName, (toolUsageCounts.get(toolName) || 0) + 1);
            const toolEmoji = this.getToolReactionEmoji(toolName);
            if (statusMessageTs) {
              const newStatusText = `${toolEmoji} ${t('status.usingTool', locale, { toolName })}`;
              if (newStatusText === lastStatusText) {
                statusRepeatCount++;
                this.queueStatus(sessionKey, channel, statusMessageTs,
                  `${toolEmoji} ${t('status.usingToolCount', locale, { toolName, count: statusRepeatCount })}`);
              } else {
                lastStatusText = newStatusText;
                statusRepeatCount = 1;
                this.queueStatus(sessionKey, channel, statusMessageTs, newStatusText);
              }
            }
            await this.updateMessageReaction(sessionKey, toolEmoji);
          }
          continue;
        }

        // Rate limit event from CLI
        // SDKRateLimitInfo.status: 'allowed' | 'allowed_warning' | 'rejected'
        // Only 'rejected' means the request is actually blocked. 'allowed_warning' is a
        // heads-up that the user is approaching a limit but the request still succeeded.
        if (event.type === 'rate_limit_event') {
          const rlEvent = event as CliRateLimitEvent;
          const info = rlEvent.rate_limit_info;
          this.logger.debug('Rate limit event from CLI', {
            status: info.status,
            rateLimitType: info.rateLimitType,
            resetsAt: info.resetsAt,
            overageStatus: info.overageStatus,
          });
          if (info.status === 'rejected' && info.resetsAt) {
            const retryAfterSec = Math.max(60, info.resetsAt - Math.floor(Date.now() / 1000));
            rateLimitInfo = { retryAfterSec, resetsAt: info.resetsAt, rateLimitType: info.rateLimitType ?? 'unknown' };
          }
          // 시각이 없어도 거절은 거절이다 — DM 폴백이 이 뒤의 Claude 글을 안 올리고 넘긴다.
          if (info.status === 'rejected') limitSeen = true;
          continue;
        }

        if (event.type === 'assistant') {
          const assistantEvent = event as CliAssistantEvent;
          // API 오류를 대신 전하는 메시지(SDK `error` 칸) — 한도 · 과부하면 거절 이벤트와 같게 본다.
          const apiError = (assistantEvent as any).error;
          if (apiError === 'rate_limit' || apiError === 'overloaded') limitSeen = true;

          // Track last assistant message UUID for session continuity
          if (assistantEvent.uuid && session) {
            session.lastAssistantUuid = assistantEvent.uuid;
            this.cliHandler.scheduleSave();
          }

          const contentParts = assistantEvent.message.content || [];
          const hasToolUse = contentParts.some((part: any) => part.type === 'tool_use');

          this.logger.debug('Assistant message received', {
            hasToolUse,
            partTypes: contentParts.map((p: any) => p.type),
            textPreview: contentParts.filter((p: any) => p.type === 'text').map((p: any) => p.text?.substring(0, 80)),
          });

          if (hasToolUse) {
            const todoTool = contentParts.find((part: any) =>
              part.type === 'tool_use' && part.name === 'TodoWrite'
            );
            if (todoTool) {
              await this.handleTodoUpdate(todoTool.input, sessionKey, session?.sessionId, channel, replyTs, say, locale);
            }

            // **DM 에서는 도구 실행을 보여주지 않는다** (2026-08-06). 여기는 클로드
            // 코드 세션 화면이 아니라 비서와 주고받는 대화창이다 — 무슨 명령을
            // 돌렸는지는 받는 사람이 할 일이 없는 정보라, 답만 남기는 쪽이 깔끔하다.
            // 채널은 그대로 둔다: 여럿이 보는 곳에서는 무엇을 만졌는지가 기록이 된다.
            const toolContent = isDM ? '' : this.formatToolUse(contentParts, locale);
            if (toolContent) {
              await say({ text: toolContent, thread_ts: replyTs });
            }
          } else {
            const content = this.extractTextFromContent(contentParts);
            if (content && limitSeen) {
              // **막힌 뒤의 Claude 글(「You've hit your limit…」)은 안 올린다** — 넘길 차례면 이어 받는 엔진이
              // 답하고, 못 넘기는 차례(개인 글 · 채널 · 계획 · 다른 디렉터리 · 폴백 꺼짐)는 아래 한도 안내(한 번만)가
              // 알린다. 판정은 이벤트(거절 · API 오류 칸)로만 한다 — 보통 글은 낱말로 안 훑는다(아래 NOTE).
              this.logger.info('막힌 뒤의 Claude 글을 올리지 않습니다');
            } else if (content) {
              // NOTE: Do NOT check isRateLimitText on assistant text content here.
              // It causes false positives when Claude mentions "rate limit" in normal conversation.
              // Rate limits are reliably detected via rate_limit_event (line ~524) and result.is_error (line ~616).
              currentMessages.push(content);
              if (statusMessageTs) {
                const newStatusText = `✍️ ${t('status.writing', locale)}`;
                if (newStatusText !== lastStatusText) {
                  lastStatusText = newStatusText;
                  statusRepeatCount = 1;
                  this.queueStatus(sessionKey, channel, statusMessageTs, newStatusText);
                }
              }
              await this.updateMessageReaction(sessionKey, '✍️');
              await say({ text: this.formatMessage(content, false), thread_ts: replyTs });
            }
          }
        } else if (event.type === 'result') {
          const resultEvent = event as CliResultEvent;
          tailT0 = Date.now();
          this.logger.info('Received result from CLI', {
            subtype: resultEvent.subtype,
            totalCost: resultEvent.total_cost_usd,
            duration: resultEvent.duration_ms,
            isError: resultEvent.is_error,
            denials: resultEvent.permission_denials?.length || 0,
            denialDetails: JSON.stringify(resultEvent.permission_denials),
          });

          // Store cost info
          if (resultEvent.total_cost_usd !== undefined && session?.sessionId) {
            this.lastQueryCosts.set(channel, {
              cost: resultEvent.total_cost_usd,
              duration: resultEvent.duration_ms || 0,
              model: channelModel || 'default',
              sessionId: session.sessionId,
            });
          }

          // Handle permission denials — show approval buttons (skip in plan mode)
          const denials = resultEvent.permission_denials || [];
          if (!isPlanMode && denials.length > 0 && (resultEvent.session_id || session?.sessionId)) {
            const sid = resultEvent.session_id || session?.sessionId || '';
            await this.showPermissionDenialButtons(
              channel, replyTs, user,
              denials, sid, say, locale
            );
          }

          // Track error state
          if (resultEvent.is_error) {
            cliError = true;
            // Handle rate limit from result
            if (!rateLimitInfo) {
              const resultText = resultEvent.result || '';
              if (this.isRateLimitText(resultText)) {
                rateLimitMessageText = resultText;
              }
            }
          }

          // 막힌 차례의 결과 글(한도 글 그대로)도 안 올린다 — 위 어시스턴트 글과 같은 까닭. 글로 읽는 것은
          // 오류 결과뿐이다(`rateLimitMessageText` 는 `is_error` 일 때만 선다).
          const limited = limitSeen || !!rateLimitMessageText;
          if (resultEvent.subtype === 'success' && resultEvent.result && !limited) {
            if (!currentMessages.includes(resultEvent.result)) {
              await say({ text: this.formatMessage(resultEvent.result, true), thread_ts: replyTs });
              tmark('마지막 글');
            }
          }
          tmark('결과 처리');
        }
      }
      tmark('스트림 닫힘');

      // **사람이 `-stop` 으로 끊은 다시 돌리기는 버린다 — Claude 가 돌던 것도**(2026-10-15 검토). GPT · agy 칸은 이미
      // 그랬다. 남기면 옛 실패 표시가 그대로라 다음 드레인이 끊은 요청을 또 돌린다. 끊은 차례는 다음 칸으로도 안 넘긴다.
      const claudeStopped = this.stoppedTurns?.has(cliProcess) ?? false;
      if (claudeStopped && event.replay && captureId) {
        await dropCapture(captureId, '다시 돌리던 것을 사람이 끊음');
        dropHeldFiles(captureId);
      }

      // **DM 폴백 — Claude 가 끝난 뒤**(엔진 폴백 5단계): 한도 · 과부하로 막혔거나 띄우기 전에 건너뛰었으면
      // 다음 칸으로 넘긴다. 쓰기가 돌았어도 넘긴다 — 「이미 한 것」을 같이 준다. 다 막혔으면(`hold`)
      // 아래 예전 한도 길이 실패 표시와 안내를 맡는다. Claude 의 보통 오류는 안 넘긴다(예전 오류 길).
      const claudeLimited = !!(rateLimitInfo || rateLimitMessageText || limitSeen);
      if ((claudeSkipped || claudeLimited) && fbOn() && !claudeStopped) {
        const claudeBlock = currentClaudeBlock(rateLimitInfo?.resetsAt, rateLimitMessageText);
        const ladder = dmLadder();
        if (!claudeSkipped) {
          pick = pickEngine(await pickInput({
            claudeOutcome: claudeBlock.kind === 'overload' ? 'overload' : 'limited', writeRan: stepLog.writeRan,
          }), ladder);
        }
        if (pick === 'codex' || isAgyRung(pick)) {
          // **같은 방은 한 줄로 — 사다리 전체를 한 번 잡는다**(칸을 옮기는 사이에 새 차례가 끼어들지 않게).
          // 새 차례는 문에서 기다리고 이 차례를 끊지 않는다. 다시 돌리는 차례는 드레인이 이미 문을 잡았다.
          const release = event.replay ? () => { /* 드레인이 잡은 문 */ } : await this.holdGate.acquire(channel);
          let finish!: () => void;
          this.fallbackRuns.set(sessionKey, new Promise<void>((r) => { finish = r; }));
          try {
            // 칸이 못 하면 그다음 칸으로(6단계 · `pickAfter`) — 마지막 칸이 못 하면 그 칸이 모아 둔다.
            const nextAfter = async (failed: Engine) => pickAfter(await pickInput(), failed, ladder);
            let prior: TurnStep[] = stepLog.steps;
            while (pick === 'codex' || isAgyRung(pick)) {
              const rung: Engine = pick;
              const common = {
                event, channel, sessionKey, replyTs, ts, thread_ts, captureId, surfaceNote, slotMap, finalPrompt,
                files: processedFiles, claudeSteps: prior, claudeModel: channelModel, block: claudeBlock,
                sessionId: session?.sessionId, locale, say, nextAfter,
                status: (s: string) => { if (statusMessageTs) this.queueStatus(sessionKey, channel, statusMessageTs, s); },
              };
              const fb: FallbackResult = isAgyRung(rung)
                ? await this.runAgyFallback({ ...common, rung, ladder })
                : await this.runDmFallback(common);
              fallbackDone = true;
              fallbackSteps = [...fallbackSteps, ...fb.steps];
              fallbackWrote = fallbackWrote || fb.writeRan;
              if (fb.result === 'next' && fb.next) {
                // 이 칸이 돌린 것(GPT 명령)은 다음 칸에 「이미 한 것」으로 넘긴다.
                prior = [...prior, ...fb.steps];
                pick = fb.next;
                continue;
              }
              if (fb.result === 'ok' || fb.result === 'held') {
                turnEngine = rung;
                cliError = false;
                // 「Claude·GPT 몫」이 남았으면 모아 두었다 — 결과는 막힘(드레인이 멈추고 회복 때 다시).
                if (fb.result === 'held') {
                  turnBlock = claudeBlock;
                  markDone = fb.markDone ?? null;
                }
              } else {
                cliError = true;
                if (fb.result === 'failed') {
                  // 개인 글이라 모아 둔 것은 막힘이 아니다 — 드레인이 이 건에서 멈추지 않고 뒤의 건을 본다.
                  if (!fb.privateHold) turnBlock = claudeBlock;
                  markDone = fb.markDone ?? null;
                }
                // **사람이 끊은 다시 돌리기는 버린다** — 옛 실패 표시가 남으면 다음 드레인이 또 돌리는데, 끊기 전에
                // 대체 칸이 돌린 명령은 「이미 한 것」에 없어 같은 쓰기가 두 번 들어간다. 끊은 것은 사람이 고른 것이다.
                if (fb.result === 'stopped' && event.replay && captureId) {
                  await dropCapture(captureId, '다시 돌리던 것을 사람이 끊음');
                  dropHeldFiles(captureId);
                }
              }
              break;
            }
          } finally {
            this.fallbackRuns.delete(sessionKey);
            finish();
            release();
          }
        } else {
          // 다 막혔다 — 아래 예전 한도 길이 모아 둔다(띄우기 전에 건너뛰었어도 ❌ 로 끝을 보인다).
          cliError = true;
          appendLedger({ channel, engine: 'none', model: '', captureId, outcome: 'hold' });
        }
        // 맡는 엔진이 바뀌었으면 안내 한 줄(켜는 문 `ENGINE_NOTICE` · 막힘이 바뀔 때도 저절로 돈다).
        void this.engineNotice.check();
      }

      // Update session activity timestamp and flush to disk
      // Claude 를 건너뛰었거나 다른 엔진이 끝을 맡은 차례는 안 고친다 — Claude 세션이 못 본 이 차례의 글(대체
      // 엔진의 답)을 다음 차례가 「못 본 글」 · 장부 한 줄로 받는다. 고치면 그 창이 대체 답 뒤에서 시작한다.
      if (session && !claudeSkipped && !fallbackDone) {
        session.lastActivity = new Date();
        this.cliHandler.saveNow();
        tmark('세션 저장');
      }

      // Completed
      const doneEmoji = cliError ? '❌' : isPlanMode ? '📋' : '✅';
      const doneLabel = cliError ? t('status.errorOccurred', locale) : isPlanMode ? t('status.planReady', locale) : t('status.taskCompleted', locale);
      // 완료 줄의 도구 목록도 DM 에서는 뗀다 — "작업 완료 (Read, Bash ×2)" 의
      // 괄호는 대화창에서 읽는 사람이 쓸 데가 없다. 완료 표시 자체는 남긴다.
      const toolSummary = (!isDM && toolUsageCounts.size > 0)
        ? ' (' + Array.from(toolUsageCounts.entries()).map(([name, count]) => count > 1 ? `${name} ×${count}` : name).join(', ') + ')'
        : '';
      if (statusMessageTs) {
        // **봇이 스스로 띄운 세션은 「작업 완료」를 안 남긴다** (2026-08-19 사용자 결정).
        // 사람이 물어본 것이면 그 줄이 「받았고 끝났다」를 알리지만, 판에서 누른 것과
        // 메일 후보는 사람이 말을 건 적이 없어 **아무것도 안 알리는 줄**이 된다.
        //
        // ⚠️ **오류일 때는 남긴다** — ❌ 는 이 줄에만 뜬다. 지우면 세션이 넘어진
        // 사실이 채널 어디에도 안 남는다.
        //
        // **DM 에서는 사람이 물은 것도 안 남긴다** (2026-09-18). 「✅ 작업 완료」 다음
        // 줄이 「무엇을 가리키는지 확실치 않습니다」(09/15 16:09)처럼 되물음이면 그
        // 줄은 거짓이고, 「받았고 끝났다」는 원본 메시지의 반응 이모지가 이미 말한다.
        // 채널은 그대로 — 다른 사람이 보는 방에서는 끝난 표가 스레드 밖에서 읽힌다.
        const pushed = Boolean((event as any).pushed);
        // **여기서도 기다리지 않는다** (2026-08-31). 상태 한 줄을 지우거나 고치는
        // 것은 슬랙 왕복인데, 그 결과를 읽는 곳이 없고 뒤에 오는 것은 판 반영이다.
        // 기다리면 **카드가 늦게 바뀐다** — 사람이 보는 것은 그 카드다.
        //
        // ⚠️ **스트림 안의 고치기와 같은 줄에 세운다** — 따로 두면 이 「지우기」가
        // 아직 안 나간 「고치기」를 앞질러, 지운 메시지를 고치려 드는 순서가 나온다.
        this.queueStatus(sessionKey, channel, statusMessageTs,
          `${doneEmoji} ${doneLabel}${toolSummary}`,
          (pushed || (isDM && !isPlanMode)) && !cliError);
      }
      await this.updateMessageReaction(sessionKey, doneEmoji);
      await this.removeAnchorReaction(sessionKey);
      tmark('완료 표시');
      if (tailT0) this.logger.info('뒤처리', { ms: tail });

      // Register session in sessions-index.json for CLI compatibility
      if (session?.sessionId && workingDirectory && !claudeSkipped) {
        this.sessionScanner.registerSession({
          sessionId: session.sessionId,
          projectPath: workingDirectory,
          firstPrompt: basePrompt.substring(0, 100),
        });
      }

      // If plan mode, offer Execute button
      if (isPlanMode && session?.sessionId) {
        const planId = `plan-${Date.now()}`;
        this.pendingPlans.set(planId, {
          sessionId: session.sessionId,
          prompt: basePrompt,
          channel,
          threadTs: replyTs,
          user,
        });
        setTimeout(() => this.pendingPlans.delete(planId), 30 * 60 * 1000);

        await say({
          thread_ts: replyTs,
          text: `📋 ${t('plan.complete', locale)}`,
          blocks: [
            { type: 'section', text: { type: 'mrkdwn', text: `📋 ${t('plan.readyExecute', locale)}` } },
            {
              type: 'actions',
              elements: [
                {
                  type: 'button',
                  text: { type: 'plain_text', text: t('plan.execute', locale) },
                  action_id: 'execute_plan',
                  value: planId,
                  style: 'primary',
                },
                {
                  type: 'button',
                  text: { type: 'plain_text', text: t('plan.cancel', locale) },
                  action_id: 'cancel_plan',
                  value: planId,
                },
              ],
            },
          ],
        });
      }

      // Handle rate limit (from rate_limit_event or error text)
      // DM 폴백이 끝을 맡았으면 건너뛴다 · 다 막혔으면(띄우기 전에 건너뜀 · 시각 없는 거절) 여기서 모아 둔다.
      // 거절을 봤으면 넘기지 않는 차례도 여기로 온다 — 위에서 한도 글을 안 올렸으니 안내가 대신 말한다.
      if (!fallbackDone && !claudeStopped && (rateLimitInfo || rateLimitMessageText || limitSeen || claudeSkipped)) {
        // **캡처에 남긴다 — 이유를 안 가리는 그 자국이다.** 아래 한도 큐는
        // 이유별 장치라 실제로 어긋났다(08/24 의 서버 과부하를 5시간짜리 한도로
        // 잡아 이레를 들고 있었다). 정본은 캡처 큐 한 곳으로 간다.
        // 보류 v2 면 쓰기가 돈 뒤였는지(`partial`) · 세션 · 이미 한 것 · 첨부까지 같이 적는다.
        markDone = this.markTurnFailed(captureId, 'limit', stepLog, session?.sessionId, event, processedFiles);
        // **언제 다시 할지는 엔진 상태가 정한다** — 사용량 소진은 서버가 준 시각, 과부하는 10분부터.
        // 전에는 시각을 못 읽으면 5시간으로 잡아 529 한 번에 큐를 다섯 시간 세웠다.
        const block = currentClaudeBlock(rateLimitInfo?.resetsAt, rateLimitMessageText);
        turnBlock = block;

        await this.handleRateLimitUI(channel, thread_ts || ts, finalPrompt, block, locale, say, ts, captureId);
      }

      // Clean up temp files
      if (processedFiles.length > 0) {
        await this.fileHandler.cleanupTempFiles(processedFiles);
      }
    } catch (error: any) {
      this.logger.error('Error handling message', error);

      if (statusMessageTs) {
        this.queueStatus(sessionKey, channel, statusMessageTs, `❌ ${t('status.errorOccurred', locale)}`);
      }
      await this.updateMessageReaction(sessionKey, '❌');
      await this.removeAnchorReaction(sessionKey);

      // Rate limit detection from error
      // 스트림에서 본 한도 글이면 Claude 의 것이 확실하다. 던진 오류는 슬랙 같은 남의 실패일 수 있어
      // Claude 한도·과부하 글로 읽힐 때만 막힘으로 적는다(`thrownClaudeBlock`).
      const block = rateLimitMessageText
        ? currentClaudeBlock(rateLimitInfo?.resetsAt, rateLimitMessageText)
        : this.isRateLimitError(error) ? thrownClaudeBlock(error) : null;
      turnBlock = block;
      turnThrew = true;

      // **터진 것도 같은 자국을 남긴다.** 한도인지 아닌지는 재시도 *시점*만
      // 가르고, 「처리 못 했다」는 사실은 둘이 같다. 단 사람이 끊어 터진 다시 돌리기는 버린다(위 `claudeStopped`).
      if (turnHandle && this.stoppedTurns?.has(turnHandle) && event.replay && captureId) {
        await dropCapture(captureId, '다시 돌리던 것을 사람이 끊음');
        dropHeldFiles(captureId);
      } else {
        markDone = this.markTurnFailed(captureId, block ? 'limit' : 'error', stepLog, session?.sessionId,
          event, processedFiles);
      }

      if (block) {
        await this.handleRateLimitUI(channel, thread_ts || ts, finalPrompt, block, locale, say, ts, captureId);
      } else {
        await say({ text: t('error.generic', locale, { message: error.message || t('error.somethingWrong', locale) }), thread_ts: thread_ts || ts });
      }

      if (processedFiles.length > 0) {
        await this.fileHandler.cleanupTempFiles(processedFiles);
      }
    } finally {
      this.activeProcesses.delete(sessionKey);
      { const m = readInflight(); delete m[sessionKey]; if (waitRec) delete m[waitRec]; writeInflight(m); }
      // **차례가 끝나면 캡처 가리킴을 비운다.** 안 비우면 다음 쓰기가 앞 차례의
      // 캡처를 닫는다 — 파이썬의 30분 시한은 봇이 죽었을 때의 안전망이지
      // 평소에 기대는 길이 아니다.
      writeCapturePointer(channel, '');

      // 같은 세션으로 이어 갔으면 이 대화의 세션을 원래대로 돌린다(보류 v2 · 위 `restoreSession`).
      if (restoreSession?.sessionId && session && session.sessionId !== restoreSession.sessionId) {
        session.sessionId = restoreSession.sessionId;
        session.lastAssistantUuid = restoreSession.uuid;
        this.cliHandler.saveNow();
      }

      // **결과를 부른 쪽에 돌려준다**(보류 v2 · `turn-outcome.ts`). 실패 표시가 끝나기를 기다린 뒤에
      // 돌려준다 — 부른 쪽이 곧바로 그 캡처를 버리거나 다시 집을 수 있다.
      if (event.outcomeSink) {
        Object.assign(event.outcomeSink, {
          outcome: outcomeFrom(turnBlock, cliError || turnThrew),
          engine: turnEngine,
          steps: [...stepLog.steps, ...fallbackSteps],
          writeRan: stepLog.writeRan || fallbackWrote || (event.heldSteps?.length ?? 0) > 0,
          sessionId: session?.sessionId,
          captureId,
        } satisfies TurnOutcome);
        if (markDone) await markDone.catch(() => { });
      }

      // **다음 차례를 미리 띄워 둔다** — 방금 쓴 것과 **한 글자도 안 고친** 옵션으로.
      // 판에서 오는 말처럼 모양이 같은 것이 이어질 때 그대로 맞는다(부팅 2.7~3.4초).
      //
      // ⛔ **옛 코드는 여기서 세션을 떼고 띄웠다**(`session`·`resumeSessionId`·
      // `continueLastSession` 을 전부 `undefined` 로). 그러면 **실제 차례와 영영
      // 안 맞는다** — 실제 차례는 늘 이 방의 대화를 이어받기 때문이다. 08-29 에
      // 「세션 id 는 원인이 아니다」로 적은 것은 **실제 차례 둘을 견준 것**이라
      // 절반만 맞았다. 캡처 id 도 원인이었지만 이쪽이 더 앞이었다.
      //
      // ⚠️ **떼야 안전한 것이 아니다 — 지문이 막는다.** 다른 방은 작업 디렉터리도
      // 캡처 파일 경로도 세션 id 도 달라 지문이 안 맞고, 안 맞으면 안 쓴다.
      // 떼는 것은 안전을 더하지 않고 장치만 무력화했다.
      //
      // ⚠️ **터져도 아무 일이 없어야 한다** — 빠르게 하는 장치이지 반영의 일부가
      // 아니다. `prewarm` 이 통째로 `try` 로 감싸여 있다.
      // 옛 세션을 이어 간 차례(보류 v2) 뒤에는 안 띄운다 — 다음 차례는 원래 세션이라 지문이 안 맞는다.
      // Claude 가 막혀 GPT 가 받은 차례(DM 폴백) 뒤에도 안 띄운다 — 다음 차례도 Claude 를 건너뛰어 그냥 남는다.
      if (sdkOptsForWarm && !event.resumeSessionId && !claudeSkipped && !fallbackDone) {
        this.sdkHandler.prewarm(sdkOptsForWarm);
      }

      if (session?.sessionId) {
        setTimeout(() => {
          this.todoManager.cleanupSession(session.sessionId!);
          this.todoMessages.delete(sessionKey);
          this.originalMessages.delete(sessionKey);
          this.currentReactions.delete(sessionKey);
          // 줄에 선 반응은 진작 다 나갔다(5분). 안 지우면 세션마다 약속이 하나씩 쌓인다.
          this.slackChain.delete(sessionKey);
        }, 5 * 60 * 1000);
      }
    }
  }

  // --- Build allowed tools list for CLI ---

  private buildAllowedTools(channel: string, permLevel: 'default' | 'safe' | 'trust' | 'auto', sessionKey?: string): string[] {
    if (permLevel === 'trust') return []; // --dangerously-skip-permissions used instead
    // auto 는 목록을 넘기지 않는다 — 넘기면 그 목록으로 좁혀져 분류기와
    // 설정(settingSources)의 허용 규칙이 무력해진다.
    if (permLevel === 'auto') return [];

    // Read-only tools (always allowed)
    const tools = [
      'Read', 'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch',
      'Task', 'TaskOutput', 'TodoRead', 'TodoWrite', 'NotebookRead',
      'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode',
      'Skill', 'TaskStop', 'EnterWorktree',
    ];

    // Safe mode: add edit tools
    if (permLevel === 'safe') {
      tools.push('Edit', 'MultiEdit', 'Write', 'NotebookEdit');
    }

    // Channel-specific always-approved tools
    const alwaysApproved = this.channelAlwaysApproveTools.get(channel);
    if (alwaysApproved) {
      for (const tool of alwaysApproved) {
        if (!tools.includes(tool)) tools.push(tool);
      }
    }

    // One-time approved tools (consumed after use)
    if (sessionKey) {
      const oneTime = this.pendingOneTimeTools.get(sessionKey);
      if (oneTime) {
        for (const tool of oneTime) {
          if (!tools.includes(tool)) tools.push(tool);
        }
        this.pendingOneTimeTools.delete(sessionKey);
      }
    }

    // MCP tools (mcp__ prefix pattern)
    const mcpTools = this.mcpManager.getDefaultAllowedTools();
    tools.push(...mcpTools);

    return tools;
  }

  // --- Permission denial UI (CLI mode) ---

  private async showPermissionDenialButtons(
    channel: string, threadTs: string | undefined, user: string,
    denials: Array<{ tool_name: string; tool_use_id: string; tool_input?: any }>,
    sessionId: string, say: any, locale: Locale
  ): Promise<void> {
    // Deduplicate tools
    const uniqueTools = [...new Set(denials.map(d => d.tool_name))];
    const denialId = `denial-${Date.now()}`;

    this.pendingDenials.set(denialId, {
      sessionId, deniedTools: uniqueTools,
      channel, threadTs, user,
    });
    setTimeout(() => this.pendingDenials.delete(denialId), 10 * 60 * 1000);

    const toolList = uniqueTools.map(tl => `\`${tl}\``).join(', ');
    const elements: any[] = [
      // Per-tool "Allow" buttons (max 3)
      ...uniqueTools.slice(0, 3).map(tool => ({
        type: 'button',
        text: { type: 'plain_text', text: t('permission.allowTool', locale, { toolName: tool }) },
        action_id: `allow_denied_tool_${tool}`,
        value: JSON.stringify({ denialId, tool }),
      })),
      // "Allow All & Resume" button
      {
        type: 'button',
        text: { type: 'plain_text', text: t('permission.allowAllAndResume', locale) },
        action_id: 'allow_all_denied_tools',
        value: JSON.stringify({ denialId }),
        style: 'primary',
      },
    ];

    await say({
      thread_ts: threadTs,
      text: t('permission.denied', locale, { tools: toolList }),
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: `🔐 ${t('permission.denied', locale, { tools: toolList })}` } },
        { type: 'actions', elements },
      ],
    });
  }

  // --- Rate limit UI helper ---

  private async handleRateLimitUI(
    channel: string, threadTs: string,
    prompt: string, block: Block, locale: Locale, say: any,
    messageTs?: string, captureId?: string
  ): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const postAt = block.until ?? now + 60;
    const retryAfterSec = Math.max(60, postAt - now);
    const retryTimeStr = formatTime(new Date(postAt * 1000), locale);

    // **원문은 캡처 큐가 든다** — 이유를 안 가리고 쌓이며 처리되면 스스로 닫힌다
    // (`markCaptureFailed` 가 이미 자국을 남겼다). 여기서 또 목록을 들면 두
    // 목록이 어긋난다 — 2026-08/24 의 서버 과부하를 5시간짜리 한도로 잡아
    // 이레를 들고 있던 것이 그 어긋남이었다. 풀리는 시각은 엔진 상태가 들고,
    // 회복 타이머는 그 상태가 바뀔 때 스스로 다시 걸린다(`engine-recovery.ts`).

    // 두 번째부터는 같은 안내를 올리지 않는다 — 한도가 걸린 동안 보낸 메시지마다
    // 버튼 뭉치가 하나씩 쌓이면 그 자체가 도배다. 회복 시각에 한 번에 보여 준다.
    // **「이미 올렸나」는 엔진 상태에 적는다** — 막힘 하나(갈래 · 다시 볼 시각)마다 한 번이고,
    // 재시작해도 남는다. 전에는 메모리 깃발이었는데 아무도 세우지 않아 매번 안내가 나갔다.
    //
    // **대신 ✋ 를 붙인다.** 아무 신호도 안 주면 이미 달린 ❌ 만 남아 실패로 읽히고,
    // 실패로 읽힌 요청은 사람이 다시 보낸다 — 그러면 같은 것이 두 번 처리된다.
    // 열쇠는 **막힘이 시작된 시각**이다 — 풀리는 시각으로 잡으면 과부하가 이어질 때마다(10 → 20 → 40분)
    // 시각이 늘어 안내가 다시 나갔다. 같은 구간이면 한 번 · 풀렸다 다시 막히면 그때 한 번.
    if (!engineState.noticeOnce(`claude:${block.kind}:${block.since}`)) {
      this.logger.info('한도 안내는 이미 올렸습니다 — 손만 듭니다');
      if (messageTs) {
        await this.app.client.reactions.add({ channel, timestamp: messageTs, name: 'raised_hand' })
          .catch(() => { /* 이미 달렸거나 지워진 메시지 */ });
      }
      return;
    }

    const promptPreview = prompt.length > 200
      ? prompt.substring(0, 200) + '...'
      : prompt;

    // 버튼은 「취소」 하나다. 계정 전환 · API 키 전환 버튼은 2026-10-14 사용자 결정으로 걷었다 —
    // 회복 시각에 드레인이 캡처를 다시 돌린다(보류 재실행).
    // **「자동 재실행」 버튼을 두지 않는다.** 큐가 회복 시각에 이미 묻는데 이 버튼도
    // 자기 타이머를 걸어서, 누르면 같은 프롬프트가 두 번 돈다. 두 번 도는 것이
    // 조회면 낭비로 끝나지만 등록·상태 변경이면 노션에 두 벌이 들어간다.
    const buttons: any[] = [
      { type: 'button', text: { type: 'plain_text', text: t('rateLimit.cancel', locale) }, action_id: 'cancel_retry', value: JSON.stringify({ captureId }) },
    ];

    // 과부하는 한도가 아니다 — 같은 「한도에 도달」로 쓰면 사람이 사용량을 다 쓴 줄 안다.
    const head = t(block.kind === 'overload' ? 'rateLimit.overloaded' : 'rateLimit.reached', locale);
    const eta = t('rateLimit.retryEstimate', locale, { time: retryTimeStr, minutes: Math.round(retryAfterSec / 60) });
    await say({
      thread_ts: threadTs,
      text: `⏳ ${head} ${eta}`,
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: `⏳ ${head}\n${eta}` } },
        { type: 'context', elements: [{ type: 'mrkdwn', text: t('rateLimit.prompt', locale, { prompt: promptPreview }) }] },
        { type: 'actions', elements: buttons },
      ],
    });
  }

  // --- 한도에 막혀 밀린 요청 ---

  /**
   * 엔진 감시를 켠다 — **기동 드레인 뒤에** 부른다.
   *
   * 회복 타이머를 파일에서 다시 걸고(재시작이 메모리 타이머를 지운다 — 전에는 다시 거는 곳이
   * 없어 회복 시각이 와도 아무도 안 깨웠다) 엔진 안내가 막힘 변화를 듣게 한다.
   */
  private startEngineWatch(): void {
    this.engineRecovery.init();
    this.engineNotice.init();
  }

  /**
   * 처리 못 하고 밀린 것을 **한 건씩 순서대로** 다시 돌린다.
   *
   * **묶어서 한 프롬프트로 안 보낸다.** 캡처 id 는 차례마다 하나라
   * (`WORK_ASSISTANT_CAPTURE_FILE` 에 id 하나), N건을 묶으면 세션이 다
   * 처리해도 **닫히는 것은 하나**다 — 나머지는 열린 채 남아 다음 드레인이 또
   * 집고, 큐가 영영 안 줄어든다.
   *
   * **이유를 안 가린다** — 한도든 서버 장애든 재시작이든 「정상 종료 못 했다」
   * 하나로 온다(파이썬 `drain_list`). 무엇을 돌릴지 정하는 규칙도 거기 있다.
   *
   * ⚠️ **겹쳐 돌지 않게 막는다** — 기동과 회복 시각이 겹칠 수 있고, 겹치면
   * 같은 캡처를 두 세션이 동시에 처리한다.
   */
  private draining = false;
  /** 돌고 있는 보류 v2 드레인 — [실행] 버튼이 끝나기를 기다린다. */
  private drainRun: Promise<void> | null = null;

  private async drainStuck(why: string): Promise<void> {
    if (this.draining || !isWorkAssistantEnabled()) return;
    // 보류 v2(`HOLD_V2=on`) — 받은 자리에서 · 다시 막히면 멈춤 · 일하다 끊긴 것은 이어 감(`hold-replay.ts`).
    if (holdV2On()) return this.drainStuckV2(why);
    // **아직 안 풀렸으면 안 돈다.** 기동 드레인이 한도에 곧바로 다시 부딪히면
    // 아무것도 못 하면서 **시도 횟수만 태운다** — 상한이 3회라 두 번 재시작하면
    // 사람 손으로 넘어간다.
    if (stillBlocked()) {
      this.logger.info('아직 한도가 안 풀려 다시 돌리지 않습니다', { why });
      return;
    }
    this.draining = true;
    try {
      // 이어 가야 하는 것(보류 v2 로 적힌 세션)은 옛 드레인이 안 집는다 — 처음부터 돌리면 같은
      // 쓰기가 두 번 들어간다. `HOLD_V2` 를 다시 켜면 그쪽이 이어 간다.
      // 「이미 한 것」만 적힌 것(세션 없이 GPT · agy 가 쓰다 끊김)도 옛 드레인은 안 집는다 — 그 메모 없이 돌리면 두 번 쓴다.
      const all = await pendingCaptures(DRAIN_MAX);
      const items = all.filter((it) => !it.session_id && !it.done_steps?.length);
      if (items.length < all.length) {
        this.logger.warn('이어 가야 하는 밀린 것은 보류 v2 가 켜져야 돕니다', { count: all.length - items.length });
      }
      if (!items.length) return;
      this.logger.warn('밀린 것을 다시 돌립니다', { count: items.length, why });
      for (const [i, it] of items.entries()) {
        // **넘기기 전에 센다** — 뒤에 세면 그 차례가 또 터졌을 때 못 세고,
        // 그러면 같은 것을 끝없이 다시 돌린다.
        await markCaptureTried(it.id);
        try {
          // **`askFromBoard` 를 그대로 쓴다** — 방·사용자·`[조용히]` 삼키기·
          // `pushed` 표시가 전부 거기 있다. 여기서 다시 짜면 규칙이 두 곳으로
          // 갈라지고, 갈라진 쪽이 조용히 낡는다.
          const out = await this.askFromBoard(
            it.text,
            `↻ 밀렸던 것 (${i + 1}/${items.length} · ${it.tries + 1}번째 시도)`,
            '', it.id);
          // **다시 막히면 그 자리에서 멈춘다**(2026-10-14 · 켜는 문과 무관한 고침). 전에는 결과를
          // 몰라 다음 것을 집었고, 막힌 동안 건마다 시도 횟수만 탔다. 남은 것은 회복 때 다시 돈다.
          if (isHeldOutcome(out)) {
            this.logger.warn('다시 막혀 밀린 것 돌리기를 멈춥니다', { id: it.id, left: items.length - i - 1 });
            break;
          }
        } catch (err) {
          // 한 건이 터져도 나머지는 간다 — 여기서 멈추면 뒤가 통째로 밀린다.
          this.logger.error('밀린 것을 다시 돌리다 터졌습니다', { id: it.id, err });
        }
      }
    } finally {
      this.draining = false;
    }
  }

  /**
   * 보류 v2 드레인 — 순서와 멈추는 조건은 `drainHeld`(`hold-replay.ts`), 여기는 슬랙 · 파이썬을 잇는다.
   *
   * - 막혀 있으면 아무것도 안 한다(시도도 안 셈) · 막힌 뒤 된 적이 없으면 작은 호출로 먼저 떠 봄
   * - 오래된 것부터 받은 자리에서 · 도는 동안 그 방의 새 차례는 기다림 · 다시 막히면 멈춤
   * - 끝까지 간 것은 실패 자국 · 보관 첨부를 걷음 · 한 건 이상 돌았으면 한 줄 요약
   * - **DM 폴백이 켜져 있으면 사다리의 어느 칸이든 비면 돈다**(6단계) — 다시 돌린 차례는 대화 처리기가 골라
   *   맡긴다. 떠 보기는 Claude 가 맡을 칸일 때만 · 지금 맡을 칸이 없는 건(첨부 · 개인 글 · 「Claude·GPT 몫」)은
   *   시도를 안 세고 남긴다(`drainSkip`)
   */
  private async drainStuckV2(why: string): Promise<void> {
    this.draining = true;
    let finish!: () => void;
    this.drainRun = new Promise<void>((r) => { finish = r; });
    try {
      const dm = config.assistant.dmChannel;
      // codex 한도 조회(5분 캐시)를 엔진 상태에 옮겨 둔다 — 아래 막힘 판정이 같은 값을 본다.
      if (dmFallbackOn()) await codexQuota.refresh();
      const rep = await drainHeld({
        blocked: () => this.drainBlocked(),
        needsCanary: () => !engineState.isBlocked('claude') && needsCanary(engineState),
        skip: (it) => this.drainSkip(it),
        canary: () => this.canaryClaude(),
        pending: (n) => pendingHeld(n),
        tried: (id) => markCaptureTried(id),
        replay: (it) => this.replayHeld(it),
        replayed: async (it) => {
          await markCaptureReplayed(it.id);
          dropHeldFiles(it.id);
        },
        summary: async (text) => {
          if (dm) await this.app.client.chat.postMessage({ channel: dm, text });
        },
        askOld: (items) => this.askOldHeld(items),
        gate: this.holdGate,
        channelOf: (it) => replayTarget(it, dm).channel,
        log: (msg, meta) => this.logger.info(msg, { why, ...(meta ?? {}) }),
      }, DRAIN_MAX);
      if (rep.ran || rep.stopped) this.logger.info('밀린 것 다시 돌림', { why, ...rep });
    } catch (err) {
      this.logger.error('밀린 것을 다시 돌리다 터졌습니다', { why, err });
    } finally {
      this.draining = false;
      this.drainRun = null;
      finish();
    }
  }

  /**
   * 드레인 — 다시 돌릴 엔진이 하나도 없나. DM 폴백이 꺼져 있으면 예전 그대로 Claude 만 본다 · 켜져 있으면
   * 사다리(`dmLadder`)가 다 막혔을 때만. 「⏸ … 가장 빠른 회복에 처리」가 그래야 참이다.
   */
  private drainBlocked(): boolean {
    if (!dmFallbackOn()) return stillBlocked();
    const b = ladderBlockedMap(engineState);
    return dmLadder().every((e) => b[e]);
  }

  /**
   * 24시간 안 쓴 대화 세션을 지운다 — **장부(DM 폴백)에 그 방의 차례가 있으면 쓰는 중으로 본다.**
   * Claude 를 건너뛰거나 다른 엔진이 받은 차례는 세션 시각을 안 민다(Claude 가 그 글을 「못 본 글」로 받게).
   * 그것만 보면 며칠 막힌 동안 DM 의 대화 세션이 지워져, 돌아온 Claude 가 앞 대화를 잃는다.
   */
  private sweepSessions(): void {
    const maxAge = SESSION_IDLE_MS;
    const sinceSec = (Date.now() - maxAge) / 1000;
    this.cliHandler.cleanupInactiveSessions(maxAge, (s) => ledgerActiveSince(s.channelId, sinceSec));
  }

  /**
   * 이 건을 지금 맡을 엔진이 없나(6단계) — 대화 처리기가 그 차례에 고를 것을 미리 본다. Claude 가 비었으면
   * 무엇이든 맡는다. 아니면 넘기지 않는 차례(개인 글 · 채널 · 다른 작업 디렉터리)는 Claude 몫이고, 첨부 ·
   * 「Claude·GPT 몫」은 agy 칸이 못 맡는다 — 그런 건은 시도를 안 세고 남긴다.
   */
  private drainSkip(it: HeldItem): boolean {
    if (!dmFallbackOn()) return false;
    const b = ladderBlockedMap(engineState);
    if (!b.claude) return false;
    const target = replayTarget(it, config.assistant.dmChannel);
    const cwd = this.workingDirManager.getWorkingDirectory(target.channel, target.thread, config.bot.allowUsers[0]);
    const pick = pickEngine({
      origin: target.channel.startsWith('D') ? 'replay' : 'channel', planMode: false, resumeCmd: false,
      hasFiles: !!it.files?.length, needsFull: it.needs === 'full', isPrivate: containsPrivate(it.text),
      cwdIsWorkAssistant: this.isWorkAssistantDir(cwd), blocked: b,
    }, dmLadder());
    return pick === 'hold' || pick === 'claude';
  }

  /**
   * 막힌 뒤 한 번도 된 적이 없으면 아주 작은 호출로 먼저 떠 본다 — 밀린 것을 집었다가 곧바로
   * 또 막히면 그 건의 시도만 탄다. 결과는 전송 탭이 엔진 상태에 적는다(되면 막힘을 지우고
   * 막히면 다시 적는다). 도구 · 설정 · MCP 없이 한 줄.
   */
  private async canaryClaude(): Promise<void> {
    try {
      const r = await this.runAssistantSession('「확인」 한 낱말로만 답한다.', {
        workingDirectory: os.tmpdir(),
        model: SlackHandler.resolveModelAlias(config.defaultModel),
        effort: 'low',
        tools: [],
        settingSources: [],
        skipMcp: true,
        noSessionPersistence: true,
        maxDurationMs: 60_000,
      });
      this.logger.info('한도 떠 보기', { rateLimited: r.rateLimited, isError: r.isError });
    } catch (err) {
      // 스트림 밖에서 던진 Claude 막힘도 적는다 — 안 적으면 막힌 줄 모르고 밀린 것을 집는다.
      thrownClaudeBlock(err);
      throw err;
    }
  }

  /**
   * 밀린 것 하나를 **받은 자리에서** 다시 돌린다 — 머리 줄을 그 대화방 · 스레드에 올리고, 받은
   * 시각과 그 뒤에 올라온 글을 세션 앞에 붙인다(그 사이 뒤집혔는지 세션이 가린다). 일하다 끊긴
   * 것이면 같은 세션을 「이미 한 것」과 함께 잇는다. 결과를 돌려준다.
   */
  private async replayHeld(item: HeldItem): Promise<TurnOutcome> {
    const dm = config.assistant.dmChannel;
    const user = config.bot.allowUsers[0];
    if (!dm || !user) throw new Error('비서 방 또는 사용자가 설정되지 않았습니다');
    const target = replayTarget(item, dm);
    const posted = await this.app.client.chat.postMessage({
      channel: target.channel, text: leadText(item), ...(target.thread ? { thread_ts: target.thread } : {}),
    });
    const ts = String(posted.ts);
    const since = receivedSec(item);
    // 받은 뒤 올라온 글 — 스레드에서 받은 것이면 스레드 첫 글도 같이(그 글에 단 답이었다).
    const unseen = since === undefined ? '' : await this.getBotUserId()
      .then((botUserId) => readUnseen(this.app.client as any, target.channel, {
        currentTs: ts,
        threadTs: target.thread,
        isNewSession: Boolean(item.thread && item.thread !== item.msg_ts),
        sinceSec: since,
        botUserId,
        isPrivate: containsPrivate,
        frame: REPLAY_FRAME,
      })).catch(() => '');
    // **처음 값은 「못 함」** — 차례가 끝까지 가야 결과가 덮인다. 비워 두면 처리기가 일찍 돌아온 것(작업
    // 디렉터리 없음 등)이 아래 기본값 `ok` 로 읽혀, 돌지도 않은 건이 「다시 돌림」으로 닫힌다.
    const outcomeSink: Partial<TurnOutcome> = { outcome: 'error' };
    await this.handleMessage({
      type: 'message', channel: target.channel, user, text: item.text, ts,
      ...(target.thread ? { thread_ts: target.thread } : {}),
      pushed: true, replay: true, captureId: item.id, outcomeSink,
      replayNote: replayNote(item, unseen),
      ...(item.session_id ? { resumeSessionId: item.session_id } : {}),
      // 세션이 없어도 「이미 한 것」은 싣는다 — GPT · agy 가 쓰다 끊긴 것을 새 차례로 이어 간다(2026-10-15 검토). 또
      // 끊기면 이 줄들이 다음 보류 칸에 합쳐진다(`buildHoldExtra` 의 `prior`).
      ...(item.session_id || item.done_steps?.length ? { heldSteps: item.done_steps ?? [] } : {}),
      ...(item.files?.length ? { heldFiles: item.files } : {}),
      ...(item.needs === 'full' ? { needsFull: true } : {}),
    } as unknown as MessageEvent, this.pushedSay(target.channel));
    return { outcome: 'ok', engine: 'claude', steps: [], writeRan: false, ...outcomeSink };
  }

  /** 받은 지 7일이 지난 것 — 건마다 [실행]·[버림] 을 한 번 묻고 물었다고 적는다. */
  private async askOldHeld(items: HeldItem[]): Promise<void> {
    const dm = config.assistant.dmChannel;
    if (!dm || !items.length) return;
    const msg = oldListMessage(items);
    await this.app.client.chat.postMessage({ channel: dm, text: msg.text, blocks: msg.blocks });
    await markCaptureTold(items.map((i) => i.id));
  }

  /**
   * [실행] 을 누른 7일 지난 것 하나를 지금 돌린다 — 드레인과 같은 길(`replayHeld`). 사람에게 낼
   * 한 줄과 버튼을 걷을지를 돌려준다(다시 막혔으면 버튼을 남겨 나중에 다시 누르게).
   */
  private async runHeldNow(id: string): Promise<{ text: string; settle: boolean }> {
    // **겹 누름은 첫 await 앞에서 막는다** — 뒤에서 막으면 두 번째 누름이 기다리는 사이를 지나 같은 건을 두 번 돌린다.
    if (this.heldNowBusy) return { text: '이미 처리하는 중입니다 — 끝난 뒤 결과를 알려 드립니다', settle: false };
    this.heldNowBusy = true;
    try {
      if (dmFallbackOn()) await codexQuota.refresh();
      if (this.drainBlocked()) return { text: '⏳ 아직 사용량 한도에 막혀 있습니다 — 풀린 뒤 다시 눌러 주세요', settle: false };
      if (this.drainRun) await this.drainRun;
      if (this.draining) return { text: '밀린 요청을 처리하는 중입니다 — 끝난 뒤 다시 눌러 주세요', settle: false };
      // 드레인 문도 확인한 그 자리에서 잡는다 — 목록을 읽는 사이에 드레인이 끼어들지 않게.
      this.draining = true;
      try {
        const { run, tell } = await pendingHeld(50);
        const item = [...tell, ...run].find((x) => x.id === id);
        if (!item) return { text: '이미 처리했거나 버린 요청입니다', settle: true };
        // 지금 남은 칸이 이 건을 못 맡으면(첨부 · 개인 글 · 「Claude·GPT 몫」) 돌리지 않는다 — 6단계.
        if (this.drainSkip(item)) return { text: '⏳ 이 요청을 맡을 엔진이 아직 막혀 있습니다 — 풀린 뒤 다시 눌러 주세요', settle: false };
        const release = this.holdGate.hold([replayTarget(item, config.assistant.dmChannel).channel]);
        try {
          await markCaptureTried(id);
          const out = await this.replayHeld(item);
          if (out.outcome === 'ok') {
            await markCaptureReplayed(id);
            dropHeldFiles(id);
            return { text: '▶ 처리했습니다', settle: true };
          }
          if (isHeldOutcome(out)) return { text: '⏳ 다시 한도에 막혔습니다 — 풀린 뒤 다시 눌러 주세요', settle: false };
          return { text: '⚠️ 처리하다 문제가 났습니다 — 확인이 필요합니다', settle: true };
        } finally {
          release();
        }
      } finally {
        this.draining = false;
      }
    } finally {
      this.heldNowBusy = false;
    }
  }
  /** [실행] 이 도는 중 — `runHeldNow` 가 첫 await 앞에서 세운다. */
  private heldNowBusy = false;

  /**
   * 처리 못 한 차례의 실패 표시 — 보류 v2 면 쓰기가 돈 뒤였는지(`partial`) · 세션 · 이미 한 것 ·
   * 첨부까지 같이 적는다. **첨부 보관은 동기로** 한다 — 바로 뒤에서 임시 파일을 지운다.
   */
  private markTurnFailed(captureId: string, why: 'limit' | 'error', steps: Pick<StepLog, 'steps'>,
                         sessionId: string | undefined, event: MessageEvent,
                         files: ProcessedFile[], needs?: 'full'): Promise<void> {
    if (!captureId) return Promise.resolve();
    if (!holdV2On()) return markCaptureFailed(captureId, why);
    const { extra, writeRan } = buildHoldExtra(
      captureId, steps.steps, event.heldSteps ?? [], sessionId, files.map(heldFileOf));
    // agy 칸이 「Claude·GPT 몫」으로 남긴 것 — agy 만 남은 동안에는 드레인이 안 집는다(6단계).
    if (needs || event.needsFull) extra.needs = 'full';
    return markCaptureFailed(captureId, why === 'limit' && writeRan ? 'partial' : why, extra);
  }

  // --- DM 폴백 (엔진 폴백 5단계 · `DM_FALLBACK=on` · 6단계 agy 칸 `DM_FALLBACK_AGY=on`) ---

  /**
   * 엔진별 지금 못 맡나 — codex 는 한도 조회(5분에 한 번 · 못 읽으면 모름)를 엔진 상태에 옮긴 뒤 본다
   * (`ladderBlockedMap`).
   */
  private async ladderBlocked(): Promise<Partial<Record<Engine, boolean>>> {
    await codexQuota.refresh();
    return ladderBlockedMap(engineState);
  }

  /**
   * 엔진 안내의 이름 — GPT 는 **DM 차례가 실제로 부를 모델**(2026-10-15 검토). 예전에는 기본 모델의 대응표 칸을
   * 따로 읽어, DM 방의 모델(`-model`)을 바꿨거나 표에 칸이 없을 때 안내와 실제가 어긋났다. 고르는 함수는
   * `runDmFallback` 과 같은 `serviceCodex` 이고, 표에 칸이 없으면 마지막으로 실제로 부른 모델(`lastCodexModel`).
   */
  private engineNoticeLabels(): ModelLabels {
    const primary = SlackHandler.resolveModelAlias(
      this.channelModels.get(config.assistant.dmChannel) || config.defaultModel);
    const base = loadModelLabels(undefined, primary, INTERACTIVE_EFFORT);
    const codex = serviceCodex(primary, INTERACTIVE_EFFORT)?.model ?? this.lastCodexModel ?? base.codex;
    return { ...base, codex };
  }

  /**
   * 넘길 글에 개인 글 조각이 있다 — GPT · agy 로 안 보내고 모아 둔다(개인 글 차례와 같은 길: 실패 표시 · 한도 안내
   * 한 번). 다음 칸으로도 안 넘긴다(그쪽도 밖이다). 회복 때 Claude 가 다시 돌린다.
   * 결과는 막힘이 아니라 「못 함」(`privateHold`) — 드레인이 이 건에서 멈추면 뒤의 건까지 묶인다.
   */
  private async holdPrivateFallback(a: FallbackArgs, rung: Engine): Promise<FallbackResult> {
    this.logger.warn('DM 폴백 — 넘길 글에 개인 글 조각이 있어 대체 엔진에 안 보내고 모아 둡니다', { rung });
    appendLedger({ channel: a.channel, engine: 'none', model: '', captureId: a.captureId, outcome: 'hold' });
    const markDone = this.markTurnFailed(a.captureId, 'limit', { steps: a.claudeSteps }, a.sessionId, a.event, a.files);
    await this.handleRateLimitUI(a.channel, a.thread_ts || a.ts, a.finalPrompt, a.block, a.locale, a.say, a.ts, a.captureId);
    return { result: 'failed', steps: [], writeRan: false, markDone, privateHold: true };
  }

  /** 이 작업 디렉터리가 업무 비서 뿌리인가 — 대체 엔진의 규칙 · 쓰기 범위가 거기에 맞춰져 있다. */
  private isWorkAssistantDir(dir: string | undefined): boolean {
    const root = workAssistantRoot();
    if (!root || !dir) return false;
    const norm = (p: string) => {
      const r = path.resolve(p).replace(/[\\/]+$/, '');
      return process.platform === 'win32' ? r.toLowerCase() : r;
    };
    return norm(root) === norm(dir);
  }

  /**
   * GPT(codex) 한 차례 — Claude 가 막힌 DM 차례를 이어 받는다.
   *
   * - **같은 방에서 한 줄로** — 문(`holdGate`)은 부르는 쪽이 사다리 전체에 한 번 잡는다
   * - `-stop` 이 끊을 수 있게 손잡이를 걸고, 재시작에 끊기면 「했을 수 있음」으로 모아 두게 처리 중 기록을 고친다
   * - Claude 와 같은 안내(슬랙 · 캡처 · 번호표) + 못 본 대화방 글(새 세션처럼 12시간) + 넘겨줄 메모 + 사람 말 + 첨부 경로
   * - 캡처 id 는 **값으로** 넘긴다(`WORK_ASSISTANT_CAPTURE`) — 방마다 하나인 가리킴 파일은 다음 차례가 갈아 끼운다
   * - 됐으면 답 + 작은 표시 줄 · 쓰기가 없었으면 캡처를 닫음. 못 했으면 다음 칸(6단계 agy)이 있으면 그리로,
   *   없으면 모아 두고 예전 한도 안내(한 번만) — codex 의 오류 글은 안 올린다
   */
  private async runDmFallback(a: FallbackArgs): Promise<FallbackResult> {
    const { event, channel, sessionKey, captureId } = a;
    let kill: (() => void) | null = null;
    let stopped = false;
    const handle: TurnHandle = { interrupt: () => { stopped = true; kill?.(); } };
    this.activeProcesses.set(sessionKey, handle);
    patchInflight(sessionKey, { engine: 'codex', steps: [...a.claudeSteps, CODEX_INFLIGHT_STEP], sessionId: a.sessionId });
    a.status('↪ GPT 가 이어 받는 중');
    try {
      const claudeWrites = a.claudeSteps.filter((s) => s.write).length;
      const context = event.replay ? (event.replayNote ?? '') : await this.getBotUserId()
        .then((botUserId) => readUnseen(this.app.client as any, channel, {
          currentTs: a.ts, threadTs: a.thread_ts, isNewSession: true, botUserId, isPrivate: containsPrivate,
        })).catch(() => '');
      const prompt = [handoverNote(a.claudeSteps), context, a.finalPrompt + filesNote(a.files)].filter(Boolean).join('\n');
      // **보낼 글 전체를 개인 글 문에 한 번 더 댄다**(2026-10-15 검토) — 차례 앞에서는 사람 말만 봤다. 넘겨줄 메모
      // (Claude 가 돌린 명령의 인자) · 못 본 대화방 글 · 밀린 요청 메모에 섞인 조각도 OpenAI 로 안 나가게 모아 둔다.
      if (containsPrivate(prompt)) return await this.holdPrivateFallback(a, 'codex');
      // 모델은 서비스 폴백 대응표(`service_fallback` · 한 급 낮게) — 표가 없으면 예전처럼 같은 등급 · 기본 모델.
      const svc = serviceCodex(a.claudeModel, INTERACTIVE_EFFORT);
      const model = svc?.model
        ?? (await sameTier(a.claudeModel, 'codex'))?.model ?? SESSION_CODEX_MODEL;
      // 엔진 안내가 이 이름을 쓴다(대응표에 칸이 없을 때) — 기본 모델이 아니라 실제로 부른 모델.
      this.lastCodexModel = model;
      this.logger.warn('DM 폴백 — GPT 가 이어 받습니다', { model, claudeWrites, origin: event.replay ? 'replay' : 'dm' });
      const r = await codexTurn(prompt, {
        workingDirectory: workAssistantRoot() ?? process.cwd(),
        sandbox: 'workspace-write',
        appendSystemPrompt: a.surfaceNote,
        timeoutMs: FALLBACK_TIMEOUT_MS,
        // 깊이는 1차(Claude 대화 차례)의 것 — 대응표가 luna 면 한 단계 위(`effort_up`). 표의 등급 깊이가 아니다.
        effort: svc?.effort ?? INTERACTIVE_EFFORT,
        model,
        env: fallbackEnv(captureId),
        onSpawn: (k) => { kill = k; if (stopped) k(); },
        drillScope: 'interactive',
      });
      const steps = codexSteps(r.steps);
      if (stopped) {
        appendLedger({ channel, engine: 'codex', model, captureId, outcome: 'stopped' });
        return { result: 'stopped', steps, writeRan: r.writeRan };
      }
      if (r.kind === 'ok') {
        const reply = r.text.trim();
        if (reply) await a.say({ text: this.formatMessage(reply, true), thread_ts: a.replyTs });
        // 판에서 온 차례가 「조용히」로 답했으면 답이 안 보이므로 표시 줄도 안 올린다.
        if (!((event as any).pushed && isQuietReply(reply))) {
          const marker = markerLines({ model, block: a.block, ...(claudeWrites ? { handover: claudeWrites } : {}) }).join('\n');
          await a.say({ text: marker, blocks: [{ type: 'context', elements: [{ type: 'mrkdwn', text: marker }] }], thread_ts: a.replyTs });
        }
        // 쓰기가 하나도 없었으면(조회 · 잡담) 캡처를 닫는다 — 쓰기가 있었으면 `tasks.py` 가 스스로 닫았다.
        if (captureId && !r.writeRan && !claudeWrites) await dropCapture(captureId, '대체 엔진이 답함');
        appendLedger({ channel, engine: 'codex', model, captureId, outcome: 'ok' });
        return { result: 'ok', steps, writeRan: r.writeRan };
      }
      appendLedger({ channel, engine: 'codex', model, captureId, outcome: r.kind });
      // 다음 칸(6단계 agy)이 있으면 그리로 — GPT 가 돌린 명령은 「이미 한 것」으로 넘어간다.
      const next = await a.nextAfter('codex');
      if (next !== 'hold' && next !== 'claude') {
        this.logger.warn(`DM 폴백 — GPT 도 못 했습니다(${r.kind}) · ${next} 로 넘깁니다`, { detail: r.detail });
        return { result: 'next', steps, writeRan: r.writeRan, next };
      }
      this.logger.warn(`DM 폴백 — GPT 도 못 했습니다(${r.kind}) · 모아 둡니다`, { detail: r.detail });
      const markDone = this.markTurnFailed(captureId, 'limit', { steps: [...a.claudeSteps, ...steps] },
        a.sessionId, event, a.files);
      await this.handleRateLimitUI(channel, a.thread_ts || a.ts, a.finalPrompt, a.block, a.locale, a.say, a.ts, captureId);
      return { result: 'failed', steps, writeRan: r.writeRan, markDone };
    } finally {
      if (this.activeProcesses.get(sessionKey) === handle) this.activeProcesses.delete(sessionKey);
    }
  }

  /**
   * agy 칸 한 차례(6단계 · `DM_FALLBACK_AGY=on`) — Claude · GPT 가 못 한 DM 차례를 agy 의 Claude 또는 Gemini 가
   * 이어 받는다. agy 는 도구가 없어 **JSON 계획만** 내고, 봇이 허용 목록 명령만 셸 없이 돌린다(`agy-actions.ts`).
   *
   * - 프롬프트 — 이 칸의 규칙(`AGY_DM_RULES`) + 지금 시각 + **열린 업무 전부**(일부만 주면 엉뚱한 업무를 골랐다) +
   *   체크인 번호표 + 넘겨줄 메모(앞 칸이 한 것 · 결과 모름 표시) + 못 본 대화방 글 + 사람 말
   * - 답 뒤에 「실행한 것」(명령마다 한 줄) · 「실행하지 않은 명령」 · 표시 줄 「↪ <표시 이름> 가 답함 · <무엇이 막혔나>」
   * - `needs_full` — 답과 「⏸ 이 부분은 Claude·GPT 가 돌아오면 …」을 올리고 캡처에 실패 표시(`limit` · 명령이
   *   돌았으면 `partial`)와 `needs: full` 을 남긴다 — 보류 v2 가 Claude·GPT 가 돌아오면 다시 돌린다
   * - 못 했으면(한도 · 실패 · 계획 아님 · 업무 목록을 못 읽음) 다음 칸으로 · 없으면 모아 둔다(예전 한도 안내)
   */
  private async runAgyFallback(a: FallbackArgs & { rung: AgyRung; ladder: readonly Engine[] }): Promise<FallbackResult> {
    const { event, channel, sessionKey, captureId, rung } = a;
    let kill: (() => void) | null = null;
    let stopped = false;
    const handle: TurnHandle = { interrupt: () => { stopped = true; kill?.(); } };
    this.activeProcesses.set(sessionKey, handle);
    // agy 를 부르는 동안은 아무것도 안 쓴다 — 명령을 띄우기 직전에만 「결과 모름」 자리표를 붙인다.
    patchInflight(sessionKey, { engine: rung, steps: [...a.claudeSteps], sessionId: a.sessionId });
    const model = agyModel(rung);
    const display = agyDisplay(rung, model.label);
    a.status(`↪ ${display} 가 이어 받는 중${rung === 'agy-gemini' ? '(답이 느립니다)' : ''}`);
    const fail = async (kind: string, detail?: string): Promise<FallbackResult> => {
      appendLedger({ channel, engine: rung, model: display, captureId, outcome: kind });
      const next = await a.nextAfter(rung);
      if (next !== 'hold' && next !== 'claude') {
        this.logger.warn(`DM 폴백 — ${rung} 못 함(${kind}) · ${next} 로 넘깁니다`, { detail });
        return { result: 'next', steps: [], writeRan: false, next };
      }
      this.logger.warn(`DM 폴백 — ${rung} 못 함(${kind}) · 모아 둡니다`, { detail });
      const markDone = this.markTurnFailed(captureId, 'limit', { steps: a.claudeSteps }, a.sessionId, event, a.files);
      await this.handleRateLimitUI(channel, a.thread_ts || a.ts, a.finalPrompt, a.block, a.locale, a.say, a.ts, captureId);
      return { result: 'failed', steps: [], writeRan: false, markDone };
    };
    try {
      const root = workAssistantRoot();
      const list = root ? await fetchTaskList() : null;
      if (!root || !list) return await fail('fail', '업무 목록을 못 읽음');
      const priorWrites = a.claudeSteps.filter((s) => s.write).length;
      const context = event.replay ? (event.replayNote ?? '') : await this.getBotUserId()
        .then((botUserId) => readUnseen(this.app.client as any, channel, {
          currentTs: a.ts, threadTs: a.thread_ts, isNewSession: true, botUserId, isPrivate: containsPrivate,
        })).catch(() => '');
      const handover = handoverNote(a.claudeSteps, 'Claude·GPT');
      // **보낼 글을 개인 글 문에 한 번 더 댄다**(2026-10-15 검토) — 넘겨줄 메모 · 못 본 대화방 글 · 밀린 요청 메모 ·
      // 사람 말. 걸리면 Google 로 안 보내고 모아 둔다(업무 목록 · 이 칸의 규칙은 봇이 짓는 글이라 안 본다).
      if (containsPrivate([handover, context, a.finalPrompt].join('\n'))) return await this.holdPrivateFallback(a, rung);
      const prompt = agyDmPrompt({
        list, slotMap: a.slotMap, handover, context, text: a.finalPrompt,
      });
      this.logger.warn(`DM 폴백 — ${rung} 가 이어 받습니다`, { model: model.alias, priorWrites, origin: event.replay ? 'replay' : 'dm' });
      const r = await agyTurn(prompt, {
        rung, system: AGY_DM_RULES, drillScope: 'interactive', env: fallbackEnv(captureId),
        onSpawn: (k) => { kill = k; if (stopped) k(); },
      });
      if (stopped) {
        appendLedger({ channel, engine: rung, model: display, captureId, outcome: 'stopped' });
        return { result: 'stopped', steps: [], writeRan: false };
      }
      if (r.kind !== 'ok' || !r.plan) return await fail(r.kind, r.detail);
      const plan = r.plan;

      // 허용 목록 → 셸 없이 차례로. 앞이 실패하면 뒤는 안 돌린다.
      // **명령 하나가 끝날 때마다 처리 중 기록에 적는다 — 다음 명령을 띄우기 전에**(2026-10-15 검토). 전에는 다 끝난
      // 뒤에야 모았고 그사이 기록은 빈 목록으로 덮였다 — 재시작에 끊기면 앞서 끝난 등록이 「이미 한 것」에서 빠져
      // 다음 엔진이 또 등록했다.
      const { ok: valid, rejected } = validateActions(plan.actions, { tasks: list.tasks });
      let done: TurnStep[] = [];
      const ran = await runActions(valid, {
        root, captureId,
        onStart: (i) => patchInflight(sessionKey, {
          steps: [...a.claudeSteps, ...done, agyRunningStep(rung, valid[i].summary)],
        }),
        onDone: (runs) => {
          done = actionSteps(runs, rung);
          patchInflight(sessionKey, { steps: [...a.claudeSteps, ...done] });
        },
        stop: () => stopped,
      });
      const steps = actionSteps(ran.runs, rung);
      const wrote = ran.runs.length > 0;
      if (rejected.length) this.logger.warn(`DM 폴백 — ${rung} 명령 ${rejected.length}건을 안 돌림`, { why: rejected.map((x) => x.why) });
      // **명령 사이에 끊었으면 끊긴 것이다**(2026-10-15 검토) — 전에는 남은 명령을 「앞 명령이 실패해 멈춤」으로 적고
      // 「됨」으로 끝냈다. 돈 것은 사람에게 보이고(무엇이 됐는지는 알아야 한다), 결과는 `stopped`.
      if (stopped) {
        if (ran.runs.length) {
          await a.say({ text: this.formatMessage(actionReport(ran.runs, [], []), true), thread_ts: a.replyTs });
        }
        appendLedger({ channel, engine: rung, model: display, captureId, outcome: 'stopped' });
        return { result: 'stopped', steps, writeRan: wrote };
      }

      // **하나라도 안 됐으면 「됨」이 아니다**(2026-10-15 검토) — 실패 · 허용 목록 밖 · 앞이 실패해 안 돈 명령이
      // 있으면 남은 몫을 「Claude·GPT 몫」으로 모아 둔다(돈 것과 실패한 것은 「이미 한 것」, 안 돈 것은 「안 함」).
      // 전에는 실패 줄을 보이고도 `ok` 로 끝내 다시 돌리던 차례가 「다시 돌림」으로 닫혔다.
      const incomplete = rejected.length > 0 || ran.skipped.length > 0 || ran.runs.some((x) => !x.ok);
      const holdRest = plan.needsFull || incomplete;

      // 사람에게 — 답 · 실행한 것 · 실행하지 않은 명령 · (남긴 몫) · 표시 줄. 판에서 온 「조용히」는 다 그대로
      // 됐을 때만 조용하다(안 된 것은 반드시 말한다).
      const report = actionReport(ran.runs, ran.skipped, rejected);
      const quiet = isQuietReply(plan.reply);
      const trouble = incomplete || ran.runs.some((x) => x.notes.length);
      const silent = !!(event as any).pushed && quiet && !trouble && !plan.needsFull;
      if (!silent) {
        const held = plan.needsFull
          ? `${NEEDS_FULL_LINE}${plan.needsFullReason ? ` — ${plan.needsFullReason}` : ''}`
          : incomplete ? INCOMPLETE_LINE : '';
        const body = [quiet ? '' : plan.reply, report, held].filter(Boolean).join('\n\n');
        if (body) await a.say({ text: this.formatMessage(body, true), thread_ts: a.replyTs });
        const marker = agyMarkerLines({
          display, claudeBlock: a.block, above: a.ladder.slice(0, Math.max(0, a.ladder.indexOf(rung))),
          st: engineState.load(), nowSec: engineState.nowSec(), ...(priorWrites ? { handover: priorWrites } : {}),
        }).join('\n');
        await a.say({ text: marker, blocks: [{ type: 'context', elements: [{ type: 'mrkdwn', text: marker }] }], thread_ts: a.replyTs });
      }

      if (holdRest) {
        // 남은 몫은 모아 둔다 — 명령이 돌았으면 `partial`(이미 한 것과 함께) · agy 만 남은 동안은 안 집는다.
        const notRun = notRunSteps(rung, [...ran.skipped.map((x) => x.summary), ...rejected.map((x) => x.what)]);
        const markDone = this.markTurnFailed(captureId, 'limit', { steps: [...a.claudeSteps, ...steps, ...notRun] },
          a.sessionId, event, a.files, 'full');
        appendLedger({ channel, engine: rung, model: display, captureId, outcome: 'hold' });
        return { result: 'held', steps, writeRan: wrote, markDone };
      }
      // 쓰기가 하나도 없었으면(조회 · 잡담 · 되물음) 캡처를 닫는다 — 명령이 돌았으면 `tasks.py` 가 스스로 닫았다.
      if (captureId && !wrote && !priorWrites) await dropCapture(captureId, '대체 엔진이 답함');
      appendLedger({ channel, engine: rung, model: display, captureId, outcome: 'ok' });
      return { result: 'ok', steps, writeRan: wrote };
    } finally {
      if (this.activeProcesses.get(sessionKey) === handle) this.activeProcesses.delete(sessionKey);
    }
  }

  // --- Message content helpers ---

  private extractTextFromContent(content: Array<{ type: string; text?: string; [key: string]: any }>): string | null {
    const textParts = content
      .filter((part: any) => part.type === 'text')
      .map((part: any) => part.text);
    const result = textParts.join('');
    return result || null;
  }

  // Tools that only show in the status message (no separate say() needed)
  private static readonly STATUS_ONLY_TOOLS = new Set([
    'Read', 'Grep', 'Glob', 'LS', 'WebSearch', 'WebFetch',
    'ListMcpResourcesTool', 'ReadMcpResourceTool',
    'TodoRead', 'TodoWrite', 'NotebookRead',
  ]);

  private formatToolUse(content: any[], locale: Locale): string {
    const parts: string[] = [];
    for (const part of content) {
      if (part.type === 'text') {
        parts.push(part.text);
      } else if (part.type === 'tool_use') {
        const toolName = part.name;
        const input = part.input;

        // Skip tools already shown in status message
        if (SlackHandler.STATUS_ONLY_TOOLS.has(toolName)) continue;

        switch (toolName) {
          case 'Edit':
          case 'MultiEdit':
            parts.push(this.formatEditTool(toolName, input, locale));
            break;
          case 'Write':
            parts.push(this.formatWriteTool(input, locale));
            break;
          case 'Bash':
            parts.push(this.formatBashTool(input, locale));
            break;
          default:
            parts.push(this.formatGenericTool(toolName, input, locale));
        }
      }
    }
    return parts.join('\n\n');
  }

  private formatEditTool(toolName: string, input: any, locale: Locale): string {
    const filePath = input.file_path;
    const edits = toolName === 'MultiEdit' ? input.edits : [{ old_string: input.old_string, new_string: input.new_string }];
    let result = `📝 ${t('tool.editing', locale, { path: filePath })}\n`;
    for (const edit of edits) {
      result += '\n```diff\n';
      result += `- ${this.truncateString(edit.old_string, 200)}\n`;
      result += `+ ${this.truncateString(edit.new_string, 200)}\n`;
      result += '```';
    }
    return result;
  }

  private formatWriteTool(input: any, locale: Locale): string {
    return `📄 ${t('tool.creating', locale, { path: input.file_path })}\n\`\`\`\n${this.truncateString(input.content, 300)}\n\`\`\``;
  }

  private formatBashTool(input: any, locale: Locale): string {
    return `🖥️ ${t('tool.running', locale)}\n\`\`\`bash\n${input.command}\n\`\`\``;
  }

  private formatGenericTool(toolName: string, _input: any, locale: Locale): string {
    return `🔧 ${t('tool.using', locale, { toolName })}`;
  }

  private truncateString(str: string, maxLength: number): string {
    if (!str) return '';
    if (str.length <= maxLength) return str;
    return str.substring(0, maxLength) + '...';
  }

  private formatMessage(text: string, _isFinal: boolean): string {
    return text
      .replace(/```(\w+)?\n([\s\S]*?)```/g, (_, _lang, code) => '```' + code + '```')
      .replace(/`([^`]+)`/g, '`$1`')
      .replace(/\*\*([^*]+)\*\*/g, '*$1*')
      .replace(/__([^_]+)__/g, '_$1_');
  }

  // --- Todo handling ---

  private async handleTodoUpdate(input: any, sessionKey: string, sessionId: string | undefined, channel: string, threadTs: string | undefined, say: any, locale: Locale = 'en'): Promise<void> {
    if (!sessionId || !input.todos) return;
    const newTodos: Todo[] = input.todos;
    const oldTodos = this.todoManager.getTodos(sessionId);

    if (this.todoManager.hasSignificantChange(oldTodos, newTodos)) {
      this.todoManager.updateTodos(sessionId, newTodos);
      const todoList = this.todoManager.formatTodoList(newTodos, locale);
      const existingTodoMessageTs = this.todoMessages.get(sessionKey);

      if (existingTodoMessageTs) {
        try {
          await this.app.client.chat.update({ channel, ts: existingTodoMessageTs, text: todoList });
        } catch {
          await this.createNewTodoMessage(todoList, channel, threadTs, sessionKey, say);
        }
      } else {
        await this.createNewTodoMessage(todoList, channel, threadTs, sessionKey, say);
      }

      const statusChange = this.todoManager.getStatusChange(oldTodos, newTodos, locale);
      if (statusChange) {
        await say({ text: `🔄 ${t('tool.taskUpdate', locale)}\n${statusChange}`, thread_ts: threadTs });
      }
      await this.updateTaskProgressReaction(sessionKey, newTodos);
    }
  }

  private async createNewTodoMessage(todoList: string, channel: string, threadTs: string | undefined, sessionKey: string, say: any): Promise<void> {
    const result = await say({ text: todoList, thread_ts: threadTs });
    if (result?.ts) {
      this.todoMessages.set(sessionKey, result.ts);
    }
  }

  // --- Reactions ---

  // Unicode emoji → Slack reaction shortcode mapping
  private readonly emojiToReaction: Record<string, string> = {
    '📝': 'memo',
    '🤔': 'thinking_face',
    '⚙️': 'gear',
    '📋': 'clipboard',
    '✅': 'white_check_mark',
    '❌': 'x',
    '⏹️': 'stop_button',
    '🔄': 'arrows_counterclockwise',
    '🔍': 'mag',
    '✏️': 'pencil2',
    '💻': 'computer',
    '🌐': 'globe_with_meridians',
    '🤖': 'robot_face',
    '🔌': 'electric_plug',
    '✍️': 'writing_hand',
  };

  private getToolReactionEmoji(toolName: string): string {
    if (['Read', 'Glob', 'Grep', 'LS'].includes(toolName)) return '🔍';
    if (['Edit', 'MultiEdit', 'Write', 'NotebookEdit'].includes(toolName)) return '✏️';
    if (toolName === 'Bash') return '💻';
    if (['WebFetch', 'WebSearch'].includes(toolName)) return '🌐';
    if (toolName === 'Task') return '🤖';
    if (toolName.startsWith('mcp__')) return '🔌';
    return '⚙️';
  }

  // Conflicting reaction groups: within each group, only one should be shown at a time
  private readonly conflictingReactionGroups: string[][] = [
    // Terminal states conflict with each other and with in-progress states
    ['white_check_mark', 'x', 'stop_button', 'clipboard'],
    // In-progress states conflict with each other and with terminal states
    ['thinking_face', 'memo', 'mag', 'pencil2', 'computer', 'globe_with_meridians', 'robot_face', 'electric_plug', 'gear', 'writing_hand', 'arrows_counterclockwise'],
  ];

  // Get all reactions that conflict with the given reaction (from all groups it belongs to, plus the other group)
  private getConflictingReactions(reactionName: string): Set<string> {
    const conflicts = new Set<string>();
    // All status reactions are mutually conflicting — collect from all groups
    for (const group of this.conflictingReactionGroups) {
      for (const r of group) {
        if (r !== reactionName) conflicts.add(r);
      }
    }
    return conflicts;
  }

  private readonly ANCHOR_REACTION = 'hourglass_flowing_sand'; // ⏳

  /**
   * **줄에 세우고 바로 돌아온다.** 반응 API 를 기다리지 않으므로 부르는 쪽의
   * `await` 는 즉시 풀린다 — 호출 지점을 하나도 안 고치고 대기만 걷어내려고
   * 반환형을 `Promise<void>` 로 남겨 두었다.
   *
   * 순서는 세션마다 하나뿐인 약속 사슬이 지킨다. 실패는 삼킨다 — 반응은 장식이라
   * 못 달렸다고 차례를 멈출 이유가 없고, 원래 코드도 통째로 `catch` 였다.
   *
   * ⚠️ **원본 메시지는 실행 시점에 읽는다** — 줄에 선 뒤에 세션이 정리될 수 있다.
   * 정리는 5분 뒤라 실제로는 넉넉하지만, 사라졌으면 조용히 건너뛰는 것이 맞다.
   */
  private queueSlack(sessionKey: string, work: () => Promise<void>): void {
    const prev = this.slackChain.get(sessionKey) ?? Promise.resolve();
    const next = prev.then(work).catch(() => { /* 반응은 장식 */ });
    this.slackChain.set(sessionKey, next);
  }

  /**
   * 상태 한 줄(「🔍 Read 사용 중」)을 **줄에 세워서** 고친다 (2026-08-31).
   *
   * 도구를 쓸 때마다 이 줄을 고치는데, 그때마다 슬랙 왕복을 **기다리고 있었다** —
   * 도구 호출 수 × 0.26초가 그대로 차례에 실린다. 판에서 온 것은 그 줄을 끝에
   * 지우므로 **아무도 안 읽는다.**
   *
   * ⚠️ **반응과 같은 줄에 세운다.** 따로 두면 차례 끝의 「지우기」가 진행 중이던
   * 「고치기」를 앞질러, 지운 메시지를 고치려 드는 순서가 나온다.
   */
  private queueStatus(sessionKey: string, channel: string, ts: string | undefined,
                      text: string, remove = false): void {
    if (!ts) return;
    this.queueSlack(sessionKey, async () => {
      if (remove) {
        await this.app.client.chat.delete({ channel, ts }).catch(() => {});
      } else {
        await this.app.client.chat.update({ channel, ts, text }).catch(() => {});
      }
    });
  }

  private async addAnchorReaction(sessionKey: string): Promise<void> {
    this.queueSlack(sessionKey, async () => {
      const originalMessage = this.originalMessages.get(sessionKey);
      if (!originalMessage) return;
      try {
        await this.app.client.reactions.add({ channel: originalMessage.channel, timestamp: originalMessage.ts, name: this.ANCHOR_REACTION });
      } catch { /* ignore */ }
    });
  }

  private async removeAnchorReaction(sessionKey: string): Promise<void> {
    this.queueSlack(sessionKey, async () => {
      const originalMessage = this.originalMessages.get(sessionKey);
      if (!originalMessage) return;
      try {
        await this.app.client.reactions.remove({ channel: originalMessage.channel, timestamp: originalMessage.ts, name: this.ANCHOR_REACTION });
      } catch { /* ignore */ }
    });
  }

  private async updateMessageReaction(sessionKey: string, emoji: string): Promise<void> {
    this.queueSlack(sessionKey, async () => {
      const originalMessage = this.originalMessages.get(sessionKey);
      if (!originalMessage) return;

      const reactionName = this.emojiToReaction[emoji] || emoji;
      let activeReactions = this.currentReactions.get(sessionKey);
      if (!activeReactions) {
        activeReactions = new Set();
        this.currentReactions.set(sessionKey, activeReactions);
      }

      // Already showing this exact reaction — nothing to do
      if (activeReactions.has(reactionName)) {
        // Still remove any conflicting ones that shouldn't be there
        const conflicts = this.getConflictingReactions(reactionName);
        for (const conflict of conflicts) {
          if (activeReactions.has(conflict)) {
            try {
              await this.app.client.reactions.remove({ channel: originalMessage.channel, timestamp: originalMessage.ts, name: conflict });
            } catch { /* might not exist */ }
            activeReactions.delete(conflict);
          }
        }
        return;
      }

      try {
        // Remove all conflicting reactions first
        const conflicts = this.getConflictingReactions(reactionName);
        for (const conflict of conflicts) {
          if (activeReactions.has(conflict)) {
            try {
              await this.app.client.reactions.remove({ channel: originalMessage.channel, timestamp: originalMessage.ts, name: conflict });
            } catch { /* might not exist */ }
            activeReactions.delete(conflict);
          }
        }

        // Add the new reaction
        await this.app.client.reactions.add({ channel: originalMessage.channel, timestamp: originalMessage.ts, name: reactionName });
        activeReactions.add(reactionName);
      } catch (error) {
        this.logger.warn('Failed to update message reaction', error);
      }
    });
  }

  private async updateTaskProgressReaction(sessionKey: string, todos: Todo[]): Promise<void> {
    if (todos.length === 0) return;
    const completed = todos.filter(t => t.status === 'completed').length;
    const inProgress = todos.filter(t => t.status === 'in_progress').length;
    const total = todos.length;
    const emoji = completed === total ? '✅' : inProgress > 0 ? '🔄' : '📋';
    await this.updateMessageReaction(sessionKey, emoji);
  }

  // --- Command parsers ---

  private isStopCommand(text: string): boolean {
    return /^-(stop|cancel|중단)$/i.test(text.trim());
  }

  private isEnginesCommand(text: string): boolean {
    return /^-(engines?|엔진)$/i.test(text.trim());
  }

  private isHelpCommand(text: string): boolean {
    return /^-?(help|commands|도움말)(\?)?$/i.test(text.trim());
  }

  private isResetCommand(text: string): boolean {
    return /^-(reset|새로시작)$|^초기화$/i.test(text.trim());
  }

  private isDefaultModeCommand(text: string): boolean {
    return /^-(?:default|d)$|^기본$/i.test(text.trim());
  }

  private isSafeCommand(text: string): boolean {
    return /^-safe$|^안전$/i.test(text.trim());
  }

  private isTrustCommand(text: string): boolean {
    return /^-trust$|^신뢰$/i.test(text.trim());
  }

  private parseModelCommand(text: string): string | null {
    const trimmed = text.trim();
    // -model <name> | -m <name> | 모델 <name>  (empty arg = show current)
    const longMatch = trimmed.match(/^-(?:model|m)(?:\s+(\S+))?$|^모델(?:\s+(\S+))?$/i);
    if (longMatch) return longMatch[1] || longMatch[2] || '';
    // Short alias commands: -opus | -o | -sonnet | -s | -haiku | -h
    const shortMatch = trimmed.match(/^-(opus|sonnet|haiku|o|s|h)$/i);
    if (shortMatch) return shortMatch[1].toLowerCase();
    return null;
  }

  // 별칭 → 실제 모델 ID. 전체 ID 는 그대로 통과.
  // 짧은 이름을 SDK 에 넘기면 SDK 기본값으로 풀려 최신이 아닐 수 있다(config.models 주석).
  private static resolveModelAlias(input: string): string {
    const map: Record<string, string> = {
      o: config.models.opus, opus: config.models.opus,
      s: config.models.sonnet, sonnet: config.models.sonnet,
      h: config.models.haiku, haiku: config.models.haiku,
    };
    return map[input.toLowerCase()] ?? input;
  }

  // !o / !s / !h prefix → one-time model override + stripped prompt.
  // Returns null if no prefix.
  private parseModelPrefix(text: string): { model: string; prompt: string } | null {
    const m = text.match(/^!([osh])\s+([\s\S]+)$/i);
    if (!m) return null;
    return { model: SlackHandler.resolveModelAlias(m[1]), prompt: m[2] };
  }

  private isCostCommand(text: string): boolean {
    return /^-cost$|^비용$/i.test(text.trim());
  }

  private isVersionCommand(text: string): boolean {
    return /^`?-(?:version|v)`?$|^버전$/i.test(text.trim());
  }

  private isSessionsCommand(text: string): boolean {
    return /^-(?:sessions?|s)(\s+(list|all|전체))?$|^세션(\s+(all|전체))?$/i.test(text.trim());
  }

  private parsePlanCommand(text: string): { prompt: string } | null {
    const match = text.trim().match(/^-plan\s+(.+)$|^계획\s+(.+)$/is);
    if (match) return { prompt: (match[1] || match[2]).trim() };
    return null;
  }

  private parseResumeCommand(text: string): { mode: 'picker' } | { mode: 'uuid'; resumeOptions: { resumeSessionId: string }; prompt?: string } | { mode: 'continue'; resumeOptions: { continueLastSession: true }; prompt?: string } | null {
    const trimmed = text.trim();

    // -continue / -c [message]
    const continueMatch = trimmed.match(/^-(?:continue|c)(?:\s+(.+))?$/is);
    if (continueMatch) {
      return { mode: 'continue', resumeOptions: { continueLastSession: true }, prompt: continueMatch[1]?.trim() || undefined };
    }

    // -resume <UUID> [message]
    const resumeUuidMatch = trimmed.match(/^-resume\s+`?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})`?(?:\s+(.+))?$/is);
    if (resumeUuidMatch) {
      return { mode: 'uuid', resumeOptions: { resumeSessionId: resumeUuidMatch[1] }, prompt: resumeUuidMatch[2]?.trim() || undefined };
    }

    // -r, -resume, resume, continue, keep going, 계속, 계속하자 (no args) → session picker
    if (/^-(r|resume)$/i.test(trimmed) || /^(resume|continue|keep\s*going|계속(하자)?)$/i.test(trimmed)) {
      return { mode: 'picker' };
    }

    // Natural language resume: short messages (≤30 chars) with resume-intent keywords
    if (trimmed.length <= 30) {
      const resumePatterns = /^(let'?s?\s*go|go\s*ahead|carry\s*on|pick\s*up|let'?s?\s*work|go|gg|start|일하자|하자|이어서|다시|시작|진행|작업|고고|ㄱㄱ)!?\.?$/i;
      if (resumePatterns.test(trimmed)) {
        return { mode: 'picker' };
      }
    }

    return null;
  }

  // --- Assistant commands ---

  private isBriefingCommand(text: string): boolean {
    return /^`?-(?:briefing|br)`?$/i.test(text.trim()) || /^브리핑$/i.test(text.trim());
  }

  private isReportCommand(text: string): boolean {
    return /^`?-(?:report|rp)`?(?:\s|$)/i.test(text.trim());
  }

  private parseReportCommand(text: string): { type?: string } {
    const match = text.trim().match(/^`?-(?:report|rp)`?\s*(.*)$/i);
    return { type: match?.[1]?.trim() || undefined };
  }

  private isNasCommand(text: string): boolean {
    return /^`?-(?:nas)`?(?:\s|$)/i.test(text.trim());
  }


  /** NAS 이동 컨펌 큐를 버튼 메시지로 게시 (`-nas` / 브리핑 후처리 공용). */

  private async handleNasCommand(threadTs: string, say: any): Promise<void> {
    try {
      const blocks = await buildNasQueueBlocks(await listNasQueue());
      if (!blocks) {
        await say({ text: '📦 NAS 이동 컨펌 대기 큐가 비어 있습니다.', thread_ts: threadTs });
        return;
      }
      await say({ text: '📦 NAS 이동 컨펌 대기', blocks, thread_ts: threadTs });
    } catch (error) {
      this.logger.error('NAS confirm queue listing failed', error);
      await say({ text: `❌ NAS 컨펌 큐 조회 실패: ${(error as Error).message}`, thread_ts: threadTs });
    }
  }

  /**
   * NAS 컨펌 버튼 처리 후 원 메시지를 최신 큐로 재렌더 (respond replace_original).
   * note = 방금 처리한 결과 한 줄 (context 블록으로 상단 표시).
   */
  private async rerenderNasMessage(respond: any, note: string): Promise<void> {
    try {
      const blocks = await buildNasQueueBlocks(await listNasQueue());
      const noteBlock = { type: 'context', elements: [{ type: 'mrkdwn', text: note }] };
      if (!blocks) {
        await respond({
          replace_original: true,
          text: note,
          blocks: [noteBlock, {
            type: 'section',
            text: { type: 'mrkdwn', text: '📦 컨펌 대기 큐가 비었습니다. 🎉' },
          }],
        });
      } else {
        await respond({ replace_original: true, text: '📦 NAS 이동 컨펌 대기', blocks: [noteBlock, ...blocks] });
      }
    } catch (error) {
      this.logger.error('NAS message rerender failed', error);
      await respond(noticeReply(`${note}\n⚠️ 목록 갱신 실패 — \`-nas\`로 재조회하세요.`));
    }
  }

  private isActionsCommand(text: string): boolean {
    return /^`?-actions`?(?:\s|$)/i.test(text.trim());
  }

  /** `-actions` 요약 · `-actions review` 지금 검토 · `-actions run` 지금 이어 가기. */
  private async handleActionsCommand(text: string, threadTs: string, locale: Locale, say: any): Promise<void> {
    if (!this.assistantScheduler) {
      await say({ text: t('assistant.notConfigured', locale), thread_ts: threadTs });
      return;
    }
    const arg = text.trim().replace(/^`?-actions`?\s*/i, '').trim().toLowerCase();
    if (arg === 'review' || arg === 'run') {
      const r = this.assistantScheduler.runActionsNow(arg);
      const key = r === 'unavailable' ? 'actions.unavailable'
        : r === 'queued' ? 'actions.queued'
          : arg === 'review' ? 'actions.reviewStarted' : 'actions.runStarted';
      await say({ text: t(key, locale), thread_ts: threadTs });
      return;
    }
    const blocks = await this.assistantScheduler.actionDigestBlocks().catch(() => null);
    if (!blocks) {
      await say({ text: t('actions.empty', locale), thread_ts: threadTs });
      return;
    }
    await say({ text: '🗂 처리 제안', blocks, thread_ts: threadTs });
  }

  /** CLI 결과를 사용자 표시용 한 줄로 (락 충돌은 안내 메시지). */
  private nasResultNote(ok: boolean, detail: string, okText: string): string {
    if (ok) return okText;
    if (detail === 'lock') return '⏳ 다른 sync 작업이 진행 중입니다 — 잠시 후 다시 시도하세요.';
    return `❌ 처리 실패:\n\`\`\`${detail.slice(0, 500)}\`\`\``;
  }

  private isAnalyzeCommand(text: string): boolean {
    return /^`?-(?:analyze|an)`?(?:\s|$)/i.test(text.trim()) || /^분석(?:\s|$)/i.test(text.trim());
  }

  private parseAnalyzeCommand(text: string): { type?: string } {
    const match = text.trim().match(/^(?:`?-(?:analyze|an)`?|분석)\s*(.*)$/i);
    return { type: match?.[1]?.trim() || undefined };
  }

  private isAssistantCommand(text: string): boolean {
    return /^`?-(?:assistant|as)`?\s/i.test(text.trim());
  }

  private parseAssistantCommand(text: string): { subcommand: string; args?: string } | null {
    const match = text.trim().match(/^`?-(?:assistant|as)`?\s+(\S+)(?:\s+(.+))?$/i);
    if (!match) return null;
    return { subcommand: match[1].toLowerCase(), args: match[2]?.trim() };
  }

  /**
   * `-report [종류]` — 처리 제안 요약과 desk 보고서 링크 (report-log 4단계 · 읽는 쪽 전환).
   *
   * 예전에는 `reports/scheduled-reports/` 를 훑어 파일을 올리고 보관 버튼을 달았다. 보관이 곧 읽음
   * 표시였고, 사람이 보는 단위가 보고서였다. 지금은 보고서가 report-log 에 회차별로 쌓이고(desk),
   * 사람은 검토를 거친 처리 제안만 결정한다 — 그래서 여기서는 요약과 링크만 낸다.
   */
  private async handleReportCommand(type: string | undefined, threadTs: string, locale: Locale, say: any): Promise<void> {
    if (!reportLogAvailable()) {
      await say({ text: t('actions.unavailable', locale), thread_ts: threadTs });
      return;
    }
    const blocks = await this.assistantScheduler?.reportReplyBlocks(type).catch(() => null);
    if (!blocks) {
      await say({ text: t('actions.readFailed', locale), thread_ts: threadTs });
      return;
    }
    await say({ text: '🗂 처리 제안 · 보고서', blocks, thread_ts: threadTs });
  }

  private async handleAssistantSubcommand(
    parsed: { subcommand: string; args?: string },
    threadTs: string,
    locale: Locale,
    say: any,
  ): Promise<void> {
    switch (parsed.subcommand) {
      case 'config': {
        const cfg = this.assistantScheduler?.getConfig();
        if (!cfg) {
          await say({ text: t('assistant.notConfigured', locale), thread_ts: threadTs });
          return;
        }
        await say({
          text: `${t('assistant.configShow', locale)}\n\`\`\`${JSON.stringify(cfg, null, 2)}\`\`\``,
          thread_ts: threadTs,
        });
        break;
      }
      case 'briefing': {
        if (parsed.args && /^\d{1,2}:\d{2}$/.test(parsed.args)) {
          this.assistantScheduler?.updateConfig({ briefingTime: parsed.args });
          await say({ text: t('assistant.configUpdated', locale), thread_ts: threadTs });
        } else {
          await say({ text: 'Usage: `-as briefing HH:MM`', thread_ts: threadTs });
        }
        break;
      }
      case 'reminder': {
        const minutes = parsed.args ? parseInt(parsed.args, 10) : NaN;
        if (!isNaN(minutes) && minutes > 0) {
          this.assistantScheduler?.updateConfig({ reminderMinutes: minutes });
          await say({ text: t('assistant.configUpdated', locale), thread_ts: threadTs });
        } else {
          await say({ text: 'Usage: `-as reminder <minutes>`', thread_ts: threadTs });
        }
        break;
      }
      default:
        await say({ text: 'Unknown subcommand. Use: `config`, `briefing`, `reminder`', thread_ts: threadTs });
    }
  }

  /**
   * Run a Claude session and return the result text (one-shot, no streaming to Slack).
   * Used by AssistantScheduler for briefing, reminders, and analysis.
   * Reuses OAuth injection (line 500-506) + for-await loop (line 525) + extractTextFromContent (line 987).
   */
  /**
   * 메모리 감시기의 종료 대상 검토 — 도구 없이 글만 주고받는 Opus(medium) 한 번(2026-09-29 사용자 결정).
   * 설정 · 규칙 파일 · 훅을 안 싣는다(`settingSources: []`) — 압박 중이라 가볍게 · 2분 안에.
   * 실패하면 null — 감시기가 규칙으로 물러난다(`process-memory-watchdog.ts` 의 `decide`).
   */
  private async reviewMemoryTarget(prompt: string): Promise<string | null> {
    try {
      const r = await this.runAssistantSession(prompt, {
        workingDirectory: os.tmpdir(),
        model: 'opus',
        effort: 'medium',
        tools: [],
        settingSources: [],
        skipMcp: true,
        noSessionPersistence: true,
        maxDurationMs: 120_000,
      });
      return r.isError ? null : r.text;
    } catch (err) {
      this.logger.warn('메모리 감시기 검토 실패 — 규칙으로 물러남', err);
      return null;
    }
  }

  private async runAssistantSession(prompt: string, opts: SpawnOpts): Promise<SessionResult> {
    // OAuth token injection — handleMessage pattern (line 494-506)
    this.accountManager.syncFromCredentialsFile();
    const oauthToken = await this.accountManager.getAccessToken();
    const env: Record<string, string> = { ...(opts.env || {}) };
    if (oauthToken) env.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;

    const commonOpts = {
      workingDirectory: opts.workingDirectory,
      model: opts.model,
      permissionMode: opts.permissionMode,
      allowedTools: opts.allowedTools,
      appendSystemPrompt: opts.appendSystemPrompt,
      systemPrompt: opts.systemPrompt,
      maxBudgetUsd: opts.maxBudgetUsd,
      resumeSessionId: opts.resumeSessionId,
      skipMcp: opts.skipMcp,
      noSessionPersistence: opts.noSessionPersistence,
      tools: opts.tools,
      settings: opts.settings,
      settingSources: opts.settingSources,
      additionalDirectories: opts.additionalDirectories,
      env,
    };

    // **구간을 잰다** (2026-10-01) — 띄우기 시작부터 뜸(init) · 첫 글자 · 끝. 합계만 남으면
    // 느린 곳이 띄우기인지 써 내려가기인지 운영에서 가를 수 없다. 원장에 그대로 옮긴다.
    const t0 = Date.now();
    const timing: { initMs?: number; firstMs?: number; resultMs?: number } = {};
    const sdkOpts = { ...commonOpts, effort: opts.effort };
    const proc = this.sdkHandler.runQuery(prompt, sdkOpts);

    this.logger.info('Assistant session started', { via: 'sdk' });

    // Session timeout — kill process if it exceeds maxDurationMs
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    let graceTimer: ReturnType<typeof setTimeout> | null = null;
    let timedOut = false;
    if (opts.maxDurationMs) {
      killTimer = setTimeout(() => {
        timedOut = true;
        this.logger.warn('Assistant session timeout, killing process', {
          maxDurationMs: opts.maxDurationMs,
        });
        proc.interrupt();
      }, opts.maxDurationMs);
    }

    // Collect text, sessionId, cost, subtype, and usage from events
    let text = '';
    let sessionId = '';
    let costUsd = 0;
    let subtype = 'success';
    let usage: SessionUsage | undefined;
    let resultReceived = false;
    // **원장에 값만 남으면 폭주를 볼 수가 없다.** 2026-08-14 에 회당 $45 짜리
    // 회차의 원인(같은 명령 900회 되부르기)을 세는 데 금지된 자료(트랜스크립트)
    // 말고는 길이 없었다. 세는 값은 여기서 같이 남긴다.
    let turns = 0;
    let toolCalls = 0;
    // 그중 쓰기를 할 수 있는 도구 — 예약 일 폴백이 「읽기만 돌았나」를 가른다(`spawnOrFallback` · 2026-10-15 검토).
    let writeToolCalls = 0;
    // **리미트는 산문이 아니라 이벤트로 온다.** 여기서 안 받으면 부르는 쪽은
    // 모델이 쓴 본문을 정규식으로 훑는 수밖에 없고, 그러면 「429를 분석한
    // 보고서」가 「429에 걸린 세션」으로 둔갑한다(2026-05~08 오탐 13회).
    // 엔진 상태에 적는 것은 전송 탭(`engine-tap.ts`)이 이미 했다 — 여기서는 부른 쪽에 돌려주기만 한다.
    let rateLimited = false;
    let rateLimitResetsAt: number | undefined;
    let isError = false;

    for await (const event of proc) {
      if (event.type === 'system' && (event as any).subtype === 'init') {
        sessionId = (event as CliInitEvent).session_id;
        if (timing.initMs === undefined) timing.initMs = Date.now() - t0;
      }
      // 첫 글자 — 부분 메시지(`stream_event`)가 켜진 길(SDK)에서만 잡힌다.
      if (timing.firstMs === undefined && event.type === 'stream_event'
          && (event as any).event?.type === 'content_block_delta') {
        timing.firstMs = Date.now() - t0;
      }
      // status: 'allowed' | 'allowed_warning' | 'rejected'.
      // **'rejected' 만 실제 차단이다** — 'allowed_warning' 은 한도에 가까워졌다는
      // 예고일 뿐 요청은 그대로 통과한다. 곁의 `overageStatus` 도 판정에 쓰지
      // 않는다(정액 초과분 거절이라 `status: allowed` 와 함께 상시로 온다).
      if (event.type === 'rate_limit_event') {
        const info = (event as CliRateLimitEvent).rate_limit_info;
        if (info?.status === 'rejected') {
          rateLimited = true;
          if (info.resetsAt) rateLimitResetsAt = info.resetsAt;
        }
        continue;
      }
      if (event.type === 'assistant') {
        const assistantEvent = event as CliAssistantEvent;
        const content = assistantEvent.message.content || [];
        turns += 1;
        for (const part of content) {
          if ((part as any)?.type === 'tool_use') {
            toolCalls += 1;
            if (isWriteTool(String((part as any).name ?? ''))) writeToolCalls += 1;
          }
        }
        const extracted = this.extractTextFromContent(content);
        if (extracted) text = extracted;  // Keep only last assistant turn (drop intermediate explanations)
      }
      if (event.type === 'result' && !resultReceived) {
        resultReceived = true;
        timing.resultMs = Date.now() - t0;
        const resultEvent = event as CliResultEvent;
        costUsd = resultEvent.total_cost_usd || 0;
        subtype = resultEvent.subtype || 'success';
        isError = resultEvent.is_error === true;
        const rawUsage = (event as any).usage;
        if (rawUsage) {
          usage = {
            inputTokens: rawUsage.input_tokens ?? 0,
            outputTokens: rawUsage.output_tokens ?? 0,
            cacheCreateTokens: rawUsage.cache_creation_input_tokens ?? 0,
            cacheReadTokens: rawUsage.cache_read_input_tokens ?? 0,
          };
        }
        // 정상이라면 result 직후 스트림이 닫힌다. 닫히지 않으면(자식 프로세스/훅
        // hang — 2026-06-11 data-sync가 00:39 완료 후 01:00 wall-clock 캡까지
        // 잡혀 error_timeout으로 오분류) grace 후 강제 종료하되 결과는 살린다.
        graceTimer = setTimeout(() => {
          this.logger.warn('Assistant session stream still open after result, aborting (grace)', {
            sessionId,
            graceMs: RESULT_GRACE_MS,
          });
          proc.interrupt();
        }, RESULT_GRACE_MS);
      }
    }

    if (killTimer) clearTimeout(killTimer);
    if (graceTimer) clearTimeout(graceTimer);

    // result를 받은 뒤의 abort(grace/wall-clock)는 timeout이 아니라 정상 완료.
    if (timedOut && !resultReceived) {
      return { text, costUsd, sessionId, subtype: 'error_timeout', usage, turns, toolCalls, writeToolCalls,
               rateLimited, rateLimitResetsAt, isError: true, timing };
    }

    // **다음 차례를 위해 같은 옵션으로 하나 띄워 둔다**(좁은 길이 켬 · 2026-10-01). 방금 쓴 그
    // 객체를 그대로 넘겨 지문이 맞게 한다. 실패·한도에 걸린 차례 뒤에는 안 띄운다.
    if (opts.prewarmAfter && !isError && !rateLimited) {
      this.sdkHandler.prewarm(sdkOpts);
    }

    return { text, costUsd, sessionId, subtype, usage, turns, toolCalls, writeToolCalls,
             rateLimited, rateLimitResetsAt, isError, timing };
  }

  /**
   * Cancel all pending scheduled messages created by this bot.
   * Prevents orphaned rate limit notifications from firing after pm2 restart.
   */
  private async cancelOrphanedScheduledMessages(): Promise<void> {
    const result = await this.app.client.chat.scheduledMessages.list({});
    const messages = (result as any).scheduled_messages;
    if (!messages || messages.length === 0) return;
    this.logger.info(`Found ${messages.length} orphaned scheduled message(s), cancelling`);
    for (const msg of messages) {
      try {
        await this.app.client.chat.deleteScheduledMessage({
          channel: msg.channel_id,
          scheduled_message_id: msg.id,
        });
        this.logger.debug('Cancelled orphaned scheduled message', { id: msg.id, channel: msg.channel_id });
      } catch (err) {
        this.logger.warn('Failed to cancel scheduled message', { id: msg.id, error: err });
      }
    }
  }

  private isRateLimitError(error: any): boolean {
    return isRateLimitErrorUtil(error);
  }

  private isRateLimitText(text: string): boolean {
    return isRateLimitTextUtil(text);
  }

  private isMcpInfoCommand(text: string): boolean {
    return /^-mcp(\s+(info|list|status))?(\?)?$/i.test(text.trim());
  }

  private isMcpReloadCommand(text: string): boolean {
    return /^-mcp\s+(reload|refresh)$/i.test(text.trim());
  }

  // --- Session picker ---

  private readonly PICKER_PAGE_SIZE = 5;
  private readonly MAX_PICKER_SESSIONS = 15; // 3*15+5=50 blocks, Slack hard limit

  private buildPickerBlocks(sessions: SessionInfo[], pickerId: string, shownCount: number, locale: Locale): any[] {
    const visible = sessions.slice(0, shownCount);
    const blocks: any[] = [
      { type: 'section', text: { type: 'mrkdwn', text: `📂 ${t('picker.title', locale)}` } },
    ];

    visible.forEach((s, index) => {
      const title = s.summary || s.firstPrompt || t('picker.noTitle', locale);
      const label = s.projectLabel;
      const branch = s.gitBranch;
      const relTime = formatRelativeTime(s.modified, locale);
      const projectInfo = branch ? `*${label}* · \`${branch}\`` : `*${label}*`;
      const shortId = s.sessionId.substring(0, 8);

      blocks.push({ type: 'divider' });
      blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `${projectInfo} · _${relTime}_ · \`${shortId}\`\n${title}\n\`${s.projectPath}\`` }],
      });
      blocks.push({
        type: 'actions',
        elements: [{
          type: 'button',
          text: { type: 'plain_text', text: t('picker.resume', locale) },
          action_id: `pick_${index + 1}`,
          value: JSON.stringify({ pickerId, index }),
        }],
      });
    });

    // "Show more" or cap-reached guidance
    if (shownCount < sessions.length) {
      blocks.push({ type: 'divider' });
      if (shownCount < this.MAX_PICKER_SESSIONS) {
        blocks.push({
          type: 'actions',
          elements: [{
            type: 'button',
            text: { type: 'plain_text', text: t('picker.showMore', locale, { count: Math.min(this.PICKER_PAGE_SIZE, sessions.length - shownCount) }) },
            action_id: 'picker_show_more',
            value: JSON.stringify({ pickerId }),
          }],
        });
      } else {
        const remaining = sessions.length - shownCount;
        blocks.push({
          type: 'context',
          elements: [{ type: 'mrkdwn', text: t('picker.moreAvailable', locale, { remaining: remaining.toString() }) }],
        });
      }
    }

    blocks.push({ type: 'divider' });
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `${t('picker.footer', locale)} (${shownCount}/${sessions.length})` }] });

    return blocks;
  }

  private async showSessionPicker(channel: string, threadTs: string, user: string, say: any, locale: Locale = 'en'): Promise<void> {
    const knownPaths = this.workingDirManager.getKnownPathsMap();
    const sessions = this.sessionScanner.listRecentSessions(30, knownPaths);

    if (sessions.length === 0) {
      await say({ text: `ℹ️ ${t('picker.noSessions', locale)}`, thread_ts: threadTs });
      return;
    }

    const pickerId = `picker-${Date.now()}`;
    const shownCount = Math.min(this.PICKER_PAGE_SIZE, sessions.length);
    const blocks = this.buildPickerBlocks(sessions, pickerId, shownCount, locale);

    const result = await say({ text: `📂 ${t('picker.title', locale)}`, blocks, thread_ts: threadTs });

    // Store picker state
    const timeout = setTimeout(() => {
      this.pendingPickers.delete(pickerId);
      this.app.client.chat.update({
        channel, ts: result.ts,
        text: `📂 ${t('picker.expired', locale)}`,
        blocks: [],
      }).catch(() => {});
    }, 300_000); // 5 minutes

    this.pendingPickers.set(pickerId, {
      sessions,
      channel,
      threadTs,
      user,
      messageTs: result.ts,
      timeout,
      shownCount,
      locale,
    });
  }

  // --- Session listing ---

  private getProjectsDir(cwd: string): string {
    const encoded = cwd.replace(/[^a-zA-Z0-9]/g, '-');
    return path.join(os.homedir(), '.claude', 'projects', encoded);
  }

  private listSessions(cwd: string, limit: number = 10): Array<{ id: string; date: Date; summary: string; preview: string }> {
    const projectsDir = this.getProjectsDir(cwd);
    if (!fs.existsSync(projectsDir)) return [];

    const files = fs.readdirSync(projectsDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => {
        const fullPath = path.join(projectsDir, f);
        return { name: f, path: fullPath, mtime: fs.statSync(fullPath).mtime };
      })
      .sort((a, b) => b.mtime.getTime() - a.mtime.getTime())
      .slice(0, limit);

    const sessions: Array<{ id: string; date: Date; summary: string; preview: string }> = [];
    for (const file of files) {
      const sessionId = file.name.replace('.jsonl', '');
      let summary = '';
      let preview = '';
      try {
        const content = fs.readFileSync(file.path, 'utf-8');
        const lines = content.split('\n').slice(0, 100);
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.type === 'summary' && msg.summary && !summary) summary = msg.summary;
            if (msg.type === 'user' && !msg.isMeta && !preview) {
              const msgContent = msg.message?.content;
              if (Array.isArray(msgContent)) {
                const textPart = msgContent.find((p: any) => p.type === 'text' && p.text);
                if (textPart) preview = textPart.text;
              } else if (typeof msgContent === 'string') {
                preview = msgContent;
              }
            }
            if (summary && preview) break;
          } catch { /* skip */ }
        }
      } catch { /* skip */ }
      sessions.push({ id: sessionId, date: file.mtime, summary, preview: preview.substring(0, 100) + (preview.length > 100 ? '...' : '') });
    }
    return sessions;
  }

  private formatSessionsList(sessions: Array<{ id: string; date: Date; summary: string; preview: string }>, locale: Locale = 'en'): string {
    if (sessions.length === 0) return `ℹ️ ${t('sessions.noSessions', locale)}`;
    let msg = `${t('sessions.title', locale)}\n\n`;
    for (const s of sessions) {
      const dateStr = formatDateTime(s.date, locale);
      const title = s.summary || s.preview || t('sessions.noPreview', locale);
      msg += `• \`${s.id}\`\n  ${dateStr} — ${title}\n\n`;
    }
    msg += t('sessions.resumeHint', locale);
    return msg;
  }

  // getHelpText is now provided by messages.ts (getHelpTextI18n)

  // --- Bot user ID ---

  private async getBotUserId(): Promise<string> {
    if (!this.botUserId) {
      try {
        const response = await this.app.client.auth.test();
        this.botUserId = response.user_id as string;
      } catch (error) {
        this.logger.error('Failed to get bot user ID', error);
        this.botUserId = '';
      }
    }
    return this.botUserId;
  }

  // --- Channel join ---

  private async handleChannelJoin(channelId: string, say: any, locale: Locale = 'en'): Promise<void> {
    try {
      const channelInfo = await this.app.client.conversations.info({ channel: channelId });
      const channelName = (channelInfo.channel as any)?.name || 'this channel';

      let welcomeMessage = `👋 ${t('welcome.greeting', locale)}\n\n`;
      welcomeMessage += `${t('welcome.needCwd', locale, { channel: channelName })}\n\n`;
      if (config.baseDirectory) {
        welcomeMessage += `${t('welcome.useRelative', locale, { baseDir: config.baseDirectory })}\n\n`;
      } else {
        welcomeMessage += `${t('welcome.useAbsolute', locale)}\n\n`;
      }
      welcomeMessage += `${t('welcome.channelDefault', locale)}\n\n`;
      welcomeMessage += t('welcome.helpHint', locale);

      await say({ text: welcomeMessage });
      this.logger.info('Sent welcome message to channel', { channelId, channelName });
    } catch (error) {
      this.logger.error('Failed to handle channel join', error);
    }
  }

  // --- Event handlers ---

  /**
   * 지난 기동에서 처리 중이던 대화가 있으면 알리고 그 기록만 지운다.
   *
   * **이 기동 뒤에 시작한 차례는 안 건드린다** — 기동 12초 뒤에 돌므로 그 사이 시작한 차례가 이미 적혀 있다.
   * 통째로 비우면 그 차례가 끊긴 것으로 알려지고 나중에 다시 돌아 같은 일을 두 번 한다. 시각을 못 읽으면 옛 것으로 본다.
   */
  private async reportInterruptedSessions(): Promise<void> {
    // 지난 기동의 것은 기동 때 떠 둔 것에서(생성자 · `snapshotBootInflight`) — 지금 파일은 그 사이 새 차례가 같은
    // 열쇠로 덮었을 수 있다. 떠 둔 것이 없으면(검사 껍데기) 지금 파일. 남길 것은 지금 파일의 이 기동 뒤 기록뿐.
    const prior = bootInflight ?? readInflight();
    bootInflight = null;
    const isLive = (r: InflightRecord | undefined) => {
      const at = Date.parse(r?.startedAt ?? '');
      return Number.isFinite(at) && at >= BOOT_MS;
    };
    const pending: Record<string, InflightRecord> = {};
    for (const [k, r] of Object.entries(prior)) if (!isLive(r)) pending[k] = r;
    const keys = Object.keys(pending);
    if (keys.length === 0) return;
    const live: Record<string, InflightRecord> = {};
    for (const [k, r] of Object.entries(readInflight())) if (isLive(r)) live[k] = r;
    writeInflight(live);
    this.logger.warn('Reporting interrupted sessions', { count: keys.length });
    const v2 = holdV2On();
    // **끊긴 것도 캡처에 남긴다.** 「다시 보내주세요」는 사람이 친 말에나
    // 통하지, 판이나 메일 폴러가 민 것은 보낸 사람이 그 화면을 떠났다.
    //
    // **표시를 다 남긴 뒤에 돌아간다**(2026-10-14 · 켜는 문과 무관한 고침) — 바로 뒤에 기동
    // 드레인이 돈다. 기다리지 않으면 끊긴 차례의 자국이 아직 안 찍혀 그 건이 목록에서 빠진다.
    await Promise.all(keys.map((key) => this.markInterrupted(pending[key], v2)));

    // 보류 v2 — 실제로 자동으로 이어질 것(드레인 목록에 든 것)만 「다시 보내지 않으셔도 됩니다」로
    // 묶는다. 목록에 안 든 것(닫힌 채 끊김 · 첨부를 못 보관함 등)은 예전처럼 다시 보내 달라고 한다.
    const auto = v2 ? new Set((await pendingHeld(50)).run.map((i) => i.id)) : new Set<string>();
    const groups = new Map<string, { channel: string; threadTs?: string; n: number }>();
    for (const key of keys) {
      const r = pending[key];
      if (r.captureId && auto.has(r.captureId)) {
        const g = `${r.channel}:${r.threadTs ?? ''}`;
        const cur = groups.get(g) ?? { channel: r.channel, threadTs: r.threadTs, n: 0 };
        cur.n += 1;
        groups.set(g, cur);
        continue;
      }
      await this.app.client.chat.postMessage({
        channel: r.channel,
        thread_ts: r.threadTs,
        text: '⚠️ 봇이 다시 시작되면서 처리 중이던 요청이 끊겼습니다 — 답을 못 드렸습니다.\n> '
          + r.text + '\n다시 보내주세요.',
      }).catch(() => { });
    }
    for (const g of groups.values()) {
      await this.app.client.chat.postMessage({
        channel: g.channel,
        thread_ts: g.threadTs,
        text: `⚠️ 재시작으로 끊긴 요청 ${g.n}건 — 자동으로 이어서 처리합니다(다시 보내지 않으셔도 됩니다)`,
      }).catch(() => { });
    }
  }

  /**
   * 재시작으로 끊긴 차례 하나에 실패 표시를 남긴다. 보류 v2 면 처리 중 기록의 도구로 가른다 —
   * 쓰기가 돌았으면 `partial`(그 세션으로 이어 감) · 아니면 `interrupted`(처음부터).
   */
  private markInterrupted(r: InflightRecord, v2: boolean): Promise<void> {
    const id = r.captureId ?? '';
    if (!v2) return markCaptureFailed(id, 'interrupted');
    if (!id) return Promise.resolve();
    const { extra, writeRan } = buildHoldExtra(id, r.steps ?? [], r.heldSteps ?? [], r.sessionId, r.files ?? []);
    return markCaptureFailed(id, writeRan ? 'partial' : 'interrupted', extra);
  }

  setupEventHandlers() {
    // Handle direct messages
    this.app.message(async ({ message, say }) => {
      if (message.subtype === undefined && 'user' in message) {
        this.logger.info('Handling direct message event');
        const msg = message as MessageEvent;
        if (msg.text) {
          msg.text = msg.text.replace(/<@[^>]+>/g, '').trim();
        }
        await this.handleMessage(msg, say);
      }
    });

    // Handle app mentions
    this.app.event('app_mention', async ({ event, say }) => {
      this.logger.info('Handling app mention event');
      const text = event.text.replace(/<@[^>]+>/g, '').trim();
      await this.handleMessage({ ...event, text } as MessageEvent, say);
    });

    // Handle file uploads in threads
    this.app.event('message', async ({ event, say }) => {
      if (event.subtype === 'file_share' && 'user' in event && event.files) {
        this.logger.info('Handling file upload event');
        await this.handleMessage(event as MessageEvent, say);
      }
    });

    // Handle bot being added to channels
    this.app.event('member_joined_channel', async ({ event, say }) => {
      if (event.user === await this.getBotUserId()) {
        this.logger.info('Bot added to channel', { channel: event.channel });
        await this.handleChannelJoin(event.channel, say);
      }
    });

    // Cancel any orphaned scheduled notifications from previous runs
    this.cancelOrphanedScheduledMessages().catch(err =>
      this.logger.warn('Failed to cancel orphaned scheduled messages', err),
    );

    // Start assistant scheduler (briefing, reminders, analysis)
    this.assistantScheduler?.start();

    // --- Interactive button handlers ---

    // 옛 「📄 보고서 확인」 버튼 — 이미 올라간 브리핑 메시지에 남아 있다. 새 `-report` 와 같은 답을 낸다.
    this.action('briefing_view_reports', async ({ ack, body }) => {
      await ack();
      const channel = (body as any).channel?.id || (body as any).container?.channel_id;
      const threadTs = (body as any).message?.ts;
      const userId = (body as any).user?.id;
      if (!channel) return;
      const locale = await this.getUserLocale(userId).catch(() => 'ko' as Locale);
      await this.handleReportCommand(undefined, threadTs, locale, async (msg: any) => {
        await this.app.client.chat.postMessage({ channel, ...msg });
      });
    });

    // 옛 보관 버튼 셋 — 보관(= 읽음 표시)은 폐지됐다. 누르면 처리기가 없다는 오류 대신 까닭을 알린다.
    this.action(/^archive_(report|all_reports|clean_reports)$/, async ({ ack, body, respond }) => {
      await ack();
      const locale = await this.getUserLocale((body as any).user?.id).catch(() => 'ko' as Locale);
      await respond(noticeReply(t('report.archiveRetired', locale))).catch(() => {});
    });

    // --- NAS 이동 컨펌 버튼 (inbox auto-classify) ---
    // 카드 단위 결정: 파일 1건 또는 폴더 통째(dir 카드). value = id hex prefix.

    this.action('nas_confirm_item', async ({ ack, body, respond }) => {
      await ack();
      try {
        const id = (body as any).actions[0].value as string;
        const r = await confirmAndApply([id]).catch(e => ({ ok: false, detail: String(e) }));
        await this.rerenderNasMessage(respond, this.nasResultNote(r.ok, r.detail, `✅ NAS 이동 완료 (\`${id}\`)`));
      } catch (error) {
        this.logger.error('NAS confirm item failed', error);
        await respond(noticeReply('❌ 처리 실패')).catch(() => {});
      }
    });

    this.action('nas_reject_item', async ({ ack, body, respond }) => {
      await ack();
      try {
        const id = (body as any).actions[0].value as string;
        const r = await rejectItems([id]).catch(e => ({ ok: false, detail: String(e) }));
        await this.rerenderNasMessage(respond, this.nasResultNote(r.ok, r.detail, `❌ 거부 처리 — 파일은 Z:\\ABYSS에 남습니다 (\`${id}\`)`));
      } catch (error) {
        this.logger.error('NAS reject item failed', error);
        await respond(noticeReply('❌ 처리 실패')).catch(() => {});
      }
    });

    this.action('nas_hold_item', async ({ ack, respond }) => {
      await ack();
      // DB 무변경 — 큐에 남아 다음 브리핑에 다시 표시 (무기한 대기 + 7일 🔴 정책)
      await respond(noticeReply('⏸️ 보류 — 다음 브리핑에 다시 표시됩니다.'));
    });

    this.action('nas_confirm_all_safe', async ({ ack, body, respond }) => {
      await ack();
      try {
        const { ids } = JSON.parse((body as any).actions[0].value);
        const r = await confirmAndApply(ids);
        await this.rerenderNasMessage(respond, this.nasResultNote(r.ok, r.detail, `✅ ${ids.length}건 NAS 이동 완료 (⚠️ 항목은 개별 결정)`));
      } catch (error) {
        this.logger.error('NAS bulk confirm failed', error);
        await respond(noticeReply('❌ 일괄 승인 실패'));
      }
    });

    this.action('nas_reject_all', async ({ ack, body, respond }) => {
      await ack();
      try {
        const { ids } = JSON.parse((body as any).actions[0].value);
        const r = await rejectItems(ids);
        await this.rerenderNasMessage(respond, this.nasResultNote(r.ok, r.detail, `❌ ${ids.length}건 거부 — 파일은 Z:\\ABYSS에 남습니다`));
      } catch (error) {
        this.logger.error('NAS bulk reject failed', error);
        await respond(noticeReply('❌ 일괄 거부 실패'));
      }
    });

    // 분류 변경 드롭다운 — block_id `nas_<idPrefix>`에서 대상 카드 식별
    this.action('nas_retarget_item', async ({ ack, body, respond }) => {
      await ack();
      try {
        const action = (body as any).actions[0];
        const id = String(action.block_id || '').replace(/^nas_/, '');
        const category = action.selected_option?.value as string;
        if (!id || !category) return;
        const r = await retargetItem(id, category);
        await this.rerenderNasMessage(respond, this.nasResultNote(r.ok, r.detail, `📂 분류 변경 → \`${category}\` (target 재계산됨 — ✅로 확정)`));
      } catch (error) {
        this.logger.error('NAS retarget failed', error);
        await respond(noticeReply('❌ 분류 변경 실패'));
      }
    });

    // --- 처리 제안 버튼 (report-log) ---
    // 값은 제안 번호뿐이고 결정은 action_id 에 있다. 번호 형식 · 결정 이름은 실행기가 다시 본다
    // (버튼 값은 사용자 쪽에서 보이므로 믿지 않는다). 누른 제안의 버튼 줄만 결과 한 줄로 바꾼다.
    this.action(/^actions_(approve|hold|reject|reopen)$/, async ({ ack, body, respond }) => {
      await ack();
      try {
        if (!this.assistantScheduler) return;
        const act = (body as any).actions[0];
        const decision = String(act.action_id || '').replace(/^actions_/, '');
        const id = String(act.value || '');
        const r = await this.assistantScheduler.decideAction(id, decision);
        await respond(decisionReply(r, (body as any).message, id, '🗂 처리 제안'));
      } catch (error) {
        this.logger.error('Action proposal decision failed', error);
        await respond(noticeReply('❌ 처리 실패')).catch(() => {});
      }
    });

    // --- 매일 개선 제안 버튼 (2026-10-02) ---
    // 처리 제안과 같은 모양 · 다른 갈래 — 「업무로 등록」은 실행으로 안 이어진다(처음 2주는 등록만).
    // 값은 제안 번호뿐이고 결정은 action_id 에 있다. 번호 · 결정 이름은 스케줄러가 다시 본다.
    this.action(/^improve_(register|hold|drop)$/, async ({ ack, body, respond }) => {
      await ack();
      try {
        if (!this.assistantScheduler) return;
        const act = (body as any).actions[0];
        const decision = String(act.action_id || '').replace(/^improve_/, '');
        const id = String(act.value || '');
        const r = await this.assistantScheduler.decideImprove(id, decision);
        await respond(decisionReply(r, (body as any).message, id, '💡 개선 제안'));
      } catch (error) {
        this.logger.error('Improvement proposal decision failed', error);
        await respond(noticeReply('❌ 처리 실패')).catch(() => {});
      }
    });

    // Permission denial: "Allow All & Resume" — approve all denied tools and resume
    this.action('allow_all_denied_tools', async ({ ack, body, respond }) => {
      await ack();
      try {
        const actionLocale = await this.getUserLocale((body as any).user.id);
        const actionValue = JSON.parse((body as any).actions[0].value);
        const denial = this.pendingDenials.get(actionValue.denialId);
        if (!denial) {
          await respond(noticeReply(`⚠️ ${t('approval.expired', actionLocale)}`));
          return;
        }

        // Register each denied tool as always-approved for this channel
        let toolSet = this.channelAlwaysApproveTools.get(denial.channel);
        if (!toolSet) { toolSet = new Set(); this.channelAlwaysApproveTools.set(denial.channel, toolSet); }
        for (const tool of denial.deniedTools) toolSet.add(tool);
        this.pendingDenials.delete(actionValue.denialId);

        await respond({ response_type: 'in_channel', text: `🔓 ${t('permission.resuming', actionLocale)}` });

        // Resume the session — tell Claude the tools are now approved so it retries
        const toolNames = denial.deniedTools.join(', ');
        const resumePrompt = `The following tools have been approved: ${toolNames}. Please retry the previously denied operation.`;
        const event: MessageEvent = {
          user: denial.user, channel: denial.channel,
          thread_ts: denial.threadTs, ts: denial.threadTs ?? '',
          text: `-resume ${denial.sessionId} ${resumePrompt}`,
        };
        const sayCb = async (msg: any) => this.app.client.chat.postMessage({ channel: denial.channel, ...msg });
        await this.handleMessage(event, sayCb);
      } catch (error) {
        this.logger.error('Error handling allow_all_denied_tools', error);
      }
    });

    // Permission denial: "Allow <tool>" — one-time approve and resume
    this.action(/^allow_denied_tool_/, async ({ ack, body, respond }) => {
      await ack();
      try {
        const actionLocale = await this.getUserLocale((body as any).user.id);
        const actionValue = JSON.parse((body as any).actions[0].value);
        const denial = this.pendingDenials.get(actionValue.denialId);
        if (!denial) {
          await respond(noticeReply(`⚠️ ${t('approval.expired', actionLocale)}`));
          return;
        }

        // Track one-time approved tools for this denial (not channel-wide)
        if (!denial.approvedTools) denial.approvedTools = new Set();
        denial.approvedTools.add(actionValue.tool);

        await respond(noticeReply(`✅ ${t('permission.allowTool', actionLocale, { toolName: actionValue.tool })}`));

        // Check if all denied tools are now approved (one-time or channel-wide)
        const channelSet = this.channelAlwaysApproveTools.get(denial.channel) || new Set();
        const allApproved = denial.deniedTools.every(tl => denial.approvedTools!.has(tl) || channelSet.has(tl));
        if (allApproved) {
          this.pendingDenials.delete(actionValue.denialId);

          await this.app.client.chat.postMessage({
            channel: denial.channel,
            thread_ts: denial.threadTs,
            text: `🔓 ${t('permission.resuming', actionLocale)}`,
          });

          // Resume with one-time + channel-wide approved tools
          const oneTimeTools = [...(denial.approvedTools || [])];
          const toolNames = denial.deniedTools.join(', ');
          const resumePrompt = `The following tools have been approved: ${toolNames}. Please retry the previously denied operation.`;
          const event: MessageEvent = {
            user: denial.user, channel: denial.channel,
            thread_ts: denial.threadTs, ts: denial.threadTs ?? '',
            text: `-resume ${denial.sessionId} ${resumePrompt}`,
          };
          const sayCb = async (msg: any) => this.app.client.chat.postMessage({ channel: denial.channel, ...msg });
          // Store one-time tools temporarily so handleMessage can pick them up
          this.pendingOneTimeTools.set(`${denial.user}-${denial.channel}-${denial.threadTs || 'direct'}`, oneTimeTools);
          await this.handleMessage(event, sayCb);
        }
      } catch (error) {
        this.logger.error('Error handling allow_denied_tool', error);
      }
    });

    // Plan execution
    this.action('execute_plan', async ({ ack, body, respond }) => {
      await ack();
      const actionLocale = await this.getUserLocale((body as any).user.id);
      const planId = (body as any).actions[0].value;
      const planInfo = this.pendingPlans.get(planId);
      if (!planInfo) {
        // 원래 메시지를 이 한 줄로 바꿔 쓴다(replace_original 없음) — 버튼만 있던 메시지라 잃는 것이 없고
        // 그 버튼은 이미 죽었다. 남겨야 하는 답은 noticeReply(`check:actions` ⑤c).
        await respond({ response_type: 'ephemeral', text: `⚠️ ${t('plan.expired', actionLocale)}` });
        return;
      }
      this.pendingPlans.delete(planId);

      await respond({ response_type: 'in_channel', text: `🚀 ${t('plan.executing', actionLocale)}` });

      // Execute by resuming the plan session with acceptEdits mode
      const { channel, threadTs, user, sessionId, prompt } = planInfo;
      // threadTs 가 undefined 면 DM(채널에 바로 게시)이다. `ts` 는 타입상 필수인데
      // 이 합성 이벤트에서는 스레드 대체값으로만 쓰이고, thread_ts 가 이미 진실을
      // 담고 있으므로 빈 값이어도 게시 위치가 달라지지 않는다.
      const event: MessageEvent = { user, channel, thread_ts: threadTs, ts: threadTs ?? '', text: `-resume ${sessionId} Execute the plan you created.` };
      const say = async (msg: any) => {
        return this.app.client.chat.postMessage({ channel, ...msg });
      };
      // Execute with the channel's current permission mode (defaults to 'default' with interactive approval)
      await this.handleMessage(event, say);
    });

    this.action('cancel_plan', async ({ ack, body, respond }) => {
      await ack();
      const actionLocale = await this.getUserLocale((body as any).user.id);
      const planId = (body as any).actions[0].value;
      this.pendingPlans.delete(planId);
      // 버튼만 있던 메시지를 결과 한 줄로 바꿔 쓴다(위 계획 만료와 같은 까닭).
      await respond({ response_type: 'ephemeral', text: t('plan.cancelled', actionLocale) });
    });

    // Session picker "Show more" button
    this.action('picker_show_more', async ({ ack, body }) => {
      await ack();
      try {
        const actionValue = JSON.parse((body as any).actions[0].value);
        const picker = this.pendingPickers.get(actionValue.pickerId);
        if (!picker) return;

        // Expand by PICKER_PAGE_SIZE (capped by MAX_PICKER_SESSIONS)
        picker.shownCount = Math.min(picker.shownCount + this.PICKER_PAGE_SIZE, picker.sessions.length, this.MAX_PICKER_SESSIONS);
        const blocks = this.buildPickerBlocks(picker.sessions, actionValue.pickerId, picker.shownCount, picker.locale);

        await this.app.client.chat.update({
          channel: picker.channel,
          ts: picker.messageTs,
          text: `📂 ${t('picker.title', picker.locale)}`,
          blocks,
        }).catch(() => {});
      } catch (error) {
        this.logger.error('Error handling picker show more', error);
      }
    });

    // Session picker buttons
    this.action(/^pick_\d+$/, async ({ ack, body }) => {
      await ack();
      try {
        const actionLocale = await this.getUserLocale((body as any).user?.id);
        const actionValue = JSON.parse((body as any).actions[0].value);
        const picker = this.pendingPickers.get(actionValue.pickerId);
        if (!picker) {
          await this.app.client.chat.postEphemeral({
            channel: (body as any).channel?.id,
            user: (body as any).user?.id,
            text: `⚠️ ${t('picker.expiredAction', actionLocale)}`,
          });
          return;
        }

        const session = picker.sessions[actionValue.index];
        if (!session) return;

        clearTimeout(picker.timeout);
        this.pendingPickers.delete(actionValue.pickerId);

        // 1. Auto-switch cwd to the session's project path
        if (session.projectPath && path.isAbsolute(session.projectPath)) {
          this.workingDirManager.setWorkingDirectory(
            picker.channel, session.projectPath, picker.threadTs, picker.user
          );
        }

        // 2. Update picker message to show selection
        const title = session.summary || session.firstPrompt || t('picker.noTitle', actionLocale);
        const cwdNote = path.isAbsolute(session.projectPath) ? `\n_cwd → ${session.projectPath}_` : '';
        await this.app.client.chat.update({
          channel: picker.channel,
          ts: picker.messageTs,
          text: `📂 ${t('picker.resuming', actionLocale, { title })}${cwdNote}`,
          blocks: [],
        }).catch(() => {});

        // Show terminal coexistence tip
        await this.app.client.chat.postMessage({
          channel: picker.channel,
          thread_ts: picker.threadTs,
          text: t('hint.resumeTerminal', actionLocale),
          blocks: [
            { type: 'context', elements: [{ type: 'mrkdwn', text: t('hint.resumeTerminal', actionLocale) }] },
          ],
        }).catch(() => {});

        // 3. Resume session in the same thread
        const event: MessageEvent = {
          user: picker.user,
          channel: picker.channel,
          thread_ts: picker.threadTs,
          ts: picker.threadTs,
          text: `-resume ${session.sessionId}`,
        };
        const sayCb = async (msg: any) => this.app.client.chat.postMessage({ channel: picker.channel, ...msg });
        await this.handleMessage(event, sayCb);
      } catch (error) {
        this.logger.error('Error handling session picker selection', error);
      }
    });


    // 한도 안내의 「취소」 — 캡처를 버려 회복 시각의 드레인이 다시 안 돌린다.
    // 값의 `retryId` · `rlqId` 는 예전 버튼 모양이다(지금 버튼은 `captureId` 만 싣는다).
    this.action('cancel_retry', async ({ ack, body, respond }) => {
      await ack();
      const actionLocale = await this.getUserLocale((body as any).user.id);
      const raw = (body as any).actions[0].value;
      // 예전 형식(문자열 그대로)도 받는다 — 봇을 올리기 전에 뿌려진 버튼이 살아 있다.
      let captureId: string | undefined;
      try {
        const parsed = JSON.parse(raw);
        captureId = parsed.captureId ?? parsed.rlqId;
      } catch { /* 예전 형식 — 버릴 캡처가 없다 */ }
      // **캡처도 버린다.** 안 버리면 취소해 놓고도 회복 시각에 드레인이 다시 돌린다.
      if (captureId) {
        await dropCapture(captureId, '사람이 취소함');
        dropHeldFiles(captureId);
      }
      await respond(noticeReply(t('misc.cancelled', actionLocale)));
    });

    // 보류 v2 — 받은 지 7일이 지난 요청의 [실행]·[버림]. 누른 건의 버튼은 결과 한 줄로 바꾼다
    // (다시 막혔으면 버튼을 남겨 나중에 다시 누르게).
    const heldId = (body: any): string => {
      try { return String(JSON.parse(body?.actions?.[0]?.value ?? '{}').id ?? ''); } catch { return ''; }
    };
    this.action('held_run', async ({ ack, body, respond }) => {
      await ack();
      const id = heldId(body);
      if (!id) return;
      const r = await this.runHeldNow(id);
      const blocks = (body as any)?.message?.blocks;
      if (r.settle && Array.isArray(blocks)) {
        await respond({ replace_original: true, text: (body as any).message.text ?? r.text,
          blocks: markChoice(blocks, id, r.text) }).catch(() => { });
      } else {
        await respond({ replace_original: false, text: r.text }).catch(() => { });
      }
    });
    this.action('held_drop', async ({ ack, body, respond }) => {
      await ack();
      const id = heldId(body);
      if (!id) return;
      await dropCapture(id, '7일 지남 — 사람이 버림');
      dropHeldFiles(id);
      const blocks = (body as any)?.message?.blocks;
      if (Array.isArray(blocks)) {
        await respond({ replace_original: true, text: (body as any).message.text ?? '버렸습니다',
          blocks: markChoice(blocks, id, '🗑 버렸습니다') }).catch(() => { });
      }
    });

    // Calendar notification mute button
    this.action('calendar_mute_event', async ({ ack, body, respond }) => {
      await ack();
      const baseEventId = (body as any).actions?.[0]?.value;
      if (!baseEventId || !this.assistantScheduler) return;

      const poller = this.assistantScheduler.getCalendarPoller();
      if (!poller) return;

      // Find event title from cache for display
      const cache = poller.getCache();
      const event = cache?.events.find(e => CalendarPoller.getBaseEventId(e.id) === baseEventId);
      const title = event?.title || baseEventId;

      poller.muteEvent(baseEventId, title);

      try {
        await respond({
          replace_original: true,
          text: `🔇 *${title}* — 이 일정의 알림을 껐습니다.`,
        });
      } catch (error) {
        this.logger.error('Failed to respond to mute action', error);
      }
    });

    // 재시작에 끊긴 대화 알리기. 기동 직후는 슬랙 연결이 아직이라 잠깐 미룬다.
    // 드레인 뒤에 회복 타이머를 엔진 상태 파일에서 다시 건다(`startEngineWatch`) — 안 풀린
    // 막힘이면 기동 드레인은 쉬고, 그 막힘이 풀리는 시각에 이 타이머가 깨운다.
    setTimeout(() => this.reportInterruptedSessions()
      // **알리고 나서 돌린다** — 순서가 규칙이다. 먼저 돌리면 끊긴 차례의
      // 자국(`interrupted`)이 아직 안 찍혀 그 건이 목록에서 빠진다.
      .then(() => this.drainStuck('기동'))
      .catch(() => { })
      .then(() => this.startEngineWatch()), 12_000);

    // 보류 v2 — 30분마다 쓸어 본다. 회복 타이머가 못 깨우는 것(오류로 밀린 것 · 시각을 모르는 막힘이
    // 시간으로 풀린 것)을 줍는다. 막혀 있으면 안 돌고, 밀린 것이 없으면 드레인이 바로 돌아온다.
    // 막힘은 사다리로 본다(`drainBlocked`) — Claude 만 보면 GPT · agy 가 비어도 Claude 가 풀릴 때까지 안 돈다.
    if (holdV2On()) {
      const sweep = setInterval(() => {
        if (this.drainBlocked()) return;
        void this.drainStuck('쓸어보기');
      }, HOLD_SWEEP_MS);
      sweep.unref?.();
    }

    // Cleanup inactive sessions periodically
    setInterval(() => this.sweepSessions(), 5 * 60 * 1000);

    // Periodic token health check (every 1 hour)
    setInterval(() => {
      this.checkTokenHealth().catch(err =>
        this.logger.error('Token health check failed', err),
      );
    }, 60 * 60 * 1000);
    // Run once at startup (after 30 seconds to let Slack connect)
    setTimeout(() => {
      this.checkTokenHealth().catch(err =>
        this.logger.error('Initial token health check failed', err),
      );
    }, 30 * 1000);

    // Lunch recruitment bot
    this.lunchPoller?.start();
    this.lunchButtons?.start().catch((err) =>
      this.logger.warn('Lunch button listener failed to start', err),
    );

    // 대화 봇들 (레터 DM · 점심봇 채널)
    for (const host of this.chatHosts) {
      host.start().catch((err) => this.logger.warn('Chat host failed to start', err));
    }

    // Agent SDK 판 맞춤 — 허용된 사람만 누르게 `this.action` 으로(DM 인지는 모듈이 다시 본다).
    if (this.sdkUpdate) {
      const su = this.sdkUpdate;
      su.start();
      this.action(SDK_UPDATE_RUN, (args) => su.onRun(args));
      this.action(SDK_UPDATE_SKIP, (args) => su.onSkip(args));
    }

    // System memory watchdog
    if (this.memoryWatchdog) {
      this.memoryWatchdog.start();

      this.action('watchdog_kill', async ({ ack, body }) => {
        await ack();
        const pid = parseInt((body as any).actions[0].value, 10);
        await this.memoryWatchdog?.handleKillAction(pid);
      });

      this.action('watchdog_ignore', async ({ ack, body }) => {
        await ack();
        const pid = parseInt((body as any).actions[0].value, 10);
        await this.memoryWatchdog?.handleIgnoreAction(pid);
      });

      this.action('watchdog_exclude', async ({ ack, body }) => {
        await ack();
        const pid = parseInt((body as any).actions[0].value, 10);
        await this.memoryWatchdog?.handleExcludeAction(pid);
      });

      // 데일리 시스템 점검이 낸 「알려진 문제」 알림의 조치 버튼.
      // `ack()` 를 먼저 보낸다 — 정리는 몇 초 걸리는데 3초 안에 응답이 없으면
      // 슬랙이 버튼을 실패로 표시한다.
      const healthActions = ['health_fix_explorer', 'health_fix_watchers',
                             'health_reboot_confirm', 'health_reboot_cancel'];
      for (const actionId of healthActions) {
        this.action(actionId, async ({ ack, body }) => {
          await ack();
          const ts = (body as any).message?.ts;
          if (ts) await this.memoryWatchdog?.handleHealthFixAction(actionId, ts);
        });
      }
      this.action('health_reboot_ask', async ({ ack, body }) => {
        await ack();
        const ts = (body as any).message?.ts;
        if (ts) await this.memoryWatchdog?.handleRebootAsk(ts);
      });
      this.action('health_dismiss', async ({ ack, body }) => {
        await ack();
        const ts = (body as any).message?.ts;
        if (ts) await this.memoryWatchdog?.handleHealthDismiss(ts);
      });
    }

    // 다우 로그인 버튼 — 하루 뒤에 눌러도 되도록 상태는 버튼이 아니라 파일에 있다.
    if (this.daouLogin) {
      this.daouLogin.start();
      this.action(DAOU_LOGIN_ACTION, async ({ ack, body }) => {
        await ack();
        const ts = (body as any).message?.ts;
        if (ts) await this.daouLogin?.handleAction(ts);
      });
    }
  }

  private async checkTokenHealth(): Promise<void> {
    const unhealthy = await this.accountManager.checkTokenHealth();

    // Clear notification state for accounts that recovered (e.g., user re-logged in)
    for (const id of this.notifiedUnhealthyAccounts) {
      if (!unhealthy.find(a => a.id === id)) {
        this.notifiedUnhealthyAccounts.delete(id);
      }
    }

    // Filter out already-notified accounts
    const newUnhealthy = unhealthy.filter(a => !this.notifiedUnhealthyAccounts.has(a.id));
    if (newUnhealthy.length === 0) return;

    // 비서 DM 으로 알린다 — 전에는 인사 예약(2026-10-14 걷음)이 든 방을 빌려 썼다.
    const channel = config.assistant.dmChannel;
    if (!channel) return; // 알릴 곳이 없으면 표시도 안 남긴다 — 설정되면 다음 점검에서 알린다
    const user = config.bot.allowUsers[0];
    const locale: Locale = user ? await this.getUserLocale(user).catch(() => 'ko' as Locale) : 'ko';
    const accountLabels = newUnhealthy.map(a => `\`${a.email || a.id}\``).join(', ');
    const message = t('account.tokenExpired', locale, { accounts: accountLabels });

    await this.app.client.chat.postMessage({ channel, text: message });

    for (const a of newUnhealthy) {
      this.notifiedUnhealthyAccounts.add(a.id);
    }
    this.logger.info('Sent token expiry notification', { accounts: newUnhealthy.map(a => a.id) });
  }
}
