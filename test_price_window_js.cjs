const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');

const sourcePath = path.join(__dirname, 'browser_extension', 'price-window.js');
const source = fs.readFileSync(sourcePath, 'utf8');
const sandbox = { module: { exports: {} }, exports: {} };
vm.runInNewContext(source, sandbox, { filename: sourcePath });
const { buildPlan, presetPriceWarning } = sandbox.module.exports;

const base = {
  site: '美国站',
  priceType: '日常价格',
  status: '',
  editable: true,
  selected: true,
};
const rules = {
  size_prices: {
    '40×50in': { floor: 70, target_daily: 90 },
    '50×60in': { floor: 50, target_daily: 60 },
  },
};

const onlyBlocked = buildPlan([
  { ...base, spec: '40*50in', old: '67.00' },
], rules, 'preset_target_daily');
assert.equal(onlyBlocked.planned.length, 0);
assert.equal(onlyBlocked.skipped.length, 1);
assert.equal(onlyBlocked.skipped[0].old, 6700);
assert.equal(onlyBlocked.skipped[0].target, 9000);
assert.match(onlyBlocked.skipped[0].reason, /低于预设价/);
assert.equal(
  presetPriceWarning(onlyBlocked),
  '以下 1 个规格当前价格低于店铺预设，按“不允许上调”规则未执行：\n\n40×50in：当前 ¥67.00，预设 ¥90.00',
);

const mixed = buildPlan([
  { ...base, spec: '40*50in', old: '67.00' },
  { ...base, spec: '50*60in', old: '65.00' },
], rules, 'preset_target_daily');
assert.equal(mixed.planned.length, 1);
assert.equal(mixed.planned[0].spec, '50×60in');
assert.match(presetPriceWarning(mixed), /40×50in/);
assert.doesNotMatch(presetPriceWarning(mixed), /50×60in/);

const lowerOnly = buildPlan([
  { ...base, spec: '50*60in', old: '65.00' },
], rules, 'preset_target_daily');
assert.equal(presetPriceWarning(lowerOnly), '');

console.log('price-window JS tests passed');
