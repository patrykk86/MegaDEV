@echo off
echo ==============================================================
echo Installing MegaDEV & BioCore 24/7 Background Services to Windows Startup
echo ==============================================================

set "TARGET_DIR=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "VBS_SCRIPT=d:\MegaDEV\tools\service\start-background-services.vbs"

if not exist "%VBS_SCRIPT%" (
    echo Error: Could not find %VBS_SCRIPT%
    pause
    exit /b 1
)

copy /Y "%VBS_SCRIPT%" "%TARGET_DIR%\MegaDevBioCoreServices.vbs" >nul

if %ERRORLEVEL% EQU 0 (
    echo.
    echo [SUCCESS] Installed to Windows Startup!
    echo Location: %TARGET_DIR%\MegaDevBioCoreServices.vbs
    echo.
    echo Both services will now automatically start in the background:
    echo 1. Every time you turn on your PC / log in to Windows
    echo 2. Completely silent (no black command prompt windows)
    echo 3. 24 hours a day, 7 days a week without Antigravity needing to be open.
    echo.
    echo To start them right now without rebooting, run:
    echo   wscript "d:\MegaDEV\tools\service\start-background-services.vbs"
) else (
    echo.
    echo [ERROR] Failed to copy script to Startup folder.
)

pause

