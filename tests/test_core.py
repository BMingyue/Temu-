import tempfile
import threading
import unittest
from pathlib import Path

from main import (
    AppConfig,
    DxmUploader,
    JobFailure,
    ProductJob,
    RunReport,
    StateStore,
    apply_product_image_order,
    classify_publish_feedback,
    compose_upload_images,
    count_square_dimensions,
    extended_windows_path,
    image_dimensions,
    is_batch_submission_mode,
    is_blocking_scan_warning,
    merge_recovery_report,
    natural_key,
    prepare_carousel_jpg,
    sanitize_temu_title,
    scan_product_folders,
    should_offer_retry,
    summarize_scan,
    _parallel_page_marker,
)


class ScannerTests(unittest.TestCase):
    def test_sanitizes_title_and_keeps_common_listing_punctuation(self):
        raw = "Mother's Day, Cozy-Warm & Soft_Blanket™_d3e5bc1b"
        self.assertEqual(
            sanitize_temu_title(raw),
            "Mother's Day, Cozy-Warm & Soft Blanket",
        )

    def test_sanitized_title_never_splits_last_word_at_limit(self):
        title = sanitize_temu_title("Word " * 80, max_length=25)
        self.assertLessEqual(len(title), 25)
        self.assertRegex(title, r"^[A-Za-z0-9 .,'&()\-]+$")
        self.assertFalse(title.endswith(" "))

    def test_normalizes_curly_punctuation_without_removing_it(self):
        raw = "Women's—Winter， Warm（Queen’s Size）"
        self.assertEqual(
            sanitize_temu_title(raw),
            "Women's-Winter, Warm(Queen's Size)",
        )

    def test_sanitized_title_rejects_symbols_only(self):
        with self.assertRaises(ValueError):
            sanitize_temu_title("™©—___")

    def test_natural_order(self):
        self.assertEqual(sorted(["10.jpg", "2.jpg", "1.jpg"], key=natural_key), ["1.jpg", "2.jpg", "10.jpg"])

    def test_natural_order_accepts_mixed_numeric_and_named_files(self):
        names = ["尺寸图.jpg", "10.jpg", "主图.jpg", "2.jpg"]
        ordered = sorted(names, key=natural_key)
        self.assertEqual(ordered[:2], ["2.jpg", "10.jpg"])
        self.assertCountEqual(ordered[2:], ["尺寸图.jpg", "主图.jpg"])

    def test_counts_resized_carousel_dimension_labels(self):
        text = "1200 X 1200  1200×1200  800 X 800  1200 x 1200"
        self.assertEqual(count_square_dimensions(text), 3)

    def test_extracts_zero_and_ready_image_dimensions(self):
        self.assertEqual(
            image_dimensions("0 X 0  1448 × 1086  1200x1200"),
            [(0, 0), (1448, 1086), (1200, 1200)],
        )

    def test_prepares_square_jpg_without_changing_source(self):
        from PIL import Image

        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "source.png"
            target = root / "staging" / "01.jpg"
            Image.new("RGBA", (200, 100), (20, 40, 60, 255)).save(source)

            prepare_carousel_jpg(source, target)

            with Image.open(source) as original:
                self.assertEqual(original.size, (200, 100))
            with Image.open(target) as prepared:
                self.assertEqual(prepared.format, "JPEG")
                self.assertEqual(prepared.size, (1200, 1200))
                self.assertEqual(prepared.mode, "RGB")
                self.assertGreater(min(prepared.getpixel((10, 10))), 245)
                center = prepared.getpixel((600, 600))
                self.assertLess(center[0], 40)
                self.assertLess(center[1], 60)
                self.assertLess(center[2], 80)

    def test_batch_submission_modes(self):
        self.assertTrue(is_batch_submission_mode("schedule"))
        self.assertTrue(is_batch_submission_mode("publish"))
        self.assertFalse(is_batch_submission_mode("review"))

    def test_scans_folders_and_limits_images(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            product = root / "Test title"
            product.mkdir()
            for name in ["10.jpg", "2.jpg", "1.jpg", "note.txt"]:
                (product / name).write_bytes(b"x")
            config = AppConfig(product_root=str(root), min_images=3, max_images=3)
            jobs, warnings = scan_product_folders(config)
            self.assertEqual(len(jobs), 1)
            self.assertEqual([p.name for p in jobs[0].images], ["1.jpg", "2.jpg", "10.jpg"])
            self.assertEqual(warnings, [])

    def test_product_images_follow_saved_manual_order_and_first_is_main(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            product = root / "Custom order product"
            product.mkdir()
            for name in ["01.jpg", "02.jpg", "03.jpg"]:
                (product / name).write_bytes(b"x")
            config = AppConfig(product_root=str(root))
            config.product_image_orders = {
                str(product.resolve()).casefold(): ["03.jpg", "01.jpg", "02.jpg"]
            }

            jobs, warnings = scan_product_folders(config)

            self.assertEqual(warnings, [])
            self.assertEqual(
                [path.name for path in jobs[0].images],
                ["03.jpg", "01.jpg", "02.jpg"],
            )

    def test_product_order_ignores_deleted_names_and_appends_new_images(self):
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp) / "Product"
            folder.mkdir()
            for name in ["01.jpg", "02.jpg", "04.jpg"]:
                (folder / name).write_bytes(b"x")
            config = AppConfig(
                product_image_orders={
                    str(folder.resolve()).casefold(): [
                        "03-deleted.jpg",
                        "02.jpg",
                        "01.jpg",
                    ]
                }
            )

            ordered = apply_product_image_order(folder, folder.iterdir(), config)

            self.assertEqual(
                [path.name for path in ordered],
                ["02.jpg", "01.jpg", "04.jpg"],
            )

    def test_each_product_keeps_its_own_saved_order(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            first = root / "First product"
            second = root / "Second product"
            first.mkdir()
            second.mkdir()
            for folder in [first, second]:
                for name in ["01.jpg", "02.jpg", "03.jpg"]:
                    (folder / name).write_bytes(b"x")
            config = AppConfig(
                product_root=str(root),
                product_image_orders={
                    str(first.resolve()).casefold(): ["02.jpg", "01.jpg", "03.jpg"],
                    str(second.resolve()).casefold(): ["03.jpg", "02.jpg", "01.jpg"],
                },
            )

            jobs, _warnings = scan_product_folders(config)

            self.assertEqual(
                [[path.name for path in job.images] for job in jobs],
                [
                    ["02.jpg", "01.jpg", "03.jpg"],
                    ["03.jpg", "02.jpg", "01.jpg"],
                ],
            )

    def test_common_detail_images_are_appended_after_all_product_images(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            product = root / "Test product"
            details = root / "shared-details"
            product.mkdir()
            details.mkdir()
            for name in ["01-main.jpg", "02-product.jpg", "03-product.jpg"]:
                (product / name).write_bytes(b"x")
            for name in ["detail-10.jpg", "detail-2.jpg"]:
                (details / name).write_bytes(b"x")

            jobs, warnings = scan_product_folders(
                AppConfig(
                    product_root=str(product),
                    common_detail_images=[
                        str(details / "detail-10.jpg"),
                        str(details / "detail-2.jpg"),
                    ],
                )
            )

            self.assertEqual(len(jobs), 1)
            self.assertEqual(
                [path.name for path in jobs[0].images],
                [
                    "01-main.jpg",
                    "02-product.jpg",
                    "03-product.jpg",
                    "detail-10.jpg",
                    "detail-2.jpg",
                ],
            )
            self.assertEqual(jobs[0].common_detail_count, 2)
            self.assertTrue(any("单商品目录" in item for item in warnings))

    def test_common_detail_images_keep_saved_manual_order(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            product = root / "Manual order product"
            details = root / "details"
            product.mkdir()
            details.mkdir()
            for name in ["01.jpg", "02.jpg", "03.jpg"]:
                (product / name).write_bytes(b"x")
            for name in ["A.jpg", "B.jpg", "C.jpg"]:
                (details / name).write_bytes(b"x")

            jobs, _warnings = scan_product_folders(
                AppConfig(
                    product_root=str(product),
                    common_detail_images=[
                        str(details / "C.jpg"),
                        str(details / "A.jpg"),
                        str(details / "B.jpg"),
                    ],
                )
            )

            self.assertEqual(
                [path.name for path in jobs[0].images[-3:]],
                ["C.jpg", "A.jpg", "B.jpg"],
            )

    def test_common_details_take_priority_over_trailing_product_images_at_limit(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            product = root / "Limited product"
            details = root / "details"
            product.mkdir()
            details.mkdir()
            for index in range(1, 7):
                (product / f"{index:02d}.jpg").write_bytes(b"x")
            for index in range(1, 3):
                (details / f"detail-{index:02d}.jpg").write_bytes(b"x")

            jobs, warnings = scan_product_folders(
                AppConfig(
                    product_root=str(product),
                    max_images=5,
                    common_detail_images=[str(path) for path in details.iterdir()],
                )
            )

            self.assertEqual(
                [path.name for path in jobs[0].images],
                ["01.jpg", "02.jpg", "03.jpg", "detail-01.jpg", "detail-02.jpg"],
            )
            self.assertEqual(jobs[0].common_detail_count, 2)
            self.assertTrue(any("保留主图和全部通用细节图" in item for item in warnings))

    def test_compose_upload_images_moves_selected_duplicate_to_detail_group(self):
        main = Path("main.jpg")
        duplicate_detail = Path("detail.jpg")
        self.assertEqual(
            compose_upload_images(
                [main, duplicate_detail, Path("product-2.jpg")],
                [duplicate_detail, duplicate_detail],
            ),
            [main, Path("product-2.jpg"), duplicate_detail],
        )

    def test_missing_common_detail_image_blocks_scan(self):
        with tempfile.TemporaryDirectory() as temp:
            product = Path(temp) / "Product"
            product.mkdir()
            for name in ["01.jpg", "02.jpg", "03.jpg"]:
                (product / name).write_bytes(b"x")

            with self.assertRaisesRegex(ValueError, "已不存在"):
                scan_product_folders(
                    AppConfig(
                        product_root=str(product),
                        common_detail_images=[str(Path(temp) / "missing.jpg")],
                    )
                )

    def test_common_detail_folder_inside_batch_root_is_not_treated_as_product(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            product = root / "Real product"
            details = root / "通用细节图"
            product.mkdir()
            details.mkdir()
            for name in ["01.jpg", "02.jpg", "03.jpg"]:
                (product / name).write_bytes(b"x")
            for name in ["detail-01.jpg", "detail-02.jpg"]:
                (details / name).write_bytes(b"x")

            jobs, warnings = scan_product_folders(
                AppConfig(
                    product_root=str(root),
                    common_detail_images=[str(path) for path in details.iterdir()],
                )
            )

            self.assertEqual([job.title for job in jobs], ["Real product"])
            self.assertEqual(jobs[0].common_detail_count, 2)
            self.assertTrue(any("仅存放所选通用细节图" in item for item in warnings))

    def test_accepts_one_image_even_with_legacy_minimum(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            product = root / "Short"
            product.mkdir()
            (product / "1.jpg").write_bytes(b"x")
            config = AppConfig(product_root=str(root), min_images=3)
            jobs, warnings = scan_product_folders(config)
            self.assertEqual(len(jobs), 1)
            self.assertEqual(len(jobs[0].images), 1)
            self.assertFalse(any(is_blocking_scan_warning(item) for item in warnings))

    def test_scan_summary_counts_blocked_folder_separately(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            valid = root / "Valid Product"
            incomplete = root / "Incomplete Product"
            valid.mkdir()
            incomplete.mkdir()
            for name in ["01.jpg", "02.jpg", "03.jpg"]:
                (valid / name).write_bytes(b"x")

            jobs, warnings = scan_product_folders(AppConfig(product_root=str(root)))
            self.assertEqual(summarize_scan(jobs, warnings), (2, 1, 1))
            blocked = [item for item in warnings if is_blocking_scan_warning(item)]
            self.assertEqual(len(blocked), 1)
            self.assertIn("Incomplete Product", blocked[0])
            self.assertIn("空文件夹", blocked[0])

    def test_accepts_single_product_folder(self):
        with tempfile.TemporaryDirectory() as temp:
            product = Path(temp) / "Single product title"
            product.mkdir()
            for name in ["主图_02.jpg", "主图_03.jpg", "详情_01.jpg"]:
                (product / name).write_bytes(b"x")
            config = AppConfig(product_root=str(product), min_images=3)
            jobs, warnings = scan_product_folders(config)
            self.assertEqual(len(jobs), 1)
            self.assertEqual(jobs[0].title, "Single product title")
            self.assertTrue(any("单商品目录" in item for item in warnings))

    def test_prefers_product_subfolders_when_batch_root_also_has_loose_images(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for name in ["download-01.jpg", "download-02.jpg"]:
                (root / name).write_bytes(b"x")
            for title in ["Quilted Travel Bag A", "Quilted Travel Bag B"]:
                product = root / title
                product.mkdir()
                for name in ["01.jpg", "02.jpg", "03.jpg"]:
                    (product / name).write_bytes(b"x")

            jobs, warnings = scan_product_folders(
                AppConfig(product_root=str(root), min_images=3)
            )

            self.assertEqual([job.title for job in jobs], [
                "Quilted Travel Bag A",
                "Quilted Travel Bag B",
            ])
            self.assertTrue(any("已忽略总目录根部的 2 张散图" in item for item in warnings))
            self.assertFalse(any("单商品目录" in item for item in warnings))

    def test_detects_product_folder_when_full_path_exceeds_260_characters(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            title = "Long product title " + ("x" * 205)
            product = root / title
            readable_product = extended_windows_path(product)
            readable_product.mkdir()
            try:
                for name in ["01.jpg", "02.jpg", "03.jpg"]:
                    (readable_product / name).write_bytes(b"x")

                jobs, warnings = scan_product_folders(AppConfig(product_root=str(root), min_images=3))

                self.assertEqual(len(jobs), 1)
                self.assertEqual(jobs[0].title, title)
                self.assertEqual(warnings, [])
            finally:
                for path in readable_product.iterdir():
                    path.unlink()
                readable_product.rmdir()


class PublishFeedbackTests(unittest.TestCase):
    def test_recognizes_transient_success_messages(self):
        status, detail = classify_publish_feedback(
            ["产品已提交发布，请在『发布中』、『发布失败』或『在线产品』中查看！"]
        )
        self.assertEqual("success", status)
        self.assertIn("已提交发布", detail)

    def test_recognizes_validation_errors(self):
        status, detail = classify_publish_feedback(["产品标题不能为空，请填写后重试"])
        self.assertEqual("error", status)
        self.assertIn("不能为空", detail)

    def test_ignores_confirmation_copy(self):
        status, _ = classify_publish_feedback(["是否确认立即发布该商品？"])
        self.assertEqual("pending", status)

    def test_recognizes_scheduled_submission(self):
        status, detail = classify_publish_feedback(
            ["产品已移入定时发布，请在『定时发布』中查看！"]
        )
        self.assertEqual("success", status)
        self.assertIn("已移入定时发布", detail)

    def test_recognizes_image_dimension_error(self):
        status, detail = classify_publish_feedback(["错误：产品轮播图尺寸不能小于800*800"])
        self.assertEqual("error", status)
        self.assertIn("不能小于", detail)


class RetryPolicyTests(unittest.TestCase):
    def test_only_first_failure_can_be_retried(self):
        self.assertTrue(should_offer_retry(1))
        self.assertFalse(should_offer_retry(2))
        self.assertFalse(should_offer_retry(3))

    def test_noninteractive_run_defaults_to_one_retry(self):
        messages = []
        uploader = DxmUploader(AppConfig(), messages.append, threading.Event())
        job = ProductJob(Path("product"), "Safe Product Title", [])
        self.assertTrue(uploader._should_retry_job(job, RuntimeError("first"), 1))
        self.assertFalse(uploader._should_retry_job(job, RuntimeError("second"), 2))
        self.assertTrue(any("自动重试一次" in message for message in messages))

    def test_user_can_decline_first_retry(self):
        uploader = DxmUploader(
            AppConfig(),
            lambda _: None,
            threading.Event(),
            retry_decider=lambda job, reason, timeout: False,
        )
        job = ProductJob(Path("product"), "Safe Product Title", [])
        self.assertFalse(uploader._should_retry_job(job, RuntimeError("first"), 1))

    def test_failed_batch_recovery_allows_only_one_attempt(self):
        uploader = DxmUploader(
            AppConfig(),
            lambda _: None,
            threading.Event(),
            max_job_attempts=1,
        )
        job = ProductJob(Path("product"), "Safe Product Title", [])
        self.assertFalse(uploader._should_retry_job(job, RuntimeError("recovery"), 1))

    def test_driver_disconnect_is_escalated_to_page_supervisor(self):
        self.assertTrue(
            DxmUploader._is_driver_disconnect(
                RuntimeError("Page.goto: Connection closed while reading from the driver")
            )
        )
        self.assertFalse(
            DxmUploader._is_driver_disconnect(RuntimeError("图片尺寸校验失败"))
        )


class ParallelPageTests(unittest.TestCase):
    def test_three_worker_page_markers_are_stable_and_distinct(self):
        markers = [_parallel_page_marker(slot) for slot in (1, 2, 3)]
        self.assertEqual(markers, [
            "dxm-parallel-page-1",
            "dxm-parallel-page-2",
            "dxm-parallel-page-3",
        ])
        self.assertEqual(len(set(markers)), 3)


class StateStoreTests(unittest.TestCase):
    def test_concurrent_completion_writes_do_not_overwrite_each_other(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "state.json"
            store = StateStore(path)
            jobs = [
                ProductJob(Path(temp) / f"Product {index}", f"Product {index}", [])
                for index in range(12)
            ]
            threads = [
                threading.Thread(
                    target=store.mark_completed,
                    args=(job, "published"),
                )
                for job in jobs
            ]

            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join()

            reloaded = StateStore(path)
            self.assertEqual(len(reloaded.data["completed"]), len(jobs))
            self.assertTrue(all(reloaded.is_completed(job) for job in jobs))

    def test_completed_title_survives_root_move_and_old_truncation(self):
        common = "Cartoon Pattern Flannel Blanket With Long Product Description " * 3
        old_title = common[:120] + "_a1b2c3d4"
        new_title = common + "Additional words from the new collector"
        with tempfile.TemporaryDirectory() as temp:
            state = StateStore(Path(temp) / "state.json")
            state.data = {
                "completed": {
                    "C:/old/path": {
                        "title": old_title,
                        "listing_title": sanitize_temu_title(old_title),
                        "title_rule_version": 2,
                    }
                }
            }
            job = ProductJob(Path(temp) / "new", new_title, [])
            self.assertTrue(state.is_completed(job))

    def test_old_raw_title_completion_is_retried_after_title_rule_upgrade(self):
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp) / "Mothers Day, Cozy-Warm Blanket_d3e5bc1b"
            state = StateStore(Path(temp) / "state.json")
            state.data = {
                "completed": {
                    str(folder.resolve()): {
                        "title": folder.name,
                        "status": "published",
                    }
                }
            }
            self.assertFalse(state.is_completed(ProductJob(folder, folder.name, [])))


class RunReportTests(unittest.TestCase):
    def test_report_contains_skipped_job_reason(self):
        report = RunReport(
            attempted=2,
            succeeded=1,
            failures=[JobFailure("Problem title", "validation failed", Path("logs/problem"))],
        )
        text = report.render()
        self.assertIn("成功完成：1", text)
        self.assertIn("遇到问题并跳过：1", text)
        self.assertIn("Problem title", text)
        self.assertIn("validation failed", text)

    def test_recovery_report_keeps_only_still_failed_jobs(self):
        initial = RunReport(
            attempted=4,
            succeeded=2,
            failures=[
                JobFailure("A", "first", Path("logs/a"), Path("products/a")),
                JobFailure("B", "first", Path("logs/b"), Path("products/b")),
            ],
        )
        recovery = RunReport(
            attempted=2,
            succeeded=1,
            failures=[JobFailure("B", "again", Path("logs/b2"), Path("products/b"))],
        )
        final = merge_recovery_report(initial, recovery)
        self.assertEqual(4, final.attempted)
        self.assertEqual(3, final.succeeded)
        self.assertEqual(["B"], [failure.title for failure in final.failures])


if __name__ == "__main__":
    unittest.main()
