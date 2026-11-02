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

(async()=>{
 const browser=await chromium.launch({executablePath:process.env.WORKBENCH_TEST_CHROME||path.join(__dirname,'runtime/gpt-chrome/chrome-win64/chrome.exe'),headless:true});
 const page=await browser.newPage();page.on('pageerror',error=>result.pageErrors.push(error.message));
 await page.route('https://preview.invalid/**',route=>route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="red"/></svg>'}));
 async function load(html,code=source){
  await page.goto('about:blank');await page.setContent(html);
  await page.evaluate(()=>{window.module={exports:{}};window.__sends=0;window.__posts=[];window.chrome={runtime:{getManifest:()=>({version:'fixture'}),sendMessage:async message=>{window.__posts.push(message);return {ok:true,value:{ok:true}}}}}});
  await page.addScriptTag({content:code.replace('module.exports={','module.exports={uploadInput,attachmentScope,attachmentPresence,'+(code.includes('function attachmentSourceIdentity(')?'attachmentSourceIdentity,':'')+(code.includes('function uploadMenu(')?'uploadMenu,':''))});
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
  });
  await check('unrelated pre-existing file controls, history inputs and dialogs stay excluded',async()=>{
   await load(form()+'<input id="avatar" type="file" multiple accept="image/*"><div role="dialog"><input id="dialog" type="file" multiple accept="image/*"></div><div data-message-author-role="assistant"><input id="history" type="file" multiple accept="image/*"></div>');
   assert.equal(await page.evaluate(value=>module.exports.uploadInput(false,value),task),null);
   assert.equal(await page.evaluate(value=>module.exports.uploadInput(false,value,new Set([document.querySelector('#avatar')]))?.id,task),'avatar');
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
   await page.evaluate(pictures=>document.querySelector('#add').addEventListener('click',()=>{const input=document.createElement('input');input.id='new-upload';input.type='file';input.multiple=true;input.accept='image/*';input.addEventListener('change',()=>{const tray=document.createElement('div');tray.innerHTML=pictures.map(src=>`<div data-testid="composer-attachment"><img width="64" height="64" src="${src}" alt="Image"></div>`).join('');document.querySelector('form').append(tray)});document.body.append(input)}),[picture('red'),picture('blue')]);
   await page.evaluate(value=>module.exports.attach(value),task);assert.equal((await state()).ready,true);assert.equal(await page.locator('#unrelated').evaluate(element=>element.files.length),0);assert.equal(await page.locator('#new-upload').evaluate(element=>element.files.length),2);
  });
  await check('an unrelated already visible Upload files menu cannot be clicked or used for the composer',async()=>{
   await load('<div>'+form()+'<button id="add" aria-label="Add files">+</button></div><button id="foreign">Upload files</button>');
   await page.evaluate(()=>{window.__foreignClicks=0;document.querySelector('#foreign').addEventListener('click',()=>{window.__foreignClicks++;const input=document.createElement('input');input.type='file';input.multiple=true;input.accept='image/*';document.body.append(input)})});
   const failure=await page.evaluate(async value=>{try{await module.exports.attach(value);return {}}catch(error){return {message:error.message,code:error.code}}},{...task,step_phase:'ready'});
   assert.match(failure.message,/找不到唯一可接收/);assert.equal(failure.code,'workflow_attachment_not_ready');assert.equal(await page.evaluate(()=>window.__foreignClicks),0);assert.equal(await page.locator('input[type=file]').count(),0);
  });
  await check('only one newly visible owned portal upload menu may create the new file input',async()=>{
   await load('<div>'+form()+'<button id="add" aria-label="Add files">+</button></div>');
   await page.evaluate(pictures=>document.querySelector('#add').addEventListener('click',()=>{const menu=document.createElement('button');menu.setAttribute('role','menuitem');menu.textContent='Upload files';menu.addEventListener('click',()=>{const input=document.createElement('input');input.type='file';input.multiple=true;input.accept='image/*';input.addEventListener('change',()=>{const tray=document.createElement('div');tray.innerHTML=pictures.map(src=>`<div data-testid="composer-attachment"><img width="64" height="64" src="${src}" alt="Image"></div>`).join('');document.querySelector('form').append(tray)});document.body.append(input)});document.body.append(menu)}),[picture('red'),picture('blue')]);
   await page.evaluate(value=>module.exports.attach(value),task);assert.equal((await state()).ready,true);
   await load('<div>'+form()+'<button id="add" aria-label="Add files">+</button></div><button role="menuitem">Upload files</button><button role="menuitem">Upload files</button>');
   assert.equal(await page.evaluate(()=>module.exports.uploadMenu(document.querySelector('#add'),new Set())),null);
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
