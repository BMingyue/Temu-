"""Offline regressions for capacity changes between and during products."""
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

import main
import tshirt_automation
from album_cleanup_policy import is_album_capacity_error


class AlbumMidrunTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        settings = patch.multiple(main, LOG_DIR=self.root / "logs", PROFILE_DIR=self.root / "profile")
        settings.start()
        self.addCleanup(settings.stop)

    def uploader(self, enabled=True):
        uploader = main.DxmUploader(main.AppConfig(album_cleanup_enabled=enabled,
            publish_mode="publish", album_cleanup_batch_id="c" * 32), MagicMock(), threading.Event())
        uploader.page = MagicMock()
        uploader.page.is_closed.return_value = False
        uploader.page.locator.return_value.evaluate_all.return_value = []
        return uploader

    def jobs(self):
        result = []
        for number in range(3):
            directory = self.root / f"Product {number}"
            directory.mkdir()
            source = directory / "source.jpg"
            source.write_bytes(b"fixture")
            result.append(main.ProductJob(directory, directory.name, [source]))
        return result

    def run_offline(self, uploader, jobs):
        context = MagicMock()
        context.pages = [uploader.page]
        runtime = MagicMock()
        runtime.__enter__.return_value.chromium.launch_persistent_context.return_value = context
        uploader._open_template = MagicMock()
        uploader._protect_album_page_images = MagicMock()
        uploader._ensure_album_space = MagicMock()
        uploader._publish_now = MagicMock()
        uploader._capture_failure = MagicMock(return_value=self.root / "evidence")
        with patch("playwright.sync_api.sync_playwright", return_value=runtime), \
                patch.object(main, "find_browser", return_value="offline-browser"), \
                patch.object(main, "completion_state_path", return_value=self.root / "state.json"):
            return uploader.run(jobs)

    def test_capacity_is_checked_before_every_product_not_only_at_start(self):
        uploader = self.uploader()
        jobs = self.jobs()
        order = []
        uploader._populate_job_fields = lambda job: order.append(("upload", job.title))
        # Record all three capacity checks as well as the publish boundaries.
        context = MagicMock()
        context.pages = [uploader.page]
        runtime = MagicMock()
        runtime.__enter__.return_value.chromium.launch_persistent_context.return_value = context
        uploader._open_template = MagicMock()
        uploader._protect_album_page_images = MagicMock()
        uploader._ensure_album_space = lambda job: order.append(("capacity", job.title))
        uploader._publish_now = MagicMock()
        with patch("playwright.sync_api.sync_playwright", return_value=runtime), \
                patch.object(main, "find_browser", return_value="offline-browser"), \
                patch.object(main, "completion_state_path", return_value=self.root / "state.json"):
            report = uploader.run(jobs)
        self.assertEqual([(step, job.title) for job in jobs for step in ("capacity", "upload")], order)
        self.assertEqual(3, report.succeeded)
        self.assertEqual(3, uploader._publish_now.call_count)

    def test_mid_upload_capacity_failure_stops_with_first_completed_and_two_pending(self):
        uploader = self.uploader()
        jobs = self.jobs()
        uploader._populate_job_fields = MagicMock(side_effect=[None, main.AutomationError("图片空间不足，上传失败")])
        report = self.run_offline(uploader, jobs)
        self.assertEqual((1, 1, 2), (report.attempted, report.succeeded, report.pending_count))
        self.assertEqual("album", report.blocked_category)
        self.assertEqual([], report.failures)
        self.assertEqual(2, uploader._ensure_album_space.call_count)
        self.assertEqual(2, uploader._populate_job_fields.call_count)
        self.assertEqual(1, uploader._publish_now.call_count)
        state = main.StateStore(self.root / "state.json")
        self.assertTrue(state.is_completed(jobs[0]))
        self.assertFalse(state.is_completed(jobs[1]))
        self.assertFalse(state.is_completed(jobs[2]))
        self.assertTrue(uploader._album_cleanup_suspended)

    def test_alert_is_immediate_album_error_and_disabled_mode_does_not_inspect(self):
        uploader = self.uploader()
        uploader.page.locator.return_value.evaluate_all.return_value = ["图片空间已满，请清理后重新上传"]
        with self.assertRaises(main.AlbumSpaceError):
            uploader._check_album_upload_space()
        disabled = self.uploader(False)
        disabled._check_album_upload_space()
        disabled.page.locator.assert_not_called()

    def test_image_format_error_and_user_stop_keep_original_exception(self):
        uploader = self.uploader()
        uploader._protect_album_page_images = MagicMock()
        uploader._ensure_album_space = MagicMock()
        for error in (main.AutomationError("图片尺寸超过限制"), main.StopRequested("停止")):
            with self.subTest(error=error):
                uploader._populate_job_fields = MagicMock(side_effect=error)
                with self.assertRaises(type(error)) as caught:
                    uploader._fill_job_fields(main.ProductJob(self.root, "Product", []))
                self.assertIs(error, caught.exception)

    def test_waits_for_blanket_and_tshirt_propagate_capacity_alert(self):
        uploader = self.uploader()
        uploader._check_album_upload_space = MagicMock(side_effect=main.AlbumSpaceError("图片空间不足"))
        for waiter in (lambda: uploader._wait_for_carousel_images(MagicMock(), 1),
                       lambda: tshirt_automation._wait_color_images(uploader, MagicMock(), 1)):
            with self.subTest(waiter=waiter), self.assertRaises(main.AlbumSpaceError):
                waiter()
        self.assertEqual(2, uploader._check_album_upload_space.call_count)

    def test_matching_requires_capacity_subject_and_shortage(self):
        for text in ("图片空间已满", "图库剩余空间不足", "相册容量超限", "Image storage full"):
            self.assertTrue(is_album_capacity_error(text), text)
        for text in ("图片尺寸超过限制", "文件大小超出5MB", "图库空间充足", "网络连接超时", None):
            self.assertFalse(is_album_capacity_error(text), text)


if __name__ == "__main__":
    unittest.main()
