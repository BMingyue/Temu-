"""Rebuild using Windows x64 Python 3.12 and requirements-build.txt."""
from __future__ import annotations
import argparse
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
from portable_runtime import APP_VERSION, RELEASE_DATE

ROOT = Path(__file__).resolve().parent


def run(*args, **kwargs):
    subprocess.run([str(arg) for arg in args], check=True, **kwargs)


def build():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=ROOT / ".build/dist")
    parser.add_argument("--browsers", type=Path, default=ROOT / ".build/browsers")
    args = parser.parse_args()
    if sys.platform != "win32" or sys.maxsize < 2**32:
        raise SystemExit("Build on 64-bit Windows with Python 3.12.")
    output = args.output.resolve()
    if (output / "DXMUploader-Windows-x64").exists():
        raise SystemExit("Output already exists. Choose a new --output directory.")
    cache = args.browsers.resolve()
    environment = os.environ.copy()
    environment["PLAYWRIGHT_BROWSERS_PATH"] = str(cache)
    run(sys.executable, "-m", "playwright", "install", "chromium", "--no-shell", env=environment)
    from playwright.sync_api import sync_playwright
    os.environ["PLAYWRIGHT_BROWSERS_PATH"] = str(cache)
    with sync_playwright() as pw:
        browser = Path(pw.chromium.executable_path).parent
        engine = pw.chromium.launch(executable_path=str(browser / "chrome.exe"), headless=True)
        try:
            browser_version = engine.version
            credits_page = engine.new_page()
            credits_page.goto("chrome://credits", wait_until="load")
            browser_credits = credits_page.content()
        finally:
            engine.close()
    run(sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean", "--onedir", "--windowed",
        "--name", "DXMUploader-Windows-x64", "--distpath", output,
        "--workpath", ROOT / ".build/pyinstaller", "--specpath", ROOT / ".build",
        "--paths", ROOT, "--collect-all", "playwright", "--collect-all", "PIL",
        "--add-data", f"{browser};browser", ROOT / "launcher.py", cwd=ROOT)
    folder = output / "DXMUploader-Windows-x64"
    (folder / "DXMUploader-Windows-x64.exe").rename(folder / "店小秘自动上架.exe")
    for name in ("使用说明.txt", "环境诊断.cmd"):
        shutil.copy2(ROOT / name, folder / name)
    licenses = folder / "licenses"
    licenses.mkdir()
    (licenses / "Chromium-credits.html").write_text(browser_credits, encoding="utf-8")
    runtime_root = Path(sys.base_prefix)
    for file in runtime_root.glob("LICENSE*"):
        if file.is_file():
            shutil.copy2(file, licenses / ("Python-" + file.name))
    for package in ("playwright", "Pillow", "greenlet", "pyee", "typing_extensions", "pyinstaller"):
        distribution = importlib.metadata.distribution(package)
        for file in distribution.files or ():
            if any(word in str(file).lower() for word in ("license", "copying", "notice")):
                source = Path(distribution.locate_file(file))
                if source.is_file():
                    relative = Path(str(file))
                    if relative.is_absolute() or ".." in relative.parts:
                        continue
                    destination = licenses / package / relative
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(source, destination)
    versions = {name: importlib.metadata.version(name) for name in ("playwright", "Pillow", "pyinstaller", "greenlet", "pyee", "typing_extensions")}
    source_hashes = {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest()
                     for name in ("main.py", "failure_records.py", "portable_runtime.py", "launcher.py", "listing_profiles.py", "tshirt_automation.py", "preflight_review.py", "color_detail_ui.py", "image_processing.py", "image_processing_ui.py", "mixed_image_order.py", "mixed_image_order_ui.py", "album_cleanup.py", "album_cleanup_policy.py", "album_cleanup_ui.py", "build.py", "requirements-build.txt")}
    manifest = {"app": "店小秘 Temu 自动上架独立版", "version": APP_VERSION, "date": RELEASE_DATE,
                "target": "Windows 10/11 x64", "python": sys.version, "packages": versions,
                "browser_directory": browser.name, "browser_version": browser_version, "source_sha256": source_hashes,
                "data_directory": "%LOCALAPPDATA%/DianxiaomiUploaderStandalone"}
    (folder / "版本信息.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    write_checksums(folder)
    print(folder)


def write_checksums(folder: Path):
    entries = []
    for file in sorted(folder.rglob("*")):
        if file.is_file() and file.name != "文件校验SHA256.txt":
            digest = hashlib.sha256(file.read_bytes()).hexdigest()
            entries.append(f"{digest}  {file.relative_to(folder).as_posix()}")
    (folder / "文件校验SHA256.txt").write_text("\n".join(entries) + "\n", encoding="utf-8")


if __name__ == "__main__":
    build()
