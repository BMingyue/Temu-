"""A partial set can resume only its proven-unsent current step.

All files and bridge operations below use synthetic images in a temporary
directory. No browser, website or production job is used.
"""
import base64
import hashlib
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

import gpt_extension_bridge as bridge
import gpt_unattended as unattended
import image_jobs
import image_workflows as workflow
from test_image_workflows import png


class PartialPresendRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.data = self.root / 'data'
        reference = self.root / 'reference.png'
        reference.write_bytes(png(0))
        self.owner = dict(browser='chrome', worker_id='partial-worker',
                          session='original-tab', version='0.4.8')
        self.chat = 'https://chatgpt.com/c/partial-set-original'
        self.job = image_jobs.prepare(dict(
            title='partial-presend', workflow_id=workflow.SWEATER_PRESET,
            reference=str(reference), output_folder=str(self.root / 'output')), self.data)
        self.job['eligible_browsers'] = ['chrome']
        bridge._write(self.data, self.job)
        bridge.enqueue(self.data, self.job['id'])
        for number in (1, 2):
            task = bridge.claim(self.data, self.owner)['task']
            self.assertEqual(task['step_number'], number)
            self.event(task, 'workflow_sending', chat_url='https://chatgpt.com/' if number == 1 else self.chat)
            self.event(task, 'workflow_sent', chat_url=self.chat, user_message_id='user-' + str(number))
            self.event(task, 'downloaded_bytes', base64=base64.b64encode(png(number)).decode())
            job = bridge._read(self.data, self.job['id'])
            job['next_step_at'] = 0
            bridge._write(self.data, job)
        self.task = bridge.claim(self.data, self.owner)['task']
        self.assertEqual(self.task['step_number'], 3)
        self.saved = self.saved_files()

    def tearDown(self):
        self.temp.cleanup()

    def event(self, task, event, owner=None, **details):
        return bridge.update(self.data, dict(owner or self.owner,
            job_id=self.job['id'], event=event, step=task['step_number'],
            step_token=task['step_token'], **details))

    def saved_files(self):
        job = bridge._read(self.data, self.job['id'])
        return {step['number']: hashlib.sha256(Path(step['output']).read_bytes()).hexdigest()
                for step in job['steps'] if bridge._saved(step)}

    def isolate_attachment_failure(self):
        return self.event(self.task, 'workflow_needs_review',
            message='2 个附件未在发送框中稳定挂载，已停止发送（图片 2/2、上传中 false）')

    def test_attachment_failure_preserves_two_images_and_unsent_third_step(self):
        result = self.isolate_attachment_failure()
        self.assertTrue(result['task_isolated'])
        job = bridge._read(self.data, self.job['id'])
        self.assertEqual(job['batch_phase'], 'needs_review')
        self.assertEqual(job['current_step'], 3)
        self.assertEqual([step['phase'] for step in job['steps']],
                         ['saved', 'saved', 'ready', 'ready', 'ready'])
        self.assertIsNone(job['runner'])
        self.assertEqual(job['claim_session'], '')
        self.assertEqual(job['chat_url'], self.chat)
        self.assertEqual(job['assigned_worker'], self.owner['worker_id'])
        self.assertTrue(job['sent_at'], 'Set-level sent_at belongs to earlier saved steps')
        for field in ('send_started_at', 'sent_at', 'user_message_id'):
            self.assertNotIn(field, workflow.current(job))
        self.assertEqual(self.saved_files(), self.saved)

    def test_explicit_ready_recovery_resumes_third_step_in_original_chat(self):
        self.isolate_attachment_failure()
        recovered = unattended.recover_selected(self.data, [self.job['id']], list(bridge.BROWSERS))
        self.assertEqual(recovered['queued'], [self.job['id']])
        self.assertEqual(recovered['protected'], [])
        # A stale page cannot send after its claim has been released.
        with self.assertRaises(ValueError):
            self.event(self.task, 'workflow_sending', chat_url=self.chat)
        next_owner = {**self.owner, 'session': 'new-original-profile-tab'}
        resumed = bridge.claim(self.data, next_owner)['task']
        self.assertEqual(resumed['step_number'], 3)
        self.assertEqual(resumed['step_phase'], 'ready')
        self.assertEqual(resumed['chat_url'], self.chat)
        self.assertEqual(resumed['step_token'], self.task['step_token'])
        self.assertEqual(len(resumed['attachments']), 2)
        master = base64.b64decode(resumed['attachments'][1]['base64'])
        self.assertEqual(hashlib.sha256(master).hexdigest(), self.saved[1])
        self.assertEqual(self.saved_files(), self.saved)
        self.assertEqual(sum(step['phase'] == 'saved' for step in bridge._read(self.data, self.job['id'])['steps']), 2)

    def test_sending_or_sent_current_step_stays_protected(self):
        for phase in ('sending', 'sent'):
            with self.subTest(phase=phase):
                # Each subcase starts from the same ready third step.
                if phase == 'sending':
                    self.event(self.task, 'workflow_sending', chat_url=self.chat)
                else:
                    job = bridge._read(self.data, self.job['id'])
                    job.update(batch_phase='sending', runner='chrome_extension',
                               claim_session=self.owner['session'])
                    bridge._write(self.data, job)
                    self.event(self.task, 'workflow_sent', chat_url=self.chat,
                               user_message_id='third-result-not-confirmed')
                self.event(self.task, 'workflow_needs_review', message='Current send/result requires checking')
                before = (self.data / 'image-jobs' / self.job['id'] / 'job.json').read_bytes()
                recovered = unattended.recover_selected(self.data, [self.job['id']], list(bridge.BROWSERS))
                self.assertEqual(recovered['queued'], [])
                self.assertEqual(recovered['protected'], [self.job['id']])
                self.assertEqual((self.data / 'image-jobs' / self.job['id'] / 'job.json').read_bytes(), before)
                self.assertEqual(self.saved_files(), self.saved)

    def test_recovery_remains_bound_to_original_browser_and_worker(self):
        self.isolate_attachment_failure()
        unattended.recover_selected(self.data, [self.job['id']], list(bridge.BROWSERS))
        for other in ({**self.owner, 'browser': 'firefox', 'worker_id': 'other'},
                      {**self.owner, 'worker_id': 'other-chrome-profile'}):
            self.assertIsNone(bridge.claim(self.data, other)['task'])
        resumed = bridge.claim(self.data, {**self.owner, 'session': 'fresh-tab'})['task']
        self.assertEqual(resumed['step_number'], 3)
        self.assertEqual(resumed['chat_url'], self.chat)

    def test_corrupt_master_prevents_ready_recovery(self):
        self.isolate_attachment_failure()
        job = bridge._read(self.data, self.job['id'])
        Path(job['steps'][0]['output']).write_bytes(png(99))
        before = (self.data / 'image-jobs' / self.job['id'] / 'job.json').read_bytes()
        result = unattended.recover_selected(self.data, [self.job['id']], list(bridge.BROWSERS))
        self.assertEqual(result['queued'], [])
        self.assertEqual(result['protected'], [self.job['id']])
        self.assertEqual((self.data / 'image-jobs' / self.job['id'] / 'job.json').read_bytes(), before)

    def test_ready_with_current_step_send_evidence_stays_protected(self):
        self.isolate_attachment_failure()
        for field in ('send_started_at', 'sent_at', 'user_message_id'):
            with self.subTest(field=field):
                job = bridge._read(self.data, self.job['id'])
                step = workflow.current(job)
                for key in ('send_started_at', 'sent_at', 'user_message_id'):
                    step.pop(key, None)
                step[field] = 'observed-current-step-send'
                bridge._write(self.data, job)
                path = self.data / 'image-jobs' / self.job['id'] / 'job.json'
                before = path.read_bytes()
                result = unattended.recover_selected(self.data, [self.job['id']], list(bridge.BROWSERS))
                self.assertEqual(result['queued'], [])
                self.assertEqual(result['protected'], [self.job['id']])
                self.assertEqual(path.read_bytes(), before)
                self.assertEqual(self.saved_files(), self.saved)

    def test_presend_attachment_fault_is_distinct_from_generic_task_failure(self):
        self.event(self.task, 'workflow_needs_review',
                   message='2 个附件未在发送框中稳定挂载',
                   code='workflow_attachment_not_ready')
        job = bridge._read(self.data, self.job['id'])
        self.assertEqual(job['failure_reason'], 'workflow_attachment_not_ready')
        self.assertEqual(workflow.current(job)['phase'], 'ready')
        self.assertEqual(self.saved_files(), self.saved)

    def test_repeated_attachment_fault_pauses_only_the_failing_profile(self):
        jobs = []
        for number in range(3):
            jobs.append(dict(id=str(number), assigned_browser='chrome',
                             assigned_worker='broken-profile',
                             batch_phase='needs_review', failed_at=bridge.now(),
                             failure_reason='workflow_attachment_not_ready'))
        circuit = bridge._generation_circuit(jobs, 'chrome', 'broken-profile')
        self.assertTrue(circuit['open'])
        self.assertEqual(circuit['consecutive'], 3)
        self.assertGreater(circuit['wait_seconds'], 0)
        self.assertFalse(bridge._generation_circuit(jobs, 'chrome', 'healthy-profile')['open'])
        self.assertFalse(bridge._generation_circuit(jobs, 'edge', 'broken-profile')['open'])

    def test_attachment_code_cannot_reclassify_an_already_sent_step(self):
        self.event(self.task, 'workflow_sending', chat_url=self.chat)
        self.event(self.task, 'workflow_sent', chat_url=self.chat, user_message_id='uncertain-message')
        self.event(self.task, 'workflow_needs_review',
                   message='附件状态需要检查', code='workflow_attachment_not_ready')
        job = bridge._read(self.data, self.job['id'])
        self.assertEqual(workflow.current(job)['phase'], 'sent')
        self.assertEqual(job['failure_reason'], 'task_stalled')
        result = unattended.recover_selected(self.data, [self.job['id']], ['chrome'])
        self.assertEqual(result['queued'], [])
        self.assertEqual(result['protected'], [self.job['id']])


if __name__ == '__main__':
    unittest.main()
