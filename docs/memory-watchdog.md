# 시스템 메모리 워치독

**워치독을 고치기 전에 읽는 참고** — `src/process-memory-watchdog.ts` 의 감시 경로와 종료 규칙(2026-10-02 `AGENTS.md` 「Error Handling」에서 옮김).

- **시스템 메모리 워치독**: `ProcessMemoryWatchdog` — Windows 시스템 커밋 메모리 감시 · **목적은 상시 작업(봇과 그 세션 · 예약 파이프라인)이 메모리 고갈로 넘어지지 않게 하는 것 — 감시기가 그 작업을 죽이는 것도 같은 사고**(2026-09-29 개편 · 근거는 소스 머리 주석)
  - 3분 간격 체크 · 두 경로
    - **폭주**: 한 프로세스가 `processThresholdMB`(기본 7GB) 이상 → 상시 작업이어도 종료 대상 · 유예 3분(`MEMORY_WATCHDOG_RUNAWAY_KILL_SEC`)
    - **시스템**: 커밋 `thresholdPct`(기본 90%) 이상 · 폭주 없음 → **상시 작업 계보는 절대 안 죽임** · 한 고점에 한 번만 판정 · 유예 10분
  - 상시 작업 계보는 기계로 가름(`classifyRoles`) — 봇의 조상(pm2 등 · 후보에서도 뺌) · 봇의 자손 · 파이프라인 러너(잠금 파일 PID)와 자손. 프로세스 표를 못 읽으면 시스템 경로는 아무것도 안 죽임
  - 대화형 터미널 계보(WindowsTerminal 과 그 안의 세션)는 폭주여도 **심각할 때만** 끊음 — 커밋 97% 이상 또는 그 프로세스 16GB 이상 · 그때 유예 1분 · 시스템 경로에서는 안 죽임(2026-09-29 사용자 결정 · 9/2 터미널 11.2GB · 95.4% 는 부족 없이 지나감)
  - AI 검토(Opus · medium · 도구 없음 · 2분)가 그 규칙 안에서 대상을 고르거나 「기다림」 — 최종 결정은 `decide()` · AI 실패 시 폭주는 규칙대로 · 시스템은 알림만 · `MEMORY_WATCHDOG_AI_REVIEW=0` 이면 규칙만
  - **기본은 관찰 모드** — AI 판정은 기록 · DM 에만 보이고 실제 결정은 규칙만 내립니다(폭주는 규칙대로 · 시스템 경로는 알림만). 판정 기록의 `aiWould` 로 맞았는지 본 뒤 `MEMORY_WATCHDOG_AI_ACT=1` 로 켭니다(2026-09-29 사용자 「시험하다 사고 나면 안 됨」).
  - 자동 종료 직전 다시 잼 — 압박이 풀렸으면 안 쏨 · 판정 · 취소 · 자동 종료는 `~/.claude/state/memory-watchdog-events.jsonl`
  - Kill/Ignore/Exclude 버튼 · Exclude 는 런타임 예외(디스크 영속화 없음) · 시스템 프로세스 보호 목록 + 자기 자신 제외
  - `ASSISTANT_DM_CHANNEL`로 알림 전송, Windows 전용 (`process.platform === 'win32'`)
  - 환경변수: `MEMORY_WATCHDOG_ENABLED`, `MEMORY_WATCHDOG_THRESHOLD_PCT`, `MEMORY_WATCHDOG_PROCESS_THRESHOLD_MB`, `MEMORY_WATCHDOG_INTERVAL_SEC`, `MEMORY_WATCHDOG_AUTO_KILL_SEC`, `MEMORY_WATCHDOG_RUNAWAY_KILL_SEC`, `MEMORY_WATCHDOG_AI_REVIEW`, `MEMORY_WATCHDOG_AI_ACT`
  - 검사: `npm run check:watchdog`
