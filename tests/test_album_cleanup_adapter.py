"""Exercise the album adapter against a stateful fake API, never a real account."""
import copy
import json
import math
from pathlib import Path
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
from urllib.parse import urlsplit

from album_cleanup import ALBUM_URL, API_ORIGIN, AlbumCleaner, AlbumCleanupError, MIB


class FakeResponse:
    def __init__(self, path, data, code=0, status=200, url=None):
        self.status = status
        self.url = url or API_ORIGIN + path
        self.payload = {"code": code, "data": data}

    def json(self):
        return copy.deepcopy(self.payload)


class FakeAlbumApi:
    """Newest-first gallery with official response fields and mutable deletion."""

    def __init__(self, count=1279, free_mb=1, release_mb=1):
        self.puid = "42"
        self.capacity = 1200 * MIB
        self.used = self.capacity - int(free_mb * MIB)
        self.release_mb = release_mb
        self.rows = [{"id": index, "idStr": str(index), "puid": 42,
                      "name": f"image-{index}.jpg", "lockState": 0, "fileType": 0,
                      "createTime": count - index + 100,
                      "imgUrl": f"/wxalbum/42/{index}.jpg"}
                     for index in range(1, count + 1)]
        self.get_calls = []
        self.post_calls = []
        self.mode = "success"
        self.index_hook = None
        self.list_hook = None
        self.delete_hook = None

    def page_data(self, page_no=1, page_size=20):
        start = (page_no - 1) * page_size
        return {"picListPage": {
                    "list": copy.deepcopy(self.rows[start:start + page_size]),
                    "pageNo": page_no, "pageSize": page_size,
                    "totalPage": math.ceil(len(self.rows) / page_size),
                    "totalSize": len(self.rows), "params": {},
                },
                "lockedCount": sum(row["lockState"] for row in self.rows),
                "fullCid": "", "name": "", "beginDate": "", "endDate": ""}

    def get(self, url, params, timeout, max_redirects=0):
        assert max_redirects == 0
        path = urlsplit(url).path
        self.get_calls.append((path, dict(params)))
        if path == "/api/album/index.json":
            data = self.page_data()
            data["albumUserSummary"] = {"puid": self.puid,
                                       "realSizeAllow": str(self.capacity),
                                       "sizeUsed": str(self.used)}
            response = FakeResponse(path, data)
            if self.index_hook:
                self.index_hook(response, self)
            return response
        if path == "/api/album/list.json":
            data = self.page_data(params["pageNo"], params["pageSize"])
            response = FakeResponse(path, data)
            if self.list_hook:
                self.list_hook(response, params, self)
            return response
        raise AssertionError(f"Unexpected API read: {url}")

    def post(self, url, form, timeout, max_redirects=0):
        assert max_redirects == 0
        path = urlsplit(url).path
        ids = form["ids"].split(",")
        self.post_calls.append((path, ids))
        if self.delete_hook:
            self.delete_hook(self)
        if self.mode == "timeout":
            raise TimeoutError("fake request timeout")
        if self.mode == "http_error":
            return FakeResponse(path, {}, status=500)
        if self.mode == "api_error":
            return FakeResponse(path, {}, code=1)
        if self.mode == "redirect":
            return FakeResponse(path, {}, url=API_ORIGIN + "/login.htm")
        if self.mode == "missing_aus":
            return FakeResponse(path, {})
        if self.mode != "unchanged":
            deleting = set(ids)
            self.rows = [row for row in self.rows if row["idStr"] not in deleting]
            if self.mode != "stale_quota":
                self.used = max(0, self.used - int(len(ids) * self.release_mb * MIB))
        return FakeResponse(path, {"aus": {}})


class AlbumCleanupAdapterTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.audit = Path(self.temporary.name) / "cleanup.jsonl"
        self.api = FakeAlbumApi()
        self.page = SimpleNamespace(url=ALBUM_URL, context=SimpleNamespace(request=self.api))
        self.page.goto = Mock()
        self.stop = False
        self.sleeps = []

    def cleaner(self, threshold=500, protected=()):
        return AlbumCleaner(self.page, Mock(), lambda: self.stop,
                            self.sleeps.append, threshold, set(protected), self.audit)

    def events(self):
        if not self.audit.exists():
            return []
        return [json.loads(line) for line in self.audit.read_text(encoding="utf-8").splitlines()]

    def test_fixed_last_two_pages_include_partial_page_without_filling_from_earlier(self):
        cleaner = self.cleaner()
        with self.assertRaisesRegex(AlbumCleanupError, "末两页范围清理，空间仍不足"):
            cleaner.ensure_space()
        self.assertEqual([list(map(str, range(1201, 1280))), list(map(str, range(901, 1201)))],
                         [ids for _path, ids in self.api.post_calls])
        self.assertEqual(list(range(1, 901)), [row["id"] for row in self.api.rows])
        self.assertEqual(379, sum(len(ids) for _path, ids in self.api.post_calls))
        lists = [params for path, params in self.api.get_calls if path == "/api/album/list.json"]
        self.assertTrue(all(params["pageSize"] == 300 for params in lists))
        self.assertTrue(all(params["name"] == params["fullCid"] == "" for params in lists))
        self.assertEqual([5, 4], [params["pageNo"] for params in lists[:2]])

    def test_two_full_pages_have_hard_limit_600_and_no_third_delete(self):
        self.api = FakeAlbumApi(count=1200, free_mb=1)
        self.page.context.request = self.api
        cleaner = self.cleaner(threshold=1000)
        with self.assertRaisesRegex(AlbumCleanupError, "空间仍不足"):
            cleaner.ensure_space()
        self.assertEqual([300, 300], [len(ids) for _path, ids in self.api.post_calls])
        self.assertEqual(set(map(str, range(601, 1201))),
                         {identifier for _path, ids in self.api.post_calls for identifier in ids})

    def test_one_page_success_and_verified_audit_and_post_quota_reads(self):
        self.api = FakeAlbumApi(count=12, free_mb=99, release_mb=1)
        self.page.context.request = self.api
        result = self.cleaner(threshold=100).ensure_space()
        self.assertEqual({"cleaned": True, "deleted_count": 12, "batches": 1,
                          "remaining_mb": 111.0}, result)
        self.assertEqual([], self.api.rows)
        self.assertEqual(1, len(self.api.post_calls))
        events = self.events()
        self.assertEqual(["plan", "before_delete", "after_delete", "complete"],
                         [event["event"] for event in events])
        self.assertEqual("verified", events[2]["status"])
        self.assertEqual(0, events[2]["after"]["imageCount"])
        self.assertEqual(111 * MIB, events[2]["after"]["remainingBytes"])

    def test_locks_and_protection_match_relative_path_http_and_multiple_cdn_aliases(self):
        self.api = FakeAlbumApi(count=8, free_mb=99)
        self.page.context.request = self.api
        self.api.rows[2]["lockState"] = 1
        self.api.rows[1]["imgUrl"] = "http://alias-two.example/wxalbum/42/2.jpg?resize=200"
        self.api.rows[3]["imgUrl"] = "//alias-three.example/wxalbum/42/4.jpg"
        protected = {"https://different-cdn.example/wxalbum/42/2.jpg?width=1200#preview",
                     "/wxalbum/42/4.jpg"}
        result = self.cleaner(threshold=100, protected=protected).ensure_space()
        self.assertEqual(5, result["deleted_count"])
        self.assertEqual([2, 3, 4], [row["id"] for row in self.api.rows])
        self.assertEqual(["1", "5", "6", "7", "8"], self.api.post_calls[0][1])

    def test_quota_at_threshold_or_above_is_read_only_and_creates_no_audit(self):
        self.api.used = self.api.capacity - 100 * MIB
        result = self.cleaner(threshold=100).ensure_space()
        self.assertFalse(result["cleaned"])
        self.assertEqual([], self.api.post_calls)
        self.assertFalse(self.audit.exists())
        self.assertEqual([("/api/album/index.json", {})], self.api.get_calls)

    def test_stop_before_cleanup_never_reads_or_deletes(self):
        self.stop = True
        with self.assertRaisesRegex(AlbumCleanupError, "任务已停止"):
            self.cleaner().ensure_space()
        self.assertEqual([], self.api.get_calls)
        self.assertEqual([], self.api.post_calls)

    def test_no_unlocked_unprotected_candidate_does_not_delete(self):
        self.api = FakeAlbumApi(count=5, free_mb=1)
        self.page.context.request = self.api
        for row in self.api.rows:
            row["lockState"] = 1
        with self.assertRaisesRegex(AlbumCleanupError, "没有可清理图片"):
            self.cleaner(threshold=100).ensure_space()
        self.assertEqual([], self.api.post_calls)
        self.assertFalse(self.audit.exists())

    def test_delete_failures_never_retry_even_on_new_cleaner_for_same_audit(self):
        for mode in ("timeout", "http_error", "api_error", "redirect", "missing_aus"):
            with self.subTest(mode=mode):
                self.api = FakeAlbumApi(count=4, free_mb=99)
                self.api.mode = mode
                self.page.context.request = self.api
                self.audit = Path(self.temporary.name) / (mode + ".jsonl")
                cleaner = self.cleaner(threshold=100)
                with self.assertRaisesRegex(AlbumCleanupError, "不会自动重复删除"):
                    cleaner.ensure_space()
                with self.assertRaisesRegex(AlbumCleanupError, "结果不确定"):
                    cleaner.ensure_space()
                with self.assertRaisesRegex(AlbumCleanupError, "上次图库删除结果尚未确认"):
                    self.cleaner(threshold=100).ensure_space()
                self.assertEqual(1, len(self.api.post_calls))
                after = [event for event in self.events() if event["event"] == "after_delete"]
                self.assertEqual(["uncertain"], [event["status"] for event in after])

    def test_success_response_requires_both_removal_and_capacity_release(self):
        for mode in ("unchanged", "stale_quota"):
            with self.subTest(mode=mode):
                self.api = FakeAlbumApi(count=4, free_mb=99)
                self.api.mode = mode
                self.page.context.request = self.api
                self.audit = Path(self.temporary.name) / (mode + ".jsonl")
                with self.assertRaisesRegex(AlbumCleanupError, "删除结果或空间释放尚未确认"):
                    self.cleaner(threshold=100).ensure_space()
                self.assertEqual(1, len(self.api.post_calls))
                self.assertEqual("uncertain", self.events()[-1]["status"])

    def test_stop_after_post_never_sends_second_batch_and_marks_uncertain(self):
        self.api.delete_hook = lambda _api: setattr(self, "stop", True)
        with self.assertRaisesRegex(AlbumCleanupError, "任务已停止"):
            self.cleaner().ensure_space()
        self.assertEqual(1, len(self.api.post_calls))
        self.assertEqual("uncertain", self.events()[-1]["status"])

    def test_stop_immediately_before_delete_does_not_leave_pending_audit(self):
        cleaner = self.cleaner()
        original_tail = cleaner._tail
        calls = 0

        def stop_after_final_candidate_verification(index):
            nonlocal calls
            pages = original_tail(index)
            calls += 1
            if calls == 2:
                self.stop = True
            return pages

        cleaner._tail = stop_after_final_candidate_verification
        with self.assertRaisesRegex(AlbumCleanupError, "任务已停止"):
            cleaner.ensure_space()
        self.assertEqual([], self.api.post_calls)
        self.assertEqual(["plan"], [event["event"] for event in self.events()])
        self.stop = False
        cleaner._audit_clear()

    def test_main_stop_during_post_verification_propagates_user_stop_and_retains_pending(self):
        import main

        self.api = FakeAlbumApi(count=8, free_mb=99)
        self.page.context.request = self.api
        self.page.close = Mock()
        stopped = threading.Event()
        self.api.delete_hook = lambda _api: stopped.set()
        source = Path(self.temporary.name) / "source.jpg"
        source.write_bytes(b"offline-source")
        job = main.ProductJob(source.parent, "Offline", [source])
        log_dir = Path(self.temporary.name) / "logs"
        with patch.object(main, "LOG_DIR", log_dir):
            uploader = main.DxmUploader(main.AppConfig(album_cleanup_enabled=True,
                        album_cleanup_batch_id="e" * 32), Mock(), stopped)
            uploader.page = SimpleNamespace(context=SimpleNamespace(new_page=lambda: self.page))
            with self.assertRaises(main.StopRequested):
                uploader._ensure_album_space(job)
            self.audit = log_dir / "album-cleanup" / ("e" * 32) / "cleanup.jsonl"
            self.assertEqual("uncertain", self.events()[-1]["status"])
            with self.assertRaisesRegex(AlbumCleanupError, "上次图库删除结果尚未确认"):
                self.cleaner()._audit_clear()
        self.assertEqual(1, len(self.api.post_calls))
        self.page.close.assert_called_once_with()

    def test_pending_deletion_in_previous_batch_blocks_a_new_batch_uuid(self):
        audit_root = Path(self.temporary.name) / "album-cleanup"
        previous = audit_root / ("a" * 32) / "cleanup.jsonl"
        previous.parent.mkdir(parents=True)
        previous.write_text(json.dumps({"event": "before_delete", "operationId": "uncertain-op"}) + "\n",
                            encoding="utf-8")
        self.audit = audit_root / ("b" * 32) / "cleanup.jsonl"
        with self.assertRaisesRegex(AlbumCleanupError, "上次图库删除结果尚未确认"):
            self.cleaner().ensure_space()
        self.assertEqual([], self.api.post_calls)
        self.assertFalse(self.audit.exists())

    def test_verified_previous_batch_does_not_block_a_new_batch_uuid(self):
        audit_root = Path(self.temporary.name) / "album-cleanup"
        previous = audit_root / ("a" * 32) / "cleanup.jsonl"
        previous.parent.mkdir(parents=True)
        entries = [{"event": "before_delete", "operationId": "confirmed-op"},
                   {"event": "after_delete", "operationId": "confirmed-op", "status": "verified"}]
        previous.write_text("".join(json.dumps(entry) + "\n" for entry in entries), encoding="utf-8")
        self.audit = audit_root / ("b" * 32) / "cleanup.jsonl"
        self.api = FakeAlbumApi(count=4, free_mb=99)
        self.page.context.request = self.api
        self.assertEqual(4, self.cleaner(threshold=100).ensure_space()["deleted_count"])
        self.assertEqual(1, len(self.api.post_calls))

    def test_deleted_ids_are_rechecked_even_if_count_and_quota_match(self):
        self.api = FakeAlbumApi(count=650, free_mb=99)
        self.page.context.request = self.api

        def substitute_wrong_deletions(api):
            # Emulate a bad backend: it frees the expected amount and removes
            # the expected count, but leaves all requested tail IDs untouched.
            amount = len(api.post_calls[-1][1])
            api.rows = api.rows[amount:]
            api.used -= amount * MIB
            api.mode = "unchanged"

        self.api.delete_hook = substitute_wrong_deletions
        with self.assertRaisesRegex(AlbumCleanupError, "删除结果或空间释放尚未确认"):
            self.cleaner(threshold=100).ensure_space()
        self.assertEqual(1, len(self.api.post_calls))
        self.assertEqual("uncertain", self.events()[-1]["status"])

    def test_ambiguous_page_number_size_filters_or_locks_abort_before_post(self):
        mutations = (
            lambda data: data["picListPage"].update(pageNo=1),
            lambda data: data["picListPage"].update(pageSize=20),
            lambda data: data.update(name="unexpected filter"),
            lambda data: data["picListPage"]["list"][0].update(lockState=None),
            lambda data: data["picListPage"]["list"][0].update(puid=43),
            lambda data: data["picListPage"]["list"][0].update(imgUrl="/wxalbum/43/a.jpg"),
        )
        for mutate in mutations:
            with self.subTest(mutation=mutate):
                self.api.list_hook = lambda response, _params, _api, m=mutate: m(response.payload["data"])
                with self.assertRaises(AlbumCleanupError):
                    self.cleaner().ensure_space()
                self.assertEqual([], self.api.post_calls)

    def test_redirect_or_api_failure_during_index_aborts_before_post(self):
        for mutation in (lambda response: setattr(response, "url", API_ORIGIN + "/login.htm"),
                         lambda response: setattr(response, "status", 403),
                         lambda response: response.payload.update(code=True),
                         lambda response: response.payload.update(code=1)):
            with self.subTest(mutation=mutation):
                self.api.index_hook = lambda response, _api, m=mutation: m(response)
                with self.assertRaises(AlbumCleanupError):
                    self.cleaner().ensure_space()
                self.assertEqual([], self.api.post_calls)


if __name__ == "__main__":
    unittest.main()
