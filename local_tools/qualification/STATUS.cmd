@echo off
setlocal
title Temu Photo Uploader Status
cd /d "%~dp0"
if not exist "%~dp0logs\latest.log" (
  echo No run log exists yet. Run START.cmd first.
) else (
  type "%~dp0logs\latest.log"
)
echo.
echo Press any key to close this window.
pause >nul
endlocal
