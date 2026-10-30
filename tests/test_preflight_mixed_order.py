"""The review must show the same interleaved images that will be uploaded."""
import tempfile
import tkinter as tk
import unittest
from pathlib import Path
from types import SimpleNamespace

from PIL import Image

import preflight_review as review
from mixed_image_order import layout_key, make_items, order_key


def config(profile="blanket", first="white"):
    return SimpleNamespace(listing_profile=profile, bw_first_color=first, max_images=10)


def product(images, details=(), **overrides):
    values = dict(folder=Path("商品"), title="商品", images=list(images),
                  detail_image_paths=list(details), common_detail_count=len(details),
                  color_image_sets={})
    values.update(overrides)
    return SimpleNamespace(**values)


class MixedOrderPreviewTests(unittest.TestCase):
    def test_common_details_are_labeled_by_identity_between_product_images(self):
        images = [Path(name) for name in ("main.png", "size.png", "back.png", "detail.png", "side.png")]
        selected = product(images, details=[images[1], images[3]])
        entries = review.preview_entries(selected, config())
        self.assertEqual(images, [entry.path for entry in entries])
        self.assertEqual(["main", "common", "product", "common", "product"],
                         [entry.role for entry in entries])
        self.assertIn("通用细节图", entries[1].label)
        self.assertIn("商品图", entries[-1].label)

    def test_common_detail_can_be_actual_first_main_and_original_is_still_a_product(self):
        images = [Path("size.png"), Path("product.png"), Path("back.png")]
        entries = review.preview_entries(product(images, details=images[:1]), config("tshirt"))
        self.assertEqual(images, [entry.path for entry in entries])
        self.assertEqual(["common", "product", "product"], [entry.role for entry in entries])
        self.assertIn("主图", entries[0].label)
        self.assertIn("通用细节图", entries[0].label)
        self.assertIn("商品图", entries[1].label)

    def test_default_empty_identity_list_preserves_historic_tail_labels(self):
        images = [Path("product.png"), Path("back.png"), Path("size.png")]
        selected = product(images, common_detail_count=1)
        entries = review.preview_entries(selected, config())
        self.assertEqual(["main", "product", "common"], [entry.role for entry in entries])

    def test_bw_independent_orders_can_start_with_details_and_move_product_later(self):
        white, black = Path("white-product.png"), Path("black-product.png")
        size, white_back, black_back = Path("size.png"), Path("white-back.png"), Path("black-back.png")
        sets = {"white": [size, white_back, white], "black": [black_back, black, size]}
        selected = product([white, black], color_image_sets=sets)
        entries = review.preview_entries(selected, config("tshirt_bw"))
        self.assertEqual(sets["white"] + sets["black"], [entry.path for entry in entries])
        self.assertEqual(["white", "white_detail", "white_detail",
                          "black", "black_detail", "black_detail"], [entry.role for entry in entries])
        self.assertIn("白色主图", entries[0].label)
        self.assertIn("白色细节图", entries[0].label)
        self.assertIn("白色商品图", entries[2].label)
        self.assertIn("黑色主图", entries[3].label)
        self.assertIn("黑色商品图", entries[4].label)
        self.assertIn("黑色细节图", entries[-1].label)

    def test_bw_duplicate_or_missing_product_or_other_color_product_is_rejected(self):
        white, black, detail = Path("white-product.png"), Path("black-product.png"), Path("detail.png")
        for white_paths in ([detail], [white, detail, detail], [detail, black, white]):
            with self.subTest(white_paths=white_paths):
                selected = product([white, black], color_image_sets={"white": white_paths, "black": [black]})
                with self.assertRaises(ValueError):
                    review.preview_entries(selected, config("tshirt_bw"))

    def test_black_first_groups_follow_color_mapping_without_reordering_snapshot(self):
        white, black = Path("white-product.png"), Path("black-product.png")
        sets = {"white": [Path("white-detail.png"), white], "black": [Path("black-detail.png"), black]}
        selected = product([black, white], color_image_sets=sets)
        entries = review.preview_entries(selected, config("tshirt_bw", "black"))
        self.assertEqual(sets["black"] + sets["white"], [entry.path for entry in entries])
        self.assertIn("黑色主图", entries[0].label)
        self.assertIn("白色商品图", entries[-1].label)

    def test_legacy_bw_rebuild_uses_saved_mixed_layout_and_product_override(self):
        white, black = Path("white-product.png"), Path("black-product.png")
        first_detail, last_detail = Path("size.png"), Path("white-back.png")
        black_detail = Path("black-back.png")
        selected = product([white, black, Path("old-shared.png")], common_detail_count=1)
        settings = config("tshirt_bw")
        settings.white_detail_images = [first_detail, last_detail]
        settings.black_detail_images = [black_detail]
        white_items = make_items([white], settings.white_detail_images)
        black_items = make_items([black], settings.black_detail_images)
        settings.combined_image_layouts = {
            layout_key("tshirt_bw", "white"): [item.token for item in reversed(white_items)],
            layout_key("tshirt_bw", "black"): [item.token for item in reversed(black_items)],
        }
        settings.combined_image_orders = {
            order_key("tshirt_bw", selected.folder, "white"):
                [white_items[index].token for index in (1, 0, 2)],
        }
        entries = review.preview_entries(selected, settings)
        self.assertEqual([first_detail, white, last_detail, black_detail, black],
                         [entry.path for entry in entries])
        self.assertIn("白色主图（白色细节图", entries[0].label)
        self.assertIn("白色商品图", entries[1].label)
        self.assertIn("黑色商品图", entries[-1].label)


class MixedThumbnailDialogTests(unittest.TestCase):
    def test_detail_first_thumbnail_and_moved_product_are_both_required_for_acknowledgement(self):
        root = tk.Tk()
        root.withdraw()
        self.addCleanup(root.destroy)
        with tempfile.TemporaryDirectory() as scratch:
            directory = Path(scratch)
            white, black, detail = [directory / name for name in ("white.png", "black.png", "detail.png")]
            for path, color in ((white, "white"), (black, "black"), (detail, "gray")):
                Image.new("RGB", (50, 80), color).save(path)
            selected = product([white, black], folder=directory,
                               color_image_sets={"white": [detail, white], "black": [black]})
            dialog = review.ImageOrderReviewDialog(root, [selected], config("tshirt_bw"))
            try:
                self.assertEqual(3, len(dialog.photos))
                self.assertTrue(dialog.current_ready)
                cards = dialog.cards.winfo_children()
                self.assertIn("白色主图（白色细节图", cards[0].winfo_children()[0].cget("text"))
                self.assertIn("白色商品图", cards[1].winfo_children()[0].cget("text"))
                self.assertIn("disabled", dialog.confirm_button.state())
                dialog.ack_button.invoke()
                self.assertNotIn("disabled", dialog.confirm_button.state())
                # A missing original product cannot be hidden by a readable detail thumbnail.
                white.unlink()
                dialog.show_sample(0)
                self.assertFalse(dialog.current_ready)
                self.assertFalse(dialog.checked)
                self.assertIn("disabled", dialog.confirm_button.state())
            finally:
                dialog.cancel()


if __name__ == "__main__":
    unittest.main()
