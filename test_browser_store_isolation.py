import json
import sqlite3
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path

import collector


ROOT = Path(__file__).resolve().parent
EXTENSION = ROOT / 'browser_extension'


class BrowserStoreIsolationTests(unittest.TestCase):
    def test_collector_supports_both_seller_hosts(self):
        auto = (EXTENSION / 'workbench-auto.js').read_text(encoding='utf-8')
        sync = (EXTENSION / 'workbench-sync.js').read_text(encoding='utf-8')
        self.assertIn('wbSellerUrl(tab.url)', auto)
        self.assertIn('agentseller(?:-us)?', sync)
        self.assertNotIn(
            "!/^https:\\/\\/agentseller-us\\.temu\\.com\\//",
            auto,
        )

    def test_manual_collection_preserves_current_seller_origin(self):
        sidepanel = (EXTENSION / 'sidepanel.js').read_text(encoding='utf-8')
        self.assertIn('function currentSellerOrigin()', sidepanel)
        self.assertIn('currentSellerOrigin()+"/main/flux-analysis"', sidepanel)
        self.assertIn('currentSellerOrigin()+"/mmsos/orders.html"', sidepanel)
        self.assertIn(
            'currentSellerOrigin()+"/mmsos/return-refund-list.html"',
            sidepanel,
        )

    def test_extension_version_marks_store_routing_fix(self):
        manifest = json.loads(
            (EXTENSION / 'manifest.json').read_text(encoding='utf-8')
        )
        version = tuple(int(part) for part in manifest['version'].split('.'))
        self.assertGreaterEqual(version, (0, 18, 9))

    def test_seller_identity_uses_mall_id_when_name_widget_is_late(self):
        bridge = (EXTENSION / 'page-bridge.js').read_text(encoding='utf-8')
        sidepanel = (EXTENSION / 'sidepanel.js').read_text(encoding='utf-8')
        self.assertIn('matches:!refreshNotice && mallIdMatches', bridge)
        self.assertNotIn('matches:nameMatches && mallIdMatches', bridge)
        self.assertIn('名称组件尚未加载', sidepanel)
        self.assertIn('请求级校验', sidepanel)

    def test_collector_is_local_only_and_does_not_read_phone(self):
        manifest = json.loads(
            (EXTENSION / 'manifest.json').read_text(encoding='utf-8')
        )
        self.assertGreaterEqual(
            tuple(int(part) for part in manifest['version'].split('.')),
            (0, 16, 0),
        )
        http_hosts = [
            item for item in manifest['host_permissions']
            if item.startswith('http://')
        ]
        self.assertEqual(http_hosts, ['http://127.0.0.1:18769/*', 'http://127.0.0.1:5173/*'])
        worker = (EXTENSION / 'service-worker.js').read_text(encoding='utf-8')
        bridge = (EXTENSION / 'page-bridge.js').read_text(encoding='utf-8')
        self.assertIn('wbLocalDatabaseApi(message)', worker)
        self.assertNotIn('117.72.213.83', worker)
        self.assertNotIn('account.mobile', bridge)
        self.assertNotIn('account.phone', bridge)

    def test_saved_tasks_and_ads_are_locked_to_current_mall(self):
        sidepanel = (EXTENSION / 'sidepanel.js').read_text(encoding='utf-8')
        self.assertIn(
            'auth?.current_mall_id||auth?.mallId',
            sidepanel,
        )
        self.assertIn('actual&&expected===actual', sidepanel)
        self.assertNotIn('collect(tabId,"ADS_SWITCH"', sidepanel)
        self.assertIn('当前浏览器广告店铺已变化', sidepanel)

    def test_local_receipt_keeps_browser_instance_source(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'collector.sqlite'

            @contextmanager
            def connect():
                db = sqlite3.connect(path)
                db.row_factory = sqlite3.Row
                collector.init(db)
                try:
                    yield db
                    db.commit()
                finally:
                    db.close()

            receipt = collector.ingest({
                'id': 'a' * 64,
                'path': '/api/client/products/upload',
                'observed_at': '2026-09-29T12:00:00+08:00',
                'body': {
                    'mall_id': '10001',
                    'store_name': 'chrome-shop',
                    'collector_browser': 'Chrome',
                    'collector_client_id': 'chromeinstance01',
                    'rows': [{'spuId': '1', 'skcId': '2', 'skuId': '3'}],
                },
            }, connect)
            self.assertEqual(receipt['browser'], 'Chrome')
            self.assertEqual(receipt['client_id'], 'chromeinstance01')

    def test_buyout_lion_scraper_is_bundled_without_remote_auth(self):
        manifest = json.loads(
            (EXTENSION / 'manifest.json').read_text(encoding='utf-8')
        )
        consumer_scripts = [
            item for item in manifest['content_scripts']
            if 'https://www.temu.com/*' in item['matches']
        ]
        self.assertEqual(len(consumer_scripts), 1)
        self.assertIn('lion-scraper.js', consumer_scripts[0]['js'])
        self.assertIn('lion-scraper.css', consumer_scripts[0]['css'])
        source = (EXTENSION / 'lion-scraper.js').read_text(encoding='utf-8')
        self.assertIn('工作台买断授权', source)
        self.assertNotIn('47.111.100.206', source)
        self.assertNotIn('/api/auth/', source)


if __name__ == '__main__':
    unittest.main()
