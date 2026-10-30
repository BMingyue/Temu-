"""Black/white DOM regressions use synthetic HTML, without live store requests."""
import unittest
from pathlib import Path

try:
    from tests import test_tshirt_automation as fixture
except ImportError:
    import test_tshirt_automation as fixture

import tshirt_automation as tshirt
from main import prepare_carousel_jpg


class BlackWhiteTshirtTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        fixture.TshirtOfflineBrowserTests.setUpClass.__func__(cls)

    @classmethod
    def tearDownClass(cls):
        fixture.TshirtOfflineBrowserTests.tearDownClass.__func__(cls)

    setUp = fixture.TshirtOfflineBrowserTests.setUp
    job = fixture.TshirtOfflineBrowserTests.job

    def configure_bw(self, labels=("白色", "黑色")):
        self.uploader.config.listing_profile = "tshirt_bw"
        self.page.evaluate("""labels => {
            resetRows(labels.length);
            document.querySelectorAll('#colors tbody > tr').forEach((row, i) => row.children[0].textContent = labels[i]);
            window.uploadBatches = [];
            document.querySelector('#upload').onchange = event => {
                document.querySelector('#localMenu').style.display = 'none';
                const names = Array.from(event.target.files).map(file => file.name);
                uploadBatches.push({row: activeColor, names});
                document.querySelectorAll('#colors .image-box')[activeColor].innerHTML = names
                    .map(name => card(`http://offline.test/image/${name}?display-row=${activeColor}`)).join('');
                event.target.value = '';
            };
        }""", list(labels))

    def image_sets(self):
        job = self.job(3)
        white, black, common = job.images
        return job, {"white": [white, common], "black": [black, common]}

    def test_reversed_web_rows_match_labels_and_material_uses_actual_first_row(self):
        self.configure_bw(("黑色", "白色"))
        self.assertEqual(["black", "white"], tshirt.validate_bw_rows(self.uploader))
        job, sets = self.image_sets()
        prepared = {}

        def prepare(source: Path, target: Path):
            prepared[target.name] = source
            prepare_carousel_jpg(source, target)

        tshirt.upload_images(self.uploader, job, ["black001", "white001"], prepare, sets)
        batches = self.page.evaluate("uploadBatches")
        self.assertEqual([sets["black"][0], sets["black"][1]], [prepared[name] for name in batches[0]["names"]])
        self.assertEqual([sets["white"][0], sets["white"][1]], [prepared[name] for name in batches[1]["names"]])
        self.assertNotEqual(batches[0]["names"][0], batches[1]["names"][0])
        self.assertEqual(batches[0]["names"][1], batches[1]["names"][1])
        self.assertEqual(3, len(prepared))
        self.assertEqual(2, len(self.uploader._tshirt_color_image_urls["white"]))
        self.assertEqual(self.uploader._tshirt_color_image_urls["black"], self.uploader._tshirt_image_urls)
        tshirt.refresh_material_image(self.uploader)
        self.assertEqual(self.uploader._tshirt_image_urls[0], self.page.locator('.material-img-module img').get_attribute('src'))

    def test_reference_includes_both_main_images_and_shared_images_once(self):
        self.configure_bw()
        job, sets = self.image_sets()
        tshirt.upload_images(self.uploader, job, ["white001", "black001"], prepare_carousel_jpg, sets)
        self.assertEqual(3, len(self.uploader._tshirt_all_image_urls))
        self.page.locator('#batch').evaluate("el=>el.style.display='block'")
        tshirt.choose_description_images(self.uploader, all_images=True)
        self.assertEqual(self.uploader._tshirt_all_image_urls, self.page.evaluate('chosen'))
        selected_keys = {tshirt._url_key(url) for url in self.page.evaluate('chosen')}
        for color in ("white", "black"):
            self.assertIn(tshirt._url_key(self.uploader._tshirt_color_image_urls[color][0]), selected_keys)
        self.page.evaluate("""() => {document.querySelector('#wirelessDescContentBox').innerHTML =
            chosen.map(src => `<img src="${src}">`).join('')}""")
        tshirt.verify_description_images(self.uploader)

    def test_exact_english_color_labels_are_supported(self):
        self.configure_bw(("BLACK", "white"))
        self.assertEqual(["black", "white"], tshirt.bw_color_labels(self.uploader))

    def test_unknown_duplicate_or_missing_colors_fail_before_mutation(self):
        job, sets = self.image_sets()
        for labels in (("白色", "白色"), ("白色", "米白色"), ("black",), ("white", "black", "red")):
            with self.subTest(labels=labels):
                self.configure_bw(labels)
                before = self.page.locator('#colors').inner_html()
                with self.assertRaises(tshirt.TshirtAutomationError):
                    tshirt.upload_images(self.uploader, job, ["white001", "black001"], prepare_carousel_jpg, sets)
                self.assertEqual(before, self.page.locator('#colors').inner_html())

    def test_invalid_sets_and_readonly_controls_fail_before_mutation(self):
        job, sets = self.image_sets()
        for kind in ("missing", "empty", "too_many", "same_main", "cross_main", "readonly", "disabled_upload"):
            with self.subTest(kind=kind):
                self.configure_bw()
                supplied = {key: list(value) for key, value in sets.items()}
                if kind == "missing":
                    supplied.pop("black")
                elif kind == "empty":
                    supplied["black"] = []
                elif kind == "too_many":
                    supplied["white"] = [job.images[0]] * 11
                elif kind == "same_main":
                    supplied["black"][0] = supplied["white"][0]
                elif kind == "cross_main":
                    supplied["white"].append(supplied["black"][0])
                elif kind == "readonly":
                    self.page.locator('#colors input').last.evaluate('el=>el.readOnly=true')
                elif kind == "disabled_upload":
                    self.page.locator('#colors button').last.evaluate('el=>el.disabled=true')
                before = self.page.locator('#colors').inner_html()
                with self.assertRaises(tshirt.TshirtAutomationError):
                    tshirt.upload_images(self.uploader, job, ["white001", "black001"], prepare_carousel_jpg, supplied)
                self.assertEqual(before, self.page.locator('#colors').inner_html())


if __name__ == '__main__':
    unittest.main()
