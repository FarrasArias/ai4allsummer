@echo off
setlocal enabledelayedexpansion

:: ============================================================
::  AI4ALL - Setup
::  Run this after extracting the folder, and again after every
::  update (git pull) - it is safe to re-run and only installs
::  what is missing or outdated.
:: ============================================================

title AI4ALL Setup

:: Use the folder where this script lives as the project root
set "ROOT=%~dp0"
cd /d "%ROOT%"

echo.
echo  ============================================
echo   AI4ALL - Setup
echo  ============================================
echo   (Safe to re-run: anything already installed is skipped)
echo.

:: ----------------------------------------------------------
:: Step 1: Check for Python
:: ----------------------------------------------------------
echo  [1/6] Checking for Python...

where python >nul 2>&1
if %errorlevel% equ 0 (
    for /f "tokens=*" %%v in ('python --version 2^>^&1') do set "PYVER=%%v"
    echo         Found: !PYVER!
    set "PYTHON_CMD=python"
    goto :python_ok
)

where py >nul 2>&1
if %errorlevel% equ 0 (
    for /f "tokens=*" %%v in ('py --version 2^>^&1') do set "PYVER=%%v"
    echo         Found: !PYVER!
    set "PYTHON_CMD=py"
    goto :python_ok
)

echo.
echo  [X] Python is not installed.
echo.
echo      Please install Python 3.10 or newer:
echo      Opening the download page for you...
echo.
start "" "https://www.python.org/downloads/"
echo      After installing, CLOSE this window and run setup.bat again.
echo      IMPORTANT: Check "Add Python to PATH" during installation!
echo.
pause
exit /b 1

:python_ok

:: ----------------------------------------------------------
:: Step 2: Check for Node.js / npm
:: ----------------------------------------------------------
echo  [2/6] Checking for Node.js...

where node >nul 2>&1
if %errorlevel% equ 0 (
    for /f "tokens=*" %%v in ('node --version 2^>^&1') do set "NODEVER=%%v"
    echo         Found: Node !NODEVER!
    goto :node_ok
)

echo.
echo  [X] Node.js is not installed.
echo.
echo      Please install Node.js 18 or newer:
echo      Opening the download page for you...
echo.
start "" "https://nodejs.org/"
echo      After installing, CLOSE this window and run setup.bat again.
echo.
pause
exit /b 1

:node_ok

where npm >nul 2>&1
if %errorlevel% neq 0 (
    echo  [X] npm not found. It should come with Node.js.
    echo      Try reinstalling Node.js from https://nodejs.org/
    pause
    exit /b 1
)

:: ----------------------------------------------------------
:: Step 3: Check for / Install Ollama
:: ----------------------------------------------------------
echo  [3/6] Checking for Ollama...

where ollama >nul 2>&1
if %errorlevel% equ 0 (
    echo         Found: Ollama is installed.
    goto :ollama_ok
)

:: Also check the default install location
if exist "%LOCALAPPDATA%\Programs\Ollama\ollama.exe" (
    echo         Found: Ollama at default location.
    set "PATH=%LOCALAPPDATA%\Programs\Ollama;%PATH%"
    goto :ollama_ok
)

echo         Ollama is not installed. Downloading installer...
echo.

:: Download Ollama installer using curl (built into Windows 10/11)
set "OLLAMA_INSTALLER=%TEMP%\OllamaSetup.exe"
curl -L -o "%OLLAMA_INSTALLER%" "https://ollama.com/download/OllamaSetup.exe" 2>nul

if not exist "%OLLAMA_INSTALLER%" (
    echo  [X] Could not download Ollama installer.
    echo      Please install Ollama manually from: https://ollama.com/download
    echo      Then run setup.bat again.
    pause
    exit /b 1
)

echo         Running Ollama installer...
echo         (Follow the installer prompts if any appear)
echo.
start /wait "" "%OLLAMA_INSTALLER%"

:: Check again after install
where ollama >nul 2>&1
if %errorlevel% neq 0 (
    if exist "%LOCALAPPDATA%\Programs\Ollama\ollama.exe" (
        set "PATH=%LOCALAPPDATA%\Programs\Ollama;%PATH%"
    ) else (
        echo  [X] Ollama installation may have failed.
        echo      Please install manually from: https://ollama.com/download
        echo      Then run setup.bat again.
        pause
        exit /b 1
    )
)
echo         Ollama installed successfully.

:ollama_ok

:: ----------------------------------------------------------
:: Step 4: Set up Python backend
:: ----------------------------------------------------------
echo  [4/6] Setting up Python backend...

if exist "%ROOT%backend\.venv\Scripts\python.exe" (
    :: Test if the venv actually works at this location
    :: (Python venvs embed absolute paths — they break when copied to a new folder)
    "%ROOT%backend\.venv\Scripts\python.exe" -c "print('ok')" >nul 2>&1
    if !errorlevel! neq 0 (
        echo         Existing virtual environment is stale (copied from another location^).
        echo         Recreating...
        rmdir /s /q "%ROOT%backend\.venv"
        %PYTHON_CMD% -m venv "%ROOT%backend\.venv"
        if !errorlevel! neq 0 (
            echo  [X] Failed to create Python virtual environment.
            pause
            exit /b 1
        )
    ) else (
        echo         Virtual environment already exists. Updating packages...
    )
) else (
    echo         Creating virtual environment...
    %PYTHON_CMD% -m venv "%ROOT%backend\.venv"
    if !errorlevel! neq 0 (
        echo  [X] Failed to create Python virtual environment.
        pause
        exit /b 1
    )
)

echo         Installing Python packages (this may take a minute)...
"%ROOT%backend\.venv\Scripts\pip.exe" install -r "%ROOT%backend\requirements.txt" --quiet
if %errorlevel% neq 0 (
    echo  [X] Failed to install Python packages.
    echo      Check the error messages above.
    pause
    exit /b 1
)

:: Create backend\.env from the template on first run
if not exist "%ROOT%backend\.env" (
    if exist "%ROOT%backend\.env.example" (
        copy /y "%ROOT%backend\.env.example" "%ROOT%backend\.env" >nul
        echo         Created backend\.env from template.
        echo         ^(Optional^) Edit backend\.env and set OLLAMA_WEB_API_KEY
        echo         to enable web search in the Web tab.
    )
)

echo         Backend ready.

:: ----------------------------------------------------------
:: Step 5: Set up Frontend
:: ----------------------------------------------------------
echo  [5/6] Setting up frontend...

if exist "%ROOT%energy-chat-dashboard\node_modules\.package-lock.json" (
    echo         node_modules already exists. Checking for updates...
)

pushd "%ROOT%energy-chat-dashboard"
call npm install --silent 2>nul
if %errorlevel% neq 0 (
    echo         Retrying npm install...
    call npm install
    if %errorlevel% neq 0 (
        echo  [X] Failed to install frontend packages.
        echo      Check the error messages above.
        popd
        pause
        exit /b 1
    )
)
popd
echo         Frontend ready.

:: ----------------------------------------------------------
:: Step 6: Pull default AI model
:: ----------------------------------------------------------
echo  [6/6] Setting up AI models...
echo.

:: Make sure Ollama service is running
echo         Starting Ollama service...
start /min "" ollama serve 2>nul

:: Give it a moment to start
timeout /t 3 /nobreak >nul 2>&1

:: Check if default model is already pulled
ollama list 2>nul | findstr /i "qwen3:1.7b" >nul 2>&1
if %errorlevel% equ 0 (
    echo         Default model (qwen3:1.7b) is already downloaded.
    goto :models_done
)

echo.
echo  The app needs at least one AI model to work.
echo  The default model (qwen3:1.7b) is about ~1 GB to download.
echo.
set /p "PULL_MODEL=  Download the default model now? (Y/n): "
if /i "!PULL_MODEL!"=="n" (
    echo.
    echo  Skipped. You can download models later from the Models tab in the app,
    echo  or run:  ollama pull qwen3:1.7b
    goto :models_done
)

echo.
echo         Downloading qwen3:1.7b (this may take a few minutes)...
ollama pull qwen3:1.7b
if %errorlevel% equ 0 (
    echo         Model downloaded successfully.
) else (
    echo  [!] Model download failed. You can try again later with:
    echo      ollama pull qwen3:1.7b
)

:models_done

:: Embedding model for document search (RAG). Small download, so no prompt -
:: without it the app falls back to pasting whole documents into the prompt.
ollama list 2>nul | findstr /i "nomic-embed-text" >nul 2>&1
if %errorlevel% equ 0 (
    echo         Embedding model ^(nomic-embed-text^) is already downloaded.
) else (
    echo.
    echo         Downloading nomic-embed-text ^(~274 MB^) - lets the app search
    echo         uploaded documents efficiently instead of re-reading them fully...
    ollama pull nomic-embed-text
    if !errorlevel! neq 0 (
        echo  [!] Download failed. You can try again later with:
        echo      ollama pull nomic-embed-text
    )
)

echo.
echo  ============================================
echo   Optional: Additional Models
echo  ============================================
echo.
echo  The app supports several modes, each with a recommended model:
echo.
echo    Chat (fast):      qwen2.5:14b   (~8 GB)
echo    Chat (deep):      qwen3:14b     (~9 GB)
echo    Code assistant:   qwen2.5-coder:7b  (~4 GB)
echo    Image analysis:   qwen2.5vl:7b  (~5 GB)
echo    Web search:       qwen2.5:7b    (~4 GB)
echo.
echo  You can download these anytime from the Models tab in the app,
echo  or by running:  ollama pull ^<model-name^>
echo.

:: ============================================================
::  Done!
:: ============================================================
echo  ============================================
echo   Setup complete!
echo  ============================================
echo.
echo   To start the app:
echo     Double-click  start.bat
echo.
echo   To download more models later:
echo     ollama pull ^<model-name^>
echo.
pause
