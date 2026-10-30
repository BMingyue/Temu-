"""Pure, bounded selection rules for optional Dianxiaomi album cleanup.

This module does not open the album, upload anything, or delete images.  The
browser adapter supplies at most two already verified final pages and executes
the resulting image IDs only after it has checked the page again.
"""

from __future__ import annotations

import math
import re
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from numbers import Real
from urllib.parse import urlsplit


_NUMBER = r"(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?"
_UNIT = r"(?:GiB|GB|G|吉字节|吉|千兆字节|千兆|MiB|MB|M|兆字节|兆|KiB|KB|K|千字节)"
_CAPACITY = re.compile(rf"\s*({_NUMBER})\s*({_UNIT})\s*", re.IGNORECASE)


def is_album_capacity_error(message: object) -> bool:
    """Recognize explicit album capacity failures, not image size/format errors."""
    if not isinstance(message, str):
        return False
    text = re.sub(r"\s+", " ", message).casefold()
    topic = (r"图片空间|图库[^，。；:：]{0,8}(?:空间|容量|存储|配额)|"
             r"相册[^，。；:：]{0,8}(?:空间|容量|存储|配额)|存储空间|剩余空间|空间容量|"
             r"(?:album|gallery|image)\s+(?:space|storage|capacity)")
    shortage = r"不足|已满|用尽|耗尽|用完|超限|超出|超过|insufficient|not enough|full|exceed|quota"
    for segment in re.split(r"[,，;；。！？!?]", text):
        if re.search(r"(?:图库|相册)(?:已满|用尽|耗尽|用完|超限)", segment):
            return True
        # A format or per-image size error mentioning the gallery is unrelated
        # to account capacity and must retain its original error handling.
        if re.search(r"尺寸|像素|分辨率|宽度|高度|文件大小|图片大小|image dimensions|resolution", segment):
            continue
        if (re.search(rf"(?:{topic}).{{0,32}}(?:{shortage})", segment)
                or re.search(rf"(?:{shortage}).{{0,16}}(?:{topic})", segment)):
            return True
    return False


def _finite_mb(value: Real, label: str) -> float:
    if isinstance(value, bool) or not isinstance(value, Real):
        raise ValueError(f"{label}必须是非负的有限数字（MB）。")
    result = float(value)
    if not math.isfinite(result) or result < 0:
        raise ValueError(f"{label}必须是非负的有限数字（MB）。")
    return result


def parse_capacity_mb(text: str) -> float:
    """Parse a single displayed capacity; G=1024 MB and K=1/1024 MB."""
    if not isinstance(text, str):
        raise ValueError("空间容量必须包含有效的数字和单位。")
    match = _CAPACITY.fullmatch(text)
    if match is None:
        raise ValueError(f"无法识别空间容量：{text!r}；需要 M/MB、G/GB 或 K/KB 单位。")
    value = float(match.group(1).replace(",", ""))
    unit = match.group(2).casefold()
    if unit in {"g", "gb", "gib", "吉字节", "吉", "千兆字节", "千兆"}:
        value *= 1024
    elif unit in {"k", "kb", "kib", "千字节"}:
        value /= 1024
    return _finite_mb(value, "空间容量")


@dataclass(frozen=True)
class AlbumUsage:
    total_mb: float
    used_mb: float
    remaining_mb: float

    def __post_init__(self) -> None:
        for name, label in (("total_mb", "总容量"), ("used_mb", "已使用空间"),
                            ("remaining_mb", "剩余空间")):
            object.__setattr__(self, name, _finite_mb(getattr(self, name), label))
        if abs(self.total_mb - self.used_mb - self.remaining_mb) > 1.000001:
            raise ValueError("图库空间数据不一致：总容量应等于已使用空间与剩余空间之和。")


def usage_from_text(text: str) -> AlbumUsage:
    """Read only the three account capacity labels, ignoring PDF/image subtotals."""
    if not isinstance(text, str) or not text.strip():
        raise ValueError("未读取到图库空间使用情况。")
    result: dict[str, float] = {}
    for label in ("总容量", "已使用", "剩余空间"):
        labels = list(re.finditer(re.escape(label), text))
        if len(labels) != 1:
            raise ValueError(f"图库空间使用情况中的“{label}”缺失或重复，无法安全判断。")
        after_label = text[labels[0].end():]
        capacity = re.match(rf"\s*[:：]?\s*({_NUMBER}\s*{_UNIT})(?![A-Za-z0-9.,])",
                            after_label, re.IGNORECASE)
        if capacity is None:
            raise ValueError(f"无法识别图库“{label}”的容量或单位。")
        result[label] = parse_capacity_mb(capacity.group(1))
    return AlbumUsage(result["总容量"], result["已使用"], result["剩余空间"])


def image_url_identity(url: str) -> str:
    """Match a CDN asset across resize queries without changing its path case.

    HTTP and HTTPS variants name the same protected asset.  Query strings and
    fragments are image transformations, never an alternative image ID here.
    A URL without an asset path is rejected rather than treated as an image.
    """
    if not isinstance(url, str) or not url.strip():
        raise ValueError("图库图片缺少有效的网址，已停止清理。")
    value = url.strip()
    if any(char.isspace() for char in value):
        raise ValueError("图库图片网址含有空白字符，已停止清理。")
    try:
        parsed = urlsplit("https:" + value if value.startswith("//") else value)
        if (parsed.scheme.lower() not in {"http", "https"} or not parsed.hostname
                or parsed.username is not None or parsed.password is not None
                or parsed.path in {"", "/"}):
            raise ValueError
        # Accessing port rejects malformed or out-of-range ports.
        port = parsed.port
        host = parsed.hostname.lower()
        if ":" in host:
            host = f"[{host}]"
        if port not in {None, 80, 443}:
            host += f":{port}"
    except (ValueError, TypeError):
        raise ValueError("图库图片网址无效或缺少图片路径，已停止清理。") from None
    return "//" + host + parsed.path


@dataclass(frozen=True)
class AlbumImage:
    id: str
    url: str
    title: str = ""
    locked: bool = False

    def __post_init__(self) -> None:
        if not isinstance(self.id, str) or not self.id.strip():
            raise ValueError("图库图片缺少有效的图片 ID，已停止清理。")
        image_url_identity(self.url)
        if not isinstance(self.title, str):
            raise ValueError("图库图片标题格式无效，已停止清理。")
        if not isinstance(self.locked, bool):
            raise ValueError("图库图片锁定状态不明确，已停止清理。")
        object.__setattr__(self, "id", self.id.strip())
        object.__setattr__(self, "url", self.url.strip())


def cleanup_candidates(
    last_pages: Sequence[Sequence[AlbumImage]],
    protected_urls: Iterable[str] = (),
    max_images: int = 600,
) -> list[AlbumImage]:
    """Select unlocked, unprotected images in the supplied final-page order.

    The adapter must prove these are the final two pages.  Empty/partial pages
    are accepted.  This function never fills a short page from an earlier page.
    """
    if isinstance(max_images, bool) or not isinstance(max_images, int) or not 1 <= max_images <= 600:
        raise ValueError("一次清理数量必须为 1 至 600 的整数。")
    if (not isinstance(last_pages, Sequence) or isinstance(last_pages, (str, bytes))
            or len(last_pages) > 2):
        raise ValueError("只能从图库末尾的最多两页选择清理图片。")
    if isinstance(protected_urls, (str, bytes)) or not isinstance(protected_urls, Iterable):
        raise ValueError("受保护图片网址必须为网址列表。")
    protected = {image_url_identity(url) for url in protected_urls}
    images: list[tuple[AlbumImage, str]] = []
    for page in last_pages:
        if (not isinstance(page, Sequence) or isinstance(page, (str, bytes))
                or len(page) > 300):
            raise ValueError("图库清理每页最多允许 300 张图片。")
        for item in page:
            if not isinstance(item, AlbumImage):
                raise ValueError("图库图片资料格式无效，已停止清理。")
            images.append((item, image_url_identity(item.url)))

    # A locked/protected alias must not re-enter through another ID or page.
    blocked_ids = {item.id for item, identity in images if item.locked or identity in protected}
    blocked_urls = protected | {identity for item, identity in images if item.locked}
    selected: list[AlbumImage] = []
    seen_ids: set[str] = set()
    seen_urls: set[str] = set()
    for item, identity in images:
        if (item.id in blocked_ids or identity in blocked_urls
                or item.id in seen_ids or identity in seen_urls):
            continue
        selected.append(item)
        seen_ids.add(item.id)
        seen_urls.add(identity)
        if len(selected) >= max_images:
            break
    return selected


def needs_cleanup(usage: AlbumUsage, threshold_mb: int = 100, reserve_mb: float = 0) -> bool:
    """Check one pre-upload capacity snapshot; unreachable targets stop cleanup."""
    if not isinstance(usage, AlbumUsage):
        raise ValueError("未读取到有效的图库空间使用情况。")
    if (isinstance(threshold_mb, bool) or not isinstance(threshold_mb, int)
            or not 50 <= threshold_mb <= 2000):
        raise ValueError("图库清理触发阈值必须为 50 至 2000 MB 的整数。")
    reserve = _finite_mb(reserve_mb, "本次上传预留空间")
    target = max(float(threshold_mb), reserve)
    if target > usage.total_mb:
        raise ValueError("图库总容量小于清理目标或本次上传需要的空间，请降低阈值或扩容后再运行。")
    return usage.remaining_mb < target
