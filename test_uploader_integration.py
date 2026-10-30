import json
import subprocess
import sys
import threading
import types
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import Mock, patch
import backend


class UploaderIntegrationTests(unittest.TestCase):
    def write_manifest(self, folder, version=backend.UPLOADER_VERSION):
        (folder / '版本信息.json').write_text(json.dumps({'version': version}), encoding='utf-8')

    def test_bundled_version_matches_release_component(self):
        folder, executable, interpreter = backend.TOOLS['uploader']
        self.assertIsNone(interpreter)
        self.assertTrue((folder / executable).is_file())
        self.assertEqual(json.loads((folder / '版本信息.json').read_text(encoding='utf-8'))['version'], backend.UPLOADER_VERSION)
        self.assertEqual(folder, backend.ROOT / 'local_tools' / 'dxm-uploader')
        self.assertEqual(backend.tool_status('uploader')['version'], backend.UPLOADER_VERSION)
        self.assertTrue(backend.tool_status('uploader')['available'])

    def test_executable_launch_is_direct_and_does_not_inherit_python_settings(self):
        with TemporaryDirectory() as temp:
            folder = Path(temp)
            executable = folder / '上传工具.exe'
            executable.touch()
            self.write_manifest(folder)
            process = Mock()
            process.wait.side_effect = subprocess.TimeoutExpired('uploader', 1.5)
            with patch.dict(backend.TOOLS, uploader=(folder, executable.name, None)), patch.object(backend, 'DATA', folder / 'data'), patch.object(backend, 'launches', {}), patch.dict(backend.os.environ, {'PYTHONHOME':'wrong','TCL_LIBRARY':'wrong'}), patch.object(backend.subprocess, 'Popen', return_value=process) as spawn:
                result = backend.launch_tool('uploader')
                self.assertEqual(spawn.call_args.args[0], [str(executable)])
                self.assertEqual(spawn.call_args.kwargs['cwd'], folder)
                self.assertNotIn('PYTHONHOME', spawn.call_args.kwargs['env'])
                self.assertNotIn('TCL_LIBRARY', spawn.call_args.kwargs['env'])
                self.assertIn(backend.UPLOADER_VERSION, result['message'])
                process.poll.return_value = None
                backend.launch_tool('uploader')
                self.assertEqual(spawn.call_count, 1)

    def test_early_executable_failure_is_reported(self):
        with TemporaryDirectory() as temp:
            folder = Path(temp)
            (folder / 'bad.exe').touch()
            self.write_manifest(folder)
            process = Mock()
            process.wait.return_value = 7
            with patch.dict(backend.TOOLS, uploader=(folder, 'bad.exe', None)), patch.object(backend, 'DATA', folder), patch.object(backend, 'launches', {}), patch.object(backend.subprocess, 'Popen', return_value=process):
                with self.assertRaisesRegex(ValueError, '7'):
                    backend.launch_tool('uploader')

    def test_older_or_missing_manifest_never_launches_stale_binary(self):
        with TemporaryDirectory() as temp:
            folder = Path(temp)
            (folder / 'tool.exe').touch()
            for version in ('1.7.1', '9.9.9', None):
                if version:
                    self.write_manifest(folder, version)
                else:
                    (folder / '版本信息.json').unlink()
                with self.subTest(version=version), patch.dict(backend.TOOLS, uploader=(folder, 'tool.exe', None)), patch.object(backend.subprocess, 'Popen') as spawn:
                    self.assertFalse(backend.tool_status('uploader')['available'])
                    with self.assertRaisesRegex(ValueError, backend.UPLOADER_VERSION):
                        backend.launch_tool('uploader')
                    spawn.assert_not_called()

    def test_missing_executable_gives_unpack_instruction(self):
        with TemporaryDirectory() as temp:
            folder = Path(temp)
            self.write_manifest(folder)
            with patch.dict(backend.TOOLS, uploader=(folder, 'missing.exe', None)):
                with self.assertRaisesRegex(ValueError, '重新解压'):
                    backend.launch_tool('uploader')

    def test_old_optional_collector_has_no_machine_specific_path(self):
        folder, _, interpreter = backend.TOOLS['collector']
        self.assertEqual(folder, backend.ROOT / 'local_tools/image-collector')
        self.assertEqual(interpreter, Path(sys.executable))
        with TemporaryDirectory() as temp, patch.dict(backend.TOOLS, collector=(Path(temp), 'missing.py', Path(sys.executable))):
            with self.assertRaisesRegex(ValueError, '统一采集入口'):
                backend.launch_tool('collector')


class ColleagueBrowserRoutesTests(unittest.TestCase):
    def setUp(self):
        self.server = backend.BoundedThreadingHTTPServer(('127.0.0.1', 0), backend.Handler, max_workers=4)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f'http://127.0.0.1:{self.server.server_port}'
        self.module = types.SimpleNamespace(status=Mock(return_value={'available': True, 'running': False}), open_browser=Mock(return_value={'ok': True, 'message': '已打开'}))
        self.modules = patch.dict(sys.modules, colleague_browser=self.module)
        self.modules.start()

    def tearDown(self):
        self.modules.stop()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=3)

    def test_status_route_uses_workbench_data_folder(self):
        with urllib.request.urlopen(self.base + '/api/colleague-browser', timeout=3) as response:
            self.assertTrue(json.loads(response.read().decode())['available'])
        self.module.status.assert_called_once_with(backend.DATA)

    def test_open_route_requires_workbench_header(self):
        request = urllib.request.Request(self.base + '/api/colleague-browser/open', data=b'{}', headers={'Content-Type': 'application/json'})
        with self.assertRaises(urllib.error.HTTPError) as raised:
            urllib.request.urlopen(request, timeout=3)
        self.assertEqual(raised.exception.code, 403)
        self.module.open_browser.assert_not_called()

    def test_open_route_passes_workbench_data_folder(self):
        request = urllib.request.Request(self.base + '/api/colleague-browser/open', data=b'{}', headers={'Content-Type': 'application/json', 'X-Workbench': 'local'})
        with urllib.request.urlopen(request, timeout=3) as response:
            self.assertTrue(json.loads(response.read().decode())['ok'])
        self.module.open_browser.assert_called_once_with(backend.DATA, 'store')

    def test_selection_route_passes_named_target(self):
        request = urllib.request.Request(self.base + '/api/colleague-browser/open', data=b'{"target":"selection"}', headers={'Content-Type': 'application/json', 'X-Workbench': 'local'})
        with urllib.request.urlopen(request, timeout=3) as response:
            self.assertTrue(json.loads(response.read().decode())['ok'])
        self.module.open_browser.assert_called_once_with(backend.DATA, 'selection')


if __name__ == '__main__':
    unittest.main()
