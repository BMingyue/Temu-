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
    local / 'Google/Chrome/Application/chrome.exe',
    program_files / 'Google/Chrome/Application/chrome.exe',
    program_files_x86 / 'Google/Chrome/Application/chrome.exe',
])
if not browser:
    raise SystemExit('未找到 Google Chrome')

subprocess.Popen(['explorer.exe', str(ROOT)])
subprocess.Popen([str(browser), 'chrome://extensions/'])
