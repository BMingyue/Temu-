@echo off
setlocal
title Check Temu Photo Uploader
cd /d "%~dp0"
if not exist "%~dp0runtime\node.exe" (
  echo ERROR: runtime\node.exe is missing.
  echo Extract the complete ZIP package, then run CHECK.cmd again.
  echo.
  pause
  exit /b 1
)
"%~dp0runtime\node.exe" "%~dp0temu-local-uploader.js" --check
echo.
echo Press any key to close this window.
pause >nul
endlocal
