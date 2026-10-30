"""One-time archive of the previous image queue, leaving generated files alone."""

import json
import os
import subprocess
import sys
import time
import urllib.request
from datetime import datetime
from pathlib import Path

import psutil

from restart_workbench import is_our_backend


ROOT = Path(__file__).resolve().parent
DATA = (ROOT / 'data').resolve()
QUEUE = DATA / 'image-jobs'
ARCHIVES = DATA / 'image-jobs-archive'


def main():
    if not QUEUE.is_dir() or QUEUE.resolve().parent != DATA:
        raise RuntimeError('任务目录不在预期工作区内')
    if not ARCHIVES.is_dir() or ARCHIVES.resolve().parent != DATA:
        raise RuntimeError('归档目录不在预期工作区内')

    processes = [p for p in psutil.process_iter() if is_our_backend(p)]
    if len(processes) != 1:
        raise RuntimeError(f'预期一个工作台数据服务，实际找到 {len(processes)} 个')
    process = processes[0]
    if not is_our_backend(process):
        raise RuntimeError('工作台服务进程身份已变化')
    process.terminate()
    _, alive = psutil.wait_procs([process], timeout=20)
    if alive or any(is_our_backend(p) for p in psutil.process_iter()):
        raise RuntimeError('工作台服务仍在运行，取消归档')

    target = ARCHIVES / ('queue-reset-' + datetime.now().strftime('%Y%m%d-%H%M%S'))
    if target.exists() or target.resolve().parent != ARCHIVES.resolve():
        raise RuntimeError('归档目标路径无效')
    moved = False
    try:
        jobs = []
        for path in QUEUE.glob('*/job.json'):
            jobs.append(json.loads(path.read_text(encoding='utf-8')))
        sending = [j['id'] for j in jobs if j.get('batch_phase') == 'sending']
        if sending:
            raise RuntimeError('有任务处于发送结果待确认状态，取消归档：' + ', '.join(sending))

        os.replace(QUEUE, target)
        moved = True
        QUEUE.mkdir()
        manifest = {
            'archived_at': datetime.now().astimezone().isoformat(),
            'job_count': len(jobs),
            'saved_jobs': sum(j.get('batch_phase') == 'saved' for j in jobs),
            'generated_result_folders': [j.get('result_folder') for j in jobs if j.get('result_folder')],
        }
        (target / 'archive-manifest.json').write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8'
        )
        print(json.dumps({'archive': str(target), **{k: v for k, v in manifest.items() if k != 'generated_result_folders'}}, ensure_ascii=False))
    finally:
        if moved and not QUEUE.exists():
            QUEUE.mkdir()
        flags = getattr(subprocess, 'CREATE_NO_WINDOW', 0)
        with (DATA / 'backend.log').open('ab') as log:
            subprocess.Popen([sys.executable, str(ROOT / 'backend.py')], cwd=ROOT,
                             stdout=log, stderr=log, creationflags=flags)
        for _ in range(30):
            try:
                with urllib.request.urlopen('http://127.0.0.1:18769/api/health', timeout=1) as response:
                    if response.status == 200:
                        print('工作台数据服务已恢复')
                        break
            except Exception:
                time.sleep(1)
        else:
            raise RuntimeError('归档后工作台数据服务未恢复')


if __name__ == '__main__':
    main()
