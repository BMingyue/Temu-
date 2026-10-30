/* Store completed collector payloads in the user's local workbench.
 * No collector data or account identifier is sent to an external service.
 */
const WB_PATHS = new Set(['/api/client/products/accelerators/upload','/api/client/flow-overviews','/api/client/products/upload','/api/client/products/activities/upload','/api/client/orders/upload','/api/client/returns/upload','/api/client/shipping/upload','/api/client/ads/save','/api/client/daily-audits']);
const WB_PREFIX='workbench.outbox.v1.';
const WB_CLIENT_KEY='workbench.browser.identity.v1';
let wbQueueLock=Promise.resolve(),wbFlushLock=null;
const wbSerial=fn=>{const task=wbQueueLock.then(fn);wbQueueLock=task.catch(()=>{});return task};
function wbBrowserName(){return /Edg\//.test(navigator.userAgent)?'Edge':/Chrome\//.test(navigator.userAgent)?'Chrome':'Chromium'}
function wbSellerUrl(value){try{return /^https:\/\/agentseller(?:-us)?\.temu\.com\//.test(String(value||''))}catch{return false}}
async function wbBrowserIdentity(){
 const saved=(await chrome.storage.local.get(WB_CLIENT_KEY))[WB_CLIENT_KEY];
 if(saved?.client_id)return {...saved,browser:wbBrowserName()};
 const value={client_id:crypto.randomUUID().replace(/-/g,''),browser:wbBrowserName(),created_at:new Date().toISOString()};
 await chrome.storage.local.set({[WB_CLIENT_KEY]:value});return value;
}
async function wbSellerIdentity(tab){
 let info={},mall='',store='';
 if(tab?.id&&wbSellerUrl(tab.url)){
  try{info=await chrome.tabs.sendMessage(tab.id,{type:'TEMU_COLLECT',tabId:tab.id,command:'USER_INFO',payload:{},timeout:15000})||{}}catch{}
  mall=String(info.current_mall_id||'');
  if(!/^\d+$/.test(mall)){try{const cookie=await chrome.cookies.get({url:new URL(tab.url).origin+'/',name:'mallid'});mall=String(cookie?.value||'')}catch{mall=''}}
  store=String((info.shops||[]).find(s=>String(s.mall_id)===mall)?.name||'');
 }
 const saved=(await chrome.storage.local.get('temuCollectorState.v2'))['temuCollectorState.v2']||{};
 if(!store&&mall)store=String((saved.shops||[]).find(s=>String(s.database_mall_id||s.mall_id)===mall)?.database_name||(saved.shops||[]).find(s=>String(s.mall_id)===mall)?.name||'');
 return {success:Boolean(/^\d+$/.test(mall)),current_mall_id:/^\d+$/.test(mall)?mall:'',store_name:store,shops:Array.isArray(info.shops)?info.shops:[]};
}
async function wbContextForTab(tab){
 const base=await wbBrowserIdentity(),identity=await wbSellerIdentity(tab);
 const mall=identity.current_mall_id,store=identity.store_name;
 return {...base,mall_id:/^\d+$/.test(mall)?mall:'',store_name:store,version:chrome.runtime.getManifest().version};
}
async function wbCurrentContext(){
 const tabs=await chrome.tabs.query({currentWindow:true});
 const active=tabs.find(t=>t.active&&wbSellerUrl(t.url));
 const seller=active||tabs.find(t=>wbSellerUrl(t.url));
 return wbContextForTab(seller);
}
function wbClean(value){
 if(Array.isArray(value))return value.map(wbClean);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>!/phone|password|cookie|token|authorization|requestheaders|anti.content/i.test(key)).map(([k,v])=>[k,wbClean(v)]));
 return value;
}
async function wbStatus(){
 const all=await chrome.storage.local.get(null);
 return {pending:Object.keys(all).filter(k=>k.startsWith(WB_PREFIX)).length,...(all['workbench.status.v1']||{}),url:WORKBENCH_CONFIG.ui};
}
async function wbEnqueue(message){
 if(message.method!=='POST'||!WB_PATHS.has(message.path))return false;
 const identity=await wbBrowserIdentity();
 const body={...wbClean(message.body),collector_browser:identity.browser,collector_client_id:identity.client_id};
 if(!body||!body.mall_id)throw Error('本地同步缺少店铺 ID');
 const canonical=JSON.stringify({path:message.path,body});
 if(new TextEncoder().encode(canonical).length>15000000)throw Error('单批数据超过 15MB，本地未缓存；请缩小采集范围后重试');
 const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical)))).map(b=>b.toString(16).padStart(2,'0')).join('');
 await wbSerial(async()=>{
  const all=await chrome.storage.local.get(null),key=WB_PREFIX+hash;
  if(!all[key]&&Object.keys(all).filter(k=>k.startsWith(WB_PREFIX)).length>=300)throw Error('本地待同步队列已达 300 批，请先启动工作台并点击补传');
  if(!all[key])await chrome.storage.local.set({[key]:{id:hash,path:message.path,body,observed_at:new Date().toISOString(),source:'temu-collector-'+chrome.runtime.getManifest().version}});
 });
 return true;
}
async function wbFlush(){
 if(wbFlushLock)return wbFlushLock;
 wbFlushLock=(async()=>{
  const all=await chrome.storage.local.get(null);
  const pending=Object.entries(all).filter(([key])=>key.startsWith(WB_PREFIX)).sort((a,b)=>a[1].observed_at.localeCompare(b[1].observed_at));
  for(const [key,payload] of pending){
   try{
    const r=await wbBridgeFetch(WORKBENCH_CONFIG.api+'/api/bridge/collector',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(4000)});
    const receipt=await r.json();if(!r.ok)throw Error(receipt.error||'本地写入失败');
    if(receipt.id!==payload.id)throw Error('本地回执不匹配，已保留待传数据');
    await wbSerial(()=>chrome.storage.local.remove(key));
    await chrome.storage.local.set({'workbench.status.v1':{last_success:new Date().toISOString(),last_error:'',last_receipt:receipt}});
   }catch(error){
    const previous=(await chrome.storage.local.get('workbench.status.v1'))['workbench.status.v1']||{};
    await chrome.storage.local.set({'workbench.status.v1':{...previous,last_error:'本地同步未完成，数据保留待补传：'+String(error.message||error),failed_at:new Date().toISOString()}});
    break;
   }
  }
  return wbStatus();
 })().finally(()=>{wbFlushLock=null});
 return wbFlushLock;
}
async function wbMirror(message){
 try{if(await wbEnqueue(message))await wbFlush()}
 catch(error){
  const previous=(await chrome.storage.local.get('workbench.status.v1'))['workbench.status.v1']||{};
  await chrome.storage.local.set({'workbench.status.v1':{...previous,last_error:'本批本地同步失败，请重新采集：'+String(error.message||error)}});
 }
}

function wbDateRange(start,end){
 const result=[];
 const cursor=new Date(`${start}T00:00:00+08:00`),last=new Date(`${end}T00:00:00+08:00`);
 if(!Number.isFinite(cursor.getTime())||!Number.isFinite(last.getTime()))return result;
 while(cursor<=last&&result.length<370){result.push(new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai'}).format(cursor));cursor.setUTCDate(cursor.getUTCDate()+1)}
 return result;
}
function wbUploadResult(path,body){
 const rows=Array.isArray(body.rows)?body.rows:[];
 if(path==='/api/client/products/upload'){
  const skcs=new Set(rows.map(row=>String(row.skcId||'')).filter(Boolean));
  return {success:true,normalized_skus:rows.length,listed_skc_count:skcs.size,delisted_skc_count:0,local_only:true};
 }
 if(path==='/api/client/products/activities/upload')return {success:true,activities:new Set(rows.map(row=>String(row.enrollId||'')).filter(Boolean)).size,local_only:true};
 if(path==='/api/client/orders/upload'){
  const deferred=rows.filter(row=>row.money==null),parents=new Set(deferred.map(row=>String(row.parentOrderSn||'')).filter(Boolean));
  return {success:true,uploaded_rows:rows.length,deferred_rows:deferred.length,deferred_parents:parents.size,local_only:true};
 }
 if(path==='/api/client/returns/upload')return {success:true,rows:rows.length,sku_repair:{repaired_count:0},local_only:true};
 if(path==='/api/client/shipping/upload')return {success:true,rows:rows.length,found:rows.filter(row=>row.lookup_status==='found').length,local_only:true};
 if(path==='/api/client/daily-audits')return {success:true,rows:rows.length,local_only:true};
 return {success:true,local_only:true};
}
function wbOrderKey(row){return [row?.parentOrderSn||row?.parent_order_sn,row?.orderSn||row?.order_sn,row?.skuId||row?.sku_id].map(value=>String(value||'').trim()).join('|')}
async function wbUpdateOrderState(body){
 const mall=String(body.mall_id||''),pendingKey=`workbench.local.pendingMoney.${mall}`,moneyKey=`workbench.local.moneyCache.${mall}`;
 const saved=await chrome.storage.local.get([pendingKey,moneyKey]),pending={...(saved[pendingKey]||{})},money={...(saved[moneyKey]||{})};
 for(const row of body.rows||[]){
  const key=wbOrderKey(row);if(!key||key==='||')continue;
  if(row.money==null||row.money==='')pending[key]=row;
  else{money[key]=row.money;delete pending[key]}
 }
 await chrome.storage.local.set({[pendingKey]:pending,[moneyKey]:money});
 return {pending,money};
}
async function wbLocalDatabaseApi(message){
 const startedAt=performance.now(),path=String(message.path||''),route=path.split('?',1)[0],body=wbClean(message.body||{});
 let data={success:true,local_only:true};
 if(WB_PATHS.has(route)){
  const localMessage={method:'POST',path:route,body};
  if(!await wbEnqueue(localMessage))throw Error('本地采集结果格式无效');
  const status=await wbFlush();
  data={...wbUploadResult(route,body),pending_local_batches:Number(status.pending||0)};
  if(route==='/api/client/orders/upload'&&body.mall_id&&body.start_date&&body.end_date){
   await wbUpdateOrderState(body);
   await chrome.storage.local.set({[`workbench.local.orderCoverage.${body.mall_id}`]:{start_date:body.start_date,end_date:body.end_date,updated_at:new Date().toISOString()}});
  }
 }else if(route==='/api/client/accounts/active-shop'){
  await chrome.storage.local.set({'workbench.local.activeMall':String(body.mall_id||'')});
 }else if(route==='/api/client/accounts/resolve-by-shops'){
  const malls=(body.mall_ids||[]).map(String).filter(Boolean),names=body.shop_names||[];
  data={success:Boolean(malls.length),phone:'',match_basis:'current_browser',shops:malls.map((mall_id,index)=>({mall_id,name:String(names[index]||`店铺 ${mall_id}`)})),local_only:true};
 }else if(route==='/api/client/flow/plan')data={success:true,dimensions:[0,1,4,5,2,3],local_only:true};
 else if(route==='/api/client/orders/pending-money'){
  const key=`workbench.local.pendingMoney.${body.mall_id}`,pending=(await chrome.storage.local.get(key))[key]||{},rows=Object.values(pending);
  data={success:true,rows,pending_parents:new Set(rows.map(row=>String(row.parentOrderSn||'')).filter(Boolean)).size,local_only:true};
 }
 else if(route==='/api/client/returns/pending-orders')data={success:true,parent_order_sns:[],total_count:0,local_only:true};
 else if(route==='/api/client/orders/money-cache'){
  const key=`workbench.local.moneyCache.${body.mall_id}`,cache=(await chrome.storage.local.get(key))[key]||{};
  data={success:true,money:(body.orders||[]).map(row=>({parent_order_sn:row.parentOrderSn,order_sn:row.orderSn,sku_id:row.skuId,money:row.money??cache[wbOrderKey(row)]})).filter(row=>row.money!=null),local_only:true};
 }
 else if(route==='/api/orders/missing-days'){
  const query=new URLSearchParams(path.includes('?')?path.slice(path.indexOf('?')+1):''),end=query.get('end_date')||new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai'}).format(new Date());
  const saved=(await chrome.storage.local.get('workbench.local.activeMall'))['workbench.local.activeMall'];
  const coverage=saved?(await chrome.storage.local.get(`workbench.local.orderCoverage.${saved}`))[`workbench.local.orderCoverage.${saved}`]:null;
  const requestedStart=query.get('start_date')||end,start=coverage?wbDateRange(requestedStart,end).slice(-7)[0]||requestedStart:requestedStart;
  const dates=wbDateRange(start,end);data={success:true,recommended_crawl_dates:dates,missing_dates:dates,refresh_dates:[],stable_incomplete_dates:coverage?[]:dates,plan_mode:coverage?'recent_7_days':'full_month',local_only:true};
 }else if(route==='/api/client/ads/plan')data={success:true,dates:wbDateRange(body.start_date,body.end_date),local_only:true};
 else if(route==='/api/client/ads/shop-setting'){
  await chrome.storage.local.set({[`workbench.local.adsDisabled.${body.mall_id}`]:body.ads_collection_disabled===true});
 }else if(route==='/api/client/data-revisions/complete'||route==='/api/client/accounts/login-result')data={success:true,local_only:true};
 else throw Error(`本地采集接口不支持：${route}`);
 const text=JSON.stringify(data);
 return {ok:true,status:200,statusText:'OK',data,text,bytes:new TextEncoder().encode(text).length,durationMs:performance.now()-startedAt};
}
chrome.runtime.onMessage.addListener((message,sender,reply)=>{
 if(sender.id!==chrome.runtime.id)return false;
 if(message?.type==='WORKBENCH_ENROLLMENT_POLL'||message?.type==='WORKBENCH_ENROLLMENT_REPORT'){
  (async()=>{
   const url=new URL(sender.tab?.url||'');
   if(!['agentseller.temu.com','agentseller-us.temu.com'].includes(url.hostname)||url.pathname!=='/activity/marketing-activity/detail-new')throw Error('报名命令只能由活动详情页执行');
   const campaign=url.searchParams.get('thematicId')||url.searchParams.get('activityId')||'';
   if(!/^\d+$/.test(campaign)||campaign!==String(message.campaign_id||campaign))throw Error('当前活动与报名命令不一致');
   const cookie=await chrome.cookies.get({url:url.origin,name:'mallid'});
   const mall=String(cookie?.value||message.mall_id||'');
   if(!/^\d+$/.test(mall))throw Error('无法确认当前店铺，请重新登录店铺');
   const body=message.type==='WORKBENCH_ENROLLMENT_POLL'
    ?{action:'poll',mall_id:mall,campaign_id:campaign,collector_version:chrome.runtime.getManifest().version}
    :{action:'report',id:message.id,claim_token:message.claim_token,status:message.status,message:message.message||'',mall_id:mall,campaign_id:campaign,collector_version:chrome.runtime.getManifest().version};
   const response=await wbBridgeFetch(WORKBENCH_CONFIG.api+'/api/bridge/activity-enrollment',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
   const value=await response.json();if(!response.ok)throw Error(value.error||'报名控制连接失败');return value;
  })().then(reply).catch(error=>reply({error:String(error.message||error)}));return true;
 }
 if(message?.type==='WORKBENCH_PRICE_CLAIM'){
  wbSerial(async()=>{
   if(!/^https:\/\/agentseller(?:-us)?\.temu\.com\/newon\/product-select(?:[?#]|$)/.test(sender.tab?.url||'')||! /^[a-f0-9]{64}$/.test(message.id||''))throw Error('调价执行来源不匹配');
   const key='workbench.price.attempt.'+message.id;
   if((await chrome.storage.local.get(key))[key])throw Error('这份计划已有提交尝试。请人工核对平台结果，禁止自动重试');
   await chrome.storage.local.set({[key]:{at:new Date().toISOString(),status:'submission_attempt_unverified',summary:wbClean(message.summary)}});return {ok:true};
  }).then(reply).catch(error=>reply({error:String(error.message||error)}));return true;
 }
 if(message?.type==='WORKBENCH_PRICE_RULES'){
  (async()=>{
   const url=new URL(sender.tab?.url||'');
   if(!['agentseller.temu.com','agentseller-us.temu.com'].includes(url.hostname)||url.pathname!=='/newon/product-select')throw Error('请在商品生命周期管理页使用调价');
   const cookie=await chrome.cookies.get({url:url.origin,name:'mallid'});
   if(!/^\d+$/.test(cookie?.value||''))throw Error('无法确认当前店铺，请重新登录店铺');
   const response=await wbBridgeFetch(WORKBENCH_CONFIG.api+'/api/bridge/price-window',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mall_id:cookie.value,skc_id:message.skc_id}),signal:AbortSignal.timeout(8000)});
   const value=await response.json();if(!response.ok)throw Error(value.error||'价格设置读取失败');return value;
  })().then(reply).catch(error=>reply({error:String(error.message||error)}));return true;
 }
 if(message?.type==='WORKBENCH_ACTIVITY_EVIDENCE'){
  (async()=>{
   let response;
   try{
    response=await wbBridgeFetch(WORKBENCH_CONFIG.api+'/api/bridge/activity-evidence',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(wbClean(message.body)),signal:AbortSignal.timeout(8000)});
   }catch(error){
    const detail=String(error?.message||error||'');
    if(/failed to fetch|network|load failed|timeout|abort/i.test(detail))throw Error('工作台数据服务未启动或正在重启，请先打开工作台后再试');
    throw error;
   }
   let value={};
   try{value=await response.json()}catch{throw Error(`工作台返回了无法识别的内容（HTTP ${response.status}）`)}
   if(!response.ok)throw Error(value.error||`活动证据写入失败（HTTP ${response.status}）`);
   await chrome.storage.local.set({'workbench.activity.status.v1':{at:new Date().toISOString(),version:chrome.runtime.getManifest().version,ok:true,rows:value.rows||0,recovered:value.recovered||0,unresolved:value.unresolved||0,error:''}});
   return value;
  })().then(reply).catch(async error=>{
   const message=String(error.message||error);
   await chrome.storage.local.set({'workbench.activity.status.v1':{at:new Date().toISOString(),version:chrome.runtime.getManifest().version,ok:false,error:message}}).catch(()=>{});
   reply({error:message});
  });
  return true;
 }
 if(message?.type==='WORKBENCH_STATUS'){wbStatus().then(reply).catch(e=>reply({error:String(e)}));return true}
 if(message?.type==='WORKBENCH_RETRY'){wbFlush().then(reply).catch(e=>reply({error:String(e)}));return true}
 if(message?.type==='WORKBENCH_CONTEXT'){wbCurrentContext().then(reply).catch(e=>reply({error:String(e)}));return true}
 return false;
});

// Wake on browser start and periodically retry durable local outbox batches.
if(chrome.alarms){
 const ensureAlarm=()=>chrome.alarms.create('workbench-local-retry',{periodInMinutes:5});
 chrome.runtime.onInstalled.addListener(ensureAlarm);
 chrome.runtime.onStartup.addListener(()=>{ensureAlarm();wbFlush().catch(()=>{});});
 chrome.alarms.onAlarm.addListener(a=>{if(a.name==='workbench-local-retry')wbFlush().catch(()=>{});});
 ensureAlarm();
}
