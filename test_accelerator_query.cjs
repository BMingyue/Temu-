const assert=require('node:assert/strict'),{test}=require('node:test'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('./browser_extension/accelerator-query.js','utf8');
const baseUrl='https://agentseller-us.temu.com/main/flux-analysis?wb_accelerator_status=owned';
const activeItem=(productId,patch={})=>({productId:String(productId),siteId:100,siteName:'美国',flowGrowStatus:1,...patch});
const response=(items,total=items.length,patch={})=>({success:true,result:{pageItems:items,total,...patch}});
const plain=value=>JSON.parse(JSON.stringify(value));
function harness(options={}){
 const calls=[],context={URL,location:new URL(options.url||baseUrl),window:{}};
 vm.createContext(context);vm.runInContext(source,context);
 const payload={mallId:'123',capturedMallId:'123',marker:'owned',requestHeaders:{mallid:'123','anti-content':'native'},productIds:['100001','100002'],...options.payload};
 const post=async(...args)=>{
  calls.push(args);
  if(options.post)return options.post(...args,context);
  assert.equal(args[0],'/api/flow/analysis/list','badge queries must not call a single-product detail endpoint');
  return Object.hasOwn(options,'response')?options.response:response([activeItem(100001)]);
 };
 return {context,payload,calls,run:patch=>context.window.TemuAcceleratorQuery.readBatch({...payload,...patch},post)};
}

test('MAIN and CJS expose readBatch without starting requests',()=>{
 const h=harness();assert.equal(typeof h.context.window.TemuAcceleratorQuery.readBatch,'function');
 const cjs={module:{exports:{}}};vm.createContext(cjs);vm.runInContext(source,cjs);
 assert.equal(typeof cjs.module.exports.readBatch,'function');assert.equal(h.calls.length,0);
});

test('the request contains only bounded native identities, the US site and active status',async()=>{
 const h=harness({payload:{flowGrowStatus:0,canToGrow:1,maxModeStatus:1,flowLimitingStatus:1,productIdList:[999999],siteIdList:[101],pageNumber:7,pageSize:500,timeDimension:0}});
 await h.run();
 assert.equal(h.calls.length,1);assert.equal(h.calls[0][0],'/api/flow/analysis/list');
 assert.deepEqual(plain(h.calls[0][1]),{pageSize:100,pageNumber:1,timeDimension:1,productIdList:[100001,100002],siteIdList:[100],flowGrowStatus:1});
 assert.deepEqual(plain(h.calls[0][2]),{mallid:'123','anti-content':'native'});
});

test('a complete active set yields one switch state for every catalog target',async()=>{
 const h=harness(),result=await h.run();
 assert.equal(result.success,true);assert.equal(result.complete,true);assert.equal(result.stateRule,'flow_grow_badge_v1');
 assert.equal(result.sourceMallId,'123');assert.equal(result.rawCount,1);assert.equal(result.total,1);assert.equal(result.pages,1);
 assert.deepEqual(plain(result.rows.map(row=>[row.spuId,row.siteName,row.status])),[['100001','美国站','enabled'],['100002','美国站','disabled']]);
 assert.deepEqual(plain(result.missingIds),[]);assert.deepEqual(plain(result.unknownIds),[]);
 assert.deepEqual(plain(result.diagnostics.map(row=>[row.spuId,row.code])),[['100001','badge_present'],['100002','badge_absent']]);
 assert.match(result.rows[0].evidence,/流量加速中.*flowGrowStatus=1/);
 assert.match(result.rows[1].evidence,/同店美国站完整.*集合.*未开启/);
 assert.equal(result.diagnostics[1].message,result.rows[1].evidence);
 assert.equal(result.detailRequests,0);assert.equal(h.calls.length,1);
});

test('a successful explicit empty active set marks every requested target off without detail calls',async()=>{
 const h=harness({response:response([])}),result=await h.run();
 assert.deepEqual(plain(result.rows.map(row=>row.status)),['disabled','disabled']);
 assert.equal(result.rawCount,0);assert.equal(result.total,0);assert.equal(result.complete,true);
 assert.equal(result.detailRequests,0);assert.equal(h.calls.length,1);
 assert.ok(result.diagnostics.every(row=>row.code==='badge_absent'));
 assert.deepEqual(plain(result.missingIds),[]);assert.deepEqual(plain(result.unknownIds),[]);
});

test('an all-active response and a reordered response preserve the target identities',async()=>{
 const h=harness({response:response([activeItem(100002),activeItem(100001)])}),result=await h.run();
 assert.deepEqual(plain(result.rows.map(row=>[row.spuId,row.status])),[['100001','enabled'],['100002','enabled']]);
 assert.equal(result.rows.length,2);assert.equal(result.rawCount,2);
});

test('numeric identities are canonicalized and duplicated requested targets do not produce duplicate rows',async()=>{
 const h=harness({payload:{productIds:['100001',100001,'100002']}}),result=await h.run();
 assert.deepEqual(plain(h.calls[0][1].productIdList),[100001,100002]);
 assert.deepEqual(plain(result.rows.map(row=>row.spuId)),['100001','100002']);
});

test('legacy SKC evidence may be present but is not required to establish the badge set',async()=>{
 for(const skcIdsBySpu of [undefined,{100001:['200001'],100002:['200002']}]){
  const h=harness({payload:{skcIdsBySpu},response:response([])}),result=await h.run();
  assert.deepEqual(plain(result.rows.map(row=>row.status)),['disabled','disabled']);
  assert.equal(result.detailRequests,0);assert.equal(h.calls.length,1);
  assert.equal(Object.hasOwn(h.calls[0][1],'skcIdsBySpu'),false);
 }
});

test('raw list rows must explicitly carry own numeric status 1 or the entire active set is rejected',async()=>{
 for(const value of [0,2,99,'1','0',true,false,null,undefined]){
  const row=activeItem(100001,{flowGrowStatus:value});
  if(value===undefined)delete row.flowGrowStatus;
  const h=harness({response:response([row])});
  await assert.rejects(h.run(),/加速中筛选未生效/);assert.equal(h.calls.length,1);
 }
 const inherited=Object.assign(Object.create({flowGrowStatus:1}),{productId:'100001',siteId:100,siteName:'美国'});
 await assert.rejects(harness({response:response([inherited])}).run(),/加速中筛选未生效/);
});

test('ignored status filtering cannot publish off states from a mixed response',async()=>{
 const h=harness({response:response([activeItem(100001),activeItem(100002,{flowGrowStatus:0})])});
 await assert.rejects(h.run(),/筛选未生效/);assert.equal(h.calls.length,1);
});

test('offer, Max, eligibility and unrelated merchant prices do not alter the badge decision',async()=>{
 const h=harness({response:response([activeItem(100001,{maxModeStatus:1,canToGrow:1,flowLimitStatus:3,siteStatus:0,price:5000,supplierPrice:8000,growDays:-1})])}),result=await h.run();
 assert.equal(result.rows[0].status,'enabled');assert.equal(result.rows[1].status,'disabled');
 for(const row of result.rows)for(const key of ['price','currency','priceKind','supplierPrice'])assert.equal(Object.hasOwn(row,key),false);
});

test('wrong page, unowned markers and non-US helper routes cannot issue a request',async()=>{
 for(const options of [
  {url:'https://agentseller.temu.com/main/flux-analysis?wb_accelerator_status=owned'},
  {url:'https://agentseller-eu.temu.com/main/flux-analysis?wb_accelerator_status=owned'},
  {url:'https://agentseller-us.temu.com/goods/list?wb_accelerator_status=owned'},
  {url:'https://agentseller-us.temu.com/main/flux-analysis'},
  {url:baseUrl.replace('owned','another')},
  {payload:{marker:''}}
 ]){
  const h=harness(options);await assert.rejects(h.run());assert.equal(h.calls.length,0);
 }
});

test('captured mall and exactly one matching native mall header are required before requests',async()=>{
 for(const payload of [
  {mallId:'not-a-mall'},{capturedMallId:'999'},{requestHeaders:{mallid:'999'}},
  {requestHeaders:{}},{requestHeaders:null},{requestHeaders:{mallid:'123',MallId:'999'}}
 ]){
  const h=harness({payload});await assert.rejects(h.run(),/mallid|店铺/);assert.equal(h.calls.length,0);
 }
 const h=harness({payload:{requestHeaders:{MallId:'123'}}});await h.run();assert.equal(h.calls.length,1);
});

test('navigation or marker changes during the response prevent any absence conclusion',async()=>{
 for(const url of ['https://example.com/',baseUrl.replace('owned','new-scan')]){
  const h=harness({post:async(_url,_body,_headers,_requestContext,context)=>{context.location=new URL(url);return response([])}});
  await assert.rejects(h.run(),/本轮独立/);assert.equal(h.calls.length,1);
 }
});

test('bad targets and batches larger than twenty cannot issue native requests',async()=>{
 for(const productIds of [undefined,null,[],['100001','x'],[null],[true],[1.5],['0'],['9007199254740993'],Array.from({length:21},(_,index)=>String(100001+index))]){
  const h=harness({payload:{productIds}});await assert.rejects(h.run(),/商品标识/);assert.equal(h.calls.length,0);
 }
 const ids=Array.from({length:20},(_,index)=>String(100001+index));
 const h=harness({payload:{productIds:ids},response:response(ids.map(productId=>activeItem(productId)))}),result=await h.run();
 assert.equal(result.rows.length,20);assert.equal(result.rawCount,20);assert.equal(result.detailRequests,0);assert.equal(h.calls.length,1);
});

test('failed, missing or ambiguous responses cannot be interpreted as an empty active set',async()=>{
 for(const value of [
  null,{},[],{success:false,result:{pageItems:[],total:0}},{success:'true',result:{pageItems:[],total:0}},
  {success:true},{success:true,result:{total:0}},{success:true,result:{pageItems:[]}},
  {success:true,result:{pageItems:null,total:0}},{success:true,result:{pageItems:[],total:null}},
  {success:true,result:{pageItems:[],total:'0'}},{success:true,result:{pageItems:[],total:-1}},
  {success:true,result:{pageItems:[],total:0.5}}
 ]){
  const h=harness({response:value});await assert.rejects(h.run());assert.equal(h.calls.length,1);
 }
});

test('nonempty totals with empty or short pages cannot turn unreturned targets off',async()=>{
 for(const value of [
  response([],1),response([activeItem(100001)],2),response([activeItem(100001),activeItem(100002)],1),
  response([activeItem(100001)],101)
 ]){
  const h=harness({response:value});await assert.rejects(h.run(),/未读全|分页上界/);assert.equal(h.calls.length,1);
 }
});

test('incompatible native page metadata fails even for an empty result',async()=>{
 for(const patch of [{pageNumber:2},{pageNumber:'1'},{pageSize:20},{pageSize:'100'}]){
  const h=harness({response:response([],0,patch)});await assert.rejects(h.run(),/页码或每页条数不匹配/);
 }
});

test('duplicate active identities cannot satisfy the reported total',async()=>{
 const h=harness({response:response([activeItem(100001),activeItem(100001)])});
 await assert.rejects(h.run(),/重复返回/);assert.equal(h.calls.length,1);
});

test('returned products, sites and mall identities must match the exact requested scope',async()=>{
 for(const value of [
  response([activeItem(999999)]),response([{siteId:100,siteName:'美国',flowGrowStatus:1}]),
  response([activeItem(100001,{siteId:101})]),response([activeItem(100001,{siteId:'100'})]),
  response([activeItem(100001,{siteName:'英国'})]),response([activeItem(100001,{siteName:''})]),
  response([activeItem(100001,{mallId:'999'})]),response([activeItem(100001)],1,{mall_id:'999'}),
  {success:true,mall_id:'999',result:{pageItems:[],total:0}}
 ]){
  const h=harness({response:value});await assert.rejects(h.run(),/范围外|站点|店铺/);assert.equal(h.calls.length,1);
 }
});

test('platform errors propagate without replaying requests or trying detail fallbacks',async()=>{
 const h=harness({post:async()=>{throw Error('native failure')}});
 await assert.rejects(h.run(),/native failure/);assert.equal(h.calls.length,1);
});

test('explicit response scope is checked even when the active set is empty',async()=>{
 for(const scope of [
  {siteId:101},{siteId:'100'},{siteId:null},{siteName:'英国'},{siteName:''},
  {siteIdList:[101]},{siteIdList:[100,101]},{siteIdList:['100']},{siteIdList:[]},{siteIdList:null},
  {mallId:'999'},{mall_id:'999'}
 ])for(const layer of ['response','result']){
  const value=response([]);
  Object.assign(layer==='response'?value:value.result,scope);
  const h=harness({response:value});await assert.rejects(h.run(),/站点|店铺/);assert.equal(h.calls.length,1);
 }
 const h=harness({response:{success:true,mall_id:'123',siteId:100,siteName:'美国',siteIdList:[100],result:{pageItems:[],total:0,mallId:'123',siteId:100,siteName:'美国站',siteIdList:[100]}}});
 assert.deepEqual(plain((await h.run()).rows.map(row=>row.status)),['disabled','disabled']);
});
