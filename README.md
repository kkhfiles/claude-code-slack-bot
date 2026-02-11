# Claude Code Slack Bot

Slack에서 로컬 머신의 Claude Code를 원격으로 실행하고 결과를 받아보는 봇.
[mpociot/claude-code-slack-bot](https://github.com/mpociot/claude-code-slack-bot) 포크에 Windows 호환성 및 기능 개선을 추가.

## 주요 기능

- DM / 채널 멘션 / 쓰레드 대화 (세션 자동 유지)
- 스트리밍 응답 (실시간 메시지 갱신)
- 파일 업로드 (이미지, 텍스트, PDF, 코드 파일)
- 작업 디렉터리 관리 (디스크 영속화, 재시작 후 유지)
- MCP 서버 연동
- AWS Bedrock / Google Vertex AI 지원 (선택)

### 포크 변경사항

- Windows 호환성 (permission MCP 서버 제외, `bypassPermissions`)
- 작업 디렉터리 디스크 영속화 (`.working-dirs.json`)
- DM 쓰레드에서 `cwd` 설정 시 DM 레벨 폴백 자동 생성
- DM에서 `@bot cwd` 명령 인식 (봇 멘션 자동 제거)
- 프로세스 관리 스크립트 (`start.bat`, `stop.bat`)

## 사전 요구사항

- Node.js 18+
- Claude Code CLI 설치 및 로그인 (`claude login`)
- Slack 워크스페이스 관리자 권한

## 설치

### 1. 클론 및 패키지 설치

```bash
cd P:\github
git clone https://github.com/kkhfiles/claude-code-slack-bot.git
cd claude-code-slack-bot
git checkout custom
npm install --ignore-scripts
```

> `--ignore-scripts`: `@anthropic-ai/claude-code` 패키지의 Windows 플랫폼 체크를 우회.

### 2. Slack App 생성

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

### 시작 / 중지 (권장)

```bash
start.bat          # 기존 프로세스 자동 종료 → 빌드 → 시작
stop.bat           # 종료 + 고아 프로세스 정리
type bot.log       # 로그 확인
```

`start.bat`은 PID 파일로 프로세스를 추적하여 항상 **하나의 인스턴스만** 실행됨을 보장.

### 수동 실행

```bash
# 프로덕션
npm run build
npm run prod        # = node dist/index.js

# 개발 (TypeScript 직접 실행, 파일 변경 시 자동 재시작)
npm run dev
```

> **주의**: `npm run dev` 사용 시 종료가 불완전할 수 있음. `stop.bat`으로 정리하거나 `start.bat` 사용 권장.

## Slack 사용법

### 작업 디렉터리 설정

봇에게 질문하기 전에 반드시 작업 디렉터리를 설정해야 합니다.

```
cwd ct-maven/ct-maven          # BASE_DIRECTORY 기준 상대 경로
cwd P:\bitbucket\ct-cert        # 절대 경로
set directory /path/to/project  # 대체 문법
cwd                             # 현재 설정 확인
```

**적용 범위:**
- **DM**: 해당 DM 대화 전체에 적용
- **채널**: 해당 채널 전체에 적용 (봇 추가 시 설정 안내)
- **쓰레드**: 해당 쓰레드에만 적용 (DM 폴백도 자동 생성)

설정은 디스크에 저장되어 봇 재시작 후에도 유지됩니다.

### 대화

```
# DM으로 직접 메시지
이 프로젝트의 구조를 설명해줘

# 채널에서 멘션
@ClaudeBot pom.xml 분석해줘

# 쓰레드에서 이어서 (세션 자동 유지)
의존성 충돌이 있는지 확인해줘
```

### 세션 관리

| 동작 | 결과 |
|------|------|
| 같은 쓰레드에서 대화 | 세션 자동 이어짐 (`--resume`) |
| 새 메시지 (쓰레드 외) | 새 세션 시작 |
| 30분 비활성 | 세션 자동 정리, 이후 새 세션 |

SDK는 `resume` (세션 ID로 이어가기)과 `continue` (마지막 대화 이어가기) 모두 지원.
현재 구현에서는 Slack 쓰레드 기반으로 `resume`을 자동 적용합니다.

### 파일 업로드

드래그 앤 드롭 또는 첨부 버튼으로 파일 업로드 후 분석 요청:

- **이미지**: JPG, PNG, GIF, WebP, SVG
- **텍스트**: TXT, MD, JSON, JS, TS, PY, Java 등
- **문서**: PDF, DOCX (제한적)
- **코드**: 대부분의 프로그래밍 언어

### MCP 서버

`mcp-servers.json` 파일로 MCP 서버를 설정하여 Claude의 기능을 확장할 수 있습니다.

```bash
cp mcp-servers.example.json mcp-servers.json
```

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/files"]
    }
  }
}
```

**명령어:**
- `mcp` 또는 `servers` — 설정된 서버 확인
- `mcp reload` — 설정 다시 로드

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
2. `bot.log` 확인
3. `.env` 토큰 유효성 확인
4. 채널에 봇이 추가되었는지 확인

### 여러 봇 프로세스가 동시에 실행됨
```bash
stop.bat    # 모든 봇 프로세스 종료 + 고아 프로세스 정리
start.bat   # 깨끗한 상태로 재시작
```

### "No working directory set" 오류
`cwd <경로>` 명령으로 작업 디렉터리를 먼저 설정하세요.

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
