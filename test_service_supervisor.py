import unittest
import json
import tempfile
from pathlib import Path
from unittest.mock import Mock, patch

import psutil
import service_supervisor as supervisor


class FrontendScopeTests(unittest.TestCase):
    def process(self, args, cwd=None, executable=None):
        process = Mock()
        process.cmdline.return_value = args
        process.exe.return_value = str(executable or supervisor.NODE)
        process.cwd.return_value = str(cwd or supervisor.ROOT)
        return process

    def test_exact_frontend(self):
        process = self.process([str(supervisor.NODE), str(supervisor.VINEXT), 'dev'])
        self.assertTrue(supervisor.is_our_frontend(process))

    def test_relative_frontend(self):
        process = self.process([str(supervisor.NODE), 'node_modules/vinext/dist/cli.js', 'dev'])
        self.assertTrue(supervisor.is_our_frontend(process))

    def test_other_workspace_not_touched(self):
        process = self.process(
            [str(supervisor.NODE), 'node_modules/vinext/dist/cli.js', 'dev'],
            cwd='C:/another-workspace',
        )
        self.assertFalse(supervisor.is_our_frontend(process))

    def test_other_runtime_not_touched(self):
        process = self.process(
            ['C:/old/runtime/node.exe', str(supervisor.VINEXT), 'dev'],
            executable='C:/old/runtime/node.exe',
        )
        self.assertFalse(supervisor.is_our_frontend(process))

    def test_non_dev_command_not_touched(self):
        process = self.process([str(supervisor.NODE), str(supervisor.VINEXT), 'build'])
        self.assertFalse(supervisor.is_our_frontend(process))

    def test_unknown_identity_not_touched(self):
        process = self.process([])
        process.cmdline.side_effect = psutil.AccessDenied()
        self.assertFalse(supervisor.is_our_frontend(process))

    @patch.object(supervisor.time, 'time', return_value=1000)
    def test_recent_frontend_gets_startup_grace(self, _time):
        process = Mock()
        process.create_time.return_value = 900
        self.assertTrue(supervisor.frontend_starting([process]))

    @patch.object(supervisor.time, 'time', return_value=1000)
    def test_old_frontend_is_not_starting(self, _time):
        process = Mock()
        process.create_time.return_value = 100
        self.assertFalse(supervisor.frontend_starting([process]))

    @patch.object(supervisor, 'our_frontend_processes', return_value=[Mock()])
    @patch.object(supervisor.subprocess, 'Popen')
    def test_restart_does_not_duplicate_known_frontend(self, popen, _known):
        self.assertFalse(supervisor.restart_frontend())
        popen.assert_not_called()

    @patch.object(supervisor, 'listener_process', return_value=None)
    @patch.object(supervisor, 'our_frontend_processes', return_value=[])
    @patch.object(supervisor.subprocess, 'Popen')
    def test_restart_launches_only_current_workspace(self, popen, _missing, _listener):
        self.assertTrue(supervisor.restart_frontend())
        args, kwargs = popen.call_args
        self.assertEqual(args[0], [str(supervisor.NODE), str(supervisor.VINEXT), 'dev'])
        self.assertEqual(kwargs['cwd'], supervisor.ROOT)

    @patch.object(supervisor, 'listener_process', return_value=Mock())
    @patch.object(supervisor, 'our_frontend_processes', return_value=[])
    def test_foreign_listener_is_rejected(self, _missing, _listener):
        with self.assertRaisesRegex(RuntimeError, '5173'):
            supervisor.restart_frontend()

    @patch.object(supervisor, 'listener_process', return_value=None)
    @patch.object(supervisor, 'stop_frontend_processes')
    @patch.object(supervisor, 'our_frontend_processes')
    @patch.object(supervisor.subprocess, 'Popen')
    def test_recycle_stops_verified_frontend(self, popen, known, stop, _listener):
        target = Mock()
        known.return_value = [target]
        self.assertTrue(supervisor.restart_frontend(recycle=True))
        stop.assert_called_once_with([target])
        popen.assert_called_once()

    def test_heartbeat_is_atomic_and_diagnostic(self):
        with tempfile.TemporaryDirectory() as temporary:
            heartbeat = Path(temporary) / 'supervisor-heartbeat.json'
            with patch.object(supervisor, 'HEARTBEAT', heartbeat):
                supervisor.write_heartbeat('running', backend=True, frontend=False, detail='test')
            payload = json.loads(heartbeat.read_text(encoding='utf-8'))
            self.assertEqual(payload['status'], 'running')
            self.assertTrue(payload['backend_healthy'])
            self.assertFalse(payload['frontend_healthy'])
            self.assertEqual(payload['detail'], 'test')
            self.assertFalse(heartbeat.with_suffix('.json.tmp').exists())


if __name__ == '__main__':
    unittest.main()
