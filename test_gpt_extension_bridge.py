import base64
import json
import time
import unittest
from datetime import datetime, timezone
from pathlib import Path
from tempfile import TemporaryDirectory

import gpt_extension_bridge as bridge
import image_jobs


class ChatUrlValidationTests(unittest.TestCase):
    def test_encoded_temporary_chat_url_is_accepted(self):
        self.assertTrue(bridge._valid_chat_url('https://chatgpt.com/c/WEB%3Ajob-123'))
        self.assertTrue(bridge._valid_chat_url('https://chatgpt.com/c/6ab47ef3-de14-83e8-99b2-449e27b4fdd0'))
        self.assertFalse(bridge._valid_chat_url('https://evil.example/c/job-123'))

    def test_only_formal_conversation_urls_are_safe_for_recovery(self):
        self.assertFalse(bridge._stable_chat_url('https://chatgpt.com/c/WEB%3Ajob-123'))
        self.assertFalse(bridge._stable_chat_url('https://chatgpt.com/c/local-chatgpt%3Ajob-123'))
        self.assertTrue(bridge._stable_chat_url('https://chatgpt.com/c/6ab47ef3-de14-83e8-99b2-449e27b4fdd0'))


class GenerationCircuitTests(unittest.TestCase):
    def terminal(self, *, failed_seconds_ago=0, reason='response_timeout', success=False, browser='chrome'):
        ended = datetime.fromtimestamp(time.time() - failed_seconds_ago, timezone.utc).isoformat()
        if success:
            return {'completed_at': ended, 'batch_phase': 'saved', 'assigned_browser': browser}
        return {'failed_at': ended, 'failure_reason': reason, 'batch_phase': 'failed', 'assigned_browser': browser}

    def write_queued(self, root, marker='f', browsers=None):
        ident = marker * 32
        folder = Path(root) / 'image-jobs' / ident
        folder.mkdir(parents=True)
        reference = folder / 'reference.png'
        template = folder / 'template.zip'
        reference.write_bytes(b'reference')
        template.write_bytes(b'template')
        stamp = datetime.now(timezone.utc).isoformat()
        job = {
            'id': ident, 'task_no': 'IMG-CIRCUIT', 'created': stamp,
            'prompt_template': 'prompt', 'reference': str(reference),
            'template_archive': str(template), 'steps': [{'number': 1}],
            'runner': 'chrome_extension', 'batch_phase': 'queued',
            'queued_at': stamp, 'logs': [],
            'status': '等待浏览器执行',
        }
        job['eligible_browsers'] = browsers or ['chrome']
        (folder / 'job.json').write_text(json.dumps(job), encoding='utf-8')
        return ident

    def write_terminal(self, root, number, job):
        ident = str(number) * 32
        folder = Path(root) / 'image-jobs' / ident
        folder.mkdir(parents=True)
        saved = {'id': ident, 'task_no': 'IMG-OLD', 'runner': None, 'logs': [], **job}
        (folder / 'job.json').write_text(json.dumps(saved), encoding='utf-8')

    def test_three_recent_no_image_failures_open_circuit(self):
        jobs = [self.terminal(failed_seconds_ago=seconds) for seconds in (30, 20, 10)]
        state = bridge._generation_circuit(jobs)
        self.assertTrue(state['open'])
        self.assertEqual(state['consecutive'], 3)
        self.assertGreater(state['wait_seconds'], 0)

    def test_recent_presend_page_losses_open_circuit_for_that_browser(self):
        stamp = datetime.now(timezone.utc).isoformat()
        jobs = [{
            'logs': [{
                'at': stamp,
                'event': 'auto_requeue',
                'details': {'previous_browser': 'edge'},
            }],
        } for _ in range(bridge.CIRCUIT_FAILURE_COUNT)]
        edge = bridge._generation_circuit(jobs, 'edge')
        chrome = bridge._generation_circuit(jobs, 'chrome')
        self.assertTrue(edge['open'])
        self.assertEqual(edge['consecutive'], bridge.CIRCUIT_FAILURE_COUNT)
        self.assertFalse(chrome['open'])

    def test_success_after_failures_closes_circuit(self):
        jobs = [self.terminal(failed_seconds_ago=30), self.terminal(failed_seconds_ago=20),
                self.terminal(failed_seconds_ago=10), self.terminal(success=True)]
        state = bridge._generation_circuit(jobs)
        self.assertFalse(state['open'])
        self.assertEqual(state['consecutive'], 0)

    def test_old_failures_allow_one_probe_after_cooldown(self):
        age = bridge.CIRCUIT_COOLDOWN_SECONDS + 10
        jobs = [self.terminal(failed_seconds_ago=age + offset) for offset in (20, 10, 0)]
        state = bridge._generation_circuit(jobs)
        self.assertFalse(state['open'])
        self.assertTrue(state['half_open'])
        self.assertEqual(state['consecutive'], 3)

    def test_half_open_circuit_is_isolated_per_browser(self):
        with TemporaryDirectory() as root:
            age = bridge.CIRCUIT_COOLDOWN_SECONDS + 10
            for number, offset in enumerate((20, 10, 0), 1):
                self.write_terminal(root, number, self.terminal(failed_seconds_ago=age + offset))
            first = self.write_queued(root, 'e', ['chrome', 'edge'])
            second = self.write_queued(root, 'f', ['chrome', 'edge'])
            chrome = bridge.claim(root, {
                'browser': 'chrome', 'worker_id': 'chrome-worker',
                'session': 'chrome-session', 'version': bridge.EXTENSION_VERSION,
            })
            self.assertIn(chrome['task']['job_id'], (first, second))
            claimed_path = Path(root) / 'image-jobs' / chrome['task']['job_id'] / 'job.json'
            self.assertTrue(json.loads(claimed_path.read_text(encoding='utf-8'))['circuit_probe'])
            edge = bridge.claim(root, {
                'browser': 'edge', 'worker_id': 'edge-worker',
                'session': 'edge-session', 'version': bridge.EXTENSION_VERSION,
            })
            self.assertIsNotNone(edge['task'])
            self.assertNotEqual(edge['task']['job_id'], chrome['task']['job_id'])

    def test_claim_does_not_consume_queue_while_circuit_is_open(self):
        with TemporaryDirectory() as root:
            queued = self.write_queued(root)
            for number, seconds in enumerate((30, 20, 10), 1):
                self.write_terminal(root, number, self.terminal(failed_seconds_ago=seconds))
            result = bridge.claim(root, {
                'browser': 'chrome', 'worker_id': 'chrome-worker',
                'session': 'chrome-session', 'version': bridge.EXTENSION_VERSION,
            })
            self.assertIsNone(result['task'])
            self.assertTrue(result['circuit_open'])
            queued_path = Path(root) / 'image-jobs' / queued / 'job.json'
            self.assertEqual(json.loads(queued_path.read_text(encoding='utf-8'))['batch_phase'], 'queued')

    def test_explicit_page_failure_is_recorded_with_diagnostic(self):
        with TemporaryDirectory() as root:
            ident = self.write_queued(root)
            path = Path(root) / 'image-jobs' / ident / 'job.json'
            job = json.loads(path.read_text(encoding='utf-8'))
            job.update(batch_phase='waiting', assigned_browser='chrome', assigned_worker='chrome-worker',
                       claim_session='chrome-session', chat_url='https://chatgpt.com/c/test')
            path.write_text(json.dumps(job), encoding='utf-8')
            common = {'job_id': ident, 'browser': 'chrome', 'worker_id': 'chrome-worker',
                      'session': 'chrome-session'}
            bridge.update(root, {**common, 'event': 'response_diagnostic',
                                 'assistant_text': '已达到图片生成上限', 'alert_text': '请稍后再试'})
            bridge.update(root, {**common, 'event': 'generation_failed',
                                 'message': '已达到图片生成上限，请稍后再试'})
            saved = json.loads(path.read_text(encoding='utf-8'))
            self.assertEqual(saved['batch_phase'], 'failed')
            self.assertEqual(saved['failure_reason'], 'generation_failed')
            self.assertIn('图片生成上限', saved['error'])
            self.assertEqual([entry['event'] for entry in saved['logs'][-2:]],
                             ['response_diagnostic', 'generation_failed'])


class WorkerStateTests(unittest.TestCase):
    def setUp(self):
        bridge.WORKERS.clear()

    def test_repeated_snapshots_record_offline_transition_once(self):
        with TemporaryDirectory() as root:
            bridge.heartbeat({
                'browser': 'edge', 'worker_id': 'edge-worker',
                'version': bridge.EXTENSION_VERSION,
            }, root)
            key = 'edge:edge-worker'
            bridge.WORKERS[key]['_epoch'] = time.time() - bridge.WORKER_ONLINE_SECONDS - 1
            state_path = Path(root) / 'gpt-worker-state.json'
            persisted = json.loads(state_path.read_text(encoding='utf-8'))
            persisted['workers'][key]['_epoch'] = bridge.WORKERS[key]['_epoch']
            state_path.write_text(json.dumps(persisted), encoding='utf-8')

            bridge.snapshot(root)
            bridge.snapshot(root)

            saved = json.loads(state_path.read_text(encoding='utf-8'))
            offline = [event for event in saved['events'] if event['event'] == 'offline']
            self.assertEqual(len(offline), 1)
            self.assertFalse(saved['workers'][key]['online'])


class MultiReferencePayloadTests(unittest.TestCase):
    def test_payload_contains_every_reference_and_legacy_primary(self):
        with TemporaryDirectory() as root:
            folder = Path(root)
            primary = folder / 'reference.png'
            detail = folder / 'reference-02.jpg'
            template = folder / 'template.zip'
            primary.write_bytes(b'primary')
            detail.write_bytes(b'detail')
            template.write_bytes(b'template')
            job = {
                'id': 'a' * 32, 'prompt_template': 'prompt',
                'reference': str(primary),
                'reference_images': [str(primary), str(detail)],
                'template_archive': str(template), 'steps': [{'number': 1}],
                'batch_phase': 'queued',
            }
            task = bridge._payload(job)['task']
            self.assertEqual(len(task['reference_images']), 2)
            self.assertEqual(task['reference'], task['reference_images'][0])
            self.assertIn(__import__('hashlib').sha256(detail.read_bytes()).hexdigest(), bridge._input_hashes(job))

    def test_obsolete_extension_is_rejected_and_fixed_release_can_claim_multi_reference_job(self):
        with TemporaryDirectory() as root:
            ident = 'b' * 32
            folder = Path(root) / 'image-jobs' / ident
            folder.mkdir(parents=True)
            primary = folder / 'reference.png'
            detail = folder / 'reference-02.jpg'
            template = folder / 'template.zip'
            primary.write_bytes(b'primary')
            detail.write_bytes(b'detail')
            template.write_bytes(b'template')
            stamp = datetime.now(timezone.utc).isoformat()
            job = {
                'id': ident, 'task_no': 'IMG-MULTI', 'created': stamp,
                'prompt_template': 'prompt', 'reference': str(primary),
                'reference_images': [str(primary), str(detail)],
                'template_archive': str(template), 'steps': [{'number': 1}],
                'runner': 'chrome_extension', 'batch_phase': 'queued',
                'queued_at': stamp, 'preferred_browser': 'edge',
                'eligible_browsers': ['edge'], 'logs': [],
            }
            (folder / 'job.json').write_text(json.dumps(job), encoding='utf-8')
            with self.assertRaisesRegex(ValueError, bridge.EXTENSION_VERSION.replace('.', r'\.')):
                bridge.claim(root, {
                    'browser': 'edge', 'worker_id': 'edge-worker',
                    'session': 'old-session', 'version': '0.3.33',
                })
            current = bridge.claim(root, {
                'browser': 'edge', 'worker_id': 'edge-worker',
                'session': 'new-session', 'version': bridge.EXTENSION_VERSION,
            })
            self.assertEqual(current['task']['job_id'], ident)
            self.assertEqual(len(current['task']['reference_images']), 2)


class PresendRecoveryTests(unittest.TestCase):
    def make_job(self, root, *, phase='claimed', age=None):
        if age is None:
            age = bridge.PRESEND_STALE_SECONDS + 1
        ident = 'a' * 32
        folder = Path(root) / 'image-jobs' / ident
        folder.mkdir(parents=True)
        reference = folder / 'reference.png'
        template = folder / 'template.zip'
        reference.write_bytes(b'reference')
        template.write_bytes(b'template')
        job = {
            'id': ident,
            'task_no': 'IMG-TEST',
            'title': 'test',
            'prompt_template': 'prompt',
            'reference': str(reference),
            'template_archive': str(template),
            'steps': [{'number': 1, 'status': '待执行'}],
            'runner': 'chrome_extension',
            'batch_phase': phase,
            'assigned_browser': 'edge',
            'assigned_worker': 'old-worker',
            'claim_session': 'old-session',
            'owner_seen': time.time() - age,
            'claimed_at': '2026-09-17T01:00:00+08:00',
            'queued_at': '2026-09-17T00:00:00+08:00',
            'logs': [],
        }
        (folder / 'job.json').write_text(json.dumps(job, ensure_ascii=False), encoding='utf-8')
        return folder / 'job.json'

    def test_stale_claimed_task_is_safely_requeued_and_claimed_by_live_browser(self):
        with TemporaryDirectory() as root:
            path = self.make_job(root)
            result = bridge.claim(root, {
                'browser': 'chrome', 'worker_id': 'new-worker',
                'session': 'new-session', 'version': bridge.EXTENSION_VERSION,
            })
            saved = json.loads(path.read_text(encoding='utf-8'))
            self.assertEqual(result['task']['job_id'], 'a' * 32)
            self.assertEqual(saved['batch_phase'], 'claimed')
            self.assertEqual(saved['assigned_browser'], 'chrome')
            self.assertEqual(saved['assigned_worker'], 'new-worker')
            self.assertEqual(saved['claim_session'], 'new-session')
            self.assertEqual(saved['presend_stale_requeue_count'], 1)
            self.assertEqual([entry['event'] for entry in saved['logs']], ['auto_requeue', 'claimed'])

    def test_second_stale_claim_stops_instead_of_reopening_another_page(self):
        with TemporaryDirectory() as root:
            path = self.make_job(root)
            job = json.loads(path.read_text(encoding='utf-8'))
            job['presend_stale_requeue_count'] = bridge.PRESEND_STALE_REQUEUE_LIMIT
            path.write_text(json.dumps(job, ensure_ascii=False), encoding='utf-8')
            result = bridge.claim(root, {
                'browser': 'chrome', 'worker_id': 'new-worker',
                'session': 'new-session', 'version': bridge.EXTENSION_VERSION,
            })
            saved = json.loads(path.read_text(encoding='utf-8'))
            self.assertIsNone(result['task'])
            self.assertEqual(saved['batch_phase'], 'failed')
            self.assertIsNone(saved['runner'])
            self.assertEqual(saved['failure_reason'], 'presend_page_lost')
            self.assertEqual(saved['presend_stale_requeue_count'], 2)
            self.assertNotIn('auto_requeue', [entry['event'] for entry in saved['logs']])

    def test_recent_claim_is_not_taken_from_its_page(self):
        with TemporaryDirectory() as root:
            path = self.make_job(root, age=30)
            result = bridge.claim(root, {
                'browser': 'edge', 'worker_id': 'other-worker',
                'session': 'other-session', 'version': bridge.EXTENSION_VERSION,
            })
            saved = json.loads(path.read_text(encoding='utf-8'))
            self.assertIsNone(result['task'])
            self.assertEqual(saved['claim_session'], 'old-session')
            self.assertFalse(saved['logs'])

    def test_stale_claim_after_prompt_does_not_repeat_prompt(self):
        with TemporaryDirectory() as root:
            path = self.make_job(root)
            job = json.loads(path.read_text(encoding='utf-8'))
            job['logs'] = [{'event': 'progress', 'message': '提示词已填写，正在二次核对两个附件'}]
            path.write_text(json.dumps(job, ensure_ascii=False), encoding='utf-8')
            result = bridge.claim(root, {
                'browser': 'chrome', 'worker_id': 'new-worker',
                'session': 'new-session', 'version': bridge.EXTENSION_VERSION,
            })
            saved = json.loads(path.read_text(encoding='utf-8'))
            self.assertIsNone(result['task'])
            self.assertEqual(saved['batch_phase'], 'failed')
            self.assertIsNone(saved['runner'])
            self.assertIn('禁止自动重新排队', saved['error'])

    def test_stale_claim_ignores_prompt_from_prior_attempt(self):
        with TemporaryDirectory() as root:
            path = self.make_job(root)
            job = json.loads(path.read_text(encoding='utf-8'))
            job['logs'] = [
                {'event': 'progress', 'message': '提示词已填写，正在二次核对两个附件'},
                {'event': 'presend_retry', 'message': '清理旧草稿'},
                {'event': 'claimed', 'message': '新页面领取任务'},
            ]
            path.write_text(json.dumps(job, ensure_ascii=False), encoding='utf-8')
            result = bridge.claim(root, {
                'browser': 'chrome', 'worker_id': 'new-worker',
                'session': 'new-session', 'version': bridge.EXTENSION_VERSION,
            })
            saved = json.loads(path.read_text(encoding='utf-8'))
            self.assertEqual(result['task']['job_id'], job['id'])
            self.assertEqual(saved['batch_phase'], 'claimed')
            self.assertIn('auto_requeue', [entry['event'] for entry in saved['logs']])

    def test_stale_uncertain_sending_phase_is_failed_but_never_requeued(self):
        with TemporaryDirectory() as root:
            path = self.make_job(root, phase='sending', age=600)
            result = bridge.claim(root, {
                'browser': 'edge', 'worker_id': 'other-worker',
                'session': 'other-session', 'version': bridge.EXTENSION_VERSION,
            })
            saved = json.loads(path.read_text(encoding='utf-8'))
            self.assertIsNone(result['task'])
            self.assertEqual(saved['batch_phase'], 'failed')
            self.assertEqual(saved['failure_reason'], 'send_timeout')
            self.assertEqual(saved['claim_session'], '')
            self.assertIn('send_timeout', [entry['event'] for entry in saved['logs']])

    def test_waiting_keeps_original_chat_when_page_reports_home(self):
        with TemporaryDirectory() as root:
            path = self.make_job(root, phase='waiting', age=30)
            job = json.loads(path.read_text(encoding='utf-8'))
            original = 'https://chatgpt.com/c/d5f99715-5a50-4c95-8ec1-cd1c1a34b5c4'
            job['chat_url'] = 'https://chatgpt.com/'
            job['logs'] = [{'event': 'sent', 'details': {'chat_url': original}}]
            path.write_text(json.dumps(job, ensure_ascii=False), encoding='utf-8')
            self.assertEqual(bridge._payload(job)['task']['chat_url'], original)
            bridge.update(root, {
                'job_id': job['id'], 'event': 'waiting',
                'browser': 'edge', 'worker_id': 'old-worker',
                'session': 'old-session', 'chat_url': 'https://chatgpt.com/',
            })
            saved = json.loads(path.read_text(encoding='utf-8'))
            self.assertEqual(saved['chat_url'], original)

    def test_temporary_conversation_url_is_not_returned_as_recovery_target(self):
        with TemporaryDirectory() as root:
            path = self.make_job(root, phase='sending', age=30)
            job = json.loads(path.read_text(encoding='utf-8'))
            job['chat_url'] = 'https://chatgpt.com/c/local-chatgpt%3Ajob-123'
            path.write_text(json.dumps(job, ensure_ascii=False), encoding='utf-8')
            task = bridge._payload(job)['task']
            self.assertEqual(task['chat_url'], '')
            self.assertTrue(task['awaiting_chat_confirmation'])


class FairSchedulingTests(unittest.TestCase):
    def setUp(self):
        bridge.WORKERS.clear()

    def make_queued(self, root, *, number=1, age=0, browsers=None):
        ident = chr(ord('a') + number) * 32
        folder = Path(root) / 'image-jobs' / ident
        folder.mkdir(parents=True)
        reference = folder / 'reference.png'
        template = folder / 'template.zip'
        reference.write_bytes(b'reference')
        template.write_bytes(b'template')
        stamp = datetime.fromtimestamp(time.time() - age, timezone.utc).isoformat()
        job = {
            'id': ident, 'task_no': 'IMG-FAIR', 'created': stamp,
            'prompt_template': 'prompt', 'reference': str(reference),
            'template_archive': str(template), 'steps': [{'number': 1}],
            'runner': 'chrome_extension', 'batch_phase': 'queued',
            'queue_number': number, 'queued_at': stamp, 'logs': [],
        }
        if browsers is not None:
            job['eligible_browsers'] = browsers
        path = folder / 'job.json'
        path.write_text(json.dumps(job, ensure_ascii=False), encoding='utf-8')
        return ident, path

    def claim(self, root, browser):
        return bridge.claim(root, {
            'browser': browser, 'worker_id': browser + '-worker',
            'session': browser + '-session', 'version': bridge.EXTENSION_VERSION,
        })

    def test_tasks_are_reserved_round_robin_for_three_browsers(self):
        with TemporaryDirectory() as root:
            first, _ = self.make_queued(root, number=1)
            second, _ = self.make_queued(root, number=2)
            third, _ = self.make_queued(root, number=3)
            self.assertEqual(self.claim(root, 'chrome')['task']['job_id'], second)
            self.assertEqual(self.claim(root, 'edge')['task']['job_id'], first)
            self.assertEqual(self.claim(root, 'firefox')['task']['job_id'], third)

    def test_other_browser_cannot_take_over_before_offline_timeout(self):
        with TemporaryDirectory() as root:
            self.make_queued(root, number=1, age=bridge.TAKEOVER_SECONDS - 60)
            self.assertIsNone(self.claim(root, 'chrome')['task'])

    def test_recent_edge_heartbeat_preserves_short_reservation(self):
        with TemporaryDirectory() as root:
            self.make_queued(root, number=1, age=10)
            bridge.heartbeat({
                'browser': 'edge', 'worker_id': 'edge-worker',
                'version': bridge.EXTENSION_VERSION, 'status': '已连接',
            }, root)
            self.assertIsNone(self.claim(root, 'chrome')['task'])

    def test_online_reservation_expires_and_idle_chrome_takes_over(self):
        with TemporaryDirectory() as root:
            ident, path = self.make_queued(root, number=1, age=bridge.ONLINE_RESERVATION_SECONDS + 1)
            bridge.heartbeat({
                'browser': 'edge', 'worker_id': 'edge-worker',
                'version': bridge.EXTENSION_VERSION, 'status': '已连接',
            }, root)
            self.assertEqual(self.claim(root, 'chrome')['task']['job_id'], ident)
            saved = json.loads(path.read_text(encoding='utf-8'))
            self.assertEqual(saved['fallback_reason'], 'reservation_expired')

    def test_idle_browser_takes_over_while_preferred_browser_is_busy(self):
        with TemporaryDirectory() as root:
            first, _ = self.make_queued(root, number=1, browsers=['chrome', 'edge'])
            second, path = self.make_queued(root, number=3, browsers=['chrome', 'edge'])
            self.assertEqual(self.claim(root, 'edge')['task']['job_id'], first)
            self.assertEqual(self.claim(root, 'chrome')['task']['job_id'], second)
            saved = json.loads(path.read_text(encoding='utf-8'))
            self.assertEqual(saved['fallback_reason'], 'preferred_busy')

    def test_idle_browser_takes_over_during_preferred_browser_gap(self):
        with TemporaryDirectory() as root:
            _, ended_path = self.make_queued(root, number=1, browsers=['chrome', 'edge'])
            ended = json.loads(ended_path.read_text(encoding='utf-8'))
            ended.update(batch_phase='saved', runner=None, assigned_browser='edge', completed_at=bridge.now())
            ended_path.write_text(json.dumps(ended, ensure_ascii=False), encoding='utf-8')
            queued, path = self.make_queued(root, number=3, browsers=['chrome', 'edge'])
            self.assertEqual(self.claim(root, 'chrome')['task']['job_id'], queued)
            saved = json.loads(path.read_text(encoding='utf-8'))
            self.assertEqual(saved['fallback_reason'], 'preferred_cooling')

    def test_other_browser_takes_over_after_offline_timeout(self):
        with TemporaryDirectory() as root:
            ident, path = self.make_queued(root, number=1, age=bridge.TAKEOVER_SECONDS + 1)
            self.assertEqual(self.claim(root, 'chrome')['task']['job_id'], ident)
            saved = json.loads(path.read_text(encoding='utf-8'))
            self.assertEqual(saved['fallback_from'], 'edge')
            self.assertEqual([entry['event'] for entry in saved['logs']], ['fallback_claim', 'claimed'])

    def test_only_selected_browsers_can_claim_this_batch(self):
        with TemporaryDirectory() as root:
            ident, path = self.make_queued(
                root, number=1, age=bridge.TAKEOVER_SECONDS + 60,
                browsers=['firefox'],
            )
            self.assertIsNone(self.claim(root, 'chrome')['task'])
            self.assertIsNone(self.claim(root, 'edge')['task'])
            self.assertEqual(self.claim(root, 'firefox')['task']['job_id'], ident)
            saved = json.loads(path.read_text(encoding='utf-8'))
            self.assertEqual(saved['preferred_browser'], 'firefox')

    def test_selected_pair_gets_its_own_round_robin(self):
        with TemporaryDirectory() as root:
            first, _ = self.make_queued(root, number=1, browsers=['chrome', 'firefox'])
            second, _ = self.make_queued(root, number=2, browsers=['chrome', 'firefox'])
            self.assertEqual(self.claim(root, 'chrome')['task']['job_id'], first)
            self.assertEqual(self.claim(root, 'firefox')['task']['job_id'], second)

    def test_recovery_backlog_does_not_starve_unsent_jobs(self):
        with TemporaryDirectory() as root:
            _, last_path = self.make_queued(root, number=1, browsers=['edge'])
            last = json.loads(last_path.read_text(encoding='utf-8'))
            last.update(batch_phase='saved', runner=None, assigned_browser='edge',
                        claimed_at=datetime.now(timezone.utc).isoformat(),
                        chat_url='https://chatgpt.com/c/old-completed', claim_was_recovery=True)
            last_path.write_text(json.dumps(last, ensure_ascii=False), encoding='utf-8')
            fresh_id, _ = self.make_queued(root, number=2, browsers=['edge'])
            _, recovery_path = self.make_queued(root, number=3, browsers=['edge'])
            recovery = json.loads(recovery_path.read_text(encoding='utf-8'))
            recovery['chat_url'] = 'https://chatgpt.com/c/needs-recovery'
            recovery_path.write_text(json.dumps(recovery, ensure_ascii=False), encoding='utf-8')
            self.assertEqual(self.claim(root, 'edge')['task']['job_id'], fresh_id)

    def test_recovery_runs_after_an_unsent_job(self):
        with TemporaryDirectory() as root:
            _, last_path = self.make_queued(root, number=1, browsers=['edge'])
            last = json.loads(last_path.read_text(encoding='utf-8'))
            last.update(batch_phase='saved', runner=None, assigned_browser='edge',
                        claimed_at=datetime.now(timezone.utc).isoformat(),
                        chat_url='https://chatgpt.com/c/newly-completed', claim_was_recovery=False)
            last_path.write_text(json.dumps(last, ensure_ascii=False), encoding='utf-8')
            self.make_queued(root, number=2, browsers=['edge'])
            recovery_id, recovery_path = self.make_queued(root, number=3, browsers=['edge'])
            recovery = json.loads(recovery_path.read_text(encoding='utf-8'))
            recovery['chat_url'] = 'https://chatgpt.com/c/needs-recovery'
            recovery_path.write_text(json.dumps(recovery, ensure_ascii=False), encoding='utf-8')
            self.assertEqual(self.claim(root, 'edge')['task']['job_id'], recovery_id)

    def test_recovery_claim_accepts_immediate_image_progress(self):
        with TemporaryDirectory() as root:
            ident, path = self.make_queued(root, number=1, browsers=['edge'])
            job = json.loads(path.read_text(encoding='utf-8'))
            job['chat_url'] = 'https://chatgpt.com/c/needs-recovery'
            path.write_text(json.dumps(job, ensure_ascii=False), encoding='utf-8')
            claimed = self.claim(root, 'edge')
            self.assertEqual(claimed['task']['job_id'], ident)
            saved = json.loads(path.read_text(encoding='utf-8'))
            self.assertEqual(saved['batch_phase'], 'waiting')
            bridge.update(root, {
                'job_id': ident, 'browser': 'edge', 'worker_id': 'edge-worker',
                'session': 'edge-session', 'event': 'image_progress', 'count': 0,
            })
            self.assertEqual(json.loads(path.read_text(encoding='utf-8'))['batch_phase'], 'waiting')

    def test_worker_heartbeat_survives_backend_memory_reset(self):
        with TemporaryDirectory() as root:
            bridge.heartbeat({
                'browser': 'edge', 'worker_id': 'edge-worker',
                'version': bridge.EXTENSION_VERSION, 'status': '已连接',
            }, root)
            bridge.WORKERS.clear()
            state = bridge.snapshot(root)
            row = next(item for item in state['workers'] if item['browser'] == 'edge')
            self.assertTrue(row['online'])
            self.assertEqual(row['worker_id'], 'edge-worker')

    def test_firefox_heartbeat_is_accepted(self):
        with TemporaryDirectory() as root:
            bridge.heartbeat({
                'browser': 'firefox', 'worker_id': 'firefox-worker',
                'version': bridge.EXTENSION_VERSION, 'status': '已连接',
            }, root)
            row = next(item for item in bridge.snapshot(root)['workers'] if item['browser'] == 'firefox')
            self.assertTrue(row['online'])
            self.assertEqual(row['label'], 'Firefox 账号')

    def test_queued_task_can_be_paused_and_resumed(self):
        with TemporaryDirectory() as root:
            ident, path = self.make_queued(root, number=1)
            result = bridge.pause(root, ident)
            paused = json.loads(path.read_text(encoding='utf-8'))
            self.assertIn('已暂停', result['message'])
            self.assertEqual(paused['batch_phase'], 'paused')
            self.assertIsNone(paused['runner'])
            bridge.enqueue(root, ident, browsers=['firefox'])
            resumed = json.loads(path.read_text(encoding='utf-8'))
            self.assertEqual(resumed['batch_phase'], 'queued')
            self.assertEqual(resumed['runner'], 'chrome_extension')
            self.assertEqual(resumed['eligible_browsers'], ['firefox'])
            self.assertEqual(resumed['preferred_browser'], 'firefox')

    def test_sent_task_resumes_through_queue_without_stealing_active_browser(self):
        with TemporaryDirectory() as root:
            active_id, active_path = self.make_queued(root, number=1)
            active = json.loads(active_path.read_text(encoding='utf-8'))
            active.update(batch_phase='waiting', assigned_browser='edge', assigned_worker='edge-worker',
                          claim_session='edge-worker:active', chat_url='https://chatgpt.com/c/active')
            active_path.write_text(json.dumps(active, ensure_ascii=False), encoding='utf-8')
            ident, path = self.make_queued(root, number=2)
            job = json.loads(path.read_text(encoding='utf-8'))
            job.update(batch_phase='needs_review', runner=None, assigned_browser='edge',
                       eligible_browsers=['edge'], chat_url='https://chatgpt.com/c/original')
            path.write_text(json.dumps(job, ensure_ascii=False), encoding='utf-8')
            bridge.enqueue(root, ident, browsers=['edge'])
            resumed = json.loads(path.read_text(encoding='utf-8'))
            self.assertEqual(resumed['batch_phase'], 'queued')
            self.assertTrue(bridge._payload(resumed)['task']['resume'])
            result = bridge.claim(root, {'browser':'edge','worker_id':'edge-worker',
                                         'session':'edge-worker:other', 'version':bridge.EXTENSION_VERSION})
            self.assertIsNone(result['task'])
            self.assertEqual(json.loads(path.read_text(encoding='utf-8'))['batch_phase'], 'queued')

    def test_review_resume_resets_stale_response_timer_and_false_failure(self):
        with TemporaryDirectory() as root:
            ident, path = self.make_queued(root, number=1)
            job = json.loads(path.read_text(encoding='utf-8'))
            old = datetime.fromtimestamp(time.time()-3600, timezone.utc).isoformat()
            job.update(batch_phase='needs_review', runner=None, assigned_browser='firefox',
                       eligible_browsers=['firefox'], chat_url='https://chatgpt.com/c/original',
                       response_last_progress_at=old, response_refresh_count=1,
                       response_refresh_requested_at=old, failed_at=old,
                       failure_reason='response_timeout')
            path.write_text(json.dumps(job, ensure_ascii=False), encoding='utf-8')
            bridge.enqueue(root, ident, browsers=['firefox'])
            resumed = json.loads(path.read_text(encoding='utf-8'))
            self.assertEqual(resumed['batch_phase'], 'queued')
            self.assertEqual(resumed['response_refresh_count'], 0)
            self.assertGreater(bridge._timestamp(resumed['response_last_progress_at']), time.time()-10)
            self.assertNotIn('response_refresh_requested_at', resumed)
            self.assertNotIn('failed_at', resumed)
            self.assertNotIn('failure_reason', resumed)

    def test_late_download_error_does_not_spoil_saved_task(self):
        with TemporaryDirectory() as root:
            ident, path = self.make_queued(root, number=1)
            job = json.loads(path.read_text(encoding='utf-8'))
            job.update(batch_phase='saved', status='1 张已保存，待检查', runner=None, error='')
            path.write_text(json.dumps(job, ensure_ascii=False), encoding='utf-8')
            result = bridge.update(root, {'job_id':ident,'event':'error','message':'旧页面迟到的错误',
                                          'browser':'edge','worker_id':'edge-worker'})
            saved = json.loads(path.read_text(encoding='utf-8'))
            self.assertTrue(result['duplicate'])
            self.assertEqual(saved['status'], '1 张已保存，待检查')
            self.assertEqual(saved['error'], '')

    def test_downloaded_reference_is_rejected_before_archive(self):
        with TemporaryDirectory() as root:
            ident = 'b' * 32
            folder = Path(root) / 'image-jobs' / ident
            folder.mkdir(parents=True)
            png = b'\x89PNG\r\n\x1a\nreference-image'
            reference = folder / 'reference.png'
            reference.write_bytes(png)
            template = folder / 'template.zip'
            template.write_bytes(b'template')
            path = folder / 'job.json'
            path.write_text(json.dumps({
                'id': ident, 'task_no': 'IMG-INPUT-GUARD',
                'prompt_template': 'prompt', 'reference': str(reference),
                'template_archive': str(template),
                'steps': [{'number': 1, 'status': '待执行'}],
                'runner': 'chrome_extension', 'batch_phase': 'queued',
                'eligible_browsers': ['edge'], 'logs': [],
            }, ensure_ascii=False), encoding='utf-8')
            body = {'job_id': ident, 'browser': 'edge',
                    'worker_id': 'edge-worker', 'session': 'edge-worker:tab-1'}
            bridge.claim(root, {**body, 'version': bridge.EXTENSION_VERSION})
            bridge.update(root, {**body, 'event': 'sending'})
            bridge.update(root, {**body, 'event': 'sent',
                                 'chat_url': 'https://chatgpt.com/c/input-guard'})
            with self.assertRaisesRegex(ValueError, '参考印花或模板附件完全相同'):
                bridge.update(root, {**body, 'event': 'downloaded', 'step': 1,
                                     'path': str(reference)})
            saved = json.loads(path.read_text(encoding='utf-8'))
            self.assertNotEqual(saved['steps'][0].get('phase'), 'saved')
            self.assertEqual(saved['steps'][0]['status'], '待执行')
            self.assertEqual(saved['logs'][-1]['event'], 'invalid_download')

    def test_generated_image_bytes_are_archived_without_downloads_folder(self):
        with TemporaryDirectory() as root:
            ident, path = self.make_queued(root, number=1)
            prepared = json.loads(path.read_text(encoding='utf-8'))
            prepared['result_folder'] = str(Path(root) / 'results' / ident)
            path.write_text(json.dumps(prepared, ensure_ascii=False), encoding='utf-8')
            body = {'job_id': ident, 'browser': 'edge', 'worker_id': 'edge-worker', 'session': 'edge-session'}
            bridge.claim(root, {**body, 'version': bridge.EXTENSION_VERSION})
            bridge.update(root, {**body, 'event': 'sent', 'chat_url': 'https://chatgpt.com/c/bytes'})
            raw = b'\x89PNG\r\n\x1a\n' + b'generated-pixels' * 100
            bridge.update(root, {**body, 'event': 'downloaded_bytes', 'step': 1,
                                 'mime': 'image/png', 'base64': base64.b64encode(raw).decode('ascii')})
            saved = json.loads(path.read_text(encoding='utf-8'))
            self.assertEqual(saved['batch_phase'], 'saved')
            output = Path(saved['steps'][0]['output'])
            self.assertEqual(output.read_bytes(), raw)
            self.assertEqual(saved['steps'][0]['download_source'], '浏览器页面内存')

    def test_watchdog_recovers_stale_job_even_if_another_tab_is_online(self):
        with TemporaryDirectory() as root:
            ident, path = self.make_queued(root, number=1)
            job = json.loads(path.read_text(encoding='utf-8'))
            job.update(batch_phase='waiting', assigned_browser='chrome', assigned_worker='worker',
                       claim_session='worker:lost-tab', owner_seen=time.time()-600,
                       chat_url='https://chatgpt.com/c/original')
            path.write_text(json.dumps(job, ensure_ascii=False), encoding='utf-8')
            bridge.heartbeat({'browser':'chrome','worker_id':'worker','session':'worker:other-tab',
                              'version':bridge.EXTENSION_VERSION,'status':'已连接'}, root)
            state = bridge.watchdog(root, {'browser':'chrome','worker_id':'worker'})
            self.assertTrue(state['pending'])
            self.assertTrue(state['page_alive'])
            self.assertEqual(state['recovery_action']['type'], 'resume')
            self.assertEqual(state['recovery_action']['chat_url'], job['chat_url'])

    def test_watchdog_never_opens_home_recovery_for_temporary_conversation(self):
        with TemporaryDirectory() as root:
            ident, path = self.make_queued(root, number=1, browsers=['edge'])
            job = json.loads(path.read_text(encoding='utf-8'))
            job.update(batch_phase='sending', assigned_browser='edge', assigned_worker='edge-worker',
                       claim_session='edge-worker:tab-1', owner_seen=time.time()-180,
                       chat_url='https://chatgpt.com/c/local-chatgpt%3Ajob-123')
            path.write_text(json.dumps(job, ensure_ascii=False), encoding='utf-8')
            state = bridge.watchdog(root, {'browser':'edge','worker_id':'edge-worker'})
            self.assertTrue(state['pending'])
            self.assertTrue(state['page_alive'])
            self.assertIsNone(state['recovery_action'])

    def test_watchdog_wakes_queue_when_home_tab_is_draft_blocked(self):
        with TemporaryDirectory() as root:
            self.make_queued(root, number=1, browsers=['edge'])
            bridge.heartbeat({'browser':'edge','worker_id':'edge-worker',
                              'version':bridge.EXTENSION_VERSION,
                              'status':'需要清理草稿或附件'}, root)
            state = bridge.watchdog(root, {'browser':'edge','worker_id':'edge-worker'})
            self.assertTrue(state['pending'])
            self.assertFalse(state['page_alive'])

    def test_sending_task_cannot_be_paused_at_uncertain_boundary(self):
        with TemporaryDirectory() as root:
            ident, _ = self.make_queued(root, number=1)
            path = Path(root) / 'image-jobs' / ident / 'job.json'
            job = json.loads(path.read_text(encoding='utf-8'))
            job['batch_phase'] = 'sending'
            path.write_text(json.dumps(job, ensure_ascii=False), encoding='utf-8')
            with self.assertRaisesRegex(ValueError, '暂时不能暂停'):
                bridge.pause(root, ident)

    def test_reassigns_all_unsent_tasks_in_batch(self):
        with TemporaryDirectory() as root:
            batch_no = 'BATCH-20260918-010203-ABCD'
            paths = []
            for number in (1, 2):
                _, path = self.make_queued(root, number=number)
                job = json.loads(path.read_text(encoding='utf-8'))
                job['batch_no'] = batch_no
                if number == 1:
                    job.update(batch_phase='paused', runner=None)
                path.write_text(json.dumps(job, ensure_ascii=False), encoding='utf-8')
                paths.append(path)
            _, sent_path = self.make_queued(root, number=3)
            sent = json.loads(sent_path.read_text(encoding='utf-8'))
            sent.update(
                batch_no=batch_no, batch_phase='sent',
                eligible_browsers=['edge'], preferred_browser='edge',
                assigned_browser='edge', chat_url='https://chatgpt.com/c/test',
            )
            sent_path.write_text(json.dumps(sent, ensure_ascii=False), encoding='utf-8')
            result = image_jobs.reassign_batch(
                {'batch_no': batch_no, 'browsers': ['firefox']}, root,
            )
            self.assertEqual(result['reassigned'], 2)
            self.assertEqual(result['protected'], 1)
            for path in paths:
                saved = json.loads(path.read_text(encoding='utf-8'))
                self.assertEqual(saved['batch_phase'], 'queued')
                self.assertEqual(saved['eligible_browsers'], ['firefox'])
                self.assertEqual(saved['preferred_browser'], 'firefox')
            unchanged = json.loads(sent_path.read_text(encoding='utf-8'))
            self.assertEqual(unchanged['eligible_browsers'], ['edge'])
            self.assertEqual(unchanged['assigned_browser'], 'edge')

    def test_bulk_pause_only_changes_safe_selected_tasks(self):
        with TemporaryDirectory() as root:
            queued_id, queued_path = self.make_queued(root, number=1)
            sending_id, sending_path = self.make_queued(root, number=2)
            sending = json.loads(sending_path.read_text(encoding='utf-8'))
            sending['batch_phase'] = 'sending'
            sending_path.write_text(json.dumps(sending, ensure_ascii=False), encoding='utf-8')

            result = bridge.pause_many(root, [queued_id, sending_id])

            self.assertEqual(result['paused'], 1)
            self.assertEqual(result['protected'], 1)
            self.assertEqual(
                json.loads(queued_path.read_text(encoding='utf-8'))['batch_phase'],
                'paused',
            )
            self.assertEqual(
                json.loads(sending_path.read_text(encoding='utf-8'))['batch_phase'],
                'sending',
            )

    def test_bulk_reassign_only_changes_unsent_selected_tasks(self):
        with TemporaryDirectory() as root:
            queued_id, queued_path = self.make_queued(root, number=1)
            sent_id, sent_path = self.make_queued(root, number=2)
            sent = json.loads(sent_path.read_text(encoding='utf-8'))
            sent.update(
                batch_phase='sent', eligible_browsers=['edge'],
                preferred_browser='edge', assigned_browser='edge',
                chat_url='https://chatgpt.com/c/test',
            )
            sent_path.write_text(json.dumps(sent, ensure_ascii=False), encoding='utf-8')

            result = bridge.reassign_many(
                root, [queued_id, sent_id], ['chrome', 'firefox'],
            )

            self.assertEqual(result['reassigned'], 1)
            self.assertEqual(result['protected'], 1)
            queued = json.loads(queued_path.read_text(encoding='utf-8'))
            self.assertEqual(queued['eligible_browsers'], ['chrome', 'firefox'])
            self.assertEqual(queued['preferred_browser'], 'chrome')
            unchanged = json.loads(sent_path.read_text(encoding='utf-8'))
            self.assertEqual(unchanged['eligible_browsers'], ['edge'])
            self.assertEqual(unchanged['assigned_browser'], 'edge')

    def test_manual_draft_does_not_claim_a_new_task(self):
        with TemporaryDirectory() as root:
            _, path = self.make_queued(root, number=1, browsers=['edge'])
            result = bridge.claim(root, {
                'browser': 'edge', 'worker_id': 'edge-worker',
                'session': 'edge-worker:tab-1',
                'version': bridge.EXTENSION_VERSION,
                'draft_present': True,
            })
            saved = json.loads(path.read_text(encoding='utf-8'))
            self.assertIsNone(result['task'])
            self.assertTrue(result['draft_blocked'])
            self.assertEqual(saved['batch_phase'], 'queued')
            self.assertNotIn('assigned_browser', saved)

    def test_manual_draft_without_an_eligible_task_does_not_request_clean_tab(self):
        with TemporaryDirectory() as root:
            result = bridge.claim(root, {
                'browser': 'edge', 'worker_id': 'edge-worker',
                'session': 'edge-worker:tab-1',
                'version': bridge.EXTENSION_VERSION,
                'draft_present': True,
            })
            self.assertIsNone(result['task'])
            self.assertNotIn('draft_blocked', result)

    def test_manual_draft_ignores_tasks_assigned_to_another_browser(self):
        with TemporaryDirectory() as root:
            _, path = self.make_queued(root, number=1, browsers=['chrome'])
            result = bridge.claim(root, {
                'browser': 'edge', 'worker_id': 'edge-worker',
                'session': 'edge-worker:tab-1',
                'version': bridge.EXTENSION_VERSION,
                'draft_present': True,
            })
            saved = json.loads(path.read_text(encoding='utf-8'))
            self.assertIsNone(result['task'])
            self.assertNotIn('draft_blocked', result)
            self.assertEqual(saved['batch_phase'], 'queued')
            self.assertNotIn('assigned_browser', saved)

    def test_owned_task_is_returned_even_when_its_draft_is_present(self):
        with TemporaryDirectory() as root:
            ident, path = self.make_queued(root, number=1, browsers=['edge'])
            first = bridge.claim(root, {
                'browser': 'edge', 'worker_id': 'edge-worker',
                'session': 'edge-worker:tab-1',
                'version': bridge.EXTENSION_VERSION,
            })
            resumed = bridge.claim(root, {
                'browser': 'edge', 'worker_id': 'edge-worker',
                'session': 'edge-worker:tab-1',
                'version': bridge.EXTENSION_VERSION,
                'draft_present': True,
            })
            self.assertEqual(first['task']['job_id'], ident)
            self.assertEqual(resumed['task']['job_id'], ident)
            self.assertEqual(
                json.loads(path.read_text(encoding='utf-8'))['batch_phase'],
                'claimed',
            )

    def test_temporary_sent_url_stays_with_original_tab_without_retry_loop(self):
        with TemporaryDirectory() as root:
            ident, path = self.make_queued(root, number=1, browsers=['edge'])
            bridge.claim(root, {
                'browser': 'edge', 'worker_id': 'edge-worker',
                'session': 'edge-worker:tab-1', 'version': bridge.EXTENSION_VERSION,
            })
            body = {
                'job_id': ident, 'browser': 'edge', 'worker_id': 'edge-worker',
                'session': 'edge-worker:tab-1',
            }
            bridge.update(root, {**body, 'event': 'sending'})
            bridge.update(root, {
                **body, 'event': 'sent',
                'chat_url': 'https://chatgpt.com/c/local-chatgpt%3Ajob-123',
            })
            bridge.update(root, {**body, 'event': 'error', 'message': '正式地址尚未出现'})
            saved = json.loads(path.read_text(encoding='utf-8'))
            self.assertEqual(saved['batch_phase'], 'sending')
            self.assertEqual(saved['claim_session'], 'edge-worker:tab-1')
            self.assertNotIn('retry_count', saved)
            task = bridge.claim(root, {
                'browser': 'edge', 'worker_id': 'edge-worker',
                'session': 'edge-worker:tab-1', 'version': bridge.EXTENSION_VERSION,
            })['task']
            self.assertTrue(task['awaiting_chat_confirmation'])
            self.assertEqual(task['chat_url'], '')

    def test_temporary_sent_url_cannot_be_automatically_retried(self):
        with TemporaryDirectory() as root:
            ident, path = self.make_queued(root, number=1, browsers=['edge'])
            job = json.loads(path.read_text(encoding='utf-8'))
            job.update(batch_phase='failed', runner=None, sent_at=bridge.now(),
                       chat_url='https://chatgpt.com/c/local-chatgpt%3Ajob-123',
                       assigned_browser='edge', failed_at=bridge.now())
            path.write_text(json.dumps(job, ensure_ascii=False), encoding='utf-8')
            result = bridge.retry_failed(root, [ident])
            self.assertEqual(result['retried'], 0)
            self.assertEqual(len(result['skipped']), 1)
            self.assertEqual(json.loads(path.read_text(encoding='utf-8'))['batch_phase'], 'failed')

    def test_auxiliary_home_tab_does_not_replace_active_task_heartbeat(self):
        with TemporaryDirectory() as root:
            ident, path = self.make_queued(root, number=1, browsers=['edge'])
            bridge.claim(root, {
                'browser': 'edge', 'worker_id': 'edge-worker',
                'session': 'edge-worker:tab-1', 'version': bridge.EXTENSION_VERSION,
            })
            job = json.loads(path.read_text(encoding='utf-8'))
            job.update(batch_phase='waiting', chat_url='https://chatgpt.com/c/formal-chat')
            path.write_text(json.dumps(job, ensure_ascii=False), encoding='utf-8')
            bridge.heartbeat({
                'browser': 'edge', 'worker_id': 'edge-worker',
                'session': 'edge-worker:tab-1', 'version': bridge.EXTENSION_VERSION,
                'page': job['chat_url'], 'status': '执行中', 'message': '正在等待图片',
            }, root)
            bridge.heartbeat({
                'browser': 'edge', 'worker_id': 'edge-worker',
                'session': 'edge-worker:tab-2', 'version': bridge.EXTENSION_VERSION,
                'page': 'https://chatgpt.com/', 'status': '队列等待', 'message': '已有任务执行中',
            }, root)
            row = next(item for item in bridge.snapshot(root)['workers'] if item['browser'] == 'edge')
            self.assertEqual(row['page'], job['chat_url'])
            self.assertEqual(row['status'], '执行中')
            self.assertEqual(row['auxiliary_page'], 'https://chatgpt.com/')
            self.assertEqual(row['active_task_no'], job['task_no'])

    def test_presend_retry_safely_requeues_owned_task(self):
        with TemporaryDirectory() as root:
            ident, path = self.make_queued(root, number=1, browsers=['edge'])
            bridge.claim(root, {
                'browser': 'edge', 'worker_id': 'edge-worker',
                'session': 'edge-worker:tab-1',
                'version': bridge.EXTENSION_VERSION,
            })
            result = bridge.update(root, {
                'job_id': ident, 'event': 'presend_retry',
                'browser': 'edge', 'worker_id': 'edge-worker',
                'session': 'edge-worker:tab-1',
            })
            saved = json.loads(path.read_text(encoding='utf-8'))
            self.assertTrue(result['ok'])
            self.assertEqual(saved['batch_phase'], 'queued')
            self.assertEqual(saved['presend_retry_count'], 1)
            self.assertNotIn('assigned_browser', saved)
            self.assertEqual(saved['logs'][-1]['event'], 'presend_retry')

    def test_presend_retry_is_rejected_after_send_boundary(self):
        with TemporaryDirectory() as root:
            ident, path = self.make_queued(root, number=1, browsers=['edge'])
            bridge.claim(root, {
                'browser': 'edge', 'worker_id': 'edge-worker',
                'session': 'edge-worker:tab-1',
                'version': bridge.EXTENSION_VERSION,
            })
            body = {
                'job_id': ident, 'browser': 'edge',
                'worker_id': 'edge-worker', 'session': 'edge-worker:tab-1',
            }
            bridge.update(root, {**body, 'event': 'sending'})
            with self.assertRaisesRegex(ValueError, '禁止自动重试'):
                bridge.update(root, {**body, 'event': 'presend_retry'})
            self.assertEqual(
                json.loads(path.read_text(encoding='utf-8'))['batch_phase'],
                'sending',
            )

    def test_missing_attachments_can_be_repaired_in_original_chat(self):
        with TemporaryDirectory() as root:
            ident, path = self.make_queued(root, number=1, browsers=['edge'])
            bridge.claim(root, {
                'browser': 'edge', 'worker_id': 'edge-worker',
                'session': 'edge-worker:tab-1',
                'version': bridge.EXTENSION_VERSION,
            })
            body = {
                'job_id': ident, 'browser': 'edge',
                'worker_id': 'edge-worker', 'session': 'edge-worker:tab-1',
            }
            bridge.update(root, {**body, 'event': 'sending'})
            bridge.update(root, {
                **body, 'event': 'sent',
                'chat_url': 'https://chatgpt.com/c/test',
            })
            bridge.update(root, {**body, 'event': 'attachment_repairing'})
            bridge.update(root, {**body, 'event': 'attachment_repair_sending'})
            result = bridge.update(root, {**body, 'event': 'attachment_repaired'})

            saved = json.loads(path.read_text(encoding='utf-8'))
            self.assertTrue(result['ok'])
            self.assertEqual(saved['batch_phase'], 'waiting')
            self.assertEqual(saved['attachment_repair_count'], 1)
            self.assertEqual(saved['attachment_repair_state'], 'sent')
            self.assertEqual(
                [entry['event'] for entry in saved['logs'][-3:]],
                [
                    'attachment_repairing',
                    'attachment_repair_sending',
                    'attachment_repaired',
                ],
            )

    def test_attachment_repair_requires_existing_sent_chat(self):
        with TemporaryDirectory() as root:
            ident, _ = self.make_queued(root, number=1, browsers=['edge'])
            bridge.claim(root, {
                'browser': 'edge', 'worker_id': 'edge-worker',
                'session': 'edge-worker:tab-1',
                'version': bridge.EXTENSION_VERSION,
            })
            with self.assertRaisesRegex(ValueError, '不能补传附件'):
                bridge.update(root, {
                    'job_id': ident, 'event': 'attachment_repairing',
                    'browser': 'edge', 'worker_id': 'edge-worker',
                    'session': 'edge-worker:tab-1',
                })

    def test_stalled_response_refreshes_once_then_fails_and_releases_browser(self):
        with TemporaryDirectory() as root:
            ident, path = self.make_queued(root, number=1, browsers=['edge'])
            next_id, _ = self.make_queued(root, number=2, browsers=['edge'])
            self.claim(root, 'edge')
            body = {'job_id': ident, 'browser': 'edge', 'worker_id': 'edge-worker', 'session': 'edge-session'}
            bridge.update(root, {**body, 'event': 'sent', 'chat_url': 'https://chatgpt.com/c/test'})
            job = json.loads(path.read_text(encoding='utf-8'))
            job['response_last_progress_at'] = datetime.fromtimestamp(time.time()-604, timezone.utc).isoformat()
            path.write_text(json.dumps(job, ensure_ascii=False), encoding='utf-8')
            bridge.update(root, {**body, 'event': 'response_refresh'})
            refreshed = json.loads(path.read_text(encoding='utf-8'))
            self.assertEqual(refreshed['response_refresh_count'], 1)
            with self.assertRaisesRegex(ValueError, '尚未达到十分钟'):
                bridge.update(root, {**body, 'event': 'response_timeout'})
            refreshed['response_last_progress_at'] = datetime.fromtimestamp(time.time()-604, timezone.utc).isoformat()
            path.write_text(json.dumps(refreshed, ensure_ascii=False), encoding='utf-8')
            bridge.update(root, {**body, 'event': 'response_timeout'})
            failed = json.loads(path.read_text(encoding='utf-8'))
            self.assertEqual(failed['batch_phase'], 'failed')
            self.assertEqual(failed['failure_reason'], 'response_timeout')
            self.assertEqual(failed['chat_url'], 'https://chatgpt.com/c/test')
            with self.assertRaisesRegex(ValueError, '任务已失败'):
                bridge.update(root, {**body, 'event': 'waiting', 'chat_url': failed['chat_url']})
            self.assertEqual(self.claim(root, 'edge')['task']['job_id'], next_id)

    def test_failed_retry_preserves_original_chat_and_resets_timer(self):
        with TemporaryDirectory() as root:
            ident, path = self.make_queued(root, number=1, browsers=['edge'])
            job = json.loads(path.read_text(encoding='utf-8'))
            job.update(batch_phase='failed', runner=None, chat_url='https://chatgpt.com/c/test',
                       assigned_browser='edge', failed_at=bridge.now(), failure_reason='response_timeout',
                       response_refresh_count=1, retry_count=3, eligible_browsers=['chrome','edge'], preferred_browser='chrome')
            path.write_text(json.dumps(job, ensure_ascii=False), encoding='utf-8')
            result = bridge.retry_failed(root)
            saved = json.loads(path.read_text(encoding='utf-8'))
            self.assertEqual(result['retried'], 1)
            self.assertEqual(saved['batch_phase'], 'queued')
            self.assertEqual(saved['chat_url'], job['chat_url'])
            self.assertEqual(saved['response_refresh_count'], 0)
            self.assertEqual(saved['retry_count'], 0)
            self.assertEqual(saved['eligible_browsers'], ['edge'])
            self.assertEqual(saved['preferred_browser'], 'edge')
            self.assertNotIn('failed_at', saved)

    def test_new_image_progress_resets_response_timer(self):
        with TemporaryDirectory() as root:
            ident, path = self.make_queued(root, number=1, browsers=['edge'])
            self.claim(root, 'edge')
            body = {'job_id': ident, 'browser': 'edge', 'worker_id': 'edge-worker', 'session': 'edge-session'}
            bridge.update(root, {**body, 'event': 'sent', 'chat_url': 'https://chatgpt.com/c/test'})
            job = json.loads(path.read_text(encoding='utf-8'))
            job.update(response_refresh_count=1, response_last_progress_at=datetime.fromtimestamp(time.time()-604, timezone.utc).isoformat())
            path.write_text(json.dumps(job, ensure_ascii=False), encoding='utf-8')
            bridge.update(root, {**body, 'event': 'image_progress', 'count': 1})
            progressed = json.loads(path.read_text(encoding='utf-8'))
            self.assertEqual(progressed['observed_image_count'], 1)
            self.assertEqual(progressed['response_refresh_count'], 0)
            with self.assertRaisesRegex(ValueError, '尚未达到十分钟'):
                bridge.update(root, {**body, 'event': 'response_refresh'})

    def test_uncertain_send_cannot_be_retried_automatically(self):
        with TemporaryDirectory() as root:
            ident, path = self.make_queued(root, number=1, browsers=['edge'])
            job = json.loads(path.read_text(encoding='utf-8'))
            job.update(batch_phase='failed', runner=None, logs=[{'event': 'sending', 'message': 'clicked'}])
            path.write_text(json.dumps(job, ensure_ascii=False), encoding='utf-8')
            result = bridge.retry_failed(root)
            self.assertEqual(result['retried'], 0)
            self.assertEqual(len(result['skipped']), 1)
            self.assertEqual(json.loads(path.read_text(encoding='utf-8'))['batch_phase'], 'failed')

    def test_legacy_sent_log_cannot_be_retried_automatically(self):
        with TemporaryDirectory() as root:
            ident, path = self.make_queued(root, number=1, browsers=['edge'])
            job = json.loads(path.read_text(encoding='utf-8'))
            job.update(batch_phase='failed', runner=None, logs=[{'event': 'sent', 'message': 'legacy sent'}])
            path.write_text(json.dumps(job, ensure_ascii=False), encoding='utf-8')
            result = bridge.retry_failed(root)
            self.assertEqual(result['retried'], 0)
            self.assertEqual(len(result['skipped']), 1)

    def test_legacy_sent_queued_job_is_isolated_before_claim(self):
        with TemporaryDirectory() as root:
            ident, path = self.make_queued(root, number=1, browsers=['edge'])
            job = json.loads(path.read_text(encoding='utf-8'))
            job['logs'] = [{'event': 'sent', 'message': 'legacy sent'}]
            path.write_text(json.dumps(job, ensure_ascii=False), encoding='utf-8')
            result = self.claim(root, 'edge')
            saved = json.loads(path.read_text(encoding='utf-8'))
            self.assertIsNone(result['task'])
            self.assertEqual(saved['batch_phase'], 'needs_review')
            self.assertIsNone(saved['runner'])
            self.assertEqual(saved['logs'][-1]['event'], 'uncertain_send_isolated')

    def test_exhausted_collection_errors_appear_in_failed_tasks(self):
        with TemporaryDirectory() as root:
            ident, path = self.make_queued(root, number=1, browsers=['edge'])
            self.claim(root, 'edge')
            body = {'job_id': ident, 'browser': 'edge', 'worker_id': 'edge-worker', 'session': 'edge-session'}
            bridge.update(root, {**body, 'event': 'sent', 'chat_url': 'https://chatgpt.com/c/test'})
            job = json.loads(path.read_text(encoding='utf-8'))
            job['retry_count'] = 3
            path.write_text(json.dumps(job, ensure_ascii=False), encoding='utf-8')
            bridge.update(root, {**body, 'event': 'error', 'message': '下载失败'})
            failed = json.loads(path.read_text(encoding='utf-8'))
            self.assertEqual(failed['batch_phase'], 'failed')
            self.assertEqual(failed['failure_reason'], 'collection_error')
            self.assertIsNone(failed['runner'])
            self.assertEqual(failed['chat_url'], 'https://chatgpt.com/c/test')

    def test_stale_sending_without_url_is_failed_and_releases_browser(self):
        with TemporaryDirectory() as root:
            ident, path = self.make_queued(root, number=1, browsers=['edge'])
            job = json.loads(path.read_text(encoding='utf-8'))
            job.update(batch_phase='sending', runner=None, owner_seen=time.time()-bridge.SEND_STALE_SECONDS-1,
                       assigned_browser='edge', claim_session='old-session',
                       logs=[{'event':'sending','message':'正在发送'}])
            path.write_text(json.dumps(job, ensure_ascii=False), encoding='utf-8')
            bridge._recover_stale_sending([job], root)
            saved = json.loads(path.read_text(encoding='utf-8'))
            self.assertEqual(saved['batch_phase'], 'failed')
            self.assertEqual(saved['failure_reason'], 'send_timeout')
            self.assertIsNone(saved['runner'])

    def test_send_error_waits_for_stable_chat_url_before_timeout(self):
        with TemporaryDirectory() as root:
            ident, path = self.make_queued(root, number=1, browsers=['edge'])
            self.claim(root, 'edge')
            body = {'job_id': ident, 'browser': 'edge', 'worker_id': 'edge-worker', 'session': 'edge-session'}
            bridge.update(root, {**body, 'event': 'sending'})
            bridge.update(root, {**body, 'event': 'error', 'message': '发送后未取得有效 GPT 对话地址'})
            saved = json.loads(path.read_text(encoding='utf-8'))
            self.assertEqual(saved['batch_phase'], 'sending')
            self.assertEqual(saved['status'], '等待确认')
            self.assertTrue(saved.get('send_error_at'))
            self.assertIn('send_pending', [entry['event'] for entry in saved['logs']])

    def test_reset_all_archives_tasks_and_keeps_result_files(self):
        with TemporaryDirectory() as root:
            ident, path = self.make_queued(root, number=1, browsers=['edge'])
            result_folder = Path(root) / 'results'
            result_folder.mkdir()
            output = result_folder / 'generated.png'
            output.write_bytes(b'generated')
            job = json.loads(path.read_text(encoding='utf-8'))
            job['result_folder'] = str(result_folder)
            path.write_text(json.dumps(job, ensure_ascii=False), encoding='utf-8')
            reset = image_jobs.reset_all(root)
            self.assertEqual(reset['cleared'], 1)
            self.assertFalse(path.exists())
            self.assertTrue(output.exists())
            self.assertEqual(len(list(Path(reset['archive']).glob('*/job.json'))), 1)

    def test_reset_all_rejects_uncertain_send(self):
        with TemporaryDirectory() as root:
            ident, path = self.make_queued(root, number=1, browsers=['edge'])
            job = json.loads(path.read_text(encoding='utf-8'))
            job['batch_phase'] = 'sending'
            path.write_text(json.dumps(job, ensure_ascii=False), encoding='utf-8')
            with self.assertRaisesRegex(ValueError, '发送结果'):
                image_jobs.reset_all(root)
            self.assertTrue(path.exists())

    def test_server_timeout_releases_task_without_any_page_poll(self):
        with TemporaryDirectory() as root:
            ident, path = self.make_queued(root, number=1, browsers=['edge'])
            next_id, _ = self.make_queued(root, number=2, browsers=['edge'])
            self.claim(root, 'edge')
            job = json.loads(path.read_text(encoding='utf-8'))
            job.update(batch_phase='waiting', chat_url='https://chatgpt.com/c/test',
                       response_refresh_count=1, response_last_progress_at=datetime.fromtimestamp(time.time()-601, timezone.utc).isoformat(),
                       owner_seen=time.time())
            path.write_text(json.dumps(job), encoding='utf-8')
            bridge.maintenance(root)
            failed = json.loads(path.read_text(encoding='utf-8'))
            self.assertEqual(failed['failure_reason'], 'response_timeout')
            self.assertEqual(failed['claim_session'], '')
            self.assertEqual(self.claim(root, 'edge')['task']['job_id'], next_id)

    def test_server_requests_refresh_and_only_acknowledgement_starts_second_timer(self):
        with TemporaryDirectory() as root:
            ident, path = self.make_queued(root, number=1, browsers=['edge'])
            self.claim(root, 'edge')
            job = json.loads(path.read_text(encoding='utf-8'))
            old = datetime.fromtimestamp(time.time()-601, timezone.utc).isoformat()
            job.update(batch_phase='waiting', chat_url='https://chatgpt.com/c/test', response_last_progress_at=old)
            path.write_text(json.dumps(job), encoding='utf-8')
            state = bridge.watchdog(root, {'browser':'edge', 'worker_id':'edge-worker'})
            self.assertEqual(state['recovery_action']['job_id'], ident)
            self.assertEqual(json.loads(path.read_text(encoding='utf-8'))['response_last_progress_at'], old)
            body = {'job_id':ident, 'browser':'edge', 'worker_id':'edge-worker', 'event':'response_refresh'}
            bridge.update(root, body)
            refreshed = json.loads(path.read_text(encoding='utf-8'))
            self.assertEqual(refreshed['response_refresh_count'], 1)
            self.assertNotIn('response_refresh_requested_at', refreshed)
            self.assertTrue(bridge.update(root, body)['duplicate'])
            self.assertEqual(json.loads(path.read_text(encoding='utf-8'))['response_last_progress_at'], refreshed['response_last_progress_at'])

    def test_unresponsive_browser_refresh_does_not_block_queue_forever(self):
        with TemporaryDirectory() as root:
            ident, path = self.make_queued(root, number=1, browsers=['edge'])
            self.claim(root, 'edge')
            job = json.loads(path.read_text(encoding='utf-8'))
            job.update(batch_phase='waiting', chat_url='https://chatgpt.com/c/test',
                       response_last_progress_at=datetime.fromtimestamp(time.time()-900, timezone.utc).isoformat(),
                       response_refresh_requested_at=datetime.fromtimestamp(time.time()-121, timezone.utc).isoformat())
            path.write_text(json.dumps(job), encoding='utf-8')
            bridge.maintenance(root)
            self.assertEqual(json.loads(path.read_text(encoding='utf-8'))['failure_reason'], 'browser_unresponsive')

    def test_normal_thinking_and_new_image_do_not_fail_early(self):
        with TemporaryDirectory() as root:
            ident, path = self.make_queued(root, number=1, browsers=['edge'])
            self.claim(root, 'edge')
            body = {'job_id':ident, 'browser':'edge', 'worker_id':'edge-worker'}
            bridge.update(root, {**body, 'event':'sent', 'chat_url':'https://chatgpt.com/c/test'})
            job = json.loads(path.read_text(encoding='utf-8'))
            job['response_last_progress_at'] = datetime.fromtimestamp(time.time()-590, timezone.utc).isoformat()
            path.write_text(json.dumps(job), encoding='utf-8')
            bridge.maintenance(root)
            self.assertNotIn('response_refresh_requested_at', json.loads(path.read_text(encoding='utf-8')))
            job['response_last_progress_at'] = datetime.fromtimestamp(time.time()-601, timezone.utc).isoformat()
            path.write_text(json.dumps(job), encoding='utf-8')
            bridge.maintenance(root)
            bridge.update(root, {**body, 'event':'image_progress', 'count':1})
            bridge.maintenance(root)
            progressed = json.loads(path.read_text(encoding='utf-8'))
            self.assertEqual(progressed['batch_phase'], 'sent')
            self.assertNotIn('response_refresh_requested_at', progressed)

    def test_send_error_iso_timestamp_times_out_from_server(self):
        with TemporaryDirectory() as root:
            ident, path = self.make_queued(root, number=1, browsers=['edge'])
            self.claim(root, 'edge')
            job = json.loads(path.read_text(encoding='utf-8'))
            job.update(batch_phase='sending', owner_seen=time.time(),
                       send_error_at=datetime.fromtimestamp(time.time()-601, timezone.utc).isoformat())
            path.write_text(json.dumps(job), encoding='utf-8')
            bridge.maintenance(root)
            self.assertEqual(json.loads(path.read_text(encoding='utf-8'))['failure_reason'], 'send_timeout')

if __name__ == '__main__':
    unittest.main()
