import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from PIL import Image, ImageOps

from image_processing import (
    ImageProcessingOptions,
    describe_options,
    dimensions_for_upload,
    options_from_config,
    prepared_upload_path,
    validate_options,
)


class ImageProcessingTests(unittest.TestCase):
    def setUp(self):
        scratch = tempfile.TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        self.root = Path(scratch.name)

    def source(self, size=(640, 320), mode="RGB", color="red", filename="original.png"):
        path = self.root / filename
        Image.new(mode, size, color).save(path)
        return path

    def assert_processed(self, source, options, expected):
        before = source.read_bytes()
        target = self.root / "prepared" / "image.jpg"
        result = prepared_upload_path(source, target, options)
        self.assertEqual(target, result)
        self.assertEqual(before, source.read_bytes())
        self.assertEqual(expected, dimensions_for_upload(source, options))
        with Image.open(result) as image:
            self.assertEqual("JPEG", image.format)
            self.assertEqual("RGB", image.mode)
            self.assertEqual(expected, image.size)
            self.assertIsNone(image.getexif().get(0x0112))
        return target

    def test_original_is_exact_same_png_and_does_not_create_destination(self):
        source = self.source(mode="RGBA", color=(10, 20, 30, 40))
        before = source.read_bytes()
        target = self.root / "not-created" / "image.jpg"
        options = ImageProcessingOptions(mode="original", width=0, height="unused", max_edge=None)
        self.assertEqual(source, prepared_upload_path(source, target, options))
        self.assertFalse(target.parent.exists())
        self.assertEqual(before, source.read_bytes())
        self.assertEqual((640, 320), dimensions_for_upload(source, options))
        with Image.open(source) as image:
            self.assertEqual("PNG", image.format)
            self.assertEqual("RGBA", image.mode)

    def test_original_does_not_decode_or_reencode_animated_file(self):
        source = self.root / "animated.gif"
        Image.new("RGB", (210, 200), "red").save(
            source, save_all=True, append_images=[Image.new("RGB", (210, 200), "blue")], duration=100, loop=0
        )
        before = source.read_bytes()
        self.assertEqual(source, prepared_upload_path(source, self.root / "ignored.jpg", ImageProcessingOptions(mode="original")))
        self.assertEqual(before, source.read_bytes())
        with Image.open(source) as image:
            self.assertEqual(2, image.n_frames)

    def test_fit_landscape_and_portrait_preserve_ratio(self):
        for size, expected in (((2400, 1200), (1000, 500)), ((1200, 2400), (500, 1000))):
            with self.subTest(size=size):
                source = self.source(size=size)
                self.assert_processed(source, ImageProcessingOptions(mode="fit", max_edge=1000), expected)

    def test_fit_never_enlarges_small_image(self):
        source = self.source(size=(321, 123))
        target = self.assert_processed(source, ImageProcessingOptions(mode="fit", max_edge=1200), (321, 123))
        with Image.open(target) as image:
            # The original rectangle fills the whole result; fit adds no canvas.
            self.assertGreater(image.getpixel((0, 0))[0], 245)
            self.assertLess(image.getpixel((0, 0))[1], 10)

    def test_fit_rounding_and_very_narrow_image_match_declared_dimensions(self):
        for size, expected in (((1999, 667), (1200, 400)), ((4001, 1), (1200, 1))):
            with self.subTest(size=size):
                self.assert_processed(self.source(size=size), ImageProcessingOptions(mode="fit"), expected)

    def test_default_is_legacy_1200_square_white_padding_without_crop(self):
        source = self.source(size=(800, 400))
        target = self.assert_processed(source, ImageProcessingOptions(), (1200, 1200))
        with Image.open(target) as image:
            self.assertEqual((255, 255, 255), image.getpixel((600, 50)))
            self.assertGreater(image.getpixel((600, 600))[0], 245)
            self.assertLess(image.getpixel((600, 600))[1], 10)

    def test_custom_rectangular_canvas_preserves_all_content(self):
        source = self.source(size=(300, 600))
        target = self.assert_processed(source, ImageProcessingOptions(width=800, height=1000), (800, 1000))
        with Image.open(target) as image:
            self.assertEqual((255, 255, 255), image.getpixel((30, 500)))
            # A portrait occupies the full height, with white only at the sides.
            self.assertGreater(image.getpixel((400, 1))[0], 245)
            self.assertLess(image.getpixel((400, 998))[1], 10)

    def test_transparent_pixels_are_composited_on_white(self):
        source = self.source(size=(200, 200), mode="RGBA", color=(255, 0, 0, 0))
        for options in (ImageProcessingOptions(mode="fit"), ImageProcessingOptions(width=200, height=200)):
            with self.subTest(mode=options.mode):
                result = self.assert_processed(source, options, (200, 200))
                with Image.open(result) as image:
                    self.assertEqual((255, 255, 255), image.getpixel((100, 100)))

    def test_palette_transparency_is_composited_on_white(self):
        source = self.root / "palette.png"
        image = Image.new("P", (200, 200), 0)
        image.putpalette([255, 0, 0] + [0, 0, 0] * 255)
        image.save(source, transparency=0)
        result = self.assert_processed(source, ImageProcessingOptions(mode="fit"), (200, 200))
        with Image.open(result) as image:
            self.assertEqual((255, 255, 255), image.getpixel((50, 50)))

    def test_exif_orientation_is_applied_to_generated_pixels_and_dimensions(self):
        source = self.root / "phone.jpg"
        image = Image.new("RGB", (800, 400), "red")
        image.paste("blue", (0, 200, 800, 400))
        exif = Image.Exif()
        exif[0x0112] = 6
        image.save(source, exif=exif, quality=95)
        before = source.read_bytes()
        self.assertEqual((400, 800), dimensions_for_upload(source, ImageProcessingOptions(mode="original")))
        self.assertEqual(source, prepared_upload_path(source, self.root / "unused.jpg", ImageProcessingOptions(mode="original")))
        result = self.assert_processed(source, ImageProcessingOptions(mode="fit", max_edge=400), (200, 400))
        with Image.open(source) as original, Image.open(result) as processed:
            expected = ImageOps.exif_transpose(original)
            # A rotation must change more than the dimension metadata.
            for point in ((20, 100), (180, 100)):
                original_point = (point[0] * 2, point[1] * 2)
                self.assertLess(sum(abs(a - b) for a, b in zip(processed.getpixel(point), expected.getpixel(original_point))), 15)
        self.assertEqual(before, source.read_bytes())

    def test_all_eight_exif_orientation_dimensions_match_saved_pixels(self):
        source = self.root / "oriented.jpg"
        for orientation in range(1, 9):
            with self.subTest(orientation=orientation):
                exif = Image.Exif()
                exif[0x0112] = orientation
                Image.new("RGB", (600, 300), "red").save(source, exif=exif)
                self.assert_processed(source, ImageProcessingOptions(mode="fit", max_edge=300),
                                      (150, 300) if orientation >= 5 else (300, 150))

    def test_processing_refuses_to_overwrite_source(self):
        source = self.source()
        before = source.read_bytes()
        with self.assertRaisesRegex(ValueError, "不能覆盖原图"):
            prepared_upload_path(source, source, ImageProcessingOptions())
        self.assertEqual(before, source.read_bytes())

    def test_original_requires_an_existing_source_file(self):
        for source in (self.root / "missing.png", self.root):
            with self.subTest(source=source), self.assertRaisesRegex(ValueError, "图片文件不存在"):
                prepared_upload_path(source, self.root / "ignored.jpg", ImageProcessingOptions(mode="original"))

    def test_invalid_modes_and_active_dimensions_are_rejected(self):
        for options in (
            ImageProcessingOptions(mode="crop"), ImageProcessingOptions(mode=""),
            ImageProcessingOptions(width=199), ImageProcessingOptions(height=4001),
            ImageProcessingOptions(width="1200"), ImageProcessingOptions(height=True),
            ImageProcessingOptions(mode="fit", max_edge=0), ImageProcessingOptions(mode="fit", max_edge=4001),
            ImageProcessingOptions(mode="fit", max_edge=1200.0), ImageProcessingOptions(mode="fit", max_edge=False),
        ):
            with self.subTest(options=options), self.assertRaises(ValueError):
                validate_options(options)
        validate_options(ImageProcessingOptions(width=200, height=4000, max_edge=0))
        validate_options(ImageProcessingOptions(mode="fit", max_edge=4000, width=0, height=None))
        validate_options(ImageProcessingOptions(mode="original", width=0, height=None, max_edge="unused"))

    def test_config_legacy_defaults_customization_and_chinese_summaries(self):
        self.assertEqual(ImageProcessingOptions(), options_from_config(SimpleNamespace()))
        self.assertEqual(ImageProcessingOptions("fit", 700, 900, 1600), options_from_config(SimpleNamespace(
            image_processing_mode="fit", image_target_width=700, image_target_height=900, image_max_edge=1600)))
        with self.assertRaisesRegex(ValueError, "不支持的图片处理模式"):
            options_from_config(SimpleNamespace(image_processing_mode="unknown"))
        self.assertIn("原图", describe_options(ImageProcessingOptions(mode="original")))
        self.assertIn("1600", describe_options(ImageProcessingOptions(mode="fit", max_edge=1600)))
        self.assertIn("800×1000", describe_options(ImageProcessingOptions(width=800, height=1000)))


if __name__ == "__main__":
    unittest.main()
