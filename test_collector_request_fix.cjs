const assert=require('node:assert/strict');
const {test}=require('node:test');
const fs=require('node:fs'),vm=require('node:vm');
const auto=fs.readFileSync('./browser_extension/workbench-auto.js','utf8');
function harness(manual,options={}){
 const sent=[],run=[],listeners=[];
 let saved={enabled:true,scopes:{},...options.state};
 const chrome={storage:{local:{
  get:async key=>({[key]:key==='temuCollectorState.v2'?manual:saved}),
  set:async value=>{if(value['workbench.auto.v1'])saved=value['workbench.auto.v1']}
 }},runtime:{id:'extension1',getManifest:()=>({version:'0.19.1'}),onMessage:{addListener:fn=>listeners.push(fn)}}};
 const context={chrome,Date,URL,AbortSignal,
  wbSellerUrl:()=>true,wbProductHelper:()=>false,
  wbSellerIdentity:async()=>({current_mall_id:'123',store_name:'shop'}),
  wbBrowserIdentity:async()=>({client_id:'chromeclient1',browser:'Chrome'}),
  WORKBENCH_CONFIG:{api:'http://local',token:'test'},
  fetch:async(url,init)=>{const body=JSON.parse(init.body);sent.push(body);return {ok:true,json:async()=>({command:body.claim?{id:'command1',kind:options.kind||'product_status',mall_id:'123'}:null})}},
  wbStatus:async()=>({pending:0}),
  wbAcceleratorStatusTick:async(tab,force,mall,progress)=>{run.push({force,mall});await progress('正在采集加速器');return {acceleratorFinishedAt:Date.now(),acceleratorError:options.acceleratorError||'',error:'旧流量错误',message:'加速器结果'}},
   wbProductStatusTick:async(tab,force,mall,progress)=>{
   run.push({force,mall});
   await progress('正在采集报名记录');
   if(options.throwOnRun)throw Error('页面连接中断');
   return {finishedAt:Date.now(),message:'报名记录已同步'}
  }
 };
 context.wbBridgeFetch=(...args)=>context.fetch(...args);
 vm.createContext(context);vm.runInContext(auto+';globalThis.poll=wbControlPoll;',context);
 return {context,sent,run,read:()=>saved,tab:{id:1,url:'https://agentseller.temu.com/activity/marketing-activity/log'}};
}
test('stopped manual task permits claim and progress without resuming it',async()=>{
 const manual={status:'paused',endedAt:Date.now(),phase:'products'};
 const h=harness(manual);await h.context.poll(h.tab);
 assert.equal(h.sent[0].claim,true);assert.equal(h.run.length,1);
 assert.ok(h.sent.some(row=>row.progress_id==='command1'&&row.message.includes('报名记录')));
 assert.ok(h.sent.some(row=>row.finished_id==='command1'&&!row.error));
 assert.equal(manual.status,'paused');
});
test('active manual collector keeps command queued with visible blocking reason',async()=>{
 const h=harness({status:'running'});await h.context.poll(h.tab);
 assert.equal(h.sent[0].claim,false);assert.match(h.sent[0].blocked_reason,/手动采集/);
 assert.equal(h.run.length,0);
});
test('accelerator command dispatch has separate result and does not inherit flow errors',async()=>{
 const h=harness({status:'done'},{kind:'accelerator_status'});await h.context.poll(h.tab);
 assert.equal(h.run.length,1);assert.ok(h.sent.some(row=>row.progress_id==='command1'&&row.message.includes('加速器')));
 assert.ok(h.sent.some(row=>row.finished_id==='command1'&&!row.error));
 const failed=harness({status:'done'},{kind:'accelerator_status',acceleratorError:'未识别到下一页'});await failed.context.poll(failed.tab);
 assert.ok(failed.sent.some(row=>row.finished_id==='command1'&&row.error==='未识别到下一页'));
});
test('stale persisted lease cannot block an explicit accelerator refresh after worker restart',async()=>{
 const h=harness({status:'done'},{kind:'accelerator_status',state:{leaseUntil:Date.now()+25*60000}});
 await h.context.poll(h.tab);assert.equal(h.sent[0].claim,true);assert.equal(h.run.length,1);
});
test('unexpected claimed-command exception is reported as failed',async()=>{
 const h=harness({status:'paused',endedAt:Date.now()},{throwOnRun:true});
 await h.context.poll(h.tab);
 assert.ok(h.sent.some(row=>row.finished_id==='command1'&&row.error==='页面连接中断'));
 assert.equal(h.read().controlError,'页面连接中断');
});
