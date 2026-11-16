@echo off
setlocal
cd /d "%~dp0"
where py >nul 2>nul
if errorlevel 1 (
  echo Python launcher not found. Install Python 3.12 from python.org.
  pause
  exit /b 1
)
where npm.cmd >nul 2>nul
if errorlevel 1 (
  echo npm not found. Install Node.js LTS and reopen this terminal.
  pause
  exit /b 1
)
if not exist "backend\.venv\Scripts\python.exe" (
  echo Creating Python 3.12 environment...
  py -3.12 -m venv "backend\.venv"
  if errorlevel 1 (pause & exit /b 1)
)
if not exist "backend\.venv\.gr2lite-setup" (
  echo Installing backend dependencies for the first time...
  pushd "backend"
  ".venv\Scripts\python.exe" -m pip install -e .
  if errorlevel 1 (popd & pause & exit /b 1)
  popd
  echo ready>"backend\.venv\.gr2lite-setup"
) else (
  echo Backend environment already prepared.
)
if not exist "frontend\node_modules" (
  echo Installing browser dependencies...
  pushd "frontend"
  call npm.cmd install
  if errorlevel 1 (popd & pause & exit /b 1)
  popd
)
echo Starting experimental incremental KMOB Level-II viewer...
echo NOTE: This uses real-time Level-II chunks, with completed-volume fallback.
start "GR2Lite Backend" cmd /k "cd /d ""%~dp0backend"" && set GR2LITE_MODE=chunks&& set GR2LITE_HISTORY_DIR=data\history&& set GR2LITE_HISTORY_MINUTES=60&& .venv\Scripts\python.exe -m uvicorn gr2lite.api:app --host 127.0.0.1 --port 8000"
start "GR2Lite Frontend" cmd /k "cd /d ""%~dp0frontend"" && npm.cmd run dev"
start "" "http://127.0.0.1:5173/GR2Lite/"
echo Two windows are running. Close them to stop GR2Lite.
