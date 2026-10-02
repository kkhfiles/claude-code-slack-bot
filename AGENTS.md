# 작업 지시서 확인 (최우선)

세션 시작 시 `TASKS.md` 파일이 존재하는지 확인한다.
파일이 있으면:
1. 내용을 읽고 미완료(`[ ]`) 작업을 파악
2. Plan Mode로 진입하여 구현 계획 작성
3. 사용자 승인을 받은 후 구현 진행
4. 완료된 작업은 `[x]`로 표시하고, 필요 시 결과 노트를 추가
5. 모든 작업 완료 시 사용자에게 보고

# Claude Code Slack Bot - Project Conventions

**규칙은 이 파일에 적는다** — Claude Code 와 Codex 가 함께 읽는다(`CLAUDE.md` 는 이 파일을 불러오는 한 줄). 명령별 상세 · 메모리 워치독 · 파일 목록 같은 참고 자료는 `docs/` 에 둔다. 이 파일은 28 KB 를 넘지 않는다 — Codex 는 기본 32 KiB 넘는 부분을 말없이 자른다(`npm run check:agents-md`).

## 개인 글 — 실원이 봇에게 전한 말은 남·방으로 안 나간다 (2026-09-30 · 최우선)

**원칙(실장 결정)**: 실원이 봇에게 DM·슬래시 명령·창구(1on1 신청·커피챗·칭찬)로 전한 말은 **실장 DM 과 그 말의 당사자 DM 말고는 어디로도 안 나간다.** 방·다른 사람 DM 은 물론이고 로그 원문·저장소·AI 가 도는 작업 폴더·외부 모델도 「나간다」에 든다. 기능을 새로 만들거나 고칠 때 이 원칙이 다른 모든 편의보다 앞선다.

지키는 장치는 세 겹이고, **새 코드가 이 장치를 돌아가면 안 된다**:

- **개인 글 문**(`src/privacy-guard.ts`) — `WebClient.prototype.apiCall` 의 가장 바깥(활동 기록 다음에 설치). 개인 글 조각이 실린 글은 실장·당사자 DM 말고는 막고 실장에게 「막았다」만 알린다. 조각 기준은 파이썬 방 답 빗장(`work-assistant/chatbot/privacy_gate.py`)과 같다(10자 · 1:1 대화 12자 · 짧은 원문 통째)
- **활동 기록 가림**(`src/activity-log.ts` `scrub`) — 실원이 봇에게 한 말 · 실장에게 넘긴 DM · 실원 DM 방의 봇 답 · 개인 글 조각은 원문 대신 글자 수만
- **시험**(`check:privacy` · `check:activity` · `check:1on1dm`) — 막을 것·통과시킬 것 · 로그에 원문 없음 · 문을 돌아가는 길을 소스에서 센다

그래서 코드를 쓸 때:

1. **슬랙에 보내는 길은 `WebClient` 하나** — `slack.com/api` 에 직접 HTTP 를 쏘거나 `apiCall` 을 새로 감싸지 않는다(`check:privacy` 가 실패한다). 창(모달)은 문이 안 보므로 **여는 쪽이 누른 사람을 가린다**
2. **개인 글을 새 파일에 쌓으면 문의 원천(`privacy-guard.ts` `SOURCES`)에 넣는다** — 안 넣으면 문이 그 글을 모른다. 파일은 `bots/<봇>/data/`(Git 추적 제외)
3. **로그·활동 기록에 사용자 글을 넣지 않는다** — 로그 줄에는 이름·글자 수·까닭만. 활동 기록은 `note()` 로만 적는다(`scrub` 을 거친다). 시험·점검 스크립트도 개인 글을 찍지 않는다(건수·길이만)
4. **개인 글이 쌓이는 폴더는 AI 작업 폴더(Claude·Codex 가 도는 곳) 밖** — 넓게 찾다가 모델 프롬프트로 들어간다. 활동 기록은 `%LOCALAPPDATA%/bot-activity`(`BOT_ACTIVITY_DIR`)
5. **대화 명단 밖 DM 은 모델에 안 태운다** — 모델은 외부 서비스다. 실장에게 그대로 넘기고(`bypassToManager` · 지문만 적음) 명단을 넓히는 것은 실장 결정
6. **외부 서비스에 쓸 때는 넣기 전에 공유 범위를 본다** — 예: 1on1 확정 일정은 「업무」 캘린더에 넣되 그 캘린더가 이 계정만 보는지 먼저 확인하고, 공유돼 있으면 안 넣는다(`CalendarPoller.privateCalendarId`)
7. **남에게 보내는 알림에는 그 사람 글만** — 신청 메모·넘긴 DM 을 다른 알림(신청자 확정·장소 알림·캘린더 설명)에 다시 싣지 않는다

## Overview
- Fork of [mpociot/claude-code-slack-bot](https://github.com/mpociot/claude-code-slack-bot)
- Cross-platform (Windows/macOS/Linux), CLI (`claude -p`) 기반 프로세스 스폰
- Slack Socket Mode (공개 URL 불필요)
- `main` 브랜치 기반, 기능 개발은 `feature/*` 브랜치

## Build & Run

```bash
npm install                    # macOS / Linux
npm install --ignore-scripts   # Windows (플랫폼 체크 우회)
npm run build                  # TypeScript → dist/

# 초기 설정 (전제 조건 체크 + 의존성 + .env + pm2 + 빌드)
./setup.sh                    # macOS / Linux
setup.bat                     # Windows

# 실행
./start.sh                    # macOS / Linux
start.bat                     # Windows (pm2로 빌드+실행)
./stop.sh / stop.bat          # 중지

# 업데이트 (git pull + npm install + 빌드 + pm2 재시작)
./update.sh                   # macOS / Linux
update.bat                    # Windows
```

- pm2 프로세스명: `claude-slack-bot`
- 로그: `pm2 logs claude-slack-bot`

### 재시작은 `npm run restart` 로 — `pm2 restart` 를 직접 치지 않는다

`pm2 restart` 는 **처리 중이던 판 메모를 죽인다.** 2026-08-21 에 큐가 TSK-35 메모를 세션에 넘긴 **6초 뒤** 재시작이 그 세션을 죽였고, 다시 가져왔을 때는 부르기 전에 찍어 둔 처리 표시 때문에 「이미 반영한 것」으로 버려졌다(`board-queue.ts` 의 「한 번만 시도한다」). 원문은 캡처 큐에 살아 있었지만 그것을 알려 주는 것은 다음 브리핑뿐이라 14시간 뒤였다.

```bash
npm run restart              # 걸리는 것을 세고 안전하면 재시작
npm run restart -- --dry     # 세기만
npm run restart -- --force   # 다 알고 그냥
npm run check:restart        # 그 문이 실제로 막는지
```

- **아직 반영 안 된 사람 말이 지금 도는 중이면 멈춘다** — 재시작해도 해결 안 되고 도는 것만 또 죽인다. 「도는 중」은 차례 포인터에 있거나 붙은 지 30분 안인 캡처다
- **오래 열린 캡처는 알리기만 한다** — 판에 쓰기가 없는 질문·조회는 캡처가 안 닫힌 채 남는다. 그걸 다 세던 때는 하루 지난 질문 하나가 재시작을 막았다(2026-09-23 고침)
- **큐가 방금 움직였으면 기다린다** — 최대 3분, 넘으면 사람에게 넘긴다
- **지금 떠 있는 봇이 연 분석 회차가 안 닫혔으면 멈춘다** — 재시작하면 그 판정 세션이 죽고 그룹의 뒤 차례는 아예 안 돈다(2026-10-02 에 두 번). 봇이 뜨기 전에 열린 회차는 주인이 없어 알리기만 한다 · 정리 작업이 6시간 뒤 받는다
- **규칙으로 적지 않고 길에 붙인 이유** — 「재시작 전에 확인할 것」은 사람이 기억해야 하는 구조라 실패한다

### 검사는 `npm test` 하나로 (2026-08-23)

```bash
npm test        # 빌드 + check:* 전부
```

**어느 검사를 돌릴지 고르지 않는다.** `package.json` 의 `check:*` 를 읽어 다 돌리므로 **검사를 새로 만들면 저절로 들어온다.** 손으로 적은 목록을 두면 그 목록이 낡고, 낡은 목록은 「다 돌렸다」면서 새 검사를 빼먹는다.

- **첫 실패에서 안 멈춘다** — 다 돌리고 끝에 모아 낸다
- **0개를 찾으면 통과가 아니라 실패** — 찾는 규칙이 헛돌면 조용히 늘 통과한다
- **`check:board` 는 서버를 스스로 띄운다** — 포트 8788(사람이 쓰는 8787 을 안 뺏음) · 끝나면 트리째 내림. 전에는 다른 터미널을 요구해서 **아홉 중 이것만 못 돌고 있었다**
- **`check:cli` 는 레포 경계를 본다** — 봇이 부르는 서브커맨드·플래그가 `tasks.py` 에 아직 있나. 한쪽만 고치면 08:00 브리핑에서야 티가 난다
- 따로 부를 일이 있으면 `npm run check:<이름>`

## Coding Rules

### 중복 방지 기억은 처리 대기열과 같은 수명에 두지 않는다 (2026-09-02)

**소인이 방에서 한 마디에 두 번씩 답했다.** 「이미 담은 글」 목록을 대기열 항목(`Waiting`) 안에 뒀는데, `pump` 가 턴을 시작하며 그 항목을 통째로 지운다(`pending.delete`). 그래서 **지금 답을 만들고 있는 바로 그 말**이 아무 데도 안 남고, 10~15초 뒤 훑기가 방을 다시 읽으면 봇이 아직 답을 안 올린 탓에 「답 안 한 글」로 보여 다시 담긴다. 턴이 끝나자마자 `pump` 의 반복문이 그걸 집어 한 번 더 나간다. 실측: 그날 부름 16번 중 4번(간격 11~15초).

- **처리하는 동안이 정확히 그 기억이 비어 있는 구간이다** — 중복이 나는 시간과 기억이 사라지는 시간이 겹친다
- 기억은 **처리 단위 바깥**에 둔다(`ChatHost.taken`) · 상한을 걸어 오래된 것부터 버린다(`TAKEN_MEMORY`)
- **막는 검사가 이미 있어도 안심하지 않는다** — 훑기 쪽 검사(「줄이 하나도 안 남았다 = 이미 도는 턴에 들어가 있다」)가 바로 그 지워진 기억을 믿고 있었다
- 대신 잃는 것 — 턴이 넘어져 방에 아무 말도 안 남은 것을 훑기가 되집어 주던 길이 닫힌다. 부른 턴은 「못 했다」 한 줄이 나가고, 먼저 말 걸려던 턴은 아무도 안 기다린다
- 검사: `npm run check:double` — 턴이 도는 상태로 만들어 놓고 훑기를 돌린다. **지나치게 막아 귀를 닫는 것도 같이 잰다**(도는 사이에 온 새 말은 집어야 통과)

### TypeScript
- 엄격한 타입 사용, `any` 최소화 (Slack API 등 불가피한 경우만)
- 클래스 기반 구조 유지 (SlackHandler, CliHandler, WorkingDirectoryManager 등)
- 새 기능은 기존 클래스에 메서드 추가 또는 별도 Manager 클래스로 분리

### Command Pattern
- 모든 사용자 명령어는 `-` 접두사 필수 (`-cwd`, `-stop`, `-sessions` 등)
- 예외: `help`, `resume`, `continue`, `keep going`, `계속`, `계속하자`는 `-` 없이도 동작 (모바일 편의)
- 명령어 파싱은 정규식 기반, `slack-handler.ts`의 `is*Command()` / `parse*Command()` 패턴
- **명령별 동작 · 설정 · 저장 파일은 `docs/commands.md`** — 명령을 고치거나 새로 만들기 전에 그 문서의 해당 항목을 먼저 읽는다
- **건드리기 전에 알아야 할 것** — 명령 상세에 묻혀 있던 교훈(원문 그대로 · 맥락은 `docs/commands.md`):
  - 토큰 만료 90분 전 자동 갱신 (OAuth refresh), 갱신 실패 시 `null` 반환 (만료 토큰 사용 방지)
  - **토큰 공유**: `captureForSlot()`은 캡처만 수행 (독립 refresh 삭제 — 토큰 체인 파괴 원인이었음)
  - **터미널 보호**: 터미널 활성 계정은 선제적 갱신 건너뜀 (OAuth rotation이 터미널 인메모리 refresh token 무효화 방지), 토큰 실제 만료 시에만 갱신
  - `notifyAt` 보정 (`clampNotifyAt`): "upcoming" 알림의 `notifyAt`이 `eventStart - beforeMinutes`보다 이르면 강제 보정 (AI 판단 오류 안전장치)
  - 분석 회차와 보고서 저장 — report-log 5단계(쓰는 쪽). **저장 주체는 스탠리 하나** · 설계 정본은 report-log `docs/stage5-plan.md` 「쓰는 흐름」 · 검사 `npm run check:reportrun`
  - 처리 백엔드: `SessionResult.servedBy`(`spawnOrFallback` 이 붙임) · agy 위임 경로(`ANALYSIS_AGY_TYPES`)는 없앰 — agy 는 도구 없는 회차의 폴백 사다리에서만 씀
- 새 명령어 추가 시:
  1. `is*Command()` 또는 `parse*Command()` 메서드 작성
  2. `handleMessage()`의 명령어 분기에 추가 (stop은 help보다 먼저 체크)
  3. `messages.ts`의 `getHelpText()`에 도움말 추가
  4. `README.md`에도 반영
  5. `docs/commands.md` 에도 반영

### Error Handling
- CLI 프로세스 에러는 `try/catch`로 감싸고, Slack 메시지로 사용자에게 전달
- Rate limit 감지: CLI `rate_limit_event` 이벤트 + `isRateLimitText()` 공유 유틸 (`src/rate-limit-utils.ts`)
  - 사용자 세션: 4단계 UI (계정 전환 → API 키 → 자동 재실행 → 취소)
  - 스케줄 세션: rate limit 감지 시 안내 메시지 전송 (브리핑), 분석 전체 중단
  - 캘린더 판단: rate limit 시 다음 정시까지 AI 판단 일시 중지 (`pauseAiJudgment()`)
- 자동 재실행 (`pendingRetries` + `pendingAutoRetries` + `pendingRetryCleanup`):
  - "자동 재실행" 버튼 → reset 시각 +60초 버퍼에 `setTimeout` 큐잉 → 동일 thread에 원본 prompt로 `handleMessage()` 재진입
  - "취소" 버튼 또는 10분 무클릭 → `clearRetryTimers()`로 모든 타이머/엔트리 정리
  - 메모리 전용, 영속화 X (pm2 재시작 시 자연 소멸 — rate limit 정보 자체가 시한성)
- API 키 fallback: rate limit 시 등록된 API 키로 전환 → 리셋 시간 후 구독 방식으로 자동 복귀
- 다중 계정 fallback: rate limit 시 `AccountManager.switchToNext()` → account-1 → account-2 → account-3 → API 키 버튼 순으로 전환
- 읽기 전용 도구 (Grep, Read, Glob 등)는 상태 메시지에서만 표시 (`STATUS_ONLY_TOOLS`)
- CLI `is_error` 감지: `cliError` 플래그 추적 → 에러 시 ❌ 리액션 + `status.errorOccurred` 표시
- 완료 시 도구 사용 요약 표시 (`toolUsageCounts` → `✅ Task completed (Grep ×5, Read ×2)`)
- 로깅은 `Logger` 클래스 사용 (`this.logger.info/debug/warn/error`)
- **시스템 메모리 워치독**: `ProcessMemoryWatchdog` — 감시 경로 · 종료 규칙 · 관찰 모드 · 환경 변수 · 검사(`npm run check:watchdog`)는 `docs/memory-watchdog.md` · 고치기 전에 그 문서를 먼저 읽는다

### CLI Integration
- `child_process.spawn('claude', ['-p', '--output-format', 'stream-json', ...])` 방식
- `CliProcess` 클래스: AsyncIterable<CliEvent> 패턴으로 stdout 스트리밍
- **경량 모드 옵션** (`runQuery()` opts):
  - `systemPrompt`: `--system-prompt` (기본 프롬프트 교체, ~7K 토큰 절감)
  - `tools`: `--tools` (빈 배열이면 전체 비활성)
  - `noSessionPersistence`: `--no-session-persistence` (세션 파일 미생성)
  - `cwd=os.tmpdir()`: CLAUDE.md 미로드 (~25-39K 토큰 절감)
  - 캘린더 판단 세션에 적용: $0.051 → $0.003/세션 (94% 절감)
- 권한 모드 계층 (제한적 → 자유):
  - Default (기본): `--permission-mode default` + `--allowedTools` (읽기 도구만)
  - `-safe`: `--permission-mode default` + `--allowedTools` (읽기 + 편집 도구)
  - `-trust`: `--dangerously-skip-permissions` → 모든 도구 자동 승인
  - `-default`: 기본 모드로 복귀
- 권한 거부 처리: `result.permission_denials` 감지 → Slack 버튼 (Allow [tool] / Allow All & Resume)
  - 승인된 도구는 `channelAlwaysApproveTools`에 등록 → `--allowedTools`에 자동 포함
  - `-default` 또는 `-reset` 시 초기화
- Resume 우선순위: 명시적 resumeSessionId > Slack 세션 > 새 대화
- Slack은 backtick(`)으로 텍스트를 감쌀 수 있음 → 정규식에서 선택적 backtick 처리

### Runtime Routing (CLI / SDK)

`claude -p` subprocess 경로(`cli-handler.ts`)와 in-process `@anthropic-ai/claude-agent-sdk` 경로(`sdk-handler.ts`)를 호출별로 선택. 두 경로는 동일한 `CliEvent` shape을 산출하므로 호출자(`slack-handler`, `assistant-scheduler`, `calendar-poller`)는 동일 for-await 루프로 처리.

**Scope 토글 (`shouldUseSdk(scope)`)**:
- `SLACKBOT_SDK_ENABLED`: 콤마(또는 `+`) 구분 scope 토큰 리스트, 또는 `all`/`1`/`true`. 빈 값이면 모두 CLI.
- `scope`는 `category` 또는 `category:detail` 형식. detail이 있으면 category prefix도 매칭. 예: `analysis` 토큰은 `analysis:kg-skill-update` scope를 통과시킴.
- `SLACKBOT_FORCE_CLI=1`: 긴급 롤백 — 모든 SDK 경로 무시하고 CLI로 강제.

**Scope별 호출 위치**:
| Scope | 호출 위치 | 용도 |
|---|---|---|
| `interactive` | `slack-handler.ts:685` | 사용자 메인 채팅 (handleMessage 경유) |
| `briefing` | `assistant-scheduler.ts:621` | 모닝 브리핑 |
| `calendar` | `calendar-poller.ts:601` | 캘린더 변경 AI 판단 |
| `analysis:${type}` | `assistant-scheduler.ts:922` | 12종 분석 (타입별 detail) |

**SDK 핸들러 운영 컨벤션** (2026-05-26 phase2 fix에서 정합화):
- **env 머지**: `opts.env` 전달 시 `{...process.env, ...opts.env}`로 머지. SDK는 `env` 옵션을 받으면 `process.env` 디폴트를 통째로 치환하므로 PATH·HOME·TZ 같은 표준 env 손실 방지.
- **appendSystemPrompt → preset.append**: SDK public Options에 `appendSystemPrompt` 키 없음. `systemPrompt: { type: 'preset', preset: 'claude_code', append: <text> }` 형태로 넘겨야 모델에 전달됨.
- **`tools` vs `allowedTools` 분리**: SDK는 두 개념을 별도 옵션으로 받음 — `tools`는 가용 도구 제한 (`[]`이면 모든 built-in 비활성), `allowedTools`는 auto-approve 리스트. CLI의 한 플래그(`--tools` variadic)와 다름.
- **`persistSession` 호출자 제어**: SDK 디폴트 `true`, `opts.noSessionPersistence: true`일 때만 `false`. CLI 디폴트(`--no-session-persistence` 미사용 시 persist)와 동등.
- **in-process 실행**: `SdkProcess.pid`는 항상 `undefined`. `activeProcesses: Map<string, CliProcess | SdkProcess>` 타입. `process-memory-watchdog`의 PID 매칭 정리는 SDK 호출에 무관 (외부 프로세스 없음).
- **`includePartialMessages: true`**: 인터랙티브 채팅의 실시간 tool status(`stream_event`/`content_block_start`) 보존. 다른 호출자는 미인식 이벤트를 그냥 건너뛰므로 안전.

자세한 회고는 `migrations/2026-06-sdk-restore/phase{0,1,2}-{notes,retrospective}.md` 참고.

### UX
- 쓰레드 힌트: 새 세션 첫 응답 시 기본 명령어 안내 (`-stop`, `-reset`, `-plan`, `-help`) 표시
- 앵커 리액션: 쿼리 실행 중 ⏳ 리액션 유지 → 리액션 수 0↔1 변동으로 인한 Slack 줄 점프 방지
- 도구 사용 요약: 완료 시 사용된 도구 카운트 표시 (`✅ Task completed (Grep ×5, Read ×2)`)

### Sessions
- Claude 세션 파일: `~/.claude/projects/<encoded-path>/*.jsonl`
- 경로 인코딩: 영숫자 외 문자 → `-` (예: `P:\bitbucket` → `P--bitbucket`)
- JSONL 형식: `type: "summary"` (제목), `type: "user"` (메시지), `type: "assistant"` (응답)
- CLI 호환: 쿼리 완료 시 `sessions-index.json`에 세션 등록 → `claude -c`/`-r`에서 Slack 세션 표시
- 세션 연속성: `lastAssistantUuid` 추적 (CLI `--resume`는 자동으로 마지막 상태에서 이어감)
- 세션 상태 영속화: `.session-state.json`에 sessionId/lastAssistantUuid 저장 → pm2 재시작 후 복원 (7일 보관)
- 빈 세션 필터링: 대화 내용 없는 세션 (file-history-snapshot만)은 피커에서 제외
- 메모리 정리: 24시간 비활성 세션 자동 정리 (5분마다 체크), 디스크 `.jsonl`은 유지
- CLI 공존 주의: 터미널 CLI `/exit`는 JSONL을 덮어써서 Slack 작업 유실 → 세션 피커 resume 시 안내 표시
- 세션 피커 한도: `MAX_PICKER_SESSIONS = 15` (Slack 50블록 제한, 세션당 3블록+5오버헤드)
  - 15개 초과 시 "Show more" 대신 `-cwd` → `-sessions` → `-resume <id>` 안내 표시

### MCP Integration
- `mcp-servers.json` (프로젝트 루트, `.gitignore`에 포함): 로컬 MCP 서버 설정
- `--mcp-config` 플래그로 CLI에 전달 (`cli-handler.ts:358-361`)
- **Google Calendar**: `@cocal/google-calendar-mcp` 패키지 (stdio), OAuth 자격 증명은 `~/.claude/` 저장
- platform MCP (`mcp__claude_ai_*`)는 `-p` 모드에서 미지원 → 로컬 MCP 사용
- 설정 가이드: `docs/google-calendar-setup.md`

### Working Directory
- 디스크 영속화: `.working-dirs.json`
- 우선순위: Thread > Channel/DM > DEFAULT_WORKING_DIRECTORY
- DM 쓰레드에서 설정 시 DM 레벨 폴백 자동 생성

### i18n (Korean / English)
- `src/messages.ts`: 번역 카탈로그 (`Record<string, Record<Locale, string>>`) + `t(key, locale, params?)` 함수
- Slack `users.info` API의 `locale` 필드로 자동 감지 (캐시됨): `ko-*` → Korean, 그 외 → English
- `{{variable}}` 보간 지원
- 번역 대상: 사용자에게 보이는 모든 문자열 (상태, 명령 응답, 버튼, 모달, 도움말 등)
- 번역 제외: Claude에게 보내는 프롬프트, 로그 메시지, 명령어 입력 파싱
- 새 문자열 추가 시: `messages.ts`에 키 추가 → `t('key', locale)` 호출

## Git Workflow

```bash
# upstream 업데이트
git fetch upstream
git checkout main && git merge upstream/main

# 기능 개발
git checkout -b feature/<name>
# ... 작업 후 main으로 머지
```

## File Overview

파일별 역할 → `docs/architecture.md` · 데이터 파일과 비밀 포함 여부는 아래 표

### Data Files

| File | Location | Contains Secrets |
|------|----------|-----------------|
| `.bot-accounts.json` | `~/.claude/` | ✅ OAuth 토큰 |
| `.bot-api-keys.json` | `~/.claude/` | ✅ API 키 |
| `.working-dirs.json` | 프로젝트 루트 | ❌ |
| `.session-state.json` | 프로젝트 루트 | ❌ |
| `.schedule-config.json` | 프로젝트 루트 | ❌ |
| `.assistant-costs.json` | 프로젝트 루트 | ❌ |
| `.calendar-cache.json` | 프로젝트 루트 | ❌ |
| `.calendar-notifications.json` | 프로젝트 루트 | ❌ |
| `.calendar-muted-events.json` | 프로젝트 루트 | ❌ |
