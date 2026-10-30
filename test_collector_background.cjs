const assert=require('node:assert/strict'),{test}=require('node:test');
const fs=require('node:fs'),vm=require('node:vm');
const sw=fs.readFileSync('./browser_extension/service-worker.js','utf8');
function captureHarness(){
 const listeners={};
 let now=1000;
 const chrome={
  runtime:{onInstalled:{addListener(){}},onMessage:{addListener(fn){listeners.message=fn}}},
  tabs:{onUpdated:{addListener(fn){listeners.update=fn}},onRemoved:{addListener(fn){listeners.remove=fn}}},
  webRequest:{onBeforeRequest:{addListener(fn){listeners.request=fn}},onBeforeSendHeaders:{addListener(fn){listeners.headers=fn}}}
 };
 const context={chrome,TextDecoder,Date:{now:()=>now},Map,Set};
 vm.runInNewContext(sw,context);
 const send=(tabId,senderTab=tabId)=>{let result;listeners.message({type:'GET_CAPTURED_HEADERS',tabId,kind:'products'},{tab:{id:senderTab}},value=>result=value);return result};
 const capture=(tabId,mall)=>listeners.headers({tabId,requestId:'req'+tabId,url:'https://agentseller.temu.com/visage-agent-seller/product/skc/pageQuery',requestHeaders:[{name:'mallid',value:mall}]});
 return {listeners,send,capture,advance:()=>now+=120001};
}
test('captured headers are tied to actual sender tab, expire, and clear on navigation',()=>{
 const h=captureHarness();h.capture(1,'123');h.capture(2,'999');
 assert.equal(h.send(1).headers.mallid,'123');assert.equal(h.send(2,1).headers.mallid,'123');
 h.listeners.update(1,{status:'loading'});assert.equal(h.send(1).headers.mallid,undefined);
 assert.equal(h.send(2).headers.mallid,'999');h.advance();assert.equal(h.send(2).headers.mallid,undefined);
 h.capture(2,'999');h.listeners.remove(2);assert.equal(h.send(2).headers.mallid,undefined);
});
const source=fs.readFileSync('./browser_extension/workbench-auto.js','utf8');
test('background alarm selects one ready seller tab and never selects helper pages',async()=>{
 const events=[],alarms=[];
 const chrome={
  runtime:{id:'extension',onInstalled:{addListener(){}},onStartup:{addListener(){}},onMessage:{addListener(){}}},
  alarms:{create:(...args)=>alarms.push(args),onAlarm:{addListener(){}}},
  tabs:{query:async()=>[
   {id:1,status:'complete',active:false,lastAccessed:2,url:'https://agentseller.temu.com/goods/list'},
   {id:2,status:'complete',active:true,url:'https://agentseller.temu.com/goods/list?wb_product_status=helper'},
   {id:3,status:'complete',active:true,url:'https://agentseller.temu.com/main/flux-analysis'}]}
 };
 const context={chrome,URL,Date,wbSellerUrl:url=>url.includes('agentseller.temu.com'),
  wbProductHelper:tab=>tab.url.includes('wb_product_status'),
  wbProductStatusTick:async tab=>events.push('products:'+tab.id),
   wbAcceleratorStatusTick:async tab=>events.push('accelerators:'+tab.id)};
 vm.createContext(context);
 vm.runInContext(source+";wbAutoRead=async()=>({});wbControlPoll=async tab=>events.push('control:'+tab.id);wbAutoTick=async tab=>events.push('flow:'+tab.id);globalThis.background=wbBackgroundCollect;",Object.assign(context,{events}));
 await context.background();
 assert.deepEqual(events,['control:3','products:3','control:3','accelerators:3','control:3','flow:3']);assert.equal(alarms[0][1].periodInMinutes,1);
});
test('flow calls preserve independently observed native request filters for each endpoint',async()=>{
 const bridge=fs.readFileSync('./browser_extension/page-bridge.js','utf8'),requests=[];
 let mode='valid';
 const context={Date,document:{querySelectorAll:()=>[]},location:{origin:'https://agentseller.temu.com',pathname:'/main/flux-analysis'},
  sleep:async()=>{},progress:()=>{},post:async(url,body)=>{requests.push({url,body});return {success:mode!=='bad-trend'||!url.endsWith('/trend'),result:mode==='empty'?{}:{impressionCount:0}}}};
 vm.createContext(context);
 vm.runInContext(bridge.slice(bridge.indexOf('  async function flow('),bridge.indexOf('  function seconds('))+';globalThis.flow=flow;',context);
 await context.flow({dimensions:[4],capturedPayload:{timeDimension:0,siteId:100},capturedTrendPayload:{timeDimension:0,channel:7}});
 assert.equal(requests[0].body.siteId,100);assert.equal(requests[0].body.timeDimension,4);
 assert.equal(requests[1].body.channel,7);assert.equal(requests[1].body.timeDimension,4);
 mode='empty';await assert.rejects(context.flow({dimensions:[0]}),/全部为空/);
 mode='bad-trend';await assert.rejects(context.flow({dimensions:[0]}),/趋势未完整/);
});
async function runFlow(options={}){
 let state={enabled:true,scopes:{}};
 const track=options.track||{created:[],closed:[]};
 const chrome={storage:{local:{get:async key=>({[key]:key==='temuCollectorState.v2'?{status:'done'}:state}),set:async patch=>state=patch['workbench.auto.v1']}},
  runtime:{onMessage:{addListener(){}}},
  tabs:{create:async value=>{const tab={id:2,...value};track.created.push(tab);return tab},
   get:async()=>track.created[0],remove:async id=>track.closed.push(id)}};
 const context={chrome,Date,URL,crypto:require('node:crypto').webcrypto,wbProductWait:async()=>{},wbSellerUrl:()=>true,wbSellerIdentity:async()=>({current_mall_id:'123'}),
  wbProductHelper:()=>false,wbProductGuard:async id=>id===1?{id:1,url:options.sourceUrl||'https://agentseller.temu.com/main/flux-analysis'}:track.created[0],wbEnqueue:async()=>{},wbFlush:async()=>({pending:options.pending||0})};
 vm.createContext(context);vm.runInContext(source+";wbAutoCall=async()=>({items:[{data:{result:"+(options.empty?"{}":"{impressionCount:0}")+",trend_response:{success:true}}}]});globalThis.tick=wbAutoTick;",context);
 await context.tick({id:1,url:options.sourceUrl||'https://agentseller.temu.com/main/flux-analysis'},true,'123');
 return state;
}
test('flow initiated elsewhere uses and closes one inactive helper on the same origin',async()=>{
 const track={created:[],closed:[]};
 const state=await runFlow({sourceUrl:'https://agentseller-us.temu.com/goods/list',track});
 assert.equal(state.error,'');assert.equal(track.created.length,1);assert.equal(track.created[0].active,false);
 assert.equal(new URL(track.created[0].url).origin,'https://agentseller-us.temu.com');
 assert.equal(new URL(track.created[0].url).pathname,'/main/flux-analysis');
 assert.deepEqual(track.closed,[2]);
});
test('flow all-empty response is not updated while explicit zero is usable',async()=>{
 const missing=await runFlow({empty:true});assert.match(missing.error,/全部为空/);assert.equal(missing.finishedAt,undefined);
 const zero=await runFlow();assert.equal(zero.error,'');assert.ok(zero.finishedAt);
});
test('flow outbox pending state cannot advance synchronized timestamp',async()=>{
 const state=await runFlow({pending:1});
 assert.match(state.error,/待补传/);assert.equal(Object.keys(state.scopes).length,0);assert.equal(state.finishedAt,undefined);
});
