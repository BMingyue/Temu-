import json
import unittest
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parent
RELEASE = ROOT / 'release'
VERSION = json.loads((ROOT / 'browser_extension/manifest.json').read_text(encoding='utf-8'))['version']
WARNING_TEXT = '当前价格低于店铺预设'


class ExtensionPackageTests(unittest.TestCase):
    def test_chrome_and_edge_packages_use_service_worker_and_contain_fix(self):
        for browser in ('chrome', 'edge'):
            path = RELEASE / f'Temu-data-collector-{browser}-{VERSION}.zip'
            self.assertTrue(path.is_file(), path)
            with zipfile.ZipFile(path) as archive:
                manifest = json.loads(archive.read('manifest.json'))
                script = archive.read('price-window.js').decode('utf-8')
            self.assertEqual(manifest['version'], VERSION)
            self.assertEqual(manifest['background']['service_worker'], 'service-worker.js')
            self.assertIn(WARNING_TEXT, script)
            with zipfile.ZipFile(path) as archive:
                manager = archive.read('workbench-panel-manager.js').decode('utf-8')
            self.assertIn("addEventListener('pointermove'", manager)
            self.assertIn('workbench.panel.fab.position.v1', manager)

    def test_product_status_scripts_match_source_in_every_package(self):
        scripts = ['accelerator-query.js', 'content.js', 'sidepanel.js', 'service-worker.js', 'workbench-daily.js', 'page-bridge.js', 'workbench-auto.js', 'product-status-sync.js', 'product-state-evidence.js', 'extension-features.js', 'traffic-background.js', 'workbench-web-bridge.js', 'traffic/adapter.js', 'traffic/scan-only.js', 'traffic/runner.js', 'traffic/rules.js', 'traffic/identity-reader.js', 'traffic/records-transfer.js']
        for browser, suffix in [('chrome','zip'),('edge','zip'),('firefox','xpi')]:
            with zipfile.ZipFile(RELEASE / f'Temu-data-collector-{browser}-{VERSION}.{suffix}') as archive:
                for name in scripts:
                    self.assertEqual(archive.read(name), (ROOT / 'browser_extension' / name).read_bytes())

    def test_firefox_package_uses_scripts_and_contains_fix(self):
        path = RELEASE / f'Temu-data-collector-firefox-{VERSION}.xpi'
        self.assertTrue(path.is_file(), path)
        with zipfile.ZipFile(path) as archive:
            manifest = json.loads(archive.read('manifest.json'))
            script = archive.read('price-window.js').decode('utf-8')
        self.assertEqual(manifest['version'], VERSION)
        self.assertNotIn('service_worker', manifest['background'])
        self.assertIn('service-worker.js', manifest['background']['scripts'])
        self.assertIn(WARNING_TEXT, script)
        with zipfile.ZipFile(path) as archive:
            manager = archive.read('workbench-panel-manager.js').decode('utf-8')
        self.assertIn("addEventListener('pointermove'", manager)
        self.assertIn('workbench.panel.fab.position.v1', manager)


if __name__ == '__main__':
    unittest.main()
