# Claude Code Slack Bot

Slack에서 로컬 머신의 Claude Code를 원격으로 실행하고 결과를 받아보는 봇.
[mpociot/claude-code-slack-bot](https://github.com/mpociot/claude-code-slack-bot) 포크에 Windows 호환성 및 기능 개선을 추가.

## 주요 기능

- DM / 채널 멘션 / 쓰레드 대화 (세션 자동 유지)
- 스트리밍 응답 (실시간 메시지 갱신)
- 파일 업로드 (이미지, 텍스트, PDF, 코드 파일)
- CLI 세션 resume/continue (`-sessions`, `-resume`, `-continue`)
- 작업 디렉터리 관리 (디스크 영속화, 재시작 후 유지)
- 모델 선택 / 비용 제어 (`-model`, `-budget`, `-cost`)
- Plan 모드 (`-plan`) — 실행 없이 계획만 확인 후 실행 결정
- Safe/Trust 모드 — Bash 명령 승인 요청 또는 전체 자동 승인
- 실시간 진행 표시 (현재 실행 중인 도구명 표시)
- Rate limit 시 예약 메시지로 자동 재시도
- MCP 서버 연동
- AWS Bedrock / Google Vertex AI 지원 (선택)

### 포크 변경사항

- Windows 호환성 (permission MCP 서버 제외, `bypassPermissions`)
- 모든 명령어에 `-` 접두사 (`-cwd`, `-help`, `-sessions` 등)
- CLI 세션 resume/continue 지원 (Slack 외부에서 시작한 세션도 이어가기)
- 모델 선택, 비용 제한, 비용 조회
- Plan 모드: 계획만 보고 Execute 버튼으로 실행
- Safe/Trust 모드: Bash 승인 요청 vs 전체 자동 승인
- `-stop`: SDK `Query.interrupt()`로 정상 중단 (세션 상태 보존)
- 실시간 진행 표시 (`stream_event`로 현재 도구명 표시)
- Rate limit 감지 → Slack 예약 메시지로 자동 재시도 제안
- 작업 디렉터리 디스크 영속화 (`.working-dirs.json`)
- DM 쓰레드에서 `-cwd` 설정 시 DM 레벨 폴백 자동 생성
- pm2 기반 프로세스 관리 (`start.bat`, `stop.bat`)

## 사전 요구사항

- Node.js 18+
- Claude Code CLI 설치 및 로그인 (`claude login`)
- Slack 워크스페이스 관리자 권한

## 설치

### 1. 클론 및 패키지 설치

```bash
git clone https://github.com/kkhfiles/claude-code-slack-bot.git
cd claude-code-slack-bot
git checkout custom
npm install --ignore-scripts
```

> `--ignore-scripts`: `@anthropic-ai/claude-code` 패키지의 Windows 플랫폼 체크를 우회.

### 2. Slack App 생성

**각 사용자가 자신의 Slack App을 생성해야 합니다** (Socket Mode 특성상 앱당 하나의 연결만 유지).

1. [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From an app manifest**
2. 워크스페이스 선택 후 `slack-app-manifest.json` 내용 붙여넣기
3. 앱 생성 후:

**토큰 생성:**
- **OAuth & Permissions** → 워크스페이스에 앱 설치 → Bot User OAuth Token 복사 (`xoxb-...`)
- **Basic Information** → App-Level Tokens → `connections:write` 스코프로 생성 (`xapp-...`)
- **Basic Information** → Signing Secret 복사

### 3. 환경 변수 설정

```bash
cp .env.example .env
```

`.env` 편집:
```env
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_APP_TOKEN=xapp-your-app-token
SLACK_SIGNING_SECRET=your-signing-secret
BASE_DIRECTORY=P:\bitbucket
# DEBUG=true
```

> API 키 불필요: Claude Code SDK는 로컬 `claude login` 인증을 사용. Claude 구독(Pro/Max)에서 사용량 차감.

## 실행

[pm2](https://pm2.keymetrics.io/)로 백그라운드 실행. 별도 CMD 창 불필요, 크래시 시 자동 재시작.

```bash
npm install -g pm2   # 최초 1회

start.bat            # 빌드 → pm2로 시작 (이미 실행 중이면 재시작)
stop.bat             # 중지
```

### pm2 명령어

```bash
pm2 logs claude-slack-bot          # 실시간 로그 보기
pm2 logs claude-slack-bot --lines 50  # 최근 50줄
pm2 status                         # 프로세스 상태
pm2 restart claude-slack-bot       # 재시작
pm2 stop claude-slack-bot          # 중지
pm2 delete claude-slack-bot        # 제거
```

### Windows 재부팅 시 자동 시작

```bash
# 관리자 권한으로 실행 (최초 1회)
autostart-setup.bat
```

이 스크립트는 Windows Task Scheduler에 `pm2-resurrect` 작업을 등록합니다.
로그인 시 `pm2 resurrect`가 자동 실행되어 봇이 복원됩니다.

제거: `schtasks /delete /tn "pm2-resurrect" /f`

### 수동 실행 (pm2 없이)

```bash
npm run build
node dist/index.js            # 포그라운드 실행 (Ctrl+C로 종료)
```

## Slack 명령어

모든 명령어는 `-` 접두사로 시작합니다. `-help`로 전체 목록을 볼 수 있습니다.

### 작업 디렉터리

| 명령어 | 설명 |
|--------|------|
| `-cwd <경로>` | 작업 디렉터리 설정 (상대/절대 경로) |
| `-cwd` | 현재 설정 확인 |

```
-cwd ct-maven/ct-maven          # BASE_DIRECTORY 기준 상대 경로
-cwd P:\bitbucket\ct-cert        # 절대 경로
-cwd                             # 현재 설정 확인
```

**적용 범위:**
- **DM**: 해당 DM 대화 전체에 적용
- **채널**: 해당 채널 전체에 적용 (봇 추가 시 설정 안내)
- **쓰레드**: 해당 쓰레드에만 적용 (DM 폴백도 자동 생성)

설정은 디스크에 저장되어 봇 재시작 후에도 유지됩니다.

### 세션 관리

| 명령어 | 설명 |
|--------|------|
| `-sessions` | 현재 cwd의 최근 세션 목록 (ID + 요약) |
| `-continue [메시지]` | 마지막 CLI 세션 이어가기 |
| `-resume <session-id> [메시지]` | 특정 세션 이어가기 |
| `-stop` | 진행 중인 쿼리 중단 (graceful interrupt) |
| `-reset` | 현재 세션 초기화 (다음 메시지는 새 세션) |

```
-sessions                        # 세션 목록 확인
-resume 6449c0ab-4aa1-4de4-89ca-88ffcfc7c334   # 특정 세션 이어가기
-continue 현재 상태를 요약해줘    # 마지막 세션에 메시지 추가
-stop                            # 진행 중인 작업 중단
-reset                           # 세션 초기화
```

같은 쓰레드에서의 대화는 자동으로 세션이 이어집니다 (별도 명령 불필요).

### Plan & Permissions

| 명령어 | 설명 |
|--------|------|
| `-plan <프롬프트>` | 읽기 전용으로 계획만 생성 (실행 안함) |
| `-safe` | Safe 모드: Bash 명령 실행 시 Slack 버튼으로 승인 요청 |
| `-trust` | Trust 모드: 모든 도구 자동 승인 (기본값) |

```
-plan pom.xml 의존성 정리 방법 알려줘   # 계획만 보기 → Execute 버튼
-safe                                    # Bash 승인 모드 전환
-trust                                   # 자동 승인 모드 복귀
```

**Plan 모드 흐름:**
1. `-plan <프롬프트>` → Claude가 계획만 작성 (파일 수정 없음)
2. 계획 확인 후 **Execute** 버튼 → 세션 이어서 실제 실행
3. 또는 **Cancel** 버튼으로 취소

**Safe 모드:**
- 파일 읽기/편집: 자동 승인
- Bash 명령: Slack 버튼으로 승인/거부 요청
- 2분 내 응답 없으면 자동 승인

### 설정

| 명령어 | 설명 |
|--------|------|
| `-model [name]` | 모델 조회/설정 (`sonnet`, `opus`, `haiku`, 또는 전체 이름) |
| `-budget [amount\|off]` | 쿼리당 비용 상한 조회/설정/해제 (USD) |
| `-cost` | 마지막 쿼리 비용, 세션 ID 확인 |

```
-model                # 현재 모델 확인
-model sonnet         # sonnet으로 변경 (빠름/저렴)
-model opus           # opus로 변경 (고성능)
-budget 1.00          # 쿼리당 $1.00 상한
-budget off           # 상한 해제
-cost                 # 마지막 비용 확인
```

### MCP 서버

| 명령어 | 설명 |
|--------|------|
| `-mcp` | MCP 서버 상태 확인 |
| `-mcp reload` | MCP 설정 다시 로드 |

`mcp-servers.json` 파일로 설정:
```bash
cp mcp-servers.example.json mcp-servers.json
```

### 기타

| 명령어 | 설명 |
|--------|------|
| `help` 또는 `-help` | 전체 명령어 목록 |

### 대화

```
# DM으로 직접 메시지
이 프로젝트의 구조를 설명해줘

# 채널에서 멘션
@ClaudeBot pom.xml 분석해줘

# 쓰레드에서 이어서 (세션 자동 유지)
의존성 충돌이 있는지 확인해줘
```

### 파일 업로드

드래그 앤 드롭 또는 첨부 버튼으로 파일 업로드 후 분석 요청:

- **이미지**: JPG, PNG, GIF, WebP, SVG
- **텍스트**: TXT, MD, JSON, JS, TS, PY, Java 등
- **문서**: PDF, DOCX (제한적)
- **코드**: 대부분의 프로그래밍 언어

### Rate Limit 재시도

Claude 사용량 한도에 도달하면 봇이 자동으로 감지하고 Slack 예약 메시지를 통한 재시도를 제안합니다:

1. Rate limit 에러 발생 → 예상 대기 시간 표시
2. "예약" 버튼 클릭 → Slack이 지정 시간에 메시지 전달
3. 봇이 예약된 메시지를 수신하여 자동 실행

## 멀티유저 설정

같은 Slack 워크스페이스의 여러 사용자가 각각 봇을 실행하려면:

1. **각 사용자가 자신의 Slack App을 생성** (Socket Mode는 앱당 단일 연결)
2. 각자의 머신에서 봇을 실행 (`claude login` → `.env` 설정 → `start.bat`)
3. 각자의 Claude 구독에서 사용량 차감

> 팀 공유 서버에서 하나의 봇을 운영하는 것도 가능합니다. 이 경우 모든 팀원이 하나의 Claude 구독을 공유하게 됩니다.

## 고급 설정

### AWS Bedrock
```env
CLAUDE_CODE_USE_BEDROCK=1
# AWS CLI 또는 IAM 역할로 인증 설정 필요
```

### Google Vertex AI
```env
CLAUDE_CODE_USE_VERTEX=1
# Google Cloud 인증 설정 필요
```

## 프로젝트 구조

```
src/
├── index.ts                     # 진입점
├── config.ts                    # 환경변수 및 설정
├── types.ts                     # TypeScript 타입 정의
├── claude-handler.ts            # Claude Code SDK 연동
├── slack-handler.ts             # Slack 이벤트 처리
├── working-directory-manager.ts # 작업 디렉터리 관리 (영속화)
├── file-handler.ts              # 파일 업로드 처리
├── todo-manager.ts              # 작업 목록 관리
├── mcp-manager.ts               # MCP 서버 관리
└── logger.ts                    # 로깅 유틸리티
```

## 트러블슈팅

### 봇이 응답하지 않음
1. `stop.bat` → `start.bat`으로 재시작
2. `pm2 logs claude-slack-bot`으로 로그 확인
3. `.env` 토큰 유효성 확인
4. 채널에 봇이 추가되었는지 확인

### "No working directory set" 오류
`-cwd <경로>` 명령으로 작업 디렉터리를 먼저 설정하세요.

### Windows에서 `npm install` 실패
```bash
npm install --ignore-scripts
```

## 업스트림 업데이트

```bash
git fetch upstream
git checkout main && git merge upstream/main
git checkout custom && git merge main
npm install --ignore-scripts
npm run build
```

## 라이선스

MIT
