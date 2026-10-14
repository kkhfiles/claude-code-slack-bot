# DM 폴백 — Claude 가 막히면 GPT 가 이어 받음

**DM 폴백을 고치거나 켜기 전에 읽는 참고** — 엔진 폴백 5단계(2026-10-14), 켜는 문은 `DM_FALLBACK=on`, 요약은 `AGENTS.md` 「DM 폴백」

- **원칙**(사용자 결정 2026-10-14) — 멈추는 것보다 품질이 조금 떨어져도 이어 가는 쪽
- **사다리** — Claude → GPT(codex) → 모아 두고 회복 때 처리
  - 6단계가 agy Claude 와 agy Gemini 를 `DM_LADDER`(`src/engine-ladder.ts`)의 GPT 뒤에 넣음
- **꺼져 있으면** — 예전 그대로(막히면 한도 안내를 내고 모아 둠)

## 고르기 — `pickEngine`

| 상황 | 고름 |
|---|---|
| 채널, 계획 모드(`-plan`), 세션 직접 잇기(`-r <id>`, `-continue`) | 늘 Claude, 막혔으면 모아 둠 |
| 개인 글 조각이 든 말(`containsPrivate`) | 늘 Claude, 막혔으면 모아 둠(OpenAI 로 안 보냄) |
| 작업 디렉터리가 업무 비서 뿌리가 아님 | 늘 Claude, 막혔으면 모아 둠 |
| 엔진 상태가 Claude 막힘이라고 함 | Claude 를 안 띄우고 GPT, GPT 도 막혔으면 모아 둠 |
| Claude 가 도는 중에 한도나 과부하로 끝남 | GPT(쓰기가 돌았어도), GPT 도 막혔으면 모아 둠 |
| Claude 의 보통 오류 | 안 넘김(예전 오류 길) |

- **넘기는 차례** — 사람 DM, 판에서 온 말, 메일 후보, DM 에서 받아 모아 둔 것을 다시 돌림
- **GPT 막힘** — 엔진 상태와 한도 조회(`src/codex-quota.ts`)로 판정
  - 한도 조회는 5분 캐시, 못 읽으면 「모름」이라 막지 않음
- **첨부** — 막지 않고 로컬 경로를 프롬프트에 실음

## GPT 차례 — `runDmFallback`(`src/slack-handler.ts`)

- **프롬프트** — 다섯 덩어리
  - Claude 와 같은 안내(슬랙 표면, 캡처, 체크인 번호표)
  - 못 본 대화방 글(새 세션처럼 12시간), 다시 돌리는 차례는 그 메모
  - 넘겨줄 메모(쓰기가 돌았을 때)
  - 사람 말
  - 첨부 경로
- **넘겨줄 메모** — 머리 「이미 한 것 — 다시 하지 말 것 · 결과를 못 받은 것은 확인부터」
  - 줄마다 `완료` 또는 `결과 모름 — 먼저 확인`
- **환경 변수**
  - `WORK_ASSISTANT_CAPTURE=<캡처 id>` — 값으로 넘김(방마다 하나인 가리킴 파일은 다음 차례가 갈아 끼움)
  - `CLAUDE_BOT_SESSION=1` — codex 시작 훅이 투영 동기화를 건너뜀
- **실행 조건**
  - 쓰기 모래상자(`--approve-for-me`)와 기존 쓰기 폴더
  - 작업 폴더는 업무 비서 뿌리
  - 모델은 채널 모델과 같은 등급(`sameTier`), 표를 못 읽으면 기본 모델
  - 깊이 low, 상한 180초
- **같은 방은 한 줄로** — `ChannelGate.acquire`
  - 새 DM 은 문에서 기다림(⏳), GPT 차례를 끊지 않음
  - 다시 돌리는 차례는 드레인이 잡은 문이라 따로 안 잡음
- **`-stop`** — 손잡이를 `activeProcesses` 에 걸어 둠, 끊으면 실패 표시 없음
- **재시작에 끊김** — 처리 중 기록에 「GPT 명령 — 무엇을 했는지 모름」(쓰기)을 넣어 둠, 보류 v2 가 `partial` 로 이어 감

## 결과

- **됨**
  - 답(Claude 마지막 글과 같은 모양) 뒤에 표시 줄(context 블록)
  - 실패 표시 없음
  - GPT 와 Claude 둘 다 쓰기가 없었으면 캡처를 닫음(`대체 엔진이 답함`)
  - 판에서 온 차례가 「[조용히]」로 답했으면 표시 줄도 안 올림
- **못 함**(GPT 한도나 실패)
  - 실패 표시 `limit`, 쓰기가 돌았으면 `partial`(보류 v2 칸 포함)
  - 예전 한도 안내(막힘마다 한 번)
  - codex 오류 글은 안 올림
- **한도 글 안 올림** — 넘길 차례면 아래 신호 뒤의 Claude 글과 결과 글을 안 올림
  - 거절 이벤트(`rate_limit_event` rejected)
  - SDK `error: rate_limit` 또는 `error: overloaded`

## 표시 줄

```
↪ Claude 가 하다 끊겨 GPT 가 이어서 마무리했습니다(이미 한 것: 2건)
↪ GPT(<모델 id>) 가 답함 · Claude 사용량 소진(풀림 10/14(수) 16:10)
```

- **첫 줄** — Claude 가 쓰기를 한 뒤 넘겼을 때만
- **까닭** — `Claude 사용량 소진(풀림 …)`, `Claude 과부하`, 시각을 모르면 `(다시 확인 …)`

## 엔진 안내 — `ENGINE_NOTICE=on`

- **사다리** — 실제로 붙은 칸만(`dmLadder`), 폴백이 꺼져 있으면 Claude 하나
- **때** — 막힘이 바뀔 때마다, 그리고 GPT 차례 뒤에 한 번 더 확인
- **되풀이** — 같은 바뀜은 한 번만

## 장부 — `.fallback-ledger.jsonl`

- **칸 여섯** — 말은 안 적음
  - `at`(epoch 초), `channel`, `model`, `captureId`
  - `engine` — `codex`, 다 막혀 모아 두면 `none`
  - `outcome` — `ok`, `usage`, `fail`, `hold`, `stopped`
- **돌아온 첫 Claude 차례** — 세션의 마지막 차례 뒤에 `ok` 가 있으면 앞에 한 줄
  - 「[Claude 가 막힌 동안 다른 엔진이 처리한 것 — N건 · 자세한 내용은 위 대화방 글]」
  - 그 차례가 판이나 메일이 민 것이어도 못 본 대화방 글을 붙임(안 붙이면 세션 시각이 밀려 사람의 다음 차례도 그 글을 못 받음)
- **Claude 를 건너뛴 차례** — 세션 시각을 안 고침, 그 사이 글이 다음 차례의 「못 본 대화방 글」로 감

## 연습 파일 — `.engine-drill.json`(`src/engine-drill.ts`)

```json
{ "claude": "usage", "codex": "usage", "expiresAt": 1792000000, "scope": "all" }
```

- **`claude`**
  - `usage` — 거절 이벤트, 한도 글, 오류 결과를 재생
  - `overload` — 529 글을 재생
  - `usage-after-tool` — 진짜 차례를 첫 도구 결과까지 돌린 뒤 끊음
- **`codex`** — `usage`(엔진 상태에 막힘을 적음) 또는 `fail`
- **안 받는 파일** — 없음, 지남, `expiresAt` 이 2시간 넘게 남음, 깨짐
- **범위** — 대화 차례만, `scope: "all"` 이면 예약 일까지
- **막힘 길이** — 20분 뒤와 연습 파일의 `expiresAt` 중 이른 쪽(`drillBlockUntil`). 파일을 일찍 지우면 남은 시간만큼 엔진 상태에 남음(그동안 DM 은 Claude 를 건너뜀)
- **로그** — 주입할 때마다 WARN 한 줄

## `-engines`

- **머리 한 줄** — DM 폴백, 엔진 안내, 연습 상태
- **엔진 네 줄** — 막힘, 풀리는 시각, 마지막 성공, 5시간과 7일 사용률, 사다리 밖 표시
- 버튼 없음

## 아는 빈틈 — 6단계에서

- **드레인은 Claude 가 풀려야 돎** — GPT 가 먼저 회복돼도 모아 둔 것은 Claude 회복 때 다시 돎
  - 「⏸ 모든 엔진 소진 — … 가장 빠른 회복에 처리」 안내와 어긋남
- **agy 칸** — `DM_LADDER` 에 넣으면 `pickEngine` 의 다음 칸 고르기를 그대로 씀, 첨부(`hasFiles`)는 거기서 가름

검사 `npm run check:dmfallback`
