"""Local thumbnail editor for interleaving product and reusable detail images.

All edits stay in the dialog until ``on_save`` succeeds.  Layouts carry item
tokens, never another product's file paths, so a batch layout cannot mix goods.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import tkinter as tk
from tkinter import messagebox, ttk
from typing import Callable

from PIL import Image, ImageOps, ImageTk

from mixed_image_order import ImageOrderItem, apply_order, trim_items


@dataclass
class MixedImageGroup:
    key: str
    layout_key: str
    label: str
    items: list[ImageOrderItem]
    base_items: list[ImageOrderItem]
    limit: int = 10


def _kind_label(item: ImageOrderItem) -> str:
    return "细节图" if "detail" in item.kind else "商品图"


class MixedImageOrderDialog:
    """Edit every candidate, including images omitted by the upload limit."""

    def __init__(self, parent: tk.Misc, groups: list[MixedImageGroup],
                 on_save: Callable[[dict[str, list[str]], dict[str, list[str]]], None]):
        if not groups:
            raise ValueError("没有可以混排的商品图片。")
        if len({group.key for group in groups}) != len(groups):
            raise ValueError("混排商品的标识重复，请重新扫描目录。")
        self.groups = [MixedImageGroup(group.key, group.layout_key, group.label,
                                      list(group.items), list(group.base_items), group.limit)
                       for group in groups]
        self.on_save = on_save
        self.items_by_key = {group.key: list(group.items) for group in self.groups}
        self.layouts: dict[str, list[str]] = {}
        self.current_index = 0
        self.selected_index = 0
        self.photos: list[ImageTk.PhotoImage] = []
        self.result = False
        self._closed = False
        self.window = tk.Toplevel(parent)
        self.window.title("商品图与细节图：合并排序")
        screen_width = self.window.winfo_screenwidth()
        screen_height = self.window.winfo_screenheight()
        width = min(1060, max(360, screen_width - 70))
        height = min(760, max(320, screen_height - 100))
        self.window.geometry(f"{width}x{height}+{max(0, (screen_width - width) // 2)}+"
                             f"{max(0, (screen_height - height - 35) // 2)}")
        self.window.minsize(min(640, width), min(420, height))
        self.window.transient(parent.winfo_toplevel())
        self.window.protocol("WM_DELETE_WINDOW", self.cancel)
        self.window.bind("<Escape>", lambda _event: self.cancel())
        outer = ttk.Frame(self.window, padding=12)
        outer.pack(fill="both", expand=True)
        self.explanation_label = ttk.Label(
            outer, text="商品图和细节图可以穿插排列，也可将细节图置首。第一张实际上传的图片就是商品主图。\n"
            "点击缩略图后调整；切换商品可单独设置。只有点击“保存排序”后才会生效。",
            justify="left", wraplength=width - 45)
        self.explanation_label.pack(fill="x")
        self.selector = ttk.Combobox(outer, state="readonly",
                                     values=[group.label for group in self.groups])
        self.selector.current(0)
        self.selector.pack(fill="x", pady=(8, 5))
        self.selector.bind("<<ComboboxSelected>>", lambda _event: self.select_group(self.selector.current()))
        self.summary_var = tk.StringVar(self.window)
        self.summary_label = ttk.Label(outer, textvariable=self.summary_var, foreground="#1658a0",
                                       justify="left", wraplength=width - 45)
        self.summary_label.pack(fill="x", pady=(0, 5))
        body = ttk.Frame(outer)
        body.pack(fill="both", expand=True)
        self.canvas = tk.Canvas(body, background="#f5f5f5", highlightthickness=0)
        self.canvas.pack(side="left", fill="both", expand=True)
        scrollbar = ttk.Scrollbar(body, orient="vertical", command=self.canvas.yview)
        scrollbar.pack(side="right", fill="y")
        self.canvas.configure(yscrollcommand=scrollbar.set)
        self.cards = ttk.Frame(self.canvas, padding=3)
        self.card_window = self.canvas.create_window((0, 0), window=self.cards, anchor="nw")
        self.cards.bind("<Configure>", lambda _event: self.canvas.configure(scrollregion=self.canvas.bbox("all")))
        self.canvas.bind("<Configure>", self._resize_cards)
        self.canvas.bind("<MouseWheel>", self._mousewheel)
        self.selection_var = tk.StringVar(self.window)
        self.path_var = tk.StringVar(self.window)
        ttk.Label(outer, textvariable=self.selection_var).pack(fill="x", pady=(5, 0))
        # The full selected path is copyable; equal basenames remain distinct.
        self.path_entry = ttk.Entry(outer, textvariable=self.path_var, state="readonly")
        self.path_entry.pack(fill="x", pady=(2, 6))
        controls = ttk.Frame(outer)
        controls.pack(fill="x")
        self.previous_button = ttk.Button(controls, text="前移", command=lambda: self.move_selected(-1))
        self.previous_button.pack(side="left")
        self.next_button = ttk.Button(controls, text="后移", command=lambda: self.move_selected(1))
        self.next_button.pack(side="left", padx=5)
        self.main_button = ttk.Button(controls, text="置首（设为主图）", command=self.move_to_first)
        self.main_button.pack(side="left")
        self.restore_button = ttk.Button(controls, text="恢复当前默认", command=self.restore_current_default)
        self.restore_button.pack(side="left", padx=5)
        footer = ttk.Frame(outer)
        footer.pack(fill="x", pady=(7, 0))
        self.apply_button = ttk.Button(footer, text="将当前混排方式应用到同类全部商品",
                                       command=self.apply_current_layout_to_all)
        self.apply_button.pack(side="left")
        self.save_button = ttk.Button(footer, text="保存排序", command=self.save)
        self.save_button.pack(side="right")
        self.cancel_button = ttk.Button(footer, text="取消", command=self.cancel)
        self.cancel_button.pack(side="right", padx=5)
        self._render()
        self.window.grab_set()

    @property
    def current_group(self) -> MixedImageGroup:
        return self.groups[self.current_index]

    @property
    def current_items(self) -> list[ImageOrderItem]:
        return self.items_by_key[self.current_group.key]

    def _mousewheel(self, event: tk.Event) -> str:
        self.canvas.yview_scroll(-int(event.delta / 120), "units")
        return "break"

    def _resize_cards(self, event: tk.Event | None = None) -> None:
        width = event.width if event is not None else self.canvas.winfo_width()
        self.canvas.itemconfigure(self.card_window, width=width)
        columns = max(1, min(5, (width - 6) // 178))
        for index, card in enumerate(self.cards.winfo_children()):
            card.grid(row=index // columns, column=index % columns, padx=4, pady=4, sticky="nsew")

    def _render(self) -> None:
        for child in self.cards.winfo_children():
            child.destroy()
        self.photos.clear()
        items = self.current_items
        self.selected_index = max(0, min(self.selected_index, len(items) - 1))
        uploaded = trim_items(items, self.current_group.limit)
        chosen = {item.token: index + 1 for index, item in enumerate(uploaded)}
        skipped = len(items) - len(uploaded)
        text = f"共 {len(items)} 张候选图，本次上传 {len(uploaded)} 张；第一张实际上传图为主图。"
        if skipped:
            text += f" 超出 {self.current_group.limit} 张上限时优先保留细节图，其余商品图按混排顺序选入；未选 {skipped} 张。"
        self.summary_var.set(text)
        for index, item in enumerate(items):
            position = chosen.get(item.token)
            selected = index == self.selected_index
            background = "white" if position else "#ededed"
            card = tk.Frame(self.cards, background=background, highlightthickness=2,
                            highlightbackground="#1658a0" if selected else "#d4d4d4")
            card.grid(row=index // 5, column=index % 5, padx=4, pady=4, sticky="nsew")
            role = _kind_label(item)
            status = f"上传第 {position} 张" if position else "上限未选"
            if position == 1:
                status += " · 主图"
            title = tk.Label(card, text=f"{index + 1}. {role}｜{status}", background=background,
                             foreground="#1658a0" if position == 1 else "#333333", wraplength=162)
            title.pack(padx=3, pady=(4, 2))
            try:
                with Image.open(item.path) as source:
                    thumbnail = ImageOps.exif_transpose(source).convert("RGBA")
                    thumbnail.thumbnail((152, 112))
                    composed = Image.new("RGBA", (152, 112), "white")
                    composed.alpha_composite(thumbnail, ((152 - thumbnail.width) // 2,
                                                         (112 - thumbnail.height) // 2))
                photo = ImageTk.PhotoImage(composed, master=self.window)
                self.photos.append(photo)
                picture = tk.Label(card, image=photo, background=background)
            except Exception:
                picture = tk.Label(card, text="缩略图读取失败\n请检查原文件", foreground="#b42318",
                                   background=background, width=20, height=6)
            picture.pack(pady=2)
            name = tk.Label(card, text=Path(item.path).name, wraplength=155, background=background)
            name.pack(padx=3, pady=(1, 4))
            for widget in (card, title, picture, name):
                widget.bind("<Button-1>", lambda _event, item_index=index: self.select(item_index))
                widget.bind("<MouseWheel>", self._mousewheel)
        self._update_selection()
        self.window.update_idletasks()
        self._resize_cards()

    def _update_selection(self) -> None:
        items = self.current_items
        if items:
            item = items[self.selected_index]
            self.selection_var.set(f"已选第 {self.selected_index + 1} 张 · {_kind_label(item)}：{Path(item.path).name}")
            self.path_var.set(str(item.path))
            self.path_entry.xview_moveto(0)
        else:
            self.selection_var.set("本商品暂无可排序图片。")
            self.path_var.set("")
        self.previous_button.configure(state="normal" if items and self.selected_index > 0 else "disabled")
        self.next_button.configure(state="normal" if items and self.selected_index < len(items) - 1 else "disabled")
        self.main_button.configure(state="normal" if items and self.selected_index > 0 else "disabled")
        self.apply_button.configure(state="normal" if items else "disabled")
        for index, card in enumerate(self.cards.winfo_children()):
            card.configure(highlightbackground="#1658a0" if index == self.selected_index else "#d4d4d4")

    def select(self, index: int) -> None:
        if 0 <= index < len(self.current_items):
            self.selected_index = index
            self._update_selection()

    def select_group(self, index: int) -> None:
        if 0 <= index < len(self.groups):
            self.current_index = index
            self.selected_index = 0
            self.selector.current(index)
            self.canvas.yview_moveto(0)
            self._render()

    def move_selected(self, delta: int) -> None:
        target = self.selected_index + delta
        if self.current_items and 0 <= target < len(self.current_items):
            item = self.current_items.pop(self.selected_index)
            self.current_items.insert(target, item)
            self.selected_index = target
            self._render()

    def move_to_first(self) -> None:
        if self.current_items and self.selected_index:
            item = self.current_items.pop(self.selected_index)
            self.current_items.insert(0, item)
            self.selected_index = 0
            self._render()
            self.canvas.yview_moveto(0)

    set_as_main = move_to_first

    def restore_current_default(self) -> None:
        self.items_by_key[self.current_group.key] = list(self.current_group.base_items)
        self.selected_index = 0
        self._render()
        self.canvas.yview_moveto(0)

    def apply_current_layout_to_all(self) -> None:
        tokens = [item.token for item in self.current_items]
        layout_key = self.current_group.layout_key
        self.layouts[layout_key] = list(tokens)
        for group in self.groups:
            if group.layout_key == layout_key:
                self.items_by_key[group.key] = apply_order(self.items_by_key[group.key], tokens)
        self._render()
        self.summary_var.set(self.summary_var.get() + " 已应用到同类全部商品，保存后生效。")

    def save(self) -> bool:
        orders = {key: [item.token for item in items] for key, items in self.items_by_key.items()}
        layouts = {key: list(tokens) for key, tokens in self.layouts.items()}
        try:
            outcome = self.on_save(orders, layouts)
        except Exception as exc:
            messagebox.showerror("排序未保存", str(exc), parent=self.window)
            return False
        if outcome is False:
            return False
        self.result = True
        self.cancel()
        return True

    def cancel(self) -> None:
        if not self._closed:
            self._closed = True
            self.window.destroy()
