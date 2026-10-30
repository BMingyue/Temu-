(function (root) {
  'use strict';
  const R = root.TrafficRules;
  const ROWS = 'tr,[role="row"],[data-row-key],[class*="table-row"],[class*="tableRow"],[class*="table_row"]';
  const OVERLAYS = '[role="dialog"],[aria-modal="true"],[class*="modal-content"],[class*="modalContent"],[class*="ModalContent"],[class*="drawer-content"],[class*="drawerContent"],[class*="DrawerContent"]';
  const compact = R.normalize;
  const text = element => element?.innerText || '';
  let identitySnapshot = null;
  async function refreshIdentities() {
    const rows = rowCandidates();
    const beast = rows.some(row => row.getAttribute('data-testid') === 'beast-core-table-body-tr');
    if (!beast) { identitySnapshot = null; return; }
    const requestId = crypto.randomUUID();
    const data = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { document.removeEventListener('traffic-identity-response-v1', receive); reject(new Error('唯一商品ID读取超时，请重新打开插件面板')); }, 1200);
      function receive(event) {
        if (event.detail?.requestId !== requestId) return;
        clearTimeout(timer); document.removeEventListener('traffic-identity-response-v1', receive); resolve(event.detail);
      }
      document.addEventListener('traffic-identity-response-v1', receive);
      document.dispatchEvent(new CustomEvent('traffic-identity-request-v1', {detail:{requestId}}));
    });
    const ids = rows.map(row => (row.textContent || '').match(/SPU\s*ID\s*[:：]\s*(\d+)/i)?.[1]);
    if (!data.supported || data.records?.length !== ids.length || data.records.some((record,index) => record.id !== ids[index] || !/^\d+$/.test(record.goodsId))) throw new Error('商品唯一ID与表格行暂未对应，等待列表加载');
    if (new Set(data.records.map(record => record.goodsId)).size !== ids.length) throw new Error('同页出现重复商品ID，无法确认表格完整性');
    identitySnapshot = {ids:ids.join(','), records:data.records};
  }
  function visible(el) {
    if (!(el instanceof Element) || el.closest('[data-traffic-assistant]')) return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && el.getClientRects().length > 0;
  }
  function disabled(el) {
    if (el?.closest('[disabled],[aria-disabled="true"]')) return true;
    for (let node = el; node && node !== document.body; node = node.parentElement) {
      if (/(?:^|[\s_-])(?:is-)?disabled(?:$|[\s_-])|(?:item|button|pagination)Disabled/i.test(String(node.className))) return true;
    }
    return false;
  }
  function unique(elements) { return [...new Set(elements)]; }
  function exact(scope, labels) {
    const wanted = labels.map(compact);
    return [...scope.querySelectorAll('button,a,[role="button"],label,span,div,p,li,h1,h2,h3,h4')].filter(el => {
      if (!visible(el) || !wanted.includes(compact(text(el)))) return false;
      return ![...el.children].some(child => visible(child) && compact(text(child)) === compact(text(el)));
    });
  }
  function clickTargets(scope, labels) {
    return unique(exact(scope, labels).map(el => {
      const parent = el.closest('button,a,[role="button"],label');
      return parent && scope.contains(parent) ? parent : el;
    })).filter(el => !disabled(el));
  }
  function one(elements, description) {
    if (elements.length !== 1) throw new Error(description + '识别结果不是唯一（' + elements.length + '处）');
    return elements[0];
  }
  function control(scope, labels) { return one(clickTargets(scope, labels), labels.join('/')); }
  function click(el) {
    if (!visible(el) || disabled(el) || !el.isConnected) throw new Error('目标控件已消失或不可用');
    el.scrollIntoView({block: 'center', inline: 'nearest', behavior: 'instant'});
    if (typeof el.click === 'function') el.click();
    else el.dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true, composed:true, view:window}));
  }
  function allowedPage() {
    return location.origin === 'https://agentseller-us.temu.com' && /^\/main\/flux-analysis\/?$/.test(location.pathname);
  }
  function field(row, name) {
    const value = text(row).match(new RegExp(name + '\\s*[:：]\\s*([\\s\\S]*?)(?=SPU\\s*ID\\s*[:：]|经营站点\\s*[:：]|首次加入|$)', 'i'));
    return value ? value[1].trim() : '';
  }
  function rowCandidates(scope = document) {
    const found = [...scope.querySelectorAll(ROWS)].filter(el => {
      const retained = el.isConnected && (el.dataset.workbenchHidden === 'true' || el.getAttribute('data-testid') === 'beast-core-table-body-tr');
      return (visible(el) || retained) && /SPU\s*ID\s*[:：]\s*\d+/i.test(el.textContent || '');
    });
    return found.filter(el => !found.some(child => child !== el && el.contains(child)));
  }
  function readProduct(row, index) {
    const rowText = text(row) || row.textContent || '';
    const idMatches = [...rowText.matchAll(/SPU\s*ID\s*[:：]\s*(\d+)/gi)].map(x => x[1]);
    const ids = unique(idMatches);
    let category = field(row, '类目');
    const categoryItem = [...row.querySelectorAll('[class*="goodsItem"],td,[role="cell"]')].find(el => /^类目[:：]/.test(compact(el.textContent || '')) && !/SPU\s*ID/.test(el.textContent || ''));
    if (categoryItem) category = (categoryItem.textContent || '').replace(/^\s*类目\s*[:：]/, '').trim();
    const categoryTitles = [...row.querySelectorAll('[title],[data-title]')].map(el => el.getAttribute('title') || el.getAttribute('data-title')).filter(s => s && (s.includes('>') || s.startsWith('类目')) && !s.includes('SPU'));
    if (categoryTitles.length === 1) category = categoryTitles[0];
    const structuredTags = [...row.querySelectorAll('[class*="tag-module__tag"],[data-testid="beast-core-tag"],[data-traffic-product-tag]')];
    // Activity tags contain an SVG arrow in the real page, so their text span is not a leaf.
    const tags = structuredTags.length ? structuredTags.map(el => (el.textContent || '').trim()).filter(Boolean) :
      [...row.querySelectorAll('span,a,label')].filter(el => !el.querySelector('span,a,label') && (visible(el) || row.dataset.workbenchHidden === 'true')).map(el => (el.textContent || '').trim()).filter(Boolean);
    if (!structuredTags.length) tags.push(...rowText.split(/\r?\n/).map(x => x.trim()).filter(Boolean));
    const opportunity = compact(rowText).replace(/[‘’“”"'「」『』]/g, '').includes('该商品已获得开启流量加速器机会');
    const opens = clickTargets(row, ['立即开启']);
    const info = row.querySelector('[class*="leftCnt"]') || row;
    const firstItem = info.querySelector('[class*="goodsItem"]');
    const title = firstItem ? [...firstItem.querySelectorAll('style,script')].reduce((value, el) => value.replace(el.textContent || '', ''), firstItem.textContent || '').trim() : rowText.split(/\r?\n/).find(x => x.trim() && !/类目|SPU\s*ID/.test(x))?.trim() || '';
    const hidden = !visible(row);
    const id = ids.length === 1 ? ids[0] : '';
    const goodsId = identitySnapshot?.records[index]?.id === id ? identitySnapshot.records[index].goodsId : '';
    return {id, goodsId, key:goodsId || 'spu:' + id, category, tags: unique(tags), opportunity: opportunity && (opens.length === 1 || (hidden && [...row.querySelectorAll('a,button,[role="button"]')].filter(el => compact(el.textContent || '') === '立即开启').length === 1)),
      hidden, title: title.slice(0, 200), element: row};
  }
  function products() {
    const rows = rowCandidates();
    const rowIds = rows.map(row => (row.textContent || '').match(/SPU\s*ID\s*[:：]\s*(\d+)/i)?.[1]).join(',');
    if (identitySnapshot && identitySnapshot.ids !== rowIds) identitySnapshot = null;
    const values = rows.map(readProduct);
    const groups = new Map();
    for (const p of values) {
      const key = p.key || 'unknown-' + groups.size;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(p);
    }
    return [...groups.values()].map(group => {
      if (group.length === 1) return group[0];
      const complete = group.filter(p => p.category && p.opportunity);
      if (complete.length === 1) return complete[0];
      return {...group[0], opportunity: false, ambiguity: true};
    });
  }
  function overlay(title, predicate) {
    const qualifies = el => visible(el) && exact(el, [title]).length > 0 && predicate(el);
    let candidates = [...document.querySelectorAll(OVERLAYS)].filter(qualifies);
    candidates = candidates.filter(el => !candidates.some(child => child !== el && el.contains(child)));
    if (candidates.length === 1) return candidates[0];
    if (candidates.length > 1) throw new Error(title + '窗口不唯一');
    // Some component libraries render no dialog semantics. Locate the smallest complete ancestor.
    const fallback = [];
    for (const heading of exact(document, [title])) {
      for (let el = heading.parentElement; el && el !== document.body; el = el.parentElement) {
        if (qualifies(el)) { fallback.push(el); break; }
      }
    }
    const values = unique(fallback);
    if (values.length > 1) throw new Error(title + '窗口不唯一');
    return values[0] || null;
  }
  function drawer() { return overlay('流量加速器', el => clickTargets(el, ['立即加速']).length === 1 && /SPU\s*ID/i.test(text(el))); }
  function priceDialog() { return overlay('调整申报价', el => el.querySelector('input') && clickTargets(el, ['确认', '确定']).length === 1); }
  function confirmation() { return overlay('确认选择?', el => clickTargets(el, ['确认', '确定']).length === 1) || overlay('确认选择？', el => clickTargets(el, ['确认', '确定']).length === 1); }
  function verifyIdentity(el, product, config) {
    const actual = readProduct(el);
    if (actual.id !== product.id) throw new Error('窗口SPU ID与目标商品不一致');
    if (!config.categories.some(c => R.categoryMatches(actual.category, c))) throw new Error('窗口类目与配置不一致');
  }
  function durationCard(el) {
    const headings = exact(el, ['持续14天', '持续14天流量加权']);
    const cards = [];
    for (const h of headings) {
      for (let p = h; p && p !== el; p = p.parentElement) {
        const radios = p.querySelectorAll('input[type="radio"],[role="radio"]');
        if (radios.length === 1) { cards.push(p); break; }
      }
    }
    return one(unique(cards), '持续14天选项');
  }
  function is14Selected(el) {
    const card = durationCard(el);
    const radio = card.querySelector('input[type="radio"],[role="radio"]');
    return radio?.checked === true || radio?.getAttribute('aria-checked') === 'true' ||
      /(?:^|[\s_-])(?:checked|selected|active)(?:$|[\s_-])/i.test(String(radio?.className || '') + ' ' + card.className);
  }
  function select14(el) {
    const card = durationCard(el);
    const input = card.querySelector('input[type="radio"]');
    click(input && visible(input) ? input : card);
  }
  function getMore(el) {
    const matches = clickTargets(el, ['去获取']).filter(target => {
      let p = target;
      for (let i = 0; i < 4 && p && p !== el; i++, p = p.parentElement) {
        if (compact(text(p)).includes('继续让价获取更多流量')) return true;
      }
      return false;
    });
    return one(matches, '继续让价获取更多流量的去获取');
  }
  function cells(row) {
    const direct = [...row.children].filter(x => /^(TD|TH)$/.test(x.tagName) || ['cell', 'columnheader'].includes(x.getAttribute('role')) || /cell/i.test(x.className));
    return direct.length ? direct : [...row.querySelectorAll('td,th,[role="cell"],[role="columnheader"]')];
  }
  function amount(raw, label) {
    const m = raw.match(/(?:¥|￥|CNY)\s*(\d+(?:\.\d{1,2})?)(?![\d.])/i);
    if (!m) throw new Error('无法识别' + label);
    return R.cents(m[1]);
  }
  function readPriceRows(modal) {
    if (!/CNY|人民币/.test(text(modal))) throw new Error('价格窗口未明确标记人民币CNY');
    if (modal.querySelector('[class*="virtual"],[data-virtualized],[aria-rowcount]')) throw new Error('价格窗口含虚拟列表，无法确认已读到全部SKU');
    const tables = [...modal.querySelectorAll('table,[role="table"]')].filter(el => /SKU信息/.test(text(el)) && el.querySelector('input'));
    const table = one(tables.filter(el => !tables.some(child => child !== el && el.contains(child))), 'SKU价格表');
    const rows = [...table.querySelectorAll(ROWS)].filter(visible);
    const header = rows.find(row => /SKU信息/.test(text(row)) && !row.querySelector('input'));
    if (!header) throw new Error('未识别SKU表头');
    const headings = cells(header).map(x => compact(text(x)));
    const skuIndex = headings.findIndex(x => x === 'SKU信息');
    const dailyIndex = headings.findIndex(x => x.includes('日常申报价格'));
    if (skuIndex < 0 || dailyIndex < 0) throw new Error('未识别规格或日常价格列');
    const bodyRows = rows.filter(row => row.querySelector('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"])'));
    const inputs = [...table.querySelectorAll('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"])')];
    if (!bodyRows.length || bodyRows.length !== inputs.length) throw new Error('价格输入框与SKU行数量不一致');
    const hiddenRows = [...table.querySelectorAll(ROWS)].filter(row => row !== header && !row.querySelector('th,[role="columnheader"]') && cells(row).length >= headings.length && !bodyRows.includes(row));
    if (hiddenRows.length) throw new Error('存在未完整识别的SKU行');
    if (modal.querySelector('[class*="pagination"],[class*="Pagination"]')) throw new Error('SKU价格表有分页，无法确认全部规格');
    return bodyRows.map(row => {
      const columns = cells(row), input = row.querySelector('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"])');
      if (!visible(row) || !visible(input) || disabled(input) || input.readOnly) throw new Error('SKU输入框不可编辑');
      const skuCell = columns[skuIndex];
      const full = skuCell?.getAttribute('title') || skuCell?.querySelector('[title]')?.getAttribute('title') || text(skuCell).trim();
      const dailyRaw = text(columns[dailyIndex]);
      const daily = /[¥￥]|CNY/.test(dailyRaw) ? amount(dailyRaw, '日常申报价') : R.cents(dailyRaw.trim());
      const referenceMatch = text(row).match(/参考申报价格?\s*[:：]\s*([¥￥]\s*\d+(?:\.\d{1,2})?)/);
      if (!referenceMatch) throw new Error('未识别SKU参考申报价格');
      return {spec: full, daily, reference: amount(referenceMatch[1], '参考价'), input, row};
    });
  }
  function setValue(input, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    input.focus(); setter.call(input, value);
    input.dispatchEvent(new Event('input', {bubbles: true}));
    input.dispatchEvent(new Event('change', {bubbles: true}));
    input.blur();
  }
  function verifyValues(plan) {
    for (const item of plan) {
      if (!item.input.isConnected || R.cents(item.input.value) !== item.target) throw new Error('填写后的价格校验不通过：' + item.spec);
    }
  }
  function verifyStagedPrices(el, plan) {
    // Temu renders one SKU column beside the tier cards. Use its row structure;
    // the selected class is itemActive (capital A), and currency symbols are nested.
    const nativeTables = [...el.querySelectorAll('[class*="flux-shift-table_main__"]')].filter(visible);
    if (nativeTables.length) {
      const table = one(nativeTables, '加权规格价格区域');
      const tier = one([...table.children].filter(node => visible(node) && [...node.classList].some(name => name.startsWith('flux-shift-table_itemActive__'))), '已选中的加权档位');
      if ([...tier.classList].some(name => name.startsWith('flux-shift-table_beforeItem__'))) throw new Error('当前选中的是加速前档位');
      const info = one([...table.children].filter(node => [...node.classList].some(name => name.startsWith('flux-shift-table_infoItem__'))), '加权SKU区域');
      const columns = (scope, label) => [...scope.querySelectorAll('[class*="flux-shift-table_rightCnt__"]')].filter(column => [...column.querySelectorAll('[class*="flux-shift-table_skcItemTit__"]')].some(title => compact(text(title)) === label));
      const specs = columns(info, 'SKU信息'), prices = columns(tier, '对应申报价格');
      if (!specs.length || specs.length !== prices.length) throw new Error('加权档位的SKU分组与价格列不对应');
      const values = [];
      for (let index = 0; index < specs.length; index++) {
        const skuRows = [...specs[index].querySelectorAll('[class*="flux-shift-table_skuItem__"]')];
        const priceRows = [...prices[index].querySelectorAll('[class*="flux-shift-table_skuItem__"]')];
        if (!skuRows.length || skuRows.length !== priceRows.length) throw new Error('加权档位的SKU行与对应价格行数量不一致');
        if (skuRows.some(row => !visible(row)) || priceRows.some(row => !visible(row))) throw new Error('加权档位存在不可读取的规格或价格行');
        // innerText excludes the inline STYLE inserted by Beast ellipsis. textContent
        // incorrectly prepends that CSS to the SKU; the exported HTML had stripped it.
        skuRows.forEach((row, rowIndex) => values.push({spec: text(row).trim(), value: amount(text(priceRows[rowIndex]), '对应申报价')}));
      }
      const priceCheck = {expected:plan.map(item => ({spec:item.spec, price:R.money(item.target)})), actual:values.map(item => ({spec:item.spec, price:R.money(item.value)}))};
      if (values.length !== plan.length || new Set(values.map(value => R.spec(value.spec))).size !== values.length || plan.some(item => values.filter(value => R.spec(value.spec) === R.spec(item.spec) && value.value === item.target).length !== 1)) throw Object.assign(new Error('加权档位的规格与申报价不一致'), {priceCheck});
      return priceCheck;
    }
    // Require one selected tier and compare SKU -> corresponding declared price, irrespective of row order.
    const selected = [...el.querySelectorAll('[class*="selected"],[class*="checked"],[class*="active"],[aria-checked="true"],[data-state="checked"]')].filter(node => visible(node) && compact(text(node)).includes('对应申报价格'));
    const containers = selected.filter(node => !selected.some(child => child !== node && node.contains(child)));
    if (containers.length !== 1) throw new Error('未唯一识别已选中的加权档位，无法复核申报价');
    const tier = containers[0];
    const tables = [...tier.querySelectorAll('table,[role="table"]')].filter(table => /SKU信息/.test(text(table)));
    if (tables.length === 1) {
      const rows = [...tables[0].querySelectorAll(ROWS)].filter(visible);
      const header = rows.find(row => /SKU信息/.test(text(row)) && /对应申报价格/.test(text(row)));
      if (!header) throw new Error('未识别加权档位的价格表头');
      const labels = cells(header).map(cell => compact(text(cell)));
      const specIndex = labels.indexOf('SKU信息'), priceIndex = labels.indexOf('对应申报价格');
      const values = rows.filter(row => row !== header).map(row => ({spec: text(cells(row)[specIndex]).trim(), value: amount(text(cells(row)[priceIndex]), '对应申报价')}));
      if (values.length !== plan.length || plan.some(item => values.filter(x => R.spec(x.spec) === R.spec(item.spec) && x.value === item.target).length !== 1)) throw new Error('加权档位的规格与申报价不一致');
      return;
    }
    // Temu may render the SKU column once, beside all three tier cards. Pair by row position,
    // using full SKU text and only the corresponding-price column, never by a bag of prices.
    const heading = one(exact(tier, ['对应申报价格']), '对应申报价格列');
    const column = heading.getBoundingClientRect();
    const amounts = [...tier.querySelectorAll('span,div,p,td')].filter(node => {
      if (!visible(node) || !/^[¥￥]\s*\d+(?:\.\d{1,2})?$/.test(text(node).trim())) return false;
      if ([...node.children].some(child => visible(child) && text(child).trim() === text(node).trim())) return false;
      const rect = node.getBoundingClientRect(), x = rect.left + rect.width / 2;
      return x >= column.left - 35 && x <= column.right + 35 && rect.top > column.top;
    });
    const used = new Set();
    for (const item of plan) {
      const specs = [...el.querySelectorAll('span,div,p,td,[title]')].filter(node => visible(node) && R.spec(node.getAttribute('title') || text(node)) === R.spec(item.spec));
      const leaves = specs.filter(node => !specs.some(child => child !== node && node.contains(child)));
      const sku = one(leaves, '加权档位完整规格' + item.spec), rect = sku.getBoundingClientRect();
      const matches = amounts.filter(node => {
        const r = node.getBoundingClientRect();
        return Math.abs(r.top + r.height / 2 - rect.top - rect.height / 2) <= Math.max(9, rect.height * .55);
      });
      const price = one(matches, item.spec + '对应申报价');
      if (used.has(price) || amount(text(price), '对应申报价') !== item.target) throw new Error('加权档位的规格与申报价不一致：' + item.spec);
      used.add(price);
    }
  }
  function notices() {
    const candidates = [...document.querySelectorAll('[role="alert"],[role="status"],[aria-live="polite"],[aria-live="assertive"],[data-testid*="toast" i],[data-testid*="message" i],[data-testid*="notification" i],[class*="toast" i],[class*="message" i],[class*="notification" i]')];
    // Beast popup implementations may have neither alert semantics nor a toast class.
    // Find the exact result text only inside a visible notification/floating layer.
    const resultText = /^(?:[✓✔√]\s*)?(?:流量加速成功|流量加速失败|加速失败|开启失败|操作失败|系统繁忙|请求失败)(?:[，,。！!：:\s]|$)/;
    const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const value = node.textContent.trim(), parent = node.parentElement;
      if (!parent || value.length > 500 || !resultText.test(value) || parent.closest('style,script,template,noscript,[data-traffic-assistant]') || !visible(parent)) continue;
      let floating = false;
      for (let container = parent, depth = 0; container && container !== document.body && container !== document.documentElement && depth < 8; container = container.parentElement, depth++) {
        const marker = container.getAttribute('data-testid') || '';
        const style = getComputedStyle(container);
        if (/(?:toast|message|notification|popup)/i.test(marker) || ((style.position === 'fixed' || style.position === 'absolute') && Number.parseInt(style.zIndex, 10) >= 10)) { floating = true; break; }
      }
      if (floating) candidates.push(parent);
    }
    const values = unique(candidates);
    return values.filter(visible).filter(el => /流量加速成功|加速失败|开启失败|操作失败|系统繁忙|请求失败|稍后重试|不符合|价格.*(?:错误|无效)|校验失败/.test(text(el))).filter(el => !values.some(child => child !== el && visible(child) && el.contains(child) && text(child) === text(el)));
  }
  function outcomeTracker() {
    const old = new Map(notices().map(el => [el, text(el)]));
    let result = null, armed = false;
    function check() {
      if (!armed || result) return;
      for (const el of old.keys()) if (!el.isConnected || !visible(el)) old.delete(el);
      for (const el of notices()) {
        const value = text(el).trim();
        if (old.get(el) === value) continue;
        if (/流量加速成功/.test(value)) result = {kind: 'success', message: value};
        else result = {kind: 'failed', message: value};
        Object.defineProperty(result, 'element', {value:el});
      }
    }
    const observer = new MutationObserver(check);
    observer.observe(document.documentElement, {subtree: true, childList: true, characterData: true, attributes: true});
    return {arm() { armed = true; check(); }, read() { check(); return result; }, close() { observer.disconnect(); }};
  }
  function pagination() {
    const candidates = [...document.querySelectorAll('[class*="pagination"],[class*="Pagination"],[role="navigation"][aria-label*="分页"]')].filter(el => visible(el) && !el.closest(OVERLAYS));
    const roots = candidates.filter(el => !candidates.some(parent => parent !== el && parent.contains(el)));
    return one(roots, '商品分页');
  }
  function pageInfo() {
    const p = pagination();
    const footer = compact(text(p));
    const totalText = footer.match(/(?:共有|共)(\d+)条/);
    const total = totalText ? Number(totalText[1]) : null;
    const size = footer.match(/每页(\d+)/);
    const beastSize = [...p.querySelectorAll('[class*="PGT_sizeChanger"] input,[data-testid="beast-core-select-htmlInput"],select')].map(el => el.value).filter(value => /^\d+$/.test(value));
    const mirror = p.querySelector('[class*="PGT_sizeChanger"] [class*="IPT_mirror"]');
    const pageSize = beastSize.length === 1 ? Number(beastSize[0]) : size ? Number(size[1]) : mirror && /^\d+$/.test(mirror.textContent.trim()) ? Number(mirror.textContent.trim()) : null;
    const selected = [...p.querySelectorAll('[aria-current="page"],[class*="active"],[class*="Active"],[class*="selected"],[class*="Selected"]')].filter(el => visible(el) && /^\d+$/.test(text(el).trim()) && !el.closest('[role="combobox"],[role="listbox"],[class*="select"],[class*="Select"]'));
    const active = unique(selected).filter(el => !selected.some(child => child !== el && el.contains(child)));
    let next = [...p.querySelectorAll('button,a,li,[role="button"]')].filter(el => {
      const label = [el.getAttribute('aria-label'), el.getAttribute('title'), el.getAttribute('rel')].join(' ');
      const className = String(el.className);
      if (/jump[-_]?next|jump[-_]?prev/i.test(className)) return false;
      return /下一页|\bnext\b/i.test(label) || /(?:^|[\s_-])next(?:$|[\s_-])/i.test(className) || /^(?:下一页|›|»|>)$/.test(text(el).trim());
    });
    next = unique(next.map(el => el.closest('button,li,a,[role="button"]') || el)).filter(visible);
    next = next.filter(el => !next.some(parent => parent !== el && parent.contains(el)));
    const numericControls = [...p.querySelectorAll('li,button,a,[role="button"],[aria-current="page"]')].filter(el => visible(el) && /^\d+$/.test(text(el).trim()) && !el.closest('[class*="PGT_sizeChanger"],[role="listbox"],[role="combobox"]'));
    // Beast intentionally removes all page numbers and arrows when the data fits
    // on one page (PGT_alone). Derive page 1 only from explicit total and page size.
    if (active.length === 0 && numericControls.length === 0 && next.length === 0 && total !== null && pageSize > 0 && total <= pageSize) return {current:1,total,pageSize,next:null,last:true,expected:total,single:true};
    const current = Number(text(one(active, '当前页码')).trim());
    if (next.length === 0 && current === 1 && total !== null && pageSize > 0 && total <= pageSize) return {current,total,pageSize,next:null,last:true,expected:total,single:true};
    if (next.length !== 1) throw new Error('未唯一识别下一页按钮');
    if (pageSize && total !== null && current > Math.max(1,Math.ceil(total/pageSize))) throw new Error('当前页码超出列表范围，等待列表更新');
    const expected = total !== null && pageSize ? Math.max(0, Math.min(pageSize, total - (current - 1) * pageSize)) : null;
    return {current,total,pageSize,next:next[0],last:disabled(next[0]) || !!next[0].querySelector('button:disabled,[aria-disabled="true"]'),expected,single:total !== null && pageSize > 0 && total <= pageSize};
  }
  function firstPage() { if(pageInfo().current!==1)click(control(pagination(), ['1'])); }
  async function pauseUpdater() {
    const bar=document.getElementById('wbDailyBar');
    const button=bar&&[...bar.querySelectorAll('button')].find(el=>text(el).trim()==='暂停自动更新');
    if(!button)return false;
    if(/正在采集|采集中|正在更新/.test([...bar.children].filter(el=>el.tagName==='DIV').map(text).join(' ')))throw new Error('原工作台正在采集，请等它完成后再扫描，避免同时翻页');
    click(button);await new Promise(resolve=>setTimeout(resolve,700));
    if(![...bar.querySelectorAll('button')].some(el=>text(el).trim()==='开启自动更新'))throw new Error('未能暂停原工作台的并发自动更新');
    return true;
  }
  async function restoreUpdater() {
    const bar=document.getElementById('wbDailyBar');
    const button=bar&&[...bar.querySelectorAll('button')].find(el=>text(el).trim()==='开启自动更新');
    if(button){click(button);await new Promise(resolve=>setTimeout(resolve,300))}
  }
  function scrollArea() {
    const p = products()[0]?.element;
    for (let el = p?.parentElement; el && el !== document.body; el = el.parentElement) {
      if (el.scrollHeight > el.clientHeight + 40 && /(auto|scroll)/.test(getComputedStyle(el).overflowY)) return el;
    }
    return document.scrollingElement;
  }
  async function revealRows(check=async()=>{}, report=()=>{}) {
    const area=scrollArea();
    if(!area)return;
    area.scrollTop=0;await new Promise(resolve=>setTimeout(resolve,150));
    for(let steps=0;steps<600;steps++){
      await check();
      if(area.scrollTop+area.clientHeight>=area.scrollHeight-5)break;
      const before=area.scrollTop;
      area.scrollTop=Math.min(area.scrollTop+Math.max(200,area.clientHeight*.7),area.scrollHeight);
      report({percent:Math.min(100,Math.round((area.scrollTop+area.clientHeight)/Math.max(1,area.scrollHeight)*100))});
      await new Promise(resolve=>setTimeout(resolve,750));
      if(area.scrollTop===before)break;
    }
    area.scrollTop=0;await new Promise(resolve=>setTimeout(resolve,200));
  }
  function fingerprint() { return products().map(p => p.id).filter(Boolean).join(','); }
  function loading() { return [...document.querySelectorAll('[aria-busy="true"],[class*="loading-spinning"],[class*="spin-spinning"]')].some(visible); }
  function serverProblem() {
    const candidates = document.querySelectorAll('[role="alert"],[class*="toast"],[class*="message"],[class*="Message"],[class*="notification"],[class*="error"],[class*="Error"],[class*="empty"],[class*="Empty"],h1,h2,p');
    const pattern = /服务器.{0,8}(?:无响应|繁忙|异常|错误)|服务不可用|系统繁忙|(?:访问|操作|请求)过于频繁|请求频繁|请求失败|请求超时|网络异常|too many requests|service unavailable/i;
    for (const el of candidates) {
      if (!visible(el) || el.closest('#wbDailyBar')) continue;
      const value = text(el).trim();
      if (value.length <= 240 && pattern.test(value)) return value;
    }
    return '';
  }
  function drawerCloseControl(el) {
    const selector = '[aria-label],[title],[data-testid="beast-core-icon-close"],[data-testid*="drawer-close"],[data-testid*="drawerClose"],[class*="drawer-close"],[class*="drawerClose"],[class*="DrawerClose"],[class*="closeIcon"],[class*="close-icon"],[class*="index-module__close"],button,[role="button"]';
    for (let scope = el, depth = 0; scope && scope !== document.body && scope !== document.documentElement && depth < 6; scope = scope.parentElement, depth++) {
      // The X can be a sibling of the drawer body. Never expand into the product list
      // or another drawer when looking for it.
      if (scope.querySelector('[data-testid="beast-core-table-body-tr"]')) break;
      const bodies = scope.querySelectorAll('[data-testid="bgb-pc-show-drawer-body"]');
      if (bodies.length > 1) break;
      const candidates = [...scope.querySelectorAll(selector)].filter(node => {
        if (!visible(node)) return false;
        const label = node.getAttribute('aria-label') || node.getAttribute('title') || '';
        return node.getAttribute('data-testid') === 'beast-core-icon-close' || /^(?:关闭|关闭窗口|close)$/i.test(label) || /drawer-?close|drawerClose|closeIcon|close-icon|index-module__close/.test(String(node.className) + ' ' + node.getAttribute('data-testid')) || /^(?:×|✕|✖)$/.test(text(node).trim());
      });
      const targets = unique(candidates.map(node => { const button = node.closest('button,a,[role="button"]'); return button && scope.contains(button) ? button : node; }));
      const leaves = targets.filter(node => !targets.some(child => child !== node && node.contains(child)));
      if (leaves.length === 1) return leaves[0];
      if (leaves.length > 1) break;
    }
    throw new Error('无法唯一识别抽屉关闭按钮，请手动关闭后重新运行');
  }
  function closeDrawer(el) { click(drawerCloseControl(el)); }
  function diagnostics() {
    const clean = el => {
      const copy = el.cloneNode(true);
      copy.querySelectorAll('script,style,iframe,img,svg').forEach(x => x.remove());
      copy.querySelectorAll('*').forEach(x => [...x.attributes].forEach(a => {
        if (!['class', 'role', 'title', 'aria-label', 'aria-checked', 'aria-current', 'aria-disabled', 'type', 'disabled', 'data-row-key'].includes(a.name)) x.removeAttribute(a.name);
      }));
      copy.querySelectorAll('input').forEach(x => x.removeAttribute('value'));
      return copy.outerHTML.slice(0, 65000);
    };
    let rows = [], pager = null;
    try { rows = products().slice(0, 3); } catch {}
    try { pager = clean(pagination()); } catch {}
    let modal = null;
    try { modal = priceDialog() || drawer(); } catch {}
    let pageStats = null;
    try { const info = pageInfo(); pageStats = {current:info.current, total:info.total, pageSize:info.pageSize, expected:info.expected}; } catch {}
    let stagedText = null;
    try { const current = drawer(); if (current) stagedText = [...current.querySelectorAll('[class*="flux-shift-table_skuItem__"]')].map(row => ({displayed:text(row).trim(), raw:(row.textContent || '').slice(0,1500)})); } catch {}
    return {version: '1.0.6', page: location.origin + location.pathname, time: new Date().toISOString(), pageStats, stagedText,
      products: rows.map(p => ({id: p.id, goodsId:p.goodsId, key:p.key, category: p.category, tags: p.tags, opportunity: p.opportunity, html: clean(p.element)})), pagination: pager, dialog: modal ? clean(modal) : null};
  }
  root.TrafficDOM = {visible, disabled, text, exact, control, click, allowedPage, refreshIdentities, products, drawer, priceDialog, confirmation, verifyIdentity, select14, is14Selected, getMore, readPriceRows, setValue, verifyValues, verifyStagedPrices, outcomeTracker, notices, pageInfo, firstPage, pauseUpdater, restoreUpdater, scrollArea, revealRows, fingerprint, loading, serverProblem, drawerCloseControl, closeDrawer, diagnostics};
})(globalThis);
