"""T-shirt colour-table automation, scoped to the live Dianxiaomi quote editor.

This module never submits or saves a product. The shared uploader owns those steps.
Selectors were inspected against the T-shirt template editor on 2026-10-23.
"""
from __future__ import annotations

import re
import time
from pathlib import Path
from typing import Callable, Sequence
from urllib.parse import urlsplit


class TshirtAutomationError(RuntimeError):
    pass


COLOR_TABLE_XPATH = (
    "xpath=//table[thead/tr/th[contains(.,'SKC编码')] "
    "and thead/tr/th[contains(.,'图片')]]"
)


def _url_key(value: str) -> str:
    """Ignore CDN display transforms, while retaining the original image identity."""
    parts = urlsplit(value or "")
    return parts.netloc.casefold() + parts.path if parts.netloc else str(value)


def _unique_urls(values: Sequence[str]) -> list[str]:
    result, seen = [], set()
    for value in values:
        key = _url_key(value)
        if key and key not in seen:
            result.append(value)
            seen.add(key)
    return result


def _color_table(uploader):
    tables = uploader.page.locator(COLOR_TABLE_XPATH)
    visible = [tables.nth(i) for i in range(tables.count()) if tables.nth(i).is_visible()]
    if len(visible) != 1:
        raise TshirtAutomationError("没有唯一定位到 T恤颜色表（SKC编码 / 图片），请核对所选脚本和模板。")
    return visible[0]


def _column_indices(table) -> tuple[int, int]:
    headers = table.locator("thead tr").last.locator("th").all_text_contents()
    codes = [i for i, text in enumerate(headers) if "SKC编码" in text]
    images = [i for i, text in enumerate(headers) if re.search(r"图片\s*[（(]", text)]
    if len(codes) != 1 or len(images) != 1:
        raise TshirtAutomationError("T恤颜色表表头发生变化，无法确认货号和图片列，已停止。")
    return codes[0], images[0]


def _color_rows(uploader):
    table = _color_table(uploader)
    code_column, image_column = _column_indices(table)
    candidates = table.locator("tbody > tr")
    rows = []
    for index in range(candidates.count()):
        row = candidates.nth(index)
        cells = row.locator(":scope > td")
        if row.is_visible() and cells.count() > max(code_column, image_column):
            if cells.nth(code_column).locator("input").count():
                rows.append(row)
    return rows, code_column, image_column


def color_row_count(uploader) -> int:
    return len(_color_rows(uploader)[0])


def _image_picker_button(container, label: str):
    """Match DOM text, excluding icon-font ::before content in accessible names."""
    buttons = container.locator("button:visible").filter(has_text=re.compile(r"^\s*选择图片\s*$"))
    count = buttons.count()
    if count == 0:
        raise TshirtAutomationError(f"{label}未找到可见的“选择图片”按钮，请等待页面加载完成或检查页面结构。")
    if count != 1:
        raise TshirtAutomationError(f"{label}找到多个“选择图片”按钮，无法确认唯一入口，未修改模板。")
    button = buttons.first
    if not button.is_enabled():
        raise TshirtAutomationError(f"{label}“选择图片”按钮当前被禁用，请等待页面加载完成或检查模板权限。")
    return button


def bw_color_labels(uploader) -> list[str]:
    """Return exact black/white identities in displayed row order, before editing."""
    table = _color_table(uploader)
    headers = table.locator("thead tr").last.locator("th").all_text_contents()
    columns = [i for i, value in enumerate(headers) if value.strip() == "颜色"]
    if len(columns) != 1:
        raise TshirtAutomationError("黑白T恤模板无法确认颜色列，未修改模板。")
    rows, code_column, image_column = _color_rows(uploader)
    visible_rows = table.locator("tbody > tr")
    visible_count = sum(visible_rows.nth(i).is_visible() for i in range(visible_rows.count()))
    if len(rows) != 2 or visible_count != 2:
        raise TshirtAutomationError("黑白T恤模板必须恰好包含白色和黑色两个颜色行，未修改模板。")
    aliases = {"白色": "white", "黑色": "black", "white": "white", "black": "black"}
    labels = []
    for row in rows:
        cells = row.locator(":scope > td")
        text = cells.nth(columns[0]).inner_text().strip().casefold()
        label = aliases.get(text)
        if label is None:
            raise TshirtAutomationError(f"黑白T恤模板出现不支持的颜色：{text}；应为白色和黑色，未修改模板。")
        labels.append(label)
    if set(labels) != {"white", "black"}:
        raise TshirtAutomationError("黑白T恤模板颜色重复或缺少白色/黑色，未修改模板。")
    return labels


def validate_bw_rows(uploader) -> list[str]:
    """Public preflight for callers that reserve one article number per row."""
    labels = bw_color_labels(uploader)
    rows, code_column, image_column = _color_rows(uploader)
    for row in rows:
        cells = row.locator(":scope > td")
        target = cells.nth(code_column).locator("input").first
        if not target.is_enabled() or not target.is_editable():
            raise TshirtAutomationError("黑白T恤SKC货号输入框不可编辑，模板可能只读，未修改模板。")
        _image_picker_button(cells.nth(image_column), "黑白T恤颜色图：")
    return labels


def template_problems(uploader) -> list[str]:
    """A T-shirt has colour-image rows and size SKUs, rather than blanket previews."""
    return uploader.page.evaluate(r"""() => {
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
            const label = [...document.querySelectorAll('label[title]')]
                .find(el => el.title === name && visible(el));
            const section = label && label.closest('.ant-form-item');
            const selected = section && [...section.querySelectorAll('.ant-select-selection-item')]
                .some(el => visible(el) && el.textContent.trim() && !/请选择|未选择/.test(el.textContent));
            if (!selected) problems.push(name + '未加载或未选择');
        }
        const tables = [...document.querySelectorAll('table')].filter(table => {
            const heads = [...table.querySelectorAll('thead th')].filter(visible);
            return heads.some(el => /SKC编码/.test(el.textContent))
                && heads.some(el => /图片\s*[（(]/.test(el.textContent));
        });
        if (tables.length !== 1) {
            problems.push('T恤颜色表未加载（缺少SKC编码/图片表头，或所选模板不属于T恤脚本）');
        } else {
            const table = tables[0];
            const headers = [...table.querySelectorAll('thead tr:last-child th')];
            const codeIndex = headers.findIndex(el => /SKC编码/.test(el.textContent));
            const rows = [...table.querySelectorAll('tbody > tr')].filter(el => visible(el)
                && el.children[codeIndex]?.querySelector('input'));
            if (!rows.length) problems.push('T恤颜色行未加载或未选择颜色');
        }
        const sku = [...document.querySelectorAll('table')].find(table =>
            [...table.querySelectorAll('thead th')].some(el => visible(el) && /SKU货号/.test(el.textContent)));
        if (!sku || ![...sku.querySelectorAll('tbody > tr')].some(el => visible(el) && el.querySelector('input'))) {
            problems.push('T恤尺码SKU未加载或未选择尺码');
        }
        if (![...document.querySelectorAll('.material-img-module a[title="刷新"]')].some(visible)) {
            problems.push('产品素材图刷新入口未加载');
        }
        if (!document.querySelector('#wirelessDescBox')) problems.push('产品描述未加载');
        return problems;
    }""")


def _read_color_image(uploader, url: str) -> tuple[tuple[int, int], bytes, str] | None:
    """Read and decode an existing HTTPS asset without following redirects."""
    from io import BytesIO
    from PIL import Image

    try:
        parts = urlsplit(url)
        if (parts.scheme != "https" or not parts.hostname
                or parts.username is not None or parts.password is not None):
            return None
        parts.port  # Reject malformed ports before handing the URL to the client.
    except ValueError:
        return None
    uploader._check_stop()
    response = None
    asset = None
    try:
        response = uploader.page.context.request.get(url, timeout=10000, max_redirects=0)
        if response.status == 200 and response.url == url:
            body = response.body()
            with Image.open(BytesIO(body)) as image:
                image.load()
                if image.width > 0 and image.height > 0:
                    asset = image.size, body, Image.MIME.get(image.format, "application/octet-stream")
    except Exception:
        # A failed read is never evidence of a successful upload.
        pass
    finally:
        if response is not None:
            try:
                response.dispose()
            except Exception:
                pass
    uploader._check_stop()
    return asset


def _restore_color_preview(uploader, image_cell, url: str, body: bytes, content_type: str) -> bool:
    """Let the real img load verified original bytes and run the site's onload."""
    served = False

    def exact_url(value):
        return value == url

    def serve_asset(route):
        nonlocal served
        request = route.request
        if not served and request.url == url and request.method == "GET" and request.resource_type == "image":
            served = True
            route.fulfill(status=200, body=body, content_type=content_type,
                          headers={"Cache-Control": "no-store"})
        else:
            route.fallback()

    uploader._check_stop()
    uploader.page.route(exact_url, serve_asset)
    try:
        loaded = image_cell.locator(".image-box .single-image img").evaluate_all("""async (els, src) => {
            const image = els.find(el => el.getClientRects().length && el.getAttribute('src') === src);
            if (!image) return false;
            return await new Promise(resolve => {
                const finish = success => {
                    clearTimeout(timer);
                    image.removeEventListener('load', onLoad);
                    image.removeEventListener('error', onError);
                    resolve(success);
                };
                const onLoad = () => finish(image.getAttribute('src') === src &&
                    image.complete && image.naturalWidth > 0 && image.naturalHeight > 0);
                const onError = () => finish(false);
                const timer = setTimeout(() => finish(false), 7000);
                image.addEventListener('load', onLoad);
                image.addEventListener('error', onError);
                image.setAttribute('src', src);
            });
        }""", url)
    finally:
        # Remove only our exact, temporary handler, including on cancellation or
        # page errors. It must never remain around a later publish request.
        uploader.page.unroute(exact_url, serve_asset)
    uploader._check_stop()
    return bool(loaded)


def _wait_color_images(uploader, image_cell, expected_count: int,
                       expected_sizes: Sequence[tuple[int, int]] | None = None) -> list[str]:
    if expected_sizes is not None and len(expected_sizes) != expected_count:
        raise TshirtAutomationError("颜色图的尺寸清单与图片数量不一致。")
    deadline = time.monotonic() + max(180, uploader.config.upload_wait_seconds * 3,
                                      uploader.config.operation_timeout_seconds * 3)
    stable_since = None
    last_report = time.monotonic() - 5
    previous = None
    snapshot = []
    unready_since = {}
    reload_counts = {}
    probe_counts = {}
    last_probe = {}
    probe_size_mismatches = {}
    pending_load_events = set()

    def valid_url(value):
        try:
            parts = urlsplit(value)
            return (parts.scheme in {"https", "http"} and bool(parts.hostname)
                    and parts.username is None and parts.password is None
                    and (parts.port is None or 1 <= parts.port <= 65535))
        except ValueError:
            return False

    def dimensions(image):
        if image["ready"] and image["width"] > 0 and image["height"] > 0:
            return image["width"], image["height"]
        return None  # API metadata alone cannot populate the website's model.

    def image_ready(index, image):
        size = dimensions(image)
        return (valid_url(image["src"]) and image["src"] not in pending_load_events and size is not None
                and (expected_sizes is None or (index < len(expected_sizes)
                     and size == tuple(expected_sizes[index]))))

    while time.monotonic() < deadline:
        uploader._check_stop()
        check_space = getattr(uploader, "_check_album_upload_space", None)
        if callable(check_space):
            check_space()
        snapshot = image_cell.locator(".image-box .single-image img").evaluate_all("""els => els.map(el => ({
            src: el.getAttribute('src') || '', width: el.naturalWidth, height: el.naturalHeight,
            ready: el.complete, visible: !!el.getClientRects().length
        })).filter(el => el.visible)""")
        signature = tuple(image["src"] for image in snapshot)
        complete_urls = (len(snapshot) == expected_count and all(valid_url(src) for src in signature)
                         and len({_url_key(src) for src in signature}) == expected_count)
        # The site may finish uploading while its thumbnail request fails. Retry
        # only that preview, retaining the exact URL, card, and image order.
        if complete_urls:
            for index, image in enumerate(snapshot):
                src = image["src"]
                loaded = image["ready"] and image["width"] > 0 and image["height"] > 0
                if loaded and src not in pending_load_events:
                    unready_since.pop(src, None)
                    continue  # A loaded image with the wrong size must fail.
                if (loaded and expected_sizes is not None
                        and (image["width"], image["height"]) != tuple(expected_sizes[index])):
                    continue
                now = time.monotonic()
                elapsed = now - unready_since.setdefault(src, now)
                reloads = reload_counts.get(src, 0)
                if image["ready"] and reloads < 2 and elapsed >= (2 if reloads == 0 else 5):
                    image_cell.locator(".image-box .single-image img").evaluate_all("""(els, src) => {
                        const image = els.find(el => el.getClientRects().length && el.getAttribute('src') === src);
                        if (image && image.complete && (!image.naturalWidth || !image.naturalHeight)) {
                            image.setAttribute('src', src);
                        }
                    }""", src)
                    reload_counts[src] = reloads + 1
                    uploader.log(f"第 {index + 1} 张颜色图缩略图未加载，重载原地址预览（{reloads + 1}/2），不重新上传。")
                if (src not in probe_size_mismatches and elapsed >= 8
                        and probe_counts.get(src, 0) < 2
                        and now - last_probe.get(src, float("-inf")) >= 5
                        and now < deadline):
                    probe_counts[src] = probe_counts.get(src, 0) + 1
                    last_probe[src] = now
                    asset = _read_color_image(uploader, src)
                    if asset is not None:
                        size, body, content_type = asset
                        if expected_sizes is not None and size != tuple(expected_sizes[index]):
                            probe_size_mismatches[src] = size
                            continue
                        pending_load_events.add(src)
                        loaded_preview = _restore_color_preview(uploader, image_cell, src, body, content_type)
                        if loaded_preview:
                            pending_load_events.discard(src)
                        uploader.log(f"第 {index + 1} 张颜色图原地址核验为 {size[0]}×{size[1]}；"
                                     + ("已恢复网页预览，等待网页尺寸回读。" if loaded_preview
                                        else "网页尺寸仍未就绪，不按原图核验结果放行。"))
        ready = complete_urls and all(image_ready(i, image) for i, image in enumerate(snapshot))
        if ready:
            if signature != previous or stable_since is None:
                stable_since = time.monotonic()
            elif time.monotonic() - stable_since >= 0.6:
                return list(signature)
        else:
            stable_since = None
        previous = signature
        if time.monotonic() - last_report >= 5:
            ready_count = sum(image_ready(i, image) for i, image in enumerate(snapshot))
            uploader.log(f"T恤颜色图上传进度：{ready_count}/{expected_count} 张图片按所选处理方式就绪。")
            last_report = time.monotonic()
        uploader._sleep(0.3)
    readable = sum(dimensions(image) is not None for image in snapshot)
    unloaded = [str(i + 1) for i, image in enumerate(snapshot) if dimensions(image) is None]
    mismatched = [f"{i + 1}（实际 {dimensions(image)[0]}×{dimensions(image)[1]}，"
                  f"应为 {expected_sizes[i][0]}×{expected_sizes[i][1]}）"
                  for i, image in enumerate(snapshot)
                  if expected_sizes is not None and i < len(expected_sizes)
                  and dimensions(image) is not None and dimensions(image) != tuple(expected_sizes[i])]
    details = [f"应有 {expected_count} 张图片，实际卡片 {len(snapshot)} 张，可读取 {readable} 张"]
    if unloaded:
        details.append("网页尺寸未就绪的位置：" + "、".join(unloaded))
    if mismatched:
        details.append("尺寸不匹配的位置：" + "、".join(mismatched))
    pending_events = [str(i + 1) for i, image in enumerate(snapshot) if image["src"] in pending_load_events]
    if pending_events:
        details.append("网页图片加载事件未完成的位置：" + "、".join(pending_events))
    probe_mismatched = [f"{i + 1}（实际 {probe_size_mismatches[image['src']][0]}×"
                        f"{probe_size_mismatches[image['src']][1]}，应为 "
                        f"{expected_sizes[i][0]}×{expected_sizes[i][1]}）"
                        for i, image in enumerate(snapshot)
                        if image["src"] in probe_size_mismatches and expected_sizes is not None
                        and i < len(expected_sizes)]
    if probe_mismatched:
        details.append("原图核验尺寸不匹配的位置：" + "、".join(probe_mismatched))
    if any(not valid_url(image["src"]) for image in snapshot):
        details.append("存在未完成的图片地址")
    elif len({_url_key(image["src"]) for image in snapshot}) != len(snapshot):
        details.append("存在重复图片地址")
    raise TshirtAutomationError("T恤颜色图上传或尺寸核对未完成：" + "；".join(details) + "。已停止后续操作。")


def upload_images(uploader, job, article_numbers: Sequence[str],
                  prepare_image: Callable[[Path, Path], Path | None],
                  color_image_sets: dict[str, Sequence[Path]] | None = None) -> None:
    """Replace images and SKC codes only; prices, size SKUs and stock remain in the template."""
    rows, code_column, image_column = _color_rows(uploader)
    if not rows or len(article_numbers) != len(rows):
        raise TshirtAutomationError("T恤颜色行数与预留货号数量不一致，未修改图片或货号。")
    is_bw = color_image_sets is not None or getattr(uploader.config, "listing_profile", "") == "tshirt_bw"
    labels = validate_bw_rows(uploader) if is_bw else []
    if is_bw:
        if color_image_sets is None or set(color_image_sets) != {"white", "black"}:
            raise TshirtAutomationError("黑白T恤必须分别提供白色和黑色图片，未修改模板。")
        row_sources = [list(color_image_sets[label]) for label in labels]
    else:
        row_sources = [list(job.images) for _ in rows]
    if any(not 1 <= len(sources) <= 10 for sources in row_sources):
        raise TshirtAutomationError("T恤每个颜色应上传 1 至 10 张图片，请检查商品图片和通用细节图。")
    if is_bw:
        first = getattr(uploader.config, "bw_first_color", "white")
        if first not in {"white", "black"} or len(job.images) < 2:
            raise TshirtAutomationError("黑白T恤的原始商品图或颜色对应无效，未修改模板。")
        anchors = {first: Path(job.images[0]).resolve(),
                   "black" if first == "white" else "white": Path(job.images[1]).resolve()}
        if anchors["white"] == anchors["black"]:
            raise TshirtAutomationError("黑白T恤两种颜色不能使用同一张原始商品图，未修改模板。")
        for color, other in (("white", "black"), ("black", "white")):
            identities = [Path(source).resolve() for source in color_image_sets[color]]
            if anchors[color] not in identities:
                raise TshirtAutomationError(f"黑白T恤{color}图片组缺少对应的原始商品图，未修改模板。")
            if len(set(identities)) != len(identities):
                raise TshirtAutomationError("黑白T恤图片组存在重复图片，未修改模板。")
            if anchors[other] in identities:
                raise TshirtAutomationError("黑白T恤图片组混入了另一种颜色的商品主图，未修改模板。")
    if len(set(article_numbers)) != len(article_numbers):
        raise TshirtAutomationError("T恤各颜色货号必须互不相同，未修改模板。")
    # Check every code before touching any row, so a bad code cannot leave partial edits.
    for row, code in zip(rows, article_numbers):
        target = row.locator(":scope > td").nth(code_column).locator("input").first
        declared_limit = target.get_attribute("maxlength")
        limit = min(22, int(declared_limit)) if declared_limit and declared_limit.isdigit() else 22
        if not code or len(code) > limit or not re.fullmatch(r"[A-Za-z0-9_-]+", code):
            raise TshirtAutomationError(f"生成的SKC货号不符合要求（英文、数字、连字符或下划线，最多 {limit} 位）：{code}")
        if not target.is_enabled() or not target.is_editable():
            raise TshirtAutomationError("T恤SKC货号输入框不可编辑，未修改模板。")
        _image_picker_button(row.locator(":scope > td").nth(image_column), "T恤颜色图：")

    from contextlib import nullcontext
    from tempfile import TemporaryDirectory
    from PIL import Image
    from image_processing import describe_options, options_from_config
    options = options_from_config(uploader.config)
    if options.mode == "original":
        stage_context = nullcontext(None)
    else:
        stage_parent = Path(uploader.upload_stage_dir) / "tshirt"
        stage_parent.mkdir(parents=True, exist_ok=True)
        stage_context = TemporaryDirectory(prefix="upload-", dir=stage_parent)
    # Do not remove or write fixed filenames in a parent that may hold source images.
    with stage_context as stage_name:
        stage_dir = Path(stage_name) if stage_name is not None else None
        prepared = {}
        staged_rows = []
        expected_rows = []
        uploader.log("上传图片处理：" + describe_options(options) + "；源文件不变。")
        for sources in row_sources:
            staged = []
            for source in sources:
                uploader._check_stop()
                key = str(Path(source).resolve()).casefold()
                if key not in prepared:
                    if options.mode == "original":
                        prepared[key] = str(Path(source))
                    else:
                        target = stage_dir / f"{len(prepared) + 1:02d}.jpg"
                        actual = prepare_image(Path(source), target)
                        prepared[key] = str(actual if actual is not None else target)
                staged.append(prepared[key])
            staged_rows.append(staged)
            expected = None
            if options.mode != "original":
                expected = []
                for path in staged:
                    with Image.open(path) as image:
                        expected.append(image.size)
            expected_rows.append(expected)
        uploader._tshirt_image_urls = []
        uploader._tshirt_all_image_urls = []
        uploader._tshirt_color_image_urls = {}
        uploader._tshirt_bw_upload = is_bw
        uploader._tshirt_description_urls = []
        uploader.log(f"T恤脚本：将图片分别上传到 {len(rows)} 个颜色行，各行第一张为对应颜色主图。")
        for row_index, (row, code, staged) in enumerate(zip(rows, article_numbers, staged_rows), start=1):
            uploader._check_stop()
            cells = row.locator(":scope > td")
            image_cell = cells.nth(image_column)
            cards = image_cell.locator(".image-box .single-image")
            old_count = cards.count()
            for _ in range(30):
                uploader._check_stop()
                count = cards.count()
                if count == 0:
                    break
                card = cards.first
                card.hover(timeout=5000)
                delete = card.locator(".icon_delete")
                if delete.count() != 1:
                    raise TshirtAutomationError("T恤颜色图删除入口发生变化，已停止，避免保留模板旧图。")
                delete.click(force=True, timeout=5000)
                deletion_deadline = time.monotonic() + 5
                while cards.count() >= count and time.monotonic() < deletion_deadline:
                    uploader._sleep(0.1)
                if cards.count() >= count:
                    raise TshirtAutomationError("T恤模板旧颜色图未能删除，已停止，避免新旧图片混用。")
            if cards.count():
                raise TshirtAutomationError("T恤旧颜色图未清空，已停止上传。")
            target = cells.nth(code_column).locator("input").first
            target.fill(code)
            target.press("Tab")
            if target.input_value() != code:
                raise TshirtAutomationError("T恤SKC货号写入回读不一致，已停止。")
            _image_picker_button(image_cell, "T恤颜色图：").click(timeout=5000)
            local = uploader._wait_visible(
                uploader.page.locator(".ant-dropdown:visible li[data-menu-id='local']"),
                "T恤颜色图本地上传入口", 8)
            with uploader.page.expect_file_chooser(
                timeout=uploader.config.operation_timeout_seconds * 1000
            ) as chooser:
                local.click(timeout=5000)
            chooser.value.set_files(staged)
            urls = _wait_color_images(uploader, image_cell, len(staged), expected_rows[row_index - 1])
            if row_index == 1:
                uploader._tshirt_image_urls = urls
            uploader._tshirt_all_image_urls.extend(urls)
            if is_bw:
                uploader._tshirt_color_image_urls[labels[row_index - 1]] = urls
            uploader.log(f"T恤颜色行 {row_index}/{len(rows)} 完成：已替换 {old_count} 张旧图，货号 {code}，新图 {len(urls)} 张。")
        uploader._tshirt_all_image_urls = _unique_urls(uploader._tshirt_all_image_urls)


def refresh_material_image(uploader) -> None:
    urls = getattr(uploader, "_tshirt_image_urls", [])
    if not urls:
        raise TshirtAutomationError("尚未获得T恤新颜色图，不能刷新素材图。")
    section = uploader._visible(uploader.page.locator(".material-img-module"))
    if section is None:
        raise TshirtAutomationError("没有找到T恤产品素材图区域。")
    refresh = uploader._visible(section.locator("a[title='刷新']"))
    if refresh is None:
        raise TshirtAutomationError("没有找到素材图右下角的刷新按钮。")
    refresh.click(timeout=5000)
    deadline = time.monotonic() + max(15, uploader.config.operation_timeout_seconds)
    while time.monotonic() < deadline:
        uploader._check_stop()
        images = section.locator(".single-image img")
        if images.count():
            actual = images.first.get_attribute("src") or ""
            if _url_key(actual) == _url_key(urls[0]):
                uploader.log("产品素材图已刷新并核对：与当前商品第一张颜色图一致。")
                return
        uploader._sleep(0.3)
    raise TshirtAutomationError("素材图刷新后未匹配当前商品主图，已停止后续操作。")


def choose_description_images(uploader, all_images: bool) -> None:
    """Reference both colour sets for BW; preserve ordinary T-shirt behaviour."""
    source = getattr(uploader, "_tshirt_image_urls", [])
    if all_images and getattr(uploader, "_tshirt_bw_upload", False):
        source = getattr(uploader, "_tshirt_all_image_urls", [])
    if not source:
        raise TshirtAutomationError("没有可引用的T恤新颜色图，已阻止引用模板旧图。")
    expected = _unique_urls(source if all_images else source[:1])
    upload_dialog = uploader._top_dialog()
    _image_picker_button(upload_dialog, "T恤描述图：").click(timeout=5000)
    menu = uploader._wait_visible(
        uploader.page.locator(".ant-dropdown:visible li[data-menu-id='sku_product_image']"),
        "引用SKC轮播图入口")
    menu.click(timeout=5000)
    uploader._sleep(0.4)
    picker = uploader._top_dialog()
    labels = picker.locator(".ant-checkbox-group.img-box label.ant-checkbox-wrapper")
    uploader._wait_visible(labels, "T恤颜色图引用列表")
    available = {}
    for index in range(labels.count()):
        label = labels.nth(index)
        img = label.locator("img")
        checkbox = label.locator("input[type='checkbox']")
        if not img.count() or not checkbox.count():
            continue
        if checkbox.is_checked():
            checkbox.uncheck(force=True)
        key = _url_key(img.first.get_attribute("src") or "")
        available.setdefault(key, checkbox)
    if any(_url_key(url) not in available for url in expected):
        raise TshirtAutomationError("引用图片弹窗中缺少当前商品新图，已停止，避免带入模板旧图。")
    for url in expected:
        uploader._check_stop()
        available[_url_key(url)].check(force=True)
    actual = labels.evaluate_all("""els => els.filter(el => el.querySelector('input')?.checked)
        .map(el => el.querySelector('img')?.getAttribute('src') || '')""")
    if [_url_key(url) for url in actual] != [_url_key(url) for url in expected]:
        raise TshirtAutomationError("T恤描述图片引用数量或顺序与新图不一致，已停止。")
    uploader._tshirt_description_urls = expected
    uploader._click_dialog_button("选择")
    picker.wait_for(state="hidden", timeout=10000)


def verify_description_images(uploader) -> None:
    expected = getattr(uploader, "_tshirt_description_urls", [])
    if not expected:
        raise TshirtAutomationError("没有T恤描述图片引用记录，已停止。")
    deadline = time.monotonic() + max(10, uploader.config.operation_timeout_seconds)
    while time.monotonic() < deadline:
        uploader._check_stop()
        actual = uploader.page.locator("#wirelessDescContentBox img").evaluate_all(
            "els => els.map(el => el.getAttribute('src') || '')")
        if [_url_key(url) for url in actual] == [_url_key(url) for url in expected]:
            uploader.log(f"T恤描述图已核对：{len(expected)} 张，顺序与当前商品新图一致。")
            return
        uploader._sleep(0.3)
    raise TshirtAutomationError("保存后的T恤描述图与当前商品新图不一致，已停止发布。")
