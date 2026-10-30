import json
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent
EXTENSION = ROOT / "browser_extension"


class FirefoxExtensionTests(unittest.TestCase):
    def test_manifest_has_cross_browser_background_and_gecko_identity(self):
        manifest = json.loads((EXTENSION / "manifest.json").read_text(encoding="utf-8"))
        background = manifest["background"]
        self.assertEqual(background["service_worker"], "service-worker.js")
        self.assertIn("service-worker.js", background["scripts"])
        self.assertEqual(
            manifest["browser_specific_settings"]["gecko"]["id"],
            "temu-workbench@cutemomomo.local",
        )

    def test_firefox_background_does_not_call_importscripts_in_document_context(self):
        worker = (EXTENSION / "service-worker.js").read_text(encoding="utf-8")
        self.assertIn("typeof importScripts === \"function\"", worker)

    def test_firefox_packaging_and_policy_helpers_exist(self):
        self.assertTrue((ROOT / "release" / "package_firefox_extension.py").is_file())
        installer = (ROOT / "release" / "install-firefox-workbench.ps1").read_text(encoding="utf-8")
        self.assertIn("ExtensionSettings", installer)
        self.assertIn("normal_installed", installer)
        self.assertNotIn("xpinstall.signatures.required", installer)

    def test_gpt_helper_uses_page_blob_download_fallback_for_firefox(self):
        content = (ROOT / "gpt_chrome_extension" / "content.js").read_text(encoding="utf-8")
        self.assertIn("async function downloadPageBlob", content)
        self.assertIn("blob:https:\\/\\/chatgpt\\.com", content)
        self.assertIn("link.download='workbench-'", content)
        self.assertIn("if(await downloadPageBlob(task,index,source))return true", content)


if __name__ == "__main__":
    unittest.main()
