"""Validated template links and persistent article numbers for listing profiles.

An article reservation belongs to (product_key, English name). Retries, including
retries on a later day, retain their original numbers. If more color rows are
added, their numbers use that reservation's original date and the next available
sequence. A different English name starts a separate reservation. Never delete
the store to retry a product: it is the history that prevents duplicate numbers.
"""
from __future__ import annotations

import errno
import json
import os
import re
import tempfile
import threading
import time
from contextlib import contextmanager
from datetime import date
from pathlib import Path
from urllib.parse import parse_qsl, urlsplit, urlunsplit


_ARTICLE_NAME = re.compile(r"[A-Za-z][A-Za-z0-9_-]{0,7}\Z")
_LOCKS: dict[str, threading.RLock] = {}
_LOCKS_GUARD = threading.Lock()
_REPLACE_ATTEMPTS = 12


def normalize_template_url(value: str) -> str:
    """Return the quoteEdit equivalent of a validated Dianxiaomi template URL.

    The raw query is retained, including large/zero-padded IDs, other parameters,
    their order and their URL encoding. Empty configuration values are allowed.
    """
    if not isinstance(value, str):
        raise ValueError("模板编辑网址必须是文本。")
    cleaned = value.strip()
    if not cleaned:
        return ""
    wrappers = (("<", ">"), ('"', '"'), ("'", "'"), ("`", "`"),
                ("“", "”"), ("‘", "’"), ("（", "）"), ("(", ")"),
                ("[", "]"), ("「", "」"), ("『", "』"))
    # Chat applications may add both wrappers and a sentence-ending full stop.
    for _ in range(8):
        previous = cleaned
        cleaned = cleaned.rstrip("。．，、；！\r\n\t ")
        markdown = re.fullmatch(r"\[[^\]\r\n]*\]\((https://[^\r\n]+)\)", cleaned)
        if markdown:
            cleaned = markdown.group(1).strip()
        else:
            for left, right in wrappers:
                if cleaned.startswith(left) and cleaned.endswith(right):
                    cleaned = cleaned[len(left):-len(right)].strip()
                    break
        if previous == cleaned:
            break
    try:
        parsed = urlsplit(cleaned)
    except ValueError as exc:
        raise ValueError("模板编辑网址格式无效。") from exc
    if (parsed.scheme != "https"
            or parsed.netloc.lower() not in {"www.dianxiaomi.com", "dianxiaomi.com"}
            or parsed.path not in {"/web/popTemu/edit", "/web/popTemu/quoteEdit",
                                   "/web/popTemu/quoteEdite"}
            or parsed.fragment
            or any(char.isspace() or ord(char) < 32 for char in cleaned)):
        raise ValueError("请填写店小秘 Temu 的 https 模板编辑网址（edit 或 quoteEdit）。")
    ids = [item for key, item in parse_qsl(parsed.query, keep_blank_values=True)
           if key == "id"]
    if len(ids) != 1 or re.fullmatch(r"[0-9]+", ids[0]) is None:
        raise ValueError("模板编辑网址必须包含唯一、非空的数字 id。")
    return urlunsplit(("https", "www.dianxiaomi.com", "/web/popTemu/quoteEdit",
                       parsed.query, ""))


def validate_article_name(name: str) -> str:
    """Trim and validate 1..8 ASCII letters/digits/_/-, starting with a letter.

    Eight name characters keep YYYYMMDD-Name-0001 within the platform's 22-char
    SKC limit. Four-digit sequences deliberately stop at 9999.
    """
    if not isinstance(name, str) or not _ARTICLE_NAME.fullmatch(name.strip()):
        raise ValueError("货号英文名称须以英文字母开头，限 1–8 位英文字母、数字、_ 或 -。")
    return name.strip()


def _thread_lock(path: Path) -> threading.RLock:
    identity = os.path.normcase(str(path.resolve()))
    with _LOCKS_GUARD:
        return _LOCKS.setdefault(identity, threading.RLock())


@contextmanager
def _exclusive_file_lock(path: Path):
    """Lock a separate, never-replaced file across threads and processes."""
    with _thread_lock(path):
        descriptor = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
        locked = False
        try:
            if os.fstat(descriptor).st_size == 0:
                os.write(descriptor, b"\0")
            os.lseek(descriptor, 0, os.SEEK_SET)
            if os.name == "nt":
                import msvcrt
                deadline = time.monotonic() + 30
                while True:
                    try:
                        msvcrt.locking(descriptor, msvcrt.LK_NBLCK, 1)
                        locked = True
                        break
                    except OSError as exc:
                        if exc.errno not in {errno.EACCES, errno.EAGAIN, errno.EDEADLK}:
                            raise
                        if time.monotonic() >= deadline:
                            raise TimeoutError("货号记录被其他进程占用，请稍后重试。") from exc
                        time.sleep(0.05)
            else:
                import fcntl
                fcntl.flock(descriptor, fcntl.LOCK_EX)
                locked = True
            yield
        finally:
            if locked:
                if os.name == "nt":
                    import msvcrt
                    os.lseek(descriptor, 0, os.SEEK_SET)
                    msvcrt.locking(descriptor, msvcrt.LK_UNLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(descriptor, fcntl.LOCK_UN)
            os.close(descriptor)


class ArticleNumberStore:
    """Allocate stable SKC numbers from a shared JSON file, protected by a lock.

    ``path`` is a file path, normally under the application's shared data folder.
    A missing file starts a new history; an existing invalid file raises
    ValueError and is never silently replaced with empty history.
    """

    def __init__(self, path: str | Path):
        self.path = Path(path).resolve()
        self.lock_path = self.path.with_name(self.path.name + ".lock")

    def reserve(self, product_key: str, english_name: str, when: date | None = None,
                row_count: int = 1) -> list[str]:
        """Reserve one unique number per color row, or return a prior reservation."""
        name = validate_article_name(english_name)
        if not isinstance(product_key, str) or not product_key.strip():
            raise ValueError("商品标识不能为空。")
        if type(row_count) is not int or row_count < 1:
            raise ValueError("颜色行数必须是正整数。")
        if when is None:
            when = date.today()
        if not isinstance(when, date):
            raise ValueError("货号日期必须是 date。")
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with _exclusive_file_lock(self.lock_path):
            state = self._load()
            product = state["products"].setdefault(product_key, {})
            record = product.get(name)
            if record is None:
                prefix = f"{when:%Y%m%d}-{name}"
                record = {"prefix": prefix, "numbers": []}
                product[name] = record
            prefix = record["prefix"]
            numbers = record["numbers"]
            if len(numbers) < row_count:
                start = state["counters"].get(prefix, 0)
                needed = row_count - len(numbers)
                if start + needed > 9999:
                    raise ValueError("该日期与英文名称的货号序号已超过 9999，请更换英文名称；已有货号会保留。")
                numbers.extend(f"{prefix}-{sequence:04d}"
                               for sequence in range(start + 1, start + needed + 1))
                state["counters"][prefix] = start + needed
                self._save(state)
            return numbers[:row_count]

    def _load(self) -> dict:
        try:
            with self.path.open("r", encoding="utf-8") as source:
                state = json.load(source)
        except FileNotFoundError:
            return {"version": 1, "counters": {}, "products": {}}
        except (ValueError, UnicodeError) as exc:
            raise ValueError(f"货号记录损坏，请保留文件并联系维护人员：{self.path}") from exc
        try:
            self._validate(state)
        except (ValueError, TypeError, KeyError) as exc:
            raise ValueError(f"货号记录损坏，请保留文件并联系维护人员：{self.path}") from exc
        return state

    @staticmethod
    def _validate(state: dict) -> None:
        if (not isinstance(state, dict) or type(state.get("version")) is not int
                or state["version"] != 1 or not isinstance(state.get("counters"), dict)
                or not isinstance(state.get("products"), dict)):
            raise ValueError("Invalid article store schema")
        for prefix, counter in state["counters"].items():
            if not isinstance(prefix, str) or len(prefix) < 10 or prefix[8] != "-":
                raise ValueError("Invalid prefix")
            if not re.fullmatch(r"[0-9]{8}", prefix[:8]):
                raise ValueError("Invalid date")
            date(int(prefix[:4]), int(prefix[4:6]), int(prefix[6:8]))
            if validate_article_name(prefix[9:]) != prefix[9:]:
                raise ValueError("Invalid name")
            if type(counter) is not int or not 0 <= counter <= 9999:
                raise ValueError("Invalid sequence")
        seen = set()
        for product_key, product in state["products"].items():
            if (not isinstance(product_key, str) or not product_key.strip()
                    or not isinstance(product, dict) or not product):
                raise ValueError("Invalid product")
            for name, record in product.items():
                if validate_article_name(name) != name or not isinstance(record, dict):
                    raise ValueError("Invalid product name")
                prefix = record.get("prefix")
                numbers = record.get("numbers")
                if (not isinstance(prefix, str) or prefix[9:] != name
                        or prefix not in state["counters"]
                        or not isinstance(numbers, list) or not numbers):
                    raise ValueError("Invalid reservation")
                previous_sequence = 0
                for number in numbers:
                    if not isinstance(number, str) or not number.startswith(prefix + "-"):
                        raise ValueError("Invalid number")
                    suffix = number[len(prefix) + 1:]
                    if re.fullmatch(r"[0-9]{4}", suffix) is None:
                        raise ValueError("Invalid suffix")
                    sequence = int(suffix)
                    if (number in seen or sequence <= previous_sequence
                            or sequence > state["counters"][prefix]
                            or number != f"{prefix}-{sequence:04d}"):
                        raise ValueError("Duplicate or invalid sequence")
                    seen.add(number)
                    previous_sequence = sequence

    def _save(self, state: dict) -> None:
        descriptor, temporary_name = tempfile.mkstemp(
            prefix=self.path.name + ".", suffix=".tmp", dir=self.path.parent)
        temporary = Path(temporary_name)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as destination:
                json.dump(state, destination, ensure_ascii=False, indent=2)
                destination.write("\n")
                destination.flush()
                os.fsync(destination.fileno())
            # reserve() still owns the process lock here. Antivirus/indexers can
            # briefly open either file without Windows' delete-sharing flag;
            # retry the same complete transaction before allowing another writer.
            for attempt in range(_REPLACE_ATTEMPTS):
                try:
                    os.replace(temporary, self.path)
                    break
                except OSError as exc:
                    if getattr(exc, "winerror", None) not in {5, 32, 33}:
                        raise
                    if attempt == _REPLACE_ATTEMPTS - 1:
                        raise PermissionError(
                            errno.EACCES,
                            "无法保存货号记录：文件持续被占用或没有写入权限。"
                            "原记录已保留，本次未占用新货号；请解除占用或检查文件权限后重试。",
                            str(self.path),
                        ) from exc
                    time.sleep(min(0.025 * (2 ** attempt), 0.25))
        finally:
            temporary.unlink(missing_ok=True)
