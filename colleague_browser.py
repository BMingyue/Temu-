"""Dedicated colleague collection browser; never reuse personal browser profiles."""
from __future__ import annotations

import json
from pathlib import Path
import shutil
import subprocess
import threading
import time

import gpt_browser_profiles as browsers
from workbench_processes import WEB_PORT

ROOT = Path(__file__).resolve().parent
EXTENSION = ROOT / 'browser_extension'
URL = 'https://agentseller-us.temu.com/'
URLS = {'store': URL, 'selection': 'https://www.temu.com/'}
LOCK = threading.RLock()
LAST_OPENED = {}


def _row(data, executable):
    return dict(executable=str(executable), profile_path=str(Path(data).resolve() / 'collector-browser/user-data'))


def status(data):
    executable = browsers._testing_runtime()
    available = bool(executable and (EXTENSION / 'manifest.json').is_file())
    running = bool(executable and browsers._chrome_process(_row(data, executable)))
    try:
        version = json.loads((EXTENSION / 'manifest.json').read_text(encoding='utf-8'))['version']
    except (OSError, ValueError, KeyError):
        version = ''
    return dict(available=available, running=running, extension_version=version,
                message=('已配好统一助手；打开后登录自己的 Temu 美国站账号。升级助手后关闭此专用浏览器再打开。'
                         if available else '采集浏览器组件不完整，请重新安装工作台。'))


def open_browser(data, target='store'):
    mode = target
    if not isinstance(mode, str) or mode not in URLS:
        raise ValueError('浏览器用途无效，请选择店铺采集或选品。')
    with LOCK:
        executable = browsers._ensure_runtime()
        row = _row(data, executable)
        pid = browsers._chrome_process(row)
        if pid:
            focused = browsers._focus_window(pid)
            if mode == 'selection':
                key = row['profile_path'] + ':' + mode
                if time.monotonic() - LAST_OPENED.get(key, -5) < 5:
                    return dict(ok=True, already_running=True, already_requested=True, message='选品页面刚刚已打开，请切到专用浏览器。')
                subprocess.Popen([str(executable), '--user-data-dir=' + row['profile_path'],
                                  '--profile-directory=Default', '--new-tab', URLS[mode]],
                                 stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                 creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
                LAST_OPENED[key] = time.monotonic()
                return dict(ok=True, already_running=True, focused=focused, message='已在专用浏览器打开 Temu 选品页面。')
            return dict(ok=True, already_running=True, focused=focused,
                        message='采集浏览器已打开，请在原窗口登录或继续使用。升级助手后须关闭此浏览器再打开。')
        key = row['profile_path'] + ':' + mode
        if time.monotonic() - LAST_OPENED.get(key, -5) < 5:
            return dict(ok=True, already_requested=True, message='正在打开采集浏览器，请稍候。')
        folder = Path(data).resolve() / 'collector-browser'
        extension = folder / 'extension'
        # Only this application's own extension code is copied; no existing
        # browser login, history, extension storage or machine token is imported.
        shutil.copytree(EXTENSION, extension, dirs_exist_ok=True,
                        ignore=shutil.ignore_patterns('__pycache__', '*.pyc', '*.zip', '*.xpi'))
        manifest = json.loads((extension / 'manifest.json').read_text(encoding='utf-8'))
        manifest['background'] = {'service_worker': manifest['background']['service_worker']}
        manifest.pop('browser_specific_settings', None)
        (extension / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
        Path(row['profile_path']).mkdir(parents=True, exist_ok=True)
        process = subprocess.Popen(
            [str(executable), '--user-data-dir=' + row['profile_path'], '--profile-directory=Default',
             '--load-extension=' + str(extension), '--no-first-run', '--no-default-browser-check',
             '--new-window', f'http://127.0.0.1:{WEB_PORT}/', URLS[mode]], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        try:
            code = process.wait(timeout=.3)
        except subprocess.TimeoutExpired:
            code = None
        if code not in (None, 0):
            raise ValueError('采集浏览器启动失败，请运行“检查运行环境.cmd”。')
        LAST_OPENED[key] = time.monotonic()
        return dict(ok=True, already_running=False,
                    message=('已打开 Temu 选品页面和工作台，统一助手已自动加载。' if mode=='selection' else
                             '已打开专用采集浏览器并自动加载统一助手；请登录自己的 Temu 美国站账号，再切到同窗口的工作台标签。'))
