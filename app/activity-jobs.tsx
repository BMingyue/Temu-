'use client';
import {useEffect,useState} from 'react';
import {Button} from '@/components/ui/button';

import {BatchSelectionTools,useBatchSelection} from './batch-selection';
type Row=Record<string,any>;
type Rule={spec:string;floor:string;target:string;min:string;max:string};
const money=(value:any)=>value==null||value===''?'—':`¥${Number(value).toFixed(2)}`;
const activityPrice=(bare:any)=>{const value=Number(bare);return Number.isFinite(value)&&value>0?(Math.ceil(value/0.75*100)/100).toFixed(2):''};
const versionAtLeast=(actual:any,minimum:string)=>{
 const a=String(actual||'').split('.').map(Number),b=minimum.split('.').map(Number);
 for(let i=0;i<3;i++){if((a[i]||0)!==(b[i]||0))return (a[i]||0)>(b[i]||0)}
 return true;
};
async function api(path:string,body?:Row){
 const response=await fetch('/api/activity-jobs/'+path,body?{method:'POST',headers:{'Content-Type':'application/json','X-Workbench':'local'},body:JSON.stringify(body)}:undefined);
 const value=await response.json() as Row;if(!response.ok)throw Error(value.error||'请求失败');return value;
}
async function enrollmentApi(path:string,body?:Row){
 const response=await fetch('/api/activity-enrollment/'+path,body?{method:'POST',headers:{'Content-Type':'application/json','X-Workbench':'local'},body:JSON.stringify(body)}:undefined);
 const value=await response.json() as Row;if(!response.ok)throw Error(value.error||'报名请求失败');return value;
}
function fullReadyGroups(rows:Row[]){
 const groups=new Map<string,Row[]>();for(const row of rows){const key=row.spuId+'|'+row.skcId;groups.set(key,[...(groups.get(key)||[]),row])}
 return [...groups.entries()].filter(([,items])=>items.length>0&&items.every(item=>item.precheck?.status==='ready')).map(([key,items])=>({key,items}));
}
function priceGroups(rows:Row[]){
 const groups=new Map<string,Row[]>();for(const row of rows){const key=row.spuId+'|'+row.skcId;groups.set(key,[...(groups.get(key)||[]),row])}
 return [...groups.entries()].map(([key,items])=>({key,items}));
}
export default function ActivityJobs({preferredMall=''}:{preferredMall?:string}){
 const [data,setData]=useState<Row|null>(null),[mall,setMall]=useState(''),[campaign,setCampaign]=useState(''),[query,setQuery]=useState('');
 const [rules,setRules]=useState<Rule[]>([]),[config,setConfig]=useState<Row>({}),[ready,setReady]=useState(false);
 const [busy,setBusy]=useState(false),[message,setMessage]=useState(''),[error,setError]=useState('');
 const [showBlocked,setShowBlocked]=useState(false);
 const [priceView,setPriceView]=useState<'all'|'needs_adjustment'|'bare'|'ready'|'blocked'|'pending'>('all');
 const [presetName,setPresetName]=useState(''),[selectedPreset,setSelectedPreset]=useState('');
 const [naming,setNaming]=useState(false),[saveError,setSaveError]=useState('');
 function beginSave(){setSaveError('');setError('');setNaming(true)}
 const statePath=(value=mall)=>'state'+(value?'?mall_id='+encodeURIComponent(value):'');
 async function loadPreset(name:string){const p=data?.price_presets?.find((p:Row)=>p.name===name);if(!p)return;const next={...p.config,two_price_mode:true,category:p.config.category||(name.includes('毛毯')?'毛毯':name.includes('地垫')?'地垫':'未分类')};setSelectedPreset(name);setPresetName(name);setConfig(next);setRules(Object.entries(p.config.size_prices||{}).map(([spec,r]:[string,any])=>({spec,floor:String(r.floor??''),target:String(r.target_daily??activityPrice(r.floor)),min:'',max:''})));setBusy(true);setError('');try{const result=await api('settings',{mall_id:mall,preset_name:name,config:next});setConfig(result.activity_settings);setData(await api(statePath()));setMessage('已为当前店铺切换到「'+name+'」，商品已重新筛选。')}catch(e:any){setError(e.message)}finally{setBusy(false)}}
 const [selectedProducts,setSelectedProducts]=useState<string[]>([]),[enrollmentPreview,setEnrollmentPreview]=useState<Row|null>(null),[enrollmentState,setEnrollmentState]=useState<Row|null>(null);
 async function refresh(){setBusy(true);setError('');try{setData(await api(statePath()))}catch(e:any){setError(e.message)}finally{setBusy(false)}}
 useEffect(()=>{refresh()},[]);
 useEffect(()=>{if(data&&!ready){const saved=data.activity_settings||data.default_config;const name=data.active_preset||'';setConfig({...saved,two_price_mode:true,category:saved.category||(name.includes('毛毯')?'毛毯':name.includes('地垫')?'地垫':'未分类')});setPresetName(name);setSelectedPreset(name);setRules(Object.entries(saved.size_prices||{}).map(([spec,r]:[string,any])=>({spec,floor:String(r.floor??''),target:String(r.target_daily??activityPrice(r.floor)),min:'',max:''})));setMall(preferredMall||data.evidence?.[0]?.mall_id||data.shops?.[0]?.mall_id||'');setReady(true)}},[data,ready,preferredMall]);
 useEffect(()=>{if(ready&&preferredMall)setMall(preferredMall)},[preferredMall,ready]);
 useEffect(()=>{if(!ready||!mall)return;let live=true;api(statePath(mall)).then(value=>{if(!live)return;setData(value);const saved=value.activity_settings||value.default_config,name=value.active_preset||'';setConfig({...saved,two_price_mode:true,category:saved.category||(name.includes('毛毯')?'毛毯':name.includes('地垫')?'地垫':'未分类')});setPresetName(name);setSelectedPreset(name);setRules(Object.entries(saved.size_prices||{}).map(([spec,r]:[string,any])=>({spec,floor:String(r.floor??''),target:String(r.target_daily??activityPrice(r.floor)),min:'',max:''})))}).catch(e=>{if(live)setError(e.message)});return()=>{live=false}},[mall,ready]);
 useEffect(()=>{if(!ready||!mall)return;let live=true,loading=false;const load=async()=>{if(document.hidden||loading||busy)return;loading=true;try{const value=await api(statePath(mall));if(live)setData(value)}catch(e:any){if(live)setError(e.message)}finally{loading=false}};const timer=setInterval(load,15000);window.addEventListener('focus',load);return()=>{live=false;clearInterval(timer);window.removeEventListener('focus',load)}},[mall,ready,busy]);
 useEffect(()=>{if(!mall)return;let live=true;const load=()=>enrollmentApi('state?mall_id='+encodeURIComponent(mall)).then(value=>{if(live)setEnrollmentState(value)}).catch(()=>{});load();const timer=setInterval(load,3000);return()=>{live=false;clearInterval(timer)}},[mall]);
 const evidence=(data?.evidence||[]).filter((row:Row)=>row.mall_id===mall);
 const campaigns=evidence.filter((row:Row,index:number)=>evidence.findIndex((item:Row)=>item.campaign_id===row.campaign_id)===index) as Row[];
 const latest=campaign?evidence.find((row:Row)=>row.campaign_id===campaign):(campaigns.find((row:Row)=>(row.payload.evaluated_candidates||[]).length>0)||evidence[0]);
 const allCandidates:Row[]=latest?.payload?.evaluated_candidates||latest?.payload?.candidates||[];
 // A preset is also the category filter.  For the current catalog, blanket
 // rules are inch-based and mat rules are centimetre-based; an unconfigured
 // size with the same unit stays visible as "资料不足", while the other
 // category is hidden completely.
 const candidates:Row[]=allCandidates.filter(row=>row.precheck?.categoryMatched!==false);
 const pending:Row[]=latest?.payload?.unresolved_candidates||[];
 const products=new Set(candidates.map(row=>row.spuId)).size;
 const totalProducts=new Set([...allCandidates,...pending].map(row=>row.spuId)).size;
 const scannedSkuCount=allCandidates.length+pending.length;
 const excludedCategoryCount=allCandidates.length-candidates.length;
 const matches=(row:Row)=>[row.spuId,row.skcId,row.skuId,row.specification].join(' ').toLowerCase().includes(query.toLowerCase());
 const passed=candidates.filter(row=>row.precheck?.eligible===true);
 const bare=candidates.filter(row=>row.precheck?.priceState==='bare');
 const needsAdjustment=candidates.filter(row=>row.precheck?.status==='needs_adjustment');
 const blocked=candidates.filter(row=>row.precheck?.status==='blocked');
 const awaiting=candidates.filter(row=>!row.precheck||row.precheck.status==='pending');
 const unavailable=Boolean(latest&&!latest.payload.evaluated_candidates);
 const readyGroups=fullReadyGroups(candidates).filter(group=>!pending.some((row:Row)=>row.spuId===group.items[0].spuId&&(!row.skcId||row.skcId===group.items[0].skcId))),safeRows=readyGroups.flatMap(group=>group.items);
 const readyGroupKeys=new Set(readyGroups.map(group=>group.key));
 const shown=safeRows.filter(matches),shownGroups=readyGroups.filter(group=>group.items.some(matches));
 const filteredPriceRows=candidates.filter(row=>(priceView==='all'||row.precheck?.priceState===priceView)&&matches(row));
 const shownPriceGroups=priceGroups(filteredPriceRows);
 const copyBatch=useBatchSelection(shownPriceGroups,JSON.stringify([mall,latest?.id,priceView,query,config.category]),group=>group.key);
 const groupSignature=readyGroups.map(group=>group.key).join('|');
 useEffect(()=>{setSelectedProducts(['毛毯','地垫'].includes(config.category)?readyGroups.map(group=>group.key):[]);setEnrollmentPreview(null)},[latest?.id,groupSignature,config.category]);
 const visibleCampaigns=campaigns.filter(row=>showBlocked||(row.payload.evaluated_candidates||[]).length>0);
 const latestBatch=enrollmentState?.batches?.find((batch:Row)=>!campaign||batch.campaign_id===(latest?.campaign_id||campaign));
 const enrollmentClient=enrollmentState?.clients?.find((client:Row)=>client.campaign_id===(latest?.campaign_id||campaign));
 const executorOnline=Boolean(enrollmentClient&&Date.now()-new Date(enrollmentClient.last_seen).getTime()<12000);
 const executorVersionOK=executorOnline&&versionAtLeast(enrollmentClient?.collector_version,'0.15.1');
 function exportCandidates(){
  const rows=[['活动','SPU','SKC','SKU','尺寸','当前价格','平台活动参考价'],...shown.map(row=>[latest?.campaign_id,row.spuId,row.skcId,row.skuId,row.specification,row.dailyPrice,row.precheck?.plannedActivityPrice])];
  const cell=(value:any)=>{let text=String(value??'');if(/^[=+@\-\t\r]/.test(text))text="'"+text;return '"'+text.replace(/"/g,'""')+'"'};
  const url=URL.createObjectURL(new Blob(['\uFEFF'+rows.map(row=>row.map(cell).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'}));
  const link=document.createElement('a');link.href=url;link.download='报名候选-'+(latest?.campaign_id||'')+'.csv';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  setMessage(`已导出当前显示的 ${shown.length} 个候选 SKU，未向平台提交报名。`);
 }
 async function prepareEnrollment(){setBusy(true);setError('');setMessage('');try{
  if(!latest)throw Error('请先选择活动');
  const result=await enrollmentApi('prepare',{mall_id:mall,campaign_id:latest.campaign_id,product_keys:selectedProducts});setEnrollmentPreview(result);setMessage(`报名预览已生成：${result.product_count} 个商品、${result.sku_count} 个 SKU。尚未提交。`);
 }catch(e:any){setError(e.message)}finally{setBusy(false)}}
 async function startEnrollment(){setBusy(true);setError('');setMessage('');try{
  if(!enrollmentPreview)throw Error('请先生成报名预览');
  const details=enrollmentPreview.products.map((product:Row)=>`SPU ${product.spuId}：${product.items.length} 个 SKU，库存 ${product.inventory}`).join('\n');
  if(!window.confirm(`将向 Temu 提交 ${enrollmentPreview.product_count} 个商品、${enrollmentPreview.sku_count} 个 SKU 的活动报名：\n\n${details}\n\n活动价采用本次平台参考价，库存采用参考库存。确定开始？`))return;
  await enrollmentApi('enqueue',{batch_id:enrollmentPreview.id,confirmation:`确认报名${enrollmentPreview.product_count}个商品`});setEnrollmentPreview(null);setMessage('已发送到当前活动页。扩展会再次核对 SPU、SKC、全部 SKU、价格和库存后提交；结果不明不会重试。');setEnrollmentState(await enrollmentApi('state?mall_id='+encodeURIComponent(mall)));
 }catch(e:any){setError(e.message)}finally{setBusy(false)}}
 async function save(){setBusy(true);setError('');setSaveError('');setMessage('');try{
  const size_prices:Row=Object.create(null);
  for(const rule of rules){if(!rule.spec.trim()||!rule.floor||!rule.target)throw Error('请填写尺寸、裸跑价和活动标价');if(size_prices[rule.spec.trim()])throw Error('尺寸不能重复');size_prices[rule.spec.trim()]={floor:rule.floor,target_daily:rule.target,match_min:null,match_max:null}}
  if(!presetName.trim())throw Error('请填写预设名称，例如毛毯、地垫或男T恤');
  const category=String(config.category||'').trim(),effectiveCategory=category&&category!=='未分类'?category:presetName.trim();
  const result=await api('settings',{mall_id:mall,preset_name:presetName.trim(),config:{...config,category:effectiveCategory,two_price_mode:true,discount_rate:'0.75',price_match:{field:'dailyPrice'},size_prices}});setConfig(result.activity_settings);setData(await api(statePath()));setSelectedPreset(presetName.trim());setNaming(false);setMessage('预设「'+presetName.trim()+'」已保存到当前店铺并使用，已按两档价格重新筛选；平台价格未改动。');
 }catch(e:any){setError(e.message);setSaveError(e.message)}finally{setBusy(false)}}
 return <>
  {naming&&<div style={{position:'fixed',inset:0,background:'rgba(0,0,0,.4)',zIndex:1000,display:'flex',alignItems:'center',justifyContent:'center'}}><section role="dialog" aria-modal="true" aria-labelledby="preset-dialog-title" className="panel" style={{width:460,maxWidth:'90vw',margin:0}}><h2 id="preset-dialog-title">保存两档价格预设</h2><p>每套预设保存类目、规格、裸跑价和活动标价。未填写类目时使用预设名称。</p><form onSubmit={e=>{e.preventDefault();save()}}><label className="field"><span>预设名称</span><input autoFocus aria-label="预设名称" value={presetName} maxLength={60} placeholder="例如：毛毯、地垫、男T恤" onChange={e=>setPresetName(e.target.value)} disabled={busy}/></label>{data?.price_presets?.some((p:Row)=>p.name===presetName.trim())&&<p>将更新已有预设「{presetName.trim()}」。修改名称可另存一套。</p>}{saveError&&<p role="alert" className="banner danger">{saveError}</p>}<div className="buttons"><Button type="submit" disabled={busy||!presetName.trim()}>{busy?'正在保存…':'确认保存并使用'}</Button><Button type="button" variant="outline" disabled={busy} onClick={()=>setNaming(false)}>取消</Button></div></form></section></div>}
  {error&&<div className="banner danger">{error}</div>}{message&&<div className="banner success">{message}</div>}
  <section className="panel">
   <div className="sectionhead"><div><h2>{config.category&&config.category!=='未分类'?`${config.category}：`:''}{products} 个商品 · {candidates.length} 个已识别 SKU</h2><p>{latest?`最近读取：${new Date(latest.captured).toLocaleString('zh-CN')}，本次活动扫描 ${totalProducts} 个商品、${scannedSkuCount} 个 SKU；成功识别 ${allCandidates.length} 个，待核对 ${pending.length} 个。`:'尚未读取活动商品。请在活动页完成采集后刷新。'}{excludedCategoryCount?` 已按「${config.category}」预设隐藏其他类目 ${excludedCategoryCount} 个 SKU。`:''}</p></div><Button variant="outline" disabled={busy} onClick={refresh}>刷新数据</Button></div>
   <div className="formgrid"><label className="field"><span>店铺</span><select value={mall} onChange={e=>{setMall(e.target.value);setCampaign('')}}>{mall&&!data?.shops?.some((shop:Row)=>shop.mall_id===mall)&&<option value={mall}>当前浏览器店铺 · {mall}（等待首次同步）</option>}{data?.shops?.map((shop:Row)=><option key={shop.mall_id} value={shop.mall_id}>{shop.name||shop.mall_id}</option>)}</select></label><label className="field"><span>需要处理的活动</span><select value={campaign} onChange={e=>setCampaign(e.target.value)}><option value="">{visibleCampaigns.length?'自动选择最近有商品的活动':'暂无读取到商品的活动'}</option>{visibleCampaigns.map(row=><option key={row.campaign_id} value={row.campaign_id}>{row.payload.campaign_name||row.campaign_id}</option>)}</select></label></div>
   <label><input type="checkbox" checked={showBlocked} onChange={e=>{setShowBlocked(e.target.checked);setCampaign('')}}/> 显示没有读取到商品的历史活动</label>
   {unavailable?<p className="banner danger">后台版本未更新，尚未取得预检结果。这不代表商品不能报名。请点击右上角重启工作台。</p>:<p className="panelnote">当前预设：{data?.active_preset||config.category||'未分类'} · 按当前规格规则筛选：两档均不符 {needsAdjustment.length} 个 SKU · 裸跑价已就位 {bare.length} 个 SKU · 活动价核价通过 {passed.length} 个 SKU · 可整件一键报名 {readyGroups.length} 个商品 / {safeRows.length} 个 SKU · 不可报名 {blocked.length} 个 SKU · 资料不足 {awaiting.length} 个 SKU。{!['毛毯','地垫','未分类'].includes(config.category)?'文字规格可能被不同类目的商品共用；报名时请核对 SPU。':''}</p>}
   <div className="buttons">{([['all','全部'],['needs_adjustment','两档均不符'],['bare','裸跑价已就位'],['ready','活动价可报名'],['blocked','不可报名'],['pending','资料不足']] as const).map(([key,label])=><Button key={key} variant={priceView===key?'default':'outline'} onClick={()=>setPriceView(key)}>{label}（{key==='all'?candidates.length:key==='needs_adjustment'?needsAdjustment.length:key==='bare'?bare.length:key==='ready'?passed.length:key==='blocked'?blocked.length:awaiting.length}）</Button>)}</div>
   <div className="tabletools"><input aria-label="搜索 SKU 或尺寸" placeholder="搜索商品、SKU 或尺寸" value={query} onChange={e=>setQuery(e.target.value)}/></div>
 
   <BatchSelectionTools selection={copyBatch} total={shownPriceGroups.length} label="活动核价" copyFields={[{label:'SPU',value:group=>group.items[0].spuId},{label:'SKC',value:group=>group.items[0].skcId},{label:'SKU',value:group=>group.items.map(row=>row.skuId)}]} columns={[{label:'SPU',value:group=>group.items[0].spuId},{label:'SKC',value:group=>group.items[0].skcId},{label:'SKU',value:group=>group.items.map(row=>row.skuId).join('；')},{label:'规格',value:group=>group.items.map(row=>row.specification).join('；')},{label:'当前价',value:group=>group.items.map(row=>money(row.dailyPrice)).join('；')},{label:'核价状态',value:group=>group.items.map(row=>row.precheck?.priceStateLabel||'待核对').join('；')}]}/>
   {shownPriceGroups.length?<div className="tablewrap"><table><thead><tr><th>复制</th><th>商品</th><th>SKU / 尺寸</th><th>当前日常价</th><th>应调活动标价</th><th>75 折后 / 裸跑价</th><th>核价结果</th></tr></thead><tbody>{copyBatch.visibleRows.map(group=>{const first=group.items[0],wholeProductReady=readyGroupKeys.has(group.key);return <tr key={group.key}><td><input type="checkbox" aria-label={`复制选择 SPU ${first.spuId} SKC ${first.skcId||'未读取'}`} checked={copyBatch.isSelected(group)} onChange={e=>copyBatch.toggle(group,e.target.checked)}/></td><td><strong>SPU {first.spuId}</strong><small>SKC {first.skcId||'未读取'}</small></td><td>{group.items.map((row,index)=><small key={`${row.skuId||row.specification}-${index}`}>SKU {row.skuId||'未读取'} · {row.specification}</small>)}</td><td>{group.items.map((row,index)=><small key={index}>{money(row.dailyPrice)}</small>)}</td><td>{group.items.map((row,index)=><small key={index}>{money(row.precheck?.targetDailyPrice)}</small>)}</td><td>{group.items.map((row,index)=><small key={index}>{money(row.precheck?.expectedActivityPrice)} / {money(row.precheck?.barePrice)}</small>)}</td><td>{group.items.map((row,index)=>{const reason=[...(row.precheck?.blockedReasons||[]),...(row.precheck?.pendingReasons||[])].join('；'),label=row.precheck?.priceState==='ready'?(wholeProductReady?'可一键报名':'活动价符合，等待同商品其他 SKU'):row.precheck?.priceStateLabel||'待核对',state=row.precheck?.priceState,tagClass=state==='ready'||state==='bare'?'green':state==='needs_adjustment'?'amber':'red';return <small key={index}><span title={reason} className={'tag '+tagClass}>{label}</span>{reason&&<span title={reason}> · {reason}</span>}</small>})}</td></tr>})}</tbody></table></div>:<p className="panelnote">当前类目和筛选条件下没有商品。</p>}
   <p className="panelnote">复制范围是当前筛选中勾选的商品；编号去重后每行一个。切换店铺、活动或筛选条件时会清空复制勾选。</p>
   <div className="buttons"><a className="external" href="https://agentseller.temu.com/newon/product-select" target="_blank" rel="noreferrer">打开商品调价页 ↗</a><Button variant="outline" onClick={()=>setPriceView('needs_adjustment')}>筛出两档均不符（{needsAdjustment.length}）</Button><Button variant="outline" onClick={()=>setPriceView('bare')}>筛出裸跑价已就位（{bare.length}）</Button></div>
   <p className="panelnote">在商品调价页打开某个 SKC 的“发起调价”窗口，右上角工具点击“一键调成活动标价”；提交前仍会显示价格确认。</p>
   <h3>第二步：一键报名整件全部 SKU 均符合的商品</h3>
   <div className="buttons"><Button variant="outline" disabled={!readyGroups.length||busy} onClick={()=>setSelectedProducts(selectedProducts.length===readyGroups.length?[]:readyGroups.map(group=>group.key))}>{selectedProducts.length===readyGroups.length?'取消全选':'全选可报名'}（{readyGroups.length} 个商品）</Button><Button disabled={!selectedProducts.length||busy||unavailable} onClick={prepareEnrollment}>生成一键报名预览（{selectedProducts.length} 个商品）</Button><Button variant="outline" disabled={!shown.length||busy} onClick={exportCandidates}>导出对应 SKU（{shown.length} 个）</Button></div>
   <p className={executorVersionOK?'banner success':'banner danger'}>{executorOnline?`活动页执行器在线 · 扩展 ${enrollmentClient.collector_version||'版本未知'} · 最近心跳 ${new Date(enrollmentClient.last_seen).toLocaleTimeString('zh-CN')}${executorVersionOK?'':' · 请重载到 0.15.8'}`:'活动页执行器未连接 · 请打开对应活动页并确认扩展 0.15.8 已重载'}</p>
   <p className="panelnote">自动报名只处理整件全部 SKU 都已是活动标价，并且平台活动参考价不低于裸跑价的商品。</p>
   {passed.length>safeRows.length&&<p className="banner">有 {passed.length-safeRows.length} 个 SKU 的活动价已经符合，但同一商品还有其他 SKU 位于裸跑档、两档均不符或不可报名；它们会显示对应 SKU，暂不进入一键报名，避免整件提交时混入错误价格。</p>}
   {enrollmentPreview&&<div className="banner"><div><strong>等待确认：{enrollmentPreview.product_count} 个商品 · {enrollmentPreview.sku_count} 个 SKU</strong><p>活动价使用平台活动参考价，场次共用库存使用参考库存；提交前页面还会逐项复核。</p></div><Button onClick={startEnrollment} disabled={busy}>确认并开始自动报名</Button></div>}
   {latestBatch&&<p className="panelnote">最近报名批次：{latestBatch.status} · {latestBatch.message} · {new Date(latestBatch.updated).toLocaleString('zh-CN')}</p>}
   {shownGroups.length?<div className="tablewrap"><table><thead><tr><th>报名</th><th>商品</th><th>对应 SKU / 尺寸</th><th>当前价 → 活动价</th><th>共用库存</th></tr></thead><tbody>{shownGroups.map(group=>{const first=group.items[0];return <tr key={group.key}><td><input aria-label={`选择商品 ${first.spuId}`} type="checkbox" checked={selectedProducts.includes(group.key)} onChange={e=>setSelectedProducts(keys=>e.target.checked?[...keys,group.key]:keys.filter(key=>key!==group.key))}/></td><td><strong>SPU {first.spuId}</strong><small>SKC {first.skcId}</small></td><td>{group.items.map(row=><small key={row.skuId}>SKU {row.skuId} · {row.specification}</small>)}</td><td>{group.items.map(row=><small key={row.skuId}>{money(row.dailyPrice)} → {money(row.precheck?.plannedActivityPrice)}</small>)}</td><td>{first.referenceStock??'—'}</td></tr>})}</tbody></table></div>:<p className="panelnote">暂无可整件报名的商品。可展开下方查看原因。</p>}
   <details open={passed.length===0&&awaiting.length>0}><summary>待补资料（{awaiting.length}）</summary><p>这里现在只保留当前类目真正缺少尺寸规则、活动页价格或库存的 SKU；其他类目不会再算作资料不足。</p>{[...new Set(awaiting.flatMap(row=>row.precheck?.pendingReasons||['尚未取得后台预检结果']))].map(reason=><p key={String(reason)}>{String(reason)}：{awaiting.filter(row=>(row.precheck?.pendingReasons||['尚未取得后台预检结果']).includes(reason)).length} 个 SKU</p>)}</details>
   <details><summary>未通过 / 待核对（{blocked.length+pending.length}）</summary>{blocked.filter(matches).map(row=><p key={[row.spuId,row.skcId,row.skuId].join('|')}>SKU {row.skuId} · {row.specification} · 当前 {money(row.dailyPrice)}：{row.precheck?.blockedReasons?.join('；')||'尚未取得后台预检结果，请更新并重启本地服务'}</p>)}{pending.filter(matches).map((row,index)=><p key={index}>{row.spuId} · {row.specification}：{row.resolutionError||'SKU 待核对'}</p>)}</details>
  </section>
  <section className="panel"><h2>类目与两档价格预设</h2><p className="panelnote">可填写任意商品类目，例如男T恤。尺寸每条边允许 ±2；颜色等文字规格必须精确一致。活动标价和裸跑价允许 ±2 元。</p>{message&&<p role="status" className="banner success">{message}</p>}{error&&<p role="alert" className="banner danger">{error}</p>}<p>当前插件使用：<strong>{data?.active_preset||'尚未选择'}</strong>。</p><div className="formgrid"><label className="field"><span>已保存的预设</span><select value={selectedPreset} onChange={e=>loadPreset(e.target.value)}><option value="">选择预设</option>{data?.price_presets?.map((p:Row)=><option key={p.name} value={p.name}>{p.name}</option>)}</select></label><label className="field"><span>商品类目</span><input list="activity-category-names" value={config.category==='未分类'?'':config.category||''} maxLength={60} placeholder="不填则使用预设名称" onChange={e=>setConfig({...config,category:e.target.value})}/><datalist id="activity-category-names"><option value="毛毯"/><option value="地垫"/><option value="男T恤"/>{data?.price_presets?.map((p:Row)=><option key={p.name} value={p.config.category||p.name}/>)}</datalist></label><label className="field"><span>保存名称</span><input list="activity-preset-names" value={presetName} maxLength={60} placeholder="例如：毛毯、地垫、男T恤" onChange={e=>setPresetName(e.target.value)}/><datalist id="activity-preset-names"><option value="毛毯"/><option value="地垫"/><option value="男T恤"/></datalist></label></div>
   <div className="buttons"><Button variant="outline" onClick={()=>{setSelectedPreset('');setPresetName('');setConfig({...config,category:'未分类'});setRules([{spec:'',floor:'',target:'',min:'',max:''}]);setSaveError('');setError('');setMessage('已打开空白预设。填写名称和规格价格后点击“保存并使用”。')}}>新建空白预设</Button></div>
   <p className="panelnote">活动标价按“裸跑价 ÷ 0.75”向上保留两位小数。你可以手动加一点余量，但 75 折后不能低于裸跑价。</p>
   {rules.filter(rule=>Number(rule.target)>0&&Math.round(Number(rule.target)*75)/100<Number(rule.floor)).map(rule=><p className="banner danger" key={rule.spec}>{rule.spec}：活动标价 {money(rule.target)} 打 75 折后只有 {money(Math.round(Number(rule.target)*75)/100)}，低于裸跑价 {money(rule.floor)}。</p>)}
   <div className="tablewrap"><table className="activity-rule-table"><thead><tr><th>尺寸 / 规格</th><th>裸跑价</th><th>自动建议活动标价</th><th>实际活动标价</th><th>75 折后</th><th></th></tr></thead><tbody>{rules.map((rule,index)=><tr key={index}><td><input aria-label={`尺寸或规格 ${index+1}`} value={rule.spec} placeholder="如 40×50in、混合色" onChange={e=>setRules(rows=>rows.map((r,i)=>i===index?{...r,spec:e.target.value}:r))}/></td><td><input aria-label={`裸跑价 ${index+1}`} type="number" min="0.01" step="0.01" value={rule.floor} onChange={e=>setRules(rows=>rows.map((r,i)=>i===index?{...r,floor:e.target.value}:r))}/></td><td>{money(activityPrice(rule.floor))}</td><td><input aria-label={`活动标价 ${index+1}`} type="number" min="0.01" step="0.01" value={rule.target} onChange={e=>setRules(rows=>rows.map((r,i)=>i===index?{...r,target:e.target.value}:r))}/></td><td>{rule.target?money(Math.round(Number(rule.target)*75)/100):'—'}</td><td><Button variant="ghost" onClick={()=>setRules(rows=>rows.filter((_,i)=>i!==index))}>移除</Button></td></tr>)}</tbody></table></div>
   <div className="buttons"><Button variant="outline" onClick={()=>setRules(rows=>rows.map(rule=>({...rule,target:activityPrice(rule.floor)})))}>按裸跑价自动计算全部</Button><Button variant="outline" onClick={()=>setRules(rows=>[...rows,{spec:'',target:'',floor:'',min:'',max:''}])}>添加规格</Button><Button variant="outline" onClick={()=>setRules(rows=>{const known=new Set(rows.map(r=>r.spec));return [...rows,...[...new Set(candidates.map(r=>r.specification).filter(Boolean))].filter(spec=>!known.has(spec)).map(spec=>({spec,target:'',floor:'',min:'',max:''}))]})}>补充已读取规格</Button><Button disabled={busy} onClick={beginSave}>保存并使用</Button></div>
  </section>
  <p className="panelnote">扩展 0.15.8：Chrome 与 Edge 按浏览器和店铺独立领取任务；活动页也能读取“混合色”等明确标注的文字规格。</p>
  <p className="panelnote">商品目录更新后自动重新匹配活动候选，本页每 15 秒刷新。商品与活动采集中的“活动”是已报名记录；新增可报名商品仍需在对应活动详情页只读采集，资格和参考价保留原采集时间。</p>
  <details className="panel"><summary>读取详情</summary>{latest?<><p>活动 {latest.campaign_id} · 扩展 {latest.payload.collector_version||'未记录'}</p><p>本次匹配使用商品目录：{latest.payload.product_catalog?.captured?new Date(latest.payload.product_catalog.captured).toLocaleString('zh-CN'):'尚未采集'} · {latest.payload.recovered_sku_count||0} 个 SKU 唯一补全</p>{latest.payload.warnings?.map((warning:string)=><p key={warning}>{warning}</p>)}{pending.map((row:Row,index:number)=><p key={index}>{row.spuId} · {row.specification}：{row.resolutionError}</p>)}</>:<p>暂无记录。</p>}</details>
 </>;
}

