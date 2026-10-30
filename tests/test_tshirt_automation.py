"""Offline T-shirt DOM regressions; no Dianxiaomi requests, saves or publishing."""
import io
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image
from playwright.sync_api import sync_playwright

from main import AppConfig, DxmUploader, ProductJob, find_browser, prepare_carousel_jpg
import tshirt_automation as tshirt


FIXTURE = r'''<!doctype html><html><head><meta charset="utf-8"></head><body>
<div class="ant-form-item"><label title="店铺账号">店铺账号</label><span class="ant-select-selection-item">fixture store</span></div>
<div class="ant-form-item"><label title="产品分类">产品分类</label><span class="ant-select-selection-item">fixture category</span></div>
<div class="ant-form-item"><label title="运费模板">运费模板</label><span class="ant-select-selection-item">fixture shipping</span></div>
<div class="material-img-module"><div class="single-image"><img width="50" height="50" src="http://offline.test/image/old.jpg"></div><a title="刷新" onclick="refreshMaterial()">autorenew</a></div>
<table id="colors"><thead><tr><th>颜色</th><th>SKC编码（货号）</th><th>图片(3-10张)批量</th></tr></thead><tbody></tbody></table>
<table id="skus"><thead><tr><th>SKU货号</th><th>申报价</th></tr></thead><tbody><tr><td><input value="keep-sku"></td><td><input value="19.00"></td></tr></tbody></table>
<div id="wirelessDescBox"><div id="wirelessDescContentBox"><img src="http://offline.test/image/old.jpg"></div></div>
<input id="upload" type="file" multiple style="display:none">
<div id="localMenu" class="ant-dropdown" style="display:none"><li data-menu-id="local" onclick="document.querySelector('#upload').click()">本地图片</li></div>
<div id="batch" role="dialog" style="display:none"><button onclick="document.querySelector('#descriptionMenu').style.display='block'">选择图片</button></div>
<div id="descriptionMenu" class="ant-dropdown" style="display:none"><li data-menu-id="sku_product_image" onclick="showReference()">引用skc轮播图</li></div>
<div id="picker" role="dialog" style="display:none"><label><input type="checkbox">全部</label><div class="ant-checkbox-group img-box"></div><button onclick="chooseReference()">选择</button></div>
<script>
let activeColor=0; let chosen=[];
function card(src) {return `<div class="single-image"><img width="50" height="50" src="${src}"><a class="icon_delete" onclick="this.parentElement.remove()">delete</a></div>`}
function resetRows(n) {
 document.querySelector('#colors tbody').innerHTML=Array.from({length:n},(_,i)=>`<tr><td>colour ${i}</td><td><input maxlength="22" value="old-${i}"></td><td><div class="image-box">${card('http://offline.test/image/old.jpg')}</div><button onclick="activeColor=${i};document.querySelector('#localMenu').style.display='block'">选择图片</button></td></tr>`).join('');
}
document.querySelector('#upload').onchange = event => {
 document.querySelector('#localMenu').style.display='none';
 document.querySelectorAll('#colors .image-box')[activeColor].innerHTML=Array.from(event.target.files).map(file=>card(`http://offline.test/image/${activeColor}/${file.name}`)).join('');
 event.target.value='';
};
function refreshMaterial() {
 document.querySelector('.material-img-module img').src=document.querySelector('#colors .image-box img').src;
}
function showReference() {
 document.querySelector('#descriptionMenu').style.display='none';
 const urls=['http://offline.test/image/old.jpg',...Array.from(document.querySelectorAll('#colors .image-box img')).map(img=>img.src)];
 document.querySelector('#picker .img-box').innerHTML=urls.map((url,i)=>`<label class="ant-checkbox-wrapper"><input type="checkbox" ${i===0?'checked':''}><div class="img-item"><img width="50" height="50" src="${url}"></div></label>`).join('');
 document.querySelector('#picker').style.display='block';
}
function chooseReference() {
 chosen=Array.from(document.querySelectorAll('#picker .img-box label')).filter(el=>el.querySelector('input').checked).map(el=>el.querySelector('img').src);
 document.querySelector('#picker').style.display='none';
}
resetRows(2);
</script></body></html>'''


class TshirtOfflineBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch(executable_path=find_browser(AppConfig.load().browser_path), headless=True)
        image = Image.new('RGB', (1200, 1200), 'white')
        buffer = io.BytesIO()
        image.save(buffer, 'JPEG')
        cls.image_bytes = buffer.getvalue()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.page = self.browser.new_page()
        self.addCleanup(self.page.close)
        self.page.route('**/*', lambda route: route.fulfill(body=self.image_bytes, content_type='image/jpeg'))
        self.page.set_content(FIXTURE)
        self.uploader = DxmUploader(AppConfig(operation_timeout_seconds=3, upload_wait_seconds=1),
                                    lambda _: None, threading.Event(), upload_stage_dir=self.root / 'stage')
        self.uploader.page = self.page
        # Keep browser IO synchronous, and advance module polling time without sleeps.
        self.elapsed = 0.0
        self.uploader._sleep = lambda seconds: setattr(self, 'elapsed', self.elapsed + seconds)
        self.clock = patch('tshirt_automation.time.monotonic', lambda: self.elapsed)
        self.clock.start()
        self.addCleanup(self.clock.stop)
        self.uploader._top_dialog = lambda: self.page.locator(
            '#' + self.page.locator('[role=dialog]:visible').last.get_attribute('id'))

    def job(self, count):
        sources = []
        for index in range(count):
            path = self.root / f'source-{index}.png'
            Image.new('RGB', (80 + index, 110), (index, 50, 90)).save(path)
            sources.append(path)
        return ProductJob(self.root, 'Safe Tshirt Title', sources)

    def test_colour_upload_material_and_description_with_two_colour_rows(self):
        self.assertEqual([], tshirt.template_problems(self.uploader))
        self.assertEqual(2, tshirt.color_row_count(self.uploader))
        job = self.job(3)
        tshirt.upload_images(self.uploader, job, ['20261023_test_0001', '20261023_test_0002'], prepare_carousel_jpg)
        self.assertEqual(['20261023_test_0001', '20261023_test_0002'],
                         self.page.locator('#colors input').evaluate_all('els=>els.map(el=>el.value)'))
        self.assertEqual(6, self.page.locator('#colors .image-box img').count())
        self.assertEqual(0, self.page.locator('#colors img[src$="old.jpg"]').count())
        self.assertEqual(['keep-sku', '19.00'],
                         self.page.locator('#skus input').evaluate_all('els=>els.map(el=>el.value)'))
        tshirt.refresh_material_image(self.uploader)
        self.assertEqual(self.uploader._tshirt_image_urls[0], self.page.locator('.material-img-module img').get_attribute('src'))
        self.page.locator('#batch').evaluate("el=>el.style.display='block'")
        tshirt.choose_description_images(self.uploader, all_images=True)
        self.assertEqual(self.uploader._tshirt_image_urls, self.page.evaluate('chosen'))
        self.page.evaluate("""() => {document.querySelector('#wirelessDescContentBox').innerHTML=
            chosen.map(src=>`<img src="${src}">`).join('')}""")
        tshirt.verify_description_images(self.uploader)

    def test_one_source_image_is_permitted_without_fabricated_duplicates(self):
        self.page.evaluate('resetRows(1)')
        tshirt.upload_images(self.uploader, self.job(1), ['20261023_test_0003'], prepare_carousel_jpg)
        self.assertEqual(1, self.page.locator('#colors .image-box img').count())
        self.assertEqual(1, len(self.uploader._tshirt_image_urls))

    def test_invalid_codes_are_rejected_before_any_template_mutation(self):
        for codes in [['x' * 23, 'valid'], ['repeat', 'repeat'], ['中文', 'valid'], ['one']]:
            before = self.page.locator('#colors').inner_html()
            with self.assertRaises(tshirt.TshirtAutomationError):
                tshirt.upload_images(self.uploader, self.job(1), codes, prepare_carousel_jpg)
            self.assertEqual(before, self.page.locator('#colors').inner_html())

    def test_material_refresh_mismatch_blocks_following_steps(self):
        self.uploader._tshirt_image_urls = ['http://offline.test/image/new.jpg']
        self.page.evaluate('refreshMaterial=()=>{}')
        with self.assertRaisesRegex(tshirt.TshirtAutomationError, '素材图刷新后未匹配'):
            tshirt.refresh_material_image(self.uploader)

    def test_missing_new_picture_cannot_reference_template_old_picture(self):
        self.uploader._tshirt_image_urls = ['http://offline.test/image/missing.jpg']
        self.page.locator('#batch').evaluate("el=>el.style.display='block'")
        with self.assertRaisesRegex(tshirt.TshirtAutomationError, '缺少当前商品新图'):
            tshirt.choose_description_images(self.uploader, all_images=True)
        self.assertEqual([], self.page.evaluate('chosen'))

    def test_saved_old_description_is_blocked(self):
        self.uploader._tshirt_description_urls = ['http://offline.test/image/new.jpg']
        with self.assertRaisesRegex(tshirt.TshirtAutomationError, '描述图与当前商品新图不一致'):
            tshirt.verify_description_images(self.uploader)

    def test_wrong_template_has_explicit_readiness_problem(self):
        self.page.locator('#colors').evaluate('el=>el.remove()')
        problems = tshirt.template_problems(self.uploader)
        self.assertTrue(any('T恤颜色表' in problem for problem in problems))


if __name__ == '__main__':
    unittest.main()
