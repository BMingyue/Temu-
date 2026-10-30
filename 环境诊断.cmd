@echo off
setlocal
cd /d "%~dp0"
for %%F in (*.exe) do (
  start "" /wait "%%~fF" --diagnose
  exit /b
)
echo Program missing. Extract the complete ZIP before running.
pause
exit /b 1
