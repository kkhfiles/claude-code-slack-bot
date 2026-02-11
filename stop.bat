@echo off
setlocal

set BOT_DIR=%~dp0
set PID_FILE=%BOT_DIR%bot.pid

if exist "%PID_FILE%" (
    set /p PID=<"%PID_FILE%"
    echo Stopping bot process (PID: %PID%)...
    taskkill /PID %PID% /T /F >nul 2>&1
    del "%PID_FILE%"
    echo Bot stopped.
) else (
    echo No PID file found. Searching for orphaned processes...
)

:: Kill any remaining bot processes
set FOUND=0
for /f "tokens=2" %%a in ('tasklist /fi "imagename eq node.exe" /fo list 2^>nul ^| findstr /i "PID:"') do (
    wmic process where "ProcessId=%%a" get CommandLine 2>nul | findstr /i "claude-code-slack" >nul 2>&1
    if not errorlevel 1 (
        echo Killing orphaned bot process (PID: %%a)...
        taskkill /PID %%a /T /F >nul 2>&1
        set FOUND=1
    )
)

if "%FOUND%"=="0" (
    if not exist "%PID_FILE%" echo No bot processes found.
)
