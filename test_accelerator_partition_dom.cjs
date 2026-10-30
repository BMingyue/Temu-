const assert=require('node:assert/strict'),{test}=require('node:test'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(process.env.WB_PARTITION_EVIDENCE_SOURCE||'./browser_extension/product-state-evidence.js','utf8');

// Small DOM fixture for the public partition APIs. Selectors are evaluated
// against a tree rather than returning canned matches for the implementation.
function matchesOne(element,selector){
 const attrs=[];
 selector=selector.trim().replace(/\[([^\]]+)\]/g,(_all,body)=>{attrs.push(body);return ''});
 const tag=selector.match(/^[\w-]+/);
 if(tag&&element.tagName!==tag[0].toUpperCase())return false;
 if([...selector.matchAll(/#([\w-]+)/g)].some(([,id])=>element.getAttribute('id')!==id))return false;
 if([...selector.matchAll(/\.([\w-]+)/g)].some(([,name])=>!String(element.className).split(/\s+/).includes(name)))return false;
 for(const body of attrs){
  const match=body.match(/^([\w-]+)(?:\s*(\*=|\^=|\$=|=)\s*(?:"([^"]*)"|'([^']*)'|([^\s]+))\s*(i)?)?$/i);
  assert.ok(match,'Unsupported fixture attribute selector: '+body);
  const [,name,operator,double,single,bare,ignoreCase]=match;
  let value=element.getAttribute(name),expected=double??single??bare;
  if(value===null)return false;
  if(!operator)continue;
  if(ignoreCase){value=value.toLowerCase();expected=expected.toLowerCase()}
  if(operator==='='&&value!==expected||operator==='*='&&!value.includes(expected)||operator==='^='&&!value.startsWith(expected)||operator==='$='&&!value.endsWith(expected))return false;
 }
 return true;
}
class Element{
 constructor(tag='div',text='',attrs={}){this.tagName=tag.toUpperCase();this.text=text;this.attrs={...attrs};this.children=[];this.parentElement=null;this.shown=true;this.clicks=0}
 get className(){return this.attrs.class||''}
 set className(value){this.attrs.class=value}
 get textContent(){return [this.text,...this.children.map(child=>child.textContent)].filter(Boolean).join(' ')}
 get innerText(){return this.textContent}
 getAttribute(name){return Object.hasOwn(this.attrs,name)?String(this.attrs[name]):null}
 setAttribute(name,value){this.attrs[name]=String(value)}
 removeAttribute(name){delete this.attrs[name]}
 matches(selector){return selector.split(',').some(part=>matchesOne(this,part))}
 append(...children){for(const child of children){child.remove();child.parentElement=this;this.children.push(child)}return this}
 remove(){if(this.parentElement){const siblings=this.parentElement.children;siblings.splice(siblings.indexOf(this),1);this.parentElement=null}}
 replaceWith(replacement){const parent=this.parentElement,index=parent.children.indexOf(this);replacement.remove();replacement.parentElement=parent;parent.children[index]=replacement;this.parentElement=null}
 contains(other){return this===other||this.children.some(child=>child.contains(other))}
 closest(selector){for(let node=this;node;node=node.parentElement)if(node.matches(selector))return node;return null}
 querySelectorAll(selector){return this.children.flatMap(child=>[...(child.matches(selector)?[child]:[]),...child.querySelectorAll(selector)])}
 querySelector(selector){return this.querySelectorAll(selector)[0]||null}
 getClientRects(){for(let node=this;node;node=node.parentElement){if(!node.shown)return [];if(node.tagName==='#DOCUMENT')return [{}]}return []}
 click(){this.clicks++;for(let node=this;node;node=node.parentElement){if(node.onClick){node.onClick();break}}}
}
const el=(tag,text,attrs)=>new Element(tag,text,attrs);
const CARD='quick-overdue-filter_card__7x5wV',ICON='quick-overdue-filter_clickIcon__ZbuiU';
function nativeCard(label='流量加速中',count='12'){
 const card=el('div','',{class:CARD});
 card.append(el('span',label),el('span',count));
 card.setActive=(active,shown=true)=>{
  for(const icon of card.querySelectorAll('[class*="quick-overdue-filter_clickIcon__"]'))icon.remove();
  if(active){const icon=el('div','',{class:ICON});icon.shown=shown;icon.append(el('span','',{class:'quick-overdue-filter_iconCnt__350ht'}));card.append(icon)}
 };
 card.onClick=()=>card.setActive(!card.querySelector('[class*="quick-overdue-filter_clickIcon__"]'));
 return card;
}
function fixture(...nodes){
 const doc=el('#document');doc.append(...nodes);
 let polls=0;
 const context={module:{exports:{}},setTimeout:fn=>{polls++;context.onPoll?.(polls);fn();return polls}};
 vm.createContext(context);vm.runInContext(source,context);
 return {doc,context,api:context.module.exports,list:()=>context.module.exports.listAcceleratorPartitions(doc),select:target=>context.module.exports.selectAcceleratorPartition(doc,target)};
}

test('native quick filter cards are listed as inactive before their selected icon appears',()=>{
 const enabled=nativeCard(),eligible=nativeCard('流量加速器待开启','7'),h=fixture(enabled,eligible);
 assert.deepEqual(Array.from(h.list().partitions,part=>[part.key,part.active]),[['enabled',false],['eligible',false]]);
});

test('clicking a native card confirms the visible clickIcon and does not toggle it off on a repeated selection',async()=>{
 const card=nativeCard(),h=fixture(card);
 const selected=await h.select('enabled');
 assert.equal(selected.key,'enabled');
 assert.equal(h.list().partitions[0].active,true);
 assert.equal(card.clicks,1);
 await h.select('流量加速中');
 assert.equal(card.clicks,1);
 assert.ok(card.querySelector('[class*="quick-overdue-filter_clickIcon__"]'));
});

test('an already selected native quick filter is returned without reversing the native toggle',async()=>{
 const card=nativeCard();card.setActive(true);const h=fixture(card);
 assert.equal(h.list().partitions[0].active,true);
 await h.select('enabled');
 assert.equal(card.clicks,0);
});

test('a native card whose click has no effect is rejected rather than claiming selected coverage',async()=>{
 const card=nativeCard();card.onClick=()=>{};const h=fixture(card);
 await assert.rejects(h.select('enabled'),/选择未生效/);
 assert.equal(card.clicks,1);
 assert.equal(h.list().partitions[0].active,false);
});

test('a hidden selected icon is not proof that the card is active',async()=>{
 const card=nativeCard();card.setActive(true,false);card.onClick=()=>{};const h=fixture(card);
 assert.equal(h.list().partitions[0].active,false);
 await assert.rejects(h.select('enabled'),/选择未生效/);
});

test('an icon on a sibling partition or an enclosing group cannot activate the requested partition',async()=>{
 const enabled=nativeCard(),eligible=nativeCard('流量加速器待开启','7');
 enabled.onClick=()=>{};eligible.setActive(true);
 const group=el('div','',{class:'quick-overdue-filter_group__fixture'}).append(enabled,eligible,el('div','',{class:ICON}));
 const h=fixture(group),parts=h.list().partitions;
 assert.equal(parts.find(part=>part.key==='enabled').active,false);
 assert.equal(parts.find(part=>part.key==='eligible').active,true);
 await assert.rejects(h.select('enabled'),/选择未生效/);
});

test('a lookalike icon outside the native quick-filter card does not mark a generic tag selected',async()=>{
 const tag=el('div','流量加速中',{class:'custom-filter-tag'}).append(el('div','',{class:ICON}));
 tag.onClick=()=>{};const h=fixture(tag);
 assert.equal(h.list().partitions[0].active,false);
 await assert.rejects(h.select('enabled'),/选择未生效/);
});

test('React replacement is re-queried and confirmed through the new native card',async()=>{
 const initial=nativeCard();let replacement;
 initial.onClick=()=>{replacement=nativeCard();replacement.setActive(true);initial.replaceWith(replacement)};
 const h=fixture(initial);
 assert.equal((await h.select('enabled')).key,'enabled');
 assert.equal(initial.getClientRects().length,0);
 assert.equal(replacement.clicks,0);
 assert.equal(h.list().partitions[0].active,true);
});

test('a detached old selected card cannot prove activity after React replaces it with an inactive card',async()=>{
 const initial=nativeCard();let replacement;
 initial.onClick=()=>{initial.setActive(true);replacement=nativeCard();replacement.onClick=()=>{};initial.replaceWith(replacement)};
 const h=fixture(initial);
 await assert.rejects(h.select('enabled'),/选择未生效/);
 assert.equal(initial.getClientRects().length,0);
 assert.equal(h.list().partitions[0].active,false);
});

test('existing aria-selected and CSS-module active tab contracts remain supported',async()=>{
 for(const attrs of [{role:'tab','aria-selected':'true'},{class:'TAB_filterOptionActive__hash'}]){
  const control=el('div','流量加速中',attrs),h=fixture(control);
  assert.equal(h.list().partitions[0].active,true);
  await h.select('enabled');
  assert.equal(control.clicks,0);
 }
 const tab=el('button','流量加速中',{role:'tab','aria-selected':'false'});
 tab.onClick=()=>tab.setAttribute('aria-selected','true');const h=fixture(tab);
 await h.select('enabled');assert.equal(tab.clicks,1);
});

test('product-row controls and modal actions are never discovered or clicked as partitions',async()=>{
 const productButton=el('button','流量加速中'),productCard=nativeCard('流量加速器待开启');
 const row=el('tr').append(el('td').append(productButton,productCard));
 const dialogButton=el('button','Max模式待开启'),dialog=el('div','',{role:'dialog'}).append(dialogButton);
 const h=fixture(row,dialog);
 assert.equal(h.list().partitions.length,0);
 await assert.rejects(h.select('enabled'),/未找到/);
 assert.equal(productButton.clicks+productCard.clicks+dialogButton.clicks,0);
});
