# 파일별 역할

**어느 파일이 무엇을 하는지** — 데이터 파일과 비밀 포함 여부는 `AGENTS.md` 「Data Files」(2026-10-02 `AGENTS.md` 「File Overview」에서 옮김).

| File | Role |
|------|------|
| `src/slack-handler.ts` | Slack 이벤트 처리, 명령어 파싱, 메시지 포맷팅 |
| `src/cli-handler.ts` | CLI 프로세스 스폰 (`claude -p`), 세션 관리 |
| `src/sdk-handler.ts` | Agent SDK in-process 호출 (`@anthropic-ai/claude-agent-sdk`), `shouldUseSdk(scope)` 게이트 |
| `src/working-directory-manager.ts` | 작업 디렉터리 설정/조회/영속화 |
| `src/schedule-manager.ts` | 세션 자동 시작 스케줄 관리 (`.schedule-config.json` 영속화) |
| `src/assistant-scheduler.ts` | 개인비서 스케줄러 — 브리핑/캘린더 리마인더/주간 분석 자동화 |
| `src/calendar-poller.ts` | 캘린더 직접 HTTP 폴링, diff, AI 판단, 알림 발송 |
| `src/error-collector.ts` | 봇 전체 에러 수집 싱글턴 — 브리핑에서 일괄 보고 |
| `src/file-handler.ts` | 파일 업로드 다운로드/임베딩 |
| `src/session-scanner.ts` | 전체 프로젝트 세션 스캔/피커 데이터 |
| `src/messages.ts` | i18n 번역 카탈로그 (`t()` 함수, `Locale` 타입) |
| `src/mcp-manager.ts` | MCP 서버 설정 로드/관리 |
| `src/account-manager.ts` | 다중 계정 관리 — OAuth 토큰 저장/갱신, env var 주입 방식 전환 |
| `src/version.ts` | 버전 정보 + 업데이트 체크 (`getVersionInfo()`, `checkForUpdates()`) |
| `src/rate-limit-utils.ts` | 공유 rate limit 감지 유틸 (`isRateLimitText()`, `isRateLimitError()`) |
| `src/process-memory-watchdog.ts` | 시스템 메모리 워치독 — 커밋 메모리 감시, 프로세스 kill, Slack 확인 UI |
| `src/report-server.ts` | 로컬 HTTP 서버 — 업무 칸반 · 수동 분석 실행, 127.0.0.1, 토큰 인증 |
| `src/config.ts` | 환경변수 로드 |
| `src/types.ts` | TypeScript 타입 정의 |
| `src/logger.ts` | 구조화된 로깅 |
