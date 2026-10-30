"""Clean installer: stage and verify first, retire exact old installations, rollback on error."""
from __future__ import annotations
import argparse
from contextlib import contextmanager
from datetime import datetime
import json
import os
from pathlib import Path
import queue
import shutil
import subprocess
import sys
import threading
import uuid
import webbrowser
import xml.etree.ElementTree as ET

import psutil
from update_workbench import assert_quiet, digest, safe_path, verify_package
from workbench_processes import BACKEND_PORT, WEB_PORT, is_link_path, listener_roots, service_root, stop_services
from workbench_version import identity

ROOT = Path(__file__).resolve().parent
FLAGS = getattr(subprocess, 'CREATE_NO_WINDOW', 0)
TASKS = ('Temu Workbench Supervisor', 'Temu Workbench Supervisor Recovery')


def checked_path(value):
    """Reject links in all ancestors before resolving an absolute user path."""
    path = Path(os.path.abspath(value))
    for part in (path, *path.parents):
        if is_link_path(part):
            raise RuntimeError('所选路径含目录链接，请选择真实目录：'+str(part))
    return path.resolve()


def is_installation(path):
    try:
        root = Path(path)
        return all((root / name).is_file() for name in
                   ('backend.py', 'launcher.py', 'browser_extension/manifest.json'))
    except OSError:
        return False


def discover_old(source=ROOT):
    source = Path(source).resolve()
    roots = set()
    for process in psutil.process_iter():
        root = service_root(process)
        if root and root != source:
            roots.add(root)
    for root in listener_roots().values():
        if root and root != source:
            roots.add(root)
    return sorted(roots, key=str)


def port_details():
    details = []
    for item in psutil.net_connections(kind='tcp'):
        if item.status != psutil.CONN_LISTEN or not item.laddr or item.laddr.port not in (BACKEND_PORT, WEB_PORT):
            continue
        name = '未知程序'
        if item.pid:
            try:
                name = psutil.Process(item.pid).name()
            except psutil.Error:
                pass
        details.append(f'{item.laddr.port}：{name}（进程 {item.pid or "未知"}）')
    return '\n'.join(dict.fromkeys(details))


def validate_plan(source, target, old_roots):
    source, target = checked_path(source), checked_path(target)
    if len(str(target)) > 80:
        raise RuntimeError('安装路径过长，请选择较短目录，例如 D:\\TemuWorkbench。')
    roots = sorted({checked_path(p) for p in old_roots}, key=str)
    if target == source or source.is_relative_to(target) or target.is_relative_to(source):
        raise RuntimeError('请选择解压文件夹之外的安装目录，例如 D:\\TemuWorkbench。')
    if target.exists():
        if is_installation(target):
            if target not in roots:
                roots.append(target)
        elif not target.is_dir() or any(target.iterdir()):
            raise RuntimeError('安装目录包含其他文件，请选择空目录或原工作台目录。')
    for root in roots:
        if not is_installation(root):
            raise RuntimeError('不是工作台目录，未清理：'+str(root))
        if root == source or source.is_relative_to(root) or root.is_relative_to(source):
            raise RuntimeError('旧目录与解压包重叠，请把新 ZIP 单独完整解压。')
        if Path(sys.executable).resolve().is_relative_to(root):
            raise RuntimeError('安装程序正在使用旧目录的 Python，请从新版 INSTALL.cmd 启动。')
        if root != target and (root.is_relative_to(target) or target.is_relative_to(root)):
            raise RuntimeError('安装目录与旧目录不能互相包含。')
        for other in roots:
            if other != root and (root.is_relative_to(other) or other.is_relative_to(root)):
                raise RuntimeError('所选旧目录互相包含，请只选择真正的工作台根目录。')
        assert_quiet(root)
    for port, owner in listener_roots().items():
        if owner not in roots:
            raise RuntimeError(
                '检测到其他程序使用工作台地址，未关闭无关程序。\n'+port_details()+
                '\n请退出对应软件后点“重新检测”；如果是旧工作台，请用“添加旧目录”选中它。')
    return source, target, roots


def task_xml(value):
    # schtasks may declare UTF-16 while its stdout actually uses UTF-8/OEM.
    # Decode first so ElementTree cannot mistake that declaration for byte encoding.
    if isinstance(value, bytes):
        if value.startswith((b'\xff\xfe', b'\xfe\xff')) or b'\x00' in value[:128]:
            value = value.decode('utf-16')
        else:
            try:
                value = value.decode('utf-8-sig')
            except UnicodeDecodeError:
                value = value.decode('mbcs')
    return ET.fromstring(value)


def task_owned(xml, roots):
    """Only single Python actions for the known workbench tasks are eligible."""
    doc = task_xml(xml)
    actions = doc.findall('.//{*}Actions/{*}Exec')
    if len(actions) != 1:
        return False
    command = os.path.expandvars(actions[0].findtext('{*}Command', ''))
    argument = actions[0].findtext('{*}Arguments', '').strip()
    if argument.startswith('"') and argument.endswith('"'):
        argument = argument[1:-1]
    if '"' in argument or Path(command).name.lower() not in ('python.exe', 'pythonw.exe'):
        return False
    script = Path(argument)
    return script.is_absolute() and script.name in ('service_supervisor.py', 'ensure_supervisor.py') and script.parent.resolve() in roots


def disable_old_tasks(roots, backup):
    changed = []
    try:
        for name in TASKS:
            query = subprocess.run(['schtasks.exe', '/Query', '/TN', name, '/XML'],
                                   capture_output=True, creationflags=FLAGS, timeout=15)
            if query.returncode:
                continue
            raw = query.stdout
            # Normalize schtasks stdout independently of its sometimes incorrect declaration.
            if not task_owned(raw, roots):
                continue
            doc = task_xml(raw)
            if doc.findtext('.//{*}Settings/{*}Enabled', 'true') == 'false':
                continue
            (backup / (name.replace(' ', '-')+'.xml')).write_bytes(raw)
            result = subprocess.run(['schtasks.exe', '/Change', '/TN', name, '/DISABLE'],
                                    capture_output=True, creationflags=FLAGS, timeout=15)
            if result.returncode:
                raise RuntimeError('无法停用旧工作台自动启动任务：'+name+'。请使用原安装用户运行。')
            changed.append(name)
    except BaseException:
        restore_tasks(changed)
        raise
    return changed


def restore_tasks(names):
    for name in names:
        result = subprocess.run(['schtasks.exe', '/Change', '/TN', name, '/ENABLE'],
                                capture_output=True, creationflags=FLAGS, timeout=15)
        if result.returncode:
            raise RuntimeError('恢复旧自动启动任务失败：'+name)


@contextmanager
def install_lock(parent, target):
    import msvcrt
    path = parent / ('.temu-install-'+identity(target)+'.lock')
    with path.open('a+b') as stream:
        stream.seek(0); stream.write(b'0'); stream.flush(); stream.seek(0)
        try:
            msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError as error:
            raise RuntimeError('另一个安装程序正在运行，请稍候。') from error
        try:
            yield
        finally:
            stream.seek(0)
            msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)


def uploader_data():
    appdata = os.environ.get('LOCALAPPDATA')
    if not appdata:
        raise RuntimeError('无法定位当前用户的上架数据目录。')
    return checked_path(Path(appdata) / 'DianxiaomiUploaderStandalone')


def move_exact(source, destination):
    # Revalidate absolute paths at the mutation boundary. Never traverse a user tree.
    source, destination = checked_path(source), checked_path(destination)
    if destination.exists():
        raise RuntimeError('备份目录已存在：'+str(destination))
    source.rename(destination)


def install_clean(source, target, old_roots=(), reset_uploader=True, notify=print):
    source, target, roots = validate_plan(source, target, old_roots)
    notify('正在核对完整安装文件…')
    inventory = verify_package(source, complete=True)
    if 'install_workbench.py' not in inventory or 'INSTALL.cmd' not in inventory:
        raise RuntimeError('这不是新版全新安装包，请重新下载。')
    for name in inventory:
        safe_path(target, name)
    if reset_uploader:
        for process in psutil.process_iter():
            try:
                if process.name() == '店小秘自动上架.exe':
                    raise RuntimeError('店小秘上架程序仍在运行，请先正常退出，再清空它的记录。')
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                pass
        upload = uploader_data()
        for protected in (source, target, *roots):
            if upload == protected or upload.is_relative_to(protected) or protected.is_relative_to(upload):
                raise RuntimeError('上架数据目录与程序目录重叠，未清理。')
    target.parent.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime('%Y%m%d-%H%M%S')+'-'+uuid.uuid4().hex[:6]
    staging = target.parent / ('.temu-stage-'+stamp)
    backup = target.parent / ('TemuWorkbench-backup-'+stamp)
    report = {'version': json.loads((source/'workbench-release.json').read_text(encoding='utf-8'))['version'],
              'source': str(source), 'target': str(target), 'status': 'preparing',
              'retired': [], 'tasks_disabled': [], 'browser_data_reset': 'remove_old_extensions_in_browser'}
    moved = []
    installed = False
    with install_lock(target.parent, target):
        try:
            needed = sum(safe_path(source,n).stat().st_size for n in inventory)
            if shutil.disk_usage(target.parent).free < needed + 100_000_000:
                raise RuntimeError('安装磁盘空间不足，请释放至少 '+str((needed+100_000_000)//1_000_000)+' MB。')
            staging.mkdir()
            notify('正在准备全新程序，旧数据尚未改动…')
            for name, expected in inventory.items():
                destination = safe_path(staging, name)
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(safe_path(source, name), destination)
                if digest(destination) != expected:
                    raise RuntimeError('文件复制校验失败：'+name)
            # This also checks the Chromium-only manifest in the actual copied package.
            for folder in ('browser_extension', 'gpt_chrome_extension'):
                manifest = json.loads((staging/folder/'manifest.json').read_text(encoding='utf-8'))
                if 'scripts' in manifest.get('background', {}) or 'browser_specific_settings' in manifest:
                    raise RuntimeError('Chrome 插件配置不正确，请重新下载本次全新安装包。')
            validate_plan(source, target, roots)
            backup.mkdir()
            journal = backup / 'install-report.json'
            def save():
                report['retired'] = [{'original':str(a),'backup':str(b)} for a,b in moved]
                journal.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
            save()
            notify('正在关闭旧工作台并停用它的自动启动…')
            report['tasks_disabled'] = disable_old_tasks(roots, backup)
            save()
            for root in roots:
                stop_services(root)
                assert_quiet(root)
            if listener_roots():
                raise RuntimeError('地址仍被占用，安装未替换旧目录。\n'+port_details())
            report['status'] = 'retiring'; save()
            # Retire whole installations: data, local tool state and obsolete code disappear together.
            for root in roots:
                destination = root.with_name(root.name+'.old-'+stamp)
                move_exact(root, destination)
                moved.append((root, destination)); save()
            if reset_uploader:
                upload = uploader_data()
                # No arbitrary process is closed, including the uploader itself.
                if upload.exists():
                    destination = upload.with_name(upload.name+'.old-'+stamp)
                    move_exact(upload, destination)
                    moved.append((upload, destination)); save()
            if target.exists():  # An empty destination selected by a first-time user.
                if any(target.iterdir()):
                    raise RuntimeError('安装目录在执行期间出现其他文件，已停止。')
                checked_path(target).rmdir()
            move_exact(staging, target)
            installed = True
            (target/'installation.json').write_text(json.dumps({
                'version':report['version'], 'clean_install':True, 'backup_report':str(journal)
            },ensure_ascii=False,indent=2),encoding='utf-8')
            report['status'] = 'complete'; save()
            notify('全新安装完成；旧数据已移出使用目录。备份报告：'+str(journal))
            return report
        except BaseException as error:
            if 'journal' in locals():
                report['error'] = str(error)
                try:
                    if installed:
                        stop_services(target)
                        move_exact(target, backup/'failed-install')
                    for original, saved in reversed(moved):
                        move_exact(saved, original)
                    restore_tasks(report['tasks_disabled'])
                    report['status'] = 'rolled_back'
                except BaseException as recovery:
                    report['status'] = 'recovery_needed'
                    report['recovery_error'] = str(recovery)
                    raise RuntimeError('安装失败且恢复未完成，请保留备份并提供此报告：'+str(journal)) from recovery
                finally:
                    save()
            raise
        finally:
            if staging.exists():
                # Only this freshly created private stage may be recursively removed.
                exact = checked_path(staging)
                if exact.parent != target.parent or not exact.name.startswith('.temu-stage-'):
                    raise RuntimeError('临时安装目录不符合预期，未删除。')
                shutil.rmtree(exact)


def prepare_startup(root):
    """Offer a concrete recovery for verified old services, never kill a foreign listener."""
    import ctypes
    root = Path(root).resolve()
    owners = listener_roots()
    foreign = {port:owner for port,owner in owners.items() if owner != root}
    if any(owner is None for owner in foreign.values()):
        raise RuntimeError('工作台地址被其他软件使用：\n'+port_details()+'\n请退出对应软件后重新启动。')
    roots = sorted({owner for owner in foreign.values()}, key=str)
    if roots:
        message = '检测到旧工作台仍在运行：\n'+'\n'.join(map(str,roots))+'\n\n点击“是”自动关闭这些旧工作台服务，再打开本次版本。旧数据保留。'
        if ctypes.windll.user32.MessageBoxW(0,message,'切换到新版工作台',0x24) != 6:
            return False
        for old in roots:
            assert_quiet(old)
            stop_services(old)
    return True


def create_shortcut(target):
    env = os.environ.copy()
    env['TEMU_INSTALL_TARGET'] = str(target)
    code = r"""
$ErrorActionPreference='Stop'
$folder=$env:TEMU_INSTALL_TARGET
$desktop=[Environment]::GetFolderPath('Desktop')
$link=(New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $desktop '织品工作台.lnk'))
$link.TargetPath=Join-Path $folder 'runtime\python\pythonw.exe'
$link.Arguments='-E -B "'+(Join-Path $folder 'launcher.py')+'"'
$link.WorkingDirectory=$folder
$link.Description='织品工作台'
$link.Save()
"""
    subprocess.run(['powershell.exe','-NoProfile','-NonInteractive','-Command',code],
                   env=env,check=True,capture_output=True,creationflags=FLAGS,timeout=20)


def launch(target):
    env = os.environ.copy()
    for name in ('PYTHONHOME','PYTHONPATH','TCL_LIBRARY','TK_LIBRARY','TEMU_WORKBENCH_DATA'):
        env.pop(name, None)
    subprocess.Popen([str(target/'runtime/python/pythonw.exe'), str(target/'launcher.py')],
                     cwd=target, env=env, creationflags=FLAGS)


def wizard(source=ROOT, initial=None):
    import tkinter as tk
    from tkinter import filedialog, messagebox, ttk
    app = tk.Tk()
    app.title('织品工作台 · 安装')
    app.geometry('780x640')
    source = Path(source).resolve()
    old = discover_old(source)
    default = old[0] if len(old)==1 else Path('D:/TemuWorkbench') if Path('D:/').is_dir() else Path.home()/'TemuWB'
    if initial:
        default = Path(initial)
    target = tk.StringVar(value=str(default))
    reset = tk.BooleanVar(value=False)
    removed = tk.BooleanVar(value=False)
    status = tk.StringVar(value='首次使用保持推荐位置，点击“安装并打开”即可。' if not old else '请完成或停止旧工作台任务，再确认下面的旧目录。')
    box = ttk.Frame(app,padding=20); box.pack(fill='both',expand=True)
    ttk.Label(box,text='装好后，双击桌面入口即可使用',font=('Microsoft YaHei UI',17,'bold')).pack(anchor='w')
    ttk.Label(box,text='已包含运行环境、专用浏览器、采集助手、生图助手和店小秘 1.7.1。首次使用无需另外安装软件。',
              wraplength=720).pack(anchor='w',pady=8)
    row=ttk.Frame(box); row.pack(fill='x')
    ttk.Label(row,text='安装到：').pack(side='left')
    entry=ttk.Entry(row,textvariable=target); entry.pack(side='left',fill='x',expand=True)
    def choose():
        value=filedialog.askdirectory(title='选择安装目录（空目录或旧工作台目录）')
        if value: target.set(value)
    browse=ttk.Button(row,text='选择目录',command=choose); browse.pack(side='right')
    ttk.Label(box,text='将清理的旧工作台（自动识别，也可添加未运行的旧目录）：').pack(anchor='w',pady=(15,5))
    listing=tk.Listbox(box,height=6); listing.pack(fill='x')
    def render():
        listing.delete(0,'end')
        for path in old: listing.insert('end',str(path))
    render()
    controls=ttk.Frame(box); controls.pack(fill='x',pady=5)
    def add():
        value=filedialog.askdirectory(title='选择旧工作台根目录（含 backend.py 和 browser_extension）')
        if not value: return
        path=Path(value).resolve()
        if not is_installation(path):
            messagebox.showerror('目录不正确','请选整个旧工作台目录，不要只选 browser_extension。'); return
        if path not in old: old.append(path); render()
    def drop():
        for index in reversed(listing.curselection()): old.pop(index)
        render()
    def detect():
        for path in discover_old(source):
            if path not in old: old.append(path)
        render(); status.set(port_details() or '工作台地址当前空闲，可开始安装。')
    buttons=[]
    for text,command in [('添加旧目录',add),('移除所选',drop),('重新检测',detect)]:
        button=ttk.Button(controls,text=text,command=command); button.pack(side='left',padx=(0,8)); buttons.append(button)
    ttk.Checkbutton(box,text='同时清空当前 Windows 用户的店小秘上架记录与工具登录（先移入备份）',variable=reset).pack(anchor='w',pady=5)
    ttk.Label(box,text='新版会自动配置专用浏览器，打开后登录自己的账号即可。\n若有旧版：请先完成或停止旧任务；列出的旧目录将移入 .old 备份。',
              wraplength=720).pack(anchor='w',pady=8)
    ttk.Checkbutton(box,text='若已有旧版，我已完成或停止旧工作台任务',variable=removed).pack(anchor='w')
    ttk.Label(box,textvariable=status,wraplength=720,foreground='#995200').pack(anchor='w',pady=12)
    progress=ttk.Progressbar(box,mode='indeterminate'); progress.pack(fill='x')
    events=queue.Queue()
    busy=False
    def start():
        nonlocal busy
        if old and not removed.get():
            messagebox.showinfo('先停止旧任务','请完成或停止旧工作台任务，再勾选确认。首次安装无需处理浏览器插件。'); return
        selected=Path(target.get())
        try:
            _, selected, roots=validate_plan(source,selected,list(old))
        except Exception as error:
            messagebox.showerror('请检查安装目录',str(error)); return
        text='将安装到：\n'+str(selected)+'\n\n清理旧目录：\n'+('\n'.join(map(str,roots)) or '无')+'\n\n旧数据先移到备份，新版为空白。确定开始？'
        if (roots or reset.get()) and not messagebox.askyesno('确认旧版备份范围',text): return
        reset_value=reset.get()
        busy=True; run.configure(state='disabled'); browse.configure(state='disabled')
        entry.configure(state='disabled')
        for b in buttons: b.configure(state='disabled')
        progress.start()
        def worker():
            try:
                report=install_clean(source,selected,roots,reset_uploader=reset_value,notify=lambda s:events.put(('status',s)))
                try: create_shortcut(selected)
                except Exception: report['shortcut_warning']='桌面快捷方式未创建，请从安装目录 START.cmd 启动。'
                events.put(('done',report))
            except Exception as error: events.put(('error',str(error)))
        threading.Thread(target=worker,daemon=True).start()
    run=ttk.Button(box,text='安装并打开',command=start); run.pack(anchor='e',pady=12)
    def close():
        if busy: messagebox.showinfo('安装正在进行','请等待安装或恢复完成后再关闭。')
        else: app.destroy()
    app.protocol('WM_DELETE_WINDOW',close)
    def poll():
        nonlocal busy
        try:
            while True:
                kind,value=events.get_nowait()
                if kind=='status': status.set(value); continue
                busy=False; progress.stop(); run.configure(state='normal'); browse.configure(state='normal'); entry.configure(state='normal')
                for b in buttons: b.configure(state='normal')
                if kind=='error':
                    status.set('安装未完成，可修正后重试。'); messagebox.showerror('安装未完成',value)
                else:
                    installed=Path(value['target'])
                    status.set('安装完成：'+str(installed))
                    messagebox.showinfo('安装完成',
                        value.get('shortcut_warning','桌面已创建“织品工作台”快捷方式。')+
                        '\n\n接下来会自动打开工作台，按首页首次使用提示登录自己的账号。\n专用浏览器会自动加载助手，无需手动安装插件。')
                    launch(installed)
                    app.destroy(); return
        except queue.Empty: pass
        app.after(100,poll)
    poll(); app.mainloop()


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--target',type=Path)
    parser.add_argument('--old',type=Path,action='append',default=[])
    parser.add_argument('--apply',action='store_true')
    parser.add_argument('--check',action='store_true',help='Verify package and GUI dependencies without installing')
    parser.add_argument('--keep-uploader',action='store_true')
    args=parser.parse_args()
    if args.check:
        inventory=verify_package(ROOT,complete=True)
        import tkinter as tk
        window=tk.Tk(); window.withdraw(); window.update(); window.destroy()
        print(json.dumps({'package_complete':True,'files':len(inventory),'tk_ready':True}))
        return
    if args.apply:
        if not args.target: parser.error('--apply requires --target')
        report=install_clean(ROOT,args.target,args.old,reset_uploader=not args.keep_uploader)
        print(json.dumps(report,ensure_ascii=False,indent=2))
    else:
        wizard(initial=args.target)


if __name__=='__main__':
    main()
