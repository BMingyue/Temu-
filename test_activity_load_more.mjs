import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const batches = [
  "SPU ID：8669833554 SKC：83299686807 法兰绒-40*50in 日常价：¥49.00 参考价：¥36.75",
  "SPU ID：8361912651 SKC：70900819315 法兰绒-50*60in 日常价：¥70.00 参考价：¥52.50",
  "SPU ID：7361912651 SKC：70900819316 法兰绒-60*80in 日常价：¥84.00 参考价：¥63.00",
];
let batch = 0, processing = false, clickHandler = null, sentBody = null;
const remaining = () => (batches.length - batch - 1) * 60;
const more = {
  innerText:"查询更多商品", textContent:"查询更多商品", className:"", hidden:false,
  get disabled(){return processing || remaining() === 0;},
  getAttribute(name){return name === "aria-disabled" ? (this.disabled ? "true" : "false") : null;},
  click(){if(!this.disabled){processing=true;setTimeout(()=>{batch += 1;},150);setTimeout(()=>{processing=false;},600);}}, dispatchEvent(){}, scrollIntoView(){}, closest(){return null;},
};
const button = {style:{},dataset:{},disabled:false,textContent:"",title:"",addEventListener(type,handler){if(type === "click")clickHandler=handler;}};
const document = {
  cookie:"mallid=634418231620307", title:"活动详情", scrollingElement:null,
  documentElement:{appendChild(){},scrollHeight:0,clientHeight:0},
  get body(){return {innerText:`${batches.slice(0,batch+1).join(' ')} 剩余 ${remaining()} 件待查询 查询更多商品`};},
  getElementById(){return null;}, createElement(){return button;}, querySelector(){return null;},
  querySelectorAll(selector){
    if(selector === 'button, [role="button"], a')return [more];
    return [];
  },
};
const chrome={runtime:{getManifest(){return{version:"0.17.5"};},async sendMessage(message){sentBody=message.body;return{rows:3,recovered:3,unresolved:0,scanned:3};}}};
const context={document,chrome,console,URLSearchParams,setTimeout,clearTimeout,Event:class Event{},Date,location:{pathname:"/activity/marketing-activity/detail-new",search:"?thematicId=2609060000024013",href:"https://agentseller.temu.com/activity/marketing-activity/detail-new?thematicId=2609060000024013"}};
vm.runInNewContext(fs.readFileSync("browser_extension/activity-evidence.js","utf8"),context);
await clickHandler();
assert.deepEqual([...sentBody.candidates.map((row)=>row.spuId)].sort(),["7361912651","8361912651","8669833554"]);
assert.equal(sentBody.scan_stats.pages,1);
assert.equal(sentBody.scan_stats.load_more_clicks,2);
assert.equal(sentBody.scan_stats.remaining_query_count,0);
assert.equal(sentBody.scan_stats.scan_passes,1);
assert.match(button.textContent,/已同步本活动 3 个 SKU · 1 次扫描 \/ 查询更多 2 次/);
console.log("activity evidence load-more fixture: OK");
