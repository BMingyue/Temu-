const STATE_KEY = "temuCollectorState.v2";
const SETTINGS_KEY = "temuCollectorSettings.v2";
const HISTORY_KEY = "temuCollectorHistory.v1";
const ETA_PROFILE_KEY = "temuCollectorEtaProfile.v1";
const LAUNCH_KEY = "temuCollectorLaunch.v1";
const $ = (id) => document.getElementById(id);
if (!$('temuCollectorRoot')) throw new Error('Temu 采集界面未加载');

const emptyStats = () => ({requests:0,bytes:0,networkMs:0,retryWaitMs:0,pages:0,rows:0,parents:0,parentTotal:0,shipping:0,returns:0,dates:0,deferredRows:0,deferredParents:0});
const freshState = (mode = "seller") => ({status:"idle",taskMode:mode,shops:[],shopIndex:0,phase:"discover",startedAt:0,logs:[],stats:emptyStats()});
let state = freshState();
let history = [];
let etaProfile = [];
let etaTracker = null;
let etaDisplay = {context:"",seconds:null,updatedAt:0};
let paused = false;
let runGeneration = 0;
let pendingMode = "seller";
let pendingLaunchContext = {};
let currentLoginMatchesSavedTask = true;
let forceFreshTask = false;
let elapsedTimer = null;
let lastWorkbenchTaskSync = 0;

const dayText = (date) => date.toLocaleDateString('sv-SE',{timeZone:'Asia/Shanghai'});
function recentDays(days) {
  const count = Math.max(1, Number(days) || 1);
  const end = new Date(), start = new Date();
  start.setDate(start.getDate() - (count - 1));
  return {startDate:dayText(start),endDate:dayText(end),dates:Array.from({length:count},(_,index)=>{const day=new Date(start);day.setDate(day.getDate()+index);return dayText(day);})};
}
const sellerCollectionRange = () => recentDays(60);
const adsCollectionRange = () => recentDays(30);
function extensionUnavailable(error) {
  const message = String(error?.message || error || "");
  if (/Extension context invalidated|context invalidated|Receiving end does not exist/i.test(message)) {
    return new Error("扩展刚刚更新，当前 Temu 页面仍是旧版本。请刷新当前页面后重试");
  }
  return error instanceof Error ? error : new Error(message || "扩展暂时不可用");
}
const storageGet = (key) => new Promise((resolve, reject) => {
  try {
    if (!chrome.runtime?.id) throw new Error("Extension context invalidated");
    chrome.storage.local.get(key, (value) => {
      const error = chrome.runtime.lastError;
      if (error) reject(extensionUnavailable(error));
      else resolve(value[key]);
    });
  } catch (error) { reject(extensionUnavailable(error)); }
});
const storageSet = (value) => new Promise((resolve, reject) => {
  try {
    if (!chrome.runtime?.id) throw new Error("Extension context invalidated");
    chrome.storage.local.set(value, () => {
      const error = chrome.runtime.lastError;
      if (error) reject(extensionUnavailable(error));
      else resolve();
    });
  } catch (error) { reject(extensionUnavailable(error)); }
});
const runtime = async (message) => {
  try {
    if (!chrome.runtime?.id) throw new Error("Extension context invalidated");
    return await chrome.runtime.sendMessage(message);
  } catch (error) { throw extensionUnavailable(error); }
};
const currentTab = async () => (await runtime({type:"CURRENT_TAB"})).tabId;
const tabMessage = (tabId, message) => runtime({type:"TAB_MESSAGE",tabId,message});
const tabUpdate = (tabId, update) => runtime({type:"TAB_UPDATE",tabId,update});
const tabReload = (tabId) => runtime({type:"TAB_RELOAD",tabId});
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g,(char)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[char]);
const formatDuration = (seconds) => { const rounded=Math.max(1,Math.round(seconds));return rounded<60?`${rounded}秒`:`${Math.floor(rounded/60)}分${rounded%60}秒`; };
const formatElapsed = (milliseconds) => { const seconds=Math.max(0,Math.floor(milliseconds/1000)),hours=Math.floor(seconds/3600),minutes=Math.floor((seconds%3600)/60),rest=seconds%60;return [hours,minutes,rest].map((value)=>String(value).padStart(2,"0")).join(":"); };
const formatAge = (time) => { if (!time) return "没有采集记录"; const days=Math.floor((Date.now()-time)/86400000); return days<1?"今天":`${days}天前`; };

function workbenchTaskSnapshot() {
  const progress=Math.round(progressPercent()*10)/10;
  return {status:state.status,taskMode:state.taskMode,phase:state.phase,message:String(state.message||""),progress,eta:etaText(progress),startedAt:state.startedAt||0,endedAt:state.endedAt||0,stats:{...(state.stats||{})}};
}
function syncTaskToWorkbench(force=false) {
  if(!chrome.runtime?.id)return;
  const now=Date.now();if(!force&&now-lastWorkbenchTaskSync<1500)return;lastWorkbenchTaskSync=now;
  runtime({type:"WORKBENCH_TASK_PROGRESS",state:workbenchTaskSnapshot()}).catch(()=>{});
}
async function save() { await storageSet({[STATE_KEY]:state}); render(); syncTaskToWorkbench(true); }
function log(message) { state.logs=[...(state.logs||[]),`${new Date().toLocaleTimeString()} ${message}`].slice(-120); render(); }
function currentShop() { return state.shops?.[state.shopIndex] || null; }
function phaseLabel(value) { return ({discover:"读取账号与店铺",products:"采集在售商品",activities:"采集活动报名",flow:"采集流量",orders:"采集订单列表",money:"补全订单金额",shipping:"采集精准物流费用",returns:"采集退货退款",ads:"采集广告",done:"本部分完成"})[value]||value; }
const flowDimensionLabel = (value) => ({0:"实时",1:"近1日",2:"本周",3:"本月",4:"近7日",5:"近30日"})[Number(value)]||`维度 ${value}`;
function nextLabel() { return ({discover:"识别当前浏览器店铺",products:"保存商品后继续采集活动",activities:"保存活动数据",flow:"保存流量后采集订单",orders:"补齐订单金额",money:"保存订单后查询精准物流费用",shipping:"保存物流费用后采集退货退款",returns:"保存退货退款",ads:"保存当前店铺广告",done:"可选择采集另一部分"})[state.phase]||"继续"; }
function phaseWeight() { return state.taskMode==="ads" ? ({discover:0,ads:.15,done:1}[state.phase]||0) : state.taskMode==="products" ? ({discover:0,products:.25,activities:.65,done:1}[state.phase]||0) : ({discover:0,flow:.1,orders:.3,money:.52,shipping:.7,returns:.86,done:1}[state.phase]||0); }
function progressPercent() { return state.shops.length ? Math.min(100,((state.shopIndex+phaseWeight())/state.shops.length)*100) : 0; }
function median(values) {
  const sorted=(values||[]).map(Number).filter((value)=>Number.isFinite(value)&&value>0).sort((a,b)=>a-b);
  if(!sorted.length)return null;
  const middle=Math.floor(sorted.length/2);
  return sorted.length%2?sorted[middle]:(sorted[middle-1]+sorted[middle])/2;
}
function recentEtaSamples(kind,limit=16) {
  return (etaProfile||[]).filter((item)=>item?.kind===kind&&Number(item.duration)>0).slice(-limit);
}
function legacySecondsPerShop() {
  return median(history.filter((item)=>item.mode===state.taskMode&&Number(item.shopCount)>0).slice(-8).map((item)=>Number(item.duration)/Number(item.shopCount)));
}
function observeEtaProgress(progress={}) {
  if(progress.stage!=="money")return;
  const current=Math.max(0,Number(progress.current)||0),total=Math.max(0,Number(progress.total)||0),now=Date.now();
  const key=`money:${state.shopIndex}`;
  if(!etaTracker||etaTracker.key!==key||current<etaTracker.lastCurrent){
    etaTracker={key,kind:"money",shopIndex:state.shopIndex,startedAt:now,firstCurrent:current,lastCurrent:current,total,points:[{at:now,current}]};
  }else{
    etaTracker.total=Math.max(etaTracker.total||0,total);
    if(current!==etaTracker.lastCurrent||now-etaTracker.points.at(-1).at>=1000){
      etaTracker.points.push({at:now,current});
      etaTracker.points=etaTracker.points.filter((item)=>now-item.at<=120000).slice(-240);
      etaTracker.lastCurrent=current;
    }
  }
  const shop=currentShop();
  if(shop&&total>0)shop.etaMoneyTotal=total;
}
function liveMoneySecondsPerUnit() {
  if(!etaTracker||etaTracker.kind!=="money"||etaTracker.shopIndex!==state.shopIndex)return null;
  const points=etaTracker.points||[],last=points.at(-1);
  if(!last)return null;
  const first=points.find((item)=>last.current-item.current>=10&&last.at-item.at>=2000);
  if(!first)return null;
  return ((Math.max(Date.now(),last.at)-first.at)/1000)/(last.current-first.current);
}
function historicalMoneySecondsPerUnit(total) {
  const samples=recentEtaSamples("money",24).filter((item)=>Number(item.units)>0&&Number(item.secondsPerUnit)>0);
  if(!samples.length)return null;
  const target=Math.max(1,Number(total)||1);
  const closest=[...samples].sort((a,b)=>Math.abs(Math.log(Number(a.units)/target))-Math.abs(Math.log(Number(b.units)/target))).slice(0,8);
  return median(closest.map((item)=>item.secondsPerUnit));
}
function blendedMoneySecondsPerUnit(total) {
  const live=liveMoneySecondsPerUnit(),historical=historicalMoneySecondsPerUnit(total);
  if(!live)return historical;
  if(!historical)return live;
  const points=etaTracker?.points||[],first=points[0],last=points.at(-1);
  const observed=Math.max(0,Number(last?.current||0)-Number(first?.current||0));
  const elapsed=Math.max(0,Number(last?.at||0)-Number(first?.at||0))/1000;
  const liveWeight=Math.min(.9,Math.max(.35,observed/500,elapsed/90));
  return live*liveWeight+historical*(1-liveWeight);
}
function sellerShopEstimate(shop,referenceMoneyUnits) {
  const mallId=String(shop?.database_mall_id||shop?.mall_id||"");
  const exact=recentEtaSamples("seller_shop",40).filter((item)=>mallId&&String(item.mallId||"")===mallId);
  const candidates=(exact.length?exact:recentEtaSamples("seller_shop",16)).slice(-8);
  if(candidates.length){
    if(exact.length)return median(candidates.map((item)=>item.duration));
    const target=Math.max(0,Number(referenceMoneyUnits)||0);
    const estimates=candidates.map((item)=>{
      const duration=Number(item.duration)||0,moneyDuration=Number(item.moneyDuration)||0,units=Number(item.moneyUnits)||0;
      if(target>0&&units>0&&moneyDuration>0)return Math.max(0,duration-moneyDuration)+moneyDuration*(target/units);
      return duration;
    });
    return median(estimates);
  }
  const legacy=legacySecondsPerShop();
  const secondsPerUnit=blendedMoneySecondsPerUnit(referenceMoneyUnits);
  const workload=secondsPerUnit&&referenceMoneyUnits>0?secondsPerUnit*referenceMoneyUnits:null;
  if(workload&&legacy)return Math.max(workload,legacy);
  return workload||legacy;
}
function moneyTailEstimate() {
  return median(recentEtaSamples("seller_shop",20).map((item)=>item.tailAfterMoney));
}
function dataDrivenEtaSeconds() {
  if(state.phase!=="money"||Number(state.stats?.parentTotal||0)<=0)return null;
  const total=Number(state.stats.parentTotal),current=Math.min(total,Math.max(0,Number(state.stats.parents)||0));
  const secondsPerUnit=blendedMoneySecondsPerUnit(total);
  if(!secondsPerUnit)return null;
  let seconds=(total-current)*secondsPerUnit+(moneyTailEstimate()||0);
  for(let index=state.shopIndex+1;index<(state.shops||[]).length;index++)seconds+=sellerShopEstimate(state.shops[index],total)||0;
  return Math.max(1,seconds);
}
function smoothEtaSeconds(raw,source="fallback") {
  if(!Number.isFinite(raw)||raw<=0)return null;
  const context=`${state.taskMode}:${state.shopIndex}:${state.phase}:${source}`,now=Date.now();
  if(etaDisplay.context!==context||!Number.isFinite(etaDisplay.seconds)){etaDisplay={context,seconds:raw,updatedAt:now};return raw;}
  if(now-etaDisplay.updatedAt<1000)return etaDisplay.seconds;
  etaDisplay.seconds=etaDisplay.seconds*.72+raw*.28;etaDisplay.updatedAt=now;return etaDisplay.seconds;
}
function etaResult(seconds,source) {
  const smoothed=smoothEtaSeconds(seconds,source);
  if(!smoothed)return null;
  const completedAt=new Date(Date.now()+smoothed*1000).toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit",hour12:false});
  return `约 ${formatDuration(smoothed)} · ${completedAt}完成`;
}
function etaText(progress) {
  if (state.status !== "running") return state.status === "done" ? "已完成" : "尚未开始";
  const workloadEta=etaResult(dataDrivenEtaSeconds(),"workload");
  if(workloadEta)return workloadEta;
  const elapsed=Math.max(1,(Date.now()-state.startedAt)/1000);
  const secondsPerShop=legacySecondsPerShop();
  if (secondsPerShop) {
    const remaining=Math.max(0,state.shops.length-state.shopIndex-phaseWeight());
    return etaResult(secondsPerShop*remaining,"history")||"正在根据数据量学习";
  }
  return progress>=8 ? etaResult(elapsed*(100-progress)/progress,"progress")||"正在根据数据量学习" : "正在根据数据量学习";
}
function render() {
  const shop=currentShop(), progress=progressPercent(), stats=state.stats||emptyStats();
  $("phone").textContent=state.browserLabel||"当前浏览器";
  $("shop").textContent=shop?`${shop.name} (${state.shopIndex+1}/${state.shops.length})`:"--";
  $("overall").textContent=`${Math.min(state.shopIndex,state.shops.length)} / ${state.shops.length}`;
  $("stage").textContent=phaseLabel(state.phase);
  $("message").textContent=state.message||"正在准备";
  $("nextStep").textContent=`下一步：${nextLabel()}`;
  $("progressBar").style.width=`${progress}%`;
  $("eta").textContent=etaText(progress);
  $("elapsed").textContent=state.startedAt?formatElapsed((state.endedAt||Date.now())-state.startedAt):"00:00:00";
  $("shops").innerHTML=(state.shops||[]).map((item,index)=>{
    const disabled=Boolean(item.ads_collection_disabled),status=disabled?"无需采集广告":item.status||(index===state.shopIndex?phaseLabel(state.phase):"等待");
    const control=state.taskMode==="ads"?`<button class="shop-ad-toggle ${disabled?"is-disabled":""}" data-shop-index="${index}" type="button">${disabled?"恢复广告采集":"无需广告"}</button>`:"";
    return `<div class="shop-row"><strong>${escapeHtml(item.name)}</strong><div class="shop-row-actions"><span>${escapeHtml(status)}</span>${control}</div><small>${escapeHtml(item.mall_id)}</small></div>`;
  }).join("");
  $("log").textContent=(state.logs||[]).join("\n");
  const speed=stats.networkMs?stats.bytes/(stats.networkMs/1000)/1024:0;
  const moneyProgress=stats.parentTotal>0?`${stats.parents}/${stats.parentTotal}`:String(stats.parents||0);
  $("workStats").textContent=`请求 ${stats.requests} 次 · 接收 ${(stats.bytes/1024).toFixed(1)} KB · 平均 ${speed.toFixed(1)} KB/s · 订单 ${stats.rows} 行 · 待补金额 ${moneyProgress} 个父订单 · 物流 ${stats.shipping||0} 条 · 退款 ${stats.returns} 项 · 广告 ${stats.dates} 天`;
  const canContinue=(state.status==="failed"||state.status==="paused")&&state.phase!=="done";
  $("start").hidden=!canContinue;
  $("start").disabled=!canContinue;
  $("start").textContent="继续任务";
  $("pause").disabled=state.status!=="running";
  $("reset").hidden=!canContinue;
}
function syncElapsedTimer() { if(elapsedTimer){clearInterval(elapsedTimer);elapsedTimer=null;}if(state.status==="running")elapsedTimer=setInterval(()=>{if($("elapsed"))$("elapsed").textContent=formatElapsed(Date.now()-state.startedAt);if($("eta"))$("eta").textContent=etaText(progressPercent());},1000); }
function showView(name) {
  for (const id of ["confirmView","progressView","exitView","completeView"]) $(id).hidden=id!==name;
  $("temuCollectorOverlay").hidden=false;
}
function closeOverlay() { $("temuCollectorOverlay").hidden=true; }
function settings() { return {}; }
function normalizedErrorText(error) { return String(error?.message||error||"").trim().replace(/^(?:Error|TypeError):\s*/i,""); }
function friendlyErrorMessage(error, fallback="操作失败，请稍后重试") {
  const raw=normalizedErrorText(error);
  if(!raw)return fallback;
  if(/extension context invalidated|receiving end does not exist|message port closed/i.test(raw))return "插件刚刚更新，请刷新当前 Temu 页面后重试";
  if(/invalid login state|not logged|login.*expired|登录.*(失效|异常|过期|无效)/i.test(raw))return "Temu 账号未登录或登录已失效，请重新登录";
  if(/no permission|permission denied|forbidden|无权限|没有权限/i.test(raw)||/^403\b/.test(raw))return "当前账号没有权限访问这项数据，请确认登录账号";
  if(/too many visitors|^429\b/i.test(raw))return "Temu 当前访问人数过多，请稍后继续任务";
  if(/failed to fetch|networkerror|network timeout|load failed|连接.*失败|网络.*(异常|超时)/i.test(raw))return "网络连接异常，请检查网络后继续任务";
  if(/cannot connect to postgresql|deadlock detected|database.*timeout|数据库.*(连接|超时)/i.test(raw))return "数据库暂时无法连接，请稍后继续任务";
  if(/^401\b/.test(raw))return "账号登录已失效，请重新登录";
  if(/^404\b/.test(raw))return "没有找到对应的账号、店铺或数据，请确认后重试";
  if(/^5\d\d\b/.test(raw))return "数据服务暂时异常，请稍后重试";
  if(/^4\d\d\b/.test(raw)||/\{\s*"error_(?:code|msg)"/i.test(raw))return fallback;
  return raw;
}
function errorWithTechnicalInfo(message, technicalInfo="", errorCode="") { const error=new Error(message);error.technicalInfo=String(technicalInfo||"");if(errorCode==="FLOW_EMPTY_SUMMARY")error.errorCode=errorCode;return error; }
function technicalErrorInfo(error) { return String(error?.technicalInfo||"").trim(); }
function logTechnicalError(error) { const technical=technicalErrorInfo(error);if(technical)log(`技术信息：${technical}`); }
function errorDisplayText(prefix,error,fallback) {
  const message=friendlyErrorMessage(error,fallback);
  const technical=technicalErrorInfo(error);
  return `${prefix}${message}${technical?`\n技术信息：${technical}`:""}`;
}
function normalizedShopName(value) { return String(value||"").normalize("NFKC").trim().replace(/\s+/g," ").toLocaleLowerCase(); }
function databaseMallId(shop) { return String(shop?.database_mall_id||shop?.mall_id||""); }
function shopLookup(shops) {
  return {
    byMallId:new Map((shops||[]).map((shop)=>[String(shop.mall_id||""),shop]).filter(([key])=>key)),
    byName:new Map((shops||[]).map((shop)=>[normalizedShopName(shop.name),shop]).filter(([key])=>key)),
  };
}
function matchedShop(shop,lookup) { return lookup.byMallId.get(String(shop?.mall_id||""))||lookup.byName.get(normalizedShopName(shop?.name)); }
function savedTaskMatchesAuth(auth) {
  if(state.phase==="discover"&&!(state.shops||[]).length)return true;
  const saved=currentShop()||state.shops?.[0];
  const expected=String(saved?.mall_id||saved?.database_mall_id||"");
  const actual=String(auth?.current_mall_id||auth?.mallId||"");
  return Boolean(expected&&actual&&expected===actual);
}
async function api(path, options={}) {
  const result=await runtime({type:"DATABASE_API",path,method:options.method||"GET",body:options.body});
  state.stats.requests+=1; state.stats.bytes+=Number(result?.bytes||0); state.stats.networkMs+=Number(result?.durationMs||0);
  const data=result?.data||{};
  if (!result?.ok) {
    const detail=typeof data.detail==="string"?data.detail:String(data.detail?.message||data.error_msg||data.error||result?.error||"");
    const status=Number(result?.status||0);
    const fallback=status===403?"本地接口拒绝了当前扩展":status===404?"本地工作台没有找到对应店铺":status>=500?"本地数据服务暂时异常，请稍后重试":"无法连接本地工作台，请确认工作台已启动";
    const errorCode=Number(data?.error_code??data?.errorCode);
    const technical=[status>0?`看板 HTTP ${status}`:"",String(path||"").split("?",1)[0],Number.isFinite(errorCode)?`错误码 ${errorCode}`:""].filter(Boolean).join(" · ");
    const translated=friendlyErrorMessage(detail,fallback);
    const detailWasTranslated=Boolean(detail)&&translated!==normalizedErrorText(detail);
    const message=([401,403,404].includes(status)||(status>=500&&!detailWasTranslated))?fallback:translated;
    throw errorWithTechnicalInfo(message,technical);
  }
  return data;
}
async function temuTab(kind="seller") {
  const seller=kind!=="ads", sellerMatches=["https://agentseller-us.temu.com/*","https://agentseller.temu.com/*"];
  if (seller && (location.hostname==="agentseller-us.temu.com" || location.hostname==="agentseller.temu.com")) return currentTab();
  const response=await runtime({type:"TEMU_TAB",matches:seller?sellerMatches:["https://ads.temu.com/*"],url:kind==="products"?"https://agentseller.temu.com/goods/list":seller?"https://agentseller.temu.com/main/flux-analysis":"https://ads.temu.com/ad-list.html"});
  if (response?.error) throw new Error(response.error);
  return response.tabId;
}
async function collect(tabId, command, payload={}, timeout=180000, generation=runGeneration, maxAttempts=20) {
  let lastError="";
  let lastTechnicalInfo="";
  for (let attempt=0;attempt<maxAttempts;attempt+=1) {
    if (generation!==runGeneration||paused) throw new Error("任务已停止");
    try { const result=await tabMessage(tabId,{type:"TEMU_COLLECT",tabId,command,payload,timeout}); if (!result?.success) throw errorWithTechnicalInfo(result?.error||`${command} 失败`,result?.technicalInfo,command==="FLOW"?result?.errorCode:""); return result; }
    catch(error) { if(generation!==runGeneration||paused) throw new Error("任务已停止");if(error?.errorCode==="FLOW_EMPTY_SUMMARY")throw error;lastError=friendlyErrorMessage(error);lastTechnicalInfo=technicalErrorInfo(error)||lastTechnicalInfo;if(/未登录|登录已失效|没有权限/.test(lastError))throw errorWithTechnicalInfo(lastError,lastTechnicalInfo);await new Promise((resolve)=>setTimeout(resolve,1000)); }
  }
  throw errorWithTechnicalInfo(lastError,lastTechnicalInfo);
}
async function sellerAuth(tabId){
  const info=await collect(tabId,"USER_INFO",{},15000,runGeneration,1);
  if(!/^\d+$/.test(String(info.current_mall_id||""))){
    const cookie=await runtime({type:"CURRENT_MALL",tabId});
    info.current_mall_id=String(cookie?.mallId||"");
  }
  return info;
}
async function setActiveShop(shop) { await api("/api/client/accounts/active-shop",{method:"POST",body:{phone:state.phone,mall_id:databaseMallId(shop)}}); }
function sellerRequestHeaders(shop){return {mallid:String(shop?.mall_id||"")};}
async function prepareAdsAccountScopeFromCurrentLogin(tabId) {
  let auth;
  try{
    auth=await collect(tabId,"ADS_AUTH_STATUS",{},15000,runGeneration,1);
  }catch(error){
    throw new Error("广告平台未登录或登录已失效，请先登录后重新检查");
  }
  const mallId=String(auth.mallId||"").trim();
  const mallName=String(auth.mallName||"").trim();
  if(!mallId)throw new Error("无法识别当前广告店铺，请确认广告平台已登录");
  const current=(auth.shops||[]).find(shop=>String(shop.mall_id||"")===mallId)||{mall_id:mallId,name:mallName||`店铺 ${mallId}`};
  state.phone="";
  state.shops=[{...current,mall_id:mallId,name:String(current.name||mallName||`店铺 ${mallId}`),database_mall_id:mallId,database_name:String(current.name||mallName||`店铺 ${mallId}`),status:"等待"}];
  state.shopIndex=0;
  state.phase="ads";
  log(`已锁定当前浏览器广告店铺 ${mallName||mallId}`);
  return auth;
}
async function switchSeller(tabId,shop) {
  state.message=`正在核对当前浏览器店铺：${shop.name}`;await save();
  const verified=await collect(tabId,"VERIFY_SELLER_SHOP",{name:shop.name,mallId:String(shop.mall_id||"")},30000,runGeneration,1);
  if(!verified.matches||verified.refreshNotice)throw new Error(`当前浏览器店铺已变化：任务店铺 ${shop.name}（${shop.mall_id}），页面 mallId ${verified.currentMallId||"未知"}、名称 ${verified.currentShop||"未知店铺"}；已停止以避免数据串店`);
  if(!verified.nameMatches)log(`店铺名称组件尚未加载，但 mallId ${verified.currentMallId} 已与任务店铺精确一致，继续执行请求级校验`);
  shop.status=state.phase==="flow"?"店铺已确认，准备采集流量":shop.status;return "ready";
}
async function discover() {
  const tabId=await temuTab("seller"), info=await sellerAuth(tabId);
  const mallId=String(info.current_mall_id||"").trim();
  if(!/^\d+$/.test(mallId))throw new Error("无法识别当前浏览器正在使用的店铺，请刷新商家后台后重试");
  const current=(info.shops||[]).find(shop=>String(shop.mall_id||"")===mallId)||{mall_id:mallId,name:`店铺 ${mallId}`};
  state.phone="";state.loginPhone="";
  state.shops=[{...current,mall_id:mallId,name:String(current.name||`店铺 ${mallId}`),database_mall_id:mallId,database_name:String(current.name||`店铺 ${mallId}`),status:"等待"}];
  state.shopIndex=0;
  state.phase=state.taskMode==="ads"?"ads":state.taskMode==="products"?"products":"flow";log(`已锁定当前浏览器店铺：${state.shops[0].name}（${mallId}）`);await save();
}
function usableFlowItem(item){return ['impressionCount','clickCount','orderPayOrderNum','orderPayGoodsNum','clickImpressionRate','clickOrderRatio','orderPayImpressionRate'].some(key=>typeof item?.data?.result?.[key]==='number'&&Number.isFinite(item.data.result[key]));}
function flowWarningsText(){return [...new Set((state.shops||[]).map(shop=>shop.flowWarning).filter(Boolean))].join('；');}
async function runFlow(tabId,shop){
  await setActiveShop(shop);
  let pending=state.pendingFlow?.shopIndex===state.shopIndex&&String(state.pendingFlow.mallId||shop.mall_id)===String(shop.mall_id)?state.pendingFlow:null;
  if(pending&&!Array.isArray(pending.plannedDimensions)){
    pending.plannedDimensions=[0,1,4,5,2,3];pending.completedDimensions=(pending.items||[]).filter(usableFlowItem).map(item=>Number(item.time_dimension));
  }
  if(!pending){
    const plan=await api("/api/client/flow/plan",{method:"POST",body:{phone:state.phone,mall_id:databaseMallId(shop),requested_time_dimension:0}});
    const dimensions=[...new Set([...(plan.dimensions||[]).map(Number),0,1,4,5,2,3])].filter(v=>Number.isInteger(v)&&v>=0&&v<=5);
    pending={shopIndex:state.shopIndex,mallId:String(shop.mall_id),plannedDimensions:dimensions,completedDimensions:[],items:[]};
    state.pendingFlow=pending;await save();
  }
  const dimensions=pending.plannedDimensions.map(Number);
  const completed=new Set((pending.completedDimensions||[]).map(Number));
  const empty=new Set((pending.emptyDimensions||[]).map(Number));
  state.message=`等待 ${shop.name} 页面自身流量请求结束，避免与采集请求冲突`;await save();
  const prepared=await collect(tabId,"PREPARE_FLOW",{},30000,runGeneration,1);
  for(const dimension of dimensions){
    if(completed.has(dimension))continue;
    state.message=`页面已稳定（等待 ${(Number(prepared.waitedMs||0)/1000).toFixed(1)} 秒），正在采集 ${shop.name} ${flowDimensionLabel(dimension)}（${completed.size+1}/${dimensions.length}）`;await save();
    let result;
    try{result=await collect(tabId,"FLOW",{dimensions:[dimension],requestHeaders:sellerRequestHeaders(shop)},240000,runGeneration,1);}
    catch(error){
      if(error?.errorCode!=="FLOW_EMPTY_SUMMARY")throw error;
      empty.add(dimension);pending.emptyDimensions=[...empty];state.pendingFlow=pending;
      state.message=`${shop.name} ${flowDimensionLabel(dimension)}流量为空，保留该范围历史有效数据，继续其他范围`;shop.status=state.message;log(state.message);await save();continue;
    }
    if(!result.items?.length||result.items.some(item=>!usableFlowItem(item))){
      throw Error("流量汇总全部为空，未更新有效报表；请确认商品流量页的站点与查询条件");
    }
    for(const item of result.items||[]){
      const itemDimension=Number(item.time_dimension);
      pending.items=(pending.items||[]).filter((existing)=>Number(existing.time_dimension)!==itemDimension);
      pending.items.push(item);
    }
    empty.delete(dimension);pending.emptyDimensions=[...empty];completed.add(dimension);pending.completedDimensions=[...completed];state.pendingFlow=pending;
    shop.status=`流量 ${completed.size}/${dimensions.length} 已保存`;await save();
  }
  if(!(pending.items||[]).length||(pending.items||[]).some(item=>!usableFlowItem(item))||!(pending.items||[]).some(item=>[0,1].includes(Number(item.time_dimension))&&usableFlowItem(item))){
    throw Error("实时和近1日流量均未取得有效数值，未更新报表；已保留历史有效数据，请确认商品流量页后继续");
  }
  await api("/api/client/flow-overviews",{method:"POST",body:{phone:state.phone,mall_id:databaseMallId(shop),store_name:shop.database_name||shop.name,items:pending.items||[]}});
  shop.flowEmptyDimensions=[...empty];shop.flowWarning=empty.size?`${[...empty].map(flowDimensionLabel).join('、')}流量为空，已保留这些范围的历史有效数据`:"";
  delete state.pendingFlow;shop.status=shop.flowWarning?`有效流量已保存；${shop.flowWarning}，准备采集订单`:"流量完成，准备采集订单";state.message=shop.status;state.phase="orders";log(`${shop.name} ${shop.status}`);await save();
}
async function runProducts(tabId,shop){
  await setActiveShop(shop);
  if(!location.pathname.includes("/goods/list")){state.resumeAfterNavigation=true;state.message=`正在进入商品页，准备采集 ${shop.name} 的在售商品`;await save();await tabUpdate(tabId,{url:"https://agentseller.temu.com/goods/list",active:true});return "navigating";}
  delete state.resumeAfterNavigation;state.message=`正在采集 ${shop.name} 的在售商品（SPU / SKC / SKU / 申报价格）`;shop.status="正在采集在售商品";await save();
  const result=await collect(tabId,"PRODUCTS",{requestHeaders:sellerRequestHeaders(shop),mallId:String(shop.mall_id||"")},600000);
  if(!result.sourceMallId||String(result.sourceMallId)!==String(shop.mall_id||""))throw new Error(`商品请求店铺校验失败：目标 ${shop.name}，请求 mallId 为 ${result.sourceMallId||"空"}；本次数据未保存`);
  const upload=await api("/api/client/products/upload",{method:"POST",body:{phone:state.phone,store_name:shop.database_name||shop.name,mall_id:databaseMallId(shop),source_mall_id:String(result.sourceMallId),source_store_name:shop.name,rows:result.rows||[],crawl_result:{source:"browser_extension",source_mall_id:String(result.sourceMallId),sale_scope:"on_sale",pages:result.pages||0,page_size:result.pageSize||100,total:result.total||0,collected_skc_count:result.collectedSkcs||0,complete:result.complete===true,completion_reason:result.completionReason||"unknown"}}});
  state.stats.rows=Number(state.stats.rows||0)+Number(upload.normalized_skus||0);shop.status=`商品完成（${upload.normalized_skus||0} 个 SKU，上架 ${upload.listed_skc_count||0} / 下架 ${upload.delisted_skc_count||0} 个 SKC），准备采集活动`;state.phase="activities";await save();return "complete";
}
async function runProductActivities(tabId,shop){
  const target="/activity/marketing-activity/log";
  if(!location.pathname.includes(target)){state.resumeAfterNavigation=true;state.message=`正在进入活动报名页，准备采集 ${shop.name} 的有效活动`;await save();await tabUpdate(tabId,{url:`https://agentseller.temu.com${target}`,active:true});return "navigating";}
  delete state.resumeAfterNavigation;state.message=`正在采集 ${shop.name} 的全部报名记录、活动价格与退出状态`;shop.status="正在采集活动报名";await save();
  const result=await collect(tabId,"ACTIVITIES",{requestHeaders:sellerRequestHeaders(shop),mallId:String(shop.mall_id||"")},600000);
  if(!result.sourceMallId||String(result.sourceMallId)!==String(shop.mall_id||""))throw new Error(`活动请求店铺校验失败：目标 ${shop.name}，请求 mallId 为 ${result.sourceMallId||"空"}；本次数据未保存`);
  const upload=await api("/api/client/products/activities/upload",{method:"POST",body:{phone:state.phone,store_name:shop.database_name||shop.name,mall_id:databaseMallId(shop),source_mall_id:String(result.sourceMallId),source_store_name:shop.name,rows:result.rows||[],crawl_result:{source:"browser_extension",source_mall_id:String(result.sourceMallId),pages:result.pages||0,page_size:result.pageSize||50,total:result.total||0,enrollment_scope:"all",source_url:"https://agentseller.temu.com/activity/marketing-activity/log",enrollment_count:result.enrollmentCount||0,complete:result.complete===true,completion_reason:result.completionReason||"unknown"}}});
  shop.status=`商品与活动完成（${upload.activities||0} 个活动）`;state.shopIndex+=1;
  if(state.shopIndex>=state.shops.length){state.phase="done";state.status="done";state.message="当前店铺的商品与活动数据已保存到本机";}else state.phase="products";await save();return "complete";
}
function currentSellerOrigin(){return (location.hostname==="agentseller-us.temu.com"||location.hostname==="agentseller.temu.com")?location.origin:"https://agentseller.temu.com";}
async function enterFlowPage(tabId,shop){if(location.pathname.includes("/main/flux-analysis"))return false;state.message=`正在进入流量页，准备采集 ${shop.name}`;await save();await tabUpdate(tabId,{url:currentSellerOrigin()+"/main/flux-analysis",active:true});return true;}
function finishSellerShop(shop){shop.status=shop.deferredParents?`本次完成，${shop.deferredParents} 个父订单待补金额`:"有效流量、订单和退货退款已保存";if(shop.flowWarning)shop.status+=`；${shop.flowWarning}`;delete state.pendingReturnRecovery;delete state.returnRecoveryAttempted;delete state.returnDataUploaded;delete state.orderRange;state.shopIndex+=1;if(state.shopIndex>=state.shops.length){state.phase="done";state.status="done";state.message=Number(state.stats.deferredParents||0)>0?`可入库数据已完成；${state.stats.deferredParents} 个父订单已记录，下次优先补金额`:"当前店铺的有效流量、订单、金额和退货退款已保存到本机";if(flowWarningsText())state.message+=`；${flowWarningsText()}`;}else state.phase="flow";}
async function appendEtaSample(sample) {
  if(!sample||!Number.isFinite(Number(sample.duration))||Number(sample.duration)<=0)return;
  etaProfile=[...(etaProfile||[]),{...sample,recordedAt:Date.now()}].slice(-160);
  await storageSet({[ETA_PROFILE_KEY]:etaProfile});
}
async function completeMoneyEtaSample(shop) {
  const now=Date.now(),tracker=etaTracker?.kind==="money"&&etaTracker.shopIndex===state.shopIndex?etaTracker:null;
  shop.etaMoneyFinishedAt=now;
  if(!tracker){etaTracker=null;return;}
  const last=tracker.points?.at(-1),units=Math.max(0,Number(last?.current||0)-Number(tracker.firstCurrent||0));
  const duration=Math.max(0,(now-Number(tracker.startedAt||now))/1000);
  shop.etaMoneyTotal=Math.max(Number(shop.etaMoneyTotal)||0,Number(tracker.total)||0);
  shop.etaMoneyDuration=duration;
  etaTracker=null;
  if(units<10||duration<2)return;
  await appendEtaSample({kind:"money",mode:state.taskMode,mallId:databaseMallId(shop),storeName:shop.database_name||shop.name,units,duration,secondsPerUnit:duration/units});
}
async function recordSellerShopEta(shop) {
  const finishedAt=Date.now(),startedAt=Number(shop?.etaStartedAt)||0;
  if(!startedAt||finishedAt<=startedAt)return;
  const duration=(finishedAt-startedAt)/1000;
  const moneyFinishedAt=Number(shop.etaMoneyFinishedAt)||0;
  await appendEtaSample({kind:"seller_shop",mode:"seller",mallId:databaseMallId(shop),storeName:shop.database_name||shop.name,duration,moneyUnits:Number(shop.etaMoneyTotal)||0,moneyDuration:Number(shop.etaMoneyDuration)||0,orderRows:Number(shop.etaOrderRows)||0,tailAfterMoney:moneyFinishedAt?Math.max(0,(finishedAt-moneyFinishedAt)/1000):0});
}
async function loadPendingMoneyRows(shop){return api("/api/client/orders/pending-money",{method:"POST",body:{phone:state.phone,store_name:shop.database_name||shop.name,mall_id:databaseMallId(shop),orders:[]}});}
async function loadPendingReturnParents(shop,range){return api("/api/client/returns/pending-orders",{method:"POST",body:{phone:state.phone,mall_id:databaseMallId(shop),start_date:range.startDate,end_date:range.endDate,limit:1000}});}
function attemptedReturnParents(){return state.returnRecoveryAttempted?.shopIndex===state.shopIndex?new Set(state.returnRecoveryAttempted.parentOrderSns||[]):new Set();}
function markReturnParentsAttempted(parentOrderSns){const attempted=attemptedReturnParents();for(const parent of parentOrderSns||[]){const value=String(parent||"").trim();if(value)attempted.add(value);}state.returnRecoveryAttempted={shopIndex:state.shopIndex,parentOrderSns:[...attempted]};}
async function schedulePendingReturnRecovery(shop,range){
  const pending=await loadPendingReturnParents(shop,range),attempted=attemptedReturnParents();
  const candidates=(pending.parent_order_sns||[]).map((value)=>String(value||"").trim()).filter((value)=>value&&!attempted.has(value));
  if(!candidates.length){
    const remaining=Number(pending.total_count||0);
    if(remaining>0)log(`${shop.name} 仍有 ${remaining} 个退款父订单本次无法从 Temu 查到完整订单详情，已保留，下次采集继续补抓`);
    return false;
  }
  const parentOrderSns=candidates.slice(0,200);
  state.pendingReturnRecovery={shopIndex:state.shopIndex,parentOrderSns,totalCount:Number(pending.total_count||0)};
  state.orderRange={startDate:range.startDate,endDate:range.endDate,dates:[],planMode:"return_recovery",stableIncompleteDates:[]};
  state.phase="orders";shop.status="正在补抓退款关联订单";
  log(`${shop.name} 发现 ${pending.total_count||parentOrderSns.length} 个退款父订单尚未入库，立即定向补抓 ${parentOrderSns.length} 个`);
  await save();return true;
}
function orderRowKey(row){return `${String(row?.parentOrderSn||row?.parent_order_sn||"").trim()}|${String(row?.orderSn||row?.order_sn||"").trim()}|${String(row?.skuId||row?.sku_id||"").trim()}`;}
function mergeOrderRows(currentRows,pendingRows){
  const merged=new Map();
  for(const row of [...(pendingRows||[]),...(currentRows||[])]){
    const key=orderRowKey(row);if(!key||key==="||")continue;
    const previous=merged.get(key)||{};
    const money=row?.money??previous.money??null;
    merged.set(key,{...previous,...row,money});
  }
  return [...merged.values()];
}
async function uploadOrderRows(shop,range,rows,resumed=false){
  return api("/api/client/orders/upload",{method:"POST",body:{phone:state.phone,store_name:shop.database_name||shop.name,mall_id:databaseMallId(shop),start_date:range.startDate,end_date:range.endDate,rows,crawl_result:{source:"browser_extension",resumed_upload:resumed}}});
}
function logOrderUploadResult(shop,result){
  const deferredRows=Number(result?.deferred_rows||0),deferredParents=Number(result?.deferred_parents||0),uploadedRows=Number(result?.uploaded_rows??result?.upload?.validRows??0);
  shop.deferredRows=deferredRows;shop.deferredParents=deferredParents;
  state.stats.deferredRows=Number(state.stats.deferredRows||0)+deferredRows;state.stats.deferredParents=Number(state.stats.deferredParents||0)+deferredParents;
  if(deferredRows>0)log(`${shop.name} 已保存 ${uploadedRows} 行完整订单；${deferredParents} 个父订单（${deferredRows} 行）缺少金额，已记录并将在下次优先重试`);else log(`${shop.name} 订单已保存 ${uploadedRows} 行`);
}
async function runOrders(tabId,shop){
  const selected=sellerCollectionRange();
  if(!state.orderRange){
    const returnRecovery=await loadPendingReturnParents(shop,selected);
    state.pendingReturnRecovery={shopIndex:state.shopIndex,parentOrderSns:returnRecovery.parent_order_sns||[],totalCount:Number(returnRecovery.total_count||0)};
    const coverage=await api(`/api/orders/missing-days?start_date=${selected.startDate}&end_date=${selected.endDate}`);
    const planned=Array.isArray(coverage.recommended_crawl_dates)?coverage.recommended_crawl_dates:[];
    const dates=[...new Set((planned.length?planned:[...(coverage.missing_dates||[]),...(coverage.refresh_dates||[])]).map(String).filter(Boolean))].sort();
    if(!dates.length){
      const pending=await loadPendingMoneyRows(shop);
      if((pending.rows||[]).length){
        state.orderRange={startDate:selected.startDate,endDate:selected.endDate,dates:[],planMode:"pending_money",stableIncompleteDates:[]};
        state.orderRows=pending.rows;state.phase="money";shop.status="正在重试历史缺失金额";
        log(`${shop.name} 有 ${pending.pending_parents||0} 个历史父订单缺少金额，本次优先重试`);await save();return "complete";
      }
      if((state.pendingReturnRecovery.parentOrderSns||[]).length){
        state.orderRange={startDate:selected.startDate,endDate:selected.endDate,dates:[],planMode:"return_recovery",stableIncompleteDates:[]};
        shop.status="正在补抓未匹配退款订单";
        log(`${shop.name} 有 ${returnRecovery.total_count||0} 个退款父订单缺少订单明细，本次定向补抓 ${state.pendingReturnRecovery.parentOrderSns.length} 个`);await save();
      }else{
        delete state.pendingReturnRecovery;
        state.phase="returns";shop.status="订单无需更新，准备采集退货退款";log(`${shop.name} 当前订单范围无需更新`);await save();return "complete";
      }
    }
    if(dates.length){
      const fullMonth=coverage.plan_mode==="full_month";
      state.orderRange={startDate:dates[0],endDate:dates[dates.length-1],dates,planMode:fullMonth?"full_month":"recent_7_days",stableIncompleteDates:coverage.stable_incomplete_dates||[]};
      if(fullMonth){const missingCount=state.orderRange.stableIncompleteDates.length;log(`${shop.name} 近60天稳定区有 ${missingCount} 天未确认完整，重新采集近60天`);}else log(`${shop.name} 近60天稳定区完整，更新最近7天`);
      if((state.pendingReturnRecovery.parentOrderSns||[]).length)log(`${shop.name} 同时定向补抓 ${state.pendingReturnRecovery.parentOrderSns.length} 个未匹配退款父订单`);
    }
  }
  const range=state.orderRange,rangeLabel=range.planMode==="full_month"?"近60天完整补抓":range.planMode==="pending_money"?"历史缺失金额补抓":range.planMode==="return_recovery"?"退款订单定向补抓":"最近7天滚动更新";
  state.message=`${rangeLabel}：正在采集 ${shop.name} ${range.startDate} 至 ${range.endDate} 订单列表`;shop.status=shop.flowWarning?`${shop.flowWarning}；${rangeLabel}`:`流量完成，${rangeLabel}`;await save();
  if(!location.pathname.includes("/mmsos/orders.html")){state.resumeAfterNavigation=true;state.message=`正在进入订单页，准备${rangeLabel} ${shop.name}`;await save();await tabUpdate(tabId,{url:currentSellerOrigin()+"/mmsos/orders.html",active:true});return "navigating";}
  delete state.resumeAfterNavigation;await save();await collect(tabId,"PREPARE_ORDERS",{},30000);
  const result=range.dates?.length===0?{rows:[]}:await collect(tabId,"ORDERS",{...range,requestHeaders:sellerRequestHeaders(shop)},600000);
  let recovered={rows:[],failedParentOrderSns:[]};
  if(state.pendingReturnRecovery?.shopIndex===state.shopIndex&&(state.pendingReturnRecovery.parentOrderSns||[]).length){
    markReturnParentsAttempted(state.pendingReturnRecovery.parentOrderSns);await save();
    recovered=await collect(tabId,"ORDER_DETAILS",{parentOrderSns:state.pendingReturnRecovery.parentOrderSns,requestHeaders:sellerRequestHeaders(shop)},900000);
    log(`${shop.name} 定向恢复退款订单 ${recovered.rows.length} 行${recovered.failedParentOrderSns?.length?`，${recovered.failedParentOrderSns.length} 个父订单将在下次重试`:""}`);
  }
  const combined=mergeOrderRows(result.rows,recovered.rows);delete state.pendingReturnRecovery;shop.etaOrderRows=combined.length;
  state.orderRows=combined;state.stats.rows=Math.max(state.stats.rows,combined.length);shop.status="订单完成，正在补金额";state.phase="money";log(`${shop.name} ${rangeLabel}完成，订单列表 ${combined.length} 行`);await save();return "complete";
}
async function runMoney(tabId,shop){
  const range=state.orderRange||sellerCollectionRange(),dbMallId=databaseMallId(shop),dbStoreName=shop.database_name||shop.name;
  if(state.pendingOrders?.shopIndex===state.shopIndex){
    const pendingRows=state.pendingOrders.rows||[];
    const uploadResult=await uploadOrderRows(shop,state.pendingOrders.range||range,pendingRows,true);
    logOrderUploadResult(shop,uploadResult);state.shippingParentOrderSns=[...new Set(pendingRows.map(row=>String(row.parentOrderSn||"").trim()).filter(Boolean))];delete state.pendingOrders;delete state.orderRows;state.phase="shipping";shop.status="订单已处理，准备采集精准物流费用";await save();return;
  }
  const historical=await loadPendingMoneyRows(shop);
  const rows=mergeOrderRows(state.orderRows||[],historical.rows||[]);state.orderRows=rows;await save();
  if((historical.rows||[]).length)log(`${shop.name} 已合并 ${historical.pending_parents||0} 个历史待补父订单，本次优先重试缺失金额`);
  if(!rows.length){
    await completeMoneyEtaSample(shop);
    const uploadResult=await uploadOrderRows(shop,range,[]);logOrderUploadResult(shop,uploadResult);
  }else{
    const cache=await api("/api/client/orders/money-cache",{method:"POST",body:{phone:state.phone,store_name:dbStoreName,mall_id:dbMallId,orders:rows}});
    const byKey=new Map((cache.money||[]).map((item)=>[`${item.parent_order_sn}|${item.order_sn}|${item.sku_id}`,item.money]));
    const cached=rows.map((row)=>({...row,money:byKey.get(`${row.parentOrderSn}|${row.orderSn}|${row.skuId}`)??row.money}));
    state.stats.parents=0;state.stats.parentTotal=0;
    state.message=`正在补全 ${shop.name} 订单金额`;await save();
    const filled=await collect(tabId,"MONEY",{rows:cached,requestHeaders:sellerRequestHeaders(shop)},900000);
    state.orderRows=filled.rows;
    await completeMoneyEtaSample(shop);
    await save();
    if(Number(filled.missingCount||0)>0){
      for(const [parent,failure] of Object.entries(filled.failedByParent||{}).slice(0,3)){
        const detail=failure?.diagnostic||{};
        const structure=detail.hasRawDataText
          ? detail.rawParsed?`rawData 已解析；store 字段：${(detail.storeKeys||[]).join(",")||"无"}`:"检测到 rawData，但解析失败"
          : "响应中没有 rawData";
        const fallback=detail.supplierPriceFallback?`；金额接口：${detail.supplierPriceFallback}`:"";
        const keys=Array.isArray(detail.returnedOrderSns)?`；已返回子订单：${detail.returnedOrderSns.slice(0,5).join("、")||"无"}`:"";
        log(`金额诊断 ${parent}：${failure?.reason||"详情结构异常"}；请求店铺 ${detail.mallId||dbMallId}；HTTP ${detail.status||"未知"}；${detail.finalPath||"路径未知"}；${detail.responseBytes||0} 字节；标题 ${detail.pageTitle||"未知"}；${structure}${fallback}${keys}`);
      }
      const sample=(filled.missingParentOrderSns||[]).slice(0,3).join("、");
      log(`${shop.name} 仍有 ${filled.missingCount} 行金额暂时无法获取${sample?`（父订单 ${sample}）`:""}，这些父订单暂缓入库`);
    }
    state.pendingOrders={shopIndex:state.shopIndex,range,rows:filled.rows};
    await save();
    const uploadResult=await uploadOrderRows(shop,range,filled.rows);logOrderUploadResult(shop,uploadResult);
  }
  state.shippingParentOrderSns=[...new Set((state.orderRows||[]).map(row=>String(row.parentOrderSn||"").trim()).filter(Boolean))];delete state.pendingOrders;delete state.orderRows;state.phase="shipping";shop.status="订单已处理，准备采集精准物流费用";await save();
}
async function runShipping(tabId,shop){
  const parents=[...new Set((state.shippingParentOrderSns||[]).map(String).filter(Boolean))];
  const body={mall_id:databaseMallId(shop),store_name:shop.database_name||shop.name,rows:[]};
  if(parents.length){state.message=`正在按父订单查询 ${shop.name} 的精准物流费用（${parents.length} 个）`;shop.status="正在采集精准物流费用";await save();const result=await collect(tabId,"PRECISE_SHIPPING",{parentOrderSns:parents,requestHeaders:sellerRequestHeaders(shop)},900000);body.rows=result.rows||[];state.stats.shipping=body.rows.length;log(`${shop.name} 精准物流费用：找到 ${result.found||0} 条，缺失 ${result.missing||0} 条`);}
  else log(`${shop.name} 本批没有需要查询物流费用的父订单`);
  await api("/api/client/shipping/upload",{method:"POST",body});delete state.shippingParentOrderSns;state.phase="returns";shop.status="物流费用已保存，准备采集退货退款";await save();
}
async function finishReturnsOrRecoverOrders(shop,range){
  if(await schedulePendingReturnRecovery(shop,range))return "recovering";
  await recordSellerShopEta(shop);
  finishSellerShop(shop);await save();return "complete";
}
async function runReturns(tabId,shop){
  const uploadedMarker=state.returnDataUploaded?.shopIndex===state.shopIndex?state.returnDataUploaded:null;
  const range=state.pendingReturns?.range||uploadedMarker?.range||state.orderRange||sellerCollectionRange();
  const uploadBody=(rows,totalCount)=>({phone:state.phone,store_name:shop.database_name||shop.name,mall_id:databaseMallId(shop),start_date:range.startDate,end_date:range.endDate,total_count:totalCount,rows});
  const logRepair=(uploadResult)=>{const repaired=Number(uploadResult?.sku_repair?.repaired_count||0);if(repaired>0)log(`${shop.name} 已修复 ${repaired} 行历史 SKU ID，订单金额保持不变`);};
  if(uploadedMarker)return finishReturnsOrRecoverOrders(shop,range);
  if(state.pendingReturns?.shopIndex===state.shopIndex){
    const uploadResult=await api("/api/client/returns/upload",{method:"POST",body:uploadBody(state.pendingReturns.rows,state.pendingReturns.totalCount)});logRepair(uploadResult);
    const count=state.pendingReturns.rows.length;delete state.pendingReturns;state.returnDataUploaded={shopIndex:state.shopIndex,range};
    log(`${shop.name} 待保存退货退款已写入本机（${count} 项）`);await save();return finishReturnsOrRecoverOrders(shop,range);
  }
  if(!location.pathname.includes("/mmsos/return-refund-list.html")){state.message=`正在进入退货退款页，准备采集 ${shop.name}`;shop.status="正在进入退货退款页";await save();await tabUpdate(tabId,{url:currentSellerOrigin()+"/mmsos/return-refund-list.html",active:true});return "navigating";}
  state.message=`正在采集 ${shop.name} ${range.startDate} 至 ${range.endDate} 退货退款`;shop.status="正在采集退货退款";await save();
  const result=await collect(tabId,"RETURNS",{mallId:shop.mall_id,startDate:range.startDate,endDate:range.endDate,requestHeaders:sellerRequestHeaders(shop)},600000);
  state.pendingReturns={shopIndex:state.shopIndex,range,rows:result.rows,totalCount:result.totalCount};state.stats.returns=Math.max(state.stats.returns,result.rows.length);await save();
  const uploadResult=await api("/api/client/returns/upload",{method:"POST",body:uploadBody(result.rows,result.totalCount)});logRepair(uploadResult);
  delete state.pendingReturns;state.returnDataUploaded={shopIndex:state.shopIndex,range};log(`${shop.name} 退货退款已保存到本机（${result.rows.length} 个商品项）`);await save();
  return finishReturnsOrRecoverOrders(shop,range);
}
async function runAds(){
  const shop=currentShop(),tabId=await temuTab("ads"),dbMallId=databaseMallId(shop);
  const finish=(status,message)=>{delete state.pendingAds;shop.status=status;state.shopIndex+=1;if(state.shopIndex>=state.shops.length){state.phase="done";state.status="done";state.message="当前店铺广告数据已保存到本机";}if(message)log(message);};
  if(shop.ads_collection_disabled){finish("无需采集广告",`${shop.name} 已标记为无需采集广告，自动跳过`);await save();return;}
  if(state.pendingAds?.shopIndex===state.shopIndex){
    await api("/api/client/ads/save",{method:"POST",body:{phone:state.phone,store_name:shop.database_name||shop.name,mall_id:dbMallId,reports:state.pendingAds.reports,earliest_ad_date:state.pendingAds.earliestAdDate||null,earliest_time_ms:state.pendingAds.earliestTimeMs||null}});
    finish("广告完成",`${shop.name} 待保存广告已写入本机`);await save();return;
  }
  state.message="正在核对当前浏览器广告店铺";await save();
  const auth=await collect(tabId,"ADS_AUTH_STATUS",{},30000,runGeneration,1);
  if(auth.usRegionSelected!==true)throw new Error(`广告平台当前不是美国区（${auth.regionText||auth.siteId||"区域未知"}），请手动选择“美国”后重试；本次没有保存广告数据`);
  if(String(auth.mallId||"")!==String(shop.mall_id||""))throw new Error(`当前浏览器广告店铺已变化：任务店铺 ${shop.name}，当前店铺 ${auth.mallName||auth.mallId||"未知"}；已停止以避免数据串店`);
  const range=adsCollectionRange();
  let dates=range.dates;
  try{const plan=await api("/api/client/ads/plan",{method:"POST",body:{phone:state.phone,mall_id:dbMallId,start_date:range.startDate,end_date:range.endDate,refresh_recent:true}});dates=plan.dates||plan.fetch_dates||range.dates;}
  catch(error){log(`${shop.name} 广告采集计划暂不可用，改用最近30天兜底采集：${friendlyErrorMessage(error)}`);logTechnicalError(error);}
  if(!dates.length){finish("广告无需更新",`${shop.name} 广告日期已完整，无需重复采集`);await save();return;}
  let result;
  try{result=await collect(tabId,"ADS_REPORTS",{dates},600000,runGeneration,1);}catch(error){
    const reason=friendlyErrorMessage(error);
    if(/未登录|登录已失效|插件刚刚更新|任务已停止/.test(reason))throw error;
    finish("广告未采集，已跳过",`${shop.name} 可能没有广告数据或当前店铺无广告权限，已跳过并继续下一店：${reason}`);await save();return;
  }
  state.pendingAds={shopIndex:state.shopIndex,reports:result.reports,earliestAdDate:result.earliestAdDate,earliestTimeMs:result.earliestTimeMs};await save();
  await api("/api/client/ads/save",{method:"POST",body:{phone:state.phone,store_name:shop.database_name||shop.name,mall_id:dbMallId,reports:result.reports,earliest_ad_date:result.earliestAdDate||null,earliest_time_ms:result.earliestTimeMs||null}});
  const failedCount=Number(result.failedDates?.length||0);
  finish(failedCount?`广告部分完成（${failedCount} 天未取得）`:"广告完成",failedCount?`${shop.name} 已保存成功广告日期；另有 ${failedCount} 天未取得`:`${shop.name} 广告已保存到本机`);
  await save();
}

async function toggleAdsCollection(index,button){
  const shop=state.shops?.[index];if(!shop||state.taskMode!=="ads")return;
  const before=Boolean(shop.ads_collection_disabled),disabled=!before;
  button.disabled=true;
  try{
    await api("/api/client/ads/shop-setting",{method:"POST",body:{phone:state.phone,mall_id:databaseMallId(shop),ads_collection_disabled:disabled}});
    shop.ads_collection_disabled=disabled;
    shop.status=disabled?"无需采集广告":index<state.shopIndex?"广告已处理":"等待";
    log(`${shop.name} 已${disabled?"标记为无需采集广告":"恢复广告采集"}`);
    if(disabled&&index===state.shopIndex&&state.phase==="ads"&&(state.status==="failed"||state.status==="paused")){
      delete state.pendingAds;state.shopIndex+=1;
      if(state.shopIndex>=state.shops.length){state.phase="done";state.status="done";state.message="当前店铺广告任务已处理完成";}else{state.status="paused";state.message=`${shop.name} 已跳过`;}
    }
    await save();
  }catch(error){shop.ads_collection_disabled=before;log(`保存 ${shop.name} 广告采集设置失败：${friendlyErrorMessage(error)}`);logTechnicalError(error);render();}
}
async function recordCompletion(){const endedAt=Date.now();state.endedAt=endedAt;syncElapsedTimer();history=[...history,{mode:state.taskMode,endedAt,duration:Math.max(1,(endedAt-state.startedAt)/1000),shopCount:state.shops.length,stats:state.stats}].slice(-40);await storageSet({[HISTORY_KEY]:history});const pendingText=Number(state.stats.deferredParents||0)>0?`本次其他数据已保存；另有 ${state.stats.deferredParents} 个父订单缺少金额，下次采集会继续补全。`:(flowWarningsText()?`有效流量、订单、金额、精准物流费用和退货退款已保存到本机；${flowWarningsText()}。`:"流量、订单、金额、精准物流费用和退货退款均已保存到本机。");$("completeMessage").textContent=state.taskMode==="seller"?`${pendingText} 是否继续采集当前浏览器店铺的广告？`:state.taskMode==="products"?"在售商品目录、活动价格和活动状态已保存到本机。":"广告数据已保存到本机。是否返回 Seller Center 采集订单、流量和退货退款？";$("runOther").textContent=state.taskMode==="seller"?"前往采集广告":"前往采集订单＋流量";if(state.taskMode==="seller"&&flowWarningsText()&&!$("completeMessage").textContent.includes(flowWarningsText()))$("completeMessage").textContent+=` ${flowWarningsText()}。`;showView("completeView");render();syncTaskToWorkbench(true);if(pendingLaunchContext?.scheduleRunId)runtime({type:"LOCAL_SCHEDULE_STAGE_DONE",runId:pendingLaunchContext.scheduleRunId,failed:false}).catch(()=>{});}
async function run(){const manualRunId=crypto.randomUUID(),admission=await runtime({type:'WORKBENCH_COLLECTOR_RESERVE',runId:manualRunId});if(!admission?.ok){state.message=admission?.error||'当前任务占用中，请稍后重试';render();return;}paused=false;const generation=++runGeneration;const resumedAt=Date.now();if(state.endedAt&&state.startedAt)state.startedAt+=Math.max(0,resumedAt-state.endedAt);delete state.endedAt;state.status="running";state.startedAt ||= resumedAt;syncElapsedTimer();try{await save()}finally{await runtime({type:'WORKBENCH_COLLECTOR_COMMIT',runId:manualRunId})}try{while(!paused&&generation===runGeneration&&state.phase!=="done"){if(state.phase==="discover"){await discover();continue;}if(state.phase==="ads"){await runAds();continue;}const shop=currentShop();shop.etaStartedAt ||= Date.now();const tabId=await temuTab(state.taskMode==="products"?"products":"seller");if(state.phase==="products"){const switchResult=await switchSeller(tabId,shop);if(switchResult==="navigating")return;const result=await runProducts(tabId,shop);if(result==="navigating")return;continue;}if(state.phase==="activities"){const result=await runProductActivities(tabId,shop);if(result==="navigating")return;continue;}if(state.phase==="flow"){if(await enterFlowPage(tabId,shop))return;const switchResult=await switchSeller(tabId,shop);if(switchResult==="navigating")return;await runFlow(tabId,shop);continue;}if(state.phase==="orders"){const verified=await collect(tabId,"VERIFY_SELLER_SHOP",{name:shop.name,mallId:shop.mall_id},30000);if(!verified.matches||verified.refreshNotice)throw new Error(`订单采集前店铺校验失败：目标 ${shop.name}，页面顶部显示 ${verified.currentShop||"未知店铺"}；已停止以避免数据错位`);const result=await runOrders(tabId,shop);if(result==="navigating")return;continue;}if(state.phase==="money"){const verified=await collect(tabId,"VERIFY_SELLER_SHOP",{name:shop.name,mallId:shop.mall_id},30000);if(!verified.matches||verified.refreshNotice)throw new Error(`金额采集前店铺校验失败：目标 ${shop.name}，页面顶部显示 ${verified.currentShop||"未知店铺"}；已停止以避免数据错位`);await runMoney(tabId,shop);continue;}if(state.phase==="shipping"){const verified=await collect(tabId,"VERIFY_SELLER_SHOP",{name:shop.name,mallId:shop.mall_id},30000);if(!verified.matches||verified.refreshNotice)throw new Error(`物流费用采集前店铺校验失败：目标 ${shop.name}，页面顶部显示 ${verified.currentShop||"未知店铺"}；已停止以避免数据错位`);await runShipping(tabId,shop);continue;}if(state.phase==="returns"){const verified=await collect(tabId,"VERIFY_SELLER_SHOP",{name:shop.name,mallId:shop.mall_id},30000);if(!verified.matches||verified.refreshNotice)throw new Error(`退货退款采集前店铺校验失败：目标 ${shop.name}，页面顶部显示 ${verified.currentShop||"未知店铺"}；已停止以避免数据错位`);const result=await runReturns(tabId,shop);if(result==="navigating")return;continue;}}if(state.phase==="done"&&generation===runGeneration)await recordCompletion();}catch(error){if(generation!==runGeneration)return;const shop=currentShop();if(shop&&state.phase!=="done")shop.status=`${phaseLabel(state.phase)}失败，可继续`;state.status="failed";state.endedAt=Date.now();syncElapsedTimer();state.message=friendlyErrorMessage(error);log(`失败：${state.message}`);logTechnicalError(error);await save();if(pendingLaunchContext?.scheduleRunId)runtime({type:"LOCAL_SCHEDULE_STAGE_DONE",runId:pendingLaunchContext.scheduleRunId,failed:true,error:state.message}).catch(()=>{});}}
async function beginMode(mode,launchContext={}){pendingMode=mode;pendingLaunchContext=launchContext||{};const label=mode==="seller"?"订单＋流量信息抓取":mode==="products"?"商品与活动采集":"广告抓取";$("confirmTitle").textContent=`确认开始${label}`;let message=mode==="seller"?"插件会锁定当前浏览器正在登录的店铺，采集流量、订单、金额和退货退款并保存到本机。":mode==="products"?"插件会锁定当前浏览器店铺，采集在售商品、SKU 申报价和活动状态并保存到本机。":"插件会锁定广告平台当前店铺，采集最近30天广告数据并保存到本机。";if(forceFreshTask)message="当前浏览器登录店铺与保存中的任务不同。确认后将为当前店铺开始新任务，旧店铺已经保存的数据不会删除。";$("confirmMessage").textContent=message;$("confirmMessage").classList.remove("collector-error");$("confirmStart").disabled=false;$("confirmStart").textContent=mode==="ads"?"确认并检查店铺":"确认并开始";showView("confirmView");}
async function startConfirmed(){
  const button=$("confirmStart");
  button.disabled=true;
  button.textContent=pendingMode==="ads"?"正在检查登录账号…":"正在启动…";
  $("confirmMessage").classList.remove("collector-error");
  try{
    const admission=await runtime({type:'WORKBENCH_COLLECTOR_STATUS'});
    if(!admission?.ok)throw Error(admission?.error||'采集状态检查失败，请刷新当前页面后重试');
    await storageSet({[SETTINGS_KEY]:settings()});
    if(forceFreshTask||state.taskMode!==pendingMode||state.status==="done"||state.status==="failed"||state.phase==="done"){state=freshState(pendingMode);etaTracker=null;etaDisplay={context:"",seconds:null,updatedAt:0};}
    forceFreshTask=false;
    currentLoginMatchesSavedTask=true;
    state.taskMode=pendingMode;
    state.phone="";
    delete state.endedAt;
    if(pendingMode==="ads"){
      state.status="idle";
      state.startedAt=0;
      state.message="正在核对广告平台登录账号，校验期间不计时";
      if(location.hostname!=="ads.temu.com"){
        await save();
        syncElapsedTimer();
        await storageSet({[LAUNCH_KEY]:{mode:"ads",at:Date.now()}});
        closeOverlay();
        const result=await runtime({type:"OPEN_COLLECTOR",mode:"ads"});
        if(!result?.success)throw new Error(result?.error||"广告页面打开失败");
        return;
      }
      await prepareAdsAccountScopeFromCurrentLogin(await currentTab());
    }
    state.status="running";
    state.startedAt=Date.now();
    await save();
    syncElapsedTimer();
    showView("progressView");
    if(pendingMode==="seller"&&location.hostname!=="agentseller-us.temu.com"&&location.hostname!=="agentseller.temu.com"){
      const id=await currentTab();
      const result=await tabUpdate(id,{url:"https://agentseller.temu.com/main/flux-analysis",active:true});
      if(result?.error||result?.success===false)throw new Error(result.error||"页面跳转失败");
      return;
    }
    run();
  }catch(error){
    if(pendingMode==="ads"){
      state.status="idle";
      state.startedAt=0;
      syncElapsedTimer();
      await save();
    }
    button.disabled=false;
    button.textContent=pendingMode==="ads"?"重新检查登录账号":"重新尝试";
    $("confirmMessage").textContent=errorDisplayText("启动失败：",extensionUnavailable(error));
    $("confirmMessage").classList.add("collector-error");
    showView("confirmView");
  }
}
function requestExit(){if(state.status==="running")showView("exitView");else closeOverlay();}
async function confirmExit(){paused=true;runGeneration+=1;state.status="paused";state.endedAt=Date.now();state.message="任务已停止；已经保存到本机的数据保留";syncElapsedTimer();await save();const id=await currentTab();if(id)await tabReload(id);}
async function showOther(){const mode=state.taskMode==="seller"?"ads":"seller";closeOverlay();const result=await runtime({type:"OPEN_COLLECTOR",mode});if(!result?.success){await beginMode(mode,{});$("confirmMessage").textContent=`页面打开失败：${friendlyErrorMessage(result?.error,"无法打开对应的 Temu 页面")}`;$("confirmMessage").classList.add("collector-error");}}

$("confirmStart").addEventListener("click",startConfirmed);
$("confirmCancel").addEventListener("click",closeOverlay);
$("pause").addEventListener("click",requestExit);
$("dialogClose").addEventListener("click",requestExit);
$("confirmExit").addEventListener("click",confirmExit);
$("continueTask").addEventListener("click",()=>showView("progressView"));
$("finishClose").addEventListener("click",closeOverlay);
$("runOther").addEventListener("click",showOther);
$("start").addEventListener("click",()=>{showView("progressView");run();});
$("reset").addEventListener("click",async()=>{paused=true;runGeneration+=1;etaTracker=null;etaDisplay={context:"",seconds:null,updatedAt:0};state=freshState(state.taskMode);await save();closeOverlay();});
$("shops").addEventListener("click",(event)=>{const button=event.target.closest(".shop-ad-toggle");if(button)toggleAdsCollection(Number(button.dataset.shopIndex),button);});
function receiveProgress(progress={}){if(state.status!=="running")return;observeEtaProgress(progress);if(progress.metric){state.stats.requests+=1;state.stats.bytes+=Number(progress.metric.bytes||0);state.stats.networkMs+=Number(progress.metric.durationMs||0);}if(progress.stage==="retry")state.stats.retryWaitMs+=Number(progress.waitMs||0);if(progress.stage==="orders"){state.stats.pages=Math.max(state.stats.pages,Number(progress.current||0));state.stats.rows=Math.max(state.stats.rows,Number(progress.rows||0));}if(progress.stage==="money"){state.stats.parents=Math.max(0,Number(progress.current||0));state.stats.parentTotal=Math.max(0,Number(progress.total||0));}if(progress.stage==="returns")state.stats.returns=Math.max(state.stats.returns,Number(progress.rows||0));if(progress.stage==="ads")state.stats.dates=Math.max(state.stats.dates,Number(progress.current||0));state.message=progress.message||state.message;render();syncTaskToWorkbench();}
document.addEventListener("temu-collector-progress",(event)=>receiveProgress(event.detail));
document.addEventListener("temu-collector-open",async(event)=>{const mode=event.detail?.mode==="ads"?"ads":event.detail?.mode==="products"?"products":"seller",active=(state.status==="running"||state.status==="failed"||state.status==="paused")&&state.phase!=="done"&&state.taskMode===mode;if(active&&currentLoginMatchesSavedTask){showView("progressView");return;}forceFreshTask=Boolean(active&&!currentLoginMatchesSavedTask);await beginMode(mode,event.detail||{});});

(async()=>{history=await storageGet(HISTORY_KEY)||[];etaProfile=await storageGet(ETA_PROFILE_KEY)||[];state=await storageGet(STATE_KEY)||state;state.phone="";state.stats={...emptyStats(),...(state.stats||{})};syncElapsedTimer();let authenticated=false,auth=null;try{const id=await currentTab();const command=location.hostname==="ads.temu.com"?"ADS_AUTH_STATUS":"USER_INFO";auth=command==="USER_INFO"?await sellerAuth(id):await collect(id,command,{},15000);authenticated=Boolean(auth.success);}catch{}const adsLogin=location.hostname==="ads.temu.com"&&location.pathname.includes("login");const correctTaskHost=(state.taskMode==="ads"&&location.hostname==="ads.temu.com")||((state.taskMode==="seller"||state.taskMode==="products")&&(location.hostname==="agentseller-us.temu.com"||location.hostname==="agentseller.temu.com"));const activeSavedTask=(state.status==="running"||state.status==="failed"||state.status==="paused")&&state.phase!=="done"&&correctTaskHost;currentLoginMatchesSavedTask=!activeSavedTask||savedTaskMatchesAuth(auth);forceFreshTask=Boolean(activeSavedTask&&authenticated&&!currentLoginMatchesSavedTask);const resuming=!adsLogin&&state.status==="running"&&correctTaskHost&&currentLoginMatchesSavedTask;const recoverable=!adsLogin&&state.status==="failed"&&state.phase!=="done"&&correctTaskHost&&currentLoginMatchesSavedTask;$("temuCollectorRoot").hidden=!(authenticated||resuming||recoverable);render();if(authenticated&&typeof wbDailyMount==="function")wbDailyMount().catch(()=>{});if(resuming){showView("progressView");run();return;}if(recoverable){showView("progressView");return;}const launch=await storageGet(LAUNCH_KEY);const correctHost=((launch?.mode==="seller"||launch?.mode==="products")&&(location.hostname==="agentseller-us.temu.com"||location.hostname==="agentseller.temu.com"))||(launch?.mode==="ads"&&location.hostname==="ads.temu.com");if(authenticated&&correctHost&&Date.now()-Number(launch.at||0)<1800000){await storageSet({[LAUNCH_KEY]:null});await beginMode(launch.mode,launch);if(launch.scheduleAutoStart===true){await startConfirmed();}}})();


$('collectorTrafficOpen')?.addEventListener('click',async()=>{const result=await runtime({type:'WORKBENCH_OPEN_TRAFFIC_ACCELERATOR'});if(result?.ok)closeOverlay();else alert(result?.error||'流量加速器打开失败')});
