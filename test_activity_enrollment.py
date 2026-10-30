import json
import sqlite3
import unittest
from contextlib import contextmanager
from datetime import datetime, timezone

import activity_enrollment
import activity_jobs
import collector


class EnrollmentTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(':memory:')
        self.db.row_factory = sqlite3.Row
        self.captured = datetime.now(timezone.utc).isoformat()
        collector.init(self.db)
        activity_jobs.init(self.db)
        activity_enrollment.init(self.db)
        @contextmanager
        def connect():
            with self.db:
                yield self.db
        self.connect = connect
        self.add_product()
        self.evidence(referenceActivityPrice='60', adjustable=None)
        activity_jobs.save_settings({'config': {'size_prices': {
            '120.05×45.22cm': {'floor': '50', 'target_daily': '80', 'match_min': '79', 'match_max': '81'}
        }}}, self.connect)

    def tearDown(self):
        self.db.close()

    def add_product(self):
        product = {'spuId':'SPU1','skcId':'SKC1','skuId':'SKU1','skuCode':'CODE1','declaredPrice':80}
        self.db.execute('INSERT INTO collector_records VALUES(?,?,?,?,?)', ('products','100',json.dumps(['SPU1','SKC1','SKU1']),json.dumps(product),self.captured))

    def evidence(self, **patch):
        candidate={'spuId':'SPU1','skcId':'SKC1','skuId':'SKU1','skuCode':'CODE1','specification':'120.05×45.22cm','dailyPrice':'80','referenceActivityPrice':'60','referenceStock':30,'eligible':True,'adjustable':None}
        candidate.update(patch)
        return activity_jobs.ingest_evidence({'mall_id':'100','campaign_id':'CAMPAIGN1','captured':self.captured,'candidates':[candidate]},self.connect)

    def preview(self):
        return activity_enrollment.prepare({'mall_id': '100', 'campaign_id': 'CAMPAIGN1', 'product_keys': ['SPU1|SKC1']}, self.connect)

    def test_prepare_exact_safe_product(self):
        preview = self.preview()
        self.assertEqual(preview['product_count'], 1)
        self.assertEqual(preview['sku_count'], 1)
        self.assertEqual(preview['products'][0]['items'][0]['activityPrice'], '60.00')
        self.assertEqual(preview['products'][0]['inventory'], 30)

    def test_preview_uses_recovered_candidates_after_catalog_refresh(self):
        self.db.execute("DELETE FROM activity_evidence_snapshots")
        self.db.execute("DELETE FROM collector_records")
        self.evidence(skcId="", skuId="", skuCode="")
        self.add_product()
        preview = self.preview()
        self.assertEqual(preview["products"][0]["items"][0]["skuId"], "SKU1")
        self.assertEqual(preview["status"], "preview")

    def test_unresolved_sibling_blocks_partial_product_preview(self):
        snapshot = self.db.execute("SELECT * FROM activity_evidence_snapshots").fetchone()
        payload = json.loads(snapshot["payload"])
        sibling = {**payload["candidates"][0], "skuId": "", "skuCode": "", "dailyPrice": "81.00"}
        sibling.pop("sourceIdentity", None)
        payload["unresolved_candidates"] = [sibling]
        self.db.execute("UPDATE activity_evidence_snapshots SET payload=?", (json.dumps(payload),))
        with self.assertRaisesRegex(ValueError, "不完整"):
            self.preview()

    def test_confirmation_and_single_claim(self):
        preview = self.preview()
        with self.assertRaises(ValueError):
            activity_enrollment.enqueue({'batch_id': preview['id'], 'confirmation': '确认报名2个商品'}, self.connect)
        activity_enrollment.enqueue({'batch_id': preview['id'], 'confirmation': '确认报名1个商品'}, self.connect)
        claimed = activity_enrollment.bridge({'action': 'poll', 'mall_id': '100', 'campaign_id': 'CAMPAIGN1'}, self.connect)['command']
        self.assertEqual(claimed['id'], preview['id'])
        self.assertIsNone(activity_enrollment.bridge({'action': 'poll', 'mall_id': '100', 'campaign_id': 'CAMPAIGN1'}, self.connect)['command'])
        activity_enrollment.bridge({'action': 'report', 'id': preview['id'], 'claim_token': claimed['claim_token'], 'status': 'submission_attempted', 'message': 'clicked'}, self.connect)
        activity_enrollment.bridge({'action': 'report', 'id': preview['id'], 'claim_token': claimed['claim_token'], 'status': 'platform_acknowledged', 'message': 'success'}, self.connect)
        state = activity_enrollment.snapshot(self.connect)
        self.assertEqual(state['batches'][0]['status'], 'platform_acknowledged')
        self.assertIsNone(state['batches'][0]['claim_token'])

    def test_poll_records_activity_page_heartbeat_without_a_batch(self):
        response = activity_enrollment.bridge({'action': 'poll', 'mall_id': '100', 'campaign_id': 'CAMPAIGN1', 'collector_version': '0.12.1'}, self.connect)
        self.assertIsNone(response['command'])
        clients = activity_enrollment.snapshot(self.connect)['clients']
        self.assertEqual([(row['mall_id'], row['campaign_id']) for row in clients], [('100', 'CAMPAIGN1')])
        self.assertEqual(clients[0]['collector_version'], '0.12.1')

    def test_unsafe_product_cannot_prepare(self):
        activity_jobs.save_settings({'config': {'size_prices': {
            '120.05×45.22cm': {'floor': '70', 'target_daily': '80', 'match_min': '100', 'match_max': '101'}
        }}}, self.connect)
        with self.assertRaises(ValueError):
            self.preview()

    def test_changed_settings_invalidate_preview(self):
        preview = self.preview()
        activity_jobs.save_settings({'config': {'size_prices': {
            '120.05×45.22cm': {'floor': '51', 'target_daily': '80', 'match_min': '79', 'match_max': '81'}
        }}}, self.connect)
        with self.assertRaises(ValueError):
            activity_enrollment.enqueue({'batch_id': preview['id'], 'confirmation': '确认报名1个商品'}, self.connect)


if __name__ == '__main__':
    unittest.main()
