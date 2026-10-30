"""Keep this workspace's data service alive independently of browser tabs."""
import json
import os
import subprocess
import sys
import time
import traceback
import urllib.request
from contextlib import contextmanager
from pathlib import Path
import psutil
from restart_workbench import is_our_backend
from workbench_version import VERSION, identity
from workbench_processes import check_ports, BACKEND_PORT, WEB_PORT

ROOT = Path(__file__).resolve().parent
DATA = ROOT / 'data'
NODE = ROOT / 'runtime' / 'node.exe'
VINEXT = ROOT / 'node_modules' / 'vinext' / 'dist' / 'cli.js'
PORTABLE = (ROOT / 'web-dist/index.html').is_file()
WEB_SERVER = ROOT / 'portable_web.py'
FRONTEND_STARTUP_GRACE = 180
HEARTBEAT_INTERVAL = 30
HEARTBEAT = DATA / 'supervisor-heartbeat.json'


def append_supervisor_log(message):
    DATA.mkdir(exist_ok=True)
    with (DATA / 'supervisor.log').open('a', encoding='utf-8') as log:
        log.write(time.strftime('%Y-%m-%d %H:%M:%S ') + message.rstrip() + '\n')


def write_heartbeat(status, backend=None, frontend=None, detail=''):
    """Atomically publish supervisor liveness for diagnosis and watchdog checks."""
    DATA.mkdir(exist_ok=True)
    payload = {
        'pid': os.getpid(),
        'status': status,
        'timestamp': time.strftime('%Y-%m-%d %H:%M:%S'),
        'epoch': time.time(),
        'backend_healthy': backend,
        'frontend_healthy': frontend,
        'detail': detail,
    }
    temporary = HEARTBEAT.with_suffix('.json.tmp')
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding='utf-8')
    os.replace(temporary, HEARTBEAT)


def healthy():
    try:
        with urllib.request.urlopen(f'http://127.0.0.1:{BACKEND_PORT}/api/health', timeout=4) as response:
            info = json.load(response)
            return info.get('service') == 'temu-workbench' and info.get('version') == VERSION and info.get('installation_id') == identity(ROOT)
    except (OSError, ValueError):
        return False


def listener_process(port):
    for connection in psutil.net_connections(kind='tcp'):
        if connection.status == psutil.CONN_LISTEN and connection.laddr and connection.laddr.port == port and connection.pid:
            try:
                return psutil.Process(connection.pid)
            except psutil.NoSuchProcess:
                return None
    return None


def backend_healthy():
    process = listener_process(BACKEND_PORT)
    if process is None or not is_our_backend(process):
        return False
    return healthy()


def frontend_http_healthy():
    try:
        with urllib.request.urlopen(f'http://127.0.0.1:{WEB_PORT}/api/health', timeout=4) as response:
            info = json.load(response)
            return info.get('service') == 'temu-workbench' and info.get('version') == VERSION and info.get('installation_id') == identity(ROOT)
    except (OSError, ValueError):
        return False


def is_our_frontend(process):
    try:
        args = process.cmdline()
        if PORTABLE:
            if len(args) != 2 or Path(process.exe()).resolve() != Path(sys.executable).resolve():
                return False
            script = Path(args[1])
            if not script.is_absolute():
                script = Path(process.cwd()) / script
            return script.resolve() == WEB_SERVER.resolve()
        if len(args) < 3 or Path(process.exe()).resolve() != NODE.resolve():
            return False
        cli = Path(args[1])
        if not cli.is_absolute():
            cli = Path(process.cwd()) / cli
        return cli.resolve() == VINEXT.resolve() and 'dev' in args[2:]
    except (psutil.Error, OSError, ValueError):
        return False


def our_frontend_processes():
    return [process for process in psutil.process_iter() if is_our_frontend(process)]


def frontend_healthy():
    process = listener_process(WEB_PORT)
    return process is not None and is_our_frontend(process) and frontend_http_healthy()


def frontend_starting(processes):
    now = time.time()
    for process in processes:
        try:
            if now - process.create_time() < FRONTEND_STARTUP_GRACE:
                return True
        except (psutil.Error, OSError, ValueError):
            pass
    return False


@contextmanager
def frontend_launch_lock():
    import msvcrt
    DATA.mkdir(exist_ok=True)
    with (DATA / 'frontend-launch.lock').open('a+b') as lock:
        lock.seek(0); lock.write(b'0'); lock.flush(); lock.seek(0)
        try:
            msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError:
            yield False
            return
        try:
            yield True
        finally:
            lock.seek(0)
            try:
                msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)
            except OSError:
                pass


def stop_frontend_processes(targets):
    for process in targets:
        try:
            if is_our_frontend(process):
                process.terminate()
        except psutil.NoSuchProcess:
            pass
    _, alive = psutil.wait_procs(targets, timeout=8)
    for process in alive:
        if is_our_frontend(process):
            process.kill()
    _, alive = psutil.wait_procs(alive, timeout=4)
    if alive:
        raise RuntimeError('旧页面服务仍未退出，稍后重试')


def restart_frontend(recycle=False):
    # Never terminate a process merely because it owns port 5173. Only
    # processes verified as this workspace's Vinext instance may be recycled.
    with frontend_launch_lock() as acquired:
        if not acquired:
            return False
        targets = our_frontend_processes()
        if targets and not recycle:
            return False
        if recycle:
            stop_frontend_processes(targets)
        if listener_process(WEB_PORT) is not None:
            raise RuntimeError('端口 5173 已被其他程序占用，未启动页面服务')
        if PORTABLE:
            if not WEB_SERVER.is_file():
                raise RuntimeError('便携页面服务缺失')
            command = [sys.executable, str(WEB_SERVER)]
        else:
            if not NODE.is_file() or not VINEXT.is_file():
                raise RuntimeError('前端运行环境缺失')
            command = [str(NODE), str(VINEXT), 'dev']
        env = os.environ.copy()
        env['PATH'] = str(NODE.parent) + os.pathsep + env.get('PATH', '')
        with (DATA / 'frontend.log').open('ab') as output:
            subprocess.Popen(command, cwd=ROOT,
                             stdout=output, stderr=output, env=env,
                              creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        return True


def restart_backend():
    # Only a verified backend script in this workspace may be stopped.
    targets = [p for p in psutil.process_iter() if is_our_backend(p)]
    for process in targets:
        try:
            if is_our_backend(process):
                process.terminate()
        except psutil.NoSuchProcess:
            pass
    _, alive = psutil.wait_procs(targets, timeout=8)
    for process in alive:
        if is_our_backend(process):
            process.kill()
    _, alive = psutil.wait_procs(alive, timeout=4)
    if alive:
        raise RuntimeError('旧数据服务仍未退出，稍后重试')
    with (DATA / 'backend.log').open('ab') as output:
        subprocess.Popen([sys.executable, str(ROOT / 'backend.py')], cwd=ROOT,
                         stdout=output, stderr=output, env=os.environ.copy(),
                          creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))


def main():
    import msvcrt
    check_ports(ROOT)
    DATA.mkdir(exist_ok=True)
    with (DATA / 'supervisor.lock').open('a+b') as lock:
        lock.seek(0); lock.write(b'0'); lock.flush(); lock.seek(0)
        try:
            msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError:
            append_supervisor_log('守护进程已运行，本次重复启动安全退出')
            return
        append_supervisor_log(f'守护进程启动，PID={os.getpid()}')
        write_heartbeat('starting')
        failures = 0
        frontend_failures = 0
        last_heartbeat = 0.0
        while True:
            alive = backend_healthy()
            failures = 0 if alive else failures + 1
            # A missing process is recovered immediately; a nonresponsive one
            # needs three failed probes to avoid restarting on a brief spike.
            if not alive and (failures >= 3 or not any(is_our_backend(p) for p in psutil.process_iter())):
                try:
                    restart_backend()
                    append_supervisor_log('数据服务失联，已自动恢复')
                    failures = 0
                except Exception as error:
                    append_supervisor_log('数据服务恢复失败：' + str(error))
            frontend_processes = our_frontend_processes()
            frontend_alive = frontend_healthy()
            frontend_failures = 0 if frontend_alive else frontend_failures + 1
            if not frontend_alive and (
                not frontend_processes
                or (frontend_failures >= 3 and not frontend_starting(frontend_processes))
            ):
                try:
                    if restart_frontend(recycle=bool(frontend_processes)):
                        append_supervisor_log('页面服务失联，已自动恢复')
                    frontend_failures = 0
                except Exception as error:
                    append_supervisor_log('页面服务恢复失败：' + str(error))
            if time.monotonic() - last_heartbeat >= HEARTBEAT_INTERVAL:
                write_heartbeat('running', backend=alive, frontend=frontend_alive)
                last_heartbeat = time.monotonic()
            time.sleep(5)


if __name__ == '__main__':
    try:
        main()
    except BaseException as error:
        detail = ''.join(traceback.format_exception(type(error), error, error.__traceback__))
        try:
            append_supervisor_log('守护进程异常退出：\n' + detail)
            write_heartbeat('crashed', detail=str(error))
        finally:
            raise
