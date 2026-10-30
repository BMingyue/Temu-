const extensionApi=globalThis.browser||globalThis.chrome;
document.querySelector('#version').textContent='版本 '+extensionApi.runtime.getManifest().version+' · Chrome / Edge / Firefox';
document.querySelector('#open').addEventListener('click',()=>extensionApi.tabs.create({url:'https://chatgpt.com/'}));

extensionApi.runtime.sendMessage({type:'diagnose'}).then(r=>{const name=r?.browser==='edge'?'Edge':r?.browser==='firefox'?'Firefox':'Chrome';document.querySelector('#connection').textContent=r?.ok?(name+' · 本地接口已连接 · '+r.version+'。请保持 GPT 页面打开。'):'连接失败：'+(r?.error||'后台无响应')}).catch(e=>{document.querySelector('#connection').textContent='扩展后台未启动：'+e.message});
