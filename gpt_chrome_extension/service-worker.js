if(typeof importScripts==='function')importScripts('config.js','pairing.js');
const extensionApi=globalThis.browser||globalThis.chrome;
const API='http://127.0.0.1:18769/api/bridge/gpt';
const pairing=createWorkbenchPairing({extensionApi,api:API,initialToken:globalThis.WORKBENCH_TOKEN});
let armed=null;
const chatTab=tab=>Boolean(tab&&/^https:\/\/chatgpt\.com\//.test(tab.url||''));
async function reuseTab(tab,url){
 if(!chatTab(tab))return null;
 if(tab.url===url)await extensionApi.tabs.reload(tab.id);
 else await extensionApi.tabs.update(tab.id,{url,active:false});
 return {...tab,url};
}
async function savedArmed(){
 if(armed)return armed;
 const saved=await extensionApi.storage.local.get('armedDownload');
 armed=saved.armedDownload||null;return armed;
}
async function rememberArmed(value){armed=value||null;if(value)await extensionApi.storage.local.set({armedDownload:value});else await extensionApi.storage.local.remove('armedDownload')}
function waitForDownload(downloadId,step,timeout=180000){
 return new Promise(async(resolve,reject)=>{
  let finished=false,timer=null;
  const done=(error,item)=>{if(finished)return;finished=true;clearTimeout(timer);extensionApi.downloads.onChanged.removeListener(listener);error?reject(error):resolve(item)};
  const inspect=async()=>{const [item]=await extensionApi.downloads.search({id:downloadId});if(item?.state==='complete')done(null,item);else if(item?.state==='interrupted')done(Error('浏览器下载失败：'+(item.error||'下载中断')))};
  const listener=delta=>{if(delta.id!==downloadId)return;if(delta.error?.current)done(Error('浏览器下载失败：'+delta.error.current));else if(delta.state?.current==='complete')inspect().catch(done)};
  timer=setTimeout(()=>done(Error('第 '+step+' 张图片下载超过 3 分钟')),timeout);
  extensionApi.downloads.onChanged.addListener(listener);
  inspect().catch(done);
 });
}
const identity=(async()=>{
 const saved=await extensionApi.storage.local.get('workerId');
 const worker_id=saved.workerId||globalThis.WORKBENCH_WORKER_ID||crypto.randomUUID();
 if(!saved.workerId)await extensionApi.storage.local.set({workerId:worker_id});
 const userAgent=navigator.userAgent;
 return {worker_id,browser:/Firefox\//.test(userAgent)?'firefox':/Edg\//.test(userAgent)?'edge':'chrome'};
})();
async function post(path,body){
 const owner=await identity;
 body={...body,...owner,session:body.session?owner.worker_id+':'+body.session:undefined};
 for(let attempt=0;attempt<2;attempt++){
  const token=await pairing.getToken(attempt>0),controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
  try{
   const response=await fetch(API+path,{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},body:JSON.stringify(body),signal:controller.signal});
   const value=await response.json();
   if(response.status===403&&attempt===0)continue;
   if(!response.ok)throw Error(response.status===403?'本机自动配对失败，请先启动最新版工作台，再重新加载扩展':value.error||'本地工作台请求失败');
   return value;
  }finally{clearTimeout(timer)}
 }
 throw Error('本机自动配对失败，请先启动最新版工作台，再重新加载扩展');
}
extensionApi.runtime.onMessage.addListener((message,_sender,reply)=>{
 if(message?.type==='runner-context'||message?.type==='isolate-runner'){
  (async()=>{
   if(!chatTab(_sender.tab))return {ok:false};
   const saved=await extensionApi.storage.local.get('isolatedRunnerTabs'),tabs=saved.isolatedRunnerTabs||{};
   if(message.type==='isolate-runner'){
    tabs[_sender.tab.id]={job_id:message.job_id,at:Date.now()};
    await extensionApi.storage.local.set({isolatedRunnerTabs:tabs});
    watchQueue();
   }
   return {ok:true,isolated:Boolean(tabs[_sender.tab.id])};
  })().then(reply).catch(error=>reply({ok:false,error:String(error?.message||error)}));return true;
 }
 if(message?.type==='protect-runner'){
  (async()=>{
   if(!chatTab(_sender.tab))return {ok:false,error:'Only a ChatGPT task tab can be protected'};
   const options=(await identity).browser!=='firefox'?{autoDiscardable:false}:{};
   // Select only the already-owned execution tab inside its current window.
   // tabs.update(active) never focuses the window or creates another page.
   if(message.activate===true)options.active=true;
   if(Object.keys(options).length)await extensionApi.tabs.update(_sender.tab.id,options);
   return {ok:true};
  })().then(reply).catch(error=>reply({ok:false,error:String(error?.message||error)}));return true;
 }
 if(message?.type==='diagnose'){
  post('/watchdog',{}).then(async()=>reply({ok:true,...await identity,version:extensionApi.runtime.getManifest().version})).catch(error=>reply({ok:false,error:String(error?.message||error)}));
  return true;
 }
 if(message?.type==='api'){
  post(message.path,{...message.body,session:'tab-'+_sender.tab?.id}).then(value=>reply({ok:true,value})).catch(error=>reply({ok:false,error:String(error?.message||error)}));
  return true;
 }
 if(message?.type==='open-clean-tab'){
  (async()=>{
   const signature=String(message.signature||'');
   if(!/^[a-f0-9]{64}$/.test(signature))return {ok:false,error:'草稿指纹无效'};
   const saved=await extensionApi.storage.local.get(['draftRecoveryAt','draftRecoverySignature','recoveryTab']);
   const existing=saved.recoveryTab?await extensionApi.tabs.get(saved.recoveryTab).catch(()=>null):null;
   if(Date.now()-Number(saved.draftRecoveryAt||0)<15*60*1000&&existing?.url?.startsWith('https://chatgpt.com/')){
    if(saved.draftRecoverySignature!==signature){
     await extensionApi.storage.local.set({draftRecoverySignature:signature});
     await extensionApi.tabs.reload(existing.id);
    }
    return {ok:true,skipped:true};
   }
    const tab=await reuseTab(existing,'https://chatgpt.com/')||await extensionApi.tabs.create({url:'https://chatgpt.com/',active:false});
   await extensionApi.storage.local.set({draftRecoveryAt:Date.now(),draftRecoverySignature:signature,recoveryTab:tab.id});
   return {ok:true};
  })().then(reply).catch(error=>reply({ok:false,error:String(error?.message||error)}));
  return true;
 }
 if(message?.type==='recovery-context'){
  extensionApi.storage.local.get(['recoveryTab','draftRecoverySignature']).then(saved=>reply({ok:true,is_recovery:_sender.tab?.id===saved.recoveryTab,signature:saved.draftRecoverySignature||''})).catch(error=>reply({ok:false,error:String(error?.message||error)}));
  return true;
 }
 if(message?.type==='arm-download'){
  rememberArmed({...message.task,session:'tab-'+_sender.tab?.id,created:Date.now(),downloadId:null,tabId:_sender.tab?.id}).then(()=>reply({ok:true})).catch(error=>reply({ok:false,error:String(error?.message||error)}));return true;
 }
 if(message?.type==='download-source'){
  const task=message.task||{};
  let url;try{url=new URL(message.url)}catch{reply({ok:false,error:'图片地址无效'});return false}
  if(url.protocol!=='https:'||!(url.hostname==='chatgpt.com'||url.hostname==='oaiusercontent.com'||url.hostname.endsWith('.oaiusercontent.com'))){reply({ok:false,error:'图片来源不受信任'});return false}
  (async()=>{
   const id=await extensionApi.downloads.download({url:url.href,saveAs:false,conflictAction:'uniquify'});
   const item=await waitForDownload(id,task.step);
   if(!item?.filename)throw Error('没有取得浏览器下载路径');
   await post('/update',{...task,session:'tab-'+_sender.tab?.id,event:'downloaded',path:item.filename});
   return {ok:true,path:item.filename};
  })().then(reply).catch(error=>reply({ok:false,error:String(error?.message||error)}));
  return true;
 }
 if(message?.type==='download-bytes'){
  const task=message.task||{},mime=String(message.mime||'').toLowerCase(),base64=String(message.base64||'');
  if(!/^image\/(?:png|jpeg|webp)$/.test(mime)){reply({ok:false,error:'图片格式无效'});return false}
  if(!base64||base64.length>42*1024*1024||!/^[A-Za-z0-9+/=]+$/.test(base64)){reply({ok:false,error:'图片数据无效或过大'});return false}
  post('/update',{...task,session:'tab-'+_sender.tab?.id,event:'downloaded_bytes',mime,base64})
   .then(value=>reply({ok:true,value})).catch(error=>reply({ok:false,error:String(error?.message||error)}));
  return true;
 }
 return false;
});
extensionApi.downloads.onCreated.addListener(async item=>{
 const current=await savedArmed();if(!current||current.downloadId||Date.now()-current.created>60000)return;
 const name=(item.filename||item.url||'').toLowerCase();
 if(item.mime?.startsWith('image/')||/\.(png|jpe?g|webp)(?:$|\?)/.test(name))await rememberArmed({...current,downloadId:item.id});
});
extensionApi.downloads.onChanged.addListener(async delta=>{
 const current=await savedArmed();if(!current||delta.id!==current.downloadId)return;
 if(delta.error?.current){
  const task=current;await rememberArmed(null);const message='浏览器下载失败：'+delta.error.current;
  await post('/update',{...task,event:'error',message}).catch(()=>{});
  if(task.tabId)await extensionApi.tabs.sendMessage(task.tabId,{type:'download-result',job_id:task.job_id,step:task.step,ok:false,error:message}).catch(()=>{});
  return;
 }
 if(delta.state?.current!=='complete')return;
 const task=current;await rememberArmed(null);
 try{
  const [item]=await extensionApi.downloads.search({id:delta.id});
  if(!item?.filename)throw Error('没有取得浏览器下载路径');
  await post('/update',{...task,event:'downloaded',path:item.filename});
  if(task.tabId)await extensionApi.tabs.sendMessage(task.tabId,{type:'download-result',job_id:task.job_id,step:task.step,ok:true}).catch(()=>{});
 }catch(error){
  await post('/update',{...task,event:'error',message:String(error?.message||error)}).catch(()=>{});
  if(task.tabId)await extensionApi.tabs.sendMessage(task.tabId,{type:'download-result',job_id:task.job_id,step:task.step,ok:false,error:String(error?.message||error)}).catch(()=>{});
 }
});

// Wake independently of page timers; only create a recovery page for pending work.
let recovering=false;
async function watchQueue(){
 if(recovering)return;recovering=true;
 try{
  const state=await post('/watchdog',{});
  if(state.account_blocked)return;
  const action=state.recovery_action;
  if(action&&['refresh','resume'].includes(action.type)){
   const recent=(await extensionApi.storage.local.get('lastTaskRecovery')).lastTaskRecovery||{};
   if(action.type==='resume'&&recent.job_id===action.job_id&&Date.now()-Number(recent.at||0)<180000)return;
   const sameChat=(value,expectedValue)=>{try{const url=new URL(value),expected=new URL(expectedValue);return url.origin===expected.origin&&url.pathname.replace(/\/$/,'')===expected.pathname.replace(/\/$/,'')}catch{return false}};
   const match=String(action.session||'').match(/:tab-(\d+)$/),owned=match?await extensionApi.tabs.get(Number(match[1])).catch(()=>null):null;
   const saved=(await extensionApi.storage.local.get('recoveryTab')).recoveryTab;
   const recovery=saved?await extensionApi.tabs.get(saved).catch(()=>null):null;
    const target=owned&&sameChat(owned.url,action.chat_url)?owned:recovery&&sameChat(recovery.url,action.chat_url)?recovery:null;
   let tab=target;
   if(tab)await extensionApi.tabs.reload(tab.id);
    else tab=await reuseTab(owned,action.chat_url)||await reuseTab(recovery,action.chat_url)||await extensionApi.tabs.create({url:action.chat_url,active:false});
   await extensionApi.storage.local.set({recoveryTab:tab.id,lastTaskRecovery:{job_id:action.job_id,at:Date.now()}});
   if(action.type==='refresh')await post('/update',{job_id:action.job_id,event:'response_refresh'});
   return;
  }
  if(!state.pending||state.page_alive)return;
  const last=(await extensionApi.storage.local.get('lastRecovery')).lastRecovery||0;
  if(Date.now()-last<180000)return;
  await extensionApi.storage.local.set({lastRecovery:Date.now()});
  const saved=(await extensionApi.storage.local.get('recoveryTab')).recoveryTab;
   const tab=saved?await extensionApi.tabs.get(saved).catch(()=>null):null;
   const isolated=(await extensionApi.storage.local.get('isolatedRunnerTabs')).isolatedRunnerTabs||{};
   const next=await reuseTab(tab&&!isolated[tab.id]?tab:null,'https://chatgpt.com/')||await extensionApi.tabs.create({url:'https://chatgpt.com/',active:false});
   await extensionApi.storage.local.set({recoveryTab:next.id});
 }catch{}finally{recovering=false}
}
const installWatch=()=>extensionApi.alarms.create('gpt-queue-watch',{periodInMinutes:1});
async function refreshChatTabs(){
 const tabs=await extensionApi.tabs.query({url:'https://chatgpt.com/*'}).catch(()=>[]);
 for(const tab of tabs)if(tab.id)await extensionApi.tabs.reload(tab.id).catch(()=>{});
}
extensionApi.runtime.onInstalled.addListener(details=>{
 installWatch();watchQueue();
 if(details?.reason==='install')refreshChatTabs();
 if(details?.reason==='update'){
  (async()=>{
   const state=await post('/watchdog',{});if(state.pending)return;
   const saved=(await extensionApi.storage.local.get('recoveryTab')).recoveryTab;
   const owned=saved?await extensionApi.tabs.get(saved).catch(()=>null):null;
   const home=owned?.url==='https://chatgpt.com/'?owned:(await extensionApi.tabs.query({url:'https://chatgpt.com/'})).find(tab=>tab.url==='https://chatgpt.com/');
   if(home?.id)await extensionApi.tabs.reload(home.id);
  })().catch(()=>{});
 }
});
extensionApi.runtime.onStartup.addListener(()=>{installWatch();watchQueue()});
extensionApi.alarms.onAlarm.addListener(a=>{if(a.name==='gpt-queue-watch')watchQueue()});
installWatch();
