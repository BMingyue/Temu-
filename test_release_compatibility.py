"""Portable release contracts, without launching services or merchant actions."""
import importlib.util
from contextlib import redirect_stdout
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

import delta_update_workbench
import gpt_runner
import update_workbench

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('portable_build_contract', ROOT/'release/build_workbench_bundle.py')
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class ReleaseCompatibilityTests(unittest.TestCase):
    def test_traffic_version_comes_from_runner_export(self):
        with tempfile.TemporaryDirectory() as temp:
            extension = Path(temp)
            (extension/'traffic').mkdir()
            (extension/'traffic/runner.js').write_text(
                "globalThis.__temuTrafficAssistant = {version:'7.8.9', show(){}};", encoding='utf-8')
            self.assertEqual(builder.traffic_version(extension), '7.8.9')
            (extension/'traffic/runner.js').write_text('/* no runtime version */', encoding='utf-8')
            with self.assertRaisesRegex(RuntimeError, 'version'):
                builder.traffic_version(extension)

    def test_release_cannot_omit_new_local_runtime_import(self):
        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp)
            (source/'backend.py').write_text('import json\nfrom new_feature import action\n', encoding='utf-8')
            (source/'new_feature.py').write_text('def action(): pass\n', encoding='utf-8')
            with self.assertRaisesRegex(RuntimeError, 'new_feature.py'):
                builder.validate_production_sources(source, ('backend.py',))
            builder.validate_production_sources(source, ('backend.py', 'new_feature.py'))

    def test_archive_preserves_full_dotted_release_directory_name(self):
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp)/'Workbench-2026.11.02.1'
            output.mkdir()
            (output/'entry.txt').write_text('portable fixture', encoding='utf-8')
            with patch.object(builder, 'audit'), redirect_stdout(io.StringIO()):
                builder.archive(output)
            self.assertTrue((output.parent/'Workbench-2026.11.02.1.zip').is_file())
            self.assertFalse((output.parent/'Workbench-2026.11.02.zip').exists())

    def test_current_python_production_allowlist_is_closed(self):
        builder.validate_production_sources(ROOT, tuple(name for name in builder.PRODUCTION if name.endswith('.py')))

    def test_online_delivery_paths_are_explicitly_managed_without_directory_wildcard(self):
        for module in (update_workbench, delta_update_workbench):
            self.assertTrue(module.managed('从GitHub安装更新.cmd'))
            self.assertTrue(module.managed('maintenance/github_workbench_update.ps1'))
            self.assertFalse(module.managed('maintenance/unreviewed.ps1'))
            self.assertFalse(module.managed('maintenance/data/private.json'))
            self.assertFalse(module.managed('data/private.json'))

    def test_legacy_runner_uses_bundled_browser_in_a_path_with_spaces(self):
        with tempfile.TemporaryDirectory(prefix='工作台 同事 ') as temp:
            runner = gpt_runner.Runner.__new__(gpt_runner.Runner)
            runner.data = Path(temp)/'data'
            runner.context = None
            runner.pw = Mock()
            executable = Path(temp)/'runtime/Chrome for Testing/chrome.exe'
            with patch('gpt_browser_profiles._ensure_runtime', return_value=executable):
                runner._open()
            args, kwargs = runner.pw.chromium.launch_persistent_context.call_args
            self.assertEqual(args[0], str(runner.data/'gpt-browser'))
            self.assertEqual(kwargs['executable_path'], str(executable))
            self.assertNotIn('channel', kwargs)
            self.assertFalse(kwargs['headless'])
            runner.context.set_default_timeout.assert_called_once_with(60000)

    def test_existing_live_legacy_context_is_not_reopened(self):
        runner = gpt_runner.Runner.__new__(gpt_runner.Runner)
        runner.context = Mock()
        runner.context.pages = [Mock()]
        runner.pw = Mock()
        with patch('gpt_browser_profiles._ensure_runtime') as ensure:
            runner._open()
        ensure.assert_not_called()
        runner.pw.chromium.launch_persistent_context.assert_not_called()


if __name__ == '__main__':
    unittest.main()
