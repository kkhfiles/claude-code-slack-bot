@echo off
REM Windows 로그인 시 pm2 프로세스를 자동 복원하는 Task Scheduler 등록
REM 관리자 권한 불필요 (현재 사용자 로그온 트리거)

echo === Claude Slack Bot Auto-Start Setup ===
echo.

REM 현재 pm2 프로세스 목록 저장
echo [1/3] Saving current pm2 process list...
call pm2 save
echo.

REM Task Scheduler 등록
echo [2/3] Creating scheduled task "pm2-resurrect"...
schtasks /create /tn "pm2-resurrect" /tr "cmd /c pm2 resurrect" /sc onlogon /f
if %errorlevel% neq 0 (
    echo.
    echo Failed to create task. Try running as Administrator:
    echo   Right-click autostart-setup.bat ^> Run as administrator
    exit /b 1
)
echo.

echo [3/3] Verifying...
schtasks /query /tn "pm2-resurrect" /fo list
echo.
echo === Setup Complete ===
echo pm2 processes will auto-start on login.
echo.
echo To remove: schtasks /delete /tn "pm2-resurrect" /f
pause
