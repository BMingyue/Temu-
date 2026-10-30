import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch

import colleague_browser as browser


class ColleagueBrowserTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.source = self.base/'source'
        self.source.mkdir()
        (self.source/'manifest.json').write_text(json.dumps({'version':'0.20.11', 'background':{'service_worker':'worker.js','scripts':['worker.js']},'browser_specific_settings':{'gecko':{'id':'x'}}}))
        (self.source/'worker.js').write_text('/* fixture */')
        self.data = self.base/'data'
        self.exe = self.base/'runtime/chrome.exe'
        self.exe.parent.mkdir(); self.exe.touch()
        self.patches = [patch.object(browser,'EXTENSION',self.source),
                        patch.object(browser.browsers,'_ensure_runtime',return_value=self.exe),
                        patch.object(browser.browsers,'_testing_runtime',return_value=self.exe),
                        patch.object(browser.browsers,'_chrome_process',return_value=None)]
        for item in self.patches:
            item.start(); self.addCleanup(item.stop)
        browser.LAST_OPENED.clear()

    def test_blank_profile_auto_extension_and_repeat_click_guard(self):
        process = Mock(); process.wait.side_effect = subprocess.TimeoutExpired('fixture',.3)
        with patch.object(browser.subprocess,'Popen',return_value=process) as launch:
            result = browser.open_browser(self.data)
            self.assertTrue(result['ok'])
            self.assertFalse(result['already_running'])
            args = launch.call_args.args[0]
            self.assertIn('--user-data-dir='+str(self.data.resolve()/'collector-browser/user-data'),args)
            self.assertIn('--load-extension='+str(self.data.resolve()/'collector-browser/extension'),args)
            self.assertEqual(args[-1],browser.URL)
            self.assertFalse(any('remote-debugging' in x for x in args))
            manifest = json.loads((self.data/'collector-browser/extension/manifest.json').read_text())
            self.assertEqual(manifest['background'],{'service_worker':'worker.js'})
            self.assertNotIn('browser_specific_settings',manifest)
            self.assertEqual(list((self.data/'collector-browser/user-data').iterdir()),[])
            self.assertTrue(browser.open_browser(self.data)['already_requested'])
            self.assertEqual(launch.call_count,1)

    def test_running_browser_focuses_without_recopy_or_restart(self):
        with patch.object(browser.browsers,'_chrome_process',return_value=42), patch.object(browser.browsers,'_focus_window',return_value=True), patch.object(browser.subprocess,'Popen') as launch:
            self.assertTrue(browser.open_browser(self.data)['already_running'])
            launch.assert_not_called()
            self.assertFalse(self.data.exists())

    def test_status_reports_only_availability_and_source_version(self):
        result = browser.status(self.data)
        self.assertTrue(result['available'])
        self.assertFalse(result['running'])
        self.assertEqual(result['extension_version'],'0.20.11')
        self.assertFalse(self.data.exists())

    def test_failed_browser_exit_is_explained(self):
        process=Mock(); process.wait.return_value=12
        with patch.object(browser.subprocess,'Popen',return_value=process):
            with self.assertRaisesRegex(ValueError,'检查运行环境'):
                browser.open_browser(self.data)

    def test_selection_opens_a_tab_in_the_same_running_profile(self):
        with patch.object(browser.browsers,'_chrome_process',return_value=42), patch.object(browser.browsers,'_focus_window',return_value=True), patch.object(browser.subprocess,'Popen') as launch:
            result = browser.open_browser(self.data,'selection')
            self.assertTrue(result['already_running'])
            args = launch.call_args.args[0]
            self.assertEqual(args[-1],'https://www.temu.com/')
            self.assertIn('--new-tab',args)
            self.assertIn('--user-data-dir='+str(self.data.resolve()/'collector-browser/user-data'),args)
            self.assertFalse(self.data.exists())
            self.assertTrue(browser.open_browser(self.data,'selection')['already_requested'])
            self.assertEqual(launch.call_count,1)

    def test_arbitrary_urls_and_unknown_modes_are_rejected(self):
        for mode in ('https://example.com/', None, [], 'store --other'):
            with self.assertRaisesRegex(ValueError,'用途无效'):
                browser.open_browser(self.data,mode)
        self.assertFalse(self.data.exists())


if __name__=='__main__': unittest.main()
