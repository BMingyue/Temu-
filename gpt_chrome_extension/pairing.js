(function(root){
 function createWorkbenchPairing({extensionApi,api,initialToken='',fetchImpl=root.fetch}){
  let currentToken=String(initialToken||'');
  async function getToken(force=false){
   if(force){currentToken='';await extensionApi.storage.local.remove('workbenchToken')}
   if(currentToken)return currentToken;
   const saved=await extensionApi.storage.local.get('workbenchToken');
   if(saved.workbenchToken){currentToken=String(saved.workbenchToken);return currentToken}
   const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
   try{
    const response=await fetchImpl(api+'/bootstrap',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({version:extensionApi.runtime.getManifest().version}),signal:controller.signal});
    const value=await response.json();
    if(!response.ok)throw Error(value.error||'本机工作台拒绝首次配对');
    if(!/^[A-Za-z0-9_-]{32,}$/.test(String(value.token||'')))throw Error('本机工作台返回的连接凭据无效');
    currentToken=String(value.token);await extensionApi.storage.local.set({workbenchToken:currentToken});return currentToken;
   }finally{clearTimeout(timer)}
  }
  return {getToken};
 }
 root.createWorkbenchPairing=createWorkbenchPairing;
 if(typeof module!=='undefined'&&module.exports)module.exports={createWorkbenchPairing};
})(globalThis);

