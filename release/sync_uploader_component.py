"""Verify a clean uploader release, replace the bundled copy, and record its version.

This maintenance command never reads the uploader's AppData or starts a business task.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone, timedelta
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import sys
import urllib.request
import uuid

import psutil

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
PRIVATE_NAMES = {'config.json', 'state.json', 'browser-profile', 'failure-records',
                 'upload-staging', 'logs', 'protected.json', 'cleanup.jsonl'}


def sha256(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def verify_release(folder):
    folder = Path(folder).resolve(strict=True)
    manifest = json.loads((folder / '版本信息.json').read_text(encoding='utf-8-sig'))
    if manifest.get('app') != '店小秘 Temu 自动上架独立版' or not re.fullmatch(r'\d+\.\d+\.\d+', str(manifest.get('version', ''))):
        raise ValueError('不是已知格式的店小秘独立版发布目录')
    expected = {}
    for line in (folder / '文件校验SHA256.txt').read_text(encoding='utf-8-sig').splitlines():
        digest, relative = line.split('  ', 1)
        path = PurePosixPath(relative)
        if not re.fullmatch(r'[0-9a-f]{64}', digest) or path.is_absolute() or '\\' in relative or ':' in relative or '..' in path.parts or relative in expected:
            raise ValueError('发布校验清单路径或哈希无效')
        expected[relative] = digest
    actual = set()
    for path in folder.rglob('*'):
        flags = getattr(path.lstat(), 'st_file_attributes', 0)
        if path.is_symlink() or flags & stat.FILE_ATTRIBUTE_REPARSE_POINT:
            raise ValueError('发布目录不能包含目录链接')
        if path.is_file():
            relative = path.relative_to(folder).as_posix()
            if any(part.casefold() in PRIVATE_NAMES for part in path.relative_to(folder).parts):
                raise ValueError('发布目录包含账号、任务或日志文件：' + relative)
            actual.add(relative)
    if set(expected) != actual - {'文件校验SHA256.txt'} or not {'店小秘自动上架.exe', '版本信息.json'} <= set(expected):
        raise ValueError('发布目录含缺失或未校验文件')
    for relative, digest in expected.items():
        path = folder / relative
        if not path.resolve().is_relative_to(folder) or sha256(path) != digest:
            raise ValueError('发布文件校验失败：' + relative)
    return {'version': manifest['version'], 'file_count': len(actual),
            'manifest_sha256': sha256(folder / '版本信息.json'),
            'checksums_sha256': sha256(folder / '文件校验SHA256.txt')}


def require_component_closed(target):
    for process in psutil.process_iter():
        try:
            if Path(process.exe()).resolve().is_relative_to(target):
                raise ValueError('工作台内的店小秘仍在运行，请结束当前任务并正常关闭后再同步')
        except (psutil.Error, OSError):
            continue


def sync_release(source, root=ROOT):
    root = Path(root).resolve(strict=True)
    source = Path(source).resolve(strict=True)
    target = root / 'local_tools/dxm-uploader'
    if source == target or source.is_relative_to(target) or target.is_relative_to(source):
        raise ValueError('来源与工作台内置目录不能重叠')
    release = verify_release(source)
    # The directory replacement is safe only while the bundled executable and
    # its children are closed. Never terminate them or touch another edition.
    require_component_closed(target)
    component_file = root / 'workbench-components.json'
    components = json.loads(component_file.read_text(encoding='utf-8-sig')) if component_file.exists() else {'schema': 1}
    if not isinstance(components, dict):
        raise ValueError('工作台组件清单格式无效')
    components['uploader'] = release
    stamp = datetime.now(timezone(timedelta(hours=8))).strftime('%Y%m%d-%H%M%S') + '-' + uuid.uuid4().hex[:6]
    backup = root / 'data/code-backups' / ('uploader-sync-' + stamp)
    backup.mkdir(parents=True)
    if component_file.exists():
        shutil.copy2(component_file, backup / component_file.name)
    stage = root / 'local_tools' / ('.dxm-uploader-stage-' + stamp)
    stage.parent.mkdir(parents=True, exist_ok=True)
    if target.exists() and (target.is_symlink() or getattr(target.lstat(), 'st_file_attributes', 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT):
        raise ValueError('工作台内置目录不能是目录链接')
    shutil.copytree(source, stage)
    verify_release(stage)
    moved = False
    installed = False
    temporary = component_file.with_name(component_file.name + '.' + uuid.uuid4().hex + '.tmp')
    try:
        if target.exists():
            target.rename(backup / 'dxm-uploader')
            moved = True
        stage.rename(target)
        installed = True
        temporary.write_text(json.dumps(components, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        temporary.replace(component_file)
    except BaseException as error:
        # Preserve every new byte for inspection and restore the known edition.
        if installed:
            target.rename(backup / 'failed-new-uploader')
        if moved:
            (backup / 'dxm-uploader').rename(target)
        if isinstance(error, PermissionError):
            raise ValueError('工作台或其他程序仍占用工具目录，旧版已保留。请先正常停止工作台服务及上架工具，再重试同步。') from error
        raise
    result = {'ok': True, **release, 'target': str(target), 'backup': str(backup)}
    (backup / 'sync-report.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    return result


def read_local_json(path):
    from workbench_processes import BACKEND_PORT
    with urllib.request.urlopen(f'http://127.0.0.1:{BACKEND_PORT}' + path, timeout=6) as response:
        return json.load(response)


def require_idle_workbench(root):
    from workbench_processes import listener_roots, service_root
    require_component_closed(root / 'local_tools/dxm-uploader')
    running = any(service_root(process) == root for process in psutil.process_iter())
    listeners = listener_roots()
    if not running and not listeners:
        return False
    if any(owner != root for owner in listeners.values()):
        raise ValueError('工作台地址由其他目录或未识别的程序占用，未同步任何文件')
    try:
        health = read_local_json('/api/health')
        expected = hashlib.sha256(str(root).casefold().encode('utf-8')).hexdigest()[:24]
        if health.get('ok') is not True or health.get('service') != 'temu-workbench' or health.get('installation_id') != expected:
            raise ValueError('工作台身份不匹配')
        summary = read_local_json('/api/image-jobs?compact=1').get('summary', {})
        if any(type(summary.get(key)) is not int or summary[key] != 0 for key in ('active', 'queued')):
            raise ValueError('采集或生图仍有排队/执行任务')
        commands = read_local_json('/api/collector/control').get('commands')
        if not isinstance(commands, list) or any(not isinstance(command, dict) or command.get('status') in ('queued', 'running') for command in commands):
            raise ValueError('采集仍有排队/执行任务，或任务状态未能确认')
    except (OSError, ValueError, TypeError, AttributeError) as error:
        raise ValueError('暂不能安全同步：' + str(error) + '。请先完成或停止任务，再重试。') from error
    return True


def reopen_workbench(root):
    executable = root / 'runtime/python/pythonw.exe'
    if not executable.is_file():
        executable = Path(sys.executable).with_name('pythonw.exe')
    if not executable.is_file():
        executable = Path(sys.executable)
    subprocess.Popen([str(executable), str(root / 'launcher.py')], cwd=root,
                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                     creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))


def sync_with_reload(source, root=ROOT):
    # GUI only: every source byte and current business state is checked before
    # the exact installation's restart-capable service chain is paused.
    from workbench_processes import stop_services
    root = Path(root).resolve(strict=True)
    verify_release(source)
    restore = require_idle_workbench(root)
    try:
        if restore:
            stop_services(root)
        return sync_release(source, root)
    finally:
        if restore:
            reopen_workbench(root)


def wizard():
    import tkinter as tk
    from tkinter import filedialog, messagebox
    window = tk.Tk()
    window.title('同步店小秘新版')
    window.geometry('530x230')
    window.resizable(False, False)
    status = tk.StringVar(value='请选择新版发布文件夹，里面应有“店小秘自动上架.exe”和“版本信息.json”。')
    tk.Label(window, text='同步工作台里的店小秘工具', font=('Microsoft YaHei UI', 15, 'bold')).pack(pady=(22, 14))
    tk.Label(window, textvariable=status, wraplength=475, justify='left').pack(padx=25)
    def choose():
        folder = filedialog.askdirectory(parent=window, title='选择新版 DXMUploader-Windows-x64 文件夹', mustexist=True)
        if not folder:
            return
        button.config(state='disabled')
        status.set('正在检查发布文件，完成后会显示版本供你确认，请稍候……')
        window.update_idletasks()
        try:
            release = verify_release(folder)
            current = ROOT / 'workbench-components.json'
            old = json.loads(current.read_text(encoding='utf-8-sig')).get('uploader', {}).get('version', '未知') if current.exists() else '未知'
            confirm = messagebox.askyesno('确认同步版本', f'当前内置版本：{old}\n新版：{release["version"]}\n已通过全部 {release["file_count"]} 个文件检查。\n\n请先正常关闭工作台内的上架工具。\n确认后会检查排队/执行任务，安全时短暂重载本目录工作台。\n同步会备份旧版，不清除账号和完成记录，也不会开始上架。\n\n现在同步吗？', parent=window)
            if not confirm:
                status.set('已取消，没有更换内置工具。')
                return
            result = sync_with_reload(folder)
            status.set('已同步店小秘 ' + result['version'] + '。可从工作台“上新”打开工具。')
            messagebox.showinfo('同步完成', '已同步店小秘 ' + result['version'] + '。\n旧版本已保留备份。\n工作台原先运行时已请求重新打开；若原先关闭，可双击桌面入口打开。', parent=window)
        except Exception as error:
            status.set('未完成同步，请按提示处理后重试。')
            messagebox.showerror('同步未完成', str(error), parent=window)
        finally:
            button.config(state='normal')
    button = tk.Button(window, text='选择新版发布文件夹', command=choose, width=23, height=2)
    button.pack(pady=22)
    window.mainloop()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='校验并同步店小秘独立版，不读取个人账号数据。')
    parser.add_argument('source', type=Path, nargs='?')
    parser.add_argument('--check-only', action='store_true')
    args = parser.parse_args()
    if args.source is None:
        if args.check_only:
            parser.error('--check-only 需要指定发布文件夹')
        wizard()
    else:
        result = verify_release(args.source) if args.check_only else sync_release(args.source)
        print(json.dumps(result, ensure_ascii=False, indent=2))
