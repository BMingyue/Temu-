import json
import unittest

import product_rules
import test_product_operations as base


class ProductRuleTests(unittest.TestCase):
    setUp = base.ProductOperationsTests.setUp
    tearDown = base.ProductOperationsTests.tearDown
    product = base.ProductOperationsTests.product
    upload = base.ProductOperationsTests.upload
    state = base.ProductOperationsTests.state
    save_category = base.ProductOperationsTests.save_category
    def config(self, mall="123"):
        return product_rules.load(self.db, mall)

    def save_rules(self, rules, revision=None, mall="123"):
        return product_rules.save({"mall_id": mall, "revision": self.config(mall)["revision"] if revision is None else revision,
                                   "rules": rules}, self.connect)

    def rule(self, name="毛毯", specs=None, **patch):
        return {"name": name, "specifications": specs or ["30×40in", "40×50in", "50×60in", "60×80in"],
                "codeKeywords": [], "minMatches": 1, "tolerance": 2, "allowUnmatched": False, **patch}

    def test_old_and_new_variant_subsets_share_one_persistent_rule(self):
        self.save_rules([self.rule()])
        self.upload([self.product(specification="40×50in"),
                     self.product(sku="300002", specification="50×60in"),
                     self.product(sku="300003", specification="60×80in")])
        self.assertEqual(self.state()["products"][0]["categoryName"], "毛毯")
        self.upload([self.product(specification="30×40in")])
        self.assertEqual(self.state()["products"][0]["categoryName"], "毛毯")
        self.assertEqual(self.config()["revision"], 1)

    def test_matching_count_tolerance_extra_sizes_and_keyword_are_editable(self):
        self.save_rules([self.rule("地垫", ["60×40cm", "80×50cm"], minMatches=2, tolerance=0.5)])
        self.upload([self.product(specification="60.21×39.86cm")])
        self.assertEqual(self.state()["products"][0]["categoryName"], "未分类")
        self.save_rules([self.rule("地垫", ["60×40cm", "80×50cm"], minMatches=1, tolerance=0.5)])
        self.assertEqual(self.state()["products"][0]["categoryName"], "地垫")
        self.upload([self.product(specification="59×41cm")])
        self.assertEqual(self.state()["products"][0]["categoryName"], "未分类")
        self.save_rules([self.rule("地垫", ["60×40cm", "80×50cm"], tolerance=2)])
        self.assertEqual(self.state()["products"][0]["categoryName"], "地垫")
        self.upload([self.product(specification="59×41cm"), self.product(sku="300002", specification="大号")])
        self.assertEqual(self.state()["products"][0]["categoryName"], "未分类")
        self.save_rules([self.rule("地垫", ["60×40cm", "80×50cm"], allowUnmatched=True)])
        self.assertEqual(self.state()["products"][0]["categoryName"], "地垫")
        self.save_rules([self.rule("窗帘", [], codeKeywords=["curtain"]) | {"specifications": []}])
        self.upload([self.product(skuCode="my-CURTAIN-02")])
        self.assertEqual(self.state()["products"][0]["categoryName"], "窗帘")

    def test_manual_category_and_sku_spec_are_shop_scoped_and_keep_evidence(self):
        self.save_rules([self.rule()])
        self.upload([self.product(specification="原始规格")])
        product_rules.save({"mall_id": "123", "action": "product", "revision": 1,
                            "spuId": "100001", "category": "毛毯", "specifications": {"200001|300001": "40×50in"}}, self.connect)
        row = self.state()["products"][0]
        self.assertEqual(row["categoryName"], "毛毯")
        self.assertEqual(row["categorySource"], "local_maintenance")
        self.assertEqual(row["skus"][0]["specification"], "40×50in")
        self.assertEqual(row["skus"][0]["observedSpecification"], "原始规格")
        self.upload([self.product(specification="后来采集值")])
        self.assertEqual(self.state()["products"][0]["skus"][0]["specification"], "40×50in")
        self.upload([self.product(specification="原始规格")], mall="999")
        self.assertEqual(self.state("999")["products"][0]["categoryName"], "未分类")
        with self.assertRaisesRegex(ValueError, "不属于"):
            product_rules.save({"mall_id": "123", "action": "product", "revision": 2, "spuId": "100001",
                                "category": "", "specifications": {"999|999": "40×50in"}}, self.connect)
        product_rules.save({"mall_id": "123", "action": "product", "revision": 2, "spuId": "100001",
                            "category": "", "specifications": {}}, self.connect)
        self.assertEqual(self.state()["products"][0]["skus"][0]["specification"], "后来采集值")

    def test_category_rules_never_rewrite_activity_prices_and_detect_stale_saves(self):
        self.save_category("毛毯", ["40×50in"])
        old = self.db.execute("SELECT payload FROM activity_settings WHERE id='preset:123:毛毯'").fetchone()[0]
        self.save_rules([self.rule()])
        self.assertEqual(self.db.execute("SELECT payload FROM activity_settings WHERE id='preset:123:毛毯'").fetchone()[0], old)
        with self.assertRaisesRegex(ValueError, "其他页面"):
            self.save_rules([self.rule("别的类目")], revision=0)
        self.assertEqual(self.config()["rules"][0]["name"], "毛毯")

    def test_equivalent_spec_names_are_deduplicated_and_exact_match_wins_tolerance(self):
        self.save_rules([self.rule(specs=["40*50in", "40×50in", "41×51in"])])
        self.assertEqual(self.config()["rules"][0]["specifications"], ["40×50in", "41×51in"])
        self.upload([self.product(specification="40×50in")])
        self.assertEqual(self.state()["products"][0]["categoryName"], "毛毯")

    def test_invalid_rules_are_rejected_without_changes(self):
        for rule in [self.rule(tolerance=float("nan")), self.rule(tolerance=-1),
                     self.rule(minMatches=0), self.rule(minMatches=100), self.rule(name="未分类")]:
            with self.assertRaises(ValueError):
                self.save_rules([rule])
        self.assertEqual(self.config()["revision"], 0)


if __name__ == "__main__":
    unittest.main()
