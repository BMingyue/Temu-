"""Daily operational checklist based only on locally observed records."""
import json,hashlib
from datetime import datetime,date,timezone,timedelta
CHINA=timezone(timedelta(hours=8))
LABELS={'products':'商品＋活动中的商品目录','activities':'商品＋活动中的活动价格','orders':'订单＋流量中的订单','returns':'订单＋流量中的退款','flow':'订单＋流量中的流量','ads':'广告日报'}

def init(db):
 db.execute('CREATE TABLE IF NOT EXISTS daily_task_states(key TEXT PRIMARY KEY,status TEXT,updated TEXT,note TEXT)')

def moment(value):
 try:
  d=datetime.fromisoformat(str(value).replace('Z','+00:00'))
  return d.replace(tzinfo=CHINA) if not d.tzinfo else d
 except ValueError:return None

def snapshot(connect,now=None):
 now=now or datetime.now(CHINA);today=now.astimezone(CHINA).date()
 with connect() as db:
  receipts=[json.loads(r['payload']) for r in db.execute('SELECT payload FROM collector_receipts ORDER BY observed_at DESC')]
  shops={r['mall_id']:r['name'] for r in db.execute('SELECT * FROM collector_shops')}
  for r in receipts:shops.setdefault(r['mall_id'],r.get('shop') or '店铺 '+r['mall_id'])
  catalog=[{**json.loads(r['payload']),'shop':r['shop'],'site':r['site'],'captured':r['captured']} for r in db.execute('SELECT * FROM catalog')]
  entries=[{**dict(r),'payload':json.loads(r['payload'])} for r in db.execute("SELECT * FROM entries WHERE kind='review'")]
  states={r['key']:dict(r) for r in db.execute('SELECT * FROM daily_task_states')}
 freshness=[]
 for mall,name in shops.items():
  for kind,label in LABELS.items():
   receipt=next((r for r in receipts if r['mall_id']==mall and r['dataset']==kind),None)
   time=moment(receipt.get('observed_at')) if receipt else None
   age=max(0,(now-time).total_seconds()/3600) if time else None
   state='missing' if not time else 'stale' if age>36 else 'received'
   freshness.append({'mall_id':mall,'shop':name,'dataset':kind,'label':label,'state':state,'hours':round(age,1) if age is not None else None,'observed_at':receipt.get('observed_at') if receipt else None,'rows':receipt.get('rows') if receipt else None,'start_date':receipt.get('start_date') if receipt else None,'end_date':receipt.get('end_date') if receipt else None,'note':'接收新鲜度，不等于报表日期新鲜或全量采齐'})
 tasks=[]
 for r in catalog:
  issues=sorted({str(v.get('issue','')).strip() for v in r.get('variants',[]) if str(v.get('issue','')).strip() not in ('','-','—')})
  todo=str(r.get('todo','')).strip();todo='' if todo in ('-','—') else todo
  reason='；'.join(([todo] if todo else [])+issues)
  if not reason:continue
  key='catalog:'+hashlib.sha256(json.dumps([r['shop'],r['site'],r['spu'],r.get('status'),reason],ensure_ascii=False).encode()).hexdigest()[:24]
  task={'key':key,'kind':'catalog','title':r.get('title') or r['spu'],'shop':r['shop'],'site':r['site'],'product_id':r['spu'],'priority':1,'category':'上架阻塞核对','evidence':reason,'action':'到来源后台核对当前状态，按平台待办处理，再记录结果','source_at':r['captured'],'source_url':'https://agentseller.temu.com/newon/product-select'}
  if any(word in reason for word in ['侵权','违规']):task['category']='违规状态核对';task['priority']=0
  saved=states.get(key,{})
  task.update(status=saved.get('status','pending'),note=saved.get('note',''),updated=saved.get('updated'))
  tasks.append(task)
 for e in entries:
  p=e['payload'];due=p.get('followup','');done=p.get('status')=='done'
  try:day=date.fromisoformat(due)
  except (ValueError,TypeError):continue
  if day>today and not done:continue
  tasks.append({'key':'review:'+e['id'],'kind':'review','title':p.get('title'),'shop':p.get('shop'),'site':p.get('site'),'product_id':p.get('product_id'),'category':'到期复查','priority':0 if day<today else 1,'evidence':p.get('notes') or '按之前记录的动作核对后续变化','action':'核对同口径数据并记录复查结论','due':due,'status':'done' if done else 'pending','note':p.get('outcome',''),'updated':p.get('completed_at')})
 tasks.sort(key=lambda t:(t['status']=='done',t['priority'],t.get('due','9999'),t['key']))
 pending=[t for t in tasks if t['status']=='pending']
 return {'today':today.isoformat(),'has_collector_receipt':bool(receipts),'last_received':receipts[0]['observed_at'] if receipts else None,'freshness':freshness,'tasks':tasks,'counts':{'pending':len(pending),'catalog':sum(t['kind']=='catalog' for t in pending),'reviews':sum(t['kind']=='review' for t in pending),'done':len(tasks)-len(pending)},'requirements':[{'title':'先接收商品＋活动','detail':'在正确扩展执行一次“商品＋活动”，让工作台建立商品、SKU 和活动价格对应关系。','target':'collector'},{'title':'再接收订单＋流量','detail':'执行一次“订单＋流量”，包含订单金额和退款。看到本地回执后才能做经营判断。','target':'collector'},{'title':'补齐你的成本口径','detail':'在数据中心导入商品、履约和广告等成本。金额币种和结算口径未确认前不计算利润。','target':'data'}]}

def update(body,connect):
 key=body.get('key');status=body.get('status');note=str(body.get('note','')).strip()
 if status not in ['pending','done'] or len(note)>3000:raise ValueError('任务状态或结论无效')
 task=next((t for t in snapshot(connect)['tasks'] if t['key']==key),None)
 if not task:raise ValueError('待办已变化，请刷新后操作')
 if status=='done' and not note:raise ValueError('请简要记录核对结果，之后才能追溯这次处理')
 now=datetime.now(CHINA).isoformat(timespec='seconds')
 with connect() as db:
  if task['kind']=='review':
   eid=key.split(':',1)[1];row=db.execute("SELECT payload FROM entries WHERE id=? AND kind='review'",(eid,)).fetchone()
   if not row:raise ValueError('复查记录不存在')
   p=json.loads(row['payload']);p.update(status=status,outcome=note,completed_at=now if status=='done' else '')
   db.execute('UPDATE entries SET payload=? WHERE id=?',(json.dumps(p,ensure_ascii=False),eid))
  else:db.execute('INSERT OR REPLACE INTO daily_task_states VALUES(?,?,?,?)',(key,status,now,note))
 return {'ok':True,'message':'已记录本次核对结果；平台状态仍以后台为准' if status=='done' else '已保存进展，保留在待处理清单'}
