import base64
import hashlib
import http.client
from io import BytesIO
import json
from pathlib import Path
import random
import shutil
import threading
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch
import zipfile

from PIL import Image

import gpt_extension_bridge as bridge
import image_jobs
import image_workflows as flow
import backend


def png(seed, size=(128, 128)):
    stream = BytesIO()
    Image.frombytes('RGB', size, random.Random(seed).randbytes(size[0] * size[1] * 3)).save(stream, 'PNG')
    return stream.getvalue()


class ImageJobRetryTests(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.data = self.root / 'data'
        ref = self.root / 'print.png'
        ref.write_bytes(png(0))
        self.source = flow.prepare(dict(title='audit', workflow_id=flow.DEFAULT_PRESET,
            reference=str(ref), output_folder=str(self.root / 'results'),
            workflow_prompts={'main': 'Original edited prompt snapshot'}), self.data)
        for step in self.source['steps']:
            raw = png(step['number'])
            target = Path(self.source['result_folder']) / f'{step["number"]:02d}-{step["key"]}.png'
            target.write_bytes(raw)
            step.update(phase='saved', output=str(target), sha256=hashlib.sha256(raw).hexdigest(),
                        send_started_at='2026-10-01T01:00:00Z', sent_at='2026-10-01T01:01:00Z',
                        saved_at='2026-10-01T01:03:00Z')
        self.source.update(batch_phase='saved', runner=None, current_step=4,
                           chat_url='https://chatgpt.com/c/original', assigned_worker='original-worker')
        bridge._write(self.data, self.source)
        self.originals = {str(p): p.read_bytes() for p in Path(self.source['folder']).rglob('*') if p.is_file()}
        self.originals.update({str(p): p.read_bytes() for p in Path(self.source['result_folder']).iterdir()})
        self.body = dict(id=self.source['id'], request_id='first-request', browsers=['chrome'])

    def tearDown(self):
        self.temp.cleanup()

    def retry(self, **kwargs):
        result = flow.retry_job({**self.body, **kwargs}, self.data)
        return result, image_jobs.get_job(self.data, result['id'])

    def assert_source_unchanged(self):
        self.assertTrue(all(Path(p).read_bytes() == raw for p, raw in self.originals.items()))

    def test_single_step_creates_queued_snapshot_and_preserves_others(self):
        result, child = self.retry(step_keys=['reading'])
        self.assertTrue(result['created'])
        self.assertEqual(child['batch_phase'], 'queued')
        self.assertNotIn('chat_url', child)
        self.assertNotIn('assigned_worker', child)
        self.assertEqual(child['current_step'], 3)
        self.assertEqual(child['execution_end_step'], 3)
        self.assertEqual(child['steps'][0]['prompt'], 'Original edited prompt snapshot')
        self.assertEqual([s['phase'] for s in child['steps']], ['saved', 'saved', 'ready', 'saved'])
        self.assertNotIn('sent_at', child['steps'][2])
        self.assertTrue(all(bridge._saved(s) for s in child['steps'] if s['phase'] == 'saved'))
        self.assert_source_unchanged()
        payload = flow.payload(child)['task']
        self.assertEqual(payload['step_number'], 3)
        self.assertEqual(len(payload['attachments']), 2)

    def test_multiple_nonadjacent_steps_and_full_retry(self):
        _, child = self.retry(step_keys=['sofa', 'outdoor'])
        self.assertEqual([s['phase'] for s in child['steps']], ['saved', 'ready', 'saved', 'ready'])
        _, full = self.retry(request_id='whole-request')
        self.assertEqual([s['phase'] for s in full['steps']], ['ready'] * 4)
        self.assertEqual(full['current_step'], 1)
        self.assertEqual(list(Path(full['result_folder']).iterdir()), [])
        self.assert_source_unchanged()

    def test_repeated_request_and_cross_tab_click_are_idempotent(self):
        first, child = self.retry(step_keys=['sofa'])
        repeated, _ = self.retry(step_keys=['sofa'])
        cross_tab, _ = self.retry(step_keys=['sofa'], request_id='another-tab')
        self.assertEqual(first['id'], repeated['id'])
        self.assertEqual(first['id'], cross_tab['id'])
        self.assertFalse(repeated['created'])
        self.assertEqual(len(image_jobs._read_jobs(self.data)), 2)
        with self.assertRaisesRegex(ValueError, '不能改变'):
            self.retry(step_keys=['reading'])

    def test_later_user_revision_allowed_after_previous_finishes(self):
        first, child = self.retry(step_keys=['sofa'])
        child.update(batch_phase='saved', runner=None)
        bridge._write(self.data, child)
        same, _ = self.retry(step_keys=['sofa'])
        self.assertEqual(same['id'], first['id'])
        new, _ = self.retry(step_keys=['sofa'], request_id='later-review-request')
        self.assertNotEqual(new['id'], first['id'])
        self.assertTrue(new['created'])

    def test_active_source_and_unknown_sent_steps_are_protected(self):
        for phase in ('queued', 'claimed', 'sending', 'waiting', 'sent', 'downloading'):
            with self.subTest(phase=phase):
                bridge._write(self.data, {**self.source, 'batch_phase': phase})
                with self.assertRaisesRegex(ValueError, '正在执行'):
                    self.retry()
        source = json.loads(json.dumps(self.source))
        source.update(batch_phase='needs_review')
        source['steps'][2].update(phase='sent', output='', sha256='')
        bridge._write(self.data, source)
        with self.assertRaisesRegex(ValueError, '尚未确认'):
            self.retry(step_keys=['reading'])
        self.assertEqual(len(image_jobs._read_jobs(self.data)), 1)

    def test_unsent_failed_step_can_be_retried_but_missing_unselected_blocks(self):
        source = json.loads(json.dumps(self.source))
        source.update(batch_phase='failed', runner=None)
        source['steps'][3] = {k: v for k, v in source['steps'][3].items()
                              if k not in ('output', 'sha256', 'sent_at', 'send_started_at')}
        source['steps'][3].update(phase='ready')
        bridge._write(self.data, source)
        with self.assertRaisesRegex(ValueError, '一并选择'):
            self.retry(step_keys=['sofa'])
        _, child = self.retry(step_keys=['outdoor'])
        self.assertEqual(child['current_step'], 4)

    def test_corrupt_selected_output_can_be_regenerated_and_retained_corrupt_blocks(self):
        Path(self.source['steps'][2]['output']).write_bytes(png(90))
        with self.assertRaisesRegex(ValueError, '校验失败'):
            self.retry(step_keys=['sofa'])
        result, child = self.retry(step_keys=['reading'])
        self.assertTrue(result['created'])
        self.assertEqual(child['steps'][2]['phase'], 'ready')

    def test_moved_outputs_require_explicit_root(self):
        moved = self.root / 'moved'
        moved.mkdir()
        shutil.move(self.source['result_folder'], moved / Path(self.source['result_folder']).name)
        with self.assertRaisesRegex(ValueError, '原成图目录'):
            self.retry(step_keys=['sofa'])
        _, child = self.retry(step_keys=['sofa'], source_results_root=str(moved))
        self.assertEqual(Path(child['result_folder']).parent, moved)
        self.assertTrue(bridge._saved(child['steps'][0]))

    def test_invalid_request_keys_ids_and_browsers_create_nothing(self):
        for update in (dict(request_id='bad'), dict(id='../a'), dict(step_keys=[]),
                       dict(step_keys=['fake']), dict(browsers=[])):
            with self.subTest(update=update), self.assertRaises(ValueError):
                self.retry(**update)
        self.assertEqual(len(image_jobs._read_jobs(self.data)), 1)

    def test_unknown_sent_requires_explicit_manual_ack_and_keeps_original_evidence(self):
        source = json.loads(json.dumps(self.source))
        source.update(batch_phase='needs_review')
        source['steps'][2].update(phase='sent', output='', sha256='')
        bridge._write(self.data, source)
        before = (Path(source['folder']) / 'job.json').read_bytes()
        for ack in (None, False, 'true'):
            updates = {} if ack is None else {'confirm_resend': ack}
            with self.subTest(ack=ack), self.assertRaises(ValueError):
                self.retry(step_keys=['reading'], **updates)
        _, child = self.retry(step_keys=['reading'], confirm_resend=True)
        self.assertEqual(child['retry_confirmed_unknown_steps'], ['reading'])
        self.assertEqual(child['steps'][2]['phase'], 'ready')
        self.assertNotIn('sent_at', child['steps'][2])
        self.assertTrue(any(entry['event'] == 'manual_retry_acknowledged' for entry in child['logs']))
        self.assertEqual((Path(source['folder']) / 'job.json').read_bytes(), before)
        self.assertEqual(child['batch_phase'], 'queued')

    def test_enqueue_interruption_reuses_prepared_child(self):
        with patch.object(bridge, 'enqueue', side_effect=OSError('interrupted')):
            with self.assertRaises(OSError):
                self.retry(step_keys=['sofa'])
        result, child = self.retry(step_keys=['sofa'])
        self.assertFalse(result['created'])
        self.assertEqual(child['batch_phase'], 'queued')
        self.assertEqual(len(image_jobs._read_jobs(self.data)), 2)

    def test_old_zip_supports_full_retry_only(self):
        template = self.root / 'templates.zip'
        with zipfile.ZipFile(template, 'w') as archive:
            archive.writestr('image.png', png(99))
        old = image_jobs.prepare(dict(title='ZIP', category='地垫', reference=self.source['reference'],
            template=str(template), output_folder=str(self.root / 'zip-results')), self.data)
        result, child = self.retry(id=old['id'])
        self.assertTrue(result['created'])
        self.assertEqual(child['batch_phase'], 'queued')
        self.assertTrue(Path(child['template_archive']).is_file())
        with self.assertRaisesRegex(ValueError, '整套'):
            self.retry(id=old['id'], request_id='partial-zip', step_keys=['1'])

    def test_compact_fields_and_registered_thumbnail(self):
        raw = png(101, (640, 480))
        Path(self.source['steps'][0]['output']).write_bytes(raw)
        self.source['steps'][0]['sha256'] = hashlib.sha256(raw).hexdigest()
        bridge._write(self.data, self.source)
        compact = image_jobs.compact_job(self.source)
        step = compact['step_progress'][0]
        self.assertEqual(step['key'], 'main')
        self.assertEqual(step['output'], self.source['steps'][0]['output'])
        self.assertIn('sent_at', step)
        raw, mime = image_jobs.output_image(self.data, self.source['id'], 1, True)
        self.assertEqual(mime, 'image/jpeg')
        with Image.open(BytesIO(raw)) as thumb:
            self.assertLessEqual(max(thumb.size), 320)
        full, _ = image_jobs.output_image(self.data, self.source['id'], 1)
        self.assertEqual(full, Path(step['output']).read_bytes())
        for ident, number in (('../secret', 1), (self.source['id'], 99)):
            with self.assertRaises(ValueError):
                image_jobs.output_image(self.data, ident, number)
        Path(step['output']).write_bytes(png(100))
        with self.assertRaises(ValueError):
            image_jobs.output_image(self.data, self.source['id'], 1)

    def test_retry_claim_completes_only_selected_step_using_original_master(self):
        _, child = self.retry(step_keys=['reading'])
        owner = dict(browser='chrome', worker_id='revision-worker', session='revision-session', version='0.4.6')
        task = bridge.claim(self.data, owner)['task']
        self.assertEqual(task['job_id'], child['id'])
        self.assertEqual(task['step_number'], 3)
        master = base64.b64decode(task['attachments'][1]['base64'])
        self.assertEqual(hashlib.sha256(master).hexdigest(), self.source['steps'][0]['sha256'])
        def event(kind, **values):
            return bridge.update(self.data, dict(job_id=child['id'], step=3,
                step_token=task['step_token'], event=kind, **owner, **values))
        event('workflow_sending', chat_url='https://chatgpt.com/')
        event('workflow_sent', chat_url='https://chatgpt.com/c/revision', user_message_id='new-revision-step')
        event('downloaded_bytes', base64=base64.b64encode(png(303)).decode())
        done = image_jobs.get_job(self.data, child['id'])
        self.assertEqual(done['batch_phase'], 'saved')
        self.assertTrue(all(bridge._saved(s) for s in done['steps']))
        self.assertEqual(len(list(Path(done['result_folder']).iterdir())), 4)
        self.assert_source_unchanged()

    def test_http_image_and_retry_routes_respect_local_write_guards(self):
        with patch.object(backend, 'DATA', self.data):
            server = backend.BoundedThreadingHTTPServer(('127.0.0.1', 0), backend.Handler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                def request(method, path, body=None, headers=None):
                    conn = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=3)
                    conn.request(method, path, body=json.dumps(body) if body else None,
                                 headers={'Content-Type': 'application/json', **(headers or {})})
                    response = conn.getresponse()
                    status, mime, content = response.status, response.getheader('Content-Type'), response.read()
                    conn.close()
                    return status, mime, content
                path = f'/api/image-jobs/{self.source["id"]}/outputs/1?thumbnail=1'
                status, mime, raw = request('GET', path)
                self.assertEqual((status, mime), (200, 'image/jpeg'))
                self.assertTrue(raw.startswith(b'\xff\xd8\xff'))
                self.assertEqual(request('GET', path, headers={'Origin': 'https://attacker.test'})[0], 403)
                self.assertEqual(request('GET', f'/api/image-jobs/{self.source["id"]}/outputs/99')[0], 404)
                self.assertEqual(request('POST', '/api/image-jobs/retry', self.body)[0], 403)
                status, _, raw = request('POST', '/api/image-jobs/retry', self.body,
                    {'X-Workbench': 'local', 'Origin': 'http://127.0.0.1:5173'})
                self.assertEqual(status, 200)
                self.assertTrue(json.loads(raw)['created'])
            finally:
                server.shutdown()
                server.server_close()
                thread.join(3)


if __name__ == '__main__':
    unittest.main()
