const assert=require('node:assert/strict'),{test}=require('node:test'),fs=require('node:fs'),vm=require('node:vm');
const panel=fs.readFileSync('browser_extension/sidepanel.js','utf8'),bridge=fs.readFileSync('browser_extension/page-bridge.js','utf8');
const runSource=panel.slice(panel.indexOf('function usableFlowItem('),panel.indexOf('async function runProducts('));
const finishSource=panel.slice(panel.indexOf('function finishSellerShop('),panel.indexOf('async function appendEtaSample('));
const labels={0:'实时',1:'近1日',4:'近7日',5:'近30日',2:'本周',3:'本月'};
const item=(dimension,value=10)=>({time_dimension:dimension,data:{result:{impressionCount:value},trend_response:{success:true}}});
function harness(options={}){
 const shop={mall_id:'123',name:'shop'},state={shopIndex:0,shops:[shop],taskMode:'seller',startedAt:Date.now(),phase:'flow',status:'running',stats:{},pendingFlow:options.pending};
 const requested=[],uploads=[],logs=[],snapshots=[];
 const context={state,Date,Number,Set,Error,flowDimensionLabel:d=>labels[d],sellerRequestHeaders:()=>({mallid:'123'}),databaseMallId:()=> '123',setActiveShop:async()=>{},log:text=>logs.push(text),save:async()=>snapshots.push(JSON.parse(JSON.stringify(state))),
  runGeneration:1,api:async(path,request)=>{if(path.endsWith('/plan'))return {dimensions:[0,1,4,5,2,3]};uploads.push(JSON.parse(JSON.stringify(request.body)));return {}},
  collect:async(_tab,command,payload)=>{
   if(command==='PREPARE_FLOW')return {success:true,waitedMs:0};
   const dimension=payload.dimensions[0];requested.push(dimension);
   if(options.fail===dimension){const error=Error('流量汇总全部为空');if(options.failCode)error.errorCode=options.failCode;throw error}
   if(options.empty?.includes(dimension)){const error=Error('该范围没有汇总数值');error.errorCode='FLOW_EMPTY_SUMMARY';throw error}
   return {success:true,items:[item(dimension,options.zero?0:10)]};
  }};
 vm.createContext(context);vm.runInContext(runSource+finishSource+';globalThis.run=runFlow;globalThis.finish=finishSellerShop;',context);
 return {state,shop,requested,uploads,logs,snapshots,run:()=>context.run(7,shop),finish:()=>context.finish(shop),context};
}
test('one empty historical range preserves other values, still collects month and advances to orders with a warning',async()=>{
 const h=harness({empty:[2]});await h.run();
 assert.deepEqual(h.requested,[0,1,4,5,2,3]);assert.equal(h.uploads.length,1);
 assert.deepEqual(h.uploads[0].items.map(row=>row.time_dimension),[0,1,4,5,3]);assert.equal(h.state.phase,'orders');
 assert.match(h.shop.status,/本周流量为空/);assert.match(h.state.message,/保留.*历史有效数据/);assert.equal(h.state.pendingFlow,undefined);
 h.finish();assert.equal(h.state.phase,'done');assert.match(h.shop.status,/本周流量为空/);assert.match(h.state.message,/本周流量为空/);
});
test('all empty ranges never upload or advance to orders',async()=>{
 const h=harness({empty:[0,1,4,5,2,3]});await assert.rejects(h.run(),/实时和近1日/);
 assert.equal(h.uploads.length,0);assert.equal(h.state.phase,'flow');assert.equal(h.state.pendingFlow.items.length,0);
 assert.deepEqual([...h.state.pendingFlow.emptyDimensions],[0,1,4,5,2,3]);
});
test('both recent ranges empty cannot upload even when long ranges are numeric',async()=>{
 const h=harness({empty:[0,1]});await assert.rejects(h.run(),/实时和近1日/);assert.equal(h.uploads.length,0);assert.equal(h.state.phase,'flow');
});
test('an explicit numeric zero in realtime is valid and empty ranges are neither uploaded nor padded',async()=>{
 const h=harness({zero:true,empty:[1,4,5,2,3]});await h.run();assert.equal(h.state.phase,'orders');
 assert.equal(h.uploads[0].items.length,1);assert.equal(h.uploads[0].items[0].data.result.impressionCount,0);
});
test('generic failures and unknown codes stop the loop and retain four pending good ranges',async()=>{
 for(const failCode of [undefined,'SOME_OTHER_ERROR']){
  const h=harness({fail:2,failCode});await assert.rejects(h.run(),/全部为空/);
  assert.deepEqual(h.requested,[0,1,4,5,2]);assert.equal(h.uploads.length,0);assert.equal(h.state.phase,'flow');
  assert.deepEqual(Array.from(h.state.pendingFlow.items,row=>row.time_dimension),[0,1,4,5]);
 }
});
test('resuming a pending four-range batch keeps its existing data and only reads missing ranges',async()=>{
 const pending={shopIndex:0,mallId:'123',plannedDimensions:[0,1,4,5,2,3],completedDimensions:[0,1,4,5],items:[0,1,4,5].map(d=>item(d,77))};
 const h=harness({pending,empty:[2]});await h.run();assert.deepEqual(h.requested,[2,3]);
 assert.equal(h.uploads[0].items.length,5);assert.ok(h.uploads[0].items.filter(row=>row.time_dimension!==3).every(row=>row.data.result.impressionCount===77));
});
test('legacy pending payloads also require usable recent data before an upload',async()=>{
 const h=harness({pending:{shopIndex:0,mallId:'123',items:[item(4,77)]},empty:[0,1,5,2,3]});
 await assert.rejects(h.run(),/实时和近1日/);assert.equal(h.uploads.length,0);assert.equal(h.state.pendingFlow.items[0].data.result.impressionCount,77);
});
test('page bridge classifies empty summary only after both native APIs succeeded',async()=>{
 const source=bridge.slice(bridge.indexOf('  async function flow('),bridge.indexOf('  function seconds('));
 for(const mode of ['empty','overview-failed','trend-failed','zero']){
  const context={Date,Number,document:{querySelectorAll:()=>[]},location:{origin:'https://agentseller-us.temu.com',pathname:'/main/flux-analysis'},sleep:async()=>{},progress(){},post:async url=>({success:!(mode==='overview-failed'&&url.endsWith('/overview'))&&!(mode==='trend-failed'&&url.endsWith('/trend')),result:mode==='zero'?{impressionCount:0}:{impressionCount:null}})};
  vm.createContext(context);vm.runInContext(source+';globalThis.flow=flow;',context);
  if(mode==='zero')assert.equal((await context.flow({dimensions:[0]})).items[0].data.result.impressionCount,0);
  else await assert.rejects(context.flow({dimensions:[2]}),error=>{assert.equal(error.errorCode,mode==='empty'?'FLOW_EMPTY_SUMMARY':undefined);return true});
 }
});
test('collector preserves the one empty-summary code and never promotes generic errors to it',async()=>{
 const helpers=panel.slice(panel.indexOf('function errorWithTechnicalInfo('),panel.indexOf('function logTechnicalError('));
 const source=panel.slice(panel.indexOf('async function collect('),panel.indexOf('async function sellerAuth('));
 for(const errorCode of ['FLOW_EMPTY_SUMMARY','UNKNOWN_ERROR',undefined]){
  let calls=0;const context={Error,runGeneration:1,paused:false,friendlyErrorMessage:error=>error.message,tabMessage:async()=>{calls++;return {success:false,error:'empty-looking text',errorCode,technicalInfo:'safe'}},setTimeout:fn=>fn()};
  vm.createContext(context);vm.runInContext(helpers+source+';globalThis.collect=collect;',context);
  await assert.rejects(context.collect(7,'FLOW',{},100,1,2),error=>{assert.equal(error.errorCode,errorCode==='FLOW_EMPTY_SUMMARY'?errorCode:undefined);assert.equal(error.technicalInfo,'safe');return true});
  assert.equal(calls,errorCode==='FLOW_EMPTY_SUMMARY'?1:2);
 }
});
test('page-to-content response keeps only the empty-summary code on failed FLOW commands',async()=>{
 const content=fs.readFileSync('browser_extension/content.js','utf8').split('if (!document.getElementById("temuCollectorRoot"))')[0];
 for(const code of ['FLOW_EMPTY_SUMMARY','UNKNOWN_ERROR']){
  let listener,resultListener;
  const context={crypto:{randomUUID:()=> 'request1'},setTimeout:()=>1,clearTimeout(){},
   window:{addEventListener:(_name,fn)=>resultListener=fn,removeEventListener(){},postMessage(){}},
   chrome:{runtime:{onMessage:{addListener:fn=>listener=fn},sendMessage:async()=>({headers:{},payload:null})}}};
  vm.createContext(context);vm.runInContext(content+';prepareCapturedRequest=async()=>({headers:{},payload:null});',context);
  const result=await new Promise(resolve=>{listener({type:'TEMU_COLLECT',command:'FLOW'},{},resolve);resultListener({source:context.window,data:{source:'temu-dashboard-page',id:'request1',result:{success:false,error:'empty-looking text',errorCode:code}}})});
  assert.equal(result.errorCode,code==='FLOW_EMPTY_SUMMARY'?code:undefined);
 }
});
test('page bridge serializes only the allowed code on FLOW failures',async()=>{
 const listenerSource=bridge.slice(bridge.lastIndexOf('  window.addEventListener("message", async (event)'),bridge.lastIndexOf('})();'));
 for(const command of ['FLOW','ORDERS'])for(const errorCode of ['FLOW_EMPTY_SUMMARY','UNKNOWN_ERROR']){
  let listener,response;const error=Error('failed');error.errorCode=errorCode;
  const context={handlers:{[command]:async()=>{throw error}},window:{addEventListener:(_name,fn)=>listener=fn,postMessage:value=>response=value}};
  vm.createContext(context);vm.runInContext(listenerSource,context);
  await listener({source:context.window,data:{source:'temu-dashboard-extension',id:'request1',command,payload:{}}});
  assert.equal(response.result.errorCode,command==='FLOW'&&errorCode==='FLOW_EMPTY_SUMMARY'?errorCode:undefined);
 }
});
test('completion dialog retains the flow warning with or without deferred order amounts',async()=>{
 const completionSource=panel.slice(panel.indexOf('async function recordCompletion(){'),panel.indexOf('async function run(){'));
 for(const deferredParents of [0,2]){
  const h=harness({empty:[2]});await h.run();h.state.stats.deferredParents=deferredParents;h.finish();
  const nodes=new Map();Object.assign(h.context,{history:[],HISTORY_KEY:'history',pendingLaunchContext:{},syncElapsedTimer(){},storageSet:async()=>{},showView(){},render(){},syncTaskToWorkbench(){},$:id=>{if(!nodes.has(id))nodes.set(id,{textContent:''});return nodes.get(id)}});
  vm.runInContext(completionSource+';globalThis.complete=recordCompletion;',h.context);await h.context.complete();
  assert.match(nodes.get('completeMessage').textContent,/本周流量为空/);assert.equal(nodes.get('completeMessage').textContent.includes('均已保存'),false);
 }
});
