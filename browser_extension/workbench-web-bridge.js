/* The local workbench may request a panel, never a business action. */
(() => {
  'use strict';
  if (location.origin !== 'http://127.0.0.1:5173' || window.__wbLocalWebBridge) return;
  window.__wbLocalWebBridge = true;
  const commands = new Set(['WORKBENCH_PING','WORKBENCH_OPEN_TRAFFIC_ACCELERATOR']);
  window.addEventListener('message', async event => {
    const data = event.data;
    if (event.source !== window || event.origin !== location.origin || data?.source !== 'temu-workbench-web' || typeof data.id !== 'string' || data.id.length > 100 || !commands.has(data.command)) return;
    let result;
    try { result = await chrome.runtime.sendMessage({type:data.command}); }
    catch { result = {ok:false,error:'插件连接已失效，请刷新工作台页面后重试'}; }
    window.postMessage({source:'temu-workbench-extension',id:data.id,result},location.origin);
  });
})();
