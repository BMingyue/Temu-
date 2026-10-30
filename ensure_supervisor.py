"""One-shot scheduled task that restores the exact D-drive supervisor if missing."""
import subprocess
import time
import traceback

import launcher


ROOT = launcher.ROOT
DATA = ROOT / 'data'
SUPERVISOR = launcher.SUPERVISOR


def append_log(message):
    DATA.mkdir(exist_ok=True)
    with (DATA / 'supervisor-task.log').open('a', encoding='utf-8') as log:
        log.write(time.strftime('%Y-%m-%d %H:%M:%S ') + message.rstrip() + '\n')


def ensure_supervisor():
    if launcher.supervisor_running():
        return False
    DATA.mkdir(exist_ok=True)
    result = subprocess.run(
        ['schtasks.exe', '/Run', '/TN', launcher.SUPERVISOR_TASK],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=10,
        creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
    )
    if result.returncode != 0:
        raise RuntimeError(f'请求 supervisor 主任务失败，退出码 {result.returncode}')
    append_log('检测到 supervisor 缺失，已请求运行主任务')
    return True


if __name__ == '__main__':
    try:
        ensure_supervisor()
    except BaseException as error:
        detail = ''.join(traceback.format_exception(type(error), error, error.__traceback__))
        append_log('恢复 supervisor 失败：\n' + detail)
        raise
