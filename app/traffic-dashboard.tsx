'use client';
import { useCallback, useEffect, useState } from 'react';
import {useWorkbenchMode} from './workbench-mode';
import {
  Area,
  AreaChart,
  Line,
  LineChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
type Row = Record<string, any>;
const dimensions = [
  [0, '实时'],
  [1, '近1日'],
  [4, '近7日'],
  [5, '近30日'],
  [2, '本周'],
  [3, '本月'],
] as const;
const metrics = [
  ['impressionCount', '商品曝光量', false],
  ['clickCount', '商品点击量', false],
  ['orderPayOrderNum', '支付订单数', false],
  ['orderPayGoodsNum', '支付件数', false],
  ['clickImpressionRate', '点击率', true],
  ['clickOrderRatio', '点击订单转化率', true],
  ['orderPayImpressionRate', '曝光订单转化率', true],
] as const;
const numeric = (v: any) => typeof v === 'number' && Number.isFinite(v);
const value = (v: any, rate = false) =>
  numeric(v)
    ? rate
      ? (v * 100).toFixed(2) + '%'
      : v.toLocaleString('zh-CN')
    : '未采集';
const timestamp = (v: any) => {
  const parsed = typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};
const time = (v: any) =>
  timestamp(v)
    ? new Date(timestamp(v)).toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        hour12: false,
      })
    : '未记录';
const colors = ['#ff8200', '#526f88', '#ffd51a'];
const taskStatuses: Record<string, string> = {
  queued: '等待插件', running: '采集中', paused: '已暂停',
  done: '任务结束', finished: '任务结束', failed: '未完成',
};
const taskPhases: Record<string, string> = {
  discover: '识别店铺', flow: '采集流量', orders: '采集订单',
  money: '补全订单金额', shipping: '采集物流费用', returns: '采集退货退款',
  done: '任务结束',
};
export default function TrafficDashboard({
  open,
  preferredMall = '',
  preferredStore = '',
  preferredClient = '',
}: {
  open: (tab: string) => void;
  preferredMall?: string;
  preferredStore?: string;
  preferredClient?: string;
}) {
  const {professional} = useWorkbenchMode();
  const [historical, setHistorical] = useState(false),
    [historyDay, setHistoryDay] = useState(''),
    [historyId, setHistoryId] = useState(''),
    [history, setHistory] = useState<Row>({}),
    [historyError, setHistoryError] = useState(''),
    [historyLoading, setHistoryLoading] = useState(false);
  const [control, setControl] = useState<Row>({}),
    [syncMessage, setSyncMessage] = useState(''),
    [syncBusy, setSyncBusy] = useState(false);
  const [snapshot, setSnapshot] = useState<Row>({}),
    [mall, setMall] = useState(''),
    [dimension, setDimension] = useState(0),
    [error, setError] = useState('');
  useEffect(() => {
    setMall(preferredMall);
  }, [preferredMall]);
  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/collector/state');
      if (!r.ok) throw Error('本地数据服务暂时不可用');
      setSnapshot(await r.json());
      const c = await fetch('/api/collector/control');
      if (c.ok) setControl(await c.json());
      setError('');
    } catch (e: any) {
      setError(e.message);
    }
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load]);
  const storedShops: Row[] = snapshot.shops || [];
  const shops: Row[] =
    preferredMall && !storedShops.some((s) => s.mall_id === preferredMall)
      ? [
          {
            mall_id: preferredMall,
            name: preferredStore || '当前浏览器店铺 ' + preferredMall,
            pending_first_sync: true,
          },
          ...storedShops,
        ]
      : storedShops;
  const selected = shops.some((s) => s.mall_id === mall)
    ? mall
    : shops.some((s) => s.mall_id === preferredMall)
      ? preferredMall
      : shops[0]?.mall_id;
  useEffect(() => {
    if (!historical || !selected) return;
    let live = true;
    setHistoryLoading(true);
    setHistory({});
    setHistoryError('');
    fetch(
      '/api/collector/flow-history?mall_id=' +
        encodeURIComponent(selected) +
        '&day=' +
        encodeURIComponent(historyDay),
    )
      .then(async (r) => {
        const v = (await r.json()) as Row;
        if (!r.ok) throw Error(v.error || '历史记录读取失败');
        return v;
      })
      .then((v) => {
        if (live) {
          setHistory(v);
          setHistoryId(v.snapshots?.[0]?.id || '');
        }
      })
      .catch((e) => {
        if (live) setHistoryError(e.message);
      })
      .finally(() => {
        if (live) setHistoryLoading(false);
      });
    return () => {
      live = false;
    };
  }, [historical, selected, historyDay]);
  const historyRow = history.snapshots?.find((h: Row) => h.id === historyId);
  const records: Row[] = historical
    ? historyRow?.records || []
    : snapshot.records?.flow || [];
  const row = records.find(
      (r) => r._mall_id === selected && r.time_dimension === dimension,
    ),
    data = row?.data || {},
    summary = data.result || {};
  const trend =
    data.trend_response?.success === false
      ? {}
      : data.trend_response?.result || {};
  const series: Row[] = trend.trendList || [],
    channels: Row[] = trend.channelList || [];
  const length = Math.max(0, ...series.map((s) => s.trendList?.length || 0));
  const points = Array.from({ length }, (_, i) => {
    const p: Row = {
      label:
        series[0]?.trendList?.[i]?.time ||
        series[1]?.trendList?.[i]?.time ||
        String(i),
    };
    series.forEach((s, j) => {
      const v = s.trendList?.[i];
      p['v' + j] = numeric(v?.value) ? v.value : null;
      p['time' + j] = v?.time;
    });
    return p;
  });
  const channelTimes = [
    ...new Set<string>(
      channels.flatMap((c) =>
        (c.trendList || []).map((p: Row) => String(p.time)),
      ),
    ),
  ].sort();
  const channelPoints = channelTimes.map((t) => {
    const p: Row = { label: t };
    channels.forEach((c, i) => {
      const v = c.trendList?.find((x: Row) => String(x.time) === t)?.value;
      p['v' + i] = numeric(v) ? v : null;
    });
    return p;
  });
  const tick = (v: string) =>
    /^\d{2}-\d{2} \d{2}$/.test(v) ? v.slice(-2) + ':00' : v;
  const current = records.find(
      (r) => r._mall_id === selected && r.time_dimension === 0,
    ),
    previous = records.find(
      (r) => r._mall_id === selected && r.time_dimension === 1,
    );
  const captured = data.overview_received_at || row?._captured;
  const stale =
    captured && Date.now() - Date.parse(captured) > 24 * 60 * 60 * 1000;
  async function collectNow() {
    setSyncBusy(true);
    try {
      const r = await fetch('/api/collector/collect-now', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Workbench': 'local' },
        body: JSON.stringify({ mall_id: selected, ...(preferredClient ? { client_id: preferredClient } : {}) }),
      });
      const result = (await r.json()) as Row;
      if (!r.ok) throw Error(result.error);
      setSyncMessage(result.message);
      await load();
    } catch (e: any) {
      setSyncMessage(e.message);
    } finally {
      setSyncBusy(false);
    }
  }
  const scopedClient = preferredClient
    ? control.clients?.[preferredClient]
    : null;
  const matchingClients = (Object.values(control.clients || {}) as Row[])
    .filter((client) => selected && client.mall_id === selected)
    .sort((a, b) => timestamp(b.at) - timestamp(a.at));
  const connection = preferredClient
    ? scopedClient?.mall_id === selected ? scopedClient : null
    : matchingClients[0] || (selected && control.heartbeat?.mall_id === selected ? control.heartbeat : null);
  const differentClientShop = preferredClient && scopedClient && scopedClient.mall_id !== selected;
  const autoState = connection?.auto_state;
  const connected =
    timestamp(connection?.at) && Date.now() - timestamp(connection.at) < 90000;
  const recentTasks: Row[] = (control.task_runs || [])
    .filter((task: Row) => selected && task.mall_id === selected && task.taskMode === 'seller' &&
      (!preferredClient || task.client_id === preferredClient))
    .sort((a: Row, b: Row) =>
      (timestamp(b.endedAt) || timestamp(b.startedAt) || timestamp(b.created_at)) -
      (timestamp(a.endedAt) || timestamp(a.startedAt) || timestamp(a.created_at)))
    .slice(0, 5);
  const recentCommands: Row[] = (control.commands || [])
    .filter((command: Row) => selected && command.mall_id === selected && (!command.kind || command.kind === 'flow') &&
      (!preferredClient || !(command.claimed_by || command.target_client) ||
        (command.claimed_by || command.target_client) === preferredClient))
    .sort((a: Row, b: Row) => timestamp(b.created) - timestamp(a.created))
    .slice(0, 5);
  return (
    <section className="temu-traffic">
      <div className="tt-top">
        <div>
          <h2>商品流量</h2>
          <span className="tt-tab">商品流量</span>
        </div>
        <div className="tt-actions">
          <select
            aria-label="选择店铺"
            value={selected || ''}
            onChange={(e) => setMall(e.target.value)}
          >
            {!shops.length && <option>尚未同步店铺</option>}
            {shops.map((s) => (
              <option key={s.mall_id} value={s.mall_id}>
                {s.name || s.mall_id}
                {s.pending_first_sync ? ' · 等待首次采集' : ''}
              </option>
            ))}
          </select>
          <button disabled={syncBusy || !selected} onClick={collectNow}>
            立即采集并同步
          </button>
          <button onClick={load}>刷新记录</button>
          <button onClick={() => open('collector')}>采集详情</button>
          <a
            href="https://agentseller-us.temu.com/main/flux-analysis"
            target="_blank"
            rel="noreferrer"
          >
            打开商家后台 ↗
          </a>
        </div>
      </div>
      <div className="tt-notice">
        <label>
          <input
            type="checkbox"
            checked={historical}
            onChange={(e) => setHistorical(e.target.checked)}
          />{' '}
          查看历史快照
        </label>
        {historical && (
          <div className="tt-actions">
            <label>
              日期（北京时间）
              <input
                type="date"
                value={historyDay || history.day || ''}
                onChange={(e) => setHistoryDay(e.target.value)}
              />
            </label>
            <label>
              已有记录日期
              <select
                aria-label="已有记录日期"
                value={historyDay || history.day || ''}
                onChange={(e) => setHistoryDay(e.target.value)}
              >
                {history.dates?.map((d: string) => (
                  <option key={d}>{d}</option>
                ))}
              </select>
            </label>
            <label>
              采集时间
              <select
                aria-label="历史采集时间"
                value={historyId}
                onChange={(e) => setHistoryId(e.target.value)}
                disabled={historyLoading}
              >
                {!history.snapshots?.length && (
                  <option value="">当天没有记录</option>
                )}
                {history.snapshots?.map((h: Row) => (
                  <option key={h.id} value={h.id}>
                    {time(h.captured)} ·{' '}
                    {h.records
                      ?.map(
                        (r: Row) =>
                          dimensions.find(
                            (d) => d[0] === r.time_dimension,
                          )?.[1] || r.time_dimension,
                      )
                      .join('、')}
                  </option>
                ))}
              </select>
            </label>
            <button onClick={() => setHistorical(false)}>返回最新数据</button>
          </div>
        )}
        {historical && (
          <p>
            {historyLoading
              ? '正在读取历史记录…'
              : historyError ||
                `当天保存了 ${history.snapshots?.length || 0} 批快照。展示当次采集原值；未采集时刻和范围不会补齐。`}
          </p>
        )}
      </div>
      <div className="tt-notice">
        <strong>
          {connected
            ? `${connection?.browser || '当前浏览器'}采集插件已连接`
            : differentClientShop
              ? '当前浏览器绑定其他店铺，未显示其采集状态'
              : '所选店铺采集插件未连接或未收到近期心跳'}
        </strong>
        <br />
        所选店铺：
        {connection?.store_name ||
          shops.find((shop) => shop.mall_id === selected)?.name ||
          selected ||
          '等待识别'} ·
        最近连接：{time(connection?.at)} · 插件版本：
        {connection?.version || '未知'}
        <br />
        插件最近消息：{connection?.message ||
          '请重新加载 Temu 数据采集助手，并保持当前浏览器已登录的店铺页面打开。'}
        <p>
          自动更新：{autoState?.enabled === true ? '已开启' : autoState?.enabled === false ? '已暂停' : '未上报'}
        </p>
        {autoState?.flow_error && <p role="status">自动流量提示：{autoState.flow_error}</p>}
        {syncMessage && <p role="status">{syncMessage}</p>}
      </div>
      {professional&&<details className="tt-audit" open>
        <summary>当前店铺最近采集记录（北京时间）</summary>
        {recentTasks.map((task: Row) => (
          <p key={task.id}>
            开始：{time(task.startedAt || task.created_at)} · 插件手动订单＋流量任务 ·{' '}
            {taskStatuses[task.status] || task.status}
            <br />
            {task.browser || '浏览器未记录'} · 当前阶段：{taskPhases[task.phase] || task.phase || '未记录'}
            {task.message && <> · {task.message}</>}
            {task.endedAt ? <> · 结束：{time(task.endedAt)}</> : null}
          </p>
        ))}
        {recentCommands.map((c: Row) => (
            <p key={c.id}>
              {time(c.created)} · 工作台流量采集请求 ·{' '}
              {taskStatuses[c.status] || c.status}
              <br />
              {c.message}
              {c.finished && <> · 结束：{time(c.finished)}</>}
            </p>
          ))}
        {(snapshot.receipts || [])
          .filter((r: Row) => r.dataset === 'flow' && r.mall_id === selected)
          .slice(0, 6)
          .map((r: Row) => (
            <p key={r.id}>
              {time(r.observed_at)} ·{' '}
              {r.empty_flow_rows ? '空汇总已记录，保留有效报表' : '流量已入库'}{' '}
              · {r.shop || r.mall_id} · {r.rows} 个范围
            </p>
          ))}
        {!(snapshot.receipts || []).some(
          (r: Row) => r.dataset === 'flow' && r.mall_id === selected,
        ) && (
          <p>
            所选店铺暂无近期流量入库回执。可以点击“立即采集并同步”，命令只会由登录这家店的浏览器领取。
          </p>
        )}
      </details>}
      {error && (
        <p role="alert" className="tt-notice">
          {error}；以下保留上次读取结果。
        </p>
      )}
      <details className="tt-audit" open>
        <summary>
          {historical
            ? '历史快照内前日 / 当日对比'
            : '昨日 / 今日经营对比（所选店铺）'}
        </summary>
        <p>
          昨日全天与今日截至采集时分别展示，不按全天订单差额判断跌幅。今日采集时间：
          {time(current?._captured)}
        </p>
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>指标</th>
                <th>昨日全天</th>
                <th>今日累计</th>
              </tr>
            </thead>
            <tbody>
              {metrics.map(([k, label, rate]) => (
                <tr key={k}>
                  <td>{label}</td>
                  <td>{value(previous?.data?.result?.[k], rate)}</td>
                  <td>{value(current?.data?.result?.[k], rate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {current?._quality && (
          <p>今日最新数据异常，当前使用历史快照，请以标注时间为准。</p>
        )}
        <p>
          定位顺序：曝光 → 点击率 →
          点击订单转化率。商品级流量与售价、库存变化尚不完整，汇总差异不能直接认定具体原因。
        </p>
      </details>
      <div className="tt-summary">
        <div>
          <strong>汇总分析</strong>
          <small>
            采集时间：北京时间 {time(captured)}
            {stale ? ' · 历史快照，待更新' : ''}
          </small>
        </div>
        <div className="tt-periods" aria-label="统计范围">
          {dimensions.map(([id, label]) => (
            <button
              key={id}
              aria-pressed={dimension === id}
              className={dimension === id ? 'selected' : ''}
              onClick={() => setDimension(id)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {!row && (
        <p className="tt-notice">
          {historical ? '所选快照中的' : '此店铺的'}
          {dimensions.find((d) => d[0] === dimension)?.[1]}
          数据尚未采集。请保持已登录的商家后台打开，并启用采集助手 0.17.0
          的自动更新。
        </p>
      )}
      {row?._quality && (
        <p role="status" className="tt-notice">
          {row._quality.message} {row._quality.source_warning} 最新尝试：
          {time(row._quality.latest_attempt)}
        </p>
      )}
      <div className="tt-cards">
        {metrics.map(([key, label, rate], i) => {
          const delta = summary[key + 'LinkRelative'];
          return (
            <div className={'tt-card ' + (i === 0 ? 'selected' : '')} key={key}>
              <span>{label}</span>
              <strong>{value(summary[key], rate)}</strong>
              <small>
                {dimension === 0 ? '较前1日' : '较对比期'}{' '}
                <b
                  className={
                    numeric(delta)
                      ? delta > 0
                        ? 'up'
                        : delta < 0
                          ? 'down'
                          : ''
                      : ''
                  }
                >
                  {numeric(delta)
                    ? (delta > 0 ? '↑' : delta < 0 ? '↓' : '') +
                      (Math.abs(delta) * 100).toFixed(2) +
                      '%'
                    : '未采集'}
                </b>
              </small>
            </div>
          );
        })}
      </div>
      <div className="tt-charts">
        <div className="tt-chart">
          <h3>
            趋势分析 <small>商品曝光量</small>
          </h3>
          {points.length ? (
            <ResponsiveContainer width="100%" height={285}>
              <LineChart
                data={points}
                margin={{ top: 12, right: 20, bottom: 8, left: 0 }}
              >
                <CartesianGrid vertical={false} stroke="#e8edf3" />
                <XAxis
                  dataKey="label"
                  tickFormatter={tick}
                  minTickGap={32}
                  tick={{ fontSize: 11 }}
                />
                <YAxis tick={{ fontSize: 11 }} width={52} />
                <Tooltip labelFormatter={(v) => String(v)} />
                <Legend verticalAlign="top" height={36} />
                {series.map((s, i) => (
                  <Line
                    key={i}
                    type="monotone"
                    dataKey={'v' + i}
                    name={s.key || '序列' + (i + 1)}
                    stroke={colors[i % 3]}
                    strokeWidth={2}
                    dot={false}
                    connectNulls={false}
                    isAnimationActive={false}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div className="tt-empty">曝光趋势未采集</div>
          )}
        </div>
        <div className="tt-chart">
          <h3>
            渠道分析 <small>商品曝光量</small>
          </h3>
          {channelPoints.length ? (
            <ResponsiveContainer width="100%" height={285}>
              <AreaChart
                data={channelPoints}
                margin={{ top: 12, right: 20, bottom: 8, left: 0 }}
              >
                <CartesianGrid vertical={false} stroke="#e8edf3" />
                <XAxis
                  dataKey="label"
                  tickFormatter={tick}
                  minTickGap={32}
                  tick={{ fontSize: 11 }}
                />
                <YAxis tick={{ fontSize: 11 }} width={52} />
                <Tooltip />
                <Legend verticalAlign="top" height={36} />
                {channels.map((c, i) => (
                  <Area
                    key={i}
                    type="monotone"
                    dataKey={'v' + i}
                    name={c.key || '渠道' + (i + 1)}
                    stackId="channel"
                    stroke={colors[i % 3]}
                    fill={colors[i % 3]}
                    fillOpacity={0.72}
                    connectNulls={false}
                    isAnimationActive={false}
                  />
                ))}
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div className="tt-empty">渠道数据未采集</div>
          )}
        </div>
      </div>
      {professional&&<p className="tt-note">
        实时为采集时累计值，每 15 秒读取本机最新同步；开启自动更新且商家后台在线时每 2 小时采集一次。汇总与趋势分次采集，可能存在时间差。图中保留平台原始值，缺失值不补零；暂无有效数据的范围保留上次结果并显示提示。
      </p>}
      {professional&&<details className="tt-audit">
        <summary>核对采集详情与原始数据</summary>
        <p>
          店铺：{selected || '未采集'} · 范围：
          {dimensions.find((d) => d[0] === dimension)?.[1]} · 站点：
          {data.site_label || '旧记录未提供，需与后台所选站点核对'}
        </p>
        <p>
          来源：{data.source_page || '未记录'}
          <br />
          汇总：{time(captured)} · 趋势：{time(data.trend_received_at)}
        </p>
        <p>
          趋势序列 {series.length} 组 / 渠道 {channels.length}{' '}
          组。比率、环比直接使用后台字段；没有从订单或商品明细反推。
        </p>
        <pre>{row ? JSON.stringify(data, null, 2) : '未采集'}</pre>
      </details>}
    </section>
  );
}
