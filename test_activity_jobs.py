import json
import sqlite3
import unittest
from contextlib import contextmanager
from datetime import datetime, timezone

import activity_jobs
import collector


class ActivityJobsTest(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.row_factory = sqlite3.Row
        self.captured = datetime.now(timezone.utc).isoformat()
        collector.init(self.db)
        activity_jobs.init(self.db)

        @contextmanager
        def connect():
            with self.db:
                yield self.db
        self.connect = connect

    def tearDown(self):
        self.db.close()

    def add_product(self, **patch):
        product = {"spuId":"SPU1", "skcId":"SKC1", "skuId":"SKU1", "skuCode":"CODE1", "declaredPrice":80}
        product.update(patch)
        self.db.execute("INSERT INTO collector_records VALUES(?,?,?,?,?)", (
            "products", "100", json.dumps([product["spuId"], product["skcId"], product["skuId"]]),
            json.dumps(product), self.captured))

    def evidence(self, **patch):
        row = {"spuId":"SPU1", "skcId":"SKC1", "skuId":"SKU1", "skuCode":"CODE1", "specification":"120.05 * 45.22 cm", "dailyPrice":"80", "referenceActivityPrice":"60", "referenceStock":30, "eligible":True, "adjustable":True}
        row.update(patch)
        return activity_jobs.ingest_evidence({"mall_id":"100", "campaign_id":"CAMPAIGN1", "captured":self.captured, "candidates":[row]}, self.connect)

    def test_catalog_refresh_recovers_hidden_sku_without_recapturing_activity(self):
        self.evidence(skcId="", skuId="", skuCode="")
        before = self.db.execute("SELECT * FROM activity_evidence_snapshots").fetchone()
        self.add_product()
        state = activity_jobs.job_snapshot(self.connect, mall_id="100")
        snapshot = state["evidence"][0]
        payload = snapshot["payload"]
        self.assertEqual(payload["candidates"][0]["skuId"], "SKU1")
        self.assertEqual(payload["unresolved_candidates"], [])
        self.assertEqual(payload["source_candidate_count"], 1)
        self.assertFalse(payload["needs_product_refresh"])
        self.assertEqual(snapshot["captured"], before["captured"])
        self.assertEqual(self.db.execute("SELECT payload FROM activity_evidence_snapshots").fetchone()["payload"], before["payload"])
        plan = activity_jobs.create_plan({"mall_id": "100"}, self.connect)
        self.assertEqual(plan["job"]["items"][0]["skuId"], "SKU1")

    def test_refreshed_match_preserves_activity_fields_and_capture_warnings(self):
        self.evidence(skcId="", skuId="", skuCode="", referenceActivityPrice="60", referenceStock=17)
        self.add_product()
        before = json.loads(self.db.execute("SELECT payload FROM activity_evidence_snapshots").fetchone()["payload"])
        before["capture_warnings"] = ["活动页仅扫描了部分商品"]
        payload = activity_jobs.resolve_evidence(self.db, "100", before)
        row = payload["candidates"][0]
        self.assertEqual(row["referenceActivityPrice"], "60.00")
        self.assertEqual(row["referenceStock"], 17)
        self.assertEqual(row["dailyPrice"], "80.00")
        self.assertIn("活动页仅扫描了部分商品", payload["warnings"])
        self.assertFalse(any("没有找到" in warning for warning in payload["warnings"]))
        self.assertFalse(any("超过 12 小时" in warning for warning in payload["warnings"]))

    def test_inferred_id_becomes_unresolved_when_current_catalog_is_ambiguous(self):
        self.add_product()
        self.evidence(skcId="", skuId="", skuCode="")
        self.add_product(skcId="SKC2", skuId="SKU2", skuCode="CODE2")
        payload = activity_jobs.job_snapshot(self.connect, mall_id="100")["evidence"][0]["payload"]
        self.assertEqual(payload["candidates"], [])
        self.assertIn("存在歧义", payload["unresolved_candidates"][0]["resolutionError"])

    def test_legacy_inferred_id_is_rechecked_without_trusting_inferred_code(self):
        self.add_product()
        self.evidence(skcId="", skuId="", skuCode="")
        payload = json.loads(self.db.execute("SELECT payload FROM activity_evidence_snapshots").fetchone()["payload"])
        payload["candidates"][0].pop("sourceIdentity")
        self.add_product(skcId="SKC2", skuId="SKU2", skuCode="CODE2")
        result = activity_jobs.resolve_evidence(self.db, "100", payload)
        self.assertEqual(result["candidates"], [])
        self.assertIn("存在歧义", result["unresolved_candidates"][0]["resolutionError"])

    def test_refresh_never_uses_other_store_products(self):
        self.evidence(skcId="", skuId="", skuCode="")
        self.add_product()
        self.db.execute("UPDATE collector_records SET mall_id='200'")
        payload = activity_jobs.job_snapshot(self.connect, mall_id="100")["evidence"][0]["payload"]
        self.assertEqual(payload["candidates"], [])
        self.assertEqual(len(payload["unresolved_candidates"]), 1)

    def test_refresh_does_not_reactivate_product_outside_current_snapshot(self):
        self.add_product()
        self.evidence(skcId="", skuId="", skuCode="")
        collector.ingest({
            "id": "f" * 64, "path": "/api/client/products/upload", "observed_at": self.captured,
            "body": {"mall_id": "100", "rows": [{"spuId": "SPU2", "skcId": "SKC2", "skuId": "SKU2"}],
                     "crawl_result": {"complete": True, "total": 1, "collected_skc_count": 1}},
        }, self.connect)
        payload = activity_jobs.job_snapshot(self.connect, mall_id="100")["evidence"][0]["payload"]
        self.assertEqual(payload["candidates"], [])
        self.assertEqual(len(payload["unresolved_candidates"]), 1)

    def test_refresh_does_not_renew_stale_activity_evidence(self):
        from datetime import timedelta
        self.captured = (datetime.now(timezone.utc) - timedelta(days=2)).isoformat()
        self.evidence(skcId="", skuId="", skuCode="")
        self.captured = datetime.now(timezone.utc).isoformat()
        self.add_product()
        row = activity_jobs.job_snapshot(self.connect, mall_id="100")["evidence"][0]["payload"]["evaluated_candidates"][0]
        self.assertFalse(row["precheck"]["eligible"])
        self.assertTrue(any("过期" in text for text in row["precheck"]["pendingReasons"]))

    def test_exact_batch_mapping_and_decimal_prices(self):
        self.add_product(); self.evidence()
        job = activity_jobs.create_plan({"mall_id":"100"}, self.connect)["job"]
        item = job["items"][0]
        self.assertTrue(item["eligible"])
        self.assertEqual(item["specification"], "120.05×45.22cm")
        self.assertEqual(item["floorPrice"], "72.00")
        self.assertEqual(item["targetDailyPrice"], "96.00")
        self.assertEqual(item["seventyFivePercent"], "72.00")
        self.assertEqual(item["action"], "adjust_then_enroll")

    def test_visible_precheck_uses_saved_rules_and_preserves_evidence(self):
        self.add_product(); self.evidence()
        settings = {"size_prices": {"120.05×45.22cm": {"floor":72,"target_daily":72,"match_min":79,"match_max":81}}}
        activity_jobs.save_settings({"config":settings},self.connect)
        state = activity_jobs.job_snapshot(self.connect)
        row = state['evidence'][0]['payload']['evaluated_candidates'][0]
        self.assertFalse(row['precheck']['eligible'])
        self.assertTrue(any('低于底价' in reason for reason in row['precheck']['blockedReasons']))
        self.assertFalse(any('不在' in reason for reason in row['precheck']['blockedReasons']))
        raw = json.loads(self.db.execute('SELECT payload FROM activity_evidence_snapshots').fetchone()['payload'])
        self.assertNotIn('evaluated_candidates', raw)
        settings['size_prices']['120.05×45.22cm']['target_daily'] = 96
        activity_jobs.save_settings({'config':settings},self.connect)
        self.assertFalse(activity_jobs.job_snapshot(self.connect)['evidence'][0]['payload']['evaluated_candidates'][0]['precheck']['eligible'])

    def test_enrollment_does_not_require_adjustment(self):
        self.add_product(); self.evidence(adjustable=None,referenceActivityPrice='72')
        row=activity_jobs.job_snapshot(self.connect)['evidence'][0]['payload']['evaluated_candidates'][0]
        self.assertEqual(row['precheck']['status'],'ready')
        self.assertEqual(row['precheck']['plannedActivityPrice'],'72.00')

    def test_missing_rule_is_pending_not_rejected(self):
        self.add_product(); self.evidence(specification='40×50in',adjustable=None)
        row=activity_jobs.job_snapshot(self.connect)['evidence'][0]['payload']['evaluated_candidates'][0]
        self.assertEqual(row['precheck']['status'],'pending')
        self.assertEqual(row['precheck']['blockedReasons'],[])

    def test_inches_never_match_centimeters(self):
        self.assertEqual(activity_jobs.normalize_spec('120.05×45.22in'),'')

    def test_unrecognized_spec_blocks_enrollment(self):
        self.add_product(); self.evidence(specification="63×40cm")
        item = activity_jobs.create_plan({"mall_id":"100"}, self.connect)["job"]["items"][0]
        self.assertFalse(item["eligible"])
        self.assertIn("规格 63×40cm 尚未配置本批底价与目标日常价", item["blockedReasons"])

    def test_hidden_sku_is_recovered_by_unique_spu_skc_exact_price(self):
        self.add_product()
        receipt = self.evidence(skuId="", skuCode="", specification="40*50in")
        self.assertEqual(receipt["rows"], 1)
        self.assertEqual(receipt["recovered"], 1)
        self.assertEqual(receipt["unresolved"], 0)
        with self.connect() as db:
            payload = json.loads(db.execute("SELECT payload FROM activity_evidence_snapshots").fetchone()["payload"])
        self.assertEqual(payload["candidates"][0]["skuId"], "SKU1")
        self.assertEqual(payload["candidates"][0]["skuCode"], "CODE1")
        self.assertEqual(payload["candidates"][0]["identityResolution"], "spu_skc_exact_daily_price")
        item = activity_jobs.create_plan({"mall_id":"100"}, self.connect)["job"]["items"][0]
        self.assertEqual(item["skuId"], "SKU1")
        self.assertEqual(item["specification"], "40×50in")
        self.assertIn("规格 40×50in 尚未配置本批底价与目标日常价", item["blockedReasons"])

    def test_hidden_sku_with_duplicate_price_is_blocked_as_ambiguous(self):
        self.add_product()
        self.add_product(skuId="SKU2", skuCode="CODE2", declaredPrice=80)
        receipt = self.evidence(skuId="", skuCode="")
        self.assertEqual(receipt["rows"], 0)
        self.assertEqual(receipt["recovered"], 0)
        self.assertEqual(receipt["unresolved"], 1)
        with self.connect() as db:
            payload = json.loads(db.execute("SELECT payload FROM activity_evidence_snapshots").fetchone()["payload"])
        self.assertIn("存在歧义", payload["unresolved_candidates"][0]["resolutionError"])

    def test_exact_sku_code_safely_disambiguates_duplicate_prices(self):
        self.add_product()
        self.add_product(skuId="SKU2", skuCode="CODE2", declaredPrice=80)
        receipt = self.evidence(skuId="", skuCode="CODE2")
        self.assertEqual(receipt["rows"], 1)
        self.assertEqual(receipt["recovered"], 1)
        with self.connect() as db:
            payload = json.loads(db.execute("SELECT payload FROM activity_evidence_snapshots").fetchone()["payload"])
        self.assertEqual(payload["candidates"][0]["skuId"], "SKU2")
        self.assertEqual(payload["candidates"][0]["identityResolution"], "spu_skc_exact_daily_price_and_code")

    def test_hidden_sku_without_exact_price_match_is_not_guessed(self):
        self.add_product(declaredPrice=80)
        receipt = self.evidence(skuId="", skuCode="", dailyPrice="80.01")
        self.assertEqual(receipt["rows"], 0)
        self.assertEqual(receipt["unresolved"], 1)
        with self.connect() as db:
            payload = json.loads(db.execute("SELECT payload FROM activity_evidence_snapshots").fetchone()["payload"])
        self.assertIn("没有找到", payload["unresolved_candidates"][0]["resolutionError"])

    def test_missing_product_catalog_requests_refresh(self):
        receipt = self.evidence(skuId="", skuCode="")
        self.assertEqual(receipt["rows"], 0)
        self.assertEqual(receipt["unresolved"], 1)
        self.assertTrue(receipt["needs_product_refresh"])
        self.assertEqual(receipt["product_catalog"]["sku_count"], 0)

    def test_hidden_skc_and_sku_are_recovered_from_unique_spu_price(self):
        self.add_product()
        receipt = self.evidence(skcId="", skuId="", skuCode="")
        self.assertEqual(receipt["rows"], 1)
        self.assertEqual(receipt["recovered"], 1)
        with self.connect() as db:
            payload = json.loads(db.execute("SELECT payload FROM activity_evidence_snapshots").fetchone()["payload"])
        candidate = payload["candidates"][0]
        self.assertEqual(candidate["skcId"], "SKC1")
        self.assertEqual(candidate["skuId"], "SKU1")
        self.assertEqual(candidate["identityResolution"], "spu_unique_exact_daily_price")

    def test_hidden_skc_is_blocked_when_spu_price_is_not_unique(self):
        self.add_product()
        self.add_product(skcId="SKC2", skuId="SKU2", skuCode="CODE2", declaredPrice=80)
        receipt = self.evidence(skcId="", skuId="", skuCode="")
        self.assertEqual(receipt["rows"], 0)
        self.assertEqual(receipt["unresolved"], 1)

    def test_per_size_price_interval_allows_in_range_and_blocks_outside(self):
        self.add_product()
        self.evidence(specification="40*50in", dailyPrice="51")
        config = {"price_match":{"field":"dailyPrice"}, "size_prices":{
            "40×50in":{"floor":"36.00", "target_daily":"50.00", "match_min":"49.00", "match_max":"52.00"}
        }}
        item = activity_jobs.create_plan({"mall_id":"100", "config":config}, self.connect)["job"]["items"][0]
        self.assertTrue(item["eligible"])
        self.assertEqual(item["priceMatchValue"], "51.00")
        self.assertEqual(item["priceMatchMin"], "49.00")
        self.assertEqual(item["priceMatchMax"], "52.00")

        with self.connect() as db:
            payload = json.loads(db.execute("SELECT payload FROM activity_evidence_snapshots ORDER BY captured DESC LIMIT 1").fetchone()["payload"])
            payload["candidates"][0]["dailyPrice"] = "52.01"
            db.execute("UPDATE activity_evidence_snapshots SET payload=?", (json.dumps(payload),))
        item = activity_jobs.create_plan({"mall_id":"100", "config":config}, self.connect)["job"]["items"][0]
        self.assertFalse(item["eligible"])
        self.assertIn("不在 49.00～52.00 的可报名区间", " ".join(item["blockedReasons"]))

    def test_activity_price_settings_are_persisted(self):
        config = {"price_match":{"field":"referenceActivityPrice"}, "size_prices":{
            "40×50in":{"floor":"36", "target_daily":"50", "match_min":"35", "match_max":"38"}
        }}
        saved = activity_jobs.save_settings({"config":config}, self.connect)
        self.assertTrue(saved["ok"])
        state = activity_jobs.job_snapshot(self.connect)
        self.assertEqual(state["activity_settings"]["price_match"]["field"], "referenceActivityPrice")
        self.assertEqual(state["activity_settings"]["size_prices"]["40×50in"]["match_max"], "38.00")

    def test_activity_price_presets_are_independent_per_store(self):
        blanket = {"two_price_mode":True,"category":"毛毯","size_prices":{
            "40×50in":{"floor":"48","target_daily":"64"}}}
        mat = {"two_price_mode":True,"category":"地垫","size_prices":{
            "60×40cm":{"floor":"28","target_daily":"37.34"}}}
        activity_jobs.save_settings({"mall_id":"10001","preset_name":"毛毯","config":blanket}, self.connect)
        activity_jobs.save_settings({"mall_id":"20002","preset_name":"地垫","config":mat}, self.connect)
        first = activity_jobs.job_snapshot(self.connect, mall_id="10001")
        second = activity_jobs.job_snapshot(self.connect, mall_id="20002")
        self.assertEqual(first["active_preset"], "毛毯")
        self.assertEqual(first["activity_settings"]["category"], "毛毯")
        self.assertEqual([p["name"] for p in first["price_presets"]], ["毛毯"])
        self.assertEqual(second["active_preset"], "地垫")
        self.assertEqual(second["activity_settings"]["category"], "地垫")
        self.assertEqual([p["name"] for p in second["price_presets"]], ["地垫"])

    def test_custom_category_and_text_spec_preset_can_be_saved_and_matched(self):
        config = {"two_price_mode": True, "category": "男T恤", "size_prices": {
            "混合色": {"floor": "18", "target_daily": "24"}}}
        result = activity_jobs.save_settings(
            {"mall_id": "100", "preset_name": "男T恤", "config": config}, self.connect)
        self.assertTrue(result["ok"])
        state = activity_jobs.job_snapshot(self.connect, mall_id="100")
        self.assertEqual(state["active_preset"], "男T恤")
        self.assertEqual(state["activity_settings"]["size_prices"]["混合色"]["floor"], "18.00")
        self.add_product(declaredPrice=24)
        self.evidence(specification="混合色", dailyPrice="24", referenceActivityPrice="18", adjustable=None)
        row = activity_jobs.job_snapshot(self.connect, mall_id="100")["evidence"][0]["payload"]["evaluated_candidates"][0]
        self.assertEqual(row["specification"], "混合色")
        self.assertTrue(row["precheck"]["categoryMatched"])
        self.assertEqual(row["precheck"]["status"], "ready")
        self.assertEqual(activity_jobs.match_size_rule("混合色", {"混合色": config["size_prices"]["混合色"]})[0], "混合色")
        self.assertIsNone(activity_jobs.match_size_rule("深蓝色", {"混合色": config["size_prices"]["混合色"]})[1])

    def test_two_price_mode_separates_unadjusted_and_ready_skus(self):
        self.add_product(declaredPrice=48)
        self.evidence(specification="40×50in", dailyPrice="48", referenceActivityPrice="36", adjustable=None)
        config = activity_jobs.config_from({"two_price_mode":True, "category":"毛毯", "size_prices":{
            "40×50in":{"floor":"48", "target_daily":"64"}
        }})
        with self.connect() as db:
            snapshot=db.execute("SELECT * FROM activity_evidence_snapshots").fetchone()
            candidate=json.loads(snapshot["payload"])["candidates"][0]
            product=activity_jobs._collector_products(db,"100")[0]["SKU1"]
        result=activity_jobs.enrollment_precheck(candidate,product,False,config,snapshot["captured"])
        self.assertEqual(result["status"],"bare")
        self.assertEqual(result["priceStateLabel"],"裸跑价已就位，报名需切活动价")
        self.assertEqual(result["currentPriceTier"],"bare")
        self.assertTrue(result["alreadyAdjusted"])
        self.assertFalse(result["eligible"])
        self.assertEqual(result["barePrice"],"48.00")
        self.assertEqual(result["targetDailyPrice"],"64.00")
        self.assertEqual(result["expectedActivityPrice"],"48.00")

        candidate["dailyPrice"]="64"
        candidate["referenceActivityPrice"]="48"
        result=activity_jobs.enrollment_precheck(candidate,product,False,config,snapshot["captured"])
        self.assertEqual(result["status"],"ready")
        self.assertTrue(result["eligible"])
        self.assertEqual(result["currentPriceTier"],"activity")

        candidate["dailyPrice"]="53"
        result=activity_jobs.enrollment_precheck(candidate,product,False,config,snapshot["captured"])
        self.assertEqual(result["status"],"needs_adjustment")
        self.assertFalse(result["alreadyAdjusted"])

    def test_bare_price_within_two_yuan_is_already_adjusted_but_not_enrollable(self):
        self.add_product(declaredPrice=28)
        self.evidence(specification="60×40cm", dailyPrice="29.99", referenceActivityPrice="21", adjustable=None)
        config=activity_jobs.config_from({"two_price_mode":True,"category":"地垫","size_prices":{
            "60×40cm":{"floor":"28","target_daily":"38"}
        }})
        with self.connect() as db:
            snapshot=db.execute("SELECT * FROM activity_evidence_snapshots").fetchone()
            candidate=json.loads(snapshot["payload"])["candidates"][0]
            product=activity_jobs._collector_products(db,"100")[0]["SKU1"]
        result=activity_jobs.enrollment_precheck(candidate,product,False,config,snapshot["captured"])
        self.assertEqual(result["status"],"bare")
        self.assertTrue(result["alreadyAdjusted"])
        candidate["dailyPrice"]="30.01"
        result=activity_jobs.enrollment_precheck(candidate,product,False,config,snapshot["captured"])
        self.assertEqual(result["status"],"needs_adjustment")

    def test_two_price_mode_allows_two_units_for_size_and_price(self):
        self.add_product(declaredPrice=48)
        self.evidence(specification="42×48in", dailyPrice="62", referenceActivityPrice="46", adjustable=None)
        config = activity_jobs.config_from({"two_price_mode":True, "category":"毛毯", "price_tolerance_cents":1, "size_prices":{
            "40×50in":{"floor":"48", "target_daily":"64"}
        }})
        self.assertEqual(config["price_tolerance_cents"], 200)
        with self.connect() as db:
            snapshot=db.execute("SELECT * FROM activity_evidence_snapshots").fetchone()
            candidate=json.loads(snapshot["payload"])["candidates"][0]
            product=activity_jobs._collector_products(db,"100")[0]["SKU1"]
        result=activity_jobs.enrollment_precheck(candidate,product,False,config,snapshot["captured"])
        self.assertEqual(result["matchedSpec"], "40×50in")
        self.assertEqual(result["status"], "ready")

        candidate["dailyPrice"]="61.99"
        result=activity_jobs.enrollment_precheck(candidate,product,False,config,snapshot["captured"])
        self.assertEqual(result["status"], "needs_adjustment")

        candidate["dailyPrice"]="64"
        candidate["referenceActivityPrice"]="50.01"
        result=activity_jobs.enrollment_precheck(candidate,product,False,config,snapshot["captured"])
        self.assertEqual(result["status"], "blocked")
        self.assertIn("可报名区间", " ".join(result["blockedReasons"]))

        candidate["specification"]="42.01×48in"
        result=activity_jobs.enrollment_precheck(candidate,product,False,config,snapshot["captured"])
        self.assertEqual(result["status"], "pending")
        self.assertIn("不属于当前毛毯预设", " ".join(result["pendingReasons"]))

    def test_two_price_mode_rejects_wrong_category_size_without_guessing(self):
        self.add_product(declaredPrice=28)
        self.evidence(specification="60×40cm", dailyPrice="28", referenceActivityPrice="21", adjustable=None)
        config=activity_jobs.config_from({"two_price_mode":True,"category":"毛毯","size_prices":{
            "40×50in":{"floor":"48","target_daily":"64"}
        }})
        with self.connect() as db:
            snapshot=db.execute("SELECT * FROM activity_evidence_snapshots").fetchone()
            candidate=json.loads(snapshot["payload"])["candidates"][0]
            product=activity_jobs._collector_products(db,"100")[0]["SKU1"]
        result=activity_jobs.enrollment_precheck(candidate,product,False,config,snapshot["captured"])
        self.assertEqual(result["status"],"pending")
        self.assertFalse(result["categoryMatched"])
        self.assertIn("不属于当前毛毯预设"," ".join(result["pendingReasons"]))

    def test_stale_catalog_price_does_not_hide_current_activity_price(self):
        self.add_product(declaredPrice=48)
        self.evidence(specification="40×50in", dailyPrice="64", referenceActivityPrice="48", adjustable=None)
        config=activity_jobs.config_from({"two_price_mode":True,"category":"毛毯","size_prices":{
            "40×50in":{"floor":"48","target_daily":"64"}
        }})
        with self.connect() as db:
            snapshot=db.execute("SELECT * FROM activity_evidence_snapshots").fetchone()
            candidate=json.loads(snapshot["payload"])["candidates"][0]
            product=activity_jobs._collector_products(db,"100")[0]["SKU1"]
        product["_captured"]="2020-01-01T00:00:00+00:00"
        result=activity_jobs.enrollment_precheck(candidate,product,False,config,snapshot["captured"])
        self.assertEqual(result["status"],"ready")
        self.assertTrue(result["categoryMatched"])
        self.assertIn("商品目录快照较旧", " ".join(result["notices"]))

    def test_invalid_price_interval_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "最低价不能高于最高价"):
            activity_jobs.config_from({"size_prices":{"40×50in":{"floor":"36", "target_daily":"50", "match_min":"53", "match_max":"49"}}})

    def test_id_mismatch_and_unknown_adjustability_block(self):
        self.add_product(); self.evidence(spuId="SPU2", adjustable=None)
        item = activity_jobs.create_plan({"mall_id":"100"}, self.connect)["job"]["items"][0]
        self.assertIn("SPU 与商品记录不一致", item["blockedReasons"])
        self.assertIn("尚未取得平台可调价确认", item["blockedReasons"])

    def test_missing_inventory_blocks(self):
        self.add_product(); self.evidence(referenceStock=None)
        item = activity_jobs.create_plan({"mall_id":"100"}, self.connect)["job"]["items"][0]
        self.assertIn("活动库存未取得，禁止擅自填满", item["blockedReasons"])

    def test_cannot_adjust_becomes_floor_only_not_enrollable(self):
        self.add_product(); self.evidence(adjustable=False)
        job = activity_jobs.create_plan({"mall_id":"100"}, self.connect)["job"]
        item = job["items"][0]
        self.assertEqual(item["action"], "direct_floor_only")
        self.assertEqual(item["plannedActivityPrice"], "72.00")
        self.assertFalse(item["eligible"])
        self.assertTrue(item["priceActionAllowed"])
        activity_jobs.update_selection({"job_id":job["id"], "selected":[item["item_key"]]}, self.connect)
        manifest = activity_jobs.prepare_manifest({"job_id":job["id"], "step":"price", "confirmation":"确认执行调价", "dry_run":True}, self.connect)
        self.assertEqual(manifest["items"][0]["targetPrice"], "72.00")

    def test_blocked_selection_rejected(self):
        self.add_product(); self.evidence(eligible=False, blockReason="平台不可报名")
        job = activity_jobs.create_plan({"mall_id":"100"}, self.connect)["job"]
        with self.assertRaisesRegex(ValueError, "没有安全价格动作"):
            activity_jobs.update_selection({"job_id":job["id"], "selected":[job["items"][0]["item_key"]]}, self.connect)

    def test_two_independent_manifest_confirmations_and_state_gate(self):
        self.add_product(); self.evidence()
        job = activity_jobs.create_plan({"mall_id":"100"}, self.connect)["job"]
        key = job["items"][0]["item_key"]
        activity_jobs.update_selection({"job_id":job["id"], "selected":[key]}, self.connect)
        price = activity_jobs.prepare_manifest({"job_id":job["id"], "step":"price", "confirmation":"确认执行调价", "dry_run":True}, self.connect)
        self.assertEqual(price["items"][0]["targetPrice"], "96.00")
        with self.assertRaisesRegex(ValueError, "尚未验证调价生效"):
            activity_jobs.prepare_manifest({"job_id":job["id"], "step":"enroll", "confirmation":"确认执行报名", "dry_run":True}, self.connect)
        activity_jobs.record_transition({"job_id":job["id"], "item_key":key, "state":"price_submitted"}, self.connect)
        activity_jobs.record_transition({"job_id":job["id"], "item_key":key, "state":"price_effective", "platform_response":{"spuId":"SPU1", "skcId":"SKC1", "skuId":"SKU1", "observedPrice":"96.00"}}, self.connect)
        activity_jobs.record_transition({"job_id":job["id"], "item_key":key, "state":"eligible"}, self.connect)
        enroll = activity_jobs.prepare_manifest({"job_id":job["id"], "step":"enroll", "confirmation":"确认执行报名", "dry_run":True}, self.connect)
        self.assertEqual(enroll["items"][0]["targetPrice"], "72.00")
        self.assertEqual(enroll["items"][0]["inventory"], 30)

    def test_real_execution_is_disabled(self):
        self.add_product(); self.evidence()
        job = activity_jobs.create_plan({"mall_id":"100"}, self.connect)["job"]
        key = job["items"][0]["item_key"]
        activity_jobs.update_selection({"job_id":job["id"], "selected":[key]}, self.connect)
        with self.assertRaisesRegex(ValueError, "真实执行适配器未启用"):
            activity_jobs.prepare_manifest({"job_id":job["id"], "step":"price", "confirmation":"确认执行调价", "dry_run":False}, self.connect)

    def test_platform_price_receipt_checks_ids_and_tolerance(self):
        self.add_product(); self.evidence()
        job = activity_jobs.create_plan({"mall_id":"100"}, self.connect)["job"]
        key = job["items"][0]["item_key"]
        activity_jobs.record_transition({"job_id":job["id"], "item_key":key, "state":"price_submitted"}, self.connect)
        with self.assertRaisesRegex(ValueError, "skuId 与作业不一致"):
            activity_jobs.record_transition({"job_id":job["id"], "item_key":key, "state":"price_effective", "platform_response":{"spuId":"SPU1", "skcId":"SKC1", "skuId":"WRONG", "observedPrice":"96.00"}}, self.connect)
        with self.assertRaisesRegex(ValueError, "超出 200 分容差"):
            activity_jobs.record_transition({"job_id":job["id"], "item_key":key, "state":"price_effective", "platform_response":{"spuId":"SPU1", "skcId":"SKC1", "skuId":"SKU1", "observedPrice":"93.99"}}, self.connect)


if __name__ == "__main__":
    unittest.main()
