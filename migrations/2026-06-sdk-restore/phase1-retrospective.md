# Phase 1 POC 회고 — 2026-05-18

`feature/sdk-migration` 브랜치 / 6/15 정책 대응 트랙.

## 한 줄 요약
**SDK 경로 실 분석에서 CLI 대비 -37~-59% cost 절감 확인. 산출물 동등성·운영 안정성·도구 호출 경로 모두 통과. analysis 카테고리 전면 토글 + 토요일 자동 fire 진행 가능.**

## 검증 지표

### kg-skill-update (Bash 도구 호출 없음 — 가벼운 경로)
| 항목 | CLI 평균 (3회) | SDK 1차 | SDK 2차 | Δ |
|---|---|---|---|---|
| cost USD | 0.606 | 0.324 | 0.441 | -47% / -27% |
| output tokens | — | 9,637 | 9,610 | ≈ |
| cacheCreate | — | 39,510 | 41,212 | ≈ |
| cacheRead | — | 100,108 | 469,864 | +4.7× |
| 소요 (벽시계) | — | 2분 25초 | ~3분 | ≈ |
| 산출물 동등성 | baseline 변경 보고서 생성 | "변경 없음" 판단 | 동일 | ✅ KG state 직접 검증으로 판단 정확 확인 |

### cli-usage (Bash + Read + Write — 도구 호출 무거운 경로)
| 항목 | CLI 평균 (3회) | SDK | Δ |
|---|---|---|---|
| cost USD | 1.93 | 0.797 | **-59%** |
| output tokens | — | 13,067 | — |
| 보고서 생성 | OK | `reports/cli-usage/2026-05-18.md` ✅ | 동등 |

### kg-health (mycelium 가드 영향)
SDK 호출 정상, 분석 prompt가 audit.py 호출 시도 → mycelium acquire_job 가드(B7 배치 실행 중)가 거부 → 분석이 그 정보를 받아 사용자에게 안내 ("~2.3h 후 가능, kill 옵션") — SDK 자체 동작 정상.

## 도중 발견한 SDK ↔ CLI 동작 불일치 3종 (모두 fix)

단일 type POC(kg-skill-update)에서는 안 노출 — kg-skill-update는 Bash 도구 호출이 없는 경량 분석이라 SDK API mismatch가 안 드러났다. `SLACKBOT_SDK_ENABLED=analysis` 확장 후 kg-health(audit.py 실행 필요)에서 일제히 노출.

| 불일치 | SDK 거동 | CLI 거동 | Fix |
|---|---|---|---|
| 설정 소스 | `settingSources` 명시한 것만 | user/project/local 자동 합침 | `7945dda` 3개 모두 명시 |
| `allowedTools` 명세 | bare tool name (`'Bash'`) 만 | permission 패턴 (`'Bash(python:*)'`) 자동 분해 | `5938879` base name 추출 |
| 권한 모드 | `'default'`는 사용자 prompt 요구 (background 불가 → 거부) | `--print` 모드는 settings의 allow 패턴 자동 적용 | `5ecfeec` `'default'` → `'dontAsk'` 매핑 |

**모두 SDK API mismatch 자체** — 분석 prompts·config 변경 없이 sdk-handler.ts에서 해소.

## 코드 변경 (오늘 5/18 누적 commit)

| commit | 변경 |
|---|---|
| `046005f` | SdkHandler 215줄 + feature flag `shouldUseSdk` + cost entry 확장 (`via`, `cacheRead/Create/in/out`) |
| `c758450` | phase1-notes 누적 |
| `8e529d6` | mock event-translation 16/16 pass + briefing/calendar 분기 + recordSessionCost refactor |
| `5102bb4` | ReportServer `/trigger` endpoint (loopback 127.0.0.1 binding이 access 경계) |
| `1296612` | phase1-notes §1.7 컴팩트 복귀 절차 |
| `857cc88` | §1.7 자동 실행 성공 기록 |
| `b9da2d4` | §1.8 산출물 동등성 + 1H 캐시 검증 |
| `12b3161` | analysis model pin (`claude-sonnet-4-6`, env/config override) |
| `7945dda` | sdk-handler: `settingSources ['user','project','local']` |
| `5938879` | sdk-handler: `allowedTools`에서 permission 패턴 분리 |
| `5ecfeec` | sdk-handler: `'default'` → `'dontAsk'` 권한 모드 매핑 |
| `2df2350` | assistant-scheduler: `textPreview` 600자 로깅 (디버그/운영 모니터링) |
| `b189ae8` | phase1-notes: SDK regression fix 3종 + cli-usage 검증 |

## 신규 도입

| 도입 | 위치 | 효과 |
|---|---|---|
| feature flag (`SLACKBOT_SDK_ENABLED`) | `sdk-handler.ts` `shouldUseSdk()` | scope/category prefix 매칭으로 점진 토글 |
| kill switch (`SLACKBOT_FORCE_CLI`) | 동상 | 긴급 롤백 1줄 |
| 자동 트리거 endpoint | `ReportServer.POST /trigger?type=` | Slack DM 우회, 어시스턴트가 직접 trigger 가능 |
| SessionUsage 측정 | `assistant-scheduler.ts:SessionUsage` | cacheRead/Create 측정으로 캐시 효과 가시화 |
| `via` 태그 | `CostEntry.via:'cli'\|'sdk'` | 호출별 경로 식별 |
| 분석 model pin | `runSingleAnalysis` | SDK default 변경시 Opus fall-through 방지 (Sonnet 4.6 기본, env/config override) |
| `textPreview` 로깅 | `runSingleAnalysis` | 분석 응답 600자 pm2 log only — Slack/외부 surface로는 가지 않음 |

## 위험 / 잔존 이슈

- **호출간 비용 변동성**: 1H cacheCreate가 매 호출 재발생, cacheRead 적중량 변동. kg-skill-update -47%/-27%, cli-usage -59%. 1주 자동 fire 데이터로 평균 안정성 확인 필요.
- **1H 캐시 TTL 비공식적**: 2h 47m 후에도 cacheRead 적중 — Anthropic API의 캐시 reuse 로직이 문서보다 관대. 비용 모델 안정성 측정 항목.
- **mycelium 가드 충돌 → success로 분류**: kg-health/kg-regression이 audit 차단 응답을 받으면 `subtype: 'success'`로 처리됨 → retry 안 됨, Slack은 "📊 완료"로 보고. 운영자가 보고서 누락을 직접 확인해야 알아챔. 토요일 fire 시점에 B7 같은 mycelium write 진행 중일 확률 낮으므로 자연 복원 가능. 이슈 발생 시점에 retry 메커니즘 추가 (지금 X).
- **로깅 간략**: runAssistantSession 자체가 CLI/SDK 공통으로 assistant text / tool call을 INFO 로깅 안 함. `textPreview`로 분석 응답 본문 600자는 보이게 됐지만, 중간 tool_use는 안 보임. 디버깅 어려움 시 SdkProcess에서 user/assistant event verbose logging 추가 가능.

## Go 결정 (5/18 최종)

- ✅ **카테고리 확장 적용** — `SLACKBOT_SDK_ENABLED=analysis` (사용자 .env)
- ✅ **모델 명시화 안전망** — Sonnet 4.6 pin (`ANALYSIS_MODEL` env / `config.types[t].model` override)
- ✅ **SDK regression fix 3종** — settingSources / allowedTools / permissionMode
- ⏳ **5/22 토요일 자동 fire 관찰** — weekly 6종 (ai-practice / kg-health / kg-skill-update / cli-usage / kg-regression / dawoo-orgchart). 모두 SDK 경로. mycelium 가드 충돌 시 보고서 누락 가능 (운영자 확인 필요).
- ⏳ **1주 관찰 후 briefing/calendar 토글** — daily fire (06:00 KST briefing) 추가
- ⏳ **D-day 6/14**: data-sync 이관 검토 (별도 트랙, 가장 비싼 작업)

## 핵심 교훈

POC는 가능한 가장 무거운 경로(도구 호출 많은 분석)로 검증해야 한다. kg-skill-update만 봤다면 5/22 자동 fire에서 weekly 6종 중 4종(audit.py / Python 스크립트 호출)이 모두 조용한 실패로 끝났을 것. 확장 토글 시 사전 trigger로 다른 무거운 경로를 1종이라도 검증하는 안전망이 결정적이었다.
