"""Local runtime, diagnostics and setup for the independent Windows distribution."""
from __future__ import annotations

import ctypes
import json
import multiprocessing
import os
import platform
import queue
import sys
import tempfile
import threading
import time
import traceback
from datetime import datetime
from pathlib import Path

APP_VERSION = "1.7.4"
RELEASE_DATE = "2026-10-30"
VERSION = f"{APP_VERSION} ({RELEASE_DATE})"
APP_ID = "DianxiaomiUploaderStandalone"
_mutex = None


def default_data_directory() -> Path:
    base = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData/Local")
    return base / APP_ID


def prepare_runtime() -> Path:
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(1)
    except (AttributeError, OSError):
        pass
    data = Path(os.environ.get("DXM_STANDALONE_DATA") or default_data_directory()).resolve()
    data.mkdir(parents=True, exist_ok=True)
    # Verify user permissions before opening a window or starting a batch.
    with tempfile.TemporaryFile(dir=data) as probe:
        probe.write(b"ok")
    os.environ["DXM_STANDALONE_DATA"] = str(data)
    os.environ["PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD"] = "1"
    bypass = os.environ.get("NO_PROXY", os.environ.get("no_proxy", ""))
    os.environ["NO_PROXY"] = ",".join(filter(None, [bypass, "localhost", "127.0.0.1", "::1"]))
    os.environ["no_proxy"] = os.environ["NO_PROXY"]
    for key in ("PYTHONHOME", "PYTHONPATH", "NODE_OPTIONS", "NODE_PATH"):
        os.environ.pop(key, None)
    (data / "logs").mkdir(exist_ok=True)
    log = (data / "logs/startup.log").open("a", encoding="utf-8", buffering=1)
    if sys.stdout is None:
        sys.stdout = log
    if sys.stderr is None:
        sys.stderr = log
    print(f"\n[{datetime.now().isoformat(timespec='seconds')}] {VERSION}", flush=True)
    if getattr(sys, "frozen", False):
        ctypes.windll.kernel32.SetDllDirectoryW(None)
    return data


def show_error(message: str) -> None:
    ctypes.windll.user32.MessageBoxW(None, message, "店小秘独立版", 0x10)


def claim_single_instance(data: Path) -> bool:
    import hashlib
    global _mutex
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateMutexW.argtypes = [ctypes.c_void_p, ctypes.c_bool, ctypes.c_wchar_p]
    kernel.CreateMutexW.restype = ctypes.c_void_p
    key = hashlib.sha256(str(data).casefold().encode()).hexdigest()[:24]
    _mutex = kernel.CreateMutexW(None, False, "Local\\DXMUploader-" + key)
    if not _mutex:
        raise ctypes.WinError(ctypes.get_last_error())
    return ctypes.get_last_error() != 183


def validate_config() -> list[str]:
    """Preserve invalid configuration for recovery; never touch listing state."""
    import main
    warnings = []
    if not main.CONFIG_PATH.exists():
        return warnings
    try:
        raw = json.loads(main.CONFIG_PATH.read_text(encoding="utf-8-sig"))
        if not isinstance(raw, dict):
            raise ValueError("配置不是对象")
        defaults = main.AppConfig().__dict__
        for key, value in raw.items():
            if key in defaults and type(value) is not type(defaults[key]):
                raise ValueError(f"{key} 的格式不正确")
        if raw.get("publish_mode", "review") not in {"review", "schedule", "publish"}:
            raise ValueError("运行模式无效")
        if raw.get("listing_profile", "blanket") not in {"blanket", "tshirt", "tshirt_bw"}:
            raise ValueError("上架脚本无效，请选择毛毯、T恤或黑白T恤")
        if raw.get("bw_first_color", "white") not in {"white", "black"}:
            raise ValueError("黑白图片顺序无效")
        if raw.get("description_mode", "replace") not in {"keep", "replace"}:
            raise ValueError("产品描述图片模式无效")
        limits = {"concurrent_pages": (1, 3), "variant_count": (1, 100), "min_images": (1, 10),
                  "max_images": (1, 10), "upload_wait_seconds": (1, 600),
                  "operation_timeout_seconds": (1, 600), "login_wait_minutes": (1, 120),
                  "schedule_hour": (0, 23), "schedule_minute": (0, 59)}
        for key, (low, high) in limits.items():
            if key in raw and not low <= raw[key] <= high:
                raise ValueError(f"{key} 超出范围")
        for field, label in (("common_detail_images", "通用"),
                             ("white_detail_images", "白色"), ("black_detail_images", "黑色")):
            if not all(isinstance(p, str) for p in raw.get(field, [])):
                raise ValueError(f"{label}细节图片路径无效")
        # Normalize an optional UTF-8 BOM, using the same atomic writer as the UI.
        main.AppConfig(**{k: v for k, v in raw.items() if k in defaults}).save()
    except (ValueError, TypeError) as exc:
        backup = main.CONFIG_PATH.with_name(f"config.invalid-{time.time_ns()}.json")
        main.CONFIG_PATH.replace(backup)
        warnings.append(f"原配置无法读取（{exc}），已备份到：\n{backup}\n请重新选择目录和模板网址。完成记录未修改。")
    return warnings


def _spawn_probe(result_queue) -> None:
    import main
    from listing_profiles import ArticleNumberStore
    from playwright.sync_api import sync_playwright
    number = ArticleNumberStore(main.APP_DIR / "selftest-article-numbers.json").reserve("worker", "Test")[0]
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path=main.find_browser(), headless=True)
        page = browser.new_page()
        page.set_content("<title>worker-ok</title>")
        result_queue.put({"title": page.title(), "article_number": number})
        browser.close()


def run_checks(*, spawn: bool = False, gui_enabled: bool = True) -> dict:
    """Use only local pages; diagnostics never contact a seller website."""
    import main
    report = {"version": VERSION, "os": platform.platform(), "architecture": platform.machine(),
              "python_bundled": getattr(sys, "frozen", False), "checks": [], "ok": False}

    def check(name, operation):
        try:
            detail = operation()
            report["checks"].append({"name": name, "ok": True, "detail": detail})
        except Exception:
            report["checks"].append({"name": name, "ok": False, "detail": traceback.format_exc()})

    def writable():
        with tempfile.TemporaryFile(dir=main.APP_DIR) as f:
            f.write(b"ok")
        return str(main.APP_DIR)

    def gui():
        import tkinter as tk
        root = tk.Tk()
        try:
            root.withdraw()
            root.update()
            return root.tk.call("info", "patchlevel")
        finally:
            root.destroy()

    def pictures():
        from PIL import Image
        with tempfile.TemporaryDirectory(dir=main.APP_DIR) as scratch:
            src = Path(scratch) / "中文 图片.png"
            dst = Path(scratch) / "轮播.jpg"
            Image.new("RGBA", (300, 180), (30, 80, 160, 140)).save(src)
            main.prepare_carousel_jpg(src, dst)
            with Image.open(dst) as img:
                assert img.size == (1200, 1200) and img.mode == "RGB"
            original_bytes = src.read_bytes()
            for mode, size in (("original", (300, 180)), ("fit", (200, 120)), ("square", (800, 1000))):
                config = main.AppConfig(image_processing_mode=mode, image_max_edge=200,
                                        image_target_width=800, image_target_height=1000)
                uploader = main.DxmUploader(config, lambda _: None, threading.Event())
                target = Path(scratch) / f"{mode}.jpg"
                actual = uploader._prepare_upload_image(src, target)
                with Image.open(actual) as img:
                    assert img.size == size
                if mode == "original":
                    assert actual == src and not target.exists() and actual.read_bytes() == original_bytes
            assert src.read_bytes() == original_bytes
            for codec in ("JPEG", "PNG", "WEBP"):
                image_path = Path(scratch) / (codec + ".test")
                Image.new("RGB", (8, 8)).save(image_path, format=codec)
                with Image.open(image_path) as img:
                    img.load()
        return "JPG / PNG / WEBP；原图字节保持、等比缩小200×120、自定义800×1000；源文件不变、中文路径"

    def browser():
        from playwright.sync_api import sync_playwright
        with tempfile.TemporaryDirectory(dir=main.APP_DIR) as scratch:
            sample = Path(scratch) / "测试 文件.txt"
            sample.write_text("local test", encoding="utf-8")
            with sync_playwright() as pw:
                context = pw.chromium.launch_persistent_context(
                    str(Path(scratch) / "profile"), executable_path=main.find_browser(), headless=True)
                try:
                    page = context.new_page()
                    page.set_content('<title>local-ok</title><input type="file"><input id="t">')
                    page.locator("#t").fill("店小秘独立版")
                    page.locator('input[type="file"]').set_input_files(str(sample))
                    assert page.title() == "local-ok"
                    assert page.locator("#t").input_value() == "店小秘独立版"
                    assert page.locator('input[type="file"]').evaluate("e=>e.files.length") == 1
                    import tshirt_automation
                    page.evaluate("""() => {
                        const style=document.createElement('style');
                        style.textContent='.icon_down::before {content:"\\\\e007"}';
                        document.head.append(style);
                        const region=document.createElement('div'); region.id='picker-test';
                        region.innerHTML='<button onclick="this.dataset.clicked=1"><span>选择图片</span><span class="icon_down"></span></button>';
                        document.body.append(region);
                    }""")
                    region=page.locator('#picker-test')
                    assert region.get_by_role('button',name='选择图片',exact=True).count() == 0
                    picker=tshirt_automation._image_picker_button(region,'本地自检：')
                    picker.click()
                    assert picker.get_attribute('data-clicked') == '1'
                    return "Chromium " + context.browser.version + "; 下拉图标按钮识别和点击正常"
                finally:
                    context.close()

    check("用户数据目录读写", writable)
    if gui_enabled:
        check("界面组件", gui)
    check("图片处理组件", pictures)
    check("内置浏览器和自动化驱动", browser)
    if spawn:
        def workers():
            context = multiprocessing.get_context("spawn")
            results = context.Queue()
            child = context.Process(target=_spawn_probe, args=(results,))
            child.start()
            try:
                value = results.get(timeout=45)
                child.join(10)
                if value["title"] != "worker-ok" or len(value["article_number"]) > 22 or child.exitcode != 0:
                    raise RuntimeError(f"工作进程异常：{value}, {child.exitcode}")
                return "独立进程、独立浏览器驱动及持久货号模块正常"
            finally:
                if child.is_alive():
                    child.terminate()
                    child.join(5)
                results.close()
        check("多进程兼容", workers)
    report["ok"] = all(item["ok"] for item in report["checks"])
    return report


def verify_listing_improvements(app) -> list[dict]:
    """Exercise the shipped scanner and actual add-image callback with local fixtures."""
    import main
    from listing_profiles import ArticleNumberStore, normalize_template_url
    from PIL import Image
    checks = []
    original_selector = main.filedialog.askopenfilenames
    try:
        with tempfile.TemporaryDirectory(dir=main.APP_DIR) as scratch:
            base = Path(scratch)
            assert not app.config.album_cleanup_enabled
            app.album_cleanup_panel.set_settings(True, 100)
            album_config = app._current_config()
            assert album_config.album_cleanup_enabled and main.effective_concurrent_pages(album_config) == 1
            assert main.AppConfig.load().album_cleanup_threshold_mb == 100
            app.album_cleanup_panel.set_settings(False, 100)
            app._current_config()
            from album_cleanup import AlbumCleaner
            assert callable(AlbumCleaner.ensure_space)
            checks.append({"name": "图库自动清理设置与默认关闭", "ok": True,
                           "detail": "默认关闭、阈值100MB；开启设置可保存且使用单工作页；自检不访问真实图库、不删除图片"})
            from image_processing import ImageProcessingOptions
            for options in (ImageProcessingOptions(mode="original"),
                            ImageProcessingOptions(mode="fit", max_edge=1600),
                            ImageProcessingOptions(width=800, height=1000)):
                app.image_processing_panel.set_options(options)
                saved = app._current_config()
                assert saved.image_processing_mode == options.mode
                loaded = main.AppConfig.load()
                assert (loaded.image_processing_mode, loaded.image_target_width, loaded.image_target_height,
                        loaded.image_max_edge) == (options.mode, options.width, options.height, options.max_edge)
            app.image_processing_panel.set_options(ImageProcessingOptions())
            checks.append({"name": "上传尺寸选项与配置保存", "ok": True,
                           "detail": "原图、等比缩小、自定义矩形尺寸可选择并重新加载；旧默认1200×1200兼容"})
            batch = base / "批次 商品"
            batch.mkdir()
            for title, count in (("Regular A", 4), ("Regular B", 4), ("One Image", 1)):
                folder = batch / title
                folder.mkdir()
                for number in range(count):
                    Image.new("RGB", (8, 8), "white").save(folder / f"{number + 1}.png")
            config = main.AppConfig(product_root=str(batch), min_images=3)
            jobs, warnings = main.scan_product_folders(config)
            assert len(jobs) == 3 and main.summarize_scan(jobs, warnings) == (3, 3, 0)
            assert any("One Image" in warning and main.is_image_count_warning(warning) for warning in warnings)
            single = batch / "One Image"
            jobs, warnings = main.scan_product_folders(main.AppConfig(product_root=str(single)))
            assert len(jobs) == 1 and len(jobs[0].images) == 1
            assert not any(main.is_image_count_warning(warning) for warning in warnings)
            for folder in batch.iterdir():
                for image in folder.glob("*.png"):
                    if image.name != "1.png":
                        image.unlink()
            jobs, warnings = main.scan_product_folders(config)
            assert len(jobs) == 3 and not any(main.is_image_count_warning(warning) for warning in warnings)
            checks.append({"name": "单张商品图与批次数量预警", "ok": True,
                           "detail": "旧配置3张不阻塞；4/4/1预警但全纳入；全部单图及单款无数量报警"})

            first = base / "目录一"
            second = base / "目录二"
            first.mkdir()
            second.mkdir()
            paths = [first / "1.png", first / "2.png", second / "1.png", second / "10.png"]
            for path in paths:
                Image.new("RGB", (8, 8), "white").save(path)
            main.filedialog.askopenfilenames = lambda **kwargs: tuple(str(p) for p in paths[:2])
            app._choose_common_detail_images()
            app.common_detail_paths.reverse()
            main.filedialog.askopenfilenames = lambda **kwargs: tuple(str(p) for p in (paths[3], paths[0], paths[2]))
            app._choose_common_detail_images()
            expected = [str(paths[1]), str(paths[0]), str(paths[2]), str(paths[3])]
            assert app.common_detail_paths == expected
            assert main.AppConfig.load().common_detail_images == expected
            checks.append({"name": "跨目录累加通用细节图", "ok": True,
                           "detail": "实际界面回调保留手动顺序、追加新批次、路径去重、同名不同目录保留、配置可重载"})
            app.url_var.set("https://www.dianxiaomi.com/web/popTemu/edit?id=123。")
            app._normalize_template_entry()
            assert app.url_var.get() == "https://www.dianxiaomi.com/web/popTemu/quoteEdit?id=123"
            app.profile_var.set("tshirt")
            app.article_name_var.set("BKShirt")
            app._update_profile_controls()
            config = app._current_config()
            assert config.listing_profile == "tshirt" and config.article_name == "BKShirt"
            assert str(app.article_name_entry.cget("state")) == "normal"
            store = ArticleNumberStore(base / "numbers.json")
            first = store.reserve("product-one", "BKShirt", row_count=2)
            second = store.reserve("product-two", "BKShirt")
            assert len(set(first + second)) == 3 and max(map(len, first + second)) <= 22
            assert store.reserve("product-one", "BKShirt", row_count=2) == first
            import tshirt_automation
            assert callable(tshirt_automation.upload_images) and callable(tshirt_automation.verify_description_images)
            checks.append({"name": "模板转换、脚本选择和T恤货号", "ok": True,
                           "detail": "edit自动转quoteEdit；T恤配置可保存；各颜色货号唯一且重试复用；T恤自动化模块已包含"})
            from preflight_review import ImageOrderReviewDialog, preview_entries, sample_jobs
            bw_root = base / "黑白 批次"
            bw_root.mkdir()
            detail_groups = {}
            for color in ("white", "black"):
                detail_folder = base / f"{color}细节图"
                detail_folder.mkdir()
                detail_groups[color] = []
                for number in range(9):
                    path = detail_folder / f"detail-{number + 1}.png"
                    Image.new("RGB", (16, 16), color).save(path)
                    detail_groups[color].append(str(path))
            for number in range(3):
                folder = bw_root / f"BW Product {number + 1}"
                folder.mkdir()
                Image.new("RGB", (24, 24), "white").save(folder / "01-white.png")
                Image.new("RGB", (24, 24), "black").save(folder / "02-black.png")
            app.profile_var.set("tshirt_bw")
            app.description_mode_var.set("keep")
            app.bw_order_var.set("第1张白色，第2张黑色")
            app.path_var.set(str(bw_root))
            app.common_detail_paths = [str(base / "不应被黑白模式使用的旧通用图.png")]
            for color, detail_paths in detail_groups.items():
                app.color_detail_panel.set_paths(color, detail_paths)
            app.url_var.set(main.BW_TEMPLATE_URL)
            app._update_profile_controls()
            config = app._current_config()
            assert config.description_mode == "keep" and config.listing_profile == "tshirt_bw"
            assert str(app.bw_order_selector.cget("state")) == "readonly"
            jobs, warnings = main.scan_product_folders(config)
            assert len(jobs) == 3 and all(len(job.images) == 2 for job in jobs)
            assert all(len(job.color_image_sets[color]) == 10 for job in jobs for color in ("white", "black"))
            assert jobs[0].color_image_sets["white"][1:] == list(map(Path, detail_groups["white"]))
            assert jobs[0].color_image_sets["black"][1:] == list(map(Path, detail_groups["black"]))
            entries = preview_entries(jobs[0], config)
            assert len(entries) == 20 and entries[0].role == "white" and entries[10].role == "black"
            assert all(entry.role == "white_detail" for entry in entries[1:10])
            assert all(entry.role == "black_detail" for entry in entries[11:])
            dialog = ImageOrderReviewDialog(app.root, jobs, config)
            try:
                dialog.window.update()
                assert len(dialog.samples) == 3 and not dialog.result
                assert str(dialog.confirm_button.cget("state")) == "disabled"
                for _ in range(3):
                    assert dialog.current_ready and len(dialog.photos) == 20
                    dialog.acknowledge_current()
                assert str(dialog.confirm_button.cget("state")) == "normal"
                dialog.confirm()
                assert dialog.result
            finally:
                if dialog.window.winfo_exists():
                    dialog.cancel()
            checks.append({"name": "黑白独立细节图、描述设置与强制缩略图核对", "ok": True,
                           "detail": "各色主图+各自9张细节图独立保存和分组；旧通用图不使用；20张缩略图逐款核对3个样本；保留描述模式可保存"})
            # The actual sorting window must save the same order subsequently
            # used by scanning, per-color review and upload workers.
            app._preview_product_images()
            mixed = app._mixed_order_dialog
            try:
                mixed.select(1)
                mixed.move_to_first()
                mixed.apply_current_layout_to_all()
                mixed.save()
            finally:
                if mixed.window.winfo_exists():
                    mixed.cancel()
            config = app._current_config()
            jobs, _ = main.scan_product_folders(config)
            first_color = "white"
            for job in jobs:
                assert job.color_image_sets[first_color][0] == Path(detail_groups[first_color][0])
                assert job.color_image_sets[first_color][1] == job.images[0]
                assert job.color_image_sets["black"][0] == job.images[1]
                actual_entries = preview_entries(job, config)
                assert actual_entries[0].path == job.color_image_sets[first_color][0]
            reloaded = main.AppConfig.load()
            assert reloaded.combined_image_orders == config.combined_image_orders
            assert reloaded.combined_image_layouts == config.combined_image_layouts
            checks.append({"name": "商品图和细节图混合排序", "ok": True,
                           "detail": "真实排序窗口可将细节图移到主图前、按颜色应用全部商品、保存并重载；扫描和强制预览顺序一致"})
    finally:
        main.filedialog.askopenfilenames = original_selector
        app.common_detail_paths = []
        app.album_cleanup_panel.set_settings(False, 100)
        from image_processing import ImageProcessingOptions
        app.image_processing_panel.set_options(ImageProcessingOptions())
        app.color_detail_panel.set_paths("white", [])
        app.color_detail_panel.set_paths("black", [])
        app.config.combined_image_orders = {}
        app.config.combined_image_layouts = {}
        app.path_var.set("")
        app.url_var.set("")
        app.profile_var.set("blanket")
        app.article_name_var.set("")
        app.description_mode_var.set("replace")
        app.bw_order_var.set("第1张白色，第2张黑色")
        app._update_profile_controls()
        app._refresh_common_detail_summary()
        app._current_config()
        app.status_var.set("请选择商品图片总目录。")
    return checks


def attach_support_ui(app) -> None:
    import tkinter as tk
    from tkinter import filedialog, messagebox, ttk
    import main

    def callback_error(kind, error, tb):
        detail = "".join(traceback.format_exception(kind, error, tb))
        print(detail, file=sys.stderr, flush=True)
        app._append_log(detail)
        messagebox.showerror("操作未完成", f"{error}\n\n详细信息已写入启动日志。", parent=app.root)
    app.root.report_callback_exception = callback_error

    def settings():
        if app.worker is not None and app.worker.is_alive():
            messagebox.showinfo("任务运行中", "请等任务结束后再修改环境设置。", parent=app.root)
            return
        dialog = tk.Toplevel(app.root)
        dialog.title("环境与设置")
        dialog.geometry("660x390")
        dialog.transient(app.root)
        frame = ttk.Frame(dialog, padding=18)
        frame.pack(fill="both", expand=True)
        ttk.Label(frame, text="已包含运行环境和浏览器，无需安装 Python。", foreground="#0b63a8").pack(anchor="w")
        ttk.Label(frame, text="浏览器：留空使用内置浏览器；有特殊要求时可选择本机 Chrome / Edge。", wraplength=600).pack(anchor="w", pady=(14, 4))
        browser_var = tk.StringVar(value=app.config.browser_path)
        row = ttk.Frame(frame)
        row.pack(fill="x")
        ttk.Entry(row, textvariable=browser_var).pack(side="left", fill="x", expand=True)
        def choose():
            path = filedialog.askopenfilename(parent=dialog, title="选择 Chrome 或 Edge", filetypes=[("浏览器程序", "*.exe")])
            if path:
                browser_var.set(path)
        ttk.Button(row, text="选择", command=choose).pack(side="left", padx=5)
        ttk.Button(row, text="使用内置", command=lambda: browser_var.set("")).pack(side="left")
        ttk.Label(frame, text="并行工作页：配置较低的电脑建议保持 1。最多 3 页。", wraplength=600).pack(anchor="w", pady=(14, 4))
        count = tk.IntVar(value=app.config.concurrent_pages)
        ttk.Spinbox(frame, from_=1, to=3, textvariable=count, width=5, state="readonly").pack(anchor="w")
        ttk.Label(frame, text=f"配置、登录和运行记录保存在当前 Windows 用户目录：\n{main.APP_DIR}", wraplength=600).pack(anchor="w", pady=12)
        def save():
            custom = browser_var.get().strip()
            if custom and (not Path(custom).is_file() or Path(custom).name.lower() not in {"chrome.exe", "msedge.exe"}):
                messagebox.showerror("浏览器不可用", "请选择有效的 chrome.exe 或 msedge.exe，或点击“使用内置”。", parent=dialog)
                return
            app.config.browser_path = custom
            app.config.concurrent_pages = max(1, min(3, count.get()))
            app._current_config()
            dialog.destroy()
            app._append_log(f"设置已保存：最多 {app.config.concurrent_pages} 个工作页。")
        buttons = ttk.Frame(frame)
        buttons.pack(fill="x")
        ttk.Button(buttons, text="打开数据目录", command=lambda: os.startfile(main.APP_DIR)).pack(side="left")
        ttk.Button(buttons, text="保存设置", command=save).pack(side="right")

    def diagnose():
        if app.worker is not None and app.worker.is_alive():
            messagebox.showinfo("任务运行中", "请等任务结束后再进行环境自检。", parent=app.root)
            return
        diagnostic_button.configure(state="disabled")
        app._append_log("正在自检界面、图片和浏览器组件；不会打开店铺或提交商品。")
        result_queue = queue.Queue()
        # Tk must remain on the main thread; the existing window is the GUI check.
        def work():
            try:
                report = run_checks_without_gui()
                destination = main.LOG_DIR / f"environment-{datetime.now():%Y%m%d-%H%M%S}.json"
                destination.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
                result_queue.put((report, destination, None))
            except Exception:
                result_queue.put((None, None, traceback.format_exc()))
        def poll():
            try:
                report, destination, error = result_queue.get_nowait()
            except queue.Empty:
                app.root.after(100, poll)
                return
            diagnostic_button.configure(state="normal")
            if error:
                app._append_log(error)
                messagebox.showerror("自检未完成", "详细错误已写入窗口日志。", parent=app.root)
                return
            summary = "\n".join(("通过：" if x["ok"] else "失败：") + x["name"] for x in report["checks"])
            app._append_log(summary + f"\n报告：{destination}")
            (messagebox.showinfo if report["ok"] else messagebox.showwarning)("环境自检", summary + f"\n\n报告已保存：\n{destination}", parent=app.root)
        threading.Thread(target=work, daemon=True).start()
        app.root.after(100, poll)

    # Append a compact toolbar without changing the existing listing controls.
    toolbar = ttk.Frame(app.root, padding=(16, 4, 16, 10))
    toolbar.pack(side="bottom", fill="x", before=app.root.winfo_children()[0])
    app.support_toolbar = toolbar
    ttk.Button(toolbar, text="环境与设置", command=settings).pack(side="left")
    diagnostic_button = ttk.Button(toolbar, text="环境自检", command=diagnose)
    diagnostic_button.pack(side="left", padx=8)
    ttk.Button(toolbar, text="打开运行日志", command=lambda: os.startfile(main.LOG_DIR)).pack(side="left")
    ttk.Label(toolbar, text=f"独立版 {VERSION}", foreground="#666").pack(side="right")
    if not app.config.template_url or not app.config.product_root:
        app._append_log("首次使用：选择自己的商品图片目录，粘贴自己店铺的 Temu 模板编辑网址。\n先保持“发布前检查”，扫描后点击“开始运行”，在打开的独立浏览器内登录。\n测试正确后，再选择批量发布模式。")


def run_checks_without_gui() -> dict:
    # The UI exists on the main thread. Suppress creating a second Tk interpreter
    # in the diagnostic worker, but still exercise all image/browser operations.
    return run_checks(gui_enabled=False)
