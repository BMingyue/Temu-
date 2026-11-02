/* Product-info badge rule, confirmed by the user: the complete native
 * flowGrowStatus=1 set is enabled; its complement within the requested catalog
 * batch is not enabled. Failed or incomplete queries never establish absence. */
(() => {
  const ORIGIN="https://agentseller-us.temu.com",PATH="/main/flux-analysis";
  const ENDPOINT="/api/flow/analysis/list",PAGE_SIZE=100,MAX_IDS=20,US_SITE=100;
  const STATE_RULE="flow_grow_badge_v1";
  const ATTENTION_RULE="temu_native_flow_limit_v1";
  // Historical official flux-analysis enum + its Chinese translation map:
  // numeric 2 alone renders 商品流量待关注; 1/3 are different warning labels.
  const ATTENTION_LABELS={0:"无商品流量待关注标记",1:"商品流量预测将下滑",2:"商品流量待关注",3:"商品流量近期有下滑"};
  // The seller page renders its product-info badge only for numeric status 1.
  // Its US site selector explicitly keeps siteId 100; product ID input becomes
  // a numeric productIdList. No eligibility or Max-mode filters are involved.
  const id=value=>{
    if(typeof value!=="string" && !(typeof value==="number"&&Number.isSafeInteger(value)))return "";
    const text=String(value).trim();
    return /^\d+$/.test(text)?text:"";
  };
  const object=value=>value!==null&&typeof value==="object"&&!Array.isArray(value);
  const usSiteName=value=>typeof value==="string"&&/^(?:美国(?:站)?|US|USA|United States(?: of America)?)$/i.test(value.trim());
  async function readBatch(payload={},postFn){
    if(!object(payload)||typeof postFn!=="function")throw Error("加速器查询缺少有效参数或原生请求器");
    const mall=id(payload.mallId),capturedMall=id(payload.capturedMallId),marker=payload.marker;
    if(!mall||capturedMall!==mall)throw Error("加速器查询店铺与原生请求 mallid 不匹配");
    if(typeof marker!=="string"||!marker.trim())throw Error("加速器查询缺少本轮辅助页面标识");
    if(!object(payload.requestHeaders))throw Error("加速器查询缺少原生请求头 mallid");
    const headers={...payload.requestHeaders},mallHeaders=Object.entries(headers).filter(([key])=>key.toLowerCase()==="mallid");
    if(mallHeaders.length!==1||id(mallHeaders[0][1])!==mall)throw Error("加速器查询请求头 mallid 与目标店铺不一致");
    const assertContext=()=>{
      let current;
      try{current=new URL(globalThis.location.href)}catch{throw Error("加速器查询无法确认当前页面")}
      if(current.origin!==ORIGIN||current.pathname!==PATH||current.searchParams.get("wb_accelerator_status")!==marker){
        throw Error("加速器查询仅能读取本轮独立的美国站流量页");
      }
    };
    assertContext();
    if(!Array.isArray(payload.productIds)||!payload.productIds.length||payload.productIds.length>MAX_IDS){
      throw Error("加速器每批须提供 1 至 20 个在售商品标识");
    }
    const productIds=[];
    for(const value of payload.productIds){
      const numericId=Number(id(value));
      if(!Number.isSafeInteger(numericId)||numericId<=0)throw Error("加速器查询包含无效商品标识");
      const productId=String(numericId);
      if(!productIds.includes(productId))productIds.push(productId);
    }
    const requested=new Set(productIds);
    // At most twenty single-site identities fit in one native 100-row page.
    // A larger total or a partial page invalidates the entire active set.
    // Legacy skcIdsBySpu is accepted but is irrelevant to this badge rule.
    const body={pageSize:PAGE_SIZE,pageNumber:1,timeDimension:1,productIdList:productIds.map(Number),siteIdList:[US_SITE],flowGrowStatus:1};
    const response=await postFn(ENDPOINT,body,{...headers},{label:"完整加速中标志集合"});
    assertContext();
    if(!object(response)||response.success!==true)throw Error("加速器原生列表接口未明确返回成功，不能判定未开启");
    const result=response.result;
    if(!object(result)||!Array.isArray(result.pageItems)||!Number.isSafeInteger(result.total)||result.total<0){
      throw Error("加速器原生列表缺少有效 pageItems/total，不能判定未开启");
    }
    const total=result.total,items=result.pageItems;
    if(total>productIds.length||items.length>PAGE_SIZE||items.length>total){
      throw Error("加速器列表超出本批商品范围或分页上界，未确认完整加速中集合");
    }
    if((Object.hasOwn(result,"pageNumber")&&result.pageNumber!==1)||
       (Object.hasOwn(result,"pageSize")&&result.pageSize!==PAGE_SIZE)){
      throw Error("加速器原生列表页码或每页条数不匹配");
    }
    for(const value of [response,result]){
      for(const key of ["mallId","mall_id"]){
        if(Object.hasOwn(value,key)&&id(value[key])!==mall)throw Error("加速器原生列表返回了其他店铺数据");
      }
      if((Object.hasOwn(value,"siteId")&&value.siteId!==US_SITE)||
         (Object.hasOwn(value,"siteName")&&!usSiteName(value.siteName))||
         (Object.hasOwn(value,"siteIdList")&&(!Array.isArray(value.siteIdList)||value.siteIdList.length!==1||value.siteIdList[0]!==US_SITE))){
        throw Error("加速器原生列表返回了其他站点范围，不能判定未开启");
      }
    }
    const active=new Set();
    for(const item of items){
      if(!object(item))throw Error("加速器原生商品行结构无效");
      const productId=id(item.productId);
      if(!productId||!requested.has(productId))throw Error("加速器原生列表包含本批范围外商品");
      if(item.siteId!==US_SITE||!usSiteName(item.siteName))throw Error("加速器原生列表站点标识或名称不匹配");
      for(const key of ["mallId","mall_id"]){
        if(Object.hasOwn(item,key)&&id(item[key])!==mall)throw Error("加速器原生商品行店铺不匹配");
      }
      if(active.has(productId))throw Error("加速器原生列表重复返回同一商品与站点，未确认完整加速中集合");
      if(!Object.hasOwn(item,"flowGrowStatus")||item.flowGrowStatus!==1){
        throw Error("加速中筛选未生效：返回行不是原始数字 flowGrowStatus=1，不能判定未开启");
      }
      active.add(productId);
    }
    if(items.length!==total)throw Error("加速器小批列表未读全：已返回 "+items.length+" / "+total+"，不能判定未开启");
    const attention=new Map();
    if(payload.includeTrafficAttention===true){
      // Read native rows without growing/eligibility/warning filters. Membership
      // in the separate enabled set cannot establish this independent badge.
      const attentionBody={pageSize:PAGE_SIZE,pageNumber:1,timeDimension:1,productIdList:productIds.map(Number),siteIdList:[US_SITE]};
      const attentionResponse=await postFn(ENDPOINT,attentionBody,{...headers},{label:"商品流量待关注原生标记"});
      assertContext();
      const value=attentionResponse?.result;
      if(!object(attentionResponse)||attentionResponse.success!==true||!object(value)||!Array.isArray(value.pageItems)||!Number.isSafeInteger(value.total)||value.total<0){
        throw Error("流量待关注原生列表未明确成功或缺少有效 pageItems/total，本批未保存");
      }
      if(value.total>productIds.length||value.pageItems.length!==value.total||value.pageItems.length>PAGE_SIZE){
        throw Error("流量待关注原生列表未读全或超出本批分页上界，本批未保存");
      }
      if((Object.hasOwn(value,"pageNumber")&&value.pageNumber!==1)||(Object.hasOwn(value,"pageSize")&&value.pageSize!==PAGE_SIZE)){
        throw Error("流量待关注原生列表页码或每页条数不匹配");
      }
      for(const scope of [attentionResponse,value]){
        for(const key of ["mallId","mall_id"]){
          if(Object.hasOwn(scope,key)&&id(scope[key])!==mall)throw Error("流量待关注原生列表返回其他店铺数据");
        }
        if((Object.hasOwn(scope,"siteId")&&scope.siteId!==US_SITE)||
           (Object.hasOwn(scope,"siteName")&&!usSiteName(scope.siteName))||
           (Object.hasOwn(scope,"siteIdList")&&(!Array.isArray(scope.siteIdList)||scope.siteIdList.length!==1||scope.siteIdList[0]!==US_SITE))){
          throw Error("流量待关注原生列表返回其他站点范围");
        }
      }
      for(const item of value.pageItems){
        if(!object(item))throw Error("流量待关注原生商品行结构无效");
        const productId=id(item.productId);
        if(!productId||!requested.has(productId)||attention.has(productId))throw Error("流量待关注原生列表商品范围外或身份重复");
        if(item.siteId!==US_SITE||!usSiteName(item.siteName))throw Error("流量待关注原生商品行站点不匹配");
        for(const key of ["mallId","mall_id"]){
          if(Object.hasOwn(item,key)&&id(item[key])!==mall)throw Error("流量待关注原生商品行店铺不匹配");
        }
        const code=Object.hasOwn(item,"flowLimitStatus")&&Number.isInteger(item.flowLimitStatus)&&Object.hasOwn(ATTENTION_LABELS,item.flowLimitStatus)?item.flowLimitStatus:null;
        attention.set(productId,code);
      }
    }
    const diagnostics=[];
    const rows=productIds.map(productId=>{
      const enabled=active.has(productId),message=enabled?
        "商品信息存在“流量加速中”标志：原生 flowGrowStatus=1":
        "本批同店美国站完整“流量加速中”集合已核对；商品不在集合，按用户确认的标志规则判为未开启";
      diagnostics.push({spuId:productId,code:enabled?"badge_present":"badge_absent",message});
      const code=attention.get(productId)??null;
      return {spuId:productId,skcId:"",skuId:"",siteId:US_SITE,siteName:"美国站",status:enabled?"enabled":"disabled",
        sourceUrl:ORIGIN+PATH,evidence:message,
        ...(payload.includeTrafficAttention===true?{trafficAttention:code===null?null:code===2,flowLimitStatus:code,
          trafficAttentionSource:code===null?"":ATTENTION_RULE,trafficAttentionLabel:code===null?"":ATTENTION_LABELS[code]}:{})};
    });
    return {success:true,sourceMallId:mall,stateRule:STATE_RULE,rows,missingIds:[],unknownIds:[],
      rawCount:items.length,total,pages:1,complete:true,detailRequests:0,diagnostics,
      ...(payload.includeTrafficAttention===true?{trafficAttentionRule:ATTENTION_RULE,trafficAttentionRows:attention.size,
        trafficAttentionKnown:rows.filter(row=>typeof row.trafficAttention==="boolean").length}: {})};
  }
  const api={readBatch};
  if(typeof module!=="undefined"&&module.exports)module.exports=api;
  else window.TemuAcceleratorQuery=api;
})();
