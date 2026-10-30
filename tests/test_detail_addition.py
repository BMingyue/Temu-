import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import main


class CommonDetailAdditionTests(unittest.TestCase):
    def setUp(self):
        scratch = tempfile.TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        self.directory = Path(scratch.name)
        self.config_path = self.directory / "config.json"
        config_patch = patch.object(main, "CONFIG_PATH", self.config_path)
        config_patch.start()
        self.addCleanup(config_patch.stop)
        error_patch = patch.object(main.messagebox, "showerror")
        self.showerror = error_patch.start()
        self.addCleanup(error_patch.stop)

        # Exercise the real selection and config-saving code without creating Tk windows.
        self.app = main.UploaderApp.__new__(main.UploaderApp)
        self.app.config = main.AppConfig()
        self.app.common_detail_paths = []
        self.app.path_var = Mock()
        self.app.path_var.get.return_value = str(self.directory)
        self.app.url_var = Mock()
        self.app.url_var.get.return_value = ""
        self.app.mode_var = Mock()
        self.app.mode_var.get.return_value = "review"
        self.app.status_var = Mock()
        self.app.common_detail_summary_var = Mock()

    def image(self, relative):
        path = self.directory / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.touch()
        return str(path.resolve())

    def select(self, *paths):
        with patch.object(main.filedialog, "askopenfilenames", return_value=paths):
            self.app._choose_common_detail_images()

    def test_repeated_batches_append_in_natural_order_and_keep_manual_order(self):
        first = self.image("first/1.jpg")
        second = self.image("first/2.jpg")
        self.select(second, first)
        self.assertEqual([first, second], self.app.common_detail_paths)

        # Simulate the user moving the second image to the front in preview/sort.
        self.app.common_detail_paths = [second, first]
        new_two = self.image("another/2.png")
        new_ten = self.image("another/10.png")
        self.select(new_ten, new_two)

        expected = [second, first, new_two, new_ten]
        self.assertEqual(expected, self.app.common_detail_paths)
        self.assertEqual(expected, main.AppConfig.load().common_detail_images)
        self.showerror.assert_not_called()

    def test_cancel_preserves_existing_list_config_and_status(self):
        existing = self.image("first/1.jpg")
        self.select(existing)
        saved_config = self.config_path.read_bytes()
        original_list = self.app.common_detail_paths
        self.app.status_var.reset_mock()
        self.app.common_detail_summary_var.reset_mock()

        self.select()

        self.assertIs(original_list, self.app.common_detail_paths)
        self.assertEqual(saved_config, self.config_path.read_bytes())
        self.app.status_var.set.assert_not_called()
        self.app.common_detail_summary_var.set.assert_not_called()
        self.showerror.assert_not_called()

    def test_full_path_duplicates_including_case_are_ignored(self):
        existing = self.image("first/1.jpg")
        self.select(existing)
        equivalent = str(Path(existing).parent / ".." / "first" / "1.jpg")
        new_image = self.image("first/2.jpg")

        self.select(existing.upper(), equivalent, new_image, new_image)

        self.assertEqual([existing, new_image], self.app.common_detail_paths)
        self.assertEqual([existing, new_image], main.AppConfig.load().common_detail_images)
        self.showerror.assert_not_called()

    def test_same_filename_from_different_folders_is_added(self):
        first = self.image("first/detail.png")
        second = self.image("second/detail.png")
        self.select(first)
        self.select(second)

        self.assertEqual([first, second], self.app.common_detail_paths)
        self.showerror.assert_not_called()

    def test_overflow_rejects_whole_new_batch_and_preserves_manual_order(self):
        self.app.config.max_images = 4
        first = self.image("first/1.jpg")
        second = self.image("first/2.jpg")
        self.select(first, second)
        self.app.common_detail_paths = [second, first]
        self.app._current_config()
        saved_config = self.config_path.read_bytes()
        original_list = self.app.common_detail_paths
        self.app.status_var.reset_mock()

        self.select(self.image("second/1.jpg"), self.image("second/2.jpg"))

        self.assertIs(original_list, self.app.common_detail_paths)
        self.assertEqual([second, first], self.app.common_detail_paths)
        self.assertEqual(saved_config, self.config_path.read_bytes())
        self.app.status_var.set.assert_not_called()
        self.showerror.assert_called_once()
        self.assertIn("已有 2 张，本次新增 2 张，合计 4 张", self.showerror.call_args.args[1])

    def test_limit_is_applied_after_ignoring_duplicates(self):
        self.app.config.max_images = 3
        first = self.image("first/1.jpg")
        second = self.image("first/2.jpg")
        self.select(first)
        self.select(first, second, second)
        self.select(second)

        self.assertEqual([first, second], self.app.common_detail_paths)
        self.assertEqual([first, second], main.AppConfig.load().common_detail_images)
        self.showerror.assert_not_called()

    def test_unsupported_file_rejects_whole_batch_without_partial_addition(self):
        existing = self.image("first/1.jpg")
        self.select(existing)
        saved_config = self.config_path.read_bytes()

        self.select(self.image("second/1.png"), self.image("second/2.txt"))

        self.assertEqual([existing], self.app.common_detail_paths)
        self.assertEqual(saved_config, self.config_path.read_bytes())
        self.showerror.assert_called_once()

    def test_no_detail_capacity_keeps_existing_empty_list(self):
        self.app.config.max_images = 1
        self.select(self.image("first/1.jpg"))

        self.assertEqual([], self.app.common_detail_paths)
        self.assertFalse(self.config_path.exists())
        self.showerror.assert_called_once()


if __name__ == "__main__":
    unittest.main()
