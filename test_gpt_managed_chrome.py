"""Persistent multi-Chrome launch tests; no production accounts or queues."""
import http.client
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import threading
import unittest
from unittest.mock import Mock, patch

import backend
import gpt_browser_profiles as profiles
ENSURE_RUNTIME = profiles._ensure_runtime


class ManagedChromeTests(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.data = Path(self.temp.name) / 'data'
        self.data.mkdir()
        self.runtime = Path(self.temp.name) / 'runtime/chrome.exe'
        self.runtime.parent.mkdir()
        self.runtime.touch()
        self.addCleanup(patch.stopall)
        patch.object(profiles, '_testing_runtime', return_value=self.runtime).start()
        patch.object(profiles, '_ensure_runtime', return_value=self.runtime).start()
        patch.object(profiles, '_file_description', return_value='Google Chrome for Testing').start()
        profiles.LAST_OPENED.clear()

    def create(self, count=1, **body):
        return profiles.create_profiles(self.data, dict(count=count, **body))

    def rows(self):
        return profiles._profiles(self.data)

    def test_create_separate_blank_persistent_directories_and_fixed_workers(self):
        result = self.create(3)
        self.assertEqual(len(result['created']), 3)
        rows = self.rows()
        self.assertEqual(len({r['profile_path'] for r in rows}), 3)
        self.assertEqual(len({r['worker_id'] for r in rows}), 3)
        for row, public in zip(rows, result['created']):
            path = Path(row['profile_path'])
            self.assertEqual(list((path / 'Default').iterdir()), [])
            extension = path.parent / 'extension'
            config = (extension / 'config.js').read_text(encoding='utf-8')
            self.assertIn(json.dumps(row['worker_id']), config)
            manifest = json.loads((extension / 'manifest.json').read_text(encoding='utf-8'))
            self.assertEqual(manifest['background'], {'service_worker': 'service-worker.js'})
            self.assertNotIn('browser_specific_settings', manifest)
            self.assertTrue(public['extension_auto_load'])
            self.assertNotIn('profile_path', public)
        # More requests append with persistent identity and no fixed four/twelve cap.
        self.create(20)
        self.assertEqual(len(self.rows()), 23)
        self.assertEqual(self.rows()[:3], rows)

    def test_input_validation_does_not_accept_executables_paths_urls_or_bad_counts(self):
        for count in (0, -1, 21, '2', 1.5, True, None):
            with self.subTest(count=count), self.assertRaises(ValueError):
                self.create(count)
        for prefix in ('', 'a' * 41, 'a\n--bad', None):
            with self.subTest(prefix=prefix), self.assertRaises(ValueError):
                self.create(label_prefix=prefix)
        self.create(executable='C:/bad.exe', profile_path='C:/bad', url='https://bad.test')
        row = self.rows()[0]
        self.assertEqual(row['executable'], str(self.runtime))
        self.assertTrue(Path(row['profile_path']).is_relative_to(self.data))

    def test_missing_runtime_never_falls_back_to_regular_chrome(self):
        with patch.object(profiles, '_testing_runtime', return_value=None), \
                patch.object(profiles, '_ensure_runtime', side_effect=ValueError('Chrome for Testing unavailable')):
            self.assertFalse(profiles.creation_status()['available'])
            with self.assertRaisesRegex(ValueError, 'Chrome for Testing'):
                self.create()
        self.assertFalse((self.data / profiles.CONFIG_NAME).exists())

    def test_runtime_is_copied_independently_with_read_only_sandbox_permissions(self):
        source_marker = self.runtime.parent / 'chrome.dll'
        source_marker.write_bytes(b'runtime-original')
        with patch.object(profiles, 'ROOT', self.data), \
                patch.object(profiles, '_grant_runtime_read_access') as grant:
            executable = ENSURE_RUNTIME()
        self.assertEqual(executable, self.data / 'runtime/gpt-chrome/chrome-win64/chrome.exe')
        self.assertTrue(executable.is_file())
        self.assertEqual((executable.parent / 'chrome.dll').read_bytes(), b'runtime-original')
        self.assertEqual(source_marker.read_bytes(), b'runtime-original')
        grant.assert_called_once()
        self.assertNotEqual(grant.call_args.args[0], self.runtime.parent)

    def test_reserved_bulk_id_cannot_shadow_a_single_profile(self):
        self.create()
        rows = self.rows()
        rows[0]['id'] = 'chrome-all'
        profiles._save_profiles(self.data, rows)
        with self.assertRaises(ValueError):
            profiles.catalog(self.data)

    def test_catalog_reports_extension_on_disk_instead_of_creation_version(self):
        self.create()
        rows = self.rows()
        rows[0]['extension_version'] = '0.1.0'
        profiles._save_profiles(self.data, rows)
        manifest_path = Path(rows[0]['profile_path']).parent / 'extension/manifest.json'
        manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
        manifest['version'] = '0.4.99'
        manifest_path.write_text(json.dumps(manifest), encoding='utf-8')
        self.assertEqual(profiles.catalog(self.data)[0]['extension_version'], '0.4.99')
        manifest_path.write_text('invalid', encoding='utf-8')
        self.assertEqual(profiles.catalog(self.data)[0]['extension_version'], '')

    def test_failed_copy_rolls_back_only_new_folders_and_keeps_existing_profiles(self):
        self.create()
        config_before = (self.data / profiles.CONFIG_NAME).read_bytes()
        profile_before = Path(self.rows()[0]['profile_path'])
        marker = profile_before / 'Default/Cookies'
        marker.write_bytes(b'existing-login')
        with patch.object(profiles, '_sync_extension', side_effect=OSError('disk full')):
            with self.assertRaises(OSError):
                self.create(2)
        self.assertEqual((self.data / profiles.CONFIG_NAME).read_bytes(), config_before)
        self.assertEqual(marker.read_bytes(), b'existing-login')
        self.assertEqual(len(list((self.data / 'gpt-browser-profiles').iterdir())), 1)

    def test_launch_loads_extension_and_reopens_same_profile_without_mutating_cookies(self):
        self.create()
        row = self.rows()[0]
        marker = Path(row['profile_path']) / 'Default/Cookies'
        marker.write_bytes(b'login')
        with patch.object(profiles, '_chrome_process', return_value=None), \
                patch.object(profiles.subprocess, 'Popen') as spawn:
            spawn.return_value.wait.return_value = 0
            profiles.open_profile(self.data, row['id'])
            first = spawn.call_args.args[0]
            profiles.LAST_OPENED.clear()
            profiles.open_profile(self.data, row['id'])
            self.assertEqual(spawn.call_args.args[0], first)
            self.assertIn('--load-extension=' + str(Path(row['profile_path']).parent / 'extension'), first)
            self.assertIn('--user-data-dir=' + row['profile_path'], first)
            self.assertEqual(first[-1], profiles.CHATGPT_URL)
        self.assertEqual(marker.read_bytes(), b'login')

    def test_existing_running_profile_is_focused_without_copy_or_new_window(self):
        self.create()
        row = self.rows()[0]
        with patch.object(profiles, '_chrome_process', return_value=42), \
                patch.object(profiles, '_focus_window', return_value=True), \
                patch.object(profiles, '_sync_extension') as sync, \
                patch.object(profiles.subprocess, 'Popen') as spawn:
            result = profiles.open_profile(self.data, row['id'])
            self.assertTrue(result['already_running'])
            sync.assert_not_called()
            spawn.assert_not_called()

    def test_chrome_process_matches_exact_executable_profile_and_main_process(self):
        self.create()
        row = self.rows()[0]
        processes = [Mock(pid=1, info=dict(name='chrome.exe', exe=row['executable'], cmdline=['chrome.exe', '--user-data-dir=C:/other'])),
                     Mock(pid=2, info=dict(name='chrome.exe', exe=row['executable'], cmdline=['chrome.exe', '--type=renderer', '--user-data-dir='+row['profile_path']])),
                     Mock(pid=3, info=dict(name='chrome.exe', exe=row['executable'], cmdline=['chrome.exe', '--user-data-dir='+row['profile_path']]))]
        with patch.object(profiles.psutil, 'process_iter', return_value=processes):
            self.assertEqual(profiles._chrome_process(row), 3)

    def test_chrome_all_excludes_other_browser_profiles(self):
        self.create(2)
        rows = self.rows()
        rows.append(dict(id='firefox-old', label='Firefox-old', browser='firefox', executable='C:/firefox.exe', profile_path='C:/profile'))
        profiles._save_profiles(self.data, rows)
        with patch.object(profiles, '_open', return_value={'ok':True, 'message':'opened'}) as opened:
            result = profiles.open_profile(self.data, 'chrome-all')
        self.assertEqual(len(result['results']), 2)
        self.assertTrue(all(call.args[0]['browser'] == 'chrome' for call in opened.call_args_list))

    def test_managed_path_tampering_is_rejected(self):
        self.create()
        rows = self.rows()
        rows[0]['profile_path'] = str(self.data / 'outside')
        profiles._save_profiles(self.data, rows)
        with self.assertRaises(ValueError):
            profiles.catalog(self.data)

    def test_create_http_requires_local_origin_and_header(self):
        with patch.object(backend, 'DATA', self.data):
            server = backend.BoundedThreadingHTTPServer(('127.0.0.1', 0), backend.Handler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                def request(headers):
                    connection = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=3)
                    connection.request('POST', '/api/gpt-browser-profiles/create', body='{"count":2}',
                                       headers={'Content-Type':'application/json', **headers})
                    response = connection.getresponse()
                    result = response.status, json.loads(response.read())
                    connection.close()
                    return result
                self.assertEqual(request({})[0], 403)
                self.assertEqual(request({'X-Workbench':'local','Origin':'https://bad.test'})[0], 403)
                status, body = request({'X-Workbench':'local','Origin':'http://127.0.0.1:5173'})
                self.assertEqual(status, 200)
                self.assertEqual(len(body['created']), 2)
            finally:
                server.shutdown()
                server.server_close()
                thread.join(3)


if __name__ == '__main__':
    unittest.main()
