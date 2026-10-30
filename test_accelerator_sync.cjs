const assert=require('node:assert/strict'),{test}=require('node:test'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('./browser_extension/product-status-sync.js','utf8');
const STATE_RULE='flow_grow_badge_v1';
const row=(id,status='enabled')=>({spuId:String(id),siteName:'美国站',status,price:null,sourceUrl:'https://agentseller-us.temu.com/main/flux-analysis'});
function harness(options={}){
 let state={enabled:true,scopes:{},...options.state},changed=false,queries=0,targetReads=0;
 const ids=options.ids||Array.from({length:43},(_,i)=>String(100001+i));
 const tabs=new Map([[1,{id:1,url:'https://agentseller.temu.com/goods/list',status:'complete'}]]);
 const saved=[],created=[],closed=[],calls=[],progress=[];
 const context={URL,Date,AbortSignal,crypto:require('node:crypto').webcrypto,setTimeout:fn=>fn(),
  WORKBENCH_CONFIG:{api:'http://127.0.0.1:18769'},wbBridgeFetch:async url=>{
   targetReads++;assert.match(url,/accelerator-targets\?mall_id=123$/);
   return {ok:!options.targetError,json:async()=>options.targetError?{error:'缺少完整在售快照'}:{success:true,mallId:'123',complete:true,
    spuIds:ids,skcIdsBySpu:Object.fromEntries(ids.map(id=>[id,[String(Number(id)+100000)]])),catalogCaptured:'2026-10-28T08:23:00Z',targetHash:(options.changedCatalog&&targetReads>1?'b':'a').repeat(64),...options.targetReply}};
  },
  wbAutoRunning:false,wbSellerUrl:url=>/^https:\/\/agentseller(?:-us)?\.temu\.com\//.test(url),
  wbManualTaskBusy:task=>task?.status==='running',wbSellerIdentity:async()=>({current_mall_id:changed?'999':'123',store_name:'shop'}),
  wbAutoRead:async()=>structuredClone(state),wbAutoWrite:async patch=>{state={...state,...patch}},
  wbEnqueue:async value=>saved.push(value),wbFlush:async()=>({pending:options.pending||0}),
  wbAutoCall:async(id,command,payload)=>{
   calls.push({id,command,payload});
   if(command==='VERIFY_SELLER_SHOP')return {matches:!changed};
   assert.equal(command,'ACCELERATORS_QUERY','DOM-pagination commands must never be used');
   assert.deepEqual(Object.keys(payload.skcIdsBySpu),Array.from(payload.productIds));
   queries++;
   if(options.queryError&&queries===options.queryError)throw Error('原生查询失败');
   if(options.switchShop)changed=true;
   const rows=payload.productIds.filter(id=>id!==options.missing).map((id,index)=>row(id,options.unknown===id?'unknown':options.allDisabled||index%2?'disabled':'enabled'));
   if(options.extra)rows.push(row(999999));if(options.duplicate)rows.push(rows[0]);
   const activeCount=rows.filter(value=>value.status==='enabled').length;
   return {success:true,stateRule:STATE_RULE,sourceMallId:options.wrongMall?'999':'123',rows,complete:!options.incomplete,rawCount:activeCount,total:activeCount,pages:1,...options.queryReply};
  },
  chrome:{storage:{local:{get:async()=>({'temuCollectorState.v2':options.manual||{status:'done'}})}},
   tabs:{create:async value=>{const tab={...value,id:2,status:'complete'};tabs.set(2,tab);created.push(tab);return tab},
    get:async id=>tabs.get(id),sendMessage:async()=>({success:true,current_mall_id:'123'}),
    remove:async id=>{closed.push(id);tabs.delete(id)}}}
 };
 vm.createContext(context);vm.runInContext(source+';globalThis.tick=wbAcceleratorStatusTick;',context);
 return {run:(force=true,mall='123')=>context.tick(tabs.get(1),force,mall,message=>progress.push(message)),saved,created,closed,calls,context,read:()=>state,progress};
}
test('queries every on-sale SPU with a complete badge-rule result in bounded native batches',async()=>{
 const h=harness();await h.run();assert.equal(h.read().acceleratorError,'');
 assert.equal(h.created.length,1);assert.equal(h.created[0].active,false);assert.deepEqual(h.closed,[2]);
 const calls=h.calls.filter(c=>c.command==='ACCELERATORS_QUERY');
 assert.deepEqual(calls.map(c=>c.payload.productIds.length),[20,20,3]);
 assert.equal(new Set(calls.flatMap(c=>c.payload.productIds)).size,43);
 assert.equal(h.saved.length,3);assert.equal(h.read().acceleratorResult.targetCount,43);
 assert.equal(h.read().acceleratorResult.enabled+h.read().acceleratorResult.disabled,43);
 assert.ok(h.saved.every(item=>item.body.crawl_result.complete===false&&item.body.crawl_result.scan_id));
 assert.ok(h.saved.every(item=>item.body.crawl_result.target_count===43&&item.body.crawl_result.target_hash==='a'.repeat(64)));
 assert.ok(h.saved.every(item=>item.body.crawl_result.state_rule===STATE_RULE));
 assert.deepEqual(h.saved.map(item=>[item.body.crawl_result.raw_count,item.body.crawl_result.total]),[[10,10],[10,10],[2,2]]);
 assert.ok(h.read().acceleratorFinishedAt);assert.equal(h.context.wbAutoRunning,false);
});
test('missing or unknown rows violate the badge contract and cannot be fabricated or uploaded',async()=>{
 for(const options of [{missing:'100001'},{unknown:'100001'}]){
  const h=harness(options);await h.run();
  assert.equal(h.saved.length,0);assert.ok(h.read().acceleratorError);
  assert.equal(h.read().acceleratorFinishedAt,undefined);assert.deepEqual(h.closed,[2]);
  assert.equal(h.context.wbAutoRunning,false);
 }
});
test('missing or incompatible state-rule proof rejects even otherwise complete on/off rows',async()=>{
 for(const stateRule of [undefined,null,'','native_flow_catalog_query','flow_grow_badge_v2']){
  const h=harness({queryReply:{stateRule}});await h.run();
  assert.equal(h.saved.length,0);assert.ok(h.read().acceleratorError);
  assert.equal(h.read().acceleratorFinishedAt,undefined);assert.deepEqual(h.closed,[2]);
 }
});
test('a valid empty active set still supplies every target as explicitly disabled under the badge rule',async()=>{
 const h=harness({ids:['100001','100002','100003'],allDisabled:true});await h.run();
 assert.equal(h.read().acceleratorError,'');assert.equal(h.saved.length,1);
 assert.equal(h.saved[0].body.rows.length,3);assert.ok(h.saved[0].body.rows.every(row=>row.status==='disabled'));
 assert.equal(h.saved[0].body.crawl_result.raw_count,0);assert.equal(h.saved[0].body.crawl_result.total,0);
 assert.equal(h.read().acceleratorResult.enabled,0);assert.equal(h.read().acceleratorResult.disabled,3);
 assert.ok(h.read().acceleratorFinishedAt);
});
test('missing complete catalog prevents any seller query',async()=>{
 for(const options of [{targetError:true},{targetReply:{complete:false}},{targetReply:{mallId:'999'}},{targetReply:{skcIdsBySpu:{}}},{ids:['100001','100001']}]){
  const h=harness(options);await h.run();assert.equal(h.created.length,0);assert.equal(h.saved.length,0);assert.ok(h.read().acceleratorError);
 }
});
test('shop mismatch, changed shop, out-of-scope, duplicate, incomplete and wrong-site results cannot upload',async()=>{
 for(const options of [{wrongMall:true},{switchShop:true},{extra:true},{duplicate:true},{incomplete:true},{queryReply:{rows:[{...row(100001),siteName:'英国站'}]}}]){
  const h=harness(options);await h.run();assert.equal(h.saved.length,0);assert.ok(h.read().acceleratorError);assert.deepEqual(h.closed,[2]);
 }
});
test('inconsistent active totals or returned-row statistics cannot certify an entire batch as on/off',async()=>{
 for(const queryReply of [{total:21,rawCount:21},{total:9},{total:10.5,rawCount:10.5},{rawCount:9},{rawCount:0,total:0},{pages:2}]){
  const h=harness({queryReply});await h.run();
  assert.equal(h.saved.length,0);assert.ok(h.read().acceleratorError);assert.equal(h.read().acceleratorFinishedAt,undefined);
 }
});
test('later batch errors preserve prior observations and do not mark a complete scan',async()=>{
 const h=harness({queryError:2});await h.run();assert.equal(h.saved.length,1);assert.equal(h.saved[0].body.rows.length,20);
 assert.match(h.read().acceleratorError,/原生查询失败/);assert.equal(h.read().acceleratorFinishedAt,undefined);
});
test('a later incomplete badge result preserves earlier uploads without filling the missing product as disabled',async()=>{
 const h=harness({missing:'100021'});await h.run();
 assert.equal(h.saved.length,1);assert.equal(h.saved[0].body.rows.length,20);
 assert.equal(h.saved.flatMap(item=>item.body.rows).some(row=>row.spuId==='100021'),false);
 assert.ok(h.read().acceleratorError);assert.equal(h.read().acceleratorFinishedAt,undefined);
});
test('catalog changed while querying invalidates whole-catalog success without deleting observations',async()=>{
 const h=harness({changedCatalog:true});await h.run();assert.equal(h.saved.length,3);
 assert.match(h.read().acceleratorError,/在售清单已变化/);assert.equal(h.read().acceleratorFinishedAt,undefined);
});
test('pending upload cannot advance successful catalog scan time',async()=>{
 const h=harness({pending:1});await h.run();assert.equal(h.saved.length,1);assert.match(h.read().acceleratorError,/待补传/);assert.equal(h.read().acceleratorFinishedAt,undefined);
});
test('automatic cadence, pause and manual work are respected while explicit refresh bypasses cadence',async()=>{
 const key='accelerators-us-catalog:123';
 for(const options of [{state:{enabled:false}},{manual:{status:'running'}},{state:{scopes:{[key]:{updatedAt:Date.now()}}}}]){
  const h=harness(options);await h.run(false);assert.equal(h.created.length,0);
 }
 const h=harness({state:{enabled:false,scopes:{[key]:{updatedAt:Date.now()}}}});await h.run();assert.equal(h.saved.length,3);
 const failed=harness({wrongMall:true});await failed.run(false);assert.ok(failed.read().acceleratorRetryAt>=Date.now()+119*60000);
 await failed.run(false);assert.equal(failed.created.length,1);
});
test('valid empty on-sale catalog completes without opening a seller tab',async()=>{
 const h=harness({ids:[]});await h.run();assert.equal(h.created.length,0);assert.equal(h.saved.length,0);assert.equal(h.read().acceleratorResult.targetCount,0);assert.ok(h.read().acceleratorFinishedAt);
});
test('helper tabs and mismatched requested stores never start another scan',async()=>{
 const h=harness();await h.run(true,'999');assert.equal(h.created.length,0);
 assert.equal(vm.runInContext("wbProductHelper({url:'https://agentseller-us.temu.com/main/flux-analysis?wb_accelerator_status=own'})",h.context),true);
});
test('native evidence session is mandatory and can only paginate its own US helper',async()=>{
 const content=fs.readFileSync('./browser_extension/content.js','utf8');
 const isolated=content.slice(content.indexOf('let wbAcceleratorPageSession'),content.indexOf('chrome.runtime.onMessage.addListener'));
 const context={URL,location:new URL('https://agentseller-us.temu.com/main/flux-analysis?wb_accelerator_status=own'),
  capturedHeader:(value,name)=>value.headers[name],prepareCapturedRequest:async()=>({headers:{mallid:'123'}}),
  window:{TemuAcceleratorEvidence:{readPage:()=>({rows:[row(100001)]}),nextPage:()=>({success:true})}}};
 vm.createContext(context);vm.runInContext(isolated+';globalThis.command=acceleratorPageCommand;',context);
 const message={command:'ACCELERATORS_PAGE',payload:{mallId:'123',marker:'own'}};
 await assert.rejects(context.command(message),/原生请求/);
 assert.equal((await context.command({...message,payload:{...message.payload,requireNative:true}})).sourceMallId,'123');
 await assert.rejects(context.command({...message,payload:{...message.payload,mallId:'999'}}),/原生请求/);
 context.location=new URL('https://agentseller-us.temu.com/main/flux-analysis');
 await assert.rejects(context.command(message),/独立/);
});
