import json
import sqlite3
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path

import collector
import collector_control


class DailyAuditTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.data = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def connect(self):
        path = self.data / 'workbench.sqlite3'

        @contextmanager
        def connection():
            db = sqlite3.connect(path)
            db.row_factory = sqlite3.Row
            collector.init(db)
            try:
                yield db
                db.commit()
            finally:
                db.close()

        return connection

    def test_daily_audit_is_saved_by_shop_and_day(self):
        connect = self.connect()
        receipt = collector.ingest({
            'id': 'd' * 64,
            'path': '/api/client/daily-audits',
            'observed_at': '2026-10-12T11:30:00+08:00',
            'body': {
                'mall_id': '10001',
                'store_name': 'daily-shop',
                'collector_browser': 'Edge',
                'collector_client_id': 'edgeclient01',
                'rows': [{
                    'date': '2026-10-12',
                    'captured_at': '2026-10-12T11:30:00+08:00',
                    'status': 'finished',
                    'traffic': {'realtime': {}, 'one_day': {}},
                    'consultations': {'has_unreplied': False},
                    'orders': {'cancelled_count': 0, 'logistics_exception_count': 0, 'overdue_shipment_count': 0},
                    'steps': [],
                    'warnings': [],
                    'source_urls': {},
                    'customer_address': 'must not survive allow-listing',
                }],
            },
        }, connect)
        self.assertEqual(receipt['dataset'], 'daily')
        snapshot = collector.daily_audits(connect, '10001')
        self.assertEqual(snapshot['latest']['date'], '2026-10-12')
        self.assertNotIn('customer_address', snapshot['latest'])
        self.assertEqual(snapshot['latest']['orders']['overdue_shipment_count'], 0)

    def test_daily_command_is_claimed_only_by_target_browser(self):
        collector_control.request(self.data, {
            'mall_id': '10001',
            'client_id': 'edgeclient01',
            'task_type': 'daily_audit',
        })
        wrong = collector_control.bridge(self.data, {
            'client_id': 'chromeclient1', 'mall_id': '10001', 'browser': 'Chrome',
            'store_name': 'shop', 'version': '0.18.3', 'claim': True,
        })
        right = collector_control.bridge(self.data, {
            'client_id': 'edgeclient01', 'mall_id': '10001', 'browser': 'Edge',
            'store_name': 'shop', 'version': '0.18.3', 'claim': True,
        })
        self.assertIsNone(wrong['command'])
        self.assertEqual(right['command']['kind'], 'daily_audit')
        self.assertEqual(right['command']['claimed_by'], 'edgeclient01')

    def test_legacy_daily_result_uses_verified_badges_and_hides_false_cancelled_rows(self):
        row = collector.display_daily({
            'consultations': {'status': 'partial', 'page_recognized': False, 'has_unreplied': False, 'unreplied_count': 0, 'has_attention': True, 'attention_count': 2},
            'orders': {
                'cancelled_count': 2571, 'cancelled_recent_count': 2571, 'cancelled_visible_count': 67,
                'logistics_exception_count': 16,
                'cancelled_orders': [
                    {'order_sn': 'wrong', 'status': 'TAIL_CHANNEL'},
                    {'order_sn': 'right', 'status': '已取消'},
                ],
            },
            'steps': [
                {'id': 'cancelled', 'message': '近30日检测到 2571 个已取消订单'},
                {'id': 'exceptions', 'message': '检测到 0 个物流异常订单'},
            ],
        })
        self.assertEqual(row['orders']['cancelled_count'], 67)
        self.assertEqual(row['orders']['cancelled_pool_count'], 2571)
        self.assertEqual([item['order_sn'] for item in row['orders']['cancelled_orders']], ['right'])
        self.assertIsNone(row['consultations']['has_unreplied'])
        self.assertTrue(row['consultations']['has_attention'])
        self.assertEqual(row['consultations']['attention_count'], 2)
        self.assertIn('67', row['steps'][0]['message'])
        self.assertIn('16', row['steps'][1]['message'])

    def test_old_extension_cannot_claim_daily_command(self):
        collector_control.request(self.data, {
            'mall_id': '10001', 'task_type': 'daily_audit',
        })
        old = collector_control.bridge(self.data, {
            'client_id': 'oldchrome01', 'mall_id': '10001', 'browser': 'Chrome',
            'store_name': 'shop', 'version': '0.18.2', 'claim': True,
        })
        new = collector_control.bridge(self.data, {
            'client_id': 'newchrome01', 'mall_id': '10001', 'browser': 'Chrome',
            'store_name': 'shop', 'version': '0.18.3', 'claim': True,
        })
        self.assertIsNone(old['command'])
        self.assertEqual(new['command']['kind'], 'daily_audit')

    def test_extension_contains_read_only_daily_runner(self):
        root = Path(__file__).resolve().parent / 'browser_extension'
        manifest = json.loads((root / 'manifest.json').read_text(encoding='utf-8'))
        self.assertGreaterEqual(tuple(map(int, manifest['version'].split('.'))), (0, 18, 1))
        worker = (root / 'service-worker.js').read_text(encoding='utf-8')
        runner = (root / 'workbench-daily-audit.js').read_text(encoding='utf-8')
        bridge = (root / 'page-bridge.js').read_text(encoding='utf-8')
        self.assertIn('workbench-daily-audit.js', worker)
        self.assertIn("path:'/api/client/daily-audits'", runner)
        self.assertIn("ORDER_AUDIT:orderAudit", bridge)
        self.assertIn('statuses.find((status) => /已取消|取消成功|cancelled|canceled/i.test(status))', bridge)
        self.assertIn("has_unreplied:definitive.length?has:null", runner)
        self.assertIn('wbAuditScanServiceAlerts', runner)
        self.assertIn("['售前/售后工单'", runner)
        self.assertIn('has_attention:hasAttention', runner)
        self.assertNotIn('innerHTML=', runner)


if __name__ == '__main__':
    unittest.main()
