'use client';
// Scope changes and query changes reset the visible comparison before its next fetch.
import { useEffect, useState } from 'react';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {BatchSelectionTools,useBatchSelection} from './batch-selection';
const metrics = [
  ['impressionCount', '商品曝光量'],
  ['clickCount', '商品点击量'],
  ['orderPayOrderNum', '支付订单数'],
] as const;
const colors = [
  '#2563eb',
  '#dc2626',
  '#059669',
  '#9333ea',
  '#d97706',
  '#0891b2',
  '#475569',
];
const today = () =>
  new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
type Point = {
  time: string;
  captured_at: string | null;
  missing: boolean;
  metrics: Record<string, number | null>;
};
type Result = {
  queryScope?: string;
  times: string[];
  series: { date: string; aligned: Point; points: Point[] }[];
};
export default function PatrolTraffic({
  preferredMall = '',
  preferredStore = '',
}: {
  preferredMall?: string;
  preferredStore?: string;
}) {
  const [shops, setShops] = useState<{ mall_id: string; name: string }[]>([]),
    [mall, setMall] = useState(preferredMall);
  const [dates, setDates] = useState([today()]),
    [candidate, setCandidate] = useState(today()),
    [at, setAt] = useState('12:00');
  const [rawResult, setResult] = useState<Result | null>(null),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(false);
  const queryScope=JSON.stringify([mall,dates,at]);
  const result=rawResult?.queryScope===queryScope?rawResult:null;
  useEffect(() => setMall(preferredMall), [preferredMall]);
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/collector/state', { signal: controller.signal })
      .then((r) => {
        if (!r.ok) throw Error('店铺列表读取失败');
        return r.json() as Promise<{
          shops?: { mall_id: string; name: string }[];
        }>;
      })
      .then((r) => setShops(r.shops || []))
      .catch((e) => {
        if (e.name !== 'AbortError') setError(e.message);
      });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    setResult(null);
    setError('');
    if (!mall) return;
    const controller = new AbortController();
    setLoading(true);
    const q = new URLSearchParams({
      mall_id: mall,
      dates: dates.join(','),
      at,
    });
    fetch('/api/patrol/traffic-compare?' + q, { signal: controller.signal })
      .then(async (r) => {
        const value = (await r.json()) as Result & { error?: string };
        if (!r.ok) throw Error(value.error || '流量对比读取失败');
        return value;
      })
      .then(value=>setResult({...value,queryScope:JSON.stringify([mall,dates,at])}))
      .catch((e) => {
        if (e.name !== 'AbortError') setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [mall, dates, at]);
  const batch=useBatchSelection(result?.series||[],JSON.stringify([mall,dates,at]),row=>row.date);
  function addDate() {
    if (!candidate) return;
    const next = [...new Set([...dates, candidate])].sort();
    if (
      next.length > 7 ||
      Date.parse(next[next.length - 1]) - Date.parse(next[0]) > 6 * 86400000
    ) {
      setError('请选择同一周内最多 7 个日期');
      return;
    }
    setError('');
    setDates(next);
  }
  return (
    <section className="panel">
      <div className="sectionhead">
        <div>
          <span className="eyebrow">维护 · 巡店</span>
          <h2>流量对比</h2>
          <p>
            按北京时间同一分钟比较实时累计；不补点、不使用全日报表。缺采样显示“无点”，折线留空。
          </p>
        </div>
      </div>
      <div
        className="buttons"
        style={{ alignItems: 'center', flexWrap: 'wrap' }}
      >
        <label>
          店铺{' '}
          <select
            aria-label="流量对比店铺"
            value={mall}
            onChange={(e) => setMall(e.target.value)}
          >
            <option value="">请选择店铺</option>
            {preferredMall &&
              !shops.some((s) => s.mall_id === preferredMall) && (
                <option value={preferredMall}>
                  {preferredStore || preferredMall}
                </option>
              )}
            {shops.map((s) => (
              <option key={s.mall_id} value={s.mall_id}>
                {s.name || s.mall_id}
              </option>
            ))}
          </select>
        </label>
        <label>
          日期{' '}
          <input
            aria-label="添加对比日期"
            type="date"
            value={candidate}
            onChange={(e) => setCandidate(e.target.value)}
          />
        </label>
        <button type="button" onClick={addDate}>
          添加日期
        </button>
        <label>
          对齐时刻{' '}
          <input
            aria-label="对齐时刻"
            type="time"
            value={at}
            onChange={(e) => setAt(e.target.value)}
          />
        </label>
      </div>
      <div className="buttons">
        {dates.map((d) => (
          <button
            type="button"
            key={d}
            disabled={dates.length === 1}
            onClick={() => setDates(dates.filter((day) => day !== d))}
            aria-label={'移除日期 ' + d}
          >
            {d} ×
          </button>
        ))}
      </div>
      {error && <p role="alert">{error}</p>}
      {!mall && <p>选择店铺后查看历史采样。</p>}
      {loading && mall && <output>正在读取…</output>}
      {result && (
        <>
          <BatchSelectionTools selection={batch} total={result.series.length} label="流量对比" copyFields={[{label:'日期',value:row=>row.date}]} columns={[{label:'日期',value:row=>row.date},...metrics.map(([key,label])=>({label,value:(row:Result['series'][number])=>row.aligned.metrics[key]??'无点'})),{label:'采样时间',value:row=>row.aligned.captured_at||'无点'}]}/>
          <div className="tablewrap">
            <table>
              <caption>{at} · Asia/Shanghai 同刻点</caption>
              <thead>
                <tr>
                  <th>选择</th><th>日期</th>
                  {metrics.map(([k, label]) => (
                    <th key={k}>{label}</th>
                  ))}
                  <th>实际采样时间</th>
                </tr>
              </thead>
              <tbody>
                {batch.visibleRows.map((s) => (
                  <tr key={s.date} data-batch-selected={batch.isSelected(s)}>
                    <td><input className="batch-row-check" type="checkbox" aria-label={'选择对比日期 '+s.date} checked={batch.isSelected(s)} onChange={event=>batch.toggle(s,event.target.checked)}/></td>
                    <td>{s.date}</td>
                    {metrics.map(([key]) => (
                      <td key={key}>
                        {s.aligned.metrics[key]?.toLocaleString('zh-CN') ??
                          '无点'}
                      </td>
                    ))}
                    <td>
                      {s.aligned.captured_at
                        ? new Date(s.aligned.captured_at).toLocaleString(
                            'zh-CN',
                            { timeZone: 'Asia/Shanghai', hour12: false },
                          )
                        : '无点'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {metrics.map(([key, label]) => {
            const points = result.times.map((time, index) =>
              Object.fromEntries([
                ['time', time],
                ...result.series.map((s) => [
                  s.date,
                  s.points[index].metrics[key],
                ]),
              ]),
            );
            return (
              <div key={key}>
                <h3>
                  {label} · 各日 00:00 至 {at}
                </h3>
                <div style={{ height: 260, width: '100%', minWidth: 0 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={points}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="time" />
                      <YAxis />
                      <Tooltip formatter={(v) => (v == null ? '无点' : v)} />
                      <Legend />
                      {result.series.map((s, i) => (
                        <Line
                          key={s.date}
                          dataKey={s.date}
                          name={s.date}
                          stroke={colors[i]}
                          connectNulls={false}
                          dot={{ r: 3 }}
                          isAnimationActive={false}
                        />
                      ))}
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>
            );
          })}
        </>
      )}
    </section>
  );
}
