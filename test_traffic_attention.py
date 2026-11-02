"""Official traffic badge and independent patrol queues, with in-memory data only."""
import hashlib
import json
import sqlite3
import unittest
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone

import activity_jobs
import collector
import patrol_health
import product_operations as ops


class TrafficAttentionTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(':memory:')
        self.db.row_factory = sqlite3.Row
        collector.init(self.db)
        activity_jobs.init(self.db)
        patrol_health.init(self.db)
        self.now = datetime.now(timezone.utc)
        self.seq = 0

        @contextmanager
        def connect():
            with self.db:
                yield self.db
        self.connect = connect

    def tearDown(self):
        self.db.close()

    def upload(self, kind, rows, mall='123', when=None):
        self.seq += 1
        identity = 'skcId' if kind == 'products' else 'enrollId'
        count = len({row.get(identity) for row in rows})
        meta = {'source': 'browser_extension', 'source_mall_id': mall, 'complete': True,
                'total': count, 'sale_scope': 'on_sale', 'enrollment_scope': 'all',
                'collected_skc_count': count, 'enrollment_count': count}
        path = {'products': '/api/client/products/upload',
                'activities': '/api/client/products/activities/upload',
                'accelerators': '/api/client/products/accelerators/upload'}[kind]
        collector.ingest({'id': hashlib.sha256(str(self.seq).encode()).hexdigest(),
                          'observed_at': (when or self.now).isoformat(), 'path': path,
                          'body': {'mall_id': mall, 'source_mall_id': mall, 'rows': rows,
                                   'crawl_result': meta}}, self.connect)

    def catalog(self, ids=('100001',), mall='123'):
        self.upload('products', [{'spuId': spu, 'skcId': '2' + spu, 'skuId': '3' + spu,
                                  'onSale': True, 'imageUrl': 'https://img.example/test.png'}
                                 for spu in ids], mall=mall)

    def activities(self, ids=('100001',), mall='123'):
        self.upload('activities', [{'enrollId': '4' + spu, 'spuId': spu, 'skcId': '2' + spu,
                                   'skuId': '3' + spu, 'activityName': '限时秒杀',
                                   'statusKey': 'active', 'sessionStatus': 2} for spu in ids], mall=mall)

    def boost(self, code=2, spu='100001', status='disabled', **changes):
        row = {'spuId': spu, 'skuId': '', 'siteName': '美国站', 'status': status,
               'sourceUrl': 'https://agentseller-us.temu.com/main/flux-analysis',
               'trafficAttention': code == 2, 'flowLimitStatus': code,
               'trafficAttentionSource': ops.TRAFFIC_ATTENTION_SOURCE,
               'trafficAttentionLabel': ops.FLOW_LIMIT_LABELS.get(code, '')}
        row.update(changes)
        return row

    def observation(self, code=2, when=None, **changes):
        return {**self.boost(code, **changes), '_captured': (when or self.now).isoformat()}

    def test_exact_official_numeric_mapping_not_other_badges(self):
        for code in range(4):
            with self.subTest(code=code):
                value = ops.traffic_attention_state([self.observation(code)], self.now)
                self.assertEqual(value['status'], 'attention' if code == 2 else 'clear')
                self.assertEqual(value['rawStatus'], code)
                self.assertEqual(value['label'], ops.FLOW_LIMIT_LABELS[code])

    def test_unknown_stale_invalid_scope_and_no_metric_inference(self):
        legacy = {k: v for k, v in self.observation().items()
                  if k not in ('trafficAttention', 'flowLimitStatus', 'trafficAttentionSource', 'trafficAttentionLabel')}
        legacy.update(exposure=0, clicks=0, evidence='商品流量待关注', status='disabled')
        cases = [[], [legacy], [self.observation(when=self.now - timedelta(minutes=721))],
                 [self.observation(flowLimitStatus='2')], [self.observation(flowLimitStatus=True)],
                 [self.observation(trafficAttention=False)], [self.observation(trafficAttentionSource='guess')],
                 [self.observation(siteName='英国站')],
                 [self.observation(sourceUrl='https://agentseller.temu.com/main/flux-analysis')],
                 [{**self.observation(), '_captured': 'not-a-date'}],
                 [self.observation(flowLimitStatus=None, trafficAttention=None,
                                   trafficAttentionSource='', trafficAttentionLabel='')]]
        for rows in cases:
            with self.subTest(rows=rows):
                self.assertEqual(ops.traffic_attention_state(rows, self.now)['status'], 'unknown')

    def test_latest_clear_and_explicit_unknown_do_not_fall_back(self):
        previous = self.observation(when=self.now - timedelta(minutes=5))
        clear = self.observation(0)
        self.assertEqual(ops.traffic_attention_state([previous, clear], self.now)['status'], 'clear')
        unknown = self.observation(flowLimitStatus=None, trafficAttention=None,
                                   trafficAttentionSource='', trafficAttentionLabel='')
        self.assertEqual(ops.traffic_attention_state([previous, unknown], self.now)['status'], 'unknown')
        # A newer boost-only row does not claim to have read the independent badge.
        legacy = {k: v for k, v in self.observation().items()
                  if k not in ('trafficAttention', 'flowLimitStatus', 'trafficAttentionSource', 'trafficAttentionLabel')}
        self.assertEqual(ops.traffic_attention_state([previous, legacy], self.now)['status'], 'attention')

    def test_same_observation_conflict_is_unknown(self):
        self.assertEqual(ops.traffic_attention_state(
            [self.observation(2), self.observation(0, skuId='300002')], self.now)['status'], 'unknown')

    def test_ingest_to_product_and_patrol_routes_badge_out_of_health(self):
        self.catalog(('100001', '100002'))
        self.activities(('100001', '100002'))
        self.upload('accelerators', [self.boost(), self.boost(0, spu='100002')])
        value = ops.state(self.connect, '123')
        self.assertEqual(value['counts']['trafficAttention'], 1)
        self.assertEqual(value['counts']['acceleratorSwitchDisabled'], 2)
        self.assertEqual(value['counts']['trafficAttentionUnknown'], 0)
        state = patrol_health.snapshot(self.connect, '123')
        self.assertEqual([i['spuId'] for i in state['health']['items']], ['100002'])
        traffic = state['trafficAttention']
        self.assertEqual([i['spuId'] for i in traffic['items']], ['100001'])
        self.assertEqual(traffic['items'][0]['kind'], 'traffic_attention')
        self.assertEqual(traffic['items'][0]['flowLimitStatus'], 2)
        self.assertEqual(traffic['coverage'], {'total': 2, 'observed': 2, 'fresh': 2,
                                              'attention': 1, 'clear': 1, 'unknown': 0, 'stale': 0})

    def test_badge_does_not_require_activity_or_disabled_accelerator(self):
        self.catalog()
        self.upload('accelerators', [self.boost(status='enabled')])
        state = patrol_health.snapshot(self.connect, '123')
        self.assertEqual(state['health']['items'], [])
        self.assertEqual(state['trafficAttention']['unclearedCount'], 1)
        self.assertTrue(state['warnModal'])
        self.assertTrue(state['forceModal'])

    def test_unknown_keeps_ordinary_health_and_partial_coverage_visible(self):
        self.catalog(('100001', '100002', '100003'))
        self.activities(('100001', '100002', '100003'))
        self.upload('accelerators', [self.boost(), self.boost(0, spu='100002'),
                                    self.boost(spu='100003', flowLimitStatus=None, trafficAttention=None,
                                               trafficAttentionSource='', trafficAttentionLabel='')])
        state = patrol_health.snapshot(self.connect, '123')
        self.assertEqual({i['spuId'] for i in state['health']['items']}, {'100002', '100003'})
        self.assertTrue(state['trafficAttention']['available'])
        self.assertEqual(state['trafficAttention']['coverage']['unknown'], 1)
        self.assertIn('1', state['trafficAttention']['gap'])

    def test_clear_is_store_and_kind_scoped_and_does_not_return_to_health(self):
        for mall in ('123', '456'):
            self.catalog(mall=mall)
            self.activities(mall=mall)
            self.upload('accelerators', [self.boost()], mall=mall)
        item = patrol_health.snapshot(self.connect, '123')['trafficAttention']['items'][0]
        before = self.db.execute('SELECT payload FROM collector_records ORDER BY dataset,mall_id,item_key').fetchall()
        patrol_health.clear_alert({'mall_id': '123', 'kind': 'traffic_attention',
                                   'alert_key': item['alertKey'], 'spu_id': item['spuId']}, self.connect)
        after = self.db.execute('SELECT payload FROM collector_records ORDER BY dataset,mall_id,item_key').fetchall()
        self.assertEqual([r[0] for r in before], [r[0] for r in after])
        state = patrol_health.snapshot(self.connect, '123')
        self.assertEqual(state['health']['items'], [])
        self.assertTrue(state['trafficAttention']['items'][0]['cleared'])
        self.assertFalse(state['warnModal'])
        self.assertFalse(patrol_health.snapshot(self.connect, '456')['trafficAttention']['items'][0]['cleared'])
        with self.assertRaises(ValueError):
            patrol_health.clear_alert({'mall_id': '123', 'kind': 'health',
                                       'alert_key': item['alertKey'], 'spu_id': item['spuId']}, self.connect)

    def test_new_unknown_invalidates_old_sku_positive_and_preserves_switch(self):
        self.catalog()
        self.activities()
        self.upload('accelerators', [self.boost(skuId='300001')], when=self.now-timedelta(minutes=5))
        self.upload('accelerators', [self.boost(flowLimitStatus=None, trafficAttention=None,
                                               trafficAttentionSource='', trafficAttentionLabel='')])
        product = ops.state(self.connect, '123')['products'][0]
        self.assertEqual(product['trafficAttentionStatus'], 'unknown')
        self.assertEqual(product['acceleratorSwitchStatus'], 'disabled')
        self.assertEqual(len(patrol_health.snapshot(self.connect, '123')['health']['items']), 1)

    def test_missing_or_stale_never_means_no_badge(self):
        self.catalog()
        state = patrol_health.snapshot(self.connect, '123')
        self.assertFalse(state['trafficAttention']['available'])
        self.assertEqual(state['trafficAttention']['coverage']['unknown'], 1)
        self.upload('accelerators', [self.boost()], when=self.now-timedelta(minutes=721))
        state = patrol_health.snapshot(self.connect, '123')
        self.assertFalse(state['trafficAttention']['available'])
        self.assertEqual(state['trafficAttention']['coverage']['stale'], 1)
        self.assertEqual(state['trafficAttention']['items'], [])

    def test_only_current_on_sale_scope_and_selected_store_are_joined(self):
        self.catalog(('100001', '100002'))
        self.upload('accelerators', [self.boost(), self.boost(spu='100002')])
        self.catalog(('100002',))
        self.catalog(mall='456')
        self.upload('accelerators', [self.boost(0)], mall='456')
        traffic = patrol_health.snapshot(self.connect, '123')['trafficAttention']
        self.assertEqual([i['spuId'] for i in traffic['items']], ['100002'])
        self.assertEqual(traffic['coverage']['total'], 1)
        self.assertEqual(patrol_health.snapshot(self.connect, '456')['trafficAttention']['items'], [])


if __name__ == '__main__':
    unittest.main()
