"""Current SPU operations view. No platform mutations or estimated boost prices."""
from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timezone
from urllib.parse import urlparse

import activity_jobs
import collector
import product_rules

SALE_LABELS = {"on_sale": "在售", "not_on_sale": "不在售", "unknown": "在售状态待确认"}
COLLECTION_INTERVAL_MINUTES = 120
# Snapshot validity is independent from the two-hour collection schedule.
FRESHNESS_WINDOW_MINUTES = 12 * 60
BOOST_LABELS = {"enabled": "加速中", "eligible": "待开启", "max_eligible": "Max 待开启",
                "disabled": "未开启", "unknown": "待确认"}
BOOST_SWITCH_LABELS = {"enabled": "已开启", "disabled": "未开启", "unknown": "待确认"}
ACTIVITY_LABELS = {"active": "活动中", "scheduled": "待生效", "exit_review": "退出审核中",
                   "ended": "已结束", "cancelled": "已退出", "unknown": "状态待确认"}


def _time(value):
    try:
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return datetime.fromtimestamp(value / (1000 if value > 100000000000 else 1), timezone.utc)
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return parsed if parsed.tzinfo else None
    except (ValueError, TypeError, OverflowError, OSError):
        return None


def freshness(captured, now=None):
    parsed = _time(captured)
    now = now or datetime.now(timezone.utc)
    minutes = max(0, (now - parsed).total_seconds() / 60) if parsed else None
    return {"captured": captured or "", "ageMinutes": round(minutes, 1) if minutes is not None else None,
            "stale": minutes is None or minutes > FRESHNESS_WINDOW_MINUTES}


def snapshot_scope(db, kind, mall):
    row = db.execute("SELECT * FROM collector_snapshots WHERE dataset=? AND mall_id=?", (kind, mall)).fetchone()
    if not row:
        return None
    return {**dict(row), "meta": json.loads(row["payload"])}


def sale_state(row, scope):
    explicit = row.get("onSale")
    status = str(row.get("lifecycleStatus") or "").strip().lower()
    if explicit is False or status in {"价格申报中", "未发布到站点", "已下架/终止", "已下架", "终止", "下架", "inactive", "delisted", "off_shelf"}:
        return "not_on_sale"
    if explicit is True or status in {"已发布到站点", "在线", "在售", "on_sale", "active", "listed"}:
        return "on_sale"
    # These releases only queried skcTopStatus:100. Require the matching
    # nonempty mall ID and a complete browser snapshot for legacy empty labels.
    if scope and scope["meta"].get("source") == "browser_extension" and scope["meta"].get("complete") is True:
        meta = scope["meta"]
        if str(meta.get("source_mall_id") or "") == scope["mall_id"] and meta.get("sale_scope", "on_sale") == "on_sale":
            return "on_sale"
    return "unknown"


def activity_state(row, now=None):
    now = now or datetime.now(timezone.utc)
    if str(row.get("cancelReviewStatus")) == "3" or row.get("statusKey") in {"cancelled", "rejected", "exited"}:
        return "cancelled"
    end = _time(row.get("sessionEndTime"))
    if end and end < now:
        return "ended"
    if str(row.get("cancelReviewStatus")) == "1" or row.get("statusKey") == "exit_review":
        return "exit_review"
    start = _time(row.get("sessionStartTime"))
    if start and start > now:
        return "scheduled"
    if str(row.get("sessionStatus")) == "2" or row.get("statusKey") == "active":
        return "active"
    return "unknown"


def _rows(db, kind, mall):
    return [{**json.loads(row["payload"]), "_captured": row["captured"]}
            for row in collector.current_records(db, kind, mall)]


def accelerator_targets(connect, mall_id, now=None):
    """Freeze accelerator targets from the last verified complete on-sale batch.

    Current records can contain later partial updates. Read the archived batch
    tied to the snapshot instead, so its membership and capture time stay exact.
    """
    mall = str(mall_id or "").strip()
    if not re.fullmatch(r"\d{1,40}", mall):
        raise ValueError("请选择有效店铺")
    with connect() as db:
        scope = snapshot_scope(db, "products", mall)
        meta = scope["meta"] if scope and isinstance(scope["meta"], dict) else {}
        if not (scope and meta.get("complete") is True
                and meta.get("source") == "browser_extension"
                and str(meta.get("source_mall_id") or "") == mall
                and meta.get("sale_scope", "on_sale") == "on_sale"):
            raise ValueError("缺少本店完整在售商品快照，请先更新商品＋活动")
        if freshness(scope["captured"], now)["stale"]:
            raise ValueError("本店在售商品快照已超过12小时，请先更新商品＋活动")
        archived = db.execute(
            "SELECT body FROM collector_payloads WHERE id=? AND observed_at=? AND source_path=?",
            (scope["batch_id"], scope["captured"], "/api/client/products/upload"),
        ).fetchone()
        try:
            body = json.loads(archived["body"]) if archived else None
            rows = body.get("rows") if isinstance(body, dict) else None
            original_meta = body.get("crawl_result", {}) if isinstance(body, dict) else {}
            valid = (isinstance(rows, list) and all(isinstance(row, dict) for row in rows)
                     and str(body.get("mall_id") or "") == mall
                     and str(body.get("source_mall_id", mall)) == mall
                     and isinstance(original_meta, dict)
                     and original_meta.get("source") == "browser_extension"
                     and str(original_meta.get("source_mall_id") or "") == mall
                     and original_meta.get("complete") is not False
                     and original_meta.get("sale_scope", "on_sale") == "on_sale"
                     and collector.complete_snapshot("products", rows, meta))
        except (TypeError, ValueError, json.JSONDecodeError):
            valid = False
        if not valid:
            raise ValueError("完整在售快照的原始批次缺失或范围不一致，请先更新商品＋活动")
        targets = set()
        skcs_by_spu, skc_owners = {}, {}
        for row in rows:
            if sale_state(row, scope) != "on_sale":
                continue
            spu = str(row.get("spuId") or "").strip()
            if not re.fullmatch(r"\d{1,40}", spu):
                raise ValueError("在售快照含无效SPU标识，请先更新商品＋活动")
            skc = str(row.get("skcId") or "").strip()
            if not re.fullmatch(r"\d{1,40}", skc) or int(skc) <= 0:
                raise ValueError("在售快照含无效SKC标识，请先更新商品＋活动")
            if skc in skc_owners and skc_owners[skc] != spu:
                raise ValueError("在售快照的同一SKC关联多个SPU，请先更新商品＋活动")
            skc_owners[skc] = spu
            skcs_by_spu.setdefault(spu, set()).add(skc)
            targets.add(spu)
    spu_ids = sorted(targets, key=lambda value: (int(value), value))
    return {"success": True, "mallId": mall, "spuIds": spu_ids,
            "skcIdsBySpu": {spu: sorted(skcs_by_spu[spu], key=lambda value: (int(value), value))
                            for spu in spu_ids},
            "catalogCaptured": scope["captured"], "complete": True,
            "targetHash": hashlib.sha256("\n".join(spu_ids).encode("utf-8")).hexdigest()}


def accelerator_switch_status(observations):
    # Ordinary eligibility explicitly means not yet enabled. Max eligibility
    # alone says nothing about the ordinary switch; absence/staleness is unknown.
    states = {"enabled" if row.get("status") == "enabled" else
              "disabled" if row.get("status") in {"eligible", "disabled"} else "unknown"
              for row in observations if not row["freshness"]["stale"]}
    return next(iter(states)) if len(states) == 1 else "unknown"


TRAFFIC_ATTENTION_SOURCE = "temu_native_flow_limit_v1"
FLOW_LIMIT_LABELS = {0: "无商品流量待关注标记", 1: "商品流量预测将下滑",
                     2: "商品流量待关注", 3: "商品流量近期有下滑"}


def traffic_attention_state(observations, now=None):
    """Read the independent official badge, never infer it from boost or metrics.

    Only the latest US badge observation can resolve this particular badge.
    A newer explicit unknown invalidates older evidence; legacy boost-only rows
    without any badge fields do not count as new badge observations.
    """
    fields = ("trafficAttention", "flowLimitStatus", "trafficAttentionSource", "trafficAttentionLabel")
    rows = [row for row in observations if row.get("siteName") == "美国站"
            and any(field in row for field in fields)]
    result = {"status": "unknown", "source": "", "rawStatus": None, "label": "",
              "freshness": freshness("", now), "reason": "尚未采集官方商品流量待关注标记"}
    if not rows:
        return result
    times = [_time(row.get("_captured")) for row in rows]
    if any(value is None for value in times):
        return {**result, "reason": "流量标记采集时间无效，需重新确认"}
    latest = max(times)
    rows = [row for row, stamp in zip(rows, times) if stamp == latest]
    result.update(source=TRAFFIC_ATTENTION_SOURCE if any(
        row.get("trafficAttentionSource") == TRAFFIC_ATTENTION_SOURCE for row in rows) else "",
        freshness=freshness(latest.isoformat(), now))
    if result["freshness"]["stale"]:
        return {**result, "reason": "官方流量标记快照已超过12小时，需更新确认"}
    states, raw_states = set(), set()
    for row in rows:
        page = urlparse(str(row.get("sourceUrl") or ""))
        raw, flag = row.get("flowLimitStatus"), row.get("trafficAttention")
        if (row.get("trafficAttentionSource") != TRAFFIC_ATTENTION_SOURCE
                or page.scheme != "https" or page.netloc != "agentseller-us.temu.com"
                or page.path != "/main/flux-analysis" or type(raw) is not int
                or raw not in FLOW_LIMIT_LABELS or type(flag) is not bool or flag != (raw == 2)):
            return {**result, "reason": "最新官方流量标记未明确返回，需更新确认"}
        states.add(flag)
        raw_states.add(raw)
    if len(states) != 1:
        return {**result, "reason": "同次官方流量标记证据冲突，需更新确认"}
    flag = next(iter(states))
    raw = next(iter(raw_states)) if len(raw_states) == 1 else None
    return {**result, "status": "attention" if flag else "clear", "rawStatus": raw,
            "label": FLOW_LIMIT_LABELS.get(raw, "无商品流量待关注标记"),
            "reason": "官方商品流量待关注标记" if flag else "官方列表明确无此特定标记"}


def _specification(row, evidence_specs):
    direct = activity_jobs.normalize_variant(row.get("specification") or row.get("properties"))
    if direct:
        return direct, "product_catalog"
    matched = re.search(r"\d+(?:\.\d+)?\s*[×*xX]\s*\d+(?:\.\d+)?\s*(?:cm|in|inch)", str(row.get("skuCode") or ""), re.I)
    if matched:
        return activity_jobs.normalize_variant(matched.group()), "sku_code"
    key = (str(row.get("spuId")), str(row.get("skcId")), str(row.get("skuId")))
    return evidence_specs.get(key, ("", "missing"))


def state(connect, mall_id):
    mall = str(mall_id or "").strip()
    if not re.fullmatch(r"\d{1,40}", mall):
        raise ValueError("请选择有效店铺")
    now = datetime.now(timezone.utc)
    with connect() as db:
        category_config = product_rules.load(db, mall)
        product_scope = snapshot_scope(db, "products", mall)
        activity_scope = snapshot_scope(db, "activities", mall)
        current = [product_rules.enrich_platform_category(row, product_scope, mall)
                   for row in _rows(db, "products", mall)]
        activities = _rows(db, "activities", mall)
        boosts = _rows(db, "accelerators", mall)
        known = {str(json.loads(row["payload"]).get("spuId") or "") for row in db.execute(
            "SELECT payload FROM collector_records WHERE dataset='products' AND mall_id=?", (mall,))}
        known.discard("")
        # A variant identity recovered from exact current SPU/SKC/price evidence
        # may supply its specification; eligibility/price are never copied here.
        evidence_specs = {}
        evidence = db.execute("""SELECT * FROM activity_evidence_snapshots e WHERE mall_id=? AND NOT EXISTS(
            SELECT 1 FROM activity_evidence_snapshots newer WHERE newer.mall_id=e.mall_id
            AND newer.campaign_id=e.campaign_id AND newer.captured>e.captured)
            ORDER BY captured DESC LIMIT 30""", (mall,)).fetchall()
        for saved in evidence:
            payload = activity_jobs.resolve_evidence(db, mall, json.loads(saved["payload"]))
            for row in payload["candidates"]:
                key = (row["spuId"], row["skcId"], row["skuId"])
                if row.get("specification") and key not in evidence_specs:
                    evidence_specs[key] = (row["specification"], "activity_identity_evidence")

    by_sku = {}
    for row in activities:
        key = tuple(str(row.get(k) or "") for k in ("spuId", "skcId", "skuId"))
        state_key = activity_state(row, now)
        by_sku.setdefault(key, []).append({
            **row, "status": state_key, "statusLabel": ACTIVITY_LABELS[state_key],
            "freshness": freshness(row["_captured"], now),
        })
    by_spu_boost = {}
    for row in boosts:
        by_spu_boost.setdefault(str(row.get("spuId") or ""), []).append({
            **row, "statusLabel": BOOST_LABELS.get(row.get("status"), "待确认"),
            "freshness": freshness(row["_captured"], now),
        })

    grouped = {}
    for row in current:
        spu = str(row.get("spuId") or "")
        if not spu:
            continue
        item = grouped.setdefault(spu, {"spuId": spu, "saleStatus": "unknown", "skus": [], "images": []})
        sale = sale_state(row, product_scope)
        if sale == "on_sale" or (sale == "not_on_sale" and item["saleStatus"] == "unknown"):
            item["saleStatus"] = sale
        if sale != "on_sale":
            continue
        image = str(row.get("imageUrl") or "")
        if image.startswith("https://") and image not in item["images"]:
            item["images"].append(image)
        key = tuple(str(row.get(k) or "") for k in ("spuId", "skcId", "skuId"))
        linked = by_sku.get(key, [])
        specification, spec_source = _specification(row, evidence_specs)
        observed_specification = specification
        override = category_config["overrides"].get(spu, {})
        maintained_specification = override.get("specifications", {}).get(key[1] + "|" + key[2], "")
        if maintained_specification:
            specification, spec_source = maintained_specification, "local_maintenance"
        item["skus"].append({
            "skuId": key[2], "skcId": key[1], "skuCode": row.get("skuCode") or "",
            **{field: row.get(field, [] if field in {"categoryPath", "categoryIds"} else "")
               for field in ("categoryId", "categoryName", "categoryPath", "categoryIds", "categorySource")},
            "categoryPathSource": row.get("categoryPathSource", ""),
            "categoryPathEvidence": row.get("categoryPathEvidence", {}),
            "specification": specification, "specificationSource": spec_source,
            "observedSpecification": observed_specification, "maintainedSpecification": maintained_specification,
            "declaredPrice": row.get("declaredPrice"), "currency": row.get("currency") or "CNY",
            "activities": linked, "freshness": freshness(row["_captured"], now),
        })

    # A successful full on-sale snapshot is the only absence evidence.
    if product_scope and product_scope["meta"].get("complete") is True and product_scope["meta"].get("source") == "browser_extension" and str(product_scope["meta"].get("source_mall_id") or "") == mall and product_scope["meta"].get("sale_scope", "on_sale") == "on_sale":
        for spu in known - set(grouped):
            grouped[spu] = {"spuId": spu, "saleStatus": "not_on_sale", "skus": [], "images": []}

    active, trash, pending = [], [], []
    for item in grouped.values():
        sale = item["saleStatus"]
        item["saleStatusLabel"] = SALE_LABELS[sale]
        if sale != "on_sale":
            compact = {"spuId": item["spuId"], "saleStatus": sale, "saleStatusLabel": SALE_LABELS[sale],
                       "captured": product_scope["captured"] if product_scope else ""}
            (trash if sale == "not_on_sale" else pending).append(compact)
            continue
        item["skus"].sort(key=lambda sku: (sku["skcId"], sku["specification"], sku["skuId"]))
        item.update(product_rules.classify(item["skus"], category_config))
        item["categoryOverride"] = category_config["overrides"].get(item["spuId"], {}).get("category", "")
        if item["categoryOverride"]:
            item.update(categoryName=item["categoryOverride"], categorySource="local_maintenance", categorySourceLabel="手动归类")
        linked = [a for sku in item["skus"] for a in sku["activities"]]
        current_activities = [a for a in linked if a["status"] in {"active", "scheduled", "exit_review"}]
        item["activityNames"] = sorted({a.get("activityName") or a.get("activityTypeName") or a["enrollId"] for a in current_activities})
        item["activityFreshness"] = freshness(activity_scope["captured"] if activity_scope else "", now)
        activity_meta = activity_scope["meta"] if activity_scope else {}
        activity_complete = bool(activity_scope and activity_meta.get("complete") is True
                                 and activity_meta.get("source") == "browser_extension"
                                 and str(activity_meta.get("source_mall_id") or "") == mall
                                 and activity_meta.get("enrollment_scope", "all") == "all")
        item["activityCoverage"] = {"complete": activity_complete,
                                    "fresh": not item["activityFreshness"]["stale"],
                                    "scope": activity_meta.get("enrollment_scope", "all") if activity_scope else "",
                                    "sourceTotal": activity_scope["source_total"] if activity_scope else None}
        item["activityStatus"] = ("enrolled" if current_activities else
                                  "none" if activity_complete and not item["activityFreshness"]["stale"]
                                  and not any(a["status"] == "unknown" for a in linked) else "unknown")
        if item["activityStatus"] == "enrolled":
            item["activityStatusLabel"] = "已报名（快照较旧）" if item["activityFreshness"]["stale"] else "已报名"
        else:
            item["activityStatusLabel"] = ("当前无生效活动" if item["activityStatus"] == "none" else
                                           "活动记录待更新" if item["activityFreshness"]["stale"] else
                                           "活动状态待确认" if activity_complete else "活动记录未确认全量")
        item["accelerators"] = by_spu_boost.get(item["spuId"], [])
        statuses = {b.get("status") for b in item["accelerators"] if not b["freshness"]["stale"]}
        item["acceleratorStatus"] = next(iter(statuses)) if len(statuses) == 1 else "unknown"
        item["acceleratorStatusLabel"] = BOOST_LABELS.get(item["acceleratorStatus"], "待确认")
        item["acceleratorSwitchStatus"] = accelerator_switch_status(item["accelerators"])
        item["acceleratorSwitchStatusLabel"] = BOOST_SWITCH_LABELS[item["acceleratorSwitchStatus"]]
        attention = traffic_attention_state(item["accelerators"], now)
        item["trafficAttentionStatus"] = attention["status"]
        item["trafficAttentionFreshness"] = attention["freshness"]
        item["trafficAttentionSource"] = attention["source"]
        item["trafficAttentionRawStatus"] = attention["rawStatus"]
        item["trafficAttentionLabel"] = attention["label"]
        item["trafficAttentionReason"] = attention["reason"]
        item["tags"] = [item["saleStatusLabel"], item["activityStatusLabel"], "加速器：" + item["acceleratorStatusLabel"]]
        if attention["status"] == "attention":
            item["tags"].append("商品流量待关注")
        item["freshness"] = freshness(product_scope["captured"] if product_scope else max((s["freshness"]["captured"] for s in item["skus"]), default=""), now)
        item["skuCount"] = len(item["skus"])
        active.append(item)
    active.sort(key=lambda item: item["spuId"])
    trash.sort(key=lambda item: item["spuId"])
    pending.sort(key=lambda item: item["spuId"])
    official_count = sum(bool(p["platformCategoryId"] or p["platformCategoryName"])
                         and not p["platformCategoryConflict"] for p in active)
    official_conflicts = sum(p["platformCategoryConflict"] for p in active)
    official_missing = len(active) - official_count - official_conflicts
    return {
        "success": True, "mallId": mall, "generatedAt": now.isoformat(),
        "products": active, "trash": trash, "pending": pending, "categoryConfig": category_config,
        "categoryCoverage": {"matched": official_count, "missing": official_missing,
                             "conflicts": official_conflicts, "total": len(active)},
        "counts": {"onSale": len(active), "notOnSale": len(trash), "unknown": len(pending),
                   "platformCategorized": official_count, "platformCategoryMissing": official_missing,
                   "platformCategoryConflicts": official_conflicts,
                   "skus": sum(p["skuCount"] for p in active),
                   "enrolled": sum(p["activityStatus"] == "enrolled" for p in active),
                   "accelerating": sum(p["acceleratorStatus"] == "enabled" for p in active),
                   "acceleratorUnknown": sum(p["acceleratorStatus"] == "unknown" for p in active),
                   "acceleratorSwitchEnabled": sum(p["acceleratorSwitchStatus"] == "enabled" for p in active),
                   "acceleratorSwitchDisabled": sum(p["acceleratorSwitchStatus"] == "disabled" for p in active),
                   "acceleratorSwitchUnknown": sum(p["acceleratorSwitchStatus"] == "unknown" for p in active),
                   "trafficAttention": sum(p["trafficAttentionStatus"] == "attention" for p in active),
                   "trafficAttentionUnknown": sum(p["trafficAttentionStatus"] == "unknown" for p in active)},
        "sources": {"products": freshness(product_scope["captured"] if product_scope else "", now),
                    "activities": freshness(activity_scope["captured"] if activity_scope else "", now),
                    "accelerators": {**freshness(max((b["_captured"] for b in boosts), default=""), now),
                                     "observedProducts": sum(bool(p["accelerators"]) for p in active),
                                     "freshProducts": sum(p["acceleratorStatus"] != "unknown" for p in active),
                                     "switchFreshProducts": sum(p["acceleratorSwitchStatus"] != "unknown" for p in active)},
                    "trafficAttention": {**freshness(max((p["trafficAttentionFreshness"]["captured"] for p in active), default=""), now),
                                         "observedProducts": sum(bool(p["trafficAttentionSource"]) for p in active),
                                         "freshProducts": sum(p["trafficAttentionStatus"] != "unknown" for p in active)}},
        "refreshIntervalSeconds": 15, "collectionIntervalMinutes": COLLECTION_INTERVAL_MINUTES,
        "freshnessWindowMinutes": FRESHNESS_WINDOW_MINUTES,
        "todo": "逐商品流量诊断与长期跟踪：后续共同确定指标、采样频率和保存周期。",
    }
