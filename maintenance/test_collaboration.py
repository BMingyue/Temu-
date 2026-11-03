"""Offline Git fixtures for the static collaboration gate; no business code runs."""
from __future__ import annotations

import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest


spec = importlib.util.spec_from_file_location('collaboration_gate', Path(__file__).with_name('check_collaboration.py'))
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)


class CollaborationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='tw-collaboration-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.git('init', '-q')
        self.git('config', 'user.name', 'Offline Test')
        self.git('config', 'user.email', 'test@example.invalid')
        self.git('config', 'core.autocrlf', 'false')
        self.put('README.md', b'Fixture only\n')
        self.git('add', '--', 'README.md')
        self.git('commit', '-qm', 'base')
        self.base = self.git('rev-parse', 'HEAD').strip()

    def git(self, *args, data=None):
        result = subprocess.run(['git', '-C', str(self.root), *args], input=data,
                                capture_output=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr.decode(errors='replace'))
        return result.stdout.decode()

    def put(self, name, data):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)

    def commit(self, name, data):
        self.put(name, data)
        self.git('add', '--', name)
        self.git('commit', '-qm', 'candidate')
        return self.git('rev-parse', 'HEAD').strip()

    def test_parses_python_and_json_without_executing_python(self):
        self.commit('change.py', b'raise RuntimeError("must never execute")\n')
        head = self.commit('manifest.json', b'{"version": "test"}\n')
        result = gate.check(self.root, self.base, head)
        self.assertEqual(result['python_syntax_checked'], ['change.py'])
        self.assertEqual(result['json_syntax_checked'], ['manifest.json'])
        self.assertTrue(result['ok'])

    def test_rejects_invalid_python(self):
        head = self.commit('change.py', b'def broken(\n')
        with self.assertRaisesRegex(gate.CheckError, 'Invalid .py syntax'):
            gate.check(self.root, self.base, head)

    def test_rejects_invalid_json(self):
        head = self.commit('manifest.json', b'{"unfinished":\n')
        with self.assertRaisesRegex(gate.CheckError, 'Invalid .json syntax'):
            gate.check(self.root, self.base, head)

    def test_rejects_python_scope_errors_without_executing(self):
        head = self.commit('change.py', b'return 1\n')
        with self.assertRaisesRegex(gate.CheckError, 'Invalid .py syntax'):
            gate.check(self.root, self.base, head)

    def test_rejects_nonstandard_json_constant(self):
        head = self.commit('manifest.json', b'{"value": NaN}\n')
        with self.assertRaisesRegex(gate.CheckError, 'Invalid .json syntax'):
            gate.check(self.root, self.base, head)

    def test_rejects_private_path_case_insensitively(self):
        head = self.commit('plugin/DATA/private.txt', b'fixture\n')
        with self.assertRaisesRegex(gate.CheckError, 'private directory'):
            gate.check(self.root, self.base, head)

    def test_rejects_private_filename(self):
        head = self.commit('plugin/credentials.json', b'{}\n')
        with self.assertRaisesRegex(gate.CheckError, 'private, binary'):
            gate.check(self.root, self.base, head)

    def test_rejects_release_binary(self):
        head = self.commit('release/tool.exe', b'fixture\n')
        with self.assertRaisesRegex(gate.CheckError, 'private, binary'):
            gate.check(self.root, self.base, head)

    def test_rejects_local_collaboration_configuration(self):
        head = self.commit('maintenance/local-collaboration.json', b'{}\n')
        with self.assertRaisesRegex(gate.CheckError, 'private, binary'):
            gate.check(self.root, self.base, head)

    def test_rejects_git_link_without_requiring_os_symlink_privileges(self):
        oid = self.git('hash-object', '-w', '--stdin', data=b'../private\n').strip()
        self.git('update-index', '--add', '--cacheinfo', '120000,' + oid + ',link')
        self.git('commit', '-qm', 'symlink candidate')
        with self.assertRaisesRegex(gate.CheckError, 'Links and submodules'):
            gate.check(self.root, self.base, 'HEAD')

    def test_rejects_submodule(self):
        self.git('update-index', '--add', '--cacheinfo', '160000,' + self.base + ',module')
        self.git('commit', '-qm', 'submodule candidate')
        with self.assertRaisesRegex(gate.CheckError, 'Links and submodules'):
            gate.check(self.root, self.base, 'HEAD')

    def test_rejects_oversized_source(self):
        head = self.commit('huge.txt', b'x' * (gate.MAX_FILE_BYTES + 1))
        with self.assertRaisesRegex(gate.CheckError, '20 MiB'):
            gate.check(self.root, self.base, head)

    def test_requires_exact_base_to_be_ancestor(self):
        first = self.commit('first.py', b'x = 1\n')
        self.git('checkout', '-q', '--detach', self.base)
        other = self.commit('other.py', b'x = 2\n')
        with self.assertRaisesRegex(gate.CheckError, 'not an ancestor'):
            gate.check(self.root, first, other)

    def test_rejects_committed_whitespace_errors(self):
        head = self.commit('change.py', b'x = 1   \n')
        with self.assertRaisesRegex(gate.CheckError, 'whitespace errors'):
            gate.check(self.root, self.base, head)

    def test_uses_committed_blob_instead_of_dirty_candidate_worktree(self):
        head = self.commit('change.py', b'x = 1\n')
        self.put('change.py', b'def broken(\n')
        self.assertTrue(gate.check(self.root, self.base, head)['ok'])

    def test_reports_control_changes_without_claiming_approval(self):
        head = self.commit('AGENTS.md', b'Rule changes need independent review.\n')
        result = gate.check(self.root, self.base, head)
        self.assertEqual(result['requires_special_review'], ['AGENTS.md'])
        self.assertIn('static-only', result['validation_scope'])

    def test_checks_full_head_tree_not_only_recent_diff(self):
        self.base = self.commit('runtime/private.txt', b'fixture\n')
        head = self.commit('change.py', b'x = 1\n')
        with self.assertRaisesRegex(gate.CheckError, 'private directory'):
            gate.check(self.root, self.base, head)

    def test_deleted_invalid_file_is_not_parsed(self):
        self.base = self.commit('invalid.py', b'def broken(\n')
        self.git('rm', '-q', '--', 'invalid.py')
        self.git('commit', '-qm', 'remove invalid file')
        self.assertTrue(gate.check(self.root, self.base, 'HEAD')['ok'])


if __name__ == '__main__':
    unittest.main()
