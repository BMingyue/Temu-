const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const context={module:{exports:{}},AbortController,setTimeout,clearTimeout,console};
vm.runInNewContext(fs.readFileSync('./gpt_chrome_extension/pairing.js','utf8'),context);
const {createWorkbenchPairing}=context.module.exports;

function extensionApi(storage){
 return {
  runtime:{getManifest:()=>({version:'0.3.35'})},
  storage:{local:{
   get:async key=>({[key]:storage[key]}),
   set:async value=>Object.assign(storage,value),
   remove:async key=>delete storage[key],
  }},
 };
}

(async()=>{
 const token='portable_token_'+('x'.repeat(32));
 const storage={};let requests=0,lastRequest=null;
 const pairing=createWorkbenchPairing({
  extensionApi:extensionApi(storage),api:'http://127.0.0.1:18769/api/bridge/gpt',
  fetchImpl:async(url,options)=>{requests++;lastRequest={url,options};return {ok:true,status:200,json:async()=>({ok:true,token})}},
 });
 assert.equal(await pairing.getToken(),token);
 assert.equal(storage.workbenchToken,token);
 assert.equal(requests,1);
 assert.equal(lastRequest.url,'http://127.0.0.1:18769/api/bridge/gpt/bootstrap');
 assert.equal(JSON.parse(lastRequest.options.body).version,'0.3.35');
 assert.equal(await pairing.getToken(),token);
 assert.equal(requests,1,'memory token should avoid a second bootstrap request');
 assert.equal(await pairing.getToken(true),token);
 assert.equal(requests,2,'forced repair should discard the old token and pair again');

 const stored={workbenchToken:'stored_token_'+('y'.repeat(32))};let storedFetches=0;
 const fromStorage=createWorkbenchPairing({extensionApi:extensionApi(stored),api:'http://127.0.0.1:18769/api/bridge/gpt',fetchImpl:async()=>{storedFetches++;throw Error('should not fetch')}});
 assert.equal(await fromStorage.getToken(),stored.workbenchToken);
 assert.equal(storedFetches,0);

 const invalid=createWorkbenchPairing({extensionApi:extensionApi({}),api:'http://127.0.0.1:18769/api/bridge/gpt',fetchImpl:async()=>({ok:true,status:200,json:async()=>({token:'short'})})});
 await assert.rejects(invalid.getToken(),/连接凭据无效/);
 console.log('GPT first-install pairing checks passed.');
})().catch(error=>{console.error(error);process.exitCode=1});

