'use client';
import {ArrowUpRight} from 'lucide-react';
import {Button} from '@/components/ui/button';

export default function FileTools({available,busy,onLaunch}:{available:boolean;busy:boolean;onLaunch:()=>void}){
 return <section className="panel">
  <div className="sectionhead"><div><h2>长文件名 / 长路径迁移</h2><p>打开你的长路径迁移助手，批量复制商品图片文件夹，保留原文件和目录结构。</p></div><span className="tag">{available?'本地工具可用':'工具未找到'}</span></div>
  <div className="listingsteps">{[
   '选择源文件夹，以及接收文件的目标位置',
   '默认复制所有直属子文件夹；取消勾选可复制整个文件夹',
   '点击开始复制，在工具窗口查看进度和日志',
   '复制完成后打开结果，核对文件数量与图片内容',
  ].map((text,index)=><div key={text}><b>0{index+1}</b><p>{text}</p></div>)}</div>
  <Button disabled={busy||!available} onClick={onLaunch}>打开长文件名迁移工具<ArrowUpRight size={16}/></Button>
  <p className="panelnote">源文件始终保留。目标中有同名目录时，会创建带编号的新目录。默认子文件夹模式不复制源目录内的散文件。</p>
  <p className="panelnote">停止后保持工具窗口、模式和路径不变，可点击“重试 / 继续”。关闭窗口后再次运行会视为新任务。</p>
  <p className="panelnote">此入口打开本地工具窗口；复制进度和结果请在该窗口查看。长路径支持不能突破单个文件名长度、磁盘空间和文件权限限制。</p>
 </section>;
}
