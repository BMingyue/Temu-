'use client';
type Row=Record<string,any>;
const labels:Record<string,string>={missing:'尚未收到',received:'已接收本批',empty:'成功返回零条',partial:'范围待补齐'};
export default function SyncAudit({items}:{items:Row[]}){
 return <section className="panel"><div className="sectionhead"><div><h2>这次同步齐了哪些数据</h2><p>逐店核对上传回执与本地记录。已接收本批不等于平台全量数据已经采齐。</p></div></div>{items.length?<div className="tablewrap"><table><thead><tr><th>店铺</th><th>数据类别</th><th>同步情况</th><th>核对结果</th><th>下一步</th></tr></thead><tbody>{items.map(r=><tr key={r.mall_id+r.dataset}><td>{r.shop}</td><td>{r.label}</td><td><span className={'tag '+(['received','empty'].includes(r.status)?'green':'amber')}>{labels[r.status]}</span></td><td style={{minWidth:260,maxWidth:480,lineHeight:1.8}}>{r.detail}{r.ad_coverage?.missing_dates?.length>0&&<details><summary>查看缺失日期</summary><small>{r.ad_coverage.missing_dates.join('、')}</small></details>}</td><td style={{maxWidth:220,lineHeight:1.8}}>{r.next_action||'本批无需重复补传'}</td></tr>)}</tbody></table></div>:<p className="panelnote">收到第一份采集回执后会按店铺列出缺失项目。</p>}</section>;
}
