@echo off
REM AskWRI - Stop all services (Windows)

echo Stopping AskWRI services...

REM Kill Python processes
echo    Stopping hybrid service...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :8002 ^| findstr LISTENING') do taskkill /F /PID %%a >nul 2>&1
echo    Hybrid service stopped

REM Kill Node processes
echo    Stopping frontend...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :3000 ^| findstr LISTENING') do taskkill /F /PID %%a >nul 2>&1
echo    Frontend stopped

echo.
echo All services stopped