# Tasks

<!--
작성자: claude-workflow 워크스페이스
수행자: claude-code-slack-bot 워크스페이스의 Claude Code 세션
-->

## AssistantScheduler 구현 — 개인비서 스케줄링 엔진

개인비서 시스템의 런타임 컴포넌트. `ScheduleManager`와 별도 클래스로 구현.
설정 파일(`P:/github/claude-workflow/assistant/config.json`)을 읽어 브리핑/리마인더/분석 작업을 스케줄링하고, Claude Code 세션을 스폰하여 결과를 슬랙 DM으로 전달.

### 구현할 파일

#### 1. `src/assistant-scheduler.ts` (새 파일)

**참고 패턴**: `src/schedule-manager.ts`의 타이머 관리, 휴일 처리, 설정 저장 패턴을 따름.

```typescript
import * as fs from 'fs';
import Holidays from 'date-holidays';
import { Logger } from './logger';

interface AssistantConfig {
  briefing: {
    time: string;        // "HH:MM"
    enabled: boolean;
    calendars: string[];
  };
  reminders: {
    beforeMinutes: number;
    pollingIntervalMinutes: number;
    enabled: boolean;
    workingHoursStart: string;  // "HH:00"
    workingHoursEnd: string;    // "HH:00"
  };
  analysis: {
    schedule: string;    // "saturday-03:00"
    deliveryTime: string;
    enabled: Record<string, boolean>;
    competitors: { tools: string[] };
  };
}

interface SpawnOpts {
  workingDirectory: string;
  model?: string;
  permissionMode?: 'default' | 'plan' | 'trust';
  allowedTools?: string[];
  appendSystemPrompt?: string;
  env?: Record<string, string>;
}

export class AssistantScheduler {
  private config: AssistantConfig | null = null;
  private configWatcher: fs.FSWatcher | null = null;
  private readonly configPath = 'P:/github/claude-workflow/assistant/config.json';
  private readonly promptsDir = 'P:/github/claude-workflow/assistant/prompts';
  private readonly workingDir = 'P:/github/claude-workflow';

  // 타이머
  private briefingTimer: ReturnType<typeof setTimeout> | null = null;
  private reminderInterval: ReturnType<typeof setInterval> | null = null;
  private analysisTimer: ReturnType<typeof setTimeout> | null = null;

  // 리마인더 중복 방지 (eventId-date 키, 24시간 후 자동 정리)
  private remindedEvents = new Set<string>();

  // MCP 인증 실패 추적
  private consecutiveAuthFailures = 0;
  private reminderPaused = false;

  private logger = new Logger('AssistantScheduler');
  private holidays = new Holidays('KR');

  constructor(
    private sendMessage: (text: string) => Promise<void>,
    private spawnSession: (prompt: string, opts: SpawnOpts) => Promise<string>,
  ) {}

  start(): void;           // loadConfig + 모든 타이머 시작 + fs.watch
  stop(): void;            // 모든 타이머 + watcher 정리
  private loadConfig(): void;
  private onConfigChange(): void;  // debounce → loadConfig + 타이머 재설정

  // --- 브리핑 ---
  private scheduleBriefing(): void;        // 다음 업무일 config.briefing.time에 타이머
  private runBriefing(): Promise<void>;    // 프롬프트 읽기 → 세션 스폰 → 결과 전송

  // --- 캘린더 리마인더 ---
  private startReminderPolling(): void;    // setInterval(config.pollingIntervalMinutes)
  private pollCalendar(): Promise<void>;   // 업무시간 체크 → 세션 스폰 → 결과 파싱 → DM
  private isWorkingHours(): boolean;       // config의 start/end + 휴일 체크

  // --- 자동 분석 ---
  private scheduleAnalysis(): void;        // 다음 토요일 03:00에 타이머
  private runAnalysis(): Promise<void>;    // 활성화된 분석 타입별 순차 실행
  private runSingleAnalysis(type: string): Promise<void>;  // 프롬프트 → 세션 → 보고서 생성
}
```

**핵심 구현 세부사항:**

1. **loadConfig()**: `fs.readFileSync(this.configPath)` → JSON.parse. 파일 없으면 경고 로그만.

2. **fs.watch()**: config.json 변경 감지. debounce 1초 적용 (연속 변경 시 마지막만 반영). 변경 시 모든 타이머 clear → loadConfig → 타이머 재설정.

3. **scheduleBriefing()**: `ScheduleManager`의 패턴 참조.
   - 현재 시각과 다음 업무일 briefing.time의 차이를 ms로 계산 → `setTimeout`
   - 업무일 판정: `this.holidays.isHoliday(date)` + 토/일 체크 (ScheduleManager.isNonWorkingDay 참고)
   - 브리핑 완료 후 다음 업무일 재스케줄

4. **runBriefing()**:
   - `fs.readFileSync(path.join(this.promptsDir, 'morning-briefing.md'))`로 프롬프트 읽기
   - spawnSession 호출:
     ```
     model: 'claude-sonnet-4-6'
     permissionMode: 'default'
     allowedTools: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch',
       'mcp__claude_ai_Google_Calendar__gcal_list_events',
       'mcp__claude_ai_Google_Calendar__gcal_list_calendars']
     ```
   - 결과를 sendMessage로 슬랙 DM 전송

5. **pollCalendar()**:
   - `isWorkingHours()` false면 즉시 return
   - `reminderPaused` true면 즉시 return
   - 프롬프트의 `{beforeMinutes}`를 config 값으로 치환
   - spawnSession: `model: 'claude-haiku-4-5-20251001'`, `permissionMode: 'plan'`
   - 응답에 "NONE" 포함 시 무시
   - 일정 정보 있으면 → 이벤트 텍스트 기반 중복 체크 → sendMessage
   - 예외 발생 시 consecutiveAuthFailures++ → 3회 도달 시 sendMessage("⚠️ 캘린더 인증 갱신 필요") + reminderPaused = true

6. **runAnalysis()**:
   - `config.analysis.enabled`에서 true인 타입만 순차 실행
   - 각 타입: `runSingleAnalysis(type)` → 완료 후 다음
   - spawnSession:
     ```
     permissionMode: 'default'
     allowedTools: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'Write']
     appendSystemPrompt: 'CRITICAL: reports/ 디렉토리에만 새 파일 생성. 기존 파일 수정/삭제 금지.'
     env: { ASSISTANT_MODE: 'analysis' }
     ```

#### 2. `src/slack-handler.ts` 수정

**추가할 멤버:**
```typescript
// line 97 근처, scheduleManager 아래에 추가
private assistantScheduler: AssistantScheduler;
```

**constructor (line 104)에서 초기화:**
```typescript
this.assistantScheduler = new AssistantScheduler(
  async (text) => {
    await this.app.client.chat.postMessage({
      channel: 'D0AE30D5CRH',  // 사용자 DM 채널
      text,
    });
  },
  async (prompt, opts) => {
    // cliHandler.runQuery를 래핑하여 결과 텍스트를 Promise<string>으로 반환
    return new Promise((resolve, reject) => {
      const proc = this.cliHandler.runQuery(prompt, opts);
      let result = '';
      proc.on('assistant', (event) => { result += event.content; });
      proc.on('result', (event) => { resolve(event.result || result); });
      proc.on('error', (error) => { reject(error); });
    });
  },
);
```

**setupEventHandlers() 끝에 추가:**
```typescript
this.assistantScheduler.start();
```

**새 명령어 파싱 추가 (handleMessage 내 명령어 분기에):**

| 명령어 패턴 | 동작 |
|-------------|------|
| `-briefing` 또는 `-br` | `this.assistantScheduler.runBriefing()` 호출 (public으로 노출 필요) |
| `-report [type]` 또는 `-rp [type]` | reports/ 디렉토리에서 최신 보고서 읽어서 전송, 또는 분석 트리거 |
| `-assistant config` | config.json 내용을 슬랙으로 전송 |
| `-assistant briefing HH:MM` | config.json의 briefing.time 수정 → 파일 저장 (fs.watch가 감지하여 자동 재스케줄) |
| `-assistant reminder N` | config.json의 reminders.beforeMinutes 수정 |

**i18n (messages.ts):**
- 새 키 추가 필요: `assistant.briefingScheduled`, `assistant.configUpdated`, `assistant.reminderPaused`, `assistant.reportNotFound` 등

### spawnSession 콜백 구현 참고

`CliProcess`는 EventEmitter 패턴. 이벤트 타입:
- `init`: 세션 초기화 (`{ sessionId }`)
- `stream`: 스트리밍 텍스트 (`{ text }`)
- `assistant`: 어시스턴트 메시지 완료 (`{ content }`)
- `result`: 세션 종료 (`{ result, cost_usd }`)
- `error`: 에러

`runScheduledGreeting()` (line 1440)의 패턴을 참고하되, 차이점:
- greeting은 `handleMessage()`를 통해 전체 파이프라인을 타지만
- assistant 세션은 `runQuery()` 결과만 수집하여 직접 `sendMessage()`로 전달

### 검증 방법

1. `npm run build` 성공
2. pm2 restart 후 로그에 `AssistantScheduler` 초기화 확인
3. 슬랙에서 `-briefing` 입력 → 브리핑 메시지 수신 확인
4. 슬랙에서 `-assistant config` → 현재 설정 표시 확인

### 완료 조건

- [x] `src/assistant-scheduler.ts` 구현
- [x] `src/slack-handler.ts`에 AssistantScheduler 통합
- [x] 새 명령어 3종 (-briefing, -report, -assistant) 파싱
- [x] `npm run build` 성공
- [x] TypeScript strict 타입 에러 없음

---

## DEFAULT_WORKING_DIRECTORY 추가 — DM 기본 작업 디렉토리

DM에서 `-cwd` 없이 대화를 시작해도 자동으로 `claude-workflow`를 cwd로 사용하여 비서 컨텍스트(CLAUDE.md, config, prompts)가 로드되도록 한다.

### 배경
- `-cwd`는 특정 프로젝트 작업 전 사용자가 명시적으로 설정하는 용도
- 개인비서는 아무 설정 없이 DM에서 바로 응답해야 함
- `getWorkingDirectory()`가 `undefined`를 반환하면 현재는 에러 표시됨

### 변경 사항

#### 1. `.env` — 환경변수 추가
```
DEFAULT_WORKING_DIRECTORY=P:\github\claude-workflow
```

#### 2. `src/config.ts` — 필드 추가
```typescript
defaultWorkingDirectory: process.env.DEFAULT_WORKING_DIRECTORY || '',
```
`baseDirectory` 아래에 추가.

#### 3. `src/working-directory-manager.ts` — fallback 추가
`getWorkingDirectory()` 메서드의 마지막 `return undefined` 직전에:
```typescript
// Fall back to default working directory (for assistant context)
if (config.defaultWorkingDirectory) {
  this.logger.debug('Using default working directory', {
    directory: config.defaultWorkingDirectory,
  });
  return config.defaultWorkingDirectory;
}
```

### 동작 흐름 (우선순위)
1. 스레드별 `-cwd` 설정 → 최우선
2. 채널/DM 레벨 `-cwd` 설정 → 차선
3. **`DEFAULT_WORKING_DIRECTORY` → 새 fallback**
4. `undefined` → 에러 (이전과 동일)

### 검증 방법
1. `npm run build` 성공
2. `.env`에 `DEFAULT_WORKING_DIRECTORY` 설정
3. pm2 restart 후 DM에서 `-cwd` 없이 새 스레드 시작
4. Claude가 `claude-workflow`의 CLAUDE.md를 인식하는지 확인
5. 특정 스레드에서 `-cwd D:\CT2606\plan` → 해당 스레드는 오버라이드 확인

### 완료 조건
- [x] `src/config.ts` 수정
- [x] `src/working-directory-manager.ts` 수정
- [x] `.env` 값 추가
- [x] `npm run build` 성공

---

## 스케줄 세션에 `CLAUDE_SCHEDULED=1` 환경변수 추가

### 배경
AssistantScheduler가 스폰하는 Claude 세션(브리핑, 캘린더 리마인더, 분석)이 종료될 때
Stop hook(`notify-stop.py`)이 Windows 토스트 알림을 발생시킨다.
스케줄 세션 결과는 이미 Slack DM으로 전달되므로 Windows 알림은 중복이다.

hook 쪽은 이미 `os.environ.get('CLAUDE_SCHEDULED')` 체크를 추가 완료.
슬랙봇에서 환경변수를 주입하면 자동 세션의 불필요 알림이 사라진다.

### 변경 사항

#### `src/assistant-scheduler.ts`

`spawnSession` 호출부에 `env: { CLAUDE_SCHEDULED: '1' }` 추가. 총 3곳:

1. **runBriefing()** (line ~345): `env` 필드 추가
```typescript
env: { CLAUDE_SCHEDULED: '1' },
```

2. **pollCalendar()** (line ~440): `env` 필드 추가
```typescript
env: { CLAUDE_SCHEDULED: '1' },
```

3. **runSingleAnalysis()** (line ~563): 기존 `ASSISTANT_MODE`에 병합
```typescript
env: { ASSISTANT_MODE: 'analysis', CLAUDE_SCHEDULED: '1' },
```

### 검증
1. `npm run build` 성공
2. pm2 restart 후 리마인더 폴링 시 Windows 토스트가 뜨지 않는지 확인
3. Slack DM 응답은 정상 전달되는지 확인

### 완료 조건
- [x] 3개 spawnSession 호출에 `CLAUDE_SCHEDULED: '1'` 추가 (briefing, analysis, calendar-poller judgment)
- [x] `npm run build` 성공

---

## 분석 프레임워크 유연화 — 타입별 도구/권한 설정

### 배경
현재 `runSingleAnalysis()`에서 `allowedTools`와 `appendSystemPrompt`가 하드코딩되어 있다.
분석 타입마다 필요한 도구와 쓰기 경로가 다르므로, config.json의 `defaults` + 타입별 오버라이드 구조로 변경한다.
새 분석 타입 추가 시 프롬프트 파일 + config 항목만 추가하면 되도록 한다.

### config.json 구조 (이미 claude-workflow에 반영 완료)

```json
"analysis": {
  "budgetUsd": 5.00,
  "defaults": {
    "sessionBudgetUsd": 2.00,
    "allowedTools": ["Read", "Glob", "Grep", "WebSearch", "WebFetch", "Write"],
    "writablePaths": ["reports/"]
  },
  "types": {
    "skill-review": {
      "enabled": true,
      "allowedTools": ["Read", "Glob", "Grep", "WebSearch", "WebFetch", "Write", "Edit"],
      "writablePaths": ["reports/", "references/"]
    },
    "ai-practice": { "enabled": true },
    "competitors": { "enabled": true, "tools": [...] },
    ...
  }
}
```

### 변경 사항

#### 1. `AssistantConfig` 인터페이스 변경

```typescript
// Before
analysis: {
  schedule: string;
  deliveryTime: string;
  enabled: Record<string, boolean>;
  competitors: { tools: string[] };
  budgetUsd?: number;
  sessionBudgetUsd?: number;
};

// After
analysis: {
  schedule: string;
  deliveryTime: string;
  budgetUsd?: number;
  defaults: {
    sessionBudgetUsd: number;
    allowedTools: string[];
    writablePaths: string[];
  };
  types: Record<string, {
    enabled: boolean;
    allowedTools?: string[];
    writablePaths?: string[];
    sessionBudgetUsd?: number;
    [key: string]: unknown;
  }>;
};
```

#### 2. `runAnalysis()` — `types`에서 활성 타입 읽기

```typescript
// Before
const enabledTypes = Object.entries(this.config.analysis.enabled)
  .filter(([, enabled]) => enabled)
  .map(([type]) => type);

// After
const enabledTypes = Object.entries(this.config.analysis.types)
  .filter(([, cfg]) => cfg.enabled)
  .map(([type]) => type);
```

#### 3. `runSingleAnalysis()` — defaults와 타입 오버라이드 병합

```typescript
// Before (하드코딩)
allowedTools: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'Write'],
appendSystemPrompt: 'CRITICAL: reports/ 디렉토리에만 새 파일 생성. 기존 파일 수정/삭제 금지.',

// After (동적 구성)
const defaults = this.config.analysis.defaults;
const typeConfig = this.config.analysis.types[type] || {};
const sessionBudget = typeConfig.sessionBudgetUsd ?? defaults.sessionBudgetUsd;
const allowedTools = typeConfig.allowedTools ?? defaults.allowedTools;
const writablePaths = typeConfig.writablePaths ?? defaults.writablePaths;
const pathList = writablePaths.join(', ');
const systemPrompt = `CRITICAL: ${pathList} 디렉토리에만 파일 생성/수정 가능. 그 외 기존 파일 수정/삭제 금지.`;
```

### 완료 조건
- [x] `AssistantConfig` 인터페이스 변경 (레거시 `enabled`/`competitors`/`sessionBudgetUsd` 제거)
- [x] `runAnalysis()` — `types`에서 읽기로 전환 (레거시 fallback 제거)
- [x] `runSingleAnalysis()` — defaults/override 병합 로직
- [x] `npm run build` 성공

---

## 브리핑 누락 방지 — 재시작 시 catch-up

### 배경
2026-03-30(월) 아침 브리핑 누락. 원인: 봇 다운 후 월요일 정오경 재시작 → 08:30 타이머 이미 지남.
`scheduleBriefing()`은 "다음 업무일 시간"만 계산하므로, 재시작 시점이 당일 브리핑 시간 이후면 하루 통째로 스킵.

### 변경 사항

#### `src/assistant-scheduler.ts`

`scheduleAll()` 또는 `start()` 실행 시, 마지막 브리핑 실행 일자를 체크하여 오늘이 업무일이고 아직 실행되지 않았으면 즉시 실행.

1. **마지막 브리핑 일자 추적**: `.assistant-costs.json`에서 가장 최근 `type: "briefing"` 엔트리의 timestamp를 읽어 KST 날짜 추출
2. **catch-up 판정**: `오늘(KST) !== 마지막 브리핑 날짜(KST)` && `isNonWorkingDay() === false` && `현재 시각 > briefing.time`
3. **즉시 실행**: 조건 충족 시 `executeBriefing()` 호출 후 정상 스케줄링 진행

```typescript
private async catchUpBriefingIfNeeded(): Promise<void> {
  if (!this.config?.briefing.enabled) return;

  const lastBriefingDate = this.getLastBriefingDate(); // from .assistant-costs.json
  const todayKST = this.getTodayKST(); // YYYY-MM-DD in KST

  if (lastBriefingDate === todayKST) return; // 오늘 이미 실행됨
  if (this.isNonWorkingDay().skip) return;    // 비업무일

  const [h, m] = this.config.briefing.time.split(':').map(Number);
  const now = new Date();
  if (now.getHours() < h || (now.getHours() === h && now.getMinutes() < m)) return; // 아직 시간 안 됨

  this.logger.info('Catch-up briefing: missed today, running now');
  try {
    const result = await this.executeBriefing();
    this.recordCost('briefing', result.costUsd, result.sessionId);
    await this.sendMessage(result.text + this.formatErrorReport() + this.formatCostLine());
  } catch (error) {
    this.logger.error('Catch-up briefing failed', error);
  }
}
```

### 완료 조건
- [x] `catchUpBriefingIfNeeded()` 구현
- [x] `start()`에서 15초 후 호출
- [x] `npm run build` 성공

---

## 월요일 주간 요약 브리핑

### 배경
현재 브리핑은 매일 동일한 형식 (당일 일정 + 대기 보고서). 월요일에는 지난 주 요약이 필요:
- 주간 세션/비용 통계
- 지난 주 생성된 보고서
- 주요 작업 요약

### 변경 사항

#### 1. `assistant/prompts/monday-briefing-extra.md` (새 프롬프트 섹션)

월요일일 때 기존 프롬프트에 추가 주입할 섹션:

```markdown
## 주간 요약 (월요일 전용)

추가로 다음 정보를 수집하여 브리핑에 포함하세요:

1. `.assistant-costs.json`을 읽어 지난 7일간 비용 통계:
   - 일별 비용 합계 (briefing, reminder, analysis 구분)
   - 주간 총 비용

2. `reports/` 디렉토리에서 지난 7일간 생성된 보고서:
   - 각 보고서의 제목과 절대 경로
   - 핵심 발견사항 1줄 요약

출력 형식에 다음 섹션을 추가하세요:

📊 *주간 요약 (지난 7일)*
• 총 비용: $X.XX (브리핑 $X.XX / 리마인더 $X.XX / 분석 $X.XX)
• 보고서 N건:
  - [유형] YYYY-MM-DD — 한 줄 요약
    `절대경로`
```

#### 2. `src/assistant-scheduler.ts` — `executeBriefing()` 수정

```typescript
// 기존 prompt 로드 후, 월요일이면 추가 프롬프트 주입
const dayOfWeek = new Date().getDay();
if (dayOfWeek === 1) { // Monday
  const mondayExtra = path.join(this.promptsDir, 'monday-briefing-extra.md');
  if (fs.existsSync(mondayExtra)) {
    prompt += '\n\n' + fs.readFileSync(mondayExtra, 'utf-8');
  }
}
```

### 완료 조건
- [x] `assistant/prompts/monday-briefing-extra.md` 작성
- [x] `executeBriefing()`에서 월요일 판정 + 추가 프롬프트 주입
- [x] `npm run build` 성공

---

## 보고서 경로 표시 개선

### 배경
`-report` 명령과 브리핑에서 보고서를 표시할 때 파일명만 노출. 사용자가 직접 열 수 있는 절대 경로가 필요.

### 변경 사항

#### 1. `src/slack-handler.ts` — `handleReportCommand()` 수정

현재 (line 1443):
```typescript
await say({ text: `📄 *${latestFile}*\n\n${truncated}`, thread_ts: threadTs });
```

변경:
```typescript
const fullPath = path.resolve(path.join(reportsDir, latestFile));
await say({ text: `📄 *${latestFile}*\n\`${fullPath}\`\n\n${truncated}`, thread_ts: threadTs });
```

#### 2. `assistant/prompts/morning-briefing.md` — 보고서 출력 형식 수정

현재:
```
📊 *대기 중인 보고서*
• [보고서 유형] YYYY-MM-DD — 한 줄 요약
```

변경:
```
📊 *대기 중인 보고서*
• [보고서 유형] YYYY-MM-DD — 한 줄 요약
  `절대경로`
```

주의사항에 추가:
```
- 보고서 경로는 Glob 결과의 절대 경로를 그대로 표시하세요.
```

### 완료 조건
- [x] `handleReportCommand()`에 절대 경로 표시
- [x] `morning-briefing.md` 프롬프트에 경로 형식 추가
- [x] `npm run build` 성공

---

## 주간 분석 미실행 조사 + 브리핑 연동

### 배경
`config.json`에 `"schedule": "wednesday-20:00"`로 분석이 설정되어 있고, 11개 분석 타입이 모두 `enabled: true`이다. 하지만 `reports/` 하위 디렉토리(session-efficiency/, skill-review/, weekly/ 등)에 **보고서가 하나도 생성되지 않았다**. 실행 자체가 되지 않는 것으로 보인다.

또한 분석 보고서가 생성되더라도 **다음 브리핑에 요약이 포함되는지** 확인이 필요하다.

### 조사 항목

1. **분석 실행 여부 확인**
   - pm2 로그에서 `AssistantScheduler`의 analysis 관련 로그 확인
   - `scheduleAnalysis()`가 실제로 타이머를 등록하는지
   - 수요일 20:00 이후 실행 시도 로그가 있는지
   - 에러가 발생했다면 어떤 에러인지

2. **스케줄 파싱 확인**
   - `"wednesday-20:00"` 형식이 `scheduleAnalysis()`에서 정확히 파싱되는지
   - 타이머 등록 시 계산된 ms 값이 올바른지

3. **분석 실행 테스트**
   - `-report` 또는 수동 트리거로 단일 분석 타입(예: `session-efficiency`)을 실행하여 보고서 생성 확인
   - 실패 시 에러 원인 파악

4. **브리핑 연동 확인**
   - `morning-briefing.md` 프롬프트가 `reports/` 디렉토리를 스캔하도록 되어 있는지
   - 월요일 주간 요약(`monday-briefing-extra.md`)에서 보고서를 읽는 로직이 동작하는지

### 완료 조건
- [x] 분석 미실행 원인 파악 및 수정
  - 원인: WebFetch가 응답 없이 행 → CLI 12시간+ 무한 실행 → 봇 재시작으로 소실
  - 수정: `maxDurationMs` 타임아웃 + `maxRetries` 리트라이 (기본 60분, 2회)
  - `-analyze [type]` 수동 트리거 명령어 추가
- [x] 수동 트리거로 최소 1개 보고서 생성 확인
  - `session-efficiency` 분석 실행 → `reports/session-efficiency/2026-04-09.md` 생성 ($2.57)
- [ ] 다음 브리핑에서 대기 보고서가 표시되는지 확인 (Slack `-briefing`으로 확인 필요)
- [x] `npm run build` 성공

---

## 예약 문서 리마인더 Phase 2 — 캘린더 리마인더에 문서 내용 포함

### 배경
`claude-workflow`에 예약 문서 리마인더 기능이 구현되었다 (Phase 1 완료, 2026-04-09).
사용자가 "정리해서 화요일 10시에 알려줘" → .md 문서 + 캘린더 이벤트 생성.
현재 캘린더 리마인더는 이벤트 제목만 표시하고 문서 내용은 아침 브리핑에서만 전달된다.

Phase 2는 캘린더 리마인더가 연결된 문서의 내용까지 포함하여 지정 시간에 완전한 알림을 보내는 것.

### 규약
- 캘린더 이벤트 설명(description)에 `[scheduled-doc] reports/scheduled/{파일명}` 태그 포함
- 문서 위치: `P:/github/claude-workflow/reports/scheduled/{YYYY-MM-DD}-{slug}.md`
- 문서 포맷: YAML frontmatter (title, scheduled_at, calendar_event_id) + `## 요약` + `## 상세`

### 변경 사항

#### 1. `src/calendar-poller.ts` — GCalEvent에 description 추가

```typescript
// GCalEvent 인터페이스에 추가
description?: string;

// fetchCalendarEvents()에서 이벤트 매핑 시 추가
description: (item.description || '') as string,
```

#### 2. `src/calendar-poller.ts` — 이벤트 포맷팅에 description 포함

`formatEventForPrompt()` 또는 diff 데이터 포맷팅 시 description 필드를 포함하여
`calendar-judgment.md` 프롬프트가 이벤트 설명을 볼 수 있게 한다.

```typescript
// 포맷 예시
`${event.summary} | ${event.start} ~ ${event.end} | ${event.location || ''} | desc: ${event.description || ''}`
```

#### 3. `assistant/prompts/calendar-judgment.md` — `[scheduled-doc]` 감지 규칙 추가

기존 결정 기준에 추가:

```
6. 예약 문서 리마인더: 이벤트 설명에 `[scheduled-doc]`이 포함된 경우:
   - type: "scheduled-doc"
   - message에 문서 경로 포함: "📋 예약 문서 리마인더: {제목}\n`{문서경로}`"
   - 해당 경로의 파일을 Read로 열어 ## 요약 섹션 내용을 message에 포함
```

출력 type에 `"scheduled-doc"` 추가:
```
- `type`: "upcoming" | "change" | "cancel" | "scheduled-doc"
```

#### 4. `src/assistant-scheduler.ts` — scheduled-doc 타입 알림 처리

`processNotifications()` 또는 알림 전송 로직에서 `type === "scheduled-doc"` 시
문서 파일을 읽어 내용을 Slack 메시지에 포함:

```typescript
if (notification.type === 'scheduled-doc') {
  // notification.message에서 문서 경로 추출
  // fs.readFileSync로 문서 읽기
  // Slack 메시지에 요약 내용 포함
}
```

### 검증 방법
1. `npm run build` 성공
2. 테스트 캘린더 이벤트 생성 (설명에 `[scheduled-doc]` 포함)
3. 리마인더 폴링에서 이벤트 감지 → 문서 경로 추출 → 내용 포함 알림 확인
4. 문서 없는 일반 이벤트는 기존 동작 유지 확인

### 완료 조건
- [x] `GCalEvent`에 `description` 필드 추가
- [x] 이벤트 포맷팅에 description 포함
- [x] `calendar-judgment.md`에 `[scheduled-doc]` 규칙 추가
- [x] scheduled-doc 알림 시 문서 내용 포함 전송 (dispatch 시 `fs.readFileSync`로 `## 요약` 섹션 추출)
- [x] `npm run build` 성공

---

## 아침 브리핑 날짜 오류 — 어제 캘린더가 표시됨

### 배경
2026-04-14(화) 아침 브리핑에 어제(월) 캘린더 일정이 표시됨.
pm2 로그 기준 브리핑 실행 시각: `2026-04-13T23:00:18Z` (UTC) = 4월 14일 08:00 KST.
실행 시각은 정상이나 캘린더 조회 시 "오늘"이 어제 날짜로 해석된 것으로 추정.

### 조사 항목
1. `executeBriefing()`에서 세션 스폰 시 시스템 timezone이 KST인지 UTC인지 확인
2. `morning-briefing.md` 프롬프트의 "오늘 00:00 ~ 23:59"가 Claude 세션 내에서 어느 timezone 기준으로 해석되는지
3. catch-up 브리핑인 경우 "오늘"이 스케줄 기준 날짜인지 실행 시점 날짜인지
4. Google Calendar MCP `list-events`의 날짜 파라미터가 UTC인지 로컬인지

### 수정 방향
- 프롬프트에 명시적 날짜를 주입: `executeBriefing()`에서 KST 기준 오늘 날짜를 `{today}` 변수로 프롬프트에 삽입
- 또는 `list-events` 호출 시 timezone 명시 (`timeZone: 'Asia/Seoul'`)

### 완료 조건
- [x] 원인 확인 (timezone 또는 catch-up 로직)
  - 원인: `executeBriefing()` line 551에서 `new Date().toISOString().substring(0,10)` → UTC 날짜 반환
  - 08:00 KST = 23:00 UTC **전날** → 캐시가 "어제" 저장됐어도 UTC 날짜가 같아 "fresh"로 판정
  - `fetchAllEvents()`는 로컬 TZ 기준이라 정확하지만, 캐시 비교만 UTC 사용 → 불일치
- [x] 수정 구현
  - `toLocalDate()` 헬퍼로 로컬 TZ 기준 YYYY-MM-DD 비교 (`getFullYear/getMonth/getDate`)
  - 캐시의 `fetchedAt`도 로컬 TZ로 변환 후 비교
- [x] `npm run build` 성공
- [ ] 다음 날 브리핑에서 정확한 날짜 일정 확인
