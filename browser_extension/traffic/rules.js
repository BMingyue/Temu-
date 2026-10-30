(function (root) {
  'use strict';
  const normalize = value => String(value ?? '').normalize('NFKC').replace(/[\u200b-\u200d\ufeff]/g, '').replace(/\s+/g, '').trim();
  function category(value) {
    return normalize(value).replace(/^类目[:：]?/, '').replace(/[›»→]/g, '>').replace(/[,，、；;]/g, '、');
  }
  function categoryMatches(actual, expected) {
    const a = category(actual), e = category(expected);
    if (!a || !e) return false;
    if (e.includes('>')) return a === e && !/[.…]/.test(a);
    const leaf = a.split('>').at(-1);
    return leaf === e && !/[.…]/.test(leaf);
  }
  function spec(value) {
    return normalize(value).toLowerCase().replace(/[×x✕＊]/g, '*').replace(/(?:英寸|inches|inch|[″"])/g, 'in').replace(/[—–－]/g, '-');
  }
  function cents(value) {
    const s = String(value ?? '').trim();
    if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(s)) throw new Error('价格必须是正数，最多两位小数');
    const [integer, fraction = ''] = s.split('.');
    const result = Number(integer) * 100 + Number(fraction.padEnd(2, '0'));
    if (!Number.isSafeInteger(result) || result <= 0 || result > 100000000) throw new Error('价格超出允许范围');
    return result;
  }
  function money(value) { return (value / 100).toFixed(2); }
  const defaults = {
    categories: ['小盖毯、午休毯'], tags: ['限时秒杀'], duration: 14,
    skuRules: [
      {spec: '40*50in-法兰绒', price: '49'},
      {spec: '50*60in-法兰绒', price: '68'},
      {spec: '60*80in-法兰绒', price: '83'}
    ], maxPages: 200, delayMs: 1200, scanPageDelayMs: 30000, timeoutMs: 60000, resultTimeoutMs: 60000
  };
  function validate(config) {
    if (!config || !Array.isArray(config.categories) || !config.categories.length || config.categories.some(x => !category(x))) throw new Error('请至少填写一个完整类目');
    if (!Array.isArray(config.tags) || !config.tags.length || config.tags.some(x => !normalize(x))) throw new Error('请填写活动标签');
    if (config.duration !== 14) throw new Error('本版本固定使用持续14天');
    if (!Array.isArray(config.skuRules) || !config.skuRules.length) throw new Error('请填写规格与固定价格');
    const keys = new Set();
    for (const rule of config.skuRules) {
      const key = spec(rule.spec);
      if (!key || /[.…]/.test(key)) throw new Error('规格必须完整，不允许省略号');
      if (keys.has(key)) throw new Error('存在重复规格：' + rule.spec);
      keys.add(key); cents(rule.price);
    }
    if (!Number.isInteger(config.maxPages) || config.maxPages < 1 || config.maxPages > 2000) throw new Error('最大页数需为1～2000');
    if (!Number.isFinite(config.delayMs) || config.delayMs < 300 || config.delayMs > 10000) throw new Error('操作间隔需为300～10000毫秒');
    if (!Number.isFinite(config.timeoutMs) || config.timeoutMs < 500 || config.timeoutMs > 120000) throw new Error('等待时间配置无效');
    const scanPageDelayMs = config.scanPageDelayMs ?? defaults.scanPageDelayMs;
    if (!Number.isFinite(scanPageDelayMs) || scanPageDelayMs < 15000 || scanPageDelayMs > 120000) throw new Error('扫描翻页间隔需为15～120秒');
    const resultTimeoutMs = config.resultTimeoutMs ?? defaults.resultTimeoutMs;
    if (!Number.isFinite(resultTimeoutMs) || resultTimeoutMs < 500 || resultTimeoutMs > 120000) throw new Error('结果等待时间配置无效');
    return JSON.parse(JSON.stringify({...config, scanPageDelayMs, resultTimeoutMs}));
  }
  function matchProduct(product, config) {
    if (!/^\d+$/.test(product.id || '')) return {ok: false, reason: '未识别唯一SPU ID'};
    if (!config.categories.some(x => categoryMatches(product.category, x))) return {ok: false, reason: '类目不匹配或类目文字不完整'};
    if (!config.tags.every(tag => product.tags.some(x => normalize(x).replace(/[>›]+$/, '') === normalize(tag)))) return {ok: false, reason: '缺少指定活动标签'};
    if (!product.opportunity) return {ok: false, reason: '没有开启流量加速器机会'};
    return {ok: true, reason: '符合商品筛选，开启前仍需核验全部SKU'};
  }
  function pricePlan(skus, config) {
    if (!skus.length) throw new Error('未识别到SKU价格行');
    const plan = [], used = new Set();
    for (const sku of skus) {
      const key = spec(sku.spec);
      const matches = config.skuRules.filter(x => spec(x.spec) === key);
      if (matches.length !== 1) throw new Error('SKU未精确匹配固定价格：' + sku.spec);
      if (used.has(key)) throw new Error('页面出现重复规格，无法唯一确认：' + sku.spec);
      used.add(key);
      const target = cents(matches[0].price);
      if (!Number.isSafeInteger(sku.reference) || !Number.isSafeInteger(sku.daily)) throw new Error('未识别人民币参考价或日常申报价');
      if (target > sku.reference || target > sku.daily) throw new Error(sku.spec + '：指定价格高于页面价格上限，已跳过');
      plan.push({...sku, target, price: money(target)});
    }
    return plan;
  }
  const api = {normalize, category, categoryMatches, spec, cents, money, defaults, validate, matchProduct, pricePlan};
  root.TrafficRules = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
