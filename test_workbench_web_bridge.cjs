const assert=require('node:assert/strict');
const {test}=require('node:test');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync('./browser_extension/workbench-web-bridge.js','utf8');
const worker=fs.readFileSync('./browser_extension/service-worker.js','utf8');
const ORIGIN='http://127.0.0.1:5173';
const clone=value=>JSON.parse(JSON.stringify(value));
function harness(origin=ORIGIN){
  const listeners=new Set(),posted=[],calls=[],attributes=new Map();
  let sequence=0;
  const window={addEventListener:(type,fn)=>{if(type==='message')listeners.add(fn)},
    removeEventListener:(type,fn)=>{if(type==='message')listeners.delete(fn)},
    postMessage:(data,target)=>posted.push({data:clone(data),target})};
  const document={documentElement:{getAttribute:key=>attributes.get(key)||null,
    setAttribute:(key,value)=>attributes.set(key,value),removeAttribute:key=>attributes.delete(key)}};
  const context={window,document,location:{origin},crypto:{randomUUID:()=>`bridge-${++sequence}`},Date,Math,Promise,Set,URL,setTimeout,clearTimeout};
  vm.createContext(context);
  const runtime=(name='current')=>({id:'extension',valid:true,async sendMessage(message){
    calls.push({name,message:clone(message)});
    if(!this.valid)throw Error('Extension context invalidated.');
    return message.type==='WORKBENCH_PING'?{ok:true,version:'0.20.14',capabilities:['traffic-accelerator']}:{ok:true,panelOnly:true,mallId:message.expectedMallId};
  }});
  const load=async api=>{context.chrome={runtime:api};await vm.runInContext(source,context);};
  const request=async(data,overrides={})=>{
    const event={source:window,origin:ORIGIN,data:{source:'temu-workbench-web',id:'request-1',command:'WORKBENCH_PING',...data},...overrides};
    await Promise.all([...listeners].map(fn=>fn(event)));
  };
  return {window,listeners,posted,calls,attributes,context,runtime,load,request};
}

test('protocol 2 bridge announces readiness and only forwards PING or an explicitly scoped panel open',async()=>{
  const h=harness(),runtime=h.runtime();await h.load(runtime);
  const ready=h.posted[0].data;
  assert.equal(ready.event,'WORKBENCH_BRIDGE_READY');assert.equal(ready.bridgeProtocol,2);
  assert.equal(ready.bridgeVersion,'local_web_bridge_v2');assert.equal(h.calls.length,0);
  await h.request({});
  const ping=h.posted.at(-1).data.result;
  assert.equal(ping.ok,true);assert.equal(ping.bridgeInstance,ready.bridgeInstance);
  await h.request({command:'WORKBENCH_OPEN_TRAFFIC_ACCELERATOR',bridgeInstance:ready.bridgeInstance,mallId:' 123 ',
    scan:true,submit:true,trafficLock:'acquire',price:99});
  assert.deepEqual(h.calls.at(-1).message,{type:'WORKBENCH_OPEN_TRAFFIC_ACCELERATOR',expectedMallId:'123'});
  assert.equal(h.posted.at(-1).data.result.panelOnly,true);
  assert.ok(h.calls.every(call=>['WORKBENCH_PING','WORKBENCH_OPEN_TRAFFIC_ACCELERATOR'].includes(call.message.type)));
});
test('foreign frames, commands, invalid scopes and stale bridge instances cannot open a panel',async()=>{
  const h=harness();await h.load(h.runtime());const instance=h.posted[0].data.bridgeInstance;
  for(const [data,override] of [
    [{command:'WORKBENCH_OPEN_TRAFFIC_ACCELERATOR',bridgeInstance:instance,mallId:'123'},{source:{}}],
    [{command:'WORKBENCH_OPEN_TRAFFIC_ACCELERATOR',bridgeInstance:instance,mallId:'123'},{origin:'https://attacker.invalid'}],
    [{command:'SCAN_AND_SUBMIT'},{}], [{source:'other'},{}], [{id:'x'.repeat(101)},{}],
  ])await h.request(data,override);
  assert.equal(h.calls.length,0);
  for(const mallId of ['',undefined,'12x','1'.repeat(41),['123'],123]){
    await h.request({command:'WORKBENCH_OPEN_TRAFFIC_ACCELERATOR',bridgeInstance:instance,mallId});
    assert.equal(h.posted.at(-1).data.result.code,'INVALID_MALL_SCOPE');
  }
  await h.request({command:'WORKBENCH_OPEN_TRAFFIC_ACCELERATOR',bridgeInstance:'stale',mallId:'123'});
  assert.equal(h.posted.at(-1).data.result.code,'BRIDGE_GENERATION_CHANGED');
  assert.equal(h.calls.length,0);
  const foreign=harness('http://localhost:5173');await foreign.load(foreign.runtime());
  assert.equal(foreign.listeners.size,0);assert.equal(foreign.posted.length,0);
});
test('live duplicate injection preserves its instance while invalidated runtime is replaced without reload',async()=>{
  const h=harness(),old=h.runtime('old');await h.load(old);
  const first=h.window.__wbLocalWebBridge.instance;
  await h.load(old);assert.equal(h.window.__wbLocalWebBridge.instance,first);assert.equal(h.listeners.size,1);
  old.valid=false;await h.load(h.runtime('new'));
  assert.notEqual(h.window.__wbLocalWebBridge.instance,first);assert.equal(h.listeners.size,1);
  h.calls.length=0;await h.request({});
  assert.equal(h.calls.length,1);assert.equal(h.calls[0].name,'new');
  assert.equal(h.posted.at(-1).data.result.ok,true);
});
test('legacy boolean guard no longer blocks replacement and inaccessible older generation stays silent',async()=>{
  const h=harness();h.window.__wbLocalWebBridge=true;await h.load(h.runtime('first'));
  assert.equal(h.window.__wbLocalWebBridge.protocol,2);
  // A second isolated generation can retain a listener that cannot be removed.
  // The shared DOM generation attribute still prevents it handling any request.
  h.window.__wbLocalWebBridge=true;await h.load(h.runtime('second'));
  assert.equal(h.listeners.size,2);h.calls.length=0;h.posted.length=0;
  await h.request({});assert.equal(h.calls.length,1);assert.equal(h.calls[0].name,'second');
  assert.equal(h.posted.length,1);assert.equal(h.posted[0].data.result.bridgeProtocol,2);
});
test('context invalidation is a typed retryable result, never a business fallback',async()=>{
  const h=harness(),runtime=h.runtime();await h.load(runtime);runtime.valid=false;
  await h.request({});
  const result=h.posted.at(-1).data.result;
  assert.equal(result.code,'EXTENSION_CONTEXT_INVALIDATED');assert.equal(result.retryable,true);
  assert.equal(result.bridgeProtocol,2);assert.equal(h.calls.length,1);
});
test('superseded pending replies cannot race the replacement bridge and concurrent reinjection stays singular',async()=>{
  const h=harness(),old=h.runtime('old');let finish;
  old.sendMessage=async function(message){
    h.calls.push({name:'old',message:clone(message)});
    if(!this.valid)throw Error('Extension context invalidated.');
    return await new Promise(resolve=>finish=resolve);
  };
  await h.load(old);h.posted.length=0;
  const pending=h.request({});old.valid=false;
  const current=h.runtime('new');await Promise.all([h.load(current),h.load(current)]);
  assert.equal(h.listeners.size,1);
  finish({ok:false,error:'late orphan reply'});await pending;
  assert.ok(!h.posted.some(item=>item.data.id==='request-1'));
  await h.request({});assert.equal(h.posted.at(-1).data.result.ok,true);
  assert.equal(h.posted.at(-1).data.result.bridgeInstance,h.window.__wbLocalWebBridge.instance);
});
test('worker reconnect touches only exact localhost top frames and isolates injection failures',async()=>{
  const listeners={},queries=[],scripts=[],reloads=[];let tabs=[];
  const chrome={runtime:{onInstalled:{addListener:fn=>listeners.installed=fn},onStartup:{addListener:fn=>listeners.startup=fn},onMessage:{addListener(){}}},
    tabs:{query:async options=>{queries.push(clone(options));return tabs},reload:async id=>reloads.push(id),
      onUpdated:{addListener(){}},onRemoved:{addListener(){}}},
    scripting:{executeScript:async options=>{scripts.push(clone(options));if(options.target.tabId===2)throw Error('closed tab');}},
    webRequest:{onBeforeRequest:{addListener(){}},onBeforeSendHeaders:{addListener(){}}}};
  const context={chrome,URL,Map,Set,Promise,TextDecoder,Date};vm.createContext(context);
  vm.runInContext(worker+';globalThis.reconnect=wbReconnectLocalWebBridges;',context);
  await new Promise(resolve=>setImmediate(resolve));queries.length=0;
  tabs=[{id:1,url:ORIGIN+'/'},{id:2,url:ORIGIN+'/maintenance'},
    {id:3,url:'http://127.0.0.1:5174/'},{id:4,url:'https://127.0.0.1:5173/'},
    {id:5,url:'http://localhost:5173/'},{id:6,url:'https://agentseller-us.temu.com/main/flux-analysis'},
    {url:ORIGIN+'/'},{id:7,url:'http://127.0.0.1:5173.attacker.invalid/'}];
  assert.deepEqual(clone(await context.reconnect()),{attempted:2,connected:1});
  assert.deepEqual(queries,[{url:[ORIGIN+'/*']}]);
  assert.deepEqual(scripts,[{target:{tabId:1,frameIds:[0]},files:['workbench-web-bridge.js']},
    {target:{tabId:2,frameIds:[0]},files:['workbench-web-bridge.js']}]);
  assert.deepEqual(reloads,[]);scripts.length=0;tabs=[];
  listeners.startup();await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(reloads,[]);
});
