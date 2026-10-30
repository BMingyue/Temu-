import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch, Mock
import update_workbench as update
import workbench_processes as processes
import launcher
from workbench_version import VERSION, identity

class UpgradeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.source = self.base/'new'
        self.target = self.base/'original'
        self.source.mkdir(); self.target.mkdir()
        for name in ['backend.py','launcher.py','browser_extension/manifest.json']:
            self.write(self.target,name,'original '+name)
        required = {
            'backend.py':'new backend','launcher.py':'new launcher','portable_web.py':'new frontend',
            'service_supervisor.py':'new supervisor','workbench_version.py':'new version module',
            'workbench_processes.py':'new processes','update_workbench.py':'new updater',
            'web-dist/index.html':'new html','browser_extension/manifest.json':'new manifest',
            'runtime/python/python.exe':'new runtime',
            'workbench-release.json':json.dumps({'product':'temu-workbench','version':VERSION}),
            '版本信息.json':json.dumps({'release':VERSION,'contains_user_data':False}),
            'local_tools/qualification/assets/请先配置自己的资质材料.txt':'vendor placeholder',
            'gpt_chrome_extension/config.js':'new default token',
        }
        for name,body in required.items(): self.write(self.source,name,body)
        self.manifest()
        self.write(self.target,'data/workbench.sqlite3','private database')
        self.write(self.target,'data/bridge-token','private token')
        self.write(self.target,'local_tools/qualification/assets/产品正面图.jpg','private material')
        self.write(self.target,'gpt_chrome_extension/config.js','original local token')
        self.write(self.target,'browser_extension/custom-user-file.txt','custom')
        for name,value in [('listener_roots',{}),('stop_services',None),('assert_quiet',None)]:
            item=patch.object(update,name,return_value=value); item.start(); self.addCleanup(item.stop)
        item=patch.object(update.psutil,'process_iter',return_value=[]); item.start(); self.addCleanup(item.stop)

    def write(self,root,name,body):
        path=root/name; path.parent.mkdir(parents=True,exist_ok=True)
        path.write_text(body,encoding='utf-8')

    def manifest(self):
        lines=[update.digest(p)+'  '+p.relative_to(self.source).as_posix()
               for p in sorted(self.source.rglob('*')) if p.is_file() and p.name!='SHA256SUMS.txt']
        (self.source/'SHA256SUMS.txt').write_text('\n'.join(lines)+'\n',encoding='utf-8')

    def test_updates_original_and_preserves_private_data_and_extension_path(self):
        result=update.apply_update(self.source,self.target,lambda _:None)
        self.assertEqual(result['status'],'complete')
        self.assertEqual((self.target/'backend.py').read_text(),'new backend')
        self.assertEqual((self.target/'data/workbench.sqlite3').read_text(),'private database')
        self.assertEqual((self.target/'data/bridge-token').read_text(),'private token')
        self.assertEqual((self.target/'gpt_chrome_extension/config.js').read_text(),'original local token')
        self.assertEqual((self.target/'local_tools/qualification/assets/产品正面图.jpg').read_text(),'private material')
        self.assertFalse((self.target/'local_tools/qualification/assets/请先配置自己的资质材料.txt').exists())
        self.assertEqual((self.target/'browser_extension/custom-user-file.txt').read_text(),'custom')
        backup=Path(result['backup'])
        self.assertEqual((backup/'data/workbench.sqlite3').read_text(),'private database')
        self.assertEqual((backup/'program/backend.py').read_text(),'original backend.py')

    def test_copy_failure_rolls_back_all_replaced_files_and_keeps_data(self):
        original=update.atomic_copy
        def fail(source,dest,expected=None):
            if dest==self.target/'web-dist/index.html': raise OSError('simulated write failure')
            return original(source,dest,expected)
        with patch.object(update,'atomic_copy',side_effect=fail):
            with self.assertRaisesRegex(OSError,'simulated'):
                update.apply_update(self.source,self.target,lambda _:None)
        self.assertEqual((self.target/'backend.py').read_text(),'original backend.py')
        self.assertFalse((self.target/'portable_web.py').exists())
        self.assertFalse((self.target/'workbench-release.json').exists())
        self.assertEqual((self.target/'data/workbench.sqlite3').read_text(),'private database')
        report=json.loads(next(self.base.glob('original-backup-*/update-report.json')).read_text(encoding='utf-8'))
        self.assertEqual(report['status'],'rolled_back')

    def test_corrupt_bundle_rejected_before_stop(self):
        (self.source/'backend.py').write_text('broken')
        with self.assertRaisesRegex(RuntimeError,'不完整'):
            update.apply_update(self.source,self.target,lambda _:None)
        update.stop_services.assert_not_called()

    def test_newer_target_rejected_before_stop(self):
        self.write(self.target,'workbench-release.json',json.dumps({'version':'2099.1.1'}))
        with self.assertRaisesRegex(RuntimeError,'拒绝降级'):
            update.apply_update(self.source,self.target,lambda _:None)
        update.stop_services.assert_not_called()

    def test_same_or_nested_directory_rejected(self):
        for target in [self.source,self.source/'child',self.base]:
            with self.assertRaisesRegex(RuntimeError,'单独目录'):
                update.validate_target(self.source,target)

    def test_path_escape_rejected(self):
        for name in ['../outside.py','/absolute','D:/wrong.py','browser_extension/../../outside.py','a\\b']:
            with self.assertRaises(RuntimeError): update.safe_path(self.target,name)

    def test_junction_destination_rejected(self):
        # Windows directory links are detected without following them.
        with patch.object(Path,'is_symlink',return_value=True):
            with self.assertRaisesRegex(RuntimeError,'目录链接'): update.safe_path(self.target,'backend.py')

class LaunchVersionTests(unittest.TestCase):
    def response(self,data):
        result=Mock(); result.__enter__=Mock(return_value=result); result.__exit__=Mock()
        result.read.return_value=json.dumps(data).encode(); return result

    def test_old_backend_cannot_pass_launch_readiness(self):
        with patch.object(launcher.urllib.request,'urlopen',return_value=self.response({'ok':True,'service':'temu-workbench'})):
            self.assertFalse(launcher.current_version_ready())

    def test_other_installation_cannot_pass_launch_readiness(self):
        with patch.object(launcher.urllib.request,'urlopen',return_value=self.response({'version':VERSION,'installation_id':'other'})):
            self.assertFalse(launcher.current_version_ready())

    def test_matching_backend_and_frontend_pass(self):
        value={'version':VERSION,'installation_id':identity(launcher.ROOT)}
        with patch.object(launcher.urllib.request,'urlopen',return_value=self.response(value)):
            self.assertTrue(launcher.current_version_ready())

    def test_foreign_port_reports_update_entry(self):
        with patch.object(processes,'listener_roots',return_value={5173:Path('C:/old')}):
            with self.assertRaisesRegex(RuntimeError,'UPDATE.cmd'): processes.check_ports(Path('C:/new'))

    def test_existing_vinext_root_is_recognized_even_with_package_links(self):
        p=Mock(); p.exe.return_value='C:/runtime/node.exe'
        p.cwd.return_value=str(launcher.ROOT)
        p.cmdline.return_value=['node',str(launcher.ROOT/'node_modules/vinext/dist/cli.js'),'dev']
        self.assertEqual(processes.service_root(p),launcher.ROOT.resolve())

    def test_embedded_command_path_never_identifies_service(self):
        p=Mock(); p.exe.return_value='C:/Python/python.exe'
        p.cmdline.return_value=['python','-c',str(launcher.ROOT/'backend.py')]
        self.assertIsNone(processes.service_root(p))

if __name__=='__main__': unittest.main()
