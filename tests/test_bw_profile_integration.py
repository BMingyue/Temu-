import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import MagicMock, patch

import main
import tshirt_automation


class BlackWhiteProfileTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)

    def product(self, name='BW Product', count=2):
        folder = self.root / name
        folder.mkdir()
        for index in range(count):
            (folder / f'{index+1:02d}.png').write_bytes(b'image')
        return folder

    def test_bw_scan_requires_two_originals_and_preserves_nine_details_per_color(self):
        product = self.product()
        details = self.root / 'Shared'
        details.mkdir()
        for index in range(9):
            (details / f'{index+1}.jpg').write_bytes(b'image')
        jobs, warnings = main.scan_product_folders(main.AppConfig(
            listing_profile='tshirt_bw', product_root=str(product),
            white_detail_images=[str(p) for p in details.iterdir()],
            black_detail_images=[str(p) for p in details.iterdir()]))
        self.assertEqual(1, len(jobs))
        self.assertEqual(2, len(jobs[0].images))
        self.assertEqual(['01.png', '02.png'], [p.name for p in jobs[0].images[:2]])
        self.assertEqual(0, jobs[0].common_detail_count)
        self.assertEqual(10, len(jobs[0].color_image_sets['white']))
        self.assertEqual(10, len(jobs[0].color_image_sets['black']))

    def test_missing_or_extra_product_images_are_not_silently_mapped(self):
        for number in (1, 3):
            product = self.product(f'Product {number}', number)
            jobs, warnings = main.scan_product_folders(main.AppConfig(listing_profile='tshirt_bw', product_root=str(product)))
            self.assertEqual([], jobs)
            self.assertTrue(any('需恰好 2 张' in w and main.is_blocking_scan_warning(w) for w in warnings))

    def test_manual_product_order_drives_color_positions(self):
        product = self.product()
        config = main.AppConfig(listing_profile='tshirt_bw', product_root=str(product),
                                product_image_orders={main._path_identity(product): ['02.png','01.png']})
        jobs, _ = main.scan_product_folders(config)
        self.assertEqual(['02.png','01.png'], [p.name for p in jobs[0].images])

    def test_bw_flow_passes_two_distinct_color_sets_including_separate_details(self):
        config = main.AppConfig(listing_profile='tshirt_bw', article_name='BWShirt', bw_first_color='black',
                                description_mode='keep', template_url=main.BW_TEMPLATE_URL)
        uploader = main.DxmUploader(config, MagicMock(), threading.Event())
        uploader._fill_title = MagicMock()
        uploader._replace_description = MagicMock()
        paths = [self.root / name for name in ('black.png', 'white.png', 'black-detail.png', 'white-detail.png')]
        job = main.ProductJob(self.root, 'BW Product', paths[:2], color_image_sets={
            'black': [paths[0], paths[2]], 'white': [paths[1], paths[3]]})
        with patch.object(main, 'APP_DIR', self.root), \
             patch.object(tshirt_automation, 'validate_bw_rows', return_value=['white','black']), \
             patch.object(tshirt_automation, 'color_row_count', return_value=2), \
             patch.object(tshirt_automation, 'upload_images') as upload, \
             patch.object(tshirt_automation, 'refresh_material_image'), \
             patch.object(tshirt_automation, 'verify_description_images') as verify:
            uploader._fill_job_fields(job)
        sets = upload.call_args.kwargs['color_image_sets']
        self.assertEqual([paths[0],paths[2]], sets['black'])
        self.assertEqual([paths[1],paths[3]], sets['white'])
        uploader._replace_description.assert_not_called()
        verify.assert_not_called()

    def test_keep_description_is_a_complete_noop_for_both_previous_profiles(self):
        for profile in ('blanket','tshirt'):
            config = main.AppConfig(listing_profile=profile, description_mode='keep', article_name='Shirt')
            uploader = main.DxmUploader(config, MagicMock(), threading.Event())
            uploader._fill_title = uploader._upload_carousel = uploader._replace_variant_images = MagicMock()
            uploader._replace_description = MagicMock()
            with patch.object(main, 'APP_DIR', self.root), \
                 patch.object(tshirt_automation, 'color_row_count', return_value=1), \
                 patch.object(tshirt_automation, 'upload_images'), \
                 patch.object(tshirt_automation, 'refresh_material_image'), \
                 patch.object(tshirt_automation, 'verify_description_images') as verify:
                uploader._fill_job_fields(main.ProductJob(self.root, 'Product', []))
            uploader._replace_description.assert_not_called()
            verify.assert_not_called()

    def test_canceling_preflight_does_not_launch_or_consume_a_batch(self):
        app = main.UploaderApp.__new__(main.UploaderApp)
        app.root = MagicMock()
        app._append_log = MagicMock()
        app._batch_config = None
        with patch.object(main, 'confirm_image_order', return_value=False) as confirm, \
             patch.object(main.threading, 'Thread') as worker, \
             patch.object(main, 'STATE_PATH', self.root / 'state.json'):
            self.assertFalse(app._launch_worker([main.ProductJob(self.root,'Product',[])], main.AppConfig(), 2, False))
        worker.assert_not_called()
        self.assertIsNone(app._batch_config)
        confirm.assert_called_once()

    def test_bw_and_description_settings_roundtrip(self):
        path = self.root / 'config.json'
        config = main.AppConfig(listing_profile='tshirt_bw', article_name='BWShirt',
                               description_mode='keep', bw_first_color='black', template_url=main.BW_TEMPLATE_URL)
        with patch.object(main, 'CONFIG_PATH', path):
            config.save()
            loaded = main.AppConfig.load()
        self.assertEqual(config, loaded)

    def test_blackwhite_completion_and_failure_history_are_separate_from_old_script(self):
        old = main.AppConfig(listing_profile='tshirt', publish_mode='publish')
        new = main.AppConfig(listing_profile='tshirt_bw', template_url=main.BW_TEMPLATE_URL, publish_mode='publish')
        job = main.ProductJob(self.root / 'Same Product', 'Same Product', [])
        with patch.object(main, 'STATE_PATH', self.root / 'state.json'), \
             patch.object(main, 'FAILURE_DIR', self.root / 'failures'):
            old_state = main.StateStore(main.completion_state_path(old))
            old_state.mark_completed(job, 'published')
            self.assertFalse(main.StateStore(main.completion_state_path(new)).is_completed(job))
            self.assertNotEqual(main.completion_state_path(old), main.completion_state_path(new))
            failure = main.JobFailure(job.title, 'upload failed', self.root, job.folder)
            old_worker = main.DxmUploader(old, MagicMock(), threading.Event())
            bw_worker = main.DxmUploader(new, MagicMock(), threading.Event())
            old_worker._remember_failure(failure)
            bw_worker._remember_failure(failure)
            bw_worker._resolve_failure(job)
            old_records = main.FailureStore(main.failure_record_directory(old)).load()
            new_records = main.FailureStore(main.failure_record_directory(new)).load()
            self.assertEqual('failed', old_records[0].status)
            self.assertEqual('resolved', new_records[0].status)

    def test_preflight_uses_pending_products_and_respects_single_review_limit(self):
        jobs = [main.ProductJob(self.root / f'Product {i}', f'Product {i}', []) for i in range(5)]
        with patch.object(main, 'STATE_PATH', self.root / 'state.json'):
            state = main.StateStore(main.STATE_PATH)
            for index in (0,2,4):
                state.mark_completed(jobs[index], 'published')
            bulk = main.AppConfig(publish_mode='publish')
            self.assertEqual([jobs[1],jobs[3]], main.pending_jobs_for_run(bulk, jobs))
            review = main.AppConfig(publish_mode='review')
            self.assertEqual([jobs[1]], main.pending_jobs_for_run(review, jobs))
            app = main.UploaderApp.__new__(main.UploaderApp)
            app.root = MagicMock()
            app._append_log = MagicMock()
            with patch.object(main, 'confirm_image_order', return_value=False) as confirm:
                self.assertFalse(app._launch_worker(jobs, bulk, 2, False))
                self.assertEqual([jobs[1],jobs[3]], confirm.call_args.args[1])

    def test_no_pending_products_does_not_show_preflight_or_launch_worker(self):
        job = main.ProductJob(self.root,'Product',[])
        app = main.UploaderApp.__new__(main.UploaderApp)
        app._append_log = MagicMock()
        with patch.object(main, 'STATE_PATH', self.root / 'state.json'):
            main.StateStore(main.STATE_PATH).mark_completed(job,'published')
            with patch.object(main, 'confirm_image_order') as confirm, patch.object(main.threading,'Thread') as thread:
                self.assertFalse(app._launch_worker([job], main.AppConfig(), 2, False))
            confirm.assert_not_called()
            thread.assert_not_called()


if __name__ == '__main__':
    unittest.main()
