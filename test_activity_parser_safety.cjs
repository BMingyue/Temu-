const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('browser_extension/page-bridge.js','utf8');
const start = source.indexOf('  const firstValue =');
const end = source.indexOf('  const rememberActivityResponse =');
const ctx = {};
vm.runInNewContext(source.slice(start,end) + '\nglobalThis.parse = extractActivityNetworkCandidates; globalThis.price = networkPrice;',ctx);
assert.equal(ctx.price({}, ['dailyPrice']),null);
assert.equal(ctx.price({dailyPrice:false}, ['dailyPrice']),null);
assert.equal(ctx.price({dailyPrice:'  '}, ['dailyPrice']),null);
assert.equal(ctx.price({dailyPrice:100}, ['dailyPrice']),100, 'never infer cents by magnitude');
const payload = {spuId:'123456',skcId:'234567',items:[
 {skuId:'345678',specName:'A',detail:{dailyPrice:4900}},
 {skuId:'456789',specName:'B',detail:{dailyPrice:70}},
 {skuId:'567890',specName:'C'}
]};
const rows=ctx.parse(payload);
assert.equal(rows.length,2,'missing price must not become zero and shadow nested price');
assert.deepEqual(Array.from(rows,r=>r.skuId),['345678','456789']);
assert.deepEqual(Array.from(rows,r=>r.dailyPrice),[4900,70]);
assert.ok(rows.every(r=>r.identityOnly && r.eligible===null));
payload.self=payload;
assert.equal(ctx.parse(payload).length,2,'cycles terminate');
console.log('activity parser safety: 8 behavior assertions passed');
