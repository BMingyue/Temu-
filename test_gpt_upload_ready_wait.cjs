const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {chromium}=require('./local_tools/dxm-uploader/_internal/playwright/driver/package');
const source=fs.readFileSync(path.join(__dirname,'gpt_chrome_extension/content.js'),'utf8');
const code=source.replace('module.exports={','module.exports={activateUploadControl,');
const task={job_id:'abcdef1234567890abcdef1234567890',workflow_mode:'single_image_chat_v1',step_number:5,step_token:'ready-wait-token',step_phase:'ready',attachments:[{name:'template.png',type:'image/png'},{name:'main.png',type:'image/png'}]};
const results=[];
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.WORKBENCH_TEST_CHROME||path.join(__dirname,'runtime/gpt-chrome/chrome-win64/chrome.exe'),headless:true});
 const page=await browser.newPage(),pageErrors=[];let requests=0;
 page.on('pageerror',error=>pageErrors.push(error.message));await page.route('**/*',route=>{requests++;return route.abort()});
 async function load(kind='native',mode='persistent',slow=false){
  await page.goto('about:blank');
  const button='<button id="add" type="button" data-composer-navigation-target="add-context" aria-label="添加文件等内容"'+(kind==='native'?' disabled':'')+(kind==='aria'?' aria-disabled="true"':'')+'>+</button>';
  await page.setContent('<form><textarea id="prompt-textarea"></textarea>'+(kind==='fieldset'?'<fieldset disabled>'+button+'</fieldset>':button)+'<input id="chosen" type="file" accept="image/*" multiple></form>');
  await page.evaluate(({mode,slow})=>{
   window.module={exports:{}};window.__task=null;window.__result=null;window.__now=0;window.__sleeps=[];window.__controlEvents=[];window.__eventStates=[];window.__inputClicks=0;window.__mutated=false;window.__trustedEvents=0;
   const nativeTimer=window.setTimeout.bind(window);Date.now=()=>window.__now;
   // Only the fixture clock changes: the production 20000ms deadline,
   // 250ms polls, identity guards and existing capture branch run unchanged.
   window.setTimeout=(callback,delay,...args)=>{window.__sleeps.push(delay);return nativeTimer(()=>{window.__now+=delay;
    if(mode==='late-enable'&&window.__sleeps.length===80){window.__now++;document.getElementById('add').disabled=false}
    if(window.__sleeps.length===2&&!window.__mutated){window.__mutated=true;const control=document.getElementById('add'),box=document.getElementById('prompt-textarea');
     if(mode==='enable'){control.disabled=false;control.removeAttribute('aria-disabled');control.closest('fieldset')?.removeAttribute('disabled')}
     else if(mode==='control-replaced')control.replaceWith(control.cloneNode(true));
     else if(mode==='box-replaced')box.replaceWith(box.cloneNode(true));
     else if(mode==='task-changed')window.__task.step_token='other-step-token';
     else if(mode==='draft')box.value='foreign fixture draft';
     else if(mode==='ambiguous')control.before(control.cloneNode(true));
    }
    callback(...args);
   },slow?8:1)};
   const control=document.getElementById('add');
   for(const type of ['pointerdown','mousedown','pointerup','mouseup','click'])control.addEventListener(type,()=>{window.__controlEvents.push(type);window.__eventStates.push({type,at:window.__now,disabled:control.disabled||control.matches(':disabled')||control.getAttribute('aria-disabled')==='true'})});
   control.addEventListener('pointerdown',()=>{
    if(mode==='disabled-during-action')control.disabled=true;
    document.getElementById('chosen').click();
   });
   document.getElementById('chosen').addEventListener('click',()=>window.__inputClicks++);
   document.addEventListener('keydown',event=>{if(event.isTrusted)window.__trustedEvents++},true);
   window.chrome={runtime:{getManifest:()=>({version:'fixture'}),sendMessage:async()=>({ok:true,value:{ok:true}})}};
  },{mode,slow});
  await page.addScriptTag({content:code});
 }
 async function activate(){return page.evaluate(async current=>{
  window.__task=current;
  try{const input=await module.exports.activateUploadControl(document.getElementById('add'),current);return {ok:true,input:input?.id,now:window.__now,sleeps:window.__sleeps,controlEvents:window.__controlEvents,eventStates:window.__eventStates,inputClicks:window.__inputClicks,files:document.getElementById('chosen').files.length}}
  catch(error){return {ok:false,message:error.message,code:error.code,now:window.__now,sleeps:window.__sleeps,controlEvents:window.__controlEvents,inputClicks:window.__inputClicks,files:document.getElementById('chosen').files.length}}
 },task)}
 async function check(name,operation){await operation();results.push(name)}
 function untouched(value){assert.deepEqual(value.controlEvents,[]);assert.equal(value.inputClicks,0);assert.equal(value.files,0)}
 try{
  for(const kind of ['native','aria','fieldset'])await check(kind+' disabled recovers on the same node before one owned capture',async()=>{
   await load(kind,'enable');const value=await activate();assert.equal(value.ok,true);assert.equal(value.input,'chosen');assert.equal(value.now,500);assert.deepEqual(value.sleeps,[250,250]);assert.deepEqual(value.controlEvents,['pointerdown']);assert.deepEqual(value.eventStates,[{type:'pointerdown',at:500,disabled:false}]);assert.equal(value.inputClicks,1);assert.equal(value.files,0);
  });
  for(const kind of ['native','aria','fieldset'])await check(kind+' disabled times out at the unchanged 20000ms deadline without input',async()=>{
   await load(kind);const value=await activate();assert.equal(value.ok,false);assert.equal(value.code,'workflow_attachment_not_ready');assert.match(value.message,/20 秒/);assert.equal(value.now,20000);assert.equal(value.sleeps.length,80);assert(value.sleeps.every(delay=>delay===250));untouched(value);
   assert.equal(await page.evaluate(()=>{const control=document.getElementById('add');return control.disabled||control.matches(':disabled')||control.getAttribute('aria-disabled')==='true'}),true);
  });
  await check('a control enabled only after the readiness deadline remains unactivated',async()=>{
   await load('native','late-enable');const value=await activate();assert.equal(value.ok,false);assert.equal(value.code,'workflow_attachment_not_ready');assert.match(value.message,/20 秒/);assert.equal(value.now,20001);untouched(value);
  });
  for(const [mode,message] of [['control-replaced',/添加文件按钮已从页面移除/],['box-replaced',/原 GPT 输入框已从页面移除/],['task-changed',/本步骤身份已变化/],['draft',/出现其他草稿/],['ambiguous',/入口已变化或不唯一/]])await check(mode+' cancels the initial wait without any upload action',async()=>{
   await load('native',mode);const value=await activate();assert.equal(value.ok,false);assert.equal(value.code,'workflow_attachment_not_ready');assert.match(value.message,message);assert.equal(value.now,500);untouched(value);
  });
  await check('trusted user input cancels the initial wait and never grants upload authority',async()=>{
   await load('native','persistent',true);
   await page.evaluate(current=>{window.__task=current;module.exports.activateUploadControl(document.getElementById('add'),current).then(()=>window.__result={ok:true},error=>window.__result={ok:false,message:error.message,code:error.code,now:window.__now,controlEvents:window.__controlEvents,inputClicks:window.__inputClicks,files:document.getElementById('chosen').files.length})},task);
   await page.waitForFunction(()=>window.__sleeps.length>=2);await page.keyboard.press('Escape');await page.waitForFunction(()=>window.__result!==null);
   const value=await page.evaluate(()=>window.__result);assert.equal(value.ok,false);assert.equal(value.code,'workflow_upload_interrupted');assert(value.now<20000);untouched(value);assert(await page.evaluate(()=>window.__trustedEvents)>0);
  });
  await check('an initially enabled owned control uses the unchanged capture path without a readiness sleep',async()=>{
   await load('enabled');const value=await activate();assert.equal(value.ok,true);assert.deepEqual(value.sleeps,[]);assert.deepEqual(value.controlEvents,['pointerdown']);assert.equal(value.inputClicks,1);assert.equal(value.files,0);
  });
  await check('disabled during an activation still fails immediately instead of entering the initial wait again',async()=>{
   await load('enabled','disabled-during-action');const value=await activate();assert.equal(value.ok,false);assert.equal(value.code,'workflow_attachment_not_ready');assert.match(value.message,/选择文件期间已禁用/);assert.deepEqual(value.sleeps,[]);assert.deepEqual(value.controlEvents,['pointerdown']);assert.equal(value.files,0);
  });
  assert.equal(requests,0);assert.deepEqual(pageErrors,[]);
  console.log(JSON.stringify({checks:results.length,results,requests,pageErrors,mode:'isolated headless fixtures, production deadline/poll/guard branches with accelerated fixture clock; no live profile or file assignment',content_sha256:require('node:crypto').createHash('sha256').update(source).digest('hex')},null,2));
 }finally{await browser.close()}
})().catch(error=>{console.error(error);process.exitCode=1});
