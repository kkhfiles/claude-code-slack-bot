# Phase 0 — 사전 준비 진척 노트

상세 계획서: `P:/github/claude-workflow/reports/action-plans/2026-05-15-slackbot-sdk-migration-detailed.md` §6 Phase 0.

시작: 2026-05-18

---

## 0.1 — `feature/sdk-migration` 브랜치 생성 ✅

```
git checkout -b feature/sdk-migration
git push -u origin feature/sdk-migration
```

base: `main` (commit 시점 main HEAD). 미커밋 변경(메모리 watchdog 확장)은 main에 stash로 격리 — SDK 마이그와 무관한 별도 트랙.

stash 메시지: `WIP: memory watchdog per-process threshold (pre-SDK-migration)`. 회수: `git stash list` → `git stash pop`.

---

## 0.2 — 옛 SDK 코드 풀 추출 ✅

`migrations/2026-06-sdk-restore/` 디렉토리에 보존:

| 파일 | 출처 commit | 줄수 |
|---|---|---|
| `claude-handler.ts` | `ad06380^` (SDK 시대 마지막) | 247 |
| `mcp-manager.ts` | `ad06380^` | 159 |
| `slack-handler.ts` | `ad06380^` | 1965 |
| `permission-mcp-server.ts` | `998f8b8` (initial — ad06380^에는 없음) | 268 |

총 2,639줄. ad06380 = "feat: migrate from Agent SDK to CLI-based process spawning" (SDK→CLI 후퇴 commit). permission-mcp-server.ts는 그보다 일찍(d8b6f4f "docs sync + dead code drop") 삭제됐기 때문에 initial commit에서 추출.

---

## 0.3 — 운영 상태 백업 ✅

```
.assistant-costs.json → .assistant-costs.pre-sdk.json (18,497 bytes)
.session-state.json   → .session-state.pre-sdk.json   (220 bytes)
```

위치: `P:/github/claude-code-slack-bot/`. 슬랙봇이 실서비스 중 갱신하므로 시점 보존 = 회귀 비교 기준.

---

## 0.4 — 최근 분석 보고서 baseline 백업 ✅

`P:/github/claude-workflow/reports/pre-sdk-baseline/` 에 35 파일 복사. 각 분석 타입별 archived/ 디렉토리에서 2026-05-10 이후 .md 전체.

타입별 내역:
- ai-practice: 1 (2026-05-16)
- cli-usage: 1 (2026-05-16)
- competitors: 1 (summary.md)
- mycelium: 27 (05-11 ~ 05-18)
- presentations-2026h1: 1
- project-summary: 1
- skill-update: 1 (2026-05-16) — mycelium 디렉토리 안

회귀 비교 §8.2의 baseline.

---

## 0.5 — SDK 최신 stable 버전 핀닝 ✅

- 결정: **`@anthropic-ai/claude-agent-sdk@0.3.143`** (2026-05-15 modified)
- 핀닝 정책: `~0.3.143` (patch only). minor 변동은 수동 검증 후 갱신
- 옛 SDK: `^0.2.39` (2026-02-20 ad06380 commit 직전까지 사용)
- 차이: minor 1단계 (0.2.x → 0.3.x). 타입/시그니처 변경 가능성 — 0.10에서 delta 정리

---

## 0.7 — 호출자 매핑 검수 ✅

상세 계획서 §2.1 4종 호출 site 코드 grep 재확인:

| Site | 파일:라인 | 호출 흐름 |
|---|---|---|
| 사용자 응답 | `slack-handler.ts:1842` (`runAssistantSession`) | callback `slack-handler.ts:138` → cli-handler |
| 브리핑 | `assistant-scheduler.ts:533` (`executeBriefing`) | 180/443/509 호출 → cli-handler |
| 분석 12종 | `assistant-scheduler.ts:860` (`runSingleAnalysis`) | 203/762/839 호출 → cli-handler |
| 캘린더 판단 | `calendar-poller.ts:546` (`getAIJudgment`) | 942 호출 → cli-handler |

최종 spawn 지점: `cli-handler.ts:417` 단일. 모든 흐름이 여기로 귀결. orphan CLI 호출 없음.

---

## 0.9 — `schedule-manager.ts` 호출 경로 확인 ✅

`grep spawn|child_process|claude-handler|sdk-handler|runAssistantSession` on `src/schedule-manager.ts` → **매칭 없음**.

`schedule-manager.ts`는 callback 기반 reminder 관리만 함. 호출자(slack-handler / assistant-scheduler)가 SDK로 이관되면 자동 따라옴.

§2.1 매핑에 추가할 orphan 호출 없음. Phase 2.12에서 "확인 only"로 통과.

---

## 0.8 — 환경변수 정의 ✅

| 변수 | 기본 | 값 형식 | 용도 |
|---|---|---|---|
| `SLACKBOT_SDK_ENABLED` | `''` (off) | `''` / `analysis` / `analysis+briefing` / `analysis+briefing+calendar` / `all` | feature flag — 어느 흐름이 SDK 경로를 사용할지 |
| `SLACKBOT_FORCE_CLI` | `''` (off) | `''` / `1` | 긴급 롤백 — 이 값이 `1`이면 SLACKBOT_SDK_ENABLED 무시하고 CLI 강제 |

진입 우선순위: `SLACKBOT_FORCE_CLI=1` → CLI. 그 외 `SLACKBOT_SDK_ENABLED` 토큰 매칭으로 분기.

토큰 매칭 함수 위치: `sdk-handler.ts` 또는 `src/utils/flags.ts` 신규 (Phase 1.2). 매칭은 `,`/`+` 둘 다 허용 (오탈자 방지).

`.env.example`에 두 변수 주석 추가는 Phase 1.1에서.

---

## 0.12 — 6/15 정책 contingency 매트릭스 ✅

본 문서 §10.5에 5개 시나리오 작성됨 (요약):

| 시나리오 | 트리거 | 대응 |
|---|---|---|
| A. 정책 지연 | 6/15 이후에도 크레딧 시스템 활성 안 됨 | CLI 사용량을 구독 한도 안에서 그대로. SDK 마이그는 진행했으니 캐싱 효과로 더 효율 |
| B. 정책 변경 (단가 인상) | 크레딧 빠르게 소진 | A~D 절감 트랙 즉시 발동 (data-sync Python, 분석 Gemini Flash) |
| C. 정책 변경 (SDK 사용 제한) | Agent SDK도 종량 청구 또는 차단 | API key 직접 결제 모드 검토 |
| D. 정책 취소 | 6/15 정책 자체가 철회 | 변경 사항 없이 CLI 그대로 유지 |
| E. 토큰 인증 깨짐 | OAuth 토큰 갱신 흐름 변경 | Phase 1.10 다중 계정 시뮬레이션 결과로 1차 대응. 안 되면 API key fallback |

본 문서 §10.5 원본 참조.

---

## 0.10 — SDK 패키지 설치 + tsc 빌드 + 타입 delta ✅

`npm install --save @anthropic-ai/claude-agent-sdk@0.3.143`:
- 9 packages 추가 (lock 188개)
- 10 vulnerabilities (3 moderate, 7 high) — 별도 트랙 (이번 마이그 범위 외)

`npx tsc --noEmit` → exit 0. 새 패키지가 import되지 않은 상태(0.2.x 옛 코드는 `migrations/`에만 존재)에서도 기존 컴파일 깨짐 없음.

### 옛(0.2.39) ↔ 새(0.3.143) 타입 delta

**전 옵션 호환 유지** (옛 `claude-handler.ts:buildQuery` 옵션은 그대로 사용 가능):

| 옵션 | 옛 사용 | 0.3.143 위치 (sdk.d.ts) | 비고 |
|---|---|---|---|
| `permissionMode` | ✅ | 다중 line | 값 추가: `'dontAsk'`, `'auto'` (옛엔 없음) |
| `includePartialMessages` | ✅ | 1421 | 동일 |
| `systemPrompt` (preset) | ✅ | 1802 | `string | string[] | { type: 'preset', preset }` |
| `allowDangerouslySkipPermissions` | ✅ | 1541 | 동일 |
| `model` | ✅ | 1503 | 동일 |
| `maxBudgetUsd` | ✅ | 1473 | 동일 |
| `cwd` | ✅ | 1225 | 동일 |
| `canUseTool` | ✅ | 1216 | Issue #27203 버그 — Phase 1.13에서 mock 흐름으로 검증 |
| `abortController` | ✅ | 1163 | 동일 |
| `env` | ✅ | 1280 | 동일 |
| `mcpServers` | ✅ | 1498 | `Record<string, McpServerConfig>` 동일 |
| `allowedTools` | ✅ | 1211 | 동일 |
| `resume` / `resumeSessionAt` / `continue` | ✅ | 1591/1603/1221 | 동일 |

**신규 옵션 (활용 가능)**:

| 옵션 | line | 활용 시점 |
|---|---|---|
| `forkSession?: boolean` | 1326 | Phase 1+: 분석 다중 thread 분기 |
| `persistSession?: boolean` | 1376 | Phase 1.2: `false`로 분석 호출 시 disk 쓰기 차단 |
| `thinking?: ThinkingConfig` | 1441 | Phase 1.4: `{ type: 'enabled', budgetTokens: 5000 }` |
| `settingSources?: SettingSource[]` | 1698 | Phase 1.4: `['project']`로 CLAUDE.md만 로드 |
| `appendSystemPrompt?: string` | 2749 | Phase 1.4: writablePaths 제약 추가 |
| `hooks?: Record<HookEvent, ...>` | 1347 | Phase 2.6: PreToolUse hook으로 Opus 차단 |
| `disallowedTools?: string[]` | 1231 | 보안 강화 (옛엔 없었음) |
| `forkSession()` 함수 | 622 | 세션 분기 (`@anthropic-ai/claude-agent-sdk` export) |

**핵심 결론**: 옛 `buildQuery` 코드 거의 그대로 가져온 뒤 신규 옵션 6개를 추가 적용. 호환성 리스크 낮음.

---

## 0.6 — SDK Sandbox 학습 예제 ✅

`sandbox/learn.ts` 작성 + 1회 실행.

**프롬프트**: `"Reply with just the number 42. No other text."`

**측정**:
- duration: **2,637 ms** (성공 응답 "42")
- cost: **$0.0206**
- message stream (5개): `system/init` → `rate_limit_event` → `assistant` × 2 → `result/success`
- usage:
  - `input_tokens`: 10
  - `output_tokens`: 47
  - `cache_creation_input_tokens`: 13,720 (1H TTL prompt cache 생성)
  - `cache_read_input_tokens`: **27,088** (단일 호출 안 두 iteration에서 cache hit)
- 메시지 dump: `sandbox/learn-output.jsonl`

**관찰**:
- 첫 호출인데 cache_read 27K — SDK 자체적으로 system preset prompt 캐싱 활용
- `rate_limit_event`는 정보용 (실제 한도 도달 아님). Phase 1.13 retry 흐름 식별에 사용
- `result.usage.cache_creation.ephemeral_1h_input_tokens = 13,720` — 1H cache 활용 확인 (재호출 시 그대로 hit 가능)

---

## 0.11 — Sandbox 100회 측정 ✅

`sandbox/measure.ts` 실행 (single Node process, no restart). 산출물: `sandbox/measure-summary.md` + `measure-samples.jsonl`.

**전체 결과**:
- Wall time: **248.4 s** (avg 2,484 ms/call)
- Successes: **100 / 100** (실패 0)
- Total cost: **$0.4922** (avg $0.00492/call) — 옛 예상 $2의 1/4 수준

**Go 기준**:
| 항목 | slope/call | threshold | 결과 |
|---|---|---|---|
| RSS | +0.027 MB | < 0.5 | ✅ |
| heapUsed | +0.042 MB | < 0.3 | ✅ |
| handles | 0.000 | < 0.1 | ✅ |
| 실패율 | 0% | 0 | ✅ |

**관찰**:
- RSS 첫 호출 128.3 MB → 100회차 **109.0 MB** (오히려 감소, GC 효과). 누수 없음
- handles 100회 내내 **1** 유지 — Node event loop 외 leak 없음
- duration slope **-5.099 ms/call** — 호출이 진행될수록 빨라짐 (prompt cache hit 안정화)
- **cache_read**: 27,088 → 40,804 tokens 안정 hit
- **cache_create**: 첫 호출만 13,716, 이후 99회 0 → 1H prompt cache가 정확히 작동
- duration max 9,487 ms (1회 spike, 추정 일시적 network/rate-limit). p95 3,637 ms

§5.8 daemon 누적 위험 → **녹색 신호**. Phase 1.14에서 daemon 내 query() 격리 결정에 활용.

env 격리 검증(§5.9)는 별도 작업 (Phase 1.10에서 다중 계정 시뮬레이션으로 처리). measure에서는 메모리/handle 누수 측정에만 집중.

---

## Go 조건 (Phase 1 진입 전 체크)

- ☑ 0.1 브랜치
- ☑ 0.2 옛 SDK 자산 보존
- ☑ 0.3 운영 상태 백업
- ☑ 0.4 분석 baseline
- ☑ 0.5 버전 핀닝
- ☑ 0.6 sandbox 학습
- ☑ 0.7 매핑 검수
- ☑ 0.8 env 정의
- ☑ 0.9 schedule-manager 확인
- ☑ 0.10 SDK install + tsc + delta
- ☑ 0.11 100회 측정 — 누수 없음 + 100% 성공
- ☑ 0.12 contingency 매트릭스

**Phase 0 Go 통과 — Phase 1 진입 가능.**

---

(Go 조건 체크리스트는 0.11 섹션 끝에 통합)
