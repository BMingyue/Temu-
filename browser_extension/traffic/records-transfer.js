/* Explicit backup of local protection records. Never starts the runner. */
(() => {
  'use strict';
  const LIMIT = 5 * 1024 * 1024;
  const KEYS = ['trafficConfig','trafficLastRun','trafficConfirmedSuccess','trafficPending','trafficImportedRuns'];
  const str = (value,max=300) => typeof value === 'string' && value.length <= max;
  const id = value => typeof value === 'string' && /^\d{1,30}$/.test(value);
  const validDate = value => str(value,40) && Number.isFinite(Date.parse(value));
  function product(value) {
    if (!value || !id(value.id) || !(value.goodsId === '' || value.goodsId === undefined || id(value.goodsId)) || !str(value.key,40) || value.key !== (value.goodsId || 'spu:' + value.id)) throw Error('商品标识或保护键无效');
    if (value.prices !== undefined && (!Array.isArray(value.prices) || value.prices.length > 200 || value.prices.some(item => !item || !str(item.spec,200) || !/^\d{1,8}(\.\d{1,2})?$/.test(String(item.price))))) throw Error('规格价格记录无效');
    if (value.runId !== undefined && !str(value.runId,100)) throw Error('任务标识无效');
    return value;
  }
  function normalize(data) {
    if (!data || data.format !== 'temu-traffic-records' || data.schemaVersion !== 1 || data.origin !== 'https://agentseller-us.temu.com' || !id(data.mallId) || !validDate(data.exportedAt)) throw Error('不是有效的流量助手记录备份，或缺少来源店铺ID');
    const value = data.storage;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('备份记录结构无效');
    const entries = value.trafficConfirmedSuccess || [];
    if (!Array.isArray(entries) || entries.length > 50000) throw Error('成功记录条数过多或格式无效');
    for (const item of entries) {
      product(item);
      if (!validDate(item.confirmedAt) || !validDate(item.expiresAt) || Date.parse(item.expiresAt) < Date.parse(item.confirmedAt) || Date.parse(item.expiresAt) - Date.parse(item.confirmedAt) > 15 * 86400000 || Date.parse(item.confirmedAt) > Date.now() + 300000) throw Error('成功保护期限无效');
    }
    if (value.trafficPending) { product(value.trafficPending); if (!validDate(value.trafficPending.time) || !str(value.trafficPending.runId,100) || !value.trafficPending.runId) throw Error('待核实记录无效'); }
    const runs = [value.trafficLastRun,...(value.trafficImportedRuns || [])].filter(Boolean);
    if (!Array.isArray(value.trafficImportedRuns || []) || runs.length > 30) throw Error('历史任务格式无效或超过30份');
    for (const run of runs) {
      if (!run || !Array.isArray(run.records) || run.records.length > 50000 || !Array.isArray(run.logs || []) || (run.logs || []).length > 50000) throw Error('任务记录格式无效');
      if (run.config) globalThis.TrafficRules.validate(run.config);
      for (const record of run.records) { product(record); if (!['success','failed','unknown','excluded','candidate','skipped'].includes(record.result)) throw Error('结果状态无效'); }
    }
    const unknown = runs.flatMap(run => run.records).filter(item => item.result === 'unknown');
    const unresolved = new Map(unknown.map(item => [item.key + ':' + item.runId,item]));
    if (value.trafficPending) unresolved.set(value.trafficPending.key + ':' + value.trafficPending.runId,value.trafficPending);
    if (unresolved.size > 1) throw Error('备份包含多个待核实结果，请先在来源助手逐项人工核实，再迁移');
    const pending = [...unresolved.values()][0];
    if (pending && (!validDate(pending.time) || !pending.runId)) throw Error('待核实结果缺少时间或任务标识');
    const config = value.trafficConfig ? globalThis.TrafficRules.validate(value.trafficConfig) : undefined;
    return {mallId:data.mallId,storage:{trafficConfig:config,trafficConfirmedSuccess:entries,trafficPending:pending,trafficLastRun:value.trafficLastRun,trafficImportedRuns:value.trafficImportedRuns || []}};
  }
  function parse(text) { if (typeof text !== 'string' || new TextEncoder().encode(text).length > LIMIT) throw Error('备份超过5MB上限'); return normalize(JSON.parse(text)); }
  function merge(existing,incoming) {
    const before = existing.trafficPending, after = incoming.trafficPending;
    if (before && after && (before.key !== after.key || before.runId !== after.runId)) throw Error('本机和备份各有不同的待核实记录，导入已取消；请先分别人工核实，原记录保留');
    const successes = new Map();
    for (const entry of [...(existing.trafficConfirmedSuccess || []),...(incoming.trafficConfirmedSuccess || [])]) {
      const old = successes.get(entry.key);
      if (!old || Date.parse(entry.expiresAt) > Date.parse(old.expiresAt)) successes.set(entry.key,entry);
    }
    const runs = [...(existing.trafficImportedRuns || []),...(incoming.trafficImportedRuns || [])];
    if (incoming.trafficLastRun && existing.trafficLastRun && JSON.stringify(incoming.trafficLastRun) !== JSON.stringify(existing.trafficLastRun)) runs.push(incoming.trafficLastRun);
    const uniqueRuns = [...new Map(runs.map(run => [String(run.runId) + ':' + String(run.time),run])).values()];
    if (uniqueRuns.length > 29) throw Error('本机历史迁移档案过多，导入已取消；请先导出备份');
    const result = {trafficConfirmedSuccess:[...successes.values()],trafficImportedRuns:uniqueRuns};
    if (before || after) result.trafficPending = before || after;
    if (!existing.trafficConfig && incoming.trafficConfig) result.trafficConfig = incoming.trafficConfig;
    if (!existing.trafficLastRun && incoming.trafficLastRun) result.trafficLastRun = incoming.trafficLastRun;
    return result;
  }
  function mount(shadow,state,onImport,exportOnly=false) {
    if (shadow.getElementById('trafficRecordsBackup')) return;
    const section = document.createElement('details'); section.id = 'trafficRecordsBackup';
    section.innerHTML = '<summary>历史记录备份' + (exportOnly ? '（迁移导出）' : '与迁移') + '</summary><p class="hint">包含14天成功保护、待核实结果、规则和任务记录，仅由你下载保存。来源店铺ID用于导入时核对；旧版未记录店铺归属，请按原记录所属店铺填写。</p><label class="label">来源店铺ID（mall ID）</label><input inputmode="numeric" data-mall placeholder="填写原记录所属店铺的数字ID"><div class="row"><button type="button" data-export class="tiny">导出完整记录JSON</button>' + (exportOnly ? '' : '<button type="button" data-import class="tiny">导入历史记录</button>') + '</div><input type="file" data-file accept=".json,application/json" class="hidden"><p class="hint" data-note></p>';
    (shadow.querySelector('.body') || shadow).append(section);
    const mall = section.querySelector('[data-mall]'), note = section.querySelector('[data-note]'), input = section.querySelector('[data-file]');
    const currentMall = async () => { const here = await chrome.runtime.sendMessage({type:'CURRENT_TAB'}); const result = await chrome.runtime.sendMessage({type:'CURRENT_MALL',tabId:here?.tabId}); if (!id(result?.mallId)) throw Error('无法核对当前店铺ID，请确认已登录当前美国站店铺后重试'); return result.mallId; };
    if (!exportOnly) currentMall().then(value => { mall.value = value; mall.readOnly = true; }).catch(() => { note.textContent = '尚未读取到当前店铺，导出时请填写原记录的来源店铺ID。'; });
    section.querySelector('[data-export]').onclick = async () => {
      try {
        if (state.running || state.starting) throw Error('请先停止任务后导出，避免备份时记录变化');
        if (!id(mall.value.trim())) throw Error('请填写原记录所属的数字店铺ID');
        const data = {format:'temu-traffic-records',schemaVersion:1,origin:'https://agentseller-us.temu.com',mallId:mall.value.trim(),exportedAt:new Date().toISOString(),storage:await chrome.storage.local.get(KEYS)};
        const body = JSON.stringify(data,null,2); parse(body);
        const url = URL.createObjectURL(new Blob([body],{type:'application/json'})), a = document.createElement('a'); a.href = url; a.download = 'temu-流量历史记录-' + data.mallId + '-' + Date.now() + '.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url),10000);
        note.textContent = '完整记录已导出。导入成功并核对数量前，请保留原插件及其本机记录。';
      } catch (error) { note.textContent = error.message; }
    };
    if (!exportOnly) {
      section.querySelector('[data-import]').onclick = () => { if (state.running || state.starting) { note.textContent = '请先停止任务后导入'; return; } input.click(); };
      input.onchange = async () => {
        let transferRun, wasReady = state.ready;
        try {
          if (state.running || state.starting) throw Error('请先停止任务后导入');
          state.ready = false;
          const file = input.files[0]; if (!file) return; if (file.size > LIMIT) throw Error('备份超过5MB上限');
          const incoming = parse(await file.text()), activeMall = await currentMall();
          if (incoming.mallId !== activeMall) throw Error('来源店铺ID与当前登录店铺不同，导入已取消');
          transferRun = crypto.randomUUID();
          const lock = await chrome.runtime.sendMessage({trafficLock:'acquire',runId:transferRun}); if (!lock?.ok) { transferRun = null; throw Error(lock?.message || '未能锁定本机记录，请先停止其他任务'); }
          if (incoming.mallId !== await currentMall()) throw Error('导入期间店铺发生变化，导入已取消');
          const existing = await chrome.storage.local.get(KEYS), patch = merge(existing,incoming.storage);
          if (new TextEncoder().encode(JSON.stringify({...existing,...patch})).length > LIMIT - 1000) throw Error('合并后的记录超过5MB上限，导入已取消');
          await chrome.storage.local.set(patch);
          try { await onImport?.(patch); } catch { note.textContent = '记录已保存，请关闭并重新打开助手核对历史。'; return; }
          note.textContent = '已合并 ' + patch.trafficConfirmedSuccess.length + ' 条成功保护；' + (patch.trafficPending ? '待核实锁保留，请核实后再运行。' : '任务保持停止，请先核对规则与记录。');
        } catch (error) { note.textContent = '未导入：' + error.message; }
        finally { if (transferRun) await chrome.runtime.sendMessage({trafficLock:'release',runId:transferRun}).catch(() => {}); state.ready = wasReady; input.value = ''; }
      };
    }
  }
  globalThis.TrafficRecordsTransfer = {mount,parse,normalize,merge,LIMIT};
})();
