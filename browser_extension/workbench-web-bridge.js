/* The local workbench may request a panel, never a business action. */
(async () => {
  'use strict';
  const ORIGIN = 'http://127.0.0.1:5173';
  if (location.origin !== ORIGIN) return;
  const VERSION = 'local_web_bridge_v2';
  const ATTRIBUTE = 'data-temu-workbench-bridge-instance';
  const runtime = chrome.runtime;
  const root = document.documentElement;
  const previous = window.__wbLocalWebBridge;
  // Worker wake-ups can reinject this file. Keep a live bridge; an orphan left
  // by extension reload must prove its captured runtime still answers a PING.
  if (previous?.protocol === 2 && previous.version === VERSION && typeof previous.verify === 'function') {
    try {
      let timer;
      const alive = await Promise.race([
        previous.verify(),
        new Promise(resolve => { timer = setTimeout(() => resolve(false),750); }),
      ]).finally(() => clearTimeout(timer));
      if (alive && previous.isActive()) { previous.announce(); return; }
    } catch {}
  }
  const replacement = window.__wbLocalWebBridge;
  if (replacement !== previous && replacement?.protocol === 2 && replacement.version === VERSION && replacement.isActive()) {
    replacement.announce();
    return;
  }
  try { previous?.dispose?.(); } catch {}
  const instance = typeof crypto?.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let disposed = false;
  const active = () => !disposed && root?.getAttribute(ATTRIBUTE) === instance;
  const metadata = {bridgeProtocol:2,bridgeVersion:VERSION,bridgeInstance:instance};
  const announce = () => {
    if (active()) window.postMessage({source:'temu-workbench-extension',event:'WORKBENCH_BRIDGE_READY',...metadata},ORIGIN);
  };
  const reply = (id,result) => {
    if (active()) window.postMessage({source:'temu-workbench-extension',id,result:{...result,...metadata}},ORIGIN);
  };
  const commands = new Set(['WORKBENCH_PING','WORKBENCH_OPEN_TRAFFIC_ACCELERATOR']);
  const receive = async event => {
    const data = event.data;
    if (!active() || event.source !== window || event.origin !== ORIGIN || data?.source !== 'temu-workbench-web' || typeof data.id !== 'string' || !data.id || data.id.length > 100 || !commands.has(data.command)) return;
    if (data.command === 'WORKBENCH_OPEN_TRAFFIC_ACCELERATOR' && data.bridgeInstance !== instance) {
      reply(data.id,{ok:false,code:'BRIDGE_GENERATION_CHANGED',retryable:true,error:'插件连接已更新，请重新检测后再打开面板'});
      return;
    }
    const mall = typeof data.mallId === 'string' ? data.mallId.trim() : '';
    if (data.command === 'WORKBENCH_OPEN_TRAFFIC_ACCELERATOR' && !/^\d{1,40}$/.test(mall)) {
      reply(data.id,{ok:false,code:'INVALID_MALL_SCOPE',error:'工作台店铺编号无效，请重新选择店铺'});
      return;
    }
    let result;
    try {
      result = await runtime.sendMessage({type:data.command,...(data.command === 'WORKBENCH_OPEN_TRAFFIC_ACCELERATOR' ? {expectedMallId:mall} : {})});
      if (!result || typeof result !== 'object') result = {ok:false,code:'BRIDGE_NO_RESPONSE',retryable:true,error:'插件没有返回连接结果，请重新检测'};
    } catch {
      result = {ok:false,code:'EXTENSION_CONTEXT_INVALIDATED',retryable:true,error:'插件连接已失效，请刷新工作台页面后重试'};
    }
    reply(data.id,result);
  };
  root?.setAttribute(ATTRIBUTE,instance);
  window.__wbLocalWebBridge = {
    protocol:2,version:VERSION,instance,
    isActive:active,announce,
    verify:async () => {
      if (!active()) return false;
      try { return (await runtime.sendMessage({type:'WORKBENCH_PING'}))?.ok === true; } catch { return false; }
    },
    dispose:() => {
      disposed = true;
      window.removeEventListener('message',receive);
      if (root?.getAttribute(ATTRIBUTE) === instance) root.removeAttribute(ATTRIBUTE);
    },
  };
  window.addEventListener('message',receive);
  announce();
})().catch(() => {});
