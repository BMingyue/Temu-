"""Mandatory, local thumbnail review before a listing worker may start.

The review never edits image order.  ``confirm_image_order`` returns ``True``
only after every sampled product has loaded and been individually acknowledged.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

import tkinter as tk
from tkinter import messagebox, ttk

from PIL import Image, ImageOps, ImageTk

from image_processing import describe_options, dimensions_for_upload, options_from_config
from mixed_image_order import make_items, ordered_items, path_identity, trim_items


@dataclass(frozen=True)
class PreviewEntry:
    path: Path
    source_index: int
    role: str
    label: str


def sample_jobs(jobs: Iterable[object]) -> list[object]:
    """Take the first, middle and last product, with no duplicate folders."""
    items = list(jobs)
    if not items:
        return []
    selected = []
    seen = set()
    for index in (0, len(items) // 2, len(items) - 1):
        job = items[index]
        key = path_identity(job.folder)
        if key not in seen:
            selected.append(job)
            seen.add(key)
    return selected


def _configured_color_details(config: object, color: str) -> list[Path]:
    """Rebuild a legacy job from the current color settings, never old common images."""
    raw_paths = getattr(config, f"{color}_detail_images", [])
    name = "白色" if color == "white" else "黑色"
    if not isinstance(raw_paths, (list, tuple)):
        raise ValueError(f"{name}细节图配置无效，请重新选择图片。")
    paths = []
    seen = set()
    for raw in raw_paths:
        path = Path(str(raw)).expanduser()
        raw_path = str(path)
        if os.name == "nt" and raw_path.startswith("\\\\?\\UNC\\"):
            path = Path("\\\\" + raw_path[8:])
        elif os.name == "nt" and raw_path.startswith("\\\\?\\"):
            path = Path(raw_path[4:])
        identity = path_identity(path)
        if identity not in seen:
            seen.add(identity)
            paths.append(path)
    maximum = max(0, int(getattr(config, "max_images", 10)) - 1)
    if len(paths) > maximum:
        raise ValueError(f"{name}细节图最多 {maximum} 张，请重新选择该颜色的细节图。")
    return paths


def preview_entries(job: object, config: object) -> list[PreviewEntry]:
    """Describe the saved upload order, without inspecting filenames for colors."""
    images = [Path(path) for path in job.images]
    common_count = int(getattr(job, "common_detail_count", 0))
    if common_count < 0 or common_count > len(images):
        raise ValueError("商品图的通用细节图数量无效，请重新扫描目录。")
    original_count = len(images) - common_count
    if original_count < 1:
        raise ValueError("商品文件夹没有可预览的原始商品图，请返回检查目录。")
    is_bw = getattr(config, "listing_profile", "blanket") == "tshirt_bw"
    first_color = getattr(config, "bw_first_color", "white")
    if is_bw and first_color not in {"white", "black"}:
        raise ValueError("黑白图片顺序无效，请重新选择第 1 张图片的颜色。")
    if is_bw and original_count != 2:
        raise ValueError("黑白 T恤每个商品必须恰好有 2 张原始商品图，分别对应白色和黑色。")
    colors = ("white", "black") if first_color == "white" else ("black", "white")
    color_labels = {"white": "白色", "black": "黑色"}
    color_sets = getattr(job, "color_image_sets", None)
    if is_bw:
        if color_sets is None or color_sets == {}:
            color_sets = {}
            for index, color in enumerate(colors):
                items = make_items([images[index]], _configured_color_details(config, color))
                color_sets[color] = [
                    item.path for item in trim_items(
                        ordered_items(config, job.folder, color, items),
                        limit=min(10, int(getattr(config, "max_images", 10))),
                    )
                ]
        if not isinstance(color_sets, dict) or set(color_sets) != {"white", "black"}:
            raise ValueError("黑白 T恤必须同时提供白色和黑色的完整上传图片，请重新扫描目录。")
        main_paths = {
            color: path_identity(images[index])
            for index, color in enumerate(colors)
        }
        entries = []
        for color in colors:
            name = color_labels[color]
            raw_paths = color_sets[color]
            if not isinstance(raw_paths, (list, tuple)) or not 1 <= len(raw_paths) <= 10:
                raise ValueError(f"{name}上传图片必须为 1 至 10 张，请重新选择该颜色的细节图。")
            paths = [Path(path) for path in raw_paths]
            resolved = [path_identity(path) for path in paths]
            if len(set(resolved)) != len(resolved):
                raise ValueError(f"{name}上传图片有重复，请重新扫描并核对混合排序。")
            if main_paths[color] not in resolved:
                raise ValueError(f"{name}上传图片缺少对应的商品图，请重新扫描并核对图片顺序。")
            opposite = "black" if color == "white" else "white"
            if main_paths[opposite] in resolved:
                raise ValueError(f"{name}图片中混入了{color_labels[opposite]}主图，请重新选择该颜色的细节图。")
            detail_index = 0
            for group_index, path in enumerate(paths):
                role = color if group_index == 0 else f"{color}_detail"
                if resolved[group_index] == main_paths[color]:
                    label = f"{name}主图" if group_index == 0 else f"{name}商品图"
                else:
                    detail_index += 1
                    label = f"{name}细节图 {detail_index}"
                    if group_index == 0:
                        label = f"{name}主图（{label}）"
                entries.append(PreviewEntry(
                    path, len(entries) + 1, role, f"{name}第 {group_index + 1} 张 → {label}"))
        return entries
    detail_paths = getattr(job, "detail_image_paths", None)
    if detail_paths:
        detail_identities = {path_identity(path) for path in detail_paths}
    else:
        # Historic jobs only recorded a count while their detail images were a tail.
        detail_identities = {
            path_identity(path) for path in images[original_count:]
        }
    entries = []
    for index, path in enumerate(images[:10]):
        if path_identity(path) in detail_identities:
            role = "common"
            label = "主图（通用细节图）" if index == 0 else "通用细节图"
        else:
            role = "main" if index == 0 else "product"
            label = "主图" if index == 0 else "商品图"
        entries.append(PreviewEntry(path, index + 1, role, f"第 {index + 1} 张 → {label}"))
    return entries


class ImageOrderReviewDialog:
    """A modal view with one acknowledgement per sampled product."""

    def __init__(self, parent: tk.Misc, jobs: Iterable[object], config: object):
        jobs = list(jobs)
        self.samples = sample_jobs(jobs)
        self.config = config
        self.image_processing_options = options_from_config(config)
        self.result = False
        self.checked: set[int] = set()
        self.photos: list[ImageTk.PhotoImage] = []
        self.current_index = 0
        self.current_ready = False
        self.window = tk.Toplevel(parent)
        self.window.title("开始前必须核对：商品图顺序")
        screen_width = self.window.winfo_screenwidth()
        screen_height = self.window.winfo_screenheight()
        width = min(1100, max(640, screen_width - 80))
        height = min(780, max(480, screen_height - 100))
        self.window.geometry(f"{width}x{height}")
        self.window.minsize(min(760, width), min(520, height))
        self.window.transient(parent)
        self.window.protocol("WM_DELETE_WINDOW", self.cancel)
        self.window.bind("<Escape>", lambda _event: self.cancel())

        outer = ttk.Frame(self.window, padding=14)
        outer.pack(fill="both", expand=True)
        publish_mode = getattr(config, "publish_mode", "review")
        mode_label = {"publish": "立即发布", "schedule": "定时发布", "review": "发布前检查"}.get(publish_mode, "发布前检查")
        if publish_mode == "schedule":
            mode_label += f"（明天 {getattr(config, 'schedule_hour', 10):02d}:{getattr(config, 'schedule_minute', 0):02d}）"
        self.run_mode_summary_var = tk.StringVar(self.window, value=f"本次将处理 {len(jobs)} 款商品；运行模式：{mode_label}。")
        ttk.Label(outer, textvariable=self.run_mode_summary_var, foreground="#b45309", wraplength=1020).pack(fill="x", pady=(0, 6))
        is_bw = getattr(config, "listing_profile", "blanket") == "tshirt_bw"
        explanation = "每次开始都需逐一核对首、中、末商品的图片顺序与缩略图。"
        if getattr(config, "album_cleanup_enabled", False):
            explanation += (f"\n图库自动清理已开启：低于 {getattr(config, 'album_cleanup_threshold_mb', 100)}MB 时，"
                            "最多清理末两页、跳过锁定与本批次使用图片；本批次使用单工作页。")
        if is_bw:
            first = "白色" if getattr(config, "bw_first_color", "white") == "white" else "黑色"
            second = "黑色" if first == "白色" else "白色"
            explanation += (
                f"\n商品文件夹中的第 1 张商品图对应{first}，第 2 张商品图对应{second}。"
                "所有文件夹必须按相同颜色顺序，图片不会自动识别颜色。"
            )
            explanation += "\n下方按颜色展示最终上传顺序，请分别核对两色主图和各自的细节图。"
        explanation += "每组第 1 张将作为实际上传主图，细节图可穿插在商品图之间。"
        explanation += "\n如有错误，点“返回调整排序”，通过主窗口的混合排序调整后重新开始。"
        ttk.Label(outer, text=explanation, wraplength=1020, justify="left").pack(fill="x")
        self.image_processing_summary_var = tk.StringVar(
            self.window, value="图片处理：" + describe_options(self.image_processing_options))
        ttk.Label(outer, textvariable=self.image_processing_summary_var,
                  foreground="#1658a0", wraplength=1020, justify="left").pack(fill="x", pady=(6, 0))
        self.progress_var = tk.StringVar(self.window)
        ttk.Label(outer, textvariable=self.progress_var, foreground="#1658a0").pack(anchor="w", pady=(8, 6))
        self.selector = ttk.Combobox(outer, state="readonly")
        self.selector.pack(fill="x", pady=(0, 6))
        self.selector.bind("<<ComboboxSelected>>", self._select_sample)
        self.folder_var = tk.StringVar(self.window)
        ttk.Entry(outer, textvariable=self.folder_var, state="readonly").pack(fill="x", pady=(0, 8))

        preview = ttk.Frame(outer)
        preview.pack(fill="both", expand=True)
        self.canvas = tk.Canvas(preview, background="#f5f5f5", highlightthickness=1, highlightbackground="#ddd")
        self.canvas.pack(side="left", fill="both", expand=True)
        scrollbar = ttk.Scrollbar(preview, orient="vertical", command=self.canvas.yview)
        scrollbar.pack(side="right", fill="y")
        self.canvas.configure(yscrollcommand=scrollbar.set)
        self.cards = ttk.Frame(self.canvas, padding=8)
        self.cards_window = self.canvas.create_window((0, 0), window=self.cards, anchor="nw")
        self.cards.bind("<Configure>", lambda _event: self.canvas.configure(scrollregion=self.canvas.bbox("all")))
        self.canvas.bind("<Configure>", self._resize_cards)
        self.error_var = tk.StringVar(self.window)
        ttk.Label(outer, textvariable=self.error_var, foreground="#b42318", wraplength=1020, justify="left").pack(fill="x", pady=(6, 3))
        footer = ttk.Frame(outer)
        footer.pack(fill="x", pady=(6, 0))
        ttk.Button(footer, text="返回调整排序", command=self.cancel).pack(side="left")
        self.previous_button = ttk.Button(footer, text="上一款", command=self.previous_sample)
        self.previous_button.pack(side="left", padx=8)
        self.ack_button = ttk.Button(footer, text="已核对本商品，下一款", command=self.acknowledge_current)
        self.ack_button.pack(side="left", padx=8)
        confirm_text = {"publish": "确认排序并立即发布", "schedule": "确认排序并定时发布"}.get(publish_mode, "确认排序并开始检查")
        self.confirm_button = ttk.Button(footer, text=confirm_text, command=self.confirm, state="disabled")
        self.confirm_button.pack(side="right")
        self._update_selector()
        if self.samples:
            self.show_sample(0)
        else:
            self.error_var.set("没有可核对的商品，已阻止开始。请返回重新扫描目录。")
            self.ack_button.configure(state="disabled")

    def _resize_cards(self, event: tk.Event | None = None) -> None:
        width = event.width if event is not None else self.canvas.winfo_width()
        self.canvas.itemconfigure(self.cards_window, width=width)
        columns = max(1, min(5, (width - 16) // 190))
        for index, card in enumerate(self.cards.winfo_children()):
            card.grid(row=index // columns, column=index % columns, sticky="nsew", padx=5, pady=5)

    def _update_selector(self) -> None:
        self.selector.configure(values=[
            f"{'✓ 已核对' if index in self.checked else '待核对'}  {index + 1}/{len(self.samples)}  {job.title}"
            for index, job in enumerate(self.samples)
        ])
        if self.samples:
            self.selector.current(self.current_index)
        self.progress_var.set(f"已核对 {len(self.checked)}/{len(self.samples)} 个抽样商品；请检查每张图及其用途。")

    def _select_sample(self, _event: object = None) -> None:
        self.show_sample(self.selector.current())

    def show_sample(self, index: int) -> None:
        if not 0 <= index < len(self.samples):
            return
        self.current_index = index
        self.current_ready = False
        self.ack_button.configure(state="disabled")
        self.confirm_button.configure(state="disabled")
        self.error_var.set("")
        for child in self.cards.winfo_children():
            child.destroy()
        self.photos.clear()
        job = self.samples[index]
        self.folder_var.set(f"商品文件夹：{Path(job.folder).resolve()}")
        errors = []
        try:
            entries = preview_entries(job, self.config)
        except (ValueError, TypeError) as exc:
            entries = []
            errors.append(str(exc))
        for entry in entries:
            card = ttk.Frame(self.cards, padding=6, relief="groove")
            card.grid(row=0, column=entry.source_index - 1, sticky="nsew", padx=5, pady=5)
            ttk.Label(card, text=entry.label, foreground="#1658a0", wraplength=170, justify="center").pack()
            try:
                with Image.open(entry.path) as opened:
                    opened.load()
                    image = ImageOps.exif_transpose(opened).convert("RGBA")
                    original_width, original_height = image.size
                    upload_width, upload_height = dimensions_for_upload(entry.path, self.image_processing_options)
                    background = Image.new("RGBA", image.size, "white")
                    background.alpha_composite(image)
                    thumbnail = ImageOps.pad(background.convert("RGB"), (164, 148), color="white")
                photo = ImageTk.PhotoImage(thumbnail, master=self.window)
                self.photos.append(photo)
                ttk.Label(card, image=photo).pack(pady=4)
                ttk.Label(
                    card,
                    text=f"原图 {original_width}×{original_height} → 上传 {upload_width}×{upload_height}",
                    foreground="#555555", wraplength=170, justify="center",
                ).pack(fill="x", pady=(0, 3))
            except Exception as exc:
                errors.append(f"{entry.path.name}：{exc}")
                ttk.Label(card, text="缩略图读取失败", foreground="#b42318", width=22).pack(pady=45)
            ttk.Label(card, text=entry.path.name, wraplength=170, justify="center").pack(fill="x")
        if errors:
            self.checked.discard(index)
            self.error_var.set("无法核对图片，已阻止开始。请返回修正后重试。\n" + "\n".join(errors))
        else:
            self.current_ready = bool(entries) and len(self.photos) == len(entries)
        self.previous_button.configure(state="normal" if index else "disabled")
        self.ack_button.configure(
            state="normal" if self.current_ready else "disabled",
            text="已核对本商品" if index == len(self.samples) - 1 else "已核对本商品，下一款",
        )
        self._update_selector()
        self._update_confirm()
        self.canvas.yview_moveto(0)
        self.window.update_idletasks()
        self._resize_cards()

    def previous_sample(self) -> None:
        if self.current_index > 0:
            self.show_sample(self.current_index - 1)

    def acknowledge_current(self) -> None:
        if not self.current_ready:
            return
        self.checked.add(self.current_index)
        self._update_selector()
        self._update_confirm()
        if self.current_index + 1 < len(self.samples):
            self.show_sample(self.current_index + 1)

    def _update_confirm(self) -> None:
        ready = bool(self.samples) and self.current_ready and len(self.checked) == len(self.samples)
        self.confirm_button.configure(state="normal" if ready else "disabled")

    def confirm(self) -> None:
        if not self.samples or not self.current_ready or len(self.checked) != len(self.samples):
            return
        self.result = True
        self.window.destroy()

    def cancel(self) -> None:
        self.result = False
        self.window.destroy()


def confirm_image_order(parent: tk.Misc, jobs: Iterable[object], config: object) -> bool:
    """Return True only after the user reviews every sampled thumbnail group."""
    try:
        dialog = ImageOrderReviewDialog(parent, jobs, config)
        dialog.window.grab_set()
        parent.wait_window(dialog.window)
        return dialog.result
    except Exception as exc:
        messagebox.showerror("无法核对商品图", f"运行前的缩略图核对未完成，已取消开始。\n{exc}", parent=parent)
        return False
