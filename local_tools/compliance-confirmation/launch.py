import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / 'qualification'
subprocess.Popen(
    [str(ROOT / 'runtime/node.exe'), str(ROOT / 'temu-local-uploader.js'), '--confirm-warnings'],
    cwd=ROOT,
    creationflags=subprocess.CREATE_NEW_CONSOLE,
)
