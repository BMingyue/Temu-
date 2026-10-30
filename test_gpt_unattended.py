import base64
import hashlib
from pathlib import Path
from tempfile import TemporaryDirectory
import time
import unittest
from unittest.mock import patch

import gpt_extension_bridge as bridge
import gpt_unattended as policy
import image_jobs
import image_workflows as flow
from test_image_workflows import png

QUOTA = '你已达到 Plus 套餐的图像生成请求上限。上限将在 3 小时后重置，届时可创建更多图像。本次未能调用图像生成工具。'


class UnattendedTests(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.data = self.root / 'data'
        self.ref = self.root / 'reference.png'
        self.ref.write_bytes(png(0))
        self.chrome = dict(browser='chrome', worker_id='c', session='c-tab', version='0.4.6')
        self.edge = dict(browser='edge', worker_id='e', session='e-tab', version='0.4.6')
        self.firefox = dict(browser='firefox', worker_id='f', session='f-tab', version='0.4.6')
        self.chat = 'https://chatgpt.com/c/chrome-original-chat'
        self.job = self.prepare()

    def tearDown(self):
        self.temp.cleanup()

    def prepare(self):
        job = image_jobs.prepare(dict(title='unattended', workflow_id=flow.DEFAULT_PRESET,
            reference=str(self.ref), output_folder=str(self.root / 'out')), self.data)
        job.update(eligible_browsers=list(bridge.BROWSERS), preferred_browser='chrome')
        bridge._write(self.data, job)
        bridge.enqueue(self.data, job['id'])
        return job

    def event(self, task, event, owner=None, **kwargs):
        return bridge.update(self.data, {**(owner or self.chrome), 'job_id': task['job_id'],
            'step': task['step_number'], 'step_token': task['step_token'], 'event': event, **kwargs})

    def send(self, task, owner=None, chat=None):
        chat = chat or self.chat
        self.event(task, 'workflow_sending', owner, chat_url=chat if task['step_number'] > 1 and task['chat_url'] else 'https://chatgpt.com/')
        self.event(task, 'workflow_sent', owner, chat_url=chat, user_message_id='m-' + task['step_token'])

    def reject_quota(self, task, **kwargs):
        body = dict(quota_text=QUOTA, failed_prompt_marker=task['prompt_marker'], generated_images=0, generating=False)
        body.update(kwargs)
        return self.event(task, 'workflow_quota', **body)

    def test_exhausted_account_survives_reload_cannot_claim_or_wake(self):
        policy.block_account(self.data, 'chrome', QUOTA)
        self.assertTrue(policy.account(self.data, 'chrome')['blocked'])
        self.assertTrue(bridge.claim(self.data, self.chrome)['account_blocked'])
        self.assertFalse(bridge.watchdog(self.data, self.chrome)['pending'])
        self.assertTrue(bridge.watchdog(self.data, self.chrome)['account_blocked'])
        task = bridge.claim(self.data, self.firefox)['task']
        self.assertEqual(task['job_id'], self.job['id'])

    def test_duplicate_quota_does_not_extend_hold(self):
        first = policy.block_account(self.data, 'chrome', QUOTA)
        self.assertEqual(first['until'], policy.block_account(self.data, 'chrome', QUOTA)['until'])
        self.assertGreater(first['wait_seconds'], 3 * 3600)
        with patch.object(policy.time, 'time', return_value=first['until'] + 1):
            self.assertFalse(policy.account(self.data, 'chrome')['blocked'])

    def test_old_worker_cannot_pick_up_new_handoffs(self):
        policy.block_account(self.data, 'chrome', QUOTA)
        result = bridge.claim(self.data, {**self.firefox, 'version': '0.4.5'})
        self.assertIsNone(result['task'])
        self.assertIn(bridge.EXTENSION_VERSION, result['message'])

    def test_exact_quota_rejection_can_move_only_this_unsaved_attempt(self):
        task = bridge.claim(self.data, self.chrome)['task']
        self.send(task)
        self.assertTrue(self.reject_quota(task)['relayed'])
        job = bridge._read(self.data, self.job['id'])
        self.assertEqual(job['steps'][0]['phase'], 'ready')
        self.assertNotEqual(job['steps'][0]['step_token'], task['step_token'])
        self.assertEqual(job['chat_history'][0]['chat_url'], self.chat)
        self.assertEqual(bridge._stable_job_chat_url(job), '')
        moved = bridge.claim(self.data, self.firefox)['task']
        self.assertEqual(moved['chat_url'], '')
        self.assertEqual(len(moved['attachments']), 2)
        with self.assertRaises(ValueError):
            self.event(task, 'workflow_sending', chat_url=self.chat)

    def test_master_bytes_retained_when_later_step_moves_to_new_chat(self):
        task = bridge.claim(self.data, self.chrome)['task']
        self.send(task)
        raw = png(1)
        self.event(task, 'downloaded_bytes', base64=base64.b64encode(raw).decode())
        job = bridge._read(self.data, self.job['id'])
        master = Path(job['steps'][0]['output'])
        job['next_step_at'] = 0
        bridge._write(self.data, job)
        task = bridge.claim(self.data, self.chrome)['task']
        self.send(task)
        self.reject_quota(task)
        moved = bridge.claim(self.data, self.edge)['task']
        self.assertEqual(moved['step_number'], 2)
        self.assertEqual(moved['chat_url'], '')
        self.assertEqual(base64.b64decode(moved['attachments'][1]['base64']), raw)
        self.assertEqual(master.read_bytes(), raw)
        self.send(moved, self.edge, 'https://chatgpt.com/c/edge-relay-chat')
        saved = bridge._read(self.data, self.job['id'])
        self.assertEqual(saved['chat_url'], 'https://chatgpt.com/c/edge-relay-chat')
        self.assertEqual(saved['steps'][0]['sha256'], hashlib.sha256(raw).hexdigest())

    def test_quota_without_current_turn_or_with_images_never_resends(self):
        task = bridge.claim(self.data, self.chrome)['task']
        self.send(task)
        for changes in (dict(failed_prompt_marker='old-marker'), dict(generated_images=1), dict(generating=True),
                        dict(quota_text='图片生成失败，请重新发送')):
            with self.assertRaises(ValueError):
                self.reject_quota(task, **changes)
        self.assertEqual(bridge._read(self.data, self.job['id'])['steps'][0]['phase'], 'sent')
        self.assertFalse(policy.account(self.data, 'chrome')['blocked'])

    def test_unknown_sent_result_is_not_rerouted_by_account_block(self):
        task = bridge.claim(self.data, self.chrome)['task']
        self.send(task)
        policy.block_account(self.data, 'chrome', QUOTA)
        bridge.maintenance(self.data)
        job = bridge._read(self.data, self.job['id'])
        self.assertEqual(job['steps'][0]['phase'], 'sent')
        self.assertEqual(job['assigned_browser'], 'chrome')
        self.assertIsNone(bridge.claim(self.data, self.firefox)['task'])

    def test_quota_after_ready_does_not_regenerate_saved_main(self):
        task = bridge.claim(self.data, self.chrome)['task']
        self.send(task)
        self.event(task, 'downloaded_bytes', base64=base64.b64encode(png(1)).decode())
        policy.block_account(self.data, 'chrome', QUOTA)
        bridge.maintenance(self.data)
        moved = bridge.claim(self.data, self.firefox)['task']
        self.assertEqual(moved['step_number'], 2)
        self.assertFalse(moved['chat_url'])

    def test_ready_timeout_not_extended_by_owner_heartbeat(self):
        task = bridge.claim(self.data, self.chrome)['task']
        next_job = self.prepare()
        job = bridge._read(self.data, self.job['id'])
        job['steps'][0]['ready_started_at'] = '2000-01-01T00:00:00+00:00'
        job['owner_seen'] = time.time()
        bridge._write(self.data, job)
        bridge.maintenance(self.data)
        self.assertEqual(bridge._read(self.data, self.job['id'])['batch_phase'], 'needs_review')
        self.assertEqual(bridge.claim(self.data, self.chrome)['task']['job_id'], next_job['id'])
        with self.assertRaises(ValueError):
            self.event(task, 'workflow_sending', chat_url='https://chatgpt.com/')

    def test_sending_timeout_with_existing_chat_releases_lease(self):
        task = bridge.claim(self.data, self.chrome)['task']
        self.send(task)
        self.event(task, 'downloaded_bytes', base64=base64.b64encode(png(1)).decode())
        job = bridge._read(self.data, self.job['id'])
        job['next_step_at'] = 0
        bridge._write(self.data, job)
        task = bridge.claim(self.data, self.chrome)['task']
        self.event(task, 'workflow_sending', chat_url=self.chat)
        job = bridge._read(self.data, self.job['id'])
        job['steps'][1]['send_started_at'] = '2000-01-01T00:00:00+00:00'
        job['owner_seen'] = time.time()
        bridge._write(self.data, job)
        bridge.maintenance(self.data)
        self.assertEqual(bridge._read(self.data, self.job['id'])['batch_phase'], 'needs_review')

    def test_isolated_tasks_do_not_open_account_circuit(self):
        jobs = []
        for _ in range(3):
            jobs.append(self.prepare())
            policy.isolate(self.data, jobs[-1], 'single bad product')
        self.assertFalse(bridge._generation_circuit(jobs, 'chrome')['open'])

    def test_explicit_recovery_protects_sent_steps(self):
        task = bridge.claim(self.data, self.chrome)['task']
        self.send(task)
        policy.isolate(self.data, bridge._read(self.data, self.job['id']), 'unknown result')
        result = policy.recover_selected(self.data, [self.job['id']], list(bridge.BROWSERS))
        self.assertEqual(result['protected'], [self.job['id']])

    def test_safe_recovery_releases_never_sent_work_to_healthy_accounts(self):
        task = bridge.claim(self.data, self.chrome)['task']
        policy.isolate(self.data, bridge._read(self.data, self.job['id']), 'upload failed')
        policy.recover_selected(self.data, [self.job['id']], list(bridge.BROWSERS))
        with self.assertRaises(ValueError):
            self.event(task, 'workflow_sending', chat_url='https://chatgpt.com/')


if __name__ == '__main__':
    unittest.main()
