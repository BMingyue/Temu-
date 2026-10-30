const assert=require('node:assert/strict');
const vm=require('node:vm'),fs=require('node:fs');
const context={module:{exports:{}}};
vm.runInNewContext(fs.readFileSync('./browser_extension/price-window.js','utf8'),context);
const {spec,cents,columnIndex,selectEligible,selectAutomatic,selectPreset,plan,lowerOnly,buildPlan,panelView}=context.module.exports;
const row={spec:'法兰绒 120.05*45.22cm',site:'美国站',priceType:'日常价格',old:'¥96.00'};
const rules={'120.05×45.22cm':{floor:'72',target_daily:'96'}};
assert.equal(spec('40*50in'),'40×50in');
assert.equal(spec('混合色 当前SKC'),'混合色');
const adjustedHeaders=['','颜色','调价站点','申报价格类型','原申报价格(CNY)','申报价格状态','参考申报价格(CNY)','调整后申报价格(CNY)'];
assert.equal(columnIndex(adjustedHeaders,'SKU属性集','颜色','规格','SKU规格'),1);
assert.equal(columnIndex(adjustedHeaders,'站点','调价站点'),2);
assert.notEqual(spec('40*50in'),spec('40*50cm'));
assert.equal(cents('￥1,234.56'),123456);
for(const bad of ['',null,'NaN','Infinity','-1','0','1.234'])assert.throws(()=>cents(bad));
assert.equal(plan([row],rules,'floor')[0].target,7200);
assert.equal(plan([row],rules,'target_daily')[0].target,9600);
assert.throws(()=>plan([row],rules,'unknown'));
assert.throws(()=>plan([],rules,'floor'));
assert.throws(()=>plan([row,row],rules,'floor'),/不唯一|唯一定位/);
assert.throws(()=>plan([{...row,site:'加拿大站'}],rules,'floor'));
assert.throws(()=>plan([{...row,priceType:'活动价格'}],rules,'floor'));
assert.throws(()=>plan([row],{},'floor'));
assert.throws(()=>plan([row],{...rules,'120.05*45.22cm':rules['120.05×45.22cm']},'floor'));
assert.throws(()=>spec('120*45cm 60*40cm'));
assert.throws(()=>spec('120*45'));
const shuffled=plan([{...row,spec:'60.21*39.86cm',old:'38'},row],{...rules,'60.21×39.86cm':{floor:28,target_daily:38}},'floor');
assert.equal(JSON.stringify(shuffled.map(x=>x.target)),JSON.stringify([2800,7200]));
assert.equal(JSON.stringify(panelView(true)),JSON.stringify({label:'展开',width:'auto',padding:'7px 10px',headingHidden:true,left:'16px',bottom:'16px',right:'auto',top:'auto'}));
assert.equal(JSON.stringify(panelView(false)),JSON.stringify({label:'收起',width:'340px',padding:'12px',headingHidden:false,left:'16px',bottom:'16px',right:'auto',top:'auto'}));
console.log('Price-window rule checks passed (including shuffled rows, units, duplicates and invalid money).');

assert.equal(plan([{...row,spec:'121.05×44.22cm'}],rules,'floor')[0].target,7200);
assert.throws(()=>plan([{...row,spec:'122.06×45.22cm'}],rules,'floor'));
assert.throws(()=>plan([{...row,spec:'120.05×45.22in'}],rules,'floor'));
const nearby={'60×40cm':{floor:'28'},'61×41cm':{floor:'30'}};
assert.equal(plan([{...row,spec:'60×40cm'}],nearby,'floor')[0].target,2800);
assert.throws(()=>plan([{...row,spec:'60.5×40.5cm'}],nearby,'floor'),/多个/);

const partial=[
 {...row,spec:'40*50in-法兰绒',old:'¥45.70',status:'商品流量待关注',reference:'¥45.05',selected:true,editable:true},
 {...row,spec:'50*60in-法兰绒',status:'价格已作废',reference:'--',selected:false,editable:false},
 {...row,spec:'30*40in-法兰绒',status:'价格已作废',reference:'--',selected:false,editable:false},
 {...row,spec:'60*80in-法兰绒',status:'价格已作废',reference:'--',selected:false,editable:false},
];
const choice=selectEligible(partial);
assert.equal(choice.selected.length,1);
assert.equal(choice.selected[0].index,0);
assert.equal(choice.skipped.length,3);
assert.equal(plan(choice.selected,{'40×50in':{floor:34,target_daily:46}},'target_daily')[0].target,4600);
assert.throws(()=>selectEligible(partial.map((r,i)=>i===1?{...r,selected:true}:r)),/已勾选.*已作废/);
assert.throws(()=>selectEligible(partial.map(r=>({...r,selected:false}))),/没有已勾选/);
assert.equal(selectEligible([{...partial[0],selected:false}, {...partial[0],spec:'50*60in',status:'正常',reference:'¥50',selected:true}]).selected[0].index,1);
console.log('Partial-size eligibility checks passed.');

const autoRules={'40×50in':{floor:'48',target_daily:'64'},'50×60in':{floor:'70',target_daily:'90'}};
const autoRows=[
 {...partial[0],old:'¥45.70',selected:true},
 {...partial[1],status:'-',reference:'--',old:'¥120.00',editable:true,selected:false},
 {...partial[2],status:'-',reference:'--',old:'¥70.00',editable:true,selected:true},
 {...partial[3],selected:true},
];
const auto=selectAutomatic(autoRows,autoRules,{state:'ready',decisions:{'40×50in':{eligible:true},'50×60in':{eligible:false}}});
assert.equal(auto.selected.length,1);
assert.equal(auto.selected[0].tier,'floor');
assert.equal(auto.selected[0].index,1);
assert.equal(plan(auto.selected,autoRules,'auto')[0].target,7000);
assert.match(auto.skipped[0].reason,/禁止上调/);
assert.match(auto.skipped[1].reason,/活动资格没有明确证据/);
assert.match(auto.skipped[2].reason,/已作废/);
assert.equal(selectAutomatic(autoRows,autoRules,{state:'missing',decisions:{}}).selected.length,0);
const reduced=lowerOnly([{index:0,spec:'40×50in',old:4570,target:4800},{index:1,spec:'50×60in',old:12000,target:7000}]);
assert.deepEqual(JSON.parse(JSON.stringify(reduced.planned.map(x=>x.index))),[1]);
assert.match(reduced.skipped[0].reason,/禁止上调/);
const screenshotPlan=buildPlan(partial,{size_prices:autoRules,activity:{state:'ready',decisions:{'40×50in':{eligible:true}}}},'auto');
assert.equal(screenshotPlan.planned.length,0);
assert.equal(screenshotPlan.skipped.length,4);
assert.match(screenshotPlan.skipped[0].reason,/禁止上调/);
const mixedPlan=buildPlan(autoRows,{size_prices:autoRules,activity:{state:'ready',decisions:{'40×50in':{eligible:true},'50×60in':{eligible:false}}}},'auto');
assert.equal(mixedPlan.planned.length,1);
assert.equal(mixedPlan.planned[0].tier,'floor');
assert.equal(mixedPlan.planned[0].target,7000);
assert.throws(()=>buildPlan([{...autoRows[1],site:'加拿大站'}],{size_prices:autoRules,activity:{state:'ready',decisions:{}}},'auto'),/非美国站/);
console.log('Automatic activity/floor tier and no-price-increase checks passed.');

const presetRows=[
 {spec:'混合色 当前SKC',site:'美国站',priceType:'日常价格',old:'¥30.00',status:'-',reference:'--',selected:false,editable:true},
 {spec:'其他颜色',site:'美国站',priceType:'日常价格',old:'¥30.00',status:'-',reference:'--',selected:false,editable:true},
 {spec:'混合色',site:'美国站',priceType:'日常价格',old:'¥30.00',status:'价格已作废',reference:'--',selected:false,editable:false},
];
const tshirtPreset={size_prices:{'混合色':{floor:18,target_daily:24}},activity:{state:'missing',decisions:{}}};
const presetChoice=selectPreset(presetRows,tshirtPreset.size_prices,'preset_target_daily');
assert.equal(presetChoice.selected.length,1);
assert.equal(presetChoice.selected[0].index,0);
assert.equal(presetChoice.skipped.length,2);
const presetPlan=buildPlan(presetRows,tshirtPreset,'preset_target_daily');
assert.equal(presetPlan.planned.length,1);
assert.equal(presetPlan.planned[0].target,2400);
assert.equal(presetPlan.planned[0].spec,'混合色');
assert.equal(buildPlan(presetRows,tshirtPreset,'preset_floor').planned[0].target,1800);
assert.equal(buildPlan([{...presetRows[0],old:'¥24.00'}],tshirtPreset,'preset_target_daily').planned.length,0);
assert.match(buildPlan([{...presetRows[0],old:'¥20.00'}],tshirtPreset,'preset_target_daily').skipped[0].reason,/禁止上调/);
console.log('Preset-only price checks passed without activity evidence or reference price.');
