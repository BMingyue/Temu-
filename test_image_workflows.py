import base64
import hashlib
from io import BytesIO
import json
from pathlib import Path
import random
from tempfile import TemporaryDirectory
from unittest.mock import patch
import time
import unittest

from PIL import Image
import gpt_extension_bridge as bridge
import image_jobs
import image_workflows as flow


def png(seed):
    out = BytesIO()
    Image.frombytes('RGB', (256, 256), random.Random(seed).randbytes(256 * 256 * 3)).save(out, 'PNG')
    return out.getvalue()


class WorkflowTests(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.data = self.root / 'data'
        self.reference = self.root / 'print.png'
        self.reference.write_bytes(png(0))
        self.owner = dict(browser='chrome', worker_id='workflow-worker', session='workflow-tab', version='0.4.0')
        self.chat = 'https://chatgpt.com/c/workflow-test-chat'
        self.job = image_jobs.prepare(dict(title='workflow', workflow_id=flow.DEFAULT_PRESET,
                                         reference=str(self.reference), output_folder=str(self.root / 'out')), self.data)
        self.job['eligible_browsers'] = ['chrome']
        bridge._write(self.data, self.job)
        bridge.enqueue(self.data, self.job['id'])

    def tearDown(self):
        self.temp.cleanup()

    def claim(self):
        return bridge.claim(self.data, self.owner)['task']

    def event(self, task, event, **details):
        return bridge.update(self.data, dict(self.owner, job_id=self.job['id'], event=event,
                                            step=task['step_number'], step_token=task['step_token'], **details))

    def send(self, task):
        self.event(task, 'workflow_sending', chat_url=self.chat if task['step_number'] > 1 else 'https://chatgpt.com/')
        self.event(task, 'workflow_sent', chat_url=self.chat, user_message_id='user-' + str(task['step_number']))

    def download(self, task, seed):
        return self.event(task, 'downloaded_bytes', base64=base64.b64encode(png(seed)).decode())

    def skip_delay(self):
        job = bridge._read(self.data, self.job['id'])
        job['next_step_at'] = time.time() - 1
        bridge._write(self.data, job)

    def attachment_diagnostic(self):
        return dict(version=1, state='captured', scope='form',
            composer=dict(connected=True, visible=True),
            control=dict.fromkeys(('present', 'connected', 'visible', 'native_disabled',
                'inherited_disabled', 'aria_disabled', 'expanded', 'open', 'marked'), False),
            ancestors=dict(overlay=False, dialog=False, history=False),
            counts=dict.fromkeys(('elements', 'file_inputs', 'disabled_inputs', 'multiple_inputs',
                'markers', 'visible_markers', 'images', 'visible_images', 'image_small',
                'image_eligible_size', 'image_large', 'image_unloaded', 'images_in_overlay',
                'images_in_dialog', 'images_in_history', 'overlays', 'progress',
                'remove_buttons', 'file_dialog_buttons', 'cards', 'raw_images', 'raw_markers'), 0))

    def test_attachment_report_is_bound_to_unsent_step_and_strips_page_data(self):
        task = self.claim()
        diagnostic = self.attachment_diagnostic()
        diagnostic['html'] = '<private>'
        diagnostic['counts']['src'] = 'https://example.invalid/private?token=secret'
        diagnostic['control']['label'] = 'private filename.png'
        result = self.event(task, 'workflow_needs_review', code='workflow_attachment_not_ready',
                            message='upload failed', attachment_diagnostic=diagnostic)
        self.assertTrue(result['task_isolated'])
        saved = bridge._read(self.data, self.job['id'])
        step = flow.current(saved)
        self.assertEqual(step['last_attachment_diagnostic'], self.attachment_diagnostic())
        self.assertEqual(step['step_token'], task['step_token'])
        self.assertEqual(step['attachment_diagnostic_step_token'], task['step_token'])
        self.assertEqual(step['phase'], 'ready')
        self.assertFalse(any(step.get(key) for key in ('send_started_at', 'sent_at', 'user_message_id')))
        trace = next(row for row in saved['logs'] if row['event'] == 'attachment_diagnostic')
        self.assertEqual(trace['details']['step'], task['step_number'])
        self.assertEqual(trace['details']['step_token'], task['step_token'])
        self.assertEqual(trace['details']['worker_id'], self.owner['worker_id'])
        self.assertNotIn('private', json.dumps(step['last_attachment_diagnostic']))

    def test_invalid_attachment_reports_still_isolate_without_persisting(self):
        good = self.attachment_diagnostic()
        bad = [None, {}, dict(good, version=True), dict(good, state='raw-html'),
               dict(good, html='x' * 3073), dict(good, counts=dict(good['counts'], cards=True)),
               dict(good, counts=dict(good['counts'], cards=5001)),
               dict(good, control=dict(good['control'], expanded='true'))]
        for diagnostic in bad:
            with self.subTest(diagnostic=type(diagnostic).__name__):
                self.assertIsNone(flow._attachment_diagnostic(diagnostic))
        task = self.claim()
        self.event(task, 'workflow_needs_review', code='workflow_attachment_not_ready',
                   message='original failure', attachment_diagnostic=bad[-1])
        saved = bridge._read(self.data, self.job['id'])
        self.assertEqual(saved['batch_phase'], 'needs_review')
        self.assertNotIn('last_attachment_diagnostic', flow.current(saved))
        self.assertIn('original failure', saved['error'])

    def test_attachment_report_cannot_update_other_worker_or_step(self):
        task = self.claim()
        path = self.data / 'image-jobs' / self.job['id'] / 'job.json'
        before = path.read_bytes()
        common = dict(self.owner, job_id=self.job['id'], event='workflow_needs_review',
                      step=task['step_number'], step_token=task['step_token'],
                      code='workflow_attachment_not_ready', attachment_diagnostic=self.attachment_diagnostic())
        for changed in (dict(worker_id='other'), dict(session='old-tab'), dict(step_token='old-step')):
            with self.subTest(changed=changed), self.assertRaises(ValueError):
                bridge.update(self.data, {**common, **changed})
            self.assertEqual(path.read_bytes(), before)

    def test_attachment_report_does_not_change_unknown_send_protection(self):
        task = self.claim()
        self.event(task, 'workflow_sending', chat_url='https://chatgpt.com/')
        before = bridge._read(self.data, self.job['id'])
        self.event(task, 'workflow_needs_review', code='workflow_attachment_not_ready',
                   message='send not confirmed', attachment_diagnostic=self.attachment_diagnostic())
        saved = bridge._read(self.data, self.job['id'])
        self.assertEqual(saved['batch_phase'], 'needs_review')
        self.assertEqual(flow.current(saved)['phase'], 'sending')
        self.assertEqual(flow.current(saved)['send_started_at'], flow.current(before)['send_started_at'])
        self.assertNotIn('last_attachment_diagnostic', flow.current(saved))

    def test_four_steps_two_images_same_chat_master_reference(self):
        self.assert_step_workflow()

    def test_blanket_four_steps_use_master_and_save_in_scene_order(self):
        self.data = self.root / 'blanket-data'
        self.job = image_jobs.prepare(dict(title='blanket', workflow_id=flow.BLANKET_PRESET,
            reference=str(self.reference), output_folder=str(self.root / 'blanket-out')), self.data)
        self.job['eligible_browsers'] = ['chrome']
        bridge._write(self.data, self.job)
        bridge.enqueue(self.data, self.job['id'])
        self.assertEqual(self.job['expected_count'], 4)
        self.assertEqual([s['label'] for s in self.job['steps']], ['主图', '办公室午休', '沙发平铺', '帐篷使用'])
        self.assert_step_workflow()
        saved = bridge._read(self.data, self.job['id'])
        self.assertEqual([Path(s['output']).name for s in saved['steps']],
                         ['01-main.png', '02-office.png', '03-sofa.png', '04-tent.png'])

    def assert_step_workflow(self, count=4):
        master_hash = None
        for number in range(1, count + 1):
            task = self.claim()
            self.assertEqual(task['step_number'], number)
            self.assertEqual(len(task['attachments']), 2)
            template_hash = hashlib.sha256(Path(self.job['steps'][number - 1]['template']).read_bytes()).hexdigest()
            self.assertEqual(hashlib.sha256(base64.b64decode(task['attachments'][0]['base64'])).hexdigest(), template_hash)
            self.assertEqual(task['total_steps'], count)
            self.assertTrue(all(a['type'].startswith('image/') for a in task['attachments']))
            self.assertNotIn('template_archive', task)
            self.assertEqual(task['chat_url'], self.chat if number > 1 else '')
            if master_hash:
                self.assertEqual(hashlib.sha256(base64.b64decode(task['attachments'][1]['base64'])).hexdigest(), master_hash)
            self.send(task)
            self.download(task, number)
            if number == 1:
                master_hash = bridge._read(self.data, self.job['id'])['steps'][0]['sha256']
            if number < count:
                delayed = self.claim()
                self.assertGreater(delayed['wait_seconds'], 0)
                self.assertEqual(delayed['attachments'], [])
                self.skip_delay()
        job = bridge._read(self.data, self.job['id'])
        self.assertEqual(job['batch_phase'], 'saved')
        self.assertTrue(all(bridge._saved(s) for s in job['steps']))
        self.assertEqual(len(list(Path(job['result_folder']).glob('*.png'))), count)
        self.assertEqual(job['assigned_browser'], 'chrome')

    def test_sweater_five_steps_use_verified_master_and_save_in_reference_order(self):
        self.data = self.root / 'sweater-data'
        self.job = image_jobs.prepare(dict(title='sweater', workflow_id=flow.SWEATER_PRESET,
            reference=str(self.reference), output_folder=str(self.root / 'sweater-out')), self.data)
        self.job['eligible_browsers'] = ['chrome']
        bridge._write(self.data, self.job)
        bridge.enqueue(self.data, self.job['id'])
        self.assertEqual(self.job['expected_count'], 5)
        self.assertEqual([s['key'] for s in self.job['steps']], ['main', 'back', 'hanger', 'cafe', 'flatlay'])
        self.assert_step_workflow(count=5)
        saved = bridge._read(self.data, self.job['id'])
        self.assertEqual([Path(s['output']).name for s in saved['steps']],
                         ['01-main.png', '02-back.png', '03-hanger.png', '04-cafe.png', '05-flatlay.png'])

    def test_sweater_catalog_replaces_old_preset_and_old_identifier_resolves_to_new(self):
        catalog = flow.catalog(self.data)
        sweaters = [p for p in catalog['presets'] if p['category'] == '毛衣']
        self.assertEqual([p['id'] for p in sweaters], ['sweater-print-set-v3'])
        selected = sweaters[0]
        for old_id in ('sweater-print-main-v1', 'sweater-print-set-v2'):
            self.assertNotIn(old_id, [p['id'] for p in catalog['presets']])
            self.assertEqual(flow.preset(old_id), selected)
        self.assertEqual(selected['step_count'], 5)
        self.assertEqual([s['key'] for s in selected['steps']], ['main', 'back', 'hanger', 'cafe', 'flatlay'])
        for step in selected['steps']:
            self.assertTrue(Path(step['template']).is_file())
            self.assertTrue(step['prompt'].strip())

    def test_old_sweater_settings_reset_retired_prompts_and_preserve_delay_and_version(self):
        self.data.mkdir(parents=True, exist_ok=True)
        selected = flow.preset(flow.SWEATER_PRESET)
        built_in = {s['key']: s['prompt'] for s in selected['steps']}
        for old_id in ('sweater-print-main-v1', 'sweater-print-set-v2'):
            with self.subTest(old_id=old_id):
                old = dict(preset_id=old_id, delay_seconds=60,
                           prompts={'main': '旧版圆领主图的自定义提示词', 'flatlay': '强制继承圆领'},
                           version=7, saved_at='2026-10-26T00:00:00+00:00')
                path = self.data / 'image-workflow-settings.json'
                path.write_text(json.dumps(old, ensure_ascii=False), encoding='utf-8')
                before = path.read_bytes()
                migrated = flow.settings(self.data)
                self.assertEqual(migrated['preset_id'], flow.SWEATER_PRESET)
                self.assertEqual(migrated['delay_seconds'], 60)
                self.assertEqual(migrated['version'], 7)
                self.assertEqual(flow.normalized_prompts(migrated['prompts'], selected), built_in)
                self.assertEqual(path.read_bytes(), before)
        custom = dict(built_in, cafe=built_in['cafe'] + '\n自定义咖啡场景要求')
        saved = flow.save_settings(dict(preset_id=flow.SWEATER_PRESET, prompts=custom,
                                       delay_seconds=60, version=7), self.data)
        self.assertEqual(saved['version'], 8)
        self.assertEqual(flow.settings(self.data)['prompts'], custom)

    def test_stale_sweater_clients_cannot_write_old_prompts_as_the_new_preset(self):
        old_prompts = {'main': '旧版仅生成一张主图的自定义提示词'}
        jobs_before = sorted(p.parent.name for p in (self.data / 'image-jobs').glob('*/job.json'))
        for old_id in ('sweater-print-main-v1', 'sweater-print-set-v2'):
            writes = (
                lambda: flow.save_settings(dict(preset_id=old_id, prompts=old_prompts), self.data),
                lambda: image_jobs.prepare(dict(title='stale-sweater', workflow_id=old_id,
                    workflow_prompts=old_prompts, reference=str(self.reference),
                    output_folder=str(self.root / 'stale-out')), self.data),
                lambda: image_jobs.prepare_batch(dict(workflow_id=old_id,
                    workflow_prompts=old_prompts, folders=str(self.root), browsers=['chrome'],
                    output_folder=str(self.root / 'stale-batch-out')), self.data),
            )
            for write in writes:
                with self.subTest(old_id=old_id, write=write):
                    with self.assertRaisesRegex(ValueError, '刷新页面'):
                        write()
        self.assertFalse((self.data / 'image-workflow-settings.json').exists())
        self.assertEqual(sorted(p.parent.name for p in (self.data / 'image-jobs').glob('*/job.json')),
                         jobs_before)
        self.assertFalse((self.root / 'stale-out').exists())
        self.assertFalse((self.root / 'stale-batch-out').exists())

    def test_existing_one_image_sweater_job_keeps_its_snapshot_and_completes_once(self):
        self.job = bridge._read(self.data, self.job['id'])
        self.job.update(workflow_id='sweater-print-main-v1', workflow_label='毛衣主图印花迁移',
                        expected_count=1, steps=self.job['steps'][:1])
        self.job['steps'][0]['prompt'] = '旧毛衣任务的提示词快照'
        bridge._write(self.data, self.job)
        before = (Path(self.job['folder']) / 'job.json').read_bytes()
        flow.catalog(self.data)
        self.assertEqual((Path(self.job['folder']) / 'job.json').read_bytes(), before)
        task = self.claim()
        self.assertEqual(task['total_steps'], 1)
        self.assertIn('旧毛衣任务的提示词快照', task['prompt'])
        self.send(task)
        self.download(task, 1)
        saved = bridge._read(self.data, self.job['id'])
        self.assertEqual(saved['batch_phase'], 'saved')
        self.assertEqual(saved['workflow_id'], 'sweater-print-main-v1')
        self.assertEqual(len(saved['steps']), 1)
        self.assertEqual(len(list(Path(saved['result_folder']).glob('*.png'))), 1)

    def test_existing_four_image_sweater_job_keeps_its_snapshot_and_completes_four(self):
        self.job = bridge._read(self.data, self.job['id'])
        self.job.update(workflow_id='sweater-print-set-v2', workflow_label='旧毛衣四图', expected_count=4)
        for number, (step, key) in enumerate(zip(self.job['steps'], ('main', 'back', 'cafe', 'flatlay')), 1):
            step.update(key=key, prompt=f'旧版第 {number} 张圆领毛衣提示词快照')
        bridge._write(self.data, self.job)
        path = Path(self.job['folder']) / 'job.json'
        before = path.read_bytes()
        flow.catalog(self.data)
        self.assertEqual(path.read_bytes(), before)
        self.assert_step_workflow()
        saved = bridge._read(self.data, self.job['id'])
        self.assertEqual(saved['workflow_id'], 'sweater-print-set-v2')
        self.assertEqual([s['key'] for s in saved['steps']], ['main', 'back', 'cafe', 'flatlay'])
        self.assertEqual(saved['steps'][3]['prompt'], '旧版第 4 张圆领毛衣提示词快照')

    def test_send_boundary_is_durable_and_cannot_be_sent_again(self):
        task = self.claim()
        self.event(task, 'workflow_sending', chat_url='https://chatgpt.com/')
        self.assertEqual(self.claim()['attachments'], [])
        with self.assertRaisesRegex(ValueError, '重复发送'):
            self.event(task, 'workflow_sending', chat_url='https://chatgpt.com/')
        resumed = self.claim()
        self.assertEqual(resumed['step_phase'], 'sending')
        self.assertEqual(resumed['step_token'], task['step_token'])

    def test_other_browser_and_wrong_chat_are_rejected(self):
        task = self.claim()
        self.send(task)
        self.assertIsNone(bridge.claim(self.data, dict(self.owner, browser='firefox'))['task'])
        with self.assertRaisesRegex(ValueError, '另一浏览器'):
            bridge.update(self.data, dict(self.owner, browser='firefox', job_id=self.job['id'], event='progress'))
        self.download(task, 1)
        self.skip_delay()
        task = self.claim()
        with self.assertRaisesRegex(ValueError, '原聊天'):
            self.event(task, 'workflow_sending', chat_url='https://chatgpt.com/c/wrong')
        with self.assertRaisesRegex(ValueError, '改派'):
            bridge.enqueue(self.data, self.job['id'], browsers=['firefox'])

    def test_delay_gate_and_duplicate_download_preserve_next_step(self):
        task = self.claim()
        self.send(task)
        self.download(task, 1)
        next_task = self.claim()
        with self.assertRaisesRegex(ValueError, '开始时间'):
            self.event(next_task, 'workflow_sending', chat_url=self.chat)
        result = self.download(task, 1)
        self.assertTrue(result['duplicate'])
        self.assertEqual(bridge._read(self.data, self.job['id'])['current_step'], 2)

    def test_input_and_previous_output_are_not_new_results(self):
        task = self.claim()
        self.send(task)
        with self.assertRaisesRegex(ValueError, '拒绝保存'):
            self.download(task, 0)
        self.download(task, 1)
        self.skip_delay()
        task = self.claim()
        self.send(task)
        with self.assertRaisesRegex(ValueError, '拒绝保存'):
            self.download(task, 1)
        self.assertEqual(bridge._read(self.data, self.job['id'])['steps'][1]['phase'], 'sent')

    def test_review_and_resume_keep_saved_master_and_current_stage(self):
        first = self.claim()
        self.send(first)
        self.download(first, 1)
        self.skip_delay()
        second = self.claim()
        self.send(second)
        self.event(second, 'workflow_needs_review', message='测试中断')
        bridge.enqueue(self.data, self.job['id'])
        resumed = self.claim()
        self.assertEqual(resumed['step_number'], 2)
        self.assertEqual(resumed['step_phase'], 'sent')
        self.assertEqual(resumed['chat_url'], self.chat)
        self.assertTrue(bridge._saved(bridge._read(self.data, self.job['id'])['steps'][0]))

    def test_old_extension_cannot_claim_new_workflow(self):
        self.assertIsNone(bridge.claim(self.data, dict(self.owner, version='0.3.40'))['task'])

    def test_reconnect_is_bounded_and_never_reopens_send_boundary(self):
        task=self.claim()
        with self.assertRaisesRegex(ValueError,'已确认发送'):
            self.event(task,'workflow_reconnect',chat_url=self.chat)
        self.send(task)
        self.event(task,'workflow_reconnect',chat_url=self.chat)
        resumed=self.claim()
        self.assertEqual(resumed['step_phase'],'sent')
        self.assertEqual(resumed['reconnect_count'],1)
        self.assertEqual(resumed['attachments'],[])
        with self.assertRaisesRegex(ValueError,'重连过一次'):
            self.event(task,'workflow_reconnect',chat_url=self.chat)

    def test_collect_only_recovers_one_image_without_queuing_another_prompt(self):
        with self.assertRaisesRegex(ValueError,'已确认发送'):
            bridge.enqueue(self.data,self.job['id'],collect_only=True)
        task=self.claim();self.send(task)
        self.event(task,'workflow_needs_review',message='延迟加载')
        bridge.enqueue(self.data,self.job['id'],collect_only=True)
        task=self.claim();self.assertTrue(task['collect_only'])
        self.download(task,1)
        job=bridge._read(self.data,self.job['id'])
        self.assertEqual(job['batch_phase'],'paused')
        self.assertEqual(job['current_step'],2)
        self.assertEqual(job['steps'][1]['phase'],'ready')
        self.assertIsNone(bridge.claim(self.data,self.owner)['task'])

    def test_stale_step_error_cannot_pause_next_step(self):
        task=self.claim();self.send(task);self.download(task,1)
        with self.assertRaisesRegex(ValueError,'旧步骤'):
            self.event(task,'workflow_needs_review',message='旧页面的延迟错误')
        self.assertEqual(bridge._read(self.data,self.job['id'])['batch_phase'],'waiting')

    def test_transient_windows_file_lock_is_retried_without_truncation(self):
        original=bridge.os.replace
        attempts=[]
        def replace(source,target):
            attempts.append(str(target))
            if len(attempts)<3:raise PermissionError(5,'temporary Windows sharing violation')
            return original(source,target)
        job=bridge._read(self.data,self.job['id']);job['test_update']='intact'
        with patch.object(bridge.os,'replace',side_effect=replace),patch.object(bridge.time,'sleep') as sleep:
            bridge._write(self.data,job)
        self.assertEqual(len(attempts),3)
        self.assertEqual(sleep.call_count,2)
        self.assertEqual(bridge._read(self.data,self.job['id'])['test_update'],'intact')

    def test_unsent_owned_workflow_retry_keeps_browser_and_worker(self):
        task=self.claim()
        self.event(task, 'workflow_needs_review', message='发送前暂停')
        with self.assertRaisesRegex(ValueError, '改派'):
            bridge.enqueue(self.data, self.job['id'], browsers=['firefox'])
        bridge.enqueue(self.data, self.job['id'], browsers=['chrome','firefox'])
        saved=bridge._read(self.data,self.job['id'])
        self.assertEqual(saved['eligible_browsers'],['chrome'])
        self.assertEqual(saved['assigned_worker'],self.owner['worker_id'])

    def test_workflow_maintenance_never_uses_legacy_reload_or_presend_takeover(self):
        task=self.claim()
        job=bridge._read(self.data,self.job['id'])
        job['owner_seen']=time.time()-3600
        bridge._recover_stale_presend([job],self.data)
        self.assertEqual(job['batch_phase'],'needs_review')
        self.assertEqual(job['assigned_worker'],self.owner['worker_id'])
        bridge.enqueue(self.data,self.job['id'])
        task=self.claim();self.send(task)
        job=bridge._read(self.data,self.job['id'])
        epoch=time.time()
        with patch.object(time,'time',return_value=epoch+11*60):
            bridge._recover_stale_responses([job],self.data)
        self.assertNotIn('response_refresh_requested_at',job)
        self.assertEqual(job['batch_phase'],'waiting')
        with patch.object(time,'time',return_value=epoch+21*60):
            bridge._recover_stale_responses([job],self.data)
        self.assertEqual(job['batch_phase'],'needs_review')
        self.assertEqual(job['steps'][0]['phase'],'sent')

    def test_only_exact_owned_unsent_workflow_draft_can_be_reclaimed(self):
        task=self.claim()
        self.event(task, 'workflow_needs_review', message='发送前编辑器等待渲染')
        bridge.enqueue(self.data, self.job['id'])
        signature=hashlib.sha256(''.join(task['prompt'].split()).encode()).hexdigest()
        body=dict(self.owner, draft_present=True, draft_workflow_marker=task['prompt_marker'], draft_signature=signature)
        self.assertTrue(bridge.claim(self.data, dict(body, draft_signature='wrong'))['draft_blocked'])
        self.assertEqual(bridge.claim(self.data, body)['task']['step_phase'], 'ready')

    def test_recovery_claim_rearms_observation_without_changing_sent_evidence(self):
        task=self.claim();self.send(task)
        self.event(task,'workflow_needs_review',message='原聊天等待核对')
        job=bridge._read(self.data,self.job['id'])
        old_sent=job['steps'][0]['sent_at'];old_token=job['steps'][0]['step_token']
        job['response_last_progress_at']='2026-10-01T00:00:00+08:00'
        bridge._write(self.data,job)
        bridge.enqueue(self.data,job['id'],browsers=['chrome'],collect_only=True)
        resumed=self.claim()
        self.assertGreater(bridge._timestamp(resumed['response_last_progress_at']),time.time()-10)
        saved=bridge._read(self.data,job['id'])
        self.assertEqual(saved['steps'][0]['sent_at'],old_sent)
        self.assertEqual(saved['steps'][0]['step_token'],old_token)
        self.assertEqual(resumed['attachments'],[])
        self.assertEqual(resumed['chat_url'],self.chat)

    def test_repeated_workflow_page_failures_hold_only_the_failing_browser(self):
        failed=[]
        for index in range(3):
            if index:
                self.job=image_jobs.prepare(dict(title=f'blocked-{index}',workflow_id=flow.DEFAULT_PRESET,
                    reference=str(self.reference),output_folder=str(self.root/'out')),self.data)
                self.job['eligible_browsers']=['chrome'];bridge._write(self.data,self.job)
                bridge.enqueue(self.data,self.job['id'])
            task=self.claim();self.send(task)
            self.event(task,'workflow_needs_review',code='workflow_page_not_ready',message='消息未挂载')
            failed.append(bridge._read(self.data,self.job['id']))
        self.assertTrue(bridge._generation_circuit(failed,'chrome')['open'])
        self.assertFalse(bridge._generation_circuit(failed,'firefox')['open'])
        self.assertTrue(bridge.claim(self.data,self.owner)['circuit_open'])

    def retry_once(self, task, **changes):
        values=dict(chat_url=self.chat,failed_prompt_marker=task['prompt_marker'],
            failure_text='抱歉，这次图片未能成功生成，当前我无法继续重试这一张。请你再发送一次同样的生成请求，或重新上传这两张参考图后让我继续处理。',
            generated_images=0,generating=False)
        values.update(changes)
        return self.event(task,'workflow_retry_once',**values)

    def test_explicit_failure_retry_rotates_attempt_once_preserves_chat_and_inputs(self):
        task=self.claim();self.send(task)
        original_hashes=[hashlib.sha256(base64.b64decode(a['base64'])).hexdigest() for a in task['attachments']]
        self.retry_once(task)
        job=bridge._read(self.data,self.job['id']);step=job['steps'][0]
        self.assertEqual(step['generation_retry_count'],1)
        self.assertNotEqual(step['step_token'],task['step_token'])
        self.assertEqual(step['failed_attempts'][0]['step_token'],task['step_token'])
        self.assertEqual(job['assigned_worker'],self.owner['worker_id'])
        self.assertEqual(job['chat_url'],self.chat)
        self.assertEqual(job['current_step'],1)
        self.assertEqual(step['prompt'],self.job['steps'][0]['prompt'])
        self.assertGreater(self.claim()['wait_seconds'],0)
        self.skip_delay();retry=self.claim()
        self.assertEqual([hashlib.sha256(base64.b64decode(a['base64'])).hexdigest() for a in retry['attachments']],original_hashes)
        with self.assertRaisesRegex(ValueError,'旧步骤'):
            self.event(task,'workflow_needs_review',message='Delayed error from old attempt')
        self.send(retry)
        self.event(retry,'workflow_needs_review',message='Second explicit failure',code='generation_failed')
        bridge.enqueue(self.data,self.job['id'],browsers=['chrome'])
        retry=self.claim()
        with self.assertRaisesRegex(ValueError,'重发过一次'):
            self.retry_once(retry)
        self.assertEqual(bridge._read(self.data,self.job['id'])['steps'][0]['generation_retry_count'],1)

    def test_retry_rejects_quota_running_images_wrong_marker_or_chat(self):
        task=self.claim();self.send(task)
        for changes in [dict(failure_text='图片未能生成，请重新发送。今日额度已用完。'),
                        dict(generating=True),dict(generated_images=1),
                        dict(failed_prompt_marker='wrong'),dict(chat_url='https://chatgpt.com/c/other')]:
            with self.assertRaises(ValueError):self.retry_once(task,**changes)
        self.assertEqual(bridge._read(self.data,self.job['id'])['steps'][0].get('generation_retry_count',0),0)

    def test_collect_only_cannot_consume_generation_retry_budget(self):
        task=self.claim();self.send(task)
        job=bridge._read(self.data,self.job['id']);job['recovery_collect_only']=True;bridge._write(self.data,job)
        with self.assertRaisesRegex(ValueError,'仅续收'):self.retry_once(task)

    def test_retry_cannot_overwrite_existing_orphan_image(self):
        task=self.claim();self.send(task)
        output=Path(self.job['result_folder'])/'01-main.png';output.write_bytes(png(7))
        with self.assertRaisesRegex(ValueError,'保存文件'):self.retry_once(task)
        self.assertEqual(output.read_bytes(),png(7))

    def test_retry_material_changes_are_rejected_before_upload(self):
        task=self.claim();self.send(task);self.retry_once(task);self.skip_delay()
        job=bridge._read(self.data,self.job['id']);Path(job['steps'][0]['template']).write_bytes(png(8))
        with self.assertRaisesRegex(ValueError,'已变化'):self.claim()

    def test_retry_text_classifier_is_narrow(self):
        self.assertTrue(flow.retryable_generation_failure('这次图片未能成功生成，请你再发送一次同样的生成请求。'))
        self.assertTrue(flow.retryable_generation_failure('图片生成失败，请重新发送。'))
        self.assertTrue(flow.retryable_generation_failure('Image generation failed. Please send the same request again.'))
        for text in ['图片未能成功生成', '请重新上传附件', '图片未能生成，请重发。涉及安全政策。',
                     '图片未能生成，请重发。需要验证码。', '图片未能生成，请重发。当前已达上限。']:
            self.assertFalse(flow.retryable_generation_failure(text),text)

    def test_saved_settings_preserve_prompts_and_validate_delay(self):
        selected = flow.preset()
        prompts = {step['key']: step['prompt'] for step in selected['steps']}
        prompts['main'] += '\n自定义保留要求'
        value = flow.save_settings(dict(prompts=prompts, delay_seconds=60), self.data)
        self.assertEqual(flow.settings(self.data)['prompts']['main'], prompts['main'])
        self.assertEqual(flow.settings(self.data)['delay_seconds'], 60)
        with self.assertRaises(ValueError):
            flow.save_settings(dict(prompts=prompts, delay_seconds=1), self.data)
        with self.assertRaises(ValueError):
            flow.save_settings(dict(prompts=prompts, delay_seconds=30, version=value['version']-1), self.data)

    def test_blanket_settings_round_trip_and_task_prompt_snapshot(self):
        selected = next(p for p in flow.catalog(self.data)['presets'] if p['id'] == flow.BLANKET_PRESET)
        prompts = {s['key']: s['prompt'] for s in selected['steps']}
        prompts['office'] += '\n自定义办公室要求'
        saved = flow.save_settings(dict(preset_id=flow.BLANKET_PRESET, prompts=prompts, delay_seconds=60), self.data)
        self.assertEqual(flow.catalog(self.data)['settings']['preset_id'], flow.BLANKET_PRESET)
        self.assertEqual(flow.settings(self.data)['prompts'], prompts)
        job = image_jobs.prepare(dict(title='custom-blanket', workflow_id=flow.BLANKET_PRESET,
            workflow_prompts=saved['prompts'], reference=str(self.reference),
            output_folder=str(self.root / 'custom-out')), self.data)
        flow.save_settings(dict(preset_id=flow.BLANKET_PRESET, delay_seconds=30), self.data)
        self.assertEqual(bridge._read(self.data, job['id'])['steps'][1]['prompt'], prompts['office'])
        self.assertEqual(set(prompts), {'main', 'office', 'sofa', 'tent'})

    def test_same_print_can_use_blanket_preset_without_old_preset_deduplication(self):
        body = dict(workflow_id=flow.DEFAULT_PRESET, folders=str(self.root), browsers=['chrome'],
                    output_folder=str(self.root / 'batch-out'), fixed_images=[])
        original = image_jobs.prepare_batch(body, self.data)
        blanket = image_jobs.prepare_batch(dict(body, workflow_id=flow.BLANKET_PRESET), self.data)
        repeated = image_jobs.prepare_batch(dict(body, workflow_id=flow.BLANKET_PRESET), self.data)
        self.assertEqual(len(original['jobs']), 1)
        self.assertEqual(len(blanket['jobs']), 1)
        self.assertEqual(repeated['skipped'][0]['id'], blanket['jobs'][0]['id'])
        self.assertFalse(blanket['skipped'])
        self.assertFalse(blanket['errors'])
        job = bridge._read(self.data, blanket['jobs'][0]['id'])
        self.assertEqual(job['workflow_id'], flow.BLANKET_PRESET)
        self.assertEqual(job['expected_count'], 4)

    def test_new_sweater_batch_is_not_deduplicated_against_retired_snapshots(self):
        selected = flow.preset(flow.SWEATER_PRESET)
        for retired_id, old_count in (('sweater-print-main-v1', 1), ('sweater-print-set-v2', 4)):
            with self.subTest(retired_id=retired_id):
                self.data = self.root / retired_id
                old_steps = [s for s in selected['steps'] if s['key'] != 'hanger'][:old_count]
                old_steps = [{**s, 'number': i} for i, s in enumerate(old_steps, 1)]
                old = dict(selected, id=retired_id, step_count=old_count, steps=old_steps)
                body = dict(workflow_id=retired_id, folders=str(self.root), browsers=['chrome'],
                            output_folder=str(self.root / 'sweater-batch-out'), fixed_images=[])
                # Simulate jobs created before their preset identifier retired.
                with patch.object(flow, 'writable_preset', return_value=old):
                    previous = image_jobs.prepare_batch(body, self.data)
                old_id = previous['jobs'][0]['id']
                new_body = dict(body, workflow_id=flow.SWEATER_PRESET)
                updated = image_jobs.prepare_batch(new_body, self.data)
                repeated = image_jobs.prepare_batch(new_body, self.data)
                self.assertEqual(len(updated['jobs']), 1)
                self.assertFalse(updated['skipped'])
                self.assertFalse(updated['errors'])
                new_id = updated['jobs'][0]['id']
                self.assertEqual(repeated['skipped'][0]['id'], new_id)
                self.assertEqual(bridge._read(self.data, old_id)['expected_count'], old_count)
                self.assertEqual(bridge._read(self.data, old_id)['workflow_id'], retired_id)
                self.assertEqual(bridge._read(self.data, new_id)['expected_count'], 5)
                self.assertEqual(bridge._read(self.data, new_id)['workflow_id'], flow.SWEATER_PRESET)

    def test_prepare_batch_has_no_zip_requirement_and_deduplicates(self):
        body = dict(workflow_id=flow.DEFAULT_PRESET, folders=str(self.root), browsers=['chrome'],
                    output_folder=str(self.root / 'batch-out'), fixed_images=[])
        first = image_jobs.prepare_batch(body, self.data)
        second = image_jobs.prepare_batch(body, self.data)
        self.assertEqual(len(first['jobs']), 1)
        self.assertEqual(len(second['skipped']), 1)
        self.assertFalse(second['errors'])


if __name__ == '__main__':
    unittest.main()
