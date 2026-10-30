"""Offline reconciliation and retry-decision regressions; no shop access."""
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import MagicMock, Mock, patch

import main
from failure_records import FailureRecord, FailureStore


class BatchProgressTests(unittest.TestCase):
    def setUp(self):
        scratch = tempfile.TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        self.root = Path(scratch.name)
        self.batch = self.root / "Current Batch"
        self.batch.mkdir()
        self.config = main.AppConfig(
            product_root=str(self.batch), listing_profile="tshirt", article_name="my",
            template_url="https://www.dianxiaomi.com/web/popTemu/quoteEdit?id=123",
        )
        self.state = main.StateStore(self.root / "state.json")

    def job(self, name, parent=None):
        folder = (parent or self.batch) / name
        folder.mkdir(parents=True)
        return main.ProductJob(folder, name, [])

    def record(self, job, **changes):
        values = dict(title=job.title, product_folder=str(job.folder), reason="上传失败",
                      evidence_dir=str(self.root / "evidence"), updated_at="2026-10-30T09:00:00",
                      listing_profile="tshirt", article_name="my", template_url=self.config.template_url)
        values.update(changes)
        return FailureRecord(**values)

    def test_current_failures_pending_and_completion_are_reconciled(self):
        done, failed, waiting = [self.job(name) for name in ("Done", "Failed", "Waiting")]
        other = self.job("Old", self.root / "Other Batch")
        self.state.mark_completed(done, "published")
        current, pending, completed = main.current_batch_progress(
            self.config, [done, failed, waiting],
            [self.record(done), self.record(failed), self.record(other)], self.state)
        self.assertEqual([failed.title], [record.title for record in current])
        self.assertEqual([waiting], pending)
        self.assertEqual(1, completed)

    def test_other_profile_template_article_and_dismissed_records_are_not_current_failures(self):
        jobs = [self.job(name) for name in ("Other Profile", "Other Template", "Other Article", "Dismissed")]
        records = [self.record(jobs[0], listing_profile="blanket"),
                   self.record(jobs[1], template_url="https://www.dianxiaomi.com/web/popTemu/edit?id=456"),
                   self.record(jobs[2], article_name="oldname"),
                   self.record(jobs[3], status="dismissed")]
        current, pending, completed = main.current_batch_progress(self.config, jobs, records, self.state)
        self.assertEqual([], current)
        self.assertEqual(jobs, pending)
        self.assertEqual(0, completed)

    def test_full_identity_keeps_distinct_long_prefix_print_pending(self):
        prefix = "Mock Neck Long Sleeve Sweater Clearance Sale Halloween Holiday Season " * 2
        done = self.job(prefix + "Whale")
        pending_job = self.job(prefix + "Goose")
        self.state.mark_completed(done, "published")
        self.assertTrue(self.state.is_completed(pending_job))
        current, pending, completed = main.current_batch_progress(
            self.config, [done, pending_job], [], self.state)
        self.assertEqual([], current)
        self.assertEqual([pending_job], pending)
        self.assertEqual(1, completed)


class RetryDecisionTests(unittest.TestCase):
    def uploader(self, decider):
        return main.DxmUploader(main.AppConfig(), Mock(), threading.Event(),
                                retry_decider=decider, max_job_attempts=2)

    def test_prompt_result_is_respected(self):
        job = main.ProductJob(Path("unused"), "Unused Product", [])
        for decision in (True, False):
            with self.subTest(decision=decision):
                decider = Mock(return_value=decision)
                uploader = self.uploader(decider)
                self.assertIs(decision, uploader._should_retry_job(job, RuntimeError("upload error"), 1))
                decider.assert_called_once_with(job, "upload error", main.RETRY_PROMPT_TIMEOUT_SECONDS)

    def test_prompt_error_uses_default_single_retry(self):
        uploader = self.uploader(Mock(side_effect=RuntimeError("dialog error")))
        job = main.ProductJob(Path("unused"), "Unused Product", [])
        self.assertTrue(uploader._should_retry_job(job, RuntimeError("upload error"), 1))
        self.assertFalse(uploader._should_retry_job(job, RuntimeError("upload error"), 2))

    def test_uncertain_result_and_shared_block_never_offer_or_auto_retry(self):
        job = main.ProductJob(Path("unused"), "Unused Product", [])
        for decider in (None, Mock(return_value=True)):
            for reason in (RuntimeError("提交结果不明"), main.TemplateValidationError("template error")):
                with self.subTest(decider=decider, reason=reason):
                    uploader = self.uploader(decider)
                    self.assertFalse(uploader._should_retry_job(job, reason, 1))
                    if decider is not None:
                        decider.assert_not_called()

    def test_first_failure_is_persisted_before_prompt_and_retry_success_resolves_it(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            job = main.ProductJob(root / "Product", "Product", [])
            store = FailureStore(root / "failures")

            def decide_retry(prompt_job, reason, timeout):
                records = store.load()
                self.assertEqual(1, len(records))
                self.assertEqual("failed", records[0].status)
                self.assertEqual(str(job.folder.resolve()), records[0].product_folder)
                self.assertIn("first upload error", records[0].reason)
                return True

            uploader = main.DxmUploader(main.AppConfig(publish_mode="publish"), Mock(), threading.Event(),
                                        retry_decider=decide_retry, max_job_attempts=2)
            page = MagicMock()
            page.is_closed.return_value = False
            context = MagicMock()
            context.pages = [page]
            runtime = MagicMock()
            runtime.__enter__.return_value.chromium.launch_persistent_context.return_value = context
            uploader._open_template = Mock()
            uploader._fill_job_fields = Mock(side_effect=[RuntimeError("first upload error"), None])
            uploader._publish_now = Mock()
            uploader._capture_failure = Mock(return_value=root / "evidence")
            with patch.multiple(main, LOG_DIR=root / "logs", PROFILE_DIR=root / "profile",
                                FAILURE_DIR=store.directory, STATE_PATH=root / "state.json"), \
                    patch("playwright.sync_api.sync_playwright", return_value=runtime), \
                    patch.object(main, "find_browser", return_value="offline-browser"):
                report = uploader.run([job])
            self.assertEqual((1, 0), (report.succeeded, len(report.failures)))
            self.assertEqual("resolved", store.load()[0].status)
            self.assertEqual(2, uploader._fill_job_fields.call_count)
            uploader._publish_now.assert_called_once()


if __name__ == "__main__":
    unittest.main()
