// Original runner functions with all DOM/runtime/storage effects isolated mocks.
// No browser is launched and no real apply or business request is performed.
const assert=require('node:assert/strict');
const {test}=require('node:test');
const fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('./browser_extension/traffic/runner.js','utf8');
function extract(from,to){const start=source.indexOf(from),end=source.indexOf(to,start);assert(start>=0&&end>start);return source.slice(start,end)}
const processSource=extract('  async function processProduct(product) {','\n  async function run(mode)');
const runSource=extract('  async function run(mode) {','\n  async function pendingNotice()');
const product={id:'1001',goodsId:'2001',key:'2001',title:'isolated fixture',category:'fixture',tags:[],opportunity:true};
function processHarness(kind){
 const storage={},events=[],records=[];let priceOpen=true,successes=0,cleanup=0,attempts=0,delivered=0;
 const modal={kind:'price'},drawer={kind:'drawer'},confirmation={kind:'confirmation'};
 const state={committed:false,stop:false,step:'',lastError:null};
 const plan=[{spec:'fixture-S',target:100,price:'1.00',input:{}}];
 const D={refreshIdentities:async()=>{},products:()=>[product],drawer:()=>drawer,priceDialog:()=>priceOpen?modal:null,
  confirmation:()=>confirmation,verifyIdentity(){},select14(){},is14Selected:()=>true,getMore:()=>({kind:'get-more'}),
  control:(scope,labels)=>({kind:scope===confirmation?'final':scope===modal?'price-confirm':'other',labels}),
  readPriceRows:()=>[],setValue(){},verifyValues(){},verifyStagedPrices(){},
  outcomeTracker:()=>({arm(){events.push('tracker-armed')},read:()=>undefined,close(){events.push('tracker-closed')}}),
  click(){attempts++;assert.ok(storage.trafficPending,'pending must be persisted before final dispatch');assert.equal(state.committed,true);events.push('final-click');
    if(kind==='vanished')throw Error('目标控件已消失或不可用');delivered++;}};
 const chrome={storage:{local:{set:async patch=>{events.push('pending-written');Object.assign(storage,JSON.parse(JSON.stringify(patch)))},
  remove:async key=>{events.push('pending-removed');delete storage[key]}}}};
 const context={state,chrome,D,R:{matchProduct:()=>({ok:true}),pricePlan:()=>plan,spec:x=>x,money:()=> '1.00'},
  runId:'isolated-run',activeConfig:{timeoutMs:500,resultTimeoutMs:500},setStatus(){},gate:async()=>{},settle:async()=>{},
  act:async element=>{if(element.kind==='price-confirm')priceOpen=false},
  waitFor:async(fn,description,options={})=>{if(options.observeOnly)throw Error('isolated outcome timeout');const value=fn();assert.ok(value,description);return value},
  record:async(item,result,reason)=>{records.push({result,reason})},rememberSuccess:async()=>{successes++},
  cleanup:async()=>{cleanup++},log(){},Date,Math,Object};
 vm.createContext(context);vm.runInContext(processSource+';globalThis.execute=processProduct;',context);
 return {execute:()=>context.execute(product),storage,events,records,state,get stats(){return {successes,cleanup,attempts,delivered}}};
}
test('vanished final confirmation preserves durable pending and does not turn uncertainty into a normal failed item',async()=>{
 const h=processHarness('vanished');await assert.rejects(h.execute(),/目标控件已消失或不可用/);
 assert.equal(h.storage.trafficPending.key,product.key);assert.equal(h.storage.trafficPending.runId,'isolated-run');
 assert.ok(h.events.indexOf('pending-written')<h.events.indexOf('final-click'));
 assert.equal(h.state.committed,true);assert.equal(h.stats.attempts,1);assert.equal(h.stats.delivered,0);
 assert.equal(h.stats.successes,0);assert.equal(h.stats.cleanup,0);assert.deepEqual(h.records,[]);
 assert.equal(h.events.includes('pending-removed'),false);
});
test('unconfirmed result after dispatch records unknown once, retains pending and terminates without replay',async()=>{
 const h=processHarness('unknown');await assert.rejects(h.execute(),error=>error.unknown===true);
 assert.equal(h.storage.trafficPending.key,product.key);assert.equal(h.stats.attempts,1);assert.equal(h.stats.delivered,1);
 assert.equal(h.stats.successes,0);assert.equal(h.stats.cleanup,0);assert.deepEqual(h.records.map(record=>record.result),['unknown']);
 assert.equal(h.events.includes('pending-removed'),false);
});
test('a new start with existing pending cannot scan, process, clear dedupe or replay submission',async()=>{
 const pending={id:'1001',goodsId:'2001',key:'2001',runId:'previous-run',time:new Date().toISOString()};
 const storage={trafficPending:pending,trafficConfirmedSuccess:[{key:'protected',expiresAt:'2099-01-01T00:00:00.000Z'}]};
 const state={ready:true,running:false,starting:false},effects=[],elements=new Map();
 const $=id=>{if(!elements.has(id))elements.set(id,{textContent:'',classList:{add(){},remove(){}}});return elements.get(id)};
 let scans=0,processes=0;
 const context={state,$,host:{dataset:{}},D:{priceDialog:()=>null,confirmation:()=>null,drawer:()=>null},
  readConfig:()=>({}),crypto:{randomUUID:()=> 'new-attempt'},runId:null,activeConfig:null,heartbeat:null,
  chrome:{runtime:{sendMessage:async message=>{effects.push(message);return {ok:true}}},storage:{local:{
    get:async()=>storage,set:async()=>{throw Error('pending guard must run before any storage write')},remove:async()=>{throw Error('must not clear pending')}}}},
  TrafficScanOnly:{run:async()=>{scans++}},processProduct:async()=>{processes++},pendingNotice:async()=>{},
  setStatus(){},log(){},persist:async()=>{},clearInterval(){},Date,Math};
 vm.createContext(context);vm.runInContext(runSource+';globalThis.execute=run;',context);
 await context.execute('apply');
 assert.match($('errors').textContent,/结果未确认/);assert.equal(scans,0);assert.equal(processes,0);
 assert.equal(storage.trafficPending,pending);assert.equal(storage.trafficConfirmedSuccess.length,1);
 assert.deepEqual(effects.map(message=>message.trafficLock),['acquire','release']);
 assert.equal(state.starting,false);assert.equal(state.running,false);
});
