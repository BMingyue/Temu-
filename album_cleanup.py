"""Bounded album cleanup using the same authenticated API as the official UI.

Deletion is intentionally never retried. An unresolved durable audit entry
blocks another cleanup until the operator has checked the album manually.
"""
from __future__ import annotations

import json
import math
import os
import re
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

from album_cleanup_policy import AlbumImage, AlbumUsage, cleanup_candidates, needs_cleanup


ALBUM_URL = "https://www.dianxiaomi.com/web/service/album"
API_ORIGIN = "https://www.dianxiaomi.com"
CDN_ORIGIN = "https://wxalbum-10001658-file.dianxiaomi.com"
MIB = 1024 * 1024


class AlbumCleanupError(RuntimeError):
    """Cleanup cannot safely continue; the caller must stop the upload batch."""


class _RetryableReadError(AlbumCleanupError):
    """A transient server response. Only the GET caller may retry it."""


def _response_detail(payload):
    """Keep a useful short reason without recording whole private responses."""
    if not isinstance(payload, dict):
        return "返回资料格式不正确"
    code = payload.get("code")
    code_text = str(code) if type(code) in {str, int} and re.fullmatch(r"-?\d{1,10}", str(code)) else "未知"
    message = payload.get("msg")
    if not isinstance(message, str):
        message = "没有提供错误原因"
    message = re.sub(r"<[^>]*>|https?://\S+", "", message)
    message = re.sub(r"[\x00-\x1f\x7f]+", " ", message).strip()[:120]
    return f"代码 {code_text}：{message or '没有提供错误原因'}"


@dataclass(frozen=True)
class _Index:
    puid: str
    total_bytes: int
    used_bytes: int
    total_images: int
    locked_count: int

    @property
    def usage(self):
        return AlbumUsage(self.total_bytes / MIB, self.used_bytes / MIB,
                          (self.total_bytes - self.used_bytes) / MIB)

    def audit(self):
        return {"puid": self.puid, "totalBytes": self.total_bytes,
                "usedBytes": self.used_bytes, "remainingBytes": self.total_bytes - self.used_bytes,
                "imageCount": self.total_images}


def _integer(value, label, minimum=0):
    if isinstance(value, bool) or not isinstance(value, (str, int)):
        raise AlbumCleanupError(f"图库{label}不明确，已停止清理。")
    if not re.fullmatch(r"\d+", str(value)) or int(value) < minimum:
        raise AlbumCleanupError(f"图库{label}无效，已停止清理。")
    return int(value)


def _asset_url(value):
    if not isinstance(value, str) or not value or any(c.isspace() for c in value):
        raise AlbumCleanupError("图库图片网址无效，已停止清理。")
    if value.startswith("/wxalbum/"):
        value = CDN_ORIGIN + value
    elif value.startswith("//"):
        value = "https:" + value
    parsed = urlsplit(value)
    try:
        if (parsed.scheme not in {"http", "https"} or not parsed.hostname
                or parsed.username is not None or parsed.password is not None
                or parsed.path in {"", "/"}):
            raise ValueError
        parsed.port
    except ValueError:
        raise AlbumCleanupError("图库图片网址格式不明确，已停止清理。") from None
    return value


def _protection_key(value):
    """Use the complete account asset path across Dianxiaomi CDN aliases."""
    value = _asset_url(value)
    parsed = urlsplit(value)
    if parsed.path.startswith("/wxalbum/"):
        return "https://album-asset.invalid" + parsed.path
    return "https://" + parsed.netloc.lower() + parsed.path


class AlbumCleaner:
    def __init__(self, album_page, log, check_stop, sleep, threshold_mb=100,
                 protected_urls=None, audit_path=None):
        self.page = album_page
        self.log = log
        self.check_stop = check_stop
        self.sleep = sleep
        self.threshold_mb = threshold_mb
        self.protected_urls = protected_urls if protected_urls is not None else set()
        self.audit_path = Path(audit_path) if audit_path is not None else None
        self._puid = None
        self._uncertain = False
        self._deleted_count = 0
        context = getattr(album_page, "context", None)
        self.request = getattr(context, "request", None) or getattr(album_page, "request", None)
        if self.request is None:
            raise AlbumCleanupError("图库没有可用的登录会话。")

    def _stop(self):
        if self.check_stop():
            raise AlbumCleanupError("任务已停止，图库清理已中断。")

    def _open(self):
        self._stop()
        current = urlsplit(getattr(self.page, "url", ""))
        if (current.scheme, current.netloc, current.path) != (
                "https", "www.dianxiaomi.com", "/web/service/album"):
            self.page.goto(ALBUM_URL, wait_until="domcontentloaded", timeout=45000)
            current = urlsplit(self.page.url)
        if (current.scheme, current.netloc, current.path) != (
                "https", "www.dianxiaomi.com", "/web/service/album"):
            raise AlbumCleanupError("图库尚未登录或页面地址不正确，已停止清理。")

    def _response(self, response, path):
        if response.status != 200:
            error = _RetryableReadError if response.status == 429 or 500 <= response.status < 600 else AlbumCleanupError
            raise error(f"图库接口 {path} 返回 HTTP {response.status}。")
        final_url = urlsplit(getattr(response, "url", API_ORIGIN + path))
        if (final_url.scheme, final_url.netloc, final_url.path) != ("https", "www.dianxiaomi.com", path):
            raise AlbumCleanupError("图库接口发生跳转，请检查登录后重新运行。")
        try:
            payload = response.json()
        except Exception as exc:
            raise AlbumCleanupError("图库接口没有返回有效资料，请检查登录后重新运行。") from exc
        if (not isinstance(payload, dict) or isinstance(payload.get("code"), bool)
                or payload.get("code") != 0 or not isinstance(payload.get("data"), dict)):
            error = _RetryableReadError if isinstance(payload, dict) and payload.get("code") == 2005 else AlbumCleanupError
            raise error(f"图库接口 {path} 返回失败（{_response_detail(payload)}）。")
        return payload["data"]

    def _get(self, path, params=None):
        self._stop()
        # The live service rejects rapid repeated reads, including the album
        # page's own initial request. Space GETs as well as deletion checks.
        self.sleep(1.1)
        self._stop()
        for attempt in range(3):
            self._stop()
            try:
                response = self.request.get(API_ORIGIN + path, params=params or {}, timeout=30000,
                                            max_redirects=0)
            except Exception as exc:
                self._stop()
                failure = _RetryableReadError("读取图库连接失败或超时。")
                failure.__cause__ = exc
            else:
                try:
                    return self._response(response, path)
                except _RetryableReadError as exc:
                    failure = exc
            if attempt == 2:
                raise AlbumCleanupError(f"图库只读检查已尝试3次，仍未恢复：{failure}") from failure
            delay = (2, 4)[attempt]
            self.log(f"图库检查暂时未完成：{failure} 等待{delay}秒重试只读检查（{attempt + 2}/3）。")
            self.sleep(delay)

    def _page(self, data, puid, requested_no=None, requested_size=None, filtered=False):
        if filtered:
            for field in ("fullCid", "name", "beginDate", "endDate"):
                if field not in data or data[field] != "":
                    raise AlbumCleanupError("图库筛选条件不明确，已停止清理。")
        page = data.get("picListPage")
        if not isinstance(page, dict) or not isinstance(page.get("list"), list):
            raise AlbumCleanupError("图库分页资料不完整，已停止清理。")
        no = _integer(page.get("pageNo"), "页码", 1)
        size = _integer(page.get("pageSize"), "每页数量", 1)
        total = _integer(page.get("totalSize"), "图片总数")
        pages = _integer(page.get("totalPage"), "总页数")
        locked = _integer(data.get("lockedCount"), "锁定数量")
        if (size > 300 or locked > total or page.get("params") != {}
                or (requested_no is not None and no != requested_no)
                or (requested_size is not None and size != requested_size)
                or (total > 0 and pages != math.ceil(total / size))
                or (total == 0 and pages not in {0, 1})
                or no > max(1, pages)
                or len(page["list"]) != min(size, max(0, total - (no - 1) * size))):
            raise AlbumCleanupError("图库分页或图片数量发生变化，已停止清理。")
        images, seen, previous_time = [], set(), None
        for row in page["list"]:
            if not isinstance(row, dict):
                raise AlbumCleanupError("图库图片资料格式不正确。")
            image_id = row.get("idStr")
            if (not isinstance(image_id, str) or not re.fullmatch(r"\d+", image_id)
                    or image_id in seen or str(row.get("id")) != image_id):
                raise AlbumCleanupError("图库图片 ID 缺失、重复或不一致。")
            if str(_integer(row.get("puid"), "图片所属账号", 1)) != puid:
                raise AlbumCleanupError("图库账号发生变化，已停止清理。")
            lock = row.get("lockState")
            file_type = row.get("fileType")
            if type(lock) is not int or lock not in {0, 1} or type(file_type) is not int or file_type != 0:
                raise AlbumCleanupError("图库图片锁定状态或文件类型不明确，已停止清理。")
            created = _integer(row.get("createTime"), "图片时间", 1)
            if previous_time is not None and created > previous_time:
                raise AlbumCleanupError("图库图片排序发生变化，已停止清理。")
            previous_time = created
            url = _asset_url(row.get("imgUrl"))
            path = urlsplit(url).path
            if path.startswith("/wxalbum/") and not path.startswith(f"/wxalbum/{puid}/"):
                raise AlbumCleanupError("图库图片网址与当前账号不一致，已停止清理。")
            # Some valid uploaded/material assets have no display name.  IDs,
            # ownership, locks and exact URLs still determine deletion safety.
            title = row.get("name")
            if title is not None and not isinstance(title, str):
                raise AlbumCleanupError("图库图片名称不明确。")
            images.append(AlbumImage(image_id, url, title or "", lock == 1))
            seen.add(image_id)
        return no, size, total, locked, images

    def _index(self):
        data = self._get("/api/album/index.json")
        summary = data.get("albumUserSummary")
        if not isinstance(summary, dict):
            raise AlbumCleanupError("无法读取图库空间使用情况。")
        puid = str(_integer(summary.get("puid"), "账号", 1))
        if self._puid is not None and puid != self._puid:
            raise AlbumCleanupError("图库登录账号发生变化，已停止清理。")
        capacity = _integer(summary.get("realSizeAllow"), "总容量", 1)
        used = _integer(summary.get("sizeUsed"), "已使用容量")
        if used > capacity:
            raise AlbumCleanupError("图库已超出账号可用容量，请先检查扩容状态。")
        _, _, count, locked, _ = self._page(data, puid)
        self._puid = puid
        return _Index(puid, capacity, used, count, locked)

    def read_usage(self):
        """Read-only capacity check. Never selects images or calls deletion."""
        self._open()
        return self._index().usage

    def _tail(self, index):
        pages = []
        count = math.ceil(index.total_images / 300)
        for page_no in range(count, max(0, count - 2), -1):
            data = self._get("/api/album/list.json", {
                "name": "", "startTime": "", "endTime": "", "fileType": 0,
                "fullCid": "", "pageNo": page_no, "pageSize": 300})
            _, _, total, locked, images = self._page(data, index.puid, page_no, 300, True)
            if total != index.total_images or locked != index.locked_count:
                raise AlbumCleanupError("图库图片总数或锁定资料发生变化，已停止清理。")
            pages.append(images)
        ids = [image.id for page in pages for image in page]
        if len(ids) != len(set(ids)):
            raise AlbumCleanupError("图库末两页出现重复图片 ID，已停止清理。")
        if self._index() != index:
            raise AlbumCleanupError("核对期间图库资料发生变化，已停止清理。")
        return pages

    def _selected(self, pages):
        mapping = {image.id: image for page in pages for image in page}
        normalized = [[AlbumImage(image.id, _protection_key(image.url), image.title, image.locked)
                       for image in page] for page in pages]
        try:
            protected = [_protection_key(value) for value in self.protected_urls]
            selected = cleanup_candidates(normalized, protected)
        except ValueError as exc:
            raise AlbumCleanupError(str(exc)) from exc
        return {image.id: mapping[image.id] for image in selected}

    def _audit_clear(self):
        if self.audit_path is None:
            raise AlbumCleanupError("没有设置图库清理记录位置，未删除任何图片。")
        pending = set()
        try:
            paths = {self.audit_path}
            if re.fullmatch(r"[a-f0-9]{32}", self.audit_path.parent.name):
                paths.update(self.audit_path.parent.parent.glob("*/cleanup.jsonl"))
            for path in paths:
                if not path.exists():
                    continue
                for line in path.read_text(encoding="utf-8").splitlines():
                    if not line.strip():
                        continue
                    event = json.loads(line)
                    if not isinstance(event, dict):
                        raise ValueError("invalid audit record")
                    if event.get("event") == "before_delete":
                        pending.add(event["operationId"])
                    if event.get("event") == "after_delete" and event.get("status") == "verified":
                        pending.discard(event["operationId"])
        except Exception as exc:
            raise AlbumCleanupError("无法核对上次图库清理记录，未删除任何图片。") from exc
        if pending:
            raise AlbumCleanupError("上次图库删除结果尚未确认，请先人工核对清理记录；程序不会重复删除。")

    def _audit(self, event, **fields):
        if self.audit_path is None:
            raise AlbumCleanupError("没有图库清理记录文件，未执行删除。")
        entry = {"at": datetime.now(timezone.utc).isoformat(), "event": event, **fields}
        try:
            self.audit_path.parent.mkdir(parents=True, exist_ok=True)
            with self.audit_path.open("a", encoding="utf-8", newline="\n") as stream:
                stream.write(json.dumps(entry, ensure_ascii=False, separators=(",", ":")) + "\n")
                stream.flush()
                os.fsync(stream.fileno())
        except Exception as exc:
            raise AlbumCleanupError("图库清理记录无法保存，已停止；不会自动重试删除。") from exc

    def _verify(self, before, batch):
        expected = before.total_images - len(batch)
        ids = {image.id for image in batch}
        for attempt in range(11):
            self._stop()
            after = self._index()
            if after.total_bytes != before.total_bytes:
                raise AlbumCleanupError("删除核对期间图库总容量发生变化。")
            if after.total_images < expected or after.total_images > before.total_images:
                raise AlbumCleanupError("删除核对期间图库图片数量出现其他变化。")
            if after.total_images == expected and after.used_bytes < before.used_bytes:
                tail = self._tail(after)
                if not ids.intersection(image.id for page in tail for image in page):
                    return after
            if attempt < 10:
                self.sleep(1)
        raise AlbumCleanupError("图库删除结果或空间释放尚未确认，已停止；不会再次发送删除。")

    def ensure_space(self, reserve_mb=0, *, allow_cleanup=True):
        """Check capacity, optionally forbidding all cleanup after an upload error.

        Suspending cleanup still permits a read-only capacity check. It never
        selects candidates or writes deletion audit entries when space is low.
        The caller must retain this suspension while uploaded assets are unknown.
        """
        if not isinstance(allow_cleanup, bool):
            raise AlbumCleanupError("是否允许自动清理必须是布尔值。")
        if self._uncertain:
            raise AlbumCleanupError("本次图库删除结果不确定，已停止自动清理，请人工核对。")
        self._open()
        initial = self._index()
        try:
            required = needs_cleanup(initial.usage, self.threshold_mb, reserve_mb)
        except ValueError as exc:
            raise AlbumCleanupError(str(exc)) from exc
        result = {"cleaned": False, "deleted_count": 0, "batches": 0,
                  "remaining_mb": initial.usage.remaining_mb}
        if not required:
            self.log(f"图库剩余 {initial.usage.remaining_mb:.2f} MB，空间充足。")
            return result
        if not allow_cleanup:
            target = max(float(self.threshold_mb), float(reserve_mb))
            raise AlbumCleanupError(
                f"图库剩余 {initial.usage.remaining_mb:.2f} MB，低于本次所需 {target:.2f} MB；"
                "上传异常后自动清理已暂停，未删除任何图片。请先人工处理图库空间后继续。")
        self._audit_clear()
        snapshot = self._tail(initial)
        selected = self._selected(snapshot)
        batches = [[image for image in page if image.id in selected] for page in snapshot]
        if not selected:
            raise AlbumCleanupError("图库末两页没有可清理图片（已锁定或受到保护），请人工处理后运行。")
        plan_id = uuid.uuid4().hex
        target = max(float(self.threshold_mb), float(reserve_mb))
        self._audit("plan", planId=plan_id, before=initial.audit(), targetMB=target,
                    batches=[[image.id for image in batch] for batch in batches],
                    candidateCount=len(selected))
        current = initial
        for planned in batches:
            self._stop()
            if current.usage.remaining_mb >= target:
                break
            if not planned:
                continue
            before = self._index()
            if before != current:
                raise AlbumCleanupError("删除前图库空间或图片数量发生变化，已停止清理。")
            verified_pages = self._tail(before)
            present = {image.id: image for page in verified_pages for image in page}
            allowed = self._selected(verified_pages)
            batch = []
            for original in planned:
                image = present.get(original.id)
                if image is None or image.locked != original.locked or _protection_key(image.url) != _protection_key(original.url):
                    raise AlbumCleanupError("待删除图片已离开末两页或网址/锁定状态发生变化，已停止清理。")
                if image.id in allowed:
                    batch.append(image)
            if not batch:
                continue
            operation = uuid.uuid4().hex
            self._stop()
            self._audit("before_delete", planId=plan_id, operationId=operation,
                        before=before.audit(), ids=[image.id for image in batch],
                        urls=[image.url for image in batch], deleteCount=len(batch))
            self._uncertain = True
            try:
                # Exactly one POST for this fixed ID batch. Never retry this call.
                response = self.request.post(API_ORIGIN + "/api/album/delPic.json",
                    form={"ids": ",".join(image.id for image in batch)}, timeout=30000,
                    max_redirects=0)
                data = self._response(response, "/api/album/delPic.json")
                if not isinstance(data.get("aus"), dict):
                    raise AlbumCleanupError("图库删除返回资料不完整，结果需要人工核对。")
                current = self._verify(before, batch)
                self._deleted_count += len(batch)
                self._audit("after_delete", planId=plan_id, operationId=operation,
                            status="verified", after=current.audit(), deletedCount=len(batch))
                self._uncertain = False
            except Exception as exc:
                try:
                    self._audit("after_delete", planId=plan_id, operationId=operation,
                                status="uncertain", deletedCount=0,
                                confirmedDeletedCount=self._deleted_count,
                                error=str(exc), before=before.audit())
                except AlbumCleanupError:
                    pass
                self._stop()
                raise AlbumCleanupError("图库删除结果尚未确认，任务已停止；不会自动重复删除。" + str(exc)) from exc
            result.update(cleaned=True, deleted_count=result["deleted_count"] + len(batch),
                          batches=result["batches"] + 1, remaining_mb=current.usage.remaining_mb)
            self.log(f"图库已核对清理 {len(batch)} 张，剩余 {current.usage.remaining_mb:.2f} MB。")
        self._audit("complete", planId=plan_id, after=current.audit(),
                    deletedCount=result["deleted_count"], targetMB=target)
        if current.usage.remaining_mb < target:
            raise AlbumCleanupError("已完成本次末两页范围清理，空间仍不足；请人工处理或扩容，程序不会继续删除其他页。")
        return result
