'use client';
import { useState, useEffect, useCallback, useRef } from 'react';
import {
  PackageCheck,
  Settings2,
  Upload,
  RefreshCw,
  ArrowUpRight,
  AlertCircle,
  Layers,
  ListChecks,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import Catalog from './catalog';
import Traffic from './traffic';
import Collector from './collector';
import Daily from './daily';
import Patrol from './patrol';
import ImageQueue from './image-queue';
import FileTools from './file-tools';
import FocusHome from './focus-home';
import MoreTools from './more-tools';
import Qualification from './qualification';
import TrafficDashboard from './traffic-dashboard';
import ActivityJobs from './activity-jobs';
import Delisting from './delisting';
import FeatureCenter from './feature-center';
import ProductStatus from './product-status';
import TrafficAccelerator from './traffic-accelerator';
import Onboarding from './onboarding';
import { WorkbenchModeProvider, WorkbenchModeSwitch, useWorkbenchMode } from './workbench-mode';
import {BatchSelectionTools, useBatchSelection} from './batch-selection';
import { sections, tools as nav, sectionForTab } from './workbench-navigation';
import workbenchRelease from '../workbench-release.json';
import workbenchComponents from '../workbench-components.json';
type Row = Record<string, any>;
const sectionIcons = { patrol: ListChecks, maintenance: Settings2, launch: PackageCheck };
const fields: Record<string, string> = {
  date: '日期',
  product_id: '商品ID',
  title: '商品标题',
  category: '品类',
  impressions: '曝光次数',
  clicks: '点击次数',
  orders: '订单数',
  units: '销售件数',
  settlement: '结算收入',
  goods_cost: '商品成本合计',
  fulfillment: '履约成本合计',
  ads: '广告费',
  refund_loss: '退款损失',
  other_cost: '其他成本合计',
};
const fmt = (v: any, d = 0) =>
  v == null
    ? '—'
    : Number(v).toLocaleString('zh-CN', { maximumFractionDigits: d });
const today = () => new Date().toLocaleDateString('sv-SE');
async function api(path: string, body?: any): Promise<Row> {
  const request = () =>
    fetch(
      '/api/' + path,
      body
        ? {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Workbench': 'local',
            },
            body: JSON.stringify(body),
          }
        : { cache: 'no-store', signal: AbortSignal.timeout(10000) },
    );
  let r: Response;
  try {
    r = await request();
    if (!body && (!r.ok || !r.headers.get('content-type')?.includes('application/json'))) {
      await new Promise((resolve) => setTimeout(resolve, 800));
      r = await request();
    }
  } catch {
    throw Error('本地数据服务暂时没有响应，正在自动重连');
  }
  const text = await r.text();
  let v: Row = {};
  if (text.trim()) {
    try {
      v = JSON.parse(text) as Row;
    } catch {
      throw Error(`本地数据服务返回格式异常（HTTP ${r.status}），正在自动重连`);
    }
  }
  if (!r.ok) throw Error(v.error || `本地数据服务暂时不可用（HTTP ${r.status}）`);
  if (!text.trim()) throw Error('本地数据服务返回了空内容，正在自动重连');
  return v;
}
function Select({ value, onChange, children, ...p }: any) {
  return (
    <select {...p} value={value} onChange={(e) => onChange(e.target.value)}>
      {children}
    </select>
  );
}
function Field({ name, children }: any) {
  return (
    <label className="field">
      <span>{name}</span>
      {children}
    </label>
  );
}
function Empty({ title, detail, children }: any) {
  return (
    <div className="empty">
      <Layers size={34} />
      <h3>{title}</h3>
      <p>{detail}</p>
      {children}
    </div>
  );
}
export default function Workbench() {
  return <WorkbenchModeProvider><WorkbenchContent /></WorkbenchModeProvider>;
}
function WorkbenchContent() {
  const {professional} = useWorkbenchMode();
  const [tab, updateTab] = useState('patrol'),
    [state, setState] = useState<Row | null>(null),
    [message, setMessage] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [serverVersion, setServerVersion] = useState('');
  const [guideOpen, setGuideOpen] = useState(false);
  const setTab = useCallback((next: string) => { updateTab(next); setMessage(''); }, []);
  const sectionId = sectionForTab(tab);
  const currentSection = sections.find(section => section.id === sectionId)!;
  const currentTool = nav.find(tool => tool.id === tab);
  useEffect(() => {
    try {
      const key = 'workbench.quickstart.v20261029';
      if (!localStorage.getItem(key)) {
        setGuideOpen(true);
        localStorage.setItem(key, 'seen');
      }
    } catch {}
  }, []);
  useEffect(() => {
    let active = true;
    const check = async () => {
      try {
        const response = await fetch('/api/health', { cache: 'no-store' });
        const health = await response.json() as Row;
        if (active && response.ok) setServerVersion(health.version || '旧版（未标识版本）');
      } catch {}
    };
    void check();
    const timer = window.setInterval(check, 30000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);
  const [browserContext, setBrowserContext] = useState<Row>({}),
    [scopeMall, setScopeMall] = useState(''),
    [scopeMode, setScopeMode] = useState<'browser' | 'all'>('browser');
  const scopeModeRef = useRef<'browser' | 'all'>('browser');
  function toggleScope() {
    const next = scopeModeRef.current === 'browser' ? 'all' : 'browser';
    scopeModeRef.current = next;
    setScopeMode(next);
    setScopeMall(next === 'all' ? '' : browserContext.mall_id || '');
  }
  async function restartWorkbench() {
    if (
      restarting ||
      !window.confirm(
        '确定重启工作台？请先保存未保存的设置，并停止正在运行的采集、生图等任务。重启会短暂断开本地服务并刷新页面，不会清除已保存的数据，也不会重启 Chrome 扩展。',
      )
    )
      return;
    setRestarting(true);
    setError('');
    setMessage('正在重启工作台，请勿重复点击…');
    try {
      const response = await fetch('/api/workbench/restart', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Workbench': 'local' },
        body: JSON.stringify({ confirm: 'restart-workbench' }),
        signal: AbortSignal.timeout(10000),
      });
      if (response.status === 404)
        throw Error(
          '旧服务尚未支持重启按钮。首次请双击工作台文件夹内“重启工作台.vbs”，之后即可使用此按钮。',
        );
      if (!response.ok) throw Error('重启请求未成功，请稍后再试');
      const before = (await response.json()) as Row;
      const deadline = Date.now() + 90000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        try {
          const r = await fetch('/api/health', {
            cache: 'no-store',
            signal: AbortSignal.timeout(2500),
          });
          const health = (await r.json()) as Row;
          if (
            r.ok &&
            health.ok &&
            health.instance_id &&
            health.instance_id !== before.instance_id
          ) {
            window.location.reload();
            return;
          }
        } catch {}
      }
      throw Error(
        '90 秒内未确认服务重启完成。请使用“重启工作台.vbs”恢复；不要连续重复点击。',
      );
    } catch (e: any) {
      setMessage('');
      setError(e.message);
    } finally {
      setRestarting(false);
    }
  }
  const [filters, setFilters] = useState({
      shop: '',
      site: '',
      currency: '',
      level: '',
      start: '',
      end: '',
    }),
    [search, setSearch] = useState('');
  const [source, setSource] = useState({ name: '', text: '' }),
    [preview, setPreview] = useState<Row | null>(null),
    [mapping, setMapping] = useState<Record<string, string>>({}),
    [checked, setChecked] = useState<Row | null>(null);
  const [context, setContext] = useState({
    shop: '',
    site: '',
    currency: '',
    level: 'SKU',
    date: '',
  });
  const [draft, setDraft] = useState<Row>({
    title: '',
    category: '毛毯',
    route: '印花创新',
    url: '',
    sales: '',
    price: '',
    currency: '',
    theme: '',
    notes: '',
    status: '待判断',
  });
  const [review, setReview] = useState<Row>({
    title: '',
    product_id: '',
    shop: '',
    site: '',
    date: today(),
    action: '主图测试',
    notes: '',
    followup: '',
  });
  const [imageTask, setImageTask] = useState<Row>({
    title: '',
    category: '毛毯',
    theme: '',
    reference: '',
    template: '',
    notes: '',
    status: '待生成',
  });
  const [ruleDraft, setRuleDraft] = useState<Row>({
    min_impressions: 1000,
    min_clicks: 30,
    ctr: 1,
    order_ratio: 2,
  });
  const load = useCallback(async () => {
    const s = await api('state?' + new URLSearchParams(filters));
    setState(s);
    setError('');
  }, [filters]);
  useEffect(() => {
    load().catch((e) => setError('本地数据服务未连接：' + e.message));
    const timer = setInterval(
      () => load().catch((e) => setError('本地数据服务未连接：' + e.message)),
      15000,
    );
    return () => clearInterval(timer);
  }, [load]);
  useEffect(() => {
    const browser = /Edg\//.test(navigator.userAgent) ? 'Edge' : /Chrome\//.test(navigator.userAgent) ? 'Chrome' : '';
    const storageKey = 'workbench.browser.context.v1';
    const q = new URLSearchParams(window.location.search);
    const queryBrowser = q.get('browser') || '';
    const fromQuery = q.get('client_id') && (!queryBrowser || queryBrowser === browser)
      ? { client_id: q.get('client_id'), browser: queryBrowser || browser, mall_id: q.get('mall_id') || '', store_name: q.get('store_name') || '' }
      : null;
    let saved: Row | null = null;
    try { saved = JSON.parse(localStorage.getItem(storageKey) || 'null') as Row | null; } catch {}
    const sameBrowserSaved = saved?.browser === browser ? saved : null;
    let fallback = fromQuery || sameBrowserSaved;
    if (fromQuery && sameBrowserSaved?.client_id === fromQuery.client_id) {
      fallback = { ...fromQuery, mall_id: sameBrowserSaved.mall_id || fromQuery.mall_id, store_name: sameBrowserSaved.store_name || fromQuery.store_name };
    }
    let client = String(fallback?.client_id || '');
    if (fallback) {
      setBrowserContext(fallback);
      setScopeMall(fallback.mall_id || '');
    }
    const update = () =>
      fetch('/api/collector/control')
        .then((r) => r.json() as Promise<Row>)
        .then((v) => {
          let live = client ? v.clients?.[client] : null;
          const fresh = (item: Row) => item?.browser === browser && Date.now() - new Date(item.at).getTime() < 90000;
          if (!live || !fresh(live)) {
            const active = Object.values(v.clients || {}).filter((item) => fresh(item as Row)) as Row[];
            // A direct workbench URL has no client ID.  Bind it only when
            // this browser has one unambiguous active extension instance.
            live = active.length === 1 ? active[0] : null;
          }
          if (live) {
            client = live.client_id;
            setBrowserContext(live);
            try { localStorage.setItem(storageKey, JSON.stringify({client_id:client,browser,mall_id:live.mall_id,store_name:live.store_name})); } catch {}
            setScopeMall((current) =>
              scopeModeRef.current === 'browser' ? live.mall_id || current || '' : current,
            );
          }
        })
        .catch(() => {});
    update();
    const timer = setInterval(update, 15000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    setFilters((value) => ({
      ...value,
      shop: scopeMall ? browserContext.store_name || '' : '',
    }));
  }, [scopeMall, browserContext.store_name]);
  useEffect(() => {
    if (state?.rules) setRuleDraft(state.rules);
  }, [state?.rules]);
  useEffect(() => {
    const registry = (
      document as Document & {
        modelContext?: {
          registerTool: (tool: any, options: any) => void | Promise<void>;
        };
      }
    ).modelContext;
    if (!registry?.registerTool) return;
    const life = new AbortController();
    try {
      Promise.resolve(
        registry.registerTool(
          {
            name: 'read_operations_state',
            title: '读取本地经营复盘',
            description:
              '只读返回当前筛选范围内已导入的商品诊断、日期覆盖和观察线，不采集商家后台。',
            inputSchema: {
              type: 'object',
              properties: {},
              additionalProperties: false,
            },
            annotations: { readOnlyHint: true, untrustedContentHint: true },
            execute: async (input: unknown) => {
              if (
                !input ||
                typeof input !== 'object' ||
                Object.keys(input).length
              )
                throw Error('不接受额外参数');
              const r = await api('state?' + new URLSearchParams(filters));
              return {
                products: r.products,
                coverage: r.coverage,
                rules: r.rules,
              };
            },
          },
          { signal: life.signal },
        ),
      ).catch(() => {});
    } catch {}
    return () => life.abort();
  }, [filters]);
  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await fn();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function save(kind: string, payload: Row, id?: string) {
    await api('entry', { kind, payload, id });
    setMessage('已保存到本机');
    await load();
  }
  const entries = (kind: string) =>
    (state?.entries || []).filter((r: Row) => r.kind === kind);
  const products: Row[] = state?.products || [],
    scopes: Row[] = state?.scopes || [];
  const shown = products.filter((r) =>
    `${r.title} ${r.product_id}`.toLowerCase().includes(search.toLowerCase()),
  );
  const csvSelection = useBatchSelection<Row>(shown, JSON.stringify([scopeMall, filters, search]), r=>[r.shop,r.site,r.currency,r.level,r.product_id].join('|'));
  const currencies = [...new Set(products.map((r) => r.currency))],
    levels = [...new Set(products.map((r) => r.level))];
  const total = (k: string) =>
    products.length && products.every((r) => r[k] != null)
      ? products.reduce((s, r) => s + r[k], 0)
      : null;
  const stats = [
    ['已导入商品', products.length || null, '按店铺、站点与层级区分'],
    [
      '订单数',
      levels.length > 1 ? null : total('orders'),
      levels.length > 1 ? '混合 SKU / SPU，不相加' : '当前已导入范围',
    ],
    [
      '结算收入',
      currencies.length > 1 || levels.length > 1 ? null : total('settlement'),
      currencies.length === 1 ? currencies[0] : '不同币种不相加',
    ],
    [
      '贡献结余',
      currencies.length > 1 || levels.length > 1 ? null : total('contribution'),
      '收入减已填成本，非财务净利润',
    ],
  ];
  const prompt = `请根据套图模板中的图片数量，为${imageTask.category}生成对应数量的独立商品套图。\n参考印花：${imageTask.reference || '【附上参考印花】'}\n套图模板：${imageTask.template || '【附上模板】'}\n主题：${imageTask.theme || '遵循参考印花'}。保持图案元素、颜色与排布一致，将印花适配到${imageTask.category}表面，场景摆件匹配主题氛围。保持模板中的产品形状、比例、材质和镜头构图，避免图案变形、元素遗漏或文字乱码。\n每张模板对应调用一次生图工具，每次输出一张完整独立图片，禁止拼图，并按模板顺序输出。不得凭空添加尺寸、认证或功能宣称，不出现儿童相关描述。${imageTask.notes ? '\n补充要求：' + imageTask.notes : ''}`;
  const formInput = (
    obj: Row,
    set: (v: Row) => void,
    key: string,
    label: string,
    type = 'text',
  ) => (
    <Field name={label} key={key}>
      <Input
        type={type}
        value={obj[key] || ''}
        onChange={(e) => set({ ...obj, [key]: e.target.value })}
      />
    </Field>
  );
  async function readFile(file?: File) {
    if (!file) return;
    await act(async () => {
      const bytes = await file.arrayBuffer();
      let text = new TextDecoder('utf-8').decode(bytes);
      if (text.includes('\ufffd'))
        text = new TextDecoder('gb18030').decode(bytes);
      setSource({ name: file.name, text });
      const p = await api('preview', { text });
      setPreview(p);
      setMapping(p.mapping);
      setChecked(null);
    });
  }
  return (
    <div className={'shell ' + (professional ? 'workbench-professional' : 'workbench-simple')}>
      <aside className="sidebar">
        <div className="brand">
          <span className="brandmark">T</span>
          <div>
            <strong>织品工作台</strong>
            <small>TEMU · 半托管</small>
          </div>
        </div>
        <div className="navcaption">工作板块</div>
        <nav className="section-navigation" aria-label="工作板块">
          {sections.map(section => {
            const Icon = sectionIcons[section.id];
            return <button key={section.id} aria-label={section.title} aria-current={sectionId === section.id ? 'page' : undefined} className={sectionId === section.id ? 'active' : ''} onClick={() => setTab(section.first)}>
              <Icon size={21}/><span><strong>{section.title}</strong><small>{section.detail}</small></span>
            </button>;
          })}
        </nav>
        <div className="navcaption tool-caption">{currentSection.title}工具</div>
        <nav className="tool-navigation" aria-label="板块工具">
          {nav.filter(tool=>tool.section===sectionId && !('extra' in tool)).map(({id, title}) => (
            <button
              key={id}
              className={tab === id || (id==='more' && currentTool && 'extra' in currentTool) ? 'active' : ''}
              aria-current={tab === id ? 'page' : undefined}
              onClick={() => setTab(id)}
            >
              {title}
            </button>
          ))}
        </nav>
        <div className="sidebottom">
          <span className={'connection ' + (state ? 'connected' : '')} />
          {state ? '本地服务已连接' : '等待本地数据服务'}
          <small>毛毯 / 服装 / 地垫 · 数据留在本机</small>
          <button className="guide-link" onClick={()=>setGuideOpen(value=>!value)}>新同事使用指南</button>
        </div>
      </aside>
      <main>
        <header>
          <div>
            <span className="eyebrow">
              {currentSection.title} / {currentTool?.title || '辅助与设置'}
            </span>
            <h1>{currentTool?.title || '辅助与设置'}</h1>
          </div>
          <div className="headtools">
            <WorkbenchModeSwitch />
            {professional && <span className="tag" title={`页面 ${workbenchRelease.version} / 服务 ${serverVersion || '连接中'}`}>工作台 {workbenchRelease.version}</span>}
            <Button variant="outline" onClick={()=>setGuideOpen(value=>!value)} aria-expanded={guideOpen}>使用指南</Button>
            <Button
              variant="outline"
              onClick={() => act(load)}
              disabled={busy || restarting}
            >
              <RefreshCw size={15} />
              刷新
            </Button>
            {professional && <Button
              variant="outline"
              onClick={restartWorkbench}
              disabled={busy || restarting}
            >
              {restarting ? '正在重启…' : '重启工作台'}
            </Button>}
          </div>
        </header>
        {serverVersion && serverVersion !== workbenchRelease.version && (
          <div className="banner warning" role="alert">
            页面版本 {workbenchRelease.version}，后台服务版本 {serverVersion}。请先结束正在运行的任务，再点击“重启工作台”加载更新。
          </div>
        )}
        {guideOpen && <Onboarding open={setTab} onClose={()=>setGuideOpen(false)} />}
        {browserContext.client_id && (professional || tab !== 'images') && (
          <div className="banner">
            <span>
              <strong>
                {browserContext.browser || '浏览器'} ·{' '}
                {browserContext.store_name ||
                  browserContext.mall_id ||
                  '等待识别店铺'}
              </strong>
              <br />
              {scopeMall
                ? '当前默认只看并操作这个浏览器登录的店铺；可以切换到汇总视图查看所有店铺。'
                : '当前为全部店铺汇总视图；真实调价、报名、下架仍只会由匹配店铺的浏览器领取。'}
            </span>
            <Button
              variant="outline"
              onClick={toggleScope}
              disabled={!browserContext.mall_id}
            >
              {scopeMode === 'browser' ? '查看全部店铺' : '回到当前浏览器店铺'}
            </Button>
          </div>
        )}
        <Patrol key={scopeMall} preferredMall={scopeMall} active={tab === 'patrol'} onOpen={()=>setTab('patrol')} />
        {tab === 'analysis' && (
          <TrafficDashboard
            open={setTab}
            preferredMall={scopeMall}
            preferredStore={browserContext.store_name || ''}
            preferredClient={browserContext.client_id || ''}
          />
        )}
        {tab === 'qualification' && <Qualification />}
        {tab === 'home' && <FocusHome open={setTab} />}
        {tab === 'activity' && <ActivityJobs preferredMall={scopeMall} />}
        {tab === 'traffic-accelerator' && <TrafficAccelerator preferredMall={scopeMall} preferredStore={scopeMall ? browserContext.store_name || '' : ''} />}
        {tab === 'product-status' && <ProductStatus preferredMall={scopeMall} clientId={browserContext?.client_id || ''} />}
        {tab === 'features' && <FeatureCenter preferredMall={scopeMall} open={setTab} />}
        {tab === 'delisting' && <Delisting />}
        {tab === 'more' && <MoreTools open={setTab} />}
        {error && (
          <div role="alert" className="banner danger">
            <AlertCircle size={18} />
            {error}
          </div>
        )}
        {message && (
          <div role="status" className="banner success">
            {message}
          </div>
        )}
        {tab === 'overview' && (
          <div className="banner">
            <span>
              此处仅分析手工导入的
              CSV。查看插件刚同步的实时与每日曝光，请进入经营数据接入。
            </span>
            <Button onClick={() => setTab('collector')}>
              查看最新后台数据
            </Button>
          </div>
        )}
        {tab === 'overview' && !!state?.catalog?.length && (
          <div className="banner success">
            <span>
              已保存 {state.catalog.length}{' '}
              款商品历史状态。当前为部分快照，包含待核对的加站异常。
            </span>
            <Button variant="outline" onClick={() => setTab('catalog')}>
              查看商品状态
            </Button>
          </div>
        )}
        {tab === 'daily' && (
          <Daily
            navigate={setTab}
            onChanged={() => load().catch((e) => setError(e.message))}
            preferredMall={scopeMall}
            preferredStore={browserContext.store_name || ''}
            preferredClient={browserContext.client_id || ''}
          />
        )}
        {tab === 'collector' && (
          <Collector
            preferredMall={scopeMall}
            onReview={(r) => {
              setReview({ ...review, ...r });
              setTab('reviews');
            }}
          />
        )}
        {tab === 'traffic' && (
          <Traffic
            rows={state?.traffic || []}
            captures={state?.traffic_captures || []}
            onReview={(r) => {
              setReview({
                ...review,
                title: r.title,
                product_id: r.product_id,
                shop: r.shop,
                site: r.site,
                notes: r.date + '：' + r.reason + '。' + r.action,
              });
              setTab('reviews');
            }}
          />
        )}
        {tab === 'catalog' && (
          <Catalog
            records={state?.catalog || []}
            collections={state?.collections || []}
            onReview={(r) => {
              setReview({
                ...review,
                title: r.title,
                product_id: r.spu,
                shop: r.shop,
                site: r.site,
                action: '上架阻塞处理',
                notes: '平台状态：' + r.status + '；待办：' + r.todo,
              });
              setTab('reviews');
            }}
          />
        )}
        {tab === 'overview' && (
          <>
            <div className="filterbar">
              {[
                ['shop', '全部店铺'],
                ['site', '全部站点'],
                ['currency', '全部币种'],
                ['level', '全部层级'],
              ].map(([key, label]) => (
                <Select
                  key={key}
                  aria-label={label}
                  value={(filters as Row)[key]}
                  onChange={(v: string) => setFilters({ ...filters, [key]: v })}
                >
                  <option value="">{label}</option>
                  {[...new Set(scopes.map((s) => s[key]))].map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </Select>
              ))}
              <Input
                aria-label="开始日期"
                type="date"
                value={filters.start}
                onChange={(e) =>
                  setFilters({ ...filters, start: e.target.value })
                }
              />
              <span>至</span>
              <Input
                aria-label="结束日期"
                type="date"
                value={filters.end}
                onChange={(e) =>
                  setFilters({ ...filters, end: e.target.value })
                }
              />
            </div>
            <div className="banner">
              <AlertCircle size={18} />
              <span>
                {state?.fact_count
                  ? '汇总只覆盖已导入记录，不代表后台全量。缺失值显示为 —，不能视为零。'
                  : '还没有导入经营数据。先连接一份报表，再开始判断款式表现。'}{' '}
                <button className="textlink" onClick={() => setTab('data')}>
                  查看数据范围 →
                </button>
              </span>
            </div>
            <div className="stats">
              {stats.map(([title, value, detail]) => (
                <div className="stat" key={String(title)}>
                  <span>{title}</span>
                  <strong>{fmt(value, 2)}</strong>
                  <small>{detail}</small>
                </div>
              ))}
            </div>
            <section className="panel">
              <div className="sectionhead">
                <div>
                  <h2>今天先处理这些款</h2>
                  <p>先看数据和样本，再决定改图、检查价格或继续观察。</p>
                </div>
                <span className="tag">{products.length} 个商品</span>
              </div>
              <div className="tabletools">
                <Input
                  aria-label="搜索商品"
                  placeholder="搜索商品标题或 ID"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              <BatchSelectionTools selection={csvSelection} total={shown.length} label="CSV商品复盘" copyFields={[{label:'商品ID',value:r=>r.product_id}]} columns={[{label:'商品ID',value:r=>r.product_id},{label:'标题',value:r=>r.title},{label:'店铺',value:r=>r.shop},{label:'曝光',value:r=>r.impressions},{label:'订单',value:r=>r.orders},{label:'观察结果',value:r=>r.reason}]} />
              {shown.length ? (
                <div className="tablewrap">
                  <table>
                    <thead>
                      <tr>
                        <th>选择</th>
                        <th>商品 / 店铺</th>
                        <th>曝光</th>
                        <th>点击率</th>
                        <th>订单</th>
                        <th>贡献结余</th>
                        <th>观察结果</th>
                        <th>建议动作</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {csvSelection.visibleRows.map((r) => (
                        <tr
                          key={[
                            r.shop,
                            r.site,
                            r.currency,
                            r.level,
                            r.product_id,
                          ].join('|')}
                        >
                          <td><input type="checkbox" aria-label={'选择复盘商品 '+r.product_id} checked={csvSelection.isSelected(r)} onChange={e=>csvSelection.toggle(r,e.target.checked)} /></td>
                          <td>
                            <strong>{r.title || r.product_id}</strong>
                            <small>
                              {r.shop} · {r.site} · {r.level} {r.product_id}
                            </small>
                            <small>
                              已记录 {r.days} 日 · {r.currency}
                            </small>
                          </td>
                          <td>{fmt(r.impressions)}</td>
                          <td>{r.ctr == null ? '—' : fmt(r.ctr, 2) + '%'}</td>
                          <td>{fmt(r.orders)}</td>
                          <td className={r.contribution < 0 ? 'negative' : ''}>
                            {fmt(r.contribution, 2)}
                          </td>
                          <td>
                            <span
                              className={
                                'tag ' +
                                (r.reason === '贡献亏损'
                                  ? 'red'
                                  : r.reason === '继续观察'
                                    ? 'green'
                                    : 'amber')
                              }
                            >
                              {r.reason}
                            </span>
                          </td>
                          <td className="actioncell">{r.action}</td>
                          <td>
                            <Button
                              variant="ghost"
                              onClick={() => {
                                setReview({
                                  ...review,
                                  title: r.title || r.product_id,
                                  product_id: r.product_id,
                                  shop: r.shop,
                                  site: r.site,
                                });
                                setTab('reviews');
                              }}
                            >
                              记录
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <Empty
                  title={
                    products.length ? '没有匹配的商品' : '从一份真实报表开始'
                  }
                  detail="导入每日曝光、点击和订单数据，工作台会给出可追踪的观察建议。"
                >
                  <Button onClick={() => setTab('data')}>
                    <Upload size={16} />
                    导入第一份报表
                  </Button>
                </Empty>
              )}
            </section>
            <div className="twocol">
              <section className="panel">
                <div className="sectionhead">
                  <h2>一款商品的工作流</h2>
                </div>
                {[
                  ['selection', '01', '选品判断', '销量、价格、印花与来源'],
                  [
                    'images',
                    '02',
                    'GPT 套图',
                    '按模板数量生成独立图片，审核后交付',
                  ],
                  ['listing', '03', '店小秘上架', '复用现有批量工具'],
                  ['reviews', '04', '数据复盘', '记录动作，再看后续变化'],
                ].map(([id, n, title, detail]) => (
                  <button
                    className="flowrow"
                    key={id}
                    onClick={() => setTab(id)}
                  >
                    <b>{n}</b>
                    <span>
                      <strong>{title}</strong>
                      <small>{detail}</small>
                    </span>
                    <ArrowUpRight size={18} />
                  </button>
                ))}
              </section>
              <section className="panel">
                <div className="sectionhead">
                  <h2>连接状态</h2>
                </div>
                {[
                  [
                    '商家后台直接采集',
                    '正确扩展已适配 · 在数据接入查看回执',
                    'amber',
                  ],
                  ['本地报表导入', '可使用', 'green'],
                  ['GPT 自动生图', '提示词可用 · RPA 待接', 'amber'],
                  [
                    '店小秘批量上架',
                    state?.tools?.uploader?.available
                      ? '已找到本地工具'
                      : '未检测到',
                    '',
                  ],
                ].map(([label, status, color]) => (
                  <div className="statusrow" key={label}>
                    <span>{label}</span>
                    <span className={'tag ' + color}>{status}</span>
                  </div>
                ))}
                <p className="panelnote">
                  经营数据通过 Temu 数据采集助手扩展接入。金额与成本可通过 CSV
                  补充。报活动、改价与上架结果以平台为准。
                </p>
              </section>
            </div>
          </>
        )}
        {tab === 'data' && (
          <>
            <section className="panel">
              <div className="sectionhead">
                <div>
                  <h2>导入每日商品报表</h2>
                  <p>
                    分次导入流量、订单与成本；同键合并，已有值以本次非空值更新。
                  </p>
                </div>
                <span className="tag green">本地保存</span>
              </div>
              <div className="importdrop">
                <Upload size={26} />
                <strong>选择后台导出的 CSV 文件</strong>
                <p>
                  每行一个商品的一天。Excel 请先另存为 CSV，商品ID保留文本格式。
                </p>
                <input
                  aria-label="选择 CSV 文件"
                  type="file"
                  accept=".csv,text/csv"
                  onChange={(e) => readFile(e.target.files?.[0])}
                />
              </div>
              <div className="formgrid">
                {[
                  ['shop', '店铺名称'],
                  ['site', '站点（例如 US）'],
                  ['currency', '币种（USD / CNY）'],
                ].map(([k, v]) =>
                  formInput(
                    context,
                    (obj) => {
                      setContext(obj as any);
                      setChecked(null);
                    },
                    k,
                    v,
                  ),
                )}
                <Field name="商品层级">
                  <Select
                    value={context.level}
                    onChange={(v: string) => {
                      setContext({ ...context, level: v });
                      setChecked(null);
                    }}
                  >
                    <option>SKU</option>
                    <option>SPU</option>
                  </Select>
                </Field>
                <Field name="单日日期（无日期列时）">
                  <Input
                    type="date"
                    value={context.date}
                    onChange={(e) => {
                      setContext({ ...context, date: e.target.value });
                      setChecked(null);
                    }}
                  />
                </Field>
              </div>
              {preview && (
                <>
                  <div className="sectionhead">
                    <h3>
                      {source.name} · {preview.count} 行
                    </h3>
                    <span>请核对对应字段</span>
                  </div>
                  <div className="mapping">
                    {Object.entries(fields).map(([k, v]) => (
                      <Field name={v} key={k}>
                        <Select
                          value={mapping[k] || ''}
                          onChange={(val: string) => {
                            setMapping({ ...mapping, [k]: val });
                            setChecked(null);
                          }}
                        >
                          <option value="">不导入 / 缺失</option>
                          {preview.headers.map((h: string) => (
                            <option key={h}>{h}</option>
                          ))}
                        </Select>
                      </Field>
                    ))}
                  </div>
                  <div className="banner">
                    <AlertCircle size={18} />
                    <span>
                      金额须为当前币种、当前商品当天合计。销售额不能映射为结算收入，单件成本须先换算。区间合计不能当作日数据。
                    </span>
                  </div>
                  <div className="buttons">
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        act(async () =>
                          setChecked(
                            await api('preview', {
                              ...source,
                              mapping,
                              context,
                            }),
                          ),
                        )
                      }
                    >
                      检查并预览
                    </Button>
                    <Button
                      disabled={busy || !checked || checked.error_count > 0}
                      onClick={() =>
                        act(async () => {
                          const r = await api('import', {
                            ...source,
                            mapping,
                            context,
                          });
                          setMessage(
                            `已导入 ${r.rows} 行：新增 ${r.added} 行，合并 ${r.updated} 行`,
                          );
                          setChecked(null);
                          await load();
                        })
                      }
                    >
                      确认写入本机
                    </Button>
                  </div>
                  {checked && (
                    <div className="preview">
                      <p>
                        {checked.error_count
                          ? `发现 ${checked.error_count} 行问题，未写入数据`
                          : `检查通过，${checked.count} 行可导入`}
                      </p>
                      {checked.errors?.map((e: Row) => (
                        <p className="negative" key={e.row}>
                          第 {e.row} 行：{e.reason}
                        </p>
                      ))}
                      <div className="tablewrap">
                        <table>
                          <thead>
                            <tr>
                              <th>日期</th>
                              <th>商品ID</th>
                              <th>标题</th>
                              <th>曝光</th>
                              <th>点击</th>
                              <th>订单</th>
                            </tr>
                          </thead>
                          <tbody>
                            {checked.sample.map((r: Row) => (
                              <tr key={r.date + r.product_id}>
                                <td>{r.date}</td>
                                <td>{r.product_id}</td>
                                <td>{r.title}</td>
                                <td>{fmt(r.impressions)}</td>
                                <td>{fmt(r.clicks)}</td>
                                <td>{fmt(r.orders)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </>
              )}
            </section>
            <section className="panel">
              <div className="sectionhead">
                <h2>导入记录</h2>
                <span>{state?.fact_count || 0} 条日数据</span>
              </div>
              {state?.batches?.length ? (
                <div className="tablewrap">
                  <table>
                    <thead>
                      <tr>
                        <th>导入时间</th>
                        <th>文件</th>
                        <th>行数</th>
                        <th>范围</th>
                      </tr>
                    </thead>
                    <tbody>
                      {state.batches.map((b: Row) => (
                        <tr key={b.id}>
                          <td>{b.created.replace('T', ' ')}</td>
                          <td>{b.name}</td>
                          <td>{b.rows}</td>
                          <td>
                            {Object.values(JSON.parse(b.context))
                              .filter(Boolean)
                              .join(' · ')}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="panelnote">
                  暂无导入记录，尚未读取到商家后台的经营明细。
                </p>
              )}
            </section>
            <section className="panel">
              <div className="sectionhead">
                <h2>已导入日期覆盖</h2>
              </div>
              <div className="coverage">
                {Object.entries(state?.coverage || {})
                  .sort()
                  .map(([d, n]) => (
                    <span className="tag" key={d}>
                      {d} · {String(n)} 行
                    </span>
                  ))}
              </div>
              <p className="panelnote">
                有记录不代表当天商品已全量采齐，缺失日期不会自动补零。
              </p>
            </section>
          </>
        )}
        {tab === 'selection' && (
          <>
            <section className="panel">
              <div className="sectionhead">
                <div>
                  <h2>小狮子选品与轮播图采集</h2>
                  <p>
                    使用带有图片采集助手的专用浏览器，打开 Temu 前台，按条件筛选商品并收集轮播图。
                  </p>
                </div>
                <span
                  className={
                    'tag ' +
                    (state?.tools?.lion_scraper_chrome?.available
                      ? 'green'
                      : 'amber')
                  }
                >
                  {state?.tools?.lion_scraper_chrome?.available
                    ? '已并入主扩展'
                    : '安装文件缺失'}
                </span>
              </div>
              <div className="buttons">
                <Button
                  disabled={busy || !state?.tools?.lion_scraper_chrome?.available}
                  onClick={() =>
                    act(async () => {
                      setMessage(
                        (
                          await api('colleague-browser/open', {
                            target: 'selection',
                          })
                        ).message,
                      );
                    })
                  }
                >
                  打开选品采图浏览器
                </Button>
              </div>
              <div className="listingsteps">
                {[
                  '点击“打开选品采图浏览器”，助手随专用浏览器自动加载',
                  '在打开的 Temu 前台搜索商品，进入需要采集的商品列表',
                  '点击页面金色悬浮球，设置筛选、翻页次数和“同时获取轮播图”',
                  '先预览采集结果，再按需要导出图片和编号，记录参考来源',
                ].map((text, index) => (
                  <div key={text}>
                    <b>0{index + 1}</b>
                    <p>{text}</p>
                  </div>
                ))}
              </div>
              <p className="panelnote">
                小狮子与店铺采集、活动报名和批量下架共用一个主扩展；采集结果仍保存在当前浏览器扩展本地，并从悬浮面板预览或导出 TXT。工作台不保存 Temu 密码，也不会访问原授权服务器。
              </p>
            </section>
            <div className="twocol">
            <section className="panel">
              <div className="sectionhead">
                <div>
                  <h2>保存一个选品判断</h2>
                  <p>记录潜力和来源，后续对照实际表现。</p>
                </div>
              </div>
              <div className="formstack">
                {formInput(draft, setDraft, 'title', '款式名称')}
                <div className="formgrid">
                  <Field name="目标品类">
                    <Select
                      value={draft.category}
                      onChange={(v: string) =>
                        setDraft({ ...draft, category: v })
                      }
                    >
                      <option>毛毯</option>
                      <option>地垫</option>
                    </Select>
                  </Field>
                  <Field name="开发方式">
                    <Select
                      value={draft.route}
                      onChange={(v: string) => setDraft({ ...draft, route: v })}
                    >
                      <option>印花创新</option>
                      <option>截流参考</option>
                    </Select>
                  </Field>
                </div>
                {formInput(draft, setDraft, 'url', '参考商品链接')}
                <div className="formgrid">
                  {formInput(
                    draft,
                    setDraft,
                    'sales',
                    '云启日销量（观察值）',
                    'number',
                  )}
                  {formInput(draft, setDraft, 'price', '参考售价', 'number')}
                  {formInput(draft, setDraft, 'currency', '币种')}
                </div>
                {formInput(draft, setDraft, 'theme', '印花主题')}
                <Field name="判断理由与素材来源">
                  <Textarea
                    value={draft.notes}
                    onChange={(e) =>
                      setDraft({ ...draft, notes: e.target.value })
                    }
                    placeholder="为什么想做？参考图是否可用？差异在哪？"
                  />
                </Field>
                <Button
                  disabled={busy || !draft.title.trim()}
                  onClick={() =>
                    act(async () => {
                      await save('opportunity', {
                        ...draft,
                        observed_at: today(),
                      });
                      setDraft({ ...draft, title: '', notes: '' });
                    })
                  }
                >
                  加入选品池
                </Button>
              </div>
            </section>
            <section className="panel">
              <div className="sectionhead">
                <h2>待判断与已选款</h2>
                <span>{entries('opportunity').length} 款</span>
              </div>
              {entries('opportunity').length ? (
                entries('opportunity').map((e: Row) => (
                  <article className="entry" key={e.id}>
                    <div className="entryhead">
                      <strong>{e.payload.title}</strong>
                      <span className="tag">{e.payload.status}</span>
                    </div>
                    <p>
                      {e.payload.category} · {e.payload.route} ·{' '}
                      {e.payload.theme || '未填主题'}
                    </p>
                    <p>
                      日销量 {e.payload.sales || '—'} · 参考价{' '}
                      {e.payload.price || '—'} {e.payload.currency} ·{' '}
                      {e.payload.observed_at}
                    </p>
                    <p>{e.payload.notes}</p>
                    <div className="buttons">
                      <Button
                        variant="outline"
                        onClick={() => {
                          setImageTask({
                            ...imageTask,
                            title: e.payload.title,
                            category: e.payload.category,
                            theme: e.payload.theme,
                            reference: e.payload.url,
                          });
                          setTab('images');
                        }}
                      >
                        准备套图
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={() =>
                          act(() =>
                            save(
                              e.kind,
                              {
                                ...e.payload,
                                status:
                                  e.payload.status === '暂缓'
                                    ? '待判断'
                                    : '暂缓',
                              },
                              e.id,
                            ),
                          )
                        }
                      >
                        {e.payload.status === '暂缓' ? '恢复观察' : '暂缓'}
                      </Button>
                    </div>
                  </article>
                ))
              ) : (
                <Empty
                  title="保留你的选品判断"
                  detail="销量和参考价只是线索。记录主题与来源，复盘哪类印花更适合你的店。"
                />
              )}
            </section>
            </div>
          </>
        )}
        {tab === 'images' && <ImageQueue draft={imageTask} />}
        {tab === 'filetools' && (
          <FileTools
            available={!!state?.tools?.long_path_mover?.available}
            busy={busy}
            onLaunch={() =>
              act(async () =>
                setMessage(
                  (await api('launch', { tool: 'long_path_mover' })).message,
                ),
              )
            }
          />
        )}
        {tab === 'listing' && (
          <>
            <section className="panel">
              <div className="sectionhead">
                <div>
                  <h2>店小秘批量上架</h2>
                  <p>
                    已接入店小秘独立版，支持毛毯、普通 T 恤与黑白 T 恤。打开后核对店铺、模板、细节图和图片处理方式，再开始当前批次。
                  </p>
                </div>
                <span className="tag">
                  {state?.tools?.uploader?.available
                    ? `独立版 v${state?.tools?.uploader?.version || workbenchComponents.uploader.version}`
                    : '工具未找到'}
                </span>
              </div>
              <div className="listingsteps">
                {[
                  '选择毛毯、普通 T 恤或黑白 T 恤脚本，并使用对应店铺模板',
                  '黑白 T 恤分别配置白色、黑色细节图，运行前逐款核对顺序',
                  '图片可保留原图、按比例缩小或填充到指定尺寸；默认填充 1200×1200',
                  '扫描并核对预计上传尺寸后开始；记录保存在当前电脑的独立版数据目录',
                ].map((s, i) => (
                  <div key={s}>
                    <b>0{i + 1}</b>
                    <p>{s}</p>
                  </div>
                ))}
              </div>
              <Button
                disabled={busy || !state?.tools?.uploader?.available}
                onClick={() =>
                  act(async () =>
                    setMessage(
                      (await api('launch', { tool: 'uploader' })).message,
                    ),
                  )
                }
              >
                打开店小秘上架 {state?.tools?.uploader?.version || workbenchComponents.uploader.version}
                <ArrowUpRight size={16} />
              </Button>
              <p className="panelnote">
                此按钮只启动工具窗口。工作台尚未接收上架回执，请以店小秘和商家后台为准。
              </p>
            </section>
            <section className="panel">
              <div className="sectionhead">
                <h2>后台入口</h2>
              </div>
              <div className="buttons">
                <a
                  className="external"
                  href="https://www.dianxiaomi.com/web/popTemu/pageList/offline"
                  target="_blank"
                  rel="noreferrer"
                >
                  店小秘商品管理 ↗
                </a>
                <a
                  className="external"
                  href="https://agentseller-us.temu.com/main/flux-analysis"
                  target="_blank"
                  rel="noreferrer"
                >
                  美国站商品流量 ↗
                </a>
                <a
                  className="external"
                  href="https://agentseller.temu.com/newon/product-select"
                  target="_blank"
                  rel="noreferrer"
                >
                  上新生命周期 ↗
                </a>
              </div>
            </section>
          </>
        )}
        {tab === 'reviews' && (
          <div className="twocol">
            <section className="panel">
              <div className="sectionhead">
                <div>
                  <h2>记录一次运营动作</h2>
                  <p>改了什么、为什么改、何时复查。</p>
                </div>
              </div>
              <div className="formstack">
                {[
                  ['title', '商品或记录名称'],
                  ['product_id', '商品ID'],
                  ['shop', '店铺'],
                  ['site', '站点'],
                ].map(([k, v]) => formInput(review, setReview, k, v))}
                <Field name="动作">
                  <Select
                    value={review.action}
                    onChange={(v: string) =>
                      setReview({ ...review, action: v })
                    }
                  >
                    {[
                      '主图测试',
                      '价格检查',
                      '活动评估',
                      '库存检查',
                      '印花扩款',
                      '暂停观察',
                      '上架阻塞处理',
                    ].map((x) => (
                      <option key={x}>{x}</option>
                    ))}
                  </Select>
                </Field>
                <div className="formgrid">
                  {formInput(review, setReview, 'date', '执行日期', 'date')}
                  {formInput(review, setReview, 'followup', '复查日期', 'date')}
                </div>
                <Field name="改动与判断依据">
                  <Textarea
                    value={review.notes}
                    onChange={(e) =>
                      setReview({ ...review, notes: e.target.value })
                    }
                  />
                </Field>
                <Button
                  disabled={busy || !review.title.trim()}
                  onClick={() =>
                    act(async () => {
                      await save('review', review);
                      setReview({ ...review, title: '', notes: '' });
                    })
                  }
                >
                  保存复盘记录
                </Button>
              </div>
            </section>
            <section className="panel">
              <div className="sectionhead">
                <h2>行动时间线</h2>
              </div>
              {entries('review').length ? (
                entries('review').map((e: Row) => (
                  <article key={e.id} className="entry">
                    <div className="entryhead">
                      <strong>{e.payload.title}</strong>
                      <span className="tag">{e.payload.action}</span>
                    </div>
                    <p>
                      {e.payload.date} · {e.payload.shop} · {e.payload.site} ·{' '}
                      {e.payload.product_id}
                    </p>
                    <p>{e.payload.notes}</p>
                    {e.payload.followup && (
                      <span
                        className={
                          'tag ' +
                          (e.payload.status === 'done'
                            ? 'green'
                            : e.payload.followup <= today()
                              ? 'amber'
                              : '')
                        }
                      >
                        {e.payload.status === 'done'
                          ? '已复查 · '
                          : '复查日期 '}
                        {e.payload.followup}
                      </span>
                    )}
                    {e.payload.outcome && <p>复查结果：{e.payload.outcome}</p>}
                    {e.payload.followup &&
                      e.payload.followup <= today() &&
                      e.payload.status !== 'done' && (
                        <Button variant="ghost" onClick={() => setTab('daily')}>
                          去完成复查
                        </Button>
                      )}
                  </article>
                ))
              ) : (
                <Empty
                  title="让每次调整都有记录"
                  detail="例如只换一张主图，记录日期，再用后续同口径数据判断变化。"
                />
              )}
              <p className="panelnote">
                复查日期保存在此处，当前版本不会自动发送提醒。
              </p>
            </section>
          </div>
        )}
        {tab === 'settings' && (
          <section className="panel narrow">
            <div className="sectionhead">
              <div>
                <h2>你的观察线</h2>
                <p>这些是可调整的工作假设，不是 Temu 平台基准或出单保证。</p>
              </div>
            </div>
            <div className="formstack">
              {[
                ['min_impressions', '最低曝光样本'],
                ['min_clicks', '最低点击样本'],
                ['ctr', '点击率观察线（%）'],
                ['order_ratio', '下单 / 点击比观察线（%）'],
              ].map(([k, v]) => (
                <Field key={k} name={v}>
                  <Input
                    type="number"
                    min="0"
                    step="any"
                    value={ruleDraft[k]}
                    onChange={(e) =>
                      setRuleDraft({ ...ruleDraft, [k]: e.target.value })
                    }
                  />
                </Field>
              ))}
              <Button
                disabled={busy}
                onClick={() =>
                  act(async () => {
                    await api('rules', ruleDraft);
                    await load();
                    setMessage('观察线已保存，诊断已更新');
                  })
                }
              >
                保存观察线
              </Button>
            </div>
            <p className="panelnote">
              点击率 = 点击次数 ÷ 曝光次数。下单 / 点击比 = 订单数 ÷
              点击次数，只是粗略指标，不等同于后台访客支付转化率。
            </p>
            <p className="panelnote">
              贡献结余 = 结算收入 − 商品成本 − 履约成本 − 广告费 − 退款损失 −
              其他成本。均为当日商品合计；收入已扣除的费用不能再次扣除。缺一项即不显示结余。
            </p>
          </section>
        )}
        <footer>
          巡店 · 维护 · 上新 ｜ 数据保存在当前电脑
        </footer>
      </main>
    </div>
  );
}
