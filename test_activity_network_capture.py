import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent
BRIDGE = (ROOT / 'browser_extension' / 'page-bridge.js').read_text(encoding='utf-8')
EVIDENCE = (ROOT / 'browser_extension' / 'activity-evidence.js').read_text(encoding='utf-8')


class ActivityNetworkCaptureTests(unittest.TestCase):
    def test_main_world_captures_fetch_and_xhr_batches(self):
        self.assertIn('window.fetch = async function activityAwareFetch', BRIDGE)
        self.assertIn('XMLHttpRequest.prototype.send = function(body)', BRIDGE)
        self.assertIn('ACTIVITY_NETWORK_EVIDENCE:activityNetworkEvidence', BRIDGE)
        self.assertIn('extractActivityNetworkCandidates', BRIDGE)

    def test_network_payload_does_not_expose_full_raw_response(self):
        marker = 'activityResponses.push('
        section = BRIDGE[BRIDGE.index(marker):BRIDGE.index(marker) + 320]
        self.assertIn('candidates', section)
        self.assertNotIn('responseBody,', section)

    def test_dom_scan_merges_network_batches(self):
        self.assertIn('await addNetwork();', EVIDENCE)
        self.assertIn('network_batches:scan.networkBatchCount', EVIDENCE)
        self.assertIn('network_responses_seen:scan.networkResponseCount', EVIDENCE)
        self.assertIn('network_candidates_added:scan.networkCandidateCount', EVIDENCE)
        self.assertIn('ACTIVITY_REACT_EVIDENCE:activityReactEvidence', BRIDGE)
        self.assertIn('react_candidates_added:scan.reactCandidateCount', EVIDENCE)

    def test_invalid_scroll_container_is_rejected(self):
        self.assertIn('unchangedSignatureSteps >= 8', EVIDENCE)
        self.assertIn('visible_signature_changes:scan.signatureChanges', EVIDENCE)
        self.assertIn('可见 SPU 签名从未变化', EVIDENCE)


if __name__ == '__main__':
    unittest.main()
