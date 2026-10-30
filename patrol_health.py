"""Local patrol alerts; product truth comes exclusively from product_operations."""
import hashlib
import json
import re
from datetime import datetime
from zoneinfo import ZoneInfo

import product_operations

SHANGHAI = ZoneInfo('Asia/Shanghai')


def init(db):
    db.executescript('''
    CREATE TABLE IF NOT EXISTS patrol_alert_clears(
      mall_id TEXT NOT NULL, alert_key TEXT NOT NULL, spu_id TEXT NOT NULL,
      kind TEXT NOT NULL, cleared_at TEXT NOT NULL, note TEXT NOT NULL,
      PRIMARY KEY(mall_id,alert_key));
    CREATE TABLE IF NOT EXISTS patrol_window_actions(
      id INTEGER PRIMARY KEY, mall_id TEXT NOT NULL, window_date TEXT NOT NULL,
      window_slot TEXT NOT NULL, action TEXT NOT NULL, created_at TEXT NOT NULL,
      note TEXT NOT NULL, payload TEXT NOT NULL);
    ''')


def _mall(value):
    mall = str(value or '').strip()
    if not re.fullmatch(r'\d{1,40}', mall):
        raise ValueError('请选择有效店铺')
    return mall


def windows_for(now_shanghai=None):
    now = now_shanghai or datetime.now(SHANGHAI)
    if now.tzinfo is None:
        now = now.replace(tzinfo=SHANGHAI)
    now = now.astimezone(SHANGHAI)
    slot = 'morning' if 9 <= now.hour < 12 else 'afternoon' if 14 <= now.hour < 18 else ''
    return {'active': bool(slot), 'slot': slot, 'date': now.date().isoformat(),
            'timezone': 'Asia/Shanghai', 'now': now.isoformat(),
            'schedule': ['09:00–12:00', '14:00–18:00']}


def resolve_accelerator(product):
    """Prefer fresh status from product_operations; if all rows are stale, fall
    back to a unanimous last-known status so patrol does not flood 无法确认.
    Product-status page still shows unknown for stale; only patrol uses this.
    """
    boost = product.get('acceleratorStatus')
    if boost and boost != 'unknown':
        return boost, False
    known = {row.get('status') for row in product.get('accelerators') or []
             if row.get('status') not in (None, '', 'unknown')}
    if len(known) == 1:
        return next(iter(known)), True
    return 'unknown', False


def health_anomalies(connect, mall_id, data=None):
    mall = _mall(mall_id)
    data = data or product_operations.state(connect, mall)
    with connect() as db:
        cleared = {row[0] for row in db.execute('SELECT alert_key FROM patrol_alert_clears WHERE mall_id=?', (mall,))}
    items = []
    for product in data['products']:
        if product.get('saleStatus') != 'on_sale':
            continue
        activity = product.get('activityStatus')
        boost, from_stale = resolve_accelerator(product)
        reasons = []
        if activity == 'enrolled':
            if boost == 'unknown':
                reasons.append('加速器状态无法确认')
            elif boost != 'enabled':
                reasons.append('有活动无加速器')
            if product.get('activityFreshness', {}).get('stale'):
                reasons.append('活动记录过期/可能误报')
        if not reasons:
            continue
        identity = [product['spuId'], activity, boost, from_stale, reasons]
        key = 'health:' + hashlib.sha256(json.dumps(identity, ensure_ascii=False).encode()).hexdigest()
        images = [url for url in (product.get('images') or []) if isinstance(url, str) and url.startswith('https://')]
        items.append({k: product.get(k) for k in ('spuId', 'tags', 'activityStatus', 'acceleratorStatus', 'saleStatus')} | {
            'alertKey': key, 'kind': 'health', 'reasons': reasons, 'adsStatus': 'not_available',
            'acceleratorResolved': boost, 'acceleratorFromStale': from_stale, 'cleared': key in cleared,
            'imageUrl': images[0] if images else '', 'images': images[:3],
            'activityNames': product.get('activityNames') or [],
            'acceleratorStatusLabel': product_operations.BOOST_LABELS.get(boost, '待确认'),
            'activityStatusLabel': product.get('activityStatusLabel') or '',
            'saleStatusLabel': product.get('saleStatusLabel') or ''})
    return items


def traffic_attention(connect, mall_id):
    _mall(mall_id)
    return {'items': [], 'available': False, 'gap': '商品列表「流量待关注」红标尚未入库'}


def snapshot(connect, mall_id, now=None):
    mall = _mall(mall_id)
    ops = product_operations.state(connect, mall)
    health = health_anomalies(connect, mall, data=ops)
    traffic = traffic_attention(connect, mall)
    window = windows_for(now)
    pending = sum(not item['cleared'] for item in health)
    pending += sum(not item.get('cleared', False) for item in traffic['items']) if traffic['available'] else 0
    return {'success': True, 'mallId': mall, 'generatedAt': ops.get('generatedAt') or window['now'],
            'sources': ops.get('sources') or {},
            'health': {'items': health, 'unclearedCount': sum(not i['cleared'] for i in health)},
            'trafficAttention': traffic, 'window': window,
            # warnModal: any uncleared alerts (dismissible UI). forceModal kept as alias for older clients.
            'warnModal': pending > 0, 'forceModal': pending > 0}


def _record(db, mall, action, note, payload):
    window = windows_for()
    db.execute('INSERT INTO patrol_window_actions(mall_id,window_date,window_slot,action,created_at,note,payload) VALUES(?,?,?,?,?,?,?)',
               (mall, window['date'], window['slot'], action, window['now'], note, json.dumps(payload, ensure_ascii=False)))


def clear_alert(body, connect):
    mall = _mall(body.get('mall_id'))
    kind = body.get('kind')
    if kind not in {'health', 'traffic_attention'}:
        raise ValueError('无效预警类型')
    items = health_anomalies(connect, mall) if kind == 'health' else traffic_attention(connect, mall)['items']
    item = next((i for i in items if i['alertKey'] == body.get('alert_key') and i['spuId'] == str(body.get('spu_id', ''))), None)
    if not item:
        raise ValueError('预警已变化，请刷新后核对')
    note = str(body.get('note') or '')[:2000]
    with connect() as db:
        db.execute('INSERT OR REPLACE INTO patrol_alert_clears VALUES(?,?,?,?,?,?)',
                   (mall, item['alertKey'], item['spuId'], kind, windows_for()['now'], note))
        _record(db, mall, 'clear', note, {'alertKey': item['alertKey'], 'spuId': item['spuId'], 'kind': kind})
    return {'success': True}


def record_patrol(body, connect):
    mall = _mall(body.get('mall_id'))
    action = body.get('action', 'acknowledge')
    if action not in {'acknowledge', 'open'}:
        raise ValueError('无效巡店动作')
    with connect() as db:
        _record(db, mall, action, str(body.get('note') or '')[:2000], {})
    return {'success': True, 'window': windows_for()}
