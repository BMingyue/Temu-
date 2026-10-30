@echo off
setlocal
title Temu Compliance Warning Check
cd /d "%~dp0"
"%~dp0runtime\node.exe" "%~dp0temu-local-uploader.js" --confirm-warnings --check
echo.
echo Press any key to close this window.
pause >nul
endlocal
