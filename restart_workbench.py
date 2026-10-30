"""Restart only this workspace's backend; never terminate by process name/port."""
import os
import subprocess
import sys
import time
from pathlib import Path
import psutil

ROOT = Path(__file__).resolve().parent


def is_our_backend(process):
    try:
        args = process.cmdline()
        if Path(process.exe()).name.lower() not in ('python.exe', 'pythonw.exe'):
            return False
        # The script must be the first argument, not text inside another command.
        if len(args) < 2:
            return False
        script = Path(args[1])
        if not script.is_absolute():
            script = Path(process.cwd()) / script
        return script.resolve() == (ROOT / 'backend.py').resolve()
    except (psutil.Error, OSError, ValueError):
        return False


def main():
    import msvcrt
    logs = ROOT / 'data'
    logs.mkdir(exist_ok=True)
    with open(logs / 'restart.lock', 'a+b') as lock:
        lock.seek(0); lock.write(b'0'); lock.flush(); lock.seek(0)
        try:
            msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError:
            return
        # Allow the HTTP acknowledgement to reach the requesting page.
        time.sleep(2)
        if len(sys.argv) == 3:
            try:
                process = psutil.Process(int(sys.argv[1]))
                if abs(process.create_time() - float(sys.argv[2])) > .01 or not is_our_backend(process):
                    raise RuntimeError('进程身份变化，取消重启')
                targets = [process]
            except psutil.NoSuchProcess:
                targets = []
        elif len(sys.argv) == 1:
            targets = [p for p in psutil.process_iter() if is_our_backend(p)]
        else:
            raise RuntimeError('重启参数无效')
        for process in targets:
            if not is_our_backend(process):
                raise RuntimeError('无法再次确认进程身份')
            process.terminate()
        _, alive = psutil.wait_procs(targets, timeout=20)
        if alive:
            raise RuntimeError('旧服务尚未退出，未启动第二个实例')
        flags = getattr(subprocess, 'CREATE_NO_WINDOW', 0)
        # Reuse the existing launcher to check both services and open the workbench.
        subprocess.Popen([sys.executable, str(ROOT / 'launcher.py')], cwd=ROOT,
                         creationflags=flags, env=os.environ.copy())


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        with open(ROOT / 'data' / 'restart.log', 'a', encoding='utf-8') as log:
            log.write(time.strftime('%Y-%m-%d %H:%M:%S ') + str(error) + '\n')
        sys.exit(1)
