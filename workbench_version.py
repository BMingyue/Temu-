"""The release loaded by this process, independent of later file replacement."""
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
RELEASE = json.loads((ROOT / 'workbench-release.json').read_text(encoding='utf-8'))
VERSION = RELEASE['version']

def identity(root=ROOT):
    return hashlib.sha256(str(Path(root).resolve()).casefold().encode('utf-8')).hexdigest()[:24]

def health_identity():
    return {'version': VERSION, 'installation_id': identity()}
