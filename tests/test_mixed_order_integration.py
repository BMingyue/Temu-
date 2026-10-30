"""Mixed order must survive scanning, confirmation, real file selection and retry."""
from dataclasses import asdict
import json
from pathlib import Path
import pickle
import tempfile
import unittest
from unittest.mock import MagicMock, patch

from PIL import Image

import main
from mixed_image_order import make_items, order_key, layout_key
from preflight_review import preview_entries
try:
    from tests import test_image_upload_policies as browser_fixture
except ImportError:
    import test_image_upload_policies as browser_fixture


class MixedScannerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def images(self, folder, names):
        folder.mkdir(parents=True, exist_ok=True)
        result = []
        for index, name in enumerate(names):
            path = folder / name
            Image.new('RGB', (70 + index, 100), (50, index, 80)).save(path)
            result.append(path)
        return result

    def test_batch_template_inserts_details_among_each_products_own_images(self):
        products = [self.images(self.root / name, ['1.png', '2.png', '3.png']) for name in ('First', 'Second')]
        details = self.images(self.root / 'Details', ['1.png', '2.png'])
        items = make_items(products[0], details)
        tokens = [items[i].token for i in (0, 3, 1, 4, 2)]
        config = main.AppConfig(product_root=str(self.root), common_detail_images=list(map(str, details)),
            combined_image_layouts={layout_key('blanket'): tokens})
        jobs, _ = main.scan_product_folders(config)
        self.assertEqual(2, len(jobs))
        for job, originals in zip(jobs, products):
            expected = [originals[0], details[0], originals[1], details[1], originals[2]]
            self.assertEqual(expected, job.images)
            self.assertEqual(details, job.detail_image_paths)
            self.assertEqual(['main', 'common', 'product', 'common', 'product'],
                             [entry.role for entry in preview_entries(job, config)])

    def test_detail_can_be_first_and_config_and_job_roundtrip_preserve_sequence(self):
        originals = self.images(self.root / 'Product', ['1.png', '2.png'])
        details = self.images(self.root / 'Details', ['1.png'])
        items = make_items(originals, details)
        config = main.AppConfig(product_root=str(originals[0].parent), common_detail_images=list(map(str, details)),
            combined_image_orders={order_key('blanket', originals[0].parent): [items[2].token, items[1].token, items[0].token]})
        with patch.object(main, 'CONFIG_PATH', self.root / 'config.json'):
            config.save()
            loaded = main.AppConfig.load()
        jobs, _ = main.scan_product_folders(loaded)
        self.assertEqual([details[0], originals[1], originals[0]], jobs[0].images)
        entries = preview_entries(jobs[0], loaded)
        self.assertIn('主图', entries[0].label)
        self.assertIn('细节', entries[0].label)
        self.assertEqual(jobs[0], pickle.loads(pickle.dumps(jobs[0])))
        self.assertEqual(loaded, main.AppConfig(**json.loads(json.dumps(asdict(loaded)))))

    def test_limit_retains_details_and_uses_mixed_product_priority(self):
        products = self.images(self.root / 'Product', [f'{i:02}.png' for i in range(12)])
        details = self.images(self.root / 'Details', ['detail.png'])
        items = make_items(products, details)
        config = main.AppConfig(product_root=str(products[0].parent), common_detail_images=list(map(str, details)),
            combined_image_layouts={layout_key('blanket'): [items[11].token, items[12].token, items[0].token]})
        jobs, _ = main.scan_product_folders(config)
        self.assertEqual([products[11], details[0], products[0]], jobs[0].images[:3])
        self.assertEqual(10, len(jobs[0].images))
        self.assertEqual([details[0]], jobs[0].detail_image_paths)

    def test_blackwhite_main_mapping_and_color_details_remain_independent(self):
        originals = self.images(self.root / 'Product', ['1-black.png', '2-white.png'])
        white = self.images(self.root / 'White', ['1.png', '2.png'])
        black = self.images(self.root / 'Black', ['1.png', '2.png'])
        white_items = make_items([originals[1]], white)
        black_items = make_items([originals[0]], black)
        config = main.AppConfig(listing_profile='tshirt_bw', bw_first_color='black',
            product_root=str(originals[0].parent), white_detail_images=list(map(str, white)),
            black_detail_images=list(map(str, black)), combined_image_layouts={
                layout_key('tshirt_bw', 'white'): [white_items[i].token for i in (1, 0, 2)],
                layout_key('tshirt_bw', 'black'): [black_items[i].token for i in (2, 1, 0)]})
        jobs, _ = main.scan_product_folders(config)
        self.assertEqual(originals, jobs[0].images)
        self.assertEqual([white[0], originals[1], white[1]], jobs[0].color_image_sets['white'])
        self.assertEqual([black[1], black[0], originals[0]], jobs[0].color_image_sets['black'])
        entries = preview_entries(jobs[0], config)
        self.assertEqual([black[1], black[0], originals[0], white[0], originals[1], white[1]], [entry.path for entry in entries])


class MixedUploadBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        browser_fixture.ImageUploadPolicyBrowserTests.setUpClass.__func__(cls)

    @classmethod
    def tearDownClass(cls):
        browser_fixture.ImageUploadPolicyBrowserTests.tearDownClass.__func__(cls)

    setUp = browser_fixture.ImageUploadPolicyBrowserTests.setUp
    _route = browser_fixture.ImageUploadPolicyBrowserTests._route
    _source = browser_fixture.ImageUploadPolicyBrowserTests._source
    _uploader = browser_fixture.ImageUploadPolicyBrowserTests._uploader

    def exercise(self, profile):
        uploader = self._uploader(profile, 'original')
        products = [self._source(f'Product/{i}.png', (180 + i, 240), color)
                    for i, color in enumerate(('red', 'green') if profile == 'tshirt_bw' else ('red', 'green', 'blue'))]
        details = [self._source(f'Details/{i}.png', (190 + i, 250), color)
                   for i, color in enumerate(('ivory', 'navy'))]
        config = uploader.config
        config.product_root = str(products[0].parent)
        config.article_name = 'Mixed'
        config.template_url = main.BW_TEMPLATE_URL
        config.description_mode = 'keep'
        if profile == 'tshirt_bw':
            config.white_detail_images = [str(details[0])]
            config.black_detail_images = [str(details[1])]
            for color, product, detail in zip(('white', 'black'), products, details):
                items = make_items([product], [detail])
                config.combined_image_layouts[layout_key(profile, color)] = [items[1].token, items[0].token]
        else:
            config.common_detail_images = list(map(str, details))
            items = make_items(products, details)
            config.combined_image_layouts[layout_key(profile)] = [items[i].token for i in (0, 3, 1, 4, 2)]
        jobs, _ = main.scan_product_folders(config)
        job = jobs[0]
        uploader._fill_title = MagicMock()
        uploader._replace_variant_images = MagicMock()
        uploader._replace_description = MagicMock()
        with patch.object(main, 'APP_DIR', self.root):
            uploader._fill_job_fields(job)
        batches = self.page.evaluate('receivedFiles')
        expected = [job.images] if profile == 'blanket' else (
            [job.color_image_sets['white'], job.color_image_sets['black']] if profile == 'tshirt_bw' else [job.images, job.images])
        self.assertEqual(len(expected), len(batches))
        for sources, batch in zip(expected, batches):
            self.assertEqual([path.read_bytes() for path in sources], [self.uploaded_bytes[url] for url in batch['urls']])
        self.assertFalse(self.unexpected_requests)
        uploader._replace_description.assert_not_called()
        if profile != 'blanket':
            self.assertEqual(batches[0]['urls'][0], self.page.locator('.material-img-module img').get_attribute('src'))

    def test_blanket_mixed_order_reaches_actual_file_chooser(self):
        self.exercise('blanket')

    def test_tshirt_mixed_order_reaches_each_color_row(self):
        self.exercise('tshirt')

    def test_blackwhite_detail_first_reaches_each_correct_color_and_material(self):
        self.exercise('tshirt_bw')


if __name__ == '__main__':
    unittest.main()
