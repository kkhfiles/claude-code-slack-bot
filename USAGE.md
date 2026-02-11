# Claude Code Slack Bot - 사용 가이드

## 사전 요구사항

- Node.js 18+
- Claude Code CLI (`claude`) 설치 및 로그인 (`claude login`)
- Slack App 설정 완료 (`.env` 파일)

## 실행 방법

### 간단 실행 (권장)

```bash
# 시작 (기존 프로세스 자동 종료 후 시작)
start.bat

# 중지
stop.bat
```

`start.bat`은:
- 기존 봇 프로세스가 있으면 자동 종료
- TypeScript 빌드 후 실행
- PID 파일로 프로세스 추적
- 로그를 `bot.log`에 기록

### 수동 실행

```bash
# 빌드 후 실행 (프로덕션)
npm run build
node dist/index.js

# 개발 모드 (TypeScript 직접 실행, 핫 리로드)
npm run dev
```

> **주의**: `npm run dev`는 종료 시 자식 프로세스가 남을 수 있음.
> 항상 `stop.bat`으로 정리하거나, `start.bat`을 사용할 것.

### 백그라운드 실행

```bash
# PowerShell에서 백그라운드로 시작
Start-Process -NoNewWindow -FilePath "node" -ArgumentList "dist/index.js" -WorkingDirectory "P:\github\claude-code-slack-bot" -RedirectStandardOutput "bot.log" -RedirectStandardError "bot.err"
```

## Slack 사용법

### 작업 디렉터리 설정

봇에게 질문하기 전에 작업 디렉터리를 설정해야 합니다.

```
cwd ct-maven/ct-maven          # BASE_DIRECTORY 기준 상대 경로
cwd P:\bitbucket\ct-cert        # 절대 경로
cwd                             # 현재 설정 확인
```

- DM에서 설정하면 해당 DM 전체에 적용
- 쓰레드에서 설정하면 해당 쓰레드에만 적용 (DM 폴백도 자동 생성)
- 봇 재시작 후에도 설정이 유지됨 (`.working-dirs.json`)

### 대화

```
# 새 대화 시작
hello, 이 프로젝트의 구조를 설명해줘

# 쓰레드에서 이어서 대화 (세션 자동 유지)
pom.xml에서 의존성을 확인해줘
```

### 세션 관리

- **같은 쓰레드** = 같은 세션 (자동 `--resume`)
- **새 메시지** = 새 세션
- 세션은 30분 비활성 후 자동 정리 (Slack 쓰레드에서 다시 대화하면 새 세션 시작)

## 환경 변수

| 변수 | 필수 | 설명 |
|------|------|------|
| `SLACK_BOT_TOKEN` | O | Bot User OAuth Token (`xoxb-...`) |
| `SLACK_APP_TOKEN` | O | App-Level Token (`xapp-...`) |
| `SLACK_SIGNING_SECRET` | O | App Credentials의 Signing Secret |
| `BASE_DIRECTORY` | - | 기본 작업 디렉터리 (상대 경로의 기준) |
| `DEBUG` | - | `true`로 설정하면 상세 로그 출력 |

## 트러블슈팅

### 여러 봇 프로세스가 동시에 실행됨
```bash
# 모든 봇 프로세스 종료
stop.bat

# 또는 수동으로
tasklist | findstr node.exe
taskkill /PID <pid> /T /F
```

### "No working directory set" 오류
`cwd <경로>` 명령으로 작업 디렉터리를 먼저 설정하세요.

### 봇이 응답하지 않음
1. `stop.bat`으로 종료 후 `start.bat`으로 재시작
2. `bot.log` 확인
3. `.env` 파일의 토큰 확인

## 업스트림 업데이트

```bash
git fetch upstream
git checkout main && git merge upstream/main
git checkout custom && git merge main
npm install --ignore-scripts
npm run build
```
