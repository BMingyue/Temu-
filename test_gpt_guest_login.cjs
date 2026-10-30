const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('gpt_chrome_extension/content.js','utf8');

// Guest home pages expose a normal #prompt-textarea beside Log in / Sign up.
// Exercise the complete run() entry point with that DOM shape, not only a
// boolean login detector, and record every task bridge operation.
function page({controls=[],hasComposer=true}={}){
 const requests=[];
 const form={innerText:'',querySelectorAll:()=>[]};
 const box={tagName:'TEXTAREA',value:'',getClientRects:()=>[{}],closest:selector=>selector==='form'?form:null};
 const nodes=controls.map(({text='',aria='',testId='',shown=true})=>({
  textContent:text,innerText:text,getClientRects:()=>shown?[{}]:[],
  getAttribute:key=>key==='aria-label'?aria:key==='data-testid'?testId:null,
 }));
 const context={module:{exports:{}},console,URL,
  location:{href:'https://chatgpt.com/',pathname:'/'},
  sessionStorage:{getItem:()=> 'test-session'},
  document:{body:{innerText:'Ask anything'},
   querySelector:selector=>hasComposer&&selector==='#prompt-textarea'?box:null,
   querySelectorAll:selector=>selector==='button,a,[role="button"]'?nodes:[],
  },
  chrome:{runtime:{getManifest:()=>({version:'0.4.7'}),async sendMessage(message){
   if(message.type==='runner-context')return {ok:true,isolated:false};
   requests.push(message);return {ok:true,value:{task:null}};
  }}},
 };
 vm.runInNewContext(source,context);
 return {api:context.module.exports,requests,box};
}

(async()=>{
 const cases=[
  [{text:'Log in'},{text:'Sign up for free'}],
  [{text:'登录'},{text:'免费注册'}],
  [{text:'',aria:'Log in'}],
  [{text:'',testId:'login-button'}],
  [{text:'',testId:'signup-button'}],
 ];
 for(const controls of cases){
  const h=page({controls});
  assert.equal(h.api.composer(),h.box,'A visible composer exists on this guest page');
  await h.api.run();
  assert.equal(h.requests.length,1);
  assert.equal(h.requests[0].path,'/heartbeat');
  assert.equal(h.requests[0].body.status,'等待登录');
  assert.ok(!h.requests.some(r=>r.path==='/claim'||r.path==='/update'),'Guest pages must never claim or mutate tasks');
 }
 {
  const h=page({controls:[{text:'Log in',shown:false}]});
  await h.api.run();
  assert.equal(h.requests[0].body.status,'已连接');
  assert.equal(h.requests[0].body.message,'0.4.7 GPT 输入页面已就绪');
  assert.ok(!h.requests[0].body.message.includes('已登录'));
  assert.equal(h.requests[1].path,'/claim','Hidden login controls do not block ready pages');
 }
 {
  const h=page({hasComposer:false});
  await h.api.run();
  assert.equal(h.requests[0].body.status,'页面未识别');
  assert.equal(h.requests.length,1);
 }
 console.log('GPT guest gate: 5 guest DOM variants never claim; ready/unknown pages retain correct behavior.');
})().catch(error=>{console.error(error);process.exitCode=1});
