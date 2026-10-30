"""Open registered local browser profiles without changing their login data."""
from __future__ import annotations

import ctypes
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import threading
import time
import uuid

import psutil

CHATGPT_URL = 'https://chatgpt.com/'
CONFIG_NAME = 'gpt-browser-profiles.json'
EXECUTABLES = {'chrome': 'chrome.exe', 'edge': 'msedge.exe', 'firefox': 'firefox.exe'}
LOCK = threading.RLock()
LAST_OPENED = {}
CLICK_GAP_SECONDS = 5
ROOT = Path(__file__).resolve().parent
EXTENSION_ROOT = ROOT / 'gpt_chrome_extension'
MAX_CREATE_COUNT = 20


def _file_description(executable):
    """Do not assume a chrome.exe is a build which supports extension loading."""
    if os.name != 'nt':
        return ''
    from ctypes import wintypes
    version = ctypes.WinDLL('version', use_last_error=True)
    version.GetFileVersionInfoSizeW.argtypes = [wintypes.LPCWSTR, ctypes.POINTER(wintypes.DWORD)]
    version.GetFileVersionInfoW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p]
    version.VerQueryValueW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR,
                                    ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(wintypes.UINT)]
    size = version.GetFileVersionInfoSizeW(str(executable), None)
    if not size:
        return ''
    buffer = ctypes.create_string_buffer(size)
    if not version.GetFileVersionInfoW(str(executable), 0, size, buffer):
        return ''
    pointer, length = ctypes.c_void_p(), wintypes.UINT()
    if not version.VerQueryValueW(buffer, '\\VarFileInfo\\Translation', ctypes.byref(pointer), ctypes.byref(length)):
        return ''
    languages = ctypes.cast(pointer, ctypes.POINTER(ctypes.c_ushort))
    for index in range(length.value // 4):
        language, page = languages[index * 2], languages[index * 2 + 1]
        key = f'\\StringFileInfo\\{language:04x}{page:04x}\\FileDescription'
        if version.VerQueryValueW(buffer, key, ctypes.byref(pointer), ctypes.byref(length)):
            return ctypes.wstring_at(pointer, max(0, length.value - 1))
    return ''


def _testing_runtime():
    # Official branded Chrome >=137 ignores --load-extension. Use only a verified
    # local Chrome for Testing; never fall back silently to regular Chrome.
    for executable in (ROOT / 'runtime/gpt-chrome/chrome-win64/chrome.exe',
                       ROOT / 'local_tools/dxm-uploader/_internal/browser/chrome.exe'):
        if executable.is_file() and 'Chrome for Testing' in _file_description(executable):
            return executable.resolve()
    return None


def _grant_runtime_read_access(directory):
    """Let Windows' restricted browser processes read this dedicated runtime."""
    if os.name == 'nt':
        subprocess.run(['icacls', str(directory), '/grant',
                        '*S-1-15-2-1:(OI)(CI)RX', '*S-1-15-2-2:(OI)(CI)RX', '/T', '/Q'],
                       check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                       creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))


def _ensure_runtime():
    source = _testing_runtime()
    if not source:
        raise ValueError(creation_status()['message'])
    target = ROOT / 'runtime/gpt-chrome/chrome-win64'
    if _same_path(source.parent, target):
        return source
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(target.name + '.' + uuid.uuid4().hex + '.tmp')
    try:
        # Keep an independent copy: updating the uploader cannot remove or alter
        # the browser used by image tasks. Never change the uploader's ACLs.
        shutil.copytree(source.parent, temporary)
        _grant_runtime_read_access(temporary)
        os.replace(temporary, target)
        return target / 'chrome.exe'
    finally:
        if temporary.exists() and temporary.resolve().parent == target.parent.resolve():
            shutil.rmtree(temporary)


def creation_status():
    runtime = _testing_runtime()
    available = bool(runtime and (EXTENSION_ROOT / 'manifest.json').is_file())
    return dict(available=available, runtime_label='Chrome for Testing', max_per_request=MAX_CREATE_COUNT,
                message=('独立 Chrome 自动加载生图助手，登录和配置保存在本机；数量可继续增加' if available else
                         '未找到支持自动加载扩展的 Chrome for Testing，请修复工作台运行组件'))


def _managed_folder(data, ident):
    root = (Path(data) / 'gpt-browser-profiles').resolve()
    folder = root / ident
    if folder.resolve().parent != root:
        raise ValueError('独立浏览器目录无效')
    return folder


def _sync_extension(row):
    destination = Path(row['profile_path']).parent / 'extension'
    destination.mkdir(exist_ok=True)
    manifest = json.loads((EXTENSION_ROOT / 'manifest.json').read_text(encoding='utf-8'))
    for source in EXTENSION_ROOT.iterdir():
        if source.is_file() and source.suffix in ('.js', '.html') and source.name != 'config.js':
            shutil.copy2(source, destination / source.name)
    # Chromium only supports the service_worker form, not Firefox's scripts.
    manifest['background'] = {'service_worker': 'service-worker.js'}
    manifest.pop('browser_specific_settings', None)
    (destination / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    (destination / 'config.js').write_text(
        'globalThis.WORKBENCH_TOKEN="";\n' +
        'globalThis.WORKBENCH_WORKER_ID=' + json.dumps(row['worker_id']) + ';\n', encoding='utf-8')
    return manifest['version']


def _save_profiles(data, rows):
    target = Path(data) / CONFIG_NAME
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(target.name + '.' + uuid.uuid4().hex + '.tmp')
    try:
        temporary.write_text(json.dumps(dict(version=1, profiles=rows), ensure_ascii=False, indent=2), encoding='utf-8')
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)


def create_profiles(data, body):
    """Create blank persistent profiles; never copy another account's cookies."""
    count = body.get('count', 1)
    if type(count) is not int or not 1 <= count <= MAX_CREATE_COUNT:
        raise ValueError(f'每次可新增 1–{MAX_CREATE_COUNT} 个 Chrome，之后可继续增加')
    prefix = body.get('label_prefix', 'Chrome')
    if not isinstance(prefix, str) or not prefix.strip() or len(prefix) > 40 or any(ord(c) < 32 for c in prefix):
        raise ValueError('浏览器名称需为 1–40 个可见字符')
    with LOCK:
        rows = _profiles(data)
        runtime = _ensure_runtime()
        created, folders = [], []
        try:
            next_index = max((row.get('managed_index', 0) for row in rows if row.get('managed')), default=0) + 1
            labels = {row['label'] for row in rows}
            for number in range(next_index, next_index + count):
                ident = 'chrome-' + uuid.uuid4().hex[:16]
                folder = _managed_folder(data, ident)
                folder.mkdir(parents=True, exist_ok=False)
                folders.append(folder)
                user_data = folder / 'user-data'
                (user_data / 'Default').mkdir(parents=True)
                (folder / 'extension').mkdir()
                label = prefix.strip() + '-' + str(number)
                if label in labels:
                    label += ' (' + ident[-4:] + ')'
                labels.add(label)
                row = dict(id=ident, label=label, browser='chrome', executable=str(runtime),
                           profile_path=str(user_data), profile_directory='Default', worker_id=str(uuid.uuid4()),
                           include_in_all=True, managed=True, managed_index=number,
                           created_at=datetime.now(timezone.utc).isoformat())
                row['extension_version'] = _sync_extension(row)
                created.append(row)
            _save_profiles(data, rows + created)
        except Exception:
            for folder in folders:
                # Only the new folders created in this call can be rolled back.
                if folder.resolve().parent == (Path(data) / 'gpt-browser-profiles').resolve():
                    shutil.rmtree(folder)
            raise
        catalog_rows = catalog(data)
        ids = {row['id'] for row in created}
        return dict(ok=True, created=[row for row in catalog_rows if row['id'] in ids],
                    browser_profiles=catalog_rows, message=f'已新增 {count} 个独立 Chrome；打开后各自登录 GPT 即可')


def chrome_profile_directory(user_data):
    """Resolve the original Chrome profile once when registering this machine."""
    state = Path(user_data) / 'Local State'
    value = json.loads(state.read_text(encoding='utf-8')).get('profile', {}).get('last_used', 'Default')
    if not isinstance(value, str) or value in ('', '.', '..') or '/' in value or '\\' in value:
        raise ValueError('Chrome 配置目录无效')
    if not (Path(user_data) / value).is_dir():
        raise ValueError('原 Chrome 配置目录不存在')
    return value


def _profiles(data):
    path = Path(data) / CONFIG_NAME
    if not path.is_file():
        return []
    try:
        saved = json.loads(path.read_text(encoding='utf-8-sig'))
        rows = saved['profiles']
        if saved.get('version') != 1 or not isinstance(rows, list):
            raise ValueError()
        seen = set()
        for row in rows:
            ident = row['id']
            if not isinstance(ident, str) or not re.fullmatch(r'[a-z][a-z0-9-]{1,39}', ident) or ident in ('all', 'chrome-all') or ident in seen:
                raise ValueError()
            seen.add(ident)
            browser = row['browser']
            executable, profile = Path(row['executable']), Path(row['profile_path'])
            if browser not in EXECUTABLES or executable.name.lower() != EXECUTABLES[browser]:
                raise ValueError()
            if not executable.is_absolute() or not profile.is_absolute():
                raise ValueError()
            if not isinstance(row['label'], str) or not row['label'].strip():
                raise ValueError()
            directory = row.get('profile_directory', '')
            if browser != 'firefox' and (not isinstance(directory, str) or directory in ('', '.', '..') or '/' in directory or '\\' in directory):
                raise ValueError()
            if row.get('managed') and (browser != 'chrome' or
                    profile.resolve() != (_managed_folder(data, ident) / 'user-data').resolve() or
                    not re.fullmatch(r'[a-f0-9-]{36}', str(row.get('worker_id', ''))) or
                    type(row.get('managed_index')) is not int):
                raise ValueError()
        return rows
    except (OSError, ValueError, TypeError, KeyError) as error:
        raise ValueError('本机浏览器启动配置无效，请检查 ' + CONFIG_NAME) from error


def _unavailable(row):
    if not Path(row['executable']).is_file():
        return '浏览器程序不存在'
    profile = Path(row['profile_path'])
    if not profile.is_dir():
        return '原浏览器配置目录不存在'
    if row['browser'] != 'firefox' and not (profile / row['profile_directory']).is_dir():
        return '原浏览器用户目录不存在'
    return ''


def _installed_extension_version(row):
    """Version on disk; the heartbeat separately reports the running version."""
    if not row.get('managed'):
        return row.get('extension_version', '')
    try:
        manifest = Path(row['profile_path']).parent / 'extension/manifest.json'
        version = json.loads(manifest.read_text(encoding='utf-8')).get('version', '')
        return version if isinstance(version, str) and re.fullmatch(r'\d+(?:\.\d+){0,3}', version) else ''
    except (OSError, ValueError, TypeError):
        return ''


def catalog(data):
    return [
        dict(id=row['id'], label=row['label'], browser=row['browser'],
             worker_id=row.get('worker_id', ''), available=not bool(reason),
             unavailable_reason=reason, include_in_all=bool(row.get('include_in_all', True)),
             managed=bool(row.get('managed')), extension_auto_load=bool(row.get('managed')),
             extension_version=_installed_extension_version(row), created_at=row.get('created_at', ''))
        for row in _profiles(data)
        for reason in [_unavailable(row)]
    ]


def _same_path(left, right):
    return os.path.normcase(str(Path(left).resolve())) == os.path.normcase(str(Path(right).resolve()))


def _firefox_process(row):
    """Only match the exact profile, or its locked profile's sole default process."""
    explicit, defaults = [], []
    for process in psutil.process_iter(['name', 'exe', 'cmdline']):
        try:
            info = process.info
            if info['name'].lower() != 'firefox.exe' or not info['exe'] or not _same_path(info['exe'], row['executable']):
                continue
            args = info['cmdline'] or []
            if '-contentproc' in args:
                continue
            option = next((i for i, arg in enumerate(args) if arg.lower() in ('-profile', '--profile')), None)
            if option is not None:
                if option + 1 < len(args) and _same_path(args[option + 1], row['profile_path']):
                    explicit.append(process.pid)
            elif not any(arg.lower() in ('-p', '--p') for arg in args):
                defaults.append(process.pid)
        except (psutil.Error, OSError, ValueError, TypeError, AttributeError):
            continue
    if explicit:
        return explicit[0], True
    from release.firefox_local_channel import profile_running
    locked = profile_running(Path(row['profile_path']))
    return (defaults[0] if locked and len(defaults) == 1 else None), locked


def _chrome_process(row):
    for process in psutil.process_iter(['name', 'exe', 'cmdline']):
        try:
            info = process.info
            if (info['name'].lower() != 'chrome.exe' or not info['exe'] or
                    not _same_path(info['exe'], row['executable'])):
                continue
            args = info['cmdline'] or []
            profile = next((arg.split('=', 1)[1] for arg in args if arg.startswith('--user-data-dir=')), None)
            if profile and not any(arg.startswith('--type=') for arg in args) and _same_path(profile, row['profile_path']):
                return process.pid
        except (psutil.Error, OSError, ValueError, TypeError, AttributeError):
            continue
    return None


def _focus_window(pid):
    if not pid or os.name != 'nt':
        return False
    from ctypes import wintypes
    user32 = ctypes.WinDLL('user32', use_last_error=True)
    callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    user32.EnumWindows.argtypes = [callback_type, wintypes.LPARAM]
    user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    user32.IsWindowVisible.argtypes = [wintypes.HWND]
    user32.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
    user32.SetForegroundWindow.argtypes = [wintypes.HWND]
    handles = []

    @callback_type
    def visit(handle, _param):
        owner = wintypes.DWORD()
        user32.GetWindowThreadProcessId(handle, ctypes.byref(owner))
        if owner.value == pid and user32.IsWindowVisible(handle):
            handles.append(handle)
        return True

    user32.EnumWindows(visit, 0)
    if not handles:
        return False
    user32.ShowWindow(handles[0], 9)  # Restore an existing minimized window.
    return bool(user32.SetForegroundWindow(handles[0]))


def _open(row):
    reason = _unavailable(row)
    if reason:
        raise ValueError(row['label'] + '：' + reason + '，请恢复原路径后再打开')
    stamp = time.monotonic()
    if stamp - LAST_OPENED.get(row['id'], -CLICK_GAP_SECONDS) < CLICK_GAP_SECONDS:
        return dict(ok=True, id=row['id'], message=row['label'] + ' 刚刚已请求打开，请稍候', already_requested=True)
    if row['browser'] == 'firefox':
        pid, running = _firefox_process(row)
        if running:
            focused = _focus_window(pid)
            LAST_OPENED[row['id']] = stamp
            return dict(ok=True, id=row['id'], already_running=True, focused=focused,
                        message=(row['label'] + ' 已切换到原窗口' if focused else
                                 row['label'] + ' 已在运行，请从任务栏切换到原窗口'))
        command = [row['executable'], '-no-remote', '-profile', row['profile_path'],
                   '-new-window', CHATGPT_URL]
    else:
        extension_arguments = []
        if row.get('managed'):
            pid = _chrome_process(row)
            if pid:
                focused = _focus_window(pid)
                LAST_OPENED[row['id']] = stamp
                return dict(ok=True, id=row['id'], already_running=True, focused=focused,
                            message=row['label'] + (' 已切换到独立窗口' if focused else ' 已在运行，请从任务栏切换'))
            if 'Chrome for Testing' not in _file_description(row['executable']):
                raise ValueError('此配置的 Chrome 不支持自动加载扩展，请修复 Chrome for Testing 运行组件')
            _sync_extension(row)
            extension = str(Path(row['profile_path']).parent / 'extension')
            extension_arguments = ['--load-extension=' + extension]
        command = [row['executable'], '--user-data-dir=' + row['profile_path'],
                   '--profile-directory=' + row['profile_directory'],
                   *extension_arguments, '--no-first-run', '--new-window', CHATGPT_URL]
    try:
        process = subprocess.Popen(
            command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
        )
        try:
            code = process.wait(timeout=0.3)
        except subprocess.TimeoutExpired:
            code = None
        if code not in (None, 0):
            raise ValueError(row['label'] + ' 启动失败（退出码 ' + str(code) + '）')
    except OSError as error:
        raise ValueError(row['label'] + ' 启动失败：' + str(error)) from error
    LAST_OPENED[row['id']] = stamp
    return dict(ok=True, id=row['id'], message='已请求打开 ' + row['label'] + ' 的原配置和 GPT 首页')


def open_profile(data, ident):
    """The HTTP request supplies an ID only; paths and arguments stay local."""
    if not isinstance(ident, str):
        raise ValueError('请选择要打开的浏览器配置')
    with LOCK:
        rows = _profiles(data)
        if ident in ('all', 'chrome-all'):
            selected = [row for row in rows if row.get('include_in_all', True) and (ident == 'all' or row['browser'] == 'chrome')]
            if not selected:
                raise ValueError('本机尚未配置浏览器启动入口')
            results = []
            for row in selected:
                try:
                    results.append(_open(row))
                except ValueError as error:
                    results.append(dict(ok=False, id=row['id'], message=str(error)))
            return dict(ok=any(row['ok'] for row in results), results=results,
                        message='；'.join(row['message'] for row in results))
        row = next((row for row in rows if row['id'] == ident), None)
        if not row:
            raise ValueError('未知浏览器配置')
        return _open(row)
