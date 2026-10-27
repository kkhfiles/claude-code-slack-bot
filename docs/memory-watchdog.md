# 시스템 메모리 워치독

**워치독을 고치기 전에 읽는 참고** — `src/process-memory-watchdog.ts` 의 감시 경로와 종료 규칙(2026-10-02 `AGENTS.md` 「Error Handling」에서 옮김).

- **시스템 메모리 워치독**: `ProcessMemoryWatchdog` — Windows 시스템 커밋 메모리 감시 · **목적은 상시 작업(봇과 그 세션 · 예약 파이프라인)이 메모리 고갈로 넘어지지 않게 하는 것 — 감시기가 그 작업을 죽이는 것도 같은 사고**(2026-09-29 개편 · 근거는 소스 머리 주석)
  - 3분 간격 체크 · 두 경로
    - **폭주**: 한 프로세스가 `processThresholdMB`(기본 7GB) 이상 → 상시 작업이어도 종료 대상 · 유예 3분(`MEMORY_WATCHDOG_RUNAWAY_KILL_SEC`)
    - **시스템**: 커밋 `thresholdPct`(기본 90%) 이상 · 폭주 없음 → **상시 작업 계보는 절대 안 죽임** · 한 고점에 한 번만 판정 · 유예 10분
  - 상시 작업 계보는 기계로 가름(`classifyRoles`) — 봇의 조상(pm2 등 · 후보에서도 뺌) · 봇의 자손 · 파이프라인 러너(잠금 파일 PID)와 자손. 프로세스 표를 못 읽으면 시스템 경로는 아무것도 안 죽임
  - 대화형 터미널 계보(WindowsTerminal 또는 WezTerm 과 그 안의 세션, WezTerm 은 2026-10-27 추가)는 폭주여도 **심각할 때만** 끊음 — 기준은 커밋 97% 이상 또는 그 프로세스 16GB 이상, 그때 유예는 1분, 시스템 경로에서는 안 죽임(2026-09-29 사용자 결정, 9/2 터미널 11.2GB와 커밋 95.4% 는 부족 없이 지나감)
  - AI 검토(Opus · medium · 도구 없음 · 2분)가 그 규칙 안에서 대상을 고르거나 「기다림」 — 최종 결정은 `decide()` · AI 실패 시 폭주는 규칙대로 · 시스템은 알림만 · `MEMORY_WATCHDOG_AI_REVIEW=0` 이면 규칙만
  - **기본은 관찰 모드** — AI 판정은 기록 · DM 에만 보이고 실제 결정은 규칙만 내립니다(폭주는 규칙대로 · 시스템 경로는 알림만). 판정 기록의 `aiWould` 로 맞았는지 본 뒤 `MEMORY_WATCHDOG_AI_ACT=1` 로 켭니다(2026-09-29 사용자 「시험하다 사고 나면 안 됨」).
  - 자동 종료 직전 다시 잼 — 압박이 풀렸으면 안 쏨 · 판정 · 취소 · 자동 종료는 `~/.claude/state/memory-watchdog-events.jsonl`
  - Kill/Ignore/Exclude 버튼 · Exclude 는 런타임 예외(디스크 영속화 없음) · 시스템 프로세스 보호 목록 + 자기 자신 제외
  - **분석과 상황별 대안**(2026-10-27, `src/memory-analysis.ts`, `MEMORY_WATCHDOG_ANALYSIS=1` 일 때만)
    - 판정할 때 스냅샷 도구(`MEMORY_SNAPSHOT_TOOL`, 기본 `~/.claude/assets/memory-snapshot.py --json`)로 프로세스 전부와 AI 세션 묶음, 커널 풀을 재고 평소 기준 장(`-baseline`)과 직전 장에 맞댐
    - 같은 AI 검토 호출이 판정과 함께 분석 두세 문장과 대안 1~4개를 내고, 그 대안이 경고와 자동 종료 확인 메시지 아래에 버튼으로 표시됨
    - 시스템 점검의 커밋 압박 알림(`winhealth-commit`)은 정해 둔 버튼 대신 이 대안을 냄
    - 대안은 **눌러야만 실행**
    - 갈래는 하나 종료(kill), 자식까지 종료(kill_tree), 유령 Explorer 정리, 감시 프로세스 정리, 재시작(두 단계), 직접 할 일(버튼 없음)
    - 상시 작업 계보와 시스템 프로세스, 스냅샷에 없는 PID, 자손에 상시 작업이 있는 통째 종료는 `vetOptions` 가 버림
    - 대화형 세션은 대안이 될 수 있음(사람이 누르므로)
    - 끄는 버튼에는 슬랙 확인 창이 뜸
    - 실행 직전에 이름과 생성 시각을 맞대 같은 프로세스일 때만 끄고, 결과와 커밋 전후를 그 대안 줄에 기재
    - 자식까지 끄는 대안은 누르는 그때의 자식을 다시 보고, 상시 작업이 있거나 프로세스 표를 못 읽으면 안 끔(버튼이 이틀 살아 있어서)
    - 자동 종료 확인에 붙은 대안은 Kill, Ignore, 타이머 결과로 메시지를 고쳐도 분석과 남은 버튼이 남음. 「그대로 둠」은 자동 종료가 기다리는 동안 Kill, Ignore, Exclude 를 지우지 않음(Slack 은 글만 주고 블록을 빼면 블록을 지움)
    - 버튼 상태는 `~/.claude/state/memory-watchdog-options.json`(이틀)
    - 커밋 85% 를 처음 넘으면 기록용 스냅샷 한 장(`rise`) — 판정 때 「직전 장」이 되어 그 사이 쉰 세션을 가름
    - 스냅샷 보관은 기준 장을 빼고 14일
  - `ASSISTANT_DM_CHANNEL`로 알림 전송, Windows 전용 (`process.platform === 'win32'`)
  - 환경변수: `MEMORY_WATCHDOG_ENABLED`, `MEMORY_WATCHDOG_THRESHOLD_PCT`, `MEMORY_WATCHDOG_PROCESS_THRESHOLD_MB`, `MEMORY_WATCHDOG_INTERVAL_SEC`, `MEMORY_WATCHDOG_AUTO_KILL_SEC`, `MEMORY_WATCHDOG_RUNAWAY_KILL_SEC`, `MEMORY_WATCHDOG_AI_REVIEW`, `MEMORY_WATCHDOG_AI_ACT`, `MEMORY_WATCHDOG_ANALYSIS`, `MEMORY_SNAPSHOT_TOOL`
  - 검사: `npm run check:watchdog`
