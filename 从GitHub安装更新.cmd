@echo off
setlocal
chcp 65001 >nul
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0maintenance\github_workbench_update.ps1" %*
set "WB_DOWNLOAD_EXIT=%ERRORLEVEL%"
if not "%WB_DOWNLOAD_EXIT%"=="0" pause
exit /b %WB_DOWNLOAD_EXIT%
