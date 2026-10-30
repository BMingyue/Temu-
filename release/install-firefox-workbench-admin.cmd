@echo off
setlocal

REM One-time elevated launcher for the Firefox workbench policy installer.
fltmc >nul 2>&1
if not "%errorlevel%"=="0" (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -Verb RunAs -FilePath '%~f0'"
  exit /b 0
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-firefox-workbench.ps1" -UseInstallDirectoryPolicy
if not "%errorlevel%"=="0" (
  echo.
  echo Firefox workbench installation failed. See the message above.
)
pause
