/* Local-only optional features for workbench extension 0.17.x. */
const WBF_SCHEDULE_KEY='workbench.collector.schedule.v2';
const WBF_SCHEDULE_RUN_KEY='workbench.collector.schedule.run.v2';
const WBF_IMAGE_KEY='temuImageHoverDownload.v1';
const WBF_IMAGE_SCRIPT_ID='temu-image-hover-download';
const WBF_ALARMS={morning:'workbench-collector-morning',night:'workbench-collector-night'};

function wbfScheduleMinutes(value){const m=/^(\d{2}):(\d{2})$/.exec(String(value||''));if(!m)return null;const h=Number(m[1]),n=Number(m[2]);return h<24&&n<60?h*60+n:null}
function wbfNextTime(value,now=Date.now()){const n=wbfScheduleMinutes(value);if(n==null)return null;const d=new Date(now);d.setHours(Math.floor(n/60),n%60,0,0);if(d.getTime()<=now)d.setDate(d.getDate()+1);return d.getTime()}
async function wbfRestoreAlarms(){
 const saved=(await chrome.storage.local.get(WBF_SCHEDULE_KEY))[WBF_SCHEDULE_KEY]||{};
 for(const [kind,name] of Object.entries(WBF_ALARMS)){
  await chrome.alarms.clear(name).catch(()=>null);
  const entry=saved[kind];if(saved.enabled!==true||entry?.enabled!==true)continue;
  const when=wbfNextTime(entry.time);if(when)chrome.alarms.create(name,{when,periodInMinutes:1440});
 }
 return {success:true,schedule:saved};
}
async function wbfLaunchMode(mode,runId){
 if(globalThis.wbTrafficActive)throw Error('流量加速器正在运行，定时采集等待下次执行');
 const seller=mode!=='ads';
 const matches=seller?['https://agentseller-us.temu.com/*','https://agentseller.temu.com/*']:['https://ads.temu.com/*'];
 const url=mode==='products'?'https://agentseller.temu.com/goods/list':mode==='ads'?'https://ads.temu.com/ad-list.html':'https://agentseller-us.temu.com/main/flux-analysis';
 let tabs=await chrome.tabs.query({url:matches}),tab=tabs.find(item=>item.status==='complete')||tabs[0];
 if(!tab)throw new Error(`${mode==='ads'?'广告':'商家后台'}页面未打开；定时任务没有自动登录账号`);
 const launch={mode,at:Date.now(),scheduleAutoStart:true,scheduleRunId:runId};
 await chrome.storage.local.set({'temuCollectorLaunch.v1':launch});
 await chrome.tabs.update(tab.id,{url,active:false});
 return {success:true,tabId:tab.id};
}
async function wbfStartSchedule(alarm){
 if(globalThis.wbTrafficActive)return;
 const saved=(await chrome.storage.local.get(WBF_SCHEDULE_KEY))[WBF_SCHEDULE_KEY]||{};
 if(saved.enabled!==true)return;
 if(Number(alarm?.scheduledTime||0)&&Date.now()-Number(alarm.scheduledTime)>10*60*1000)return;
 const manual=(await chrome.storage.local.get('temuCollectorState.v2'))['temuCollectorState.v2']||{};
 if(['running','paused'].includes(manual.status)&&manual.phase!=='done')return;
 const modes=(Array.isArray(saved.modes)?saved.modes:['seller','products','ads']).filter(mode=>['seller','products','ads'].includes(mode));
 if(!modes.length)return;
 const run={id:crypto.randomUUID(),modes,index:0,startedAt:Date.now(),status:'running',alarm:alarm.name};
 await chrome.storage.local.set({[WBF_SCHEDULE_RUN_KEY]:run});
 try{await wbfLaunchMode(modes[0],run.id)}catch(error){run.status='failed';run.error=String(error.message||error);run.finishedAt=Date.now();await chrome.storage.local.set({[WBF_SCHEDULE_RUN_KEY]:run})}
}
async function wbfAdvanceSchedule(message){
 const run=(await chrome.storage.local.get(WBF_SCHEDULE_RUN_KEY))[WBF_SCHEDULE_RUN_KEY]||{};
 if(!message.runId||message.runId!==run.id)return {success:false,error:'定时任务标识已变化'};
 if(message.failed){run.status='failed';run.error=String(message.error||'采集失败');run.finishedAt=Date.now();await chrome.storage.local.set({[WBF_SCHEDULE_RUN_KEY]:run});return {success:true,done:true};}
 run.index=Number(run.index||0)+1;
 if(run.index>=run.modes.length){run.status='finished';run.finishedAt=Date.now();await chrome.storage.local.set({[WBF_SCHEDULE_RUN_KEY]:run});return {success:true,done:true};}
 await chrome.storage.local.set({[WBF_SCHEDULE_RUN_KEY]:run});
 await wbfLaunchMode(run.modes[run.index],run.id);return {success:true,done:false,next:run.modes[run.index]};
}

function wbfPrefixes(settings){return [...new Set((Array.isArray(settings?.urlPrefixes)?settings.urlPrefixes:[]).map(value=>String(value||'').trim()).filter(value=>{try{return ['http:','https:'].includes(new URL(value).protocol)}catch{return false}}))]}
function wbfOrigins(prefixes){return [...new Set(prefixes.map(prefix=>`${new URL(prefix).origin}/*`))]}
async function wbfRefreshImageRegistration(){
 if(!chrome.scripting?.getRegisteredContentScripts)return {success:false,error:'当前浏览器不支持动态图片工具'};
 const existing=await chrome.scripting.getRegisteredContentScripts({ids:[WBF_IMAGE_SCRIPT_ID]}).catch(()=>[]);
 if(existing.length)await chrome.scripting.unregisterContentScripts({ids:[WBF_IMAGE_SCRIPT_ID]}).catch(()=>null);
 const settings=(await chrome.storage.local.get(WBF_IMAGE_KEY))[WBF_IMAGE_KEY]||{},prefixes=wbfPrefixes(settings),matches=wbfOrigins(prefixes);
 if(settings.enabled!==true||!matches.length)return {success:true,active:false};
 if(!await chrome.permissions.contains({origins:matches}))throw new Error('适用网站权限尚未授予');
 await chrome.scripting.registerContentScripts([{id:WBF_IMAGE_SCRIPT_ID,js:['image-hover-download.js'],matches,runAt:'document_idle',persistAcrossSessions:true}]);
 return {success:true,active:true,prefixCount:prefixes.length};
}
function wbfSafeFolder(value){const parts=String(value||'').replace(/\\/g,'/').split('/').map(v=>v.trim()).filter(Boolean);if(!parts.length||parts.some(v=>v==='.'||v==='..'))throw new Error('请设置有效的下载子目录');return parts.map(v=>v.replace(/[<>:"|?*\u0000-\u001f]/g,'_').replace(/[. ]+$/g,'')||'图片').join('/')}
function wbfSafeFile(value,url){let name=String(value||'').trim();if(!name)try{name=decodeURIComponent(new URL(url).pathname.split('/').pop()||'')}catch{};name=name.replace(/[<>:"/\\|?*\u0000-\u001f]/g,'_').replace(/[. ]+$/g,'').slice(0,140);if(!name)name=`网页图片_${Date.now()}.jpg`;if(!/\.[a-z0-9]{2,5}$/i.test(name))name+='.jpg';return name}
async function wbfDownload(message,sender){
 const settings=(await chrome.storage.local.get(WBF_IMAGE_KEY))[WBF_IMAGE_KEY]||{},page=String(sender?.tab?.url||message.pageUrl||'');
 if(settings.enabled!==true||!wbfPrefixes(settings).some(prefix=>page.startsWith(prefix)))throw new Error('当前网页不在图片下载授权范围内');
 const url=String(message.imageUrl||'').trim();if(!/^(https?:|data:)/i.test(url))throw new Error('这张图片使用临时链接，无法下载');
 const filename=`${wbfSafeFolder(settings.folder)}/${wbfSafeFile(message.suggestedName,url)}`;
 const downloadId=await chrome.downloads.download({url,filename,conflictAction:'uniquify',saveAs:false});return {success:true,downloadId,filename};
}

async function wbfFeatureFetch(path){
 const url=new URL(String(path||''),WORKBENCH_CONFIG.api);
 if(url.origin!==new URL(WORKBENCH_CONFIG.api).origin||!url.pathname.startsWith('/api/features/'))throw new Error('本地功能接口无效');
 const response=await wbBridgeFetch(url,{signal:AbortSignal.timeout(10000)});
 const data=await response.json();if(!response.ok)throw new Error(data.error||'本地功能数据读取失败');return data;
}
async function wbfCurrentMall(sender){
 const context=await wbContextForTab(sender?.tab);if(!context.mall_id)throw new Error('无法确认当前浏览器店铺');return context;
}

chrome.alarms?.onAlarm?.addListener(alarm=>{if(Object.values(WBF_ALARMS).includes(alarm.name))wbfStartSchedule(alarm).catch(()=>{})});
chrome.runtime.onStartup?.addListener(()=>{wbfRestoreAlarms();wbfRefreshImageRegistration().catch(()=>{})});

chrome.runtime.onMessage.addListener((message,sender,reply)=>{
 if(sender.id!==chrome.runtime.id)return false;
 if(message?.type==='SAVE_LOCAL_SCHEDULE'){
  (async()=>{const schedule=message.schedule||{};for(const key of ['morning','night'])if(schedule[key]?.enabled&&wbfScheduleMinutes(schedule[key].time)==null)throw new Error('定时时间格式无效');schedule.enabled=Boolean(schedule.morning?.enabled||schedule.night?.enabled);schedule.modes=(schedule.modes||[]).filter(mode=>['seller','products','ads'].includes(mode));schedule.updatedAt=Date.now();await chrome.storage.local.set({[WBF_SCHEDULE_KEY]:schedule});await wbfRestoreAlarms();reply({success:true,schedule});})().catch(error=>reply({success:false,error:String(error.message||error)}));return true;
 }
 if(message?.type==='GET_LOCAL_SCHEDULE'){chrome.storage.local.get([WBF_SCHEDULE_KEY,WBF_SCHEDULE_RUN_KEY]).then(value=>reply({success:true,schedule:value[WBF_SCHEDULE_KEY]||{},run:value[WBF_SCHEDULE_RUN_KEY]||{}}));return true;}
 if(message?.type==='LOCAL_SCHEDULE_STAGE_DONE'){wbfAdvanceSchedule(message).then(reply).catch(error=>reply({success:false,error:String(error.message||error)}));return true;}
 if(message?.type==='IMAGE_HOVER_SETTINGS_UPDATED'){wbfRefreshImageRegistration().then(reply).catch(error=>reply({success:false,error:String(error.message||error)}));return true;}
 if(message?.type==='DOWNLOAD_HOVERED_IMAGE'){wbfDownload(message,sender).then(reply).catch(error=>reply({success:false,error:String(error.message||error)}));return true;}
 if(message?.type==='WORKBENCH_FEATURE_API'){
  (async()=>{const context=await wbfCurrentMall(sender);const url=new URL(message.path,WORKBENCH_CONFIG.api);if(!url.searchParams.has('mall_id'))url.searchParams.set('mall_id',context.mall_id);reply(await wbfFeatureFetch(url.href));})().catch(error=>reply({success:false,error:String(error.message||error)}));return true;
 }
 if(message?.type==='WORKBENCH_PRODUCT_CONTEXT'||message?.type==='WORKBENCH_PRODUCT_EVIDENCE'){
   (async()=>{
    if(!wbSellerUrl(sender.tab?.url)||new URL(sender.tab.url).pathname!=='/main/flux-analysis')throw Error('商品状态仅从流量分析页读取');
    const context=await wbfCurrentMall(sender);
    const checked=await wbAutoCall(sender.tab.id,'VERIFY_SELLER_SHOP',{mallId:context.mall_id,name:context.store_name});
    if(!checked.matches)throw Error('店铺身份尚未稳定，本批状态未保存');
    if(message.type==='WORKBENCH_PRODUCT_CONTEXT')return {success:true,...context};
    if(message.observedMallId!==context.mall_id)throw Error('采集期间店铺发生变化');
    if(!Array.isArray(message.rows)||message.rows.length>300)throw Error('商品状态格式无效');
    const after=await wbfCurrentMall(sender);
    if(after.mall_id!==context.mall_id)throw Error('店铺发生变化，本批状态未保存');
    await wbEnqueue({method:'POST',path:'/api/client/products/accelerators/upload',body:{
      mall_id:context.mall_id,source_mall_id:context.mall_id,store_name:context.store_name,rows:message.rows,
      crawl_result:{source:'visible_flow_page',source_mall_id:context.mall_id,complete:false}
    }});
    const sync=await wbFlush();
    if(sync.pending)throw Error('加速器状态已保存在扩展，待补传 '+sync.pending+' 批');
    return {success:true};
   })().then(reply).catch(error=>reply({success:false,error:String(error.message||error)}));return true;
  }
  if(message?.type==='FLOW_PRODUCT_GALLERY'){
  (async()=>{const started=performance.now(),context=await wbfCurrentMall(sender),data=await wbfFeatureFetch(`/api/features/catalog?mall_id=${encodeURIComponent(context.mall_id)}`),ids=new Set((message.spuIds||[]).map(String));const products=[];for(const id of ids){const images=[...new Set(data.products.filter(product=>String(product.spuId)===id).flatMap(product=>product.images||[]))];products.push({spuId:id,images,source:'local-workbench'});}reply({success:true,mallId:context.mall_id,products,durationMs:Math.round(performance.now()-started)});})().catch(error=>reply({success:false,error:String(error.message||error)}));return true;
 }
 if(message?.type==='WORKBENCH_TASK_PROGRESS'){
  (async()=>{const context=await wbfCurrentMall(sender);await wbControlPost({...context,task_state:message.state||{},message:String(message.state?.message||'采集插件已连接')});reply({success:true});})().catch(error=>reply({success:false,error:String(error.message||error)}));return true;
 }
 return false;
});

wbfRestoreAlarms();
wbfRefreshImageRegistration().catch(()=>{});
