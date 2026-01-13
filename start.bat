@echo off
REM AskWRI - Start all services (Windows)

echo Starting AskWRI v3.0...
echo.

REM Check if .env file exists
if not exist .env (
    echo Warning: No .env file found. Creating from .env.example...
    if exist .env.example (
        copy .env.example .env
        echo Created .env file. Please add your OPENAI_API_KEY
        exit /b 1
    )
)

REM Check for OPENAI_API_KEY in .env
findstr /C:"OPENAI_API_KEY=sk-" .env >nul
if errorlevel 1 (
    echo Error: OPENAI_API_KEY not set in .env file
    exit /b 1
)

REM Load environment variables from .env
for /f "tokens=*" %%a in ('type .env ^| findstr /v "^#"') do set %%a

REM Set default service URL
if not defined LLAMAINDEX_SERVICE_URL set LLAMAINDEX_SERVICE_URL=http://127.0.0.1:8002

echo Configuration:
echo    OPENAI_API_KEY: %OPENAI_API_KEY:~0,8%...
echo    LLAMAINDEX_SERVICE_URL: %LLAMAINDEX_SERVICE_URL%
echo.

REM Create logs directory
if not exist logs mkdir logs

REM Start Python hybrid service
echo Starting Python hybrid service...
cd hybrid-service

REM Check if venv exists
if not exist venv (
    echo    Creating Python virtual environment...
    python -m venv venv
    call venv\Scripts\activate
    echo    Installing dependencies...
    pip install -q -r requirements.txt
) else (
    call venv\Scripts\activate
)

REM Start hybrid service in background
start /B python main.py > ..\logs\hybrid-service.log 2>&1

cd ..

echo    Hybrid service starting
echo    Logs: logs\hybrid-service.log
echo.

REM Wait for hybrid service
echo Waiting for hybrid service to initialize...
timeout /t 5 /nobreak >nul

:check_hybrid
curl -s http://127.0.0.1:8002/health >nul 2>&1
if errorlevel 1 (
    timeout /t 2 /nobreak >nul
    goto check_hybrid
)
echo    Hybrid service ready!
echo.

REM Check if node_modules exists
if not exist node_modules (
    echo Installing npm dependencies...
    call npm install
    echo.
)

REM Start Next.js frontend
echo Starting Next.js frontend...
start /B npm run dev > logs\frontend.log 2>&1

echo    Frontend starting
echo    Logs: logs\frontend.log
echo.

REM Wait for frontend
echo Waiting for frontend to be ready...
timeout /t 5 /nobreak >nul

:check_frontend
curl -s http://localhost:3000 >nul 2>&1
if errorlevel 1 (
    timeout /t 2 /nobreak >nul
    goto check_frontend
)
echo    Frontend ready!
echo.

echo ========================================
echo AskWRI is now running!
echo.
echo Access points:
echo    Research Interface: http://localhost:3000
echo    Document Management: http://localhost:3000/admin/documents
echo    Hybrid Service: http://localhost:8002
echo    API Health: http://localhost:8002/health
echo.
echo Logs:
echo    Hybrid Service: logs\hybrid-service.log
echo    Frontend: logs\frontend.log
echo.
echo Press Ctrl+C to stop (then run stop.bat to cleanup)
echo ========================================
echo.

pause