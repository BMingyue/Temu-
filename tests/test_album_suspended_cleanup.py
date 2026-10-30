"""Suspended cleanup permits only capacity reads, never candidate selection."""
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from album_cleanup import ALBUM_URL, AlbumCleaner, AlbumCleanupError, MIB
from tests.test_album_cleanup_adapter import FakeAlbumApi


class AlbumSuspendedCleanupTests(unittest.TestCase):
    def setUp(self):
        scratch = tempfile.TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        self.root = Path(scratch.name)
        self.audit_path = self.root / "cleanup.jsonl"
        self.api = FakeAlbumApi(count=12, free_mb=100)
        self.page = SimpleNamespace(url=ALBUM_URL, context=SimpleNamespace(request=self.api), goto=Mock())
        self.logs = []

    def cleaner(self):
        return AlbumCleaner(self.page, self.logs.append, lambda: False, lambda _: None,
                            threshold_mb=100, protected_urls=set(), audit_path=self.audit_path)

    def test_suspended_cleanup_at_target_only_reads_capacity_without_audit_or_candidates(self):
        cleaner = self.cleaner()
        with patch.object(cleaner, "_tail", side_effect=AssertionError("Cannot select suspended images")), \
                patch.object(cleaner, "_audit", side_effect=AssertionError("Cannot audit suspended deletion")):
            result = cleaner.ensure_space(reserve_mb=100, allow_cleanup=False)
        self.assertEqual({"cleaned": False, "deleted_count": 0, "batches": 0, "remaining_mb": 100.0}, result)
        self.assertEqual([("/api/album/index.json", {})], self.api.get_calls)
        self.assertEqual([], self.api.post_calls)
        self.assertFalse(self.audit_path.exists())

    def test_low_capacity_suspension_stops_before_tail_audit_and_delete(self):
        self.api.used = self.api.capacity - 99 * MIB
        cleaner = self.cleaner()
        original_rows = list(self.api.rows)
        with patch.object(cleaner, "_tail", side_effect=AssertionError("Cannot select suspended images")), \
                patch.object(cleaner, "_audit", side_effect=AssertionError("Cannot audit suspended deletion")), \
                self.assertRaisesRegex(AlbumCleanupError, "自动清理已暂停，未删除任何图片"):
            cleaner.ensure_space(allow_cleanup=False)
        self.assertEqual([("/api/album/index.json", {})], self.api.get_calls)
        self.assertEqual([], self.api.post_calls)
        self.assertEqual(original_rows, self.api.rows)
        self.assertFalse(self.audit_path.exists())

    def test_reserve_above_threshold_can_stop_suspended_cleanup_without_any_delete(self):
        cleaner = self.cleaner()
        with self.assertRaisesRegex(AlbumCleanupError, "低于本次所需 120.00 MB"):
            cleaner.ensure_space(reserve_mb=120, allow_cleanup=False)
        self.assertEqual([("/api/album/index.json", {})], self.api.get_calls)
        self.assertEqual([], self.api.post_calls)
        self.assertFalse(self.audit_path.exists())

    def test_default_call_preserves_bounded_verified_cleanup(self):
        self.api.used = self.api.capacity - 99 * MIB
        result = self.cleaner().ensure_space()
        self.assertTrue(result["cleaned"])
        self.assertEqual(12, result["deleted_count"])
        self.assertEqual(1, len(self.api.post_calls))
        events = [json.loads(line) for line in self.audit_path.read_text(encoding="utf-8").splitlines()]
        self.assertEqual(["plan", "before_delete", "after_delete", "complete"], [event["event"] for event in events])
        self.assertEqual("verified", events[2]["status"])

    def test_allow_cleanup_rejects_non_booleans_before_any_network_access(self):
        for value in (None, 0, 1, "false", [], {}):
            with self.subTest(value=value), self.assertRaisesRegex(AlbumCleanupError, "必须是布尔值"):
                self.cleaner().ensure_space(allow_cleanup=value)
        self.assertEqual([], self.api.get_calls)
        self.assertEqual([], self.api.post_calls)

    def test_live_uncertain_delete_still_blocks_even_with_read_only_flag(self):
        cleaner = self.cleaner()
        cleaner._uncertain = True
        with self.assertRaisesRegex(AlbumCleanupError, "删除结果不确定"):
            cleaner.ensure_space(allow_cleanup=False)
        self.assertEqual([], self.api.get_calls)
        self.assertEqual([], self.api.post_calls)

    def test_suspension_does_not_clear_durable_unknown_delete_audit(self):
        self.api.used = self.api.capacity - 99 * MIB
        previous = self.root / ("a" * 32) / "cleanup.jsonl"
        previous.parent.mkdir()
        old = '{"event":"before_delete","operationId":"unconfirmed"}\n'
        previous.write_text(old, encoding="utf-8")
        self.audit_path = self.root / ("b" * 32) / "cleanup.jsonl"
        cleaner = self.cleaner()
        with self.assertRaisesRegex(AlbumCleanupError, "自动清理已暂停"):
            cleaner.ensure_space(allow_cleanup=False)
        self.assertEqual(old, previous.read_text(encoding="utf-8"))
        with self.assertRaisesRegex(AlbumCleanupError, "上次图库删除结果尚未确认"):
            self.cleaner().ensure_space()
        self.assertEqual([], self.api.post_calls)
        self.assertFalse(self.audit_path.exists())


if __name__ == "__main__":
    unittest.main()
