'use client';
import {useEffect,useState} from 'react';
import {Button} from '@/components/ui/button';
type BrowserStatus = {available?:boolean; running?:boolean; message?:string};
type OpenResult = {message?:string; error?:string};
export default function Onboarding({open,onClose}:{open:(tab:string)=>void;onClose:()=>void}) {
 const [browser,setBrowser]=useState<BrowserStatus>({});
 const [busy,setBusy]=useState(false),[message,setMessage]=useState(''),[error,setError]=useState('');
 useEffect(()=>{let active=true;fetch('/api/colleague-browser',{cache:'no-store'}).then(async r=>{if(!r.ok)throw Error('请先重启工作台加载新版本');return await r.json() as BrowserStatus}).then(value=>{if(active)setBrowser(value)}).catch(e=>{if(active)setError(e.message)});return()=>{active=false}},[]);
 async function launch(){setBusy(true);setError('');setMessage('');try{const response=await fetch('/api/colleague-browser/open',{method:'POST',headers:{'Content-Type':'application/json','X-Workbench':'local'},body:'{}'});const value=await response.json() as OpenResult;if(!response.ok)throw Error(value.error||'浏览器打开失败');setMessage(value.message||'采集浏览器已打开');setBrowser(previous=>({...previous,running:true}))}catch(e:unknown){setError(e instanceof Error?e.message:'浏览器打开失败，请运行安装目录里的“检查运行环境”。')}finally{setBusy(false)}}
 const visit=(tab:string)=>{open(tab);onClose()};
 return <section className="panel onboarding" aria-label="新同事使用指南">
  <div className="sectionhead"><div><span className="eyebrow">第一次使用，从这里开始</span><h2>登录自己的账号，就能开始工作</h2><p>迁移包先右键“全部解压”，再双击“安装织品工作台”。以后双击桌面“织品工作台”即可。</p></div><Button variant="outline" onClick={onClose}>收起指南</Button></div>
  {error&&<div role="alert" className="banner danger">{error}</div>}{message&&<output className="banner success">{message}</output>}
  <div className="onboarding-grid">
   <div><b>01</b><h3>连接店铺</h3><p>打开专用采集浏览器，登录自己的 Temu 美国站。浏览器已带工作台助手。登录后切换同一窗口的“织品工作台”标签，核对页面顶部的店铺名称。</p><Button onClick={launch} disabled={busy||!browser.available}>{busy?'正在打开…':browser.running?'回到采集浏览器':'打开采集浏览器'}</Button><small>首次使用要自己登录；登录资料只保存在这台电脑。</small></div>
   <div><b>02</b><h3>巡店和维护</h3><p>在“维护 → 采集任务中心”查看连接与采集结果，再到“巡店”核对预警。商品清单勾选后，可一次复制多个 SPU、查看所选或复制表格。</p><Button variant="outline" onClick={()=>visit('collector')}>查看采集任务</Button><small>复制后的编号可直接粘贴到后台搜索框。</small></div>
   <div><b>03</b><h3>准备上新</h3><p>“上新”集中放选品、生图和店小秘独立版。生图页可新增专用 Chrome 并登录自己的 ChatGPT；店小秘第一次打开也需自行登录、设置店铺模板。</p><Button variant="outline" onClick={()=>visit('home')}>进入上新</Button><small>先试一款，检查图片和模板，再处理整批。</small></div>
  </div>
  <p className="panelnote">迁移给同事：发送原始安装压缩包。安装后的文件夹含个人账号和数据，请保留在自己电脑。打不开时双击包内“检查运行环境”，将检查结果交给负责人。</p>
 </section>
}
