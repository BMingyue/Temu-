(()=>{
 const extensionApi=globalThis.browser||globalThis.chrome;
 const VERSION=extensionApi?.runtime?.getManifest?.().version||'0.3.37';
 const BUILD=VERSION;
 const USER_SELECTOR='[data-message-author-role="user"],[class~="group/user-message"]';
 const ASSISTANT_SELECTOR='[data-message-author-role="assistant"],[class~="group/assistant-message"],[class~="group/agent-message"],[class~="group/generated-image-preview"]';
 const DIALOG_SELECTOR='dialog,[role="dialog"],[role="alertdialog"]';
 const ATTACHMENT_EXCLUDED=USER_SELECTOR+','+ASSISTANT_SELECTOR+','+DIALOG_SELECTOR;
 const COMPOSER_OVERLAY='[data-composer-overlay-floating-ui="true"]';
 const ADD_CONTEXT='button[data-composer-navigation-target="add-context"]';
 const ATTACHMENT_EVIDENCE_EXCLUDED=ATTACHMENT_EXCLUDED+','+COMPOSER_OVERLAY;
 function messageTurns(selector,root=document,includeUnrendered=false){
  const nodes=[...root.querySelectorAll(selector)].filter(el=>includeUnrendered||!el.getClientRects||visible(el));
  return nodes.filter(el=>!nodes.some(other=>other!==el&&el.contains?.(other)));
 }
 let busy=false,activeSession='',activeWorkflowTask=null,isolatedRunner=false;
 const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 async function post(path,body){if(path==='/update'&&activeWorkflowTask&&body.job_id===activeWorkflowTask.job_id)body={step:activeWorkflowTask.step_number,step_token:activeWorkflowTask.step_token,...body};const result=await extensionApi.runtime.sendMessage({type:'api',path,body});if(!result?.ok)throw Error(result?.error||'扩展后台未响应');return result.value}
 async function session(){let value=sessionStorage.getItem('workbenchRunnerSession');if(value)return value;value=crypto.randomUUID();sessionStorage.setItem('workbenchRunnerSession',value);return value}
 const visible=element=>element&&element.getClientRects().length>0;
 const label=element=>(element?.getAttribute('aria-label')||element?.textContent||'').trim();
 function button(names){return [...document.querySelectorAll('button')].find(el=>visible(el)&&names.some(name=>label(el).toLowerCase()===name.toLowerCase()))}
 function uploadControl(){
  const names=['添加文件等内容','添加文件等','添加照片和文件','添加照片/文件','添加文件','添加附件','上传文件','Add files','Attach files','Upload files','Add photos and files','Upload from computer'];
  const box=typeof document.querySelector==='function'?composer():null,scope=box?attachmentScope():null;
  if(typeof document.querySelector==='function'&&!box)return null;
  const controls=[...document.querySelectorAll('button,[role="menuitem"]')].filter(element=>visible(element)&&!element.closest?.(ATTACHMENT_EXCLUDED)&&!element.closest?.(COMPOSER_OVERLAY)&&(!scope||scope.contains(element)));
  const marked=controls.filter(element=>element.matches?.(ADD_CONTEXT));
  if(marked.length)return marked.length===1?marked[0]:null;
  const named=controls.find(el=>names.some(name=>label(el).toLowerCase()===name.toLowerCase()))||controls.find(el=>names.some(name=>label(el).toLowerCase().startsWith(name.toLowerCase())));
  if(named)return named;
  const form=composer()?.closest('form');if(!form)return null;
  return [...form.querySelectorAll('button,[role="button"]')].filter(el=>visible(el)&&!el.closest(ATTACHMENT_EXCLUDED)&&!el.closest(COMPOSER_OVERLAY)).find(el=>{
   const hint=[label(el),el.getAttribute('title'),el.getAttribute('data-testid')].filter(Boolean).join(' ');
   return /^(?:\+|添加|add)$/i.test(hint)||/composer.*(?:plus|attach|upload)|(?:plus|attach|upload).*composer/i.test(hint);
  })||null;
 }
 function composerUploadOverlay(control){
  const scope=attachmentScope();if(!scope||!control.matches?.(ADD_CONTEXT)||!scope.contains(control)||uploadActionDisabled(control)||control.closest(ATTACHMENT_EXCLUDED+','+COMPOSER_OVERLAY)||control.getAttribute('aria-expanded')!=='true'||control.getAttribute('data-state')!=='open')return null;
  const entries=[...scope.querySelectorAll(ADD_CONTEXT)].filter(element=>visible(element)&&!element.closest(ATTACHMENT_EXCLUDED+','+COMPOSER_OVERLAY));
  if(entries.length!==1||entries[0]!==control)return null;
  const openEntries=[...document.querySelectorAll(ADD_CONTEXT)].filter(element=>visible(element)&&!element.closest(ATTACHMENT_EXCLUDED+','+COMPOSER_OVERLAY)&&(element.getAttribute('aria-expanded')==='true'||element.getAttribute('data-state')==='open'));
  if(openEntries.length!==1||openEntries[0]!==control)return null;
  const overlays=[...document.querySelectorAll(COMPOSER_OVERLAY)].filter(visible);
  if(overlays.length!==1||overlays[0].closest(ATTACHMENT_EXCLUDED))return null;
  const overlay=overlays[0],sections=[...overlay.querySelectorAll('[data-mention-section-id="chatgpt-primary"]')].filter(element=>visible(element)&&!element.closest(ATTACHMENT_EXCLUDED));
  if(sections.length!==1)return null;
  const section=sections[0],items=[...(section.matches('[data-mention-section-items="true"]')?[section]:[]),...section.querySelectorAll('[data-mention-section-items="true"]')].filter(element=>visible(element)&&!element.closest(ATTACHMENT_EXCLUDED)&&element.closest('[data-mention-section-id]')===section);
  return items.length===1?{overlay,section,items:items[0]}:null;
 }
 function uploadMenu(control,beforeVisible,createdDuringClick=null){
  const scope=attachmentScope(),declared=(control.getAttribute('aria-controls')||'').split(/\s+/).filter(Boolean),owned=declared.map(id=>document.getElementById(id)).filter(Boolean);
  if(control.id)owned.push(...[...document.querySelectorAll('[role="menu"],[role="listbox"]')].filter(menu=>(menu.getAttribute('aria-labelledby')||'').split(/\s+/).includes(control.id)));
  const composerOverlay=declared.length||owned.length?null:composerUploadOverlay(control);
  const related=element=>{
   if(declared.length||owned.length)return owned.some(parent=>parent.contains(element));
   if(element.closest(COMPOSER_OVERLAY))return Boolean(composerOverlay&&element.matches('button[data-list-navigation-item="true"]')&&element.closest(COMPOSER_OVERLAY)===composerOverlay.overlay&&element.closest('[data-mention-section-id]')===composerOverlay.section&&element.closest('[data-mention-section-items="true"]')===composerOverlay.items&&element.querySelector('[data-menu-row-content="true"]'));
   return scope?.contains(element)||createdDuringClick?.has(element)&&!beforeVisible.has(element);
  };
  // Read only the local semantic menu text. Skipped rendering can make
  // innerText empty; raw fallback text would include SVG style-sheet text.
  const menuLabel=element=>{
   let content=element.textContent||'';
   if(element.cloneNode){const copy=element.cloneNode(true);copy.querySelectorAll('svg,style,script,[aria-hidden="true"]').forEach(node=>node.remove());content=copy.textContent||'';}
   const text=String(element.getAttribute('aria-label')||content).trim();
   if(text.startsWith('添加照片和文件')){
    const compact=text.replace(/\s+/g,'');
    return compact==='添加照片和文件'?'添加照片和文件':compact==='添加照片和文件从计算机上传'?'添加照片和文件 从计算机上传':'';
   }
   return text;
  };
  const candidates=[...document.querySelectorAll('[role="menuitem"],button')].filter(element=>element!==control&&visible(element)&&!element.closest(ATTACHMENT_EXCLUDED)&&/^(?:上传文件|从电脑上传|从计算机上传|选择文件|上传照片和文件|添加照片和文件|upload from computer|upload photos and files|upload files|add photos and files|add files|choose files)(?:\b|\s|$)/i.test(menuLabel(element))&&related(element));
  return candidates.length===1?candidates[0]:null;
 }
 async function captureOwnedMenuInput(control,beforeVisible,createdDuringClick,task,triggerPhase='click',verifyContext=null){
  let interrupted=false;
  const events=['pointerdown','pointerup','mousedown','mouseup','touchstart','keydown','keyup','click','input','paste','drop','wheel'];
  const cancel=event=>{if(event.isTrusted)interrupted=true};
  const verify=()=>{if(interrupted)throw workflowFailure('用户正在操作当前页面，已取消本次附件选择；请确认草稿和菜单后再继续','workflow_upload_interrupted');if(verifyContext)verifyContext()};
  // The listener that grants file-input authority never crosses an await.
  // During menu rendering we retain only a trusted-user cancellation guard,
  // so a later user-opened project menu cannot inherit the earlier click.
  for(const type of events)document.addEventListener(type,cancel,true);
  try{
   const menu=await waitFor(()=>{verify();return uploadMenu(control,beforeVisible,createdDuringClick)},10000,'找不到当前上传控件的唯一照片或文件菜单').catch(error=>{if(error.code)throw error;throw attachmentFailure(task,error.message+'（触发阶段 '+triggerPhase+'；展开 '+(control.getAttribute('aria-expanded')||'未知')+'；状态 '+(control.getAttribute('data-state')||'未知')+'；'+uploadDiagnostic()+'）')});
   verify();return captureUploadInput(menu,task,{control,beforeVisible,createdDuringClick});
  }finally{for(const type of events)document.removeEventListener(type,cancel,true)}
 }
 function uploadInputEligible(input,task){
  if(!input?.matches?.('input[type="file"]')||input.disabled||input.isConnected===false||input.webkitdirectory||input.hasAttribute('capture')||input.closest(ATTACHMENT_EXCLUDED))return false;
  const items=task?attachmentItems(task):[],accept=String(input.accept||'').toLowerCase().split(',').map(value=>value.trim()).filter(Boolean);
  if(!accept.length)return true;
  return items.every(item=>{
   const extension='.'+String(item.name||'').split('.').pop().toLowerCase();
   const fallback={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.zip':'application/zip'};
   const type=String(item.type||fallback[extension]||'').toLowerCase();
   return accept.some(value=>value==='*'||value==='*/*'||value===extension||value===type||value.endsWith('/*')&&type.startsWith(value.slice(0,-1)));
  });
 }
 function uploadInput(localOnly=false,task=null){
  const scope=attachmentScope(),form=composer()?.closest('form');
  const local=input=>Boolean(scope?.contains(input)||form&&input.form===form);
  const inputs=[...document.querySelectorAll('input[type="file"]')].filter(input=>uploadInputEligible(input,task)&&!input.closest(COMPOSER_OVERLAY)&&(!localOnly||local(input))&&(!task||local(input)));
  // More than one compatible local control requires observing the actual
  // owned upload click. MIME/multiple ranking does not establish ownership.
  return inputs.length===1?inputs[0]:null;
 }
 function uploadActionDisabled(control){return Boolean(control?.disabled||control?.matches?.(':disabled')||String(control?.getAttribute?.('aria-disabled')||'').trim().toLowerCase()==='true')}
 function captureUploadInput(control,task,menuContext=null,activation=null){
  const box=composer(),scope=attachmentScope(),key=attachmentKey(task);
  const owned=box&&scope&&visible(control)&&!uploadActionDisabled(control)&&!control.closest(ATTACHMENT_EXCLUDED)&&(menuContext?uploadMenu(menuContext.control,menuContext.beforeVisible,menuContext.createdDuringClick)===control:uploadControl()===control);
  if(!owned)throw attachmentFailure(task,'无法确认当前上传控件属于本步骤输入框，已停止选择文件');
  if(composerText(box).trim())throw attachmentFailure(task,'当前输入框已有草稿，已停止选择文件');
  if(composerAttachmentSnapshot(scope).cards.length||[...scope.querySelectorAll(ATTACHMENT_SELECTOR)].some(node=>!node.closest(ATTACHMENT_EVIDENCE_EXCLUDED)))throw attachmentFailure(task,'当前输入框已有附件，已停止重新选择文件');
  const observed=[];
  const capture=event=>{
   const input=event.target;
   if(!input?.matches?.('input[type="file"]'))return;
   // A real page-world React handler can call input.click(). DOM events cross
   // extension isolated worlds; patching its prototype here would not. Block
   // only the native picker, keep the app's normal click handlers running.
   event.preventDefault();observed.push(input);
  };
  document.addEventListener('click',capture,true);
  try{
   if(!activation||activation.type==='click')control.click();
   else{
    const rect=control.getBoundingClientRect(),down=activation.type.endsWith('down');
    const options={bubbles:true,cancelable:true,composed:true,button:0,buttons:down?1:0,clientX:rect.left+rect.width/2,clientY:rect.top+rect.height/2,ctrlKey:false,altKey:false,shiftKey:false,metaKey:false};
    const event=activation.type.startsWith('pointer')?new PointerEvent(activation.type,{...options,pointerId:1,pointerType:'mouse',isPrimary:true}):new MouseEvent(activation.type,options);
    control.dispatchEvent(event);activation.defaultPrevented=event.defaultPrevented;
   }
  }finally{document.removeEventListener('click',capture,true)}
  if(composer()!==box||box.isConnected===false||attachmentKey(task)!==key)throw attachmentFailure(task,'选择文件期间输入框或本步骤身份已变化');
  if(composerText(box).trim())throw attachmentFailure(task,'选择文件期间出现了其他草稿，已停止选择文件');
  if(uploadActionDisabled(control))throw attachmentFailure(task,'上传控件在选择文件期间已禁用，已停止上传');
  if(!observed.length)return null;
  if(observed.length!==1||!uploadInputEligible(observed[0],task))throw attachmentFailure(task,'上传控件触发了多个或不适用的文件输入框，已停止选择文件');
  return observed[0];
 }
 async function activateUploadControl(control,task){
  const box=composer(),key=attachmentKey(task);
  const beforeVisible=new Set([...document.querySelectorAll('[role="menuitem"],button')].filter(visible)),createdDuringClick=new Set();
  let interrupted=false,pointerDefaultPrevented=false,lastPhase='existing-menu';
  const events=['pointerdown','pointerup','mousedown','mouseup','touchstart','keydown','keyup','click','input','paste','drop','wheel'];
  const cancel=event=>{if(event.isTrusted)interrupted=true};
  const verify=(allowInitialDisabled=false)=>{
   if(interrupted)throw workflowFailure('用户正在操作当前页面，已取消本次附件选择；请确认草稿和菜单后再继续','workflow_upload_interrupted');
   if(!box)throw attachmentFailure(task,'打开附件菜单前未找到 GPT 输入框，已停止上传');
   if(box.isConnected===false)throw attachmentFailure(task,'打开附件菜单期间原 GPT 输入框已从页面移除，已停止上传');
   if(composer()!==box)throw attachmentFailure(task,'打开附件菜单期间 GPT 输入框节点已变化，已停止上传');
   if(control.isConnected===false)throw attachmentFailure(task,'打开附件菜单期间添加文件按钮已从页面移除，已停止上传');
   if(!allowInitialDisabled&&uploadActionDisabled(control))throw attachmentFailure(task,'打开附件菜单期间添加文件控件已禁用，已停止上传');
   if(uploadControl()!==control)throw attachmentFailure(task,'打开附件菜单期间添加文件入口已变化或不唯一，已停止上传');
   if(attachmentKey(task)!==key)throw attachmentFailure(task,'打开附件菜单期间本步骤身份已变化，已停止上传');
   if(composerText(box).trim())throw attachmentFailure(task,'打开附件菜单期间输入框出现其他草稿，已停止上传');
  };
  const opened=()=>Boolean(uploadMenu(control,beforeVisible,createdDuringClick))||control.getAttribute('aria-expanded')==='true'||control.getAttribute('data-state')==='open';
  for(const type of events)document.addEventListener(type,cancel,true);
  try{
   verify(true);
   if(uploadActionDisabled(control)){
    // The composer may still be hydrating after opening the original chat.
    // Wait only before the first activation, on this exact owned node. No
    // synthetic input or file-picker authority exists during this wait.
    const readyDeadline=Date.now()+20000;
    while(true){
     verify(true);
     const remaining=readyDeadline-Date.now();
     if(!uploadActionDisabled(control)&&remaining>=0)break;
     if(remaining<=0)throw attachmentFailure(task,'等待 20 秒后添加文件控件仍已禁用，已停止上传');
     await sleep(Math.min(250,remaining));
    }
   }
   verify();
   // Reuse an already open, owned menu. Opening its trigger again can close
   // it. Menu options retain their existing single click-only activation.
   if(uploadMenu(control,beforeVisible,createdDuringClick))return await captureOwnedMenuInput(control,beforeVisible,createdDuringClick,task,lastPhase,verify);
   if(!opened())for(const type of ['pointerdown','mousedown','pointerup','mouseup','click']){
    if(pointerDefaultPrevented&&(type==='mousedown'||type==='mouseup'))continue;
    verify();lastPhase=type;
    const phaseBeforeVisible=new Set([...document.querySelectorAll('[role="menuitem"],button')].filter(visible));
    const activation={type,defaultPrevented:false},input=captureUploadInput(control,task,null,activation);
    // Only menus made visible in this exact synchronous owned event may
    // enter the no-ARIA portal whitelist. Later renders still need ARIA.
    for(const element of document.querySelectorAll('[role="menuitem"],button'))if(visible(element)&&!phaseBeforeVisible.has(element))createdDuringClick.add(element);
    verify();
    if(input)return input;
    if(type==='pointerdown')pointerDefaultPrevented=activation.defaultPrevented;
    if(opened())break;
    // Discrete React handlers may commit after dispatchEvent returns. Let
    // that render finish before trying another phase, to avoid toggling an
    // opened menu closed. No file-input authority survives this await.
    const until=Date.now()+250;
    do{await sleep(25);verify();if(opened())break}while(Date.now()<until);
    if(opened())break;
   }
   verify();return await captureOwnedMenuInput(control,beforeVisible,createdDuringClick,task,lastPhase,verify);
  }finally{for(const type of events)document.removeEventListener(type,cancel,true)}
 }
 function uploadDiagnostic(){
  const scope=attachmentScope();if(!scope)return '未识别 GPT 输入框；关联文件输入框：无';
  const hints=[...scope.querySelectorAll('button,[role="button"]')].filter(el=>visible(el)&&!el.closest(ATTACHMENT_EXCLUDED)).slice(0,16).map(el=>
   [el.getAttribute('aria-label'),el.getAttribute('title'),el.getAttribute('data-testid'),el.getAttribute('aria-haspopup'),el.getAttribute('aria-controls')].filter(Boolean).join('|').slice(0,100)).filter(Boolean);
  const inputs=[...scope.querySelectorAll('input[type="file"]')].filter(el=>!el.closest(ATTACHMENT_EXCLUDED)).map(el=>`${el.multiple?'多选':'单选'}:${(el.accept||'任意').slice(0,40)}`);
  return `可见按钮标记：${hints.join('、')||'无'}；文件输入框：${inputs.join('、')||'无'}`;
 }
 function composer(){
  const primary=document.querySelector('#prompt-textarea');
  if(primary&&visible(primary)&&!primary.closest(DIALOG_SELECTOR+','+COMPOSER_OVERLAY)&&(primary.isContentEditable||primary.tagName==='TEXTAREA'))return primary;
  const candidates=[...document.querySelectorAll('[contenteditable="true"],textarea,[data-testid="textbox"]')];
  return candidates.find(el=>{
   if(!visible(el)||el.closest(DIALOG_SELECTOR+','+COMPOSER_OVERLAY))return false;
   const hint=[el.getAttribute('aria-label'),el.getAttribute('placeholder'),el.getAttribute('data-testid')].filter(Boolean).join(' ');
   return /与 ChatGPT 聊天|message chatgpt|ask anything|发送消息|message|prompt|textbox|聊天/i.test(hint)||el.matches('[contenteditable="true"][data-lexical-editor="true"]');
  })||candidates.find(el=>visible(el)&&!el.closest(DIALOG_SELECTOR+','+COMPOSER_OVERLAY))||null;
 }
 function loginPromptVisible(){return [...document.querySelectorAll('button,a,[role="button"]')].some(el=>{
  if(!visible(el))return false;
  const testId=el.getAttribute?.('data-testid')||'';
  const hint=[el.innerText||el.textContent||'',el.getAttribute?.('aria-label')||''].join(' ').trim();
  return /^(?:login|signup|log-in|sign-up)-button$/i.test(testId)||/登录|注册|log\s*in|sign\s*up/i.test(hint);
 })}
 function passivePage(pathname){return String(pathname||'').startsWith('/library')}
 function accessDenied(){return /你无权访问此对话|无权访问此对话|you do not have access to this conversation|don't have access to this conversation/i.test(document.body?.innerText||'')}
 function composerText(box=composer()){
  if(!box)return '';
  if('value' in box&&!box.isContentEditable)return String(box.value||'');
  // File chips and placeholder decorations inside a rich-text editor are not
  // an unsent user draft. Read a detached clone; never mutate the live editor.
  if(box.cloneNode){const clone=box.cloneNode(true);clone.querySelectorAll('[contenteditable="false"],[aria-hidden="true"],[data-placeholder]:empty').forEach(el=>el.remove());return String(clone.textContent||'')}
  return String(box.textContent||'');
 }
 function sendButton(){
  const box=composer(),form=box?.closest('form');
  const candidates=[
   document.querySelector('[data-testid="send-button"]'),
   document.querySelector('button[data-testid*="send"]'),
   ...document.querySelectorAll('button[aria-label^="Send"],button[aria-label^="发送"]'),
   ...(form?[...form.querySelectorAll('button')]:[]),
  ].filter(Boolean);
  return candidates.find(el=>{
   const name=[label(el),el.getAttribute('title'),el.getAttribute('data-testid')].filter(Boolean).join(' ');
   return visible(el)&&!el.disabled&&el.getAttribute('aria-disabled')!=='true'&&(/发送(?:消息|提示词)?|send(?: message| prompt)?/i.test(name)||el.type==='submit');
  })||null;
 }
 function draftMatches(text){
  const actual=composerText().replace(/\s+/g,'').trim();
  const expected=String(text||'').replace(/\s+/g,'').trim();
  return !!actual&&!!expected&&(actual===expected||actual.includes(expected.slice(0,120)));
 }
 async function draftSignature(text){
  const bytes=new TextEncoder().encode(String(text||'').replace(/\s+/g,''));
  const digest=await crypto.subtle.digest('SHA-256',bytes);
  return [...new Uint8Array(digest)].map(value=>value.toString(16).padStart(2,'0')).join('');
 }
 function writePlainValue(box,value){
  // Bypass React's per-element value tracker, then dispatch the native input
  // event at the call site so the controlled editor updates its saved state.
  let prototype=Object.getPrototypeOf(box),setter=null;
  while(prototype&&!setter){setter=Object.getOwnPropertyDescriptor(prototype,'value')?.set;prototype=Object.getPrototypeOf(prototype)}
  if(setter)setter.call(box,value);else box.value=value;
 }
 function clearComposerText(box){
  box.focus();
  if('value' in box&&!box.isContentEditable){writePlainValue(box,'');box.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'deleteContentBackward'}));return !composerText(box).trim()}
  const selection=window.getSelection(),range=document.createRange();
  range.selectNodeContents(box);selection.removeAllRanges();selection.addRange(range);
  document.execCommand('delete',false);selection.removeAllRanges();
  box.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'deleteContentBackward'}));
  return !composerText(box).trim();
 }
 async function waitFor(fn,timeout,message){const end=Date.now()+timeout;while(Date.now()<end){const value=fn();if(value)return value;await sleep(500)}throw Error(message)}
 function uploadName(task,item){
  let prefix=task.job_id.slice(0,12);
  if(workflowTask(task)){
   const index=referenceItems(task).indexOf(item);if(index<0)throw Error('本步骤附件不属于当前任务，已停止选择文件');
   prefix+='-s'+(task.step_number||0)+'-a'+(index+1);
  }
  return prefix+'-'+item.name.replace(/[\\/]/g,'_');
 }
 function workflowTask(task){return task?.workflow_mode==='single_image_chat_v1'}
 function referenceItems(task){if(workflowTask(task))return task.attachments||[];return Array.isArray(task.reference_images)&&task.reference_images.length?task.reference_images:[task.reference]}
 function attachmentItems(task){return workflowTask(task)?task.attachments:[...referenceItems(task),task.template_archive]}
 function downloadTask(task,index){return {job_id:task.job_id,step:workflowTask(task)?task.step_number:index,...(workflowTask(task)?{step_token:task.step_token}:{})}}
 function downloadIndex(task,index){return workflowTask(task)?task.step_number:index}
 function file(item,name){const bytes=Uint8Array.from(atob(item.base64),c=>c.charCodeAt(0));return new File([bytes],name,{type:item.type})}
 function selectFiles(input,files){
  const transfer=new DataTransfer();for(const item of files)transfer.items.add(item);
  input.files=transfer.files;
  const accepted=input.files?.length||0;
  if(accepted!==files.length)throw Error('GPT 文件框未接收所选附件（预期 '+files.length+' 个，实际 '+accepted+' 个）');
  // ChatGPT may clear or replace the input synchronously while handling change.
  // Its value after dispatch is not evidence that the selection failed.
  input.dispatchEvent(new Event('change',{bubbles:true}));
 }
 function nameVisible(text,name){
  const dot=name.lastIndexOf('.');if(dot<1)return false;
  const escape=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  return new RegExp(escape(name.slice(0,dot))+'(?:\\([^)]{1,64}\\))?'+escape(name.slice(dot)),'i').test(text);
 }
 let selectedAttachments=null;
 const ATTACHMENT_SELECTOR='[data-testid="file-thumbnail"],[data-testid="composer-attachment"]';
 function attachmentKey(task){return [task.job_id,task.step_token||'',task.step_number||''].join(':')}
 function exactAttachmentName(text,name){
  const dot=name.lastIndexOf('.');if(dot<1)return false;
  const escape=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const expected=new RegExp('^'+escape(name.slice(0,dot))+'(?:\\([^)]{1,64}\\))?'+escape(name.slice(dot))+'$','iu');
  return String(text||'').split(/\r?\n/).some(value=>expected.test(value.trim().replace(/^(?:(?:remove|delete|preview|download|file|image|attachment|移除|删除|预览|下载|文件|图片|附件)[\s:：]+){1,3}/i,'').replace(/\s+(?:[·•–—]\s*)?\d+(?:\.\d+)?\s*(?:B|KB|MB|GB)\s*$/i,'')));
 }
 function attachmentText(element){
  const nodes=[element,...(element.querySelectorAll?.('[aria-label],[title],[alt],[data-file-name],[data-filename]')||[])].filter(node=>!node.closest?.(ATTACHMENT_EVIDENCE_EXCLUDED));
  return [attachmentLocalText(element),...nodes.flatMap(node=>['aria-label','title','alt','data-file-name','data-filename'].map(name=>node.getAttribute?.(name)||''))].filter(Boolean).join('\n');
 }
 function primaryAttachmentNames(element){
  const nodes=[element,...(element.querySelectorAll?.('[aria-label],[title],[data-file-name],[data-filename]')||[])].filter(node=>!node.closest?.(ATTACHMENT_EVIDENCE_EXCLUDED));
  return [attachmentLocalText(element),...nodes.flatMap(node=>['aria-label','title','data-file-name','data-filename'].map(name=>node.getAttribute?.(name)||''))].flatMap(value=>String(value).split(/\r?\n/)).filter(value=>/\.[a-z][a-z0-9]{0,11}(?:\b|$)/i.test(value));
 }
 function attachmentLocalText(element){
  if(!element||element.closest?.(ATTACHMENT_EVIDENCE_EXCLUDED))return '';
  if(!element.cloneNode||!element.querySelector?.(ATTACHMENT_EVIDENCE_EXCLUDED))return element.innerText||element.textContent||'';
  const clone=element.cloneNode(true);clone.querySelectorAll(ATTACHMENT_EVIDENCE_EXCLUDED).forEach(node=>node.remove());
  clone.querySelectorAll('div,p,li,section,article,button,br').forEach(node=>{node.before('\n');node.after('\n')});
  return clone.textContent||'';
 }
 function attachmentSourceIdentity(source){
  try{
   const url=new URL(source);
   if(!/^https?:$/.test(url.protocol))return source;
   const azure=['sv','sig','se','sp','sr'].every(key=>url.searchParams.has(key));
   const aws=url.searchParams.get('X-Amz-Algorithm')==='AWS4-HMAC-SHA256'&&['X-Amz-Credential','X-Amz-Signature','X-Amz-Expires'].every(key=>url.searchParams.has(key));
   if(!azure&&!aws)return source;
   for(const key of [...url.searchParams.keys()]){
    if(azure&&/^(?:sig|se|st|sv|sr|sp|skoid|sktid|skt|ske|sks|skv|rsct|rscd)$/i.test(key)||aws&&/^x-amz-(?:signature|credential|date|expires|security-token|signedheaders)$/i.test(key))url.searchParams.delete(key);
   }
   url.searchParams.sort();return url.href;
  }catch{return source}
 }
 function composerAttachmentSnapshot(scope=attachmentScope()){
  if(!scope)return {cards:[],rawImages:0,rawMarkers:0,imageCount:0};
  const local=element=>visible(element)&&!element.closest?.(ATTACHMENT_EVIDENCE_EXCLUDED);
  const rawMarked=[...scope.querySelectorAll(ATTACHMENT_SELECTOR)].filter(element=>visible(element)&&!element.closest(COMPOSER_OVERLAY)),marked=rawMarked.filter(local);
  // One file can expose both test ids, and one outer group can contain several
  // files. Collapse single-file ancestor chains, never multi-file groups.
  const leaves=marked.filter(node=>!marked.some(child=>child!==node&&node.contains(child)));
  const roots=leaves.map(leaf=>{
   const chain=marked.filter(node=>node.contains(leaf)&&leaves.filter(child=>node.contains(child)).length===1);
   return chain.find(node=>!chain.some(parent=>parent!==node&&parent.contains(node)))||leaf;
  });
  const isAvatar=img=>{
   const hint=[img.getAttribute?.('alt'),img.getAttribute?.('data-testid'),img.getAttribute?.('class')].filter(Boolean).join(' ');
   const control=img.closest?.('button,[role="button"]');
   return /(?:^|[\s_-])avatar(?:$|[\s_-])|头像|profile picture/i.test(hint)||/账户|账号|个人资料|account|profile/i.test([control?.getAttribute?.('aria-label'),control?.getAttribute?.('title')].filter(Boolean).join(' '));
  };
  const rawImages=[...scope.querySelectorAll('img')].filter(img=>{
   if(!visible(img)||img.closest(COMPOSER_OVERLAY))return false;
   const r=img.getBoundingClientRect();return r.width>=32&&r.height>=32&&r.width<=220&&r.height<=220;
  });
  const images=rawImages.filter(img=>local(img)&&!isAvatar(img));
  // Without a file-card relationship identical URLs could also be duplicate
  // uploaded files, so unmarked images must not be silently collapsed.
  const extras=images.filter(img=>!roots.some(root=>root.contains(img)));
  const cards=[...roots,...extras].map(node=>{
   const previews=images.filter(img=>node===img||node.contains(img));
   return {node,text:attachmentText(node),primaryNames:primaryAttachmentNames(node),images:previews.length,previewReady:previews.every(img=>img.complete!==false&&img.naturalWidth!==0),sources:[...new Set(previews.map(img=>img.currentSrc||img.src||''))].sort()};
  });
  return {cards,rawImages:rawImages.length,rawMarkers:rawMarked.length,imageCount:cards.filter(card=>card.images&&card.previewReady).length};
 }
 function workflowAttachmentEvidence(task,state){
  const references=referenceItems(task),expectedImages=references.length,requiredImages=task.workflow_input_mode==='single_source_edit'?1:2;
  const receipt=selectedAttachments,scope=attachmentScope();
  const box=composer(),sameComposer=Boolean(receipt&&(receipt.scope===scope||receipt.form&&receipt.form===box?.closest('form')&&scope?.contains(receipt.form)));
  const receiptValid=Boolean(receipt&&receipt.key===attachmentKey(task)&&sameComposer&&receipt.emptyBeforeSelection&&receipt.names.length===expectedImages&&receipt.names.every((name,index)=>name===uploadName(task,references[index]))&&Date.now()-receipt.at<600000);
  const assigned=new Set(),reasons=[],unnamed=[],identities=[];let namedImages=0,confirmedImages=0;
  for(const card of state.cards){
   // A full filename on the file card wins over a generic/bare preview alt.
   // Otherwise a foreign job/step can masquerade as this file's basename.
   const foreignName=card.primaryNames.some(value=>!references.some(item=>exactAttachmentName(value,uploadName(task,item))||exactAttachmentName(value,item.name)));
   const exact=references.map((item,index)=>exactAttachmentName(card.text,uploadName(task,item))?index:-1).filter(index=>index>=0);
   const matches=foreignName?[]:exact.length?exact:references.map((item,index)=>exactAttachmentName(card.text,item.name)?index:-1).filter(index=>index>=0);
   const hasFilename=/\.[a-z][a-z0-9]{0,11}(?:\b|$)/i.test(card.text);
   if(matches.length===1&&!assigned.has(matches[0])){assigned.add(matches[0]);namedImages++;confirmedImages++;identities.push(JSON.stringify(['name',uploadName(task,references[matches[0]]),card.sources.map(attachmentSourceIdentity).sort()]))}
   else if(matches.length>1||matches.length===1){reasons.push('附件身份重复或混合')}
   else if(hasFilename){reasons.push('存在其他文件名或其他步骤的附件')}
   else if(receiptValid&&card.images){confirmedImages++;unnamed.push(card);identities.push('preview:'+JSON.stringify(card.sources))}
   else reasons.push('附件文件身份尚未确认');
   if(!card.previewReady)reasons.push('附件预览仍未加载完成');
  }
  if(expectedImages!==requiredImages)reasons.push('任务附件数量不符合本步骤');
  if(state.cards.length!==requiredImages)reasons.push('实际唯一附件数量不符');
  if(confirmedImages!==requiredImages)reasons.push('任务附件未全部对应');
  if(state.uploading)reasons.push('仍有附件正在上传');
  if(unnamed.some(card=>card.sources.some(source=>source&&state.cards.some(other=>other!==card&&other.sources.includes(source)))))reasons.push('无文件名的附件预览身份重复');
  // Signed preview URLs, remove-button labels and upload decorations can be
  // recreated while the same named file stays attached. Stability follows the
  // verified file identities; unnamed receipt-backed cards still require the
  // same preview sources and cannot silently exchange files.
  const fingerprint=identities.sort().join('|');
  return {ready:reasons.length===0,count:confirmedImages,namedImages,reference:confirmedImages===requiredImages,references:confirmedImages,expectedImages,archive:false,uploading:Boolean(state.uploading),images:state.imageCount,rawImages:state.rawImages,rawThumbnails:state.rawMarkers,uniqueAttachments:state.cards.length,reasons:[...new Set(reasons)],fingerprint};
 }
 function attachmentEvidence(task,{searchable,imageCount,thumbnailCount,uploading,cards,rawImages,rawMarkers}){
  if(workflowTask(task)&&Array.isArray(cards))return workflowAttachmentEvidence(task,{cards,imageCount,uploading,rawImages,rawMarkers});
  const references=referenceItems(task),expectedImages=references.length;
  const namedImages=references.filter(item=>nameVisible(searchable,uploadName(task,item))||nameVisible(searchable,item.name)).length;
  if(workflowTask(task)){
   const requiredImages=task.workflow_input_mode==='single_source_edit'?1:2;
   const confirmedImages=Math.max(Math.min(imageCount,expectedImages),Math.min(namedImages,thumbnailCount||namedImages));
   return {ready:expectedImages===requiredImages&&confirmedImages===requiredImages&&imageCount<=requiredImages&&thumbnailCount<=requiredImages&&!uploading,count:confirmedImages,namedImages,reference:confirmedImages===requiredImages,references:confirmedImages,expectedImages,archive:false,uploading:Boolean(uploading),images:imageCount};
  }
  const archive=nameVisible(searchable,uploadName(task,task.template_archive))||nameVisible(searchable,task.template_archive.name);
  const confirmedImages=Math.max(Math.min(imageCount,expectedImages),Math.min(namedImages,thumbnailCount||namedImages));
  const reference=confirmedImages>=expectedImages;
  return {ready:Boolean(reference&&archive&&!uploading),count:confirmedImages+Number(archive),reference:Boolean(reference),references:confirmedImages,expectedImages,archive:Boolean(archive),uploading:Boolean(uploading),images:imageCount};
 }
 function attachmentScope(){
  const box=composer();if(!box)return null;
  const form=box.closest('form'),base=form||box.parentElement;
  if(!base)return null;
  let scope=base;
  // The attachment tray may be a sibling of the form rather than its child.
  // Stay inside the nearest small composer wrapper; never expand through chat
  // turns, another editor, dialogs or page-level containers to count images.
  for(let parent=base.parentElement,depth=0;parent&&depth<3;parent=parent.parentElement,depth++){
   if(parent.matches('body,main,html,[role="main"],'+DIALOG_SELECTOR+','+COMPOSER_OVERLAY)||parent.querySelector(USER_SELECTOR+','+ASSISTANT_SELECTOR))break;
   const editors=[...parent.querySelectorAll('#prompt-textarea,[contenteditable="true"],textarea')].filter(editor=>visible(editor)&&!editor.closest(ATTACHMENT_EVIDENCE_EXCLUDED));
   if(editors.some(editor=>editor!==box&&!box.contains(editor)&&!editor.contains(box)))break;
   const outside=[...parent.querySelectorAll(ATTACHMENT_SELECTOR)].some(node=>!scope.contains(node)&&!node.closest(ATTACHMENT_EVIDENCE_EXCLUDED));
   const uploader=[...parent.querySelectorAll('button,[role="button"]')].some(node=>!scope.contains(node)&&visible(node)&&!node.closest(ATTACHMENT_EVIDENCE_EXCLUDED)&&/^(?:添加文件等内容|添加文件等|添加照片和文件|添加照片\/文件|添加文件|添加附件|上传文件|add files|attach files|upload files|add photos and files|upload from computer)$/i.test(label(node)));
   if(outside||uploader)scope=parent;
  }
  return scope;
 }
 function attachmentPresence(){
  const scope=attachmentScope();if(!scope)return false;
  return composerAttachmentSnapshot(scope).cards.length>0||/\.zip(?:\b|$)/i.test(attachmentLocalText(scope));
 }
 function attachmentState(task){
  const scope=attachmentScope();if(!scope)return {ready:false,count:0};
  const elements=[scope,...scope.querySelectorAll('[aria-label],[title]')].filter(el=>visible(el)&&!el.closest(ATTACHMENT_EVIDENCE_EXCLUDED));
  const searchable=[attachmentLocalText(scope),...elements.map(el=>[el.getAttribute?.('aria-label'),el.getAttribute?.('title')].filter(Boolean).join(' '))].join('\n');
  const snapshot=composerAttachmentSnapshot(scope);
  const uploading=[...scope.querySelectorAll('[role="progressbar"],[data-testid*="uploading"],[aria-label*="上传中"],[aria-label*="Uploading"],[aria-busy="true"]')].some(el=>visible(el)&&!el.closest(ATTACHMENT_EVIDENCE_EXCLUDED));
  return attachmentEvidence(task,{searchable,imageCount:snapshot.imageCount,thumbnailCount:snapshot.cards.length,uploading,...snapshot});
 }
 function ownedComposer(task){
  const text=composerText().trim();if(text&&!draftMatches(task.prompt))return false;
  const state=attachmentState(task);
  return Boolean(text||state.archive);
 }
 function canRetryPresend(task,attempt,pathname,owned){return Boolean(!task.resume&&!attempt.crossedSendBoundary&&pathname==='/'&&owned)}
 async function clearOwnedPresendComposer(task){
  if(location.pathname!=='/'||document.querySelector('[data-message-author-role]')||!ownedComposer(task))return false;
  const box=composer();if(!box)return false;
  if(composerText(box).trim()){
   if(!draftMatches(task.prompt))return false;
   if(!clearComposerText(box))return false;
  }
  for(let attempt=0;attempt<4&&attachmentPresence();attempt++){
   const scope=attachmentScope();
   const remove=[...scope.querySelectorAll('button,[role="button"]')].find(el=>visible(el)&&!el.closest(ATTACHMENT_EVIDENCE_EXCLUDED)&&/^(?:移除|删除|remove|delete)/i.test([label(el),el.getAttribute('title'),el.getAttribute('data-testid')].filter(Boolean).join(' ')));
   if(!remove)break;
   remove.click();await sleep(500);
  }
  return !composerText(box).trim()&&!attachmentPresence();
 }
 async function waitAttachments(task,timeout=120000){
  // ChatGPT can briefly replace attachment chips while rendering. Require
  // two positive observations at least two seconds apart, with both files
  // still visible and no upload indicator on the final observation.
  const expected=attachmentItems(task).length;
  let stable={firstReadyAt:null,positiveCount:0,fingerprint:''},last={};try{return await waitFor(()=>{last=attachmentState(task);stable=attachmentStability(stable,last,Date.now());return stable.ready?last:null},timeout,expected+' 个附件未在发送框中稳定挂载，已停止发送')}
  catch{throw attachmentFailure(task,`${expected} 个附件未在发送框中稳定挂载，已停止发送（图片 ${last.references||0}/${last.expectedImages||referenceItems(task).length}${workflowTask(task)?'、唯一附件 '+(last.uniqueAttachments??'未知')+'、原始图片 '+(last.rawImages??'未知')+'、原始标记 '+(last.rawThumbnails??'未知')+'、原因 '+(last.reasons?.join('；')||'连续稳定时间不足'):'、ZIP 确认 '+Boolean(last.archive)}、上传中 ${Boolean(last.uploading)}；${uploadDiagnostic()}）`)}
 }
 function attachmentStability(previous,state,at){
  if(!state.ready)return {firstReadyAt:null,positiveCount:0,fingerprint:'',ready:false};
  const fingerprint=state.fingerprint||JSON.stringify([state.references,state.archive,state.uniqueAttachments]);
  const same=previous.firstReadyAt!==null&&previous.fingerprint===fingerprint;
  const firstReadyAt=same?previous.firstReadyAt:at,positiveCount=same?previous.positiveCount+1:1;
  return {firstReadyAt,positiveCount,fingerprint,ready:positiveCount>=2&&at-firstReadyAt>=2000};
 }
 function attachmentDiagnostic(){
  // Local task-failure telemetry only. Never serialize DOM, labels, filenames,
  // text, classes or URLs; the backend accepts this fixed numeric/boolean schema.
  const empty=()=>({version:1,state:'missing_composer',scope:'none',composer:{connected:false,visible:false},control:{present:false,connected:false,visible:false,native_disabled:false,inherited_disabled:false,aria_disabled:false,expanded:false,open:false,marked:false},counts:{elements:0,file_inputs:0,disabled_inputs:0,multiple_inputs:0,markers:0,visible_markers:0,images:0,visible_images:0,image_small:0,image_eligible_size:0,image_large:0,image_unloaded:0,images_in_overlay:0,images_in_dialog:0,images_in_history:0,overlays:0,progress:0,remove_buttons:0,file_dialog_buttons:0,cards:0,raw_images:0,raw_markers:0},ancestors:{overlay:false,dialog:false,history:false}}),result=empty();
  const box=composer();if(!box)return result;
  result.composer={connected:box.isConnected!==false,visible:Boolean(visible(box))};
  const scope=attachmentScope();if(!scope){result.state='missing_scope';return result}
  result.scope=scope===box.closest('form')?'form':scope===box.parentElement?'parent':'wrapper';
  result.ancestors={overlay:Boolean(scope.closest(COMPOSER_OVERLAY)),dialog:Boolean(scope.closest(DIALOG_SELECTOR)),history:Boolean(scope.closest(USER_SELECTOR+','+ASSISTANT_SELECTOR))};
  if(result.ancestors.dialog||result.ancestors.history){result.state='excluded_scope';return result}
  const elements=scope.querySelectorAll('*');result.counts.elements=Math.min(elements.length,5000);
  if(elements.length>5000){result.state='truncated';return result}
  const control=uploadControl();
  if(control&&scope.contains(control))result.control={present:true,connected:control.isConnected!==false,visible:Boolean(visible(control)),native_disabled:Boolean(control.disabled),inherited_disabled:Boolean(control.matches(':disabled')),aria_disabled:String(control.getAttribute('aria-disabled')||'').trim().toLowerCase()==='true',expanded:control.getAttribute('aria-expanded')==='true',open:control.getAttribute('data-state')==='open',marked:Boolean(control.matches(ADD_CONTEXT))};
  const marked=[],images=[];
  for(const node of elements){
   const shown=Boolean(visible(node)),overlay=Boolean(node.closest(COMPOSER_OVERLAY)),dialog=Boolean(node.closest(DIALOG_SELECTOR)),history=Boolean(node.closest(USER_SELECTOR+','+ASSISTANT_SELECTOR)),local=shown&&!overlay&&!dialog&&!history;
   if(node.matches('input[type="file"]')){result.counts.file_inputs++;if(uploadActionDisabled(node))result.counts.disabled_inputs++;if(node.multiple)result.counts.multiple_inputs++}
   if(node.matches(ATTACHMENT_SELECTOR)){result.counts.markers++;if(shown)result.counts.visible_markers++;if(shown&&!overlay)result.counts.raw_markers++;if(local)marked.push(node)}
   if(node.matches(COMPOSER_OVERLAY))result.counts.overlays++;
   if(local&&node.matches('[role="progressbar"],[data-testid*="uploading"],[aria-busy="true"]'))result.counts.progress++;
   if(node.matches('button,[role="button"]')){
    if(shown&&node.matches('[aria-label^="移除"],[aria-label^="删除"],[aria-label^="remove" i],[aria-label^="delete" i],[title^="移除"],[title^="删除"],[title^="remove" i],[title^="delete" i]'))result.counts.remove_buttons++;
    if(shown&&node.matches('[aria-haspopup="dialog"]'))result.counts.file_dialog_buttons++;
   }
   if(!node.matches('img'))continue;
   result.counts.images++;if(overlay)result.counts.images_in_overlay++;if(dialog)result.counts.images_in_dialog++;if(history)result.counts.images_in_history++;
   if(node.complete===false||node.naturalWidth===0)result.counts.image_unloaded++;
   if(!shown)continue;
   result.counts.visible_images++;const rect=node.getBoundingClientRect();
   if(rect.width<32||rect.height<32)result.counts.image_small++;
   else if(rect.width>220||rect.height>220)result.counts.image_large++;
   else{result.counts.image_eligible_size++;if(!overlay)result.counts.raw_images++;if(local)images.push(node)}
  }
  const leaves=marked.filter(node=>!marked.some(child=>child!==node&&node.contains(child)));
  // Structural candidate count, not evidence of file identity or readiness.
  result.counts.cards=leaves.length+images.filter(image=>!marked.some(node=>node.contains(image))).length;
  result.state='captured';
  return JSON.stringify(result).length<=3072?result:{...empty(),state:'truncated'};
 }
 function attachmentFailure(task,message){
  const error=Error(message);
  if(workflowTask(task)&&task.step_phase==='ready'){
   error.code='workflow_attachment_not_ready';
   try{error.attachmentDiagnostic=attachmentDiagnostic()}catch{/* Diagnostics must never replace the original failure or prevent isolation. */}
  }
  return error;
 }
 async function attach(task){
  // ChatGPT has used several labels for the same composer upload control.
  // Keep exact-label matching, but cover the current Chinese UI as well as
  // the English variants so a UI copy change cannot strand unsent jobs.
  const originalBox=composer(),originalKey=attachmentKey(task);
  if(!originalBox||composerText(originalBox).trim())throw attachmentFailure(task,'GPT 输入框尚未就绪或已有其他草稿，已停止选择文件');
  let input=uploadInput(true,task),captured=false;
  if(!input){
   const control=await waitFor(uploadControl,20000,'找不到添加文件按钮').catch(()=>{throw attachmentFailure(task,'找不到添加文件按钮（'+uploadDiagnostic()+'）')});
   input=await activateUploadControl(control,task);
   if(!input)throw attachmentFailure(task,'当前上传控件未同步触发可确认的文件输入框，已停止选择文件（'+uploadDiagnostic()+'）');
   captured=true;
  }
  const items=attachmentItems(task),files=items.map(item=>file(item,uploadName(task,item)));
  if(composer()!==originalBox||originalBox.isConnected===false||attachmentKey(task)!==originalKey||composerText(originalBox).trim())throw attachmentFailure(task,'选择文件前输入框、本步骤或草稿已变化，已停止上传');
  const scope=attachmentScope(),before=composerAttachmentSnapshot(scope);
  const hiddenOrVisibleMarkers=scope?[...scope.querySelectorAll(ATTACHMENT_SELECTOR)].filter(node=>!node.closest?.(ATTACHMENT_EVIDENCE_EXCLUDED)):[];
  if(before.cards.length||hiddenOrVisibleMarkers.length)throw attachmentFailure(task,'当前输入框已有附件，已停止重新选择文件');
  const selection={key:attachmentKey(task),scope,form:composer()?.closest('form'),names:files.map(item=>item.name),emptyBeforeSelection:before.cards.length===0&&hiddenOrVisibleMarkers.length===0,at:Date.now()};
  selectedAttachments=null;
  if(input.multiple){
   try{selectFiles(input,files)}catch(error){throw attachmentFailure(task,error.message)}
  }else{
   for(let index=0;index<files.length;index++){
    const item=files[index];
    const target=input.isConnected?input:captured?null:uploadInput(true,task);
    if(!target)throw attachmentFailure(task,'选择第 '+(index+1)+'/'+files.length+' 个附件时找不到 GPT 文件框');
    try{selectFiles(target,[item])}catch(error){throw attachmentFailure(task,error.message)}
    await sleep(750);
   }
  }
  selectedAttachments=selection;
  await post('/update',{job_id:task.job_id,event:'progress',message:'已选择 '+files.length+'/'+files.length+' 个附件，等待 GPT 完成上传'});
  await waitAttachments(task);
  await post('/update',{job_id:task.job_id,event:'progress',message:workflowTask(task)?(task.workflow_input_mode==='single_source_edit'?'本张待修原图已就绪，正在填写局部修改提示词':'模板与本款印花依据两张图片已就绪，正在填写本步骤提示词'):referenceItems(task).length+' 张参考图和模板 ZIP 已就绪，正在填写提示词'});
 }
 async function enterPrompt(text){
  const box=await waitFor(composer,20000,'找不到 GPT 输入框');
  if(composerText(box).replace(/\s+/g,'')===String(text).replace(/\s+/g,''))return;
  if(composerText(box).trim())throw Error('输入框已有草稿，禁止覆盖或追加提示词（编辑器 '+box.tagName+'#'+(box.id||'')+'，正文 '+composerText(box).trim().length+' 字）');
  box.focus();
  if('value' in box&&!box.isContentEditable){writePlainValue(box,text)}else{
   const selection=window.getSelection(),range=document.createRange();range.selectNodeContents(box);range.collapse(false);selection.removeAllRanges();selection.addRange(range);
   document.execCommand('insertText',false,text);
  }
  box.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:text}));
  // Controlled editors can commit their readable content on the next render.
  await waitFor(()=>composerText().replace(/\s+/g,'')===String(text).replace(/\s+/g,''),8000,'提示词写入后内容不一致，已停止发送');
 }
 function imageKey(img){return img.currentSrc||img.src||''}
 function generatedEvidence(img){
  const src=imageKey(img),assistant=img?.closest?.(ASSISTANT_SELECTOR);
  const user=img?.closest?.(USER_SELECTOR);
   const attachment=img?.closest?.('form,[data-testid*="attachment"],[data-testid*="file-thumbnail"],[data-testid*="composer-attachment"]');
  const holder=img?.closest?.('figure,button,[role="button"],[data-testid]');
  const metadata=[img?.alt,img?.getAttribute?.('aria-label'),img?.getAttribute?.('title'),
   holder?.getAttribute?.('aria-label'),holder?.getAttribute?.('title'),holder?.getAttribute?.('data-testid'),
   assistant?.getAttribute?.('data-testid'),assistant?.className].filter(Boolean).join(' ').toLowerCase();
  const generatedHint=/生成|generated|image[-_ ]generation|dall[· -]?e|created image|已生成图像|生成图片/i.test(metadata);
  const generatedSource=/oaiusercontent\.com|generated|image[-_ ]generation/i.test(src);
  const actions=assistant?[...assistant.querySelectorAll('button,a,[role="button"]')].filter(visible).map(el=>[label(el),el.getAttribute('title'),el.getAttribute('data-testid')].filter(Boolean).join(' ')).join(' '):'';
   const generatedAction=/(?:下载|保存|编辑|重新生成).{0,16}(?:图片|图像)|(?:download|save|edit|regenerate).{0,16}(?:image|picture)/i.test(actions);
   return {src,assistant,user,attachment,generatedHint,generatedAction,generatedSource};
 }
 function isGeneratedImage(img){
  const evidence=generatedEvidence(img);
  if(!evidence.src||evidence.user||evidence.attachment)return false;
  // backend-api/files and file-service are also used for user uploads. They
  // are accepted only with explicit generated-image metadata.
  if(/backend-api\/files|file-service/i.test(evidence.src))return evidence.generatedHint||evidence.generatedAction;
  return evidence.generatedHint||evidence.generatedSource;
 }
 function generatedCandidate(img){
  const evidence=generatedEvidence(img);
  if(evidence.user||evidence.attachment)return false;
  // Some ChatGPT builds omit alt/test ids on the assistant's generated file
  // card. Keep that card discoverable for the viewer path, while direct
  // downloads still require the stronger isGeneratedImage check below.
  return Boolean(evidence.generatedHint||(!/backend-api\/files|file-service/i.test(evidence.src)&&evidence.generatedSource)||
   (evidence.generatedAction&&/backend-api\/files|file-service/i.test(evidence.src)));
 }
 function generatedSet(root=document){
  const workflowScope=root===document&&activeWorkflowTask;
  if(workflowScope){
   const turn=workflowAssistantTurn(activeWorkflowTask);
   if(!turn)return {scope:document.createElement('div'),images:[],unique:[]};
   root=turn;
  }
  const turns=workflowScope?[]:messageTurns(ASSISTANT_SELECTOR,root);
  const scope=workflowScope?root:[...turns].reverse().find(turn=>[...turn.querySelectorAll('img')].some(img=>visible(img)&&img.getBoundingClientRect().width>=38))||turns.at(-1)||root;
  // A decoded generated image in the exactly-bound assistant turn is safe
  // to fetch even if background layout reports a zero-sized rectangle.
  // Never apply this relaxed geometry rule to legacy whole-page discovery.
  const images=[...scope.querySelectorAll('img')].filter(img=>{const rect=img.getBoundingClientRect();const decoded=workflowScope&&img.complete&&img.naturalWidth>=256&&img.naturalHeight>=256;return (decoded||(visible(img)&&rect.width>=38&&rect.height>=38))&&generatedCandidate(img)});
  const ordered=[...images].sort((a,b)=>Number(isGeneratedImage(b))-Number(isGeneratedImage(a)));
  const unique=[];for(const img of ordered){const key=imageKey(img);if(key&&!unique.some(item=>item.key===key))unique.push({key,img})}
  return {scope,images,unique};
 }
 function expectedCount(task){const count=Number(task.expected_count);if(!Number.isInteger(count)||count<1)throw Error('任务缺少有效的模板图片数量');return count}
 function responseWaitDecision(task,at=Date.now()){
  const started=Date.parse(task.response_last_progress_at||'');
  if(!Number.isFinite(started)||at-started<603000)return null;
  return Number(task.response_refresh_count||0)>0?'fail':'refresh';
 }
 function inTaskChat(current,expected){
  const route=value=>{try{const url=new URL(String(value||''));const path=decodeURIComponent(url.pathname);const match=url.hostname==='chatgpt.com'&&url.protocol==='https:'&&path.match(/^\/c\/([A-Za-z0-9:._-]+)\/?$/);return match?['',`/c/${match[1]}`]:null}catch{return null}};
  const actual=route(current),original=expected?route(expected):null;
  return Boolean(actual&&(!expected||original&&actual[1]===original[1]));
 }
 function stableChatUrl(value){try{const url=new URL(String(value||''));return url.protocol==='https:'&&url.hostname==='chatgpt.com'&&/^\/c\/(?!WEB:)[A-Za-z0-9._-]+\/?$/.test(decodeURIComponent(url.pathname))}catch{return false}}
 function promptVisibleInChat(task){
  const expected=String(task.prompt||'').replace(/\s+/g,'').slice(0,80);
  return Boolean(expected&&[...document.querySelectorAll('[data-message-author-role="user"]')].some(el=>(el.innerText||el.textContent||'').replace(/\s+/g,'').includes(expected)));
 }
 async function adoptStableChat(task){
  if(stableChatUrl(task.chat_url)||!stableChatUrl(location.href)||sessionStorage.getItem('workbenchSentJob')!==task.job_id||!promptVisibleInChat(task))return false;
  await post('/update',{job_id:task.job_id,event:'waiting',chat_url:location.href});task.chat_url=location.href;
  sessionStorage.removeItem('workbenchSentJob');return true;
 }
 function downloadableImageUrl(value){
  try{const url=new URL(value);return url.protocol==='https:'&&(url.hostname==='chatgpt.com'||url.hostname==='oaiusercontent.com'||url.hostname.endsWith('.oaiusercontent.com'))?url.href:''}catch{return ''}
 }
 function bestImageUrl(img){
  if(!img)return '';
  const srcset=String(img.getAttribute?.('srcset')||'').split(',').map((item,index)=>{
   const match=item.trim().match(/^(\S+)(?:\s+(\d+(?:\.\d+)?)(w|x))?$/);if(!match)return null;
   const weight=match[3]==='w'?Number(match[2]||0):Number(match[2]||1)*10000;
   return {url:match[1],weight,index};
  }).filter(Boolean).sort((a,b)=>b.weight-a.weight||b.index-a.index).map(item=>item.url);
  const holder=img.closest?.('a[href]');
  const candidates=[img.getAttribute?.('data-original'),img.getAttribute?.('data-src'),...srcset,
   img.currentSrc,img.src,holder?.getAttribute?.('href')];
  for(const value of candidates){const safe=downloadableImageUrl(value);if(safe)return safe}
  return '';
 }
 function bestImageSource(img){
  const remote=bestImageUrl(img);if(remote)return remote;
  const candidates=[img?.getAttribute?.('data-original'),img?.getAttribute?.('data-src'),img?.currentSrc,img?.src];
  for(const value of candidates){
   const source=String(value||'');
   if(/^blob:https:\/\/chatgpt\.com\//i.test(source)||/^data:image\/(?:png|jpe?g|webp);base64,/i.test(source))return source;
  }
  return '';
 }
 function bytesToBase64(bytes){
  const parts=[];for(let offset=0;offset<bytes.length;offset+=32768)parts.push(String.fromCharCode(...bytes.subarray(offset,offset+32768)));
  return btoa(parts.join(''));
 }
 async function transferableImage(source){
  const response=await fetch(source);if(!response.ok)throw Error('读取页面生成图失败：HTTP '+response.status);
  const blob=await response.blob(),mime=String(blob.type||'').toLowerCase();
  if(!/^image\/(?:png|jpeg|webp)$/.test(mime))throw Error('页面生成图格式无效：'+(mime||'未知格式'));
  if(blob.size<1024)throw Error('页面生成图内容过小，已停止保存');
  if(blob.size>30*1024*1024)throw Error('页面生成图超过 30MB，已停止保存');
  return {mime,base64:bytesToBase64(new Uint8Array(await blob.arrayBuffer()))};
 }
 function missingAttachmentReply(){
  const turns=[...document.querySelectorAll('[data-message-author-role="assistant"]')];
  const text=(turns.at(-1)?.innerText||turns.at(-1)?.textContent||'').replace(/\s+/g,' ');
  return /(?:没有|未)(?:收到|检测到|看见).{0,40}(?:文件|附件)|请重新上传.{0,40}(?:文件|附件)|(?:did not|didn't|cannot|can't).{0,40}(?:receive|find|see).{0,30}(?:file|attachment)|please (?:re-)?upload/i.test(text);
 }
 function responseDiagnostic(){
   const turns=[...document.querySelectorAll('[data-message-author-role="assistant"]')],userTurns=[...document.querySelectorAll('[data-message-author-role="user"]')];
  const assistantText=(turns.at(-1)?.innerText||turns.at(-1)?.textContent||'').replace(/\s+/g,' ').trim().slice(0,500);
  const alerts=[...document.querySelectorAll('[role="alert"],[data-testid*="error"],.text-token-text-error')]
   .filter(visible).map(el=>(el.innerText||el.textContent||'').replace(/\s+/g,' ').trim()).filter(Boolean);
   const set=generatedSet(),stopping=Boolean(button(['停止生成','停止流式传输','Stop generating','Stop streaming']));
   return {assistantText,alertText:[...new Set(alerts)].join('；').slice(0,500),userTurns:userTurns.length,assistantTurns:turns.length,candidateImages:set.unique.length,generatedImages:set.images.filter(isGeneratedImage).length,stopping,composerAttachments:attachmentPresence()?1:0};
  }
 function explicitGenerationFailure(diagnostic){
  const text=[diagnostic?.assistantText,diagnostic?.alertText].filter(Boolean).join(' ');
  if(!text)return '';
  const failed=/(?:图片|图像).{0,20}(?:生成|创建).{0,20}(?:上限|限制|失败|不可用)|(?:达到|已达).{0,30}(?:图片|图像).{0,20}(?:上限|限制)|(?:无法|不能).{0,30}(?:生成|创建|编辑).{0,20}(?:图片|图像)|(?:image|picture).{0,30}(?:generation )?(?:limit|unavailable|failed)|(?:reached|hit).{0,30}(?:image|picture).{0,20}(?:limit|cap)|(?:can't|cannot|unable to).{0,35}(?:generate|create|edit).{0,20}(?:image|picture)|something went wrong (?:while )?generating|error generating (?:a )?response/i.test(text);
  return failed?text.slice(0,500):'';
 }
 async function repairAttachments(task){
  if(Number(task.attachment_repair_count||0)>=2)throw Error('GPT 仍反馈缺少附件，自动补传已达上限');
  await post('/update',{job_id:task.job_id,event:'attachment_repairing'});
  await attach(task);
  const followup='补充上传本任务缺少的 '+attachmentItems(task).length+' 个附件：'+referenceItems(task).length+' 张参考图与套图模板 ZIP。请结合上一条要求继续执行，生成 '+expectedCount(task)+' 张单独图片，不得拼图。';
  await enterPrompt(followup);await waitAttachments(task,30000);
  const send=await waitFor(sendButton,30000,'补传附件后发送按钮未就绪');
  const before=document.querySelectorAll('[data-message-author-role="user"]').length;
  await post('/update',{job_id:task.job_id,event:'attachment_repair_sending'});send.click();
  await waitFor(()=>document.querySelectorAll('[data-message-author-role="user"]').length>before,60000,'附件补充消息未确认发送');
  await post('/update',{job_id:task.job_id,event:'attachment_repaired'});task.attachment_repair_count=Number(task.attachment_repair_count||0)+1;task.attachment_repair_state='sent';
 }
 async function waitImages(task){
  const expected=expectedCount(task);
  task.response_last_progress_at=new Date().toISOString();
  let stable=0,lastCount=-1,lastScroll=0;
  while(true){
   if(!inTaskChat(location.href,task.chat_url))throw Error('收图页面已离开本任务原对话，已停止，禁止在首页覆盖对话地址');
   if(Date.now()-lastScroll>15000){
    const lastTurn=[...document.querySelectorAll('[data-message-author-role="assistant"]')].at(-1);
    lastTurn?.scrollIntoView?.({block:'end'});lastScroll=Date.now();await sleep(300);
   }
   const set=generatedSet();
   if(!set.unique.length&&missingAttachmentReply()&&!['sending','sent'].includes(task.attachment_repair_state||'')){
    await repairAttachments(task);task.response_last_progress_at=new Date().toISOString();task.response_refresh_count=0;
    }
    const stopping=button(['停止生成','停止流式传输','Stop generating','Stop streaming']);
    const diagnostic=responseDiagnostic(),failure=!stopping&&!set.unique.length?explicitGenerationFailure(diagnostic):'';
    if(failure){
     await post('/update',{job_id:task.job_id,event:'response_diagnostic',assistant_text:diagnostic.assistantText,alert_text:diagnostic.alertText,user_turns:diagnostic.userTurns,assistant_turns:diagnostic.assistantTurns,candidate_images:diagnostic.candidateImages,generated_images:diagnostic.generatedImages,stopping:diagnostic.stopping,composer_attachments:diagnostic.composerAttachments}).catch(()=>{});
     await post('/update',{job_id:task.job_id,event:'generation_failed',message:failure});location.href='https://chatgpt.com/';return null;
    }
   if(set.unique.length>Number(task.observed_image_count||0)){
    await post('/update',{job_id:task.job_id,event:'image_progress',count:Math.min(set.unique.length,expected)});
    task.observed_image_count=Math.min(set.unique.length,expected);task.response_last_progress_at=new Date().toISOString();task.response_refresh_count=0;
   }
   if(set.unique.length!==lastCount){lastCount=set.unique.length;await post('/update',{job_id:task.job_id,event:'progress',message:'已识别 '+Math.min(lastCount,expected)+'/'+expected+' 张独立图片'}).catch(()=>{})}
   if(set.unique.length>=expected&&!stopping){stable++;if(stable>=4){const preferred=set.images.filter(isGeneratedImage);const main=[...(preferred.length?preferred:set.images)].sort((a,b)=>{const x=a.getBoundingClientRect(),y=b.getBoundingClientRect();return y.width*y.height-x.width*x.height})[0];return main?.closest('button,[role="button"]')||main}}else stable=0;
    const decision=responseWaitDecision(task);
    if(decision==='refresh'){
     const diagnostic=responseDiagnostic();await post('/update',{job_id:task.job_id,event:'response_diagnostic',assistant_text:diagnostic.assistantText,alert_text:diagnostic.alertText,user_turns:diagnostic.userTurns,assistant_turns:diagnostic.assistantTurns,candidate_images:diagnostic.candidateImages,generated_images:diagnostic.generatedImages,stopping:diagnostic.stopping,composer_attachments:diagnostic.composerAttachments}).catch(()=>{});
     await post('/update',{job_id:task.job_id,event:'response_refresh'});
    task.response_refresh_count=1;task.response_last_progress_at=new Date().toISOString();
    location.reload();return null;
   }
    if(decision==='fail'){
     const diagnostic=responseDiagnostic();await post('/update',{job_id:task.job_id,event:'response_diagnostic',assistant_text:diagnostic.assistantText,alert_text:diagnostic.alertText,user_turns:diagnostic.userTurns,assistant_turns:diagnostic.assistantTurns,candidate_images:diagnostic.candidateImages,generated_images:diagnostic.generatedImages,stopping:diagnostic.stopping,composer_attachments:diagnostic.composerAttachments}).catch(()=>{});
     await post('/update',{job_id:task.job_id,event:'response_timeout'});
    location.href='https://chatgpt.com/';return null;
   }
   try{await post('/update',{job_id:task.job_id,event:'waiting',chat_url:location.href})}
   catch(error){if(/任务已暂停|任务已失败|任务不存在|失去任务所有权/.test(String(error?.message||error)))throw error}
   await sleep(2000);
  }
 }
 function waitDownload(task,index,timeout=180000){
  return new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>{extensionApi.runtime.onMessage.removeListener(listener);reject(Error('第 '+index+'张下载超时'))},timeout);
   function listener(message){if(message?.type!=='download-result'||message.job_id!==task.job_id||message.step!==index)return;clearTimeout(timer);extensionApi.runtime.onMessage.removeListener(listener);message.ok?resolve():reject(Error(message.error||'图片下载失败'))}
   extensionApi.runtime.onMessage.addListener(listener);
  });
 }
 async function downloadPageBlob(task,index,source){
  if(!/^blob:https:\/\/chatgpt\.com\//i.test(String(source||'')))return false;
  const armed=await extensionApi.runtime.sendMessage({type:'arm-download',task:downloadTask(task,index)});
  if(!armed?.ok)throw Error('无法监听第 '+index+'张下载');
  const completed=waitDownload(task,downloadIndex(task,index),45000);completed.catch(()=>{});
  const link=document.createElement('a');
  link.href=source;
  link.download='workbench-'+task.job_id.slice(0,12)+'-'+String(index).padStart(2,'0')+'.png';
  link.style.display='none';document.documentElement.appendChild(link);
  try{link.click()}finally{link.remove()}
  await completed;
  return true;
 }
 function inlineGallery(expected){
  const set=generatedSet();
  if(set.scope===document)return null;
  const thumbs=set.images.filter(img=>{const r=img.getBoundingClientRect();return r.width>=38&&r.width<=180&&r.height>=38&&r.height<=180});
  const ordered=[...thumbs].sort((a,b)=>Number(isGeneratedImage(b))-Number(isGeneratedImage(a)));
  const unique=[];for(const img of ordered){if(!unique.some(x=>imageKey(x)===imageKey(img)))unique.push(img)}
  return unique.length>=expected?{scope:set.scope,thumbs:unique.slice(0,expected)}:null;
 }
 function directGallery(expected){
  const set=generatedSet(),images=[];
  for(const item of set.unique){
   // The assistant's generated-image cards sometimes use the same
   // backend-api/files URL family as uploads and expose no useful alt text.
   // generatedCandidate already excludes every image inside the user turn;
   // the server also rejects bytes equal to either input attachment.
   if(!generatedCandidate(item.img))continue;
   const source=bestImageSource(item.img);if(!source||images.some(value=>value.source===source))continue;
   images.push({img:item.img,source});
  }
  return images.length>=expected?images.slice(0,expected):null;
 }
 async function downloadSource(task,index,img){
  const source=typeof img==='string'?img:bestImageSource(img);if(!source)return false;
  let message;
  try{message={type:'download-bytes',task:downloadTask(task,index),...await transferableImage(source)}}
  catch(error){
   if(await downloadPageBlob(task,index,source))return true;
   const url=downloadableImageUrl(source);if(!url)return false;
   message={type:'download-source',task:downloadTask(task,index),url};
  }
  const result=await extensionApi.runtime.sendMessage(message);
  if(!result?.ok)throw Error(result?.error||'无法直接下载已生成图片');
  return true;
 }
 async function downloadDirect(task){
  const expected=expectedCount(task);
  await post('/update',{job_id:task.job_id,event:'downloading'});
  for(let index=1;index<=expected;index++){
   if(task.saved.includes(index))continue;
   const images=await waitFor(()=>directGallery(expected),15000,'已生成图片的原始地址未就绪');
   await post('/update',{job_id:task.job_id,event:'progress',message:'正在直接保存第 '+index+'/'+expected+' 张生成图'});
   if(!await downloadSource(task,index,images[index-1].source))return false;await sleep(500);
  }
  if(!workflowTask(task))location.href='https://chatgpt.com/';
  return true;
 }
 async function downloadInline(task){
  const expected=expectedCount(task);
  await post('/update',{job_id:task.job_id,event:'downloading'});
  for(let index=1;index<=expected;index++){
   if(task.saved.includes(index))continue;
   const gallery=await waitFor(()=>inlineGallery(expected),15000,'聊天页 '+expected+' 张缩略图未就绪');
   const chosen=gallery.thumbs[index-1];const key=imageKey(chosen);
   (chosen.closest('button,[role="button"]')||chosen).click();
   await sleep(1200);
   await waitFor(()=>{const current=inlineGallery(expected);if(!current)return null;return [...current.scope.querySelectorAll('img')].find(img=>visible(img)&&img.getBoundingClientRect().width>180&&imageKey(img)===key)},10000,'切换第 '+index+' 张主图未确认，停止下载以免保存错图');
   const control=await waitFor(()=>{
    const current=inlineGallery(expected);if(!current)return null;
    const main=[...current.scope.querySelectorAll('img')].find(img=>visible(img)&&img.getBoundingClientRect().width>180&&imageKey(img)===key);
    if(!main)return null;
    // Stay inside the image card: never select the whole-response share action.
    const rect=main.getBoundingClientRect();
    return [...current.scope.querySelectorAll('button,a,[role="button"]')].find(el=>{
     if(!visible(el))return false;const r=el.getBoundingClientRect();
     const inside=r.left>=rect.left&&r.right<=rect.right+2&&r.top>=rect.top&&r.bottom<=rect.bottom+2;
     const name=[label(el),el.getAttribute('title'),el.getAttribute('data-testid')].filter(Boolean).join(' ');
     return inside&&/下载|保存|分享|导出|download|save|share|export/i.test(name);
    });
   },10000,'聊天页图片卡片内找不到保存或导出按钮');
   await post('/update',{job_id:task.job_id,event:'progress',message:'聊天页已选中第 '+index+' 张，开始下载'});
   const armed=await extensionApi.runtime.sendMessage({type:'arm-download',task:downloadTask(task,index)});if(!armed?.ok)throw Error('无法监听下载');
   const completed=waitDownload(task,downloadIndex(task,index));completed.catch(()=>{});
   control.click();await sleep(400);
   const isDirect=/^(下载|下载图片|Download|Download image)$/i.test(label(control));
   if(!isDirect){
    const menu=await waitFor(()=>[...document.querySelectorAll('[role="menuitem"],[role="dialog"] button,[data-radix-popper-content-wrapper] button')].find(el=>visible(el)&&/^(下载|下载图片|Download|Download image)$/i.test(label(el))),10000,'图片导出菜单中没有下载选项');menu.click();
   }
   await completed;await sleep(800);
  }
  if(!workflowTask(task))location.href='https://chatgpt.com/';
 }
 async function downloadImages(task,opener){
  const expected=expectedCount(task);
  const openerImage=opener?.tagName?.toLowerCase()==='img'?opener:opener?.querySelector?.('img');
  const openerKey=openerImage?imageKey(openerImage):'';
  if(directGallery(expected)&&await downloadDirect(task))return;
  if(inlineGallery(expected))return downloadInline(task);
  const currentViewer=()=>{
   const tagged=[...document.querySelectorAll('[data-testid*="image-viewer"],[data-testid*="lightbox"],[role="dialog"]')].find(visible);
   if(tagged)return tagged;
   const large=[...(workflowTask(task)?workflowAssistantTurn(task)||document.createElement('div'):document).querySelectorAll('img')].find(img=>{if(!visible(img))return false;const r=img.getBoundingClientRect();return r.width>500&&r.height>400});
   return large?.closest('main')||large?.parentElement?.parentElement||null;
  };
  opener.click();const dialog=await waitFor(currentViewer,20000,'没有打开图片查看器');
  await post('/update',{job_id:task.job_id,event:'downloading'});
  for(let index=1;index<=expected;index++){
   if(task.saved.includes(index))continue;
   if(expected===1){
    await waitFor(()=>{const current=currentViewer()||dialog;const images=[...current.querySelectorAll('img')].filter(img=>{const r=img.getBoundingClientRect();return visible(img)&&r.width>180&&r.height>180&&(generatedCandidate(img)||(openerKey&&imageKey(img)===openerKey))});return images.sort((a,b)=>{const x=a.getBoundingClientRect(),y=b.getBoundingClientRect();return y.width*y.height-x.width*x.height})[0]||null},20000,'单张图片查看器中未确认唯一主图');
   }else{
    const thumb=await waitFor(()=>{const current=currentViewer()||dialog;const buttons=[...current.querySelectorAll('button,[role="button"]')];const named=buttons.find(el=>new RegExp(`第\\s*${index}\\s*张图片|Image\\s*${index}\\s*(?:of|/)\\s*${expected}`,'i').test(label(el)));if(named)return named;const imageButtons=buttons.filter(el=>{const img=el.querySelector('img');if(!img)return false;const rect=el.getBoundingClientRect();return visible(el)&&rect.width>=32&&rect.height>=32&&rect.width<=180&&rect.height<=180});if(imageButtons[index-1])return imageButtons[index-1];const thumbs=[...current.querySelectorAll('img')].filter(img=>{const r=img.getBoundingClientRect();return visible(img)&&r.width>=32&&r.width<=180&&r.height>=32&&r.height<=180});return thumbs.length>=expected?thumbs[index-1]:null},20000,'找不到第 '+index+'张图片');thumb.click();
   }
   const saveName=el=>[label(el),el.getAttribute('title'),el.getAttribute('data-testid')].filter(Boolean).join(' ');
   const saveControl=()=>{
    const current=currentViewer()||dialog,buttons=[...current.querySelectorAll('button,[role="button"],a')].filter(visible);
    const named=buttons.find(el=>/^(?:保存|Save|下载|下载图片|Download|Download image|Export image)$/i.test(label(el)||el.getAttribute('title')||'')||/(?:download|save)[-_]?(?:image|button)|(?:image|button)[-_]?(?:download|save)/i.test(el.getAttribute('data-testid')||''));
    if(named)return named;
    const image=[...current.querySelectorAll('img')].find(img=>{if(!visible(img))return false;const r=img.getBoundingClientRect();return r.width>500&&r.height>400});
    if(!image)return null;
    const rect=image.getBoundingClientRect();
    return buttons.filter(el=>{const r=el.getBoundingClientRect();return r.width>=24&&r.width<=90&&r.height>=24&&r.height<=90&&r.top<=rect.top+90&&r.bottom>=rect.top-20&&r.left>=rect.right-420}).sort((a,b)=>a.getBoundingClientRect().left-b.getBoundingClientRect().left)[0]||null;
   };
   let save;try{save=await waitFor(saveControl,10000,'找不到图片保存或下载按钮')}
   catch{const current=currentViewer()||dialog;const names=[...current.querySelectorAll('button,[role="button"],a')].filter(visible).map(saveName).filter(Boolean).slice(0,12);throw Error('找不到图片保存或下载按钮；查看器控件：'+(names.join('、')||'无可读名称'))}
   const armed=await extensionApi.runtime.sendMessage({type:'arm-download',task:downloadTask(task,index)});if(!armed?.ok)throw Error('无法监听第 '+index+'张下载');
   const completed=waitDownload(task,downloadIndex(task,index));completed.catch(()=>{});save.click();
   const direct=/^(?:下载|下载图片|Download|Download image)$/i.test(label(save)||save.getAttribute('title')||'')||/download/i.test(save.getAttribute('data-testid')||'');
   if(!direct){
    const item=await waitFor(()=>[...document.querySelectorAll('[role="menuitem"],[role="dialog"] button')].find(el=>visible(el)&&/^(下载|下载图片|Download|Download image)$/i.test(label(el))),10000,'找不到下载菜单；请检查图片导出入口');item.click();
   }
   await completed;await sleep(800);
  }
  if(!workflowTask(task))location.href='https://chatgpt.com/';
 }
 function workflowUserTurn(task){
  const matches=messageTurns(USER_SELECTOR,document,true).filter(el=>(el.textContent||'').includes(task.prompt_marker));
  if(matches.length>1)throw Error('同一步出现重复用户消息，请人工核对，已停止继续生成');
  if(!matches.length&&task.prompt_excerpt){
   const collapsed=messageTurns(USER_SELECTOR,document,true).filter(el=>(el.textContent||'').includes(task.prompt_excerpt));
   if(collapsed.length===1){const expand=[...collapsed[0].querySelectorAll('button')].find(el=>visible(el)&&/^(显示更多|Show more)$/i.test(label(el)));if(expand){expand.click();return null}}
  }
  return matches[0]||null;
 }
 function workflowMessageId(task,turn){
  return turn?.getAttribute('data-message-id')||turn?.closest('[data-message-id]')?.getAttribute('data-message-id')||task.prompt_marker;
 }
 function retryableWorkflowFailureText(value){
  const text=String(value||'').replace(/\s+/g,' ').trim().slice(0,2000);
  if(/额度|上限|频率|冷却|限制|限流|验证|人机|登录|安全|政策|违规|侵权|版权|不允许|无法协助|不能协助|无法帮助|不能帮助|稍后再试|稍后重试|quota|limit|policy|safety|copyright|prohibited|violation|captcha|verification|sign.?in|log.?in|not allowed|cannot help|can\W?t help|try again in\s*\d/i.test(text))return '';
  const failed=/(?:图片|图像).{0,25}(?:未能|未|没能|没有|无法).{0,12}(?:成功)?生成|(?:图片|图像).{0,15}(?:生成|创建).{0,10}(?:失败|未成功)|(?:image|picture).{0,30}(?:generation|creation).{0,12}(?:failed|unsuccessful)|(?:image|picture).{0,30}(?:failed|could not|couldn\W?t|not successfully).{0,20}(?:generat|creat)|(?:failed|unable).{0,15}(?:generat|creat).{0,20}(?:image|picture)/i.test(text);
  const resend=/再发送|重新发送|重新上传|重发|(?:send|submit|upload).{0,45}(?:again|once more)|resubmit|re-upload/i.test(text);
  return failed&&resend?text:'';
 }
 function workflowRetryFailure(task){
  const user=workflowUserTurn(task);if(!user)return null;
  const following=el=>Boolean(user.compareDocumentPosition(el)&4);
  if(messageTurns(USER_SELECTOR,document,true).some(el=>el!==user&&following(el)))throw Error('本步骤之后已有另一条用户消息，禁止自动重发');
  // Plain-text failure replies in newer ChatGPT builds need not expose an
  // assistant role. Only consider paragraphs after the exact marked user
  // turn, excluding uploads, the composer, dialogs and unrelated user turns.
  const scope=attachmentScope();
  const generated=[...document.querySelectorAll('img')].some(img=>following(img)&&!user.contains?.(img)&&generatedCandidate(img));
  if(generated)return null;
  const turn=workflowAssistantTurn(task),candidates=[...(turn?[turn]:[]),...document.querySelectorAll('main p,[role="main"] p,article p')];
  for(const candidate of candidates){
   if(!following(candidate)||user.contains?.(candidate)||candidate.contains?.(user)||scope?.contains(candidate)||candidate.closest?.(USER_SELECTOR+',aside,nav,[role="dialog"]'))continue;
   const text=retryableWorkflowFailureText(candidate.innerText||candidate.textContent||'');
   if(text)return {text};
  }
  return null;
 }
 function imageQuotaText(value){
  const text=String(value||'').replace(/\s+/g,' ').trim().slice(0,2000);
  return /(?:已达到|已达|达到|用完|耗尽).{0,65}(?:图像|图片|生图).{0,30}(?:上限|限额|额度)|(?:图像|图片|生图).{0,35}(?:额度|限额|次数).{0,15}(?:已用完|已耗尽|不足|用尽)|(?:reached|hit|exceeded).{0,65}(?:image|picture).{0,35}(?:limit|cap|quota)|(?:image|picture).{0,35}(?:limit|quota).{0,25}(?:reached|exceeded|exhausted)|(?:out of|used up).{0,25}(?:image generations|image credits)/i.test(text)?text:'';
 }
 function workflowQuotaFailure(task){
  if(!task?.prompt_marker)return null;
  const user=workflowUserTurn(task);if(!user)return null;
  const following=el=>Boolean(user.compareDocumentPosition(el)&4);
  if(messageTurns(USER_SELECTOR,document,true).some(el=>el!==user&&following(el)))throw Error('本步骤之后已有另一条用户消息，停止额度自动转接');
  const scope=attachmentScope();
  if([...document.querySelectorAll('img')].some(img=>following(img)&&!user.contains?.(img)&&generatedCandidate(img)))return null;
  const turn=workflowAssistantTurn(task),candidates=[...(turn?[turn]:[]),...document.querySelectorAll('main p,[role="main"] p,article p')];
  for(const candidate of candidates){
   if(!following(candidate)||user.contains?.(candidate)||candidate.contains?.(user)||scope?.contains(candidate)||candidate.closest?.(USER_SELECTOR+',aside,nav,[role="dialog"]'))continue;
   const text=imageQuotaText(candidate.innerText||candidate.textContent||'');if(text)return {text};
  }
  return null;
 }
 async function releaseIsolatedWorkflow(task){
  // Clear only a provably extension-owned unsent draft. Other drafts stay in
  // their original tab, which is excluded from future claims by the worker.
  const text=composerText().trim(),state=attachmentState(task);
  const owned=task.step_phase==='ready'&&((text&&text.replace(/\s+/g,'')===task.prompt.replace(/\s+/g,'')&&text.includes(task.prompt_marker))||(!text&&state.namedImages===2));
  if((text||attachmentPresence())&&owned){
   const box=composer();if(text&&box)clearComposerText(box);
   for(let count=0;count<8&&attachmentPresence();count++){
    const remove=[...attachmentScope().querySelectorAll('button,[role="button"]')].find(el=>visible(el)&&!el.closest(ATTACHMENT_EVIDENCE_EXCLUDED)&&/^(?:移除|删除|remove|delete)/i.test([label(el),el.getAttribute('title'),el.getAttribute('data-testid')].filter(Boolean).join(' ')));
    if(!remove)break;remove.click();await sleep(300);
   }
  }
  if(!composerText().trim()&&!attachmentPresence()){location.href='https://chatgpt.com/';return}
  isolatedRunner=true;
  await extensionApi.runtime.sendMessage({type:'isolate-runner',job_id:task.job_id}).catch(()=>{});
 }
 function workflowAssistantTurn(task){
  const user=workflowUserTurn(task);if(!user)return null;
  const following=element=>Boolean(user.compareDocumentPosition(element)&4);
  if(messageTurns(USER_SELECTOR,document,true).some(el=>el!==user&&following(el)))throw Error('本步骤之后出现另一条用户消息，已停止，避免收错图');
  // Generated cards may remain unpainted in a background tab. They still
  // belong to this exact, already-submitted turn; do not lose that binding.
  const turns=messageTurns(ASSISTANT_SELECTOR,document,true).filter(following);
  return [...turns].reverse().find(turn=>[...turn.querySelectorAll('img')].some(generatedCandidate))||turns.at(-1)||null;
 }
 function wakeWorkflowImages(task,awakened){
  const turn=workflowAssistantTurn(task);if(!turn)return 0;
  const images=[...turn.querySelectorAll('img')].filter(img=>generatedCandidate(img)&&!awakened.has(img));
  let changed=0;
  for(const image of images){
   const rect=image.getBoundingClientRect();
   if(image.loading==='lazy'||!image.complete||!image.naturalWidth||rect.width<38||rect.height<38){
    // Only the current assistant's generated card: never activate a browser
    // window, touch the composer, or reload/upload either input attachment.
    image.loading='eager';image.scrollIntoView?.({block:'center',behavior:'instant'});changed++;
   }
   awakened.add(image);
  }
  return changed;
 }
 async function workflowPost(task,event,details={}){
  return post('/update',{job_id:task.job_id,step:task.step_number,step_token:task.step_token,event,...details});
 }
 async function confirmWorkflowSend(task,turn){
  await waitFor(()=>stableChatUrl(location.href),90000,'本步骤已发送，尚未取得稳定聊天地址，请保留页面，不要重发');
  if(task.chat_url&&!inTaskChat(location.href,task.chat_url))throw Error('本套聊天地址已改变，停止执行');
  await workflowPost(task,'workflow_sent',{chat_url:location.href,user_message_id:workflowMessageId(task,turn)});
  task.chat_url=location.href;task.step_phase='sent';
  task.response_last_progress_at=new Date().toISOString();
 }
 async function waitWorkflowImage(task){
  // This is a new observation of an already-submitted turn, not a new send.
  // An hours-old persisted progress timestamp must not expire a chat before
  // its messages have even hydrated after navigation/recovery.
  const observedAt=Date.now(),maximumWait=20*60*1000;
  let stableAt=0,lastImage='',progressAt=observedAt,lastDiagnostic=0,wokeTab=false;
  const awakened=new WeakSet();
  while(true){
   if(!inTaskChat(location.href,task.chat_url))throw Error('页面已离开本套原聊天，停止收图');
   if(accessDenied()||loginPromptVisible())throw Error('GPT 账号或登录状态需要人工处理');
   wakeWorkflowImages(task,awakened);
   const set=generatedSet();
   const stopping=generationActive();
   const images=set.images.filter(img=>img.complete!==false&&img.naturalWidth>=256&&img.naturalHeight>=256);
   const imageProgress=images.map(imageKey).join('|');
   if(stopping||imageProgress!==lastImage){progressAt=Date.now();lastImage=imageProgress}
   if(images.length&&!stopping){
    if(!stableAt)stableAt=Date.now();
    if(images.some(img=>img.naturalWidth>=800&&img.naturalHeight>=800)||Date.now()-stableAt>=1500){const image=images[0];return image.closest('button,[role="button"]')||image}
   }else stableAt=0;
   const quota=!stopping?workflowQuotaFailure(task):null;
   if(quota){
    await workflowPost(task,'workflow_quota',{quota_text:quota.text,failed_prompt_marker:task.prompt_marker,generated_images:0,generating:false});
    isolatedRunner=true;
    await post('/heartbeat',{version:VERSION,page:location.href,status:'额度停发',message:'本账号图片额度耗尽；尚未生成的步骤已转入健康账号接力队列'}).catch(()=>{});
    return null;
   }
   const retryFailure=!stopping?workflowRetryFailure(task):null;
   if(retryFailure){
    if(task.collect_only)throw Error('已确认生成失败；仅续收模式不执行重发');
    if(Number(task.generation_retry_count||0)>=1)throw workflowFailure('本步骤明确生成失败，唯一一次重发也已失败，保留原聊天等待核对','generation_failed');
    if(composerText().trim()||attachmentPresence())throw Error('明确失败但发送框已有草稿或附件，停止自动重发');
    const prepared=await workflowPost(task,'workflow_retry_once',{chat_url:location.href,failed_prompt_marker:task.prompt_marker,failure_text:retryFailure.text,generated_images:0,generating:false});
    if(!prepared?.task)throw Error('未确认唯一一次重发记录，停止发送');
    return {workflowRetryTask:prepared.task};
   }
   const diagnostic=responseDiagnostic(),failure=!stopping?explicitGenerationFailure(diagnostic):'';
   if(failure)throw Error('GPT 本步骤明确失败：'+failure);
   if(!stopping&&missingAttachmentReply())throw Error('GPT 反馈本步骤缺少附件，已保留原聊天等待核对，不自动补传或重发');
   const elapsed=Date.now()-progressAt,user=workflowUserTurn(task);
   if(!user&&Date.now()-observedAt>90000)throw workflowFailure('原聊天加载后仍未找到本步骤消息，已停止续收，禁止重发','workflow_page_not_ready');
   if(user&&!stopping&&!images.length&&!wokeTab&&document.visibilityState==='hidden'&&Date.now()-observedAt>15000){
    wokeTab=true;await extensionApi.runtime.sendMessage({type:'protect-runner',activate:true}).catch(()=>{});
   }
   if(elapsed>180000&&!stopping&&!task.reconnect_count&&user&&!composerText().trim()&&!attachmentPresence()){
    await workflowPost(task,'workflow_reconnect',{chat_url:location.href});task.reconnect_count=1;location.reload();return null;
   }
   if(elapsed>600000||Date.now()-observedAt>maximumWait)throw workflowFailure('本步骤长时间未确认可保存的新图片，已保留原聊天等待核对，不自动重发','workflow_response_timeout');
   if(Date.now()-lastDiagnostic>=15000){lastDiagnostic=Date.now();await workflowPost(task,'response_diagnostic',{diagnostic:workflowSnapshot(task,set,stopping)})}
   await workflowPost(task,'waiting',{chat_url:location.href});
   await sleep(2000);
  }
 }
 function workflowFailure(message,code){const error=Error(message);error.code=code;return error}
 function generationActive(){
  const exact=button(['停止生成','停止流式传输','停止','Stop generating','Stop streaming','Stop']);
  if(exact)return exact;
  return [...document.querySelectorAll('[data-testid="stop-button"],[data-testid="stop-streaming-button"],button[aria-label*="Stop streaming"],button[aria-label*="停止"]')].find(el=>visible(el)&&!el.disabled)||null;
 }
 function workflowSnapshot(task,set=generatedSet(),stopping=generationActive()){
  const turn=workflowAssistantTurn(task),rawImages=turn?[...turn.querySelectorAll('img')]:[];
  return {step:task.step_number,user_found:Boolean(workflowUserTurn(task)),assistant_found:Boolean(turn),generating:Boolean(stopping),visibility:document.visibilityState||'unknown',draft_length:composerText().length,send_available:Boolean(sendButton()),images:set.images.map(img=>({complete:img.complete,natural_width:img.naturalWidth,natural_height:img.naturalHeight})).slice(0,4),raw_images:rawImages.slice(0,4).map(img=>({complete:img.complete,natural_width:img.naturalWidth,natural_height:img.naturalHeight,loading:img.loading,generated:generatedCandidate(img),rendered:visible(img),display_width:img.getBoundingClientRect().width,display_height:img.getBoundingClientRect().height}))};
 }
 async function ensureWorkflowChatMode(){
  const chat=button(['聊天','Chat']),work=button(['工作','Work']);
  if(!chat||!work)return; // Older ChatGPT builds only expose ordinary chat.
  const selected=el=>el.getAttribute('aria-pressed')==='true'||el.getAttribute('aria-selected')==='true'||(String(el.className).includes('text-mode-toggle-primary')&&!String(el.className).includes('text-mode-toggle-inactive'));
  if(selected(chat))return;
  if(!selected(work))throw Error('不能确认当前为聊天模式，已停止发送，请选择 Chat 聊天');
  chat.click();
  await waitFor(()=>selected(button(['聊天','Chat'])||chat)&&composer(),20000,'未能切换到 Chat 聊天，停止发送');
 }
 async function executeWorkflow(initial,attempt){
  await extensionApi.runtime.sendMessage({type:'protect-runner',activate:true}).catch(()=>{});
  let task=initial;
  while(task&&workflowTask(task)){
   activeWorkflowTask=task;
   if(task.chat_url&&!inTaskChat(location.href,task.chat_url)){location.href=task.chat_url;return}
   if(!task.chat_url&&location.pathname!=='/'){location.href='https://chatgpt.com/';return}
   if(task.wait_seconds){
    const retrying=Number(task.generation_retry_count||0)>0&&task.step_phase==='ready';
    await post('/heartbeat',{version:VERSION,session:activeSession,page:location.href,status:'执行中',message:retrying?'本步骤明确失败，原聊天等待 '+task.wait_seconds+' 秒后进行唯一一次重发':'本张已保存，原聊天等待 '+task.wait_seconds+' 秒后生成下一张'});
    await sleep(Math.min(task.wait_seconds,10)*1000);
   }else{
    const sent=workflowUserTurn(task);
    if(task.step_phase==='ready'){
     if(sent)throw Error('待发送步骤已有同标记消息，已停止以免重复生图');
     await ensureWorkflowChatMode();
     const hasDraft=Boolean(composerText().trim()||attachmentPresence());
     const ownedDraft=hasDraft&&composerText().replace(/\s+/g,'')===task.prompt.replace(/\s+/g,'')&&composerText().includes(task.prompt_marker)&&attachmentState(task).namedImages===attachmentItems(task).length&&attachmentState(task).ready;
     if(hasDraft&&!ownedDraft)throw Error('当前聊天发送框有不匹配的草稿或附件，已保留，需人工核对后续接本步骤');
     await waitFor(()=>composer()&&!button(['停止生成','停止流式传输','Stop generating','Stop streaming']),60000,'当前聊天仍在生成，停止追加新步骤');
     if(!ownedDraft){await attach(task);await enterPrompt(task.prompt)}else await workflowPost(task,'progress',{message:'已确认本步骤原有未发送草稿及'+attachmentItems(task).length+'张附件，直接续接，不重复上传'});
     attempt.promptEntered=true;
     await waitAttachments(task,150000);
     if(composerText().replace(/\s+/g,'')!==task.prompt.replace(/\s+/g,''))throw Error('本步骤发送前提示词校验失败');
     const send=await waitFor(sendButton,60000,'本步骤发送按钮未就绪');
     await workflowPost(task,'workflow_sending',{chat_url:location.href});
     task.step_phase='sending';attempt.crossedSendBoundary=true;
     send.click();
     const turn=await waitFor(()=>workflowUserTurn(task),60000,'本步骤点击发送后未确认用户消息，已停止，禁止重发');
     await confirmWorkflowSend(task,turn);
    }else if(task.step_phase==='sending'){
     await workflowPost(task,'progress',{message:'正在核对原聊天中的本步骤消息，不会重复发送'});
     const turn=sent||await waitFor(()=>workflowUserTurn(task),60000,'正在恢复的步骤发送结果不明，需核对原聊天，禁止自动重发');
     await confirmWorkflowSend(task,turn);
    }else if(task.step_phase!=='sent')throw Error('本步骤状态不支持自动执行');
    const opener=await waitWorkflowImage(task);
    if(!opener)return;
    if(opener.workflowRetryTask){task=opener.workflowRetryTask;activeWorkflowTask=task;continue}
    await downloadImages(task,opener);
    if(task.collect_only)return;
    if(task.step_number>=task.total_steps){activeWorkflowTask=null;location.href='https://chatgpt.com/';return}
   }
   const claimed=await post('/claim',{version:VERSION,session:activeSession});
   if(claimed.task&&claimed.task.job_id!==initial.job_id)throw Error('当前套图尚未结束却返回其他任务，已停止');
   task=claimed.task;
  }
 }
 async function execute(task,attempt){
  if(workflowTask(task))return executeWorkflow(task,attempt);
  if(task.resume){
    const adopted=await adoptStableChat(task);
    if(task.awaiting_chat_confirmation&&!task.chat_url&&!adopted){await sleep(3000);return}
   if(task.chat_url&&!inTaskChat(location.href,task.chat_url)){location.href=task.chat_url;return}
   if(!task.chat_url){
    if(!/^\/c\/[a-zA-Z0-9-]+/.test(location.pathname))throw Error('发送后没有找到新对话，请核对 GPT 页面');
    await post('/update',{job_id:task.job_id,event:'sent',chat_url:location.href});
   }
   const opener=await waitImages(task);if(opener)await downloadImages(task,opener);return;
  }
  if(location.pathname!=='/'){location.href='https://chatgpt.com/';return}
  await waitFor(composer,20000,'等待新对话输入框');
  if(document.querySelector('[data-message-author-role]')||composerText().trim()||attachmentPresence())throw Error('新对话不是空白，请保留当前草稿或附件并打开一个空白 GPT 对话后继续');
  await post('/update',{job_id:task.job_id,event:'progress',message:'已确认独立空白对话，本套单独发送'});
  await attach(task);attempt.promptEntered=true;await enterPrompt(task.prompt);await post('/update',{job_id:task.job_id,event:'progress',message:'提示词已填写，正在二次核对 '+attachmentItems(task).length+' 个附件'});
  await waitAttachments(task,150000);
  if(!draftMatches(task.prompt))throw Error('发送前提示词已变化，已停止发送');
  await waitFor(sendButton,120000,'发送按钮准备超时');
  await post('/update',{job_id:task.job_id,event:'progress',message:'发送按钮已就绪，最终复核 '+attachmentItems(task).length+' 个附件'});
  await waitAttachments(task,150000);
  if(!draftMatches(task.prompt))throw Error('发送按钮就绪时提示词已变化，已停止发送');
  const send=sendButton();if(!send)throw Error('最终检查后发送按钮状态已变化，已停止发送');
  await post('/update',{job_id:task.job_id,event:'sending'});attempt.crossedSendBoundary=true;sessionStorage.setItem('workbenchSentJob',task.job_id);send.click();
  await waitFor(()=>/^\/c\/[a-zA-Z0-9:%._-]+/.test(decodeURIComponent(location.pathname))||promptVisibleInChat(task),60000,'发送动作未生效：页面仍在 GPT 首页');
  await post('/update',{job_id:task.job_id,event:'sent',chat_url:location.href});
  if(!stableChatUrl(location.href)){
   await waitFor(()=>stableChatUrl(location.href),90000,'GPT 尚未生成稳定对话地址；已停止自动重发');
   await post('/update',{job_id:task.job_id,event:'waiting',chat_url:location.href});task.chat_url=location.href;
  }
  sessionStorage.removeItem('workbenchSentJob');
  task.response_last_progress_at=new Date().toISOString();task.response_refresh_count=0;
  const opener=await waitImages(task);if(opener)await downloadImages(task,opener);
 }
 async function run(){
   if(busy||isolatedRunner)return;busy=true;let task=null;const attempt={crossedSendBoundary:false,promptEntered:false};
  try{
   const runnerContext=await extensionApi.runtime.sendMessage({type:'runner-context'}).catch(()=>null);
   if(runnerContext?.isolated){isolatedRunner=true;return}
   activeSession=await session();
   if(accessDenied()){
    await post('/heartbeat',{version:VERSION,page:location.href,status:'账号不匹配',message:BUILD+' 当前账号无权访问此 GPT 对话，已停止领取任务'}).catch(()=>{});
    return;
   }
   if(location.pathname.startsWith('/codex/open-app')){
    await post('/heartbeat',{version:VERSION,page:location.href,status:'页面切换',message:BUILD+' 检测到登录跳转页，正在回到 GPT 首页'}).catch(()=>{});
    location.href='https://chatgpt.com/';return;
   }
   if(passivePage(location.pathname)){
    await post('/heartbeat',{version:VERSION,page:location.href,status:'浏览资料库',message:BUILD+' 资料库页面保持原位；有任务时由后台另开执行页'}).catch(()=>{});
    return;
   }
   // Guests can have the same composer as signed-in users. A visible login
   // control must stop before claiming, drafting or uploading any task.
   if(loginPromptVisible()){
    await post('/heartbeat',{version:VERSION,page:location.href,status:'等待登录',message:BUILD+' 当前 GPT 页面显示登录入口，请先登录'});
    return;
   }
   const box=composer(),hasDraft=Boolean(composerText(box).trim()||attachmentPresence());await post('/heartbeat',{version:VERSION,page:location.href,status:box?'已连接':'页面未识别',message:box?BUILD+' GPT 输入页面已就绪':'当前 GPT 页面已打开，但未识别输入框；请刷新 GPT 页面'});
   if(!box)return;
    const draftMarker=composerText(box).match(/WBSTEP-[a-f0-9]{12}-[a-zA-Z0-9-]+/)?.[0]||'';
    const claimed=await post('/claim',{version:VERSION,session:activeSession,draft_present:location.pathname==='/'&&hasDraft,draft_workflow_marker:draftMarker,draft_signature:draftMarker?await draftSignature(composerText(box)):''});task=claimed.task;
   if(workflowTask(task)){await executeWorkflow(task,attempt);return}
   if(location.pathname==='/'&&hasDraft){
    if(task&&!task.resume&&ownedComposer(task)){
     if(draftMatches(task.prompt)){
      await post('/update',{job_id:task.job_id,event:'error',message:'刷新后发现未发送提示词；附件状态不确定，已停止自动重试，请人工核对'});
      await post('/heartbeat',{version:VERSION,page:location.href,status:'需要处理',message:'旧任务提示词仍在输入框，已停止自动重试；请先核对并清空发送框'});return;
     }
     await post('/heartbeat',{version:VERSION,page:location.href,status:'自动修复',message:'检测到扩展遗留附件，正在安全清理并重新排队'});
     await post('/update',{job_id:task.job_id,event:'presend_retry'});location.reload();return;
    }
    const another=claimed.message?.includes('已有任务执行中');
    if(claimed.draft_blocked&&!another){
     const signature=await draftSignature(composerText(box));
     const recovery=await extensionApi.runtime.sendMessage({type:'recovery-context'}).catch(()=>null);
     if(recovery?.ok&&recovery.is_recovery&&recovery.signature===signature&&!attachmentPresence()&&clearComposerText(box)){
      await post('/heartbeat',{version:VERSION,page:location.href,status:'自动修复',message:'新标签继承了旧草稿；已核对指纹并清空副本，原标签保留'});
      await sleep(3500);
      if(!composerText(box).trim()&&!attachmentPresence())location.reload();
      return;
     }
     if(!recovery?.is_recovery)await extensionApi.runtime.sendMessage({type:'open-clean-tab',signature}).catch(()=>{});
    }
    await post('/heartbeat',{version:VERSION,page:location.href,status:another?'执行中':'需要清理草稿或附件',message:another?'另一个 GPT 页面正在执行；本页旧内容已隔离，不会领取任务':'0.3.18：旧草稿已隔离，正在核对恢复标签并继续队列。'});return;
   }
   if(task)await execute(task,attempt);else if(claimed.message)await post('/heartbeat',{version:VERSION,page:location.href,status:'队列等待',message:claimed.message+(claimed.wait_seconds?'，剩余 '+claimed.wait_seconds+' 秒':'')});
  }catch(error){
   if(workflowTask(task)){
    const message=String(error?.message||error);
    const current=activeWorkflowTask?.job_id===task.job_id?activeWorkflowTask:task;
    const parked=await workflowPost(current,'workflow_needs_review',{message,code:error?.code||'',...(error?.attachmentDiagnostic?{attachment_diagnostic:error.attachmentDiagnostic}:{})}).catch(()=>null);
    await post('/heartbeat',{version:VERSION,page:location.href,status:'任务已跳过',message}).catch(()=>{});
    if(parked?.task_isolated)await releaseIsolatedWorkflow(current);
    else if(/已暂停|失去.*权限|属于另一浏览器|所有权|已失败/.test(message))await releaseIsolatedWorkflow(current);
    return;
   }
   const message=String(error?.message||error);if(task){
    const safe=canRetryPresend(task,attempt,location.pathname,ownedComposer(task));
    if(safe){
     const cleared=await clearOwnedPresendComposer(task).catch(()=>false);
     if(cleared){await post('/update',{job_id:task.job_id,event:'progress',message:'发送前检查未通过，已清空本任务草稿与附件：'+message}).catch(()=>{});const retried=await post('/update',{job_id:task.job_id,event:'presend_retry',message}).then(()=>true,()=>false);if(retried)location.reload()}
     else {await post('/update',{job_id:task.job_id,event:'error',message:'发送前检查未通过，且无法确认本任务草稿与附件已清空：'+message}).catch(()=>{});await post('/heartbeat',{version:VERSION,page:location.href,status:'需要处理',message:'未发送任务的草稿或附件未能安全清空，已停止自动重试'}).catch(()=>{})}
    }
    else await post('/update',{job_id:task.job_id,event:'error',message}).catch(()=>{});
    if(!task.awaiting_chat_confirmation&&(task.resume||attempt.crossedSendBoundary||location.pathname.startsWith('/c/'))){setTimeout(()=>location.reload(),35000)}
   }else await post('/heartbeat',{version:VERSION,page:location.href,status:'需要处理',message}).catch(()=>{});
   }finally{activeSession='';busy=false;activeWorkflowTask=null}
 }
  if(typeof module!=='undefined'&&module.exports){module.exports={imageQuotaText,workflowQuotaFailure,retryableWorkflowFailureText,workflowRetryFailure,uploadControl,selectFiles,responseWaitDecision,uploadName,referenceItems,attachmentItems,nameVisible,attachmentEvidence,attachmentState,attachmentStability,attachmentDiagnostic,attachmentFailure,composerAttachmentSnapshot,waitAttachments,attach,canRetryPresend,inTaskChat,stableChatUrl,downloadableImageUrl,bestImageUrl,bestImageSource,isGeneratedImage,generatedCandidate,passivePage,responseDiagnostic,explicitGenerationFailure,workflowTask,workflowUserTurn,workflowAssistantTurn,downloadTask,executeWorkflow,generatedSet,composer,composerText,loginPromptVisible,run,setWorkflowContext:task=>{activeWorkflowTask=task}};return}
  setInterval(()=>{if(busy)post('/heartbeat',{version:VERSION,session:activeSession,page:location.href,status:'执行中',message:'正在处理当前套图，其他任务排队'}).catch(()=>{})},5000);
 setInterval(run,3000);run();
})();








