"""Shop-local category rules and display overrides, separate from activity prices."""
from __future__ import annotations

import json
import math
import re
from datetime import datetime, timezone

import activity_jobs


def mall_id(value):
    value = str(value or "").strip()
    if not re.fullmatch(r"\d{1,40}", value):
        raise ValueError("请选择有效店铺")
    return value


def text(value, limit=100):
    if not isinstance(value, str) or len(value.strip()) > limit or any(ord(c) < 32 for c in value):
        raise ValueError("规则文字格式无效或过长")
    return value.strip()


def load(db, mall):
    row = db.execute("SELECT payload FROM activity_settings WHERE id=?", ("product_rules:" + mall,)).fetchone()
    if row:
        return json.loads(row["payload"])
    # Bootstrap from this shop only. Editing category rules never alters prices.
    grouped = {}
    prefix = "preset:" + mall + ":"
    for saved in db.execute("SELECT payload FROM activity_settings WHERE id LIKE ?", (prefix + "%",)):
        config = json.loads(saved["payload"])
        if not isinstance(config, dict):
            continue
        name = str(config.get("category") or "").strip()
        if not name or name == "未分类":
            continue
        sizes = config.get("size_prices", {})
        grouped.setdefault(name, set()).update(activity_jobs.normalize_variant(s) for s in sizes if activity_jobs.normalize_dimension(s))
    keywords = {"毛毯": ["blanket"], "地垫": ["doormat"], "T恤": ["shirt"],
                "托特包": ["totebag"], "旅行包": ["travelbag"]}
    for name in keywords:
        grouped.setdefault(name, set())
    rules = [{"name": name, "specifications": sorted(sizes), "codeKeywords": keywords.get(name, []),
              "minMatches": 1, "tolerance": 2, "allowUnmatched": False}
             for name, sizes in grouped.items() if sizes or keywords.get(name)]
    return {"revision": 0, "rules": rules, "overrides": {}, "updatedAt": "", "saved": False}


def validate_rules(rules):
    if not isinstance(rules, list) or len(rules) > 100:
        raise ValueError("最多维护 100 个类目")
    result, seen = [], set()
    for rule in rules:
        if not isinstance(rule, dict):
            raise ValueError("类目规则格式无效")
        name = text(rule.get("name"), 60)
        if not name or name == "未分类" or name in seen:
            raise ValueError("类目名称不能为空、重复或使用未分类")
        seen.add(name)
        fields = {}
        for key in ("specifications", "codeKeywords"):
            values = rule.get(key, [])
            if not isinstance(values, list) or len(values) > 100:
                raise ValueError("每个类目最多填写 100 个规格或货号关键词")
            normalized = [text(v) for v in values]
            if key == "specifications":
                normalized = [activity_jobs.normalize_variant(v) for v in normalized]
            fields[key] = list(dict.fromkeys(v for v in normalized if v))
        if not fields["specifications"] and not fields["codeKeywords"]:
            raise ValueError("每个类目至少填写一种规格或货号关键词")
        minimum = rule.get("minMatches", 1)
        tolerance = rule.get("tolerance", 2)
        if isinstance(minimum, bool) or not isinstance(minimum, int) or not 1 <= minimum <= 100:
            raise ValueError("最少匹配规格数需要为 1 到 100 的整数")
        if isinstance(tolerance, bool) or not isinstance(tolerance, (int, float)) or not math.isfinite(tolerance) or not 0 <= tolerance <= 10:
            raise ValueError("尺寸容差需要为 0 到 10")
        if fields["specifications"] and minimum > len(fields["specifications"]):
            raise ValueError("最少匹配数不能超过已填写的规格数")
        allow = rule.get("allowUnmatched", False)
        if not isinstance(allow, bool):
            raise ValueError("额外规格设置无效")
        result.append({"name": name, **fields, "minMatches": minimum, "tolerance": tolerance, "allowUnmatched": allow})
    return result


def matches(spec, expected, tolerance):
    def parts(value):
        m = re.fullmatch(r"(\d+(?:\.\d+)?)×(\d+(?:\.\d+)?)(cm|in)", activity_jobs.normalize_dimension(value))
        return (float(m[1]), float(m[2]), m[3]) if m else None
    left, right = parts(spec), parts(expected)
    if left or right:
        return bool(left and right and left[2] == right[2] and
                    abs(left[0] - right[0]) <= tolerance and abs(left[1] - right[1]) <= tolerance)
    return bool(spec and str(spec).strip().casefold() == str(expected).strip().casefold())


def classify(skus, config):
    codes = [str(s.get("skuCode") or "").casefold() for s in skus]
    specs = {s["specification"] for s in skus if s.get("specification")}
    candidates = {}
    for rule in config["rules"]:
        code_match = any(word.casefold() in code for word in rule["codeKeywords"] for code in codes)
        matched = set()
        extra = False
        for spec in specs:
            exact = [target for target in rule["specifications"] if matches(spec, target, 0)]
            targets = exact or [target for target in rule["specifications"] if matches(spec, target, rule["tolerance"])]
            if len(targets) == 1:
                matched.add(targets[0])
            else:
                extra = True
        spec_match = len(matched) >= rule["minMatches"] and (rule["allowUnmatched"] or not extra)
        if code_match or spec_match:
            candidates[rule["name"]] = "sku_code" if code_match else "spec_preset"
    if len(candidates) == 1:
        name, source = next(iter(candidates.items()))
        return {"categoryName": name, "categorySource": source,
                "categorySourceLabel": "货号规则" if source == "sku_code" else "规格规则"}
    return {"categoryName": "未分类", "categorySource": "conflict" if candidates else "missing",
            "categorySourceLabel": "多个类目规则冲突" if candidates else "类目或规格信息不足"}


def save(body, connect):
    mall = mall_id(body.get("mall_id"))
    action = body.get("action", "rules")
    rules = validate_rules(body.get("rules")) if action == "rules" else None
    if action not in {"rules", "product", "products"}:
        raise ValueError("未知维护操作")
    with connect() as db:
        config = load(db, mall)
        previous = db.execute("SELECT payload FROM activity_settings WHERE id=?", ("product_rules:" + mall,)).fetchone()
        if body.get("revision") != config["revision"]:
            raise ValueError("设置已被其他页面更新，请重新打开后再保存")
        if action == "rules":
            config["rules"] = rules
        elif action == "products":
            spus = body.get("spuIds")
            if not isinstance(spus, list) or len(spus) > 500:
                raise ValueError("商品 SPU 列表无效，每批最多维护 500 个商品")
            if any(not isinstance(spu, str) or not re.fullmatch(r"\d{1,40}", spu) for spu in spus):
                raise ValueError("商品 SPU 无效")
            owned = {str(json.loads(row["payload"]).get("spuId")) for row in db.execute(
                "SELECT payload FROM collector_records WHERE dataset='products' AND mall_id=?", (mall,))}
            if not set(spus).issubset(owned):
                raise ValueError("当前店铺没有这个商品")
            category = text(body.get("category"), 60)
            if category and category not in {r["name"] for r in config["rules"]}:
                raise ValueError("请先在规则中添加对应类目")
            for spu in dict.fromkeys(spus):
                override = config["overrides"].get(spu, {})
                if category:
                    override["category"] = category
                else:
                    override.pop("category", None)
                if category or override.get("specifications"):
                    config["overrides"][spu] = override
                else:
                    config["overrides"].pop(spu, None)
        else:
            spu = str(body.get("spuId") or "")
            if not re.fullmatch(r"\d{1,40}", spu):
                raise ValueError("商品 SPU 无效")
            rows = [json.loads(r["payload"]) for r in db.execute(
                "SELECT payload FROM collector_records WHERE dataset='products' AND mall_id=?", (mall,))]
            own = {(str(r.get("skcId") or "") + "|" + str(r.get("skuId") or "")) for r in rows if str(r.get("spuId")) == spu}
            if not own:
                raise ValueError("当前店铺没有这个商品")
            category = text(body.get("category", ""), 60)
            if category and category not in {r["name"] for r in config["rules"]}:
                raise ValueError("请先在规则中添加对应类目")
            specifications = body.get("specifications", {})
            if not isinstance(specifications, dict) or len(specifications) > 500:
                raise ValueError("商品规格格式无效")
            specs = {}
            for key, value in specifications.items():
                if key not in own:
                    raise ValueError("规格不属于当前店铺商品")
                label = text(value)
                if label:
                    specs[key] = label
            if category or specs:
                config["overrides"][spu] = {"category": category, "specifications": specs}
            else:
                config["overrides"].pop(spu, None)
        config.update(revision=config["revision"] + 1, saved=True, updatedAt=datetime.now(timezone.utc).isoformat())
        payload = json.dumps(config, ensure_ascii=False)
        if previous:
            changed = db.execute("UPDATE activity_settings SET updated=?,payload=? WHERE id=? AND payload=?",
                                 (config["updatedAt"], payload, "product_rules:" + mall, previous["payload"])).rowcount
        else:
            changed = db.execute("INSERT OR IGNORE INTO activity_settings VALUES(?,?,?)",
                                 ("product_rules:" + mall, config["updatedAt"], payload)).rowcount
        if changed != 1:
            raise ValueError("设置已被其他页面更新，请重新打开后再保存")
    return {"success": True, "mallId": mall, "config": config}
