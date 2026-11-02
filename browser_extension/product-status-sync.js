/* Refresh only the logged-in shop's current product/enrollment snapshots.
 * Own inactive tab; read-only endpoints; no login or seller switching. */
const WB_PRODUCT_INTERVAL = 120 * 60000;
const wbProductHelper = tab => {
  try { const params=new URL(tab?.url || "").searchParams;return params.has("wb_product_status")||params.has("wb_auto_flow")||params.has("wb_accelerator_status"); } catch { return false; }
};
async function wbProductGuard(tabId, mall, name) {
  const tab = await chrome.tabs.get(tabId);
  if (!wbSellerUrl(tab.url)) throw Error("商品同步页面离开商家后台，已停止");
  const identity = await wbSellerIdentity(tab);
  if (String(identity.current_mall_id || "") !== mall) throw Error("商品同步店铺已变化，本批不保存");
  const checked = await wbAutoCall(tabId, "VERIFY_SELLER_SHOP", {mallId:mall,name});
  if (!checked.matches) throw Error("店铺正在切换或身份未确认，本批不保存");
  const manual = (await chrome.storage.local.get("temuCollectorState.v2"))["temuCollectorState.v2"];
  if (wbManualTaskBusy(manual)) throw Error("手动采集仍在运行，商品更新等待中");
  return tab;
}
async function wbProductWait(tabId, expectedUrl) {
  const expected = new URL(expectedUrl);
  for (let attempt = 0; attempt < 80; attempt++) {
    const tab = await chrome.tabs.get(tabId);
    const current = new URL(tab.url || "about:blank");
    if (current.origin !== expected.origin || current.pathname !== expected.pathname) {
      if (tab.status === "complete") throw Error("商品同步未进入预期页面，请检查登录状态");
    } else if (tab.status === "complete") {
      const response = await chrome.tabs.sendMessage(tabId, {type:"TEMU_COLLECT",command:"USER_INFO",payload:{},tabId,timeout:5000}).catch(() => null);
      if (response?.success && response.current_mall_id) return tab;
    }
    await new Promise(resolve => setTimeout(resolve,500));
  }
  throw Error("商品同步页面尚未就绪");
}
async function wbProductStatusTick(sourceTab, force=false, expectedMall="", onProgress=async()=>{}) {
  if (wbAutoRunning || globalThis.wbTrafficActive || !wbSellerUrl(sourceTab?.url) || wbProductHelper(sourceTab)) return {error:"已有采集任务或缺少当前店铺页面"};
  wbAutoRunning = true;
  let ownTabId = null, ownMarker = "", scopeKey = "", attemptMall = expectedMall;
  const report = async message => {
    await wbAutoWrite({message});
    await onProgress(message).catch(()=>{});
  };
  try {
    let state = await wbAutoRead();
    if (!force && (!state.enabled || Date.now() < Number(state.productRetryAt || 0))) return state;
    const manual = (await chrome.storage.local.get("temuCollectorState.v2"))["temuCollectorState.v2"];
    if (wbManualTaskBusy(manual)) throw Error("手动采集仍在运行，请先在采集面板停止任务");
    const identity = await wbSellerIdentity(sourceTab);
    const mall = String(identity.current_mall_id || "");
    attemptMall = mall;
    if (!/^\d+$/.test(mall) || (expectedMall && expectedMall !== mall)) throw Error("商品同步店铺与工作台选择不一致");
    await wbProductGuard(sourceTab.id,mall,identity.store_name || "");
    scopeKey = new URL(sourceTab.url).hostname + ":" + mall;
    if (!force && Date.now() - Number(state.scopes?.[scopeKey]?.productUpdatedAt || 0) < WB_PRODUCT_INTERVAL) return state;
    ownMarker = crypto.randomUUID();
    const origin = "https://agentseller.temu.com";
    const urlFor = path => origin + path + "?wb_product_status=" + ownMarker;
    const created = await chrome.tabs.create({url:urlFor("/goods/list"),active:false});
    ownTabId = created.id;
    await wbAutoWrite({productMallId:mall,productStartedAt:Date.now(),productError:"",error:""});
    const failures = [], summaries = [];
    for (const [command,path,dataset,label] of [
      ["PRODUCTS","/goods/list","products","在售商品"],
      ["ACTIVITIES","/activity/marketing-activity/log","activities","报名记录"]
    ]) {
      try {
        await report("正在采集"+label+"，请保持商家后台登录");
        if (command !== "PRODUCTS") await chrome.tabs.update(ownTabId,{url:urlFor(path),active:false});
        await wbProductWait(ownTabId,urlFor(path));
        await wbProductGuard(sourceTab.id,mall,identity.store_name || "");
        await wbProductGuard(ownTabId,mall,identity.store_name || "");
        const result = await wbAutoCall(ownTabId,command,{mallId:mall,requestHeaders:{mallid:mall}});
        await wbProductGuard(sourceTab.id,mall,identity.store_name || "");
        await wbProductGuard(ownTabId,mall,identity.store_name || "");
        if (String(result.sourceMallId || "") !== mall) throw Error("采集请求 mallid 不匹配，本批未保存");
        if (result.complete !== true) throw Error("分页未完整返回，保留上次完整状态");
        const meta = {source:"browser_extension",source_mall_id:mall,pages:result.pages,total:result.total,
          page_size:result.pageSize,complete:true,completion_reason:result.completionReason,source_url:origin+path,
          ...(dataset === "products" ? {sale_scope:"on_sale",collected_skc_count:result.collectedSkcs,
            category_coverage:result.categoryCoverage || null,
            category_diagnostics:result.categoryDiagnostics || null,
            category_taxonomies:Array.isArray(result.categoryTaxonomies) ? result.categoryTaxonomies : []} : {enrollment_scope:"all",enrollment_count:result.enrollmentCount})};
        await wbEnqueue({method:"POST",path:dataset === "products" ? "/api/client/products/upload" : "/api/client/products/activities/upload",
          body:{mall_id:mall,source_mall_id:mall,store_name:identity.store_name || "",rows:result.rows || [],crawl_result:meta}});
        const sync = await wbFlush();
        if (sync.pending) throw Error("结果已保存在扩展，待补传 "+sync.pending+" 批："+(sync.last_error||"本地服务暂未接收"));
        const coverage = dataset === "products" ? result.categoryCoverage : null;
        const categorySummary = dataset !== "products" ? "" : coverage && Number.isInteger(coverage.classifiedSkus) && Number.isInteger(coverage.skuCount) ?
          `；平台类目 ${coverage.classifiedSkus}/${coverage.skuCount} 个 SKU${coverage.classifiedSkus < coverage.skuCount ? "（类目待补采）" : ""}` : "；平台类目覆盖待核实";
        summaries.push(label+" "+result.total+" 条"+categorySummary);
        await report(label+"已同步（"+result.total+" 条）"+categorySummary);
      } catch (error) {
        failures.push(label+"："+String(error.message || error));
        await report(label+"未完成："+String(error.message || error));
      }
    }
    if (failures.length) throw Error([...summaries,...failures].join("；"));
    state = await wbAutoRead();
    const stamp = Date.now();
    await wbAutoWrite({scopes:{...state.scopes,[scopeKey]:{...state.scopes?.[scopeKey],productUpdatedAt:stamp}},
      productRetryAt:0,productError:"",error:"",finishedAt:stamp,productFinishedAt:stamp,
      message:summaries.join("；")+"；已同步本地"});
  } catch (error) {
    const message = String(error.message || error);
    await wbAutoWrite({productMallId:attemptMall,productRetryAt:Date.now()+WB_PRODUCT_INTERVAL,productError:message,
      error:force?message:"",message:"商品状态更新未完成："+message});
  } finally {
    if (ownTabId != null) {
      const tab = await chrome.tabs.get(ownTabId).catch(() => null);
      if (tab && new URL(tab.url || "about:blank").searchParams.get("wb_product_status") === ownMarker) await chrome.tabs.remove(ownTabId).catch(() => {});
    }
    wbAutoRunning = false;
  }
  return wbAutoRead();
}

// For every on-sale target, read membership in a complete bounded US growing set.
// User-confirmed rule: the growing badge means enabled; its absence means disabled.
async function wbAcceleratorStatusTick(sourceTab, force=false, expectedMall="", onProgress=async()=>{}) {
  if (wbAutoRunning || globalThis.wbTrafficActive || !wbSellerUrl(sourceTab?.url) || wbProductHelper(sourceTab)) return {error:"已有采集任务或缺少当前店铺页面"};
  wbAutoRunning=true;
  let ownTabId=null,marker="",mall=expectedMall;
  const report=async message=>{await wbAutoWrite({message});await Promise.resolve().then(()=>onProgress(message)).catch(()=>{})};
  try {
    let state=await wbAutoRead();
    if (!force && (!state.enabled || Date.now()<Number(state.acceleratorRetryAt||0))) return state;
    const identity=await wbSellerIdentity(sourceTab);
    mall=String(identity.current_mall_id||"");
    if (!/^\d+$/.test(mall) || expectedMall && expectedMall!==mall) throw Error("加速器采集店铺与工作台选择不一致");
    await wbProductGuard(sourceTab.id,mall,identity.store_name||"");
    const scopeKey="accelerators-us-catalog:"+mall;
    if (!force && Date.now()-Number(state.scopes?.[scopeKey]?.updatedAt||0)<WB_PRODUCT_INTERVAL) return state;
    const readTargets=async()=>{
      const response=await wbBridgeFetch(WORKBENCH_CONFIG.api+"/api/features/product-status/accelerator-targets?mall_id="+encodeURIComponent(mall),{signal:AbortSignal.timeout(15000)});
      const value=await response.json();
      if (!response.ok || value.success!==true) throw Error(value.error || "无法读取完整在售清单，请先更新商品");
      if(value.mallId!==mall || value.complete!==true || !value.catalogCaptured || !/^[a-f0-9]{64}$/.test(value.targetHash||"") ||
          !Array.isArray(value.spuIds) || !value.skcIdsBySpu || value.spuIds.some(id=>typeof id!=="string" || !/^\d+$/.test(id) || !Array.isArray(value.skcIdsBySpu[id]) || !value.skcIdsBySpu[id].length || value.skcIdsBySpu[id].some(skc=>typeof skc!=="string" || !/^\d+$/.test(skc))) || new Set(value.spuIds).size!==value.spuIds.length) throw Error("在售清单证据不完整，本轮未查询");
      return value;
    };
    const targets=await readTargets(),targetIds=new Set(targets.spuIds);
    marker=crypto.randomUUID();
    await wbAutoWrite({acceleratorMallId:mall,acceleratorError:"",acceleratorStartedAt:Date.now()});
    await report("正在核对全部在售商品的加速器：共 "+targetIds.size+" 个，按流量加速中标志判定开关");
    const url="https://agentseller-us.temu.com/main/flux-analysis?wb_accelerator_status="+marker;
    if(targetIds.size){const created=await chrome.tabs.create({url,active:false});ownTabId=created.id;await wbProductWait(ownTabId,url);}
    const guard=async()=>{
      const current=await wbAutoRead();
      if (!force && current.enabled===false) throw Error("自动更新已暂停");
      await wbProductGuard(sourceTab.id,mall,identity.store_name||"");
      if(ownTabId!=null){
        const owned=await wbProductGuard(ownTabId,mall,identity.store_name||"");
        if (new URL(owned.url).searchParams.get("wb_accelerator_status")!==marker) throw Error("加速器采集页面已变化，本轮停止");
      }
    };
    const observed=new Map();let pages=0,batches=0;
    for(let offset=0;offset<targets.spuIds.length;offset+=20){
      await guard();
      const productIds=targets.spuIds.slice(offset,offset+20),batchIds=new Set(productIds);
      const result=await wbAutoCall(ownTabId,"ACCELERATORS_QUERY",{mallId:mall,marker,productIds,includeTrafficAttention:true,skcIdsBySpu:Object.fromEntries(productIds.map(id=>[id,targets.skcIdsBySpu[id]]))});
      await guard();
      if(result.success!==true || String(result.sourceMallId||"")!==mall || result.complete!==true || result.stateRule!=="flow_grow_badge_v1" || !Array.isArray(result.rows)) throw Error("原生加速器查询未完整返回同店铺标志核对结果");
      if(result.trafficAttentionRule!=="temu_native_flow_limit_v1" || !Number.isSafeInteger(result.trafficAttentionRows) || result.trafficAttentionRows<0 || result.trafficAttentionRows>productIds.length ||
          !Number.isSafeInteger(result.trafficAttentionKnown) || result.trafficAttentionKnown<0 || result.trafficAttentionKnown>result.trafficAttentionRows) throw Error("流量待关注查询器版本或覆盖证据不完整，请刷新商家后台后再更新");
      const returned=new Set(),rows=[];
      for(const row of result.rows){
        const id=String(row.spuId||"");
        if(!batchIds.has(id) || row.siteName!=="美国站" || returned.has(id) || !["enabled","disabled"].includes(row.status)) throw Error("加速器标志核对返回了清单外、重复、状态不明或站点不符的商品");
        if(!["trafficAttention","flowLimitStatus","trafficAttentionSource","trafficAttentionLabel"].every(field=>Object.hasOwn(row,field)))throw Error("流量待关注查询缺少原生标记字段，本批未保存");
        if(row.trafficAttention===null){
          if(row.flowLimitStatus!==null || row.trafficAttentionSource!=="" || row.trafficAttentionLabel!=="")throw Error("未知流量待关注标记证据不一致");
        }else if(typeof row.trafficAttention!=="boolean" || !Number.isInteger(row.flowLimitStatus) || ![0,1,2,3].includes(row.flowLimitStatus) || row.trafficAttention!==(row.flowLimitStatus===2) ||
            row.trafficAttentionSource!=="temu_native_flow_limit_v1" || typeof row.trafficAttentionLabel!=="string" || !row.trafficAttentionLabel || row.trafficAttentionLabel.length>100){
          throw Error("流量待关注原生标记和状态不一致，本批未保存");
        }
        returned.add(id);rows.push(row);
      }
      // Only the query module can certify the complete growing set and its complement.
      // A missing output row is an incomplete result, never an implicit disabled state.
      if(returned.size!==productIds.length)throw Error("加速器标志核对缺少目标商品，本批未保存");
      if(rows.filter(row=>typeof row.trafficAttention==="boolean").length!==result.trafficAttentionKnown)throw Error("流量待关注已确认数量与原生行证据不一致，本批未保存");
      const enabledCount=rows.filter(row=>row.status==="enabled").length;
      if(!Number.isSafeInteger(result.rawCount) || !Number.isSafeInteger(result.total) || result.total<0 || result.total>productIds.length || result.rawCount!==result.total || enabledCount!==result.total || result.pages!==1)throw Error("加速器标志集合条数或分页证据不一致，本批未保存");
      for(const row of rows)observed.set(row.spuId,row.status);
      pages+=Number(result.pages)||1;batches++;
      await guard();
      await wbEnqueue({method:"POST",path:"/api/client/products/accelerators/upload",body:{
        mall_id:mall,source_mall_id:mall,store_name:identity.store_name||"",rows,
        crawl_result:{source:"native_flow_catalog_query",source_mall_id:mall,complete:false,scan_id:marker,
          catalog_captured:targets.catalogCaptured,target_hash:targets.targetHash,target_count:targetIds.size,
          batch:batches,batch_target_count:productIds.length,raw_count:result.rawCount,total:result.total,pages:result.pages,detail_queries:result.detailRequests||0,diagnostics:result.diagnostics||[],
          state_rule:result.stateRule,traffic_attention_rule:result.trafficAttentionRule||null,
          traffic_attention_rows:result.trafficAttentionRows??null,traffic_attention_known:result.trafficAttentionKnown??null,
          source_url:"https://agentseller-us.temu.com/main/flux-analysis"}
      }});
      const sync=await wbFlush();
      if(sync.pending)throw Error("加速器状态已保存在扩展，待补传 "+sync.pending+" 批");
      const enabled=[...observed.values()].filter(value=>value==="enabled").length,disabled=[...observed.values()].filter(value=>value==="disabled").length;
      await report("全部在售加速器已查询 "+observed.size+" / "+targetIds.size+"：已开启 "+enabled+"，未开启 "+disabled+"，待确认 "+(observed.size-enabled-disabled));
      if(offset+20<targets.spuIds.length)await new Promise(resolve=>setTimeout(resolve,350));
    }
    await guard();
    const currentTargets=await readTargets();
    if(currentTargets.targetHash!==targets.targetHash)throw Error("采集期间在售清单已变化，请重新更新；本轮观察已保留");
    const enabled=[...observed.values()].filter(value=>value==="enabled").length,disabled=[...observed.values()].filter(value=>value==="disabled").length;
    const unknownIds=targets.spuIds.filter(id=>!["enabled","disabled"].includes(observed.get(id)));
    const coverage="全部在售 "+targetIds.size+"：已开启 "+enabled+"，未开启 "+disabled+"，待确认 "+unknownIds.length;
    await wbAutoWrite({acceleratorResult:{rows:observed.size,pages,batches,coverage,enabled,disabled,unknown:unknownIds.length,unknownIds,
      scanId:marker,targetCount:targetIds.size,targetHash:targets.targetHash,catalogCaptured:targets.catalogCaptured,stateRule:"flow_grow_badge_v1"}});
    if(unknownIds.length)throw Error(coverage+"；平台未明确返回的商品保留待确认，不视为未开启");
    state=await wbAutoRead();const stamp=Date.now();
    await wbAutoWrite({scopes:{...state.scopes,[scopeKey]:{updatedAt:stamp}},acceleratorRetryAt:0,acceleratorMallId:mall,
      acceleratorFinishedAt:stamp,acceleratorError:"",message:"加速器已完成核对 · "+coverage+"（美国站）"});
  }catch(error){
    const message=String(error.message||error);
    await wbAutoWrite({acceleratorMallId:mall,acceleratorRetryAt:Date.now()+WB_PRODUCT_INTERVAL,acceleratorError:message,message:"加速器更新未完成："+message});
  }finally{
    if(ownTabId!=null){
      const owned=await chrome.tabs.get(ownTabId).catch(()=>null);
      if(owned && new URL(owned.url||"about:blank").searchParams.get("wb_accelerator_status")===marker)await chrome.tabs.remove(ownTabId).catch(()=>{});
    }
    wbAutoRunning=false;
  }
  return wbAutoRead();
}
