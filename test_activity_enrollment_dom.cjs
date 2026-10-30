const vm=require('node:vm'),fs=require('node:fs'),assert=require('node:assert/strict');
const context={module:{exports:{}}};
vm.runInNewContext(fs.readFileSync('browser_extension/activity-enrollment.js','utf8'),context);
const {normalizeSpec,cents,validateModel}=context.module.exports;
const expected={spuId:'111111',skcId:'222222',items:[
 {specification:'120.05×45.22cm',dailyPrice:'96.00',referenceActivityPrice:'72.00'},
 {specification:'60.21*39.86cm',dailyPrice:'38',referenceActivityPrice:'28.50'},
]};
assert.equal(normalizeSpec('法兰绒 60.21*39.86cm'),'60.21×39.86cm');
assert.notEqual(normalizeSpec('60.21*39.86in'),normalizeSpec('60.21*39.86cm'));
assert.equal(cents('¥1,234.50'),123450);
assert.equal(validateModel({spuId:'111111',skcId:'222222',specs:['60.21×39.86cm','120.05×45.22cm'],daily:['38.00','96'],reference:['28.5','72.00']},expected),true);
assert.throws(()=>validateModel({spuId:'111111',skcId:'222222',specs:['60.21×39.86cm','120.05×45.22cm'],daily:['39','96'],reference:['28.5','72']},expected),/价格已变化/);
assert.throws(()=>validateModel({spuId:'111111',skcId:'222222',specs:['60.21×39.86cm'],daily:['38'],reference:['28.5']},expected),/SKU 数量变化/);
assert.throws(()=>validateModel({spuId:'111111',skcId:'333333',specs:['60.21×39.86cm','120.05×45.22cm'],daily:['38','96'],reference:['28.5','72']},expected),/不一致/);
console.log('Enrollment identity and price contract checks passed.');
