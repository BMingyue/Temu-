"""Serve the prebuilt workbench on loopback, proxying only its local API."""
import http.client
import json
import os
from pathlib import Path
from http.server import SimpleHTTPRequestHandler
from urllib.parse import unquote, urlsplit
from backend import BoundedThreadingHTTPServer
from workbench_version import health_identity

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / 'web-dist'
BACKEND_PORT = int(os.environ.get('TEMU_WORKBENCH_PORT', '18769'))
WEB_PORT = int(os.environ.get('TEMU_WORKBENCH_WEB_PORT', '5173'))
HOP_HEADERS = {'connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailers','transfer-encoding','upgrade'}


class Handler(SimpleHTTPRequestHandler):
    timeout = 30
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, '.js':'application/javascript', '.css':'text/css', '.svg':'image/svg+xml'}

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(STATIC), **kwargs)

    def log_message(self, *args):
        pass

    def local_host(self):
        return self.headers.get('Host', '').split(':')[0] in ('127.0.0.1', 'localhost')

    def proxy(self):
        if not self.local_host():
            return self.send_error(403)
        try:
            size = int(self.headers.get('Content-Length', '0'))
        except ValueError:
            return self.send_error(400)
        if size < 0 or size > 100_000_000 or self.headers.get('Transfer-Encoding'):
            return self.send_error(413)
        body = self.rfile.read(size) if size else None
        headers = {k:v for k,v in self.headers.items() if k.lower() not in HOP_HEADERS | {'host'}}
        connection = http.client.HTTPConnection('127.0.0.1', BACKEND_PORT, timeout=60)
        started = False
        try:
            connection.request(self.command, self.path, body=body, headers=headers)
            response = connection.getresponse()
            self.send_response(response.status)
            for key, value in response.getheaders():
                if key.lower() not in HOP_HEADERS | {'server','date'}:
                    self.send_header(key, value)
            self.send_header('Connection', 'close')
            self.end_headers()
            started = True
            if self.command != 'HEAD':
                while chunk := response.read(65536):
                    self.wfile.write(chunk)
        except (OSError, http.client.HTTPException):
            if not started:
                self.send_error(502, 'Local data service unavailable')
        finally:
            connection.close()
            self.close_connection = True

    def end_headers(self):
        # HTML must be revalidated after an in-place upgrade.
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def version(self, head=False):
        data = json.dumps({'service':'temu-workbench-web', **health_identity()}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        if not head:
            self.wfile.write(data)

    def do_GET(self):
        if not self.local_host():
            return self.send_error(403)
        if urlsplit(self.path).path == '/__workbench__/version':
            return self.version()
        if urlsplit(self.path).path.startswith('/api/'):
            return self.proxy()
        self.static()

    def do_HEAD(self):
        if not self.local_host():
            return self.send_error(403)
        if urlsplit(self.path).path == '/__workbench__/version':
            return self.version(head=True)
        if urlsplit(self.path).path.startswith('/api/'):
            return self.proxy()
        self.static(head=True)

    def static(self, head=False):
        route = unquote(urlsplit(self.path).path)
        candidate = (STATIC / ('index.html' if route == '/' else route.lstrip('/'))).resolve()
        if not candidate.is_relative_to(STATIC.resolve()) or not candidate.is_file():
            return self.send_error(404)
        self.path = '/' + candidate.relative_to(STATIC.resolve()).as_posix()
        return super().do_HEAD() if head else super().do_GET()

    def do_POST(self):
        if urlsplit(self.path).path.startswith('/api/'):
            return self.proxy()
        self.send_error(404)

    def do_OPTIONS(self):
        if urlsplit(self.path).path.startswith('/api/'):
            return self.proxy()
        self.send_error(404)


if __name__ == '__main__':
    if not (STATIC / 'index.html').is_file():
        raise SystemExit('Missing web-dist/index.html')
    BoundedThreadingHTTPServer(('127.0.0.1', WEB_PORT), Handler).serve_forever()
