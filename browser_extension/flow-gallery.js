/* Original product carousel images, loaded only for products the user opens. */
(() => {
  const helpers={
    imageRetryDelays:[800,2000,5000],
    imageSource(element){
      const direct=String(element?.currentSrc||element?.src||element?.getAttribute?.('data-src')||element?.getAttribute?.('data-original')||'').trim();
      if(direct)return direct;
      const background=String(element?.style?.backgroundImage||'');
      return background.match(/^url\(["']?(.*?)["']?\)$/)?.[1]||'';
    },
    productImage(element){
      const source=helpers.imageSource(element),rect=element?.getBoundingClientRect?.()||{};
      if(!source||element?.closest?.('[data-temu-flow-gallery]'))return false;
      if(Number(rect.width||0)<28||Number(rect.height||0)<28)return false;
      return /(?:img\.kwcdn\.com\/product|temu|product)/i.test(source)||source.startsWith('blob:')||source.startsWith('data:image/');
    },
    findOriginal(entry,doc){
      const selector='img,[style*="background-image"]';
      const direct=[...new Set([...(entry.cell?.querySelectorAll?.(selector)||[]),...(entry.row?.querySelectorAll?.(selector)||[])])].filter(helpers.productImage);
      if(direct.length)return direct.sort((left,right)=>(right.getBoundingClientRect().width*right.getBoundingClientRect().height)-(left.getBoundingClientRect().width*left.getBoundingClientRect().height))[0];
      const rowRect=entry.row?.getBoundingClientRect?.();
      if(!rowRect)return null;
      const centerY=rowRect.top+rowRect.height/2;
      return [...doc.querySelectorAll(selector)].filter(helpers.productImage).map(image=>{
        const rect=image.getBoundingClientRect();
        return {image,vertical:Math.abs(rect.top+rect.height/2-centerY),horizontal:Math.max(0,rect.left-rowRect.right)};
      }).filter(item=>item.vertical<=Math.max(24,rowRect.height*.42)&&item.horizontal<20)
        .sort((left,right)=>left.vertical-right.vertical||left.horizontal-right.horizontal)[0]?.image||null;
    },
  };
  if(typeof module!=='undefined'&&module.exports){module.exports=helpers;return;}
  if(location.origin!=='https://agentseller-us.temu.com'||window.TemuFlowGallery)return;
  const views=new Map(),pending=new Map();
  let timer=0,loading=false,viewer=null,current=null;
  const style=`:host{display:inline-block;position:relative;z-index:auto;vertical-align:top;width:82px;margin-right:8px;color:#284454;font:11px/1.4 system-ui}button{cursor:pointer;border:0;font:inherit;padding:0;background:transparent;color:inherit}button:focus-visible{outline:2px solid #07988d;outline-offset:2px}.photo{display:block;width:82px;height:82px;border-radius:6px;overflow:hidden;background:#f2f6f7}.photo img{width:100%;height:100%;object-fit:contain}.request{display:block;width:82px;margin-top:3px;border:1px solid #8ccdc8;border-radius:5px;padding:3px 2px;color:#087e76;background:#effaf9}.nav,.thumbs{display:none}.nav{align-items:center;justify-content:space-between;gap:2px;margin:3px 0}.nav button{min-width:18px;min-height:22px;border-radius:4px;background:#eef7f6}.nav button:disabled{opacity:.3;cursor:default}.refresh{color:#087e76}.refresh.loading{animation:spin .8s linear infinite}.count{white-space:nowrap}.thumbs{gap:3px;overflow-x:auto;scrollbar-width:thin;scrollbar-color:#bdd8d4 transparent}.thumbs button{flex:0 0 23px;height:25px;border:1px solid transparent;border-radius:3px;overflow:hidden}.thumbs img{width:100%;height:100%;object-fit:cover}.thumbs .selected{border-color:#07988d}.retry{font-size:10px;color:#a05b11;text-align:left;margin-top:2px}:host([data-expanded="true"]) .request{display:none}:host([data-expanded="true"]) .nav,:host([data-expanded="true"]) .thumbs{display:flex}@keyframes spin{to{transform:rotate(360deg)}}`;
  function ensureViewer(){
    if(viewer)return viewer;
    const host=document.createElement('div');host.id='temu-flow-image-viewer';
    const shadow=host.attachShadow({mode:'open'});
    shadow.innerHTML=`<style>dialog{border:1px solid #b8d5d1;border-radius:12px;padding:14px;background:#f8fbfb;color:#203d50;max-width:94vw;max-height:94vh;width:900px;box-sizing:border-box;font:14px system-ui}dialog::backdrop{background:#142432b8}header{display:flex;align-items:center;justify-content:space-between;gap:15px}button{cursor:pointer;border:1px solid #b9cfcd;background:white;border-radius:6px;padding:8px 14px;color:#24504e;font:inherit}.stage{display:flex;align-items:center;gap:10px;margin-top:12px}.stage img{display:block;flex:1;min-width:0;width:calc(100% - 110px);height:68vh;object-fit:contain}.message{font-size:12px;color:#697b81;margin:8px 0 0}button:disabled{opacity:.4}</style><dialog aria-label="商品图片预览"><header><strong></strong><button class="close" type="button">关闭 ×</button></header><div class="stage"><button class="prev" aria-label="上一张">‹</button><img alt="商品原图"><button class="next" aria-label="下一张">›</button></div><p class="message"></p></dialog>`;
    document.body.append(host);
    const dialog=shadow.querySelector('dialog');
    shadow.querySelector('.close').onclick=()=>dialog.close();
    shadow.querySelector('.prev').onclick=()=>step(current,-1);
    shadow.querySelector('.next').onclick=()=>step(current,1);
    dialog.addEventListener('keydown',e=>{if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();step(current,e.key==='ArrowLeft'?-1:1);}});
    dialog.addEventListener('click',e=>{if(e.target===dialog){const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)dialog.close();}});
    dialog.addEventListener('close',()=>{const image=shadow.querySelector('img');image.removeAttribute('src');delete image.dataset.galleryKey;delete image.dataset.galleryUrl;current=null;});
    viewer={host,shadow,dialog};return viewer;
  }
  function updateViewer(){
    if(!current||!viewer?.dialog.open)return;
    const {shadow}=viewer;
    shadow.querySelector('strong').textContent=`SPU ${current.spuId} · ${current.index+1} / ${current.images.length}`;
    setImageSource(shadow.querySelector('img'),current,current.images[current.index]);
    shadow.querySelector('.message').textContent=current.error||'← → 切换图片 · Esc 关闭';
    for(const button of shadow.querySelectorAll('.prev,.next'))button.disabled=current.images.length<2;
  }
  function step(view,delta){if(!view||!view.images.length)return;view.index=(view.index+delta+view.images.length)%view.images.length;paint(view);}
  function resetRetries(view){view.imageRefreshScheduled=false;view.error='';}
  function retryImage(image,view,url){
    if(!image.isConnected||image.dataset.galleryUrl!==url)return;
    image.removeAttribute('src');
    setTimeout(()=>{if(image.isConnected&&image.dataset.galleryUrl===url)image.src=url;},60);
  }
  function setImageSource(image,view,url){
    const source=String(url||'');
    const generation=String(view.loadGeneration||0),key=`${source}|${generation}`;
    if(image.dataset.galleryKey===key)return;
    image.dataset.galleryKey=key;image.dataset.galleryUrl=source;image.dataset.retryCount='0';
    image.onload=()=>{
      if(image.dataset.galleryUrl!==source)return;
      image.dataset.retryCount='0';
      if(view.error.startsWith('图片加载失败')){view.error='';paint(view);}
    };
    image.onerror=()=>{
      if(image.dataset.galleryUrl!==source||!view.host.isConnected)return;
      const attempt=Number(image.dataset.retryCount||0)+1;
      image.dataset.retryCount=String(attempt);
      if(attempt<=helpers.imageRetryDelays.length){
        const delay=helpers.imageRetryDelays[attempt-1];
        view.error=`图片加载失败，正在自动找回（${attempt}/${helpers.imageRetryDelays.length}）`;
        paint(view);setTimeout(()=>retryImage(image,view,source),delay);return;
      }
      if(view.host.dataset.expanded==='true'&&!view.imageRefreshScheduled){view.imageRefreshScheduled=true;view.error='图片地址已失效，点击 ↻ 重新获取';paint(view);}
    };
    image.src=source;
  }
  function paint(view){
    const root=view.shadow;
    setImageSource(root.querySelector('.photo img'),view,view.images[view.index]);
    root.querySelector('.count').textContent=view.loading?'读取中':view.galleryLoaded?`${view.index+1}/${view.images.length}`:'待加载';
    for(const button of root.querySelectorAll('.prev,.next'))button.disabled=!view.galleryLoaded||view.images.length<2;
    const strip=root.querySelector('.thumbs');
    const visibleImages=view.host.dataset.expanded==='true'&&view.galleryLoaded?view.images:[];
    if(strip.dataset.urls!==JSON.stringify(visibleImages)){
      strip.replaceChildren();strip.dataset.urls=JSON.stringify(visibleImages);
      visibleImages.forEach((url,index)=>{const button=document.createElement('button');button.type='button';button.title=`第 ${index+1} 张`;const image=document.createElement('img');image.loading='lazy';image.alt=`缩略图 ${index+1}`;setImageSource(image,view,url);button.append(image);button.onclick=()=>{view.index=index;paint(view);};strip.append(button);});
    }
    visibleImages.forEach((url,index)=>{const image=strip.children[index]?.querySelector('img');if(image)setImageSource(image,view,url);});
    [...strip.children].forEach((button,index)=>button.classList.toggle('selected',index===view.index));
    root.querySelector('.refresh').classList.toggle('loading',view.loading===true);
    const retry=root.querySelector('.retry');retry.hidden=!view.error;retry.textContent=view.error||'';retry.title=view.error||'';
    root.querySelector('.refresh').title=view.lastDurationMs!=null?`本次获取 ${view.lastDurationMs}ms；点击重新获取`:'重新获取该商品图片';
    if(current===view)updateViewer();
  }
  function collapse(view){
    pending.delete(view);resetRetries(view);view.galleryLoaded=false;view.loading=false;view.images=[view.originalUrl];view.index=0;view.loadGeneration+=1;view.host.dataset.expanded='false';
    if(current===view){viewer?.dialog.close();current=null;}
    paint(view);
  }
  function activate(view){
    view.host.dataset.expanded='true';resetRetries(view);view.galleryLoaded=false;view.images=[view.originalUrl];view.index=0;paint(view);queue(view,true);
  }
  function queue(view,forceRefresh=false){pending.set(view,Boolean(forceRefresh)||pending.get(view)===true);if(!timer)timer=setTimeout(flush,150);}
  async function flush(){
    timer=0;if(loading)return;
    const first=[...pending].find(([view])=>view.host.isConnected);
    if(!first)return;
    const forceRefresh=first[1];
    const batch=[...pending].filter(([view,force])=>view.host.isConnected&&force===forceRefresh).slice(0,50).map(([view])=>view);
    batch.forEach(view=>{pending.delete(view);view.loading=true;paint(view);});if(!batch.length)return;loading=true;
    try{
      const result=await chrome.runtime.sendMessage({type:'FLOW_PRODUCT_GALLERY',spuIds:batch.map(v=>v.spuId),forceRefresh});
      if(!result?.success)throw new Error(result?.error||'商品图片读取失败');
      for(const view of batch){
        if(view.host.dataset.expanded!=='true')continue;
        const product=result.products.find(item=>item.spuId===view.spuId);
        if(product?.images.length){view.images=product.images;view.index=0;view.error='';view.imageRefreshScheduled=false;view.galleryLoaded=true;view.loadGeneration+=1;view.lastSource=product.source||'';view.lastDurationMs=result.durationMs;}
        else view.error='该商品尚未返回完整图片，点击这里重试';
        paint(view);
      }
    }catch(error){for(const view of batch)if(view.host.dataset.expanded==='true'){view.error=`${String(error.message||error)} · 点击这里重试`;paint(view);}}
    finally{for(const view of batch){view.loading=false;paint(view);}loading=false;if(pending.size&&!timer)timer=setTimeout(flush,150);}
  }
  window.TemuFlowGallery={render(entries){
    if(location.pathname!=='/main/flux-analysis'){viewer?.dialog.close();return;}
    // Temu rebuilds rows while filtering/paging. Release detached galleries;
    // every carousel the user opened on the current page remains expanded.
    for(const [host,view] of views)if(!host.isConnected){pending.delete(view);if(current===view){viewer?.dialog.close();current=null;}views.delete(host);}
    for(const entry of entries){
      const {cell,spuId}=entry;
      if(document.querySelector(`[data-temu-flow-gallery="${CSS.escape(spuId)}"]`))continue;
      const original=helpers.findOriginal(entry,document);
      if(!original)continue;
      const host=document.createElement('span');host.dataset.temuFlowGallery=spuId;
      host.dataset.expanded='false';
      const shadow=host.attachShadow({mode:'open'});
      shadow.innerHTML=`<style>${style}</style><button class="photo" type="button" aria-label="点开该商品轮播"><img alt="商品图片" loading="lazy"></button><button class="request" type="button">▣ 查看轮播</button><div class="nav"><button class="prev" type="button" aria-label="上一张">‹</button><span class="count"></span><button class="next" type="button" aria-label="下一张">›</button><button class="refresh" type="button" aria-label="重新获取图片">↻</button><button class="collapse" type="button" aria-label="收起轮播">×</button></div><div class="thumbs"></div><button class="retry" type="button" hidden></button>`;
      original.insertAdjacentElement('afterend',host);original.style.display='none';
      const originalUrl=helpers.imageSource(original);
      const view={host,shadow,spuId,originalUrl,images:[originalUrl],index:0,error:'',loading:false,lastSource:'',lastDurationMs:null,loadGeneration:0,galleryLoaded:false,imageRefreshScheduled:false};views.set(host,view);
      // Keep native image-preview wrappers from handling our carousel clicks.
      host.addEventListener('click',e=>e.stopPropagation());
      shadow.querySelector('.photo').onclick=()=>{if(!view.galleryLoaded){activate(view);return;}current=view;const v=ensureViewer();if(!v.dialog.open)v.dialog.showModal();updateViewer();};
      shadow.querySelector('.request').onclick=()=>activate(view);
      shadow.querySelector('.prev').onclick=()=>step(view,-1);
      shadow.querySelector('.next').onclick=()=>step(view,1);
      shadow.querySelector('.refresh').onclick=()=>{resetRetries(view);queue(view,true);};
      shadow.querySelector('.retry').onclick=()=>{resetRetries(view);queue(view,true);};
      shadow.querySelector('.collapse').onclick=()=>collapse(view);
      paint(view);
    }
  }};
})();
