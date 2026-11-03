@echo off
echo Stopping BioCore backend and Telegram gateway...
taskkill /F /IM uvicorn.exe 2>nul
for /f "tokens=2" %%i in ('wmic process where "commandline like '%%telegram-bot.mjs%%' or commandline like '%%run-gateway.mjs%%' or commandline like '%%start-backend.cmd%%' or commandline like '%%start-gateway.cmd%%'" get processid 2^>nul ^| findstr /r "[0-9]"') do (
  taskkill /F /PID %%i 2>nul
)
echo Services stopped successfully.
