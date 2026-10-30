import sqlite3
import unittest
from contextlib import contextmanager
from datetime import datetime, timezone
from unittest.mock import patch

import patrol_health as patrol


class PatrolHealthTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(':memory:')
        patrol.init(self.db)
        @contextmanager
        def connect():
            with self.db:
                yield self.db
        self.connect = connect
        self.product = {'spuId': '1', 'saleStatus': 'on_sale', 'activityStatus': 'none',
                        'acceleratorStatus': 'unknown', 'tags': ['在售']}
        self.mock = patch('product_operations.state', return_value={'products': [self.product]})
        self.mock.start()

    def tearDown(self):
        self.mock.stop()
        self.db.close()

    def test_only_on_sale_is_healthy(self):
        self.assertEqual(patrol.health_anomalies(self.connect, '123'), [])
        self.product['acceleratorStatus'] = 'disabled'
        self.assertEqual(patrol.health_anomalies(self.connect, '123'), [])

    def test_enrolled_requires_enabled(self):
        self.product['activityStatus'] = 'enrolled'
        for boost in ['disabled', 'eligible', 'max_eligible']:
            self.product['acceleratorStatus'] = boost
            self.product['accelerators'] = []
            item = patrol.health_anomalies(self.connect, '123')[0]
            self.assertEqual(item['reasons'], ['有活动无加速器'])
        self.product['acceleratorStatus'] = 'unknown'
        self.product['accelerators'] = []
        self.assertEqual(patrol.health_anomalies(self.connect, '123')[0]['reasons'], ['加速器状态无法确认'])
        self.product['acceleratorStatus'] = 'enabled'
        self.assertEqual(patrol.health_anomalies(self.connect, '123'), [])

    def test_stale_last_known_enabled_is_not_unknown_alert(self):
        self.product.update(
            activityStatus='enrolled', acceleratorStatus='unknown',
            accelerators=[{'status': 'enabled', 'freshness': {'stale': True, 'ageMinutes': 200}}])
        self.assertEqual(patrol.health_anomalies(self.connect, '123'), [])

    def test_stale_last_known_eligible_still_flags_missing_boost(self):
        self.product.update(
            activityStatus='enrolled', acceleratorStatus='unknown',
            accelerators=[{'status': 'eligible', 'freshness': {'stale': True, 'ageMinutes': 200}}])
        item = patrol.health_anomalies(self.connect, '123')[0]
        self.assertEqual(item['reasons'], ['有活动无加速器'])
        self.assertEqual(item['acceleratorResolved'], 'eligible')
        self.assertTrue(item['acceleratorFromStale'])

    def test_stale_claim_is_flagged(self):
        self.product.update(activityStatus='enrolled', acceleratorStatus='enabled', activityFreshness={'stale': True})
        self.assertIn('活动记录过期/可能误报', patrol.health_anomalies(self.connect, '123')[0]['reasons'])

    def test_shanghai_windows_and_boundaries(self):
        for hour, slot in [(8, ''), (9, 'morning'), (11, 'morning'), (12, ''), (14, 'afternoon'), (17, 'afternoon'), (18, '')]:
            self.assertEqual(patrol.windows_for(datetime(2026, 10, 28, hour))['slot'], slot)
        self.assertEqual(patrol.windows_for(datetime(2026, 10, 28, 1, tzinfo=timezone.utc))['slot'], 'morning')

    def test_clear_persists_matches_signature_and_is_store_scoped(self):
        self.product['activityStatus'] = 'enrolled'
        item = patrol.health_anomalies(self.connect, '123')[0]
        patrol.clear_alert({'mall_id': '123', 'kind': 'health', 'alert_key': item['alertKey'], 'spu_id': '1', 'note': '已核对'}, self.connect)
        self.assertTrue(patrol.health_anomalies(self.connect, '123')[0]['cleared'])
        self.assertFalse(patrol.health_anomalies(self.connect, '456')[0]['cleared'])
        self.product['acceleratorStatus'] = 'disabled'
        self.assertFalse(patrol.health_anomalies(self.connect, '123')[0]['cleared'])
        with self.assertRaises(ValueError):
            patrol.clear_alert({'mall_id': '123', 'kind': 'health', 'alert_key': item['alertKey'], 'spu_id': '1'}, self.connect)

    def test_force_modal_and_action_does_not_clear(self):
        self.product['activityStatus'] = 'enrolled'
        now = datetime(2026, 10, 28, 10)
        snap = patrol.snapshot(self.connect, '123', now)
        self.assertTrue(snap['forceModal'])
        self.assertTrue(snap['warnModal'])
        patrol.record_patrol({'mall_id': '123', 'action': 'open'}, self.connect)
        self.assertTrue(patrol.snapshot(self.connect, '123', now)['forceModal'])
        mid = patrol.snapshot(self.connect, '123', datetime(2026, 10, 28, 13))
        self.assertTrue(mid['forceModal'])  # uncleared alerts still warn off-window
        self.assertTrue(mid['warnModal'])
        self.assertFalse(mid['window']['active'])
        self.assertEqual(self.db.execute('SELECT count(*) FROM patrol_window_actions').fetchone()[0], 1)

    def test_health_includes_thumbnail(self):
        self.product.update(
            activityStatus='enrolled', acceleratorStatus='disabled',
            images=['https://img.example/a.jpg'], activityNames=['限时秒杀'],
            activityStatusLabel='已报名', saleStatusLabel='在售')
        item = patrol.health_anomalies(self.connect, '123')[0]
        self.assertEqual(item['imageUrl'], 'https://img.example/a.jpg')
        self.assertEqual(item['activityNames'], ['限时秒杀'])

    def test_snapshot_exposes_sources(self):
        self.mock.stop()
        self.product.update(activityStatus='enrolled', acceleratorStatus='disabled')
        self.mock = patch('product_operations.state', return_value={
            'products': [self.product], 'generatedAt': '2026-10-28T00:00:00+00:00',
            'sources': {'activities': {'captured': 'y', 'ageMinutes': 2, 'stale': False}}})
        self.mock.start()
        value = patrol.snapshot(self.connect, '123')
        self.assertEqual(value['sources']['activities']['ageMinutes'], 2)
        self.assertEqual(value['generatedAt'], '2026-10-28T00:00:00+00:00')

    def test_traffic_placeholder_is_separate(self):
        value = patrol.snapshot(self.connect, '123')
        self.assertFalse(value['trafficAttention']['available'])
        self.assertEqual(value['trafficAttention']['items'], [])


if __name__ == '__main__':
    unittest.main()
