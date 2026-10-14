# 파일별 역할

**어느 파일이 무엇을 하는지** — 데이터 파일과 비밀 포함 여부는 `AGENTS.md` 「Data Files」(2026-10-02 `AGENTS.md` 「File Overview」에서 옮김).

| File | Role |
|------|------|
| `src/slack-handler.ts` | Slack 이벤트 처리, 명령어 파싱, 메시지 포맷팅 |
| `src/cli-handler.ts` | CLI 프로세스 스폰 (`claude -p`), 세션 관리 |
| `src/sdk-handler.ts` | Agent SDK in-process 호출 (`@anthropic-ai/claude-agent-sdk`), `shouldUseSdk(scope)` 게이트 |
| `src/working-directory-manager.ts` | 작업 디렉터리 설정/조회/영속화 |
| `src/assistant-scheduler.ts` | 개인비서 스케줄러 — 브리핑/캘린더 리마인더/주간 분석 자동화 |
| `src/calendar-poller.ts` | 캘린더 직접 HTTP 폴링, diff, AI 판단, 알림 발송 |
| `src/error-collector.ts` | 봇 전체 에러 수집 싱글턴 — 브리핑에서 일괄 보고 |
| `src/file-handler.ts` | 파일 업로드 다운로드/임베딩 |
| `src/session-scanner.ts` | 전체 프로젝트 세션 스캔/피커 데이터 |
| `src/messages.ts` | i18n 번역 카탈로그 (`t()` 함수, `Locale` 타입) |
| `src/mcp-manager.ts` | MCP 서버 설정 로드/관리 |
| `src/account-manager.ts` | OAuth 토큰 하나의 저장, 갱신, 터미널(`.credentials.json`)과의 양방향 동기화 |
| `src/child-env.ts` | 봇이 띄우는 세션의 환경 변수에서 API 키를 뺌 (`withoutApiKey()`, SDK와 CLI 두 길 공통) |
| `src/version.ts` | 버전 정보 + 업데이트 체크 (`getVersionInfo()`, `checkForUpdates()`) |
| `src/rate-limit-utils.ts` | 공유 rate limit 감지 유틸 (`isRateLimitText()`, `isRateLimitError()`), 엔진 상태에 적을 막힘 판정 (`classifyClaudeEvent()`, `classifyClaudeErrorText()`, codex 쪽 `classifyCodexErrorText()`) |
| `src/engine-state.ts` | 엔진 상태의 정본: 엔진별 막힘, 회복 시각, 사용률, 안내 키 (`.engine-state.json`) |
| `src/engine-tap.ts` | 전송 탭: SDK와 CLI 이벤트에서 엔진 상태를 기록하는 단일 지점 (`ClaudeTap`) |
| `src/engine-recovery.ts` | 회복 타이머: 가장 이른 회복 시각 1분 뒤에 드레인, 기동 시 파일에서 다시 설정 |
| `src/codex-quota.ts` | codex 한도 조회(5분 캐시): 사용률과 소진을 엔진 상태에 기록, 못 읽으면 모름 |
| `src/engine-notice.ts` | DM 담당 엔진이 바뀔 때 보내는 한 줄 안내 (기본 꺼짐, `ENGINE_NOTICE=on`일 때만 전송) |
| `src/rate-limit-until.ts` | 옛 함수 이름을 유지하는 호환 계층 (엔진 상태의 Claude 항목을 읽고 씀) |
| `src/process-memory-watchdog.ts` | 시스템 메모리 워치독 — 커밋 메모리 감시, 프로세스 kill, Slack 확인 UI |
| `src/report-server.ts` | 로컬 HTTP 서버 — 업무 칸반 · 수동 분석 실행, 127.0.0.1, 토큰 인증 |
| `src/config.ts` | 환경변수 로드 |
| `src/types.ts` | TypeScript 타입 정의 |
| `src/logger.ts` | 구조화된 로깅 |
