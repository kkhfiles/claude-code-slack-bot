# 작업 지시서 확인 (최우선)

세션 시작 시 `TASKS.md` 파일이 존재하는지 확인한다.
파일이 있으면:
1. 내용을 읽고 미완료(`[ ]`) 작업을 파악
2. Plan Mode로 진입하여 구현 계획 작성
3. 사용자 승인을 받은 후 구현 진행
4. 완료된 작업은 `[x]`로 표시하고, 필요 시 결과 노트를 추가
5. 모든 작업 완료 시 사용자에게 보고

# Claude Code Slack Bot - Project Conventions

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

## Coding Rules

### TypeScript
- 엄격한 타입 사용, `any` 최소화 (Slack API 등 불가피한 경우만)
- 클래스 기반 구조 유지 (SlackHandler, CliHandler, WorkingDirectoryManager 등)
- 새 기능은 기존 클래스에 메서드 추가 또는 별도 Manager 클래스로 분리

### Command Pattern
- 모든 사용자 명령어는 `-` 접두사 필수 (`-cwd`, `-stop`, `-sessions` 등)
- 예외: `help`, `resume`, `continue`, `keep going`, `계속`, `계속하자`는 `-` 없이도 동작 (모바일 편의)
- 명령어 파싱은 정규식 기반, `slack-handler.ts`의 `is*Command()` / `parse*Command()` 패턴
- `-stop`: `CliProcess.interrupt()`로 CLI 프로세스 중단 (세션 상태 보존)
- `-plan <prompt>`: `permissionMode: 'plan'`으로 읽기 전용 실행 → Execute 버튼으로 세션 resume
- `-default`/`-safe`/`-trust`: 권한 모드 전환 (default → safe → trust 순으로 자유도 증가)
- `-r`/`-resume`: 전체 프로젝트 세션 피커 (버튼 선택 → cwd 자동 전환 + 세션 재개)
- `-sessions all`: 전체 프로젝트 세션 목록 (세션 피커와 동일)
- `-version`: 봇 버전 + git hash + 업데이트 확인 (`src/version.ts`)
- `-apikey`: API 키 등록/수정 모달 (rate limit 시 자동 전환용, `~/.claude/.bot-api-keys.json` 영속화)
- `-account`: 다중 계정 상태 조회 및 수동 전환 (`AccountManager`, `~/.claude/.bot-accounts.json` 영속화)
  - `-account` — 통합 상태 뷰 (Set/Use/Unset 버튼)
  - `-account 1` / `-account 2` / `-account 3` — 수동 전환
  - 토큰 저장: `~/.claude/.bot-accounts.json` (accessToken, refreshToken, expiresAt, email, oauthAccount)
  - 전환: `CLAUDE_CODE_OAUTH_TOKEN` env var 주입 + `~/.claude/.credentials.json` + `~/.claude.json` 자동 동기화 (터미널 CLI도 전환 반영)
  - 토큰 만료 90분 전 자동 갱신 (OAuth refresh), 갱신 실패 시 `null` 반환 (만료 토큰 사용 방지)
  - **토큰 자동 동기화**: `fs.watchFile`로 `.credentials.json` 10초 간격 감시 → email 매칭으로 `.bot-accounts.json` 자동 갱신
  - 봇→터미널: refresh 시 `syncToCredentialsIfActive()` — email 매칭으로 터미널 활성 계정이면 `.credentials.json` 갱신
  - 터미널→봇: 파일 워처 + CLI 스폰 전 동기화
  - **토큰 공유**: `captureForSlot()`은 캡처만 수행 (독립 refresh 삭제 — 토큰 체인 파괴 원인이었음)
  - **토큰 건강 체크**: 1시간마다 + 시작 시 전 계정 체크, 체크 전 `syncFromCredentialsFile()` 실행, 갱신 실패 시 Slack 알림 (계정당 1회)
  - **터미널 보호**: 터미널 활성 계정은 선제적 갱신 건너뜀 (OAuth rotation이 터미널 인메모리 refresh token 무효화 방지), 토큰 실제 만료 시에만 갱신
  - rate limit 시 전환 체인: account-1 → account-2 → account-3 → API 키 버튼
- `-schedule`: 세션 자동 시작 설정 관리 (`ScheduleManager`, `.schedule-config.json` 영속화)
  - 블록 UI: 계정별 `[+ email]` 추가 버튼(모달) + 시간별 `[✕]` 삭제 버튼 + `[🗑 Clear all]`
  - 각 스케줄 엔트리는 특정 계정에 연결 (`ScheduleEntry: { time, account }`)
  - 같은 계정 내에서만 5시간 윈도우 충돌 검사 (다른 계정끼리는 겹쳐도 OK)
  - 모달 제출 후 원래 메시지를 `chat.update`로 즉시 갱신
  - 예약 시간 +5~25분 랜덤 지터로 자동화 감지 방지
  - **자동 팔로우업**: 첫 발송 후 5시간 뒤 두 번째 메시지 자동 발송 (다음 세션 윈도우 커버)
  - **비업무일 스킵**: 주말 + 한국 공휴일(음력 포함) 자동 스킵 (`date-holidays` 패키지, 오프라인)
  - 팔로우업 타이머 디스크 영속화 (`pendingFollowUps`) — pm2 재시작 후에도 복원, 만료분은 즉시 발사
  - 랜덤 인사 메시지 (`say "hi"`, `3+7` 등) + haiku 모델로 새 세션 시작
  - **일일 로테이션**: 2계정 교차 스케줄 시 짝수/홀수 dayOfYear로 계정 스왑 → 2주 합산 균형 (토글 버튼으로 ON/OFF)
- `-briefing`/`-br`/`브리핑`: 모닝 브리핑 즉시 실행 (`AssistantScheduler.runBriefing()`)
  - 캐시된 캘린더 데이터 사용 (MCP 미호출), 캐시 없으면 MCP fallback
  - `ErrorCollector`에 수집된 봇 에러를 `⚠️ 시스템 이슈` 섹션으로 일괄 보고
  - **재시작 시 catch-up**: `catchUpBriefingIfNeeded()` — `.assistant-costs.json`에서 마지막 브리핑 날짜 확인, 오늘 미실행이면 15초 후 즉시 실행
  - **월요일 주간 요약**: `monday-briefing-extra.md` 프롬프트 자동 주입 (주간 비용 통계 + 보고서 요약)
- **캘린더 리마인더**: `CalendarPoller` — 직접 Google Calendar REST API HTTP 폴링
  - 전체 캘린더 조회 후 `excludeCalendars`로만 제외 (화이트리스트 없음)
  - 5분 간격 폴링, diff 감지 시에만 AI 판단 (Haiku 모델, 경량 모드 ~$0.003/회)
  - AI 판단 경량 모드: `cwd=tmpdir` + `--system-prompt` + `--tools ""` + `--no-session-persistence`
  - AI 판단 rate limit 시 다음 정시까지 자동 일시 중지 (`aiJudgmentPaused`)
  - 알림 큐 (`.calendar-notifications.json`) + 1분 간격 디스패치
  - 토큰 공유: `~/.config/google-calendar-mcp/tokens.json` (MCP 서버와 동일)
  - 어시스턴트 세션은 `skipMcp: true`로 MCP 서버 연결 건너뜀
  - 알림 뮤트: 🔇 버튼으로 반복 일정 알림 끄기 (`.calendar-muted-events.json`, base eventId로 시리즈 매칭)
  - 인증 연속 3회 실패 시 자동 일시 중지 + Slack 알림
- `-report [type]`/`-rp [type]`: reports/ 하위 디렉토리 재귀 탐색, Slack 파일 업로드 (`filesUploadV2`, `files:write` 스코프 필요), 절대 경로 + 요약 표시, 업로드 실패 시 텍스트 fallback
- `-assistant [subcmd]`/`-as [subcmd]`: 어시스턴트 설정 관리
  - `-as config`: 현재 설정 표시 (config.json 내용)
  - `-as briefing HH:MM`: 브리핑 시간 변경 → fs.watchFile이 감지하여 자동 재스케줄
  - `-as reminder N`: 리마인더 사전 알림 시간(분) 변경
  - 환경변수 미설정 시 graceful 비활성 (`assistantScheduler = null`)
- 비용 제어: `--max-budget-usd` 플래그로 세션별 비용 한도, `.assistant-costs.json`에 비용 기록, 브리핑에 일간/주간/월간 통계 표시
  - `config.json`에서 `briefing.maxBudgetUsd`, `reminders.maxBudgetUsd`, `analysis.budgetUsd` 조정 가능
  - 분석: `analysis.defaults` (sessionBudgetUsd, allowedTools, writablePaths) + `analysis.types` (타입별 override) 구조
  - 분석 세션: 비용 한도 도달 시 `--resume`로 이어서 진행 (총 `budgetUsd` 내에서)
- 새 명령어 추가 시:
  1. `is*Command()` 또는 `parse*Command()` 메서드 작성
  2. `handleMessage()`의 명령어 분기에 추가 (stop은 help보다 먼저 체크)
  3. `messages.ts`의 `getHelpText()`에 도움말 추가
  4. `README.md`에도 반영

### Error Handling
- CLI 프로세스 에러는 `try/catch`로 감싸고, Slack 메시지로 사용자에게 전달
- Rate limit 감지: CLI `rate_limit_event` 이벤트 + `isRateLimitText()` 공유 유틸 (`src/rate-limit-utils.ts`)
  - 사용자 세션: 4단계 UI (계정 전환 → API 키 → 예약 재시도 → 취소)
  - 스케줄 세션: rate limit 감지 시 안내 메시지 전송 (브리핑), 분석 전체 중단
  - 캘린더 판단: rate limit 시 다음 정시까지 AI 판단 일시 중지 (`pauseAiJudgment()`)
- Rate limit 멘션 알림: 재시도/취소 시 자동 취소 (`notifyScheduledId`로 추적)
- API 키 fallback: rate limit 시 등록된 API 키로 전환 → 리셋 시간 후 구독 방식으로 자동 복귀
- 다중 계정 fallback: rate limit 시 `AccountManager.switchToNext()` → account-1 → account-2 → account-3 → API 키 버튼 순으로 전환
- 읽기 전용 도구 (Grep, Read, Glob 등)는 상태 메시지에서만 표시 (`STATUS_ONLY_TOOLS`)
- CLI `is_error` 감지: `cliError` 플래그 추적 → 에러 시 ❌ 리액션 + `status.errorOccurred` 표시
- 완료 시 도구 사용 요약 표시 (`toolUsageCounts` → `✅ Task completed (Grep ×5, Read ×2)`)
- 로깅은 `Logger` 클래스 사용 (`this.logger.info/debug/warn/error`)

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

| File | Role |
|------|------|
| `src/slack-handler.ts` | Slack 이벤트 처리, 명령어 파싱, 메시지 포맷팅 |
| `src/cli-handler.ts` | CLI 프로세스 스폰 (`claude -p`), 세션 관리 |
| `src/working-directory-manager.ts` | 작업 디렉터리 설정/조회/영속화 |
| `src/schedule-manager.ts` | 세션 자동 시작 스케줄 관리 (`.schedule-config.json` 영속화) |
| `src/assistant-scheduler.ts` | 개인비서 스케줄러 — 브리핑/캘린더 리마인더/주간 분석 자동화 |
| `src/calendar-poller.ts` | 캘린더 직접 HTTP 폴링, diff, AI 판단, 알림 디스패치 |
| `src/error-collector.ts` | 봇 전체 에러 수집 싱글턴 — 브리핑에서 일괄 보고 |
| `src/file-handler.ts` | 파일 업로드 다운로드/임베딩 |
| `src/session-scanner.ts` | 전체 프로젝트 세션 스캔/피커 데이터 |
| `src/messages.ts` | i18n 번역 카탈로그 (`t()` 함수, `Locale` 타입) |
| `src/mcp-manager.ts` | MCP 서버 설정 로드/관리 |
| `src/account-manager.ts` | 다중 계정 관리 — OAuth 토큰 저장/갱신, env var 주입 방식 전환 |
| `src/version.ts` | 버전 정보 + 업데이트 체크 (`getVersionInfo()`, `checkForUpdates()`) |
| `src/rate-limit-utils.ts` | 공유 rate limit 감지 유틸 (`isRateLimitText()`, `isRateLimitError()`) |
| `src/config.ts` | 환경변수 로드 |
| `src/types.ts` | TypeScript 타입 정의 |
| `src/logger.ts` | 구조화된 로깅 |

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
