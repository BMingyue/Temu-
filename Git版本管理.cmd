@echo off
chcp 65001 >nul
cd /d "%~dp0"
if exist "%~dp0runtime\python\pythonw.exe" (
  start "" "%~dp0runtime\python\pythonw.exe" -E -B "%~dp0maintenance\git_manager.py" --repo "%~dp0."
  exit /b 0
)
where pythonw.exe >nul 2>nul
if not errorlevel 1 (
  start "" pythonw.exe -E -B "%~dp0maintenance\git_manager.py" --repo "%~dp0."
  exit /b 0
)
where py.exe >nul 2>nul
if not errorlevel 1 (
  py -3 -E -B "%~dp0maintenance\git_manager.py" --repo "%~dp0."
  if errorlevel 1 pause
  exit /b
)
echo 未找到 Python 运行环境。请从完整工作台源码目录使用，或安装带 Tk 的 Python 3。
pause
exit /b 1
