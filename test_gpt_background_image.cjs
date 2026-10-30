const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const context={module:{exports:{}},URL};
const source=fs.readFileSync('gpt_chrome_extension/content.js','utf8').replace('module.exports={','module.exports={wakeWorkflowImages,');
vm.runInNewContext(source,context);
const api=context.module.exports,task={prompt_marker:'WBSTEP-background-test'};
const turn=(role,text,position)=>({role,textContent:text,position,getAttribute:()=>null,closest:()=>null,
 querySelectorAll:()=>[],getClientRects:()=>[],
 compareDocumentPosition(other){return other.position>this.position?4:2}});
const user=turn('user',task.prompt_marker,0),assistant=turn('assistant','',1);
let scrolled=0,rendered=false;
const image={src:'https://example.test/generated/current.png',alt:'Generated image',loading:'lazy',complete:false,naturalWidth:0,
 getAttribute:()=>null,closest:()=>null,getBoundingClientRect:()=>({width:rendered?300:0,height:rendered?300:0}),
 scrollIntoView(){rendered=true;scrolled++}};
assistant.querySelectorAll=selector=>selector==='img'?[image]:[];
let nodes=[user,assistant];
context.document={querySelectorAll:selector=>nodes.filter(node=>selector.includes('"'+node.role+'"'))};
assert.equal(api.workflowAssistantTurn(task),assistant,'An unpainted response still belongs to the exact sent turn');
const awakened=new WeakSet();
assert.equal(api.wakeWorkflowImages(task,awakened),1);
assert.equal(image.loading,'eager');
assert.equal(scrolled,1);
assert.equal(api.wakeWorkflowImages(task,awakened),0,'Never continually scroll an already-awakened image');
nodes.push(turn('user','Another unpainted manual message',2));
assert.throws(()=>api.wakeWorkflowImages(task,awakened),/另一条用户消息/);
console.log('Background generated card wakes locally without focusing windows or touching uploads: OK');
