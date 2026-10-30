'use client';
import {ShieldCheck} from 'lucide-react';

export default function Delisting(){
 return <>
  <section className="panel">
   <div className="sectionhead"><div><h2>商品批量下架助手</h2><p>原“商品批量下架助手 v1.1.0”已经合并到 Temu 数据采集助手 0.15.0。</p></div><span className="tag green">已加入扩展</span></div>
   <div className="listingsteps">{[
    '在商品列表勾选目标商品，复制 SKC ID；如实际复制的是 SKU 或 SPU，请在助手里选择对应类型',
    '点击页面右下角“下架”，读取剪贴板并检查编号、类型和下架原因',
    '第一次保持演练模式，只填写第一条，不会点击“申请下架”',
    '核对平台表单正确后关闭演练模式，再确认正式逐条提交'
   ].map((step,index)=><div key={step}><b>0{index+1}</b><p>{step}</p></div>)}</div>
   <div className="buttons"><a className="external" href="https://agentseller.temu.com/goods/list" target="_blank" rel="noreferrer">打开 Temu 商品列表 ↗</a></div>
   <p className="panelnote">打开后点击页面右下角的“下架”圆形按钮。正式执行期间请保持该标签页可见，不要同时操作客服窗口。</p>
  </section>
  <section className="panel">
   <div className="sectionhead"><div><h2>下架安全保护</h2><p>这些规则来自原插件，并在合并后继续保留。</p></div><ShieldCheck size={24}/></div>
   <div className="statusrow"><span>默认启动方式</span><span className="tag green">演练模式</span></div>
   <div className="statusrow"><span>正式提交</span><span className="tag amber">显示数量、编号类型和原因后再次确认</span></div>
   <div className="statusrow"><span>重复编号</span><span className="tag">自动去重并跳过成功历史</span></div>
   <div className="statusrow"><span>运行控制</span><span className="tag">支持暂停和安全停止</span></div>
   <div className="statusrow"><span>平台页面改版</span><span className="tag red">找不到准确按钮时停止，不盲点</span></div>
   <p className="panelnote">下架会向平台提交真实申请且可能难以撤销。工作台不会自动从经营数据中决定哪些商品应该下架，编号仍由你人工选择。</p>
  </section>
 </>;
}
