const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('gpt_chrome_extension/content.js','utf8').replace('module.exports={',`
 generatedSet=()=>scenario.images();wakeWorkflowImages=()=>0;generationActive=()=>false;
 workflowUserTurn=()=>scenario.user();responseDiagnostic=()=>({});explicitGenerationFailure=()=>'';
 missingAttachmentReply=()=>false;workflowRetryFailure=()=>null;workflowSnapshot=()=>({user_found:Boolean(scenario.user())});
 accessDenied=()=>false;loginPromptVisible=()=>false;composerText=()=>'';attachmentPresence=()=>false;
 module.exports={waitWorkflowImage,`);
async function test(neverHydrates=false){
 const start=Date.parse('2026-10-22T09:30:00+08:00');let clock=start;
 class Clock extends Date{constructor(...args){super(...(args.length?args:[clock]))}static now(){return clock}}
 const calls=[],image={complete:true,naturalWidth:1254,naturalHeight:1254,src:'https://example.test/generated/final.png',closest:()=>null};
 const context={module:{exports:{}},URL,Date:Clock,document:{visibilityState:'hidden'},
  location:{href:'https://chatgpt.com/c/original-sent-chat',reload(){throw Error('Unexpected reload')}},
  chrome:{runtime:{sendMessage:async m=>{calls.push(m);return {ok:true,value:{ok:true}}}}},
  setTimeout(fn,ms){clock+=ms;Promise.resolve().then(fn)},
  scenario:{user:()=>!neverHydrates&&clock-start>=3000?{}:null,
   images:()=>({images:!neverHydrates&&clock-start>=4000?[image]:[],unique:[]})},
 };
 vm.runInNewContext(source,context);
 const task={job_id:'resume',step_number:2,step_token:'same-token',step_phase:'sent',
  chat_url:context.location.href,response_last_progress_at:'2026-10-21T17:00:00+08:00'};
 if(neverHydrates){
  await assert.rejects(context.module.exports.waitWorkflowImage(task),e=>e.code==='workflow_page_not_ready');
  assert.ok(clock-start>=90000,'Hydration failure must not inherit yesterday\'s timeout');
 }else{
  assert.equal(await context.module.exports.waitWorkflowImage(task),image);
  assert.ok(clock-start>=4000);
 }
 assert.equal(calls.filter(m=>/sending|sent|reconnect/.test(m.body?.event||'')).length,0,'Recovery cannot resend or prematurely reload');
 assert.ok(calls.some(m=>m.body?.event==='response_diagnostic'),'Always leave observation evidence');
}
(async()=>{await test();await test(true);console.log('Old submitted turns wait for hydration, collect without sending, and fail structurally only after their own observation budget: OK')})().catch(e=>{console.error(e);process.exitCode=1});
