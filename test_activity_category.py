"""Category isolation across catalog ingestion, prechecks and enrollment preview."""
import json
import sqlite3
import unittest
from contextlib import contextmanager
from datetime import datetime, timezone

import activity_jobs
import collector


class ActivityCategoryTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(':memory:')
        self.db.row_factory = sqlite3.Row
        collector.init(self.db)
        activity_jobs.init(self.db)
        self.captured = datetime.now(timezone.utc).isoformat()
        self.config = activity_jobs.config_from({
            'category': '男T恤', 'two_price_mode': True,
            'size_prices': {'S': {'floor': '30', 'target_daily': '40'}},
        })
        self.candidate = {
            'spuId': '1001', 'skcId': '2001', 'skuId': '3001', 'skuCode': 'CODE1',
            'specification': 'S', 'dailyPrice': '40', 'referenceActivityPrice': '30',
            'referenceStock': 10, 'eligible': True, 'adjustable': True,
        }

    def tearDown(self):
        self.db.close()

    def product(self, **fields):
        value = {**{key: self.candidate[key] for key in ('spuId', 'skcId', 'skuId', 'skuCode')},
                 'declaredPrice': 40, **fields}
        self.db.execute('INSERT OR REPLACE INTO collector_records VALUES(?,?,?,?,?)', (
            'products', '123', collector.key_for('products', value),
            json.dumps(value, ensure_ascii=False), self.captured,
        ))
        products, _ = activity_jobs._collector_products(self.db, '123')
        return products['3001']

    def check(self, product):
        return activity_jobs.enrollment_precheck(self.candidate, product, False, self.config, self.captured)

    def test_same_size_in_other_official_category_cannot_be_enrolled(self):
        result = self.check(self.product(categoryId='12', categoryName='女衬衫'))
        self.assertFalse(result['categoryMatched'])
        self.assertFalse(result['eligible'])
        self.assertIn('不属于', ';'.join(result['pendingReasons']))

    def test_official_category_matches_despite_no_sku_keyword(self):
        result = self.check(self.product(categoryId='11', categoryName='男T恤'))
        self.assertTrue(result['categoryMatched'])
        self.assertTrue(result['eligible'])
        self.assertEqual(result['categoryEvidence']['platformCategoryId'], '11')

    def test_shop_mapping_uses_platform_id_for_price_preset(self):
        self.db.execute('INSERT INTO activity_settings VALUES(?,?,?)', (
            'product_rules:123', self.captured, json.dumps({
                'revision': 1, 'rules': [{
                    'name': '男T恤', 'specifications': [], 'codeKeywords': [],
                    'platformCategoryIds': ['11'], 'platformCategoryNames': [],
                    'minMatches': 1, 'tolerance': 2, 'allowUnmatched': False,
                }], 'overrides': {},
            }, ensure_ascii=False),
        ))
        result = self.check(self.product(categoryId='11', categoryName='男士新奇睡衣上衣'))
        self.assertTrue(result['eligible'])
        self.assertEqual(result['categoryEvidence']['categoryName'], '男T恤')

    def test_missing_platform_category_retains_legacy_price_checks(self):
        result = self.check(self.product())
        self.assertTrue(result['eligible'])
        self.assertEqual(result['categoryEvidence']['categoryMatchSource'], 'legacy_specification')

    def test_id_only_without_mapping_stays_visible_and_pending(self):
        result = self.check(self.product(categoryId='11'))
        self.assertTrue(result['categoryMatched'])
        self.assertFalse(result['eligible'])
        self.assertIn('尚缺名称', ';'.join(result['pendingReasons']))

    def test_explicit_manual_category_takes_priority_over_official_conflict(self):
        self.db.execute('INSERT INTO activity_settings VALUES(?,?,?)', (
            'product_rules:123', self.captured, json.dumps({
                'revision': 1, 'rules': [], 'overrides': {'1001': {'category': '男T恤'}},
            }, ensure_ascii=False),
        ))
        result = self.check(self.product(categorySource='temu_product_catalog_conflict'))
        self.assertTrue(result['eligible'])
        self.assertEqual(result['categoryEvidence']['categoryMatchSource'], 'local_maintenance')

    def test_official_conflict_cannot_pass_even_when_price_and_size_match(self):
        self.product(categoryId='11', categoryName='男T恤')
        self.db.execute('INSERT INTO collector_records VALUES(?,?,?,?,?)', (
            'products', '123', 'other', json.dumps({
                'spuId': '1001', 'skcId': '2002', 'skuId': '3002',
                'categoryId': '12', 'categoryName': '女衬衫',
            }, ensure_ascii=False), self.captured,
        ))
        products, _ = activity_jobs._collector_products(self.db, '123')
        result = self.check(products['3001'])
        self.assertFalse(result['eligible'])
        self.assertIn('类目存在冲突', ';'.join(result['pendingReasons']))

    def test_legacy_plan_rejects_official_mismatch_and_direct_floor_action(self):
        product = self.product(categoryId='12', categoryName='女衬衫')
        candidate = {**self.candidate, 'adjustable': False}
        result = activity_jobs._make_item(candidate, product, False, self.config, self.captured)
        self.assertFalse(result['eligible'])
        self.assertFalse(result['priceActionAllowed'])


if __name__ == '__main__':
    unittest.main()
