(() => {
  const SCRIPT_VERSION = "0.17.0";
  if (globalThis.__temuImageHoverDownloadVersion === SCRIPT_VERSION) return;
  try{globalThis.__temuImageHoverDownloadCleanup?.();}catch{}
  document.getElementById("temu-image-hover-download-host")?.remove();
  globalThis.__temuImageHoverDownloadVersion = SCRIPT_VERSION;

  const SETTINGS_KEY = "temuImageHoverDownload.v1";
  let settings = null;
  let currentImage = null;
  let hideTimer = 0;
  let downloading = false;
  const controller = new AbortController();

  const host = document.createElement("div");
  host.id = "temu-image-hover-download-host";
  host.style.cssText = "position:fixed;z-index:2147483647;display:none;pointer-events:none;inset:0 auto auto 0;";
  const shadow = host.attachShadow({mode:"closed"});
  shadow.innerHTML = `<style>
    button{display:flex;align-items:center;gap:5px;padding:7px 10px;border:1px solid rgba(255,255,255,.72);border-radius:9px;background:rgba(15,118,110,.94);color:#fff;font:700 12px/1.2 system-ui,"Microsoft YaHei",sans-serif;box-shadow:0 5px 16px rgba(15,23,42,.28);cursor:pointer;pointer-events:auto;backdrop-filter:blur(5px)}
    button:hover{background:#0d9488;transform:translateY(-1px)}button:disabled{opacity:.72;cursor:wait;transform:none}
    .toast{position:fixed;top:14px;left:50vw;transform:translateX(-50%);max-width:340px;padding:9px 12px;border-radius:9px;background:rgba(15,23,42,.94);color:#fff;font:12px/1.5 system-ui,"Microsoft YaHei",sans-serif;box-shadow:0 7px 22px rgba(15,23,42,.24);pointer-events:none}
  </style><button type="button" title="保存这张图片"><span>↓</span><span class="label">下载</span></button>`;
  const button = shadow.querySelector("button");
  const label = shadow.querySelector(".label");

  function validPrefixes(value) {
    return (Array.isArray(value?.urlPrefixes)?value.urlPrefixes:[]).map((item)=>String(item||"").trim()).filter(Boolean);
  }

  function enabledHere() {
    return settings?.enabled===true&&validPrefixes(settings).some((prefix)=>location.href.startsWith(prefix));
  }

  function imageScore(image) {
    const url=String(image.currentSrc||image.src||image.getAttribute("data-src")||"");
    const requestedWidth=Number((url.match(/\/w\/(\d+)/i)||[])[1]||0);
    return (image.matches('[data-js-main-img="true"]')?100000000:0)
      +(image.classList.contains("loaded")?1000000:0)
      +(Number(image.naturalWidth||0)*Number(image.naturalHeight||0))
      +(requestedWidth*requestedWidth);
  }

  function candidateImage(event) {
    const candidates=new Set();
    const add=(node)=>{if(node instanceof HTMLImageElement)candidates.add(node);};
    const addWithin=(node)=>{
      if(!(node instanceof Element))return;
      add(node.closest("img"));
      node.querySelectorAll?.("img").forEach(add);
    };
    const path=typeof event.composedPath==="function"?event.composedPath():[];
    path.forEach(add);
    const target=event.target instanceof Element?event.target:null;
    addWithin(target);
    addWithin(target?.closest('a,[role="link"],[class*="goods-img"],[class*="image"],[class*="img"]'));
    if(Number.isFinite(event.clientX)&&Number.isFinite(event.clientY)){
      document.elementsFromPoint(event.clientX,event.clientY).forEach((node)=>{
        addWithin(node);
        addWithin(node.closest?.('a,[role="link"],[class*="goods-img"],[class*="image"],[class*="img"]'));
      });
    }
    return [...candidates].filter((image)=>{
      const rect=image.getBoundingClientRect();
      const style=getComputedStyle(image);
      return image.isConnected&&rect.width>=32&&rect.height>=32&&style.display!=="none"&&style.visibility!=="hidden";
    }).sort((left,right)=>imageScore(right)-imageScore(left))[0]||null;
  }

  function positionButton() {
    if(!currentImage||!currentImage.isConnected||!enabledHere()){hideButton();return;}
    const rect=currentImage.getBoundingClientRect();
    if(rect.bottom<=0||rect.right<=0||rect.top>=innerHeight||rect.left>=innerWidth){hideButton();return;}
    const width=72;
    host.style.left=`${Math.max(6,Math.min(innerWidth-width-6,rect.right-width-7))}px`;
    host.style.top=`${Math.max(6,rect.top+7)}px`;
  }

  function showButton(image) {
    if(!enabledHere())return;
    clearTimeout(hideTimer);
    currentImage=image;
    host.style.display="block";
    positionButton();
  }

  function hideButton() {
    if(downloading)return;
    currentImage=null;
    host.style.display="none";
  }

  function scheduleHide() {
    clearTimeout(hideTimer);
    hideTimer=setTimeout(hideButton,130);
  }

  function showToast(message) {
    const toast=document.createElement("div");
    toast.className="toast";
    toast.textContent=message;
    shadow.appendChild(toast);
    setTimeout(()=>toast.remove(),2400);
  }

  function suggestedName(image, url) {
    const alt=String(image?.alt||"").trim().replace(/\s+/g," ").slice(0,90);
    if(alt)return alt;
    try{return decodeURIComponent(new URL(url).pathname.split("/").pop()||"");}catch{return "网页图片";}
  }

  async function transferableImageUrl(imageUrl) {
    if(!/^blob:/i.test(imageUrl))return imageUrl;
    const response=await fetch(imageUrl);
    if(!response.ok)throw new Error("临时图片读取失败");
    const blob=await response.blob();
    if(blob.size>25*1024*1024)throw new Error("图片超过 25MB，请使用网页自带下载");
    return new Promise((resolve,reject)=>{
      const reader=new FileReader();
      reader.onload=()=>resolve(String(reader.result||""));
      reader.onerror=()=>reject(new Error("临时图片转换失败"));
      reader.readAsDataURL(blob);
    });
  }

  document.addEventListener("pointerover",(event)=>{
    if(!enabledHere())return;
    const image=candidateImage(event);
    if(image)showButton(image);
  },{capture:true,signal:controller.signal});
  document.addEventListener("pointerout",(event)=>{
    if(!currentImage)return;
    const next=event.relatedTarget;
    if(next===currentImage||currentImage.contains(next)||next===host)return;
    scheduleHide();
  },{capture:true,signal:controller.signal});
  document.addEventListener("scroll",positionButton,{capture:true,signal:controller.signal});
  window.addEventListener("resize",positionButton,{signal:controller.signal});
  host.addEventListener("pointerenter",()=>clearTimeout(hideTimer),{signal:controller.signal});
  host.addEventListener("pointerleave",scheduleHide,{signal:controller.signal});
  button.addEventListener("click",async(event)=>{
    event.preventDefault();
    event.stopPropagation();
    if(!currentImage||downloading)return;
    const imageUrl=String(currentImage.currentSrc||currentImage.src||currentImage.getAttribute("data-src")||"").trim();
    if(!imageUrl){showToast("没有识别到图片链接");return;}
    downloading=true;button.disabled=true;label.textContent="保存中";
    try{
      const downloadUrl=await transferableImageUrl(imageUrl);
      const result=await chrome.runtime.sendMessage({type:"DOWNLOAD_HOVERED_IMAGE",imageUrl:downloadUrl,suggestedName:suggestedName(currentImage,imageUrl),pageUrl:location.href});
      if(!result?.success)throw new Error(result?.error||"下载失败");
      showToast(`已保存：${result.filename}`);
    }catch(error){showToast(String(error?.message||error));}
    finally{downloading=false;button.disabled=false;label.textContent="下载";scheduleHide();}
  },{signal:controller.signal});

  const handleSettingsChange=(changes,area)=>{
    if(area!=="local"||!changes[SETTINGS_KEY])return;
    settings=changes[SETTINGS_KEY].newValue||{};
    if(!enabledHere())hideButton();
  };
  chrome.storage.onChanged.addListener(handleSettingsChange);
  globalThis.__temuImageHoverDownloadCleanup=()=>{
    controller.abort();
    clearTimeout(hideTimer);
    chrome.storage.onChanged.removeListener(handleSettingsChange);
    host.remove();
    if(globalThis.__temuImageHoverDownloadVersion===SCRIPT_VERSION)delete globalThis.__temuImageHoverDownloadVersion;
  };
  chrome.storage.local.get(SETTINGS_KEY).then((saved)=>{
    settings=saved[SETTINGS_KEY]||{};
    if(enabledHere()&&!host.isConnected)document.documentElement.appendChild(host);
  }).catch(()=>{});
})();
