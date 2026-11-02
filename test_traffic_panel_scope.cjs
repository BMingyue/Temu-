const assert=require('node:assert/strict');
const {test}=require('node:test');
const fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('./browser_extension/traffic-background.js','utf8');
const url='https://agentseller-us.temu.com/main/flux-analysis';
const local={id:'extension1',tab:{id:1,url:'http://127.0.0.1:5173/'}};

function harness(options={}){
 const listeners=[],effects=[],session={},store={};
 const existing=options.tabs??[{id:7,url,status:'complete'}];
 let finishVerification;
 const held=options.holdVerification?new Promise(resolve=>{finishVerification=resolve}):null;
 const chrome={runtime:{id:'extension1',getURL:()=> 'chrome-extension://extension1/',getManifest:()=>({version:'0.20.14'}),onMessage:{addListener:fn=>listeners.push(fn)}},
  storage:{session:{get:async key=>Object.fromEntries((Array.isArray(key)?key:[key]).map(k=>[k,session[k]])),set:async patch=>{effects.push(['session-set',patch]);Object.assign(session,patch)},remove:async key=>{effects.push(['session-remove',key]);delete session[key]}},
   local:{get:async key=>({[key]:store[key]}),set:async patch=>{effects.push(['local-set',patch]);Object.assign(store,patch)}}},
  cookies:{get:async()=>({value:options.cookieMall??'123'})},
  tabs:{query:async query=>query.active?[{id:1}]:existing,get:async id=>({id,url:options.currentUrl??url,status:'complete'}),
   update:async(id,patch)=>{effects.push(['tab-update',id,patch]);return {id,url,status:'complete'}},
   create:async patch=>{effects.push(['tab-create',patch]);return {id:9,url,status:'complete'}},
   onRemoved:{addListener(){}},onUpdated:{addListener(){}}},
  scripting:{executeScript:async value=>{effects.push(['script',value]);return []}}};
 const context={chrome,URL,Date,setTimeout,clearTimeout,
  wbSellerIdentity:async()=>({current_mall_id:options.mall??'123',store_name:'shop'}),
  wbAutoCall:async(id,command,payload)=>{effects.push(['verify',id,command,payload]);if(held)await held;return {success:true,matches:options.matches!==false}}};
 vm.createContext(context);vm.runInContext(source,context);
 const send=(message,sender=local)=>new Promise(resolve=>{const handled=listeners[0](message,sender,resolve);if(!handled)resolve(undefined)});
 return {effects,send,finishVerification:()=>finishVerification?.(),session};
}
const open=mall=>({type:'WORKBENCH_OPEN_TRAFFIC_ACCELERATOR',...(mall===undefined?{}:{expectedMallId:mall})});

test('workbench PING is read-only and does not open or inject any panel',async()=>{
 const h=harness();const result=await h.send({type:'WORKBENCH_PING'});
 assert.equal(result.ok,true);assert.equal(result.version,'0.20.14');
 assert.deepEqual(h.effects,[]);
});

test('workbench open requires an explicit valid shop before any action',async()=>{
 for(const mall of [undefined,'',123,'0','other','123\n']){
  const h=harness(),result=await h.send(open(mall));
  assert.equal(result.ok,false);assert.deepEqual(h.effects,[]);
 }
});

test('wrong shop and unverified DOM never activate or inject into an existing seller tab',async()=>{
 for(const options of [{mall:'999'},{matches:false}]){
  const h=harness(options),result=await h.send(open('123'));
  assert.equal(result.ok,false);
  assert.equal(h.effects.some(x=>['tab-update','tab-create','local-set','script'].includes(x[0])),false);
 }
});

test('wrong profile shop cannot create a new US tab',async()=>{
 const h=harness({tabs:[],cookieMall:'999'}),result=await h.send(open('123'));
 assert.equal(result.ok,false);assert.deepEqual(h.effects,[]);
});

test('verified workbench launch only shows the panel and returns its checked shop',async()=>{
 const h=harness(),result=await h.send(open('123'));
 assert.equal(result.ok,true);assert.equal(result.panelOnly,true);assert.equal(result.mallId,'123');
 assert.equal(h.effects.filter(x=>x[0]==='verify').length,1);
 assert.equal(h.effects.find(x=>x[0]==='verify')[2],'VERIFY_SELLER_SHOP');
 assert.equal(h.effects.filter(x=>x[0]==='script').length,2);
 assert.equal(h.effects.some(x=>x[0].startsWith('session-')),false);
 assert.deepEqual(Object.keys(h.session),[]);
});

test('a tab leaving the target flow page cannot receive panel scripts',async()=>{
 const h=harness({currentUrl:'https://agentseller-us.temu.com/login'}),result=await h.send(open('123'));
 assert.equal(result.ok,false);assert.equal(h.effects.some(x=>x[0]==='script'),false);
});

test('concurrent requests for another shop cannot share a pending open',async()=>{
 const h=harness({holdVerification:true});const first=h.send(open('123'));
 const other=await h.send(open('999'));assert.equal(other.ok,false);
 h.finishVerification();assert.equal((await first).ok,true);
 assert.equal(h.effects.filter(x=>x[0]==='script').length,2);
});

test('extension popup remains supported while unrelated origins cannot open panels',async()=>{
 const h=harness();const popup={id:'extension1',url:'chrome-extension://extension1/popup.html'};
 assert.equal((await h.send(open(),popup)).panelOnly,true);
 const blocked=harness();assert.equal(await blocked.send(open('123'),{id:'extension1',tab:{id:2,url:'https://example.com/'}}),undefined);
 assert.deepEqual(blocked.effects,[]);
});
