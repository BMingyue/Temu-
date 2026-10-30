"""Frozen GUI entry point. Early freeze_support is essential for worker processes."""
import multiprocessing
import os
import sys

# Workers launched by the windowed executable also need valid standard streams.
if sys.stdout is None:
    sys.stdout = open(os.devnull, "w", encoding="utf-8")
if sys.stderr is None:
    sys.stderr = open(os.devnull, "w", encoding="utf-8")

if __name__ == "__main__":
    multiprocessing.freeze_support()


def entry() -> int:
    import json
    import tempfile
    import traceback
    from pathlib import Path
    import portable_runtime as runtime

    testing = "--self-test" in sys.argv
    diagnostic = testing or "--diagnose" in sys.argv
    scratch = tempfile.TemporaryDirectory(prefix="DXMUploader-test-") if testing else None
    if scratch:
        os.environ["DXM_STANDALONE_DATA"] = str(Path(scratch.name) / "用户 数据")
    data = None
    log_stream = None
    try:
        data = runtime.prepare_runtime()
        log_stream = (data / "logs/startup.log").open("a", encoding="utf-8", buffering=1)
        sys.stdout = log_stream
        sys.stderr = log_stream
        if not diagnostic and not runtime.claim_single_instance(data):
            import ctypes
            ctypes.windll.user32.MessageBoxW(None, "程序已经打开，请切换到现有的店小秘窗口。", "店小秘独立版", 0x40)
            return 0
        warnings = runtime.validate_config()
        if diagnostic:
            report = runtime.run_checks(spawn=True)
            if testing:
                import main
                app = main.UploaderApp()
                try:
                    app.root.update()
                    app.root.lift()
                    assert app.support_toolbar.winfo_ismapped()
                    assert app.support_toolbar.winfo_y() + app.support_toolbar.winfo_height() <= app.root.winfo_height()
                    assert app.url_var.get() == "" and app.path_var.get() == ""
                    assert app.mode_var.get() == "review"
                    app._current_config()
                    app._refresh_failure_records()
                    report["checks"].extend(runtime.verify_listing_improvements(app))
                    report["checks"].append({"name": "完整界面及全新配置", "ok": True,
                                             "detail": "默认检查模式、空模板和图片目录、单页；配置可保存"})
                    if "--screenshot" in sys.argv:
                        import time
                        app.root.update()
                        time.sleep(0.6)
                        from PIL import ImageGrab
                        screenshot = Path(sys.argv[sys.argv.index("--screenshot") + 1]).resolve()
                        screenshot.parent.mkdir(parents=True, exist_ok=True)
                        ImageGrab.grab(window=int(app.root.wm_frame(), 0)).save(screenshot)
                finally:
                    app.root.destroy()
            report["ok"] = all(c["ok"] for c in report["checks"])
            destination = data / "logs/environment.json"
            if "--report" in sys.argv:
                destination = Path(sys.argv[sys.argv.index("--report") + 1]).resolve()
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
            if "--diagnose" in sys.argv:
                import ctypes
                summary = "\n".join(("通过：" if c["ok"] else "失败：") + c["name"] for c in report["checks"])
                ctypes.windll.user32.MessageBoxW(None, summary + f"\n\n报告：{destination}", "环境自检", 0x40 if report["ok"] else 0x30)
            return 0 if report["ok"] else 1
        import main
        from tkinter import messagebox
        app = main.UploaderApp()
        for warning in warnings:
            app.root.after(250, lambda w=warning: messagebox.showwarning("配置已备份", w, parent=app.root))
        app.run()
        return 0
    except Exception:
        detail = traceback.format_exc()
        destination = (data or Path(tempfile.gettempdir())) / "startup-error.txt"
        try:
            destination.write_text(detail, encoding="utf-8")
        except OSError:
            destination = Path(tempfile.gettempdir()) / "DXMUploader-startup-error.txt"
            destination.write_text(detail, encoding="utf-8")
        if not testing:
            runtime.show_error(f"启动或自检未完成。请确认已完整解压整个压缩包。\n\n错误信息：\n{detail[-1400:]}\n\n详细日志：{destination}")
        elif "--report" in sys.argv:
            Path(sys.argv[sys.argv.index("--report") + 1]).write_text(
                json.dumps({"ok": False, "error": detail}, ensure_ascii=False, indent=2), encoding="utf-8")
        return 1
    finally:
        if log_stream:
            sys.stdout = sys.stderr = open(os.devnull, "w", encoding="utf-8")
            log_stream.close()
        if scratch:
            scratch.cleanup()


if __name__ == "__main__":
    raise SystemExit(entry())
