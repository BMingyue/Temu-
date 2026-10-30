import tempfile
import tkinter as tk
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from PIL import Image

import preflight_review as review


def job(folder, images=(), common_detail_count=0):
    return SimpleNamespace(folder=Path(folder), title=Path(folder).name,
                           images=list(images), common_detail_count=common_detail_count)


def config(profile="blanket", first="white"):
    return SimpleNamespace(listing_profile=profile, bw_first_color=first)


class PreviewPlanTests(unittest.TestCase):
    def test_samples_first_middle_last_without_repeats(self):
        jobs = [job(f"product-{index}") for index in range(9)]
        self.assertEqual([jobs[0], jobs[4], jobs[8]], review.sample_jobs(jobs))
        self.assertEqual([], review.sample_jobs([]))
        self.assertEqual(jobs[:1], review.sample_jobs(jobs[:1]))
        self.assertEqual(jobs[:2], review.sample_jobs(jobs[:2]))
        self.assertEqual([jobs[0], jobs[8]], review.sample_jobs([jobs[0], jobs[0], jobs[8]]))

    def test_normal_preview_preserves_order_and_labels_shared_tail(self):
        product = job("Product", [Path("2.png"), Path("1.png"), Path("detail.png")], 1)
        entries = review.preview_entries(product, config())
        self.assertEqual([Path("2.png"), Path("1.png"), Path("detail.png")], [entry.path for entry in entries])
        self.assertEqual(["main", "product", "common"], [entry.role for entry in entries])
        self.assertIn("主图", entries[0].label)
        self.assertIn("通用细节图", entries[-1].label)

    def test_bw_follows_explicit_order_even_when_names_suggest_another_color(self):
        product = job("Product", [Path("black.png"), Path("white.png"), Path("shared.png")], 1)
        entries = review.preview_entries(product, config("tshirt_bw"))
        self.assertEqual(["white", "black"], [entry.role for entry in entries])
        self.assertEqual([1, 2], [entry.source_index for entry in entries])
        self.assertNotIn(Path("shared.png"), [entry.path for entry in entries])
        reversed_entries = review.preview_entries(product, config("tshirt_bw", "black"))
        self.assertEqual(["black", "white"], [entry.role for entry in reversed_entries])
        self.assertEqual([entry.path for entry in entries], [entry.path for entry in reversed_entries])

    def test_bw_ignores_legacy_shared_tail_while_normal_preview_keeps_its_limit(self):
        product = job("Product", [Path(f"{index}.png") for index in range(11)], 9)
        self.assertEqual(2, len(review.preview_entries(product, config("tshirt_bw"))))
        normal_product = job("Normal", [Path(f"{index}.png") for index in range(12)])
        self.assertEqual(10, len(review.preview_entries(normal_product, config())))

    def test_invalid_image_plan_cannot_be_reviewed(self):
        cases = [
            (job("Empty"), config()),
            (job("Common only", [Path("shared.png")], 1), config()),
            (job("Bad count", [Path("a.png")], 2), config()),
            (job("One color", [Path("a.png")]), config("tshirt_bw")),
            (job("Extra color", [Path("a.png")] * 3), config("tshirt_bw")),
            (job("Unknown order", [Path("a.png")] * 2), config("tshirt_bw", "auto")),
        ]
        for product, options in cases:
            with self.subTest(product=product.title), self.assertRaises(ValueError):
                review.preview_entries(product, options)


class ThumbnailDialogTests(unittest.TestCase):
    def setUp(self):
        self.root = tk.Tk()
        self.root.withdraw()
        self.addCleanup(self.root.destroy)
        scratch = tempfile.TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        self.directory = Path(scratch.name)
        self.white = self.directory / "01_白色.png"
        self.black = self.directory / "02_黑色.png"
        Image.new("RGB", (90, 120), "white").save(self.white)
        Image.new("RGB", (120, 90), "black").save(self.black)

    def make_dialog(self, count=5):
        jobs = [job(self.directory / f"商品{index}", [self.white, self.black]) for index in range(count)]
        dialog = review.ImageOrderReviewDialog(self.root, jobs, config("tshirt_bw"))
        self.addCleanup(lambda: dialog.window.destroy() if dialog.window.winfo_exists() else None)
        return dialog

    def test_real_thumbnails_and_individual_acknowledgements_are_required(self):
        dialog = self.make_dialog()
        self.assertEqual(2, len(dialog.photos))
        self.assertTrue(dialog.current_ready)
        self.assertIn("disabled", dialog.confirm_button.state())
        dialog.confirm()  # Even a direct call cannot bypass per-product acknowledgement.
        self.assertFalse(dialog.result)
        self.assertTrue(dialog.window.winfo_exists())
        dialog.ack_button.invoke()
        self.assertEqual({0}, dialog.checked)
        self.assertEqual(1, dialog.current_index)
        self.assertIn("disabled", dialog.confirm_button.state())
        dialog.ack_button.invoke()
        self.assertEqual({0, 1}, dialog.checked)
        self.assertEqual(2, dialog.current_index)
        dialog.confirm_button.invoke()
        self.assertFalse(dialog.result)
        dialog.ack_button.invoke()
        self.assertEqual({0, 1, 2}, dialog.checked)
        self.assertNotIn("disabled", dialog.confirm_button.state())
        dialog.previous_button.invoke()
        self.assertEqual(1, dialog.current_index)
        self.assertEqual(2, len(dialog.photos))
        dialog.confirm_button.invoke()
        self.assertTrue(dialog.result)

    def test_missing_or_corrupt_thumbnail_prevents_acknowledgement(self):
        for content in (None, b"not a PNG"):
            with self.subTest(content=content):
                if content is None:
                    self.black.unlink(missing_ok=True)
                else:
                    self.black.write_bytes(content)
                dialog = self.make_dialog(count=1)
                self.assertFalse(dialog.current_ready)
                self.assertEqual(1, len(dialog.photos))
                self.assertIn("02_黑色.png", dialog.error_var.get())
                self.assertIn("已阻止开始", dialog.error_var.get())
                self.assertIn("disabled", dialog.ack_button.state())
                dialog.acknowledge_current()
                dialog.confirm()
                self.assertFalse(dialog.result)
                self.assertFalse(dialog.checked)
                dialog.cancel()

    def test_legacy_shared_tail_is_not_loaded_without_color_details(self):
        images = [self.white, self.black] + [self.white] * 9
        dialog = review.ImageOrderReviewDialog(
            self.root, [job(self.directory, images, 9)], config("tshirt_bw"))
        self.addCleanup(lambda: dialog.window.destroy() if dialog.window.winfo_exists() else None)
        self.assertEqual(2, len(dialog.photos))
        self.assertEqual(2, len(dialog.cards.winfo_children()))
        self.assertTrue(dialog.current_ready)
        self.assertIn("disabled", dialog.confirm_button.state())

    def test_revisiting_a_newly_broken_sample_invalidates_previous_acknowledgement(self):
        dialog = self.make_dialog(count=1)
        dialog.ack_button.invoke()
        self.assertNotIn("disabled", dialog.confirm_button.state())
        self.black.unlink()
        dialog.show_sample(0)
        self.assertFalse(dialog.checked)
        self.assertIn("disabled", dialog.confirm_button.state())

    def test_public_api_modal_returns_false_after_user_cancels(self):
        def cancel_modal(window):
            # The production API waits for a user action; the test triggers that action.
            self.root.after(10, window.destroy)
            self.root.wait_window_original(window)
        self.root.wait_window_original = self.root.wait_window
        with patch.object(self.root, "wait_window", side_effect=cancel_modal):
            self.assertFalse(review.confirm_image_order(self.root, [job(self.directory, [self.white])], config()))

    def test_empty_samples_never_enable_start(self):
        dialog = review.ImageOrderReviewDialog(self.root, [], config())
        self.addCleanup(lambda: dialog.window.destroy() if dialog.window.winfo_exists() else None)
        dialog.confirm()
        self.assertFalse(dialog.result)
        self.assertIn("disabled", dialog.confirm_button.state())


if __name__ == "__main__":
    unittest.main()
