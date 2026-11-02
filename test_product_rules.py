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

    def test_platform_leaf_wins_over_identical_sizes_and_sku_keywords(self):
        self.save_rules([self.rule("男T恤", ["M"], codeKeywords=["shirt"])])
        self.upload([self.product(specification="M", skuCode="shirt-M", categoryId="101",
                                   categoryName="针织毛衣", categoryPath=["服装", "针织毛衣"],
                                   categoryIds=["1", "101"], categorySource="temu_product_catalog")])
        row = self.state()["products"][0]
        self.assertEqual(row["categoryName"], "针织毛衣")
        self.assertEqual(row["categorySource"], "platform_category")
        self.assertEqual(row["platformCategoryPath"], ["服装", "针织毛衣"])
        self.assertEqual(self.state()["categoryCoverage"], {"matched": 1, "missing": 0, "conflicts": 0, "total": 1})

    def test_platform_mapping_uses_most_specific_ancestor_and_exact_path(self):
        self.save_rules([self.rule("衣服", [], specifications=[], platformCategoryIds=["1"]),
                         self.rule("男T恤", [], specifications=[], platformCategoryIds=["101"])])
        self.upload([self.product(categoryId="101", categoryName="男士上衣",
                                   categoryPath=["服装", "男装", "男士上衣"], categoryIds=["1", "10", "101"])])
        self.assertEqual(self.state()["products"][0]["categoryName"], "男T恤")
        self.save_rules([self.rule("男T恤", [], specifications=[],
                                  platformCategoryNames=["服装>男装 > 男士上衣"])])
        row = self.state()["products"][0]
        self.assertEqual(row["categoryName"], "男T恤")
        self.assertEqual(row["categorySource"], "platform_category_rule")
        # Same size and similar name do not qualify as an exact taxonomy map.
        self.upload([self.product(categoryId="102", categoryName="男士毛衣", specification="M",
                                   categoryPath=["服装", "男装", "男士毛衣"])])
        self.assertEqual(self.state()["products"][0]["categoryName"], "男士毛衣")

    def test_platform_conflicts_and_normalizer_conflict_marker_never_fall_back(self):
        self.upload([self.product(categoryId="101", categoryName="毛毯", skuCode="blanket"),
                     self.product(sku="300002", categoryId="102", categoryName="地垫", skuCode="blanket")])
        row = self.state()["products"][0]
        self.assertEqual(row["categoryName"], "未分类")
        self.assertEqual(row["categorySource"], "platform_conflict")
        self.assertEqual(self.state()["counts"]["platformCategoryConflicts"], 1)
        self.upload([self.product(categorySource="temu_product_catalog_conflict", skuCode="blanket")])
        self.assertEqual(self.state()["products"][0]["categorySource"], "platform_conflict")

    def test_manual_override_keeps_original_taxonomy_and_conflicting_maps_stay_unknown(self):
        self.save_rules([self.rule("毛毯", [], specifications=[], platformCategoryIds=["101"]),
                         self.rule("家纺", [], specifications=[], platformCategoryIds=["101"])])
        self.upload([self.product(categoryId="101", categoryName="盖毯")])
        self.assertEqual(self.state()["products"][0]["categoryName"], "未分类")
        product_rules.save({"mall_id": "123", "action": "product", "revision": 1,
                            "spuId": "100001", "category": "毛毯", "specifications": {}}, self.connect)
        row = self.state()["products"][0]
        self.assertEqual(row["categoryName"], "毛毯")
        self.assertEqual(row["categorySource"], "local_maintenance")
        self.assertEqual(row["platformCategoryName"], "盖毯")

    def test_platform_fields_are_validated_and_leaf_ids_survive_richer_name_path(self):
        with self.assertRaisesRegex(ValueError, "类目"):
            self.upload([self.product(categoryPath="服装>男装")])
        with self.assertRaisesRegex(ValueError, "类目"):
            self.save_rules([self.rule(platformCategoryIds=["not-an-id"])])
        self.upload([self.product(categoryName="上衣", categoryPath=["服装", "上衣"]),
                     self.product(sku="300002", categoryId="101", categoryName="上衣", categoryIds=["1", "101"])])
        row = self.state()["products"][0]
        self.assertEqual(row["platformCategoryPath"], ["服装", "上衣"])
        self.assertEqual(row["platformCategoryIds"], ["1", "101"])

    def test_platform_mapping_is_shop_local_and_explicit_mapping_wins_default_leaf_name(self):
        self.save_rules([self.rule("家纺", [], specifications=[], platformCategoryIds=["1"])])
        fields = {"categoryId": "101", "categoryName": "毛毯", "categoryIds": ["1", "101"],
                  "categoryPath": ["家居", "毛毯"], "categorySource": "temu_product_catalog"}
        self.upload([self.product(**fields)])
        self.upload([self.product(**fields)], mall="999")
        self.assertEqual(self.state()["products"][0]["categoryName"], "家纺")
        self.assertEqual(self.state("999")["products"][0]["categoryName"], "毛毯")
        self.assertEqual(self.state("999")["products"][0]["categorySource"], "platform_category")

    def test_leaf_id_and_leaf_name_mapping_have_equal_specificity_with_shorter_paths(self):
        self.save_rules([self.rule("衣服", [], specifications=[], platformCategoryIds=["1"]),
                         self.rule("男T恤", [], specifications=[], platformCategoryNames=["上衣"])])
        self.upload([self.product(categoryId="101", categoryName="上衣", categoryIds=["1", "10", "101"])])
        self.assertEqual(self.state()["products"][0]["categoryName"], "男T恤")
        self.save_rules([self.rule("衣服", [], specifications=[], platformCategoryNames=["服装"]),
                         self.rule("男T恤", [], specifications=[], platformCategoryIds=["101"])])
        self.upload([self.product(categoryId="101", categoryName="上衣", categoryPath=["服装", "男装", "上衣"])])
        self.assertEqual(self.state()["products"][0]["categoryName"], "男T恤")

    def test_partial_paths_without_explicit_leaf_are_not_promoted_to_ancestors(self):
        for fields in [
            {"categoryId": "300", "categoryName": "", "categoryIds": ["1", "2", "300"],
             "categoryPath": ["服装", "男装"]},
            {"categoryId": "", "categoryName": "T恤", "categoryIds": ["1", "2"],
             "categoryPath": ["服装", "男装", "T恤"]},
            {"categoryId": "", "categoryName": "", "categoryIds": ["1", "2"],
             "categoryPath": ["服装", "男装"]},
        ]:
            self.upload([self.product(skuCode="shirt-M", **fields)])
            row = self.state()["products"][0]
            self.assertEqual(row["categorySource"], "platform_conflict")
            self.assertEqual(row["categoryName"], "未分类")
            self.assertNotIn(row["platformCategoryName"], ["服装", "男装"])
            self.assertNotIn(row["platformCategoryId"], ["1", "2"])

    def test_continuous_leaf_suffix_remains_usable_when_ancestors_have_no_id_or_name(self):
        self.upload([self.product(categoryId="300", categoryName="T恤", categoryIds=["300"],
                                   categoryPath=["男装", "T恤"])])
        row = self.state()["products"][0]
        self.assertEqual(row["categorySource"], "platform_category")
        self.assertEqual(row["platformCategoryId"], "300")
        self.assertEqual(row["platformCategoryName"], "T恤")
        self.assertEqual(row["platformCategoryIds"], ["300"])
        self.assertEqual(row["platformCategoryPath"], ["男装", "T恤"])

    def test_missing_leaf_name_keeps_ids_without_borrowing_ancestor_name(self):
        self.upload([self.product(categoryId="300", categoryName="", categoryIds=["1", "300"],
                                   categoryPath=[])])
        row = self.state()["products"][0]
        self.assertFalse(row["platformCategoryConflict"])
        self.assertEqual(row["platformCategoryId"], "300")
        self.assertEqual(row["platformCategoryName"], "")
        self.assertEqual(row["categoryName"], "未分类")

    def test_missing_leaf_id_keeps_names_without_borrowing_ancestor_id(self):
        self.upload([self.product(categoryId="", categoryName="T恤", categoryIds=[],
                                   categoryPath=["服装", "T恤"])])
        row = self.state()["products"][0]
        self.assertFalse(row["platformCategoryConflict"])
        self.assertEqual(row["platformCategoryId"], "")
        self.assertEqual(row["platformCategoryName"], "T恤")
        self.assertEqual(row["categoryName"], "T恤")


if __name__ == "__main__":
    unittest.main()
