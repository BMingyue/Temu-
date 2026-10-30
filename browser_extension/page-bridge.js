(() => {
  if (window.__TEMU_DASHBOARD_BRIDGE__) return;
  window.__TEMU_DASHBOARD_BRIDGE__ = true;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let activeRequestId = "";

  // Activity candidate lists are virtualized: older rows disappear from the
  // DOM when later batches arrive. Preserve each same-page JSON response at
  // network time so read-only evidence does not depend on recycled elements.
  const activityResponses = [];
  const activityResponseDiagnostics = [];
  const activityPage = () => location.pathname === "/activity/marketing-activity/detail-new";
  const activityRequestUrl = (value) => {
    try {
      const url = new URL(String(value || ""), location.href);
      return url.origin === location.origin && /(?:activity|marketing|thematic|gamblers|enroll|candidate|product|goods|spu|skc|sku)/i.test(url.pathname);
    } catch { return false; }
  };
  const parseJsonValue = (value) => {
    if (value == null || value === "") return null;
    if (typeof value === "object") return value;
    try { return JSON.parse(String(value)); } catch { return null; }
  };
  const firstValue = (object, keys) => {
    for (const key of keys) if (object?.[key] != null && object[key] !== "") return object[key];
    return null;
  };
  const networkId = (object, keys) => {
    const value = firstValue(object, keys);
    return /^\d{5,}$/.test(String(value ?? "").trim()) ? String(value).trim() : "";
  };
  const networkSpec = (object) => {
    const direct = firstValue(object, ["specification","specName","skuSpec","spec","specText","propertyText","variationName","variantName"]);
    if (direct != null && String(direct).trim()) return String(direct).replace(/\s+/g," ").trim();
    const properties = object?.properties ?? object?.propertyList ?? object?.skuProperties;
    if (Array.isArray(properties)) return properties.map((item) => firstValue(item,["value","valueName","propertyValue","name","text"])).filter(Boolean).join(" / ");
    if (properties && typeof properties === "object") return Object.values(properties).map(String).filter(Boolean).join(" / ");
    return "";
  };
  const networkPrice = (object, keys) => {
    let value = firstValue(object, keys);
    if (value && typeof value === "object") value = firstValue(value,["amount","value","price","cent","cents"]);
    if (value == null || typeof value === 'boolean' || String(value).trim() === '') return null;
    const number = Number(String(value).replace(/,/g,''));
    if (!Number.isFinite(number) || number < 0) return null;
    // Unit semantics are endpoint-specific. Preserve the observed number;
    // this diagnostic extractor must not guess cents from its magnitude.
    return number;
  };
  const extractActivityNetworkCandidates = (payload) => {
    const candidates = [], seen = new Set(), visited = new WeakSet();
    const walk = (value, context = {}, depth = 0) => {
      if (!value || depth > 14) return;
      if (typeof value !== "object") return;
      if (visited.has(value)) return;
      visited.add(value);
      if (Array.isArray(value)) { for (const item of value) walk(item, context, depth + 1); return; }
      const ownSkuId = networkId(value,["skuId","productSkuId","goodsSkuId"]);
      const ownSpecification = networkSpec(value);
      const ownSkuCode = String(firstValue(value,["skuCode","extCode","outerSkuCode","merchantSkuCode"]) || "").trim();
      const next = {
        spuId:networkId(value,["spuId","productId","productSpuId","goodsId"]) || context.spuId || "",
        skcId:networkId(value,["skcId","productSkcId","goodsSkcId"]) || context.skcId || "",
        skuId:ownSkuId || context.skuId || "",
        specification:ownSpecification || context.specification || "",
        skuCode:ownSkuCode || context.skuCode || "",
      };
      const dailyPrice = networkPrice(value,["dailyPrice","supplierPrice","dailySupplierPrice","originPrice","originalPrice","marketPrice","price"]);
      const referenceActivityPrice = networkPrice(value,["referenceActivityPrice","referencePrice","activityPrice","suggestPrice","recommendedPrice","promotionPrice"]);
      if (next.spuId && (next.skuId || next.specification) && dailyPrice != null) {
        const row = {spuId:next.spuId,skcId:next.skcId,skuId:next.skuId,skuCode:next.skuCode,specification:next.specification || next.skuCode || `SKU ${next.skuId}`,dailyPrice,referenceActivityPrice,referenceStock:null,salesStock:null,eligible:null,identityOnly:true,candidateStatus:"未验证接口字段与价格单位，仅供诊断",adjustable:null,source:"temu_activity_network_batch"};
        const key = row.skuId ? `sku:${row.skuId}` : [row.spuId,row.skcId,row.skuCode,row.specification,row.dailyPrice].join("|");
        if (!seen.has(key)) { seen.add(key); candidates.push(row); }
      }
      for (const child of Object.values(value)) if (child && typeof child === "object") walk(child, next, depth + 1);
    };
    walk(payload);
    return candidates;
  };
  const rememberActivityResponse = (url, requestBody, responseBody) => {
    if (!activityPage() || !activityRequestUrl(url) || !responseBody || typeof responseBody !== "object") return;
    const pathname = new URL(String(url),location.href).pathname;
    const candidates = extractActivityNetworkCandidates(responseBody);
    const diagnostic = {url:pathname,candidateCount:candidates.length,topKeys:Object.keys(responseBody).slice(0,20),capturedAt:Date.now()};
    activityResponseDiagnostics.push(diagnostic);
    if (activityResponseDiagnostics.length > 160) activityResponseDiagnostics.splice(0, activityResponseDiagnostics.length - 160);
    if (!candidates.length) return;
    activityResponses.push({url:pathname, requestBody:parseJsonValue(requestBody), candidates, capturedAt:diagnostic.capturedAt});
    if (activityResponses.length > 160) activityResponses.splice(0, activityResponses.length - 160);
  };
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async function activityAwareFetch(input, init) {
    const url = typeof input === "string" || input instanceof URL ? String(input) : String(input?.url || "");
    let requestBody = init?.body ?? null;
    if (requestBody == null && typeof Request !== "undefined" && input instanceof Request) {
      try { requestBody = await input.clone().text(); } catch {}
    }
    const response = await nativeFetch(input, init);
    if (activityPage() && activityRequestUrl(url)) {
      response.clone().text().then((text) => rememberActivityResponse(url, requestBody, parseJsonValue(text))).catch(() => {});
    }
    return response;
  };
  const xhrMeta = new WeakMap(), nativeXhrOpen = XMLHttpRequest.prototype.open, nativeXhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    xhrMeta.set(this, {method:String(method || "GET"), url:String(url || ""), body:null});
    return nativeXhrOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function(body) {
    const meta = xhrMeta.get(this) || {url:""};
    meta.body = body;
    xhrMeta.set(this, meta);
    if (activityPage() && activityRequestUrl(meta.url)) this.addEventListener("loadend", () => {
      let value = null;
      try { value = this.responseType === "json" ? this.response : parseJsonValue(this.responseText); } catch {}
      rememberActivityResponse(meta.url, meta.body, value);
    }, {once:true});
    return nativeXhrSend.call(this, body);
  };
  const progress = (detail) => window.postMessage({source:"temu-dashboard-page", id:activeRequestId, progress:detail}, "*");
  const technicalRequestInfo = ({status = 0, errorCode = NaN, url = ""} = {}) => {
    const parts = [];
    if (Number(status) > 0) parts.push(`Temu HTTP ${Number(status)}`);
    try { if (url) parts.push(new URL(String(url), location.origin).pathname); } catch {}
    if (Number.isFinite(Number(errorCode))) parts.push(`错误码 ${Number(errorCode)}`);
    return parts.join(" · ");
  };
  const errorWithTechnicalInfo = (message, technicalInfo = "") => {
    const error = new Error(message);
    error.technicalInfo = String(technicalInfo || "");
    return error;
  };
  const friendlyTemuError = ({status = NaN, errorCode = NaN, errorMessage = "", fallback = ""} = {}) => {
    const raw = String(errorMessage || fallback || "");
    if (/invalid login state|not logged|login.*expired|登录.*(失效|异常|过期|无效)/i.test(raw) || Number(errorCode) === 40001) return "Temu 账号未登录或登录已失效，请重新登录";
    if (/no permission|permission denied|forbidden|无权限|没有权限/i.test(raw) || Number(errorCode) === 400020037 || Number(status) === 403) return "当前 Temu 账号没有权限访问这项数据";
    if (/too many visitors/i.test(raw) || Number(status) === 429) return "Temu 当前访问人数过多，请稍后继续任务";
    if (/network timeout|try again later|failed to fetch|networkerror|load failed|网络/i.test(raw) || Number(errorCode) === 40002 || (Number.isFinite(Number(status)) && Number(status) === 0)) return "网络连接异常或 Temu 接口繁忙，请稍后重试";
    if (Number(status) === 401) return "Temu 账号未登录或登录已失效，请重新登录";
    if (Number(status) === 404) return "Temu 页面接口已变化，请刷新页面后重试";
    if (Number(status) >= 500) return "Temu 服务暂时异常，请稍后重试";
    return raw && !/^\d{3}\b/.test(raw) && !/^\s*[\[{]/.test(raw) ? raw : "Temu 数据请求失败，请刷新页面后重试";
  };
  const jsonFetch = async (url, options = {}, requestContext = {}) => {
    const retryDelays = [5000, 10000, 20000, 30000, 45000];
    const visitorRetryDelays = [30000, 60000];
    let lastError = "";
    let lastTechnicalInfo = "";
    for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
      let visitorLimited = false;
      try {
        const startedAt = performance.now();
        const response = await fetch(url, {credentials: "include", ...options});
        const text = await response.text();
        progress({stage:"network", metric:{url:String(url).split("?")[0], bytes:new TextEncoder().encode(text).length, durationMs:performance.now() - startedAt}});
        let data = null;
        try { data = JSON.parse(text); } catch {}
        const errorCode = Number(data?.error_code ?? data?.errorCode);
        const errorMessage = String(data?.error_msg || data?.errorMsg || "");
        visitorLimited = response.status === 429 || /too many visitors/i.test(errorMessage);
        const transient = response.status === 429 || errorCode === 40002 || /network timeout|try again later|操作太快/i.test(errorMessage);
        if (response.ok && data && !transient) return data;
        lastError = friendlyTemuError({status:response.status,errorCode,errorMessage,fallback:text.slice(0,300)});
        lastTechnicalInfo = technicalRequestInfo({status:response.status,errorCode,url});
        requestContext.lastReason = lastError;
        if (!transient || (visitorLimited ? attempt >= visitorRetryDelays.length : attempt >= retryDelays.length)) throw errorWithTechnicalInfo(lastError,lastTechnicalInfo);
      } catch (error) {
        const rawError = String(error?.message || error);
        visitorLimited ||= /429|too many visitors/i.test(rawError);
        const transient = /429|40002|network timeout|try again later|操作太快|failed to fetch|networkerror|load failed/i.test(rawError);
        lastError = friendlyTemuError({errorMessage:rawError,fallback:rawError});
        lastTechnicalInfo = String(error?.technicalInfo || lastTechnicalInfo || "");
        if (!transient || (visitorLimited ? attempt >= visitorRetryDelays.length : attempt >= retryDelays.length)) throw errorWithTechnicalInfo(lastError,lastTechnicalInfo);
      }
      const delays = visitorLimited ? visitorRetryDelays : retryDelays;
      const waitMs = delays[attempt];
      const target = requestContext.label ? `${requestContext.label}：` : "";
      const reason = String(requestContext.lastReason || "Temu 接口临时繁忙").slice(0, 100);
      progress({stage:"retry", message:`${target}${reason}，${Math.round(waitMs / 1000)} 秒后第 ${attempt + 2} 次重试`, current:attempt + 1, total:delays.length + 1, waitMs, url:String(url), reason});
      await sleep(waitMs);
    }
    throw errorWithTechnicalInfo(lastError || "Temu 数据请求失败，请刷新页面后重试",lastTechnicalInfo);
  };
  const post = (url, body, requestHeaders = {}, requestContext = {}) => jsonFetch(url, {method: "POST", headers: {...requestHeaders, accept: "application/json, text/plain, */*", "content-type": "application/json;charset=UTF-8"}, body: JSON.stringify(body || {})}, requestContext);

  function normalizeShops(payload) {
    const list = payload?.result?.mallList || [];
    return list.filter((item) => !(String(item.managedType) === "0" && String(item.mallMode) === "0")).map((item) => ({mall_id: String(item.mallId || ""), name: String(item.mallName || "")})).filter((item) => item.mall_id && item.name);
  }
  async function userInfo() {
    const data = await post("/api/seller/auth/userInfo", {});
    if (data.success !== true) throw new Error(data.errorMsg || "Temu 登录状态无效");
    return {success: true, shops: normalizeShops(data), current_mall_id: (document.cookie.match(/(?:^|;\s*)mallid=([^;]+)/) || [])[1] || ""};
  }
  const adsCookieValue = (name) => {
    const safe=String(name).replace(/[.*+?^${}()|[\]\\]/g,"\\$&"),match=document.cookie.match(new RegExp(`(?:^|;\\s*)${safe}=([^;]*)`));
    try{return decodeURIComponent(match?.[1]||"")}catch{return String(match?.[1]||"")}
  };
  const adsCurrentRegionText = () => [...document.querySelectorAll("button,[role='button'],header,nav,div,span")]
    .filter(element=>element.offsetParent!==null)
    .map(element=>String(element.innerText||element.textContent||"").replace(/\s+/g," ").trim())
    .find(text=>/^当前区域\s*[:：]/.test(text)&&text.length<80)||"";
  const adsUsRegionSelected = () => {
    const regionText=adsCurrentRegionText();
    if(regionText)return /^当前区域\s*[:：].*美国/.test(regionText)&&!/全球|欧区|除美国/.test(regionText);
    return Number(adsCookieValue("ad_area"))===1&&Number(adsCookieValue("ad_site"))===100;
  };
  async function adsAuthStatus({expectedMallIds = []} = {}) {
    const data = await post("/api/v1/coconut/mall/query_mall_detail?is_back=1", {});
    if (data.success !== true || !data?.result?.mall_id) throw new Error(data.error_msg || "广告平台尚未登录");
    const mallId = String(data.result.mall_id);
    const mallName = String(data.result.mall_name || "");
    const mallType = Number(data.result.mall_type || 2);
    let shops = [{mall_id:mallId, name:mallName}];
    try {
      const listData = await post(`/api/v1/coconut/account/mall_list?mallType=${mallType}&is_back=1`, {mall_type:mallType});
      const list = listData?.result?.query_mall_detail_resp_dtolist || [];
      const discovered = list.map((item)=>({mall_id:String(item.mall_id || ""),name:String(item.mall_name || "")})).filter((item)=>item.mall_id);
      if(discovered.length)shops=discovered;
    } catch {}
    const expected = new Set((expectedMallIds || []).map((value) => String(value || "").trim()).filter(Boolean));
    return {
      success: true,
      mallId,
      mallName,
      shops,
      siteId:Number(adsCookieValue("ad_site"))||null,
      regionText:adsCurrentRegionText(),
      usRegionSelected:adsUsRegionSelected(),
      accountMatches: expected.size ? expected.has(mallId) : null,
    };
  }
  function productRowsFromPayload(data) {
    const preferred = ["pageItems", "records", "items", "list", "dataList", "skcList", "productList"];
    const seen = new Set();
    const visit = (value, depth = 0) => {
      if (!value || depth > 5 || seen.has(value)) return [];
      if (typeof value === "object") seen.add(value);
      if (Array.isArray(value)) {
        if (value.length && value.every((item) => item && typeof item === "object")) return value;
        return [];
      }
      if (typeof value !== "object") return [];
      for (const key of preferred) {
        const found = visit(value[key], depth + 1);
        if (found.length) return found;
      }
      for (const valueItem of Object.values(value)) {
        const found = visit(valueItem, depth + 1);
        if (found.length) return found;
      }
      return [];
    };
    return visit(data);
  }
  const hasProductList = (value,depth=0) => {
    if (!value || depth > 5 || typeof value !== "object" || Array.isArray(value)) return false;
    if (["pageItems","records","items","list","dataList","skcList","productList"].some(key => Array.isArray(value[key]))) return true;
    return Object.values(value).some(child => hasProductList(child,depth+1));
  };
  const productTotalFromPayload = (data) => {
    const visit = (value, depth = 0) => {
      if (!value || depth > 5 || typeof value !== "object") return 0;
      if (Array.isArray(value)) return 0;
      for (const key of ["total", "totalCount", "totalNum", "recordCount", "count"]) {
        const n = Number(value[key]);
        if (Number.isFinite(n) && n > 0) return n;
      }
      for (const child of Object.values(value)) { const n = visit(child, depth + 1); if (n) return n; }
      return 0;
    };
    return visit(data);
  };
  const skuClassificationLabel = (value) => ({1:"单品",2:"混装",3:"组合装"})[Number(value)] || (value == null ? "" : String(value));
  const declaredPrice = (sku) => {
    const sitePrice = (Array.isArray(sku?.siteSupplierPrices) ? sku.siteSupplierPrices : []).find((item) => item?.supplierPrice != null)?.supplierPrice;
    const cents = sku?.supplierPrice ?? sitePrice;
    if (cents == null || cents === '') return null;
    const amount = Number(cents);
    return Number.isFinite(amount) ? amount / 100 : null;
  };
  const compactProductRows = (pageRows) => pageRows.flatMap((product) => {
    const skus = Array.isArray(product?.productSkuSummaries) ? product.productSkuSummaries : [];
    const base = {
      spuId:String(product?.productId || ""),
      skcId:String(product?.productSkcId || ""),
      imageUrl:String(product?.mainImageUrl || ""),
      onSale:true, lifecycleStatus:"已发布到站点", saleStatusSource:"skcTopStatus:100", currency:"CNY",
    };
    if (!skus.length) return [{...base, skuId:"", skuCode:"", declaredPrice:null, skuCategory:""}];
    return skus.map((sku) => ({
      ...base,
      skuId:String(sku?.productSkuId || ""),
      skuCode:String(sku?.extCode || ""),
      imageUrl:String(sku?.thumbUrl || base.imageUrl),
      declaredPrice:declaredPrice(sku),
      skuCategory:skuClassificationLabel(sku?.productSkuMultiPack?.skuClassification),
      properties:sku?.properties && typeof sku.properties === "object" ? sku.properties : {},
      specification:networkSpec(sku),
      priceAdjustable:typeof sku?.priceAdjustable === "boolean" ? sku.priceAdjustable : null,
    }));
  });
  async function products({requestHeaders = {}, capturedMallId = "", pageSize = 100} = {}) {
    const rows = [];
    let page = 1;
    let total = 0;
    let collectedSkcs = 0;
    let complete = false;
    let completionReason = "page_limit";
    while (page <= 100) {
      const data = await post("/visage-agent-seller/product/skc/pageQuery", {page, pageSize, skcTopStatus:100}, requestHeaders, {label:`在售商品第 ${page} 页`});
      if (data?.success !== true) throw new Error(data?.errorMsg || "商品接口未确认成功，保留上次状态");
      const pageRows = productRowsFromPayload(data);
      if (pageRows.some(item => !item?.productId || !item?.productSkcId)) throw new Error("商品接口结构已变化，保留上次状态");
      if (!pageRows.length && (!hasProductList(data) || !/"(?:total|totalCount|totalNum|recordCount|count)":0(?:[,}])/.test(JSON.stringify(data)))) throw new Error("商品空列表缺少零总数证明，保留上次状态");
      total = Math.max(total, productTotalFromPayload(data));
      collectedSkcs += pageRows.length;
      rows.push(...compactProductRows(pageRows));
      progress({stage:"products", message:`在售商品：已采集 ${collectedSkcs}${total ? ` / ${total}` : ""} 个 SKC，展开 ${rows.length} 个 SKU`, current:page, total:total ? Math.ceil(total / pageSize) : Math.max(page, 1), rows:rows.length});
      if (!pageRows.length) {
        complete = !total || collectedSkcs >= total;
        completionReason = total ? "empty_page_after_total" : "empty_catalog";
        break;
      }
      if (pageRows.length < pageSize) {
        complete = !total || collectedSkcs >= total;
        completionReason = "short_final_page";
        break;
      }
      if (total && collectedSkcs >= total) {
        complete = true;
        completionReason = "reported_total_reached";
        break;
      }
      page += 1;
    }
    return {success:true, rows, pages:page, total:total || collectedSkcs, collectedSkcs, pageSize, complete, completionReason, sourceMallId:String(capturedMallId || "")};
  }
  const centsPrice = (value) => {
    if (value == null || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number / 100 : null;
  };
  const compactActivityRows = (enrollments) => enrollments.flatMap((enrollment) => {
    const cancelReviewStatus = enrollment?.cancelApplyInfo?.reviewStatus ?? null;
    // Preserve exited records so the complete enrollment count remains auditable.
    const session = (Array.isArray(enrollment?.assignSessionList) ? enrollment.assignSessionList : []).find((item) => Number(item?.sessionStatus) === 2) || enrollment?.assignSessionList?.[0] || {};
    const shared = {
      enrollId:String(enrollment?.enrollId || ""),
      spuId:String(enrollment?.productId || ""),
      activityType:String(enrollment?.activityType || ""),
      activityTypeName:String(enrollment?.activityTypeName || ""),
      activityName:String(enrollment?.activityThematicName || ""),
      statusKey:Number(cancelReviewStatus) === 3 ? "cancelled" : Number(cancelReviewStatus) === 1 ? "exit_review" : Number(enrollment?.sessionStatus) === 2 ? "active" : "unknown",
      sessionStatus:enrollment?.sessionStatus ?? null,
      sessionStatusTag:enrollment?.sessionStatusTag ?? null,
      cancelReviewStatus,
      sessionStartTime:session?.startTime ?? enrollment?.sessionStartTime ?? null,
      sessionEndTime:session?.endTime ?? enrollment?.sessionEndTime ?? null,
      enrollTime:enrollment?.enrollTime ?? null,
      activityStock:enrollment?.activityStock ?? null,
      remainingStock:enrollment?.remainingActivityStock ?? null,
      currency:String(enrollment?.currency || "CNY"),
    };
    return (Array.isArray(enrollment?.skcList) ? enrollment.skcList : []).flatMap((skc) =>
      (Array.isArray(skc?.skuList) ? skc.skuList : []).flatMap((sku) => {
        const sitePrices = Array.isArray(sku?.sitePriceList) && sku.sitePriceList.length ? sku.sitePriceList : [{
          siteId:enrollment?.sites?.[0]?.siteId,
          siteName:enrollment?.sites?.[0]?.siteName,
          dailyPrice:sku?.dailyPrice ?? skc?.dailyPrice,
          activityPrice:sku?.activityPrice ?? skc?.activityPrice,
        }];
        return sitePrices.map((site) => {
          const dailyPrice = centsPrice(site?.dailyPrice ?? sku?.dailyPrice ?? skc?.dailyPrice);
          const activityPrice = centsPrice(site?.activityPrice ?? sku?.activityPrice ?? skc?.activityPrice);
          return {
            ...shared,
            skcId:String(skc?.skcId || ""),
            skuId:String(sku?.skuId || ""),
            skuCode:String(sku?.extCode || ""),
            siteId:String(site?.siteId ?? enrollment?.sites?.[0]?.siteId ?? ""),
            siteName:String(site?.siteName || enrollment?.sites?.[0]?.siteName || ""),
            dailyPrice,
            activityPrice,
            discountRate:dailyPrice > 0 && activityPrice != null ? activityPrice / dailyPrice * 100 : null,
            properties:sku?.properties && typeof sku.properties === "object" ? sku.properties : {},
          };
        });
      })
    );
  });
  async function activities({requestHeaders = {}, capturedMallId = "", pageSize = 50} = {}) {
    const rows = [];
    let pageNo = 1;
    const limit = Math.max(1, Math.min(50, Number(pageSize) || 50));
    const seen = new Set();
    let total = 0;
    let enrollmentCount = 0;
    let complete = false;
    let completionReason = "page_limit";
    while (pageNo <= 100) {
      const data = await post("/api/kiana/gamblers/marketing/enroll/list", {pageNo, pageSize:limit}, requestHeaders, {label:`活动报名第 ${pageNo} 页`});
      if (data?.success !== true || !Array.isArray(data?.result?.list) || data.result.total == null || !Number.isFinite(Number(data.result.total))) throw new Error(data?.errorMsg || "活动接口未返回完整列表结构，保留上次状态");
      const list = data.result.list;
      const reported = Number(data.result.total);
      if (reported < 0 || !Number.isInteger(reported) || (pageNo > 1 && reported !== total)) throw new Error("报名记录总数变化，本批未确认为完整");
      total = reported;
      for (const entry of list) {
        const id = String(entry?.enrollId || "");
        if (!/^\d+$/.test(id) || seen.has(id)) throw new Error("报名记录标识缺失或分页重复，保留上次状态");
        seen.add(id);
      }
      enrollmentCount += list.length;
      rows.push(...compactActivityRows(list));
      progress({stage:"activities", message:`活动报名：已采集 ${enrollmentCount}${total ? ` / ${total}` : ""} 条，展开 ${rows.length} 个 SKU 价格`, current:pageNo, total:total ? Math.ceil(total / limit) : pageNo, rows:rows.length});
      if (!list.length) {
        complete = !total || enrollmentCount >= total;
        completionReason = total ? "empty_page_after_total" : "empty_catalog";
        break;
      }
      if (list.length < limit) {
        complete = !total || enrollmentCount >= total;
        completionReason = "short_final_page";
        break;
      }
      if (total && enrollmentCount >= total) {
        complete = true;
        completionReason = "reported_total_reached";
        break;
      }
      pageNo += 1;
      await sleep(1300);
    }
    const represented = new Set(rows.filter(row=>row.skuId).map(row=>row.enrollId));
    if (represented.size !== seen.size) throw new Error("部分报名记录未返回 SKU 明细，保留上次完整状态");
    if (enrollmentCount !== total) complete = false;
    return {success:true, rows, pages:pageNo, total, enrollmentCount, pageSize:limit, complete, completionReason, sourceMallId:String(capturedMallId || "")};
  }
  const cleanShopName = (value) => String(value || "").replace(/\s+/g, " ").replace(/(?:\s*当前店铺\s*)+$/g, "").replace(/(?:\s*半托管店铺\s*)+$/g, "").trim();
  const sameShopName = (left, right) => cleanShopName(left).toLocaleLowerCase() === cleanShopName(right).toLocaleLowerCase();
  const currentMallId = () => (document.cookie.match(/(?:^|;\s*)mallid=([^;]+)/) || [])[1] || "";
  function currentShopName() {
    const selectors = [
      '[class*="account-info_accountInfo"] [class*="elli_outerWrapper"]',
      '[class*="account-info_accountInfo"]'
    ];
    for (const selector of selectors) {
      const node = document.querySelector(selector);
      const value = cleanShopName(node?.innerText || node?.textContent || "");
      if (value) return value;
    }
    const candidates = Array.from(document.querySelectorAll("div, span")).filter((element) => {
      const rect = element.getBoundingClientRect();
      const value = cleanShopName(element.innerText || element.textContent || "");
      return rect.width > 40 && rect.width < 320 && rect.height > 16 && rect.height < 90 && rect.top < 120 && rect.right > window.innerWidth * 0.7 && value.length > 1 && value.length < 100 && Boolean(element.querySelector('svg[data-testid="beast-core-icon-down"]'));
    }).sort((left, right) => {
      const a = left.getBoundingClientRect(), b = right.getBoundingClientRect();
      return a.width * a.height - b.width * b.height;
    });
    return cleanShopName(candidates[0]?.innerText || candidates[0]?.textContent || "");
  }
  const visible = (element) => {
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  };
  const fireClick = (element) => {
    element.scrollIntoView({block:"center", inline:"center"});
    element.dispatchEvent(new MouseEvent("mousedown", {bubbles:true, cancelable:true, view:window}));
    element.dispatchEvent(new MouseEvent("mouseup", {bubbles:true, cancelable:true, view:window}));
    element.click();
  };
  const exactText = (element) => String(element?.innerText || element?.textContent || "").replace(/\s+/g, " ").trim();
  function visibleTextAction(root, label) {
    if (!root) return null;
    return Array.from(root.querySelectorAll("button, [role='button'], div, span"))
      .filter((element) => visible(element) && exactText(element) === label)
      .sort((left, right) => {
        const a = left.getBoundingClientRect(), b = right.getBoundingClientRect();
        return a.width * a.height - b.width * b.height;
      })[0] || null;
  }
  async function openSellerAccountMenu(accountMenu) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const existing = document.querySelector('[class*="account-info_mainMall"]');
      if (visible(existing)) return existing;
      fireClick(accountMenu);
      await sleep(700);
      const opened = document.querySelector('[class*="account-info_mainMall"]');
      if (visible(opened)) return opened;
      // Temu 的消息、规则中心等弹层打开时，第一次点击账号区只会关闭旧弹层。
      // 发送 Escape 后再点一次真实账号 DOM，不使用坐标定位。
      document.dispatchEvent(new KeyboardEvent("keydown", {key:"Escape", code:"Escape", keyCode:27, which:27, bubbles:true}));
      await sleep(250);
    }
    return null;
  }
  async function switchSellerShop({name}) {
    const targetName = cleanShopName(name);
    if (!targetName) throw new Error("目标店铺名称为空");
    const before = currentShopName();
    if (sameShopName(before, targetName)) return {success:true, currentShop:before, alreadyActive:true};

    let root = document.querySelector('[class*="account-info_changeModal"]');
    if (!visible(root)) {
      const accountMenu = document.querySelector('[class*="account-info_accountInfo"]');
      if (!visible(accountMenu)) throw new Error(`无法打开店铺菜单；页面当前显示 ${before || "未知店铺"}`);
      const mainMall = await openSellerAccountMenu(accountMenu);
      // Temu 把点击事件挂在 operatorBtn 上，不能优先点击里面只负责显示文字的 span。
      const firstSwitch = mainMall?.querySelector('[class*="account-info_operatorBtn"]') || visibleTextAction(mainMall, "切换");
      if (!visible(firstSwitch)) throw new Error(`店铺菜单中没有找到“切换”；页面当前显示 ${before || "未知店铺"}`);
      fireClick(firstSwitch);
      await sleep(900);
      root = document.querySelector('[class*="account-info_changeModal"]');
    }
    if (!visible(root)) throw new Error("点击切换后没有出现店铺列表");
    const targetText = targetName.toLocaleLowerCase();
    const row = Array.from(root.querySelectorAll('[class*="account-info_mallSection"]')).find((element) => cleanShopName(element.innerText || element.textContent || "").toLocaleLowerCase().includes(targetText));
    if (!visible(row)) throw new Error(`切换列表中没有找到 ${targetName}`);
    const rowButton = row.querySelector('[class*="account-info_operatorBtn"]:not([disabled])') || visibleTextAction(row, "切换");
    if (!visible(rowButton)) throw new Error(`无法点击 ${targetName} 的切换按钮`);
    fireClick(rowButton);
    await sleep(1200);
    return {success:true, currentShop:currentShopName(), clicked:true};
  }
  function hasSellerRefreshNotice() {
    return Array.from(document.querySelectorAll("div")).some((element) => {
      if (!visible(element)) return false;
      const text = String(element.innerText || element.textContent || "").replace(/\s+/g, " ");
      return !element.closest("#temuCollectorRoot") && text.length < 80 && text.includes("检测到店铺已切换") && text.includes("即将刷新页面");
    });
  }
  async function verifySellerShop({name, mallId}) {
    const targetMallId = String(mallId || "").trim();
    let currentShop = "";
    let actualMallId = "";
    let refreshNotice = false;
    // 商品页顶部账号组件是异步渲染的，名称可能短暂显示“-”或为空。
    // 数字 mallid 才是采集隔离的强身份；名称只用于可读诊断。
    for (let attempt = 0; attempt < 12; attempt += 1) {
      currentShop = currentShopName();
      actualMallId = currentMallId();
      refreshNotice = hasSellerRefreshNotice();
      const nameMatches = sameShopName(currentShop, name);
      const mallIdMatches = Boolean(targetMallId && actualMallId === targetMallId);
      if (refreshNotice || mallIdMatches || (actualMallId && targetMallId && actualMallId !== targetMallId)) {
        return {success:true, matches:!refreshNotice && mallIdMatches, nameMatches, mallIdMatches, currentShop, currentMallId:actualMallId, identitySource:"mall_id", refreshNotice};
      }
      await sleep(250);
    }
    const nameMatches = sameShopName(currentShop, name);
    const mallIdMatches = Boolean(targetMallId && actualMallId === targetMallId);
    return {success:true, matches:!refreshNotice && mallIdMatches, nameMatches, mallIdMatches, currentShop, currentMallId:actualMallId, identitySource:"mall_id", refreshNotice};
  }
  async function prepareFlow() {
    const relevant = (entry) => /\/api\/flow\/analysis\/(?:overview|trend)/.test(String(entry?.name || ""));
    const startedAt = performance.now();
    let lastSignature = "";
    let quietSince = startedAt;
    while (performance.now() - startedAt < 10000) {
      const entries = performance.getEntriesByType("resource").filter(relevant);
      const latest = entries.reduce((value, entry) => Math.max(value, Number(entry.responseEnd || entry.startTime || 0)), 0);
      const signature = `${entries.length}:${latest}`;
      if (signature !== lastSignature) {
        lastSignature = signature;
        quietSince = performance.now();
      }
      const elapsed = performance.now() - startedAt;
      if (elapsed >= 2500 && performance.now() - quietSince >= 1800) break;
      await sleep(250);
    }
    return {success:true, waitedMs:Math.round(performance.now() - startedAt)};
  }
  async function flow({dimensions = [0], requestHeaders = {}, capturedPayload = {}, capturedTrendPayload = {}}) {
    const items = [];
    const dimensionNames = {0:"实时", 1:"近1日", 2:"本周", 3:"本月", 4:"近7日", 5:"近30日"};
    for (let index = 0; index < dimensions.length; index += 1) {
      const dimension = Number(dimensions[index]);
      const label = dimensionNames[dimension] || `维度 ${dimension}`;
      const overview = await post("/api/flow/analysis/overview", {...(capturedPayload || {}), timeDimension: dimension}, requestHeaders, {label:`${label}概览接口`});
      const overviewReceivedAt = new Date().toISOString();
      await sleep(2000);
      const trend = await post("/api/flow/analysis/trend", {...(capturedTrendPayload || {}), trendType: 1, timeDimension: dimension}, requestHeaders, {label:`${label}趋势接口`});
      if (overview.success !== true) throw new Error(overview.errorMsg || `流量维度 ${dimension} 获取失败`);
      if (trend.success !== true) throw new Error(trend.errorMsg || "流量趋势未完整返回，保留上次数据");
      if (!["impressionCount","clickCount","orderPayOrderNum","orderPayGoodsNum","clickImpressionRate","clickOrderRatio","orderPayImpressionRate"].some(key=>typeof overview.result?.[key]==="number"&&Number.isFinite(overview.result[key]))) {
        const error = new Error("流量汇总全部为空，未更新有效报表；请确认商品流量页的站点与查询条件");
        error.errorCode = "FLOW_EMPTY_SUMMARY";
        throw error;
      }
      items.push({time_dimension: dimension, data: {result: overview.result || {}, response: overview, trend_response: trend, source_page: location.origin + location.pathname, site_label: Array.from(document.querySelectorAll("h1,h2,h3")).map(el => (el.textContent || "").trim()).find(text => /^商品流量\s*[·・—-]\s*.+/.test(text))?.replace(/^商品流量\s*[·・—-]\s*/, "") || null, request_scope: {timeDimension: dimension, trendType: 1}, overview_received_at: overviewReceivedAt, trend_received_at: new Date().toISOString()}});
      progress({stage:"flow", message:`${label}流量完成（${items.length}/${dimensions.length}）`, current:items.length, total:dimensions.length});
    }
    return {success: true, items};
  }
  function seconds(day, end = false) {
    return Math.floor(new Date(`${day.replace(/-/g, "/")} ${end ? "23:59:59" : "00:00:00"}`).getTime() / 1000);
  }
  function chinaMilliseconds(day, end = false) {
    return new Date(`${day}T${end ? "23:59:59.999" : "00:00:00.000"}+08:00`).getTime();
  }
  async function prepareOrders() {
    const buttons = Array.from(document.querySelectorAll("button"));
    const query = buttons.find((item) => String(item.innerText || item.textContent || "").trim() === "查询");
    if (!query) throw new Error("订单页面尚未准备完成：没有找到查询按钮");
    query.click();
    await sleep(1800);
    return {success:true};
  }
  async function orders({startDate, endDate, requestHeaders = {}, capturedPayload = null}) {
    const rows = [], seen = new Set();
    const tasks = [[0,2],[0,4],[0,5],[1,2],[1,4],[1,5]];
    for (const [fulfillmentMode, queryType] of tasks) {
      let pageNumber = 1, totalPages = 1;
      while (pageNumber <= totalPages) {
        const requestBody = {...(capturedPayload && typeof capturedPayload === "object" ? capturedPayload : {}), fulfillmentMode, queryType, pageNumber, pageSize: 500, sortType: 1, timeZone: "UTC+8", sellerNoteLabelList: [], parentAfterSalesTag: 0, parentOrderTimeStart: seconds(startDate), parentOrderTimeEnd: seconds(endDate, true)};
        if (Object.prototype.hasOwnProperty.call(requestBody, "page")) requestBody.page = pageNumber;
        const body = await post("/kirogi/bg/mms/recentOrderList", requestBody, requestHeaders);
        if (body.success !== true || !Array.isArray(body?.result?.pageItems)) throw new Error(body.errorMsg || `订单池 ${fulfillmentMode}/${queryType} 第${pageNumber}页失败`);
        const total = Number(body.result.totalItemNum || 0);
        totalPages = Math.max(1, Math.ceil(total / 500));
        for (const item of body.result.pageItems) {
          const parent = item.parentOrderMap || {};
          for (const order of item.orderList || []) {
            const productInfoList = Array.isArray(order.productInfoList) ? order.productInfoList : [];
            const products = productInfoList.filter((product) => String(product?.productSkuId || "").trim());
            if (!products.length) throw new Error(`子订单 ${order.orderSn || "未知"} 缺少 productInfoList.productSkuId，已停止以避免写入错误 SKU ID`);
            if (new Set(products.map((product) => String(product.productSkuId))).size > 1) throw new Error(`子订单 ${order.orderSn || "未知"} 包含多个 productSkuId，当前金额无法安全拆分，已停止以避免重复计算`);
            for (const product of products) {
              const row = {fulfillmentMode, queryType, parentOrderSn: String(parent.parentOrderSn || ""), orderSn: String(order.orderSn || ""), skuId: String(product.productSkuId || ""), temuSkuId: String(order.skuId || ""), productSkcId: String(product.productSkcId || ""), productSpuId: String(product.productSpuId || ""), extCodeList: Array.isArray(order.extCodeList) ? order.extCodeList.map(String).filter(Boolean) : [], originQuantity: Number(product.productQuantity ?? order.originQuantity ?? order.quantity ?? 0), parentConfirmTimeStr: parent.parentConfirmTimeStr || "", money: null};
              const key = `${row.parentOrderSn}|${row.orderSn}|${row.skuId}`;
              if (row.parentOrderSn && row.orderSn && row.skuId && !seen.has(key)) { seen.add(key); rows.push(row); }
            }
          }
        }
        progress({stage:"orders", message:`订单池 ${fulfillmentMode}/${queryType}：${pageNumber}/${totalPages} 页，已合并 ${rows.length} 行`, current:pageNumber, total:totalPages, rows:rows.length});
        pageNumber += 1;
        await sleep(150);
      }
    }
    return {success: true, rows};
  }
  function dailyAuditWalk(value, visit, path = [], depth = 0, seen = new Set()) {
    if (value == null || depth > 12 || (typeof value === "object" && seen.has(value))) return;
    if (typeof value === "object") seen.add(value);
    if (Array.isArray(value)) {
      value.forEach((item, index) => dailyAuditWalk(item, visit, [...path, String(index)], depth + 1, seen));
      return;
    }
    if (typeof value !== "object") { visit(path, value); return; }
    Object.entries(value).forEach(([key, child]) => dailyAuditWalk(child, visit, [...path, key], depth + 1, seen));
  }
  function dailyAuditDate(value) {
    if (typeof value === "number" && Number.isFinite(value)) {
      const millis = value > 100000000000 ? value : value > 1000000000 ? value * 1000 : NaN;
      return Number.isFinite(millis) ? new Date(millis) : null;
    }
    const text = String(value || "").trim();
    if (!text) return null;
    const normalized = /^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}$/.test(text) ? text.replace(" ", "T") + "+08:00" : text;
    const parsed = new Date(normalized);
    return Number.isFinite(parsed.getTime()) ? parsed : null;
  }
  function dailyAuditIds(item) {
    const ids = {parent_order_sn:"", order_sn:""};
    dailyAuditWalk(item, (path, value) => {
      const key = path.at(-1) || "", text = String(value || "").trim();
      if (!ids.parent_order_sn && /^parentOrderSn$/i.test(key) && text) ids.parent_order_sn = text;
      if (!ids.order_sn && /^orderSn$/i.test(key) && text) ids.order_sn = text;
    });
    return ids;
  }
  function dailyAuditStatusText(item) {
    const values = [];
    dailyAuditWalk(item, (path, value) => {
      const key = path.at(-1) || "";
      if (!/(?:status|state|desc|tag|reason|error|fail|exception)/i.test(key)) return;
      const text = String(value || "").replace(/\s+/g, " ").trim();
      if (text && text.length <= 120 && !/^\d+$/.test(text)) values.push(text);
    });
    return [...new Set(values)].slice(0, 8);
  }
  function dailyAuditActualShipTimes(item) {
    const found = [];
    dailyAuditWalk(item, (path, value) => {
      const key = path.at(-1) || "", lower = key.toLowerCase();
      const relevant = /(?:actual|real).*(?:ship|send|deliver)|(?:ship|send|deliver).*(?:actual|real)|^(?:ship|shipped|send)time(?:str)?$/.test(lower);
      if (!relevant || /expect|required|latest|deadline|promise/.test(lower)) return;
      const parsed = dailyAuditDate(value);
      if (parsed) found.push({field:key, at:parsed.toISOString()});
    });
    return found;
  }
  async function orderAudit({startDate, endDate, requestHeaders = {}, thresholdHours = 72} = {}) {
    const cancelled = new Map(), abnormal = new Map(), overdue = new Map(), poolTotals = {};
    const pools = [
      {fulfillmentMode:0, queryType:6, label:"卖家发货订单状态筛查"},
      {fulfillmentMode:1, queryType:6, label:"平台发货订单状态筛查"},
      {fulfillmentMode:0, queryType:4, label:"卖家发货已发货"},
      {fulfillmentMode:1, queryType:4, label:"平台发货已发货"},
    ];
    let requests = 0;
    for (const pool of pools) {
      let pageNumber = 1, totalPages = 1;
      while (pageNumber <= totalPages && pageNumber <= 100) {
        const requestBody = {fulfillmentMode:pool.fulfillmentMode, queryType:pool.queryType, pageNumber, pageSize:500, sortType:1, timeZone:"UTC+8", sellerNoteLabelList:[], parentAfterSalesTag:0, parentOrderTimeStart:seconds(startDate), parentOrderTimeEnd:seconds(endDate, true)};
        const body = await post("/kirogi/bg/mms/recentOrderList", requestBody, requestHeaders, {label:`每日巡检·${pool.label}第 ${pageNumber} 页`});
        if (body.success !== true || !Array.isArray(body?.result?.pageItems)) throw new Error(body.errorMsg || `${pool.label}读取失败`);
        requests += 1;
        const total = Number(body.result.totalItemNum || 0);
        poolTotals[`${pool.fulfillmentMode}:${pool.queryType}`] = total;
        totalPages = Math.max(1, Math.ceil(total / 500));
        for (const item of body.result.pageItems) {
          const ids = dailyAuditIds(item), key = ids.parent_order_sn || ids.order_sn;
          if (!key) continue;
          const statuses = dailyAuditStatusText(item);
          if (pool.queryType === 6) {
            const cancelledStatus = statuses.find((status) => /已取消|取消成功|cancelled|canceled/i.test(status));
            if (cancelledStatus) cancelled.set(key, {...ids, status:cancelledStatus});
            continue;
          }
          const statusLine = statuses.join(" · ");
          if (/物流信息异常|揽收失败|物流异常|发货异常|shipment.*(?:fail|exception|abnormal)|pickup.*fail|tracking.*exception/i.test(statusLine)) {
            abnormal.set(key, {...ids, reason:statusLine || "物流信息异常"});
          }
          const actualTimes = dailyAuditActualShipTimes(item).sort((a,b)=>a.at.localeCompare(b.at));
          const actual = actualTimes[0];
          if (actual) {
            const hours = (Date.now() - new Date(actual.at).getTime()) / 3600000;
            if (hours >= Number(thresholdHours || 72)) overdue.set(key, {...ids, actual_ship_time:actual.at, elapsed_hours:Math.floor(hours), status:statusLine});
          }
        }
        progress({stage:"daily-orders", message:`${pool.label}：${pageNumber}/${totalPages} 页`, current:pageNumber, total:totalPages});
        pageNumber += 1;
        if (pageNumber <= totalPages) await sleep(150);
      }
    }
    return {
      success:true,
      range:{start_date:startDate,end_date:endDate,threshold_hours:Number(thresholdHours || 72)},
      cancelled_count:cancelled.size,
      cancelled_orders:[...cancelled.values()].slice(0,100),
      logistics_exception_count:abnormal.size,
      logistics_exceptions:[...abnormal.values()].slice(0,100),
      overdue_shipment_count:overdue.size,
      overdue_shipments:[...overdue.values()].sort((a,b)=>b.elapsed_hours-a.elapsed_hours).slice(0,100),
      pool_totals:poolTotals,
      requests,
      coverage:"已取消按订单状态文字确认；异常和发货满72小时从已发货订单池检查；时间范围按北京时间订单创建时间",
    };
  }
  function shippingAmountFromText(value) {
    const normalized=String(value||"").replace(/,/g,"").trim();
    const currency=normalized.match(/(?:US\s*\$|USD|\$)\s*(-?\d+(?:\.\d+)?)/i);
    const amount=Number(currency?.[1]);return currency&&Number.isFinite(amount)&&amount>=0?Number(amount.toFixed(2)):null;
  }
  function nestedParentOrderSns(value,found=new Set(),depth=0){
    if(value==null||depth>12)return found;if(Array.isArray(value)){for(const item of value)nestedParentOrderSns(item,found,depth+1);return found;}if(typeof value!=="object")return found;
    for(const [key,item] of Object.entries(value)){if(/^parentOrderSn$/i.test(key)&&(typeof item==="string"||typeof item==="number")){const text=String(item||"").trim();if(text)found.add(text);}nestedParentOrderSns(item,found,depth+1);}return found;
  }
  function nestedStringValues(value,keyPattern,found=new Set(),depth=0){
    if(value==null||depth>12)return found;if(Array.isArray(value)){for(const item of value)nestedStringValues(item,keyPattern,found,depth+1);return found;}if(typeof value!=="object")return found;
    for(const [key,item] of Object.entries(value)){if(keyPattern.test(key)&&(typeof item==="string"||typeof item==="number")){const text=String(item||"").trim();if(text)found.add(text);}nestedStringValues(item,keyPattern,found,depth+1);}return found;
  }
  function preciseShippingRows(payload){
    const rows=[],items=Array.isArray(payload?.result?.pageItems)?payload.result.pageItems:[];
    for(const item of items){const record=item?.callLabelPackageInfo||item?.unshippedParentOrderInfo||item||{},parents=[...nestedParentOrderSns(record)],packages=[...nestedStringValues(record,/^packageSn$/i)],trackings=[...nestedStringValues(record,/^(?:trackingId|trackingNo|waybillSn)$/i)],amount=shippingAmountFromText(record?.estimatedText),targets=packages.length?packages:[""];
      for(const parent_order_sn of parents)for(const package_sn of targets)rows.push({parent_order_sn,package_sn,tracking_no:trackings[0]||"",carrier:String(record?.shipCompanyName||""),service_name:String(record?.shipProductName||""),lookup_status:amount!==null?"found":"missing",online_shipping_amount_usd:amount,source:"seller_online_shipment_api"});}
    return rows;
  }
  async function preciseShipping({parentOrderSns=[] ,requestHeaders={}}={}){
    const parents=[...new Set(parentOrderSns.map(value=>String(value||"").trim()).filter(Boolean))].slice(0,10000),collected=new Map();
    for(let start=0;start<parents.length;start+=100){const batch=parents.slice(start,start+100),base={pageSize:100,parentOrderSnList:batch};
      for(const queryType of [3,1])for(let pageNumber=1;pageNumber<=50;pageNumber+=1){const payload=await post("/kirogi/bg/mms/queryShipments",{...base,pageNumber,queryType},requestHeaders,{label:`精准物流费用第 ${pageNumber} 页`});if(payload?.success!==true)throw new Error(payload?.errorMsg||"精准物流费用查询失败");const pageItems=Array.isArray(payload?.result?.pageItems)?payload.result.pageItems:[];for(const row of preciseShippingRows(payload)){const key=`${row.parent_order_sn}|${row.package_sn||"parent"}`,old=collected.get(key);if(!old||row.lookup_status==="found")collected.set(key,row);}const total=Number(payload?.result?.total??payload?.result?.totalCount??pageItems.length);if(!pageItems.length||pageItems.length<100||pageNumber*100>=total)break;}
      progress({stage:"shipping",message:`精准物流费用：已查询 ${Math.min(start+batch.length,parents.length)}/${parents.length} 个父订单`,current:Math.min(start+batch.length,parents.length),total:parents.length,rows:collected.size});if(start+100<parents.length)await sleep(150);}
    const covered=new Set([...collected.values()].map(row=>String(row.parent_order_sn)));
    for(const parent_order_sn of parents)if(!covered.has(parent_order_sn))collected.set(`${parent_order_sn}|parent`,{parent_order_sn,package_sn:"",tracking_no:"",carrier:"",service_name:"",lookup_status:"missing",online_shipping_amount_usd:null,source:"seller_online_shipment_api"});
    const rows=[...collected.values()];return {success:true,rows,found:rows.filter(row=>row.lookup_status==="found").length,missing:rows.filter(row=>row.lookup_status!=="found").length};
  }
  async function returns({startDate, endDate, requestHeaders = {}, capturedPayload = null}) {
    const rows = [], seen = new Set();
    let pageNumber = 1, totalPages = 1, totalCount = 0;
    while (pageNumber <= totalPages) {
      const requestBody = {
        ...(capturedPayload && typeof capturedPayload === "object" ? capturedPayload : {}),
        pageNumber,
        pageSize: 100,
        groupSearchType: 0,
        timeSearchType: 5000,
        reverseSignedTimeSearchType: 7000,
        startCreatedTime: chinaMilliseconds(startDate),
        endCreatedTime: chinaMilliseconds(endDate, true),
        selectOnlyRefund: true,
        selectReturnRefund: true
      };
      if (Object.prototype.hasOwnProperty.call(requestBody, "page")) requestBody.page = pageNumber;
      const body = await post("/garen/mms/afterSales/queryReturnAndRefundPaList", requestBody, requestHeaders, {label:`退货退款第 ${pageNumber} 页`});
      const page = body?.result?.mmsPageVO;
      if (body.success !== true || !page || !Array.isArray(page.data)) throw new Error(body.errorMsg || `退货退款第 ${pageNumber} 页失败`);
      totalCount = Math.max(totalCount, Number(page.totalCount || 0));
      const actualPageSize = Math.max(1, Number(page.pageSize || requestBody.pageSize || 10));
      totalPages = Math.max(1, Math.ceil(totalCount / actualPageSize));
      for (const parent of page.data) {
        const completedAt = (parent.operateNodeVOList || []).find((node) => Number(node?.operateNodeType) === 4)?.operateTime || null;
        for (const item of parent.afterSalesItemVOList || []) {
          const afterSalesSn = String(item.afterSalesSn || "").trim();
          const productSkuId = String(item.productSkuId || "").trim();
          const key = `${afterSalesSn}|${productSkuId}`;
          if (!afterSalesSn || !productSkuId || seen.has(key)) continue;
          seen.add(key);
          rows.push({
            parentAfterSalesSn: String(parent.parentAfterSalesSn || ""),
            afterSalesSn,
            parentOrderSn: String(parent.parentOrderSn || ""),
            orderSn: String(item.orderSn || ""),
            productSkuId,
            temuSkuId: String(item.skuId || ""),
            productSkcId: String(item.productSkcId || ""),
            productSpuId: String(item.productSpuId || ""),
            afterSalesType: Number(parent.afterSalesType ?? 0),
            afterSalesTypeDesc: String(parent.afterSalesTypeDesc || ""),
            afterSalesStatus: Number(parent.parentAfterSalesStatus ?? 0),
            afterSalesStatusDesc: String(parent.parentAfterSalesStatusDesc || ""),
            createdAt: Number(parent.createdAt || 0),
            completedAt: Number(completedAt || 0),
            applyReturnGoodsNumber: Number(item.applyReturnGoodsNumber || 0),
            returnGoodsNumber: Number(item.returnGoodsNumber || 0),
            rejectGoodsNumber: Number(item.rejectGoodsNumber || 0),
            orderGoodsNumber: Number(item.orderGoodsNumber || 0),
            reasonCode: String(item.afterSalesReasonCode || ""),
            reasonDesc: String(item.afterSalesReasonDesc || ""),
            goodsName: String(item.goodsName || ""),
            goodsSpec: String(item.goodsSpec || "")
          });
        }
      }
      progress({stage:"returns", message:`退货退款：${pageNumber}/${totalPages} 页，已采集 ${rows.length} 个商品项`, current:pageNumber, total:totalPages, rows:rows.length});
      pageNumber += 1;
      if (pageNumber <= totalPages) await sleep(200);
    }
    return {success:true, rows, totalCount};
  }
  function parseRawData(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const text = [...doc.scripts].map((item) => item.textContent || "").find((item) => item.includes("window.rawData"));
    const match = text?.match(/window\.rawData\s*=\s*({[\s\S]*?})(?=;\s*document\.dispatchEvent|;\s*$|,\s*window\.)/);
    if (!match) return null;
    try { return JSON.parse(match[1]); } catch { return Function(`"use strict";return (${match[1]})`)(); }
  }
  async function querySupplierPrices(parentOrderSn, requestHeaders = {}) {
    const body = await post(
      "/bg-visage-agent-seller/product/sku/supplierPrice/batchQueryByOrder",
      {parentOrderSnList:[parentOrderSn]},
      requestHeaders,
      {label:`父订单 ${parentOrderSn} 金额接口`}
    );
    if (body.success !== true) throw new Error(body.errorMsg || body.error_msg || "订单金额接口请求失败");
    const parentResults = body?.result?.querySupplierPriceByOrderRespList || [];
    const prices = {};
    for (const parentResult of parentResults) {
      for (const subOrder of parentResult?.supplierPriceWithSubOrderRespList || []) {
        const productPrice = subOrder?.productSkuSupplierPriceRespList?.[0] || {};
        const rawPrice = productPrice.activitySupplierPrice || productPrice.supplierPrice;
        const price = Number(rawPrice);
        const orderSn = String(subOrder?.orderSn || "").trim();
        if (orderSn && Number.isFinite(price) && price > 0) prices[orderSn] = Number((price / 100).toFixed(2));
      }
    }
    if (!Object.keys(prices).length) throw new Error("订单金额接口未返回有效供货价");
    return prices;
  }
  async function orderDetails({parentOrderSns = [], requestHeaders = {}}) {
    const parents = [...new Set((parentOrderSns || []).map((value) => String(value || "").trim()).filter(Boolean))].slice(0, 200);
    const rows = [];
    const failedByParent = {};
    let cursor = 0;
    let processed = 0;
    progress({stage:"orders", message:`缺失退款订单：已处理 0/${parents.length} 个父订单`, current:0, total:parents.length, rows:0});
    async function worker() {
      while (cursor < parents.length) {
        const parentOrderSn = parents[cursor++];
        try {
          const response = await fetch(`/mmsos/order-detail.html?parent_order_sn=${encodeURIComponent(parentOrderSn)}`, {credentials:"include", headers:requestHeaders});
          const text = await response.text();
          if (!response.ok) throw new Error(friendlyTemuError({status:response.status, fallback:"订单详情请求失败"}));
          const raw = parseRawData(text);
          const store = raw?.store?.store;
          const detail = store?.orderDetailData;
          const parent = detail?.parentOrderMap || {};
          const orderList = detail?.orderList;
          if (!Array.isArray(orderList)) throw new Error("订单详情没有返回商品列表");
          let fallbackPrices = {};
          for (const order of orderList) {
            const orderSn = String(order?.orderSn || "").trim();
            const products = (Array.isArray(order?.productInfoList) ? order.productInfoList : []).filter((product) => String(product?.productSkuId || "").trim());
            if (!orderSn || !products.length) continue;
            if (new Set(products.map((product) => String(product.productSkuId))).size > 1) {
              throw new Error(`子订单 ${orderSn} 包含多个 productSkuId，无法安全拆分订单金额`);
            }
            let money = Number(store?.orderSupplierPriceMap?.[orderSn]);
            if (!(money > 0)) {
              if (!Object.keys(fallbackPrices).length) {
                try { fallbackPrices = await querySupplierPrices(parentOrderSn, requestHeaders); } catch {}
              }
              money = fallbackPrices[orderSn] == null ? NaN : Number(fallbackPrices[orderSn]) * 100;
            }
            for (const product of products) {
              rows.push({
                fulfillmentMode:Number(order?.orderFulfillmentMode ?? store?.fulfillmentMode ?? 0),
                queryType:Number(order?.orderStatus ?? 0),
                parentOrderSn:String(parent?.parentOrderSn || parentOrderSn),
                orderSn,
                skuId:String(product.productSkuId || ""),
                temuSkuId:String(order?.skuId || ""),
                productSkcId:String(product.productSkcId || ""),
                productSpuId:String(product.productSpuId || ""),
                extCodeList:Array.isArray(order?.extCodeList) ? order.extCodeList.map(String).filter(Boolean) : [],
                originQuantity:Number(product.productQuantity ?? order.originQuantity ?? order.quantity ?? 0),
                parentConfirmTimeStr:String(parent?.parentConfirmTimeStr || parent?.parentOrderTimeStr || ""),
                money:Number.isFinite(money) && money > 0 ? Number((money / 100).toFixed(2)) : null,
                recoveredFromReturnRefund:true
              });
            }
          }
        } catch (error) {
          failedByParent[parentOrderSn] = String(error?.message || error);
        }
        processed += 1;
        progress({stage:"orders", message:`缺失退款订单：已处理 ${processed}/${parents.length} 个父订单，恢复 ${rows.length} 行`, current:processed, total:parents.length, rows:rows.length});
      }
    }
    await Promise.all(Array.from({length:Math.min(5, parents.length || 1)}, worker));
    return {success:true, rows, failedByParent, failedParentOrderSns:Object.keys(failedByParent)};
  }
  async function money({rows, requestHeaders = {}}) {
    const groups = [...new Set(rows.filter((row) => row.money == null || row.money === "").map((row) => String(row.parentOrderSn || "").trim()).filter(Boolean))];
    const requiredOrderSnsByParent = new Map(groups.map((parent)=>[
      parent,
      [...new Set(rows.filter((row)=>String(row.parentOrderSn||"").trim()===parent&&(row.money==null||row.money==="")).map((row)=>String(row.orderSn||"").trim()).filter(Boolean))]
    ]));
    const detailByParent = {};
    const failedByParent = {};
    let cursor = 0;
    let processed = 0;
    progress({stage:"money", message:`订单金额：已处理 0/${groups.length} 个待补父订单`, current:0, total:groups.length});
    async function worker() {
      while (cursor < groups.length) {
        const parent = groups[cursor++];
        let lastError = "";
        let lastDiagnostic = null;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            const startedAt = performance.now();
            const response = await fetch(`/mmsos/order-detail.html?parent_order_sn=${encodeURIComponent(parent)}`, {credentials: "include", headers: requestHeaders});
            const text = await response.text();
            progress({stage:"network", metric:{url:"/mmsos/order-detail.html", bytes:new TextEncoder().encode(text).length, durationMs:performance.now() - startedAt}});
            if (!response.ok) throw new Error(friendlyTemuError({status:response.status,fallback:"订单详情请求失败"}));
            const raw = parseRawData(text);
            const store = raw?.store?.store;
            const list = store?.orderDetailData?.orderList;
            if (!Array.isArray(list)) {
              const doc = new DOMParser().parseFromString(text, "text/html");
              const authPage = /invalid login state|login\/authorize|sign[ -]?in|登录已失效|重新登录/i.test(`${response.url}\n${text.slice(0,12000)}`);
              const diagnostic = {
                attempt:attempt + 1,
                status:response.status,
                responseBytes:new TextEncoder().encode(text).length,
                contentType:String(response.headers.get("content-type") || "").split(";", 1)[0],
                finalPath:new URL(response.url, location.origin).pathname,
                pageTitle:String(doc.title || ""),
                hasRawDataText:text.includes("window.rawData"),
                rawParsed:Boolean(raw),
                rawKeys:raw ? Object.keys(raw).slice(0, 12) : [],
                storeKeys:store ? Object.keys(store).slice(0, 20) : [],
                detailKeys:store?.orderDetailData ? Object.keys(store.orderDetailData).slice(0, 20) : [],
                orderListType:Array.isArray(list) ? "array" : typeof list,
                authPage,
                mallId:String(requestHeaders.mallid || requestHeaders.mallId || "")
              };
              if (authPage) {
                const detailError = new Error("Temu 账号未登录或登录已失效，请重新登录");
                detailError.diagnostic = diagnostic;
                throw detailError;
              }
              try {
                detailByParent[parent] = await querySupplierPrices(parent, requestHeaders);
                lastError = "";
                break;
              } catch (fallbackError) {
                diagnostic.supplierPriceFallback = String(fallbackError?.message || fallbackError);
                const detailError = new Error("订单详情没有内嵌数据，金额接口也未返回有效供货价");
                detailError.diagnostic = diagnostic;
                throw detailError;
              }
            }
            const prices = {};
            for (const order of list) {
              const orderSn = String(order.orderSn || "");
              const price = Number(store?.orderSupplierPriceMap?.[orderSn]);
              if (price > 0) prices[orderSn] = Number((price / 100).toFixed(2));
            }
            const requiredOrderSns=requiredOrderSnsByParent.get(parent)||[];
            const missingBeforeFallback=requiredOrderSns.filter((orderSn)=>prices[orderSn]==null);
            let fallbackFailure="";
            if(missingBeforeFallback.length){
              try{Object.assign(prices,await querySupplierPrices(parent,requestHeaders));}
              catch(fallbackError){fallbackFailure=String(fallbackError?.message||fallbackError);}
            }
            const missingAfterFallback=requiredOrderSns.filter((orderSn)=>prices[orderSn]==null);
            if(missingAfterFallback.length){
              const detailError=new Error(`订单金额仍缺少 ${missingAfterFallback.length} 个子订单：${missingAfterFallback.slice(0,3).join("、")}`);
              detailError.diagnostic={
                attempt:attempt+1,status:response.status,responseBytes:new TextEncoder().encode(text).length,
                contentType:String(response.headers.get("content-type")||"").split(";",1)[0],
                finalPath:new URL(response.url,location.origin).pathname,pageTitle:"订单详情",
                hasRawDataText:text.includes("window.rawData"),rawParsed:Boolean(raw),
                storeKeys:store?Object.keys(store).slice(0,20):[],mallId:String(requestHeaders.mallid||requestHeaders.mallId||""),
                requiredOrderSns,returnedOrderSns:Object.keys(prices),supplierPriceFallback:fallbackFailure
              };
              throw detailError;
            }
            detailByParent[parent] = prices; lastError = ""; break;
          } catch (error) {
            lastError = String(error);
            lastDiagnostic = error?.diagnostic || {attempt:attempt + 1, reason:lastError, mallId:String(requestHeaders.mallid || requestHeaders.mallId || "")};
            await sleep(500 * (attempt + 1));
          }
        }
        if (lastError) failedByParent[parent] = {reason:lastError, attempts:3, diagnostic:lastDiagnostic};
        processed += 1;
        progress({stage:"money", message:`订单金额：已处理 ${processed}/${groups.length} 个待补父订单`, current:processed, total:groups.length});
      }
    }
    await Promise.all(Array.from({length: Math.min(10, groups.length || 1)}, worker));
    const result = rows.map((row) => ({...row, money: row.money ?? detailByParent[row.parentOrderSn]?.[row.orderSn] ?? null}));
    const missing = result.filter((row) => row.money == null || row.money === "");
    const missingParentOrderSns = [...new Set(missing.map((row) => String(row.parentOrderSn || "").trim()).filter(Boolean))];
    return {success: true, rows: result, missingCount:missing.length, missingParentOrderSns, failedByParent};
  }
  async function adsSwitch({mallId}) {
    const detail = (await post("/api/v1/coconut/mall/query_mall_detail?is_back=1", {}))?.result || {};
    if (String(detail.mall_id || "") === String(mallId)) return {success: true};
    const mallType = Number(detail.mall_type || 2);
    const list = (await post(`/api/v1/coconut/account/mall_list?mallType=${mallType}&is_back=1`, {mall_type: mallType}))?.result?.query_mall_detail_resp_dtolist || [];
    const target = list.find((item) => String(item.mall_id || "") === String(mallId));
    if (!target) throw new Error(`广告平台没有找到 mallId=${mallId}`);
    const switched = await post(`/api/v1/coconut/account/mall_switch?mallType=${mallType}&targetMallId=${encodeURIComponent(mallId)}&is_back=1`, {});
    if (switched.success !== true) throw new Error(switched.error_msg || "广告店铺切换失败");
    return {success: true};
  }
  async function adsReports({dates, requestHeaders = {}}) {
    const reports = [];
    const failedDates = [];
    let earliestTimeMs = null;
    let lastError = null;
    let consecutiveFailures = 0;
    for (const day of dates) {
      const start = new Date(`${day}T00:00:00+08:00`).getTime(), end = start + 86400000 - 1;
      try {
        const data = await post("/api/v1/coconut/reports/queryReports?is_back=1", {start_ts: start, end_ts: end, source: 0, sort_type: 0, query_type: 0, need_query_last_cycle: false, asc_order: true, columns_type: 18}, {...requestHeaders, "x-ad-request-id": crypto.randomUUID()}, {label:`${day} 广告日报`});
        if (data.success !== true) throw new Error(data.error_msg || `${day} 广告数据获取失败`);
        const allowed = Number(data?.result?.allowed_start_ts);
        if (Number.isFinite(allowed)) earliestTimeMs = allowed;
        const summary = data?.result?.reports_summary || {}, values = {};
        for (const key of ["ad_spend_all","net_ad_spend","total_order_pay_amt","total_roas","total_acos","total_transaction_cost","total_order_pay_cnt"]) values[key] = summary[key] || {val: null, trans_val: "--"};
        reports.push({date: day, response_ok: true, values});
        consecutiveFailures = 0;
      } catch (error) {
        lastError = error;
        failedDates.push({date:day, reason:String(error?.message || error)});
        consecutiveFailures += 1;
        progress({stage:"ads", message:`${day} 广告日报未取得，已保留其他成功日期`, current:reports.length, total:dates.length});
        if (consecutiveFailures >= 2) break;
      }
      progress({stage:"ads", message:`广告日报：成功 ${reports.length} 天，失败 ${failedDates.length} 天`, current:reports.length, total:dates.length});
    }
    if (!reports.length && lastError) throw lastError;
    return {success: true, reports, failedDates, earliestTimeMs, earliestAdDate:earliestTimeMs ? new Date(earliestTimeMs).toLocaleDateString("sv-SE", {timeZone:"Asia/Shanghai"}) : null};
  }
  const activityReactEvidence = () => {
    const merged = new Map(), roots = [], states = [], seenStates = new WeakSet();
    const rootCandidates = [document.body, document.documentElement, ...document.querySelectorAll('main,section,[class*="activity" i],[class*="table" i],[class*="list" i]')].slice(0,120);
    for (const element of rootCandidates) {
      for (const key of Object.getOwnPropertyNames(element || {})) {
        if (/^__reactProps\$/.test(key) && element[key] && typeof element[key] === 'object') states.push(element[key]);
        if (/^__react(?:Fiber|Container)\$/.test(key) && element[key]) roots.push(element[key]);
      }
    }
    // Walk only the Fiber control links to discover component state holders;
    // do not recursively parse each Fiber node as business data.
    const fibers = [...roots], seenFibers = new WeakSet();
    let fiberCount = 0;
    while (fibers.length && fiberCount < 5000) {
      const fiber = fibers.pop();
      if (!fiber || typeof fiber !== 'object' || seenFibers.has(fiber)) continue;
      seenFibers.add(fiber);
      fiberCount += 1;
      for (const key of ['memoizedProps','pendingProps','memoizedState']) {
        const state = fiber[key];
        if (state && typeof state === 'object' && !seenStates.has(state)) { seenStates.add(state); states.push(state); }
      }
      for (const key of ['child','sibling']) if (fiber[key] && typeof fiber[key] === 'object') fibers.push(fiber[key]);
    }
    for (const state of states.slice(0,5000)) {
      const rows = extractActivityNetworkCandidates(state);
      for (const row of rows) merged.set(row.skuId ? `sku:${row.skuId}` : [row.spuId,row.skcId,row.skuCode,row.specification,row.dailyPrice].join('|'), {...row,source:'temu_activity_react_state'});
    }
    return {success:true,rootCount:roots.length,stateCount:states.length,candidates:[...merged.values()]};
  };
  const activityNetworkEvidence = ({since = 0} = {}) => ({
    success:true,
    responses:activityResponses.filter((item) => Number(item.capturedAt || 0) >= Number(since || 0)),
    diagnostics:activityResponseDiagnostics.filter((item) => Number(item.capturedAt || 0) >= Number(since || 0)),
  });
  const handlers = {ACCELERATORS_QUERY:payload=>{if (!window.TemuAcceleratorQuery) throw Error("加速器查询器尚未加载，请刷新商家后台");return window.TemuAcceleratorQuery.readBatch(payload,post);},USER_INFO: userInfo, ADS_AUTH_STATUS:adsAuthStatus, VERIFY_SELLER_SHOP: verifySellerShop, PREPARE_FLOW:prepareFlow, FLOW: flow, PREPARE_ORDERS: prepareOrders, ORDERS: orders, ORDER_AUDIT:orderAudit, ORDER_DETAILS:orderDetails, MONEY: money, PRECISE_SHIPPING:preciseShipping, RETURNS: returns, ADS_REPORTS: adsReports, PRODUCTS: products, ACTIVITIES:activities, ACTIVITY_NETWORK_EVIDENCE:activityNetworkEvidence, ACTIVITY_REACT_EVIDENCE:activityReactEvidence};
  window.addEventListener("message", async (event) => {
    if (event.source !== window || event.data?.source !== "temu-dashboard-extension") return;
    let result;
    activeRequestId = event.data.id;
    try { result = await handlers[event.data.command](event.data.payload || {}); }
    catch (error) { result = {success: false, error: String(error?.message || error), technicalInfo:String(error?.technicalInfo || ""), ...(event.data.command === "FLOW" && error?.errorCode === "FLOW_EMPTY_SUMMARY" ? {errorCode:"FLOW_EMPTY_SUMMARY"} : {})}; }
    window.postMessage({source: "temu-dashboard-page", id: event.data.id, result}, "*");
  });
})();
