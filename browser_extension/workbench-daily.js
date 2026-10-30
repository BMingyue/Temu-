// Automatic current-shop traffic plus optional manual collection tools.
async function wbDailyMount(){
 if(document.getElementById('wbDailyBar'))return;
 const box=document.createElement('div');box.id='wbDailyBar';
 box.style.cssText='position:fixed;bottom:12px;left:270px;z-index:2147483000;padding:10px 14px;background:#fff8ee;border:1px solid #deab72;border-radius:10px;box-shadow:0 3px 15px #0002;font:13px sans-serif;color:#493c31;max-width:850px';
 const title=document.createElement('strong');title.textContent='每日数据更新 · 自动流量';box.append(title);
 const status=document.createElement('div');status.style.margin='6px 0';box.append(status);
 async function check(){try{const s=await chrome.runtime.sendMessage({type:'WORKBENCH_RETRY'});status.textContent=`待补传 ${s.pending??'未知'} 批 · 最近本地同步：${s.last_success?new Date(s.last_success).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'}):'尚未成功'}。`;if(s.last_error)status.textContent+=' '+s.last_error;}catch{status.textContent='连接中断；请启动本地工作台后重试。'}}
 for(const [mode,label] of [['seller','更新订单＋流量'],['products','更新商品＋活动'],['ads','更新广告']]){const b=document.createElement('button');b.textContent=label;b.style.cssText='margin:3px;padding:6px;cursor:pointer';b.onclick=()=>document.dispatchEvent(new CustomEvent('temu-collector-open',{detail:{mode}}));box.append(b);}
 const accel=document.createElement('button');accel.textContent='更新加速器状态';accel.style.cssText='margin:3px;padding:6px;cursor:pointer';
 accel.onclick=async()=>{accel.disabled=true;try{const s=await chrome.runtime.sendMessage({type:'WORKBENCH_ACCELERATOR_NOW'});if(s?.error)throw Error(s.error);showAuto(s);autoStatus.textContent=(s.queued_message?s.queued_message+' · ':'')+(autoStatus.textContent||'');}catch(error){autoStatus.textContent='加速器更新失败：'+String(error.message||error);}finally{accel.disabled=false;await check();}};
 box.append(accel);
 const autoStatus=document.createElement('div');autoStatus.style.margin='6px 0';box.append(autoStatus);
 const autoButton=document.createElement('button');autoButton.style.marginRight='8px';box.append(autoButton);
 let autoEnabled=true;
 function showAuto(s){autoEnabled=s.enabled!==false;autoButton.textContent=autoEnabled?'暂停自动更新':'开启自动更新';autoStatus.textContent=(autoEnabled?'自动更新已开启 · ':'已暂停 · ')+(s.message||'手动刷新优先；商品、活动、加速器与流量每 2 小时自动更新')+(s.productError?' · 商品/报名更新失败：'+s.productError:'')+(s.acceleratorError?' · 加速器更新失败：'+s.acceleratorError:'')+(s.error&&s.error!==s.productError?' · '+s.error:'')+(s.job?' · 编号 '+s.job:'');}
 autoButton.onclick=async()=>{showAuto(await chrome.runtime.sendMessage({type:'WORKBENCH_AUTO_ENABLE',enabled:!autoEnabled}));if(autoEnabled)tick()};
 async function tick(){try{showAuto(await chrome.runtime.sendMessage({type:'WORKBENCH_AUTO_TICK'}));await check()}catch{autoStatus.textContent='扩展连接失效，请刷新此店铺页面'}}
 async function autoCheck(){chrome.runtime.sendMessage({type:'WORKBENCH_CONTROL_POLL'}).catch(()=>{});try{showAuto(await chrome.runtime.sendMessage({type:'WORKBENCH_AUTO_STATUS'}))}catch{}}
 const retry=document.createElement('button');retry.textContent='检查 / 补传';retry.onclick=check;box.append(retry);
 const hide=document.createElement('button');hide.textContent='收起';hide.style.marginLeft='8px';hide.onclick=()=>{box.hidden=true};box.append(hide);
 document.body.append(box);await check();
 setTimeout(tick,12000);
 setInterval(tick,60000);
 setInterval(autoCheck,5000);
 await autoCheck();
}
