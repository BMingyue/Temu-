"""Durable image bridge shared by Chrome, Edge, and Firefox."""
import base64,hashlib,json,os,re,threading,time,uuid
from urllib.parse import urlparse,unquote
from pathlib import Path
from datetime import datetime,timezone

LOCK=threading.RLock()
STATE={'last_seen':None,'page':'','status':'未连接','message':'请安装并启用浏览器生图助手'}
EXTENSION_VERSION='0.4.8'
# 0.3.40 tightens generated-image detection and sends richer no-image
# diagnostics.  Older builds must not claim newly prepared tasks because they
# can count an assistant attachment card as a generated result.
COMPATIBLE_EXTENSION_VERSIONS=('0.3.40','0.4.0','0.4.1','0.4.2','0.4.3','0.4.4','0.4.5','0.4.6','0.4.7','0.4.8')
WORKFLOW_EXTENSION_VERSIONS=('0.4.0','0.4.1','0.4.2','0.4.3','0.4.4','0.4.5','0.4.6','0.4.7','0.4.8')
UNATTENDED_EXTENSION_VERSIONS=('0.4.6','0.4.7','0.4.8')
SOURCE_EDIT_EXTENSION_VERSIONS=('0.4.8',)
WORKERS={}
BROWSERS=('chrome','edge','firefox')
PREFERENCE_ORDER=('edge','chrome','firefox')
BROWSER_LABELS={'chrome':'Chrome','edge':'Edge','firefox':'Firefox'}
TASK_GAP_SECONDS=300
TAKEOVER_SECONDS=3*60
ONLINE_RESERVATION_SECONDS=60
# Background GPT tabs are commonly throttled to one timer tick per minute.
# Keep display/reconnect detection above that cadence; task takeover is the
# separate 15-minute threshold below and remains deliberately conservative.
WORKER_ONLINE_SECONDS=90
ACTIVE_PHASES=('claimed','sending','sent','waiting','downloading')
# Uploading multiple attachments and waiting for ChatGPT's send control can take over
# four minutes.  Do not recycle an owned pre-send task while that safe window is
# still open; the page performs its own bounded cleanup/retry first.
PRESEND_STALE_SECONDS=6*60
PRESEND_STALE_REQUEUE_LIMIT=1
SEND_STALE_SECONDS=10*60
RESPONSE_STALE_SECONDS=10*60
REFRESH_COMMAND_SECONDS=2*60
CIRCUIT_FAILURE_COUNT=3
CIRCUIT_COOLDOWN_SECONDS=30*60
def now():return datetime.now(timezone.utc).isoformat()
def _timestamp(value,default=0):
 try:return datetime.fromisoformat(str(value).replace('Z','+00:00')).timestamp()
 except (TypeError,ValueError):return default
def _worker_path(data):return Path(data)/'gpt-worker-state.json'
def _load_worker_state(data):
 if not data:return {'workers':{},'events':[]}
 try:
  value=json.loads(_worker_path(data).read_text(encoding='utf-8'))
  return value if isinstance(value,dict) else {'workers':{},'events':[]}
 except (OSError,ValueError):return {'workers':{},'events':[]}
def _save_worker_state(data,state):
 if not data:return
 p=_worker_path(data);p.parent.mkdir(parents=True,exist_ok=True);tmp=p.with_suffix('.'+uuid.uuid4().hex+'.tmp')
 tmp.write_text(json.dumps(state,ensure_ascii=False,indent=2),encoding='utf-8');_replace_with_retry(tmp,p)
def _worker_rows(data,mark_offline=False):
 state=_load_worker_state(data);records=dict(state.get('workers') or {});records.update(WORKERS)
 changed=False;current=time.time()
 if mark_offline:
  for key,row in records.items():
   online=current-float(row.get('_epoch',0) or 0)<WORKER_ONLINE_SECONDS
   if row.get('online',online) and not online:
    row={**row,'online':False,'offline_since':row.get('last_seen'),'offline_reason':'心跳中断：浏览器、GPT 页面或扩展已停止运行'};records[key]=row;changed=True
    # Persist the transition in the in-memory overlay too. Otherwise every
    # dashboard poll overlays the stale online value and writes another
    # identical offline event.
    if key in WORKERS:WORKERS[key]=row
    state.setdefault('events',[]).append({'at':now(),'event':'offline','browser':row.get('browser'),'worker_id':row.get('worker_id'),'last_seen':row.get('last_seen'),'reason':row['offline_reason']})
   elif online and not row.get('online',True):
    row={**row,'online':True,'offline_since':None,'offline_reason':''};records[key]=row;changed=True
    if key in WORKERS:WORKERS[key]=row
  if changed:
   state['workers']=records;state['events']=state.get('events',[])[-200:];_save_worker_state(data,state)
 return records,state
def _browser_last_seen(data,browser):
 rows,_=_worker_rows(data)
 return max((float(v.get('_epoch',0) or 0) for v in rows.values() if v.get('browser')==browser),default=0)
def _eligible_browsers(job):
 selected=job.get('eligible_browsers')
 if not isinstance(selected,list):return PREFERENCE_ORDER
 eligible=tuple(browser for browser in PREFERENCE_ORDER if browser in selected)
 return eligible or BROWSERS
def _preferred_browser(job):
 eligible=_eligible_browsers(job)
 value=job.get('preferred_browser')
 if value in eligible:return value
 try:number=int(job.get('queue_number'))
 except (TypeError,ValueError):number=int(job.get('id','0')[:8],16)
 return eligible[(number-1)%len(eligible)]
def _browser_label(browser):return BROWSER_LABELS.get(browser,str(browser).title())
def _worker_key(browser,worker=None):
 return browser+':'+worker if worker else browser
def _worker_label(browser,worker=None):
 return _browser_label(browser)+((' 配置 '+worker[:8]) if worker else ' 账号')
def _in_scope(job,browser=None,worker=None):
 """None aggregates a browser; an explicit worker isolates its profile.

 Legacy jobs without a worker retain the original browser-wide safety hold.
 """
 return (not browser or job.get('assigned_browser','chrome')==browser) and (worker is None or not job.get('assigned_worker') or job['assigned_worker']==worker)
def normalize_browsers(selected):
 if selected is None:return None
 if not isinstance(selected,list):raise ValueError('参与浏览器设置无效')
 result=[]
 for browser in selected:
  browser=str(browser)
  if browser not in BROWSERS:raise ValueError('参与浏览器设置包含不支持的浏览器')
  if browser not in result:result.append(browser)
 if not result:raise ValueError('请至少选择一个参与生图的浏览器')
 return result
def normalize_job_ids(values):
 if not isinstance(values,list) or not values:raise ValueError('请至少选择一个任务')
 if len(values)>500:raise ValueError('单次最多操作 500 个任务')
 result=[]
 for value in values:
  value=str(value)
  if not re.fullmatch(r'[a-f0-9]{32}',value):raise ValueError('任务编号无效')
  if value not in result:result.append(value)
 return result
def _task_gap_remaining(jobs,browser,worker=None):
 ended=[]
 for job in jobs or []:
  if not _in_scope(job,browser,worker):continue
  for key in ('completed_at','failed_at'):
   try:ended.append((_timestamp(job[key]),(job.get('failure_reason') in ('response_timeout','browser_unresponsive','send_timeout','send_error','task_stalled','presend_page_lost') or bool(job.get('chat_url'))) and key=='failed_at'))
   except (KeyError,TypeError):pass
 last_end,skip_gap=max(ended,default=(0,False))
 return 0 if skip_gap else max(0,int(last_end+TASK_GAP_SECONDS-time.time()+0.999))
def _takeover(job,data,browser,jobs=None,worker=None):
 if browser not in _eligible_browsers(job):return False,False,_preferred_browser(job),0,'not_eligible'
 # A stable chat and every already-started sequential workflow belong to the
 # exact original profile, including ready steps and manual recovery queues.
 if job.get('assigned_browser') in BROWSERS and (_stable_job_chat_url(job) or job.get('workflow_mode')=='single_image_chat_v1'):
  return _in_scope(job,browser,worker),False,job['assigned_browser'],0,'owned_chat'
 preferred=_preferred_browser(job)
 if browser==preferred:return True,False,preferred,0,'preferred'
 import gpt_unattended
 rows,_=_worker_rows(data)
 profiles=[row for row in rows.values() if row.get('browser')==preferred and time.time()-float(row.get('_epoch',0) or 0)<WORKER_ONLINE_SECONDS and row.get('status') not in ('等待登录','账号不匹配','需要更新','页面未识别')]
 if profiles and worker is not None:
  unavailable=[]
  for row in profiles:
   owner=row.get('worker_id','')
   if gpt_unattended.account(data,preferred,owner)['blocked']:reason='preferred_quota'
   elif jobs is not None and _generation_circuit(jobs,preferred,owner)['open']:reason='preferred_circuit'
   elif any(j.get('batch_phase') in ACTIVE_PHASES and _in_scope(j,preferred,owner) for j in jobs or []):reason='preferred_busy'
   elif _task_gap_remaining(jobs,preferred,owner):reason='preferred_cooling'
   else:reason=''
   unavailable.append(reason)
  # One free profile preserves the short browser-type reservation. A busy or
  # quota-held sibling must never make that healthy profile unavailable.
  if all(unavailable):return True,True,preferred,0,unavailable[0]
 else:
  if gpt_unattended.account(data,preferred)['blocked']:return True,True,preferred,0,'preferred_quota'
  if jobs is not None and _generation_circuit(jobs,preferred)['open']:return True,True,preferred,0,'preferred_circuit'
  if jobs is not None:
   preferred_active=any(item.get('runner')=='chrome_extension' and item.get('batch_phase') in ACTIVE_PHASES and item.get('assigned_browser')==preferred for item in jobs)
   if preferred_active:return True,True,preferred,0,'preferred_busy'
   if _task_gap_remaining(jobs,preferred):return True,True,preferred,0,'preferred_cooling'
 if job.get('recovered_presend'):return True,False,preferred,0,'safe_recovery'
 last_seen=_browser_last_seen(data,preferred)
 current=time.time()
 if last_seen and current-last_seen<WORKER_ONLINE_SECONDS:
  reserved_from=_timestamp(job.get('queued_at') or job.get('created'),current)
  remaining=max(0,int(reserved_from+ONLINE_RESERVATION_SECONDS-current+0.999))
  return remaining==0,remaining==0,preferred,remaining,'reservation_expired' if remaining==0 else 'reserved'
 offline_from=last_seen or _timestamp(job.get('queued_at'),time.time())
 remaining=max(0,int(offline_from+TAKEOVER_SECONDS-current+0.999))
 return remaining==0,remaining==0,preferred,remaining,'offline_timeout' if remaining==0 else 'offline_wait'
def _trace(job,event,message,**details):
 if not job.get('task_no'):
  stamp=str(job.get('created',now()))[:10].replace('-','');job['task_no']=f'IMG-{stamp}-{job["id"][:8].upper()}'
 entry={'at':now(),'event':event,'message':str(message)[:500]}
 job['last_progress_at']=entry['at']
 if event=='claimed':job.setdefault('started_at',entry['at'])
 if details:entry['details']=details
 job.setdefault('logs',[]).append(entry);job['logs']=job['logs'][-500:]
def _job_path(data,ident):
 if not isinstance(ident,str) or not re.fullmatch(r'[a-f0-9]{32}',ident):raise ValueError('任务编号无效')
 return Path(data)/'image-jobs'/ident/'job.json'
def _read(data,ident):
 try:return json.loads(_job_path(data,ident).read_text(encoding='utf-8'))
 except FileNotFoundError:raise ValueError('任务不存在，停止当前操作') from None
def _replace_with_retry(source,target):
 for attempt in range(8):
  try:os.replace(source,target);return
  except PermissionError:
   if attempt==7:raise
   time.sleep(.025*(attempt+1))

def _write(data,job):
 p=_job_path(data,job['id']);tmp=p.with_suffix('.'+uuid.uuid4().hex+'.tmp');tmp.write_text(json.dumps(job,ensure_ascii=False,indent=2),encoding='utf-8');_replace_with_retry(tmp,p)
def _image_ext(raw):
 if raw.startswith(b'\x89PNG\r\n\x1a\n'):return '.png'
 if raw.startswith(b'\xff\xd8\xff'):return '.jpg'
 if raw.startswith(b'RIFF') and raw[8:12]==b'WEBP':return '.webp'
 raise ValueError('下载文件不是有效 PNG/JPG/WEBP 图片')
def _saved(step):
 p=Path(step.get('output',''))
 return bool(step.get('sha256') and p.is_file() and hashlib.sha256(p.read_bytes()).hexdigest()==step['sha256'])
def append_fixed(job):
 for item in job.get('fixed_images',[]):
  source=Path(item['source']);raw=source.read_bytes()
  if hashlib.sha256(raw).hexdigest()!=item['sha256']:raise ValueError('固定图校验失败')
  target=Path(job['result_folder'])/(f"{item['number']:02d}-fixed"+source.suffix.lower())
  if target.exists() and hashlib.sha256(target.read_bytes()).hexdigest()!=item['sha256']:raise ValueError('固定图目标文件冲突，不覆盖现有图片')
  target.write_bytes(raw);item['output']=str(target)

def _attachment(path):
 p=Path(path);raw=p.read_bytes()
 if len(raw)>32_000_000:raise ValueError('单个附件超过 32MB')
 mime='application/zip' if p.suffix.lower()=='.zip' else {'.png':'image/png','.webp':'image/webp'}.get(p.suffix.lower(),'image/jpeg')
 return {'name':p.name,'base64':base64.b64encode(raw).decode('ascii'),'type':mime}

def _reference_paths(job):
 values=job.get('reference_images')
 if not isinstance(values,list) or not values:values=[job.get('reference')]
 result=[];seen=set()
 for value in values:
  text=str(value or '')
  if not text or text in seen:continue
  seen.add(text);result.append(text)
 return result

def _valid_chat_url(value):
 if not isinstance(value,str) or len(value)>1000:return False
 try:
  parsed=urlparse(value)
  path=unquote(parsed.path)
  return parsed.scheme=='https' and parsed.hostname=='chatgpt.com' and bool(re.fullmatch(r'/c/[A-Za-z0-9:._-]+/?',path))
 except ValueError:return False

def _stable_chat_url(value):
 if not _valid_chat_url(value):return False
 try:
  path=unquote(urlparse(value).path)
  return bool(re.fullmatch(r'/c/[A-Za-z0-9._-]+/?',path))
 except ValueError:return False

def _chat_url(job):
 value=job.get('chat_url')
 if _valid_chat_url(value):return value
 if job.get('execution_segment'):return ''
 for entry in reversed(job.get('logs') or []):
  if entry.get('event')!='sent':continue
  value=(entry.get('details') or {}).get('chat_url')
  if _valid_chat_url(value):return value
 return ''

def _stable_job_chat_url(job):
 value=job.get('chat_url')
 if _stable_chat_url(value):return value
 if job.get('execution_segment'):return ''
 for entry in reversed(job.get('logs') or []):
  value=(entry.get('details') or {}).get('chat_url')
  if _stable_chat_url(value):return value
 return ''

def _crossed_send_boundary(job):
 if job.get('workflow_mode')=='single_image_chat_v1' and job.get('execution_segment') and not job.get('chat_url'):
  import image_workflows
  return image_workflows.current(job)['phase']!='ready'
 if job.get('send_started_at') or job.get('sent_at') or _chat_url(job):return True
 unsafe={'sending','sent','send_pending','attachment_repair_sending'}
 return any(entry.get('event') in unsafe for entry in job.get('logs',[]))

def _isolate_uncertain_send(data,job):
 message='任务已有发送证据但没有稳定原对话地址，已隔离待人工核对，禁止自动重新发送'
 job.update(batch_phase='needs_review',runner=None,status='需要处理',progress=message,error=message,claim_session='',paused_at=now())
 _trace(job,'uncertain_send_isolated',message);_write(data,job)

def _identity(body):
 browser=body.get('browser','chrome')
 if browser not in BROWSERS:raise ValueError('不支持的浏览器')
 worker=str(body.get('worker_id',''))[:100]
 return browser,worker

def _owns(job,browser,worker):
 return job.get('assigned_browser','chrome')==browser and (not job.get('assigned_worker') or job['assigned_worker']==worker)

def snapshot(data=None):
 with LOCK:result=dict(STATE)
 if result['last_seen'] and time.time()-result.get('_epoch',0)>WORKER_ONLINE_SECONDS:result.update(status='未连接',message='浏览器生图助手没有心跳，请打开一个 GPT 页面')
 result.pop('_epoch',None)
 with LOCK:
  rows,_=_worker_rows(data,mark_offline=True)
  result['workers']=[{**v,'online':time.time()-float(v.get('_epoch',0) or 0)<WORKER_ONLINE_SECONDS} for v in rows.values()]
  live_rows=[v for v in result['workers'] if v['online']]
  if live_rows:
   latest=max(live_rows,key=lambda v:float(v.get('_epoch',0) or 0))
   latest_status=latest.get('status') or '已连接'
   result.update(status=latest_status,message=latest.get('message','浏览器生图助手已连接'),last_seen=latest.get('last_seen'))
 if data:
  jobs=[]
  metrics={browser:{'reserved':0,'claimed':0,'completed':0,'fallback':0} for browser in BROWSERS}
  _,worker_state=_worker_rows(data)
  result['worker_events']=worker_state.get('events',[])[-20:]
  today=datetime.now().astimezone().date()
  for p in (Path(data)/'image-jobs').glob('*/job.json'):
   try:j=json.loads(p.read_text(encoding='utf-8'))
   except (OSError,ValueError):continue
   jobs.append(j)
   if datetime.fromtimestamp(_timestamp(j.get('created')),timezone.utc).astimezone().date()!=today:continue
   preferred=j.get('preferred_browser')
   if preferred in metrics:metrics[preferred]['reserved']+=1
   assigned=j.get('assigned_browser')
   if assigned in metrics:
    metrics[assigned]['claimed']+=1
    if j.get('completed_at'):metrics[assigned]['completed']+=1
    if j.get('fallback_from'):metrics[assigned]['fallback']+=1
  result['metrics']=metrics
 result['scheduler']={'mode':'work_conserving_round_robin','browsers':list(BROWSERS),'online_reservation_seconds':ONLINE_RESERVATION_SECONDS,'offline_takeover_minutes':TAKEOVER_SECONDS//60,'task_gap_minutes':TASK_GAP_SECONDS//60,'circuit_scope':'per_browser'}
 if data:
  import gpt_unattended
  result['accounts']={browser:gpt_unattended.account(data,browser) for browser in BROWSERS}
  for row in result.get('workers',[]):
   browser,worker=row['browser'],row.get('worker_id','')
   row.update(channel_id=_worker_key(browser,worker),profile_label=_worker_label(browser,worker),account=gpt_unattended.account(data,browser,worker),circuit=_generation_circuit(jobs,browser,worker),gap_seconds=_task_gap_remaining(jobs,browser,worker))
   owned=[job for job in jobs if job.get('assigned_worker')==worker and job.get('assigned_browser')==browser and datetime.fromtimestamp(_timestamp(job.get('created')),timezone.utc).astimezone().date()==today]
   row['metrics']={'claimed':len(owned),'completed':sum(bool(job.get('completed_at')) for job in owned),'fallback':sum(bool(job.get('fallback_from')) for job in owned)}
 result['scheduler'].update(quota_handoff=True,task_isolation=True,task_max_wait_minutes=20,circuit_scope='per_worker',quota_scope='per_worker',cooldown_scope='per_worker',max_active_per_profile=1,profile_pool=True)
 result['mode']='动态轮流：任务先为轮到的浏览器保留 60 秒；该浏览器忙碌、冷却或未及时领取时，其他空闲浏览器立即接手；离线 3 分钟后接管；无图熔断按浏览器分别计算'
 result['mode']='多配置接力：同一种浏览器的独立配置可同时执行，每个配置分别冷却、额度停发与故障熔断；原聊天绑定原配置，发送结果不明时不自动重发'
 return result
def heartbeat(body,data=None):
 browser,worker=_identity(body)
 version=str(body.get('version',''))
 status=str(body.get('status','已连接'))[:40];message=str(body.get('message','浏览器生图助手已连接'))[:300]
 if version not in COMPATIBLE_EXTENSION_VERSIONS:status='需要更新';message=f'请在扩展程序页面重新加载 GPT 生图助手 {EXTENSION_VERSION}'
 active_job=None
 if data:
  with LOCK:
   for p in (Path(data)/'image-jobs').glob('*/job.json'):
    try:j=json.loads(p.read_text(encoding='utf-8'))
    except (OSError,ValueError):continue
    if not _owns(j,browser,worker) or j.get('batch_phase') not in ACTIVE_PHASES:continue
    active_job=j
    if body.get('session') and j.get('claim_session')==body['session']:
     j['owner_seen']=time.time();_write(data,j)
    break
 with LOCK:
  STATE.update(last_seen=now(),_epoch=time.time(),page=str(body.get('page',''))[:500],version=version,status=status,message=message)
  key=browser+':'+worker;persisted=_load_worker_state(data);old=(persisted.get('workers') or {}).get(key,{})
  row={**old,**STATE,'browser':browser,'worker_id':worker,'label':_browser_label(browser)+' 账号','online':True,'offline_since':None,'offline_reason':''}
  if active_job and body.get('session')!=active_job.get('claim_session'):
   # An idle/home/library tab from the same browser must not overwrite the
   # active task tab's page and status. It still refreshes browser-level
   # connectivity, while only the owner session refreshes ``owner_seen``.
   row.update(page=old.get('page',row['page']),status=old.get('status','执行中'),message=old.get('message','另一个标签正在执行生图任务'),auxiliary_page=str(body.get('page',''))[:500],active_task_no=active_job.get('task_no',''))
  else:
   row.pop('auxiliary_page',None);row['active_task_no']=active_job.get('task_no','') if active_job else ''
  if not old:row['first_seen']=STATE['last_seen'];persisted.setdefault('events',[]).append({'at':STATE['last_seen'],'event':'connected','browser':browser,'worker_id':worker})
  elif time.time()-float(old.get('_epoch',0) or 0)>=WORKER_ONLINE_SECONDS:
   row['last_reconnected_at']=STATE['last_seen'];row['last_offline_seconds']=int(time.time()-float(old.get('_epoch',time.time()) or time.time()))
   persisted.setdefault('events',[]).append({'at':STATE['last_seen'],'event':'reconnected','browser':browser,'worker_id':worker,'offline_seconds':row['last_offline_seconds']})
  WORKERS[key]=row
  if data:
   persisted.setdefault('workers',{})[key]=row;persisted['events']=persisted.get('events',[])[-200:];_save_worker_state(data,persisted)
 return {'ok':True}

def pause(data,ident):
 with LOCK:
  job=_read(data,ident)
  phase=job.get('batch_phase')
  if phase in ('paused','needs_review'):return {'ok':True,'message':'任务已经暂停'}
  if phase=='sending':raise ValueError('正在确认发送结果，暂时不能暂停；请稍后再试')
  if phase in ('queued','claimed') and not job.get('chat_url'):
   previous=job.pop('assigned_browser',None);job.pop('assigned_worker',None)
   job.update(batch_phase='paused',runner=None,status='已暂停，尚未发送',claim_session='',paused_at=now())
   _trace(job,'paused','任务在发送前暂停，未向 GPT 发送内容',previous_browser=previous or 'unassigned')
   message='任务已暂停，尚未发送；点击继续可重新排队'
  elif phase in ('sent','waiting','downloading') or job.get('chat_url'):
   job.update(batch_phase='needs_review',runner=None,status='已暂停，保留原对话与图片',claim_session='',paused_at=now())
   _trace(job,'parked','保留原对话与已下载图片，暂停收图并释放账号')
   message='任务已暂停并保留原对话；点击继续可恢复收图'
  else:raise ValueError('当前任务状态不需要暂停')
  _write(data,job)
 return {'ok':True,'message':message}

def park(data,ident):return pause(data,ident)

def unattended_action(data,body):
 import gpt_unattended
 with LOCK:
  if body.get('action')=='recover-skipped':
   return gpt_unattended.recover_selected(data,body.get('ids'),body.get('browsers'))
  if body.get('action')=='account-quota':
   browser=body.get('browser')
   if body.get('job_id'):
    job=_read(data,body['job_id'])
    import image_workflows
    if not image_workflows.is_workflow(job) or job.get('assigned_browser')!=browser:raise ValueError('账号与逐张任务不匹配')
    step=image_workflows.current(job)
    if body.get('step')!=step['number'] or body.get('step_token')!=step['step_token']:raise ValueError('步骤已变化，请重新核对')
    return gpt_unattended.quota_event(data,job,body)
   return {'ok':True,'account':gpt_unattended.block_account(data,browser,body.get('quota_text'),body.get('worker_id'))}
  raise ValueError('未知的无人值守操作')

def pause_many(data,idents):
 ids=normalize_job_ids(idents);paused=[];protected=[]
 with LOCK:
  for ident in ids:
   try:pause(data,ident);paused.append(ident)
   except (ValueError,OSError):protected.append(ident)
 return {'ok':True,'paused':len(paused),'protected':len(protected),'message':f'已暂停 {len(paused)} 个任务；{len(protected)} 个已结束或处于发送临界状态的任务保持原样'}

def reassign_many(data,idents,browsers):
 ids=normalize_job_ids(idents);selected=normalize_browsers(browsers);reassigned=[];protected=[]
 with LOCK:
  for ident in ids:
   try:
    job=_read(data,ident)
    if job.get('batch_phase') not in ('queued','paused','failed',None):protected.append(ident);continue
    enqueue(data,ident,browsers=selected);reassigned.append(ident)
   except (ValueError,OSError):protected.append(ident)
 return {'ok':True,'reassigned':len(reassigned),'protected':len(protected),'message':f'已按当前浏览器选择重新分配 {len(reassigned)} 个任务；{len(protected)} 个已发送或已完成任务保持原样'}

def enqueue(data,ident,single=False,browsers=None,collect_only=False):
 with LOCK:
  job=_read(data,ident)
  if collect_only:
   import image_workflows
   if not image_workflows.is_workflow(job) or not _stable_job_chat_url(job) or image_workflows.current(job).get('phase')!='sent':
    raise ValueError('仅续收必须是已确认发送并有原聊天的逐张步骤')
  job['recovery_collect_only']=bool(collect_only)
  if not _stable_job_chat_url(job) and _crossed_send_boundary(job):raise ValueError('发送结果不确定，不能一键重试；请先核对 GPT 对话')
  total=len(job['steps'])
  if all(_saved(s) for s in job['steps']):raise ValueError(f'{total} 张图片均已保存')
  phase=job.get('batch_phase')
  resuming_review=phase=='needs_review' and bool(_stable_job_chat_url(job))
  selected=normalize_browsers(browsers)
  job.setdefault('handoff_browsers',list(_eligible_browsers(job)))
  original_browser=job.get('assigned_browser') if (_stable_job_chat_url(job) or job.get('workflow_mode')=='single_image_chat_v1') else None
  if job.get('workflow_mode')=='single_image_chat_v1' and original_browser and selected is not None and original_browser not in selected:
   raise ValueError('已开始的逐张套图必须由原浏览器继续，不能改派其他账号')
  if _stable_job_chat_url(job) and original_browser not in BROWSERS:raise ValueError('已发送任务缺少原浏览器账号，不能自动重试')
  if selected is not None and phase in ('queued','paused','failed','needs_review',None):
   if original_browser and original_browser not in selected:
    raise ValueError('已发送任务必须由原浏览器账号续接，不能改派其他账号')
   if not original_browser:
    job['eligible_browsers']=selected;job.pop('preferred_browser',None);job.pop('assigned_browser',None);job.pop('assigned_worker',None)
  if original_browser:
   job['eligible_browsers']=[original_browser];job['preferred_browser']=original_browser
  if resuming_review:
   phase='queued';job['batch_phase']='queued';job['resume_existing_chat']=True
  if phase in ACTIVE_PHASES and job.get('runner')=='chrome_extension':return {'ok':True,'message':'任务已在执行，保持原有独占会话'}
  if phase in ('claimed','sending') and not _stable_job_chat_url(job):raise ValueError('发送结果不确定，请先核对 GPT 页面')
  references=_reference_paths(job)
  import image_workflows
  if image_workflows.is_workflow(job):
   image_workflows.current(job).pop('ready_started_at',None)
   if not references or any(not Path(value).is_file() for value in references) or any(not Path(s.get('template','')).is_file() for s in job['steps']):raise ValueError('逐张任务参考图或模板缺失')
  elif not references or any(not Path(value).is_file() for value in references) or not Path(job.get('template_archive','')).is_file():raise ValueError('任务参考图或模板附件缺失，请重新准备任务')
  if phase in ('sent','waiting','downloading') or _stable_job_chat_url(job):job.update(retry_count=0,retry_after=0)
  if phase in ('failed','needs_review','paused'):job.update(presend_retry_count=0,retry_after=0)
  if phase=='failed' or resuming_review:
   job.pop('failed_at',None);job.pop('failure_reason',None)
   job.pop('response_refresh_requested_at',None)
   if _stable_job_chat_url(job):job.update(response_refresh_count=0,response_last_progress_at=now(),observed_image_count=0)
  job.update(status='等待浏览器执行',runner='chrome_extension',error='',queued_at=now(),claim_session='')
  job['preferred_browser']=_preferred_browser(job)
  if phase not in ('sent','waiting','downloading'):job['batch_phase']='queued'
  _trace(job,'queued','任务加入浏览器队列，参与账号：'+'、'.join(_browser_label(v) for v in _eligible_browsers(job))+'；优先分配给 '+_browser_label(job['preferred_browser']),preferred_browser=job['preferred_browser'],eligible_browsers=list(_eligible_browsers(job)))
  _write(data,job)
 return {'ok':True,'message':'任务已按 '+'、'.join(_browser_label(v) for v in _eligible_browsers(job))+' 重新排队'}

def retry_failed(data,idents=None):
 with LOCK:
  selected=set(normalize_job_ids(idents)) if idents is not None else None
  jobs=[]
  for path in (Path(data)/'image-jobs').glob('*/job.json'):
   try:jobs.append(json.loads(path.read_text(encoding='utf-8')))
   except (OSError,ValueError):continue
  failed=[job for job in jobs if job.get('batch_phase')=='failed' and (selected is None or job.get('id') in selected)]
  retried=[];skipped=[]
  for job in failed:
   try:enqueue(data,job['id']);retried.append(job['id'])
   except ValueError as error:skipped.append({'id':job['id'],'reason':str(error)})
  return {'ok':True,'retried':len(retried),'skipped':skipped,'message':f'已重试 {len(retried)} 个失败任务'+(f'；{len(skipped)} 个发送状态不明确，需核对原对话' if skipped else '')}

def _payload(job):
 import image_workflows
 if image_workflows.is_workflow(job):return image_workflows.payload(job)
 phase=job.get('batch_phase','queued')
 references=[_attachment(value) for value in _reference_paths(job)]
 stable_url=_stable_job_chat_url(job)
 return {'task':{'job_id':job['id'],'prompt':job['prompt_template'],'expected_count':len(job['steps']),'reference':references[0],'reference_images':references,'template_archive':_attachment(job['template_archive']),'resume':bool(stable_url) or phase in ('sending','sent','waiting','downloading'),'chat_url':stable_url,'awaiting_chat_confirmation':phase in ('sending','sent') and not bool(stable_url),'saved':[s['number'] for s in job['steps'] if _saved(s)],'attachment_repair_count':int(job.get('attachment_repair_count',0) or 0),'attachment_repair_state':job.get('attachment_repair_state',''),'response_refresh_count':int(job.get('response_refresh_count',0) or 0),'response_last_progress_at':job.get('response_last_progress_at') or job.get('sent_at'),'observed_image_count':int(job.get('observed_image_count',0) or 0)}}

def _input_hashes(job):
 hashes=set()
 for value in [*_reference_paths(job),job.get('template_archive')]:
  try:
   p=Path(str(value))
   if p.is_file():hashes.add(hashlib.sha256(p.read_bytes()).hexdigest())
  except (OSError,TypeError):pass
 for step in job.get('steps',[]):
  try:
   p=Path(str(step.get('template','')))
   if p.is_file():hashes.add(hashlib.sha256(p.read_bytes()).hexdigest())
  except (OSError,TypeError):pass
 for item in job.get('fixed_images',[]):
  try:
   p=Path(str(item.get('source','')))
   if p.is_file():hashes.add(hashlib.sha256(p.read_bytes()).hexdigest())
  except (OSError,TypeError):pass
 return hashes
def _recover_stale_presend(jobs,data):
 # A claimed task has not reached the send boundary. If its page disappears,
 # invalidating the old session and queuing it again cannot duplicate a send.
 # The later "sending" phase is deliberately never recovered this way because
 # the click result may be uncertain and must be checked instead.
 current=time.time()
 for job in jobs:
  if job.get('runner')!='chrome_extension' or job.get('batch_phase')!='claimed' or job.get('chat_url'):continue
  try:stale=current-float(job.get('owner_seen',current))>PRESEND_STALE_SECONDS
  except (TypeError,ValueError):stale=False
  if not stale:continue
  if job.get('workflow_mode')=='single_image_chat_v1':
   message='逐张任务发送前执行页失联，已保留原浏览器、草稿和步骤，等待原页面核对后续接'
   job.update(batch_phase='needs_review',runner=None,status='待核对，已保留步骤',error=message,paused_at=now(),failed_at=now(),failure_reason='presend_page_lost',claim_session='')
   _trace(job,'error',message);_write(data,job);continue
  logs=job.get('logs',[])
  last_claim=max((index for index,entry in enumerate(logs) if entry.get('event')=='claimed'),default=-1)
  current_attempt=logs[last_claim+1:] if last_claim>=0 else logs
  prompt_entered=any(entry.get('event')=='progress' and '提示词已填写' in str(entry.get('message','')) for entry in current_attempt)
  if prompt_entered:
   message='提示词已填写后执行页面失联；附件与发送状态需人工核对，禁止自动重新排队'
   job.update(batch_phase='failed',runner=None,status='需要处理',error=message,failed_at=now(),failure_reason='presend_page_lost',claim_session='')
   _trace(job,'error',message);_write(data,job);continue
  count=int(job.get('presend_stale_requeue_count',0) or 0)+1
  if count>PRESEND_STALE_REQUEUE_LIMIT:
   message=f'发送前执行页面连续 {count} 次失联，已停止自动重新排队；请检查浏览器和 GPT 页面'
   job.update(batch_phase='failed',runner=None,status='需要处理',error=message,failed_at=now(),failure_reason='presend_page_lost',claim_session='',presend_stale_requeue_count=count)
   _trace(job,'presend_page_lost',message,previous_browser=job.get('assigned_browser') or 'unknown')
   _write(data,job);continue
  old_browser=job.pop('assigned_browser',None);old_worker=job.pop('assigned_worker',None)
  job.update(batch_phase='queued',claim_session='',status=f'执行页面中断，仅自动重试 {count}/{PRESEND_STALE_REQUEUE_LIMIT}',queued_at=job.get('queued_at') or now(),recovered_presend=True,presend_stale_requeue_count=count)
  _trace(job,'auto_requeue',f'发送前执行页面失联，仅允许自动重新排队 {count}/{PRESEND_STALE_REQUEUE_LIMIT}',previous_browser=old_browser or 'unknown',previous_worker=old_worker or '')
  _write(data,job)

def _recover_stale_sending(jobs,data):
 # Once the send boundary is crossed without a valid conversation URL, do not
 # retry automatically. After ten quiet minutes, release the browser and mark
 # the task failed so the queue can continue; the original page remains intact
 # for manual inspection.
 current=time.time()
 for job in jobs:
  if job.get('batch_phase')!='sending' or _stable_job_chat_url(job):continue
  try:stale=current-(_timestamp(job.get('send_error_at')) or float(job.get('owner_seen',current)))>SEND_STALE_SECONDS
  except (TypeError,ValueError):stale=False
  if not stale:continue
  message='发送后十分钟仍未取得有效 GPT 对话地址，判定对话失败，已跳过并释放浏览器'
  job.update(batch_phase='failed',runner=None,status='失败',progress=message,error=message,failed_at=now(),failure_reason='send_timeout',claim_session='')
  _trace(job,'send_timeout',message)
  _write(data,job)

def _fail_response(job,data,message,reason='response_timeout'):
 job.update(batch_phase='failed',runner=None,status='失败',progress=message,error=message,failed_at=now(),failure_reason=reason,claim_session='')
 job.pop('response_refresh_requested_at',None)
 _trace(job,reason,message);_write(data,job)

def _recover_stale_responses(jobs,data):
 # Run without browser/page polling. Heartbeats and repeated "waiting" events
 # do not count as image progress and must never extend this deadline.
 current=time.time()
 for job in jobs:
  if job.get('runner')!='chrome_extension' or job.get('batch_phase') not in ('sent','waiting') or not _stable_job_chat_url(job):continue
  started=_timestamp(job.get('response_last_progress_at') or job.get('sent_at'))
  if not started or current-started<RESPONSE_STALE_SECONDS:continue
  if job.get('workflow_mode')=='single_image_chat_v1':
   # Its content runner has a progress-aware 20-minute cap. Never apply the
   # legacy ten-minute reload/retry rules to a multi-turn conversation.
   if current-started>=20*60:
    message='逐张任务本步骤长时间未完成，已保留原聊天与图片，等待核对，不自动刷新或重发'
    job.update(batch_phase='needs_review',runner=None,status='待核对，已保留步骤',error=message,paused_at=now(),claim_session='')
    _trace(job,'error',message);_write(data,job)
   continue
  if int(job.get('response_refresh_count',0) or 0)>0:
   _fail_response(job,data,'对话刷新后又等待十分钟仍无新图片，服务端已跳过并转入失败任务')
  elif job.get('response_refresh_requested_at'):
   if current-_timestamp(job['response_refresh_requested_at'],current)>=REFRESH_COMMAND_SECONDS:
    _fail_response(job,data,'十分钟无新图片后已请求刷新，但浏览器连续两分钟无法执行，已跳过并转入失败任务','browser_unresponsive')
  else:
   job['response_refresh_requested_at']=now()
   _trace(job,'response_refresh_requested','十分钟无新图片，工作台请求扩展后台刷新原对话')
   _write(data,job)

def _generation_circuit(jobs,browser=None,worker=None):
 """Pause only the failing profile; omit worker for browser aggregates."""
 terminal=[]
 for job in jobs:
  if _in_scope(job,browser,worker):
   if job.get('completed_at'):terminal.append((_timestamp(job['completed_at']),True,job))
   elif job.get('failed_at') and job.get('failure_reason') in ('response_timeout','generation_failed','presend_page_lost','workflow_page_not_ready','workflow_response_timeout'):
    terminal.append((_timestamp(job['failed_at']),False,job))
  for entry in job.get('logs') or []:
   if entry.get('event')!='auto_requeue':continue
   previous=(entry.get('details') or {}).get('previous_browser')
   if browser and previous!=browser:continue
   if worker is not None and (entry.get('details') or {}).get('previous_worker')!=worker:continue
   terminal.append((_timestamp(entry.get('at')),False,{'failure_reason':'presend_page_lost','failed_at':entry.get('at')}))
 terminal.sort(key=lambda item:item[0],reverse=True)
 failures=[]
 for ended,success,job in terminal:
  if success:break
  failures.append((ended,job))
 if len(failures)<CIRCUIT_FAILURE_COUNT:return {'open':False,'half_open':False,'consecutive':len(failures),'wait_seconds':0}
 remaining=max(0,int(failures[0][0]+CIRCUIT_COOLDOWN_SECONDS-time.time()+0.999))
 state={'open':remaining>0,'half_open':remaining<=0,'consecutive':len(failures),'wait_seconds':remaining,'last_failure_at':failures[0][1].get('failed_at')}
 active=next((job for job in jobs if job.get('runner')=='chrome_extension' and job.get('batch_phase') in ACTIVE_PHASES and _in_scope(job,browser,worker)),None)
 if remaining<=0 and active:
  state.update(open=True,half_open=True,probe_active=True,wait_seconds=5,probe_job_id=active.get('id'))
 return state

def maintenance(data):
 with LOCK:
  jobs=[]
  for path in (Path(data)/'image-jobs').glob('*/job.json'):
   try:jobs.append(json.loads(path.read_text(encoding='utf-8')))
   except (OSError,ValueError):continue
  import gpt_unattended
  gpt_unattended.maintenance(data,jobs)
  _recover_stale_presend(jobs,data)
  _recover_stale_sending(jobs,data)
  _recover_stale_responses(jobs,data)
  return jobs

def start_maintenance(data,stop=None,interval=5):
 stop=stop or threading.Event()
 def run():
  while not stop.is_set():
   try:maintenance(data)
   except Exception as error:
    # A malformed job or transient disk error must not kill the safety loop.
    try:
     with (Path(data)/'gpt-maintenance.log').open('a',encoding='utf-8') as log:log.write(now()+' '+str(error)+'\n')
    except OSError:pass
   stop.wait(interval)
 thread=threading.Thread(target=run,name='gpt-task-maintenance',daemon=True)
 thread.start();return stop,thread

def claim(data,body):
 browser,worker=_identity(body)
 version=str(body.get('version',''))
 session=str(body.get('session',''))[:100]
 if not session:raise ValueError('扩展会话无效')
 if version not in COMPATIBLE_EXTENSION_VERSIONS:raise ValueError(f'扩展版本过旧，请重新加载 {EXTENSION_VERSION}')
 with LOCK:
  jobs=[]
  for p in (Path(data)/'image-jobs').glob('*/job.json'):
   try:jobs.append(json.loads(p.read_text(encoding='utf-8')))
   except (OSError,ValueError):pass
  import gpt_unattended
  gpt_unattended.maintenance(data,jobs)
  _recover_stale_presend(jobs,data)
  _recover_stale_sending(jobs,data)
  _recover_stale_responses(jobs,data)
  for stalled in jobs:
   if stalled.get('runner') is None and stalled.get('batch_phase') in ('waiting','sent','downloading'):
    stalled.update(batch_phase='needs_review',status='待检查，可续传；队列已释放',paused_at=now(),claim_session='')
    _trace(stalled,'parked','收图重试已用尽，保留已下载图片与原对话，不再阻塞其他任务');_write(data,stalled)
  account=gpt_unattended.account(data,browser,worker)
  if account['blocked']:
   return {'task':None,'account_blocked':True,'wait_seconds':account['wait_seconds'],'message':account['message']}
  # Active work wins over queue order, including uncertain sends awaiting repair.
  active=sorted([j for j in jobs if j.get('batch_phase') in ACTIVE_PHASES and _in_scope(j,browser,worker)],key=lambda j:j.get('claimed_at',''))
  if active:
   job=active[0]
   if job.get('workflow_input_mode')=='single_source_edit' and version not in SOURCE_EDIT_EXTENSION_VERSIONS:return {'task':None,'message':'一对一原图修复需要生图助手0.4.8，请重新打开专用Chrome'}
   if job.get('workflow_mode')=='single_image_chat_v1' and version not in WORKFLOW_EXTENSION_VERSIONS:return {'task':None,'message':'逐张聊天预设需要 0.4.0 或更新的生图助手，请重新加载扩展'}
   if len(_reference_paths(job))>1 and version not in COMPATIBLE_EXTENSION_VERSIONS:return {'task':None,'message':'多参考图任务需要最新版生图助手，请重新加载扩展并刷新 GPT 页面'}
   if not _owns(job,browser,worker):return {'task':None,'message':'该账号已有其他浏览器配置在执行，请使用原配置恢复'}
   if _stable_job_chat_url(job) and job.get('runner')=='chrome_extension' and time.time()-job.get('owner_seen',time.time())>120:
    job['claim_session']='';_trace(job,'auto_reconnect','执行页面失联，自动续接原对话收图')
   if time.time()<job.get('retry_after',0):return {'task':None,'message':'收图失败后自动等待重试'}
   if job.get('runner')!='chrome_extension' or (job.get('claim_session') and job['claim_session']!=session):return {'task':None,'message':'已有任务执行中或需要处理，队列等待'}
   if not job.get('claim_session'):
    job.update(assigned_browser=browser,assigned_worker=worker,claim_session=session,claimed_at=now(),owner_seen=time.time());_trace(job,'resumed',_browser_label(browser)+' 已续接独占任务');_write(data,job)
   return _payload(job)
  remaining=_task_gap_remaining(jobs,browser,worker)
  if remaining:
   return {'task':None,'wait_seconds':remaining,'message':'任务间隔等待中'}
  circuit=_generation_circuit(jobs,browser,worker)
  if circuit['open']:
   if circuit.get('probe_active'):
    return {'task':None,'wait_seconds':5,'circuit_open':True,'probe_active':True,'message':'GPT 熔断后的单个探测任务正在执行；探测成功后队列才会继续'}
   minutes=max(1,(circuit['wait_seconds']+59)//60)
   return {'task':None,'wait_seconds':circuit['wait_seconds'],'circuit_open':True,'message':f'GPT 连续出现 {circuit["consecutive"]} 次无图或页面失联，队列已自动熔断；约 {minutes} 分钟后只放行一个探测任务'}
  # Alternate recovery and new submissions so a large repair backlog cannot
  # indefinitely starve tasks that have never crossed the send boundary.
  last_claimed=max((j for j in jobs if _in_scope(j,browser,worker) and j.get('claimed_at')),
                   key=lambda j:j.get('claimed_at',''),default=None)
  recover_first=not bool(last_claimed and last_claimed.get('claim_was_recovery'))
  multi_version_blocked=False
  source_edit_version_blocked=False
  queued_probe=next((j for j in jobs if j.get('runner')=='chrome_extension' and j.get('batch_phase')=='queued' and j.get('circuit_probe') and j.get('circuit_probe_browser')==browser and j.get('circuit_probe_worker',worker)==worker),None)
  for job in sorted(jobs,key=lambda j:(0 if bool(j.get('chat_url'))==recover_first else 1,j.get('queued_at',''))):
   if job.get('runner')!='chrome_extension' or job.get('batch_phase')!='queued':continue
   if job.get('workflow_input_mode')=='single_source_edit' and version not in SOURCE_EDIT_EXTENSION_VERSIONS:
    source_edit_version_blocked=True;continue
   if job.get('workflow_mode')=='single_image_chat_v1' and (Path(data)/'gpt-account-availability.json').exists() and version not in UNATTENDED_EXTENSION_VERSIONS:
    multi_version_blocked=True;continue
   if job.get('workflow_mode')=='single_image_chat_v1' and version not in WORKFLOW_EXTENSION_VERSIONS:continue
   if not _stable_job_chat_url(job) and _crossed_send_boundary(job):
    _isolate_uncertain_send(data,job);continue
   if circuit.get('half_open') and queued_probe and job.get('id')!=queued_probe.get('id'):continue
   if len(_reference_paths(job))>1 and version not in COMPATIBLE_EXTENSION_VERSIONS:multi_version_blocked=True;continue
   if time.time()<float(job.get('retry_after',0) or 0):continue
   allowed,fallback,preferred,takeover_wait,fallback_reason=_takeover(job,data,browser,jobs,worker)
   if not allowed:continue
   # Only isolate a manual or stale draft when this browser has an eligible
   # task ready to claim.  Returning ``draft_blocked`` while the queue is
   # empty (or only contains work for another browser) makes the extension
   # open a needless clean ChatGPT tab during ordinary conversations.
   # Already-owned active work was handled above and is deliberately allowed
   # through so its page can safely identify an extension-created draft.
   if body.get('draft_present'):
    owned_draft=False
    if job.get('workflow_mode')=='single_image_chat_v1' and job.get('assigned_browser')==browser and job.get('assigned_worker')==worker:
     import image_workflows
     step=image_workflows.current(job)
     marker,prompt=image_workflows.step_prompt(job,step)
     signature=hashlib.sha256(''.join(prompt.split()).encode('utf-8')).hexdigest()
     owned_draft=step['phase']=='ready' and body.get('draft_workflow_marker')==marker and body.get('draft_signature')==signature
    if not owned_draft:return {'task':None,'draft_blocked':True,'message':'当前页面有未发送草稿，暂不领取新任务'}
   phase=job.get('batch_phase','queued')
   if phase!='queued' and job.get('claim_session') and job.get('claim_session')!=session:return {'task':None}
   if phase=='queued':
    # A queued job with a saved ChatGPT URL is a collection recovery. Keep it
    # in the waiting phase as soon as ownership is assigned so the page may
    # report image progress immediately. Previously it briefly entered
    # ``claimed``; a fast content script could then be rejected with
    # "当前任务不在等待图片" before its subsequent waiting event arrived.
    recovering=bool(_chat_url(job))
    job.update(preferred_browser=preferred,assigned_browser=browser,assigned_worker=worker,batch_phase='waiting' if recovering else 'claimed',claim_session=session,claimed_at=now(),owner_seen=time.time(),status='执行中',claim_was_recovery=recovering)
    if job.get('workflow_mode')=='single_image_chat_v1':
     import image_workflows
     image_workflows.current(job).setdefault('ready_started_at',now())
    if recovering and job.get('workflow_mode')=='single_image_chat_v1':
     job['response_last_progress_at']=now()
     job['response_observation_started_at']=job['response_last_progress_at']
    if circuit.get('half_open'):job.update(circuit_probe=True,circuit_probe_browser=browser,circuit_probe_worker=worker)
    if fallback:
     reasons={'preferred_busy':'仍在执行','preferred_cooling':'处于任务间隔','preferred_quota':'额度耗尽','preferred_circuit':'账号熔断中','reservation_expired':'未在 60 秒保留期内领取','offline_timeout':'已离线 3 分钟','safe_recovery':'发送前页面失联并已安全释放'}
     reason_text=reasons.get(fallback_reason,'当前不可用')
     job.update(fallback_from=preferred,fallback_at=now(),fallback_reason=fallback_reason);_trace(job,'fallback_claim',_browser_label(preferred)+reason_text+'，'+_browser_label(browser)+' 自动接管',from_browser=preferred,to_browser=browser,reason=fallback_reason)
    job.pop('recovered_presend',None);_trace(job,'claimed',_worker_label(browser,worker)+' 已领取任务',browser=browser,worker_id=worker);_write(data,job)
   elif not job.get('claim_session'):job.update(assigned_browser=browser,assigned_worker=worker,claim_session=session,claimed_at=now(),owner_seen=time.time());_trace(job,'resumed',_browser_label(browser)+' 已续接任务');_write(data,job)
   return _payload(job)
  if source_edit_version_blocked:return {'task':None,'message':'一对一原图修复需要生图助手0.4.8，请重新打开专用Chrome'}
  if multi_version_blocked:return {'task':None,'message':'无人值守接力需要生图助手 '+EXTENSION_VERSION+'，请重新加载扩展并刷新 GPT 执行页'}
  return {'task':None}

def update(data,body):
 ident=body.get('job_id');event=body.get('event')
 with LOCK:
  job=_read(data,ident)
  total=len(job['steps'])
  reference_count=len(_reference_paths(job));attachment_count=reference_count+1
  if job.get('batch_phase')=='saved':return {'ok':True,'job_status':job['status'],'duplicate':True}
  if job.get('batch_phase') in ('paused','needs_review'):raise ValueError('任务已暂停，停止当前操作')
  if job.get('batch_phase')=='failed':raise ValueError('任务已失败，停止当前操作')
  browser,worker=_identity(body)
  if not _owns(job,browser,worker):raise ValueError('任务属于另一浏览器账号，禁止更新')
  if body.get('session') and job.get('claim_session') and body['session']!=job['claim_session']:raise ValueError('旧页面已失去任务所有权，停止操作')
  job['owner_seen']=time.time()
  if job.get('workflow_mode')=='single_image_chat_v1':
   if job.get('runner')!='chrome_extension' or job.get('batch_phase') not in ACTIVE_PHASES or not job.get('claim_session') or body.get('session')!=job['claim_session']:
    raise ValueError('旧页面已失去任务所有权，禁止发送或保存')
   import image_workflows
   return image_workflows.update(job,body,data)
  if event=='sending':job.setdefault('send_started_at',now());job.update(batch_phase='sending',status='执行中',progress=f'正在发送提示词和 {attachment_count} 个附件');_trace(job,'sending',f'正在发送提示词、{reference_count} 张参考图和模板 ZIP')
  elif event=='presend_retry':
   if job.get('batch_phase')!='claimed' or job.get('chat_url'):raise ValueError('任务已经进入发送边界，禁止自动重试')
   cause=str(body.get('message') or '')[:300]
   count=int(job.get('presend_retry_count',0) or 0)+1
   if count>3:
    message='发送前页面连续 3 次异常，已停止自动重试，请检查 GPT 页面'+('；最近原因：'+cause if cause else '')
    job.update(batch_phase='failed',status='需要处理',runner=None,error=message,failed_at=now(),claim_session='',presend_retry_count=count)
    _trace(job,'error',message)
   else:
    job.update(batch_phase='queued',status=f'发送前自动清理并重试 {count}/3',error='',claim_session='',presend_retry_count=count,retry_after=time.time()+8)
    job.pop('assigned_browser',None);job.pop('assigned_worker',None)
    _trace(job,'presend_retry',f'已安全清理发送前草稿或附件，8 秒后重新领取（{count}/3）',cause=cause)
  elif event=='attachment_repairing':
   if job.get('batch_phase') not in ('sent','waiting') or not _stable_job_chat_url(job):raise ValueError('当前任务不能补传附件')
   count=int(job.get('attachment_repair_count',0) or 0)+1
   if count>2:raise ValueError('附件补传次数已达上限，请人工检查对话')
   job.update(batch_phase='waiting',status='执行中',progress='GPT 未收到附件，正在原对话补传',attachment_repair_count=count,attachment_repair_state='preparing')
   _trace(job,'attachment_repairing',f'检测到 GPT 明确反馈缺少附件，开始第 {count} 次原对话补传')
  elif event=='attachment_repair_sending':
   if job.get('attachment_repair_state')!='preparing':raise ValueError('附件补传状态无效')
   job.update(progress=f'{attachment_count} 个附件已确认挂载，正在发送补充消息',attachment_repair_state='sending')
   _trace(job,'attachment_repair_sending',f'{reference_count} 张参考图与模板 ZIP 已确认挂载，正在发送补充消息')
  elif event=='attachment_repaired':
   if job.get('attachment_repair_state')!='sending':raise ValueError('附件补传发送状态无效')
   job.update(batch_phase='waiting',status='执行中',progress=f'附件已补传，等待 {total} 张图片',attachment_repair_state='sent',response_last_progress_at=now(),response_refresh_count=0)
   _trace(job,'attachment_repaired','已在原对话补传两份附件，继续等待生图')
  elif event=='progress':
   message=str(body.get('message','执行中'))[:200];job.update(status=message,error='');_trace(job,'progress',message)
  elif event=='sent':
   url=str(body.get('chat_url',''))[:500]
   if not _valid_chat_url(url):raise ValueError('发送后未取得有效的 GPT 对话地址')
   sent_at=now();job.update(batch_phase='sent',status='执行中',progress=f'已发送，等待 {total} 张图片',chat_url=url,sent_at=sent_at,response_last_progress_at=sent_at,response_refresh_count=0,observed_image_count=0);job.pop('send_error_at',None);_trace(job,'sent',f'提示词和 {attachment_count} 个附件已发送',chat_url=url)
   job.pop('response_refresh_requested_at',None)
  elif event=='image_progress':
   if job.get('batch_phase') not in ('sent','waiting') or not _stable_job_chat_url(job):raise ValueError('当前任务不在等待图片')
   count=int(body.get('count',0))
   if count<0 or count>total:raise ValueError('图片进展数量无效')
   if count>int(job.get('observed_image_count',0) or 0):
    job.update(observed_image_count=count,response_last_progress_at=now(),response_refresh_count=0)
    job.pop('response_refresh_requested_at',None)
    _trace(job,'image_progress',f'已识别 {count}/{total} 张独立图片')
  elif event=='response_refresh':
   if job.get('batch_phase') not in ('sent','waiting') or not _stable_job_chat_url(job):raise ValueError('当前任务不在等待图片')
   if int(job.get('response_refresh_count',0) or 0)>0:return {'ok':True,'job_status':job['status'],'duplicate':True}
   if time.time()-_timestamp(job.get('response_last_progress_at') or job.get('sent_at'),time.time())<600:raise ValueError('尚未达到十分钟无进展时间')
   job.update(response_refresh_count=1,response_last_progress_at=now())
   job.pop('response_refresh_requested_at',None)
   _trace(job,'response_refresh','对话十分钟无进展，刷新原对话后再观察十分钟')
  elif event=='response_timeout':
   if job.get('batch_phase') not in ('sent','waiting') or not _stable_job_chat_url(job):raise ValueError('当前任务不在等待图片')
   if int(job.get('response_refresh_count',0) or 0)<1:raise ValueError('对话尚未刷新，不能标记超时失败')
   if time.time()-_timestamp(job.get('response_last_progress_at'),time.time())<600:raise ValueError('刷新后尚未达到十分钟无进展时间')
   message='对话刷新后又等待十分钟仍无新图片，已跳过并转入失败任务'
   job.update(batch_phase='failed',runner=None,status='失败',progress=message,error=message,failed_at=now(),failure_reason='response_timeout',claim_session='')
   _trace(job,'response_timeout',message)
  elif event=='response_diagnostic':
   if job.get('batch_phase') not in ('sent','waiting') or not _stable_job_chat_url(job):raise ValueError('当前任务不在等待图片')
   assistant=str(body.get('assistant_text','')).strip()[:500]
   alert=str(body.get('alert_text','')).strip()[:500]
   _trace(job,'response_diagnostic','记录 GPT 页面无图诊断',assistant_text=assistant,alert_text=alert,user_turns=max(0,min(100,int(body.get('user_turns',0) or 0))),assistant_turns=max(0,min(100,int(body.get('assistant_turns',0) or 0))),candidate_images=max(0,min(100,int(body.get('candidate_images',0) or 0))),generated_images=max(0,min(100,int(body.get('generated_images',0) or 0))),stopping=bool(body.get('stopping')),composer_attachments=max(0,min(20,int(body.get('composer_attachments',0) or 0))))
  elif event=='generation_failed':
   if job.get('batch_phase') not in ('sent','waiting') or not _stable_job_chat_url(job):raise ValueError('当前任务不在等待图片')
   detail=str(body.get('message') or 'GPT 页面明确显示无法生成图片').strip()[:500]
   message='GPT 明确返回生成失败：'+detail
   job.update(batch_phase='failed',runner=None,status='失败',progress=message,error=message,failed_at=now(),failure_reason='generation_failed',claim_session='')
   _trace(job,'generation_failed',message)
  elif event=='waiting':
   url=str(body.get('chat_url',''))[:500]
   if not _stable_chat_url(url):url=_stable_job_chat_url(job)
   if not url:raise ValueError('缺少稳定的原 GPT 对话地址，停止收图')
   job.update(batch_phase='waiting',status='执行中',progress=f'等待 {total} 张图片',chat_url=url)
   if not job.get('logs') or job['logs'][-1].get('event')!='waiting':_trace(job,'waiting',f'正在等待 {total} 张独立图片生成')
  elif event=='downloading':job.update(batch_phase='downloading',status='执行中',progress='正在逐张下载');_trace(job,'downloading',f'开始逐张下载 {total} 张图片')
  elif event=='error':
   if job.get('batch_phase')=='claimed':job['batch_phase']='failed';job['failed_at']=now()
   message=str(body.get('message','扩展执行失败'))[:500];job.update(status='需要处理',runner=None,error=message);_trace(job,'error',message)
   if job.get('batch_phase') in ('sending','sent') and not _stable_job_chat_url(job):
    job.update(batch_phase='sending',runner='chrome_extension',status='等待确认',progress='已点击发送，暂未取得稳定对话地址；仅保留原标签观察，十分钟无进展后再判定失败',send_error_at=job.get('send_error_at') or now())
    _trace(job,'send_pending','已点击发送但对话地址暂不稳定，继续等待页面恢复，不立即跳过')
    _write(data,job);return {'ok':True,'job_status':job['status']}
   if _stable_job_chat_url(job) and job.get('batch_phase') in ('sent','waiting','downloading'):
    count=job.get('retry_count',0)+1
    if count<=3:job.update(runner='chrome_extension',claim_session='',retry_count=count,retry_after=time.time()+30,status=f'收图自动重试 {count}/3',batch_phase='waiting');_trace(job,'auto_retry','保留已保存图片，30 秒后重新打开原对话收图')
    else:
     job.update(batch_phase='failed',status='失败',failed_at=now(),failure_reason='collection_error',claim_session='',retry_count=count)
     _trace(job,'failed','收图自动重试已用尽，已转入失败任务，可从原对话手动重试')
  elif event in ('downloaded','downloaded_bytes'):
   number=int(body.get('step',0));step=next((s for s in job['steps'] if s['number']==number),None)
   if not step:raise ValueError('下载序号无效')
   if _saved(step):return {'ok':True,'job_status':job['status'],'duplicate':True}
   if event=='downloaded_bytes':
    encoded=str(body.get('base64',''))
    if not encoded or len(encoded)>42*1024*1024:raise ValueError('浏览器传回的图片数据无效或过大')
    try:raw=base64.b64decode(encoded,validate=True)
    except (ValueError,TypeError):raise ValueError('浏览器传回的图片数据不是有效 Base64') from None
    if len(raw)<1024 or len(raw)>30*1024*1024:raise ValueError('浏览器传回的图片大小不合理')
    source_label='浏览器页面内存'
   else:
    source=Path(str(body.get('path','')))
    if not source.is_file():raise ValueError('浏览器下载文件不存在')
    raw=source.read_bytes();source_label=str(source)
   ext=_image_ext(raw);digest=hashlib.sha256(raw).hexdigest()
   if digest in _input_hashes(job):
    _trace(job,'invalid_download','拒绝归档：下载文件与参考印花或模板附件完全相同',step=number,sha256=digest,source=source_label)
    _write(data,job)
    raise ValueError('下载文件与参考印花或模板附件完全相同，已拒绝归档，继续等待生成图')
   folder=Path(job['result_folder']);folder.mkdir(parents=True,exist_ok=True)
   target=folder/(f'{number:02d}-'+uuid.uuid4().hex[:8]+ext);target.write_bytes(raw)
   if hashlib.sha256(target.read_bytes()).digest()!=hashlib.sha256(raw).digest():raise ValueError('图片归档校验失败')
   step.update(phase='saved',status='已保存',output=str(target),sha256=digest,saved_at=now(),download_source=source_label)
   job.update(batch_phase='downloading',status='执行中',progress=f'已保存 {sum(_saved(s) for s in job["steps"])}/{total} 张',error='')
   _trace(job,'downloaded',f'第 {number} 张图片已保存',step=number,output=str(target))
   if all(_saved(s) for s in job['steps']):
    append_fixed(job)
    _trace(job,'fixed_images','附加固定图 '+str(len(job.get('fixed_images',[])))+' 张')
    job.update(batch_phase='saved',status=f'{total} 张已保存，待检查',runner=None,completed_at=now());_trace(job,'completed',f'{total} 张独立图片均已保存并通过文件校验')
  else:raise ValueError('未知执行事件')
  _write(data,job);return {'ok':True,'job_status':job['status']}


def watchdog(data,body=None):
 browser,worker=_identity(body or {})
 with LOCK:
  jobs=maintenance(data)
  import gpt_unattended
  account=gpt_unattended.account(data,browser,worker)
  if account['blocked']:return {'pending':False,'page_alive':False,'account_blocked':True,'wait_seconds':account['wait_seconds'],'message':account['message'],'recovery_action':None}
  if not any(j.get('runner')=='chrome_extension' and j.get('batch_phase') in ACTIVE_PHASES and _owns(j,browser,worker) for j in jobs):
   if _task_gap_remaining(jobs,browser,worker) or _generation_circuit(jobs,browser,worker)['open']:
    return {'pending':False,'page_alive':False,'message':'当前配置冷却或熔断中，等待后再领取','recovery_action':None}
  pending=[];takeover_waits=[]
  for j in jobs:
   if j.get('runner')!='chrome_extension':continue
   if j.get('batch_phase') in ACTIVE_PHASES and _owns(j,browser,worker):pending.append(j);continue
   if j.get('batch_phase')!='queued':continue
   allowed,_fallback,_preferred,remaining,_reason=_takeover(j,data,browser,jobs,worker)
   if allowed:pending.append(j)
   elif remaining:takeover_waits.append(remaining)
  rows,_=_worker_rows(data);worker_row=rows.get(browser+':'+worker,STATE if not worker else {})
  live=time.time()-float(worker_row.get('_epoch',0) or 0)<90
  owned_active=[j for j in pending if j.get('batch_phase') in ACTIVE_PHASES and _owns(j,browser,worker)]
  if owned_active:
   try:owner_recent=all(j.get('claim_session') and time.time()-float(j.get('owner_seen',0))<120 for j in owned_active)
   except (TypeError,ValueError):owner_recent=False
   live=live and owner_recent
  elif pending and worker_row.get('status') in ('执行中','等待登录','需要清理草稿或附件','浏览资料库','任务已跳过'):
   # A paused or draft-blocked tab may keep its heartbeat while ignoring queued work.
   live=False
  message='等待执行页面连接' if pending and not live else '队列运行中' if pending else ('等待轮到的浏览器；保留期结束后自动接管' if takeover_waits else '没有待执行任务')
  refresh=next((j for j in owned_active if j.get('response_refresh_requested_at') and _stable_job_chat_url(j)),None)
  resumable=next((j for j in owned_active if _stable_job_chat_url(j)),None) if not live else None
  action={'type':'refresh','job_id':refresh['id'],'chat_url':_stable_job_chat_url(refresh),'session':refresh.get('claim_session','')} if refresh else ({'type':'resume','job_id':resumable['id'],'chat_url':_stable_job_chat_url(resumable),'session':resumable.get('claim_session','')} if resumable else None)
  # 0.3.35 ignores the new ``resume`` action. Report the recovery command as
  # effectively alive so old builds do not fall through to the unsafe generic
  # home-tab refresher. 0.3.36 consumes the action before this flag.
  reported_live=live or bool(action and action.get('type')=='resume') or bool(owned_active and not any(_stable_job_chat_url(j) for j in owned_active))
  return {'pending':bool(pending),'page_alive':reported_live,'takeover_wait_seconds':min(takeover_waits,default=0),'message':message,'recovery_action':action}

