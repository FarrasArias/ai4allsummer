@echo off
setlocal enabledelayedexpansion

:: ============================================================
::  AI4ALL - Start the App
::  Launches the backend, frontend, and opens the browser.
:: ============================================================

title AI4ALL

set "ROOT=%~dp0"
cd /d "%ROOT%"

echo.
echo  ============================================
echo   AI4ALL - Starting...
echo  ============================================
echo.

:: ----------------------------------------------------------
:: Pre-flight checks
:: ----------------------------------------------------------
if not exist "%ROOT%backend\.venv\Scripts\python.exe" (
    echo  [X] Backend not set up yet.
    echo      Please run setup.bat first.
    echo.
    pause
    exit /b 1
)

if not exist "%ROOT%energy-chat-dashboard\node_modules" (
    echo  [X] Frontend not set up yet.
    echo      Please run setup.bat first.
    echo.
    pause
    exit /b 1
)

:: ----------------------------------------------------------
:: Start Ollama (if not already running)
:: ----------------------------------------------------------
echo  [1/3] Starting Ollama...

:: Check if Ollama is already running by trying to list models
ollama list >nul 2>&1
if %errorlevel% equ 0 (
    echo         Ollama is already running.
    goto :ollama_running
)

:: Try to find ollama on PATH or default location
where ollama >nul 2>&1
if %errorlevel% equ 0 (
    start /min "Ollama" ollama serve
    goto :ollama_wait
)

if exist "%LOCALAPPDATA%\Programs\Ollama\ollama.exe" (
    start /min "Ollama" "%LOCALAPPDATA%\Programs\Ollama\ollama.exe" serve
    goto :ollama_wait
)

echo  [!] Ollama not found. The app may not work without it.
echo      Install Ollama from https://ollama.com/download
echo      or run setup.bat again.
echo.
goto :ollama_running

:ollama_wait
echo         Waiting for Ollama to start...
:: Wait up to 15 seconds for Ollama to become ready
for /l %%i in (1,1,15) do (
    timeout /t 1 /nobreak >nul 2>&1
    ollama list >nul 2>&1
    if !errorlevel! equ 0 (
        echo         Ollama is ready.
        goto :ollama_running
    )
)
echo  [!] Ollama may still be starting. Continuing anyway...

:ollama_running

:: ----------------------------------------------------------
:: Start Backend
:: ----------------------------------------------------------
echo  [2/3] Starting backend server...

start /min "AI4ALL Backend" cmd /c "cd /d "%ROOT%backend" && call .venv\Scripts\activate.bat && python -m uvicorn server:app --host 0.0.0.0 --port 8000 --reload"

:: Wait for backend to be ready (up to 15 seconds)
echo         Waiting for backend...
for /l %%i in (1,1,15) do (
    timeout /t 1 /nobreak >nul 2>&1
    curl -s http://localhost:8000/api/health >nul 2>&1
    if !errorlevel! equ 0 (
        echo         Backend is ready.
        goto :backend_ready
    )
)
echo         Backend may still be loading. Continuing...

:backend_ready

:: ----------------------------------------------------------
:: Start Frontend
:: ----------------------------------------------------------
echo  [3/3] Starting frontend...

start /min "AI4ALL Frontend" cmd /c "cd /d "%ROOT%energy-chat-dashboard" && npm run dev"

:: Wait a moment for Vite to start
timeout /t 4 /nobreak >nul 2>&1

:: ----------------------------------------------------------
:: Open browser
:: ----------------------------------------------------------
echo.
echo         Opening app in browser...
start "" "http://localhost:5173/"

:: ----------------------------------------------------------
:: Keep this window open so user can see status
:: ----------------------------------------------------------
echo.
echo  ============================================
echo   AI4ALL is running!
echo  ============================================
echo.
echo   App:      http://localhost:5173
echo   Backend:  http://localhost:8000
echo.
echo   To stop the app, close this window
echo   (it will also close the backend and frontend).
echo.
echo   Press Ctrl+C or close this window to quit.
echo  ============================================
echo.

:: Keep the window open; when user closes it, child processes
:: started with "start /min" will close automatically since
:: they are in separate consoles.
pause >nul
