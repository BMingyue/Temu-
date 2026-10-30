/* Pair with this computer; distributable sources contain no bearer token. */
const WORKBENCH_CONFIG = Object.freeze({api:"http://127.0.0.1:18769",ui:"http://127.0.0.1:5173/"});
let wbLocalToken = '', wbPairing = null;
async function wbPairLocalService() {
 if (!wbPairing) wbPairing = (async () => {
  const response = await fetch(WORKBENCH_CONFIG.api+'/api/bridge/gpt/bootstrap',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(5000)});
  if (!response.ok) throw Error('本机工作台连接失败，请先启动工作台');
  const value = await response.json();
  if (value.service !== 'temu-workbench' || !/^[a-zA-Z0-9_-]{32,200}$/.test(value.token || '')) throw Error('本机工作台配对响应无效');
  wbLocalToken = value.token;
 })().finally(() => { wbPairing = null; });
 return wbPairing;
}
async function wbBridgeFetch(url, options = {}) {
 const target = new URL(url, WORKBENCH_CONFIG.api);
 if (target.origin !== WORKBENCH_CONFIG.api || !target.pathname.startsWith('/api/')) throw Error('仅允许连接本机工作台');
 if (!wbLocalToken) await wbPairLocalService();
 const request = () => fetch(target.href,{...options,headers:{...options.headers,Authorization:'Bearer '+wbLocalToken}});
 let response = await request();
 // A rejected bearer token has not crossed the backend write boundary.
 if (response.status === 403) { wbLocalToken = ''; await wbPairLocalService(); response = await request(); }
 return response;
}
