"""Versioned parser for the visible Temu US product-traffic table."""
import json, re, hashlib
from datetime import date, datetime, timezone

SOURCE = 'https://agentseller-us.temu.com/main/flux-analysis'
TOP = ['', '商品信息', '商品情况', '支付情况', '曝光订单转化率', '点击率', '点击订单转化率', '搜索数据', '推荐数据', '商品优化方式', '操作']
SUB = ['曝光量','点击量','访客数','浏览量','加购人数','收藏人数','订单数','件数','买家数','商详支付买家数','商详支付转化率'] + ['曝光量','点击量','支付订单数','支付件数'] * 2
KEYS = ['impressions','clicks','visitors','views','carts','favorites','orders','units','buyers','detail_buyers','detail_conversion','exposure_conversion','reported_ctr','click_conversion','search_impressions','search_clicks','search_orders','search_units','recommend_impressions','recommend_clicks','recommend_orders','recommend_units']

def number(text, percentage=False):
 value = str(text).strip().split('\n')[0].strip().replace(',','')
 if value in ('','-','—','--'): return None
 pattern = r'\d+(?:\.\d+)?%' if percentage else r'\d+'
 if not re.fullmatch(pattern,value): raise ValueError('指标格式发生变化：'+value[:30])
 n = float(value[:-1]) if percentage else int(value)
 if percentage and n>100: raise ValueError('百分比超出范围')
 return n

def parse_capture(body):
 if body.get('url') != SOURCE: raise ValueError('目前仅支持美国站商品流量页面')
 shop = str(body.get('shop','')).strip()
 text = body.get('text','')
 if not shop or len(shop)>100 or shop not in text[:350].splitlines(): raise ValueError('页面店铺名称与指定店铺不一致，请检查是否切店')
 times = re.findall(r'统计时间[：:]([^\n]+)', text)
 if len(times)!=2: raise ValueError('无法确认汇总和明细统计日期，请等待页面加载完成')
 days=[]
 for t in times:
  m=re.fullmatch(r'\s*(?:北京时间\s*)?(\d{4}-\d{2}-\d{2})\s*',t)
  if not m: raise ValueError('请选择单日统计，实时或区间数据不能写成日数据')
  day=date.fromisoformat(m[1])
  if day>date.today(): raise ValueError('统计日期不能在未来')
  days.append(day.isoformat())
 if days[0]!=days[1]: raise ValueError('汇总与明细日期不一致，请分别选择同一天')
 tables=body.get('tables',[])
 headers=next((t['headers'] for t in tables if t.get('headers')),[])
 if len(headers)!=2: raise ValueError('流量表头结构发生变化')
 if [[re.sub(r'\s+','',c['text']) for c in r] for r in headers] != [TOP,SUB]: raise ValueError('流量表头发生变化，已停止写入，避免列错位')
 expected=[(1,2),(1,2),(6,1),(5,1),(1,2),(1,2),(1,2),(4,1),(4,1),(1,2),(1,2)]
 if [(c['colspan'],c['rowspan']) for c in headers[0]]!=expected or any(c['colspan']!=1 or c['rowspan']!=1 for c in headers[1]): raise ValueError('流量合并表头发生变化')
 rows=[r for t in tables for r in t.get('rows',[]) if len(r)>1 and 'SPU ID' in r[1]]
 if not rows or len(rows)>500: raise ValueError('当前页面没有可识别的商品明细')
 products=[]; ids=set()
 for r in rows:
  if len(r)!=26: raise ValueError('商品明细列数发生变化')
  m=re.search(r'SPU ID[：:]\s*(\d+)',r[1])
  if not m or not re.search(r'经营站点[：:]\s*美国站',r[1]): raise ValueError('商品ID或经营站点无法确认')
  if m[1] in ids: continue
  ids.add(m[1])
  item={'product_id':m[1],'title':r[1].split('\n')[0], 'shop':shop,'site':'US','date':days[1], 'product_info':r[1]}
  item.update({k:number(r[i+2],10<=i<=13) for i,k in enumerate(KEYS)})
  products.append(item)
 summary_text=text.split('趋势分析')[0]
 summary={}
 for label,key in [('商品曝光量','impressions'),('商品点击量','clicks'),('支付订单数','orders'),('支付件数','units'),('点击率','ctr')]:
  match=re.search(r'(?:^|\n)'+label+r'\s*\n([^\n]+)',summary_text)
  if not match: raise ValueError('汇总指标未加载完整：'+label)
  summary[key]=number(match[1],key=='ctr')
 total=re.search(r'共有\s*([\d,]+)\s*条',text)
 total=int(total[1].replace(',','')) if total else None
 if total is not None and total<len(products): raise ValueError('页面总数小于采集数')
 observed=body.get('observed_at','')
 try:
  timestamp=datetime.fromisoformat(observed.replace('Z','+00:00'))
  if timestamp.tzinfo is None: raise ValueError()
  observed=timestamp.astimezone(timezone.utc).isoformat()
 except (ValueError,AttributeError): raise ValueError('采集时间格式无效')
 digest=hashlib.sha256(json.dumps([shop,days[1],summary,products,total],sort_keys=True,ensure_ascii=False).encode()).hexdigest()
 return {'shop':shop,'site':'US','date':days[1],'summary':summary,'products':products,'displayed_total':total,'observed_at':observed,'source_url':SOURCE,'digest':digest,'status':'partial'}

def ingest(body, connect):
 capture=parse_capture(body)
 with connect() as db:
  unchanged=True
  for row in capture['products']:
   old=db.execute('SELECT payload,captured FROM traffic WHERE shop=? AND site=? AND day=? AND spu=?',(row['shop'],row['site'],row['date'],row['product_id'])).fetchone()
   if old and old['captured']>capture['observed_at']: raise ValueError('旧采集不能覆盖较新的记录')
   if not old or json.loads(old['payload'])!=row: unchanged=False
  if unchanged and db.execute('SELECT 1 FROM traffic_captures WHERE id=?',(capture['digest'],)).fetchone(): return {'received':len(capture['products']),'duplicate':True,'date':capture['date'],'message':'当前页数据未变化，已跳过重复保存'}
  for row in capture['products']:
   key=(row['shop'],row['site'],row['date'],row['product_id'])
   old=db.execute('SELECT captured FROM traffic WHERE shop=? AND site=? AND day=? AND spu=?',key).fetchone()
   if old and old['captured']>capture['observed_at']: raise ValueError('旧采集不能覆盖较新的记录')
   db.execute('INSERT OR REPLACE INTO traffic VALUES(?,?,?,?,?,?)',(*key,json.dumps(row,ensure_ascii=False),capture['observed_at']))
  receipt={k:v for k,v in capture.items() if k!='products'}
  receipt['received']=len(capture['products'])
  db.execute('INSERT OR REPLACE INTO traffic_captures VALUES(?,?,?)',(capture['digest'],capture['observed_at'],json.dumps(receipt,ensure_ascii=False)))
 return {**receipt,'message':f"已保存 {len(capture['products'])} 款商品；仍按部分采集显示"}
