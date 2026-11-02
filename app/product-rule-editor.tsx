'use client';
import {useState} from 'react';
import {Button} from '@/components/ui/button';

type Row=Record<string,any>;
const split=(value:string)=>value.split(/\r?\n/).map(item=>item.trim()).filter(Boolean);
async function save(body:Row){
 const response=await fetch('/api/features/product-rules',{method:'POST',headers:{'Content-Type':'application/json','X-Workbench':'local'},body:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
 const value=await response.json() as Row;if(!response.ok)throw Error(value.error||'保存失败');return value;
}
export default function ProductRuleEditor({mall,config,onSaved,onClose}:{mall:string;config:Row;onSaved:()=>void;onClose:()=>void}){
 const [rules,setRules]=useState<Row[]>(()=>config.rules.map((rule:Row)=>({...rule,specText:(rule.specifications||[]).join('\n'),codeText:(rule.codeKeywords||[]).join('\n'),platformIdText:(rule.platformCategoryIds||[]).join('\n'),platformNameText:(rule.platformCategoryNames||[]).join('\n')})));
 const [busy,setBusy]=useState(false),[error,setError]=useState('');
 const update=(index:number,patch:Row)=>setRules(value=>value.map((row,i)=>i===index?{...row,...patch}:row));
 async function submit(event:React.FormEvent){
  event.preventDefault();setBusy(true);setError('');
  try{await save({mall_id:mall,revision:config.revision,rules:rules.map(rule=>({name:rule.name,platformCategoryIds:split(rule.platformIdText),platformCategoryNames:split(rule.platformNameText),specifications:split(rule.specText),codeKeywords:split(rule.codeText),minMatches:Number(rule.minMatches),tolerance:Number(rule.tolerance),allowUnmatched:rule.allowUnmatched}))});onSaved();onClose()}
  catch(e:any){setError(e.message)}finally{setBusy(false)}
 }
 return <section className="panel product-rules" aria-label="维护类目与规格">
  <div className="sectionhead"><div><h2>维护类目与规格</h2><p>将平台类目映射为本店业务类目。保存后重新匹配，独立于活动价格预设。</p></div><Button variant="outline" disabled={busy} onClick={onClose}>关闭设置</Button></div>
  <p className="panelnote">优先填写平台类目 ID 或精确名称，每行一个；可填写上级节点，将其子类目统一归类。名称按完整节点名称或完整路径精确匹配。已有平台类目但未命中映射时，直接使用平台叶子类目；缺少平台类目时才使用下面的货号、规格规则。多个业务类目同时命中时保留未分类，人工归类优先。</p>
  <form onSubmit={submit}><fieldset disabled={busy} style={{border:0,padding:0,margin:0}}>
   {rules.map((rule,index)=><article key={index} style={{borderBottom:'1px solid #dfe5ec',padding:'18px 0'}} aria-label={'类目规则 '+(rule.name||index+1)}>
    <div className="filterbar">
     <label className="field">类目名称<input aria-label={'类目名称 '+index} maxLength={60} value={rule.name} onChange={e=>update(index,{name:e.target.value})} required/></label>
     <label className="field">最少匹配规格数<input aria-label={'最少匹配规格数 '+index} type="number" min={1} max={100} value={rule.minMatches} onChange={e=>update(index,{minMatches:e.target.value})} required/></label>
     <label className="field">每边尺寸容差（同单位）<input aria-label={'尺寸容差 '+index} type="number" min={0} max={10} step="0.01" value={rule.tolerance} onChange={e=>update(index,{tolerance:e.target.value})} required/></label>
     <Button type="button" variant="ghost" onClick={()=>setRules(rows=>rows.filter((_,i)=>i!==index))}>移除此规则</Button>
    </div>
    <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(240px,1fr))',gap:16}}>
     <label className="field">平台类目 ID（精确匹配，每行一个）<textarea aria-label={'平台类目ID '+index} rows={3} value={rule.platformIdText} placeholder="从商品的平台类目 ID 读取" onChange={e=>update(index,{platformIdText:e.target.value})}/></label>
     <label className="field">平台类目名称或完整路径（精确匹配）<textarea aria-label={'平台类目名称 '+index} rows={3} value={rule.platformNameText} placeholder="例如：男士T恤；完整路径使用 > 分隔" onChange={e=>update(index,{platformNameText:e.target.value})}/></label>
     <label className="field">规格列表（每行一个，含 cm / in）<textarea aria-label={'规格列表 '+index} rows={5} value={rule.specText} placeholder="每行一个；无规格规则时可留空" onChange={e=>update(index,{specText:e.target.value})}/></label>
     <label className="field">货号包含关键词（任一命中即可）<textarea aria-label={'货号关键词 '+index} rows={5} value={rule.codeText} placeholder="例如 blanket；每行一个关键词" onChange={e=>update(index,{codeText:e.target.value})}/></label>
    </div>
    <label><input type="checkbox" checked={rule.allowUnmatched} onChange={e=>update(index,{allowUnmatched:e.target.checked})}/> 缺少平台类目时，命中足够规格后允许商品存在其他规格</label>
   </article>)}
   <div className="buttons product-rule-actions" style={{marginTop:16}}><Button type="button" variant="outline" onClick={()=>setRules(rows=>[...rows,{name:'',specText:'',codeText:'',platformIdText:'',platformNameText:'',minMatches:1,tolerance:2,allowUnmatched:false}])}>添加类目</Button><Button type="submit">{busy?'保存中…':'保存并重新匹配'}</Button></div>
  </fieldset></form>
  {error&&<p className="banner danger" role="alert">{error}</p>}
 </section>
}
export function ProductMaintenance({mall,config,product,onSaved,onClose}:{mall:string;config:Row;product:Row;onSaved:()=>void;onClose:()=>void}){
 const [category,setCategory]=useState(product.categoryOverride||'');
 const [specs,setSpecs]=useState<Row>(()=>Object.fromEntries(product.skus.map((sku:Row)=>[sku.skcId+'|'+sku.skuId,sku.maintainedSpecification||''])));
 const [busy,setBusy]=useState(false),[error,setError]=useState('');
 async function submit(event:React.FormEvent){
  event.preventDefault();setBusy(true);setError('');
  try{await save({mall_id:mall,revision:config.revision,action:'product',spuId:product.spuId,category,specifications:specs});onSaved();onClose()}
  catch(e:any){setError(e.message)}finally{setBusy(false)}
 }
 return <div style={{position:'fixed',inset:0,background:'#0006',zIndex:1000,display:'grid',placeItems:'center',padding:20}}>
  <section className="panel product-maintenance" role="dialog" aria-modal="true" aria-labelledby="product-maintenance-title" style={{width:760,maxWidth:'100%',maxHeight:'90vh',overflow:'auto',margin:0}}>
   <h2 id="product-maintenance-title">维护商品 {product.spuId}</h2><p className="panelnote">本地维护值会单独保留。清空后恢复采集值；只用于当前店铺的商品状态与归类。</p>
   <form onSubmit={submit}><fieldset disabled={busy} style={{border:0,padding:0,margin:0}}>
    <label className="field">手动指定类目<select aria-label="手动指定类目" value={category} onChange={e=>setCategory(e.target.value)}><option value="">按平台类目自动匹配</option>{[...new Set<string>([...config.rules.map((r:Row)=>r.name),...(category?[category]:[])])].map(name=><option key={name}>{name}</option>)}</select></label>
    {product.skus.map((sku:Row)=><label className="field" key={sku.skcId+'|'+sku.skuId}><span>SKU {sku.skuId||'待确认'} · 采集规格：{sku.observedSpecification||'缺失'}</span><input aria-label={'维护规格 '+sku.skuId} maxLength={100} placeholder="留空使用采集值；可填写历史或当前实际规格" value={specs[sku.skcId+'|'+sku.skuId]} onChange={e=>setSpecs({...specs,[sku.skcId+'|'+sku.skuId]:e.target.value})}/></label>)}
    <div className="buttons"><Button type="submit">{busy?'保存中…':'保存商品维护'}</Button><Button type="button" variant="outline" onClick={onClose}>取消</Button><Button type="button" variant="ghost" onClick={()=>{setCategory('');setSpecs(Object.fromEntries(Object.keys(specs).map(key=>[key,''])))}}>清空维护值</Button></div>
   </fieldset></form>{error&&<p className="banner danger" role="alert">{error}</p>}
  </section>
 </div>
}
