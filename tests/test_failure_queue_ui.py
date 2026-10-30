"""Failure/pending UI tests with temporary data and the launch seam mocked."""
import tempfile
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch

import main
import preflight_review
from failure_records import FailureStore


class FailureQueueUITests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.root = Path(self.stack.enter_context(tempfile.TemporaryDirectory()))
        self.batch = self.root / "Current Batch"
        self.batch.mkdir()
        self.done = self.product("Done")
        self.failed = self.product("Failed")
        self.pending = self.product("Pending")
        self.history = self.product("History", self.root / "Other Batch")
        self.config = main.AppConfig(
            product_root=str(self.batch), publish_mode="review", concurrent_pages=3,
            template_url="https://www.dianxiaomi.com/web/popTemu/quoteEdit?id=123")
        self.store = FailureStore(self.root / "failure-records")
        self.record(self.failed)
        self.record(self.history)
        self.state = main.StateStore(self.root / "state.json")
        self.state.mark_completed(main.ProductJob(self.done, self.done.name, []), "published")
        for name, value in (("FAILURE_DIR", self.store.directory),
                            ("CONFIG_PATH", self.root / "config.json"),
                            ("LOG_DIR", self.root / "logs"),
                            ("STATE_PATH", self.state.path)):
            self.stack.enter_context(patch.object(main, name, value))
        self.stack.enter_context(patch.object(main.AppConfig, "load", return_value=self.config))
        self.stack.enter_context(patch("portable_runtime.attach_support_ui"))
        self.dialogs = {name: self.stack.enter_context(patch.object(main.messagebox, name, return_value=True))
                        for name in ("showinfo", "showwarning", "showerror", "askyesno")}
        self.app = main.UploaderApp()
        self.stack.callback(self.destroy_app)
        self.app.root.withdraw()
        self.app.root.update()
        self.app._show_failure_records()
        self.app._failure_dialog.withdraw()
        self.app.root.update()

    def destroy_app(self):
        for callback in self.app.root.tk.call("after", "info"):
            self.app.root.after_cancel(callback)
        self.app.root.destroy()

    def product(self, name, parent=None):
        folder = (parent or self.batch) / name
        folder.mkdir(parents=True)
        (folder / "1.jpg").write_bytes(b"offline image placeholder")
        return folder

    def record(self, folder, reason="上传失败"):
        self.store.record(folder.name, reason, folder, self.root / "evidence", "review",
                          template_url="https://www.dianxiaomi.com/web/popTemu/quoteEdit?id=123")

    def test_default_current_scope_and_history_scope_keep_pending_current(self):
        self.assertEqual([self.failed.name], [record.title for record in self.app._failure_records])
        self.assertEqual([self.pending], [job.folder for job in self.app._pending_jobs])
        self.assertIn("已有完成记录 1", self.app.batch_progress_var.get())
        self.assertIn("其他历史失败 1", self.app.batch_progress_var.get())
        self.app.failure_scope_var.set("全部历史")
        self.app._refresh_failure_records()
        self.assertEqual({self.failed.name, self.history.name}, {record.title for record in self.app._failure_records})
        self.assertEqual([self.pending], [job.folder for job in self.app._pending_jobs])

    def test_dismiss_only_changes_record_and_returns_unfinished_product_to_pending(self):
        record = self.app._failure_records[0]
        self.app.failure_tree.selection_set(record.key)
        self.app._dismiss_failure_records()
        self.assertEqual("dismissed", next(item.status for item in self.store.load() if item.key == record.key))
        self.assertTrue(self.failed.is_dir())
        self.assertTrue((self.store.directory / f"{record.key}.json").is_file())
        self.assertTrue(self.state.is_completed(main.ProductJob(self.done, self.done.name, []), strict=True))
        self.assertEqual({self.failed, self.pending}, {job.folder for job in self.app._pending_jobs})

    def test_continue_reconciles_completion_and_launches_only_pending_without_browser(self):
        with patch.object(self.app, "_launch_worker", return_value=True) as launch:
            self.app._continue_pending_records()
        jobs, config = launch.call_args.args
        self.assertEqual([self.pending], [job.folder for job in jobs])
        self.assertEqual(1, config.concurrent_pages)
        self.assertEqual("", config.album_cleanup_batch_id)
        self.assertEqual("review", config.publish_mode)
        self.assertTrue(launch.call_args.kwargs["recovery"])
        self.assertEqual(1, launch.call_args.kwargs["max_job_attempts"])
        self.assertEqual(3, self.config.concurrent_pages)
        self.assertIsNone(self.app.worker)
        self.state.mark_completed(main.ProductJob(self.pending, self.pending.name, []), "published")
        with patch.object(self.app, "_launch_worker") as launch:
            self.app._continue_pending_records()
        launch.assert_not_called()

    def test_dismissed_uncertain_submission_cannot_be_continued(self):
        self.record(self.pending, "点击立即发布后，无法确认发布结果")
        record = next(record for record in self.store.load() if record.title == self.pending.name)
        self.store.dismiss({record.key})
        with patch.object(self.app, "_launch_worker") as launch:
            self.app._continue_pending_records()
        launch.assert_not_called()
        self.assertTrue(self.dialogs["showinfo"].called)

    def test_scan_exception_clears_stale_pending_and_is_visible(self):
        self.assertTrue(self.app._pending_jobs)
        with patch.object(main, "scan_product_folders", side_effect=RuntimeError("offline scan error")):
            self.app._refresh_failure_records()
        self.assertEqual([], self.app._pending_jobs)
        self.assertIn("offline scan error", self.app.batch_progress_var.get())
        self.assertEqual("disabled", str(self.app.continue_pending_button["state"]))


class PreviewModeUITests(unittest.TestCase):
    def test_mode_and_total_are_explicit_for_list_and_generator_inputs(self):
        root = main.tk.Tk()
        root.withdraw()
        self.addCleanup(root.destroy)
        jobs = [main.ProductJob(Path(f"unused-{index}"), f"Unused {index}", []) for index in range(5)]
        for mode, summary, button in (
                ("publish", "立即发布", "确认排序并立即发布"),
                ("schedule", "明天 09:30", "确认排序并定时发布"),
                ("review", "发布前检查", "确认排序并开始检查")):
            with self.subTest(mode=mode), patch.object(preflight_review.ImageOrderReviewDialog, "show_sample"):
                config = main.AppConfig(publish_mode=mode, schedule_hour=9, schedule_minute=30)
                iterable = iter(jobs) if mode == "publish" else jobs
                dialog = preflight_review.ImageOrderReviewDialog(root, iterable, config)
                try:
                    self.assertIn("本次将处理 5 款商品", dialog.run_mode_summary_var.get())
                    self.assertIn(summary, dialog.run_mode_summary_var.get())
                    self.assertEqual(button, str(dialog.confirm_button["text"]))
                finally:
                    dialog.cancel()


if __name__ == "__main__":
    unittest.main()
