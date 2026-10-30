import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

import install_workbench as install
import update_workbench as update
import workbench_processes as processes


class CleanInstallTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='temu-')
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.source = self.base/'new'
        self.old = self.base/'old'
        self.target = self.old
        self.source.mkdir(); self.old.mkdir()
        contents = {
            'backend.py':'new backend', 'launcher.py':'new launcher', 'portable_web.py':'new web',
            'service_supervisor.py':'new supervisor', 'workbench_version.py':'version',
            'workbench_processes.py':'processes', 'update_workbench.py':'updater',
            'install_workbench.py':'installer', 'INSTALL.cmd':'setup',
            'web-dist/index.html':'new page', 'runtime/python/python.exe':'runtime',
            'workbench-release.json':json.dumps({'product':'temu-workbench','version':'2026.10.24.2'}),
            '版本信息.json':json.dumps({'release':'2026.10.24.2','contains_user_data':False}),
            'browser_extension/manifest.json':json.dumps({'background':{'service_worker':'service-worker.js'}}),
            'gpt_chrome_extension/manifest.json':json.dumps({'background':{'service_worker':'service-worker.js'}}),
            'gpt_chrome_extension/config.js':'empty-token',
            'local_tools/qualification/assets/说明.txt':'configure your own',
        }
        for name, value in contents.items(): self.write(self.source,name,value)
        for name,value in {'backend.py':'old code','launcher.py':'old launch',
                           'browser_extension/manifest.json':'{}',
                           'data/workbench.sqlite3':'old private data',
                           'data/bridge-token':'old token',
                           'local_tools/qualification/state/login':'old login',
                           'local_tools/qualification/assets/photo.jpg':'personal image'}.items():
            self.write(self.old,name,value)
        self.appdata=self.base/'local'
        self.upload=self.appdata/'DianxiaomiUploaderStandalone'
        self.write(self.upload,'login.db','old uploader data')
        self.outside=self.base/'unrelated.txt'
        self.outside.write_text('keep')
        env=patch.dict(os.environ,{'LOCALAPPDATA':str(self.appdata)})
        env.start(); self.addCleanup(env.stop)
        for name,value in [('listener_roots',{}),('stop_services',None),('assert_quiet',None),
                           ('disable_old_tasks',[]),('restore_tasks',None)]:
            item=patch.object(install,name,return_value=value); item.start(); self.addCleanup(item.stop)
        item=patch.object(install.psutil,'process_iter',return_value=[])
        item.start(); self.addCleanup(item.stop)
        self.manifest()

    def write(self,root,name,value):
        path=root/name; path.parent.mkdir(parents=True,exist_ok=True)
        path.write_text(value,encoding='utf-8')

    def manifest(self):
        (self.source/'SHA256SUMS.txt').write_text('\n'.join(
            update.digest(p)+'  '+p.relative_to(self.source).as_posix()
            for p in sorted(self.source.rglob('*')) if p.is_file() and p.name!='SHA256SUMS.txt'
        )+'\n',encoding='utf-8')

    def apply(self,**kwargs):
        return install.install_clean(self.source,self.target,[self.old],notify=lambda _:None,**kwargs)

    def test_clean_replacement_removes_all_old_live_state_and_keeps_recoverable_copy(self):
        result=self.apply()
        self.assertEqual(result['status'],'complete')
        self.assertFalse((self.target/'data').exists())
        self.assertFalse((self.target/'local_tools/qualification/state').exists())
        self.assertFalse((self.target/'local_tools/qualification/assets/photo.jpg').exists())
        self.assertTrue((self.target/'local_tools/qualification/assets/说明.txt').exists())
        self.assertFalse(self.upload.exists())
        backups={Path(x['original']):Path(x['backup']) for x in result['retired']}
        self.assertEqual((backups[self.old]/'data/workbench.sqlite3').read_text(),'old private data')
        self.assertEqual((backups[self.upload]/'login.db').read_text(),'old uploader data')
        self.assertEqual(self.outside.read_text(),'keep')

    def test_first_install_creates_empty_application_without_touching_unselected_old_folder(self):
        self.target=self.base/'fresh'
        result=install.install_clean(self.source,self.target,[],reset_uploader=False,notify=lambda _:None)
        self.assertEqual(result['retired'],[])
        self.assertFalse((self.target/'data').exists())
        self.assertTrue((self.old/'data/workbench.sqlite3').exists())
        self.assertTrue(self.upload.exists())

    def test_commit_failure_restores_old_directory_and_uploader(self):
        original=install.move_exact
        def failing(source,destination):
            if Path(source).name.startswith('.temu-stage-'):
                raise OSError('injected commit failure')
            original(source,destination)
        with patch.object(install,'move_exact',side_effect=failing):
            with self.assertRaisesRegex(OSError,'commit failure'): self.apply()
        self.assertEqual((self.old/'backend.py').read_text(),'old code')
        self.assertEqual((self.upload/'login.db').read_text(),'old uploader data')
        report=json.loads(next(self.base.glob('TemuWorkbench-backup-*/install-report.json')).read_text())
        self.assertEqual(report['status'],'rolled_back')

    def test_bad_package_is_rejected_before_services_are_stopped(self):
        (self.source/'backend.py').write_text('corrupt')
        with self.assertRaisesRegex(RuntimeError,'不完整'): self.apply()
        install.stop_services.assert_not_called()
        self.assertTrue((self.old/'data/workbench.sqlite3').exists())

    def test_missing_checksum_has_extract_all_recovery_message(self):
        (self.source/'SHA256SUMS.txt').unlink()
        with self.assertRaisesRegex(RuntimeError,'全部解压'): self.apply()
        install.stop_services.assert_not_called()

    def test_foreign_listener_is_never_stopped_or_deleted(self):
        install.listener_roots.return_value={5173:None}
        with self.assertRaisesRegex(RuntimeError,'其他程序'): self.apply()
        install.stop_services.assert_not_called()
        self.assertTrue(self.old.exists())

    def test_same_or_nested_source_and_target_are_rejected(self):
        for target in (self.source,self.source/'child',self.base):
            with self.assertRaises(RuntimeError):
                install.validate_plan(self.source,target,[])

    def test_non_workbench_old_directory_is_never_retired(self):
        other=self.base/'documents'; other.mkdir()
        self.write(other,'notes.txt','private')
        with self.assertRaisesRegex(RuntimeError,'不是工作台'):
            install.install_clean(self.source,self.target,[other],notify=lambda _:None)
        self.assertEqual((other/'notes.txt').read_text(),'private')

    def test_interpreter_options_do_not_hide_owned_processes(self):
        process=Mock()
        process.exe.return_value='C:/runtime/pythonw.exe'
        process.cmdline.return_value=['pythonw','-E','-B',str(self.old/'launcher.py')]
        self.assertEqual(processes.service_root(process),self.old.resolve())
        process.cmdline.return_value=['pythonw','-c',str(self.old/'launcher.py')]
        self.assertIsNone(processes.service_root(process))

    def test_multiple_listeners_on_same_port_keep_foreign_conflict(self):
        own=Mock(status='LISTEN',laddr=Mock(port=5173),pid=10)
        foreign=Mock(status='LISTEN',laddr=Mock(port=5173),pid=11)
        with patch.object(processes.psutil,'net_connections',return_value=[own,foreign]), \
             patch.object(processes.psutil,'Process'), \
             patch.object(processes,'service_root',side_effect=[self.old,None]):
            self.assertEqual(processes.listener_roots(),{5173:None})

    def test_chrome_incompatible_manifest_rejected_before_retiring(self):
        self.write(self.source,'browser_extension/manifest.json',
                   json.dumps({'background':{'service_worker':'a.js','scripts':['a.js']}}))
        self.manifest()
        with self.assertRaisesRegex(RuntimeError,'Chrome'): self.apply()
        install.stop_services.assert_not_called()

    def test_python311_reparse_points_are_rejected_without_path_is_junction(self):
        with patch.object(Path,'is_symlink',return_value=False), \
             patch.object(Path,'lstat',return_value=Mock(st_file_attributes=0x400)):
            self.assertTrue(processes.is_link_path(self.old))
            with self.assertRaisesRegex(RuntimeError,'目录链接'):
                install.checked_path(self.old)

    def test_private_runtime_data_cannot_be_copied_by_clean_install(self):
        self.write(self.source,'data/workbench.sqlite3','another person data')
        self.manifest()
        with self.assertRaisesRegex(RuntimeError,'混入运行数据'): self.apply()
        install.stop_services.assert_not_called()

    def test_schtasks_utf8_bytes_with_utf16_declaration_do_not_break_installation(self):
        xml='<?xml version="1.0" encoding="UTF-16"?><Task><Actions><Exec><Command>C:/Python/pythonw.exe</Command><Arguments>"%s"</Arguments></Exec></Actions></Task>'
        text=xml % (self.old/'service_supervisor.py')
        self.assertTrue(install.task_owned(text.encode('utf-8'),[self.old]))
        self.assertTrue(install.task_owned(text.encode('utf-16'),[self.old]))

    def test_tasks_are_matched_by_exact_action_not_name_or_substring(self):
        xml='<Task><Actions><Exec><Command>C:/Python/pythonw.exe</Command><Arguments>"%s"</Arguments></Exec></Actions></Task>'
        self.assertTrue(install.task_owned(xml % (self.old/'service_supervisor.py'),[self.old]))
        self.assertFalse(install.task_owned(xml % (self.source/'service_supervisor.py'),[self.old]))
        self.assertFalse(install.task_owned(xml % ('-c '+str(self.old/'service_supervisor.py')),[self.old]))


if __name__=='__main__': unittest.main()
