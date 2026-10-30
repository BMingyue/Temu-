'use client';
import {useState} from 'react';
type Row=Record<string,any>;
const names=['实时','近1日','本周','本月','近7日','近30日'];
const number=(v:any)=>typeof v==='number'?v.toLocaleString('zh-CN'):'—';
const beijing=(v:string)=>new Date(v).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});
export default function FlowDetail({records,shops}:{records:Row[],shops:Row[]}){
 const [mall,setMall]=useState(''),[dimension,setDimension]=useState(0);
 const available=shops.filter(s=>records.some(r=>r._mall_id===s.mall_id));
 const selected=available.some(s=>s.mall_id===mall)?mall:available[0]?.mall_id;
 const row=records.find(r=>r._mall_id===selected&&r.time_dimension===dimension);
 const result=row?.data?.result||{},trend=row?.data?.trend_response;
 const series:Row[]=trend?.success===false?[]:trend?.result?.trendList||[];
 const channels:Row[]=trend?.result?.channelList||[];
 return <section className="panel"><div className="sectionhead"><div><h2>曝光与后台逐项核对</h2><p>实时是采集当时的累计值；历史每日曝光来自趋势报表，多个维度不能相加。</p></div></div>
 <div className="filterbar"><select aria-label="流量核对店铺" value={selected||''} onChange={e=>setMall(e.target.value)}>{available.map(s=><option key={s.mall_id} value={s.mall_id}>{s.name}</option>)}</select><select aria-label="流量统计范围" value={dimension} onChange={e=>setDimension(Number(e.target.value))}>{names.map((s,i)=><option key={i} value={i}>{s}</option>)}</select></div>
 {!row?<p className="panelnote">尚未收到这一店铺和维度的报表。</p>:<><p><strong>本批采集时间：{beijing(row.data?.overview_received_at||row._captured)}（北京时间）</strong></p><p className="panelnote">来源：商品流量汇总接口。{row.data?.source_page&&<>页面：{row.data.source_page}。 </>}现有采集记录没有保存站点标识，暂不能自动证明与后台所选站点一致。接口 pt={result.pt||'未提供'}，不将此字段作为实时日期；下表保留趋势接口原始时间。</p>
 <div className="stats">{[['impressionCount','商品曝光量'],['clickCount','商品点击量'],['orderPayOrderNum','支付订单'],['orderPayGoodsNum','支付件数']].map(([key,label])=><div className="stat" key={key}><span>{label}</span><strong>{number(result[key])}</strong><small>{names[dimension]} · {dimension===0?'非全天最终值':'来源汇总'}</small></div>)}</div>
 <p>点击率 {typeof result.clickImpressionRate==='number'?(result.clickImpressionRate*100).toFixed(2)+'%':'—'} · 点击订单转化率 {typeof result.clickOrderRatio==='number'?(result.clickOrderRatio*100).toFixed(2)+'%':'—'}</p>
 {!series.length&&<p className="panelnote">趋势接口未返回可用序列，不能据汇总推算每天曝光。</p>}
 {series.map((s:Row,index:number)=>{const points:Row[]=s.trendList||[];const numeric=points.length>0&&points.every(p=>typeof p.value==='number');const sum=numeric?points.reduce((n,p)=>n+p.value,0):null;return <details key={s.key||index} open={index===0}><summary>{s.key||'未命名序列'} · {points[0]?.time||'无日期'} 至 {points.at(-1)?.time||'无日期'} · 曝光合计 {number(sum)}{index===0&&sum!==null&&typeof result.impressionCount==='number'?(sum===result.impressionCount?' · 与汇总一致':' · 与汇总不同，请核对报表更新时间'):''}</summary><div className="tablewrap" style={{maxHeight:380,overflow:'auto'}}><table><thead><tr><th>平台时间</th><th>曝光</th>{index===0&&channels.map(c=><th key={c.key}>{c.key}</th>)}</tr></thead><tbody>{points.map((p:Row)=>{const parts=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hourCycle:'h23'}).format(new Date(row._captured));const future=dimension===0&&s.key==='今日数据'&&/^\d{2}-\d{2} \d{2}$/.test(p.time)&&p.time>parts.slice(5,10)+' '+parts.slice(-2);return <tr key={p.time}><td>{p.time}{future&&<small>采集时尚未到达</small>}</td><td>{future?'—':number(p.value)}</td>{index===0&&channels.map(c=><td key={c.key}>{future?'—':number(c.trendList?.find((v:Row)=>v.time===p.time)?.value)}</td>)}</tr>})}</tbody></table></div></details>})}
 <p className="panelnote">趋势目前只采集曝光；没有逐日点击、订单数据时不补零。对比期单独展示。汇总和趋势是先后请求，实时可能存在少量差异。</p></>}
 </section>;
}
