const assert=require('node:assert/strict');
const {test}=require('node:test');
const fs=require('node:fs'),vm=require('node:vm');
function harness(fetch){
 const context={fetch,URL,AbortSignal};
 vm.createContext(context);
 vm.runInContext(fs.readFileSync('browser_extension/workbench-config.js','utf8')+';globalThis.request=wbBridgeFetch;',context);
 return context.request;
}
const token='a'.repeat(43);
test('fresh installation pairs once for concurrent requests',async()=>{
 let paired=0,writes=0;
 const request=harness(async(url,init)=>{
  if(String(url).endsWith('/bootstrap')){paired++;return {ok:true,json:async()=>({service:'temu-workbench',token})};}
  assert.equal(init.headers.Authorization,'Bearer '+token);writes++;return {ok:true,status:200};
 });
 await Promise.all([request('/api/a'),request('/api/b')]);
 assert.equal(paired,1);assert.equal(writes,2);
});
test('a rejected old token re-pairs once and retains the write payload',async()=>{
 let paired=0,attempts=0;
 const request=harness(async(url,init)=>{
  if(String(url).endsWith('/bootstrap'))return {ok:true,json:async()=>({service:'temu-workbench',token:token+(++paired)})};
  attempts++;assert.equal(init.body,'{"x":1}');return {status:attempts===1?403:200};
 });
 const result=await request('/api/bridge/collector',{method:'POST',body:'{"x":1}'});
 assert.equal(result.status,200);assert.equal(attempts,2);assert.equal(paired,2);
});
test('external URLs are rejected before pairing or transmission',async()=>{
 let calls=0;const request=harness(async()=>{calls++;});
 await assert.rejects(request('https://example.com/api/collect'));
 assert.equal(calls,0);
});
test('invalid pairing response never transmits a payload',async()=>{
 let calls=0;const request=harness(async()=>{calls++;return {ok:true,json:async()=>({service:'wrong',token})};});
 await assert.rejects(request('/api/bridge/collector',{body:'private'}));
 assert.equal(calls,1);
});
test('connection failure is surfaced without repeated writes',async()=>{
 let calls=0;const request=harness(async()=>{calls++;throw Error('offline');});
 await assert.rejects(request('/api/bridge/collector'),/offline/);assert.equal(calls,1);
});
