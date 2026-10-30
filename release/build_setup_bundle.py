"""Wrap the frozen verified workbench ZIP with a Windows native bootstrap."""
import argparse
import hashlib
import json
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parent

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--payload", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    with args.payload.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    with zipfile.ZipFile(args.payload) as payload:
        names = payload.namelist()
        roots = {name.split('/',1)[0] for name in names}
        if len(roots)!=1 or len(set(names))!=len(names):
            raise RuntimeError('Payload root or member list is invalid')
        folder = roots.pop()
        prefix = folder+'/'
        checks = {}
        for line in payload.read(prefix+'SHA256SUMS.txt').decode('utf-8').splitlines():
            checksum, relative = line.split('  ',1)
            if relative.startswith('/') or '..' in relative.split('/') or '\\' in relative:
                raise RuntimeError('Invalid payload path')
            checks[prefix+relative] = checksum
        if set(names)!=set(checks)|{prefix+'SHA256SUMS.txt'}:
            raise RuntimeError('Payload contains unverified files')
        for name, checksum in checks.items():
            with payload.open(name) as stream:
                if hashlib.file_digest(stream,'sha256').hexdigest()!=checksum:
                    raise RuntimeError('Payload file differs: '+name)
        release = json.loads(payload.read(prefix+'workbench-release.json'))['version']
        uploader = json.loads(payload.read(prefix+'版本信息.json'))['uploader']
    if args.output.exists():
        raise RuntimeError("Output already exists; use a new filename")
    script = (ROOT / "setup_bundle.ps1").read_text(encoding="utf-8-sig")
    if script.count("__PAYLOAD_SHA256__") != 1:
        raise RuntimeError("Missing bootstrap payload hash placeholder")
    script = script.replace("__PAYLOAD_SHA256__", digest).replace('__PAYLOAD_FOLDER__', folder)
    command = ('@echo off\r\nchcp 65001 >nul\r\n'
               'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1" %*\r\n'
               'if errorlevel 1 (\r\n  pause\r\n  exit /b 1\r\n)\r\n')
    readme = '织品工作台 '+release+''' · 同事安装版

只需三步：
1. 右键本 ZIP，选择“全部解压”。
2. 双击“安装织品工作台.cmd”，等待文件检查完成。
3. 首次安装保持推荐位置，点“安装并打开”；以后双击桌面“织品工作台”。

不需要编程基础、Python、Node、开发者模式或管理员权限。
采集和生图有专用浏览器，一键打开并自动装好助手；首次登录自己的 Temu / GPT 账号即可。
“上新”内置店小秘 __UPLOADER_VERSION__，首次使用登录自己的店小秘账号。
同事使用指南和“检查运行环境.cmd”会随程序安装。

不用手动解压 workbench.zip；保留它和 setup.ps1，不要单独移动安装入口。
电脑需 Windows 10/11 64位，建议预留至少 4 GB 空间。文件检查失败会显示原因与日志位置；将提示和最新日志发给提供者。
日志在 %LOCALAPPDATA%\\TemuWorkbenchInstaller\\logs。
若已有旧版，先完成或停止旧任务；安装向导替换前会确认并保留旧目录备份。
默认保留此用户已有的店小秘登录与完成记录。

只转发原始安装 ZIP，不要转发用过的安装目录；使用过的目录可能包含你的登录和店铺资料。
'''
    readme = readme.replace('__UPLOADER_VERSION__', uploader)
    with zipfile.ZipFile(args.output, "w", compression=zipfile.ZIP_STORED) as bundle:
        bundle.writestr("INSTALL.cmd", command.encode("utf-8"))
        bundle.writestr("安装织品工作台.cmd", command.encode("utf-8"))
        bundle.writestr("setup.ps1", ("\ufeff" + script).encode("utf-8"))
        bundle.writestr("请先阅读.txt", readme.encode("utf-8-sig"))
        bundle.write(args.payload, "workbench.zip")
    with args.output.open("rb") as stream:
        result_hash = hashlib.file_digest(stream, "sha256").hexdigest()
    args.output.with_suffix(".zip.sha256").write_text(result_hash+"  "+args.output.name+"\n", encoding="utf-8")
    print(json.dumps({"archive":str(args.output),"bytes":args.output.stat().st_size,
                      "sha256":result_hash,"payload_sha256":digest,"files":5},ensure_ascii=False))

if __name__ == "__main__":
    main()
