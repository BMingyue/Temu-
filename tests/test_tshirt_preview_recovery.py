"""Offline image-preview recovery: browser requests routed, API reads faked."""
import io
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from PIL import Image
from playwright.sync_api import sync_playwright

from main import AppConfig, StopRequested, find_browser
import tshirt_automation as tshirt


def jpeg(size):
    stream = io.BytesIO()
    Image.new('RGB', size, 'navy').save(stream, 'JPEG')
    return stream.getvalue()


class Response:
    def __init__(self, url, body=b'', status=200):
        self.url, self.status, self.payload = url, status, body
        self.disposed = False
        self.body_reads = 0

    def body(self):
        self.body_reads += 1
        return self.payload

    def dispose(self):
        self.disposed = True


class ReadOnlyAPI:
    def __init__(self, handler):
        self.handler = handler
        self.calls = []
        self.responses = []

    def get(self, url, **kwargs):
        self.calls.append((url, kwargs))
        response = self.handler(url, len(self.calls))
        self.responses.append(response)
        return response

    def post(self, *args, **kwargs):
        raise AssertionError('Recovery must not upload or mutate anything')


class TshirtPreviewRecoveryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch(
            executable_path=find_browser(AppConfig().browser_path), headless=True)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def setUp(self):
        self.elapsed = 0.0
        self.logs = []
        self.requests = []
        self.pages = []
        self.addCleanup(lambda: [page.close() for page in self.pages])
        clock = patch.object(tshirt.time, 'monotonic', lambda: self.elapsed)
        clock.start()
        self.addCleanup(clock.stop)

    def scene(self, urls, sizes=None, recover_after_first=False, api_handler=None):
        """Every browser URL is intercepted. APIRequestContext is never used."""
        self.elapsed = 0.0
        page = self.browser.new_page()
        self.pages.append(page)
        request_counts = {}
        bodies = {url: jpeg(size) for url, size in zip(urls, sizes or [])}

        def route(request_route):
            request = request_route.request
            self.requests.append((request.method, request.url))
            self.assertEqual('GET', request.method)
            request_counts[request.url] = request_counts.get(request.url, 0) + 1
            if (request.url in bodies and
                    (not recover_after_first or request_counts[request.url] > 1)):
                request_route.fulfill(body=bodies[request.url], content_type='image/jpeg')
            else:
                request_route.abort()

        page.route('**/*', route)
        page.set_content(f'<script>window.model=Array.from({{length:{len(urls)}}},()=>({{width:0,height:0}}));'
                         'window.loadCounts=Array(model.length).fill(0);</script>'
                         '<div id="cell"><div class="image-box">' + ''.join(
            f'<div class="single-image"><img width="30" height="30" src="{url}" '
            f'onload="model[{i}].width=this.naturalWidth;model[{i}].height=this.naturalHeight;loadCounts[{i}]++" '
            f'onerror="model[{i}].width=0;model[{i}].height=0"></div>'
            for i, url in enumerate(urls)) + '</div></div>')
        page.wait_for_function("Array.from(document.images).every(image => image.complete)")
        api = ReadOnlyAPI(api_handler or (lambda url, _: Response(url, jpeg((800, 1000)))))
        get_patch = patch.object(page.context.request, 'get', side_effect=api.get)
        get_patch.start()
        self.addCleanup(get_patch.stop)
        uploader = SimpleNamespace(
            page=page,
            config=AppConfig(upload_wait_seconds=0, operation_timeout_seconds=1),
            _check_stop=lambda: None, _check_album_upload_space=lambda: None,
            _sleep=lambda seconds: setattr(self, 'elapsed', self.elapsed + seconds),
            log=self.logs.append,
        )
        return uploader, page.locator('#cell'), api, request_counts

    def assert_read_only_calls(self, api):
        for _, kwargs in api.calls:
            self.assertEqual({'timeout': 10000, 'max_redirects': 0}, kwargs)
        self.assertTrue(all(response.disposed for response in api.responses))

    def test_broken_preview_recovers_by_reloading_same_url_without_api_or_upload(self):
        url = 'https://offline.invalid/reload.jpg'
        uploader, cell, api, requests = self.scene([url], [(800, 1000)], recover_after_first=True)
        self.assertEqual([url], tshirt._wait_color_images(uploader, cell, 1, [(800, 1000)]))
        self.assertEqual([], api.calls)
        self.assertGreaterEqual(requests[url], 2)
        self.assertLessEqual(requests[url], 3)
        self.assertEqual([url], cell.locator('img').evaluate_all('els => els.map(el => el.getAttribute("src"))'))
        self.assertEqual(1, cell.locator('.single-image').count())

    def test_persistent_broken_thumbnails_use_existing_assets_without_changing_order(self):
        urls = [f'https://offline.invalid/broken-{i}.jpg' for i in range(3)]
        sizes = [(800, 1000), (400, 200), (200, 400)]
        data = dict(zip(urls, [jpeg(size) for size in sizes]))
        uploader, cell, api, requests = self.scene(urls, api_handler=lambda url, _: Response(url, data[url]))
        before = cell.inner_html()
        self.assertEqual(urls, tshirt._wait_color_images(uploader, cell, 3, sizes))
        self.assertEqual(before, cell.inner_html())
        self.assertEqual(urls, [url for url, _ in api.calls])
        self.assertTrue(all(requests[url] <= 3 for url in urls))
        self.assert_read_only_calls(api)

    def test_nine_uploaded_cards_with_last_two_broken_keep_all_original_urls(self):
        # Match the observed incident: nine uploaded assets, seven readable
        # thumbnails and two broken previews, all prepared at 1350 x 1800.
        urls = [f'https://offline.invalid/nine-card-{i}.jpg' for i in range(9)]
        size = (1350, 1800)
        body = jpeg(size)
        uploader, cell, api, requests = self.scene(
            urls, [size] * 7, api_handler=lambda url, _: Response(url, body))
        self.assertEqual(7, cell.locator('img').evaluate_all(
            'els => els.filter(el => el.complete && el.naturalWidth > 0).length'))
        before = cell.inner_html()
        self.assertEqual(urls, tshirt._wait_color_images(uploader, cell, 9, [size] * 9))
        self.assertEqual(before, cell.inner_html())
        self.assertEqual(urls[-2:], [url for url, _ in api.calls])
        self.assertEqual(9, cell.locator('.single-image').count())
        self.assertEqual([1] * 7, [requests[url] for url in urls[:7]])
        self.assertTrue(all(requests[url] <= 3 for url in urls[-2:]))
        self.assertEqual([[1350, 1800]] * 9, uploader.page.evaluate('model.map(img=>[img.width,img.height])'))
        self.assertEqual([1] * 9, uploader.page.evaluate('loadCounts'))
        self.assert_read_only_calls(api)

    def test_original_and_fit_metadata_keep_actual_dimensions(self):
        for expected, actual in ((None, (321, 987)), ([(400, 200)], (400, 200))):
            with self.subTest(expected=expected):
                url = 'https://offline.invalid/original-or-fit.jpg'
                uploader, cell, api, _ = self.scene(
                    [url], api_handler=lambda url, _: Response(url, jpeg(actual)))
                self.assertEqual([url], tshirt._wait_color_images(uploader, cell, 1, expected))
                self.assert_read_only_calls(api)

    def test_loaded_wrong_dimensions_never_use_api_to_mask_mismatch(self):
        url = 'https://offline.invalid/wrong-size.jpg'
        uploader, cell, api, requests = self.scene([url], [(600, 300)])
        with self.assertRaisesRegex(tshirt.TshirtAutomationError, '实际 600×300，应为 800×1000'):
            tshirt._wait_color_images(uploader, cell, 1, [(800, 1000)])
        self.assertEqual([], api.calls)
        self.assertEqual(1, requests[url])

    def test_probe_wrong_dimensions_remain_blocked(self):
        url = 'https://offline.invalid/bad-asset-size.jpg'
        uploader, cell, api, _ = self.scene([url], api_handler=lambda url, _: Response(url, jpeg((600, 300))))
        with self.assertRaisesRegex(tshirt.TshirtAutomationError, '实际 600×300，应为 800×1000'):
            tshirt._wait_color_images(uploader, cell, 1, [(800, 1000)])
        self.assertEqual(1, len(api.calls))
        self.assert_read_only_calls(api)

    def test_redirect_invalid_data_and_network_errors_never_release_failure(self):
        cases = {
            'redirect': lambda url, _: Response(url, jpeg((800, 1000)), 302),
            'changed-url': lambda url, _: Response(url + '?redirected=1', jpeg((800, 1000))),
            'invalid': lambda url, _: Response(url, b'<html>not an image</html>'),
            'truncated': lambda url, _: Response(url, b'\xff\xd8\xff'),
            'http-error': lambda url, _: Response(url, jpeg((800, 1000)), 503),
        }
        for name, handler in cases.items():
            with self.subTest(case=name):
                url = f'https://offline.invalid/{name}.jpg'
                uploader, cell, api, requests = self.scene([url], api_handler=handler)
                with self.assertRaisesRegex(tshirt.TshirtAutomationError, '实际卡片 1 张，可读取 0 张'):
                    tshirt._wait_color_images(uploader, cell, 1, [(800, 1000)])
                self.assertEqual(2, len(api.calls))
                self.assertLessEqual(requests[url], 3)
                self.assert_read_only_calls(api)

        def timeout(url, count):
            raise TimeoutError('offline timeout')

        uploader, cell, api, _ = self.scene(['https://offline.invalid/timeout.jpg'], api_handler=timeout)
        with self.assertRaises(tshirt.TshirtAutomationError):
            tshirt._wait_color_images(uploader, cell, 1, [(800, 1000)])
        self.assertEqual(2, len(api.calls))

    def test_duplicate_urls_and_missing_cards_never_trigger_probes(self):
        url = 'https://offline.invalid/repeated.jpg'
        for urls, expected_count, message in (([url, url], 2, '存在重复图片地址'),
                                               ([url], 2, '实际卡片 1 张')):
            with self.subTest(urls=urls):
                uploader, cell, api, _ = self.scene(urls)
                with self.assertRaisesRegex(tshirt.TshirtAutomationError, message):
                    tshirt._wait_color_images(uploader, cell, expected_count)
                self.assertEqual([], api.calls)

    def test_api_metadata_does_not_release_a_preview_with_permanently_incomplete_dom(self):
        url = 'https://offline.invalid/still-loading.jpg'
        uploader, cell, api, _ = self.scene([url])
        cell.locator('img').evaluate("image => Object.defineProperty(image, 'complete', {get: () => false})")
        before = cell.inner_html()
        with self.assertRaisesRegex(tshirt.TshirtAutomationError, '网页尺寸未就绪的位置：1'):
            tshirt._wait_color_images(uploader, cell, 1, [(800, 1000)])
        self.assertEqual(before, cell.inner_html())
        self.assert_read_only_calls(api)

    def test_stop_after_probe_is_not_swallowed_and_disposes_response(self):
        url = 'https://offline.invalid/stop.jpg'
        stopped = threading.Event()

        def handler(url, count):
            stopped.set()
            return Response(url, jpeg((800, 1000)))

        uploader, cell, api, _ = self.scene([url], api_handler=handler)

        def check_stop():
            if stopped.is_set():
                raise StopRequested('offline stop')

        uploader._check_stop = check_stop
        with self.assertRaises(StopRequested):
            tshirt._wait_color_images(uploader, cell, 1, [(800, 1000)])
        self.assert_read_only_calls(api)


if __name__ == '__main__':
    unittest.main()
