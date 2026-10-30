import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const pageTexts = [
  "SPU ID：8669833554 SKC：83299686807 法兰绒-40*50in 日常价：¥49.00 参考价：¥36.75",
  "SPU ID：8361912651 SKC：70900819315 法兰绒-50*60in 日常价：¥70.00 参考价：¥52.50",
];
let page = 0, clickHandler = null, sentBody = null;
const root = {};
const control = (text, click) => ({
  innerText:text, textContent:text, className:"pagination-control", disabled:false, hidden:false,
  getAttribute(name){return name === "aria-disabled" ? (this.disabled ? "true" : "false") : null;},
  closest(){return root;}, click, dispatchEvent(){}, scrollIntoView(){},
});
const previous = control("上一页", () => { if (page > 0) page -= 1; });
const next = control("下一页", () => { if (page < pageTexts.length - 1) page += 1; });
const first = control("1", () => { page = 0; });
Object.defineProperty(previous, "disabled", {get(){return page === 0;}});
Object.defineProperty(next, "disabled", {get(){return page === pageTexts.length - 1;}});
const button = {style:{},dataset:{},disabled:false,textContent:"",title:"",addEventListener(type,handler){if(type === "click")clickHandler=handler;}};
const document = {
  cookie:"mallid=634418231620307", title:"活动详情", scrollingElement:null,
  documentElement:{appendChild(){},scrollHeight:0,clientHeight:0},
  get body(){return {innerText:pageTexts[page]};},
  getElementById(){return null;}, createElement(){return button;}, querySelector(){return null;},
  querySelectorAll(selector){
    if(selector === 'button, [role="button"], li, a')return [previous,next,first];
    if(selector.startsWith('[aria-current="page"'))return [{innerText:String(page+1),textContent:String(page+1)}];
    return [];
  },
};
const chrome={runtime:{getManifest(){return{version:"0.17.1"};},async sendMessage(message){sentBody=message.body;return{rows:2,recovered:2,unresolved:0};}}};
const context={document,chrome,console,URLSearchParams,setTimeout,clearTimeout,Event:class Event{},Date,location:{pathname:"/activity/marketing-activity/detail-new",search:"?thematicId=2609060000024013",href:"https://agentseller.temu.com/activity/marketing-activity/detail-new?thematicId=2609060000024013"}};
vm.runInNewContext(fs.readFileSync("browser_extension/activity-evidence.js","utf8"),context);
await clickHandler();
assert.deepEqual([...sentBody.candidates.map((row)=>row.spuId)].sort(),["8361912651","8669833554"]);
assert.equal(sentBody.scan_stats.pages,2);
assert.equal(sentBody.capture_quality,"full_paginated_virtual_scroll");
assert.equal(page,0,"activity collector should restore the page where it started");
assert.match(button.textContent,/已同步本活动 2 个 SKU · 2 次扫描 \/ 查询更多 0 次/);
console.log("activity evidence pagination fixture: OK");
