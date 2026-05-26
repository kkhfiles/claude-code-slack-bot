# Phase 2 회고 — 2026-05-26

`feature/sdk-migration` 브랜치 / 4종 SDK 핸들러 정합화 + 전 scope 토글.

## 한 줄 요약
**SDK 핸들러 버그 4종 fix + interactive scope 신설 + `SLACKBOT_SDK_ENABLED=all` 토글. analysis(실 fire) / briefing(4일 운영) / calendar(슬랙 알림 확인) 3 경로 자연 검증 통과. 메인 채팅 경로는 토글 후 사용자 직접 채팅 시 검증 예정.**

## Phase 1 → Phase 2 갭

Phase 1은 analysis scope만 토글 후 5/22 weekly 자동 fire 관찰까지가 범위였다. 그 결과는 양호했지만(주요 지표는 [phase1-retrospective.md](phase1-retrospective.md) §검증 지표), 다음 검토에서 **현재 운영 analysis 경로에도 영향이 있는 SDK 핸들러 버그 4종**이 드러났다.

| # | 버그 | 발견 경로 | Phase 1 영향 |
|---|---|---|---|
| A1 | `opts.env`가 `process.env`를 치환 (SDK는 `env: H = {...process.env}` 디폴트라 옵션 전달 시 표준 env 통째로 손실) | sdk.mjs grep으로 `env:H={...process.env}` 디스트럭처 확인 | analysis subprocess가 표준 env 없이 "동작은 했지만" PATH·HOME·TZ 손실 상태로 돔 |
| A2 | `appendSystemPrompt`가 public Options 키가 아닌데 top-level에 할당 → silently dropped | sdk.d.ts에 public 키 없음 + sdk.mjs에서 `X.type==="preset" → B=X.append`로 변환만 확인 | analysis "CRITICAL: writablePaths 디렉토리에만" 모델 nudge 미적용 |
| A3 | `opts.tools`가 `sdkOptions.allowedTools`로 매핑 (도구 제한 vs auto-approve 두 개념 혼동) | SDK Options 타입 분리 명시 | calendar 판단(`tools: []`)이 dontAsk silent deny에 의해 우연히 작동 |
| A4 | `persistSession: false` 하드코딩 (인터페이스의 `noSessionPersistence` 무시) | sdk-handler.ts:191 + 옵션 인터페이스 비교 | analysis JSONL 미생성 (CLI 경로는 만들고 SDK 경로만 누락) |

A1·A2는 운영 영향, A3는 의도와 결과만 우연히 일치, A4는 동등성 측면 누락. 모두 `sdk-handler.ts` 내부 수정으로 해소 가능 — 호출자(assistant-scheduler·calendar-poller·slack-handler) 변경 불요.

## 코드 변경 (5/26 누적 commit)

| commit | 변경 | 설명 |
|---|---|---|
| `0ec30d0` | sdk-handler: env 머지, appendSystemPrompt → preset.append | A1 + A2 fix |
| `7f7b848` | sdk-handler: tools/allowedTools 분리, noSessionPersistence honor | A3 + A4 fix |
| `247608b` | sdk-handler: stream_event 활성화·번역 (`includePartialMessages: true` + `interpretSdkMessage`에 case 추가) | 메인 채팅 SDK 경로의 실시간 tool status UX 보존 |
| `137f853` | slack-handler: 메인 채팅 `shouldUseSdk('interactive')` 게이트 추가 | 라우팅 + `activeProcesses: Map<string, CliProcess \| SdkProcess>` 타입 확장 |

`.env` 토글 (commit 외): `SLACKBOT_SDK_ENABLED=analysis` → `analysis,briefing,calendar`(중간 단계) → `all`.

## 실 동작 검증

### Step 3 게이트 (5/22~5/25 cost 검토)
- 5/22 weekly 7종 모두 via=sdk 정상 (cost $0.49~$2.10, output 3K~28K, cacheRead 정상, 에러 없음)
- 5/25 data-sync $3.86 (D-day 6/14 예정작) 정상 완료
- 5/24, 5/25 briefing 2건이 의외로 via=sdk (사용자 토글 흔적 추정) — **결과 정상, 사실상 briefing scope 4일 운영 검증**

### Step 7 토글 직후 실 fire (kg-skill-update)
| 항목 | 5/22 fire (SDK, fix 전) | 5/26 fire (SDK, fix 후) |
|---|---|---|
| cost USD | 0.488 | 0.643 |
| output tokens | 11,722 | 16,690 |
| cacheCreate | 65,949 | 78,586 |
| cacheRead | 212,278 | 322,426 |
| subtype | success | success |
| JSONL 생성 | ❌ (persistSession 하드코딩 false) | ✅ `4944d9c7-...jsonl` 175KB (A4 fix 효력) |

cost 증가는 4일치 KG 변경 누적 + cacheRead 1.5× 증가가 주 원인 추정. 회기 시그널 없음 (Monitor 10분 ERROR/Failed/TypeError 0건, JSONL 정상 생성, 보고서 미생성도 "변경 없음" 정상 결과와 일치).

### 자연 발생 검증
- **calendar**: 사용자가 캘린더 변경 후 슬랙 알림 정상 수신 확인 (calendar judgment SDK 경로 동작) → A3 fix의 `tools: []` 실제 비활성 시나리오 첫 검증
- **briefing**: 5/24, 5/25 + 토글 후 자연 fire 정상 (오늘 아침 정상 수신)

## SDK 핸들러 fix별 검증 매트릭스

| Fix | 직접 검증 | 간접 검증 |
|---|---|---|
| A1 env 머지 | — | subprocess 정상 startup·완료 (env 손실 시 fail) |
| A2 preset.append | — | 회기 시그널 없음. 보고서 생성 분석(5/29 토 weekly)에서 직접 효과 검증 예정 |
| A3 tools 분리 | calendar 알림 정상 | — |
| A4 persistSession | JSONL 정상 생성 (175KB) | — |

A2는 "변경 없음" 판정 경로에서는 효과 비가시. 5/29(토) weekly 12종 fire에서 reports/ 디렉토리에 파일 생성하는 분석들이 의도된 경로에만 쓰는지 확인.

## 신규 도입

| 도입 | 위치 | 효과 |
|---|---|---|
| `interactive` scope | `sdk-handler.shouldUseSdk` 매칭 + slack-handler:685 게이트 | 메인 사용자 채팅도 SDK 라우팅. 이전엔 `cliHandler.runQuery`로 하드와이어 |
| `stream_event` 번역 | `interpretSdkMessage` case 추가 + `includePartialMessages: true` | 인터랙티브 채팅의 실시간 `🔍 Using <tool>` 상태 표시 유지 (SDKPartialAssistantMessage가 CliStreamEvent와 shape 호환) |
| `activeProcesses` 타입 확장 | `Map<string, CliProcess \| SdkProcess>` | SDK in-process 호출 추적. SdkProcess.pid=undefined라 외부 memory watchdog PID 매칭은 자연 skip (SDK 호출은 외부 프로세스 없음) |

## 위험 / 잔존 이슈

- **메인 채팅 interactive 경로 실 검증 미완**: 사용자 직접 채팅 시 첫 SDK 호출 발생. CLI ↔ SDK 세션 호환(`--resume` 시 JSONL 포맷 동등성)이 phase1에서 검증 안 된 새 영역.
- **stream_event UX 회기 가능성**: `BetaRawMessageStreamEvent`가 CliStreamEvent와 shape 호환임은 타입 수준에서 확인했지만, 실제 `content_block_start` 이벤트 발생 빈도·타이밍이 미세 다를 수 있음. 사용자 첫 채팅에서 status 메시지 누락·중복 관찰.
- **PM2 metadata env 불일치**: `pm2 restart --update-env` 후에도 PM2 jlist에는 `SLACKBOT_SDK_ENABLED: (unset)` — `ecosystem.config.js`에 정의 안 했기 때문. 봇 내부 `process.env`는 dotenv가 set하므로 동작은 정상이나, `pm2 describe` 등으로 진단 시 혼동 가능. ecosystem에 명시할지 결정 보류.
- **A2 직접 검증 5/29 대기**: 보고서 생성 분석(skill-review·session-efficiency 등)에서 writablePaths 외 경로 쓰기 시도 없는지 5/29 weekly fire 후 확인.
- **5/25(공휴일) briefing 비업무일 스킵 누락**: 별개 이슈. `holidays.isHoliday()`가 부처님오신날(음력)을 못 잡은 건지 또는 catch-up 로직이 비업무일 체크 안 한 건지 추적 필요.

## Go 결정 (5/26 최종)

- ✅ **전 scope SDK 토글 적용** — `.env`: `SLACKBOT_SDK_ENABLED=all`
- ✅ **4종 fix 모두 main 머지 가능** — sdk-handler.ts 단일 파일, 호출자 영향 없음
- ⏳ **메인 채팅 첫 사용자 채팅** — 사용자 자연 사용 시 자동 검증
- ⏳ **5/29(토) weekly 12종 fire** — A2 fix 직접 효과 검증 + 회기 관측 마지막 게이트
- ⏳ **5/25 휴일 스킵 누락** — 별 트랙 이슈 등록 (이 회고 범위 밖)
- 🔧 **롤백 안전망**: `.env`에 `SLACKBOT_FORCE_CLI=1` 한 줄 + `pm2 restart claude-slack-bot --update-env` → 모든 SDK 경로 즉시 비활성

## 핵심 교훈

**SDK Options 타입 정의(public)와 runtime이 다를 수 있다.** A2의 `appendSystemPrompt`처럼 top-level에 잘못 둬도 컴파일·런타임 모두 에러 없이 silently dropped. 이번엔 sdk.mjs grep으로 실 동작을 확인했지만, 호출자 코드를 늘리기 전에 SDK 핸들러의 모든 옵션이 실제로 적용되는지 미세 검증이 필요했다. Phase 1처럼 무거운 경로 trigger로 끝까지 가 보는 검증과는 별개로, SDK API 표면을 한 번씩 직접 시험하는 단위 점검 트랙도 효율적이다.

**버그가 "동작하지 않음"이 아니라 "의도와 다른 메커니즘으로 우연히 같은 결과"일 수 있다.** A3의 `tools: []`가 dontAsk + allowedTools=[] silent deny로 우연히 의도된 결과(도구 호출 없음)를 달성한 케이스. 결과만 보면 회기가 없어 보이지만, 다른 조건(예: 모드 변경, 옵션 조합 변경)에서 곧바로 잠재된 결함이 드러난다. SDK API 의미와 호출자의 의도가 직접 일치하는지 정렬이 필요하다.
