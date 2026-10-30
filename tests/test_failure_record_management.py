import tempfile
import unittest
from pathlib import Path

from failure_records import FailureRecord, FailureStore, record_matches_batch


class FailureRecordManagementTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.batch = self.root / "Selected Batch"
        self.batch.mkdir()
        self.store = FailureStore(self.root / "failure-records")
        self.url = "https://www.dianxiaomi.com/web/popTemu/quoteEdit?id=220114595107558624"

    def record(self, folder=None, **kwargs):
        return FailureRecord(
            title="A sweater", reason="upload failed",
            product_folder=str(folder or self.batch / "A sweater"),
            evidence_dir=str(self.root / "evidence"), updated_at="2020-01-01T00:00:00",
            listing_profile=kwargs.pop("listing_profile", "tshirt"),
            template_url=kwargs.pop("template_url", self.url),
            article_name=kwargs.pop("article_name", "my"), **kwargs)

    def matches(self, record, **kwargs):
        settings = dict(product_root=self.batch, listing_profile="tshirt",
                        template_url=self.url, article_name="my")
        settings.update(kwargs)
        return record_matches_batch(record, **settings)

    def test_scope_includes_root_and_descendants_but_not_similar_siblings(self):
        self.assertTrue(self.matches(self.record(self.batch)))
        self.assertTrue(self.matches(self.record(self.batch / "Nested" / "Product")))
        self.assertFalse(self.matches(self.record(self.root / "Selected Batch Other" / "Product")))
        self.assertFalse(self.matches(self.record(self.root / "Other Batch" / "Product")))

    def test_scope_normalizes_case_and_parent_components(self):
        self.assertTrue(self.matches(self.record(self.batch / "Sub" / ".." / "Product")))
        self.assertTrue(self.matches(self.record(), product_root=str(self.batch).swapcase()))

    def test_scope_requires_known_path_root_script_and_tshirt_article_name(self):
        unknown = self.record()
        unknown.product_folder = ""
        self.assertFalse(self.matches(unknown))
        self.assertFalse(self.matches(self.record(), product_root=""))
        self.assertFalse(self.matches(self.record(listing_profile="blanket")))
        self.assertFalse(self.matches(self.record(article_name="another")))
        self.assertTrue(self.matches(self.record(article_name=" my ")))
        # Blanket mode does not use an article name.
        self.assertTrue(self.matches(self.record(listing_profile="blanket", article_name=""),
                                     listing_profile="blanket", article_name="unused"))

    def test_template_matches_exact_validated_id_and_ignores_edit_path_and_parameters(self):
        edited = self.url.replace("quoteEdit", "edit") + "&tracking=old"
        self.assertTrue(self.matches(self.record(template_url=edited)))
        self.assertFalse(self.matches(self.record(template_url=self.url.replace("558624", "558625"))))
        self.assertFalse(self.matches(self.record(template_url=self.url.replace("220", "0220", 1))))
        self.assertFalse(self.matches(self.record(), template_url=""))
        self.assertFalse(self.matches(self.record(template_url="https://example.com/web/popTemu/edit?id=1")))
        self.assertFalse(self.matches(self.record(), template_url="invalid"))

    def test_legacy_template_is_scoped_by_root_and_does_not_require_existing_folder(self):
        self.assertTrue(self.matches(self.record(template_url="")))
        self.assertFalse(self.matches(self.record(self.root / "Other" / "Product", template_url="")))

    def test_dismiss_only_selected_failures_and_preserve_all_local_assets(self):
        first = self.record()
        second = self.record(self.batch / "Second")
        resolved = self.record(self.batch / "Resolved", status="resolved")
        for record in (first, second, resolved):
            self.store._save(record)
        source = self.batch / "source.jpg"
        source.write_bytes(b"source image")
        evidence = self.root / "evidence"
        evidence.mkdir()
        (evidence / "error.txt").write_text("evidence", encoding="utf-8")
        state = self.root / "state.json"
        state.write_bytes(b'{"completed":{}}')
        before = {p: p.read_bytes() for p in (source, evidence / "error.txt", state)}
        self.assertEqual(1, self.store.dismiss([first.key, resolved.key, "unknown"]))
        records = {record.key: record for record in self.store.load()}
        self.assertEqual(3, len(records))
        self.assertEqual("dismissed", records[first.key].status)
        self.assertNotEqual(first.updated_at, records[first.key].updated_at)
        self.assertEqual("failed", records[second.key].status)
        self.assertEqual("resolved", records[resolved.key].status)
        self.assertEqual(0, self.store.dismiss([first.key]))
        self.assertTrue(all(path.read_bytes() == data for path, data in before.items()))
        self.assertEqual(3, len(list(self.store.directory.glob("*.json"))))

    def test_dismissed_record_is_not_revived_by_legacy_import_but_new_failure_is_saved(self):
        folder = self.batch / "A sweater"
        folder.mkdir()
        record = self.record(folder)
        self.store._save(record)
        self.store.dismiss([record.key])
        logs = self.root / "logs"
        logs.mkdir()
        report = logs / "run-summary-20261030-051506.txt"
        report.write_text(
            f"问题明细：\n1. {folder.name}\n   原因：old timeout\n"
            f"   商品文件夹：{folder}\n   现场：{self.root / 'evidence'}\n",
            encoding="utf-8")
        self.assertEqual(0, self.store.import_latest_legacy_report(logs, self.batch))
        self.assertEqual("dismissed", self.store.load()[0].status)
        self.store.record(folder.name, "new failure", folder, self.root / "new evidence")
        self.assertEqual("failed", self.store.load()[0].status)
        self.assertEqual("new failure", self.store.load()[0].reason)


if __name__ == "__main__":
    unittest.main()
