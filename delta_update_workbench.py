"""Apply a verified offline program delta without touching account or task data."""
from __future__ import annotations
import argparse
from contextlib import closing, contextmanager
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import sys
import unicodedata
import uuid
import psutil
from workbench_processes import is_link_path, listener_roots, service_root, stop_services

PRIVATE_PARTS = {'data','state','logs','__pycache__','.git','.migration','.openai',
                 'browser-profile','user-data','failure-records','upload-staging'}
PRIVATE_NAMES = {'cookies','login data','bridge-token','token','token.json','credentials.json','secrets.json',
                 'config.json','state.json','protected.json','cleanup.jsonl'}
ROOT_FILES = {
 'backend.py','merchant.py','collector.py','operations.py','sync_audit.py','collector_control.py',
 'image_jobs.py','image_workflows.py','image_source_edits.py','image_job_retry.py','gpt_browser_profiles.py',
 'gpt_runner.py','gpt_extension_bridge.py','gpt_unattended.py','activity_jobs.py','activity_enrollment.py',
 'price_window.py','feature_tools.py','patrol_health.py','patrol_traffic.py','colleague_browser.py',
 'product_operations.py','product_rules.py','launcher.py','service_supervisor.py','restart_workbench.py',
 'portable_web.py','启动工作台.vbs','workbench_version.py','workbench_processes.py','workbench-release.json',
 'update_workbench.py','install_workbench.py','delta_update_workbench.py','git_update_workbench.py',
 'stop_workbench.py','START.cmd','STOP.cmd','UPDATE.cmd','INSTALL.cmd','使用说明.md','同事使用指南.txt',
 '检查运行环境.cmd','diagnose_workbench.py','版本信息.json','SHA256SUMS.txt',
 'git-update.json','workbench-components.json','一键更新.cmd','一键更新.vbs',
}
ROOT_DIRS = {'runtime','web-dist','browser_extension','gpt_chrome_extension','source','local_tools','image_presets'}
ROOT_FILES.update({'从GitHub安装更新.cmd','maintenance/github_workbench_update.ps1'})
COMMIT_FILES = ('版本信息.json','SHA256SUMS.txt','workbench-release.json')
ACTIVE_JOB_PHASES = {'queued','claimed','sending','sent','waiting','downloading','running'}

def digest(path):
 with Path(path).open('rb') as stream:
  return hashlib.file_digest(stream,'sha256').hexdigest()

def relative_parts(name):
 if not isinstance(name,str) or not name or name.startswith('/') or '\\' in name or ':' in name:
  raise RuntimeError('更新文件路径无效')
 parts=name.split('/')
 for part in parts:
  if part in ('','.','..') or part[-1:] in (' ','.') or any(ord(c)<32 for c in part):
   raise RuntimeError('更新文件路径无效')
  if re.fullmatch(r'(?i)(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?',part):
   raise RuntimeError('更新文件路径无效')
 return parts

def private(name):
 parts=relative_parts(name); folded=[part.casefold() for part in parts]
 return (bool(set(folded)&PRIVATE_PARTS) or parts[:3]==['local_tools','qualification','assets']
         or parts==['gpt_chrome_extension','config.js'] or folded[-1] in PRIVATE_NAMES
         or any(part.startswith('.env') or part.startswith('failure-records') for part in folded))

def managed(name):
 parts=relative_parts(name)
 return not private(name) and (name in ROOT_FILES or parts[0] in ROOT_DIRS)

def safe_path(root,name):
 root=Path(root).resolve(); parts=relative_parts(name); current=root
 if is_link_path(root): raise RuntimeError('更新目录不能是目录链接')
 for part in parts:
  current=current/part
  if is_link_path(current): raise RuntimeError('更新路径含目录链接，请人工核对')
 if not current.resolve().is_relative_to(root): raise RuntimeError('更新路径超出安装目录')
 return current

def version_tuple(value):
 if not isinstance(value,str) or not re.fullmatch(r'\d+(?:\.\d+){1,4}',value):
  raise RuntimeError('更新版本号无效')
 return tuple(map(int,value.split('.')))

def read_json(path):
 try: return json.loads(Path(path).read_text(encoding='utf-8-sig'))
 except (OSError,ValueError) as error: raise RuntimeError('文件未能读取，请保留现场并重新获取完整更新包：'+Path(path).name) from error

def validate_inventory(values):
 if not isinstance(values,dict) or not values: raise RuntimeError('更新清单为空')
 seen=set()
 for name,sha in values.items():
  folded=unicodedata.normalize('NFC',name).casefold()
  if not managed(name) or folded in seen or not isinstance(sha,str) or not re.fullmatch('[0-9a-f]{64}',sha):
   raise RuntimeError('更新清单包含非法、重复或私有路径')
  seen.add(folded)

def load_package(package):
 package=Path(package).resolve(); value=read_json(package/'delta-manifest.json')
 if value.get('schema')!=1 or value.get('product')!='temu-workbench': raise RuntimeError('不是织品工作台小更新包')
 base,new=value.get('base_version'),value.get('target_version')
 if version_tuple(new)<=version_tuple(base): raise RuntimeError('更新版本必须高于原版本')
 before,after=value.get('base_inventory'),value.get('target_inventory')
 validate_inventory(before); validate_inventory(after)
 required={'backend.py','launcher.py','workbench-release.json','SHA256SUMS.txt','web-dist/index.html'}
 if not required.issubset(before) or not required.issubset(after): raise RuntimeError('小更新缺少必要版本文件')
 changed={name:sha for name,sha in after.items() if before.get(name)!=sha}
 removed={name:sha for name,sha in before.items() if name not in after}
 if set(value.get('changed',{}))!=set(changed) or value['changed']!=changed or value.get('removed')!=removed:
  raise RuntimeError('小更新差异清单与目标清单不一致')
 if any(name.startswith('runtime/python/') for name in changed.keys()|removed.keys()):
  raise RuntimeError('Python运行组件改变，请使用完整安装包更新')
 helper=value.get('helpers',{})
 if set(helper)!={'delta_update_workbench.py','workbench_processes.py'}: raise RuntimeError('更新器组件不完整')
 for name,sha in helper.items():
  path=safe_path(package,name)
  if not re.fullmatch('[0-9a-f]{64}',sha) or not path.is_file() or digest(path)!=sha: raise RuntimeError('更新器文件已损坏')
 actual={p.relative_to(package/'files').as_posix() for p in (package/'files').rglob('*') if p.is_file()}
 if actual!=set(changed): raise RuntimeError('小更新缺少文件或含额外文件')
 for name,sha in changed.items():
  path=safe_path(package/'files',name)
  if not path.is_file() or digest(path)!=sha: raise RuntimeError('更新文件校验失败：'+name)
 for key in ('base_manifest_sha256','target_manifest_sha256'):
  if not re.fullmatch('[0-9a-f]{64}',str(value.get(key,''))): raise RuntimeError('版本清单校验值无效')
 if before['SHA256SUMS.txt']!=value['base_manifest_sha256'] or after['SHA256SUMS.txt']!=value['target_manifest_sha256']:
  raise RuntimeError('版本清单校验值不一致')
 for key,expected in (('base_inventory',base),('target_inventory',new)):
  if key=='target_inventory':
   release=read_json(safe_path(package/'files','workbench-release.json'))
   if release.get('product')!='temu-workbench' or release.get('version')!=expected: raise RuntimeError('目标版本文件不一致')
 return value

def verify_inventory(target,inventory,exclude=()):
 for name,sha in inventory.items():
  if name in exclude: continue
  path=safe_path(target,name)
  if not path.is_file() or digest(path)!=sha:
   raise RuntimeError('原程序版本与小更新不匹配或程序被改动：'+name+'。请使用对应的完整更新包。')

def validate_target(package,target,value):
 if is_link_path(Path(target)): raise RuntimeError('安装目录不能是目录链接')
 target=Path(target).resolve(); package=Path(package).resolve()
 if target==package or target.is_relative_to(package) or package.is_relative_to(target):
  raise RuntimeError('请将更新包解压到安装目录之外，不要先覆盖原程序')
 release=read_json(safe_path(target,'workbench-release.json'))
 if release.get('product')!='temu-workbench': raise RuntimeError('请选择织品工作台安装文件夹')
 version=release.get('version')
 if version==value['target_version']:
  verify_inventory(target,value['target_inventory']); return target,True
 if version!=value['base_version']: raise RuntimeError('此小更新适用于 '+value['base_version']+'，所选目录为 '+str(version))
 verify_inventory(target,value['base_inventory'])
 for name in value['changed']:
  if name not in value['base_inventory'] and safe_path(target,name).exists(): raise RuntimeError('新增程序文件与原目录文件冲突：'+name)
 return target,False

def assert_business_quiet(target):
 data=safe_path(target,'data')
 if data.exists():
  for path in (data/'image-jobs').glob('*/job.json'):
   if is_link_path(path) or is_link_path(path.parent): raise RuntimeError('任务记录含链接，请人工核对')
   if read_json(path).get('batch_phase') in ACTIVE_JOB_PHASES: raise RuntimeError('还有生图任务排队或执行中，请先正常结束任务再更新')
  control=data/'collector-control.json'
  if control.exists():
   state=read_json(control)
   if (any(row.get('status') in ('queued','running') for row in state.get('commands',[])) or
       any((row.get('task_state') or {}).get('status')=='running' for row in state.get('clients',{}).values())):
    raise RuntimeError('还有采集任务未结束，请先正常停止后更新')
  database=data/'workbench.sqlite3'
  if database.exists():
   if is_link_path(database): raise RuntimeError('业务记录含链接，请人工核对')
   try:
    with closing(sqlite3.connect(database.resolve().as_uri()+'?mode=ro',uri=True,timeout=3)) as db:
     tables={row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
     for table in ('activity_enrollment_batches','activity_execution_manifests'):
      if table in tables and db.execute('SELECT 1 FROM '+table+" WHERE status IN ('queued','claimed','running','submission_attempted') LIMIT 1").fetchone():
       raise RuntimeError('还有活动或调价作业未结束，请先核对后更新')
   except sqlite3.Error as error: raise RuntimeError('无法核对本地业务记录，请保留现场并联系负责人') from error
 for process in psutil.process_iter(['pid','name','exe','cmdline']):
  try:
   if process.pid==os.getpid() or service_root(process)==target: continue
   info=process.info; name=str(info.get('name') or '')
   if name.casefold() in {'店小秘自动上架.exe','dxmuploader-windows-x64.exe'}: raise RuntimeError('店小秘上架工具仍在运行，请先正常关闭工具后更新')
   executable=Path(info['exe']).resolve() if info.get('exe') else None
   args=info.get('cmdline') or []
   script=Path(args[1]) if len(args)>1 and not str(args[1]).startswith('-') else None
   if script and not script.is_absolute(): script=Path(process.cwd())/script
   if ((executable and executable.is_relative_to(target)) or (script and script.resolve().is_relative_to(target))):
    raise RuntimeError('专用浏览器或工具仍在运行，请先正常关闭后更新：'+name)
  except (psutil.NoSuchProcess,psutil.AccessDenied): continue
 for owner in listener_roots().values():
  if owner!=target: raise RuntimeError('另一个工作台或程序正在占用地址，请正常关闭后更新所选目录')

@contextmanager
def update_lock(target):
 path=target.parent/('.'+target.name+'.delta-update.lock')
 if is_link_path(path): raise RuntimeError('更新锁文件含链接')
 with path.open('a+b') as lock:
  lock.seek(0); lock.write(b'0'); lock.flush(); lock.seek(0)
  if os.name=='nt':
   import msvcrt
   try: msvcrt.locking(lock.fileno(),msvcrt.LK_NBLCK,1)
   except OSError as error: raise RuntimeError('另一个更新程序正在运行') from error
  else:
   import fcntl
   try: fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
   except OSError as error: raise RuntimeError('另一个更新程序正在运行') from error
  try: yield
  finally:
   lock.seek(0)
   if os.name=='nt': msvcrt.locking(lock.fileno(),msvcrt.LK_UNLCK,1)
   else: fcntl.flock(lock,fcntl.LOCK_UN)

def atomic_copy(source,destination,expected):
 destination.parent.mkdir(parents=True,exist_ok=True)
 temporary=destination.with_name(destination.name+'.delta-'+uuid.uuid4().hex)
 try:
  shutil.copy2(source,temporary)
  if digest(temporary)!=expected: raise RuntimeError('复制程序文件校验失败')
  os.replace(temporary,destination)
 finally:
  if temporary.exists(): temporary.unlink()

def start_workbench(target):
 python=target/'runtime/python/pythonw.exe'
 if not python.is_file(): raise RuntimeError('更新完成，但启动组件缺失，请从原桌面入口启动')
 subprocess.Popen([str(python),str(target/'launcher.py')],cwd=target,
                  creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))

def apply_update(package,target,launch=False,notify=print):
 package=Path(package).resolve(); value=load_package(package)
 target,already=validate_target(package,target,value)
 if already: return {'status':'already_updated','version':value['target_version'],'target':str(target)}
 assert_business_quiet(target)
 names=list(value['changed'])+list(value['removed'])
 names.sort(key=lambda name:(name in COMMIT_FILES,COMMIT_FILES.index(name) if name in COMMIT_FILES else 0,name))
 backup=target.parent/(target.name+'-backup-delta-'+datetime.now().strftime('%Y%m%d-%H%M%S')+'-'+uuid.uuid4().hex[:6])
 report={'status':'checking','target':str(target),'version':value['target_version'],'base_version':value['base_version'],
         'backup':str(backup),'data_preserved':True,'changes':[]}
 with update_lock(target):
  target,already=validate_target(package,target,value)
  if already: return {'status':'already_updated','version':value['target_version'],'target':str(target)}
  assert_business_quiet(target)
  required=sum(safe_path(target,n).stat().st_size for n in names if safe_path(target,n).is_file())
  if shutil.disk_usage(target.parent).free<required*2+50_000_000: raise RuntimeError('备份空间不足，请释放空间后重试')
  backup.mkdir(exist_ok=False); journal=backup/'update-report.json'
  def save():
   temp=journal.with_suffix('.tmp'); temp.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8'); os.replace(temp,journal)
  notify('正在备份待更新程序；账号和业务数据保持原位…')
  for name in names:
   old=safe_path(target,name)
   if old.is_file():
    destination=safe_path(backup/'program',name); destination.parent.mkdir(parents=True,exist_ok=True)
    shutil.copy2(old,destination)
    if digest(destination)!=value['base_inventory'][name]: raise RuntimeError('程序备份校验失败')
  report['status']='backed_up'; save()
  changes=[]
  try:
   assert_business_quiet(target); stop_services(target); assert_business_quiet(target)
   verify_inventory(target,value['base_inventory'])
   report['status']='applying'; save()
   notify('正在更新 '+str(len(names))+' 个程序文件…')
   for name in names:
    destination=safe_path(target,name); before=value['base_inventory'].get(name)
    if (before is None and destination.exists()) or (before is not None and (not destination.is_file() or digest(destination)!=before)):
     raise RuntimeError('更新期间原程序有变化，已停止：'+name)
    changes.append(name); report['changes']=list(changes); save()
    if name in value['removed']: destination.unlink()
    else: atomic_copy(safe_path(package/'files',name),destination,value['changed'][name])
   verify_inventory(target,value['target_inventory'])
   for name in value['removed']:
    if safe_path(target,name).exists(): raise RuntimeError('旧程序文件未正确移除')
   report['status']='complete'; save()
  except BaseException as error:
   report['error']=str(error)
   try:
    for name in reversed(changes):
     destination=safe_path(target,name); before=value['base_inventory'].get(name); after=value['target_inventory'].get(name)
     current=digest(destination) if destination.is_file() else None
     if current==before: continue
     if current not in (None,after): raise RuntimeError('回滚期间程序被外部改动，请保留备份并联系负责人')
     if before is None:
      if destination.exists(): destination.unlink()
     else: atomic_copy(safe_path(backup/'program',name),destination,before)
    report['status']='rolled_back'; save()
   except BaseException as recovery:
    report['status']='recovery_required'; report['recovery_error']=str(recovery); save()
    raise RuntimeError('更新未完成且需要恢复，请保留备份：'+str(backup)) from recovery
   raise RuntimeError('更新未完成，已恢复原程序。备份：'+str(backup)) from error
 if launch:
  try: start_workbench(target)
  except Exception as error: report['launch_warning']=str(error)
 return report

def main():
 parser=argparse.ArgumentParser(description='织品工作台小更新（保留账号与任务）')
 parser.add_argument('--package',type=Path,default=Path(__file__).resolve().parent)
 parser.add_argument('--target',type=Path,required=True)
 group=parser.add_mutually_exclusive_group(required=True); group.add_argument('--check',action='store_true'); group.add_argument('--apply',action='store_true')
 parser.add_argument('--launch',action='store_true'); args=parser.parse_args()
 if args.check:
  value=load_package(args.package); target,already=validate_target(args.package,args.target,value); assert_business_quiet(target)
  result={'status':'already_updated' if already else 'ready','base_version':value['base_version'],'version':value['target_version'],'changed':len(value['changed']),'removed':len(value['removed'])}
 else: result=apply_update(args.package,args.target,args.launch)
 print(json.dumps(result,ensure_ascii=False))

if __name__=='__main__':
 try: main()
 except Exception as error:
  print('更新未完成：'+str(error),file=sys.stderr); sys.exit(1)
