"""Receive normalized output from the user's existing collector, without credentials.
Unknown time-dimension and currency semantics remain explicit rather than guessed.
"""
import json,re,math,hashlib
from urllib.parse import urlparse
from datetime import datetime,timezone,date

PATHS={
 '/api/client/products/upload':('products','rows'),
 '/api/client/products/activities/upload':('activities','rows'),
 '/api/client/orders/upload':('orders','rows'),
 '/api/client/returns/upload':('returns','rows'),
 '/api/client/shipping/upload':('shipping','rows'),
 '/api/client/ads/save':('ads','reports'),
 '/api/client/flow-overviews':('flow','items'),
 '/api/client/daily-audits':('daily','rows'),
 '/api/client/products/accelerators/upload':('accelerators','rows'),
}
LABELS={'products':'商品目录','activities':'活动价格','orders':'订单明细','returns':'退货退款','shipping':'精准物流费用','ads':'广告日报','flow':'店铺流量','daily':'每日必做巡检','accelerators':'商品加速器状态'}
FIELDS={
 'products':['spuId','skcId','skuId','skuCode','imageUrl','declaredPrice','skuCategory','properties','specification','lifecycleStatus','priceAdjustable','onSale','saleStatusSource','currency'],
 'activities':['enrollId','spuId','skcId','skuId','skuCode','siteId','siteName','activityType','activityTypeName','activityName','statusKey','sessionStatus','sessionStatusTag','cancelReviewStatus','sessionStartTime','sessionEndTime','enrollTime','activityStock','remainingStock','currency','dailyPrice','activityPrice','discountRate','properties'],
 'orders':['fulfillmentMode','queryType','parentOrderSn','orderSn','skuId','temuSkuId','productSkcId','productSpuId','extCodeList','originQuantity','parentConfirmTimeStr','money','recoveredFromReturnRefund'],
 'returns':['parentAfterSalesSn','afterSalesSn','parentOrderSn','orderSn','productSkuId','temuSkuId','productSkcId','productSpuId','afterSalesType','afterSalesTypeDesc','afterSalesStatus','afterSalesStatusDesc','createdAt','completedAt','applyReturnGoodsNumber','returnGoodsNumber','rejectGoodsNumber','orderGoodsNumber','reasonCode','reasonDesc','goodsName','goodsSpec'],
 'shipping':['parent_order_sn','package_sn','tracking_no','carrier','service_name','lookup_status','online_shipping_amount_usd','source'],
 'ads':['date','response_ok','values'], 'flow':['time_dimension','data'],
 'daily':['date','captured_at','status','traffic','consultations','orders','steps','warnings','source_urls'],
 'accelerators':['spuId','skcId','skuId','siteName','status','price','currency','priceKind','sourceUrl','evidence'],
}

def sanitize(value,depth=0):
 if depth>30:raise ValueError('数据嵌套过深')
 if isinstance(value,float) and not math.isfinite(value):raise ValueError('数据包含无效数字')
 if isinstance(value,list):return [sanitize(v,depth+1) for v in value]
 if isinstance(value,dict):return {k:sanitize(v,depth+1) for k,v in value.items() if not re.search(r'phone|password|cookie|token|authorization|requestheaders|anti.content',k,re.I)}
 return value

def timestamp(value):
 try:
  d=datetime.fromisoformat(str(value).replace('Z','+00:00'))
  if not d.tzinfo:raise ValueError()
  return d.astimezone(timezone.utc).isoformat()
 except ValueError:raise ValueError('采集时间需要包含时区')

def key_for(kind,row):
 needed={'products':['spuId','skcId'],'activities':['enrollId','skuId'],'orders':['parentOrderSn','orderSn','skuId'],'returns':['afterSalesSn','productSkuId'],'shipping':['parent_order_sn'],'ads':['date'],'flow':['time_dimension'],'daily':['date'],'accelerators':['spuId','siteName']}[kind]
 for key in needed:
  if row.get(key) is None or str(row[key]).strip()=='':raise ValueError(f'{LABELS[kind]}缺少标识：{key}')
 if kind=='products' and 'onSale' in row and not isinstance(row['onSale'],bool):raise ValueError('在售状态必须为布尔值')
 if kind=='accelerators':
  if row.get('status') not in ('enabled','eligible','max_eligible','disabled','unknown'):raise ValueError('加速器状态无效')
  if row.get('price') is not None and (not row.get('currency') or row.get('priceKind') not in ('current','offer')):raise ValueError('加速器价格缺少币种或报价类型')
  if not str(row.get('sourceUrl','')).startswith(('https://agentseller.temu.com/','https://agentseller-us.temu.com/')):raise ValueError('加速器证据来源无效')
 if kind=='flow':
  if type(row['time_dimension']) is not int or row['time_dimension'] not in range(6) or not isinstance(row.get('data'),dict):raise ValueError('流量维度或报表格式发生变化')
 if kind=='ads':
  date.fromisoformat(row['date'])
  if row.get('response_ok') is not True or not isinstance(row.get('values'),dict):raise ValueError('广告日报未成功返回')
 if kind=='daily':
  date.fromisoformat(row['date'])
  if row.get('status') not in ('finished','partial','failed'):raise ValueError('每日巡检状态无效')
  for section in ('traffic','consultations','orders'):
   if not isinstance(row.get(section),dict):raise ValueError('每日巡检缺少结果：'+section)
 for key in ['declaredPrice','dailyPrice','activityPrice','money','originQuantity','applyReturnGoodsNumber','returnGoodsNumber','online_shipping_amount_usd','price']:
  val=row.get(key)
  if val is not None and (isinstance(val,bool) or not isinstance(val,(int,float)) or val<0):raise ValueError('商品/订单数值无效：'+key)
 identifiers={'products':['spuId','skcId','skuId'],'activities':['enrollId','skuId','siteId'],'orders':['parentOrderSn','orderSn','skuId'],'returns':['afterSalesSn','productSkuId'],'shipping':['parent_order_sn','package_sn','tracking_no'],'ads':['date'],'flow':['time_dimension'],'daily':['date'],'accelerators':['spuId','siteName','skuId']}[kind]
 return json.dumps([str(row.get(k,'')) for k in identifiers],ensure_ascii=False)

def init(db):
 db.executescript('''CREATE TABLE IF NOT EXISTS collector_records(dataset TEXT,mall_id TEXT,item_key TEXT,payload TEXT,captured TEXT,PRIMARY KEY(dataset,mall_id,item_key));
 CREATE TABLE IF NOT EXISTS collector_receipts(id TEXT PRIMARY KEY,observed_at TEXT,payload TEXT);
 CREATE TABLE IF NOT EXISTS collector_payloads(id TEXT,observed_at TEXT,source_path TEXT,body TEXT,PRIMARY KEY(id,observed_at));
 CREATE TABLE IF NOT EXISTS collector_shops(mall_id TEXT PRIMARY KEY,name TEXT,captured TEXT);
 CREATE TABLE IF NOT EXISTS collector_snapshots(dataset TEXT,mall_id TEXT,batch_id TEXT,captured TEXT,row_count INTEGER,source_total INTEGER,payload TEXT,PRIMARY KEY(dataset,mall_id));
 CREATE TABLE IF NOT EXISTS collector_current_items(dataset TEXT,mall_id TEXT,item_key TEXT,batch_id TEXT,captured TEXT,PRIMARY KEY(dataset,mall_id,item_key));''')
 bootstrap_current_snapshots(db)

def complete_snapshot(kind,rows,source_meta):
 if kind not in ('products','activities') or not isinstance(source_meta,dict) or source_meta.get('complete') is not True:return False
 identity='skcId' if kind=='products' else 'enrollId'
 count_key='collected_skc_count' if kind=='products' else 'enrollment_count'
 identities={str(row.get(identity,'')).strip() for row in rows if str(row.get(identity,'')).strip()}
 try:announced=int(source_meta.get(count_key));total=int(source_meta.get('total'))
 except (TypeError,ValueError):return False
 return announced>=0 and total>=0 and len(identities)==announced==total

def bootstrap_current_snapshots(db):
 paths={'products':('/api/client/products/upload','rows','skcId','collected_skc_count'),'activities':('/api/client/products/activities/upload','rows','enrollId','enrollment_count')}
 for kind,(path,array,identity,count_key) in paths.items():
  existing={row[0] for row in db.execute('SELECT mall_id FROM collector_snapshots WHERE dataset=?',(kind,))}
  for archived in db.execute('SELECT id,observed_at,body FROM collector_payloads WHERE source_path=? ORDER BY observed_at DESC',(path,)):
   try:body=json.loads(archived['body']);rows=body.get(array,[]);meta=body.get('crawl_result',{});total=int(meta.get('total'));identities={str(row.get(identity,'')).strip() for row in rows if isinstance(row,dict) and str(row.get(identity,'')).strip()}
   except (TypeError,ValueError,json.JSONDecodeError):continue
   if meta.get('source')!='browser_extension' or total<0 or len(identities)!=total:continue
   mall=str(body.get('mall_id','')).strip()
   if mall in existing or not re.fullmatch(r'\d{1,40}',mall):continue
   if str(meta.get('source_mall_id') or '')!=mall or meta.get('complete') is False:continue
   keys=[]
   try:
    for row in rows:keys.append(key_for(kind,{k:v for k,v in row.items() if k in FIELDS[kind]}))
   except (TypeError,ValueError):continue
   inferred={**meta,'complete':True,count_key:len(identities),'completion_reason':'legacy_full_batch_inferred'}
   db.execute('DELETE FROM collector_current_items WHERE dataset=? AND mall_id=?',(kind,mall))
   db.executemany('INSERT OR IGNORE INTO collector_current_items VALUES(?,?,?,?,?)',((kind,mall,key,archived['id'],archived['observed_at']) for key in keys))
   db.execute('INSERT OR REPLACE INTO collector_snapshots VALUES(?,?,?,?,?,?,?)',(kind,mall,archived['id'],archived['observed_at'],len(set(keys)),total,json.dumps(inferred,ensure_ascii=False)))
   existing.add(mall)

def current_records(db,kind,mall=''):
 params=[kind]
 mall_sql=''
 if mall:mall_sql=' AND records.mall_id=?';params.append(mall)
 return db.execute('''SELECT records.* FROM collector_records records
  WHERE records.dataset=?'''+mall_sql+''' AND (
   NOT EXISTS(SELECT 1 FROM collector_snapshots snapshots WHERE snapshots.dataset=records.dataset AND snapshots.mall_id=records.mall_id)
   OR EXISTS(SELECT 1 FROM collector_current_items current WHERE current.dataset=records.dataset AND current.mall_id=records.mall_id AND current.item_key=records.item_key)
  ) ORDER BY records.captured DESC,records.item_key''',params)

def record_attempt(connect,status,message):
 with connect() as db:
  db.execute("INSERT OR REPLACE INTO settings VALUES('collector_last_attempt',?)",(json.dumps({'at':datetime.now(timezone.utc).isoformat(),'status':status,'message':str(message)[:240]},ensure_ascii=False),))

def ingest(envelope,connect):
 if not isinstance(envelope,dict) or envelope.get('path') not in PATHS:raise ValueError('不支持的采集结果类型')
 cid=envelope.get('id','')
 if not isinstance(cid,str) or not re.fullmatch('[a-f0-9]{64}',cid):raise ValueError('本地同步批次 ID 无效')
 observed=timestamp(envelope.get('observed_at'))
 body=sanitize(envelope.get('body'))
 if not isinstance(body,dict):raise ValueError('采集载荷为空')
 fingerprint=hashlib.sha256(json.dumps([envelope['path'],body],sort_keys=True,ensure_ascii=False,allow_nan=False).encode()).hexdigest()
 mall=str(body.get('mall_id','')).strip()
 if not re.fullmatch(r'\d{1,40}',mall):raise ValueError('店铺 ID 无效')
 kind,array=PATHS[envelope['path']]
 rows=body.get(array)
 if not isinstance(rows,list) or len(rows)>100000:raise ValueError('记录列表格式或大小无效')
 normalized={}
 for row in rows:
  if not isinstance(row,dict):raise ValueError('记录必须是对象')
  row={k:v for k,v in row.items() if k in FIELDS[kind]}
  key=key_for(kind,row)
  if key in normalized and normalized[key]!=row:raise ValueError('同批记录有冲突的重复标识')
  normalized[key]=row
 source_meta=body.get('crawl_result',{}) if isinstance(body.get('crawl_result'),dict) else {}
 for source_mall in (body.get('source_mall_id'),source_meta.get('source_mall_id')):
  if source_mall is not None and str(source_mall)!=mall:raise ValueError('采集来源店铺与目标店铺不一致')
 is_complete=complete_snapshot(kind,list(normalized.values()),source_meta)
 receipt={'id':cid,'fingerprint':fingerprint,'dataset':kind,'label':LABELS[kind],'mall_id':mall,'shop':str(body.get('store_name',''))[:200], 'browser':str(body.get('collector_browser',''))[:40],'client_id':str(body.get('collector_client_id',''))[:80],'observed_at':observed,'rows':len(normalized),'source_path':envelope['path'],'start_date':body.get('start_date'),'end_date':body.get('end_date'),'coverage':'完整当前快照' if is_complete else '采集器本批结果，未确认全量','source_meta':source_meta,'source_total':body.get('total_count')}
 with connect() as db:
  old=db.execute('SELECT observed_at,payload FROM collector_receipts WHERE id=?',(cid,)).fetchone()
  if old and json.loads(old['payload']).get('fingerprint')!=fingerprint:raise ValueError('同一同步批次 ID 对应了不同数据')
  if old and old['observed_at']==observed:return {**json.loads(old['payload']),'duplicate':True}
  # Keep each sanitized source batch for future date/unit verification and history.
  db.execute('INSERT OR IGNORE INTO collector_payloads VALUES(?,?,?,?)',(cid,observed,envelope['path'],json.dumps(body,ensure_ascii=False,allow_nan=False)))
  stale=0
  for key,row in normalized.items():
   current=db.execute('SELECT captured FROM collector_records WHERE dataset=? AND mall_id=? AND item_key=?',(kind,mall,key)).fetchone()
   if current and current['captured']>observed:stale+=1;continue
   db.execute('INSERT OR REPLACE INTO collector_records VALUES(?,?,?,?,?)',(kind,mall,key,json.dumps(row,ensure_ascii=False),observed))
  promoted=False
  if is_complete:
   active=db.execute('SELECT captured FROM collector_snapshots WHERE dataset=? AND mall_id=?',(kind,mall)).fetchone()
   if not active or active['captured']<=observed:
    db.execute('DELETE FROM collector_current_items WHERE dataset=? AND mall_id=?',(kind,mall))
    db.executemany('INSERT INTO collector_current_items VALUES(?,?,?,?,?)',((kind,mall,key,cid,observed) for key in normalized))
    db.execute('INSERT OR REPLACE INTO collector_snapshots VALUES(?,?,?,?,?,?,?)',(kind,mall,cid,observed,len(normalized),int(source_meta.get('total',0)),json.dumps(source_meta,ensure_ascii=False)))
    promoted=True
  name=str(body.get('store_name','')).strip()[:200]
  if name:db.execute('INSERT INTO collector_shops VALUES(?,?,?) ON CONFLICT(mall_id) DO UPDATE SET name=excluded.name,captured=excluded.captured WHERE excluded.captured>=collector_shops.captured',(mall,name,observed))
  receipt['empty_flow_rows']=sum(empty_flow(r) for r in normalized.values()) if kind=='flow' else 0
  receipt['stale_rows_skipped']=stale
  receipt['current_snapshot']=promoted
  receipt['message']=f'已接收 {len(normalized)} 条{LABELS[kind]}，旧版本跳过 {stale} 条'+('；已设为当前完整快照' if promoted else '')
  db.execute('INSERT OR REPLACE INTO collector_receipts VALUES(?,?,?)',(cid,observed,json.dumps(receipt,ensure_ascii=False)))
 return receipt

FLOW_METRICS=('impressionCount','clickCount','orderPayOrderNum','orderPayGoodsNum','clickImpressionRate','clickOrderRatio','orderPayImpressionRate')
def empty_flow(row):
 result=row.get('data',{}).get('result',{})
 return not any(type(result.get(k)) in (int,float) for k in FLOW_METRICS)

def display_flow(db,row):
 if not empty_flow(row):return row
 warning={'latest_attempt':row['_captured'],'message':'最新后台汇总全部为空，不能视为零销量或零曝光。','fallback':False}
 for archived in db.execute("SELECT observed_at,body FROM collector_payloads WHERE source_path='/api/client/flow-overviews' AND observed_at<=? ORDER BY observed_at DESC",(row['_captured'],)):
  body=json.loads(archived['body'])
  if str(body.get('mall_id'))!=row['_mall_id']:continue
  for candidate in body.get('items',[]):
   if candidate.get('time_dimension')!=row['time_dimension'] or empty_flow(candidate):continue
   # Do not borrow a different source/site or mix fields from two captures.
   old=candidate.get('data',{});new=row.get('data',{})
   old_host=urlparse(old.get('source_page') or '').hostname;new_host=urlparse(new.get('source_page') or '').hostname
   if old.get('site_label')!=new.get('site_label'):continue
   if old_host!=new_host and not (new_host=='agentseller.temu.com' and old_host=='agentseller-us.temu.com'):continue
   if old_host!=new_host:warning['source_warning']='最新空报表来自通用后台，当前展示历史美国后台报表；站点标识未记录。'
   return {**candidate,'_mall_id':row['_mall_id'],'_key':row['_key'],'_captured':archived['observed_at'],'_quality':{**warning,'fallback':True,'message':'最新后台汇总全部为空，已保留同店铺、同范围的上次有效报表；下方时间为有效报表采集时间。'}}
 return {**row,'_quality':warning}

def snapshot(connect,mall=''):
 with connect() as db:
  diagnostic=db.execute("SELECT value FROM settings WHERE key='collector_last_attempt'").fetchone()
  diagnostic=json.loads(diagnostic['value']) if diagnostic else None
  shops=[dict(r) for r in db.execute('SELECT * FROM collector_shops ORDER BY name')]
  # Some ads payloads only contain mall_id; still make those stores selectable.
  known={r['mall_id'] for r in shops}
  shops += [{'mall_id':r[0],'name':'店铺 '+r[0]} for r in db.execute('SELECT DISTINCT mall_id FROM collector_records') if r[0] not in known]
  where=' WHERE mall_id=?' if mall else '';params=(mall,) if mall else ()
  counts={k:sum(1 for _ in current_records(db,k,mall)) for k in LABELS}
  records={}
  for kind in LABELS:
   records[kind]=[{**json.loads(r['payload']),'_mall_id':r['mall_id'],'_key':r['item_key'],'_captured':r['captured']} for index,r in enumerate(current_records(db,kind,mall)) if index<200]
  records['flow']=[display_flow(db,r) for r in records['flow']]
  records['daily']=[display_daily(r) for r in records['daily']]
  receipts=[json.loads(r['payload']) for r in db.execute('SELECT payload FROM collector_receipts ORDER BY observed_at DESC LIMIT 100')]
  if mall:receipts=[r for r in receipts if r['mall_id']==mall]
 return {'diagnostic':diagnostic,'shops':shops,'counts':counts,'records':records,'receipts':receipts,'source':'Temu 数据采集助手','record_limit':200}


def flow_history(connect,mall='',day=''):
 if not re.fullmatch(r'\d{1,40}',mall):raise ValueError('请选择店铺')
 if day and not re.fullmatch(r'\d{4}-\d{2}-\d{2}',day):raise ValueError('日期格式无效')
 with connect() as db:
  where="source_path='/api/client/flow-overviews' AND CAST(json_extract(body,'$.mall_id') AS TEXT)=?"
  dates=[r[0] for r in db.execute("SELECT DISTINCT date(observed_at,'+8 hours') FROM collector_payloads WHERE "+where+" ORDER BY 1 DESC",(mall,))]
  chosen=day or (dates[0] if dates else '')
  entries=[]
  for r in db.execute("SELECT id,observed_at,body FROM collector_payloads WHERE "+where+" AND date(observed_at,'+8 hours')=? ORDER BY observed_at DESC,id",(mall,chosen)):
   body=json.loads(r['body'])
   entries.append({'id':r['id']+'@'+r['observed_at'],'captured':r['observed_at'],'records':[{**item,'_mall_id':mall,'_captured':r['observed_at']} for item in body.get('items',[])]})
 return {'day':chosen,'dates':dates,'snapshots':entries,'timezone':'Asia/Shanghai'}

def display_daily(row):
 result=dict(row)
 orders=dict(result.get('orders') or {})
 visible=orders.get('cancelled_visible_count')
 if isinstance(visible,(int,float)) and not isinstance(visible,bool) and visible>=0:
  original=orders.get('cancelled_count')
  if original!=visible:orders['cancelled_pool_count']=original
  orders['cancelled_count']=visible
  orders['cancelled_recent_count']=visible
 cancelled=[]
 for item in orders.get('cancelled_orders') or []:
  if isinstance(item,dict) and re.search(r'已取消|取消成功|cancelled|canceled',str(item.get('status','')),re.I):cancelled.append(item)
 orders['cancelled_orders']=cancelled
 result['orders']=orders
 consultations=dict(result.get('consultations') or {})
 if consultations.get('status')!='finished' or consultations.get('page_recognized') is not True:
  consultations['has_unreplied']=None
  consultations['unreplied_count']=None
 result['consultations']=consultations
 steps=[]
 for item in result.get('steps') or []:
  step=dict(item) if isinstance(item,dict) else item
  if isinstance(step,dict) and step.get('id')=='cancelled':step['message']=f"近30日检测到 {orders.get('cancelled_count',0)} 个已取消订单"
  if isinstance(step,dict) and step.get('id')=='exceptions':step['message']=f"检测到 {orders.get('logistics_exception_count',0)} 个物流异常订单"
  steps.append(step)
 result['steps']=steps
 return result

def daily_audits(connect,mall=''):
 if mall and not re.fullmatch(r'\d{1,40}',mall):raise ValueError('请选择有效店铺')
 where="dataset='daily'";params=[]
 if mall:where+=' AND mall_id=?';params.append(mall)
 with connect() as db:
  rows=[]
  for record in db.execute('SELECT mall_id,payload,captured FROM collector_records WHERE '+where+' ORDER BY captured DESC LIMIT 45',params):
   payload=json.loads(record['payload'])
   rows.append(display_daily({**payload,'_mall_id':record['mall_id'],'_captured':record['captured']}))
  shops={r['mall_id']:r['name'] for r in db.execute('SELECT mall_id,name FROM collector_shops')}
 return {'records':rows,'latest':rows[0] if rows else None,'shops':shops,'timezone':'Asia/Shanghai'}
