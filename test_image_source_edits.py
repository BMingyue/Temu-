import base64
import hashlib
from io import BytesIO
import json
from pathlib import Path
import random
from tempfile import TemporaryDirectory
import unittest

from PIL import Image
import gpt_extension_bridge as bridge
import image_jobs
import image_job_retry
import image_source_edits as edits
import image_workflows as flow
import backend
import http.client
import threading
from unittest.mock import patch


def png(seed):
    buffer = BytesIO()
    Image.frombytes('RGB', (256, 256), random.Random(seed).randbytes(256 * 256 * 3)).save(buffer, 'PNG')
    return buffer.getvalue()


class SourceEditTests(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.data = self.root / 'data'
        self.data.mkdir()
        self.source = self.root / 'source'
        self.product = self.source / 'Paisley product'
        self.product.mkdir(parents=True)
        for n, name in enumerate(edits.SOURCE_NAMES):
            (self.product / name).write_bytes(png(n))
        self.output = self.root / 'output'
        self.body = dict(source_folder=str(self.source), output_folder=str(self.output), browsers=['chrome'])
        self.owner = dict(browser='chrome', worker_id='edit-worker', session='edit-tab', version='0.4.8')

    def tearDown(self):
        self.temp.cleanup()

    def scan(self):
        return edits.scan(self.body, self.data)

    def prepare(self, **kwargs):
        return edits.prepare({**self.body, 'items': self.scan()['items'], **kwargs}, self.data)

    def test_scan_only_original_front_back_and_skip_manual_mixed_folder(self):
        (self.product / '03-hanger.png').write_bytes(png(3))
        self.assertEqual(self.scan()['file_count'], 2)
        (self.product / 'ChatGPT 图像 2026.png').write_bytes(png(4))
        result = self.scan()
        self.assertEqual(result['file_count'], 0)
        self.assertIn('手动替换', result['skipped'][0]['reason'])

    def test_persisted_exclusion_stays_after_manual_download_removed(self):
        (self.data / 'source-edit-exclusions.json').write_text(json.dumps({str(self.source): [self.product.name]}), encoding='utf-8')
        result = self.scan()
        self.assertFalse(result['items'])
        self.assertIn('历史排除', result['skipped'][0]['reason'])
        self.assertEqual(result['excluded_folders'], [str(self.product)])

    def test_scan_excludes_whole_product_when_front_or_back_is_missing(self):
        partial = self.source / 'Partial product'
        partial.mkdir()
        (partial / '01-main.png').write_bytes(png(5))
        result = self.scan()
        self.assertEqual(result['file_count'], 2)
        blocked = next(row for row in result['skipped'] if row['folder'] == str(partial))
        self.assertIn('02-back.png', blocked['reason'])
        self.assertIn('整款', blocked['reason'])

    def test_explicit_exclusion_and_invalid_escape(self):
        self.assertFalse(edits.scan({**self.body, 'exclude_folders': [self.product.name]}, self.data)['items'])
        with self.assertRaises(ValueError):
            edits.scan({**self.body, 'exclude_folders': ['../elsewhere']}, self.data)

    def test_changed_source_or_manual_download_after_scan_is_not_prepared(self):
        items = self.scan()['items']
        (self.product / '01-main.png').write_bytes(png(6))
        result = edits.prepare({**self.body, 'items': items}, self.data)
        self.assertEqual(result['prepared_count'], 0)
        self.assertEqual(len(result['errors']), 2)
        items = self.scan()['items']
        (self.product / 'ChatGPT Image new.png').write_bytes(png(7))
        self.assertEqual(edits.prepare({**self.body, 'items': items}, self.data)['prepared_count'], 0)

    def test_prepare_two_independent_jobs_single_snapshot_each_and_dedup(self):
        original = {p.name: p.read_bytes() for p in self.product.iterdir()}
        result = self.prepare()
        self.assertEqual((result['prepared_count'], result['queued_count']), (2, 0))
        self.assertEqual(len(set(row['id'] for row in result['jobs'])), 2)
        jobs = [image_jobs.get_job(self.data, row['id']) for row in result['jobs']]
        for job in jobs:
            self.assertEqual(job['expected_count'], 1)
            self.assertEqual(len(job['steps']), 1)
            self.assertEqual(job['workflow_input_mode'], edits.INPUT_MODE)
            self.assertEqual(job['steps'][0]['output_basename'], Path(job['source_name']).stem)
            self.assertEqual(Path(job['result_folder']), self.output / self.product.name)
            self.assertEqual(Path(job['reference']).read_bytes(), original[job['source_name']])
            self.assertFalse(job.get('chat_url'))
            self.assertIsNone(job.get('runner'))
        again = self.prepare(start=True)
        self.assertEqual((again['prepared_count'], again['queued_count']), (0, 2))
        self.assertEqual(self.prepare(start=True)['queued_count'], 0)
        self.assertEqual({p.name: p.read_bytes() for p in self.product.iterdir()}, original)

    def test_old_extension_cannot_claim_source_edits(self):
        result = self.prepare(start=True)
        for version in ('0.4.6', '0.4.7'):
            denied = bridge.claim(self.data, {**self.owner, 'version': version})
            self.assertIsNone(denied['task'])
            self.assertIn('0.4.8', denied['message'])
        self.assertEqual(image_jobs.get_job(self.data, result['jobs'][0]['id'])['batch_phase'], 'queued')
        accepted = bridge.claim(self.data, self.owner)['task']
        self.assertEqual(len(accepted['attachments']), 1)
        self.assertEqual(accepted['workflow_input_mode'], edits.INPUT_MODE)

    def _event(self, task, event, **extra):
        return bridge.update(self.data, dict(self.owner, job_id=task['job_id'], event=event,
                            step=task['step_number'], step_token=task['step_token'], **extra))

    def test_back_claim_send_save_has_single_source_and_correct_filename(self):
        item = next(i for i in self.scan()['items'] if i['source_name'] == '02-back.png')
        result = edits.prepare({**self.body, 'items': [item], 'start': True}, self.data)
        task = bridge.claim(self.data, self.owner)['task']
        self.assertEqual((task['step_number'], task['total_steps'], task['expected_count']), (1, 1, 1))
        self.assertEqual(len(task['attachments']), 1)
        raw = base64.b64decode(task['attachments'][0]['base64'])
        self.assertEqual(hashlib.sha256(raw).hexdigest(), item['sha256'])
        self._event(task, 'workflow_sending', chat_url='https://chatgpt.com/')
        chat = 'https://chatgpt.com/c/source-edit-back'
        self._event(task, 'workflow_sent', chat_url=chat, user_message_id='back-user')
        self._event(task, 'downloaded_bytes', base64=base64.b64encode(png(100)).decode())
        saved = image_jobs.get_job(self.data, result['jobs'][0]['id'])
        self.assertEqual(saved['batch_phase'], 'saved')
        self.assertEqual(Path(saved['steps'][0]['output']), self.output / self.product.name / '02-back.png')
        self.assertEqual((self.product / '02-back.png').read_bytes(), png(1))
        self.assertEqual(len(list(self.output.rglob('*.png'))), 1)
        preview, mime = image_jobs.output_image(self.data, saved['id'], 1, True)
        self.assertEqual(mime, 'image/jpeg')
        self.assertTrue(preview)

    def test_one_time_technical_retry_preserves_one_input_hash(self):
        result = self.prepare(start=True)
        task = bridge.claim(self.data, self.owner)['task']
        chat = 'https://chatgpt.com/c/source-edit-retry'
        self._event(task, 'workflow_sending', chat_url='https://chatgpt.com/')
        self._event(task, 'workflow_sent', chat_url=chat, user_message_id='retry-user')
        self._event(task, 'workflow_retry_once', chat_url=chat, failed_prompt_marker=task['prompt_marker'],
                    generating=False, generated_images=0, failure_text='Image generation failed. Please send again.')
        job = image_jobs.get_job(self.data, task['job_id'])
        self.assertEqual(len(job['steps'][0]['generation_retry_input_hashes']), 1)
        job['next_step_at'] = 0
        bridge._write(self.data, job)
        self.assertEqual(len(flow.payload(job)['task']['attachments']), 1)

    def test_snapshot_tamper_stops_payload(self):
        result = self.prepare()
        job = image_jobs.get_job(self.data, result['jobs'][0]['id'])
        Path(job['reference']).write_bytes(png(120))
        with self.assertRaisesRegex(ValueError, '快照校验'):
            flow.payload(job)

    def test_manual_retry_of_source_job_keeps_single_attachment_and_filename_mapping(self):
        result = self.prepare()
        source = image_jobs.get_job(self.data, result['jobs'][1]['id'])
        target = Path(source['result_folder']) / '02-back.png'
        raw = png(200)
        target.write_bytes(raw)
        source['steps'][0].update(phase='saved', output=str(target), sha256=hashlib.sha256(raw).hexdigest())
        source.update(batch_phase='saved')
        bridge._write(self.data, source)
        before = bridge._job_path(self.data, source['id']).read_bytes()
        retried = image_job_retry.retry(dict(id=source['id'], request_id='source-retry-request'), self.data)
        child = image_jobs.get_job(self.data, retried['id'])
        self.assertEqual(child['workflow_input_mode'], edits.INPUT_MODE)
        self.assertEqual(child['source_relative_path'], source['source_relative_path'])
        self.assertEqual(child['steps'][0]['output_basename'], '02-back')
        self.assertNotEqual(child['result_folder'], source['result_folder'])
        self.assertEqual(len(flow.payload(child)['task']['attachments']), 1)
        self.assertNotIn('source_edit_key', child)
        self.assertEqual(bridge._job_path(self.data, source['id']).read_bytes(), before)
        self.assertEqual(target.read_bytes(), raw)

    def test_http_catalog_scan_prepare_require_local_origin_and_keep_job_unstarted(self):
        with patch.object(backend, 'DATA', self.data):
            server = backend.BoundedThreadingHTTPServer(('127.0.0.1', 0), backend.Handler, max_workers=4)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                conn = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=5)
                conn.request('GET', '/api/image-jobs/source-edit-presets')
                reply = conn.getresponse()
                self.assertEqual(reply.status, 200)
                self.assertEqual(json.loads(reply.read())['presets'][0]['id'], edits.PRESET_ID)
                payload = {**self.body, 'items': self.scan()['items']}
                conn.request('POST', '/api/image-jobs/source-edit-prepare', body=json.dumps(payload), headers={'Content-Type': 'application/json'})
                reply = conn.getresponse()
                self.assertEqual(reply.status, 403)
                reply.read()
                conn.request('POST', '/api/image-jobs/source-edit-prepare', body=json.dumps(payload), headers={'Content-Type': 'application/json', 'X-Workbench': 'local'})
                reply = conn.getresponse()
                self.assertEqual(reply.status, 200)
                self.assertEqual(json.loads(reply.read())['prepared_count'], 2)
                self.assertTrue(all(j.get('runner') is None for j in image_jobs._read_jobs(self.data)))
                conn.close()
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=3)

    def test_output_cannot_overlap_or_overwrite_source_or_existing_result(self):
        for output in (self.source, self.product, self.source.parent):
            with self.assertRaises(ValueError):
                self.prepare(output_folder=str(output))
        result = self.output / self.product.name
        result.mkdir(parents=True)
        (result / '01-main.webp').write_bytes(png(121))
        response = self.prepare()
        self.assertEqual(response['prepared_count'], 1)
        self.assertIn('已有', response['errors'][0]['error'])

    def test_wrong_input_or_output_mapping_is_rejected(self):
        with self.assertRaises(ValueError):
            self.prepare(prompt='')
        result = self.prepare()
        job = image_jobs.get_job(self.data, result['jobs'][0]['id'])
        job['steps'].append(job['steps'][0])
        with self.assertRaises(ValueError):
            flow.payload(job)
        with self.assertRaises(ValueError):
            flow._output_basename({'workflow_input_mode': edits.INPUT_MODE}, {'output_basename': '../x'})


if __name__ == '__main__':
    unittest.main()
