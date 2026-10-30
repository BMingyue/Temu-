"""Open the bundled, user-owned migration UI; no copy operation is started."""
import os
from pathlib import Path
import subprocess
import sys

def main():
 root=Path(__file__).resolve().parent
 powershell=Path(os.environ.get('SystemRoot',r'C:\Windows'))/'System32/WindowsPowerShell/v1.0/powershell.exe'
 # Same per-process execution options as the tool's existing launch shortcut.
 return subprocess.call([str(powershell),'-NoProfile','-ExecutionPolicy','Bypass','-STA','-WindowStyle','Hidden','-File',str(root/'LongPathMover.ps1')],cwd=root,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))

if __name__=='__main__':sys.exit(main())
