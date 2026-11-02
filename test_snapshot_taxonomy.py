"""Derive paths from the exact native 0.20.13 snapshot without rewriting rows."""
import copy
import json
import unittest
from datetime import datetime, timedelta, timezone

import activity_jobs
import product_rules
import test_product_operations as base


class SnapshotTaxonomyTests(unittest.TestCase):
    setUp = base.ProductOperationsTests.setUp
    tearDown = base.ProductOperationsTests.tearDown
    product = base.ProductOperationsTests.product
    upload = base.ProductOperationsTests.upload
    state = base.ProductOperationsTests.state

    def taxonomy(self):
        # Actual native shape from the 2026-11-01 00:54:03 capture.
        names = [(27011, "服装、鞋靴和珠宝饰品"), (30327, "男士时尚"), (30328, "男装"),
                 (30459, "男士睡衣、家居服"), (30463, "男士睡衣、家居服上衣")]
        categories = {f"cat{index + 1}": {"catId": value, "catName": name}
                      for index, (value, name) in enumerate(names)}
        categories.update({f"cat{index}": {"catId": 0, "catName": ""} for index in range(6, 11)})
        return {"leafCat": {"catId": "30463", "catName": names[-1][1]}, "categories": categories}

    def row(self, **patch):
        return self.product(categoryId="30463", categoryName="男士睡衣、家居服上衣",
                            categoryPath=["男士睡衣、家居服上衣"], categoryIds=["30463"],
                            categorySource="temu_product_catalog", **patch)

    def scope(self, taxonomies=None):
        return {"mall_id": "123", "captured": self.captured, "meta": {
            "complete": True, "source": "browser_extension", "source_mall_id": "123",
            "category_taxonomies": taxonomies if taxonomies is not None else [self.taxonomy()]}}

    def test_actual_native_shape_enriches_state_and_keeps_database_and_archive_unchanged(self):
        self.upload([self.row()], meta={"category_taxonomies": [self.taxonomy()]})
        before = [tuple(row) for row in self.db.execute("SELECT * FROM collector_records")]
        archives = [tuple(row) for row in self.db.execute("SELECT * FROM collector_payloads")]
        row = self.state()["products"][0]
        self.assertEqual(row["platformCategoryIds"], ["27011", "30327", "30328", "30459", "30463"])
        self.assertEqual(row["platformCategoryPath"][0], "服装、鞋靴和珠宝饰品")
        self.assertEqual(len(row["platformCategoryPath"]), 5)
        self.assertEqual(row["platformCategoryPathSource"], "same_snapshot_taxonomy")
        self.assertEqual(row["platformCategoryPathEvidence"]["catalogCaptured"], self.captured)
        self.assertEqual(row["skus"][0]["freshness"]["captured"], self.captured)
        self.assertEqual([tuple(row) for row in self.db.execute("SELECT * FROM collector_records")], before)
        self.assertEqual([tuple(row) for row in self.db.execute("SELECT * FROM collector_payloads")], archives)

    def test_scope_requires_same_store_exact_capture_complete_and_browser_source(self):
        row = {**self.row(), "_captured": self.captured}
        valid = self.scope()
        self.assertEqual(len(product_rules.enrich_platform_category(row, valid, "123")["categoryPath"]), 5)
        patches = [("mall_id", "999"), ("captured", "different"), ("complete", False),
                   ("source", "other"), ("source_mall_id", "999")]
        for key, value in patches:
            scope = copy.deepcopy(valid)
            (scope if key in {"mall_id", "captured"} else scope["meta"])[key] = value
            self.assertEqual(product_rules.enrich_platform_category(row, scope, "123"), row)
        self.assertEqual(product_rules.enrich_platform_category(row, valid, "999"), row)

    def test_later_partial_row_does_not_borrow_old_complete_taxonomy(self):
        self.upload([self.row()], meta={"category_taxonomies": [self.taxonomy()]})
        later = (datetime.now(timezone.utc) + timedelta(minutes=1)).isoformat()
        self.upload([self.row()], complete=False, captured=later)
        row = self.state()["products"][0]
        self.assertEqual(row["platformCategoryPath"], ["男士睡衣、家居服上衣"])
        self.assertEqual(row["platformCategoryPathSource"], "product_catalog")
        indexed, _ = activity_jobs._collector_products(self.db, "123")
        self.assertEqual(indexed["300001"]["_productCategory"]["platformCategoryPathSource"], "product_catalog")

    def test_activity_index_and_state_share_ancestor_mapping_from_exact_snapshot(self):
        product_rules.save({"mall_id": "123", "revision": 0, "rules": [{
            "name": "男装", "specifications": [], "codeKeywords": [],
            "platformCategoryIds": ["30328"], "platformCategoryNames": [],
        }]}, self.connect)
        self.upload([self.row()], meta={"category_taxonomies": [self.taxonomy()]})
        row = self.state()["products"][0]
        indexed, _ = activity_jobs._collector_products(self.db, "123")
        category = indexed["300001"]["_productCategory"]
        self.assertEqual(row["categoryName"], "男装")
        self.assertEqual(category["categoryName"], "男装")
        self.assertEqual(category["platformCategoryPath"], row["platformCategoryPath"])
        self.assertEqual(category["platformCategoryPathSource"], "same_snapshot_taxonomy")

    def test_existing_multilevel_path_is_not_overwritten(self):
        row = {**self.row(), "_captured": self.captured,
               "categoryPath": ["已有上级", "男士睡衣、家居服上衣"], "categoryIds": ["1", "30463"]}
        self.assertEqual(product_rules.enrich_platform_category(row, self.scope(), "123"), row)

    def test_internal_missing_node_preserves_continuous_leaf_suffix(self):
        taxonomy = self.taxonomy()
        taxonomy["categories"]["cat3"] = {"catId": 0, "catName": ""}
        row = product_rules.enrich_platform_category({**self.row(), "_captured": self.captured}, self.scope([taxonomy]), "123")
        self.assertEqual(row["categoryPath"], ["男士睡衣、家居服", "男士睡衣、家居服上衣"])
        self.assertEqual(row["categoryIds"], ["30459", "30463"])

    def test_internal_id_gap_does_not_shorten_name_path_or_promote_ancestor_id(self):
        taxonomy = self.taxonomy()
        taxonomy["categories"]["cat3"]["catId"] = 0
        row = product_rules.enrich_platform_category({**self.row(), "_captured": self.captured}, self.scope([taxonomy]), "123")
        self.assertEqual(len(row["categoryPath"]), 5)
        self.assertEqual(row["categoryIds"], ["30459", "30463"])

    def test_conflicting_leaf_ancestors_or_untyped_nodes_prevent_enrichment(self):
        row = {**self.row(), "_captured": self.captured}
        for field, value in (("categoryIds", ["111"]), ("categoryPath", ["其他叶子"])):
            conflicting_row = {**row, field: value}
            self.assertEqual(product_rules.enrich_platform_category(conflicting_row, self.scope(), "123"), conflicting_row)
        different = self.taxonomy()
        different["categories"]["cat1"]["catName"] = "不同上级"
        self.assertEqual(product_rules.enrich_platform_category(row, self.scope([self.taxonomy(), different]), "123"), row)
        for key, value in [("cat5", {"catId": 111, "catName": "其他叶子"}), ("cat3", "不能猜测的字符串节点")]:
            taxonomy = self.taxonomy()
            taxonomy["categories"][key] = value
            self.assertEqual(product_rules.enrich_platform_category(row, self.scope([taxonomy]), "123"), row)


if __name__ == "__main__":
    unittest.main()
