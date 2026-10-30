/* Shared traffic runner lock and explicit, panel-only launch. */
(() => {
  'use strict';
  const TARGET = 'https://agentseller-us.temu.com/main/flux-analysis';
  const VISIBILITY = 'workbench.panel.visibility.v1';
  const allowed = url => { try { const u = new URL(url); return u.origin === 'https://agentseller-us.temu.com' && /^\/main\/flux-analysis\/?$/.test(u.pathname) && !u.searchParams.has('wb_accelerator_status') && !u.searchParams.has('wb_auto_flow'); } catch { return false; } };
  let queue = Promise.resolve(), opening = null;
  globalThis.wbTrafficActive = true;
  const initialized = chrome.storage.session.get('trafficLease').then(async ({trafficLease}) => {
    if (!trafficLease) return;
    const tab = await chrome.tabs.get(trafficLease.tabId).catch(() => null);
    if (!tab || !allowed(tab.url)) await chrome.storage.session.remove('trafficLease');
  }).finally(async () => { globalThis.wbTrafficActive = Boolean((await chrome.storage.session.get('trafficLease')).trafficLease); });
  async function releaseTab(tabId) {
    queue = queue.catch(() => {}).then(async () => {
      await initialized;
      const {trafficLease} = await chrome.storage.session.get('trafficLease');
      if (trafficLease?.tabId === tabId) { await chrome.storage.session.remove('trafficLease'); globalThis.wbTrafficActive = false; }
    });
    return queue;
  }
  async function waitLoaded(tabId) {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === 'complete') { if (!allowed(tab.url)) throw Error('请先完成美国站登录，再从工作台打开流量加速器'); return tab; }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw Error('Temu 页面仍在加载，请完成登录后重试');
  }
  async function openPanel(sender) {
    const tabs = (await chrome.tabs.query({url:'https://agentseller-us.temu.com/main/flux-analysis*'})).filter(tab => allowed(tab.url));
    const [active] = await chrome.tabs.query({active:true,currentWindow:true});
    let tab = tabs.find(item => item.id === sender.tab?.id) || tabs.find(item => item.id === active?.id);
    if (!tab && tabs.length > 1) throw Error('已打开多个美国站流量页，请先切到要操作的店铺页面，再点击插件中的流量加速器');
    if (!tab) tab = tabs[0] || await chrome.tabs.create({url:TARGET,active:true});
    await chrome.tabs.update(tab.id,{active:true});
    await waitLoaded(tab.id);
    const saved = (await chrome.storage.local.get(VISIBILITY))[VISIBILITY] || {};
    await chrome.storage.local.set({[VISIBILITY]:{...saved,traffic:true}});
    await chrome.scripting.executeScript({target:{tabId:tab.id},world:'MAIN',files:['traffic/identity-reader.js']});
    await chrome.scripting.executeScript({target:{tabId:tab.id},files:['traffic/rules.js','traffic/adapter.js','traffic/scan-only.js','traffic/records-transfer.js','traffic/runner.js']});
    return {ok:true,tabId:tab.id,panelOnly:true};
  }
  chrome.runtime.onMessage.addListener((message,sender,respond) => {
    if (sender.id !== chrome.runtime.id) return false;
    const source = sender.tab?.url || sender.url || '';
    let trusted = false;
    try { const origin = new URL(source).origin; trusted = origin === 'http://127.0.0.1:5173' || /^https:\/\/agentseller(?:-us)?\.temu\.com$/.test(origin) || source.startsWith(chrome.runtime.getURL('')); } catch {}
    if (['WORKBENCH_PING','WORKBENCH_OPEN_TRAFFIC_ACCELERATOR'].includes(message?.type) && !trusted) return false;
    if (['WORKBENCH_COLLECTOR_STATUS','WORKBENCH_COLLECTOR_RESERVE','WORKBENCH_COLLECTOR_COMMIT'].includes(message?.type)) {
      const statusOnly=message.type==='WORKBENCH_COLLECTOR_STATUS';
      if (!sender.tab || !/^https:\/\/(?:agentseller(?:-us)?|ads)\.temu\.com\//.test(sender.tab.url || '') || (!statusOnly && (typeof message.runId !== 'string' || !/^[a-zA-Z0-9-]{8,80}$/.test(message.runId)))) return false;
      queue = queue.catch(() => {}).then(async () => {
        await initialized;
        const saved = await chrome.storage.session.get(['trafficLease','trafficManualReservation']);
        if (statusOnly) return saved.trafficLease ? {ok:false,error:'流量加速器正在运行，请先停止后再采集'} : {ok:true};
        const old = saved.trafficManualReservation;
        if (message.type === 'WORKBENCH_COLLECTOR_COMMIT') {
          if (old?.tabId === sender.tab.id && old.runId === message.runId) await chrome.storage.session.remove('trafficManualReservation');
          return {ok:true};
        }
        if (saved.trafficLease) return {ok:false,error:'流量加速器正在运行，请先停止后再采集'};
        if (old && old.expiresAt > Date.now()) return {ok:false,error:'另一个采集任务正在启动，请稍后重试'};
        await chrome.storage.session.set({trafficManualReservation:{tabId:sender.tab.id,runId:message.runId,expiresAt:Date.now()+60000}});
        return {ok:true};
      });
      queue.then(respond,error=>respond({ok:false,error:String(error.message || error)})); return true;
    }
    if (message?.type === 'WORKBENCH_PING') { respond({ok:true,version:chrome.runtime.getManifest().version,capabilities:['traffic-accelerator']}); return false; }
    if (message?.type === 'WORKBENCH_OPEN_TRAFFIC_ACCELERATOR') {
      if (!opening) opening = openPanel(sender).finally(() => { opening = null; });
      opening.then(respond,error => respond({ok:false,error:String(error.message || error)})); return true;
    }
    if (!['acquire','release','heartbeat'].includes(message?.trafficLock) || !sender.tab || !allowed(sender.tab.url) || typeof message.runId !== 'string' || !/^[a-zA-Z0-9-]{8,80}$/.test(message.runId)) return false;
    // Reserve before awaiting storage so an automatic collector cannot win the same turn.
    if (message.trafficLock === 'acquire') globalThis.wbTrafficActive = true;
    queue = queue.catch(() => {}).then(async () => {
      await initialized;
      const tabId = sender.tab.id, {trafficLease} = await chrome.storage.session.get('trafficLease');
      if (message.trafficLock === 'acquire') {
        globalThis.wbTrafficActive = true;
        if (trafficLease && trafficLease.runId !== message.runId) {
          const exists = await chrome.tabs.get(trafficLease.tabId).catch(() => null);
          if (exists) return {ok:false,message:'另一个流量加速任务仍占用运行锁，请先停止它或关闭原标签页'};
        }
        const reservation = (await chrome.storage.session.get('trafficManualReservation')).trafficManualReservation;
        const manual = (await chrome.storage.local.get('temuCollectorState.v2'))['temuCollectorState.v2'];
        const busy = (typeof wbAutoRunning !== 'undefined' && wbAutoRunning) || (typeof wbControlPolling !== 'undefined' && wbControlPolling) || (typeof wbScheduledRunning !== 'undefined' && wbScheduledRunning) || manual?.status === 'running' || (manual?.status === 'paused' && !manual.endedAt);
        if (busy || (reservation && reservation.expiresAt > Date.now())) { globalThis.wbTrafficActive = Boolean(trafficLease); return {ok:false,message:'工作台正在采集或等待继续采集，请先完成或停止采集，再运行流量加速器'}; }
        await chrome.storage.session.set({trafficLease:{tabId,runId:message.runId,updated:Date.now()}});
        return {ok:true};
      }
      if (trafficLease?.tabId !== tabId || trafficLease.runId !== message.runId) return {ok:false,message:'运行锁已失效，任务停止'};
      if (message.trafficLock === 'release') { await chrome.storage.session.remove('trafficLease'); globalThis.wbTrafficActive = false; }
      else { globalThis.wbTrafficActive = true; await chrome.storage.session.set({trafficLease:{...trafficLease,updated:Date.now()}}); }
      return {ok:true};
    });
    queue.then(respond,error => respond({ok:false,message:String(error.message || error)})); return true;
  });
  chrome.tabs.onRemoved.addListener(releaseTab);
  chrome.tabs.onUpdated.addListener((tabId,change) => { if (change.status === 'loading') releaseTab(tabId); });
})();
