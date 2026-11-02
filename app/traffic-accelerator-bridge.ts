export type ExtensionReply = {
  ok?: boolean;
  error?: string;
  code?: string;
  retryable?: boolean;
  version?: string;
  capabilities?: string[];
  message?: string;
  panelOnly?: boolean;
  mallId?: string;
  bridgeProtocol?: number;
  bridgeVersion?: string;
  bridgeInstance?: string;
};
export type ExtensionCommand = 'WORKBENCH_PING' | 'WORKBENCH_OPEN_TRAFFIC_ACCELERATOR';
type RequestOptions = {timeoutMs?:number; bridgeInstance?:string; mallId?:string};
export class ExtensionConnectionError extends Error {
  constructor(message:string,public code:string){super(message);this.name='ExtensionConnectionError';}
}
export const isCurrentBridge=(reply:ExtensionReply)=>reply.bridgeProtocol===2&&typeof reply.bridgeInstance==='string'&&reply.bridgeInstance.length>0;

// A reloaded extension can leave an invalidated legacy listener in this page.
// Only a valid reply from the current bridge may settle a directed request.
export function extensionRequest(command:ExtensionCommand,signal:AbortSignal,{timeoutMs=5000,bridgeInstance,mallId}:RequestOptions={}):Promise<ExtensionReply>{
 return new Promise((resolve,reject)=>{
  if(signal.aborted){reject(new ExtensionConnectionError('页面已关闭','ABORTED'));return;}
  if(window.location.origin!=='http://127.0.0.1:5173'){
   reject(new ExtensionConnectionError('请使用启动器打开 http://127.0.0.1:5173，再连接统一工作台插件。','UNSUPPORTED_ORIGIN'));return;
  }
  const id=crypto.randomUUID();
  let unavailable:ExtensionReply|undefined;
  const cleanup=()=>{clearTimeout(timer);window.removeEventListener('message',receive);signal.removeEventListener('abort',abort);};
  const abort=()=>{cleanup();reject(new ExtensionConnectionError('页面已关闭','ABORTED'));};
  const receive=(event:MessageEvent)=>{
   if(event.source!==window||event.origin!==window.location.origin||event.data?.source!=='temu-workbench-extension'||event.data?.id!==id)return;
   const result=event.data.result as ExtensionReply|undefined;
   if(!result||typeof result!=='object')return;
   // Invalid old contexts may answer first, including old replies without a code.
   const invalid=result.code==='EXTENSION_CONTEXT_INVALIDATED'||(!result.ok&&/插件连接已失效|Extension context invalidated/i.test(result.error||''));
   if(invalid){unavailable=result;return;}
   if(bridgeInstance&&result.bridgeInstance!==bridgeInstance&&!(result.code==='BRIDGE_GENERATION_CHANGED'&&isCurrentBridge(result)))return;
   if(command==='WORKBENCH_PING'&&result.ok&&!isCurrentBridge(result)){unavailable={...result,code:'BRIDGE_UPDATE_REQUIRED'};return;}
   cleanup();resolve(result);
  };
  const timer=setTimeout(()=>{
   cleanup();
   if(command==='WORKBENCH_OPEN_TRAFFIC_ACCELERATOR'){
    reject(new ExtensionConnectionError('尚未收到面板打开确认。请先查看卖家标签页；页面会自动恢复连接，不会自动重复打开或启动任务。','OPEN_TIMEOUT'));return;
   }
   const detail=unavailable?.code==='BRIDGE_UPDATE_REQUIRED'
    ?'插件已响应，此页面的连接仍待更新。请将统一助手更新并重载到 0.20.14，本页会自动重连；也可从统一助手弹窗打开面板。'
    :unavailable?'此页面的旧插件连接已失效，正在自动重新连接。若尚未升级，请更新并重载统一助手 0.20.14；也可从统一助手弹窗打开面板。'
    :'尚未收到此页面的插件响应，正在自动重试。请确认工作台和商家后台位于同一浏览器资料，也可从统一助手弹窗打开面板。';
   reject(new ExtensionConnectionError(detail,unavailable?.code||'BRIDGE_TIMEOUT'));
  },timeoutMs);
  window.addEventListener('message',receive);signal.addEventListener('abort',abort,{once:true});
  window.postMessage({source:'temu-workbench-web',id,command,...(bridgeInstance?{bridgeInstance}:{}),...(mallId?{mallId}:{})},window.location.origin);
 });
}
