"""Twelve-hour data validity remains separate from the collection schedule."""
import hashlib
import sqlite3
import unittest
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone

import activity_jobs
import collector
import product_operations as ops


class SnapshotValidityTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(':memory:')
        self.db.row_factory = sqlite3.Row
        collector.init(self.db)
        activity_jobs.init(self.db)
        self.now = datetime.now(timezone.utc)
        self.sequence = 0

        @contextmanager
        def connect():
            with self.db:
                yield self.db
        self.connect = connect

    def tearDown(self):
        self.db.close()

    def upload(self, kind, rows, captured):
        self.sequence += 1
        identity = 'skcId' if kind == 'products' else 'enrollId'
        count = len({r.get(identity) for r in rows})
        meta = {'source': 'browser_extension', 'source_mall_id': '123', 'complete': True,
                'total': count, 'sale_scope': 'on_sale', 'enrollment_scope': 'all',
                'collected_skc_count': count, 'enrollment_count': count}
        path = {'products': '/api/client/products/upload',
                'activities': '/api/client/products/activities/upload',
                'accelerators': '/api/client/products/accelerators/upload'}[kind]
        collector.ingest({'id': hashlib.sha256(str(self.sequence).encode()).hexdigest(),
                          'observed_at': captured.isoformat(), 'path': path,
                          'body': {'mall_id': '123', 'source_mall_id': '123', 'rows': rows,
                                   'crawl_result': meta}}, self.connect)

    def test_three_hours_and_exact_twelve_hours_are_valid(self):
        for age in (timedelta(minutes=151), timedelta(hours=3), timedelta(hours=12)):
            with self.subTest(age=age):
                self.assertFalse(ops.freshness((self.now-age).isoformat(), self.now)['stale'])

    def test_only_after_twelve_hours_is_stale(self):
        self.assertTrue(ops.freshness((self.now-timedelta(hours=12, seconds=1)).isoformat(), self.now)['stale'])

    def test_missing_and_invalid_capture_still_unknown(self):
        for captured in ('', 'invalid', '2026-11-01T00:00:00'):
            self.assertTrue(ops.freshness(captured, self.now)['stale'])

    def test_catalog_target_gate_accepts_twelve_hours_then_rejects(self):
        self.upload('products', [{'spuId': '100001', 'skcId': '200001', 'skuId': '300001'}],
                    self.now-timedelta(hours=12))
        self.assertEqual(ops.accelerator_targets(self.connect, '123', self.now)['spuIds'], ['100001'])
        with self.assertRaisesRegex(ValueError, '12小时'):
            ops.accelerator_targets(self.connect, '123', self.now+timedelta(seconds=1))

    def test_official_badge_uses_the_same_twelve_hour_boundary(self):
        observation = {'siteName': '美国站', 'trafficAttentionSource': ops.TRAFFIC_ATTENTION_SOURCE,
                       'trafficAttention': True, 'flowLimitStatus': 2,
                       'sourceUrl': 'https://agentseller-us.temu.com/main/flux-analysis',
                       '_captured': (self.now-timedelta(hours=12)).isoformat()}
        self.assertEqual(ops.traffic_attention_state([observation], self.now)['status'], 'attention')
        expired = ops.traffic_attention_state([observation], self.now+timedelta(seconds=1))
        self.assertEqual(expired['status'], 'unknown')
        self.assertIn('12小时', expired['reason'])

    def test_product_activity_and_accelerator_statuses_remain_valid_at_three_hours(self):
        captured = self.now-timedelta(hours=3)
        self.upload('products', [{'spuId': '100001', 'skcId': '200001', 'skuId': '300001'}], captured)
        self.upload('activities', [{'enrollId': '400001', 'spuId': '100001', 'skcId': '200001',
                                    'skuId': '300001', 'activityName': '限时秒杀', 'statusKey': 'active',
                                    'sessionStatus': 2}], captured)
        self.upload('accelerators', [{'spuId': '100001', 'skuId': '', 'siteName': '美国站',
                                      'status': 'disabled', 'trafficAttention': True, 'flowLimitStatus': 2,
                                      'trafficAttentionSource': ops.TRAFFIC_ATTENTION_SOURCE,
                                      'sourceUrl': 'https://agentseller-us.temu.com/main/flux-analysis'}], captured)
        state = ops.state(self.connect, '123')
        product = state['products'][0]
        self.assertFalse(product['freshness']['stale'])
        self.assertFalse(product['activityFreshness']['stale'])
        self.assertFalse(product['accelerators'][0]['freshness']['stale'])
        self.assertFalse(product['trafficAttentionFreshness']['stale'])
        self.assertEqual(product['acceleratorSwitchStatus'], 'disabled')
        self.assertEqual(product['trafficAttentionStatus'], 'attention')
        self.assertEqual(state['freshnessWindowMinutes'], 720)
        self.assertEqual(state['collectionIntervalMinutes'], 120)


if __name__ == '__main__':
    unittest.main()
