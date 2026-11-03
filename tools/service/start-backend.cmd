@echo off
setlocal
set "SCRIPT_DIR=%~dp0"
set "SIBLING_APP_DIR=%SCRIPT_DIR%..\..\..\Projekt Hajs\biocore_ai\biocore_backend"
set "ALT_APP_DIR=%SCRIPT_DIR%..\..\..\biocore_ai\biocore_backend"

if defined BIOCORE_APP_DIR (
    set "TARGET_APP_DIR=%BIOCORE_APP_DIR%"
) else if exist "%SIBLING_APP_DIR%" (
    set "TARGET_APP_DIR=%SIBLING_APP_DIR%"
) else (
    set "TARGET_APP_DIR=%ALT_APP_DIR%"
)

if defined BIOCORE_PYTHON (
    set "TARGET_PYTHON=%BIOCORE_PYTHON%"
) else (
    set "TARGET_PYTHON=%TARGET_APP_DIR%\venv\Scripts\python.exe"
)

"%TARGET_PYTHON%" -m uvicorn app.main:app --app-dir "%TARGET_APP_DIR%" --host 127.0.0.1 --port 8000
endlocal

