"""Reproduce icon-font accessible names without any live seller page or request."""
import unittest

try:
    from tests import test_tshirt_automation as fixture
except ImportError:
    import test_tshirt_automation as fixture

from main import prepare_carousel_jpg
import tshirt_automation as module


class ImagePickerIconRegressionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        fixture.TshirtOfflineBrowserTests.setUpClass.__func__(cls)

    @classmethod
    def tearDownClass(cls):
        fixture.TshirtOfflineBrowserTests.tearDownClass.__func__(cls)

    setUp = fixture.TshirtOfflineBrowserTests.setUp
    job = fixture.TshirtOfflineBrowserTests.job

    def add_arrows(self):
        self.page.add_style_tag(content='.icon_down::before { content: "\\e007"; }')
        self.page.evaluate('''() => {
            for(const button of document.querySelectorAll('#colors button, #batch button')) {
                button.innerHTML = '<span>选择图片</span><span class="iconfont icon_down"></span>';
            }
        }''')

    def blackwhite(self):
        self.uploader.config.listing_profile = 'tshirt_bw'
        self.page.evaluate('''() => document.querySelectorAll('#colors tbody > tr')
            .forEach((row,index)=>row.children[0].textContent=index?'黑色':'白色')''')

    def test_live_style_icon_name_does_not_make_enabled_bw_button_unavailable(self):
        self.blackwhite()
        self.add_arrows()
        cell = self.page.locator('#colors tbody > tr').first.locator('td').last
        self.assertEqual(0,cell.get_by_role('button',name='选择图片',exact=True).count())
        self.assertIn('\ue007',cell.aria_snapshot())
        self.assertTrue(cell.locator('button').is_enabled())
        self.assertEqual(['white','black'],module.validate_bw_rows(self.uploader))
        self.assertTrue(module._image_picker_button(cell,'颜色图：').is_enabled())

    def test_bw_upload_and_description_work_with_arrows_and_hidden_duplicate_buttons(self):
        self.blackwhite()
        self.add_arrows()
        self.page.evaluate('''() => {
            for(const cell of document.querySelectorAll('#colors tbody > tr > td:last-child')) {
                const hidden=document.createElement('button'); hidden.textContent='选择图片';
                hidden.style.display='none'; cell.append(hidden);
            }
        }''')
        job = self.job(3)
        white,black,common=job.images
        module.upload_images(self.uploader,job,['white001','black001'],prepare_carousel_jpg,
                             {'white':[white,common],'black':[black,common]})
        module.refresh_material_image(self.uploader)
        self.page.locator('#batch').evaluate("el=>el.style.display='block'")
        module.choose_description_images(self.uploader,all_images=True)
        self.assertEqual(self.uploader._tshirt_all_image_urls,self.page.evaluate('chosen'))

    def test_ordinary_tshirt_upload_keeps_working_with_css_arrow(self):
        self.add_arrows()
        job=self.job(1)
        module.upload_images(self.uploader,job,['first001','second001'],prepare_carousel_jpg)
        self.assertEqual(2,len(self.page.evaluate("Array.from(document.querySelectorAll('#colors .image-box')).map(e=>e.querySelectorAll('img').length)")))
        self.assertEqual(1,len(self.uploader._tshirt_image_urls))

    def test_real_disabled_button_still_blocks_before_any_row_mutation(self):
        self.blackwhite()
        self.add_arrows()
        self.page.locator('#colors button').last.evaluate('el=>el.disabled=true')
        before=self.page.locator('#colors').inner_html()
        with self.assertRaisesRegex(module.TshirtAutomationError,'被禁用'):
            module.validate_bw_rows(self.uploader)
        self.assertEqual(before,self.page.locator('#colors').inner_html())

    def test_visible_duplicate_and_missing_button_have_specific_errors(self):
        self.blackwhite()
        self.add_arrows()
        cell=self.page.locator('#colors tbody > tr').first.locator('td').last
        cell.evaluate("e=>e.append(e.querySelector('button').cloneNode(true))")
        with self.assertRaisesRegex(module.TshirtAutomationError,'多个'):
            module.validate_bw_rows(self.uploader)
        cell.locator('button').evaluate_all('els=>els.forEach(e=>e.remove())')
        with self.assertRaisesRegex(module.TshirtAutomationError,'未找到'):
            module.validate_bw_rows(self.uploader)

    def test_aria_disabled_button_is_not_treated_as_usable(self):
        self.blackwhite()
        self.add_arrows()
        self.page.locator('#colors button').last.evaluate("el=>el.setAttribute('aria-disabled','true')")
        with self.assertRaisesRegex(module.TshirtAutomationError,'被禁用'):
            module.validate_bw_rows(self.uploader)


if __name__=='__main__':
    unittest.main()
