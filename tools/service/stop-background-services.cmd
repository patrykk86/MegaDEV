@echo off
echo Stopping BioCore backend...
taskkill /F /IM uvicorn.exe 2>nul
for /f "tokens=2" %%i in ('wmic process where "commandline like '%%start-backend.cmd%%'" get processid 2^>nul ^| findstr /r "[0-9]"') do (
  taskkill /F /PID %%i 2>nul
)
echo Services stopped successfully.
