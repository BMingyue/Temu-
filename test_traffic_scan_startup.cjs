const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {chromium}=require('./local_tools/dxm-uploader/_internal/playwright/driver/package');
const evidence=path.resolve(process.env.WORKBENCH_TEST_EVIDENCE_DIR||path.join(__dirname,'data/verification/20261101-traffic-startup-integration'));
fs.mkdirSync(evidence,{recursive:true});
const baselineOnly=process.argv.includes('--baseline-only');
const files=['identity-reader.js','rules.js','adapter.js','scan-only.js','runner.js'];
const current=Object.fromEntries(files.map(file=>[file,fs.readFileSync(path.join(__dirname,'browser_extension/traffic',file),'utf8')]));
const baselineRoot=path.join(__dirname,'data/verification/20261101-traffic-startup-integration/baseline');
if(baselineOnly&&files.some(file=>!fs.existsSync(path.join(baselineRoot,file))))throw Error('Baseline source backup is required for --baseline-only; current source is not a baseline.');
const old=Object.fromEntries(files.map(file=>{const saved=path.join(baselineRoot,file);return[file,fs.existsSync(saved)?fs.readFileSync(saved,'utf8'):current[file]];}));
const result={at:new Date().toISOString(),mode:'isolated real-layout fixture, full runner scan only; all runtime/storage mocked, platform clicks/input/network blocked; apply never invoked',checks:[],cases:[],errors:[],sourceHashes:Object.fromEntries(Object.entries(baselineOnly?old:current).map(([file,source])=>[file,crypto.createHash('sha256').update(source).digest('hex')]))};
const fixture=`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
 *{box-sizing:border-box}body{margin:0;background:#f5f6f8;font:14px Arial;color:#24344a}header{padding:20px;background:white}main{margin:20px;width:1600px}#listArea{height:390px;overflow-y:auto;border:1px solid #ddd;background:white}table{width:100%;border-collapse:collapse}tr{height:86px}td{border-bottom:1px solid #eee;padding:8px}.tag{display:inline-block;background:#eff6ff;padding:4px}.pagination-wrapper_fixture{display:flex;gap:12px;padding:18px;background:white}.PGT_sizeChanger_fixture{margin-left:auto}.PGT_sizeChanger_fixture input{width:60px}#wbDailyBar{position:fixed;bottom:15px;left:15px;background:#fff7ee;padding:10px}button{padding:8px;border:1px solid #ccc;background:white}
 </style></head><body><header>Seller Central · 流量分析 · 隔离测试页面</header><main><div id="listArea"><table><tbody id="list"></tbody></table></div><div class="pagination-wrapper_fixture PGT_alone_fixture" role="navigation" aria-label="商品分页"><span class="PGT_totalText_fixture">共有 100 条</span><span class="PGT_sizeChanger_fixture">每页<input data-testid="beast-core-select-htmlInput" value="100" readonly><span class="IPT_mirror_fixture" style="visibility:hidden">100</span>条</span></div></main><div id="wbDailyBar" data-wb-manager-hidden="true" style="display:none!important"><strong>每日数据更新 · 自动流量</strong><div>自动更新已开启 · 待机</div><button id="autoButton">暂停自动更新</button></div></body></html>`;

async function setup(browser,options={},sources=current){
 const context=await browser.newContext({viewport:{width:1660,height:1060},locale:'zh-CN'}),page=await context.newPage();
 const network=[];page.setDefaultTimeout(20000);page.on('pageerror',error=>result.errors.push(error.message));
 await context.route('**/*',route=>{
  const request=route.request();
  if(request.method()==='GET'&&request.url()==='https://agentseller-us.temu.com/main/flux-analysis'&&network.length===0){network.push({kind:'fixture',method:'GET'});return route.fulfill({contentType:'text/html',body:fixture});}
  network.push({kind:'blocked',method:request.method()});return route.abort('blockedbyclient');
 });
 await page.goto('https://agentseller-us.temu.com/main/flux-analysis');
 await page.evaluate(options=>{
  window.__effects={runtime:[],storage:[],platformClicks:[],platformInputs:[],domClicks:[]};
  window.__autoEnabled=options.autoEnabled!==false;
  window.__storage={trafficConfig:{categories:['小盖毯、午休毯'],tags:['限时秒杀'],duration:14,skuRules:[{spec:'40*50in-法兰绒',price:'49'}],maxPages:4,delayMs:300,scanPageDelayMs:15000,timeoutMs:2500,resultTimeoutMs:2500},trafficConfirmedSuccess:[{id:'900001',goodsId:'9900001',key:'9900001',confirmedAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+14*86400000-1000).toISOString()}]};
  if(options.pending)window.__storage.trafficPending={id:'900002',goodsId:'9900002',key:'9900002',runId:'old-pending-1234',time:new Date().toISOString()};
  window.__protectionBefore=JSON.stringify({trafficPending:window.__storage.trafficPending,trafficConfirmedSuccess:window.__storage.trafficConfirmedSuccess});
  window.chrome={runtime:{async sendMessage(message){
   __effects.runtime.push(structuredClone(message));
   if(message.trafficLock==='acquire')return options.lockBusy?{ok:false,message:'工作台正在采集，请等待完成后再启动'}:{ok:true};
   if(['release','heartbeat'].includes(message.trafficLock))return{ok:true};
   if(message.type==='WORKBENCH_AUTO_STATUS')return options.invalidAutoStatus?{}:{enabled:__autoEnabled,message:'隔离状态'};
   if(message.type==='WORKBENCH_AUTO_ENABLE'){if(options.enableRejected||options.restoreRejected&&message.enabled)throw Error('mock runtime unavailable');__autoEnabled=message.enabled===true;return{enabled:__autoEnabled};}
   throw Error('TEST_BOUNDARY_RUNTIME_COMMAND_BLOCKED:'+JSON.stringify(message));
  }},storage:{local:{async get(keys){const result={};for(const key of typeof keys==='string'?[keys]:keys)result[key]=structuredClone(__storage[key]);return result;},async set(patch){__effects.storage.push(Object.keys(patch));for(const key of Object.keys(patch))if(!['trafficConfig','trafficLastRun'].includes(key))throw Error('TEST_BOUNDARY_PROTECTION_WRITE_BLOCKED:'+key);Object.assign(__storage,structuredClone(patch));},async remove(){throw Error('TEST_BOUNDARY_STORAGE_REMOVE_BLOCKED');}}}};
  // Preserve the real adapter's geometry/visibility checks. The only native
  // clicks permitted are the runner's scan/stop controls and local updater UI.
  const nativeClick=HTMLElement.prototype.click;
  HTMLElement.prototype.click=function(){
   const host=this.getRootNode()?.host;
   if(host?.matches('[data-traffic-assistant]')){
    if(!['scan','stop','collapse','expand'].includes(this.id))throw Error('TEST_BOUNDARY_APPLY_OR_PANEL_ACTION_BLOCKED:'+this.id);
    __effects.domClicks.push('panel:'+this.id);return nativeClick.call(this);
   }
   if(this.closest('#wbDailyBar')){__effects.domClicks.push('daily');return nativeClick.call(this);}
   __effects.platformClicks.push(this.textContent);throw Error('TEST_BOUNDARY_PLATFORM_CLICK_BLOCKED');
  };
  for(const name of ['input','change','submit'])document.addEventListener(name,event=>{
   if(event.composedPath().some(node=>node?.matches?.('[data-traffic-assistant]')))return;
   __effects.platformInputs.push(name);event.preventDefault();event.stopImmediatePropagation();
  },true);
  window.fetch=()=>{throw Error('TEST_BOUNDARY_FETCH_BLOCKED');};
  XMLHttpRequest.prototype.open=function(){throw Error('TEST_BOUNDARY_XHR_BLOCKED');};
  navigator.sendBeacon=()=>{throw Error('TEST_BOUNDARY_BEACON_BLOCKED');};
  const nativeTimeout=window.setTimeout.bind(window);
  window.setTimeout=(fn,delay,...args)=>nativeTimeout(fn,[150,200,250,300,700,750,1000].includes(delay)?Math.min(delay,5):delay,...args);
  const body=document.getElementById('list'),source=Array.from({length:100},(_,i)=>({productId:String(800000+i),goodsId:String(9800000+i)}));
  body.innerHTML=source.map(item=>'<tr data-testid="beast-core-table-body-tr" data-row-key="'+item.productId+'"><td><div>Flannel blanket</div><div class="goodsItem_fixture">类目：家居、厨房用品&gt;床上用品&gt;毯子、盖毯&gt;小盖毯、午休毯</div><div>SPU ID：'+item.productId+'</div><div>经营站点：美国站</div><span class="tag" data-testid="beast-core-tag"><span>限时秒杀<svg width="8" height="8"></svg></span></span></td><td>该商品已获得开启流量加速器机会 <button data-business-action="open">立即开启</button></td></tr>').join('');
  for(const row of body.children)Object.defineProperty(row,'__reactFiber$fixture',{value:{memoizedProps:{dataSource:source},return:null},configurable:true,enumerable:true});
  const button=document.getElementById('autoButton');button.textContent=__autoEnabled?'暂停自动更新':'开启自动更新';button.onclick=()=>{__autoEnabled=!__autoEnabled;button.textContent=__autoEnabled?'暂停自动更新':'开启自动更新';};
  if(options.noDailyBar)document.getElementById('wbDailyBar').remove();
  else if(options.visibleDailyBar){document.getElementById('wbDailyBar').style.removeProperty('display');document.getElementById('wbDailyBar').removeAttribute('data-wb-manager-hidden');}
 },options);
 for(const file of files)await page.addScriptTag({content:sources[file]});
 await page.waitForFunction(()=>globalThis.__temuTrafficAssistant?.state.ready);
 return{context,page,network};
}
async function runScan(h,{double=false,stopDuringScroll=false}={}){
 await h.page.evaluate(double=>{const scan=document.querySelector('[data-traffic-assistant]').shadowRoot.getElementById('scan');scan.click();if(double)scan.click();},double);
 if(stopDuringScroll){await h.page.waitForFunction(()=>__temuTrafficAssistant.state.running&&document.getElementById('listArea').scrollTop>0);await h.page.evaluate(()=>document.querySelector('[data-traffic-assistant]').shadowRoot.getElementById('stop').click());}
 await h.page.waitForFunction(()=>!__temuTrafficAssistant.state.starting,null,{timeout:30000});
 return h.page.evaluate(()=>({state:{...__temuTrafficAssistant.state,successful:undefined},status:document.querySelector('[data-traffic-assistant]').shadowRoot.getElementById('status').textContent,error:document.querySelector('[data-traffic-assistant]').shadowRoot.getElementById('errors').textContent,effects:__effects,autoEnabled:__autoEnabled,protectionBefore:__protectionBefore,protectionAfter:JSON.stringify({trafficPending:__storage.trafficPending,trafficConfirmedSuccess:__storage.trafficConfirmedSuccess}),lastRun:__storage.trafficLastRun}));
}
function safe(value,h){
 assert.deepEqual(value.effects.platformClicks,[]);assert.deepEqual(value.effects.platformInputs,[]);assert.equal(h.network.length,1);assert.equal(h.network[0].kind,'fixture');
 assert.equal(value.protectionAfter,value.protectionBefore);
 assert(value.effects.domClicks.every(item=>item.startsWith('panel:')||item==='daily'));
 assert(value.effects.runtime.every(item=>['acquire','heartbeat','release'].includes(item.trafficLock)||['WORKBENCH_AUTO_STATUS','WORKBENCH_AUTO_ENABLE'].includes(item.type)));
}
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.WORKBENCH_TEST_CHROME||path.join(__dirname,'runtime/gpt-chrome/chrome-win64/chrome.exe'),headless:true,args:['--disable-background-networking','--disable-sync']});
 try{
  if(baselineOnly){
   const h=await setup(browser,{},old);try{
    const value=await runScan(h);safe(value,h);assert.equal(value.state.counts.read,0);assert.match(value.status,/目标控件已消失或不可用/);assert.equal(value.state.coverage.length,0);
    result.cases.push({name:'baseline hidden updater',status:value.status,counts:value.state.counts,logs:value.state.logs,effects:value.effects});result.checks.push('修前完整runner只读扫描稳定复现：隐藏dailybar使起步即停、已读0、未进入分页');
    await h.page.screenshot({path:path.join(evidence,'baseline-hidden-updater.png'),fullPage:false});
   }finally{await h.context.close();}
  }else{
   for(const options of [{name:'hidden daily bar',autoEnabled:true},{name:'no daily bar',autoEnabled:true,noDailyBar:true},{name:'already paused',autoEnabled:false},{name:'visible updater',autoEnabled:true,visibleDailyBar:true}]){
    const h=await setup(browser,options);try{
     const value=await runScan(h,{double:options.name==='hidden daily bar'});safe(value,h);
     assert.match(value.status,/扫描完成/);assert.equal(value.state.counts.read,100);assert.equal(value.state.counts.seen,100);assert.equal(value.state.counts.matched,100);assert.equal(value.state.counts.success,0);assert.equal(value.state.counts.failed,0);assert.equal(value.state.counts.unknown,0);assert.equal(value.state.records.length,100);assert(value.state.records.every(row=>row.result==='candidate'));
     assert.deepEqual(value.state.coverage.map(page=>[page.page,page.expected,page.scanned,page.duplicate]),[[1,100,100,0]]);
     assert.deepEqual(value.effects.runtime.filter(item=>item.type==='WORKBENCH_AUTO_ENABLE').map(item=>item.enabled),options.autoEnabled?[false,true]:[]);assert.equal(value.autoEnabled,options.autoEnabled);
     assert.equal(value.effects.runtime.filter(item=>item.trafficLock==='acquire').length,1);assert.equal(value.effects.runtime.filter(item=>item.trafficLock==='release').length,1);
     assert.equal(value.effects.domClicks.filter(item=>item==='daily').length,0);
     result.cases.push({name:options.name,status:value.status,counts:value.state.counts,coverage:value.state.coverage,autoEnabled:value.autoEnabled,runtime:value.effects.runtime,domClicks:value.effects.domClicks});
     result.checks.push(options.name+'：真实布局100条单页完整只读扫描，无平台点击/输入/网络，原自动开关恢复一致');
     if(options.name==='hidden daily bar'){
      const overlay=await h.page.evaluate(()=>{const input=document.querySelector('.PGT_sizeChanger_fixture input'),r=input.getBoundingClientRect();return{covered:!!document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('[data-traffic-assistant]'),visible:TrafficDOM.visible(input)};});
      assert.equal(overlay.covered,true);assert.equal(overlay.visible,true);
      result.checks.push('真实固定面板遮住每页条数输入框时仍能只读识别分页；无点击该输入框');
      await h.page.addScriptTag({content:current['runner.js']});assert.equal(await h.page.locator('[data-traffic-assistant]').count(),1);assert.equal(await h.page.evaluate(()=>__temuTrafficAssistant.state.counts.read),100);
      assert.equal(await h.page.evaluate(()=>__effects.runtime.filter(item=>item.trafficLock==='acquire').length),1);
      result.checks.push('双击扫描与重注入不会重复拿锁、重新扫描或丢失已读记录');
      await h.page.screenshot({path:path.join(evidence,'scan-100-complete.png'),fullPage:false});
     }
    }finally{await h.context.close();}
   }
   for(const options of [{name:'pending protection',pending:true},{name:'collector lock busy',lockBusy:true},{name:'unknown automatic state',invalidAutoStatus:true},{name:'pause runtime rejection',enableRejected:true}]){
    const h=await setup(browser,options);try{
     const value=await runScan(h);safe(value,h);assert.equal(value.state.counts.read,0);if(!options.enableRejected)assert.equal(value.effects.runtime.filter(item=>item.type==='WORKBENCH_AUTO_ENABLE').length,0);
     assert.match(value.error||value.status,options.pending?/结果未确认/:options.lockBusy?/正在采集/:/自动|准备|状态/);
     if(!options.pending&&!options.lockBusy){assert(value.state.lastError);assert.match(value.state.lastError.step,/准备|暂停|更新/);}
     result.cases.push({name:options.name,status:value.status,error:value.error,counts:value.state.counts,runtime:value.effects.runtime});result.checks.push(options.name+'：准备阶段拒绝且保留pending/14天成功保护，不进入平台动作');
    }finally{await h.context.close();}
   }
   {
    const h=await setup(browser,{restoreRejected:true});try{
     const value=await runScan(h);safe(value,h);assert.equal(value.state.counts.read,100);assert.equal(value.state.coverage.length,1);assert.match(value.status,/列表扫描已完成，但恢复自动更新失败/);assert.equal(value.state.lastError.trafficStage,'restore_auto_updates');assert.equal(value.autoEnabled,false);
     result.cases.push({name:'restore failure preserves completed coverage',status:value.status,counts:value.state.counts,coverage:value.state.coverage,lastError:value.state.lastError});result.checks.push('恢复调度失败保留100/100扫描覆盖与restore_auto_updates诊断，不伪装扫描成功或启动重采');
    }finally{await h.context.close();}
   }
   {
    const h=await setup(browser,{});try{
     const value=await runScan(h,{stopDuringScroll:true});safe(value,h);assert.equal(value.state.counts.read,0);assert.match(value.status,/已停止/);assert.equal(value.autoEnabled,false);assert.deepEqual(value.effects.runtime.filter(item=>item.type==='WORKBENCH_AUTO_ENABLE').map(item=>item.enabled),[false]);
     result.cases.push({name:'stop during revealRows',status:value.status,counts:value.state.counts,runtime:value.effects.runtime,lastError:value.state.lastError});result.checks.push('revealRows实际滚动期间可停止，0读取/0平台动作，失败后保持已暂停调度且不重扫');
    }finally{await h.context.close();}
   }
  }
  assert.deepEqual(result.errors,[]);result.passed=true;
 }catch(error){result.passed=false;result.error=error.stack;throw error;}
 finally{fs.writeFileSync(path.join(evidence,baselineOnly?'baseline-reproduction.json':'integration-verification.json'),JSON.stringify(result,null,2));await browser.close();}
})().catch(error=>{console.error(error);process.exit(1)});
