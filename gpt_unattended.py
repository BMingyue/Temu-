"""Durable account quotas, safe step handoff and bounded task isolation.

Only an unsent step (or an exact, image-free quota rejection) may change
accounts. Unknown send results remain parked, without holding a browser lease.
All entry points are called under gpt_extension_bridge.LOCK.
"""
from pathlib import Path
import json
import math
import re
import time
import uuid

READY_TIMEOUT = 8 * 60
SEND_TIMEOUT = 3 * 60
RESPONSE_TIMEOUT = 20 * 60
DOWNLOAD_TIMEOUT = 4 * 60


def quota_text(value):
    text = ' '.join(str(value or '').split())[:2000]
    # Require an explicit exhausted image allowance, never a generic failure,
    # a policy refusal, or an instruction asking the model to discuss limits.
    patterns = (
        r'(?:已达到|已达|达到|用完|耗尽).{0,65}(?:图像|图片|生图).{0,30}(?:上限|限额|额度)',
        r'(?:图像|图片|生图).{0,35}(?:额度|限额|次数).{0,15}(?:已用完|已耗尽|不足|用尽)',
        r'(?:reached|hit|exceeded).{0,65}(?:image|picture).{0,35}(?:limit|cap|quota)',
        r'(?:image|picture).{0,35}(?:limit|quota).{0,25}(?:reached|exceeded|exhausted)',
        r'(?:out of|used up).{0,25}(?:image generations|image credits)',
    )
    return text if any(re.search(p, text, re.I) for p in patterns) else ''


def _load(data):
    path = Path(data) / 'gpt-account-availability.json'
    value = json.loads(path.read_text(encoding='utf-8')) if path.exists() else {}
    if not isinstance(value, dict):
        raise ValueError('账号停发状态文件损坏，停止领取，请人工核对')
    return value


def account(data, browser, worker=None):
    import gpt_extension_bridge as b
    state = _load(data)
    # Old explicit browser-wide holds remain conservative until they expire.
    # New runtime quota events only hold the exact originating profile.
    legacy = state.get(browser, {})
    scoped = state.get(b._worker_key(browser, worker), {})
    holds = [legacy, scoped] if worker is not None else [legacy, *(row for key, row in state.items() if key.startswith(str(browser) + ':'))]
    row = max(holds, key=lambda item: float(item.get('until', 0)))
    remaining = max(0, math.ceil(float(row.get('until', 0)) - time.time()))
    return {**row, 'blocked': remaining > 0, 'wait_seconds': remaining}


def block_account(data, browser, evidence, worker=None):
    import gpt_extension_bridge as b
    text = quota_text(evidence)
    if browser not in b.BROWSERS or not text:
        raise ValueError('没有明确的图片额度耗尽证据，不能按额度自动转接')
    state = _load(data)
    previous = account(data, browser, worker)
    if worker is None:
        row = state.get(browser, {})
        remaining = max(0, math.ceil(float(row.get('until', 0)) - time.time()))
        previous = {**row, 'blocked': remaining > 0, 'wait_seconds': remaining}
    if previous['blocked']:
        return previous  # Repeated page reads must not keep extending the hold.
    match = re.search(r'(\d+(?:\.\d+)?)\s*(小时|分钟|hours?|minutes?|hrs?|mins?)', text, re.I)
    seconds = float(match[1]) * (3600 if re.match(r'小时|hour|hr', match[2], re.I) else 60) if match else 24 * 3600
    seconds = min(48 * 3600, max(60, seconds)) + 60
    row = dict(reason='image_quota', text=text, since=b.now(), until=time.time() + seconds,
               message='图片额度耗尽，停止新发送；尚未发送步骤由其他参与账号接力')
    row.update(browser=browser, worker_id=worker or '')
    state[b._worker_key(browser, worker)] = row
    path = Path(data) / 'gpt-account-availability.json'
    temp = path.with_suffix('.' + uuid.uuid4().hex + '.tmp')
    temp.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding='utf-8')
    b._replace_with_retry(temp, path)
    return account(data, browser, worker)


def pool(job):
    import gpt_extension_bridge as b
    selected = job.get('handoff_browsers')
    if not selected:
        selected = next(((e.get('details') or {}).get('eligible_browsers') for e in job.get('logs', [])
                         if e.get('event') == 'queued' and (e.get('details') or {}).get('eligible_browsers')), None)
    selected = selected or job.get('eligible_browsers') or list(b.BROWSERS)
    return [v for v in b.BROWSERS if v in selected]


def isolate(data, job, message, reason='task_stalled'):
    import gpt_extension_bridge as b
    job.update(batch_phase='needs_review', runner=None, claim_session='', error=message,
               status='本任务已跳过，后续队列继续', paused_at=b.now(), failed_at=b.now(),
               failure_reason=reason, isolated_at=b.now())
    job.pop('response_refresh_requested_at', None)
    b._trace(job, 'task_isolated', message, step=job.get('current_step'))
    b._write(data, job)


def relay(data, job, reason='image_quota'):
    import gpt_extension_bridge as b
    import image_workflows as f
    step = f.current(job)
    if step['phase'] != 'ready':
        raise ValueError('发送结果尚未明确，禁止跨账号重发')
    if step['number'] > 1 and not b._saved(job['steps'][0]):
        raise ValueError('原主图没有通过文件校验，禁止转接场景图')
    browsers = pool(job)
    origin = job.get('assigned_browser')
    job.setdefault('chat_history', []).append(dict(
        chat_url=b._stable_job_chat_url(job), browser=origin, worker=job.get('assigned_worker'),
        step=step['number'], reason=reason, at=b.now()))
    try:
        segment = int(job.get('execution_segment', 0))
    except (TypeError, ValueError):
        segment = 0  # Initial repair jobs previously used a UUID marker here.
    job.update(execution_segment=segment + 1,
               relay_start_step=step['number'], chat_url='', runner='chrome_extension',
               batch_phase='queued', claim_session='', queued_at=b.now(), error='',
               status='额度停发，等待健康账号从未完成步骤接力',
               handoff_browsers=browsers, eligible_browsers=browsers, next_step_at=0,
               quota_handoff_from=origin)
    for key in ('assigned_browser', 'assigned_worker', 'preferred_browser', 'sent_at', 'send_started_at',
                'response_last_progress_at', 'response_observation_started_at', 'recovery_collect_only',
                'failed_at', 'failure_reason', 'paused_at', 'download_started_at'):
        job.pop(key, None)
    if origin in browsers:
        job['preferred_browser'] = origin  # Other healthy accounts bypass a quota-held preference immediately.
    step.pop('ready_started_at', None)
    b._trace(job, 'quota_handoff', '原账号额度耗尽，保留已保存图片，仅未发送步骤等待健康账号接力',
             previous_browser=origin, step=step['number'])
    b._write(data, job)


def quota_event(data, job, body):
    import gpt_extension_bridge as b
    import image_workflows as f
    step = f.current(job)
    text = quota_text(body.get('quota_text'))
    if not text or body.get('generating') is not False or body.get('generated_images') != 0:
        raise ValueError('没有明确的无生成额度拒绝证据，保留本步骤，不得重发')
    if step['phase'] not in ('ready', 'sent'):
        raise ValueError('发送结果未确认，不能按额度拒绝转接')
    if step['phase'] == 'sent' and body.get('failed_prompt_marker') != f.step_prompt(job, step)[0]:
        raise ValueError('额度回复不属于当前步骤')
    if b._saved(step) or any(Path(job['result_folder']).glob(f'{step["number"]:02d}-{step["key"]}.*')):
        raise ValueError('本步骤已有保存文件，禁止按额度拒绝重发')
    browser = job.get('assigned_browser')
    blocked = block_account(data, browser, text, job.get('assigned_worker'))
    if step['phase'] == 'sent':
        step.setdefault('quota_rejections', []).append(dict(
            step_token=step['step_token'], sent_at=step.get('sent_at'),
            user_message_id=step.get('user_message_id'), chat_url=b._stable_job_chat_url(job),
            browser=browser, text=text, confirmed_at=b.now()))
        step.update(phase='ready', status='明确额度拒绝，尚未生成', step_token=uuid.uuid4().hex)
        for key in ('sent_at', 'send_started_at', 'user_message_id', 'reconnect_count',
                    'last_diagnostic', 'diagnostic_at'):
            step.pop(key, None)
    relay(data, job)
    return {'ok': True, 'account_blocked': True, 'wait_seconds': blocked['wait_seconds'], 'relayed': True}


def maintenance(data, jobs):
    import gpt_extension_bridge as b
    import image_workflows as f
    current = time.time()
    for job in jobs:
        if not f.is_workflow(job) or job.get('runner') != 'chrome_extension':
            continue
        phase = job.get('batch_phase')
        step = f.current(job)
        browser = job.get('assigned_browser')
        if browser and account(data, browser, job.get('assigned_worker'))['blocked'] and step['phase'] == 'ready' and phase in ('queued', *b.ACTIVE_PHASES):
            relay(data, job)
            continue
        if phase not in b.ACTIVE_PHASES:
            continue
        if step['phase'] == 'ready':
            started = b._timestamp(step.get('ready_started_at') or job.get('claimed_at'))
            deadline = READY_TIMEOUT + int(job.get('step_delay_seconds', 30))
        elif step['phase'] == 'sending':
            started, deadline = b._timestamp(step.get('send_started_at')), SEND_TIMEOUT
        elif step['phase'] == 'sent':
            started = max(b._timestamp(step.get('sent_at')), b._timestamp(job.get('response_observation_started_at')))
            deadline = RESPONSE_TIMEOUT
            if job.get('download_started_at'):
                started, deadline = b._timestamp(job['download_started_at']), DOWNLOAD_TIMEOUT
        else:
            continue
        if started and current - started >= deadline:
            page_lost = step['phase'] == 'ready' and current - float(job.get('owner_seen', current)) > b.PRESEND_STALE_SECONDS
            isolate(data, job, f'第 {step["number"]} 张持续卡住超过 {deadline // 60} 分钟，已隔离本任务并释放浏览器；原聊天与图片保留，不自动重发',
                    'presend_page_lost' if page_lost else 'task_stalled')


def recover_selected(data, ids, browsers):
    """Explicit operator recovery of ready steps; unknown sends stay parked."""
    import gpt_extension_bridge as b
    import image_workflows as f
    queued, protected = [], []
    for ident in b.normalize_job_ids(ids):
        job = b._read(data, ident)
        if not f.is_workflow(job) or job.get('batch_phase') not in ('needs_review', 'paused') or f.current(job)['phase'] != 'ready':
            protected.append(ident)
            continue
        job['handoff_browsers'] = b.normalize_browsers(browsers) or pool(job)
        step = f.current(job)
        if step['number'] > 1 and not b._saved(job['steps'][0]):
            protected.append(ident)
            continue
        if job.get('assigned_browser') and account(data, job['assigned_browser'], job.get('assigned_worker'))['blocked']:
            relay(data, job)
        else:
            # Keep the original account/chat when it is still healthy.
            initial_repair = bool(
                job.get('repair_source_id') and job.get('execution_segment')
                and step['number'] == job.get('relay_start_step')
                and not b._stable_job_chat_url(job) and not b._crossed_send_boundary(job)
                and not any(job.get(key) or step.get(key) for key in ('sent_at', 'send_started_at', 'user_message_id'))
                and not any(e.get('event') in ('sending', 'sent', 'send_pending', 'attachment_repair_sending')
                            for e in job.get('logs', [])))
            if (step['number'] == 1 and not b._crossed_send_boundary(job)) or initial_repair:
                job['eligible_browsers'] = job['handoff_browsers']
                for key in ('assigned_browser', 'assigned_worker', 'preferred_browser'):
                    job.pop(key, None)
            elif job.get('assigned_browser'):
                job['eligible_browsers'] = [job['assigned_browser']]
                job['preferred_browser'] = job['assigned_browser']
            job.update(batch_phase='queued', runner='chrome_extension', claim_session='', queued_at=b.now(),
                       error='', status='未发送步骤重新排队；异常任务不再阻塞后续队列')
            for key in ('failed_at', 'failure_reason', 'paused_at', 'isolated_at'):
                job.pop(key, None)
            step.pop('ready_started_at', None)
            b._trace(job, 'safe_ready_recovery', '仅恢复尚未发送的步骤，已保存图片和原聊天保留')
            b._write(data, job)
        queued.append(ident)
    return dict(ok=True, queued=queued, protected=protected)
