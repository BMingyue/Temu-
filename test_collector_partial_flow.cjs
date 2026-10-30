const assert=require('node:assert/strict'),{test}=require('node:test');
const fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('./browser_extension/workbench-auto.js','utf8');
const scope='https://agentseller-us.temu.com:123';
function harness(options={}){
 let state={enabled:true,scopes:{[scope]:{day:'2000-01-01',marker:'preserved'}},...options.state};
 const tab={id:1,url:'https://agentseller-us.temu.com/main/flux-analysis',status:'complete'},requested=[],uploads=[];
 let flushes=0;
 const chrome={storage:{local:{get:async key=>({[key]:key==='temuCollectorState.v2'?{status:'done'}:state}),set:async patch=>{state=patch['workbench.auto.v1'];}}},
  runtime:{onMessage:{addListener(){}}},tabs:{query:async()=>[],sendMessage:async()=>options.response}};
 const context={chrome,Date,URL,setTimeout,clearTimeout,wbSellerUrl:()=>true,wbProductHelper:()=>false,
  wbSellerIdentity:async()=>({current_mall_id:'123',store_name:'shop'}),wbProductGuard:async()=>tab,
  wbEnqueue:async message=>uploads.push(message),wbFlush:async()=>{flushes++;return {pending:options.pending||0};}};
 vm.createContext(context);vm.runInContext(source+';globalThis.tick=wbAutoTick;globalThis.call=wbAutoCall;globalThis.today=wbAutoDay;',context);
 if(!options.realCall)context.wbAutoCall=async(id,command,payload)=>{
  const dimension=payload.dimensions[0];requested.push(dimension);
  const code=options.errors?.[dimension];
  if(code){const error=Error('synthetic '+code);error.errorCode=code;throw error;}
  return {items:[{time_dimension:dimension,data:{result:{impressionCount:0},trend_response:{success:true}}}]};
 };
 return {run:()=>context.tick(tab,false,'123'),context,read:()=>state,requested,uploads,flushes:()=>flushes};
}
test('week empty preserves earlier ranges, still collects month, and records partial scope without a complete day',async()=>{
 const h=harness({errors:{2:'FLOW_EMPTY_SUMMARY'}});await h.run();
 assert.deepEqual(h.requested,[0,1,4,5,2,3]);
 assert.deepEqual(h.uploads.map(upload=>upload.body.items[0].time_dimension),[0,1,4,5,3]);
 assert.equal(h.read().scopes[scope].day,'2000-01-01');assert(h.read().scopes[scope].updatedAt);
 assert.deepEqual(Array.from(h.read().scopes[scope].emptyDimensions),[2]);
 assert.match(h.read().message,/5\/6/);assert.match(h.read().error,/本周/);assert.equal(h.flushes(),1);
 const attempts=h.requested.length;await h.run();assert.equal(h.requested.length,attempts);
 h.read().scopes[scope].updatedAt=Date.now()-121*60000;
 await h.run();assert.deepEqual(h.requested.slice(attempts),[0,1,4,5,2,3]);
});
test('four usable ranges survive while both week and month are empty',async()=>{
 const h=harness({errors:{2:'FLOW_EMPTY_SUMMARY',3:'FLOW_EMPTY_SUMMARY'}});await h.run();
 assert.equal(h.uploads.length,4);assert.match(h.read().message,/4\/6/);
 assert.match(h.read().error,/本周、本月/);assert.equal(h.read().scopes[scope].day,'2000-01-01');
});
test('all empty ranges enqueue nothing and cannot advance success scope',async()=>{
 const errors=Object.fromEntries([0,1,4,5,2,3].map(dimension=>[dimension,'FLOW_EMPTY_SUMMARY']));
 const h=harness({errors});await h.run();assert.equal(h.requested.length,6);assert.equal(h.uploads.length,0);
 assert.equal(h.read().scopes[scope].updatedAt,undefined);assert.equal(h.read().finishedAt,undefined);
 assert.match(h.read().error,/实时与近1日均无有效汇总/);assert(h.read().retryAt>Date.now());
});
test('both core ranges empty keeps other valid data but does not claim the automatic scope succeeded',async()=>{
 const h=harness({errors:{0:'FLOW_EMPTY_SUMMARY',1:'FLOW_EMPTY_SUMMARY'}});await h.run();
 assert.deepEqual(h.uploads.map(upload=>upload.body.items[0].time_dimension),[4,5,2,3]);
 assert.equal(h.read().scopes[scope].updatedAt,undefined);assert.equal(h.read().finishedAt,undefined);
 assert.match(h.read().error,/实时与近1日均无有效汇总/);assert.equal(h.flushes(),1);
});
test('either core range alone is sufficient for a synchronized partial scope',async()=>{
 for(const emptyCore of [0,1]){
  const h=harness({errors:{[emptyCore]:'FLOW_EMPTY_SUMMARY'}});await h.run();
  assert.equal(h.uploads.length,5);assert(h.read().scopes[scope].updatedAt);assert(h.read().finishedAt);
  assert.match(h.read().message,/5\/6/);assert.equal(h.read().scopes[scope].day,'2000-01-01');
 }
});
test('authentication and unknown errors stop the remaining ranges',async()=>{
 for(const errorCode of ['LOGIN_EXPIRED','OTHER_ERROR']){
  const h=harness({errors:{4:errorCode}});await h.run();assert.deepEqual(h.requested,[0,1,4]);
  assert.equal(h.uploads.length,2);assert.equal(h.read().scopes[scope].updatedAt,undefined);
  assert.match(h.read().error,new RegExp(errorCode));
 }
});
test('partial data with pending outbox cannot advance the automatic scope',async()=>{
 const h=harness({errors:{2:'FLOW_EMPTY_SUMMARY'},pending:1});await h.run();
 assert.equal(h.uploads.length,5);assert.equal(h.read().scopes[scope].updatedAt,undefined);
 assert.equal(h.read().finishedAt,undefined);assert.match(h.read().error,/待补传/);
});
test('a partial refresh of a day already complete still requests all ranges after the interval',async()=>{
 const h=harness({errors:{2:'FLOW_EMPTY_SUMMARY'}});
 h.read().scopes[scope].day=h.context.today();h.read().scopes[scope].emptyDimensions=[2];
 await h.run();assert.equal(h.requested.length,6);
 assert.equal(h.read().scopes[scope].day,h.context.today());
 h.read().scopes[scope].updatedAt=Date.now()-121*60000;
 await h.run();assert.equal(h.requested.length,12);
});
test('wbAutoCall preserves only the exact empty-summary error code',async()=>{
 for(const code of ['FLOW_EMPTY_SUMMARY','UNKNOWN_PRIVATE_CODE']){
  const h=harness({realCall:true,response:{success:false,error:'native error',errorCode:code}});
  await assert.rejects(h.context.call(1,'FLOW',{}),error=>error.errorCode===(code==='FLOW_EMPTY_SUMMARY'?code:undefined));
 }
});
