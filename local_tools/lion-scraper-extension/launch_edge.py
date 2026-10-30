from pathlib import Path
import os
import subprocess


ROOT = Path(__file__).resolve().parents[2] / 'browser_extension'


def first_existing(paths):
    return next((path for path in paths if path.is_file()), None)


local = Path(os.environ.get('LOCALAPPDATA', ''))
program_files = Path(os.environ.get('PROGRAMFILES', ''))
program_files_x86 = Path(os.environ.get('PROGRAMFILES(X86)', ''))
browser = first_existing([
    program_files_x86 / 'Microsoft/Edge/Application/msedge.exe',
    program_files / 'Microsoft/Edge/Application/msedge.exe',
    local / 'Microsoft/Edge/Application/msedge.exe',
])
if not browser:
    raise SystemExit('未找到 Microsoft Edge')

subprocess.Popen(['explorer.exe', str(ROOT)])
subprocess.Popen([str(browser), 'edge://extensions/'])
