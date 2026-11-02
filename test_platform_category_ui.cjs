const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {chromium}=require('./local_tools/dxm-uploader/_internal/playwright/driver/package');
const workbenchVersion=JSON.parse(fs.readFileSync(path.join(__dirname,'workbench-release.json'),'utf8')).version;
const evidence=path.resolve(process.env.WORKBENCH_TEST_EVIDENCE_DIR||path.join(__dirname,'data/verification/20261101-platform-category-ui'));
fs.mkdirSync(evidence,{recursive:true});
const now=new Date().toISOString();
const result={at:now,mode:'isolated headless browser; all APIs mocked; real writes blocked',checks:[],writes:[],errors:[]};
const rule={name:'毛毯',platformCategoryIds:['403'],platformCategoryNames:['毛毯'],specifications:[],codeKeywords:[],minMatches:1,tolerance:2,allowUnmatched:false};
const shops=[{mall_id:'111',name:'类目测试甲店'},{mall_id:'222',name:'类目测试乙店'}];
const product=(spu,patch={})=>({spuId:spu,categoryName:'未分类',categorySourceLabel:'平台类目',saleStatusLabel:'在售',activityStatus:'none',activityStatusLabel:'当前无生效活动',activityNames:[],acceleratorSwitchStatus:'unknown',acceleratorSwitchStatusLabel:'待确认',accelerators:[],skuCount:1,skus:[{skcId:spu+'1',skuId:spu+'2',specification:'M',declaredPrice:30,activities:[]}],freshness:{captured:now,stale:false},...patch});
let legacy=false,revision=1;
const products=mall=>mall==='222'?[product('22201',{categoryName:'乙店类目',platformCategoryName:'乙店平台类目',platformCategoryId:'880'})]:legacy?[product('11101',{categoryName:'旧规则类目'}),product('11104')]:[
 product('11101',{categoryName:'男T恤',categorySourceLabel:'平台类目映射',platformCategoryId:'103',platformCategoryName:'T恤',platformCategoryPath:['服装','男士','T恤'],platformCategoryIds:['101','102','103'],activityStatus:'enrolled',activityStatusLabel:'已报名',activityNames:['男装活动']}),
 product('11102',{categoryName:'女T恤',platformCategoryId:'203',platformCategoryName:'T恤',platformCategoryPath:['服装','女士','T恤'],platformCategoryIds:['101','202','203']}),
 product('11103',{categoryName:'毛毯',platformCategoryId:'403',platformCategoryName:'毛毯',platformCategoryPath:['家居','软装','毛毯'],platformCategoryIds:['401','402','403']}),
 product('11104',{categoryName:'T恤',categorySourceLabel:'货号规则'}),
 product('11105',{platformCategoryConflict:true,categorySourceLabel:'平台类目冲突',activityStatus:'unknown',activityStatusLabel:'活动待确认'}),
 product('11106',{categoryName:'单叶类目',platformCategoryId:'909',platformCategoryName:'单叶类目'})
];
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.WORKBENCH_TEST_CHROME||path.join(__dirname,'runtime/gpt-chrome/chrome-win64/chrome.exe'),headless:true});
 const page=await browser.newPage({viewport:{width:1540,height:1100},locale:'zh-CN'});
 page.setDefaultTimeout(15000);page.on('pageerror',error=>result.errors.push(error.message));
 await page.addInitScript(()=>{localStorage.setItem('workbench.quickstart.v20261029','seen');window.__copied='';Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.__copied=text;}}});});
 await page.route('**/api/**',async route=>{
  const req=route.request(),url=new URL(req.url()),p=url.pathname;
  if(req.method()!=='GET'){
   result.writes.push({path:p,body:req.postDataJSON()});
   if(p==='/api/features/product-rules'){revision++;return route.fulfill({json:{success:true}});}
   return route.abort('blockedbyclient');
  }
  let data={};
  if(p==='/api/state')data={products:[],scopes:[],entries:[],rules:{},coverage:{},catalog:[],collections:[],traffic:[],traffic_captures:[]};
  else if(p==='/api/health')data={ok:true,version:workbenchVersion};
  else if(p==='/api/collector/control')data={clients:{ui:{client_id:'ui',browser:'Chrome',mall_id:'111',store_name:'类目测试甲店',at:now,version:'0.20.12'}},commands:[]};
  else if(p==='/api/collector/state')data={shops,records:{},receipts:[],counts:{}};
  else if(p==='/api/patrol/state')data={mallId:url.searchParams.get('mall_id'),health:{items:[],unclearedCount:0},trafficAttention:{items:[],available:true},window:{active:false},forceModal:false};
  else if(p==='/api/features/product-status'){
   const mall=url.searchParams.get('mall_id'),rows=products(mall);
   data={mallId:mall,products:rows,trash:[],pending:[],categoryConfig:{rules:[rule],revision},counts:{onSale:rows.length,notOnSale:0,unknown:0,skus:rows.length,enrolled:rows.filter(row=>row.activityStatus==='enrolled').length},sources:{products:{captured:now,stale:false},activities:{captured:now,stale:false},accelerators:{captured:now}}};
  }
  return route.fulfill({json:data});
 });
 const tableRows=()=>page.locator('tr[data-spu-id]');
 const shown=async()=>await tableRows().evaluateAll(rows=>rows.map(row=>row.getAttribute('data-spu-id')));
 const platform=()=>page.getByLabel('平台类目筛选',{exact:true});
 const group=()=>page.getByRole('group',{name:'商品状态批量选择',exact:true});
 try{
  await page.goto('http://127.0.0.1:5173/?client_id=ui&mall_id=111&browser=Chrome',{waitUntil:'domcontentloaded',timeout:45000});
  await page.locator('.connection.connected').waitFor();
  await page.getByRole('navigation',{name:'工作板块',exact:true}).getByRole('button',{name:'维护',exact:true}).click();
  await page.getByRole('navigation',{name:'板块工具',exact:true}).getByRole('button',{name:'商品状态',exact:true}).click();
  await page.getByLabel('平台类目采集覆盖',{exact:true}).filter({hasText:'4 / 6'}).waitFor();
  assert((await page.getByLabel('平台类目采集覆盖',{exact:true}).innerText()).includes('待采集 1 · 冲突待核对 1'));
  assert.equal(await tableRows().count(),6);
  assert((await tableRows().filter({has:page.getByText('11101',{exact:true})}).innerText()).includes('服装 > 男士 > T恤'));
  result.checks.push('平台类目覆盖显示4已采集/1缺失/1冲突，逐商品完整路径及ID可见');
  await platform().selectOption('id:101');
  assert.deepEqual(await shown(),['11101','11102']);
  assert((await page.getByLabel('筛选商品报名情况',{exact:true}).innerText()).includes('有报名 1 · 当前无生效活动 1 · 待确认 0'));
  await page.screenshot({path:path.join(evidence,'platform-parent-category.png'),fullPage:true});
  result.checks.push('选择平台父类目覆盖子类目并核对对应商品报名数');
  await group().getByRole('button',{name:'全选当前筛选（2）',exact:true}).click();
  await platform().selectOption('id:203');
  assert.deepEqual(await shown(),['11102']);
  await group().getByText('已选 0 / 1 条',{exact:true}).waitFor();
  assert((await platform().locator('option[value="id:103"]').innerText()).includes('服装 > 男士 > T恤'));
  assert((await platform().locator('option[value="id:203"]').innerText()).includes('服装 > 女士 > T恤'));
  result.checks.push('同名叶子依官方ID和完整路径区分；改变平台类目清空跨类选择');
  await platform().selectOption('missing');assert.deepEqual(await shown(),['11104']);
  await platform().selectOption('conflict');assert.deepEqual(await shown(),['11105']);
  await platform().selectOption('id:909');assert.deepEqual(await shown(),['11106']);
  await page.getByRole('button',{name:'清除筛选',exact:true}).click();
  await page.getByLabel('搜索商品状态',{exact:true}).fill('家居');assert.deepEqual(await shown(),['11103']);
  await group().getByRole('button',{name:'全选当前筛选（1）',exact:true}).click();
  await group().getByRole('button',{name:'查看所选（1）',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'商品状态所选清单',exact:true});
  await dialog.getByRole('button',{name:'复制所选表格',exact:true}).click();
  const copied=await page.evaluate(()=>window.__copied);assert(copied.includes('平台类目\t平台类目ID\t归类依据'));assert(copied.includes('家居 > 软装 > 毛毯\t403'));
  await page.keyboard.press('Escape');
  result.checks.push('缺失、冲突、仅叶子ID均可筛选；搜索与导出包含平台完整类目');
  await page.getByRole('button',{name:'清除筛选',exact:true}).click();
  await page.getByRole('button',{name:'维护类目与规格',exact:true}).click();
  await page.getByLabel('平台类目ID 0',{exact:true}).fill('403\n404');
  await page.getByLabel('平台类目名称 0',{exact:true}).fill('毛毯\n家居 > 软装 > 毛毯');
  await page.getByRole('button',{name:'保存并重新匹配',exact:true}).click();
  await page.getByRole('button',{name:'关闭设置',exact:true}).waitFor({state:'hidden'});
  assert.equal(result.writes.length,1);assert.equal(result.writes[0].path,'/api/features/product-rules');
  assert.deepEqual(result.writes[0].body.rules[0].platformCategoryIds,['403','404']);
  assert.deepEqual(result.writes[0].body.rules[0].platformCategoryNames,['毛毯','家居 > 软装 > 毛毯']);
  assert.deepEqual(result.writes[0].body.rules[0].specifications,[]);
  result.checks.push('平台类目映射可单独维护，无规格规则时仍发送完整精确映射字段（仅mock写入）');
  await platform().selectOption('id:101');
  await page.getByLabel('商品状态店铺',{exact:true}).selectOption('222');
  await tableRows().filter({has:page.getByText('22201',{exact:true})}).waitFor();
  assert.equal(await platform().inputValue(),'');assert.equal(await platform().locator('option[value="id:101"]').count(),0);
  result.checks.push('切店清除官方类目筛选且不遗留前一店类目选项');
  legacy=true;await page.getByLabel('商品状态店铺',{exact:true}).selectOption('111');
  await page.getByLabel('平台类目采集覆盖',{exact:true}).filter({hasText:'0 / 2'}).waitFor();
  assert.equal(await tableRows().count(),2);await platform().selectOption('missing');assert.deepEqual(await shown(),['11101','11104']);
  assert.equal(result.errors.length,0);assert.equal(result.writes.length,1);
  result.checks.push('历史快照缺全部平台字段时保留商品，覆盖提示0/2并支持待采集筛选');
  await page.screenshot({path:path.join(evidence,'legacy-missing.png'),fullPage:false});
  result.passed=true;
 }catch(error){result.passed=false;result.error=error.stack;await page.screenshot({path:path.join(evidence,'failure.png')}).catch(()=>{});throw error;}
 finally{fs.writeFileSync(path.join(evidence,'ui-verification.json'),JSON.stringify(result,null,2));await browser.close();}
})().catch(error=>{console.error(error);process.exit(1)});
