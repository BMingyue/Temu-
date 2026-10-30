/* Current-drawer adapter. No navigation, row-position matching, or automatic retries. */
(() => {
 'use strict';
 const clean=x=>String(x??'').replace(/\s+/g,' ').trim();
 function spec(text){
  const value=clean(text).replace(/\s*当前SKC\s*/g,' ').replace(/^(?:颜色|规格|SKU属性集)\s*[:：]\s*/,'').trim();
  const found=[...value.matchAll(/(\d+(?:\.\d+)?)\s*[*×xX]\s*(\d+(?:\.\d+)?)\s*(cm|in|英寸|厘米)/gi)];
  if(found.length>1)throw Error('尺寸不唯一：'+value);
  if(found.length===1){const m=found[0];return `${Number(m[1])}×${Number(m[2])}${/^(in|英寸)$/i.test(m[3])?'in':'cm'}`}
  if(!value||/[\d]\s*[*×xX]\s*[\d]/.test(value)||value.length>60)throw Error('规格无法识别：'+value);
  return value;
 }
 function cents(value){
  const text=clean(value).replace(/[¥￥,]/g,'');
  if(!/^\d+(?:\.\d{1,2})?$/.test(text)||Number(text)<=0)throw Error('价格必须为正数且最多两位小数：'+text);
  return Math.round(Number(text)*100);
 }
 function columnIndex(headers,...labels){
  const matches=headers.map((x,i)=>labels.some(label=>x===label||x.startsWith(label+'(')||x.startsWith(label+'（'))?i:-1).filter(i=>i>=0);
  if(matches.length!==1)throw Error('无法识别列：'+labels.join('/'));
  return matches[0];
 }
 function selectEligible(rows){
  const selected=[],skipped=[];
  for(const [index,row] of rows.entries()){
   const label=clean(row.spec)||`第 ${index+1} 行`;
   const invalid=/价格已作废|未通过|不通过|已拒绝|审核失败/.test(clean(row.status));
   let hasReference=false;
   try{cents(row.reference);hasReference=true}catch{}
   const reason=invalid?'价格未通过或已作废':!hasReference?'无有效参考申报价':!row.editable?'价格框不可编辑':!row.selected?'未勾选':'';
   if(row.selected&&reason&&reason!=='未勾选')throw Error(`${label} 已勾选，但${reason}；请取消该行勾选后重试`);
   if(reason)skipped.push({index,spec:label,reason});
   else selected.push({...row,index});
  }
  if(!selected.length)throw Error('本窗口没有已勾选且可调价的 SKU；请只勾选价格通过的尺寸');
  return {selected,skipped};
 }
 function selectAutomatic(rows,rules,activity){
  const selected=[],skipped=[],decisions=activity?.state==='ready'?activity.decisions||{}:{};
  for(const [index,row] of rows.entries()){
   const label=clean(row.spec)||`第 ${index+1} 行`;
   let reason='',tier='';
   if(/价格已作废|未通过|不通过|已拒绝|审核失败/.test(clean(row.status)))reason='平台价格未通过或已作废';
   else if(!row.editable)reason='平台价格框不可编辑';
   else{
    const dimension=spec(row.spec),decision=decisions[dimension];
    if(!decision||typeof decision.eligible!=='boolean')reason='活动资格没有明确证据';
    else{
     tier=decision.eligible?'target_daily':'floor';
     const candidate=plan([{...row,index,tier}],rules,'auto')[0];
     if(candidate.target>candidate.old)reason=`目标价 ¥${(candidate.target/100).toFixed(2)} 高于原价，禁止上调`;
     else if(candidate.target===candidate.old)reason='原价已等于目标价，无需调价';
    }
   }
   if(reason)skipped.push({index,spec:label,reason});
   else selected.push({...row,index,tier});
  }
  return {selected,skipped};
 }
 function selectPreset(rows,rules,mode){
  if(!['preset_target_daily','preset_floor'].includes(mode))throw Error('请选择预设价格档位');
  const tier=mode==='preset_floor'?'floor':'target_daily',selected=[],skipped=[];
  for(const [index,row] of rows.entries()){
   const label=clean(row.spec)||`第 ${index+1} 行`;
   let reason='',candidate=null;
   if(/价格已作废|未通过|不通过|已拒绝|审核失败/.test(clean(row.status)))reason='平台价格未通过或已作废';
   else if(!row.editable)reason='平台价格框不可编辑';
   else try{
    candidate=plan([{...row,index}],rules,tier)[0];
    if(candidate.target>candidate.old)reason=`当前价 ¥${(candidate.old/100).toFixed(2)} 低于预设价 ¥${(candidate.target/100).toFixed(2)}，禁止上调`;
    else if(candidate.target===candidate.old)reason='原价已等于目标价，无需调价';
   }catch(e){reason=e.message}
   if(reason)skipped.push({index,spec:candidate?.spec||label,reason,...(candidate?{old:candidate.old,target:candidate.target,tier}:{})});
   else selected.push({...row,index,tier});
  }
  return {selected,skipped};
 }
 function presetPriceWarning(p){
  const blocked=(p?.skipped||[]).filter(row=>Number.isInteger(row.old)&&Number.isInteger(row.target)&&row.target>row.old);
  if(!blocked.length)return '';
  return `以下 ${blocked.length} 个规格当前价格低于店铺预设，按“不允许上调”规则未执行：\n\n`+blocked.map(row=>`${row.spec}：当前 ¥${(row.old/100).toFixed(2)}，预设 ¥${(row.target/100).toFixed(2)}`).join('\n');
 }
 function plan(rows,rules,mode){
  if(!['auto','target_daily','floor'].includes(mode))throw Error('请选择价格档位');
  if(!rows.length)throw Error('请选择调价站点并等待 SKU 表格加载');
  const normalized=new Map();
  for(const [key,rule] of Object.entries(rules||{})){const s=spec(key);if(normalized.has(s))throw Error('工作台存在重复规格规则');normalized.set(s,rule)}
  const seen=new Set();
  return rows.map(row=>{
   const dimension=spec(row.spec),key=row.site+'|'+dimension;
   if(seen.has(key))throw Error('同站点同规格存在多行，无法唯一定位 SKU');seen.add(key);
   if(row.site!=='美国站')throw Error('当前仅适配截图中的美国站，其他站点暂停执行');
   if(row.priceType!=='日常价格')throw Error('只允许调整日常申报价');
   let rule=normalized.get(dimension),matchedSpec=dimension;
   if(!rule){
    const parse=s=>s.match(/^(\d+(?:\.\d+)?)×(\d+(?:\.\d+)?)(cm|in)$/);
    const current=parse(dimension);
    const matches=[...normalized].filter(([key])=>{const size=parse(key);return size&&current&&size[3]===current[3]&&Math.abs(Number(size[1])-Number(current[1]))<=2+1e-9&&Math.abs(Number(size[2])-Number(current[2]))<=2+1e-9});
    if(matches.length>1)throw Error('尺寸浮动范围命中多个预设，请核对：'+dimension);
    if(matches.length===1){matchedSpec=matches[0][0];rule=matches[0][1]}
   }
   if(!rule)throw Error('工作台未设置规格（尺寸每边允许上下浮动2）：'+dimension);
   const tier=mode==='auto'?row.tier:mode;
   if(!['target_daily','floor'].includes(tier))throw Error('活动资格不明确，不能自动选择价格档位');
   const old=cents(row.old),target=cents(rule[tier]);
   return {index:row.index,spec:dimension,matchedSpec,site:row.site,old,target,tier};
  });
 }
 function lowerOnly(items){
  const planned=[],skipped=[];
  for(const item of items){
   if(item.target>=item.old)skipped.push({index:item.index,spec:item.spec,reason:item.target>item.old?'目标价高于原价，禁止上调':'原价已等于目标价，无需调价'});
   else planned.push(item);
  }
  return {planned,skipped};
 }
 function buildPlan(rows,r,chosenMode){
  if(rows.some(row=>row.site!=='美国站'))throw Error('当前窗口含非美国站 SKU，已停止');
  const presetMode=chosenMode==='preset_target_daily'||chosenMode==='preset_floor';
  const choice=chosenMode==='auto'?selectAutomatic(rows,r.size_prices,r.activity):presetMode?selectPreset(rows,r.size_prices,chosenMode):selectEligible(rows);
  const tierMode=presetMode?(chosenMode==='preset_floor'?'floor':'target_daily'):chosenMode;
  const computed=choice.selected.length?plan(choice.selected,r.size_prices,tierMode):[];
  const reduced=lowerOnly(computed),skipped=[...choice.skipped,...reduced.skipped],planned=reduced.planned;
  skipped.sort((a,b)=>a.index-b.index);
  return {planned,skipped};
 }
 const panelView=collapsed=>({label:collapsed?'展开':'收起',width:collapsed?'auto':'340px',padding:collapsed?'7px 10px':'12px',headingHidden:collapsed,left:'16px',bottom:'16px',right:'auto',top:'auto'});
 // Testable pure contract without a browser dependency.
 if(typeof module!=='undefined'&&module.exports){module.exports={spec,cents,columnIndex,selectEligible,selectAutomatic,selectPreset,presetPriceWarning,plan,lowerOnly,buildPlan,panelView};return}
 if(location.pathname!=='/newon/product-select'||document.getElementById('wbPriceWindow'))return;
 const visible=e=>e.getClientRects().length>0&&getComputedStyle(e).visibility!=='hidden';
 const all=(root,selector)=>[...root.querySelectorAll(selector)].filter(visible);
 const exact=(root,selector,text)=>all(root,selector).filter(e=>clean(e.innerText)===text);
 const panel=document.createElement('section');panel.id='wbPriceWindow';
 panel.style.cssText='position:fixed;left:16px;bottom:16px;right:auto;top:auto;z-index:2147483646;background:#fff;border:1px solid #faad80;border-radius:10px;padding:12px;width:340px;max-width:calc(100vw - 32px);box-shadow:0 4px 20px #0002;color:#24364b;font:13px/1.6 sans-serif;max-height:70vh;overflow:auto';
 panel.innerHTML='<div style="display:flex;align-items:center;justify-content:space-between;gap:12px"><strong>工作台 · 当前窗口调价</strong><button type="button" data-collapse aria-expanded="true">收起</button></div><div data-panel-body><div>先核对当前店铺预设。活动资格自动调价仍需活动证据；下面两个预设调价按钮不要求活动资格或参考申报价。仅下调，不上调；调价原因沿用页面当前选择。</div><button type="button" data-load>加载当前店铺预设</button><div data-preset>预设尚未加载</div><button type="button" data-quick style="display:block;width:100%;margin:9px 0;background:#d9480f;color:white;font-weight:700">按活动资格自动调价</button><button type="button" data-preset-target style="width:49%">按预设调活动标价</button> <button type="button" data-preset-floor style="width:49%">按预设调裸跑价</button><div style="margin-top:8px"><select aria-label="调价档位"><option value="auto">按活动资格自动判断</option><option value="preset_target_daily">按预设：活动标价</option><option value="preset_floor">按预设：裸跑价</option></select> <button type="button" data-read>分步读取</button></div><pre style="white-space:pre-wrap"></pre><button type="button" data-fill disabled>分步填入</button> <button type="button" data-submit disabled>分步提交</button></div>';
 document.documentElement.appendChild(panel);
 const output=panel.querySelector('pre'),read=panel.querySelector('[data-read]'),fill=panel.querySelector('[data-fill]'),submit=panel.querySelector('[data-submit]'),quick=panel.querySelector('[data-quick]'),presetTarget=panel.querySelector('[data-preset-target]'),presetFloor=panel.querySelector('[data-preset-floor]'),load=panel.querySelector('[data-load]'),preset=panel.querySelector('[data-preset]'),mode=panel.querySelector('select'),collapse=panel.querySelector('[data-collapse]'),heading=panel.querySelector('strong'),panelBody=panel.querySelector('[data-panel-body]');
 let prepared=null,busy=false;
 function showCollapsed(value){const state=panelView(Boolean(value));panelBody.hidden=Boolean(value);heading.hidden=state.headingHidden;collapse.textContent=state.label;collapse.setAttribute('aria-expanded',String(!value));panel.style.width=state.width;panel.style.padding=state.padding;panel.style.left=state.left;panel.style.bottom=state.bottom;panel.style.right=state.right;panel.style.top=state.top}
 collapse.addEventListener('click',async()=>{const collapsed=!panelBody.hidden;showCollapsed(collapsed);await chrome.storage.local.set({'workbench.price.panel.collapsed':collapsed})});
 chrome.storage.local.get('workbench.price.panel.collapsed').then(saved=>showCollapsed(Boolean(saved['workbench.price.panel.collapsed']))).catch(()=>{});
 function drawerShell(){
  const buttons=exact(document,'button','确认调价');if(buttons.length!==1)throw Error('请打开唯一的“发起调价”窗口');
  let root=buttons[0].parentElement;
  while(root&&root!==document.body){if(/SKC\s*(?:ID)?\s*[:：]\s*\d+/i.test(root.innerText)&&root.innerText.includes('原申报价格'))break;root=root.parentElement}
  if(!root||root===document.body)throw Error('无法隔离调价窗口，已停止');
  const ids=[...root.innerText.matchAll(/SKC\s*(?:ID)?\s*[:：]\s*(\d+)/gi)].map(m=>m[1]);
  if(new Set(ids).size!==1)throw Error('窗口 SKC 不唯一');
  return {root,skc:ids[0],button:buttons[0]};
 }
 async function ensureUsSite(shell){
  const labels=all(shell.root,'label,span,div').filter(e=>clean(e.innerText).replace(/^[*＊]\s*/,'')==='调价站点'&&![...e.children].some(child=>clean(child.innerText).replace(/^[*＊]\s*/,'')==='调价站点'));
  if(labels.length!==1)throw Error('无法唯一定位调价站点，请手动选择美国站');
  let field=labels[0].parentElement,control=null;
  for(let depth=0;field&&field!==shell.root&&depth<4;field=field.parentElement,depth++){
   if(clean(field.innerText).includes('美国站'))return;
   const candidates=all(field,'[role=combobox],.ant-select-selector,[class*="select-selector"],input[readonly]').filter(e=>!e.closest('table'));
   const controls=candidates.filter(e=>!candidates.some(other=>other!==e&&e.contains(other)));
   if(controls.length===1&&(clean(controls[0].value)==='美国站'||clean(controls[0].innerText).includes('美国站')))return;
   if(controls.length===1){control=controls[0];break}
  }
  if(!control)throw Error('无法安全定位站点选择框，请手动选择美国站');
  control.click();
  await new Promise(resolve=>setTimeout(resolve,50));
  const options=all(document,'[role=option],li,[class*="select-item-option"]').filter(e=>clean(e.innerText)==='美国站');
  if(options.length!==1)throw Error('无法唯一定位美国站选项，请手动选择美国站');
  options[0].click();
  await new Promise(resolve=>setTimeout(resolve,50));
  if(!clean(field?.innerText).includes('美国站'))throw Error('美国站未选中，请手动核对调价站点');
 }
 function drawer(shell){
  const {root,skc,button}=shell;
  const tables=all(root,'table').filter(t=>t.innerText.includes('原申报价格')&&t.innerText.includes('调整后申报价格'));
  if(tables.length!==1)throw Error('调价表格结构不受支持');
  const table=tables[0],headers=all(table,'thead th').map(x=>clean(x.innerText));
  const index=(...labels)=>columnIndex(headers,...labels);
  const columns={spec:index('SKU属性集','颜色','规格','SKU规格'),site:index('站点','调价站点'),old:index('原申报价格'),priceType:index('申报价格类型'),status:index('申报价格状态'),reference:index('参考申报价格'),target:index('调整后申报价格')};
  for(let parent=table.parentElement;parent&&parent!==root;parent=parent.parentElement){if(/auto|scroll/.test(getComputedStyle(parent).overflowY)&&parent.scrollHeight>parent.clientHeight+4)throw Error('表格存在未展示行，请完整展开后再执行')}
  const rows=all(table,'tbody tr').map(tr=>{
   const cells=[...tr.children];if(cells.length!==headers.length||cells.some(c=>c.rowSpan>1||c.colSpan>1))throw Error('表格含合并行，暂停执行');
   const inputs=all(cells[columns.target],'input').filter(e=>!['checkbox','hidden'].includes(e.type));
   const checks=all(tr,'input[type=checkbox]');
   if(inputs.length>1||checks.length!==1)throw Error('SKU 行价格框或勾选框不唯一，暂停执行');
   const input=inputs[0]||null;
   return {spec:clean(cells[columns.spec].innerText),site:clean(cells[columns.site].innerText),old:clean(cells[columns.old].innerText),priceType:clean(cells[columns.priceType].innerText),status:clean(cells[columns.status].innerText+' '+cells[columns.target].innerText),reference:clean(cells[columns.reference].innerText),selected:checks[0].checked,editable:Boolean(input&&!input.disabled&&!input.readOnly),check:checks[0],input};
  });
  return {root,skc,rows,button};
 }
 async function rules(skc){const r=await chrome.runtime.sendMessage({type:'WORKBENCH_PRICE_RULES',skc_id:skc});if(!r||r.error)throw Error(r?.error||'本地服务未连接');if(!r.preset_name||!r.size_prices||!Object.keys(r.size_prices).length)throw Error('本地后台尚未加载有效价格预设，请重启工作台并为当前店铺保存预设');return r}
 function showPreset(r){preset.textContent=`已加载：${r.preset_name} · ${r.shop_name} · ${Object.keys(r.size_prices||{}).length} 条规格规则`}
 async function alignSelection(shell,initial,planned){
  const desired=new Set(planned.map(row=>row.index));
  for(let index=0;index<initial.rows.length;index++){
   const refreshed=drawerShell();
   if(refreshed.skc!==shell.skc)throw Error('自动勾选期间 SKC 已变化，请重新读取');
   const current=drawer(refreshed),row=current.rows[index],original=initial.rows[index];
   if(!row||row.spec!==original.spec||row.site!==original.site)throw Error('SKU 行在自动勾选期间变化，请重新读取');
   const want=desired.has(index);
   if(row.selected===want)continue;
   if(row.check.disabled)throw Error(`${row.spec} 的勾选框不可操作，请人工核对`);
   row.check.click();
   await new Promise(resolve=>setTimeout(resolve,0));
  }
  const refreshed=drawerShell();
  if(refreshed.skc!==shell.skc)throw Error('自动勾选期间 SKC 已变化，请重新读取');
  const current=drawer(refreshed);
  if(current.rows.some((row,index)=>row.selected!==desired.has(index)))throw Error('自动勾选未生效，请人工核对');
  return current;
 }
 const signature=p=>JSON.stringify({mall:p.mall,skc:p.skc,preset:p.preset,mode:p.mode,activity:p.mode==='auto'?p.activity:null,rows:p.rows,skipped:p.skipped});
 async function inspect({align=false,selectSite=false}={}){
  let shell=drawerShell();
  if(selectSite){const skc=shell.skc;await ensureUsSite(shell);shell=drawerShell();if(shell.skc!==skc)throw Error('选择站点期间 SKC 已变化，请重新读取')}
  const r=await rules(shell.skc);showPreset(r);
  if(mode.value==='auto'&&r.two_price_mode!==true)throw Error('当前预设未启用两档价格，不能自动判断活动价与裸跑价');
  let d=drawer(shell),choice=buildPlan(d.rows,r,mode.value);
  if(align){d=await alignSelection(shell,d,choice.planned);if(mode.value==='auto'||choice.planned.length)choice=buildPlan(d.rows,r,mode.value)}
  else if(d.rows.some((row,index)=>row.selected!==choice.planned.some(item=>item.index===index)))throw Error('SKU 勾选状态已变化，请重新读取预览');
  return {d,p:{mall:r.mall_id,shop:r.shop_name,preset:r.preset_name,skc:d.skc,mode:mode.value,activity:r.activity,rows:choice.planned,skipped:choice.skipped}};
 }
 function reset(){prepared=null;fill.disabled=true;submit.disabled=true}
 async function run(action){if(busy)return;busy=true;load.disabled=read.disabled=fill.disabled=submit.disabled=quick.disabled=presetTarget.disabled=presetFloor.disabled=true;try{await action()}catch(e){reset();output.textContent='已停止：'+e.message}finally{busy=false;load.disabled=false;read.disabled=false;quick.disabled=presetTarget.disabled=presetFloor.disabled=false}}
 const previewText=p=>`${p.shop} · 美国站 · 预设「${p.preset}」\nSKC ${p.skc}\n${mode.selectedOptions[0].text}${p.mode==='auto'?`\n活动证据：${p.activity?.state==='ready'?'活动 '+p.activity.campaign_id+' · '+p.activity.captured:'不可确定（'+(p.activity?.state||'无记录')+'）'}`:''}\n将调价 ${p.rows.length} 行：\n`+p.rows.map(r=>`${r.spec}${r.matchedSpec!==r.spec?"（匹配预设 "+r.matchedSpec+"）":""}〔${r.tier==='floor'?'裸跑价':'活动前标价'}〕：¥${(r.old/100).toFixed(2)} → ¥${(r.target/100).toFixed(2)}`).join('\n')+(p.skipped.length?'\n跳过 '+p.skipped.length+' 行：\n'+p.skipped.map(r=>`${r.spec}：${r.reason}`).join('\n'):'')+'\n只允许降价；仅提交上述自动勾选的行，不会报名活动。';
 function fillPrepared(d){
  const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
  for(const row of prepared.rows){const input=d.rows[row.index]?.input;if(!input)throw Error('待调价行价格框消失，请重新读取');setter.call(input,(row.target/100).toFixed(2));input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));input.blur()}
 }
 const finalCheck=d=>{if(!prepared.rows.length)throw Error('没有可下调的 SKU，禁止提交');if(d.button.disabled||d.button.getAttribute('aria-disabled')==='true')throw Error('平台不允许提交，请检查调价原因和校验提示');if(prepared.rows.some(r=>r.target>=r.old||cents(d.rows[r.index].input.value)!==r.target))throw Error('价格不符合预览或存在上调，禁止提交')};
 async function durableSubmit(){
  let d=await verify();finalCheck(d);
  const id=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(signature(prepared))))).map(x=>x.toString(16).padStart(2,'0')).join('');
  const receipt=await chrome.runtime.sendMessage({type:'WORKBENCH_PRICE_CLAIM',id,summary:{mall:prepared.mall,skc:prepared.skc,mode:prepared.mode,rows:prepared.rows}});
  if(!receipt?.ok)throw Error(receipt?.error||'无法记录执行，未提交');
  d=await verify();finalCheck(d);d.button.click();reset();
  output.textContent='已点击确认调价。结果待平台核对，不代表价格已生效；本工具不会重复提交这份计划。';
 }
 load.addEventListener('click',()=>run(async()=>{reset();const r=await rules();showPreset(r);output.textContent=`已加载当前店铺预设「${r.preset_name}」，共 ${Object.keys(r.size_prices||{}).length} 条规格规则。请打开“发起调价”窗口，再读取调价预览。`;}));
 mode.addEventListener('change',()=>{reset();output.textContent='档位已变更，请重新读取'});
 read.addEventListener('click',()=>run(async()=>{
  reset();const {p}=await inspect({align:true,selectSite:true});prepared={...p,at:Date.now()};
  output.textContent=previewText(p);fill.disabled=!p.rows.length;
 }));
 async function verify(){if(!prepared||Date.now()-prepared.at>120000)throw Error('预览已过期，请重新读取');const current=await inspect();if(signature(current.p)!==signature(prepared))throw Error('店铺、商品、原价或规则已变化，请重新预览');return current.d}
 fill.addEventListener('click',()=>run(async()=>{
  const d=await verify();
  if(!prepared.rows.length)throw Error('没有可下调的 SKU，禁止填入');
  fillPrepared(d);
  output.textContent+='\n价格已填入，尚未提交。请检查站点、原因和金额。';submit.disabled=false;
 }));
 submit.addEventListener('click',()=>run(async()=>{
  let d=await verify();finalCheck(d);
  if(!window.confirm(output.textContent+'\n\n确认将上述价格提交给 Temu？')){submit.disabled=false;return}
  await durableSubmit();
 }));
 quick.addEventListener('click',()=>run(async()=>{
  mode.value='auto';reset();const {p}=await inspect({align:true,selectSite:true});prepared={...p,at:Date.now()};output.textContent=previewText(p);
  if(!p.rows.length){output.textContent+='\n没有活动资格明确且允许下调的 SKU，未填入、未提交。';return}
  if(!window.confirm(output.textContent+'\n\n将自动填入并提交当前窗口。确定继续？'))return;
  const d=await verify();fillPrepared(d);await durableSubmit();
 }));
 function presetQuick(chosenMode){return run(async()=>{
  mode.value=chosenMode;reset();const {p}=await inspect({align:true,selectSite:true});prepared={...p,at:Date.now()};output.textContent=previewText(p);
  const priceWarning=presetPriceWarning(p);if(priceWarning)window.alert(priceWarning);
  if(!p.rows.length){output.textContent+='\n没有匹配预设且允许下调的 SKU，未填入、未提交。';return}
  if(!window.confirm(output.textContent+'\n\n不依据活动资格，将按当前店铺预设填价并提交一次。确定继续？'))return;
  const d=await verify();fillPrepared(d);await durableSubmit();
 })}
 presetTarget.addEventListener('click',()=>presetQuick('preset_target_daily'));
 presetFloor.addEventListener('click',()=>presetQuick('preset_floor'));
})();
