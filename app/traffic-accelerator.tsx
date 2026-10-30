'use client';
import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, RefreshCw, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';

type ExtensionReply = {
  ok?: boolean;
  error?: string;
  version?: string;
  capabilities?: string[];
  message?: string;
};
type Command = 'WORKBENCH_PING' | 'WORKBENCH_OPEN_TRAFFIC_ACCELERATOR';

function extensionRequest(command: Command, signal: AbortSignal, timeoutMs = 5000): Promise<ExtensionReply> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('页面已关闭')); return; }
    if (window.location.origin !== 'http://127.0.0.1:5173') {
      reject(new Error('请使用启动器打开 http://127.0.0.1:5173，再连接统一工作台插件。'));
      return;
    }
    const id = crypto.randomUUID();
    const cleanup = () => {
      clearTimeout(timer);
      window.removeEventListener('message', receive);
      signal.removeEventListener('abort', abort);
    };
    const abort = () => { cleanup(); reject(new Error('页面已关闭')); };
    const receive = (event: MessageEvent) => {
      if (event.source !== window || event.origin !== window.location.origin) return;
      if (event.data?.source !== 'temu-workbench-extension' || event.data?.id !== id) return;
      cleanup();
      const result = event.data.result as ExtensionReply | undefined;
      if (!result || typeof result !== 'object') { reject(new Error('插件响应异常，请重新加载统一工作台插件。')); return; }
      resolve(result);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(command === 'WORKBENCH_PING'
        ? '尚未连接统一工作台插件。安装或重新加载后，请刷新此页面再检测。'
        : '插件未能及时打开面板。请查看卖家标签页；若面板未出现，请重新加载插件并刷新页面。'));
    }, timeoutMs);
    window.addEventListener('message', receive);
    signal.addEventListener('abort', abort, { once: true });
    window.postMessage({ source: 'temu-workbench-web', id, command }, window.location.origin);
  });
}

export default function TrafficAccelerator({ preferredMall = '', preferredStore = '' }: { preferredMall?: string; preferredStore?: string }) {
  const [connected, setConnected] = useState(false);
  const [version, setVersion] = useState('');
  const [checking, setChecking] = useState(true);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const lifecycle = useRef<AbortController | null>(null);

  async function checkConnection(signal: AbortSignal) {
    setChecking(true);
    setError('');
    try {
      const result = await extensionRequest('WORKBENCH_PING', signal);
      if (!result.ok || !result.capabilities?.includes('traffic-accelerator')) {
        throw new Error(result.error || '当前插件版本还未整合流量加速器，请加载随包提供的统一工作台插件。');
      }
      setConnected(true);
      setVersion(result.version || '');
    } catch (reason: unknown) {
      if (!signal.aborted) { setConnected(false); setError(reason instanceof Error ? reason.message : '插件连接失败'); }
    } finally {
      if (!signal.aborted) setChecking(false);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    lifecycle.current = controller;
    void checkConnection(controller.signal);
    return () => controller.abort();
  }, []);

  async function openAssistant() {
    const signal = lifecycle.current?.signal;
    if (!signal || signal.aborted || opening) return;
    setOpening(true);
    setError('');
    setMessage('');
    try {
      const result = await extensionRequest('WORKBENCH_OPEN_TRAFFIC_ACCELERATOR', signal, 45000);
      if (!result.ok) throw new Error(result.error || '面板打开失败，请确认已登录 Temu 美国站卖家后台。');
      setConnected(true);
      setMessage(result.message || '已打开卖家后台的流量加速器面板。请先核对当前店铺和规则，再选择只读扫描或一键开启。');
    } catch (reason: unknown) {
      if (!signal.aborted) setError(reason instanceof Error ? reason.message : '打开失败');
    } finally {
      if (!signal.aborted) setOpening(false);
    }
  }

  return <div className="feature-center">
    <section className="panel">
      <div className="sectionhead">
        <div><h2><Zap size={21} style={{ display: 'inline', verticalAlign: 'middle' }} /> 流量加速器</h2><p>工作台统一入口 · 已整合流量加速助手 v1.0.6</p></div>
        <span className={'tag ' + (connected ? 'green' : 'amber')}>{checking ? '正在检测插件' : connected ? `插件已连接${version ? ' · ' + version : ''}` : '等待连接插件'}</span>
      </div>
      <p>在当前浏览器打开 Temu 美国站“经营分析 → 流量分析”，并显示加速器操作面板。</p>
      {(preferredMall || preferredStore) && <div className="banner"><span><strong>工作台当前范围：{preferredStore || '当前店铺'}{preferredMall ? ` · ${preferredMall}` : ''}</strong><br />打开后请核对卖家后台实际登录的店铺；助手使用目标标签页中的店铺和商品列表。</span></div>}
      <div className="buttons">
        <Button onClick={openAssistant} disabled={opening || checking}><ArrowUpRight size={16} />{opening ? '正在打开面板…' : '打开流量加速器面板'}</Button>
        <Button variant="outline" disabled={opening || checking} onClick={() => { if (lifecycle.current) void checkConnection(lifecycle.current.signal); }}><RefreshCw size={15} />{checking ? '检测中…' : '重新检测插件'}</Button>
      </div>
      <p className="panelnote">打开入口只显示面板。扫描和提交由你在面板中分别启动；“一键开启”会实际填写申报价格并提交开启请求。</p>
      {error && <div className="banner danger" role="alert">{error}</div>}
      {message && <div className="banner success" role="status">{message}</div>}
    </section>

    <section className="panel">
      <div className="sectionhead"><div><h2>使用顺序</h2><p>每位同事使用自己浏览器登录的店铺；先确认规则，再开始任务。</p></div><span className="tag">保持目标标签页可见</span></div>
      <ol>
        <li>打开面板，核对店铺、商品筛选范围、类目、活动标签和每条完整 SKU 的价格。</li>
        <li>先点“只读扫描”，核对独立商品数量和列表筛选结果。扫描不会打开商品或提交；SKU 和价格窗口仍需在实际开启流程中核验。</li>
        <li>确认无误后，在面板点“一键开启”。助手逐件核对规则、选择持续 14 天、填写价格并提交，遇到不确定结果会停止等待核实。</li>
        <li>运行中使用面板“暂停／停止”；结束后导出结果 CSV。不要同时切换店铺、筛选或每页条数。</li>
      </ol>
      <div className="banner"><span><strong>随包规则需按自己的店铺核对</strong><br />默认类目“小盖毯、午休毯”，活动标签“限时秒杀”；40*50in、50*60in、60*80in 法兰绒 SKU 的申报价分别为 49、68、83 元。可在面板修改并导出规则备份，持续时间固定为 14 天。</span></div>
      <p className="panelnote">成功记录与待核实记录保存在当前浏览器的本机扩展存储中。不同同事和不同插件 ID 不共享记录；更换为统一插件前，先在旧助手导出完整 JSON 备份，再在统一助手导入同一店铺的完整备份，并人工核对来源店铺 ID；结果 CSV 仅供查看，不能迁移去重历史。</p>
    </section>

    <section className="panel">
      <div className="sectionhead"><div><h2>首次安装与更新</h2><p>使用整合包中的一个统一工作台插件，同时提供原工作台功能和流量加速器。</p></div></div>
      <ol>
        <li>将同事版整合包完整解压到固定文件夹，按随包说明启动工作台。</li>
        <li>在 Edge 的扩展管理页（edge://extensions）或 Chrome 的扩展管理页（chrome://extensions）开启开发者模式。</li>
        <li>选择“加载已解压的扩展程序”，选中整合包中的 browser_extension 文件夹。</li>
        <li>如需替换旧的独立流量加速助手，先导出完整 JSON 备份，人工核对来源店铺 ID 后在统一助手按同一店铺导入，再停用旧助手。确认历史成功和待核实记录已导入前，请保留旧插件。</li>
        <li>刷新工作台与卖家页面，再点“重新检测插件”。更新时在扩展管理页点“重新加载”，然后刷新两个页面。</li>
      </ol>
      <p className="panelnote">找不到插件时，请确认工作台与卖家后台使用同一个浏览器和用户资料，并通过启动器打开 http://127.0.0.1:5173。也可以从统一插件的弹窗或侧边面板直接打开“流量加速器”。</p>
    </section>
  </div>;
}
