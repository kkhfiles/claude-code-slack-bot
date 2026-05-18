# Phase 1 — POC: 분석 1종 SDK 호출

상세 계획서: `P:/github/claude-workflow/reports/action-plans/2026-05-15-slackbot-sdk-migration-detailed.md` §6 Phase 1.

진입: 2026-05-18 (Phase 0 Go 통과 직후).

---

## 1.1 — package.json + lock 커밋 ✅

Phase 0.10에서 통합 처리됨. commit `d0c725f`에 포함.

```
"@anthropic-ai/claude-agent-sdk": "~0.3.143"
```

(상세 계획에선 `^`였으나 minor 자동 갱신을 막기 위해 `~`로 핀닝)

---

## 1.2 — `src/sdk-handler.ts` 신규 ✅

commit `046005f`. 215줄 (옛 claude-handler.ts 247줄 + 신규 옵션 반영, 슬랙 session disk persistence는 제거 — analysis path는 `persistSession: false`).

구성:
- `interpretSdkMessage(msg: SDKMessage): CliEvent | null` — SDK→CLI 이벤트 형식 변환 (system/assistant/user/result/rate_limit_event 5종, partial/stream_event는 drop)
- `SdkProcess` class — `CliProcess`와 동일한 `AsyncIterable<CliEvent>` interface + `interrupt()` + `kill()` + `pid` getter. abort는 `AbortController`.
- `SdkHandler.runQuery(prompt, opts: SdkRunOptions): SdkProcess` — `CliHandler.runQuery` 시그니처와 호환 (workingDirectory / model / permissionMode / allowedTools / tools / appendSystemPrompt / systemPrompt / env / maxBudgetUsd / skipMcp / resumeSessionId / continueLastSession / session). 신규 입력: `canUseTool`, `thinkingBudgetTokens`.
- `shouldUseSdk(scope: string): boolean` — feature flag 매칭. `SLACKBOT_FORCE_CLI=1` 우선, 그 외 `SLACKBOT_SDK_ENABLED` 토큰 매칭 (콤마/플러스 분리, 카테고리 prefix 매치, `all`).

---

## 1.3 — Feature flag 진입점 ✅

`assistant-scheduler.runSingleAnalysis`:

```ts
const useSdk = shouldUseSdk(`analysis:${type}`);
const result = await this.spawnSession(prompt, {
  ...,
  useSdk,
  thinkingBudgetTokens: useSdk ? 5000 : undefined,
});
```

`slack-handler.runAssistantSession`:

```ts
const proc = opts.useSdk
  ? this.sdkHandler.runQuery(prompt, { ...commonOpts, thinkingBudgetTokens })
  : this.cliHandler.runQuery(prompt, commonOpts);
```

POC 진입 방법:
```
SLACKBOT_SDK_ENABLED=analysis:kg-skill-update
```

기본은 unset이라 모든 흐름은 CLI 경로 그대로.

---

## 1.4 — SDK 옵션 빌더 ✅

`sdk-handler.ts:runQuery` 안:

| 옵션 | 값 | 비고 |
|---|---|---|
| `permissionMode` | `'default'` (또는 trust→`'bypassPermissions'`) | CLI 매핑 |
| `systemPrompt` | `{ type: 'preset', preset: 'claude_code' }` | 옛 SDK 그대로 |
| `settingSources` | `['project']` | 글로벌 `~/.claude/` 자동 로드 차단, repo CLAUDE.md만 |
| `persistSession` | `false` | 분석 호출은 disk session 안 만듦 |
| `includePartialMessages` | `false` | partial stream 차단 (필요 없음) |
| `appendSystemPrompt` | `opts.appendSystemPrompt` | writablePaths 제약 그대로 |
| `thinking` | `{ type: 'enabled', budgetTokens: 5000 }` | useSdk + 분석 흐름에서만. 다른 흐름은 undefined |
| `mcpServers` | `mcpManager.getServerConfiguration()` | cli-handler와 동일 — 단 분석은 `skipMcp:true`라 사용 안 됨 |
| `abortController` | new | maxDurationMs 만료 시 interrupt |
| `resume` / `resumeSessionAt` / `continue` | opts에서 그대로 | resume 흐름 유지 |

---

## 1.5 — `interpretSdkEvents` (메시지 해석) ✅

`SdkProcess[Symbol.asyncIterator]` 안에서 `interpretSdkMessage` 호출. 추가로:

- abort 발생 시 `result/error_timeout` 합성 (`subtype='error_timeout'`)
- SDK 던지는 기타 에러 시 `result/error` 합성 + `errorCollector` 기록

결과: 호출자(`runAssistantSession`)는 CLI 경로와 동일한 형태로 `for await` 처리. assistant 텍스트 추출 / sessionId / costUsd 모두 동일 코드 경로.

신규: `event.type === 'result'`에서 `(event as any).usage` 접근 — SDK는 `usage.{input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens}` 풍부 정보. CLI는 누락 → `usage` undefined.

---

## 1.6 — 비용 기록 확장 ✅

`SessionUsage` 타입 신규 (`assistant-scheduler.ts`):
```ts
export interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreateTokens: number;
  cacheReadTokens: number;
}
```

`SessionResult.usage?: SessionUsage` 추가.

`CostEntry` 확장:
```ts
interface CostEntry {
  timestamp, type, costUsd, sessionId,
  inputTokens?, outputTokens?, cacheCreateTokens?, cacheReadTokens?, via?: 'cli'|'sdk'
}
```

`recordCost(type, costUsd, sessionId, extras?: { usage, via })`. 옛 호출 시그니처 호환 (extras optional).

JSON 스키마: 옛 entry는 신규 필드 누락 — `loadCosts`의 cutoff 필터 외엔 변경 없어 호환.

---

## 1.7 — 수동 트리거 실행 (자동 진입 준비 완료, 2026-05-18)

### 준비 완료된 자산

- commit `5102bb4`: `ReportServer`에 `POST /trigger?type=<analysis-type>` endpoint 추가. 127.0.0.1 바인딩 → token 불요. SlackHandler가 `assistantScheduler.runAnalysisManual`을 callback으로 wire함.
- 사용자가 `.env`에 `SLACKBOT_SDK_ENABLED=analysis:kg-skill-update` 한 줄 추가 완료 (2026-05-18, 컴팩트 직전).

### 컴팩트 복귀 후 즉시 진입 절차 (어시스턴트 자동)

```powershell
# 1) 빌드 (background OK, 5~20초)
npm run build --prefix P:/github/claude-code-slack-bot

# 2) pm2 재시작 — env 갱신 필수
pm2 restart claude-slack-bot --update-env

# 3) ReportServer port 추출 (배포된 로그에서)
pm2 logs claude-slack-bot --lines 100 --nostream | Select-String "Listening on http://127.0.0.1"
# 예: "Listening on http://127.0.0.1:8087" → port=8087

# 4) trigger
curl.exe -X POST "http://127.0.0.1:<port>/trigger?type=kg-skill-update"
# 기대 응답: 202 + {"ok":true,"type":"kg-skill-update","accepted":true}

# 5) 진행 모니터링 (background)
pm2 logs claude-slack-bot --lines 0
```

### 검증 포인트 (분석 완료 후, 5~20분 소요)

pm2 로그에서 이 3 줄이 순서대로 보여야 SDK 경로 작동:
1. `[SdkHandler] Building SDK query { permissionMode: 'default', ..., thinkingBudget: 5000 }`
2. `[SlackHandler] Assistant session started { via: 'sdk' }`
3. `[AssistantScheduler] Recorded cost { type: 'analysis-kg-skill-update', costUsd: ..., via: 'sdk', cacheRead: ... }`

### 결과 분석

- `.assistant-costs.json` 마지막 entry — `via: 'sdk'` + `cacheReadTokens` / `cacheCreateTokens` 채워짐
- 결과 보고서: `P:/github/claude-workflow/reports/mycelium/skill-update-<date>.md`
- baseline: `P:/github/claude-workflow/reports/pre-sdk-baseline/mycelium/skill-update-2026-05-16.md` (1.8 비교)

### 긴급 롤백

분석 실패·이상 출력 시:
```powershell
Add-Content -Path P:\github\claude-code-slack-bot\.env -Value "`nSLACKBOT_FORCE_CLI=1"
pm2 restart claude-slack-bot --update-env
```
또는 main 브랜치로:
```powershell
git -C P:/github/claude-code-slack-bot checkout main
npm run build --prefix P:/github/claude-code-slack-bot
pm2 restart claude-slack-bot --update-env
```

### 컴팩트 복귀 시 entry point

새 세션 첫 메시지로 "1.7 진행" 또는 "ok" 받으면 위 5 step 순차 실행 + 모니터링.

---

## 1.8 — 동등성 비교 (대기)

- flag off: `SLACKBOT_SDK_ENABLED=` (unset) → CLI 1회 실행 → 결과 A
- flag on: `SLACKBOT_SDK_ENABLED=analysis:kg-skill-update` → SDK 1회 실행 → 결과 B
- `git diff` 또는 수동 spot-check
- 토큰 단위 일치는 LLM 특성상 비현실 — 헤더/섹션/결론 의미 동일성

---

## 1.9 — 캐싱 효과 측정 (대기)

- SDK 경로 같은 prompt 2~3회 연속 실행 (각각 1.7 패턴)
- `.assistant-costs.json` 최근 3 entries의 `cacheReadTokens` 비교
- 2회차부터 cache_read ≥ 50% 잠정 기준 (sandbox에서 40K 토큰 안정 hit 관찰됨)

---

## 1.10 — 다중 계정 시뮬레이션 (대기)

`accountManager.getAccessToken()`이 다른 OAuth 토큰을 반환하도록 전환 → 호출 → Anthropic 응답의 account 정보 (또는 비용 귀속) 확인.

§5.9 위험 — env 격리. SDK options.env 주입 후 in-process 호출이 새 토큰을 잡는지가 본질. sandbox에서 0.6/0.11 측정으론 검증 불가 (단일 계정 단일 토큰).

---

## 1.11 — Rate limit 메시지 dump (대기)

실 한도 도달 어려움 → mock SDK 메시지로 `interpretSdkMessage` 단위 테스트. mock 패턴:

```ts
const mockRateLimit: SDKMessage = {
  type: 'rate_limit_event',
  rate_limit_info: { status: 'rate_limited', resetsAt: ..., ... },
  session_id: 'mock-session',
} as any;
const ev = interpretSdkMessage(mockRateLimit);
// 기대: type='rate_limit_event'인 CliRateLimitEvent
```

---

## 1.13 — retry 흐름 검증 (대기)

`assistant-scheduler.runSingleAnalysis`의 rate-limit 분기:
```ts
if (isRateLimitText(result.text) || result.subtype === 'error_max_budget_usd') {
  return { rateLimited: true, ... };
}
```

SDK 경로에서 rate-limit 발생 → result.text에 rate-limit 텍스트가 들어가는지 + `error_max_budget_usd` subtype이 전파되는지가 핵심. mock으로 통합 테스트.

후속 처리(failedRetryTypes.push → 1시간 후 resume)는 같은 코드 경로 — 변경 없음.

---

## 1.14 — 격리 옵션 결정 (잠정 ✅ — sandbox 결과 활용)

Phase 0.11 sandbox 100회 측정:
- RSS slope +0.027 MB/call (threshold 0.5)
- heap slope +0.042 MB/call (threshold 0.3)
- handles 1 → 1 (0)
- 실패 0 / 100

**결정: daemon 내 `query()` 직접 호출** (child_process.fork 분리 불요). Phase 2/3 진행하며 동일 측정 반복하다 누수 발견 시 fork 분리로 전환.

근거:
- in-process라야 1H prompt cache 효과 극대화 (cache_create 13.7K → 99회 0)
- fork 분리하면 호출당 Node 부팅 + abort/timeout 처리 복잡도 증가
- §5.8 백업 옵션은 Phase 2.13 daemon 모니터링 결과로 트리거

---

## 1.12 — Phase 1 회고 (대기 — 1.7~1.10 실행 후)

`reports/action-plans/2026-05-2X-sdk-phase1-poc.md` 작성:
- 효과: SDK 1.7~1.9 결과로 캐싱 hit률 + 비용 변화 표
- 문제: 1.10/1.13/1.14 검증 결과 정리
- Phase 2 진입 Go/No-go 결정

---

## Go 조건 (Phase 2 진입 전 체크)

- ☑ 1.1 package.json/lock
- ☑ 1.2 sdk-handler 작성 (tsc 통과)
- ☑ 1.3 feature flag
- ☑ 1.4 SDK 옵션 빌더
- ☑ 1.5 interpretSdkEvents
- ☑ 1.6 recordCost 확장
- ☑ 1.14 격리 잠정 결정 (daemon 안)
- ☐ 1.7 수동 트리거 1회
- ☐ 1.8 동등성 비교
- ☐ 1.9 캐싱 측정
- ☐ 1.10 다중 계정
- ☐ 1.11 rate-limit dump
- ☐ 1.13 retry 통합 테스트
- ☐ 1.12 회고

### 2026-05-18: Phase 1.7 — 자동 트리거 실행 결과

| 항목 | 값 |
|---|---|
| trigger 시각 | 2026-05-18T03:05:05.213Z |
| Recorded cost 시각 | 2026-05-18T03:07:30.752Z |
| 총 소요 | 2분 25초 |
| via | sdk ✅ |
| cacheReadTokens | 100,108 (1H prompt cache hit) |
| cacheCreateTokens | 39,510 |
| inputTokens | 4 |
| outputTokens | 9,637 |
| costUsd | $0.32417 |
| pm2 안정성 | online, error 없음 |

**비용 비교** (analysis-kg-skill-update entry, 최근 4회):

| 일자 | via | costUsd |
|---|---|---|
| 2026-05-01 | cli | $0.4740 |
| 2026-05-08 | cli | $0.6425 |
| 2026-05-15 | cli | $0.7010 |
| 2026-05-18 | **sdk** | **$0.3242** |

직전 CLI 3회 평균 $0.606 대비 **-47%** 절감.

### Phase 1.7 Go 통과 — 6 step 검증

1. ✅ build clean (tsc)
2. ✅ pm2 restart, online
3. ✅ ReportServer listening on http://127.0.0.1:8765
4. ✅ POST /trigger?type=kg-skill-update → 202 Accepted
5. ✅ pm2 로그에 `SdkHandler Building SDK query` + `via:'sdk'` 진입 신호 + `Recorded cost` 완료 신호 관측
6. ✅ .assistant-costs.json 마지막 entry 정상 (via:'sdk', cacheRead 100K)

### 관찰 / 다음 트랙

- **SKILL.md mtime 미변경** — SDK가 "변경 없음" 판단했을 가능성. Phase 1.8 (#17)에서 baseline 비교 + 필요시 동일 입력으로 CLI 재실행 비교.
- **SdkHandler 로깅 간략** — CLI는 매 메시지·tool 호출 로깅, SDK는 진입·종료 메타만 로깅. Phase 2에서 보강 후보. 디버깅 시 어려움 우려.
- **캐시 적중 매우 좋음** — 100K 1H cache read. 향후 모든 분석을 SDK로 옮겨도 동일 효과 기대.


### 2026-05-18: Phase 1.8 — 산출물 동등성 + 1H 캐시 검증

**산출물 동등성**:
SDK 1차 호출 후 `~/.claude/skills/mycelium/skill.md` mtime 미변경 = SDK가 "변경 없음" 판단. baseline 5/16 → 5/18 KG state diff 직접 확인:

| 지표 | 5/16 baseline | 5/18 현재 | Δ |
|---|---|---|---|
| Total nodes | 25,915 | 26,021 | +106 |
| Type 종류 | 16 | 16 | 0 |
| Major examples (person/org/project/tool/concept) | — | 유효 | 0 |

`source_file +38, java_class +6, jira_issue +28, pull_request +34` — 정기 sync 누적 delta만. 도메인 힌트 본문 변경 불필요. **SDK 판단 정확**.

**1H prompt cache 동작**:

| 호출 | 시각 (UTC) | 직전 호출과 gap | cacheCreate | cacheRead | output | costUsd |
|---|---|---|---|---|---|---|
| 1차 | 03:07:30 | — | 39,510 | 100,108 | 9,637 | $0.324 |
| 2차 | 05:54:19 | +2h 47m | 41,212 | **469,864** | 9,610 | $0.441 |

- 2차 cacheRead가 1차의 4.7배 — 시스템 캐시 + 1차 호출에서 생성된 캐시 누적
- 1H TTL 60분 초과 후에도 cacheRead 적중 (Anthropic API 동작 — 정확한 TTL 정책 불명확, 누적 read 합계 가능성)
- cacheCreate가 매 호출 새로 발생 → 비용 변동 +36% (2차)
- **CLI 평균 $0.606 대비**: 1차 -47% / 2차 -27% / **평균 -37% 절감**

### Phase 1.8 결론

- ✅ SDK 출력 정확성: KG state 일치 검증으로 "변경 없음" 판단 신뢰
- ✅ 1H 캐시 작동: cacheRead 적중 일관됨
- ⚠️ 호출간 비용 변동성: cacheCreate 재발생으로 절감 폭이 -27%~-47% 변동. **일관 -90% 같은 결과는 아님** (Phase 0 단순 sandbox는 system prompt 정적, 실 분석 호출은 도구 호출·thinking이 변동 발생)
- 결정: SDK 라우팅 의미 있는 절감 (-37% 평균) → Phase 2 확대 진행 가능


### 2026-05-18: SDK 회귀 fix 3종 + 검증 (kg-health, cli-usage)

`SLACKBOT_SDK_ENABLED=analysis`로 확장 후 kg-health 첫 trigger에서 audit.py 미호출 + 보고서 미생성 회귀 발견. 단계적 진단 + fix:

#### Fix 1 — settingSources 확장 (`7945dda`)
- 증상: SDK가 settings.local.json 못 읽음 → `Bash(python:*)` permission 패턴 누락
- 진단: `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` SettingSource = `'user' | 'project' | 'local'`. 코드는 `['project']`만 사용
- 수정: `['user', 'project', 'local']`로 확장 (precedence: user < project < local)
- 효과: kg-health 2차 호출 output 1.6K → 4.6K (도구 시도는 증가)

#### Fix 2 — allowedTools base tool name (`5938879`)
- 증상: Bash 도구 호출 여전히 실패
- 진단: SDK `allowedTools` 명세는 bare tool name (`'Bash'`)만, CLI 형식 permission 패턴 (`'Bash(python:*)'`)은 못 찾음. CLI는 패턴 자동 분해, SDK는 그대로 받음
- 수정: `toBaseToolName()` 헬퍼로 `'Bash(python:*)' → 'Bash'` 변환 + Set으로 중복 제거. Settings-level pattern 매칭은 settingSources 경유로 별도 적용되어 보안 약화 없음
- 효과: kg-health 3차 호출 output 4.1K (변화 미미 — 다음 fix 필요)

#### Fix 3 — permissionMode 'default' → 'dontAsk' 매핑 (`5ecfeec`)
- 증상: 도구 호출 시도는 했지만 실제 실행 안 됨
- 진단: SDK `'default'` mode는 위험 작업에 사용자 prompt 요청 → background 분석은 stdin 응답 불가 → 자동 거부. `'dontAsk'` mode는 settings의 allow 패턴으로 pre-approved된 것만 통과, 나머지 자동 거부 (CLI `--print` + settings.local.json 동작과 동일)
- 수정: sdk-handler permissionMode 매핑에서 `'default'` → `'dontAsk'`
- 효과: kg-health 5차 호출이 정상 audit 시도 + mycelium 가드 응답 ("B7 배치 차단" 안내)

#### 검증 — cli-usage 사전 trigger (mycelium 가드 무관 분석)
- output 13,067 tokens
- cost $0.797 (CLI 직전 평균 $1.93 대비 **-59%**)
- 보고서 `reports/cli-usage/2026-05-18.md` 정상 생성 ✅
- textPreview: "보고서가 생성됐습니다 ... 676건 / 40일 ... 실패 패턴 5가지 ... 권고 2건"

#### 부가 변경
- `assistant-scheduler.ts` `textPreview` 로깅 추가 (`2df2350`) — 분석 응답 본문 첫 600자를 pm2 log에 출력. 디버깅 + 운영 모니터링용. Slack/외부 surface로는 절대 가지 않음

#### 누적 commits (5/18)
| commit | 변경 |
|---|---|
| 12b3161 | analysis: pin model to claude-sonnet-4-6 |
| 7945dda | sdk-handler: settingSources `['user','project','local']` |
| 5938879 | sdk-handler: strip permission patterns from allowedTools |
| 5ecfeec | sdk-handler: 'dontAsk' instead of 'default' |
| 2df2350 | assistant-scheduler: textPreview log |

#### 비용 비교 (5/18 누적)

| 분석 type | CLI 평균 | SDK | Δ |
|---|---|---|---|
| kg-skill-update (2회) | $0.606 | $0.383 | -37% |
| kg-health (5회) | $0.92 | varied (mycelium 가드) | n/a |
| cli-usage (1회) | $1.93 | $0.797 | **-59%** |

#### Go / 결정
- ✅ SDK 도구 호출 정상 동작 — fix 3종 묶음이 필수 조건
- ✅ analysis 카테고리 전체 토글 안전성 확인 (cli-usage 외 다른 11종도 같은 SDK options 공유)
- ⏳ 5/22 토요일 자동 fire 6종 그대로 진행 (B7 배치 영향 받는 것은 kg-health/kg-regression만, 그 외는 영향 없음)
- ⏳ kg-health/kg-regression은 mycelium 가드 충돌이 잠재적 — B7 배치 완료 후 시점에 fire되도록 보장 또는 retry 로직이 잘 동작하는지 별도 검증

