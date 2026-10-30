const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const context={module:{exports:{}},URL};
vm.runInNewContext(fs.readFileSync('gpt_chrome_extension/content.js','utf8'),context);
const api=context.module.exports;
const failure='抱歉，这次图片未能成功生成，当前我无法继续重试这一张。请你再发送一次同样的生成请求，或重新上传这两张参考图后让我继续处理。';
assert.equal(api.retryableWorkflowFailureText(failure),failure);
assert.ok(api.retryableWorkflowFailureText('图片生成失败，请重新发送。'));
assert.ok(api.retryableWorkflowFailureText('Image generation failed. Please send the same request again.'));
for(const text of [failure+' 今日额度已用完。',failure+' 请先登录。',failure+' 涉及安全政策。',
 '图片未能成功生成','请重新上传两张参考图'])assert.equal(api.retryableWorkflowFailureText(text),'');
const task={prompt_marker:'WBSTEP-test-token'};
const user={textContent:task.prompt_marker,contains:()=>false,querySelectorAll:()=>[],
 compareDocumentPosition:()=>4,closest:()=>null};
const paragraph={textContent:failure,closest:()=>null,contains:()=>false};
let laterUser=false,generated=false;
context.document={querySelector:()=>null,querySelectorAll(selector){
 if(selector=== 'img')return generated?[{src:'https://example.test/generated/current.png',alt:'Generated image',closest:()=>null,getAttribute:()=>null}]:[];
 if(selector.includes('main p'))return [paragraph];
 if(selector.includes('"user"'))return laterUser?[user,{textContent:'manual followup',contains:()=>false}]:[user];
 return [];
}};
assert.equal(api.workflowRetryFailure(task).text,failure,'A plain paragraph without an assistant role is still recognized');
generated=true;assert.equal(api.workflowRetryFailure(task),null,'Any generated-card evidence blocks resend');
generated=false;laterUser=true;assert.throws(()=>api.workflowRetryFailure(task),/另一条用户消息/);
console.log('Only exact current-turn technical failure can request one resend; images, quota, login, policy and later user messages block it: OK');
