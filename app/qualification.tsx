'use client';
import {useEffect,useState} from 'react';
import {Button} from '@/components/ui/button';

const stageLabels:Record<string,string>={
 'environment-ok':'环境检查通过','awaiting-store-confirmation':'等待确认目标店铺','store-confirmed':'店铺已确认',
 'chrome-connected':'专用浏览器已连接','running':'正在自动处理','uploading':'正在上传实拍图',
 'uploading-qualification':'正在上传商品资质','confirming-warning':'正在确认警示声明',
 'complete':'全部处理完成','test-complete':'单商品测试成功','cancelled':'已取消，未开始','error':'运行遇到问题',
};

function RunStatus({state,kind}:{state:any,kind:'upload'|'confirm'}){
 const status=state.status||{},stage=String(status.stage||''),completed=stage==='complete'||stage==='test-complete',failed=stage==='error';
 const needsDesktopRestart=failed&&String(status.message||'').includes('专用 Chrome 启动失败');
 const phase=status.phase==='live-photos'?'正在上传四张实拍图':status.phase==='qualification-pdf'?'正在上传 GCC PDF':status.phase==='turning-page'?'正在检查下一页':stageLabels[stage]||'—';
 const updated=status.updatedAt?new Date(status.updatedAt).toLocaleString('zh-CN'):'暂无记录';
 return <section className="panel">
  <div className="sectionhead"><h2>{kind==='upload'?'上传工具最近状态':'确认工具最近状态'}</h2><span className={'tag '+(completed?'green':failed?'red':stage?'amber':'')}>{stageLabels[stage]||'暂无运行'}</span></div>
  <div className="statusrow"><span>目标店铺</span><strong>{status.store||'等待确认'}</strong></div>
  <div className="statusrow"><span>已完成商品</span><strong>{status.processed??0} 个</strong></div>
  <div className="statusrow"><span>当前商品</span><strong>{status.spu||status.lastSpu||'—'}</strong></div>
  <div className="statusrow"><span>当前步骤</span><strong>{phase}</strong></div>
  <div className="statusrow"><span>更新时间</span><span>{updated}</span></div>
  {status.message&&<div role={failed?'alert':'status'} className={'banner '+(failed?'danger':'')}>{status.message}</div>}
  {needsDesktopRestart&&<p className="panelnote">请在 Windows 文件夹中双击“重启工作台.vbs”；页面右上角的重启按钮只重启后台服务。</p>}
  <p className="panelnote">状态每 3 秒更新。页面结构异常、平台失败或超时会停止，并保留已完成进度。</p>
 </section>;
}

export default function Qualification(){
 const [upload,setUpload]=useState<any>({}),[confirm,setConfirm]=useState<any>({}),[message,setMessage]=useState(''),[busy,setBusy]=useState('');
 async function load(){
  const [a,b]=await Promise.all([fetch('/api/qualification-status'),fetch('/api/compliance-confirmation-status')]);
  if(!a.ok||!b.ok)throw Error('无法读取工具状态');setUpload(await a.json());setConfirm(await b.json());
 }
 useEffect(()=>{load().catch(e=>setMessage(e.message));const t=setInterval(()=>load().catch(()=>{}),3000);return()=>clearInterval(t)},[]);
 async function start(tool:'qualification'|'compliance_confirmation'){
  setBusy(tool);setMessage('');
  try{
   const r=await fetch('/api/launch',{method:'POST',headers:{'Content-Type':'application/json','X-Workbench':'local'},body:JSON.stringify({tool})});
   const v=await r.json() as any;if(!r.ok)throw Error(v.error);
   setMessage(tool==='qualification'
    ?'上方上传工具已打开。请在专用 Chrome 选好店铺，再点击“确认店铺并开始”。'
    :'下方确认工具已打开。请在专用 Chrome 选好店铺，再点击“确认店铺并开始”。');
   await load();
  }catch(e:any){setMessage(e.message)}finally{setBusy('')}
 }
 return <>
  <section className="panel">
   <div className="sectionhead"><div><h2>上 · 商品资质自动上传</h2><p>筛选“未发布到站点”的 GCC 地垫，依次补齐实拍图和检测报告。</p></div><span className={'tag '+(upload.available?'green':'red')}>{upload.available?'v'+upload.version+' 已就绪':'本地工具未找到'}</span></div>
   <div className="listingsteps">
    {[
     ['01','确认店铺','在专用 Chrome 切换到本次目标店铺'],['02','筛选商品','自动选择“未发布到站点”的 GCC 地垫'],
     ['03','补齐实拍图','已有四张图时跳过，缺图时只补空位'],['04','提交资质','上传 GCC PDF，完成后自动翻页'],
    ].map(([n,title,detail])=><div key={n}><b>{n}</b><p><strong>{title}</strong><br/><small>{detail}</small></p></div>)}
   </div>
   <div className="buttons"><Button onClick={()=>start('qualification')} disabled={!!busy||!upload.available}>{busy==='qualification'?'正在打开…':'开始上传实拍图和 GCC'}</Button></div>
   <p className="panelnote">四张图片和 GCC 检测报告已内置在工作台，无需再依赖 D 盘素材目录。</p>
  </section>
  <RunStatus state={upload} kind="upload"/>
  <section className="panel">
   <div className="sectionhead"><div><h2>下 · 小地垫警示声明确认</h2><p>进入“商品合规信息”，只处理“小地垫易燃警示声明 · 待确认”的地垫。</p></div><span className={'tag '+(confirm.available?'green':'red')}>{confirm.available?'v'+confirm.version+' 已就绪':'本地工具未找到'}</span></div>
   <div className="listingsteps">
    {[
     ['01','确认店铺','每次运行都先核对目标店铺'],['02','识别待办','只匹配地垫和“待确认”警示声明'],
     ['03','核对页面','声明已选、责任框已勾选后才继续'],['04','确认并翻页','点击确认，处理完当前页后自动下一页'],
    ].map(([n,title,detail])=><div key={n}><b>{n}</b><p><strong>{title}</strong><br/><small>{detail}</small></p></div>)}
   </div>
   <div className="buttons"><Button onClick={()=>start('compliance_confirmation')} disabled={!!busy||!confirm.available}>{busy==='compliance_confirmation'?'正在打开…':'开始确认警示声明'}</Button></div>
   <p className="panelnote">此工具不会上传图片或 PDF，也不会填写加州 65 或包装材料；它只确认页面上已经选好的小地垫警示声明。</p>
  </section>
  <RunStatus state={confirm} kind="confirm"/>
  {message&&<div role="status" className="banner success">{message}</div>}
  <p className="panelnote">两个工具彼此独立，同一时间只允许运行一个。每次启动都必须在独立窗口确认店铺；取消或关闭窗口会安全退出。</p>
 </>;
}
