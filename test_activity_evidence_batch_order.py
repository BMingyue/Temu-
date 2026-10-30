import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent
SOURCE = (ROOT / 'browser_extension' / 'activity-evidence.js').read_text(encoding='utf-8')


class ActivityEvidenceBatchOrderTests(unittest.TestCase):
    def test_batch_is_collected_before_load_more_click(self):
        marker = 'Crucial ordering: preserve the current batch before clicking once.'
        self.assertIn(marker, SOURCE)
        section = SOURCE[SOURCE.index(marker) - 500:SOURCE.index(marker) + 1800]
        self.assertLess(section.index('addVisible();'), section.index('clickControl(bottomMore);'))

    def test_old_expand_everything_first_call_is_not_used(self):
        collect_start = SOURCE.index('async function collectAcrossVirtualScroll()')
        collect_end = SOURCE.index('\n  async function capture()', collect_start)
        collect_body = SOURCE[collect_start:collect_end]
        self.assertNotIn('await expandAllProducts', collect_body)
        self.assertIn('loadedNextBatch', collect_body)
        self.assertIn('failedLoadAttempts >= 3', collect_body)

    def test_deep_virtual_scrollers_are_preferred(self):
        self.assertIn('depthOf(right) - depthOf(left)', SOURCE)
        self.assertIn('element.contains?.(selected)', SOURCE)


if __name__ == '__main__':
    unittest.main()
