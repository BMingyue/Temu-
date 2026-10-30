"""Offline album integration regressions; never open or delete a real album."""
import json
import sys
import tempfile
import threading
import types
import unittest
from pathlib import Path
from unittest.mock import MagicMock, call, patch

import main


class AlbumIntegrationTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.log_patch = patch.object(main, "LOG_DIR", self.root / "logs")
        self.log_patch.start()
        self.addCleanup(self.log_patch.stop)

    def uploader(self, enabled=True, **settings):
        config = main.AppConfig(album_cleanup_enabled=enabled,
                                album_cleanup_batch_id="a" * 32, **settings)
        result = main.DxmUploader(config, MagicMock(), threading.Event())
        result.page = MagicMock()
        result.page.is_closed.return_value = False
        result.page.locator.return_value.evaluate_all.return_value = ["https://img.example.com/template.jpg"]
        return result

    def job(self, name="Safe Product"):
        folder = self.root / name
        folder.mkdir(exist_ok=True)
        source = folder / "product.png"
        source.write_bytes(b"image")
        return main.ProductJob(folder, name, [source])

    @staticmethod
    def fake_driver(error=None):
        driver = types.ModuleType("album_cleanup")
        driver.AlbumCleanupError = type("AlbumCleanupError", (RuntimeError,), {})
        driver.AlbumCleaner = MagicMock()
        if error is not None:
            driver.AlbumCleaner.return_value.ensure_space.side_effect = error
        return driver

    def test_defaults_are_opt_in_and_effective_single_page_preserves_preference(self):
        config = main.AppConfig(concurrent_pages=3)
        self.assertIs(config.album_cleanup_enabled, False)
        self.assertEqual(100, config.album_cleanup_threshold_mb)
        self.assertEqual("", config.album_cleanup_batch_id)
        self.assertEqual(3, main.effective_concurrent_pages(config))
        config.album_cleanup_enabled = True
        self.assertEqual(1, main.effective_concurrent_pages(config))
        self.assertEqual(3, config.concurrent_pages)
        config.album_cleanup_enabled = False
        self.assertEqual(3, main.effective_concurrent_pages(config))

    def test_disabled_fill_only_runs_existing_upload_flow(self):
        uploader = self.uploader(enabled=False)
        uploader._populate_job_fields = MagicMock()
        uploader._protect_album_page_images = MagicMock()
        uploader._ensure_album_space = MagicMock()
        job = self.job()
        uploader._fill_job_fields(job)
        uploader._populate_job_fields.assert_called_once_with(job)
        uploader._protect_album_page_images.assert_not_called()
        uploader._ensure_album_space.assert_not_called()
        uploader.page.context.new_page.assert_not_called()
        self.assertFalse((self.root / "logs").exists())

    def test_disabled_ensure_is_noop_without_browser_tab_or_driver(self):
        uploader = self.uploader(enabled=False)
        with patch.dict(sys.modules, {"album_cleanup": None}):
            uploader._ensure_album_space(self.job())
        uploader.page.context.new_page.assert_not_called()

    def test_fill_protects_checks_then_uploads_and_updates_protection_afterwards(self):
        uploader = self.uploader()
        job = self.job()
        recorder = MagicMock()
        uploader._protect_album_page_images = recorder.protect
        uploader._ensure_album_space = recorder.space
        uploader._populate_job_fields = recorder.populate
        uploader._fill_job_fields(job)
        self.assertEqual([call.protect(), call.space(job), call.populate(job), call.protect(strict=False)],
                         recorder.mock_calls)

    def test_failed_partial_upload_still_protects_new_images(self):
        uploader = self.uploader()
        recorder = MagicMock()
        uploader._protect_album_page_images = recorder.protect
        uploader._ensure_album_space = recorder.space
        uploader._populate_job_fields = recorder.populate
        recorder.populate.side_effect = RuntimeError("图片上传中断")
        job = self.job()
        with self.assertRaisesRegex(RuntimeError, "图片上传中断"):
            uploader._fill_job_fields(job)
        self.assertEqual([call.protect(), call.space(job), call.populate(job), call.protect(strict=False)],
                         recorder.mock_calls)

    def test_failed_capacity_check_does_not_mutate_product(self):
        uploader = self.uploader()
        uploader._protect_album_page_images = MagicMock()
        uploader._ensure_album_space = MagicMock(side_effect=main.AlbumSpaceError("图库不足"))
        uploader._populate_job_fields = MagicMock()
        with self.assertRaises(main.AlbumSpaceError):
            uploader._fill_job_fields(self.job())
        uploader._populate_job_fields.assert_not_called()
        uploader._protect_album_page_images.assert_called_once_with()

    def test_driver_uses_deduplicated_sources_threshold_and_protected_registry(self):
        uploader = self.uploader(album_cleanup_threshold_mb=200)
        job = self.job()
        job.images[0].write_bytes(b"a" * (1024 * 1024))
        second = job.folder / "detail.png"
        second.write_bytes(b"a" * (2 * 1024 * 1024))
        job.color_image_sets = {"white": [job.images[0], second], "black": [job.images[0], second]}
        uploader._album_protected_urls = {"https://img.example.com/current.jpg"}
        driver = self.fake_driver()
        with patch.dict(sys.modules, {"album_cleanup": driver}):
            uploader._ensure_album_space(job)
        args, options = driver.AlbumCleaner.call_args
        self.assertEqual((uploader.page.context.new_page.return_value,), args)
        self.assertEqual(200, options["threshold_mb"])
        self.assertEqual(uploader._album_protected_urls, options["protected_urls"])
        self.assertEqual(self.root / "logs" / "album-cleanup" / ("a" * 32) / "cleanup.jsonl", options["audit_path"])
        driver.AlbumCleaner.return_value.ensure_space.assert_called_once_with(reserve_mb=13.0)
        uploader.page.context.new_page.return_value.close.assert_called_once_with()

    def test_driver_failure_becomes_album_error_and_closes_only_album_tab(self):
        uploader = self.uploader()
        driver = self.fake_driver(RuntimeError("无法核对图库分页"))
        with patch.dict(sys.modules, {"album_cleanup": driver}), \
                self.assertRaisesRegex(main.AlbumSpaceError, "无法核对图库分页"):
            uploader._ensure_album_space(self.job())
        uploader.page.context.new_page.return_value.close.assert_called_once_with()
        uploader.page.close.assert_not_called()

    def test_stop_during_cleanup_is_not_reclassified_or_retried(self):
        uploader = self.uploader()
        driver = self.fake_driver(main.StopRequested("用户停止"))
        with patch.dict(sys.modules, {"album_cleanup": driver}), self.assertRaises(main.StopRequested):
            uploader._ensure_album_space(self.job())
        uploader.page.context.new_page.return_value.close.assert_called_once_with()

    def test_album_tab_creation_error_stops_as_shared_album_error(self):
        uploader = self.uploader()
        uploader.page.context.new_page.side_effect = RuntimeError("浏览器无法新建图库页面")
        with patch.dict(sys.modules, {"album_cleanup": self.fake_driver()}), \
                self.assertRaises(main.AlbumSpaceError):
            uploader._ensure_album_space(self.job())

    def test_protection_persists_and_reloads_for_same_batch(self):
        uploader = self.uploader()
        first = "https://img.example.com/template.jpg?width=400"
        uploader.page.locator.return_value.evaluate_all.return_value = [first]
        uploader._protect_album_page_images()
        path = self.root / "logs" / "album-cleanup" / ("a" * 32) / "protected.json"
        self.assertEqual([first], json.loads(path.read_text(encoding="utf-8"))["urls"])
        resumed = self.uploader()
        self.assertEqual({first}, resumed._album_protected_urls)
        second = "https://img.example.com/new-upload.jpg"
        resumed.page.locator.return_value.evaluate_all.return_value = [second]
        resumed._protect_album_page_images()
        self.assertEqual({first, second}, set(json.loads(path.read_text(encoding="utf-8"))["urls"]))
        another = self.uploader()
        self.assertEqual({first, second}, another._album_protected_urls)
        different = main.DxmUploader(main.AppConfig(album_cleanup_enabled=True,
            album_cleanup_batch_id="b" * 32), MagicMock(), threading.Event())
        self.assertEqual(set(), different._album_protected_urls)

    def test_corrupt_or_incomplete_protection_registry_blocks_cleanup(self):
        path = self.root / "logs" / "album-cleanup" / ("a" * 32) / "protected.json"
        path.parent.mkdir(parents=True)
        for raw in ("broken JSON", "[]", '{"urls": null}', '{"urls": [42]}',
                    '{"urls": [""]}', '{"urls": ["/relative.jpg"]}'):
            with self.subTest(raw=raw):
                path.write_text(raw, encoding="utf-8")
                self.assertRaises(main.AlbumSpaceError, self.uploader)

    def test_failed_protection_persistence_disables_future_cleanup(self):
        uploader = self.uploader()
        with patch.object(Path, "write_text", side_effect=OSError("磁盘已满")):
            uploader._protect_album_page_images(strict=False)
        self.assertTrue(uploader._album_protection_failed)
        with patch.dict(sys.modules, {"album_cleanup": None}), self.assertRaises(main.AlbumSpaceError):
            uploader._ensure_album_space(self.job())
        uploader.page.context.new_page.assert_not_called()

    def test_closed_page_after_upload_blocks_future_cleanup(self):
        uploader = self.uploader()
        uploader.page.is_closed.return_value = True
        uploader._protect_album_page_images(strict=False)
        self.assertTrue(uploader._album_protection_failed)
        uploader.page.is_closed.return_value = False
        with self.assertRaises(main.AlbumSpaceError):
            uploader._ensure_album_space(self.job())
        uploader.page.context.new_page.assert_not_called()

    def test_capacity_failure_stops_batch_without_retry_next_product_or_completed_state_change(self):
        uploader = self.uploader(publish_mode="publish", concurrent_pages=3)
        jobs = [self.job(name) for name in ("Completed Product", "Pending One", "Pending Two")]
        state_path = self.root / "state.json"
        state = main.StateStore(state_path)
        state.mark_completed(jobs[0], "published")
        before = state_path.read_bytes()
        context = MagicMock()
        context.pages = [uploader.page]
        runtime = MagicMock()
        runtime.__enter__.return_value.chromium.launch_persistent_context.return_value = context
        uploader._open_template = MagicMock()
        uploader._protect_album_page_images = MagicMock()
        uploader._ensure_album_space = MagicMock(side_effect=main.AlbumSpaceError("图库清理后空间仍不足"))
        uploader._populate_job_fields = MagicMock()
        uploader._publish_now = MagicMock()
        uploader._schedule_publish = MagicMock()
        uploader._capture_failure = MagicMock(return_value=self.root / "evidence")
        uploader._run_concurrent = MagicMock(side_effect=AssertionError("清理时不应进入并发上传"))
        with patch("playwright.sync_api.sync_playwright", return_value=runtime), \
                patch.object(main, "find_browser", return_value="offline-browser"), \
                patch.object(main, "completion_state_path", return_value=state_path), \
                patch.object(main, "PROFILE_DIR", self.root / "profile"):
            report = uploader.run(jobs)
        self.assertEqual((0, 0, 2, 1), (report.attempted, report.succeeded, report.pending_count, report.already_completed))
        self.assertEqual([], report.failures)
        self.assertEqual("album", report.blocked_category)
        self.assertIn("图库清理后空间仍不足", report.blocked_reason)
        self.assertEqual(before, state_path.read_bytes())
        uploader._open_template.assert_called_once_with()
        uploader._ensure_album_space.assert_called_once_with(jobs[1])
        uploader._populate_job_fields.assert_not_called()
        uploader._publish_now.assert_not_called()
        uploader._schedule_publish.assert_not_called()
        uploader._run_concurrent.assert_not_called()
        context.close.assert_called_once_with()
        self.assertEqual(3, uploader.config.concurrent_pages)
        self.assertTrue(issubclass(main.AlbumSpaceError, main.TemplateValidationError))
        self.assertFalse(uploader._should_retry_job(jobs[1], main.AlbumSpaceError("不足"), 1))
        self.assertFalse(main.UploaderApp._offer_failed_batch_recovery(MagicMock(), report, jobs))

    def test_report_and_popup_explain_album_problem_instead_of_template_url(self):
        report = main.RunReport(attempted=0, succeeded=0, failures=[], pending_count=2,
            blocked_reason="图库空间不足，已停止清理", blocked_category="album")
        rendered = report.render()
        self.assertIn("图库空间问题", rendered)
        self.assertIn("未提交，不计为商品失败", rendered)
        self.assertNotIn("修正模板", rendered)
        app = main.UploaderApp.__new__(main.UploaderApp)
        app._append_log = MagicMock()
        app.status_var = MagicMock()
        app.start_button = MagicMock()
        app.stop_button = MagicMock()
        app._refresh_failure_records = MagicMock()
        with patch.object(main.messagebox, "showwarning") as warning, \
                patch.object(main.messagebox, "showinfo") as info:
            app._finish_with_report(report)
        warning.assert_called_once()
        self.assertIn("图库", warning.call_args.args[0])
        self.assertNotIn("模板", warning.call_args.args[0])
        self.assertIn("图库", app.status_var.set.call_args.args[0])
        info.assert_not_called()


if __name__ == "__main__":
    unittest.main()
