"""Prepare resumable image jobs. Browser execution is a separate adapter."""
from pathlib import Path
import json,uuid,shutil,zipfile,base64,re,threading,os,hashlib
from datetime import datetime,timezone,timedelta

IMAGE_EXT={'.png','.jpg','.jpeg','.webp'}
PROMPT_LOCK=threading.RLock()
LEGACY_DEFAULT_PROMPT='现在我采集到了1个不同载体的印花。我需要把这部分印花全部转移到我的一套地垫套图上，并且把场景中的其他摆件换成符合印花图案的氛围摆件，这样来生成新的套图。上传的压缩包模板是套图模板。上传图为参考印花图。调用五次生图工具。给我五张单独的图片。不得出现拼图。'
DEFAULT_PROMPT='把参考印花自然应用到每张{category}模板上，并根据印花主题协调少量场景摆件。'
PROMPT_PROTOCOL_MARKER='【织品工作台固定套图协议 v1】'
PROMPT_PROTOCOL='''【织品工作台固定套图协议 v1】
本消息附带参考图和一个套图模板 ZIP。参考图是本次印花、图案和配色来源；ZIP 内正好有 {total} 张相互独立的模板图片。

请立即使用图像生成工具执行本任务，不要只回复文字说明：
1. 解读参考图中的有效印花，把同一套印花分别应用到 ZIP 内每一张模板对应的商品主体上。
2. 必须对 {total} 张模板分别调用 {total} 次生图工具，每张模板生成一张独立图片，共返回 {total} 张成品。
3. 每次生成只使用参考图与当前对应模板，保持该模板原有构图、人物、产品形态、文字和场景用途，不得把多张模板合成一张拼图。
4. 输出顺序必须与 ZIP 内模板顺序一致；不得遗漏、重复或用文字回答替代任何一张图片。
5. 如果附加要求只描述局部修改，它只补充本协议，不能取消“逐模板生成 {total} 张独立图片”的要求。

商品类型：{category}
用户附加要求：
{extra}

现在开始依次生成并返回 {total} 张单独图片。'''
def prompt_settings(data):
 with PROMPT_LOCK:
  p=Path(data)/'image-prompt.json'
  value=json.loads(p.read_text(encoding='utf-8')) if p.exists() else {'prompt':DEFAULT_PROMPT,'version':0,'saved_at':None,'last_used_prompt':None,'last_used_at':None}
  if value.get('prompt')==LEGACY_DEFAULT_PROMPT:value['prompt']=DEFAULT_PROMPT
  return value
def validate_prompt(value):
 if not isinstance(value,str) or not value.strip():raise ValueError('提示词不能为空')
 if len(value)>12000:raise ValueError('提示词最多 12000 字')
 return value
def save_prompt(body,data):
 with PROMPT_LOCK:
  old=prompt_settings(data)
  if body.get('version')!=old['version']:raise ValueError('提示词已在其他页面更新，请刷新后再编辑；本页文字未被清空')
  value=validate_prompt(body.get('prompt'))
  updated={**old,'prompt':value,'version':old['version']+1,'saved_at':datetime.now(timezone.utc).isoformat()}
  _write_prompt(updated,data);return updated
def _write_prompt(value,data):
 root=Path(data);root.mkdir(parents=True,exist_ok=True);temp=root/('image-prompt-'+uuid.uuid4().hex+'.tmp')
 temp.write_text(json.dumps(value,ensure_ascii=False,indent=2),encoding='utf-8');os.replace(temp,root/'image-prompt.json')
def used_prompt(value,data):
 with PROMPT_LOCK:
  old=prompt_settings(data);_write_prompt({**old,'last_used_prompt':value,'last_used_at':datetime.now(timezone.utc).isoformat()},data)
def render_prompt(value,category,index,total=5):
 # 用户输入始终作为“附加要求”。固定协议由系统生成，防止短提示词意外
 # 覆盖逐模板生图、输出数量和禁止拼图等不可缺少的执行约束。
 if value==LEGACY_DEFAULT_PROMPT:value=DEFAULT_PROMPT
 value=value.replace('调用五次生图工具',f'调用{total}次生图工具').replace('给我五张单独的图片',f'给我{total}张单独的图片')
 extra=value.replace('{category}',category).replace('{index}',str(index)).replace('{total}',str(total)).strip()
 if PROMPT_PROTOCOL_MARKER in extra:return extra
 return PROMPT_PROTOCOL.format(category=category,index=index,total=total,extra=extra or '无额外要求。')
def config(data):
 path=Path(data)/'image-config.json'
 cfg=json.loads(path.read_text(encoding='utf-8')) if path.exists() else {'source_folder':str(Path(data)/'image-inbox'),'template_folder':str(Path(data)/'templates'),'output_folder':str(Path(data)/'generated')}
 for key,folder,extensions in [('references','source_folder',IMAGE_EXT),('templates','template_folder',{'.zip'})]:
  p=Path(cfg[folder]);cfg[key]=[{'name':f.name,'path':str(f)} for f in sorted(p.iterdir()) if f.is_file() and f.suffix.lower() in extensions][:200] if p.is_dir() else []
 return cfg

def upload(body,data):
 name=Path(str(body.get('name','image.png'))).name;ext=Path(name).suffix.lower()
 if ext not in IMAGE_EXT:raise ValueError('仅支持 PNG/JPG/WEBP 印花图')
 try:content=base64.b64decode(body.get('content',''),validate=True)
 except (ValueError,TypeError):raise ValueError('图片编码无效')
 if not content or len(content)>10_000_000:raise ValueError('单张印花图需在 10MB 以内')
 if not (content.startswith(b'\x89PNG\r\n\x1a\n') or content.startswith(b'\xff\xd8\xff') or (content.startswith(b'RIFF') and content[8:12]==b'WEBP')):raise ValueError('文件内容不是支持的图片')
 stem=re.sub(r'[<>:"/\\|?*\x00-\x1f]','_',Path(name).stem).strip(' .')[:80] or 'print'
 if body.get('fixed'):folder=Path(data)/'fixed-images'
 elif body.get('extra_reference'):folder=Path(data)/'reference-attachments'
 else:folder=Path(config(data)['source_folder'])
 folder.mkdir(parents=True,exist_ok=True)
 dest=folder/(stem+'-'+uuid.uuid4().hex[:8]+ext)
 with dest.open('xb') as f:f.write(content)
 return {'name':dest.name,'path':str(dest)}
def prepare(body,data):
 if body.get('workflow_id') and body['workflow_id']!='legacy_zip':
  import image_workflows
  return image_workflows.prepare(body,data)
 title=str(body.get('title','')).strip()
 if not title:raise ValueError('请填写任务名称')
 category=body.get('category','毛毯')
 if category not in ('毛毯','地垫'):raise ValueError('请选择毛毯或地垫')
 prompt_source=validate_prompt(body.get('prompt',prompt_settings(data)['prompt']))
 reference=Path(str(body.get('reference','')).strip().strip('"'))
 template=Path(str(body.get('template','')).strip().strip('"'))
 if not reference.is_file() or reference.suffix.lower() not in IMAGE_EXT:raise ValueError('参考印花请填写一张本地 PNG/JPG/WEBP 图片的完整路径')
 if reference.stat().st_size>30_000_000:raise ValueError('参考图超过 30MB，请先缩小')
 extra_references=body.get('extra_references',[])
 if not isinstance(extra_references,list) or len(extra_references)>7:raise ValueError('额外参考图最多 7 张；加上主参考图共 8 张')
 reference_sources=[reference]
 seen_references={str(reference.resolve()).lower()}
 for value in extra_references:
  extra=Path(str(value).strip().strip('"'))
  if not extra.is_file() or extra.suffix.lower() not in IMAGE_EXT:raise ValueError('额外参考图不存在或格式不支持：'+str(value))
  if extra.stat().st_size>30_000_000:raise ValueError('额外参考图超过 30MB：'+extra.name)
  key=str(extra.resolve()).lower()
  if key in seen_references:continue
  seen_references.add(key);reference_sources.append(extra)
 files=[];archive=None
 if template.is_dir():
  files=sorted([p for p in template.iterdir() if p.is_file() and p.suffix.lower() in IMAGE_EXT],key=lambda p:p.name)
 elif template.is_file() and template.suffix.lower()=='.zip':
  try:
   with zipfile.ZipFile(template) as z:
    files=sorted([i for i in z.infolist() if not i.is_dir() and Path(i.filename).suffix.lower() in IMAGE_EXT and not i.filename.startswith('__MACOSX/')],key=lambda i:i.filename)
  except zipfile.BadZipFile:raise ValueError('模板压缩包无法读取')
  archive=template
 else:raise ValueError('套图模板请填写包含图片的文件夹或 ZIP 路径')
 if not files:raise ValueError('模板中至少需要一张 PNG/JPG/WEBP 图片')
 if any((f.file_size if archive else f.stat().st_size)>30_000_000 for f in files):raise ValueError('单张模板超过 30MB')
 total=len(files);prompt_template=render_prompt(prompt_source,category,'{index}',total)
 ident=uuid.uuid4().hex;folder=Path(data)/'image-jobs'/ident;folder.mkdir(parents=True)
 try:
  inputs=folder/'inputs';inputs.mkdir()
  output_root=Path(body.get('output_folder') or config(data)['output_folder']).resolve();output_root.mkdir(parents=True,exist_ok=True)
  safe_title=re.sub(r'[<>:"/\\|?*\x00-\x1f]','_',title).strip(' .')[:60] or 'image'
  result_folder=output_root/('GPT-'+safe_title+'-'+ident[:8]);result_folder.mkdir()
  reference_images=[]
  for number,source in enumerate(reference_sources,1):
   name='reference'+(f'-{number:02d}' if number>1 else '')+source.suffix.lower()
   dest=inputs/name;shutil.copyfile(source,dest);reference_images.append(str(dest))
  ref=Path(reference_images[0])
  package=inputs/(archive.name if archive else '套图模板.zip')
  if archive:shutil.copyfile(archive,package)
  else:
   with zipfile.ZipFile(package,'w',zipfile.ZIP_DEFLATED) as z:
    for f in files:z.write(f,arcname=f.name)
  fixed=[]
  for n,source in enumerate(body.get('fixed_images',[]),total+1):
   original=Path(source)
   if not original.is_file() or original.suffix.lower() not in IMAGE_EXT:raise ValueError('固定图不存在或格式不支持：'+str(source))
   if original.stat().st_size>30_000_000:raise ValueError('固定图超过 30MB')
   dest=inputs/(f'fixed-{n:02d}'+original.suffix.lower());shutil.copyfile(original,dest)
   fixed.append({'source':str(dest),'name':original.name,'number':n,'sha256':hashlib.sha256(dest.read_bytes()).hexdigest()})
  steps=[]
  for n,f in enumerate(files,1):
   name=f.filename if archive else f.name;dest=inputs/(f'template-{n:02d}'+Path(name).suffix.lower())
   if archive:
    with zipfile.ZipFile(archive) as z, z.open(f) as source, dest.open('wb') as target:shutil.copyfileobj(source,target)
   else:shutil.copyfile(f,dest)
   prompt=render_prompt(prompt_source,category,n,total)
   (folder/f'prompt-{n:02d}.txt').write_text(prompt,encoding='utf-8')
   steps.append({'number':n,'template_name':name,'reference':str(ref),'template':str(dest),'prompt':prompt,'status':'待执行'})
  created=datetime.now(timezone.utc).isoformat();task_no=f'IMG-{created[:10].replace("-","")}-{ident[:8].upper()}'
  job={'id':ident,'task_no':task_no,'title':title,'category':category,'prompt_template':prompt_template,'expected_count':total,'reference':str(ref),'reference_images':reference_images,'template_archive':str(package),'created':created,'status':'素材已准备，等待浏览器账号执行','folder':str(folder),'result_folder':str(result_folder),'steps':steps,'fixed_images':fixed,'logs':[{'at':created,'event':'prepared','message':f'{len(reference_images)} 张参考图、模板 ZIP 和 {total} 个输出槽位已准备'}]}
  (folder/'job.json').write_text(json.dumps(job,ensure_ascii=False,indent=2),encoding='utf-8')
  used_prompt(prompt_source,data)
  return job
 except Exception:
  # Only the newly created job directory is removed on failed preparation.
  if folder.resolve().parent==(Path(data)/'image-jobs').resolve():shutil.rmtree(folder)
  if 'result_folder' in locals() and result_folder.resolve().parent==output_root and result_folder.is_dir():result_folder.rmdir()
  raise

def _read_jobs(data):
 result=[]
 for f in (Path(data)/'image-jobs').glob('*/job.json'):
  try:result.append(json.loads(f.read_text(encoding='utf-8')))
  except (OSError,ValueError):continue
 return sorted(result,key=lambda j:j['created'],reverse=True)

def list_jobs(data):
 result=_read_jobs(data)
 import gpt_extension_bridge
 connected=gpt_extension_bridge.snapshot(data).get('status')!='未连接'
 for j in result:
  if j.get('batch_phase')=='queued' and not connected:j['status']='等待 GPT 执行页面连接（非倒计时）'
 return result

def compact_job(job):
 """Return only the fields required before a queue row is expanded."""
 keys=(
  'id','task_no','title','status','batch_phase','assigned_browser','assigned_worker',
  'eligible_browsers','created','queued_at','started_at','claimed_at','send_started_at','sent_at',
  'completed_at','failed_at','paused_at','last_progress_at','batch_no',
  'reference','reference_images','template_archive','result_folder',
  'expected_count','progress','error','prompt_template','chat_url',
  'response_last_progress_at','response_refresh_count',
  'response_refresh_requested_at','failure_reason','workflow_mode','workflow_id',
  'workflow_label','workflow_input_mode','current_step','step_delay_seconds','next_step_at',
  'source_relative_path','source_product_folder','source_name','source_sha256',
  'repair_source_id','repair_source_title','repair_step_keys',
  'retry_source_id','retry_source_title','retry_step_keys','retry_mode'
 )
 result={key:job[key] for key in keys if key in job}
 result['step_count']=len(job.get('steps') or [])
 result['fixed_image_count']=len(job.get('fixed_images') or [])
 result['has_sending_event']=any(entry.get('event')=='sending' for entry in job.get('logs') or [])
 result['step_progress']=[{k:s.get(k) for k in ('number','key','label','phase','status','output','send_started_at','sent_at','saved_at','retained_from_job')} for s in job.get('steps',[])]
 return result

def output_image(data,ident,number,thumbnail=False):
 """Read a registered result by job/step, never accept arbitrary file paths."""
 import gpt_extension_bridge as bridge
 from PIL import Image,ImageOps
 from io import BytesIO
 job=get_job(data,ident)
 step=next((s for s in job.get('steps',[]) if s.get('number')==number),None)
 if not step or not bridge._saved(step):raise ValueError('成图不存在、已搬迁或校验失败')
 path=Path(step['output'])
 if path.suffix.lower() not in IMAGE_EXT:raise ValueError('成图格式不支持')
 raw=path.read_bytes()
 if hashlib.sha256(raw).hexdigest()!=step['sha256']:raise ValueError('成图在读取期间发生变化')
 if thumbnail:
  with Image.open(BytesIO(raw)) as source:
   image=ImageOps.exif_transpose(source);image.thumbnail((320,320))
   buffer=BytesIO();image.convert('RGB').save(buffer,format='JPEG',quality=82)
  return buffer.getvalue(),'image/jpeg'
 return raw,{'.png':'image/png','.webp':'image/webp'}.get(path.suffix.lower(),'image/jpeg')

def list_job_summaries(data,jobs=None):
 jobs=jobs if jobs is not None else list_jobs(data)
 return [compact_job(job) for job in jobs]

def get_job(data,ident):
 if not isinstance(ident,str) or not re.fullmatch(r'[a-f0-9]{32}',ident):raise ValueError('任务编号无效')
 path=Path(data)/'image-jobs'/ident/'job.json'
 try:return json.loads(path.read_text(encoding='utf-8'))
 except FileNotFoundError:raise ValueError('任务不存在') from None
 except (OSError,ValueError):raise ValueError('任务记录无法读取') from None

def summary(data,jobs=None):
 jobs=jobs if jobs is not None else list_jobs(data)
 local_today=datetime.now(timezone(timedelta(hours=8))).date()
 sent_jobs=[job for job in jobs if job.get('sent_at') or any(entry.get('event')=='sent' for entry in job.get('logs',[]))]
 sent_today=0
 for job in sent_jobs:
  sent_at=job.get('sent_at') or next((entry.get('at') for entry in job.get('logs',[]) if entry.get('event')=='sent'),None)
  try:
   if datetime.fromisoformat(sent_at.replace('Z','+00:00')).astimezone(timezone(timedelta(hours=8))).date()==local_today:sent_today+=1
  except (AttributeError,ValueError):pass
 phases={}
 for job in jobs:phases[job.get('batch_phase','unknown')]=phases.get(job.get('batch_phase','unknown'),0)+1
 total_images=sum(len(job.get('steps',[])) for job in jobs)
 saved_images=sum(sum(1 for step in job.get('steps',[]) if step.get('phase')=='saved') for job in jobs)
 failed_steps=sum(1 for job in jobs for step in job.get('steps',[]) if step.get('phase') in ('failed','error'))
 invalid_downloads=sum(1 for job in jobs for entry in job.get('logs',[]) if entry.get('event') in ('invalid_download','repair_quarantine'))
 recent_failures=[]
 for job in jobs:
  last=next((entry for entry in reversed(job.get('logs',[])) if entry.get('event') in ('error','invalid_download','repair_quarantine')),None)
  if job.get('batch_phase')=='failed' or job.get('error') or last:
   recent_failures.append({'task_no':job.get('task_no'),'phase':job.get('batch_phase'),'browser':job.get('assigned_browser'),'at':last.get('at') if last else job.get('failed_at'),'message':(last or {}).get('message') or job.get('error','')})
 recent_failures.sort(key=lambda row:row.get('at') or '',reverse=True)
 return {'total_jobs':len(jobs),'sent_jobs':len(sent_jobs),'sent_today':sent_today,'total_images':total_images,'saved_jobs':phases.get('saved',0),'saved_images':saved_images,'expected_images':total_images,'queued':phases.get('queued',0),'active':sum(phases.get(k,0) for k in ('claimed','sending','sent','waiting','downloading')),'failed':phases.get('failed',0),'needs_review':phases.get('needs_review',0),'paused':phases.get('paused',0),'failed_steps':failed_steps,'invalid_downloads':invalid_downloads,'phases':phases,'last_activity':max((job.get('last_progress_at') or job.get('created') or '' for job in jobs),default=None),'recent_failures':recent_failures[:20]}


BATCH_LOCK=threading.RLock()
def reset_all(data):
 import gpt_extension_bridge
 with BATCH_LOCK,gpt_extension_bridge.LOCK:
  root=(Path(data)/'image-jobs').resolve();archive_root=(Path(data)/'image-jobs-archive').resolve()
  data_root=Path(data).resolve()
  if root.parent!=data_root or archive_root.parent!=data_root:raise ValueError('任务目录超出允许范围')
  root.mkdir(parents=True,exist_ok=True);archive_root.mkdir(parents=True,exist_ok=True)
  jobs=[]
  for path in root.glob('*/job.json'):
   try:jobs.append(json.loads(path.read_text(encoding='utf-8')))
   except (OSError,ValueError):raise ValueError('存在无法读取的任务记录，已取消重置')
  if any(job.get('batch_phase')=='sending' for job in jobs):raise ValueError('有任务正在确认发送结果，请稍后重置')
  if not jobs:return {'ok':True,'cleared':0,'message':'任务列表已经是空的'}
  target=archive_root/('queue-reset-'+datetime.now().strftime('%Y%m%d-%H%M%S')+'-'+uuid.uuid4().hex[:6])
  if target.resolve().parent!=archive_root:raise ValueError('归档目标超出允许范围')
  os.replace(root,target);root.mkdir()
  manifest={'archived_at':datetime.now(timezone.utc).isoformat(),'job_count':len(jobs),'saved_jobs':sum(j.get('batch_phase')=='saved' for j in jobs),'result_folders':[j.get('result_folder') for j in jobs if j.get('result_folder')]}
  (target/'archive-manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf-8')
  return {'ok':True,'cleared':len(jobs),'archive':str(target),'message':f'已重置 {len(jobs)} 个任务；生成图片仍在原目录'}

def clear_records(data,idents=None):
 with BATCH_LOCK:
  selected=None
  if idents is not None:
   if not isinstance(idents,list) or not idents:raise ValueError('请至少选择一个任务')
   if len(idents)>500:raise ValueError('单次最多操作 500 个任务')
   selected=set(str(ident) for ident in idents)
   if any(not re.fullmatch(r'[a-f0-9]{32}',ident) for ident in selected):raise ValueError('任务编号无效')
  root=(Path(data)/'image-jobs').resolve();archive_root=(Path(data)/'image-jobs-archive').resolve()
  cleared=[];kept=0;stamp=datetime.now().strftime('%Y%m%d-%H%M%S')
  for path in root.glob('*/job.json'):
   try:job=json.loads(path.read_text(encoding='utf-8'))
   except (OSError,ValueError):kept+=1;continue
   if selected is not None and job.get('id') not in selected:kept+=1;continue
   phase=job.get('batch_phase')
   finished=phase in ('saved','failed') or bool(job.get('completed_at') and not job.get('runner'))
   if not finished:kept+=1;continue
   folder=path.parent.resolve()
   if folder.parent!=root:raise ValueError('任务记录路径超出允许范围')
   archive_root.mkdir(parents=True,exist_ok=True)
   target=archive_root/(stamp+'-'+folder.name)
   if target.exists():target=archive_root/(stamp+'-'+folder.name+'-'+uuid.uuid4().hex[:6])
   shutil.move(str(folder),str(target));cleared.append(job.get('task_no') or job.get('id') or folder.name)
  return {'ok':True,'cleared':len(cleared),'kept':kept,'message':f'已清除 {len(cleared)} 条已结束记录；运行中、排队中和暂停任务均已保留','archive':str(archive_root) if cleared else ''}

def delete_selected(data,idents):
 """Remove selected non-active jobs from the visible queue, keeping a local archive."""
 import gpt_extension_bridge
 ids=gpt_extension_bridge.normalize_job_ids(idents)
 data_root=Path(data).resolve();root=(data_root/'image-jobs').resolve();archive_root=(data_root/'image-jobs-archive').resolve()
 if root.parent!=data_root or archive_root.parent!=data_root:raise ValueError('任务目录超出允许范围')
 deleted=[];protected=[];missing=[];stamp=datetime.now().strftime('%Y%m%d-%H%M%S')
 # Keep lock order consistent with prepare_batch: batch lock, then bridge lock.
 with BATCH_LOCK,gpt_extension_bridge.LOCK:
  for ident in ids:
   folder=(root/ident).resolve();path=folder/'job.json'
   if folder.parent!=root:raise ValueError('任务记录路径超出允许范围')
   if not path.is_file():missing.append(ident);continue
   try:job=json.loads(path.read_text(encoding='utf-8'))
   except (OSError,ValueError):protected.append(ident);continue
   phase=job.get('batch_phase')
   if phase in gpt_extension_bridge.ACTIVE_PHASES:
    protected.append(job.get('task_no') or ident);continue
   archive_root.mkdir(parents=True,exist_ok=True)
   target=archive_root/(f'deleted-{stamp}-{ident}')
   if target.exists():target=archive_root/(f'deleted-{stamp}-{ident}-{uuid.uuid4().hex[:6]}')
   shutil.move(str(folder),str(target));deleted.append(job.get('task_no') or ident)
 message=f'已从任务列表删除 {len(deleted)} 个选中任务'
 if protected:message+=f'；{len(protected)} 个正在执行或等待结果的任务已保护，请先暂停后再删除'
 if missing:message+=f'；{len(missing)} 个任务已不在列表中'
 return {'ok':True,'deleted':len(deleted),'protected':protected,'missing':missing,'archive':str(archive_root) if deleted else '','message':message}

def reassign_batch(body,data):
 import gpt_extension_bridge
 batch_no=str(body.get('batch_no',''))
 if not re.fullmatch(r'BATCH-\d{8}-\d{6}-[A-F0-9]{4}',batch_no):raise ValueError('批次编号无效')
 selected=gpt_extension_bridge.normalize_browsers(body.get('browsers'))
 reassigned=[];protected=[]
 with BATCH_LOCK:
  for job in list_jobs(data):
   if job.get('batch_no')!=batch_no:continue
   if job.get('batch_phase') not in ('queued','paused','failed',None):
    protected.append(job.get('task_no') or job['id']);continue
   try:
    gpt_extension_bridge.enqueue(data,job['id'],browsers=selected);reassigned.append(job.get('task_no') or job['id'])
   except ValueError:
    protected.append(job.get('task_no') or job['id'])
 return {'ok':True,'batch_no':batch_no,'reassigned':len(reassigned),'protected':len(protected),'message':f'已按当前选择重新分配 {len(reassigned)} 个未发送任务；{len(protected)} 个已发送或已完成任务保持原样'}

def scan_batch(body,data):
 raw=body.get('folders','')
 folders=raw.splitlines() if isinstance(raw,str) else raw
 if not isinstance(folders,list) or not folders:raise ValueError('请填写印花文件夹，每行一个路径')
 files={}
 for name in folders:
  if not str(name).strip():continue
  root=Path(str(name).strip().strip('"')).resolve()
  if not root.is_dir():raise ValueError('文件夹不存在：'+str(root))
  for p in (root.rglob('*') if body.get('recursive') else root.iterdir()):
   if p.is_file() and p.suffix.lower() in IMAGE_EXT:
    resolved=p.resolve()
    if not resolved.is_relative_to(root):continue
    files[str(resolved)]= {'path':str(resolved),'name':p.name,'size':p.stat().st_size}
    if len(files)>200:raise ValueError('单批最多 200 张印花，请分批指定文件夹')
 if not files:raise ValueError('文件夹中没有 PNG/JPG/WEBP 印花图')
 return {'files':sorted(files.values(),key=lambda f:f['path'].lower()),'count':len(files)}

def prepare_batch(body,data):
 if body.get('workflow_id') and body['workflow_id']!='legacy_zip':
  import image_workflows
  return image_workflows.prepare_batch(body,data)
 import hashlib,gpt_extension_bridge
 with BATCH_LOCK:
  selected=gpt_extension_bridge.normalize_browsers(body.get('browsers',list(gpt_extension_bridge.BROWSERS)))
  scanned=scan_batch(body,data)
  prompt=validate_prompt(body.get('prompt'))
  template=Path(str(body.get('template','')).strip().strip('"'))
  if not template.is_file() or template.suffix.lower()!='.zip':raise ValueError('请指定统一的模板 ZIP')
  fixed_paths=body.get('fixed_images',[])
  if not isinstance(fixed_paths,list) or len(fixed_paths)>20:raise ValueError('最多添加 20 张固定图')
  extra_paths=body.get('extra_references',[])
  if not isinstance(extra_paths,list) or len(extra_paths)>7:raise ValueError('额外参考图最多 7 张；加上主参考图共 8 张')
  for path in extra_paths:
   extra=Path(path)
   if not extra.is_file() or extra.suffix.lower() not in IMAGE_EXT:raise ValueError('额外参考图不存在或格式不支持：'+str(path))
   if extra.stat().st_size>30_000_000:raise ValueError('额外参考图超过 30MB：'+extra.name)
  fixed_hash=''.join(hashlib.sha256(Path(f).read_bytes()).hexdigest() for f in fixed_paths)
  extra_hash=''.join(hashlib.sha256(Path(f).read_bytes()).hexdigest() for f in extra_paths)
  template_hash=hashlib.sha256(template.read_bytes()).hexdigest()+fixed_hash+extra_hash
  existing={j.get('batch_key'):j for j in list_jobs(data) if j.get('batch_key')}
  batch_no='BATCH-'+datetime.now().strftime('%Y%m%d-%H%M%S')+'-'+uuid.uuid4().hex[:4].upper()
  settings=config(data);settings={k:v for k,v in settings.items() if k not in ('references','templates')}
  if body.get('output_folder'):settings['output_folder']=str(Path(body['output_folder']).resolve())
  settings['fixed_images']=fixed_paths
  settings['extra_references']=extra_paths
  settings.update(source_folder=str(body.get('folders','')).splitlines()[0].strip().strip(chr(34)),template_path=str(template),browsers=selected)
  (Path(data)/'image-config.json').write_text(json.dumps(settings,ensure_ascii=False,indent=2),encoding='utf-8')
  jobs=[];skipped=[];reassigned=[];errors=[]
  for sequence,item in enumerate(scanned['files'],1):
   try:
    reference=Path(item['path'])
    if item['size']>30_000_000:raise ValueError('参考图超过 30MB')
    key=hashlib.sha256((hashlib.sha256(reference.read_bytes()).hexdigest()+template_hash+prompt+str(body.get('category'))).encode()).hexdigest()
    if key in existing:
     duplicate=existing[key]
     if duplicate.get('batch_phase') in ('queued','paused','failed',None):
      gpt_extension_bridge.enqueue(data,duplicate['id'],browsers=selected);reassigned.append({'name':item['name'],'id':duplicate['id']})
     else:skipped.append({'name':item['name'],'id':duplicate['id']})
     continue
    job=prepare({**body,'title':datetime.now().strftime('%Y%m%d-%H%M%S')+f'-{sequence:03d}','reference':str(reference),'prompt':prompt},data)
    job.update(batch_no=batch_no,batch_key=key,source_reference=str(reference),queue_number=sequence,eligible_browsers=selected)
    (Path(job['folder'])/'job.json').write_text(json.dumps(job,ensure_ascii=False,indent=2),encoding='utf-8')
    gpt_extension_bridge.enqueue(data,job['id'])
    existing[key]=job;jobs.append({'id':job['id'],'title':job['title'],'task_no':job['task_no']})
   except (ValueError,OSError) as e:errors.append({'name':item['name'],'error':str(e)})
  return {'batch_no':batch_no,'jobs':jobs,'skipped':skipped,'reassigned':reassigned,'errors':errors}

