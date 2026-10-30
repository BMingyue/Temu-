const assert=require('node:assert/strict');
const {test}=require('node:test');
const fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('./browser_extension/content.js','utf8').split('chrome.runtime.onMessage.addListener')[0];
function prepare(options={}){
 let poll=0,clicks=0,queries=0;
 const button={innerText:options.label||'查 询',disabled:false,closest:()=>null,getClientRects:()=>[{}],click:()=>clicks++};
 const context={chrome:{runtime:{sendMessage:async()=>{poll++;return options.capture?options.capture(poll,clicks):{headers:{}}}}},
  document:{querySelectorAll:()=>{queries++;return queries>=(options.buttonAt||1)?[button]:[]}},
  setTimeout:fn=>{fn();return 1}};
 vm.createContext(context);vm.runInContext(source+';globalThis.prepare=prepareCapturedRequest;',context);
 return {run:kind=>context.prepare({tabId:7,payload:{mallId:'123'}},kind),stats:()=>({poll,clicks,queries})};
}
test('native matching request without anti-content is accepted without a search',async()=>{
 for(const kind of ['products','activities']){
  const h=prepare({capture:()=>({headers:{Mallid:'123'}})});
  assert.equal((await h.run(kind)).headers.Mallid,'123');assert.equal(h.stats().clicks,0);
 }
});
test('native request may arrive after USER_INFO while list UI is still absent',async()=>{
 const h=prepare({buttonAt:1000,capture:n=>n>=25?{headers:{mallid:'123'}}:{headers:{}}});
 assert.equal((await h.run('products')).headers.mallid,'123');assert.equal(h.stats().clicks,0);
});
test('late hydrated query or search is clicked once and preserves native mall evidence',async()=>{
 for(const label of ['查 询','搜索','Search']){
  const h=prepare({label,buttonAt:5,capture:(_n,clicks)=>({headers:clicks?{mallid:'123'}:{}})});
  await h.run('activities');assert.equal(h.stats().clicks,1);
 }
});
test('flow preparation requires same-shop native overview and trend payloads',async()=>{
 const context={setTimeout:fn=>fn(),chrome:{runtime:{sendMessage:async m=>({headers:{mallid:'123'},payload:m.kind==='flow'?{timeDimension:0,siteId:100}:{timeDimension:0,channel:7}})}}};
 vm.createContext(context);vm.runInContext(source+';globalThis.prepare=prepareCapturedRequest;',context);
 const captured=await context.prepare({tabId:1,payload:{mallId:'123'}},'flow');
 assert.equal(captured.payload.siteId,100);assert.equal(captured.trendPayload.channel,7);
 context.chrome.runtime.sendMessage=async m=>({headers:{mallid:m.kind==='flow'?'123':'999'},payload:{}});
 await assert.rejects(context.prepare({tabId:1,payload:{mallId:'123'}},'flow'),/当前店铺/);
});
test('missing controls wait for request instead of immediately failing, wrong mall is rejected',async()=>{
 const h=prepare({buttonAt:1000,capture:()=>({headers:{mallid:'999','anti-content':'example'}})});
 await assert.rejects(h.run('products'),/当前店铺匹配/);
 assert.equal(h.stats().poll,120);assert.equal(h.stats().clicks,0);
});
