'use client';
import {useCallback,useEffect,useMemo,useState} from 'react';
import {Button} from '@/components/ui/button';
import ProductRuleEditor,{ProductMaintenance} from './product-rule-editor';
import {useWorkbenchMode} from './workbench-mode';

import {BatchSelectionTools,useBatchSelection} from './batch-selection';
type Row=Record<string,any>;
const stamp=(value:any)=>value?new Date(value).toLocaleString('zh-CN'):'尚未采集';
const money=(value:any,currency='CNY')=>value==null||value===''?'待采集':(currency==='CNY'?'¥':currency==='USD'?'$':currency+' ')+Number(value).toFixed(2);
const fresh=(value:Row)=>value?.stale?'快照较旧':'有效期内快照';
const platformPath=(row:Row):string[]=>Array.isArray(row.platformCategoryPath)?row.platformCategoryPath.map(String).filter(Boolean):[];
const platformLabel=(row:Row)=>platformPath(row).join(' > ')||row.platformCategoryName||(row.platformCategoryId?'类目 ID '+row.platformCategoryId:'');
function platformLeaf(row:Row){
 if(row.platformCategoryConflict)return {key:'conflict',label:'平台类目冲突，待核对'};
 const names=platformPath(row),ids=Array.isArray(row.platformCategoryIds)?row.platformCategoryIds.map(String):[];
 const id=row.platformCategoryId||(names.length&&ids.length===names.length?ids[ids.length-1]:'');
 if(id)return {key:'id:'+id,label:platformLabel(row)||'类目 ID '+id};
 if(names.length)return {key:'path:'+JSON.stringify(names),label:names.join(' > ')};
 return row.platformCategoryName?{key:'name:'+row.platformCategoryName,label:row.platformCategoryName}:{key:'missing',label:'平台类目待采集'};
}
const catalogQueryReady=(version:string)=>{const parts=String(version||'').split('.').map(Number);return parts.length>=3&&parts.every(Number.isInteger)&&(parts[0]>0||parts[1]>20||parts[1]===20&&parts[2]>=11)};
async function api(path:string,body?:Row,signal?:AbortSignal){
 const response=await fetch(path,{cache:'no-store',signal:signal||AbortSignal.timeout(20000),...(body?{method:'POST',headers:{'Content-Type':'application/json','X-Workbench':'local'},body:JSON.stringify(body)}:{})});
 const value=await response.json() as Row;if(!response.ok)throw Error(value.error||'读取失败');return value;
}
export default function ProductStatus({preferredMall='',clientId=''}:{preferredMall?:string;clientId?:string}){
 const {professional}=useWorkbenchMode();
 const [mall,setMall]=useState(preferredMall),[shops,setShops]=useState<Row[]>([]),[data,setData]=useState<Row|null>(null);
 const [query,setQuery]=useState(''),[pool,setPool]=useState('on_sale'),[category,setCategory]=useState(''),[platformCategory,setPlatformCategory]=useState(''),[activity,setActivity]=useState('all'),[boost,setBoost]=useState('all');
 const [error,setError]=useState(''),[message,setMessage]=useState(''),[busy,setBusy]=useState(false),[page,setPage]=useState(1);
 const [control,setControl]=useState<Row|null>(null),[reload,setReload]=useState(0);
 const [editingRules,setEditingRules]=useState(false),[editingProduct,setEditingProduct]=useState<Row|null>(null);
 const [batchCategory,setBatchCategory]=useState('');
 useEffect(()=>{if(preferredMall)setMall(preferredMall)},[preferredMall]);
 useEffect(()=>{const controller=new AbortController();api('/api/collector/state',undefined,controller.signal).then(value=>setShops(value.shops||[])).catch(reason=>{if(reason.name!=='AbortError')setError(reason.message)});return()=>controller.abort()},[]);
 useEffect(()=>{
  setData(null);setError('');if(!mall)return;
  const controller=new AbortController();let loading=false;
  const load=async()=>{if(loading||document.hidden)return;loading=true;try{
   const value=await api('/api/features/product-status?'+new URLSearchParams({mall_id:mall}),undefined,controller.signal);
   if(!controller.signal.aborted){setData(value);setError('')}
  }catch(reason:any){if(reason.name!=='AbortError')setError(reason.message)}finally{loading=false}};
  load();const timer=setInterval(load,15000);window.addEventListener('focus',load);
  return()=>{controller.abort();clearInterval(timer);window.removeEventListener('focus',load)};
 },[mall,reload]);
 useEffect(()=>{
  const controller=new AbortController();let loading=false;
  const load=async()=>{if(loading||document.hidden)return;loading=true;try{const status=await api('/api/collector/control',undefined,controller.signal);if(!controller.signal.aborted)setControl(status)}catch(reason:any){if(reason.name!=='AbortError')setError(reason.message)}finally{loading=false}};
  load();const timer=setInterval(load,3000);window.addEventListener('focus',load);
  return()=>{controller.abort();clearInterval(timer);window.removeEventListener('focus',load)};
 },[mall,reload]);
 useEffect(()=>{setMessage('');setEditingRules(false);setEditingProduct(null)},[mall]);
 useEffect(()=>{setCategory('');setPlatformCategory('');setBatchCategory('')},[mall,pool]);
 useEffect(()=>setPage(1),[mall,pool,category,platformCategory,query,activity,boost]);
 const categories=useMemo(()=>{
  if(!data||data.mallId!==mall)return [];
  const counts=new Map<string,number>();
  for(const row of data.products||[]){const name=row.categoryName||'未分类';counts.set(name,(counts.get(name)||0)+1)}
  return [...counts].map(([name,count])=>({name,count})).sort((a,b)=>a.name==='未分类'?1:b.name==='未分类'?-1:b.count-a.count||a.name.localeCompare(b.name,'zh-CN'));
 },[data,mall]);
 const platformCategories=useMemo(()=>{
  if(!data||data.mallId!==mall)return [];
  const counts=new Map<string,{key:string;label:string;count:number}>();
  for(const row of data.products||[]){const node=platformLeaf(row),saved=counts.get(node.key);if(saved)saved.count++;else counts.set(node.key,{...node,count:1})}
  return [...counts.values()].sort((a,b)=>Number(['missing','conflict'].includes(a.key))-Number(['missing','conflict'].includes(b.key))||a.label.localeCompare(b.label,'zh-CN'));
 },[data,mall]);
 useEffect(()=>{if(data?.mallId===mall&&category&&!categories.some(item=>item.name===category))setCategory('')},[data,mall,category,categories]);
 useEffect(()=>{if(data?.mallId===mall&&platformCategory&&!platformCategories.some(item=>item.key===platformCategory))setPlatformCategory('')},[data,mall,platformCategory,platformCategories]);
 const rows=useMemo(()=>{
  if(!data||data.mallId!==mall)return [];
  const source:Row[]=pool==='on_sale'?data.products:pool==='not_on_sale'?data.trash:data.pending;
  const term=query.trim().toLowerCase();
  return (source||[]).filter(row=>(!term||[row.spuId,row.categoryName,platformLabel(row),row.platformCategoryId,...(row.skus||[]).flatMap((sku:Row)=>[sku.skuId,sku.skcId,sku.skuCode,sku.specification]),...(row.activityNames||[])].join(' ').toLowerCase().includes(term))&&(pool!=='on_sale'||(!category||(row.categoryName||'未分类')===category)&&(!platformCategory||platformLeaf(row).key===platformCategory)&&(activity==='all'||row.activityStatus===activity)&&(boost==='all'||row.acceleratorSwitchStatus===boost)));
 },[data,mall,pool,category,platformCategory,query,activity,boost]);
 const batch=useBatchSelection(rows,JSON.stringify([mall,pool,category,platformCategory,query,activity,boost]),row=>String(row.spuId));
 const selected=batch.selectedRows.map(row=>String(row.spuId));
 useEffect(()=>setPage(1),[batch.onlySelected]);
 const visibleRows=batch.visibleRows;
 const pageCount=Math.max(1,Math.ceil(visibleRows.length/40)),currentPage=Math.min(page,pageCount),shown=visibleRows.slice((currentPage-1)*40,currentPage*40);
 const canBatch=pool==='on_sale'&&data?.mallId===mall&&!!data?.categoryConfig;
 async function categorize(){
  if(!data?.categoryConfig||data.mallId!==mall||pool!=='on_sale'||busy||!selected.length)return;
  setBusy(true);setError('');setMessage('');try{
   if(selected.length>500)throw Error('每批最多归类 500 个商品，请减少勾选');
   await api('/api/features/product-rules',{mall_id:mall,revision:data.categoryConfig.revision,action:'products',spuIds:selected,category:batchCategory});
   batch.clear();setMessage(batchCategory?'已将 '+selected.length+' 个商品归类到「'+batchCategory+'」。':'已恢复 '+selected.length+' 个商品自动匹配。');setReload(value=>value+1);
  }catch(reason:any){setError(reason.message)}finally{setBusy(false)}
 }
 const sync=useCallback(async(taskType='product_status')=>{
  if(!mall)return;setBusy(true);setError('');try{
   const value=await api('/api/collector/collect-now',{mall_id:mall,task_type:taskType,...(clientId?{client_id:clientId}:{})});
   setMessage(value.message);setReload(value=>value+1);
  }catch(reason:any){setError(reason.message)}finally{setBusy(false)}
 },[mall,clientId]);
 const client=control?.clients?.[clientId];
 const otherBrowserShop=!!client?.mall_id&&client.mall_id!==mall;
 const pendingCommand=control?.commands?.find((row:Row)=>row.mall_id===mall&&['product_status','accelerator_status'].includes(row.kind)&&['queued','running'].includes(row.status));
 const lastCommand=control?.commands?.find((row:Row)=>row.mall_id===mall&&['product_status','accelerator_status'].includes(row.kind));
 return <div>
   {editingRules&&data?.mallId===mall&&data.categoryConfig&&<div hidden={!professional}><ProductRuleEditor key={mall} mall={mall} config={data.categoryConfig} onSaved={()=>setReload(value=>value+1)} onClose={()=>setEditingRules(false)}/></div>}
   {editingProduct&&data?.mallId===mall&&data.categoryConfig&&<div hidden={!professional}><ProductMaintenance key={mall+'|'+editingProduct.spuId} mall={mall} config={data.categoryConfig} product={editingProduct} onSaved={()=>setReload(value=>value+1)} onClose={()=>setEditingProduct(null)}/></div>}

  <section className="panel">
   <div className="sectionhead"><div><h2>商品状态</h2><p>按平台类目查找在售商品，按商品编号关联活动报名，展开查看每个规格的价格与活动。</p></div><span className="tag green">默认只看在售</span></div>
   <div className="filterbar">
    <select aria-label="商品状态店铺" value={mall} onChange={event=>setMall(event.target.value)}>
     <option value="">选择店铺</option>
     {preferredMall&&!shops.some(shop=>shop.mall_id===preferredMall)&&<option value={preferredMall}>当前浏览器店铺</option>}
     {shops.map(shop=><option key={shop.mall_id} value={shop.mall_id}>{shop.name||shop.mall_id}</option>)}
    </select>
    <Button disabled={!mall||busy||!!pendingCommand||otherBrowserShop} onClick={()=>sync()}>{pendingCommand?.kind==='product_status'?(pendingCommand.status==='running'?'正在采集…':'等待插件领取…'):busy?'请求中…':'立即更新商品＋活动'}</Button>
     <Button variant="outline" disabled={!mall||busy||!!pendingCommand||otherBrowserShop||!!client&&!catalogQueryReady(client.version)} onClick={()=>sync('accelerator_status')}>{pendingCommand?.kind==='accelerator_status'?(pendingCommand.status==='running'?'正在采集加速器…':'加速器等待领取…'):'更新加速器状态'}</Button>
    <Button variant="outline" disabled={!mall} onClick={()=>setReload(value=>value+1)}>刷新本地列表</Button>
     {professional&&<Button variant="outline" disabled={!data?.categoryConfig||data.mallId!==mall} onClick={()=>setEditingRules(value=>!value)}>维护类目与规格</Button>}
    {professional&&client&&<span className="tag">当前浏览器 {client.browser} · 扩展 {client.version}</span>}
   </div>
   {error&&<div className="banner danger">{error}</div>}
   {message&&<div className="banner" role="status">{message}</div>}
   {client&&!catalogQueryReady(client.version)&&<div className="banner">按“流量加速中”标志核对全部在售商品，需要重新加载助手到 0.20.11，并刷新商家后台和工作台。</div>}
   {otherBrowserShop&&<p className="panelnote">当前查看其他店铺的数据。同步前请先在此浏览器商家后台切换到所选店铺。</p>}
   {typeof client?.auto_state?.enabled==='boolean'&&<p className={'banner '+(client.auto_state.product_error?'danger':'')} aria-label="自动采集状态">自动更新{client.auto_state.enabled?'已开启':'已暂停'} · {client.auto_state.product_error||'手动刷新优先；商家后台在线时每 2 小时更新商品与报名记录'}{client.auto_state.product_finished_at?' · 最近完整同步：'+stamp(client.auto_state.product_finished_at):''}{client.auto_state.product_error&&client.auto_state.product_retry_at?' · 下次尝试：'+stamp(client.auto_state.product_retry_at):''}</p>}
    {typeof client?.auto_state?.enabled==='boolean'&&<p className={'banner '+(client.auto_state.accelerator_error?'danger':'')} aria-label="加速器采集状态">加速器：{client.auto_state.accelerator_error||'可随时手动刷新；自动更新开启时每 2 小时从美国站读取'}{client.auto_state.accelerator_finished_at?' · 最近完成：'+stamp(client.auto_state.accelerator_finished_at):''}</p>}
    {lastCommand&&<div className={'banner '+(lastCommand.status==='failed'?'danger':'')} role="status">{({queued:'等待领取',running:'正在采集',finished:'同步完成',failed:'采集失败'} as Row)[lastCommand.status]||'同步状态'}：{lastCommand.message} · {stamp(lastCommand.updated_at||lastCommand.finished||lastCommand.started||lastCommand.created)}</div>}
   {professional?<p className="panelnote">批量上品后可主动刷新，手动请求优先于下一阶段的自动采集；已有采集阶段会先完成并显示排队进度。自动更新开启且商家后台在线时，商品、报名记录、加速器与流量每 2 小时采集；自动失败后等下一周期，也可手动重试。页面每 3 秒查看请求进度、每 15 秒读取本地列表，不会触发平台抓取。加速器按商品信息的“流量加速中”标志判断：有标志为已开启，无标志为未开启。商品、活动、加速器及流量标记的数据有效期为 {(data?.freshnessWindowMinutes ?? 720) / 60} 小时；未采集或过期的状态标为待确认，始终保留采集时间。<a href="https://agentseller-us.temu.com/main/flux-analysis" target="_blank" rel="noreferrer">打开加速器来源页 ↗</a></p>:<p className="panelnote">按类目查商品，展开查看规格与报名。数据未采集或过期时显示“待确认”。</p>}
   {data&&<><div className="metricgrid">
    <div><strong>{data.counts.onSale}</strong><span>在售 SPU</span></div>{professional&&<div><strong>{data.counts.skus}</strong><span>在售规格</span></div>}
    <div><strong>{data.counts.enrolled}</strong><span>有报名记录</span></div>
    <div><strong>{data.counts.acceleratorSwitchEnabled??0} / {data.counts.onSale}</strong><span>加速器已开启</span></div>
    <div><strong>{data.counts.acceleratorSwitchDisabled??0} / {data.counts.onSale}</strong><span>加速器未开启</span></div>
    <div><strong>{data.counts.acceleratorSwitchUnknown??data.counts.onSale} / {data.counts.onSale}</strong><span>加速器待确认</span></div>
   </div><p className="panelnote">商品：{stamp(data.sources.products.captured)}（{fresh(data.sources.products)}） · 活动：{stamp(data.sources.activities.captured)}（{fresh(data.sources.activities)}）{professional&&<> · 加速器：{stamp(data.sources.accelerators?.captured)} · 有效期内已确认开启或未开启 {data.sources.accelerators?.switchFreshProducts??0} / {data.counts.onSale}</>}</p>
   <p className="panelnote" aria-label="平台类目采集覆盖">平台类目已采集 {data.categoryCoverage?.matched??data.products.filter((row:Row)=>!row.platformCategoryConflict&&!!platformLabel(row)).length} / {data.products.length} 个 SPU · 待采集 {data.categoryCoverage?.missing??data.products.filter((row:Row)=>platformLeaf(row).key==='missing').length} · 冲突待核对 {data.categoryCoverage?.conflicts??data.products.filter((row:Row)=>row.platformCategoryConflict).length}。{data.products.some((row:Row)=>!platformLabel(row)&&!row.platformCategoryConflict)&&'请重新加载统一助手到 0.20.13，刷新商家后台和工作台，再点击“立即更新商品＋活动”补采平台类目。'}平台类目缺失的商品仍保留在列表中。</p></>}
  </section>
  <section className="panel">
   <div className="filterbar">
    <Button variant={pool==='on_sale'?'default':'outline'} onClick={()=>setPool('on_sale')}>在售 {data?.counts.onSale??'—'}</Button>
    <Button variant={pool==='not_on_sale'?'default':'outline'} onClick={()=>setPool('not_on_sale')}>垃圾堆 · 不在售 {data?.counts.notOnSale??'—'}</Button>
    {!!data?.counts.unknown&&<Button variant={pool==='unknown'?'default':'outline'} onClick={()=>setPool('unknown')}>状态待确认 {data.counts.unknown}</Button>}
    <input aria-label="搜索商品状态" style={{width:240,maxWidth:'100%'}} placeholder="搜索类目、SPU、SKU、货号或活动" value={query} onChange={event=>setQuery(event.target.value)}/>
    {pool==='on_sale'&&<>
     <select aria-label="平台类目筛选" style={{width:300,maxWidth:'100%'}} title={platformCategories.find(item=>item.key===platformCategory)?.label||'按商品所属的末级平台类目筛选，保留完整路径区分同名类目'} value={platformCategory} onChange={event=>setPlatformCategory(event.target.value)}><option value="">全部平台类目（{data?.products?.length??0}）</option>{platformCategories.map(item=><option key={item.key} value={item.key}>{item.label}（{item.count}）</option>)}</select>
     <select aria-label="商品类目筛选" style={{width:180,maxWidth:'100%'}} value={category} onChange={event=>setCategory(event.target.value)}><option value="">全部业务类目（{data?.products?.length??0}）</option>{categories.map(item=><option key={item.name} value={item.name}>{item.name}（{item.count}）</option>)}</select>
      <select aria-label="活动状态筛选" value={activity} onChange={event=>setActivity(event.target.value)}><option value="all">全部活动状态</option><option value="enrolled">有报名记录</option><option value="none">当前无生效活动</option><option value="unknown">活动待确认</option></select>
     <select aria-label="加速器状态筛选" value={boost} onChange={event=>setBoost(event.target.value)}><option value="all">全部加速器状态</option><option value="enabled">已开启</option><option value="disabled">未开启</option><option value="unknown">待确认</option></select>
    </>}
   </div>
   {pool==='on_sale'&&data?.mallId===mall&&<><p className="panelnote" aria-label="类目筛选结果">当前{category?'「'+category+'」':'全部类目'}{platformCategory?' · '+(platformCategories.find(item=>item.key===platformCategory)?.label||'所选平台类目'):''} · 符合筛选 {rows.length} / {data.products.length} 个 SPU。优先按平台类目归类；本地映射可合并业务类目，人工归类保留优先。缺少平台类目时使用货号或规格规则。{(category||platformCategory||query||activity!=='all'||boost!=='all')&&<Button variant="ghost" onClick={()=>{setCategory('');setPlatformCategory('');setQuery('');setActivity('all');setBoost('all')}}>清除筛选</Button>}</p><p className="panelnote" aria-label="筛选商品报名情况">当前筛选：有报名 {rows.filter(row=>row.activityStatus==='enrolled').length} · 当前无生效活动 {rows.filter(row=>row.activityStatus==='none').length} · 待确认 {rows.filter(row=>row.activityStatus==='unknown').length}。报名按同店 SPU、SKC、SKU 编号核对；活动快照较旧时以采集时间为准。</p></>}
   <BatchSelectionTools selection={batch} total={rows.length} label="商品状态" copyFields={[{label:'SPU',value:row=>row.spuId}]} columns={[{label:'SPU',value:row=>row.spuId},{label:'类目',value:row=>row.categoryName},{label:'平台类目',value:row=>platformLabel(row)},{label:'平台类目ID',value:row=>row.platformCategoryId},{label:'归类依据',value:row=>row.categorySourceLabel},{label:'在售状态',value:row=>row.saleStatusLabel},{label:'活动',value:row=>row.activityStatusLabel},{label:'活动名称',value:row=>(row.activityNames||[]).join('；')},{label:'加速器',value:row=>row.acceleratorSwitchStatusLabel},{label:'采集时间',value:row=>stamp(row.freshness?.captured||row.captured)}]}/>
   {professional&&pool==='on_sale'&&<>
    <div className="buttons"><select aria-label="批量归类目标" value={batchCategory} disabled={!selected.length||busy||!canBatch} onChange={event=>setBatchCategory(event.target.value)}><option value="">恢复自动匹配</option>{data?.categoryConfig?.rules.map((rule:Row)=><option key={rule.name} value={rule.name}>{rule.name}</option>)}</select><Button disabled={!selected.length||selected.length>500||busy||!canBatch} onClick={categorize}>批量归类（{selected.length}）</Button></div>
    <p className="panelnote">已勾选 {selected.length} 个 SPU，每批最多 500 个。仅维护本地类目，保留已维护规格。切换店铺或筛选条件会清空勾选。</p>
   </>}
    {pool==='not_on_sale'&&<p className="panelnote">只显示 SPU 与不在售状态。未出现在最新完整在售快照中的已知商品归入此处，再次上架后自动回到在售池。</p>}
   {!data?<p>{mall?'正在读取商品状态…':'请先选择店铺。'}</p>:!rows.length?<p>当前筛选没有商品。</p>:<>
    <div className="tablewrap"><table><thead><tr><th>选择</th><th>SPU</th><th>在售状态</th>{pool==='on_sale'?<><th>活动</th><th>流量加速器</th><th>规格与价格</th></>:<th>状态更新时间</th>}</tr></thead><tbody>
    {shown.map(row=><tr key={row.spuId} data-spu-id={row.spuId} data-category={row.categoryName||undefined} data-batch-selected={batch.isSelected(row)}>
     <td><input className="batch-row-check" type="checkbox" aria-label={`选择商品状态 SPU ${row.spuId}`} checked={batch.isSelected(row)} onChange={event=>batch.toggle(row,event.target.checked)}/></td>
     <td>{row.images?.[0]&&<img className="feature-thumb" src={row.images[0]} alt="" loading="lazy"/>}<div>{row.spuId}</div>{pool==='on_sale'&&<><span className="tag" title={row.categorySourceLabel}>{row.categoryName||'未分类'}</span><small className="panelnote" style={{display:'block'}}>{row.categorySourceLabel}</small><small className="panelnote" style={{display:'block',maxWidth:300,overflowWrap:'anywhere'}}>{row.platformCategoryConflict?'平台类目冲突，待核对':platformLabel(row)?'平台：'+platformLabel(row):'平台类目待采集'}{row.platformCategoryId?<><br/>类目 ID {row.platformCategoryId}</>:null}</small><Button variant="ghost" onClick={()=>setEditingProduct(row)}>维护商品</Button></>}</td>
     <td><span className={'tag '+(pool==='on_sale'?'green':'')}>{row.saleStatusLabel}</span>{row.freshness?.stale&&<p className="panelnote">在售快照较旧</p>}</td>
     {pool==='on_sale'?<>
      <td><span className={'tag '+(row.activityStatus==='enrolled'?'green':'amber')}>{row.activityStatusLabel}</span>{row.activityNames.map((name:string)=><div key={name}>{name}</div>)}</td>
      <td><span className={'tag '+(row.acceleratorSwitchStatus==='enabled'?'green':'amber')}>{row.acceleratorSwitchStatusLabel||'待确认'}</span>
       {(row.accelerators||[]).map((entry:Row,index:number)=><p className="panelnote" key={index}>{entry.siteName} · {entry.statusLabel}{entry.freshness.stale?'（较旧）':''}<br/>{entry.status==='unknown'&&entry.evidence?<>{entry.evidence}<br/></>:null}{entry.priceKind==='offer'?'开启报价':'开启后价格'}：{money(entry.price,entry.currency)}{entry.skuId?' · SKU '+entry.skuId:''}<br/>{stamp(entry.freshness.captured)}</p>)}
       {!row.accelerators.length&&<p className="panelnote">开启后价格待采集</p>}
      </td>
      <td><details><summary>{row.skuCount} 个规格 · 展开</summary>
       <table><thead><tr><th>规格 / SKU</th><th>申报价</th><th>报名活动与活动价</th><th>开启后价格 / 报价</th></tr></thead><tbody>
        {row.skus.map((sku:Row)=><tr key={sku.skcId+'|'+sku.skuId}><td>{sku.specification||'规格待采集'}{sku.specificationSource==='local_maintenance'&&<small> · 本地维护</small>}<br/><small>SKC {sku.skcId}<br/>SKU {sku.skuId||'待确认'}{sku.skuCode?<><br/>{sku.skuCode}</>:null}</small></td><td>{money(sku.declaredPrice,sku.currency)}</td><td>
         {sku.activities.length?sku.activities.map((item:Row,index:number)=><div key={index}>{item.activityName||item.activityTypeName||item.enrollId} · {item.siteName||'站点待确认'}<br/>{item.statusLabel} · {money(item.activityPrice,item.currency||'CNY')}<br/><small>{stamp(item.freshness.captured)}{item.freshness.stale?' · 较旧':''}</small></div>):'未读到当前报名记录'}
        </td><td>{row.accelerators.filter((entry:Row)=>entry.skuId===sku.skuId&&entry.price!=null).length?row.accelerators.filter((entry:Row)=>entry.skuId===sku.skuId&&entry.price!=null).map((entry:Row,index:number)=><div key={index}>{entry.siteName} · {money(entry.price,entry.currency)}<br/><small>{entry.priceKind==='offer'?'开启报价':'开启后价格'}{entry.freshness.stale?' · 较旧':''}</small></div>):'待采集'}</td></tr>)}
       </tbody></table>
      </details></td>
     </>:<td>{stamp(row.captured)}</td>}
    </tr>)}
    </tbody></table></div>
    <div className="buttons"><Button variant="outline" disabled={currentPage<=1} onClick={()=>setPage(currentPage-1)}>上一页</Button><span>{currentPage} / {pageCount} 页 · 当前显示 {visibleRows.length} 个 SPU</span><Button variant="outline" disabled={currentPage>=pageCount} onClick={()=>setPage(currentPage+1)}>下一页</Button></div>
   </>}
  </section>
  {professional&&<section className="panel"><h3>后续待办</h3><p>逐商品流量诊断与长期跟踪：共同确定指标、采样频率和保存周期后再做。</p><p className="panelnote">后续一键开启加速器将使用这里的商品、活动与实际报价状态。</p></section>}
 </div>;
}
