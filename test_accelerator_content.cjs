const assert=require('node:assert/strict'),{test}=require('node:test'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('browser_extension/content.js','utf8');
const code=source.slice(source.indexOf('async function prepareCapturedRequest'),source.indexOf('let wbAcceleratorPageSession'));
function harness(patch={}){
 const calls=[],context={URL,location:new URL(patch.url||'https://agentseller-us.temu.com/main/flux-analysis?wb_accelerator_status=own'),
  wait:async()=>{},capturedHeader:(value,name)=>String(value.headers?.[name]||''),triggerProductSearch:()=>false,
  chrome:{runtime:{sendMessage:async message=>{calls.push(message);return {headers:{mallid:'123'},requestMethod:'POST',requestPath:'https://agentseller-us.temu.com/api/flow/analysis/list',...patch.capture}}}}};
 vm.createContext(context);vm.runInContext(code+';globalThis.prepare=prepareCapturedRequest;',context);
 return {calls,context,run:payload=>context.prepare({command:'ACCELERATORS_QUERY',tabId:7,payload:{mallId:'123',marker:'own',...payload}},'accelerators')};
}
test('catalog query requires native list headers from its own US helper',async()=>{
 const h=harness();await h.run();assert.equal(h.calls.length,1);assert.equal(h.calls[0].kind,'flow_list');
});
test('wrong route, method, shop or unowned page never grants native list evidence',async()=>{
 for(const patch of [{capture:{requestPath:'https://agentseller-us.temu.com/api/flow/analysis/overview'}},{capture:{requestMethod:'GET'}},{capture:{headers:{mallid:'999'}}},{url:'https://agentseller-us.temu.com/main/flux-analysis'},{url:'https://agentseller.temu.com/main/flux-analysis?wb_accelerator_status=own'}]){
  await assert.rejects(harness(patch).run());
 }
 await assert.rejects(harness().run({marker:'other'}));
});
test('new MAIN query module loads before the request bridge',()=>{
 const manifest=JSON.parse(fs.readFileSync('browser_extension/manifest.json'));
 const main=manifest.content_scripts.find(item=>item.world==='MAIN');
 assert.ok(main.js.indexOf('accelerator-query.js')>=0);assert.ok(main.js.indexOf('accelerator-query.js')<main.js.indexOf('page-bridge.js'));
 assert.match(source,/ACCELERATORS_QUERY:"accelerators"/);
 const bridge=fs.readFileSync('browser_extension/page-bridge.js','utf8');assert.match(bridge,/ACCELERATORS_QUERY:payload/);
});

test('ordinary flow pages cannot passively overwrite native catalog status after refresh',()=>{
 const evidence=fs.readFileSync('browser_extension/product-state-evidence.js','utf8');
 const context={window:{}};vm.createContext(context);vm.runInContext(evidence,context);
 assert.equal(context.window.__workbenchProductStateEvidence,true);
 assert.equal(typeof context.window.TemuAcceleratorEvidence.readPage,'function');
 // No document, MutationObserver, timers or chrome messaging are exposed in
 // this scope: passive side effects would fail during script initialization.
});
