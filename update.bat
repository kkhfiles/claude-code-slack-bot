@echo off
setlocal
cd /d "%~dp0"

echo === Claude Code Slack Bot — Update ===
echo.

REM Show current version
for /f "delims=" %%V in ('node -e "console.log(require('./package.json').version)"') do set CURRENT_VERSION=%%V
echo Current version: v%CURRENT_VERSION%
echo.

REM Pull latest changes
echo Pulling latest changes...
git pull
echo.

REM Install dependencies
echo Installing dependencies...
call npm install --ignore-scripts
if errorlevel 1 (
    echo ERROR: npm install failed!
    exit /b 1
)
echo.

REM Build
echo Building...
call npm run build
if errorlevel 1 (
    echo ERROR: Build failed!
    exit /b 1
)
echo.

REM Restart pm2 (if running)
where pm2 >nul 2>&1
if not errorlevel 1 (
    pm2 describe claude-slack-bot >nul 2>&1
    if not errorlevel 1 (
        echo Restarting bot...
        pm2 restart claude-slack-bot
        pm2 save >nul 2>&1
    ) else (
        echo Bot is not running in pm2. Start it with start.bat
    )
) else (
    echo pm2 not found. Start the bot manually.
)
echo.

REM Show new version
for /f "delims=" %%V in ('node -e "console.log(require('./package.json').version)"') do set NEW_VERSION=%%V
echo === Updated to v%NEW_VERSION% ===
