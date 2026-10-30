"""Small, independent controls for optional album space cleanup.

This panel only edits settings.  It does not open the album, delete images,
save configuration, or show a confirmation dialog.
"""
from __future__ import annotations

import tkinter as tk
from tkinter import ttk


DEFAULT_THRESHOLD_MB = 100
THRESHOLD_PRESETS = (100, 200, 300, 500)
MIN_THRESHOLD_MB = 50
MAX_THRESHOLD_MB = 2000


class AlbumCleanupPanel(ttk.Frame):
    """Choose an explicit cleanup opt-in and a free-space threshold in MB."""

    def __init__(self, parent: tk.Misc, enabled: bool = False,
                 threshold_mb: int = DEFAULT_THRESHOLD_MB):
        super().__init__(parent)
        self.enabled_var = tk.BooleanVar(self, value=False)
        self.threshold_var = tk.StringVar(self)
        self._last_valid_threshold = DEFAULT_THRESHOLD_MB
        self.columnconfigure(0, weight=1)

        controls = ttk.Frame(self)
        controls.grid(row=0, column=0, sticky="w")
        self.enabled_input = ttk.Checkbutton(
            controls, text="图库空间不足时自动清理", variable=self.enabled_var,
        )
        self.enabled_input.pack(side="left")
        ttk.Label(controls, text="剩余空间低于").pack(side="left", padx=(16, 4))
        self.threshold_input = ttk.Spinbox(
            controls, textvariable=self.threshold_var, from_=MIN_THRESHOLD_MB,
            to=MAX_THRESHOLD_MB, values=THRESHOLD_PRESETS, width=6,
        )
        self.threshold_input.pack(side="left")
        ttk.Label(controls, text="MB 时触发").pack(side="left", padx=(4, 0))
        ttk.Label(
            self,
            text="每页300张，最多清理末两页；跳过锁定和本批次使用的图。开启后使用单工作页。",
            foreground="#555555", wraplength=810, justify="left",
        ).grid(row=1, column=0, sticky="w", pady=(3, 0))
        ttk.Label(
            self, text="删除不可恢复，可能影响待发布商品、在线商品及合规标签；请确认末页旧图可以删除后开启。",
            foreground="#a65a00", wraplength=810, justify="left",
        ).grid(row=2, column=0, sticky="w", pady=(1, 0))

        self.enabled_var.trace_add("write", self._render_enabled)
        self.set_settings(enabled, threshold_mb)

    def _render_enabled(self, *_args: str) -> None:
        self.threshold_input.configure(
            state="normal" if self.enabled_var.get() else "disabled",
        )

    @staticmethod
    def _parse_threshold(value: object) -> int:
        text = str(value).strip()
        if not text.isascii() or not text.isdecimal():
            raise ValueError("图库清理阈值请输入 50 到 2000 之间的整数（MB）。")
        threshold = int(text)
        if not MIN_THRESHOLD_MB <= threshold <= MAX_THRESHOLD_MB:
            raise ValueError("图库清理阈值请输入 50 到 2000 之间的整数（MB）。")
        return threshold

    def get_settings(self) -> tuple[bool, int]:
        """Return a validated snapshot without changing the displayed text.

        A disabled feature cannot be blocked by an unfinished or invalid input.
        Its saved threshold falls back to the last successfully validated value.
        """
        enabled = self.enabled_var.get()
        try:
            threshold = self._parse_threshold(self.threshold_var.get())
        except ValueError:
            if enabled:
                raise
            threshold = self._last_valid_threshold
        self._last_valid_threshold = threshold
        return enabled, threshold

    def set_settings(self, enabled: bool, threshold_mb: int) -> None:
        """Restore settings atomically; unused invalid threshold text is kept."""
        if not isinstance(enabled, bool):
            raise ValueError("图库自动清理开关必须为开启或关闭。")
        try:
            valid_threshold = self._parse_threshold(threshold_mb)
        except ValueError:
            if enabled:
                raise
            valid_threshold = self._last_valid_threshold
        self.threshold_var.set(str(threshold_mb))
        self._last_valid_threshold = valid_threshold
        self.enabled_var.set(enabled)
