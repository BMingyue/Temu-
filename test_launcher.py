import unittest
from unittest.mock import Mock, patch

import launcher


class SupervisorIdentityTests(unittest.TestCase):
    def process(self, args, cwd=None, executable='C:/Python/python.exe'):
        process = Mock()
        process.cmdline.return_value = args
        process.cwd.return_value = str(cwd or launcher.ROOT)
        process.exe.return_value = executable
        return process

    @patch.object(launcher.psutil, 'process_iter')
    def test_current_workspace_supervisor_is_detected(self, process_iter):
        process_iter.return_value = [self.process(['python', str(launcher.SUPERVISOR)])]
        self.assertTrue(launcher.supervisor_running())

    @patch.object(launcher.psutil, 'process_iter')
    def test_relative_current_workspace_supervisor_is_detected(self, process_iter):
        process_iter.return_value = [self.process(['python', 'service_supervisor.py'])]
        self.assertTrue(launcher.supervisor_running())

    @patch.object(launcher.psutil, 'process_iter')
    def test_old_workspace_supervisor_is_not_reused(self, process_iter):
        process_iter.return_value = [
            self.process(['python', 'service_supervisor.py'], cwd='C:/old/temu-workbench')
        ]
        self.assertFalse(launcher.supervisor_running())

    @patch.object(launcher.psutil, 'process_iter')
    def test_embedded_path_is_not_reused(self, process_iter):
        process_iter.return_value = [
            self.process(['python', '-c', str(launcher.SUPERVISOR)])
        ]
        self.assertFalse(launcher.supervisor_running())

    @patch.object(launcher.psutil, 'process_iter')
    def test_non_python_process_is_not_reused(self, process_iter):
        process_iter.return_value = [
            self.process(['notepad', str(launcher.SUPERVISOR)], executable='C:/Windows/notepad.exe')
        ]
        self.assertFalse(launcher.supervisor_running())

    @patch.object(launcher.subprocess, 'run')
    def test_scheduled_supervisor_is_requested(self, run):
        run.return_value = Mock(returncode=0)
        self.assertTrue(launcher.request_scheduled_supervisor())
        self.assertEqual(
            run.call_args.args[0],
            ['schtasks.exe', '/Run', '/TN', launcher.SUPERVISOR_TASK],
        )

    @patch.object(launcher.subprocess, 'run')
    def test_missing_scheduled_task_allows_fallback(self, run):
        run.return_value = Mock(returncode=1)
        self.assertFalse(launcher.request_scheduled_supervisor())


if __name__ == '__main__':
    unittest.main()
