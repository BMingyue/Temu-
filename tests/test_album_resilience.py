"""Independent offline regressions for transient reads and non-retried deletes."""
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock

from album_cleanup import ALBUM_URL, AlbumCleaner, AlbumCleanupError, MIB
from tests.test_album_cleanup_adapter import FakeAlbumApi, FakeResponse


class AlbumResilienceTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        self.audit_path = self.directory / "cleanup.jsonl"
        self.api = FakeAlbumApi(count=6, free_mb=100)
        self.page = SimpleNamespace(url=ALBUM_URL, context=SimpleNamespace(request=self.api))
        self.page.goto = Mock()
        self.sleeps = []
        self.logs = []
        self.stop = False

    def cleaner(self):
        return AlbumCleaner(self.page, self.logs.append, lambda: self.stop,
                            self.sleeps.append, 100, set(), self.audit_path)

    @staticmethod
    def busy(response):
        response.payload = {"code": 2005, "msg": "系统繁忙，请稍后再试", "data": None}

    def events(self):
        if not self.audit_path.exists():
            return []
        return [json.loads(line) for line in self.audit_path.read_text(encoding="utf-8").splitlines()]

    def test_initial_index_busy_recovers_on_second_get_without_any_delete(self):
        calls = 0

        def hook(response, _api):
            nonlocal calls
            calls += 1
            if calls == 1:
                self.busy(response)

        self.api.index_hook = hook
        result = self.cleaner().ensure_space()
        self.assertFalse(result["cleaned"])
        self.assertEqual(2, calls)
        self.assertEqual([1.1, 2], self.sleeps)
        self.assertEqual([], self.api.post_calls)
        self.assertFalse(self.audit_path.exists())
        self.assertTrue(any("2005" in line and "系统繁忙" in line for line in self.logs))

    def test_two_transient_busy_reads_recover_on_last_allowed_get(self):
        calls = 0

        def hook(response, _api):
            nonlocal calls
            calls += 1
            if calls <= 2:
                self.busy(response)

        self.api.index_hook = hook
        usage = self.cleaner().read_usage()
        self.assertEqual(100, usage.remaining_mb)
        self.assertEqual(3, calls)
        self.assertEqual([1.1, 2, 4], self.sleeps)
        self.assertEqual([], self.api.post_calls)

    def test_repeated_busy_stops_after_three_reads_keeps_details_and_never_deletes(self):
        self.api.index_hook = lambda response, _api: self.busy(response)
        self.api.used = self.api.capacity - MIB
        with self.assertRaises(AlbumCleanupError) as caught:
            self.cleaner().ensure_space()
        self.assertIn("3次", str(caught.exception))
        self.assertIn("2005", str(caught.exception))
        self.assertIn("系统繁忙", str(caught.exception))
        self.assertEqual(3, len(self.api.get_calls))
        self.assertEqual([1.1, 2, 4], self.sleeps)
        self.assertEqual([], self.api.post_calls)
        self.assertFalse(self.audit_path.exists())

    def test_http_429_and_5xx_reads_are_bounded_and_can_recover(self):
        for status in (429, 500, 501, 502, 503, 504, 507, 599):
            with self.subTest(status=status):
                api = FakeAlbumApi(count=3, free_mb=100)
                self.page.context.request = api
                sleeps = []
                calls = 0

                def hook(response, _api):
                    nonlocal calls
                    calls += 1
                    if calls == 1:
                        response.status = status

                api.index_hook = hook
                cleaner = AlbumCleaner(self.page, self.logs.append, lambda: False,
                                       sleeps.append, 100, set(), self.audit_path)
                self.assertEqual(100, cleaner.read_usage().remaining_mb)
                self.assertEqual(2, calls)
                self.assertEqual([1.1, 2], sleeps)
                self.assertEqual([], api.post_calls)

    def test_read_connection_error_can_recover_and_has_three_attempt_cap(self):
        original = self.api.get
        calls = 0

        def flaky(*args, **kwargs):
            nonlocal calls
            calls += 1
            if calls == 1:
                raise TimeoutError("offline transient timeout")
            return original(*args, **kwargs)

        self.api.get = flaky
        self.assertEqual(100, self.cleaner().read_usage().remaining_mb)
        self.assertEqual(2, calls)
        self.assertEqual([1.1, 2], self.sleeps)
        self.assertEqual([], self.api.post_calls)
        self.sleeps.clear()
        self.api.get = Mock(side_effect=ConnectionError("offline unavailable"))
        with self.assertRaisesRegex(AlbumCleanupError, "3次"):
            self.cleaner().ensure_space()
        self.assertEqual(3, self.api.get.call_count)
        self.assertEqual([1.1, 2, 4], self.sleeps)
        self.assertEqual([], self.api.post_calls)

    def test_permission_and_unknown_application_errors_are_not_retried(self):
        for code, message in ((403, "没有图片管理权限"), (10001, "登录已失效"),
                              (9999, "未知错误，请联系管理员")):
            with self.subTest(code=code):
                api = FakeAlbumApi(count=3, free_mb=1)
                self.page.context.request = api
                sleeps = []

                def hook(response, _api):
                    response.payload = {"code": code, "msg": message, "data": None}

                api.index_hook = hook
                cleaner = AlbumCleaner(self.page, self.logs.append, lambda: False,
                                       sleeps.append, 100, set(), self.audit_path)
                with self.assertRaises(AlbumCleanupError) as caught:
                    cleaner.ensure_space()
                self.assertIn(str(code), str(caught.exception))
                self.assertIn(message, str(caught.exception))
                self.assertEqual(1, len(api.get_calls))
                self.assertEqual([1.1], sleeps)
                self.assertEqual([], api.post_calls)

    def test_nontransient_http_statuses_are_not_retried(self):
        for status in (301, 400, 401, 403, 404, 409):
            with self.subTest(status=status):
                api = FakeAlbumApi(count=3, free_mb=1)
                self.page.context.request = api
                api.index_hook = lambda response, _api: setattr(response, "status", status)
                sleeps = []
                cleaner = AlbumCleaner(self.page, self.logs.append, lambda: False,
                                       sleeps.append, 100, set(), self.audit_path)
                with self.assertRaisesRegex(AlbumCleanupError, str(status)):
                    cleaner.ensure_space()
                self.assertEqual(1, len(api.get_calls))
                self.assertEqual([1.1], sleeps)
                self.assertEqual([], api.post_calls)

    def test_busy_tail_read_stops_before_delete_instead_of_reusing_prior_index(self):
        self.api.used = self.api.capacity - MIB
        self.api.list_hook = lambda response, _params, _api: self.busy(response)
        with self.assertRaisesRegex(AlbumCleanupError, "2005"):
            self.cleaner().ensure_space()
        lists = [entry for entry in self.api.get_calls if entry[0].endswith("list.json")]
        self.assertEqual(3, len(lists))
        self.assertEqual([], self.api.post_calls)
        self.assertFalse(self.audit_path.exists())

    def test_busy_delete_is_sent_once_and_blocks_a_fresh_cleaner_from_repeating_it(self):
        self.api.used = self.api.capacity - 99 * MIB
        calls = []

        def busy_delete(url, form, timeout, max_redirects=0):
            calls.append((url, dict(form)))
            response = FakeResponse("/api/album/delPic.json", {}, code=2005)
            self.busy(response)
            return response

        self.api.post = busy_delete
        cleaner = self.cleaner()
        with self.assertRaises(AlbumCleanupError) as caught:
            cleaner.ensure_space()
        self.assertIn("不会自动重复删除", str(caught.exception))
        self.assertIn("2005", str(caught.exception))
        self.assertIn("系统繁忙", str(caught.exception))
        self.assertEqual(1, len(calls))
        self.assertEqual("1,2,3,4,5,6", calls[0][1]["ids"])
        with self.assertRaisesRegex(AlbumCleanupError, "结果不确定"):
            cleaner.ensure_space()
        with self.assertRaisesRegex(AlbumCleanupError, "上次图库删除结果尚未确认"):
            self.cleaner().ensure_space()
        self.assertEqual(1, len(calls))
        after = [event for event in self.events() if event["event"] == "after_delete"]
        self.assertEqual(["uncertain"], [event["status"] for event in after])
        self.assertFalse(any(event["event"] == "complete" for event in self.events()))

    def test_null_names_are_valid_display_metadata_during_usage_read_and_cleanup(self):
        for row in self.api.rows:
            row["name"] = None
        self.assertEqual(100, self.cleaner().read_usage().remaining_mb)
        self.assertEqual([], self.api.post_calls)
        self.api.used = self.api.capacity - 99 * MIB
        result = self.cleaner().ensure_space()
        self.assertEqual(6, result["deleted_count"])
        self.assertEqual(1, len(self.api.post_calls))
        self.assertEqual([], self.api.rows)
        self.assertEqual("verified", [event for event in self.events()
                         if event["event"] == "after_delete"][0]["status"])

    def test_null_name_does_not_relax_id_lock_or_url_validation(self):
        for field, value in (("idStr", None), ("id", "different"), ("lockState", None),
                             ("lockState", "0"), ("imgUrl", None), ("name", {})):
            with self.subTest(field=field, value=value):
                api = FakeAlbumApi(count=3, free_mb=1)
                self.page.context.request = api

                def malformed_display_row(response, _api):
                    row = response.payload["data"]["picListPage"]["list"][0]
                    row["name"] = None
                    row[field] = value

                api.index_hook = malformed_display_row
                cleaner = self.cleaner()
                with self.assertRaises(AlbumCleanupError):
                    cleaner.ensure_space()
                self.assertEqual(1, len(api.get_calls))
                self.assertEqual([], api.post_calls)

    def test_error_text_keeps_short_reason_without_html_urls_or_full_private_response(self):
        def hook(response, _api):
            response.payload = {"code": 403, "msg": "<b>无权限</b> https://private.example/token\n请检查账号",
                                "data": {"private_token": "should-not-log"}}

        self.api.index_hook = hook
        with self.assertRaises(AlbumCleanupError) as caught:
            self.cleaner().read_usage()
        text = str(caught.exception)
        self.assertIn("403", text)
        self.assertIn("无权限", text)
        self.assertIn("请检查账号", text)
        for forbidden in ("<b>", "private.example", "private_token", "should-not-log"):
            self.assertNotIn(forbidden, text)


if __name__ == "__main__":
    unittest.main()
