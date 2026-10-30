import json
import sqlite3
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path

import activity_jobs
import collector
import feature_tools


class LocalFeatureToolsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "workbench.sqlite3"

        @contextmanager
        def connect():
            db = sqlite3.connect(self.path)
            db.row_factory = sqlite3.Row
            collector.init(db)
            activity_jobs.init(db)
            db.execute("CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT)")
            try:
                yield db
                db.commit()
            finally:
                db.close()

        self.connect = connect
        with self.connect() as db:
            captured = "2026-09-10T00:00:00+00:00"
            product = {
                "spuId": "1", "skcId": "10", "skuId": "11", "skuCode": "A",
                "imageUrl": "https://example.com/a.jpg", "declaredPrice": 100,
                "specification": "60.21×39.86cm", "lifecycleStatus": "在线",
            }
            activity = {
                "enrollId": "20", "spuId": "1", "skcId": "10", "skuId": "11",
                "activityName": "测试活动", "dailyPrice": 100, "activityPrice": 80,
                "discountRate": 80,
            }
            db.execute("INSERT INTO collector_records VALUES(?,?,?,?,?)", ("products", "123", '["1","10","11"]', json.dumps(product, ensure_ascii=False), captured))
            db.execute("INSERT INTO collector_records VALUES(?,?,?,?,?)", ("activities", "123", '["20","11",""]', json.dumps(activity, ensure_ascii=False), captured))

    def tearDown(self):
        self.temp.cleanup()

    def test_promotion_requires_local_floor_before_marking_candidate(self):
        preview = feature_tools.promotion_audit(self.connect, "123")
        self.assertFalse(preview["pricePresetAvailable"])
        self.assertEqual(preview["acceleratorCandidateCount"], 0)
        self.assertEqual(preview["activitySafetyPreview"][0]["lowestLocalActivityPrice"], 80)

    def test_promotion_uses_active_price_preset(self):
        config = {
            "size_prices": {
                "60.21×39.86cm": {"floor": "28.00", "target_daily": "38.00"}
            }
        }
        with self.connect() as db:
            db.execute("INSERT INTO activity_settings VALUES(?,?,?)", ("active_preset:123", "2026-09-30T00:00:00+00:00", json.dumps("默认")))
            db.execute("INSERT INTO activity_settings VALUES(?,?,?)", ("preset:123:默认", "2026-09-30T00:00:00+00:00", json.dumps(config, ensure_ascii=False)))
        preview = feature_tools.promotion_audit(self.connect, "123")
        self.assertTrue(preview["pricePresetAvailable"])
        self.assertEqual(preview["activitySafetyPreview"][0]["floor"], 28)
        self.assertEqual(preview["acceleratorCandidateCount"], 1)
        self.assertEqual(preview["acceleratorPreview"][0]["previewTargetPrice"], 80.01)

    def test_zero_sales_refuses_incomplete_order_coverage(self):
        result = feature_tools.zero_sales(self.connect, "123", "2026-09-01", "2026-09-20", "2026-09-01", "2026-09-30")
        self.assertFalse(result["safe"])
        self.assertEqual(result["items"], [])

    def test_shipping_dataset_round_trip(self):
        receipt = collector.ingest({
            "path": "/api/client/shipping/upload",
            "id": "a" * 64,
            "observed_at": "2026-09-30T00:00:00+00:00",
            "body": {
                "mall_id": "123",
                "store_name": "测试店",
                "rows": [{
                    "parent_order_sn": "P1", "package_sn": "PK1", "tracking_no": "T1",
                    "carrier": "UPS", "service_name": "Ground", "lookup_status": "found",
                    "online_shipping_amount_usd": 3.25, "source": "seller_online_shipment_api",
                }],
            },
        }, self.connect)
        self.assertEqual(receipt["dataset"], "shipping")
        snapshot = collector.snapshot(self.connect, "123")
        self.assertEqual(snapshot["counts"]["shipping"], 1)
        self.assertEqual(snapshot["records"]["shipping"][0]["online_shipping_amount_usd"], 3.25)


if __name__ == "__main__":
    unittest.main()

