const assert=require('node:assert/strict'),{test}=require('node:test'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('./browser_extension/workbench-auto.js','utf8');
function scheduler(polls=[],product=async()=>{}){
 const events=[];
 const context={Date,URL,chrome:{runtime:{onMessage:{addListener(){}}}},wbProductStatusTick:async()=>{events.push('products');await product()},wbAcceleratorStatusTick:async()=>events.push('accelerators')};
 vm.createContext(context);
 vm.runInContext(source+";wbAutoRead=async()=>({});wbAutoTick=async()=>events.push('flow');wbControlPoll=async()=>{events.push('poll');return polls.shift()||{}};globalThis.collect=wbScheduledCollect;",Object.assign(context,{events,polls}));
 return {events,context};
}
test('queued or just handled manual request prevents new automatic stages',async()=>{
 for(const state of [{pending:true},{handled:true}]){
  const h=scheduler([state]);await h.context.collect({id:1});assert.deepEqual(h.events,['poll']);
 }
});
test('manual request arriving during product collection runs before automatic accelerator or flow stage',async()=>{
 const h=scheduler([{}, {handled:true}]);await h.context.collect({id:1});
 assert.deepEqual(h.events,['poll','products','poll']);
});
test('page timers and alarm do not start overlapping automatic cycles',async()=>{
 let release;const waiting=new Promise(resolve=>release=resolve);
 const h=scheduler([],()=>waiting);
 const first=h.context.collect({id:1});await new Promise(resolve=>setImmediate(resolve));
 await h.context.collect({id:2});assert.deepEqual(h.events,['poll','products']);
 release();await first;assert.deepEqual(h.events,['poll','products','poll','accelerators','poll','flow']);
});
test('background message timeout is bounded even if a content response never settles',async()=>{
 let elapsed=0,cleared=false;
 const context={chrome:{runtime:{onMessage:{addListener(){}}},tabs:{sendMessage:()=>new Promise(()=>{})}},setTimeout:(fn,ms)=>{elapsed=ms;queueMicrotask(fn);return 1},clearTimeout:()=>cleared=true};
 vm.createContext(context);vm.runInContext(source+';globalThis.call=wbAutoCall;',context);
 await assert.rejects(context.call(1,'ACCELERATORS_PAGE'),/页面读取超时/);
 assert.equal(elapsed,185000);assert.equal(cleared,true);
});
test('flow automatic interval is two hours and explicit refresh bypasses the interval',async()=>{
 for(const minutes of [5,60,119,121]){
  let state={enabled:true,scopes:{'agentseller.temu.com:123':{updatedAt:Date.now()-minutes*60000}}};
  const context={Date,URL,chrome:{storage:{local:{get:async key=>({[key]:key==='temuCollectorState.v2'?{status:'done'}:state}),set:async patch=>state=patch['workbench.auto.v1']}},runtime:{onMessage:{addListener(){}}}},
   wbSellerUrl:()=>true,wbSellerIdentity:async()=>({current_mall_id:'123'}),wbProductGuard:async()=>({id:1,url:'https://agentseller.temu.com/main/flux-analysis'}),wbEnqueue:async()=>{},wbFlush:async()=>({pending:0})};
  vm.createContext(context);
  vm.runInContext(source+';globalThis.tick=wbAutoTick;',context);
  vm.runInContext("globalThis.calls=0;wbAutoCall=async()=>{calls++;return {items:[{data:{result:{impressionCount:0},trend_response:{success:true}}}]}}",context);
  const tab={id:1,url:'https://agentseller.temu.com/main/flux-analysis'};
  await context.tick(tab,false,'123');assert.equal(context.calls>0,minutes>=120);
  if(minutes<120){await context.tick(tab,true,'123');assert.ok(context.calls>0)}
 }
});
