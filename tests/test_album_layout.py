"""Real Tk layout checks with isolated settings; no browser or account access."""
import tempfile
from pathlib import Path
import unittest
from unittest.mock import patch

import main


class AlbumLayoutTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        directory = Path(temporary.name)
        values = dict(APP_DIR=directory, CONFIG_PATH=directory / "config.json",
                      STATE_PATH=directory / "state.json", LOG_DIR=directory / "logs",
                      PROFILE_DIR=directory / "profile", FAILURE_DIR=directory / "failed",
                      UPLOAD_STAGE_DIR=directory / "stage")
        directories = patch.multiple(main, **values)
        directories.start()
        self.addCleanup(directories.stop)
        self.config = main.AppConfig(
            listing_profile="tshirt_bw", article_name="tshirt",
            album_cleanup_enabled=True,
            white_detail_images=[str(directory / "white" / (f"{index}-很长的白色商品细节图片名称用于布局检查.png"))
                                 for index in range(9)],
            black_detail_images=[str(directory / "black" / (f"{index}-很长的黑色商品细节图片名称用于布局检查.png"))
                                 for index in range(9)],
        )
        with patch.object(main.AppConfig, "load", return_value=self.config):
            self.app = main.UploaderApp()
        self.addCleanup(self.destroy_app)
        self.app.root.geometry("820x620+40+40")
        self.app.root.update()

    def destroy_app(self):
        # Cancel this isolated app's periodic callbacks before its interpreter
        # is destroyed; they must not leak into the next real Tk test window.
        for callback in self.app.root.tk.call("after", "info"):
            self.app.root.after_cancel(callback)
        self.app.root.destroy()

    def inside(self, widget):
        root = self.app.root
        top = widget.winfo_rooty() - root.winfo_rooty()
        return widget.winfo_ismapped() and top >= 0 and top + widget.winfo_height() <= root.winfo_height()

    def test_smallest_window_keeps_controls_status_log_and_support_visible(self):
        for name in ("scan_button", "start_button", "stop_button", "retry_failed_button",
                     "status_label", "log_box", "support_toolbar"):
            with self.subTest(widget=name):
                self.assertTrue(self.inside(getattr(self.app, name)))
        self.assertGreaterEqual(self.app.log_box.winfo_height(), 80)
        self.assertEqual((820, 620), (self.app.root.winfo_width(), self.app.root.winfo_height()))
        self.assertEqual((820, 620), self.app.root.minsize())
        self.assertGreater(self.app.settings_frame.winfo_height(), self.app.settings_canvas.winfo_height())
        self.assertEqual(self.app.settings_canvas.winfo_width(), self.app.settings_frame.winfo_width())

    def test_settings_scroll_to_bottom_without_moving_fixed_task_controls(self):
        before = self.app.start_button.winfo_rooty(), self.app.log_box.winfo_rooty()
        self.app.settings_canvas.yview_moveto(1)
        self.app.root.update()
        self.assertAlmostEqual(1.0, self.app.settings_canvas.yview()[1])
        self.assertGreater(self.app.settings_canvas.yview()[0], 0)
        bottom_note = self.app.settings_frame.grid_slaves(row=8)[0]
        viewport_top = self.app.settings_canvas.winfo_rooty()
        self.assertGreaterEqual(bottom_note.winfo_rooty(), viewport_top)
        self.assertLessEqual(bottom_note.winfo_rooty() + bottom_note.winfo_height(),
                             viewport_top + self.app.settings_canvas.winfo_height())
        self.assertEqual(before, (self.app.start_button.winfo_rooty(), self.app.log_box.winfo_rooty()))
        self.assertTrue(self.inside(self.app.support_toolbar))

    def test_mousewheel_over_threshold_scrolls_settings_without_changing_threshold(self):
        self.app.settings_canvas.yview_moveto(0)
        self.app.root.update()
        self.app.album_cleanup_panel.threshold_input.event_generate("<MouseWheel>", delta=-120)
        self.app.root.update()
        self.assertGreater(self.app.settings_canvas.yview()[0], 0)
        self.assertEqual((True, 100), self.app.album_cleanup_panel.get_settings())

    def test_keyboard_focus_reveals_a_setting_below_viewport(self):
        self.app.settings_canvas.yview_moveto(0)
        mode_frame = self.app.settings_frame.grid_slaves(row=7, column=1)[0]
        field = mode_frame.winfo_children()[-1]
        field.focus_force()
        self.app.root.update()
        top = self.app.settings_canvas.winfo_rooty()
        self.assertGreaterEqual(field.winfo_rooty(), top)
        self.assertLessEqual(field.winfo_rooty() + field.winfo_height(),
                             top + self.app.settings_canvas.winfo_height())
        self.assertTrue(self.inside(self.app.log_box))

    def test_resizing_and_switching_profiles_reflows_settings_and_preserves_values(self):
        self.app.root.geometry("920x720+40+40")
        self.app.root.update()
        self.assertGreaterEqual(self.app.log_box.winfo_height(), 80)
        large_fraction = self.app.settings_canvas.yview()[1] - self.app.settings_canvas.yview()[0]
        self.app.root.geometry("820x620+40+40")
        self.app.root.update()
        small_fraction = self.app.settings_canvas.yview()[1] - self.app.settings_canvas.yview()[0]
        self.assertGreater(large_fraction, small_fraction)
        self.app.profile_var.set("blanket")
        self.app._update_profile_controls()
        self.app.root.update()
        self.assertGreaterEqual(self.app.log_box.winfo_height(), 80)
        self.assertEqual(9, len(self.app.color_detail_panel.get_paths("white")))
        self.assertEqual(9, len(self.app.color_detail_panel.get_paths("black")))
        self.assertEqual((True, 100), self.app.album_cleanup_panel.get_settings())
        self.app.profile_var.set("tshirt_bw")
        self.app._update_profile_controls()
        self.app.root.update()
        self.assertTrue(self.inside(self.app.start_button))
        self.assertTrue(self.inside(self.app.support_toolbar))


if __name__ == "__main__":
    unittest.main()
