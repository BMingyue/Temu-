"""Exercise previous release -> new release with real isolated services and data."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import time
import urllib.request
import uuid

def request(url):
    with urllib.request.urlopen(url,timeout=3) as response:
        return json.load(response)

def wait(url, predicate=lambda x: True):
    deadline=time.monotonic()+45
    while time.monotonic()<deadline:
        try:
            value=request(url)
            if predicate(value): return value
        except (OSError,ValueError): pass
        time.sleep(.2)
    raise RuntimeError('Not ready: '+url)

def hashfile(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--old',type=Path,required=True)
    parser.add_argument('--new',type=Path,required=True)
    parser.add_argument('--report',type=Path,required=True)
    args=parser.parse_args()
    args.report = args.report.resolve()
    old,new=args.old.resolve(),args.new.resolve()
    # Keep the installed tool paths short, as recommended for the portable release.
    run=new.parent.parent/'_upgrade-verification'/uuid.uuid4().hex[:8]
    run.mkdir(parents=True)
    target=run/'同事原目录'
    shutil.copytree(old,target)
    python=new/'runtime/python/python.exe'
    env=os.environ.copy()
    for name in ('PYTHONHOME','PYTHONPATH','TCL_LIBRARY','TK_LIBRARY'):
        env.pop(name,None)
    env.update(PYTHONUTF8='1',PYTHONDONTWRITEBYTECODE='1',
               TEMU_WORKBENCH_PORT='18789',TEMU_WORKBENCH_WEB_PORT='15183',
               TEMU_WORKBENCH_DATA=str(target/'data'),LOCALAPPDATA=str(run/'appdata'))
    expected=json.loads((new/'workbench-release.json').read_text(encoding='utf-8'))['version']
    flags=getattr(subprocess,'CREATE_NO_WINDOW',0)
    children=[]
    result={'old':str(old),'new':str(new),'target':str(target)}
    log=(run/'verification.log').open('wb')
    def start(script):
        child=subprocess.Popen([str(target/'runtime/python/python.exe'),str(target/script)],cwd=target,env=env,stdout=log,stderr=log,creationflags=flags)
        children.append(child); return child
    try:
        # Previous backend supports isolated ports; its old supervisor hard-codes 5173.
        start('backend.py'); start('portable_web.py')
        before=wait('http://127.0.0.1:18789/api/health')
        assert not before.get('version'),before
        result['old_health']=before
        data=target/'data'
        (data/'upgrade-sentinel.txt').write_text('同事历史不能丢',encoding='utf-8')
        token_before=hashfile(data/'bridge-token')
        db=data/'workbench.sqlite3'
        with sqlite3.connect(db) as connection:
            connection.execute('CREATE TABLE upgrade_test_private(value TEXT)')
            connection.execute("INSERT INTO upgrade_test_private VALUES ('colleague data')")
        materials=target/'local_tools/qualification/assets/同事自有材料.txt'
        materials.parent.mkdir(parents=True,exist_ok=True)
        materials.write_text('private assets',encoding='utf-8')
        original_extension=str((target/'browser_extension').resolve())
        # Check the new launcher rejects the already-running older directory.
        guard_code="import launcher; launcher.check_ports(launcher.ROOT)"
        guard=subprocess.run([str(python),'-c',guard_code],cwd=new,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,encoding='utf-8',creationflags=flags,timeout=15)
        assert guard.returncode!=0 and 'UPDATE.cmd' in guard.stderr,guard.stderr
        result['foreign_installation_blocked']=True
        apply=subprocess.run([str(python),str(new/'update_workbench.py'),'--target',str(target),'--apply'],cwd=new,env=env,stdout=log,stderr=log,creationflags=flags,timeout=180)
        assert apply.returncode==0,'Upgrade failed: '+str(run/'verification.log')
        for child in children: child.wait(timeout=10)
        assert (data/'upgrade-sentinel.txt').read_text(encoding='utf-8')=='同事历史不能丢'
        assert hashfile(data/'bridge-token')==token_before
        with sqlite3.connect(db) as connection:
            assert connection.execute('SELECT value FROM upgrade_test_private').fetchone()[0]=='colleague data'
        assert materials.read_text(encoding='utf-8')=='private assets'
        assert original_extension==str((target/'browser_extension').resolve())
        result.update(database_preserved=True,token_preserved=True,materials_preserved=True,extension_path_preserved=True)
        start('service_supervisor.py')
        after=wait('http://127.0.0.1:15183/api/health',lambda x:x.get('version')==expected)
        frontend=wait('http://127.0.0.1:15183/__workbench__/version')
        assert frontend['version']==expected and frontend['installation_id']==after['installation_id']
        assert after['instance_id']!=before['instance_id']
        result['new_health']=after; result['frontend']=frontend
        ready=subprocess.run([str(target/'runtime/python/python.exe'),'-c',"import launcher; assert launcher.current_version_ready(); print('ready')"],cwd=target,env=env,stdout=log,stderr=log,creationflags=flags,timeout=15)
        assert ready.returncode==0
        browser_code="""
import json,sys
from playwright.sync_api import sync_playwright
with sync_playwright() as pw:
    browser=pw.chromium.launch(executable_path=sys.argv[1],headless=True)
    try:
        page=browser.new_page(viewport={'width':1600,'height':1000})
        errors=[]; page.on('pageerror',lambda e:errors.append(str(e)))
        page.goto('http://127.0.0.1:15183/?release='+sys.argv[2],wait_until='networkidle')
        page.get_by_text('工作台 '+sys.argv[2],exact=True).wait_for()
        assert not page.get_by_role('alert').filter(has_text='后台服务版本').count()
        assert not errors,errors
        page.screenshot(path=sys.argv[3],full_page=True)
        print(json.dumps({'versionVisible':True,'mismatchBannerAbsent':True,'pageErrors':errors}))
    finally: browser.close()
"""
        ui=subprocess.run([str(target/'runtime/python/python.exe'),'-c',browser_code,str(target/'local_tools/dxm-uploader/_internal/browser/chrome.exe'),expected,str(args.report.parent/'upgraded-workbench.png')],cwd=target,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,encoding='utf-8',creationflags=flags,timeout=45)
        assert ui.returncode==0,ui.stderr
        result['browser']=json.loads(ui.stdout)
        result['upgraded_in_place']=True
        args.report.write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
        print(json.dumps(result,ensure_ascii=False,indent=2))
    finally:
        # Only this fixture may be stopped. Never touch daily-browser or main-workspace services.
        stop=subprocess.run([str(python),'-c',"from workbench_processes import stop_services; from pathlib import Path; import sys; stop_services(Path(sys.argv[1]))",str(target)],cwd=new,env=env,stdout=log,stderr=log,creationflags=flags,timeout=45)
        for child in children:
            if child.poll() is None: child.terminate()
            child.wait(timeout=10)
        log.close()
        if stop.returncode: raise RuntimeError('Fixture cleanup failed: '+str(run/'verification.log'))

if __name__=='__main__': main()
