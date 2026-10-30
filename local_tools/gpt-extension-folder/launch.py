import subprocess
from pathlib import Path

folder=Path(__file__).resolve().parents[2]/'gpt_chrome_extension'
subprocess.Popen(['explorer.exe',str(folder)])
