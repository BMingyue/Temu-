import json
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import MagicMock, patch

import main


class ProductImageCountTests(unittest.TestCase):
    def setUp(self):
        scratch = tempfile.TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        self.root = Path(scratch.name)

    def product(self, name, count):
        folder = self.root / name
        folder.mkdir()
        for number in range(count):
            (folder / f'{number + 1}.jpg').write_bytes(b'image')
        return folder

    def scan(self, **kwargs):
        return main.scan_product_folders(main.AppConfig(product_root=str(self.root), **kwargs))

    def count_warnings(self, warnings):
        return [warning for warning in warnings if main.is_image_count_warning(warning)]

    def test_single_product_with_one_image_is_valid(self):
        folder = self.product('One Product', 1)
        jobs, warnings = main.scan_product_folders(main.AppConfig(product_root=str(folder), min_images=3))
        self.assertEqual(1, len(jobs))
        self.assertEqual(1, len(jobs[0].images))
        self.assertFalse(self.count_warnings(warnings))
        self.assertFalse(any(main.is_blocking_scan_warning(w) for w in warnings))

    def test_all_26_products_with_one_image_are_valid_without_count_alarm(self):
        for index in range(26):
            self.product(f'Shirt {index + 1}', 1)
        jobs, warnings = self.scan(min_images=3)
        self.assertEqual((26, 26, 0), main.summarize_scan(jobs, warnings))
        self.assertFalse(self.count_warnings(warnings))

    def test_majority_four_with_one_outlier_warns_and_keeps_all_products(self):
        self.product('Regular A', 4)
        self.product('Regular B', 4)
        self.product('Short Product', 1)
        jobs, warnings = self.scan()
        alarms = self.count_warnings(warnings)
        self.assertEqual((3, 3, 0), main.summarize_scan(jobs, warnings))
        self.assertEqual(2, len(alarms))
        self.assertIn('通常每款 4 张', alarms[0])
        self.assertIn('Short Product（1 张', alarms[1])
        self.assertNotIn('Regular A', alarms[1])

    def test_equal_sized_groups_warn_without_inventing_a_majority(self):
        self.product('One Image', 1)
        self.product('Four Images', 4)
        jobs, warnings = self.scan()
        alarms = self.count_warnings(warnings)
        self.assertEqual(2, len(jobs))
        self.assertEqual(3, len(alarms))
        self.assertIn('没有唯一', alarms[0])
        self.assertTrue(any('One Image' in warning for warning in alarms))
        self.assertTrue(any('Four Images' in warning for warning in alarms))

    def test_common_details_and_upload_limit_do_not_change_comparison(self):
        self.product('Regular A', 12)
        self.product('Regular B', 12)
        self.product('Different Product', 11)
        details = self.product('Shared Details', 2)
        jobs, warnings = self.scan(common_detail_images=[str(p) for p in details.iterdir()])
        self.assertEqual(3, len(jobs))
        self.assertTrue(all(len(job.images) == 10 for job in jobs))
        alarms = self.count_warnings(warnings)
        self.assertIn('通常每款 12 张', alarms[0])
        self.assertIn('Different Product（11 张', alarms[1])
        self.assertFalse(any('Shared Details' in warning for warning in alarms))

    def test_empty_folders_remain_blocked(self):
        self.product('Valid Product', 1)
        self.product('Empty Product', 0)
        jobs, warnings = self.scan()
        self.assertEqual((2, 1, 1), main.summarize_scan(jobs, warnings))
        self.assertFalse(self.count_warnings(warnings))

    def test_selected_details_inside_one_product_do_not_inflate_its_image_count(self):
        first = self.product('Regular A', 4)
        self.product('Regular B', 4)
        self.product('Regular C', 4)
        shared = first / '5-detail.png'
        shared.write_bytes(b'image')
        jobs, warnings = self.scan(common_detail_images=[str(shared)])
        self.assertEqual(3, len(jobs))
        self.assertFalse(self.count_warnings(warnings))
        self.assertTrue(all(job.common_detail_count == 1 for job in jobs))

    def test_existing_three_image_setting_is_migrated_and_saved(self):
        path = self.root / 'config.json'
        path.write_text(json.dumps({'min_images': 3, 'product_root': 'D:/colleague',
                                   'common_detail_images': ['D:/detail.png']}), encoding='utf-8')
        with patch.object(main, 'CONFIG_PATH', path):
            config = main.AppConfig.load()
            self.assertEqual(1, config.min_images)
            config.save()
        self.assertEqual(1, json.loads(path.read_text(encoding='utf-8'))['min_images'])
        self.assertEqual(['D:/detail.png'], config.common_detail_images)

    def test_ui_warns_once_then_clears_when_folder_counts_match(self):
        self.product('Regular A', 4)
        self.product('Regular B', 4)
        short = self.product('Short Product', 1)
        app = SimpleNamespace(_current_config=lambda: main.AppConfig(product_root=str(self.root)),
                              _append_log=MagicMock(), status_var=MagicMock(), status_label=MagicMock(),
                              _last_blocked_signature=(), _last_count_warning_signature=())
        with patch.object(main.messagebox, 'showwarning') as warning:
            self.assertEqual(3, len(main.UploaderApp._scan(app)))
            self.assertEqual(1, warning.call_count)
            self.assertIn('仍然可以处理', warning.call_args.args[1])
            main.UploaderApp._scan(app)
            self.assertEqual(1, warning.call_count)
            for number in (2, 3, 4):
                (short / f'{number}.jpg').write_bytes(b'image')
            main.UploaderApp._scan(app)
            self.assertEqual((), app._last_count_warning_signature)
            self.assertIn('全部可以处理', app.status_var.set.call_args.args[0])


if __name__ == '__main__':
    unittest.main()
