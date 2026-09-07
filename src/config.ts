import * as os from 'os';
import * as path from 'path';
import dotenv from 'dotenv';

dotenv.config();

export const config = {
  slack: {
    botToken: process.env.SLACK_BOT_TOKEN!,
    appToken: process.env.SLACK_APP_TOKEN!,
    signingSecret: process.env.SLACK_SIGNING_SECRET!,
  },
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY!,
  },
  claude: {
    useBedrock: process.env.CLAUDE_CODE_USE_BEDROCK === '1',
    useVertex: process.env.CLAUDE_CODE_USE_VERTEX === '1',
  },
  baseDirectory: process.env.BASE_DIRECTORY || '',
  defaultWorkingDirectory: process.env.DEFAULT_WORKING_DIRECTORY || '',
  // **별칭을 쓴다 — 모델이 새로 나와도 코드를 안 고치기 위해서다.** SDK 가 별칭을
  // 그 시점의 최신 세대로 푼다(확인 2026-08-06: opus→claude-opus-5,
  // sonnet→claude-sonnet-5).
  //
  // 대신 **SDK 를 낡게 두면 모델도 같이 낡는다.** 0.3.143 에서는 같은 `opus` 가
  // claude-opus-4-7 로 풀렸고, 그 사실이 아무 데도 안 드러나 한 세대 전을 쓰면서
  // 최신인 줄 알고 있었다. 세대를 확인하는 자리는 세션마다 찍히는
  // `Session initialized {model: …}` 로그다 — 별칭이 아니라 **풀린 ID** 가 찍힌다.
  models: {
    opus: process.env.MODEL_OPUS || 'opus',
    sonnet: process.env.MODEL_SONNET || 'sonnet',
    haiku: process.env.MODEL_HAIKU || 'haiku',
  },
  // Default model used when channel has no explicit override.
  // Aliases: 'sonnet' | 'opus' | 'haiku' | full Anthropic ID
  defaultModel: process.env.DEFAULT_MODEL || 'opus',
  debug: process.env.DEBUG === 'true' || process.env.NODE_ENV === 'development',
  assistant: {
    dmChannel: process.env.ASSISTANT_DM_CHANNEL || '',
    configDir: process.env.ASSISTANT_CONFIG_DIR || '',
  },
  // 개인 업무 비서(work-assistant). 태스크 정본은 로컬 볼트(2026-08-18 전환)이고, 이 레포는
  // 결정론 조회 계층만 갖는다. 경로가 비면 관련 기능 전체가 조용히 꺼진다.
  // **기본값을 두지 않는다** — 이 저장소는 공개라, 운영자 PC 의 경로를 소스에 박으면
  // 그대로 남는다. 쓰려면 `.env` 의 `WORK_ASSISTANT_ROOT` 에 적는다.
  workAssistant: {
    root: process.env.WORK_ASSISTANT_ROOT || '',
  },
  // **이 봇을 쓸 수 있는 사람.** 봇은 운영자 PC 에서 도는 Claude Code 세션을
  // 그대로 내준다 — 개인 업무 목록·사내 지식그래프·파일 접근이 딸려 있다.
  // 워크스페이스의 누구든 DM 하거나 채널에서 멘션할 수 있으므로 반드시 좁힌다.
  // **비면 아무도 못 쓴다** — 열어두는 쪽이 기본값이면 안 되는 종류의 설정이다.
  bot: {
    allowUsers: (process.env.BOT_ALLOW_USERS || '')
      .split(',').map((s) => s.trim()).filter(Boolean),
  },
  reports: {
    localServer: {
      enabled: process.env.REPORTS_SERVER_ENABLED !== '0',
      port: parseInt(process.env.REPORTS_SERVER_PORT || '8765', 10),
    },
  },
  // Scheduled greeting: at configured times, auto-spawn a haiku session via a
  // trivial greeting message (.schedule-config.json + ScheduleManager).
  scheduledGreeting: {
    enabled: process.env.SCHEDULED_GREETING_ENABLED !== '0',
  },
  memoryWatchdog: {
    enabled: process.env.MEMORY_WATCHDOG_ENABLED !== '0',
    thresholdPct: parseInt(process.env.MEMORY_WATCHDOG_THRESHOLD_PCT || '90', 10),
    checkIntervalSec: parseInt(process.env.MEMORY_WATCHDOG_INTERVAL_SEC || '180', 10),
    autoKillDelaySec: parseInt(process.env.MEMORY_WATCHDOG_AUTO_KILL_SEC || '600', 10),
    processThresholdMB: parseInt(process.env.MEMORY_WATCHDOG_PROCESS_THRESHOLD_MB || '7168', 10),
  },
  // Lunch recruitment bot. Runs an external Python script that owns its own
  // Slack token and channel — this bot only supplies the 24/7 heartbeat.
  // Stays off unless LUNCH_BOT_SCRIPT points at the script.
  lunchBot: {
    script: process.env.LUNCH_BOT_SCRIPT || '',
    python: process.env.LUNCH_BOT_PYTHON || 'python',
    intervalMinutes: parseInt(process.env.LUNCH_BOT_INTERVAL_MIN || '2', 10),
    windowStart: process.env.LUNCH_BOT_WINDOW_START || '10:00',
    windowEnd: process.env.LUNCH_BOT_WINDOW_END || '13:00',
    // App-level token (xapp-) of the *lunch* Slack app, for its own Socket Mode
    // connection so its message buttons work. Empty = no buttons; the emoji
    // fallback still works because reactions are picked up by the poller.
    appToken: process.env.LUNCH_BOT_SLACK_APP_TOKEN || '',
    // 이 채널에서 오가는 말에 답한다(불렀을 때 + 조건이 차면 먼저).
    // 비면 채널 대화는 꺼진 채로 둔다 — 사람들이 쓰는 방이라 기본값은 침묵이어야 한다.
    chatChannel: process.env.LUNCH_CHAT_CHANNEL || '',
  },
  // agy 대화 계층. **봇 여러 개가 한 코드를 같이 쓴다**(chat-host.ts).
  // 봇마다 자기 슬랙 앱이라 토큰도 소켓 연결도 따로다. 답을 만드는 일은
  // 외부 파이썬(chatbot/turn.py)이 하고, 봇별 성격·설정은 그쪽 bots/<이름>/ 에 있다.
  chat: {
    // 두 봇이 같은 파이썬·같은 스크립트를 쓴다. 봇 이름만 다르게 넘긴다.
    python: process.env.CHATBOT_PYTHON || process.env.LETTER_PYTHON || 'python',
    turnScript: process.env.CHATBOT_TURN_SCRIPT || process.env.LETTER_TURN_SCRIPT || '',
    // 시험용 방. **대화 봇 전부가 여기서는 답한다** — 실원이 있는 방을 건드리지 않고
    // 말투·성격을 바꿔 보려면, 아무 데서나 답하지 않는 규칙에 문을 하나 내야 한다.
    // 비워 두면 문은 닫힌 채다(기본값이 침묵인 것은 그대로).
    testChannel: process.env.BOT_TEST_CHANNEL || '',
    // 봇끼리 말 섞기. 꺼 두면 봇이 한 말은 전부 안 들린다(기본값이 침묵).
    // 굴레가 없으면 부름(멘션)이 조용한 시간·하루 한도를 건너뛰므로 둘이 최고 속도로
    // 주고받는다 — 그래서 두 문턱이 이 기능의 일부다. 열 번에서 스스로 맺으라 이르고,
    // 스무 번을 넘기면 사람이 말할 때까지 끊는다.
    botTalk: {
      enabled: process.env.BOT_TALK === '1',
      softTurns: parseInt(process.env.BOT_TALK_SOFT || '10', 10),
      hardTurns: parseInt(process.env.BOT_TALK_HARD || '20', 10),
    },
    // 점심원정대 채널에서 **먼저 말 걸기**. 낄 자리인지 판단하는 길이 둘이다 —
    // 낱말이 걸리면 그 자리에서 바로(`interest`), 안 걸려도 몇 분마다 쌓인 말을
    // 통째로 보고 한 번 더(`sweepMinutes`). 나머지는 수다스러움을 막는 굴레다 —
    // 말 많은 봇은 곧 아무도 안 읽는다.
    buttIn: {
      enabled: process.env.LUNCH_CHAT_BUTT_IN !== '0',
      // 점심원정대 방에서는 **더 말해도 된다**(실장 지시). 이 방은 점심 이야기를 하러
      // 모인 자리라 봇이 그 이야기의 주인이다 — 조용한 것이 예의가 아니라 불친절이다.
      // 낄 자리를 가리는 일은 굴레가 아니라 판단 지침(turn.py 의 DECIDE_NOTE)이 한다.
      //
      // **2026-09-07 에 커피챗 방과 같은 값으로 풀었다**(실장 지시: 「그만해 라고 하기
      // 전까지는 자연스럽게 대화에 참여」). 뜸(3분)과 하루 상한(20회)이 대화 도중에
      // 봇을 끊어 놓고 있었다 — 사람이 이어 말하는데 봇만 3분을 기다리면 그 대화는
      // 이미 지나가 있다. 말이 많아지는 것을 막는 일은 **사람이 「그만」이라고 하면
      // 멈추는 것**(`hushed`)으로 옮겼다.
      quietMinutes: parseInt(process.env.LUNCH_CHAT_QUIET_MIN || '0', 10),
      dailyCap: parseInt(process.env.LUNCH_CHAT_DAILY_CAP || '100', 10),
      // **낱말로는 못 잡는 자리**를 위한 길. 「애가 됐네」처럼 앞 글을 가리키는 말은
      // 어떤 낱말 목록으로도 못 잡는데, 정작 그런 자리가 봇이 껴야 할 자리다.
      //
      // 1분마다 봐도 모델 호출이 분당 한 번이 되지는 않는다 — 훑을 때 쌓인 말을
      // **비우고** 가므로, 묻는 횟수는 타이머가 아니라 **사람이 말한 횟수**에 묶인다.
      // 아무도 말이 없으면 0회다. 0 으로 두면 이 길을 끈다.
      sweepMinutes: parseInt(process.env.LUNCH_CHAT_SWEEP_MIN || '1', 10),
    },
  },
  // 레터 — 1on1 예약·피드백 전달 창구(개인 DM).
  // 토큰이 없으면 통째로 꺼진 상태로 둔다.
  letter: {
    enabled: process.env.LETTER_ENABLED !== '0',
    botToken: process.env.LETTER_SLACK_BOT_TOKEN || '',
    appToken: process.env.LETTER_SLACK_APP_TOKEN || '',
    turnScript: process.env.LETTER_TURN_SCRIPT || '',
    python: process.env.LETTER_PYTHON || 'python',
    // 여기 적힌 사람만 대화가 된다. **비면 아무도 못 쓴다** — 실제 워크스페이스에
    // 사는 봇이라 기본값은 침묵이어야 한다.
    allowUsers: (process.env.LETTER_ALLOW_USERS || '')
      .split(',').map((s) => s.trim()).filter(Boolean),
    // 실장 본인. 봇이 말을 옮기는 상대이자, 지금 단계에서는 유일한 시험 상대다.
    managerUserId: process.env.LETTER_MANAGER_USER_ID || '',
    // 칭찬을 **받을** 수 있는 사람 명단(실원 전체). 대화 허용 명단과 다르다 —
    // 받는 사람은 목록에서 고르게 해서 이름 오타·동명이인이 끼지 못하게 한다.
    // **비면 칭찬 전달이 통째로 꺼진다.** 고를 목록이 없으면 고를 수가 없다.
    members: (process.env.LETTER_MEMBERS || '')
      .split(',').map((s) => s.trim()).filter(Boolean),
    // 커피챗 채널에 상주하기. **비면 채널 자리는 통째로 닫혀 있다** — 봇을 채널에
    // 초대하고 여기에 방 ID 를 넣는 두 가지가 다 돼야 열린다. 실원이 쓰는 방이라
    // 기본값은 침묵이어야 하고, 준비해 둔 것과 실제로 들어간 것은 다른 일이다.
    //
    // **연결은 늘지 않는다** — DM 과 같은 앱, 같은 소켓 하나가 두 자리를 다 받는다
    // (`ChatHost.surfaces`). 자리마다 연결을 열면 부름의 절반이 사라진다.
    chatChannel: process.env.LETTER_CHAT_CHANNEL || '',
    // 커피챗 방에서는 **앞장서서 이끌어도 된다**(실장 지시). 점심원정대보다 굴레가 느슨하다 —
    // 이 방은 소통 이야기를 하러 모인 자리고 그 이야기의 진행을 봇이 맡는다.
    // 커피챗 방에서는 **바로바로 받는다**(실장 지시). 말한 뒤 뜸을 들이지 않고(0분),
    // 하루 상한도 100 회로 크게 둔다 — 여기서 봇은 조건에 반응하는 장치가 아니라
    // 그 방에 사는 인물이고, 사람이 말을 걸었는데 굴레 때문에 조용한 편이 더 나쁘다.
    buttIn: {
      enabled: process.env.LETTER_CHAT_BUTT_IN !== '0',
      quietMinutes: parseInt(process.env.LETTER_CHAT_QUIET_MIN || '0', 10),
      dailyCap: parseInt(process.env.LETTER_CHAT_DAILY_CAP || '100', 10),
      sweepMinutes: parseInt(process.env.LETTER_CHAT_SWEEP_MIN || '1', 10),
    },
    // 방에 들어간 직후 **한 번만** 인사한다. 인사말은 고정 문구가 아니라 그 자리에서
    // 지어낸다 — 인물처럼 굴어야 하는 봇이 붙박이 문장으로 등장하면 거기서 다 들킨다.
    greetOnJoin: process.env.LETTER_CHAT_GREET !== '0',
    // 1on1 신청 창구. 받는 사람(실장)과 명단은 위 값을 그대로 쓴다 —
    // 신청할 수 있는 사람과 칭찬을 받는 사람이 같은 실원 전체다.
    // 커피챗 창구 — 실원이 남긴 이야기를 받아 두었다가 주에 한 번 실장이 골라서 내보낸다.
    // **칭찬만 나간다.** 개선은 실장이 목록으로만 본다.
    coffeechat: {
      enabled: process.env.LETTER_CC_ENABLED !== '0',
      // **기본은 닫힘.** 열면 실원이 쓴 글이 쌓이기 시작하고, 들어온 글은 없던 일이 안 된다.
      open: process.env.LETTER_CC_OPEN === '1',
      // 금요일 이 시각이 지나면 실장에게 한 번 알린다(토·일에도 열려 있다 — 금요일에
      // 봇이 꺼져 있었으면 그 주가 통째로 사라진다).
      digestAt: process.env.LETTER_CC_DIGEST_AT || '17:00',
      // 예약해 두면 나가는 시각. **하루 일이 끝날 무렵**에 닿게 하려고 둔 값이다 —
      // 일하는 중에 받으면 흐름이 끊기고, 이 시각이면 그날을 기분 좋게 닫는다.
      sendAt: process.env.LETTER_CC_SEND_AT || '18:00',
      // 노션에 남길 목록. **비면 노션 쪽만 통째로 건너뛴다** — 정본은 로컬 기록이다.
      notionDb: process.env.LETTER_CC_NOTION_DB || '',
      notionScript: process.env.NOTION_SCRIPT
        || path.join(os.homedir(), '.claude', 'skills', 'notion-publish', 'notion.py'),
      notionPython: process.env.NOTION_PYTHON || process.env.CHATBOT_PYTHON || 'python',
    },
    booking: {
      enabled: process.env.LETTER_1ON1_ENABLED !== '0',
      // **기본은 닫힘 — 실장만 쓸 수 있다.** 만들어 둔 것과 실원에게 연 것은 다른 일이고,
      // 여는 것은 되돌리기 어렵다(한 번 들어온 신청은 없던 일이 안 된다).
      // 실원에게 안내할 준비가 되면 `LETTER_1ON1_OPEN=1`.
      open: process.env.LETTER_1ON1_OPEN === '1',
    },
  },
  // AI Premium 좌석 관리. 화면과 타이머만 여기 있고, 상태·매칭·판정은 전부
  // 파이썬 도메인(work-assistant/chatbot/premium_seat_manager)이 한다.
  // **좌석을 바꾸는 경로는 없다** — 실제 변경은 실장이 관리 화면에서 직접 한다.
  premiumSeat: {
    // **기본은 닫힘.** 켜도 팀원 버튼은 따로 열어야 한다(open).
    enabled: process.env.PREMIUM_SEAT_ENABLED === '1',
    // 현황판은 켠 순간부터 뜨지만, 요청·상태 변경 버튼은 이 값이 1 이라야 나온다.
    // 만들어 둔 것과 실원에게 연 것은 다른 일이다.
    open: process.env.PREMIUM_SEAT_OPEN === '1',
    channelId: process.env.PREMIUM_SEAT_CHANNEL_ID || '',
    // 승인 권한. 쉼표로 여럿. 비면 기능이 서지 않는다 — 승인 경로가 없다.
    managerUserIds: (process.env.PREMIUM_SEAT_MANAGER_USER_IDS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    python: process.env.PREMIUM_SEAT_PYTHON || process.env.CHATBOT_PYTHON || 'python',
    // `python -m premium_seat_manager.cli` 를 부를 작업 폴더.
    workerDir: process.env.PREMIUM_SEAT_WORKER_DIR || '',
    jobPollSeconds: parseInt(process.env.PREMIUM_SEAT_JOB_POLL_SECONDS || '10', 10),
    // 시험용. 슬랙 사용자 ID 하나를 넣으면 팀원에게 갈 DM 이 전부 그 사람에게
    // 간다 — 안 보내는 것이 아니라 돌리는 것이라, 동료가 받을 글을 그대로 본다.
    // **비워 두는 것이 운영값이다.**
    dmRedirectTo: (process.env.PREMIUM_SEAT_DM_REDIRECT || '').trim(),
  },
};

export function validateConfig() {
  const required = [
    'SLACK_BOT_TOKEN',
    'SLACK_APP_TOKEN',
    'SLACK_SIGNING_SECRET',
  ];

  const missing = required.filter((key) => !process.env[key]);
  
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}