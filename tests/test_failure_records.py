import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

import main
from failure_records import FailureStore, needs_submission_review
from main import AppConfig, JobFailure, ProductJob, StateStore, UploaderApp, prepare_failed_retries


class FailureRecordTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.store = FailureStore(self.root / "records")
        self.state = StateStore(self.root / "state.json")
        self.config = AppConfig(product_root=str(self.root), concurrent_pages=3)

    def product(self, name="Cozy Blanket", count=3):
        folder = self.root / name
        folder.mkdir()
        for n in range(count):
            (folder / f"{n + 1}.jpg").write_bytes(b"image")
        return folder

    def fail(self, folder, reason="轮播图上传等待超时"):
        self.store.record(folder.name, reason, folder, self.root / "evidence", "schedule")

    def test_persist_update_and_resolve_only_target_folder(self):
        a, b = self.product("Whale Blanket"), self.product("Goose Blanket")
        self.fail(a)
        self.fail(b)
        self.fail(a, "图片尺寸错误")
        reloaded = FailureStore(self.store.directory)
        self.assertEqual(2, len(reloaded.load()))
        self.assertEqual("图片尺寸错误", next(r.reason for r in reloaded.load() if r.title == a.name))
        reloaded.resolve(a)
        self.assertEqual([b.name], [r.title for r in reloaded.load() if r.status == "failed"])
        self.assertEqual(2, len(reloaded.load()))

    def test_retry_only_failed_and_recheck_completion_and_current_image_order(self):
        a, b = self.product("Failed Blanket"), self.product("Completed Blanket")
        self.fail(a)
        self.fail(b)
        # A successful later run must remain protected even if the old failure file remains.
        self.state.mark_completed(ProductJob(b, b.name, []), "published")
        common = self.root / "common.jpg"
        common.write_bytes(b"image")
        self.config.common_detail_images = [str(common)]
        self.config.product_image_orders = {main._path_identity(a): ["3.jpg", "1.jpg", "2.jpg"]}
        jobs, skipped = prepare_failed_retries(self.store.load(), self.config, self.state)
        self.assertEqual([a], [job.folder for job in jobs])
        self.assertEqual(["3.jpg", "1.jpg", "2.jpg", "common.jpg"], [p.name for p in jobs[0].images])
        self.assertEqual(1, len(skipped))

    def test_similar_long_titles_do_not_hide_a_different_failed_print(self):
        prefix = "Flannel Blanket Clearance Sale Multipurpose Cozy Soft Autumn Winter " * 2
        a = self.product(prefix + "Whale")
        b = self.product(prefix + "Goose")
        self.state.mark_completed(ProductJob(a, a.name, []), "published")
        self.fail(b)
        self.assertTrue(self.state.is_completed(ProductJob(b, b.name, [])))  # Legacy prefix rule.
        self.assertFalse(self.state.is_completed(ProductJob(b, b.name, []), strict=True))
        jobs, _ = prepare_failed_retries(self.store.load(), self.config, self.state)
        self.assertEqual([b], [job.folder for job in jobs])

    def test_missing_invalid_and_uncertain_records_remain_saved(self):
        missing = self.root / "Gone Blanket"
        self.fail(missing)
        invalid = self.product("Empty Product", count=0)
        self.fail(invalid)
        uncertain = self.product("Unconfirmed Product")
        self.fail(uncertain, "提交定时发布后，平台未返回可确认的结果")
        jobs, skipped = prepare_failed_retries(self.store.load(), self.config, self.state)
        self.assertEqual([], jobs)
        self.assertEqual(3, len(skipped))
        self.assertEqual(3, len(self.store.load()))
        self.assertTrue(needs_submission_review("点击立即发布后浏览器页面被关闭，无法确认发布结果。"))
        self.assertFalse(needs_submission_review("平台返回发布校验错误：产品标题不能为空"))

    def test_imports_latest_report_once_and_only_exact_existing_folder(self):
        folder = self.product("Whale Blanket")
        logs = self.root / "logs"
        logs.mkdir()
        report = logs / "run-summary-final-20261019-004734.txt"
        report.write_text(
            "本次运行结束\n遇到问题并跳过：2\n\n问题明细：\n"
            f"1. {folder.name}\n   原因：超时\n   现场：{logs / 'a'}\n"
            f"2. Whale Blanket Unknown\n   原因：上传失败\n   现场：{logs / 'b'}\n\n"
            f"完整汇总：{report}\n", encoding="utf-8")
        self.assertEqual(2, self.store.import_latest_legacy_report(logs, self.root))
        records = {r.title: r for r in self.store.load()}
        self.assertEqual(str(folder.resolve()), records[folder.name].product_folder)
        self.assertEqual("", records["Whale Blanket Unknown"].product_folder)
        self.assertEqual(0, self.store.import_latest_legacy_report(logs, self.root))
        self.store.resolve(folder)
        self.store.import_latest_legacy_report(logs, self.root)
        self.assertEqual("resolved", next(r.status for r in self.store.load() if r.title == folder.name))

    def test_malformed_record_is_reported_instead_of_hidden(self):
        self.store.directory.mkdir()
        (self.store.directory / "broken.json").write_text("{", encoding="utf-8")
        with self.assertRaises(json.JSONDecodeError):
            self.store.load()

    def test_final_failure_is_saved_before_worker_finishes_and_review_does_not_resolve(self):
        folder = self.product()
        uploader = main.DxmUploader(self.config, lambda _: None, threading.Event())
        with patch.object(main, "FAILURE_DIR", self.store.directory):
            uploader._remember_failure(JobFailure(folder.name, "upload failed", self.root / "evidence", folder))
            self.assertEqual(1, len(self.store.load()))
            uploader.config = AppConfig(publish_mode="review")
            uploader._resolve_failure(ProductJob(folder, folder.name, []))
            self.assertEqual("failed", self.store.load()[0].status)
            uploader.config.publish_mode = "publish"
            uploader._resolve_failure(ProductJob(folder, folder.name, []))
            self.assertEqual("resolved", self.store.load()[0].status)


class FailureDialogTests(unittest.TestCase):
    def test_window_paths_copy_and_retry_launch_without_publishing(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            folder = root / "Whale Blanket"
            folder.mkdir()
            for n in range(3):
                (folder / f"{n}.jpg").write_bytes(b"image")
            store = FailureStore(root / "records")
            store.record(folder.name, "上传失败", folder, root, "publish")
            config = AppConfig(product_root=str(root), publish_mode="publish", concurrent_pages=3,
                               template_url="https://www.dianxiaomi.com/web/popTemu/edit?id=1")
            with patch.object(main, "FAILURE_DIR", store.directory), \
                 patch.object(main, "CONFIG_PATH", root / "config.json"), \
                 patch.object(main, "LOG_DIR", root / "logs"), \
                 patch.object(main, "STATE_PATH", root / "state.json"), \
                 patch.object(AppConfig, "load", return_value=config):
                app = UploaderApp()
                self.addCleanup(app.root.destroy)
                app.root.withdraw()
                app.root.update()
                app._show_failure_records()
                app._failure_dialog.withdraw()
                app.root.update()
                self.assertEqual(1, len(app.failure_tree.get_children()))
                try:
                    original_clipboard = app.root.clipboard_get()
                except main.tk.TclError:
                    original_clipboard = None
                app._copy_failure_folder()
                self.assertEqual(str(folder.resolve()), app.root.clipboard_get())
                if original_clipboard is not None:
                    app.root.clipboard_clear()
                    app.root.clipboard_append(original_clipboard)
                with patch.object(main.os, "startfile") as open_folder:
                    app._open_failure_folder()
                    open_folder.assert_called_once_with(str(folder.resolve()))
                with patch.object(app, "_current_config", return_value=config), \
                     patch.object(app, "_launch_worker") as launch:
                    app._retry_failed_records()
                    jobs, retry_config = launch.call_args.args
                    self.assertEqual([folder], [job.folder for job in jobs])
                    self.assertEqual(1, retry_config.concurrent_pages)
                    self.assertEqual("publish", retry_config.publish_mode)
                    self.assertEqual(1, launch.call_args.kwargs["max_job_attempts"])
                    self.assertTrue(launch.call_args.kwargs["recovery"])
                    self.assertEqual(3, config.concurrent_pages)
                # Refreshing an empty list and reopening the dialog must also work.
                store.resolve(folder)
                app._refresh_failure_records()
                self.assertEqual(0, len(app.failure_tree.get_children()))
                app._failure_dialog.destroy()
                app._show_failure_records()
                app._failure_dialog.withdraw()
                app.root.update()


if __name__ == "__main__":
    unittest.main()
