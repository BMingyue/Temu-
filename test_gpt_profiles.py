"""Profile pool regression tests; all inputs, jobs and outputs are temporary."""
import base64
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from tempfile import TemporaryDirectory
import time
import unittest

import gpt_extension_bridge as bridge
import gpt_unattended as policy
import image_jobs
import image_workflows as flow
from test_image_workflows import png

QUOTA = 'You have reached the image generation limit. Try again in 3 hours.'


class ProfilePoolTests(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.data = self.root / 'data'
        self.reference = self.root / 'reference.png'
        self.reference.write_bytes(png(0))
        bridge.WORKERS.clear()
        self.owners = [
            dict(browser=browser, worker_id=worker, session=worker + ':tab-1',
                 version=bridge.EXTENSION_VERSION)
            for browser, worker in [('chrome', 'chrome-a'), ('chrome', 'chrome-b'),
                                    ('firefox', 'firefox-a'), ('firefox', 'firefox-b')]
        ]
        self.ca, self.cb, self.fa, self.fb = self.owners
        for owner in self.owners:
            bridge.heartbeat(dict(owner, status='已连接', page='https://chatgpt.com/'), self.data)
        self.sequence = 0

    def tearDown(self):
        bridge.WORKERS.clear()
        self.temp.cleanup()

    def prepare(self, browsers=None):
        self.sequence += 1
        job = image_jobs.prepare(dict(
            title='profile-test-' + str(self.sequence), workflow_id=flow.DEFAULT_PRESET,
            reference=str(self.reference), output_folder=str(self.root / 'out')), self.data)
        job.update(queue_number=self.sequence, eligible_browsers=browsers or ['chrome', 'firefox'])
        bridge._write(self.data, job)
        bridge.enqueue(self.data, job['id'])
        return job['id']

    def claim(self, owner):
        return bridge.claim(self.data, owner)

    def event(self, owner, task, event, **kwargs):
        return bridge.update(self.data, dict(
            owner, job_id=task['job_id'], step=task['step_number'],
            step_token=task['step_token'], event=event, **kwargs))

    def send(self, owner, task):
        self.event(owner, task, 'workflow_sending', chat_url='https://chatgpt.com/')
        self.event(owner, task, 'workflow_sent',
                   chat_url='https://chatgpt.com/c/' + owner['worker_id'],
                   user_message_id='user-' + task['step_token'])

    def failures(self, owner, age=1):
        jobs = []
        for offset in range(3):
            ident = self.prepare(['chrome'])
            job = bridge._read(self.data, ident)
            job.update(batch_phase='needs_review', runner=None,
                       assigned_browser=owner['browser'], assigned_worker=owner['worker_id'],
                       failed_at=datetime.fromtimestamp(time.time() - age - offset, timezone.utc).isoformat(),
                       failure_reason='presend_page_lost')
            bridge._write(self.data, job)
            jobs.append(job)
        return jobs

    def test_four_profiles_claim_unique_jobs_concurrently(self):
        for _ in range(8):
            self.prepare()
        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(self.claim, self.owners))
        tasks = [result['task'] for result in results]
        self.assertTrue(all(tasks))
        self.assertEqual(len({task['job_id'] for task in tasks}), 4)
        for owner, task in zip(self.owners, tasks):
            self.assertEqual(bridge._read(self.data, task['job_id'])['assigned_worker'], owner['worker_id'])
            self.assertEqual(self.claim(owner)['task']['job_id'], task['job_id'])
            self.assertIsNone(self.claim(dict(owner, session=owner['worker_id'] + ':tab-2'))['task'])

    def test_completion_gap_is_separate_for_same_browser_profiles(self):
        first = self.prepare(['chrome'])
        second = self.prepare(['chrome'])
        task = self.claim(self.ca)['task']
        job = bridge._read(self.data, first)
        job.update(batch_phase='saved', runner=None, completed_at=bridge.now())
        bridge._write(self.data, job)
        self.assertIsNone(self.claim(self.ca)['task'])
        self.assertEqual(self.claim(self.cb)['task']['job_id'], second)
        self.assertGreater(bridge._task_gap_remaining([job], 'chrome', 'chrome-a'), 0)
        self.assertEqual(bridge._task_gap_remaining([job], 'chrome', 'chrome-b'), 0)

    def test_quota_hold_survives_reload_without_blocking_sibling(self):
        self.prepare(['chrome'])
        policy.block_account(self.data, 'chrome', QUOTA, 'chrome-a')
        bridge.WORKERS.clear()
        self.assertTrue(self.claim(self.ca)['account_blocked'])
        self.assertTrue(bridge.watchdog(self.data, self.ca)['account_blocked'])
        self.assertFalse(policy.account(self.data, 'chrome', 'chrome-b')['blocked'])
        task = self.claim(self.cb)['task']
        self.assertIsNotNone(task)
        self.send(self.cb, task)

    def test_legacy_browser_hold_stays_conservative(self):
        self.prepare(['chrome'])
        policy.block_account(self.data, 'chrome', QUOTA)
        for owner in (self.ca, self.cb):
            self.assertTrue(self.claim(owner)['account_blocked'])

    def test_explicit_browser_hold_after_scoped_hold_still_blocks_all_profiles(self):
        policy.block_account(self.data, 'chrome', QUOTA, 'chrome-a')
        browser_hold = policy.block_account(self.data, 'chrome', QUOTA)
        self.assertEqual(browser_hold['worker_id'], '')
        self.assertTrue(policy.account(self.data, 'chrome', 'chrome-b')['blocked'])
        self.assertEqual(browser_hold['until'], policy.block_account(self.data, 'chrome', QUOTA)['until'])

    def test_free_preferred_sibling_retains_its_short_reservation(self):
        self.prepare(['chrome', 'firefox'])
        policy.block_account(self.data, 'chrome', QUOTA, 'chrome-a')
        self.assertIsNone(self.claim(self.fa)['task'])
        self.assertIsNotNone(self.claim(self.cb)['task'])

    def test_exact_quota_rejection_can_relay_to_same_browser_sibling(self):
        ident = self.prepare(['chrome'])
        task = self.claim(self.ca)['task']
        self.send(self.ca, task)
        response = self.event(self.ca, task, 'workflow_quota', quota_text=QUOTA,
                              failed_prompt_marker=task['prompt_marker'],
                              generated_images=0, generating=False)
        self.assertTrue(response['relayed'])
        moved = self.claim(self.cb)['task']
        self.assertEqual(moved['job_id'], ident)
        self.assertEqual(moved['chat_url'], '')
        self.assertNotEqual(moved['step_token'], task['step_token'])
        self.assertTrue(policy.account(self.data, 'chrome', 'chrome-a')['blocked'])
        self.assertFalse(policy.account(self.data, 'chrome', 'chrome-b')['blocked'])
        with self.assertRaises(ValueError):
            self.event(self.ca, task, 'workflow_sending', chat_url='https://chatgpt.com/')

    def test_stable_chat_recovery_stays_with_original_profile(self):
        ident = self.prepare(['chrome'])
        task = self.claim(self.ca)['task']
        self.send(self.ca, task)
        policy.isolate(self.data, bridge._read(self.data, ident), 'connection interrupted')
        bridge.enqueue(self.data, ident)
        self.assertIsNone(self.claim(self.cb)['task'])
        self.assertFalse(bridge.watchdog(self.data, self.cb)['pending'])
        resumed = self.claim(self.ca)['task']
        self.assertEqual(resumed['job_id'], ident)
        self.assertEqual(resumed['chat_url'], 'https://chatgpt.com/c/chrome-a')
        self.assertEqual(resumed['step_phase'], 'sent')

    def test_ready_workflow_with_draft_cannot_change_profile_on_recovery(self):
        ident = self.prepare(['chrome'])
        task = self.claim(self.ca)['task']
        self.event(self.ca, task, 'workflow_needs_review', message='upload paused')
        bridge.enqueue(self.data, ident)
        self.assertIsNone(self.claim(self.cb)['task'])
        self.assertEqual(self.claim(self.ca)['task']['step_token'], task['step_token'])

    def test_sibling_cannot_refresh_owner_heartbeat_or_report_send(self):
        ident = self.prepare(['chrome'])
        task = self.claim(self.ca)['task']
        job = bridge._read(self.data, ident)
        job['owner_seen'] = time.time() - 40
        bridge._write(self.data, job)
        bridge.heartbeat(dict(self.cb, status='已连接'), self.data)
        self.assertEqual(bridge._read(self.data, ident)['owner_seen'], job['owner_seen'])
        with self.assertRaisesRegex(ValueError, '另一浏览器账号'):
            self.event(self.cb, task, 'workflow_sending', chat_url='https://chatgpt.com/')
        self.assertEqual(bridge._read(self.data, ident)['steps'][0]['phase'], 'ready')

    def test_three_presend_losses_open_only_origin_profile_circuit(self):
        failed = []
        for _ in range(3):
            ident = self.prepare(['chrome'])
            job = bridge._read(self.data, ident)
            job.update(batch_phase='claimed', assigned_browser='chrome',
                       assigned_worker='chrome-a', claim_session=self.ca['session'],
                       owner_seen=time.time() - bridge.PRESEND_STALE_SECONDS - 1)
            job['steps'][0]['ready_started_at'] = bridge.now()
            bridge._write(self.data, job)
            failed.append(ident)
        remaining = self.prepare(['chrome'])
        jobs = bridge.maintenance(self.data)
        self.assertTrue(bridge._generation_circuit(jobs, 'chrome', 'chrome-a')['open'])
        self.assertFalse(bridge._generation_circuit(jobs, 'chrome', 'chrome-b')['open'])
        for ident in failed:
            job = bridge._read(self.data, ident)
            self.assertEqual(job['batch_phase'], 'needs_review')
            self.assertEqual(job['failure_reason'], 'presend_page_lost')
            self.assertTrue(job['failed_at'])
            self.assertEqual(job['steps'][0]['phase'], 'ready')
        self.assertTrue(self.claim(self.ca)['circuit_open'])
        self.assertFalse(bridge.watchdog(self.data, self.ca)['pending'])
        self.assertEqual(self.claim(self.cb)['task']['job_id'], remaining)

    def test_half_open_probe_does_not_reserve_sibling_slot(self):
        self.failures(self.ca, bridge.CIRCUIT_COOLDOWN_SECONDS + 10)
        self.prepare(['chrome'])
        self.prepare(['chrome'])
        probe = self.claim(self.ca)['task']
        sibling = self.claim(self.cb)['task']
        self.assertNotEqual(probe['job_id'], sibling['job_id'])
        job = bridge._read(self.data, probe['job_id'])
        self.assertTrue(job['circuit_probe'])
        self.assertEqual(job['circuit_probe_worker'], 'chrome-a')
        self.assertIsNone(self.claim(dict(self.ca, session='chrome-a:other-tab'))['task'])

    def test_isolation_of_bad_products_does_not_trip_profile_circuit(self):
        for _ in range(3):
            ident = self.prepare(['chrome'])
            task = self.claim(self.ca)['task']
            policy.isolate(self.data, bridge._read(self.data, task['job_id']), 'bad reference')
        jobs = bridge.maintenance(self.data)
        self.assertFalse(bridge._generation_circuit(jobs, 'chrome', 'chrome-a')['open'])

    def test_later_unsent_step_keeps_saved_main_after_page_loss(self):
        ident = self.prepare(['chrome'])
        task = self.claim(self.ca)['task']
        self.send(self.ca, task)
        raw = png(1)
        self.event(self.ca, task, 'downloaded_bytes', base64=base64.b64encode(raw).decode())
        job = bridge._read(self.data, ident)
        master = Path(job['steps'][0]['output'])
        job['steps'][1]['ready_started_at'] = '2000-01-01T00:00:00+00:00'
        job['owner_seen'] = time.time() - 3600
        bridge._write(self.data, job)
        bridge.maintenance(self.data)
        saved = bridge._read(self.data, ident)
        self.assertEqual(saved['failure_reason'], 'presend_page_lost')
        self.assertEqual(saved['steps'][1]['phase'], 'ready')
        self.assertEqual(saved['assigned_worker'], 'chrome-a')
        self.assertEqual(master.read_bytes(), raw)
        self.assertEqual(saved['chat_url'], 'https://chatgpt.com/c/chrome-a')

    def test_snapshot_reports_each_profile_independently(self):
        self.prepare(['chrome'])
        task = self.claim(self.ca)['task']
        policy.block_account(self.data, 'chrome', QUOTA, 'chrome-b')
        snapshot = bridge.snapshot(self.data)
        rows = {row['worker_id']: row for row in snapshot['workers']}
        self.assertEqual(len(rows), 4)
        self.assertEqual(rows['chrome-a']['metrics']['claimed'], 1)
        self.assertEqual(rows['chrome-b']['metrics']['claimed'], 0)
        self.assertFalse(rows['chrome-a']['account']['blocked'])
        self.assertTrue(rows['chrome-b']['account']['blocked'])
        self.assertNotEqual(rows['chrome-a']['channel_id'], rows['chrome-b']['channel_id'])
        self.assertEqual(snapshot['scheduler']['circuit_scope'], 'per_worker')
        self.assertEqual(image_jobs.compact_job(bridge._read(self.data, task['job_id']))['assigned_worker'], 'chrome-a')


if __name__ == '__main__':
    unittest.main()
