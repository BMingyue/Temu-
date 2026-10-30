"""Shared image order rules for previews, saved layouts, and upload snapshots.

Product tokens describe positions, so one layout works across product folders.
Detail tokens describe full paths, so identically named files stay independent.
These helpers never alter the caller's lists or saved configuration.
"""
from __future__ import annotations

import json
import os
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class ImageOrderItem:
    token: str
    path: Path
    kind: str


def path_identity(path: str | Path) -> str:
    """Canonical path identity, including equivalent Windows extended paths."""
    text = os.fspath(path)
    if text[:8].lower() == "\\\\?\\unc\\":
        text = "\\\\" + text[8:]
    elif text.startswith("\\\\?\\"):
        text = text[4:]
    try:
        resolved = str(Path(text).expanduser().resolve(strict=False))
    except (OSError, RuntimeError, ValueError):
        # A stale or malformed saved path must not prevent another product
        # from being ordered. File existence is validated by the scanner.
        resolved = os.path.abspath(os.path.expanduser(text))
    if resolved[:8].lower() == "\\\\?\\unc\\":
        resolved = "\\\\" + resolved[8:]
    elif resolved.startswith("\\\\?\\"):
        resolved = resolved[4:]
    return os.path.normcase(os.path.normpath(resolved))


def make_items(products: Iterable[Path], details: Iterable[Path]) -> list[ImageOrderItem]:
    """Combine source lists once, retaining a shared path as a product image."""
    result: list[ImageOrderItem] = []
    seen: set[str] = set()
    product_index = 0
    for source in products:
        path = Path(source)
        identity = path_identity(path)
        if identity in seen:
            continue
        seen.add(identity)
        result.append(ImageOrderItem(f"product:{product_index}", path, "product"))
        product_index += 1
    for source in details:
        path = Path(source)
        identity = path_identity(path)
        if identity in seen:
            continue
        seen.add(identity)
        result.append(ImageOrderItem(f"detail:{identity}", path, "detail"))
    return result


def order_key(profile: str, folder: str | Path, channel: str = "all") -> str:
    """Scope a product override to a profile, folder, and colour channel."""
    return json.dumps([profile, path_identity(folder), channel], ensure_ascii=False, separators=(",", ":"))


def layout_key(profile: str, channel: str = "all") -> str:
    """Scope a shared positional layout to a profile and colour channel."""
    return json.dumps([profile, channel], ensure_ascii=False, separators=(",", ":"))


def apply_order(items: Iterable[ImageOrderItem], tokens: object) -> list[ImageOrderItem]:
    """Apply known tokens, appending new images and ignoring stale entries."""
    current = list(items)
    if not isinstance(tokens, (list, tuple)):
        return current
    by_token = {item.token: item for item in reversed(current)}
    seen: set[str] = set()
    ordered: list[ImageOrderItem] = []
    for token in tokens:
        if not isinstance(token, str) or token in seen or token not in by_token:
            continue
        ordered.append(by_token[token])
        seen.add(token)
    ordered.extend(item for item in current if item.token not in seen)
    return ordered


def _saved_tokens(config: object, attribute: str, key: str) -> list[str] | None:
    mapping = getattr(config, attribute, None)
    if not isinstance(mapping, Mapping):
        return None
    tokens = mapping.get(key)
    if not isinstance(tokens, list):
        return None
    return [token for token in tokens if isinstance(token, str)]


def ordered_items(config: object, folder: str | Path, channel: str,
                  items: Iterable[ImageOrderItem]) -> list[ImageOrderItem]:
    """Resolve a product override, then a profile layout, then source order."""
    profile = getattr(config, "listing_profile", "blanket")
    tokens = _saved_tokens(config, "combined_image_orders", order_key(profile, folder, channel))
    if tokens is None:
        tokens = _saved_tokens(config, "combined_image_layouts", layout_key(profile, channel))
    return apply_order(items, tokens)


def trim_items(items: Iterable[ImageOrderItem], limit: int = 10,
               preserve_details: bool = True) -> list[ImageOrderItem]:
    """Keep detail capacity and the first product choices in their mixed order.

The scanner normally limits details to nine. If an invalid caller exceeds the
capacity, keep the earliest details that fit while still retaining a product.
The first selected item may be a detail; its upload position is not changed.
"""
    current = list(items)
    if limit <= 0:
        return []
    if len(current) <= limit:
        return current
    products = [index for index, item in enumerate(current) if item.kind == "product"]
    if preserve_details:
        details = [index for index, item in enumerate(current) if item.kind == "detail"]
        detail_limit = limit - 1 if products else limit
        selected = set(details[:detail_limit])
        selected.update(products[:limit - len(selected)])
    else:
        selected = set(range(limit))
        if products and not any(current[index].kind == "product" for index in selected):
            selected.remove(limit - 1)
            selected.add(products[0])
    return [item for index, item in enumerate(current) if index in selected]
