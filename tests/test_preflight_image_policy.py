import tempfile
import tkinter as tk
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from PIL import Image

import preflight_review as review


class ImagePolicyPreviewTests(unittest.TestCase):
    def setUp(self):
        self.root = tk.Tk()
        self.root.withdraw()
        self.addCleanup(self.root.destroy)
        scratch = tempfile.TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        self.directory = Path(scratch.name)
        self.landscape = self.directory / "landscape.png"
        self.portrait = self.directory / "portrait.png"
        Image.new("RGB", (900, 450), "red").save(self.landscape)
        Image.new("RGB", (300, 600), "blue").save(self.portrait)

    def dialog(self, config=None, images=None, color_image_sets=None):
        if config is None:
            config = SimpleNamespace(listing_profile="blanket")
        job = SimpleNamespace(folder=self.directory, title="Sample", common_detail_count=0,
                              images=images or [self.landscape, self.portrait])
        if color_image_sets is not None:
            job.color_image_sets = color_image_sets
        dialog = review.ImageOrderReviewDialog(self.root, [job], config)
        self.addCleanup(lambda: dialog.window.destroy() if dialog.window.winfo_exists() else None)
        return dialog

    @staticmethod
    def card_texts(dialog):
        return [
            "\n".join(str(child.cget("text")) for child in card.winfo_children())
            for card in dialog.cards.winfo_children()
        ]

    def test_legacy_namespace_defaults_to_square_and_shows_both_sizes(self):
        dialog = self.dialog()
        self.assertTrue(dialog.current_ready)
        self.assertIn("1200×1200", dialog.image_processing_summary_var.get())
        cards = self.card_texts(dialog)
        self.assertIn("原图 900×450 → 上传 1200×1200", cards[0])
        self.assertIn("原图 300×600 → 上传 1200×1200", cards[1])
        self.assertIn("disabled", dialog.confirm_button.state())
        dialog.ack_button.invoke()
        self.assertNotIn("disabled", dialog.confirm_button.state())

    def test_original_preview_keeps_landscape_and_portrait_dimensions(self):
        dialog = self.dialog(SimpleNamespace(listing_profile="tshirt", image_processing_mode="original"))
        self.assertTrue(dialog.current_ready)
        self.assertIn("原图上传", dialog.image_processing_summary_var.get())
        cards = self.card_texts(dialog)
        self.assertIn("原图 900×450 → 上传 900×450", cards[0])
        self.assertIn("原图 300×600 → 上传 300×600", cards[1])
        self.assertNotIn("上传 1200×1200", "\n".join(cards))

    def test_fit_preview_shows_reduced_ratio_and_leaves_small_images_unenlarged(self):
        dialog = self.dialog(SimpleNamespace(listing_profile="blanket", image_processing_mode="fit", image_max_edge=800))
        self.assertIn("最长边 800", dialog.image_processing_summary_var.get())
        cards = self.card_texts(dialog)
        self.assertIn("原图 900×450 → 上传 800×400", cards[0])
        self.assertIn("原图 300×600 → 上传 300×600", cards[1])

    def test_custom_rectangular_canvas_shows_selected_width_and_height(self):
        dialog = self.dialog(SimpleNamespace(image_processing_mode="square", image_target_width=800,
                                             image_target_height=1000))
        self.assertIn("800×1000", dialog.image_processing_summary_var.get())
        self.assertIn("原图 900×450 → 上传 800×1000", self.card_texts(dialog)[0])
        self.assertTrue(dialog.current_ready)

    def test_bw_uses_the_same_policy_for_each_independent_color_detail(self):
        white_detail = self.directory / "white-detail.png"
        black_detail = self.directory / "black-detail.png"
        Image.new("RGB", (1400, 700), "white").save(white_detail)
        Image.new("RGB", (700, 1400), "black").save(black_detail)
        config = SimpleNamespace(listing_profile="tshirt_bw", bw_first_color="white",
                                 image_processing_mode="fit", image_max_edge=1000)
        dialog = self.dialog(config, color_image_sets={
            "white": [self.landscape, white_detail], "black": [self.portrait, black_detail]})
        cards = self.card_texts(dialog)
        self.assertEqual(4, len(cards))
        self.assertIn("白色细节图", cards[1])
        self.assertIn("原图 1400×700 → 上传 1000×500", cards[1])
        self.assertIn("黑色细节图", cards[3])
        self.assertIn("原图 700×1400 → 上传 500×1000", cards[3])
        self.assertTrue(dialog.current_ready)

    def test_exif_dimensions_are_displayed_after_rotation(self):
        source = self.directory / "phone.jpg"
        exif = Image.Exif()
        exif[0x0112] = 6
        Image.new("RGB", (1600, 800), "red").save(source, exif=exif)
        for mode, expected in (("original", "800×1600"), ("fit", "400×800")):
            with self.subTest(mode=mode):
                dialog = self.dialog(SimpleNamespace(image_processing_mode=mode, image_max_edge=800), images=[source])
                self.assertIn(f"原图 800×1600 → 上传 {expected}", self.card_texts(dialog)[0])
                self.assertTrue(dialog.current_ready)

    def test_preview_never_writes_processing_files_or_reencodes_sources(self):
        before = {path: path.read_bytes() for path in self.directory.iterdir()}
        with patch.object(Image.Image, "save", side_effect=AssertionError("preview must not encode image files")):
            dialog = self.dialog(SimpleNamespace(image_processing_mode="fit", image_max_edge=400))
            self.assertTrue(dialog.current_ready)
        self.assertEqual(before, {path: path.read_bytes() for path in self.directory.iterdir()})

    def test_original_mode_still_rejects_unreadable_thumbnail(self):
        self.portrait.write_bytes(b"broken image")
        dialog = self.dialog(SimpleNamespace(image_processing_mode="original"))
        self.assertFalse(dialog.current_ready)
        self.assertIn("已阻止开始", dialog.error_var.get())
        self.assertIn("disabled", dialog.ack_button.state())
        dialog.acknowledge_current()
        dialog.confirm()
        self.assertFalse(dialog.result)

    def test_invalid_processing_options_cannot_create_a_ready_dialog(self):
        windows_before = self.root.winfo_children()
        with self.assertRaisesRegex(ValueError, "图片目标宽度"):
            self.dialog(SimpleNamespace(image_processing_mode="square", image_target_width=10))
        self.assertEqual(windows_before, self.root.winfo_children())


if __name__ == "__main__":
    unittest.main()
