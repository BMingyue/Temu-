import json
import multiprocessing
import os
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from pathlib import Path
from unittest.mock import patch

from listing_profiles import ArticleNumberStore, normalize_template_url, validate_article_name


def _process_reservations(path, worker):
    store = ArticleNumberStore(path)
    for index in range(4):
        store.reserve(f"process-{worker}-{index}", "Tshirt", date(2026, 10, 23), 2)
    store.reserve("shared-product", "Tshirt", date(2026, 10, 23), 3)


class TemplateUrlTests(unittest.TestCase):
    def test_normalizes_supported_forms_without_rounding_large_id_or_query(self):
        query = "id=000220114595107558624&name=A%20B&tag=a%2Bb&tag=x&empty="
        for host in ("www.dianxiaomi.com", "dianxiaomi.com"):
            for path in ("edit", "quoteEdit", "quoteEdite"):
                with self.subTest(host=host, path=path):
                    actual = normalize_template_url(f"https://{host}/web/popTemu/{path}?{query}")
                    self.assertEqual(f"https://www.dianxiaomi.com/web/popTemu/quoteEdit?{query}", actual)

    def test_strips_copied_chat_wrappers_and_chinese_period(self):
        url = "https://www.dianxiaomi.com/web/popTemu/edit?id=220114595107558624"
        expected = url.replace("/edit?", "/quoteEdit?")
        for copied in (f"  {url}。 \n", f"<{url}>", f'“{url}。”', f"`{url}`。",
                       f"[模板]({url})", f"（{url}）", f"[<{url}>]。"):
            with self.subTest(copied=copied):
                self.assertEqual(expected, normalize_template_url(copied))
        self.assertEqual("", normalize_template_url(" \n "))

    def test_rejects_wrong_host_scheme_path_and_missing_or_ambiguous_id(self):
        invalid = (
            "http://www.dianxiaomi.com/web/popTemu/edit?id=1",
            "https://www.dianxiaomi.com.evil.test/web/popTemu/edit?id=1",
            "https://evil.test@www.dianxiaomi.com/web/popTemu/edit?id=1",
            "https://www.dianxiaomi.com:443/web/popTemu/edit?id=1",
            "https://www.dianxiaomi.com./web/popTemu/edit?id=1",
            "https://www.dianxiaomi.com/web/popTemu/edit/extra?id=1",
            "https://www.dianxiaomi.com/web/popTemu/edit/../edit?id=1",
            "https://www.dianxiaomi.com/web/popTemu/edit",
            "https://www.dianxiaomi.com/web/popTemu/edit?id=",
            "https://www.dianxiaomi.com/web/popTemu/edit?id=abc",
            "https://www.dianxiaomi.com/web/popTemu/edit?id=１２３",
            "https://www.dianxiaomi.com/web/popTemu/edit?id=1&id=2",
            "https://www.dianxiaomi.com/web/popTemu/edit?id=1#other",
            "https://www.dianxiaomi.com/web/popTemu/edit?id=1\n&x=y",
        )
        for value in invalid:
            with self.subTest(url=value), self.assertRaises(ValueError):
                normalize_template_url(value)


class ArticleNumberTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.path = Path(self.temporary.name) / "子目录" / "article-numbers.json"
        self.store = ArticleNumberStore(self.path)
        self.today = date(2026, 10, 23)

    def test_name_validation(self):
        for valid in ("T", "Tshirt", "my_T-2", "A" * 8):
            self.assertEqual(valid, validate_article_name(" " + valid + " "))
        for invalid in ("", "3shirt", "中文", "T shirt", "T.shirt", "A" * 9, None):
            with self.subTest(name=invalid), self.assertRaises(ValueError):
                validate_article_name(invalid)

    def test_number_length_and_sequence_limit_preserve_existing_history(self):
        name = "Abcd_1-2"
        number = self.store.reserve("first", name, self.today)[0]
        self.assertEqual("20261023-Abcd_1-2-0001", number)
        self.assertEqual(22, len(number))
        state = json.loads(self.path.read_text(encoding="utf-8"))
        state["counters"]["20261023-Abcd_1-2"] = 9998
        self.path.write_text(json.dumps(state), encoding="utf-8")
        before = self.path.read_bytes()
        with self.assertRaisesRegex(ValueError, "9999"):
            self.store.reserve("too-many", name, self.today, 2)
        self.assertEqual(before, self.path.read_bytes())
        self.assertEqual(["20261023-Abcd_1-2-9999"],
                         self.store.reserve("last", name, self.today, 1))
        before = self.path.read_bytes()
        with self.assertRaisesRegex(ValueError, "9999"):
            self.store.reserve("overflow", name, self.today, 1)
        self.assertEqual(before, self.path.read_bytes())
        self.assertEqual([number], self.store.reserve("first", name, self.today, 1))

    def test_reserves_different_numbers_and_retries_keep_original_date_and_name(self):
        first = self.store.reserve("product-a", "Tshirt", self.today, 2)
        self.assertEqual(["20261023-Tshirt-0001", "20261023-Tshirt-0002"], first)
        self.assertEqual(["20261023-Tshirt-0003"],
                         self.store.reserve("product-b", "Tshirt", self.today, 1))
        reloaded = ArticleNumberStore(self.path)
        self.assertEqual(first, reloaded.reserve("product-a", "Tshirt", date(2026, 10, 24), 2))
        extended = reloaded.reserve("product-a", "Tshirt", date(2026, 10, 24), 3)
        self.assertEqual(first + ["20261023-Tshirt-0004"], extended)
        self.assertEqual(first[:1], reloaded.reserve("product-a", "Tshirt", self.today, 1))
        self.assertEqual(extended, reloaded.reserve("product-a", "Tshirt", self.today, 3))
        self.assertEqual(["20261024-Tshirt-0001"],
                         reloaded.reserve("product-c", "Tshirt", date(2026, 10, 24), 1))
        self.assertEqual(["20261024-Blanket-0001"],
                         reloaded.reserve("product-a", "Blanket", date(2026, 10, 24), 1))

    def test_allocation_failure_keeps_existing_history_and_retry_sequence(self):
        self.store.reserve("original", "Tshirt", self.today)
        original = self.path.read_bytes()
        with patch("listing_profiles.os.replace", side_effect=OSError("blocked")):
            with self.assertRaises(OSError):
                self.store.reserve("new", "Tshirt", self.today)
        self.assertEqual(original, self.path.read_bytes())
        self.assertEqual([], list(self.path.parent.glob("*.tmp")))
        self.assertEqual(["20261023-Tshirt-0002"],
                         self.store.reserve("new", "Tshirt", self.today))

    def test_transient_windows_replace_denial_retries_same_transaction(self):
        self.store.reserve("original", "Tshirt", self.today)
        replace = os.replace
        for sequence, winerror in enumerate((5, 32, 33), start=2):
            failure = PermissionError("temporarily held by scanner")
            failure.winerror = winerror
            attempts = []

            def replace_after_transient_error(source, destination):
                attempts.append((source, destination))
                if len(attempts) == 1:
                    raise failure
                return replace(source, destination)

            with self.subTest(winerror=winerror):
                with patch("listing_profiles.os.replace", side_effect=replace_after_transient_error):
                    result = self.store.reserve(f"product-{sequence}", "Tshirt", self.today)
                self.assertEqual([f"20261023-Tshirt-{sequence:04d}"], result)
                self.assertEqual(2, len(attempts))
                self.assertEqual(attempts[0], attempts[1])
                self.assertEqual(result, ArticleNumberStore(self.path).reserve(
                    f"product-{sequence}", "Tshirt", self.today))
                self.assertEqual([], list(self.path.parent.glob("*.tmp")))

    def test_persistent_windows_replace_denial_is_bounded_and_keeps_history(self):
        self.store.reserve("original", "Tshirt", self.today)
        original = self.path.read_bytes()
        failure = PermissionError("permission denied")
        failure.winerror = 5
        with patch("listing_profiles.os.replace", side_effect=failure) as replace:
            with patch("listing_profiles.time.sleep") as sleep:
                with self.assertRaisesRegex(PermissionError, "原记录已保留"):
                    self.store.reserve("blocked", "Tshirt", self.today)
        self.assertEqual(12, replace.call_count)
        self.assertEqual(11, sleep.call_count)
        self.assertEqual(original, self.path.read_bytes())
        self.assertEqual([], list(self.path.parent.glob("*.tmp")))
        self.assertEqual(["20261023-Tshirt-0002"],
                         self.store.reserve("blocked", "Tshirt", self.today))

    def test_bad_arguments_create_no_history(self):
        for row_count in (0, -1, 1.5, True):
            with self.subTest(row_count=row_count), self.assertRaises(ValueError):
                self.store.reserve("product", "Tshirt", self.today, row_count)
        with self.assertRaises(ValueError):
            self.store.reserve(" ", "Tshirt", self.today)
        self.assertFalse(self.path.exists())

    def test_corrupt_history_is_preserved_and_never_resets_numbering(self):
        self.path.parent.mkdir(parents=True)
        corrupt_values = ("", "{broken", "null", '{"version":2,"counters":{},"products":{}}',
                          '{"version":1,"counters":{"20261023-Tshirt":true},"products":{}}')
        for corrupted in corrupt_values:
            self.path.write_text(corrupted, encoding="utf-8")
            with self.subTest(value=corrupted), self.assertRaises(ValueError):
                self.store.reserve("product", "Tshirt", self.today)
            self.assertEqual(corrupted, self.path.read_text(encoding="utf-8"))
        self.path.unlink()
        self.store.reserve("a", "Tshirt", self.today)
        state = json.loads(self.path.read_text(encoding="utf-8"))
        state["products"]["b"] = state["products"]["a"]
        self.path.write_text(json.dumps(state), encoding="utf-8")
        with self.assertRaises(ValueError):
            self.store.reserve("c", "Tshirt", self.today)

    def test_threaded_instances_allocate_without_duplicates_or_lost_updates(self):
        def reserve(index):
            return ArticleNumberStore(self.path).reserve(f"thread-{index}", "Tshirt", self.today, 2)
        with ThreadPoolExecutor(max_workers=8) as executor:
            batches = list(executor.map(reserve, range(24)))
        numbers = [number for batch in batches for number in batch]
        self.assertEqual(48, len(set(numbers)))
        self.assertEqual(set(range(1, 49)), {int(number.rsplit("-", 1)[1]) for number in numbers})
        self.assertEqual(["20261023-Tshirt-0049"],
                         self.store.reserve("next", "Tshirt", self.today))

    def test_multiple_processes_share_numbering_and_same_product_reservation(self):
        context = multiprocessing.get_context("spawn")
        workers = [context.Process(target=_process_reservations, args=(str(self.path), index))
                   for index in range(4)]
        started = []
        try:
            for worker in workers:
                worker.start()
                started.append(worker)
            for worker in started:
                worker.join(timeout=30)
                self.assertFalse(worker.is_alive(), "Article-number worker did not finish")
                self.assertEqual(0, worker.exitcode)
        finally:
            # A failed first worker must not leave later workers writing while
            # TemporaryDirectory's cleanup deletes the store and lock file.
            for worker in started:
                if worker.is_alive():
                    worker.terminate()
            for worker in started:
                worker.join(timeout=5)
                if worker.is_alive():
                    worker.kill()
                    worker.join(timeout=5)
                if not worker.is_alive():
                    worker.close()
        state = json.loads(self.path.read_text(encoding="utf-8"))
        self.assertEqual(17, len(state["products"]))
        all_numbers = [number for product in state["products"].values()
                       for record in product.values() for number in record["numbers"]]
        self.assertEqual(35, len(all_numbers))
        self.assertEqual(35, len(set(all_numbers)))
        self.assertEqual(35, state["counters"]["20261023-Tshirt"])
        self.assertEqual(3, len(self.store.reserve("shared-product", "Tshirt", self.today, 3)))
        self.assertEqual(["20261023-Tshirt-0036"],
                         self.store.reserve("next", "Tshirt", self.today))


if __name__ == "__main__":
    unittest.main()
