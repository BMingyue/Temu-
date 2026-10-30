"""One immutable source image, one independent edit job, one output image."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import re
import shutil
import uuid

PRESET_ID = 'sweater-front-back-fix-v1'
INPUT_MODE = 'single_source_edit'
SOURCE_NAMES = ('01-main.png', '02-back.png')
ROOT = Path(__file__).resolve().parent


def catalog():
    return {'presets': [dict(id=PRESET_ID, label='毛衣正背面 · 半高领与面料细节局部修复',
                            mode=INPUT_MODE, source_names=list(SOURCE_NAMES),
                            description='一张原图单独开启一个聊天，只生成一张修改图；保留原图与其他画面。',
                            prompt=(ROOT / 'image_presets/sweater-source-edit/prompt.txt').read_text(encoding='utf-8'))]}


def _preset(body):
    ident = body.get('preset_id', PRESET_ID)
    if ident != PRESET_ID:
        raise ValueError('未知的一对一修复预设')
    return catalog()['presets'][0]


def _root(body, key):
    value = body.get(key, '')
    if not isinstance(value, str) or not value.strip():
        raise ValueError('请填写' + ('原图目录' if key == 'source_folder' else '独立保存目录'))
    return Path(value.strip().strip('"')).resolve()


def _folder_signature(folder):
    # A new downloaded replacement or any edited image invalidates a prior scan.
    rows = []
    for path in sorted(folder.iterdir(), key=lambda p: p.name.casefold()):
        if path.is_file() and path.suffix.lower() in ('.png', '.jpg', '.jpeg', '.webp'):
            stat = path.stat()
            rows.append((path.name, stat.st_size, stat.st_mtime_ns))
    return hashlib.sha256(json.dumps(rows, ensure_ascii=False).encode()).hexdigest()


def _manual_replacement(folder):
    return any(p.is_file() and p.suffix.lower() in ('.png', '.jpg', '.jpeg', '.webp')
               and re.match(r'^(?:chat\s*gpt|gpt)(?:[\s_-]|图像|image|$)', p.stem, re.I)
               for p in folder.iterdir())


def _exclusions(body, root, data):
    values = body.get('exclude_folders', [])
    if not isinstance(values, list) or any(not isinstance(value, str) for value in values):
        raise ValueError('人工已修目录排除清单无效')
    values = list(values)
    if data is not None:
        path = Path(data) / 'source-edit-exclusions.json'
        if path.exists():
            saved = json.loads(path.read_text(encoding='utf-8-sig'))
            if not isinstance(saved, dict):
                raise ValueError('人工已修目录排除记录无效，停止扫描')
            for saved_root, folders in saved.items():
                if Path(saved_root).resolve() == root:
                    if not isinstance(folders, list) or any(not isinstance(value, str) for value in folders):
                        raise ValueError('人工已修目录排除记录无效，停止扫描')
                    values.extend(folders)
    result = set()
    for value in values:
        candidate = Path(value)
        if not candidate.is_absolute():
            if candidate.name != value or value in ('', '.', '..'):
                raise ValueError('人工已修目录名无效')
            candidate = root / value
        candidate = candidate.resolve()
        if candidate != root and candidate.parent != root:
            raise ValueError('人工已修目录超出原图目录')
        result.add(str(candidate))
    return result


def scan(body, data=None):
    import image_workflows as flow
    _preset(body)
    root = _root(body, 'source_folder')
    if not root.is_dir():
        raise ValueError('原图目录不存在')
    excluded = _exclusions(body, root, data)
    folders = [root] if any((root / name).is_file() for name in SOURCE_NAMES) else sorted(
        (p for p in root.iterdir() if p.is_dir()), key=lambda p: p.name.casefold())
    if len(folders) > 2000:
        raise ValueError('一次最多扫描2000个产品目录')
    items, skipped = [], []
    for folder in folders:
        if str(folder.resolve()) in excluded:
            skipped.append(dict(folder=str(folder), reason='已登记为人工修复目录，保留历史排除'))
            continue
        if folder.resolve() != root and folder.resolve().parent != root:
            skipped.append(dict(folder=str(folder), reason='目录链接超出原图目录，已排除'))
            continue
        if _manual_replacement(folder):
            skipped.append(dict(folder=str(folder), reason='发现ChatGPT/GPT手动替换图片，整款已排除'))
            continue
        missing = [name for name in SOURCE_NAMES if not (folder / name).is_file()]
        if missing:
            skipped.append(dict(folder=str(folder), reason='原图对不完整，缺少' + '、'.join(missing) + '，整款已排除'))
            continue
        signature = _folder_signature(folder)
        count = 0
        for name in SOURCE_NAMES:
            path = folder / name
            if not path.is_file():
                continue
            if path.resolve().parent != folder.resolve():
                skipped.append(dict(folder=str(folder), reason=name + '链接超出产品目录，已排除'))
                continue
            try:
                flow._image(path)
                items.append(dict(path=str(path.resolve()), relative_path=path.relative_to(root).as_posix(),
                                  product_folder=folder.name, source_name=name,
                                  sha256=hashlib.sha256(path.read_bytes()).hexdigest(), folder_signature=signature))
                count += 1
            except (ValueError, OSError) as error:
                skipped.append(dict(folder=str(folder), reason=name + '：' + str(error)))
        if not count:
            skipped.append(dict(folder=str(folder), reason='没有可修复的01-main.png或02-back.png'))
    return dict(ok=True, source_folder=str(root), items=items, skipped=skipped, excluded_folders=sorted(excluded),
                folder_count=len(folders), file_count=len(items),
                message=f'扫描到 {len(items)} 张待修原图；手动替换过的整款已排除')


def prepare(body, data):
    import image_jobs
    import image_workflows as flow
    import gpt_extension_bridge as bridge
    selected = _preset(body)
    prompt = body.get('prompt', selected['prompt'])
    if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 12000:
        raise ValueError('修复提示词不能为空且最多12000字')
    items = body.get('items')
    if not isinstance(items, list) or not items or len(items) > 500:
        raise ValueError('请先扫描并选择1–500张原图')
    if type(body.get('start', False)) is not bool:
        raise ValueError('开始设置无效')
    start = body.get('start', False)
    root, output = _root(body, 'source_folder'), _root(body, 'output_folder')
    if output == root or output.is_relative_to(root) or root.is_relative_to(output):
        raise ValueError('保存目录必须与原图目录分开，不能包含彼此')
    browsers = bridge.normalize_browsers(body.get('browsers', ['chrome']))
    with image_jobs.BATCH_LOCK, bridge.LOCK:
        current = {row['path']: row for row in scan(body, data)['items']}
        existing = {j.get('source_edit_key'): j for j in image_jobs._read_jobs(data) if j.get('source_edit_key')}
        batch = 'EDIT-' + bridge.now()[:19].replace('-', '').replace(':', '').replace('T', '-') + '-' + uuid.uuid4().hex[:4].upper()
        jobs, skipped, errors, queued = [], [], [], 0
        seen = set()
        for item in items:
            child, created_folder = None, None
            try:
                if not isinstance(item, dict) or not isinstance(item.get('path'), str):
                    raise ValueError('原图选择无效，请重新扫描')
                path = str(Path(item['path']).resolve())
                if path in seen:
                    continue
                seen.add(path)
                fresh = current.get(path)
                if not fresh or any(item.get(k) != fresh[k] for k in ('sha256', 'folder_signature')):
                    raise ValueError('原图或产品目录在扫描后发生变化（或已手工替换），请重新扫描')
                signature = hashlib.sha256(json.dumps([PRESET_ID, path, fresh['sha256'], prompt, str(output)], ensure_ascii=False).encode()).hexdigest()
                previous = existing.get(signature)
                if previous:
                    if start and not previous.get('runner') and not previous.get('batch_phase'):
                        bridge.enqueue(data, previous['id'], browsers=browsers)
                        queued += 1
                    skipped.append(dict(path=path, id=previous['id'], reason='相同原图与提示词的修复任务已存在，未重复创建'))
                    continue
                source = Path(path)
                result = output / fresh['product_folder']
                basename = source.stem
                if any(result.glob(basename + '.*')):
                    raise ValueError('独立保存目录已有该图，保留已有结果，不覆盖')
                ident = uuid.uuid4().hex
                folder = Path(data) / 'image-jobs' / ident
                (folder / 'inputs').mkdir(parents=True)
                created_folder = folder
                snapshot = folder / 'inputs' / source.name
                shutil.copyfile(source, snapshot)
                if hashlib.sha256(snapshot.read_bytes()).hexdigest() != fresh['sha256'] or _folder_signature(source.parent) != fresh['folder_signature']:
                    raise ValueError('原图在复制期间发生变化，停止准备')
                result.mkdir(parents=True, exist_ok=True)
                stamp = bridge.now()
                key = 'main' if source.name == '01-main.png' else 'back'
                label = '正面局部修复' if key == 'main' else '背面局部修复'
                step = dict(number=1, key=key, label=label, template=str(snapshot), template_name=source.name,
                            output_basename=basename, prompt=prompt, phase='ready', status='待执行', step_token=uuid.uuid4().hex)
                (folder / 'prompt-01.txt').write_text(prompt, encoding='utf-8')
                child = dict(id=ident, task_no=f'IMG-{stamp[:10].replace("-", "")}-{ident[:8].upper()}',
                             title=fresh['product_folder'] + ' · ' + label, category='毛衣修复',
                             workflow_mode=flow.MODE, workflow_input_mode=INPUT_MODE, workflow_id=PRESET_ID,
                             workflow_label=selected['label'], workflow_version='1.0.0',
                             step_delay_seconds=30, current_step=1, next_step_at=0, expected_count=1,
                             prompt_template=prompt, reference=str(snapshot), reference_images=[str(snapshot)], created=stamp,
                             folder=str(folder), result_folder=str(result), steps=[step], fixed_images=[],
                             status='一对一原图修复已准备', runner=None, logs=[], batch_no=batch,
                             eligible_browsers=browsers, source_edit_key=signature, source_reference=path,
                             source_sha256=fresh['sha256'], source_folder_signature=fresh['folder_signature'],
                             source_relative_path=fresh['relative_path'], source_product_folder=fresh['product_folder'],
                             source_name=source.name, source_edit_output_root=str(output))
                bridge._trace(child, 'prepared', '一张原图、独立聊天、单张成品；只修改指定两处，原图不覆盖')
                bridge._write(data, child)
                # Once written, keep this immutable prepared job even if enqueue fails.
                created_folder = None
                existing[signature] = child
                if start:
                    bridge.enqueue(data, ident, browsers=browsers)
                    queued += 1
                jobs.append({k: child[k] for k in ('id', 'title', 'task_no', 'source_relative_path', 'result_folder')})
            except (ValueError, OSError, KeyError, TypeError) as error:
                if created_folder and created_folder.resolve().parent == (Path(data) / 'image-jobs').resolve():
                    shutil.rmtree(created_folder)
                errors.append(dict(path=item.get('path', '') if isinstance(item, dict) else '', error=str(error)))
        return dict(ok=True, batch_no=batch, jobs=jobs, skipped=skipped, errors=errors,
                    prepared_count=len(jobs), queued_count=queued,
                    message=f'已准备 {len(jobs)} 张一对一修复任务，排队 {queued} 张，跳过重复 {len(skipped)} 张，异常 {len(errors)} 张')
