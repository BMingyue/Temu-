const wbNode=document.getElementById('workbench-status');
async function wbRefresh(retry=false){
 const button=document.getElementById('workbench-retry');button.disabled=true;
 if(retry)wbNode.textContent='正在补传，请稍候…';
 try{
  const state=await chrome.runtime.sendMessage({type:retry?'WORKBENCH_RETRY':'WORKBENCH_STATUS'});
  if(state?.error)throw Error(state.error);
  wbNode.textContent=`待同步 ${state.pending||0} 批`+(state.last_success?` · 最近成功 ${new Date(state.last_success).toLocaleString()}`:' · 尚未收到本地同步回执')+(state.last_error?'\n'+state.last_error:'');
 }catch(e){wbNode.textContent='连接状态读取失败，请重载扩展后重试。'}finally{button.disabled=false}
}
document.getElementById('workbench-open').addEventListener('click',async()=>{
 const context=await chrome.runtime.sendMessage({type:'WORKBENCH_CONTEXT'}).catch(()=>({}));
 const url=new URL('http://127.0.0.1:5173/');
 for(const key of ['client_id','browser','mall_id','store_name'])if(context?.[key])url.searchParams.set(key,context[key]);
 chrome.tabs.create({url:url.toString()});
});
document.getElementById('workbench-retry').addEventListener('click',()=>wbRefresh(true));
wbRefresh();
