import json
import socket
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import Mock, patch

import backend


class BoundedServerTests(unittest.TestCase):
    def make_server(self, workers=1):
        with patch.object(backend.ThreadingHTTPServer, '__init__', return_value=None):
            server = backend.BoundedThreadingHTTPServer(('127.0.0.1', 0), Mock(), max_workers=workers)
        server.shutdown_request = Mock()
        server.handle_error = Mock()
        return server

    def test_saturated_server_returns_503_without_spawning(self):
        server = self.make_server()
        self.assertTrue(server.worker_slots.acquire(blocking=False))
        request = Mock()
        server.process_request(request, ('127.0.0.1', 12345))
        payload = request.sendall.call_args.args[0]
        self.assertIn(b'503 Service Unavailable', payload)
        self.assertIn('本地数据服务繁忙'.encode(), payload)
        server.shutdown_request.assert_called_once_with(request)

    def test_thread_creation_failure_falls_back_inline_and_releases_slot(self):
        server = self.make_server()
        request = Mock()
        with patch.object(backend.ThreadingHTTPServer, 'process_request', side_effect=RuntimeError('can\'t start new thread')):
            server.finish_request = Mock()
            server.process_request(request, ('127.0.0.1', 12345))
        server.finish_request.assert_called_once_with(request, ('127.0.0.1', 12345))
        self.assertTrue(server.worker_slots.acquire(blocking=False), 'worker slot should be released')

    def test_get_exception_still_returns_json_error(self):
        server = backend.BoundedThreadingHTTPServer(
            ('127.0.0.1', 0), backend.Handler, max_workers=2
        )
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with patch.object(backend, 'snapshot', side_effect=RuntimeError('boom')):
                with self.assertRaises(urllib.error.HTTPError) as raised:
                    urllib.request.urlopen(
                        f'http://127.0.0.1:{server.server_port}/api/state',
                        timeout=3,
                    )
                self.assertEqual(raised.exception.code, 500)
                body = json.loads(raised.exception.read().decode('utf-8'))
                self.assertIn('本地读取失败', body['error'])
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=3)


class ExtensionBootstrapTests(unittest.TestCase):
    def start_server(self):
        server = backend.BoundedThreadingHTTPServer(
            ('127.0.0.1', 0), backend.Handler, max_workers=4
        )
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        return server, thread

    def request(self, server, path, *, origin=None, token=None):
        headers = {'Content-Type': 'application/json'}
        if origin:
            headers['Origin'] = origin
        if token:
            headers['Authorization'] = 'Bearer ' + token
        return urllib.request.urlopen(
            urllib.request.Request(
                f'http://127.0.0.1:{server.server_port}{path}',
                data=b'{}', headers=headers, method='POST',
            ), timeout=3,
        )

    def test_extension_origin_can_pair_and_use_returned_token(self):
        with TemporaryDirectory() as root, patch.object(backend, 'DATA', Path(root)):
            token = 'portable-test-token_' + 'x' * 32
            (Path(root) / 'bridge-token').write_text(token, encoding='utf-8')
            server, thread = self.start_server()
            try:
                origin = 'chrome-extension://' + 'a' * 32
                with self.request(server, '/api/bridge/gpt/bootstrap', origin=origin) as response:
                    value = json.loads(response.read().decode('utf-8'))
                    self.assertEqual(value['token'], token)
                    self.assertEqual(value['extension_version'], backend.gpt_extension_bridge.EXTENSION_VERSION)
                    self.assertEqual(response.headers['Access-Control-Allow-Origin'], origin)
                with self.request(server, '/api/bridge/gpt/watchdog', origin=origin, token=value['token']) as response:
                    self.assertEqual(response.status, 200)
                    self.assertIn('pending', json.loads(response.read().decode('utf-8')))
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=3)

    def test_normal_page_and_originless_request_cannot_obtain_token(self):
        with TemporaryDirectory() as root, patch.object(backend, 'DATA', Path(root)):
            (Path(root) / 'bridge-token').write_text('secret_' + 'x' * 32, encoding='utf-8')
            server, thread = self.start_server()
            try:
                for origin in (None, 'https://chatgpt.com'):
                    with self.subTest(origin=origin):
                        with self.assertRaises(urllib.error.HTTPError) as raised:
                            self.request(server, '/api/bridge/gpt/bootstrap', origin=origin)
                        self.assertEqual(raised.exception.code, 403)
                        self.assertNotIn('secret_', raised.exception.read().decode('utf-8'))
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=3)


if __name__ == '__main__':
    unittest.main()
