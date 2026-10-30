"""Local-only integration checks; all push/fetch targets are disposable bare repos."""
import contextlib
import importlib.util
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('git_manager', Path(__file__).with_name('git_manager.py'))
manager = importlib.util.module_from_spec(spec)
spec.loader.exec_module(manager)


class RemoteValidationTests(unittest.TestCase):
    def test_accepted_addresses_are_not_rewritten(self):
        for value in ('https://github.com/example/project.git', 'git@github.com:example/project.git',
                      'ssh://git@example.com:22/example/project.git', 'https://gitee.com/example/project'):
            self.assertEqual(manager.validate_remote(value), value)

    def test_credentials_local_paths_queries_and_options_are_rejected(self):
        for value in ('https://person:example-secret@github.com/a/b.git', 'https://example-secret@github.com/a/b',
                      'https://github.com/a/b?access=example', 'https://github.com/a/b#fragment',
                      'ssh://person@example.com/a/b', 'ssh://git:example-secret@example.com/a/b',
                      '/tmp/source', 'file:///tmp/source', '-oProxyCommand=example',
                      'git@github.com:/absolute', 'git@github.com:../outside', 'https://github.com/a/../b',
                      'https://github.com/a b', 'https://github.com', 'https://github.com:99999/a/b'):
            with self.subTest(value=value), self.assertRaises(manager.GitError):
                manager.validate_remote(value)

    def test_failure_text_redacts_accidental_url_credentials_and_parameters(self):
        value = manager.redact('fatal https://person:example-secret@host/a/b?access=example#x failed')
        self.assertNotIn('example-secret', value)
        self.assertNotIn('access=example', value)


class LocalRepositoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='git-helper-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)/'中文 源码'
        self.root.mkdir()
        # These settings affect child fixture commands only, never real/global Git.
        self.env = patch.dict(os.environ, {'GIT_CONFIG_GLOBAL': os.devnull, 'GIT_CONFIG_NOSYSTEM': '1'})
        self.env.start(); self.addCleanup(self.env.stop)
        self.git = shutil.which('git')
        self.call(self.root, 'init', '-b', 'main')
        self.call(self.root, 'config', 'user.name', 'Fixture Maintainer')
        self.call(self.root, 'config', 'user.email', 'fixture@localhost')
        (self.root/'README.md').write_text('initial\n', encoding='utf-8')
        (self.root/'.gitignore').write_text('data/\n.env*\nruntime/\n', encoding='utf-8')
        self.call(self.root, 'add', 'README.md', '.gitignore')
        self.call(self.root, 'commit', '-m', 'Initial fixture')
        self.repo = manager.Repository(self.root)

    def call(self, root, *args):
        result = subprocess.run([self.git, '-c', 'core.quotepath=false', '-C', str(root), *args], capture_output=True,
                                encoding='utf-8', errors='replace', check=True,
                                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        return result.stdout.strip()

    def touch(self, name, text='new\n'):
        path = self.root/name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding='utf-8')
        return path

    def checked_commit(self, names, message='fixture update'):
        status = self.repo.status()
        return self.repo.commit(message, names, status['snapshot'])

    def bare(self):
        bare = Path(self.temp.name)/'remote.git'
        bare.mkdir(); self.call(bare, 'init', '--bare', '-b', 'main')
        self.call(self.root, 'remote', 'add', 'origin', str(bare))
        # Public validation still rejects local paths. Only this test patches
        # the validator; real Git subprocesses read the local fixture origin.
        route = patch.object(self.repo, 'origin', return_value='https://fixture.invalid/project.git')
        route.start(); self.addCleanup(route.stop)
        self.repo.push()
        other = Path(self.temp.name)/'other'
        self.call(Path(self.temp.name), 'clone', str(bare), str(other))
        self.call(other, 'config', 'user.name', 'Other Fixture')
        self.call(other, 'config', 'user.email', 'other@localhost')
        return bare, other

    def other_commit(self, other, name='remote.py', text='print(2)\n'):
        path = other/name; path.parent.mkdir(parents=True, exist_ok=True); path.write_text(text)
        self.call(other, 'add', name); self.call(other, 'commit', '-m', 'Remote fixture update')
        self.call(other, 'push', 'origin', 'main')

    def test_requires_exact_repository_root(self):
        nested = self.root/'nested'; nested.mkdir()
        with self.assertRaisesRegex(manager.GitError, '根目录'):
            manager.Repository(nested)

    def test_connect_is_local_and_refuses_origin_replacement(self):
        self.repo.connect('https://github.com/example/first.git')
        self.repo.connect('https://github.com/example/first.git')
        with self.assertRaisesRegex(manager.GitError, '不会覆盖'):
            self.repo.connect('https://github.com/example/second.git')
        self.assertEqual(self.repo.origin(), 'https://github.com/example/first.git')

    def test_only_checked_files_are_committed_with_unicode(self):
        self.touch('新的 文件.py', 'print(1)\n'); self.touch('not-selected.py')
        self.checked_commit(['新的 文件.py'])
        self.assertIn('新的 文件.py', self.call(self.root, 'show', '--pretty=', '--name-only', 'HEAD'))
        self.assertEqual([item['path'] for item in self.repo.status()['entries']], ['not-selected.py'])

    def test_changed_contents_with_same_status_force_new_review(self):
        self.touch('main.py', 'first\n'); status = self.repo.status()
        self.touch('main.py', 'second\n')
        old = self.repo.head()
        with self.assertRaisesRegex(manager.GitError, '已变化'):
            self.repo.commit('update', ['main.py'], status['snapshot'])
        self.assertEqual(self.repo.head(), old)

    def test_preexisting_unchecked_staging_is_never_committed(self):
        self.touch('checked.py'); self.touch('other.py'); self.call(self.root, 'add', 'other.py')
        with self.assertRaisesRegex(manager.GitError, '其他工具暂存'):
            self.checked_commit(['checked.py'])
        self.assertEqual(self.call(self.root, 'diff', '--cached', '--name-only'), 'other.py')

    def test_private_files_and_binary_payloads_cannot_be_selected(self):
        self.touch('config.json'); self.touch('payload.exe')
        for name in ('config.json', 'payload.exe'):
            with self.subTest(name=name), self.assertRaisesRegex(manager.GitError, '受保护'):
                self.checked_commit([name])

    def test_nested_credentials_and_runtime_paths_are_protected(self):
        for value in ('data/workbench.sqlite3', 'state/session.json', 'runtime/python/python.exe',
                      'folder/.env.local', 'browser-profile/Default/Cookies', 'local_tools/qualification/assets/a.jpg'):
            self.assertTrue(manager.private_reason(value))

    def test_big_untracked_files_are_protected(self):
        path = self.root/'huge.txt'
        with path.open('wb') as stream: stream.truncate(manager.MAX_FILE_BYTES + 1)
        self.assertTrue(self.repo.status()['entries'][0]['protected'])

    def test_deletions_and_renames_are_committed(self):
        self.call(self.root, 'mv', 'README.md', 'renamed.md')
        self.checked_commit(['renamed.md'])
        self.assertFalse((self.root/'README.md').exists())
        (self.root/'renamed.md').unlink(); self.checked_commit(['renamed.md'])
        self.assertNotIn('renamed.md', self.call(self.root, 'ls-files'))

    def test_local_identity_fallback_does_not_change_config(self):
        self.call(self.root, 'config', '--unset', 'user.name'); self.call(self.root, 'config', '--unset', 'user.email')
        self.touch('main.py'); self.checked_commit(['main.py'])
        self.assertIn('maintainer@localhost', self.call(self.root, 'show', '-s', '--format=%ae'))
        self.assertNotIn('user.email', self.call(self.root, 'config', '--local', '--list'))

    def test_push_missing_origin_rejected_without_network(self):
        with self.assertRaisesRegex(manager.GitError, '先填写'):
            self.repo.push()

    def test_different_push_url_is_rejected_before_any_network(self):
        self.call(self.root, 'remote', 'add', 'origin', 'https://github.com/example/expected.git')
        self.call(self.root, 'config', 'remote.origin.pushurl', 'https://github.com/example/other.git')
        with self.assertRaisesRegex(manager.GitError, '推送地址不同'):
            self.repo.push()

    def test_credential_push_url_is_rejected_without_exposing_its_value(self):
        self.call(self.root, 'remote', 'add', 'origin', 'https://github.com/example/expected.git')
        self.call(self.root, 'config', 'remote.origin.pushurl', 'https://person:example-secret@github.com/example/other.git')
        with self.assertRaises(manager.GitError) as failure:
            self.repo.push()
        self.assertNotIn('example-secret', str(failure.exception))

    def test_push_to_disposable_bare_origin_uses_normal_nonforce_push(self):
        bare, other = self.bare()
        self.touch('main.py'); self.checked_commit(['main.py']); self.repo.push()
        self.assertEqual(self.repo.head(), self.call(bare, 'rev-parse', 'refs/heads/main'))

    def test_fast_forward_preserves_private_ignored_records(self):
        bare, other = self.bare()
        self.touch('data/records.json', 'do not touch')
        self.other_commit(other)
        self.repo.pull()
        self.assertEqual((self.root/'data/records.json').read_text(), 'do not touch')
        self.assertEqual((self.root/'remote.py').read_text(), 'print(2)\n')
        self.assertEqual(self.repo.head(), self.call(bare, 'rev-parse', 'refs/heads/main'))

    def test_dirty_pull_does_not_overwrite_local_source(self):
        bare, other = self.bare(); self.other_commit(other)
        self.touch('README.md', 'local uncommitted')
        old = self.repo.head()
        with self.assertRaisesRegex(manager.GitError, '未保存'):
            self.repo.pull()
        self.assertEqual(self.repo.head(), old)
        self.assertEqual((self.root/'README.md').read_text(), 'local uncommitted')

    def test_diverged_history_is_not_reset_or_merged(self):
        bare, other = self.bare(); self.other_commit(other)
        self.touch('local.py'); self.checked_commit(['local.py']); old = self.repo.head()
        with self.assertRaisesRegex(manager.GitError, '各自的新版本'):
            self.repo.pull()
        self.assertEqual(self.repo.head(), old)
        self.assertFalse((self.root/'remote.py').exists())

    def test_ahead_local_history_is_kept(self):
        bare, other = self.bare()
        self.touch('local.py'); self.checked_commit(['local.py']); old = self.repo.head()
        self.assertIn('领先', self.repo.pull())
        self.assertEqual(self.repo.head(), old)

    def test_remote_private_tree_is_rejected_before_worktree_changes(self):
        bare, other = self.bare()
        path = other/'data'/'bad.json'; path.parent.mkdir(); path.write_text('private fixture')
        self.call(other, 'add', '-f', 'data/bad.json'); self.call(other, 'commit', '-m', 'Unsafe fixture')
        self.call(other, 'push', 'origin', 'main')
        old = self.repo.head()
        with self.assertRaisesRegex(manager.GitError, '运行目录'):
            self.repo.pull()
        self.assertEqual(self.repo.head(), old)
        self.assertFalse((self.root/'data/bad.json').exists())

    def test_current_private_tracked_tree_is_rejected_before_push(self):
        bare, other = self.bare()
        self.touch('data/private.json')
        self.call(self.root, 'add', '-f', 'data/private.json'); self.call(self.root, 'commit', '-m', 'Unsafe fixture')
        old_remote = self.call(bare, 'rev-parse', 'refs/heads/main')
        with self.assertRaisesRegex(manager.GitError, '运行目录'):
            self.repo.push()
        self.assertEqual(self.call(bare, 'rev-parse', 'refs/heads/main'), old_remote)


if __name__ == '__main__': unittest.main()
