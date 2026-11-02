const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),cp=require('node:child_process');
const {chromium}=require('./local_tools/dxm-uploader/_internal/playwright/driver/package');
const source=fs.readFileSync(path.join(__dirname,'gpt_chrome_extension/content.js'),'utf8');
const baselineRevision='6f5e5b516560d4f72e4b0e5ae3893a6f96eb811a';
const baselineOnly=process.argv.includes('--baseline-only');
let baseline=null;
try{baseline=cp.execFileSync('git',['show',baselineRevision+':gpt_chrome_extension/content.js'],{cwd:__dirname,encoding:'utf8',stdio:['ignore','pipe','pipe']})}catch{
 if(baselineOnly)throw Error('固定修前基线不在当前仓库中；--baseline-only需要历史提交 '+baselineRevision+'，不会把当前代码冒充修前代码');
}
const evidence=path.resolve(process.env.WORKBENCH_TEST_EVIDENCE_DIR||path.join(__dirname,'data/verification/20261102-gpt-attachment-dom'));
fs.mkdirSync(evidence,{recursive:true});
const task={job_id:'abcdef1234567890abcdef1234567890',workflow_mode:'single_image_chat_v1',step_number:3,step_token:'step-three',attachments:[{name:'03-template.png',type:'image/png',base64:'AA=='},{name:'01-main.png',type:'image/png',base64:'AA=='}]};
const pureContext={module:{exports:{}},URL};vm.runInNewContext(source,pureContext);
const names=task.attachments.map(item=>pureContext.module.exports.uploadName(task,item));
const picture=color=>'data:image/svg+xml;base64,'+Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="${color}"/></svg>`).toString('base64');
const img=(color,alt='')=>`<img width="64" height="64" src="${picture(color)}" alt="${alt}">`;
const card=(name,color='red',nested=true)=>`<div data-testid="composer-attachment" title="${name}">${nested?'<div data-testid="file-thumbnail">':''}${img(color,name)}${nested?'</div>':''}</div>`;
const shell=html=>`<form><div id="cards">${html}</div><textarea id="prompt-textarea"></textarea><button data-testid="send-button" onclick="window.__sends++">发送</button></form>`;
const result={mode:'isolated headless DOM fixtures; no real ChatGPT or backend requests',checks:[],baseline:{revision:baselineRevision,available:Boolean(baseline),skipped:!baseline,reason:baseline?'':'固定历史基线不可用（例如浅克隆）；仍完整验证当前实现'},baselineReproductions:[],errors:[]};

(async()=>{
 const browser=await chromium.launch({executablePath:process.env.WORKBENCH_TEST_CHROME||path.join(__dirname,'runtime/gpt-chrome/chrome-win64/chrome.exe'),headless:true});
 const page=await browser.newPage();
 page.on('pageerror',error=>result.errors.push(error.message));
 let posts=[];
 async function load(html,code=source){
  await page.goto('about:blank');await page.setContent(shell(html));
  await page.evaluate(()=>{
   window.module={exports:{}};window.__sends=0;window.__posts=[];
   window.chrome={runtime:{getManifest:()=>({version:'fixture'}),sendMessage:async message=>{window.__posts.push(message);return {ok:true,value:{ok:true}}}}};
  });
  await page.addScriptTag({content:code.replace('module.exports={','module.exports={attachmentState,')});
  await page.waitForFunction(()=>[...document.images].every(image=>image.complete));
 }
 async function state(current=task){return page.evaluate(value=>module.exports.attachmentState(value),current)}
 async function check(name,operation){await operation();result.checks.push(name)}
 try{
  const nested=card(names[0])+card(names[1],'blue');
  if(baseline){
   await load(nested,baseline);
   const old=await state();assert.equal(old.ready,false);assert.equal(old.references,2);assert.equal(old.uploading,false);
   result.baselineReproductions.push({scenario:'two real files expose nested markers',state:old});
  }
  if(baselineOnly){
   await load(nested+`<div data-message-author-role="assistant">${img('green','old generated image')}</div><button aria-label="Account">${img('orange','Profile picture')}</button>`,baseline);
   const old=await state();assert.equal(old.ready,false);assert.equal(old.references,2);assert.equal(old.uploading,false);
   result.baselineReproductions.push({scenario:'two attached files plus history and avatar',state:old});
   result.passed=true;console.log(JSON.stringify({passed:true,baselineOnly:true,baselineReproductions:2}));return;
  }
  await check('nested markers are one file each; two verified task files become ready',async()=>{
   await load(nested);const actual=await state();assert.equal(actual.ready,true);assert.equal(actual.uniqueAttachments,2);assert.equal(actual.rawThumbnails,4);assert.equal(actual.namedImages,2);
  });
  await check('an outer multi-file group keeps its two individual file cards',async()=>{
   await load(`<div data-testid="composer-attachment"><div data-testid="file-thumbnail" title="${names[0]}">${img('red',names[0])}</div><div data-testid="file-thumbnail" title="${names[1]}">${img('blue',names[1])}</div></div>`);
   const actual=await state();assert.equal(actual.ready,true);assert.equal(actual.uniqueAttachments,2);assert.equal(actual.rawThumbnails,3);
  });
  await check('history images and explicit account avatars cannot become composer attachments',async()=>{
   const html=nested+`<div data-message-author-role="assistant">${img('green','old generated image')}</div><button aria-label="Account">${img('orange','Profile picture')}</button>`;
   if(baseline){await load(html,baseline);const old=await state();assert.equal(old.ready,false);assert.equal(old.references,2);
    result.baselineReproductions.push({scenario:'two attached files plus history and avatar',state:old});}
   await load(html);const actual=await state();assert.equal(actual.ready,true);assert.equal(actual.uniqueAttachments,2);assert.equal(actual.rawImages,4);
  });
  await check('two renderings inside one named card are one attached file',async()=>{
   await load(card(names[0])+`<div data-testid="composer-attachment" title="${names[1]}">${img('blue',names[1])}${img('blue',names[1])}</div>`);
   const actual=await state();assert.equal(actual.ready,true);assert.equal(actual.uniqueAttachments,2);assert.equal(actual.rawImages,3);
  });
  await check('a genuine third file and unclassified extra image remain blocked',async()=>{
   for(const extra of [card('foreign.png','green'),img('green','unknown'),img('red',names[0])]){
    await load(nested+extra);const actual=await state();assert.equal(actual.ready,false);assert.equal(actual.uniqueAttachments,3);
   }
  });
  await check('same count with foreign, duplicate, or different-job names is not ready',async()=>{
   for(const second of ['foreign.svg',names[0],'otherjobprefix-'+task.attachments[1].name,'other '+task.attachments[1].name]){
    await load(card(names[0])+card(second,'blue'));const actual=await state();assert.equal(actual.ready,false);
   }
  });
  await check('two legitimate same-basename files have distinct step-indexed upload identities',async()=>{
   const same={...task,attachments:[{name:'01-main.png',type:'image/png',base64:'AA=='},{name:'01-main.png',type:'image/png',base64:'AQ=='}]};
   const unique=same.attachments.map(item=>pureContext.module.exports.uploadName(same,item));assert.notEqual(unique[0],unique[1]);
   await load(card(unique[0])+card(unique[1],'blue'));assert.equal((await state(same)).ready,true);
   await load(card(unique[0])+card(unique[0],'blue'));assert.equal((await state(same)).ready,false);
  });
  await check('foreign full filename cannot be overridden by bare expected preview alt',async()=>{
   for(const foreign of ['otherjobprefix-'+task.attachments[1].name,names[1].replace('-s3-','-s2-'),names[1].replace('-a2-','-a9-')]){
    await load(card(names[0])+`<div data-testid="composer-attachment" title="${foreign}">${img('blue',task.attachments[1].name)}</div>`);
    assert.equal((await state()).ready,false);
   }
  });
  await check('unidentified images need this exact task upload receipt; prompt text cannot supply file identity',async()=>{
   await load(card('','red')+card('','blue'));await page.locator('#prompt-textarea').fill(names.join(' '));assert.equal((await state()).ready,false);
   await load(img('red')+img('blue'));assert.equal((await state()).ready,false);
  });
  await check('visible uploading and incomplete previews block; hidden stale indicators do not',async()=>{
   await load(nested+'<span role="progressbar"></span>');await page.locator('[role="progressbar"]').evaluate(element=>element.style.cssText='display:block;width:40px;height:20px');assert.equal((await state()).ready,false);
   await page.locator('[role="progressbar"]').evaluate(element=>element.style.display='none');assert.equal((await state()).ready,true);
   await page.locator('img').first().evaluate(element=>Object.defineProperty(element,'complete',{get:()=>false}));assert.equal((await state()).ready,false);
  });
  await check('unmarked named images and legacy image plus ZIP stay supported',async()=>{
   await load(img('red',names[0])+img('blue',names[1]));assert.equal((await state()).ready,true);
   const legacy={job_id:task.job_id,reference:{name:'reference.png'},template_archive:{name:'bundle.zip'}};
   await load(card('reference.png')+'<div data-testid="composer-attachment" title="bundle.zip">bundle.zip</div>');assert.equal((await state(legacy)).ready,true);
  });
  await check('single-source editing still requires exactly one real task attachment',async()=>{
   const one={...task,workflow_input_mode:'single_source_edit',attachments:[task.attachments[0]]};
   await load(card(names[0]));assert.equal((await state(one)).ready,true);
   await load(nested);assert.equal((await state(one)).ready,false);
  });
  await check('successful local selection binds unnamed new cards, but not another step or foreign replacement',async()=>{
   await load('<input type="file" multiple>');
   await page.evaluate(pictures=>document.querySelector('input[type=file]').addEventListener('change',()=>{document.querySelector('#cards').innerHTML=pictures.map(src=>`<div data-testid="composer-attachment"><img width="64" height="64" src="${src}" alt="Image"></div>`).join('')}),[picture('red'),picture('blue')]);
   await page.evaluate(value=>module.exports.attach(value),task);
   assert.equal((await state()).ready,true);assert.equal((await state({...task,step_token:'other-step'})).ready,false);
   await page.locator('[data-testid="composer-attachment"] img').last().evaluate((element,src)=>element.src=src,picture('red'));await page.waitForFunction(()=>[...document.images].every(image=>image.complete));assert.equal((await state()).ready,false);
   await page.locator('[data-testid="composer-attachment"] img').last().evaluate((element,src)=>element.src=src,picture('blue'));await page.waitForFunction(()=>[...document.images].every(image=>image.complete));assert.equal((await state()).ready,true);
   await page.locator('[data-testid="composer-attachment"]').last().evaluate(element=>element.setAttribute('title','foreign.svg'));assert.equal((await state()).ready,false);
   posts=await page.evaluate(()=>window.__posts);assert(posts.length>0);assert(posts.every(message=>message.body.event==='progress'));
  });
  await check('failed file-input acceptance never grants an upload receipt',async()=>{
   await load('<input type="file" multiple>');
   await page.locator('input').evaluate(element=>Object.defineProperty(element,'files',{get:()=>[],set:()=>{}}));
   await assert.rejects(()=>page.evaluate(value=>module.exports.attach(value),task),/未接收/);
   await page.locator('#cards').evaluate((element,html)=>element.innerHTML=html,card('','red')+card('','blue'));await page.waitForFunction(()=>[...document.images].every(image=>image.complete));
   assert.equal((await state()).ready,false);
  });
  await check('stability resets after a gap or attachment fingerprint change, including time zero',async()=>{
   const context={module:{exports:{}},URL};vm.runInNewContext(source,context);const observe=context.module.exports.attachmentStability;
   let stable={firstReadyAt:null,positiveCount:0,fingerprint:''};const ready={ready:true,fingerprint:'files-A'};
   stable=observe(stable,ready,0);assert.equal(stable.ready,false);stable=observe(stable,{ready:false},1500);stable=observe(stable,ready,2000);assert.equal(stable.ready,false);stable=observe(stable,ready,3500);assert.equal(stable.ready,false);stable=observe(stable,ready,4000);assert.equal(stable.ready,true);
   stable=observe(stable,{ready:true,fingerprint:'files-B'},5000);assert.equal(stable.ready,false);
  });
  await check('real wait does not bridge a temporary upload gap and reports raw versus unique evidence',async()=>{
   await load(nested);
   const message=await page.evaluate(async value=>{
    const form=document.querySelector('form'),bar=document.createElement('div');bar.setAttribute('role','progressbar');bar.style.cssText='width:40px;height:20px';
    setTimeout(()=>form.append(bar),700);setTimeout(()=>bar.remove(),1300);
    try{await module.exports.waitAttachments(value,2600);return ''}catch(error){return error.message}
   },task);
   assert.match(message,/唯一附件 2/);assert.match(message,/原始标记 4/);assert.match(message,/连续稳定时间不足/);
   const stable=await page.evaluate(value=>module.exports.waitAttachments(value,3000),task);assert.equal(stable.ready,true);
  });
  assert.equal(await page.evaluate(()=>window.__sends),0);assert.equal(result.errors.length,0);
  assert(source.replace(/\r\n/g,'\n').includes("await workflowPost(task,'workflow_sending',{chat_url:location.href});\n     task.step_phase='sending';attempt.crossedSendBoundary=true;\n     send.click();"));
  result.passed=true;
 }catch(error){result.passed=false;result.error=error.stack;throw error;}
 finally{fs.writeFileSync(path.join(evidence,'verification.json'),JSON.stringify(result,null,2));await browser.close();}
 console.log(JSON.stringify({passed:result.passed,checks:result.checks.length,baselineReproductions:result.baselineReproductions.length,errors:result.errors.length}));
})().catch(error=>{console.error(error);process.exitCode=1});
