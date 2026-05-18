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

## 1.7 — 수동 트리거 실행 (대기 — 실 환경 작업)

진입 방법:
```
# pm2 또는 슬랙봇 환경에서
export SLACKBOT_SDK_ENABLED=analysis:kg-skill-update
# 슬랙봇 켜진 상태에서 슬랙 DM:
-assistant run kg-skill-update
```

기대 산출물:
- `reports/{skill-update or mycelium}/2026-05-XX-...md`
- `.assistant-costs.json`의 마지막 entry에 `via: 'sdk'` + cache 토큰 필드 채워짐

검증: 결과 보고서가 baseline `reports/pre-sdk-baseline/mycelium/skill-update-2026-05-16.md`와 형식·내용 의미 동일.

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
