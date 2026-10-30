const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');
const {chromium}=require('./local_tools/dxm-uploader/_internal/playwright/driver/package');
const evidence=path.join(__dirname,'data/verification/20261029-browser-manager-ui');fs.mkdirSync(evidence,{recursive:true});
const oldProfiles=[{id:'chrome-a',label:'Chrome-A',browser:'chrome',worker_id:'old-worker',available:true,include_in_all:true},{id:'firefox-a',label:'Firefox-A',browser:'firefox',available:true,include_in_all:true},{id:'edge-legacy',label:'Edge 旧配置',browser:'edge',available:true,include_in_all:false}];
const newProfiles=[1,2].map(i=>({id:'chrome-ui-'+i,label:'测试窗口 '+i,browser:'chrome',worker_id:'ui-worker-'+i,available:true,include_in_all:true,managed:true,extension_auto_load:true,extension_version:'0.4.6'}));
let profiles=[...oldProfiles],available=true,failSecond=true;
const result={at:new Date().toISOString(),mode:'isolated headless browser; all writes intercepted',checks:[],requests:[],unexpected_writes:[],page_errors:[]};
(async()=>{
 const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 const page=await browser.newPage({viewport:{width:1440,height:1100},locale:'zh-CN'});page.setDefaultTimeout(15000);page.on('pageerror',e=>result.page_errors.push(e.message));
 try{
  await page.route('**/api/**',async route=>{
   const req=route.request(),url=new URL(req.url());
   if(req.method()==='GET'){
    if(url.pathname==='/api/gpt-extension')return route.fulfill({json:{workers:[{browser:'chrome',worker_id:'old-worker',online:true,status:'已连接',message:'可领取任务',metrics:{claimed:2,completed:1},last_seen:'2026-10-29T02:00:00Z'}],browser_profiles:profiles,browser_creation:{available,max_per_request:20,message:available?'':'本机未找到支持插件自动加载的Chrome'}}});
    if(url.pathname==='/api/image-jobs')return route.fulfill({json:{jobs:[],summary:{total_jobs:0}}});
    return route.continue();
   }
   const body=req.postDataJSON();result.requests.push({path:url.pathname,body,header:req.headers()['x-workbench']});
   if(url.pathname==='/api/gpt-browser-profiles/create'){
    profiles=[...oldProfiles,...newProfiles];return route.fulfill({json:{ok:true,created:newProfiles,browser_profiles:profiles,message:'已创建'}});
   }
   if(url.pathname==='/api/gpt-browser-profiles/open'){
    if(body.profile_id==='chrome-ui-2'&&failSecond)return route.fulfill({status:400,json:{error:'模拟该配置启动失败'}});
    if(body.profile_id==='chrome-all')return route.fulfill({json:{ok:true,results:[{id:'chrome-a',ok:true,message:'Chrome-A 已打开'},{id:'chrome-ui-1',ok:true,message:'测试窗口 1 已打开'},{id:'chrome-ui-2',ok:false,message:'测试窗口 2 模拟打开失败'}]}});
    return route.fulfill({json:{ok:true,id:body.profile_id,message:body.profile_id+' 已请求打开'}});
   }
   result.unexpected_writes.push({path:url.pathname,body});return route.abort('blockedbyclient');
  });
  await page.goto('http://127.0.0.1:5173/',{waitUntil:'domcontentloaded',timeout:45000});
  await page.locator('.connection.connected').waitFor();await page.getByRole('button',{name:'上新',exact:true}).click();await page.getByRole('button',{name:'GPT 批量生图',exact:true}).click();
  const panel=page.getByRole('region',{name:'生图浏览器管理',exact:true});await panel.waitFor();
  const create=panel.getByRole('button',{name:'新增并打开 Chrome',exact:true});
  assert.equal(await panel.getByRole('button',{name:'打开 Chrome-A',exact:true}).count(),1);
  await panel.getByText('其他已有浏览器（Edge / Firefox）',{exact:true}).click();
  assert.equal(await panel.getByRole('button',{name:'打开 Firefox-A',exact:true}).count(),1);
  assert.equal(await panel.getByRole('button',{name:'打开 Edge 旧配置',exact:true}).count(),1);
  result.checks.push('保留原Chrome与折叠Edge/Firefox入口，显示旧worker连接状态');
  const count=panel.getByLabel('新增浏览器数量',{exact:true});
  for(const value of ['0','21','1.5','']){
   await count.fill(value);await create.click();
   assert((await panel.getByRole('alert').innerText()).includes('每次可新增 1–20'));
   assert.equal(result.requests.length,0);
  }
  result.checks.push('空值、0、21、小数被拦截，不发送创建请求');
  await panel.getByLabel('窗口名称前缀',{exact:true}).fill('  测试窗口  ');await count.fill('2');await create.click();
  await panel.getByText('测试窗口 2：模拟该配置启动失败',{exact:false}).waitFor();
  assert.deepEqual(result.requests.map(r=>r.path),['/api/gpt-browser-profiles/create','/api/gpt-browser-profiles/open','/api/gpt-browser-profiles/open']);
  assert.deepEqual(result.requests[0].body,{count:2,label_prefix:'测试窗口'});
  assert.deepEqual(result.requests.slice(1).map(r=>r.body.profile_id),['chrome-ui-1','chrome-ui-2']);
  assert(result.requests.every(r=>r.header==='local'));
  assert((await panel.locator('output').innerText()).includes('chrome-ui-1 已请求打开'));
  assert((await panel.getByRole('alert').innerText()).includes('模拟该配置启动失败'));
  assert.equal(await panel.getByRole('button',{name:'打开 测试窗口 1',exact:true}).count(),1);
  assert.equal(await panel.getByRole('button',{name:'打开 测试窗口 2',exact:true}).count(),1);
  result.checks.push('按count创建，去除名称前后空白，按返回id逐个打开并分别显示成功/失败');
  assert.equal(await panel.getByRole('button',{name:'打开 Chrome-A',exact:true}).count(),1);
  assert.equal(await panel.getByRole('button',{name:'打开 Firefox-A',exact:true}).count(),1);
  result.checks.push('新增后原配置入口仍保留，新配置标注插件自动加载版本');
  assert((await panel.innerText()).includes('插件随启动自动加载 · v0.4.6'));
  await panel.getByRole('button',{name:'打开全部 3 个 Chrome',exact:true}).click();
  await panel.getByText('测试窗口 2 模拟打开失败',{exact:false}).waitFor();
  assert.deepEqual(result.requests.at(-1).body,{profile_id:'chrome-all'});
  assert((await panel.locator('output').innerText()).includes('Chrome-A 已打开'));
  assert((await panel.getByRole('alert').innerText()).includes('测试窗口 2 模拟打开失败'));
  result.checks.push('全部Chrome发送chrome-all，部分失败独立告警');
  failSecond=false;
  await panel.getByRole('button',{name:'打开 测试窗口 2',exact:true}).click();
  await panel.getByText('chrome-ui-2 已请求打开',{exact:true}).waitFor();
  assert.deepEqual(result.requests.at(-1).body,{profile_id:'chrome-ui-2'});
  assert.equal(await panel.getByRole('alert').count(),0);
  result.checks.push('单独重开失败配置，成功后清除旧告警');
  await panel.screenshot({path:path.join(evidence,'browser-manager.png')});
  available=false;await page.waitForTimeout(3200);
  assert(await create.isDisabled());assert((await panel.innerText()).includes('本机未找到支持插件自动加载的Chrome'));
  result.checks.push('本机不支持自动加载时禁用创建并展示原因');
  assert.equal(result.unexpected_writes.length,0);assert.equal(result.page_errors.length,0);result.passed=true;
 }catch(e){result.passed=false;result.error=e.stack;await page.screenshot({path:path.join(evidence,'failure.png')}).catch(()=>{});throw e}
 finally{fs.writeFileSync(path.join(evidence,'ui-verification.json'),JSON.stringify(result,null,2));await browser.close()}
})().catch(e=>{console.error(e);process.exit(1)});
