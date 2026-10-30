import http.client
import json
import threading
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch, Mock
import sys
import backend
import portable_web
import service_supervisor as supervisor


class PortableWebTests(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.static = Path(self.temp.name) / 'web'
        self.static.mkdir()
        (self.static / 'index.html').write_text('<html>portable</html>', encoding='utf-8')
        (Path(self.temp.name) / 'private.txt').write_text('private', encoding='utf-8')
        self.patches = [patch.object(portable_web, 'STATIC', self.static)]
        for item in self.patches: item.start()
        self.server = backend.BoundedThreadingHTTPServer(('127.0.0.1', 0), portable_web.Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(3)
        for item in reversed(self.patches): item.stop()
        self.temp.cleanup()

    def request(self, path, method='GET', headers=None, body=None):
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=3)
        conn.request(method, path, body=body, headers=headers or {})
        response = conn.getresponse()
        result = response.status, response.read()
        conn.close()
        return result

    def test_serves_static_and_rejects_private_files_and_directory_listing(self):
        self.assertEqual(self.request('/')[0], 200)
        self.assertEqual(self.request('/../private.txt')[0], 404)
        self.assertEqual(self.request('/%2e%2e/private.txt')[0], 404)
        self.assertEqual(self.request('/web/')[0], 404)
        self.assertEqual(self.request('/', headers={'Host':'attacker.test'})[0], 403)

    def test_frontend_version_and_html_have_no_store_cache_policy(self):
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=3)
        conn.request('GET','/__workbench__/version')
        response = conn.getresponse()
        self.assertEqual(response.status,200)
        self.assertEqual(json.loads(response.read())['version'],portable_web.health_identity()['version'])
        self.assertIn('no-store',response.getheader('Cache-Control'))
        conn.close()
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=3)
        conn.request('GET','/',headers={'If-Modified-Since':'Wed, 01 Jan 2100 00:00:00 GMT'})
        response = conn.getresponse()
        self.assertIn('no-store',response.getheader('Cache-Control'))
        response.read(); conn.close()

    def test_api_status_and_write_headers_are_preserved(self):
        api = backend.BoundedThreadingHTTPServer(('127.0.0.1', 0), backend.Handler)
        thread = threading.Thread(target=api.serve_forever, daemon=True); thread.start()
        try:
            with patch.object(portable_web, 'BACKEND_PORT', api.server_port):
                status, body = self.request('/api/health')
                self.assertEqual(status, 200)
                self.assertEqual(json.loads(body)['service'], 'temu-workbench')
                with patch.object(backend, 'launch_tool', return_value={'message':'reviewed'}) as launch:
                    status, body = self.request('/api/launch', 'POST', {'Content-Type':'application/json','X-Workbench':'local','Origin':'http://127.0.0.1:5173'}, '{"tool":"uploader"}')
                    self.assertEqual(status, 200)
                    launch.assert_called_once_with('uploader')
                status, _ = self.request('/api/launch', 'POST', {'Content-Type':'application/json','X-Workbench':'local','Origin':'https://attacker.test'}, '{"tool":"uploader"}')
                self.assertEqual(status, 403)
        finally:
            api.shutdown(); api.server_close(); thread.join(3)

    def test_portable_supervisor_starts_bundled_python_without_node(self):
        with patch.object(supervisor, 'PORTABLE', True), patch.object(supervisor, 'listener_process', return_value=None), patch.object(supervisor, 'our_frontend_processes', return_value=[]), patch.object(supervisor.subprocess, 'Popen') as spawn:
            self.assertTrue(supervisor.restart_frontend())
            self.assertEqual(spawn.call_args.args[0], [sys.executable, str(supervisor.WEB_SERVER)])

    def test_portable_process_identity_rejects_another_installation(self):
        process = Mock()
        process.exe.return_value = sys.executable
        process.cmdline.return_value = [sys.executable, str(supervisor.WEB_SERVER)]
        with patch.object(supervisor, 'PORTABLE', True):
            self.assertTrue(supervisor.is_our_frontend(process))
            process.cmdline.return_value = [sys.executable, 'C:/other/portable_web.py']
            self.assertFalse(supervisor.is_our_frontend(process))


if __name__ == '__main__':
    unittest.main()
