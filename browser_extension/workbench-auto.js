// Automatic current-shop flow collection. Uses only the durable LOCAL outbox.
const WB_AUTO_KEY='workbench.auto.v1';
// The live background owns collection. A persisted lease cannot survive a worker restart.
let wbAutoRunning=false;
let wbScheduledRunning=false;
const WB_AUTO_INTERVAL=120*60000;
const wbFlowRangeNames={0:'实时',1:'近1日',4:'近7日',5:'近30日',2:'本周',3:'本月'};
// A stopped manual task remains resumable, but no longer owns the collector.
const wbManualTaskBusy=task=>!!task&&task.status!=='done'&&task.status!=='failed'&&task.phase!=='done'&&(task.status==='running'||task.status==='paused'&&!task.endedAt);
const wbAutoDay=()=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai'}).format(new Date());
async function wbAutoRead(){const {leaseUntil,...state}=(await chrome.storage.local.get(WB_AUTO_KEY))[WB_AUTO_KEY]||{enabled:true,scopes:{}};return state}
async function wbAutoWrite(patch){const state=await wbAutoRead();await chrome.storage.local.set({[WB_AUTO_KEY]:{...state,...patch}})}
async function wbAutoCall(tabId,command,payload={}){
 const timeout=['PRODUCTS','ACTIVITIES'].includes(command)?600000:command==='VERIFY_SELLER_SHOP'?15000:180000;
 let timer;
 const response=chrome.tabs.sendMessage(tabId,{type:'TEMU_COLLECT',tabId,command,payload,timeout});
 const r=await Promise.race([response,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('页面读取超时（'+command+'），请刷新对应商家页面后重试')),timeout+5000)})]).finally(()=>clearTimeout(timer));
 if(r?.success!==true){const error=Error(r?.error||r?.errorMsg||'页面未返回有效数据');if(r?.errorCode==='FLOW_EMPTY_SUMMARY')error.errorCode='FLOW_EMPTY_SUMMARY';throw error}return r;
}
function wbUsFlowCandidate(tab){
 try{const url=new URL(tab?.url||'');return !!tab?.id&&tab.status==='complete'&&!wbProductHelper(tab)&&url.origin==='https://agentseller-us.temu.com'&&url.pathname==='/main/flux-analysis'}catch{return false}
}
async function wbFlowTarget(source,mall,name){
 let candidates=[];
 try{candidates=(await chrome.tabs.query({url:'https://agentseller-us.temu.com/main/flux-analysis*'})).filter(wbUsFlowCandidate)}catch{}
 candidates.sort((a,b)=>Number(b.id===source.id)-Number(a.id===source.id)||Number(b.active)-Number(a.active)||Number(b.lastAccessed||0)-Number(a.lastAccessed||0));
 for(const candidate of candidates){
  try{
   const identity=await wbSellerIdentity(candidate);
   if(String(identity.current_mall_id||'')!==mall)continue;
   const checked=await wbProductGuard(candidate.id,mall,name);
   if(wbUsFlowCandidate(checked))return checked;
  }catch{}
 }
 return source;
}
async function wbAutoTick(tab,force=false,expectedMall=""){
 if(wbAutoRunning||globalThis.wbTrafficActive)return wbAutoRead();
 wbAutoRunning=true;
 let flowTab=null,flowMarker='',flowScope='';
 try{
  let state=await wbAutoRead();
  if(!force&&!state.enabled)return state;
  if(!tab?.id||!wbSellerUrl(tab.url))return state;
  const manual=(await chrome.storage.local.get('temuCollectorState.v2'))['temuCollectorState.v2'];
  if(wbManualTaskBusy(manual)){await wbAutoWrite({message:'手动采集正在运行，自动更新等待中'});return wbAutoRead()}
  await wbAutoWrite({message:'正在识别当前店铺'});
  const identity=await wbSellerIdentity(tab);
  const mall=String(identity.current_mall_id||'');
  const shop=identity.shops?.find(s=>String(s.mall_id)===mall)||{mall_id:mall,name:identity.store_name||''};
  if(!/^\d+$/.test(mall))throw Error('无法确认当前店铺，请先完成商家后台登录');
  if(expectedMall&&mall!==expectedMall)throw Error('当前浏览器店铺与工作台选择不同，请打开所选店铺后再同步');
  let target=await wbFlowTarget(tab,mall,shop.name);
  const targetOrigin=new URL(target.url).origin,key=targetOrigin+':'+mall;
  flowScope=key;
  state=await wbAutoRead();const last=state.scopes?.[key]||state.scopes?.[new URL(target.url).hostname+':'+mall]||{};
  if(!force&&state.retryScope===key&&Date.now()<Number(state.retryAt||0))return state;
  if(!force&&Date.now()-Number(last.updatedAt||0)<WB_AUTO_INTERVAL){await wbAutoWrite({message:'自动更新已开启，等待下一轮'});return wbAutoRead()}
  const full=force||last.day!==wbAutoDay()||Array.isArray(last.emptyDimensions)&&last.emptyDimensions.length>0,dimensions=full?[0,1,4,5,2,3]:[0];
  const validDimensions=[],emptyDimensions=[];
  const job='FLOW-'+Date.now()+'-'+mall.slice(-4);
  await wbAutoWrite({job,message:`${shop.name}：自动更新流量`,startedAt:Date.now()});
  if(new URL(target.url).pathname!=='/main/flux-analysis'){
   flowMarker=crypto.randomUUID();
   const url=new URL('/main/flux-analysis',target.url);url.searchParams.set('wb_auto_flow',flowMarker);
   target=await chrome.tabs.create({url:url.href,active:false});flowTab=target.id;
   await wbProductWait(flowTab,url.href);
  }
  const guardTarget=async()=>{
   const checked=await wbProductGuard(target.id,mall,shop.name);
   const current=new URL(checked?.url||'about:blank');
   if(current.origin!==targetOrigin||current.pathname!=='/main/flux-analysis')throw Error('流量采集页面已变化，本批不保存');
  };
  await guardTarget();
  for(const dimension of dimensions){
   state=await wbAutoRead();if(!force&&!state.enabled)throw Error('自动更新已暂停');
   const currentManual=(await chrome.storage.local.get('temuCollectorState.v2'))['temuCollectorState.v2'];
   if(wbManualTaskBusy(currentManual))throw Error('手动采集已开始，自动更新让路');
   const before=await wbSellerIdentity(tab);
   if(String(before.current_mall_id)!==mall)throw Error('店铺已切换，本轮停止以避免数据混入');
   await wbProductGuard(tab.id,mall,shop.name);
   await guardTarget();
   let result,empty=false;
   try{result=await wbAutoCall(target.id,'FLOW',{dimensions:[dimension],mallId:mall,requestHeaders:{mallid:mall}})}
   catch(error){if(error?.errorCode!=='FLOW_EMPTY_SUMMARY')throw error;empty=true}
   await guardTarget();
   const after=await wbSellerIdentity(tab);
   if(String(after.current_mall_id)!==mall)throw Error('采集中店铺发生变化，本批不保存');
   await wbProductGuard(tab.id,mall,shop.name);
   if(empty){
    emptyDimensions.push(dimension);
    await wbAutoWrite({message:`${shop.name}：${wbFlowRangeNames[dimension]}汇总为空，保留上次数据并继续其他范围`});
    continue;
   }
   if(result.items?.length!==1||result.items[0].data?.trend_response?.success!==true)throw Error('趋势数据未完整返回，稍后重试');
   const summary=result.items[0].data?.result||{};
   if(!['impressionCount','clickCount','orderPayOrderNum','orderPayGoodsNum','clickImpressionRate','clickOrderRatio','orderPayImpressionRate'].some(key=>typeof summary[key]==='number'&&Number.isFinite(summary[key]))){
    throw Error('流量接口汇总全部为空，未更新有效报表；请在商品流量页确认站点与查询条件');
   }
   result.items[0].data.auto_job_id=job;
   await wbEnqueue({method:'POST',path:'/api/client/flow-overviews',body:{mall_id:mall,store_name:shop.name,items:result.items}});
   validDimensions.push(dimension);
   await wbAutoWrite({message:`${shop.name}：已保存 ${validDimensions.length}/${dimensions.length} 个有效范围`});
  }
  state=await wbAutoRead();
  const sync=await wbFlush();
   if(sync.pending)throw Error('流量已保存在扩展，待补传 '+sync.pending+' 批：'+(sync.last_error||'本地尚未接收'));
   if(!validDimensions.length||!validDimensions.some(dimension=>dimension===0||dimension===1))throw Error('本轮实时与近1日均无有效汇总，未更新自动采集完成状态；其他已采集范围保留');
   const warning=emptyDimensions.length?emptyDimensions.map(dimension=>wbFlowRangeNames[dimension]).join('、')+'汇总为空，已保留上次数据；2 小时后重试':'';
   await wbAutoWrite({scopes:{...state.scopes,[key]:{...state.scopes?.[key],updatedAt:Date.now(),day:full&&!emptyDimensions.length?wbAutoDay():last.day,emptyDimensions}},retryAt:0,retryScope:key,error:warning,message:warning?`${shop.name}：已更新 ${validDimensions.length}/${dimensions.length} 个流量范围；${warning}`:`${shop.name}：流量已自动采集`,finishedAt:Date.now()});

 }catch(e){await wbAutoWrite({retryAt:Date.now()+WB_AUTO_INTERVAL,retryScope:flowScope,error:String(e.message||e),message:'自动更新暂未完成，可手动刷新；2 小时后自动重试'})}
 finally{
  if(flowTab!=null){
   const owned=await chrome.tabs.get(flowTab).catch(()=>null);
   if(owned&&new URL(owned.url||'about:blank').searchParams.get('wb_auto_flow')===flowMarker)await chrome.tabs.remove(flowTab).catch(()=>{});
  }
  wbAutoRunning=false;
 }
 return wbAutoRead();
}
chrome.runtime.onMessage.addListener((message,sender,reply)=>{
 if(sender.id!==chrome.runtime.id)return false;
 if(message?.type==='WORKBENCH_AUTO_TICK'){(wbProductHelper(sender.tab)?wbAutoRead():wbScheduledCollect(sender.tab)).then(reply).catch(e=>reply({error:String(e)}));return true}
 if(message?.type==='WORKBENCH_AUTO_STATUS'){wbAutoRead().then(reply);return true}
 if(message?.type==='WORKBENCH_AUTO_ENABLE'){wbAutoWrite({enabled:message.enabled===true,retryAt:0,productRetryAt:0,acceleratorRetryAt:0}).then(wbAutoRead).then(reply);return true}
 if(message?.type==='WORKBENCH_ACCELERATOR_NOW'){
  (async()=>{
   const tab=sender.tab;
   if(!tab||!wbSellerUrl(tab.url)||wbProductHelper(tab))throw Error('请在当前店铺卖家页点击更新加速器');
   const identity=await wbSellerIdentity(tab);
   const mall=String(identity.current_mall_id||'');
   if(!/^\d+$/.test(mall))throw Error('无法识别当前店铺，请确认已登录卖家中心');
   const browser=await wbBrowserIdentity();
   const body={mall_id:mall,task_type:'accelerator_status',client_id:browser.client_id};
   const response=await wbBridgeFetch(WORKBENCH_CONFIG.api+'/api/collector/collect-now',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(8000)});
   const queued=await response.json().catch(async()=>({error:await response.text().catch(()=>'')}));
   if(!response.ok || queued.error){
    throw Error(queued.error||queued.message||('请求加速器采集失败 HTTP '+response.status));
   }
   await wbAutoWrite({message:queued.message||'已请求更新加速器状态',acceleratorError:''});
   // Claim/run via the same control path as the product-status page button.
   await wbControlPoll(tab);
   return {...await wbAutoRead(),queued_message:queued.message||''};
  })().then(reply).catch(e=>reply({error:String(e.message||e)}));
  return true;
 }
 return false;
});

// Page timers are throttled when seller tabs are in the background. Alarms
// also wake the MV3 worker and check the same guarded, current-shop collector.
async function wbScheduledCollect(tab) {
 if(wbScheduledRunning||wbAutoRunning||wbControlPolling||globalThis.wbTrafficActive)return wbAutoRead();
 wbScheduledRunning=true;
 try {
  // Recheck manual requests before each automatic stage, including requests
  // received while the previous stage was running.
  for(const collect of [wbProductStatusTick,wbAcceleratorStatusTick,wbAutoTick]){
   const control=await wbControlPoll(tab);
   if(control?.pending||control?.handled||wbControlPolling||wbAutoRunning)return wbAutoRead();
   await collect(tab);
  }
  return wbAutoRead();
 }finally{wbScheduledRunning=false}
}
async function wbBackgroundCollect() {
 const tabs = await chrome.tabs.query({url:["https://agentseller.temu.com/*","https://agentseller-us.temu.com/*"]});
 const tab = tabs.filter(tab=>wbSellerUrl(tab.url)&&!wbProductHelper(tab)&&tab.status==="complete")
   .sort((a,b)=>Number(b.active)-Number(a.active)||Number(b.lastAccessed||0)-Number(a.lastAccessed||0))[0];
 if (!tab) return;
 return wbScheduledCollect(tab);
}
if(chrome.alarms) {
 const ensureAutoAlarm=()=>chrome.alarms.create("workbench-current-shop",{periodInMinutes:1});
 chrome.runtime.onInstalled?.addListener(ensureAutoAlarm);
 chrome.runtime.onStartup?.addListener(ensureAutoAlarm);
 chrome.alarms.onAlarm.addListener(alarm=>{
  if(alarm.name==="workbench-current-shop")wbBackgroundCollect().catch(error=>wbAutoWrite({controlError:String(error.message||error)}));
 });
 ensureAutoAlarm();
}
let wbControlPolling=false;
async function wbControlPost(body){
 const r=await wbBridgeFetch(WORKBENCH_CONFIG.api+'/api/bridge/collector-control',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({version:chrome.runtime.getManifest().version,...body}),signal:AbortSignal.timeout(5000)});
 if(!r.ok)throw Error('本地采集控制连接失败');return r.json();
}
async function wbControlPoll(tab){
 if(wbControlPolling||!wbSellerUrl(tab?.url)||wbProductHelper(tab))return {pending:true};
 wbControlPolling=true;
  let command=null,context=null;
 try{
  const status=await wbAutoRead();
  const manual=(await chrome.storage.local.get('temuCollectorState.v2'))['temuCollectorState.v2'];
  const blocked=globalThis.wbTrafficActive?'流量加速器正在运行，请先暂停或停止加速任务':wbManualTaskBusy(manual)?'手动采集仍在运行，请先在采集面板停止任务':wbAutoRunning?'采集正在执行：'+(status.message||'正在读取当前店铺')+'；本次刷新已排队，当前阶段结束后优先领取':'';
  const identity=await wbSellerIdentity(tab);
  const mall=String(identity.current_mall_id||''),shop=identity.shops?.find(s=>String(s.mall_id)===mall)||{name:identity.store_name||''};
  const browser=await wbBrowserIdentity();
  const productError = (!status.productMallId || status.productMallId===mall) ? status.productError || '' : '';
   context={client_id:browser.client_id,browser:browser.browser,mall_id:mall,store_name:String(shop?.name||''),
    auto_state:{enabled:status.enabled!==false,product_error:productError,flow_error:status.error||'',
     product_finished_at:status.productMallId===mall?Number(status.productFinishedAt||0):0,
     product_retry_at:status.productMallId===mall?Number(status.productRetryAt||0):0,
      accelerator_error:status.acceleratorMallId===mall?status.acceleratorError||'':'',
      accelerator_finished_at:status.acceleratorMallId===mall?Number(status.acceleratorFinishedAt||0):0,
      accelerator_retry_at:status.acceleratorMallId===mall?Number(status.acceleratorRetryAt||0):0}};
  const response=await wbControlPost({...context,claim:!blocked&&/^\d+$/.test(mall),blocked_reason:blocked,message:blocked||productError||status.error||status.message||'自动采集插件已连接'});
   command=response.command;
  if(command){
   const began=Date.now();const result=command.kind==='daily_audit'?await globalThis.wbRunDailyAudit(tab,command,context):command.kind==='product_status'?await wbProductStatusTick(tab,true,command.mall_id,message=>wbControlPost({...context,claim:false,progress_id:command.id,message})):command.kind==='accelerator_status'?await wbAcceleratorStatusTick(tab,true,command.mall_id,message=>wbControlPost({...context,claim:false,progress_id:command.id,message})):await wbAutoTick(tab,true,command.mall_id);const sync=await wbStatus();
   await wbControlPost({...context,finished_id:command.id,error:(command.kind==='accelerator_status'?result.acceleratorError:result.error||(command.kind==='product_status'?result.productError:''))||(Number((command.kind==='accelerator_status'?result.acceleratorFinishedAt:result.finishedAt)||0)<began?'本次采集未启动，可能已有任务运行，请稍后重试':''),message:result.message+(sync.pending?'；待补传 '+sync.pending+' 批':'；已同步本地')});
  }
 return {handled:!!command,pending:response.pending===true};
  }catch(error){
   const message=String(error.message||error);
   if(command&&context)await wbControlPost({...context,claim:false,finished_id:command.id,error:message}).catch(()=>{});
   await wbAutoWrite({controlError:message}).catch(()=>{});
    return {pending:true};
  }finally{wbControlPolling=false}
}
chrome.runtime.onMessage.addListener((message,sender,reply)=>{
 if(sender.id===chrome.runtime.id&&message?.type==='WORKBENCH_CONTROL_POLL'){wbControlPoll(sender.tab).then(()=>reply({ok:true}));return true}return false;
});
