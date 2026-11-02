'use client';
import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, RefreshCw, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {extensionRequest,ExtensionConnectionError,isCurrentBridge,type ExtensionReply} from './traffic-accelerator-bridge';
const recoverableConnectionErrors=new Set(['EXTENSION_CONTEXT_INVALIDATED','BRIDGE_GENERATION_CHANGED','BRIDGE_TIMEOUT','BRIDGE_UPDATE_REQUIRED','BRIDGE_NO_RESPONSE']);

export default function TrafficAccelerator({ preferredMall = '', preferredStore = '' }: { preferredMall?: string; preferredStore?: string }) {
  const [connected, setConnected] = useState(false);
  const [version, setVersion] = useState('');
  const [checking, setChecking] = useState(true);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState('');
  const [connectionError,setConnectionError]=useState('');
  const actionErrorCode=useRef('');
  const [message, setMessage] = useState('');
  const lifecycle = useRef<AbortController | null>(null);
  const pendingCheck = useRef<Promise<ExtensionReply>|null>(null);
  const pendingCheckToken=useRef<object|null>(null);
  const pendingCheckReport=useRef(false);
  const connectedRef = useRef(false);
  const openingRef = useRef(false);
  const scope = useRef(preferredMall);
  scope.current=preferredMall;

  function checkConnection(signal: AbortSignal,reportFailure=true):Promise<ExtensionReply> {
    if(pendingCheck.current){if(reportFailure){pendingCheckReport.current=true;setChecking(true);}return pendingCheck.current;}
    const token={};pendingCheckToken.current=token;
    pendingCheckReport.current=reportFailure;
    const request:Promise<ExtensionReply>=(async()=>{
      if(reportFailure)setChecking(true);
      try {
        const result = await extensionRequest('WORKBENCH_PING', signal);
        if (!result.ok || !result.capabilities?.includes('traffic-accelerator') || !isCurrentBridge(result)) {
          throw new ExtensionConnectionError(result.error || '当前插件尚未提供可用的面板连接，请使用随包统一助手；页面会继续尝试重连。',result.code||'CAPABILITY_MISSING');
        }
        if(signal.aborted)throw new ExtensionConnectionError('页面已关闭','ABORTED');
        connectedRef.current=true;setConnected(true);setVersion(result.version||'');setConnectionError('');
        if(recoverableConnectionErrors.has(actionErrorCode.current)){actionErrorCode.current='';setError('');}
        return result;
      } catch (reason: unknown) {
        if (!signal.aborted) { connectedRef.current=false;setConnected(false);setVersion('');if(pendingCheckToken.current===token&&pendingCheckReport.current)setConnectionError(reason instanceof Error ? reason.message : '插件连接失败，正在自动重试'); }
        throw reason;
      } finally {
        if(pendingCheckToken.current===token){if(!signal.aborted)setChecking(false);pendingCheck.current=null;pendingCheckToken.current=null;pendingCheckReport.current=false;}
      }
    })();
    pendingCheck.current=request;return request;
  }

  useEffect(() => {
    const controller = new AbortController();
    lifecycle.current = controller;
    const check=()=>{if(!document.hidden&&!openingRef.current)void checkConnection(controller.signal).catch(()=>{});};
    const ready=(event:MessageEvent)=>{
      if(event.source!==window||event.origin!==window.location.origin||event.data?.source!=='temu-workbench-extension'||event.data?.event!=='WORKBENCH_BRIDGE_READY'||event.data?.bridgeProtocol!==2||openingRef.current)return;
      const reconnect=()=>{if(!controller.signal.aborted&&!openingRef.current)void checkConnection(controller.signal,false).catch(()=>{});};
      if(pendingCheck.current)void pendingCheck.current.catch(()=>{}).then(()=>{if(!connectedRef.current)reconnect();});else reconnect();
    };
    check();
    const timer=setInterval(()=>{if(!connectedRef.current&&!document.hidden&&!openingRef.current)void checkConnection(controller.signal,false).catch(()=>{});},15000);
    window.addEventListener('focus',check);window.addEventListener('message',ready);
    return () => {controller.abort();pendingCheck.current=null;pendingCheckToken.current=null;pendingCheckReport.current=false;clearInterval(timer);window.removeEventListener('focus',check);window.removeEventListener('message',ready);};
  }, []);
  useEffect(()=>{setMessage('');setError('');actionErrorCode.current='';},[preferredMall]);

  async function openAssistant() {
    const signal = lifecycle.current?.signal;
    if (!signal || signal.aborted || openingRef.current) return;
    const requestedMall=scope.current;
    if(!requestedMall){actionErrorCode.current='INVALID_MALL_SCOPE';setError('请先在工作台顶部选择当前浏览器店铺，再打开该店的流量加速器面板。');return;}
    openingRef.current=true;
    setOpening(true);
    setError('');
    actionErrorCode.current='';
    setMessage('');
    try {
      const bridge=await checkConnection(signal);
      if(scope.current!==requestedMall)throw new ExtensionConnectionError('工作台店铺范围已变化，请在当前范围重新打开面板。','SCOPE_CHANGED');
      const result = await extensionRequest('WORKBENCH_OPEN_TRAFFIC_ACCELERATOR', signal,{timeoutMs:45000,bridgeInstance:bridge.bridgeInstance,mallId:requestedMall});
      if (!result.ok) throw new ExtensionConnectionError(result.error || '面板打开失败，请确认已登录 Temu 美国站卖家后台。',result.code||'OPEN_FAILED');
      if(result.panelOnly!==true)throw new ExtensionConnectionError('未取得仅打开面板的确认，请查看卖家标签页后核对。','PANEL_NOT_CONFIRMED');
      if(result.mallId!==requestedMall)throw new ExtensionConnectionError('未取得所选店铺的面板确认，请核对卖家店铺后再操作。','MALL_NOT_CONFIRMED');
      if(scope.current!==requestedMall)throw new ExtensionConnectionError('面板已打开，但工作台店铺范围已变化。请核对卖家店铺后再操作。','SCOPE_CHANGED');
      setConnected(true);
      setMessage(result.message || '已打开卖家后台的流量加速器面板。请核对当前店铺和规则，面板不会自动开始任务。');
    } catch (reason: unknown) {
      if (!signal.aborted) {
        actionErrorCode.current=reason instanceof ExtensionConnectionError?reason.code:'OPEN_FAILED';
        setError(reason instanceof Error ? reason.message : '打开失败');
        if(reason instanceof ExtensionConnectionError&&['EXTENSION_CONTEXT_INVALIDATED','OPEN_TIMEOUT','BRIDGE_TIMEOUT','BRIDGE_UPDATE_REQUIRED','BRIDGE_GENERATION_CHANGED','BRIDGE_NO_RESPONSE'].includes(reason.code)){connectedRef.current=false;setConnected(false);}
      }
    } finally {
      openingRef.current=false;
      if (!signal.aborted) setOpening(false);
      if(!signal.aborted&&!connectedRef.current)void checkConnection(signal,false).catch(()=>{});
    }
  }

  return <div className="feature-center">
    <section className="panel">
      <div className="sectionhead">
        <div><h2><Zap size={21} style={{ display: 'inline', verticalAlign: 'middle' }} /> 流量加速器</h2><p>工作台统一入口 · 已整合流量加速助手 v1.0.7</p></div>
        <span className={'tag ' + (connected ? 'green' : 'amber')} aria-label="加速器插件连接状态">{checking ? '正在连接插件' : connected ? `插件已连接${version ? ' · ' + version : ''}` : '未连接，正在自动重试'}</span>
      </div>
      <p>在当前浏览器打开 Temu 美国站“经营分析 → 流量分析”，并显示加速器操作面板。</p>
      {(preferredMall || preferredStore) && <div className="banner"><span><strong>工作台当前范围：{preferredStore || '当前店铺'}{preferredMall ? ` · ${preferredMall}` : ''}</strong><br />打开后请核对卖家后台实际登录的店铺；助手使用目标标签页中的店铺和商品列表。</span></div>}
      {!preferredMall&&<div className="banner">请先在工作台顶部选择当前浏览器店铺，再打开该店的面板。</div>}
      <div className="buttons">
        <Button onClick={openAssistant} disabled={opening || checking}><ArrowUpRight size={16} />{opening ? '正在打开面板…' : '打开流量加速器面板'}</Button>
        <Button variant="outline" disabled={opening || checking} onClick={() => {setMessage('');if (lifecycle.current) void checkConnection(lifecycle.current.signal).catch(()=>{}); }}><RefreshCw size={15} />{checking ? '检测中…' : '重新检测插件'}</Button>
      </div>
      <p className="panelnote">连接中断后会自动重试，回到此页面也会重新检测；恢复连接只做检测。打开前会核对工作台当前店铺范围，无法确认时不打开其他店铺的面板。打开确认超时后不会自动重发，请先查看卖家标签页。</p>
      <p className="panelnote">打开入口只显示面板。扫描和提交由你在面板中分别启动；“一键开启”会实际填写申报价格并提交开启请求。</p>
      {error&&<div className="banner danger" role="alert">{error}</div>}
      {connectionError&&connectionError!==error&&<div className="banner danger" role="alert">{connectionError}</div>}
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
        <li>首次安装后点“重新检测插件”。更新时在扩展管理页点“重新加载”，新版会自动重接当前工作台；看到“插件已连接”后再打开面板。</li>
      </ol>
      <p className="panelnote">找不到插件时，请确认工作台与卖家后台使用同一个浏览器和用户资料，并通过启动器打开 http://127.0.0.1:5173。也可以从统一插件的弹窗或侧边面板直接打开“流量加速器”。</p>
    </section>
  </div>;
}
