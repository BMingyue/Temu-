"""Use disposable old/new installations; never touch the main workbench or daily browsers."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import urllib.request
import uuid


def wait_json(url):
    deadline=time.monotonic()+45
    while time.monotonic()<deadline:
        try:
            with urllib.request.urlopen(url,timeout=3) as response: return json.load(response)
        except (OSError,ValueError): time.sleep(.2)
    raise RuntimeError('Not ready: '+url)


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--old',type=Path,required=True)
    parser.add_argument('--new',type=Path,required=True)
    parser.add_argument('--report',type=Path,required=True)
    args=parser.parse_args()
    old,new=args.old.resolve(),args.new.resolve()
    report=args.report.resolve(); report.parent.mkdir(parents=True,exist_ok=True)
    run=new.parent.parent/'_cleancheck'/uuid.uuid4().hex[:8]
    run.mkdir(parents=True)
    target=run/'原工作台'
    shutil.copytree(old,target)
    env=os.environ.copy()
    for key in ('PYTHONHOME','PYTHONPATH','TCL_LIBRARY','TK_LIBRARY','TEMU_WORKBENCH_DATA'):
        env.pop(key,None)
    env.update(PYTHONUTF8='1',PYTHONDONTWRITEBYTECODE='1',
               TEMU_WORKBENCH_PORT='18799',TEMU_WORKBENCH_WEB_PORT='15193',
               LOCALAPPDATA=str(run/'appdata'))
    python=new/'runtime/python/python.exe'
    flags=getattr(subprocess,'CREATE_NO_WINDOW',0)
    children=[]
    result={'fixture':str(run),'release':json.loads((new/'workbench-release.json').read_text())['version']}
    log=(run/'services.log').open('wb')
    def start(script):
        child=subprocess.Popen([str(target/'runtime/python/python.exe'),str(target/script)],
                               cwd=target,env=env,stdout=log,stderr=log,creationflags=flags)
        children.append(child); return child
    try:
        # Simulate a colleague's old edition already occupying both addresses.
        start('backend.py'); start('portable_web.py')
        before=wait_json('http://127.0.0.1:15193/api/health')
        assert not before.get('version')
        (target/'data/private-fixture.txt').write_text('old colleague records')
        upload=run/'appdata/DianxiaomiUploaderStandalone'
        upload.mkdir(parents=True); (upload/'login.db').write_text('old uploader state')
        materials=target/'local_tools/qualification/assets/private-photo.txt'
        materials.parent.mkdir(parents=True,exist_ok=True); materials.write_text('personal asset')
        # Verify bundled Tk initializes and wizard widgets can be built without manual GUI automation.
        ui_code="""
from unittest.mock import patch
import tkinter as tk
import install_workbench
original=tk.Tk.__init__
def init(self,*a,**k):
    original(self,*a,**k); self.withdraw()
def check(self):
    self.update_idletasks()
    def labels(w):
        return [str(w.cget('text'))] if 'text' in w.keys() else []
    def walk(w):
        result=labels(w)
        for child in w.winfo_children(): result+=walk(child)
        return result
    values=walk(self)
    assert '开始全新安装' in values
    assert '重新检测' in values
    self.destroy()
with patch.object(tk.Tk,'__init__',init),patch.object(tk.Tk,'mainloop',check):
    install_workbench.wizard()
print('wizard built')
"""
        ui=subprocess.run([str(python),'-c',ui_code],cwd=new,env=env,capture_output=True,
                          text=True,encoding='utf-8',creationflags=flags,timeout=25)
        assert ui.returncode==0,ui.stderr
        result['bundled_tk_wizard']=True
        apply=subprocess.run([str(python),str(new/'install_workbench.py'),'--target',str(target),
                              '--old',str(target),'--apply'],cwd=new,env=env,
                             stdout=log,stderr=log,creationflags=flags,timeout=180)
        assert apply.returncode==0,'Clean installation failed; see '+str(run/'services.log')
        for child in children: child.wait(timeout=15)
        assert not (target/'data').exists()
        assert not materials.exists()
        assert not upload.exists()
        metadata=json.loads((target/'installation.json').read_text(encoding='utf-8'))
        install_report=json.loads(Path(metadata['backup_report']).read_text(encoding='utf-8'))
        copies={Path(x['original']):Path(x['backup']) for x in install_report['retired']}
        assert (copies[target]/'data/private-fixture.txt').read_text()=='old colleague records'
        assert (copies[upload]/'login.db').read_text()=='old uploader state'
        assert (copies[target]/'local_tools/qualification/assets/private-photo.txt').read_text()=='personal asset'
        result.update(old_port_owners_stopped=True,old_data_removed_from_active_path=True,
                      old_tool_state_removed=True,uploader_state_reset=True,backup_recoverable=True)
        # Use the real launcher's main() with only the final browser-open call suppressed.
        launcher=subprocess.Popen([str(target/'runtime/python/python.exe'),'-c',
            'import launcher; launcher.webbrowser.open=lambda url: True; launcher.main()'],
            cwd=target,env=env,stdout=log,stderr=log,creationflags=flags)
        children.append(launcher)
        after=wait_json('http://127.0.0.1:15193/api/health')
        frontend=wait_json('http://127.0.0.1:15193/__workbench__/version')
        launcher.wait(timeout=45); assert launcher.returncode==0
        assert after['version']==result['release']==frontend['version']
        assert after['installation_id']==frontend['installation_id']
        state=wait_json('http://127.0.0.1:15193/api/state')
        assert not state['entries'] and not state['catalog'] and state['fact_count']==0
        result.update(installed_launcher_ready=True,frontend_backend_version_match=True,empty_business_data=True)
        result['health']={key:after[key] for key in ('service','version','installation_id')}

        browser_code="""
import json,sys
from pathlib import Path
from playwright.sync_api import sync_playwright
target=Path(sys.argv[1])
with sync_playwright() as pw:
    browser=pw.chromium.launch(executable_path=str(target/'local_tools/dxm-uploader/_internal/browser/chrome.exe'),headless=True)
    try:
        page=browser.new_page(viewport={'width':1500,'height':1000})
        errors=[]; page.on('pageerror',lambda e:errors.append(str(e)))
        page.goto('http://127.0.0.1:15193/',wait_until='networkidle')
        page.get_by_text('工作台 '+sys.argv[2],exact=True).wait_for()
        assert not errors,errors
        page.screenshot(path=sys.argv[3],full_page=True)
        print(json.dumps({'version_visible':True,'page_errors':errors}))
    finally: browser.close()
"""
        browser=subprocess.run([str(target/'runtime/python/python.exe'),'-c',browser_code,str(target),
                                result['release'],str(report.parent/'clean-workbench.png')],
                                cwd=target,env=env,capture_output=True,text=True,encoding='utf-8',
                                creationflags=flags,timeout=45)
        assert browser.returncode==0,browser.stderr
        result['browser']=json.loads(browser.stdout)
        result['status']='passed'
        report.write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
        print(json.dumps(result,ensure_ascii=False,indent=2))
    finally:
        stop=subprocess.run([str(python),'-c',
            'from pathlib import Path; from workbench_processes import stop_services; import sys; stop_services(Path(sys.argv[1]))',
            str(target)],cwd=new,env=env,stdout=log,stderr=log,creationflags=flags,timeout=45)
        for child in children:
            if child.poll() is None: child.terminate()
            child.wait(timeout=15)
        log.close()
        shutil.copy2(run/'services.log',report.parent/'clean-services.log')
        if stop.returncode: raise RuntimeError('Cleanup failed; see '+str(run))
        # Keep this fixture for final review; caller can remove the exact printed fixture path.


if __name__=='__main__': main()
