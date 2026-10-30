import subprocess
from pathlib import Path
ROOT=Path(__file__).resolve().parent
subprocess.Popen([str(ROOT/"runtime/node.exe"),str(ROOT/"temu-local-uploader.js")],cwd=ROOT,creationflags=subprocess.CREATE_NEW_CONSOLE)
