@echo off
setlocal
cd /d "%~dp0"

echo === Claude Code Slack Bot — Setup ===
echo.

REM --- Prerequisites ---
echo Checking prerequisites...

where node >nul 2>&1
if errorlevel 1 (
    echo ERROR: Node.js is not installed. Please install Node.js 18+ first.
    exit /b 1
)
for /f "tokens=1 delims=." %%A in ('node -v') do set NODE_VER=%%A
set NODE_VER=%NODE_VER:v=%
if %NODE_VER% LSS 18 (
    echo ERROR: Node.js 18+ required.
    exit /b 1
)
echo   √ Node.js found

where npm >nul 2>&1
if errorlevel 1 (
    echo ERROR: npm is not installed.
    exit /b 1
)
echo   √ npm found

where git >nul 2>&1
if errorlevel 1 (
    echo ERROR: git is not installed.
    exit /b 1
)
echo   √ git found

where claude >nul 2>&1
if errorlevel 1 (
    echo WARNING: claude CLI not found. Install it before running the bot.
) else (
    echo   √ claude CLI found
)

echo.

REM --- Install dependencies ---
echo Installing dependencies...
call npm install --ignore-scripts
if errorlevel 1 (
    echo ERROR: npm install failed!
    exit /b 1
)
echo.

REM --- .env file ---
if not exist .env (
    if exist .env.example (
        copy .env.example .env >nul
        echo Created .env from .env.example — please edit it with your tokens.
    ) else (
        echo WARNING: No .env file found. Create one with your Slack tokens before starting.
    )
) else (
    echo .env already exists — skipping.
)
echo.

REM --- pm2 ---
where pm2 >nul 2>&1
if errorlevel 1 (
    echo Installing pm2 globally...
    call npm install -g pm2
) else (
    echo pm2 already installed.
)
echo.

REM --- Build ---
echo Building...
call npm run build
if errorlevel 1 (
    echo ERROR: Build failed!
    exit /b 1
)
echo.

echo === Setup complete ===
echo.
echo Next steps:
echo   1. Edit .env with your Slack tokens
echo   2. Run start.bat to start the bot
echo   3. Run 'pm2 logs claude-slack-bot' to view logs
