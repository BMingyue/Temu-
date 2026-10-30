@echo off
setlocal
title Temu Compliance Warning Confirmer
cd /d "%~dp0"
if not exist "%~dp0runtime\node.exe" (
  echo ERROR: runtime\node.exe is missing.
  echo Extract the complete ZIP package, then run START-COMPLIANCE.cmd again.
  echo.
  pause
  exit /b 1
)
"%~dp0runtime\node.exe" "%~dp0temu-local-uploader.js" --confirm-warnings
echo.
echo The compliance confirmer has stopped. Press any key to close this window.
pause >nul
endlocal
