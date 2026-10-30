/* Exact-scope enrollment executor for an explicitly confirmed local batch. */
(() => {
 'use strict';
 const clean=value=>String(value??'').replace(/\s+/g,' ').trim();
 const normalizeSpec=value=>{const m=clean(value).replace(/厘米/g,'cm').replace(/英寸|inches?/gi,'in').replace(/[xX*✕]/g,'×').match(/(\d+(?:\.\d+)?)\s*×\s*(\d+(?:\.\d+)?)\s*(cm|in)?/i);return m?`${m[1]}×${m[2]}${(m[3]||'').toLowerCase()}`:''};
 const cents=value=>{const text=clean(value).replace(/[¥￥,]/g,'');if(!/^\d+(?:\.\d{1,2})?$/.test(text))throw Error('金额格式无效：'+text);return Math.round(Number(text)*100)};
 const idAfter=(text,label)=>(clean(text).match(new RegExp(`${label}(?:\\s*ID)?\\s*[:：]?\\s*(\\d{6,})`,'i'))||[])[1]||'';
 const bareId=text=>(clean(text).match(/(?:^|\s)(\d{6,})(?:\s|$)/)||[])[1]||'';
 const allSpecs=text=>[...clean(text).replace(/厘米/g,'cm').replace(/英寸|inches?/gi,'in').replace(/[xX*✕]/g,'×').matchAll(/(\d+(?:\.\d+)?)\s*×\s*(\d+(?:\.\d+)?)\s*(cm|in)?/gi)].map(m=>`${m[1]}×${m[2]}${(m[3]||'').toLowerCase()}`).filter((x,i,a)=>a.indexOf(x)===i);
 const prices=(text,label)=>[...clean(text).matchAll(new RegExp(`${label}\\s*[:：]?\\s*(?:¥|￥)?\\s*([0-9,]+(?:\\.[0-9]{1,2})?)`,'g'))].map(m=>m[1]);
 function validateModel(observed,expected){
  if(observed.spuId!==expected.spuId||observed.skcId!==expected.skcId)throw Error('SPU/SKC 与执行清单不一致');
  if(observed.specs.length!==expected.items.length)throw Error(`商品 ${expected.spuId} 的 SKU 数量变化`);
  const wanted=new Map(expected.items.map(item=>[normalizeSpec(item.specification),item]));
  if(wanted.size!==expected.items.length)throw Error('执行清单含重复尺寸');
  for(let i=0;i<observed.specs.length;i++){
   const item=wanted.get(observed.specs[i]);if(!item)throw Error(`商品 ${expected.spuId} 出现未确认尺寸 ${observed.specs[i]}`);
   if(cents(observed.daily[i])!==cents(item.dailyPrice)||cents(observed.reference[i])!==cents(item.referenceActivityPrice))throw Error(`商品 ${expected.spuId} 的 ${observed.specs[i]} 价格已变化`);
  }
  return true;
 }
 if(typeof module!=='undefined'&&module.exports){module.exports={normalizeSpec,cents,validateModel};return}
 if(location.pathname!=='/activity/marketing-activity/detail-new')return;
 const campaignId=()=>new URLSearchParams(location.search).get('thematicId')||new URLSearchParams(location.search).get('activityId')||'';
 const mallId=()=>(document.cookie.match(/(?:^|;\s*)mallid=([^;]+)/)||[])[1]||'';
 const visible=e=>e.getClientRects().length>0&&getComputedStyle(e).visibility!=='hidden';
 const fieldInput=e=>visible(e)&&!e.readOnly&&!['checkbox','hidden','button','submit'].includes(e.type);
 const editable=e=>fieldInput(e)&&!e.disabled;
 const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 const setInput=(input,value)=>{const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')?.set;if(!setter)throw Error('浏览器输入适配不可用');setter.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));input.blur()};
 const panel=document.createElement('section');panel.id='wbEnrollmentStatus';panel.style.cssText='position:fixed;right:20px;bottom:132px;z-index:2147483645;background:#fff;border:1px solid #ee6b2f;border-radius:9px;padding:10px 12px;width:330px;box-shadow:0 4px 18px #0002;color:#27384d;font:13px/1.55 sans-serif';panel.innerHTML='<strong>自动报名连接中</strong><div data-message>等待工作台的已确认批次</div>';document.documentElement.appendChild(panel);
 const message=panel.querySelector('[data-message]');
 function tableContract(){
  const matches=[];
  for(const headerTable of document.querySelectorAll('table')){
   const headers=[...headerTable.querySelectorAll('thead th,thead td')].map(cell=>clean(cell.innerText||cell.textContent));
   const one=label=>{const found=headers.map((x,i)=>x.includes(label)?i:-1).filter(i=>i>=0);return found.length===1?found[0]:-1};
   const columns={product:one('商品信息'),skc:one('SKC'),variants:one('SKU属性集'),price:one('活动申报价格'),stock:one('活动库存')};
   if(!Object.values(columns).every(i=>i>=0))continue;
   const region=headerTable.parentElement?.parentElement;
   const bodies=region?[...region.querySelectorAll('table')].filter(table=>table!==headerTable&&table.querySelector('tbody tr')):[];
   if(bodies.length===1)matches.push({table:bodies[0],headerTable,columns,headers});
  }
  if(matches.length!==1)throw Error(`需要唯一的报名表格，实际识别 ${matches.length} 个`);
  return matches[0];
 }
 const directCells=row=>[...row.children].filter(x=>x.tagName==='TD');
 function parseGroups(contract){
  const rows=[...contract.table.querySelectorAll('tbody tr')],groups=[];
  for(let index=0;index<rows.length;index++){
   const row=rows[index],cells=directCells(row);if(cells.length<contract.headers.length)continue;
   const text=i=>clean(cells[i]?.innerText||cells[i]?.textContent),product=text(contract.columns.product),skc=text(contract.columns.skc);
   const spuId=idAfter(product,'SPU'),skcId=idAfter(skc||clean(row.innerText),'SKC')||bareId(skc);if(!spuId||!skcId)continue;
   const span=Math.max(1,...cells.map(cell=>Number(cell.rowSpan)||1)),parts=rows.slice(index,index+span);
   const specs=[],daily=[],reference=[],priceInputs=[];
   for(let partIndex=0;partIndex<parts.length;partIndex++){
    const partCells=directCells(parts[partIndex]);
    const variantCell=partIndex===0?partCells[contract.columns.variants]:partCells[0];
    const priceCell=partIndex===0?partCells[contract.columns.price]:partCells[1];
    const foundSpecs=allSpecs(clean(variantCell?.innerText||variantCell?.textContent));
    const priceText=clean(priceCell?.innerText||priceCell?.textContent);
    if(foundSpecs.length!==1)throw Error(`商品 ${spuId} 的第 ${partIndex+1} 个尺寸行无法唯一识别`);
    const foundDaily=prices(priceText,'日常价'),foundReference=prices(priceText,'参考价');
    if(foundDaily.length!==1||foundReference.length!==1)throw Error(`商品 ${spuId} 的第 ${partIndex+1} 个价格无法唯一识别`);
    const inputs=[...(priceCell?.querySelectorAll('input')||[])].filter(fieldInput);
    if(inputs.length!==1)throw Error(`商品 ${spuId} 的第 ${partIndex+1} 个活动价输入框无法唯一识别`);
    specs.push(foundSpecs[0]);daily.push(foundDaily[0]);reference.push(foundReference[0]);priceInputs.push(inputs[0]);
   }
   const stockInputs=[...cells[contract.columns.stock].querySelectorAll('input')].filter(fieldInput);
   const checkboxes=[...cells[0].querySelectorAll('input[type=checkbox]')].filter(visible);
   groups.push({row,spuId,skcId,key:spuId+'|'+skcId,specs,daily,reference,priceInputs,stockInputs,checkboxes});
   index+=span-1;
  }
  return groups;
 }
 function scrollerFor(table){
  const candidates=[];for(let e=table;e&&e!==document.body;e=e.parentElement)candidates.push(e);candidates.push(...table.querySelectorAll('*'));
  const usable=[...new Set(candidates)].filter(e=>e.scrollHeight-e.clientHeight>120&&e.clientHeight>180&&e.clientWidth>500&&/SPU\s*ID|日常价/.test(clean(e.innerText||e.textContent))).sort((a,b)=>(b.scrollHeight-b.clientHeight)-(a.scrollHeight-a.clientHeight));
  return usable[0]||null;
 }
 async function walk(contract,callback){
  const scroller=scrollerFor(contract.table),original=scroller?.scrollTop||0,maximum=scroller?scroller.scrollHeight-scroller.clientHeight:0,step=scroller?Math.max(160,Math.floor(scroller.clientHeight*.65)):1;
  const positions=scroller?[...Array(Math.min(260,Math.ceil(maximum/step)+1)).keys()].map(i=>Math.min(i*step,maximum)):[0];if(scroller&&positions.at(-1)!==maximum)positions.push(maximum);
  for(const top of positions){if(scroller){scroller.scrollTop=top;scroller.dispatchEvent(new Event('scroll',{bubbles:true}));await wait(220)}const rows=parseGroups(contract);const counts={};for(const row of rows)counts[row.key]=(counts[row.key]||0)+1;if(Object.values(counts).some(n=>n>1))throw Error('同一 SPU/SKC 同时出现多组，无法唯一定位');await callback(rows)}
  if(scroller){scroller.scrollTop=original;scroller.dispatchEvent(new Event('scroll',{bubbles:true}))}
 }
 async function clearListingFilters(){
  const forms=[...document.querySelectorAll('form')].filter(form=>/ID查询/.test(clean(form.innerText))&&[...form.querySelectorAll('button')].some(button=>clean(button.innerText)==='查询'));
  if(forms.length!==1)throw Error(`商品查询区无法唯一识别（${forms.length}）`);
  const form=forms[0],filters=()=>[...form.querySelectorAll('input[type=text]')].filter(input=>input.placeholder==='请选择'||/多个请/.test(input.placeholder));
  if(!filters().some(input=>clean(input.value)))return;
  const reset=[...form.querySelectorAll('button')].filter(button=>visible(button)&&clean(button.innerText)==='重置');
  if(reset.length!==1)throw Error('查询重置按钮无法唯一识别');
  reset[0].click();await wait(1200);
  if(filters().some(input=>clean(input.value)))throw Error('商品查询条件未能清空');
 }
 function searchControls(){
  const forms=[...document.querySelectorAll('form')].filter(form=>/ID查询/.test(clean(form.innerText))&&[...form.querySelectorAll('button')].some(button=>clean(button.innerText)==='查询'));
  if(forms.length!==1)throw Error(`商品查询区无法唯一识别（${forms.length}）`);
  const form=forms[0],mode=[...form.querySelectorAll('input[type=text]')].find(input=>clean(input.value)==='SPU ID');
  const queries=[...form.querySelectorAll('input[type=text]')].filter(input=>/多个请/.test(input.placeholder));
  const searches=[...form.querySelectorAll('button')].filter(button=>visible(button)&&clean(button.innerText)==='查询');
  if(!mode||queries.length!==2||searches.length!==1)throw Error('SPU 查询控件结构不受支持');
  return {query:queries[0],search:searches[0]};
 }
 async function queryProduct(expected){
  const controls=searchControls();if(clean(controls.query.value)!==expected.spuId)setInput(controls.query,expected.spuId);controls.search.click();
  let lastKeys=[];
  for(let attempt=0;attempt<30;attempt++){
   await wait(200);
   try{const contract=tableContract(),groups=parseGroups(contract);lastKeys=groups.map(group=>group.key);const exact=groups.filter(group=>group.key===expected.product_key);if(exact.length===1)return {contract,row:exact[0]};if(exact.length>1)throw Error(`商品 ${expected.spuId} 查询结果不唯一`)}catch(error){if(attempt===29)throw error}
  }
  throw Error(`查询 SPU ${expected.spuId} 后未找到目标 SKC ${expected.skcId}；页面返回 ${lastKeys.join('、')||'空结果'}`);
 }
 async function waitEnabled(expected){
  for(let attempt=0;attempt<20;attempt++){
   await wait(100);
   const contract=tableContract(),row=parseGroups(contract).find(item=>item.key===expected.product_key);
   if(row&&row.checkboxes[0]?.checked&&row.priceInputs.length===row.specs.length&&row.stockInputs.length===1&&row.priceInputs.every(editable)&&editable(row.stockInputs[0]))return row;
  }
  throw Error(`商品 ${expected.spuId} 勾选后输入框仍不可用`);
 }
 const selectedCount=()=>Number((clean(document.body.innerText).match(/已选\s*(\d+)\s*个商品/)||[])[1]||0);
 async function cleanup(command){
  for(const expected of command.products){
   try{const {row}=await queryProduct(expected),bySpec=new Map(expected.items.map(item=>[normalizeSpec(item.specification),item]));for(let i=0;i<row.specs.length;i++){const item=bySpec.get(row.specs[i]);if(item&&clean(row.priceInputs[i]?.value)&&cents(row.priceInputs[i].value)===cents(item.activityPrice)&&editable(row.priceInputs[i]))setInput(row.priceInputs[i],'')}if(clean(row.stockInputs[0]?.value)===String(expected.inventory)&&editable(row.stockInputs[0]))setInput(row.stockInputs[0],'');if(row.checkboxes[0]?.checked)row.checkboxes[0].click()}catch{}}
  await clearListingFilters().catch(()=>{});
 }
 async function report(command,status,text){return chrome.runtime.sendMessage({type:'WORKBENCH_ENROLLMENT_REPORT',campaign_id:command.campaign_id,mall_id:command.mall_id,id:command.id,claim_token:command.claim_token,status,message:text})}
 function exactButtons(text){return [...document.querySelectorAll('button')].filter(e=>visible(e)&&!e.closest('#wbEnrollmentStatus')&&clean(e.innerText||e.textContent)===text)}
 async function execute(command){
  message.textContent=`正在核对 ${command.products.length} 个商品…`;
  let attempted=false,mutated=false;
  try{
   if(command.campaign_id!==campaignId()||command.mall_id!==mallId())throw Error('当前店铺或活动与执行清单不一致');
   await clearListingFilters();
   const wanted=new Map(command.products.map(product=>[product.product_key,product]));if(wanted.size!==command.products.length)throw Error('执行清单包含重复商品');
   if(selectedCount()!==0)throw Error('页面已有勾选商品，请先清空后重新执行');
   const seen=new Set();
   for(const expected of command.products){const {row}=await queryProduct(expected);validateModel(row,expected);if(row.priceInputs.length!==row.specs.length||row.stockInputs.length!==1||row.checkboxes.length!==1)throw Error(`商品 ${row.spuId} 的输入框或勾选框结构不受支持`);seen.add(row.key);message.textContent=`只读核对商品 ${seen.size}/${wanted.size}…`}
   if(seen.size!==wanted.size)throw Error(`仅定位到 ${seen.size}/${wanted.size} 个商品，未执行`);
   const filled=new Set();message.textContent='页面结构通过，正在填写活动价和库存…';
   for(const expected of command.products){let {row}=await queryProduct(expected);validateModel(row,expected);if(!row.checkboxes[0].checked){row.checkboxes[0].click();mutated=true}row=await waitEnabled(expected);validateModel(row,expected);const bySpec=new Map(expected.items.map(item=>[normalizeSpec(item.specification),item]));for(let i=0;i<row.specs.length;i++){const target=Number(cents(bySpec.get(row.specs[i]).activityPrice)/100).toFixed(2),current=clean(row.priceInputs[i].value);if(current&&cents(current)!==cents(target))throw Error(`商品 ${row.spuId} 已填写其他活动价，未覆盖`);if(!current){setInput(row.priceInputs[i],target);mutated=true}}const stock=String(expected.inventory),currentStock=clean(row.stockInputs[0].value);if(currentStock&&Number(currentStock)!==expected.inventory)throw Error(`商品 ${row.spuId} 已填写其他库存，未覆盖`);if(!currentStock){setInput(row.stockInputs[0],stock);mutated=true}filled.add(row.key);await wait(100);if(selectedCount()!==filled.size)throw Error(`页面已选商品数 ${selectedCount()}，预期 ${filled.size}`)}
   if(filled.size!==wanted.size)throw Error('未能填完全部商品');
   const verified=new Set();message.textContent='正在复核已填金额、库存和勾选…';
   for(const expected of command.products){const {row}=await queryProduct(expected);validateModel(row,expected);const bySpec=new Map(expected.items.map(item=>[normalizeSpec(item.specification),item]));if(!row.checkboxes[0]?.checked||row.stockInputs.length!==1||Number(row.stockInputs[0].value)!==expected.inventory||row.priceInputs.some((input,i)=>cents(input.value)!==cents(bySpec.get(row.specs[i]).activityPrice)))throw Error(`商品 ${row.spuId} 填写复核失败`);verified.add(row.key)}
   if(verified.size!==wanted.size)throw Error('复核时未找到全部商品');
   const chosen=selectedCount();if(chosen!==wanted.size)throw Error(`页面显示已选 ${chosen} 个，与计划 ${wanted.size} 个不一致`);
   const submit=exactButtons('提交');if(submit.length!==1||submit[0].disabled||submit[0].getAttribute('aria-disabled')==='true')throw Error('提交按钮不唯一或当前不可用');
   message.textContent=`复核通过：${wanted.size} 个商品。正在提交…`;submit[0].click();attempted=true;
   await report(command,'submission_attempted',`已点击提交：${wanted.size} 个商品，${command.products.reduce((n,p)=>n+p.items.length,0)} 个 SKU`);
   await wait(500);
   const dialogs=[...document.querySelectorAll('[role=dialog],.semi-modal,.ant-modal,.arco-modal')].filter(visible);if(dialogs.length===1){const text=clean(dialogs[0].innerText);if(/协议|条款|授权/.test(text))throw Error('平台出现协议或授权确认，请人工处理，未自动确认');if(/确认.*(?:报名|提交)|(?:报名|提交).*确认/.test(text)){const confirms=[...dialogs[0].querySelectorAll('button')].filter(e=>visible(e)&&/^(确认|确定|继续提交)$/.test(clean(e.innerText)));if(confirms.length!==1)throw Error('平台二次确认按钮不唯一');confirms[0].click()}}
   const started=Date.now();let feedback='';while(Date.now()-started<20000){await wait(500);const texts=[...document.querySelectorAll('[role=alert],[role=dialog],.semi-toast,.semi-message,.ant-message,.arco-message')].filter(visible).map(e=>clean(e.innerText)).filter(Boolean);feedback=texts.find(t=>/(成功|失败|错误|已报名|提交)/.test(t))||'';if(feedback)break}
   if(/成功|已报名/.test(feedback)){await report(command,'platform_acknowledged',feedback);message.textContent='平台已返回成功提示：'+feedback}
   else if(/失败|错误|不允许|不可/.test(feedback)){await report(command,'platform_rejected',feedback);message.textContent='平台未接受：'+feedback}
   else{await report(command,'submitted_unverified','已提交但 20 秒内未识别到明确平台结果，请人工核对，禁止自动重试');message.textContent='已提交，未识别到明确结果；请人工核对，工具不会重试。'}
  }catch(error){const text=String(error.message||error);if(!attempted){if(mutated)await cleanup(command).catch(()=>{});else await clearListingFilters().catch(()=>{})}await report(command,attempted?'submitted_unverified':'preflight_failed',attempted?'已点击提交后出现异常：'+text:text).catch(()=>{});message.textContent=(attempted?'提交结果不明确，请人工核对：':mutated?'已停止并清理本轮填写：':'已停止：')+text}
 }
 let busy=false;
 async function poll(){if(busy)return;try{const response=await chrome.runtime.sendMessage({type:'WORKBENCH_ENROLLMENT_POLL',campaign_id:campaignId(),mall_id:mallId()});if(response?.command){busy=true;await execute(response.command)}}catch(error){message.textContent='本地报名连接失败：'+String(error.message||error)}finally{busy=false}}
 setInterval(poll,3000);poll();
})();
