// One-click, read-only daily inspection for the currently logged-in shop.
// Results are reduced to operational counts and order/time identifiers before
// they are saved locally; customer messages and addresses are never stored.
const WB_DAILY_AUDIT_STATE='workbench.dailyAudit.v1';
let wbDailyAuditRunning=false;

function wbAuditDay(offset=0){
 const date=new Date(Date.now()+offset*86400000);
 return new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai'}).format(date);
}
function wbAuditFlowSummary(item){
 const source=item?.data?.result||{},result={};
 for(const key of ['impressionCount','clickCount','orderPayOrderNum','orderPayGoodsNum','clickImpressionRate','clickOrderRatio','orderPayImpressionRate']){
  const value=source[key],relative=source[key+'LinkRelative'];
  result[key]=typeof value==='number'&&Number.isFinite(value)?value:null;
  result[key+'LinkRelative']=typeof relative==='number'&&Number.isFinite(relative)?relative:null;
 }
 return {time_dimension:item?.time_dimension,metrics:result,overview_received_at:item?.data?.overview_received_at||new Date().toISOString(),site_label:item?.data?.site_label||null};
}
function wbAuditWaitForTab(tabId,timeout=30000){
 return new Promise((resolve,reject)=>{
  let settled=false;
  const done=(error)=>{if(settled)return;settled=true;clearTimeout(timer);chrome.tabs.onUpdated.removeListener(listener);if(error)reject(error);else resolve()};
  const listener=(id,change)=>{if(id===tabId&&change.status==='complete')done()};
  const timer=setTimeout(()=>done(new Error('后台巡检页面加载超时')),timeout);
  chrome.tabs.onUpdated.addListener(listener);
  chrome.tabs.get(tabId).then(tab=>{if(tab.status==='complete')done()}).catch(error=>done(error));
 });
}
async function wbAuditScanConsultations(tabId){
 const results=await chrome.scripting.executeScript({target:{tabId,allFrames:true},func:()=>{
  const visible=(element)=>{const rect=element.getBoundingClientRect(),style=getComputedStyle(element);return rect.width>0&&rect.height>0&&style.display!=='none'&&style.visibility!=='hidden'};
  const body=String(document.body?.innerText||'').replace(/\s+/g,' ').trim();
  const signals=[];let unread=0,hasDot=false;
  const nodes=[...document.querySelectorAll('[class*="unread" i],[class*="badge" i],[class*="count" i],[data-testid*="badge" i],[aria-label*="未读"],[aria-label*="未回复"]')].filter(visible).slice(0,300);
  for(const node of nodes){
   const own=String(node.innerText||node.textContent||node.getAttribute('aria-label')||'').replace(/\s+/g,' ').trim();
   const around=String(node.parentElement?.innerText||'').replace(/\s+/g,' ').trim().slice(0,120);
   if(!/未回复|待回复|未读|unread|unanswered/i.test(own+' '+around)&&!/unread/i.test(String(node.className)))continue;
   const match=own.match(/\b(\d{1,4})\b/)||around.match(/(?:未回复|待回复|未读)\D{0,8}(\d{1,4})/);
   if(match)unread+=Number(match[1]);else hasDot=true;
   const label=(own||around).match(/未回复|待回复|未读|unread|unanswered/i)?.[0];if(label)signals.push(label);
  }
  const textMatch=body.match(/(?:未回复|待回复|未读)\D{0,8}(\d{1,4})/);
  if(textMatch)unread=Math.max(unread,Number(textMatch[1]));
  const login=/登录|sign\s*in/i.test(document.title+' '+body.slice(0,500))&&!/消费者咨询|客服中心|conversation/i.test(body);
  const pageRecognized=/\/chat-app(?:\/|$)/i.test(location.pathname)||/消费者咨询|客服中心|conversation|咨询/i.test(body);
  const explicitEmpty=/(?:未回复|待回复|未读)[^。；\n]{0,30}(?:暂无|没有|为\s*0|0\s*条)|(?:暂无|没有)[^。；\n]{0,30}(?:未回复|待回复|未读)/i.test(body);
  const hasUnreplied=unread>0||hasDot;
  return {url:location.href,title:document.title,authenticated:!login,has_unreplied:hasUnreplied,unreplied_count:unread||null,indicator_only:unread===0&&hasDot,signals:[...new Set(signals)].slice(0,6),page_recognized:pageRecognized,definitive:hasUnreplied||explicitEmpty,explicit_empty:explicitEmpty};
 }});
 const values=results.map(item=>item.result).filter(Boolean),recognized=values.filter(item=>item.page_recognized);
 if(!values.length)throw new Error('消费者咨询页面无法读取');
 const definitive=recognized.filter(item=>item.definitive),unread=definitive.reduce((sum,item)=>sum+Number(item.unreplied_count||0),0),has=definitive.some(item=>item.has_unreplied);
 const message=definitive.length?(has?(unread?`检测到 ${unread} 条未回复/未读提示`:'检测到未回复提示红点，请进入咨询页处理'):'页面明确显示没有未回复咨询'):(recognized.length?'已打开消费者咨询页，但未找到可可靠判定的未回复状态，请人工核对':'咨询页面结构未识别，请点击来源链接人工核对');
 return {status:definitive.length?'finished':'partial',has_unreplied:definitive.length?has:null,unreplied_count:unread||null,indicator_only:has&&!unread,page_recognized:Boolean(recognized.length),authenticated:values.some(item=>item.authenticated),message};
}
async function wbAuditScanServiceAlerts(tabId){
 const results=await chrome.scripting.executeScript({target:{tabId,allFrames:true},func:()=>{
  const visible=(element)=>{const rect=element.getBoundingClientRect(),style=getComputedStyle(element);return rect.width>0&&rect.height>0&&style.display!=='none'&&style.visibility!=='hidden'};
  const clean=(value)=>String(value||'').replace(/\s+/g,' ').trim();
  const definitions=[
   ['消费者咨询',/消费者咨询(?!助手)/],
   ['售前/售后工单',/售前\s*\/\s*售后工单/],
   ['消费者咨询助手',/消费者咨询助手/],
   ['CSBS',/\bCSBS\b/i],
  ];
  const links=[...document.querySelectorAll('a[href*="/chat-app/"]')].filter(visible);
  const items=[];
  for(const link of links){
   const text=clean(link.innerText||link.textContent||link.getAttribute('aria-label'));
   const definition=definitions.find(([,pattern])=>pattern.test(text));
   if(!definition)continue;
   const [label,pattern]=definition,rest=clean(text.replace(pattern,''));
   const match=rest.match(/(?:^|\s|[（(])(99\+|\d{1,4})(?:\s|[）)]|$)/);
   const count=match?(match[1]==='99+'?99:Number(match[1])):null;
   const candidates=[link,...link.querySelectorAll('*')].filter(visible).slice(0,80);
   const hasDot=candidates.some(node=>{
    const own=clean(node.innerText||node.textContent),rect=node.getBoundingClientRect(),style=getComputedStyle(node);
    if(own&&own!==String(count??''))return false;
    const className=clean(node.className);
    const color=style.backgroundColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
    const red=color&&Number(color[1])>180&&Number(color[2])<110&&Number(color[3])<110;
    return rect.width>0&&rect.height>0&&rect.width<=28&&rect.height<=28&&(red||/(?:badge|dot|unread|notice|count)/i.test(className));
   });
   if((typeof count==='number'&&count>0)||hasDot)items.push({label,count:typeof count==='number'?count:null,indicator_only:count==null,url:link.href});
  }
  return {page_recognized:links.some(link=>definitions.some(([,pattern])=>pattern.test(clean(link.innerText||link.textContent)))),items};
 }});
 const values=results.map(item=>item.result).filter(Boolean),merged=new Map();
 for(const value of values)for(const item of value.items||[]){
  const key=item.label+'|'+item.url,old=merged.get(key);
  if(!old||Number(item.count||0)>Number(old.count||0))merged.set(key,item);
 }
 const items=[...merged.values()],attentionCount=items.reduce((sum,item)=>sum+Number(item.count||0),0),hasAttention=items.length>0;
 return {page_recognized:values.some(item=>item.page_recognized),has_attention:hasAttention,attention_count:attentionCount||null,indicator_only:hasAttention&&!attentionCount,items};
}
function wbAuditMergeServiceAlerts(consultations,serviceAlerts){
 const sidebarItems=serviceAlerts.items||[],unrepliedCount=Number(consultations.unreplied_count||0);
 const sidebarConsumerCount=sidebarItems.filter(item=>item.label==='消费者咨询').reduce((sum,item)=>sum+Number(item.count||0),0);
 const otherSidebarCount=sidebarItems.filter(item=>item.label!=='消费者咨询').reduce((sum,item)=>sum+Number(item.count||0),0);
 const hasAttention=serviceAlerts.has_attention===true||consultations.has_unreplied===true;
 // “消费者咨询”侧栏角标与咨询页未回复数通常是同一批提醒，取较大值避免重复计数。
 const attentionCount=otherSidebarCount+Math.max(sidebarConsumerCount,unrepliedCount);
 const labels=sidebarItems.map(item=>item.count?`${item.label}（${item.count}）`:item.label);
 const message=serviceAlerts.has_attention?(attentionCount?`客服中心有 ${attentionCount} 个待处理提醒：${labels.join('、')}`:`客服中心显示待处理红点：${labels.join('、')}`):consultations.message;
 return {...consultations,status:serviceAlerts.has_attention?'finished':consultations.status,has_attention:hasAttention,attention_count:attentionCount||null,attention_items:sidebarItems,sidebar_recognized:serviceAlerts.page_recognized===true,attention_url:sidebarItems[0]?.url||null,message};
}
async function wbAuditScanOrders(tabId){
 const results=await chrome.scripting.executeScript({target:{tabId,allFrames:true},func:async()=>{
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const visible=(element)=>{const rect=element.getBoundingClientRect(),style=getComputedStyle(element);return rect.width>0&&rect.height>0&&style.display!=='none'&&style.visibility!=='hidden'};
  const text=()=>String(document.body?.innerText||'').replace(/\s+/g,' ').trim();
  const count=(label)=>{const escaped=label.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),match=text().match(new RegExp(escaped+'\\s*[（(]?(\\d{1,7}|99\\+)[）)]?'));return match?(match[1]==='99+'?99:Number(match[1])):null};
  const shipped=[...document.querySelectorAll('button,[role="tab"],div,span')].filter(node=>visible(node)&&/^已发货(?:\s*[（(]?\d+\+?[）)]?)?$/.test(String(node.innerText||node.textContent||'').replace(/\s+/g,' ').trim())).sort((a,b)=>a.getBoundingClientRect().width*a.getBoundingClientRect().height-b.getBoundingClientRect().width*b.getBoundingClientRect().height)[0];
  const cancelled=count('已取消'),exception=count('物流信息异常');
  if(shipped){shipped.click();await wait(2500)}
  const body=text(),dates=[...body.matchAll(/实际发货时间\s*[：:]\s*(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})/g)].map(match=>match[1]);
  const overdue=dates.filter(value=>Date.now()-new Date(value.replace(' ','T')+'+08:00').getTime()>=72*3600000).length;
  return {page_recognized:/订单列表|待发货|已发货|已签收|已取消/.test(body),cancelled_visible_count:cancelled,logistics_exception_visible_count:exception,visible_actual_ship_times:dates.length,visible_overdue_count:overdue};
 }});
 const values=results.map(item=>item.result).filter(item=>item?.page_recognized);
 if(!values.length)return {status:'partial',message:'订单页面结构未识别；接口结果仍已保留'};
 const max=key=>{const nums=values.map(item=>item[key]).filter(value=>typeof value==='number');return nums.length?Math.max(...nums):null};
 return {status:'finished',cancelled_visible_count:max('cancelled_visible_count'),logistics_exception_visible_count:max('logistics_exception_visible_count'),visible_actual_ship_times:max('visible_actual_ship_times')||0,visible_overdue_count:max('visible_overdue_count')||0,message:'订单页面徽标与接口结果已交叉核对'};
}
async function wbAuditBackgroundPages(tab){
 const origin=new URL(tab.url).origin;
 let temporary=null,consultations={status:'partial',has_unreplied:null,unreplied_count:null,page_recognized:false,message:'消费者咨询页面未完成自动核对'},orderPage={status:'partial',message:'订单页面徽标未完成自动核对'};
 const serviceAlerts=await wbAuditScanServiceAlerts(tab.id).catch(()=>({page_recognized:false,has_attention:false,attention_count:null,items:[]}));
 try{
  temporary=await chrome.tabs.create({url:origin+'/chat-app/index',active:false});
  await wbAuditWaitForTab(temporary.id);await new Promise(resolve=>setTimeout(resolve,4500));
  try{consultations=await wbAuditScanConsultations(temporary.id)}catch(error){consultations.message=String(error?.message||error)}
  await chrome.tabs.update(temporary.id,{url:origin+'/mmsos/orders.html',active:false});
  await wbAuditWaitForTab(temporary.id);await new Promise(resolve=>setTimeout(resolve,4500));
  orderPage=await wbAuditScanOrders(temporary.id);
 }catch(error){
  if(!serviceAlerts.has_attention)consultations.message=String(error?.message||error);
 }finally{if(temporary?.id)await chrome.tabs.remove(temporary.id).catch(()=>{})}
 return {consultations:wbAuditMergeServiceAlerts(consultations,serviceAlerts),orderPage};
}
async function wbRunDailyAudit(tab,command,context){
 if(wbDailyAuditRunning)throw new Error('每日必做巡检已经在运行');
 wbDailyAuditRunning=true;
 const steps=[],warnings=[];const startedAt=new Date().toISOString();
 const report=async(phase,message,current,total)=>{
  await chrome.storage.local.set({[WB_DAILY_AUDIT_STATE]:{status:'running',phase,message,current,total,startedAt,mall_id:context.mall_id,store_name:context.store_name}});
  await wbControlPost({...context,message,task_state:{status:'running',taskMode:'daily_audit',phase,message,progress:{current,total},startedAt}}).catch(()=>{});
 };
 try{
  const identity=await wbSellerIdentity(tab),mall=String(identity.current_mall_id||'');
  if(mall!==String(command.mall_id||''))throw new Error('当前浏览器店铺与每日巡检目标不一致');
  await report('traffic','正在读取实时与近1日流量',1,5);
  const flow=await wbAutoCall(tab.id,'FLOW',{dimensions:[0,1],mallId:mall,requestHeaders:{mallid:mall}});
  if(flow.items?.length!==2)throw new Error('实时与近1日流量未完整返回');
  await wbEnqueue({method:'POST',path:'/api/client/flow-overviews',body:{mall_id:mall,store_name:context.store_name,items:flow.items}});
  const realtime=flow.items.find(item=>Number(item.time_dimension)===0),oneDay=flow.items.find(item=>Number(item.time_dimension)===1);
  const traffic={status:'finished',realtime:wbAuditFlowSummary(realtime),one_day:wbAuditFlowSummary(oneDay),message:'实时数据已包含平台“较前1日”对比，近1日数据单独保存'};
  steps.push({id:'traffic',label:'流量分析',status:'finished',message:traffic.message});

  await report('orders','正在检查取消、物流异常与发货超过3天',2,5);
  const orderResult=await wbAutoCall(tab.id,'ORDER_AUDIT',{startDate:wbAuditDay(-30),endDate:wbAuditDay(0),thresholdHours:72,mallId:mall,requestHeaders:{mallid:mall}});
  if(orderResult.success!==true)throw new Error(orderResult.error||'订单巡检未完成');

  await report('pages','正在后台核对消费者咨询和订单页面徽标',3,5);
  let pageAudit={consultations:{status:'partial',has_unreplied:null,unreplied_count:null,message:'消费者咨询页面未完成自动核对'},orderPage:{status:'partial',message:'订单页面徽标未完成自动核对'}};
  try{pageAudit=await wbAuditBackgroundPages(tab)}catch(error){warnings.push(String(error?.message||error))}
  if(pageAudit.consultations.status!=='finished')warnings.push(pageAudit.consultations.message);

  await report('save','正在保存巡检结果',4,5);
  const pageOrders=pageAudit.orderPage||{},visibleCancelled=pageOrders.cancelled_visible_count,visibleExceptions=pageOrders.logistics_exception_visible_count,orders={
   status:pageOrders.status==='finished'?'finished':'partial',
   range:orderResult.range,
   cancelled_count:typeof visibleCancelled==='number'?visibleCancelled:Number(orderResult.cancelled_count||0),
   cancelled_recent_count:Number(orderResult.cancelled_count||0),
   cancelled_visible_count:visibleCancelled??null,
   cancelled_orders:orderResult.cancelled_orders||[],
   logistics_exception_count:typeof visibleExceptions==='number'?visibleExceptions:Number(orderResult.logistics_exception_count||0),
   logistics_exception_api_count:Number(orderResult.logistics_exception_count||0),
   logistics_exception_visible_count:visibleExceptions??null,
   logistics_exceptions:orderResult.logistics_exceptions||[],
   overdue_shipment_count:Math.max(Number(orderResult.overdue_shipment_count||0),Number(pageOrders.visible_overdue_count||0)),
   overdue_shipments:orderResult.overdue_shipments||[],coverage:orderResult.coverage,pool_totals:orderResult.pool_totals,
  };
  steps.push({id:'cancelled',label:'取消订单',status:'finished',message:`近30日检测到 ${orders.cancelled_count} 个已取消订单`});
  steps.push({id:'exceptions',label:'异常订单',status:'finished',message:`检测到 ${orders.logistics_exception_count} 个物流异常订单`});
  steps.push({id:'overdue',label:'发货超过3天',status:'finished',message:`检测到 ${orders.overdue_shipment_count} 个实际发货已满72小时的订单`});
  steps.push({id:'consultations',label:'客服中心提醒',status:pageAudit.consultations.has_attention?'action_required':pageAudit.consultations.status,message:pageAudit.consultations.message});
  const audit={date:wbAuditDay(),captured_at:new Date().toISOString(),status:warnings.length?'partial':'finished',traffic,consultations:pageAudit.consultations,orders,steps,warnings,source_urls:{traffic:new URL('/main/flux-analysis',tab.url).href,consultations:new URL('/chat-app/index',tab.url).href,customer_service:pageAudit.consultations.attention_url||new URL('/chat-app/index',tab.url).href,orders:new URL('/mmsos/orders.html',tab.url).href}};
  await wbEnqueue({method:'POST',path:'/api/client/daily-audits',body:{mall_id:mall,store_name:context.store_name,rows:[audit]}});
  const sync=await wbFlush();
  const finishedAt=new Date().toISOString(),message=warnings.length?'每日巡检已完成，部分页面需要人工复核':'每日必做巡检已全部完成';
  await chrome.storage.local.set({[WB_DAILY_AUDIT_STATE]:{status:audit.status,phase:'done',message,startedAt,finishedAt,mall_id:mall,store_name:context.store_name,warnings}});
  await wbControlPost({...context,message,task_state:{status:'finished',taskMode:'daily_audit',phase:'done',message,progress:{current:5,total:5},startedAt,endedAt:finishedAt,stats:{warnings:warnings.length,pending:Number(sync.pending||0)}}}).catch(()=>{});
  return {error:'',message,finishedAt,audit};
 }catch(error){
  const message=String(error?.message||error),endedAt=new Date().toISOString();
  await chrome.storage.local.set({[WB_DAILY_AUDIT_STATE]:{status:'failed',phase:'failed',message,startedAt,endedAt,mall_id:context.mall_id,store_name:context.store_name}});
  await wbControlPost({...context,message,task_state:{status:'failed',taskMode:'daily_audit',phase:'failed',message,startedAt,endedAt}}).catch(()=>{});
  return {error:message,message,finishedAt:endedAt};
 }finally{wbDailyAuditRunning=false}
}
globalThis.wbRunDailyAudit=wbRunDailyAudit;
