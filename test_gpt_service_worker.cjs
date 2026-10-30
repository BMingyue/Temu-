const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync('gpt_chrome_extension/service-worker.js','utf8');

function harness(watchdog,tabs={},saved={},configuredWorker){
 const created=[],reloaded=[],updated=[],requests=[],messageListeners=[];
 const store={...saved};
 const listeners={addListener(){},removeListener(){}};
 const storage={
  async get(keys){
   const list=Array.isArray(keys)?keys:[keys],result={};
   for(const key of list)if(Object.prototype.hasOwnProperty.call(store,key))result[key]=store[key];
   return result;
  },
  async set(value){Object.assign(store,value)},
  async remove(key){delete store[key]},
 };
 let nextId=100;
 const chrome={
  storage:{local:storage},
  runtime:{onMessage:{addListener(fn){messageListeners.push(fn)}},getManifest:()=>({version:'0.4.3'}),onInstalled:listeners,onStartup:listeners},
  downloads:{onCreated:listeners,onChanged:listeners,async search(){return[]},async download(){return 1}},
  alarms:{create(){},onAlarm:listeners},
  tabs:{
   async get(id){if(!tabs[id])throw Error('missing tab');return tabs[id]},
   async create(options){const tab={id:nextId++,...options};tabs[tab.id]=tab;created.push(tab);return tab},
   async reload(id){reloaded.push(id)},
   async update(id,options){Object.assign(tabs[id],options);updated.push({id,...options});return tabs[id]},
   async query(){return[]},
   async sendMessage(){},
  },
 };
 const context={
  console,URL,AbortController,setTimeout,clearTimeout,Date,Promise,
  navigator:{userAgent:'Edg/140'},crypto:{randomUUID:()=> 'edge-worker'},
  WORKBENCH_WORKER_ID:configuredWorker,
  chrome,importScripts(){},
  createWorkbenchPairing:()=>({getToken:async()=> 'token'}),
  async fetch(url,options){
   requests.push({url,options});
   const value=url.endsWith('/watchdog')?watchdog:{ok:true};
   return {ok:true,status:200,json:async()=>value};
  },
 };
 context.globalThis=context;
 vm.createContext(context);vm.runInContext(source,context);
 return {context,created,reloaded,updated,requests,store,
  dispatch:(message,tab)=>new Promise(resolve=>messageListeners[0](message,{tab},resolve))};
}

(async()=>{
 const chat='https://chatgpt.com/c/formal-chat';
 {
  const h=harness({}, {}, {}, 'managed-worker');
  await h.context.watchQueue();
  assert.equal(h.store.workerId,'managed-worker');
  assert.equal(JSON.parse(h.requests[0].options.body).worker_id,'managed-worker');
  const existing=harness({}, {}, {workerId:'original-worker'}, 'managed-worker');
  await existing.context.watchQueue();
  assert.equal(existing.store.workerId,'original-worker','Retain existing worker ownership on update');
 }
 {
  const h=harness({}, {7:{id:7,url:chat}});
  assert.equal((await h.dispatch({type:'protect-runner',activate:true},{id:7,url:chat})).ok,true);
  assert.deepEqual(h.updated,[{id:7,autoDiscardable:false,active:true}]);
  assert.equal(h.created.length,0);assert.equal(h.reloaded.length,0);
  assert.equal((await h.dispatch({type:'protect-runner',activate:true},{id:9,url:'https://example.test/'})).ok,false);
  assert.equal(h.updated.length,1,'Cannot activate unrelated pages');
 }
 {
  const h=harness({pending:true,page_alive:true,recovery_action:{type:'resume',job_id:'job-1',chat_url:chat,session:'edge-worker:tab-7'}},{7:{id:7,url:chat}});
  await h.context.watchQueue();
  assert.deepEqual(h.reloaded,[7]);
  assert.equal(h.created.length,0);
  assert.equal(h.requests.filter(item=>item.url.endsWith('/update')).length,0);
 }
 {
  const h=harness({pending:true,page_alive:true,recovery_action:{type:'resume',job_id:'job-2',chat_url:chat,session:'edge-worker:tab-7'}},{9:{id:9,url:'https://chatgpt.com/'}},{recoveryTab:9});
  await h.context.watchQueue();
  assert.equal(h.reloaded.length,0);
  assert.equal(h.created.length,0);
  assert.deepEqual(h.updated,[{id:9,url:chat,active:false}]);
 }
 {
  const h=harness({pending:true,page_alive:false,recovery_action:null},{9:{id:9,url:chat}},{recoveryTab:9});
  await h.context.watchQueue();
  assert.equal(h.reloaded.length,0);
  assert.equal(h.created.length,0);
  assert.deepEqual(h.updated,[{id:9,url:'https://chatgpt.com/',active:false}]);
 }
 console.log('GPT service-worker recovery checks passed.');
})().catch(error=>{console.error(error);process.exitCode=1});
