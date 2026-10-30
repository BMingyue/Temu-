"""Local-only Temu operations data service. No credentials or merchant writes."""
from __future__ import annotations
import csv, io, json, math, os, re, sqlite3, subprocess, sys, threading, uuid, secrets
import merchant
import collector
import operations
import sync_audit
import collector_control
import image_jobs
import image_workflows
import image_source_edits
import gpt_runner
import gpt_extension_bridge
import gpt_browser_profiles
import activity_jobs
import activity_enrollment
import price_window
import feature_tools
import product_operations
import patrol_health
import patrol_traffic
import product_rules
from workbench_version import health_identity
from datetime import date, datetime, timedelta
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs
from contextlib import contextmanager

ROOT = Path(__file__).resolve().parent
DATA = Path(os.environ.get('TEMU_WORKBENCH_DATA', ROOT / 'data'))
PORT = int(os.environ.get('TEMU_WORKBENCH_PORT', '18769'))
INSTANCE_ID = uuid.uuid4().hex
RESTART_LOCK = threading.Lock()
RESTART_PENDING = False
FIELDS = {
 'date':'日期', 'product_id':'商品ID', 'title':'商品标题', 'category':'品类',
 'impressions':'曝光次数', 'clicks':'点击次数', 'orders':'订单数', 'units':'销售件数',
 'settlement':'结算收入', 'goods_cost':'商品成本合计', 'fulfillment':'履约成本合计',
 'ads':'广告费', 'refund_loss':'退款损失', 'other_cost':'其他成本合计',
}
ALIASES = {
 'date':['统计日期','数据日期','日期','date'], 'product_id':['商品ID','SKU ID','SKU ID编码','SKUID','SKU','SPUID','SPU ID','product_id'],
 'title':['商品名称','商品标题','标题','title'], 'category':['品类','category'],
 'impressions':['曝光次数','曝光量','impressions'], 'clicks':['点击次数','点击量','clicks'],
 'orders':['订单数','支付订单数','子订单数','orders'], 'units':['销售件数','销量','units'],
 'settlement':['结算收入','settlement'], 'goods_cost':['商品成本合计','goods_cost'],
 'fulfillment':['履约成本合计','fulfillment'], 'ads':['广告费','广告费用','ads'],
 'refund_loss':['退款损失','refund_loss'], 'other_cost':['其他成本合计','other_cost'],
}
NUMBERS = list(FIELDS)[4:]
COUNTS = ['impressions','clicks','orders','units']
DEFAULT_RULES = {'min_impressions':1000, 'min_clicks':30, 'ctr':1.0, 'order_ratio':2.0}
QUALIFICATION_ROOT=ROOT / 'local_tools' / 'qualification'
COMPONENTS=json.loads((ROOT/'workbench-components.json').read_text(encoding='utf-8-sig'))
UPLOADER_VERSION=COMPONENTS['uploader']['version']
if not isinstance(UPLOADER_VERSION,str) or not re.fullmatch(r'\d+\.\d+\.\d+',UPLOADER_VERSION):
 raise ValueError('工作台店小秘组件版本清单无效')
TOOLS = {
 'qualification': (ROOT / 'local_tools/qualification', 'launch.py', Path(sys.executable)),
 'compliance_confirmation': (ROOT / 'local_tools/compliance-confirmation', 'launch.py', Path(sys.executable)),
 'long_path_mover': (ROOT / 'local_tools/long-path-mover', 'launch.py', Path(sys.executable)),
 'gpt_extension_folder': (ROOT / 'local_tools/gpt-extension-folder', 'launch.py', Path(sys.executable)),
 'lion_scraper_chrome': (ROOT / 'local_tools/lion-scraper-extension', 'launch_chrome.py', Path(sys.executable)),
 'lion_scraper_edge': (ROOT / 'local_tools/lion-scraper-extension', 'launch_edge.py', Path(sys.executable)),
 'collector': (ROOT / 'local_tools/image-collector', 'app.py', Path(sys.executable)),
 'uploader': (ROOT / 'local_tools/dxm-uploader', '店小秘自动上架.exe', None),
}
launches = {}
launch_lock = threading.Lock()


def tool_status(key):
 folder,script,python=TOOLS[key]
 available=(folder/script).is_file() and (python is None or python.is_file())
 info={'available':available,'path':str(folder)}
 if key=='collector' and not available:
  info['message']='此版本未附带旧图片采集器，请使用维护板块的统一采集入口'
 if key=='uploader':
  try:
   manifest=json.loads((folder/'版本信息.json').read_text(encoding='utf-8-sig'))
   version=str(manifest.get('version') or '')
  except (OSError,ValueError,AttributeError):version=''
  info.update(version=version or '未知',bundled=True,required_version=UPLOADER_VERSION)
  if not available:
   info['message']='店小秘工具文件不完整，请重新解压完整的工作台文件夹'
  elif version!=UPLOADER_VERSION:
   info['available']=False
   info['message']=f'店小秘版本不匹配，请使用随工作台提供的 {UPLOADER_VERSION} 完整版'
 return info


class BoundedThreadingHTTPServer(ThreadingHTTPServer):
 """Keep browser polling from exhausting the Windows thread limit.

 The workbench UI and the three browser extensions poll the local service.  A
 plain ThreadingHTTPServer creates one unbounded thread per accepted socket;
 if clients leave enough half-open requests behind, thread creation raises a
 RuntimeError and terminates serve_forever.  Bound concurrent handlers and
 return a short 503 while saturated so the next poll can recover naturally.
 """
 daemon_threads = True
 block_on_close = False
 request_queue_size = 128

 def __init__(self, server_address, request_handler_class, max_workers=48):
  self.worker_slots = threading.BoundedSemaphore(max_workers)
  super().__init__(server_address, request_handler_class)

 def process_request(self, request, client_address):
  request.settimeout(20)
  if not self.worker_slots.acquire(blocking=False):
   try:
    body = json.dumps({'error':'本地数据服务繁忙，请稍后重试'},ensure_ascii=False).encode()
    request.sendall(
     b'HTTP/1.0 503 Service Unavailable\r\n'
     b'Content-Type: application/json; charset=utf-8\r\n'
     b'Cache-Control: no-store\r\n'
     b'Connection: close\r\n'
     + f'Content-Length: {len(body)}\r\n\r\n'.encode() + body
    )
   except OSError:
    pass
   finally:
    self.shutdown_request(request)
   return
  try:
   super().process_request(request, client_address)
  except RuntimeError:
   # If Windows temporarily refuses a new thread, serve this one request on
   # the accept loop instead of letting the whole backend exit.
   try:
    self.finish_request(request, client_address)
   except Exception:
    self.handle_error(request, client_address)
   finally:
    self.shutdown_request(request)
    self.worker_slots.release()

 def process_request_thread(self, request, client_address):
  try:
   super().process_request_thread(request, client_address)
  finally:
   self.worker_slots.release()

@contextmanager
def connect():
 DATA.mkdir(parents=True, exist_ok=True)
 db = sqlite3.connect(DATA / 'workbench.sqlite3', timeout=20)
 db.row_factory = sqlite3.Row
 db.execute('PRAGMA journal_mode=WAL')
 try:
  with db:
   yield db
 finally:
  db.close()

def init():
 with connect() as db:
  db.executescript('''
  CREATE TABLE IF NOT EXISTS facts (
   shop TEXT NOT NULL, site TEXT NOT NULL, currency TEXT NOT NULL, level TEXT NOT NULL,
   date TEXT NOT NULL, product_id TEXT NOT NULL, payload TEXT NOT NULL, batch_id TEXT NOT NULL,
   PRIMARY KEY(shop,site,currency,level,date,product_id));
  CREATE TABLE IF NOT EXISTS batches(id TEXT PRIMARY KEY, created TEXT NOT NULL, name TEXT NOT NULL, rows INTEGER NOT NULL, context TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS entries(id TEXT PRIMARY KEY, kind TEXT NOT NULL, created TEXT NOT NULL, payload TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS catalog(shop TEXT NOT NULL,site TEXT NOT NULL,spu TEXT NOT NULL,payload TEXT NOT NULL,captured TEXT NOT NULL,PRIMARY KEY(shop,site,spu));
  CREATE TABLE IF NOT EXISTS collections(id TEXT PRIMARY KEY,created TEXT NOT NULL,payload TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS traffic(shop TEXT,site TEXT,day TEXT,spu TEXT,payload TEXT,captured TEXT,PRIMARY KEY(shop,site,day,spu));
  CREATE TABLE IF NOT EXISTS traffic_captures(id TEXT PRIMARY KEY,captured TEXT,payload TEXT);
  ''')
  collector.init(db)
  patrol_health.init(db)
  operations.init(db)
  activity_jobs.init(db)
  activity_enrollment.init(db)
 token_file=DATA/'bridge-token'
 if not token_file.exists(): token_file.write_text(secrets.token_urlsafe(32),encoding='utf-8')
 extension=ROOT/'gpt_chrome_extension';extension.mkdir(exist_ok=True)
 # Extension 0.3.35+ pairs with the local service on first use.  Never write a
 # machine-specific bearer token into the distributable extension source.
 if DATA.resolve()==(ROOT/'data').resolve(): (extension/'config.js').write_text('globalThis.WORKBENCH_TOKEN="";\n',encoding='utf-8')

def clean(value):
 return str(value if value is not None else '').strip()

def numeric(value, field):
 value = clean(value)
 if value.lower() in ('','--','—','-','n/a','null','none'): return None
 # Keep interpretation explicit: no K/W rounding, percentages, or currency conversion.
 try: n = float(value.replace(',',''))
 except ValueError: raise ValueError(f'{FIELDS[field]}不是数字：{value[:40]}')
 if not math.isfinite(n): raise ValueError(f'{FIELDS[field]}必须为有限数字')
 if field in COUNTS and (n < 0 or n != int(n)): raise ValueError(f'{FIELDS[field]}必须为非负整数')
 return n

def parse_csv(text):
 if len(text) > 12_000_000: raise ValueError('文件过大，请按店铺或月份拆分到 12MB 以内')
 reader = csv.DictReader(io.StringIO(text.lstrip('\ufeff')))
 headers = reader.fieldnames or []
 if not headers or len(headers)!=len(set(headers)): raise ValueError('表头为空或有重名列，请整理后导入')
 rows = list(reader)
 if not rows: raise ValueError('表格没有数据行')
 if len(rows)>30000: raise ValueError('单次最多导入 30000 行')
 if any(None in row for row in rows): raise ValueError('部分行比表头多列，请检查逗号和引号')
 return headers, rows

def guess(headers):
 norm = lambda x: re.sub(r'\s+','',x).lower()
 return {key:next((h for h in headers if norm(h) in [norm(a) for a in names]),'') for key,names in ALIASES.items()}

def normalize(body):
 headers, raw = parse_csv(body.get('text',''))
 mapping = body.get('mapping') or guess(headers)
 context = body.get('context',{})
 for key in ['shop','site','currency','level']:
  if not clean(context.get(key)): raise ValueError('请填写店铺、站点、币种和商品层级')
 if context['level'] not in ['SKU','SPU']: raise ValueError('商品层级只能为 SKU 或 SPU')
 if not re.fullmatch('[A-Z]{3}',context['currency']): raise ValueError('币种请填写三位大写代码，例如 USD 或 CNY')
 if not mapping.get('product_id'): raise ValueError('请指定商品ID列')
 if not mapping.get('date') and not context.get('date'): raise ValueError('请指定日期列或填写单日日期；区间合计不能当成日数据')
 used = [v for v in mapping.values() if v]
 if len(used) != len(set(used)): raise ValueError('一列不能重复映射到多个字段')
 if any(v not in headers for v in used): raise ValueError('映射列不在当前文件中')
 if not any(mapping.get(k) for k in NUMBERS): raise ValueError('请至少指定一列经营指标')
 result, errors, seen = [], [], set()
 for i,row in enumerate(raw,2):
  if all(not clean(x) for x in row.values()): continue
  try:
   get = lambda k: clean(row.get(mapping.get(k,'')))
   pid=get('product_id')
   if not pid or re.search(r'\d[eE][+-]?\d',pid): raise ValueError('商品ID为空或为科学计数法，请保留文本格式')
   day=get('date') or context.get('date','')
   day=date.fromisoformat(day.replace('/','-')).isoformat()
   if day>date.today().isoformat(): raise ValueError('日期在未来')
   key=(day,pid)
   if key in seen: raise ValueError('同一天同一商品出现多行，请先汇总或选择正确的 SKU/SPU 层级')
   seen.add(key)
   item={k:clean(context[k]) for k in ['shop','site','currency','level']}
   item.update(date=day, product_id=pid, title=get('title'), category=get('category'))
   item.update({k:numeric(get(k),k) for k in NUMBERS})
   result.append(item)
  except (ValueError,TypeError) as e: errors.append({'row':i,'reason':str(e)})
 return headers,result,errors

def import_rows(body):
 _,rows,errors=normalize(body)
 if errors: raise ValueError(f'有 {len(errors)} 行待修正，未写入任何数据。第 {errors[0]["row"]} 行：{errors[0]["reason"]}')
 if not rows: raise ValueError('没有可导入的行')
 batch=uuid.uuid4().hex
 with connect() as db:
  existing=0
  for row in rows:
   key=tuple(row[k] for k in ['shop','site','currency','level','date','product_id'])
   old=db.execute('SELECT payload FROM facts WHERE shop=? AND site=? AND currency=? AND level=? AND date=? AND product_id=?',key).fetchone()
   if old:
    existing+=1
    # Independently exported traffic and costs merge; blanks never erase known values.
    merged=json.loads(old['payload']); merged.update({k:v for k,v in row.items() if v is not None and v!=''})
    row=merged
   db.execute('INSERT OR REPLACE INTO facts VALUES (?,?,?,?,?,?,?,?)',(*key,json.dumps(row,ensure_ascii=False),batch))
  db.execute('INSERT INTO batches VALUES (?,?,?,?,?)',(batch,datetime.now().isoformat(timespec='seconds'),clean(body.get('name','导入文件'))[:200],len(rows),json.dumps(body.get('context',{}),ensure_ascii=False)))
 return {'rows':len(rows),'updated':existing,'added':len(rows)-existing,'batch_id':batch}

def rules(db):
 row=db.execute("SELECT value FROM settings WHERE key='rules'").fetchone()
 return json.loads(row['value']) if row else DEFAULT_RULES.copy()

def diagnose(row,rule):
 imp, clicks, orders = (row.get(k) for k in ['impressions','clicks','orders'])
 profit_fields=['settlement','goods_cost','fulfillment','ads','refund_loss','other_cost']
 row['contribution']=round(row['settlement']-sum(row[k] for k in profit_fields[1:]),2) if all(row.get(k) is not None for k in profit_fields) else None
 row['ctr']=clicks/imp*100 if imp and clicks is not None else None
 row['order_ratio']=orders/clicks*100 if clicks and orders is not None else None
 if row['contribution'] is not None and row['contribution']<0:
  reason,action='贡献亏损','先核对结算、履约与广告成本，再评估价格或活动'
 elif imp is None or clicks is None or orders is None:
  reason,action='数据待补','补齐曝光、点击与订单；暂不判断款式潜力'
 elif imp<rule['min_impressions']:
  reason,action='曝光样本不足','检查在售、库存和活动资格；继续积累样本'
 elif row['ctr'] is not None and row['ctr']<rule['ctr']:
  reason,action='点击偏低','优先安排主图对照测试，记录改图日期'
 elif clicks<rule['min_clicks']:
  reason,action='点击样本不足','继续观察，暂不因低订单淘汰款式'
 elif row['order_ratio'] is not None and row['order_ratio']<rule['order_ratio']:
  reason,action='下单偏低','检查价格、尺寸说明、交付时效与评价'
 else:
  reason,action='继续观察','核对贡献与库存后，考虑扩展同主题印花'
 row.update(reason=reason,action=action)
 return row

def snapshot(query):
 with connect() as db:
  all_rows=[json.loads(r['payload']) for r in db.execute('SELECT payload FROM facts')]
  cfg=rules(db)
  entries=[dict(r) for r in db.execute('SELECT * FROM entries ORDER BY created DESC')]
  batches=[dict(r) for r in db.execute('SELECT * FROM batches ORDER BY created DESC LIMIT 30')]
  catalog=[{**json.loads(r['payload']),'shop':r['shop'],'site':r['site'],'captured':r['captured']} for r in db.execute('SELECT * FROM catalog ORDER BY captured DESC,spu')]
  collections=[{**json.loads(r['payload']),'created':r['created']} for r in db.execute('SELECT * FROM collections ORDER BY created DESC LIMIT 20')]
  traffic=[json.loads(r['payload']) for r in db.execute('SELECT payload FROM traffic ORDER BY day DESC,spu')]
  traffic_captures=[json.loads(r['payload']) for r in db.execute('SELECT payload FROM traffic_captures ORDER BY captured DESC LIMIT 100')]
  for row in traffic: diagnose(row,cfg)
 for e in entries: e['payload']=json.loads(e['payload'])
 selected=[r for r in all_rows if all(not query.get(k) or r[k]==query[k] for k in ['shop','site','currency','level']) and (not query.get('start') or r['date']>=query['start']) and (not query.get('end') or r['date']<=query['end'])]
 groups={}
 for row in selected:
  key=tuple(row[k] for k in ['shop','site','currency','level','product_id'])
  groups.setdefault(key,[]).append(row)
 products=[]
 for rows in groups.values():
  row=max(rows,key=lambda x:x['date']).copy()
  for key in NUMBERS: row[key]=sum(r[key] for r in rows) if all(r.get(key) is not None for r in rows) else None
  row['days']=len(rows)
  products.append(diagnose(row,cfg))
 products.sort(key=lambda r:(r['reason']!='贡献亏损',r['reason']=='继续观察',-(r.get('orders') or 0)))
 coverage={}
 for r in selected: coverage.setdefault(r['date'],0); coverage[r['date']]+=1
 scopes=sorted({(r['shop'],r['site'],r['currency'],r['level']) for r in all_rows})
 return {'traffic':traffic,'traffic_captures':traffic_captures,'products':products,'scopes':[dict(zip(['shop','site','currency','level'],x)) for x in scopes], 'catalog':catalog,'collections':collections,'coverage':coverage,'batches':batches,'entries':entries,'rules':cfg,'fact_count':len(all_rows),'tools':{k:tool_status(k) for k in TOOLS}}

def ingest_catalog(body):
 if body.get('source_url')!='https://agentseller.temu.com/newon/product-select': raise ValueError('仅接受已核对的上新生命周期页面来源')
 for key in ['shop','site','scope','observed_at']:
  if not clean(body.get(key)): raise ValueError('采集元信息不完整：'+key)
 datetime.fromisoformat(body['observed_at'])
 rows=body.get('products',[])
 if not isinstance(rows,list) or not rows or len(rows)>2000: raise ValueError('商品记录为空或过多')
 ids=set()
 for row in rows:
  if not isinstance(row,dict) or not re.fullmatch(r'\d+',clean(row.get('spu'))) or not clean(row.get('title')): raise ValueError('商品ID或标题无效')
  if row['spu'] in ids: raise ValueError('采集包含重复SPU')
  ids.add(row['spu'])
  if not isinstance(row.get('variants'),list): raise ValueError('SKU列表格式错误')
  skus=set()
  for v in row['variants']:
   sku=clean(v.get('sku'))
   if not re.fullmatch(r'\d+',sku) or sku in skus: raise ValueError('SKU格式错误或重复')
   skus.add(sku)
 total=body.get('displayed_total')
 if total is not None and (not isinstance(total,int) or total<len(rows)): raise ValueError('页面总数小于采集数')
 # Only a page capture has been observed: never infer full-store completion.
 receipt={k:body[k] for k in ['shop','site','source_url','scope','observed_at']}
 receipt.update(received=len(rows),displayed_total=total,status='partial',message=clean(body.get('message')) or '当前页面部分记录，尚未确认全量采齐')
 timestamp=datetime.now().isoformat(timespec='seconds')
 with connect() as db:
  for row in rows:
   old=db.execute('SELECT captured FROM catalog WHERE shop=? AND site=? AND spu=?',(body['shop'],body['site'],row['spu'])).fetchone()
   if old and old['captured']>body['observed_at']: raise ValueError('旧快照不能覆盖较新的商品状态')
   db.execute('INSERT OR REPLACE INTO catalog VALUES(?,?,?,?,?)',(body['shop'],body['site'],row['spu'],json.dumps(row,ensure_ascii=False),body['observed_at']))
  db.execute('INSERT INTO collections VALUES(?,?,?)',(uuid.uuid4().hex,timestamp,json.dumps(receipt,ensure_ascii=False)))
 return receipt

def save_entry(body):
 kind=body.get('kind')
 if kind not in ['opportunity','review','image_task']: raise ValueError('未知记录类型')
 payload=body.get('payload',{})
 if not isinstance(payload,dict) or not clean(payload.get('title')): raise ValueError('请填写标题')
 if len(json.dumps(payload))>40000: raise ValueError('记录内容过长')
 eid=body.get('id') or uuid.uuid4().hex
 with connect() as db:
  db.execute('INSERT INTO entries VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload',(eid,kind,datetime.now().isoformat(timespec='seconds'),json.dumps(payload,ensure_ascii=False)))
 return {'id':eid}

def launch_tool(key):
 if key not in TOOLS: raise ValueError('未知工具')
 folder,script,python=TOOLS[key]
 info=tool_status(key)
 if not info['available']:raise ValueError(info.get('message') or '工具或运行环境路径不存在')
 if not (folder/script).is_file() or (python is not None and not python.is_file()): raise ValueError('工具或运行环境路径不存在')
 with launch_lock:
  proc=launches.get(key)
  if proc and proc.poll() is None: return {'message':'该工具已由工作台启动，请切换到工具窗口'}
  DATA.mkdir(parents=True,exist_ok=True)
  log=open(DATA / f'{key}-launch.log','ab')
  env=os.environ.copy()
  # GUI tools must use their own Python/Tcl runtime, not inherited app settings.
  for name in ('TCL_LIBRARY','TK_LIBRARY','PYTHONHOME','PYTHONPATH'):env.pop(name,None)
  try:
   command=([str(python)] if python is not None else [])+[str(folder/script)]
   launches[key]=subprocess.Popen(command,cwd=folder,env=env,stdout=log,stderr=log,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
   try:
    code=launches[key].wait(timeout=1.5)
    if code!=0:raise ValueError(f'工具启动失败（退出码 {code}），请查看 {key}-launch.log')
   except subprocess.TimeoutExpired:pass
  finally: log.close()
 if key.startswith('lion_scraper_'):
  return {'message':'已打开主扩展文件夹和浏览器扩展管理页。首次使用请选择“加载已解压的扩展程序”；已有扩展请点击重新加载。'}
 return {'message':f'已打开店小秘上架 {info["version"]}，请在工具中核对脚本、图片处理和商品后开始任务' if key=='uploader' else '已打开工具窗口，请在原工具中选择参数并开始任务'}

class Handler(BaseHTTPRequestHandler):
 # Bound how long a broken/half-open browser request can occupy a worker.
 timeout=30
 protocol_version='HTTP/1.0'
 def bridge_origin(self):
  origin=self.headers.get('Origin','')
  return re.fullmatch(r'(?:chrome-extension://[a-p]{32}|moz-extension://[0-9a-f-]{36})',origin,re.I) is not None
 def bridge_allowed(self):
  origin=self.headers.get('Origin','')
  token=(DATA/'bridge-token').read_text(encoding='utf-8')
  return self.headers.get('Host','').split(':')[0] in ['127.0.0.1','localhost'] and (not origin or self.bridge_origin()) and secrets.compare_digest(self.headers.get('Authorization',''),'Bearer '+token)
 def bridge_bootstrap_allowed(self):
  # Pairing is intentionally limited to an installed browser extension on the
  # same computer. Normal web pages, remote hosts, and origin-less requests are
  # rejected even though the service itself listens on loopback only.
  return self.headers.get('Host','').split(':')[0] in ['127.0.0.1','localhost'] and self.bridge_origin()
 def end_headers(self):
  if self.path=='/api/bridge/price-window' and self.bridge_origin():
   self.send_header('Access-Control-Allow-Origin',self.headers['Origin'])
   self.send_header('Vary','Origin')
  if self.path in ['/api/bridge/capture','/api/bridge/collector','/api/bridge/activity-evidence','/api/bridge/coverage','/api/bridge/gpt/bootstrap','/api/bridge/gpt/heartbeat','/api/bridge/gpt/claim','/api/bridge/gpt/update','/api/bridge/gpt/watchdog','/api/bridge/collector-control','/api/bridge/activity-enrollment'] and self.bridge_origin():
   self.send_header('Access-Control-Allow-Origin',self.headers['Origin'])
   self.send_header('Vary','Origin')
  super().end_headers()
 def do_OPTIONS(self):
  if self.path=='/api/bridge/price-window' and self.bridge_origin() and self.headers.get('Host','').split(':')[0] in ['127.0.0.1','localhost']:
   self.send_response(204)
   self.send_header('Access-Control-Allow-Methods','POST')
   self.send_header('Access-Control-Allow-Headers','Authorization, Content-Type')
   return self.end_headers()
  if self.path not in ['/api/bridge/capture','/api/bridge/collector','/api/bridge/activity-evidence','/api/bridge/coverage','/api/bridge/gpt/bootstrap','/api/bridge/gpt/heartbeat','/api/bridge/gpt/claim','/api/bridge/gpt/update','/api/bridge/gpt/watchdog','/api/bridge/collector-control','/api/bridge/activity-enrollment'] or not self.bridge_origin() or self.headers.get('Host','').split(':')[0] not in ['127.0.0.1','localhost']: return self.reply({'error':'来源不受支持'},403)
  self.send_response(204)
  self.send_header('Access-Control-Allow-Methods','POST')
  self.send_header('Access-Control-Allow-Headers','Authorization, Content-Type')
  self.end_headers()
 def log_message(self,*args): pass
 def reply(self,value,status=200):
  data=json.dumps(value,ensure_ascii=False,allow_nan=False).encode()
  try:
   self.send_response(status); self.send_header('Content-Type','application/json; charset=utf-8'); self.send_header('Cache-Control','no-store'); self.send_header('Connection','close'); self.send_header('Content-Length',str(len(data))); self.end_headers(); self.wfile.write(data); self.close_connection=True
  except (BrokenPipeError,ConnectionResetError,ConnectionAbortedError):
   # Page navigation can cancel polling after the database operation committed.
   # Upload retries remain safe through the stored batch ID.
   self.close_connection=True
 def allowed(self):
  host=self.headers.get('Host','').split(':')[0]
  if host not in ['127.0.0.1','localhost']: return False
  origin=self.headers.get('Origin')
  return not origin or origin in ['http://127.0.0.1:5173','http://localhost:5173',f'http://127.0.0.1:{PORT}']
 def do_GET(self):
  try:return self._do_GET()
  except (BrokenPipeError,ConnectionResetError,ConnectionAbortedError):
   self.close_connection=True
  except Exception as error:
   return self.reply({'error':'本地读取失败：'+str(error)},500)
 def _do_GET(self):
  if not self.allowed(): return self.reply({'error':'仅允许本机工作台访问'},403)
  url=urlparse(self.path)
  if url.path=='/api/qualification-status':
   p=QUALIFICATION_ROOT/'logs/status.json'
   try: status=json.loads(p.read_text(encoding='utf-8')) if p.exists() else {}
   except (OSError,ValueError): status={}
   try:
    match=re.search(r'版本[：:]\s*([0-9.]+)',(QUALIFICATION_ROOT/'README.txt').read_text(encoding='utf-8'));version=match.group(1) if match else '未知'
   except OSError:version='未知'
   return self.reply({'version':version,'available':(QUALIFICATION_ROOT/'runtime/node.exe').is_file() and (QUALIFICATION_ROOT/'temu-local-uploader.js').is_file(),'status':status})
  if url.path=='/api/compliance-confirmation-status':
   p=QUALIFICATION_ROOT/'logs/compliance-status.json'
   try: status=json.loads(p.read_text(encoding='utf-8')) if p.exists() else {}
   except (OSError,ValueError): status={}
   try:
    match=re.search(r"version:\s*'([0-9.]+)'",(QUALIFICATION_ROOT/'temu-local-uploader.js').read_text(encoding='utf-8'));version=match.group(1) if match else '未知'
   except OSError:version='未知'
   return self.reply({'version':version,'available':(QUALIFICATION_ROOT/'runtime/node.exe').is_file() and (QUALIFICATION_ROOT/'temu-local-uploader.js').is_file(),'status':status})
  if url.path=='/api/health': return self.reply({'ok':True,'service':'temu-workbench','instance_id':INSTANCE_ID,**health_identity()})
  if url.path=='/api/colleague-browser':
   import colleague_browser
   return self.reply(colleague_browser.status(DATA))
  if url.path=='/api/image-jobs':
   jobs=image_jobs.list_jobs(DATA)
   compact=parse_qs(url.query).get('compact',['0'])[0]=='1'
   return self.reply({'jobs':image_jobs.list_job_summaries(DATA,jobs) if compact else jobs,'summary':image_jobs.summary(DATA,jobs)})
  match=re.fullmatch(r'/api/image-jobs/([a-f0-9]{32})',url.path)
  if match:return self.reply({'job':image_jobs.get_job(DATA,match.group(1))})
  match=re.fullmatch(r'/api/image-jobs/([a-f0-9]{32})/outputs/([1-9][0-9]{0,2})',url.path)
  if match:
   try:raw,mime=image_jobs.output_image(DATA,match.group(1),int(match.group(2)),parse_qs(url.query).get('thumbnail',['0'])[0]=='1')
   except (ValueError,OSError):return self.reply({'error':'成图不存在、已搬迁或校验失败'},404)
   self.send_response(200);self.send_header('Content-Type',mime);self.send_header('X-Content-Type-Options','nosniff');self.send_header('Cache-Control','private, max-age=3600');self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)
   return
  if url.path=='/api/image-jobs/summary': return self.reply(image_jobs.summary(DATA))
  if url.path=='/api/image-jobs/config': return self.reply(image_jobs.config(DATA))
  if url.path=='/api/image-jobs/workflow-presets': return self.reply(image_workflows.catalog(DATA))
  if url.path=='/api/image-jobs/source-edit-presets': return self.reply(image_source_edits.catalog())
  if url.path=='/api/image-jobs/prompt': return self.reply(image_jobs.prompt_settings(DATA))
  if url.path=='/api/image-runner': return self.reply(gpt_runner.get_runner(DATA).snapshot())
  if url.path=='/api/gpt-extension':
   state=gpt_extension_bridge.snapshot(DATA)
   state['browser_profiles']=gpt_browser_profiles.catalog(DATA)
   state['browser_creation']=gpt_browser_profiles.creation_status()
   return self.reply(state)
  if url.path=='/api/state': return self.reply(snapshot({k:v[0] for k,v in parse_qs(url.query).items()}))
  if url.path=='/api/collector/control': return self.reply(collector_control.read(DATA))
  if url.path=='/api/patrol/traffic-compare':
   q=parse_qs(url.query)
   try:return self.reply(patrol_traffic.compare(connect,q.get('mall_id',[''])[0],','.join(q.get('dates',[])).split(','),q.get('at',[''])[0]))
   except ValueError as e:return self.reply({'error':str(e)},400)
  if url.path=='/api/collector/flow-history':
   q=parse_qs(url.query)
   try:return self.reply(collector.flow_history(connect,q.get('mall_id',[''])[0],q.get('day',[''])[0]))
   except ValueError as e:return self.reply({'error':str(e)},400)
  if url.path=='/api/collector/daily-audit':
   try:return self.reply(collector.daily_audits(connect,parse_qs(url.query).get('mall_id',[''])[0]))
   except ValueError as e:return self.reply({'error':str(e)},400)
  if url.path=='/api/collector/state': return self.reply(collector.snapshot(connect,parse_qs(url.query).get('mall_id',[''])[0]))
  if url.path in ['/api/patrol/health','/api/patrol/state']:
   try:return self.reply(patrol_health.snapshot(connect,parse_qs(url.query).get('mall_id',[''])[0]))
   except ValueError as e:return self.reply({'error':str(e)},400)
  if url.path=='/api/features/product-status':
   try:return self.reply(product_operations.state(connect,parse_qs(url.query).get('mall_id',[''])[0]))
   except ValueError as e:return self.reply({'error':str(e)},400)
  if url.path=='/api/features/product-status/accelerator-targets':
   try:return self.reply(product_operations.accelerator_targets(connect,parse_qs(url.query).get('mall_id',[''])[0]))
   except ValueError as e:return self.reply({'error':str(e)},400)
  if url.path=='/api/features/catalog':
   query=parse_qs(url.query)
   try:return self.reply(feature_tools.catalog(connect,query.get('mall_id',[''])[0]))
   except ValueError as e:return self.reply({'error':str(e)},400)
  if url.path=='/api/features/zero-sales':
   query=parse_qs(url.query)
   try:return self.reply(feature_tools.zero_sales(connect,query.get('mall_id',[''])[0],query.get('first_start',[''])[0],query.get('first_end',[''])[0],query.get('order_start',[''])[0],query.get('order_end',[''])[0]))
   except ValueError as e:return self.reply({'error':str(e)},400)
  if url.path=='/api/features/promotion-audit':
   query=parse_qs(url.query)
   try:return self.reply(feature_tools.promotion_audit(connect,query.get('mall_id',[''])[0]))
   except ValueError as e:return self.reply({'error':str(e)},400)
  if url.path=='/api/activity-jobs/state':
   query=parse_qs(url.query)
   return self.reply(activity_jobs.job_snapshot(connect,query.get('job_id',[''])[0],query.get('mall_id',[''])[0]))
  if url.path=='/api/activity-enrollment/state':
   return self.reply(activity_enrollment.snapshot(connect,parse_qs(url.query).get('mall_id',[''])[0]))
  if url.path=='/api/daily': return self.reply(operations.snapshot(connect))
  if url.path=='/api/sync-audit': return self.reply({'items':sync_audit.snapshot(connect,parse_qs(url.query).get('mall_id',[''])[0])})
  return self.reply({'error':'未知入口'},404)
 def do_POST(self):
  bootstrap=self.path=='/api/bridge/gpt/bootstrap'
  bridge=self.path in ['/api/bridge/capture','/api/bridge/collector','/api/bridge/activity-evidence','/api/bridge/coverage','/api/bridge/gpt/heartbeat','/api/bridge/gpt/claim','/api/bridge/gpt/update','/api/bridge/gpt/watchdog','/api/bridge/collector-control','/api/bridge/activity-enrollment']
  if bootstrap:
   if not self.bridge_bootstrap_allowed(): return self.reply({'error':'仅允许本机浏览器扩展完成首次配对'},403)
  elif bridge or self.path=='/api/bridge/price-window':
   if not self.bridge_allowed(): return self.reply({'error':'扩展连接凭据或来源不匹配'},403)
  elif not self.allowed() or self.headers.get('X-Workbench')!='local': return self.reply({'error':'仅允许本机工作台操作'},403)
  try:
   size=int(self.headers.get('Content-Length','0'))
   if size>16_000_000: raise ValueError('请求过大')
   body=json.loads(self.rfile.read(size))
   if bootstrap:
    return self.reply({'ok':True,'token':(DATA/'bridge-token').read_text(encoding='utf-8'),'service':'temu-workbench','extension_version':gpt_extension_bridge.EXTENSION_VERSION})
   if self.path=='/api/bridge/activity-enrollment': return self.reply(activity_enrollment.bridge(body,connect))
   if self.path=='/api/colleague-browser/open':
    import colleague_browser
    return self.reply(colleague_browser.open_browser(DATA,body.get('target','store')))
   if self.path=='/api/workbench/restart':
    global RESTART_PENDING
    if body.get('confirm') != 'restart-workbench': raise ValueError('请先确认重启工作台')
    with RESTART_LOCK:
     if not RESTART_PENDING:
      import psutil
      process=psutil.Process(os.getpid())
      subprocess.Popen([sys.executable,str(ROOT/'restart_workbench.py'),str(process.pid),str(process.create_time())],cwd=ROOT,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
      RESTART_PENDING=True
    return self.reply({'ok':True,'instance_id':INSTANCE_ID})
   if self.path=='/api/bridge/price-window': return self.reply(price_window.settings(body,connect))
   if self.path=='/api/features/product-rules': return self.reply(product_rules.save(body,connect))
   if self.path=='/api/collector/collect-now': return self.reply(collector_control.request(DATA,body))
   if self.path=='/api/bridge/collector-control': return self.reply(collector_control.bridge(DATA,body))
   if self.path=='/api/bridge/coverage': return self.reply(sync_audit.ads_coverage(connect,body))
   if self.path=='/api/bridge/capture': return self.reply(merchant.ingest(body,connect))
   if self.path=='/api/bridge/activity-evidence': return self.reply(activity_jobs.ingest_evidence(body,connect))
   if self.path=='/api/bridge/collector':
    receipt=collector.ingest(body,connect)
    collector.record_attempt(connect,'accepted',receipt['message'])
    return self.reply(receipt)
   if self.path=='/api/bridge/gpt/watchdog': return self.reply(gpt_extension_bridge.watchdog(DATA,body))
   if self.path=='/api/bridge/gpt/heartbeat': return self.reply(gpt_extension_bridge.heartbeat(body,DATA))
   if self.path=='/api/bridge/gpt/claim': return self.reply(gpt_extension_bridge.claim(DATA,body))
   if self.path=='/api/bridge/gpt/update': return self.reply(gpt_extension_bridge.update(DATA,body))
   if self.path=='/api/patrol/clear':
    try:return self.reply(patrol_health.clear_alert(body,connect))
    except ValueError as e:return self.reply({'error':str(e)},400)
   if self.path=='/api/patrol/action':
    try:return self.reply(patrol_health.record_patrol(body,connect))
    except ValueError as e:return self.reply({'error':str(e)},400)
   if self.path=='/api/daily/task': return self.reply(operations.update(body,connect))
   if self.path=='/api/activity-jobs/plan': return self.reply(activity_jobs.create_plan(body,connect))
   if self.path=='/api/activity-jobs/settings': return self.reply(activity_jobs.save_settings(body,connect))
   if self.path=='/api/activity-jobs/selection': return self.reply(activity_jobs.update_selection(body,connect))
   if self.path=='/api/activity-jobs/manifest': return self.reply(activity_jobs.prepare_manifest(body,connect))
   if self.path=='/api/activity-jobs/transition': return self.reply(activity_jobs.record_transition(body,connect))
   if self.path=='/api/activity-enrollment/prepare': return self.reply(activity_enrollment.prepare(body,connect))
   if self.path=='/api/activity-enrollment/enqueue': return self.reply(activity_enrollment.enqueue(body,connect))
   if self.path=='/api/image-jobs/scan-batch': return self.reply(image_jobs.scan_batch(body,DATA))
   if self.path=='/api/image-jobs/source-edit-scan': return self.reply(image_source_edits.scan(body,DATA))
   if self.path=='/api/image-jobs/source-edit-prepare': return self.reply(image_source_edits.prepare(body,DATA))
   if self.path=='/api/image-jobs/workflow-settings': return self.reply(image_workflows.save_settings(body,DATA))
   if self.path=='/api/image-jobs/repair-preview': return self.reply(image_workflows.repair_preview(body,DATA))
   if self.path=='/api/image-jobs/repair-prepare': return self.reply(image_workflows.prepare_repairs(body,DATA))
   if self.path=='/api/image-jobs/retry': return self.reply(image_workflows.retry_job(body,DATA))
   if self.path=='/api/image-jobs/prepare-batch': return self.reply(image_jobs.prepare_batch(body,DATA))
   if self.path=='/api/image-jobs/prepare': return self.reply(image_jobs.prepare(body,DATA))
   if self.path=='/api/image-jobs/upload-fixed': return self.reply(image_jobs.upload({**body,'fixed':True},DATA))
   if self.path=='/api/image-jobs/upload-reference': return self.reply(image_jobs.upload({**body,'extra_reference':True},DATA))
   if self.path=='/api/image-jobs/upload': return self.reply(image_jobs.upload(body,DATA))
   if self.path=='/api/image-jobs/prompt': return self.reply(image_jobs.save_prompt(body,DATA))
   if self.path=='/api/image-jobs/clear-records': return self.reply(image_jobs.clear_records(DATA,body.get('ids')))
   if self.path=='/api/image-jobs/delete-selected': return self.reply(image_jobs.delete_selected(DATA,body.get('ids')))
   if self.path=='/api/image-jobs/reset-all': return self.reply(image_jobs.reset_all(DATA))
   if self.path=='/api/image-jobs/retry-failed': return self.reply(gpt_extension_bridge.retry_failed(DATA,body.get('ids')))
   if self.path=='/api/image-jobs/reassign-batch': return self.reply(image_jobs.reassign_batch(body,DATA))
   if self.path=='/api/image-jobs/pause-selected': return self.reply(gpt_extension_bridge.pause_many(DATA,body.get('ids')))
   if self.path=='/api/image-jobs/reassign-selected': return self.reply(gpt_extension_bridge.reassign_many(DATA,body.get('ids'),body.get('browsers')))
   if self.path=='/api/gpt-browser-profiles/open': return self.reply(gpt_browser_profiles.open_profile(DATA,body.get('profile_id')))
   if self.path=='/api/gpt-browser-profiles/create': return self.reply(gpt_browser_profiles.create_profiles(DATA,body))
   if self.path=='/api/image-runner': return self.reply(gpt_runner.get_runner(DATA).submit(body.get('action'),body.get('id')))
   if self.path=='/api/gpt-extension':
    if body.get('action') in ('account-quota','recover-skipped'):return self.reply(gpt_extension_bridge.unattended_action(DATA,body))
    return self.reply(gpt_extension_bridge.pause(DATA,body.get('id')) if body.get('action') in ('pause','park') else gpt_extension_bridge.enqueue(DATA,body.get('id'),bool(body.get('single')),body.get('browsers'),bool(body.get('collect_only'))))
   if self.path=='/api/preview':
    h,rows=parse_csv(body.get('text',''))
    if 'mapping' not in body: return self.reply({'headers':h,'mapping':guess(h),'sample':rows[:5],'count':len(rows),'fields':FIELDS})
    _,normalized,errors=normalize(body)
    return self.reply({'sample':normalized[:5],'count':len(normalized),'errors':errors[:30],'error_count':len(errors)})
   if self.path=='/api/import': return self.reply(import_rows(body))
   if self.path=='/api/catalog': return self.reply(ingest_catalog(body))
   if self.path=='/api/entry': return self.reply(save_entry(body))
   if self.path=='/api/launch': return self.reply(launch_tool(body.get('tool')))
   if self.path=='/api/rules':
    rule={k:float(body[k]) for k in DEFAULT_RULES}
    if any(not math.isfinite(v) or v<0 for v in rule.values()) or rule['ctr']>100 or rule['order_ratio']>100: raise ValueError('观察线必须为非负有效数字，比例不能超过 100%')
    with connect() as db: db.execute("INSERT OR REPLACE INTO settings VALUES('rules',?)",(json.dumps(rule),))
    return self.reply({'ok':True})
   return self.reply({'error':'未知入口'},404)
  except (ValueError,KeyError,TypeError) as e:
   if self.path=='/api/bridge/collector':collector.record_attempt(connect,'rejected',str(e))
   return self.reply({'error':str(e)},400)
  except Exception as e: return self.reply({'error':'本地处理失败：'+str(e)},500)

if __name__=='__main__':
 init()
 gpt_extension_bridge.start_maintenance(DATA)
 print(f'Temu local data service http://127.0.0.1:{PORT}',flush=True)
 BoundedThreadingHTTPServer(('127.0.0.1',PORT),Handler).serve_forever()
