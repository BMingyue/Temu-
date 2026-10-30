"""Read-only shop price preset for the extension's price window."""
import json
import re
from datetime import datetime, timezone

from activity_jobs import normalize_dimension


def activity_for_skc(db, mall, skc, max_age_hours):
    """Use only explicit, recent campaign decisions; absence is not rejection."""
    empty = {'state': 'missing', 'campaign_id': '', 'captured': '', 'decisions': {}}
    if not skc:
        return empty
    found = []
    stale = False
    rows = db.execute(
        'SELECT captured,campaign_id,payload FROM activity_evidence_snapshots '
        'WHERE mall_id=? ORDER BY captured DESC LIMIT 100', (mall,)
    )
    for row in rows:
        payload = json.loads(row['payload'])
        candidates = [item for item in payload.get('candidates', [])
                      if str(item.get('skcId', '')) == skc]
        unresolved = [item for item in payload.get('unresolved_candidates', [])
                      if str(item.get('skcId', '')) == skc]
        if not candidates and not unresolved:
            continue
        try:
            captured = datetime.fromisoformat(row['captured'].replace('Z', '+00:00')).astimezone(timezone.utc)
            recent = 0 <= (datetime.now(timezone.utc) - captured).total_seconds() <= max_age_hours * 3600
        except (TypeError, ValueError):
            recent = False
        if not recent:
            stale = True
            continue
        found.append((row, candidates, unresolved))
    if not found:
        return {**empty, 'state': 'stale' if stale else 'missing'}
    campaigns = {row['campaign_id'] for row, _, _ in found}
    if len(campaigns) != 1:
        return {**empty, 'state': 'ambiguous'}
    row, candidates, unresolved = found[0]
    decisions, conflicts = {}, set()
    for item in candidates:
        dimension = normalize_dimension(item.get('specification'))
        eligible = item.get('eligible')
        if not re.fullmatch(r'\d+(?:\.\d+)?×\d+(?:\.\d+)?(?:in|cm)', dimension) or not isinstance(eligible, bool):
            continue
        if dimension in decisions:
            conflicts.add(dimension)
        else:
            decisions[dimension] = {'eligible': eligible, 'sku_id': str(item.get('skuId') or '')}
    for item in unresolved:
        dimension = normalize_dimension(item.get('specification'))
        if dimension:
            conflicts.add(dimension)
    for dimension in conflicts:
        decisions.pop(dimension, None)
    return {'state': 'ready', 'campaign_id': row['campaign_id'],
            'captured': row['captured'], 'decisions': decisions}


def settings(body, connect):
    mall = str(body.get('mall_id', ''))
    skc = str(body.get('skc_id') or '')
    if not re.fullmatch(r'\d+', mall) or (skc and not re.fullmatch(r'\d+', skc)):
        raise ValueError('无法确认当前店铺或 SKC')
    with connect() as db:
        active = db.execute("SELECT payload FROM activity_settings WHERE id=?", ('active_preset:' + mall,)).fetchone()
        if not active:
            raise ValueError('请先在工作台为当前店铺加载并保存价格预设')
        name = json.loads(active['payload'])
        if not isinstance(name, str) or not name:
            raise ValueError('当前店铺的价格预设无效，请重新加载')
        saved = db.execute("SELECT payload FROM activity_settings WHERE id=?", ('preset:' + mall + ':' + name,)).fetchone()
        if not saved:
            raise ValueError('当前店铺的价格预设不存在，请重新加载并保存')
        shop = db.execute('SELECT name FROM collector_shops WHERE mall_id=?', (mall,)).fetchone()
        if not shop:
            raise ValueError('当前店铺尚未同步到工作台')
        config = json.loads(saved['payload'])
        max_age_hours = config.get('evidence_max_age_hours', 24)
        if not isinstance(max_age_hours, (int, float)) or isinstance(max_age_hours, bool) or not 0 < max_age_hours <= 168:
            max_age_hours = 24
        activity = activity_for_skc(db, mall, skc, max_age_hours)
    return {'mall_id': mall, 'skc_id': skc, 'shop_name': shop['name'],
            'preset_name': name, 'size_prices': config.get('size_prices', {}),
            'two_price_mode': config.get('two_price_mode') is True,
            'activity': activity}
