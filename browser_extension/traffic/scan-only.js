(function(root){
 'use strict';
 const D=root.TrafficDOM,R=root.TrafficRules,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 async function collect(config,options){
  const saved=R.validate(config),started=new Date().toISOString(),mutable=options.allowCompletedRemoval===true;
  const check=options.gate||(async()=>{if(!D.allowedPage())throw Error('已离开流量分析页面')});
  const gate=async()=>{
   do{await check();if(root.__trafficReadOnlyStop)throw Error('用户已停止只读测试');const problem=D.serverProblem();if(problem)throw Error('页面提示服务器或网络异常，已停止，未自动重试：'+problem);if(document.visibilityState!=='hidden')return;await sleep(250)}while(true);
  };
  async function waitInfo(message){
   await options.onLoading?.({message});
   let deadline=Date.now()+saved.timeoutMs,last='',since=0,lastError;
   while(Date.now()<deadline){
    const before=Date.now();await gate();deadline+=Date.now()-before;
    let info;try{info=D.pageInfo()}catch(error){lastError=error;last='';await sleep(200);continue}
    if(info.total===null||!info.pageSize||D.loading()){last='';await sleep(200);continue}
    const signature=[info.current,info.total,info.pageSize,info.last].join(',');
    if(signature!==last){last=signature;since=Date.now()}
    if(Date.now()-since>=Math.min(info.total===0?900:300,saved.timeoutMs/2))return info;
    await sleep(200);
   }
   throw Error(message+'等待超时'+(lastError?'：'+lastError.message:''));
  }
  const initial=await waitInfo('等待商品分页加载');
  const total=initial.total,size=initial.pageSize,seen=new Set(),pages=[],items=[];let rowCount=0,previousPage='',lastIdentityError='';
  const summary=complete=>({version:'1.0.7',started,finished:new Date().toISOString(),complete,total,scanned:seen.size,rowsRead:rowCount,uniqueSpu:new Set(items.map(item=>item.id)).size,matched:items.filter(item=>item.matched).length,pages,items});
  function validate(info){
   if(info.pageSize!==size)throw Error('运行中更改了每页条数，已停止；请在停止状态设置好后重新扫描');
   const completed=mutable?Number(options.completedCount?.()||0):0;
   if(info.total>total||info.total<total-completed)throw Error('列表总数发生了非本轮成功造成的变化，请保持筛选条件后重试');
   if(!mutable&&info.total!==total)throw Error('列表总数被其他操作改变，请保持筛选条件后重试');
   return info;
  }
  const pageWait=async()=>{
   let remaining=saved.scanPageDelayMs;await options.onWait?.({seconds:Math.ceil(remaining/1000)});
   while(remaining>0){await gate();const step=Math.min(250,remaining);await sleep(step);remaining-=step;if(remaining>0&&remaining%1000===0)await options.onWait?.({seconds:Math.ceil(remaining/1000)})}
   await gate();
  };
  async function ready(number,allowSame){
   const before=validate(await waitInfo('等待第'+number+'页分页加载'));
   if(mutable&&number>Math.max(1,Math.ceil(before.total/size))&&before.current!==number)return{redirect:before.current};
   const progress=details=>options.onProgress?.({page:number,expected:Math.max(0,Math.min(size,before.total-(number-1)*size)),observed:D.products().length,...details});
   progress({percent:0});await sleep(1000);await D.revealRows(gate,progress);
   let deadline=Date.now()+saved.timeoutMs,last='',since=0,observed=0,expected=before.expected;
   while(Date.now()<deadline){
    const pausedAt=Date.now();await gate();deadline+=Date.now()-pausedAt;
    let info;try{info=D.pageInfo()}catch{await sleep(250);continue}
    if(info.total===0&&total>0&&(!mutable||Number(options.completedCount?.()||0)<total)){await sleep(250);continue}
    validate(info);
    if(mutable&&number>Math.max(1,Math.ceil(info.total/size))&&info.current!==number)return{redirect:info.current};
    try{await D.refreshIdentities();lastIdentityError=''}catch(error){lastIdentityError=error.message;observed=D.products().length;await sleep(250);continue}
    const products=D.products(),keys=products.map(product=>product.key);if(observed!==products.length)progress({});observed=products.length;
    expected=Math.max(0,Math.min(size,info.total-(number-1)*size));
    const signature=keys.join(',');
    if(info.current===number&&products.length===expected&&keys.every(Boolean)&&new Set(keys).size===keys.length&&!D.loading()&&(allowSame||signature!==previousPage)){
     const stable=[info.total,signature].join(':');if(stable!==last){last=stable;since=Date.now()}
     if(Date.now()-since>=Math.min(900,saved.timeoutMs/2))return{info,products,signature};
    }else{last='';since=0}
    await sleep(250);
   }
   throw Error('第'+number+'页读取不完整：应有'+expected+'件，实际识别'+observed+'件。未自动重试'+(lastIdentityError?'；'+lastIdentityError:''));
  }
  try{
   const pageCount=Math.ceil(total/size);
   await options.onScope?.({total,pageSize:size,pageCount,lastPageExpected:total===0?0:total-(pageCount-1)*size});
   if(total===0)return summary(true);
   if(pageCount>saved.maxPages)throw Error('网站页数超过扫描页数上限');
   if(initial.current!==1){await pageWait();D.firstPage()}
   let number=1,allowSame=false,iterations=0;
   while(iterations++<saved.maxPages){
    const result=await ready(number,allowSame);
    if(result.redirect){number=result.redirect;allowSame=true;continue}
    const{info,products,signature}=result;previousPage=signature;rowCount+=products.length;
    const fresh=products.filter(product=>!seen.has(product.key));
    const freshItems=fresh.map(product=>{const match=R.matchProduct(product,saved);return{id:product.id,goodsId:product.goodsId,key:product.key,title:product.title,category:product.category,tags:product.tags,hidden:product.hidden,opportunity:product.opportunity,matched:match.ok,reason:match.reason,page:number,pass:1}});
    fresh.forEach(product=>seen.add(product.key));items.push(...freshItems);
    const coverage={pass:1,page:number,pageSize:size,expected:info.expected,scanned:products.length,uniqueAdded:fresh.length,uniqueTotal:seen.size,duplicate:products.length-fresh.length,matched:freshItems.filter(item=>item.matched).length};pages.push(coverage);
    await options.onPage?.({page:info,products:fresh,items:freshItems,coverage});
    await gate();
    // All original items have been read and processed. Own successful removals may
    // temporarily destroy the footer; no additional page is needed in this case.
    if(mutable&&seen.size===total)return summary(true);
    const after=validate(await waitInfo('等待处理后的商品分页加载'));
    if(!mutable&&seen.size===total)return summary(true);
    if(mutable&&after.total<info.total){
     await options.onLoading?.({message:'本轮成功后列表剩余'+after.total+'条，继续核对当前页补入的商品'});
     number=after.current;allowSame=true;continue;
    }
    if(number>=Math.max(1,Math.ceil(after.total/size))){if(!after.last)throw Error('末页状态异常，页数可能改变');break}
    await pageWait();
    const next=validate(await waitInfo('等待下一页按钮就绪'));
    if(mutable&&next.total<after.total){number=next.current;allowSame=true;continue}
    if(next.last||next.current!==number||!next.next)throw Error('页码被其他任务改变，停止以避免跳页');
    D.click(next.next);number++;allowSame=false;
   }
   throw Error('已读取'+rowCount+'条页面记录，但仅覆盖'+seen.size+'/'+total+'个独立商品；覆盖不足或达到页数上限，已停止，不自动重扫');
  }catch(error){error.partial=summary(false);throw error}
 }
 async function run(config,options={}){
  if(root.__trafficScanRunning)throw Error('当前页面已有扫描任务，请先停止或等待完成');
  root.__trafficScanRunning=true;let paused=false,completed=false,result,stage='pause_auto_updates';
  try{
   await options.onLoading?.({message:'核对并暂停工作台自动更新'});
   paused=await D.pauseUpdater();stage='scan_list';
   result=await collect(config,options);completed=true;return result;
  }
  catch(error){
   error.trafficStage=error.trafficStage||stage;
   if(stage==='pause_auto_updates')error.message='准备扫描时无法确认自动更新状态：'+error.message;
   if(paused)error.message+='；原工作台自动更新保持暂停，避免继续请求';throw error;
  }
  finally{
   try{
    if(paused&&completed){
     try{await D.restoreUpdater()}
     catch(error){error.trafficStage='restore_auto_updates';error.partial=result;error.message='列表扫描已完成，但恢复自动更新失败：'+error.message;throw error}
    }
   }finally{root.__trafficScanRunning=false}
  }
 }
 root.TrafficScanOnly={run};
})(globalThis);
