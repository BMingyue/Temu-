"""Small local Git workbench for maintainers; never starts business jobs."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import queue
import re
import shutil
import stat
import subprocess
import threading
from urllib.parse import urlsplit

MAX_FILE_BYTES = 20 * 1024 * 1024
PRIVATE_PARTS = {
    '.git', '.build', '.venv', '.migration', '.openai', '_shared_memory',
    'data', 'state', 'logs', 'runtime', 'node_modules', '__pycache__',
    'browser-profile', 'user-data', 'failure-records', 'failure_records',
    'outputs', 'work', 'reports', '.next', '.vinext', '.wrangler',
}
PRIVATE_NAMES = {'config.json', 'state.json', 'protected.json', 'cookies', 'login data',
                 'bridge-token', 'credentials.json', 'installation.json'}
PRIVATE_SUFFIXES = {'.sqlite', '.sqlite3', '.db', '.log', '.pem', '.key', '.pfx',
                    '.exe', '.dll', '.pyd', '.zip', '.7z', '.bundle', '.pyc'}


class GitError(RuntimeError):
    pass


def validate_remote(value: str) -> str:
    """Only credential-free HTTPS and Git-over-SSH origins are supported."""
    value = value.strip()
    if not value or any(ord(char) < 33 for char in value):
        raise GitError('请填写完整仓库地址，不能包含空格或换行。')
    if re.fullmatch(r'git@[A-Za-z0-9][A-Za-z0-9.-]*:[A-Za-z0-9_./-]+', value):
        path = value.split(':', 1)[1]
        if '..' in path.split('/') or not path or path.startswith('/'):
            raise GitError('SSH 仓库路径无效。')
        return value
    try:
        parsed = urlsplit(value)
        if parsed.scheme not in {'https', 'ssh'} or not parsed.hostname or parsed.password:
            raise ValueError()
        if parsed.query or parsed.fragment or not parsed.path.strip('/'):
            raise ValueError()
        if parsed.scheme == 'https' and parsed.username is not None:
            raise ValueError()
        if parsed.scheme == 'ssh' and parsed.username != 'git':
            raise ValueError()
        if parsed.port is not None and not 1 <= parsed.port <= 65535:
            raise ValueError()
        if '..' in parsed.path.split('/') or '%' in parsed.netloc:
            raise ValueError()
    except (ValueError, TypeError):
        raise GitError('请使用 HTTPS 仓库地址，或 git@ 开头的 SSH 地址；地址中不要放账号、密码、令牌或参数。') from None
    return value


def redact(text: str) -> str:
    text = re.sub(r'(https?://)[^\s/@]+(?::[^\s/@]*)?@', r'\1[已隐藏凭据]@', text)
    return re.sub(r'(https?://[^\s?#]+)[?#][^\s]*', r'\1[已隐藏参数]', text)


def private_reason(relative: str, root: Path | None = None) -> str:
    path = PurePosixPath(relative)
    if path.is_absolute() or not path.parts or any(part in {'.', '..'} or ':' in part or '\\' in part for part in path.parts):
        return '路径不属于本仓库'
    parts = {part.casefold() for part in path.parts}
    if parts & PRIVATE_PARTS or any(part.startswith('.env') for part in parts):
        return '运行数据或本机环境'
    if path.name.casefold() in PRIVATE_NAMES or path.suffix.casefold() in PRIVATE_SUFFIXES:
        return '账号、记录或二进制文件'
    if path.parts[:3] == ('local_tools', 'qualification', 'assets'):
        return '个人资质素材'
    if root:
        full = root.joinpath(*path.parts)
        current = full
        while current != root.parent:
            try:
                info = current.lstat()
                if current.is_symlink() or (getattr(info, 'st_file_attributes', 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT):
                    return '目录链接或文件链接'
            except FileNotFoundError:
                pass
            current = current.parent
        if full.is_file() and full.stat().st_size > MAX_FILE_BYTES:
            return '文件大于20MB，请作为发布附件管理'
    return ''


class Repository:
    def __init__(self, root: Path | str, git: str | None = None):
        self.root = Path(root).resolve()
        self.git = git or shutil.which('git')
        if not self.git:
            raise GitError('未找到 Git。请先安装 Git for Windows，再重新打开本窗口。')
        actual = self.run('rev-parse', '--show-toplevel').strip()
        if Path(actual).resolve() != self.root:
            raise GitError('请选择仓库根目录；本工具不会自动创建仓库或操作上层仓库。')

    def run(self, *arguments: str, timeout: int = 45) -> str:
        env = os.environ.copy()
        # Git Credential Manager may open its normal sign-in window. A hidden
        # console must never wait for a textual password/passphrase prompt.
        env.update(GIT_TERMINAL_PROMPT='0', GCM_INTERACTIVE='always')
        process = subprocess.run([self.git, '-c', 'core.quotepath=false', '-C', str(self.root), *arguments],
                                 stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 encoding='utf-8', errors='replace', env=env, timeout=timeout,
                                 creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        if process.returncode:
            detail = redact(process.stderr.strip() or process.stdout.strip())
            raise GitError(detail or 'Git 未完成操作，请检查仓库状态。')
        return process.stdout

    def head(self) -> str:
        try:
            return self.run('rev-parse', '--verify', 'HEAD').strip()
        except GitError:
            return ''

    def origin(self, push: bool = False) -> str:
        try:
            options = ['remote', 'get-url', *(['--push'] if push else []), '--all', 'origin']
            values = self.run(*options).strip().splitlines()
        except GitError:
            return ''
        if len(values) != 1:
            raise GitError('origin 配置了多个地址，请先由维护人员核对。')
        return validate_remote(values[0])

    def branch(self) -> str:
        try:
            value = self.run('symbolic-ref', '--short', 'HEAD').strip()
            self.run('check-ref-format', '--branch', value)
            return value
        except GitError:
            raise GitError('当前不在普通分支上，请先由维护人员切回分支。') from None

    def status(self) -> dict:
        values = self.run('status', '--porcelain=v1', '-z', '--untracked-files=all').split('\0')
        entries = []
        index = 0
        while index < len(values) and values[index]:
            item = values[index]
            index += 1
            code, name = item[:2], item[3:]
            old = ''
            if 'R' in code or 'C' in code:
                old = values[index]
                index += 1
            reason = private_reason(name, self.root) or (private_reason(old, self.root) if old else '')
            full = self.root.joinpath(*PurePosixPath(name).parts)
            sha = hashlib.sha256(full.read_bytes()).hexdigest() if not reason and full.is_file() else ''
            entries.append(dict(path=name, old=old, code=code, protected=reason, sha256=sha))
        result = dict(root=str(self.root), branch=self.branch(), head=self.head(),
                      origin=self.origin(), entries=entries)
        result['snapshot'] = hashlib.sha256(json.dumps(result, sort_keys=True).encode()).hexdigest()
        return result

    def connect(self, address: str) -> str:
        address = validate_remote(address)
        old = self.origin()
        if old and old != address:
            raise GitError('origin 已连接到另一个仓库，本工具不会覆盖它。请由维护人员核对。')
        if old and self.origin(push=True) != old:
            raise GitError('origin 的拉取与推送地址不同，请先由维护人员核对。')
        if not old:
            self.run('remote', 'add', 'origin', address)
        return '已连接远程仓库。账号验证将在首次同步时由 Git 官方凭据窗口完成。'

    def commit(self, message: str, paths: list[str], snapshot: str) -> str:
        message = message.strip()
        if not message or len(message) > 300 or '\x00' in message:
            raise GitError('请填写本次修改说明（1–300字）。')
        current = self.status()
        if current['snapshot'] != snapshot:
            raise GitError('文件或仓库状态已变化，请刷新后重新核对再提交。')
        available = {row['path']: row for row in current['entries']}
        if not paths or len(set(paths)) != len(paths):
            raise GitError('请先勾选本次要提交的文件。')
        chosen = []
        for name in paths:
            row = available.get(name)
            if not row or row['protected'] or 'U' in row['code']:
                raise GitError('所选范围含受保护文件或合并冲突，请刷新并核对。')
            chosen.extend([name, *([row['old']] if row['old'] else [])])
        staged = set(filter(None, self.run('diff', '--cached', '--name-only', '-z').split('\0')))
        if staged - set(chosen):
            raise GitError('另有未勾选文件已经被其他工具暂存，本工具不会将它们一并提交。请先核对暂存区。')
        # Literal pathspecs prevent filenames beginning with ':' from selecting
        # files outside the human-reviewed list. No add-all or force operation.
        index_paths = set(filter(None, self.run('ls-files', '-z').split('\0')))
        stage_paths = [name for name in dict.fromkeys(chosen)
                       if name in index_paths or self.root.joinpath(*PurePosixPath(name).parts).exists()]
        specs = [':(literal)' + name for name in stage_paths]
        if specs:
            self.run('add', '--all', '--', *specs)
        for name in paths:
            row = available[name]
            full = self.root.joinpath(*PurePosixPath(name).parts)
            after = hashlib.sha256(full.read_bytes()).hexdigest() if full.is_file() else ''
            if after != row['sha256']:
                raise GitError('文件在暂存期间发生变化，未创建提交；请刷新并核对已暂存文件。')
        if set(filter(None, self.run('diff', '--cached', '--name-only', '-z').split('\0'))) - set(chosen):
            raise GitError('暂存区在操作期间变化，未创建提交；请刷新并核对。')
        # A local fallback identity permits first use without changing global
        # Git settings or claiming a real person's email address.
        options = []
        for key, fallback in (('user.name', 'Local Maintainer'), ('user.email', 'maintainer@localhost')):
            try:
                self.run('config', '--get', key)
            except GitError:
                options.extend(['-c', key + '=' + fallback])
        self.run(*options, 'commit', '-m', message)
        return '已保存本地版本：' + self.head()[:12] + '。尚未上传；需要时点击“同步到远程”。'

    def _safe_tree(self, revision: str):
        for record in filter(None, self.run('ls-tree', '-r', '-l', '-z', revision).split('\0')):
            meta, name = record.split('\t', 1)
            mode, kind, ident, size = meta.split()
            if mode in {'120000', '160000'} or kind != 'blob' or private_reason(name):
                raise GitError('提交中含账号/运行目录或目录链接，已阻止同步：' + name)
            if int(size) > MAX_FILE_BYTES:
                raise GitError('提交中含大于20MB的文件，请使用发布附件：' + name)

    def push(self) -> str:
        origin = self.origin()
        if not origin:
            raise GitError('请先填写并连接远程仓库地址。')
        if self.origin(push=True) != origin:
            raise GitError('origin 的拉取与推送地址不同，未上传源码；请先由维护人员核对。')
        branch = self.branch()
        if not self.head():
            raise GitError('请先保存一个本地版本。')
        self._safe_tree('HEAD')
        self.run('push', '--set-upstream', 'origin', 'HEAD:refs/heads/' + branch, timeout=180)
        return '已同步到远程仓库。这里只同步源码，不会发布商品或自动安装同事版本。'

    def pull(self) -> str:
        before = self.status()
        if not before['origin']:
            raise GitError('请先填写并连接远程仓库地址。')
        if before['entries']:
            raise GitError('本机还有未保存的源码修改，请先保存本地版本。不会覆盖这些文件。')
        branch = before['branch']
        ref = 'refs/remotes/origin/' + branch
        self.run('fetch', 'origin', 'refs/heads/' + branch + ':' + ref, timeout=180)
        self._safe_tree(ref)
        if self.status()['snapshot'] != before['snapshot']:
            raise GitError('获取期间本地文件或分支发生变化，未更新源码，请刷新重试。')
        try:
            self.run('merge-base', '--is-ancestor', 'HEAD', ref)
        except GitError:
            try:
                self.run('merge-base', '--is-ancestor', ref, 'HEAD')
                return '本地版本已经领先远程，没有拉取或覆盖文件；需要时点击“同步到远程”。'
            except GitError:
                pass
            raise GitError('本地与远程已有各自的新版本，已停止更新。请交由维护人员合并，不会覆盖或强制回退。') from None
        self.run('merge', '--ff-only', ref)
        return '源码已快进更新。正在运行的程序未重启；前端构建和同事安装版仍需单独发布。'


def window(root: Path, check_only: bool = False):
    import tkinter as tk
    from tkinter import filedialog, messagebox, ttk
    app = tk.Tk()
    app.title('源码版本管理 · Git')
    app.geometry('1040x720')
    selected_root = tk.StringVar(value=str(root))
    summary = tk.StringVar(value='正在读取本地仓库…')
    remote = tk.StringVar()
    message = tk.StringVar()
    notices = queue.Queue()
    state = {'repo': None, 'status': None, 'busy': False, 'checked': set(), 'closing': False}
    buttons = []
    box = ttk.Frame(app, padding=18); box.pack(fill='both', expand=True)
    ttk.Label(box, text='先保存本地版本，再按需同步到私有仓库', font=('Microsoft YaHei UI', 16, 'bold')).pack(anchor='w')
    ttk.Label(box, text='此窗口供维护源码使用。不会上架、采集、生图、构建安装包或重启程序。').pack(anchor='w', pady=(8, 14))
    row = ttk.Frame(box); row.pack(fill='x')
    ttk.Entry(row, textvariable=selected_root, state='readonly').pack(side='left', fill='x', expand=True)
    def add_button(parent, text, callback, **pack):
        button = ttk.Button(parent, text=text, command=callback); button.pack(**pack); buttons.append(button); return button
    ttk.Label(box, textvariable=summary, wraplength=980).pack(anchor='w', pady=10)
    ttk.Label(box, text='勾选本次要保存的文件；受保护的记录和运行目录不能提交。').pack(anchor='w')
    files = ttk.Frame(box); files.pack(fill='both', expand=True, pady=8)
    table = ttk.Treeview(files, columns=('pick','code','path','reason'), show='headings', height=15, selectmode='browse')
    for key, title, width in (('pick','选择',55),('code','状态',60),('path','文件',610),('reason','说明',230)):
        table.heading(key, text=title); table.column(key, width=width, minwidth=40, stretch=key in {'path','reason'})
    scroll = ttk.Scrollbar(files, orient='vertical', command=table.yview)
    table.configure(yscrollcommand=scroll.set)
    table.pack(side='left', fill='both', expand=True); scroll.pack(side='right', fill='y')
    table.tag_configure('protected', foreground='#8b5960')
    def log(text):
        output.configure(state='normal'); output.insert('end', redact(str(text)).strip()+'\n'); output.see('end'); output.configure(state='disabled')
    def busy(value):
        state['busy'] = value
        for button in buttons: button.configure(state='disabled' if value else 'normal')
    def refresh_view(status):
        state['status'] = status; state['checked'] = set()
        table.delete(*table.get_children())
        for item in status['entries']:
            table.insert('', 'end', iid=item['path'], values=('□', item['code'], item['path'], item['protected']), tags=('protected',) if item['protected'] else ())
        remote.set(status['origin'])
        summary.set(f"分支：{status['branch']}  ·  本地版本：{status['head'][:12] or '尚无提交'}  ·  变更：{len(status['entries'])} 个  ·  {'已连接远程' if status['origin'] else '仅本地保存，尚未连接远程'}")
    def submit(task, action, result_refresh=True):
        if state['busy']: return
        busy(True); log(task+'…')
        def run():
            try:
                result = action()
                status = state['repo'].status() if result_refresh and state['repo'] else None
                notices.put(('ok', result, status))
            except Exception as error: notices.put(('error', str(error), None))
        threading.Thread(target=run, daemon=True).start()
    def load():
        directory = selected_root.get()
        state['repo'] = None; state['status'] = None; state['checked'] = set()
        table.delete(*table.get_children()); summary.set('正在读取所选仓库…')
        def action():
            state['repo'] = Repository(directory)
            return '本地状态已刷新。'
        submit('读取仓库', action)
    def choose():
        path = filedialog.askdirectory(title='选择源码仓库根目录', initialdir=selected_root.get(), mustexist=True)
        if path: selected_root.set(path); load()
    add_button(row, '选择其他源码目录', choose, side='left', padx=(8,0))
    add_button(row, '刷新', load, side='left', padx=(8,0))
    def toggle(event=None):
        if state['busy'] or not state['status']: return
        ident = table.identify_row(event.y) if event else table.focus()
        item = next((item for item in state['status']['entries'] if item['path'] == ident), None)
        if not item or item['protected']: return
        if ident in state['checked']: state['checked'].remove(ident)
        else: state['checked'].add(ident)
        table.set(ident, 'pick', '☑' if ident in state['checked'] else '□')
    table.bind('<ButtonRelease-1>', toggle); table.bind('<space>', toggle)
    toolbar = ttk.Frame(box); toolbar.pack(fill='x', pady=(0,8))
    def select_all():
        if state['status']:
            state['checked'] = {item['path'] for item in state['status']['entries'] if not item['protected']}
            for ident in table.get_children(): table.set(ident, 'pick', '☑' if ident in state['checked'] else '□')
    add_button(toolbar, '全选可提交文件', select_all, side='left')
    ttk.Entry(toolbar, textvariable=message).pack(side='left', fill='x', expand=True, padx=8)
    def commit():
        current = state['status']
        if not current: return
        chosen = sorted(state['checked'])
        if not chosen or not message.get().strip():
            messagebox.showinfo('先核对本次修改', '请勾选文件，并填写本次修改说明。'); return
        if not messagebox.askyesno('保存本地版本', f'本次将保存勾选的 {len(chosen)} 个文件。\n\n修改说明：{message.get().strip()}\n\n只保存到本机，尚不上传。'): return
        repo = state['repo']; text = message.get()
        submit('保存本地版本', lambda: repo.commit(text, chosen, current['snapshot']))
    add_button(toolbar, '保存本地版本', commit, side='left')
    ttk.Label(box, text='远程仓库地址（GitHub/Gitee 的 HTTPS 或 SSH 地址，不填写密码/令牌）').pack(anchor='w')
    row = ttk.Frame(box); row.pack(fill='x', pady=(5,8))
    ttk.Entry(row, textvariable=remote).pack(side='left', fill='x', expand=True)
    def connect():
        if not state['repo']: return
        repo = state['repo']; address = remote.get()
        submit('连接远程地址', lambda: repo.connect(address))
    add_button(row, '连接仓库', connect, side='left', padx=8)
    def push():
        if not state['status']: return
        if not state['status']['origin']: messagebox.showinfo('尚未连接', '先填写私有仓库地址并点击“连接仓库”。'); return
        if not messagebox.askyesno('同步源码到远程', '将已保存的本地提交同步到：\n'+state['status']['origin']+'\n\n首次可能出现 Git 官方登录窗口。未勾选/未保存的修改不会同步。'): return
        repo = state['repo']; submit('同步到远程', repo.push)
    add_button(row, '同步到远程', push, side='left')
    def pull():
        if not state['repo']: return
        if not messagebox.askyesno('仅更新源码', '仅快进获取远程源码，不覆盖未保存修改。\n\n这不会更新同事安装版，也不会构建或重启当前程序。\n\n继续读取并更新源码？'): return
        repo = state['repo']; submit('获取远程源码', repo.pull)
    add_button(row, '获取远程源码', pull, side='left', padx=(8,0))
    output = tk.Text(box, height=5, state='disabled', wrap='word'); output.pack(fill='x', pady=(0,8))
    ttk.Label(box, text='首次未配置提交身份时，仅本次提交使用 Local Maintainer <maintainer@localhost>，不修改全局 Git 设置。', wraplength=980).pack(anchor='w')
    def process():
        while not notices.empty():
            kind, detail, status = notices.get(); log(detail)
            busy(False)
            if status: refresh_view(status)
            if kind == 'error': messagebox.showerror('操作未完成', redact(detail))
        if not state['closing']: app.after(100, process)
    def close():
        if state['busy']:
            messagebox.showinfo('正在处理', '请等待当前 Git 操作完成；远程登录窗口可能正在等待你确认。'); return
        state['closing'] = True; app.destroy()
    app.protocol('WM_DELETE_WINDOW', close)
    if check_only:
        app.withdraw(); app.update_idletasks(); app.destroy(); return
    app.after(0, load); app.after(100, process); app.mainloop()


def main():
    parser = argparse.ArgumentParser(description='源码 Git 版本管理')
    parser.add_argument('--repo', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--status', action='store_true')
    parser.add_argument('--check-window', action='store_true')
    args = parser.parse_args()
    if args.status:
        print(json.dumps(Repository(args.repo).status(), ensure_ascii=False, indent=2)); return
    window(args.repo, args.check_window)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        if os.name == 'nt':
            import ctypes
            ctypes.windll.user32.MessageBoxW(0, redact(str(error)), 'Git 版本管理未能启动', 0x10)
        else:
            raise
