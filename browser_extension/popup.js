const statusNode=document.getElementById("status");
const views=[...document.querySelectorAll(".view")];
function showView(id){for(const view of views)view.classList.toggle("active",view.id===id)}
function friendlyPopupError(error){
 const message=String(error?.message||error||"");
 if(/context invalidated|receiving end does not exist|message port closed/i.test(message))return "插件刚刚更新，请刷新 Temu 页面后重试";
 if(/failed to fetch|networkerror|load failed|network timeout/i.test(message))return "网络连接异常，请检查网络后重试";
 if(/invalid login state|not logged|login.*expired/i.test(message))return "Temu 账号未登录或登录已失效，请重新登录";
 return message||"操作失败，请刷新页面后重试";
}
for(const button of document.querySelectorAll("button[data-mode]")){
 button.addEventListener("click",async()=>{
  for(const item of document.querySelectorAll("button[data-mode]"))item.disabled=true;
  statusNode.textContent="正在打开对应的 Temu 页面…";
  try{
   const result=await chrome.runtime.sendMessage({type:"OPEN_COLLECTOR",mode:button.dataset.mode});
   if(!result?.success)throw new Error(result?.error||"打开失败");
   window.close();
  }catch(error){statusNode.textContent=friendlyPopupError(error);for(const item of document.querySelectorAll("button[data-mode]"))item.disabled=false}
 });
}
document.getElementById("delisting-open")?.addEventListener("click",async(event)=>{
 const button=event.currentTarget;button.disabled=true;statusNode.textContent="正在打开商品列表…";
 try{
  const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
  const target="https://agentseller.temu.com/goods/list";
  if(tab?.id&&/^https:\/\/agentseller(?:-us)?\.temu\.com\//.test(tab.url||""))await chrome.tabs.update(tab.id,{url:target,active:true});
  else await chrome.tabs.create({url:target,active:true});
  window.close();
 }catch(error){statusNode.textContent="无法打开商品页："+friendlyPopupError(error);button.disabled=false}
});
for(const back of document.querySelectorAll("[data-back]"))back.addEventListener("click",()=>showView("home-view"));

const morningEnabled=document.getElementById("morning-enabled");
const morningTime=document.getElementById("morning-time");
const nightEnabled=document.getElementById("night-enabled");
const nightTime=document.getElementById("night-time");
const scheduleStatus=document.getElementById("schedule-status");
async function loadSchedule(){
 const result=await chrome.runtime.sendMessage({type:"GET_LOCAL_SCHEDULE"});
 if(!result?.success)throw new Error(result?.error||"读取失败");
 const schedule=result.schedule||{};
 morningEnabled.checked=schedule.morning?.enabled===true;morningTime.value=schedule.morning?.time||"09:00";
 nightEnabled.checked=schedule.night?.enabled===true;nightTime.value=schedule.night?.time||"21:00";
 for(const input of document.querySelectorAll('input[name="schedule-mode"]'))input.checked=(schedule.modes||["seller","products"]).includes(input.value);
 const run=result.run||{};
 scheduleStatus.textContent=run.status==="running"?"最近的定时任务正在执行":run.status==="failed"?`上次失败：${run.error||"未说明原因"}`:run.status==="finished"?"上次定时任务已完成":"";
}
document.getElementById("schedule-open")?.addEventListener("click",()=>{showView("schedule-view");loadSchedule().catch(error=>scheduleStatus.textContent=friendlyPopupError(error))});
document.getElementById("schedule-save")?.addEventListener("click",async(event)=>{
 const button=event.currentTarget;button.disabled=true;scheduleStatus.textContent="正在保存…";
 try{
  const modes=[...document.querySelectorAll('input[name="schedule-mode"]:checked')].map(input=>input.value);
  if(!modes.length)throw new Error("请至少选择一项采集内容");
  const schedule={morning:{enabled:morningEnabled.checked,time:morningTime.value},night:{enabled:nightEnabled.checked,time:nightTime.value},modes};
  const result=await chrome.runtime.sendMessage({type:"SAVE_LOCAL_SCHEDULE",schedule});
  if(!result?.success)throw new Error(result?.error||"保存失败");
  scheduleStatus.textContent=schedule.morning.enabled||schedule.night.enabled?"已保存。到点时会使用已打开且已登录的页面。":"定时采集已关闭";
 }catch(error){scheduleStatus.textContent=friendlyPopupError(error)}finally{button.disabled=false}
});

const IMAGE_KEY="temuImageHoverDownload.v1";
const imageEnabled=document.getElementById("image-enabled");
const imagePrefixes=document.getElementById("image-prefixes");
const imageFolder=document.getElementById("image-folder");
const imageStatus=document.getElementById("image-status");
function parsedPrefixes(){
 return [...new Set(imagePrefixes.value.split(/\r?\n/).map(value=>value.trim()).filter(Boolean).map(value=>{
  const url=new URL(value);if(!["http:","https:"].includes(url.protocol))throw new Error("网址只能使用 http 或 https");return value;
 }))];
}
function origins(prefixes){return [...new Set(prefixes.map(value=>new URL(value).origin+"/*"))]}
async function loadImageSettings(){
 const saved=(await chrome.storage.local.get(IMAGE_KEY))[IMAGE_KEY]||{};
 imageEnabled.checked=saved.enabled===true;
 imagePrefixes.value=(saved.urlPrefixes||["https://agentseller.temu.com/","https://agentseller-us.temu.com/"]).join("\n");
 imageFolder.value=saved.folder||"Temu图片";
}
document.getElementById("image-open")?.addEventListener("click",()=>{showView("image-view");loadImageSettings().catch(error=>imageStatus.textContent=friendlyPopupError(error))});
document.getElementById("image-save")?.addEventListener("click",async(event)=>{
 const button=event.currentTarget;button.disabled=true;imageStatus.textContent="正在保存…";
 try{
  const urlPrefixes=parsedPrefixes();if(imageEnabled.checked&&!urlPrefixes.length)throw new Error("开启时请填写至少一个适用网址");
  if(imageEnabled.checked){
   const granted=await chrome.permissions.request({origins:origins(urlPrefixes)});
   if(!granted)throw new Error("未授予网站权限，设置没有生效");
  }
  const settings={enabled:imageEnabled.checked,urlPrefixes,folder:imageFolder.value.trim()||"Temu图片",updatedAt:Date.now()};
  await chrome.storage.local.set({[IMAGE_KEY]:settings});
  const result=await chrome.runtime.sendMessage({type:"IMAGE_HOVER_SETTINGS_UPDATED"});
  if(!result?.success)throw new Error(result?.error||"动态脚本更新失败");
  imageStatus.textContent=settings.enabled?"已开启。刷新适用网页后，把鼠标移到图片上即可下载。":"功能已关闭";
 }catch(error){imageStatus.textContent=friendlyPopupError(error)}finally{button.disabled=false}
});


// Opening the tool never starts scanning or submits an item.
document.getElementById('traffic-open')?.addEventListener('click',async event=>{const button=event.currentTarget;button.disabled=true;statusNode.textContent='正在打开流量加速器面板…';try{const result=await chrome.runtime.sendMessage({type:'WORKBENCH_OPEN_TRAFFIC_ACCELERATOR'});if(!result?.ok)throw Error(result?.error||'无法打开流量加速器');window.close()}catch(error){statusNode.textContent=friendlyPopupError(error);button.disabled=false}});
