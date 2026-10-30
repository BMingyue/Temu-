import unittest
from unittest.mock import Mock
import restart_workbench as restart


class RestartScopeTests(unittest.TestCase):
    def process(self, args, cwd=None, executable='C:/Python/python.exe'):
        process=Mock()
        process.cmdline.return_value=args
        process.exe.return_value=executable
        process.cwd.return_value=str(cwd or restart.ROOT)
        return process

    def test_exact_backend(self):
        self.assertTrue(restart.is_our_backend(self.process(['python',str(restart.ROOT/'backend.py')])))

    def test_relative_backend(self):
        self.assertTrue(restart.is_our_backend(self.process(['python','backend.py'])))

    def test_other_workspace_not_touched(self):
        self.assertFalse(restart.is_our_backend(self.process(['python','backend.py'],cwd='C:/another-workspace')))

    def test_embedded_path_not_touched(self):
        self.assertFalse(restart.is_our_backend(self.process(['python','-c',str(restart.ROOT/'backend.py')])))

    def test_other_runtime_not_touched(self):
        self.assertFalse(restart.is_our_backend(self.process(['node',str(restart.ROOT/'backend.py')],executable='C:/node.exe')))

    def test_unknown_identity_not_touched(self):
        process=self.process([])
        process.cmdline.side_effect=restart.psutil.AccessDenied()
        self.assertFalse(restart.is_our_backend(process))


if __name__=='__main__':
    unittest.main()
