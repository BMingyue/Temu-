import tempfile
import tkinter as tk
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from PIL import Image

from mixed_image_order import ImageOrderItem, make_items
from mixed_image_order_ui import MixedImageGroup, MixedImageOrderDialog


class MixedImageOrderDialogTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = tk.Tk()
        cls.root.withdraw()

    @classmethod
    def tearDownClass(cls):
        cls.root.update_idletasks()
        cls.root.destroy()

    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory()
        self.addCleanup(self.scratch.cleanup)
        self.directory = Path(self.scratch.name)
        self.saved = Mock()

    def image(self, name, color="white"):
        path = self.directory / name
        path.parent.mkdir(parents=True, exist_ok=True)
        Image.new("RGB", (96, 56), color).save(path)
        return path

    def group(self, key="one", channel="all", product_count=2, detail_count=2):
        products = [self.image(f"{key}/product-{index}.png", "#77aadd") for index in range(product_count)]
        details = [self.image(f"details-{channel}/detail-{index}.png", "#eecc99") for index in range(detail_count)]
        items = make_items(products, details)
        return MixedImageGroup(key, channel, f"{key} / {channel}", list(items), list(items))

    def dialog(self, *groups):
        dialog = MixedImageOrderDialog(self.root, list(groups), self.saved)
        self.addCleanup(dialog.cancel)
        return dialog

    def tokens(self, dialog):
        return [item.token for item in dialog.current_items]

    def test_details_interleave_and_can_be_actual_main_without_mutating_input(self):
        group = self.group()
        initial = list(group.items)
        dialog = self.dialog(group)
        dialog.select(2)
        dialog.move_selected(-1)
        self.assertEqual([initial[0], initial[2], initial[1], initial[3]], dialog.current_items)
        dialog.select(3)
        dialog.set_as_main()
        self.assertEqual("detail", dialog.current_items[0].kind)
        self.assertEqual(initial[3], dialog.current_items[0])
        self.assertEqual(initial, group.items)
        self.assertIn("第一张实际上传", dialog.summary_var.get())
        self.assertIn("细节图", dialog.selection_var.get())
        self.saved.assert_not_called()

    def test_batch_layout_carries_positions_without_other_products_paths(self):
        first = self.group("first")
        second = self.group("second")
        dialog = self.dialog(first, second)
        dialog.select(2)
        dialog.move_selected(-1)
        dialog.apply_current_layout_to_all()
        self.assertEqual(self.tokens(dialog), [item.token for item in dialog.items_by_key[second.key]])
        second_paths = [item.path for item in dialog.items_by_key[second.key] if item.kind == "product"]
        self.assertEqual([item.path for item in second.items if item.kind == "product"], second_paths)
        self.assertTrue(all(path.parent.name == "second" for path in second_paths))
        self.assertEqual(self.tokens(dialog), dialog.layouts["all"])
        self.saved.assert_not_called()

    def test_white_and_black_layouts_remain_independent(self):
        first_white = self.group("first-white", "white", product_count=1)
        second_white = self.group("second-white", "white", product_count=1)
        black = self.group("first-black", "black", product_count=1)
        dialog = self.dialog(first_white, black, second_white)
        initial_black = list(black.items)
        dialog.select(2)
        dialog.move_to_first()
        dialog.apply_current_layout_to_all()
        self.assertEqual(initial_black, dialog.items_by_key[black.key])
        self.assertEqual(self.tokens(dialog), [item.token for item in dialog.items_by_key[second_white.key]])
        self.assertEqual({"white"}, set(dialog.layouts))
        dialog.select_group(1)
        self.assertEqual(initial_black, dialog.current_items)
        self.assertEqual(1, dialog.selector.current())

    def test_restore_resets_only_current_group_to_its_base_order(self):
        first = self.group("first")
        second = self.group("second")
        first.items = list(reversed(first.items))
        dialog = self.dialog(first, second)
        dialog.select_group(1)
        dialog.select(2)
        dialog.move_to_first()
        modified_second = list(dialog.current_items)
        dialog.select_group(0)
        dialog.restore_current_default()
        self.assertEqual(first.base_items, dialog.current_items)
        self.assertEqual(modified_second, dialog.items_by_key[second.key])
        self.assertEqual({}, dialog.layouts)

    def test_cancel_and_window_close_do_not_save(self):
        group = self.group()
        dialog = self.dialog(group)
        dialog.select(2)
        dialog.move_to_first()
        dialog.apply_current_layout_to_all()
        dialog.cancel()
        dialog.cancel()
        self.saved.assert_not_called()
        self.assertFalse(dialog.result)
        self.assertEqual(group.base_items, group.items)
        self.assertFalse(dialog.window.winfo_exists())

    def test_save_commits_all_group_orders_and_only_explicit_batch_layouts(self):
        first = self.group("first")
        second = self.group("second")
        dialog = self.dialog(first, second)
        dialog.select(3)
        dialog.move_to_first()
        expected = {group.key: [item.token for item in dialog.items_by_key[group.key]]
                    for group in (first, second)}
        self.assertTrue(dialog.save())
        self.saved.assert_called_once_with(expected, {})
        self.assertTrue(dialog.result)
        self.assertFalse(dialog.window.winfo_exists())

    def test_failed_save_keeps_dialog_and_working_order(self):
        dialog = self.dialog(self.group())
        dialog.select(2)
        dialog.move_to_first()
        expected = self.tokens(dialog)
        self.saved.side_effect = ValueError("模拟配置保存失败")
        with patch("mixed_image_order_ui.messagebox.showerror") as error:
            self.assertFalse(dialog.save())
        error.assert_called_once()
        self.assertTrue(dialog.window.winfo_exists())
        self.assertEqual(expected, self.tokens(dialog))
        self.assertFalse(dialog.result)
        self.saved.side_effect = None
        self.saved.return_value = False
        self.assertFalse(dialog.save())
        self.assertTrue(dialog.window.winfo_exists())

    def test_duplicate_basenames_keep_distinct_paths_and_thumbnails(self):
        product = self.image("product/same.png", "blue")
        detail = self.image("detail/same.png", "red")
        items = make_items([product], [detail])
        dialog = self.dialog(MixedImageGroup("one", "all", "商品", items, items))
        self.assertEqual(2, len(dialog.photos))
        self.assertNotEqual(items[0].token, items[1].token)
        dialog.select(0)
        self.assertEqual(str(product), dialog.path_var.get())
        dialog.select(1)
        self.assertEqual(str(detail), dialog.path_var.get())
        self.assertIn("细节图", dialog.selection_var.get())
        self.assertGreater(dialog.photos[0].width(), 1)

    def test_all_candidates_visible_and_limit_selection_updates_after_reordering(self):
        group = self.group(product_count=5, detail_count=3)
        group.limit = 5
        dialog = self.dialog(group)
        self.assertEqual(8, len(dialog.photos))
        self.assertEqual(8, len(dialog.cards.winfo_children()))
        self.assertIn("本次上传 5 张", dialog.summary_var.get())
        self.assertIn("未选 3 张", dialog.summary_var.get())
        self.assertIn("优先保留细节图", dialog.summary_var.get())
        first_detail = next(index for index, item in enumerate(dialog.current_items) if item.kind == "detail")
        dialog.select(first_detail)
        dialog.move_to_first()
        labels = [child.cget("text") for child in dialog.cards.winfo_children()[0].winfo_children()
                  if isinstance(child, tk.Label) and not child.cget("image")]
        self.assertTrue(any("上传第 1 张 · 主图" in text and "细节图" in text for text in labels))

    def test_short_screen_keeps_save_and_cancel_inside_window(self):
        self.root.deiconify()
        self.addCleanup(self.root.withdraw)
        with patch.object(tk.Toplevel, "winfo_screenheight", return_value=600):
            dialog = self.dialog(self.group())
        self.root.update()
        self.assertLessEqual(dialog.window.winfo_height(), 500)
        for button in (dialog.save_button, dialog.cancel_button, dialog.apply_button):
            bottom = button.winfo_rooty() + button.winfo_height()
            self.assertLessEqual(bottom, dialog.window.winfo_rooty() + dialog.window.winfo_height())
        self.assertGreater(dialog.canvas.winfo_height(), 60)


if __name__ == "__main__":
    unittest.main()
