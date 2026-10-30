"""Read-only local feature views used by the browser extension and workbench.

All calculations use records already stored in workbench.sqlite3.  No remote
account service or merchant write endpoint is involved.
"""
from __future__ import annotations

import json
import re
from datetime import date, datetime, timezone
from activity_jobs import match_size_rule
import collector
from product_operations import sale_state, snapshot_scope


def _payloads(db, dataset: str, mall_id: str):
    rows = [{**json.loads(row["payload"]), "_captured": row["captured"]}
            for row in collector.current_records(db, dataset, mall_id)]
    if dataset == "products":
        scope = snapshot_scope(db, dataset, mall_id)
        rows = [{**row, "lifecycleStatus": "在售", "onSale": True}
                for row in rows if sale_state(row, scope) == "on_sale"]
    return rows


def _money(value):
    if isinstance(value, bool) or value in (None, ""):
        return None
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed >= 0 else None


def _active(value):
    text = str(value or "").strip().lower()
    return text in {"在售", "在线", "已发布到站点", "on_sale", "active", "listed"}


def _date(value):
    text = str(value or "").strip()
    if not text:
        return ""
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00")).date().isoformat()
    except ValueError:
        matched = re.search(r"\d{4}-\d{2}-\d{2}", text)
        return matched.group(0) if matched else ""


def catalog(connect, mall_id: str):
    mall_id = str(mall_id or "").strip()
    if not re.fullmatch(r"\d{1,40}", mall_id):
        raise ValueError("当前浏览器店铺 ID 无效")
    with connect() as db:
        products = _payloads(db, "products", mall_id)
        activities = _payloads(db, "activities", mall_id)

    activity_by_sku = {}
    for row in activities:
        sku_id = str(row.get("skuId") or "").strip()
        if not sku_id:
            continue
        activity_by_sku.setdefault(sku_id, []).append(row)

    grouped = {}
    for row in products:
        spu_id = str(row.get("spuId") or "").strip()
        skc_id = str(row.get("skcId") or "").strip()
        sku_id = str(row.get("skuId") or "").strip()
        if not spu_id or not skc_id:
            continue
        key = (spu_id, skc_id)
        item = grouped.setdefault(
            key,
            {
                "spuId": spu_id,
                "skcId": skc_id,
                "isActive": _active(row.get("lifecycleStatus")),
                "images": [],
                "skus": [],
                "capturedAt": row.get("_captured"),
            },
        )
        image = str(row.get("imageUrl") or "").strip()
        if image.startswith("https://") and image not in item["images"]:
            item["images"].append(image)
        related = activity_by_sku.get(sku_id, [])
        daily_prices = [_money(activity.get("dailyPrice")) for activity in related]
        activity_prices = [_money(activity.get("activityPrice")) for activity in related]
        daily_prices = [value for value in daily_prices if value is not None]
        activity_prices = [value for value in activity_prices if value is not None]
        declared = _money(row.get("declaredPrice"))
        actual = min(activity_prices or daily_prices) if (activity_prices or daily_prices) else None
        item["skus"].append(
            {
                "skuId": sku_id,
                "skuCode": str(row.get("skuCode") or ""),
                "declaredPrice": declared,
                "actualSalePrice": actual,
                "specification": str(row.get("specification") or ""),
            }
        )

    return {
        "success": True,
        "localOnly": True,
        "mallId": mall_id,
        "products": list(grouped.values()),
        "productCount": len(grouped),
    }


def _order_coverage(receipts, start: str, end: str):
    eligible = [
        row
        for row in receipts
        if row.get("dataset") == "orders"
        and row.get("start_date")
        and row.get("end_date")
        and row["start_date"] <= start
        and row["end_date"] >= end
    ]
    if not eligible:
        return {"complete": False, "message": "订单数据没有覆盖所选日期，不能安全判断零销量"}
    newest = max(eligible, key=lambda row: str(row.get("observed_at") or ""))
    return {"complete": True, "receipt": newest, "message": "订单范围已由本地采集回执覆盖"}


def zero_sales(connect, mall_id: str, first_start: str, first_end: str, order_start: str, order_end: str):
    for label, value in (
        ("首次入站开始", first_start),
        ("首次入站结束", first_end),
        ("订单开始", order_start),
        ("订单结束", order_end),
    ):
        try:
            date.fromisoformat(value)
        except (TypeError, ValueError):
            raise ValueError(f"{label}日期无效")
    if first_start > first_end or order_start > order_end:
        raise ValueError("开始日期不能晚于结束日期")

    mall_id = str(mall_id or "").strip()
    with connect() as db:
        products = _payloads(db, "products", mall_id)
        orders = _payloads(db, "orders", mall_id)
        receipts = [json.loads(row["payload"]) for row in db.execute("SELECT payload FROM collector_receipts ORDER BY observed_at DESC")]

    coverage = _order_coverage([row for row in receipts if str(row.get("mall_id")) == mall_id], order_start, order_end)
    if not coverage["complete"]:
        return {"success": False, "safe": False, "localOnly": True, "coverage": coverage, "items": []}

    sold_skcs = set()
    for row in orders:
        day = _date(row.get("parentConfirmTimeStr"))
        if day and order_start <= day <= order_end:
            skc_id = str(row.get("productSkcId") or "").strip()
            if skc_id:
                sold_skcs.add(skc_id)

    grouped = {}
    for row in products:
        spu_id = str(row.get("spuId") or "").strip()
        skc_id = str(row.get("skcId") or "").strip()
        if not spu_id or not skc_id or not _active(row.get("lifecycleStatus")):
            continue
        captured_day = _date(row.get("_captured"))
        # Current collector does not expose Temu's first-joined field.  Use the
        # first local observation label explicitly rather than presenting it as
        # a platform date.
        if captured_day and not (first_start <= captured_day <= first_end):
            continue
        item = grouped.setdefault(
            skc_id,
            {
                "spuId": spu_id,
                "skcId": skc_id,
                "firstSeenLocal": captured_day,
                "imageUrl": str(row.get("imageUrl") or ""),
                "skuIds": [],
                "reason": "所选订单范围内未找到该 SKC 的成交 SKU",
            },
        )
        sku_id = str(row.get("skuId") or "").strip()
        if sku_id and sku_id not in item["skuIds"]:
            item["skuIds"].append(sku_id)

    items = []
    for skc_id, item in grouped.items():
        if skc_id in sold_skcs:
            continue
        items.append({**item, "skuCount": len(item["skuIds"])})
    items.sort(key=lambda row: (row.get("firstSeenLocal") or "", row["spuId"], row["skcId"]))
    return {
        "success": True,
        "safe": True,
        "localOnly": True,
        "coverage": coverage,
        "items": items,
        "candidateCount": len(items),
        "soldSkcCount": len(sold_skcs),
        "dateBasis": "本机首次保存日期；当前采集器尚未提供平台首次入站日期",
    }


def promotion_audit(connect, mall_id: str):
    catalog_data = catalog(connect, mall_id)
    with connect() as db:
        activities = _payloads(db, "activities", str(mall_id))
        active = db.execute("SELECT payload FROM activity_settings WHERE id=?", ("active_preset:" + str(mall_id),)).fetchone()
        preset_name = json.loads(active["payload"]) if active else ""
        preset = db.execute("SELECT payload FROM activity_settings WHERE id=?", ("preset:" + str(mall_id) + ":" + preset_name,)).fetchone() if preset_name else None
        preset_config = json.loads(preset["payload"]) if preset else {}
    price_rules = preset_config.get("size_prices", {}) if isinstance(preset_config, dict) else {}
    by_sku = {}
    for row in activities:
        by_sku.setdefault(str(row.get("skuId") or ""), []).append(row)

    issues, accelerator, safety = [], [], []
    for product in catalog_data["products"]:
        for sku in product["skus"]:
            sku_id = sku["skuId"]
            if not sku_id:
                issues.append({"spuId": product["spuId"], "skcId": product["skcId"], "issue": "缺少 SKU ID"})
                continue
            if sku["declaredPrice"] is None:
                issues.append({"spuId": product["spuId"], "skcId": product["skcId"], "skuId": sku_id, "issue": "缺少申报价"})
            _, matched_rule, rule_error = match_size_rule(sku.get("specification"), price_rules)
            floor = _money(matched_rule.get("floor")) if matched_rule else None
            if rule_error:
                issues.append({"spuId": product["spuId"], "skcId": product["skcId"], "skuId": sku_id, "issue": rule_error})
            activity_rows = by_sku.get(sku_id, [])
            prices = [_money(activity.get("activityPrice")) for activity in activity_rows]
            prices = [price for price in prices if price is not None]
            if prices:
                safe_prices = [price for price in prices if floor is not None and price >= floor]
                safety.append({
                    "spuId": product["spuId"], "skcId": product["skcId"], "skuId": sku_id,
                    "specification": sku.get("specification") or "", "floor": floor,
                    "lowestLocalActivityPrice": round(min(prices), 2),
                    "lowestSafeObservedPrice": round(min(safe_prices), 2) if safe_prices else None,
                    "unsafeActivityCount": len([price for price in prices if floor is not None and price < floor]),
                    "status": "已按当前本地价格预设核对" if floor is not None else "缺少匹配的本地价格底线，仅展示活动价，不判定安全",
                })
                if floor is not None and any(price < floor for price in prices):
                    issues.append({"spuId": product["spuId"], "skcId": product["skcId"], "skuId": sku_id, "issue": f"存在低于本地底线 {floor:.2f} 的活动价"})
            eligible = []
            for activity in activity_rows:
                daily = _money(activity.get("dailyPrice"))
                price = _money(activity.get("activityPrice"))
                discount = _money(activity.get("discountRate"))
                if discount is not None and discount > 1:
                    discount /= 100
                if discount is None and daily and price is not None:
                    discount = price / daily
                if price is not None and discount is not None and discount <= 0.85 and floor is not None and price + 0.01 >= floor:
                    eligible.append((price, discount, activity))
            if eligible:
                price, discount, activity = min(eligible, key=lambda value: value[0])
                accelerator.append(
                    {
                        "spuId": product["spuId"],
                        "skcId": product["skcId"],
                        "skuId": sku_id,
                        "activityName": str(activity.get("activityName") or ""),
                        "activityPrice": round(price, 2),
                        "discountRate": round(discount, 4),
                        "previewTargetPrice": round(price + 0.01, 2),
                        "status": "仅预览；尚未核对平台实时资格和价格底线",
                    }
                )

    return {
        "success": True,
        "localOnly": True,
        "readOnly": True,
        "mallId": str(mall_id),
        "productCount": catalog_data["productCount"],
        "pricePreset": preset_name,
        "pricePresetAvailable": bool(price_rules),
        "issues": issues,
        "activitySafetyPreview": safety,
        "acceleratorPreview": accelerator,
        "acceleratorCandidateCount": len(accelerator),
    }
