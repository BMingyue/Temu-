'use client';
import {Images,PackageCheck,Search,ArrowUpRight} from 'lucide-react';
const items=[
 ['selection','选品与采图','收集参考图、保留主题和来源，确定下一批上新的款式。',Search],
 ['images','GPT 批量生图','选择模板与印花，批量生成套图，逐步审核成图。',Images],
 ['listing','店小秘上架','已接入独立版。核对店铺模板、商品图与描述，再开始上架。',PackageCheck],
] as const;
export default function FocusHome({open}:{open:(tab:string)=>void}){
 return <><section className="focus-hero"><span>上新流程</span><h2>选品采图 → 批量生图 → 店小秘上架</h2><p>按顺序准备下一批商品。上架前检查图片、标题、模板和当前店铺。</p></section><div className="focus-grid launch-grid">{items.map(([id,title,detail,Icon],index)=><button key={id} onClick={()=>open(id)}><div><Icon size={23}/><b>0{index+1}</b></div><h2>{title}</h2><p>{detail}</p><span>进入功能 <ArrowUpRight size={15}/></span></button>)}</div></>;
}
