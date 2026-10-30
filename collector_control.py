"""Local collector commands and per-browser extension heartbeats."""
import json,re,uuid,threading
from datetime import datetime,timezone
from pathlib import Path
LOCK=threading.RLock()
def now():return datetime.now(timezone.utc).isoformat()
def version_at_least(value,minimum):
 try:return tuple(int(part) for part in str(value).split('.'))>=minimum
 except (TypeError,ValueError):return False
def read(data):
 p=Path(data)/'collector-control.json'
 s=json.loads(p.read_text(encoding='utf-8')) if p.exists() else {'commands':[]}
 s.setdefault('commands',[]);s.setdefault('clients',{});s.setdefault('task_runs',[])
 for c in s['commands']:
  if c['status'] in ('queued','running') and (datetime.now(timezone.utc)-datetime.fromisoformat(c.get('started',c['created']))).total_seconds()>1800:c.update(status='failed',message='等待或执行超过 30 分钟，请检查插件并重新同步')
 statuses={'queued':0,'running':0,'finished':0,'failed':0}
 for command in s['commands']:
  statuses[command.get('status','failed')]=statuses.get(command.get('status','failed'),0)+1
 active=[]
 for client in s['clients'].values():
  task=client.get('task_state') or {}
  if task.get('status') in ('running','paused','failed'):
   active.append({'client_id':client.get('client_id'),'browser':client.get('browser'),'mall_id':client.get('mall_id'),'store_name':client.get('store_name'),'at':client.get('at'),**task})
 s['summary']={**statuses,'total':len(s['commands']),'active_clients':len(active)}
 task_statuses={'queued':0,'running':0,'finished':0,'failed':0}
 for task in s['task_runs']:
  status='finished' if task.get('status') in ('done','finished') else task.get('status','failed')
  if status=='paused':status='running'
  task_statuses[status]=task_statuses.get(status,0)+1
 s['task_summary']={**task_statuses,'total':len(s['task_runs']),'active_clients':len(active)}
 s['active_tasks']=active
 return s
def write(data,state):
 p=Path(data)/'collector-control.json';tmp=p.with_suffix('.tmp');tmp.write_text(json.dumps(state,ensure_ascii=False),encoding='utf-8');tmp.replace(p)
def request(data,body):
 with LOCK:
  s=read(data)
  mall=str(body.get('mall_id','')).strip()
  kind=str(body.get('task_type') or 'flow').strip()
  client=str(body.get('client_id','')).strip()
  if not re.fullmatch(r'\d+',mall):raise ValueError('请选择有效店铺后再采集')
  if kind not in ('flow','daily_audit','product_status','accelerator_status'):raise ValueError('不支持的采集任务')
  if kind=='accelerator_status' and client and client in s['clients'] and not version_at_least(s['clients'][client].get('version'),(0,20,10)):raise ValueError('请先将当前浏览器的采集助手重新加载到 0.20.10，再更新全部在售商品的加速器状态')
  if kind=='product_status' and client and client in s['clients'] and not version_at_least(s['clients'][client].get('version'),(0,19,2)):raise ValueError('请先将当前浏览器的采集助手重新加载到 0.19.2，再更新商品状态')
  if client and not re.fullmatch(r'[A-Za-z0-9_-]{8,80}',client):raise ValueError('浏览器标识无效')
  if kind=='daily_audit' and client and client in s['clients'] and not version_at_least(s['clients'][client].get('version'),(0,18,3)):raise ValueError('当前浏览器的 Temu 数据采集助手需要重新加载到 0.18.3 后才能运行每日必做')
  if any(c['status'] in ('queued','running') and c.get('mall_id')==mall for c in s['commands']):return {'message':'这家店已有采集请求等待或执行中，请查看记录'}
  label='加速器状态采集' if kind=='accelerator_status' else '商品状态采集' if kind=='product_status' else '每日必做巡检' if kind=='daily_audit' else '流量采集'
  s['commands'].insert(0,{'id':uuid.uuid4().hex,'kind':kind,'mall_id':mall,'target_client':client,'created':now(),'status':'queued','message':f'等待登录这家店的浏览器插件领取{label}；其他店铺不会领取'})
  s['commands']=s['commands'][:30];write(data,s);return {'message':'已请求立即采集；插件约 5 秒检查一次，当前采集阶段结束后优先响应','command_id':s['commands'][0]['id']}
def bridge(data,body):
 with LOCK:
  s=read(data)
  client=str(body.get('client_id','')).strip();mall=str(body.get('mall_id','')).strip()
  browser=str(body.get('browser',''))[:30];store=str(body.get('store_name',''))[:120]
  if client and re.fullmatch(r'[A-Za-z0-9_-]{8,80}',client):
   previous=s['clients'].get(client,{})
   task=body.get('task_state') if isinstance(body.get('task_state'),dict) else previous.get('task_state',{})
   safe_task={key:task.get(key) for key in ['status','taskMode','phase','message','progress','eta','startedAt','endedAt','stats'] if key in task}
   auto=body.get('auto_state') if isinstance(body.get('auto_state'),dict) else previous.get('auto_state',{})
   safe_auto={key:auto.get(key) for key in ['enabled','product_error','flow_error','product_finished_at','product_retry_at','accelerator_error','accelerator_finished_at','accelerator_retry_at'] if key in auto}
   s['clients'][client]={'client_id':client,'browser':browser,'mall_id':mall if re.fullmatch(r'\d+',mall) else '',
                         'store_name':store,'version':str(body.get('version','')),'message':str(body.get('message',''))[:500],'at':now(),'task_state':safe_task,'auto_state':safe_auto}
   if safe_task.get('status') and safe_task.get('startedAt'):
    run_id=f"{client}:{safe_task.get('taskMode','unknown')}:{safe_task['startedAt']}"
    record=next((item for item in s['task_runs'] if item.get('id')==run_id),None)
    update={'id':run_id,'client_id':client,'browser':browser,'mall_id':mall if re.fullmatch(r'\d+',mall) else '',
            'store_name':store,'updated_at':now(),**safe_task}
    if record:record.update(update)
    else:s['task_runs'].insert(0,{'created_at':now(),**update})
    s['task_runs']=sorted(s['task_runs'],key=lambda item:str(item.get('updated_at','')),reverse=True)[:200]
  s['heartbeat']={'at':now(),'version':str(body.get('version','')),'message':str(body.get('message',''))[:500],
                  'client_id':client,'browser':browser,'mall_id':mall,'store_name':store}
  if body.get('finished_id'):
   for c in s['commands']:
    if c['id']==body['finished_id'] and c['status']=='running' and (not c.get('claimed_by') or c.get('claimed_by')==client):c.update(status='failed' if body.get('error') else 'finished',finished=now(),message=str(body.get('error') or body.get('message') or '采集完成')[:500])
  if body.get('progress_id'):
   for c in s['commands']:
    if c['id']==body['progress_id'] and c['status']=='running' and c.get('claimed_by')==client:
     c.update(message=str(body.get('message') or '采集中')[:500],updated_at=now())
  if body.get('blocked_reason') and not body.get('claim'):
   for c in s['commands']:
    if c['status']=='queued' and c.get('mall_id')==mall and (not c.get('target_client') or c['target_client']==client):
     c.update(message=str(body['blocked_reason'])[:500],updated_at=now())
  command=None
  if body.get('claim') and client and re.fullmatch(r'\d+',mall):
   for c in s['commands']:
    compatible=(c.get('kind')!='accelerator_status' or version_at_least(body.get('version'),(0,20,10))) and (c.get('kind')!='daily_audit' or version_at_least(body.get('version'),(0,18,3))) and (c.get('kind')!='product_status' or version_at_least(body.get('version'),(0,19,2)))
    if c['status']=='queued' and compatible and c.get('mall_id')==mall and (not c.get('target_client') or c.get('target_client')==client):
     label='加速器状态采集' if c.get('kind')=='accelerator_status' else '商品状态采集' if c.get('kind')=='product_status' else '每日必做巡检' if c.get('kind')=='daily_audit' else '流量采集'
     c.update(status='running',started=now(),claimed_by=client,claimed_browser=browser,message=f'{browser or "浏览器"} 已领取{label}，正在检查 {store or mall}');command=dict(c);break
  pending=any(c['status'] in ('queued','running') and c.get('mall_id')==mall and (not c.get('target_client') or c['target_client']==client) for c in s['commands'])
  write(data,s);return {'command':command,'pending':pending}
