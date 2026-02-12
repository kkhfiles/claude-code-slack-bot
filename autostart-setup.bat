@echo off
REM Windows 로그인 시 pm2 프로세스를 자동 복원 (시작 프로그램 폴더 방식)
REM 관리자 권한 불필요

echo === Claude Slack Bot Auto-Start Setup ===
echo.

REM pm2 경로 확인
where pm2.cmd >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] pm2 not found. Install: npm install -g pm2
    exit /b 1
)

REM 현재 pm2 프로세스 목록 저장
echo [1/3] Saving current pm2 process list...
call pm2 save
if %errorlevel% neq 0 (
    echo [WARN] pm2 save failed. Make sure the bot is running first.
    echo   Run start.bat, then re-run this script.
    exit /b 1
)
echo.

REM VBS 스크립트를 시작 프로그램 폴더에 복사
set STARTUP_DIR=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup
set VBS_SRC=%~dp0pm2-resurrect.vbs
set VBS_DST=%STARTUP_DIR%\pm2-resurrect.vbs

echo [2/3] Installing to startup folder...
copy /y "%VBS_SRC%" "%VBS_DST%" >nul
if %errorlevel% neq 0 (
    echo [ERROR] Failed to copy to startup folder.
    exit /b 1
)
echo   Copied to: %VBS_DST%
echo.

echo [3/3] Verifying...
if exist "%VBS_DST%" (
    echo   OK: pm2-resurrect.vbs found in startup folder.
) else (
    echo   FAIL: File not found in startup folder.
    exit /b 1
)
echo.
echo === Setup Complete ===
echo pm2 processes will auto-start on Windows login (no CMD window).
echo.
echo To remove:  del "%VBS_DST%"
echo To verify:  dir "%STARTUP_DIR%\pm2-resurrect.vbs"
pause
