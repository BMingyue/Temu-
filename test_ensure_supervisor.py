import unittest
from unittest.mock import Mock, patch

import ensure_supervisor as ensure


class EnsureSupervisorTests(unittest.TestCase):
    @patch.object(ensure.launcher, 'supervisor_running', return_value=True)
    @patch.object(ensure.subprocess, 'run')
    def test_existing_supervisor_is_left_alone(self, run, _running):
        self.assertFalse(ensure.ensure_supervisor())
        run.assert_not_called()

    @patch.object(ensure.launcher, 'supervisor_running', return_value=False)
    @patch.object(ensure.subprocess, 'run')
    @patch.object(ensure, 'append_log')
    def test_missing_supervisor_requests_main_task(self, _log, run, _running):
        run.return_value = Mock(returncode=0)
        self.assertTrue(ensure.ensure_supervisor())
        args, _kwargs = run.call_args
        self.assertEqual(
            args[0],
            ['schtasks.exe', '/Run', '/TN', ensure.launcher.SUPERVISOR_TASK],
        )

    @patch.object(ensure.launcher, 'supervisor_running', return_value=False)
    @patch.object(ensure.subprocess, 'run')
    def test_failed_task_request_is_reported(self, run, _running):
        run.return_value = Mock(returncode=1)
        with self.assertRaisesRegex(RuntimeError, '退出码 1'):
            ensure.ensure_supervisor()


if __name__ == '__main__':
    unittest.main()
