import unittest
from dataclasses import FrozenInstanceError

from album_cleanup_policy import (
    AlbumImage, AlbumUsage, cleanup_candidates, image_url_identity,
    needs_cleanup, parse_capacity_mb, usage_from_text,
)


def image(number, **options):
    return AlbumImage(str(number), f"https://IMG.example.com/Photo/{number}.jpg?width=1200", **options)


class AlbumCapacityTests(unittest.TestCase):
    def test_units_separators_and_chinese_units(self):
        for text, expected in (("1,200.00M", 1200), (" 1,200.25 MB ", 1200.25),
                               ("1.5GB", 1536), ("2 g", 2048), ("512K", .5),
                               ("1024 kB", 1), ("0 MB", 0), ("2兆字节", 2),
                               ("1 吉", 1024), ("512 千字节", .5), ("2MiB", 2)):
            with self.subTest(text=text):
                self.assertEqual(expected, parse_capacity_mb(text))

    def test_invalid_capacity_does_not_guess(self):
        for text in (None, 1200, "", "1200", "-1M", "NaN MB", "InfinityG", "1e3MB",
                     "1,20M", "12,00.0MB", "1 MB extra", "剩余空间100M", "1TB", "1..0M"):
            with self.subTest(text=text):
                self.assertRaises(ValueError, parse_capacity_mb, text)

    def test_usage_extracts_three_labels_not_image_or_pdf_subtotals(self):
        usage = usage_from_text("空间使用情况\n总容量\n1,200.00M\n已使用 895.66M\n"
                                "剩余空间：304.34M\n图片占用容量 800.00M\nPDF占用容量 95.66M")
        self.assertEqual(AlbumUsage(1200, 895.66, 304.34), usage)
        self.assertEqual(usage, usage_from_text("总容量:1200MB 已使用:895.66MB 剩余空间:304.34MB"))

    def test_usage_rounding_tolerance_and_frozen_snapshot(self):
        usage = AlbumUsage(1200, 895.66, 304.33)
        self.assertEqual(1200.0, usage.total_mb)
        self.assertEqual(AlbumUsage(0, 0, 0).remaining_mb, 0)
        self.assertEqual(AlbumUsage(1200, 896, 305).remaining_mb, 305)
        with self.assertRaises(FrozenInstanceError):
            usage.used_mb = 100
        for values in ((1200, 900, 400), (0, 0, 1.01), (-1, 0, 0),
                       (float("nan"), 0, 0), (1200, float("inf"), 0), (True, 0, 1), ("1200", 0, 1200)):
            with self.subTest(values=values):
                self.assertRaises(ValueError, AlbumUsage, *values)

    def test_malformed_or_ambiguous_usage_stops(self):
        for text in ("", None, "已使用100M 剩余空间50M", "总容量150M 已使用100M 剩余空间-50M",
                     "总容量150M 已使用100M 剩余空间50", "总容量150M 已使用100M 剩余空间50M 剩余空间50M",
                     "总容量150M 已使用100M 剩余空间50Mbc", "总容量150M 已使用100M 剩余空间50M.5"):
            with self.subTest(text=text):
                self.assertRaises(ValueError, usage_from_text, text)

    def test_cleanup_threshold_reserve_and_unreachable_target(self):
        self.assertTrue(needs_cleanup(AlbumUsage(1200, 1101, 99)))
        self.assertFalse(needs_cleanup(AlbumUsage(1200, 1100, 100)))
        self.assertTrue(needs_cleanup(AlbumUsage(1200, 1040, 160), reserve_mb=200))
        self.assertFalse(needs_cleanup(AlbumUsage(1200, 1000, 200), threshold_mb=50, reserve_mb=200))
        for threshold in (0, 49, 2001, True, 100.0, "100"):
            self.assertRaises(ValueError, needs_cleanup, AlbumUsage(1200, 1100, 100), threshold)
        for reserve in (-1, float("nan"), float("inf"), True, "200"):
            self.assertRaises(ValueError, needs_cleanup, AlbumUsage(1200, 1100, 100), reserve_mb=reserve)
        self.assertRaises(ValueError, needs_cleanup, AlbumUsage(1200, 1100, 100), reserve_mb=1201)
        self.assertRaises(ValueError, needs_cleanup, AlbumUsage(80, 80, 0))
        self.assertRaises(ValueError, needs_cleanup, AlbumUsage(0, 0, 0))
        self.assertRaises(ValueError, needs_cleanup, None)


class AlbumCandidateTests(unittest.TestCase):
    def test_partial_last_page_plus_previous_page_is_not_filled_to_600(self):
        last = [image(number) for number in range(1201, 1280)]
        previous = [image(number) for number in range(901, 1201)]
        candidates = cleanup_candidates([last, previous])
        self.assertEqual(379, len(candidates))
        self.assertEqual(last + previous, candidates)
        self.assertEqual(79, len(last))
        self.assertEqual(300, len(previous))

    def test_full_two_pages_and_empty_pages(self):
        pages = [[image(number) for number in range(start, start + 300)] for start in (300, 0)]
        self.assertEqual(600, len(cleanup_candidates(pages)))
        self.assertEqual([], cleanup_candidates([]))
        self.assertEqual([], cleanup_candidates([[], []]))
        self.assertEqual([image(1)], cleanup_candidates([[], [image(1)]]))
        self.assertEqual(pages[0][:2], cleanup_candidates(pages, max_images=2))

    def test_locked_and_current_template_urls_are_never_selected(self):
        candidates = cleanup_candidates([[image(1), image(2, locked=True), image(3)]],
                                        ["http://img.EXAMPLE.com/Photo/3.jpg?crop=10#preview"])
        self.assertEqual([image(1)], candidates)

    def test_duplicate_ids_urls_and_protected_aliases(self):
        first = image(1)
        same_id = AlbumImage("1", "https://img.example.com/Photo/other.jpg")
        same_url = AlbumImage("another", "//img.example.com/Photo/1.jpg?x=2")
        self.assertEqual([first, image(2)], cleanup_candidates([[first, same_id, same_url], [image(2)]]))
        self.assertEqual([], cleanup_candidates([[first], [AlbumImage("1", same_id.url, locked=True)]]))
        self.assertEqual([], cleanup_candidates([[first, same_url]], protected_urls=[same_url.url]))

    def test_url_host_normalized_but_path_case_is_significant(self):
        upper = AlbumImage("upper", "https://IMG.EXAMPLE.com/PHOTO/1.jpg?x=1")
        lower = AlbumImage("lower", "https://img.example.com/photo/1.jpg?x=1")
        self.assertNotEqual(image_url_identity(upper.url), image_url_identity(lower.url))
        self.assertEqual([lower], cleanup_candidates([[upper, lower]], protected_urls=[upper.url]))
        self.assertEqual("//img.example.com/PHOTO/1.jpg", image_url_identity(upper.url))
        self.assertEqual(image_url_identity(upper.url), image_url_identity("//IMG.example.com:443/PHOTO/1.jpg#preview"))

    def test_missing_or_malformed_metadata_stops_instead_of_guessing(self):
        for identifier, url in (("", image(1).url), (None, image(1).url), (1, image(1).url),
                                ("1", ""), ("1", None), ("1", "/image.jpg"),
                                ("1", "https://img.example.com/?id=1"), ("1", "javascript:alert(1)"),
                                ("1", "https://img.example.com:bad/1.jpg"),
                                ("1", "https://bad host.com/a.jpg")):
            with self.subTest(identifier=identifier, url=url):
                self.assertRaises(ValueError, AlbumImage, identifier, url)
        self.assertRaises(ValueError, AlbumImage, "1", image(1).url, locked=None)
        self.assertRaises(ValueError, cleanup_candidates, [[{"id": "1", "url": image(1).url}]])
        self.assertRaises(ValueError, cleanup_candidates, [[image(1)]], [""])

    def test_limits_fail_before_any_selection_and_inputs_are_unchanged(self):
        for pages in ([[], [], []], [[image(i) for i in range(301)]], "bad", None, [[]] * 3):
            self.assertRaises(ValueError, cleanup_candidates, pages)
        for maximum in (0, -1, 601, True, 1.5, "600"):
            self.assertRaises(ValueError, cleanup_candidates, [[image(1)]], max_images=maximum)
        self.assertRaises(ValueError, cleanup_candidates, [[image(1)]], protected_urls=image(1).url)
        pages = [[image(1), image(2, locked=True)]]
        copied = list(pages[0])
        cleanup_candidates(pages)
        self.assertEqual(copied, pages[0])
        with self.assertRaises(FrozenInstanceError):
            pages[0][0].locked = True


if __name__ == "__main__":
    unittest.main()
