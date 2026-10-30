import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const texts = [
  "SPU ID：8669833554 法兰绒-40*50in 日常价：¥49.00 参考价：¥36.75 参考库存：30",
  "SPU ID：8361912651 法兰绒-50*60in 日常价：¥70.00 参考价：¥52.50 参考库存：30",
];
let clickHandler = null, sentBody = null, currentText = texts[0], currentTop = 0;
const button = {style:{},dataset:{},disabled:false,textContent:"",title:"",addEventListener(type,handler){if(type==="click")clickHandler=handler;}};
const scroller = {
  clientHeight:200,clientWidth:900,scrollHeight:600,
  get scrollTop(){return currentTop;},
  set scrollTop(value){currentTop=value;currentText=value>=200?texts[1]:texts[0];},
  innerText:"SPU ID 商品信息 日常价",textContent:"",contains(){return false;},
  dispatchEvent(){},
};
const document = {
  cookie:"mallid=634418231620307",title:"活动详情",documentElement:{appendChild(){}},
  body:{get innerText(){return currentText;}},scrollingElement:null,
  getElementById(){return null;},createElement(){return button;},
  querySelectorAll(selector){return selector==="*"?[scroller]:[];},
};
const chrome={runtime:{getManifest(){return{version:"0.10.0"};},async sendMessage(message){sentBody=message.body;return{rows:2,recovered:2,unresolved:0};}}};
const context={document,chrome,console,URLSearchParams,setTimeout,Event:class Event{},location:{pathname:"/activity/marketing-activity/detail-new",search:"?thematicId=2609060000024013",href:"https://agentseller.temu.com/activity/marketing-activity/detail-new?thematicId=2609060000024013"}};
vm.runInNewContext(fs.readFileSync("browser_extension/activity-evidence.js","utf8"),context);
await clickHandler();
assert.deepEqual([...sentBody.candidates.map((row)=>row.spuId)].sort(),["8361912651","8669833554"]);
assert.equal(sentBody.capture_quality,"full_paginated_virtual_scroll");
assert.ok(sentBody.scan_stats.positions>=2);
assert.equal(currentTop,0,"scroll position should be restored");
console.log("activity evidence virtual scroll fixture: OK");
