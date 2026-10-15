# DM 폴백 — Claude 가 막히면 GPT → agy Gemini → agy Claude Sonnet 이 이어 받음

**DM 폴백을 고치거나 켜기 전에 읽는 참고** — 엔진 폴백 5단계와 6단계(2026-10-14), 켜는 문은 `DM_FALLBACK=on`(GPT)과 `DM_FALLBACK_AGY=on`(agy 두 칸), 요약은 `AGENTS.md` 「DM 폴백」

- **원칙**(사용자 결정 2026-10-14) — 멈추는 것보다 품질이 조금 떨어져도 이어 가는 쪽
- **사다리** — Claude → GPT(codex) → agy Gemini → agy Claude Sonnet → 모아 두고 회복 때 처리
  - agy 두 칸은 `DM_FALLBACK_AGY=on` 일 때만(`src/engine-ladder.ts` 의 `DM_LADDER_AGY`) — 「6단계 — agy 두 칸」 절
- **폴백 모델** — llm-playbook `models.json` 의 `service_fallback`(아래 「폴백 모델 — 서비스 폴백 대응표」)
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
  - 남은 양이 있다고 읽히면 사용량 소진 막힘을 지움(막힌 창을 그때 못 읽었으면 그대로, 마지막 성공은 안 고침)
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
  - 모델은 서비스 폴백 대응표(아래 「폴백 모델 — 서비스 폴백 대응표」), 표에 그 칸이 없으면 같은 등급(`sameTier`)이나 기본 모델
  - 깊이는 대화 차례의 것(low), 대응표가 luna 면 한 단계 위(medium)
  - 상한 180초
  - GPT 가 못 하면 다음 칸(agy)이 있을 때 그리로 넘기고, GPT 가 돌린 명령은 「이미 한 것」으로 넘어감
- **같은 방은 한 줄로** — `ChannelGate.acquire`
  - 새 DM 은 문에서 기다림(⏳), GPT 차례를 끊지 않음
  - 원문 캡처는 문에서 기다리기 전에 함(말 하나에 캡처 하나) — 기다리는 사이 재시작해도 말이 남음
  - 다시 돌리는 차례는 드레인이 잡은 문이라 따로 안 잡음
- **`-stop`** — 손잡이를 `activeProcesses` 에 걸어 둠, 끊으면 실패 표시 없음
  - `-stop` 과 `-reset` 은 차례와 같은 키로 찾음(DM 맨 위는 `direct`)
  - 다시 돌리던 차례를 끊으면 그 캡처를 버림 — 남기면 다음 드레인이 대체 칸이 한 명령을 모르는 채 또 돌림
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
- **한도 글 안 올림** — 아래 신호 뒤의 Claude 글과 결과 글을 안 올림
  - 거절 이벤트(`rate_limit_event` rejected)
  - SDK `error: rate_limit` 또는 `error: overloaded`
  - 넘기지 않는 차례(개인 글, 채널, 계획, 다른 작업 디렉터리)와 폴백이 꺼진 때도 같음 — 한도 안내(막힘마다 한 번)가 대신 알림
  - 보통 글은 낱말로 안 훑음(오류 결과의 글만 한도 낱말로 봄)

## 표시 줄

```
↪ Claude 가 하다 끊겨 GPT 가 이어서 마무리했습니다(이미 한 것: 2건)
↪ GPT(<모델 id>) 가 답함 · Claude 사용량 소진(풀림 10/14(수) 16:10)
```

- **첫 줄** — Claude 가 쓰기를 한 뒤 넘겼을 때만
- **까닭** — `Claude 사용량 소진(풀림 …)`, `Claude 과부하`, 시각을 모르면 `(다시 확인 …)`
- **agy 칸** — `↪ <표시 이름> 가 답함` 뒤에 앞 칸마다 까닭(아래 「6단계 — agy 두 칸」)

## 엔진 안내 — `ENGINE_NOTICE=on`

- **사다리** — 실제로 붙은 칸만(`dmLadder`), 폴백이 꺼져 있으면 Claude 하나
- **때** — 막힘이 바뀔 때마다, 그리고 GPT 차례 뒤에 한 번 더 확인
- **되풀이** — 같은 바뀜은 한 번만

## 장부 — `.fallback-ledger.jsonl`

- **칸 여섯** — 말은 안 적음
  - `at`(epoch 초), `channel`, `model`, `captureId`
  - `engine` — `codex`, `agy-gemini`, `agy-claude`, 다 막혀 모아 두면 `none`
  - `outcome` — `ok`, `usage`, `fail`, `hold`, `stopped`
- **돌아온 첫 Claude 차례** — 세션의 마지막 차례 뒤에 `ok` 가 있으면 앞에 한 줄
  - 「[Claude 가 막힌 동안 다른 엔진이 처리한 것 — N건 · 자세한 내용은 위 대화방 글]」
  - 그 차례가 판이나 메일이 민 것이어도 못 본 대화방 글을 붙임(안 붙이면 세션 시각이 밀려 사람의 다음 차례도 그 글을 못 받음)
- **Claude 를 건너뛰었거나 다른 엔진이 끝을 맡은 차례** — 세션 시각을 안 고침, 그 사이 글(대체 엔진의 답 포함)이 다음 차례의 「못 본 대화방 글」로 감
- **세션 정리(24시간)** — 장부에 그 방의 차례가 24시간 안에 있으면 쓰는 중으로 보고 안 지움(며칠 막힌 동안 DM 대화 세션을 잃지 않게)

## 연습 파일 — `.engine-drill.json`(`src/engine-drill.ts`)

```json
{ "claude": "usage", "codex": "usage", "expiresAt": 1792000000, "scope": "all" }
```

- **`claude`**
  - `usage` — 거절 이벤트, 한도 글, 오류 결과를 재생
  - `overload` — 529 글을 재생
  - `usage-after-tool` — 진짜 차례를 첫 도구 결과까지 돌린 뒤 끊음
- **`codex`** — `usage`(엔진 상태에 막힘을 적음) 또는 `fail`
- **`agyGemini`**, **`agyClaude`**(6단계) — `codex` 와 같은 두 갈래, agy 를 안 띄움
- **안 받는 파일** — 없음, 지남, `expiresAt` 이 2시간 넘게 남음, 깨짐
- **범위** — 대화 차례만, `scope: "all"` 이면 예약 일까지
- **막힘 길이** — 20분 뒤와 연습 파일의 `expiresAt` 중 이른 쪽(`drillBlockUntil`). 파일을 일찍 지우면 남은 시간만큼 엔진 상태에 남음(그동안 DM 은 Claude 를 건너뜀)
- **로그** — 주입할 때마다 WARN 한 줄

## `-engines`

- **머리 한 줄** — DM 폴백, agy 칸, 엔진 안내, 연습 상태
- **엔진 네 줄** — 막힘, 풀리는 시각, 마지막 성공, 5시간과 7일 사용률, 사다리 밖 표시(순서는 사다리 순서)
- 버튼 없음

## 폴백 모델 — 서비스 폴백 대응표

- **정본** — llm-playbook `models.json` 의 `service_fallback`(`src/model-ladder.ts` 의 `serviceCodex`), `tiers` 가 아님
- **codex 칸** — 1차 Claude 모델의 집안(opus, sonnet, haiku)마다 codex 별칭 하나
  - 별칭이나 id(`[1m]` 꼬리 포함)로 와도 맞춤
  - 실제 모델 id 는 `codex.models[별칭].id`
- **깊이** — 1차의 것, `effort_up` 에 적힌 별칭(luna)은 그 모델의 깊이 목록을 따라 그만큼 올림
  - 예: sonnet low → luna medium, haiku high → luna xhigh, opus low → sol low, max 는 그대로
- **쓰는 곳** — DM 의 GPT 칸, 예약 일 폴백(`spawnOrFallback`), 도구 없는 사다리의 codex 칸, 판의 좁은 길
  - 좁은 길은 `BOARD_NARROW_CODEX_MODEL`, `BOARD_NARROW_CODEX_EFFORT` 가 먼저
- **agy 칸** — `service_fallback.agy` 의 앞이 Gemini 칸, 뒤가 agy Claude 칸(1차 모델과 무관)
- **표에 칸이 없으면** — 예전 그대로(같은 등급 `sameTier`, 기본 모델), WARN 한 번
- **`after_agy`** — 부서 대화 봇 몫이라 이 봇은 안 읽음

## 6단계 — agy 두 칸

- **켜는 문** — `DM_FALLBACK_AGY=on`(DM 은 `DM_FALLBACK=on` 도 필요)
- **순서** — Gemini(`flash-high`) 다음 agy 의 Claude Sonnet(`sonnet-thinking`), agy 의 Opus 는 안 씀(그 사용량이 작음)
- **건너뛰는 조건** — 엔진 상태가 막혔다고 할 때(진짜 막힘과 연습)뿐, 횟수 상한은 두지 않음(2026-10-14 사용자 결정)
- **안 받는 차례** — 첨부가 있는 차례, 「Claude·GPT 몫」으로 남긴 것을 다시 돌리는 차례(`needsFull`), 넘기지 않는 차례(위 표)
- **부르는 길** — `src/agy-turn.ts`
  - `python -m llm_playbook.backends.agy --model <별칭> --no-fallback --tools none`, 셸 없이 인자 배열
  - 상한은 agy Claude 90초, Gemini 150초
  - 한도는 백엔드 stderr 끝 줄의 `attempts=[(…, 'quota/limit')]` 로 가름(쿼터 글도 rc 0 으로 오기 때문), 풀리는 시각을 몰라 60분 뒤 다시 봄
  - stderr 는 끝 40KB 만 들고 있음 — 앞을 남기면 말 많은 차례에서 끝 줄을 잃어 쿼터 글이 답으로 읽힘
- **agy 가 내는 것** — JSON 하나: `reply`, `actions`, `needs_full`, `needs_full_reason`
  - 코드펜스와 앞뒤 한 줄은 너그럽게 읽음, 모양이 다르면 다음 칸
- **프롬프트** — 이 칸의 규칙(`AGY_DM_RULES`), 지금 시각, 열린 업무 전부(`tasks.py json --slim`), 체크인 번호표, 넘겨줄 메모, 못 본 대화방 글, 사람 말
  - 열린 업무를 일부만 주면 두 엔진 다 엉뚱한 업무를 골랐음(0단계 측정)

### 허용 목록 — `src/agy-actions.ts`

| 명령 | 받는 칸 | 막는 것 |
|---|---|---|
| `add` | title, est, importance, size, hard, soft, next, remind, jira, exec_type | 제목 120자, 줄바꿈 |
| `update` | id(TSK-n), sets(칸 이름 14개) | 글 칸 비우기, 작업 디렉터리와 순서 |
| `log` | id(TSK-n 또는 목록의 정기 업무), text | 1500자 |
| `defer` | id, reason, soft | 사유 없음 |
| `quick` | text | 항목마다 TSK-n 으로 시작하지 않는 것(번호표 번호) |
| `inbox_resolve` | task 또는 drop | 다른 캡처 id |
| `recurring_done` | id(목록의 정기 업무), as_of, note | 목록에 없는 id |
| `focus` | note, pick(열린 업무 3개까지) 또는 off | 목록에 없는 번호 |

- **공통** — 모르는 칸, 날짜가 `YYYY-MM-DD` 가 아님, 한 줄 칸의 줄바꿈과 제어 문자, 한 번에 8개 넘음 → 「실행하지 않은 명령」
  - `update` 의 칸 이름은 목록의 제 칸만 받음(`constructor`, `__proto__` 같은 원형 이름은 거절)
- **실행** — `python -X utf8 bin/tasks.py <명령> --이름=값 …`, 셸 없이(값에 `&`, `|`, `$(…)` 가 있어도 글자 그대로)
  - 환경 변수 `WORK_ASSISTANT_CAPTURE=<캡처 id>`, `CLAUDE_BOT_SESSION=1`, API 키 뺌
  - 앞 명령이 실패하면 뒤는 안 돌림
  - 값의 뜻(상태 낱말, 칸 이름)은 파이썬 문(`_check_sets`)이 한 번 더 봄

### 답과 표시 줄

```
「보고서 초안(TSK-5)」을 진행중으로 바꾸고 진행 로그를 남겼습니다.

*실행한 것*
• 「보고서 초안」(TSK-5) — 상태 진행중 · 소프트 마감 10/20(화)
• 「보고서 초안」(TSK-5) 진행 로그 남김

*실행하지 않은 명령*
• delete TSK-5 — 허용 목록에 없는 명령
↪ Gemini <판> Flash (High) 가 답함 · Claude 사용량 소진(풀림 10/14(화) 16:10) · GPT 사용량 소진(다시 확인 10/14(화) 17:00)
```

- **표시 이름** — `models.json` 의 `agy.models`, agy Claude 는 「agy 의 …」
- **판에서 온 「[조용히]」** — 다 그대로 됐을 때만 조용, 안 된 것이 있으면 그 줄들을 냄
- **쓰기가 없었으면** — 캡처를 닫음(`대체 엔진이 답함`), 명령이 돌았으면 `tasks.py` 가 닫음

### `needs_full` — Claude·GPT 몫을 남김

- 답과 「⏸ 이 부분은 Claude·GPT 가 돌아오면 이어서 처리합니다 — <까닭>」
- 캡처에 실패 표시 `limit`(명령이 돌았으면 `partial`)와 보류 칸 `needs: full`(파이썬 `_hold_extra` 가 받음)
- 차례 결과는 막힘 — 드레인이 멈추고, agy 만 남은 동안은 그 건을 안 집음

### 드레인 — 어느 칸이든 비면 돎

- **`DM_FALLBACK=on` 이면** — 사다리(`dmLadder`)가 다 막혔을 때만 안 돎(`drainBlocked`), 꺼져 있으면 예전대로 Claude 만 봄
  - 30분 쓸어 보기도 같은 판정으로 쉼
- **다시 돌린 차례가 처리기 앞에서 돌아오면**(작업 디렉터리 없음 등) 결과는 「못 함」 — 「다시 돌림」으로 안 닫고 시도만 셈
- **[실행] 버튼** — 겹 누름은 한 번만 돌림(첫 await 앞에서 잡음)
- **재시작 알림** — 이 기동 전에 시작한 처리 중 기록만 끊김으로 봄, 기동 뒤 시작한 차례의 기록은 남김
- **떠 보기** — Claude 가 맡을 칸일 때만 실행
- **맡을 칸이 없는 건은 남김**(`drainSkip`) — 첨부, 개인 글, 「Claude·GPT 몫」은 agy 만 남은 동안 시도를 안 세고 남김
- **⏸ 안내의 「가장 빠른 회복에 처리」** — 이제 참(어느 칸이 풀려도 회복 타이머가 드레인을 부름)
- **옛 드레인(`HOLD_V2` 꺼짐)** — 그대로 Claude 만 봄

### 예약 일 — 넷만

- **받는 일** — 카드 요약(글), 회의 알림 판단(글), 지금 집중할 것, 아침 브리핑(`SpawnOpts.agyRung`)
  - 무거운 분석은 안 받음(제 재시도와 미룸이 있음)
- **회의 알림 판단의 답** — JSON 목록이 아니면 「못 함」(비교 기준을 안 옮겨 다음 폴링이 다시 판단), 같은 변경에 세 번 이어지면 알림 없이 받음(메모리에서 셈)
  - 사다리가 길어 한 차례가 5분 주기를 넘길 수 있어 폴링은 겹쳐 돌지 않음(도는 중이면 건너뜀)
- **순서** — codex(대응표 모델) 다음 Gemini 다음 agy Claude, 켜는 문이 꺼져 있으면 예전 사다리 그대로
- **지금 집중할 것** — `tasks.py json --slim` 을 재료로 한 줄(JSON)을 받고, 허용 목록 문을 지나 봇이 `tasks.py focus` 를 셸 없이 돌림(`ASSISTANT_MODE=focus` 라 자동 표시)
- **아침 브리핑** — `tasks.py brief` 출력을 재료로 본문만(읽기만), 한도와 오류 글은 예전처럼 브리핑으로 안 올림

### 연습 — D2, D3, D5

- **D2(Claude, GPT 막힘 → Gemini)** — `{"claude":"usage","codex":"usage","expiresAt":<지금+600>}` 를 놓고 DM 한 줄
- **D3(Gemini 도 막힘 → agy Claude)** — 위에 `"agyGemini":"usage"` 를 더함, 다 막힘은 `"agyClaude":"usage"` 까지
- **D5(회복과 드레인)** — 연습 파일을 지우면 남은 막힘은 `drillBlockUntil` 까지, 그때 회복 타이머가 드레인을 부름

검사 `npm run check:dmfallback`, `npm run check:agy`
