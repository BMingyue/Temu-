import json
import queue
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import MagicMock, patch

import main


class ProfileIntegrationTests(unittest.TestCase):
    def test_old_saved_edit_link_is_corrected_on_load_and_save(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'config.json'
            path.write_text(json.dumps({'template_url': 'https://www.dianxiaomi.com/web/popTemu/edit?id=220114595107558624。',
                                        'product_root': 'D:/existing'}), encoding='utf-8')
            with patch.object(main, 'CONFIG_PATH', path):
                config = main.AppConfig.load()
                self.assertEqual('blanket', config.listing_profile)
                self.assertEqual('https://www.dianxiaomi.com/web/popTemu/quoteEdit?id=220114595107558624', config.template_url)
                config.save()
            self.assertEqual(config.template_url, json.loads(path.read_text(encoding='utf-8'))['template_url'])
            self.assertEqual('D:/existing', config.product_root)

    def test_programmatic_uploader_also_normalizes_edit_link(self):
        uploader = main.DxmUploader(main.AppConfig(template_url='https://www.dianxiaomi.com/web/popTemu/edit?id=123'),
                                    lambda _: None, threading.Event())
        self.assertEqual('https://www.dianxiaomi.com/web/popTemu/quoteEdit?id=123', uploader.config.template_url)

    def test_entry_paste_conversion_updates_visible_field(self):
        app = main.UploaderApp.__new__(main.UploaderApp)
        app.url_var = MagicMock()
        app.url_var.get.return_value = 'https://www.dianxiaomi.com/web/popTemu/edit?id=123。'
        app._normalize_template_entry()
        app.url_var.set.assert_called_once_with('https://www.dianxiaomi.com/web/popTemu/quoteEdit?id=123')

    def test_blanket_profile_keeps_existing_image_sequence(self):
        uploader = main.DxmUploader(main.AppConfig(), lambda _: None, threading.Event())
        calls = []
        uploader._fill_title = lambda label, value: calls.append(label)
        uploader._upload_carousel = lambda job: calls.append('carousel')
        uploader._replace_variant_images = lambda: calls.append('variants')
        uploader._replace_description = lambda: calls.append('description')
        uploader._fill_job_fields(main.ProductJob(Path('Product'), 'Product', []))
        self.assertEqual(['产品标题', '英文标题', 'carousel', 'variants', 'description'], calls)

    def test_tshirt_profile_uses_color_upload_material_refresh_and_stable_skc(self):
        with tempfile.TemporaryDirectory() as directory:
            import tshirt_automation
            uploader = main.DxmUploader(main.AppConfig(listing_profile='tshirt', article_name='BKShirt',
                                        template_url='https://www.dianxiaomi.com/web/popTemu/edit?id=123&tracking=first'),
                                        lambda _: None, threading.Event())
            calls = []
            reserved = []
            uploader._fill_title = lambda label, value: calls.append(label)
            uploader._replace_description = lambda: calls.append('description')
            uploader._upload_carousel = MagicMock()
            uploader._replace_variant_images = MagicMock()
            job = main.ProductJob(Path(directory) / 'Product A', 'Product A', [])
            def upload(owner, product, numbers, prepare_image):
                calls.append('color-upload')
                reserved.append(numbers)
                self.assertEqual(2, len(numbers))
                self.assertTrue(all(len(n) <= 22 for n in numbers))
            with patch.object(main, 'APP_DIR', Path(directory)), \
                 patch.object(tshirt_automation, 'color_row_count', return_value=2), \
                 patch.object(tshirt_automation, 'upload_images', side_effect=upload), \
                 patch.object(tshirt_automation, 'refresh_material_image', side_effect=lambda owner: calls.append('material-refresh')), \
                 patch.object(tshirt_automation, 'verify_description_images', side_effect=lambda owner: calls.append('description-verify')):
                uploader._fill_job_fields(job)
                uploader.config.template_url = 'https://www.dianxiaomi.com/web/popTemu/quoteEdit?tracking=second&id=123'
                uploader._fill_job_fields(job)
            self.assertEqual(reserved[0], reserved[1])
            self.assertEqual(['产品标题', '英文标题', 'color-upload', 'material-refresh', 'description', 'description-verify'] * 2, calls)
            uploader._upload_carousel.assert_not_called()
            uploader._replace_variant_images.assert_not_called()

    def test_background_batch_keeps_its_original_profile_when_ui_config_changes(self):
        app = main.UploaderApp.__new__(main.UploaderApp)
        app.start_button = app.stop_button = app.retry_failed_button = MagicMock()
        app.root = MagicMock()
        app._failure_dialog = None
        app.status_var = MagicMock()
        app.stop_event = threading.Event()
        app._log = MagicMock()
        app._ask_retry_after_failure = MagicMock()
        app.messages = queue.Queue()
        config = main.AppConfig(listing_profile='tshirt', article_name='Original', common_detail_images=['original.png'])
        jobs = [main.ProductJob(Path('Product'), 'Product', [])]
        with patch.object(main.threading, 'Thread') as thread, \
             patch.object(main, 'confirm_image_order', return_value=True):
            app._launch_worker(jobs, config, max_job_attempts=2, recovery=False)
            task = thread.call_args.kwargs['target']
        config.listing_profile = 'blanket'
        config.article_name = 'Changed'
        config.common_detail_images.append('new.png')
        with patch.object(main, 'DxmUploader') as factory:
            task()
        snapshot = factory.call_args.args[0]
        self.assertEqual('tshirt', snapshot.listing_profile)
        self.assertEqual('Original', snapshot.article_name)
        self.assertEqual(['original.png'], snapshot.common_detail_images)
        self.assertIsNot(config, snapshot)

    def test_automatic_failed_batch_recovery_uses_original_profile_snapshot(self):
        app = main.UploaderApp.__new__(main.UploaderApp)
        job = main.ProductJob(Path('Product'), 'Product', [])
        report = main.RunReport(1, 0, [main.JobFailure('Product', 'failed', Path('evidence'), job.folder)])
        app.stop_event = threading.Event()
        app._batch_config = main.AppConfig(listing_profile='tshirt', article_name='Original', concurrent_pages=3)
        app._jobs_for_failures = lambda *_: [job]
        app._append_log = MagicMock()
        app._current_config = MagicMock(side_effect=AssertionError('must not read changed UI config'))
        app._launch_worker = MagicMock()
        with patch.object(main.messagebox, 'askyesno', return_value=True):
            self.assertTrue(app._offer_failed_batch_recovery(report, [job]))
        retry_config = app._launch_worker.call_args.args[1]
        self.assertEqual('tshirt', retry_config.listing_profile)
        self.assertEqual('Original', retry_config.article_name)
        self.assertEqual(1, retry_config.concurrent_pages)
        app._current_config.assert_not_called()


if __name__ == '__main__':
    unittest.main()
