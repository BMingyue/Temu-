@echo off
chcp 65001 >nul
cd /d "%~dp0"
if exist "runtime\python\pythonw.exe" (
  start "" "runtime\python\pythonw.exe" -E -B "release\sync_uploader_component.py"
  exit /b 0
)
py -3 "release\sync_uploader_component.py"
if errorlevel 1 (
  echo 请从完整工作台安装目录运行，或由维护人员补齐 Python 运行环境。
  pause
)
