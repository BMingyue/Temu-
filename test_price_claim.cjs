const vm=require('node:vm'),fs=require('node:fs'),assert=require('node:assert/strict');
const listeners=[],storage={};
const context={console,URL,chrome:{runtime:{id:'test',onMessage:{addListener:f=>listeners.push(f)}},storage:{local:{get:async key=>({[key]:storage[key]}),set:async value=>Object.assign(storage,value)}}}};
vm.runInNewContext(fs.readFileSync('browser_extension/workbench-sync.js','utf8'),context);
const send=(message,url='https://agentseller.temu.com/newon/product-select')=>new Promise(resolve=>{
 for(const fn of listeners)if(fn(message,{id:'test',tab:{url}},resolve))return;
 resolve(null);
});
(async()=>{
 const message={type:'WORKBENCH_PRICE_CLAIM',id:'a'.repeat(64),summary:{skc:'123'}};
 const results=await Promise.all([send(message),send(message)]);
 assert.equal(results.filter(r=>r.ok).length,1);
 assert.equal(results.filter(r=>r.error).length,1);
 assert.equal(Object.keys(storage).length,1);
 assert.ok((await send({...message,id:'b'.repeat(64)},'https://example.com')).error);
 assert.ok((await send({...message,id:'bad'})).error);
 console.log('Price attempt lock passed: concurrent duplicate and foreign source rejected.');
})().catch(e=>{console.error(e);process.exitCode=1});
