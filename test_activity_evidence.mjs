import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

let clickHandler = null;
let sentBody = null;
const button = {
  style: {}, dataset: {}, disabled: false, textContent: "", title: "", type: "", id: "",
  addEventListener(type, handler) { if (type === "click") clickHandler = handler; },
};
const pageText = [
  "SPU ID：8669833554 美国站 83299686807",
  "法兰绒-40*50in 货号： 日常价：¥49.00 参考价：¥36.75",
  "法兰绒-60*80in 货号： 日常价：¥84.00 参考价：¥63.00 参考库存：30 销售库存：4000",
  "SPU ID：8361912651 美国站 70900819315",
  "法兰绒-50*60in 货号： 日常价：¥70.00 参考价：¥52.50 参考库存：30 销售库存：6000",
  "SPU ID：7361912651 美国站 70900819316",
  "混合色 货号： 日常价：¥24.00 参考价：¥18.00 参考库存：30 销售库存：6000",
].join(" ");
const document = {
  body: {innerText: pageText}, cookie: "mallid=634418231620307", title: "活动详情",
  documentElement: {appendChild() {}},
  getElementById() { return null; },
  querySelectorAll() { return []; },
  createElement() { return button; },
};
const chrome = {runtime: {
  getManifest() { return {version: "0.9.3"}; },
  async sendMessage(message) {
    sentBody = message.body;
    return {rows: 4, recovered: 4, unresolved: 0};
  },
}};
const messageListeners = new Set();
const context = {
  document, chrome, console, URLSearchParams, setTimeout, clearTimeout,
  crypto:{randomUUID(){return "fixture-id"}},
  addEventListener(type, listener){if(type==="message")messageListeners.add(listener)},
  removeEventListener(type, listener){if(type==="message")messageListeners.delete(listener)},
  postMessage(message){
    if (message?.command === "ACTIVITY_NETWORK_EVIDENCE" || message?.command === "ACTIVITY_REACT_EVIDENCE") setTimeout(() => {
      const result=message.command === "ACTIVITY_REACT_EVIDENCE" ? {success:true,rootCount:0,candidates:[]} : {success:true,responses:[]};
      const event={source:null,data:{source:"temu-dashboard-page",id:message.id,result}};
      for(const listener of messageListeners)listener(event);
    }, 0);
  },
  location: {
    pathname: "/activity/marketing-activity/detail-new",
    search: "?type=101&thematicId=2609060000024013",
    href: "https://agentseller.temu.com/activity/marketing-activity/detail-new?type=101&thematicId=2609060000024013",
  },
};
context.window = context;
vm.runInNewContext(fs.readFileSync("browser_extension/activity-evidence.js", "utf8"), context);
assert.ok(clickHandler, "capture button handler should be installed");
await clickHandler();
assert.equal(sentBody.candidates.length, 4);
assert.deepEqual([...sentBody.candidates.map((row) => row.spuId)], ["8669833554", "8669833554", "8361912651", "7361912651"]);
assert.deepEqual([...sentBody.candidates.map((row) => row.specification)], ["40×50in", "60×80in", "50×60in", "混合色"]);
assert.deepEqual([...sentBody.candidates.map((row) => row.dailyPrice)], [49, 84, 70, 24]);
assert.equal(sentBody.candidates.every((row) => row.skuId === ""), true);
assert.equal(sentBody.candidates.every((row) => row.skuCode === ""), true);
assert.match(button.textContent, /已同步本活动 4 个规格 · 查询更多 0 次 · 网络批次 0 \/ React新增 0 \/ 有效滚动 0/);
console.log("activity evidence visible-text fixture: OK");
