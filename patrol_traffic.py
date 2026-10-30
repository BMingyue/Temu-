"""Read archived realtime totals; never interpolate or borrow another minute/day."""
import json
import math
import re
from datetime import date, datetime, timedelta, timezone

METRICS = ('impressionCount', 'clickCount', 'orderPayOrderNum')
SHANGHAI = timezone(timedelta(hours=8))


def compare(connect, mall, dates, at):
    if not re.fullmatch(r'\d{1,40}', mall):
        raise ValueError('请选择店铺')
    if not re.fullmatch(r'(?:[01]\d|2[0-3]):[0-5]\d', at):
        raise ValueError('对齐时刻须为 HH:MM（Asia/Shanghai）')
    try:
        days = sorted(set(date.fromisoformat(d).isoformat() for d in dates))
    except (ValueError, TypeError):
        raise ValueError('日期须为 YYYY-MM-DD')
    if not days or len(days) > 7 or (date.fromisoformat(days[-1]) - date.fromisoformat(days[0])).days > 6:
        raise ValueError('请选择同一周内的 1 至 7 个日期')
    start = datetime.fromisoformat(days[0]).replace(tzinfo=SHANGHAI).astimezone(timezone.utc).isoformat()
    end = (datetime.fromisoformat(days[-1]) + timedelta(days=1)).replace(tzinfo=SHANGHAI).astimezone(timezone.utc).isoformat()
    samples = {day: {} for day in days}
    with connect() as db:
        rows = db.execute('''SELECT id, observed_at, source_path, body FROM collector_payloads
            WHERE source_path IN ('/api/client/flow-overviews','/api/client/daily-audits')
            AND CAST(json_extract(body,'$.mall_id') AS TEXT)=?
            AND observed_at>=? AND observed_at<? ORDER BY observed_at,id''', (mall, start, end))
        for row in rows:
            body = json.loads(row['body'])
            flow = row['source_path'] == '/api/client/flow-overviews'
            for item in body.get('items' if flow else 'rows', []):
                if flow and item.get('time_dimension') != 0:
                    continue
                data = item.get('data') or {} if flow else item.get('traffic', {}).get('realtime') or {}
                # Daily finished_at is later than its traffic read. Only use a traffic timestamp.
                captured = (data.get('overview_received_at') if flow else data.get('overview_received_at'))
                captured = captured or (row['observed_at'] if flow else None)
                try:
                    moment = datetime.fromisoformat(captured.replace('Z', '+00:00'))
                    if moment.tzinfo is None:
                        continue
                    local = moment.astimezone(SHANGHAI)
                except (ValueError, TypeError, AttributeError):
                    continue
                day, minute = local.strftime('%Y-%m-%d'), local.strftime('%H:%M')
                if day not in samples or minute > at:
                    continue
                values = data.get('result' if flow else 'metrics') or {}
                values = {key: value if type(value := values.get(key)) in (int, float) and math.isfinite(value) and value >= 0 else None for key in METRICS}
                point = {'time': minute, 'captured_at': captured, 'source': 'flow' if flow else 'daily',
                         'metrics': values, 'missing': all(v is None for v in values.values())}
                previous = samples[day].get(minute)
                if previous is None or moment > datetime.fromisoformat(previous['captured_at'].replace('Z', '+00:00')):
                    samples[day][minute] = point
    times = sorted({at} | {minute for points in samples.values() for minute in points})
    def point(day, minute):
        return samples[day].get(minute, {'time': minute, 'captured_at': None, 'source': None,
            'metrics': dict.fromkeys(METRICS), 'missing': True})
    return {'mall_id': mall, 'dates': days, 'at': at, 'timezone': 'Asia/Shanghai',
            'alignment': 'exact_minute', 'times': times,
            'series': [{'date': day, 'aligned': point(day, at), 'points': [point(day, t) for t in times]} for day in days]}
