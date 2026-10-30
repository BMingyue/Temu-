"""Visible upload alerts in real offline Chromium; no real site or deletion."""
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import MagicMock, patch

from playwright.sync_api import sync_playwright

import main
import tshirt_automation


class AlbumAlertBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.runtime = sync_playwright().start()
        cls.browser = cls.runtime.chromium.launch(
            executable_path=main.find_browser(main.AppConfig().browser_path), headless=True)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.runtime.stop()

    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        log_patch = patch.object(main, "LOG_DIR", self.root / "logs")
        log_patch.start()
        self.addCleanup(log_patch.stop)
        self.uploader = main.DxmUploader(main.AppConfig(album_cleanup_enabled=True,
            album_cleanup_batch_id="c" * 32), MagicMock(), threading.Event())
        self.context = self.browser.new_context(service_workers="block")
        self.addCleanup(self.context.close)
        self.requests = []

        def reject_requests(route):
            self.requests.append(route.request.url)
            route.abort()

        self.context.route("**/*", reject_requests)
        self.page = self.context.new_page()
        self.uploader.page = self.page
        self.page.set_content("<body></body>")

    def toast(self, text, class_name="", role="", style=""):
        self.page.evaluate("""({text, className, role, style}) => {
            document.body.replaceChildren();
            const node=document.createElement('div');
            node.textContent=text;
            node.className=className;
            if(role) node.setAttribute('role',role);
            node.setAttribute('style',style);
            document.body.append(node);
        }""", {"text": text, "className": class_name, "role": role, "style": style})

    def test_visible_role_alert_capacity_error_stops_before_any_submit(self):
        self.toast("上传失败：图片空间已满，请先清理图库", role="alert")
        self.uploader._publish_now = MagicMock()
        with self.assertRaises(main.AlbumSpaceError):
            self.uploader._check_album_upload_space()
            self.uploader._publish_now()
        self.uploader._publish_now.assert_not_called()
        self.assertEqual([], self.requests)

    def test_all_supported_notice_containers_surface_capacity_failure(self):
        for class_name in ("ant-message-notice-content", "ant-notification-notice-description",
                           "ant-modal-confirm-content"):
            with self.subTest(class_name=class_name):
                self.toast("图库剩余空间不足，图片上传失败", class_name=class_name)
                with self.assertRaises(main.AlbumSpaceError):
                    self.uploader._check_album_upload_space()
        self.assertEqual([], self.requests)

    def test_hidden_notice_or_hidden_parent_does_not_trigger_old_error(self):
        for style in ("display:none", "visibility:hidden"):
            with self.subTest(style=style):
                self.toast("图片空间已满", class_name="ant-message-notice-content", style=style)
                self.uploader._check_album_upload_space()
        self.page.set_content('<div style="display:none"><div role="alert">图库空间不足</div></div>')
        self.uploader._check_album_upload_space()
        self.page.set_content('<div style="visibility:hidden"><div role="alert">图库空间不足</div></div>')
        self.uploader._check_album_upload_space()
        self.assertEqual([], self.requests)

    def test_size_format_permission_and_generic_upload_errors_are_not_capacity_failures(self):
        for text in ("图片尺寸不足800×800", "图片大小超过10MB", "图片格式不支持，请上传JPG",
                     "图片上传失败，请重试", "没有图片管理权限", "图库上传失败：图片尺寸不足800×800",
                     "图库图片大小超过10MB，请压缩单张图片", "图片空间上传失败：单张图片尺寸超过12000像素"):
            with self.subTest(text=text):
                self.toast(text, class_name="ant-message-notice-content")
                self.uploader._check_album_upload_space()
        self.assertEqual([], self.requests)

    def test_plain_page_help_text_is_not_an_upload_notification(self):
        self.page.set_content('<p>图库空间不足时，请清理图片或扩容。</p>')
        self.uploader._check_album_upload_space()
        self.assertEqual([], self.requests)

    def test_disabled_guard_does_not_even_read_page_or_create_album_tab(self):
        self.toast("图库空间不足", role="alert")
        self.uploader.config.album_cleanup_enabled = False
        self.uploader._check_album_upload_space()
        with patch.object(self.page, "locator", side_effect=AssertionError("关闭开关应无页面读取")):
            self.uploader._check_album_upload_space()
        self.assertEqual(1, len(self.context.pages))
        self.assertEqual([], self.requests)

    def test_blanket_upload_wait_does_not_swallow_capacity_alert_inside_generic_except(self):
        self.toast("图片空间不足，上传失败", role="alert")
        self.page.locator("body").evaluate("el => el.insertAdjacentHTML('beforeend','<div id=carousel><div class=img-list></div></div>')")
        with self.assertRaises(main.AlbumSpaceError):
            self.uploader._wait_for_carousel_images(self.page.locator("#carousel"), 1)
        self.assertEqual([], self.requests)

    def test_tshirt_upload_wait_does_not_swallow_capacity_alert_or_advance(self):
        self.toast("图库空间已满", class_name="ant-message-notice-content")
        self.page.locator("body").evaluate("el => el.insertAdjacentHTML('beforeend','<div id=color><div class=image-box></div></div>')")
        with self.assertRaises(main.AlbumSpaceError):
            tshirt_automation._wait_color_images(self.uploader, self.page.locator("#color"), 1)
        self.assertEqual([], self.requests)

    def test_fill_converts_visible_alert_after_other_upload_exception_and_preserves_failure_flag(self):
        self.toast("图库空间不足", class_name="ant-notification-notice-description")
        self.uploader._protect_album_page_images = MagicMock()
        self.uploader._ensure_album_space = MagicMock()
        self.uploader._populate_job_fields = MagicMock(side_effect=main.AutomationError("上传未完成"))
        self.uploader._publish_now = MagicMock()
        with self.assertRaises(main.AlbumSpaceError):
            self.uploader._fill_job_fields(main.ProductJob(self.root, "Offline Product", []))
            self.uploader._publish_now()
        self.assertTrue(self.uploader._album_cleanup_suspended)
        self.assertFalse(self.uploader._album_protection_failed)
        self.uploader._protect_album_page_images.assert_any_call(strict=False)
        self.uploader._publish_now.assert_not_called()
        self.assertEqual([], self.requests)

    def test_fill_keeps_image_size_exception_type_when_no_capacity_alert_exists(self):
        self.toast("图片尺寸不足800×800", role="alert")
        self.uploader._protect_album_page_images = MagicMock()
        self.uploader._ensure_album_space = MagicMock()
        original = main.AutomationError("图片尺寸核对失败")
        self.uploader._populate_job_fields = MagicMock(side_effect=original)
        with self.assertRaises(main.AutomationError) as caught:
            self.uploader._fill_job_fields(main.ProductJob(self.root, "Offline Product", []))
        self.assertIs(original, caught.exception)
        self.assertNotIsInstance(caught.exception, main.AlbumSpaceError)
        self.assertTrue(self.uploader._album_cleanup_suspended)
        self.assertFalse(self.uploader._album_protection_failed)
        self.assertEqual([], self.requests)


if __name__ == "__main__":
    unittest.main()
