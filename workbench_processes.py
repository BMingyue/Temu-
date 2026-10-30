"""Identify workbench services by executable and exact script path."""
from pathlib import Path
import os
import stat
import psutil

BACKEND_PORT = int(os.environ.get('TEMU_WORKBENCH_PORT', '18769'))
WEB_PORT = int(os.environ.get('TEMU_WORKBENCH_WEB_PORT', '5173'))

PYTHON_SERVICES = {'backend.py', 'portable_web.py', 'service_supervisor.py', 'launcher.py', 'restart_workbench.py', 'ensure_supervisor.py'}

def is_link_path(path):
    path = Path(path)
    if path.is_symlink():
        return True
    try:
        info = path.lstat()
    except FileNotFoundError:
        return False
    # Path.is_junction is unavailable in the bundled Python 3.11.
    return bool(getattr(info, 'st_file_attributes', 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT)


def service_root(process):
    try:
        args = process.cmdline()
        if len(args) < 2:
            return None
        exe = Path(process.exe()).name.lower()
        if exe in {'python.exe', 'pythonw.exe'}:
            args = list(args)
            while len(args) > 1 and args[1] in {'-E','-B'}:
                args.pop(1)
        if args[1].startswith('-'):
            return None
        script = Path(args[1])
        if not script.is_absolute():
            script = Path(process.cwd()) / script
        original_script = script
        script = script.resolve()
        if exe in {'python.exe', 'pythonw.exe'} and script.name in PYTHON_SERVICES and len(args) == 2:
            root = script.parent
        elif exe == 'node.exe' and script.name == 'cli.js' and 'dev' in args[2:]:
            # pnpm resolves the CLI into .pnpm; retain the installation root.
            candidates = [Path(process.cwd()).resolve(), original_script.parents[3].resolve()]
            root = next((candidate for candidate in candidates
                         if (candidate/'backend.py').is_file() and (candidate/'launcher.py').is_file()
                         and script == (candidate/'node_modules/vinext/dist/cli.js').resolve()), None)
            if root is None:
                return None
        else:
            return None
        if not (root / 'backend.py').is_file() or not (root / 'launcher.py').is_file():
            return None
        return root
    except (psutil.Error, OSError, ValueError, IndexError):
        return None

def listener_roots(ports=None):
    ports = ports or (BACKEND_PORT, WEB_PORT)
    result = {}
    for item in psutil.net_connections(kind='tcp'):
        if item.status == psutil.CONN_LISTEN and item.laddr and item.laddr.port in ports:
            root = None
            if item.pid:
                try:
                    root = service_root(psutil.Process(item.pid))
                except psutil.Error:
                    pass
            port = item.laddr.port
            result[port] = root if port not in result or result[port] == root else None
    return result

def check_ports(root, ports=None):
    root = Path(root).resolve()
    for port, owner in listener_roots(ports).items():
        if owner != root:
            label = str(owner) if owner else '其他程序（未识别为工作台）'
            raise RuntimeError(
                f'端口 {port} 仍由 {label} 占用。\n'
                '全新安装请运行 INSTALL.cmd，自动识别并关闭旧工作台；'
                '保留数据升级请运行 UPDATE.cmd，选择旧工作台文件夹；'
                '程序会备份并原地更新。不要直接打开新旧两份工作台。'
            )

def stop_services(root):
    root = Path(root).resolve()
    targets = [p for p in psutil.process_iter() if p.pid != os.getpid() and service_root(p) == root]
    controls, services = [], []
    for process in targets:
        try:
            names = {Path(arg).name for arg in process.cmdline()[1:]}
            group = controls if names & {'service_supervisor.py','ensure_supervisor.py','launcher.py','restart_workbench.py'} else services
            group.append(process)
        except psutil.NoSuchProcess:
            pass
    # Stop all restart-capable entry points before stopping the HTTP children.
    for group in (controls, services):
        for process in group:
            try:
                if service_root(process) != root:
                    raise RuntimeError('服务身份变化，更新已取消')
                process.terminate()
            except psutil.NoSuchProcess:
                pass
        _, alive = psutil.wait_procs(group, timeout=12)
        if alive:
            raise RuntimeError('旧工作台仍未退出，请停止任务并正常退出后重试')
    if any(service_root(p) == root for p in psutil.process_iter()):
        raise RuntimeError('旧工作台被其他启动入口重新拉起，请关闭其自动启动后重试')
