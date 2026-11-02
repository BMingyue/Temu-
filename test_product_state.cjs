const assert = require('node:assert/strict');
const {test} = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const parserContext={module:{exports:{}}};
vm.runInNewContext(fs.readFileSync('./browser_extension/product-state-evidence.js','utf8'),parserContext);
const {parse}=parserContext.module.exports;
const row = text => 'SPU ID: 54242718442 经营站点：美国站 ' + text;

test('explicit accelerator labels are distinct from eligibility and Max', () => {
  assert.equal(parse(row('流量加速中 商品持续推广中')).status,'enabled');
  assert.equal(parse(row('开启流量加速器（Max模式）机会 立即开启')).status,'max_eligible');
  assert.equal(parse(row('流量加速器待开启')).status,'eligible');
  assert.equal(parse(row('流量加速器已关闭')).status,'disabled');
  assert.equal(parse(row('商品流量待关注 查看流量加速效果')).status,'unknown');
});
test('row identity/site are required and multiple SPUs are rejected', () => {
  assert.equal(parse('SPU ID: 54242718442 流量加速中'),null);
  assert.equal(parse(row('SPU ID: 12345678 流量加速中')),null);
  assert.equal(parse('SPU ID: 54242718442 流量加速中','美国站').siteName,'美国站');
});
test('generic activity and supplier prices never become accelerator prices', () => {
  assert.equal(parse(row('流量加速中 日常价 ¥80 活动价 ¥60')).price,null);
  assert.equal(parse(row('流量加速中 加速器价格 80')).price,null);
});
test('explicit price preserves currency and SKU and does not discount', () => {
  const item=parse(row('流量加速中 SKU ID: 123456789 加速器价格：¥73.42'));
  assert.equal(item.price,73.42);assert.equal(item.currency,'CNY');
  assert.equal(item.skuId,'123456789');assert.equal(item.priceKind,'current');
  const offer=parse(row('流量加速器待开启 加速器价格：$12.34'));
  assert.equal(offer.currency,'USD');assert.equal(offer.priceKind,'offer');
});
test('price ranges and several variant quotes are not collapsed into one price', () => {
  assert.equal(parse(row('流量加速中 加速器价格：¥70.00～80.00')).price,null);
  assert.equal(parse(row('流量加速中 加速器价格：¥70.00 加速器价格：¥80.00')).price,null);
  assert.equal(parse(row('流量加速中 SKU ID: 123456789 SKU ID: 987654321 加速器价格：¥80.00')).price,null);
  assert.equal(parse(row('流量加速中 流量加速器待开启 加速器价格：¥80.00')).price,null);
});
test('contradictory explicit labels stay unknown', () => {
  assert.equal(parse(row('流量加速中 流量加速器待开启')).status,'unknown');
});

const bridge=fs.readFileSync('./browser_extension/page-bridge.js','utf8');
function pageBridge(responses) {
  const values=[...responses];
  const requests=[];
  const context={requests,post:async(url,body)=>{requests.push({url,body});return values.shift()},progress:()=>{},sleep:async()=>{},networkSpec:sku=>sku.specification||''};
  vm.createContext(context);
  const body=bridge.slice(bridge.indexOf('  function productRowsFromPayload'),bridge.indexOf('  const cleanShopName'));
  vm.runInContext(body+';globalThis.products=products;globalThis.activities=activities;',context);
  return context;
}
test('failed or structurally unknown product responses never clear the catalog',async()=>{
  for(const result of [{success:false,errorMsg:'expired'},{success:true,result:{total:0}},{success:true,result:{list:[],total:5}}]){
    const p=pageBridge([result]);
    await assert.rejects(p.products({capturedMallId:'123'}));
  }
});
test('explicit empty product catalog is valid while null prices stay missing',async()=>{
  const p=pageBridge([{success:true,result:{list:[],total:0}}]);
  assert.equal((await p.products({capturedMallId:'123'})).complete,true);
  const q=pageBridge([{success:true,result:{list:[{productId:'100001',productSkcId:'200001',productSkuSummaries:[{productSkuId:'300001',supplierPrice:null}]}],total:1}}]);
  const result=await q.products({capturedMallId:'123'});
  assert.equal(result.rows[0].declaredPrice,null);assert.equal(result.rows[0].onSale,true);
});
test('enrollment response must explicitly confirm success and list structure',async()=>{
  const p=pageBridge([{success:false,result:{list:[],total:0}}]);
  await assert.rejects(p.activities({capturedMallId:'123'}));
  const q=pageBridge([{success:true,result:{list:[],total:0}}]);
  assert.equal((await q.activities({capturedMallId:'123'})).complete,true);
});

const source=fs.readFileSync('./browser_extension/product-status-sync.js','utf8');
function harness(options={}) {
  let state={enabled:true,scopes:{},...options.state};
  const tabs=new Map([[1,{id:1,url:'https://agentseller-us.temu.com/main/flux-analysis',status:'complete'}]]);
  const saved=[],closed=[],created=[];
  let switched=false;
  const context={
    URL,Date,crypto:require('node:crypto').webcrypto,setTimeout,
    wbAutoRunning:false,
    wbSellerUrl:url=>/^https:\/\/agentseller(?:-us)?\.temu\.com\//.test(url||''),
    wbSellerIdentity:async()=>({current_mall_id:switched?'999':'123',store_name:'shop'}),
    wbAutoRead:async()=>structuredClone(state),
    wbAutoWrite:async patch=>{state={...state,...patch};},
    wbEnqueue:async item=>saved.push(item),wbFlush:async()=>({pending:options.pending||0}),
    wbAutoCall:async(id,command)=>{
      if(command==='VERIFY_SELLER_SHOP')return {matches:!switched};
      if(command==='PRODUCTS'&&options.failProducts)throw Error('商品接口暂不可用');
      if(options.switchOnResult)switched=true;
      return {success:true,sourceMallId:options.wrongHeader?'999':'123',
        complete:!options.partial,total:1,collectedSkcs:1,enrollmentCount:1,pageSize:100,pages:1,
        ...(command==='PRODUCTS' ? {categoryCoverage:options.categoryCoverage,categoryDiagnostics:options.categoryDiagnostics,categoryTaxonomies:options.categoryTaxonomies} : {}),
        rows:command==='PRODUCTS'?[{spuId:'100001',skcId:'200001',skuId:'300001',onSale:true}]:[{enrollId:'400001',spuId:'100001',skcId:'200001',skuId:'300001'}]};
    },
    chrome:{
      storage:{local:{get:async()=>({'temuCollectorState.v2':options.manual||{status:'done'}})}},
      tabs:{
        create:async item=>{const tab={...item,id:2,status:'complete'};tabs.set(2,tab);created.push(tab);return tab;},
        get:async id=>tabs.get(id),
        update:async(id,item)=>{const tab={...tabs.get(id),...item,status:'complete'};tabs.set(id,tab);return tab;},
        sendMessage:async()=>({success:true,current_mall_id:'123'}),
        remove:async id=>{closed.push(id);tabs.delete(id);}
      }
    }
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync('./browser_extension/workbench-auto.js','utf8').split('\n').find(line=>line.startsWith('const wbManualTaskBusy=')),context);
  vm.runInContext(source+';globalThis.runTick=wbProductStatusTick;',context);
  return {context,saved,closed,created,read:()=>state,sourceTab:tabs.get(1)};
}
test('automatic collection uses own inactive tab and stores both complete datasets',async()=>{
  const h=harness();await h.context.runTick(h.sourceTab);
  assert.equal(h.created.length,1);assert.equal(h.created[0].active,false);
  assert.equal(h.saved.length,2);assert.equal(h.saved[0].body.mall_id,'123');
  assert.equal(h.saved[0].body.crawl_result.sale_scope,'on_sale');
  assert.equal(h.saved[1].path,'/api/client/products/activities/upload');
  assert.deepEqual(h.closed,[2]);assert.equal(h.context.wbAutoRunning,false);
  assert.ok(h.read().productFinishedAt);
});
test('product sync persists independent taxonomy evidence and exposes category coverage in its summary',async()=>{
  const categoryDiagnostics={parser:'temu_leaf_cat_v1',productCount:1,sourceCounts:{temu_product_catalog:1},fieldNames:['leafCat.catId']};
  const categoryTaxonomies=[{leafCat:{catId:'11',catName:'男T恤'},categories:{cat1:{catId:1,catName:'服装'}}}];
  const categoryCoverage={skuCount:1,classifiedSkus:1,missingSkus:0,conflictSkus:0};
  const h=harness({categoryCoverage,categoryDiagnostics,categoryTaxonomies});await h.context.runTick(h.sourceTab,true,'123');
  const meta=h.saved[0].body.crawl_result;
  assert.equal(meta.category_diagnostics.parser,'temu_leaf_cat_v1');
  assert.deepEqual(JSON.parse(JSON.stringify(meta.category_taxonomies)),categoryTaxonomies);
  assert.deepEqual(JSON.parse(JSON.stringify(meta.category_coverage)),categoryCoverage);
  assert.equal(meta.complete,true);assert.match(h.read().message,/平台类目 1\/1 个 SKU/);
  assert.doesNotMatch(h.read().message,/类目待补采/);
});
test('zero category coverage does not invalidate the catalog but is explicit in synchronization results',async()=>{
  const h=harness({categoryCoverage:{skuCount:1,classifiedSkus:0,missingSkus:1,conflictSkus:0}});
  await h.context.runTick(h.sourceTab,true,'123');
  assert.equal(h.saved.length,2);assert.equal(h.saved[0].body.crawl_result.complete,true);
  assert.ok(h.read().productFinishedAt);assert.match(h.read().message,/平台类目 0\/1 个 SKU（类目待补采）/);
});
test('changed shop prevents upload and cleans up own tab',async()=>{
  const h=harness({switchOnResult:true});await h.context.runTick(h.sourceTab);
  assert.equal(h.saved.length,0);assert.match(h.read().productError,/店铺/);
  assert.deepEqual(h.closed,[2]);
});
test('captured mall header mismatch prevents upload',async()=>{
  const h=harness({wrongHeader:true});await h.context.runTick(h.sourceTab);
  assert.equal(h.saved.length,0);assert.match(h.read().productError,/mallid/);
});
test('incomplete pagination never publishes an absence snapshot',async()=>{
  const h=harness({partial:true});await h.context.runTick(h.sourceTab);
  assert.equal(h.saved.length,0);assert.match(h.read().productError,/分页/);
});
test('automatic collection respects pause and existing manual task',async()=>{
  for(const status of ['running','paused']){
    const h=harness({manual:{status}});await h.context.runTick(h.sourceTab);
    assert.equal(h.created.length,0);assert.equal(h.saved.length,0);
  }
  const h=harness({state:{enabled:false}});await h.context.runTick(h.sourceTab);
  assert.equal(h.created.length,0);
});
test('wrong requested store cannot start collection',async()=>{
  const h=harness();await h.context.runTick(h.sourceTab,true,'999');
  assert.equal(h.created.length,0);assert.equal(h.saved.length,0);
});
test('stopped resumable manual task no longer blocks automatic or requested product sync',async()=>{
  for(const force of [false,true]){
    const manual={status:'paused',endedAt:Date.now(),phase:'products',message:'任务已停止'};
    const h=harness({manual});await h.context.runTick(h.sourceTab,force,'123');
    assert.equal(h.saved.length,2);assert.equal(h.read().productError,'');
    assert.equal(manual.status,'paused');
  }
});
test('product failure still collects registration log with explicit partial result',async()=>{
  const h=harness({failProducts:true});await h.context.runTick(h.sourceTab,true,'123');
  assert.equal(h.saved.length,1);assert.equal(h.saved[0].path,'/api/client/products/activities/upload');
  assert.match(h.saved[0].body.crawl_result.source_url,/\/activity\/marketing-activity\/log$/);
  assert.equal(h.saved[0].body.crawl_result.enrollment_scope,'all');
  assert.match(h.read().productError,/商品接口暂不可用/);
  assert.match(h.read().productError,/报名记录 1 条/);
  assert.equal(h.read().productFinishedAt,undefined);
});
test('pending outbox does not report fresh synchronized product snapshots',async()=>{
  const h=harness({pending:1});await h.context.runTick(h.sourceTab,true,'123');
  assert.equal(h.saved.length,2);assert.match(h.read().productError,/待补传/);
  assert.equal(h.read().productFinishedAt,undefined);
});
const enrollment=(id,patch={})=>({
  enrollId:String(id),productId:'100001',sessionStatus:2,
  skcList:[{skcId:'200001',skuList:[{skuId:'300001',dailyPrice:8000,activityPrice:6000}]}],
  ...patch
});
test('registration log reads all pages without active-only filter and preserves exited records',async()=>{
  const p=pageBridge([
    {success:true,result:{list:[enrollment(1),enrollment(2,{cancelApplyInfo:{reviewStatus:3}})],total:3}},
    {success:true,result:{list:[enrollment(3,{sessionStatus:1})],total:3}}
  ]);
  const result=await p.activities({capturedMallId:'123',pageSize:2});
  assert.equal(result.complete,true);assert.equal(result.enrollmentCount,3);assert.equal(result.rows.length,3);
  assert.equal(result.rows.find(row=>row.enrollId==='2').statusKey,'cancelled');
  assert.equal(result.rows.find(row=>row.enrollId==='3').statusKey,'unknown');
  assert.equal(result.rows[0].dailyPrice,80);assert.equal(result.rows[0].activityPrice,60);
  assert.equal(p.requests.length,2);
  assert.ok(p.requests.every(req=>req.url==='/api/kiana/gamblers/marketing/enroll/list'&&!('sessionStatus' in req.body)));
  assert.equal(p.requests[1].body.pageNo,2);
});
test('duplicate pages, missing SKU details and null totals do not replace complete enrollment snapshot',async()=>{
  for(const payload of [
    {success:true,result:{list:[enrollment(1),enrollment(1)],total:2}},
    {success:true,result:{list:[enrollment(1,{skcList:[]})],total:1}},
    {success:true,result:{list:[],total:null}}
  ])await assert.rejects(pageBridge([payload]).activities({capturedMallId:'123'}));
});
test('missing registration prices remain null rather than zero',async()=>{
  const item=enrollment(1,{skcList:[{skcId:'200001',skuList:[{skuId:'300001',dailyPrice:null,activityPrice:null}]}]});
  const result=await pageBridge([{success:true,result:{list:[item],total:1}}]).activities({capturedMallId:'123'});
  assert.equal(result.rows[0].dailyPrice,null);assert.equal(result.rows[0].activityPrice,null);
});
test('recurring product collection waits two hours while manual refresh bypasses the interval',async()=>{
  const key='agentseller-us.temu.com:123';
  for(const minutes of [5,60,119]){
    const h=harness({state:{scopes:{[key]:{productUpdatedAt:Date.now()-minutes*60000}}}});
    await h.context.runTick(h.sourceTab);assert.equal(h.created.length,0);
    await h.context.runTick(h.sourceTab,true,'123');assert.equal(h.created.length,1);
  }
  const h=harness({state:{scopes:{[key]:{productUpdatedAt:Date.now()-121*60000}},leaseUntil:Date.now()+25*60000}});
  await h.context.runTick(h.sourceTab);assert.equal(h.saved.length,2);
});
