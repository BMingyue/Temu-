import tkinter as tk
import unittest

from album_cleanup_ui import AlbumCleanupPanel, THRESHOLD_PRESETS


class AlbumCleanupPanelTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = tk.Tk()
        cls.root.withdraw()

    @classmethod
    def tearDownClass(cls):
        cls.root.update_idletasks()
        cls.root.destroy()

    def setUp(self):
        self.panel = AlbumCleanupPanel(self.root)
        self.panel.pack(fill="x")
        self.addCleanup(self.panel.destroy)

    def test_feature_defaults_off_with_100_mb_threshold(self):
        self.assertEqual((False, 100), self.panel.get_settings())
        self.assertTrue(self.panel.threshold_input.instate(["disabled"]))
        self.assertEqual(tuple(map(str, THRESHOLD_PRESETS)),
                         self.panel.threshold_input.cget("values"))

    def test_checkbox_and_programmatic_switch_enable_threshold_input(self):
        self.panel.enabled_input.invoke()
        self.assertEqual((True, 100), self.panel.get_settings())
        self.assertFalse(self.panel.threshold_input.instate(["disabled"]))
        self.panel.enabled_var.set(False)
        self.assertEqual((False, 100), self.panel.get_settings())
        self.assertTrue(self.panel.threshold_input.instate(["disabled"]))

    def test_presets_and_custom_integer_thresholds_are_valid(self):
        self.panel.enabled_var.set(True)
        for value in ("50", " 135 ", "200", "300", "500", "2000"):
            with self.subTest(value=value):
                self.panel.threshold_var.set(value)
                self.assertEqual((True, int(value)), self.panel.get_settings())
                self.assertEqual(value, self.panel.threshold_var.get())

    def test_active_invalid_threshold_has_chinese_error_without_mutation(self):
        self.panel.enabled_var.set(True)
        for value in ("", "abc", "49", "2001", "100.5", "1e2", "-100", "１００", "True"):
            with self.subTest(value=value):
                self.panel.threshold_var.set(value)
                with self.assertRaisesRegex(ValueError, "图库清理阈值.*50.*2000.*整数"):
                    self.panel.get_settings()
                self.assertEqual(value, self.panel.threshold_var.get())

    def test_disabled_invalid_input_uses_last_valid_and_remains_editable_later(self):
        self.panel.threshold_var.set("unfinished")
        self.assertEqual((False, 100), self.panel.get_settings())
        self.panel.set_settings(True, 275)
        self.panel.threshold_var.set("unfinished")
        self.panel.enabled_var.set(False)
        self.assertEqual((False, 275), self.panel.get_settings())
        self.assertEqual("unfinished", self.panel.threshold_var.get())
        self.panel.enabled_var.set(True)
        with self.assertRaises(ValueError):
            self.panel.get_settings()
        self.panel.threshold_var.set("150")
        self.assertEqual((True, 150), self.panel.get_settings())

    def test_set_settings_restores_threshold_and_switch_and_rejects_active_invalid_atomically(self):
        self.panel.set_settings(True, 500)
        self.assertEqual((True, 500), self.panel.get_settings())
        for enabled, threshold in ((True, 0), (True, 100.5), (True, True), ("no", 200)):
            with self.subTest(enabled=enabled, threshold=threshold):
                with self.assertRaises(ValueError):
                    self.panel.set_settings(enabled, threshold)
                self.assertEqual((True, 500), self.panel.get_settings())
        self.panel.set_settings(False, "missing")
        self.assertEqual((False, 500), self.panel.get_settings())
        self.assertTrue(self.panel.threshold_input.instate(["disabled"]))
        self.panel.set_settings(True, 300)
        self.assertEqual((True, 300), self.panel.get_settings())

    def test_panel_stays_compact_and_keeps_cleanup_scope_and_irreversible_notice_visible(self):
        self.root.update_idletasks()
        self.assertLessEqual(self.panel.winfo_reqheight(), 90)
        self.assertLessEqual(self.panel.winfo_reqwidth(), 850)
        texts = [str(widget.cget("text")) for widget in self.panel.winfo_children()
                 if widget.winfo_class() == "TLabel"]
        combined = "\n".join(texts)
        self.assertIn("每页300张，最多清理末两页", combined)
        self.assertIn("跳过锁定和本批次使用的图", combined)
        self.assertIn("单工作页", combined)
        self.assertIn("删除不可恢复", combined)
        self.assertIn("待发布商品", combined)


if __name__ == "__main__":
    unittest.main()
