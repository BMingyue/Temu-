"""Browser-decode regressions for the site's image-size validation.

The fixture writes model dimensions exclusively from native image load/error
events. All browser traffic is intercepted and API image reads use a fake.
No seller site, user data, upload endpoint or publication action is involved.
"""
import io
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from PIL import Image
from playwright.sync_api import sync_playwright

from main import AppConfig, find_browser
import tshirt_automation as tshirt


def jpeg(size):
    stream = io.BytesIO()
    Image.new("RGB", size, "navy").save(stream, "JPEG")
    return stream.getvalue()


class ImageResponse:
    def __init__(self, url, body):
        self.url = url
        self.status = 200
        self._body = body
        self.disposed = False

    def body(self):
        return self._body

    def dispose(self):
        self.disposed = True


class SiteImageMetadataTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch(
            executable_path=find_browser(AppConfig().browser_path), headless=True)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()

    def setUp(self):
        self.elapsed = 0.0
        self.api_calls = []
        self.api_responses = []
        self.browser_requests = []
        self.logs = []
        self.page = self.browser.new_page()
        self.addCleanup(self.page.close)
        clock = patch.object(tshirt.time, "monotonic", lambda: self.elapsed)
        clock.start()
        self.addCleanup(clock.stop)

    def scene(self, count=1, initially_good=0, browser_size=(1350, 1800),
              api_size=(1350, 1800)):
        urls = [f"https://offline.invalid/colour-{index}.jpg" for index in range(count)]
        good = set(urls[:initially_good])
        browser_bytes = jpeg(browser_size)
        api_bytes = jpeg(api_size)

        def intercept(route):
            request = route.request
            self.browser_requests.append((request.method, request.url))
            self.assertEqual("GET", request.method)
            if request.url in good:
                route.fulfill(body=browser_bytes, content_type="image/jpeg")
            else:
                route.abort()

        self.page.route("**/*", intercept)
        self.page.set_content("""<!doctype html><meta charset="utf-8">
            <div id="cell"><div class="image-box"></div></div>
            <script>
            window.siteModel = [];
            window.imageEvents = [];
            window.siteSizeValid = () => siteModel.every(image =>
                (image.width || 0) >= 1340 && (image.height || 0) >= 1785);
            window.makeImages = urls => urls.forEach((url, index) => {
                siteModel.push({url});
                const card = document.createElement('div');
                card.className = 'single-image';
                const image = document.createElement('img');
                image.width = 30;
                image.height = 30;
                image.onload = event => {
                    siteModel[index].width = event.target.naturalWidth;
                    siteModel[index].height = event.target.naturalHeight;
                    imageEvents.push({index, event: 'load'});
                };
                image.onerror = () => {
                    delete siteModel[index].width;
                    delete siteModel[index].height;
                    imageEvents.push({index, event: 'error'});
                };
                card.appendChild(image);
                document.querySelector('.image-box').appendChild(card);
                image.src = url;
            });
            </script>""")
        self.page.evaluate("urls => makeImages(urls)", urls)
        self.page.wait_for_function("Array.from(document.images).every(image => image.complete)")

        def get(url, **kwargs):
            self.api_calls.append((url, kwargs))
            self.assertIn(url, urls)
            self.assertEqual({"timeout": 10000, "max_redirects": 0}, kwargs)
            response = ImageResponse(url, api_bytes)
            self.api_responses.append(response)
            return response

        request_patch = patch.object(self.page.context.request, "get", side_effect=get)
        request_patch.start()
        self.addCleanup(request_patch.stop)

        def sleep(seconds):
            self.elapsed += seconds
            self.page.wait_for_timeout(1)

        uploader = SimpleNamespace(
            page=self.page,
            config=AppConfig(upload_wait_seconds=0, operation_timeout_seconds=1),
            _check_stop=lambda: None,
            _check_album_upload_space=lambda: None,
            _sleep=sleep,
            log=self.logs.append,
        )
        return uploader, self.page.locator("#cell"), urls

    def wait(self, uploader, cell, count):
        return tshirt._wait_color_images(uploader, cell, count, [(1350, 1800)] * count)

    def assert_read_only(self):
        self.assertTrue(all(method == "GET" for method, _ in self.browser_requests))
        self.assertTrue(all(response.disposed for response in self.api_responses))

    def test_api_image_bytes_must_reach_native_load_and_site_model_before_return(self):
        uploader, cell, urls = self.scene()
        self.assertFalse(self.page.evaluate("siteSizeValid()"))
        before = cell.inner_html()
        self.assertEqual(urls, self.wait(uploader, cell, 1))
        self.assertEqual(before, cell.inner_html())
        self.assertTrue(self.page.evaluate("siteSizeValid()"))
        self.assertEqual([{ "url": urls[0], "width": 1350, "height": 1800}],
                         self.page.evaluate("siteModel"))
        self.assertEqual(1, len(self.api_calls))
        self.assertGreater(self.page.evaluate("imageEvents.filter(event => event.event === 'load').length"), 0)
        self.assert_read_only()

    def test_nine_images_with_two_broken_previews_have_nine_valid_site_models(self):
        uploader, cell, urls = self.scene(count=9, initially_good=7)
        self.assertFalse(self.page.evaluate("siteSizeValid()"))
        self.assertEqual(urls, self.wait(uploader, cell, 9))
        self.assertTrue(self.page.evaluate("siteSizeValid()"))
        self.assertEqual(urls, self.page.evaluate("siteModel.map(image => image.url)"))
        self.assertEqual(9, cell.locator(".single-image").count())
        self.assertEqual(urls[7:], [url for url, _ in self.api_calls])
        self.assertTrue(all(image["width"] == 1350 and image["height"] == 1800
                            for image in self.page.evaluate("siteModel")))
        self.assert_read_only()

    def test_successful_api_read_cannot_pass_when_route_cannot_restore_browser_image(self):
        uploader, cell, _ = self.scene()
        # The original all-network interception still aborts every image.
        # Recovery cannot install its temporary byte-supplying route.
        with patch.object(self.page, "route", side_effect=RuntimeError("offline route unavailable")):
            with self.assertRaises((tshirt.TshirtAutomationError, RuntimeError)):
                self.wait(uploader, cell, 1)
        self.assertTrue(self.api_calls)
        self.assertFalse(self.page.evaluate("siteSizeValid()"))
        self.assertEqual(0, self.page.evaluate("imageEvents.filter(event => event.event === 'load').length"))
        self.assert_read_only()

    def test_successful_api_read_cannot_pass_when_no_browser_load_event_occurs(self):
        uploader, cell, _ = self.scene()
        # Simulate the image component no longer accepting source assignments.
        # No bytes decode and no site onload callback can write dimensions.
        cell.locator("img").evaluate("""image => {
            const original = image.setAttribute.bind(image);
            const originalSrc = image.src;
            Object.defineProperty(image, 'src', {get: () => originalSrc, set: () => {}});
            image.setAttribute = (name, value) => {
                if (name !== 'src') original(name, value);
            };
        }""")
        with self.assertRaises(tshirt.TshirtAutomationError):
            self.wait(uploader, cell, 1)
        self.assertTrue(self.api_calls)
        self.assertFalse(self.page.evaluate("siteSizeValid()"))
        self.assertEqual(0, self.page.evaluate("imageEvents.filter(event => event.event === 'load').length"))
        self.assert_read_only()

    def test_loaded_wrong_dimensions_never_use_read_only_probe_to_hide_site_failure(self):
        uploader, cell, _ = self.scene(initially_good=1, browser_size=(1200, 1600))
        with self.assertRaises(tshirt.TshirtAutomationError):
            self.wait(uploader, cell, 1)
        self.assertFalse(self.page.evaluate("siteSizeValid()"))
        self.assertEqual([], self.api_calls)
        self.assert_read_only()

    def test_probe_bytes_below_site_minimum_do_not_recover_a_broken_preview(self):
        uploader, cell, _ = self.scene(api_size=(1200, 1600))
        with self.assertRaises(tshirt.TshirtAutomationError):
            self.wait(uploader, cell, 1)
        self.assertTrue(self.api_calls)
        self.assertFalse(self.page.evaluate("siteSizeValid()"))
        self.assert_read_only()


if __name__ == "__main__":
    unittest.main()
