const assert = require('node:assert/strict');
const {test} = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');

// Compatibility examples are synthetic. Actual Temu field names still require
// a current product response; old normalized archives omitted taxonomy.
const bridge = fs.readFileSync('./browser_extension/page-bridge.js','utf8');
function harness(responses = []) {
  const requests = [];
  const context = {requests,post:async(url,body)=>{requests.push({url,body});return responses.shift()},
    progress:()=>{},sleep:async()=>{},networkSpec:sku=>sku.specification||''};
  vm.createContext(context);
  vm.runInContext(bridge.slice(bridge.indexOf('  function productRowsFromPayload'),bridge.indexOf('  const cleanShopName')) +
    ';globalThis.parseCategory=productCategory;globalThis.products=products;',context);
  return context;
}
const plain = value => JSON.parse(JSON.stringify(value));

test('official leaf identity and full numbered path survive normalization',()=>{
  const p = harness().parseCategory({cat1Id:1,cat1Name:'服装',cat2Id:'20',cat2Name:'男士',
    cat3Id:'300',cat3Name:'T恤',catId:'300',catName:'T恤'});
  assert.deepEqual(plain(p),{categoryId:'300',categoryName:'T恤',categoryPath:['服装','男士','T恤'],
    categoryIds:['1','20','300'],categorySource:'temu_product_catalog'});
});
test('explicit ordered object and name paths preserve the leaf',()=>{
  const parse=harness().parseCategory;
  assert.deepEqual(plain(parse({categoryPath:[{catId:1,catName:'家居'},{catId:2,catName:'毛毯'}]})),
    {categoryId:'2',categoryName:'毛毯',categoryPath:['家居','毛毯'],categoryIds:['1','2'],categorySource:'temu_product_catalog'});
  assert.deepEqual(plain(parse({categoryNameList:['箱包','托特包'],categoryIdList:[7,8]})).categoryIds,['7','8']);
  assert.deepEqual(plain(parse({categoryName:'家居 > 地垫'})).categoryPath,['家居','地垫']);
});
test('nested category info and large string IDs are retained without numeric conversion',()=>{
  const item=harness().parseCategory({productCategoryInfo:{categoryId:'90071992547409931234',categoryName:'毛衣'}});
  assert.equal(item.categoryId,'90071992547409931234');assert.equal(item.categoryName,'毛衣');
  assert.equal(harness().parseCategory({categoryId:Number.MAX_SAFE_INTEGER+1,categoryName:'毛衣'}).categoryId,'');
});
test('observed native leafCat shape supplies the product leaf without guessing categories.catN',async()=>{
  // Field names are from the real 2026-11-01 00:38:46 crawl diagnostics;
  // values remain synthetic because that archive intentionally saved no raw values.
  const product={productId:'100001',productSkcId:'200001',
    leafCat:{catId:12345,catName:'男士T恤',catEnName:'Men T-Shirts',catType:1},
    categories:{cat1:'unverified-parent-shape',cat2:999,catType:1},
    productSkuSummaries:[{productSkuId:'300001',supplierPrice:3400}]};
  const result=await harness([{success:true,result:{total:1,list:[product]}}]).products({capturedMallId:'123'});
  const item=result.rows[0];
  assert.equal(item.categoryId,'12345');assert.equal(item.categoryName,'男士T恤');
  assert.deepEqual(plain(item.categoryPath),['男士T恤']);assert.deepEqual(plain(item.categoryIds),['12345']);
  assert.equal(item.categorySource,'temu_product_catalog');assert.equal(item.declaredPrice,34);
  assert.equal(result.categoryDiagnostics.parser,'temu_leaf_cat_v1');
  assert.deepEqual(plain(result.categoryCoverage),{skuCount:1,classifiedSkus:1,missingSkus:0,conflictSkus:0});
});
test('native leafCat conflicts stay unknown and English names do not replace missing Chinese names',()=>{
  const parse=harness().parseCategory;
  assert.equal(parse({leafCat:{catId:'11',catName:'男T恤'},categoryId:'12',categoryName:'女衬衫'}).categorySource,'temu_product_catalog_conflict');
  const englishOnly=parse({leafCat:{catId:'11',catEnName:'Men T-Shirts'}});
  assert.equal(englishOnly.categoryName,'');assert.equal(englishOnly.categoryId,'11');
  assert.deepEqual(plain(englishOnly.categoryPath),[]);
});
test('native categories object nodes supply a path only when the explicit final leaf agrees',()=>{
  const parse=harness().parseCategory;
  const product={leafCat:{catId:'11',catName:'男T恤'},categories:{
    cat1:{catId:1,catName:'服装'},cat2:{catId:2,catName:'男士'},cat3:{catId:11,catName:'男T恤'},cat4:null}};
  assert.deepEqual(plain(parse(product)),{categoryId:'11',categoryName:'男T恤',
    categoryPath:['服装','男士','男T恤'],categoryIds:['1','2','11'],categorySource:'temu_product_catalog'});
  const differentLeaf=parse({...product,leafCat:{catId:'12',catName:'女衬衫'}});
  assert.equal(differentLeaf.categoryId,'12');assert.equal(differentLeaf.categoryName,'女衬衫');
  assert.deepEqual(plain(differentLeaf.categoryPath),['女衬衫']);
  const ancestorsOnly=parse({...product,categories:{cat1:{catId:1,catName:'服装'},cat2:{catId:2,catName:'男士'}}});
  assert.equal(ancestorsOnly.categoryId,'11');assert.equal(ancestorsOnly.categoryName,'男T恤');
  assert.deepEqual(plain(ancestorsOnly.categoryPath),['男T恤']);
  const gap=parse({...product,categories:{cat1:{catId:1,catName:'服装'},cat2:2,cat3:{catId:11,catName:'男T恤'}}});
  assert.deepEqual(plain(gap.categoryPath),['男T恤']);assert.deepEqual(plain(gap.categoryIds),['11']);
});
test('taxonomy evidence is isolated, bounded and restricted to category node scalars',async()=>{
  const secret='secret-value-must-not-be-copied';
  const product={productId:'100001',productSkcId:'200001',title:secret,account:secret,
    leafCat:{catId:11,catName:'男T恤',token:secret},
    categories:{cat1:{catId:1,catName:'服装',catEnName:'Apparel',catType:1,token:secret},
      cat2:'x'.repeat(201),cat3:{catName:{token:secret},catType:false},cat4:[secret],cat5:123,
      cat6:'原生短类目节点',token:secret}};
  const result=await harness([{success:true,result:{total:1,list:[product]}}]).products({capturedMallId:'123'});
  assert.equal(result.rows[0].categoryId,'11');assert.equal(result.rows[0].categoryName,'男T恤');
  assert.deepEqual(plain(result.categoryTaxonomies),[{leafCat:{catId:'11',catName:'男T恤'},categories:{
    cat1:{catId:1,catName:'服装',catEnName:'Apparel',catType:1},cat5:123,cat6:'原生短类目节点'}}]);
  assert.ok(!JSON.stringify(result.categoryTaxonomies).includes(secret));
  assert.ok(!JSON.stringify(result.categoryTaxonomies).includes('100001'));
  assert.ok(!JSON.stringify(result.categoryDiagnostics).includes('Apparel'));
  const many=Array.from({length:105},(_,index)=>({productId:String(100001+index),productSkcId:String(200001+index),leafCat:{catId:1001+index,catName:'叶子'+index}}));
  many.push({...many[0],productId:'999999',productSkcId:'999998'});
  const capped=await harness([{success:true,result:{total:many.length,list:many}}]).products({capturedMallId:'123',pageSize:200});
  assert.equal(capped.categoryTaxonomies.length,100);
  assert.equal(new Set(capped.categoryTaxonomies.map(item=>item.leafCat.catId)).size,100);
});
test('SKU pack classification, titles, dimensions and selected filters never imply a category',()=>{
  const parse=harness().parseCategory;
  for(const input of [{skuCategory:'单品'},{productName:'Blanket',specification:'150x200cm'},
    {selectedCategory:{catId:1,catName:'服装'}},{productSkuMultiPack:{skuClassification:1}},
    {categoryName:{label:'毛毯'}},{categoryId:true}]) {
    assert.equal(parse(input).categorySource,'');assert.equal(parse(input).categoryName,'');
  }
});
test('contradictory product leaf/path remains unclassified and auditable',()=>{
  const item=harness().parseCategory({categoryId:7,categoryName:'T恤',categoryPath:[{id:8,name:'毛毯'}]});
  assert.equal(item.categoryName,'');assert.equal(item.categoryId,'');
  assert.equal(item.categorySource,'temu_product_catalog_conflict');
});
test('nested and top-level explicit leaves are all checked for conflicts',()=>{
  const parse=harness().parseCategory;
  const fixtures=[
    {productCategoryInfo:{categoryId:'11',categoryName:'男T恤'},categoryId:'12',categoryName:'女衬衫'},
    {productCategoryInfo:{categoryId:'11',categoryName:'男T恤'},categoryInfo:{categoryId:'12',categoryName:'男T恤'}},
    {productCategoryInfo:{categoryId:'11',categoryName:'男T恤'},categoryInfo:{categoryId:'11',categoryName:'女衬衫'}},
  ];
  for(const fixture of fixtures){
    const item=parse(fixture);
    assert.equal(item.categoryId,'');assert.equal(item.categoryName,'');
    assert.equal(item.categorySource,'temu_product_catalog_conflict');
  }
});
test('identical leaves merge a richer ancestor path regardless of nesting order',()=>{
  const parse=harness().parseCategory;
  const path={categoryPath:[{id:'1',name:'服装'},{id:'2',name:'男士'},{id:'11',name:'男T恤'}]};
  for(const fixture of [
    {productCategoryInfo:{categoryId:'11',categoryName:'男T恤'},categoryInfo:path},
    {productCategoryInfo:path,categoryId:'11',categoryName:'男T恤'},
  ]){
    assert.deepEqual(plain(parse(fixture)),{categoryId:'11',categoryName:'男T恤',
      categoryPath:['服装','男士','男T恤'],categoryIds:['1','2','11'],categorySource:'temu_product_catalog'});
  }
});
test('same leaf with incompatible complete ancestor paths remains conflicted',()=>{
  const parse=harness().parseCategory;
  for(const other of [
    [{id:'7',name:'其他服装'},{id:'11',name:'男T恤'}],
    [{id:'1',name:'女装'},{id:'11',name:'男T恤'}],
    [{id:'1',name:'服装'},{id:'2',name:'男士'},{id:'11',name:'男T恤'}],
  ]){
    const fixture={productCategoryInfo:{categoryPath:[{id:'1',name:'服装'},{id:'11',name:'男T恤'}]},categoryInfo:{categoryPath:other}};
    assert.equal(parse(fixture).categorySource,'temu_product_catalog_conflict');
  }
});
test('path fields never promote an ancestor when the leaf counterpart is absent',()=>{
  const parse=harness().parseCategory;
  const onlyLeafId=parse({categoryPath:[{id:'1',name:'服装'},{id:'11'}]});
  assert.equal(onlyLeafId.categoryId,'11');assert.equal(onlyLeafId.categoryName,'');
  assert.deepEqual(plain(onlyLeafId.categoryPath),[]);assert.deepEqual(plain(onlyLeafId.categoryIds),['1','11']);
  const onlyLeafName=parse({categoryPath:[{id:'1',name:'服装'},{name:'男T恤'}]});
  assert.equal(onlyLeafName.categoryId,'');assert.equal(onlyLeafName.categoryName,'男T恤');
  assert.deepEqual(plain(onlyLeafName.categoryIds),[]);assert.deepEqual(plain(onlyLeafName.categoryPath),['服装','男T恤']);
});
test('middle gaps keep only continuous leaf suffixes without shifting level identities',()=>{
  const parse=harness().parseCategory;
  const item=parse({categoryPath:[{id:'1',name:'服装'},{name:'男士'},{id:'11',name:'男T恤'}]});
  assert.equal(item.categoryId,'11');assert.deepEqual(plain(item.categoryIds),['11']);
  assert.deepEqual(plain(item.categoryPath),['服装','男士','男T恤']);
  const nameGap=parse({categoryPath:[{id:'1',name:'服装'},{id:'2'},{id:'11',name:'男T恤'}]});
  assert.deepEqual(plain(nameGap.categoryPath),['男T恤']);
  assert.deepEqual(plain(nameGap.categoryIds),['1','2','11']);
  for(const fixture of [
    {categoryPath:[{id:'1',name:'服装'},{},{id:'11',name:'男T恤'}]},
    {cat1Id:'1',cat1Name:'服装',cat3Id:'11',cat3Name:'男T恤'},
  ]){
    const blankLevel=parse(fixture);
    assert.deepEqual(plain(blankLevel.categoryPath),['男T恤']);
    assert.deepEqual(plain(blankLevel.categoryIds),['11']);
  }
});
test('product taxonomy is copied to every SKU without changing identity, prices or SKU classification',async()=>{
  const p=harness([{success:true,result:{total:1,list:[{productId:'100001',productSkcId:'200001',
    categoryInfo:{categoryId:300,categoryName:'T恤'},productSkuSummaries:[
      {productSkuId:'300001',supplierPrice:3400,productSkuMultiPack:{skuClassification:1}},
      {productSkuId:'300002',supplierPrice:null,productSkuMultiPack:{skuClassification:2}}]}]}}]);
  const result=await p.products({capturedMallId:'123'});
  assert.equal(result.rows.length,2);assert.equal(result.rows[0].categoryName,'T恤');
  assert.equal(result.rows[1].categoryId,'300');assert.equal(result.rows[0].declaredPrice,34);
  assert.equal(result.rows[1].declaredPrice,null);assert.equal(result.rows[0].skuCategory,'单品');
  assert.equal(result.rows[1].skuCategory,'混装');
  assert.deepEqual(plain(result.categoryCoverage),{skuCount:2,classifiedSkus:2,missingSkus:0,conflictSkus:0});
  assert.deepEqual(plain(p.requests[0].body),{page:1,pageSize:100,skcTopStatus:100});
});
test('envelope filter and neighboring goods never fill a missing product category',async()=>{
  const p=harness([{success:true,result:{categoryName:'服装',categoryId:9,total:2,list:[
    {productId:'100001',productSkcId:'200001',categoryId:7,categoryName:'T恤'},
    {productId:'100002',productSkcId:'200002'}]}}]);
  const result=await p.products({capturedMallId:'123'});
  assert.equal(result.rows[0].categoryName,'T恤');assert.equal(result.rows[1].categoryName,'');
  assert.deepEqual(plain(result.categoryCoverage),{skuCount:2,classifiedSkus:1,missingSkus:1,conflictSkus:0});
});
test('category diagnostics contain bounded structure and source counts without response values',async()=>{
  const privateValue='private-product-value-must-not-be-recorded';
  const product={productId:'100001',productSkcId:'200001',
    productCategoryInfo:{categoryId:300,categoryName:'T恤',token:privateValue},
    unknownLeafShape:[{label:privateValue}],password:privateValue,
    categories:{cat1:{catId:1,catName:privateValue},cat2:2,cat3:null}};
  for(let i=0;i<150;i++)product['category'+i+'x'.repeat(200)]={['nested'+'y'.repeat(200)]:privateValue};
  const result=await harness([{success:true,result:{total:1,list:[product]}}]).products({capturedMallId:'123'});
  const diagnostics=plain(result.categoryDiagnostics);
  assert.equal(diagnostics.productCount,1);
  assert.deepEqual(diagnostics.sourceCounts,{temu_product_catalog:1});
  assert.ok(diagnostics.fieldNames.includes('productCategoryInfo.categoryName'));
  assert.ok(diagnostics.fieldNames.includes('unknownLeafShape[].label'));
  assert.ok(diagnostics.fieldNames.includes('categories.cat1.catName'));
  assert.deepEqual(diagnostics.fieldTypes['categories.cat1'],['object']);
  assert.deepEqual(diagnostics.fieldTypes['categories.cat1.catName'],['string']);
  assert.deepEqual(diagnostics.fieldTypes['categories.cat2'],['number']);
  assert.deepEqual(diagnostics.fieldTypes['categories.cat3'],['null']);
  assert.ok(diagnostics.fieldNames.length<=120);
  assert.ok(diagnostics.fieldNames.every(field=>field.length<=160));
  assert.ok(!JSON.stringify(diagnostics).includes(privateValue));
  assert.ok(!diagnostics.fieldNames.includes('password'));
});
