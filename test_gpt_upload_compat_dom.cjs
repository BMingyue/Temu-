const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const {chromium}=require('./local_tools/dxm-uploader/_internal/playwright/driver/package');
const source=fs.readFileSync(path.join(__dirname,'gpt_chrome_extension/content.js'),'utf8');
const baselineRevision='9e0cda35fe3fe8b7c8a4036908d47ad86aeb7424';
let baseline=null;
try{baseline=cp.execFileSync('git',['show',baselineRevision+':gpt_chrome_extension/content.js'],{cwd:__dirname,encoding:'utf8',stdio:['ignore','pipe','pipe']})}catch{}
const evidence=path.resolve(process.env.WORKBENCH_TEST_EVIDENCE_DIR||path.join(__dirname,'data/verification/20261103-gpt-upload-compat'));
fs.mkdirSync(evidence,{recursive:true});
const task={job_id:'abcdef1234567890abcdef1234567890',workflow_mode:'single_image_chat_v1',step_number:1,step_token:'step-one',attachments:[{name:'01-template.png',type:'image/png',base64:'AA=='},{name:'print.png',type:'image/png',base64:'AQ=='}]};
const names=task.attachments.map((item,index)=>task.job_id.slice(0,12)+'-s1-a'+(index+1)+'-'+item.name);
const picture=color=>'data:image/svg+xml;base64,'+Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="${color}"/></svg>`).toString('base64');
const img=(color,alt='')=>`<img width="64" height="64" src="${picture(color)}" alt="${alt}">`;
const card=(name,color='red')=>`<div data-testid="composer-attachment" title="${name}">${img(color,name)}</div>`;
const form=(extra='')=>`<form id="composer-form">${extra}<textarea id="prompt-textarea"></textarea><button data-testid="send-button" onclick="window.__sends++">Send</button></form>`;
const result={mode:'isolated headless DOM fixtures; no live GPT or backend; fixed 0.4.9 baseline',checks:[],baseline:{revision:baselineRevision,available:Boolean(baseline)},baselineReproductions:[],pageErrors:[],sendClicks:0};
const fourInputs='<input id="single-image" type="file" accept="image/*"><input id="image-video" type="file" multiple accept="image/*,video/*"><input id="multi-image" type="file" multiple accept="image/*"><input id="any-file" type="file" multiple>';

(async()=>{
 const browser=await chromium.launch({executablePath:process.env.WORKBENCH_TEST_CHROME||path.join(__dirname,'runtime/gpt-chrome/chrome-win64/chrome.exe'),headless:true});
 const page=await browser.newPage();page.on('pageerror',error=>result.pageErrors.push(error.message));
 await page.route('https://preview.invalid/**',route=>route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="red"/></svg>'}));
 async function load(html,code=source){
  await page.goto('about:blank');await page.setContent(html);
  await page.evaluate(()=>{window.module={exports:{}};window.__sends=0;window.__posts=[];window.chrome={runtime:{getManifest:()=>({version:'fixture'}),sendMessage:async message=>{window.__posts.push(message);return {ok:true,value:{ok:true}}}}}});
  await page.addScriptTag({content:code.replace('module.exports={','module.exports={uploadInput,attachmentScope,attachmentPresence,'+(code.includes('function attachmentSourceIdentity(')?'attachmentSourceIdentity,':'')+(code.includes('function uploadMenu(')?'uploadMenu,':'')+(code.includes('function captureUploadInput(')?'captureUploadInput,':''))});
  await page.waitForFunction(()=>[...document.images].every(image=>image.complete));
 }
 async function state(current=task){return page.evaluate(value=>module.exports.attachmentState(value),current)}
 async function check(label,operation){await operation();result.checks.push(label)}
 try{
  await check('homepage picker chooses a compatible composer image input instead of a stale first audio or camera input',async()=>{
   const html=form('<input id="stale" type="file" accept="audio/*"><input id="camera" type="file" accept="image/*" capture="environment"><input id="images" type="file" multiple accept="image/*">');
   if(baseline){await load(html,baseline);assert.equal(await page.evaluate(value=>module.exports.uploadInput(true,value)?.id,task),'stale');result.baselineReproductions.push('0.4.9 chooses first incompatible audio input on new-chat composer');}
   await load(html);assert.equal(await page.evaluate(value=>module.exports.uploadInput(true,value)?.id,task),'images');
  });
  await check('ambiguous compatible inputs do not grant ownership to the first file control',async()=>{
   await load(form('<input id="one" type="file" accept="image/*" multiple><input id="two" type="file" accept="image/*" multiple>'));
   assert.equal(await page.evaluate(value=>module.exports.uploadInput(false,value),task),null);
   await load(form('<input id="typed" type="file" accept="image/*" multiple><input id="generic" type="file" multiple>'));
   assert.equal(await page.evaluate(value=>module.exports.uploadInput(false,value),task),null);
  });
  await check('unrelated pre-existing file controls, history inputs and dialogs stay excluded',async()=>{
   await load(form()+'<input id="avatar" type="file" multiple accept="image/*"><div role="dialog"><input id="dialog" type="file" multiple accept="image/*"></div><div data-message-author-role="assistant"><input id="history" type="file" multiple accept="image/*"></div>');
   assert.equal(await page.evaluate(value=>module.exports.uploadInput(false,value),task),null);
   assert.equal(await page.evaluate(value=>module.exports.uploadInput(false,value,new Set([document.querySelector('#avatar')]))?.id,task),undefined);
   assert.equal(await page.evaluate(value=>module.exports.uploadInput(false,value,new Set([document.querySelector('#dialog'),document.querySelector('#history')])),task),null);
  });
  await check('a file input with an explicit form owner is associated even when physically outside the form',async()=>{
   await load(form()+'<input id="owned" form="composer-form" type="file" multiple accept="image/png">');
   assert.equal(await page.evaluate(value=>module.exports.uploadInput(true,value)?.id,task),'owned');
  });
  await check('homepage sibling attachment tray is read inside a bounded composer wrapper',async()=>{
   const html='<div id="composer-wrapper">'+form()+'<div id="tray">'+card(names[0])+card(names[1],'blue')+'</div></div>';
   if(baseline){await load(html,baseline);assert.equal((await state()).references,0);result.baselineReproductions.push('0.4.9 sees zero files when new-chat tray is a sibling of the form');}
   await load(html);const value=await state();assert(value.ready);assert.equal(value.uniqueAttachments,2);
  });
  await check('bounded scope does not expand into a chat turn or another visible composer',async()=>{
   for(const blocker of ['<div data-message-author-role="assistant">old reply</div>','<textarea aria-label="Another message"></textarea>']){
    await load('<div>'+form()+'<div>'+card(names[0])+card(names[1],'blue')+'</div>'+blocker+'</div>');assert.equal((await state()).ready,false);
   }
   await load('<div>'+form(card(names[0])+card(names[1],'blue'))+'<div data-message-author-role="assistant">'+img('green','old image')+'</div></div>');assert.equal((await state()).ready,true);
  });
  await check('native dialog, dialog role and alertdialog cards cannot supply composer attachment evidence or ZIP text',async()=>{
   for(const [start,end] of [['<dialog open>','</dialog>'],['<div role="dialog">','</div>'],['<div role="alertdialog">','</div>']]){
    await load('<div>'+form()+'<button aria-label="Add files">+</button>'+start+card(names[0])+card(names[1],'blue')+'<div title="bundle.zip">bundle.zip</div>'+end+'</div>');
    const current=await state();assert.equal(current.ready,false);assert.equal(current.uniqueAttachments,0);assert.equal(await page.evaluate(()=>module.exports.attachmentPresence()),false);
    const legacy={job_id:task.job_id,reference:{name:'reference.png'},template_archive:{name:'bundle.zip'}};
    await load('<div>'+form(card('reference.png'))+'<button aria-label="Add files">+</button>'+start+'<div title="bundle.zip">bundle.zip</div>'+end+'</div>');
    assert.equal((await state(legacy)).ready,false);
   }
  });
  await check('two real composer files remain valid with unrelated dialog previews and upload progress beside them',async()=>{
   for(const [start,end] of [['<dialog open>','</dialog>'],['<div role="dialog">','</div>'],['<div role="alertdialog">','</div>']]){
    await load('<div>'+form(card(names[0])+card(names[1],'blue'))+'<button aria-label="Add files">+</button>'+start+card('unrelated.png','green')+'<span role="progressbar" style="display:block;width:40px;height:20px"></span>'+end+'</div>');
    const current=await state();assert.equal(current.ready,true);assert.equal(current.uniqueAttachments,2);assert.equal(current.uploading,false);
   }
  });
  await check('unnamed tray inserted after first upload keeps only the same form task receipt',async()=>{
   await load('<div id="composer-wrapper">'+form('<input type="file" multiple accept="image/*">')+'<div id="tray"></div></div>');
   await page.evaluate(pictures=>document.querySelector('input[type=file]').addEventListener('change',()=>{document.querySelector('#tray').innerHTML=pictures.map(src=>`<div data-testid="composer-attachment"><img width="64" height="64" src="${src}" alt="Image"></div>`).join('')}),[picture('red'),picture('blue')]);
   await page.evaluate(value=>module.exports.attach(value),task);assert.equal((await state()).ready,true);
   assert.equal((await state({...task,step_token:'foreign-step'})).ready,false);
   await page.evaluate(()=>{const old=document.querySelector('form');old.replaceWith(old.cloneNode(true));});assert.equal((await state()).ready,false);
  });
  await check('upload button outside a form is linked only by the bounded unique composer wrapper',async()=>{
   await load('<div id="composer-wrapper">'+form()+'<button id="add" aria-label="Add files">+</button></div><button id="foreign" aria-label="Add files">elsewhere</button>');
   assert.equal(await page.evaluate(()=>module.exports.uploadControl()?.id),'add');
  });
  await check('a real DOM with no active composer never falls back to a project or sidebar Add files button',async()=>{
   await load('<button id="foreign" aria-label="Add files">project upload</button><input type="file" multiple accept="image/*">');
   assert.equal(await page.evaluate(()=>module.exports.uploadControl()),null);
  });
  await check('owned upload-menu creation can select a newly mounted portal input without using unrelated existing ones',async()=>{
   await load('<div>'+form()+'<button id="add" aria-label="Add files">+</button></div><input id="unrelated" type="file" multiple accept="image/*">');
   await page.evaluate(pictures=>document.querySelector('#add').addEventListener('click',()=>{const input=document.createElement('input');input.id='new-upload';input.type='file';input.multiple=true;input.accept='image/*';input.addEventListener('change',()=>{const tray=document.createElement('div');tray.innerHTML=pictures.map(src=>`<div data-testid="composer-attachment"><img width="64" height="64" src="${src}" alt="Image"></div>`).join('');document.querySelector('form').append(tray)});document.body.append(input);input.click()}),[picture('red'),picture('blue')]);
   await page.evaluate(value=>module.exports.attach(value),task);assert.equal((await state()).ready,true);assert.equal(await page.locator('#unrelated').evaluate(element=>element.files.length),0);assert.equal(await page.locator('#new-upload').evaluate(element=>element.files.length),2);
  });
  await check('an unrelated already visible Upload files menu cannot be clicked or used for the composer',async()=>{
   await load('<div>'+form()+'<button id="add" aria-label="Add files">+</button></div><button id="foreign">Upload files</button>');
   await page.evaluate(()=>{window.__foreignClicks=0;document.querySelector('#foreign').addEventListener('click',()=>{window.__foreignClicks++;const input=document.createElement('input');input.type='file';input.multiple=true;input.accept='image/*';document.body.append(input)})});
   const failure=await page.evaluate(async value=>{try{await module.exports.attach(value);return {}}catch(error){return {message:error.message,code:error.code}}},{...task,step_phase:'ready'});
   assert.match(failure.message,/找不到当前上传控件的唯一/);assert.equal(failure.code,'workflow_attachment_not_ready');assert.equal(await page.evaluate(()=>window.__foreignClicks),0);assert.equal(await page.locator('input[type=file]').count(),0);
  });
  await check('only one newly visible owned portal upload menu may create the new file input',async()=>{
   await load('<div>'+form()+'<button id="add" aria-label="Add files">+</button></div>');
   await page.evaluate(pictures=>document.querySelector('#add').addEventListener('click',()=>{const menu=document.createElement('button');menu.setAttribute('role','menuitem');menu.textContent='Upload files';menu.addEventListener('click',()=>{const input=document.createElement('input');input.type='file';input.multiple=true;input.accept='image/*';input.addEventListener('change',()=>{const tray=document.createElement('div');tray.innerHTML=pictures.map(src=>`<div data-testid="composer-attachment"><img width="64" height="64" src="${src}" alt="Image"></div>`).join('');document.querySelector('form').append(tray)});document.body.append(input);input.click()});document.body.append(menu)}),[picture('red'),picture('blue')]);
   await page.evaluate(value=>module.exports.attach(value),task);assert.equal((await state()).ready,true);
   await load('<div>'+form()+'<button id="add" aria-label="Add files">+</button></div><button role="menuitem">Upload files</button><button role="menuitem">Upload files</button>');
   assert.equal(await page.evaluate(()=>module.exports.uploadMenu(document.querySelector('#add'),new Set())),null);
  });
  await check('four real-diagnostic input variants are resolved by the exact synchronously triggered composer input, not ranking',async()=>{
   for(const target of ['image-video','multi-image']){
    await load('<div>'+form(fourInputs)+'<button id="add" aria-label="添加文件等内容">+</button></div>');
    assert.equal(await page.evaluate(value=>module.exports.uploadInput(true,value),task),null);
    await page.evaluate(({target,pictures})=>{const input=document.getElementById(target);window.__inputDefaultPrevented=[];input.addEventListener('click',event=>window.__inputDefaultPrevented.push(event.defaultPrevented));input.addEventListener('change',()=>{const tray=document.createElement('div');tray.innerHTML=pictures.map(src=>`<div data-testid="composer-attachment"><img width="64" height="64" src="${src}" alt="Image"></div>`).join('');document.querySelector('form').append(tray)});document.querySelector('#add').addEventListener('click',()=>input.click())},{target,pictures:[picture('red'),picture('blue')]});
    await page.evaluate(value=>module.exports.attach(value),{...task,step_phase:'ready'});assert.equal((await state()).ready,true);
    const files=await page.locator('input[type=file]').evaluateAll(inputs=>inputs.map(input=>({id:input.id,count:input.files.length})));
    assert.equal(files.find(input=>input.id===target).count,2);assert(files.filter(input=>input.id!==target).every(input=>input.count===0));assert.deepEqual(await page.evaluate(()=>window.__inputDefaultPrevented),[true]);
   }
  });
  await check('current Chinese and English photo-and-file menus resolve existing ambiguous inputs through their own synchronous input click',async()=>{
   for(const menuLabel of ['添加照片和文件','Upload photos and files','Add photos and files']){
    await load('<div>'+form(fourInputs)+'<button id="add" aria-label="添加文件等内容">+</button></div>');
    await page.evaluate(({menuLabel,pictures})=>{const input=document.querySelector('#multi-image');input.addEventListener('change',()=>{const tray=document.createElement('div');tray.innerHTML=pictures.map(src=>`<div data-testid="composer-attachment"><img width="64" height="64" src="${src}" alt="Image"></div>`).join('');document.querySelector('form').append(tray)});document.querySelector('#add').addEventListener('click',()=>{const menu=document.createElement('button');menu.setAttribute('role','menuitem');menu.textContent=menuLabel;menu.addEventListener('click',()=>input.click());document.body.append(menu)})},{menuLabel,pictures:[picture('red'),picture('blue')]});
    await page.evaluate(value=>module.exports.attach(value),task);assert.equal((await state()).ready,true);assert.equal(await page.locator('#multi-image').evaluate(input=>input.files.length),2);
   }
  });
  await check('explicit aria menu ownership outranks newly visible foreign menus and never falls back while the declared target is not mounted',async()=>{
   for(const variant of ['controls','labelled','not-mounted']){
    await load('<div>'+form(fourInputs)+'<button id="add" aria-label="Add files" '+(variant==='labelled'?'':'aria-controls="owned-menu"')+'>+</button></div>'+(variant==='not-mounted'?'':'<div id="owned-menu" role="menu" '+(variant==='labelled'?'aria-labelledby="add"':'')+'><button id="owned-option" role="menuitem">Upload files</button></div>')+'<div role="menu"><button id="foreign-option" role="menuitem">Upload files</button></div>');
    const selected=await page.evaluate(()=>module.exports.uploadMenu(document.querySelector('#add'),new Set())?.id||null);assert.equal(selected,variant==='not-mounted'?null:'owned-option');
    if(variant==='not-mounted'){
     await page.evaluate(()=>{const menu=document.createElement('div');menu.id='owned-menu';menu.setAttribute('role','menu');menu.innerHTML='<button id="owned-option" role="menuitem">Upload files</button>';document.body.append(menu)});
     assert.equal(await page.evaluate(()=>module.exports.uploadMenu(document.querySelector('#add'),new Set())?.id),'owned-option');
    }
   }
  });
  await check('later trusted user pointer or keyboard interaction cancels menu authority before a foreign project menu can inherit it',async()=>{
   for(const interaction of ['pointer','keyboard']){
    await load('<div>'+form(fourInputs)+'<button id="add" aria-label="Add files">+</button></div><button id="project">Project attachments</button><input id="foreign-input" type="file" multiple accept="image/*">');
    await page.evaluate(()=>{window.__ownedClicks=0;window.__trusted=[];document.querySelector('#add').addEventListener('click',()=>window.__ownedClicks++);const openForeign=event=>{window.__trusted.push(event.isTrusted);const menu=document.createElement('button');menu.setAttribute('role','menuitem');menu.textContent='Upload files';menu.addEventListener('click',()=>document.querySelector('#foreign-input').click());document.body.append(menu)};document.querySelector('#project').addEventListener('click',openForeign);document.addEventListener('keydown',event=>{if(event.key==='p')openForeign(event)});const originalAdd=document.addEventListener,originalRemove=document.removeEventListener;window.__guardListeners=new Map();document.addEventListener=function(type,listener,options){const types=window.__guardListeners.get(listener)||new Set();types.add(type);window.__guardListeners.set(listener,types);return originalAdd.call(this,type,listener,options)};document.removeEventListener=function(type,listener,options){const types=window.__guardListeners.get(listener);types?.delete(type);if(types&&!types.size)window.__guardListeners.delete(listener);return originalRemove.call(this,type,listener,options)};window.__restoreDocListeners=()=>{document.addEventListener=originalAdd;document.removeEventListener=originalRemove}});
    await page.evaluate(value=>{window.__attachResult=null;module.exports.attach(value).then(()=>window.__attachResult={ok:true}).catch(error=>window.__attachResult={message:error.message,code:error.code})},{...task,step_phase:'ready'});
    await page.waitForFunction(()=>window.__ownedClicks===1);
    if(interaction==='pointer')await page.getByRole('button',{name:'Project attachments',exact:true}).click();else await page.keyboard.press('p');
    await page.waitForFunction(()=>window.__attachResult!==null);
    const proof=await page.evaluate(()=>{const proof={result:window.__attachResult,trusted:window.__trusted,remainingListeners:window.__guardListeners.size};window.__restoreDocListeners();return proof});
    assert.equal(proof.result.code,'workflow_upload_interrupted');assert.match(proof.result.message,/用户正在操作/);assert(proof.trusted.every(Boolean));assert(proof.trusted.length);assert.equal(proof.remainingListeners,0);assert(await page.locator('input[type=file]').evaluateAll(inputs=>inputs.every(input=>input.files.length===0)));
   }
  });
  await check('an unrelated asynchronous global menu cannot gain upload authority even without a trusted user gesture',async()=>{
   await load('<div>'+form(fourInputs)+'<button id="add" aria-label="Add files">+</button></div><input id="foreign-input" type="file" multiple accept="image/*">');
   await page.evaluate(()=>document.querySelector('#add').addEventListener('click',()=>setTimeout(()=>{const menu=document.createElement('button');menu.setAttribute('role','menuitem');menu.textContent='Upload files';menu.addEventListener('click',()=>document.querySelector('#foreign-input').click());document.body.append(menu)},0)));
   const failure=await page.evaluate(async value=>{try{await module.exports.attach(value);return {}}catch(error){return {message:error.message,code:error.code}}},{...task,step_phase:'ready'});
   assert.match(failure.message,/找不到当前上传控件的唯一/);assert.equal(failure.code,'workflow_attachment_not_ready');assert(await page.locator('input[type=file]').evaluateAll(inputs=>inputs.every(input=>input.files.length===0)));
  });
  await check('an asynchronously mounted menu with explicit aria-controls still resolves only its own synchronous file target',async()=>{
   await load('<div>'+form(fourInputs)+'<button id="add" aria-label="Add files" aria-controls="owned-menu">+</button></div>');
   await page.evaluate(pictures=>{const input=document.querySelector('#multi-image');input.addEventListener('change',()=>{const tray=document.createElement('div');tray.innerHTML=pictures.map(src=>`<div data-testid="composer-attachment"><img width="64" height="64" src="${src}" alt="Image"></div>`).join('');document.querySelector('form').append(tray)});document.querySelector('#add').addEventListener('click',()=>setTimeout(()=>{const menu=document.createElement('div');menu.id='owned-menu';menu.setAttribute('role','menu');const option=document.createElement('button');option.setAttribute('role','menuitem');option.textContent='添加照片和文件';option.addEventListener('click',()=>input.click());menu.append(option);document.body.append(menu)},100))},[picture('red'),picture('blue')]);
   await page.evaluate(value=>module.exports.attach(value),task);assert.equal((await state()).ready,true);assert.equal(await page.locator('#multi-image').evaluate(input=>input.files.length),2);assert.equal(await page.locator('#image-video').evaluate(input=>input.files.length),0);
  });
  await check('foreign, wrong-type or multiple synchronous file triggers reject without choosing another candidate',async()=>{
   for(const variant of ['audio','dialog','double','foreign-control']){
    await load('<div>'+form(fourInputs)+'<button id="add" aria-label="Add files">+</button></div><button id="foreign-add" aria-label="Add files">project upload</button><input id="audio" type="file" accept="audio/*"><div role="dialog"><input id="dialog-input" type="file" accept="image/*" multiple></div>');
    const failure=await page.evaluate(({task,variant})=>{const control=document.querySelector(variant==='foreign-control'?'#foreign-add':'#add');control.addEventListener('click',()=>{if(variant==='audio')document.querySelector('#audio').click();else if(variant==='dialog')document.querySelector('#dialog-input').click();else{document.querySelector('#multi-image').click();document.querySelector('#image-video').click()}});try{module.exports.captureUploadInput(control,task);return {}}catch(error){return {message:error.message,code:error.code}}},{task:{...task,step_phase:'ready'},variant});
    assert.match(failure.message,variant==='foreign-control'?/无法确认当前上传控件/:/多个或不适用/);assert.equal(failure.code,'workflow_attachment_not_ready');assert(await page.locator('input[type=file]').evaluateAll(inputs=>inputs.every(input=>input.files.length===0)));
   }
  });
  await check('asynchronous file clicks do not retain capture authority or gain selection after the owned click has returned',async()=>{
   await load('<div>'+form(fourInputs)+'<button id="add" aria-label="Add files">+</button></div>');
   await page.evaluate(()=>{document.addEventListener('click',event=>{if(event.target.matches('input[type=file]'))event.preventDefault()},true);document.querySelector('#add').addEventListener('click',()=>{setTimeout(()=>document.querySelector('#multi-image').click(),0)})});
   const failure=await page.evaluate(async value=>{try{await module.exports.attach(value);return {}}catch(error){return {message:error.message,code:error.code}}},{...task,step_phase:'ready'});
   assert.match(failure.message,/找不到当前上传控件的唯一/);assert.equal(failure.code,'workflow_attachment_not_ready');assert(await page.locator('input[type=file]').evaluateAll(inputs=>inputs.every(input=>input.files.length===0)));assert.equal((await state()).ready,false);
  });
  await check('capture listener is removed after success and failure, prototypes are untouched, and changed composer, drafts or existing attachments reject',async()=>{
   for(const variant of ['success','invalid','editor','draft','text-before','text-during']){
    await load('<div>'+form(fourInputs)+(variant==='draft'?card(names[0]):'')+'<button id="add" aria-label="Add files">+</button></div><input id="audio" type="file" accept="audio/*">');
    const proof=await page.evaluate(({task,variant})=>{const originalAdd=document.addEventListener,originalRemove=document.removeEventListener,originalClick=HTMLInputElement.prototype.click;const active=new Set();document.addEventListener=function(type,listener,options){if(type==='click')active.add(listener);return originalAdd.call(this,type,listener,options)};document.removeEventListener=function(type,listener,options){if(type==='click')active.delete(listener);return originalRemove.call(this,type,listener,options)};const control=document.querySelector('#add');if(variant==='text-before')document.querySelector('#prompt-textarea').value='foreign draft';let clicks=0;control.addEventListener('click',()=>{clicks++;document.querySelector(variant==='invalid'?'#audio':'#multi-image').click();if(variant==='editor'){const box=document.querySelector('#prompt-textarea');box.replaceWith(box.cloneNode(true))}if(variant==='text-during')document.querySelector('#prompt-textarea').value='foreign draft'});let selected=null,error='';try{selected=module.exports.captureUploadInput(control,task)?.id||null}catch(failure){error=failure.message}finally{document.addEventListener=originalAdd;document.removeEventListener=originalRemove}return {selected,error,active:active.size,prototypeUnchanged:HTMLInputElement.prototype.click===originalClick,clicks}},{task:{...task,step_phase:'ready'},variant});
    assert.equal(proof.active,0);assert(proof.prototypeUnchanged);if(variant==='success')assert.equal(proof.selected,'multi-image');else assert(proof.error);if(['draft','text-before'].includes(variant))assert.equal(proof.clicks,0);
   }
  });
  await check('main-world app handlers trigger the exact file input through an isolated-world content-script capture listener',async()=>{
   await load('<div>'+form(fourInputs)+'<button id="add" aria-label="Add files">+</button></div>');
   await page.evaluate(pictures=>{const input=document.querySelector('#multi-image');window.__mainInputClicks=[];input.addEventListener('click',event=>window.__mainInputClicks.push(event.defaultPrevented));input.addEventListener('change',()=>{const tray=document.createElement('div');tray.innerHTML=pictures.map(src=>`<div data-testid="composer-attachment"><img width="64" height="64" src="${src}" alt="Image"></div>`).join('');document.querySelector('form').append(tray)});document.querySelector('#add').addEventListener('click',()=>input.click())},[picture('red'),picture('blue')]);
   const cdp=await page.context().newCDPSession(page);const {frameTree}=await cdp.send('Page.getFrameTree');const {executionContextId}=await cdp.send('Page.createIsolatedWorld',{frameId:frameTree.frame.id,worldName:'workbench-upload-isolated-fixture'});
   const setup=await cdp.send('Runtime.evaluate',{contextId:executionContextId,expression:"window.module={exports:{}};window.chrome={runtime:{getManifest:()=>({version:'isolated-fixture'}),sendMessage:async()=>({ok:true,value:{ok:true}})}};"+source,returnByValue:true});assert(!setup.exceptionDetails);
   const proof=await cdp.send('Runtime.evaluate',{contextId:executionContextId,expression:'(async()=>{await module.exports.attach('+JSON.stringify({...task,step_phase:'ready'})+');return module.exports.attachmentState('+JSON.stringify(task)+')})()',awaitPromise:true,returnByValue:true});assert(!proof.exceptionDetails,proof.exceptionDetails?.text);assert.equal(proof.result.value.ready,true);assert.deepEqual(await page.evaluate(()=>window.__mainInputClicks),[true]);assert.equal(await page.locator('#multi-image').evaluate(input=>input.files.length),2);assert.equal(await page.locator('#image-video').evaluate(input=>input.files.length),0);await cdp.detach();
  });
  await check('a captured single-file control replaced after its first selection does not fall back to another ambiguous input',async()=>{
   await load('<div>'+form(fourInputs)+'<button id="add" aria-label="Add files">+</button></div>');
   await page.evaluate(()=>{const input=document.querySelector('#single-image');input.addEventListener('change',()=>{const replacement=document.createElement('input');replacement.type='file';replacement.accept='image/*';replacement.id='replacement';input.replaceWith(replacement)});document.querySelector('#add').addEventListener('click',()=>input.click())});
   const failure=await page.evaluate(async value=>{try{await module.exports.attach(value);return {}}catch(error){return {message:error.message,code:error.code}}},{...task,step_phase:'ready'});
   assert.match(failure.message,/第 2\/2 个附件时找不到/);assert.equal(failure.code,'workflow_attachment_not_ready');assert(await page.locator('input[type=file]').evaluateAll(inputs=>inputs.every(input=>input.files.length===0)));
  });
  await check('even a unique local input cannot upload files into a pre-existing foreign draft',async()=>{
   await load(form('<input type="file" multiple accept="image/*">'));await page.locator('#prompt-textarea').fill('my own draft');
   const failure=await page.evaluate(async value=>{try{await module.exports.attach(value);return {}}catch(error){return {message:error.message,code:error.code}}},{...task,step_phase:'ready'});
   assert.match(failure.message,/已有其他草稿/);assert.equal(failure.code,'workflow_attachment_not_ready');assert.equal(await page.locator('input[type=file]').evaluate(input=>input.files.length),0);assert.equal(await page.locator('#prompt-textarea').inputValue(),'my own draft');
  });
  await check('same-file attachment decoration changes do not restart the continuous stability window',async()=>{
   const html=form(card(names[0])+card(names[1],'blue'));
   async function wait(code){await load(html,code);return page.evaluate(async value=>{const counter=document.createElement('span');document.querySelector('[data-testid="composer-attachment"]').append(counter);let ticks=0;const timer=setInterval(()=>counter.textContent='preview refreshed '+(++ticks),200);try{await module.exports.waitAttachments(value,2800);return {ok:true}}catch(error){return {ok:false,message:error.message}}finally{clearInterval(timer)}},task)}
   if(baseline){const old=await wait(baseline);assert.equal(old.ok,false);assert.match(old.message,/连续稳定时间不足/);result.baselineReproductions.push('0.4.9 never becomes stable while auxiliary card text refreshes');}
   assert.equal((await wait(source)).ok,true);
  });
  await check('standard signed preview renewal preserves file identity; generic id and token changes do not',async()=>{
   await load(form(card(names[0])+card(names[1],'blue')));
   const signed='https://preview.invalid/file-A.png?sv=2024-11-04&sig=old&se=2026-11-03T01%3A00%3A00Z&sp=r&sr=b';
   const renewed=signed.replace('sig=old','sig=new').replace('01%3A00','02%3A00');
   const identities=await page.evaluate(values=>values.map(value=>module.exports.attachmentSourceIdentity(value)),[signed,renewed,'https://preview.invalid/preview?id=A&token=token-A','https://preview.invalid/preview?id=A&token=token-B','https://preview.invalid/preview?id=B&token=token-A']);
   assert.equal(identities[0],identities[1]);assert.notEqual(identities[2],identities[3]);assert.notEqual(identities[2],identities[4]);
   await page.locator('img').first().evaluate((element,url)=>element.src=url,signed);await page.waitForFunction(()=>[...document.images].every(image=>image.complete));const first=(await state()).fingerprint;
   await page.locator('img').first().evaluate((element,url)=>element.src=url,renewed);await page.waitForFunction(()=>[...document.images].every(image=>image.complete));assert.equal((await state()).fingerprint,first);
   await page.locator('img').first().evaluate((element,url)=>element.src=url,signed.replace('/file-A.png','/file-B.png'));await page.waitForFunction(()=>[...document.images].every(image=>image.complete));assert.notEqual((await state()).fingerprint,first);
  });
  await check('extra, wrong-task, uploading and broken-preview evidence still block both new-chat and continuation fixtures',async()=>{
   for(const step of [1,3]){
    const current={...task,step_number:step},fileNames=task.attachments.map((item,index)=>task.job_id.slice(0,12)+'-s'+step+'-a'+(index+1)+'-'+item.name);
    for(const extra of [card('other-file.png','green'),'<div role="progressbar" style="width:40px;height:20px"></div>']){
     await load('<div>'+form()+'<div>'+card(fileNames[0])+card(fileNames[1],'blue')+extra+'</div></div>');assert.equal((await state(current)).ready,false);
    }
    await load(form(card(fileNames[0])+card(fileNames[1].replace('-a2-','-a9-'),'blue')));assert.equal((await state(current)).ready,false);
    await load(form(card(fileNames[0])+card(fileNames[1],'blue')));await page.locator('img').first().evaluate(element=>Object.defineProperty(element,'complete',{get:()=>false}));assert.equal((await state(current)).ready,false);
   }
  });
  await check('attachment error classification is emitted only for a definitely unsent ready workflow step',async()=>{
   await load(form());
   for(const phase of ['ready','sending','sent',undefined]){
    const failure=await page.evaluate(async value=>{try{await module.exports.waitAttachments(value,1);return {}}catch(error){return {code:error.code,message:error.message}}},{...task,step_phase:phase});
    assert.match(failure.message,/实际唯一附件数量不符/);assert.equal(failure.code,phase==='ready'?'workflow_attachment_not_ready':undefined);
   }
  });
  result.sendClicks=await page.evaluate(()=>window.__sends);assert.equal(result.sendClicks,0);assert.deepEqual(result.pageErrors,[]);result.passed=true;
 }catch(error){result.passed=false;result.error=String(error.stack||error);throw error}
 finally{fs.writeFileSync(path.join(evidence,'verification.json'),JSON.stringify(result,null,2));await browser.close()}
 console.log(JSON.stringify({passed:result.passed,checks:result.checks.length,baselineReproductions:result.baselineReproductions.length,pageErrors:result.pageErrors.length,sendClicks:result.sendClicks}));
})().catch(error=>{console.error(error);process.exitCode=1});
