@echo off
setlocal

set BOT_DIR=%~dp0
set PID_FILE=%BOT_DIR%bot.pid
set LOG_FILE=%BOT_DIR%bot.log

:: Kill existing bot process if running
if exist "%PID_FILE%" (
    set /p OLD_PID=<"%PID_FILE%"
    echo Stopping existing bot process (PID: %OLD_PID%)...
    taskkill /PID %OLD_PID% /T /F >nul 2>&1
    del "%PID_FILE%"
    timeout /t 2 /nobreak >nul
)

:: Also kill any orphaned bot processes
for /f "tokens=2" %%a in ('tasklist /fi "imagename eq node.exe" /fo list 2^>nul ^| findstr /i "PID:"') do (
    wmic process where "ProcessId=%%a" get CommandLine 2>nul | findstr /i "claude-code-slack" >nul 2>&1
    if not errorlevel 1 (
        echo Killing orphaned bot process (PID: %%a)...
        taskkill /PID %%a /T /F >nul 2>&1
    )
)

:: Build
echo Building...
cd /d "%BOT_DIR%"
call npm run build
if errorlevel 1 (
    echo Build failed!
    exit /b 1
)

:: Start bot
echo Starting Claude Code Slack bot...
start /b cmd /c "node dist/index.js > "%LOG_FILE%" 2>&1 & echo %%PID%% > "%PID_FILE%""

:: Wait and capture PID
timeout /t 2 /nobreak >nul

:: Find the actual node.exe PID
for /f "tokens=2" %%a in ('tasklist /fi "imagename eq node.exe" /fo list 2^>nul ^| findstr /i "PID:"') do (
    wmic process where "ProcessId=%%a" get CommandLine 2>nul | findstr /i "dist\\index.js" >nul 2>&1
    if not errorlevel 1 (
        echo %%a> "%PID_FILE%"
        echo Bot started with PID: %%a
        echo Log file: %LOG_FILE%
        goto :started
    )
)

:started
echo.
echo Commands:
echo   stop.bat    - Stop the bot
echo   start.bat   - Restart the bot
echo   type bot.log - View logs
