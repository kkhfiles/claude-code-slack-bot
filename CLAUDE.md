# Claude Code Slack Bot - Project Conventions

## Overview
- Fork of [mpociot/claude-code-slack-bot](https://github.com/mpociot/claude-code-slack-bot)
- Cross-platform (Windows/macOS/Linux), CLI (`claude -p`) 기반 프로세스 스폰
- Slack Socket Mode (공개 URL 불필요)
- `cli-migration` 브랜치에서 작업, `main`은 upstream 동기화용

## Build & Run

```bash
npm install                    # macOS / Linux
npm install --ignore-scripts   # Windows (플랫폼 체크 우회)
npm run build                  # TypeScript → dist/

# macOS / Linux
npm run build && pm2 start ecosystem.config.js

# Windows
start.bat                     # pm2로 빌드+실행 (권장)
stop.bat                      # pm2 중지
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
- `-apikey`: API 키 등록/수정 모달 (rate limit 시 자동 전환용, `.api-keys.json` 영속화)
- 새 명령어 추가 시:
  1. `is*Command()` 또는 `parse*Command()` 메서드 작성
  2. `handleMessage()`의 명령어 분기에 추가 (stop은 help보다 먼저 체크)
  3. `messages.ts`의 `getHelpText()`에 도움말 추가
  4. `README.md`에도 반영

### Error Handling
- CLI 프로세스 에러는 `try/catch`로 감싸고, Slack 메시지로 사용자에게 전달
- Rate limit 감지: CLI `rate_limit_event` 이벤트 + `isRateLimitError()` 텍스트 패턴 매칭
- Rate limit 멘션 알림: 재시도/취소 시 자동 취소 (`notifyScheduledId`로 추적)
- API 키 fallback: rate limit 시 등록된 API 키로 전환 → 리셋 시간 후 구독 방식으로 자동 복귀
- 읽기 전용 도구 (Grep, Read, Glob 등)는 상태 메시지에서만 표시 (`STATUS_ONLY_TOOLS`)
- 완료 시 도구 사용 요약 표시 (`toolUsageCounts` → `✅ Task completed (Grep ×5, Read ×2)`)
- 로깅은 `Logger` 클래스 사용 (`this.logger.info/debug/warn/error`)

### CLI Integration
- `child_process.spawn('claude', ['-p', '--output-format', 'stream-json', ...])` 방식
- `CliProcess` 클래스: AsyncIterable<CliEvent> 패턴으로 stdout 스트리밍
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

### Working Directory
- 디스크 영속화: `.working-dirs.json`
- 우선순위: Thread > Channel/DM
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
git checkout cli-migration && git merge main

# 작업은 cli-migration 브랜치에서
git checkout cli-migration
```

## File Overview

| File | Role |
|------|------|
| `src/slack-handler.ts` | Slack 이벤트 처리, 명령어 파싱, 메시지 포맷팅 |
| `src/cli-handler.ts` | CLI 프로세스 스폰 (`claude -p`), 세션 관리 |
| `src/working-directory-manager.ts` | 작업 디렉터리 설정/조회/영속화 |
| `src/file-handler.ts` | 파일 업로드 다운로드/임베딩 |
| `src/session-scanner.ts` | 전체 프로젝트 세션 스캔/피커 데이터 |
| `src/messages.ts` | i18n 번역 카탈로그 (`t()` 함수, `Locale` 타입) |
| `src/mcp-manager.ts` | MCP 서버 설정 로드/관리 |
| `src/config.ts` | 환경변수 로드 |
| `src/types.ts` | TypeScript 타입 정의 |
| `src/logger.ts` | 구조화된 로깅 |
