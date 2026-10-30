import tempfile
import tkinter as tk
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from PIL import Image

import color_detail_ui as ui


class ColorDetailPanelTests(unittest.TestCase):
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
        self.changed = Mock()
        self.panel = ui.ColorDetailPanel(self.root, [], [], self.changed)
        self.addCleanup(self.panel.destroy)
        error_patch = patch.object(ui.messagebox, "showerror")
        self.error = error_patch.start()
        self.addCleanup(error_patch.stop)

    def image(self, name):
        path = self.directory / name
        path.parent.mkdir(parents=True, exist_ok=True)
        Image.new("RGB", (50, 30), "white").save(path)
        return str(path.resolve())

    def select(self, color, *paths):
        with patch.object(ui.filedialog, "askopenfilenames", return_value=paths):
            self.panel.add_images(color)

    def test_batches_append_naturally_while_preserving_existing_manual_order(self):
        one = self.image("white/1.jpg")
        two = self.image("white/2.jpg")
        self.select("white", two, one)
        self.assertEqual([one, two], self.panel.get_paths("white"))
        self.panel.set_paths("white", [two, one])
        new_two = self.image("other/2.png")
        new_ten = self.image("other/10.png")
        self.select("white", new_ten, new_two)
        self.assertEqual([two, one, new_two, new_ten], self.panel.get_paths("white"))
        self.assertEqual([], self.panel.get_paths("black"))
        self.error.assert_not_called()

    def test_duplicate_full_paths_are_ignored_but_same_name_different_folder_survives(self):
        first = self.image("one/detail.png")
        second = self.image("two/detail.png")
        equivalent = str(Path(first).parent / ".." / "one" / "detail.png")
        self.select("white", first)
        self.select("white", first.upper(), equivalent, second, second)
        self.assertEqual([first, second], self.panel.get_paths("white"))
        self.assertEqual(2, self.changed.call_count)
        self.select("white", equivalent)
        self.assertEqual(2, self.changed.call_count)

    def test_groups_have_separate_nine_image_capacity_and_may_share_size_chart(self):
        white = [self.image(f"white/{index}.png") for index in range(9)]
        black = [self.image(f"black/{index}.png") for index in range(8)]
        self.select("white", *white)
        self.select("black", white[0], *black)
        self.assertEqual(9, len(self.panel.get_paths("white")))
        self.assertEqual(9, len(self.panel.get_paths("black")))
        previous = self.panel.get_paths("white")
        self.changed.reset_mock()
        self.select("white", self.image("overflow.png"))
        self.assertEqual(previous, self.panel.get_paths("white"))
        self.assertEqual(9, len(self.panel.get_paths("black")))
        self.changed.assert_not_called()
        self.error.assert_called_once()

    def test_overflow_rejects_entire_batch(self):
        self.panel.maximum = 2
        first = self.image("first.jpg")
        self.select("black", first)
        self.changed.reset_mock()
        self.select("black", self.image("second.jpg"), self.image("third.jpg"))
        self.assertEqual([first], self.panel.get_paths("black"))
        self.changed.assert_not_called()

    def test_bad_extension_or_missing_path_rejects_entire_batch(self):
        existing = self.image("first.png")
        valid = self.image("valid.png")
        unsupported = self.directory / "text.txt"
        unsupported.write_text("not an image")
        self.select("white", existing)
        self.changed.reset_mock()
        for invalid in (str(unsupported), str(self.directory / "missing.png")):
            with self.subTest(invalid=invalid):
                self.select("white", valid, invalid)
                self.assertEqual([existing], self.panel.get_paths("white"))
                self.changed.assert_not_called()
        self.assertEqual(2, self.error.call_count)

    def test_cancel_empty_clear_and_duplicate_batch_do_not_callback(self):
        self.select("white")
        self.panel.clear("black")
        self.changed.assert_not_called()
        existing = self.image("first.png")
        self.select("white", existing)
        self.changed.reset_mock()
        self.select("white")
        self.select("white", existing)
        self.changed.assert_not_called()
        self.panel.clear("white")
        self.changed.assert_called_once_with("white", [])

    def test_state_and_callback_lists_are_detached_and_restore_does_not_callback(self):
        first = self.image("first.png")
        restored = [first]
        self.panel.set_paths("white", restored)
        restored.clear()
        self.changed.assert_not_called()
        obtained = self.panel.get_paths("white")
        obtained.clear()
        self.assertEqual([first], self.panel.get_paths("white"))
        second = self.image("second.png")
        self.select("white", second)
        self.changed.call_args.args[1].clear()
        self.assertEqual([first, second], self.panel.get_paths("white"))

    def test_preview_can_move_remove_and_save_one_color_only(self):
        first = self.image("first.png")
        second = self.image("second.png")
        third = self.image("third.png")
        black = self.image("black.png")
        self.panel.set_paths("white", [first, second, third])
        self.panel.set_paths("black", [black])
        preview = self.panel.show_preview("white")
        self.assertEqual(3, len(preview.photos))
        preview.select(2)
        preview.move_selected(-1)
        preview.select(0)
        preview.remove_selected()
        self.assertEqual([first, second, third], self.panel.get_paths("white"))
        self.assertTrue(preview.save())
        self.assertEqual([third, second], self.panel.get_paths("white"))
        self.assertEqual([black], self.panel.get_paths("black"))
        self.changed.assert_called_once_with("white", [third, second])

    def test_preview_cancel_keeps_original_state_and_save_unchanged_has_no_callback(self):
        first = self.image("first.png")
        second = self.image("second.png")
        self.panel.set_paths("black", [first, second])
        preview = self.panel.show_preview("black")
        preview.move_selected(1)
        preview.cancel()
        self.assertEqual([first, second], self.panel.get_paths("black"))
        self.changed.assert_not_called()
        preview = self.panel.show_preview("black")
        self.assertTrue(preview.save())
        self.changed.assert_not_called()

    def test_missing_saved_file_can_be_removed_in_preview_without_preventing_startup(self):
        missing = str(self.directory / "missing.png")
        existing = self.image("first.png")
        self.panel.set_paths("white", [missing, existing])
        preview = self.panel.show_preview("white")
        self.assertFalse(preview.save())
        self.assertEqual([missing, existing], self.panel.get_paths("white"))
        preview.remove_selected()
        self.assertTrue(preview.save())
        self.assertEqual([existing], self.panel.get_paths("white"))


if __name__ == "__main__":
    unittest.main()
