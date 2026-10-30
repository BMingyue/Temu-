"""Load both final unpacked extensions in an isolated Chromium profile with network blocked."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('bundle',type=Path)
    parser.add_argument('--report',type=Path,required=True)
    args=parser.parse_args()
    bundle=args.bundle.resolve(); report=args.report.resolve()
    env=os.environ.copy()
    for key in ('PYTHONHOME','PYTHONPATH','TCL_LIBRARY','TK_LIBRARY'):
        env.pop(key,None)
    env.update(PYTHONUTF8='1',PYTHONDONTWRITEBYTECODE='1')
    with tempfile.TemporaryDirectory(prefix='temu-ext-',dir=bundle.parent.parent) as temp:
        code="""
import json,sys,time
from pathlib import Path
from playwright.sync_api import sync_playwright
bundle=Path(sys.argv[1])
paths=','.join(str(bundle/name) for name in ('browser_extension','gpt_chrome_extension'))
with sync_playwright() as pw:
    context=pw.chromium.launch_persistent_context(sys.argv[2],
        executable_path=str(bundle/'runtime/gpt-chrome/chrome-win64/chrome.exe'),
        headless=True,ignore_default_args=['--disable-extensions'],
        args=['--disable-extensions-except='+paths,'--load-extension='+paths,
              '--proxy-server=http://127.0.0.1:9','--proxy-bypass-list=<-loopback>'])
    try:
        deadline=time.monotonic()+25
        workers=[]
        while time.monotonic()<deadline:
            workers=[w for w in context.service_workers if w.url.startswith('chrome-extension://')]
            if len(workers)>=2: break
            context.pages[0].wait_for_timeout(200)
        assert len(workers)==2,[w.url for w in workers]
        results=[]
        for worker in workers:
            value=worker.evaluate('''async () => {
                const m=chrome.runtime.getManifest();
                const storage=await chrome.storage.local.get(null);
                const forbidden=Object.keys(storage).filter(k=>k.startsWith('workbench.outbox.')||k==='temuCollectorState.v2'||k==='armedDownload');
                return {name:m.name,version:m.version,background:m.background,oldTaskKeys:forbidden};
            }''')
            assert value['oldTaskKeys']==[],value
            assert set(value['background'])=={'service_worker'},value
            results.append(value)
        print(json.dumps({'loaded':results,'both_service_workers_ready':True,'network':'blocked by loopback proxy'},ensure_ascii=False))
    finally: context.close()
"""
        result=subprocess.run([str(bundle/'runtime/python/python.exe'),'-c',code,str(bundle),temp],
                              cwd=bundle,env=env,capture_output=True,text=True,encoding='utf-8',
                              creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0),timeout=50)
        if result.returncode: raise RuntimeError(result.stderr)
        value=json.loads(result.stdout)
        report.write_text(json.dumps(value,ensure_ascii=False,indent=2),encoding='utf-8')
        print(json.dumps(value,ensure_ascii=False,indent=2))


if __name__=='__main__': main()
