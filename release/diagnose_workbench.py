"""Offline colleague diagnostics: no account, cookie or business record reads."""
import importlib
import json
from pathlib import Path
import sys
import urllib.request

ROOT = Path(__file__).resolve().parent


def diagnose():
    checks = []
    def add(label, ok, detail=''):
        checks.append(dict(item=label, ok=bool(ok), detail=detail))
    release = json.loads((ROOT/'workbench-release.json').read_text(encoding='utf-8'))
    add('工作台版本', True, release['version'])
    add('自带 Python', Path(sys.executable).resolve().is_relative_to(ROOT/'runtime/python'), sys.version.split()[0])
    for name in ('psutil', 'PIL', 'playwright', 'greenlet', 'pyee', 'tkinter', 'tzdata'):
        try:
            importlib.import_module(name)
            add('运行组件 '+name, True)
        except Exception as error:
            add('运行组件 '+name, False, type(error).__name__)
    try:
        from zoneinfo import ZoneInfo
        ZoneInfo('Asia/Shanghai')
        add('北京时间支持', True)
    except Exception:
        add('北京时间支持', False, '时区组件缺失，请重新完整安装。')
    import gpt_browser_profiles
    add('专用浏览器', bool(gpt_browser_profiles._testing_runtime()), 'Chrome for Testing')
    for folder, label in (('browser_extension','采集助手'),('gpt_chrome_extension','生图助手'),('local_tools/dxm-uploader','店小秘上架')):
        try:
            filename = '版本信息.json' if folder.startswith('local_tools') else 'manifest.json'
            version = json.loads((ROOT/folder/filename).read_text(encoding='utf-8'))['version']
            add(label, True, version)
        except Exception:
            add(label, False, '文件缺失或不完整，请重新完整安装。')
    for port, route, label in ((18769,'/api/health','本地数据服务'),(5173,'/api/health','工作台页面服务')):
        try:
            with urllib.request.urlopen(f'http://127.0.0.1:{port}{route}', timeout=3) as response:
                info = json.load(response)
            add(label, info.get('service')=='temu-workbench' and info.get('version')==release['version'], info.get('version','版本未知'))
        except Exception:
            add(label, False, '尚未启动；双击桌面“织品工作台”后重试。')
    lines = ['织品工作台环境检查（不包含账号、Cookie、商品和任务内容）', '']
    lines += [('通过' if row['ok'] else '待处理')+'  '+row['item']+('：'+row['detail'] if row['detail'] else '') for row in checks]
    lines += ['', '若文件缺失，请重新完整解压原始安装包并安装。服务尚未启动时先启动桌面入口。']
    output = ROOT/'环境检查结果.txt'
    output.write_text('\n'.join(lines)+'\n', encoding='utf-8-sig')
    print('\n'.join(lines))
    print('\n检查结果已保存为安装目录中的“环境检查结果.txt”。')
    return checks


if __name__ == '__main__':
    diagnose()
