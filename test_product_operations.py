import hashlib
import json
import sqlite3
import unittest
from contextlib import contextmanager
from datetime import datetime, timezone, timedelta

import activity_jobs
import collector
import product_operations
import feature_tools


class ProductOperationsTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.row_factory = sqlite3.Row
        collector.init(self.db)
        activity_jobs.init(self.db)
        self.captured = datetime.now(timezone.utc).isoformat()
        self.sequence = 0

        @contextmanager
        def connect():
            with self.db:
                yield self.db
        self.connect = connect

    def tearDown(self):
        self.db.close()

    def product(self, spu="100001", skc="200001", sku="300001", **patch):
        return {"spuId": spu, "skcId": skc, "skuId": sku, "declaredPrice": 80, **patch}

    def upload(self, rows, kind="products", mall="123", complete=True, captured=None, meta=None):
        self.sequence += 1
        key = "collected_skc_count" if kind == "products" else "enrollment_count"
        identity = "skcId" if kind == "products" else "enrollId"
        count = len({row.get(identity) for row in rows})
        path = "/api/client/products/upload" if kind == "products" else "/api/client/products/activities/upload" if kind == "activities" else "/api/client/products/accelerators/upload"
        scope = {"source": "browser_extension", "source_mall_id": mall, "complete": complete, "total": count, key: count}
        if kind == "products":
            scope["sale_scope"] = "on_sale"
        scope.update(meta or {})
        return collector.ingest({"id": hashlib.sha256(str(self.sequence).encode()).hexdigest(),
                                 "observed_at": captured or self.captured, "path": path,
                                 "body": {"mall_id": mall, "source_mall_id": mall, "rows": rows, "crawl_result": scope}}, self.connect)

    def state(self, mall="123"):
        return product_operations.state(self.connect, mall)

    def boost(self, status="enabled", **patch):
        return {"spuId": "100001", "skuId": "", "siteName": "美国站", "status": status,
                "price": None, "currency": "", "sourceUrl": "https://agentseller-us.temu.com/main/flux-analysis", **patch}

    def activity(self, **patch):
        return {"enrollId": "400001", "spuId": "100001", "skcId": "200001", "skuId": "300001",
                "activityName": "黑五", "siteName": "美国站", "siteId": "100", "dailyPrice": 80,
                "activityPrice": 60, "currency": "CNY", "statusKey": "active", "sessionStatus": 2, **patch}

    def test_full_on_sale_snapshot_classifies_legacy_blank_status(self):
        self.upload([self.product()])
        data = self.state()
        self.assertEqual(data["counts"]["onSale"], 1)
        self.assertEqual(data["products"][0]["skuCount"], 1)
        self.assertEqual(feature_tools.catalog(self.connect, "123")["productCount"], 1)

    def test_absence_moves_spu_to_minimal_trash_and_relisting_restores_it(self):
        self.upload([self.product(), self.product("100002", "200002", "300002")])
        self.upload([self.product()])
        data = self.state()
        self.assertEqual(data["counts"]["notOnSale"], 1)
        self.assertEqual(data["trash"][0]["spuId"], "100002")
        self.assertNotIn("skus", data["trash"][0])
        self.assertEqual(feature_tools.catalog(self.connect, "123")["productCount"], 1)
        self.upload([self.product(), self.product("100002", "200002", "300002")])
        self.assertEqual(self.state()["trash"], [])

    def test_partial_snapshot_does_not_remove_unseen_spu(self):
        self.upload([self.product(), self.product("100002", "200002", "300002")])
        self.upload([self.product()], complete=False, meta={"total": 2})
        self.assertEqual(self.state()["counts"]["onSale"], 2)

    def test_complete_empty_catalog_moves_all_known_spus_to_trash(self):
        self.upload([self.product()])
        self.upload([])
        self.assertEqual(self.state()["counts"]["onSale"], 0)
        self.assertEqual(self.state()["counts"]["notOnSale"], 1)

    def test_unknown_empty_status_without_verified_scope_is_not_active(self):
        self.upload([self.product()], complete=False)
        self.assertEqual(self.state()["counts"]["unknown"], 1)
        self.assertEqual(feature_tools.catalog(self.connect, "123")["products"], [])

    def test_official_non_sale_states_and_mixed_spu(self):
        self.upload([self.product(lifecycleStatus="未发布到站点"),
                     self.product("100001", "200002", "300002", onSale=True),
                     self.product("100002", "200003", "300003", lifecycleStatus="价格申报中"),
                     self.product("100003", "200004", "300004", lifecycleStatus="已下架/终止")])
        data = self.state()
        self.assertEqual(data["counts"]["onSale"], 1)
        self.assertEqual(data["products"][0]["skuCount"], 1)
        self.assertEqual(data["counts"]["notOnSale"], 2)

    def test_activity_join_requires_exact_spu_skc_sku_and_store(self):
        self.upload([self.product()])
        self.upload([self.activity()], kind="activities", mall="999")
        self.upload([self.activity(spuId="100002")], kind="activities")
        row = self.state()["products"][0]
        self.assertEqual(row["skus"][0]["activities"], [])
        self.assertEqual(row["activityStatus"], "none")

    def test_current_campaigns_keep_site_currency_and_ended_is_not_current(self):
        self.upload([self.product()])
        past = int((datetime.now(timezone.utc)-timedelta(days=1)).timestamp()*1000)
        self.upload([self.activity(sessionEndTime=past)], kind="activities")
        row = self.state()["products"][0]
        self.assertEqual(row["activityStatus"], "none")
        self.assertEqual(row["skus"][0]["activities"][0]["status"], "ended")
        self.assertEqual(row["skus"][0]["activities"][0]["activityPrice"], 60)

    def save_category(self, name, sizes, mall="123"):
        self.db.execute("INSERT OR REPLACE INTO activity_settings VALUES(?,?,?)",
                        ("preset:" + mall + ":" + name, self.captured,
                         json.dumps({"category": name, "size_prices": {size: {"floor": "10"} for size in sizes}})))

    def test_category_uses_multiple_matching_sizes_from_selected_shop(self):
        self.save_category("毛毯", ["40×50in", "50×60in", "60×80in"])
        self.save_category("地垫", ["60×40cm", "80×50cm"])
        self.upload([self.product(specification="40×50in"),
                     self.product(sku="300002", specification="50×60in"),
                     self.product("100002", "200002", "300003", specification="60.21×39.86cm"),
                     self.product("100002", "200002", "300004", specification="79.96×50.51cm")])
        first, second = self.state()["products"]
        self.assertEqual(first["categoryName"], "毛毯")
        self.assertEqual(first["categorySource"], "spec_preset")
        self.assertEqual(second["categoryName"], "地垫")
        self.assertEqual(first["skuCount"], 2)

    def test_category_cannot_borrow_other_shop_or_global_presets(self):
        self.save_category("毛毯", ["40×50in", "50×60in"], mall="999")
        self.db.execute("INSERT INTO activity_settings VALUES(?,?,?)",
                        ("preset:全局", self.captured, json.dumps({"category": "毛毯",
                         "size_prices": {"40×50in": {}, "50×60in": {}}})))
        self.upload([self.product(specification="40×50in"),
                     self.product(sku="300002", specification="50×60in")])
        self.assertEqual(self.state()["products"][0]["categoryName"], "未分类")

    def test_category_conflicts_single_size_and_text_attributes_remain_unknown(self):
        self.save_category("毛毯", ["40×50in", "50×60in"])
        self.save_category("其他织物", ["40×50in", "50×60in"])
        self.save_category("男T恤", ["混合色", "白色"])
        self.upload([self.product(specification="40×50in"),
                     self.product(sku="300002", specification="50×60in"),
                     self.product("100002", "200002", "300003", specification="40×50in"),
                     self.product("100003", "200003", "300004", specification="混合色"),
                     self.product("100003", "200003", "300005", specification="白色")])
        rows = self.state()["products"]
        self.assertTrue(all(row["categoryName"] == "未分类" for row in rows))
        self.assertEqual(rows[0]["categorySource"], "conflict")

    def test_sku_code_category_is_not_packaging_or_size_only(self):
        self.upload([self.product(skuCode="bkt001shirt-M", skuCategory="单品"),
                     self.product("100002", "200002", "300002", skuCode="bkt080totebag-15.75*13.39*3.94in"),
                     self.product("100003", "200003", "300003", skuCode="travelbag"),
                     self.product("100004", "200004", "300004", skuCategory="单品")])
        self.assertEqual([row["categoryName"] for row in self.state()["products"]],
                         ["T恤", "托特包", "旅行包", "未分类"])

    def test_conflicting_sku_code_categories_remain_unclassified(self):
        self.upload([self.product(skuCode="blanket-001"),
                     self.product(sku="300002", skuCode="doormat-001")])
        self.assertEqual(self.state()["products"][0]["categoryName"], "未分类")

    def test_arbitrary_shop_category_and_invalid_extra_size(self):
        self.save_category("窗帘", ["60×90cm", "80×120cm"])
        self.upload([self.product(specification="60×90cm"),
                     self.product(sku="300002", specification="80×120cm")])
        self.assertEqual(self.state()["products"][0]["categoryName"], "窗帘")
        self.upload([self.product(specification="60×90cm"),
                     self.product(sku="300002", specification="80×120cm"),
                     self.product(sku="300003", specification="40×50in")])
        self.assertEqual(self.state()["products"][0]["categoryName"], "未分类")

    def test_no_accelerator_observation_stays_unknown_with_no_guessed_price(self):
        self.upload([self.product()])
        self.upload([self.activity()], kind="activities")
        row = self.state()["products"][0]
        self.assertEqual(row["acceleratorStatus"], "unknown")
        self.assertEqual(row["accelerators"], [])

    def test_explicit_accelerator_price_and_site_are_preserved(self):
        self.upload([self.product()])
        self.upload([self.boost(price=75.34,currency="CNY",priceKind="current",skuId="300001")], kind="accelerators", complete=False)
        row = self.state()["products"][0]
        self.assertEqual(row["acceleratorStatus"], "enabled")
        self.assertEqual(row["accelerators"][0]["price"], 75.34)
        self.assertEqual(row["accelerators"][0]["skuId"], "300001")

    def test_two_hour_schedule_and_snapshot_grace_are_consistent(self):
        now=datetime.now(timezone.utc)
        self.assertFalse(product_operations.freshness((now-timedelta(minutes=120)).isoformat(),now)['stale'])
        self.assertFalse(product_operations.freshness((now-timedelta(minutes=150)).isoformat(),now)['stale'])
        self.assertTrue(product_operations.freshness((now-timedelta(minutes=151)).isoformat(),now)['stale'])
        self.upload([self.product()])
        self.upload([self.boost()],kind='accelerators',complete=False,captured=(now-timedelta(minutes=120)).isoformat())
        data=self.state()
        self.assertEqual(data['products'][0]['acceleratorStatus'],'enabled')
        self.assertEqual(data['collectionIntervalMinutes'],120)
        self.assertEqual(data['freshnessWindowMinutes'],150)

    def test_stale_boost_is_not_presented_as_current_enabled(self):
        self.upload([self.product()])
        old = (datetime.now(timezone.utc)-timedelta(hours=3)).isoformat()
        self.upload([self.boost()], kind="accelerators", complete=False, captured=old)
        row = self.state()["products"][0]
        self.assertEqual(row["acceleratorStatus"], "unknown")
        self.assertTrue(row["accelerators"][0]["freshness"]["stale"])

    def test_latest_explicit_state_replaces_previous_and_absence_does_not_disable(self):
        self.upload([self.product()])
        self.upload([self.boost()], kind="accelerators", complete=False)
        self.upload([], kind="accelerators", complete=False)
        self.assertEqual(self.state()["products"][0]["acceleratorStatus"], "enabled")
        self.upload([self.boost("eligible")], kind="accelerators", complete=False)
        self.assertEqual(self.state()["products"][0]["acceleratorStatus"], "eligible")

    def test_accelerator_sites_do_not_overwrite_each_other_or_leak_other_shop(self):
        self.upload([self.product()])
        self.upload([self.boost(), self.boost("disabled",siteName="欧区站")], kind="accelerators", complete=False)
        self.upload([self.boost(price=50,currency="CNY",priceKind="current")], kind="accelerators", complete=False, mall="999")
        row = self.state()["products"][0]
        self.assertEqual(row["acceleratorStatus"], "unknown")
        self.assertEqual(len(row["accelerators"]), 2)
        self.assertTrue(all(b["price"] is None for b in row["accelerators"]))

    def test_accelerator_switch_is_distinct_from_legacy_eligibility(self):
        self.upload([self.product(str(100001+i), str(200001+i), str(300001+i)) for i in range(6)])
        statuses = ["enabled", "eligible", "disabled", "max_eligible", "unknown"]
        self.upload([self.boost(status, spuId=str(100001+i)) for i, status in enumerate(statuses)],
                    kind="accelerators", complete=False)
        data = self.state()
        self.assertEqual([row["acceleratorSwitchStatus"] for row in data["products"]],
                         ["enabled", "disabled", "disabled", "unknown", "unknown", "unknown"])
        self.assertEqual([row["acceleratorStatus"] for row in data["products"]],
                         statuses + ["unknown"])
        self.assertEqual([row["acceleratorSwitchStatusLabel"] for row in data["products"]],
                         ["已开启", "未开启", "未开启", "待确认", "待确认", "待确认"])
        self.assertEqual(data["counts"]["acceleratorSwitchEnabled"], 1)
        self.assertEqual(data["counts"]["acceleratorSwitchDisabled"], 2)
        self.assertEqual(data["counts"]["acceleratorSwitchUnknown"], 3)
        self.assertEqual(data["sources"]["accelerators"]["switchFreshProducts"], 3)

    def test_stale_and_conflicting_accelerator_switches_stay_unknown(self):
        self.upload([self.product(), self.product("100002", "200002", "300002")])
        self.upload([self.boost()], kind="accelerators", complete=False,
                    captured=(datetime.now(timezone.utc)-timedelta(minutes=151)).isoformat())
        self.upload([self.boost("enabled", spuId="100002"),
                     self.boost("disabled", spuId="100002", siteName="欧区站")],
                    kind="accelerators", complete=False)
        self.assertEqual([row["acceleratorSwitchStatus"] for row in self.state()["products"]],
                         ["unknown", "unknown"])

    def test_eligible_and_closed_variants_agree_on_disabled_switch(self):
        self.upload([self.product()])
        self.upload([self.boost("eligible", skuId="300001"),
                     self.boost("disabled", skuId="300002")], kind="accelerators", complete=False)
        row = self.state()["products"][0]
        self.assertEqual(row["acceleratorStatus"], "unknown")
        self.assertEqual(row["acceleratorSwitchStatus"], "disabled")

    def test_accelerator_targets_use_latest_complete_batch_and_numeric_order(self):
        self.upload([self.product("100010"), self.product("100002", "200002", "300002")])
        self.upload([self.product("100010"), self.product("100010", "200003", "300003"),
                     self.product("100003", "200004", "300004", onSale=False)])
        # A later partial row must not alter the frozen complete snapshot.
        self.upload([self.product("100010", onSale=False),
                     self.product("100001", "200005", "300005", onSale=True)], complete=False)
        value = product_operations.accelerator_targets(self.connect, "123")
        self.assertEqual(value["spuIds"], ["100010"])
        self.assertEqual(value["skcIdsBySpu"], {"100010": ["200001", "200003"]})
        self.assertEqual(value["catalogCaptured"], collector.timestamp(self.captured))
        self.assertEqual(value["targetHash"], hashlib.sha256(b"100010").hexdigest())
        self.assertTrue(value["success"])
        self.assertTrue(value["complete"])
        self.upload([self.product("9"), self.product("10", "200002", "300002"),
                     self.product("2", "200003", "300003")])
        value = product_operations.accelerator_targets(self.connect, "123")
        self.assertEqual(value["spuIds"], ["2", "9", "10"])
        self.assertEqual(value["targetHash"], hashlib.sha256(b"2\n9\n10").hexdigest())

    def test_accelerator_targets_accept_complete_empty_catalog(self):
        self.upload([self.product()])
        self.upload([])
        value = product_operations.accelerator_targets(self.connect, "123")
        self.assertEqual(value["spuIds"], [])
        self.assertEqual(value["skcIdsBySpu"], {})
        self.assertEqual(value["targetHash"], hashlib.sha256(b"").hexdigest())
        self.assertTrue(value["complete"])

    def test_accelerator_targets_require_full_same_shop_on_sale_snapshot(self):
        with self.assertRaisesRegex(ValueError, "完整在售"):
            product_operations.accelerator_targets(self.connect, "123")
        self.upload([self.product(onSale=True)], complete=False)
        with self.assertRaisesRegex(ValueError, "完整在售"):
            product_operations.accelerator_targets(self.connect, "123")
        self.upload([self.product()], mall="999")
        with self.assertRaisesRegex(ValueError, "完整在售"):
            product_operations.accelerator_targets(self.connect, "123")
        self.upload([self.product()], meta={"sale_scope": "all"})
        with self.assertRaisesRegex(ValueError, "完整在售"):
            product_operations.accelerator_targets(self.connect, "123")
        self.upload([self.product()], meta={"source": "other"})
        with self.assertRaisesRegex(ValueError, "完整在售"):
            product_operations.accelerator_targets(self.connect, "123")
        self.upload([self.product()])
        scope = product_operations.snapshot_scope(self.db, "products", "123")
        self.db.execute("UPDATE collector_snapshots SET payload=? WHERE dataset='products' AND mall_id='123'",
                        (json.dumps({**scope["meta"], "source_mall_id": "999"}),))
        with self.assertRaisesRegex(ValueError, "完整在售"):
            product_operations.accelerator_targets(self.connect, "123")
        for invalid in ("", "not-a-mall", "1"*41):
            with self.assertRaisesRegex(ValueError, "有效店铺"):
                product_operations.accelerator_targets(self.connect, invalid)

    def test_accelerator_targets_reject_stale_snapshot_even_after_fresh_partial(self):
        captured = (datetime.now(timezone.utc)-timedelta(minutes=151)).isoformat()
        self.upload([self.product()], captured=captured)
        self.upload([self.product(onSale=True)], complete=False)
        with self.assertRaisesRegex(ValueError, "150分钟"):
            product_operations.accelerator_targets(self.connect, "123")
        self.upload([self.product()])
        now = datetime.fromisoformat(self.captured) + timedelta(minutes=150)
        self.assertTrue(product_operations.accelerator_targets(self.connect, "123", now=now)["complete"])

    def test_accelerator_targets_require_matching_archive_and_valid_spu(self):
        self.upload([self.product()])
        self.db.execute("DELETE FROM collector_payloads")
        with self.assertRaisesRegex(ValueError, "原始批次"):
            product_operations.accelerator_targets(self.connect, "123")
        self.upload([self.product(spu="invalid")])
        with self.assertRaisesRegex(ValueError, "无效SPU"):
            product_operations.accelerator_targets(self.connect, "123")

    def test_accelerator_target_skcs_keep_exact_spu_ownership_and_ignore_partial(self):
        self.upload([self.product("100001", "30", "300001"),
                     self.product("100001", "20", "300002"),
                     self.product("100001", "30", "300003"),
                     self.product("100002", "10", "300004"),
                     self.product("100003", "40", "300005", onSale=False)])
        original = product_operations.accelerator_targets(self.connect, "123")
        self.assertEqual(original["skcIdsBySpu"], {"100001": ["20", "30"], "100002": ["10"]})
        self.upload([self.product("100001", "99", "300006"),
                     self.product("100002", "30", "300007")], complete=False)
        value = product_operations.accelerator_targets(self.connect, "123")
        self.assertEqual(value, original)

    def test_accelerator_target_skcs_reject_invalid_and_cross_spu_identity(self):
        for invalid in ("invalid", "0", "1"*41):
            with self.subTest(skc=invalid):
                self.upload([self.product(skc=invalid)])
                with self.assertRaisesRegex(ValueError, "无效SKC"):
                    product_operations.accelerator_targets(self.connect, "123")
        self.upload([self.product("100001", "200001", "300001"),
                     self.product("100002", "200001", "300002")])
        with self.assertRaisesRegex(ValueError, "同一SKC关联多个SPU"):
            product_operations.accelerator_targets(self.connect, "123")

    def test_mismatched_source_mall_rejected(self):
        with self.assertRaisesRegex(ValueError, "店铺不一致"):
            self.upload([self.product()], meta={"source_mall_id": "999"})
        self.assertEqual(self.state()["counts"]["onSale"], 0)

    def test_spec_can_be_recovered_without_copying_activity_eligibility(self):
        self.upload([self.product()])
        activity_jobs.ingest_evidence({"mall_id":"123","campaign_id":"500001","captured":self.captured,
            "candidates":[{"spuId":"100001","skcId":"","skuId":"","specification":"40×50in",
                           "dailyPrice":"80","referenceActivityPrice":"60","eligible":True}]}, self.connect)
        row = self.state()["products"][0]
        self.assertEqual(row["skus"][0]["specification"], "40×50in")
        self.assertEqual(row["skus"][0]["activities"], [])
        self.assertEqual(row["activityStatus"], "unknown")


if __name__ == "__main__":
    unittest.main()
