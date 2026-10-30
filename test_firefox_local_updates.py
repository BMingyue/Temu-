import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
import zipfile
from release.firefox_local_channel import GECKO_ID, publish, register_policy, publish_registered, synchronize_profile


def package(path, version, ident=GECKO_ID):
    with zipfile.ZipFile(path, 'w') as archive:
        archive.writestr('manifest.json', json.dumps(dict(version=version, browser_specific_settings=dict(gecko=dict(id=ident)))))


class LocalFirefoxUpdateTests(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.old = self.root/'existing-policy.xpi'
        self.new = self.root/'new.xpi'
        package(self.old, '0.3.40')
        package(self.new, '0.4.0')
        self.config = self.root/'data'/'channels.json'
        self.policy = self.root/'policies.json'
        self.policy.write_text(json.dumps(dict(policies=dict(ExtensionSettings={GECKO_ID: dict(
            installation_mode='normal_installed', install_url=self.old.as_uri())}))), encoding='utf-8')

    def tearDown(self):
        self.temp.cleanup()

    def test_register_and_publish_preserves_policy_and_previous_package(self):
        original_policy = self.policy.read_bytes()
        original_xpi = self.old.read_bytes()
        register_policy(self.policy, self.config)
        rows = publish_registered(self.new, self.root, self.config)
        self.assertEqual(len(rows), 2)
        self.assertEqual(self.old.read_bytes(), self.new.read_bytes())
        self.assertEqual(self.policy.read_bytes(), original_policy)
        backups = list((self.config.parent/'firefox-extension-backups').glob('*.xpi'))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_bytes(), original_xpi)
        self.assertFalse(any(row['changed'] for row in publish_registered(self.new, self.root, self.config)))

    def test_reject_other_extension_and_downgrade(self):
        package(self.new, '0.4.0', 'different-addon')
        with self.assertRaisesRegex(ValueError, 'Not the workbench'):
            publish(self.new, self.old, self.root/'backups')
        package(self.new, '0.3.30')
        with self.assertRaisesRegex(ValueError, 'downgrade'):
            publish(self.new, self.old, self.root/'backups')

    def test_only_existing_local_policy_is_supported(self):
        self.policy.write_text(json.dumps(dict(policies=dict(ExtensionSettings={GECKO_ID: dict(
            installation_mode='normal_installed', install_url='https://example.com/a.xpi')}))), encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'local-file'):
            register_policy(self.policy, self.config)

    def test_future_build_updates_same_policy_file_without_profile_writes(self):
        register_policy(self.policy, self.config)
        publish_registered(self.new, self.root, self.config)
        package(self.new, '0.4.1')
        publish_registered(self.new, self.root, self.config)
        with zipfile.ZipFile(self.old) as archive:
            self.assertEqual(json.loads(archive.read('manifest.json'))['version'], '0.4.1')

    def test_live_profile_is_never_modified_and_closed_profile_updates(self):
        profile = self.root/'temu-workbench-dev'
        (profile/'extensions').mkdir(parents=True)
        installed=profile/'extensions'/(GECKO_ID+'.xpi')
        package(installed,'0.3.40')
        old=installed.read_bytes()
        self.assertTrue(synchronize_profile(self.new,profile,self.root/'backup',running=lambda _:True)['deferred'])
        self.assertEqual(installed.read_bytes(),old)
        synchronize_profile(self.new,profile,self.root/'backup',running=lambda _:False)
        self.assertEqual(installed.read_bytes(),self.new.read_bytes())


if __name__ == '__main__':
    unittest.main()
