'use client';
import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {Button} from '@/components/ui/button';

import {BatchSelectionTools,useBatchSelection} from './batch-selection';
const PAGE_SIZE = 50;

type Freshness = {captured?: string; ageMinutes?: number | null; stale?: boolean; observedProducts?: number; freshProducts?: number};
type TrafficCoverage = {total: number; observed: number; fresh: number; attention: number; clear: number; unknown: number; stale: number};
type Alert = {
  alertKey: string; spuId: string; kind: string; reasons: string[]; tags?: string[]; cleared: boolean;
  imageUrl?: string; images?: string[]; activityNames?: string[];
  activityStatus?: string; activityStatusLabel?: string;
  acceleratorStatus?: string; acceleratorResolved?: string; acceleratorStatusLabel?: string;
  acceleratorFromStale?: boolean; saleStatusLabel?: string;
};
type State = {
  mallId: string;
  generatedAt?: string;
  sources?: {products?: Freshness; activities?: Freshness; accelerators?: Freshness};
  health: {items: Alert[]; unclearedCount: number};
  trafficAttention: {items: Alert[]; available: boolean; gap?: string; unclearedCount?: number; coverage?: TrafficCoverage};
  window: {active: boolean; slot: string; date: string};
  forceModal: boolean;
  warnModal?: boolean;
};

async function api(path: string, body?: Record<string, unknown>, signal?: AbortSignal) {
  const response = await fetch(path, {
    cache: 'no-store',
    signal: signal || AbortSignal.timeout(20000),
    ...(body ? {method: 'POST', headers: {'Content-Type': 'application/json', 'X-Workbench': 'local'}, body: JSON.stringify(body)} : {}),
  });
  const value = await response.json() as State & {error?: string};
  if (!response.ok) throw Error(value.error || '读取失败');
  return value;
}

function stamp(value?: string) {
  if (!value) return '尚未采集';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', {hour12: false, timeZone: 'Asia/Shanghai'});
}

function ageText(row?: Freshness) {
  if (!row) return '无';
  if (row.ageMinutes == null) return stamp(row.captured);
  const minutes = Math.round(row.ageMinutes);
  return stamp(row.captured) + ' · ' + (minutes < 60 ? minutes + ' 分钟前' : (minutes / 60).toFixed(1) + ' 小时前') + (row.stale ? ' · 已过期' : '');
}

function Pager({page, total, onChange}: {page: number; total: number; onChange: (page: number) => void}) {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (total <= PAGE_SIZE) return null;
  return (
    <div className="buttons" style={{marginTop: 12, alignItems: 'center', flexWrap: 'wrap', gap: 8}}>
      <Button variant="outline" disabled={page <= 1} onClick={() => onChange(page - 1)}>上一页</Button>
      <span className="panelnote">第 {page} / {pages} 页 · 每页 {PAGE_SIZE} 条 · 共 {total} 条</span>
      <Button variant="outline" disabled={page >= pages} onClick={() => onChange(page + 1)}>下一页</Button>
    </div>
  );
}

export default function Patrol({preferredMall = '', active, onOpen}: {preferredMall?: string; active: boolean; onOpen: () => void}) {
  const [data, setData] = useState<State | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [handled, setHandled] = useState('');
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [healthPage, setHealthPage] = useState(1);
  const [trafficPage, setTrafficPage] = useState(1);
  const [status, setStatus] = useState('');
  const scope = useRef(preferredMall);
  const lists = useRef<HTMLDivElement>(null);
  const lastFingerprint = useRef('');

  const load = useCallback(async (signal?: AbortSignal, manual = false) => {
    if (!preferredMall) return;
    if (manual) setRefreshing(true);
    try {
      const value = await api('/api/patrol/state?mall_id=' + encodeURIComponent(preferredMall), undefined, signal);
      if (scope.current !== preferredMall || signal?.aborted) return;
      const fingerprint = JSON.stringify({
        generatedAt: value.generatedAt,
        uncleared: value.health?.unclearedCount,
        keys: (value.health?.items || []).map((item) => [item.alertKey, item.cleared]),
        traffic: {
          keys: (value.trafficAttention?.items || []).map((item) => [item.alertKey, item.cleared]),
          uncleared: value.trafficAttention?.unclearedCount,
          coverage: value.trafficAttention?.coverage,
          available: value.trafficAttention?.available,
          gap: value.trafficAttention?.gap,
        },
        sources: value.sources,
      });
      setData(value);
      setError('');
      if (manual) {
        const changed = fingerprint !== lastFingerprint.current;
        lastFingerprint.current = fingerprint;
        const staleBoost = (value.health?.items || []).filter((item) => item.acceleratorFromStale).length;
        setStatus(
          (changed ? '已重新读取本地库，清单有变化。' : '已重新读取本地库，清单与上次相同。')
          + ' 健康预警待处理 ' + (value.health?.unclearedCount ?? 0) + ' 条，流量待关注待处理 '
          + (value.trafficAttention?.unclearedCount ?? value.trafficAttention?.items.filter((item) => !item.cleared).length ?? 0) + ' 条'
          + (staleBoost ? '；其中 ' + staleBoost + ' 条仍用较旧加速器快照（需在商品状态页点「更新加速器状态」）' : '')
          + ' · ' + stamp(value.generatedAt)
        );
      } else {
        lastFingerprint.current = fingerprint;
      }
    } catch (reason: unknown) {
      if (scope.current === preferredMall && reason instanceof Error && reason.name !== 'AbortError') {
        setError(reason.message);
        if (manual) setStatus('刷新失败：' + reason.message);
      }
    } finally {
      if (manual) setRefreshing(false);
    }
  }, [preferredMall]);

  useEffect(() => {
    scope.current = preferredMall;
    setHealthPage(1);
    setTrafficPage(1);
    setStatus('');
    lastFingerprint.current = '';
    const controller = new AbortController();
    const initial = setTimeout(() => { void load(controller.signal); }, 0);
    const timer = setInterval(() => { void load(controller.signal); }, 15000);
    return () => {
      scope.current = '';
      controller.abort();
      clearTimeout(initial);
      clearInterval(timer);
    };
  }, [load, preferredMall]);

  const current = data?.mallId === preferredMall ? data : null;
  const signature = current
    ? [preferredMall, current.window.date, current.window.slot,
      ...current.health.items.filter((i) => !i.cleared).map((i) => i.alertKey),
      ...current.trafficAttention.items.filter((i) => !i.cleared).map((i) => i.alertKey)].join('|')
    : '';
  // Non-blocking warn: any uncleared alerts. Dismiss lasts until remount/refresh or alert set changes.
  const healthUncleared = current?.health.unclearedCount ?? 0;
  const trafficUncleared = current?.trafficAttention.unclearedCount ?? current?.trafficAttention.items.filter((item) => !item.cleared).length ?? 0;
  const shouldWarn = !!current && (current.warnModal ?? current.forceModal) && healthUncleared + trafficUncleared > 0;
  const showWarn = shouldWarn && handled !== signature;

  const healthItems = current?.health.items || [];
  const trafficItems = current?.trafficAttention.items || [];
  const trafficCoverage = current?.trafficAttention.coverage;
  const trafficComplete = !!trafficCoverage && trafficCoverage.fresh === trafficCoverage.total && trafficCoverage.unknown === 0 && trafficCoverage.stale === 0;
  const healthBatch=useBatchSelection(healthItems,preferredMall+'|health',item=>item.alertKey);
  const trafficBatch=useBatchSelection(trafficItems,preferredMall+'|traffic',item=>item.alertKey);
  const healthVisible=healthBatch.visibleRows,trafficVisible=trafficBatch.visibleRows;
  const healthPages = Math.max(1, Math.ceil(healthVisible.length / PAGE_SIZE));
  const trafficPages = Math.max(1, Math.ceil(trafficVisible.length / PAGE_SIZE));
  const healthSlice = useMemo(() => {
    const page = Math.min(healthPage, healthPages);
    return healthVisible.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  }, [healthVisible, healthPage, healthPages]);
  const trafficSlice = useMemo(() => {
    const page = Math.min(trafficPage, trafficPages);
    return trafficVisible.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  }, [trafficVisible, trafficPage, trafficPages]);

  useEffect(() => { if (healthPage > healthPages) setHealthPage(healthPages); }, [healthPage, healthPages]);
  useEffect(() => { if (trafficPage > trafficPages) setTrafficPage(trafficPages); }, [trafficPage, trafficPages]);

  useEffect(()=>setHealthPage(1),[healthBatch.onlySelected]);
  useEffect(()=>setTrafficPage(1),[trafficBatch.onlySelected]);

  async function handle() {
    setBusy(true);
    try {
      await api('/api/patrol/action', {mall_id: preferredMall, action: 'open'});
      if (scope.current === preferredMall) {
        setHandled(signature);
        onOpen();
        setTimeout(() => lists.current?.scrollIntoView({behavior: 'smooth'}), 0);
      }
    } catch (reason: unknown) {
      if (scope.current === preferredMall) setError(reason instanceof Error ? reason.message : '操作失败');
    } finally {
      setBusy(false);
    }
  }

  async function clear(item: Alert) {
    setBusy(true);
    try {
      await api('/api/patrol/clear', {
        mall_id: preferredMall, alert_key: item.alertKey, spu_id: item.spuId, kind: item.kind,
        note: notes[item.alertKey] || '',
      });
      await load(undefined, true);
    } catch (reason: unknown) {
      if (scope.current === preferredMall) setError(reason instanceof Error ? reason.message : '操作失败');
    } finally {
      setBusy(false);
    }
  }

  function batchTools(batch:typeof healthBatch,total:number,label:string){return <BatchSelectionTools selection={batch} total={total} label={label} copyFields={[{label:'SPU',value:item=>item.spuId}]} columns={[{label:'SPU',value:item=>item.spuId},{label:'原因',value:item=>item.reasons.join('；')},{label:'状态',value:item=>item.cleared?'已消警':'待处理'},{label:'活动',value:item=>(item.activityNames||[]).join('；')},{label:'加速器',value:item=>item.acceleratorStatusLabel}]}/>;}
  function alerts(items: Alert[],batch:typeof healthBatch,label:string) {
    return items.map((item) => (
      <article key={item.alertKey} className="panel" style={{display: 'grid', gridTemplateColumns: '72px 1fr', gap: 12, alignItems: 'start'}}>
        <div style={{width: 72, height: 72, borderRadius: 8, overflow: 'hidden', background: '#f3f4f6', display: 'flex', alignItems: 'center', justifyContent: 'center'}}>
          {item.imageUrl
            ? <img src={item.imageUrl} alt={'SPU ' + item.spuId} width={72} height={72} style={{width: '100%', height: '100%', objectFit: 'cover'}} loading="lazy" referrerPolicy="no-referrer" />
            : <span className="panelnote">无图</span>}
        </div>
        <div>
          <label className="batch-row-check"><input type="checkbox" aria-label={'选择'+label+' SPU '+item.spuId} checked={batch.isSelected(item)} onChange={e=>batch.toggle(item,e.target.checked)}/>选择</label><br/><strong>SPU {item.spuId}</strong>
          <div>{item.reasons.map((reason) => <span key={reason} className="tag red">{reason}</span>)}</div>
          <p className="panelnote">
            {[item.saleStatusLabel || '在售',
              item.activityStatusLabel || '',
              item.activityNames?.length ? item.activityNames.join(' / ') : '',
              '加速器：' + (item.acceleratorStatusLabel || '待确认') + (item.acceleratorFromStale ? '（加速器快照较旧）' : ''),
            ].filter(Boolean).join(' · ')}
          </p>
          {item.cleared
            ? <span className="tag green">已消警</span>
            : <div className="buttons">
                <input aria-label={'消警备注 ' + item.spuId} placeholder="处理备注（选填）" value={notes[item.alertKey] || ''} onChange={(event) => setNotes({...notes, [item.alertKey]: event.target.value})} />
                <Button disabled={busy || refreshing} onClick={() => clear(item)}>确认已处理并消警</Button>
              </div>}
        </div>
      </article>
    ));
  }

  const pendingText = `健康预警 ${healthUncleared} 条、流量待关注 ${trafficUncleared} 条未消警`;
  const slotLabel = current?.window.slot === 'morning' ? '上午 09:00–12:00' : current?.window.slot === 'afternoon' ? '下午 14:00–18:00' : '';
  const warnText = current?.window.active
    ? `当前是北京时间${slotLabel}巡店时段，还有${pendingText}。可先去巡店处理；关闭后仍可使用其他工具。`
    : `还有${pendingText}。北京时间每天 09:00–12:00、14:00–18:00 建议巡店消警；关闭后仍可使用其他工具。`;

  return <>
    {showWarn && (
      <div
        role="alertdialog"
        aria-modal="false"
        aria-labelledby="patrol-warn-title"
        style={{
          position: 'fixed', right: 20, bottom: 20, zIndex: 80, width: 'min(420px, calc(100vw - 40px))',
          padding: 16, borderRadius: 12, background: '#fff7ed', border: '1px solid #fdba74',
          boxShadow: '0 8px 28px rgba(0,0,0,.18)', color: '#7c2d12', pointerEvents: 'auto',
        }}
      >
        <strong id="patrol-warn-title" style={{display: 'block', marginBottom: 8, fontSize: 15}}>巡店预警未处理完</strong>
        <p style={{margin: '0 0 12px', lineHeight: 1.5}}>{warnText}</p>
        {error && <p role="alert" style={{margin: '0 0 8px'}}>{error}</p>}
        <div className="buttons" style={{display: 'flex', gap: 8, flexWrap: 'wrap'}}>
          <Button disabled={busy} onClick={handle}>{busy ? '记录中…' : '去巡店'}</Button>
          <Button variant="outline" disabled={busy} onClick={() => setHandled(signature)}>知道了</Button>
        </div>
      </div>
    )}
    {active && <div ref={lists}>
      <section className="panel">
        <div className="sectionhead">
          <div>
            <h2>巡店</h2>
            <p>有活动须开加速器；无活动和无加速器可健康。广告商品标签尚未接入。</p>
            <p>按后台「商品流量待关注」标记匹配，已匹配商品单独展示，不重复进入健康预警；未采到或过期的数据需更新确认。</p>
            <p>「刷新预警」只重读本机已采集数据，不会触发平台重新抓取。卡片上的「加速器快照较旧」要去商品状态页点「更新加速器状态」。</p>
          </div>
          <Button variant="outline" disabled={!preferredMall || busy || refreshing} onClick={() => load(undefined, true)}>
            {refreshing ? '正在重读本地库…' : '刷新预警'}
          </Button>
        </div>
        {!preferredMall && <p>请切换到当前浏览器店铺后查看巡店预警。</p>}
        {error && <div className="banner danger" role="alert">{error}</div>}
        {status && <div className="banner" role="status">{status}</div>}
        {current?.sources && (
          <p className="panelnote">
            本地采集：商品 {ageText(current.sources.products)} · 活动 {ageText(current.sources.activities)} · 加速器 {ageText(current.sources.accelerators)}
            {current.sources.accelerators?.freshProducts != null ? `（新鲜确认 ${current.sources.accelerators.freshProducts}/${current.sources.accelerators.observedProducts ?? '?'}）` : ''}
          </p>
        )}
      </section>
      {current && <div className="daily-audit-grid">
        <section className="panel">
          <h2>健康预警 · 待处理 {current.health.unclearedCount}</h2>
          {batchTools(healthBatch,healthItems.length,'健康预警')}
          {alerts(healthSlice,healthBatch,'健康预警')}
          {!healthItems.length && <p>当前快照未发现健康异常。</p>}
          <Pager page={Math.min(healthPage, healthPages)} total={healthVisible.length} onChange={(page) => { setHealthPage(page); lists.current?.scrollIntoView({behavior: 'smooth'}); }} />
        </section>
        <section className="panel">
          <h2>商品流量待关注 · 待处理 {trafficUncleared}</h2>
          {trafficCoverage && <p className="panelnote" aria-label="流量待关注覆盖">
            在售 {trafficCoverage.total} 件 · 新鲜确认 {trafficCoverage.fresh} 件 · 待关注标记 {trafficCoverage.attention} 件 · 无此标记 {trafficCoverage.clear} 件 · 待确认 {trafficCoverage.unknown} 件
            {trafficCoverage.stale ? `（含过期 ${trafficCoverage.stale} 件）` : ''}
          </p>}
          {current.trafficAttention.gap && <p role="status">{current.trafficAttention.gap}</p>}
          {trafficItems.length
              ? <>
                  {batchTools(trafficBatch,trafficItems.length,'流量待关注')}
                  {alerts(trafficSlice,trafficBatch,'流量待关注')}
                  <Pager page={Math.min(trafficPage, trafficPages)} total={trafficVisible.length} onChange={setTrafficPage} />
                </>
              : trafficComplete
                ? <p>{trafficCoverage?.total ? '当前完整快照暂无流量待关注商品。' : '当前在售商品范围为空。'}</p>
                : !current.trafficAttention.gap && <p>此标记的数据尚未完整确认，暂不能判断是否存在流量待关注商品。</p>}
        </section>
      </div>}
    </div>}
  </>;
}
