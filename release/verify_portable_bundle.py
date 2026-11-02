"""Smoke-test a staged release on isolated ports and temporary empty data."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import urllib.request

def wait(url):
    deadline=time.monotonic()+30
    while time.monotonic()<deadline:
        try:
            with urllib.request.urlopen(url,timeout=2) as response:
                return response.read()
        except OSError: time.sleep(.25)
    raise RuntimeError('Service not ready: '+url)

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('bundle',type=Path)
    parser.add_argument('--report',type=Path,required=True)
    args=parser.parse_args()
    bundle=args.bundle.resolve()
    python=bundle/'runtime/python/python.exe'
    result={'bundle':str(bundle)}
    expected_uploader=json.loads((bundle/'workbench-components.json').read_text(encoding='utf-8'))['uploader']['version']
    expected_traffic=json.loads((bundle/'版本信息.json').read_text(encoding='utf-8'))['traffic_accelerator']
    env=os.environ.copy()
    for name in ('PYTHONHOME','PYTHONPATH','TCL_LIBRARY','TK_LIBRARY'):
        env.pop(name,None)
    env['PYTHONDONTWRITEBYTECODE']='1'
    env['PYTHONUTF8']='1'
    env['PATH']=os.pathsep.join([str(Path(os.environ['SystemRoot'])/'System32'),os.environ['SystemRoot']])
    flags=getattr(subprocess,'CREATE_NO_WINDOW',0)
    with tempfile.TemporaryDirectory(prefix='temu-portable-smoke-',dir=str(args.report.parent)) as temp:
        temp=Path(temp)
        env['LOCALAPPDATA']=str(temp/'appdata')
        env['TEMU_WORKBENCH_DATA']=str(temp/'workbench-data')
        env['TEMU_WORKBENCH_PORT']='18779'
        env['TEMU_WORKBENCH_WEB_PORT']='15173'
        env['PLAYWRIGHT_BROWSERS_PATH']=str(temp/'no-system-browsers')
        imports=subprocess.run([str(python),'-c','import sys,json,psutil,PIL,playwright,greenlet,pyee,backend; print(json.dumps({"python":sys.executable,"prefix":sys.prefix,"backend":backend.__file__,"playwright":playwright.__file__}))'],cwd=bundle,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,encoding='utf-8',creationflags=flags,timeout=20)
        if imports.returncode: raise RuntimeError(imports.stderr)
        result['runtime']=json.loads(imports.stdout)
        for value in result['runtime'].values():
            if not Path(value).resolve().is_relative_to(bundle): raise RuntimeError('External runtime dependency: '+value)
        processes=[]
        with (temp/'services.log').open('wb') as log:
            try:
                for script in ('backend.py','portable_web.py'):
                    processes.append(subprocess.Popen([str(python),str(bundle/script)],cwd=bundle,env=env,stdout=log,stderr=log,creationflags=flags))
                result['health']=json.loads(wait('http://127.0.0.1:18779/api/health'))
                result['proxy_health']=json.loads(wait('http://127.0.0.1:15173/api/health'))
                html=wait('http://127.0.0.1:15173/').decode('utf-8')
                if '<script type="module"' not in html: raise RuntimeError('No prebuilt frontend entry')
                state=json.loads(wait('http://127.0.0.1:15173/api/state'))
                if state['fact_count'] or state['entries'] or state['catalog']:
                    raise RuntimeError('Release contains business records')
                result['empty_data']=True
                result['uploader']=state['tools']['uploader']
                if not result['uploader']['available'] or result['uploader']['version']!=expected_uploader:
                    raise RuntimeError('Bundled uploader not available')
                request=urllib.request.Request('http://127.0.0.1:18779/api/bridge/gpt/bootstrap',data=b'{}',headers={'Origin':'chrome-extension://'+'a'*32,'Content-Type':'application/json'},method='POST')
                with urllib.request.urlopen(request,timeout=3) as response: paired=json.load(response)
                if paired.get('service')!='temu-workbench' or len(paired.get('token',''))<32: raise RuntimeError('Pairing failed')
                result['local_pairing']=True
                browser_code = """
import json,sys
from playwright.sync_api import sync_playwright
with sync_playwright() as pw:
    browser=pw.chromium.launch(executable_path=sys.argv[1],headless=True)
    try:
        page=browser.new_page(viewport={'width':1600,'height':1000})
        errors=[]
        page.on('pageerror',lambda error:errors.append(str(error)))
        page.goto('http://127.0.0.1:15173/',wait_until='networkidle')
        page.get_by_role('navigation',name='工作板块').get_by_role('button',name='上新',exact=False).click()
        page.get_by_role('navigation',name='板块工具').get_by_role('button',name='店小秘上架',exact=True).click()
        button=page.get_by_role('button',name='打开店小秘上架 '+sys.argv[3])
        button.wait_for()
        assert button.is_enabled()
        page.screenshot(path=sys.argv[2],full_page=True)
        page.get_by_role('navigation',name='工作板块').get_by_role('button',name='维护',exact=False).click()
        page.get_by_role('navigation',name='板块工具').get_by_role('button',name='流量加速器',exact=True).click()
        page.get_by_text('工作台统一入口 · 已整合流量加速助手 v'+sys.argv[4],exact=True).wait_for()
        assert not errors,errors
        print(json.dumps({'rendered':True,'listing':True,'traffic':True,'errors':errors}))
    finally:
        browser.close()
"""
                browser_check=subprocess.run([str(python),'-c',browser_code,str(bundle/'runtime/gpt-chrome/chrome-win64/chrome.exe'),str(args.report.parent.resolve()/'portable-workbench.png'),expected_uploader,expected_traffic],cwd=bundle,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,encoding='utf-8',creationflags=flags,timeout=45)
                if browser_check.returncode: raise RuntimeError(browser_check.stderr)
                result['portable_browser']=json.loads(browser_check.stdout)
                executable=bundle/'local_tools/dxm-uploader/店小秘自动上架.exe'
                diagnostic=subprocess.run([str(executable),'--self-test','--report',str(temp/'uploader-self-test.json'),'--screenshot',str(args.report.parent.resolve()/'uploader-171.png')],cwd=executable.parent,env=env,stdout=log,stderr=log,creationflags=flags,timeout=60)
                result['uploader_diagnose_exit']=diagnostic.returncode
                if diagnostic.returncode: raise RuntimeError('Uploader diagnose failed')
                # Decode its own offline report without exposing machine or user data.
                self_test=json.loads((temp/'uploader-self-test.json').read_text(encoding='utf-8'))
                if not self_test.get('ok'): raise RuntimeError('Uploader self-test checks failed')
                result['uploader_self_test']={'ok':self_test['ok'],'checks':len(self_test.get('checks',[]))}
            finally:
                for process in reversed(processes):
                    if process.poll() is None: process.terminate()
                for process in processes: process.wait(timeout=15)
        result['no_packaged_data_created']=not (bundle/'data').exists()
        if not result['no_packaged_data_created']: raise RuntimeError('Package was contaminated by runtime data')
    args.report.write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(result,ensure_ascii=False,indent=2))

if __name__=='__main__': main()
