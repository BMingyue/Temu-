"""Durable, exact-scope enrollment commands consumed by the local extension."""
from __future__ import annotations

import hashlib
import json
import re
import secrets
import uuid
from datetime import datetime, timezone

import activity_jobs


FINAL = {'preflight_failed', 'platform_acknowledged', 'platform_rejected', 'submitted_unverified', 'cancelled'}


def now():
    return datetime.now(timezone.utc).isoformat()


def init(db):
    db.executescript('''
    CREATE TABLE IF NOT EXISTS activity_enrollment_batches(
      id TEXT PRIMARY KEY, created TEXT NOT NULL, updated TEXT NOT NULL,
      mall_id TEXT NOT NULL, campaign_id TEXT NOT NULL, status TEXT NOT NULL,
      claim_token TEXT, payload TEXT NOT NULL, message TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS activity_enrollment_queue
      ON activity_enrollment_batches(mall_id,campaign_id,status,created);
    CREATE TABLE IF NOT EXISTS activity_enrollment_clients(
      mall_id TEXT NOT NULL, campaign_id TEXT NOT NULL, last_seen TEXT NOT NULL,
      collector_version TEXT NOT NULL DEFAULT '',
      PRIMARY KEY(mall_id,campaign_id));
    ''')
    columns = {row['name'] for row in db.execute('PRAGMA table_info(activity_enrollment_clients)').fetchall()}
    if 'collector_version' not in columns:
        db.execute("ALTER TABLE activity_enrollment_clients ADD COLUMN collector_version TEXT NOT NULL DEFAULT ''")


def _id(value, label):
    value = str(value or '').strip()
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,80}', value):
        raise ValueError(f'{label}无效')
    return value


def _settings(db, mall):
    row = db.execute("SELECT payload FROM activity_settings WHERE id=?", ('default:' + mall,)).fetchone()
    if not row:
        row = db.execute("SELECT payload FROM activity_settings WHERE id='default'").fetchone()
    if not row:
        raise ValueError('请先保存活动价格和报名筛选设置')
    return activity_jobs.config_from(json.loads(row['payload']))


def _current_plan(db, mall, campaign, wanted=None):
    snapshot = db.execute('SELECT * FROM activity_evidence_snapshots WHERE mall_id=? AND campaign_id=? ORDER BY captured DESC LIMIT 1', (mall, campaign)).fetchone()
    if not snapshot:
        raise ValueError('找不到当前店铺和活动的只读采集结果')
    config = _settings(db, mall)
    evidence = activity_jobs.resolve_evidence(db, mall, json.loads(snapshot['payload']))
    products, duplicates = activity_jobs._collector_products(db, mall)
    groups = {}
    for candidate in evidence.get('candidates', []):
        precheck = activity_jobs.enrollment_precheck(candidate, products.get(candidate['skuId']), candidate['skuId'] in duplicates, config, snapshot['captured'])
        key = candidate['spuId'] + '|' + candidate['skcId']
        groups.setdefault(key, []).append((candidate, precheck))
    def incomplete(rows):
        first = rows[0][0]
        return any(row['spuId'] == first['spuId'] and (not row['skcId'] or row['skcId'] == first['skcId'])
                   for row in evidence.get('unresolved_candidates', []))
    safe = {key: rows for key, rows in groups.items()
            if rows and not incomplete(rows) and all(pre['status'] == 'ready' for _, pre in rows)}
    chosen = sorted(safe) if wanted is None else sorted(set(wanted))
    if not chosen:
        raise ValueError('请至少选择一个全部 SKU 均通过检查的商品')
    if len(chosen) > 100:
        raise ValueError('单次最多报名 100 个商品')
    if any(key not in safe for key in chosen):
        raise ValueError('选择中包含不完整或未通过检查的商品，请刷新后重选')
    output = []
    for key in chosen:
        rows = safe[key]
        stocks = {candidate.get('referenceStock') for candidate, _ in rows}
        if len(stocks) != 1 or next(iter(stocks)) is None:
            raise ValueError(f'商品 {key} 的场次共用库存不唯一')
        stock = next(iter(stocks))
        if isinstance(stock, bool) or not isinstance(stock, int) or stock < 0:
            raise ValueError(f'商品 {key} 的库存无效')
        items = []
        seen_specs = set()
        for candidate, precheck in rows:
            spec = activity_jobs.normalize_dimension(candidate['specification'])
            if not spec or spec in seen_specs:
                raise ValueError(f'商品 {key} 的尺寸缺失或重复')
            seen_specs.add(spec)
            items.append({
                'skuId': candidate['skuId'], 'specification': spec,
                'dailyPrice': candidate['dailyPrice'],
                'referenceActivityPrice': candidate['referenceActivityPrice'],
                'activityPrice': precheck['plannedActivityPrice'],
            })
        output.append({'product_key': key, 'spuId': rows[0][0]['spuId'], 'skcId': rows[0][0]['skcId'],
                       'inventory': stock, 'items': items})
    core = {'mall_id': mall, 'campaign_id': campaign, 'source_snapshot_id': snapshot['id'],
            'source_captured': snapshot['captured'], 'products': output,
            'settings_fingerprint': hashlib.sha256(json.dumps(config, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).hexdigest()}
    core['fingerprint'] = hashlib.sha256(json.dumps(core, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    return core


def prepare(body, connect):
    mall, campaign = _id(body.get('mall_id'), '店铺ID'), _id(body.get('campaign_id'), '活动ID')
    selected = body.get('product_keys')
    if not isinstance(selected, list) or any(not isinstance(x, str) for x in selected):
        raise ValueError('商品选择格式无效')
    with connect() as db:
        plan = _current_plan(db, mall, campaign, selected)
        batch_id, stamp = uuid.uuid4().hex, now()
        payload = {'id': batch_id, **plan}
        db.execute('INSERT INTO activity_enrollment_batches VALUES(?,?,?,?,?,?,?,?,?)',
                   (batch_id, stamp, stamp, mall, campaign, 'preview', None,
                    json.dumps(payload, ensure_ascii=False), '等待用户确认'))
    return {**payload, 'status': 'preview', 'product_count': len(payload['products']),
            'sku_count': sum(len(x['items']) for x in payload['products'])}


def enqueue(body, connect):
    batch_id = _id(body.get('batch_id'), '报名批次')
    with connect() as db:
        row = db.execute('SELECT * FROM activity_enrollment_batches WHERE id=?', (batch_id,)).fetchone()
        if not row or row['status'] != 'preview':
            raise ValueError('报名预览已失效或已经执行')
        payload = json.loads(row['payload'])
        count = len(payload['products'])
        if body.get('confirmation') != f'确认报名{count}个商品':
            raise ValueError('确认内容与报名商品数量不一致')
        fresh = _current_plan(db, row['mall_id'], row['campaign_id'], [x['product_key'] for x in payload['products']])
        if fresh['fingerprint'] != payload['fingerprint']:
            raise ValueError('采集结果或报名价格已经变化，请重新预览')
        db.execute('UPDATE activity_enrollment_batches SET status=?,updated=?,message=? WHERE id=?',
                   ('queued', now(), '等待活动页扩展接收', batch_id))
    return {'ok': True, 'id': batch_id, 'status': 'queued'}


def bridge(body, connect):
    action = str(body.get('action') or '')
    if action == 'poll':
        mall, campaign = _id(body.get('mall_id'), '店铺ID'), _id(body.get('campaign_id'), '活动ID')
        version = str(body.get('collector_version') or '')
        if version and not re.fullmatch(r'\d+\.\d+\.\d+', version):
            raise ValueError('扩展版本无效')
        with connect() as db:
            db.execute('''INSERT INTO activity_enrollment_clients(mall_id,campaign_id,last_seen,collector_version)
                          VALUES(?,?,?,?) ON CONFLICT(mall_id,campaign_id)
                          DO UPDATE SET last_seen=excluded.last_seen,collector_version=excluded.collector_version''', (mall, campaign, now(), version))
            row = db.execute("SELECT * FROM activity_enrollment_batches WHERE mall_id=? AND campaign_id=? AND status='queued' ORDER BY created LIMIT 1", (mall, campaign)).fetchone()
            if not row:
                return {'ok': True, 'command': None}
            token = secrets.token_urlsafe(24)
            changed = db.execute("UPDATE activity_enrollment_batches SET status='claimed',claim_token=?,updated=?,message=? WHERE id=? AND status='queued'", (token, now(), '活动页正在核对控件', row['id'])).rowcount
            if changed != 1:
                return {'ok': True, 'command': None}
            return {'ok': True, 'command': {**json.loads(row['payload']), 'claim_token': token}}
    if action == 'report':
        batch_id, token = _id(body.get('id'), '报名批次'), str(body.get('claim_token') or '')
        status = str(body.get('status') or '')
        if status not in FINAL | {'submission_attempted'}:
            raise ValueError('报名结果状态无效')
        message = str(body.get('message') or '')[:1000]
        with connect() as db:
            row = db.execute('SELECT status,claim_token FROM activity_enrollment_batches WHERE id=?', (batch_id,)).fetchone()
            if not row or not secrets.compare_digest(str(row['claim_token'] or ''), token):
                raise ValueError('报名执行回执不匹配')
            allowed = row['status'] == 'claimed' or row['status'] == 'submission_attempted' and status in FINAL
            if not allowed:
                raise ValueError('报名批次状态不允许更新')
            db.execute('UPDATE activity_enrollment_batches SET status=?,updated=?,message=? WHERE id=?', (status, now(), message, batch_id))
        return {'ok': True, 'id': batch_id, 'status': status}
    raise ValueError('报名扩展动作无效')


def snapshot(connect, mall=''):
    with connect() as db:
        rows = db.execute('SELECT * FROM activity_enrollment_batches' + (' WHERE mall_id=?' if mall else '') + ' ORDER BY created DESC LIMIT 20', (mall,) if mall else ()).fetchall()
        clients = db.execute('SELECT * FROM activity_enrollment_clients' + (' WHERE mall_id=?' if mall else '') + ' ORDER BY last_seen DESC', (mall,) if mall else ()).fetchall()
    return {
        'batches': [{**dict(row), 'claim_token': None, 'payload': json.loads(row['payload'])} for row in rows],
        'clients': [dict(row) for row in clients],
    }
