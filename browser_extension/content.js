const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function capturedHeader(captured, name) {
  const expected = String(name || "").toLowerCase();
  const entry = Object.entries(captured?.headers || {}).find(([key]) => String(key).toLowerCase() === expected);
  return String(entry?.[1] || "").trim();
}

function triggerReturnRefundSearch() {
  const button = [...document.querySelectorAll("button")].find((item) =>
    item.offsetParent !== null && String(item.innerText || "").trim() === "查询"
  );
  if (!button) return false;
  button.click();
  return true;
}

function triggerProductSearch() {
  // Read-only list controls only; exclude the collector's own overlay/buttons.
  const button = [...document.querySelectorAll('button,[role="button"],input[type="submit"]')].find((item) =>
    !item.closest("#temuCollectorRoot,#wbDailyBar") && !item.disabled &&
    item.getClientRects().length > 0 &&
    /^(查询|搜索|Search|Query)$/i.test(String(item.innerText || item.value || item.getAttribute("aria-label") || "").replace(/\s+/g,"").trim())
  );
  if (!button) return false;
  button.click();
  return true;
}

function flowSummaryRange() {
  if (typeof location === "undefined" || !/^agentseller(?:-us)?\.temu\.com$/.test(location.hostname) || location.pathname !== "/main/flux-analysis") return null;
  const titles = [...document.querySelectorAll('[class*="total-overview_topTit"]')].filter(item =>
    item.closest('[class*="total-overview_main"]') && item.getClientRects().length && /汇总分析/.test(item.textContent || ""));
  if (titles.length !== 1) return null;
  const groups = titles[0].querySelectorAll('[data-testid="beast-core-tab-top"]');
  if (groups.length !== 1) return null;
  const dimensions = {"实时":0,"近1日":1,"近7日":4,"近30日":5,"本周":2,"本月":3};
  const controls = [...groups[0].querySelectorAll('[data-testid="beast-core-tab-itemLabel-wrapper"]')].map(element => ({
    element, label:String(element.innerText || element.textContent || "").replace(/\s+/g,""),
    active:/(?:^|\s)TAB_active(?:_|\s|$)/.test(String(element.className || ""))
  }));
  if (controls.length !== 6 || new Set(controls.map(item => item.label)).size !== 6 ||
      controls.some(item => dimensions[item.label] === undefined || !item.element.getClientRects().length || item.element.disabled)) return null;
  const selected = controls.filter(item => item.active);
  return selected.length === 1 ? {controls,selected:selected[0],dimension:dimensions[selected[0].label]} : null;
}

async function refreshFlowSummaryRange(initial, message, expectedMallId) {
  const original = initial.selected.label;
  const other = initial.controls.find(item => item.label !== original);
  const waitSelected = async label => {
    for (let attempt = 0; attempt < 20; attempt++) {
      if (flowSummaryRange()?.selected.label === label) return;
      await wait(100);
    }
    throw Error("流量汇总时间范围未能刷新，请确认商品流量页已加载完成后重试");
  };
  let capturedAfter;
  try {
    const changedAt = Date.now();
    other.element.click();
    await waitSelected(other.label);
    // Let the page dispatch its debounced native queries before restoring the
    // original range; an active tab style alone does not prove a query ran.
    for (let attempt = 0; attempt < 12; attempt++) {
      const overview = await chrome.runtime.sendMessage({type:"GET_CAPTURED_HEADERS",tabId:message.tabId,kind:"flow"});
      const trend = await chrome.runtime.sendMessage({type:"GET_CAPTURED_HEADERS",tabId:message.tabId,kind:"flow_trend"});
      const mall = capturedHeader(overview,"mallid");
      if (/^\d+$/.test(mall) && (!expectedMallId || mall===expectedMallId) && capturedHeader(trend,"mallid")===mall &&
          [overview,trend].every(item => item.payload?.timeDimension != null && Number(item.payload.timeDimension) !== initial.dimension && Number(item.requestStartedAt) >= changedAt)) break;
      await wait(100);
    }
  } finally {
    const control = flowSummaryRange()?.controls.find(item => item.label === original);
    if (!control) throw Error("流量汇总时间控件已变化，请确认原时间范围后重试");
    capturedAfter = Date.now();
    control.element.click();
  }
  await waitSelected(original);
  return {dimension:initial.dimension,capturedAfter};
}

function verifiedUsFlowContract(overview, trend, expectedMallId, refreshed) {
  if (!refreshed || typeof location === "undefined" || location.origin !== "https://agentseller-us.temu.com" ||
      location.pathname !== "/main/flux-analysis" || !/^\d+$/.test(expectedMallId) ||
      overview.payload != null || trend.payload != null) return null;
  const range = flowSummaryRange();
  if (!range || range.dimension !== refreshed.dimension || !overview.requestId || !trend.requestId || overview.requestId === trend.requestId) return null;
  if (![overview,trend].every(item => {
    const info = item.requestBodyDiagnostics;
    return info && typeof info.hasBeforeRequest === "boolean" && info.parseError === false && info.rawPartCount === 0 && info.rawByteTotal === 0 &&
      (info.bodyError === null || info.bodyError === "unavailable" || info.bodyError === "access_denied" || info.bodyError === "read_failed");
  })) return null;
  const now = Date.now(), endpoints = ["overview","trend"];
  if (![overview,trend].every((item,index) => item.requestMethod === "POST" &&
      item.requestPath === "https://agentseller-us.temu.com/api/flow/analysis/"+endpoints[index] &&
      capturedHeader(item,"mallid") === expectedMallId && Number.isFinite(Number(item.headersCapturedAt)) &&
      Number(item.headersCapturedAt) >= refreshed.capturedAfter && Number(item.headersCapturedAt) <= now &&
      now-Number(item.headersCapturedAt) < 120000)) return null;
  // US summary contract verified in the current public module (2026-10-26):
  // https://bstatic.kwcdn.com/static/bgb-sca-main/flux-analysis.3252ede8.chunk.js
  // Overview has only timeDimension; trend has only trendType/timeDimension.
  // This bounded fallback requires fresh independent native POST headers when
  // this Chrome profile omits both request bodies; captured bodies stay primary.
  return {...overview,payload:{timeDimension:range.dimension},trendPayload:{trendType:1,timeDimension:range.dimension}};
}

function flowBodyStatus(captured) {
  const info = captured?.requestBodyDiagnostics;
  if (!info || typeof info !== "object") return "missing_diagnostics";
  if (info.parseError === true) return "parse_failed";
  if (Number(info.rawPartCount) > 0 || Number(info.rawByteTotal) > 0) return "raw_present";
  if (["unavailable","access_denied","read_failed","other"].includes(info.bodyError)) return info.bodyError;
  if (info.bodyError != null) return "other";
  if (typeof info.hasBeforeRequest !== "boolean" || info.parseError !== false || info.rawPartCount !== 0 || info.rawByteTotal !== 0 || info.bodyError !== null) return "missing_diagnostics";
  return info.hasBeforeRequest ? "no_raw" : "no_before_request";
}

async function prepareCapturedRequest(message, kind) {
  if (!kind) return {headers:{}, payload:null};
  if (kind === "accelerators") {
    const expectedMallId=String(message.payload?.mallId||"");
    const marker=new URL(location.href).searchParams.get("wb_accelerator_status");
    if (message.command==="ACCELERATORS_QUERY" && (location.origin!=="https://agentseller-us.temu.com" ||
        location.pathname!=="/main/flux-analysis" || !marker || marker!==message.payload?.marker)) {
      throw Error("加速器查询仅能读取本轮独立的美国站流量页");
    }
    let triggered=false;
    for(let attempt=0;attempt<120;attempt++){
      const captured=await chrome.runtime.sendMessage({type:"GET_CAPTURED_HEADERS",tabId:message.tabId,kind:message.command==="ACCELERATORS_QUERY"?"flow_list":"flow"});
      if(capturedHeader(captured,"mallid")===expectedMallId && /^\d+$/.test(expectedMallId) && (message.command!=="ACCELERATORS_QUERY" ||
          captured.requestMethod==="POST" && captured.requestPath==="https://agentseller-us.temu.com/api/flow/analysis/list"))return captured;
      if(attempt>=12&&!triggered)triggered=triggerProductSearch();
      await wait(250);
    }
    throw Error("美国站流量页尚未产生当前店铺的原生请求，请完成登录或验证后查询");
  }
  if (kind === "flow") {
    const expectedMallId = String(message.payload?.mallId || message.payload?.requestHeaders?.mallid || "").trim();
    let refreshed = null, evidence = {}, lastOverview = {}, lastTrend = {};
    for (let attempt = 0; attempt < 120; attempt++) {
      const overview = await chrome.runtime.sendMessage({type:"GET_CAPTURED_HEADERS",tabId:message.tabId,kind:"flow"});
      const trend = await chrome.runtime.sendMessage({type:"GET_CAPTURED_HEADERS",tabId:message.tabId,kind:"flow_trend"});
      lastOverview = overview; lastTrend = trend;
      const mall = capturedHeader(overview,"mallid");
      evidence = {overview:Boolean(overview?.requestId || overview?.capturedAt),trend:Boolean(trend?.requestId || trend?.capturedAt),
        overviewPayload:Boolean(overview.payload && typeof overview.payload==="object"),trendPayload:Boolean(trend.payload && typeof trend.payload==="object"),
        mallMatch:/^\d+$/.test(mall) && (!expectedMallId || mall===expectedMallId) && capturedHeader(trend,"mallid")===mall};
      if (evidence.mallMatch && evidence.overviewPayload && evidence.trendPayload &&
          (!refreshed || [overview,trend].every(item => item.payload.timeDimension != null && item.payload.timeDimension !== "" &&
            Number(item.payload.timeDimension) === refreshed.dimension && Number(item.requestStartedAt) >= refreshed.capturedAfter))) {
        return {...overview,trendPayload:trend.payload};
      }
      const contract = verifiedUsFlowContract(overview,trend,expectedMallId,refreshed);
      if (contract) return contract;
      // Refresh only the summary's native read-only time tabs, then restore the
      // original range. The separate product-detail query has different filters.
      if (attempt >= 12 && !refreshed) {
        const range = flowSummaryRange();
        if (range) refreshed = await refreshFlowSummaryRange(range,message,expectedMallId);
      }
      await wait(250);
    }
    const error = Error("流量页尚未产生当前店铺的概览与趋势请求，请打开商品流量页并确认站点；已保留历史有效数据");
    const now = Date.now();
    error.technicalInfo = JSON.stringify({...evidence,
      bodyStatus:{overview:flowBodyStatus(lastOverview),trend:flowBodyStatus(lastTrend)},
      usContractEvidence:{rangeReady:Boolean(flowSummaryRange()),refreshed:Boolean(refreshed),
        overviewExactPost:lastOverview.requestMethod === "POST" && lastOverview.requestPath === "https://agentseller-us.temu.com/api/flow/analysis/overview",
        trendExactPost:lastTrend.requestMethod === "POST" && lastTrend.requestPath === "https://agentseller-us.temu.com/api/flow/analysis/trend",
        headersAfterRestore:Boolean(refreshed && [lastOverview,lastTrend].every(item => Number.isFinite(Number(item.headersCapturedAt)) &&
          Number(item.headersCapturedAt) >= refreshed.capturedAfter && Number(item.headersCapturedAt) <= now && now-Number(item.headersCapturedAt) < 120000))}});
    throw error;
  }
  if (kind === "products" || kind === "activities") {
    // Native requests do not always carry anti-content. The independent numeric
    // mallid from this tab's actual endpoint request is required in all cases.
    const expectedMallId = String(message.payload?.mallId || "").trim();
    let triggered = false;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const captured = await chrome.runtime.sendMessage({type:"GET_CAPTURED_HEADERS", tabId:message.tabId, kind});
      const mallId = capturedHeader(captured, "mallid");
      if (/^\d+$/.test(mallId) && (!expectedMallId || mallId === expectedMallId)) return captured;
      // USER_INFO can be ready while React is still loading the list. Preserve
      // any arriving native capture and wait for hydration before one search.
      if (attempt >= 12 && !triggered) triggered = triggerProductSearch();
      await wait(250);
    }
    const label = kind === "activities" ? "报名记录" : "商品列表";
    throw new Error(label + "尚未产生与当前店铺匹配的原生请求；请在对应页面完成登录或验证后点击查询。已保留上次数据");
  }
  if (kind !== "returns") {
    return await chrome.runtime.sendMessage({type:"GET_CAPTURED_HEADERS", tabId:message.tabId, kind});
  }

  // Temu may restore the return/refund page from its client cache without sending
  // the list request. Always trigger one native search so x-phan-data belongs to
  // the current page and current mall instead of replaying another shop's header.
  await chrome.runtime.sendMessage({type:"CLEAR_CAPTURED_REQUEST", tabId:message.tabId, kind});
  if (!triggerReturnRefundSearch()) throw new Error("未找到退货退款页面的查询按钮，请确认页面已加载完成");

  const expectedMallId = String(message.payload?.mallId || "").trim();
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const captured = await chrome.runtime.sendMessage({type:"GET_CAPTURED_HEADERS", tabId:message.tabId, kind});
    const mallId = capturedHeader(captured, "mallid");
    if (captured?.payload && capturedHeader(captured, "x-phan-data") && (!expectedMallId || mallId === expectedMallId)) {
      return captured;
    }
    await wait(250);
  }
  throw new Error("Temu 未生成当前店铺的退货退款鉴权请求，请在退货退款页面重试");
}

let wbAcceleratorPageSession = null;
async function acceleratorPageCommand(message) {
  const payload=message.payload||{}, marker=new URL(location.href).searchParams.get("wb_accelerator_status");
  if (location.origin!=="https://agentseller-us.temu.com" || location.pathname!=="/main/flux-analysis" ||
      !marker || marker!==payload.marker || !/^\d+$/.test(String(payload.mallId||""))) {
    throw Error("加速器采集仅能读取本轮独立的美国站流量页");
  }
  if (!window.TemuAcceleratorEvidence) throw Error("加速器读取器尚未加载，请重新加载扩展并刷新商家后台");
  if (payload.requireNative) {
    const captured=await prepareCapturedRequest(message,"accelerators");
    wbAcceleratorPageSession={marker,mallId:capturedHeader(captured,"mallid")};
  }
  if (wbAcceleratorPageSession?.marker!==marker || wbAcceleratorPageSession?.mallId!==payload.mallId) {
    throw Error("加速器缺少当前店铺的原生请求证据，本批未保存");
  }
  if (message.command==="ACCELERATORS_NEXT") return window.TemuAcceleratorEvidence.nextPage();
  if (message.command==="ACCELERATORS_GO_TO_PAGE") return window.TemuAcceleratorEvidence.goToPage(payload.page || payload.pageNumber);
  if (message.command==="ACCELERATORS_SET_PAGE_SIZE") return window.TemuAcceleratorEvidence.setPageSize(payload.pageSize || 100);
  if (message.command==="ACCELERATORS_ENSURE_SORT") return window.TemuAcceleratorEvidence.ensureStickySort();
  if (message.command==="ACCELERATORS_LIST_PARTITIONS") return window.TemuAcceleratorEvidence.listAcceleratorPartitions();
  if (message.command==="ACCELERATORS_SELECT_PARTITION") {
    return window.TemuAcceleratorEvidence.selectAcceleratorPartition(payload.label || payload.partition || payload.target);
  }
  return {success:true,sourceMallId:wbAcceleratorPageSession.mallId,...window.TemuAcceleratorEvidence.readPage()};
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "OPEN_COLLECTOR_MODE") {
    if (message.mode === "ads" && location.hostname === "ads.temu.com" && location.pathname.includes("login")) {
      sendResponse({success:false, waitingForLogin:true});
      return false;
    }
    document.dispatchEvent(new CustomEvent("temu-collector-open", {detail:{mode:message.mode}}));
    const overlay = document.getElementById("temuCollectorOverlay");
    const opened = Boolean(overlay && !overlay.hidden);
    sendResponse(opened
      ? {success:true}
      : {success:false, error:"采集详细窗口初始化失败，请刷新 Temu 页面后重试"});
    return false;
  }
  if (message?.type !== "TEMU_COLLECT") return false;
  if (["ACCELERATORS_PAGE","ACCELERATORS_NEXT","ACCELERATORS_GO_TO_PAGE","ACCELERATORS_SET_PAGE_SIZE","ACCELERATORS_ENSURE_SORT","ACCELERATORS_LIST_PARTITIONS","ACCELERATORS_SELECT_PARTITION"].includes(message.command)) {
    acceleratorPageCommand(message).then(sendResponse).catch(error=>sendResponse({success:false,error:String(error.message||error)}));
    return true;
  }
  const kind = ({ACCELERATORS_QUERY:"accelerators",FLOW:"flow",ORDERS:"orders",ORDER_AUDIT:"orders",PRECISE_SHIPPING:"orders",RETURNS:"returns",ADS_REPORTS:"ads",PRODUCTS:"products",ACTIVITIES:"activities"})[message.command];
  const prepare = prepareCapturedRequest(message, kind);
  const id = crypto.randomUUID();
  const timeout = setTimeout(() => {
    window.removeEventListener("message", onResult);
    sendResponse({success: false, error: "页面采集超时"});
  }, Number(message.timeout || 180000));
  function onResult(event) {
    if (event.source !== window || event.data?.source !== "temu-dashboard-page" || event.data?.id !== id) return;
    if (event.data.progress) {
      chrome.runtime.sendMessage({type:"COLLECT_PROGRESS", progress:event.data.progress}).catch(() => {});
      document.dispatchEvent(new CustomEvent("temu-collector-progress", {detail:event.data.progress}));
      return;
    }
    clearTimeout(timeout);
    window.removeEventListener("message", onResult);
    const result = event.data.result;
    if (result && typeof result === "object") {
      const {errorCode,...response} = result;
      sendResponse({...response,...(message.command === "FLOW" && result.success === false && errorCode === "FLOW_EMPTY_SUMMARY" ? {errorCode:"FLOW_EMPTY_SUMMARY"} : {})});
    } else sendResponse(result);
  }
  window.addEventListener("message", onResult);
  prepare
    .then((captured) => window.postMessage({source: "temu-dashboard-extension", id, command: message.command, payload: {...(message.payload || {}), requestHeaders:{...(captured?.headers || {}), ...(message.payload?.requestHeaders || {})}, capturedMallId:capturedHeader(captured, "mallid"), capturedPayload:captured?.payload || null, capturedTrendPayload:captured?.trendPayload || null}}, "*"))
    .catch((error) => {
      clearTimeout(timeout);
      window.removeEventListener("message", onResult);
      sendResponse({success:false, error:String(error?.message || error), ...(typeof error?.technicalInfo === "string" ? {technicalInfo:error.technicalInfo} : {})});
    });
  return true;
});

if (!document.getElementById("temuCollectorRoot")) {
  const root = document.createElement("div");
  root.id = "temuCollectorRoot";
  root.hidden = true;
  root.innerHTML = `
    <div id="temuCollectorOverlay" hidden>
      <section id="temuCollectorDialog" role="dialog" aria-modal="true">
        <header><div class="dialog-brand"><span class="dialog-logo">↻</span><div><h1>Temu 数据采集助手</h1><p id="dialogSubtitle">采集当前浏览器店铺并保存到本机</p></div></div><button id="dialogClose" aria-label="关闭">×</button></header>
        <div id="confirmView">
          <div class="confirm-grid">
            <section class="confirm-intro"><span class="eyebrow">开始新任务</span><h2 id="confirmTitle">确认开始</h2><p id="confirmMessage">采集期间 Temu 后台将被遮罩，不能操作页面。</p><ul><li>只采集当前浏览器正在登录的店铺</li><li>每个阶段完成后立即保存到本机</li><li>店铺发生变化时立即停止，避免串店</li></ul></section>
            <section class="confirm-form"><p class="local-scope-note">无需填写手机号，也不需要登录外部数据服务器。本次结果只进入这台电脑上的织品工作台。</p><div class="collector-choice"><button id="confirmStart">确认并开始</button><button id="confirmCancel" class="secondary">取消</button></div></section>
          </div>
        </div>
        <div id="progressView" hidden>
          <section class="summary"><div><span>采集来源</span><strong id="phone">当前浏览器</strong></div><div><span>当前店铺</span><strong id="shop">--</strong></div><div><span>店铺进度</span><strong id="overall">0 / 0</strong></div><div class="elapsed-card"><span>已运行</span><strong id="elapsed">00:00:00</strong></div><div class="eta-card"><span>预计剩余</span><strong id="eta">正在学习</strong></div></section>
          <div class="progress"><i id="progressBar"></i></div>
          <div class="progress-layout"><div class="progress-main"><section class="current"><span class="eyebrow">当前任务</span><strong id="stage">等待开始</strong><p id="message">正在准备</p><small id="nextStep"></small></section><section id="workStats" class="work-stats">请求 0 次 · 接收 0 KB · 平均 0 KB/s</section><section class="log-card"><div class="section-title">运行日志</div><pre id="log"></pre></section></div><aside><div class="section-title">店铺队列</div><section id="shops" class="shops"></section></aside></div>
          <footer><span>执行期间请保持此页面打开</span><div><button id="start" hidden>开始/继续</button><button id="pause" class="danger">停止任务</button><button id="reset" class="danger" hidden>清除任务</button></div></footer>
        </div>
        <div id="exitView" hidden><h2>确定退出采集？</h2><p>退出会停止当前页面命令，已经保存到本机的数据保留。</p><div class="collector-choice"><button id="confirmExit" class="danger">退出并恢复页面</button><button id="continueTask" class="secondary">继续采集</button></div></div>
        <div id="completeView" hidden><h2>本部分采集完成</h2><p id="completeMessage"></p><div class="collector-choice"><button id="runOther">采集另一部分</button><button id="finishClose" class="secondary">完成</button><button id="collectorTrafficOpen" class="secondary">打开流量加速器</button></div></div>
      </section>
    </div>`;
  document.documentElement.appendChild(root);
}
