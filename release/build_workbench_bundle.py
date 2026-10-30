"""Build a clean Windows portable distribution from explicit source allowlists."""
from __future__ import annotations
import argparse
import hashlib
import importlib.metadata
import json
from pathlib import Path
import shutil
import sys
import zipfile

ROOT = Path(__file__).resolve().parents[1]
NAME = 'Temu-Workbench-Windows-x64-20261030'
RELEASE = json.loads((ROOT / 'workbench-release.json').read_text(encoding='utf-8'))['version']
COMPONENTS = json.loads((ROOT / 'workbench-components.json').read_text(encoding='utf-8-sig'))
PRODUCTION = (
    'backend.py','merchant.py','collector.py','operations.py','sync_audit.py',
    'collector_control.py','image_jobs.py','image_workflows.py','image_source_edits.py','image_job_retry.py','gpt_browser_profiles.py','gpt_runner.py',
    'gpt_extension_bridge.py','gpt_unattended.py','activity_jobs.py',
    'activity_enrollment.py','price_window.py','feature_tools.py','patrol_health.py','patrol_traffic.py','colleague_browser.py',
    'product_operations.py','product_rules.py','launcher.py','service_supervisor.py',
    'restart_workbench.py','portable_web.py','启动工作台.vbs',
    'workbench_version.py','workbench_processes.py','workbench-release.json','workbench-components.json','update_workbench.py','install_workbench.py','delta_update_workbench.py',
)
EXCLUDED_DIRS = {'__pycache__','.git','.cache','logs','state'}
DEPENDENCIES = ('psutil','PIL','playwright','greenlet','pyee','typing_extensions.py','tzdata')
INFO = {
    'name':'织品工作台 · Windows 同事推广版',
    'release':RELEASE,
    'platform':'Windows 10/11 x64',
    'uploader':COMPONENTS['uploader']['version'],'traffic_accelerator':'1.0.6',
    'unified_extension':json.loads((ROOT/'browser_extension/manifest.json').read_text(encoding='utf-8'))['version'],
    'gpt_extension':json.loads((ROOT/'gpt_chrome_extension/manifest.json').read_text(encoding='utf-8'))['version'],
    'contains_user_data':False,
}
COLLEAGUE_GUIDE = """织品工作台 · 同事使用指南

第一次安装（Windows 10/11 64位）
1. 右键收到的安装包，选择“全部解压”。
2. 双击“安装织品工作台.cmd”，等待文件检查完成。
3. 首次使用保持推荐位置，点“安装并打开”。程序会创建桌面快捷方式。
不需要安装 Python、Node、浏览器插件或编程软件，不需要管理员权限。

第一次使用
1. 双击桌面“织品工作台”。首页按“巡店 / 维护 / 上新”选择工作。
2. 巡店和维护：在首次使用引导点“打开采集浏览器”，在新窗口登录自己的 Temu 美国站，然后切到同窗口的工作台标签。统一助手已自动装好；保持窗口打开，按页面提示同步数据。
3. 生图：进入“上新”的批量生图，新增独立 Chrome 并打开，登录自己的 GPT 账号。助手已自动装好；选择自己的图片和保存位置。
4. 店小秘：在“上新”点“店小秘上架”，打开当前内置独立版，首次登录自己的账号并选择自己的商品目录。
大量 SPU：逐行勾选，或全选当前筛选的所有页，再复制 SPU、查看所选或复制表格。

平时
每天双击桌面入口即可。浏览器里的工作台页面关闭后，本地服务可能仍运行。
更新助手后，关闭专用采集浏览器或生图 Chrome，再从工作台重新打开。
停止本机服务：安装目录 STOP.cmd。业务执行中请先在页面正常停止任务。
遇到问题：双击安装目录“检查运行环境.cmd”，将“环境检查结果.txt”发给提供者。

迁移给下一位同事
只转发原始安装 ZIP。不要复制使用过的安装目录；里面会有你的店铺、任务和登录资料。
本原始安装包不含任何人的账号、浏览器登录、商品或任务；每位同事独立登录。
网络账号、店铺权限、商品图片和资质材料由使用者自己准备。Windows 或企业安全软件若提示拦截，请保留完整提示给提供者。

已经安装过旧工作台
先完成或停止旧的采集、生图、上架任务。向导会列出旧目录，替换前显示确认并保留 .old 备份。
默认保留此 Windows 用户已有的店小秘登录与完成记录。只有明确勾选重置选项才会移入备份。
新版本使用专用浏览器，不必手动加载插件。旧浏览器中的旧助手请保持停用，避免重复执行。
"""
README = '# 织品工作台 '+RELEASE+' · 同事安装版\n\n'+COLLEAGUE_GUIDE

def write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding='utf-8', newline='')

def copy_tree(source, target, extra_exclude=()):
    exclude = EXCLUDED_DIRS | set(extra_exclude)
    def ignore(folder, names):
        return [name for name in names if name in exclude or name.endswith(('.pyc','.pyo','.log','.zip','.xpi'))]
    shutil.copytree(source, target, ignore=ignore)

def verify_uploader(folder):
    version = json.loads((folder / '版本信息.json').read_text(encoding='utf-8'))
    if version['version'] != INFO['uploader']:
        raise RuntimeError('Unexpected uploader version')
    expected = set()
    for line in (folder / '文件校验SHA256.txt').read_text(encoding='utf-8-sig').splitlines():
        digest, relative = line.split('  ', 1)
        path = folder / relative
        if not path.resolve().is_relative_to(folder.resolve()):
            raise RuntimeError('Invalid uploader checksum path')
        if hashlib.file_digest(path.open('rb'), 'sha256').hexdigest() != digest:
            raise RuntimeError('Uploader checksum mismatch: '+relative)
        expected.add(relative)
    actual = {p.relative_to(folder).as_posix() for p in folder.rglob('*') if p.is_file()}
    if actual - expected != {'文件校验SHA256.txt'}:
        raise RuntimeError('Unexpected files in uploader: '+str(actual-expected))
    return len(expected)

def stage(output, python_root, automation_root):
    if output.exists():
        raise RuntimeError('Output already exists; use a new output directory')
    if not (ROOT / 'dist-portable/index.html').is_file():
        raise RuntimeError('Build the portable frontend first')
    output.mkdir(parents=True)
    for name in PRODUCTION:
        shutil.copy2(ROOT / name, output / name)
    (output / 'web-dist').mkdir()
    for name in ('index.html','favicon.svg'):
        shutil.copy2(ROOT / 'dist-portable' / name, output / 'web-dist' / name)
    copy_tree(ROOT / 'dist-portable/assets', output / 'web-dist/assets')
    copy_tree(ROOT / 'browser_extension', output / 'browser_extension')
    copy_tree(ROOT / 'gpt_chrome_extension', output / 'gpt_chrome_extension')
    # Use a blank dedicated browser on the destination computer. This runtime
    # is application code only: never copy a browser's user-data directory.
    chrome = ROOT / 'runtime/gpt-chrome/chrome-win64'
    if not (chrome / 'chrome.exe').is_file():
        raise RuntimeError('Missing Chrome for Testing runtime')
    copy_tree(chrome, output / 'runtime/gpt-chrome/chrome-win64')
    # Chrome MV3 must not receive the Firefox background.scripts entry.
    for folder in ('browser_extension', 'gpt_chrome_extension'):
        manifest_path = output / folder / 'manifest.json'
        manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
        manifest['background'].pop('scripts', None)
        manifest.pop('browser_specific_settings', None)
        write(manifest_path, json.dumps(manifest, ensure_ascii=False, indent=2)+'\n')
    write(output / 'gpt_chrome_extension/config.js', 'globalThis.WORKBENCH_TOKEN="";\n')
    copy_tree(ROOT / 'image_presets', output / 'image_presets')
    for name in ('compliance-confirmation','gpt-extension-folder','lion-scraper-extension','long-path-mover'):
        copy_tree(ROOT / 'local_tools' / name, output / 'local_tools' / name)
    copy_tree(ROOT / 'local_tools/qualification', output / 'local_tools/qualification', ('assets',))
    write(output / 'local_tools/qualification/assets/请先配置自己的资质材料.txt',
          '不随推广包分发原作者的实拍图和GCC报告。请使用自己商品真实有效的 产品正面图.jpg、产品侧视图.jpg、水洗唛.jpg、包装正视图.jpg、自制证书3.0(1).pdf。\n')
    uploader_count = verify_uploader(ROOT / 'local_tools/dxm-uploader')
    # Preserve the vendor payload byte-for-byte, including its own license and checksums.
    shutil.copytree(ROOT / 'local_tools/dxm-uploader', output / 'local_tools/dxm-uploader')
    target_runtime = output / 'runtime/python'
    target_runtime.mkdir(parents=True)
    for pattern in ('python*.exe','python*.dll','vcruntime*.dll','LICENSE*'):
        for source in python_root.glob(pattern):
            shutil.copy2(source, target_runtime / source.name)
    for folder in ('DLLs','tcl'):
        if (python_root / folder).is_dir():
            copy_tree(python_root / folder, target_runtime / folder)
    copy_tree(python_root / 'Lib', target_runtime / 'Lib', ('site-packages','test','tests','idlelib','ensurepip'))
    site = target_runtime / 'Lib/site-packages'
    site.mkdir()
    roots = [python_root / 'Lib/site-packages', automation_root, Path(sys.executable).parent / 'Lib/site-packages']
    for name in DEPENDENCIES:
        source = next((base / name for base in roots if (base / name).exists()), None)
        if source is None:
            raise RuntimeError('Missing runtime dependency: '+name)
        if source.is_dir(): copy_tree(source, site / name)
        else: shutil.copy2(source, site / name)
        distribution = {'PIL':'pillow'}.get(name, name.removesuffix('.py'))
        for metadata in source.parent.glob(distribution+'-*.dist-info'):
            copy_tree(metadata, site / metadata.name)
    # Keep source-only entry points for future maintenance, never historical reports.
    for folder in ('app','components','hooks','lib'):
        copy_tree(ROOT / folder, output / 'source' / folder)
    for name in ('package.json','pnpm-lock.yaml','tsconfig.json','vite.config.ts','next-env.d.ts'):
        shutil.copy2(ROOT / name, output / 'source' / name)
    shutil.copy2(ROOT / 'workbench-release.json', output / 'source/workbench-release.json')
    shutil.copy2(ROOT / 'workbench-components.json', output / 'source/workbench-components.json')
    copy_tree(ROOT / 'release/web', output / 'source/release/web')
    shutil.copy2(ROOT / 'release/vite.portable.config.ts', output / 'source/release/vite.portable.config.ts')
    bootstrap = '@echo off\r\nchcp 65001 >nul\r\ncd /d "%~dp0"\r\nset PYTHONUTF8=1\r\nset PYTHONDONTWRITEBYTECODE=1\r\nset PYTHONHOME=\r\nset PYTHONPATH=\r\nset TCL_LIBRARY=\r\nset TK_LIBRARY=\r\n'
    check = 'if not exist "%~dp0runtime\\python\\python.exe" (\r\n  echo Python runtime missing. Right-click the ZIP and choose Extract All first.\r\n  pause\r\n  exit /b 1\r\n)\r\n'
    write(output / 'INSTALL.cmd', bootstrap+check+'"runtime\\python\\python.exe" -E -X utf8 -B install_workbench.py %*\r\nif errorlevel 1 pause\r\n')
    write(output / 'START.cmd', bootstrap+check+'start "" "runtime\\python\\pythonw.exe" -E -B launcher.py\r\n')
    write(output / 'STOP.cmd', '@echo off\ncd /d "%~dp0"\n"runtime\\python\\python.exe" stop_workbench.py\npause\n')
    write(output / 'UPDATE.cmd', '@echo off\nchcp 65001 >nul\ncd /d "%~dp0"\nset PYTHONUTF8=1\nset PYTHONDONTWRITEBYTECODE=1\n"%~dp0runtime\\python\\python.exe" "%~dp0update_workbench.py"\nif errorlevel 1 pause\n')
    shutil.copy2(ROOT / 'release/stop_workbench.py', output / 'stop_workbench.py')
    write(output / '使用说明.md', README)
    write(output / '同事使用指南.txt', COLLEAGUE_GUIDE)
    write(output / '检查运行环境.cmd', bootstrap+check+'"runtime\\python\\python.exe" -E -X utf8 -B diagnose_workbench.py\r\npause\r\n')
    shutil.copy2(ROOT / 'release/diagnose_workbench.py', output / 'diagnose_workbench.py')
    write(output / '版本信息.json', json.dumps(INFO, ensure_ascii=False, indent=2)+'\n')
    write(output / 'source/维护说明.md', '主后端源码在发布包根目录；页面源码在 source。开发时把页面源码与根目录后端合并到同一目录，使用 pnpm-lock.yaml 安装依赖，再运行 Vite --config release/vite.portable.config.ts 构建；将 dist-portable 替换为 web-dist。发布包运行不依赖构建工具。\n')
    audit(output)
    print(json.dumps({'staged':str(output),'uploader_verified_files':uploader_count}, ensure_ascii=False), flush=True)

def audit(output):
    if (output / 'data').exists():
        raise RuntimeError('Never distribute a directory after running it with real data')
    for path in output.rglob('*'):
        if not path.is_file(): continue
        relative = path.relative_to(output)
        if any(part in {'state','logs','__pycache__','.migration','.openai'} for part in relative.parts):
            raise RuntimeError('Unexpected private/cache path: '+str(relative))
        if path.name in {'bridge-token','Cookies','Login Data','workbench.sqlite3'} or path.suffix.lower() in {'.sqlite3','.sqlite','.log'}:
            raise RuntimeError('Unexpected user record: '+str(relative))
    config = (output / 'browser_extension/workbench-config.js').read_text(encoding='utf-8')
    if 'wbPairLocalService' not in config or 'WORKBENCH_CONFIG.token' in config:
        raise RuntimeError('Collector still requires an embedded machine token')
    if (output / 'gpt_chrome_extension/config.js').read_text(encoding='utf-8').strip() != 'globalThis.WORKBENCH_TOKEN="";':
        raise RuntimeError('GPT package contains a machine token')
    manifest = json.loads((output / 'browser_extension/manifest.json').read_text(encoding='utf-8'))
    if manifest['version'] != INFO['unified_extension']: raise RuntimeError('Unexpected extension version')
    if json.loads((output/'gpt_chrome_extension/manifest.json').read_text(encoding='utf-8'))['version'] != INFO['gpt_extension']:
        raise RuntimeError('Unexpected GPT extension version')
    if not (output/'runtime/gpt-chrome/chrome-win64/chrome.exe').is_file():
        raise RuntimeError('Missing automatic browser runtime')
    for folder in ('browser_extension','gpt_chrome_extension'):
        value = json.loads((output / folder / 'manifest.json').read_text(encoding='utf-8'))
        if set(value['background']) != {'service_worker'} or 'browser_specific_settings' in value:
            raise RuntimeError('Invalid Chrome MV3 manifest: '+folder)
    for name in ['traffic-background.js','workbench-web-bridge.js','traffic/runner.js','traffic/records-transfer.js']:
        if not (output / 'browser_extension' / name).is_file(): raise RuntimeError('Missing integration '+name)

def archive(output):
    audit(output)
    checksums=[]
    for path in sorted(output.rglob('*')):
        if path.is_file() and path.name != 'SHA256SUMS.txt':
            with path.open('rb') as source: digest=hashlib.file_digest(source,'sha256').hexdigest()
            checksums.append(digest+'  '+path.relative_to(output).as_posix())
    write(output / 'SHA256SUMS.txt','\n'.join(checksums)+'\n')
    archive_path=output.with_suffix('.zip')
    if archive_path.exists(): raise RuntimeError('Archive already exists')
    with zipfile.ZipFile(archive_path,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=6) as bundle:
        for path in sorted(output.rglob('*')):
            if path.is_file(): bundle.write(path,output.name+'/'+path.relative_to(output).as_posix())
    with archive_path.open('rb') as source: digest=hashlib.file_digest(source,'sha256').hexdigest()
    write(archive_path.with_suffix('.zip.sha256'),digest+'  '+archive_path.name+'\n')
    print(json.dumps({'archive':str(archive_path),'bytes':archive_path.stat().st_size,'sha256':digest,'files':len(checksums)+1},ensure_ascii=False),flush=True)

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--output',required=True,type=Path)
    parser.add_argument('--python-root',type=Path,default=Path(sys.executable).parent)
    parser.add_argument('--automation-root',type=Path,required=False)
    parser.add_argument('--archive-only',action='store_true')
    args=parser.parse_args()
    if args.archive_only: archive(args.output)
    else:
        if not args.automation_root: parser.error('--automation-root is required when staging')
        stage(args.output,args.python_root,args.automation_root)

if __name__ == '__main__': main()
