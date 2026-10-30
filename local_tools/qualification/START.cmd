@echo off
setlocal
title Temu Photo Uploader
cd /d "%~dp0"
if not exist "%~dp0runtime\node.exe" (
  echo ERROR: runtime\node.exe is missing.
  echo Extract the complete ZIP package, then run START.cmd again.
  echo.
  pause
  exit /b 1
)
"%~dp0runtime\node.exe" "%~dp0temu-local-uploader.js"
echo.
echo The uploader has stopped. Press any key to close this window.
pause >nul
endlocal
