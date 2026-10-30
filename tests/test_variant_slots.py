import threading
import unittest
from main import AppConfig, DxmUploader, find_browser
from playwright.sync_api import sync_playwright


class VariantSlotsTest(unittest.TestCase):
    def test_hover_only_buttons_and_dynamic_variant_count(self):
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=find_browser(AppConfig.load().browser_path))
            page = browser.new_page()
            page.set_content('''<style>.close-btn{display:none}.result-item:hover .close-btn{display:block}</style>
                <div id="dialog"><div class="upload-module"><div class="upload-item"><img src="data:,new">source</div></div>
                <div class="result-module"></div></div>''')
            page.evaluate('''() => {
                const root=document.querySelector('.result-module');
                for(let i=0;i<3;i++) {
                    const slot=document.createElement('div'); slot.className='result-item';
                    slot.innerHTML='<img src="data:,old"><div class="close-btn">remove</div>';
                    slot.querySelector('.close-btn').onclick=()=>slot.querySelector('img').remove(); root.append(slot);
                }
                document.querySelector('.upload-item').onclick=()=>{
                    const slot=[...root.children].find(s=>!s.querySelector('img'));
                    if(slot) {const img=document.createElement('img');img.src='data:,new';slot.append(img);}
                };
            }''')
            uploader=DxmUploader(AppConfig(variant_count=4),lambda _:None,threading.Event())
            uploader.page=page
            def save(_):
                self.assertEqual(['data:,new']*3,page.locator('.result-item img').evaluate_all('els=>els.map(e=>e.getAttribute("src"))'))
                page.locator('#dialog').evaluate('e=>e.style.display="none"')
            uploader._click_dialog_button=save
            uploader._fill_variant_slots(page.locator('#dialog'))
            browser.close()
