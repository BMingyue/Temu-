'use client';
import { useState, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import SyncAudit from './sync-audit';
import FlowDetail from './flow-detail';
import {BatchSelectionTools,useBatchSelection} from './batch-selection';
type Row = Record<string, any>;
const labels: Record<string, string> = {
  products: '商品目录',
  activities: '活动价格',
  orders: '订单明细',
  returns: '退货退款',
  ads: '广告日报',
  flow: '店铺流量',
  shipping: '精准物流费',
};
const val = (v: any) =>
  v == null || v === ''
    ? '—'
    : typeof v === 'object'
      ? JSON.stringify(v)
      : String(v);
const columns: Record<string, [string, string][]> = {
  products: [
    ['spuId', 'SPU'],
    ['skcId', 'SKC'],
    ['skuId', 'SKU'],
    ['skuCode', '货号'],
    ['declaredPrice', '申报价*'],
    ['skuCategory', '组合类型'],
  ],
  activities: [
    ['activityName', '活动名称'],
    ['skuId', 'SKU'],
    ['siteName', '站点'],
    ['dailyPrice', '日常价'],
    ['activityPrice', '活动价'],
    ['currency', '来源币种*'],
    ['statusKey', '来源状态'],
  ],
  orders: [
    ['parentConfirmTimeStr', '确认时间'],
    ['orderSn', '子订单'],
    ['skuId', 'SKU'],
    ['originQuantity', '件数'],
    ['money', '供货金额*'],
  ],
  returns: [
    ['afterSalesSn', '售后单'],
    ['orderSn', '子订单'],
    ['productSkuId', 'SKU'],
    ['afterSalesStatusDesc', '状态'],
    ['applyReturnGoodsNumber', '申请退货件数'],
    ['returnGoodsNumber', '退货件数'],
    ['reasonDesc', '原因'],
  ],
  ads: [
    ['date', '报表日期'],
    ['net_ad_spend', '净广告花费'],
    ['total_order_pay_amt', '广告归因支付金额'],
    ['total_order_pay_cnt', '广告归因支付订单'],
    ['total_roas', 'ROAS'],
    ['total_acos', 'ACOS'],
  ],
  flow: [
    ['time_dimension', '统计维度'],
    ['impressionCount', '曝光'],
    ['clickCount', '点击'],
    ['clickImpressionRate', '点击率'],
    ['orderPayOrderNum', '支付订单'],
    ['orderPayGoodsNum', '支付件数'],
  ],
  shipping: [
    ['parent_order_sn', '父订单'],
    ['package_sn', '包裹号'],
    ['tracking_no', '物流单号'],
    ['carrier', '承运商'],
    ['service_name', '服务类型'],
    ['online_shipping_amount_usd', '在线物流费（USD）'],
    ['lookup_status', '查询状态'],
  ],
};
const dimensions: Record<string, string> = {
  '0': '实时',
  '1': '近1日',
  '2': '本周',
  '3': '本月',
  '4': '近7日',
  '5': '近30日',
};
export default function Collector({
  onReview,
  preferredMall = '',
}: {
  onReview: (row: Row) => void;
  preferredMall?: string;
}) {
  const [data, setData] = useState<Row | null>(null),
    [control, setControl] = useState<Row | null>(null),
    [shop, setShop] = useState(''),
    [kind, setKind] = useState('flow'),
    [error, setError] = useState(''),
    [audit, setAudit] = useState<Row[]>([]);
  useEffect(() => {
    setShop(preferredMall);
  }, [preferredMall]);
  const load = useCallback(async () => {
    const [r, controlResponse] = await Promise.all([
      fetch('/api/collector/state?' + new URLSearchParams({ mall_id: shop })),
      fetch('/api/collector/control', { cache: 'no-store' }),
    ]);
    if (!r.ok) throw Error('扩展数据服务未连接');
    setData(await r.json());
    if (controlResponse.ok) setControl(await controlResponse.json());
    const a = await fetch(
      '/api/sync-audit?' + new URLSearchParams({ mall_id: shop }),
    );
    if (a.ok) setAudit(((await a.json()) as Row).items);
    setError('');
  }, [shop]);
  useEffect(() => {
    load().catch((e) => setError(e.message));
    const t = setInterval(
      () => load().catch((e) => setError(e.message)),
      15000,
    );
    return () => clearInterval(t);
  }, [load]);
  const records: Row[] = (data?.records?.[kind] || []).filter((row:Row)=>!shop||String(row._mall_id)===shop),
    receipts: Row[] = data?.receipts || [];
  const cell = (r: Row, key: string) => {
    if (kind === 'flow') {
      if (key === 'time_dimension') return dimensions[r[key]] || val(r[key]);
      const v = r.data?.result?.[key];
      return key === 'clickImpressionRate' && typeof v === 'number'
        ? (v * 100).toFixed(2) + '%'
        : val(v);
    }
    if (kind === 'ads' && key !== 'date')
      return val(r.values?.[key]?.trans_val);
    return val(r[key]);
  };
  const batch=useBatchSelection(records,JSON.stringify([shop,kind]),r=>JSON.stringify([r._mall_id,r._key]));
  const batchColumns=[{label:'店铺',value:(r:Row)=>r._mall_id},...columns[kind].map(([key,label])=>({label,value:(r:Row)=>cell(r,key)}))];
  const visibleShops: Row[] =
    preferredMall && !data?.shops?.some((r: Row) => r.mall_id === preferredMall)
      ? [
          { mall_id: preferredMall, name: '当前浏览器店铺（等待首次同步）' },
          ...(data?.shops || []),
        ]
      : data?.shops || [];
  const name = (id: string) =>
    visibleShops.find((r: Row) => r.mall_id === id)?.name || id;
  const taskMode: Record<string, string> = {
    seller: '订单＋流量＋物流费',
    products: '商品＋活动',
    ads: '广告',
  };
  const taskStatus: Record<string, string> = {
    queued: '等待领取',
    running: '执行中',
    paused: '已暂停',
    finished: '已完成',
    done: '已完成',
    failed: '失败',
  };
  const activeTasks: Row[] = control?.active_tasks || [];
  const recentRuns: Row[] = (control?.task_runs || []).slice(0, 20);
  const recentCommands: Row[] = (control?.commands || []).slice(0, 12);
  const taskSummary = control?.task_summary || control?.summary || {};
  return (
    <>
      <div className="banner">
        <span>
          <strong>已切换至正确源码：Temu 数据采集助手</strong>
          <br />
          扩展只采集发起任务的浏览器当前登录店铺，并把「订单＋流量」「商品＋活动」或「广告」结果保存到本机。尚未收到回执时不显示已连接。
        </span>
      </div>
      <section className="panel">
        <div className="sectionhead">
          <h2>连接检查</h2>
          <span className="tag green">本地页面已打开</span>
        </div>
        <div className="statusrow">
          <span>本地数据服务</span>
          <span className={'tag ' + (data ? 'green' : 'amber')}>
            {data ? '可读取' : '等待连接'}
          </span>
        </div>
        <div className="statusrow">
          <span>最近一次已鉴权同步请求</span>
          <span
            className={
              'tag ' +
              (data?.diagnostic?.status === 'accepted' ? 'green' : 'amber')
            }
          >
            {data?.diagnostic
              ? new Date(data.diagnostic.at).toLocaleString('zh-CN')
              : '尚未收到'}
          </span>
        </div>
        <p className="panelnote">
          {data?.diagnostic?.message ||
            '请检查扩展底部是否有本地工作台按钮。有待传数据就补传，没有按钮说明当前加载的版本尚未包含本地同步。'}
          {data?.diagnostic?.status === 'rejected'
            ? '。本批未入库，请按提示修正后补传。'
            : ''}
        </p>
      </section>
      {error && <div className="banner danger">{error}</div>}
      <section className="panel collector-tasks">
        <div className="sectionhead">
          <div>
            <h2>采集任务中心</h2>
            <p>这里汇总插件上报的实时阶段、进度、预计剩余时间和最近任务结果。</p>
          </div>
          <span className={'tag ' + (activeTasks.length ? 'amber' : 'green')}>
            {activeTasks.length ? `${activeTasks.length} 个任务处理中` : '当前没有运行中任务'}
          </span>
        </div>
        <div className="stats collector-task-stats">
          {[
            ['任务总数', taskSummary.total ?? 0],
            ['等待领取', taskSummary.queued ?? 0],
            ['执行中', taskSummary.running ?? 0],
            ['已完成', taskSummary.finished ?? 0],
            ['失败', taskSummary.failed ?? 0],
          ].map(([label, value]) => (
            <div className="stat" key={String(label)}><span>{label}</span><strong>{value}</strong></div>
          ))}
        </div>
        {!!activeTasks.length && <div className="task-live-grid">
          {activeTasks.map((task) => <article key={task.client_id} className={'task-live ' + task.status}>
            <div><strong>{task.browser || '浏览器'} · {task.store_name || task.mall_id || '识别店铺中'}</strong><span className="tag">{taskStatus[task.status] || task.status}</span></div>
            <p>{taskMode[task.taskMode] || task.taskMode || '采集任务'} · {task.message || task.phase || '正在处理'}</p>
            <div className="task-progress"><i style={{ width: `${Math.max(0, Math.min(100, Number(task.progress || 0)))}%` }} /></div>
            <small>进度 {Number(task.progress || 0).toFixed(0)}%{task.eta ? ` · 预计剩余 ${task.eta}` : ''} · 最近上报 {task.at ? new Date(task.at).toLocaleString('zh-CN') : '—'}</small>
          </article>)}
        </div>}
        {!!recentRuns.length && <details className="task-history" open><summary>最近采集任务：成功、失败与执行记录</summary>
          <div className="tablewrap"><table><thead><tr><th>开始时间</th><th>浏览器 / 店铺</th><th>任务</th><th>状态</th><th>进度</th><th>结果说明</th></tr></thead><tbody>
            {recentRuns.map((task) => <tr key={task.id}><td>{task.startedAt ? new Date(task.startedAt).toLocaleString('zh-CN') : new Date(task.created_at).toLocaleString('zh-CN')}</td><td>{task.browser || '—'}<small>{task.store_name || task.mall_id || '—'}</small></td><td>{taskMode[task.taskMode] || task.taskMode || '—'}</td><td><span className={'tag ' + (task.status === 'failed' ? 'red' : ['done','finished'].includes(task.status) ? 'green' : 'amber')}>{taskStatus[task.status] || task.status}</span></td><td>{Number(task.progress || 0).toFixed(0)}%</td><td>{task.message || task.phase || '—'}</td></tr>)}
          </tbody></table></div>
        </details>}
        {!!recentCommands.length && <details className="task-history"><summary>查看最近 {recentCommands.length} 个工作台发起的任务</summary>
          <div className="tablewrap"><table><thead><tr><th>创建时间</th><th>店铺</th><th>状态</th><th>浏览器</th><th>说明</th></tr></thead><tbody>
            {recentCommands.map((task) => <tr key={task.id}><td>{new Date(task.created).toLocaleString('zh-CN')}</td><td>{name(task.mall_id)}</td><td>{taskStatus[task.status] || task.status}</td><td>{task.claimed_browser || '—'}</td><td>{task.message || '—'}</td></tr>)}
          </tbody></table></div>
        </details>}
      </section>
      <div className="filterbar">
        <select
          aria-label="选择扩展店铺"
          value={shop}
          onChange={(e) => setShop(e.target.value)}
        >
          <option value="">全部已同步店铺</option>
          {visibleShops.map((s: Row) => (
            <option key={s.mall_id} value={s.mall_id}>
              {s.name} · {s.mall_id}
            </option>
          ))}
        </select>
        <span className={'tag ' + (receipts.length ? 'green' : 'amber')}>
          {receipts.length
            ? '已收到本地同步回执'
            : '等待当前浏览器店铺首次同步'}
        </span>
        <Button
          variant="outline"
          onClick={() => load().catch((e) => setError(e.message))}
        >
          刷新接收结果
        </Button>
      </div>
      <SyncAudit items={audit} />
      <FlowDetail
        records={data?.records?.flow || []}
        shops={data?.shops || []}
      />
      <div className="stats">
        {Object.entries(labels).map(([key, label]) => (
          <button
            className="stat"
            style={{
              textAlign: 'left',
              cursor: 'pointer',
              borderColor: kind === key ? '#df6b36' : undefined,
            }}
            onClick={() => setKind(key)}
            key={key}
          >
            <span>{label}</span>
            <strong>{data?.counts?.[key] ?? '—'}</strong>
            <small>
              {key === 'flow'
                ? '店铺维度快照 · 非商品明细'
                : key === 'ads'
                  ? '店铺 × 日期'
                  : '本地去重记录'}{' '}
              · 点击查看
            </small>
          </button>
        ))}
      </div>
      <section className="panel">
        <div className="sectionhead">
          <div>
            <h2>{labels[kind]}</h2>
            <p>
              按店铺 ID
              独立保存。保留采集器提供的统计范围；不把实时、近7日、近30日合计当作日数据。
            </p>
          </div>
          <span className="tag">最多预览 {data?.record_limit || 200} 条</span>
        </div>
        <BatchSelectionTools selection={batch} total={records.length} label={labels[kind]} copyFields={[{label:'SPU',value:(r:Row)=>r.spuId||r.productSpuId},{label:'SKU',value:(r:Row)=>r.skuId||r.productSkuId},{label:'订单号',value:(r:Row)=>r.orderSn||r.parent_order_sn||r.order_sn}]} columns={batchColumns}/>
        {!records.length ? (
          <div className="empty">
            <h3>当前类别没有明细记录</h3>
            <p>
              请先看上方同步核对表：成功返回零条表示本批没有记录，尚未收到则需要执行对应任务。
            </p>
          </div>
        ) : (
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>选择</th><th>店铺</th>
                  {columns[kind].map(([key, label]) => (
                    <th key={key}>{label}</th>
                  ))}
                  <th>
                    {['flow', 'ads'].includes(kind)
                      ? '来源报表'
                      : '采集时间 / 动作'}
                  </th>
                </tr>
              </thead>
              <tbody>
                {batch.visibleRows.map((r) => (
                  <tr key={JSON.stringify([r._mall_id,r._key])} data-batch-selected={batch.isSelected(r)}>
                    <td><input className="batch-row-check" type="checkbox" aria-label={'选择'+labels[kind]+'记录 '+r._mall_id+' '+r._key} checked={batch.isSelected(r)} onChange={event=>batch.toggle(r,event.target.checked)}/></td>
                    <td>
                      {name(r._mall_id)}
                      <small>{r._mall_id}</small>
                    </td>
                    {columns[kind].map(([key]) => (
                      <td key={key}>{cell(r, key)}</td>
                    ))}
                    <td>
                      {['flow', 'ads'].includes(kind) ? (
                        <details>
                          <summary>查看原始指标</summary>
                          <small>
                            采集时间：
                            {new Date(r._captured).toLocaleString('zh-CN', {
                              timeZone: 'Asia/Shanghai',
                            })}
                            （北京时间）
                          </small>
                          <pre
                            style={{
                              maxWidth: 650,
                              maxHeight: 320,
                              overflow: 'auto',
                              fontSize: 12,
                            }}
                          >
                            {JSON.stringify(r.data || r.values, null, 2)}
                          </pre>
                          <small>
                            广告沿用平台格式化数值；流量为各维度汇总，不跨维度相加。
                          </small>
                        </details>
                      ) : (
                        <>
                          <small>
                            {new Date(r._captured).toLocaleString('zh-CN')}
                          </small>
                          <Button
                            variant="ghost"
                            onClick={() =>
                              onReview({
                                title:
                                  r.goodsName ||
                                  r.activityName ||
                                  r.skuCode ||
                                  r.skuId ||
                                  r.productSkuId ||
                                  labels[kind],
                                product_id:
                                  r.spuId ||
                                  r.productSpuId ||
                                  r.skuId ||
                                  r.productSkuId ||
                                  '',
                                shop: name(r._mall_id),
                                site: r.siteName || '',
                                notes:
                                  '来自 ' +
                                  labels[kind] +
                                  '；店铺 ID ' +
                                  r._mall_id +
                                  '；采集时间 ' +
                                  r._captured,
                              })
                            }
                          >
                            记录待办
                          </Button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="panelnote">
          *
          申报价和订单供货金额没有明确币种，暂不合计；活动币种沿用采集器字段，其原代码缺省为
          CNY，需核对。供货金额不当作结算收入或利润。商品采集器未提供标题，因此使用货号和
          ID 展示。未出现在新批次中的旧记录保留，不能据此认定仍在售。
        </p>
      </section>
      <section className="panel">
        <div className="sectionhead">
          <h2>本地同步回执</h2>
        </div>
        {receipts.length ? (
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>采集时间</th>
                  <th>来源浏览器</th>
                  <th>店铺</th>
                  <th>类型</th>
                  <th>接收记录</th>
                  <th>范围</th>
                </tr>
              </thead>
              <tbody>
                {receipts.map((r) => (
                  <tr key={r.id}>
                    <td>{new Date(r.observed_at).toLocaleString('zh-CN')}</td>
                    <td>
                      {r.browser || '旧版本未记录'}
                      {r.client_id && <small>实例 {String(r.client_id).slice(0, 8)}</small>}
                    </td>
                    <td>{r.shop || name(r.mall_id)}</td>
                    <td>{r.label}</td>
                    <td>{r.rows}</td>
                    <td>
                      {r.start_date
                        ? `${r.start_date} 至 ${r.end_date}`
                        : r.coverage}
                      {r.stale_rows_skipped > 0 && (
                        <small>旧数据跳过 {r.stale_rows_skipped} 条</small>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="panelnote">
            当前范围尚未收到回执。历史页面快照与此次扩展同步分别保存。
          </p>
        )}
      </section>
      <div className="banner">
        <span>
          采集器已改为完全本地模式：不按手机号匹配账号，不连接外部看板。Chrome 与 Edge 分别记录自己的浏览器实例和当前店铺，切换店铺时会停止当前任务，避免数据串店。
        </span>
      </div>
    </>
  );
}
