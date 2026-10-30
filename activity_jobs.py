"""Safe, resumable planning for Temu price adjustment and activity enrollment.

This module deliberately does not call Temu.  It turns locally captured evidence
into auditable execution manifests.  A browser-side executor may consume those
manifests only after a separate, explicit confirmation in a future live session.
"""
from __future__ import annotations

import hashlib
import json
import re
import uuid
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP

import collector


MONEY = Decimal("0.01")
DISCOUNT = Decimal("0.75")
SIZE_TOLERANCE = Decimal("2")
TWO_PRICE_TOLERANCE_CENTS = 200
DEFAULT_CONFIG = {
    "currency": "CNY",
    "discount_rate": "0.75",
    "category": "未分类",
    "two_price_mode": False,
    "price_tolerance_cents": TWO_PRICE_TOLERANCE_CENTS,
    "evidence_max_age_hours": 24,
    "require_adjustable_confirmation": True,
    "inventory_rule": "platform_reference",
    "inventory_fixed": None,
    "real_execution_enabled": False,
    "price_match": {"field": "dailyPrice"},
    "size_prices": {
        "120.05×45.22cm": {"floor": "72.00", "target_daily": "96.00"},
        "60.21×39.86cm": {"floor": "28.00", "target_daily": "38.00"},
        "79.96×50.51cm": {"floor": "50.00", "target_daily": "67.00"},
        "89.99×60.11cm": {"floor": "70.00", "target_daily": "94.00"},
    },
}

STATES = (
    "pending_collection", "matched", "pending_price_adjustment",
    "price_submitted", "price_effective", "eligible", "ineligible",
    "enrollment_submitted", "platform_confirmed", "failed",
)


def now():
    return datetime.now(timezone.utc).isoformat()


def init(db):
    db.executescript("""
    CREATE TABLE IF NOT EXISTS activity_evidence_snapshots(
      id TEXT PRIMARY KEY, captured TEXT NOT NULL, mall_id TEXT NOT NULL,
      campaign_id TEXT NOT NULL, source_url TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS activity_jobs(
      id TEXT PRIMARY KEY, created TEXT NOT NULL, updated TEXT NOT NULL,
      mall_id TEXT NOT NULL, campaign_id TEXT NOT NULL, name TEXT NOT NULL,
      status TEXT NOT NULL, config TEXT NOT NULL, source_snapshot_id TEXT);
    CREATE TABLE IF NOT EXISTS activity_job_items(
      job_id TEXT NOT NULL, item_key TEXT NOT NULL, state TEXT NOT NULL,
      selected INTEGER NOT NULL DEFAULT 0, retries INTEGER NOT NULL DEFAULT 0,
      payload TEXT NOT NULL, updated TEXT NOT NULL,
      PRIMARY KEY(job_id,item_key));
    CREATE TABLE IF NOT EXISTS activity_audit(
      id TEXT PRIMARY KEY, job_id TEXT NOT NULL, item_key TEXT,
      stage TEXT NOT NULL, event TEXT NOT NULL, created TEXT NOT NULL,
      payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS activity_execution_manifests(
      id TEXT PRIMARY KEY, job_id TEXT NOT NULL, step TEXT NOT NULL,
      created TEXT NOT NULL, dry_run INTEGER NOT NULL, status TEXT NOT NULL,
      payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS activity_settings(
      id TEXT PRIMARY KEY, updated TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS activity_evidence_scope
      ON activity_evidence_snapshots(mall_id,campaign_id,captured DESC);
    CREATE INDEX IF NOT EXISTS activity_audit_job
      ON activity_audit(job_id,created DESC);
    """)


def _text(value):
    return str(value if value is not None else "").strip()


def _identifier(value, label, required=True):
    value = _text(value)
    if required and not value:
        raise ValueError(f"{label}为空")
    if value and not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", value):
        raise ValueError(f"{label}格式无效")
    return value


def _money(value, label, allow_none=False):
    if value in (None, "") and allow_none:
        return None
    if isinstance(value, bool):
        raise ValueError(f"{label}不是有效金额")
    try:
        amount = Decimal(str(value)).quantize(MONEY, rounding=ROUND_HALF_UP)
    except (InvalidOperation, ValueError):
        raise ValueError(f"{label}不是有效金额")
    if not amount.is_finite() or amount < 0:
        raise ValueError(f"{label}不是非负有效金额")
    return amount


def cents(amount):
    return int(amount * 100) if amount is not None else None


def amount_string(value):
    return format(Decimal(value).quantize(MONEY), "f")


def normalize_spec(value):
    """Return the exact configured size; never infer a nearby dimension."""
    text = normalize_dimension(value).lower()
    match = re.fullmatch(r"(120\.05×45\.22|60\.21×39\.86|79\.96×50\.51|89\.99×60\.11)cm", text)
    return match.group(1) + "cm" if match else ""


def normalize_dimension(value):
    """Normalize an explicit dimension without treating it as configured."""
    if isinstance(value, dict):
        value = " ".join(_text(v) for v in value.values())
    text = _text(value).lower().replace("厘米", "cm").replace("英寸", "in").replace("inches", "in").replace("inch", "in")
    text = text.replace("*", "×").replace("x", "×").replace("✕", "×")
    text = re.sub(r"\s+", "", text)
    match = re.search(r"(\d+(?:\.\d+)?)×(\d+(?:\.\d+)?)(cm|in)?", text)
    return "" if not match else f"{match.group(1)}×{match.group(2)}{match.group(3) or ''}"


def normalize_variant(value):
    """Normalize dimensions while retaining a visible non-size SKU attribute."""
    dimension = normalize_dimension(value)
    if dimension:
        return dimension
    if isinstance(value, dict):
        value = " ".join(_text(part) for part in value.values())
    text = re.sub(r"\s+", " ", _text(value)).strip()
    return text if 0 < len(text) <= 100 and not any(ord(char) < 32 for char in text) else ""


def match_size_rule(value, rules):
    """Exact dimensions first, otherwise unique same-unit match within +/-2 per edge."""
    dimension=normalize_variant(value)
    def parts(text):
        m=re.fullmatch(r"(\d+(?:\.\d+)?)×(\d+(?:\.\d+)?)(cm|in)",normalize_dimension(text))
        return (Decimal(m[1]),Decimal(m[2]),m[3]) if m else None
    target=parts(dimension)
    if not target:
        exact=[(key,rule) for key,rule in rules.items() if key.casefold()==dimension.casefold()]
        return (*exact[0],'') if len(exact)==1 else (dimension,None,'')
    exact=[];near=[]
    for key,rule in rules.items():
        size=parts(key)
        if not size or size[2]!=target[2]:continue
        if size[:2]==target[:2]:exact.append((key,rule))
        elif abs(size[0]-target[0])<=SIZE_TOLERANCE and abs(size[1]-target[1])<=SIZE_TOLERANCE:near.append((key,rule))
    matches=exact or near
    if len(matches)==1:return (*matches[0],'')
    if len(matches)>1:return (dimension,None,'尺寸浮动范围命中多个预设，请核对尺寸规则')
    return (dimension,None,'')


def _dimension_unit(value):
    match = re.fullmatch(r"\d+(?:\.\d+)?×\d+(?:\.\d+)?(cm|in)", normalize_dimension(value))
    return match[1] if match else ""


def config_from(body=None):
    body = body or {}
    config = json.loads(json.dumps(DEFAULT_CONFIG))
    for key in ("price_tolerance_cents", "evidence_max_age_hours", "require_adjustable_confirmation", "inventory_rule", "inventory_fixed", "two_price_mode"):
        if key in body:
            config[key] = body[key]
    if not isinstance(config["two_price_mode"], bool):
        raise ValueError("两档价格模式设置无效")
    if config["two_price_mode"]:
        # The blanket/mat workflow intentionally treats both configured prices
        # as bands: target/floor comparisons may vary by up to CNY 2.00.
        config["price_tolerance_cents"] = TWO_PRICE_TOLERANCE_CENTS
    category = _text(body.get("category", config["category"]))
    if not category or len(category) > 60 or any(ord(char) < 32 for char in category):
        raise ValueError("商品类目须为 1～60 个字符")
    config["category"] = category
    if config["inventory_rule"] not in ("platform_reference", "sales_stock", "fixed"):
        raise ValueError("库存规则不受支持")
    if config["inventory_rule"] == "fixed":
        fixed = config.get("inventory_fixed")
        if isinstance(fixed, bool) or not isinstance(fixed, int) or fixed < 0:
            raise ValueError("固定活动库存必须为非负整数")
    if not isinstance(config["price_tolerance_cents"], int) or not 0 <= config["price_tolerance_cents"] <= 1000:
        raise ValueError("价格容差必须为 0 到 1000 分")
    price_match = body.get("price_match", config["price_match"])
    if not isinstance(price_match, dict):
        raise ValueError("活动价格匹配设置格式无效")
    field = _text(price_match.get("field") or "dailyPrice")
    if field not in ("dailyPrice", "referenceActivityPrice", "declaredPrice"):
        raise ValueError("活动价格匹配依据不受支持")
    config["price_match"] = {"field": field}
    if "size_prices" in body:
        supplied = body["size_prices"]
        if not isinstance(supplied, dict) or len(supplied) > 100:
            raise ValueError("规格价格规则格式或数量无效")
        rules = {}
        for raw_spec, raw_rule in supplied.items():
            spec = normalize_variant(raw_spec)
            if not spec or not isinstance(raw_rule, dict):
                raise ValueError(f"规格价格规则无效：{_text(raw_spec)}")
            if spec.casefold() in {key.casefold() for key in rules}:
                raise ValueError(f"规格重复：{spec}")
            floor = _money(raw_rule.get("floor"), f"{spec} 底价")
            target = _money(raw_rule.get("target_daily"), f"{spec} 目标日常价")
            if floor <= 0 or target <= 0:
                raise ValueError(f"{spec} 的底价和目标日常价必须大于 0")
            raw_min, raw_max = raw_rule.get("match_min"), raw_rule.get("match_max")
            if (raw_min in (None, "")) != (raw_max in (None, "")):
                raise ValueError(f"{spec} 的报名价格区间必须同时填写最低价和最高价")
            match_min = _money(raw_min, f"{spec} 区间最低价", True)
            match_max = _money(raw_max, f"{spec} 区间最高价", True)
            if match_min is not None and match_min > match_max:
                raise ValueError(f"{spec} 的报名价格区间最低价不能高于最高价")
            rules[spec] = {
                "floor": amount_string(floor), "target_daily": amount_string(target),
                "match_min": amount_string(match_min) if match_min is not None else None,
                "match_max": amount_string(match_max) if match_max is not None else None,
            }
        config["size_prices"] = rules
    return config


def _candidate_rows(body):
    rows = body.get("candidates")
    if not isinstance(rows, list) or len(rows) > 10000:
        raise ValueError("活动候选列表格式或大小无效")
    result = []
    seen = set()
    for raw in rows:
        if not isinstance(raw, dict):
            raise ValueError("活动候选记录必须为对象")
        row = {
            "spuId": _identifier(raw.get("spuId"), "SPU"),
            "skcId": _identifier(raw.get("skcId"), "SKC", required=False),
            # Candidate pages often expose SPU/SKC and variant prices but keep
            # the SKU ID out of the DOM.  Missing SKU IDs are resolved below
            # only when the local product evidence gives one exact match.
            "skuId": _identifier(raw.get("skuId"), "SKU", required=False),
            "skuCode": _identifier(raw.get("skuCode"), "SKU货号", required=False),
            "specification": normalize_variant(raw.get("specification") or raw.get("properties")),
            "dailyPrice": amount_string(_money(raw.get("dailyPrice"), "活动页日常价", True)) if raw.get("dailyPrice") not in (None, "") else None,
            "referenceActivityPrice": amount_string(_money(raw.get("referenceActivityPrice"), "活动参考价", True)) if raw.get("referenceActivityPrice") not in (None, "") else None,
            "referenceStock": raw.get("referenceStock"),
            "salesStock": raw.get("salesStock"),
            "eligible": raw.get("eligible") is True,
            "candidateStatus": _text(raw.get("candidateStatus")),
            "blockReason": _text(raw.get("blockReason")),
            "adjustable": raw.get("adjustable") if isinstance(raw.get("adjustable"), bool) else None,
            "source": _text(raw.get("source") or "activity_page"),
        }
        for stock_key in ("referenceStock", "salesStock"):
            stock = row[stock_key]
            if stock not in (None, "") and (isinstance(stock, bool) or not isinstance(stock, int) or stock < 0):
                raise ValueError(f"{stock_key}必须为非负整数")
        key = (row["spuId"], row["skcId"], row["skuId"] or row["specification"], row["dailyPrice"])
        if key in seen:
            continue
        seen.add(key)
        result.append(row)
    return result


def _resolve_missing_skus(db, mall, rows):
    """Recover hidden SKU IDs from a unique exact SPU+SKC+price match."""
    products = []
    for record in collector.current_records(db, "products", mall):
        value = json.loads(record["payload"])
        if not _text(value.get("skuId")):
            continue
        products.append({**value, "_captured": record["captured"]})

    products_by_spu = {}
    for product in products:
        products_by_spu.setdefault(_text(product.get("spuId")), []).append(product)
    resolved, unresolved, used_skus = [], [], set()
    recovered = 0
    for source in rows:
        row = dict(source)
        row["sourceIdentity"] = {key: source.get(key, "") for key in ("skcId", "skuId", "skuCode")}
        spu_products = products_by_spu.get(row["spuId"], [])
        if row["skuId"]:
            if not row["skcId"]:
                unique = {
                    (_text(item.get("skuId")), _text(item.get("skcId"))): item
                    for item in spu_products
                    if _text(item.get("skuId")) == row["skuId"]
                }
                if len(unique) != 1:
                    unresolved.append({**row, "resolutionError": "页面有 SKU ID 但缺少 SKC，商品库无法唯一补全"})
                    continue
                product = next(iter(unique.values()))
                row["skcId"] = _identifier(product.get("skcId"), "SKC")
                row["skuCode"] = row.get("skuCode") or _identifier(product.get("skuCode"), "SKU货号", required=False)
                row["identityResolution"] = "spu_sku_exact_local_skc"
                recovered += 1
            else:
                row["identityResolution"] = "activity_page_sku_id"
        else:
            if row.get("dailyPrice") is None and not row.get("skuCode"):
                unresolved.append({**row, "resolutionError": "页面未展示 SKU ID，且缺少日常价与SKU货号，无法安全补全"})
                continue
            wanted_price = _money(row["dailyPrice"], "活动页日常价") if row.get("dailyPrice") is not None else None
            matches = []
            for product in spu_products:
                if row["skcId"] and _text(product.get("skcId")) != row["skcId"]:
                    continue
                price = _money(product.get("declaredPrice"), "商品申报价", True)
                if wanted_price is not None and (price is None or cents(price) != cents(wanted_price)):
                    continue
                if row.get("skuCode") and _text(product.get("skuCode")) != row["skuCode"]:
                    continue
                matches.append(product)
            unique = {(_text(item.get("skuId")), _text(item.get("skuCode"))): item for item in matches}
            if len(unique) != 1:
                discriminator = "精确日常价与SKU货号" if wanted_price is not None and row.get("skuCode") else "精确日常价" if wanted_price is not None else "SKU货号"
                reason = f"没有找到同 SPU/SKC 且{discriminator}完全一致的 SKU" if not unique else f"同 SPU/SKC/{discriminator}命中 {len(unique)} 个 SKU，存在歧义"
                unresolved.append({**row, "resolutionError": reason})
                continue
            product = next(iter(unique.values()))
            row["skuId"] = _identifier(product.get("skuId"), "SKU")
            row["skcId"] = row["skcId"] or _identifier(product.get("skcId"), "SKC")
            row["skuCode"] = row.get("skuCode") or _identifier(product.get("skuCode"), "SKU货号", required=False)
            prefix = "spu_skc" if source.get("skcId") else "spu_unique"
            row["identityResolution"] = f"{prefix}_exact_daily_price_and_code" if wanted_price is not None and source.get("skuCode") else f"{prefix}_exact_daily_price" if wanted_price is not None else f"{prefix}_exact_sku_code"
            recovered += 1
        identity = (row["spuId"], row["skcId"], row["skuId"])
        if identity in used_skus:
            unresolved.append({**row, "resolutionError": "多个活动规格行指向同一个 SKU，已阻断重复映射"})
            continue
        used_skus.add(identity)
        resolved.append(row)
    return resolved, unresolved, recovered


def _product_catalog_state(db, mall):
    rows = list(collector.current_records(db, "products", mall))
    captured = max((_text(row["captured"]) for row in rows), default="")
    age_hours = None
    if captured:
        try:
            parsed = datetime.fromisoformat(captured.replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            age_hours = max(0, (datetime.now(timezone.utc) - parsed.astimezone(timezone.utc)).total_seconds() / 3600)
        except ValueError:
            pass
    return {"sku_count": len(rows), "captured": captured, "age_hours": age_hours}


def resolve_evidence(db, mall, payload):
    """Rebuild derived IDs against the current catalog without changing evidence."""
    sources = []
    for original in payload.get("candidates", []) + payload.get("unresolved_candidates", []):
        row = dict(original)
        observed = row.get("sourceIdentity")
        resolution = _text(row.get("identityResolution"))
        if isinstance(observed, dict):
            row.update({key: observed.get(key, "") for key in ("skcId", "skuId", "skuCode")})
        elif resolution.startswith(("spu_unique_", "spu_skc_exact_")):
            # Legacy snapshots did not retain the observed identity separately.
            # Never promote a formerly inferred ID into platform evidence.
            row["skuId"] = ""
            if resolution.startswith("spu_unique_"):
                row["skcId"] = ""
            if not resolution.endswith(("_and_code", "_sku_code")):
                row["skuCode"] = ""
        elif resolution == "spu_sku_exact_local_skc":
            row["skcId"] = ""
            row["skuCode"] = ""
        sources.append(row)
    source_candidates = _candidate_rows({"candidates": sources})
    candidates, unresolved, recovered = _resolve_missing_skus(db, mall, source_candidates)
    catalog = _product_catalog_state(db, mall)
    needs_refresh = bool(unresolved) and (
        not catalog["captured"] or catalog["age_hours"] is None or catalog["age_hours"] > 12
    )
    warnings = payload.get("capture_warnings")
    if not isinstance(warnings, list):
        warnings = [text for text in payload.get("warnings", []) if not (
            re.match(r"^\d+ 个页面隐藏的 SKU/SKC，已用", text)
            or re.match(r"^\d+ 个规格：", text)
            or text.startswith("本地商品目录超过 12 小时")
        )]
    warnings = list(warnings)
    if recovered:
        warnings.append(f"{recovered} 个页面隐藏的 SKU/SKC，已按当前同店铺商品目录唯一补全")
    counts = {}
    for row in unresolved:
        reason = row["resolutionError"]
        counts[reason] = counts.get(reason, 0) + 1
    warnings.extend(f"{count} 个规格：{reason}" for reason, count in counts.items())
    if needs_refresh:
        warnings.append("本地商品目录超过 12 小时未刷新或尚无商品数据；请先运行“商品与活动采集”，再回到活动页重新采集")
    return {
        **payload, "candidates": candidates, "unresolved_candidates": unresolved,
        "source_candidate_count": len(source_candidates), "recovered_sku_count": recovered,
        "product_catalog": catalog, "needs_product_refresh": needs_refresh,
        "warnings": warnings[:30],
    }


def ingest_evidence(body, connect):
    mall = _identifier(body.get("mall_id"), "店铺ID")
    campaign = _identifier(body.get("campaign_id"), "活动ID")
    captured = _text(body.get("captured") or now())
    try:
        parsed = datetime.fromisoformat(captured.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            raise ValueError()
        captured = parsed.astimezone(timezone.utc).isoformat()
    except ValueError:
        raise ValueError("证据时间必须包含时区")
    source_candidates = _candidate_rows(body)
    with connect() as db:
        candidates, unresolved, recovered = _resolve_missing_skus(db, mall, source_candidates)
        product_catalog = _product_catalog_state(db, mall)
    supplied_warnings = [_text(x)[:300] for x in body.get("warnings", []) if _text(x)][:30]
    resolution_warnings = []
    if recovered:
        resolution_warnings.append(f"{recovered} 个页面隐藏的 SKU/SKC，已用同店铺 SPU（及可见 SKC）+精确日常价/货号唯一补全")
    if unresolved:
        counts = {}
        for row in unresolved:
            reason = row["resolutionError"]
            counts[reason] = counts.get(reason, 0) + 1
        resolution_warnings.extend(f"{count} 个规格：{reason}" for reason, count in counts.items())
    needs_product_refresh = bool(unresolved) and (
        not product_catalog["captured"] or product_catalog["age_hours"] is None or product_catalog["age_hours"] > 12
    )
    if needs_product_refresh:
        resolution_warnings.append("本地商品目录超过 12 小时未刷新或尚无商品数据；请先运行“商品与活动采集”，再回到活动页重新采集")
    payload = {
        "collector_version": _text(body.get("collector_version"))[:30],
        "scan_stats": body.get("scan_stats") if isinstance(body.get("scan_stats"), dict) else {},
        "campaign_name": _text(body.get("campaign_name"))[:240],
        "shop_name": _text(body.get("shop_name"))[:200],
        "candidates": candidates,
        "unresolved_candidates": unresolved,
        "source_candidate_count": len(source_candidates),
        "recovered_sku_count": recovered,
        "product_catalog": product_catalog,
        "needs_product_refresh": needs_product_refresh,
        "capture_quality": "hierarchical_dom_resolved" if recovered else _text(body.get("capture_quality") or "structured"),
        "capture_warnings": supplied_warnings,
        "warnings": (supplied_warnings + resolution_warnings)[:30],
    }
    canonical = json.dumps([mall, campaign, captured, payload], ensure_ascii=False, sort_keys=True)
    snapshot_id = hashlib.sha256(canonical.encode()).hexdigest()
    with connect() as db:
        db.execute("INSERT OR IGNORE INTO activity_evidence_snapshots VALUES(?,?,?,?,?,?)", (
            snapshot_id, captured, mall, campaign, _text(body.get("source_url"))[:2000],
            json.dumps(payload, ensure_ascii=False),
        ))
    return {"id": snapshot_id, "mall_id": mall, "campaign_id": campaign, "rows": len(candidates), "scanned": len(source_candidates), "recovered": recovered, "unresolved": len(unresolved), "needs_product_refresh": needs_product_refresh, "product_catalog": product_catalog, "captured": captured}


def _collector_products(db, mall):
    result = {}
    duplicates = set()
    for row in collector.current_records(db, "products", mall):
        value = json.loads(row["payload"])
        sku = _text(value.get("skuId"))
        if not sku:
            continue
        item = {**value, "_captured": row["captured"]}
        if sku in result and (result[sku].get("spuId"), result[sku].get("skcId")) != (item.get("spuId"), item.get("skcId")):
            duplicates.add(sku)
        result[sku] = item
    return result, duplicates


def _inventory(candidate, config):
    rule = config["inventory_rule"]
    if rule == "fixed":
        return config["inventory_fixed"], "fixed"
    field = "salesStock" if rule == "sales_stock" else "referenceStock"
    value = candidate.get(field)
    return (value, field) if isinstance(value, int) and value >= 0 else (None, field)


def _stale(timestamp, hours):
    try:
        value = datetime.fromisoformat(_text(timestamp).replace("Z", "+00:00")).astimezone(timezone.utc)
        return (datetime.now(timezone.utc) - value).total_seconds() > float(hours) * 3600
    except (ValueError, TypeError):
        return True


def _make_item(candidate, product, duplicate, config, evidence_captured=None):
    displayed_spec = normalize_variant(candidate.get("specification"))
    spec,mapping,size_error = match_size_rule(candidate.get("specification"),config["size_prices"])
    reasons = [size_error] if size_error else []
    identity_ok = bool(product) and not duplicate
    old_price = _money(product.get("declaredPrice"), "原申报价", True) if product else None
    if duplicate:
        reasons.append("同一店铺内 SKU 映射到多个 SPU/SKC")
    if _stale(evidence_captured, config["evidence_max_age_hours"]):
        reasons.append("活动候选证据已过期，请重新只读采集")
    if not product:
        reasons.append("商品采集记录中找不到该 SKU")
    else:
        if _stale(product.get("_captured"), config["evidence_max_age_hours"]):
            reasons.append("商品价格证据已过期，请重新采集在售商品")
        if _text(product.get("spuId")) != candidate["spuId"]:
            reasons.append("SPU 与商品记录不一致")
            identity_ok = False
        if _text(product.get("skcId")) != candidate["skcId"]:
            reasons.append("SKC 与商品记录不一致")
            identity_ok = False
        code_a, code_b = _text(candidate.get("skuCode")), _text(product.get("skuCode"))
        if code_a and code_b and code_a != code_b:
            reasons.append("SKU货号不一致")
            identity_ok = False
    if not displayed_spec:
        reasons.append("规格无法识别")
    elif not mapping:
        reasons.append(f"规格 {displayed_spec} 尚未配置本批底价与目标日常价")
    match_field = config.get("price_match", {}).get("field", "dailyPrice")
    match_value = old_price if match_field == "declaredPrice" else _money(candidate.get(match_field), "活动价格匹配值", True)
    match_min = _money(mapping.get("match_min"), "报名价格区间最低价", True) if mapping else None
    match_max = _money(mapping.get("match_max"), "报名价格区间最高价", True) if mapping else None
    if mapping and match_min is not None and match_max is not None:
        if match_value is None:
            reasons.append("活动价格匹配值缺失，无法判断是否落在报名区间")
        elif match_value < match_min or match_value > match_max:
            reasons.append(f"当前匹配价 {amount_string(match_value)} 不在 {amount_string(match_min)}～{amount_string(match_max)} 的可报名区间")
    if not candidate.get("eligible"):
        reasons.append(candidate.get("blockReason") or "活动页未确认可报名")
    if candidate.get("adjustable") is False:
        reasons.append("平台已判定无法调到活动目标日常价")
    elif candidate.get("adjustable") is None and config["require_adjustable_confirmation"]:
        reasons.append("尚未取得平台可调价确认")
    inventory, inventory_source = _inventory(candidate, config)
    if inventory is None:
        reasons.append("活动库存未取得，禁止擅自填满")

    floor = _money(mapping["floor"], "底价") if mapping else None
    target = _money(mapping["target_daily"], "目标日常价") if mapping else None
    seventy_five = (target * DISCOUNT).quantize(MONEY, rounding=ROUND_HALF_UP) if target else None
    planned_activity = seventy_five
    if floor is not None and planned_activity < floor:
        reasons.append("活动预留价打75折后低于日常底价，请检查两档价格")
    item_key = "|".join((candidate["spuId"], candidate["skcId"], candidate["skuId"]))
    floor_only = candidate.get("adjustable") is False and identity_ok and bool(mapping)
    if reasons:
        state = "ineligible"
        action = "direct_floor_only" if floor_only else "blocked"
    else:
        state = "pending_price_adjustment"
        action = "adjust_then_enroll"
    return {
        "item_key": item_key, "spuId": candidate["spuId"], "skcId": candidate["skcId"],
        "skuId": candidate["skuId"], "skuCode": candidate.get("skuCode") or (product or {}).get("skuCode") or "",
        "specification": spec or displayed_spec or candidate.get("specification") or "", "oldPrice": amount_string(old_price) if old_price is not None else None,
        "sourceDailyPrice": candidate.get("dailyPrice"), "referenceActivityPrice": candidate.get("referenceActivityPrice"),
        "priceMatchField": match_field, "priceMatchValue": amount_string(match_value) if match_value is not None else None,
        "priceMatchMin": amount_string(match_min) if match_min is not None else None,
        "priceMatchMax": amount_string(match_max) if match_max is not None else None,
        "floorPrice": amount_string(floor) if floor is not None else None,
        "targetDailyPrice": amount_string(target) if target is not None else None,
        "seventyFivePercent": amount_string(seventy_five) if seventy_five is not None else None,
        "plannedActivityPrice": amount_string(planned_activity) if planned_activity is not None else None,
        "floorMarginAt75": amount_string(seventy_five - floor) if floor is not None else None,
        "inventory": inventory, "inventorySource": inventory_source,
        "candidateStatus": candidate.get("candidateStatus"), "adjustable": candidate.get("adjustable"),
        "identityResolution": candidate.get("identityResolution") or "activity_page_sku_id",
        "eligible": not reasons, "priceActionAllowed": action in ("adjust_then_enroll", "direct_floor_only"),
        "action": action, "blockedReasons": reasons,
        "sourceCaptured": (product or {}).get("_captured"), "state": state,
        "stateHistory": ["pending_collection"] + (["matched"] if identity_ok else []) + ([state] if state not in ("pending_collection", "matched") else []),
    }


def enrollment_precheck(candidate, product, duplicate, config, captured):
    """Screen current enrollment prices, never a hypothetical repricing plan."""
    if config.get('two_price_mode'):
        return two_price_precheck(candidate, product, duplicate, config, captured)
    legacy = _make_item(candidate, product, duplicate, config, captured)
    waiting, blocked = [], []
    dimension = normalize_variant(candidate.get('specification'))
    _,rule,_ = match_size_rule(candidate.get('specification'),config['size_prices'])
    for reason in legacy['blockedReasons']:
        if any(text in reason for text in ('可调价确认', '无法调到', '活动预留价打75折')):
            continue
        if '尚未配置' in reason or '过期' in reason or '未取得' in reason or '缺失' in reason or '找不到' in reason:
            waiting.append(reason)
        else:
            blocked.append(reason)
    # The activity reference is observed from this campaign; never assume every
    # campaign is 75% or that a future adjustment has already taken effect.
    price = _money(candidate.get('referenceActivityPrice'), '活动参考价', True)
    if price is None:
        waiting.append('缺少平台活动参考价，请重新采集')
    elif rule and price < _money(rule['floor'], '日常底价'):
        blocked.append(f"平台活动参考价 {amount_string(price)} 低于底价 {rule['floor']}")
    if rule is None and not any('尚未配置' in reason for reason in waiting):
        waiting.append(f'{"尺寸" if normalize_dimension(dimension) else "规格"} {dimension} 尚未配置报名规则')
    status = 'blocked' if blocked else 'pending' if waiting else 'ready'
    return {'eligible': status == 'ready', 'status': status,
            'blockedReasons': blocked, 'pendingReasons': waiting,
            'plannedActivityPrice': amount_string(price) if price is not None else None}


def two_price_precheck(candidate, product, duplicate, config, captured):
    """Classify a SKU using only the bare price and its 75%-campaign list price."""
    dimension = normalize_variant(candidate.get('specification'))
    matched_spec, rule, size_error = match_size_rule(candidate.get('specification'), config['size_prices'])
    preset_units = {_dimension_unit(spec) for spec in config['size_prices']}
    preset_units.discard('')
    category_matched = bool(rule) or bool(_dimension_unit(dimension) in preset_units)
    waiting, blocked, notices = [], [], []
    if size_error:
        blocked.append(size_error)
    if not dimension:
        blocked.append('规格无法识别')
    elif rule is None and not size_error:
        waiting.append(f'{"尺寸" if normalize_dimension(dimension) else "规格"} {dimension} 不属于当前{config.get("category", "类目")}预设')
    if duplicate:
        blocked.append('同一店铺内 SKU 映射到多个 SPU/SKC')
    if not product:
        if candidate.get('identityResolution') == 'activity_page_sku_id':
            notices.append('SKU 由当前活动页直接识别，商品目录仅未参与复核')
        else:
            waiting.append('商品采集记录中找不到该 SKU')
    else:
        if _stale(product.get('_captured'), config['evidence_max_age_hours']):
            # The current campaign page is the authoritative source for the
            # visible daily/reference prices.  An older catalog snapshot may
            # still cross-check IDs, but must not turn every current candidate
            # into "资料不足".
            notices.append('商品目录快照较旧；本次核价采用当前活动页价格')
        if _text(product.get('spuId')) != candidate['spuId']:
            blocked.append('SPU 与商品记录不一致')
        if _text(product.get('skcId')) != candidate['skcId']:
            blocked.append('SKC 与商品记录不一致')
        code_a, code_b = _text(candidate.get('skuCode')), _text(product.get('skuCode'))
        if code_a and code_b and code_a != code_b:
            blocked.append('SKU货号不一致')
    if _stale(captured, config['evidence_max_age_hours']):
        waiting.append('活动候选证据已过期，请重新只读采集')
    if not candidate.get('eligible'):
        blocked.append(candidate.get('blockReason') or '活动页未确认可报名')

    daily = _money(candidate.get('dailyPrice'), '活动页日常价', True)
    reference = _money(candidate.get('referenceActivityPrice'), '平台活动参考价', True)
    floor = _money(rule['floor'], '裸跑价') if rule else None
    target = _money(rule['target_daily'], '活动前标价') if rule else None
    rate = _money(config.get('discount_rate', '0.75'), '活动折扣')
    expected = (target * rate).quantize(MONEY, rounding=ROUND_HALF_UP) if target else None
    tolerance = int(config['price_tolerance_cents'])
    current_matches_target = daily is not None and target is not None and abs(cents(daily)-cents(target)) <= tolerance
    current_matches_floor = daily is not None and floor is not None and abs(cents(daily)-cents(floor)) <= tolerance
    current_price_tier = 'activity' if current_matches_target else 'bare' if current_matches_floor else 'other' if daily is not None and rule else 'unknown'
    if daily is None:
        waiting.append('缺少活动页日常价，请重新采集')
    # Only the activity-list tier can be enrolled.  The bare tier is also an
    # intentional, already-adjusted price; it must not be called "未调价".
    if current_matches_target:
        if reference is None:
            waiting.append('缺少平台活动参考价，请重新采集')
        elif abs(cents(reference) - cents(floor)) > tolerance:
            blocked.append(
                f'已调价，但平台活动参考价 {amount_string(reference)} 不在裸跑价 '
                f'{amount_string(floor)} 上下浮动 2 元的可报名区间'
            )

    if blocked:
        price_state = 'blocked'
    elif waiting:
        price_state = 'pending'
    elif current_matches_target:
        price_state = 'ready'
    elif current_matches_floor:
        price_state = 'bare'
    else:
        price_state = 'needs_adjustment'
    status = price_state
    labels = {'ready':'活动价已就位，可报名','bare':'裸跑价已就位，报名需切活动价','needs_adjustment':'未按预设调价','blocked':'不可报名','pending':'资料不足'}
    return {
        'eligible': status == 'ready', 'status': status, 'priceState': price_state,
        'priceStateLabel': labels[price_state], 'category': config.get('category', '未分类'),
        'categoryMatched': category_matched,
        'matchedSpec': matched_spec if rule else None,
        'blockedReasons': blocked, 'pendingReasons': waiting, 'notices': notices,
        'barePrice': amount_string(floor) if floor is not None else None,
        'targetDailyPrice': amount_string(target) if target is not None else None,
        'expectedActivityPrice': amount_string(expected) if expected is not None else None,
        'currentDailyPrice': amount_string(daily) if daily is not None else None,
        'currentPriceTier': current_price_tier,
        'alreadyAdjusted': current_matches_target or current_matches_floor,
        'plannedActivityPrice': amount_string(reference) if reference is not None else None,
        'currentMatchesBarePrice': current_matches_floor,
        'adjustmentNeeded': status in ('bare', 'needs_adjustment'),
    }


def create_plan(body, connect):
    mall = _identifier(body.get("mall_id"), "店铺ID")
    campaign_requested = _identifier(body.get("campaign_id"), "活动ID", required=False)
    config = config_from(body.get("config"))
    with connect() as db:
        if campaign_requested:
            snapshot = db.execute("SELECT * FROM activity_evidence_snapshots WHERE mall_id=? AND campaign_id=? ORDER BY captured DESC LIMIT 1", (mall, campaign_requested)).fetchone()
        else:
            snapshot = db.execute("SELECT * FROM activity_evidence_snapshots WHERE mall_id=? ORDER BY captured DESC LIMIT 1", (mall,)).fetchone()
        if not snapshot:
            raise ValueError("当前店铺还没有活动候选证据，请先在目标活动报名页运行只读采集")
        evidence = resolve_evidence(db, mall, json.loads(snapshot["payload"]))
        products, duplicates = _collector_products(db, mall)
        items = [_make_item(candidate, products.get(candidate["skuId"]), candidate["skuId"] in duplicates, config, snapshot["captured"]) for candidate in evidence["candidates"]]
        job_id = uuid.uuid4().hex
        created = now()
        campaign = snapshot["campaign_id"]
        name = _text(body.get("name") or evidence.get("campaign_name") or f"活动 {campaign}")[:240]
        status = "planned" if items else "pending_collection"
        db.execute("INSERT INTO activity_jobs VALUES(?,?,?,?,?,?,?,?,?)", (
            job_id, created, created, mall, campaign, name, status,
            json.dumps(config, ensure_ascii=False), snapshot["id"],
        ))
        for item in items:
            db.execute("INSERT INTO activity_job_items VALUES(?,?,?,?,?,?,?)", (
                job_id, item["item_key"], item["state"], 0, 0,
                json.dumps(item, ensure_ascii=False), created,
            ))
            for checkpoint in item["stateHistory"]:
                _audit(db, job_id, item["item_key"], "state", checkpoint, {"blocked_reasons": item["blockedReasons"] if checkpoint == "ineligible" else []})
        _audit(db, job_id, None, "plan", "created", {"snapshot_id": snapshot["id"], "items": len(items), "eligible": sum(x["eligible"] for x in items)})
    return job_snapshot(connect, job_id)


def save_settings(body, connect):
    config = config_from(body.get("config") if isinstance(body, dict) else None)
    name = _text(body.get("preset_name", ""))
    mall = _identifier(body.get("mall_id"), "店铺ID", required=False)
    if len(name)>60:raise ValueError("预设名称最多 60 个字符")
    default_id = "default:" + mall if mall else "default"
    active_id = "active_preset:" + mall if mall else "active_preset"
    preset_prefix = "preset:" + mall + ":" if mall else "preset:"
    with connect() as db:
        if name:
            previous=db.execute("SELECT payload FROM activity_settings WHERE id=?",(default_id,)).fetchone()
            if not previous and mall:previous=db.execute("SELECT payload FROM activity_settings WHERE id='default'").fetchone()
            count=db.execute("SELECT COUNT(*) FROM activity_settings WHERE id LIKE ?",(preset_prefix+'%',)).fetchone()[0]
            if previous and count==0:
                db.execute("INSERT OR IGNORE INTO activity_settings VALUES(?,?,?)", (preset_prefix+"原有设置",now(),previous["payload"]))
            db.execute("INSERT OR REPLACE INTO activity_settings VALUES(?,?,?)", (preset_prefix+name,now(),json.dumps(config,ensure_ascii=False)))
            db.execute("INSERT OR REPLACE INTO activity_settings VALUES(?,?,?)", (active_id,now(),json.dumps(name,ensure_ascii=False)))
        else:
            active=db.execute("SELECT payload FROM activity_settings WHERE id=?",(active_id,)).fetchone()
            if active:
                name=json.loads(active["payload"])
                db.execute("INSERT OR REPLACE INTO activity_settings VALUES(?,?,?)", (preset_prefix+name,now(),json.dumps(config,ensure_ascii=False)))
        db.execute("INSERT OR REPLACE INTO activity_settings VALUES(?,?,?)", (
            default_id, now(), json.dumps(config, ensure_ascii=False),
        ))
    return {"ok": True, "activity_settings": config, "active_preset":name, "mall_id":mall}


def _audit(db, job_id, item_key, stage, event, payload):
    db.execute("INSERT INTO activity_audit VALUES(?,?,?,?,?,?,?)", (
        uuid.uuid4().hex, job_id, item_key, stage, event, now(),
        json.dumps(payload, ensure_ascii=False),
    ))


def update_selection(body, connect):
    job_id = _identifier(body.get("job_id"), "作业ID")
    selected = body.get("selected")
    if not isinstance(selected, list) or len(selected) > 10000:
        raise ValueError("勾选列表格式无效")
    wanted = {_text(x) for x in selected}
    with connect() as db:
        rows = list(db.execute("SELECT item_key,payload FROM activity_job_items WHERE job_id=?", (job_id,)))
        if not rows:
            raise ValueError("作业不存在或没有明细")
        valid = {row["item_key"] for row in rows}
        if wanted - valid:
            raise ValueError("勾选列表包含不属于本作业的 SKU")
        for row in rows:
            payload = json.loads(row["payload"])
            choose = row["item_key"] in wanted
            if choose and not payload.get("priceActionAllowed"):
                raise ValueError(f"没有安全价格动作的 SKU 不能勾选：{payload.get('skuId')}")
            db.execute("UPDATE activity_job_items SET selected=?,updated=? WHERE job_id=? AND item_key=?", (int(choose), now(), job_id, row["item_key"]))
        _audit(db, job_id, None, "selection", "updated", {"selected": sorted(wanted)})
    return job_snapshot(connect, job_id)


def prepare_manifest(body, connect):
    job_id = _identifier(body.get("job_id"), "作业ID")
    step = _text(body.get("step"))
    if step not in ("price", "enroll"):
        raise ValueError("执行步骤只能是调价或报名")
    expected_phrase = "确认执行调价" if step == "price" else "确认执行报名"
    if body.get("confirmation") != expected_phrase:
        raise ValueError(f"请输入“{expected_phrase}”进行独立确认")
    dry_run = body.get("dry_run", True)
    if not isinstance(dry_run, bool):
        raise ValueError("模拟运行标记无效")
    with connect() as db:
        job = db.execute("SELECT * FROM activity_jobs WHERE id=?", (job_id,)).fetchone()
        if not job:
            raise ValueError("作业不存在")
        config = json.loads(job["config"])
        if not dry_run and not config.get("real_execution_enabled"):
            raise ValueError("真实执行适配器未启用；本轮只允许生成模拟执行清单")
        rows = list(db.execute("SELECT * FROM activity_job_items WHERE job_id=? AND selected=1 ORDER BY item_key", (job_id,)))
        if not rows:
            raise ValueError("请先勾选至少一个未阻断 SKU")
        items = []
        for row in rows:
            item = json.loads(row["payload"])
            if step == "price" and not item.get("priceActionAllowed"):
                raise ValueError(f"SKU {item.get('skuId')} 没有可安全执行的价格动作")
            if step == "enroll" and not item.get("eligible"):
                raise ValueError(f"SKU {item.get('skuId')} 不可报名")
            if step == "enroll" and row["state"] not in ("price_effective", "eligible"):
                raise ValueError(f"SKU {item.get('skuId')} 尚未验证调价生效，不能生成报名执行清单")
            items.append({
                "item_key": item["item_key"], "spuId": item["spuId"], "skcId": item["skcId"],
                "skuId": item["skuId"], "skuCode": item["skuCode"], "specification": item["specification"],
                "targetPrice": (item["floorPrice"] if item["action"] == "direct_floor_only" else item["targetDailyPrice"]) if step == "price" else item["plannedActivityPrice"],
                "floorPrice": item["floorPrice"], "inventory": item["inventory"] if step == "enroll" else None,
            })
        manifest_id = uuid.uuid4().hex
        manifest = {"id": manifest_id, "job_id": job_id, "step": step, "campaign_id": job["campaign_id"], "mall_id": job["mall_id"], "dry_run": dry_run, "items": items}
        db.execute("INSERT INTO activity_execution_manifests VALUES(?,?,?,?,?,?,?)", (
            manifest_id, job_id, step, now(), int(dry_run), "prepared",
            json.dumps(manifest, ensure_ascii=False),
        ))
        _audit(db, job_id, None, step, "manifest_prepared", {"manifest_id": manifest_id, "dry_run": dry_run, "items": len(items)})
    return manifest


def record_transition(body, connect):
    """Record a verified platform receipt; never infer success from submission."""
    job_id = _identifier(body.get("job_id"), "作业ID")
    item_key = _text(body.get("item_key"))
    state = _text(body.get("state"))
    if state not in STATES:
        raise ValueError("作业状态无效")
    allowed = {
        "pending_price_adjustment": {"price_submitted", "failed"},
        "price_submitted": {"price_effective", "failed"},
        "price_effective": {"eligible", "failed"},
        "eligible": {"enrollment_submitted", "failed"},
        "enrollment_submitted": {"platform_confirmed", "failed"},
        "failed": {"pending_price_adjustment", "price_submitted", "enrollment_submitted"},
    }
    with connect() as db:
        row = db.execute("SELECT * FROM activity_job_items WHERE job_id=? AND item_key=?", (job_id, item_key)).fetchone()
        if not row:
            raise ValueError("作业 SKU 不存在")
        if state not in allowed.get(row["state"], set()):
            raise ValueError(f"不允许从 {row['state']} 跳转到 {state}")
        receipt = body.get("platform_response")
        if state in ("price_effective", "platform_confirmed") and not isinstance(receipt, dict):
            raise ValueError("平台确认状态必须附带结构化平台回执")
        payload = json.loads(row["payload"])
        if state in ("price_effective", "platform_confirmed"):
            for key in ("spuId", "skcId", "skuId"):
                if _text(receipt.get(key)) != payload[key]:
                    raise ValueError(f"平台回执 {key} 与作业不一致")
        if state == "price_effective":
            observed = _money(receipt.get("observedPrice"), "平台生效价")
            target = _money(payload["targetDailyPrice"], "目标日常价")
            tolerance = int(json.loads(db.execute("SELECT config FROM activity_jobs WHERE id=?", (job_id,)).fetchone()["config"])["price_tolerance_cents"])
            if abs(cents(observed) - cents(target)) > tolerance:
                raise ValueError(f"平台生效价 {amount_string(observed)} 与目标价 {amount_string(target)} 超出 {tolerance} 分容差")
        if state == "platform_confirmed":
            actual = _money(receipt.get("activityPrice"), "平台活动价")
            floor = _money(payload["floorPrice"], "底价")
            if actual < floor:
                raise ValueError("平台活动价低于底价，确认被阻止")
        payload["state"] = state
        payload["lastPlatformResponse"] = receipt
        payload["lastError"] = _text(body.get("error"))[:500]
        retries = row["retries"] + (1 if state == "failed" else 0)
        db.execute("UPDATE activity_job_items SET state=?,retries=?,payload=?,updated=? WHERE job_id=? AND item_key=?", (
            state, retries, json.dumps(payload, ensure_ascii=False), now(), job_id, item_key,
        ))
        _audit(db, job_id, item_key, "platform", state, {"response": receipt, "error": payload["lastError"], "retries": retries})
    return job_snapshot(connect, job_id)


def job_snapshot(connect, job_id="", mall_id=""):
    with connect() as db:
        if job_id:
            jobs = list(db.execute("SELECT * FROM activity_jobs WHERE id=?", (job_id,)))
        elif mall_id:
            jobs = list(db.execute("SELECT * FROM activity_jobs WHERE mall_id=? ORDER BY created DESC LIMIT 20", (mall_id,)))
        else:
            jobs = list(db.execute("SELECT * FROM activity_jobs ORDER BY created DESC LIMIT 20"))
        output = []
        for job in jobs:
            items = []
            for row in db.execute("SELECT * FROM activity_job_items WHERE job_id=? ORDER BY item_key", (job["id"],)):
                items.append({**json.loads(row["payload"]), "state": row["state"], "selected": bool(row["selected"]), "retries": row["retries"], "updated": row["updated"]})
            audit = []
            for row in db.execute("SELECT * FROM activity_audit WHERE job_id=? ORDER BY created DESC LIMIT 100", (job["id"],)):
                audit.append({**dict(row), "payload": json.loads(row["payload"])})
            manifests = []
            for row in db.execute("SELECT * FROM activity_execution_manifests WHERE job_id=? ORDER BY created DESC LIMIT 20", (job["id"],)):
                manifests.append({**dict(row), "dry_run": bool(row["dry_run"]), "payload": json.loads(row["payload"])})
            output.append({**dict(job), "config": json.loads(job["config"]), "items": items, "audit": audit, "manifests": manifests})
        evidence = [{**dict(row), "payload": json.loads(row["payload"])} for row in db.execute(
            "SELECT * FROM activity_evidence_snapshots" + (" WHERE mall_id=?" if mall_id else "") + " ORDER BY captured DESC LIMIT 30", (mall_id,) if mall_id else ())]
        shops = [dict(row) for row in db.execute("SELECT * FROM collector_shops ORDER BY name")]
        default_id = "default:" + mall_id if mall_id else "default"
        active_id = "active_preset:" + mall_id if mall_id else "active_preset"
        preset_prefix = "preset:" + mall_id + ":" if mall_id else "preset:"
        saved = db.execute("SELECT payload FROM activity_settings WHERE id=?",(default_id,)).fetchone()
        if not saved and mall_id:saved=db.execute("SELECT payload FROM activity_settings WHERE id='default'").fetchone()
        activity_settings = json.loads(saved["payload"]) if saved else DEFAULT_CONFIG
        preset_rows=list(db.execute("SELECT * FROM activity_settings WHERE id LIKE ? ORDER BY id",(preset_prefix+'%',)))
        if mall_id and not preset_rows:
            preset_prefix="preset:"
            preset_rows=list(db.execute("SELECT * FROM activity_settings WHERE id LIKE 'preset:%' AND id NOT LIKE 'preset:%:%' ORDER BY id"))
        presets=[{"name":row["id"][len(preset_prefix):],"updated":row["updated"],"config":json.loads(row["payload"])} for row in preset_rows]
        active_row=db.execute("SELECT payload FROM activity_settings WHERE id=?",(active_id,)).fetchone()
        if not active_row and mall_id:active_row=db.execute("SELECT payload FROM activity_settings WHERE id='active_preset'").fetchone()
        active_preset=json.loads(active_row["payload"]) if active_row else ""
        checked_config = config_from(activity_settings)
        products_by_mall = {}
        for snapshot in evidence:
            mall = snapshot['mall_id']
            if mall not in products_by_mall:
                products_by_mall[mall] = _collector_products(db, mall)
            products, duplicates = products_by_mall[mall]
            snapshot['payload'] = resolve_evidence(db, mall, snapshot['payload'])
            snapshot['payload']['evaluated_candidates'] = [
                {**candidate, 'precheck': enrollment_precheck(candidate, products.get(candidate['skuId']),
                    candidate['skuId'] in duplicates, checked_config, snapshot['captured'])}
                for candidate in snapshot['payload'].get('candidates', [])
            ]
    return {"jobs": output, "job": output[0] if job_id and output else None, "evidence": evidence, "shops": shops, "default_config": DEFAULT_CONFIG, "activity_settings": activity_settings, "price_presets":presets,"active_preset":active_preset,"real_execution_enabled": False}
