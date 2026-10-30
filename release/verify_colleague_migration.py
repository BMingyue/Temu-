"""Install to a disposable short Unicode path and exercise the real launcher."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import uuid
import urllib.request


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('bundle',type=Path)
    parser.add_argument('--report',type=Path,required=True)
    args=parser.parse_args()
    bundle=args.bundle.resolve()
    expected_uploader=json.loads((bundle/'workbench-components.json').read_text(encoding='utf-8'))['uploader']['version']
    fixture=Path('D:/Chatgpt_harness/_packagecheck')/('colleague-'+uuid.uuid4().hex[:6])
    fixture.mkdir(parents=True)
    target=fixture/'同事 工作台'
    appdata=fixture/'appdata'
    user=appdata/'DianxiaomiUploaderStandalone'
    user.mkdir(parents=True)
    (user/'keep-fixture.txt').write_text('fake colleague previous records',encoding='utf-8')
    env=os.environ.copy()
    for key in ('PYTHONHOME','PYTHONPATH','TCL_LIBRARY','TK_LIBRARY','TEMU_WORKBENCH_DATA'):
        env.pop(key,None)
    env.update(PYTHONUTF8='1',PYTHONDONTWRITEBYTECODE='1',LOCALAPPDATA=str(appdata),
               TEMU_WORKBENCH_PORT='18789',TEMU_WORKBENCH_WEB_PORT='15183',
               PATH=os.pathsep.join([str(Path(os.environ['SystemRoot'])/'System32'),os.environ['SystemRoot']]))
    flags=getattr(subprocess,'CREATE_NO_WINDOW',0)
    source_python=bundle/'runtime/python/python.exe'
    def run(python,code,cwd,timeout=90):
        result=subprocess.run([str(python),'-E','-X','utf8','-B',*code],cwd=cwd,env=env,capture_output=True,
                              text=True,encoding='utf-8',creationflags=flags,timeout=timeout)
        if result.returncode:
            raise RuntimeError(result.stdout+'\n'+result.stderr)
        return result.stdout
    result={'source':str(bundle),'installed':str(target),'path_has_unicode_and_space':True,'isolated_ports':[18789,15183]}
    result['package_check']=json.loads(run(source_python,['install_workbench.py','--check'],bundle))
    run(source_python,['install_workbench.py','--apply','--target',str(target),'--keep-uploader'],bundle)
    # Install output also contains human progress lines. The durable transaction
    # record is the authoritative installation result.
    installed=json.loads((target/'installation.json').read_text(encoding='utf-8'))
    result['install']=json.loads(Path(installed['backup_report']).read_text(encoding='utf-8'))
    if result['install']['status']!='complete': raise RuntimeError('Installation did not commit')
    result['previous_uploader_records_preserved']=(user/'keep-fixture.txt').is_file()
    python=target/'runtime/python/python.exe'
    try:
        output=run(python,['-c',"import launcher; launcher.webbrowser.open=lambda url: print(url); launcher.main()"],target,timeout=210)
        result['launcher_opened_workbench']='http://127.0.0.1:15183/' in output
        with urllib.request.urlopen('http://127.0.0.1:15183/api/health',timeout=4) as response:
            result['health']=json.load(response)
        with urllib.request.urlopen('http://127.0.0.1:15183/api/state',timeout=4) as response:
            state=json.load(response)
        result['empty_business_data']=not(state['fact_count'] or state['entries'] or state['catalog'])
        result['uploader_version']=state['tools']['uploader']['version']
        with urllib.request.urlopen('http://127.0.0.1:15183/api/colleague-browser',timeout=4) as response:
            result['collector_browser']=json.load(response)
        if not result['launcher_opened_workbench'] or not result['empty_business_data'] or result['uploader_version']!=expected_uploader or not result['collector_browser']['available']:
            raise RuntimeError('Migrated startup checks failed')
    finally:
        run(python,['-c',"from pathlib import Path; from workbench_processes import stop_services; stop_services(Path.cwd())"],target)
    result['source_data_absent']=not(bundle/'data').exists()
    if not result['source_data_absent'] or not result['previous_uploader_records_preserved']:
        raise RuntimeError('Source contamination or unexpected uploader reset')
    args.report.write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(result,ensure_ascii=False,indent=2))


if __name__=='__main__': main()
