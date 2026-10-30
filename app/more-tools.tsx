'use client';
import {Button} from '@/components/ui/button';
import {tools} from './workbench-navigation';
export default function MoreTools({open}:{open:(tab:string)=>void}){return <section className="panel"><div className="sectionhead"><div><h2>辅助与设置</h2><p>导入数据、查看历史快照、记录处理动作，以及调整本地观察线。</p></div></div><div className="more-grid">{tools.filter(item=>'extra' in item&&item.extra).map(item=><Button key={item.id} variant="outline" onClick={()=>open(item.id)}>{item.title}</Button>)}</div></section>}
