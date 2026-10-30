const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const stamp=Date.parse('2026-10-22T01:00:00+08:00');
class Clock extends Date {constructor(...args){super(...(args.length?args:[stamp]))}static now(){return stamp}}
const calls=[];
const context={module:{exports:{}},URL,Date:Clock,
 chrome:{runtime:{getManifest:()=>({version:'0.4.1'}),sendMessage:async message=>{calls.push(message);return {ok:true,value:{ok:true}}}}},
 location:{href:'https://chatgpt.com/c/timer-test'},
};
const source=fs.readFileSync('gpt_chrome_extension/content.js','utf8').replace('module.exports={','module.exports={confirmWorkflowSend,');
vm.runInNewContext(source,context);
(async()=>{
 const task={job_id:'timer',step_number:2,step_token:'token',prompt_marker:'marker',response_last_progress_at:'2026-10-21T20:00:00+08:00'};
 await context.module.exports.confirmWorkflowSend(task,{getAttribute:()=> 'current-user-message'});
 assert.equal(Date.parse(task.response_last_progress_at),stamp);
 assert.equal(task.step_phase,'sent');
 assert.equal(calls.length,1);
 assert.equal(calls[0].body.event,'workflow_sent');
 console.log('Each confirmed image turn resets its own wait clock: OK');
})().catch(error=>{console.error(error);process.exitCode=1});
