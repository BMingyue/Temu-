'use client';
import {useEffect,useRef,useState} from 'react';
import {Textarea} from '@/components/ui/textarea';
import {Button} from '@/components/ui/button';
type Row=Record<string,any>;
export default function PromptEditor({onChange,usedPrompt}:{onChange:(value:string|null)=>void,usedPrompt?:string}){
 const [attempt,setAttempt]=useState(0);
 const [text,setText]=useState(''),[ready,setReady]=useState(false),[status,setStatus]=useState('正在读取上次提示词…'),[lastUsed,setLastUsed]=useState('');
 const version=useRef(0),saved=useRef(''),queue=useRef(Promise.resolve());
 useEffect(()=>{let live=true;setStatus('正在读取上次提示词…');fetch('/api/image-jobs/prompt').then(async r=>{if(!r.ok)throw Error('提示词服务未连接');return await r.json() as Row}).then(v=>{if(!live)return;version.current=v.version;saved.current=v.prompt;setText(v.prompt);setLastUsed(v.last_used_prompt||'');setReady(true);setStatus('已读取保存内容');onChange(v.prompt)}).catch(e=>{if(live)setStatus(e.message)});return()=>{live=false}},[onChange,attempt]);
 function persist(value:string){queue.current=queue.current.catch(()=>{}).then(async()=>{if(value===saved.current)return;if(!value.trim()){setStatus('提示词为空，未覆盖上次保存内容');return}setStatus('保存中…');try{const r=await fetch('/api/image-jobs/prompt',{method:'POST',headers:{'Content-Type':'application/json','X-Workbench':'local'},body:JSON.stringify({prompt:value,version:version.current})});const v=await r.json() as Row;if(!r.ok)throw Error(v.error);version.current=v.version;saved.current=value;setStatus('已自动保存到本机')}catch(e:any){setStatus('保存失败：'+e.message);throw e}});queue.current.catch(()=>{});}
 useEffect(()=>{if(!ready)return;const t=setTimeout(()=>persist(text),500);return()=>clearTimeout(t)},[text,ready]);
 function edit(value:string){setText(value);onChange(value);setStatus('有修改，等待保存…')}
 return <div className="formstack"><label className="field"><span>本批次附加要求 · 系统会自动补全套图生图协议</span><Textarea aria-label="生图附加要求" rows={7} disabled={!ready} value={text} maxLength={12000} onChange={e=>edit(e.target.value)} onBlur={()=>ready&&persist(text)}/></label><p className="panelnote">这里只填写本批商品的额外修改要求。创建任务时，系统会强制追加：参考图与模板 ZIP 的角色、按 ZIP 内每张模板分别调用生图工具、输出相同数量的单独图片、禁止拼图和禁止只回复文字。可使用 {'{total}'} 表示模板数量、{'{category}'} 表示商品类型；无论这里写得多短，都不会再覆盖固定协议。</p><div className="buttons"><Button variant="outline" disabled={!ready||!text.trim()} onClick={()=>persist(text)}>保存附加要求</Button><Button variant="outline" disabled={!(usedPrompt||lastUsed)} onClick={()=>edit(usedPrompt||lastUsed)}>恢复上次使用的附加要求</Button>{!ready&&<Button variant="outline" onClick={()=>setAttempt(v=>v+1)}>重试读取附加要求</Button>}<span role="status">{status}</span></div></div>;
}
