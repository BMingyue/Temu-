import json
import sqlite3
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path

import collector


class CollectorSnapshotTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.path = Path(self.folder.name) / 'collector.sqlite3'

        @contextmanager
        def connect():
            db = sqlite3.connect(self.path)
            db.row_factory = sqlite3.Row
            collector.init(db)
            try:
                yield db
                db.commit()
            finally:
                db.close()

        self.connect = connect

    def tearDown(self):
        self.folder.cleanup()

    def ingest(self, batch_id, observed, rows, total, collected, complete=True):
        return collector.ingest({
            'id': batch_id * 64,
            'path': '/api/client/products/upload',
            'observed_at': observed,
            'body': {
                'mall_id': '10001',
                'store_name': 'snapshot-shop',
                'rows': rows,
                'crawl_result': {
                    'source': 'browser_extension',
                    'total': total,
                    'collected_skc_count': collected,
                    'complete': complete,
                },
            },
        }, self.connect)

    def test_latest_complete_snapshot_replaces_current_membership_only(self):
        first = [
            {'spuId': '1', 'skcId': '11', 'skuId': '111'},
            {'spuId': '1', 'skcId': '11', 'skuId': '112'},
            {'spuId': '2', 'skcId': '22', 'skuId': '221'},
        ]
        second = [{'spuId': '3', 'skcId': '33', 'skuId': '331'}]
        self.ingest('a', '2026-10-20T00:00:00+00:00', first, 2, 2)
        receipt = self.ingest('b', '2026-10-21T00:00:00+00:00', second, 1, 1)

        self.assertTrue(receipt['current_snapshot'])
        with self.connect() as db:
            current = [json.loads(row['payload']) for row in collector.current_records(db, 'products', '10001')]
            history_count = db.execute("SELECT COUNT(*) FROM collector_records WHERE dataset='products' AND mall_id='10001'").fetchone()[0]
        self.assertEqual([row['skuId'] for row in current], ['331'])
        self.assertEqual(history_count, 4)

    def test_incomplete_batch_does_not_replace_current_snapshot(self):
        stable = [{'spuId': '1', 'skcId': '11', 'skuId': '111'}]
        partial = [{'spuId': '2', 'skcId': '22', 'skuId': '221'}]
        self.ingest('c', '2026-10-20T00:00:00+00:00', stable, 1, 1)
        receipt = self.ingest('d', '2026-10-21T00:00:00+00:00', partial, 2, 1, complete=False)

        self.assertFalse(receipt['current_snapshot'])
        with self.connect() as db:
            current = [json.loads(row['payload']) for row in collector.current_records(db, 'products', '10001')]
        self.assertEqual([row['skuId'] for row in current], ['111'])


if __name__ == '__main__':
    unittest.main()
