'use client';
import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';

import {BatchSelectionTools,useBatchSelection,batchCellText} from './batch-selection';
import type {BatchColumn} from './batch-selection';
type Row = Record<string, any>;
const iso = (date: Date) => date.toLocaleDateString('sv-SE');
const daysAgo = (days: number) => {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return iso(date);
};
async function read(path: string) {
  const response = await fetch(path, { cache: 'no-store', signal: AbortSignal.timeout(12000) });
  const text = await response.text();
  let value: Row = {};
  try { value = text ? JSON.parse(text) : {}; } catch { throw Error('本地服务返回格式异常'); }
  if (!response.ok || value.error) throw Error(value.error || `读取失败（HTTP ${response.status}）`);
  return value;
}
export default function FeatureCenter({ preferredMall = '', open }: { preferredMall?: string; open?: (tab: string) => void }) {
  const [mall, setMall] = useState(preferredMall);
  const [shops, setShops] = useState<Row[]>([]);
  const [rawCatalog, setCatalog] = useState<Row | null>(null);
  const [rawZeroSales, setZeroSales] = useState<Row | null>(null);
  const [rawPromotion, setPromotion] = useState<Row | null>(null);
  const [dates, setDates] = useState({
    first_start: daysAgo(60),
    first_end: daysAgo(30),
    order_start: daysAgo(30),
    order_end: iso(new Date()),
  });
  const zeroScope=JSON.stringify([mall,dates]);
  const catalog=rawCatalog?.mallId===mall?rawCatalog:null;
  const zeroSales=rawZeroSales?._scope===zeroScope?rawZeroSales:null;
  const promotion=rawPromotion?.mallId===mall?rawPromotion:null;
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  useEffect(() => { if (preferredMall) setMall(preferredMall); }, [preferredMall]);
  useEffect(() => {
    read('/api/collector/state').then((value) => setShops(value.shops || [])).catch((reason) => setError(reason.message));
  }, []);
  async function run(kind: 'catalog' | 'zero' | 'promotion') {
    if (!mall) { setError('请先选择已经同步过数据的店铺'); return; }
    setBusy(kind); setError('');
    try {
      if (kind === 'catalog') setCatalog(await read('/api/features/catalog?' + new URLSearchParams({ mall_id: mall })));
      if (kind === 'zero') setZeroSales({...await read('/api/features/zero-sales?' + new URLSearchParams({ mall_id: mall, ...dates })),_scope:zeroScope});
      if (kind === 'promotion') setPromotion(await read('/api/features/promotion-audit?' + new URLSearchParams({ mall_id: mall })));
    } catch (reason: any) { setError(reason.message); } finally { setBusy(''); }
  }
  function exportZeroSales() {
    const rows: Row[] = zeroSales?.items || [];
    if (!rows.length) return;
    const values = [
      ['SPU', 'SKC', 'SKU数量', '本机首次保存日期', '候选原因', '图片'],
      ...rows.map((item) => [item.spuId, item.skcId, item.skuCount, item.firstSeenLocal, item.reason, item.imageUrl]),
    ];
    const csv = '\ufeff' + values.map((row) => row.map((value) => `"${String(value ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url; link.download = `零销量候选_${mall}_${iso(new Date())}.csv`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const currentShop = useMemo(() => shops.find((shop) => String(shop.mall_id) === mall), [shops, mall]);
  return <div className="feature-center">
    {open && <section className="panel"><div className="sectionhead"><div><h2>流量加速器</h2><p>通过统一工作台插件打开实际操作面板，先核对规则和只读扫描，再按需提交开启。</p></div><span className="tag">已整合 v1.0.6</span></div><Button onClick={() => open('traffic-accelerator')}>进入流量加速器</Button></section>}
    <div className="banner">
      <span><strong>本地只读运营辅助</strong><br />使用当前浏览器对应店铺已经采集到本机的数据。核查结果不会自动报名活动、调价、加入加速器或下架商品。</span>
    </div>
    {error && <div className="banner danger">{error}</div>}
    <section className="panel">
      <div className="sectionhead"><div><h2>分析范围</h2><p>每个浏览器只处理自己当前登录店铺的数据，不按手机号绑定。</p></div><span className="tag green">本地计算</span></div>
      <div className="filterbar">
        <select aria-label="运营辅助店铺" value={mall} onChange={(event) => setMall(event.target.value)}>
          <option value="">选择店铺</option>
          {preferredMall && !shops.some((shop) => String(shop.mall_id) === preferredMall) && <option value={preferredMall}>当前浏览器店铺 · {preferredMall}</option>}
          {shops.map((shop) => <option value={shop.mall_id} key={shop.mall_id}>{shop.name || '未命名店铺'} · {shop.mall_id}</option>)}
        </select>
        <span className="tag">{currentShop?.name || (mall ? '当前浏览器店铺' : '尚未选择')}</span>
        <Button variant="outline" disabled={!mall || !!busy} onClick={() => run('catalog')}>{busy === 'catalog' ? '读取中…' : '核对本地商品目录'}</Button>
      </div>
      {catalog && <div className="metricgrid"><div><strong>{catalog.productCount || 0}</strong><span>本地商品款数</span></div><div><strong>{(catalog.products || []).reduce((sum: number, item: Row) => sum + (item.skus?.length || 0), 0)}</strong><span>本地 SKU 数</span></div><div><strong>{(catalog.products || []).filter((item: Row) => item.isActive).length}</strong><span>本地显示在售</span></div></div>}
    </section>

    <section className="panel">
      <div className="sectionhead"><div><h2>零销量候选核查</h2><p>只有订单回执完整覆盖所选日期时才给出候选，结果仍需人工核对。</p></div><span className="tag">只读</span></div>
      <div className="feature-date-grid">
        {[
          ['first_start', '本机首次保存开始'],
          ['first_end', '本机首次保存结束'],
          ['order_start', '订单范围开始'],
          ['order_end', '订单范围结束'],
        ].map(([key, label]) => <label className="field" key={key}><span>{label}</span><input type="date" value={dates[key as keyof typeof dates]} onChange={(event) => setDates({ ...dates, [key]: event.target.value })} /></label>)}
      </div>
      <div className="buttons"><Button disabled={!mall || !!busy} onClick={() => run('zero')}>{busy === 'zero' ? '核查中…' : '开始核查'}</Button><small>“首次”目前明确采用本机首次保存日期，不冒充平台首次入站日期。</small></div>
      {zeroSales && !zeroSales.safe && <div className="banner danger">{zeroSales.coverage?.message || '订单范围不完整，已停止判断'}</div>}
      {zeroSales?.safe && <>
        <div className="metricgrid"><div><strong>{zeroSales.candidateCount || 0}</strong><span>候选 SKC</span></div><div><strong>{zeroSales.soldSkcCount || 0}</strong><span>范围内有销量 SKC</span></div></div>
        {!!zeroSales.items?.length && <div className="buttons"><Button variant="outline" onClick={exportZeroSales}>导出候选 CSV</Button><small>导出仅用于人工复核，不会创建下架任务。</small></div>}
        <SelectablePreview rows={zeroSales.items||[]} scope={zeroScope} label="零销量候选" columns={[{label:'SPU',value:item=>item.spuId},{label:'SKC',value:item=>item.skcId},{label:'本机首次保存',value:item=>item.firstSeenLocal},{label:'SKU数',value:item=>item.skuCount},{label:'候选原因',value:item=>item.reason}]} showImage/>
      </>}
    </section>

    <section className="panel">
      <div className="sectionhead"><div><h2>活动价格与加速器资格预览</h2><p>检查本地活动价、日常价、折扣和申报价缺失；目标价仅供人工核对。</p></div><span className="tag amber">不会提交平台</span></div>
      <Button disabled={!mall || !!busy} onClick={() => run('promotion')}>{busy === 'promotion' ? '检查中…' : '读取本地活动数据'}</Button>
      {promotion && <>
        <div className="metricgrid"><div><strong>{promotion.productCount || 0}</strong><span>商品款数</span></div><div><strong>{promotion.activitySafetyPreview?.length || 0}</strong><span>已读取活动价格 SKU</span></div><div><strong>{promotion.issues?.length || 0}</strong><span>数据问题</span></div><div><strong>{promotion.acceleratorCandidateCount || 0}</strong><span>加速器候选</span></div></div>
        <div className={'banner ' + (promotion.pricePresetAvailable ? 'success' : 'danger')}>{promotion.pricePresetAvailable ? `安全价采用当前店铺价格预设：${promotion.pricePreset}` : '当前店铺没有可用价格预设，因此只展示活动价，不把任何价格标记为安全，也不生成加速器候选。'}</div>
        {!!promotion.issues?.length && <details open><summary>查看数据问题</summary><SelectablePreview rows={promotion.issues} scope={mall} label="活动数据问题" columns={[{label:'SPU',value:item=>item.spuId},{label:'SKC',value:item=>item.skcId},{label:'SKU',value:item=>item.skuId},{label:'问题',value:item=>item.issue}]}/></details>}
        {!!promotion.activitySafetyPreview?.length && <details><summary>查看多活动最低安全价预览</summary><SelectablePreview rows={promotion.activitySafetyPreview} scope={mall} label="活动安全价" columns={[{label:'SPU',value:item=>item.spuId},{label:'SKU',value:item=>item.skuId},{label:'规格',value:item=>item.specification},{label:'本地底线',value:item=>item.floor},{label:'最低活动价',value:item=>item.lowestLocalActivityPrice},{label:'最低安全价',value:item=>item.lowestSafeObservedPrice},{label:'低于底线活动',value:item=>item.unsafeActivityCount},{label:'状态',value:item=>item.status}]}/></details>}
        {!!promotion.acceleratorPreview?.length && <SelectablePreview rows={promotion.acceleratorPreview} scope={mall} label="加速器资格预览" columns={[{label:'SPU',value:item=>item.spuId},{label:'SKU',value:item=>item.skuId},{label:'活动',value:item=>item.activityName},{label:'活动价',value:item=>item.activityPrice},{label:'折扣',value:item=>(Number(item.discountRate)*100).toFixed(1)+'%'},{label:'预览目标价',value:item=>item.previewTargetPrice},{label:'状态',value:item=>item.status}]}/>}
      </>}
      <p className="panelnote">加速器候选仅按本地活动记录计算“活动价＋0.01”的预览值；平台实时资格、价格底线、库存和活动冲突仍需在商家后台确认。</p>
    </section>
  </div>;
}


function SelectablePreview({rows,scope,label,columns,showImage=false}:{rows:Row[];scope:string;label:string;columns:BatchColumn<Row>[];showImage?:boolean}){
 const batch=useBatchSelection(rows,scope,item=>JSON.stringify([item.spuId,item.skcId,item.skuId,item.issue]));
 return <><BatchSelectionTools selection={batch} total={rows.length} label={label} copyFields={[{label:'SPU',value:item=>item.spuId},{label:'SKC',value:item=>item.skcId},{label:'SKU',value:item=>item.skuId||item.skuIds}]} columns={columns}/><div className="tablewrap"><table><thead><tr><th>选择</th>{showImage&&<th>图片</th>}{columns.map(column=><th key={column.label}>{column.label}</th>)}</tr></thead><tbody>{batch.visibleRows.map((item,index)=><tr key={index} data-batch-selected={batch.isSelected(item)}><td><input className="batch-row-check" type="checkbox" aria-label={'选择'+label+' SPU '+item.spuId+' '+(item.skuId||item.skcId||index)} checked={batch.isSelected(item)} onChange={event=>batch.toggle(item,event.target.checked)}/></td>{showImage&&<td>{item.imageUrl?<img className="feature-thumb" src={item.imageUrl} alt=""/>:'—'}</td>}{columns.map(column=><td key={column.label}>{batchCellText(column.value(item))||'—'}</td>)}</tr>)}</tbody></table></div></>;
}

