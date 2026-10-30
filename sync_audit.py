"""Local completeness checks against received batches; no merchant requests."""
import json,re
from datetime import date,datetime,timedelta,timezone
CHINA=timezone(timedelta(hours=8))
LABELS={'products':'商品目录','activities':'活动价格','orders':'订单明细','returns':'退货退款','ads':'广告日报','flow':'店铺流量'}

def ads_coverage(connect,body):
 mall=str(body.get('mall_id',''))
 if not re.fullmatch(r'\d{1,40}',mall):raise ValueError('店铺 ID 无效')
 start=date.fromisoformat(body.get('start_date',''));end=date.fromisoformat(body.get('end_date',''))
 if end<start or (end-start).days>61:raise ValueError('广告补采范围须为 1 至 62 天')
 if end>datetime.now(CHINA).date():raise ValueError('不能补采未来广告日期')
 requested=[(start+timedelta(days=i)).isoformat() for i in range((end-start).days+1)]
 present={};earliest=None
 with connect() as db:
  for r in db.execute("SELECT body FROM collector_payloads WHERE source_path='/api/client/ads/save' ORDER BY observed_at DESC"):
   saved=json.loads(r['body'])
   if str(saved.get('mall_id'))!=mall:continue
   try:
    earliest=date.fromisoformat(saved.get('earliest_ad_date','')).isoformat()
    break
   except (ValueError,TypeError):pass
  for r in db.execute("SELECT payload,captured FROM collector_records WHERE dataset='ads' AND mall_id=?",(mall,)):
   row=json.loads(r['payload']);present[row['date']]=(row,r['captured'])
 unavailable=[d for d in requested if earliest and d<earliest]
 eligible=[d for d in requested if d not in unavailable]
 finalized=[];refresh=[];missing=[]
 for day in eligible:
  if day not in present or present[day][0].get('response_ok') is not True:missing.append(day);continue
  captured=datetime.fromisoformat(present[day][1]).astimezone(CHINA).date().isoformat()
  if captured>day:finalized.append(day)
  else:refresh.append(day)
 return {'mall_id':mall,'requested_dates':requested,'eligible_dates':eligible,'earliest_available':earliest,'unavailable_dates':unavailable,'present_dates':[d for d in eligible if d in present],'finalized_dates':finalized,'missing_dates':missing,'refresh_dates':refresh,'fetch_dates':sorted(missing+refresh),'complete':not missing and not refresh}

def snapshot(connect,mall=''):
 with connect() as db:
  shops={r['mall_id']:r['name'] for r in db.execute('SELECT * FROM collector_shops')}
  receipts=[json.loads(r['payload']) for r in db.execute('SELECT payload FROM collector_receipts ORDER BY observed_at DESC')]
  for r in receipts:shops.setdefault(r['mall_id'],r.get('shop') or r['mall_id'])
  rows=[dict(r) for r in db.execute('SELECT * FROM collector_records')]
  archives=[dict(r) for r in db.execute('SELECT * FROM collector_payloads ORDER BY observed_at DESC')]
 result=[]
 for shop,name in shops.items():
  if mall and shop!=mall:continue
  for kind,label in LABELS.items():
   latest=next((r for r in receipts if r['mall_id']==shop and r['dataset']==kind),None)
   records=[r for r in rows if r['mall_id']==shop and r['dataset']==kind]
   item={'mall_id':shop,'shop':name,'dataset':kind,'label':label,'count':len(records),'status':'missing' if not latest else 'received','observed_at':latest.get('observed_at') if latest else None,'detail':'尚未收到此类采集回执','next_action':'运行“商品＋活动”' if kind in ['products','activities'] else '运行“广告”' if kind=='ads' else '运行“订单＋流量”'}
   if latest:
    raw=next((r for r in archives if r['id']==latest['id'] and r['observed_at']==latest['observed_at']),None)
    body=json.loads(raw['body']) if raw else {}
    array='items' if kind=='flow' else 'reports' if kind=='ads' else 'rows'
    item.update(sent_rows=len(body.get(array,[])) if raw else None,received_rows=latest['rows'],next_action='')
    item['detail']=f"本批上传 {item['sent_rows'] if raw else '未知'} 条，本地接收 {latest['rows']} 条；按记录标识去重保存"
    if kind in ['orders','returns']:
     item['detail']+=f"；查询范围 {latest.get('start_date') or '未知'} 至 {latest.get('end_date') or '未知'}"
     if latest['rows']==0:item['status']='empty';item['detail']='本批成功返回 0 条，并非未同步。'+item['detail']
    if kind=='flow':
     dimensions=sorted({json.loads(r['payload'])['time_dimension'] for r in records})
     item['detail']=f'收到 {len(dimensions)}/6 个店铺汇总维度；不是商品级流量明细'
     if len(dimensions)<6:item.update(status='partial',next_action='运行“订单＋流量”补齐维度')
    if kind=='ads':
     # Assess the 30-day window ending at the latest report date, not a guessed task date.
     days=sorted({json.loads(r['payload'])['date'] for r in records})
     if days:
      end=date.fromisoformat(days[-1]);start=end-timedelta(days=29)
      coverage=ads_coverage(connect,{'mall_id':shop,'start_date':start.isoformat(),'end_date':end.isoformat()})
      item.update(ad_coverage=coverage)
      item['detail']=f"截至 {end} 的近30天窗口，平台可查询范围内已有 {len(coverage['present_dates'])}/{len(coverage['eligible_dates'])} 天，尚缺 {len(coverage['missing_dates'])} 天"
      if coverage['earliest_available']:item['detail']+='；平台返回的可查询起始日 '+coverage['earliest_available']
      if not coverage['complete']:item.update(status='partial',next_action='更新至 0.8.4 后运行“广告”，按本地缺失日期补采')
   result.append(item)
 return result
