import json
import threading
import unittest
import urllib.error
import urllib.request
from unittest.mock import patch

import backend


class AcceleratorTargetsApiTests(unittest.TestCase):
    def test_read_only_get_uses_validated_product_targets_and_returns_errors(self):
        server = backend.BoundedThreadingHTTPServer(('127.0.0.1', 0), backend.Handler, max_workers=2)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        url = f'http://127.0.0.1:{server.server_port}/api/features/product-status/accelerator-targets?mall_id=123'
        value = {'success': True, 'mallId': '123', 'spuIds': ['100001'],
                 'catalogCaptured': '2026-10-28T08:23:32+00:00', 'targetHash': 'a'*64, 'complete': True}
        try:
            with patch.object(backend.product_operations, 'accelerator_targets', return_value=value) as targets:
                with urllib.request.urlopen(url, timeout=3) as response:
                    self.assertEqual(json.loads(response.read()), value)
                targets.assert_called_once_with(backend.connect, '123')
            with patch.object(backend.product_operations, 'accelerator_targets', side_effect=ValueError('快照已过期')):
                with self.assertRaises(urllib.error.HTTPError) as raised:
                    urllib.request.urlopen(url, timeout=3)
                self.assertEqual(raised.exception.code, 400)
                self.assertEqual(json.loads(raised.exception.read()), {'error': '快照已过期'})
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=3)


if __name__ == '__main__':
    unittest.main()
