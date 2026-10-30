"""Persistent, exact-folder failure records for the local uploader."""
from __future__ import annotations

import hashlib
import json
import os
import re
import threading
from collections.abc import Iterable
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from listing_profiles import normalize_template_url


def folder_key(folder: Path) -> str:
    return str(folder.resolve()).casefold()


def needs_submission_review(reason: str) -> bool:
    return any(text in reason for text in (
        "无法确认发布结果", "未返回可确认", "无法确认定时",
        "无法确认提交", "无法确认结果", "提交结果不明",
    ))


@dataclass
class FailureRecord:
    title: str
    reason: str
    product_folder: str
    evidence_dir: str
    updated_at: str
    publish_mode: str = ""
    status: str = "failed"
    source_report: str = ""
    listing_profile: str = "blanket"
    template_url: str = ""
    article_name: str = ""

    @property
    def key(self) -> str:
        identity = folder_key(Path(self.product_folder)) if self.product_folder else self.title
        return hashlib.sha256(identity.encode("utf-8")).hexdigest()


def record_matches_batch(record: FailureRecord, product_root: str | Path,
                         listing_profile: str, template_url: str,
                         article_name: str) -> bool:
    """Match the selected material root and listing settings without fuzzy paths.

    Legacy records without a template URL may match only within that exact root.
    A known template must match by its validated string ID, independently of the
    edit path or tracking parameters. Article names apply to the T-shirt scripts.
    """
    if not record.product_folder or not str(product_root).strip():
        return False
    if record.listing_profile != listing_profile:
        return False
    if (listing_profile in {"tshirt", "tshirt_bw"}
            and record.article_name.strip() != article_name.strip()):
        return False
    try:
        root = Path(product_root).expanduser().resolve()
        folder = Path(record.product_folder).expanduser().resolve()
        # Compare whole path components; sibling roots sharing a prefix do not
        # belong to this batch. Case folding matches Windows path identities.
        root_parts = tuple(part.casefold() for part in root.parts)
        folder_parts = tuple(part.casefold() for part in folder.parts)
        if folder_parts[:len(root_parts)] != root_parts:
            return False
        if record.template_url:
            previous = normalize_template_url(record.template_url)
            current = normalize_template_url(template_url)
            if not previous or not current:
                return False
            previous_id = parse_qs(urlsplit(previous).query)["id"][0]
            current_id = parse_qs(urlsplit(current).query)["id"][0]
            if previous_id != current_id:
                return False
    except (OSError, RuntimeError, ValueError, KeyError, TypeError):
        return False
    return True


class FailureStore:
    def __init__(self, directory: Path):
        self.directory = directory

    def _save(self, record: FailureRecord) -> None:
        self.directory.mkdir(parents=True, exist_ok=True)
        destination = self.directory / f"{record.key}.json"
        temporary = destination.with_name(
            f"{destination.name}.{os.getpid()}.{threading.get_ident()}.tmp"
        )
        temporary.write_text(json.dumps(asdict(record), ensure_ascii=False, indent=2), encoding="utf-8")
        temporary.replace(destination)

    def record(self, title: str, reason: str, product_folder: Path | None,
               evidence_dir: Path, publish_mode: str = "", source_report: str = "",
               listing_profile: str = "blanket", template_url: str = "",
               article_name: str = "") -> None:
        self._save(FailureRecord(
            title=title, reason=reason,
            product_folder=str(product_folder.resolve()) if product_folder is not None else "",
            evidence_dir=str(evidence_dir.resolve()),
            updated_at=datetime.now().isoformat(timespec="seconds"),
            publish_mode=publish_mode, source_report=source_report,
            listing_profile=listing_profile, template_url=template_url,
            article_name=article_name,
        ))

    def load(self) -> list[FailureRecord]:
        records = []
        if not self.directory.exists():
            return records
        for path in self.directory.glob("*.json"):
            if path.name == "legacy-import.json":
                continue
            # A damaged record must be reported, not silently treated as no failures.
            raw = json.loads(path.read_text(encoding="utf-8"))
            records.append(FailureRecord(**raw))
        return sorted(records, key=lambda item: item.updated_at, reverse=True)

    def resolve(self, folder: Path) -> None:
        key = folder_key(folder)
        for record in self.load():
            if record.product_folder and folder_key(Path(record.product_folder)) == key:
                record.status = "resolved"
                record.updated_at = datetime.now().isoformat(timespec="seconds")
                self._save(record)

    def dismiss(self, keys: Iterable[str]) -> int:
        """Remove selected failures from the active list, preserving their files.

        Keeping the record also prevents a later legacy import from restoring an
        intentionally removed entry. A new actual failure can still record it.
        """
        selected = set(keys)
        changed = 0
        for record in self.load():
            if record.key in selected and record.status == "failed":
                record.status = "dismissed"
                record.updated_at = datetime.now().isoformat(timespec="seconds")
                self._save(record)
                changed += 1
        return changed

    def import_latest_legacy_report(self, logs: Path, product_root: Path) -> int:
        """Import once; only an exact existing folder name may supply the old path."""
        marker = self.directory / "legacy-import.json"
        if marker.exists():
            return 0
        reports = sorted(logs.glob("run-summary-*.txt"), key=lambda p: (
            p.stat().st_mtime_ns, "final" in p.name,
        ), reverse=True) if logs.exists() else []
        if not reports:
            return 0
        report = reports[0]
        text = report.read_text(encoding="utf-8-sig")
        entries = re.finditer(
            r"^\d+\. (?P<title>[^\r\n]+)\r?\n"
            r"   原因：(?P<reason>.*?)\r?\n"
            r"(?:   商品文件夹：(?P<folder>[^\r\n]+)\r?\n)?"
            r"   现场：(?P<evidence>[^\r\n]+)", text, re.MULTILINE | re.DOTALL,
        )
        existing = {record.key for record in self.load()}
        imported = 0
        for entry in entries:
            title = entry["title"]
            candidate = Path(entry["folder"]) if entry["folder"] else product_root / title
            if not entry["folder"] and product_root.name == title:
                candidate = product_root
            # Never resolve old titles by prefix or by fuzzy matching another product.
            folder = candidate if candidate.is_dir() and candidate.name == title else None
            record = FailureRecord(title, entry["reason"], str(folder.resolve()) if folder else "",
                                   entry["evidence"], datetime.now().isoformat(timespec="seconds"),
                                   source_report=str(report))
            if record.key not in existing:
                self._save(record)
                existing.add(record.key)
                imported += 1
        self.directory.mkdir(parents=True, exist_ok=True)
        marker.write_text(json.dumps({"source": str(report), "imported": imported},
                                     ensure_ascii=False, indent=2), encoding="utf-8")
        return imported
