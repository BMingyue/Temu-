"""Separate white/black details from config through the offline upload DOM."""
import tempfile
import threading
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import MagicMock, patch

from PIL import Image

import main
import tshirt_automation as tshirt

try:
    from tests import test_tshirt_automation as fixture
except ImportError:
    import test_tshirt_automation as fixture


class SeparateColorDetailTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)

    def images(self, name, count):
        folder = self.root / name
        folder.mkdir(parents=True)
        paths = [folder / f'{index + 1:02d}.png' for index in range(count)]
        for path in paths:
            path.write_bytes(b'local-image-fixture')
        return paths

    def config(self, product, white=(), black=(), **kwargs):
        return main.AppConfig(
            listing_profile='tshirt_bw', product_root=str(product),
            white_detail_images=[str(path) for path in white],
            black_detail_images=[str(path) for path in black], **kwargs)

    def test_six_details_per_colour_keep_their_independent_saved_order(self):
        product = self.images('Product', 2)
        white = list(reversed(self.images('White details', 6)))
        black = self.images('Black details', 6)
        black = black[2:] + black[:2]
        config = self.config(product[0].parent, white, black)
        self.assertEqual({'white': white, 'black': black}, main.load_color_detail_images(config))
        jobs, _ = main.scan_product_folders(config)
        self.assertEqual(1, len(jobs))
        self.assertEqual(product, jobs[0].images)
        self.assertEqual(0, jobs[0].common_detail_count)
        self.assertEqual([product[0], *white], jobs[0].color_image_sets['white'])
        self.assertEqual([product[1], *black], jobs[0].color_image_sets['black'])

    def test_each_colour_may_have_nine_details_even_when_total_exceeds_ten(self):
        product = self.images('Product', 2)
        white = self.images('White details', 9)
        black = self.images('Black details', 9)
        jobs, warnings = main.scan_product_folders(self.config(product[0].parent, white, black))
        self.assertEqual(1, len(jobs))
        self.assertEqual(2, len(jobs[0].images))
        self.assertEqual(10, len(jobs[0].color_image_sets['white']))
        self.assertEqual(10, len(jobs[0].color_image_sets['black']))
        self.assertFalse(any(main.is_blocking_scan_warning(message) for message in warnings))

    def test_missing_file_error_identifies_the_affected_colour(self):
        product = self.images('Product', 2)
        for colour, label in [('white', '白色'), ('black', '黑色')]:
            with self.subTest(colour=colour):
                missing = self.root / f'missing-{colour}.png'
                options = {colour: [missing]}
                config = self.config(product[0].parent, **options)
                with self.assertRaisesRegex(ValueError, label + '细节图') as failure:
                    main.scan_product_folders(config)
                self.assertIn(missing.name, str(failure.exception))

    def test_excess_detail_error_identifies_colour_and_does_not_restrict_other_group(self):
        product = self.images('Product', 2)
        for colour, label in [('white', '白色'), ('black', '黑色')]:
            with self.subTest(colour=colour):
                excessive = self.images(f'{colour} overflow', 10)
                with self.assertRaisesRegex(ValueError, label + '细节图'):
                    main.scan_product_folders(self.config(product[0].parent, **{colour: excessive}))

    def test_old_common_details_are_not_reused_and_stale_old_paths_do_not_block_bw(self):
        product = self.images('Product', 2)
        old = self.images('Old common details', 2)
        config = self.config(product[0].parent,
                             common_detail_images=[*(str(path) for path in old), str(self.root / 'missing-old.png')])
        jobs, warnings = main.scan_product_folders(config)
        self.assertEqual(1, len(jobs))
        self.assertEqual({'white': [product[0]], 'black': [product[1]]}, jobs[0].color_image_sets)
        self.assertEqual([], main.detail_images_for_scanning(config))
        self.assertTrue(any('旧版通用细节图不用于黑白模式' in text for text in warnings))

    def test_existing_single_colour_profiles_still_use_common_details(self):
        product = self.images('Product', 1)
        common = self.images('Common details', 2)
        for profile in ('blanket', 'tshirt'):
            with self.subTest(profile=profile):
                config = main.AppConfig(listing_profile=profile, product_root=str(product[0].parent),
                                        common_detail_images=[str(path) for path in common],
                                        white_detail_images=[str(self.root / 'stale-white.png')],
                                        black_detail_images=[str(self.root / 'stale-black.png')])
                jobs, _ = main.scan_product_folders(config)
                self.assertEqual([product[0], *common], jobs[0].images)
                self.assertEqual(2, jobs[0].common_detail_count)
                self.assertEqual({}, jobs[0].color_image_sets)

    def test_white_and_black_detail_subfolders_are_excluded_from_product_batch(self):
        product = self.images('Batch/Product', 2)
        white = self.images('Batch/White details', 6)
        black = self.images('Batch/Black details', 6)
        jobs, warnings = main.scan_product_folders(self.config(self.root / 'Batch', white, black))
        self.assertEqual([product[0].parent], [job.folder for job in jobs])
        self.assertFalse(any(main.is_blocking_scan_warning(message) for message in warnings))
        self.assertEqual(set([*white, *black]), set(main.detail_images_for_scanning(
            self.config(self.root / 'Batch', white, black))))

    def test_manual_product_order_and_first_colour_together_determine_main_mapping(self):
        product = self.images('Product', 2)
        white = self.images('White details', 1)
        black = self.images('Black details', 1)
        for first in ('white', 'black'):
            with self.subTest(first=first):
                config = self.config(product[0].parent, white, black, bw_first_color=first,
                    product_image_orders={main._path_identity(product[0].parent): [path.name for path in reversed(product)]})
                jobs, _ = main.scan_product_folders(config)
                second = 'black' if first == 'white' else 'white'
                self.assertEqual(list(reversed(product)), jobs[0].images)
                self.assertEqual(product[1], jobs[0].color_image_sets[first][0])
                self.assertEqual(product[0], jobs[0].color_image_sets[second][0])
                self.assertEqual(white, jobs[0].color_image_sets['white'][1:])
                self.assertEqual(black, jobs[0].color_image_sets['black'][1:])

    def test_fallback_job_uses_colour_config_and_never_legacy_common_tail(self):
        product = self.images('Product', 2)
        white = self.images('White details', 2)
        black = self.images('Black details', 2)
        legacy = self.images('Old common details', 1)
        config = self.config(product[0].parent, white, black, bw_first_color='black',
                             article_name='TestBW', description_mode='keep', template_url=main.BW_TEMPLATE_URL,
                             common_detail_images=[str(path) for path in legacy])
        uploader = main.DxmUploader(config, MagicMock(), threading.Event())
        uploader._fill_title = MagicMock()
        uploader._replace_description = MagicMock()
        job = main.ProductJob(product[0].parent, 'Product', [*product, *legacy], common_detail_count=1)
        with patch.object(main, 'APP_DIR', self.root), \
             patch.object(tshirt, 'validate_bw_rows', return_value=['white', 'black']), \
             patch.object(tshirt, 'color_row_count', return_value=2), \
             patch.object(tshirt, 'upload_images') as upload, \
             patch.object(tshirt, 'refresh_material_image'):
            uploader._fill_job_fields(job)
        sets = upload.call_args.kwargs['color_image_sets']
        self.assertEqual([product[1], *white], sets['white'])
        self.assertEqual([product[0], *black], sets['black'])
        self.assertFalse(set(legacy).intersection([*sets['white'], *sets['black']]))
        uploader._replace_description.assert_not_called()

    def test_colour_settings_roundtrip_without_modifying_the_other_profile_details(self):
        config = self.config(self.root, [self.root / 'white.png'], [self.root / 'black.png'],
                             common_detail_images=[str(self.root / 'common.png')])
        with patch.object(main, 'CONFIG_PATH', self.root / 'config.json'):
            config.save()
            self.assertEqual(config, main.AppConfig.load())


class SeparateColorDetailsBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        fixture.TshirtOfflineBrowserTests.setUpClass.__func__(cls)

    @classmethod
    def tearDownClass(cls):
        fixture.TshirtOfflineBrowserTests.tearDownClass.__func__(cls)

    setUp = fixture.TshirtOfflineBrowserTests.setUp

    def test_fill_job_fields_uploads_both_colours_own_details_and_refreshes_material(self):
        for count, labels in [(6, ['白色', '黑色']), (9, ['黑色', '白色'])]:
            with self.subTest(details_per_colour=count, page_order=labels):
                batch = self.root / f'batch-{count}'
                product = batch / 'Offline Product'
                product.mkdir(parents=True)
                originals = []
                groups = {}
                for index in range(2):
                    path = product / f'{index + 1:02d}.png'
                    Image.new('RGB', (83, 109), ('white', 'black')[index]).save(path)
                    originals.append(path)
                for colour in ('white', 'black'):
                    directory = batch / f'{colour} details'
                    directory.mkdir()
                    groups[colour] = []
                    for index in range(count):
                        path = directory / f'{index + 1:02d}.png'
                        Image.new('RGB', (84 + index, 110), colour).save(path)
                        groups[colour].append(path)
                # Saved detail order differs from filename order for both groups.
                groups = {colour: list(reversed(paths)) for colour, paths in groups.items()}
                config = replace(self.uploader.config, listing_profile='tshirt_bw',
                    product_root=str(batch), article_name='Offline', template_url=main.BW_TEMPLATE_URL,
                    description_mode='keep', white_detail_images=[str(path) for path in groups['white']],
                    black_detail_images=[str(path) for path in groups['black']])
                self.uploader.config = config
                self.uploader._fill_title = MagicMock()
                self.uploader._replace_description = MagicMock()
                jobs, _ = main.scan_product_folders(config)
                self.assertEqual(1, len(jobs))
                self.assertEqual(2, len(jobs[0].images))
                self.page.evaluate("""labels => {
                    resetRows(2);
                    document.querySelectorAll('#colors tbody > tr').forEach((row, index) =>
                        row.children[0].textContent = labels[index]);
                    window.uploadBatches = [];
                    document.querySelector('#upload').onchange = event => {
                        document.querySelector('#localMenu').style.display = 'none';
                        const names = Array.from(event.target.files).map(file => file.name);
                        uploadBatches.push({row: activeColor, names});
                        document.querySelectorAll('#colors .image-box')[activeColor].innerHTML = names
                            .map(name => card(`http://offline.test/image/${name}?row=${activeColor}`)).join('');
                        event.target.value = '';
                    };
                }""", labels)
                prepared = {}
                actual_prepare = main.prepare_carousel_jpg

                def capture_prepare(source, target, **kwargs):
                    prepared[target.name] = source
                    return actual_prepare(source, target, **kwargs)

                with patch.object(main, 'APP_DIR', batch), \
                     patch.object(main, 'prepare_carousel_jpg', side_effect=capture_prepare):
                    self.uploader._fill_job_fields(jobs[0])
                uploaded = self.page.evaluate('uploadBatches')
                self.assertEqual(2, len(uploaded))
                for label, upload in zip(labels, uploaded):
                    colour = 'white' if label == '白色' else 'black'
                    other = 'black' if colour == 'white' else 'white'
                    main_index = 0 if colour == 'white' else 1
                    uploaded_sources = [prepared[name] for name in upload['names']]
                    self.assertEqual([originals[main_index], *groups[colour]], uploaded_sources)
                    self.assertFalse(set(groups[other]).intersection(uploaded_sources))
                    self.assertEqual(count + 1, len(uploaded_sources))
                self.assertEqual(2 * (count + 1), self.page.locator('#colors .image-box img').count())
                self.assertEqual(self.uploader._tshirt_image_urls[0],
                    self.page.locator('.material-img-module img').get_attribute('src'))
                self.uploader._replace_description.assert_not_called()


if __name__ == '__main__':
    unittest.main()
