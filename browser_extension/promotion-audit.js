/* Read-only promotion planning. Never contains enrollment/activation requests. */
(function (root) {
  "use strict";
  const money = (value) => value !== null && value !== "" && Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null;
  const cents = (value) => Math.round(Number(value) * 100);
  const round = (value) => Math.round(value * 100) / 100;
  const minimumAcceleratorPrice = (activityPrice) => {
    const activity = money(activityPrice);
    if (!activity) return null;
    return (cents(activity) + 1) / 100;
  };
  const DEFAULT_ACTIVITY_PRICE_CEILING = 51;
  const tiers = [{name:"普通",level:1,factor:.95,quoteField:"ordinaryPrice"},{name:"高级",level:2,factor:.93,quoteField:"premiumPrice"},{name:"超级",level:3,factor:.90,quoteField:"superPrice"}];
  // Use integer cents so the strict 90% compatibility boundary is not
  // weakened by floating-point rounding.
  function activityFitsAccelerator(activityPrice, acceleratorPrice) {
    const activity = money(activityPrice), accelerator = money(acceleratorPrice);
    return Boolean(activity && accelerator && cents(activity) * 100 <= cents(accelerator) * 90);
  }
  function qualifyingOnlineActivity(sku, maxDiscountPercent = 85) {
    const declaredPrice = money(sku?.declaredPrice);
    const limit = Number(maxDiscountPercent);
    if (!declaredPrice || !Number.isFinite(limit) || limit <= 0) return null;
    const candidates = (sku?.activities || []).map((activity) => {
      const price = money(activity?.activity_price);
      const activityDailyPrice = money(activity?.daily_price) || declaredPrice;
      const reportedDiscount = Number(activity?.discount_rate);
      // 资格以实际活动价 / 活动日常价为准；discount_rate 只在价格基准
      // 缺失时兜底，避免旧活动标签与当前价格不一致时误入队列。
      const discountPercent = price && activityDailyPrice
        ? round(price / activityDailyPrice * 100)
        : (Number.isFinite(reportedDiscount) && reportedDiscount > 0 ? reportedDiscount : NaN);
      return {price, discountPercent, name:String(activity?.activity_name || "当前活动")};
    }).filter((activity) => activity.price && Number.isFinite(activity.discountPercent) && activity.discountPercent <= limit + 0.0001);
    candidates.sort((left, right) => cents(left.price) - cents(right.price) || left.discountPercent - right.discountPercent);
    return candidates[0] || null;
  }
  function lowestActivityPrices(scans, activities, selectedIndexes = null) {
    const allowed = Array.isArray(selectedIndexes) ? new Set(selectedIndexes.map(Number)) : null;
    const bySkc = new Map();
    for (const scan of scans || []) {
      const index = Number(scan?.index);
      if (scan?.status !== "eligible" || (allowed && !allowed.has(index))) continue;
      const activity = (activities || [])[index] || {};
      for (const sample of scan.priceSamples || []) {
        const skcId = String(sample?.skcId || "").trim();
        const price = money(sample?.proposedPrice), floor = money(sample?.floor), ceiling = money(sample?.ceiling);
        if (!skcId || !price || !floor || !ceiling || cents(price) < cents(floor) || cents(price) > cents(ceiling)) continue;
        const current = bySkc.get(skcId);
        if (current && cents(current.price) <= cents(price)) continue;
        bySkc.set(skcId, {
          skcId,
          price,
          floor,
          ceiling,
          dailyMin:money(sample?.dailyMin),
          dailyMax:money(sample?.dailyMax),
          referenceMin:money(sample?.referenceMin),
          referenceMax:money(sample?.referenceMax),
          discountPercent:Number(sample?.discountPercent ?? activity.discountPercent),
          activityIndex:index,
          activityName:String(activity.name || scan.name || `活动 ${index + 1}`),
        });
      }
    }
    return Object.fromEntries(bySkc);
  }
  function catalogProduct(item) {
    const recommendation = item.activity_recommendation || {};
    return {
      spuId:String(item.spu_id || ""), skcId:String(item.skc_id || ""), remark:String(item.remark || ""),imageUrl:String(item.browse_image_url || ""),isActive:item.is_active !== false,
      activityExcluded:Boolean(item.activity_excluded),
      floor:money(recommendation.floor), ceiling:money(recommendation.ceiling) || DEFAULT_ACTIVITY_PRICE_CEILING,
      activityNames:[...new Set((item.skus || []).flatMap(sku => (sku.activities || []).map(a => a.activity_name)).filter(Boolean))],
      skus:(item.skus || []).map(sku => ({
        skuId:String(sku.sku_id || ""), skuCode:String(sku.sku_code || ""),
        declaredPrice:money(sku.declared_price), actualSalePrice:money(sku.actual_sale_price),
        floor:money(sku.activity_floor?.floor), ceiling:money(sku.activity_floor?.ceiling) || money(recommendation.ceiling) || DEFAULT_ACTIVITY_PRICE_CEILING, floorEligible:sku.activity_floor?.eligible === true,
        floorRule:String(sku.activity_floor?.rule || ""), skuGroup:String(sku.activity_floor?.sku_group || "other"), skuGroupLabel:String(sku.activity_floor?.sku_group_label || ""),
        priceMismatch:Boolean(sku.price_mismatch), activities:sku.activities || [],
      })),
    };
  }
  function productIssues(product) {
    const issues = [];
    if (!product.skus?.length) issues.push("缺少 SKU 数据");
    const ids = new Set();
    for (const sku of product.skus || []) {
      const label = sku.skuCode || sku.skuId || "未知 SKU";
      if (!sku.skuId || ids.has(sku.skuId)) issues.push(`${label}：SKU ID 缺失或重复`);
      ids.add(sku.skuId);
      if (!sku.floorEligible || !money(sku.floor)) issues.push(`${label}：未配置可用底线或命中禁报规则`);
      if (money(sku.floor) && money(sku.ceiling) && cents(sku.floor) > cents(sku.ceiling)) issues.push(`${label}：底线 ¥${sku.floor} 高于活动上限 ¥${sku.ceiling}`);
      if (!money(sku.declaredPrice)) issues.push(`${label}：缺少日常申报价`);
      else if (money(sku.floor) && cents(sku.declaredPrice) < cents(sku.floor)) issues.push(`${label}：日常申报价 ¥${sku.declaredPrice} 低于底线 ¥${sku.floor}`);
      if (sku.priceMismatch) issues.push(`${label}：库中活动日常价与在售日常价不一致，需重新采集`);
      if (money(sku.actualSalePrice) && money(sku.floor) && cents(sku.actualSalePrice) < cents(sku.floor)) issues.push(`${label}：库中实际价 ¥${sku.actualSalePrice} 低于底线 ¥${sku.floor}`);
      for (const activity of sku.activities || []) {
        const price = money(activity.activity_price);
        if (!price) issues.push(`${label}：${activity.activity_name || "当前活动"}缺少活动价`);
        else if (money(sku.floor) && cents(price) < cents(sku.floor)) issues.push(`${label}：${activity.activity_name || "当前活动"} ¥${price} 低于底线 ¥${sku.floor}`);
      }
    }
    return [...new Set(issues)];
  }
  function activeActivityIssues(product) {
    const issues = [];
    for (const sku of product.skus || []) {
      const acceleratorPrice = money(sku.declaredPrice), label = sku.skuCode || sku.skuId || "未知 SKU";
      for (const activity of sku.activities || []) {
        const activityPrice = money(activity.activity_price);
        if (activityPrice && acceleratorPrice && !activityFitsAccelerator(activityPrice, acceleratorPrice)) {
          issues.push(`${label}：${activity.activity_name || "当前活动"} ¥${activityPrice} 高于当前申报价 ¥${acceleratorPrice} 的 90%，需检查活动调价待办`);
        }
      }
    }
    return [...new Set(issues)];
  }
  function flowState(spuId, flow) {
    if (!flow?.success) return "unknown";
    const active = (flow.accelerating||[]).some(row => row.spuId === spuId);
    const pending = (flow.pending||[]).some(row => row.spuId === spuId);
    if(active&&pending)return "unknown";
    if(active)return "accelerating";
    // A positive pending result is useful even if that bucket is incomplete,
    // but the active scan must finish first to rule out conflicting state.
    if(pending&&(flow.complete===true||flow.buckets?.accelerating?.complete===true))return "pending";
    if(flow?.complete===true||(flow?.buckets?.accelerating?.complete===true&&flow?.buckets?.pending?.complete===true))return "unavailable";
    return "unknown";
  }
  // Local filtering uses individual SKU floors, not the maximum floor of a mixed SKC.
  function candidates(products, discount, flow) {
    const searchFactor = Math.max(Number(discount), 60) / 100;
    return products.filter(product => {
      const state = flowState(product.spuId, flow);
      if (!["pending","accelerating"].includes(state)) return false;
      const blocked = products.some(sibling => sibling.spuId === product.spuId &&
        (productIssues(sibling).length || (state === "accelerating" && activeActivityIssues(sibling).length)));
      return !blocked && product.skus.every(sku => cents(round(sku.declaredPrice * searchFactor)) >= cents(sku.floor));
    });
  }
  function evaluateMatch(product, quotes, discount) {
    const reasons = productIssues(product);
    const byId = new Map();
    for (const quote of quotes) {
      if (!quote.skuId || byId.has(quote.skuId)) reasons.push("平台 SKU ID 缺失或重复，不能按行号猜测对应关系");
      byId.set(quote.skuId, quote);
    }
    if (byId.size !== product.skus.length || product.skus.some(sku => !byId.has(sku.skuId))) reasons.push("平台 SKU 与数据库未完整对应");
    const rows = product.skus.map(sku => {
      const quote = byId.get(sku.skuId) || {};
      const daily = money(quote.dailyPrice), reference = money(quote.referencePrice);
      if (!daily || !reference) reasons.push(`${sku.skuCode || sku.skuId}：缺少平台日常价或参考价`);
      // First retain the highest activity price allowed. Pairing is a separate
      // alternative, not an unconditional reduction to 80% for every product.
      const factor = discount / 100;
      const ceiling = money(sku.ceiling) || money(product.ceiling) || DEFAULT_ACTIVITY_PRICE_CEILING;
      const price = daily && reference ? Math.min(round(daily * factor), reference, ceiling) : null;
      return {...sku, dailyPrice:daily, referencePrice:reference, proposedPrice:price};
    });
    // Do not unify garment/accessory SKUs across distinct floor groups.
    const homogeneous = new Set(rows.map(sku => `${sku.skuGroup}:${sku.floor}:${sku.ceiling}`)).size === 1;
    if (homogeneous && rows.length && rows.every(sku => money(sku.proposedPrice))) {
      const shared = Math.min(...rows.map(sku => sku.proposedPrice));
      for (const sku of rows) sku.proposedPrice = shared;
    } else if (rows.length > 1 && !homogeneous) reasons.push("同 SKC 混合货号分类或底线，需确认独立定价，暂不统一报价");
    for (const sku of rows) {
      if (money(sku.floor) && money(sku.ceiling) && cents(sku.floor) > cents(sku.ceiling)) reasons.push(`${sku.skuCode || sku.skuId}：底线 ¥${sku.floor} 与最高价 ¥${sku.ceiling} 冲突`);
      if (money(sku.proposedPrice) && cents(sku.proposedPrice) < cents(sku.floor)) reasons.push(`${sku.skuCode || sku.skuId}：建议价 ¥${sku.proposedPrice} 低于底线 ¥${sku.floor}${quotes.some(q => q.special) ? "（含平台特殊参考价，未假定补贴可弥补差价）" : ""}`);
    }
    return {skcId:product.skcId,spuId:product.spuId,eventDiscountPercent:discount,status:reasons.length ? "review" : "price_checked",reasons:[...new Set(reasons)],skus:rows};
  }
  function report(products, flow, scans, context = {}) {
    const rows = products.map(product => {
      const status = flowState(product.spuId, flow);
      const issues = [...new Set([...productIssues(product), ...(status === "accelerating" ? activeActivityIssues(product) : [])])];
      const activityPlans = scans.flatMap(scan => (scan.pricePlans || []).filter(plan => plan.skcId === product.skcId).map(plan => ({...plan,activityName:scan.name,thematicId:scan.thematicId})));
      const quote=(flow?.quotes||[]).find(item=>item.spuId===product.spuId),quoteSkus=new Map((quote?.skcs||[]).flatMap(skc=>skc.skus||[]).map(sku=>[sku.skuId,sku]));
      const estimates = tiers.map(tier => ({name:tier.name,source:quote?"platform_quote":"estimate_not_quote",skus:product.skus.map(sku => ({skuId:sku.skuId,price:money(quoteSkus.get(sku.skuId)?.[tier.quoteField]) ?? (money(sku.declaredPrice) ? round(sku.declaredPrice * tier.factor) : null),floor:sku.floor}))}));
      const reasons = [...issues];
      if (status === "accelerating") reasons.push("已开启加速器：只允许追加逐 SKU 满足“活动价不高于当前申报价 90%”且不低于底线的活动");
      else if (status === "unknown") reasons.push("加速器状态未核实；未出现在两个列表中不代表未开启");
      else if (status === "unavailable") reasons.push("未开启但不在平台可开启清单中；本轮不进入加速器方案");
      else if (!quote) reasons.push("平台可开启但三档真实报价未完整返回；不按估算执行");
      const blockedSibling = products.some(other => other.spuId === product.spuId && productIssues(other).length);
      if (blockedSibling && !issues.length) reasons.push("同 SPU 的其他 SKC 存在异常，整个 SPU 加速器方案暂缓");
      return {...product,flowStatus:status,issues,reasons,activityPlans,acceleratorEstimates:estimates,
        status:issues.length ? "anomaly" : "review",executable:false,
        sequence:status === "accelerating" ? "保持现有加速器，按实际价格核对后可追加兼容活动" : "先活动提交成功并复核，再检查加速器实际报价；本版仅检查"};
    });
    const summary={version:3,generatedAt:Date.now(),...context,readOnly:true,executableCount:0,rows,scans,
      counts:{skcs:rows.length,spus:new Set(rows.map(row => row.spuId)).size,anomalies:rows.filter(row => row.issues.length).length,
        accelerating:flow?.complete===true||flow?.buckets?.accelerating?.complete===true?rows.filter(row => row.flowStatus === "accelerating").length:null,
        activityPriceChecked:rows.filter(row => row.activityPlans.some(plan => plan.status === "price_checked")).length},
      flowError:[flow?.error,...(flow?.quoteErrors||[])].filter(Boolean).join("；"),notes:["底线、活动上限与现有活动来自本次 Online 目录；加速器三档使用 Temu 本轮真实报价。", "真实报价缺失、SKU 对应不完整或任一 SKU 触碰独立底线时不进入可开启。", "默认活动上限为 ¥51；已配置货号分类时使用该分类的独立上限，加速器单开不套用此上限。", "默认先活动成功，再按普通 85% / 高级 83% / 超级 80% 复核加速器；已开启加速器的商品按活动价不高于当前申报价 90% 逐 SKU 判断，不再一律排除。", "开启加速器后必须检查活动调价待办；出现待办时需在 Temu 要求时限内处理。"]};
    summary.groups=groupSpuPlans(rows,flow);
    summary.groupCounts=Object.fromEntries(["pending","can_open","candidate","anomaly","activity_first","activity_compatible","accelerating","unavailable","unknown"].map(key=>[key,summary.groups.filter(group=>group.tags.includes(key)).length]));
    if(!(flow?.complete===true||flow?.buckets?.accelerating?.complete===true))summary.groupCounts.accelerating=null;
    if(!(flow?.complete===true||flow?.buckets?.pending?.complete===true)&&summary.groupCounts.pending===0)summary.groupCounts.pending=null;
    return summary;
  }
  function groupSpuPlans(rows,flow){
    const bySpu=new Map();
    for(const row of rows){const key=row.spuId||`unknown-${row.skcId}`;if(!bySpu.has(key))bySpu.set(key,[]);bySpu.get(key).push(row);}
    return [...bySpu.values()].map(products=>{
      const first=products[0],status=flowState(first.spuId,flow),skus=products.flatMap(product=>product.skus.map(sku=>({...sku,skcId:product.skcId})));
      const issues=[...new Set(products.flatMap(product=>product.issues))];
      const hasActivities=skus.some(sku=>(sku.activities||[]).length);
      const names=[...new Set(skus.flatMap(sku=>(sku.activities||[]).map(activity=>activity.activity_name)).filter(Boolean))];
      const quote=(flow?.quotes||[]).find(item=>item.spuId===first.spuId),quoteSkus=new Map((quote?.skcs||[]).flatMap(skc=>skc.skus||[]).map(sku=>[sku.skuId,sku]));
      const quoteComplete=Boolean(quote?.canSubmit)&&skus.length>0&&skus.every(sku=>quoteSkus.has(sku.skuId));
      const tierPlans=tiers.map(tier=>{
        const target=Math.round((tier.factor-.10)*100);
        const prices=skus.map(sku=>({...sku,price:money(quoteSkus.get(sku.skuId)?.[tier.quoteField]),estimatedPrice:money(sku.declaredPrice)?round(sku.declaredPrice*tier.factor):null}));
        const failed=prices.filter(sku=>!sku.floorEligible||!money(sku.floor)||!money(sku.price)||cents(sku.price)<cents(sku.floor));
        const pairs=products.map(product=>{
          const proposals=product.activityPlans.filter(plan=>plan.status==="price_checked").map(plan=>{
            const quotes=plan.skus.map(sku=>({skuId:sku.skuId,dailyPrice:sku.dailyPrice,referencePrice:sku.referencePrice}));
            const adjusted=evaluateMatch(product,quotes,Math.min(target,Number(plan.eventDiscountPercent)||target));
            return {...adjusted,activityName:plan.activityName,thematicId:plan.thematicId};
          }).filter(plan=>plan.status==="price_checked");
          // Existing activity prices cannot be silently rewritten.
          const existingOk=product.skus.every(sku=>(sku.activities||[]).length>0&&(sku.activities||[]).every(activity=>money(activity.daily_price)&&money(activity.activity_price)&&cents(activity.activity_price)>=cents(sku.floor)&&cents(activity.activity_price)<=cents(round(activity.daily_price*target/100))));
          const hasExisting=product.skus.some(sku=>(sku.activities||[]).length);
          return {skcId:product.skcId,existingOk,proposals:hasExisting?[]:proposals};
        });
        const pairCandidate=quoteComplete&&!issues.length&&!failed.length&&pairs.every(pair=>pair.existingOk||pair.proposals.length>0);
        return {name:tier.name,discount:Math.round(tier.factor*100),activityDiscount:target,prices,failed,pairs,
          floorCandidate:quoteComplete&&!issues.length&&!failed.length,pairCandidate,source:quoteComplete?"platform_quote":"quote_missing"};
      });
      const activeActivityPlans=products.flatMap(product=>product.activityPlans.filter(plan=>plan.status==="price_checked").map(plan=>{
        const compatible=plan.skus.length===product.skus.length&&plan.skus.every(sku=>
          sku.floorEligible&&money(sku.floor)&&money(sku.dailyPrice)&&money(sku.proposedPrice)&&
          cents(sku.dailyPrice)>=cents(sku.floor)&&cents(sku.proposedPrice)>=cents(sku.floor)&&
          activityFitsAccelerator(sku.proposedPrice,sku.dailyPrice));
        return {...plan,compatible};
      })).filter(plan=>plan.compatible);
      const tags=[],safeTiers=tierPlans.filter(tier=>tier.floorCandidate),pairedTiers=tierPlans.filter(tier=>tier.pairCandidate),canOpen=safeTiers.length>0;
      const recommendedTier=safeTiers[safeTiers.length-1]||null,recommendedCombination=pairedTiers[pairedTiers.length-1]||null;
      let headline="状态未查清",reason="未能核实加速器状态，不推断未开启",sequence="先补齐状态，再决定方案";
      if(status==="accelerating"){
        tags.push("accelerating");
        if(issues.length){headline="已开启 · 价格关系异常";reason=issues[0];sequence="暂停追加活动 → 检查活动调价待办和底线";}
        else if(activeActivityPlans.length){
          tags.push("activity_compatible","candidate");headline="已开启 · 可追加兼容活动";
          reason=`已找到 ${new Set(activeActivityPlans.map(plan=>plan.thematicId||plan.activityName)).size} 个活动、${new Set(activeActivityPlans.map(plan=>plan.skcId)).size} 个 SKC 逐 SKU 满足 90% 价差和底线`;
          sequence="保持现有加速器 → 只报名已通过 90% 价差与底线核验的活动 → 提交后复查活动状态";
        }else{
          headline="已开启 · 暂无可确认的兼容活动";reason="本轮活动未返回同时满足 90% 价差和逐 SKU 底线的报价";
          sequence="保持现有加速器；重新采集价格后再检查，不按估算追加活动";
        }
      }else if(status==="unavailable"){
        tags.push("unavailable");headline="未开启 · 平台当前不可开";reason="不在 Temu 的可开启清单，本轮不尝试开启";
        sequence="保留现状；以后重新检查平台资格";
      }else if(status==="pending"){
        tags.push("pending");
        if(issues.length){headline="未开启 · 价格或底线异常";reason=issues[0];}
        else if(!quoteComplete){headline="未开启 · 真实报价待补齐";reason=quote?.reason||"Temu 三档报价或 SKU 对应不完整；不按理论折扣执行";tags.push("candidate");}
        else if(!canOpen){headline="未开启 · 三档真实报价均不达底线";reason="Temu 返回的普通、高级、超级价格均有 SKU 低于独立底线";tags.push("anomaly");}
        else{
          tags.push("candidate","can_open");headline="未开启 · 真实报价可开";
          reason=`${tierPlans.filter(tier=>tier.floorCandidate).map(tier=>tier.name).join(" / ")}的 Temu 真实报价不低于底线`;
          if(recommendedCombination){
            tags.push("activity_first");headline=hasActivities?"已有活动 · 可评估加开加速器":"候选方案 · 先活动后加速器";
            reason+=`；优先方案为活动不高于 ${recommendedCombination.activityDiscount/10} 折，再开${recommendedCombination.name}加速器`;
            sequence=hasActivities?"复核已报名活动价格与成功状态 → 核对加速器真实报价 → 再开启":"先选择活动 → 确认报名成功 → 核对加速器真实报价 → 再开启";
          }else{
            reason+=hasActivities?"；已有活动尚未满足搭配条件，不建议直接加开":`；当前仅建议单开${recommendedTier.name}加速器`;
            sequence=hasActivities?"先核清现有活动与加速器的价差，未核清不加开":`核实${recommendedTier.name}档逐 SKU 真实报价后再决定；开启后检查活动调价待办`;
          }
        }
      }else tags.push("unknown");
      if(issues.length&&!tags.includes("anomaly"))tags.push("anomaly");
      return {spuId:first.spuId,products,skus,flowStatus:status,tags,headline,reason,sequence,issues,tierPlans,
        recommendedTier:recommendedTier?{name:recommendedTier.name,discount:recommendedTier.discount,activityDiscount:recommendedTier.activityDiscount}:null,
        recommendedCombination:recommendedCombination?{name:recommendedCombination.name,discount:recommendedCombination.discount,activityDiscount:recommendedCombination.activityDiscount}:null,
        activityNames:names,activeActivityPlans,realQuoteReady:quoteComplete,executable:false,
        imageUrl:products.find(product=>product.imageUrl)?.imageUrl||"",remarks:[...new Set(products.map(product=>product.remark).filter(Boolean))]};
    });
  }
  function acceleratorExecutionPlans(products,flow,submittedActivityPrices=[],options={}){
    if(!flow?.success||flow?.complete!==true)return [];
    const submittedBySkc=new Map();
    for(const item of submittedActivityPrices||[]){
      const skcId=String(item?.skcId||""),price=money(item?.price);
      if(!skcId||!price)continue;
      const values=submittedBySkc.get(skcId)||[];values.push(price);submittedBySkc.set(skcId,values);
    }
    const bySpu=new Map();
    for(const product of products||[]){
      const key=String(product?.spuId||"");if(!key)continue;
      if(!bySpu.has(key))bySpu.set(key,[]);bySpu.get(key).push(product);
    }
    const plans=[];
    for(const [spuId,spuProducts] of bySpu){
      if(flowState(spuId,flow)!=="pending")continue;
      const issues=[...new Set(spuProducts.flatMap(productIssues))];
      if(issues.length)continue;
      const quote=(flow.quotes||[]).find(item=>String(item?.spuId||"")===spuId);
      if(!quote?.canSubmit)continue;
      const catalogSkus=spuProducts.flatMap(product=>product.skus.map(sku=>({...sku,skcId:product.skcId})));
      const quoteSkus=new Map((quote.skcs||[]).flatMap(skc=>(skc.skus||[]).map(sku=>[String(sku.skuId||""),{...sku,skcId:String(skc.skcId||"")}])));
      if(!catalogSkus.length||quoteSkus.size!==catalogSkus.length||catalogSkus.some(sku=>!quoteSkus.has(String(sku.skuId))))continue;
      if(options.customActivityPrice===true){
        const skus=catalogSkus.map(sku=>{
          const fresh=quoteSkus.get(String(sku.skuId))||{};
           const onlineActivity=Number.isFinite(Number(options.onlineActivityMaxDiscountPercent))
             ? qualifyingOnlineActivity(sku, Number(options.onlineActivityMaxDiscountPercent))
             : null;
           const activityPrices=onlineActivity
             ? [onlineActivity.price]
             : [...(options.submittedOnly===true?[]:(sku.activities||[]).map(activity=>money(activity.activity_price))),...(submittedBySkc.get(String(sku.skcId))||[])].filter(Boolean);
           const activityPriceCents=new Set(activityPrices.map(cents));
           const maxActivityPrice=onlineActivity?.price||(activityPrices.length?Math.max(...activityPrices):null);
           const targetPrice=minimumAcceleratorPrice(maxActivityPrice),floor=money(sku.floor),dailyPrice=money(fresh.dailyPrice),referenceMax=money(fresh.superPrice);
           const safe=Boolean(activityPriceCents.size===1&&sku.floorEligible&&maxActivityPrice&&targetPrice&&dailyPrice&&referenceMax&&money(sku.declaredPrice)&&
            cents(sku.declaredPrice)===cents(dailyPrice)&&cents(targetPrice)>=cents(floor)&&cents(targetPrice)<=cents(referenceMax)&&
            cents(targetPrice)<cents(dailyPrice)&&cents(targetPrice)===cents(maxActivityPrice)+1);
          return {skuId:String(sku.skuId),skcId:String(sku.skcId),dailyPrice,targetPrice,floor,maxActivityPrice,referenceMax,
            activityName:onlineActivity?.name||"",activityDiscountPercent:onlineActivity?.discountPercent??null,safe};
        });
        if(skus.length&&skus.every(sku=>sku.safe))plans.push({spuId,siteId:Number(quote.siteId||100),level:4,tier:"自定义",discount:null,days:14,autoRenew:true,skus:skus.map(({safe,...sku})=>sku)});
        continue;
      }
      // 先尝试加权更高的超级档；如果它的实时申报价无法与已报活动
      // 保持安全价差，则依次退到高级、普通。任何档位都必须逐 SKU
      // 同时通过底线、日常价一致和活动价差校验。
      const availableTiers=options.compatibleTiers===true?tiers:tiers.filter(tier=>tier.level===3);
      const evaluated=availableTiers.map(tier=>{
        const skus=catalogSkus.map(sku=>{
          const fresh=quoteSkus.get(String(sku.skuId))||{},quotedPrice=money(fresh[tier.quoteField]);
          const activityPrices=[...(sku.activities||[]).map(activity=>money(activity.activity_price)),...(submittedBySkc.get(String(sku.skcId))||[])].filter(Boolean);
          const maxActivityPrice=activityPrices.length?Math.max(...activityPrices):null;
          const safe=Boolean(sku.floorEligible&&money(sku.floor)&&money(sku.declaredPrice)&&money(fresh.dailyPrice)&&quotedPrice&&
            cents(sku.declaredPrice)===cents(fresh.dailyPrice)&&cents(quotedPrice)>=cents(sku.floor)&&
            (!maxActivityPrice||activityFitsAccelerator(maxActivityPrice,quotedPrice)));
          return {skuId:String(sku.skuId),skcId:String(sku.skcId),dailyPrice:money(fresh.dailyPrice),quotedPrice,floor:money(sku.floor),maxActivityPrice,safe};
        });
        return {tier,skus,safe:skus.length>0&&skus.every(sku=>sku.safe)};
      });
      const selected=[...evaluated].reverse().find(item=>item.safe);
      if(!selected)continue;
      plans.push({spuId,siteId:Number(quote.siteId||100),level:selected.tier.level,tier:selected.tier.name,discount:Math.round(selected.tier.factor*100),days:14,autoRenew:true,skus:selected.skus.map(({safe,...sku})=>sku)});
    }
    return plans;
  }
  const api = {catalogProduct,productIssues,activeActivityIssues,activityFitsAccelerator,qualifyingOnlineActivity,minimumAcceleratorPrice,lowestActivityPrices,flowState,candidates,evaluateMatch,report,groupSpuPlans,acceleratorExecutionPlans};
  root.TemuPromotionAudit = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
