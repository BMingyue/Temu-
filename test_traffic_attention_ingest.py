import json
import sqlite3
import unittest
from contextlib import contextmanager

import collector


class TrafficAttentionIngestTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(':memory:')
        self.db.row_factory = sqlite3.Row
        collector.init(self.db)

        @contextmanager
        def connect():
            with self.db:
                yield self.db
        self.connect = connect

    def tearDown(self):
        self.db.close()

    def row(self, flag=True, code=2):
        return {'spuId': '100001', 'siteName': '美国站', 'status': 'disabled',
                'sourceUrl': 'https://agentseller-us.temu.com/main/flux-analysis',
                'trafficAttention': flag, 'flowLimitStatus': code,
                'trafficAttentionSource': 'temu_native_flow_limit_v1',
                'trafficAttentionLabel': '商品流量待关注'}

    def ingest(self, row):
        return collector.ingest({'id': 'a' * 64, 'path': '/api/client/products/accelerators/upload',
                                 'observed_at': '2026-11-01T11:00:00+00:00',
                                 'body': {'mall_id': '123', 'source_mall_id': '123', 'rows': [row]}}, self.connect)

    def test_explicit_attention_round_trips_alongside_accelerator_state(self):
        self.ingest(self.row())
        stored = json.loads(self.db.execute("SELECT payload FROM collector_records WHERE dataset='accelerators'").fetchone()[0])
        self.assertTrue(stored['trafficAttention'])
        self.assertEqual(stored['flowLimitStatus'], 2)
        self.assertEqual(stored['trafficAttentionSource'], 'temu_native_flow_limit_v1')
        self.assertEqual(stored['status'], 'disabled')

    def test_false_requires_an_explicit_non_attention_native_code(self):
        for code in (0, 1, 3):
            self.assertIsInstance(collector.key_for('accelerators', self.row(False, code)), str)
        for patch in ({'trafficAttention': False}, {'flowLimitStatus': 0}, {'flowLimitStatus': '2'},
                      {'flowLimitStatus': True}, {'trafficAttention': 'true'}, {'trafficAttentionSource': 'guess'},
                      {'trafficAttentionSource': ''}, {'flowLimitStatus': 4}):
            with self.subTest(patch=patch), self.assertRaises(ValueError):
                collector.key_for('accelerators', {**self.row(), **patch})

    def test_unknown_and_legacy_rows_remain_accepted_without_claiming_clear(self):
        unknown = {**self.row(), 'trafficAttention': None, 'flowLimitStatus': None,
                   'trafficAttentionSource': '', 'trafficAttentionLabel': ''}
        self.ingest(unknown)
        stored = json.loads(self.db.execute("SELECT payload FROM collector_records WHERE dataset='accelerators'").fetchone()[0])
        self.assertIsNone(stored['trafficAttention'])
        legacy = {key: value for key, value in self.row().items()
                  if key not in ('trafficAttention', 'flowLimitStatus', 'trafficAttentionSource', 'trafficAttentionLabel')}
        self.assertIsInstance(collector.key_for('accelerators', legacy), str)
        with self.assertRaises(ValueError):
            collector.key_for('accelerators', {**unknown, 'flowLimitStatus': 2})

    def test_known_attention_must_have_the_exact_us_native_list_source(self):
        for patch in ({'siteName': '英国站'}, {'sourceUrl': 'https://agentseller.temu.com/main/flux-analysis'},
                      {'sourceUrl': 'https://agentseller-us.temu.com/goods/list'},
                      {'sourceUrl': 'https://agentseller-us.temu.com.evil.test/main/flux-analysis'}):
            with self.subTest(patch=patch), self.assertRaises(ValueError):
                collector.key_for('accelerators', {**self.row(), **patch})


if __name__ == '__main__':
    unittest.main()
