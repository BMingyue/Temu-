"""Isolated close-window and task-cooldown migration checks."""
from datetime import datetime, timezone
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import gpt_browser_profiles as profiles
import gpt_extension_bridge as bridge


class BrowserCloseTests(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.rows = [dict(id='chrome-test-' + str(i), browser='chrome', managed=True,
                          executable=str(root / 'chrome.exe'),
                          profile_path=str(root / ('profile-' + str(i))),
                          label='Test profile ' + str(i)) for i in (1, 2)]

    def test_process_match_excludes_other_profiles_executables_and_children(self):
        def process(row, **changes):
            info = dict(name='chrome.exe', exe=row['executable'],
                        cmdline=['chrome.exe', '--user-data-dir=' + row['profile_path']])
            info.update(changes)
            return SimpleNamespace(info=info)
        exact = process(self.rows[0])
        other = process(self.rows[1])
        child = process(self.rows[0], cmdline=[
            'chrome.exe', '--user-data-dir=' + self.rows[0]['profile_path'], '--type=renderer'])
        different_exe = process(self.rows[0], exe=str(Path(self.temp.name) / 'other/chrome.exe'))
        with patch.object(profiles.psutil, 'process_iter', return_value=[other, child, different_exe, exact]):
            self.assertEqual(profiles._chrome_processes([self.rows[0]]), {self.rows[0]['id']: exact})

    def test_unmanaged_profile_is_rejected_before_process_access(self):
        row = dict(self.rows[0], managed=False)
        with patch.object(profiles, '_profiles', return_value=[row]), \
                patch.object(profiles, '_chrome_processes') as scan:
            self.assertFalse(profiles.close_profile(self.temp.name, row['id'])['ok'])
            scan.assert_not_called()

    def test_unknown_ids_cannot_supply_a_pid_or_path(self):
        with patch.object(profiles, '_profiles', return_value=self.rows), \
                patch.object(profiles, '_request_close') as close:
            for value in (None, 42, '../other', 'chrome-test-1 --pid=42'):
                with self.subTest(value=value), self.assertRaises(ValueError):
                    profiles.close_profile(self.temp.name, value)
            close.assert_not_called()

    def test_bulk_close_is_scoped_and_reports_partial_failure(self):
        rows = [dict(self.rows[0], include_in_all=False), self.rows[1],
                dict(self.rows[0], id='ordinary', managed=False),
                dict(self.rows[0], id='edge', browser='edge')]
        with patch.object(profiles, '_profiles', return_value=rows), \
                patch.object(profiles, '_request_close', side_effect=[
                    ValueError('Synthetic close failure'),
                    dict(ok=True, id=self.rows[1]['id'], message='Close requested'),
                ]) as close:
            result = profiles.close_profile(self.temp.name, 'chrome-all')
            self.assertTrue(result['ok'])
            self.assertEqual([row['ok'] for row in result['results']], [False, True])
            self.assertEqual([call.args[0]['id'] for call in close.call_args_list],
                             [self.rows[0]['id'], self.rows[1]['id']])

    def test_normal_close_posts_wm_close_without_terminating_process(self):
        process = Mock(pid=42)
        process.is_running.return_value = False
        user32 = Mock()
        user32.EnumWindows.side_effect = lambda callback, param: callback(101, param)
        def owner(handle, pointer):
            pointer._obj.value = 42
            return 1
        user32.GetWindowThreadProcessId.side_effect = owner
        user32.IsWindowVisible.return_value = True
        user32.PostMessageW.return_value = True
        with patch.object(profiles.os, 'name', 'nt'), \
                patch.object(profiles, '_chrome_processes', return_value={self.rows[0]['id']: process}), \
                patch.object(profiles.ctypes, 'WinDLL', return_value=user32, create=True), \
                patch.object(profiles.ctypes, 'WINFUNCTYPE', profiles.ctypes.CFUNCTYPE, create=True):
            self.assertTrue(profiles._request_close(self.rows[0])['ok'])
        user32.PostMessageW.assert_called_once_with(101, 0x0010, 0, 0)
        process.terminate.assert_not_called()
        process.kill.assert_not_called()


class TaskGapTests(unittest.TestCase):
    def test_sixty_second_gap_is_isolated_per_profile(self):
        def completed(seconds_ago, worker):
            return dict(assigned_browser='chrome', assigned_worker=worker,
                        completed_at=datetime.fromtimestamp(1000 - seconds_ago, timezone.utc).isoformat())
        jobs = [completed(55, 'first'), completed(1, 'second')]
        with patch.object(bridge.time, 'time', return_value=1000):
            self.assertEqual(bridge._task_gap_remaining(jobs, 'chrome', 'first'), 5)
            self.assertEqual(bridge._task_gap_remaining(jobs, 'chrome', 'second'), 59)
            self.assertEqual(bridge._task_gap_remaining(jobs, 'firefox', 'first'), 0)


if __name__ == '__main__':
    unittest.main()
