import tkinter as tk
import unittest

from image_processing import ImageProcessingOptions
from image_processing_ui import ImageProcessingPanel, MODE_LABELS


class ImageProcessingPanelTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = tk.Tk()
        cls.root.withdraw()

    @classmethod
    def tearDownClass(cls):
        cls.root.update_idletasks()
        cls.root.destroy()

    def setUp(self):
        self.panel = ImageProcessingPanel(self.root, ImageProcessingOptions())
        self.panel.pack()
        self.addCleanup(self.panel.destroy)

    def choose(self, mode):
        self.panel.mode_selector.set(MODE_LABELS[mode])
        self.panel.mode_selector.event_generate("<<ComboboxSelected>>")
        self.root.update_idletasks()

    def test_original_hides_dimensions_and_preserves_previous_custom_sizes(self):
        expected = ImageProcessingOptions(mode="square", width=1100, height=1500, max_edge=1800)
        self.panel.set_options(expected)
        self.assertEqual("pack", self.panel.square_controls.winfo_manager())
        self.choose("original")
        self.assertEqual("", self.panel.fit_controls.winfo_manager())
        self.assertEqual("", self.panel.square_controls.winfo_manager())
        self.assertEqual(ImageProcessingOptions(mode="original", width=1100, height=1500, max_edge=1800),
                         self.panel.get_options())
        self.assertIn("原文件", self.panel.note_var.get())
        self.assertIn("店小秘", self.panel.note_var.get())
        self.choose("square")
        self.assertEqual(expected, self.panel.get_options())

    def test_fit_exposes_only_longest_edge_and_retains_rectangle_dimensions(self):
        self.panel.set_options(ImageProcessingOptions(width=900, height=1400, max_edge=1600))
        self.choose("fit")
        self.assertEqual("pack", self.panel.fit_controls.winfo_manager())
        self.assertEqual("", self.panel.square_controls.winfo_manager())
        self.panel.max_edge_var.set(" 2000 ")
        self.assertEqual(ImageProcessingOptions(mode="fit", width=900, height=1400, max_edge=2000),
                         self.panel.get_options())
        self.assertIn("不放大", self.panel.note_var.get())
        self.assertIn("不补白", self.panel.note_var.get())

    def test_custom_rectangular_dimensions_and_presets(self):
        self.choose("square")
        self.panel.width_var.set("1080")
        self.panel.height_var.set("1440")
        self.assertEqual(1080, self.panel.get_options().width)
        self.assertEqual(1440, self.panel.get_options().height)
        self.assertEqual(("800", "1200", "1600"), self.panel.width_input.cget("values"))
        self.assertIn("不裁剪", self.panel.note_var.get())

    def test_invalid_text_and_out_of_range_values_fail_without_mutation(self):
        for mode, variable in (("square", self.panel.width_var), ("square", self.panel.height_var),
                               ("fit", self.panel.max_edge_var)):
            self.choose(mode)
            saved = variable.get()
            for bad in ("", "abc", "1200.5", "1e3", "-200", "199", "4001", "１２００"):
                with self.subTest(field=str(variable), value=bad):
                    variable.set(bad)
                    with self.assertRaises(ValueError):
                        self.panel.get_options()
                    self.assertEqual(bad, variable.get())
            variable.set(saved)

    def test_set_options_is_atomic_and_restores_all_values(self):
        expected = ImageProcessingOptions(mode="fit", width=350, height=4000, max_edge=200)
        self.panel.set_options(expected)
        self.assertEqual(expected, self.panel.get_options())
        with self.assertRaises(ValueError):
            self.panel.set_options(ImageProcessingOptions(mode="unknown", width=800, height=800))
        self.assertEqual(expected, self.panel.get_options())
        with self.assertRaises(ValueError):
            self.panel.set_options(ImageProcessingOptions(mode="fit", max_edge=100))
        self.assertEqual(expected, self.panel.get_options())

    def test_unused_invalid_sizes_do_not_block_original_or_fit(self):
        self.panel.set_options(ImageProcessingOptions(width=900, height=1400, max_edge=1600))
        self.panel.width_var.set("not a size")
        self.choose("original")
        self.assertEqual(ImageProcessingOptions(mode="original", width=900, height=1400, max_edge=1600),
                         self.panel.get_options())
        self.choose("fit")
        self.assertEqual("fit", self.panel.get_options().mode)
        self.choose("square")
        with self.assertRaises(ValueError):
            self.panel.get_options()
        self.assertEqual("not a size", self.panel.width_var.get())

    def test_switch_modes_does_not_reset_unrelated_values_or_require_a_callback(self):
        expected = ImageProcessingOptions(mode="square", width=777, height=999, max_edge=1555)
        self.panel.set_options(expected)
        for mode in ("fit", "original", "square", "original", "fit", "square"):
            self.choose(mode)
            obtained = self.panel.get_options()
            self.assertEqual((777, 999, 1555), (obtained.width, obtained.height, obtained.max_edge))
            self.assertEqual(mode, obtained.mode)

    def test_invalid_mode_is_rejected_by_get_options(self):
        self.panel.mode_var.set("unknown")
        with self.assertRaises(ValueError):
            self.panel.get_options()

    def test_panel_has_compact_two_row_height(self):
        self.root.update_idletasks()
        self.assertLessEqual(self.panel.winfo_reqheight(), 76)
        self.assertLessEqual(self.panel.winfo_reqwidth(), 850)


if __name__ == "__main__":
    unittest.main()
