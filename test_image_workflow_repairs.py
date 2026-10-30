import base64
import hashlib
from io import BytesIO
import json
from pathlib import Path
import random
import shutil
from tempfile import TemporaryDirectory
import time
import unittest

from PIL import Image

import gpt_extension_bridge as bridge
import gpt_unattended as policy
import image_workflows as flow


def png(seed):
    stream = BytesIO()
    Image.frombytes('RGB', (128, 128), random.Random(seed).randbytes(128 * 128 * 3)).save(stream, 'PNG')
    return stream.getvalue()


class PartialRepairTests(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.data = self.root / 'data'
        self.reference = self.root / 'print.png'
        self.reference.write_bytes(png(0))
        self.source = flow.prepare(dict(title='20261027-003136-001', workflow_id=flow.SWEATER_PRESET,
            reference=str(self.reference), output_folder=str(self.root / 'old-results')), self.data)
        self.source['steps'] = [s for s in self.source['steps'] if s['key'] != 'hanger']
        for number, step in enumerate(self.source['steps'], 1):
            raw = png(number)
            target = Path(self.source['result_folder']) / f'{number:02d}-{step["key"]}.png'
            target.write_bytes(raw)
            step.update(number=number, phase='saved', output=str(target),
                        sha256=hashlib.sha256(raw).hexdigest(), saved_at=bridge.now())
        self.source.update(workflow_id='sweater-print-set-v2', expected_count=4, current_step=4,
                           batch_no='BATCH-sweaters', batch_phase='saved', runner=None,
                           completed_at=bridge.now(), assigned_browser='firefox', assigned_worker='old-worker',
                           chat_url='https://chatgpt.com/c/original-conversation')
        bridge._write(self.data, self.source)
        self.source_path = Path(self.source['folder']) / 'job.json'
        self.source_bytes = self.source_path.read_bytes()
        self.body = dict(ids=[self.source['id']], step_keys=['hanger', 'flatlay'], browsers=['chrome'],
                         output_folder=str(self.root / 'new-results'))
        self.owner = dict(browser='chrome', worker_id='repair-worker', session='repair-session', version='0.4.6')
        self.chat = 'https://chatgpt.com/c/independent-repair-chat'

    def tearDown(self):
        self.temp.cleanup()

    def prepare_repair(self, **overrides):
        result = flow.prepare_repairs({**self.body, **overrides}, self.data)
        self.assertEqual(result['errors'], [])
        self.assertEqual(result['prepared_count'], 1)
        return bridge._read(self.data, result['jobs'][0]['id'])

    def test_preview_requires_bounded_filter_and_valid_selection(self):
        for body in ({}, {'ids': []}, {'title_query': 42}, {'title_query': 'sweater', 'step_keys': []},
                     {'ids': [self.source['id']], 'step_keys': ['main']}, {'ids': [self.source['id']], 'browsers': []}):
            with self.subTest(body=body), self.assertRaises(ValueError):
                flow.repair_preview(body, self.data)
        preview = flow.repair_preview(dict(title_query='003136', batch_no='BATCH-sweaters'), self.data)
        self.assertEqual((preview['matched_count'], preview['eligible_count']), (1, 1))
        self.assertEqual(preview['matching'][0]['retained_count'], 3)
        self.assertEqual(preview['matching'][0]['regenerate_count'], 2)
        self.assertEqual(self.source_path.read_bytes(), self.source_bytes)

    def test_preview_blocks_missing_active_corrupt_and_non_sweater_sources(self):
        missing = flow.repair_preview(dict(ids=['f' * 32]), self.data)
        self.assertEqual(missing['blocked_count'], 1)
        for updates in (dict(batch_phase='sending'), dict(runner='chrome_extension'),
                        dict(workflow_id=flow.DEFAULT_PRESET)):
            with self.subTest(updates=updates):
                bridge._write(self.data, {**self.source, **updates})
                self.assertEqual(flow.repair_preview(self.body, self.data)['eligible_count'], 0)
        bridge._write(self.data, self.source)
        Path(self.source['steps'][0]['output']).write_bytes(png(99))
        preview = flow.repair_preview(self.body, self.data)
        self.assertEqual(preview['blocked_count'], 1)
        self.assertIn('校验', preview['matching'][0]['reason'])

    def test_new_child_preserves_three_images_and_original_records(self):
        child = self.prepare_repair()
        self.assertNotIn('chat_url', child)
        self.assertNotIn('assigned_browser', child)
        self.assertNotIn('assigned_worker', child)
        self.assertIsNone(child['runner'])
        self.assertEqual(child['repair_source_id'], self.source['id'])
        self.assertEqual(child['current_step'], 3)
        self.assertEqual(child['relay_start_step'], 3)
        self.assertTrue(child['execution_segment'])
        self.assertEqual([s['phase'] for s in child['steps']], ['saved', 'saved', 'ready', 'saved', 'ready'])
        old = {s['key']: s for s in self.source['steps']}
        for step in child['steps']:
            if step['phase'] == 'saved':
                self.assertEqual(Path(step['output']).read_bytes(), Path(old[step['key']]['output']).read_bytes())
        self.assertEqual(sorted(p.name for p in Path(child['result_folder']).glob('*.png')),
                         ['01-main.png', '02-back.png', '04-cafe.png'])
        self.assertEqual(self.source_path.read_bytes(), self.source_bytes)

    def test_repeated_prepare_is_idempotent_without_new_tasks_or_outputs(self):
        child = self.prepare_repair()
        directories = set((self.data / 'image-jobs').iterdir())
        results = set((self.root / 'new-results').iterdir())
        repeated = flow.prepare_repairs(self.body, self.data)
        self.assertEqual(repeated['prepared_count'], 0)
        self.assertEqual(repeated['skipped'][0]['existing_repair_id'], child['id'])
        self.assertEqual(set((self.data / 'image-jobs').iterdir()), directories)
        self.assertEqual(set((self.root / 'new-results').iterdir()), results)

    def test_name_search_does_not_recursively_repair_completed_child(self):
        child = self.prepare_repair()
        for step in child['steps']:
            if step['phase'] != 'saved':
                raw = png(400 + step['number'])
                target = Path(child['result_folder']) / f'{step["number"]:02d}-{step["key"]}.png'
                target.write_bytes(raw)
                step.update(phase='saved', output=str(target), sha256=hashlib.sha256(raw).hexdigest())
        child.update(batch_phase='saved', runner=None)
        bridge._write(self.data, child)
        query = dict(title_query=self.source['title'], step_keys=['hanger', 'flatlay'])
        preview = flow.repair_preview(query, self.data)
        self.assertEqual([row['id'] for row in preview['matching']], [self.source['id']])
        repeated = flow.prepare_repairs(query, self.data)
        self.assertEqual(repeated['prepared_count'], 0)
        self.assertEqual(repeated['skipped'][0]['existing_repair_id'], child['id'])
        explicit = flow.repair_preview(dict(ids=[child['id']]), self.data)
        self.assertEqual(explicit['eligible_count'], 1)
        self.assertEqual(explicit['matching'][0]['id'], child['id'])

    def test_empty_output_folder_uses_current_relocated_results_root(self):
        relocated = self.root / 'moved-results'
        relocated.mkdir()
        shutil.move(self.source['result_folder'], relocated / Path(self.source['result_folder']).name)
        child = self.prepare_repair(source_results_root=str(relocated), output_folder='')
        self.assertEqual(Path(child['result_folder']).parent, relocated)

    def test_relocated_outputs_require_explicit_root_and_matching_hashes(self):
        relocated = self.root / 'moved-results'
        relocated.mkdir()
        moved_folder = relocated / Path(self.source['result_folder']).name
        shutil.move(self.source['result_folder'], moved_folder)
        self.assertEqual(flow.repair_preview(self.body, self.data)['eligible_count'], 0)
        body = {**self.body, 'source_results_root': str(relocated)}
        preview = flow.repair_preview(body, self.data)
        self.assertEqual(preview['eligible_count'], 1)
        self.assertEqual(preview['resolved_source_root'], str(relocated.resolve()))
        child = self.prepare_repair(source_results_root=str(relocated))
        self.assertTrue(all(Path(s['output']).is_file() for s in child['steps'] if s['phase'] == 'saved'))
        self.assertEqual(self.source_path.read_bytes(), self.source_bytes)
        moved_main = moved_folder / Path(self.source['steps'][0]['output']).name
        moved_main.write_bytes(png(999))
        self.assertEqual(flow.repair_preview(body, self.data)['eligible_count'], 0)

    def test_flatlay_only_rejected_when_new_hanger_is_missing(self):
        preview = flow.repair_preview({**self.body, 'step_keys': ['flatlay']}, self.data)
        self.assertEqual(preview['eligible_count'], 0)
        self.assertIn('一并勾选', preview['matching'][0]['reason'])
        result = flow.prepare_repairs({**self.body, 'step_keys': ['flatlay']}, self.data)
        self.assertEqual(result['prepared_count'], 0)
        self.assertEqual(len(result['errors']), 1)

    def test_moved_results_keep_fixed_image_input_copy(self):
        fixed_path = Path(self.source['folder']) / 'inputs' / 'fixed-05.png'
        raw = png(300)
        fixed_path.write_bytes(raw)
        fixed_output = Path(self.source['result_folder']) / '05-fixed.png'
        fixed_output.write_bytes(raw)
        self.source['fixed_images'] = [dict(source=str(fixed_path), output=str(fixed_output),
            number=5, name='fixed.png', sha256=hashlib.sha256(raw).hexdigest())]
        bridge._write(self.data, self.source)
        source_bytes = self.source_path.read_bytes()
        relocated = self.root / 'moved-results'
        relocated.mkdir()
        shutil.move(self.source['result_folder'], relocated / Path(self.source['result_folder']).name)
        child = self.prepare_repair(source_results_root=str(relocated))
        self.assertEqual(len(child['fixed_images']), 1)
        self.assertEqual(child['fixed_images'][0]['number'], 6)
        self.assertEqual(Path(child['fixed_images'][0]['source']).read_bytes(), raw)
        self.assertEqual(self.source_path.read_bytes(), source_bytes)

    def test_preparation_never_starts_generation(self):
        with self.assertRaisesRegex(ValueError, '先准备'):
            flow.prepare_repairs({**self.body, 'start': True}, self.data)
        self.assertEqual(len(list((self.data / 'image-jobs').glob('*/job.json'))), 1)

    def event(self, child_id, task, event, **details):
        return bridge.update(self.data, dict(self.owner, job_id=child_id, event=event,
                              step=task['step_number'], step_token=task['step_token'], **details))

    def test_end_to_end_new_chat_master_reference_skip_retained_cafe(self):
        child = self.prepare_repair()
        bridge.enqueue(self.data, child['id'], browsers=['chrome'])
        master_hash = child['steps'][0]['sha256']
        for index, expected_step in enumerate((3, 5)):
            task = bridge.claim(self.data, self.owner)['task']
            self.assertEqual(task['step_number'], expected_step)
            self.assertEqual(task['chat_url'], '' if index == 0 else self.chat)
            self.assertEqual(len(task['attachments']), 2)
            self.assertEqual(hashlib.sha256(base64.b64decode(task['attachments'][1]['base64'])).hexdigest(), master_hash)
            self.event(child['id'], task, 'workflow_sending', chat_url='https://chatgpt.com/' if index == 0 else self.chat)
            self.event(child['id'], task, 'workflow_sent', chat_url=self.chat, user_message_id=f'new-{expected_step}')
            self.event(child['id'], task, 'downloaded_bytes', base64=base64.b64encode(png(100 + expected_step)).decode())
            updated = bridge._read(self.data, child['id'])
            if index == 0:
                self.assertEqual(updated['current_step'], 5)
                self.assertGreater(updated['next_step_at'], time.time())
                updated['next_step_at'] = time.time() - 1
                bridge._write(self.data, updated)
        done = bridge._read(self.data, child['id'])
        self.assertEqual(done['batch_phase'], 'saved')
        self.assertTrue(all(bridge._saved(s) for s in done['steps']))
        self.assertEqual(len(list(Path(done['result_folder']).glob('*.png'))), 5)
        self.assertEqual(self.source_path.read_bytes(), self.source_bytes)

    def test_hanger_only_ends_at_execution_step_instead_of_inheriting_total(self):
        child = self.prepare_repair(step_keys=['hanger'])
        self.assertEqual(child['execution_end_step'], 3)
        self.assertEqual(flow.payload(child)['task']['total_steps'], 3)
        bridge.enqueue(self.data, child['id'], browsers=['chrome'])
        task = bridge.claim(self.data, self.owner)['task']
        self.event(child['id'], task, 'workflow_sending', chat_url='https://chatgpt.com/')
        self.event(child['id'], task, 'workflow_sent', chat_url=self.chat, user_message_id='hanger-only')
        self.event(child['id'], task, 'downloaded_bytes', base64=base64.b64encode(png(200)).decode())
        self.assertEqual(bridge._read(self.data, child['id'])['batch_phase'], 'saved')

    def test_unsubmitted_repair_recovers_to_clean_firefox_with_retained_hashes(self):
        child = self.prepare_repair()
        bridge.enqueue(self.data, child['id'], browsers=['chrome'])
        bridge.claim(self.data, self.owner)
        claimed = bridge._read(self.data, child['id'])
        retained = {s['key']: s['sha256'] for s in claimed['steps'] if s['phase'] == 'saved'}
        policy.isolate(self.data, claimed, 'unmatched original draft')
        recovered = policy.recover_selected(self.data, [child['id']], ['firefox'])
        self.assertEqual(recovered['queued'], [child['id']])
        current = bridge._read(self.data, child['id'])
        self.assertEqual(current['current_step'], 3)
        self.assertEqual(current['eligible_browsers'], ['firefox'])
        self.assertNotIn('assigned_browser', current)
        self.assertNotIn('assigned_worker', current)
        self.assertNotIn('preferred_browser', current)
        task = bridge.claim(self.data, {**self.owner, 'browser': 'firefox', 'worker_id': 'clean-firefox'})['task']
        self.assertEqual(task['job_id'], child['id'])
        self.assertEqual(task['step_number'], 3)
        current = bridge._read(self.data, child['id'])
        self.assertEqual(current['assigned_browser'], 'firefox')
        for step in current['steps']:
            if step['key'] in retained:
                self.assertEqual(step['sha256'], retained[step['key']])
                self.assertTrue(bridge._saved(step))

    def test_sent_repair_is_protected_from_cross_account_recovery(self):
        child = self.prepare_repair()
        bridge.enqueue(self.data, child['id'], browsers=['chrome'])
        task = bridge.claim(self.data, self.owner)['task']
        self.event(child['id'], task, 'workflow_sending', chat_url='https://chatgpt.com/')
        self.event(child['id'], task, 'workflow_sent', chat_url=self.chat, user_message_id='already-sent')
        policy.isolate(self.data, bridge._read(self.data, child['id']), 'result unknown')
        recovered = policy.recover_selected(self.data, [child['id']], ['firefox'])
        self.assertEqual(recovered['protected'], [child['id']])
        current = bridge._read(self.data, child['id'])
        self.assertEqual(current['assigned_browser'], 'chrome')
        self.assertEqual(current['assigned_worker'], self.owner['worker_id'])
        self.assertEqual(current['chat_url'], self.chat)
        self.assertEqual(flow.current(current)['phase'], 'sent')

    def assert_quota_relay(self, quota_step, legacy_segment=False):
        child = self.prepare_repair(browsers=['chrome', 'firefox'])
        if legacy_segment:
            child['execution_segment'] = 'a-legacy-uuid-segment'
            bridge._write(self.data, child)
        bridge.enqueue(self.data, child['id'], browsers=['chrome', 'firefox'])
        task = bridge.claim(self.data, self.owner)['task']
        self.assertEqual(task['step_number'], 3)
        if quota_step == 5:
            self.event(child['id'], task, 'workflow_sending', chat_url='https://chatgpt.com/')
            self.event(child['id'], task, 'workflow_sent', chat_url=self.chat, user_message_id='saved-hanger')
            self.event(child['id'], task, 'downloaded_bytes', base64=base64.b64encode(png(600)).decode())
            current = bridge._read(self.data, child['id'])
            current['next_step_at'] = 0
            bridge._write(self.data, current)
            task = bridge.claim(self.data, self.owner)['task']
        current = bridge._read(self.data, child['id'])
        saved = {s['key']: s['sha256'] for s in current['steps'] if s['phase'] == 'saved'}
        self.assertEqual(task['step_number'], quota_step)
        self.event(child['id'], task, 'workflow_sending', chat_url=self.chat if quota_step == 5 else 'https://chatgpt.com/')
        self.event(child['id'], task, 'workflow_sent', chat_url=self.chat, user_message_id=f'refused-{quota_step}')
        result = self.event(child['id'], task, 'workflow_quota',
                            quota_text='你已达到图片生成额度上限，请在3小时后再试。',
                            failed_prompt_marker=task['prompt_marker'], generated_images=0, generating=False)
        self.assertTrue(result['relayed'])
        relayed = bridge._read(self.data, child['id'])
        self.assertEqual(relayed['execution_segment'], 1 if legacy_segment else 2)
        self.assertEqual(relayed['current_step'], quota_step)
        self.assertEqual(flow.current(relayed)['phase'], 'ready')
        self.assertNotEqual(flow.current(relayed)['step_token'], task['step_token'])
        self.assertEqual(bridge._stable_job_chat_url(relayed), '')
        for step in relayed['steps']:
            if step['key'] in saved:
                self.assertEqual(step['sha256'], saved[step['key']])
                self.assertTrue(bridge._saved(step))
        firefox = {**self.owner, 'browser': 'firefox', 'worker_id': 'quota-clean-firefox'}
        moved = bridge.claim(self.data, firefox)['task']
        self.assertEqual(moved['step_number'], quota_step)
        self.assertEqual(moved['chat_url'], '')
        master = base64.b64decode(moved['attachments'][1]['base64'])
        self.assertEqual(hashlib.sha256(master).hexdigest(), saved['main'])
        self.assertEqual(self.source_path.read_bytes(), self.source_bytes)

    def test_legacy_repair_segment_relays_quota_at_hanger_without_losing_seeds(self):
        self.assert_quota_relay(3, legacy_segment=True)

    def test_repair_relays_quota_at_flatlay_without_regenerating_saved_hanger(self):
        self.assert_quota_relay(5)


if __name__ == '__main__':
    unittest.main()
