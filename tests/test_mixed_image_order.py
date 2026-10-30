import os
import tempfile
import unittest
from dataclasses import FrozenInstanceError
from pathlib import Path
from types import SimpleNamespace

from mixed_image_order import (
    ImageOrderItem, apply_order, layout_key, make_items, order_key,
    ordered_items, path_identity, trim_items,
)


class MixedImageOrderTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.config = SimpleNamespace(
            listing_profile="tshirt", combined_image_orders={}, combined_image_layouts={})

    def items(self, folder="first", count=3):
        products = [self.root / folder / f"{index}.png" for index in range(count)]
        details = [self.root / "details" / f"{index}.png" for index in range(2)]
        return make_items(products, details)

    def test_same_layout_interleaves_details_across_different_products(self):
        first, second = self.items("first"), self.items("second")
        tokens = [first[3].token, "product:1", first[4].token, "product:0", "product:2"]
        self.config.combined_image_layouts[layout_key("tshirt")] = tokens
        for folder, items in (("first", first), ("second", second)):
            result = ordered_items(self.config, self.root / folder, "all", items)
            self.assertEqual(tokens, [item.token for item in result])
            self.assertEqual("detail", result[0].kind)
            self.assertEqual(self.root / folder / "1.png", result[1].path)

    def test_folder_override_wins_and_other_profile_or_colour_does_not_leak(self):
        items = self.items()
        layout = [items[-1].token]
        override = ["product:2", items[-2].token]
        self.config.combined_image_layouts[layout_key("tshirt", "white")] = layout
        self.config.combined_image_orders[order_key("tshirt", self.root / "first", "white")] = override
        self.assertEqual("product:2", ordered_items(self.config, self.root / "first", "white", items)[0].token)
        self.assertEqual(items[-1], ordered_items(self.config, self.root / "second", "white", items)[0])
        self.assertEqual(items, ordered_items(self.config, self.root / "first", "black", items))
        self.config.listing_profile = "blanket"
        self.assertEqual(items, ordered_items(self.config, self.root / "first", "white", items))

    def test_explicit_empty_override_resets_layout_to_source_order(self):
        items = self.items()
        self.config.combined_image_layouts[layout_key("tshirt")] = [items[-1].token]
        self.config.combined_image_orders[order_key("tshirt", self.root)] = []
        self.assertEqual(items, ordered_items(self.config, self.root, "all", items))

    def test_stale_unknown_duplicate_tokens_ignored_and_new_images_append(self):
        items = self.items()
        original = list(items)
        tokens = [items[-1].token, "detail:deleted.png", "product:1", "product:1", 1, None, {}, "product:999"]
        result = apply_order(items, tokens)
        self.assertEqual([items[-1], items[1], items[0], items[2], items[3]], result)
        self.assertEqual(original, items)
        self.assertEqual(8, len(tokens))

    def test_new_detail_is_appended_after_saved_existing_mix(self):
        items = self.items()
        saved = [items[-1].token, "product:0", items[-2].token, "product:1", "product:2"]
        extended = make_items([item.path for item in items[:3]],
                              [item.path for item in items[3:]] + [self.root / "new.png"])
        result = apply_order(extended, saved)
        self.assertEqual(saved + [extended[-1].token], [item.token for item in result])

    def test_path_dedupe_retains_product_type_and_distinct_fullpaths(self):
        first = self.root / "one" / "same.png"
        second = self.root / "two" / "same.png"
        items = make_items([first, first.parent / "." / "same.png", second], [second, first, self.root / "detail.png"])
        self.assertEqual(["product:0", "product:1", f"detail:{path_identity(self.root / 'detail.png')}"], [i.token for i in items])
        self.assertEqual(["product", "product", "detail"], [i.kind for i in items])
        detail_items = make_items([], [first, second])
        self.assertNotEqual(detail_items[0].token, detail_items[1].token)

    @unittest.skipUnless(os.name == "nt", "Windows path alias normalization")
    def test_windows_extended_and_case_aliases_share_identity(self):
        source = self.root / "Photo.PNG"
        extended = "\\\\?\\" + str(source)
        self.assertEqual(path_identity(source), path_identity(extended))
        self.assertEqual(path_identity(source), path_identity(str(source).swapcase()))
        self.assertEqual(order_key("tshirt", self.root), order_key("tshirt", "\\\\?\\" + str(self.root)))
        self.assertEqual(path_identity(r"\\server\share\a.png"), path_identity(r"\\?\UNC\server\share\a.png"))

    def test_malformed_saved_configuration_falls_back_safely(self):
        items = self.items()
        for malformed in (None, 7, [], "bad"):
            self.config.combined_image_orders = malformed
            self.config.combined_image_layouts = malformed
            self.assertEqual(items, ordered_items(self.config, self.root, "all", items))
        self.config.combined_image_orders = {order_key("tshirt", self.root): "bad"}
        self.config.combined_image_layouts = {layout_key("tshirt"): [items[-1].token, {}, None]}
        self.assertEqual(items[-1], ordered_items(self.config, self.root, "all", items)[0])
        self.assertEqual(items, apply_order(items, "product:2"))

    def test_all_returned_lists_are_independent_and_items_are_frozen(self):
        items = self.items()
        self.assertIsNot(items, apply_order(items, None))
        self.assertIsNot(items, trim_items(items))
        result = ordered_items(self.config, self.root, "all", items)
        result.clear()
        self.assertEqual(5, len(items))
        with self.assertRaises(FrozenInstanceError):
            items[0].token = "changed"

    def test_trim_preserves_all_details_and_selected_product_mixed_order(self):
        products = [self.root / f"p-{index}.png" for index in range(12)]
        details = [self.root / f"d-{index}.png" for index in range(3)]
        items = make_items(products, details)
        tokens = [items[12].token, "product:5", items[13].token, "product:0", "product:7", items[14].token]
        mixed = apply_order(items, tokens)
        trimmed = trim_items(mixed)
        self.assertEqual(10, len(trimmed))
        self.assertEqual(3, sum(item.kind == "detail" for item in trimmed))
        self.assertEqual([5, 0, 7, 1, 2, 3, 4], [int(item.token.split(":")[1]) for item in trimmed if item.kind == "product"])
        self.assertEqual("detail", trimmed[0].kind)
        self.assertEqual([item for item in mixed if item in trimmed], trimmed)

    def test_nine_details_reserve_one_product_even_when_details_come_first(self):
        items = make_items([self.root / f"p{i}.png" for i in range(3)],
                           [self.root / f"d{i}.png" for i in range(9)])
        mixed = items[3:] + items[:3]
        result = trim_items(mixed)
        self.assertEqual(mixed[:9] + [items[0]], result)
        self.assertEqual("detail", result[0].kind)
        self.assertEqual(1, sum(item.kind == "product" for item in result))

    def test_trim_unreserved_details_and_defensive_capacity(self):
        items = make_items([self.root / "p.png"], [self.root / f"d{i}.png" for i in range(12)])
        mixed = items[1:] + items[:1]
        for preserve in (True, False):
            with self.subTest(preserve=preserve):
                result = trim_items(mixed, limit=3, preserve_details=preserve)
                self.assertEqual(3, len(result))
                self.assertEqual(items[0], result[-1])
        self.assertEqual([], trim_items(items, limit=0))
        self.assertEqual(items[:1], trim_items(items, limit=1))


if __name__ == "__main__":
    unittest.main()
