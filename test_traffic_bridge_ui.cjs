const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');
const {chromium}=require('./local_tools/dxm-uploader/_internal/playwright/driver/package');
const workbenchVersion=JSON.parse(fs.readFileSync(path.join(__dirname,'workbench-release.json'),'utf8')).version;
const evidence=path.resolve(process.env.WORKBENCH_TEST_EVIDENCE_DIR||path.join(__dirname,'data/verification/20261101-traffic-bridge-ui'));fs.mkdirSync(evidence,{recursive:true});
const result={at:new Date().toISOString(),mode:'isolated headless UI; fake extension messages and API reads; all writes/external network blocked; request/retry timers shortened',checks:[],writes:[],errors:[]};
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.WORKBENCH_TEST_CHROME||path.join(__dirname,'runtime/gpt-chrome/chrome-win64/chrome.exe'),headless:true});
 const page=await browser.newPage({viewport:{width:1540,height:1100},locale:'zh-CN'});page.setDefaultTimeout(12000);page.on('pageerror',e=>result.errors.push(e.message));
 await page.addInitScript(()=>{
  localStorage.setItem('workbench.quickstart.v20261029','seen');
  const timeout=window.setTimeout.bind(window),interval=window.setInterval.bind(window);
  window.setTimeout=(fn,delay,...args)=>timeout(fn,delay===5000?120:delay===45000?220:delay,...args);
  window.setInterval=(fn,delay,...args)=>interval(fn,delay===15000?350:delay,...args);
  window.__bridge={mode:'healthy',instance:'bridge-a',commands:[],pingDelay:10};
  window.addEventListener('message',event=>{
   const data=event.data;if(event.source!==window||data?.source!=='temu-workbench-web')return;
   const bridge=window.__bridge;bridge.commands.push({command:data.command,mallId:data.mallId,bridgeInstance:data.bridgeInstance});
   const reply=result=>window.postMessage({source:'temu-workbench-extension',id:data.id,result},location.origin);
   if(bridge.mode==='missing')return;
   // Historical v1 error always arrives first and must never defeat a healthy v2.
   reply({ok:false,error:'插件连接已失效，请刷新工作台页面后重试'});
   if(bridge.mode==='stale')return;
   const meta={bridgeProtocol:2,bridgeVersion:'local_web_bridge_v2',bridgeInstance:bridge.instance};
   if(data.command==='WORKBENCH_PING'){
    if(bridge.mode==='legacy'){timeout(()=>reply({ok:true,version:'0.20.13',capabilities:['traffic-accelerator']}),10);return;}
    timeout(()=>reply({ok:true,version:'0.20.14',capabilities:bridge.mode==='no-capability'?[]:['traffic-accelerator'],...meta}),bridge.pingDelay);return;
   }
   if(data.command==='WORKBENCH_OPEN_TRAFFIC_ACCELERATOR'){
    if(bridge.mode==='silent-open')return;
    if(bridge.mode==='generation'){bridge.instance='bridge-b';bridge.mode='healthy';timeout(()=>reply({ok:false,error:'插件连接已更新，已恢复连接；请确认后再打开面板。',code:'BRIDGE_GENERATION_CHANGED',retryable:true,...meta,bridgeInstance:'bridge-b'}),10);return;}
    if(bridge.mode==='mismatch'){timeout(()=>reply({ok:false,error:'卖家后台当前店铺与工作台所选店铺不一致，请切回所选店铺。',code:'MALL_MISMATCH',...meta}),10);return;}
    reply({ok:true,panelOnly:true,message:'错误桥的回复不应显示',...meta,bridgeInstance:'wrong-instance'});
    timeout(()=>reply({ok:true,panelOnly:bridge.mode!=='no-panel-confirm',mallId:bridge.mode==='wrong-mall-confirm'?'222':data.mallId,message:'目标店铺面板已打开，未启动任务。',...meta}),15);
   }
  });
 });
 await page.route('**/*',route=>new URL(route.request().url()).origin==='http://127.0.0.1:5173'?route.continue():route.abort('blockedbyclient'));
 await page.route('**/api/**',async route=>{
  const req=route.request(),u=new URL(req.url()),p=u.pathname;if(req.method()!=='GET'){result.writes.push(p);return route.abort('blockedbyclient');}
  let data={};const now=new Date().toISOString();
  if(p==='/api/state')data={products:[],scopes:[],entries:[],rules:{},coverage:{},catalog:[],collections:[],traffic:[],traffic_captures:[]};
  else if(p==='/api/health')data={ok:true,version:workbenchVersion};
  else if(p==='/api/collector/control')data={clients:{ui:{client_id:'ui',browser:'Chrome',mall_id:'111',store_name:'桥接测试店铺',at:now,version:'0.20.14'}},commands:[]};
  else if(p==='/api/collector/state')data={shops:[{mall_id:'111',name:'桥接测试店铺'}],records:{},receipts:[],counts:{}};
  else if(p==='/api/features/product-status')data={mallId:'111',products:[],trash:[],pending:[],categoryConfig:{rules:[],revision:1},counts:{onSale:0,notOnSale:0,unknown:0,skus:0,enrolled:0},sources:{products:{captured:now},activities:{captured:now},accelerators:{captured:now}}};
  else if(p==='/api/patrol/state')data={mallId:'111',health:{items:[],unclearedCount:0},trafficAttention:{items:[],available:true},window:{active:false},forceModal:false};
  return route.fulfill({json:data});
 });
 const status=()=>page.getByLabel('加速器插件连接状态',{exact:true});
 const open=()=>page.getByRole('button',{name:'打开流量加速器面板',exact:true});
 const commands=()=>page.evaluate(()=>window.__bridge.commands);
 const reset=mode=>page.evaluate(mode=>{window.__bridge.mode=mode;window.__bridge.commands=[];window.__bridge.pingDelay=10;},mode);
 const ready=()=>page.evaluate(()=>window.postMessage({source:'temu-workbench-extension',event:'WORKBENCH_BRIDGE_READY',bridgeProtocol:2,bridgeInstance:window.__bridge.instance},location.origin));
 const healthy=async()=>{await status().filter({hasText:'插件已连接 · 0.20.14'}).waitFor();};
 try{
  await page.goto('http://127.0.0.1:5173/?client_id=ui&mall_id=111&browser=Chrome',{waitUntil:'domcontentloaded',timeout:45000});
  await page.locator('.connection.connected').waitFor();await page.getByRole('navigation',{name:'工作板块',exact:true}).getByRole('button',{name:'维护',exact:true}).click();await page.getByRole('navigation',{name:'板块工具',exact:true}).getByRole('button',{name:'流量加速器',exact:true}).click();
  await healthy();assert.equal(await page.getByRole('alert').count(),0);
  result.checks.push('失效legacy回复先到时仍等待并采用健康协议2桥；真实PING成功才显示已连接');
  await reset('healthy');await open().click();await page.getByRole('status').filter({hasText:'目标店铺面板已打开'}).waitFor();
  let sent=await commands();assert.deepEqual(sent.map(item=>item.command),['WORKBENCH_PING','WORKBENCH_OPEN_TRAFFIC_ACCELERATOR']);assert.equal(sent[1].bridgeInstance,'bridge-a');assert.equal(sent[1].mallId,'111');assert.equal(await page.getByText('错误桥的回复不应显示',{exact:true}).count(),0);
  result.checks.push('打开前重新PING；OPEN仅一次且带所选店铺/bridgeInstance，忽略其他桥实例回复，仅panelOnly确认成功');
  await page.screenshot({path:path.join(evidence,'connected-panel-only.png'),fullPage:false});
  await reset('mismatch');await open().click();await page.getByRole('alert').filter({hasText:'店铺不一致'}).waitFor();assert.equal((await commands()).filter(item=>item.command==='WORKBENCH_OPEN_TRAFFIC_ACCELERATOR').length,1);
  result.checks.push('不同店铺回复明确提示且不自动重开，不把同店校验失败伪装成断线');
  await reset('no-panel-confirm');await open().click();await page.getByRole('alert').filter({hasText:'未取得仅打开面板的确认'}).waitFor();
  result.checks.push('没有panelOnly=true时不会报告打开成功');
  await reset('wrong-mall-confirm');await open().click();await page.getByRole('alert').filter({hasText:'未取得所选店铺的面板确认'}).waitFor();
  result.checks.push('即使ok=true/panelOnly=true，返回店铺不符仍不报告成功');
  await reset('generation');await open().click();await page.waitForFunction(()=>window.__bridge.commands.filter(item=>item.command==='WORKBENCH_PING').length>=2);await healthy();
  assert.equal((await commands()).filter(item=>item.command==='WORKBENCH_OPEN_TRAFFIC_ACCELERATOR').length,1);
  assert.equal(await page.getByRole('alert').filter({hasText:'插件连接已更新'}).count(),0);
  result.checks.push('握手后桥代际改变立即识别并只重PING新桥，恢复后清除该连接旧错误，不等待45秒或重放OPEN');
  await reset('stale');await open().click();await page.getByRole('alert').filter({hasText:'旧插件连接已失效'}).waitFor();assert.equal((await commands()).filter(item=>item.command==='WORKBENCH_OPEN_TRAFFIC_ACCELERATOR').length,0);
  await reset('healthy');await ready();await healthy();assert.equal((await commands()).filter(item=>item.command==='WORKBENCH_OPEN_TRAFFIC_ACCELERATOR').length,0);
  assert.equal(await page.getByRole('alert').filter({hasText:'旧插件连接已失效'}).count(),0);
  result.checks.push('当前桥失效时不发OPEN；新桥READY无需刷新自动重连，恢复只PING并清除旧context错误');
  await reset('silent-open');await open().click();await page.getByRole('alert').filter({hasText:'尚未收到面板打开确认'}).waitFor();
  await reset('healthy');await ready();await healthy();await page.waitForTimeout(800);
  assert.equal((await commands()).filter(item=>item.command==='WORKBENCH_OPEN_TRAFFIC_ACCELERATOR').length,0);
  assert((await page.getByRole('alert').innerText()).includes('尚未收到面板打开确认'));
  result.checks.push('OPEN超时后只恢复PING、不重放OPEN，并保留先查看卖家标签页的未确认结果');
  await reset('legacy');await page.getByRole('button',{name:'重新检测插件',exact:true}).click();await page.getByRole('alert').filter({hasText:'页面的连接仍待更新'}).waitFor();assert(!(await status().innerText()).includes('插件已连接'));
  await reset('healthy');await ready();await healthy();
  assert((await page.getByRole('alert').innerText()).includes('尚未收到面板打开确认'));
  result.checks.push('legacy PING仅诊断在线，不把旧桥当可安全定向打开；升级READY后自动恢复');
  await reset('no-capability');await page.getByRole('button',{name:'重新检测插件',exact:true}).click();await page.getByRole('alert').filter({hasText:'尚未提供可用的面板连接'}).waitFor();assert(!(await status().innerText()).includes('插件已连接'));
  await reset('missing');await page.getByRole('button',{name:'重新检测插件',exact:true}).click();await page.getByRole('alert').filter({hasText:'尚未收到此页面的插件响应'}).waitFor();assert.equal((await commands()).filter(item=>item.command==='WORKBENCH_OPEN_TRAFFIC_ACCELERATOR').length,0);
  await reset('healthy');await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await healthy();
  result.checks.push('缺能力或无页面响应时不以在线心跳代替连接；返回页面触发PING恢复');
  await reset('healthy');await page.evaluate(()=>window.__bridge.pingDelay=90);await open().click();
  await page.getByRole('button',{name:'查看全部店铺',exact:true}).click();await page.getByRole('alert').filter({hasText:'店铺范围已变化'}).waitFor();assert.equal((await commands()).filter(item=>item.command==='WORKBENCH_OPEN_TRAFFIC_ACCELERATOR').length,0);
  await open().click();await page.getByRole('alert').filter({hasText:'请先在工作台顶部选择当前浏览器店铺'}).waitFor();
  result.checks.push('握手期间店铺范围改变及未选择店铺均不发送OPEN');
  await page.screenshot({path:path.join(evidence,'scope-protection.png'),fullPage:false});
  assert.equal(result.writes.length,0);assert.equal(result.errors.length,0);result.passed=true;
 }catch(error){result.passed=false;result.error=error.stack;await page.screenshot({path:path.join(evidence,'failure.png')}).catch(()=>{});throw error;}
 finally{fs.writeFileSync(path.join(evidence,'ui-verification.json'),JSON.stringify(result,null,2));await browser.close();}
})().catch(error=>{console.error(error);process.exit(1)});
