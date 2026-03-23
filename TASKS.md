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
