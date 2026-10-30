import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

from release import sync_uploader_component as sync
import workbench_processes as processes


class UploaderComponentSyncTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root = self.base / 'workbench'
        self.root.mkdir()
        self.source = self.base / 'new-release'
        self.source.mkdir()
        self.target = self.root / 'local_tools/dxm-uploader'
        self.target.mkdir(parents=True)
        (self.target / 'old.txt').write_text('old uploader')
        self.component = self.root / 'workbench-components.json'
        self.component.write_text(json.dumps({'schema': 1, 'uploader': {'version': '1.0.0'}}))
        (self.source / '版本信息.json').write_text(json.dumps({'app': '店小秘 Temu 自动上架独立版', 'version': '1.7.4'}), encoding='utf-8')
        (self.source / '店小秘自动上架.exe').write_bytes(b'verified fixture')
        self.checksums()
        processes = patch.object(sync.psutil, 'process_iter', return_value=[])
        processes.start()
        self.addCleanup(processes.stop)

    def checksums(self):
        values = []
        for path in sorted(self.source.rglob('*')):
            if path.is_file() and path.name != '文件校验SHA256.txt':
                values.append(sync.sha256(path) + '  ' + path.relative_to(self.source).as_posix())
        (self.source / '文件校验SHA256.txt').write_text('\n'.join(values) + '\n', encoding='utf-8')

    def test_publish_files_must_all_match(self):
        self.assertEqual(sync.verify_release(self.source)['file_count'], 3)
        (self.source / '店小秘自动上架.exe').write_bytes(b'tampered')
        with self.assertRaisesRegex(ValueError, '校验失败'):
            sync.verify_release(self.source)
        self.assertTrue((self.target / 'old.txt').is_file())

    def test_reject_unlisted_private_files(self):
        (self.source / 'CONFIG.JSON').write_text('{}')
        self.checksums()
        with self.assertRaisesRegex(ValueError, '账号'):
            sync.sync_release(self.source, self.root)
        self.assertTrue((self.target / 'old.txt').is_file())

    def test_reject_unlisted_additional_files(self):
        (self.source / 'random.txt').write_text('unverified')
        with self.assertRaisesRegex(ValueError, '未校验'):
            sync.verify_release(self.source)

    def test_reject_duplicate_and_parent_paths(self):
        checksum = self.source / '文件校验SHA256.txt'
        original = checksum.read_text(encoding='utf-8')
        for extra in (original.splitlines()[0], 'a'*64 + '  ../outside'):
            checksum.write_text(original + extra + '\n', encoding='utf-8')
            with self.assertRaisesRegex(ValueError, '无效'):
                sync.verify_release(self.source)

    def test_reject_unknown_app_or_version_format(self):
        manifest = self.source / '版本信息.json'
        for payload in ({'app':'other','version':'1.7.4'}, {'app':'店小秘 Temu 自动上架独立版','version':'latest'}):
            manifest.write_text(json.dumps(payload), encoding='utf-8')
            self.checksums()
            with self.assertRaisesRegex(ValueError, '已知格式'):
                sync.verify_release(self.source)

    def test_sync_backs_up_and_updates_only_bundled_release(self):
        personal = self.root / 'data/personal-records.json'
        personal.parent.mkdir()
        personal.write_text('private fixture')
        before = hashlib.sha256(personal.read_bytes()).hexdigest()
        result = sync.sync_release(self.source, self.root)
        self.assertTrue(result['ok'])
        self.assertEqual((Path(result['backup']) / 'dxm-uploader/old.txt').read_text(), 'old uploader')
        self.assertEqual(json.loads(self.component.read_text())['uploader']['version'], '1.7.4')
        self.assertEqual((self.target / '店小秘自动上架.exe').read_bytes(), b'verified fixture')
        self.assertEqual(hashlib.sha256(personal.read_bytes()).hexdigest(), before)

    def test_running_bundled_tool_is_never_stopped_or_replaced(self):
        process = Mock()
        process.exe.return_value = str(self.target / 'running.exe')
        with patch.object(sync.psutil, 'process_iter', return_value=[process]):
            with self.assertRaisesRegex(ValueError, '仍在运行'):
                sync.sync_release(self.source, self.root)
        process.terminate.assert_not_called()
        self.assertTrue((self.target / 'old.txt').is_file())

    def test_component_write_failure_restores_old_executable_and_metadata(self):
        original = Path.replace
        old_metadata = self.component.read_bytes()
        def fail_component(path, target):
            if str(path).endswith('.tmp'):
                raise PermissionError('fixture component lock')
            return original(path, target)
        with patch.object(Path, 'replace', fail_component):
            with self.assertRaisesRegex(ValueError, '旧版已保留'):
                sync.sync_release(self.source, self.root)
        self.assertEqual(self.component.read_bytes(), old_metadata)
        self.assertEqual((self.target / 'old.txt').read_text(), 'old uploader')

    def service_values(self, *, active=0, queued=0, commands=None, identity=None):
        expected = hashlib.sha256(str(self.root.resolve()).casefold().encode()).hexdigest()[:24]
        return [
            {'ok':True, 'service':'temu-workbench', 'installation_id':identity or expected},
            {'summary':{'active':active,'queued':queued}},
            {'commands': [] if commands is None else commands},
        ]

    def test_gui_refuses_wrong_installation_or_busy_queue(self):
        for values in (self.service_values(identity='another-installation'), self.service_values(active=1), self.service_values(queued=1), self.service_values(commands=[{'status':'running'}]), self.service_values(commands=[{'status':'queued'}])):
            with self.subTest(values=values), patch.object(processes,'listener_roots',return_value={18769:self.root}), patch.object(sync,'read_local_json',side_effect=values), patch.object(processes,'stop_services') as stop:
                with self.assertRaisesRegex(ValueError,'安全同步'):
                    sync.sync_with_reload(self.source,self.root)
                stop.assert_not_called()
                self.assertTrue((self.target / 'old.txt').is_file())

    def test_gui_refuses_unknown_port_owner(self):
        with patch.object(processes,'listener_roots',return_value={18769:None}), patch.object(sync,'read_local_json') as read, patch.object(processes,'stop_services') as stop:
            with self.assertRaisesRegex(ValueError,'未识别'):
                sync.sync_with_reload(self.source,self.root)
            read.assert_not_called()
            stop.assert_not_called()

    def test_gui_stops_and_restores_only_verified_idle_installation(self):
        with patch.object(processes,'listener_roots',return_value={18769:self.root}), patch.object(sync,'read_local_json',side_effect=self.service_values()), patch.object(processes,'stop_services') as stop, patch.object(sync,'reopen_workbench') as reopen:
            result = sync.sync_with_reload(self.source,self.root)
        self.assertTrue(result['ok'])
        stop.assert_called_once_with(self.root)
        reopen.assert_called_once_with(self.root)

    def test_gui_restores_after_sync_or_partial_stop_failure(self):
        for failing in ('sync','stop'):
            with self.subTest(failing=failing), patch.object(processes,'listener_roots',return_value={18769:self.root}), patch.object(sync,'read_local_json',side_effect=self.service_values()), patch.object(processes,'stop_services',side_effect=RuntimeError('stop fixture') if failing=='stop' else None), patch.object(sync,'sync_release',side_effect=RuntimeError('sync fixture')), patch.object(sync,'reopen_workbench') as reopen:
                with self.assertRaises(RuntimeError):
                    sync.sync_with_reload(self.source,self.root)
                reopen.assert_called_once_with(self.root)

    def test_gui_offline_folder_sync_does_not_start_unrequested_service(self):
        with patch.object(processes,'listener_roots',return_value={}), patch.object(sync,'read_local_json') as read, patch.object(processes,'stop_services') as stop, patch.object(sync,'reopen_workbench') as reopen:
            self.assertTrue(sync.sync_with_reload(self.source,self.root)['ok'])
        read.assert_not_called()
        stop.assert_not_called()
        reopen.assert_not_called()


if __name__ == '__main__':
    unittest.main()
