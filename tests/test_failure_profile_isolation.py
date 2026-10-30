import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

import main
from failure_records import FailureStore


class FailureProfileIsolationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.batch = self.root / "Selected Batch"
        self.batch.mkdir()
        self.store = FailureStore(self.root / "failure-records")
        self.state = main.StateStore(self.root / "state.json")
        self.url = "https://www.dianxiaomi.com/web/popTemu/quoteEdit?id=220114595107558624"

    def product(self, name, parent=None):
        folder = (parent or self.batch) / name
        folder.mkdir(parents=True)
        (folder / "1.jpg").write_bytes(b"image")
        return folder

    def record(self, folder, profile="blanket", template=None, article=""):
        self.store.record(folder.name, "图片上传失败", folder, self.root / "evidence",
                          "review", listing_profile=profile,
                          template_url=self.url if template is None else template,
                          article_name=article)

    def config(self, profile="blanket", article=""):
        return main.AppConfig(product_root=str(self.batch), template_url=self.url,
                              listing_profile=profile, article_name=article)

    def retry(self, config):
        return main.prepare_failed_retries(self.store.load(), config, self.state)

    def test_mixed_blanket_and_tshirt_records_only_use_selected_script(self):
        blanket = self.product("Blanket Product")
        shirt = self.product("Tshirt Product")
        self.record(blanket)
        self.record(shirt, "tshirt", article="BKShirt")
        jobs, skipped = self.retry(self.config())
        self.assertEqual([blanket], [job.folder for job in jobs])
        self.assertEqual(1, len(skipped))
        self.assertIn("属于T恤脚本", skipped[0])
        jobs, skipped = self.retry(self.config("tshirt", "BKShirt"))
        self.assertEqual([shirt], [job.folder for job in jobs])
        self.assertIn("属于毛毯脚本", skipped[0])
        self.assertEqual(2, len(self.store.load()))
        self.assertTrue(all(record.status == "failed" for record in self.store.load()))

    def test_template_identity_compares_exact_id_and_ignores_edit_path_and_other_parameters(self):
        matching = self.product("Matching Template")
        other = self.product("Other Template")
        self.record(matching, template=self.url.replace("quoteEdit", "edit") + "&tracking=old")
        self.record(other, template=self.url.replace("558624", "558625"))
        jobs, skipped = self.retry(self.config())
        self.assertEqual([matching], [job.folder for job in jobs])
        self.assertEqual(1, len(skipped))
        self.assertIn("模板 ID 与当前模板不同", skipped[0])

    def test_new_template_metadata_can_retry_exact_folder_outside_current_root(self):
        folder = self.product("Known Template", self.root / "Another Batch")
        self.record(folder)
        jobs, skipped = self.retry(self.config())
        self.assertEqual([folder], [job.folder for job in jobs])
        self.assertEqual([], skipped)

    def test_tshirt_article_name_mismatch_is_preserved_and_skipped(self):
        matching = self.product("Matching Shirt")
        other = self.product("Different English Name")
        self.record(matching, "tshirt", article="BKShirt")
        self.record(other, "tshirt", article="Amy")
        jobs, skipped = self.retry(self.config("tshirt", "BKShirt"))
        self.assertEqual([matching], [job.folder for job in jobs])
        self.assertEqual(1, len(skipped))
        self.assertIn("货号英文名与当前不同", skipped[0])
        self.assertEqual(2, len(self.store.load()))

    def test_legacy_defaults_to_blanket_and_is_limited_to_selected_root(self):
        nested = self.product("Old Inside", self.batch / "Nested")
        outside = self.product("Old Outside", self.root / "Different Batch")
        sibling_prefix = self.product("Old Prefix", self.root / "Selected Batch Other")
        for folder in (nested, outside, sibling_prefix):
            self.record(folder, template="")
        # Simulate a pre-upgrade JSON record with none of the new metadata.
        for path in self.store.directory.glob("*.json"):
            raw = json.loads(path.read_text(encoding="utf-8"))
            for key in ("listing_profile", "template_url", "article_name"):
                raw.pop(key)
            path.write_text(json.dumps(raw), encoding="utf-8")
        self.assertTrue(all(record.listing_profile == "blanket" for record in self.store.load()))
        jobs, skipped = self.retry(self.config())
        self.assertEqual([nested], [job.folder for job in jobs])
        self.assertEqual(2, len(skipped))
        self.assertTrue(all("不在当前素材总目录内" in reason for reason in skipped))
        self.assertEqual(3, len(self.store.load()))
        jobs, skipped = self.retry(self.config("tshirt", "BKShirt"))
        self.assertEqual([], jobs)
        self.assertEqual(3, len(skipped))

    def test_legacy_selected_root_itself_can_retry_and_blank_root_cannot(self):
        (self.batch / "1.jpg").write_bytes(b"image")
        self.record(self.batch, template="")
        jobs, skipped = self.retry(self.config())
        self.assertEqual([self.batch], [job.folder for job in jobs])
        self.assertEqual([], skipped)
        config = self.config()
        config.product_root = ""
        jobs, skipped = self.retry(config)
        self.assertEqual([], jobs)
        self.assertIn("请先选择所属素材总目录", skipped[0])

    def test_invalid_record_template_never_silently_uses_current_template(self):
        folder = self.product("Bad Metadata")
        self.record(folder, template="https://example.com/web/popTemu/quoteEdit?id=1")
        jobs, skipped = self.retry(self.config())
        self.assertEqual([], jobs)
        self.assertIn("无法确认同一模板", skipped[0])
        self.assertEqual(1, len(self.store.load()))

    def test_uploader_persists_profile_template_and_article_name_with_failure(self):
        folder = self.product("Failed Tshirt")
        uploader = main.DxmUploader(self.config("tshirt", "BKShirt"), lambda _: None, threading.Event())
        failure = main.JobFailure(folder.name, "图片上传失败", self.root / "evidence", folder)
        with patch.object(main, "FAILURE_DIR", self.store.directory):
            self.assertIs(failure, uploader._remember_failure(failure))
        records = self.store.load()
        self.assertEqual(1, len(records))
        self.assertEqual("tshirt", records[0].listing_profile)
        self.assertEqual(self.url, records[0].template_url)
        self.assertEqual("BKShirt", records[0].article_name)
        self.assertEqual("review", records[0].publish_mode)


if __name__ == "__main__":
    unittest.main()
