"""Offline upload recovery with real capacity checks against a fake album.

Every data path is temporary. Browser launch, template editing and publishing
are replaced with test doubles; the album API is an in-memory fixture.
"""
import json
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, Mock, patch

import main
from album_cleanup import ALBUM_URL, MIB
from failure_records import FailureStore

try:
    from tests.test_album_cleanup_adapter import FakeAlbumApi
except ImportError:
    from test_album_cleanup_adapter import FakeAlbumApi


class UploadRecoveryIntegrationTests(unittest.TestCase):
    BATCH_ID = "d" * 32

    def setUp(self):
        scratch = tempfile.TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        self.root = Path(scratch.name)
        paths = patch.multiple(
            main, APP_DIR=self.root, CONFIG_PATH=self.root / "config.json",
            STATE_PATH=self.root / "state.json", FAILURE_DIR=self.root / "failure-records",
            LOG_DIR=self.root / "logs", PROFILE_DIR=self.root / "browser-profile",
            UPLOAD_STAGE_DIR=self.root / "upload-staging",
        )
        paths.start()
        self.addCleanup(paths.stop)

    @property
    def protection_path(self):
        return self.root / "logs" / "album-cleanup" / self.BATCH_ID / "protected.json"

    def uploader(self, batch_id=None):
        config = main.AppConfig(album_cleanup_enabled=True,
                                album_cleanup_batch_id=self.BATCH_ID if batch_id is None else batch_id,
                                album_cleanup_threshold_mb=100,
                                concurrent_pages=1, publish_mode="publish")
        uploader = main.DxmUploader(config, Mock(), threading.Event(), max_job_attempts=1)
        uploader.page = MagicMock()
        uploader.page.is_closed.return_value = False
        uploader.page.locator.return_value.evaluate_all.return_value = [
            "https://img.example.com/template.jpg"
        ]
        uploader._check_album_upload_space = Mock()
        uploader._sleep = Mock()
        return uploader

    def job(self, name="Offline Product"):
        folder = self.root / name
        folder.mkdir(exist_ok=True)
        source = folder / "source.jpg"
        source.write_bytes(b"offline fixture")
        return main.ProductJob(folder, name, [source])

    def test_new_batch_allows_cleanup_and_upload_error_suspends_only_deletion(self):
        uploader = self.uploader()
        self.assertFalse(uploader._album_cleanup_suspended)
        self.assertFalse(uploader._album_protection_failed)
        uploader._ensure_album_space = Mock()
        error = RuntimeError("颜色图缩略图加载失败")
        uploader._populate_job_fields = Mock(side_effect=error)
        with self.assertRaises(RuntimeError) as caught:
            uploader._fill_job_fields(self.job())
        self.assertIs(error, caught.exception)
        self.assertTrue(uploader._album_cleanup_suspended)
        self.assertFalse(uploader._album_protection_failed)
        raw = json.loads(self.protection_path.read_text(encoding="utf-8"))
        self.assertIs(raw["cleanup_suspended"], True)
        self.assertEqual(["https://img.example.com/template.jpg"], raw["urls"])
        resumed = self.uploader()
        self.assertTrue(resumed._album_cleanup_suspended)
        self.assertFalse(resumed._album_protection_failed)

    def test_legacy_protection_without_suspension_marker_remains_compatible(self):
        self.protection_path.parent.mkdir(parents=True)
        self.protection_path.write_text(json.dumps({
            "urls": ["https://img.example.com/legacy.jpg"]
        }), encoding="utf-8")
        uploader = self.uploader()
        self.assertFalse(uploader._album_cleanup_suspended)
        self.assertEqual({"https://img.example.com/legacy.jpg"}, uploader._album_protected_urls)

    def test_invalid_suspension_marker_cannot_enable_cleanup(self):
        self.protection_path.parent.mkdir(parents=True)
        for value in ("false", "true", 0, 1, None, [], {}):
            with self.subTest(value=value):
                self.protection_path.write_text(json.dumps({
                    "urls": [], "cleanup_suspended": value,
                }), encoding="utf-8")
                with self.assertRaisesRegex(main.AlbumSpaceError, "清理暂停状态格式错误"):
                    self.uploader()

    def test_capacity_call_disables_cleanup_only_for_suspended_batch(self):
        uploader = self.uploader()
        job = self.job()
        reserve = job.images[0].stat().st_size / MIB + 10
        with patch("album_cleanup.AlbumCleaner") as cleaner:
            uploader._ensure_album_space(job)
            cleaner.return_value.ensure_space.assert_called_once_with(reserve_mb=reserve)
            cleaner.reset_mock()
            uploader._album_cleanup_suspended = True
            uploader._ensure_album_space(job)
            cleaner.return_value.ensure_space.assert_called_once_with(
                reserve_mb=reserve, allow_cleanup=False)
        self.assertEqual(2, uploader.page.context.new_page.return_value.close.call_count)

    def test_new_uuid_inherits_suspended_upload_urls_and_keeps_cleanup_disabled(self):
        previous = self.uploader()
        unknown_upload = "https://img.example.com/previous-partial-upload.jpg"
        previous._album_protected_urls.add(unknown_upload)
        previous._album_cleanup_suspended = True
        previous._protect_album_page_images()

        # An empty ID starts a fresh UUID just as a new batch launch does.
        current = self.uploader(batch_id="")
        self.assertNotEqual(self.BATCH_ID, current.config.album_cleanup_batch_id)
        self.assertTrue(current._album_cleanup_suspended)
        self.assertFalse(current._album_protection_failed)
        self.assertIn(unknown_upload, current._album_protected_urls)
        job = self.job()
        with patch("album_cleanup.AlbumCleaner") as cleaner:
            current._ensure_album_space(job)
        cleaner.return_value.ensure_space.assert_called_once_with(
            reserve_mb=job.images[0].stat().st_size / MIB + 10, allow_cleanup=False)
        current._protect_album_page_images()
        current_path = current._album_audit_directory() / "protected.json"
        raw = json.loads(current_path.read_text(encoding="utf-8"))
        self.assertIs(raw["cleanup_suspended"], True)
        self.assertIn(unknown_upload, raw["urls"])

    def test_other_batch_without_suspension_does_not_share_urls_or_disable_cleanup(self):
        self.protection_path.parent.mkdir(parents=True)
        previous_url = "https://img.example.com/unrelated-old-batch.jpg"
        for marker in ({"urls": [previous_url]},
                       {"urls": [previous_url], "cleanup_suspended": False}):
            with self.subTest(marker=marker):
                self.protection_path.write_text(json.dumps(marker), encoding="utf-8")
                current = self.uploader(batch_id="e" * 32)
                self.assertFalse(current._album_cleanup_suspended)
                self.assertFalse(current._album_protection_failed)
                self.assertNotIn(previous_url, current._album_protected_urls)
                job = self.job()
                with patch("album_cleanup.AlbumCleaner") as cleaner:
                    current._ensure_album_space(job)
                cleaner.return_value.ensure_space.assert_called_once_with(
                    reserve_mb=job.images[0].stat().st_size / MIB + 10)

    def test_unreadable_external_registry_suspends_deletion_without_hard_blocking(self):
        external = self.root / "logs" / "album-cleanup" / ("e" * 32) / "protected.json"
        external.parent.mkdir(parents=True)
        cases = ("broken JSON", "[]", '{"urls":[],"cleanup_suspended":0}',
                 '{"urls":null,"cleanup_suspended":true}',
                 '{"urls":["/relative.jpg"],"cleanup_suspended":true}')
        for raw in cases:
            with self.subTest(raw=raw):
                external.write_text(raw, encoding="utf-8")
                current = self.uploader()
                self.assertTrue(current._album_cleanup_suspended)
                self.assertFalse(current._album_protection_failed)
                job = self.job()
                with patch("album_cleanup.AlbumCleaner") as cleaner:
                    current._ensure_album_space(job)
                cleaner.return_value.ensure_space.assert_called_once_with(
                    reserve_mb=job.images[0].stat().st_size / MIB + 10,
                    allow_cleanup=False)

    def test_protection_write_failure_still_blocks_later_capacity_and_upload(self):
        uploader = self.uploader()
        job = self.job()
        with patch.object(Path, "write_text", side_effect=OSError("磁盘已满")):
            uploader._protect_album_page_images(strict=False)
        self.assertTrue(uploader._album_protection_failed)
        with patch("album_cleanup.AlbumCleaner") as cleaner, \
                self.assertRaisesRegex(main.AlbumSpaceError, "保护记录不完整"):
            uploader._ensure_album_space(job)
        cleaner.assert_not_called()
        uploader.page.context.new_page.assert_not_called()

    def test_closed_product_page_remains_a_hard_protection_failure(self):
        uploader = self.uploader()
        job = self.job()
        uploader.page.is_closed.return_value = True
        with self.assertRaisesRegex(main.AlbumSpaceError, "商品页面已关闭"):
            uploader._protect_album_page_images()
        self.assertTrue(uploader._album_protection_failed)
        with patch("album_cleanup.AlbumCleaner") as cleaner, \
                self.assertRaisesRegex(main.AlbumSpaceError, "保护记录不完整"):
            uploader._ensure_album_space(job)
        cleaner.assert_not_called()
        uploader.page.context.new_page.assert_not_called()

    def run_with_fake_album(self, fail_then_low_space=False):
        uploader = self.uploader()
        jobs = [self.job(f"Product {number}") for number in range(3)]
        api = FakeAlbumApi(count=20, free_mb=500)
        album_page = SimpleNamespace(url=ALBUM_URL,
                                     context=SimpleNamespace(request=api), close=Mock())
        uploader.page.context.new_page.return_value = album_page
        context = MagicMock()
        context.pages = [uploader.page]
        runtime = MagicMock()
        runtime.__enter__.return_value.chromium.launch_persistent_context.return_value = context
        uploader._open_template = Mock()
        uploader._publish_now = Mock()
        evidence = self.root / "evidence"
        evidence.mkdir()
        uploader._capture_failure = Mock(return_value=evidence)

        def populate(job):
            if job is jobs[0]:
                if fail_then_low_space:
                    api.used = api.capacity - MIB
                raise RuntimeError("颜色图缩略图未能加载")

        uploader._populate_job_fields = Mock(side_effect=populate)
        with patch("playwright.sync_api.sync_playwright", return_value=runtime), \
                patch.object(main, "find_browser", return_value="offline browser fixture"):
            report = uploader.run(jobs, strict_completion=True)
        return uploader, jobs, api, report

    def test_one_upload_failure_does_not_stop_later_jobs_with_sufficient_space(self):
        uploader, jobs, api, report = self.run_with_fake_album()
        self.assertEqual((3, 2, 1, 0), (
            report.attempted, report.succeeded, len(report.failures), report.pending_count))
        self.assertEqual("", report.blocked_reason)
        self.assertEqual(3, uploader._populate_job_fields.call_count)
        self.assertEqual(2, uploader._publish_now.call_count)
        self.assertTrue(uploader._album_cleanup_suspended)
        self.assertFalse(uploader._album_protection_failed)
        self.assertEqual([], api.post_calls)
        self.assertEqual(["/api/album/index.json"] * 3, [path for path, _ in api.get_calls])
        completed = main.StateStore(self.root / "state.json")
        self.assertFalse(completed.is_completed(jobs[0], strict=True))
        self.assertTrue(completed.is_completed(jobs[1], strict=True))
        self.assertTrue(completed.is_completed(jobs[2], strict=True))
        failures = FailureStore(self.root / "failure-records").load()
        self.assertEqual([(jobs[0].title, "failed")], [(r.title, r.status) for r in failures])
        self.assertIs(json.loads(self.protection_path.read_text(encoding="utf-8"))["cleanup_suspended"], True)

    def test_suspended_batch_stops_when_space_is_low_without_attempting_deletion(self):
        uploader, jobs, api, report = self.run_with_fake_album(fail_then_low_space=True)
        self.assertEqual((1, 0, 1, 2), (
            report.attempted, report.succeeded, len(report.failures), report.pending_count))
        self.assertEqual("album", report.blocked_category)
        self.assertTrue(report.blocked_reason)
        self.assertEqual(1, uploader._populate_job_fields.call_count)
        uploader._publish_now.assert_not_called()
        self.assertEqual([], api.post_calls)
        self.assertEqual(["/api/album/index.json"] * 2, [path for path, _ in api.get_calls])
        completed = main.StateStore(self.root / "state.json")
        self.assertTrue(all(not completed.is_completed(job, strict=True) for job in jobs))


if __name__ == "__main__":
    unittest.main()
