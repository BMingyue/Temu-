"""Compact controls for choosing whether and how upload images are resized."""
from __future__ import annotations

import tkinter as tk
from tkinter import ttk

from image_processing import ImageProcessingOptions, validate_options


MODE_LABELS = {
    "original": "保留原图（不处理）",
    "fit": "按比例缩小",
    "square": "填充到指定尺寸",
}
MODE_NOTES = {
    "original": "直接上传原文件，不转换 JPG、不改变尺寸或比例；上传后店小秘可能另行处理图片。",
    "fit": "只把大图按比例缩小到最长边，不放大小图、不补白，并转 JPG；保留原来的比例。",
    "square": "按比例适应指定尺寸，空白处填充白边，不裁剪，并转 JPG；旧版默认是 1200 × 1200。",
}
SIZE_PRESETS = (800, 1200, 1600)


class ImageProcessingPanel(ttk.Frame):
    """Edit an image policy without saving settings or touching source files.

    The mode variable contains the stable option value (``original``/``fit``/
    ``square``), while the read-only selector displays its Chinese label.
    Switching modes retains the three dimension values for later use.
    """

    def __init__(self, parent: tk.Misc, options: ImageProcessingOptions):
        super().__init__(parent)
        self.mode_var = tk.StringVar(self)
        self.width_var = tk.StringVar(self)
        self.height_var = tk.StringVar(self)
        self.max_edge_var = tk.StringVar(self)
        self._mode_label_var = tk.StringVar(self)
        self.note_var = tk.StringVar(self)
        self._last_valid_sizes = {"width": 1200, "height": 1200, "max_edge": 1200}
        self.columnconfigure(0, weight=1)

        controls = ttk.Frame(self)
        controls.grid(row=0, column=0, sticky="w")
        ttk.Label(controls, text="图片处理").pack(side="left", padx=(0, 10))
        self.mode_selector = ttk.Combobox(
            controls, textvariable=self._mode_label_var, state="readonly",
            values=tuple(MODE_LABELS.values()), width=22,
        )
        self.mode_selector.pack(side="left")
        self.mode_selector.bind("<<ComboboxSelected>>", self._select_mode)

        self.fit_controls = ttk.Frame(controls)
        ttk.Label(self.fit_controls, text="最长边").pack(side="left", padx=(12, 4))
        self.max_edge_input = self._size_input(self.fit_controls, self.max_edge_var)
        self.max_edge_input.pack(side="left")
        ttk.Label(self.fit_controls, text="像素").pack(side="left", padx=(4, 0))

        self.square_controls = ttk.Frame(controls)
        ttk.Label(self.square_controls, text="宽").pack(side="left", padx=(12, 4))
        self.width_input = self._size_input(self.square_controls, self.width_var)
        self.width_input.pack(side="left")
        ttk.Label(self.square_controls, text="× 高").pack(side="left", padx=4)
        self.height_input = self._size_input(self.square_controls, self.height_var)
        self.height_input.pack(side="left")
        ttk.Label(self.square_controls, text="像素").pack(side="left", padx=(4, 0))

        ttk.Label(
            self, textvariable=self.note_var, foreground="#555555",
            wraplength=810, justify="left",
        ).grid(row=1, column=0, sticky="w", pady=(4, 0))
        self.mode_var.trace_add("write", self._render_mode)
        self.set_options(options)

    @staticmethod
    def _size_input(parent: tk.Misc, variable: tk.StringVar) -> ttk.Spinbox:
        # Presets are editable: users can also type any integer from 200 to 4000.
        return ttk.Spinbox(
            parent, textvariable=variable, from_=200, to=4000,
            values=SIZE_PRESETS, width=6,
        )

    def _select_mode(self, _event: tk.Event | None = None) -> None:
        label = self._mode_label_var.get()
        for mode, known_label in MODE_LABELS.items():
            if label == known_label:
                self.mode_var.set(mode)
                return
        raise ValueError("请选择有效的图片处理方式。")

    def _render_mode(self, *_args: str) -> None:
        mode = self.mode_var.get()
        self.fit_controls.pack_forget()
        self.square_controls.pack_forget()
        if mode == "fit":
            self.fit_controls.pack(side="left")
        elif mode == "square":
            self.square_controls.pack(side="left")
        if mode in MODE_LABELS:
            self._mode_label_var.set(MODE_LABELS[mode])
            self.note_var.set(MODE_NOTES[mode])
        else:
            self._mode_label_var.set("")
            self.note_var.set("请选择图片处理方式。")

    @staticmethod
    def _parse_size(value: str, label: str) -> int:
        # Avoid silently rounding floats or accepting scientific notation.
        text = value.strip()
        if not text.isascii() or not text.isdecimal():
            raise ValueError(f"{label}请输入 200 到 4000 之间的整数像素。")
        result = int(text)
        if not 200 <= result <= 4000:
            raise ValueError(f"{label}请输入 200 到 4000 之间的整数像素。")
        return result

    def get_options(self) -> ImageProcessingOptions:
        """Return a validated, detached snapshot; do not persist anything."""
        mode = self.mode_var.get()
        active_fields = {"width", "height"} if mode == "square" else {"max_edge"} if mode == "fit" else set()
        sizes = {}
        for name, variable, label in (
            ("width", self.width_var, "图片宽度"),
            ("height", self.height_var, "图片高度"),
            ("max_edge", self.max_edge_var, "图片最长边"),
        ):
            try:
                sizes[name] = self._parse_size(variable.get(), label)
            except ValueError:
                if name in active_fields:
                    raise
                sizes[name] = self._last_valid_sizes[name]
        options = ImageProcessingOptions(
            mode=mode, **sizes,
        )
        validated = validate_options(options)
        self._last_valid_sizes.update(sizes)
        return validated

    def set_options(self, options: ImageProcessingOptions) -> None:
        """Restore all dimensions and the selected mode without callbacks."""
        validated = validate_options(options)
        # Validate before mutation, so an invalid restore never half-applies.
        self.width_var.set(str(validated.width))
        self.height_var.set(str(validated.height))
        self.max_edge_var.set(str(validated.max_edge))
        for name, value in (("width", validated.width), ("height", validated.height),
                            ("max_edge", validated.max_edge)):
            try:
                self._last_valid_sizes[name] = self._parse_size(str(value), "图片尺寸")
            except ValueError:
                # An unused saved field may be invalid; it must not block original.
                pass
        self.mode_var.set(validated.mode)
