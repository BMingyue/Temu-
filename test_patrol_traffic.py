import json
import sqlite3
import threading
import unittest
from contextlib import contextmanager
from urllib.request import urlopen
from urllib.error import HTTPError
from unittest.mock import patch

import backend
import patrol_traffic


class TrafficCompareTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(':memory:', check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.execute('CREATE TABLE collector_payloads(id,observed_at,source_path,body)')
        self.add('2026-10-26T04:00:12Z', {'impressionCount': 100, 'clickCount': 0, 'orderPayOrderNum': 2})
        self.add('2026-10-27T04:00:30Z', {'impressionCount': 200, 'clickCount': 10})
        self.add('2026-10-28T03:59:59Z', {'impressionCount': 999})
        self.add('2026-10-28T04:00:10Z', {'impressionCount': 999}, mall='2')
        self.add('2026-10-28T04:00:20Z', {'impressionCount': 999}, dimension=1)

    def tearDown(self):
        self.db.close()

    @contextmanager
    def connect(self):
        yield self.db

    def add(self, captured, values, mall='1', dimension=0, daily=False, observed=None):
        item = {'time_dimension': dimension, 'data': {'overview_received_at': captured, 'result': values}}
        if daily:
            item = {'traffic': {'realtime': {'overview_received_at': captured, 'metrics': values}}}
        body = {'mall_id': mall, 'rows' if daily else 'items': [item]}
        self.db.execute('INSERT INTO collector_payloads VALUES(?,?,?,?)',
                        (str(self.db.total_changes), observed or captured, '/api/client/daily-audits' if daily else '/api/client/flow-overviews', json.dumps(body)))

    def compare(self):
        return patrol_traffic.compare(self.connect, '1', ['2026-10-26','2026-10-27','2026-10-28'], '12:00')

    def test_exact_minute_missing_and_zero(self):
        a,b,c = self.compare()['series']
        self.assertEqual(a['aligned']['metrics']['clickCount'], 0)
        self.assertEqual(b['aligned']['metrics']['impressionCount'], 200)
        self.assertIsNone(b['aligned']['metrics']['orderPayOrderNum'])
        self.assertTrue(c['aligned']['missing'])
        self.assertIsNone(c['aligned']['metrics']['impressionCount'])
        self.assertTrue(a['points'][0]['missing'])

    def test_daily_uses_traffic_timestamp_and_latest_sample(self):
        self.add('2026-10-26T04:00:50Z', {'impressionCount': 300}, daily=True, observed='2026-10-26T04:05:00Z')
        self.assertEqual(self.compare()['series'][0]['aligned']['metrics']['impressionCount'],300)
        self.assertEqual(self.compare()['series'][0]['aligned']['source'],'daily')

    def test_beijing_day_boundary(self):
        self.add('2026-10-25T16:00:00Z', {'impressionCount': 4})
        result = patrol_traffic.compare(self.connect,'1',['2026-10-26'],'00:00')
        self.assertEqual(result['series'][0]['aligned']['metrics']['impressionCount'],4)

    def test_validation(self):
        for mall, dates, at in [('x',['2026-10-26'],'12:00'),('1',[],'12:00'),('1',['2026-10-26'],'24:00'),('1',['2026-10-01','2026-10-08'],'12:00'),('1',['bad'],'12:00')]:
            with self.assertRaises(ValueError):
                patrol_traffic.compare(self.connect,mall,dates,at)

    def test_http_route_and_bad_request(self):
        server=backend.BoundedThreadingHTTPServer(('127.0.0.1',0),backend.Handler,max_workers=2)
        thread=threading.Thread(target=server.serve_forever,daemon=True)
        thread.start()
        try:
            with patch.object(backend,'connect',self.connect):
                base=f'http://127.0.0.1:{server.server_port}/api/patrol/traffic-compare'
                with urlopen(base+'?mall_id=1&dates=2026-10-26,2026-10-28&at=12:00') as response:
                    result=json.load(response)
                self.assertEqual(len(result['series']),2)
                self.assertTrue(result['series'][1]['aligned']['missing'])
                with self.assertRaises(HTTPError) as error:
                    urlopen(base+'?mall_id=1&dates=bad&at=12:00')
                self.assertEqual(error.exception.code,400)
        finally:
            server.shutdown();server.server_close();thread.join()


if __name__ == '__main__':
    unittest.main()
