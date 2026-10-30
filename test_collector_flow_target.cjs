const assert=require('node:assert/strict'),{test}=require('node:test');
const fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('./browser_extension/workbench-auto.js','utf8');
const CN='https://agentseller.temu.com',US='https://agentseller-us.temu.com',mall='123';
function harness(options={}){
 const cn={id:1,url:CN+'/goods/list',status:'complete',active:true},us={id:2,url:US+'/main/flux-analysis',status:'complete',active:false};
 const tabs=new Map([[1,cn],[2,us]]),identities={1:mall,2:options.usMall||mall};
 const calls=[],uploads=[],created=[],guards=[];
 let state={enabled:true,scopes:{},...options.state};
 const chrome={storage:{local:{get:async key=>({[key]:key==='temuCollectorState.v2'?options.manual||{status:'done'}:state}),set:async value=>{state=value['workbench.auto.v1'];}}},
  runtime:{onMessage:{addListener(){}}},
  tabs:{query:async()=>options.noUs?[]:[us],get:async id=>tabs.get(id),
   create:async value=>{const tab={id:3,status:'complete',...value};tabs.set(3,tab);identities[3]=mall;created.push(tab);return tab;},remove:async()=>{}}};
 const context={chrome,Date,URL,crypto:require('node:crypto').webcrypto,
  wbSellerUrl:url=>/^https:\/\/agentseller(?:-us)?\.temu\.com\//.test(url),
  wbProductHelper:tab=>new URL(tab.url).searchParams.has('wb_auto_flow'),
  wbSellerIdentity:async tab=>({current_mall_id:identities[tab.id],store_name:'shop'}),
  wbProductGuard:async(id,expected)=>{guards.push(id);if(identities[id]!==expected||options.guardRejectUs&&id===2)throw Error('目标店铺已切换');return tabs.get(id);},
  wbProductWait:async()=>{},wbEnqueue:async upload=>uploads.push(upload),wbFlush:async()=>({pending:0})};
 vm.createContext(context);vm.runInContext(source+';globalThis.tick=wbAutoTick;',context);
 context.wbAutoCall=async(id,command)=>{calls.push({id,command});if(options.onFlow)options.onFlow({identities,tabs});if(options.fail)throw Error('synthetic flow failure');return {items:[{data:{result:{impressionCount:1},trend_response:{success:true}}}]};};
 return {run:()=>context.tick(cn,options.force===true,mall),read:()=>state,calls,uploads,created,guards};
}
test('automatic flow prefers existing independently confirmed same-mall US page',async()=>{
 const h=harness();await h.run();assert.equal(h.created.length,0);assert.equal(h.calls.length,6);
 assert(h.calls.every(call=>call.id===2));assert(h.guards.filter(id=>id===2).length>=14);
 assert(h.guards.filter(id=>id===1).length>=12);
 assert(h.read().scopes[US+':'+mall].updatedAt);assert.equal(h.read().scopes[CN+':'+mall],undefined);
});
test('US page for a different mall is not used or navigated',async()=>{
 const h=harness({usMall:'999'});await h.run();assert.equal(h.created.length,1);
 assert.equal(new URL(h.created[0].url).origin,CN);assert(h.calls.every(call=>call.id===3));
 assert.equal(h.guards.includes(2),false);assert(h.read().scopes[CN+':'+mall].updatedAt);
});
test('US candidate with matching identity but failed independent guard is not selected',async()=>{
 const h=harness({guardRejectUs:true});await h.run();assert.equal(h.created.length,1);
 assert(h.calls.every(call=>call.id===3));assert(h.guards.includes(2));
});
test('legacy unscoped retry and CN retry cannot block confirmed US flow',async()=>{
 for(const retryScope of [undefined,CN+':'+mall]){
  const h=harness({state:{retryAt:Date.now()+120000,retryScope}});await h.run();
  assert(h.calls.length>0);assert.equal(h.read().retryScope,US+':'+mall);assert.equal(h.read().retryAt,0);
 }
});
test('retry for the actual US flow scope remains effective',async()=>{
 const h=harness({state:{retryAt:Date.now()+120000,retryScope:US+':'+mall}});await h.run();
 assert.equal(h.calls.length,0);assert.equal(h.created.length,0);assert.equal(h.uploads.length,0);
});
test('failure records the selected target scope and cannot suppress another origin',async()=>{
 const h=harness({fail:true,state:{retryScope:CN+':'+mall}});await h.run();
 assert.equal(h.read().retryScope,US+':'+mall);assert.match(h.read().error,/synthetic/);assert.equal(h.uploads.length,0);
 const cn=harness({noUs:true,fail:true,state:{retryScope:US+':'+mall}});await cn.run();
 assert.equal(cn.read().retryScope,CN+':'+mall);assert.equal(cn.uploads.length,0);
});
test('source switching during a US flow request prevents saving the result',async()=>{
 const h=harness({onFlow:({identities})=>{identities[1]='999';}});await h.run();
 assert.equal(h.uploads.length,0);assert.match(h.read().error,/店铺发生变化/);
});
test('US target switching during a flow request prevents saving the result',async()=>{
 const h=harness({onFlow:({identities})=>{identities[2]='999';}});await h.run();
 assert.equal(h.uploads.length,0);assert.match(h.read().error,/目标店铺已切换/);
});
test('US target navigation to a different origin or path rejects same-mall results',async()=>{
 for(const url of [CN+'/main/flux-analysis',US+'/goods/list']){
  const h=harness({onFlow:({tabs})=>{tabs.get(2).url=url;}});await h.run();
  assert.equal(h.uploads.length,0);assert.match(h.read().error,/流量采集页面已变化/);
  assert.equal(h.read().retryScope,US+':'+mall);
 }
});
test('disabled automatic updates and busy manual tasks cannot start flow selection or collection',async()=>{
 for(const options of [{state:{enabled:false}},{manual:{status:'running'}}]){
  const h=harness(options);await h.run();assert.equal(h.guards.length,0);assert.equal(h.calls.length,0);assert.equal(h.created.length,0);
 }
});
