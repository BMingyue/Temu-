'use client';
import {useState} from 'react';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {BatchSelectionTools,useBatchSelection} from './batch-selection';
type Row=Record<string,any>;
const num=(v:any)=>v==null?'—':Number(v).toLocaleString('zh-CN',{maximumFractionDigits:2});
export default function Traffic({rows,captures,onReview}:{rows:Row[],captures:Row[],onReview:(row:Row)=>void}){
 const [scope,setScope]=useState(''),[day,setDay]=useState(''),[search,setSearch]=useState('');
 const scopes=[...new Set(rows.map(r=>r.shop+' · '+r.site))];
 const chosen=scopes.includes(scope)?scope:scopes[0]||'';
 const scoped=rows.filter(r=>r.shop+' · '+r.site===chosen);
 const days=[...new Set(scoped.map(r=>r.date))].sort().reverse();
 const selected=days.includes(day)?day:days[0]||'';
 const all=scoped.filter(r=>r.date===selected);
 const receipt=captures.find(r=>r.shop+' · '+r.site===chosen&&r.date===selected);
 const summary=receipt?.summary||{};
 const filtered=all.filter(r=>(r.title+' '+r.product_id).toLowerCase().includes(search.toLowerCase())).sort((a,b)=>(b.impressions??-1)-(a.impressions??-1));
 const batch=useBatchSelection(filtered,JSON.stringify([chosen,selected,search]),r=>String(r.product_id));
 const mismatch=(r:Row)=>/notebook|journal|planner/i.test(r.title)&&/小盖毯|午休毯/.test(r.product_info||'');
 return <><div className="banner"><span>此前从浏览器读取的单次页面快照，保留供参考。当前正确扩展的数据请在“经营数据接入”查看；此处不表示扩展已接通。</span></div>
 <div className="filterbar"><select aria-label="流量店铺" value={chosen} onChange={e=>{setScope(e.target.value);setDay('')}}>{scopes.map(s=><option key={s}>{s}</option>)}</select><select aria-label="后台统计日期" value={selected} onChange={e=>setDay(e.target.value)}>{days.map(d=><option key={d}>{d}</option>)}</select><span>北京时间 · 单日 · SPU</span></div>
 {!rows.length?<section className="panel"><h2>等待扩展传入第一份流量数据</h2><p>在已登录的美国站后台选择「商品流量」，将汇总和明细都设为同一天，再从扩展开始采集。</p></section>:<>
 <section className="panel"><div className="sectionhead"><div><h2>平台汇总 · {selected}</h2><p>来自后台顶部汇总分析，范围以该页面为准；与下方部分商品明细分开保存。</p></div><span className="tag green">真实后台数据</span></div><div className="stats">{[['曝光量','impressions'],['点击量','clicks'],['支付订单','orders'],['点击率','ctr']].map(([label,key])=><div className="stat" key={key}><span>{label}</span><strong>{num(summary[key])}{key==='ctr'&&summary[key]!=null?'%':''}</strong><small>{chosen}</small></div>)}</div><p className="panelnote">最近采集：{receipt?.observed_at?new Date(receipt.observed_at).toLocaleString('zh-CN'):'—'}。没有结算与成本数据，不计算利润。</p></section>
 <section className="panel"><div className="sectionhead"><div><h2>已采集商品 · {all.length} 款</h2><p>最近页面显示总数 {num(receipt?.displayed_total)} 条。不同筛选页可能合并至此，始终按部分采集处理。</p></div><span className="tag amber">未确认全量</span></div><div className="tabletools"><Input aria-label="搜索流量商品" placeholder="搜索标题或 SPU" value={search} onChange={e=>setSearch(e.target.value)}/></div><BatchSelectionTools selection={batch} total={filtered.length} label="商品流量" copyFields={[{label:'SPU',value:r=>r.product_id}]} columns={[{label:'SPU',value:r=>r.product_id},{label:'标题',value:r=>r.title},{label:'曝光',value:r=>r.impressions},{label:'点击',value:r=>r.clicks},{label:'订单',value:r=>r.orders},{label:'观察',value:r=>r.reason}]}/><div className="tablewrap"><table><thead><tr><th>选择</th><th>商品 / SPU</th><th>曝光</th><th>点击</th><th>点击率*</th><th>支付订单</th><th>搜索曝光 / 点击</th><th>推荐曝光 / 点击</th><th>观察与待办</th><th/></tr></thead><tbody>{batch.visibleRows.map(r=><tr key={r.product_id} data-batch-selected={batch.isSelected(r)}><td><input className="batch-row-check" type="checkbox" aria-label={'选择流量 SPU '+r.product_id} checked={batch.isSelected(r)} onChange={e=>batch.toggle(r,e.target.checked)}/></td><td><strong>{r.title}</strong><small>{r.product_id}</small></td><td>{num(r.impressions)}</td><td>{num(r.clicks)}</td><td>{num(r.ctr)}{r.ctr!=null?'%':''}</td><td>{num(r.orders)}</td><td>{num(r.search_impressions)} / {num(r.search_clicks)}</td><td>{num(r.recommend_impressions)} / {num(r.recommend_clicks)}</td><td className="actioncell"><span className="tag amber">{r.reason}</span><small>{r.action}</small>{mismatch(r)&&<small className="negative">标题含笔记本或计划本用词，请核对商品表达与毛毯类目是否一致。</small>}</td><td><Button variant="ghost" onClick={()=>onReview(r)}>记录动作</Button></td></tr>)}</tbody></table></div><p className="panelnote">* 点击率按已读取的点击 ÷ 曝光计算。— 表示后台未提供；0 是明确为零。小样本下的高点击率不代表爆款。观察线可在设置中调整。</p></section>
 <section className="panel"><div className="sectionhead"><h2>采集回执</h2></div>{captures.filter(r=>r.shop+' · '+r.site===chosen).slice(0,8).map(r=><div className="statusrow" key={r.digest}><span>{r.date} · {r.received} 款 · {new Date(r.observed_at).toLocaleString('zh-CN')}</span><span className="tag">部分页面</span></div>)}</section></>}
 </>;
}
