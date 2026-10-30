"""Independent invariants at the UI/scanner/upload boundaries."""
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, patch

import main
from mixed_image_order import layout_key, trim_items
from preflight_review import preview_entries
import tshirt_automation


class MixedOrderBoundaryReviewTests(unittest.TestCase):
    def setUp(self):
        scratch = tempfile.TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        self.root = Path(scratch.name)

    def sources(self, folder, count):
        folder.mkdir(parents=True)
        paths = [folder / f"{index:02}.png" for index in range(count)]
        for path in paths:
            path.write_bytes(b"scanner-only-fixture")
        return paths

    def groups(self, config):
        app = main.UploaderApp.__new__(main.UploaderApp)
        return app._collect_mixed_image_groups(config)

    def test_selected_detail_overlapping_first_original_has_identical_ui_and_scan_tokens(self):
        products = self.sources(self.root / "Product", 3)
        config = main.AppConfig(product_root=str(products[0].parent),
                                common_detail_images=[str(products[0])])
        groups = self.groups(config)
        jobs, _ = main.scan_product_folders(config)
        expected = [item.path for item in trim_items(groups[0].items)]
        self.assertEqual(expected, jobs[0].images)
        config.combined_image_layouts[layout_key("blanket")] = ["product:1", "product:0"]
        groups = self.groups(config)
        jobs, _ = main.scan_product_folders(config)
        self.assertEqual([item.path for item in trim_items(groups[0].items)], jobs[0].images)

    def test_ui_and_scan_remain_identical_above_limit_with_detail_first(self):
        products = self.sources(self.root / "Product", 12)
        details = self.sources(self.root / "Details", 3)
        config = main.AppConfig(product_root=str(products[0].parent),
                                common_detail_images=list(map(str, details)))
        groups = self.groups(config)
        token = groups[0].items[-1].token
        config.combined_image_layouts[layout_key("blanket")] = [token, "product:11", "product:4"]
        groups = self.groups(config)
        jobs, _ = main.scan_product_folders(config)
        self.assertEqual([item.path for item in trim_items(groups[0].items)], jobs[0].images)
        self.assertEqual(10, len(jobs[0].images))
        self.assertEqual(details[-1], jobs[0].images[0])

    def test_single_product_with_all_sources_also_selected_as_details_still_has_matching_group(self):
        products = self.sources(self.root / "Product", 2)
        config = main.AppConfig(product_root=str(products[0].parent),
                                common_detail_images=list(map(str, products)))
        groups = self.groups(config)
        jobs, _ = main.scan_product_folders(config)
        self.assertEqual(1, len(groups))
        self.assertEqual([item.path for item in trim_items(groups[0].items)], jobs[0].images)

    def test_new_product_uses_saved_layout_and_reordering_keeps_completed_state(self):
        originals = self.sources(self.root / "Product", 2)
        details = self.sources(self.root / "Details", 1)
        config = main.AppConfig(product_root=str(self.root),
                                common_detail_images=list(map(str, details)),
                                publish_mode="publish")
        jobs, _ = main.scan_product_folders(config)
        state = main.StateStore(self.root / "completed.json")
        state.mark_completed(jobs[0], "published")
        state_before = state.path.read_bytes()
        group = self.groups(config)[0]
        config.combined_image_layouts[layout_key("blanket")] = [group.items[-1].token, "product:1", "product:0"]
        future = self.sources(self.root / "Future", 2)
        reordered, _ = main.scan_product_folders(config)
        pending = main.pending_jobs_for_run(config, reordered, state=state)
        self.assertEqual(1, len(pending))
        self.assertEqual([details[0], future[1], future[0]], pending[0].images)
        self.assertEqual(state_before, state.path.read_bytes())
        self.assertTrue(state.is_completed(next(job for job in reordered if job.folder == originals[0].parent)))

    def test_bw_forged_wrong_anchor_duplicate_and_cross_colour_are_stopped_before_row_write(self):
        originals = self.sources(self.root / "Product", 2)
        details = self.sources(self.root / "Details", 2)
        job = main.ProductJob(originals[0].parent, "Product", originals)
        uploader = SimpleNamespace(config=main.AppConfig(listing_profile="tshirt_bw"))
        rows = [MagicMock(), MagicMock()]
        bad_sets = [
            {"white": [details[0]], "black": [originals[1]]},
            {"white": [details[0], originals[0], originals[0]], "black": [originals[1]]},
            {"white": [details[0], originals[0], originals[1]], "black": [originals[1]]},
        ]
        for image_sets in bad_sets:
            with self.subTest(image_sets=image_sets), \
                 patch.object(tshirt_automation, "_color_rows", return_value=(rows, 1, 2)), \
                 patch.object(tshirt_automation, "validate_bw_rows", return_value=["white", "black"]):
                with self.assertRaises(tshirt_automation.TshirtAutomationError):
                    tshirt_automation.upload_images(uploader, job, ["white-1", "black-2"],
                                                    prepare_image=MagicMock(), color_image_sets=image_sets)
                for row in rows:
                    row.locator.assert_not_called()
                job.color_image_sets = image_sets
                with self.assertRaises(ValueError):
                    preview_entries(job, uploader.config)


if __name__ == "__main__":
    unittest.main()
