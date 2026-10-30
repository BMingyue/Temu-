const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('browser_extension/workbench-panel-manager.js', 'utf8');
const stored = {};
const listeners = [];
const elements = new Map();
function fakeElement(id='') {
  const attrs = new Map();
  return {
    id, hidden:false, dataset:{}, children:[],
    style:{ setProperty(name,value){this[name]=value}, removeProperty(name){delete this[name]} },
    setAttribute(name,value){attrs.set(name,value)}, removeAttribute(name){attrs.delete(name)},
    closest(){return null}, appendChild(child){this.children.push(child)},
    querySelector(){return {checked:false,dataset:{},addEventListener(){}}},
    querySelectorAll(){return []},
    attachShadow(){
      const nodes = new Map();
      const node = () => ({hidden:false,dataset:{},checked:false,children:[],addEventListener(){},appendChild(child){this.children.push(child)}});
      for (const selector of ['.menu','.items','.fab','.close','[data-action="none"]','[data-action="all"]']) nodes.set(selector,node());
      return {innerHTML:'',querySelector(selector){return nodes.get(selector)||node()},querySelectorAll(){return []}};
    },
  };
}
const root = fakeElement('root');
const document = {
  documentElement: root, body: root,
  createElement(){return fakeElement()},
  querySelectorAll(selector){return elements.has(selector)?[elements.get(selector)]:[]},
};
const chrome = {storage:{local:{async get(){return stored},async set(value){Object.assign(stored,value)}},onChanged:{addListener(fn){listeners.push(fn)}}}};
const context = {window:{},document,chrome,location:{origin:'https://agentseller-us.temu.com'},MutationObserver:class{observe(){}},setTimeout,clearTimeout,console};
vm.runInNewContext(source, context);
assert.ok(context.window.__workbenchPanelManager);
assert.ok(root.children.some((child)=>child.id==='wbPanelManager'));
assert.ok(listeners.length===1);
console.log('panel manager smoke test passed');
