"""Offline in-place updater. Run from a separately extracted, verified release."""
from __future__ import annotations
import argparse
from contextlib import contextmanager
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
import uuid
import psutil
from workbench_processes import is_link_path, listener_roots, service_root, stop_services

ROOT = Path(__file__).resolve().parent
ROOT_FILES = {
    'backend.py','merchant.py','collector.py','operations.py','sync_audit.py',
    'collector_control.py','image_jobs.py','image_workflows.py','image_source_edits.py','image_job_retry.py','gpt_browser_profiles.py','gpt_runner.py',
    'gpt_extension_bridge.py','gpt_unattended.py','activity_jobs.py',
    'activity_enrollment.py','price_window.py','feature_tools.py','patrol_health.py','patrol_traffic.py','colleague_browser.py',
    'product_operations.py','product_rules.py','launcher.py','service_supervisor.py',
    'restart_workbench.py','portable_web.py','启动工作台.vbs',
    'workbench_version.py','workbench_processes.py','workbench-release.json',
    'update_workbench.py','install_workbench.py','stop_workbench.py','START.cmd','STOP.cmd','UPDATE.cmd','INSTALL.cmd',
    '使用说明.md','同事使用指南.txt','检查运行环境.cmd','diagnose_workbench.py','版本信息.json','SHA256SUMS.txt',
}
ROOT_FILES.update({'workbench-components.json','delta_update_workbench.py'})
ROOT_FILES.update({'从GitHub安装更新.cmd','maintenance/github_workbench_update.ps1'})
ROOT_DIRS = {'runtime','web-dist','browser_extension','gpt_chrome_extension','source','local_tools','image_presets'}
PRIVATE_PARTS = {'data','state','logs','__pycache__','.git','.migration','.openai'}

def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream,'sha256').hexdigest()

def safe_path(root, relative):
    root = Path(root).resolve()
    rel = PurePosixPath(relative)
    if rel.is_absolute() or not rel.parts or any(x in {'.','..'} or ':' in x or '\\' in x for x in rel.parts):
        raise RuntimeError('更新包路径无效：'+relative)
    path = root.joinpath(*rel.parts)
    current = root
    for part in rel.parts:
        current = current / part
        if is_link_path(current):
            raise RuntimeError('更新路径含目录链接，需人工核对：'+str(current))
    if not path.resolve().is_relative_to(root):
        raise RuntimeError('更新路径超出原目录：'+relative)
    return path

def preserve(relative):
    parts = PurePosixPath(relative).parts
    return bool(PRIVATE_PARTS.intersection(parts)) or parts[:3] == ('local_tools','qualification','assets')

def managed(relative):
    parts = PurePosixPath(relative).parts
    return not preserve(relative) and (relative in ROOT_FILES or parts[0] in ROOT_DIRS)

def version_tuple(value):
    if not re.fullmatch(r'\d+(?:\.\d+){1,4}', value):
        raise RuntimeError('版本号无效')
    return tuple(map(int,value.split('.')))

def read_release(root):
    return json.loads((Path(root)/'workbench-release.json').read_text(encoding='utf-8'))

def _verify_package(source, complete=False):
    source = Path(source).resolve()
    release = read_release(source)
    if release.get('product') != 'temu-workbench':
        raise RuntimeError('不是完整工作台更新包')
    version_tuple(release['version'])
    inventory = {}
    folded = set()
    for line in (source/'SHA256SUMS.txt').read_text(encoding='utf-8-sig').splitlines():
        sha, relative = line.split('  ',1)
        path = safe_path(source,relative)
        if not re.fullmatch(r'[0-9a-f]{64}',sha) or relative.casefold() in folded or relative == 'SHA256SUMS.txt':
            raise RuntimeError('校验清单无效')
        if not path.is_file() or digest(path) != sha:
            raise RuntimeError('更新包不完整或已修改：'+relative+'。请重新完整解压原始 ZIP。')
        if not managed(relative) and not preserve(relative):
            raise RuntimeError('更新包包含未管理文件：'+relative)
        if complete and PRIVATE_PARTS.intersection(part.casefold() for part in PurePosixPath(relative).parts):
            raise RuntimeError('全新安装包混入运行数据，请重新解压原始 ZIP：'+relative)
        folded.add(relative.casefold())
        inventory[relative] = sha
    required = {'backend.py','launcher.py','portable_web.py','service_supervisor.py',
                'workbench-release.json','workbench_version.py','workbench_processes.py',
                'web-dist/index.html','browser_extension/manifest.json','runtime/python/python.exe','update_workbench.py'}
    if not required.issubset(inventory):
        raise RuntimeError('缺少必要更新文件')
    info = json.loads((source/'版本信息.json').read_text(encoding='utf-8'))
    if info.get('release') != release['version'] or info.get('contains_user_data') is not False:
        raise RuntimeError('发布版本信息不一致')
    result = dict(inventory) if complete else {name:sha for name,sha in inventory.items() if managed(name)}
    result['SHA256SUMS.txt'] = digest(source/'SHA256SUMS.txt')
    return result

def verify_package(source, complete=False):
    try:
        return _verify_package(source, complete=complete)
    except RuntimeError:
        raise
    except (OSError, ValueError, KeyError, TypeError) as error:
        filename = getattr(error, 'filename', None)
        detail = str(filename or error)
        raise RuntimeError(
            '安装文件校验失败：'+detail+'\n请先右键 ZIP 选择“全部解压”，'
            '再从解压后的完整文件夹运行 INSTALL.cmd。不要在压缩软件内运行，也不要只复制插件。'
        ) from error


def validate_target(source, target):
    source, target = Path(source).resolve(), Path(target).resolve()
    if target == source or target.is_relative_to(source) or source.is_relative_to(target):
        raise RuntimeError('请将新版完整解压到单独目录，再选择原工作台文件夹；不要先手动覆盖。')
    if not (target/'backend.py').is_file() or not (target/'launcher.py').is_file() or not (target/'browser_extension/manifest.json').is_file():
        raise RuntimeError('请选择包含 backend.py、launcher.py、browser_extension 的原工作台文件夹。')
    safe_path(target,'data')
    if Path(sys.executable).resolve().is_relative_to(target):
        raise RuntimeError('更新程序正在使用旧目录的运行环境，请从新版 UPDATE.cmd 启动。')
    if (target/'workbench-release.json').is_file():
        if version_tuple(read_release(target)['version']) > version_tuple(read_release(source)['version']):
            raise RuntimeError('原目录版本比更新包新，已拒绝降级。')
    for port, owner in listener_roots().items():
        if owner != target:
            raise RuntimeError(f'端口 {port} 属于另一目录或其他程序，请先正常关闭该服务再更新所选目录。')
    return target

def assert_quiet(target):
    # Only the five exact workbench scripts may be stopped. Tool jobs must end normally.
    for process in psutil.process_iter():
        try:
            if process.pid == os.getpid() or service_root(process) == target:
                continue
            exe = Path(process.exe()).resolve()
            args = process.cmdline()
            script = Path(args[1]) if len(args)>1 and not args[1].startswith('-') else None
            if script and not script.is_absolute():
                script = Path(process.cwd()) / script
            owned = exe.is_relative_to(target) or (script is not None and script.resolve().is_relative_to(target))
            if owned:
                raise RuntimeError('原目录还有工具或任务运行，请先正常停止：'+process.name())
        except (psutil.NoSuchProcess,psutil.AccessDenied):
            pass

def atomic_copy(source, target, expected=None):
    target.parent.mkdir(parents=True,exist_ok=True)
    temporary = target.with_name(target.name+'.update-'+uuid.uuid4().hex)
    try:
        shutil.copy2(source,temporary)
        if expected is not None and digest(temporary) != expected:
            raise RuntimeError('更新文件复制校验失败：'+str(target))
        os.replace(temporary,target)
    finally:
        if temporary.exists():
            temporary.unlink()

@contextmanager
def update_lock(target):
    import msvcrt
    lock_path = target/'data/update.lock'
    lock_path.parent.mkdir(parents=True,exist_ok=True)
    with lock_path.open('a+b') as lock:
        lock.seek(0); lock.write(b'0'); lock.flush(); lock.seek(0)
        try:
            msvcrt.locking(lock.fileno(),msvcrt.LK_NBLCK,1)
        except OSError:
            raise RuntimeError('另一个更新程序仍在运行')
        try:
            yield
        finally:
            lock.seek(0)
            msvcrt.locking(lock.fileno(),msvcrt.LK_UNLCK,1)

def restore_files(target, backup, changes):
    # Paths are revalidated at action time; only files in the update journal are restored.
    for relative, existed in reversed(changes):
        dest = safe_path(target,relative)
        if existed:
            original = safe_path(backup/'program',relative)
            atomic_copy(original,dest,digest(original))
        elif dest.is_file():
            dest.unlink()

def apply_update(source, target, notify=print):
    source = Path(source).resolve()
    notify('正在校验完整更新包，请稍候…')
    inventory = verify_package(source)
    target = validate_target(source,target)
    # Validate every destination before stopping or changing anything.
    for relative in inventory:
        safe_path(target,relative)
    assert_quiet(target)
    changes = []
    backup = target.parent/(target.name+'-backup-'+datetime.now().strftime('%Y%m%d-%H%M%S')+'-'+uuid.uuid4().hex[:6])
    with update_lock(target):
        notify('正在停止所选原目录的工作台服务…')
        stop_services(target)
        assert_quiet(target)
        # Compare before writing, retaining untouched files and all user-only files.
        changed = {name:sha for name,sha in inventory.items()
                   if not safe_path(target,name).is_file() or digest(safe_path(target,name)) != sha}
        # A machine-local helper token is not a distributable program setting.
        if (target/'gpt_chrome_extension/config.js').is_file():
            changed.pop('gpt_chrome_extension/config.js',None)
        required_space = sum(safe_path(source,n).stat().st_size for n in changed)
        required_space += sum(p.stat().st_size for p in (target/'data').rglob('*') if p.is_file() and not p.is_symlink())
        if shutil.disk_usage(target.parent).free < required_space*2 + 50_000_000:
            raise RuntimeError('备份空间不足，请释放原目录所在磁盘的空间后重试。')
        backup.mkdir(exist_ok=False)
        notify('正在备份原数据和待更新程序…')
        if (target/'data').exists():
            shutil.copytree(target/'data',backup/'data',symlinks=True,ignore=shutil.ignore_patterns('*.lock'))
        for relative in changed:
            old = safe_path(target,relative)
            if old.is_file():
                saved = safe_path(backup/'program',relative)
                saved.parent.mkdir(parents=True,exist_ok=True)
                shutil.copy2(old,saved)
        report = {'target':str(target),'source':str(source),'version':read_release(source)['version'],
                  'backup':str(backup),'changes':[], 'status':'applying',
                  'data_preserved':True,'browser_storage_touched':False}
        journal = backup/'update-report.json'
        journal.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
        try:
            notify(f'正在原地更新 {len(changed)} 个文件…')
            # Publish the version last; partially copied files never signal completion.
            names = sorted(changed,key=lambda n:(n == 'workbench-release.json',n))
            for relative in names:
                dest = safe_path(target,relative)
                existed = dest.is_file()
                changes.append((relative,existed))
                report['changes'] = changes
                journal.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
                atomic_copy(safe_path(source,relative),dest,changed[relative])
            if any(service_root(p) == target for p in psutil.process_iter()):
                raise RuntimeError('更新期间旧服务被自动启动，请关闭旧自动启动后重试。')
            for relative,sha in changed.items():
                if digest(safe_path(target,relative)) != sha:
                    raise RuntimeError('更新后文件校验失败：'+relative)
            if not (target/'installation.json').exists():
                (target/'installation.json').write_text(json.dumps({
                    'version':read_release(source)['version'],'clean_install':False
                },ensure_ascii=False),encoding='utf-8')
            report['status'] = 'complete'
        except BaseException:
            notify('更新未完成，正在恢复原程序…')
            stop_services(target)
            restore_files(target,backup,changes)
            report['status'] = 'rolled_back'
            journal.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
            raise
        journal.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
        notify('更新完成。原数据和插件安装目录已保留。备份：'+str(backup))
    return report

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--target',type=Path)
    parser.add_argument('--apply',action='store_true',help='Apply to the explicitly specified target without the folder dialog')
    args = parser.parse_args()
    if args.apply:
        if args.target is None: parser.error('--apply requires --target')
        print(json.dumps(apply_update(ROOT,args.target),ensure_ascii=False,indent=2))
        return
    import tkinter as tk
    from tkinter import filedialog, messagebox
    app = tk.Tk(); app.withdraw()
    try:
        detected = list({p for p in listener_roots().values() if p is not None and p != ROOT})
        selected = args.target or filedialog.askdirectory(
            title='选择原工作台文件夹（保留原数据和插件路径）',
            initialdir=str(detected[0] if len(detected)==1 else ROOT.parent),mustexist=True)
        if not selected: return
        target = validate_target(ROOT,Path(selected))
        if not messagebox.askyesno('更新已有工作台',
            f'即将更新原目录：\n{target}\n\n'
            '请确认已停止采集、生图、上架和流量任务。\n'
            '将备份原数据、停止此目录的工作台服务，再原地更新。\n'
            '浏览器登录和扩展记录保留。确定继续？'): return
        report = apply_update(ROOT,target)
        messagebox.showinfo('更新完成',
            f'工作台已更新为 {report["version"]}。\n'
            f'请继续使用原快捷方式，或原目录 START.cmd 启动。\n\n'
            'Chrome/Edge 请对原统一助手点击“重新加载”，再刷新卖家页。\n'
            '不要卸载扩展，以保留记录。\n\n备份：'+report['backup'])
        if messagebox.askyesno('启动新版','现在启动原目录的新版工作台？'):
            python = target/'runtime/python/pythonw.exe'
            subprocess.Popen([str(python),str(target/'launcher.py')],cwd=target,
                             creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
    except Exception as error:
        messagebox.showerror('更新未完成',str(error))
        raise
    finally:
        app.destroy()

if __name__ == '__main__':
    main()
