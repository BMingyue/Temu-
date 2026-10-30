"""Exercise real file choosers against an in-memory image upload server.

Uploaded bytes are served back to Chromium, so natural dimensions reflect the
actual selected file rather than a constant square fixture. No seller site is
opened and no save or publish controls are involved.
"""
from __future__ import annotations

import io
import tempfile
import threading
import unittest
from pathlib import Path
from urllib.parse import urlsplit
from unittest.mock import patch

from PIL import Image
from playwright.sync_api import sync_playwright

from main import AppConfig, DxmUploader, ProductJob, find_browser
import tshirt_automation as tshirt

try:
    from tests.test_tshirt_automation import FIXTURE
except ImportError:
    from test_tshirt_automation import FIXTURE


UPLOAD_FIXTURE = FIXTURE.replace('</body>', r'''
<div class="mainImage"><label>产品轮播图</label>
  <div class="img-list"></div>
  <button onclick="document.querySelector('#localMenu').style.display='block'">选择图片</button>
</div>
<script>
window.receivedFiles=[];
let uploadSerial=0;
document.querySelector('#upload').onchange=async event=>{
  const files=Array.from(event.target.files);
  const row=activeColor;
  document.querySelector('#localMenu').style.display='none';
  const urls=[];
  for(const file of files) {
    const url=`http://offline.test/uploaded/${++uploadSerial}/${encodeURIComponent(file.name)}`;
    const response=await fetch(url,{method:'PUT',body:file});
    if(!response.ok) throw new Error('offline upload failed');
    urls.push(url);
  }
  receivedFiles.push({row,urls,names:files.map(file=>file.name)});
  if(window.testProfile==='blanket') {
    document.querySelector('.mainImage .img-list').innerHTML=urls.map(url=>
      `<div class="single-image"><img width="50" height="50" src="${url}"
        onload="this.nextElementSibling.textContent=this.naturalWidth+' X '+this.naturalHeight">
        <span>0 X 0</span><a class="icon_delete" onclick="this.parentElement.remove()">delete</a></div>`).join('');
  } else {
    document.querySelectorAll('#colors .image-box')[row].innerHTML=urls.map(url=>card(url)).join('');
  }
  event.target.value='';
};
</script></body>''')


class ImageUploadPolicyBrowserTests(unittest.TestCase):
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
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.uploaded_bytes = {}
        self.unexpected_requests = []
        old = io.BytesIO()
        Image.new('RGB', (24, 24), 'grey').save(old, 'JPEG')
        self.old_bytes = old.getvalue()
        self.page = self.browser.new_page()
        self.addCleanup(self.page.close)
        self.page.route('**/*', self._route)
        self.page.goto('http://offline.test/policy')
        self.elapsed = 10.0
        clock = patch('tshirt_automation.time.monotonic', lambda: self.elapsed)
        clock.start()
        self.addCleanup(clock.stop)

    def _route(self, route):
        request = route.request
        path = urlsplit(request.url).path
        if request.url == 'http://offline.test/policy':
            route.fulfill(body=UPLOAD_FIXTURE, content_type='text/html; charset=utf-8')
        elif request.method == 'PUT' and path.startswith('/uploaded/'):
            self.uploaded_bytes[request.url] = request.post_data_buffer
            route.fulfill(status=204)
        elif request.url in self.uploaded_bytes:
            route.fulfill(body=self.uploaded_bytes[request.url], content_type='image/jpeg')
        elif path == '/image/old.jpg':
            route.fulfill(body=self.old_bytes, content_type='image/jpeg')
        else:
            self.unexpected_requests.append(request.url)
            route.abort()

    def _source(self, name, size, color):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        Image.new('RGB', size, color).save(path)
        return path

    def _uploader(self, profile, mode):
        config = AppConfig(listing_profile=profile, image_processing_mode=mode,
            image_target_width=800, image_target_height=1000, image_max_edge=400,
            operation_timeout_seconds=2, upload_wait_seconds=0)
        logs = []
        uploader = DxmUploader(config, logs.append, threading.Event(),
            upload_stage_dir=self.root / 'stage')
        uploader.page = self.page
        uploader._sleep = lambda seconds: setattr(self, 'elapsed', self.elapsed + seconds)
        uploader._top_dialog = lambda: self.page.locator(
            '#' + self.page.locator('[role=dialog]:visible').last.get_attribute('id'))
        self.page.evaluate('profile=>{window.testProfile=profile;receivedFiles=[]}', profile)
        if profile == 'blanket':
            # Keep the normal scoped label/button lookup unique in this fixture.
            self.page.locator('#colors').evaluate("el=>el.style.display='none'")
        elif profile == 'tshirt_bw':
            self.page.evaluate("""() => document.querySelectorAll('#colors tbody > tr')
                .forEach((row,index)=>row.children[0].textContent=index?'黑色':'白色')""")
        return uploader

    def _exercise(self, profile, mode, sources_in_stage=False):
        uploader = self._uploader(profile, mode)
        if sources_in_stage:
            directory = uploader.upload_stage_dir
            if profile != 'blanket':
                directory /= 'tshirt'
            # Reversed source names exposed the old fixed 01/02 overwrite bug.
            names = [directory / name for name in ('02.jpg', '01.jpg', '03.jpg', '04.jpg')]
        else:
            names = ['white landscape.png', 'black portrait.webp',
                     'white small detail.jpg', 'black small detail.png']
        white = self._source(names[0], (600, 300), 'white')
        black = self._source(names[1], (300, 600), 'black')
        white_detail = self._source(names[2], (180, 90), 'ivory')
        black_detail = self._source(names[3], (90, 180), 'navy')
        sources = [white, black, white_detail, black_detail]
        before = {source: source.read_bytes() for source in sources}
        originals = {}
        for source in sources:
            with Image.open(source) as image:
                originals[source] = image.size
        job = ProductJob(self.root, 'Offline Policy Product', [white, black])
        if profile == 'blanket':
            expected_sources = [[white, black]]
            uploader._upload_carousel(job)
            selector = '.mainImage .img-list img'
        elif profile == 'tshirt_bw':
            sets = {'white': [white, white_detail], 'black': [black, black_detail]}
            expected_sources = [sets['white'], sets['black']]
            tshirt.upload_images(uploader, job, ['white001', 'black001'],
                uploader._prepare_upload_image, sets)
            selector = '#colors .image-box img'
        else:
            expected_sources = [[white, black], [white, black]]
            tshirt.upload_images(uploader, job, ['first001', 'second001'],
                uploader._prepare_upload_image)
            selector = '#colors .image-box img'

        batches = self.page.evaluate('receivedFiles')
        self.assertEqual(len(expected_sources), len(batches))
        actual_dimensions = []
        for batch, batch_sources in zip(batches, expected_sources):
            self.assertEqual(len(batch_sources), len(batch['urls']))
            for url, source in zip(batch['urls'], batch_sources):
                uploaded = self.uploaded_bytes[url]
                with Image.open(io.BytesIO(uploaded)) as image:
                    size = image.size
                actual_dimensions.append(size)
                if mode == 'original':
                    self.assertEqual(before[source], uploaded,
                        'Original mode must send the original file bytes and format')
                    self.assertEqual(originals[source], size)
                elif mode == 'square':
                    self.assertEqual((800, 1000), size)
                    self.assertTrue(url.endswith('.jpg'))
                else:
                    width, height = originals[source]
                    scale = min(1, 400 / max(width, height))
                    self.assertEqual((round(width * scale), round(height * scale)), size)
                    self.assertLessEqual(max(size), 400)
        browser_dimensions = self.page.locator(selector).evaluate_all(
            'els=>els.map(el=>[el.naturalWidth,el.naturalHeight])')
        self.assertEqual([list(size) for size in actual_dimensions], browser_dimensions)
        self.assertFalse(any(size == (1200, 1200) for size in actual_dimensions))
        self.assertEqual(before, {source: source.read_bytes() for source in sources},
            'Processing and uploading must never rewrite the source files')
        self.assertFalse(list(uploader.upload_stage_dir.glob('carousel-*')),
            'Per-upload temporary files must be removed after success')
        self.assertFalse(list((uploader.upload_stage_dir / 'tshirt').glob('upload-*')))
        if mode == 'original' and not sources_in_stage:
            self.assertFalse(uploader.upload_stage_dir.exists(),
                'Original uploads must not create a staging directory')
        self.assertFalse(self.unexpected_requests)

        if profile != 'blanket':
            tshirt.refresh_material_image(uploader)
            self.assertEqual(uploader._tshirt_image_urls[0],
                self.page.locator('.material-img-module img').get_attribute('src'))
            self.page.locator('#batch').evaluate("el=>el.style.display='block'")
            tshirt.choose_description_images(uploader, all_images=True)
            expected = (uploader._tshirt_all_image_urls if profile == 'tshirt_bw'
                        else uploader._tshirt_image_urls)
            self.assertEqual(expected, self.page.evaluate('chosen'))
            self.page.evaluate("""() => document.querySelector('#wirelessDescContentBox').innerHTML=
                chosen.map(url=>`<img src="${url}">`).join('')""")
            tshirt.verify_description_images(uploader)

    def test_blanket_original_bytes_and_rectangular_dimensions(self):
        self._exercise('blanket', 'original')

    def test_blanket_fit_landscape_and_portrait(self):
        self._exercise('blanket', 'fit')

    def test_blanket_custom_800_by_1000(self):
        self._exercise('blanket', 'square')

    def test_tshirt_original_bytes_and_rectangular_dimensions(self):
        self._exercise('tshirt', 'original')

    def test_tshirt_fit_landscape_and_portrait(self):
        self._exercise('tshirt', 'fit')

    def test_tshirt_custom_800_by_1000(self):
        self._exercise('tshirt', 'square')

    def test_blackwhite_original_bytes_and_separate_details(self):
        self._exercise('tshirt_bw', 'original')

    def test_blackwhite_fit_preserves_small_details(self):
        self._exercise('tshirt_bw', 'fit')

    def test_blackwhite_custom_800_by_1000(self):
        self._exercise('tshirt_bw', 'square')

    def test_blanket_sources_inside_old_stage_are_preserved_in_all_modes(self):
        for mode in ('original', 'fit', 'square'):
            with self.subTest(mode=mode):
                self._exercise('blanket', mode, sources_in_stage=True)

    def test_tshirt_old_stage_source_names_cannot_be_overwritten(self):
        for mode in ('original', 'fit', 'square'):
            with self.subTest(mode=mode):
                self._exercise('tshirt', mode, sources_in_stage=True)

    def test_blackwhite_old_stage_source_names_cannot_be_overwritten(self):
        for mode in ('original', 'fit', 'square'):
            with self.subTest(mode=mode):
                self._exercise('tshirt_bw', mode, sources_in_stage=True)

    def test_failed_preparation_removes_only_the_fresh_upload_directory(self):
        for profile in ('blanket', 'tshirt', 'tshirt_bw'):
            with self.subTest(profile=profile):
                uploader = self._uploader(profile, 'square')
                source_dir = uploader.upload_stage_dir
                if profile != 'blanket':
                    source_dir /= 'tshirt'
                    self.page.locator('#colors').evaluate("el=>el.style.display='table'")
                source = self._source(source_dir / '01.jpg', (600, 300), 'ivory')
                other = self._source(source_dir / '02.jpg', (300, 600), 'navy')
                before = {path: path.read_bytes() for path in (source, other)}
                prepare = uploader._prepare_upload_image

                def fail_after_write(source_path, target):
                    prepare(source_path, target)
                    raise RuntimeError('fixture preparation failed')

                job = ProductJob(self.root, 'Failure Fixture Product', [source, other])
                with self.assertRaisesRegex(RuntimeError, 'fixture preparation failed'):
                    if profile == 'blanket':
                        uploader._prepare_upload_image = fail_after_write
                        uploader._upload_carousel(job)
                    else:
                        sets = {'white': [source], 'black': [other]} if profile == 'tshirt_bw' else None
                        tshirt.upload_images(uploader, job, ['first001', 'second001'],
                            fail_after_write, sets)
                self.assertEqual(before, {path: path.read_bytes() for path in before})
                self.assertFalse(list(uploader.upload_stage_dir.glob('carousel-*')))
                self.assertFalse(list((uploader.upload_stage_dir / 'tshirt').glob('upload-*')))


if __name__ == '__main__':
    unittest.main()
