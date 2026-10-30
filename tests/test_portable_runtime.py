import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import main
import portable_runtime


class PortableConfigurationTests(unittest.TestCase):
    def setUp(self):
        scratch = tempfile.TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        self.directory = Path(scratch.name)
        self.config = self.directory / "config.json"
        config_patch = patch.object(main, "CONFIG_PATH", self.config)
        config_patch.start()
        self.addCleanup(config_patch.stop)

    def test_new_colleague_gets_empty_settings_and_review_mode(self):
        config = main.AppConfig.load()
        self.assertEqual("", config.template_url)
        self.assertEqual("", config.product_root)
        self.assertEqual("", config.browser_path)
        self.assertEqual([], config.common_detail_images)
        self.assertEqual("review", config.publish_mode)
        self.assertEqual(1, config.concurrent_pages)

    def test_invalid_config_is_preserved_without_resetting_listing_history(self):
        state = self.directory / "state.json"
        original_state = '{"completed":{"sample":true}}'
        state.write_text(original_state)
        self.config.write_text("{broken", encoding="utf-8")
        warnings = portable_runtime.validate_config()
        self.assertEqual(1, len(warnings))
        backups = list(self.directory.glob("config.invalid-*.json"))
        self.assertEqual("{broken", backups[0].read_text())
        self.assertFalse(self.config.exists())
        self.assertEqual(original_state, state.read_text())

    def test_non_object_or_invalid_types_are_recoverable(self):
        for data in ([], {"concurrent_pages": "3"}, {"publish_mode": "bad"},
                     {"common_detail_images": [123]}, {"operation_timeout_seconds": 0}):
            with self.subTest(data=data):
                self.config.write_text(json.dumps(data), encoding="utf-8")
                self.assertEqual(1, len(portable_runtime.validate_config()))

    def test_utf8_bom_and_existing_personal_settings_survive_restart(self):
        config = main.AppConfig(product_root="D:/同事 素材", template_url="https://www.dianxiaomi.com/web/popTemu/quoteEdit?id=1", concurrent_pages=2)
        config.save()
        self.config.write_text(self.config.read_text(encoding="utf-8"), encoding="utf-8-sig")
        self.assertEqual([], portable_runtime.validate_config())
        reloaded = main.AppConfig.load()
        self.assertEqual(config, reloaded)
        self.assertFalse(self.config.with_suffix(".json.tmp").exists())

    def test_bundled_browser_has_priority_over_machine_installations(self):
        with tempfile.TemporaryDirectory() as bundle:
            path = Path(bundle) / "browser/chrome.exe"
            path.parent.mkdir()
            path.write_bytes(b"test")
            with patch.object(main.sys, "_MEIPASS", bundle, create=True):
                self.assertEqual(str(path), main.find_browser())


if __name__ == "__main__":
    unittest.main()
