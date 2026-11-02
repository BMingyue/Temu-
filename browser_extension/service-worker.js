// Chrome loads this file as a service worker and needs the imports below.
// Firefox loads the same dependency list as background scripts from the manifest;
// importScripts is unavailable in that document context, so guard the call.
if (typeof importScripts === "function") importScripts("traffic-background.js", "workbench-config.js", "workbench-sync.js", "workbench-auto.js", "product-status-sync.js", "workbench-daily-audit.js", "extension-features.js");

// Reattach only the local UI bridge after extension reload. Existing workbench
// tabs retain their UI state; no seller tab, collector or traffic task is run.
async function wbReconnectLocalWebBridges() {
  if (typeof chrome.scripting?.executeScript !== "function" || typeof chrome.tabs?.query !== "function") return {attempted:0,connected:0};
  const tabs = await chrome.tabs.query({url:["http://127.0.0.1:5173/*"]});
  const targets = tabs.filter(tab => {
    try { return Number.isInteger(tab.id) && new URL(tab.url || "").origin === "http://127.0.0.1:5173"; } catch { return false; }
  });
  const results = await Promise.allSettled(targets.map(tab => chrome.scripting.executeScript({target:{tabId:tab.id,frameIds:[0]},files:["workbench-web-bridge.js"]})));
  return {attempted:targets.length,connected:results.filter(result => result.status === "fulfilled").length};
}
wbReconnectLocalWebBridges().catch(() => {});
chrome.runtime.onStartup?.addListener(() => { wbReconnectLocalWebBridges().catch(() => {}); });

chrome.runtime.onInstalled.addListener(async () => {
  await wbReconnectLocalWebBridges().catch(() => {});
  const tabs = await chrome.tabs.query({url:["https://agentseller-us.temu.com/*","https://agentseller.temu.com/*","https://ads.temu.com/*"]});
  await Promise.all(tabs.filter((tab) => tab.id).map((tab) => chrome.tabs.reload(tab.id).catch(() => null)));
});

const capturedRequests = new Map();
const pendingCapturedRequests = new Map();
const CAPTURE_TTL = 120000;
let captureSequence = 0;
const captureBodyErrorCategory = error => {
  if (!error) return null;
  const text = String(error);
  if (/permission|denied|access/i.test(text)) return "access_denied";
  if (/unavailable|not available|unsupported|not supported/i.test(text)) return "unavailable";
  if (/failed|failure|unable|cannot|could not|error/i.test(text)) return "read_failed";
  return "other";
};
const captureRequestPath = url => {
  try { const parsed = new URL(url); return parsed.origin + parsed.pathname; }
  catch { return ""; }
};
const pruneCaptures = () => {
  const cutoff = Date.now() - CAPTURE_TTL;
  for (const cache of [capturedRequests,pendingCapturedRequests]) {
    for (const [key,capture] of cache) if (capture.capturedAt <= cutoff) cache.delete(key);
  }
};
const clearTabCaptures = tabId => {
  for (const cache of [capturedRequests,pendingCapturedRequests]) {
    for (const key of cache.keys()) if (key.startsWith(tabId + ":")) cache.delete(key);
  }
};
const captureRequestPart = (details,kind,part) => {
  pruneCaptures();
  // Requests for the same endpoint can overlap while React changes filters.
  // Pair body and headers by request id before publishing the latest request.
  const key = `${details.tabId}:${kind}:${details.requestId}`;
  const capture = {...(pendingCapturedRequests.get(key) || {payload:null,sequence:++captureSequence,
    requestBodyDiagnostics:{method:String(details.method || "").toUpperCase(),hasBeforeRequest:false,
      bodyError:null,rawPartCount:0,rawByteTotal:0,parseError:false}}),
    ...part,requestId:details.requestId,capturedAt:Date.now()};
  pendingCapturedRequests.set(key,capture);
  const publishedKey = `${details.tabId}:${kind}`;
  const previous = capturedRequests.get(publishedKey);
  if (capture.headers && (!previous || capture.sequence >= previous.sequence)) capturedRequests.set(publishedKey,capture);
};
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === "loading" || change.url) clearTabCaptures(tabId);
});
chrome.tabs.onRemoved.addListener(clearTabCaptures);
chrome.webRequest.onBeforeRequest.addListener((details) => {
  const kind = details.url.includes("recentOrderList") ? "orders" : details.url.includes("queryReturnAndRefundPaList") ? "returns" : details.url.includes("/visage-agent-seller/product/skc/pageQuery") ? "products" : details.url.includes("/api/kiana/gamblers/marketing/enroll/list") ? "activities" : details.url.includes("/api/flow/analysis/list") ? "flow_list" : details.url.includes("/api/flow/analysis/overview") ? "flow" : details.url.includes("/api/flow/analysis/trend") ? "flow_trend" : "";
  if (!kind) return;
  let payload = null;
  let parseError = false;
  const chunks = Array.isArray(details.requestBody?.raw) ? details.requestBody.raw : [];
  try {
    if (chunks.length && chunks.every(chunk => chunk.bytes)) {
      const decoder = new TextDecoder();
      payload = JSON.parse(chunks.map(chunk => decoder.decode(chunk.bytes,{stream:true})).join("") + decoder.decode());
    }
  } catch { parseError = true; }
  const requestBodyDiagnostics = {method:String(details.method || "").toUpperCase(),hasBeforeRequest:true,
    bodyError:captureBodyErrorCategory(details.requestBody?.error),rawPartCount:chunks.length,
    rawByteTotal:chunks.reduce((total,chunk) => total + Number(chunk?.bytes?.byteLength || 0),0),parseError};
  captureRequestPart(details,kind,{payload,requestStartedAt:Date.now(),requestBodyDiagnostics});
}, {urls:["https://agentseller-us.temu.com/*","https://agentseller.temu.com/*"]}, ["requestBody"]);

chrome.webRequest.onBeforeSendHeaders.addListener((details) => {
  const kind = details.url.includes("recentOrderList") ? "orders" : details.url.includes("queryReturnAndRefundPaList") ? "returns" : details.url.includes("/visage-agent-seller/product/skc/pageQuery") ? "products" : details.url.includes("/api/kiana/gamblers/marketing/enroll/list") ? "activities" : details.url.includes("/api/flow/analysis/list") ? "flow_list" : details.url.includes("/api/flow/analysis/overview") ? "flow" : details.url.includes("/api/flow/analysis/trend") ? "flow_trend" : details.url.includes("queryReports") ? "ads" : "";
  if (!kind) return;
  const forbidden = new Set(["cookie","content-length","host","origin","referer","user-agent","accept-encoding","connection"]);
  const headers = {};
  for (const item of details.requestHeaders || []) {
    const name = String(item.name || "").toLowerCase();
    if (!name.startsWith(":") && !name.startsWith("sec-") && !forbidden.has(name) && item.value) headers[item.name] = item.value;
  }
  // These fields describe this actual wire-header event, independently of
  // caller payloads and of whether Chrome exposed its native request body.
  captureRequestPart(details,kind,{headers,requestMethod:String(details.method || "").toUpperCase(),
    requestPath:captureRequestPath(details.url),headersCapturedAt:Date.now()});
}, {urls:["https://agentseller-us.temu.com/*","https://agentseller.temu.com/*","https://ads.temu.com/*"]}, ["requestHeaders","extraHeaders"]);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "OPEN_COLLECTOR") {
    (async () => {
      if(globalThis.wbTrafficActive)throw Error("流量加速器正在运行，请先停止再采集");
      const mode = message.mode === "ads" ? "ads" : message.mode === "products" ? "products" : "seller";
      const seller = mode !== "ads";
  const matches = seller ? ["https://agentseller-us.temu.com/*","https://agentseller.temu.com/*"] : ["https://ads.temu.com/*"];
      const url = mode === "products" ? "https://agentseller.temu.com/goods/list" : seller ? "https://agentseller.temu.com/main/flux-analysis" : "https://ads.temu.com/ad-list.html";
      const launch={mode,at:Date.now()};
      await chrome.storage.local.set({"temuCollectorLaunch.v1":launch});
      const tabs = await chrome.tabs.query({url:matches});
      let tab = tabs.find((item) => item.active) || tabs[0];
      if (!tab) {
        tab = await chrome.tabs.create({url,active:true});
        sendResponse({success:true,tabId:tab.id,delivered:false,navigating:true});
        return;
      }
      await chrome.tabs.update(tab.id,{active:true});
      const delivery = await chrome.tabs.sendMessage(tab.id,{type:"OPEN_COLLECTOR_MODE",...launch}).catch(()=>null);
      const delivered = delivery?.success===true;
      if (delivered) {
        await chrome.storage.local.remove("temuCollectorLaunch.v1");
        sendResponse({success:true,tabId:tab.id,delivered:true});
        return;
      }
      if (delivery?.waitingForLogin) {
        sendResponse({success:true,tabId:tab.id,delivered:false,waitingForLogin:true});
        return;
      }
      // 扩展刚重新加载时，旧 Temu 标签页没有新版 content script。
      // 刷新一次后由 LAUNCH_KEY 在新脚本初始化阶段自动打开详细窗口。
      await chrome.tabs.reload(tab.id);
      sendResponse({success:true,tabId:tab.id,delivered:false,reloading:true});
    })().catch((error)=>sendResponse({success:false,error:String(error)}));
    return true;
  }
  if (message?.type === "DATABASE_API") {
    (async () => {
      if (_sender.id !== chrome.runtime.id) throw new Error("本地采集接口来源无效");
      sendResponse(await wbLocalDatabaseApi(message));
    })().catch((error) => sendResponse({ok:false,status:0,error:String(error)}));
    return true;
  }
  if (message?.type === "CURRENT_TAB") {
    sendResponse({tabId: _sender.tab?.id || null, url: _sender.tab?.url || ""});
    return false;
  }
  if (message?.type === "CURRENT_MALL") {
    (async () => {
      const tab=await chrome.tabs.get(message.tabId);
      const url=new URL(tab.url||"");
      if(!["agentseller.temu.com","agentseller-us.temu.com"].includes(url.hostname))throw new Error("当前页面不是 Temu 商家后台");
      const cookie=await chrome.cookies.get({url:url.origin+"/",name:"mallid"});
      sendResponse({mallId:String(cookie?.value||"")});
    })().catch((error)=>sendResponse({error:String(error.message||error)}));
    return true;
  }
  if (message?.type === "TAB_MESSAGE") {
    chrome.tabs.sendMessage(message.tabId, message.message).then(sendResponse).catch((error) => sendResponse({success:false,error:String(error)}));
    return true;
  }
  if (message?.type === "TAB_UPDATE") {
    chrome.tabs.update(message.tabId, message.update || {}).then((tab) => sendResponse({success:true,tabId:tab.id})).catch((error) => sendResponse({success:false,error:String(error)}));
    return true;
  }
  if (message?.type === "TAB_RELOAD") {
    chrome.tabs.reload(message.tabId).then(() => sendResponse({success:true})).catch((error) => sendResponse({success:false,error:String(error)}));
    return true;
  }
  if (message?.type === "GET_CAPTURED_HEADERS") {
    pruneCaptures();
    const captured = capturedRequests.get(`${_sender.tab?.id ?? message.tabId}:${message.kind}`);
    if (captured) {
      const {sequence,...response} = captured;
      sendResponse(response);
    } else sendResponse({headers:{},payload:null});
    return false;
  }
  if (message?.type === "CLEAR_CAPTURED_REQUEST") {
    const key = `${_sender.tab?.id ?? message.tabId}:${message.kind}`;
    capturedRequests.delete(key);
    for (const pendingKey of pendingCapturedRequests.keys()) if (pendingKey.startsWith(key + ":")) pendingCapturedRequests.delete(pendingKey);
    sendResponse({success:true});
    return false;
  }
  if (message?.type !== "TEMU_TAB") return false;
  (async () => {
    const tabs = await chrome.tabs.query({url: message.matches});
    let tab = tabs.find((item) => item.active) || tabs[0];
    if (!tab) tab = await chrome.tabs.create({url: message.url, active: true});
    else if (message.url && !String(tab.url || "").startsWith(message.url)) {
      tab = await chrome.tabs.update(tab.id, {url: message.url, active: true});
    } else {
      await chrome.tabs.update(tab.id, {active: true});
    }
    sendResponse({tabId: tab.id});
  })().catch((error) => sendResponse({error: String(error)}));
  return true;
});
