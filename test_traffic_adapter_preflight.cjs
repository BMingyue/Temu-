const assert=require('node:assert/strict');
const {test,before,after}=require('node:test');
const fs=require('node:fs');
const path=require('node:path');
const {chromium}=require('./local_tools/dxm-uploader/_internal/playwright/driver/package');
const rules=fs.readFileSync('./browser_extension/traffic/rules.js','utf8');
const adapter=fs.readFileSync('./browser_extension/traffic/adapter.js','utf8');
let browser;
before(async()=>{browser=await chromium.launch({executablePath:path.resolve('runtime/gpt-chrome/chrome-win64/chrome.exe'),headless:true});});
after(async()=>{await browser?.close();});
async function fixture(options={},source=adapter){
  const context=await browser.newContext({viewport:{width:1000,height:700}});
  await context.route('**/*',route=>route.abort());
  const page=await context.newPage();
  await page.setContent(`<!doctype html><html><body>
    <div id="wbDailyBar" data-wb-manager-hidden="true" style="display:none!important"><div>${options.busy?'正在采集商品':'自动更新已开启'}</div><button>暂停自动更新</button></div>
    <div id="thirdPartyToolbar"><button>暂停自动更新</button></div>
    <button id="native">平台目标控件</button><button id="disabledNative" disabled>禁用目标</button>
    <button id="hiddenNative" style="display:none">隐藏目标</button>
    <div data-traffic-assistant style="position:fixed;inset:0;z-index:2147483647;background:#fff8"><button id="assistantButton">助手控件</button></div>
  </body></html>`);
  await page.evaluate(options=>{
    window.__calls=[];window.__domClicks=0;window.__nativeClicks=0;window.__enabled=options.enabled!==false;
    for(const button of document.querySelectorAll('#wbDailyBar button,#thirdPartyToolbar button'))button.onclick=()=>{window.__domClicks++};
    document.getElementById('native').onclick=()=>{window.__nativeClicks++};
    if(options.fastTimeout){const original=setTimeout;window.setTimeout=(fn,ms,...args)=>original(fn,ms===5000?15:ms,...args);}
    if(!options.noRuntime)window.chrome={runtime:{sendMessage:async message=>{
      window.__calls.push(message);
      if(options.reject)throw Error('Extension context invalidated.');
      if(options.hang)return await new Promise(()=>{});
      if(options.invalid)return {enabled:'false'};
      if(message.type==='WORKBENCH_AUTO_STATUS'){
        const state={enabled:window.__enabled};
        if(options.dropAfterStatus)delete window.chrome.runtime;
        return state;
      }
      if(message.type==='WORKBENCH_AUTO_ENABLE'){
        if(!options.ignoreEnable&&!(options.refuseRestore&&message.enabled))window.__enabled=message.enabled;
        if(options.hangOnPause&&!message.enabled)return await new Promise(()=>{});
        return {enabled:window.__enabled};
      }
      throw Error('unexpected command');
    }}};
  },options);
  await page.addScriptTag({content:rules});await page.addScriptTag({content:source});
  return {page,close:()=>context.close()};
}
test('hidden daily update bar reproduces the old zero-start error before platform reads',{skip:!fs.existsSync('./data/code-backups/20261101-traffic-adapter-preflight/adapter.js')},async()=>{
  const old=fs.readFileSync('./data/code-backups/20261101-traffic-adapter-preflight/adapter.js','utf8');
  const h=await fixture({},old);
  try{
    const result=await h.page.evaluate(async()=>{
      try{await TrafficDOM.pauseUpdater();return {error:''}}catch(error){return {error:error.message,rects:document.querySelector('#wbDailyBar button').getClientRects().length,calls:__calls,clicks:__domClicks}}
    });
    assert.equal(result.error,'目标控件已消失或不可用');assert.equal(result.rects,0);
    assert.deepEqual(result.calls,[]);assert.equal(result.clicks,0);
  }finally{await h.close();}
});
test('hidden own bar and unrelated toolbar are never clicked while scheduler state is paused and restored',async()=>{
  const h=await fixture();
  try{
    const result=await h.page.evaluate(async()=>{
      const paused=await TrafficDOM.pauseUpdater(),afterPause=__enabled;
      await TrafficDOM.restoreUpdater();await TrafficDOM.restoreUpdater();
      return {paused,afterPause,enabled:__enabled,calls:__calls,clicks:__domClicks};
    });
    assert.equal(result.paused,true);assert.equal(result.afterPause,false);assert.equal(result.enabled,true);assert.equal(result.clicks,0);
    assert.deepEqual(result.calls,[{type:'WORKBENCH_AUTO_STATUS'},{type:'WORKBENCH_AUTO_ENABLE',enabled:false},{type:'WORKBENCH_AUTO_STATUS'},
      {type:'WORKBENCH_AUTO_STATUS'},{type:'WORKBENCH_AUTO_ENABLE',enabled:true},{type:'WORKBENCH_AUTO_STATUS'}]);
  }finally{await h.close();}
});
test('already paused state is not changed or restored',async()=>{
  const h=await fixture({enabled:false});
  try{
    const result=await h.page.evaluate(async()=>{const paused=await TrafficDOM.pauseUpdater();await TrafficDOM.restoreUpdater();return {paused,enabled:__enabled,calls:__calls,clicks:__domClicks}});
    assert.equal(result.paused,false);assert.equal(result.enabled,false);assert.equal(result.clicks,0);
    assert.deepEqual(result.calls,[{type:'WORKBENCH_AUTO_STATUS'}]);
  }finally{await h.close();}
});
test('unavailable, malformed and timed-out scheduler responses stop explicitly without DOM fallback',async()=>{
  for(const options of [{noRuntime:true},{reject:true},{invalid:true},{hang:true,fastTimeout:true},{dropAfterStatus:true}]){
    const h=await fixture(options);
    try{
      const result=await h.page.evaluate(async()=>{try{await TrafficDOM.pauseUpdater();return {error:''}}catch(error){return {error:error.message,enabled:__enabled,calls:__calls,clicks:__domClicks}}});
      assert.match(result.error,/自动更新/);assert.match(result.error,/连接|状态|超时/);
      assert.equal(result.enabled,true);assert.equal(result.clicks,0);assert.ok(!result.calls.some(call=>call.type==='WORKBENCH_AUTO_ENABLE'));
    }finally{await h.close();}
  }
});
test('unknown pause outcome stays paused without an automatic recovery write and failed restore stays explicit',async()=>{
  for(const options of [{hangOnPause:true,fastTimeout:true},{refuseRestore:true}]){
    const h=await fixture(options);
    try{
      const result=await h.page.evaluate(async()=>{
        let pauseError='',restoreError='';
        try{await TrafficDOM.pauseUpdater()}catch(error){pauseError=error.message}
        try{await TrafficDOM.restoreUpdater()}catch(error){restoreError=error.message}
        return {pauseError,restoreError,enabled:__enabled,calls:__calls,clicks:__domClicks};
      });
      assert.equal(result.enabled,false);assert.equal(result.clicks,0);
      if(options.hangOnPause){
        assert.match(result.pauseError,/超时/);assert.equal(result.restoreError,'');
        assert.ok(!result.calls.some(call=>call.type==='WORKBENCH_AUTO_ENABLE'&&call.enabled));
      }else{
        assert.equal(result.pauseError,'');assert.match(result.restoreError,/恢复自动更新未生效/);
      }
      assert.ok(result.calls.every(call=>['WORKBENCH_AUTO_STATUS','WORKBENCH_AUTO_ENABLE'].includes(call.type)));
    }finally{await h.close();}
  }
});
test('failed pause acknowledgement and an active collector never proceed as if preparation succeeded',async()=>{
  for(const options of [{ignoreEnable:true},{busy:true}]){
    const h=await fixture(options);
    try{
      const result=await h.page.evaluate(async()=>{try{await TrafficDOM.pauseUpdater();return {error:''}}catch(error){return {error:error.message,enabled:__enabled,calls:__calls,clicks:__domClicks}}});
      assert.match(result.error,/暂停|采集/);assert.equal(result.enabled,true);assert.equal(result.clicks,0);
      if(options.busy)assert.ok(!result.calls.some(call=>call.type==='WORKBENCH_AUTO_ENABLE'));
    }finally{await h.close();}
  }
});
test('overlay occlusion does not alter visibility guards or permit hidden, disabled, detached and own controls',async()=>{
  const h=await fixture();
  try{
    const result=await h.page.evaluate(()=>{
      const target=document.getElementById('native'),rect=target.getBoundingClientRect();
      const covered=document.elementFromPoint(rect.left+rect.width/2,rect.top+rect.height/2)!==target;
      const errors=[];
      TrafficDOM.click(target);
      for(const id of ['disabledNative','hiddenNative','assistantButton']){try{TrafficDOM.click(document.getElementById(id))}catch(error){errors.push(error.message)}}
      const detached=document.createElement('button');try{TrafficDOM.click(detached)}catch(error){errors.push(error.message)}
      return {covered,visible:TrafficDOM.visible(target),clicks:__nativeClicks,errors};
    });
    assert.equal(result.covered,true);assert.equal(result.visible,true);assert.equal(result.clicks,1);
    assert.equal(result.errors.length,4);assert.ok(result.errors.every(error=>error==='目标控件已消失或不可用'));
  }finally{await h.close();}
});
