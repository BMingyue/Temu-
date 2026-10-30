@echo off
setlocal
title Temu Compliance Warning Status
cd /d "%~dp0"
if not exist "%~dp0logs\compliance-latest.log" (
  echo No compliance run log exists yet. Run START-COMPLIANCE.cmd first.
) else (
  type "%~dp0logs\compliance-latest.log"
)
echo.
echo Press any key to close this window.
pause >nul
endlocal
