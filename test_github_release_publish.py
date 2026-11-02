import copy
import hashlib
from pathlib import Path
import tempfile
import unittest

from release import publish_github_release as pub


class ReleasePublishTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        setup = root/'TextileWorkbench-Setup-2026.11.02.1.zip'
        setup.write_bytes(b'isolated synthetic release artifact')
        sha = hashlib.sha256(setup.read_bytes()).hexdigest()
        sums = root/'SHA256SUMS.txt'
        sums.write_text(sha+'  '+setup.name+'\n', encoding='utf-8')
        self.plan = {'repository': pub.REPO, 'version': '2026.11.02.1', 'tag': 'v2026.11.02.1',
                     'commit': 'a'*40, 'title': 'Isolated release', 'notes': 'No business action',
                     'assets': [{'name': p.name, 'path': str(p), 'size': p.stat().st_size,
                                 'sha256': hashlib.sha256(p.read_bytes()).hexdigest()} for p in (setup, sums)]}

    def test_local_plan_checks_exact_hashes_and_complete_public_sums(self):
        pub.validate_plan(self.plan)

    def test_modified_artifact_is_rejected(self):
        Path(self.plan['assets'][0]['path']).write_bytes(b'changed')
        with self.assertRaises(ValueError):
            pub.validate_plan(self.plan)

    def test_case_duplicate_and_traversal_names_are_rejected(self):
        plan = copy.deepcopy(self.plan)
        plan['assets'].append({**plan['assets'][0], 'name': plan['assets'][0]['name'].lower()})
        with self.assertRaises(ValueError):
            pub.validate_plan(plan)
        plan = copy.deepcopy(self.plan)
        plan['assets'][0]['name'] = '../out.zip'
        with self.assertRaises(ValueError):
            pub.validate_plan(plan)

    def test_checksum_list_must_cover_every_artifact(self):
        sums = Path(self.plan['assets'][1]['path'])
        sums.write_text('', encoding='utf-8')
        self.plan['assets'][1].update(size=0, sha256=hashlib.sha256(b'').hexdigest())
        with self.assertRaises(ValueError):
            pub.validate_plan(self.plan)

    def client(self, bad_hash=False, public=False, extra=False):
        plan = self.plan

        class FakeGitHub:
            def __init__(self):
                self.calls, self.assets = [], []

            def call(self, method, path, body=None):
                self.calls.append((method, path, body))
                if method == 'GET' and path.startswith('/releases/tags/'):
                    if public:
                        return {'draft': False}
                    if extra:
                        return {'draft': True, 'target_commitish': plan['commit'], 'assets': [{'name': 'not-reviewed.zip'}]}
                    return None
                if method == 'POST':
                    assert body['draft'] is True
                    return {'id': 17, 'draft': True, 'target_commitish': plan['commit'], 'assets': []}
                if method == 'GET':
                    return {'assets': self.assets}
                assert method == 'PATCH'
                return {'draft': False, 'prerelease': False, 'html_url': 'https://github.com/example/release',
                        'tag_name': plan['tag']}

            def upload(self, release, asset):
                row = {'name': asset['name'], 'state': 'uploaded', 'size': asset['size'],
                       'digest': 'sha256:'+('0'*64 if bad_hash else asset['sha256'])}
                self.assets.append(row)
                return row
        return FakeGitHub()

    def test_publish_only_after_all_remote_sizes_and_hashes_match(self):
        client = self.client()
        result = pub.publish(self.plan, client)
        self.assertEqual(result['assets'], 2)
        self.assertEqual(client.calls[-1][0], 'PATCH')

    def test_wrong_remote_digest_leaves_draft_unpublished(self):
        client = self.client(bad_hash=True)
        with self.assertRaises(RuntimeError):
            pub.publish(self.plan, client)
        self.assertNotIn('PATCH', [c[0] for c in client.calls])

    def test_existing_public_release_is_never_overwritten(self):
        client = self.client(public=True)
        with self.assertRaises(RuntimeError):
            pub.publish(self.plan, client)
        self.assertEqual(len(client.calls), 1)

    def test_unreviewed_draft_assets_stop_publishing(self):
        client = self.client(extra=True)
        with self.assertRaises(RuntimeError):
            pub.publish(self.plan, client)
        self.assertNotIn('PATCH', [c[0] for c in client.calls])


if __name__ == '__main__':
    unittest.main()
