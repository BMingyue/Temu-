"""Create a small offline update by comparing two verified clean releases."""
from __future__ import annotations
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import shutil
import sys
import zipfile

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
import delta_update_workbench as delta

def inventory(root):
 root=Path(root).resolve(); listed={}; seen=set(); listed_names=set()
 for line in (root/'SHA256SUMS.txt').read_text(encoding='utf-8-sig').splitlines():
  sha,name=line.split('  ',1); path=delta.safe_path(root,name)
  key=name.casefold()
  if key in seen or name=='SHA256SUMS.txt': raise RuntimeError('发布清单包含重复路径')
  seen.add(key)
  listed_names.add(name)
  if not path.is_file() or delta.digest(path)!=sha: raise RuntimeError('发布目录文件校验失败：'+name)
  if delta.private(name): continue
  if not delta.managed(name): raise RuntimeError('发布目录包含未知程序文件：'+name)
  listed[name]=sha
 actual={p.relative_to(root).as_posix() for p in root.rglob('*') if p.is_file()}
 if actual!=listed_names|{'SHA256SUMS.txt'}: raise RuntimeError('发布目录含未校验或运行后产生的文件')
 listed['SHA256SUMS.txt']=delta.digest(root/'SHA256SUMS.txt')
 delta.validate_inventory(listed)
 return listed

def build(before,after,output,archive=True):
 before,after,output=Path(before).resolve(),Path(after).resolve(),Path(output).resolve()
 if output.exists(): raise RuntimeError('输出目录已存在，请选择新的目录')
 if any(output==root or output.is_relative_to(root) or root.is_relative_to(output) for root in (before,after)):
  raise RuntimeError('更新输出目录必须与两个发布目录完全分开')
 old_release=delta.read_json(before/'workbench-release.json'); new_release=delta.read_json(after/'workbench-release.json')
 if old_release.get('product')!='temu-workbench' or new_release.get('product')!='temu-workbench': raise RuntimeError('请选择织品工作台干净发布目录')
 if delta.version_tuple(new_release['version'])<=delta.version_tuple(old_release['version']): raise RuntimeError('目标版本必须更新')
 old,new=inventory(before),inventory(after)
 changed={name:sha for name,sha in new.items() if old.get(name)!=sha}
 removed={name:sha for name,sha in old.items() if name not in new}
 if any(name.startswith('runtime/python/') for name in changed.keys()|removed.keys()):
  raise RuntimeError('Python运行组件改变，本次不能制作小更新，请提供完整包')
 output.mkdir(parents=True)
 for name in changed:
  target=delta.safe_path(output/'files',name); target.parent.mkdir(parents=True,exist_ok=True)
  shutil.copy2(delta.safe_path(after,name),target)
 for name in ('delta_update_workbench.py','workbench_processes.py'):
  shutil.copy2(ROOT/name,output/name)
 manifest={
  'schema':1,'product':'temu-workbench','created_utc':datetime.now(timezone.utc).isoformat(),
  'base_version':old_release['version'],'target_version':new_release['version'],
  'base_manifest_sha256':old['SHA256SUMS.txt'],'target_manifest_sha256':new['SHA256SUMS.txt'],
  'base_inventory':old,'target_inventory':new,'changed':changed,'removed':removed,
  'helpers':{name:delta.digest(output/name) for name in ('delta_update_workbench.py','workbench_processes.py')},
 }
 (output/'delta-manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
 script=(ROOT/'release/增量更新.ps1').read_text(encoding='utf-8-sig')
 script=script.replace('__MANIFEST_SHA256__',delta.digest(output/'delta-manifest.json'))
 (output/'update.ps1').write_text('\ufeff'+script,encoding='utf-8')
 shutil.copy2(ROOT/'release/增量更新.cmd',output/'双击更新工作台.cmd')
 readme=f'''织品工作台 · 保留数据的小更新

适用原版本：{old_release['version']}
更新后版本：{new_release['version']}

1. 在工作台结束采集、生图、上架任务，正常关闭专用浏览器和店小秘工具。
2. 右键此ZIP选“全部解压”，放在原工作台文件夹之外。
3. 双击“双击更新工作台.cmd”。它会从桌面快捷方式寻找原安装位置，找不到时请选择原安装文件夹。

程序会检查原版本、备份待改程序，再保留原账号、店铺、任务、图片和浏览器资料进行更新。不要手动把 files 文件夹覆盖到原程序。
此小更新只适用上面列出的原版本；其他版本请使用完整更新包。原程序被人工修改、文件不全或还有工具运行时，会停止并显示原因。
更新失败会恢复本次已改程序；旁边带“backup-delta”字样的文件夹保留原程序和更新记录，请勿先删除。
完成后会重新打开工作台。扩展更新后，请从工作台重新打开专用浏览器。
'''
 (output/'请先阅读.txt').write_text(readme,encoding='utf-8-sig')
 delta.load_package(output)
 result={'package':str(output),'base_version':old_release['version'],'target_version':new_release['version'],
         'changed_files':len(changed),'removed_files':len(removed),
         'payload_bytes':sum((output/'files'/name).stat().st_size for name in changed),
         'managed_base_files':len(old),'managed_target_files':len(new)}
 if archive:
  path=output.with_suffix('.zip')
  if path.exists(): raise RuntimeError('更新ZIP已存在')
  with zipfile.ZipFile(path,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=6) as bundle:
   for file in sorted(output.rglob('*')):
    if file.is_file(): bundle.write(file,output.name+'/'+file.relative_to(output).as_posix())
  with zipfile.ZipFile(path) as bundle:
   broken=bundle.testzip()
   if broken: raise RuntimeError('更新ZIP校验失败：'+broken)
  sha=delta.digest(path); path.with_suffix('.zip.sha256').write_text(sha+'  '+path.name+'\n',encoding='utf-8')
  result.update(archive=str(path),archive_bytes=path.stat().st_size,sha256=sha)
 return result

def main():
 parser=argparse.ArgumentParser()
 parser.add_argument('--base',type=Path,required=True); parser.add_argument('--target',type=Path,required=True)
 parser.add_argument('--output',type=Path,required=True); parser.add_argument('--no-archive',action='store_true')
 args=parser.parse_args(); print(json.dumps(build(args.base,args.target,args.output,not args.no_archive),ensure_ascii=False))

if __name__=='__main__': main()
