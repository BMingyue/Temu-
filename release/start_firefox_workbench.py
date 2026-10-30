"""The dedicated Firefox shortcut: apply the published local build before launch."""
from pathlib import Path
import json
import os
import subprocess

try:
    from firefox_local_channel import ROOT, CONFIG, profile_running, synchronize_profile
except ImportError:
    from release.firefox_local_channel import ROOT, CONFIG, profile_running, synchronize_profile


def main():
    settings = json.loads(CONFIG.read_text(encoding='utf-8'))
    profiles = settings.get('profiles', [])
    if len(profiles) != 1:
        raise ValueError('Expected exactly one registered dedicated Firefox profile')
    profile = Path(profiles[0]).resolve()
    if profile.name != 'temu-workbench-dev':
        raise ValueError('Refusing to launch another browser profile')
    if profile_running(profile):
        print('Dedicated Firefox is already open; no update or restart performed.')
        return
    source = ROOT / 'release' / 'Temu-gpt-image-helper-firefox-latest.xpi'
    result = synchronize_profile(source, profile, CONFIG.parent / 'firefox-extension-backups')
    if result.get('deferred'):
        return
    firefox = Path(os.environ.get('ProgramFiles', r'C:\Program Files')) / 'Firefox Developer Edition' / 'firefox.exe'
    if not firefox.is_file():
        raise ValueError('Firefox Developer Edition executable not found')
    subprocess.Popen([str(firefox), '-no-remote', '-profile', str(profile)],
                     creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    print(json.dumps(dict(ok=True, update=result, profile=str(profile)), ensure_ascii=False))


if __name__ == '__main__':
    main()
