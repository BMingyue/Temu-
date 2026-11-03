"""Single-image turns in one owned ChatGPT conversation; legacy jobs stay intact."""
from __future__ import annotations
import base64
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import threading
import time
import uuid
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parent
ASSETS = ROOT / 'image_presets' / 'flannel-blanket-chat'
MODE = 'single_image_chat_v1'
DEFAULT_PRESET = 'flannel-blanket-chat-v1'
TEST_PRESET = 'flannel-blanket-turkey-test-v1'
LEGACY_SWEATER_PRESET = 'sweater-print-main-v1'
LEGACY_SWEATER_SET_PRESET = 'sweater-print-set-v2'
LEGACY_SWEATER_PRESETS = (LEGACY_SWEATER_PRESET, LEGACY_SWEATER_SET_PRESET)
SWEATER_PRESET = 'sweater-print-set-v3'
BLANKET_PRESET = 'flannel-blanket-scenes-v1'
VERSION = '1.0.0'
SETTINGS_LOCK = threading.RLock()
STEPS = (
    ('main', '主图', '01-main.png', '01-main.txt'),
    ('sofa', '沙发场景', '02-sofa.png', '02-sofa.txt'),
    ('reading', '阅读场景', '03-reading.png', '03-reading.txt'),
    ('outdoor', '户外场景', '04-outdoor.png', '04-outdoor.txt'),
)
BLANKET_STEPS = (
    ('main', '主图', '01-main.png', '01-main.txt'),
    ('office', '办公室午休', '02-office.png', '02-office.txt'),
    ('sofa', '沙发平铺', '03-sofa.png', '03-sofa.txt'),
    ('tent', '帐篷使用', '04-tent.png', '04-tent.txt'),
)
SWEATER_STEPS = (
    ('main', '正面多肤色展示', '01-main.png', '01-main.txt'),
    ('back', '背面多肤色展示', '02-back.png', '02-back.txt'),
    ('hanger', '衣架悬挂展示', '03-hanger.png', '03-hanger.txt'),
    ('cafe', '咖啡馆穿搭', '04-cafe.png', '04-cafe.txt'),
    ('flatlay', '半高领平铺产品图', '05-flatlay.png', '05-flatlay.txt'),
)


def is_workflow(job):
    return job.get('workflow_mode') == MODE


def preset(ident=DEFAULT_PRESET):
    # Old selectors resolve to the replacement; existing jobs keep their snapshots.
    if ident in LEGACY_SWEATER_PRESETS:
        ident = SWEATER_PRESET
    if ident not in (DEFAULT_PRESET, TEST_PRESET, SWEATER_PRESET, BLANKET_PRESET):
        raise ValueError('未知的逐张生图预设')
    sweater = ident == SWEATER_PRESET
    blanket = ident == BLANKET_PRESET
    assets = (ROOT / 'image_presets' / 'flannel-blanket-scenes' if blanket else
              ROOT / 'image_presets' / 'sweater-print-set' if sweater else ASSETS)
    definitions = BLANKET_STEPS if blanket else SWEATER_STEPS if sweater else STEPS
    steps = []
    for number, (key, label, image, text) in enumerate(definitions, 1):
        prompt_file = '01-turkey-test.txt' if ident == TEST_PRESET and number == 1 else text
        template = assets / image
        prompt = (assets / prompt_file).read_text(encoding='utf-8')
        if not template.is_file():
            raise ValueError('预设模板缺失：' + image)
        steps.append(dict(number=number, key=key, label=label, template=str(template),
                          template_name=image, prompt=prompt))
    return dict(id=ident, version=VERSION, mode=MODE,
                label=('法兰绒毛毯 · 主图＋三场景' if blanket else '毛衣 · 正面＋背面＋衣架＋穿搭＋平铺' if sweater else
                       '法兰绒披肩毯 · 主图＋三场景' if ident == DEFAULT_PRESET else '感恩节火鸡 · 本次样例测试'),
                category='毛衣' if sweater else '毛毯', step_count=len(steps), steps=steps)


def delay_seconds(value):
    if isinstance(value, bool) or value not in (30, 60):
        raise ValueError('图间等待请选择 30 秒或 60 秒')
    return int(value)


def settings(data):
    path = Path(data) / 'image-workflow-settings.json'
    with SETTINGS_LOCK:
        saved = json.loads(path.read_text(encoding='utf-8')) if path.exists() else {}
    if saved.get('preset_id') in LEGACY_SWEATER_PRESETS:
        # Retired prompts omit the hanger step and force a round neck on new templates.
        saved = {**saved, 'preset_id': SWEATER_PRESET, 'prompts': {}}
    return {'preset_id': DEFAULT_PRESET, 'delay_seconds': 30, 'prompts': {}, 'version': 0, **saved}


def catalog(data):
    return {'presets': [preset(DEFAULT_PRESET), preset(BLANKET_PRESET), preset(TEST_PRESET), preset(SWEATER_PRESET)], 'settings': settings(data)}


def normalized_prompts(value, selected):
    if value is None:
        value = {}
    if not isinstance(value, dict) or any(key not in {s['key'] for s in selected['steps']} for key in value):
        raise ValueError('逐张提示词设置无效')
    result = {}
    for step in selected['steps']:
        text = value.get(step['key'], step['prompt'])
        if not isinstance(text, str) or not text.strip() or len(text) > 12000:
            raise ValueError(step['label'] + '提示词不能为空且最多 12000 字')
        result[step['key']] = text
    return result


def writable_preset(ident):
    if ident in LEGACY_SWEATER_PRESETS:
        raise ValueError('毛衣预设已升级为五图套图，请刷新页面后重试')
    return preset(ident)


def save_settings(body, data):
    selected = writable_preset(body.get('preset_id', DEFAULT_PRESET))
    prompts = normalized_prompts(body.get('prompts'), selected)
    delay = delay_seconds(body.get('delay_seconds', 30))
    with SETTINGS_LOCK:
        old = settings(data)
        if body.get('version', old['version']) != old['version']:
            raise ValueError('预设已在其他页面更新，请刷新后再保存')
        value = dict(preset_id=selected['id'], prompts=prompts, delay_seconds=delay,
                     version=old['version'] + 1, saved_at=datetime.now(timezone.utc).isoformat())
        path = Path(data) / 'image-workflow-settings.json'
        path.parent.mkdir(parents=True, exist_ok=True)
        temp = path.with_suffix('.' + uuid.uuid4().hex + '.tmp')
        temp.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
        os.replace(temp, path)
    return value


def _image(path):
    from PIL import Image
    import image_jobs
    path = Path(str(path).strip().strip('"'))
    if not path.is_file() or path.suffix.lower() not in image_jobs.IMAGE_EXT:
        raise ValueError('图片不存在或格式不支持：' + str(path))
    if path.stat().st_size > 30_000_000:
        raise ValueError('单张图片不得超过 30MB')
    try:
        with Image.open(path) as image:
            image.verify()
    except (OSError, ValueError) as exc:
        raise ValueError('图片文件校验失败：' + path.name) from exc
    return path


def prepare(body, data):
    import image_jobs
    selected = writable_preset(body.get('workflow_id', DEFAULT_PRESET))
    prompts = normalized_prompts(body.get('workflow_prompts'), selected)
    delay = delay_seconds(body.get('step_delay_seconds', 30))
    title = str(body.get('title', '')).strip()
    if not title:
        raise ValueError('请填写任务名称')
    reference = _image(body.get('reference', ''))
    if body.get('extra_references'):
        raise ValueError('逐张预设每轮固定两张图，请移除旧模式的额外参考图')
    fixed_paths = body.get('fixed_images', [])
    if not isinstance(fixed_paths, list) or len(fixed_paths) > 20:
        raise ValueError('最多附加 20 张固定图')
    fixed_paths = [_image(value) for value in fixed_paths]
    ident = uuid.uuid4().hex
    folder = Path(data) / 'image-jobs' / ident
    inputs = folder / 'inputs'
    inputs.mkdir(parents=True)
    output = Path(body.get('output_folder') or image_jobs.config(data)['output_folder']).resolve()
    safe_title = re.sub(r'[<>:"/\\|?*\x00-\x1f]', '_', title).strip(' .')[:60] or 'workflow'
    result = output / ('GPT-' + safe_title + '-' + ident[:8])
    try:
        result.mkdir(parents=True)
        ref = inputs / ('reference' + reference.suffix.lower())
        shutil.copyfile(reference, ref)
        steps = []
        for step in selected['steps']:
            dest = inputs / step['template_name']
            shutil.copyfile(step['template'], dest)
            text = prompts[step['key']]
            (folder / f'prompt-{step["number"]:02d}.txt').write_text(text, encoding='utf-8')
            steps.append({**step, 'template': str(dest), 'prompt': text, 'phase': 'ready',
                          'status': '待执行', 'step_token': uuid.uuid4().hex})
        fixed = []
        for number, source in enumerate(fixed_paths, len(steps) + 1):
            dest = inputs / (f'fixed-{number:02d}' + source.suffix.lower())
            shutil.copyfile(source, dest)
            fixed.append(dict(source=str(dest), name=source.name, number=number,
                              sha256=hashlib.sha256(dest.read_bytes()).hexdigest()))
        stamp = datetime.now(timezone.utc).isoformat()
        job = dict(id=ident, task_no=f'IMG-{stamp[:10].replace("-", "")}-{ident[:8].upper()}',
                   title=title, category=selected['category'], workflow_mode=MODE, workflow_id=selected['id'],
                   workflow_label=selected['label'], workflow_version=VERSION,
                   step_delay_seconds=delay, current_step=1, next_step_at=0,
                   expected_count=len(steps), prompt_template='\n\n'.join(f'【{s["label"]}】\n{s["prompt"]}' for s in steps),
                   reference=str(ref), reference_images=[str(ref)], created=stamp,
                   folder=str(folder), result_folder=str(result), steps=steps, fixed_images=fixed,
                   status='逐张素材已准备', logs=[dict(at=stamp, event='prepared', message=f'{selected["label"]}，共 {len(steps)} 张，单图逐轮、同一聊天执行')])
        (folder / 'job.json').write_text(json.dumps(job, ensure_ascii=False, indent=2), encoding='utf-8')
        return job
    except Exception:
        if folder.resolve().parent == (Path(data) / 'image-jobs').resolve():
            shutil.rmtree(folder)
        if result.is_dir() and not any(result.iterdir()):
            result.rmdir()
        raise


def prepare_batch(body, data):
    import image_jobs
    import gpt_extension_bridge as bridge
    with image_jobs.BATCH_LOCK:
        selected = writable_preset(body['workflow_id'])
        browsers = bridge.normalize_browsers(body.get('browsers', list(bridge.BROWSERS)))
        prompts = normalized_prompts(body.get('workflow_prompts'), selected)
        delay_seconds(body.get('step_delay_seconds', 30))
        scanned = image_jobs.scan_batch(body, data)
        signature = ''.join(hashlib.sha256(Path(s['template']).read_bytes()).hexdigest() for s in selected['steps'])
        signature += json.dumps(prompts, ensure_ascii=False, sort_keys=True) + selected['id']
        for value in body.get('fixed_images', []):
            signature += hashlib.sha256(_image(value).read_bytes()).hexdigest()
        existing = {j.get('batch_key'): j for j in image_jobs.list_jobs(data) if j.get('batch_key')}
        batch_no = 'BATCH-' + datetime.now().strftime('%Y%m%d-%H%M%S') + '-' + uuid.uuid4().hex[:4].upper()
        jobs, skipped, errors = [], [], []
        for sequence, item in enumerate(scanned['files'], 1):
            try:
                reference = _image(item['path'])
                key = hashlib.sha256((hashlib.sha256(reference.read_bytes()).hexdigest() + signature).encode()).hexdigest()
                if key in existing:
                    skipped.append({'name': item['name'], 'id': existing[key]['id']})
                    continue
                job = prepare({**body, 'title': datetime.now().strftime('%Y%m%d-%H%M%S') + f'-{sequence:03d}',
                               'reference': str(reference), 'workflow_prompts': prompts}, data)
                job.update(batch_key=key, batch_no=batch_no, source_reference=str(reference),
                           queue_number=sequence, eligible_browsers=browsers)
                bridge._write(data, job)
                bridge.enqueue(data, job['id'])
                existing[key] = job
                jobs.append({k: job[k] for k in ('id', 'title', 'task_no')})
            except (ValueError, OSError) as exc:
                errors.append({'name': item['name'], 'error': str(exc)})
        saved = save_settings(dict(preset_id=selected['id'], prompts=prompts,
                                  delay_seconds=body.get('step_delay_seconds', 30)), data)
        return dict(batch_no=batch_no, jobs=jobs, skipped=skipped, reassigned=[], errors=errors,
                    workflow_settings=saved)


def _repair_selection(body, data):
    """Resolve a bounded, explicit selection without altering any source job."""
    import image_jobs
    import gpt_extension_bridge as bridge
    ids = bridge.normalize_job_ids(body['ids']) if body.get('ids') is not None else None
    query = body.get('title_query', '')
    batch = body.get('batch_no', '')
    if not isinstance(query, str) or not isinstance(batch, str):
        raise ValueError('任务名称和批次筛选无效')
    query, batch = query.strip(), batch.strip()
    if len(query) > 200 or len(batch) > 100:
        raise ValueError('任务名称或批次筛选过长')
    if not ids and not query and not batch:
        raise ValueError('请填写任务名称、批次，或明确选择任务')
    keys = body.get('step_keys', ['hanger', 'flatlay'])
    if not isinstance(keys, list) or not keys or any(k not in ('hanger', 'flatlay') for k in keys):
        raise ValueError('部分修改仅支持衣架图和平铺图，请至少选择一项')
    keys = [k for k in ('hanger', 'flatlay') if k in keys]
    browsers = bridge.normalize_browsers(body.get('browsers', list(bridge.BROWSERS)))
    jobs = image_jobs._read_jobs(data)
    selected = [j for j in jobs if (ids is not None or not j.get('repair_source_id'))
                and (ids is None or j['id'] in ids)
                and (not query or query.casefold() in str(j.get('title', '')).casefold())
                and (not batch or j.get('batch_no') == batch)]
    if len(selected) > 500:
        raise ValueError('单次最多操作 500 个任务，请缩小名称或批次范围')
    if ids is not None:
        found = {j['id'] for j in selected}
        selected.extend(dict(id=i, title='', selection_missing=True) for i in ids if i not in found)
    locations = {}
    for key in ('source_results_root', 'output_folder'):
        value = body.get(key, '')
        if not isinstance(value, str):
            raise ValueError('成图目录设置无效')
        locations[key] = Path(value.strip()).resolve() if value.strip() else None
    if locations['source_results_root'] is not None and not locations['source_results_root'].is_dir():
        raise ValueError('原成图所在目录不存在')
    return selected, keys, browsers, jobs, locations


def _repair_output_path(job, item, source_root=None):
    original = Path(item.get('output') or item.get('source') or '')
    if source_root is None:
        return original
    candidate = (source_root / Path(job['result_folder']).name / original.name).resolve()
    if not candidate.is_relative_to(source_root):
        raise ValueError('原成图路径超出指定目录')
    return candidate


def _repair_source_error(job, keys, selected, source_root=None):
    import gpt_extension_bridge as bridge
    if job.get('selection_missing'):
        return '任务不存在，或与名称、批次筛选不匹配'
    if not is_workflow(job) or not str(job.get('workflow_id', '')).startswith('sweater-print-'):
        return '仅支持毛衣逐张套图任务'
    if job.get('batch_phase') != 'saved' or job.get('runner'):
        return '仅能部分修改已经完成的任务；发送中或结果不明的任务保持原样'
    source_steps = {s.get('key'): s for s in job.get('steps', [])}
    if not source_steps or any(not bridge._saved({**s, 'output': str(_repair_output_path(job, s, source_root))})
                               for s in source_steps.values()):
        return '原套图存在缺失文件或哈希校验不通过，停止部分修改'
    try:
        _image(job.get('reference', ''))
        for step in source_steps.values():
            _image(_repair_output_path(job, step, source_root))
    except (ValueError, OSError) as exc:
        return str(exc)
    for step in selected['steps']:
        if step['key'] not in keys and step['key'] not in source_steps:
            return '原任务缺少' + step['label'] + '，请将该图片一并勾选补图'
    return ''


def repair_preview(body, data):
    import image_jobs
    import gpt_extension_bridge as bridge
    with image_jobs.BATCH_LOCK, bridge.LOCK:
        sources, keys, _, _, locations = _repair_selection(body, data)
        selected = preset(SWEATER_PRESET)
        matching = []
        for job in sources:
            try:
                reason = _repair_source_error(job, keys, selected, locations['source_results_root'])
            except (ValueError, OSError) as exc:
                reason = str(exc)
            matching.append(dict(id=job['id'], title=job.get('title', ''),
                                 task_no=job.get('task_no', ''), batch_no=job.get('batch_no', ''),
                                 eligible=not bool(reason), reason=reason,
                                 retained_count=len(selected['steps']) - len(keys), regenerate_count=len(keys)))
        eligible = sum(item['eligible'] for item in matching)
        return dict(ok=True, matching=matching, matched_count=len(matching), eligible_count=eligible,
                    blocked_count=len(matching) - eligible, step_keys=keys,
                    resolved_source_root=str(locations['source_results_root'] or ''),
                    message=f'匹配 {len(matching)} 个任务，可部分修改 {eligible} 个；每套保留 {len(selected["steps"]) - len(keys)} 张，生成 {len(keys)} 张')


def prepare_repairs(body, data):
    """Create new revision jobs. Originals and their conversations remain untouched."""
    import image_jobs
    import gpt_extension_bridge as bridge
    if body.get('start'):
        raise ValueError('部分修改先准备独立任务，请检查后从任务列表启动')
    with image_jobs.BATCH_LOCK, bridge.LOCK:
        sources, keys, browsers, existing_jobs, locations = _repair_selection(body, data)
        selected = preset(SWEATER_PRESET)
        template_signature = json.dumps([
            (s['key'], hashlib.sha256(Path(s['template']).read_bytes()).hexdigest(), s['prompt'])
            for s in selected['steps'] if s['key'] in keys
        ], ensure_ascii=False)
        existing = {j['repair_key']: j for j in existing_jobs if j.get('repair_key')}
        jobs, skipped, errors = [], [], []
        batch_no = 'REPAIR-' + datetime.now().strftime('%Y%m%d-%H%M%S') + '-' + uuid.uuid4().hex[:4].upper()
        for sequence, source in enumerate(sources, 1):
            child = None
            try:
                reason = _repair_source_error(source, keys, selected, locations['source_results_root'])
                if reason:
                    raise ValueError(reason)
                source_steps = {s['key']: s for s in source['steps']}
                signature = json.dumps(dict(source=source['id'], preset=selected['id'], keys=keys,
                    outputs={key: step['sha256'] for key, step in source_steps.items()},
                    templates=template_signature), ensure_ascii=False, sort_keys=True)
                repair_key = hashlib.sha256(signature.encode('utf-8')).hexdigest()
                if repair_key in existing:
                    previous = existing[repair_key]
                    skipped.append(dict(id=source['id'], title=source.get('title', ''),
                                        existing_repair_id=previous['id'], reason='相同部分修改任务已经准备，保留原任务继续执行'))
                    continue
                title = source.get('title', source['id'][:8]) + '-部分修改'
                child = prepare(dict(title=title, workflow_id=selected['id'],
                                     reference=source['reference'],
                                     output_folder=str(locations['output_folder'] or locations['source_results_root'] or Path(source['result_folder']).parent),
                                     step_delay_seconds=source.get('step_delay_seconds', 60)), data)
                originals = []
                for step in child['steps']:
                    if step['key'] in keys:
                        continue
                    old = source_steps[step['key']]
                    old_path = _repair_output_path(source, old, locations['source_results_root'])
                    target = Path(child['result_folder']) / (f'{step["number"]:02d}-{step["key"]}' + old_path.suffix.lower())
                    raw = old_path.read_bytes()
                    if hashlib.sha256(raw).hexdigest() != old['sha256']:
                        raise ValueError('原成图在准备期间发生变化，已停止复制')
                    with target.open('xb') as out:
                        out.write(raw)
                    if hashlib.sha256(target.read_bytes()).hexdigest() != old['sha256']:
                        raise ValueError('保留成图复制校验失败')
                    step.update(phase='saved', status='沿用原成图（未重新生成）', output=str(target),
                                sha256=old['sha256'], saved_at=old.get('saved_at') or bridge.now(),
                                retained_from_job=source['id'], retained_from_output=str(old_path))
                    originals.append(dict(key=step['key'], output=str(old_path), sha256=old['sha256']))
                pending = next(s for s in child['steps'] if s['phase'] != 'saved')
                fixed = []
                for number, item in enumerate(source.get('fixed_images', []), len(child['steps']) + 1):
                    # Moving the result folder does not move the immutable input copy.
                    source_path = Path(item.get('source', ''))
                    if not source_path.is_file():
                        source_path = _repair_output_path(source, item, locations['source_results_root'])
                    _image(source_path)
                    raw = source_path.read_bytes()
                    if hashlib.sha256(raw).hexdigest() != item['sha256']:
                        raise ValueError('原固定图校验失败')
                    target = Path(child['folder']) / 'inputs' / (f'fixed-{number:02d}' + source_path.suffix.lower())
                    with target.open('xb') as out:
                        out.write(raw)
                    fixed.append(dict(source=str(target), name=item.get('name', source_path.name),
                                      number=number, sha256=item['sha256']))
                child.update(repair_source_id=source['id'], repair_source_title=source.get('title', ''),
                             repair_source_batch_no=source.get('batch_no', ''), repair_step_keys=keys,
                             repair_source_results_root=str(locations['source_results_root'] or ''),
                             repair_originals=originals, repair_key=repair_key,
                             batch_no=batch_no, queue_number=sequence, eligible_browsers=browsers,
                             current_step=pending['number'], execution_segment=1,
                             execution_end_step=max(s['number'] for s in child['steps'] if s['phase'] != 'saved'),
                             relay_start_step=pending['number'], fixed_images=fixed,
                             status=f'部分修改已准备：保留 {len(originals)} 张，待生成 {len(keys)} 张',
                             runner=None)
                bridge._trace(child, 'repair_prepared', '独立新聊天部分修改；保留原任务、原成图及原聊天',
                              source_job_id=source['id'], retained_keys=[s['key'] for s in originals], regenerate_keys=keys)
                bridge._write(data, child)
                existing[repair_key] = child
                jobs.append({k: child[k] for k in ('id', 'title', 'task_no', 'repair_source_id', 'result_folder')})
            except (ValueError, OSError, KeyError) as exc:
                if child is not None:
                    # Only this brand-new, unqueued revision can be rolled back.
                    folder = Path(child['folder']).resolve()
                    if folder.parent == (Path(data) / 'image-jobs').resolve():
                        shutil.rmtree(folder)
                    result = Path(child['result_folder']).resolve()
                    output_root = (locations['output_folder'] or locations['source_results_root'] or Path(source['result_folder']).parent).resolve()
                    if result.parent == output_root:
                        shutil.rmtree(result)
                errors.append(dict(id=source['id'], title=source.get('title', ''), error=str(exc)))
        return dict(ok=True, jobs=jobs, skipped=skipped, errors=errors, prepared_count=len(jobs),
                    batch_no=batch_no, resolved_source_root=str(locations['source_results_root'] or ''),
                    message=f'已准备 {len(jobs)} 个独立部分修改任务，尚未启动；跳过 {len(skipped)} 个重复任务，{len(errors)} 个需处理')


def retry_job(body, data):
    import image_job_retry
    return image_job_retry.retry(body, data)


def current(job):
    return job['steps'][int(job.get('current_step', 1)) - 1]


def step_prompt(job, step):
    marker = 'WBSTEP-' + job['id'][:12] + '-' + step['step_token']
    return marker, '工作流消息标记：' + marker + '。此标记仅用于识别本条消息，不属于图片内容，请勿绘入图片。\n\n' + step['prompt']


def retryable_generation_failure(value):
    """Only the user-authorized technical failure + explicit resubmit request."""
    text = ' '.join(str(value or '').split())[:2000]
    if re.search(r'额度|上限|频率|冷却|限制|限流|验证|人机|登录|安全|政策|违规|侵权|版权|不允许|无法协助|不能协助|无法帮助|不能帮助|稍后再试|稍后重试|quota|limit|policy|safety|copyright|prohibited|violation|captcha|verification|sign.?in|log.?in|not allowed|cannot help|can\W?t help|try again in\s*\d', text, re.I):
        return False
    failed = re.search(r'(?:图片|图像).{0,25}(?:未能|未|没能|没有|无法).{0,12}(?:成功)?生成|(?:图片|图像).{0,15}(?:生成|创建).{0,10}(?:失败|未成功)|(?:image|picture).{0,30}(?:generation|creation).{0,12}(?:failed|unsuccessful)|(?:image|picture).{0,30}(?:failed|could not|couldn\W?t|not successfully).{0,20}(?:generat|creat)|(?:failed|unable).{0,15}(?:generat|creat).{0,20}(?:image|picture)', text, re.I)
    resend = re.search(r'再发送|重新发送|重新上传|重发|(?:send|submit|upload).{0,45}(?:again|once more)|resubmit|re-upload', text, re.I)
    return bool(failed and resend)


def _input_paths(job, step):
    import gpt_extension_bridge as bridge
    if job.get('workflow_input_mode') == 'single_source_edit':
        if len(job.get('steps', [])) != 1 or step['number'] != 1:
            raise ValueError('一对一修复必须只有一个原图步骤')
        if job.get('source_sha256') and hashlib.sha256(Path(job['reference']).read_bytes()).hexdigest() != job['source_sha256']:
            raise ValueError('一对一修复原图快照校验失败，停止发送')
        return [job['reference']]
    reference = job['reference'] if step['number'] == 1 else job['steps'][0].get('output', '')
    if step['number'] > 1 and not bridge._saved(job['steps'][0]):
        raise ValueError('本款主图未通过文件校验，禁止继续场景图')
    return [step['template'], reference]


def _output_basename(job, step):
    value = step.get('output_basename') if job.get('workflow_input_mode') == 'single_source_edit' else None
    if value is not None:
        if value not in ('01-main', '02-back'):
            raise ValueError('一对一修复输出名称无效')
        return value
    return f'{step["number"]:02d}-{step["key"]}'


def payload(job):
    import gpt_extension_bridge as bridge
    step = current(job)
    wait = max(0, math.ceil(float(job.get('next_step_at', 0)) - time.time()))
    attachments = []
    if not wait and step['phase'] == 'ready':
        paths = _input_paths(job, step)
        attachments = [bridge._attachment(path) for path in paths]
        if job.get('workflow_input_mode') == 'single_source_edit':
            attachments[0]['name'] = '01-source-original' + Path(paths[0]).suffix.lower()
        else:
            attachments[0]['name'] = f'01-template-{step["key"]}' + Path(paths[0]).suffix.lower()
            attachments[1]['name'] = '02-reference-' + ('print' if step['number'] == 1 else 'master') + Path(paths[1]).suffix.lower()
        if step.get('generation_retry_input_hashes'):
            hashes = [hashlib.sha256(base64.b64decode(item['base64'])).hexdigest() for item in attachments]
            if hashes != step['generation_retry_input_hashes']:
                raise ValueError('重发所用模板或参考图已变化，停止发送')
    marker, prompt = step_prompt(job, step)
    return {'task': dict(job_id=job['id'], workflow_mode=MODE, workflow_id=job['workflow_id'],
                         workflow_input_mode=job.get('workflow_input_mode', ''),
                         expected_count=1, total_steps=job.get('execution_end_step', len(job['steps'])), step_number=step['number'],
                         step_label=step['label'], step_token=step['step_token'], step_phase=step['phase'],
                         prompt=prompt, prompt_marker=marker, prompt_excerpt=step['prompt'][:100], attachments=attachments, saved=[],
                         chat_url=bridge._stable_job_chat_url(job), resume=step['phase'] != 'ready',
                         user_message_id=step.get('user_message_id', ''), wait_seconds=wait,
                         collect_only=bool(job.get('recovery_collect_only')), reconnect_count=step.get('reconnect_count', 0),
                         generation_retry_count=step.get('generation_retry_count', 0),
                         response_last_progress_at=job.get('response_last_progress_at'),
                         response_refresh_count=job.get('response_refresh_count', 0))}


def _attachment_diagnostic(value):
    """Keep bounded structural counters, never page text, attributes or URLs."""
    if not isinstance(value, dict):
        return None
    try:
        if len(json.dumps(value, ensure_ascii=False).encode('utf-8')) > 3072:
            return None
    except (TypeError, ValueError, RecursionError):
        return None
    if type(value.get('version')) is not int or value['version'] != 1:
        return None
    states = ('missing_composer', 'missing_scope', 'excluded_scope', 'captured', 'truncated')
    scopes = ('none', 'form', 'parent', 'wrapper')
    if value.get('state') not in states or value.get('scope') not in scopes:
        return None
    result = dict(version=1, state=value['state'], scope=value['scope'])
    booleans = {
        'composer': ('connected', 'visible'),
        'control': ('present', 'connected', 'visible', 'native_disabled',
                    'inherited_disabled', 'aria_disabled', 'expanded', 'open', 'marked'),
        'ancestors': ('overlay', 'dialog', 'history'),
    }
    for group, keys in booleans.items():
        fields = value.get(group)
        if not isinstance(fields, dict) or any(type(fields.get(key)) is not bool for key in keys):
            return None
        result[group] = {key: fields[key] for key in keys}
    keys = ('elements', 'file_inputs', 'disabled_inputs', 'multiple_inputs',
            'markers', 'visible_markers', 'images', 'visible_images', 'image_small',
            'image_eligible_size', 'image_large', 'image_unloaded', 'images_in_overlay',
            'images_in_dialog', 'images_in_history', 'overlays', 'progress',
            'remove_buttons', 'file_dialog_buttons', 'cards', 'raw_images', 'raw_markers')
    counts = value.get('counts')
    if not isinstance(counts, dict) or any(type(counts.get(key)) is not int or
                                          not 0 <= counts[key] <= 5000 for key in keys):
        return None
    result['counts'] = {key: counts[key] for key in keys}
    return result


def update(job, body, data):
    """Called inside the bridge ownership/session lock. Never infer a send from a URL."""
    import gpt_extension_bridge as bridge
    event = body.get('event')
    step = current(job)
    total = len(job['steps'])
    if body.get('step') is not None and (int(body['step']) != step['number'] or body.get('step_token') != step['step_token']) and event not in ('downloaded','downloaded_bytes'):
        raise ValueError('旧步骤已失去更新权限')
    if event == 'workflow_quota':
        import gpt_unattended
        return gpt_unattended.quota_event(data, job, body)
    if event in ('progress', 'waiting', 'image_progress', 'response_diagnostic', 'downloading'):
        if event == 'waiting' and step['phase'] not in ('sending', 'sent'):
            raise ValueError('本步骤还未发送')
        if body.get('chat_url') and job.get('chat_url') and body['chat_url'].rstrip('/') != job['chat_url'].rstrip('/'):
            raise ValueError('工作流必须保持原聊天')
        if event == 'progress':
            message = str(body.get('message', '执行中'))[:220]
            if job.get('status') != message:
                bridge._trace(job, 'progress', message, step=step['number'])
            job['status'] = message
        if event == 'downloading':
            job['status'] = f'第 {step["number"]}/{total} 张：正在保存'
            job.setdefault('download_started_at', bridge.now())
        diagnostic = body.get('diagnostic')
        if isinstance(diagnostic, dict):
            encoded = json.dumps(diagnostic, ensure_ascii=False)
            if len(encoded) <= 6000:
                step['last_diagnostic'] = diagnostic
                step['diagnostic_at'] = bridge.now()
        bridge._write(data, job)
        return {'ok': True, 'job_status': job['status']}
    if event in ('error', 'generation_failed', 'workflow_needs_review'):
        message = str(body.get('message') or '本步骤需要人工核对，保留原对话与图片')[:500]
        import gpt_unattended
        reason = 'workflow_page_not_ready' if body.get('code') == 'workflow_page_not_ready' else 'task_stalled'
        if step['phase'] == 'ready' and body.get('code') == 'workflow_attachment_not_ready':
            reason = 'workflow_attachment_not_ready'
            # This report describes only this owned, explicitly unsent attempt.
            # Invalid diagnostics must never prevent the existing isolation path.
            if (body.get('step') == step['number'] and body.get('step_token') == step['step_token']
                    and not any(step.get(key) for key in ('send_started_at', 'sent_at', 'user_message_id'))):
                diagnostic = _attachment_diagnostic(body.get('attachment_diagnostic'))
                if diagnostic is not None:
                    step['last_attachment_diagnostic'] = diagnostic
                    step['attachment_diagnostic_at'] = bridge.now()
                    step['attachment_diagnostic_step_token'] = step['step_token']
                    bridge._trace(job, 'attachment_diagnostic', '记录本步骤附件结构计数',
                                  step=step['number'], step_token=step['step_token'],
                                  worker_id=job.get('assigned_worker', ''),
                                  diagnostic=diagnostic)
        gpt_unattended.isolate(data, job, message, reason)
        return {'ok': True, 'job_status': job['status'], 'task_isolated': True}
    number = int(body.get('step', 0))
    if number < step['number'] and event in ('downloaded', 'downloaded_bytes'):
        old = next((s for s in job['steps'] if s['number'] == number), {})
        if body.get('step_token') == old.get('step_token') and bridge._saved(old):
            return {'ok': True, 'duplicate': True, 'job_status': job['status']}
    if number != step['number'] or body.get('step_token') != step['step_token']:
        raise ValueError('旧步骤已失去发送或保存权限')
    if event == 'workflow_retry_once':
        if step['phase'] != 'sent' or not bridge._stable_job_chat_url(job) or body.get('chat_url','').rstrip('/') != job['chat_url'].rstrip('/'):
            raise ValueError('仅允许本步骤已确认发送后在原聊天重发')
        if job.get('recovery_collect_only'):
            raise ValueError('仅续收模式禁止重发')
        if step.get('generation_retry_count',0) >= 1:
            raise ValueError('本步骤已重发过一次，禁止再次重发')
        if body.get('failed_prompt_marker') != step_prompt(job,step)[0]:
            raise ValueError('生成失败消息不属于当前步骤')
        if body.get('generating') is not False or body.get('generated_images') != 0:
            raise ValueError('仍在生成或已经有图片，禁止重发')
        failure = ' '.join(str(body.get('failure_text','')).split())[:2000]
        if not retryable_generation_failure(failure):
            raise ValueError('不是已授权的一次性技术失败重发情形')
        if bridge._saved(step) or any(Path(job['result_folder']).glob(_output_basename(job, step) + '.*')):
            raise ValueError('本步骤已经存在保存文件，禁止重发')
        hashes = [hashlib.sha256(Path(path).read_bytes()).hexdigest() for path in _input_paths(job, step)]
        step.setdefault('failed_attempts',[]).append(dict(
            step_token=step['step_token'],sent_at=step.get('sent_at'),
            user_message_id=step.get('user_message_id'),failure_text=failure,
            confirmed_at=bridge.now(),input_hashes=hashes))
        step.update(generation_retry_count=1,generation_retry_input_hashes=hashes,
                    phase='ready',step_token=uuid.uuid4().hex,status='明确生成失败，仅重发一次')
        for key in ('send_started_at','sent_at','user_message_id','last_diagnostic','diagnostic_at','reconnect_count'):
            step.pop(key,None)
        job.update(batch_phase='waiting',error='',next_step_at=time.time()+job['step_delay_seconds'],
                   status=f'第 {number}/{total} 张：明确失败，原聊天准备唯一一次重发',response_last_progress_at=bridge.now())
        bridge._trace(job,'workflow_retry_once','GPT 明确表示生成失败并要求重发；原账号原聊天仅重发一次',step=number,failure_text=failure)
        bridge._write(data,job)
        return {'ok':True,**payload(job)}
    elif event == 'workflow_reconnect':
        if step['phase'] != 'sent' or not bridge._stable_job_chat_url(job) or body.get('chat_url','').rstrip('/') != job['chat_url'].rstrip('/'):
            raise ValueError('仅允许已确认发送的步骤重连原聊天')
        if step.get('reconnect_count',0) >= 1:
            raise ValueError('本步骤已重连过一次，停止自动刷新')
        step['reconnect_count'] = step.get('reconnect_count',0)+1
        job.update(response_last_progress_at=bridge.now(),status=f'第 {number}/{total} 张：重连原聊天收图，不重发')
        bridge._trace(job,'workflow_reconnect','已发送步骤仅重连原聊天收图，不上传附件或重发提示词',step=number)
    elif event == 'workflow_sending':
        import gpt_unattended
        if gpt_unattended.account(data, job.get('assigned_browser'), job.get('assigned_worker'))['blocked']:
            raise ValueError('本账号额度停发中，禁止发送；未发送步骤将自动转接')
        if step['phase'] != 'ready' or time.time() < float(job.get('next_step_at', 0)):
            raise ValueError('本步骤已进入发送边界或尚未到开始时间，禁止重复发送')
        relay_start = (job.get('execution_segment') and job.get('relay_start_step') == number
                       and not bridge._stable_job_chat_url(job) and body.get('chat_url', '').rstrip('/') == 'https://chatgpt.com')
        if number > 1 and not relay_start and (body.get('chat_url', '').rstrip('/') != job.get('chat_url', '').rstrip('/') or not bridge._stable_job_chat_url(job)):
            raise ValueError('后续图片必须在本套原聊天发送')
        retrying = bool(step.get('generation_retry_count'))
        job.pop('download_started_at', None)
        step.update(phase='sending', send_started_at=bridge.now(), status='正在确认唯一一次重发' if retrying else '正在确认发送')
        job.update(batch_phase='sending', status=f'第 {number}/{total} 张：'+('正在唯一一次重发' if retrying else '正在发送'), send_started_at=bridge.now())
        bridge._trace(job, 'sending', f'第 {number}/{total} 张，发送两张图片和独立提示词', step=number)
    elif event == 'workflow_sent':
        url = str(body.get('chat_url', ''))
        if step['phase'] not in ('sending', 'sent') or not bridge._stable_chat_url(url):
            raise ValueError('未确认本步骤发送或缺少稳定聊天地址')
        if job.get('chat_url') and url.rstrip('/') != job['chat_url'].rstrip('/'):
            raise ValueError('禁止更换本套原聊天')
        message_id = str(body.get('user_message_id', ''))[:250]
        if not message_id:
            raise ValueError('未确认本步骤的用户消息')
        if step['phase'] == 'sent':
            if step.get('user_message_id') != message_id:
                raise ValueError('同一步出现不同用户消息，请人工核对')
            return {'ok': True, 'duplicate': True, 'job_status': job['status']}
        stamp = bridge.now()
        step.update(phase='sent', sent_at=stamp, user_message_id=message_id, status='等待本张生成')
        job.setdefault('sent_at', stamp)
        job.update(chat_url=url, batch_phase='waiting', status=f'第 {number}/{total} 张：{step["label"]}生成中'+('（已重发 1/1）' if step.get('generation_retry_count') else ''),
                   response_last_progress_at=stamp, response_refresh_count=0)
        bridge._trace(job, 'sent', f'第 {number}/{total} 张消息已确认，在原聊天等待图片', chat_url=url, step=number)
    elif event in ('downloaded', 'downloaded_bytes'):
        if step['phase'] != 'sent':
            raise ValueError('本步骤尚未确认发送，不能归档图片')
        if event == 'downloaded_bytes':
            encoded = str(body.get('base64', ''))
            if not encoded or len(encoded) > 42 * 1024 * 1024:
                raise ValueError('图片数据为空或过大')
            try:
                raw = base64.b64decode(encoded, validate=True)
            except (ValueError, TypeError) as exc:
                raise ValueError('图片 Base64 无效') from exc
        else:
            raw = Path(str(body.get('path', ''))).read_bytes()
        if not 1024 <= len(raw) <= 30 * 1024 * 1024:
            raise ValueError('图片大小不合理')
        ext = bridge._image_ext(raw)
        from PIL import Image
        from io import BytesIO
        try:
            with Image.open(BytesIO(raw)) as image:
                image.verify()
        except (OSError, ValueError) as exc:
            raise ValueError('生成图片文件校验失败') from exc
        digest = hashlib.sha256(raw).hexdigest()
        forbidden = bridge._input_hashes(job) | {s['sha256'] for s in job['steps'] if s.get('sha256')}
        if digest in forbidden:
            raise ValueError('拒绝保存模板、参考图或前一步成图，继续等待本步骤的新生成图')
        if any(s.get('phase') == 'saved' and not bridge._saved(s) for s in job['steps']):
            raise ValueError('此前保存的图片校验失败，已停止保存后续图片')
        target = Path(job['result_folder']) / (_output_basename(job, step) + ext)
        if job.get('workflow_input_mode') == 'single_source_edit' and any(Path(job['result_folder']).glob(_output_basename(job, step) + '.*')):
            raise ValueError('修复目标已有同名结果，保留文件并停止覆盖')
        if target.exists():
            raise ValueError('目标文件已存在且未登记，保留文件并停止覆盖')
        with target.open('xb') as out:
            out.write(raw)
        if hashlib.sha256(target.read_bytes()).hexdigest() != digest:
            raise ValueError('成图保存校验失败')
        step.update(phase='saved', status='已保存', output=str(target), sha256=digest, saved_at=bridge.now())
        job.pop('download_started_at', None)
        bridge._trace(job, 'downloaded', f'第 {number}/{total} 张已保存并通过文件校验', step=number, output=str(target))
        remaining = [s for s in job['steps'] if not bridge._saved(s)]
        if not remaining:
            bridge.append_fixed(job)
            job.update(batch_phase='saved', status=f'{total} 张已保存，待检查', runner=None, completed_at=bridge.now())
            bridge._trace(job, 'completed', f'同一浏览器、同一聊天，{total} 个单图步骤全部保存')
        else:
            next_step = remaining[0]
            if next_step['number'] <= number:
                raise ValueError('此前保存的图片校验失败，已停止后续步骤')
            next_step['ready_started_at'] = bridge.now()
            job.update(current_step=next_step['number'], next_step_at=time.time() + job['step_delay_seconds'],
                       batch_phase='waiting', status=f'第 {number}/{total} 张已保存，等待 {job["step_delay_seconds"]} 秒继续',
                       response_last_progress_at=bridge.now(), response_refresh_count=0)
            bridge._trace(job, 'step_delay', '原聊天保留，下一张使用模板与本款主图', next_step=next_step['number'])
            if job.get('recovery_collect_only'):
                job.update(batch_phase='paused',runner=None,claim_session='',status=f'已续收第 {number} 张；后续未发送步骤保留',paused_at=bridge.now())
                job.pop('recovery_collect_only',None)
    else:
        raise ValueError('逐张工作流不支持此执行事件')
    bridge._write(data, job)
    return {'ok': True, 'job_status': job['status'], 'current_step': job['current_step']}
