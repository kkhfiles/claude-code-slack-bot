import { App } from '@slack/bolt';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CliHandler, type CliEvent, type CliProcess, type CliAssistantEvent, type CliInitEvent, type CliResultEvent, type CliRateLimitEvent } from './cli-handler';
import { SdkHandler, SdkProcess, SdkRunOptions, shouldUseSdk } from './sdk-handler';
import { PendingDenial } from './types';
import { Logger } from './logger';
import { WorkingDirectoryManager } from './working-directory-manager';
import { FileHandler, ProcessedFile } from './file-handler';
import { TodoManager, Todo } from './todo-manager';
import { McpManager } from './mcp-manager';
import { SessionScanner, SessionInfo, formatRelativeTime } from './session-scanner';
import { ScheduleManager } from './schedule-manager';
import { AccountManager, AccountId } from './account-manager';
import { AssistantScheduler, SpawnOpts, SessionResult, SessionUsage } from './assistant-scheduler';
import { CalendarPoller } from './calendar-poller';
import { config } from './config';
import { Locale, t, formatTime, formatDateTime, getHelpText as getHelpTextI18n } from './messages';
import { getVersionInfo, checkForUpdates } from './version';
import { isRateLimitText as isRateLimitTextUtil, isRateLimitError as isRateLimitErrorUtil } from './rate-limit-utils';
import { nudgeDecision } from './rlq-nudge';
import { setNotice as rlqSetNotice, getNotice as rlqGetNotice } from './rate-limit-queue';
import { enqueue as rlqEnqueue, peek as rlqPeek, takeAll as rlqTakeAll, clear as rlqClear, remove as rlqRemove, QueuedRequest } from './rate-limit-queue';
import { ProcessMemoryWatchdog } from './process-memory-watchdog';
import { LunchPoller } from './lunch-poller';
import { LunchButtons, readLunchBotToken, readLunchAnnounceChannel } from './lunch-buttons';
import { ChatHost } from './chat-host';
import { LetterRelay } from './letter-relay';
import { LetterBooking } from './letter-booking';
import { LetterBoost } from './letter-boost';
import { LetterCoffeechat } from './letter-coffeechat';
import { ReportServer } from './report-server';
import { listNasQueue, buildNasQueueBlocks, confirmAndApply, rejectItems, retargetItem } from './nas-confirm';
import { captureToInbox, checkinMap, checkinNow, isWorkAssistantEnabled, quickUpdate } from './work-assistant';
import { boardLabel } from './board-queue';

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
const INFLIGHT_FILE = path.join(__dirname, '..', '.inflight-sessions.json');

interface InflightRecord { channel: string; threadTs?: string; text: string; startedAt: string; }

function readInflight(): Record<string, InflightRecord> {
  try { return JSON.parse(fs.readFileSync(INFLIGHT_FILE, 'utf-8')); } catch { return {}; }
}

function writeInflight(map: Record<string, InflightRecord>): void {
  try { fs.writeFileSync(INFLIGHT_FILE, JSON.stringify(map), 'utf-8'); } catch { /* 알림용이라 실패해도 본 작업을 막지 않는다 */ }
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
 */
function captureNote(id: string): string {
  return [
    '',
    `**이 메시지의 원문은 캡처 \`${id}\` 로 이미 저장돼 있다** (봇이 남겼다).`,
    '처리를 마쳤으면 **반드시 닫는다** — 안 닫으면 아침 브리핑 맨 위 ⛔ 에',
    '"미처리 캡처" 로 남아 처리된 것과 구분이 안 된다.',
    `- 업무로 등록했으면: \`tasks.py add … --from-inbox ${id}\` (등록 성공 시 자동으로 닫힌다)`,
    `- 조회·잡담이었거나 기존 업무에 로그만 남겼으면: \`tasks.py inbox resolve --id ${id} --drop "사유"\``,
  ].join('\n');
}

interface MessageEvent {
  user: string;
  channel: string;
  thread_ts?: string;
  ts: string;
  text?: string;
  accountId?: string; // Override account for token injection (used by scheduled sessions)
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

// 밀린 요청을 **다시 알리는** 굴레. 자동 실행이 아니라 사람이 눌러야 끝나는 구조라,
// 알림이 한 번뿐이면 자리를 비운 사이 그대로 묻힌다(2026-08-24: 한 번 알리고 22시간).
// 0 을 주면 다시 알리지 않는다.
const RLQ_NUDGE_MIN = Number(process.env.RLQ_NUDGE_MINUTES ?? 120);
const RLQ_NUDGE_FROM_HOUR = Number(process.env.RLQ_NUDGE_FROM_HOUR ?? 8);
const RLQ_NUDGE_TO_HOUR = Number(process.env.RLQ_NUDGE_TO_HOUR ?? 20);
// **끝없이 두드리지 않는다.** 그러면 사람이 그 알림 자체를 안 보게 되고, 다시 알리는
// 뜻이 사라진다. 여기까지 왔는데도 안 눌렀으면 그건 안 급한 것이다.
const RLQ_NUDGE_MAX = Number(process.env.RLQ_NUDGE_MAX ?? 5);

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
  private activeProcesses: Map<string, CliProcess | SdkProcess> = new Map();

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

  // Rate limit retry
  private pendingRetries: Map<string, { prompt: string; channel: string; threadTs: string; user: string }> = new Map();
  private pendingRetryCleanup: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private pendingAutoRetries: Map<string, ReturnType<typeof setTimeout>> = new Map();
  // 한도 회복 시각에 깨어나는 타이머. 큐가 파일이라 재시작해도 다시 걸 수 있다.
  private rlqTimer?: ReturnType<typeof setTimeout>;
  /**
   * 다시 알리기 타이머. **횟수와 앞 알림은 여기 안 둔다** — 큐 파일에 둔다.
   * 메모리에 뒀더니 재시작마다 0 으로 돌아가 알림이 쌓이고 상한이 안 걸렸다
   * (2026-08-25 실측: 저녁 재시작 네 번에 같은 알림 넉 장).
   */
  private rlqNudgeTimer?: ReturnType<typeof setTimeout>;

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

  // API key management
  private userApiKeys: Map<string, string> = new Map();
  private apiKeyActive: Map<string, { userId: string; resetTimerId: ReturnType<typeof setTimeout>; totalCost: number; limit?: number }> = new Map();
  private channelApiKeyLimits: Map<string, number> = new Map();
  private readonly API_KEYS_FILE = path.join(os.homedir(), '.claude', '.bot-api-keys.json');

  // Session schedule
  private scheduleManager = new ScheduleManager();

  // Assistant scheduler
  private assistantScheduler: AssistantScheduler | null = null;

  // Multi-account management
  private accountManager = new AccountManager();
  private pendingAccountSetups: Map<string, { slot: AccountId; originalToken: string | null; locale: Locale }> = new Map();
  private notifiedUnhealthyAccounts = new Set<string>(); // Prevent repeated token expiry notifications

  // System memory watchdog
  private memoryWatchdog: ProcessMemoryWatchdog | null = null;

  // Lunch recruitment bot (external script, its own Slack identity)
  private lunchPoller: LunchPoller | null = null;
  private lunchButtons: LunchButtons | null = null;

  // agy 대화 계층 (봇마다 자기 슬랙 앱 · 자기 소켓 연결)
  private chatHosts: ChatHost[] = [];

  constructor(app: App, cliHandler: CliHandler, mcpManager: McpManager, reportServer?: ReportServer) {
    this.app = app;
    this.cliHandler = cliHandler;
    this.sdkHandler = new SdkHandler(mcpManager);
    this.mcpManager = mcpManager;
    this.reportServer = reportServer;
    this.workingDirManager = new WorkingDirectoryManager();
    this.fileHandler = new FileHandler();
    this.todoManager = new TodoManager();
    this.loadApiKeys();

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
      );

      // Loopback trigger endpoint for manual analysis (Phase 1.7 / 1.8 / 1.9).
      if (this.reportServer) {
        const scheduler = this.assistantScheduler;
        this.reportServer.setTriggerCallback(async (type: string) => scheduler.runAnalysisManual(type));
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

    // 대화 봇들 — 토큰과 turn.py 경로가 다 있을 때만 켠다. 하나라도 없으면 꺼진 채로 둔다.
    const turnScript = config.chat.turnScript;
    // 시험용 방은 **모든 대화 봇의 방 목록에 같이 들어간다.** 초대해 둔 봇이 어느 것인지
    // 몰라도 되게 — 실원 방을 건드려 가며 말투를 시험하지 않으려고 두는 자리다.
    const testRoom = config.chat.testChannel;
    const rooms = (main: string) => [main, testRoom].filter(Boolean);
    // 봇끼리 말 섞기는 **두 봇에 같이 건다** — 한쪽만 들으면 한쪽이 혼잣말을 한다.
    const botTalk = config.chat.botTalk.enabled ? config.chat.botTalk : null;
    if (turnScript && config.letter.enabled
        && config.letter.botToken && config.letter.appToken) {
      this.chatHosts.push(new ChatHost({
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
        // 칭찬 전달과 1on1 예약은 대화가 아니다 — 같은 앱에 슬래시 명령·모달로 따로 붙는다.
        // **앱은 하나뿐이다**(소켓을 두 번 열면 슬랙이 한쪽에만 보내 조용히 실패한다).
        // 그래서 둘 다 같은 앱에 얹는다.
        attach: (app) => {
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
          if (config.letter.booking.enabled) {
            new LetterBooking({
              managerUserId: config.letter.managerUserId,
              members: config.letter.members,
              logPath: path.join(path.dirname(turnScript), 'bots', 'letter', 'data', '1on1.jsonl'),
              // 커피챗 주간 알림과 같은 이유로 파일을 나눈다 — 한쪽의 날짜 초기화가
              // 남의 칸을 지우면 안 된다.
              nudgePath: path.join(path.dirname(turnScript), 'bots', 'letter', 'data', '1on1-nudge.json'),
              open: config.letter.booking.open,
            }).register(app);
          }
          // 주 첫 업무일 아침, 후보 다섯 중 하나를 고르는 버튼. **글을 만드는 일은
          // 전부 파이썬 쪽이고** 여기는 눌린 것을 넘겨 주기만 한다.
          new LetterBoost({
            managerUserId: config.letter.managerUserId,
            python: config.letter.python,
            script: path.join(path.dirname(turnScript), 'weekly_boost.py'),
            logger: this.logger,
          }).register(app);
        },
      }));
    }
    // 점심봇의 채널 대화. **버튼도 여기에 얹는다** — 커피챗과 같은 이유로, 앱 하나에
    // 소켓을 두 번 열면 슬랙이 이벤트를 한쪽에만 보낸다. 버튼이 자기 연결을 따로 열고
    // 있던 동안 부름(@멘션)의 절반쯤이 버튼 쪽으로 가서 흔적 없이 사라졌다 — 버튼은
    // 멀쩡하고 부르면 답이 없어서, 배선 문제가 아니라 봇이 삐친 것처럼 보였다.
    if (turnScript && config.lunchBot.appToken && config.lunchBot.chatChannel) {
      const token = readLunchBotToken(config.lunchBot.script);
      if (token) {
        const buttons = this.lunchButtons;
        this.chatHosts.push(new ChatHost({
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
          attach: buttons ? (app) => buttons.register(app) : undefined,
        }));
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
  private async askFromBoard(text: string, lead?: string, shown?: string): Promise<void> {
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
    const say = async (msg: any) => {
      const text = typeof msg === 'string' ? msg : String(msg?.text ?? '');
      if (/^\s*\[조용히\]\s*$/m.test(text.split('\n')[0])) {
        this.logger.info('판에서 온 것을 조용히 처리 — 답을 안 보냅니다');
        return {};
      }
      return this.app.client.chat.postMessage(
        typeof msg === 'string' ? { channel, text: msg } : { channel, ...msg },
      );
    };
    // `pushed` 는 **사람이 말을 건 것이 아니라는 표시**다 — 완료 줄을 남길지가
    // 여기서 갈린다(사람이 물었으면 「끝났다」이고, 안 물었으면 아무 말도 아니다).
    await this.handleMessage(
      { type: 'message', channel, user, text, ts: String(posted.ts), pushed: true } as unknown as MessageEvent,
      say,
    );
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
    if (files && files.length > 0) {
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

    // API key command — show button to open modal
    if (text && this.isApiKeyCommand(text)) {
      await say({
        thread_ts: thread_ts,
        text: t('apiKey.modalBody', locale),
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: `🔑 ${t('apiKey.modalBody', locale)}` } },
          {
            type: 'actions',
            elements: [
              { type: 'button', text: { type: 'plain_text', text: t('apiKey.modalSubmit', locale) }, action_id: 'open_apikey_modal', value: JSON.stringify({}), style: 'primary' },
            ],
          },
        ],
      });
      return;
    }

    // Limit command
    if (text) {
      const limitParsed = this.parseLimitCommand(text);
      if (limitParsed) {
        await this.handleLimitCommand(limitParsed, channel, thread_ts, locale, say);
        return;
      }
    }

    // Account command
    if (text && this.isAccountCommand(text)) {
      await this.handleAccountCommand(text, channel, thread_ts, locale, say);
      return;
    }

    // Schedule command
    if (text && this.isScheduleCommand(text)) {
      await this.handleScheduleCommand(channel, thread_ts, user, locale, say);
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
        if (result.hasReports) {
          await say({
            text: '📄 대기 중인 보고서가 있습니다.',
            blocks: [{
              type: 'section',
              text: { type: 'mrkdwn', text: '📄 대기 중인 보고서가 있습니다.' },
            }, {
              type: 'actions',
              elements: [{
                type: 'button',
                text: { type: 'plain_text', text: '📄 보고서 확인' },
                action_id: 'briefing_view_reports',
              }],
            }],
            thread_ts: thread_ts || ts,
          });
        }
        // NAS 이동 컨펌 큐 버튼 (스케줄 브리핑 후처리와 동일)
        try {
          const nasBlocks = await buildNasQueueBlocks(await listNasQueue());
          if (nasBlocks) {
            await say({ text: '📦 NAS 이동 컨펌 대기', blocks: nasBlocks, thread_ts: thread_ts || ts });
          }
        } catch (err) {
          this.logger.warn('NAS confirm queue check failed (manual briefing)', err);
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
      await this.handleReportCommand(type, channel, thread_ts || ts, locale, say);
      return;
    }

    // NAS confirm command — inbox auto-classify company 분류분 결정 버튼
    if (text && this.isNasCommand(text)) {
      await this.handleNasCommand(thread_ts || ts, say);
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

    // Stop command (interrupt running CLI process)
    if (text && this.isStopCommand(text)) {
      const sessionKey = this.cliHandler.getSessionKey(user, channel, thread_ts || ts);
      const activeProcess = this.activeProcesses.get(sessionKey);
      if (activeProcess) {
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
      this.cliHandler.removeSession(user, channel, thread_ts || ts);
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
    const replyTs = isDM ? thread_ts : (thread_ts || ts);
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
    if (isDM && !event.accountId && isWorkAssistantEnabled() &&
      /^(체크인|checkin|check-?in|중간\s*점검)\s*(해줘|해주세요|하자|좀)?[.!]?$/i.test((text || '').trim())) {
      await say({ text: await checkinNow(), thread_ts: replyTs });
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
    if (isDM && !event.accountId && text?.trim() && isWorkAssistantEnabled()) {
      const quick = await quickUpdate(text);
      if (quick.kind === 'ok') {
        await this.app.client.reactions.add({
          channel, timestamp: originalMessageTs, name: 'white_check_mark',
        }).catch(() => { });
        await say({ text: quick.output, thread_ts: replyTs });
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
    let apiKeyCostInfo: { queryCost: number; totalCost: number } | null = null;
    let cliError = false;
    // **띄우기 전 준비가 얼마나 먹나** (2026-08-29). 판 한 건 23.1초 중 이 구간이
    // 1.12초인데(75건 중앙값) **안에 로그가 하나도 없어 무엇이 도는지 몰랐다.**
    // 줄일 값이 있는지는 재 봐야 안다 — 짐작으로 손대지 않는다.
    const spawnT0 = Date.now();
    const lap: Record<string, number> = {};
    const mark = (k: string) => { lap[k] = Date.now() - spawnT0; };

    try {
      this.logger.info('Spawning Claude CLI process', {
        prompt: finalPrompt.substring(0, 200) + (finalPrompt.length > 200 ? '...' : ''),
        sessionId: session.sessionId,
        workingDirectory,
        permissionMode: isPlanMode ? 'plan' : botPermLevel,
        fileCount: processedFiles.length,
      });

      // **번호표를 먼저 걸어 둔다** — 파이썬을 한 번 띄우는 일이라 0.17초 걸리는데,
      // 그동안 아래의 토큰 동기화·계정 조회가 어차피 돈다. 쓰는 곳은 저 아래
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

      // Check if API key mode is active for this channel
      const apiKeyState = this.apiKeyActive.get(channel);
      let queryEnv: Record<string, string> | undefined;
      if (apiKeyState) {
        const apiKey = this.userApiKeys.get(apiKeyState.userId);
        if (apiKey) {
          queryEnv = { ANTHROPIC_API_KEY: apiKey };
        }
      }

      // Sync tokens from terminal CLI before spawning (terminal→bot)
      if (!queryEnv) {
        this.accountManager.syncFromCredentialsFile();
      }

      // Inject OAuth token (when not in API key mode)
      // Use event.accountId if specified (scheduled sessions), otherwise current account
      if (!queryEnv) {
        const targetAccount = event.accountId || undefined;
        const oauthToken = await this.accountManager.getAccessToken(targetAccount as any);
        if (oauthToken) {
          queryEnv = { CLAUDE_CODE_OAUTH_TOKEN: oauthToken };
        }
      }

      const resumeSessionId = resumeData?.mode === 'uuid' ? resumeData.resumeOptions.resumeSessionId : undefined;
      const continueLastSession = resumeData?.mode === 'continue' ? true : undefined;

      const useSdk = shouldUseSdk('interactive');
      const runOpts = {
        session,
        workingDirectory,
        resumeSessionId,
        continueLastSession,
        model: channelModel,
        permissionMode: isPlanMode ? 'plan' as const : botPermLevel,
        allowedTools,
        env: queryEnv,
      };
      // **원문을 먼저 저장한다 — 세션을 띄우기 전에.** 순서가 규칙이다(work-assistant
      // CLAUDE.md): 저장(결정론) → 해석(세션) → 닫기. 파이썬도 노션도 안 거치고
      // JSONL 에 직접 붙이므로, 노션이 막혀도 세션이 재시작에 죽어도 원문은 남는다.
      // 세션에 맡겼더니 안 했다(2026-08-06: 캡처 0건) — 그래서 봇이 한다.
      const capture = text?.trim() ? captureToInbox(text, 'slack', thread_ts) : null;
      mark('원문 캡처');
      // 체크인이 화면에 떠 있는데 답이 짧은 문법에 안 맞아 여기까지 왔다면,
      // **번호의 뜻을 같이 넘긴다.** 안 넘기면 세션이 추측하고, 업무 ID 와 숫자가
      // 겹쳐 그럴듯하게 틀린다(2026-08-06: 「3번 논의 완료」가 TSK-10 이 아니라
      // TSK-3 에 붙었다). 세션이 할 일은 번역 하나로 좁히고 쓰기는 quick 이 한다.
      // 위에서 미리 걸어 둔 것을 여기서 받는다 — 그동안 토큰 동기화가 돌았다.
      const slotMap = await slotMapPending;
      mark('체크인 번호표');
      const surfaceNote = [
        SLACK_SURFACE_NOTE,
        capture ? captureNote(capture.id) : '',
        slotMap,
      ].filter(Boolean).join('\n');
      // **캡처 id 를 세션 환경으로 넘긴다.** 닫는 규칙을 세션에 맡겼더니 안 닫혔다
      // (2026-08-06: 업무 등록·로그·상호 링크까지 다 해 놓고 닫기만 빠져 두 건이
      // 큐에 남았다). 이제 tasks.py 의 쓰기 명령이 성공하면 스스로 닫는다 —
      // 세션이 기억해야 할 일이 하나 줄고, 큐는 「정말 처리 안 된 것」만 남는다.
      const sessionEnv = capture
        ? { ...(queryEnv ?? {}), WORK_ASSISTANT_CAPTURE: capture.id }
        : queryEnv;

      // skills: 'all' surfaces ~/.claude/skills/ to the model so it can invoke
      // domain skills (notion-publish, mycelium, bbapi, …) by name. SDK headless
      // mode does not auto-configure skills; CLI branch already exposes them
      // through its own defaults.
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
      // **띄우기 전 준비의 구간별 값.** 합이 23.1초 중 1.12초라 큰 몫은 아니지만,
      // 안에 로그가 없어 **무엇이 도는지조차 몰랐다**(2026-08-29). 재고 나서 정한다.
      mark('옵션 짓기');
      this.logger.info('띄우기 전 준비', { ms: lap });
      const cliProcess = useSdk
        ? this.sdkHandler.runQuery(finalPrompt, sdkOpts)
        : this.cliHandler.runQuery(finalPrompt, {
            ...runOpts, env: sessionEnv, appendSystemPrompt: surfaceNote,
          });

      this.logger.info('Interactive session started', { via: useSdk ? 'sdk' : 'cli' });
      // 여기서 상태 한 줄의 `ts` 를 받는다 — 세션이 뜨기를 기다리는 중이라 공짜다.
      // 아래 스트림이 그 `ts` 로 상태를 고쳐 쓰므로 들어가기 전에 받아 둔다.
      await statusSent;
      this.activeProcesses.set(sessionKey, cliProcess);
      { const m = readInflight(); m[sessionKey] = { channel, threadTs: replyTs, text: (text || '').slice(0, 160), startedAt: new Date().toISOString() }; writeInflight(m); }

      for await (const event of cliProcess) {
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
          continue;
        }

        if (event.type === 'assistant') {
          const assistantEvent = event as CliAssistantEvent;

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
            if (content) {
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

          // API key cost accumulation
          const apiKeyStateForCost = this.apiKeyActive.get(channel);
          if (apiKeyStateForCost && resultEvent.total_cost_usd !== undefined) {
            apiKeyStateForCost.totalCost += resultEvent.total_cost_usd;
            apiKeyCostInfo = { queryCost: resultEvent.total_cost_usd, totalCost: apiKeyStateForCost.totalCost };
            // Check spending limit
            if (apiKeyStateForCost.limit !== undefined && apiKeyStateForCost.totalCost >= apiKeyStateForCost.limit) {
              clearTimeout(apiKeyStateForCost.resetTimerId);
              this.apiKeyActive.delete(channel);
              await say({
                text: `⚠️ ${t('cmd.limit.exceeded', locale, { limit: apiKeyStateForCost.limit.toFixed(2), cost: apiKeyStateForCost.totalCost.toFixed(4) })}`,
                thread_ts: replyTs,
              });
            }
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

          if (resultEvent.subtype === 'success' && resultEvent.result) {
            if (!currentMessages.includes(resultEvent.result)) {
              await say({ text: this.formatMessage(resultEvent.result, true), thread_ts: replyTs });
            }
          }
        }
      }

      // Update session activity timestamp and flush to disk
      if (session) {
        session.lastActivity = new Date();
        this.cliHandler.saveNow();
      }

      // Completed
      const doneEmoji = cliError ? '❌' : isPlanMode ? '📋' : '✅';
      const doneLabel = cliError ? t('status.errorOccurred', locale) : isPlanMode ? t('status.planReady', locale) : t('status.taskCompleted', locale);
      // 완료 줄의 도구 목록도 DM 에서는 뗀다 — "작업 완료 (Read, Bash ×2)" 의
      // 괄호는 대화창에서 읽는 사람이 쓸 데가 없다. 완료 표시 자체는 남긴다.
      const toolSummary = (!isDM && toolUsageCounts.size > 0)
        ? ' (' + Array.from(toolUsageCounts.entries()).map(([name, count]) => count > 1 ? `${name} ×${count}` : name).join(', ') + ')'
        : '';
      const costSuffix = apiKeyCostInfo
        ? t('apiKey.costSuffix', locale, { queryCost: apiKeyCostInfo.queryCost.toFixed(4), totalCost: apiKeyCostInfo.totalCost.toFixed(4) })
        : '';
      if (statusMessageTs) {
        // **봇이 스스로 띄운 세션은 「작업 완료」를 안 남긴다** (2026-08-19 사용자 결정).
        // 사람이 물어본 것이면 그 줄이 「받았고 끝났다」를 알리지만, 판에서 누른 것과
        // 메일 후보는 사람이 말을 건 적이 없어 **아무것도 안 알리는 줄**이 된다.
        //
        // ⚠️ **오류일 때는 남긴다** — ❌ 는 이 줄에만 뜬다. 지우면 세션이 넘어진
        // 사실이 채널 어디에도 안 남는다.
        const pushed = Boolean((event as any).pushed);
        // **여기서도 기다리지 않는다** (2026-08-31). 상태 한 줄을 지우거나 고치는
        // 것은 슬랙 왕복인데, 그 결과를 읽는 곳이 없고 뒤에 오는 것은 판 반영이다.
        // 기다리면 **카드가 늦게 바뀐다** — 사람이 보는 것은 그 카드다.
        //
        // ⚠️ **스트림 안의 고치기와 같은 줄에 세운다** — 따로 두면 이 「지우기」가
        // 아직 안 나간 「고치기」를 앞질러, 지운 메시지를 고치려 드는 순서가 나온다.
        this.queueStatus(sessionKey, channel, statusMessageTs,
          `${doneEmoji} ${doneLabel}${toolSummary}${costSuffix}`, pushed && !cliError);
      }
      await this.updateMessageReaction(sessionKey, doneEmoji);
      await this.removeAnchorReaction(sessionKey);

      // Register session in sessions-index.json for CLI compatibility
      if (session?.sessionId && workingDirectory) {
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
      if (rateLimitInfo || rateLimitMessageText) {
        const retryAfter = rateLimitInfo
          ? rateLimitInfo.retryAfterSec
          : this.parseRetryAfterSeconds({ message: rateLimitMessageText });

        const nextAccount = this.accountManager.getNextAccount();
        await this.handleRateLimitUI(channel, thread_ts || ts, user, finalPrompt, retryAfter, locale, say, nextAccount ?? undefined, ts);
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
      const rateLimitSource = rateLimitMessageText
        ? { message: rateLimitMessageText }
        : this.isRateLimitError(error) ? error : null;

      if (rateLimitSource) {
        const retryAfter = rateLimitInfo
          ? rateLimitInfo.retryAfterSec
          : this.parseRetryAfterSeconds(rateLimitSource);

        const nextAccountOnError = this.accountManager.getNextAccount();
        await this.handleRateLimitUI(channel, thread_ts || ts, user, finalPrompt, retryAfter, locale, say, nextAccountOnError ?? undefined, ts);
      } else {
        await say({ text: t('error.generic', locale, { message: error.message || t('error.somethingWrong', locale) }), thread_ts: thread_ts || ts });
      }

      if (processedFiles.length > 0) {
        await this.fileHandler.cleanupTempFiles(processedFiles);
      }
    } finally {
      this.activeProcesses.delete(sessionKey);
      { const m = readInflight(); delete m[sessionKey]; writeInflight(m); }

      // ⛔ **다음 차례를 미리 띄우던 자리 — 2026-08-29 에 걷었다.**
      //
      // 실물에서 **한 번도 안 쓰였다**(로그 두 차례 다 「옵션이 다름」). 판
      // 프롬프트마다 새 캡처가 생기고 그 id 가 시스템 프롬프트와 `env` 양쪽에
      // 박히는데, 둘 다 프로세스를 띄울 때 굳어 나중에 갈아 끼울 수 없다. 억지로
      // 쓰면 앞 차례의 캡처를 닫고 **이번 것이 큐에 남는다** — 원문 유실을 막는
      // 마지막 안전망을 깨는 거래다. **세션 id 는 원인이 아니었다**(두 차례가 같다).
      //
      // **애초에 값이 작았다** — 판 한 건 23.1초 중 프로세스 띄우기가 3.3초이고
      // **21.5초가 모델 차례**다(75건 중앙값). 줄일 곳은 여기가 아니다.
      // 근거·재는 법 = work-assistant `docs/design.md` §5.17.

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

  private clearRetryTimers(retryId: string): void {
    const cleanup = this.pendingRetryCleanup.get(retryId);
    if (cleanup) {
      clearTimeout(cleanup);
      this.pendingRetryCleanup.delete(retryId);
    }
    const auto = this.pendingAutoRetries.get(retryId);
    if (auto) {
      clearTimeout(auto);
      this.pendingAutoRetries.delete(retryId);
    }
  }

  private async handleRateLimitUI(
    channel: string, threadTs: string, user: string,
    prompt: string, retryAfterSec: number, locale: Locale, say: any,
    nextAccount?: AccountId, messageTs?: string
  ): Promise<void> {
    const postAt = Math.floor(Date.now() / 1000) + retryAfterSec;
    const retryTimeStr = formatTime(new Date(postAt * 1000), locale);

    // **막힌 요청은 무조건 파일 큐에 남긴다.** 아래 버튼은 사람이 그 자리에 있을
    // 때만 쓸모가 있고, 재시도 정보는 10분 뒤 지워진다 — 구독 한도는 보통 몇
    // 시간 뒤에 풀리므로 그때는 이미 아무것도 남아 있지 않다.
    const q = rlqEnqueue({ channel, threadTs, user, text: prompt }, postAt);
    this.armRateLimitRecovery(q.resetsAt);

    // 두 번째부터는 같은 안내를 올리지 않는다 — 한도가 걸린 동안 보낸 메시지마다
    // 버튼 뭉치가 하나씩 쌓이면 그 자체가 도배다. 회복 시각에 한 번에 보여 준다.
    //
    // **대신 ✋ 를 붙인다.** 아무 신호도 안 주면 이미 달린 ❌ 만 남아 실패로 읽히고,
    // 실패로 읽힌 요청은 사람이 다시 보낸다 — 그러면 큐에 같은 것이 두 벌 쌓인다.
    if (!q.first) {
      this.logger.info('Rate-limited request queued', { size: q.size });
      if (messageTs) {
        await this.app.client.reactions.add({ channel, timestamp: messageTs, name: 'raised_hand' })
          .catch(() => { /* 이미 달렸거나 지워진 메시지 */ });
      }
      return;
    }

    const retryId = `retry-${Date.now()}`;

    this.pendingRetries.set(retryId, { prompt, channel, threadTs, user });
    // Cleanup if user never clicks any button within 10 min (auto-retry button clears this timer)
    const cleanupTimer = setTimeout(() => {
      this.pendingRetries.delete(retryId);
      this.pendingRetryCleanup.delete(retryId);
    }, 10 * 60 * 1000);
    this.pendingRetryCleanup.set(retryId, cleanupTimer);

    const promptPreview = prompt.length > 200
      ? prompt.substring(0, 200) + '...'
      : prompt;

    const buttons: any[] = [];
    if (nextAccount) {
      buttons.push({
        type: 'button',
        text: { type: 'plain_text', text: t('rateLimit.switchAccount', locale, { account: nextAccount }) },
        action_id: 'switch_account_retry',
        value: JSON.stringify({ retryId, account: nextAccount }),
        style: 'primary',
      });
    }
    // **「자동 재실행」 버튼을 두지 않는다.** 큐가 회복 시각에 이미 묻는데 이 버튼도
    // 자기 타이머를 걸어서, 누르면 같은 프롬프트가 두 번 돈다. 두 번 도는 것이
    // 조회면 낭비로 끝나지만 등록·상태 변경이면 노션에 두 벌이 들어간다.
    buttons.push(
      { type: 'button', text: { type: 'plain_text', text: t('rateLimit.continueWithApiKey', locale) }, action_id: 'continue_with_apikey', value: JSON.stringify({ retryId, retryAfter: retryAfterSec }), style: nextAccount ? undefined : 'primary' },
      { type: 'button', text: { type: 'plain_text', text: t('rateLimit.cancel', locale) }, action_id: 'cancel_retry', value: JSON.stringify({ retryId, rlqId: q.id }) },
    );

    await say({
      thread_ts: threadTs,
      text: `⏳ ${t('rateLimit.reached', locale)} ${t('rateLimit.retryEstimate', locale, { time: retryTimeStr, minutes: Math.round(retryAfterSec / 60) })}`,
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: `⏳ ${t('rateLimit.reached', locale)}\n${t('rateLimit.retryEstimate', locale, { time: retryTimeStr, minutes: Math.round(retryAfterSec / 60) })}` } },
        { type: 'context', elements: [{ type: 'mrkdwn', text: t('rateLimit.prompt', locale, { prompt: promptPreview }) }] },
        { type: 'actions', elements: buttons },
        { type: 'context', elements: [{ type: 'mrkdwn', text: t('rlq.queued', locale) }] },
      ],
    });
  }

  // --- 한도에 막혀 밀린 요청 ---

  /**
   * 회복 시각에 깨어나 사람에게 묻도록 예약한다.
   *
   * **정각이 아니라 1분 뒤에 깨운다** — 회복 시각에 딱 맞춰 부르면 아직 안 풀린
   * 채로 또 막혀 한 판을 헛돈다(기존 자동 재실행도 같은 이유로 60초를 더한다).
   */
  private armRateLimitRecovery(resetsAt: number | null): void {
    if (!resetsAt) return;
    if (this.rlqTimer) clearTimeout(this.rlqTimer);
    // 새로 막힌 것은 **새 사건**이다 — 앞 건에서 다 쓴 되풀이 횟수를 물려받으면
    // 이번 것은 한 번도 다시 안 알리게 된다.
    const seen = rlqGetNotice();
    if (seen) rlqSetNotice({ ...seen, count: 0 });
    const delay = Math.max(60_000, resetsAt * 1000 + 60_000 - Date.now());
    this.rlqTimer = setTimeout(() => {
      this.rlqTimer = undefined;
      this.postRecoveryPrompt().catch((e) => this.logger.error('Rate-limit recovery prompt failed', e));
    }, delay);
    this.logger.info('Rate-limit recovery armed', { resetsAt, inMinutes: Math.round(delay / 60_000) });
  }

  /** 기동 시 남아 있는 큐를 되살린다. 회복 시각이 이미 지났으면 바로 묻는다. */
  private restoreRateLimitQueue(): void {
    const s = rlqPeek();
    if (s.items.length === 0) return;
    this.logger.warn('Restoring rate-limit queue', { count: s.items.length, resetsAt: s.resetsAt });
    if (!s.resetsAt || s.resetsAt * 1000 <= Date.now()) {
      this.postRecoveryPrompt().catch((e) => this.logger.error('Rate-limit recovery prompt failed', e));
    } else {
      this.armRateLimitRecovery(s.resetsAt);
    }
  }

  /**
   * 밀린 것을 목록으로 보여 주고 사람이 고르게 한다.
   *
   * **자동으로 다 돌리지 않는 이유** — 몇 시간 전 지시가 그사이 뒤집혔을 수 있다.
   * 「그거 말고 회의 메모로」가 앞 지시를 취소한 경우, 자동 실행은 둘 다 돌려
   * 되돌리기 어려운 쓰기를 남긴다.
   */
  private async postRecoveryPrompt(): Promise<void> {
    const s = rlqPeek();
    if (s.items.length === 0) { this.stopRlqNudge(); return; }
    // 여러 채널에 흩어져 있어도 **마지막으로 말을 건 자리 한 곳에만** 올린다 —
    // 밀린 것을 알리려고 여러 방을 두드리면 그것이 또 소음이다.
    const last = s.items[s.items.length - 1];
    const locale = await this.getUserLocale(last.user);
    const lines = s.items.map((it, i) => {
      const body = it.text.length > 60 ? `${it.text.slice(0, 60)}…` : it.text;
      return `${i + 1}. 「${body}」  _${formatTime(new Date(it.ts * 1000), locale)}_`;
    });
    // 되풀이할 때는 **얼마나 기다렸는지**를 앞에 둔다. 같은 문장을 또 올리면 앞서 본
    // 그 알림과 구별이 안 돼서 또 넘어간다.
    const waitedH = s.resetsAt
      ? Math.floor((Date.now() - s.resetsAt * 1000) / 3_600_000) : 0;
    const head = waitedH > 0
      ? t('rlq.stillWaiting', locale, { count: String(s.items.length), hours: String(waitedH) })
      : t('rlq.recovered', locale, { count: String(s.items.length) });
    // **앞 알림은 지우고 새로 올린다.** 고쳐 쓰면(`chat.update`) 슬랙이 새 알림을 안 보내
    // 되풀이하는 뜻이 없어지고, 안 지우면 버튼 달린 옛 글이 줄줄이 쌓인다.
    const prev = rlqGetNotice();
    if (prev) {
      await this.app.client.chat.delete({ channel: prev.channel, ts: prev.ts })
        .catch(() => undefined);   // 사람이 이미 지웠으면 그만이다
    }
    const res = await this.app.client.chat.postMessage({
      channel: last.channel,
      thread_ts: last.threadTs,
      text: head,
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: `${head}\n${lines.join('\n')}` } },
        {
          type: 'actions', elements: [
            { type: 'button', text: { type: 'plain_text', text: t('rlq.runAll', locale) }, action_id: 'rlq_run_all', style: 'primary' },
            { type: 'button', text: { type: 'plain_text', text: t('rlq.runLast', locale) }, action_id: 'rlq_run_last' },
            { type: 'button', text: { type: 'plain_text', text: t('rlq.drop', locale) }, action_id: 'rlq_drop' },
          ],
        },
      ],
    }).catch((e) => {
      this.logger.error('Failed to post rate-limit recovery prompt', e);
      return undefined;
    });
    if (res?.ts) {
      rlqSetNotice({ channel: last.channel, ts: res.ts as string, count: prev?.count ?? 0 });
    }
    // **올리고 나서 다시 예약한다.** 한 번 뜬 알림은 자리를 비운 사이 그대로 묻힌다 —
    // 실측(2026-08-24) 20:10 에 한 번 알리고 그대로 **22시간을 기다렸다.**
    this.armRlqNudge();
  }

  /**
   * 밀린 것이 남아 있으면 **일정 간격으로 다시 알린다.**
   *
   * 자동으로 실행하지 않는 구조라 사람이 눌러야 끝나는데, 알림이 한 번뿐이면 자리를
   * 비운 사이 그대로 묻힌다. 그렇다고 밤새 두드리면 그게 또 소음이라 **깨어 있는
   * 시간에만**, 그리고 **몇 번까지만** 다시 올린다 — 끝없이 되풀이하면 사람이
   * 그 알림 자체를 안 보게 되고, 그러면 되풀이하는 뜻이 사라진다.
   */
  private armRlqNudge(): void {
    if (this.rlqNudgeTimer) clearTimeout(this.rlqNudgeTimer);
    this.rlqNudgeTimer = undefined;
    if (RLQ_NUDGE_MIN <= 0) return;
    this.rlqNudgeTimer = setTimeout(() => {
      this.rlqNudgeTimer = undefined;
      void this.nudgeRecovery();
    }, RLQ_NUDGE_MIN * 60_000);
  }

  private stopRlqNudge(): void {
    if (this.rlqNudgeTimer) clearTimeout(this.rlqNudgeTimer);
    this.rlqNudgeTimer = undefined;
    rlqSetNotice(null);
  }

  private async nudgeRecovery(): Promise<void> {
    const pending = rlqPeek().items.length;
    const what = nudgeDecision({
      pending, hour: new Date().getHours(), nudges: rlqGetNotice()?.count ?? 0,
      fromHour: RLQ_NUDGE_FROM_HOUR, toHour: RLQ_NUDGE_TO_HOUR, max: RLQ_NUDGE_MAX,
    });
    if (what === 'wait') { this.armRlqNudge(); return; }
    if (what === 'stop') {
      if (pending > 0) {
        this.logger.warn('Rate-limit queue still pending — stopped nudging', {
          times: rlqGetNotice()?.count ?? 0, items: pending,
        });
      }
      this.stopRlqNudge();
      return;
    }
    const seen = rlqGetNotice();
    if (seen) rlqSetNotice({ ...seen, count: seen.count + 1 });
    await this.postRecoveryPrompt();
  }

  /**
   * 받은 순서대로 다시 돌린다. **하나씩 기다린다** — 한꺼번에 던지면 그 자리에서
   * 다시 한도에 걸린다. 도중에 또 막히면 그쪽이 큐에 다시 쌓고 다음 회복 시각을
   * 잡으므로 여기서 따로 처리하지 않는다.
   */
  private async replayQueued(items: QueuedRequest[]): Promise<void> {
    for (const it of items) {
      try {
        const event: MessageEvent = {
          user: it.user, channel: it.channel,
          thread_ts: it.threadTs, ts: it.threadTs, text: it.text,
        };
        const sayCb = async (msg: any) => this.app.client.chat.postMessage({ channel: it.channel, ...msg });
        await this.handleMessage(event, sayCb);
      } catch (error) {
        this.logger.error('Rate-limit queue replay failed', error);
      }
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

  // --- Schedule command ---

  private isScheduleCommand(text: string): boolean {
    return /^`?-(?:schedule|sc)`?(?:\s|$)|^스케줄/i.test(text.trim());
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
      await respond({ response_type: 'ephemeral', text: `${note}\n⚠️ 목록 갱신 실패 — \`-nas\`로 재조회하세요.` });
    }
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

  private async handleScheduleCommand(
    channel: string,
    threadTs: string | undefined,
    userId: string,
    locale: Locale,
    say: any,
  ): Promise<void> {
    const { text, blocks } = this.buildScheduleBlocks(locale, channel, userId);
    await say({ text, blocks, thread_ts: threadTs });
  }

  /**
   * Reads reports/scheduled-reports/_status.json (produced by the daily
   * auto_archive_reports step) → Map<relPath, {clean, severity, oneLine}>.
   * Best-effort: missing/corrupt manifest yields an empty map (callers degrade
   * gracefully — reports show without severity, bulk "all" still works).
   */
  private loadReportManifest(reportsDir: string): Map<string, { clean: boolean; severity: string; oneLine: string }> {
    const map = new Map<string, { clean: boolean; severity: string; oneLine: string }>();
    try {
      const p = path.join(reportsDir, '_status.json');
      if (!fs.existsSync(p)) return map;
      const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
      for (const r of (data.active || [])) {
        map.set(r.relPath, { clean: !!r.clean, severity: r.severity || '', oneLine: r.oneLine || '' });
      }
    } catch { /* best-effort */ }
    return map;
  }

  /**
   * Bulk-archive scheduled reports → reports/archived/<type>/ (CLAUDE.md §9,
   * sibling of scheduled-reports/). scope='all' archives every report; 'clean'
   * archives only those flagged clean in the manifest. Returns moved/failed relPaths.
   */
  private archiveReportsBulk(scope: 'all' | 'clean', typeFilter: string): { moved: string[]; failed: string[] } {
    const reportsDir = path.join(config.assistant.configDir, '..', 'reports', 'scheduled-reports');
    const manifest = scope === 'clean' ? this.loadReportManifest(reportsDir) : null;
    const moved: string[] = [];
    const failed: string[] = [];
    if (!fs.existsSync(reportsDir)) return { moved, failed };
    for (const dir of fs.readdirSync(reportsDir)) {
      if (dir === 'archived') continue;
      const subdir = path.join(reportsDir, dir);
      if (!fs.statSync(subdir).isDirectory()) continue;
      if (typeFilter && !dir.includes(typeFilter)) continue;
      for (const fname of fs.readdirSync(subdir)) {
        if (!fname.endsWith('.md') || fname === '.gitkeep' || fname === 'README.md') continue;
        const relPath = `${dir}/${fname}`;
        if (scope === 'clean') {
          const m = manifest!.get(relPath);
          if (!m || !m.clean) continue; // only known-clean
        }
        const absPath = path.resolve(path.join(subdir, fname));
        const archivedDir = path.join(reportsDir, '..', 'archived', dir);
        try {
          fs.mkdirSync(archivedDir, { recursive: true });
          fs.renameSync(absPath, path.join(archivedDir, fname));
          moved.push(relPath);
        } catch {
          failed.push(relPath);
        }
      }
    }
    return { moved, failed };
  }

  private async handleReportCommand(type: string | undefined, channel: string, threadTs: string, locale: Locale, say: any): Promise<void> {
    // Only regular reports (CLAUDE.md §9). Ad-hoc work reports under
    // reports/<other>/ are intentionally excluded from this surface.
    const reportsDir = path.join(config.assistant.configDir, '..', 'reports', 'scheduled-reports');
    if (!fs.existsSync(reportsDir)) {
      await say({ text: t('assistant.reportNotFound', locale, { type: type || 'all' }), thread_ts: threadTs });
      return;
    }

    // Scan subdirectories for .md files: scheduled-reports/<type>/<date>.md (skip archived/)
    const files: { relPath: string; absPath: string; type: string; name: string }[] = [];
    for (const dir of fs.readdirSync(reportsDir)) {
      if (dir === 'archived') continue;
      const subdir = path.join(reportsDir, dir);
      if (!fs.statSync(subdir).isDirectory()) continue;
      for (const fname of fs.readdirSync(subdir)) {
        if (!fname.endsWith('.md') || fname === '.gitkeep' || fname === 'README.md') continue;
        files.push({
          relPath: `${dir}/${fname}`,
          absPath: path.resolve(path.join(subdir, fname)),
          type: dir,
          name: fname,
        });
      }
    }

    // Filter by type if specified
    const filtered = type ? files.filter(f => f.type.includes(type) || f.name.includes(type)) : files;

    if (filtered.length === 0) {
      const types = [...new Set(files.map(f => f.type))];
      const hint = types.length > 0
        ? `\n${t('assistant.reportAvailableTypes', locale)}: ${types.join(', ')}`
        : '';
      await say({ text: t('assistant.reportNotFound', locale, { type: type || 'all' }) + hint, thread_ts: threadTs });
      return;
    }

    // Enrich with the daily status manifest (clean/severity) when available.
    const manifest = this.loadReportManifest(reportsDir);
    type Row = { relPath: string; absPath: string; type: string; name: string; clean: boolean | null; severity: string };
    const rows: Row[] = filtered.map(f => {
      const m = manifest.get(f.relPath);
      return { ...f, clean: m ? m.clean : null, severity: m ? m.severity : '' };
    });
    // actionable (🔴/🟡) first, then unknown, then clean; each newest-first.
    const rank = (r: Row) => (r.clean === false ? 0 : r.clean === null ? 1 : 2);
    rows.sort((a, b) => rank(a) - rank(b) || b.name.localeCompare(a.name));

    const actionable = rows.filter(r => r.clean === false);
    const cleanRows = rows.filter(r => r.clean === true);
    const haveManifest = manifest.size > 0;

    // Summary line + web index (one rollup instead of N individual headers).
    let summary = `📊 보고서 ${rows.length}건`;
    if (haveManifest) summary += ` — 🔴/🟡 ${actionable.length}건 · clean ${cleanRows.length}건`;
    if (this.reportServer) summary += `\n📚 ${this.reportServer.buildIndexUrl()}`;
    await say({ text: summary, thread_ts: threadTs });

    // Upload individually: when manifest present, upload everything except known-clean
    // (actionable + unknown — a report not yet in the manifest must never be hidden).
    // Without a manifest, upload all (legacy fallback).
    const toUpload = haveManifest ? rows.filter(r => r.clean !== true) : rows;
    for (const report of toUpload) {
      const content = fs.readFileSync(report.absPath, 'utf-8');
      const firstLines = content.split('\n').filter(l => l.trim()).slice(0, 3).join('\n');
      const linkLine = this.reportServer ? `🔗 ${this.reportServer.buildReportUrl(report.relPath)}\n` : '';
      const badge = report.severity ? `${report.severity} ` : '';

      try {
        await this.app.client.filesUploadV2({
          channel_id: channel,
          thread_ts: threadTs,
          filename: report.relPath.replace('/', '_'),
          content,
          title: `📄 ${badge}${report.relPath}`,
          initial_comment: `${linkLine}\`${report.absPath}\`\n>${firstLines.split('\n').join('\n>')}`,
        });
        await say({
          text: '',
          blocks: [{
            type: 'actions',
            elements: [{
              type: 'button',
              text: { type: 'plain_text', text: `📂 Archive ${report.type}` },
              action_id: 'archive_report',
              value: JSON.stringify({ absPath: report.absPath, relPath: report.relPath }),
            }],
          }],
          thread_ts: threadTs,
        });
      } catch (error) {
        this.logger.warn('File upload failed, falling back to text', { file: report.relPath, error });
        const maxLen = 3900;
        const truncated = content.length > maxLen ? content.substring(0, maxLen) + '\n\n…(truncated)' : content;
        await say({ text: `📄 *${report.relPath}*\n${linkLine}\`${report.absPath}\`\n\n${truncated}`, thread_ts: threadTs });
      }
    }

    // Clean reports: compact list (no upload — they auto-archive). Only when manifest present.
    if (haveManifest && cleanRows.length > 0) {
      const lines = cleanRows.map(r => {
        const link = this.reportServer ? ` — ${this.reportServer.buildReportUrl(r.relPath)}` : '';
        return `• 🟢 \`${r.relPath}\`${link}`;
      }).join('\n');
      await say({ text: `🧹 *clean ${cleanRows.length}건* _(자동 정리 예정)_\n${lines}`, thread_ts: threadTs });
    }

    // Bulk archive buttons — one click instead of N.
    const bulkElements: any[] = [{
      type: 'button',
      text: { type: 'plain_text', text: `🗂 전체 아카이브 (${rows.length})` },
      style: 'danger',
      action_id: 'archive_all_reports',
      value: JSON.stringify({ scope: 'all', type: type || '' }),
    }];
    if (haveManifest && cleanRows.length > 0) {
      bulkElements.unshift({
        type: 'button',
        text: { type: 'plain_text', text: `🧹 clean 전체 (${cleanRows.length})` },
        action_id: 'archive_clean_reports',
        value: JSON.stringify({ scope: 'clean', type: type || '' }),
      });
    }
    await say({ text: '🗂 일괄 아카이브', blocks: [{ type: 'actions', elements: bulkElements }], thread_ts: threadTs });
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

  private buildScheduleBlocks(locale: Locale, channel?: string, userId?: string, note?: string): { text: string; blocks: any[] } {
    const entries = this.scheduleManager.getEntries();
    const accounts = this.accountManager.getAccountList();
    const configuredAccounts = accounts.filter(a => a.exists);
    const blocks: any[] = [];

    if (note) {
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: note } });
      blocks.push({ type: 'divider' });
    }

    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `📅 ${t('schedule.status.header', locale)}` } });

    if (entries.length === 0) {
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: t('schedule.noConfig', locale) } });
    } else {
      const nextFires = this.scheduleManager.getNextFireTimes();
      for (const entry of entries) {
        const email = accounts.find(a => a.id === entry.account)?.email;
        const label = email ? `${entry.account} (${email})` : entry.account;
        const nf = nextFires.find(f => f.time === entry.time && f.account === entry.account);
        const minsUntil = nf ? Math.round((nf.nextFire.getTime() - Date.now()) / 60000) : 0;
        const timeInfo = nf ? ` _(${minsUntil}m)_` : '';
        blocks.push({
          type: 'section',
          text: { type: 'mrkdwn', text: `• \`${entry.time}\` → ${label}${timeInfo}` },
          accessory: {
            type: 'button',
            text: { type: 'plain_text', text: '✕' },
            action_id: `schedule_remove_btn_${entry.time.replace(':', '')}_${entry.account}`,
            value: JSON.stringify({ time: entry.time, account: entry.account }),
            style: 'danger',
          },
        });
      }
    }

    // Rotation status (only when 2 accounts in schedule and rotation enabled)
    const uniqueAccountsInEntries = [...new Set(entries.map(e => e.account))];
    const showRotation = uniqueAccountsInEntries.length === 2;

    if (showRotation && this.scheduleManager.isRotationEnabled()) {
      const isSwapped = this.scheduleManager.isSwapDay();
      const status = isSwapped ? t('schedule.rotation.swapped', locale) : t('schedule.rotation.normal', locale);
      blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: t('schedule.rotation.status', locale, { status }) }],
      });
      // Show today's effective pattern
      const effectiveEntries = this.scheduleManager.getEffectiveEntries();
      const pattern = effectiveEntries.map(e => {
        const email = accounts.find(a => a.id === e.account)?.email || e.account;
        return `\`${e.time}\` ${email}`;
      }).join(', ');
      blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: t('schedule.rotation.effective', locale, { pattern }) }],
      });
    }

    // Add buttons: one per configured account
    if (configuredAccounts.length > 0) {
      blocks.push({ type: 'divider' });
      const addButtons = configuredAccounts.map(acc => {
        const label = acc.email ? `+ ${acc.email}` : `+ ${acc.id}`;
        return {
          type: 'button',
          text: { type: 'plain_text', text: label },
          action_id: `schedule_add_btn_${acc.id}`,
          value: JSON.stringify({ account: acc.id, channel, userId }),
        };
      });
      // Rotation toggle button (only when 2 accounts in entries)
      if (showRotation) {
        const rotLabel = this.scheduleManager.isRotationEnabled()
          ? t('schedule.rotation.disableBtn', locale)
          : t('schedule.rotation.enableBtn', locale);
        addButtons.push({
          type: 'button',
          text: { type: 'plain_text', text: rotLabel },
          action_id: 'schedule_rotation_btn',
          value: this.scheduleManager.isRotationEnabled() ? 'disable' : 'enable',
        } as any);
      }
      // Clear all button (only when entries exist)
      if (entries.length > 0) {
        addButtons.push({
          type: 'button',
          text: { type: 'plain_text', text: t('schedule.clearBtn', locale) },
          action_id: 'schedule_clear_btn',
          value: 'clear',
        } as any);
      }
      blocks.push({ type: 'actions', elements: addButtons });
    } else {
      blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: t('schedule.noAccounts', locale) }] });
    }

    return { text: `📅 ${t('schedule.status.header', locale)}`, blocks };
  }

  private restartScheduler(): void {
    if (!config.scheduledGreeting.enabled) {
      // Feature disabled via SCHEDULED_GREETING_ENABLED=0. Cancel any timers and
      // skip scheduling (and follow-up restore) so no greeting sessions fire.
      this.scheduleManager.cancelAll();
      this.logger.info('Scheduled greeting disabled (SCHEDULED_GREETING_ENABLED=0) — no sessions scheduled');
      return;
    }
    this.scheduleManager.scheduleAll((ch, uid, time, account) => {
      this.runScheduledGreeting(ch, uid, time, account).catch(err =>
        this.logger.error('Scheduled greeting failed', err),
      );
    });
  }

  private async runScheduledGreeting(channel: string, userId: string, time: string, account: string): Promise<void> {
    const locale = await this.getUserLocale(userId).catch(() => 'ko' as Locale);

    // Skip if account is not configured (unset)
    const accountInfo = this.accountManager.getAccountList().find(a => a.id === account);
    if (!accountInfo?.email) {
      this.logger.warn(`Skipping scheduled session: account ${account} not configured`);
      await this.app.client.chat.postMessage({
        channel,
        text: `⚠️ ${t('schedule.accountNotSet', locale, { account, time })}`,
      }).catch(() => {});
      return;
    }

    // Post session start notification as top-level message
    const accountEmail = accountInfo.email;
    const accountLabel = accountEmail ? `${account} (${accountEmail})` : account;
    const postResult = await this.app.client.chat.postMessage({
      channel,
      text: `🌅 ${t('schedule.sessionStart', locale)} (${time}) — ${accountLabel}`,
    });

    if (!postResult.ok || !postResult.ts) {
      this.logger.error('Failed to post scheduled greeting message');
      return;
    }

    const ts = postResult.ts as string;

    // Suppress thread hint for automated messages
    this.hintShownThreads.add(`${channel}:${ts}`);

    // Create say callback for this thread
    const say = async (args: any) => {
      if (typeof args === 'string') {
        return this.app.client.chat.postMessage({ channel, thread_ts: ts, text: args });
      }
      return this.app.client.chat.postMessage({ channel, ...args });
    };

    // Build synthetic event with randomized greeting
    const greeting = ScheduleManager.getRandomGreeting();
    this.logger.debug('Scheduled greeting message', { time, greeting });
    const event: MessageEvent = { user: userId, channel, ts, text: greeting, accountId: account };

    // Force haiku model for minimal token usage, restore after
    const prevModel = this.channelModels.get(channel);
    this.channelModels.set(channel, 'claude-haiku-4-5-20251001');
    try {
      await this.handleMessage(event, say);
    } finally {
      if (prevModel !== undefined) {
        this.channelModels.set(channel, prevModel);
      } else {
        this.channelModels.delete(channel);
      }
    }
  }

  /**
   * Run a Claude session and return the result text (one-shot, no streaming to Slack).
   * Used by AssistantScheduler for briefing, reminders, and analysis.
   * Reuses OAuth injection (line 500-506) + for-await loop (line 525) + extractTextFromContent (line 987).
   */
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
      env,
    };

    const proc = opts.useSdk
      ? this.sdkHandler.runQuery(prompt, { ...commonOpts, effort: opts.effort })
      : this.cliHandler.runQuery(prompt, commonOpts);

    this.logger.info('Assistant session started', { via: opts.useSdk ? 'sdk' : 'cli' });

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
    // **리미트는 산문이 아니라 이벤트로 온다.** 여기서 안 받으면 부르는 쪽은
    // 모델이 쓴 본문을 정규식으로 훑는 수밖에 없고, 그러면 「429를 분석한
    // 보고서」가 「429에 걸린 세션」으로 둔갑한다(2026-05~08 오탐 13회).
    let rateLimited = false;
    let rateLimitResetsAt: number | undefined;
    let isError = false;

    for await (const event of proc) {
      if (event.type === 'system' && (event as any).subtype === 'init') {
        sessionId = (event as CliInitEvent).session_id;
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
          if ((part as any)?.type === 'tool_use') toolCalls += 1;
        }
        const extracted = this.extractTextFromContent(content);
        if (extracted) text = extracted;  // Keep only last assistant turn (drop intermediate explanations)
      }
      if (event.type === 'result' && !resultReceived) {
        resultReceived = true;
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
      return { text, costUsd, sessionId, subtype: 'error_timeout', usage, turns, toolCalls,
               rateLimited, rateLimitResetsAt, isError: true };
    }

    return { text, costUsd, sessionId, subtype, usage, turns, toolCalls,
             rateLimited, rateLimitResetsAt, isError };
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

  // Extra buffer after reset time to avoid hitting limit again immediately
  private readonly RETRY_BUFFER_SECONDS = 3 * 60; // 3 minutes

  private parseRetryAfterSeconds(error: any): number {
    const msg = error?.message || '';
    const match = msg.match(/retry.?after[:\s]+(\d+)/i);
    if (match) return parseInt(match[1], 10) + this.RETRY_BUFFER_SECONDS;
    const minMatch = msg.match(/(\d+)\s*minutes?/i);
    if (minMatch) return parseInt(minMatch[1], 10) * 60 + this.RETRY_BUFFER_SECONDS;
    // "Spending cap reached resets 1pm" / "resets 2am" format
    const resetsMatch = msg.match(/resets\s+(\d{1,2})\s*(am|pm)/i);
    if (resetsMatch) {
      let hour = parseInt(resetsMatch[1], 10);
      if (resetsMatch[2].toLowerCase() === 'pm' && hour < 12) hour += 12;
      if (resetsMatch[2].toLowerCase() === 'am' && hour === 12) hour = 0;
      const now = new Date();
      const resetTime = new Date(now);
      resetTime.setHours(hour, 0, 0, 0);
      if (resetTime <= now) resetTime.setDate(resetTime.getDate() + 1);
      return Math.max(60, Math.floor((resetTime.getTime() - now.getTime()) / 1000) + this.RETRY_BUFFER_SECONDS);
    }
    return 5 * 60 * 60;
  }

  // --- API key management ---

  private loadApiKeys(): void {
    try {
      if (!fs.existsSync(this.API_KEYS_FILE)) return;
      const raw = fs.readFileSync(this.API_KEYS_FILE, 'utf-8');
      const data: Record<string, { apiKey: string; savedAt: string }> = JSON.parse(raw);
      for (const [userId, entry] of Object.entries(data)) {
        this.userApiKeys.set(userId, entry.apiKey);
      }
      this.logger.info(`Loaded ${this.userApiKeys.size} API key(s) from disk`);
    } catch (error) {
      this.logger.error('Failed to load API keys from disk', error);
    }
  }

  private saveApiKeys(): void {
    try {
      const data: Record<string, { apiKey: string; savedAt: string }> = {};
      for (const [userId, apiKey] of this.userApiKeys.entries()) {
        data[userId] = { apiKey, savedAt: new Date().toISOString() };
      }
      fs.writeFileSync(this.API_KEYS_FILE, JSON.stringify(data, null, 2), 'utf-8');
    } catch (error) {
      this.logger.error('Failed to save API keys to disk', error);
    }
  }

  private isApiKeyCommand(text: string): boolean {
    return /^`?-(?:apikey|key)`?$|^키$/i.test(text.trim());
  }

  private parseLimitCommand(text: string): { action: 'status' } | { action: 'set'; amount: number } | { action: 'clear' } | null {
    const trimmed = text.trim();
    if (/^`?-limit`?$|^한도$/i.test(trimmed)) return { action: 'status' };
    if (/^`?-limit`?\s+(clear|off|reset)`?$|^한도\s+(?:clear|초기화)$/i.test(trimmed)) return { action: 'clear' };
    const setMatch = trimmed.match(/^`?-limit`?\s+([\d.]+)`?$|^한도\s+([\d.]+)$/i);
    if (setMatch) {
      const amount = parseFloat(setMatch[1] || setMatch[2]);
      if (!isNaN(amount) && amount > 0) return { action: 'set', amount };
    }
    return null;
  }

  private async handleLimitCommand(
    parsed: { action: 'status' } | { action: 'set'; amount: number } | { action: 'clear' },
    channel: string,
    threadTs: string | undefined,
    locale: Locale,
    say: any,
  ): Promise<void> {
    if (parsed.action === 'set') {
      this.channelApiKeyLimits.set(channel, parsed.amount);
      // Update active session limit if running
      const active = this.apiKeyActive.get(channel);
      if (active) active.limit = parsed.amount;
      await say({ text: `✅ ${t('cmd.limit.set', locale, { amount: parsed.amount.toFixed(2) })}`, thread_ts: threadTs });
      return;
    }

    if (parsed.action === 'clear') {
      this.channelApiKeyLimits.delete(channel);
      const active = this.apiKeyActive.get(channel);
      if (active) active.limit = undefined;
      await say({ text: `✅ ${t('cmd.limit.cleared', locale)}`, thread_ts: threadTs });
      return;
    }

    // Status
    const active = this.apiKeyActive.get(channel);
    const configuredLimit = this.channelApiKeyLimits.get(channel);
    if (active) {
      const limitStr = active.limit !== undefined ? `$${active.limit.toFixed(2)}` : (locale === 'ko' ? '없음' : 'none');
      let msg = `💰 *${locale === 'ko' ? 'API 키 모드 활성 중' : 'API key mode active'}*\n`;
      msg += `• ${locale === 'ko' ? '이번 세션 사용' : 'Spent'}: $${active.totalCost.toFixed(4)}\n`;
      msg += `• ${locale === 'ko' ? '한도' : 'Limit'}: ${limitStr}\n`;
      msg += locale === 'ko'
        ? '_`-limit <금액>`으로 변경, `-limit clear`로 초기화_'
        : '_Use `-limit <amount>` to change, `-limit clear` to remove_';
      await say({ text: msg, thread_ts: threadTs });
    } else if (configuredLimit !== undefined) {
      let msg = `ℹ️ ${locale === 'ko' ? 'API 키 모드 비활성.' : 'API key mode not active.'}\n`;
      msg += `• ${locale === 'ko' ? '설정된 한도' : 'Configured limit'}: $${configuredLimit.toFixed(2)}\n`;
      msg += locale === 'ko'
        ? '_Rate limit 시 API 키 모드 전환 시 자동 적용됩니다._'
        : '_Will apply automatically when API key mode is activated._';
      await say({ text: msg, thread_ts: threadTs });
    } else {
      await say({ text: `ℹ️ ${t('cmd.limit.none', locale)}`, thread_ts: threadTs });
    }
  }

  private activateApiKey(channel: string, threadTs: string, userId: string, retryAfterSec: number, locale: Locale): void {
    // Clear any existing timer for this channel
    const existing = this.apiKeyActive.get(channel);
    if (existing?.resetTimerId) clearTimeout(existing.resetTimerId);

    const resetTimerId = setTimeout(async () => {
      this.apiKeyActive.delete(channel);
      try {
        await this.app.client.chat.postMessage({
          channel,
          thread_ts: threadTs,
          text: `🔄 ${t('apiKey.switchingToSubscription', locale)}`,
        });
      } catch (err) {
        this.logger.error('Failed to post subscription switch message', err);
      }
    }, retryAfterSec * 1000);

    this.apiKeyActive.set(channel, {
      userId,
      resetTimerId,
      totalCost: 0,
      limit: this.channelApiKeyLimits.get(channel),
    });
  }

  // --- Account management commands ---

  private isAccountCommand(text: string): boolean {
    return /^`?-(?:account|ac)(`?\s*.*)?$|^계정(\s.*)?$/i.test(text.trim());
  }

  private async handleAccountCommand(text: string, _channel: string, threadTs: string | undefined, locale: Locale, say: any): Promise<void> {
    const trimmed = text.trim().replace(/^`|`$/g, '');
    const argMatch = trimmed.match(/^-(?:account|ac)\s+(.+)$/i) || trimmed.match(/^계정\s+(.+)$/);
    const raw = argMatch ? argMatch[1].trim().toLowerCase() : '';

    // -account <id> — direct switch (always run switchTo to re-sync .credentials.json)
    const targetId = raw ? this.parseAccountId(raw) : null;
    if (targetId) {
      const ok = await this.accountManager.switchTo(targetId);
      if (!ok) {
        const { text: statusText, blocks } = this.buildAccountStatusBlocks(locale);
        await say({ text: statusText, blocks, thread_ts: threadTs });
        return;
      }
      const note = t('account.switchedTerminalGuide', locale, { account: targetId });
      const { text: statusText, blocks } = this.buildAccountStatusBlocks(locale, note);
      await say({ text: statusText, blocks, thread_ts: threadTs });
      return;
    }

    // No args (or unrecognized) — show unified status + buttons
    const { text: statusText, blocks } = this.buildAccountStatusBlocks(locale);
    await say({ text: statusText, blocks, thread_ts: threadTs });
  }

  private parseAccountId(raw: string): AccountId | null {
    if (raw === '1' || raw === 'account-1') return 'account-1';
    if (raw === '2' || raw === 'account-2') return 'account-2';
    if (raw === '3' || raw === 'account-3') return 'account-3';
    return null;
  }

  private buildAccountStatusBlocks(locale: Locale, note?: string): { text: string; blocks: any[] } {
    const current = this.accountManager.getCurrentAccount();
    const accounts = this.accountManager.getAccountList();
    const blocks: any[] = [];

    if (note) {
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: note } });
      blocks.push({ type: 'divider' });
    }

    const currentEmail = accounts.find(a => a.id === current)?.email;
    const currentLabel = currentEmail ? `${current} (${currentEmail})` : current;
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: t('account.current', locale, { account: currentLabel }) } });

    for (const acc of accounts) {
      const emailSuffix = acc.email ? ` — ${acc.email}` : '';
      if (acc.exists) {
        // Configured account: Use / Set / Unset (Use re-syncs .credentials.json even if already active)
        const statusText = acc.id === current
          ? t('account.entryActive', locale, { id: acc.id }) + emailSuffix
          : t('account.entryAvailable', locale, { id: acc.id }) + emailSuffix;
        blocks.push({ type: 'section', text: { type: 'mrkdwn', text: statusText } });
        blocks.push({
          type: 'actions',
          elements: [
            { type: 'button', text: { type: 'plain_text', text: t('account.useBtn', locale) }, action_id: 'account_use_btn', value: acc.id, style: 'primary' },
            { type: 'button', text: { type: 'plain_text', text: t('account.setBtn', locale) }, action_id: 'account_set_btn', value: acc.id },
            { type: 'button', text: { type: 'plain_text', text: t('account.unsetBtn', locale) }, action_id: 'account_unset_btn', value: acc.id, style: 'danger' },
          ],
        });
      } else {
        // Not configured: Set only
        blocks.push({
          type: 'section',
          text: { type: 'mrkdwn', text: t('account.entryMissing', locale, { id: acc.id }) },
          accessory: {
            type: 'button',
            text: { type: 'plain_text', text: t('account.setBtn', locale) },
            action_id: 'account_set_btn',
            value: acc.id,
          },
        });
      }
    }

    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: t('account.hint', locale) }] });

    return { text: t('account.current', locale, { account: current }), blocks };
  }

  private buildCaptureNewBlocks(setupId: string, slot: AccountId, locale: Locale): { text: string; blocks: any[] } {
    const text = t('account.setup.captureNew.title', locale, { slot });
    return {
      text,
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text } },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: t('account.setup.captureNew.doneBtn', locale) },
              action_id: 'account_setup_next',
              value: setupId,
              style: 'primary',
            },
            {
              type: 'button',
              text: { type: 'plain_text', text: t('account.setup.cancelBtn', locale) },
              action_id: 'account_setup_cancel',
              value: setupId,
            },
          ],
        },
      ],
    };
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

  /** 지난 기동에서 처리 중이던 대화가 있으면 알리고 기록을 비운다. */
  private async reportInterruptedSessions(): Promise<void> {
    const pending = readInflight();
    const keys = Object.keys(pending);
    if (keys.length === 0) return;
    writeInflight({});
    this.logger.warn('Reporting interrupted sessions', { count: keys.length });
    for (const key of keys) {
      const r = pending[key];
      await this.app.client.chat.postMessage({
        channel: r.channel,
        thread_ts: r.threadTs,
        text: '⚠️ 봇이 다시 시작되면서 처리 중이던 요청이 끊겼습니다 — 답을 못 드렸습니다.\n> '
          + r.text + '\n다시 보내주세요.',
      }).catch(() => { });
    }
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

    // Start session scheduler
    this.restartScheduler();

    // Start assistant scheduler (briefing, reminders, analysis)
    this.assistantScheduler?.start();

    // --- Interactive button handlers ---

    // Briefing: "보고서 확인" button — trigger -rp command
    this.action('briefing_view_reports', async ({ ack, body }) => {
      await ack();
      const channel = (body as any).channel?.id || (body as any).container?.channel_id;
      const threadTs = (body as any).message?.ts;
      const userId = (body as any).user?.id;
      if (!channel) return;
      const locale = await this.getUserLocale(userId).catch(() => 'ko' as Locale);
      await this.handleReportCommand(undefined, channel, threadTs, locale, async (msg: any) => {
        await this.app.client.chat.postMessage({ channel, ...msg });
      });
    });

    // Report: "Archive" button — move report to archived/
    this.action('archive_report', async ({ ack, body, respond }) => {
      await ack();
      try {
        const { absPath, relPath } = JSON.parse((body as any).actions[0].value);
        if (!fs.existsSync(absPath)) {
          await respond({ response_type: 'ephemeral', text: '⚠️ File not found (already archived?)' });
          return;
        }
        // absPath = reports/scheduled-reports/<type>/<file>; archive to reports/archived/<type>/ (§9).
        // Two '..' from the type dir reach reports/, so archived/ stays a sibling of scheduled-reports/.
        const archivedDir = path.join(path.dirname(absPath), '..', '..', 'archived', path.dirname(relPath));
        fs.mkdirSync(archivedDir, { recursive: true });
        fs.renameSync(absPath, path.join(archivedDir, path.basename(absPath)));
        await respond({ response_type: 'ephemeral', text: `📂 Archived: ${relPath}` });
      } catch (error) {
        this.logger.error('Failed to archive report', error);
        await respond({ response_type: 'ephemeral', text: '❌ Archive failed' });
      }
    });

    // Report: "Archive all" button — bulk-archive every currently-listed report.
    this.action('archive_all_reports', async ({ ack, body, respond }) => {
      await ack();
      try {
        const { type } = JSON.parse((body as any).actions[0].value);
        const { moved, failed } = this.archiveReportsBulk('all', type || '');
        const tail = failed.length ? ` (실패 ${failed.length})` : '';
        await respond({ response_type: 'ephemeral', text: `🗂 ${moved.length}건 아카이브 완료${tail}` });
      } catch (error) {
        this.logger.error('Failed to bulk-archive reports', error);
        await respond({ response_type: 'ephemeral', text: '❌ 일괄 아카이브 실패' });
      }
    });

    // Report: "Archive clean" button — bulk-archive only manifest-clean reports.
    this.action('archive_clean_reports', async ({ ack, body, respond }) => {
      await ack();
      try {
        const { moved, failed } = this.archiveReportsBulk('clean', '');
        const tail = failed.length ? ` (실패 ${failed.length})` : '';
        await respond({ response_type: 'ephemeral', text: `🧹 clean ${moved.length}건 아카이브 완료${tail}` });
      } catch (error) {
        this.logger.error('Failed to bulk-archive clean reports', error);
        await respond({ response_type: 'ephemeral', text: '❌ clean 일괄 아카이브 실패' });
      }
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
        await respond({ response_type: 'ephemeral', text: '❌ 처리 실패' }).catch(() => {});
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
        await respond({ response_type: 'ephemeral', text: '❌ 처리 실패' }).catch(() => {});
      }
    });

    this.action('nas_hold_item', async ({ ack, respond }) => {
      await ack();
      // DB 무변경 — 큐에 남아 다음 브리핑에 다시 표시 (무기한 대기 + 7일 🔴 정책)
      await respond({ response_type: 'ephemeral', text: '⏸️ 보류 — 다음 브리핑에 다시 표시됩니다.' });
    });

    this.action('nas_confirm_all_safe', async ({ ack, body, respond }) => {
      await ack();
      try {
        const { ids } = JSON.parse((body as any).actions[0].value);
        const r = await confirmAndApply(ids);
        await this.rerenderNasMessage(respond, this.nasResultNote(r.ok, r.detail, `✅ ${ids.length}건 NAS 이동 완료 (⚠️ 항목은 개별 결정)`));
      } catch (error) {
        this.logger.error('NAS bulk confirm failed', error);
        await respond({ response_type: 'ephemeral', text: '❌ 일괄 승인 실패' });
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
        await respond({ response_type: 'ephemeral', text: '❌ 일괄 거부 실패' });
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
        await respond({ response_type: 'ephemeral', text: '❌ 분류 변경 실패' });
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
          await respond({ response_type: 'ephemeral', text: `⚠️ ${t('approval.expired', actionLocale)}` });
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
          await respond({ response_type: 'ephemeral', text: `⚠️ ${t('approval.expired', actionLocale)}` });
          return;
        }

        // Track one-time approved tools for this denial (not channel-wide)
        if (!denial.approvedTools) denial.approvedTools = new Set();
        denial.approvedTools.add(actionValue.tool);

        await respond({ response_type: 'ephemeral', text: `✅ ${t('permission.allowTool', actionLocale, { toolName: actionValue.tool })}` });

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
      await respond({ response_type: 'ephemeral', text: t('plan.cancelled', actionLocale) });
    });

    // Account status view: "Switch" button
    this.action('account_switch_btn', async ({ ack, body, respond }) => {
      await ack();
      const actionLocale = await this.getUserLocale((body as any).user.id);
      const accountId = (body as any).actions[0].value as AccountId;
      const ok = await this.accountManager.switchTo(accountId);
      const note = ok
        ? t('account.switchedTerminalGuide', actionLocale, { account: accountId })
        : t('account.notFound', actionLocale, { account: accountId });
      const { text, blocks } = this.buildAccountStatusBlocks(actionLocale, note);
      await respond({ replace_original: true, text, blocks });
    });

    // Account status view: "Use" button → switch account
    this.action('account_use_btn', async ({ ack, body, respond }) => {
      await ack();
      const actionLocale = await this.getUserLocale((body as any).user.id);
      const accountId = (body as any).actions[0].value as AccountId;
      const ok = await this.accountManager.switchTo(accountId);
      const note = ok
        ? t('account.switchedTerminalGuide', actionLocale, { account: accountId })
        : t('account.notFound', actionLocale, { account: accountId });
      const { text, blocks } = this.buildAccountStatusBlocks(actionLocale, note);
      await respond({ replace_original: true, text, blocks });
    });

    // Account status view: "Set" button → guide user to login with target account
    this.action('account_set_btn', async ({ ack, body, respond }) => {
      await ack();
      const actionLocale = await this.getUserLocale((body as any).user.id);
      const slot = (body as any).actions[0].value as AccountId;

      const originalToken = this.accountManager.readCurrentToken();
      const setupId = `setup-${Date.now()}`;
      this.pendingAccountSetups.set(setupId, { slot, originalToken, locale: actionLocale });
      setTimeout(() => {
        const s = this.pendingAccountSetups.get(setupId);
        if (s) { this.pendingAccountSetups.delete(setupId); }
      }, 30 * 60 * 1000);

      const { text, blocks } = this.buildCaptureNewBlocks(setupId, slot, actionLocale);
      await respond({ replace_original: true, text, blocks });
    });

    // Account status view: "Unset" button → remove credentials backup
    this.action('account_unset_btn', async ({ ack, body, respond }) => {
      await ack();
      const actionLocale = await this.getUserLocale((body as any).user.id);
      const accountId = (body as any).actions[0].value as AccountId;
      this.accountManager.unsetAccount(accountId);
      const { text, blocks } = this.buildAccountStatusBlocks(actionLocale, t('account.unset.done', actionLocale, { id: accountId }));
      await respond({ replace_original: true, text, blocks });
    });

    // Account setup: "Done" button — capture token for the target slot
    this.action('account_setup_next', async ({ ack, body, respond }) => {
      await ack();
      const actionLocale = await this.getUserLocale((body as any).user.id);
      try {
        const setupId = (body as any).actions[0].value as string;
        const setup = this.pendingAccountSetups.get(setupId);
        if (!setup) {
          await respond({ response_type: 'ephemeral', text: t('account.setup.expired', actionLocale) });
          return;
        }

        const currentToken = this.accountManager.readCurrentToken();
        if (currentToken === setup.originalToken) {
          await respond({ response_type: 'ephemeral', text: t('account.setup.captureNew.notChanged', actionLocale) });
          return;
        }

        await this.accountManager.captureForSlot(setup.slot);
        this.pendingAccountSetups.delete(setupId);
        const doneBlocks = this.buildAccountStatusBlocks(actionLocale, t('account.setup.done', actionLocale, { slot: setup.slot }));
        await respond({ replace_original: true, ...doneBlocks });
      } catch (error) {
        this.logger.error('Error in account_setup_next', error);
        await respond({ response_type: 'ephemeral', text: '❌ An error occurred. Please try again.' });
      }
    });

    // Account setup: "Cancel" button
    this.action('account_setup_cancel', async ({ ack, body, respond }) => {
      await ack();
      const actionLocale = await this.getUserLocale((body as any).user.id);
      const setupId = (body as any).actions[0].value;
      const setup = this.pendingAccountSetups.get(setupId);
      if (setup) {
        this.pendingAccountSetups.delete(setupId);
        // No cleanup needed — watcher removed
      }
      // Return to status view with cancel note
      const { text, blocks } = this.buildAccountStatusBlocks(actionLocale, t('account.setup.cancelled', actionLocale));
      await respond({ replace_original: true, text, blocks });
    });

    // Schedule: "Add" button → open modal for time input
    this.action(/^schedule_add_btn_/, async ({ ack, body }) => {
      await ack();
      try {
        const actionLocale = await this.getUserLocale((body as any).user.id);
        const value = JSON.parse((body as any).actions[0].value);
        const { account, channel: ch, userId: uid } = value;
        const messageTs = (body as any).message?.ts;
        const accInfo = this.accountManager.getAccountList().find(a => a.id === account);
        const label = accInfo?.email ? `${account} (${accInfo.email})` : account;

        await this.app.client.views.open({
          trigger_id: (body as any).trigger_id,
          view: {
            type: 'modal',
            callback_id: 'schedule_add_modal',
            private_metadata: JSON.stringify({ account, channel: ch, userId: uid, messageTs }),
            title: { type: 'plain_text', text: t('schedule.modal.title', actionLocale) },
            submit: { type: 'plain_text', text: t('schedule.modal.submit', actionLocale) },
            close: { type: 'plain_text', text: t('schedule.modal.close', actionLocale) },
            blocks: [
              { type: 'section', text: { type: 'mrkdwn', text: t('schedule.modal.body', actionLocale, { account: label }) } },
              {
                type: 'input',
                block_id: 'schedule_time_block',
                label: { type: 'plain_text', text: t('schedule.modal.label', actionLocale) },
                element: {
                  type: 'plain_text_input',
                  action_id: 'schedule_time_input',
                  placeholder: { type: 'plain_text', text: '5, 11, 16:30' },
                },
              },
            ],
          },
        });
      } catch (error) {
        this.logger.error('Failed to open schedule add modal', error);
      }
    });

    // Schedule: modal submission → add time
    this.app.view('schedule_add_modal', async ({ ack, view, body }) => {
      const metadata = JSON.parse(view.private_metadata);
      const timeInput = view.state.values.schedule_time_block.schedule_time_input.value || '';
      const viewLocale = await this.getUserLocale(body.user.id);

      // Validate
      const normalized = this.scheduleManager.normalizeTime(timeInput);
      if (!normalized) {
        await ack({ response_action: 'errors', errors: { schedule_time_block: t('schedule.invalidTime', viewLocale) } });
        return;
      }
      const conflict = this.scheduleManager.findConflictingTime(normalized, metadata.account);
      if (conflict) {
        const existingHour = conflict.split(':')[0];
        await ack({ response_action: 'errors', errors: { schedule_time_block: t('schedule.conflictWithExisting', viewLocale, { time: normalized, existing: conflict, existingHour }) } });
        return;
      }

      await ack();
      this.scheduleManager.addTime(normalized, metadata.channel, metadata.userId, metadata.account);
      this.restartScheduler();

      // Update original schedule message in-place
      try {
        const { text, blocks } = this.buildScheduleBlocks(viewLocale, metadata.channel, metadata.userId);
        if (metadata.messageTs) {
          await this.app.client.chat.update({
            channel: metadata.channel,
            ts: metadata.messageTs,
            text,
            blocks,
          });
        } else {
          await this.app.client.chat.postMessage({
            channel: metadata.channel,
            text,
            blocks,
          });
        }
      } catch (err) {
        this.logger.error('Failed to update schedule view after add', err);
      }
    });

    // Schedule: "Remove" button
    this.action(/^schedule_remove_btn_/, async ({ ack, body, respond }) => {
      await ack();
      const actionLocale = await this.getUserLocale((body as any).user.id);
      const ch = (body as any).channel?.id;
      const uid = (body as any).user.id;
      const { time, account } = JSON.parse((body as any).actions[0].value);
      this.scheduleManager.removeTime(time, account);
      this.restartScheduler();
      const { text, blocks } = this.buildScheduleBlocks(actionLocale, ch, uid);
      await respond({ replace_original: true, text, blocks });
    });

    // Schedule: "Clear all" button
    this.action('schedule_clear_btn', async ({ ack, body, respond }) => {
      await ack();
      const actionLocale = await this.getUserLocale((body as any).user.id);
      const ch = (body as any).channel?.id;
      const uid = (body as any).user.id;
      this.scheduleManager.clearTimes();
      const { text, blocks } = this.buildScheduleBlocks(actionLocale, ch, uid);
      await respond({ replace_original: true, text, blocks });
    });

    // Schedule: "Rotation" toggle button
    this.action('schedule_rotation_btn', async ({ ack, body, respond }) => {
      await ack();
      const actionLocale = await this.getUserLocale((body as any).user.id);
      const ch = (body as any).channel?.id;
      const uid = (body as any).user.id;
      const value = (body as any).actions[0].value;
      this.scheduleManager.setRotation(value === 'enable');
      const { text, blocks } = this.buildScheduleBlocks(actionLocale, ch, uid);
      await respond({ replace_original: true, text, blocks });
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


    // Rate limit retry — auto-execute the original prompt at reset time
    this.action('schedule_retry', async ({ ack, body, respond }) => {
      await ack();
      try {
        const userId = (body as any).user.id;
        const actionLocale = await this.getUserLocale(userId);
        const actionValue = JSON.parse((body as any).actions[0].value);
        const { retryId, postAt, retryTimeStr } = actionValue;
        const retryInfo = this.pendingRetries.get(retryId);
        if (!retryInfo) {
          await respond({ response_type: 'ephemeral', text: `⚠️ ${t('rateLimit.retryExpired', actionLocale)}` });
          return;
        }

        // Auto-retry will own pendingRetries until fire — clear cleanup timer
        const cleanupTimer = this.pendingRetryCleanup.get(retryId);
        if (cleanupTimer) {
          clearTimeout(cleanupTimer);
          this.pendingRetryCleanup.delete(retryId);
        }

        // Schedule auto-execution: postAt + 60s buffer for Anthropic clock skew
        const fireMs = postAt * 1000 + 60_000;
        const delay = Math.max(60_000, fireMs - Date.now());
        const autoRetryTimer = setTimeout(async () => {
          this.pendingAutoRetries.delete(retryId);
          const info = this.pendingRetries.get(retryId);
          if (!info) return;
          this.pendingRetries.delete(retryId);
          try {
            const fireLocale = await this.getUserLocale(info.user);
            await this.app.client.chat.postMessage({
              channel: info.channel,
              thread_ts: info.threadTs,
              text: t('rateLimit.autoRetryFiring', fireLocale),
            }).catch(() => {});
            const event: MessageEvent = {
              user: info.user,
              channel: info.channel,
              thread_ts: info.threadTs,
              ts: info.threadTs,
              text: info.prompt,
            };
            const sayCb = async (msg: any) => this.app.client.chat.postMessage({ channel: info.channel, ...msg });
            await this.handleMessage(event, sayCb);
          } catch (error) {
            this.logger.error('Auto-retry execution failed', error);
          }
        }, delay);
        this.pendingAutoRetries.set(retryId, autoRetryTimer);

        await respond({
          replace_original: true,
          text: t('rateLimit.scheduled', actionLocale, { time: retryTimeStr }),
        });
      } catch (error) {
        this.logger.error('Failed to schedule auto-retry', error);
      }
    });

    this.action('cancel_retry', async ({ ack, body, respond }) => {
      await ack();
      const actionLocale = await this.getUserLocale((body as any).user.id);
      const raw = (body as any).actions[0].value;
      // 예전 형식(문자열 그대로)도 받는다 — 봇을 올리기 전에 뿌려진 버튼이 살아 있다.
      let retryId = raw;
      let rlqId: string | undefined;
      try {
        const parsed = JSON.parse(raw);
        retryId = parsed.retryId; rlqId = parsed.rlqId;
      } catch { /* 예전 형식 */ }
      this.clearRetryTimers(retryId);
      this.pendingRetries.delete(retryId);
      // **큐에서도 뺀다.** 안 빼면 취소해 놓고도 회복 시각에 다시 올라온다.
      if (rlqId) rlqRemove(rlqId);
      await respond({ response_type: 'ephemeral', text: t('misc.cancelled', actionLocale) });
    });

    // Switch account on rate limit
    this.action('switch_account_retry', async ({ ack, body, respond }) => {
      await ack();
      try {
        const userId = (body as any).user.id;
        const actionLocale = await this.getUserLocale(userId);
        const { retryId, account } = JSON.parse((body as any).actions[0].value) as { retryId: string; account: AccountId };
        const retryInfo = this.pendingRetries.get(retryId);
        if (!retryInfo) {
          await respond({ response_type: 'ephemeral', text: `⚠️ ${t('rateLimit.retryExpired', actionLocale)}` });
          return;
        }

        this.clearRetryTimers(retryId);

        const ok = await this.accountManager.switchTo(account);
        if (!ok) {
          await respond({ response_type: 'ephemeral', text: t('account.notFound', actionLocale, { account }) });
          return;
        }

        // Replace rate limit message (remove buttons) + show switch confirmation
        await respond({
          replace_original: true,
          text: t('account.switchedTerminalGuide', actionLocale, { account }),
        });

        // Retry original query with new account
        const { channel, threadTs, user: retryUser, prompt } = retryInfo;
        this.pendingRetries.delete(retryId);
        const event: MessageEvent = { user: retryUser, channel, thread_ts: threadTs, ts: threadTs, text: prompt };
        const sayCb = async (msg: any) => this.app.client.chat.postMessage({ channel, ...msg });
        await this.handleMessage(event, sayCb);
      } catch (error) {
        this.logger.error('Error handling switch_account_retry', error);
      }
    });

    // Continue with API key on rate limit
    this.action('continue_with_apikey', async ({ ack, body }) => {
      await ack();
      try {
        const userId = (body as any).user.id;
        const actionLocale = await this.getUserLocale(userId);
        const actionValue = JSON.parse((body as any).actions[0].value);
        const { retryId, retryAfter } = actionValue;
        const retryInfo = this.pendingRetries.get(retryId);
        if (!retryInfo) {
          await this.app.client.chat.postEphemeral({
            channel: (body as any).channel?.id || '',
            user: userId,
            text: `⚠️ ${t('rateLimit.retryExpired', actionLocale)}`,
          }).catch(() => {});
          return;
        }

        const apiKey = this.userApiKeys.get(userId);
        if (apiKey) {
          this.clearRetryTimers(retryId);

          // Activate API key mode for this channel
          this.activateApiKey(retryInfo.channel, retryInfo.threadTs, userId, retryAfter, actionLocale);

          await this.app.client.chat.postMessage({
            channel: retryInfo.channel,
            thread_ts: retryInfo.threadTs,
            text: `🔑 ${t('apiKey.switchingToApiKey', actionLocale)}`,
          });

          // Retry with API key
          const { channel, threadTs, user, prompt } = retryInfo;
          this.pendingRetries.delete(retryId);
          const event: MessageEvent = { user, channel, thread_ts: threadTs, ts: threadTs, text: prompt };
          const sayCb = async (msg: any) => this.app.client.chat.postMessage({ channel, ...msg });
          await this.handleMessage(event, sayCb);
        } else {
          // No key registered — open modal to enter one
          await this.app.client.views.open({
            trigger_id: (body as any).trigger_id,
            view: {
              type: 'modal',
              callback_id: 'apikey_modal',
              private_metadata: JSON.stringify({ retryId, retryAfter, channel: retryInfo.channel }),
              title: { type: 'plain_text', text: t('apiKey.modalTitle', actionLocale) },
              submit: { type: 'plain_text', text: t('apiKey.modalSubmit', actionLocale) },
              close: { type: 'plain_text', text: t('apiKey.modalClose', actionLocale) },
              blocks: [
                { type: 'section', text: { type: 'mrkdwn', text: t('apiKey.modalBody', actionLocale) } },
                {
                  type: 'input',
                  block_id: 'apikey_block',
                  label: { type: 'plain_text', text: t('apiKey.modalLabel', actionLocale) },
                  element: {
                    type: 'plain_text_input',
                    action_id: 'apikey_input',
                    placeholder: { type: 'plain_text', text: 'sk-ant-...' },
                  },
                },
                {
                  type: 'input',
                  block_id: 'limit_block',
                  optional: true,
                  label: { type: 'plain_text', text: t('apiKey.limitLabel', actionLocale) },
                  element: {
                    type: 'plain_text_input',
                    action_id: 'limit_input',
                    placeholder: { type: 'plain_text', text: t('apiKey.limitPlaceholder', actionLocale) },
                    initial_value: this.channelApiKeyLimits.has(retryInfo.channel) ? String(this.channelApiKeyLimits.get(retryInfo.channel)) : undefined,
                  },
                },
              ],
            },
          });
        }
      } catch (error) {
        this.logger.error('Error handling continue_with_apikey', error);
      }
    });

    // Open API key modal (from -apikey command button)
    this.action('open_apikey_modal', async ({ ack, body }) => {
      await ack();
      try {
        const userId = (body as any).user.id;
        const actionLocale = await this.getUserLocale(userId);
        const existingKey = this.userApiKeys.get(userId);
        const modalChannel = (body as any).channel?.id || (body as any).container?.channel_id || '';

        await this.app.client.views.open({
          trigger_id: (body as any).trigger_id,
          view: {
            type: 'modal',
            callback_id: 'apikey_modal',
            private_metadata: JSON.stringify({ channel: modalChannel }),
            title: { type: 'plain_text', text: t('apiKey.modalTitle', actionLocale) },
            submit: { type: 'plain_text', text: t('apiKey.modalSubmit', actionLocale) },
            close: { type: 'plain_text', text: t('apiKey.modalClose', actionLocale) },
            blocks: [
              { type: 'section', text: { type: 'mrkdwn', text: t('apiKey.modalBody', actionLocale) } },
              {
                type: 'input',
                block_id: 'apikey_block',
                label: { type: 'plain_text', text: t('apiKey.modalLabel', actionLocale) },
                element: {
                  type: 'plain_text_input',
                  action_id: 'apikey_input',
                  placeholder: { type: 'plain_text', text: existingKey ? `Already set (...${existingKey.slice(-4)})` : 'sk-ant-...' },
                },
              },
              {
                type: 'input',
                block_id: 'limit_block',
                optional: true,
                label: { type: 'plain_text', text: t('apiKey.limitLabel', actionLocale) },
                element: {
                  type: 'plain_text_input',
                  action_id: 'limit_input',
                  placeholder: { type: 'plain_text', text: t('apiKey.limitPlaceholder', actionLocale) },
                  initial_value: modalChannel && this.channelApiKeyLimits.has(modalChannel) ? String(this.channelApiKeyLimits.get(modalChannel)) : undefined,
                },
              },
            ],
          },
        });
      } catch (error) {
        this.logger.error('Failed to open API key modal', error);
      }
    });

    // API key modal submission
    this.app.view('apikey_modal', async ({ ack, view, body }) => {
      await ack();
      try {
        const userId = body.user.id;
        if (!userId) return;
        const viewLocale = await this.getUserLocale(userId);
        const apiKey = view.state.values.apikey_block.apikey_input.value?.trim();
        if (!apiKey) return;

        // Save key
        this.userApiKeys.set(userId, apiKey);
        this.saveApiKeys();

        const metadata = JSON.parse(view.private_metadata || '{}');

        // Save spending limit if provided
        const limitValue = view.state.values.limit_block?.limit_input?.value?.trim();
        const metaChannel = metadata.channel as string | undefined;
        if (metaChannel) {
          if (limitValue) {
            const limitAmount = parseFloat(limitValue);
            if (!isNaN(limitAmount) && limitAmount > 0) {
              this.channelApiKeyLimits.set(metaChannel, limitAmount);
              const active = this.apiKeyActive.get(metaChannel);
              if (active) active.limit = limitAmount;
            }
          } else {
            // Blank = clear limit
            this.channelApiKeyLimits.delete(metaChannel);
            const active = this.apiKeyActive.get(metaChannel);
            if (active) active.limit = undefined;
          }
        }

        if (metadata.retryId) {
          // Called from rate limit flow — activate API key and retry
          const retryInfo = this.pendingRetries.get(metadata.retryId);
          if (retryInfo) {
            this.clearRetryTimers(metadata.retryId);

            this.activateApiKey(retryInfo.channel, retryInfo.threadTs, userId, metadata.retryAfter, viewLocale);

            await this.app.client.chat.postMessage({
              channel: retryInfo.channel,
              thread_ts: retryInfo.threadTs,
              text: `🔑 ${t('apiKey.savedAndRetrying', viewLocale)}`,
            });

            // Retry
            const { channel, threadTs, user, prompt } = retryInfo;
            this.pendingRetries.delete(metadata.retryId);
            const event: MessageEvent = { user, channel, thread_ts: threadTs, ts: threadTs, text: prompt };
            const sayCb = async (msg: any) => this.app.client.chat.postMessage({ channel, ...msg });
            await this.handleMessage(event, sayCb);
          }
        } else {
          // Called from -apikey command — just confirm save
          // Post DM to the user
          try {
            const dm = await this.app.client.conversations.open({ users: userId });
            if (dm.channel?.id) {
              await this.app.client.chat.postMessage({
                channel: dm.channel.id,
                text: `✅ ${t('apiKey.saved', viewLocale)}`,
              });
            }
          } catch {
            // Can't DM, just log
            this.logger.debug('Could not DM user after API key save');
          }
        }
      } catch (error) {
        this.logger.error('Error handling API key modal submission', error);
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

    this.action('rlq_run_all', async ({ ack, body, respond }) => {
      await ack();
      // 사람이 골랐으면 **다시 알리기를 그 자리에서 끈다.**
      this.stopRlqNudge();
      const locale = await this.getUserLocale((body as any).user.id);
      const items = rlqTakeAll();
      if (items.length === 0) {
        await respond({ response_type: 'ephemeral', text: t('rlq.expired', locale) });
        return;
      }
      await respond({ replace_original: true, text: t('rlq.running', locale, { count: String(items.length) }) });
      // 기다리지 않는다 — 버튼 응답은 3초 안에 끝나야 하고, 재실행은 몇 분이 걸린다.
      void this.replayQueued(items);
    });

    this.action('rlq_run_last', async ({ ack, body, respond }) => {
      await ack();
      // 사람이 골랐으면 **다시 알리기를 그 자리에서 끈다.**
      this.stopRlqNudge();
      const locale = await this.getUserLocale((body as any).user.id);
      const items = rlqTakeAll();
      if (items.length === 0) {
        await respond({ response_type: 'ephemeral', text: t('rlq.expired', locale) });
        return;
      }
      const last = items[items.length - 1];
      await respond({ replace_original: true, text: t('rlq.running', locale, { count: '1' }) });
      void this.replayQueued([last]);
    });

    this.action('rlq_drop', async ({ ack, body, respond }) => {
      await ack();
      // 사람이 골랐으면 **다시 알리기를 그 자리에서 끈다.**
      this.stopRlqNudge();
      const locale = await this.getUserLocale((body as any).user.id);
      const n = rlqPeek().items.length;
      rlqClear();
      await respond({ replace_original: true, text: t('rlq.dropped', locale, { count: String(n) }) });
    });

    // 재시작에 끊긴 대화 알리기. 기동 직후는 슬랙 연결이 아직이라 잠깐 미룬다.
    setTimeout(() => this.reportInterruptedSessions().catch(() => { }), 12_000);
    // 한도에 막혀 밀린 것도 같이 되살린다 — 재시작으로 사라지면 큐를 파일에 둔
    // 뜻이 없다.
    setTimeout(() => this.restoreRateLimitQueue(), 13_000);

    // Cleanup inactive sessions periodically
    setInterval(() => {
      this.logger.debug('Running session cleanup');
      this.cliHandler.cleanupInactiveSessions(24 * 60 * 60 * 1000); // 24 hours
    }, 5 * 60 * 1000);

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

    // Find a channel/user to send the notification to
    const scheduleConfig = this.scheduleManager.getConfig();
    if (!scheduleConfig) return; // No schedule = no one to notify

    const locale = await this.getUserLocale(scheduleConfig.userId).catch(() => 'ko' as Locale);
    const accountLabels = newUnhealthy.map(a => `\`${a.id}\` (${a.email || '?'})`).join(', ');
    const message = t('account.tokenExpired', locale, { accounts: accountLabels });

    await this.app.client.chat.postMessage({
      channel: scheduleConfig.channel,
      text: message,
    });

    for (const a of newUnhealthy) {
      this.notifiedUnhealthyAccounts.add(a.id);
    }
    this.logger.info('Sent token expiry notification', { accounts: newUnhealthy.map(a => a.id) });
  }
}
