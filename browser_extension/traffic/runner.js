(function () {
  'use strict';
  if (globalThis.__temuTrafficAssistant?.version === '1.0.6') { globalThis.__temuTrafficAssistant.show(); return; }
  if (globalThis.__temuTrafficAssistant?.state.running) return;
  document.querySelectorAll('[data-traffic-assistant]').forEach(el => el.remove());
  const R = globalThis.TrafficRules, D = globalThis.TrafficDOM;
  if (!D.allowedPage()) return;
  const host = document.createElement('div');
  host.dataset.trafficAssistant = 'true';
  const shadow = host.attachShadow({mode: 'open'});
  shadow.innerHTML = `
    <style>
      :host{all:initial;position:fixed;z-index:2147483647;right:18px;top:70px;color:#183a30;font:13px/1.6 "Microsoft YaHei",Arial,sans-serif}
      *{box-sizing:border-box}button,input,textarea{font:inherit}button{cursor:pointer;border:1px solid #d8e2dc;border-radius:8px;background:white;color:#29473c;padding:8px 11px}button:hover{background:#eef5f0}button:disabled{opacity:.4;cursor:default}button.primary{background:#176e50;color:white;border-color:#176e50}button.danger{color:#ad4c37}input,textarea{width:100%;border:1px solid #d8e2dc;border-radius:7px;padding:8px;background:#fff;color:#1c3e31}textarea{resize:vertical;min-height:56px}input:focus,textarea:focus{outline:2px solid #b7d7c5;outline-offset:1px}
      .panel{width:410px;max-height:calc(100vh - 94px);display:flex;flex-direction:column;background:#f7faf8;border:1px solid #d3e1d7;border-radius:16px;box-shadow:0 16px 58px #173e2b30;overflow:hidden}.header{display:flex;align-items:center;gap:12px;padding:18px;background:#edf4ee;border-bottom:1px solid #dce7df}.logo{font-size:24px;background:#176e50;color:white;width:40px;height:40px;border-radius:12px;text-align:center}.name{font-size:17px;font-weight:700}.sub,.muted{color:#76877e;font-size:11px}.header .tools{margin-left:auto;display:flex;gap:4px}.tools button{border:0;background:transparent;padding:3px 7px}.body{padding:18px;overflow:auto}.badge{display:inline-block;background:#e1eee5;border:1px solid #c9ddce;border-radius:20px;padding:2px 9px;color:#216440;font-size:11px}.intro{margin:9px 0 16px;color:#61776a;font-size:12px}.label{display:block;font-size:12px;font-weight:600;margin:13px 0 5px}.hint{font-size:11px;color:#7a8c80;margin:5px 0}.grid{display:grid;grid-template-columns:1fr 78px 28px;gap:6px;margin-bottom:7px}.grid button{padding:3px}.tablehead{font-size:11px;color:#76877e}.row{display:flex;gap:8px;margin-top:10px}.row>*{flex:1}.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin:14px 0}.stat{padding:10px 4px;background:white;border:1px solid #dce6de;border-radius:9px;text-align:center}.stat b{display:block;font-size:21px;color:#176e50}.stat span{font-size:10px;color:#7b8b80}.status{background:#eaf1ec;border-radius:9px;padding:11px;margin:11px 0;overflow-wrap:anywhere}.logs{background:white;border:1px solid #e0e8e1;border-radius:9px;max-height:200px;overflow:auto}.log{padding:8px 10px;border-bottom:1px solid #edf1ed;font-size:11px;overflow-wrap:anywhere}.log:last-child{border:0}.log[data-kind="failed"],.log[data-kind="unknown"]{color:#a24b37}.log[data-kind="success"]{color:#176e50}.log small{display:block;color:#92a094}.footer{padding:12px 18px;border-top:1px solid #dce7df;background:#f1f6f2;font-size:10px;color:#7d8b82}.sectionTitle{font-size:12px;font-weight:700;margin:15px 0 8px}.tiny{font-size:11px;padding:6px 8px}.mini{display:none;background:#176e50;color:white;box-shadow:0 5px 24px #163f2b30;border-radius:12px;border:0;max-width:230px;padding:12px 16px}.collapsed .panel{display:none}.collapsed .mini{display:block}.hidden{display:none!important}details{font-size:11px;color:#647a6c;margin-top:12px}summary{cursor:pointer}#errors{color:#a04432;font-size:12px;white-space:pre-wrap;margin-top:8px}.progress{height:3px;background:#deebe1;overflow:hidden}.progress.running:after{content:"";display:block;background:#3c946e;width:40%;height:100%;animation:move 1.8s infinite}@keyframes move{from{transform:translateX(-110%)}to{transform:translateX(350%)}}
      :host([data-operating="true"]){left:16px;right:auto;top:74px}.miniBar{display:none;align-items:center;gap:5px;max-width:390px}.collapsed .miniBar{display:flex}.miniActions{display:flex;gap:4px}.miniActions button{background:#f7faf8;padding:9px 10px;white-space:nowrap}.miniBar .mini{font-size:12px;padding:10px 12px}
    </style>
    <div id="wrap"><div class="miniBar"><button class="mini" id="expand">↗ 流量加速助手</button><div class="miniActions hidden" id="miniActions"><button id="miniPause">暂停</button><button class="danger" id="miniStop">停止</button></div></div><div class="panel">
      <div class="header"><div class="logo">↗</div><div><div class="name">流量加速助手</div><div class="sub">TEMU · 美国站 · v1.0.6</div></div><div class="tools"><button id="collapse" title="收起">—</button><button id="hide" title="隐藏面板">×</button></div></div>
      <div id="progress" class="progress"></div><div class="body">
        <span class="badge">持续14天 · 固定价格</span><p class="intro">同时满足类目、活动标签和开启机会才处理。将从第1页扫描至末页，先逐项校验全部规格，再提交加速。</p>
        <fieldset id="settings" style="border:0;padding:0;margin:0"><label class="label" for="categories">匹配类目（每行一个，满足任意一个）</label><textarea id="categories"></textarea><div class="hint">可填完整类目路径，或完整末级类目；不使用模糊匹配。</div>
        <label class="label" for="tags">活动标签（每行一个，必须全部满足）</label><textarea id="tags"></textarea>
        <label class="label">规格与申报价格（人民币）</label><div class="grid tablehead"><span>完整SKU规格</span><span>固定价格</span><span></span></div><div id="skuRules"></div><button class="tiny" id="addRule" type="button">＋ 添加规格</button>
        <details><summary>更多设置与规则备份</summary><label class="label" for="maxPages">最多扫描页数</label><input id="maxPages" type="number" min="1" max="2000"><label class="label" for="scanPageSeconds">扫描翻页间隔（秒，至少15秒）</label><input id="scanPageSeconds" type="number" min="15" max="120"><div class="hint">默认30秒；只扫描一轮，服务器异常时停止，不自动重扫。</div><label class="label" for="delayMs">商品内每次操作间隔（毫秒）</label><input id="delayMs" type="number" min="300" max="10000"><div class="row"><button id="exportRules" class="tiny" type="button">导出规则</button><button id="importRules" class="tiny" type="button">导入规则</button><button id="reset" class="tiny" type="button">恢复默认</button></div><input type="file" accept=".json,application/json" id="file" class="hidden"></details></fieldset>
        <div id="errors"></div><div class="row" id="startActions"><button id="scan">只读扫描</button><button class="primary" id="start">一键开启</button></div><div class="hint">“只读扫描”只读取列表和翻页，不打开报名窗口或填写价格。扫描总数必须与网站总数一致。</div>
        <div class="row hidden" id="runActions"><button id="pause">暂停</button><button id="stop" class="danger">停止</button></div>
        <div class="stats" style="grid-template-columns:repeat(6,1fr)"><div class="stat"><b id="read">0</b><span>已读取</span></div><div class="stat"><b id="matched">0</b><span>符合</span></div><div class="stat"><b id="seen">0</b><span>已处理</span></div><div class="stat"><b id="success">0</b><span>成功</span></div><div class="stat"><b id="failed">0</b><span>失败</span></div><div class="stat"><b id="unknown">0</b><span>待核实</span></div></div>
        <div id="status" class="status">就绪 · 建议先仅扫描，核对匹配范围。</div><div class="sectionTitle">处理记录</div><div class="logs" id="logs"><div class="log">尚未运行</div></div><div class="row"><button id="exportResults" class="tiny">导出结果CSV</button><button id="diagnose" class="tiny">导出页面诊断</button></div>
      </div><div class="footer">仅在当前页面操作 · 不采集登录凭据 · 规则和记录保存在本机</div>
    </div></div>`;
  document.documentElement.append(host);
  const $ = id => shadow.getElementById(id);
  const state = {ready: false, running: false, paused: false, stop: false, committed: false, step: '', lastError: null, logs: [], records: [], successful: new Set(), counts: {read: 0, seen: 0, matched: 0, success: 0, failed: 0, unknown: 0}};
  let loadedConfig = R.validate(R.defaults);
  let activeConfig, runId, heartbeat, persistQueue = Promise.resolve();
  function setStatus(message) { $('status').textContent = message; $('expand').textContent = '↗ ' + message.slice(0, 25); }
  function refreshCounts() { for (const [key, value] of Object.entries(state.counts)) $(key).textContent = value; }
  function log(message, kind = 'info', id = '') {
    state.logs.push({time: new Date().toISOString(), message, kind, id});
    const fragment = document.createDocumentFragment();
    for (const item of state.logs.slice(-60).reverse()) {
      const node = document.createElement('div'); node.className = 'log'; node.dataset.kind = item.kind;
      const small = document.createElement('small'); small.textContent = new Date(item.time).toLocaleTimeString('zh-CN', {hour12: false}) + (item.id ? ' · SPU ' + item.id : '');
      node.append(small, document.createTextNode(item.message)); fragment.append(node);
    }
    $('logs').replaceChildren(fragment);
  }
  function persist() {
    const snapshot = JSON.parse(JSON.stringify({config: activeConfig || loadedConfig, runId, records: state.records, logs: state.logs, counts: state.counts, coverage:state.coverage, scanScope:state.scanScope, step:state.step, lastError:state.lastError, status: $('status').textContent, time: new Date().toISOString()}));
    persistQueue = persistQueue.catch(() => {}).then(() => chrome.storage.local.set({trafficLastRun: snapshot}));
    return persistQueue;
  }
  function record(product, result, reason, prices = []) {
    state.records.push({runId, page: state.page, id: product.id, goodsId:product.goodsId || '', key:product.key, title: product.title, category: product.category, tags: product.tags.join(' / '), result, reason, prices, time: new Date().toISOString()});
    if (result === 'success') { state.counts.success++; state.successful.add(product.key); }
    if (result === 'failed') state.counts.failed++;
    if (result === 'unknown') state.counts.unknown++;
    refreshCounts();
    return persist();
  }
  async function rememberSuccess(product, prices, source) {
    const {trafficConfirmedSuccess=[]} = await chrome.storage.local.get('trafficConfirmedSuccess');
    const now = Date.now();
    const entries = trafficConfirmedSuccess.filter(item => Date.parse(item.expiresAt) > now && item.key !== product.key);
    entries.push({id:product.id, goodsId:product.goodsId, key:product.key, prices, runId, source, confirmedAt:new Date(now).toISOString(), expiresAt:new Date(now + 14 * 86400000).toISOString()});
    await chrome.storage.local.set({trafficConfirmedSuccess:entries});
    state.successful.add(product.key);
  }
  function ruleRow(rule = {spec: '', price: ''}) {
    const row = document.createElement('div'); row.className = 'grid';
    const spec = document.createElement('input'); spec.value = rule.spec; spec.placeholder = '如40*50in-法兰绒'; spec.setAttribute('aria-label', '完整SKU规格');
    const price = document.createElement('input'); price.value = rule.price; price.inputMode = 'decimal'; price.placeholder = '元'; price.setAttribute('aria-label', '固定价格');
    const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '×'; remove.title = '删除规格'; remove.onclick = () => row.remove();
    row.append(spec, price, remove); $('skuRules').append(row);
  }
  function populate(config) {
    loadedConfig = R.validate(config);
    $('categories').value = config.categories.join('\n'); $('tags').value = config.tags.join('\n');
    $('maxPages').value = loadedConfig.maxPages; $('delayMs').value = loadedConfig.delayMs; $('scanPageSeconds').value = loadedConfig.scanPageDelayMs / 1000;
    $('skuRules').replaceChildren(); config.skuRules.forEach(ruleRow);
  }
  function readConfig() {
    return R.validate({...loadedConfig, duration: 14,
      categories: $('categories').value.split(/\r?\n/).map(x => x.trim()).filter(Boolean),
      tags: $('tags').value.split(/\r?\n/).map(x => x.trim()).filter(Boolean),
      skuRules: [...$('skuRules').children].map(row => ({spec: row.children[0].value.trim(), price: row.children[1].value.trim()})),
      maxPages: Number($('maxPages').value), delayMs: Number($('delayMs').value), scanPageDelayMs: Number($('scanPageSeconds').value) * 1000});
  }
  function download(filename, content, type) {
    const blob = new Blob([content], {type}), url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
  const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
  function csvCell(value) {
    let s = String(value ?? '');
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  }
  async function gate() {
    if (!D.allowedPage()) throw new Error('页面已离开流量分析，任务停止');
    if (state.stop) throw new Error('用户已停止');
    const problem = D.serverProblem();
    if (problem) throw Object.assign(new Error('服务器或网络异常，停止后续操作，未自动重试：' + problem), {fatalServer: true});
    while (state.paused && !state.stop) await new Promise(resolve => setTimeout(resolve, 150));
    if (state.stop) throw new Error('用户已停止');
  }
  async function waitFor(fn, description, options = {}) {
    let deadline = Date.now() + (options.timeout || activeConfig.timeoutMs);
    let lastError;
    while (Date.now() < deadline) {
      if (!options.observeOnly) { const before = Date.now(); await gate(); deadline += Date.now() - before; }
      try { const value = fn(); if (value) return value; } catch (error) { lastError = error; }
      await new Promise(resolve => setTimeout(resolve, 120));
    }
    throw Object.assign(new Error(description + '等待超时' + (lastError ? '：' + lastError.message : '')), {priceCheck:lastError?.priceCheck});
  }
  async function settle(ms = activeConfig.delayMs) {
    await gate(); await new Promise(resolve => setTimeout(resolve, ms)); await gate();
  }
  async function act(element) { await gate(); D.click(element); await settle(); }
  async function stableList() {
    let previous = '', repetitions = 0;
    return waitFor(() => {
      if (D.loading()) { repetitions = 0; return false; }
      const fingerprint = D.fingerprint();
      repetitions = fingerprint && fingerprint === previous ? repetitions + 1 : 0;
      previous = fingerprint;
      return repetitions >= 3 ? fingerprint : false;
    }, '商品列表稳定');
  }
  async function cleanup() {
    const modal = D.priceDialog();
    if (modal) { D.click(D.control(modal, ['取消'])); await new Promise(resolve => setTimeout(resolve, 300)); }
    const confirm = D.confirmation();
    if (confirm) { D.click(D.control(confirm, ['取消'])); await new Promise(resolve => setTimeout(resolve, 300)); }
    const drawer = D.drawer();
    if (drawer) { D.closeDrawer(drawer); await new Promise(resolve => setTimeout(resolve, 400)); }
    if (D.priceDialog() || D.confirmation() || D.drawer()) throw new Error('窗口未关闭，停止以免处理错商品');
  }
  async function processProduct(product) {
    let prices = [], tracker = null, outcomeRecorded = false;
    state.committed = false;
    const phase = message => { state.step = message; setStatus('SPU ' + product.id + ' · ' + message); };
    try {
      phase('重新核对商品');
      await D.refreshIdentities();
      const live = D.products().filter(p => p.key === product.key);
      if (live.length !== 1 || !R.matchProduct(live[0], activeConfig).ok) throw new Error('点击前重新核验商品失败');
      await act(D.control(live[0].element, ['立即开启']));
      let drawer = await waitFor(D.drawer, '流量加速器窗口');
      D.verifyIdentity(drawer, product, activeConfig);
      phase('选择持续14天');
      await gate(); D.select14(drawer); await settle();
      await waitFor(() => D.is14Selected(D.drawer()), '持续14天选中状态');
      await act(D.getMore(D.drawer()));
      let modal = await waitFor(D.priceDialog, '调整申报价窗口');
      phase('核对全部规格和价格');
      const initialPlan = R.pricePlan(D.readPriceRows(modal), activeConfig);
      prices = initialPlan.map(({spec, target}) => ({spec, price: R.money(target)}));
      // Check every row before writing any price. Re-query after each change to handle reactive rerenders.
      for (const item of initialPlan) {
        phase('填写 ' + item.spec);
        await gate();
        modal = D.priceDialog();
        const currentPlan = R.pricePlan(D.readPriceRows(modal), activeConfig);
        const current = currentPlan.find(x => R.spec(x.spec) === R.spec(item.spec));
        if (!current || currentPlan.length !== initialPlan.length) throw new Error('填写过程中SKU列表发生变化');
        D.setValue(current.input, current.price); await settle();
      }
      modal = D.priceDialog();
      const finalPlan = R.pricePlan(D.readPriceRows(modal), activeConfig);
      if (finalPlan.length !== initialPlan.length || finalPlan.some(x => !initialPlan.some(y => R.spec(x.spec) === R.spec(y.spec)))) throw new Error('确认前SKU集合发生变化');
      D.verifyValues(finalPlan);
      if (!D.is14Selected(D.drawer())) throw new Error('确认价格前，持续14天已不再选中');
      phase('确认填写的申报价');
      await act(D.control(modal, ['确认', '确定']));
      await waitFor(() => !D.priceDialog(), '价格窗口关闭');
      drawer = await waitFor(D.drawer, '价格确认后的流量加速器窗口'); D.verifyIdentity(drawer, product, activeConfig);
      if (!D.is14Selected(drawer)) throw new Error('提交前持续14天未选中');
      phase('等待并核对已选档位的对应价格');
      await waitFor(() => { const current = D.drawer(); if (!current) return false; D.verifyIdentity(current, product, activeConfig); if (!D.is14Selected(current)) throw new Error('持续14天已不再选中'); D.verifyStagedPrices(current, finalPlan); return true; }, '已选档位价格更新', {timeout: Math.min(activeConfig.timeoutMs, 10000)});
      drawer = D.drawer(); D.verifyIdentity(drawer, product, activeConfig);
      if (!D.is14Selected(drawer)) throw new Error('立即加速前持续14天未选中');
      D.verifyStagedPrices(drawer, finalPlan);
      phase('点击立即加速');
      await act(D.control(drawer, ['立即加速']));
      phase('核对加速二次确认');
      const confirmation = await waitFor(D.confirmation, '加速二次确认窗口');
      // Recheck behind the confirmation as the seller page can reset duration after price editing.
      drawer = D.drawer(); D.verifyIdentity(drawer, product, activeConfig);
      if (!D.is14Selected(drawer)) throw new Error('二次确认前持续14天未选中');
      D.verifyStagedPrices(drawer, finalPlan);
      await gate();
      // Persist pending before dispatch: a reload or lost response must never be treated as success.
      await chrome.storage.local.set({trafficPending: {id: product.id, goodsId:product.goodsId, key:product.key, prices, runId, time: new Date().toISOString()}});
      if (state.stop) { await chrome.storage.local.remove('trafficPending'); throw new Error('用户已停止'); }
      await gate();
      tracker = D.outcomeTracker();
      tracker.arm();
      state.committed = true;
      D.click(D.control(confirmation, ['确认', '确定']));
      phase('已提交，等待明确结果');
      let outcome;
      try { outcome = await waitFor(() => tracker.read(), '加速结果', {observeOnly: true, timeout: activeConfig.resultTimeoutMs}); }
      catch { throw Object.assign(new Error('已提交，但未检测到明确结果。请人工核实此SPU后再继续。'), {unknown: true}); }
      tracker.close(); tracker = null;
      if (outcome.kind !== 'success') {
        await record(product, 'failed', outcome.message, prices);
        await chrome.storage.local.remove('trafficPending');
        log(outcome.message + '，已跳过', 'failed', product.id);
      } else {
        await rememberSuccess(product, prices, 'success-message');
        await record(product, 'success', outcome.message, prices);
        await chrome.storage.local.remove('trafficPending');
        log('流量加速成功 · 持续14天', 'success', product.id);
      }
      outcomeRecorded = true;
      state.committed = false;
      await cleanup();
      if (!state.stop) await waitFor(() => !outcome.element?.isConnected || !D.visible(outcome.element) || D.text(outcome.element).trim() !== outcome.message, '本次商品提示消失');
    } catch (error) {
      tracker?.close();
      state.lastError = {id:product.id, step:state.step, message:error.message, priceCheck:error.priceCheck, time:new Date().toISOString()};
      if (error.fatalServer) throw error;
      if (error.unknown) {
        await record(product, 'unknown', error.message, prices); log(error.message, 'unknown', product.id); throw error;
      }
      if (state.committed || outcomeRecorded) {
        // A failed cleanup/storage operation after a confirmed result is terminal, never resubmit.
        throw error;
      }
      if (!state.stop) { await record(product, 'failed', error.message, prices); log(state.step + '：' + error.message, 'failed', product.id); }
      try { await cleanup(); }
      catch (cleanupError) { state.lastError.cleanupError = cleanupError.message; throw new Error(error.message + '；关闭未提交窗口也失败：' + cleanupError.message); }
      if (state.stop) throw error;
      log('未提交该商品，已关闭窗口并跳过', 'info', product.id);
    }
  }
  async function run(mode) {
    if (state.running || state.starting || !state.ready) return;
    state.starting = true;
    let acquired = false;
    try {
      $('errors').textContent = '';
      activeConfig = readConfig();
      if (D.priceDialog() || D.confirmation() || D.drawer()) throw new Error('请先关闭手动打开的加速器窗口，再开始任务');
      runId = crypto.randomUUID();
      const lock = await chrome.runtime.sendMessage({trafficLock: 'acquire', runId});
      if (!lock?.ok) throw new Error(lock?.message || '未能获得运行锁');
      acquired = true;
      // Imports and other tabs use the same lock. Read protections only after owning it.
      const {trafficPending, trafficConfirmedSuccess=[]} = await chrome.storage.local.get(['trafficPending','trafficConfirmedSuccess']);
      if (trafficPending) throw new Error('上次提交的SPU ' + trafficPending.id + '结果未确认。请先人工核实，再使用面板里的“已核实”按钮解除记录。');
      state.successful = new Set(trafficConfirmedSuccess.filter(item => Date.parse(item.expiresAt) > Date.now()).map(item => item.key));
      await chrome.storage.local.set({trafficConfig: activeConfig});
      state.running = true; host.dataset.trafficRunning = 'true'; state.stop = false; state.paused = false; state.committed = false;
      state.logs = []; state.records = []; state.coverage = []; state.scanScope = null; state.lastError = null; state.step = ''; state.counts = {read: 0, seen: 0, matched: 0, success: 0, failed: 0, unknown: 0}; refreshCounts();
      $('settings').disabled = true; $('startActions').classList.add('hidden'); $('runActions').classList.remove('hidden'); $('progress').classList.add('running'); $('pause').textContent = '暂停';
      $('miniPause').textContent = '暂停'; $('miniActions').classList.remove('hidden');
      if (mode === 'apply') { host.dataset.operating = 'true'; $('wrap').classList.add('collapsed'); }
      else delete host.dataset.operating;
      heartbeat = setInterval(async () => {
        try { const result = await chrome.runtime.sendMessage({trafficLock: 'heartbeat', runId}); if (!result?.ok) { state.stop = true; log('运行锁失效，任务停止', 'failed'); } }
        catch { state.stop = true; }
      }, 15000);
      log(mode === 'scan' ? '仅扫描开始，不打开商品窗口' : '批量开启开始：完整规格固定价格，持续14天');
      const summary = await globalThis.TrafficScanOnly.run(activeConfig, {gate,allowCompletedRemoval:mode==='apply',completedCount:()=>state.counts.success,
        onLoading: ({message}) => { state.step=message;setStatus(message+' · 等待页面，无额外请求'); },
        onScope: scope => { state.scanScope = scope; log('本轮范围：共' + scope.total + '条，每页' + scope.pageSize + '条，预计' + scope.pageCount + '页；末页' + scope.lastPageExpected + '条'); },
        onProgress: ({page, expected, observed, percent}) => { state.step = '读取第' + page + '页'; setStatus('正在读取第' + page + '页 · 已识别' + observed + '/' + expected + '条' + (percent === undefined ? '' : ' · 滚动' + percent + '%')); },
        onWait: ({seconds}) => { setStatus('放慢扫描 · 等待' + seconds + '秒后翻页，可随时停止'); }, onPage: async ({page, products, coverage}) => {
        state.coverage.push(coverage);
        state.counts.read += coverage.uniqueAdded; state.counts.matched += coverage.matched; refreshCounts();
        state.page = page.current;
        for (const product of products) {
            await gate();
            state.counts.seen++; refreshCounts();
            const match = R.matchProduct(product, activeConfig);
            if (!match.ok) { await record(product, 'excluded', match.reason); continue; }
            if (mode === 'scan') { await record(product, 'candidate', match.reason); log('符合列表条件，全部SKU将在开启时核验', 'info', product.id); continue; }
            if (state.successful.has(product.key)) { await record(product, 'skipped', '本页面本次打开期间已成功开启'); continue; }
            setStatus('第' + page.current + '页 · 处理SPU ' + product.id);
            await processProduct(product);
            await settle();
        }
        log('第' + page.current + '页读取' + coverage.scanned + '/' + coverage.expected + '条，新增' + coverage.uniqueAdded + '件，跨页重复' + coverage.duplicate + '件，新增符合' + coverage.matched + '件');
        setStatus('第' + page.current + '页 · 已读取' + state.counts.read + '/' + page.total + '件，符合' + state.counts.matched + '件，已处理' + state.counts.seen + '件');
      }});
      state.coverage = summary.pages;
      setStatus((mode === 'scan' ? '扫描完成' : '处理完成') + ' · 读取' + state.counts.read + '件，符合' + state.counts.matched + '件，已处理' + state.counts.seen + '件，成功' + state.counts.success + '件，失败' + state.counts.failed + '件，待核实' + state.counts.unknown + '件');
      log('已扫描至最后一页');
    } catch (error) {
      if (error.partial) state.coverage = error.partial.pages;
      if (state.running) { setStatus(state.stop ? '已停止 · ' + (state.committed ? '请核对最后提交的结果' : '记录已保留') : '任务已停止 · ' + error.message); log(error.message, 'failed'); }
      else $('errors').textContent = error.message;
    } finally {
      clearInterval(heartbeat);
      if (state.running) {
        state.running = false; delete host.dataset.trafficRunning;
        try { await persist(); } catch (error) { $('errors').textContent = '本机记录保存失败：' + error.message; }
      }
      if (acquired) { try { await chrome.runtime.sendMessage({trafficLock: 'release', runId}); } catch {} }
      $('settings').disabled = false; $('startActions').classList.remove('hidden'); $('runActions').classList.add('hidden'); $('progress').classList.remove('running');
      $('miniActions').classList.add('hidden');
      if (mode === 'apply') $('wrap').classList.remove('collapsed');
      try { await pendingNotice(); } finally { state.starting = false; }
    }
  }
  async function pendingNotice() {
    shadow.getElementById('pending')?.remove();
    const {trafficPending} = await chrome.storage.local.get('trafficPending');
    if (!trafficPending) return;
    const box = document.createElement('div'); box.id = 'pending'; box.className = 'status';
    const message = document.createElement('p'); message.textContent = 'SPU ' + trafficPending.id + '已提交但结果待核实，可能已成功。请核对后台实际状态，再选择对应结果；不会自动继续报名。';
    const resolvePending = async success => {
      if (state.running) return;
      const {trafficPending:current} = await chrome.storage.local.get('trafficPending');
      if (!current || current.id !== trafficPending.id || current.runId !== trafficPending.runId) { $('errors').textContent = '待核实记录已变化，请重新打开面板核对'; return; }
      const product = {...current, key:current.key || current.goodsId || 'spu:' + current.id};
      let item = state.records.find(record => record.runId === current.runId && record.id === current.id);
      if (!item) { item = {runId:current.runId, id:current.id, goodsId:current.goodsId, key:product.key, prices:current.prices || [], title:'', category:'', tags:'', time:new Date().toISOString()}; state.records.push(item); }
      item.result = success ? 'success' : 'failed'; item.reason = success ? '用户已在后台核实开启成功' : '用户已在后台核实未开启或报名失败'; item.manuallyVerified = true;
      if (success) await rememberSuccess(product, current.prices || [], 'user-confirmed');
      state.counts.success = state.records.filter(record => record.result === 'success').length;
      state.counts.failed = state.records.filter(record => record.result === 'failed').length;
      state.counts.unknown = state.records.filter(record => record.result === 'unknown').length;
      state.committed = false; refreshCounts();
      setStatus('已人工核实SPU ' + current.id + (success ? '开启成功' : '未开启') + '；任务保持停止，其余商品尚未继续');
      log(item.reason + '，更新记录并解除待核实锁', success ? 'success' : 'info', current.id);
      await persist(); await chrome.storage.local.remove('trafficPending'); box.remove(); $('errors').textContent = '';
    };
    const successButton = document.createElement('button'); successButton.textContent = '已核实开启成功'; successButton.className = 'tiny';
    const failedButton = document.createElement('button'); failedButton.textContent = '已核实未开启'; failedButton.className = 'tiny';
    successButton.onclick = () => resolvePending(true).catch(error => { $('errors').textContent = error.message; });
    failedButton.onclick = () => resolvePending(false).catch(error => { $('errors').textContent = error.message; });
    box.append(message, successButton, failedButton); $('status').after(box);
  }
  globalThis.TrafficRecordsTransfer?.mount(shadow,state,async patch=>{
    for(const item of patch.trafficConfirmedSuccess||[])if(Date.parse(item.expiresAt)>Date.now())state.successful.add(item.key);
    if(patch.trafficConfig)populate(patch.trafficConfig);
    if(patch.trafficLastRun){const saved=patch.trafficLastRun;state.records=saved.records||[];state.logs=saved.logs||[];state.counts={...state.counts,...saved.counts};state.coverage=saved.coverage||[];state.scanScope=saved.scanScope||null;runId=saved.runId;activeConfig=saved.config?R.validate(saved.config):loadedConfig;refreshCounts();setStatus('已导入历史记录 · 任务未运行');}
    await pendingNotice();
  });
  $('start').onclick = () => run('apply'); $('scan').onclick = () => run('scan');
  const togglePause = () => { state.paused = !state.paused; $('pause').textContent = state.paused ? '继续' : '暂停'; $('miniPause').textContent = $('pause').textContent; setStatus(state.paused ? (state.committed ? '已请求暂停 · 正在核实已提交结果' : '已暂停 · 点击继续恢复') : '继续处理'); };
  const requestStop = () => { state.stop = true; state.paused = false; setStatus(state.committed ? '停止已请求 · 等待当前提交结果' : '正在停止并关闭未提交窗口'); };
  $('pause').onclick = togglePause; $('miniPause').onclick = togglePause;
  $('stop').onclick = requestStop; $('miniStop').onclick = requestStop;
  $('collapse').onclick = () => $('wrap').classList.add('collapsed'); $('expand').onclick = () => $('wrap').classList.remove('collapsed');
  $('hide').onclick = () => { if (state.running) $('wrap').classList.add('collapsed'); else host.style.display = 'none'; };
  $('addRule').onclick = () => ruleRow(); $('reset').onclick = () => populate(R.defaults);
  $('exportRules').onclick = () => { try { download('temu-规则-' + stamp() + '.json', JSON.stringify(readConfig(), null, 2), 'application/json'); } catch (e) { $('errors').textContent = e.message; } };
  $('importRules').onclick = () => $('file').click();
  $('file').onchange = async () => { try { const file = $('file').files[0]; if (file) populate(R.validate(JSON.parse(await file.text()))); $('errors').textContent = ''; } catch (e) { $('errors').textContent = '导入失败：' + e.message; } $('file').value = ''; };
  $('exportResults').onclick = () => {
    const rows = [['运行ID', '页码', '商品ID(goodsId)', 'SPU ID', '商品', '类目', '活动标签', '结果', '原因', '规格价格CNY', '时间UTC']];
    const labels = {success: '加速成功', failed: '失败跳过', unknown: '待人工核实', excluded: '不匹配', candidate: '符合列表筛选（未核验SKU）', skipped: '已成功过，跳过'};
    for (const item of state.records) rows.push([item.runId, item.page, item.goodsId, item.id, item.title, item.category, item.tags, labels[item.result], item.reason, item.prices.map(x => x.spec + '=' + x.price).join('; '), item.time]);
    download('temu-加速结果-' + stamp() + '.csv', '\uFEFF' + rows.map(row => row.map(csvCell).join(',')).join('\r\n'), 'text/csv;charset=utf-8');
  };
  $('diagnose').onclick = () => { try { download('temu-页面诊断-' + stamp() + '.json', JSON.stringify({...D.diagnostics(), run:{step:state.step, lastError:state.lastError, scanScope:state.scanScope, coverage:state.coverage, counts:state.counts, status:$('status').textContent}}, null, 2), 'application/json'); } catch (e) { $('errors').textContent = e.message; } };
  globalThis.__temuTrafficAssistant = {version:'1.0.6', show() { host.style.display = ''; $('wrap').classList.remove('collapsed'); }, state};
  populate(R.defaults);
  $('start').disabled = true; $('scan').disabled = true;
  chrome.storage.local.get(['trafficConfig', 'trafficLastRun', 'trafficConfirmedSuccess']).then(async data => {
    if (data.trafficConfig) { try { populate(data.trafficConfig); } catch {} }
    for (const item of data.trafficConfirmedSuccess || []) if (Date.parse(item.expiresAt) > Date.now()) state.successful.add(item.key);
    if (data.trafficLastRun?.records) {
      state.records = data.trafficLastRun.records; state.logs = data.trafficLastRun.logs || [];
      state.counts = {...state.counts, ...data.trafficLastRun.counts};
      const coverage = data.trafficLastRun.coverage || [];
      state.counts.read = data.trafficLastRun.counts?.read ?? coverage.reduce((sum,page) => sum + page.uniqueAdded, 0);
      if (coverage.length) state.counts.matched = coverage.reduce((sum,page) => sum + page.matched, 0);
      state.counts.success = state.records.filter(record => record.result === 'success').length;
      state.counts.failed = state.records.filter(record => record.result === 'failed').length;
      state.counts.unknown = state.records.filter(record => record.result === 'unknown').length;
      runId = data.trafficLastRun.runId; activeConfig = loadedConfig;
      refreshCounts();
      state.coverage = data.trafficLastRun.coverage || []; state.scanScope = data.trafficLastRun.scanScope || null; state.lastError = data.trafficLastRun.lastError || null; state.step = data.trafficLastRun.step || '';
      log('已恢复上一次处理记录；刷新页面后任务不会自动继续');
      if (data.trafficLastRun.status) setStatus('上次记录（任务未运行） · ' + data.trafficLastRun.status);
    }
    await pendingNotice();
    if (!shadow.getElementById('pending') && /当前页码识别结果不是唯一.*0处/.test(data.trafficLastRun?.status || '')) {
      try { const current=D.pageInfo(); setStatus('分页已就绪 · 共'+current.total+'条，每页'+current.pageSize+'条'+(current.single?'，单页无需翻页':'')+'；任务未运行，请按需启动'); log('已恢复分页识别；旧停止记录保留，没有自动继续报名'); } catch {}
    }
  }).then(() => { state.ready = true; $('start').disabled = false; $('scan').disabled = false; }).catch(error => { $('errors').textContent = '读取本机记录失败：' + error.message; });
})();
