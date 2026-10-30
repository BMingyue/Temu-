const assert=require('node:assert/strict'),{test}=require('node:test'),fs=require('node:fs'),vm=require('node:vm');
const background=fs.readFileSync('./browser_extension/traffic-background.js','utf8');
const sidepanel=fs.readFileSync('./browser_extension/sidepanel.js','utf8');
const start=sidepanel.slice(sidepanel.indexOf('async function startConfirmed(){'),sidepanel.indexOf('\nfunction requestExit()'));
const seller={id:'extension1',tab:{id:7,url:'https://agentseller.temu.com/goods/list'}};
function harness(options={}){
 const session={...options.session},local={},listeners=[];
 const read=async keys=>Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(key=>[key,session[key]]));
 const chrome={runtime:{id:'extension1',getURL:()=> 'chrome-extension://extension1/',onMessage:{addListener:fn=>listeners.push(fn)}},
  storage:{session:{get:read,set:async patch=>Object.assign(session,patch),remove:async key=>{delete session[key]}},
   local:{get:async key=>({[key]:local[key]}),set:async patch=>Object.assign(local,patch)}},
  tabs:{get:async id=>({id,url:'https://agentseller-us.temu.com/main/flux-analysis',status:'complete'}),onRemoved:{addListener(){}},onUpdated:{addListener(){}}}};
 const context={chrome,Date,URL};vm.createContext(context);vm.runInContext(background,context);
 function send(message,sender=seller){return new Promise(resolve=>{const handled=listeners[0](message,sender,resolve);if(!handled)resolve(undefined)})}
 return {send,session,local};
}
async function confirm(h){
 const nodes=new Map(),events=[];
 const $=id=>{if(!nodes.has(id))nodes.set(id,{textContent:'',disabled:false,classList:{add(){},remove(){}}});return nodes.get(id)};
 const context={$,Error,Date,pendingMode:'seller',forceFreshTask:false,currentLoginMatchesSavedTask:true,
  state:{taskMode:'seller',status:'idle',phase:'discover'},location:{hostname:'agentseller.temu.com'},SETTINGS_KEY:'settings',
  chrome:{storage:{session:{get:async()=>{throw Error('Access to storage is not allowed from this context.')}}}},
  runtime:h.send,settings:()=>({}),storageSet:async()=>events.push('settings'),save:async()=>events.push('save'),
  syncElapsedTimer(){},showView:view=>events.push(view),run:()=>events.push('run'),extensionUnavailable:error=>error,errorDisplayText:(prefix,error)=>prefix+error.message};
 vm.createContext(context);vm.runInContext(start+';globalThis.start=startConfirmed;',context);await context.start();
 return {events,state:context.state,nodes};
}
test('manual collection starts with content-script session storage protected',async()=>{
 const h=harness(),result=await confirm(h);
 assert.deepEqual(result.events,['settings','save','progressView','run']);
 assert.equal(result.state.status,'running');
 assert.equal((await h.send({type:'WORKBENCH_COLLECTOR_STATUS'})).ok,true);
 assert.equal(h.session.trafficLease,undefined);
});
test('active accelerator blocks manual startup before settings or task state are changed',async()=>{
 const h=harness({session:{trafficLease:{tabId:8,runId:'accelerator1'}}}),result=await confirm(h);
 assert.deepEqual(result.events,['confirmView']);assert.equal(result.state.status,'idle');
 assert.match(result.nodes.get('confirmMessage').textContent,/流量加速器正在运行/);
 assert.equal(result.nodes.get('confirmStart').disabled,false);
});
test('collector status is limited to this extension on seller or ads tabs and exposes no session data',async()=>{
 const h=harness({session:{trafficLease:{tabId:8,runId:'secret-run-id'}}});
 for(const sender of [{...seller,id:'other-extension'},{...seller,tab:{id:7,url:'https://example.com/'}},{id:seller.id,url:'https://agentseller.temu.com/'}]){
  assert.equal(await h.send({type:'WORKBENCH_COLLECTOR_STATUS'},sender),undefined);
 }
 const status=await h.send({type:'WORKBENCH_COLLECTOR_STATUS'});
 assert.deepEqual(Object.keys(status).sort(),['error','ok']);assert.equal(status.ok,false);
});
test('final collector reservation still blocks a conflicting accelerator and releases on commit',async()=>{
 const h=harness();
 assert.equal((await h.send({type:'WORKBENCH_COLLECTOR_STATUS'})).ok,true);
 assert.equal((await h.send({type:'WORKBENCH_COLLECTOR_RESERVE',runId:'manual-run-1'})).ok,true);
 const trafficSender={...seller,tab:{id:8,url:'https://agentseller-us.temu.com/main/flux-analysis'}};
 assert.equal((await h.send({trafficLock:'acquire',runId:'accelerator1'},trafficSender)).ok,false);
 assert.equal(h.session.trafficLease,undefined);
 await h.send({type:'WORKBENCH_COLLECTOR_COMMIT',runId:'manual-run-1'});
 assert.equal(h.session.trafficManualReservation,undefined);
 assert.equal((await h.send({trafficLock:'acquire',runId:'accelerator1'},trafficSender)).ok,true);
 assert.equal((await h.send({type:'WORKBENCH_COLLECTOR_RESERVE',runId:'manual-run-2'})).ok,false);
});
