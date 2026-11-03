const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const {chromium}=require('./local_tools/dxm-uploader/_internal/playwright/driver/package');
const source=fs.readFileSync(path.join(__dirname,'gpt_chrome_extension/content.js'),'utf8');
const gestureBaselineRevision='448678544c7067a1ba425d808c3fc9a25ca39d80';
const overlayBaselineRevision='0ecd8965769ed40e2c69c0bc191576feb55c3571';
let gestureBaseline=null,overlayBaseline=null;
try{gestureBaseline=cp.execFileSync('git',['show',gestureBaselineRevision+':gpt_chrome_extension/content.js'],{cwd:__dirname,encoding:'utf8',stdio:['ignore','pipe','pipe']})}catch{}
try{overlayBaseline=cp.execFileSync('git',['show',overlayBaselineRevision+':gpt_chrome_extension/content.js'],{cwd:__dirname,encoding:'utf8',stdio:['ignore','pipe','pipe']})}catch{}
const literalDirectory=path.join(__dirname,'test_fixtures/gpt-upload-20261103');
const literalMenu=fs.readFileSync(path.join(literalDirectory,'menu-button.html'),'utf8'),literalPlus=fs.readFileSync(path.join(literalDirectory,'plus-button.html'),'utf8');
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
const result={mode:'isolated headless DOM fixtures; no live GPT or backend; historical baselines when available; real React MAIN to isolated-world fixtures including user-provided literals',content_sha256:require('node:crypto').createHash('sha256').update(source).digest('hex'),literal_sha256:{menu:require('node:crypto').createHash('sha256').update(literalMenu).digest('hex'),plus:require('node:crypto').createHash('sha256').update(literalPlus).digest('hex')},checks:[],baseline:{revision:baselineRevision,available:Boolean(baseline),gestureRevision:gestureBaselineRevision,gestureAvailable:Boolean(gestureBaseline),overlayRevision:overlayBaselineRevision,overlayAvailable:Boolean(overlayBaseline)},baselineReproductions:[],pageErrors:[],sendClicks:0};
const fourInputs='<input id="single-image" type="file" accept="image/*"><input id="image-video" type="file" multiple accept="image/*,video/*"><input id="multi-image" type="file" multiple accept="image/*"><input id="any-file" type="file" multiple>';
const literalOverlay=(content=literalMenu,section='chatgpt-primary')=>'<div data-composer-overlay-floating-ui="true"><div data-mention-section-id="'+section+'"><div data-mention-section-items="true">'+content+'</div></div></div>';
const literalComposer=(extra='')=>'<div id="literal-wrapper"><form id="literal-form"><textarea id="prompt-textarea"></textarea>'+fourInputs+literalPlus+extra+'</form></div>';
const store=path.join(__dirname,'node_modules/.pnpm');
const esbuild=require(path.join(store,fs.readdirSync(store).find(name=>name.startsWith('esbuild@')),'node_modules/esbuild'));
const reactGestureBundle=esbuild.buildSync({stdin:{contents:`
 import React,{useState,useRef} from 'react';
 import {createRoot} from 'react-dom/client';
 import {createPortal} from 'react-dom';
 const h=React.createElement;
 function App(){
  const [open,setOpen]=useState(false),[files,setFiles]=useState([]),input=useRef(null);
  const onPointerDown=event=>{window.__reactEvents.push('pointerdown');if(event.button===0&&!event.ctrlKey)setTimeout(()=>setOpen(true),80)};
  const onClick=()=>{window.__reactEvents.push('click');setOpen(previous=>!previous)};
  return h(React.Fragment,null,h('div',{id:'composer-wrapper'},h('form',{id:'composer-form'},
   h('textarea',{id:'prompt-textarea'}),
   h('input',{id:'single-image',type:'file',accept:'image/*'}),h('input',{id:'image-video',type:'file',accept:'image/*,video/*',multiple:true}),
   h('input',{id:'multi-image',type:'file',accept:'image/*',multiple:true,ref:input,onClick:event=>window.__reactInputDefault.push(event.defaultPrevented),onChange:event=>setFiles([...event.target.files].map(file=>file.name))}),
   h('input',{id:'any-file',type:'file',multiple:true}),
   h('button',{id:'add',type:'button','aria-label':'添加文件等内容','aria-haspopup':'menu','aria-expanded':open,'aria-controls':open?'react-menu':undefined,'data-state':open?'open':'closed',onPointerDown,onClick},'+'),
   h('button',{type:'button','data-testid':'send-button',onClick:()=>window.__sends++},'Send'),
   ...files.map((name,index)=>h('div',{'data-testid':'composer-attachment',title:name,key:name},h('img',{width:64,height:64,src:window.__fixturePictures[index],alt:name}))))),
   open?createPortal(h('div',{id:'react-menu',role:'menu','aria-labelledby':'add'},h('button',{id:'react-option',type:'button',role:'menuitem',onClick:()=>{window.__reactEvents.push('menu-click');input.current.click()}},'添加照片和文件 从计算机上传')),document.body):null);
 }
 window.__reactEvents=[];window.__reactInputDefault=[];createRoot(document.getElementById('react-root')).render(h(App));
 `,resolveDir:__dirname,sourcefile:'isolated-react-upload-fixture.js'},bundle:true,write:false,platform:'browser',format:'iife',define:{'process.env.NODE_ENV':'"production"'}}).outputFiles[0].text;
const reactLiteralBundle=esbuild.buildSync({stdin:{contents:`
 import React,{useState,useRef,useEffect} from 'react';import {createRoot} from 'react-dom/client';import {createPortal} from 'react-dom';const h=React.createElement;
 const plus=${JSON.stringify(literalPlus)},menu=${JSON.stringify(literalMenu)};
 const PlusLiteral=React.memo(()=>h('div',{id:'literal-plus-host',onClick:()=>window.__literalEvents.push('entry-click'),dangerouslySetInnerHTML:{__html:plus}}));
 const MenuLiteral=React.memo(()=>h('div',{'data-mention-section-items':'true',dangerouslySetInnerHTML:{__html:menu}}));
 function App(){
  const [shown,setShown]=useState(false),[files,setFiles]=useState([]),input=useRef(null);
  useEffect(()=>{const timer=setTimeout(()=>setShown(true),80);return()=>clearTimeout(timer)},[]);
  const onMenuClick=event=>{if(event.target.closest('button[data-list-navigation-item="true"]')){window.__literalEvents.push('menu-click');input.current.click()}};
  return h(React.Fragment,null,h('div',{id:'literal-composer-wrapper'},h('form',{id:'literal-composer-form'},h('textarea',{id:'prompt-textarea'}),
   h('input',{id:'single-image',type:'file',accept:'image/*'}),h('input',{id:'image-video',type:'file',accept:'image/*,video/*',multiple:true}),
   h('input',{id:'multi-image',type:'file',accept:'image/*',multiple:true,ref:input,onClick:event=>window.__literalInputDefault.push(event.defaultPrevented),onChange:event=>setFiles([...event.target.files].map(file=>file.name))}),h('input',{id:'any-file',type:'file',multiple:true}),
   h(PlusLiteral),
   h('button',{type:'button','data-testid':'send-button',onClick:()=>window.__sends++},'Send'),...files.map((name,index)=>h('div',{'data-testid':'composer-attachment',title:name,key:name},h('img',{width:64,height:64,src:window.__fixturePictures[index],alt:name}))))),
   shown?createPortal(h('div',{'data-composer-overlay-floating-ui':'true',onClick:onMenuClick},h('div',{'data-mention-section-id':'chatgpt-primary'},h(MenuLiteral))),document.body):null);
 }window.__literalEvents=[];window.__literalInputDefault=[];createRoot(document.getElementById('react-root')).render(h(App));
 `,resolveDir:__dirname,sourcefile:'isolated-react-literal-upload-fixture.js'},bundle:true,write:false,platform:'browser',format:'iife',define:{'process.env.NODE_ENV':'"production"'}}).outputFiles[0].text;

(async()=>{
 const browser=await chromium.launch({executablePath:process.env.WORKBENCH_TEST_CHROME||path.join(__dirname,'runtime/gpt-chrome/chrome-win64/chrome.exe'),headless:true});
 const page=await browser.newPage();page.on('pageerror',error=>result.pageErrors.push(error.message));
 await page.route('https://preview.invalid/**',route=>route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="red"/></svg>'}));
 await page.route('https://composer-fixture.invalid/**',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html><body></body></html>'}));
 async function load(html,code=source,fixtureRoot=false){
  await page.goto(fixtureRoot?'https://composer-fixture.invalid/':'about:blank');await page.setContent(html);
  await page.evaluate(()=>{window.module={exports:{}};window.__sends=0;window.__posts=[];window.chrome={runtime:{getManifest:()=>({version:'fixture'}),sendMessage:async message=>{window.__posts.push(message);return {ok:true,value:{ok:true}}}}}});
  await page.addScriptTag({content:code.replace('module.exports={','module.exports={uploadInput,attachmentScope,attachmentPresence,clearOwnedPresendComposer,'+(code.includes('function attachmentSourceIdentity(')?'attachmentSourceIdentity,':'')+(code.includes('function uploadMenu(')?'uploadMenu,':'')+(code.includes('function captureUploadInput(')?'captureUploadInput,':''))});
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
  await check('0.4.11 click-only cannot open a pointerdown-only menu; the compatible entry stops at the first owned open menu',async()=>{
   const html='<div>'+form(fourInputs)+'<button id="add" type="button" aria-label="添加文件等内容">+</button></div>';
   async function setup(){await page.evaluate(pictures=>{
    window.__triggerEvents=[];const add=document.querySelector('#add'),input=document.querySelector('#multi-image');
    input.addEventListener('change',()=>{document.querySelector('form').insertAdjacentHTML('beforeend',pictures.map(src=>`<div data-testid="composer-attachment"><img width="64" height="64" src="${src}" alt="Image"></div>`).join(''))});
    for(const type of ['pointerdown','mousedown','pointerup','mouseup','click'])add.addEventListener(type,()=>window.__triggerEvents.push(type));
    add.addEventListener('pointerdown',event=>{if(event.button!==0||event.ctrlKey)return;const menu=document.createElement('button');menu.id='pointer-menu';menu.setAttribute('role','menuitem');menu.innerHTML='<span>添加照片和文件</span><span>从计算机上传</span>';menu.addEventListener('click',()=>input.click());document.body.append(menu)});
   },[picture('red'),picture('blue')]);}
   if(gestureBaseline){await load(html,gestureBaseline);await setup();assert.equal(await page.evaluate(value=>module.exports.captureUploadInput(document.querySelector('#add'),value),task),null);assert.deepEqual(await page.evaluate(()=>window.__triggerEvents),['click']);assert.equal(await page.locator('#pointer-menu').count(),0);result.baselineReproductions.push('0.4.11 only dispatches click and leaves a pointerdown-only composer menu closed');}
   await load(html);await setup();await page.evaluate(value=>module.exports.attach(value),task);assert.equal((await state()).ready,true);assert.deepEqual(await page.evaluate(()=>window.__triggerEvents),['pointerdown']);assert.equal(await page.locator('#multi-image').evaluate(input=>input.files.length),2);
  });
  await check('mousedown, mouseup and click-only entry handlers remain compatible without activating a menu item twice',async()=>{
   for(const trigger of ['mousedown','mouseup','click']){
    await load('<div>'+form(fourInputs)+'<button id="add" type="button" aria-label="Add files">+</button></div>');
    await page.evaluate(({trigger,pictures})=>{window.__entryEvents=[];window.__menuClicks=0;const add=document.querySelector('#add'),input=document.querySelector('#multi-image');input.addEventListener('change',()=>document.querySelector('form').insertAdjacentHTML('beforeend',pictures.map(src=>`<div data-testid="composer-attachment"><img width="64" height="64" src="${src}" alt="Image"></div>`).join('')));for(const type of ['pointerdown','mousedown','pointerup','mouseup','click'])add.addEventListener(type,()=>window.__entryEvents.push(type));add.addEventListener(trigger,()=>{add.setAttribute('aria-controls','owned-menu');add.setAttribute('aria-expanded','true');const menu=document.createElement('div');menu.id='owned-menu';menu.setAttribute('role','menu');menu.innerHTML='<button id="upload-option" type="button" role="menuitem">Upload photos and files</button>';menu.querySelector('button').addEventListener('click',()=>{window.__menuClicks++;input.click()});document.body.append(menu)})},{trigger,pictures:[picture('red'),picture('blue')]});
    await page.evaluate(value=>module.exports.attach(value),task);assert.equal((await state()).ready,true);const events=await page.evaluate(()=>window.__entryEvents);assert.equal(events.at(-1),trigger);assert.equal(await page.evaluate(()=>window.__menuClicks),1);
   }
  });
  await check('preventDefault used only to retain composer focus does not suppress a click-only menu fallback',async()=>{
   await load('<div>'+form(fourInputs)+'<button id="add" type="button" aria-label="Add files">+</button></div>');
   await page.evaluate(pictures=>{window.__entryEvents=[];const add=document.querySelector('#add'),input=document.querySelector('#multi-image');input.addEventListener('change',()=>document.querySelector('form').insertAdjacentHTML('beforeend',pictures.map(src=>`<div data-testid="composer-attachment"><img width="64" height="64" src="${src}" alt="Image"></div>`).join('')));for(const type of ['pointerdown','mousedown','pointerup','mouseup','click'])add.addEventListener(type,event=>{window.__entryEvents.push(type);if(type==='pointerdown')event.preventDefault()});add.addEventListener('click',()=>{const option=document.createElement('button');option.setAttribute('role','menuitem');option.textContent='Add photos and files';option.addEventListener('click',()=>input.click());document.body.append(option)})},[picture('red'),picture('blue')]);
   await page.evaluate(value=>module.exports.attach(value),task);assert.equal((await state()).ready,true);assert.deepEqual(await page.evaluate(()=>window.__entryEvents),['pointerdown','pointerup','click']);
  });
  await check('an already open explicitly owned menu is reused without toggling its composer entry closed',async()=>{
   await load('<div>'+form(fourInputs)+'<button id="add" type="button" aria-label="Add files" aria-expanded="true" aria-controls="owned-menu">+</button></div><div id="owned-menu" role="menu"><button id="owned-option" type="button" role="menuitem">添加照片和文件 从计算机上传</button></div>');
   await page.evaluate(pictures=>{window.__entryEvents=[];const input=document.querySelector('#multi-image');input.addEventListener('change',()=>document.querySelector('form').insertAdjacentHTML('beforeend',pictures.map(src=>`<div data-testid="composer-attachment"><img width="64" height="64" src="${src}" alt="Image"></div>`).join('')));for(const type of ['pointerdown','mousedown','click'])document.querySelector('#add').addEventListener(type,()=>{window.__entryEvents.push(type);document.querySelector('#owned-menu')?.remove()});document.querySelector('#owned-option').addEventListener('click',()=>input.click())},[picture('red'),picture('blue')]);
   await page.evaluate(value=>module.exports.attach(value),task);assert.equal((await state()).ready,true);assert.deepEqual(await page.evaluate(()=>window.__entryEvents),[]);
  });
  await check('the observed Chinese title and block subtitle remain identifiable without textContent whitespace',async()=>{
   for(const aria of ['', 'aria-label="添加照片和文件"'])for(const style of ['', 'style="display:block"']){
    const html='<div>'+form(fourInputs)+'<button id="add" type="button" aria-label="添加文件等内容" aria-expanded="true" aria-controls="owned-menu">+</button></div><div id="owned-menu" role="menu"><button id="owned-option" type="button" role="menuitem" '+aria+'><span>添加照片和文件</span><span '+style+'>从计算机上传</span></button><button type="button" role="menuitem">从资料库添加</button></div>';
    if(gestureBaseline){await load(html,gestureBaseline);assert.equal(await page.locator('#owned-option').textContent(),'添加照片和文件从计算机上传');assert.equal(await page.evaluate(()=>module.exports.uploadMenu(document.querySelector('#add'),new Set())?.id||null),aria?'owned-option':null);if(!aria)result.baselineReproductions.push('0.4.11 textContent joins the observed Chinese upload title and '+(style?'block':'inline')+' subtitle and misses its menu option');}
    await load(html);await page.evaluate(pictures=>{const input=document.querySelector('#multi-image');input.addEventListener('change',()=>document.querySelector('form').insertAdjacentHTML('beforeend',pictures.map(src=>`<div data-testid="composer-attachment"><img width="64" height="64" src="${src}" alt="Image"></div>`).join('')));document.querySelector('#owned-option').addEventListener('click',()=>input.click())},[picture('red'),picture('blue')]);assert.equal(await page.evaluate(()=>module.exports.uploadMenu(document.querySelector('#add'),new Set())?.id),'owned-option');await page.evaluate(value=>module.exports.attach(value),task);assert.equal((await state()).ready,true);
   }
   for(const style of ['', 'style="display:block"']){await load('<div>'+form(fourInputs)+'<button id="add" type="button" aria-label="添加文件等内容" aria-controls="owned-menu">+</button></div><div id="owned-menu" role="menu"><button role="menuitem"><span>添加照片和文件</span><span '+style+'>从资料库上传</span></button></div>');assert.equal(await page.evaluate(()=>module.exports.uploadMenu(document.querySelector('#add'),new Set())),null);}
  });
  await check('disabled or aria-disabled upload entries and menu options never receive synthesized activation',async()=>{
   for(const disabled of ['disabled','aria-disabled="true"'])for(const target of ['entry','menu']){
    await load('<div>'+form(fourInputs)+'<button id="add" type="button" aria-label="Add files" '+(target==='entry'?disabled:'aria-expanded="true" aria-controls="owned-menu"')+'>+</button></div>'+(target==='menu'?'<div id="owned-menu" role="menu"><button id="owned-option" type="button" role="menuitem" '+disabled+'>Upload files</button></div>':''));
    await page.evaluate(target=>{window.__disabledActivations=0;const control=document.querySelector(target==='entry'?'#add':'#owned-option');for(const type of ['pointerdown','mousedown','click'])control.addEventListener(type,()=>{window.__disabledActivations++;document.querySelector('#multi-image').click()})},target);
    const failure=await page.evaluate(async value=>{try{await module.exports.attach(value);return {}}catch(error){return {message:error.message,code:error.code}}},{...task,step_phase:'ready'});assert.equal(failure.code,'workflow_attachment_not_ready');assert.equal(await page.evaluate(()=>window.__disabledActivations),0);assert(await page.locator('input[type=file]').evaluateAll(inputs=>inputs.every(input=>input.files.length===0)));
   }
   await load('<div>'+form(fourInputs)+'<button id="add" type="button" aria-label="Add files">+</button></div>');await page.evaluate(()=>{window.__entryClicks=0;document.querySelector('#add').addEventListener('pointerdown',()=>setTimeout(()=>document.querySelector('#add').disabled=true,10));document.querySelector('#add').addEventListener('click',()=>window.__entryClicks++)});
   const failure=await page.evaluate(async value=>{try{await module.exports.attach(value);return {}}catch(error){return {message:error.message,code:error.code}}},{...task,step_phase:'ready'});assert.equal(failure.code,'workflow_attachment_not_ready');assert.match(failure.message,/控件已禁用/);assert.equal(await page.evaluate(()=>window.__entryClicks),0);assert(await page.locator('input[type=file]').evaluateAll(inputs=>inputs.every(input=>input.files.length===0)));
   await load('<div>'+form(fourInputs)+'<button id="add" type="button" aria-label="Add files">+</button></div>');await page.evaluate(()=>{window.__lateMenuClicks=0;const control=document.querySelector('#add');control.addEventListener('pointerdown',()=>{control.setAttribute('aria-expanded','true');control.setAttribute('aria-controls','owned-menu');setTimeout(()=>control.setAttribute('aria-disabled','true'),10);setTimeout(()=>{const menu=document.createElement('div');menu.id='owned-menu';menu.setAttribute('role','menu');menu.innerHTML='<button id="late-option" type="button" role="menuitem">Upload files</button>';menu.querySelector('button').addEventListener('click',()=>{window.__lateMenuClicks++;document.querySelector('#multi-image').click()});document.body.append(menu)},60)})});const waiting=await page.evaluate(async value=>{try{await module.exports.attach(value);return {}}catch(error){return {message:error.message,code:error.code}}},{...task,step_phase:'ready'});assert.match(waiting.message,/控件已禁用/);assert.equal(waiting.code,'workflow_attachment_not_ready');assert.equal(await page.evaluate(()=>window.__lateMenuClicks),0);assert(await page.locator('input[type=file]').evaluateAll(inputs=>inputs.every(input=>input.files.length===0)));
   await load('<div>'+form(fourInputs)+'<button id="add" type="button" aria-label="Add files" aria-expanded="true" aria-controls="owned-menu">+</button></div><div id="owned-menu" role="menu"><button id="owned-option" type="button" role="menuitem">Upload files</button></div>');await page.evaluate(()=>document.querySelector('#owned-option').addEventListener('click',()=>{document.querySelector('#multi-image').click();document.querySelector('#owned-option').setAttribute('aria-disabled','true')}));const during=await page.evaluate(async value=>{try{await module.exports.attach(value);return {}}catch(error){return {message:error.message,code:error.code}}},{...task,step_phase:'ready'});assert.match(during.message,/选择文件期间已禁用/);assert.equal(during.code,'workflow_attachment_not_ready');assert(await page.locator('input[type=file]').evaluateAll(inputs=>inputs.every(input=>input.files.length===0)));
  });
  await check('a pointerdown or mousedown directly triggered file control is captured synchronously and stops all later entry phases',async()=>{
   for(const trigger of ['pointerdown','mousedown']){
    await load('<div>'+form(fourInputs)+'<button id="add" type="button" aria-label="Add files">+</button></div>');
    await page.evaluate(({trigger,pictures})=>{window.__entryEvents=[];window.__fileClicks=[];const input=document.querySelector('#multi-image');input.addEventListener('click',event=>window.__fileClicks.push({id:event.target.id,prevented:event.defaultPrevented}));input.addEventListener('change',()=>document.querySelector('form').insertAdjacentHTML('beforeend',pictures.map(src=>`<div data-testid="composer-attachment"><img width="64" height="64" src="${src}" alt="Image"></div>`).join('')));for(const type of ['pointerdown','mousedown','pointerup','mouseup','click'])document.querySelector('#add').addEventListener(type,()=>{window.__entryEvents.push(type);if(type===trigger)input.click();else if(type==='click')document.querySelector('#image-video').click()})},{trigger,pictures:[picture('red'),picture('blue')]});
    await page.evaluate(value=>module.exports.attach(value),task);assert.equal((await state()).ready,true);assert.equal((await page.evaluate(()=>window.__entryEvents)).at(-1),trigger);assert.deepEqual(await page.evaluate(()=>window.__fileClicks),[{id:'multi-image',prevented:true}]);assert.equal(await page.locator('#image-video').evaluate(input=>input.files.length),0);
   }
  });
  await check('wrong-type, dialog and multiple file clicks from any opening phase reject before assigning files',async()=>{
   for(const trigger of ['pointerdown','mousedown'])for(const invalid of ['audio','dialog','double']){
    await load('<div>'+form(fourInputs)+'<button id="add" type="button" aria-label="Add files">+</button></div><input id="audio" type="file" accept="audio/*"><div role="dialog"><input id="dialog-input" type="file" multiple accept="image/*"></div>');
    await page.evaluate(({trigger,invalid})=>document.querySelector('#add').addEventListener(trigger,()=>{if(invalid==='audio')document.querySelector('#audio').click();else if(invalid==='dialog')document.querySelector('#dialog-input').click();else{document.querySelector('#multi-image').click();document.querySelector('#image-video').click()}}),{trigger,invalid});
    const failure=await page.evaluate(async value=>{try{await module.exports.attach(value);return {}}catch(error){return {message:error.message,code:error.code}}},{...task,step_phase:'ready'});assert.match(failure.message,/多个或不适用/);assert.equal(failure.code,'workflow_attachment_not_ready');assert(await page.locator('input[type=file]').evaluateAll(inputs=>inputs.every(input=>input.files.length===0)));
   }
  });
  await check('trusted interaction during an opening-phase render wait revokes the next click fallback and all file selection',async()=>{
   await load('<div>'+form(fourInputs)+'<button id="add" type="button" aria-label="Add files">+</button></div><button id="project" type="button">Project attachments</button>');
   await page.evaluate(()=>{window.__pointerStarted=false;window.__fallbackClicks=0;document.querySelector('#add').addEventListener('pointerdown',()=>window.__pointerStarted=true);document.querySelector('#add').addEventListener('click',()=>{window.__fallbackClicks++;document.querySelector('#multi-image').click()})});
   await page.evaluate(value=>{window.__attachResult=null;module.exports.attach(value).then(()=>window.__attachResult={ok:true}).catch(error=>window.__attachResult={message:error.message,code:error.code})},{...task,step_phase:'ready'});await page.waitForFunction(()=>window.__pointerStarted);await page.getByRole('button',{name:'Project attachments',exact:true}).click();await page.waitForFunction(()=>window.__attachResult!==null);assert.equal(await page.evaluate(()=>window.__attachResult.code),'workflow_upload_interrupted');assert.equal(await page.evaluate(()=>window.__fallbackClicks),0);assert(await page.locator('input[type=file]').evaluateAll(inputs=>inputs.every(input=>input.files.length===0)));
  });
  await check('opening-phase draft, editor, task or entry replacement aborts before selecting files',async()=>{
   for(const mutation of ['draft','editor','task','entry']){
    await load('<div>'+form(fourInputs)+'<button id="add" type="button" aria-label="Add files">+</button></div>');
    await page.evaluate(mutation=>document.querySelector('#add').addEventListener('pointerdown',()=>{if(mutation==='draft')document.querySelector('#prompt-textarea').value='foreign draft';else if(mutation==='editor'){const box=document.querySelector('#prompt-textarea');box.replaceWith(box.cloneNode(true))}else if(mutation==='task')window.__currentTask.step_token='different-step';else{const control=document.querySelector('#add');control.replaceWith(control.cloneNode(true))}}),mutation);
    const failure=await page.evaluate(async value=>{window.__currentTask=value;try{await module.exports.attach(value);return {}}catch(error){return {message:error.message,code:error.code}}},{...task,step_phase:'ready'});assert.match(failure.message,/已变化|其他草稿|已从页面移除/);assert.equal(failure.code,'workflow_attachment_not_ready');assert(await page.locator('input[type=file]').evaluateAll(inputs=>inputs.every(input=>input.files.length===0)));
   }
  });
  await check('real React async pointerdown commit opens once before click fallback in both new-chat and continuation isolated worlds',async()=>{
   for(const step of [1,3]){
    await load('<div id="react-root"></div>');await page.evaluate(pictures=>window.__fixturePictures=pictures,[picture('red'),picture('blue')]);await page.addScriptTag({content:reactGestureBundle});await page.waitForSelector('#add');
    const cdp=await page.context().newCDPSession(page),{frameTree}=await cdp.send('Page.getFrameTree');const {executionContextId}=await cdp.send('Page.createIsolatedWorld',{frameId:frameTree.frame.id,worldName:'workbench-react-opening-isolated-fixture-'+step});
    const setup=await cdp.send('Runtime.evaluate',{contextId:executionContextId,expression:"window.module={exports:{}};window.chrome={runtime:{getManifest:()=>({version:'react-isolated-fixture'}),sendMessage:async()=>({ok:true,value:{ok:true}})}};"+source,returnByValue:true});assert(!setup.exceptionDetails);
    const current={...task,step_number:step,step_token:'react-step-'+step,step_phase:'ready'},proof=await cdp.send('Runtime.evaluate',{contextId:executionContextId,expression:'(async()=>{await module.exports.attach('+JSON.stringify(current)+');return module.exports.attachmentState('+JSON.stringify(current)+')})()',awaitPromise:true,returnByValue:true});assert(!proof.exceptionDetails,JSON.stringify(proof.exceptionDetails));assert.equal(proof.result.value.ready,true);assert.deepEqual(await page.evaluate(()=>window.__reactEvents),['pointerdown','menu-click']);assert.deepEqual(await page.evaluate(()=>window.__reactInputDefault),[true]);assert.equal(await page.locator('#multi-image').evaluate(input=>input.files.length),2);assert(await page.locator('#single-image,#image-video,#any-file').evaluateAll(inputs=>inputs.every(input=>input.files.length===0)));await cdp.detach();
   }
  });
  await check('current Chinese and English photo-and-file menus resolve existing ambiguous inputs through their own synchronous input click',async()=>{
   for(const menuLabel of ['添加照片和文件','Upload photos and files','Add photos and files']){
    await load('<div>'+form(fourInputs)+'<button id="add" aria-label="添加文件等内容">+</button></div>');
    await page.evaluate(({menuLabel,pictures})=>{const input=document.querySelector('#multi-image');input.addEventListener('change',()=>{const tray=document.createElement('div');tray.innerHTML=pictures.map(src=>`<div data-testid="composer-attachment"><img width="64" height="64" src="${src}" alt="Image"></div>`).join('');document.querySelector('form').append(tray)});document.querySelector('#add').addEventListener('click',()=>{const menu=document.createElement('button');menu.setAttribute('role','menuitem');menu.textContent=menuLabel;menu.addEventListener('click',()=>input.click());document.body.append(menu)})},{menuLabel,pictures:[picture('red'),picture('blue')]});
    await page.evaluate(value=>module.exports.attach(value),task);assert.equal((await state()).ready,true);assert.equal(await page.locator('#multi-image').evaluate(input=>input.files.length),2);
   }
  });
  await check('the unique marked composer entry outranks textual aliases, while duplicate marked entries cannot fall back to a first match',async()=>{
   await load('<div><form><textarea id="prompt-textarea"></textarea>'+literalOverlay('<button data-composer-navigation-target="add-context" aria-label="添加照片和文件">overlay decoy</button>')+literalPlus+'</form></div>');assert.equal(await page.evaluate(()=>module.exports.uploadControl()===document.querySelector('form > button[data-composer-navigation-target]')),true);
   await load(literalComposer(literalPlus));assert.equal(await page.evaluate(()=>module.exports.uploadControl()),null);
   await load('<div>'+form() +literalOverlay('<button aria-label="Add files">overlay decoy</button>')+'</div>');assert.equal(await page.evaluate(()=>module.exports.uploadControl()),null);
  });
  await check('the exact real Plus and menu literals resolve an asynchronous composer overlay that fixed 0.4.12 rejects',async()=>{
   async function setup(code){await load(literalComposer(),code);await page.evaluate(html=>new Promise(resolve=>setTimeout(()=>{document.body.insertAdjacentHTML('beforeend',html);resolve()},30)),literalOverlay());}
   if(overlayBaseline){await setup(overlayBaseline);assert.equal(await page.evaluate(()=>module.exports.uploadMenu(document.querySelector('[data-composer-navigation-target]'),new Set())),null);result.baselineReproductions.push('0.4.12 rejects the actual no-id/no-ARIA Plus and exact menu button in the observed asynchronous composer overlay structure');}
   await setup(source);assert.equal(await page.evaluate(()=>module.exports.uploadMenu(document.querySelector('[data-composer-navigation-target]'),new Set())===document.querySelector('[data-list-navigation-item]')),true);
  });
  await check('composer marker ownership requires a unique open entry, overlay, primary section, items container and the same nearest ancestor chain',async()=>{
   const variants=['no-entry-marker','wrong-entry-marker','closed-expanded','closed-state','double-entry','double-overlay','double-primary','double-items','foreign-section','foreign-chain','wrong-items-chain','no-navigation-marker','no-row-marker','wrong-overlay-marker','disabled-entry','history','dialog','alertdialog','native-dialog','duplicate-option'];
   for(const variant of variants){
    await load(literalComposer()+literalOverlay());
    await page.evaluate(variant=>{const control=document.querySelector('[data-composer-navigation-target]'),overlay=document.querySelector('[data-composer-overlay-floating-ui]'),section=overlay.querySelector('[data-mention-section-id]'),items=section.querySelector('[data-mention-section-items]'),option=items.querySelector('button');
     if(variant==='no-entry-marker')control.removeAttribute('data-composer-navigation-target');else if(variant==='wrong-entry-marker')control.setAttribute('data-composer-navigation-target','other');else if(variant==='closed-expanded')control.setAttribute('aria-expanded','false');else if(variant==='closed-state')control.setAttribute('data-state','closed');else if(variant==='double-entry')control.before(control.cloneNode(true));else if(variant==='double-overlay')overlay.after(overlay.cloneNode(true));else if(variant==='double-primary')overlay.append(section.cloneNode(true));else if(variant==='double-items')section.append(items.cloneNode(true));else if(variant==='foreign-section')section.setAttribute('data-mention-section-id','projects');else if(variant==='foreign-chain'){const foreign=document.createElement('div');foreign.setAttribute('data-mention-section-id','projects');foreign.innerHTML='<div data-mention-section-items="true"></div>';foreign.firstChild.append(option);overlay.append(foreign)}else if(variant==='wrong-items-chain')section.append(option);else if(variant==='no-navigation-marker')option.removeAttribute('data-list-navigation-item');else if(variant==='no-row-marker')option.querySelector('[data-menu-row-content]').removeAttribute('data-menu-row-content');else if(variant==='wrong-overlay-marker')overlay.setAttribute('data-composer-overlay-floating-ui','false');else if(variant==='disabled-entry')control.setAttribute('aria-disabled','true');else if(variant==='duplicate-option')items.append(option.cloneNode(true));else{const wrapper=document.createElement(variant==='native-dialog'?'dialog':'div');if(variant==='native-dialog')wrapper.open=true;else if(variant==='history')wrapper.setAttribute('data-message-author-role','assistant');else wrapper.setAttribute('role',variant);overlay.before(wrapper);wrapper.append(overlay)}
    },variant);
    assert.equal(await page.evaluate(()=>module.exports.uploadMenu(document.querySelector('form [data-composer-navigation-target],form > button'),new Set())),null,variant);assert(await page.locator('input[type=file]').evaluateAll(inputs=>inputs.every(input=>input.files.length===0)));
   }
  });
  await check('an explicit ARIA controls or labelled ownership never falls back to the marked composer overlay',async()=>{
   for(const variant of ['declared-not-mounted','declared-other','labelled-other']){
    await load(literalComposer()+literalOverlay());await page.evaluate(variant=>{const control=document.querySelector('[data-composer-navigation-target]');if(variant==='declared-not-mounted')control.setAttribute('aria-controls','not-mounted');else{control.id='fixture-plus';const other=document.createElement('div');other.id='other-owned';other.setAttribute('role','menu');if(variant==='labelled-other')other.setAttribute('aria-labelledby',control.id);else control.setAttribute('aria-controls',other.id);document.body.append(other)}},variant);assert.equal(await page.evaluate(()=>module.exports.uploadMenu(document.querySelector('[data-composer-navigation-target]'),new Set())),null,variant);
   }
  });
  await check('a global composer overlay is never attributed across multiple open marked entries, including partial open flags',async()=>{
   for(const flags of [['true','open'],['true','closed'],['false','open'],['false','closed']]){
    await load(literalComposer()+literalOverlay()+'<form id="other-composer"><textarea aria-label="other message"></textarea>'+literalPlus.replace('aria-expanded="true"','aria-expanded="'+flags[0]+'"').replace('data-state="open"','data-state="'+flags[1]+'"')+'</form>');assert.equal(await page.evaluate(()=>module.exports.uploadControl()===document.querySelector('#literal-form [data-composer-navigation-target]')),true);assert.equal(await page.evaluate(()=>module.exports.uploadMenu(document.querySelector('#literal-form [data-composer-navigation-target]'),new Set())===document.querySelector('[data-list-navigation-item]')),flags[0]==='false'&&flags[1]==='closed');
   }
  });
  await check('local semantic menu text ignores SVG style script and aria-hidden decoration even when rendering yields empty innerText',async()=>{
   const html=literalComposer()+literalOverlay();if(overlayBaseline){await load(html,overlayBaseline);await page.evaluate(()=>Object.defineProperty(document.querySelector('[data-list-navigation-item]'),'innerText',{get:()=>''}));assert.equal(await page.evaluate(()=>module.exports.uploadMenu(document.querySelector('[data-composer-navigation-target]'),new Set(),new Set([document.querySelector('[data-list-navigation-item]')]))),null);result.baselineReproductions.push('0.4.12 raw text fallback cannot identify the actual SVG/style-bearing menu literal when innerText is empty');}
   await load(html);await page.evaluate(()=>{const button=document.querySelector('[data-list-navigation-item]');Object.defineProperty(button,'innerText',{get:()=>''});button.insertAdjacentHTML('afterbegin','<script type="application/json">foreign-decoration</script><span aria-hidden="true">hidden-decoration</span>')});assert.equal(await page.evaluate(()=>module.exports.uploadMenu(document.querySelector('[data-composer-navigation-target]'),new Set())===document.querySelector('[data-list-navigation-item]')),true);
  });
  await check('composer overlays never supply attachment images names ZIP or progress and never drive the attachment scope',async()=>{
   for(const placement of ['inside-form','sibling-wrapper']){
    const phantom=literalOverlay(card(names[0])+card(names[1],'blue')+'<span title="bundle.zip">bundle.zip</span><span role="progressbar" style="display:block;width:32px;height:16px"></span><textarea aria-label="overlay message"></textarea>');
    const html=placement==='inside-form'?'<div>'+form(phantom)+'</div>':'<div>'+form()+phantom+'</div>';
    await load(html);const current=await state();assert.equal(current.ready,false);assert.equal(current.uniqueAttachments,0);assert.equal(current.rawImages,0);assert.equal(current.uploading,false);assert.equal(await page.evaluate(()=>module.exports.attachmentPresence()),false);assert.equal(await page.evaluate(()=>module.exports.attachmentScope().tagName),'FORM');
    const valid=placement==='inside-form'?'<div>'+form(card(names[0])+card(names[1],'blue')+phantom)+'</div>':'<div>'+form(card(names[0])+card(names[1],'blue'))+phantom+'</div>';await load(valid);assert.equal((await state()).ready,true);assert.equal((await state()).uniqueAttachments,2);
   }
   await load(literalOverlay('<textarea id="prompt-textarea" aria-label="message ChatGPT"></textarea>'));assert.equal(await page.evaluate(()=>module.exports.composer()),null);assert.equal(await page.evaluate(()=>module.exports.uploadControl()),null);
  });
  await check('owned presend cleanup can remove real composer cards without clicking an overlay remove action',async()=>{
   const overlay=literalOverlay(card(names[0])+card(names[1],'blue')+'<button id="overlay-remove" type="button">Remove overlay item</button>');
   await load('<form><textarea id="prompt-textarea">fixture owned prompt</textarea>'+overlay+'<div id="real-cards">'+card(names[0])+card(names[1],'blue')+'</div><button id="real-remove" type="button">Remove attached files</button></form>',source,true);await page.evaluate(()=>{window.__overlayRemoves=0;window.__realRemoves=0;document.querySelector('#overlay-remove').addEventListener('click',()=>window.__overlayRemoves++);document.querySelector('#real-remove').addEventListener('click',()=>{window.__realRemoves++;document.querySelector('#real-cards').remove()})});assert.equal(await page.evaluate(value=>module.exports.clearOwnedPresendComposer(value),{...task,prompt:'fixture owned prompt'}),true);assert.equal(await page.evaluate(()=>window.__overlayRemoves),0);assert.equal(await page.evaluate(()=>window.__realRemoves),1);
  });
  await check('an overlay file input is not a local fallback but can be assigned only after its exact owned menu click',async()=>{
   await load('<div><form><textarea id="prompt-textarea"></textarea>'+literalPlus+'</form></div>'+literalOverlay(literalMenu+'<input id="overlay-input" type="file" multiple accept="image/*">'));assert.equal(await page.evaluate(value=>module.exports.uploadInput(true,value),task),null);await page.evaluate(pictures=>{const input=document.querySelector('#overlay-input');input.addEventListener('change',()=>document.querySelector('form').insertAdjacentHTML('beforeend',pictures.map(src=>`<div data-testid="composer-attachment"><img width="64" height="64" src="${src}" alt="Image"></div>`).join('')));document.querySelector('[data-list-navigation-item]').addEventListener('click',()=>input.click())},[picture('red'),picture('blue')]);await page.evaluate(value=>module.exports.attach(value),task);assert.equal((await state()).ready,true);assert.equal(await page.locator('#overlay-input').evaluate(input=>input.files.length),2);
  });
  await check('real literal React asynchronous portals fail the fixed 0.4.12 baseline and work from MAIN handlers to isolated content on new chats and continuation',async()=>{
   async function setup(code){await load('<div id="react-root"></div>',code);await page.evaluate(pictures=>window.__fixturePictures=pictures,[picture('red'),picture('blue')]);await page.addScriptTag({content:reactLiteralBundle});await page.waitForSelector('[data-composer-navigation-target]');}
   if(overlayBaseline){await setup(overlayBaseline);const failure=await page.evaluate(async value=>{try{await module.exports.attach(value);return {}}catch(error){return {message:error.message,code:error.code}}},{...task,step_phase:'ready'});assert.match(failure.message,/找不到当前上传控件的唯一/);assert.equal(failure.code,'workflow_attachment_not_ready');assert(await page.locator('input[type=file]').evaluateAll(inputs=>inputs.every(input=>input.files.length===0)));result.baselineReproductions.push('0.4.12 actual literal asynchronous React portal stays unowned and never chooses files');}
   for(const step of [1,3]){
    await setup(source);const cdp=await page.context().newCDPSession(page),{frameTree}=await cdp.send('Page.getFrameTree');const {executionContextId}=await cdp.send('Page.createIsolatedWorld',{frameId:frameTree.frame.id,worldName:'workbench-real-literal-isolated-fixture-'+step});const init=await cdp.send('Runtime.evaluate',{contextId:executionContextId,expression:"window.module={exports:{}};window.chrome={runtime:{getManifest:()=>({version:'literal-isolated-fixture'}),sendMessage:async()=>({ok:true,value:{ok:true}})}};"+source,returnByValue:true});assert(!init.exceptionDetails);const current={...task,step_number:step,step_token:'literal-step-'+step,step_phase:'ready'},proof=await cdp.send('Runtime.evaluate',{contextId:executionContextId,expression:'(async()=>{await module.exports.attach('+JSON.stringify(current)+');return module.exports.attachmentState('+JSON.stringify(current)+')})()',awaitPromise:true,returnByValue:true});assert(!proof.exceptionDetails,JSON.stringify(proof.exceptionDetails));assert.equal(proof.result.value.ready,true);assert.deepEqual(await page.evaluate(()=>window.__literalEvents),['menu-click']);assert.deepEqual(await page.evaluate(()=>window.__literalInputDefault),[true]);assert.equal(await page.locator('#multi-image').evaluate(input=>input.files.length),2);assert(await page.locator('#single-image,#image-video,#any-file').evaluateAll(inputs=>inputs.every(input=>input.files.length===0)));await cdp.detach();
   }
  });
  await check('a later trusted project action cannot lend a newly opened marked overlay to the earlier composer wait',async()=>{
   await load(literalComposer()+'<button id="project" type="button">Project attachments</button><input id="foreign-input" type="file" multiple accept="image/*">');await page.evaluate(html=>{window.__foreignClicks=0;document.querySelector('#project').addEventListener('click',()=>{document.body.insertAdjacentHTML('beforeend',html);document.querySelector('[data-list-navigation-item]').addEventListener('click',()=>{window.__foreignClicks++;document.querySelector('#foreign-input').click()})})},literalOverlay());await page.evaluate(value=>{window.__attachResult=null;module.exports.attach(value).then(()=>window.__attachResult={ok:true}).catch(error=>window.__attachResult={message:error.message,code:error.code})},{...task,step_phase:'ready'});await page.waitForTimeout(100);await page.getByRole('button',{name:'Project attachments',exact:true}).click();await page.waitForFunction(()=>window.__attachResult!==null);assert.equal(await page.evaluate(()=>window.__attachResult.code),'workflow_upload_interrupted');assert.equal(await page.evaluate(()=>window.__foreignClicks),0);assert(await page.locator('input[type=file]').evaluateAll(inputs=>inputs.every(input=>input.files.length===0)));
  });
  await check('opening guards retain their attachment code and identify distinct entry editor draft task and disabled changes',async()=>{
   const messages=[];
   for(const mutation of ['entry','editor','draft','task','disabled','entry-lookup']){
    await load('<div>'+form(fourInputs)+'<button id="add" type="button" aria-label="Add files">+</button></div>');await page.evaluate(mutation=>document.querySelector('#add').addEventListener('pointerdown',()=>setTimeout(()=>{const control=document.querySelector('#add'),box=document.querySelector('#prompt-textarea');if(mutation==='entry')control.replaceWith(control.cloneNode(true));else if(mutation==='editor')box.replaceWith(box.cloneNode(true));else if(mutation==='draft')box.value='fixture foreign draft';else if(mutation==='task')window.__currentTask.step_token='changed';else if(mutation==='disabled')control.setAttribute('aria-disabled','true');else{const other=control.cloneNode(true);other.id='other-add';control.before(other)}},10)),mutation);const failure=await page.evaluate(async value=>{window.__currentTask=value;try{await module.exports.attach(value);return {}}catch(error){return {message:error.message,code:error.code}}},{...task,step_phase:'ready'});assert.equal(failure.code,'workflow_attachment_not_ready');assert.match(failure.message,/打开附件菜单期间/);messages.push(failure.message);assert(await page.locator('input[type=file]').evaluateAll(inputs=>inputs.every(input=>input.files.length===0)));
   }
   assert.equal(new Set(messages).size,6);
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
  await check('an asynchronous foreign menu appearing between opening phases never enters a later synchronous portal whitelist',async()=>{
   await load('<div>'+form(fourInputs)+'<button id="add" type="button" aria-label="Add files">+</button></div><input id="foreign-input" type="file" multiple accept="image/*">');
   await page.evaluate(()=>{window.__foreignClicks=0;window.__phaseEvents=[];const control=document.querySelector('#add');for(const type of ['pointerdown','mousedown','pointerup','mouseup','click'])control.addEventListener(type,()=>window.__phaseEvents.push(type));control.addEventListener('pointerdown',()=>setTimeout(()=>{const menu=document.createElement('button');menu.setAttribute('role','menuitem');menu.textContent='Upload files';menu.addEventListener('click',()=>{window.__foreignClicks++;document.querySelector('#foreign-input').click()});document.body.append(menu)},10))});
   const failure=await page.evaluate(async value=>{try{await module.exports.attach(value);return {}}catch(error){return {message:error.message,code:error.code}}},{...task,step_phase:'ready'});assert.match(failure.message,/找不到当前上传控件的唯一/);assert.equal(failure.code,'workflow_attachment_not_ready');assert.equal(await page.evaluate(()=>window.__foreignClicks),0);assert.deepEqual(await page.evaluate(()=>window.__phaseEvents),['pointerdown','mousedown','pointerup','mouseup','click']);assert(await page.locator('input[type=file]').evaluateAll(inputs=>inputs.every(input=>input.files.length===0)));
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
