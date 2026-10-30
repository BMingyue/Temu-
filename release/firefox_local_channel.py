"""Publish to the existing dedicated Firefox's local-file policy, without admin rights.

Firefox reads its installation policy at startup. We update only that policy's
already-authorized GPT XPI file, not the browser policy, profile, or live process.
"""
from __future__ import annotations
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
from urllib.parse import urlparse, unquote
from urllib.request import url2pathname
import uuid
import zipfile

GECKO_ID = 'temu-gpt-image-helper@local.workbench'
ROOT = Path(__file__).resolve().parents[1]
CONFIG = ROOT / 'data' / 'firefox-gpt-update-channels.json'


def read_package(path):
    path = Path(path)
    with zipfile.ZipFile(path) as archive:
        manifest = json.loads(archive.read('manifest.json'))
        if archive.testzip() is not None:
            raise ValueError('Firefox XPI is corrupt')
    if manifest.get('browser_specific_settings', {}).get('gecko', {}).get('id') != GECKO_ID:
        raise ValueError('Not the workbench GPT extension; refusing to replace it')
    version = str(manifest.get('version', ''))
    if not re.fullmatch(r'\d+(?:\.\d+){1,3}', version):
        raise ValueError('Invalid GPT extension version')
    return dict(version=version, sha256=hashlib.sha256(path.read_bytes()).hexdigest())


def version_key(version):
    values = tuple(map(int, version.split('.')))
    return values + (0,) * (4 - len(values))


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    try:
        temp.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
        os.replace(temp, path)
    finally:
        if temp.exists():
            temp.unlink()


def register_policy(policy_path, config=CONFIG):
    """Read, never change, the existing Firefox policy and register its GPT file."""
    policy = json.loads(Path(policy_path).read_text(encoding='utf-8-sig'))
    setting = policy['policies']['ExtensionSettings'][GECKO_ID]
    if setting.get('installation_mode') not in ('normal_installed', 'force_installed'):
        raise ValueError('The GPT extension has no existing auto-install policy')
    uri = urlparse(setting.get('install_url', ''))
    if uri.scheme != 'file' or uri.netloc:
        raise ValueError('Only an existing local-file Firefox policy can be registered')
    target = Path(url2pathname(unquote(uri.path))).resolve()
    if target.suffix.lower() != '.xpi' or not target.is_file():
        raise ValueError('The existing policy XPI file is missing')
    read_package(target)
    config = Path(config)
    saved = json.loads(config.read_text(encoding='utf-8')) if config.exists() else {'targets': []}
    targets = list(dict.fromkeys([*saved.get('targets', []), str(target)]))
    if len(targets) > 8:
        raise ValueError('Too many local Firefox channels')
    value = dict(saved, gecko_id=GECKO_ID, targets=targets, policy_source=str(Path(policy_path).resolve()),
                 activation='dedicated desktop launcher checks updates before startup; never restart a running browser')
    atomic_json(config, value)
    return value


def profile_running(profile):
    """Probe Firefox's profile lock; do not inspect login or cookie databases."""
    import ctypes
    from ctypes import wintypes
    lock = Path(profile) / 'parent.lock'
    if not lock.exists():
        return False
    if os.name != 'nt':
        raise ValueError('Cannot safely inspect a Windows Firefox profile lock')
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                                   wintypes.LPVOID, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
    kernel.CreateFileW.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    handle = kernel.CreateFileW(str(lock), 0x80000000, 0, None, 3, 0x80, None)
    if handle == ctypes.c_void_p(-1).value:
        error = ctypes.get_last_error()
        if error in (32, 33):
            return True
        raise OSError(error, 'Cannot safely access the dedicated Firefox profile lock')
    kernel.CloseHandle(handle)
    return False


def synchronize_profile(source, profile, backups, running=None):
    profile = Path(profile).resolve()
    if profile.name != 'temu-workbench-dev':
        raise ValueError('Not the dedicated workbench Firefox profile')
    installed = profile / 'extensions' / (GECKO_ID + '.xpi')
    if not installed.is_file():
        raise ValueError('Dedicated Firefox GPT extension is missing')
    read_package(installed)
    if (profile_running if running is None else running)(profile):
        return dict(path=str(installed), changed=False, deferred=True, reason='Firefox profile is running')
    return dict(publish(source, installed, backups), deferred=False)


def publish(source, destination, backups):
    source, destination = Path(source), Path(destination)
    incoming = read_package(source)
    if destination.suffix.lower() != '.xpi' or not destination.parent.is_dir():
        raise ValueError('Invalid Firefox XPI destination')
    previous = read_package(destination) if destination.exists() else None
    if previous and version_key(previous['version']) > version_key(incoming['version']):
        raise ValueError('Refusing to downgrade the Firefox GPT extension')
    if previous and previous['sha256'] == incoming['sha256']:
        return dict(path=str(destination), changed=False, **incoming)
    if previous:
        backups = Path(backups)
        backups.mkdir(parents=True, exist_ok=True)
        backup = backups / (destination.stem + '-' + previous['version'] + '-' + previous['sha256'][:16] + '.xpi')
        if not backup.exists():
            shutil.copy2(destination, backup)
    temporary = destination.with_name(destination.name + '.' + uuid.uuid4().hex + '.tmp')
    try:
        shutil.copyfile(source, temporary)
        if read_package(temporary)['sha256'] != incoming['sha256']:
            raise ValueError('Firefox publish copy failed verification')
        os.replace(temporary, destination)
    finally:
        if temporary.exists():
            temporary.unlink()
    return dict(path=str(destination), changed=True, **incoming)


def publish_registered(source, release, config=CONFIG):
    config, release = Path(config), Path(release)
    backups = config.parent / 'firefox-extension-backups'
    targets = [release / 'Temu-gpt-image-helper-firefox-latest.xpi']
    if config.exists():
        saved = json.loads(config.read_text(encoding='utf-8'))
        if saved.get('gecko_id') != GECKO_ID:
            raise ValueError('Firefox channel configuration has the wrong extension ID')
        targets.extend(Path(value) for value in saved.get('targets', []))
    rows = [publish(source, destination, backups) for destination in dict.fromkeys(targets)]
    if config.exists():
        for profile in saved.get('profiles', []):
            rows.append(synchronize_profile(source, profile, backups))
    atomic_json(release / 'firefox-gpt-local-channel-status.json', dict(
        published_at=datetime.now(timezone.utc).isoformat(), channels=rows,
        activation='dedicated desktop launcher checks updates before startup; no automatic browser restart'))
    return rows


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--register-policy', required=True)
    parser.add_argument('--register-profile')
    args = parser.parse_args()
    value = register_policy(args.register_policy)
    if args.register_profile:
        profile = Path(args.register_profile).resolve()
        if profile.name != 'temu-workbench-dev':
            raise ValueError('Not the dedicated Firefox profile')
        read_package(profile / 'extensions' / (GECKO_ID + '.xpi'))
        value['profiles'] = list(dict.fromkeys([*value.get('profiles', []), str(profile)]))
        atomic_json(CONFIG, value)
    print(json.dumps(value, ensure_ascii=False))
