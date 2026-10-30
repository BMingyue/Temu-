import tempfile
import tkinter as tk
import unittest
from pathlib import Path
from types import SimpleNamespace

from PIL import Image

import preflight_review as review


def options(first="white"):
    return SimpleNamespace(listing_profile="tshirt_bw", bw_first_color=first)


def product(white=None, black=None, first="white"):
    white = white if white is not None else [Path("white-main.png"), Path("white-detail.png")]
    black = black if black is not None else [Path("black-main.png"), Path("black-detail.png")]
    mains = [Path("white-main.png"), Path("black-main.png")]
    if first == "black":
        mains.reverse()
    return SimpleNamespace(folder=Path("商品"), title="商品", images=mains,
                           common_detail_count=0, color_image_sets={"white": white, "black": black})


class ColorDetailPreviewTests(unittest.TestCase):
    def test_both_colors_show_all_nine_details_in_actual_group_order(self):
        white = [Path("white-main.png")] + [Path(f"white-detail-{index}.png") for index in range(9)]
        black = [Path("black-main.png")] + [Path(f"black-detail-{index}.png") for index in range(9)]
        entries = review.preview_entries(product(white, black), options())
        self.assertEqual(20, len(entries))
        self.assertEqual(white + black, [entry.path for entry in entries])
        self.assertEqual(["white"] + ["white_detail"] * 9 + ["black"] + ["black_detail"] * 9,
                         [entry.role for entry in entries])
        self.assertEqual(list(range(1, 21)), [entry.source_index for entry in entries])
        self.assertIn("白色第 2 张", entries[1].label)
        self.assertIn("白色细节图 1", entries[1].label)
        self.assertIn("黑色第 1 张", entries[10].label)
        self.assertFalse(any("两色共用" in entry.label for entry in entries))

    def test_shared_size_image_is_previewed_for_each_actual_upload(self):
        shared = Path("尺码表.png")
        white = [Path("white-main.png"), Path("white-back.png"), shared]
        black = [Path("black-main.png"), Path("black-back.png"), shared]
        entries = review.preview_entries(product(white, black), options())
        self.assertEqual(white + black, [entry.path for entry in entries])
        repeated = [entry for entry in entries if entry.path == shared]
        self.assertEqual(["white_detail", "black_detail"], [entry.role for entry in repeated])
        self.assertIn("白色", repeated[0].label)
        self.assertIn("黑色", repeated[1].label)

    def test_black_first_still_matches_and_labels_separate_groups(self):
        selected = product(first="black")
        entries = review.preview_entries(selected, options("black"))
        self.assertEqual(selected.color_image_sets["black"] + selected.color_image_sets["white"],
                         [entry.path for entry in entries])
        self.assertEqual(["black", "black_detail", "white", "white_detail"],
                         [entry.role for entry in entries])

    def test_missing_color_missing_product_cross_color_and_over_limit_are_rejected(self):
        cases = {
            "missing black": {"white": [Path("white-main.png")]},
            "unknown color": {"white": [Path("white-main.png")], "black": [Path("black-main.png")],
                              "red": [Path("red.png")]},
            "empty group": {"white": [], "black": [Path("black-main.png")]},
            "missing white product": {"white": [Path("white-detail.png")],
                                 "black": [Path("black-main.png")]},
            "opposite color main in details": {"white": [Path("white-main.png"), Path("black-main.png")],
                                               "black": [Path("black-main.png")]},
            "too many white": {"white": [Path("white-main.png")] + [Path("white-detail.png")] * 10,
                               "black": [Path("black-main.png")]},
            "too many black": {"white": [Path("white-main.png")],
                               "black": [Path("black-main.png")] + [Path("black-detail.png")] * 10},
        }
        for name, sets in cases.items():
            with self.subTest(name=name):
                selected = product()
                selected.color_image_sets = sets
                with self.assertRaises(ValueError):
                    review.preview_entries(selected, options())

    def test_empty_or_missing_sets_ignore_legacy_common_without_new_settings(self):
        for sets in (None, {}):
            with self.subTest(sets=sets):
                selected = product()
                selected.images.append(Path("legacy-shared.png"))
                selected.common_detail_count = 1
                selected.color_image_sets = sets
                entries = review.preview_entries(selected, options())
                self.assertEqual(["white", "black"], [entry.role for entry in entries])
                self.assertNotIn(Path("legacy-shared.png"), [entry.path for entry in entries])

    def test_legacy_job_uses_new_color_settings_and_deduplicates_each_group_only(self):
        selected = product()
        selected.color_image_sets = {}
        selected.images.append(Path("legacy-shared.png"))
        selected.common_detail_count = 1
        settings = options()
        shared = Path("尺码表.png")
        settings.white_detail_images = ["white-detail.png", shared, shared]
        settings.black_detail_images = ["black-detail.png", shared]
        entries = review.preview_entries(selected, settings)
        self.assertEqual([Path("white-main.png"), Path("white-detail.png"), shared,
                          Path("black-main.png"), Path("black-detail.png"), shared],
                         [entry.path for entry in entries])
        self.assertEqual(["white", "white_detail", "white_detail", "black", "black_detail", "black_detail"],
                         [entry.role for entry in entries])

    def test_legacy_black_first_uses_settings_for_the_correct_color(self):
        selected = product(first="black")
        del selected.color_image_sets
        settings = options("black")
        settings.white_detail_images = ["white-detail.png"]
        settings.black_detail_images = ["black-detail.png"]
        entries = review.preview_entries(selected, settings)
        self.assertEqual([Path("black-main.png"), Path("black-detail.png"),
                          Path("white-main.png"), Path("white-detail.png")], [entry.path for entry in entries])

    def test_legacy_rebuilt_plan_rejects_over_limit_and_opposite_main(self):
        for invalid_details in (["black-main.png"], [f"white-detail-{index}.png" for index in range(10)]):
            with self.subTest(details=invalid_details):
                selected = product()
                selected.color_image_sets = None
                settings = options()
                settings.white_detail_images = invalid_details
                with self.assertRaises(ValueError):
                    review.preview_entries(selected, settings)


class ColorDetailThumbnailTests(unittest.TestCase):
    def setUp(self):
        self.root = tk.Tk()
        self.root.withdraw()
        self.addCleanup(self.root.destroy)
        scratch = tempfile.TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        self.directory = Path(scratch.name)

    def test_real_legacy_dialog_loads_current_color_details_and_ignores_old_tail(self):
        paths = []
        for name, color in (("white-main", "white"), ("black-main", "black"),
                            ("white-detail", "white"), ("black-detail", "black")):
            path = self.directory / f"{name}.png"
            Image.new("RGB", (80, 60), color).save(path)
            paths.append(path)
        selected = SimpleNamespace(folder=self.directory, title="旧商品",
                                   images=[*paths[:2], self.directory / "missing-old-common.png"],
                                   common_detail_count=1)
        settings = options()
        settings.white_detail_images = [paths[2]]
        settings.black_detail_images = [paths[3]]
        dialog = review.ImageOrderReviewDialog(self.root, [selected], settings)
        self.addCleanup(lambda: dialog.window.destroy() if dialog.window.winfo_exists() else None)
        self.assertTrue(dialog.current_ready)
        self.assertEqual(4, len(dialog.photos))
        self.assertEqual("", dialog.error_var.get())
        cards = dialog.cards.winfo_children()
        self.assertIn("白色细节图", str(cards[1].winfo_children()[0].cget("text")))
        self.assertIn("黑色细节图", str(cards[3].winfo_children()[0].cget("text")))
        dialog.ack_button.invoke()
        self.assertNotIn("disabled", dialog.confirm_button.state())

    def test_real_dialog_loads_twenty_grouped_thumbnails_before_acknowledgement(self):
        white = []
        black = []
        for color, paths in (("white", white), ("black", black)):
            for index in range(10):
                path = self.directory / f"{color}-{index}.png"
                Image.new("RGB", (80, 60), color).save(path)
                paths.append(path)
        selected = product(white, black)
        selected.folder = self.directory
        selected.images = [white[0], black[0]]
        dialog = review.ImageOrderReviewDialog(self.root, [selected], options())
        self.addCleanup(lambda: dialog.window.destroy() if dialog.window.winfo_exists() else None)
        self.assertTrue(dialog.current_ready)
        self.assertEqual(20, len(dialog.photos))
        cards = dialog.cards.winfo_children()
        self.assertEqual(20, len(cards))
        self.assertIn("白色主图", str(cards[0].winfo_children()[0].cget("text")))
        self.assertIn("黑色主图", str(cards[10].winfo_children()[0].cget("text")))
        self.assertIn("黑色细节图 9", str(cards[-1].winfo_children()[0].cget("text")))
        self.assertIn("disabled", dialog.confirm_button.state())
        dialog.confirm()
        self.assertFalse(dialog.result)
        dialog.ack_button.invoke()
        self.assertNotIn("disabled", dialog.confirm_button.state())
        dialog.confirm_button.invoke()
        self.assertTrue(dialog.result)


if __name__ == "__main__":
    unittest.main()
