@echo off
cd /d "%~dp0"

echo Building...
call npm run build
if errorlevel 1 (
    echo Build failed!
    exit /b 1
)

pm2 describe claude-slack-bot >nul 2>&1
if %errorlevel%==0 (
    echo Restarting bot...
    pm2 restart claude-slack-bot
) else (
    echo Starting bot...
    pm2 start ecosystem.config.js
)

pm2 save >nul 2>&1
echo.
echo Bot is running. Commands:
echo   pm2 logs claude-slack-bot    View logs (live)
echo   pm2 status                   Process status
echo   stop.bat                     Stop the bot
