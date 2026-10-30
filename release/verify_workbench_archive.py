"""Validate every release member against the generated SHA256 manifest."""
import argparse
import hashlib
import json
from pathlib import Path
from urllib.parse import unquote
import re
import zipfile

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('archive',type=Path)
    parser.add_argument('--report',required=True,type=Path)
    args=parser.parse_args()
    prefix=args.archive.stem+'/'
    with zipfile.ZipFile(args.archive) as bundle:
        names=bundle.namelist()
        if len(set(names))!=len(names): raise RuntimeError('Duplicate archive members')
        if any(not name.startswith(prefix) or '..' in Path(name).parts for name in names): raise RuntimeError('Invalid archive member')
        checks={}
        for line in bundle.read(prefix+'SHA256SUMS.txt').decode('utf-8').splitlines():
            digest,relative=line.split('  ',1)
            checks[prefix+relative]=digest
        if set(names)!=set(checks)|{prefix+'SHA256SUMS.txt'}: raise RuntimeError('Checksum member set differs')
        for name,digest in checks.items():
            with bundle.open(name) as stream:
                if hashlib.file_digest(stream,'sha256').hexdigest()!=digest: raise RuntimeError('Checksum mismatch: '+name)
        info=json.loads(bundle.read(prefix+'版本信息.json'))
        manifest=json.loads(bundle.read(prefix+'browser_extension/manifest.json'))
        uploader=json.loads(bundle.read(prefix+'local_tools/dxm-uploader/版本信息.json'))
        components=json.loads(bundle.read(prefix+'workbench-components.json'))
        if info['uploader']!=components['uploader']['version'] or uploader['version']!=info['uploader'] or manifest['version']!=info['unified_extension']:
            raise RuntimeError('Unexpected version')
        for folder in ('browser_extension','gpt_chrome_extension'):
            value=json.loads(bundle.read(prefix+folder+'/manifest.json'))
            if set(value['background'])!={'service_worker'} or 'browser_specific_settings' in value:
                raise RuntimeError('Invalid Chrome MV3 manifest: '+folder)
        if json.loads(bundle.read(prefix+'gpt_chrome_extension/manifest.json'))['version']!=info['gpt_extension']:
            raise RuntimeError('GPT extension version differs')
        html=bundle.read(prefix+'web-dist/index.html').decode('utf-8')
        assets=re.findall(r'(?:src|href)="/([^"]+)"',html)
        if not assets or any(prefix+'web-dist/'+asset not in names for asset in assets): raise RuntimeError('Frontend assets missing')
        js=next(asset for asset in assets if asset.endswith('.js'))
        if info['release'] not in bundle.read(prefix+'web-dist/'+js).decode('utf-8'): raise RuntimeError('Frontend version differs')
        release=json.loads(bundle.read(prefix+'workbench-release.json'))
        if release['version']!=info['release']: raise RuntimeError('Backend version differs')
        for required in ['INSTALL.cmd','install_workbench.py','UPDATE.cmd','update_workbench.py','workbench_version.py','workbench_processes.py','patrol_health.py','patrol_traffic.py','colleague_browser.py','同事使用指南.txt','检查运行环境.cmd','diagnose_workbench.py','runtime/gpt-chrome/chrome-win64/chrome.exe']:
            if prefix+required not in names: raise RuntimeError('Missing upgrade entry '+required)
        forbidden={'data','state','logs','__pycache__','.migration','.openai'}
        if any(forbidden.intersection(Path(name[len(prefix):]).parts) for name in names): raise RuntimeError('User/cache directory included')
        if bundle.read(prefix+'gpt_chrome_extension/config.js').strip()!=b'globalThis.WORKBENCH_TOKEN="";':
            raise RuntimeError('GPT token embedded')
        config=bundle.read(prefix+'browser_extension/workbench-config.js').decode('utf-8')
        if 'wbPairLocalService' not in config or 'WORKBENCH_CONFIG.token' in config: raise RuntimeError('Invalid pairing configuration')
    with args.archive.open('rb') as stream: digest=hashlib.file_digest(stream,'sha256').hexdigest()
    if args.archive.with_suffix('.zip.sha256').read_text(encoding='utf-8').split('  ',1)[0]!=digest:
        raise RuntimeError('Archive sidecar hash differs')
    result={'archive':args.archive.name,'bytes':args.archive.stat().st_size,'sha256':digest,'verified_files':len(checks),'zip_crc_and_file_hashes':True,'versions':info,'frontend_assets_present':True,'private_runtime_directories_absent':True}
    args.report.write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(result,ensure_ascii=False,indent=2))

if __name__=='__main__': main()
