import http.client
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import threading
import unittest
from unittest.mock import Mock, patch

import backend
import gpt_browser_profiles as profiles


class BrowserProfileTests(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.data = Path(self.temp.name)
        self.rows = []
        for ident, browser in [('chrome-a', 'chrome'), ('chrome-b', 'chrome'),
                               ('firefox-a', 'firefox'), ('firefox-b', 'firefox')]:
            exe = self.data / browser / profiles.EXECUTABLES[browser]
            exe.parent.mkdir(exist_ok=True)
            exe.touch()
            directory = self.data / ident
            directory.mkdir()
            (directory / 'Default').mkdir()
            self.rows.append(dict(id=ident, label=ident, browser=browser,
                                  executable=str(exe), profile_path=str(directory),
                                  profile_directory='Default', worker_id=ident, include_in_all=True))
        self.save()
        profiles.LAST_OPENED.clear()
        self.spawn = patch.object(profiles.subprocess, 'Popen').start()
        self.addCleanup(patch.stopall)
        self.spawn.return_value.wait.return_value = 0

    def save(self):
        (self.data / profiles.CONFIG_NAME).write_text(
            json.dumps(dict(version=1, profiles=self.rows)), encoding='utf-8')

    def test_chrome_buttons_use_distinct_original_profile_directories(self):
        for ident in ('chrome-a', 'chrome-b'):
            self.assertTrue(profiles.open_profile(self.data, ident)['ok'])
        commands = [call.args[0] for call in self.spawn.call_args_list]
        self.assertIn('--user-data-dir=' + self.rows[0]['profile_path'], commands[0])
        self.assertIn('--user-data-dir=' + self.rows[1]['profile_path'], commands[1])
        for command in commands:
            self.assertIn('--profile-directory=Default', command)
            self.assertEqual(command[-1], 'https://chatgpt.com/')
        self.assertNotIn('shell', self.spawn.call_args.kwargs)

    def test_firefox_starts_the_exact_closed_profile_in_a_separate_instance(self):
        with patch.object(profiles, '_firefox_process', return_value=(None, False)):
            profiles.open_profile(self.data, 'firefox-b')
        command = self.spawn.call_args.args[0]
        self.assertEqual(command[1:4], ['-no-remote', '-profile', self.rows[3]['profile_path']])
        self.assertEqual(command[-1], profiles.CHATGPT_URL)

    def test_running_firefox_is_focused_without_relaunch_or_profile_lock_conflict(self):
        with patch.object(profiles, '_firefox_process', return_value=(42, True)), \
                patch.object(profiles, '_focus_window', return_value=True) as focus:
            value = profiles.open_profile(self.data, 'firefox-a')
        self.assertTrue(value['already_running'])
        focus.assert_called_once_with(42)
        self.spawn.assert_not_called()

    def test_locked_firefox_without_identified_window_does_not_start_another_instance(self):
        with patch.object(profiles, '_firefox_process', return_value=(None, True)), \
                patch.object(profiles, '_focus_window', return_value=False):
            value = profiles.open_profile(self.data, 'firefox-b')
        self.assertTrue(value['already_running'])
        self.assertFalse(value['focused'])
        self.spawn.assert_not_called()

    def test_profile_matching_ignores_another_running_firefox_profile(self):
        other = Mock(pid=10, info=dict(name='firefox.exe', exe=self.rows[3]['executable'],
                                      cmdline=['firefox.exe', '-profile', self.rows[2]['profile_path']]))
        exact = Mock(pid=20, info=dict(name='firefox.exe', exe=self.rows[3]['executable'],
                                      cmdline=['firefox.exe', '-no-remote', '-profile', self.rows[3]['profile_path']]))
        with patch.object(profiles.psutil, 'process_iter', return_value=[other, exact]):
            self.assertEqual(profiles._firefox_process(self.rows[3]), (20, True))

    def test_missing_original_profile_is_disabled_and_never_recreated(self):
        target = self.data / 'missing'
        self.rows[1]['profile_path'] = str(target)
        self.save()
        row = profiles.catalog(self.data)[1]
        self.assertFalse(row['available'])
        with self.assertRaisesRegex(ValueError, '原浏览器配置目录不存在'):
            profiles.open_profile(self.data, 'chrome-b')
        self.assertFalse(target.exists())
        self.spawn.assert_not_called()

    def test_bad_id_cannot_pass_commands_or_paths_to_subprocess(self):
        for value in ('../chrome-a', 'chrome-a --incognito', 'C:/evil.exe', None):
            with self.subTest(value=value), self.assertRaises(ValueError):
                profiles.open_profile(self.data, value)
        self.spawn.assert_not_called()

    def test_bulk_open_reports_partial_failure_and_still_opens_healthy_profiles(self):
        self.rows[1]['executable'] = str(self.data / 'missing' / 'chrome.exe')
        self.save()
        with patch.object(profiles, '_firefox_process', return_value=(None, False)):
            result = profiles.open_profile(self.data, 'all')
        self.assertTrue(result['ok'])
        self.assertEqual([row['ok'] for row in result['results']], [True, False, True, True])
        self.assertEqual(self.spawn.call_count, 3)

    def test_repeated_click_is_suppressed_for_the_same_profile_only(self):
        profiles.open_profile(self.data, 'chrome-a')
        self.assertTrue(profiles.open_profile(self.data, 'chrome-a')['already_requested'])
        profiles.open_profile(self.data, 'chrome-b')
        self.assertEqual(self.spawn.call_count, 2)

    def test_nonzero_startup_is_reported_and_not_recorded_as_opened(self):
        self.spawn.return_value.wait.return_value = 1
        with self.assertRaisesRegex(ValueError, '启动失败'):
            profiles.open_profile(self.data, 'chrome-a')
        self.assertNotIn('chrome-a', profiles.LAST_OPENED)

    def test_catalog_keeps_offline_profiles_available_without_exposing_launch_arguments(self):
        catalog = profiles.catalog(self.data)
        self.assertEqual(len(catalog), 4)
        self.assertTrue(all(row['available'] for row in catalog))
        self.assertNotIn('executable', catalog[0])
        self.assertNotIn('profile_path', catalog[0])

    def test_rejects_profile_subdirectory_traversal_and_duplicate_ids(self):
        self.rows[0]['profile_directory'] = '../other'
        self.save()
        with self.assertRaises(ValueError):
            profiles.catalog(self.data)
        self.rows[0]['profile_directory'] = 'Default'
        self.rows[1]['id'] = self.rows[0]['id']
        self.save()
        with self.assertRaises(ValueError):
            profiles.catalog(self.data)

    def test_http_launch_requires_local_origin_header_and_known_profile(self):
        with patch.object(backend, 'DATA', self.data):
            server = backend.BoundedThreadingHTTPServer(('127.0.0.1', 0), backend.Handler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                def request(body, headers):
                    connection = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=3)
                    connection.request('POST', '/api/gpt-browser-profiles/open',
                                       body=json.dumps(body), headers={'Content-Type':'application/json', **headers})
                    response = connection.getresponse()
                    result = response.status, json.loads(response.read())
                    connection.close()
                    return result
                good = {'X-Workbench':'local', 'Origin':'http://127.0.0.1:5173'}
                self.assertEqual(request({'profile_id':'chrome-a'}, {})[0], 403)
                self.assertEqual(request({'profile_id':'chrome-a'}, dict(good, Origin='https://attacker.test'))[0], 403)
                self.assertEqual(request({'profile_id':'invalid'}, good)[0], 400)
                status, body = request({'profile_id':'chrome-a', 'url':'https://attacker.test'}, good)
                self.assertEqual(status, 200)
                self.assertTrue(body['ok'])
                self.assertEqual(self.spawn.call_args.args[0][-1], profiles.CHATGPT_URL)
            finally:
                server.shutdown()
                server.server_close()
                thread.join(3)

    def test_get_status_includes_registered_profiles_even_without_worker_heartbeats(self):
        with patch.object(backend, 'DATA', self.data), \
                patch.object(backend.gpt_extension_bridge, 'snapshot', return_value={'workers': []}):
            server = backend.BoundedThreadingHTTPServer(('127.0.0.1', 0), backend.Handler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                conn = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=3)
                conn.request('GET', '/api/gpt-extension')
                response = conn.getresponse()
                self.assertEqual(response.status, 200)
                value = json.loads(response.read())
                conn.close()
                self.assertEqual(len(value['browser_profiles']), 4)
                self.assertEqual(value['workers'], [])
            finally:
                server.shutdown()
                server.server_close()
                thread.join(3)


if __name__ == '__main__':
    unittest.main()
