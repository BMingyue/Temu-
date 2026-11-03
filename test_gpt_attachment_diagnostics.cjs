const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {chromium}=require('./local_tools/dxm-uploader/_internal/playwright/driver/package');
const source=fs.readFileSync(path.join(__dirname,'gpt_chrome_extension/content.js'),'utf8');
const task={job_id:'abcdef1234567890abcdef1234567890',workflow_mode:'single_image_chat_v1',step_number:1,step_token:'diagnostic-test-token',step_phase:'ready',attachments:[{name:'template.png'},{name:'print.png'}]};
const counts=['elements','file_inputs','disabled_inputs','multiple_inputs','markers','visible_markers','images','visible_images','image_small','image_eligible_size','image_large','image_unloaded','images_in_overlay','images_in_dialog','images_in_history','overlays','progress','remove_buttons','file_dialog_buttons','cards','raw_images','raw_markers'];
const controlFlags=['present','connected','visible','native_disabled','inherited_disabled','aria_disabled','expanded','open','marked'];
const form=extra=>'<form>'+extra+'<textarea id="prompt-textarea"></textarea><button type="button" data-composer-navigation-target="add-context" aria-label="添加文件等内容">+</button></form>';
const image=size=>'<img style="width:'+size+'px;height:'+size+'px" alt="PRIVATE-IMAGE-NAME" data-secret="https://private.invalid/SECRET-SIGNATURE">';
const results=[];

(async()=>{
 const browser=await chromium.launch({executablePath:process.env.WORKBENCH_TEST_CHROME||path.join(__dirname,'runtime/gpt-chrome/chrome-win64/chrome.exe'),headless:true});
 const page=await browser.newPage(),pageErrors=[];let actions=0,requests=0;
 page.on('pageerror',error=>pageErrors.push(error.message));
 await page.route('**/*',route=>{requests++;return route.abort()});
 async function load(html,code=source){
  await page.goto('about:blank');await page.setContent(html);
  await page.evaluate(()=>{
   window.module={exports:{}};window.__messages=[];window.__actions=0;
   Object.defineProperty(window,'sessionStorage',{value:{getItem:()=> 'fixture-session',setItem(){},removeItem(){}}});
   for(const name of ['click','input','change','pointerdown','mousedown'])document.addEventListener(name,()=>window.__actions++,true);
   window.chrome={runtime:{getManifest:()=>({version:'test'}),sendMessage:async message=>{window.__messages.push(message);return {ok:true,value:{ok:true}}}}};
  });
  await page.addScriptTag({content:code});
 }
 async function diagnostic(){return page.evaluate(()=>module.exports.attachmentDiagnostic())}
 function shape(value){
  assert.deepEqual(Object.keys(value).sort(),['version','state','scope','composer','control','counts','ancestors'].sort());
  assert.equal(value.version,1);assert(['missing_composer','missing_scope','excluded_scope','captured','truncated'].includes(value.state));
  assert(['none','form','parent','wrapper'].includes(value.scope));
  assert.deepEqual(Object.keys(value.counts).sort(),counts.slice().sort());
  assert.deepEqual(Object.keys(value.control).sort(),controlFlags.slice().sort());
  assert.deepEqual(Object.keys(value.composer).sort(),['connected','visible']);
  assert.deepEqual(Object.keys(value.ancestors).sort(),['dialog','history','overlay']);
  for(const number of Object.values(value.counts)){assert.equal(typeof number,'number');assert(Number.isInteger(number)&&number>=0&&number<=5000)}
  for(const flags of [value.composer,value.control,value.ancestors])for(const flag of Object.values(flags))assert.equal(typeof flag,'boolean');
  assert(Buffer.byteLength(JSON.stringify(value),'utf8')<=3072);
  assert.doesNotMatch(JSON.stringify(value),/PRIVATE|SECRET|private\.invalid|diagnostic-test-token|template\.png|print\.png|data:image|textContent|outerHTML/);
 }
 async function check(name,operation){await operation();actions+=await page.evaluate(()=>window.__actions);results.push(name)}
 try{
  await check('missing composer reports a bounded empty fixed schema',async()=>{await load('<div>PRIVATE CHAT BODY</div>');const value=await diagnostic();shape(value);assert.equal(value.state,'missing_composer');assert.equal(value.counts.elements,0)});
  await check('structural counters distinguish image geometry, markers, inputs and generic overlay exclusions',async()=>{
   await load(form('<input type="file" multiple><input type="file" disabled><fieldset disabled><input type="file"></fieldset><div data-testid="composer-attachment">'+image(64)+'</div>'+image(24)+image(221)+'<div data-composer-overlay-floating-ui="true"><div data-testid="file-thumbnail">'+image(64)+'</div></div><div role="progressbar"></div><button type="button" aria-label="移除“PRIVATE-NAME.png”"></button><button type="button" aria-haspopup="dialog" title="PRIVATE-NAME.png"></button>'));
   const value=await diagnostic();shape(value);assert.equal(value.state,'captured');assert.equal(value.scope,'form');
   assert.equal(value.counts.file_inputs,3);assert.equal(value.counts.disabled_inputs,2);assert.equal(value.counts.multiple_inputs,1);
   assert.equal(value.counts.markers,2);assert.equal(value.counts.visible_markers,2);assert.equal(value.counts.raw_markers,1);
   assert.equal(value.counts.images,4);assert.equal(value.counts.image_small,1);assert.equal(value.counts.image_eligible_size,2);assert.equal(value.counts.image_large,1);assert.equal(value.counts.images_in_overlay,1);assert.equal(value.counts.raw_images,1);assert.equal(value.counts.cards,1);
   assert.equal(value.counts.overlays,1);assert.equal(value.counts.progress,1);assert.equal(value.counts.remove_buttons,1);assert.equal(value.counts.file_dialog_buttons,1);
  });
  await check('diagnostic collection never reads image sources, chat text, filenames, classes or HTML',async()=>{
   await load(form('<div data-testid="composer-attachment" title="PRIVATE-NAME.png">'+image(64)+'</div><button type="button" aria-label="移除“PRIVATE-NAME.png”"></button>')+'<article data-message-author-role="assistant">PRIVATE CHAT BODY '+image(64)+'</article>');
   await page.evaluate(()=>{
    const image=document.querySelector('img');for(const name of ['src','currentSrc','alt','outerHTML','textContent','className'])Object.defineProperty(image,name,{get(){throw Error('Sensitive getter '+name)}});
    const original=Element.prototype.getAttribute;Element.prototype.getAttribute=function(name){if(['src','srcset','class','data-secret','alt','title','aria-label'].includes(name))throw Error('Sensitive attribute '+name);return original.call(this,name)};
    Object.defineProperty(document.body,'innerText',{get(){throw Error('Chat body read')}});
   });
   const value=await diagnostic();shape(value);assert.equal(value.counts.images,1);assert.equal(value.counts.cards,1);
  });
  await check('current composer control flags explain native, inherited and ARIA disabled without changing the control',async()=>{
   await load(form(''));await page.evaluate(()=>{const button=document.querySelector('button');button.disabled=true;button.setAttribute('aria-disabled','true');button.setAttribute('aria-expanded','true');button.setAttribute('data-state','open')});
   const value=await diagnostic();shape(value);assert.deepEqual(value.control,{present:true,connected:true,visible:true,native_disabled:true,inherited_disabled:true,aria_disabled:true,expanded:true,open:true,marked:true});
   assert.equal(await page.evaluate(()=>document.querySelector('button').disabled),true);
  });
  await check('history around an otherwise visible composer is reported without traversing its content',async()=>{
   await load('<article data-message-author-role="assistant">'+form(image(64))+'</article>');
   const value=await diagnostic();shape(value);assert.equal(value.state,'excluded_scope');assert.equal(value.ancestors.history,true);assert.equal(value.counts.images,0);
  });
  await check('history and dialog sibling content is not scanned or used as local attachment evidence',async()=>{
   await load(form(image(64))+'<article data-message-author-role="assistant" id="private-history">'+image(64)+'</article><div role="dialog" id="private-dialog">'+image(64)+'</div>');
   await page.evaluate(()=>{for(const id of ['private-history','private-dialog']){const node=document.getElementById(id);Object.defineProperty(node,'innerText',{get(){throw Error('Private text read')}});Object.defineProperty(node,'textContent',{get(){throw Error('Private text read')}});node.querySelectorAll=()=>{throw Error('Private subtree scanned')}}});
   const value=await diagnostic();shape(value);assert.equal(value.counts.images,1);assert.equal(value.counts.images_in_dialog,0);assert.equal(value.counts.images_in_history,0);
  });
  await check('oversized local structure reports truncation before further scans and stays under 3KB',async()=>{
   await load(form('<div>'+Array(5001).fill('<i>PRIVATE</i>').join('')+'</div>'));
   const value=await diagnostic();shape(value);assert.equal(value.state,'truncated');assert.equal(value.counts.elements,5000);assert.equal(value.counts.cards,0);
  });
  await check('only a ready workflow attachment failure receives diagnostic metadata',async()=>{
   await load(form(image(64)));
   const failures=await page.evaluate(current=>[current,{...current,step_phase:'sent'},{...current,step_phase:'sending'},{job_id:current.job_id}].map(value=>{const error=module.exports.attachmentFailure(value,'Original attachment error');return {message:error.message,code:error.code||'',diagnostic:error.attachmentDiagnostic||null}}),task);
   assert.equal(failures[0].code,'workflow_attachment_not_ready');shape(failures[0].diagnostic);
   for(const failure of failures.slice(1)){assert.equal(failure.code,'');assert.equal(failure.diagnostic,null)}
   for(const failure of failures)assert.equal(failure.message,'Original attachment error');
  });
  await check('diagnostic exceptions preserve the original attachment error and failure code',async()=>{
   await load(form(''));await page.evaluate(()=>{document.querySelectorAll=()=>{throw Error('Synthetic DOM replaced')}});
   const failure=await page.evaluate(current=>{const error=module.exports.attachmentFailure(current,'Original attachment error');return {message:error.message,code:error.code,diagnostic:error.attachmentDiagnostic||null}},task);
   assert.deepEqual(failure,{message:'Original attachment error',code:'workflow_attachment_not_ready',diagnostic:null});
  });
  await check('existing needs-review catch carries the diagnostic with exact task and step ownership',async()=>{
   // Inject one synthetic failure at the execution boundary, to exercise the
   // existing run/catch wiring without selecting files or sending a message.
   const code=source.replace('if(workflowTask(task)){await executeWorkflow(task,attempt);return}', 'if(workflowTask(task)){throw attachmentFailure(task,"Synthetic attachment failure")}');
   assert.notEqual(code,source);await load(form(''),code);
   await page.evaluate(current=>{window.chrome.runtime.sendMessage=async message=>{window.__messages.push(message);if(message.type==='api'&&message.path==='/claim')return {ok:true,value:{task:current}};return {ok:true,value:{ok:true}}}},task);
   await page.evaluate(()=>module.exports.run());
   const reported=await page.evaluate(()=>window.__messages.filter(message=>message.type==='api'&&message.body?.event==='workflow_needs_review'));
   assert.equal(reported.length,1);assert.equal(reported[0].body.job_id,task.job_id);assert.equal(reported[0].body.step,1);assert.equal(reported[0].body.step_token,task.step_token);assert.equal(reported[0].body.code,'workflow_attachment_not_ready');shape(reported[0].body.attachment_diagnostic);
   assert.equal(await page.evaluate(()=>window.__messages.some(message=>message.body?.event==='workflow_sending'||message.body?.event==='workflow_sent')),false);
  });
  assert.equal(actions,0);assert.equal(requests,0);assert.deepEqual(pageErrors,[]);
  console.log(JSON.stringify({checks:results.length,results,actions,requests,pageErrors,content_sha256:require('node:crypto').createHash('sha256').update(source).digest('hex')},null,2));
 }finally{await browser.close()}
})().catch(error=>{console.error(error);process.exitCode=1});
