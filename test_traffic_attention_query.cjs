const assert=require('node:assert/strict'),{test}=require('node:test'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('./browser_extension/accelerator-query.js','utf8');
const url='https://agentseller-us.temu.com/main/flux-analysis?wb_accelerator_status=owned';
const item=(id,code)=>({productId:String(id),siteId:100,siteName:'美国',flowLimitStatus:code});
const response=(items,patch={})=>({success:true,result:{pageItems:items,total:items.length,...patch}});
const plain=value=>JSON.parse(JSON.stringify(value));
function harness(options={}){
 const ids=options.ids||['100001','100002'],calls=[],context={URL,location:new URL(url),window:{}};
 vm.createContext(context);vm.runInContext(source,context);
 const payload={mallId:'123',capturedMallId:'123',marker:'owned',requestHeaders:{mallid:'123'},productIds:ids,includeTrafficAttention:true,...options.payload};
 const post=async(endpoint,body,headers,meta)=>{
  calls.push({endpoint,body:plain(body),headers:plain(headers),meta:plain(meta)});
  assert.equal(endpoint,'/api/flow/analysis/list');
  if(Object.hasOwn(body,'flowGrowStatus'))return options.active||response([{...item(ids[0],0),flowGrowStatus:1}]);
  if(options.post)return options.post(context);
  return Object.hasOwn(options,'attention')?options.attention:response([item(ids[0],0),item(ids[1],2)]);
 };
 return {calls,run:()=>context.window.TemuAcceleratorQuery.readBatch(payload,post)};
}
test('attention queries are independent and preserve complete enabled-set decisions',async()=>{
 const h=harness({payload:{flowGrowStatus:99,flowLimitStatus:2,flowLimitingStatus:1,siteIdList:[101]}}),result=await h.run();
 assert.equal(h.calls.length,2);
 assert.deepEqual(h.calls[1].body,{pageSize:100,pageNumber:1,timeDimension:1,productIdList:[100001,100002],siteIdList:[100]});
 assert.deepEqual(plain(result.rows.map(row=>[row.spuId,row.status,row.trafficAttention,row.flowLimitStatus])),[['100001','enabled',false,0],['100002','disabled',true,2]]);
 assert.equal(result.trafficAttentionRule,'temu_native_flow_limit_v1');assert.equal(result.trafficAttentionKnown,2);
 assert.equal(result.rows[1].trafficAttentionLabel,'商品流量待关注');
});
test('only numeric native status 2 means the exact attention badge',async()=>{
 const ids=['100001','100002','100003','100004'],h=harness({ids,attention:response(ids.map((id,code)=>item(id,code)))}),result=await h.run();
 assert.deepEqual(plain(result.rows.map(row=>row.trafficAttention)),[false,false,true,false]);
 assert.deepEqual(plain(result.rows.map(row=>row.trafficAttentionLabel)),['无商品流量待关注标记','商品流量预测将下滑','商品流量待关注','商品流量近期有下滑']);
 assert.ok(result.rows.every(row=>row.trafficAttentionSource==='temu_native_flow_limit_v1'));
});
test('missing, invalid or inherited native codes remain unknown rather than clear',async()=>{
 for(const code of [undefined,null,'2',true,false,4,-1,2.5]){
  const native=item('100001',code);if(code===undefined)delete native.flowLimitStatus;
  const h=harness({attention:response([native])}),result=await h.run();
  assert.equal(result.rows[0].trafficAttention,null);assert.equal(result.rows[0].flowLimitStatus,null);
  assert.equal(result.rows[0].trafficAttentionSource,'');assert.equal(result.rows[0].trafficAttentionLabel,'');
 }
 const native=Object.assign(Object.create({flowLimitStatus:2}),{productId:'100001',siteId:100,siteName:'美国'});
 assert.equal((await harness({attention:response([native])}).run()).rows[0].trafficAttention,null);
});
test('a target absent from a complete unfiltered list stays unknown, independently of disabled',async()=>{
 const result=await harness({active:response([]),attention:response([item('100001',2)])}).run();
 assert.equal(result.rows[0].status,'disabled');assert.equal(result.rows[0].trafficAttention,true);
 assert.equal(result.rows[1].status,'disabled');assert.equal(result.rows[1].trafficAttention,null);
 assert.equal(result.trafficAttentionKnown,1);assert.equal(result.trafficAttentionRows,1);
 const empty=await harness({active:response([]),attention:response([])}).run();
 assert.ok(empty.rows.every(row=>row.trafficAttention===null));
});
test('failed or incomplete attention responses cannot publish a successful batch or fabricate clear',async()=>{
 for(const attention of [null,{},response([], {total:1}),response([item('100001',2)],{total:3}),response([],{pageNumber:2}),response([],{pageSize:20}),{success:false,result:{pageItems:[],total:0}}]){
  const h=harness({attention});await assert.rejects(h.run(),/流量待关注/);assert.equal(h.calls.length,2);
 }
 const h=harness({post:()=>{throw Error('offline')}});await assert.rejects(h.run(),/offline/);assert.equal(h.calls.length,2);
});
test('attention scope validates each row and response layer even with empty results',async()=>{
 for(const attention of [
  response([item('999999',2)]),response([item('100001',2),item('100001',2)]),
  response([{...item('100001',2),siteId:101}]),response([{...item('100001',2),siteName:'英国'}]),
  response([{...item('100001',2),mallId:'999'}]),response([],{mallId:'999'}),response([],{siteIdList:[101]}),
  {success:true,mall_id:'999',result:{pageItems:[],total:0}}
 ])await assert.rejects(harness({attention}).run(),/流量待关注/);
});
test('navigation during attention response prevents publishing any result without retry',async()=>{
 const h=harness({post:context=>{context.location=new URL('https://example.com/');return response([])}});
 await assert.rejects(h.run(),/本轮独立/);assert.equal(h.calls.length,2);
});
