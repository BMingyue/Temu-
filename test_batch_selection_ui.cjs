const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {chromium}=require('./local_tools/dxm-uploader/_internal/playwright/driver/package');
const evidence=path.join(__dirname,'data/verification/20261029-batch-selection');
fs.mkdirSync(evidence,{recursive:true});
const shops=[{mall_id:'111',name:'测试甲店'},{mall_id:'222',name:'测试乙店'}];
const now=new Date().toISOString();
const alerts=Array.from({length:55},(_,i)=>({alertKey:'a'+i,spuId:String(1000+(i===1?0:i)),kind:'health',reasons:['测试原因'+i],cleared:false,activityNames:['测试活动'],acceleratorStatusLabel:'未开启'}));
let currentProductCount=45;
const products=(mall,count)=>Array.from({length:count},(_,i)=>({spuId:String(Number(mall)*100+i),categoryName:'测试类目',categorySourceLabel:'测试规则',saleStatusLabel:'在售',activityStatus:'none',activityStatusLabel:'无活动',activityNames:[],acceleratorSwitchStatus:i%2?'enabled':'disabled',acceleratorSwitchStatusLabel:i%2?'已开启':'未开启',accelerators:[],skuCount:0,skus:[],captured:now}));
const collectorProducts=Array.from({length:60},(_,i)=>({_mall_id:'111',_key:'p'+i,spuId:String(2000+Math.floor(i/2)),skcId:'s'+i,skuId:String(3000+i),skuCode:'货号'+i,declaredPrice:20,_captured:now}));
const rootState={products:[],scopes:[],entries:[],rules:{},coverage:{},catalog:[{spu:'9001',skc:'9101',title:'目录测试甲',shop:'测试甲店',site:'美国',category:'毛毯',status:'异常',variants:[{sku:'9201',issue:'待补资料',size:'40×50'}]},{spu:'9002',skc:'9102',title:'目录测试乙',shop:'测试乙店',site:'美国',category:'毛毯',status:'在售',variants:[]}],collections:[],traffic:[{product_id:'8001',title:'流量测试甲',shop:'测试甲店',site:'美国',date:'2026-10-29',impressions:10},{product_id:'8002',title:'流量测试乙',shop:'测试甲店',site:'美国',date:'2026-10-29',impressions:20},{product_id:'8001',title:'流量乙店',shop:'测试乙店',site:'美国',date:'2026-10-29',impressions:30}],traffic_captures:[]};
const activityRows=[{spuId:'5001',skcId:'5101',skuId:'5201',specification:'40×50',dailyPrice:20,precheck:{categoryMatched:true,status:'needs_adjustment',priceState:'needs_adjustment',priceStateLabel:'两档均不符',blockedReasons:[],pendingReasons:[]}},{spuId:'5001',skcId:'5101',skuId:'5202',specification:'50×60',dailyPrice:25,precheck:{categoryMatched:true,status:'needs_adjustment',priceState:'needs_adjustment',priceStateLabel:'两档均不符',blockedReasons:[],pendingReasons:[]}},{spuId:'5002',skcId:'5102',skuId:'5203',specification:'40×50',dailyPrice:20,precheck:{categoryMatched:true,status:'needs_adjustment',priceState:'needs_adjustment',priceStateLabel:'两档均不符',blockedReasons:[],pendingReasons:[]}}];
const result={at:now,mode:'isolated headless browser; all API reads mocked; all writes blocked',checks:[],writes:[],errors:[]};
(async()=>{
 const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 const page=await browser.newPage({viewport:{width:1500,height:1100},locale:'zh-CN'});
 page.setDefaultTimeout(20000);
 page.on('pageerror',error=>result.errors.push(error.message));
 await page.addInitScript(()=>{localStorage.setItem('workbench.quickstart.v20261029','seen'); window.__copied='';window.__copyFail=false;Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{if(window.__copyFail)throw Error('denied');window.__copied=text;}}});});
 await page.route('**/api/**',async route=>{
  const request=route.request(),u=new URL(request.url()),p=u.pathname;
  if(request.method()!=='GET'){result.writes.push(p);return route.abort('blockedbyclient');}
  let data={};
  if(p==='/api/state')data=rootState;
  else if(p==='/api/health')data={ok:true,version:'2026.10.29.1'};
  else if(p==='/api/collector/control')data={clients:{ui:{client_id:'ui',browser:'Chrome',mall_id:'111',store_name:'测试甲店',at:new Date().toISOString(),version:'0.20.11'}},commands:[]};
  else if(p==='/api/patrol/state')data={mallId:u.searchParams.get('mall_id'),generatedAt:now,health:{items:alerts,unclearedCount:55},trafficAttention:{items:alerts.slice(0,2),available:true,gap:''},window:{active:false,date:'2026-10-29',slot:'afternoon'},forceModal:false};
  else if(p==='/api/features/product-status'){const mall=u.searchParams.get('mall_id');data={mallId:mall,products:products(mall,currentProductCount),trash:products(mall,3),pending:products(mall,2),categoryConfig:{rules:[{name:'测试类目'}],revision:1},counts:{onSale:currentProductCount,notOnSale:3,unknown:2,skus:0,enrolled:0},sources:{products:{captured:now},activities:{captured:now},accelerators:{captured:now}}};}
  else if(p==='/api/collector/state')data={shops,records:{products:collectorProducts,orders:[{_mall_id:'111',_key:'o1',orderSn:'ORDER-1',skuId:'SKU-1',_captured:now}],returns:[{_mall_id:'111',_key:'r1',afterSalesSn:'RETURN-1',orderSn:'ORDER-2',productSkuId:'SKU-2',_captured:now}],flow:[],activities:[],shipping:[],ads:[]},receipts:[],counts:{products:60,orders:1,returns:1},record_limit:200};
  else if(p==='/api/sync-audit')data={items:[]};
  else if(p==='/api/daily')data={has_collector_receipt:true,today:'2026-10-29',counts:{pending:2},tasks:[{key:'t1',title:'待办甲',shop:'测试甲店',site:'美国',product_id:'6001',status:'pending',evidence:'待核对',action:'测试行动'},{key:'t2',title:'待办乙',shop:'测试乙店',site:'美国',product_id:'6002',status:'pending',evidence:'待核对',action:'测试行动'}],freshness:[]};
  else if(p==='/api/collector/daily-audit')data={latest:{_mall_id:u.searchParams.get('mall_id'),captured_at:now,status:'finished',steps:[],traffic:{},consultations:{},orders:{overdue_shipments:[{parent_order_sn:'P1',order_sn:'O1',elapsed_hours:80,actual_ship_time:now}],logistics_exceptions:[{parent_order_sn:'P2',order_sn:'O2',reason:'测试异常'}],cancelled_orders:[{parent_order_sn:'P3',order_sn:'O3',status:'已取消'}]}}};
  else if(p==='/api/patrol/traffic-compare')data={times:['12:00'],series:u.searchParams.get('dates').split(',').map(date=>({date,aligned:{metrics:{impressionCount:100,clickCount:20,orderPayOrderNum:5},captured_at:now},points:[{metrics:{impressionCount:100,clickCount:20,orderPayOrderNum:5}}]}))};
  else if(p==='/api/activity-jobs/state')data={shops,activity_settings:{category:'毛毯',size_prices:{}},default_config:{category:'毛毯',size_prices:{}},price_presets:[],active_preset:'毛毯',evidence:[{id:'ev1',mall_id:'111',campaign_id:'camp1',captured:now,payload:{campaign_name:'测试活动',evaluated_candidates:activityRows}}]};
  else if(p==='/api/activity-enrollment/state')data={batches:[],clients:[]};
  else if(p==='/api/features/zero-sales')data={safe:true,candidateCount:2,items:[{spuId:'7001',skcId:'7101',skuIds:['7201','7202'],skuCount:2,firstSeenLocal:'2026-10-01',reason:'测试无销量'},{spuId:'7002',skcId:'7102',skuIds:['7203'],skuCount:1,firstSeenLocal:'2026-10-01',reason:'测试无销量'}]};
  else if(p==='/api/features/promotion-audit')data={mallId:u.searchParams.get('mall_id'),pricePresetAvailable:false,issues:[{spuId:'7001',skcId:'7101',skuId:'7201',issue:'缺价格'}],activitySafetyPreview:[{spuId:'7001',skuId:'7201',status:'pending'}],acceleratorPreview:[{spuId:'7001',skuId:'7201',status:'pending',discountRate:0.75}]};
  return route.fulfill({json:data});
 });
 const group=name=>page.getByRole('group',{name:name+'批量选择',exact:true});
 const copyText=()=>page.evaluate(()=>window.__copied);
 const go=async(section,tool)=>{await page.getByRole('navigation',{name:'工作板块',exact:true}).getByRole('button',{name:section,exact:true}).click();await page.getByRole('navigation',{name:'板块工具',exact:true}).getByRole('button',{name:tool,exact:true}).click();};
 async function selectAll(label,total){const g=group(label);await g.getByRole('button',{name:`全选当前筛选（${total}）`,exact:true}).click();await g.getByText(`已选 ${total} / ${total} 条`,{exact:true}).waitFor();return g;}
 try{
  await page.goto('http://127.0.0.1:5173/?client_id=ui&mall_id=111&browser=Chrome',{waitUntil:'domcontentloaded',timeout:45000});
  await page.locator('.connection.connected').waitFor();
  let g=await selectAll('健康预警',55);assert.equal(await page.getByLabel('选择健康预警 SPU 1054',{exact:true}).count(),0);
  await g.getByRole('button',{name:'复制所选 SPU',exact:true}).click();assert.equal((await copyText()).split('\n').length,54);assert((await copyText()).includes('1054'));
  result.checks.push('巡店55条跨分页全选，复制54个去重SPU包含第2页');
  await g.getByRole('button',{name:'查看所选（55）',exact:true}).click();let dialog=page.getByRole('dialog',{name:'健康预警所选清单',exact:true});await dialog.waitFor();assert.equal(await dialog.locator('tbody tr').count(),55);
  await dialog.getByRole('button',{name:'复制所选表格',exact:true}).click();assert((await copyText()).startsWith('SPU\t原因\t状态'));await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
  await g.getByRole('button',{name:'清空选择',exact:true}).click();await page.getByLabel('选择健康预警 SPU 1002',{exact:true}).check();await g.getByRole('button',{name:'仅看所选',exact:true}).click();assert.equal(await page.getByLabel('选择健康预警 SPU 1000',{exact:true}).count(),0);
  result.checks.push('巡店所选预览55行、复制Excel表格、Escape关闭、仅看所选');
  await go('维护','商品状态');g=await selectAll('商品状态',45);await g.getByRole('button',{name:'复制所选 SPU',exact:true}).click();assert.equal((await copyText()).split('\n').length,45);
  await page.getByLabel('加速器状态筛选',{exact:true}).selectOption('enabled');await group('商品状态').getByText('已选 0 / 22 条',{exact:true}).waitFor();
  await page.getByLabel('加速器状态筛选',{exact:true}).selectOption('all');await group('商品状态').getByText('已选 0 / 45 条',{exact:true}).waitFor();
  await page.getByLabel('加速器状态筛选',{exact:true}).selectOption('enabled');await group('商品状态').getByText('已选 0 / 22 条',{exact:true}).waitFor();
  result.checks.push('筛选往返不会恢复旧选择，所选预览随范围重置');
  await selectAll('商品状态',22);await page.getByLabel('商品状态店铺',{exact:true}).selectOption('222');await group('商品状态').getByText('已选 0 / 22 条',{exact:true}).waitFor();await selectAll('商品状态',22);await group('商品状态').getByRole('button',{name:'复制所选 SPU',exact:true}).click();assert((await copyText()).split('\n').every(id=>Number(id)>=22200));
  await page.getByRole('button',{name:'垃圾堆 · 不在售 3',exact:true}).click();g=await selectAll('商品状态',3);await g.getByRole('button',{name:'复制所选 SPU',exact:true}).click();assert.equal((await copyText()).split('\n').length,3);
  result.checks.push('商品状态45条跨分页、筛选清选择、切店无串号、垃圾堆可复制');
  await page.getByRole('button',{name:'在售 45',exact:true}).click();await page.getByLabel('加速器状态筛选',{exact:true}).selectOption('all');await selectAll('商品状态',45);currentProductCount=44;await page.getByRole('button',{name:'刷新本地列表',exact:true}).click();await group('商品状态').getByText('已选 0 / 44 条',{exact:true}).waitFor();
  result.checks.push('刷新后清单ID范围改变立即清除旧选择');
  await go('维护','采集任务中心');await page.locator('.stats button').filter({hasText:'商品目录'}).click();g=await selectAll('商品目录',60);await g.getByRole('button',{name:'复制所选 SPU',exact:true}).click();assert.equal((await copyText()).split('\n').length,30);await g.getByRole('button',{name:'复制所选 SKU',exact:true}).click();assert.equal((await copyText()).split('\n').length,60);
  await page.getByLabel('选择扩展店铺',{exact:true}).selectOption('222');await group('商品目录').getByText('已选 0 / 0 条',{exact:true}).waitFor();await page.getByLabel('选择扩展店铺',{exact:true}).selectOption('111');await page.locator('.stats button').filter({hasText:'退货退款'}).click();g=await selectAll('退货退款',1);await g.getByRole('button',{name:'复制所选 订单号',exact:true}).click();assert.equal(await copyText(),'ORDER-2');
  result.checks.push('采集明细60行复制SPU/SKU去重、跨店排除、退货订单号复制');
  await go('维护','活动作业');g=await selectAll('活动核价',2);await g.getByRole('button',{name:'复制所选 SKU',exact:true}).click();assert.equal(await copyText(),'5201\n5202\n5203');await g.getByRole('button',{name:'复制所选 SPU',exact:true}).click();assert.equal(await copyText(),'5001\n5002');await page.getByLabel('搜索 SKU 或尺寸',{exact:true}).fill('5001');await group('活动核价').getByText('已选 0 / 1 条',{exact:true}).waitFor();
  result.checks.push('活动复制展开全部SKU并去重，筛选清选择，不触发报名');
  await go('巡店','日常巡检');g=await selectAll('今日待办',2);await g.getByRole('button',{name:'复制所选 SPU',exact:true}).click();assert.equal(await copyText(),'6001\n6002');await page.getByText('查看异常订单明细',{exact:true}).click();g=await selectAll('异常订单',3);await g.getByRole('button',{name:'复制所选 子订单号',exact:true}).click();assert.equal(await copyText(),'O1\nO2\nO3');g=await selectAll('流量对比',1);await g.getByRole('button',{name:'查看所选（1）',exact:true}).click();dialog=page.getByRole('dialog',{name:'流量对比所选清单',exact:true});await dialog.getByRole('button',{name:'复制所选表格',exact:true}).click();assert((await copyText()).includes('商品曝光量\t商品点击量\t支付订单数'));await page.keyboard.press('Escape');
  result.checks.push('每日待办SPU、3类异常订单批量复制、流量对比复制Excel');
  await go('维护','运营辅助');await page.getByRole('button',{name:'开始核查',exact:true}).click();g=await selectAll('零销量候选',2);await g.getByRole('button',{name:'复制所选 SKU',exact:true}).click();assert.equal(await copyText(),'7201\n7202\n7203');await page.getByRole('button',{name:'读取本地活动数据',exact:true}).click();await selectAll('活动数据问题',1);await page.getByLabel('运营辅助店铺',{exact:true}).selectOption('222');assert.equal(await group('零销量候选').count(),0);assert.equal(await group('活动数据问题').count(),0);
  result.checks.push('零销量SKU展开复制、活动问题批量选择、切店隐藏旧分析');
  await go('维护','辅助与设置');await page.getByRole('button',{name:'历史商品目录',exact:true}).click();g=await selectAll('商品目录',2);await g.getByRole('button',{name:'复制所选 SPU',exact:true}).click();assert.equal(await copyText(),'9001\n9002');await page.getByLabel('搜索店铺商品状态',{exact:true}).fill('目录测试甲');await group('商品目录').getByText('已选 0 / 1 条',{exact:true}).waitFor();await selectAll('商品目录',1);await page.evaluate(()=>window.__copyFail=true);await group('商品目录').getByRole('button',{name:'复制所选 SPU',exact:true}).click();dialog=page.getByRole('dialog',{name:'商品目录所选清单',exact:true});await dialog.waitFor();assert.equal(await dialog.getByLabel('商品目录所选编号',{exact:true}).inputValue(),'9001');await page.keyboard.press('Escape');await page.evaluate(()=>window.__copyFail=false);
  result.checks.push('历史目录复制/搜索复位，剪贴板拒绝后显示手动复制清单');
  await go('维护','辅助与设置');await page.getByRole('button',{name:'历史页面快照',exact:true}).click();g=await selectAll('商品流量',2);await g.getByRole('button',{name:'复制所选 SPU',exact:true}).click();assert.equal(await copyText(),'8002\n8001');await page.getByLabel('流量店铺',{exact:true}).selectOption('测试乙店 · 美国');await group('商品流量').getByText('已选 0 / 1 条',{exact:true}).waitFor();
  result.checks.push('历史流量复制依当前排序、切店清选择');
  assert.equal(result.writes.length,0);assert.equal(result.errors.length,0);await page.screenshot({path:path.join(evidence,'history-flow.png'),fullPage:false});
  await go('维护','商品状态');await selectAll('商品状态',44);await page.screenshot({path:path.join(evidence,'product-status.png'),fullPage:false});
  await go('巡店','巡店预警');await selectAll('健康预警',55);await page.screenshot({path:path.join(evidence,'patrol.png'),fullPage:false});result.passed=true;
 }catch(error){result.passed=false;result.error=error.stack;await page.screenshot({path:path.join(evidence,'failure.png')}).catch(()=>{});throw error;}
 finally{fs.writeFileSync(path.join(evidence,'ui-verification.json'),JSON.stringify(result,null,2));await browser.close();}
})().catch(error=>{console.error(error);process.exit(1)});
