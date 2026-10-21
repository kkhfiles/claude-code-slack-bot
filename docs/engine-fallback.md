# DM 폴백 — Claude 가 막히면 GPT → agy Gemini → agy Claude Sonnet 이 이어 받음

**DM 폴백을 고치거나 켜기 전에 읽는 참고** — 엔진 폴백 5단계와 6단계(2026-10-14), 켜는 문은 `DM_FALLBACK=on`(GPT)과 `DM_FALLBACK_AGY=on`(agy 두 칸), 요약은 `AGENTS.md` 「DM 폴백」

- **원칙**(사용자 결정 2026-10-14) — 멈추는 것보다 품질이 조금 떨어져도 이어 가는 쪽
- **사다리** — Claude → GPT(codex) → agy Gemini → agy Claude Sonnet → 모아 두고 회복 때 처리
  - 칸 차례의 정본은 llm-playbook `models.json` 의 `ladders.dm`(아래 「칸 차례 — 사다리 표 `ladders`」)
  - agy 두 칸은 `DM_FALLBACK_AGY=on` 일 때만 — 「6단계 — agy 두 칸」 절
- **폴백 모델** — llm-playbook `models.json` 의 `service_fallback`(아래 「폴백 모델 — 서비스 폴백 대응표」)
- **꺼져 있으면** — 예전 그대로(막히면 한도 안내를 내고 모아 둠)

## 고르기 — `pickEngine`

| 상황 | 고름 |
|---|---|
| 채널, 계획 모드(`-plan`), 세션 직접 잇기(`-r <id>`, `-continue`) | 늘 Claude, 막혔으면 모아 둠 |
| 작업 디렉터리가 업무 비서 뿌리가 아님 | 늘 Claude, 막혔으면 모아 둠 |
| 엔진 상태가 Claude 막힘이라고 함 | Claude 를 안 띄우고 GPT, GPT 도 막혔으면 모아 둠 |
| Claude 가 도는 중에 한도나 과부하로 끝남 | GPT(쓰기가 돌았어도), GPT 도 막혔으면 모아 둠 |
| Claude 의 보통 오류 | 안 넘김(예전 오류 길) |

- **넘기는 차례** — 사람 DM, 판에서 온 말, 메일 후보, DM 에서 받아 모아 둔 것을 다시 돌림
- **개인 글 조각이 든 말도 넘김**(2026-10-19 실장 확인) — 세 구독(Claude Code, Codex, agy) 모두 학습에 안 쓰게 설정돼 있어, 그 대화를 맡는 엔진에 보내는 것은 「나간다」가 아님(`AGENTS.md` 「개인 글」)
  - 걷은 것 — 차례 앞 개인 글 검사, 보낼 글 전체 재검사(GPT 칸, agy 칸), 드레인이 개인 글 건을 남기던 것(`drainSkip`)
  - 그대로인 것 — 방과 다른 사람 DM 으로 나가는 답의 개인 글 문(`src/privacy-guard.ts`), 활동 기록 가림, 못 본 대화방 글에서 조각이 든 글 빼기(`dm-context.ts`, Claude 차례와 같음)
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
- **넘겨줄 메모** — 머리 「이미 한 것 — 다시 하지 말 것 · 결과를 못 받은 것은 확인부터 · 실패한 것은 결과를 확인하고 다시 해도 됨」
  - 줄마다 세 갈래(2026-10-15 검토) — `완료` · `실패(다시 해도 됨 — 결과를 확인)` · `결과 모름 — 먼저 확인`
  - `실패` 는 결과가 오류로 돌아온 것 — Claude 는 `tool_result.is_error`, GPT 는 명령의 종료 코드 · 상태(`failed` · `declined`), agy 는 `tasks.py` rc
  - 보류 칸(`done_steps`)의 줄 머리도 같음(`완료` · `실패` · `결과 모름`, agy 가 못 돌린 명령은 `안 함`) — 옛 기록의 두 낱말은 그대로 읽힘
- **환경 변수**
  - `WORK_ASSISTANT_CAPTURE=<캡처 id>` — 값으로 넘김(방마다 하나인 가리킴 파일은 다음 차례가 갈아 끼움)
  - `CLAUDE_BOT_SESSION=1` — codex 시작 훅이 투영 동기화를 건너뜀
  - `WORK_ASSISTANT_DEFER_COMMIT=<임시 파일>` — 볼트 커밋을 봇에 미룸(아래 「볼트 커밋 — GPT 차례도 같은 메시지」)
- **실행 조건**
  - 쓰기 모래상자(`--approve-for-me`)와 기존 쓰기 폴더
  - 작업 폴더는 업무 비서 뿌리
  - 모델은 서비스 폴백 대응표(아래 「폴백 모델 — 서비스 폴백 대응표」), 표에 그 칸이 없으면 같은 등급(`sameTier`)이나 기본 모델
  - 깊이는 대응표의 칸이 정함 — 1차의 깊이(대화 차례는 low) 줄의 「별칭-깊이」
  - 상한 180초
  - GPT 가 못 하면 다음 칸(agy)이 있을 때 그리로 넘기고, GPT 가 돌린 명령은 「이미 한 것」으로 넘어감
- **같은 방은 한 줄로** — `ChannelGate.acquire`
  - 새 DM 은 문에서 기다림(⏳), GPT 차례를 끊지 않음
  - 원문 캡처는 문에서 기다리기 전에 함(말 하나에 캡처 하나) — 기다리는 사이 재시작해도 말이 남음
  - 기다리는 동안에도 처리 중 기록을 둠(`wait:<캡처 id>` · `state: waiting`) — 재시작에 끊기면 기동이 `interrupted` 로 적어 드레인이 줍는다(2026-10-15 검토). 차례가 뜨면 그 차례의 기록으로 넘어감
  - 다시 돌리는 차례는 드레인이 잡은 문이라 따로 안 잡음
- **`-stop`** — 손잡이를 `activeProcesses` 에 걸어 둠, 끊으면 실패 표시 없음
  - `-stop` 과 `-reset` 은 차례와 같은 키로 찾음(DM 맨 위는 `direct`)
  - 다시 돌리던 차례를 끊으면 그 캡처를 버림 — 남기면 다음 드레인이 대체 칸이 한 명령을 모르는 채 또 돌림
  - Claude 가 돌던 다시 돌리기도 같음(2026-10-15 검토) — 끊은 차례는 다음 칸으로도 안 넘김
- **재시작에 끊김** — 처리 중 기록에 「GPT 명령 — 무엇을 했는지 모름」(쓰기)을 넣어 둠, 보류 v2 가 `partial` 로 이어 감
  - 지난 기동의 처리 중 기록은 생성자에서 떠 둠(`snapshotBootInflight`) — 알림(기동 12초 뒤) 전에 같은 열쇠(DM 맨 위는 `direct`)의 새 차례가 덮어도 끊긴 차례를 잃지 않음

## 월 API 크레딧 칸 — `runClaudeApiFallback`(2026-10-21 사용자 결정)

- **무엇** — 구독 Claude 가 막힌 DM 차례를 GPT 보다 먼저 받는 칸. 모델은 Claude API 의 Sonnet
- **비용** — Max 구독에 딸린 월 API 크레딧(Max 5x 는 $100, 이월 없음)

- **켜는 법** — `models.json` 의 `ladders.dm` 에서 `claude` 바로 다음에 `claude_api` 칸을 넣음. 표에 없으면 이 칸은 안 돎
- **세션** — 이 차례의 Claude 옵션(규칙 파일, 도구, 권한, 슬랙 표면 안내)을 그대로 쓰는 새 세션
  - 모델은 `sonnet` 고정(Opus 를 쓰던 차례도 Sonnet)
  - 원래 세션을 잇지 않음. 긴 세션을 다시 보내면 그 길이만큼 크레딧이 듦
  - 미리 띄운 세션과 엔진 연습은 안 씀(둘 다 구독 환경으로 뜸)
  - 프롬프트는 GPT 칸과 같음(넘겨줄 메모, 못 본 대화방 글, 사람 말)
- **키** — `~/.config/llm-playbook/.anthropic-api-key`(llm-playbook 과 같은 파일, 시험은 `CLAUDE_API_KEY_FILE`)
  - `withApiKey()` 가 키를 넣고 `CLAUDE_CODE_OAUTH_TOKEN` 과 `ANTHROPIC_AUTH_TOKEN` 을 뺌
  - 키를 넣는 위치는 `sdk-handler.ts` 의 `billing: 'api'` 갈래 하나, 세션을 띄우는 위치는 이 함수 하나(검사 `check:noaccounts`)
- **엔진 상태** — `claude-api` 열쇠에 따로 적음(`ClaudeTap` 의 엔진 인자). 구독 Claude 의 막힘을 지우지 않음
- **상한** — 차례당 $1(`maxBudgetUsd`)과 6분. 지출 상한은 호출이 끝난 뒤에 재므로 한 호출만큼 넘을 수 있음
- **못 했을 때** — 다음 칸(GPT)으로 넘기고, 이 칸이 돌린 도구는 「이미 한 것」으로 함께 넘김
  - 크레딧 소진(「Credit balance too low」) — 사용량 막힘, 시각 모름(한 시간 뒤 다시 봄)
  - 키 파일 없음 또는 모양이 틀림 — 띄우지 않고 인증 막힘
  - 차례 상한, 시간 초과, 오류, 빈 답 — 막힘으로 적지 않음(다음 차례에 다시 씀)
- **표시 줄** — 「↪ Claude API(Sonnet) 가 답함 · <왜 Claude 가 아닌가>」
- **크레딧 적용 확인**(2026-10-21) — API 키로 띄운 Agent SDK 세션이 `apiKeySource: ANTHROPIC_API_KEY` 로 답함. 공식 문서는 Agent SDK 를 적용 대상, Claude Code 를 제외 대상으로 적음
- **비용 실측**(2026-10-21) — 봇과 같은 설정의 세션은 첫 호출에 약 11만 5천 토큰을 1시간 캐시에 씀
  - Haiku 진단 1건 $0.115(프롬프트 10만 토큰 초과 단가 $0.50 에 캐시 기록 2배)
  - Sonnet 5.5 추정 — 첫 호출 약 $0.46(입력 $2/MTok 에 2배), 뒤 호출은 캐시 읽기로 약 $0.02씩
- **검사** — `check:dmfallback` 「월 API 크레딧 칸」 장면(답함, 크레딧 소진 뒤 GPT, 막힌 칸 건너뜀, 상한 뒤 넘겨줄 메모, 키 파일 없음, 세션을 잇지 않음)

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
  - 넘기지 않는 차례(채널, 계획, 다른 작업 디렉터리)와 폴백이 꺼진 때도 같음 — 한도 안내(막힘마다 한 번)가 대신 알림
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
- **때** — 막힘이 바뀔 때마다 확인
- **넘길 수 있는 DM 차례 안에서는 미룸**(2026-10-16) — 차례가 끝날 때 한 번 확인(`EngineNotice.hold`)
  - 한 차례가 여러 칸을 내려가도 실제로 답한 엔진 한 줄만 나감(다 막혔으면 ⏸ 한 줄)
  - 거쳐 간 칸은 그 줄의 「… 소진」 목록에 들어 있음
  - 미루는 동안 차례를 안 적으므로 잃는 안내 없음, 차례가 넘어져도 15분 뒤 스스로 풀림
  - 차례 밖의 변화(회복 등)는 바로 나감
- **되풀이** — 같은 바뀜은 한 번만
- **다 막혀 모아 둔 차례의 끝 모양**(2026-10-16) — 아래 세 조건을 모두 채우면 ⏳ 한도 안내와 「취소」 버튼을 안 올림
  - 조건 — `ENGINE_NOTICE=on`, 비서 DM, 엔진 상태로 사다리 전체가 막힘
  - 상태 줄 — 「❌ 오류 발생」 대신 「⏸ 모아 둠」(지우지 않음)
  - 반응 — ❌ 대신 ✋
  - 실패 표시와 장부 — 바뀌지 않음
  - 조건 밖(꺼짐, 채널, 칸 실패로 모아 둠) — 예전과 같이 ⏳ 한도 안내
- **GPT 이름** — DM 차례가 실제로 부를 모델(DM 방의 모델 · `serviceCodex`), 표에 칸이 없으면 GPT 칸이 마지막으로 부른 모델(`engineNoticeLabels`)
- **「✅ Claude 회복 — 돌아왔습니다」** — 막힘 시각이 지난 것만으로는 안 보냄. 그 뒤 처음으로 된 Claude 차례(`recordOk`)가 막힘 기록을 지울 때 한 번(2026-10-15 검토)
  - 그사이에는 차례도 안 적음 — 되기 전에 다시 막히면 아무 줄도 안 나감

## 엔진 상태 공유 — 파이썬과 같은 파일(2026-10-19)

- **같이 쓰는 쪽** — 봇(`src/engine-state.ts`)과 llm-playbook(`llm_playbook/engine_state.py`, 배치와 사다리 `ladder.ask` 가 씀)
  - 파일 — 봇의 `.engine-state.json` 그대로(형식 v1)
  - 파이썬이 자리를 아는 길 — 사용자 설정 `engine_state` 또는 환경 변수 `LLM_PLAYBOOK_ENGINE_STATE`(둘 다 없으면 파이썬 쪽 기능이 꺼짐)
  - 까닭 — 봇만 막힘을 알 때 배치가 주간 한도에 막힌 Claude 를 밤새 불렀음(10/19 02:18~10:00)
- **쓰기 규약(두 쪽이 같음)** — `<파일>.lock` 을 `O_CREAT|O_EXCL`(노드는 `'wx'`)로 잡고(안에 pid) 다시 읽고 → 고치고 → 임시 파일에 써서 바꿔 끼움
  - 묵은 잠금 — 30초 넘으면 죽은 프로세스의 것으로 지움(`LOCK_STALE_MS`)
  - 바꿔 끼우기를 윈도가 거절하면 25번까지 다시 해 봄
  - 잠금 대기 — 봇 1초(`LOCK_WAIT_MS`), 파이썬 2초. 봇은 기다리는 동안 이벤트 고리가 서므로 짧게 둠
- **fail-open** — 못 잡거나 못 쓰면 기록만 건너뜀(WARN 한 줄). 부르는 쪽은 고친 값으로 답을 받고 차례는 그대로 감
- **깨진 파일은 덮어쓰지 않음** — 읽기는 빈 상태(막힌 것 없음)로 보고 쓰기는 건너뜀
  - 손으로 고칠 때까지 봇과 파이썬 모두 기록을 못 함(WARN 이 남음)
- **모르는 열쇠를 지우지 않음** — 읽은 그대로 되씀
  - 대상 셋 — 파이썬만 쓰는 엔진 열쇠 `agy-argon`, 윗단의 모르는 칸, 아는 엔진 기록 안의 모르는 칸
  - 봇의 사다리와 회복 시각과 안내는 아는 네 엔진만 봄
- **남이 쓴 변화를 듣기** — `startWatch`(기동 때 `startEngineWatch` 가 켬)가 30초마다 파일의 수정 시각과 크기를 봄(`WATCH_MS`)
  - 바뀌었고 아는 엔진의 막힘 지문이 마지막으로 본 것과 다르면 같은 알림(`subscribe`)을 냄 → 회복 타이머가 다시 걸리고 엔진 안내가 다시 봄(미루는 차례가 있으면 안내는 `hold` 대로 미룸)
  - 내 쓰기로는 다시 안 알림 — 쓸 때 지문을 적어 둠(되먹임 없음)
  - 깨진 파일은 「다 풀림」이 아니라 「모름」이라 건너뜀
  - 고르기(`isBlocked`)는 부를 때마다 파일을 읽으므로 30초를 안 기다림 — 늦는 것은 안내와 회복 타이머뿐
- **막힘 판정도 같은 시료로 시험** — llm-playbook `tests/limit_samples.json` 을 `check:limitsamples` 가 읽음(그 저장소가 없으면 건너뜀)
  - 봇 쪽에서 맞춘 것 — Claude 오류 글과 codex 오류 글 모두 이벤트 이름(`rate_limit_event`, `rate_limit_info`, `rateLimit…`)을 지우고 읽음(`stripEventNames`)
  - 봇은 로그인(auth)을 안 가름 — auth 시료는 막힘 아님으로 읽음
- **검사**
  - `npm run check:engineshare` — 두 언어 왕복, 동시 150번씩 써도 잃는 기록 0. 파이썬을 못 부르면 그 절만 건너뜀
  - `npm run check:limitsamples`

## 볼트 커밋 — GPT 차례도 같은 메시지(2026-10-19)

- **바꾸기 전 문제** — codex 쓰기 모래상자(`workspace-write`)가 쓰기를 연 폴더 안에서도 `.git` 을 읽기 전용으로 둠
  - GPT 차례마다 `tasks.py` 의 `_vault_commit` 이 실패했고, GPT 가 그 경고를 「Git 커밋은 실패했습니다」로 사람에게 전함(거짓 경보)
  - 차례 뒤 봇이 대신 커밋했지만 메시지가 `[GPT 대신 커밋] DM 폴백` 하나뿐이라 Claude 차례의 커밋과 모양이 달랐음
- **미룬 커밋** — 쓰기 차례마다 `codexTurn` 이 임시 폴더에 파일 하나(`wa-cx-<id>.commits.txt`)를 정하고, codex 환경에 `WORK_ASSISTANT_DEFER_COMMIT` 으로 넘김
  - `tasks.py` 는 그 값이 있으면 git 을 부르지 않고 메시지를 그 파일에 한 줄 적음
  - 표준 오류에는 경고가 아닌 안내 한 줄(「· 볼트 커밋은 차례가 끝나면 봇이 대신 합니다」)
  - 읽기 전용 차례에는 넘기지 않음
  - 임시 폴더를 쓰는 까닭 — codex 쓰기 모래상자가 그곳의 쓰기를 허용함(`codex sandbox` 로 확인: 임시 폴더 쓰기 성공, 홈 폴더와 `.git` 쓰기 차단, 환경 변수 전달됨)
- **차례 뒤 커밋**(`commitVaultAfterCodex`) — 바뀐 것이 있을 때만 커밋
  - 메시지 — 미룬 줄을 이어 붙인 `[GPT] TSK-114 새 업무 — … · [메일 판정] 갱신`
  - 앞머리 `[GPT]` 로 출처 표시, 바로 앞과 같은 줄은 하나로 합침, 200자에서 자름
  - 파일이 비었거나 없으면 예전 일반 메시지 `[GPT 대신 커밋] <이름>`
  - 파일은 커밋 뒤 지우고, 오류를 던지지 않음
  - 미룬 줄이 있으면 이벤트를 못 봤어도(`writeRan` 거짓) 커밋함
- **남은 변경 커밋 — 안전망**(`commitVaultLeftovers`, 예약 타이머 `vaultSweepTimer`, 10분 간격)
  - 대신 커밋이 실패했거나 차례가 중간에 죽어 남은 변경을 `[남은 변경] 봇이 모아 커밋` 으로 커밋하고 INFO 로그 한 줄을 남김
  - codex 쓰기 차례가 도는 중이면 건너뜀(`busy`) — 끝나면 그 차례가 미룬 메시지로 커밋함
  - `index.lock` 이 있으면 건너뜀(`locked`) — 묵은 잠금도 지우지 않음
  - 업무 비서가 켜져 있을 때 `scheduleAll()` 이 걸고 `clearAllTimers()` 가 지움, 쉬는 날에도 실행
  - git 환경은 대신 커밋과 같은 함수(`vaultGit`)로 만듦 — `GIT_DIR` 류를 지우고 자격 증명 창을 띄우지 않음
- **Claude 차례와 agy 차례는 그대로** — 모래상자 밖이라 `tasks.py` 가 쓰기마다 직접 커밋함
- **검사**
  - `npm run check:sessionfb` — 예약 세션 폴백과 쓰기 차례에 파일 전달, 읽기 전용 차례에는 미전달, 미룬 줄이 커밋 메시지가 됨, 빈 파일은 일반 메시지, 파일 삭제, 남은 변경 커밋(잠금과 도는 중 건너뜀, `GIT_DIR` 제거)
  - `npm run check:dmfallback` — DM 폴백의 GPT 에 파일 전달
  - `npm run check:timers` — 타이머 짝(지움, 다시 걺, 한 차례 함수 호출)
  - 업무 비서 저장소 `bin/selftest.py` — 값이 있으면 git 호출 없이 한 줄씩 쌓이고, 값이 없으면 예전대로 커밋

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
  - 부서 대화 봇(파이썬 `chatbot/turn.py`)도 `scope: "all"` 일 때만 받음 — `agyGemini`, `codex`, `claude` 갈래와 막힘 길이는 이 절과 같음
- **막힘 길이** — 20분 뒤와 연습 파일의 `expiresAt` 중 이른 쪽(`drillBlockUntil`). 파일을 일찍 지우면 남은 시간만큼 엔진 상태에 남음(그동안 DM 은 Claude 를 건너뜀)
- **로그** — 주입할 때마다 WARN 한 줄

## `-engines`

- **머리 한 줄** — DM 폴백, agy 칸, 엔진 안내, 연습 상태
- **엔진 다섯 줄** — 막힘, 풀리는 시각, 마지막 성공, 5시간과 7일 사용률, 사다리 밖 표시(순서는 사다리 순서)
- 버튼 없음

## 칸 차례 — 사다리 표 `ladders`(2026-10-19)

- **정본** — llm-playbook `models.json` 의 `ladders`. 봇은 그 가운데 `dm` 과 `scheduled` 를 읽음(`src/model-ladder.ts` 의 `serviceLadder`)
  - `dm` — DM 차례(`dmLadder`, 엔진 안내와 `-engines`, 드레인이 이것을 봄)
  - `scheduled` — 예약 일의 agy 칸 차례(`agyRungOrder`, 카드 요약과 아침 브리핑과 지금 집중할 것과 회의 알림 판단)
- **지금 값** — 두 사다리 모두 `claude` → `codex` → `agy:flash-high` → `agy:sonnet-low`
  - 별칭 없는 `claude` 와 `codex` 칸의 모델은 `service_fallback` 대응표가 정함(아래 「폴백 모델」 절)
- **칸 → 엔진 열쇠** — `claude`, `codex` 는 그대로. `claude_api`(별칭 없음 또는 `sonnet`)는 `claude-api`. agy 칸은 별칭의 표시 이름(`agy.models`)으로 가름
  - 「Claude …」 → `agy-claude`
  - 「Gemini …」(Argon 제외) → `agy-gemini`
  - Argon 과 모르는 별칭은 봇이 맡지 못하는 칸이라 아래 「못 읽으면」으로 감
- **켜는 문은 그대로** — `DM_FALLBACK` 이 꺼지면 Claude 하나, `DM_FALLBACK_AGY` 가 꺼지면 표에 agy 칸이 있어도 뺌
- **고치는 법** — 표에서 칸을 빼거나 순서를 바꿈. 봇은 파일 수정 시각이 바뀌면 다음 차례에 다시 읽음(재시작 불필요)
  - agy 칸의 별칭은 `service_fallback.agy` 에 있는 것만 받음(파이썬 검사가 막음). 호출에 쓰는 별칭과 표시 이름은 그 칸에서 읽음
- **못 읽으면** — 표 없음, 깨진 JSON, 사다리 없음, 첫 칸이 Claude 가 아님, 모르는 칸, 같은 엔진 두 번 중 하나면 기본 차례로 돎(DM 을 멈추지 않음)
  - 기본 차례는 2026-10-19 까지 박혀 있던 값(`src/engine-ladder.ts` 의 `DM_LADDER_AGY`)
  - 까닭마다 WARN 한 번 — 그동안은 표를 고쳐도 안 따라옴
  - 첫 칸이 Claude 여야 하는 까닭 — 고르는 함수가 Claude 다음 칸부터 찾음(세션과 모아 둔 차례가 Claude 에 묶여 있음)
- **사용자 설정은 못 봄** — 봇은 패키지 기본값 파일(`LLM_PLAYBOOK_MODELS` 가 있으면 그것)을 직접 읽음. `~/.config/llm-playbook/config.json` 의 `ladders` 덮어쓰기는 파이썬만 따름
- **나머지 사다리** — `batch`, `chat`(부서 대화 봇), `review`(교차 검증) 와 `reserve`(배치와 대화 봇이 GPT 5시간 통을 덜 쓰게 함)는 파이썬 `llm_playbook.ladder.ask(…, ladder=이름)` 몫이라 봇은 안 읽음
  - `chat` 을 켜는 문은 이 봇의 `.env` 에 있는 `CHATBOT_FALLBACK=on`(기본은 꺼짐). 대화 호스트(`src/chat-host.ts`)가 환경을 그대로 물려주므로 봇 코드에는 읽는 곳이 없음
- **검사** — `npm run check:servladder`. 지금 표가 오늘 차례인지, 칸을 빼면 따라오는지, 이상한 표에서 기본 차례로 도는지, 파이썬이 보는 차례와 같은지 확인

## 폴백 모델 — 서비스 폴백 대응표

- **정본** — llm-playbook `models.json` 의 `service_fallback`(`src/model-ladder.ts` 의 `serviceCodex`), `tiers` 가 아님
- **codex 칸** — 1차 Claude 모델의 집안(opus, sonnet, haiku)과 사고 깊이마다 GPT 「별칭-깊이」 하나(사용자가 정한 대응표)
  - 별칭이나 id(`[1m]` 꼬리 포함)로 와도 맞춤
  - 실제 모델 id 는 `codex.models[별칭].id`

| 1차 | low | medium | high | xhigh | max |
|---|---|---|---|---|---|
| opus | sol-low | sol-high | sol-high | sol-xhigh | sol-max |
| sonnet | sol-low | sol-low | sol-medium | sol-high | sol-xhigh |
| haiku | luna-medium | luna-high | luna-high | sol-low | sol-low |

- **깊이를 모르면** — high 줄(Claude 기본 깊이 · `PRIMARY_DEFAULT_EFFORT`)
- **xhigh 와 max 는 1차가 명시할 때만** — 사람이 시키지 않은 깊이를 대응표가 고르지 않는다(2026-10-20 사용자 결정). haiku 의 high 줄이 luna-xhigh 였던 것을 luna-high 로 낮췄다. 회의 알림 판단(`calendar-poller.ts`)처럼 깊이를 안 넘기는 호출이 이 줄을 읽는다
- **옛 모양**(집안마다 별칭 하나 + `effort_up`) — 그 표가 오면 예전처럼 1차 깊이를 `effort_up` 만큼 올림. 지금 정본은 위 대응표
- **쓰는 곳** — DM 의 GPT 칸, 예약 일 폴백(`spawnOrFallback`), 도구 없는 사다리의 codex 칸, 판의 좁은 길
  - 좁은 길은 `BOARD_NARROW_CODEX_MODEL`, `BOARD_NARROW_CODEX_EFFORT` 가 먼저
- **agy 칸의 별칭** — `service_fallback.agy` 의 앞이 Gemini 칸, 뒤가 agy Claude 칸(1차 모델과 무관). 칸의 차례는 `ladders` 가 정함
- **표에 칸이 없으면** — 예전 그대로(같은 등급 `sameTier`, 기본 모델), WARN 한 번
- **`after_agy`** — `sol-low`(agy 두 칸을 다 못 쓸 때) · 부서 대화 봇 몫이라 이 봇은 안 읽음

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
- **프롬프트** — 이 칸의 규칙(`AGY_DM_RULES`), 지금 시각, 열린 업무 전부(`tasks.py json --slim`), 체크인 번호표, 넘겨줄 메모, 못 본 대화방 글, 메일 본문(메일 후보 차례만), 사람 말
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
| `mail_judge` | subject, from, proposed, decided, by, task, note | 이 차례에 온 메일 제목이 아닌 것, 혼자 정했는데 decided 를 채운 것 |

- **메일 후보 차례**(`[메일] 후보 N건`, 2026-10-19) — 전에는 agy 가 메일함을 못 읽어 이 차례를 보류(10/16 1건)
  - 봇이 후보 글에서 제목을 뽑아 `mail.py show`(읽기 전용, 셸 없이)로 스레드마다 최근 세 통의 앞부분을 읽고 `[메일 본문]` 덩이로 붙임(9,000자 상한, 실측 7.2초)
  - 후보 글은 제목을 70자로 자르므로 `show` 가 앞부분으로 찾아 실제 제목을 돌려주고, `mail_judge` 는 그 실제 제목으로 남김(다음 후보의 「지난 판정」에 붙게)
  - 본문을 못 읽으면 덩이 없이 넘기고 규칙이 물음으로 돌림
  - 사람이 다음 DM 에서 답한 차례는 제목이 글에 없어 `mail_judge` 를 거절하고 Claude·GPT 몫으로 남김
  - 실행은 `bin/mail.py judge` — 같은 캡처 환경이라 다 정해지면 캡처가 닫힘

- **공통** — 모르는 칸, 날짜가 `YYYY-MM-DD` 가 아님, 한 줄 칸의 줄바꿈과 제어 문자, 한 번에 8개 넘음 → 「실행하지 않은 명령」
  - `update` 의 칸 이름은 목록의 제 칸만 받음(`constructor`, `__proto__` 같은 원형 이름은 거절)
- **실행** — `python -X utf8 bin/tasks.py <명령> --이름=값 …`(`mail_judge` 는 `bin/mail.py judge`), 셸 없이(값에 `&`, `|`, `$(…)` 가 있어도 글자 그대로)
  - 환경 변수 `WORK_ASSISTANT_CAPTURE=<캡처 id>`, `CLAUDE_BOT_SESSION=1`, API 키 뺌
  - 앞 명령이 실패하면 뒤는 안 돌림
  - 값의 뜻(상태 낱말, 칸 이름)은 파이썬 문(`_check_sets`)이 한 번 더 봄
  - **명령 하나가 끝날 때마다 처리 중 기록에 적음 — 다음 명령을 띄우기 전에**(`onDone` · 2026-10-15 검토). 재시작에 끊겨도 앞서 끝난 명령이 「이미 한 것」에 남음
- **하나라도 안 됐으면 「됨」이 아님**(2026-10-15 검토) — 실패, 허용 목록 밖, 앞이 실패해 안 돈 명령이 있으면
  - 답 · 실행한 것 · 실행하지 않은 명령 뒤에 「⏸ 못 한 명령은 Claude·GPT 가 돌아오면 이어서 처리합니다」
  - `needs_full` 과 같은 길로 모아 둠(`needs: full` · 명령이 돌았으면 `partial`) — 보류 칸에 돈 것은 `완료`/`실패`, 안 돈 것은 `안 함`
  - 다시 돌리던 차례면 「다시 돌림」으로 안 닫힘(결과가 막힘)
- **명령 사이에 `-stop`** — 남은 명령은 안 돌리고 결과는 끊김(`stopped`), 돈 것은 「실행한 것」으로 보임

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
- **Claude 세션이 없어도 이어 감**(2026-10-15 검토) — 보류 칸의 「이미 한 것」(`done_steps`)을 세션과 따로 싣고(`buildHoldExtra`), 파이썬 `drain_list` 가 세션이나 이미 한 것 중 하나만 있어도 다시 돌림(`_hold_carries`)
  - 새 차례로 돌되 「이미 한 것 — 다시 하지 말 것」 메모를 실음(`replayNote` · `heldSteps`) — 닫힌 캡처도 같음
  - 전에는 GPT · agy 가 쓴 뒤 끊긴 것이 사람 목록으로만 갔다

### 드레인 — 어느 칸이든 비면 돎

- **`DM_FALLBACK=on` 이면** — 사다리(`dmLadder`)가 다 막혔을 때만 안 돎(`drainBlocked`), 꺼져 있으면 예전대로 Claude 만 봄
  - 30분 쓸어 보기도 같은 판정으로 쉼
- **다시 돌린 차례가 처리기 앞에서 돌아오면**(작업 디렉터리 없음 등) 결과는 「못 함」 — 「다시 돌림」으로 안 닫고 시도만 셈
- **[실행] 버튼** — 겹 누름은 한 번만 돌림(첫 await 앞에서 잡음)
- **재시작 알림** — 이 기동 전에 시작한 처리 중 기록만 끊김으로 봄, 기동 뒤 시작한 차례의 기록은 남김
- **떠 보기** — Claude 가 맡을 칸일 때만 실행
- **맡을 칸이 없는 건은 남김**(`drainSkip`) — 첨부, 「Claude·GPT 몫」은 agy 만 남은 동안 시도를 안 세고 남김
- **목록은 넉넉히 읽고 상한은 돌린 건수에**(2026-10-15 검토) — 후보를 `PENDING_WINDOW`(50)건 읽고, `DRAIN_MAX` 는 실제로 돌린 건수에 걺. 전에는 앞의 다섯 건만 읽어 그것들이 남겨지면 뒤의 돌릴 수 있는 건이 영영 목록에 안 들었다
- **⏸ 안내의 「가장 빠른 회복에 처리」** — 이제 참(어느 칸이 풀려도 회복 타이머가 드레인을 부름)
- **옛 드레인(`HOLD_V2` 꺼짐)** — 그대로 Claude 만 봄

### 예약 일 — 넷만

- **받는 일** — 카드 요약(글), 회의 알림 판단(글), 지금 집중할 것, 아침 브리핑(`SpawnOpts.agyRung`)
- **도구가 돈 뒤 실패한 회차**(`spawnOrFallback` · 2026-10-15 검토) — 읽기 도구만 돌았으면 넘김(다시 읽을 뿐). 쓰기를 할 수 있는 도구(`isWriteTool` — `Bash` 포함)가 하나라도 돌았거나 몇 번인지 모르면 안 넘김(제 재시도와 미룸이 받음)
  - 무거운 분석은 안 받음(제 재시도와 미룸이 있음)
- **회의 알림 판단의 답** — JSON 목록이 아니면 「못 함」(비교 기준을 안 옮겨 다음 폴링이 다시 판단), 같은 변경에 세 번 이어지면 알림 없이 받음(메모리에서 셈)
  - 사다리가 길어 한 차례가 5분 주기를 넘길 수 있어 폴링은 겹쳐 돌지 않음(도는 중이면 건너뜀)
- **순서** — codex(대응표 모델) 다음 Gemini 다음 agy Claude, 켜는 문이 꺼져 있으면 예전 사다리 그대로
- **지금 집중할 것** — `tasks.py json --slim` 을 재료로 한 줄(JSON)을 받고, 허용 목록 문을 지나 봇이 `tasks.py focus` 를 셸 없이 돌림(`ASSISTANT_MODE=focus` 라 자동 표시)
- **아침 브리핑** — `tasks.py brief` 출력을 재료로 본문만(읽기만), 한도와 오류 글은 예전처럼 브리핑으로 안 올림
- **회의 알림 판단과 좁은 길도 Claude 막힘을 먼저 봄**(2026-10-19) — `spawnOrFallback` 처럼 엔진 상태가 Claude 막힘이면 Claude 를 안 띄움
  - 회의 알림 판단(`calendar-poller.ts`) — 곧장 사다리(codex 다음 agy)로 감. 자체 「다음 정시」 멈춤은 걷음(10/19 08:00 과 09:55 에 이미 막힌 Claude 를 불렀음)
  - 한도를 적는 곳 — 결과로 온 한도는 전송 탭이 적고, 던진 오류(`thrownClaudeBlock`)와 탭이 못 본 결과(`currentClaudeBlock`)는 판단 쪽이 적음
  - 좁은 길(`narrowFromBoard`) — 곧장 codex 칸으로 감, 관찰 기록의 까닭은 `claude-blocked`
  - 검사 `check:calbase`, `check:narrow`

### 메일 후보 폴러

- **Claude 하나가 막혀도 돈다** — `DM_FALLBACK=on` 이면 사다리(`dmLadder`)가 다 막혔을 때만 쉼(2026-10-15 검토), 꺼져 있으면 예전처럼 Claude 만 봄
- **표시(워터마크)** — Claude 가 막혀 아무도 답하지 않은 차례는 안 옮기고 그 캡처를 버림(다음 회차가 다시 읽음). 다른 엔진이 답하고 「Claude·GPT 몫」을 남긴 차례는 옮김(그 캡처가 남은 몫을 들고 회복 때 돎 — 안 옮기면 10분마다 같은 답이 나감)
- ⚠️ **거슬러 읽는 것은 이레까지**(`mail.py` 의 `LOOKBACK_MAX`) — 쉬는 날까지 합쳐 이레 넘게 쉬면 그 앞 메일은 후보로 안 나옴(메일함에는 남음)

### 모델별 주간 한도 — 기록만(사용자 결정)

- 거절 이벤트는 갈래(`seven_day_opus` 등 모델별 주간 창 포함)를 안 가리고 Claude 하나를 통째로 막음(`engine-tap.ts` · 엔진 상태의 칸은 `claude` 하나)
- 그 동안 다른 Claude 모델(예: Sonnet)이 쓸 수 있어도 건너뛰고 다음 칸으로 감 — 고치지 않고 이 동작을 적어 둠

### 캡처 큐 대기실 — 잠금을 못 잡으면

- 봇(`captureToInbox`)과 파이썬(`inbox add`)은 `<inbox>.lock` 을 2초 기다리고, 못 잡으면 **잠금 없이 덧붙이지 않고** `inbox.spool/<id>.json` 에 둠(2026-10-15 검토 — 잠금을 쥔 쪽이 이미 읽었으면 덧붙인 줄이 다시 쓰기에 덮였다)
- 파이썬 `_inbox_read` 가 대기실까지 읽고(브리핑 · 드레인 · 미처리 목록이 바로 봄), 다음 잠긴 고치기(`_inbox_update`)가 합친 뒤 지움(같은 id 는 한 벌)
- ⚠️ 대기실을 아는 파이썬이 먼저 돌아야 함 — 옛 파이썬은 대기실을 안 읽어 그 캡처가 파이썬이 고쳐질 때까지 안 보임(잃지는 않음)

### 연습 — D2, D3, D5

- **D2(Claude, GPT 막힘 → Gemini)** — `{"claude":"usage","codex":"usage","expiresAt":<지금+600>}` 를 놓고 DM 한 줄
- **D3(Gemini 도 막힘 → agy Claude)** — 위에 `"agyGemini":"usage"` 를 더함, 다 막힘은 `"agyClaude":"usage"` 까지
- **D5(회복과 드레인)** — 연습 파일을 지우면 남은 막힘은 `drillBlockUntil` 까지, 그때 회복 타이머가 드레인을 부름

검사 `npm run check:dmfallback`, `npm run check:agy`
