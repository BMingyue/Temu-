"""Independent image lists and thumbnail ordering for white/black T-shirts.

No application module is imported here.  ``set_paths`` restores saved paths
without invoking callbacks or reading files: moved/missing saved files can still
be displayed and removed.  User additions and preview saves validate the entire
result before changing either color's list.
"""
from __future__ import annotations

import os
from pathlib import Path
import re
import tkinter as tk
from tkinter import filedialog, messagebox, ttk
from typing import Callable, Iterable

from PIL import Image, ImageOps, ImageTk


COLOR_LABELS = {"white": "白色", "black": "黑色"}
SUPPORTED_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp"}


def _unique_paths(paths: Iterable[str]) -> list[str]:
    result = []
    seen = set()
    for original in paths:
        normalized = str(Path(original).expanduser().resolve())
        key = os.path.normcase(normalized)
        if key not in seen:
            result.append(normalized)
            seen.add(key)
    return result


def _natural_key(path: str) -> tuple:
    # A type tag makes number/text segments comparable for all filenames.
    parts = tuple((1, int(part)) if part.isdigit() else (0, part.casefold())
                  for part in re.split(r"(\d+)", Path(path).name))
    return parts, os.path.normcase(path)


def _validate_paths(paths: Iterable[str], maximum: int, color: str) -> list[str]:
    values = _unique_paths(paths)
    if len(values) > maximum:
        raise ValueError(f"{COLOR_LABELS[color]}细节图最多 {maximum} 张，当前合计 {len(values)} 张。\n"
                         "本次添加未保存，请减少所选图片后重试。")
    for value in values:
        path = Path(value)
        if path.suffix.lower() not in SUPPORTED_SUFFIXES:
            raise ValueError(f"不支持的图片格式：{path.name}\n请选择 JPG、JPEG、PNG 或 WEBP 图片。")
        if not path.is_file():
            raise ValueError(f"找不到图片文件：\n{value}\n请重新选择图片。")
    return values


class ColorDetailPanel(ttk.Frame):
    """Two independent, append-only pickers with per-color ordering dialogs."""

    def __init__(self, parent: tk.Misc, white_paths: list[str], black_paths: list[str],
                 on_change: Callable[[str, list[str]], None], maximum: int = 9):
        super().__init__(parent)
        if not isinstance(maximum, int) or maximum < 0:
            raise ValueError("maximum must be a non-negative integer")
        self.maximum = maximum
        self.on_change = on_change
        self._paths: dict[str, list[str]] = {"white": [], "black": []}
        self.summary_vars: dict[str, tk.StringVar] = {}
        self.columnconfigure(1, weight=1)
        for row, color in enumerate(COLOR_LABELS):
            ttk.Label(self, text=f"{COLOR_LABELS[color]}细节图").grid(
                row=row, column=0, sticky="nw", padx=(0, 10), pady=3)
            summary = tk.StringVar(self)
            self.summary_vars[color] = summary
            ttk.Label(self, textvariable=summary, wraplength=400, justify="left").grid(
                row=row, column=1, sticky="w", padx=(0, 10), pady=3)
            actions = ttk.Frame(self)
            actions.grid(row=row, column=2, sticky="ne", pady=3)
            ttk.Button(actions, text="添加图片", command=lambda c=color: self.add_images(c)).pack(side="left")
            ttk.Button(actions, text="预览排序", command=lambda c=color: self.show_preview(c)).pack(side="left", padx=5)
            ttk.Button(actions, text="清空", command=lambda c=color: self.clear(c)).pack(side="left")
        self.set_paths("white", white_paths)
        self.set_paths("black", black_paths)

    @staticmethod
    def _check_color(color: str) -> None:
        if color not in COLOR_LABELS:
            raise ValueError(f"Unknown color: {color!r}")

    def get_paths(self, color: str) -> list[str]:
        self._check_color(color)
        return list(self._paths[color])

    def set_paths(self, color: str, paths: Iterable[str]) -> None:
        """Restore stored order; no callback, so loading config never saves it."""
        self._check_color(color)
        self._paths[color] = _unique_paths(paths)
        self._update_summary(color)

    def _update_summary(self, color: str) -> None:
        paths = self._paths[color]
        if not paths:
            self.summary_vars[color].set(f"未添加（本颜色最多 {self.maximum} 张）")
            return
        names = []
        for path in paths[:2]:
            name = Path(path).name
            names.append(name if len(name) <= 28 else name[:25] + "…")
        more = " 等" if len(paths) > 2 else ""
        self.summary_vars[color].set(f"已选 {len(paths)} 张：{'、'.join(names)}{more}")

    def _replace(self, color: str, paths: Iterable[str]) -> bool:
        """Atomically validate/update one color; send a detached list to caller."""
        self._check_color(color)
        try:
            values = _validate_paths(paths, self.maximum, color)
        except (ValueError, OSError) as exc:
            messagebox.showerror(f"{COLOR_LABELS[color]}细节图未修改", str(exc), parent=self.winfo_toplevel())
            return False
        if values != self._paths[color]:
            self._paths[color] = values
            self._update_summary(color)
            self.on_change(color, list(values))
        return True

    def add_images(self, color: str) -> None:
        self._check_color(color)
        options = dict(
            parent=self.winfo_toplevel(), title=f"添加{COLOR_LABELS[color]}细节图（可多次追加）",
            filetypes=[("图片", "*.jpg *.jpeg *.png *.webp"), ("所有文件", "*.*")],
        )
        if self._paths[color]:
            last_parent = Path(self._paths[color][-1]).parent
            if last_parent.is_dir():
                options["initialdir"] = str(last_parent)
        selected = filedialog.askopenfilenames(**options)
        if not selected:
            return
        try:
            # Preserve previously saved manual order; only this new batch sorts.
            additions = sorted(_unique_paths(selected), key=_natural_key)
        except (ValueError, OSError) as exc:
            messagebox.showerror("图片未添加", str(exc), parent=self.winfo_toplevel())
            return
        self._replace(color, self._paths[color] + additions)

    def clear(self, color: str) -> None:
        self._check_color(color)
        if self._paths[color]:
            self._replace(color, [])

    def show_preview(self, color: str) -> ColorDetailPreviewDialog | None:
        self._check_color(color)
        if not self._paths[color]:
            messagebox.showinfo("暂无细节图", f"请先添加{COLOR_LABELS[color]}细节图。", parent=self.winfo_toplevel())
            return None
        return ColorDetailPreviewDialog(self, color)


class ColorDetailPreviewDialog:
    """Thumbnail editor that commits order only when the user presses Save."""

    def __init__(self, panel: ColorDetailPanel, color: str):
        self.panel = panel
        self.color = color
        self.paths = panel.get_paths(color)
        self.selected_index = 0
        self.photos: list[ImageTk.PhotoImage] = []
        self.window = tk.Toplevel(panel)
        self.window.title(f"{COLOR_LABELS[color]}细节图：预览与排序")
        width = min(820, max(480, self.window.winfo_screenwidth() - 80))
        height = min(700, max(400, self.window.winfo_screenheight() - 100))
        self.window.geometry(f"{width}x{height}")
        self.window.transient(panel.winfo_toplevel())
        self.window.protocol("WM_DELETE_WINDOW", self.cancel)
        self.window.bind("<Escape>", lambda _event: self.cancel())
        outer = ttk.Frame(self.window, padding=12)
        outer.pack(fill="both", expand=True)
        ttk.Label(outer, text=f"这里只调整{COLOR_LABELS[color]}细节图的默认顺序；要与商品图穿插，请回主窗口使用“图片混合排序”。\n"
                  "点击缩略图，再使用前移、后移或移除。点击保存后生效。", justify="left").pack(anchor="w")
        body = ttk.Frame(outer)
        body.pack(fill="both", expand=True, pady=10)
        self.canvas = tk.Canvas(body, background="#f5f5f5", highlightthickness=0)
        self.canvas.pack(side="left", fill="both", expand=True)
        scrollbar = ttk.Scrollbar(body, orient="vertical", command=self.canvas.yview)
        scrollbar.pack(side="right", fill="y")
        self.canvas.configure(yscrollcommand=scrollbar.set)
        self.cards = ttk.Frame(self.canvas, padding=5)
        self.card_window = self.canvas.create_window((0, 0), window=self.cards, anchor="nw")
        self.cards.bind("<Configure>", lambda _event: self.canvas.configure(scrollregion=self.canvas.bbox("all")))
        self.canvas.bind("<Configure>", self._resize_cards)
        self.selection_var = tk.StringVar(self.window)
        ttk.Label(outer, textvariable=self.selection_var, wraplength=760).pack(anchor="w", pady=(0, 8))
        footer = ttk.Frame(outer)
        footer.pack(fill="x")
        self.previous_button = ttk.Button(footer, text="前移", command=lambda: self.move_selected(-1))
        self.previous_button.pack(side="left")
        self.next_button = ttk.Button(footer, text="后移", command=lambda: self.move_selected(1))
        self.next_button.pack(side="left", padx=5)
        self.remove_button = ttk.Button(footer, text="移除", command=self.remove_selected)
        self.remove_button.pack(side="left")
        ttk.Button(footer, text="保存排序", command=self.save).pack(side="right")
        ttk.Button(footer, text="取消", command=self.cancel).pack(side="right", padx=5)
        self._render()
        self.window.grab_set()

    def _resize_cards(self, event: tk.Event | None = None) -> None:
        width = event.width if event is not None else self.canvas.winfo_width()
        self.canvas.itemconfigure(self.card_window, width=width)
        columns = max(1, min(4, (width - 10) // 180))
        for index, card in enumerate(self.cards.winfo_children()):
            card.grid(row=index // columns, column=index % columns, padx=5, pady=5, sticky="nsew")

    def _render(self) -> None:
        for child in self.cards.winfo_children():
            child.destroy()
        self.photos.clear()
        for index, path in enumerate(self.paths):
            selected = index == self.selected_index
            card = tk.Frame(self.cards, background="white", highlightthickness=2,
                            highlightbackground="#1658a0" if selected else "#dddddd")
            card.grid(row=index // 4, column=index % 4, padx=5, pady=5, sticky="nsew")
            position = tk.Label(card, text=f"第 {index + 1} 张细节图", background="white")
            position.pack(pady=3)
            try:
                with Image.open(path) as image:
                    thumbnail = ImageOps.exif_transpose(image).convert("RGBA")
                    thumbnail.thumbnail((152, 120))
                    background = Image.new("RGBA", (152, 120), "white")
                    background.alpha_composite(thumbnail, ((152 - thumbnail.width) // 2,
                                                           (120 - thumbnail.height) // 2))
                photo = ImageTk.PhotoImage(background, master=self.window)
                self.photos.append(photo)
                picture = tk.Label(card, image=photo, background="white")
            except Exception:
                picture = tk.Label(card, text="缩略图读取失败\n可移除此图片", foreground="#b42318",
                                   background="white", width=20, height=7)
            picture.pack(pady=3)
            name = tk.Label(card, text=Path(path).name, wraplength=155, background="white")
            name.pack(padx=4, pady=(0, 5))
            for widget in (card, position, picture, name):
                widget.bind("<Button-1>", lambda _event, item=index: self.select(item))
        if self.paths:
            self.selection_var.set(f"已选第 {self.selected_index + 1} 张：{Path(self.paths[self.selected_index]).name}")
        else:
            self.selection_var.set("本颜色暂无细节图，保存后将清空。")
        self.previous_button.configure(state="normal" if self.paths and self.selected_index > 0 else "disabled")
        self.next_button.configure(state="normal" if self.paths and self.selected_index < len(self.paths) - 1 else "disabled")
        self.remove_button.configure(state="normal" if self.paths else "disabled")
        self.window.update_idletasks()
        self._resize_cards()

    def select(self, index: int) -> None:
        if 0 <= index < len(self.paths):
            self.selected_index = index
            self._render()

    def move_selected(self, delta: int) -> None:
        target = self.selected_index + delta
        if self.paths and 0 <= target < len(self.paths):
            self.paths[self.selected_index], self.paths[target] = self.paths[target], self.paths[self.selected_index]
            self.selected_index = target
            self._render()

    def remove_selected(self) -> None:
        if self.paths:
            self.paths.pop(self.selected_index)
            self.selected_index = max(0, min(self.selected_index, len(self.paths) - 1))
            self._render()

    def save(self) -> bool:
        if not self.panel._replace(self.color, self.paths):
            return False
        self.cancel()
        return True

    def cancel(self) -> None:
        self.window.destroy()
