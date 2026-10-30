from __future__ import annotations

import json
from copy import deepcopy
import multiprocessing
import os
import queue
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
import traceback
import uuid
import unicodedata
import urllib.request
from urllib.parse import parse_qs, urlsplit
from collections import Counter
from dataclasses import asdict, dataclass, field, replace
from datetime import datetime, timedelta
from pathlib import Path
from typing import Callable, Iterable, Optional

import tkinter as tk
from tkinter import filedialog, messagebox, ttk

from failure_records import FailureRecord, FailureStore, folder_key, needs_submission_review, record_matches_batch
from listing_profiles import ArticleNumberStore, normalize_template_url, validate_article_name
from preflight_review import confirm_image_order
from image_processing import (
    ImageProcessingOptions, describe_options, options_from_config, prepared_upload_path,
)
from mixed_image_order import make_items, ordered_items, order_key, layout_key, trim_items

try:
    from PIL import Image as PILImage
    from PIL import ImageOps, ImageTk
except ImportError:  # The launcher repairs this dependency before normal use.
    PILImage = None
    ImageOps = None
    ImageTk = None


APP_DIR = Path(os.environ.get("DXM_STANDALONE_DATA", Path(__file__).resolve().parent))
CONFIG_PATH = APP_DIR / "config.json"
STATE_PATH = APP_DIR / "state.json"
PROFILE_DIR = APP_DIR / "browser-profile"
LOG_DIR = APP_DIR / "logs"
FAILURE_DIR = APP_DIR / "failure-records"
UPLOAD_STAGE_DIR = APP_DIR / "upload-staging"
BW_TEMPLATE_URL = "https://www.dianxiaomi.com/web/popTemu/quoteEdit?id=220114595107742054"
TEMU_TITLE_MAX_LENGTH = 250
TITLE_RULE_VERSION = 2
MAX_JOB_ATTEMPTS = 2
RETRY_PROMPT_TIMEOUT_SECONDS = 120
TEMU_TITLE_SAFE_PUNCTUATION = ".,'&()-"
SUPPORTED_IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}
CAROUSEL_IMAGE_SIZE = 1200
CAROUSEL_UPLOAD_READY_SECONDS = 180


def natural_key(value: str) -> list[tuple[int, object]]:
    return [
        (0, int(part)) if part.isdigit() else (1, part.casefold())
        for part in re.split(r"(\d+)", value)
    ]


def sanitize_temu_title(raw_title: str, max_length: int = TEMU_TITLE_MAX_LENGTH) -> str:
    """Build a Temu title while retaining common, platform-safe English punctuation."""
    text = str(raw_title).strip()
    # Some collector folders end in an internal eight-character hash. It is not product copy.
    text = re.sub(r"(?:[_\-\s]+)[0-9a-fA-F]{8}$", "", text).strip()
    text = text.translate(
        str.maketrans(
            {
                "‘": "'",
                "’": "'",
                "‛": "'",
                "，": ",",
                "。": ".",
                "．": ".",
                "‐": "-",
                "‑": "-",
                "‒": "-",
                "–": "-",
                "—": "-",
                "−": "-",
                "＆": "&",
                "（": "(",
                "）": ")",
            }
        )
    )
    # Remove unsafe punctuation/symbols before compatibility normalization so ™ does not
    # unexpectedly become "TM". Common listing punctuation is deliberately retained.
    text = "".join(
        char
        if char in TEMU_TITLE_SAFE_PUNCTUATION
        else " "
        if unicodedata.category(char)[:1] in {"P", "S"}
        else char
        for char in text
    )
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode("ascii")
    text = re.sub(r"[^A-Za-z0-9 .,'&()\-]+", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    text = re.sub(r"\s+([,.)])", r"\1", text)
    text = re.sub(r"([(])\s+", r"\1", text)
    text = text.lstrip(" .,'&)-").rstrip(" .,'&(-")
    if len(text) > max_length:
        clipped = text[: max_length + 1]
        text = clipped[:max_length] if clipped[max_length:max_length + 1] == " " else clipped.rsplit(" ", 1)[0]
        text = text.lstrip(" .,'&)-").rstrip(" .,'&(-")
    if not text:
        raise ValueError("文件夹名清洗后没有可用的英文字母或数字，无法生成商品标题。")
    if not re.fullmatch(r"[A-Za-z0-9 .,'&()\-]+", text):
        raise ValueError("商品标题仍含非法字符，已阻止提交。")
    return text


def count_square_dimensions(text: str, size: int = 1200) -> int:
    return len(re.findall(rf"{size}\s*[xX×]\s*{size}", text))


def image_dimensions(text: str) -> list[tuple[int, int]]:
    """Return pixel dimensions rendered by Dianxiaomi image cards."""
    return [
        (int(width), int(height))
        for width, height in re.findall(r"(\d+)\s*[xX×]\s*(\d+)", str(text))
    ]


def prepare_carousel_jpg(source: Path, target: Path, size: int = CAROUSEL_IMAGE_SIZE,
                         *, options: ImageProcessingOptions | None = None) -> Path:
    """Keep the legacy default while allowing the selected upload policy."""
    return prepared_upload_path(source, target, options or ImageProcessingOptions(width=size, height=size))


def is_batch_submission_mode(mode: str) -> bool:
    return mode in {"publish", "schedule"}


def should_offer_retry(attempt_number: int) -> bool:
    """Each product may be attempted once initially and retried only once."""
    return 1 <= attempt_number < MAX_JOB_ATTEMPTS


def is_blocking_scan_warning(message: str) -> bool:
    return str(message).startswith("未纳入：")


def is_image_count_warning(message: str) -> bool:
    return str(message).startswith("图片数量预警：")


def image_count_warnings(folder_counts: list[tuple[str, int]]) -> list[str]:
    """Compare original product images, before shared details and upload limits."""
    distribution = Counter(count for _, count in folder_counts)
    if len(distribution) < 2:
        return []
    summary = "、".join(f"{count} 张 × {frequency} 个文件夹" for count, frequency in sorted(distribution.items()))
    largest_group = max(distribution.values())
    modes = [count for count, frequency in distribution.items() if frequency == largest_group]
    if len(modes) == 1:
        typical_count = modes[0]
        affected = [(name, count) for name, count in folder_counts if count != typical_count]
        header = f"图片数量预警：本批次通常每款 {typical_count} 张商品图（{summary}）；以下文件夹数量不同。"
    else:
        affected = folder_counts
        header = f"图片数量预警：本批次商品图数量不一致（{summary}），没有唯一的常见数量，请核对。"
    return [header, *(f"图片数量预警：{name}（{count} 张商品图）" for name, count in affected)]


def summarize_scan(jobs: Iterable[ProductJob], warnings: Iterable[str]) -> tuple[int, int, int]:
    job_count = sum(1 for _ in jobs)
    blocked_count = sum(1 for warning in warnings if is_blocking_scan_warning(warning))
    return job_count + blocked_count, job_count, blocked_count


def classify_publish_feedback(messages: Iterable[str]) -> tuple[str, str]:
    """Classify transient publish feedback captured from the page."""
    accepted_pattern = re.compile(
        r"(?:产品)?(?:已提交(?:定时)?(?:发布|刊登)|已移入定时发布)",
        re.IGNORECASE,
    )
    success_pattern = re.compile(
        r"(?:发布|刊登|提交|创建|上架|操作).{0,16}(?:成功|完成)|"
        r"(?:成功|完成).{0,16}(?:发布|刊登|提交|创建|上架)",
        re.IGNORECASE,
    )
    error_pattern = re.compile(
        r"(?:发布|刊登|提交|创建|上架|操作).{0,16}(?:失败|错误|异常)|"
        r"(?:失败|错误|异常).{0,16}(?:发布|刊登|提交|创建|上架)|"
        r"不能为空|必填|请完善|请填写|不符合|不能小于|不能大于|图片尺寸|"
        r"超出.{0,8}(?:限制|范围)|网络异常|系统异常|(?:错误|失败)[：:]",
        re.IGNORECASE,
    )
    for raw_message in messages:
        message = re.sub(r"\s+", " ", str(raw_message)).strip()
        if not message:
            continue
        # 店小秘的成功弹窗同时包含菜单名称“发布失败”，所以先识别已提交原文。
        if accepted_pattern.search(message):
            return "success", message[:240]
        if error_pattern.search(message):
            return "error", message[:240]
        if success_pattern.search(message):
            return "success", message[:240]
    return "pending", ""


def extended_windows_path(path: Path) -> Path:
    raw = str(path.resolve())
    if os.name == "nt" and not raw.startswith("\\\\?\\"):
        return Path("\\\\?\\" + raw)
    return path


def normal_windows_path(path: Path) -> Path:
    """Remove the Win32 extended prefix while retaining the same filesystem target."""
    raw = str(path)
    if os.name == "nt" and raw.startswith("\\\\?\\UNC\\"):
        return Path("\\\\" + raw[8:])
    if os.name == "nt" and raw.startswith("\\\\?\\"):
        return Path(raw[4:])
    return path


@dataclass
class ProductJob:
    folder: Path
    title: str
    images: list[Path]
    common_detail_count: int = 0
    color_image_sets: dict[str, list[Path]] = field(default_factory=dict)
    detail_image_paths: list[Path] = field(default_factory=list)

    @property
    def listing_title(self) -> str:
        return sanitize_temu_title(self.title)


@dataclass
class JobFailure:
    title: str
    reason: str
    evidence_dir: Path
    product_folder: Optional[Path] = None


@dataclass
class RunReport:
    attempted: int
    succeeded: int
    failures: list[JobFailure]
    already_completed: int = 0
    report_path: Optional[Path] = None
    blocked_reason: str = ""
    pending_count: int = 0
    blocked_category: str = "template"

    @property
    def has_failures(self) -> bool:
        return bool(self.failures)

    def render(self, max_failures: Optional[int] = None) -> str:
        lines = [
            ("批次已停止：请先处理图库空间后重新运行" if self.blocked_category == "album"
             else "批次已停止：请先修正模板后重新运行") if self.blocked_reason else "本次运行结束",
            f"成功完成：{self.succeeded}",
            f"遇到问题并跳过：{len(self.failures)}",
        ]
        if self.blocked_reason:
            lines.extend([
                f"{'图库空间问题' if self.blocked_category == 'album' else '模板问题'}：{self.blocked_reason}",
                f"保留待处理：{self.pending_count}（未提交，不计为商品失败）",
                "已完成记录保留；处理问题后重新开始即可，不要清除完成记录。",
            ])
        if self.already_completed:
            lines.append(f"根据完成记录跳过：{self.already_completed}")
        shown = self.failures if max_failures is None else self.failures[:max_failures]
        if shown:
            lines.append("")
            lines.append("问题明细：")
            for index, failure in enumerate(shown, start=1):
                lines.append(f"{index}. {failure.title}")
                lines.append(f"   原因：{failure.reason}")
                if failure.product_folder is not None:
                    lines.append(f"   商品文件夹：{failure.product_folder.resolve()}")
                lines.append(f"   现场：{failure.evidence_dir}")
        if max_failures is not None and len(self.failures) > len(shown):
            lines.append(f"……其余 {len(self.failures) - len(shown)} 项请查看汇总文件。")
        if self.report_path is not None:
            lines.append("")
            lines.append(f"完整汇总：{self.report_path}")
        return "\n".join(lines)


def merge_recovery_report(initial: RunReport, recovery: RunReport) -> RunReport:
    """Create the user-facing final result after one failed-only recovery pass."""
    return RunReport(
        attempted=initial.attempted,
        succeeded=initial.succeeded + recovery.succeeded,
        failures=list(recovery.failures),
        already_completed=initial.already_completed,
        report_path=recovery.report_path,
        blocked_reason=recovery.blocked_reason,
        pending_count=recovery.pending_count,
        blocked_category=recovery.blocked_category,
    )


@dataclass
class AppConfig:
    template_url: str = ""
    listing_profile: str = "blanket"
    article_name: str = ""
    bw_first_color: str = "white"
    description_mode: str = "replace"
    product_root: str = ""
    publish_mode: str = "review"
    variant_count: int = 4
    min_images: int = 1
    max_images: int = 10
    upload_wait_seconds: int = 25
    operation_timeout_seconds: int = 45
    login_wait_minutes: int = 15
    browser_path: str = ""
    schedule_hour: int = 10
    schedule_minute: int = 0
    common_detail_images: list[str] = field(default_factory=list)
    white_detail_images: list[str] = field(default_factory=list)
    black_detail_images: list[str] = field(default_factory=list)
    image_processing_mode: str = "square"
    image_target_width: int = 1200
    image_target_height: int = 1200
    image_max_edge: int = 1200
    product_image_orders: dict[str, list[str]] = field(default_factory=dict)
    combined_image_orders: dict[str, list[str]] = field(default_factory=dict)
    combined_image_layouts: dict[str, list[str]] = field(default_factory=dict)
    concurrent_pages: int = 1
    album_cleanup_enabled: bool = False
    album_cleanup_threshold_mb: int = 100
    album_cleanup_batch_id: str = ""

    @classmethod
    def load(cls) -> "AppConfig":
        if not CONFIG_PATH.exists():
            return cls()
        raw = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        allowed = {field for field in cls.__dataclass_fields__}
        config = cls(**{key: value for key, value in raw.items() if key in allowed})
        config.min_images = 1  # Older releases saved 3; one image is now valid.
        config.template_url = normalize_template_url(config.template_url)
        return config

    def save(self) -> None:
        options_from_config(self)
        validate_album_config(self)
        self.min_images = 1
        self.template_url = normalize_template_url(self.template_url)
        CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
        temporary = CONFIG_PATH.with_suffix(".json.tmp")
        temporary.write_text(json.dumps(asdict(self), ensure_ascii=False, indent=2), encoding="utf-8")
        temporary.replace(CONFIG_PATH)


def _path_identity(path: Path) -> str:
    return os.path.normcase(str(normal_windows_path(path).resolve()))


def validate_album_config(config: AppConfig) -> None:
    if not isinstance(config.album_cleanup_enabled, bool):
        raise ValueError("图库自动清理开关无效。")
    value = config.album_cleanup_threshold_mb
    if isinstance(value, bool) or not isinstance(value, int) or not 50 <= value <= 2000:
        raise ValueError("图库清理阈值请输入50至2000之间的整数MB。")
    if not isinstance(config.album_cleanup_batch_id, str) or (config.album_cleanup_batch_id and not re.fullmatch(r"[a-f0-9]{32}", config.album_cleanup_batch_id)):
        raise ValueError("图库清理批次记录无效，请重新开始任务。")


def effective_concurrent_pages(config: AppConfig) -> int:
    return 1 if config.album_cleanup_enabled else max(1, min(3, int(config.concurrent_pages)))


def _bw_template_identity(config: AppConfig) -> str:
    url = normalize_template_url(config.template_url)
    return parse_qs(urlsplit(url).query).get("id", ["unconfigured"])[0]


def completion_state_path(config: AppConfig) -> Path:
    if config.listing_profile == "tshirt_bw":
        return STATE_PATH.with_name(f"state-tshirt-bw-{_bw_template_identity(config)}.json")
    return STATE_PATH


def failure_record_directory(config: AppConfig) -> Path:
    if config.listing_profile == "tshirt_bw":
        return FAILURE_DIR.with_name(f"failure-records-tshirt-bw-{_bw_template_identity(config)}")
    return FAILURE_DIR


def pending_jobs_for_run(config: AppConfig, jobs: list[ProductJob], *, strict: bool = False,
                         review_count: int = 1, state=None) -> list[ProductJob]:
    state = state if state is not None else StateStore(completion_state_path(config))
    pending = [job for job in jobs if not state.is_completed(job, strict=strict)]
    if not is_batch_submission_mode(config.publish_mode):
        pending = pending[:max(1, review_count)]
    return pending


def apply_product_image_order(
    folder: Path,
    images: Iterable[Path],
    config: AppConfig,
) -> list[Path]:
    """Apply a saved per-product filename order and naturally append new images."""
    natural_images = sorted(
        (normal_windows_path(Path(path)) for path in images),
        key=lambda path: natural_key(path.name),
    )
    raw_orders = config.product_image_orders
    if not isinstance(raw_orders, dict):
        return natural_images
    saved_names = raw_orders.get(_path_identity(folder), [])
    if not isinstance(saved_names, (list, tuple)):
        return natural_images

    by_name = {path.name.casefold(): path for path in natural_images}
    ordered: list[Path] = []
    seen: set[str] = set()
    for raw_name in saved_names:
        name = Path(str(raw_name)).name.casefold()
        image = by_name.get(name)
        if image is None or name in seen:
            continue
        seen.add(name)
        ordered.append(image)
    ordered.extend(path for path in natural_images if path.name.casefold() not in seen)
    return ordered


def compose_upload_images(
    product_images: Iterable[Path],
    common_detail_images: Iterable[Path],
    max_images: Optional[int] = None,
) -> list[Path]:
    """Keep all product images first and append shared detail images as the final group."""
    products = [normal_windows_path(Path(path)) for path in product_images]
    if not products:
        return []

    main_image = products[0]
    main_identity = _path_identity(main_image)
    details: list[Path] = []
    detail_identities: set[str] = set()
    for raw_path in common_detail_images:
        path = normal_windows_path(Path(raw_path))
        identity = _path_identity(path)
        if identity == main_identity or identity in detail_identities:
            continue
        detail_identities.add(identity)
        details.append(path)

    product_group: list[Path] = []
    seen: set[str] = set()
    for raw_path in products:
        path = normal_windows_path(Path(raw_path))
        identity = _path_identity(path)
        if identity in seen or (identity in detail_identities and identity != main_identity):
            continue
        seen.add(identity)
        product_group.append(path)
    if max_images is not None:
        limit = max(1, int(max_images))
        product_capacity = max(1, limit - len(details))
        product_group = product_group[:product_capacity]
        details = details[: max(0, limit - len(product_group))]
    return [*product_group, *details]


def load_common_detail_images(config: AppConfig) -> list[Path]:
    raw_paths = config.common_detail_images
    if not isinstance(raw_paths, (list, tuple)):
        raise ValueError("通用细节图配置无效，请重新选择图片。")

    selected: list[Path] = []
    seen: set[str] = set()
    invalid: list[str] = []
    for raw_path in raw_paths:
        path = normal_windows_path(Path(str(raw_path)).expanduser())
        readable = extended_windows_path(path)
        if not readable.is_file() or path.suffix.casefold() not in SUPPORTED_IMAGE_EXTENSIONS:
            invalid.append(str(path))
            continue
        identity = _path_identity(path)
        if identity in seen:
            continue
        seen.add(identity)
        selected.append(path)

    if invalid:
        preview = "\n".join(f"- {path}" for path in invalid[:5])
        suffix = f"\n另有 {len(invalid) - 5} 张未显示。" if len(invalid) > 5 else ""
        raise ValueError(
            "以下通用细节图已不存在或格式不支持，请重新选择：\n"
            f"{preview}{suffix}"
        )
    maximum_details = max(0, int(config.max_images) - 1)
    if len(selected) > maximum_details:
        raise ValueError(
            f"最多只能选择 {maximum_details} 张通用细节图，"
            f"因为还必须为每个商品保留第 1 张主图。当前选择了 {len(selected)} 张。"
        )
    return selected


def load_color_detail_images(config: AppConfig) -> dict[str, list[Path]]:
    groups = {}
    for color, label, paths in (("white", "白色", config.white_detail_images),
                                ("black", "黑色", config.black_detail_images)):
        try:
            groups[color] = load_common_detail_images(replace(config, common_detail_images=paths))
        except ValueError as exc:
            raise ValueError(f"{label}细节图：{exc}") from exc
    return groups


def detail_images_for_scanning(config: AppConfig) -> list[Path]:
    if config.listing_profile == "tshirt_bw":
        groups = load_color_detail_images(config)
        return list(dict.fromkeys([*groups["white"], *groups["black"]]))
    return load_common_detail_images(config)


def mixed_upload_items(config: AppConfig, folder: Path, products: list[Path],
                       details: list[Path], channel: str = "all", *, limit: bool = True):
    items = make_items(products, details)
    items = ordered_items(config, folder, channel, items)
    return trim_items(items, config.max_images) if limit else items


def ordinary_mixed_sources(images: list[Path], details: list[Path]):
    combined = compose_upload_images(images, details)
    if not combined:
        return [], []
    detail_ids = {_path_identity(path) for path in details}
    products = [path for index, path in enumerate(combined)
                if index == 0 or _path_identity(path) not in detail_ids]
    selected_details = [path for path in combined if _path_identity(path) in detail_ids
                        and _path_identity(path) != _path_identity(products[0])]
    return products, selected_details


def scan_product_folders(config: AppConfig) -> tuple[list[ProductJob], list[str]]:
    root = Path(config.product_root).expanduser()
    readable_root = extended_windows_path(root)
    if not readable_root.is_dir():
        raise ValueError("请选择存在的商品图片总目录。")

    common_detail_images = detail_images_for_scanning(config)
    color_details = load_color_detail_images(config) if config.listing_profile == "tshirt_bw" else {}
    jobs: list[ProductJob] = []
    blocking_warnings: list[str] = []
    notices: list[str] = []
    folder_counts: list[tuple[str, int]] = []
    direct_images = [
        normal_windows_path(path)
        for path in readable_root.iterdir()
        if path.is_file() and path.suffix.casefold() in SUPPORTED_IMAGE_EXTENSIONS
    ]
    child_folders = sorted(
        (normal_windows_path(path) for path in readable_root.iterdir() if path.is_dir()),
        key=lambda p: natural_key(p.name),
    )
    common_detail_identities = {_path_identity(path) for path in common_detail_images}
    common_only_folders: set[str] = set()
    for folder in child_folders:
        folder_images = [
            normal_windows_path(path)
            for path in extended_windows_path(folder).iterdir()
            if path.is_file() and path.suffix.casefold() in SUPPORTED_IMAGE_EXTENSIONS
        ]
        if folder_images and all(
            _path_identity(path) in common_detail_identities for path in folder_images
        ):
            common_only_folders.add(_path_identity(folder))
    child_folders_with_images = [
        folder
        for folder in child_folders
        if _path_identity(folder) not in common_only_folders
        if any(
            path.is_file() and path.suffix.casefold() in SUPPORTED_IMAGE_EXTENSIONS
            for path in extended_windows_path(folder).iterdir()
        )
    ]
    # 既可选择一个商品的图片文件夹，也可选择包含多个商品文件夹的总目录。
    # 总目录中常会混入下载的散图；只要一级子文件夹里存在商品图片，就应优先按批量目录扫描。
    if child_folders_with_images:
        folders = [
            folder
            for folder in child_folders
            if _path_identity(folder) not in common_only_folders
        ]
        if direct_images:
            notices.append(
                f"检测到 {len(child_folders_with_images)} 个一级商品文件夹；"
                f"已忽略总目录根部的 {len(direct_images)} 张散图。"
            )
    elif direct_images:
        folders = [root]
        notices.append("已识别为单商品目录，本次只处理当前文件夹。")
    else:
        folders = [
            folder
            for folder in child_folders
            if _path_identity(folder) not in common_only_folders
        ]

    if common_only_folders:
        notices.append(
            f"已识别并跳过 {len(common_only_folders)} 个仅存放所选通用细节图的文件夹。"
        )

    for folder in folders:
        readable_folder = extended_windows_path(folder)
        images = apply_product_image_order(
            folder,
            (
                path
                for path in readable_folder.iterdir()
                if path.is_file() and path.suffix.casefold() in SUPPORTED_IMAGE_EXTENSIONS
            ),
            config,
        )
        if not images:
            blocking_warnings.append(f"未纳入：{folder.name}（空文件夹，没有可用图片）")
            continue
        try:
            listing_title = sanitize_temu_title(folder.name)
        except ValueError as exc:
            blocking_warnings.append(f"未纳入：{folder.name}（{exc}）")
            continue
        product_image_count = sum(_path_identity(path) not in common_detail_identities for path in images)
        folder_counts.append((folder.name, product_image_count))
        if config.listing_profile == "tshirt_bw":
            original_images = [path for path in images if _path_identity(path) not in common_detail_identities]
            if len(original_images) != 2:
                blocking_warnings.append(
                    f"未纳入：{folder.name}（黑白T恤需恰好 2 张商品图，当前 {len(original_images)} 张；"
                    "白色和黑色各一张，通用细节图另行添加）"
                )
                continue
            if config.bw_first_color not in {"white", "black"}:
                raise ValueError("黑白图片顺序无效，请选择第1张白色或第1张黑色。")
            first, second = ("white", "black") if config.bw_first_color == "white" else ("black", "white")
            color_image_sets = {
                color: [item.path for item in mixed_upload_items(config, folder, [source], color_details[color], color)]
                for color, source in ((first, original_images[0]), (second, original_images[1]))
            }
            jobs.append(ProductJob(folder=folder, title=folder.name,
                                   images=original_images, color_image_sets=color_image_sets))
            if not color_details["white"] or not color_details["black"]:
                notices.append(f"{folder.name}：白色细节图 {len(color_details['white'])} 张，黑色细节图 {len(color_details['black'])} 张；"
                               "未配置的颜色仅上传对应主图，旧版通用细节图不用于黑白模式。")
            if listing_title != folder.name:
                notices.append(f"标题已安全清洗：{folder.name} → {listing_title}")
            continue
        combined_images = compose_upload_images(images, common_detail_images)
        common_identities = {_path_identity(path) for path in common_detail_images}
        common_detail_count = sum(
            1
            for path in combined_images[1:]
            if _path_identity(path) in common_identities
        )
        if len(combined_images) > config.max_images:
            kept_product_count = config.max_images - common_detail_count
            if common_detail_count:
                notices.append(
                    f"{folder.name} 有 {len(images)} 张商品图，另加入 {common_detail_count} 张通用细节图；"
                    f"轮播图上限 {config.max_images} 张，已保留主图和全部通用细节图，"
                    f"并按混合顺序只取前 {kept_product_count} 张商品图"
                )
            else:
                notices.append(
                    f"{folder.name} 有 {len(images)} 张图，只取自然排序后的前 {config.max_images} 张"
                )
        # Preserve legacy source selection, then allow every selected detail to
        # move between product images. Source identity is independent of position.
        products, details = ordinary_mixed_sources(images, common_detail_images)
        mixed_items = mixed_upload_items(config, folder, products, details)
        images = [item.path for item in mixed_items]
        detail_paths = [item.path for item in mixed_items if item.kind == "detail"]
        if listing_title != folder.name:
            notices.append(f"标题已安全清洗：{folder.name} → {listing_title}")
        jobs.append(
            ProductJob(
                folder=folder,
                title=folder.name,
                images=images,
                common_detail_count=len(detail_paths),
                detail_image_paths=detail_paths,
            )
        )
    # 阻塞原因始终排在标题清洗等普通提示之前，避免关键问题被长日志淹没。
    return jobs, blocking_warnings + image_count_warnings(folder_counts) + notices


def find_browser(configured: str = "") -> str:
    candidates = [
        configured,
        str(Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent)) / "browser" / "chrome.exe"),
        os.environ.get("DXM_BUNDLED_BROWSER", ""),
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        str(Path(os.environ.get("LOCALAPPDATA", "")) / "Google/Chrome/Application/chrome.exe"),
        str(Path(os.environ.get("LOCALAPPDATA", "")) / "Microsoft/Edge/Application/msedge.exe"),
    ]
    for candidate in candidates:
        if candidate and Path(candidate).is_file():
            return candidate
    raise RuntimeError("内置浏览器不完整，也未找到 Chrome 或 Edge。请重新完整解压发布包，或在“环境与设置”中选择浏览器。")


class StopRequested(RuntimeError):
    pass


class AutomationError(RuntimeError):
    pass


class TemplateValidationError(AutomationError):
    """Shared template failure: abort the batch without retrying each product."""


class AlbumSpaceError(TemplateValidationError):
    """Shared album failure: stop before more products fail or unsafe deletion."""


class StateStore:
    def __init__(self, path: Path, process_lock=None):
        self.path = path
        self._lock = process_lock or threading.RLock()
        self._reload_on_access = process_lock is not None
        self.data = {"completed": {}}
        self._reload_unlocked()

    def _reload_unlocked(self) -> None:
        self.data = {"completed": {}}
        path = self.path
        if path.exists():
            try:
                loaded = json.loads(path.read_text(encoding="utf-8"))
                if isinstance(loaded, dict):
                    self.data.update(loaded)
            except (OSError, json.JSONDecodeError):
                pass

    def is_completed(self, job: ProductJob, strict: bool = False) -> bool:
        with self._lock:
            if self._reload_on_access:
                self._reload_unlocked()
            completed = self.data.get("completed", {})
            path_record = completed.get(str(job.folder.resolve()))
            if isinstance(path_record, dict):
                return self._uses_current_title_rule(path_record)
            if strict:
                # Failed-folder retries must not confuse different prints that share
                # a long SEO title prefix. Exact paths/full titles still deduplicate.
                full_title = re.sub(r"[^a-z0-9]+", "", job.title.casefold())
                return any(
                    self._uses_current_title_rule(record) and (
                        folder_key(Path(path)) == folder_key(job.folder)
                        or re.sub(r"[^a-z0-9]+", "", str(record.get("title", "")).casefold()) == full_title
                    )
                    for path, record in completed.items() if isinstance(record, dict)
                )
            identity = self._title_identity(job.title)
            return any(
                self._uses_current_title_rule(record)
                and self._title_identity(str(record.get("title", ""))) == identity
                for record in completed.values()
                if isinstance(record, dict)
            )

    @staticmethod
    def _uses_current_title_rule(record: dict) -> bool:
        return (
            record.get("title_rule_version") == TITLE_RULE_VERSION
            and bool(record.get("listing_title"))
        )

    @staticmethod
    def _title_identity(title: str) -> str:
        # Stable across moving the image root and older filename-length truncation.
        normalized = re.sub(r"[^a-z0-9]+", "", title.casefold())
        return normalized[:96]

    def mark_completed(self, job: ProductJob, status: str, scheduled_at: str = "") -> None:
        with self._lock:
            # Each parallel worker owns a separate Python process. Reload while holding
            # the cross-process lock so one worker never overwrites another one's record.
            self._reload_unlocked()
            completed = self.data.setdefault("completed", {})
            record = {
                "title": job.title,
                "listing_title": job.listing_title,
                "title_rule_version": TITLE_RULE_VERSION,
                "identity": self._title_identity(job.title),
                "status": status,
                "time": datetime.now().isoformat(timespec="seconds"),
            }
            if scheduled_at:
                record["scheduled_at"] = scheduled_at
            completed[str(job.folder.resolve())] = record
            self.path.parent.mkdir(parents=True, exist_ok=True)
            temporary = self.path.with_name(
                f"{self.path.name}.{os.getpid()}.{threading.get_ident()}.tmp"
            )
            temporary.write_text(
                json.dumps(self.data, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            temporary.replace(self.path)


def prepare_failed_retries(
    records: list[FailureRecord], config: AppConfig, state: StateStore,
) -> tuple[list[ProductJob], list[str]]:
    """Rescan exact failed folders, isolating scripts, templates and old roots."""
    from urllib.parse import parse_qs, urlsplit

    def template_id(value: str) -> str:
        normalized = normalize_template_url(value)
        if not normalized:
            raise ValueError("模板网址为空")
        return parse_qs(urlsplit(normalized).query)["id"][0]

    jobs: list[ProductJob] = []
    skipped: list[str] = []
    seen: set[str] = set()
    for record in records:
        if record.status != "failed":
            continue
        if not record.product_folder:
            skipped.append(f"{record.title}：旧记录没有可确认的商品路径，请从失败现场核对。")
            continue
        folder = Path(record.product_folder)
        identity = folder_key(folder)
        if record.listing_profile != config.listing_profile:
            previous = {"blanket": "毛毯", "tshirt": "T恤", "tshirt_bw": "黑白T恤"}.get(
                record.listing_profile, str(record.listing_profile))
            current = {"blanket": "毛毯", "tshirt": "T恤", "tshirt_bw": "黑白T恤"}.get(
                config.listing_profile, str(config.listing_profile))
            skipped.append(f"{record.title}：失败记录属于{previous}脚本，当前选择{current}脚本，已跳过。")
            continue
        if record.template_url:
            try:
                matching_template = template_id(record.template_url) == template_id(config.template_url)
            except (ValueError, KeyError, TypeError):
                skipped.append(f"{record.title}：失败记录或当前模板网址无效，无法确认同一模板，已跳过。")
                continue
            if not matching_template:
                skipped.append(f"{record.title}：失败记录的模板 ID 与当前模板不同，已跳过；请切回原模板后重试。")
                continue
        else:
            # Older records have no template identity. Restrict them to this
            # selected material root, resolving symlinks and whole path parts.
            if not config.product_root.strip():
                skipped.append(f"{record.title}：旧记录未保存模板信息，请先选择所属素材总目录，已跳过。")
                continue
            root = normal_windows_path(Path(config.product_root).expanduser()).resolve()
            if not normal_windows_path(folder).resolve().is_relative_to(root):
                skipped.append(f"{record.title}：旧记录未保存模板信息，商品不在当前素材总目录内，已跳过。")
                continue
        if (config.listing_profile in {"tshirt", "tshirt_bw"}
                and record.article_name.strip() != config.article_name.strip()):
            skipped.append(f"{record.title}：失败记录的T恤货号英文名与当前不同，已跳过；请切回原英文名后重试。")
            continue
        if identity in seen:
            continue
        seen.add(identity)
        if state.is_completed(ProductJob(folder, record.title, []), strict=True):
            skipped.append(f"{record.title}：已有完成记录，已跳过。")
            continue
        if needs_submission_review(record.reason):
            skipped.append(f"{record.title}：上次提交结果不明确，请先到店小秘核对是否已发布。")
            continue
        if not extended_windows_path(folder).is_dir():
            skipped.append(f"{record.title}：文件夹不存在：{folder}")
            continue
        try:
            scanned, warnings = scan_product_folders(replace(config, product_root=str(folder)))
        except Exception as exc:
            skipped.append(f"{record.title}：{exc}")
            continue
        exact = [job for job in scanned if folder_key(job.folder) == identity]
        if len(exact) != 1:
            details = "；".join(warning for warning in warnings if is_blocking_scan_warning(warning))
            skipped.append(f"{record.title}：{details or '原商品文件夹没有可处理图片'}")
            continue
        jobs.append(exact[0])
    return jobs, skipped


def current_batch_progress(config, jobs, records, state):
    """Reconcile this material directory with durable exact completion records."""
    failures = [record for record in records if record.status == "failed"
                and record_matches_batch(record, config.product_root, config.listing_profile,
                                         config.template_url, config.article_name)
                and not state.is_completed(
                    ProductJob(Path(record.product_folder), record.title, []), strict=True)]
    failed_folders = {folder_key(Path(record.product_folder)) for record in failures}
    unfinished = [job for job in jobs if not state.is_completed(job, strict=True)]
    pending = [job for job in unfinished if folder_key(job.folder) not in failed_folders]
    return failures, pending, len(jobs) - len(unfinished)


class DxmUploader:
    """Text-first browser automation with geometry fallback only inside known dialogs."""

    def __init__(
        self,
        config: AppConfig,
        log: Callable[[str], None],
        stopped: threading.Event,
        retry_decider: Optional[Callable[[ProductJob, str, int], bool]] = None,
        max_job_attempts: int = MAX_JOB_ATTEMPTS,
        worker_slot: int = 0,
        upload_stage_dir: Optional[Path] = None,
    ) -> None:
        self.config = config
        self.config.template_url = normalize_template_url(self.config.template_url)
        self.log = log
        self.stopped = stopped
        self.retry_decider = retry_decider
        self.max_job_attempts = max(1, int(max_job_attempts))
        self.worker_slot = max(0, int(worker_slot))
        self.upload_stage_dir = upload_stage_dir or UPLOAD_STAGE_DIR
        self.page = None
        self._album_protected_urls: set[str] = set()
        self._album_protection_failed = False
        self._album_cleanup_suspended = False
        if self.config.album_cleanup_enabled:
            validate_album_config(self.config)
            if not self.config.album_cleanup_batch_id:
                self.config.album_cleanup_batch_id = uuid.uuid4().hex
            self._load_album_protection()

    def _album_audit_directory(self) -> Path:
        return LOG_DIR / "album-cleanup" / self.config.album_cleanup_batch_id

    def _load_album_protection(self) -> None:
        path = self._album_audit_directory() / "protected.json"
        candidates = [path] + sorted(candidate for candidate in path.parent.parent.glob("*/protected.json")
                                     if candidate != path and re.fullmatch(r"[a-f0-9]{32}", candidate.parent.name))
        for candidate in candidates:
            if not candidate.exists():
                continue
            try:
                raw = json.loads(candidate.read_text(encoding="utf-8"))
                if not isinstance(raw, dict):
                    raise ValueError("保护记录格式错误")
                suspended = raw.get("cleanup_suspended", False)
                if not isinstance(suspended, bool):
                    raise ValueError("清理暂停状态格式错误")
                if not isinstance(raw.get("urls"), list) or not all(isinstance(url, str) for url in raw["urls"]):
                    raise ValueError("保护图片清单格式错误")
                from album_cleanup_policy import image_url_identity
                for url in raw["urls"]:
                    image_url_identity(url)
                if candidate != path and not suspended:
                    continue
                self._album_cleanup_suspended |= suspended
                self._album_protected_urls.update(raw["urls"])
            except Exception as exc:
                if candidate == path:
                    raise AlbumSpaceError(f"本批次图库图片保护记录无法读取，已停止自动清理：{exc}") from exc
                # A fresh UUID must never bypass an older uncertain upload.
                self._album_cleanup_suspended = True
                self.log("历史图片保护记录无法核对，本批次仅检查空间并暂停自动删除。")

    def _protect_album_page_images(self, *, strict: bool = True) -> None:
        if not self.config.album_cleanup_enabled:
            return
        try:
            if self.page is None or self.page.is_closed():
                raise ValueError("商品页面已关闭")
            urls = self.page.locator("img").evaluate_all(
                "els => els.map(el => el.currentSrc || el.src || '').filter(url => /^https?:\\/\\//i.test(url))")
            if not isinstance(urls, list) or not all(isinstance(url, str) for url in urls):
                raise ValueError("无法读取商品页图片地址")
            from album_cleanup_policy import image_url_identity
            for url in urls:
                image_url_identity(url)
            self._album_protected_urls.update(urls)
            path = self._album_audit_directory() / "protected.json"
            path.parent.mkdir(parents=True, exist_ok=True)
            temporary = path.with_suffix(".tmp")
            temporary.write_text(json.dumps({"urls": sorted(self._album_protected_urls),
                                            "cleanup_suspended": self._album_cleanup_suspended}, ensure_ascii=False), encoding="utf-8")
            temporary.replace(path)
        except Exception as exc:
            self._album_protection_failed = True
            if strict:
                raise AlbumSpaceError(f"无法保护本批次图片，已停止自动清理：{exc}") from exc
            self.log(f"图库保护记录未能更新，后续清理将停止：{exc}")

    def _ensure_album_space(self, job: ProductJob) -> None:
        if not self.config.album_cleanup_enabled:
            return
        if self._album_protection_failed:
            raise AlbumSpaceError("本批次图片保护记录不完整，已停止清理和后续上传。")
        from album_cleanup import AlbumCleaner
        sources = list(job.images)
        for paths in job.color_image_sets.values():
            sources.extend(paths)
        unique_sources = {path.resolve(): path for path in sources}
        reserve_mb = sum(path.stat().st_size for path in unique_sources.values()) / (1024 * 1024) + 10
        album_page = None
        try:
            album_page = self.page.context.new_page()
            cleaner = AlbumCleaner(album_page, log=self.log, check_stop=self._check_stop,
                sleep=self._sleep, threshold_mb=self.config.album_cleanup_threshold_mb,
                protected_urls=self._album_protected_urls,
                audit_path=self._album_audit_directory() / "cleanup.jsonl")
            if self._album_cleanup_suspended:
                self.log("先前有图片上传未确认，本批次暂停自动删除，仅检查剩余空间。")
                cleaner.ensure_space(reserve_mb=reserve_mb, allow_cleanup=False)
            else:
                cleaner.ensure_space(reserve_mb=reserve_mb)
        except StopRequested:
            raise
        except Exception as exc:
            self._check_stop()
            raise AlbumSpaceError(str(exc)) from exc
        finally:
            try:
                if album_page is not None:
                    album_page.close()
            except Exception:
                pass

    def _check_album_upload_space(self) -> None:
        """Observe explicit upload alerts without initiating cleanup mid-upload."""
        if not self.config.album_cleanup_enabled:
            return
        from album_cleanup_policy import is_album_capacity_error
        try:
            notices = self.page.locator(
                ".ant-message-notice-content, .ant-notification-notice-description, "
                ".ant-modal-confirm-content, [role='alert']"
            ).evaluate_all("""els => els.filter(el => el.getClientRects().length &&
                getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none')
                .map(el => (el.innerText || '').slice(0, 500))""")
        except Exception:
            self._check_stop()
            return
        if isinstance(notices, list) and any(is_album_capacity_error(text) for text in notices):
            raise AlbumSpaceError(
                "单款上传途中，店小秘提示图库空间不足。已保留当前款及后续商品为待处理；"
                "部分图片可能已上传，程序不会在上传结果未确认时边删边重传。"
                "请先人工处理图库空间，再重新开始；已完成商品不会重复提交。")

    def _should_retry_job(self, job: ProductJob, reason: BaseException, attempt_number: int) -> bool:
        if isinstance(reason, TemplateValidationError):
            return False
        if needs_submission_review(str(reason)):
            self.log("提交结果不明确，保留记录并等待人工核对，不自动重试。")
            return False
        if attempt_number >= self.max_job_attempts:
            return False
        if self.retry_decider is None:
            self.log("当前为无交互运行；第一次失败后自动重试一次。")
            return True
        try:
            return bool(
                self.retry_decider(job, str(reason), RETRY_PROMPT_TIMEOUT_SECONDS)
            )
        except Exception as exc:
            self.log(f"重试询问弹窗异常：{exc}；按默认规则自动重试一次。")
            return True

    @staticmethod
    def _is_driver_disconnect(reason: BaseException) -> bool:
        message = str(reason).casefold()
        return any(
            marker in message
            for marker in (
                "connection closed while reading from the driver",
                "playwright connection closed",
                "browser has been closed",
                "target page, context or browser has been closed",
                "connection closed",
            )
        )

    def _check_stop(self) -> None:
        if self.stopped.is_set():
            raise StopRequested("用户已停止任务。")

    def _sleep(self, seconds: float) -> None:
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            self._check_stop()
            time.sleep(min(0.25, end - time.monotonic()))

    @staticmethod
    def _visible(locator):
        try:
            count = locator.count()
        except Exception:
            return None
        for index in range(count):
            item = locator.nth(index)
            try:
                if item.is_visible():
                    return item
            except Exception:
                continue
        return None

    def _text(self, text: str, exact: bool = True, last: bool = False):
        locator = self.page.get_by_text(text, exact=exact)
        visible = []
        for index in range(locator.count()):
            item = locator.nth(index)
            try:
                if item.is_visible():
                    visible.append(item)
            except Exception:
                pass
        if not visible:
            raise AutomationError(f"页面上没有找到可见文字：{text}")
        return visible[-1] if last else visible[0]

    def _click_text(self, text: str, exact: bool = True, last: bool = False) -> None:
        self._check_stop()
        target = self._text(text, exact=exact, last=last)
        target.click()
        self._sleep(0.6)

    def _top_dialog(self):
        selectors = [
            "div[role='dialog']",
            ".el-dialog",
            ".ant-modal",
            ".ivu-modal",
            ".modal-dialog",
            ".layui-layer",
        ]
        visible = []
        for selector in selectors:
            locator = self.page.locator(selector)
            for index in range(locator.count()):
                item = locator.nth(index)
                try:
                    if item.is_visible():
                        box = item.bounding_box()
                        if box:
                            visible.append((box["y"], item))
                except Exception:
                    pass
        if not visible:
            raise AutomationError("没有找到当前弹窗。")
        return sorted(visible, key=lambda pair: pair[0])[-1][1]

    def _click_dialog_button(self, text: str) -> None:
        dialog = self._top_dialog()
        candidates = dialog.get_by_text(text, exact=True)
        target = self._visible(candidates)
        if target is None:
            raise AutomationError(f"弹窗中没有找到按钮：{text}")
        target.click()
        self._sleep(0.7)

    def _fill_title(self, label: str, value: str) -> None:
        patterns = [
            f"xpath=//label[@title='{label}']/ancestor::div[contains(concat(' ',normalize-space(@class),' '),' ant-form-item ')][1]//input[1]",
            f"xpath=//label[normalize-space()='{label}']/ancestor::div[contains(concat(' ',normalize-space(@class),' '),' ant-form-item ')][1]//input[1]",
            f"xpath=//label[@title='{label}']/ancestor::div[contains(concat(' ',normalize-space(@class),' '),' ant-form-item ')][1]//textarea[1]",
        ]
        for selector in patterns:
            locator = self.page.locator(selector)
            target = self._visible(locator)
            if target is not None:
                if not target.is_enabled():
                    self._sleep(0.8)
                    actual = target.input_value()
                    if actual == value:
                        self.log(f"“{label}”为锁定字段，已确认自动同步正确。")
                        return
                    raise AutomationError(
                        f"“{label}”为锁定字段，但没有同步为安全标题。"
                        f"页面当前值：{actual[:120]}"
                    )
                target.click()
                target.press("Control+A")
                target.fill(value)
                target.press("Tab")
                self._sleep(0.3)
                actual = target.input_value()
                if actual != value:
                    raise AutomationError(
                        f"“{label}”写入校验失败：页面值不是预期标题。"
                    )
                return
        raise AutomationError(f"没有找到“{label}”输入框。")

    def _click_near(self, label: str, text: str) -> None:
        labels = self.page.get_by_text(re.compile(re.escape(label)))
        for index in range(labels.count()):
            node = labels.nth(index)
            try:
                if not node.is_visible():
                    continue
            except Exception:
                continue
            scope = node
            for _ in range(7):
                scope = scope.locator("xpath=..")
                target = self._visible(scope.get_by_text(text, exact=True))
                if target is not None:
                    target.click()
                    self._sleep(0.6)
                    return
        raise AutomationError(f"没有在“{label}”附近找到“{text}”。")

    def _confirm_if_present(self) -> None:
        confirm_pattern = re.compile(r"确\s*(?:定|认)")
        try:
            dialog = self._top_dialog()
        except AutomationError:
            dialog = None
        if dialog is not None:
            try:
                target = self._visible(dialog.get_by_role("button", name=confirm_pattern))
                if target is None:
                    target = self._visible(dialog.get_by_text(confirm_pattern))
                if target is not None:
                    target.click(force=True)
                    try:
                        dialog.wait_for(state="hidden", timeout=3000)
                    except Exception:
                        pass
                    self._sleep(0.8)
                    return
            except Exception:
                pass
        try:
            target = self._visible(self.page.get_by_role("button", name=confirm_pattern))
            if target is not None:
                target.click(force=True)
                self._sleep(0.8)
                return
        except Exception:
            pass
        for text in ("确 定", "确定", "确认"):
            try:
                target = self._visible(self.page.get_by_text(text, exact=True))
                if target is not None:
                    target.click(force=True)
                    self._sleep(0.8)
                    return
            except Exception:
                pass

    def _wait_for_editor(self) -> None:
        deadline = time.monotonic() + self.config.login_wait_minutes * 60
        announced = False
        last_template_retry = 0.0
        while time.monotonic() < deadline:
            self._check_stop()
            if self.page.is_closed():
                raise AutomationError("测试浏览器窗口已关闭。")
            title_input = self.page.locator(
                "xpath=//label[@title='产品标题']/ancestor::div[contains(concat(' ',normalize-space(@class),' '),' ant-form-item ')][1]//input[1]"
            )
            if self._visible(title_input) is not None:
                return
            if not announced:
                self.log("请在打开的浏览器里登录店小秘并完成滑块/验证码；登录后程序会自动继续。")
                announced = True
            login_input = self._visible(self.page.locator("input[placeholder='请输入用户名']"))
            now = time.monotonic()
            if (
                login_input is None
                and "/web/popTemu/quoteEdit" not in self.page.url
                and now - last_template_retry >= 3
            ):
                self.log("已检测到登录，正在重新打开模板编辑页。")
                self.page.goto(self.config.template_url, wait_until="domcontentloaded")
                last_template_retry = now
            self._sleep(1)
        raise AutomationError("等待登录或模板编辑页超时。")

    def _open_template(self) -> None:
        self._check_stop()
        self.config.template_url = normalize_template_url(self.config.template_url)
        self.page.goto(self.config.template_url, wait_until="domcontentloaded")
        self._wait_for_editor()
        self._wait_for_template_data()

    def _template_problems(self) -> list[str]:
        if self.config.listing_profile in {"tshirt", "tshirt_bw"}:
            import tshirt_automation
            problems = tshirt_automation.template_problems(self)
            if self.config.listing_profile == "tshirt_bw" and not problems:
                try:
                    tshirt_automation.validate_bw_rows(self)
                except tshirt_automation.TshirtAutomationError as exc:
                    problems.append(str(exc))
            return problems
        # A title input appears before quote data loads, including on an empty
        # create-product page. Check actual selected values and populated variants.
        return self.page.evaluate(r"""() => {
            const visible = el => {
                if (!el || !el.getClientRects().length) return false;
                for (let p = el; p; p = p.parentElement) {
                    const s = getComputedStyle(p);
                    if (s.display === 'none' || s.visibility === 'hidden') return false;
                }
                return true;
            };
            const problems = [];
            for (const name of ['店铺账号', '产品分类', '运费模板']) {
                const label = Array.from(document.querySelectorAll('label[title]'))
                    .find(el => el.title === name && visible(el));
                const section = label && label.closest('.ant-form-item');
                const selected = section && Array.from(section.querySelectorAll(
                    '.ant-select-selection-item'
                )).some(el => visible(el) && el.textContent.trim()
                    && !/请选择|未选择/.test(el.textContent));
                if (!selected) problems.push(name + '未加载或未选择');
            }
            const preview = Array.from(document.querySelectorAll('th'))
                .find(el => visible(el) && /预览图/.test(el.textContent)
                    && /批量/.test(el.textContent));
            const table = preview && preview.closest('table');
            const rows = table ? Array.from(table.querySelectorAll('tbody tr'))
                .filter(el => visible(el) && el.querySelector('td input, td img')) : [];
            if (!rows.length) problems.push('变种数据未加载（缺少预览图/变种行）');
            return problems;
        }""")

    def _wait_for_template_data(self) -> None:
        deadline = time.monotonic() + max(1, self.config.operation_timeout_seconds)
        last_problems = None
        ready_checks = 0
        while True:
            self._check_stop()
            if self.page.is_closed():
                raise StopRequested("模板检查窗口已关闭，已停止任务。")
            problems = self._template_problems()
            if not problems:
                ready_checks += 1
                if ready_checks >= 2:
                    self.log("模板检查通过：店铺、分类、运费模板及所选脚本的商品规格已加载。")
                    return
            else:
                ready_checks = 0
                if problems != last_problems:
                    self.log("正在等待模板数据：" + "；".join(problems))
                    last_problems = problems
            if time.monotonic() >= deadline:
                raise TemplateValidationError(
                    "模板数据未就绪：" + "；".join(problems or last_problems or ["数据尚未稳定"])
                    + "。请在店小秘打开已配置完整的同类商品模板，复制其编辑网址。"
                    "请确认当前账号能访问该模板；程序不会自动选择店铺、分类或规格。"
                    f" 当前模板：{self.config.template_url}"
                )
            self._sleep(1)

    def _prepare_upload_image(self, source: Path, target: Path) -> Path:
        return prepare_carousel_jpg(source, target, options=options_from_config(self.config))

    def _upload_carousel(self, job: ProductJob) -> None:
        options = options_from_config(self.config)
        self.log("上传图片处理：" + describe_options(options) + "；源文件不变。")
        if job.common_detail_count:
            self.log(
                f"上传 {len(job.images)} 张轮播图（第一张为主图；包含 "
                f"{job.common_detail_count} 张通用细节图，按混合排序上传）"
            )
        else:
            self.log(f"上传 {len(job.images)} 张轮播图（第一张为主图）")
        section = self.page.locator(".mainImage")
        visible_section = self._visible(section)
        if visible_section is None:
            raise AutomationError("没有找到产品轮播图区域。")
        removed = 0
        while removed < 20:
            delete_icon = self._visible(visible_section.locator(".img-list .icon_delete"))
            if delete_icon is None:
                break
            delete_icon.click(force=True)
            removed += 1
            self._sleep(0.25)
        if removed:
            self.log(f"已清除模板原轮播图 {removed} 张")
        self._click_near("产品轮播图", "选择图片")
        from contextlib import nullcontext
        from tempfile import TemporaryDirectory
        if options.mode == "original":
            stage_context = nullcontext(None)
        else:
            self.upload_stage_dir.mkdir(parents=True, exist_ok=True)
            stage_context = TemporaryDirectory(prefix="carousel-", dir=self.upload_stage_dir)
        # Only this fresh subdirectory belongs to this upload. Never delete the
        # staging parent: it may contain images selected by the user.
        with stage_context as stage_name:
            upload_paths = [str(path) for path in job.images]
            expected_sizes = None
            if options.mode != "original":
                upload_paths = []
                for index, source in enumerate(job.images, start=1):
                    target = Path(stage_name) / f"{index:02d}.jpg"
                    actual = self._prepare_upload_image(source, target)
                    upload_paths.append(str(actual))
                expected_sizes = []
                for path in upload_paths:
                    with PILImage.open(path) as image:
                        expected_sizes.append(image.size)
            self.log(f"已准备 {len(upload_paths)} 张上传图片：{describe_options(options)}。")
            # 店小秘的下拉菜单偶尔肉眼可见但文字定位误判不可见。直接点击菜单项的
            # 稳定 data-menu-id，仍保留网页原生点击事件以正确开启多文件模式。
            local_item = self.page.locator(
                "div.ant-dropdown:not([style*='display: none']) li[data-menu-id='local']"
            )
            local_target = self._wait_visible(local_item, "本地图片上传入口", 8)
            with self.page.expect_file_chooser(
                timeout=self.config.operation_timeout_seconds * 1000
            ) as chooser_info:
                local_target.click(timeout=5000)
            chooser_info.value.set_files(upload_paths)
            self._wait_for_carousel_images(visible_section, len(job.images), expected_sizes)
            self.log(f"轮播图已就绪：{len(job.images)} 张；{describe_options(options)}。")

    def _wait_for_carousel_images(self, section, expected_count: int,
                                  expected_sizes: list[tuple[int, int]] | None = None) -> None:
        """Wait for server-side uploads to materialize instead of relying on a fixed sleep."""
        if expected_sizes is not None and len(expected_sizes) != expected_count:
            raise AutomationError("上传图片尺寸清单与图片数量不一致。")
        deadline = time.monotonic() + max(
            CAROUSEL_UPLOAD_READY_SECONDS,
            self.config.upload_wait_seconds * 3,
            self.config.operation_timeout_seconds * 3,
        )
        last_count = 0
        last_ready_count = 0
        last_target_count = 0
        last_progress = time.monotonic() - 5
        stable_since = 0.0
        while time.monotonic() < deadline:
            self._check_stop()
            if self.page.is_closed():
                raise StopRequested("上传窗口已关闭，任务已停止。")
            self._check_album_upload_space()
            try:
                images = section.locator(".img-list .single-image")
                current_count = sum(
                    1
                    for index in range(images.count())
                    if images.nth(index).is_visible()
                )
                ready_count = 0
                target_count = 0
                visible_index = 0
                for index in range(images.count()):
                    card = images.nth(index)
                    if not card.is_visible():
                        continue
                    dimensions = image_dimensions(card.inner_text())
                    if any(width > 0 and height > 0 for width, height in dimensions):
                        ready_count += 1
                    target = (expected_sizes[visible_index] if visible_index < len(expected_sizes) else (-1, -1)) \
                        if expected_sizes is not None else None
                    if any(width > 0 and height > 0 and (target is None or (width, height) == target)
                           for width, height in dimensions):
                        target_count += 1
                    visible_index += 1
                snapshot = (current_count, ready_count, target_count)
                previous = (last_count, last_ready_count, last_target_count)
                if snapshot != previous:
                    self.log(
                        f"轮播图上传进度：卡片 {current_count}/{expected_count}，"
                        f"尺寸就绪 {ready_count}/{expected_count}，"
                        f"符合所选处理方式 {target_count}/{expected_count}"
                    )
                    last_count = current_count
                    last_ready_count = ready_count
                    last_target_count = target_count
                    stable_since = 0.0
                if time.monotonic() - last_progress >= 5:
                    self.log(
                        f"等待轮播图元数据：卡片 {current_count}/{expected_count}，"
                        f"符合设置 {target_count}/{expected_count}，剩余约 "
                        f"{max(0, int(deadline - time.monotonic()))} 秒；可点击停止。"
                    )
                    last_progress = time.monotonic()
                if current_count == expected_count and target_count == expected_count:
                    # 数量和服务端尺寸元数据都到齐后再确认稳定，避免 0 X 0 状态下继续。
                    if not stable_since:
                        stable_since = time.monotonic()
                    if time.monotonic() - stable_since >= 1.0:
                        self.log(
                            f"轮播图已全部上传并就绪：{expected_count}/{expected_count}，"
                            "尺寸按本次图片处理设置核对。"
                        )
                        return
            except Exception:
                pass
            self._sleep(0.3)
        raise AutomationError(
            f"轮播图上传或尺寸元数据等待超时：预期 {expected_count} 张，"
            f"处理方式为{describe_options(options_from_config(self.config))}；页面卡片 {last_count} 张，"
            f"尺寸就绪 {last_ready_count} 张，符合设置 {last_target_count} 张。"
        )

    def _wait_visible(self, locator, label: str, seconds: float = 8):
        deadline = time.monotonic() + seconds
        self.log(f"正在等待：{label}（最多 {seconds:g} 秒）")
        while time.monotonic() < deadline:
            self._check_stop()
            if self.page.is_closed():
                raise StopRequested("浏览器窗口已关闭，任务已停止。")
            target = self._visible(locator)
            if target is not None:
                return target
            self._sleep(0.25)
        raise AutomationError(f"等待{label}超时（{seconds:g} 秒），页面控件未就绪。")

    def _open_image_resize_menu(self, section):
        trigger = self._visible(section.get_by_text("编辑图片", exact=True))
        if trigger is None:
            raise AutomationError("没有找到轮播图区域的“编辑图片”菜单。")
        items = self.page.get_by_text("批量改图片尺寸", exact=True)
        for attempt in range(2):
            self._check_stop()
            if attempt:
                self.log("图片编辑菜单未展开，正在重新展开一次。")
            self.page.mouse.move(8, 8)
            trigger.hover(timeout=5000)
            if self._visible(items) is None:
                trigger.click(timeout=5000)
            try:
                return self._wait_visible(items, "批量改图片尺寸菜单", 8)
            except AutomationError:
                if attempt == 1:
                    raise

    def _resize_carousel_images(self, section, expected_count: int) -> None:
        """Legacy web fallback, restricted to the original 1200-square policy."""
        options = options_from_config(self.config)
        if options.mode != "square" or (options.width, options.height) != (1200, 1200):
            raise AutomationError("当前图片处理设置不启用网页端1200×1200转换，请按所选设置重新上传。")
        self.log("全选轮播图并批量生成 1200×1200 JPG")

        selected_pattern = re.compile(rf"已选\s*{expected_count}\s*张")
        selected = False
        for select_attempt in range(3):
            select_all = self._visible(section.locator("input[type='checkbox']"))
            if select_all is not None:
                try:
                    select_all.check(force=True)
                except Exception:
                    select_all.click(force=True)
            else:
                select_all_text = self._visible(section.get_by_text("全选", exact=True))
                if select_all_text is None:
                    raise AutomationError("轮播图上传后没有找到“全选”。")
                select_all_text.click(force=True)

            selected_deadline = time.monotonic() + 5
            while time.monotonic() < selected_deadline:
                self._check_stop()
                try:
                    selected_by_text = bool(selected_pattern.search(section.inner_text()))
                    checked_count = section.locator(
                        ".img-list .single-image input[type='checkbox']:checked"
                    ).count()
                    checked_class_count = section.locator(
                        ".img-list .single-image.checked"
                    ).count()
                    if selected_by_text or max(checked_count, checked_class_count) >= expected_count:
                        selected = True
                        break
                except Exception:
                    pass
                self._sleep(0.25)
            if selected:
                break
            self.log(f"轮播图全选第 {select_attempt + 1} 次未生效，正在重新选择。")
            self.page.mouse.move(8, 8)
            self._sleep(0.25)
        if not selected:
            raise AutomationError(f"轮播图全选校验失败：预期选中 {expected_count} 张。")

        resize_item = self._open_image_resize_menu(section)
        resize_item.click(timeout=5000)

        title = self.page.get_by_text("批量图片尺寸", exact=True)
        try:
            title.wait_for(state="visible", timeout=self.config.operation_timeout_seconds * 1000)
        except Exception as exc:
            raise AutomationError("批量图片尺寸弹窗没有打开。") from exc
        dialog = self._top_dialog()

        custom_ratio = self._visible(dialog.get_by_text("自定义比例调整", exact=True))
        if custom_ratio is not None:
            custom_ratio.click(force=True)
            self._sleep(0.3)

        custom_row = None
        if custom_ratio is not None:
            custom_row = custom_ratio.locator(
                "xpath=ancestor::div[contains(concat(' ',normalize-space(@class),' '),' resize-line ')][1]"
            )
        if custom_row is None or custom_row.count() == 0:
            rows = dialog.locator(".resize-line")
            custom_row = rows.nth(1) if rows.count() > 1 else rows.first

        mode_select = self._visible(custom_row.locator(".ant-select-selector"))
        current_mode = ""
        try:
            current_mode = custom_row.locator(".ant-select-selection-item").first.inner_text().strip()
        except Exception as exc:
            pass
        if current_mode != "自定义宽高":
            if mode_select is None:
                raise AutomationError("自定义比例区域中没有找到尺寸模式选择框。")
            option_selected = False
            for dropdown_attempt in range(1, 4):
                self._check_stop()
                try:
                    mode_select.click(force=True, timeout=5000)
                except Exception:
                    pass
                option_deadline = time.monotonic() + 5
                while time.monotonic() < option_deadline:
                    self._check_stop()
                    options = self.page.locator(
                        ".ant-select-dropdown:not(.ant-select-dropdown-hidden) "
                        ".ant-select-item-option[title='自定义宽高']"
                    )
                    option = self._visible(options)
                    if option is None:
                        option = self._visible(
                            self.page.get_by_text("自定义宽高", exact=True)
                        )
                    if option is not None:
                        option.click(force=True, timeout=5000)
                        option_selected = True
                        break
                    self._sleep(0.2)
                if option_selected:
                    break
                self.log(
                    f"尺寸模式选项第 {dropdown_attempt} 次尚未就绪，正在重新展开。"
                )
                try:
                    self.page.keyboard.press("Escape")
                except Exception:
                    pass
                self._sleep(0.4)
            if not option_selected:
                raise AutomationError(
                    "尺寸模式下拉框连续 3 次均未找到“自定义宽高”。"
                )
            mode_deadline = time.monotonic() + 3
            while time.monotonic() < mode_deadline:
                try:
                    current_mode = custom_row.locator(
                        ".ant-select-selection-item"
                    ).first.inner_text().strip()
                    if current_mode == "自定义宽高":
                        break
                except Exception:
                    pass
                self._sleep(0.2)
            if current_mode != "自定义宽高":
                raise AutomationError("尺寸模式已点击，但页面没有切换到“自定义宽高”。")

        editable_inputs = []
        inputs = custom_row.locator("input.ant-input:not([disabled])")
        for index in range(inputs.count()):
            field = inputs.nth(index)
            try:
                if field.is_visible() and field.is_enabled() and field.is_editable():
                    editable_inputs.append(field)
            except Exception:
                pass
        if len(editable_inputs) < 2:
            raise AutomationError("批量图片尺寸弹窗中没有找到可编辑的宽度和高度输入框。")
        for field in editable_inputs[:2]:
            field.click(force=True)
            field.press("Control+A")
            field.fill("1200")
            field.press("Tab")
            if field.input_value().strip() != "1200":
                raise AutomationError("图片尺寸 1200 写入校验失败。")

        remember = self._visible(dialog.get_by_text("记住本次设置", exact=True))
        if remember is not None:
            remember_label = remember.locator("xpath=ancestor::label[1]")
            remember_box = self._visible(remember_label.locator("input[type='checkbox']"))
            if remember_box is not None and not remember_box.is_checked():
                remember_box.check(force=True)

        generate = self._visible(dialog.get_by_role("button", name="生成JPG图片", exact=True))
        if generate is None:
            generate = self._visible(dialog.get_by_text("生成JPG图片", exact=True))
        if generate is None:
            raise AutomationError("批量图片尺寸弹窗中没有找到“生成JPG图片”。")
        generate.click(force=True)

        deadline = time.monotonic() + max(
            CAROUSEL_UPLOAD_READY_SECONDS,
            self.config.operation_timeout_seconds * 4,
        )
        last_count = 0
        last_status = ""
        last_progress = time.monotonic() - 10
        while time.monotonic() < deadline:
            self._check_stop()
            try:
                current_section = self._visible(self.page.locator(".mainImage")) or section
                last_count = count_square_dimensions(current_section.inner_text(), 1200)
                if last_count >= expected_count:
                    self.log(f"尺寸转换完成：{expected_count} 张均为 1200×1200 JPG")
                    return
            except Exception:
                pass
            try:
                processing = self._visible(self.page.get_by_text("图片处理中", exact=True))
                if processing is not None:
                    processing_dialog = processing.locator(
                        "xpath=ancestor::*[@role='dialog' or contains(@class,'ant-modal')][1]"
                    )
                    last_status = re.sub(r"\s+", "", processing_dialog.inner_text())[:120]
            except Exception:
                pass
            if time.monotonic() - last_progress >= 10:
                self.log(
                    f"等待店小秘图片处理：1200×1200 已识别 {last_count}/{expected_count}"
                    + (f"；{last_status}" if last_status else "")
                )
                last_progress = time.monotonic()
            self._sleep(0.5)
        raise AutomationError(
            f"生成 JPG 后尺寸校验超时：预期 {expected_count} 张 1200×1200，"
            f"页面识别到 {last_count} 张"
            + (f"；店小秘最后状态：{last_status}" if last_status else "")
            + "。"
        )

    def _choose_carousel_images(self, all_images: bool) -> None:
        if self.config.listing_profile in {"tshirt", "tshirt_bw"}:
            import tshirt_automation
            tshirt_automation.choose_description_images(self, all_images=all_images)
            return
        self._click_text("选择图片", exact=True, last=True)
        self._click_text("引用产品轮播图", exact=True, last=True)
        self._sleep(1)
        dialog = self._top_dialog()
        checkboxes = dialog.locator("input[type='checkbox']")
        visible_boxes = []
        for index in range(checkboxes.count()):
            checkbox = checkboxes.nth(index)
            try:
                if checkbox.is_visible():
                    visible_boxes.append(checkbox)
            except Exception:
                pass
        if visible_boxes:
            if all_images:
                visible_boxes[0].check(force=True)
            else:
                # 第一项通常是“全部”；存在多项时选择第一张图片对应的第二项。
                visible_boxes[1 if len(visible_boxes) > 1 else 0].check(force=True)
        else:
            # 店小秘有时把原生 checkbox 隐藏在自定义标签后面。
            fallback_text = "全部" if all_images else "选择图片"
            fallback = self._visible(dialog.get_by_text(fallback_text, exact=True))
            if fallback is None:
                raise AutomationError("引用轮播图弹窗中没有找到图片选择框。")
            fallback.click()
        self._click_dialog_button("选择")

    def _replace_variant_images(self) -> None:
        self.log("将第一张轮播图替换到全部变种浏览图")
        self._click_near("预览图", "批量")
        self._wait_visible(self.page.get_by_text("批量传图", exact=True), "变种批量传图菜单").click(timeout=5000)
        self.log("变种图片：正在引用第一张轮播图。")
        self._choose_carousel_images(all_images=False)
        dialog = self._top_dialog()
        self._fill_variant_slots(dialog)
        return

    def _fill_variant_slots(self, dialog) -> None:
        slots = dialog.locator(".result-module .result-item")
        self._wait_visible(slots, "变种图片位置")
        count = slots.count()
        source = dialog.locator(".upload-module .upload-item").first
        source_url = source.locator("img").get_attribute("src", timeout=5000)
        if not source_url:
            raise AutomationError("新主图尚未加载，不能替换变种图片。")
        # Use actual slot structure: close controls are divs and may only appear
        # on hover. Coordinate scanning missed them and could wait for minutes.
        for index in range(count):
            self._check_stop()
            slot = slots.nth(index)
            self.log(f"变种图片：清理旧图 {index + 1}/{count}")
            if slot.locator("img").count():
                slot.hover(timeout=5000)
                slot.locator(".close-btn").click(timeout=5000)
                slot.locator("img").wait_for(state="detached", timeout=5000)
        for index in range(count):
            self._check_stop()
            self.log(f"变种图片：填入新图 {index + 1}/{count}")
            source.click(timeout=5000)
            self._wait_visible(slots.nth(index).locator("img"), "变种新图片", 5)
        urls = slots.locator("img").evaluate_all("els => els.map(el => el.getAttribute('src'))")
        if len(urls) != count or any(url != source_url for url in urls):
            raise AutomationError("变种图片回读不一致，已停止保存。")
        self.log(f"变种图片：{count} 个已全部核对，正在保存。")
        self._click_dialog_button("确定")
        dialog.wait_for(state="hidden", timeout=10000)


    def _open_batch_menu(self):
        editor = self._visible(
            self.page.locator(".ant-modal-content").filter(has_text="Temu产品描述")
        )
        if editor is None:
            raise AutomationError("产品描述编辑窗口尚未准备完成。")
        menu = self._visible(editor.get_by_text("批量操作", exact=True))
        if menu is None:
            raise AutomationError("产品描述编辑窗口中没有找到“批量操作”入口。")
        dropdowns = self.page.locator("div.custom-batch-btn:not(.custom-delete-btn)").filter(
            has_text="批量传图"
        )
        for attempt in range(5):
            # 菜单依赖鼠标进入/离开事件。先移出再重新进入，避免触发器停留导致事件不再触发。
            self.page.mouse.move(8, 8)
            self._sleep(0.12)
            try:
                menu.hover(force=True)
            except Exception:
                try:
                    menu.dispatch_event("mouseenter")
                except Exception:
                    menu.click(force=True)
            self._sleep(0.35)
            for index in range(dropdowns.count() - 1, -1, -1):
                dropdown = dropdowns.nth(index)
                try:
                    style = (dropdown.get_attribute("style") or "").replace(" ", "").casefold()
                    if "display:none" not in style and dropdown.is_visible():
                        return dropdown
                except Exception:
                    continue
            # 新版页面偶尔将触发方式从悬停改为点击，交替尝试一次。
            try:
                menu.click(force=True)
            except Exception:
                pass
            self._sleep(0.25)
        raise AutomationError("产品描述的“批量操作”菜单连续 5 次未能展开。")

    def _open_clear_description_menu(self):
        """Open the nested clear-description menu without ever clicking a hidden duplicate."""
        for attempt in range(5):
            batch_menu = self._open_batch_menu()
            clear = self._visible(batch_menu.get_by_text("清空描述", exact=True))
            if clear is None:
                continue
            try:
                clear.hover(force=True)
            except Exception:
                try:
                    clear.dispatch_event("mouseenter")
                except Exception:
                    clear.click(force=True)
            self._sleep(0.3)
            submenus = self.page.locator("div.custom-delete-btn")
            for index in range(submenus.count() - 1, -1, -1):
                submenu = submenus.nth(index)
                try:
                    style = (submenu.get_attribute("style") or "").replace(" ", "").casefold()
                    if "display:none" not in style and submenu.is_visible():
                        return submenu
                except Exception:
                    continue
            # 某些页面构建只响应真实鼠标坐标，直接移动到菜单项中心再检查。
            try:
                box = clear.bounding_box()
                if box:
                    self.page.mouse.move(
                        box["x"] + box["width"] / 2,
                        box["y"] + box["height"] / 2,
                    )
                    self._sleep(0.4)
            except Exception:
                pass
            for index in range(submenus.count() - 1, -1, -1):
                submenu = submenus.nth(index)
                try:
                    if submenu.is_visible():
                        return submenu
                except Exception:
                    continue
            # 兼容少数账号上改成点击触发的菜单版本。
            try:
                clear.click(force=True, timeout=3000)
                self._sleep(0.25)
            except Exception:
                pass
            for index in range(submenus.count() - 1, -1, -1):
                submenu = submenus.nth(index)
                try:
                    if submenu.is_visible():
                        return submenu
                except Exception:
                    continue
            self.log(f"清空描述子菜单第 {attempt + 1} 次未展开，正在重新打开菜单。")
        raise AutomationError("“清空描述”子菜单连续 5 次未能展开。")

    def _clear_description_kind(self, item: str) -> None:
        submenu = self._open_clear_description_menu()
        target = self._visible(submenu.get_by_text(item, exact=True))
        if target is None:
            raise AutomationError(f"清空描述子菜单中没有找到可见的“{item}”。")
        # 限定在已确认可见的子菜单内点击，避免 Playwright 命中页面中 display:none 的同名项。
        target.click(force=True, timeout=5000)
        self._confirm_if_present()

    def _replace_description(self) -> None:
        self.log("清空描述模块并引用全部轮播图")
        description_box = self.page.locator("#wirelessDescBox")
        visible_box = self._visible(description_box)
        if visible_box is not None:
            visible_box.hover()
            self._sleep(0.5)
        self._click_text("编辑描述", exact=True)
        self.page.get_by_text("Temu产品描述", exact=True).wait_for(
            state="visible", timeout=self.config.operation_timeout_seconds * 1000
        )
        self._clear_description_kind("清空图片模块")
        batch_menu = self._open_batch_menu()
        batch_upload = self._visible(batch_menu.get_by_text("批量传图", exact=True))
        if batch_upload is None:
            raise AutomationError("批量操作菜单已展开，但没有找到“批量传图”。")
        batch_upload.click(force=True)
        self._sleep(0.5)
        self._choose_carousel_images(all_images=True)
        self._click_dialog_button("确定")
        self._click_text("保存", exact=True, last=True)
        self._sleep(2)

    def _fill_job_fields(self, job: ProductJob) -> None:
        if not self.config.album_cleanup_enabled:
            return self._populate_job_fields(job)
        self._protect_album_page_images()
        self._ensure_album_space(job)
        try:
            self._populate_job_fields(job)
        except Exception as exc:
            # Some files may have reached the album without a readable thumbnail.
            # Keep deletion disabled for this batch; capacity-only checks may
            # still permit later products without deleting any unknown assets.
            if not self._album_cleanup_suspended:
                self.log("本款上传流程未完成，已暂停本批次自动删除；后续商品仅在图库空间充足时继续。")
            self._album_cleanup_suspended = True
            if not isinstance(exc, (StopRequested, TemplateValidationError)):
                from album_cleanup_policy import is_album_capacity_error
                if is_album_capacity_error(str(exc)):
                    raise AlbumSpaceError(
                        "上传途中图库空间不足，已停止整批并保留当前款及后续商品；"
                        "请人工处理空间后重新开始，已完成商品不会重复提交。") from exc
                self._check_album_upload_space()
            raise
        finally:
            self._protect_album_page_images(strict=False)

    def _populate_job_fields(self, job: ProductJob) -> None:
        options_from_config(self.config)
        if self.config.description_mode not in {"keep", "replace"}:
            raise AutomationError("产品描述模式无效，请选择保留模板或重新引用轮播图。")
        if self.config.listing_profile == "tshirt_bw":
            import tshirt_automation
            tshirt_automation.validate_bw_rows(self)
            if self.config.bw_first_color not in {"white", "black"}:
                raise AutomationError("黑白主图顺序无效，请重新选择颜色位置。")
            if len(job.images) - job.common_detail_count != 2:
                raise AutomationError("黑白T恤必须有两张商品主图，请重新扫描并核对排序。")
        self._fill_title("产品标题", job.listing_title)
        self._fill_title("英文标题", job.listing_title)
        if self.config.listing_profile in {"tshirt", "tshirt_bw"}:
            import tshirt_automation
            name = validate_article_name(self.config.article_name)
            row_count = tshirt_automation.color_row_count(self)
            template_id = parse_qs(urlsplit(self.config.template_url).query).get("id", [""])[0]
            numbers = ArticleNumberStore(APP_DIR / "article-numbers.json").reserve(
                f"{self.config.listing_profile}|{template_id}|{folder_key(job.folder)}",
                name, row_count=row_count,
            )
            self.log("T恤货号：" + "、".join(numbers))
            color_image_sets = None
            if self.config.listing_profile == "tshirt_bw":
                if len(job.images) - job.common_detail_count != 2:
                    raise AutomationError("黑白T恤必须有两张商品主图，请重新扫描并核对排序。")
                first, second = ("white", "black") if self.config.bw_first_color == "white" else ("black", "white")
                if job.color_image_sets:
                    color_image_sets = {color: list(paths) for color, paths in job.color_image_sets.items()}
                else:
                    details = load_color_detail_images(self.config)
                    color_image_sets = {
                        color: [item.path for item in mixed_upload_items(self.config, job.folder, [source], details[color], color)]
                        for color, source in ((first, job.images[0]), (second, job.images[1]))
                    }
                tshirt_automation.upload_images(self, job, numbers, prepare_image=self._prepare_upload_image,
                                                color_image_sets=color_image_sets)
            else:
                tshirt_automation.upload_images(self, job, numbers, prepare_image=self._prepare_upload_image)
            tshirt_automation.refresh_material_image(self)
        elif self.config.listing_profile == "blanket":
            self._upload_carousel(job)
            self._replace_variant_images()
        else:
            raise AutomationError("请选择“毛毯”、“T恤”或“黑白T恤”上架脚本。")
        if self.config.description_mode == "keep":
            self.log("产品描述图片：保留模板不变，跳过描述编辑、清空、重新引用与保存。")
        elif self.config.description_mode == "replace":
            self._replace_description()
            if self.config.listing_profile in {"tshirt", "tshirt_bw"}:
                tshirt_automation.verify_description_images(self)
        else:
            raise AutomationError("产品描述模式无效，请选择保留模板或重新引用轮播图。")

    def _install_publish_monitor(self) -> None:
        """Record short-lived toast/dialog text before it disappears."""
        try:
            self.page.evaluate(
                """
                () => {
                    if (window.__dxmPublishObserver) {
                        window.__dxmPublishObserver.disconnect();
                    }
                    window.__dxmPublishEvents = [];
                    const remember = (node) => {
                        if (!node) return;
                        const raw = node.innerText || node.textContent || '';
                        const text = String(raw).replace(/\s+/g, ' ').trim();
                        if (text && text.length <= 600) {
                            window.__dxmPublishEvents.push(text);
                            if (window.__dxmPublishEvents.length > 100) {
                                window.__dxmPublishEvents.shift();
                            }
                        }
                    };
                    window.__dxmPublishObserver = new MutationObserver((mutations) => {
                        for (const mutation of mutations) {
                            for (const node of mutation.addedNodes) {
                                if (node.nodeType === Node.ELEMENT_NODE || node.nodeType === Node.TEXT_NODE) {
                                    remember(node);
                                }
                            }
                        }
                    });
                    window.__dxmPublishObserver.observe(document.documentElement, {
                        childList: true,
                        subtree: true,
                        characterData: true
                    });
                }
                """
            )
        except Exception:
            # Navigation can replace the document; URL/form checks cover that case.
            pass

    def _publish_feedback_messages(self) -> list[str]:
        messages: list[str] = []
        try:
            captured = self.page.evaluate("() => window.__dxmPublishEvents || []")
            if isinstance(captured, list):
                messages.extend(str(item) for item in captured[-100:])
        except Exception:
            pass

        selectors = (
            ".ant-message, .ant-notification, .el-message, .el-notification, "
            ".ivu-message, .layui-layer, [role='alert'], [role='status']"
        )
        try:
            nodes = self.page.locator(selectors)
            for index in range(min(nodes.count(), 30)):
                node = nodes.nth(index)
                try:
                    if node.is_visible():
                        text = node.inner_text().strip()
                        if text:
                            messages.append(text)
                except Exception:
                    pass
        except Exception:
            pass
        return list(dict.fromkeys(messages))

    def _dismiss_publish_result(self) -> None:
        """Close the accepted-submission dialog before the next product."""
        try:
            dialog = self._top_dialog()
            dialog_text = dialog.inner_text()
            if (
                "已提交" not in dialog_text
                and "已移入定时发布" not in dialog_text
                and "提交成功" not in dialog_text
            ):
                return
            close_button = self._visible(dialog.get_by_role("button", name="关闭", exact=True))
            if close_button is None:
                close_button = self._visible(dialog.get_by_text("关闭", exact=True))
            if close_button is not None:
                close_button.click(force=True)
                self._sleep(0.5)
        except Exception:
            # The next product explicitly navigates back to the template page.
            pass

    @staticmethod
    def _owned_result_page(origin_page, pages_before: list[object]):
        for candidate in origin_page.context.pages:
            if candidate in pages_before or candidate.is_closed() or candidate.url == "about:blank":
                continue
            try:
                opener = candidate.opener
                if callable(opener):
                    opener = opener()
                if opener is origin_page:
                    return candidate
            except Exception:
                continue
        return None

    def _publish_now(self) -> None:
        self.log("选择立即发布")
        origin_page = self.page
        before_url = self.page.url
        pages_before = list(self.page.context.pages)
        self._install_publish_monitor()
        self._click_text("发布", exact=True, last=True)
        self._click_text("立即发布", exact=True, last=True)
        self._confirm_if_present()
        self.log("立即发布请求已提交，正在确认平台返回结果…")

        deadline = time.monotonic() + max(20, self.config.operation_timeout_seconds)
        next_progress_log = time.monotonic() + 5
        editor_missing_since: Optional[float] = None
        while time.monotonic() < deadline:
            self._check_stop()
            if self.page.is_closed():
                owned_result = self._owned_result_page(origin_page, pages_before)
                if owned_result is not None:
                    self.page = owned_result
                    self.log("检测到当前工作页打开的发布结果页面。")
                elif self.worker_slot:
                    self.log("提交后当前工作页已关闭，判定平台已接收立即发布请求。")
                    return
            if self.page.is_closed():
                remaining_pages = [page for page in self.page.context.pages if not page.is_closed()]
                if not remaining_pages:
                    raise AutomationError("点击立即发布后浏览器页面被关闭，无法确认发布结果。")
                self.page = remaining_pages[-1]

            candidate = self._owned_result_page(origin_page, pages_before)
            if candidate is not None and candidate is not self.page:
                self.page = candidate
                self.log("检测到当前工作页打开的发布结果页面。")

            if self.page.url != before_url and self.page.url != "about:blank":
                self.log("检测到立即发布后页面已跳转。")
                return

            feedback = self._publish_feedback_messages()
            status, detail = classify_publish_feedback(feedback)
            if status == "success":
                self.log(f"平台已接受立即发布：{detail}")
                self._dismiss_publish_result()
                return
            if status == "error":
                raise AutomationError(f"平台返回发布校验错误：{detail}")

            title_input = self.page.locator(
                "xpath=//label[@title='产品标题']/ancestor::div[contains(concat(' ',normalize-space(@class),' '),' ant-form-item ')][1]//input[1]"
            )
            if self._visible(title_input) is None:
                if editor_missing_since is None:
                    editor_missing_since = time.monotonic()
                elif time.monotonic() - editor_missing_since >= 2:
                    self.log("立即发布后编辑表单已关闭，判定提交完成。")
                    return
            else:
                editor_missing_since = None

            now = time.monotonic()
            if now >= next_progress_log:
                remaining = max(0, int(deadline - now))
                self.log(f"仍在等待平台确认立即发布结果，最多再等 {remaining} 秒…")
                next_progress_log = now + 5
            self._sleep(0.5)

        feedback = self._publish_feedback_messages()
        detail = "；".join(feedback[-3:])[:500]
        suffix = f" 页面提示：{detail}" if detail else ""
        raise AutomationError(
            "点击立即发布后，平台未返回可确认的成功结果；本商品将记录问题并跳过，"
            "且不会写入完成记录。" + suffix
        )

    def _schedule_publish(self) -> datetime:
        now = datetime.now().astimezone()
        target = (now + timedelta(days=1)).replace(
            hour=max(0, min(23, int(self.config.schedule_hour))),
            minute=max(0, min(59, int(self.config.schedule_minute))),
            second=0,
            microsecond=0,
        )
        self.log(f"选择定时发布：{target:%Y-%m-%d %H:%M:%S}")
        origin_page = self.page
        before_url = self.page.url
        pages_before = list(self.page.context.pages)
        self._install_publish_monitor()
        self._click_text("发布", exact=True, last=True)
        self._click_text("定时发布", exact=True, last=True)

        dialog = self._top_dialog()
        date_input = self._visible(dialog.locator("input[placeholder='请选择日期']"))
        if date_input is None:
            raise AutomationError("定时发布弹窗中没有找到日期输入框。")
        date_input.click()
        self._sleep(0.5)

        picker = self._visible(self.page.locator(".ant-picker-dropdown"))
        if picker is None:
            raise AutomationError("点击日期后没有找到日期时间选择器。")
        date_cell = self._visible(picker.locator(f"td[title='{target:%Y-%m-%d}']"))
        if date_cell is None:
            raise AutomationError(f"日期选择器中没有找到明天：{target:%Y-%m-%d}。")
        date_cell.click()

        columns = picker.locator(".ant-picker-time-panel-column")
        if columns.count() < 3:
            raise AutomationError("定时发布的时间选择器不是预期的时、分、秒三列。")
        time_values = (f"{target.hour:02d}", f"{target.minute:02d}", "00")
        for index, value in enumerate(time_values):
            option = self._visible(
                columns.nth(index).locator(".ant-picker-time-panel-cell-inner").filter(
                    has_text=re.compile(rf"^{re.escape(value)}$")
                )
            )
            if option is None:
                raise AutomationError(f"时间选择器中没有找到第 {index + 1} 列的 {value}。")
            option.click()
        picker_ok = self._visible(picker.get_by_role("button", name="确定", exact=True))
        if picker_ok is None:
            raise AutomationError("日期时间选择器中没有找到确定按钮。")
        picker_ok.click()
        self._sleep(0.5)

        selected_value = date_input.input_value().strip()
        expected_value = target.strftime("%Y-%m-%d %H:%M")
        if not selected_value.startswith(expected_value):
            raise AutomationError(
                f"定时日期回读校验失败：期望 {expected_value}，页面显示 {selected_value or '空'}。"
            )
        self.log(f"定时日期已校验：{selected_value}")
        self._click_dialog_button("确定")
        self.log("定时发布请求已提交，正在确认平台返回结果…")

        deadline = time.monotonic() + max(20, self.config.operation_timeout_seconds)
        next_progress_log = time.monotonic() + 5
        editor_missing_since: Optional[float] = None
        while time.monotonic() < deadline:
            self._check_stop()
            if self.page.is_closed():
                owned_result = self._owned_result_page(origin_page, pages_before)
                if owned_result is not None:
                    self.page = owned_result
                    self.log("检测到当前工作页打开的发布结果页面。")
                elif self.worker_slot:
                    self.log("提交后当前工作页已关闭，判定平台已接收定时发布请求。")
                    return target
            if self.page.is_closed():
                remaining_pages = [page for page in self.page.context.pages if not page.is_closed()]
                if not remaining_pages:
                    raise AutomationError("提交定时发布后浏览器页面被关闭，无法确认结果。")
                self.page = remaining_pages[-1]

            candidate = self._owned_result_page(origin_page, pages_before)
            if candidate is not None and candidate is not self.page:
                self.page = candidate
                self.log("检测到当前工作页打开的发布结果页面。")

            if self.page.url != before_url and self.page.url != "about:blank":
                self.log("检测到发布后页面已跳转。")
                return target

            feedback = self._publish_feedback_messages()
            status, detail = classify_publish_feedback(feedback)
            if status == "success":
                self.log(f"平台已接受定时发布：{detail}")
                self._dismiss_publish_result()
                return target
            if status == "error":
                raise AutomationError(f"平台返回发布校验错误：{detail}")

            title_input = self.page.locator(
                "xpath=//label[@title='产品标题']/ancestor::div[contains(concat(' ',normalize-space(@class),' '),' ant-form-item ')][1]//input[1]"
            )
            if self._visible(title_input) is None:
                if editor_missing_since is None:
                    editor_missing_since = time.monotonic()
                elif time.monotonic() - editor_missing_since >= 2:
                    self.log("发布后编辑表单已关闭，判定提交完成。")
                    return target
            else:
                editor_missing_since = None

            now = time.monotonic()
            if now >= next_progress_log:
                remaining = max(0, int(deadline - now))
                self.log(f"仍在等待平台确认发布结果，最多再等 {remaining} 秒…")
                next_progress_log = now + 5
            self._sleep(0.5)
        feedback = self._publish_feedback_messages()
        detail = "；".join(feedback[-3:])[:500]
        suffix = f" 页面提示：{detail}" if detail else ""
        raise AutomationError(
            "提交定时发布后，平台未返回可确认的结果；本商品将记录问题并跳过，"
            "且不会写入完成记录。" + suffix
        )

    def _remember_failure(self, failure: JobFailure) -> JobFailure:
        try:
            FailureStore(failure_record_directory(self.config)).record(
                failure.title, failure.reason, failure.product_folder,
                failure.evidence_dir, self.config.publish_mode,
                listing_profile=self.config.listing_profile,
                template_url=self.config.template_url,
                article_name=self.config.article_name,
            )
        except Exception as exc:
            self.log(f"失败清单保存异常，请保留文字汇总：{exc}")
        return failure

    def _resolve_failure(self, job: ProductJob) -> None:
        if not is_batch_submission_mode(self.config.publish_mode):
            return  # 发布前检查通过不等于已提交上架，仍保留失败记录。
        try:
            FailureStore(failure_record_directory(self.config)).resolve(job.folder)
        except Exception as exc:
            self.log(f"失败清单更新异常（完成记录已保留）：{exc}")

    def _capture_failure(self, job: ProductJob, reason: BaseException) -> Path:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        safe_name = re.sub(r"[^\w\-.]+", "_", job.title, flags=re.UNICODE)[:60]
        folder = LOG_DIR / f"{stamp}-{safe_name}"
        folder.mkdir(parents=True, exist_ok=True)
        (folder / "error.txt").write_text(
            f"{type(reason).__name__}: {reason}\n\n{traceback.format_exc()}", encoding="utf-8"
        )
        try:
            images = self.page.locator("img").evaluate_all(r"""els => els.map(el => {
                const src = el.getAttribute('src') || '';
                let model = null;
                for (let vm = el.__vueParentComponent, i = 0; vm && i < 8; vm = vm.parent, i++) {
                    const candidate = vm.props && vm.props.img;
                    if (candidate && typeof candidate === 'object' && candidate.url === src) {
                        model = candidate;
                        break;
                    }
                }
                const section = el.closest('#wirelessDescBox') ? 'description'
                    : el.closest('.material-img-module') ? 'material'
                    : el.closest('.image-box') ? 'color' : 'other';
                return {src, section, complete: el.complete,
                    naturalWidth: el.naturalWidth, naturalHeight: el.naturalHeight,
                    visible: !!el.getClientRects().length, siteModelAvailable: !!model,
                    siteWidth: model ? (model.width ?? null) : null,
                    siteHeight: model ? (model.height ?? null) : null};
            })""")
            (folder / "image-diagnostics.json").write_text(json.dumps({
                "processing": {"mode": self.config.image_processing_mode,
                               "width": self.config.image_target_width,
                               "height": self.config.image_target_height,
                               "max_edge": self.config.image_max_edge},
                "images": images,
            }, ensure_ascii=False, indent=2), encoding="utf-8")
        except Exception:
            pass
        try:
            self.page.screenshot(path=str(folder / "page.png"), full_page=True)
            (folder / "page.html").write_text(self.page.content(), encoding="utf-8")
        except Exception:
            pass
        return folder

    @staticmethod
    def _reserve_local_port() -> int:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
            listener.bind(("127.0.0.1", 0))
            return int(listener.getsockname()[1])

    def _start_shared_browser(self, browser_executable: str) -> tuple[subprocess.Popen, str]:
        PROFILE_DIR.mkdir(parents=True, exist_ok=True)
        port = self._reserve_local_port()
        endpoint = f"http://127.0.0.1:{port}"
        command = [
            browser_executable,
            f"--remote-debugging-port={port}",
            "--remote-debugging-address=127.0.0.1",
            f"--user-data-dir={PROFILE_DIR}",
            "--start-maximized",
            "--no-first-run",
            "--disable-default-apps",
            "--disable-background-mode",
            "--disable-blink-features=AutomationControlled",
            "about:blank",
        ]
        creation_flags = getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0
        process = subprocess.Popen(
            command,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=creation_flags,
        )
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            self._check_stop()
            if process.poll() is not None:
                raise AutomationError("三页面并发浏览器启动失败，请先关闭旧的自动化浏览器后重试。")
            try:
                with urllib.request.urlopen(f"{endpoint}/json/version", timeout=1) as response:
                    if json.load(response).get("webSocketDebuggerUrl"):
                        return process, endpoint
            except Exception:
                time.sleep(0.2)
        try:
            process.terminate()
        except Exception:
            pass
        raise AutomationError("三页面并发浏览器启动超时，请先关闭旧的自动化浏览器后重试。")

    @staticmethod
    def _stop_shared_browser(process: subprocess.Popen, endpoint: str) -> None:
        try:
            from playwright.sync_api import sync_playwright

            with sync_playwright() as playwright:
                browser = playwright.chromium.connect_over_cdp(endpoint)
                browser.close()
        except Exception:
            pass
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            try:
                process.terminate()
                process.wait(timeout=3)
            except Exception:
                try:
                    process.kill()
                except Exception:
                    pass

    def _process_parallel_job(
        self,
        context,
        job: ProductJob,
        position: int,
        total: int,
        state: StateStore,
    ) -> tuple[bool, Optional[JobFailure], str]:
        self._check_stop()
        self.log(f"[{position}/{total}] 开始：{job.title}")
        self.log(f"实际上架标题：{job.listing_title}")
        for attempt_number in range(1, self.max_job_attempts + 1):
            self._check_stop()
            if attempt_number > 1:
                self.log("正在从模板页完整重试当前商品（第 2 次，也是最后一次）。")
            try:
                if self.page is None or self.page.is_closed():
                    self.page = context.new_page()
                    self.page.set_default_timeout(self.config.operation_timeout_seconds * 1000)
                self._open_template()
                self._fill_job_fields(job)
                if self.config.publish_mode == "schedule":
                    scheduled_time = self._schedule_publish()
                    state.mark_completed(
                        job,
                        "scheduled",
                        scheduled_at=scheduled_time.isoformat(timespec="seconds"),
                    )
                    self.log(
                        f"已安排定时发布：{job.listing_title} → "
                        f"{scheduled_time:%Y-%m-%d %H:%M:%S}"
                    )
                else:
                    self._publish_now()
                    state.mark_completed(job, "published")
                    self.log(f"已提交立即发布：{job.listing_title}")
                self._resolve_failure(job)
                return True, None, ""
            except StopRequested:
                raise
            except TemplateValidationError as exc:
                failure_dir = self._capture_failure(job, exc)
                blocked = f"{exc}\n现场：{failure_dir}"
                self.log("当前并发页面的模板检查未通过，已停止领取新商品。")
                self.log(blocked)
                return False, None, blocked
            except Exception as exc:
                # A dead Playwright driver cannot capture evidence or retry inside the
                # same worker. Let the process supervisor reconnect this page and put
                # the current product back into the shared queue.
                if self._is_driver_disconnect(exc):
                    raise
                failure_dir = self._capture_failure(job, exc)
                failure = self._remember_failure(JobFailure(
                    title=job.title, reason=str(exc), evidence_dir=failure_dir,
                    product_folder=job.folder,
                ))
                self.log(f"第 {attempt_number} 次处理失败：{exc}")
                self.log(f"失败现场已保存：{failure_dir}")
                if self._should_retry_job(job, exc, attempt_number):
                    self.log("并发模式自动重试当前商品一次。")
                    continue
                if attempt_number >= self.max_job_attempts:
                    self.log("当前商品已达到本轮最大尝试次数。")
                self.log("已跳过当前商品，本页面继续领取下一款。")
                return (
                    False,
                    failure,
                    "",
                )
        return False, None, ""

    def _run_concurrent(
        self,
        pending: list[ProductJob],
        state: StateStore,
        already_completed: int,
        browser_executable: str,
    ) -> RunReport:
        from playwright.sync_api import sync_playwright

        worker_count = min(max(1, int(self.config.concurrent_pages)), 3, len(pending))
        self.log(f"批量模式启用 {worker_count} 个页面并发；每个页面一次只处理一个商品。")
        self.log("每个工作页使用独立进程和独立浏览器驱动；单页掉线不会拖停其他页面。")
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        process, endpoint = self._start_shared_browser(browser_executable)
        mp_context = multiprocessing.get_context("spawn")
        work_queue = mp_context.Queue()
        result_queue = mp_context.Queue()
        abort_batch = mp_context.Event()
        finish_workers = mp_context.Event()
        state_lock = mp_context.RLock()
        for position, job in enumerate(pending, start=1):
            work_queue.put((position, job, 0))

        succeeded = 0
        attempted = 0
        failures: list[JobFailure] = []
        blocked_reasons: list[str] = []
        completed_positions: set[int] = set()
        active_items: dict[int, tuple[int, tuple[int, ProductJob, int]]] = {}
        running_processes: dict[int, tuple[int, multiprocessing.Process]] = {}
        generations = {slot: 0 for slot in range(1, worker_count + 1)}
        startup_restarts = {slot: 0 for slot in range(1, worker_count + 1)}

        def start_worker(slot: int) -> None:
            generations[slot] += 1
            generation = generations[slot]
            worker_process = mp_context.Process(
                target=_parallel_worker_process,
                args=(
                    slot,
                    generation,
                    endpoint,
                    asdict(self.config),
                    work_queue,
                    result_queue,
                    abort_batch,
                    finish_workers,
                    state_lock,
                    self.max_job_attempts,
                    len(pending),
                    str(completion_state_path(self.config)),
                ),
                name=f"dxm-page-{slot}",
            )
            worker_process.start()
            running_processes[slot] = (generation, worker_process)

        try:
            with sync_playwright() as playwright:
                browser = playwright.chromium.connect_over_cdp(endpoint)
                context = browser.contexts[0]
                self.page = context.pages[0] if context.pages else context.new_page()
                self.page.set_default_timeout(self.config.operation_timeout_seconds * 1000)
                self.log("正在进行一次登录与模板总预检；此页随后直接作为页面 1 使用。")
                self._open_template()
                worker_pages = [self.page]
                while len(worker_pages) < worker_count:
                    worker_pages.append(context.new_page())
                for slot, worker_page in enumerate(worker_pages, start=1):
                    worker_page.evaluate(
                        "marker => { window.name = marker; }",
                        _parallel_page_marker(slot),
                    )
                for extra_page in context.pages:
                    if extra_page not in worker_pages:
                        try:
                            extra_page.close()
                        except Exception:
                            pass
                self.log(
                    f"登录与模板总预检通过，已准备 {worker_count} 个固定工作页；不会再额外保留预检页。"
                )
                self.page = None

            for slot in range(1, worker_count + 1):
                start_worker(slot)

            remaining = len(pending)
            while remaining > 0 and not abort_batch.is_set():
                if self.stopped.is_set():
                    abort_batch.set()
                    break
                try:
                    message = result_queue.get(timeout=0.35)
                except queue.Empty:
                    message = None

                if message is not None:
                    message_type = message.get("type")
                    slot = int(message.get("slot", 0) or 0)
                    generation = int(message.get("generation", 0) or 0)
                    if message_type == "log":
                        self.log(f"[页面 {slot}] {message.get('message', '')}")
                    elif generation != generations.get(slot):
                        # A delayed message from a worker that has already been replaced.
                        continue
                    elif message_type == "job_started":
                        active_items[slot] = (generation, message["item"])
                    elif message_type == "job_result":
                        active_items.pop(slot, None)
                        position = int(message["position"])
                        if position in completed_positions:
                            continue
                        attempted += 1
                        blocked = str(message.get("blocked", ""))
                        if blocked:
                            blocked_reasons.append(blocked)
                            abort_batch.set()
                            continue
                        completed_positions.add(position)
                        remaining -= 1
                        if message.get("success"):
                            succeeded += 1
                        failure = message.get("failure")
                        if failure is not None:
                            failures.append(failure)
                    elif message_type == "worker_fatal":
                        item = message.get("item")
                        active_items.pop(slot, None)
                        reason = str(message.get("reason", "并发页面驱动异常"))
                        if item is not None:
                            position, job, reconnect_count = item
                            position = int(position)
                            reconnect_count = int(reconnect_count)
                            refreshed_state = StateStore(completion_state_path(self.config))
                            if refreshed_state.is_completed(job):
                                if position not in completed_positions:
                                    completed_positions.add(position)
                                    remaining -= 1
                                    attempted += 1
                                    succeeded += 1
                                self.log(
                                    f"[页面 {slot}] 驱动断线前商品已经完成，已按完成记录确认。"
                                )
                            elif reconnect_count < 2:
                                work_queue.put((position, job, reconnect_count + 1))
                                self.log(
                                    f"[页面 {slot}] 浏览器驱动已断线，当前商品已放回队列；"
                                    f"正在重建该页面（{reconnect_count + 1}/2），其他页面不受影响。"
                                )
                            elif position not in completed_positions:
                                completed_positions.add(position)
                                remaining -= 1
                                attempted += 1
                                failures.append(
                                    JobFailure(
                                        title=job.title,
                                        reason=f"工作页连续掉线，自动重建 2 次后仍失败：{reason}",
                                        evidence_dir=LOG_DIR,
                                        product_folder=job.folder,
                                    )
                                )
                        else:
                            startup_restarts[slot] += 1
                            if startup_restarts[slot] > 2:
                                blocked_reasons.append(
                                    f"页面 {slot} 连续 3 次无法连接浏览器驱动：{reason}"
                                )
                                abort_batch.set()
                                continue
                        if not abort_batch.is_set() and remaining > 0:
                            start_worker(slot)

                # Detect a hard process exit even if it could not write an error event.
                for slot, (generation, worker_process) in list(running_processes.items()):
                    if generation != generations[slot] or worker_process.is_alive():
                        continue
                    if remaining > 0 and not abort_batch.is_set():
                        active = active_items.pop(slot, None)
                        if active is not None and active[0] == generation:
                            position, job, reconnect_count = active[1]
                            if reconnect_count < 2:
                                work_queue.put((position, job, reconnect_count + 1))
                                self.log(
                                    f"[页面 {slot}] 工作进程意外退出，当前商品已放回队列。"
                                )
                            elif position not in completed_positions:
                                completed_positions.add(position)
                                remaining -= 1
                                attempted += 1
                                failures.append(
                                    JobFailure(
                                        title=job.title,
                                        reason="工作页进程连续意外退出，自动重建 2 次后仍失败。",
                                        evidence_dir=LOG_DIR,
                                        product_folder=job.folder,
                                    )
                                )
                        startup_restarts[slot] += 1
                        if startup_restarts[slot] <= 2:
                            self.log(f"[页面 {slot}] 工作进程意外退出，正在自动重建。")
                            start_worker(slot)
                        else:
                            blocked_reasons.append(
                                f"页面 {slot} 工作进程连续退出，已停止本批次。"
                            )
                            abort_batch.set()
                            break
        finally:
            finish_workers.set()
            if self.stopped.is_set():
                abort_batch.set()
            for _, worker_process in list(running_processes.values()):
                worker_process.join(timeout=8)
                if worker_process.is_alive():
                    worker_process.terminate()
                    worker_process.join(timeout=3)
            self._stop_shared_browser(process, endpoint)

        if self.stopped.is_set():
            raise StopRequested("用户已停止三页面并发任务。")

        order = {_path_identity(job.folder): index for index, job in enumerate(pending)}
        failures.sort(
            key=lambda failure: order.get(
                _path_identity(failure.product_folder)
                if failure.product_folder is not None
                else "",
                len(pending),
            )
        )
        blocked_reason = blocked_reasons[0] if blocked_reasons else ""
        pending_count = (
            max(0, len(pending) - succeeded - len(failures))
            if blocked_reason
            else 0
        )
        if blocked_reason:
            attempted = len(pending) - pending_count
        report = RunReport(
            attempted=attempted,
            succeeded=succeeded,
            failures=failures,
            already_completed=already_completed,
            blocked_reason=blocked_reason,
            pending_count=pending_count,
        )
        for failure in failures:
            self._remember_failure(failure)
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        report.report_path = LOG_DIR / f"run-summary-{stamp}.txt"
        report.report_path.write_text(report.render(), encoding="utf-8")
        self.log(report.render(max_failures=10))
        return report

    def run(self, jobs: list[ProductJob], review_count: int = 1,
            strict_completion: bool = False) -> RunReport:
        from playwright.sync_api import sync_playwright

        browser_executable = find_browser(self.config.browser_path)
        state = StateStore(completion_state_path(self.config))
        pending = [job for job in jobs if not state.is_completed(job, strict=strict_completion)]
        already_completed = len(jobs) - len(pending)
        if not pending:
            self.log("没有待处理商品；如需重跑，请在界面中点击“清除完成记录”。")
            return RunReport(
                attempted=0,
                succeeded=0,
                failures=[],
                already_completed=already_completed,
            )
        if (
            is_batch_submission_mode(self.config.publish_mode)
            and effective_concurrent_pages(self.config) > 1
            and len(pending) > 1
        ):
            return self._run_concurrent(
                pending,
                state,
                already_completed,
                browser_executable,
            )
        if not is_batch_submission_mode(self.config.publish_mode):
            pending = pending_jobs_for_run(self.config, jobs, strict=strict_completion,
                                            review_count=review_count, state=state)
            if len(pending) == 1:
                self.log("当前为发布前检查模式：只处理第一个待处理商品，并停在发布按钮前。")
            else:
                self.log(f"当前为连续性检查模式：连续处理 {len(pending)} 个商品，最后一款停在发布前。")

        LOG_DIR.mkdir(parents=True, exist_ok=True)
        PROFILE_DIR.mkdir(parents=True, exist_ok=True)
        succeeded = 0
        failures: list[JobFailure] = []
        blocked_reason = ""
        pending_count = 0
        blocked_category = "template"
        if self.config.album_cleanup_enabled:
            self.log(f"图库自动清理已开启：低于 {self.config.album_cleanup_threshold_mb}MB 时处理末两页，每次最多600张；本批次使用单工作页。")
        with sync_playwright() as playwright:
            context = playwright.chromium.launch_persistent_context(
                user_data_dir=str(PROFILE_DIR),
                executable_path=browser_executable,
                headless=False,
                viewport=None,
                args=["--start-maximized", "--disable-blink-features=AutomationControlled"],
            )
            self.page = context.pages[0] if context.pages else context.new_page()
            self.page.set_default_timeout(self.config.operation_timeout_seconds * 1000)
            try:
                for position, job in enumerate(pending, start=1):
                    self._check_stop()
                    self.log(f"[{position}/{len(pending)}] 开始：{job.title}")
                    self.log(f"实际上架标题：{job.listing_title}")
                    for attempt_number in range(1, self.max_job_attempts + 1):
                        self._check_stop()
                        if attempt_number > 1:
                            self.log("正在从模板页完整重试当前商品（第 2 次，也是最后一次）。")
                        try:
                            if self.page is None or self.page.is_closed():
                                self.page = context.new_page()
                                self.page.set_default_timeout(
                                    self.config.operation_timeout_seconds * 1000
                                )
                            self._open_template()
                            self._fill_job_fields(job)
                            if self.config.publish_mode == "schedule":
                                scheduled_time = self._schedule_publish()
                                state.mark_completed(
                                    job,
                                    "scheduled",
                                    scheduled_at=scheduled_time.isoformat(timespec="seconds"),
                                )
                                self.log(
                                    f"已安排定时发布：{job.listing_title} → "
                                    f"{scheduled_time:%Y-%m-%d %H:%M:%S}"
                                )
                                succeeded += 1
                            elif self.config.publish_mode == "publish":
                                self._publish_now()
                                state.mark_completed(job, "published")
                                self.log(f"已提交立即发布：{job.listing_title}")
                                succeeded += 1
                            else:
                                screenshot_name = f"continuity-{position:02d}.png"
                                html_name = f"continuity-{position:02d}.html"
                                self.page.screenshot(path=str(LOG_DIR / screenshot_name), full_page=True)
                                (LOG_DIR / html_name).write_text(self.page.content(), encoding="utf-8")
                                succeeded += 1
                                if position < len(pending):
                                    self.log(f"第 {position} 款已完成发布前流程，正在进入下一款。")
                                else:
                                    self.page.screenshot(path=str(LOG_DIR / "review-ready.png"), full_page=True)
                                    self.log(
                                        f"连续 {len(pending)} 款已处理完成；最后一款停在发布前。"
                                        "请在浏览器核对，核对完关闭浏览器即可。"
                                    )
                                    while not self.stopped.is_set() and not self.page.is_closed():
                                        time.sleep(0.25)
                            self._resolve_failure(job)
                            break
                        except StopRequested:
                            raise
                        except TemplateValidationError as exc:
                            failure_dir = self._capture_failure(job, exc)
                            blocked_reason = f"{exc}\n现场：{failure_dir}"
                            pending_count = len(pending) - position + 1
                            blocked_category = "album" if isinstance(exc, AlbumSpaceError) else "template"
                            self.log("图库空间检查或清理未完成，已停止整批；保留剩余待处理商品。" if blocked_category == "album"
                                     else "模板检查未通过，已停止整批；本轮未继续上传或提交，不再逐款重试。")
                            self.log(blocked_reason)
                            break
                        except Exception as exc:
                            failure_dir = self._capture_failure(job, exc)
                            failure = self._remember_failure(JobFailure(
                                title=job.title, reason=str(exc), evidence_dir=failure_dir,
                                product_folder=job.folder,
                            ))
                            self.log(f"第 {attempt_number} 次处理失败：{exc}")
                            self.log(f"失败现场已保存：{failure_dir}")
                            if self._should_retry_job(job, exc, attempt_number):
                                self.log("已选择重试当前商品。")
                                continue
                            if attempt_number >= self.max_job_attempts:
                                if self.max_job_attempts == 1:
                                    self.log("失败商品补跑仍然报错；本轮不再尝试此商品。")
                                else:
                                    self.log("第二次仍然报错；本轮不再尝试此商品。")
                            else:
                                self.log("已选择不重试此商品。")
                            self.log("已跳过当前商品，将继续处理下一款。")
                            failures.append(failure)
                            break
                    if blocked_reason:
                        break
            finally:
                if is_batch_submission_mode(self.config.publish_mode) or self.stopped.is_set() or failures or blocked_reason:
                    try:
                        context.close()
                    except Exception:
                        pass

        report = RunReport(
            attempted=len(pending) - pending_count,
            succeeded=succeeded,
            failures=failures,
            already_completed=already_completed,
            blocked_reason=blocked_reason,
            pending_count=pending_count,
            blocked_category=blocked_category,
        )
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        report.report_path = LOG_DIR / f"run-summary-{stamp}.txt"
        report.report_path.write_text(report.render(), encoding="utf-8")
        self.log(report.render(max_failures=10))
        return report


def _parallel_page_marker(slot: int) -> str:
    return f"dxm-parallel-page-{int(slot)}"


def _parallel_worker_process(
    slot: int,
    generation: int,
    endpoint: str,
    config_data: dict,
    work_queue,
    result_queue,
    abort_batch,
    finish_workers,
    state_lock,
    max_job_attempts: int,
    total_jobs: int,
    state_path: str,
) -> None:
    """Run one browser page in its own process and Playwright driver.

    Playwright's synchronous Python client owns thread-local greenlet state. Keeping
    one client in each OS process prevents one page's driver shutdown from closing
    the connections used by the other pages.
    """
    from playwright.sync_api import sync_playwright

    allowed = set(AppConfig.__dataclass_fields__)
    config = AppConfig(**{key: value for key, value in config_data.items() if key in allowed})

    def emit(message: str) -> None:
        result_queue.put(
            {
                "type": "log",
                "slot": slot,
                "generation": generation,
                "message": str(message),
            }
        )

    worker = DxmUploader(
        config,
        emit,
        abort_batch,
        retry_decider=None,
        max_job_attempts=max_job_attempts,
        worker_slot=slot,
        upload_stage_dir=UPLOAD_STAGE_DIR / f"page-{slot}",
    )
    state = StateStore(Path(state_path), process_lock=state_lock)
    current_item = None
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.connect_over_cdp(endpoint)
            if not browser.contexts:
                raise AutomationError("没有找到店小秘共享登录会话。")
            context = browser.contexts[0]
            marker = _parallel_page_marker(slot)
            page = None
            for candidate in context.pages:
                try:
                    if candidate.evaluate("() => window.name") == marker:
                        page = candidate
                        break
                except Exception:
                    continue
            if page is None:
                page = context.new_page()
                page.evaluate("value => { window.name = value; }", marker)
                emit("固定工作页不存在，已只重建当前页面。")
            worker.page = page
            page.set_default_timeout(config.operation_timeout_seconds * 1000)
            worker._open_template()
            emit("工作页连接成功，开始独立领取商品。")

            while not abort_batch.is_set():
                if finish_workers.is_set():
                    break
                try:
                    item = work_queue.get(timeout=0.5)
                except queue.Empty:
                    continue
                current_item = item
                position, job, reconnect_count = item
                result_queue.put(
                    {
                        "type": "job_started",
                        "slot": slot,
                        "generation": generation,
                        "item": item,
                    }
                )
                success, failure, blocked = worker._process_parallel_job(
                    context,
                    job,
                    int(position),
                    int(total_jobs),
                    state,
                )
                result_queue.put(
                    {
                        "type": "job_result",
                        "slot": slot,
                        "generation": generation,
                        "position": int(position),
                        "success": bool(success),
                        "failure": failure,
                        "blocked": blocked,
                    }
                )
                current_item = None
                if blocked:
                    abort_batch.set()
                    break
    except StopRequested:
        pass
    except BaseException as exc:
        result_queue.put(
            {
                "type": "worker_fatal",
                "slot": slot,
                "generation": generation,
                "item": current_item,
                "reason": f"{type(exc).__name__}: {exc}",
            }
        )
    finally:
        result_queue.put(
            {
                "type": "worker_done",
                "slot": slot,
                "generation": generation,
            }
        )


class UploaderApp:
    def __init__(self) -> None:
        self.config = AppConfig.load()
        self.root = tk.Tk()
        self.root.title("店小秘 Temu 批量上架 · 独立版")
        self.root.geometry(f"{min(920, self.root.winfo_screenwidth() - 64)}x{min(720, self.root.winfo_screenheight() - 80)}")
        self.root.minsize(820, 620)
        self.messages: queue.Queue[tuple[str, object]] = queue.Queue()
        self.stop_event = threading.Event()
        self.worker: Optional[threading.Thread] = None
        self._last_blocked_signature: tuple[str, ...] = ()
        self._last_count_warning_signature: tuple[str, ...] = ()
        self._initial_report: Optional[RunReport] = None
        self._batch_jobs: list[ProductJob] = []
        self._batch_config: Optional[AppConfig] = None
        self.failure_store = FailureStore(failure_record_directory(self.config))
        self._failure_dialog = None
        self._failure_records: list[FailureRecord] = []
        self._pending_jobs: list[ProductJob] = []
        self.failure_scope_var = tk.StringVar(value="当前目录")
        self.batch_progress_var = tk.StringVar()

        self.path_var = tk.StringVar(value=self.config.product_root)
        self.common_detail_paths = list(self.config.common_detail_images)
        self.common_detail_summary_var = tk.StringVar()
        self.url_var = tk.StringVar(value=self.config.template_url)
        self.profile_var = tk.StringVar(value=self.config.listing_profile)
        self.article_name_var = tk.StringVar(value=self.config.article_name)
        self.article_preview_var = tk.StringVar()
        self.bw_order_var = tk.StringVar(value="第1张白色，第2张黑色" if self.config.bw_first_color == "white" else "第1张黑色，第2张白色")
        self.description_mode_var = tk.StringVar(value=self.config.description_mode)
        self.mode_var = tk.StringVar(value=self.config.publish_mode)
        self.status_var = tk.StringVar(value="请选择商品图片总目录。")
        self.failure_summary_var = tk.StringVar(value="失败记录 / 文件夹")
        self._refresh_common_detail_summary()
        self._build_ui()
        from portable_runtime import attach_support_ui
        attach_support_ui(self)
        self.root.after(0, self._refresh_failure_records)
        self.root.after(100, self._drain_messages)

    def _build_ui(self) -> None:
        body = ttk.Frame(self.root, padding=16)
        body.pack(fill="both", expand=True)
        body.columnconfigure(0, weight=1)
        body.rowconfigure(3, weight=1, minsize=80)

        # Only settings scroll.  Progress, task controls and the support toolbar
        # remain visible on small screens and when image summaries wrap.
        settings_viewport = ttk.Frame(body)
        settings_viewport.grid(row=0, column=0, columnspan=2, sticky="nsew")
        settings_viewport.columnconfigure(0, weight=1)
        settings_viewport.rowconfigure(0, weight=1)
        self.settings_canvas = tk.Canvas(
            settings_viewport, height=300, highlightthickness=0, borderwidth=0,
            yscrollincrement=24, takefocus=False,
        )
        self.settings_canvas.grid(row=0, column=0, sticky="nsew")
        self.settings_scrollbar = ttk.Scrollbar(
            settings_viewport, orient="vertical", command=self.settings_canvas.yview,
        )
        self.settings_scrollbar.grid(row=0, column=1, sticky="ns")
        self.settings_canvas.configure(yscrollcommand=self.settings_scrollbar.set)
        outer = self.settings_frame = ttk.Frame(self.settings_canvas)
        outer.columnconfigure(1, weight=1)
        settings_window = self.settings_canvas.create_window((0, 0), window=outer, anchor="nw")

        ttk.Label(outer, text="商品图片总目录").grid(row=0, column=0, sticky="w", pady=6)
        ttk.Entry(outer, textvariable=self.path_var).grid(row=0, column=1, sticky="ew", padx=8)
        product_buttons = ttk.Frame(outer)
        product_buttons.grid(row=0, column=2, sticky="e")
        ttk.Button(product_buttons, text="选择目录", command=self._choose_folder).pack(side="left")
        ttk.Button(
            product_buttons,
            text="图片混合排序",
            command=self._preview_product_images,
        ).pack(side="left", padx=(4, 0))
        self.bw_mapping_button = ttk.Button(product_buttons, text="黑白对应", command=self._preview_original_product_images)
        self.bw_mapping_button.pack(side="left", padx=(4, 0))

        self.common_detail_label = ttk.Label(outer, text="通用细节图")
        self.common_detail_label.grid(row=1, column=0, sticky="nw", pady=8)
        detail_frame = ttk.Frame(outer)
        self.common_detail_frame = detail_frame
        detail_frame.grid(row=1, column=1, columnspan=2, sticky="ew", padx=8, pady=2)
        detail_frame.columnconfigure(0, weight=1)
        ttk.Label(
            detail_frame,
            textvariable=self.common_detail_summary_var,
            wraplength=540,
            foreground="#555",
        ).grid(row=0, column=0, sticky="w")
        ttk.Button(
            detail_frame,
            text="添加图片",
            command=self._choose_common_detail_images,
        ).grid(row=0, column=1, padx=(8, 4))
        ttk.Button(
            detail_frame,
            text="预览排序",
            command=self._preview_common_detail_images,
        ).grid(row=0, column=2, padx=(0, 4))
        ttk.Button(
            detail_frame,
            text="清空",
            command=self._clear_common_detail_images,
        ).grid(row=0, column=3)

        from color_detail_ui import ColorDetailPanel
        self.bw_detail_frame = ttk.Frame(outer)
        self.bw_detail_frame.grid(row=1, column=0, columnspan=3, sticky="ew", pady=2)
        self.color_detail_panel = ColorDetailPanel(
            self.bw_detail_frame, list(self.config.white_detail_images), list(self.config.black_detail_images),
            self._on_color_detail_change, maximum=max(0, self.config.max_images - 1))
        self.color_detail_panel.pack(fill="x")
        self.bw_detail_note = ttk.Label(self.bw_detail_frame, foreground="#9a5800", wraplength=810)
        self.bw_detail_note.pack(anchor="w", pady=(2, 3))
        self.bw_detail_frame.grid_remove()

        ttk.Label(outer, text="模板编辑网址").grid(row=2, column=0, sticky="w", pady=6)
        url_entry = ttk.Entry(outer, textvariable=self.url_var)
        url_entry.grid(row=2, column=1, columnspan=2, sticky="ew", padx=8)
        url_entry.bind("<FocusOut>", lambda event: self._normalize_template_entry())
        url_entry.bind("<<Paste>>", lambda event: self.root.after_idle(self._normalize_template_entry))

        ttk.Label(outer, text="上架脚本").grid(row=3, column=0, sticky="w", pady=6)
        profile_frame = ttk.Frame(outer)
        profile_frame.grid(row=3, column=1, columnspan=2, sticky="ew", padx=8)
        ttk.Radiobutton(profile_frame, text="毛毯", value="blanket", variable=self.profile_var,
                        command=self._update_profile_controls).pack(side="left")
        ttk.Radiobutton(profile_frame, text="T恤", value="tshirt", variable=self.profile_var,
                        command=self._update_profile_controls).pack(side="left", padx=(8, 8))
        ttk.Radiobutton(profile_frame, text="黑白T恤", value="tshirt_bw", variable=self.profile_var,
                        command=self._update_profile_controls).pack(side="left", padx=(0, 16))
        ttk.Label(profile_frame, text="货号英文名").pack(side="left")
        self.article_name_entry = ttk.Entry(profile_frame, textvariable=self.article_name_var, width=11)
        self.article_name_entry.pack(side="left", padx=6)
        ttk.Label(profile_frame, textvariable=self.article_preview_var, foreground="#555").pack(side="left")
        self.profile_options = ttk.Frame(outer)
        self.profile_options.grid(row=4, column=0, columnspan=3, sticky="ew", pady=4)
        ttk.Label(self.profile_options, text="描述图片").pack(side="left")
        ttk.Radiobutton(self.profile_options, text="保留模板不变", value="keep", variable=self.description_mode_var).pack(side="left", padx=(10, 4))
        ttk.Radiobutton(self.profile_options, text="重新引用轮播图", value="replace", variable=self.description_mode_var).pack(side="left")
        self.bw_order_selector = ttk.Combobox(self.profile_options, textvariable=self.bw_order_var, width=23,
                                             state="readonly", values=["第1张白色，第2张黑色", "第1张黑色，第2张白色"])
        self.bw_order_selector.pack(side="left", padx=10)
        self.bw_template_button = ttk.Button(self.profile_options, text="填入黑白模板", command=lambda: self.url_var.set(BW_TEMPLATE_URL))
        self.bw_template_button.pack(side="left")
        self.article_name_var.trace_add("write", lambda *args: self._update_profile_controls())
        self._update_profile_controls()

        from image_processing_ui import ImageProcessingPanel
        self.image_processing_panel = ImageProcessingPanel(outer, options_from_config(self.config))
        self.image_processing_panel.grid(row=5, column=0, columnspan=3, sticky="ew", pady=(4, 6))
        from album_cleanup_ui import AlbumCleanupPanel
        self.album_cleanup_panel = AlbumCleanupPanel(outer, self.config.album_cleanup_enabled,
                                                      self.config.album_cleanup_threshold_mb)
        self.album_cleanup_panel.grid(row=6, column=0, columnspan=3, sticky="ew", pady=(1, 6))

        ttk.Label(outer, text="运行模式").grid(row=7, column=0, sticky="w", pady=6)
        mode_frame = ttk.Frame(outer)
        mode_frame.grid(row=7, column=1, columnspan=2, sticky="w", padx=8)
        ttk.Radiobutton(
            mode_frame,
            text="发布前检查（推荐，先跑 1 个）",
            value="review",
            variable=self.mode_var,
        ).pack(side="left", padx=(0, 18))
        ttk.Radiobutton(
            mode_frame,
            text="批量定时发布（明天 10:00）",
            value="schedule",
            variable=self.mode_var,
        ).pack(side="left", padx=(0, 18))
        ttk.Radiobutton(
            mode_frame,
            text="批量立即发布",
            value="publish",
            variable=self.mode_var,
        ).pack(side="left")

        note = (
            "每个一级子文件夹是一款商品，文件夹名生成标题。普通脚本支持单张图；黑白T恤需恰好2张对应主图，"
            "按上方顺序匹配白色、黑色。商品图和细节图可在“图片混合排序”中穿插排列，第1张为实际上传主图。"
            "每次开始前须核对抽样缩略图。首次请用发布前检查核对1款。"
            f"批量最多 {self.config.concurrent_pages} 页；失败记录可单独补跑。"
        )
        settings_note = ttk.Label(outer, text=note, wraplength=790, foreground="#555")
        settings_note.grid(
            row=8, column=0, columnspan=3, sticky="w", pady=(4, 10)
        )

        actions = ttk.Frame(body)
        actions.grid(row=1, column=0, columnspan=2, sticky="ew", pady=6)
        self.scan_button = ttk.Button(actions, text="扫描预览", command=self._scan)
        self.scan_button.pack(side="left")
        self.start_button = ttk.Button(actions, text="开始运行", command=self._start)
        self.start_button.pack(side="left", padx=8)
        self.stop_button = ttk.Button(actions, text="停止", command=self._stop, state="disabled")
        self.stop_button.pack(side="left")
        ttk.Button(actions, textvariable=self.failure_summary_var,
                   command=self._show_failure_records).pack(side="left", padx=8)
        self.retry_failed_button = ttk.Button(
            actions, text="一键重试失败项", command=self._retry_failed_records,
        )
        self.retry_failed_button.pack(side="left")
        ttk.Button(actions, text="清除完成记录", command=self._clear_state).pack(side="right")

        self.status_label = ttk.Label(
            body, textvariable=self.status_var, foreground="#0b63a8"
        )
        self.status_label.grid(row=2, column=0, columnspan=2, sticky="w", pady=5)
        self.log_box = tk.Text(body, height=1, wrap="word", state="disabled")
        self.log_box.grid(row=3, column=0, sticky="nsew")
        scrollbar = ttk.Scrollbar(body, orient="vertical", command=self.log_box.yview)
        scrollbar.grid(row=3, column=1, sticky="ns")
        self.log_box.configure(yscrollcommand=scrollbar.set)

        def resize_settings(_event=None):
            width = self.settings_canvas.winfo_width()
            self.settings_canvas.itemconfigure(settings_window, width=width)
            if width > 100:
                for label in (settings_note, self.bw_detail_note,
                              *[child for panel in (self.album_cleanup_panel, self.image_processing_panel)
                                for child in panel.winfo_children()
                                if child.winfo_class() == "TLabel"]):
                    label.configure(wraplength=max(100, width - 4))
            self.settings_canvas.configure(scrollregion=self.settings_canvas.bbox("all"))
            # Reserve the fixed controls and at least 80 pixels of live log.
            available = (body.winfo_height() - 32 - actions.winfo_reqheight() - 12
                         - self.status_label.winfo_reqheight() - 10 - 80)
            height = min(outer.winfo_reqheight(), max(100, available))
            if int(self.settings_canvas.cget("height")) != height:
                self.settings_canvas.configure(height=height)
            if outer.winfo_reqheight() <= height:
                self.settings_canvas.yview_moveto(0)

        self.settings_canvas.bind("<Configure>", resize_settings)
        outer.bind("<Configure>", resize_settings)
        body.bind("<Configure>", resize_settings)
        self.root.after_idle(resize_settings)

        def scroll_settings(event):
            units = -int(event.delta / 120) if event.delta else 0
            if not units and event.delta:
                units = -1 if event.delta > 0 else 1
            if getattr(event, "num", None) in (4, 5):
                units = -1 if event.num == 4 else 1
            if units:
                self.settings_canvas.yview_scroll(units, "units")
            return "break"

        def reveal_setting(event):
            top = event.widget.winfo_rooty() - self.settings_canvas.winfo_rooty()
            bottom = top + event.widget.winfo_height()
            if top < 0:
                self.settings_canvas.yview_scroll(-max(1, (-top + 23) // 24), "units")
            elif bottom > self.settings_canvas.winfo_height():
                distance = bottom - self.settings_canvas.winfo_height()
                self.settings_canvas.yview_scroll(max(1, (distance + 23) // 24), "units")

        # Prepend a local bind tag so scrolling over a spinbox moves settings,
        # rather than accidentally changing a saved size or cleanup threshold.
        scroll_tag = f"UploaderSettingsScroll{id(self)}"
        self.root.bind_class(scroll_tag, "<MouseWheel>", scroll_settings)
        self.root.bind_class(scroll_tag, "<Button-4>", scroll_settings)
        self.root.bind_class(scroll_tag, "<Button-5>", scroll_settings)
        self.root.bind_class(scroll_tag, "<FocusIn>", reveal_setting)

        def bind_settings(widget):
            widget.bindtags((scroll_tag, *widget.bindtags()))
            for child in widget.winfo_children():
                bind_settings(child)

        bind_settings(outer)
        self.settings_canvas.bind("<MouseWheel>", scroll_settings)

    def _refresh_failure_records(self) -> bool:
        loaded = True
        current = []
        try:
            config = replace(self.config, product_root=self.path_var.get().strip(),
                             listing_profile=self.profile_var.get(), template_url=self.url_var.get().strip(),
                             article_name=self.article_name_var.get().strip())
            self.failure_store = FailureStore(failure_record_directory(config))
            if config.listing_profile != "tshirt_bw":
                self.failure_store.import_latest_legacy_report(
                    LOG_DIR, Path(config.product_root or "."),
                )
            state = StateStore(completion_state_path(config))
            all_failures = [
                record for record in self.failure_store.load()
                if record.status == "failed" and not (
                    record.product_folder and state.is_completed(
                        ProductJob(Path(record.product_folder), record.title, []), strict=True,
                    )
                )
            ]
            scan_error = ""
            try:
                jobs, warnings = scan_product_folders(config) if config.product_root else ([], [])
            except Exception as exc:
                jobs, warnings = [], []
                scan_error = f"当前目录扫描未完成：{exc}"
            current, self._pending_jobs, completed = current_batch_progress(config, jobs, all_failures, state)
            self._failure_records = current if self.failure_scope_var.get() == "当前目录" else all_failures
            self.failure_summary_var.set(f"失败 / 待处理（{len(current)} / {len(self._pending_jobs)}）")
            blocked = sum(is_blocking_scan_warning(warning) for warning in warnings)
            self.batch_progress_var.set(
                f"当前目录：可处理 {len(jobs)} 款，已有完成记录 {completed} 款，"
                f"失败 {len(current)} 款，待处理 {len(self._pending_jobs)} 款；"
                f"其他历史失败 {len(all_failures) - len(current)} 款。"
                + (f"另有 {blocked} 项扫描问题，请先扫描预览。" if blocked else "")
                + scan_error
            )
        except Exception as exc:
            loaded = False
            self._failure_records = []
            self._pending_jobs = []
            self._append_log(f"无法读取失败记录：{exc}")
            self.failure_summary_var.set("记录读取异常")
            self.batch_progress_var.set(f"记录或目录读取异常：{exc}")
        if self._failure_dialog is not None and self._failure_dialog.winfo_exists():
            self._fill_failure_tree()
        busy = bool(self.worker and self.worker.is_alive())
        self.retry_failed_button.configure(
            state="normal" if loaded and current and not busy else "disabled",
        )
        return loaded

    def _show_failure_records(self) -> None:
        try:
            self._current_config()
        except ValueError as exc:
            messagebox.showerror("请检查设置", str(exc))
            return
        if self._failure_dialog is not None and self._failure_dialog.winfo_exists():
            self._refresh_failure_records()
            self._failure_dialog.lift()
            return
        dialog = tk.Toplevel(self.root)
        self.failure_scope_var.set("当前目录")
        self._failure_dialog = dialog
        dialog.title("失败记录与待处理商品")
        dialog.geometry("1160x680")
        dialog.minsize(960, 560)
        dialog.transient(self.root)
        outer = ttk.Frame(dialog, padding=14)
        outer.pack(fill="both", expand=True)
        ttk.Label(outer, text="双击记录打开商品文件夹；可按 Ctrl / Shift 多选后重试。记录在关闭工具后仍保留。",
                  foreground="#555").pack(anchor="w", pady=(0, 8))
        ttk.Label(outer, textvariable=self.batch_progress_var, wraplength=1080).pack(anchor="w", pady=(0, 8))
        scope = ttk.Combobox(outer, textvariable=self.failure_scope_var,
                             values=("当前目录", "全部历史"), state="readonly", width=18)
        scope.pack(anchor="w", pady=(0, 8))
        scope.bind("<<ComboboxSelected>>", lambda _event: self._refresh_failure_records())
        self.failure_mode_var = tk.StringVar()
        ttk.Label(outer, textvariable=self.failure_mode_var).pack(anchor="w", pady=(0, 8))
        self.records_notebook = ttk.Notebook(outer)
        self.records_notebook.pack(fill="both", expand=True)
        table = ttk.Frame(self.records_notebook)
        self.records_notebook.add(table, text="失败记录")
        pending_frame = ttk.Frame(self.records_notebook)
        self.records_notebook.add(pending_frame, text="待处理商品")
        ttk.Label(pending_frame, text="以下商品没有完成记录，也没有当前有效失败记录。批次中断后的剩余商品会出现在这里。",
                  wraplength=1050).pack(anchor="w", pady=6)
        self.pending_tree = ttk.Treeview(pending_frame, columns=("title", "folder"), show="headings")
        self.pending_tree.heading("title", text="待处理商品")
        self.pending_tree.heading("folder", text="商品文件夹")
        self.pending_tree.column("title", width=480)
        self.pending_tree.column("folder", width=480)
        pending_scroll = ttk.Scrollbar(pending_frame, orient="vertical", command=self.pending_tree.yview)
        pending_scroll.pack(side="right", fill="y")
        self.pending_tree.configure(yscrollcommand=pending_scroll.set)
        self.pending_tree.pack(fill="both", expand=True)
        self.pending_tree.bind("<Double-1>", self._open_pending_folder)
        columns = ("title", "reason", "folder", "time")
        self.failure_tree = ttk.Treeview(table, columns=columns, show="headings", selectmode="extended")
        for name, label, width in (
            ("title", "商品", 250), ("reason", "失败原因", 300),
            ("folder", "商品文件夹路径", 350), ("time", "记录时间", 150),
        ):
            self.failure_tree.heading(name, text=label)
            self.failure_tree.column(name, width=width, minwidth=100, stretch=True)
        self.failure_tree.grid(row=0, column=0, sticky="nsew")
        table.columnconfigure(0, weight=1)
        table.rowconfigure(0, weight=1)
        vertical = ttk.Scrollbar(table, orient="vertical", command=self.failure_tree.yview)
        vertical.grid(row=0, column=1, sticky="ns")
        horizontal = ttk.Scrollbar(table, orient="horizontal", command=self.failure_tree.xview)
        horizontal.grid(row=1, column=0, sticky="ew")
        self.failure_tree.configure(xscrollcommand=horizontal.set)
        self.failure_tree.configure(yscrollcommand=vertical.set)
        self.failure_tree.bind("<<TreeviewSelect>>", lambda _event: self._show_failure_details())
        self.failure_tree.bind("<Double-1>", self._open_failure_on_double_click)
        self.failure_details = tk.Text(outer, height=5, wrap="word", state="disabled")
        self.failure_details.pack(fill="x", pady=8)
        buttons = ttk.Frame(outer)
        buttons.pack(fill="x")
        self.failure_retry_buttons = []
        for label, command in (
            ("重试列表失败项", lambda: self._retry_failed_records(list(self._failure_records))),
            ("重试选中项", lambda: self._retry_failed_records(self._selected_failures())),
        ):
            button = ttk.Button(buttons, text=label, command=command)
            button.pack(side="left", padx=(0, 6))
            self.failure_retry_buttons.append(button)
        for label, command in (
            ("打开商品文件夹", self._open_failure_folder),
            ("复制文件夹路径", self._copy_failure_folder),
            ("查看失败现场", lambda: self._open_failure_folder(evidence=True)),
            ("刷新", self._refresh_failure_records),
        ):
            ttk.Button(buttons, text=label, command=command).pack(side="left", padx=(0, 6))
        management = ttk.Frame(outer)
        management.pack(fill="x", pady=(8, 0))
        self.continue_pending_button = ttk.Button(management, text="继续当前目录待处理商品", command=self._continue_pending_records)
        self.continue_pending_button.pack(side="left", padx=(0, 8))
        self.dismiss_failure_button = ttk.Button(management, text="移除选中失败记录", command=self._dismiss_failure_records)
        self.dismiss_failure_button.pack(side="left")
        ttk.Label(management, text="移除只隐藏记录，保留商品、失败现场及完成记录。", foreground="#555").pack(side="left", padx=12)
        self._refresh_failure_records()
        if not self._failure_records and self._pending_jobs:
            self.records_notebook.select(1)

    def _fill_failure_tree(self) -> None:
        selected = set(self.failure_tree.selection())
        self.failure_tree.delete(*self.failure_tree.get_children())
        for record in self._failure_records:
            self.failure_tree.insert("", "end", iid=record.key, values=(
                record.title, record.reason, record.product_folder or "旧记录未能确认路径",
                record.updated_at.replace("T", " "),
            ))
        keys = {record.key for record in self._failure_records}
        kept = list(selected & keys)
        if kept:
            self.failure_tree.selection_set(kept)
        elif self._failure_records:
            self.failure_tree.selection_set(self._failure_records[0].key)
        mode = {"publish": "立即发布", "schedule": "定时发布", "review": "发布前检查"}.get(self.mode_var.get(), "发布前检查")
        self.failure_mode_var.set(f"{self.failure_scope_var.get()}：{len(self._failure_records)} 个失败项；重试使用当前设置：{mode}，单页面，每款一次。待处理商品请用下方继续按钮。")
        busy = bool(self.worker and self.worker.is_alive())
        for button in self.failure_retry_buttons:
            button.configure(state="disabled" if busy or not keys else "normal")
        self.pending_tree.delete(*self.pending_tree.get_children())
        for index, job in enumerate(self._pending_jobs):
            self.pending_tree.insert("", "end", iid=str(index), values=(job.title, str(job.folder)))
        self.records_notebook.tab(0, text=f"失败记录（{len(self._failure_records)}）")
        self.records_notebook.tab(1, text=f"当前目录待处理（{len(self._pending_jobs)}）")
        self.continue_pending_button.configure(state="disabled" if busy or not self._pending_jobs else "normal")
        self.dismiss_failure_button.configure(state="disabled" if busy or not keys else "normal")
        self._show_failure_details()

    def _open_pending_folder(self, event) -> None:
        item = self.pending_tree.identify_row(event.y)
        if item:
            path = self._pending_jobs[int(item)].folder
            if extended_windows_path(path).is_dir():
                os.startfile(str(path))

    def _dismiss_failure_records(self) -> None:
        if self.worker and self.worker.is_alive():
            return
        records = self._selected_failures()
        if not records:
            messagebox.showinfo("移除失败记录", "请先选择要移除的失败记录。", parent=self._failure_dialog)
            return
        if messagebox.askyesno("移除失败记录", f"将从列表移除选中的 {len(records)} 条失败记录。\n仅隐藏记录，保留商品文件、失败现场和完成记录。", parent=self._failure_dialog):
            try:
                self.failure_store.dismiss({record.key for record in records})
                self._refresh_failure_records()
            except Exception as exc:
                messagebox.showerror("移除失败记录未完成", str(exc), parent=self._failure_dialog)

    def _continue_pending_records(self) -> None:
        if self.worker and self.worker.is_alive():
            return
        try:
            config = replace(self._current_config(), concurrent_pages=1, album_cleanup_batch_id="")
            if not config.template_url:
                raise ValueError("请填写模板编辑网址。")
            if config.listing_profile in {"tshirt", "tshirt_bw"}:
                validate_article_name(config.article_name)
        except ValueError as exc:
            messagebox.showerror("请检查设置", str(exc))
            return
        if not self._refresh_failure_records() or not self._pending_jobs:
            return
        # A removed uncertain-result record must never bypass submission review.
        uncertain = {folder_key(Path(record.product_folder)) for record in self.failure_store.load()
                     if record.product_folder and needs_submission_review(record.reason)
                     and record.status != "resolved"}
        jobs = [job for job in self._pending_jobs if folder_key(job.folder) not in uncertain]
        if len(jobs) != len(self._pending_jobs):
            self._append_log("提交结果不明确的商品未纳入继续任务，请先在店小秘核对。")
        if not jobs:
            messagebox.showinfo("暂无可继续商品", "剩余商品的提交结果需先到店小秘核对。")
            return
        self._initial_report = None
        self._batch_jobs = list(jobs)
        self.stop_event.clear()
        self._append_log(f"继续当前目录：{len(jobs)} 个待处理商品，已有完成记录和失败列表商品均不重复处理。")
        self._launch_worker(jobs, config, max_job_attempts=1, recovery=True)

    def _selected_failures(self) -> list[FailureRecord]:
        selected = set(self.failure_tree.selection())
        return [record for record in self._failure_records if record.key in selected]

    def _show_failure_details(self) -> None:
        selected = self._selected_failures()
        text = "请选择失败记录。"
        if selected:
            record = selected[0]
            text = (f"商品：{record.title}\n原因：{record.reason}\n"
                    f"商品文件夹：{record.product_folder or '旧记录未能确认路径'}\n失败现场：{record.evidence_dir}")
        self.failure_details.configure(state="normal")
        self.failure_details.delete("1.0", "end")
        self.failure_details.insert("1.0", text)
        self.failure_details.configure(state="disabled")

    def _open_failure_on_double_click(self, event) -> None:
        item = self.failure_tree.identify_row(event.y)
        if item:
            self.failure_tree.selection_set(item)
            self._open_failure_folder()

    def _open_failure_folder(self, evidence: bool = False) -> None:
        selected = self._selected_failures()
        if not selected:
            messagebox.showinfo("文件夹定位", "请先选择一条失败记录。", parent=self._failure_dialog)
            return
        raw = selected[0].evidence_dir if evidence else selected[0].product_folder
        if not raw:
            messagebox.showwarning("路径未确认", "这条旧记录没有可确认的商品路径，请先查看失败现场。", parent=self._failure_dialog)
            return
        path = Path(raw)
        if not extended_windows_path(path).is_dir():
            messagebox.showwarning("文件夹不存在", f"文件夹可能已移动或改名：\n{path}", parent=self._failure_dialog)
            return
        try:
            os.startfile(str(path.resolve()))
        except OSError as exc:
            messagebox.showerror("无法打开文件夹", f"{path}\n\n{exc}", parent=self._failure_dialog)

    def _copy_failure_folder(self) -> None:
        paths = [record.product_folder for record in self._selected_failures() if record.product_folder]
        if paths:
            self.root.clipboard_clear()
            self.root.clipboard_append("\n".join(paths))

    def _retry_failed_records(self, records: Optional[list[FailureRecord]] = None) -> None:
        if self.worker and self.worker.is_alive():
            messagebox.showinfo("任务运行中", "请等待本轮结束，或先停止当前任务后再重试。")
            return
        requested_keys = None if records is None else {record.key for record in records}
        if records is None:
            self.failure_scope_var.set("当前目录")
        try:
            self._current_config()
        except ValueError as exc:
            messagebox.showerror("请检查设置", str(exc))
            return
        if not self._refresh_failure_records():
            messagebox.showerror("无法重试", "失败记录读取异常，请查看运行日志。")
            return
        records = [record for record in self._failure_records
                   if requested_keys is None or record.key in requested_keys]
        if not records:
            messagebox.showinfo("重试失败项", "没有待重试的失败项，请先选择记录。")
            return
        try:
            config = replace(self._current_config(), concurrent_pages=1)
            if not config.template_url:
                raise ValueError("请填写店小秘 Temu 商品的模板编辑网址。")
            if config.listing_profile in {"tshirt", "tshirt_bw"}:
                validate_article_name(config.article_name)
        except ValueError as exc:
            messagebox.showerror("请检查上架设置", str(exc))
            return
        jobs, skipped = prepare_failed_retries(records, config, StateStore(completion_state_path(config)))
        for reason in skipped:
            self._append_log(f"重试未纳入：{reason}")
        if not jobs:
            messagebox.showwarning("没有可重试商品", "\n\n".join(skipped[:8]) or "没有可重试商品。")
            return
        if skipped:
            messagebox.showwarning("部分记录未纳入重试", f"本次可重试 {len(jobs)} 款，另有 {len(skipped)} 条未纳入：\n\n" + "\n\n".join(skipped[:8]))
        self._append_log(f"一键重试：只处理 {len(jobs)} 个失败商品；单页面，每款一次。")
        self._initial_report = None
        self._batch_jobs = list(jobs)
        self.stop_event.clear()
        self._launch_worker(jobs, config, max_job_attempts=1, recovery=True)

    def _choose_folder(self) -> None:
        selected = filedialog.askdirectory(title="选择包含商品子文件夹的总目录")
        if selected:
            self.path_var.set(selected)
            self._scan()

    def _collect_product_image_sets(self, config: AppConfig) -> list[tuple[Path, list[Path]]]:
        root = normal_windows_path(Path(config.product_root).expanduser())
        readable_root = extended_windows_path(root)
        if not readable_root.is_dir():
            raise ValueError("请先选择存在的商品图片总目录。")

        common_identities = {
            _path_identity(path) for path in detail_images_for_scanning(config)
        }

        def folder_images(folder: Path, *, direct: bool = False) -> list[Path]:
            candidates = [
                normal_windows_path(path)
                for path in extended_windows_path(folder).iterdir()
                if path.is_file()
                and path.suffix.casefold() in SUPPORTED_IMAGE_EXTENSIONS
            ]
            ordered = apply_product_image_order(folder, candidates, config)
            if config.listing_profile == "tshirt_bw" or (not direct and all(_path_identity(path) in common_identities for path in ordered)):
                return [path for path in ordered if _path_identity(path) not in common_identities]
            return ordered

        direct_images = folder_images(root, direct=True)
        child_sets: list[tuple[Path, list[Path]]] = []
        child_folders = sorted(
            (
                normal_windows_path(path)
                for path in readable_root.iterdir()
                if path.is_dir()
            ),
            key=lambda path: natural_key(path.name),
        )
        for folder in child_folders:
            images = folder_images(folder)
            if images:
                child_sets.append((folder, images))
        if child_sets:
            return child_sets
        if direct_images:
            return [(root, direct_images)]
        return []

    def _collect_mixed_image_groups(self, config: AppConfig):
        from mixed_image_order_ui import MixedImageGroup
        groups = []
        product_sets = self._collect_product_image_sets(config)
        detail_groups = load_color_detail_images(config) if config.listing_profile == "tshirt_bw" else None
        common_details = load_common_detail_images(config) if detail_groups is None else []
        colors = ("white", "black") if config.bw_first_color == "white" else ("black", "white")
        for folder, products in product_sets:
            if detail_groups is not None:
                if len(products) != 2:
                    raise ValueError(f"{folder.name} 需要恰好2张原始商品图，请先通过“黑白对应”核对。")
                sources = [(color, [products[index]], detail_groups[color]) for index, color in enumerate(colors)]
            else:
                products, selected_details = ordinary_mixed_sources(products, common_details)
                sources = [("all", products, selected_details)]
            for channel, source_images, details in sources:
                base = make_items(source_images, details)
                items = ordered_items(config, folder, channel, base)
                label = folder.name + ({"white": " · 白色", "black": " · 黑色"}.get(channel, ""))
                groups.append(MixedImageGroup(
                    key=order_key(config.listing_profile, folder, channel),
                    layout_key=layout_key(config.listing_profile, channel), label=label,
                    items=items, base_items=base, limit=config.max_images))
        return groups

    def _preview_product_images(self) -> None:
        from mixed_image_order_ui import MixedImageOrderDialog
        try:
            config = self._current_config()
            groups = self._collect_mixed_image_groups(config)
        except Exception as exc:
            messagebox.showerror("无法读取混合图片", str(exc), parent=self.root)
            return
        if not groups:
            messagebox.showinfo("没有图片", "请选择包含商品图片的目录，再添加需要的细节图。", parent=self.root)
            return

        def save_orders(orders, layouts):
            previous_orders = self.config.combined_image_orders
            previous_layouts = self.config.combined_image_layouts
            try:
                self.config.combined_image_orders = {**previous_orders, **orders}
                self.config.combined_image_layouts = {**previous_layouts, **layouts}
                self._current_config()
            except Exception:
                self.config.combined_image_orders = previous_orders
                self.config.combined_image_layouts = previous_layouts
                raise
            self.status_var.set(f"已保存 {len(groups)} 组混合图片顺序；商品图与细节图按此顺序上传，第1张为主图。")
        self._mixed_order_dialog = MixedImageOrderDialog(self.root, groups, save_orders)

    def _preview_original_product_images(self) -> None:
        try:
            config = self._current_config()
            product_sets = self._collect_product_image_sets(config)
        except Exception as exc:
            messagebox.showerror("无法读取商品图", str(exc))
            return
        if not product_sets:
            messagebox.showinfo(
                "没有可排序的商品图",
                "所选目录中没有找到商品图片，请先确认商品图片总目录。",
            )
            return

        folders = [folder for folder, _images in product_sets]
        working_orders = {
            _path_identity(folder): list(images) for folder, images in product_sets
        }

        dialog = tk.Toplevel(self.root)
        dialog.title("原始商品图：黑白颜色对应")
        dialog.geometry("1120x610")
        dialog.minsize(820, 500)
        dialog.transient(self.root)
        dialog.grab_set()

        outer = ttk.Frame(dialog, padding=16)
        outer.pack(fill="both", expand=True)
        header = ttk.Frame(outer)
        header.pack(fill="x")
        ttk.Label(
            header,
            text="选择商品",
            font=("Microsoft YaHei UI", 10, "bold"),
        ).pack(side="left")
        product_var = tk.StringVar()
        product_selector = ttk.Combobox(
            header,
            textvariable=product_var,
            state="readonly",
            width=68,
            values=[
                f"{index + 1}. {folder.name}（{len(working_orders[_path_identity(folder)])} 张）"
                for index, folder in enumerate(folders)
            ],
        )
        product_selector.pack(side="left", fill="x", expand=True, padx=(10, 0))
        product_selector.current(0)

        instruction_var = tk.StringVar()
        ttk.Label(
            outer,
            textvariable=instruction_var,
            foreground="#555",
        ).pack(anchor="w", pady=(10, 10))

        preview_border = ttk.Frame(outer)
        preview_border.pack(fill="both", expand=True)
        canvas = tk.Canvas(
            preview_border,
            highlightthickness=1,
            highlightbackground="#d6d6d6",
        )
        canvas.pack(side="top", fill="both", expand=True)
        scrollbar = ttk.Scrollbar(preview_border, orient="horizontal", command=canvas.xview)
        scrollbar.pack(side="bottom", fill="x")
        canvas.configure(xscrollcommand=scrollbar.set)
        cards = ttk.Frame(canvas, padding=10)
        cards_window = canvas.create_window((0, 0), window=cards, anchor="nw")
        preview_photos: list[object] = []

        def selected_index() -> int:
            index = product_selector.current()
            return index if index >= 0 else 0

        def current_folder() -> Path:
            return folders[selected_index()]

        def current_images() -> list[Path]:
            return working_orders[_path_identity(current_folder())]

        def update_scroll_region(_event=None) -> None:
            canvas.configure(scrollregion=canvas.bbox("all"))
            canvas.itemconfigure(cards_window, height=max(canvas.winfo_height() - 4, 1))

        cards.bind("<Configure>", update_scroll_region)
        canvas.bind("<Configure>", update_scroll_region)

        def make_photo(path: Path):
            if PILImage is None or ImageOps is None or ImageTk is None:
                return None
            try:
                with PILImage.open(path) as opened:
                    image = ImageOps.exif_transpose(opened).convert("RGB")
                    image.thumbnail((160, 160), PILImage.Resampling.LANCZOS)
                    background = PILImage.new("RGB", (160, 160), "white")
                    background.paste(
                        image,
                        ((160 - image.width) // 2, (160 - image.height) // 2),
                    )
                return ImageTk.PhotoImage(background, master=dialog)
            except Exception:
                return None

        def move(index: int, offset: int) -> None:
            images = current_images()
            target = index + offset
            if target < 0 or target >= len(images):
                return
            images[index], images[target] = images[target], images[index]
            render_cards()

        def set_as_main(index: int) -> None:
            if index <= 0:
                return
            images = current_images()
            images.insert(0, images.pop(index))
            render_cards()

        def reset_current() -> None:
            folder = current_folder()
            working_orders[_path_identity(folder)] = sorted(
                current_images(),
                key=lambda path: natural_key(path.name),
            )
            render_cards()

        def render_cards(_event=None) -> None:
            for child in cards.winfo_children():
                child.destroy()
            preview_photos.clear()
            folder = current_folder()
            images = current_images()
            bw = config.listing_profile == "tshirt_bw"
            colors = ("白色", "黑色") if config.bw_first_color == "white" else ("黑色", "白色")
            rule = f"第 1 张→{colors[0]}，第 2 张→{colors[1]}，请让所有文件夹保持相同顺序。" if bw else "第 1 张是默认商品图。"
            instruction_var.set(f"当前商品：{folder.name}。这里只调整原始商品图的颜色对应；{rule}实际上传顺序请用“图片混合排序”。")
            for index, path in enumerate(images):
                title = f"第 {index + 1} 张（主图）" if index == 0 else f"第 {index + 1} 张"
                if bw and index < 2:
                    title = f"第 {index + 1} 张（{colors[index]}商品图）"
                card = ttk.LabelFrame(cards, text=title, padding=8)
                card.grid(row=0, column=index, padx=6, pady=4, sticky="ns")
                photo = make_photo(path)
                if photo is not None:
                    preview_photos.append(photo)
                    ttk.Label(card, image=photo).pack()
                else:
                    ttk.Label(
                        card,
                        text="图片预览不可用",
                        width=21,
                        anchor="center",
                    ).pack(ipady=68)
                ttk.Label(
                    card,
                    text=path.name,
                    width=25,
                    wraplength=170,
                    anchor="center",
                    justify="center",
                ).pack(fill="x", pady=(8, 6))
                controls = ttk.Frame(card)
                controls.pack()
                ttk.Button(
                    controls,
                    text="← 前移",
                    width=8,
                    command=lambda i=index: move(i, -1),
                    state="disabled" if index == 0 else "normal",
                ).pack(side="left")
                ttk.Button(
                    controls,
                    text="后移 →",
                    width=8,
                    command=lambda i=index: move(i, 1),
                    state="disabled" if index == len(images) - 1 else "normal",
                ).pack(side="left", padx=4)
                ttk.Button(
                    card,
                    text="设为主图",
                    command=lambda i=index: set_as_main(i),
                    state="disabled" if index == 0 else "normal",
                ).pack(pady=(6, 0))
            canvas.xview_moveto(0)
            update_scroll_region()

        def apply_all_orders() -> None:
            orders = (
                dict(self.config.product_image_orders)
                if isinstance(self.config.product_image_orders, dict)
                else {}
            )
            for folder in folders:
                orders[_path_identity(folder)] = [
                    path.name for path in working_orders[_path_identity(folder)]
                ]
            self.config.product_image_orders = orders
            self._current_config()
            self.status_var.set(f"已保存 {len(folders)} 个商品的图片顺序。" +
                                ("黑白主图按所选固定位置匹配，运行前仍需核对抽样缩略图。" if config.listing_profile == "tshirt_bw" else "每个商品第 1 张将作为主图。"))
            dialog.destroy()

        product_selector.bind("<<ComboboxSelected>>", render_cards)
        footer = ttk.Frame(outer)
        footer.pack(fill="x", pady=(12, 0))
        ttk.Button(
            footer,
            text="恢复当前商品的文件名排序",
            command=reset_current,
        ).pack(side="left")
        ttk.Button(footer, text="取消", command=dialog.destroy).pack(side="right")
        ttk.Button(footer, text="应用全部顺序", command=apply_all_orders).pack(
            side="right", padx=(0, 8)
        )
        dialog.protocol("WM_DELETE_WINDOW", dialog.destroy)
        render_cards()

    def _refresh_common_detail_summary(self) -> None:
        if not self.common_detail_paths:
            self.common_detail_summary_var.set("未选择；本批次不添加通用细节图。")
            return
        names = [Path(path).name for path in self.common_detail_paths]
        preview = "、".join(names[:5])
        if len(names) > 5:
            preview += f" 等 {len(names)} 张"
        self.common_detail_summary_var.set(
            f"已选 {len(names)} 张（当前顺序）：{preview}"
        )

    def _choose_common_detail_images(self) -> None:
        initial_dir = ""
        if self.common_detail_paths:
            initial_dir = str(Path(self.common_detail_paths[0]).parent)
        elif self.path_var.get().strip():
            candidate = Path(self.path_var.get().strip()).expanduser()
            initial_dir = str(candidate if candidate.is_dir() else candidate.parent)
        selected = filedialog.askopenfilenames(
            title="添加通用细节图（可多选，可分多次添加）",
            initialdir=initial_dir or None,
            filetypes=[
                ("支持的图片", "*.jpg *.jpeg *.png *.webp"),
                ("所有文件", "*.*"),
            ],
        )
        if not selected:
            return
        paths = sorted((Path(path) for path in selected), key=lambda path: natural_key(path.name))
        # Keep the existing manual order and append only genuinely new full paths.
        unique_paths = list(self.common_detail_paths)
        seen = {_path_identity(Path(path)) for path in unique_paths}
        added_count = 0
        for path in paths:
            if path.suffix.casefold() not in SUPPORTED_IMAGE_EXTENSIONS:
                messagebox.showerror("图片格式不支持", f"不支持此文件：\n{path}")
                return
            identity = _path_identity(path)
            if identity not in seen:
                seen.add(identity)
                unique_paths.append(str(path.resolve()))
                added_count += 1
        maximum_details = max(0, int(self.config.max_images) - 1)
        if len(unique_paths) > maximum_details:
            messagebox.showerror(
                "通用细节图过多",
                f"最多选择 {maximum_details} 张；还需要为商品主图保留 1 个位置。\n"
                f"已有 {len(self.common_detail_paths)} 张，本次新增 {added_count} 张，"
                f"合计 {len(unique_paths)} 张。\n本次未添加，已保留原有图片和顺序，请减少后重选。",
            )
            return
        self.common_detail_paths = unique_paths
        self._refresh_common_detail_summary()
        self._current_config()
        self.status_var.set(
            f"本次新增 {added_count} 张通用细节图，当前共 {len(unique_paths)} 张；"
            "重复图片已忽略，可点击“预览排序”调整上传顺序。"
        )

    def _preview_common_detail_images(self) -> None:
        if not self.common_detail_paths:
            messagebox.showinfo(
                "尚未选择通用细节图",
                "请先点击“添加图片”添加通用细节图，再打开预览排序。",
            )
            return

        working_paths = list(self.common_detail_paths)
        dialog = tk.Toplevel(self.root)
        dialog.title("通用细节图预览与排序")
        dialog.geometry("1040x500")
        dialog.minsize(760, 430)
        dialog.transient(self.root)
        dialog.grab_set()

        outer = ttk.Frame(dialog, padding=16)
        outer.pack(fill="both", expand=True)
        ttk.Label(
            outer,
            text="最终上传顺序：全部商品图 → 下列通用细节图（从左到右）",
            font=("Microsoft YaHei UI", 11, "bold"),
        ).pack(anchor="w")
        ttk.Label(
            outer,
            text="使用“前移 / 后移”调整位置；这里的序号会直接成为通用细节图的上传顺序。",
            foreground="#555",
        ).pack(anchor="w", pady=(4, 12))

        preview_border = ttk.Frame(outer)
        preview_border.pack(fill="both", expand=True)
        canvas = tk.Canvas(preview_border, highlightthickness=1, highlightbackground="#d6d6d6")
        canvas.pack(side="top", fill="both", expand=True)
        scrollbar = ttk.Scrollbar(preview_border, orient="horizontal", command=canvas.xview)
        scrollbar.pack(side="bottom", fill="x")
        canvas.configure(xscrollcommand=scrollbar.set)
        cards = ttk.Frame(canvas, padding=10)
        cards_window = canvas.create_window((0, 0), window=cards, anchor="nw")
        preview_photos: list[object] = []

        def update_scroll_region(_event=None) -> None:
            canvas.configure(scrollregion=canvas.bbox("all"))
            canvas.itemconfigure(cards_window, height=max(canvas.winfo_height() - 4, 1))

        cards.bind("<Configure>", update_scroll_region)
        canvas.bind("<Configure>", update_scroll_region)

        def make_photo(path: str):
            if PILImage is None or ImageOps is None or ImageTk is None:
                return None
            try:
                with PILImage.open(path) as opened:
                    image = ImageOps.exif_transpose(opened).convert("RGB")
                    image.thumbnail((150, 150), PILImage.Resampling.LANCZOS)
                    background = PILImage.new("RGB", (150, 150), "white")
                    left = (150 - image.width) // 2
                    top = (150 - image.height) // 2
                    background.paste(image, (left, top))
                return ImageTk.PhotoImage(background, master=dialog)
            except Exception:
                return None

        def move(index: int, offset: int) -> None:
            target = index + offset
            if target < 0 or target >= len(working_paths):
                return
            working_paths[index], working_paths[target] = (
                working_paths[target],
                working_paths[index],
            )
            render_cards()

        def remove(index: int) -> None:
            working_paths.pop(index)
            render_cards()

        def render_cards() -> None:
            for child in cards.winfo_children():
                child.destroy()
            preview_photos.clear()
            if not working_paths:
                ttk.Label(
                    cards,
                    text="当前没有通用细节图。点击“应用顺序”后将清空本批次通用图。",
                    foreground="#b45309",
                ).grid(row=0, column=0, padx=20, pady=80)
                update_scroll_region()
                return
            for index, path in enumerate(working_paths):
                card = ttk.LabelFrame(cards, text=f"第 {index + 1} 张", padding=8)
                card.grid(row=0, column=index, padx=6, pady=4, sticky="ns")
                photo = make_photo(path)
                if photo is not None:
                    preview_photos.append(photo)
                    ttk.Label(card, image=photo).pack()
                else:
                    ttk.Label(
                        card,
                        text="图片预览不可用",
                        width=20,
                        anchor="center",
                    ).pack(ipady=64)
                ttk.Label(
                    card,
                    text=Path(path).name,
                    width=24,
                    wraplength=160,
                    anchor="center",
                    justify="center",
                ).pack(fill="x", pady=(8, 6))
                controls = ttk.Frame(card)
                controls.pack()
                ttk.Button(
                    controls,
                    text="← 前移",
                    width=8,
                    command=lambda i=index: move(i, -1),
                    state="disabled" if index == 0 else "normal",
                ).pack(side="left")
                ttk.Button(
                    controls,
                    text="后移 →",
                    width=8,
                    command=lambda i=index: move(i, 1),
                    state="disabled" if index == len(working_paths) - 1 else "normal",
                ).pack(side="left", padx=4)
                ttk.Button(
                    card,
                    text="移除",
                    command=lambda i=index: remove(i),
                ).pack(pady=(6, 0))
            update_scroll_region()

        def apply_order() -> None:
            self.common_detail_paths = list(working_paths)
            self._refresh_common_detail_summary()
            self._current_config()
            if working_paths:
                self.status_var.set(
                    f"已保存 {len(working_paths)} 张通用细节图的手动顺序；"
                    "未设混排时按此默认顺序追加；要穿插商品图，请使用“图片混合排序”。"
                )
            else:
                self.status_var.set("已清空通用细节图。")
            dialog.destroy()

        footer = ttk.Frame(outer)
        footer.pack(fill="x", pady=(12, 0))
        ttk.Button(footer, text="取消", command=dialog.destroy).pack(side="right")
        ttk.Button(footer, text="应用顺序", command=apply_order).pack(
            side="right", padx=(0, 8)
        )
        dialog.protocol("WM_DELETE_WINDOW", dialog.destroy)
        render_cards()

    def _clear_common_detail_images(self) -> None:
        self.common_detail_paths = []
        self._refresh_common_detail_summary()
        self._current_config()
        self.status_var.set("已清空通用细节图；本批次只上传各商品文件夹中的图片。")

    def _normalize_template_entry(self) -> None:
        try:
            normalized = normalize_template_url(self.url_var.get())
        except ValueError:
            return  # Let the user finish typing; validation occurs on start/save.
        if normalized != self.url_var.get():
            self.url_var.set(normalized)

    def _update_profile_controls(self) -> None:
        tshirt = self.profile_var.get() in {"tshirt", "tshirt_bw"}
        self.article_name_entry.configure(state="normal" if tshirt else "disabled")
        if tshirt:
            name = self.article_name_var.get().strip() or "Name"
            self.article_preview_var.set(f"{datetime.now():%Y%m%d}-{name}-0001（最多8位）")
        else:
            self.article_preview_var.set("T恤脚本按日期和英文名生成 SKC 货号")
        if hasattr(self, "bw_order_selector"):
            state = "readonly" if self.profile_var.get() == "tshirt_bw" else "disabled"
            self.bw_order_selector.configure(state=state)
            self.bw_template_button.configure(state="normal" if state == "readonly" else "disabled")
        if hasattr(self, "bw_mapping_button"):
            if self.profile_var.get() == "tshirt_bw":
                self.bw_mapping_button.pack(side="left", padx=(4, 0))
            else:
                self.bw_mapping_button.pack_forget()
        if hasattr(self, "bw_detail_frame"):
            if self.profile_var.get() == "tshirt_bw":
                self.common_detail_label.grid_remove()
                self.common_detail_frame.grid_remove()
                self.bw_detail_frame.grid()
                empty = not self.color_detail_panel.get_paths("white") and not self.color_detail_panel.get_paths("black")
                self.bw_detail_note.configure(text=(
                    "旧版通用图已保留在普通模式，请分别添加白色和黑色细节图；黑白模式不会自动复用旧通用图。"
                    if empty and self.common_detail_paths else
                    "白色细节图只用于白色行，黑色细节图只用于黑色行；通用尺码图可分别添加到两组。"))
            else:
                self.bw_detail_frame.grid_remove()
                self.common_detail_label.grid()
                self.common_detail_frame.grid()

    def _on_color_detail_change(self, color: str, paths: list[str]) -> None:
        self._current_config()
        self._update_profile_controls()
        label = "白色" if color == "white" else "黑色"
        self.status_var.set(f"已保存 {len(paths)} 张{label}细节图，仅用于{label}颜色行。")

    def _current_config(self) -> AppConfig:
        if hasattr(self, "album_cleanup_panel"):
            self.config.album_cleanup_enabled, self.config.album_cleanup_threshold_mb = self.album_cleanup_panel.get_settings()
        if hasattr(self, "image_processing_panel"):
            options = self.image_processing_panel.get_options()
            self.config.image_processing_mode = options.mode
            self.config.image_target_width = options.width
            self.config.image_target_height = options.height
            self.config.image_max_edge = options.max_edge
        self.config.product_root = self.path_var.get().strip()
        self.config.common_detail_images = list(self.common_detail_paths)
        if hasattr(self, "color_detail_panel"):
            self.config.white_detail_images = self.color_detail_panel.get_paths("white")
            self.config.black_detail_images = self.color_detail_panel.get_paths("black")
        self.config.template_url = normalize_template_url(self.url_var.get())
        self.url_var.set(self.config.template_url)
        if hasattr(self, "profile_var"):
            self.config.listing_profile = self.profile_var.get()
            self.config.article_name = self.article_name_var.get().strip()
        if hasattr(self, "description_mode_var"):
            self.config.description_mode = self.description_mode_var.get()
            self.config.bw_first_color = "black" if self.bw_order_var.get() == "第1张黑色，第2张白色" else "white"
        self.config.publish_mode = self.mode_var.get()
        self.config.save()
        return self.config

    def _log(self, message: str) -> None:
        self.messages.put(("log", message))

    def _ask_retry_after_failure(
        self, job: ProductJob, reason: str, timeout_seconds: int
    ) -> bool:
        """Ask on Tk's main thread while the automation worker waits safely."""
        finished = threading.Event()
        result = {"retry": True}
        controls: dict[str, object] = {}

        def show_dialog() -> None:
            if self.stop_event.is_set():
                result["retry"] = False
                finished.set()
                return

            dialog = tk.Toplevel(self.root)
            controls["dialog"] = dialog
            dialog.title("商品处理失败：是否重试？")
            dialog.geometry("720x520")
            dialog.minsize(660, 460)
            dialog.resizable(True, True)
            dialog.transient(self.root)
            dialog.attributes("-topmost", True)

            body = ttk.Frame(dialog, padding=20)
            body.pack(fill="both", expand=True)
            body.columnconfigure(0, weight=1)
            body.rowconfigure(2, weight=1)
            ttk.Label(
                body,
                text="当前商品第一次处理失败，是否从模板页重新尝试上架？",
                font=("Microsoft YaHei UI", 12, "bold"),
                wraplength=660,
            ).grid(row=0, column=0, sticky="w", pady=(0, 12))
            ttk.Label(
                body,
                text=f"商品：{job.listing_title}",
                wraplength=660,
            ).grid(row=1, column=0, sticky="w", pady=(0, 10))

            error_frame = ttk.LabelFrame(body, text="错误详情（可滚动查看）", padding=6)
            error_frame.grid(row=2, column=0, sticky="nsew", pady=(0, 10))
            error_frame.columnconfigure(0, weight=1)
            error_frame.rowconfigure(0, weight=1)
            error_text = tk.Text(
                error_frame,
                wrap="word",
                height=10,
                foreground="#a13a20",
                background="#fffafa",
            )
            error_text.grid(row=0, column=0, sticky="nsew")
            error_scrollbar = ttk.Scrollbar(
                error_frame, orient="vertical", command=error_text.yview
            )
            error_scrollbar.grid(row=0, column=1, sticky="ns")
            error_text.configure(yscrollcommand=error_scrollbar.set)
            error_text.insert("1.0", reason[:4000])
            error_text.configure(state="disabled")

            ttk.Label(
                body,
                text="规则：两分钟内不操作将自动重试一次；第二次仍失败会直接跳过，不再询问。",
                wraplength=660,
            ).grid(row=3, column=0, sticky="w", pady=(0, 8))

            countdown_var = tk.StringVar()
            ttk.Label(body, textvariable=countdown_var, foreground="#0b63a8").grid(
                row=4, column=0, sticky="w", pady=(0, 10)
            )
            buttons = ttk.Frame(body)
            buttons.grid(row=5, column=0, sticky="ew")
            buttons.columnconfigure(1, weight=1)
            deadline = time.monotonic() + timeout_seconds

            def finish(retry: bool, source: str) -> None:
                if finished.is_set():
                    return
                result["retry"] = retry
                if source == "timeout":
                    self._log("重试弹窗 2 分钟无人操作，已按默认规则自动重试一次。")
                elif source == "yes":
                    self._log("用户选择重新尝试当前商品。")
                elif source in {"no", "close"}:
                    self._log("用户选择跳过当前商品，不进行重试。")
                try:
                    dialog.grab_release()
                except Exception:
                    pass
                try:
                    dialog.destroy()
                except Exception:
                    pass
                finished.set()

            controls["finish"] = finish

            def update_countdown() -> None:
                if finished.is_set():
                    return
                remaining = max(0, int(deadline - time.monotonic() + 0.999))
                countdown_var.set(f"剩余 {remaining} 秒；倒计时结束后将自动重试。")
                if remaining <= 0:
                    finish(True, "timeout")
                else:
                    dialog.after(250, update_countdown)

            retry_button = ttk.Button(
                buttons,
                text="重新尝试（最多一次）",
                command=lambda: finish(True, "yes"),
            )
            retry_button.grid(row=0, column=0, sticky="w")
            ttk.Button(
                buttons,
                text="跳过此商品",
                command=lambda: finish(False, "no"),
            ).grid(row=0, column=2, sticky="e")
            dialog.protocol("WM_DELETE_WINDOW", lambda: finish(False, "close"))
            dialog.grab_set()
            dialog.lift()
            retry_button.focus_set()
            update_countdown()

        self.root.after(0, show_dialog)
        while not finished.wait(0.2):
            if self.stop_event.is_set():
                finish = controls.get("finish")
                if callable(finish):
                    self.root.after(0, lambda fn=finish: fn(False, "stop"))
                else:
                    result["retry"] = False
                    finished.set()
        return bool(result["retry"])

    def _scan(self) -> list[ProductJob]:
        try:
            config = self._current_config()
            jobs, warnings = scan_product_folders(config)
        except Exception as exc:
            messagebox.showerror("无法扫描", str(exc))
            return []
        total_count, processable_count, blocked_count = summarize_scan(jobs, warnings)
        blocked = [warning for warning in warnings if is_blocking_scan_warning(warning)]
        count_warnings = [warning for warning in warnings if is_image_count_warning(warning)]
        notices = [
            warning
            for warning in warnings
            if not is_blocking_scan_warning(warning)
            and not is_image_count_warning(warning)
            and not warning.startswith("标题已安全清洗：")
        ]
        self._append_log("\n扫描结果：")
        self._append_log(
            f"  共发现 {total_count} 个商品文件夹：可处理 {processable_count} 个，"
            f"未纳入 {blocked_count} 个。"
        )
        if blocked:
            self._append_log("  需要处理的文件夹：")
            for warning in blocked:
                self._append_log(f"  ⚠ {warning}")
        for warning in count_warnings:
            self._append_log(f"  ⚠ {warning}")
        for index, job in enumerate(jobs, start=1):
            if job.common_detail_count:
                product_count = len(job.images) - job.common_detail_count
                image_summary = (
                    f"共 {len(job.images)} 张：商品图 {product_count} 张 + "
                    f"通用细节图 {job.common_detail_count} 张"
                )
            else:
                image_summary = f"{len(job.images)} 张"
            if config.listing_profile == "tshirt_bw":
                first_color, second_color = ("白色", "黑色") if config.bw_first_color == "white" else ("黑色", "白色")
                image_summary = (f"{first_color}商品图：{job.images[0].name}；{second_color}商品图：{job.images[1].name}；"
                                 f"白色细节 {len(job.color_image_sets['white'])-1} 张，黑色细节 {len(job.color_image_sets['black'])-1} 张")
            self._append_log(f"  {index}. 上架标题：{job.listing_title}（{image_summary}）")
            if config.listing_profile == "tshirt_bw":
                for color, label in (("white", "白色"), ("black", "黑色")):
                    self._append_log(f"     {label}实际上传主图：{job.color_image_sets[color][0].name}")
            elif job.images:
                self._append_log(f"     当前主图：{job.images[0].name}")
            if job.listing_title != job.title:
                self._append_log(f"     原文件夹名：{job.title}")
        for warning in notices:
            self._append_log(f"  提醒：{warning}")
        if blocked_count:
            self.status_var.set(
                f"发现 {total_count} 个商品文件夹：可处理 {processable_count} 个，"
                f"未纳入 {blocked_count} 个（请查看弹窗原因）。"
            )
            self.status_label.configure(foreground="#b45309")
            details = "\n\n".join(blocked[:8])
            if len(blocked) > 8:
                details += f"\n\n其余 {len(blocked) - 8} 个请查看运行窗口日志。"
            blocked_signature = tuple(blocked)
            if blocked_signature != self._last_blocked_signature:
                messagebox.showwarning(
                    "有商品文件夹未纳入",
                    f"共发现 {total_count} 个商品文件夹，其中 {processable_count} 个可处理，"
                    f"{blocked_count} 个未纳入。\n\n{details}\n\n"
                    "请核对所列文件夹；黑白T恤需2张对应主图，普通脚本单张商品图可以处理。",
                )
                self._last_blocked_signature = blocked_signature
        else:
            self.status_var.set(f"共发现 {total_count} 个商品文件夹，全部可以处理。")
            self.status_label.configure(foreground="#0b63a8")
            self._last_blocked_signature = ()
        if count_warnings:
            self.status_var.set(
                f"发现 {total_count} 个商品文件夹：可处理 {processable_count} 个，未纳入 {blocked_count} 个；"
                "商品图数量不一致，请核对（仍可处理）。"
            )
            self.status_label.configure(foreground="#b45309")
            signature = tuple(count_warnings)
            if signature != getattr(self, "_last_count_warning_signature", ()):
                details = "\n\n".join(count_warnings[:9])
                if len(count_warnings) > 9:
                    details += f"\n\n其余 {len(count_warnings) - 9} 项请查看运行日志。"
                messagebox.showwarning(
                    "商品图片数量不一致",
                    f"{details}\n\n这是数量核对预警，所列商品仍然可以处理。"
                    "数量符合预期时可继续；如有漏图，请补齐后重新扫描。",
                )
            self._last_count_warning_signature = signature
        else:
            self._last_count_warning_signature = ()
        return jobs

    def _start(self) -> None:
        if self.worker and self.worker.is_alive():
            return
        jobs = self._scan()
        if not jobs:
            return
        if not self.config.template_url:
            messagebox.showerror("请填写模板网址", "请粘贴店小秘 Temu 商品的 edit 或 quoteEdit 网址。")
            return
        if self.config.listing_profile in {"tshirt", "tshirt_bw"}:
            try:
                validate_article_name(self.config.article_name)
            except ValueError as exc:
                messagebox.showerror("请设置T恤货号", str(exc))
                return
        if self.mode_var.get() == "schedule":
            target = (datetime.now().astimezone() + timedelta(days=1)).replace(
                hour=self.config.schedule_hour,
                minute=self.config.schedule_minute,
                second=0,
                microsecond=0,
            )
            ok = messagebox.askyesno(
                "确认批量定时发布",
                f"将使用最多 {effective_concurrent_pages(self.config)} 个页面处理 {len(jobs)} 个商品，并统一安排到 "
                f"{target:%Y-%m-%d %H:%M} 发布。\n\n"
                "每个页面一次只处理一个商品；单品失败会自动重试一次。是否确认开始？",
                icon="warning",
            )
            if not ok:
                return
        elif self.mode_var.get() == "publish":
            ok = messagebox.askyesno(
                "确认批量立即发布",
                f"将使用最多 {effective_concurrent_pages(self.config)} 个页面处理并立即提交 {len(jobs)} 个商品。\n\n"
                "每个页面一次只处理一个商品；单品失败会自动重试一次。\n"
                "这不是定时发布，平台接受后会立即进入发布流程。是否确认开始？",
                icon="warning",
            )
            if not ok:
                return
        self.stop_event.clear()
        config = self._current_config()
        self._initial_report = None
        self._batch_jobs = list(jobs)
        self._launch_worker(jobs, config, max_job_attempts=MAX_JOB_ATTEMPTS, recovery=False)

    def _launch_worker(
        self,
        jobs: list[ProductJob],
        config: AppConfig,
        max_job_attempts: int,
        recovery: bool,
    ) -> bool:
        config = deepcopy(config)
        if config.album_cleanup_enabled and (not recovery or not config.album_cleanup_batch_id):
            config.album_cleanup_batch_id = uuid.uuid4().hex
        preview_jobs = pending_jobs_for_run(config, jobs, strict=recovery,
                                            review_count=len(jobs) if recovery else 1)
        if not preview_jobs:
            self._append_log("没有待处理商品，本次未启动；已完成记录保持不变。")
            return False
        if not confirm_image_order(self.root, preview_jobs, config):
            self._append_log("已取消开始运行：请通过“图片混合排序”调整后再次开始。")
            return False
        self._batch_config = deepcopy(config)
        self.start_button.configure(state="disabled")
        self.stop_button.configure(state="normal")
        self.retry_failed_button.configure(state="disabled")
        if self._failure_dialog is not None and self._failure_dialog.winfo_exists():
            for button in self.failure_retry_buttons:
                button.configure(state="disabled")
        pages = min(effective_concurrent_pages(config), len(jobs)) if is_batch_submission_mode(config.publish_mode) else 1
        if recovery:
            self.status_var.set(
                f"正在使用 {pages} 个页面处理 {len(jobs)} 个未完成商品；每个只尝试一次。"
            )
        else:
            if is_batch_submission_mode(config.publish_mode) and len(jobs) > 1:
                self.status_var.set(
                    f"正在使用 {pages} 个页面运行；请勿操作自动化浏览器。"
                )
            else:
                self.status_var.set("正在单页面运行；请留意自动打开的浏览器。")

        def task() -> None:
            try:
                report = DxmUploader(
                    config,
                    self._log,
                    self.stop_event,
                    retry_decider=self._ask_retry_after_failure,
                    max_job_attempts=max_job_attempts,
                ).run(jobs, review_count=len(jobs) if recovery else 1, strict_completion=recovery)
                self.messages.put(("recovery_done" if recovery else "done", report))
            except StopRequested:
                self.messages.put(("done", "任务已停止。"))
            except Exception as exc:
                self.messages.put(("error", str(exc)))

        self.worker = threading.Thread(target=task, daemon=True)
        self.worker.start()
        return True

    @staticmethod
    def _jobs_for_failures(report: RunReport, jobs: list[ProductJob]) -> list[ProductJob]:
        failed_paths = {
            str(failure.product_folder.resolve()).casefold()
            for failure in report.failures
            if failure.product_folder is not None and not needs_submission_review(failure.reason)
        }
        return [
            job
            for job in jobs
            if str(job.folder.resolve()).casefold() in failed_paths
        ]

    def _offer_failed_batch_recovery(
        self, report: RunReport, jobs: list[ProductJob]
    ) -> bool:
        if report.blocked_reason:
            return False
        retry_jobs = self._jobs_for_failures(report, jobs)
        if not retry_jobs or self.stop_event.is_set():
            return False
        details = []
        for index, failure in enumerate(report.failures[:10], start=1):
            details.append(f"{index}. {failure.title}\n   原因：{failure.reason}")
        if len(report.failures) > 10:
            details.append(f"……其余 {len(report.failures) - 10} 项请查看汇总文件。")
        prompt = (
            f"本批次有 {len(report.failures)} 个商品在两次尝试后仍然失败：\n\n"
            + "\n\n".join(details)
            + "\n\n是否只把以上失败商品统一补跑一次？\n"
            "已成功的商品不会重复处理；补跑仍失败的商品将直接保留在最终失败清单中。"
        )
        if not messagebox.askyesno("失败商品清单：是否统一补跑？", prompt, icon="warning"):
            self._append_log("用户选择不补跑失败商品。")
            return False
        self._append_log(f"用户选择统一补跑 {len(retry_jobs)} 个失败商品；每个只再尝试一次。")
        self._initial_report = report
        self.stop_event.clear()
        batch_config = self._batch_config if isinstance(self._batch_config, AppConfig) else self._current_config()
        launched = self._launch_worker(
            retry_jobs,
            replace(deepcopy(batch_config), concurrent_pages=1),
            max_job_attempts=1,
            recovery=True,
        )
        return launched

    def _finish_with_report(self, report: RunReport, recovery: bool = False) -> None:
        display = report.render(max_failures=10)
        status = f"运行结束：成功 {report.succeeded}，失败 {len(report.failures)}。"
        if report.blocked_reason:
            category = "图库空间检查未完成" if report.blocked_category == "album" else "模板未就绪"
            status = f"{category}，批次已停止；成功 {report.succeeded}，待处理 {report.pending_count}。"
        self._append_log(display)
        self.status_var.set(status)
        self.start_button.configure(state="normal")
        self.stop_button.configure(state="disabled")
        self._refresh_failure_records()
        pending_jobs = getattr(self, "_pending_jobs", [])
        if pending_jobs:
            status += f" 当前目录另有 {len(pending_jobs)} 款待处理，可在“失败 / 待处理”中继续。"
            self.status_var.set(status)
        if hasattr(self, "batch_progress_var"):
            self._append_log(self.batch_progress_var.get())
        if report.blocked_reason:
            messagebox.showwarning("图库空间问题：请检查清理日志" if report.blocked_category == "album"
                                   else "模板未就绪：请修正模板网址", display)
        elif report.has_failures:
            title = "未完成商品补跑结束" if recovery else "运行完成（有失败项目）"
            messagebox.showwarning(title, display)
        else:
            title = "未完成商品补跑完成" if recovery else "运行完成"
            messagebox.showinfo(title, display)

    def _stop(self) -> None:
        self.stop_event.set()
        self.status_var.set("正在安全停止…")

    def _clear_state(self) -> None:
        try:
            path = completion_state_path(self._current_config())
        except ValueError as exc:
            messagebox.showerror("请检查设置", str(exc))
            return
        if not path.exists():
            messagebox.showinfo("完成记录", "当前没有完成记录。")
            return
        if messagebox.askyesno("清除完成记录", "清除后，已发布文件夹会再次进入待处理列表。确定清除吗？"):
            path.unlink(missing_ok=True)
            self._append_log("已清除完成记录。")

    def _append_log(self, message: str) -> None:
        stamp = datetime.now().strftime("%H:%M:%S")
        self.log_box.configure(state="normal")
        self.log_box.insert("end", f"[{stamp}] {message}\n")
        self.log_box.see("end")
        self.log_box.configure(state="disabled")

    def _drain_messages(self) -> None:
        try:
            while True:
                kind, message = self.messages.get_nowait()
                if kind == "log":
                    self._append_log(str(message))
                elif kind == "done":
                    if isinstance(message, RunReport):
                        if message.has_failures:
                            if self._offer_failed_batch_recovery(message, self._batch_jobs):
                                continue
                        self._finish_with_report(message)
                    else:
                        display = str(message)
                        self._append_log(display)
                        self.status_var.set(display)
                    self.start_button.configure(state="normal")
                    self.stop_button.configure(state="disabled")
                    self._refresh_failure_records()
                elif kind == "recovery_done":
                    if isinstance(message, RunReport) and self._initial_report is not None:
                        final_report = merge_recovery_report(self._initial_report, message)
                        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
                        final_report.report_path = LOG_DIR / f"run-summary-final-{stamp}.txt"
                        final_report.report_path.write_text(
                            final_report.render(), encoding="utf-8"
                        )
                        self._initial_report = None
                        self._finish_with_report(final_report, recovery=True)
                    elif isinstance(message, RunReport):
                        self._finish_with_report(message, recovery=True)
                elif kind == "error":
                    self._append_log(f"错误：{message}")
                    self.status_var.set("运行失败；请查看日志目录中的现场截图。")
                    self.start_button.configure(state="normal")
                    self.stop_button.configure(state="disabled")
                    self._refresh_failure_records()
                    messagebox.showerror("运行失败", message)
        except queue.Empty:
            pass
        except Exception as exc:
            self._append_log(f"界面消息处理异常：{exc}")
            self.status_var.set("界面处理遇到异常；任务控制已恢复，可重新运行。")
            self.start_button.configure(state="normal")
            self.stop_button.configure(state="disabled")
            self._refresh_failure_records()
            messagebox.showerror("界面处理异常", f"{exc}\n\n程序已恢复按钮状态，请重试。")
        finally:
            self.root.after(100, self._drain_messages)

    def run(self) -> None:
        self.root.mainloop()


def run_cli_review(review_count: int = 1, named_only: bool = False) -> int:
    config = AppConfig.load()
    config.publish_mode = "review"
    try:
        jobs, warnings = scan_product_folders(config)
        if named_only:
            jobs = [job for job in jobs if not re.fullmatch(r"\d+", job.title)]
            jobs.sort(key=lambda job: natural_key(job.images[0].name if job.images else job.title))
        for warning in warnings:
            print(f"提醒：{warning}", flush=True)
        if not jobs:
            print("没有找到可测试商品。", flush=True)
            return 2
        print(f"测试商品：{jobs[0].title}", flush=True)
        print("图片顺序：", flush=True)
        for index, image in enumerate(jobs[0].images, start=1):
            print(f"  {index}. {image.name}", flush=True)
        stopped = threading.Event()
        try:
            report = DxmUploader(config, lambda message: print(message, flush=True), stopped).run(
                jobs, review_count=review_count
            )
            if report.blocked_reason or report.has_failures:
                return 1
        except KeyboardInterrupt:
            stopped.set()
            print("测试已停止。", flush=True)
        return 0
    except Exception as exc:
        print(f"测试失败：{exc}", flush=True)
        traceback.print_exc()
        return 1


def run_cli_schedule_test(product_root: str) -> int:
    config = AppConfig.load()
    config.product_root = product_root
    config.publish_mode = "schedule"
    try:
        jobs, warnings = scan_product_folders(config)
        for warning in warnings:
            print(f"提醒：{warning}", flush=True)
        if not jobs:
            print("没有找到可用于定时发布测试的商品。", flush=True)
            return 2
        job = jobs[0]
        print(f"定时发布测试商品：{job.title}", flush=True)
        print(
            f"目标时间：明天 {config.schedule_hour:02d}:{config.schedule_minute:02d}（本机时区）",
            flush=True,
        )
        report = DxmUploader(
            config,
            lambda message: print(message, flush=True),
            threading.Event(),
        ).run([job])
        print(report.render(), flush=True)
        return 0 if report.succeeded == 1 and not report.has_failures else 1
    except Exception as exc:
        print(f"定时发布测试失败：{exc}", flush=True)
        traceback.print_exc()
        return 1


if __name__ == "__main__":
    multiprocessing.freeze_support()
    if sys.version_info < (3, 10):
        if "--test" in sys.argv:
            print("需要 Python 3.10 或更高版本。", flush=True)
        else:
            messagebox.showerror("Python 版本过低", "需要 Python 3.10 或更高版本。")
        raise SystemExit(1)
    if "--test-schedule" in sys.argv:
        flag_index = sys.argv.index("--test-schedule")
        if flag_index + 1 >= len(sys.argv):
            print("--test-schedule 后需要商品图片文件夹路径。", flush=True)
            raise SystemExit(2)
        raise SystemExit(run_cli_schedule_test(sys.argv[flag_index + 1]))
    if "--test-continuity" in sys.argv:
        raise SystemExit(run_cli_review(review_count=3, named_only=True))
    if "--test" in sys.argv:
        raise SystemExit(run_cli_review())
    UploaderApp().run()
