"""User-requested revisions use immutable input snapshots and new conversations."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import re
import shutil
import uuid


def _step_key(step):
    return str(step.get('key') or step['number'])


def retry(body, data):
    import image_jobs
    import image_workflows as flow
    import gpt_extension_bridge as bridge

    request = body.get('request_id')
    if not isinstance(request, str) or not re.fullmatch(r'[a-zA-Z0-9_-]{8,100}', request):
        raise ValueError('重试请求编号无效，请刷新页面后重试')
    ident = bridge.normalize_job_ids([body.get('id')])[0]
    if 'confirm_resend' in body and not isinstance(body['confirm_resend'], bool):
        raise ValueError('人工核对确认无效')
    confirmed = body.get('confirm_resend') is True
    with image_jobs.BATCH_LOCK, bridge.LOCK:
        source = image_jobs.get_job(data, ident)
        steps = source.get('steps') or []
        if (not steps or len(steps) > 100
                or [s.get('number') for s in steps] != list(range(1, len(steps) + 1))):
            raise ValueError('原任务步骤记录无效')
        all_keys = [_step_key(s) for s in steps]
        if len(set(all_keys)) != len(steps) or any(not re.fullmatch(r'[a-zA-Z0-9_-]{1,80}', key) for key in all_keys):
            raise ValueError('原任务步骤编号重复，请先核对任务记录')
        requested = body.get('step_keys')
        full = requested is None
        if not full and (not isinstance(requested, list) or not requested
                         or any(not isinstance(k, str) or k not in all_keys for k in requested)):
            raise ValueError('请选择原任务中的有效步骤')
        keys = all_keys if full else [k for k in all_keys if k in requested]
        workflow = flow.is_workflow(source)
        if not workflow and not full:
            raise ValueError('旧版 ZIP 任务请使用整套重新发送；逐步骤重试适用于逐张生图任务')
        mode = 'full' if full else 'steps'
        signature = hashlib.sha256(json.dumps([ident, keys]).encode()).hexdigest()
        existing = image_jobs._read_jobs(data)
        for job in existing:
            if job.get('retry_request_id') == request:
                if job.get('retry_signature') != signature:
                    raise ValueError('同一重试请求不能改变任务或步骤，请重新点击重试')
                return _existing_response(job, data)
        # Different tabs may issue different request IDs for the same click.
        for job in existing:
            if (job.get('retry_signature') == signature
                    and job.get('batch_phase') not in ('saved', 'failed', 'needs_review')):
                return _existing_response(job, data)
        if source.get('runner') or source.get('batch_phase') in (*bridge.ACTIVE_PHASES, 'queued'):
            raise ValueError('原任务正在执行或排队，请等待结束后再重试')
        unknown_keys = []
        if workflow:
            for step in steps:
                if _step_key(step) in keys:
                    if ((step.get('phase') in ('sending', 'sent') or step.get('send_started_at') or step.get('sent_at'))
                            and step.get('phase') != 'saved' and not bridge._saved(step)):
                        unknown_keys.append(_step_key(step))
        elif source.get('batch_phase') != 'saved' and bridge._crossed_send_boundary(source):
            unknown_keys = keys
        if unknown_keys and not confirmed:
            raise ValueError('所选步骤已经发送但结果尚未确认。请先核对原聊天；如仍需重做，须明确确认可能重复消耗额度后再重新发送')

        source_root = _optional_root(body, 'source_results_root')
        output_root = _optional_root(body, 'output_folder')
        if source_root is not None and not source_root.is_dir():
            raise ValueError('原成图所在目录不存在')
        output_root = output_root or source_root or Path(source['result_folder']).resolve().parent
        browsers = bridge.normalize_browsers(body.get('browsers', source.get('eligible_browsers', list(bridge.BROWSERS))))
        # Validate all required source files before creating any revision directory.
        references = source.get('reference_images') or [source['reference']]
        for path in references:
            flow._image(path)
        for step in steps:
            flow._image(step['template'])
            if _step_key(step) not in keys:
                path = flow._repair_output_path(source, step, source_root)
                if not bridge._saved({**step, 'output': str(path)}):
                    raise ValueError('未勾选的' + step.get('label', _step_key(step)) + '成图缺失或校验失败，请一并选择重试，或指定搬迁后的原成图目录')
                flow._image(path)
        if not workflow and not Path(source.get('template_archive', '')).is_file():
            raise ValueError('原任务模板压缩包不存在')
        for item in source.get('fixed_images', []):
            flow._image(item['source'])
            if hashlib.sha256(Path(item['source']).read_bytes()).hexdigest() != item['sha256']:
                raise ValueError('原任务固定图校验失败')

        new_id = uuid.uuid4().hex
        folder = Path(data) / 'image-jobs' / new_id
        inputs = folder / 'inputs'
        title = str(source.get('title', ident[:8])) + ('-重新生成' if full else '-步骤重试')
        safe = re.sub(r'[<>:"/\\|?*\x00-\x1f]', '_', title).strip(' .')[:60] or 'retry'
        result = output_root / ('GPT-' + safe + '-' + new_id[:8])
        folder_created = result_created = False
        try:
            folder.mkdir(parents=True)
            folder_created = True
            inputs.mkdir()
            result.mkdir(parents=True)
            result_created = True

            def copy_input(value, name):
                old = Path(value)
                dest = inputs / (name + old.suffix.lower())
                shutil.copyfile(old, dest)
                if hashlib.sha256(dest.read_bytes()).digest() != hashlib.sha256(old.read_bytes()).digest():
                    raise ValueError('原任务素材在复制期间发生变化')
                return str(dest)

            refs = [copy_input(value, f'reference-{n:02d}') for n, value in enumerate(references, 1)]
            stamp = bridge.now()
            child = {k: source[k] for k in ('category', 'workflow_mode', 'workflow_input_mode', 'source_sha256',
                       'source_relative_path', 'source_product_folder', 'source_name', 'source_reference',
                       'source_folder_signature', 'source_edit_output_root', 'workflow_id', 'workflow_label',
                       'workflow_version', 'step_delay_seconds', 'prompt_template') if k in source}
            child.update(id=new_id, task_no=f'IMG-{stamp[:10].replace("-", "")}-{new_id[:8].upper()}',
                         title=title, reference=refs[0], reference_images=refs, created=stamp,
                         folder=str(folder), result_folder=str(result), expected_count=len(steps),
                         steps=[], fixed_images=[], logs=[], eligible_browsers=browsers,
                         retry_source_id=ident, retry_source_title=source.get('title', ''),
                         retry_step_keys=keys, retry_mode=mode, retry_request_id=request,
                         retry_signature=signature, retry_confirmed_unknown_steps=unknown_keys,
                         retry_confirmed_at=stamp if unknown_keys else None, runner=None)
            if not workflow:
                child['template_archive'] = copy_input(source['template_archive'], 'templates')
            for old in steps:
                number = old['number']
                step = {k: old[k] for k in ('number', 'key', 'label', 'template_name', 'prompt', 'output_basename') if k in old}
                step.update(template=copy_input(old['template'], f'template-{number:02d}'),
                            reference=refs[0], phase='ready', status='待执行', step_token=uuid.uuid4().hex)
                (folder / f'prompt-{number:02d}.txt').write_text(step.get('prompt', ''), encoding='utf-8')
                if _step_key(old) not in keys:
                    old_path = flow._repair_output_path(source, old, source_root)
                    raw = old_path.read_bytes()
                    if hashlib.sha256(raw).hexdigest() != old['sha256']:
                        raise ValueError('原成图在复制期间发生变化，已停止重试')
                    target = result / (f'{number:02d}-' + _step_key(old) + old_path.suffix.lower())
                    with target.open('xb') as out:
                        out.write(raw)
                    step.update(phase='saved', status='沿用原成图', output=str(target), sha256=old['sha256'],
                                saved_at=old.get('saved_at'), retained_from_job=ident,
                                retained_from_output=str(old_path))
                child['steps'].append(step)
            for n, old in enumerate(source.get('fixed_images', []), len(steps) + 1):
                copied = copy_input(old['source'], f'fixed-{n:02d}')
                if hashlib.sha256(Path(copied).read_bytes()).hexdigest() != old['sha256']:
                    raise ValueError('原任务固定图在复制期间发生变化')
                child['fixed_images'].append(dict(source=copied, number=n, name=old.get('name', ''), sha256=old['sha256']))
            if workflow:
                pending = [s for s in child['steps'] if s['phase'] != 'saved']
                child.update(current_step=pending[0]['number'], next_step_at=0,
                             execution_segment=1, relay_start_step=pending[0]['number'],
                             execution_end_step=pending[-1]['number'])
            bridge._trace(child, 'manual_retry_created', '用户主动重试；创建独立任务，保留原任务与原图',
                          source_job_id=ident, step_keys=keys, retry_mode=mode)
            if unknown_keys:
                bridge._trace(child, 'manual_retry_acknowledged', '用户已核对原聊天并明确确认可能重复消耗额度，仅重做所选步骤',
                              source_job_id=ident, original_phase=source.get('batch_phase'),
                              original_chat_url=source.get('chat_url', ''), step_keys=unknown_keys)
            bridge._write(data, child)
        except Exception:
            # Only these two newly generated revision paths can be removed.
            if folder_created and folder.resolve().parent == (Path(data) / 'image-jobs').resolve():
                shutil.rmtree(folder)
            if result_created and result.resolve().parent == output_root.resolve():
                shutil.rmtree(result)
            raise
        bridge.enqueue(data, new_id, browsers=browsers)
        return _response(image_jobs.get_job(data, new_id), True)


def _optional_root(body, key):
    value = body.get(key, '')
    if not isinstance(value, str):
        raise ValueError('成图目录设置无效')
    return Path(value.strip()).resolve() if value.strip() else None


def _response(job, created):
    import image_jobs
    return dict(ok=True, id=job['id'], created=created, job=image_jobs.compact_job(job),
                message=('已创建独立重试任务并加入队列，原任务与原图已保留' if created else '该重试任务已存在，未重复发送'))


def _existing_response(job, data):
    import image_jobs
    import gpt_extension_bridge as bridge
    # If the original request was interrupted between writing and enqueueing,
    # finish only that same unsent revision rather than creating another one.
    if not job.get('batch_phase') and not job.get('runner'):
        bridge.enqueue(data, job['id'], browsers=job.get('eligible_browsers'))
        job = image_jobs.get_job(data, job['id'])
    return _response(job, False)
