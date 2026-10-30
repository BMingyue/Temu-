const assert=require('node:assert/strict'),{test}=require('node:test'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('./browser_extension/content.js','utf8').split('chrome.runtime.onMessage.addListener')[0];
const dimensions={'实时':0,'近1日':1,'近7日':4,'近30日':5,'本周':2,'本月':3};
function assertSafeDiagnostics(diagnostics){
 assert.deepEqual(Object.keys(diagnostics).sort(),['bodyStatus','mallMatch','overview','overviewPayload','trend','trendPayload','usContractEvidence']);
 for(const key of ['mallMatch','overview','overviewPayload','trend','trendPayload'])assert.equal(typeof diagnostics[key],'boolean');
 assert.deepEqual(Object.keys(diagnostics.bodyStatus).sort(),['overview','trend']);
 const statuses=['missing_diagnostics','no_before_request','unavailable','access_denied','parse_failed','raw_present','read_failed','other','no_raw'];
 for(const value of Object.values(diagnostics.bodyStatus))assert.ok(statuses.includes(value));
 assert.deepEqual(Object.keys(diagnostics.usContractEvidence).sort(),['headersAfterRestore','overviewExactPost','rangeReady','refreshed','trendExactPost']);
 assert.ok(Object.values(diagnostics.usContractEvidence).every(value=>typeof value==='boolean'));
}
function harness(options={}){
 let now=121001,selected='近1日',polls=0,detailClicks=0,pending=null;
 const clicks=[],published=[],captures={...(options.captures||{})};
 const publish=label=>{
  now++;published.push(label);
  for(const kind of ['flow','flow_trend']){
   if(kind===options.missingKind)continue;
   captures[kind]={requestId:kind+now,capturedAt:now,requestStartedAt:options.missingStartedAt||(options.contract&&!options.preservePayload)?undefined:options.stale?1:now,
   headers:{mallid:kind==='flow_trend'&&options.mismatchTrend?'999':options.mall||'123'},payload:options.missingPayload||(options.contract&&!options.preservePayload)?null:{timeDimension:options.range==null?dimensions[label]:options.range,...(kind==='flow'?{siteId:100}:{channel:7})}};
   if(options.contract)Object.assign(captures[kind],{requestMethod:'POST',requestPath:'https://agentseller-us.temu.com/api/flow/analysis/'+(kind==='flow'?'overview':'trend'),headersCapturedAt:now,
    requestBodyDiagnostics:{method:'POST',hasBeforeRequest:false,bodyError:null,rawPartCount:0,rawByteTotal:0,parseError:false}});
   if(options.capturePatch)options.capturePatch(captures[kind],kind,{now,label});
  }
 };
 const controls=Object.keys(dimensions).map(label=>({textContent:label,get className(){return selected===label&&!options.noSelection?'TAB_tabItem TAB_active_5-120-1':'TAB_tabItem'},
  getClientRects:()=>[{}],click(){clicks.push(label);if(options.noChange&&label==='实时')return;selected=label;if(options.noNative)return;if(options.debounce)pending={label,at:now+500};else publish(label)}}));
 const group={querySelectorAll:()=>controls};
 const title={textContent:'汇总分析 统计时间 实时 近1日 近7日 近30日 本周 本月',getClientRects:()=>[{}],closest:()=>({}),querySelectorAll:()=>options.duplicateGroups?[group,group]:[group]};
 const detail={querySelectorAll:()=>[],click:()=>detailClicks++};
 const document={querySelectorAll:selector=>selector.includes('total-overview_topTit')?(now<(options.hydrateAt||0)?[]:[title]):[detail]};
 const hostname=options.hostname||'agentseller-us.temu.com';
 const context={Date:{now:()=>now},URL,document,location:{hostname,origin:options.origin||'https://'+hostname,pathname:options.pathname||'/main/flux-analysis'},
  setTimeout:fn=>{now+=250;if(pending&&now>=pending.at){const label=pending.label;pending=null;publish(label)}fn();return 1},chrome:{runtime:{sendMessage:async message=>{
   polls++;const captured=captures[message.kind];
   return captured&&now-Number(captured.capturedAt||0)<120000?captured:{headers:{},payload:null};
  }}}};
 vm.createContext(context);vm.runInContext(source+';globalThis.prepare=prepareCapturedRequest;',context);
 return {run:()=>context.prepare({tabId:7,payload:{mallId:options.expectedMall===undefined?'123':options.expectedMall}},'flow'),stats:()=>({clicks,published,selected,polls,detailClicks})};
}
test('expired captures refresh the summary once and restore its original range with native filters',async()=>{
 const h=harness({captures:{flow:{capturedAt:1,headers:{mallid:'123'},payload:{timeDimension:1}}}}),result=await h.run();
 assert.deepEqual(h.stats().clicks,['实时','近1日']);assert.equal(h.stats().selected,'近1日');assert.equal(h.stats().detailClicks,0);
 assert.equal(result.payload.timeDimension,1);assert.equal(result.trendPayload.timeDimension,1);
 assert.equal(result.payload.siteId,100);assert.equal(result.trendPayload.channel,7);
});
test('already captured matching native overview and trend need no UI action',async()=>{
 const captures={};for(const kind of ['flow','flow_trend'])captures[kind]={requestId:kind,capturedAt:121000,headers:{mallid:'123'},payload:{timeDimension:1}};
 const h=harness({captures});await h.run();assert.equal(h.stats().clicks.length,0);
});
test('late hydration is allowed before one summary refresh',async()=>{
 const h=harness({hydrateAt:125001});await h.run();assert.deepEqual(h.stats().clicks,['实时','近1日']);
});
test('debounced native queries are dispatched before restoring the original summary range',async()=>{
 const h=harness({debounce:true});await h.run();
 assert.deepEqual(h.stats().published,['实时','近1日']);assert.deepEqual(h.stats().clicks,['实时','近1日']);
});
test('intermediate range and stale original-range captures cannot satisfy restored summary',async()=>{
 for(const options of [{range:0},{stale:true}]){
  const h=harness(options);await assert.rejects(h.run(),/当前店铺的概览与趋势请求/);
  assert.deepEqual(h.stats().clicks,['实时','近1日']);assert.equal(h.stats().selected,'近1日');
 }
});
test('late headers on an old body and captures without a body-start timestamp cannot pass the refresh boundary',async()=>{
 for(const options of [{stale:true},{missingStartedAt:true}]){
  const h=harness(options);await assert.rejects(h.run(),/当前店铺的概览与趋势请求/);
  assert.deepEqual(h.stats().clicks,['实时','近1日']);
 }
});
test('refreshed requests still require matching numeric mall and endpoint payloads',async()=>{
 for(const options of [{mall:'999'},{mall:'invalid'},{mismatchTrend:true},{missingPayload:true},{missingKind:'flow_trend'},{missingKind:'flow'}]){
  const h=harness(options);await assert.rejects(h.run(),/当前店铺的概览与趋势请求/);
  assert.deepEqual(h.stats().clicks,['实时','近1日']);
 }
});
test('changing active styles without any native query cannot satisfy capture readiness',async()=>{
 const h=harness({noNative:true});await assert.rejects(h.run(),/当前店铺的概览与趋势请求/);
 assert.deepEqual(h.stats().clicks,['实时','近1日']);assert.equal(h.stats().selected,'近1日');
});
test('ambiguous summary groups, missing selection, and other pages never click detail controls',async()=>{
 for(const options of [{duplicateGroups:true},{noSelection:true},{pathname:'/goods/list'},{hostname:'example.com'}]){
  const h=harness(options);await assert.rejects(h.run(),/当前店铺的概览与趋势请求/);
  assert.equal(h.stats().clicks.length,0);assert.equal(h.stats().detailClicks,0);
 }
});
test('failed intermediate selection restores original range and stops',async()=>{
 const h=harness({noChange:true});await assert.rejects(h.run(),/时间范围未能刷新/);
 assert.deepEqual(h.stats().clicks,['实时','近1日']);assert.equal(h.stats().selected,'近1日');
});
test('timeout diagnostics use only the fixed safe schema',async()=>{
 const h=harness({mall:'999'});
 await assert.rejects(h.run(),error=>{
  const diagnostics=JSON.parse(error.technicalInfo);
  assertSafeDiagnostics(diagnostics);
  assert.equal(diagnostics.mallMatch,false);assert.equal(error.message.includes('999'),false);assert.equal(error.message.includes('siteId'),false);
  assert.equal(error.message.includes('{'),false);assert.equal(error.message.includes('overviewPayload'),false);
  return true;
 });
});
test('content response propagates only the separate safe technical diagnostics',async()=>{
 let listener;
 const completeSource=fs.readFileSync('./browser_extension/content.js','utf8').split('if (!document.getElementById("temuCollectorRoot"))')[0];
 const context={crypto:{randomUUID:()=> 'request1'},setTimeout:(fn,ms)=>{if(ms===250)fn();return 1},clearTimeout(){},
  window:{addEventListener(){},removeEventListener(){}},
  chrome:{runtime:{onMessage:{addListener:fn=>listener=fn},sendMessage:async()=>({headers:{},payload:null})}}};
 vm.createContext(context);vm.runInContext(completeSource,context);
 const response=await new Promise(resolve=>listener({type:'TEMU_COLLECT',command:'FLOW',payload:{mallId:'123'}},{},resolve));
 assert.equal(response.success,false);assert.equal(response.error.includes('{'),false);
 assert.deepEqual(Object.keys(response).sort(),['error','success','technicalInfo']);
 const diagnostics=JSON.parse(response.technicalInfo);
 assertSafeDiagnostics(diagnostics);
});
test('verified US summary contract recovers two missing bodies after fresh native header evidence',async()=>{
 const h=harness({contract:true}),result=await h.run();
 assert.deepEqual(h.stats().clicks,['实时','近1日']);assert.equal(h.stats().selected,'近1日');
 assert.deepEqual(Object.keys(result.payload),['timeDimension']);assert.equal(result.payload.timeDimension,1);
 assert.deepEqual(Object.keys(result.trendPayload).sort(),['timeDimension','trendType']);assert.equal(result.trendPayload.timeDimension,1);assert.equal(result.trendPayload.trendType,1);
 assert.equal(result.requestStartedAt,undefined);
});
test('complete native bodies remain primary even when US header contract evidence is available',async()=>{
 const h=harness({contract:true,preservePayload:true}),result=await h.run();
 assert.equal(result.payload.siteId,100);assert.equal(result.trendPayload.channel,7);
});
test('US contract fallback rejects one missing body, malformed bodies, and mixed native evidence',async()=>{
 for(const capturePatch of [
  (item,kind)=>{if(kind==='flow')item.payload={timeDimension:1,siteId:999}},
  (item,kind)=>{if(kind==='flow_trend')item.payload={timeDimension:1,channel:999}},
  item=>{item.payload=false},
  (item,kind)=>{if(kind==='flow_trend')item.headers.mallid='999'},
  item=>{item.requestId='same-request'}
 ]){
  const h=harness({contract:true,capturePatch});await assert.rejects(h.run(),/当前店铺的概览与趋势请求/);
 }
});
test('US contract fallback rejects CN, different origin or page, and invalid expected mall',async()=>{
 for(const options of [{hostname:'agentseller.temu.com'},{origin:'http://agentseller-us.temu.com'},{pathname:'/goods/list'},{expectedMall:''},{expectedMall:'invalid'}]){
  const h=harness({contract:true,...options});await assert.rejects(h.run(),/当前店铺的概览与趋势请求/);
 }
});
test('US contract fallback requires exact POST endpoints with independent wire headers',async()=>{
 for(const capturePatch of [
  item=>{item.requestMethod='GET'},
  item=>{delete item.requestMethod},
  item=>{item.requestPath='https://agentseller.temu.com/api/flow/analysis/overview'},
  item=>{item.requestPath+='-other'},
  item=>{item.headers={}},
  item=>{delete item.headersCapturedAt},
  item=>{item.headersCapturedAt=1},
  (item,_kind,{now})=>{item.headersCapturedAt=now+999999}
 ]){
  const h=harness({contract:true,capturePatch});await assert.rejects(h.run(),/当前店铺的概览与趋势请求/);
 }
});
test('US contract fallback still requires the unique visible summary range',async()=>{
 for(const options of [{duplicateGroups:true},{noSelection:true}]){
  const h=harness({contract:true,...options});await assert.rejects(h.run(),/当前店铺的概览与趋势请求/);assert.equal(h.stats().clicks.length,0);
 }
});
test('US contract fallback accepts only explicitly absent bodies from known unavailable, denied, or failed-read states',async()=>{
 for(const hasBeforeRequest of [false,true])for(const bodyError of [null,'unavailable','access_denied','read_failed']){
  const h=harness({contract:true,capturePatch:item=>Object.assign(item.requestBodyDiagnostics,{hasBeforeRequest,bodyError})});
  const result=await h.run();assert.equal(result.payload.timeDimension,1);assert.equal(result.trendPayload.trendType,1);
 }
});
test('US contract fallback rejects missing diagnostics, raw body evidence, parse failures, and uncertain read errors on either endpoint',async()=>{
 for(const badKind of ['flow','flow_trend'])for(const change of [
  item=>{delete item.requestBodyDiagnostics},
  item=>{item.requestBodyDiagnostics={}},
  item=>{item.requestBodyDiagnostics.parseError=true},
  item=>{item.requestBodyDiagnostics.rawPartCount=1},
  item=>{item.requestBodyDiagnostics.rawByteTotal=16},
  item=>{item.requestBodyDiagnostics.rawPartCount='0'},
  item=>{item.requestBodyDiagnostics.hasBeforeRequest='false'},
  item=>{item.requestBodyDiagnostics.bodyError='other'},
  item=>{delete item.requestBodyDiagnostics.bodyError}
 ]){
  const h=harness({contract:true,capturePatch:(item,kind)=>{if(kind===badKind)change(item)}});
  await assert.rejects(h.run(),/当前店铺的概览与趋势请求/);
 }
});
test('failed-read fallback still rejects raw or parse evidence, wrong mall, missing diagnostics, and non-US requests',async()=>{
 for(const options of [
  {change:item=>{item.requestBodyDiagnostics.rawPartCount=1}},
  {change:item=>{item.requestBodyDiagnostics.rawByteTotal=16}},
  {change:item=>{item.requestBodyDiagnostics.parseError=true}},
  {change:item=>{item.headers.mallid='999'}},
  {change:item=>{delete item.requestBodyDiagnostics}},
  {change:item=>{item.requestPath='https://agentseller.temu.com/api/flow/analysis/overview'}},
  {hostname:'agentseller.temu.com'},
  {change:item=>{item.requestMethod='GET'}},
  {change:item=>{delete item.headersCapturedAt}}
 ]){
  const h=harness({contract:true,hostname:options.hostname,capturePatch:item=>{
   item.requestBodyDiagnostics.bodyError='read_failed';if(options.change)options.change(item);
  }});
  await assert.rejects(h.run(),/当前店铺的概览与趋势请求/);
 }
});
test('failure diagnostics classify body evidence without copying unknown errors or wire values',async()=>{
 const cases=[
  ['missing_diagnostics',item=>{delete item.requestBodyDiagnostics}],
  ['no_before_request',()=>{}],
  ['unavailable',item=>{item.requestBodyDiagnostics.bodyError='unavailable'}],
  ['access_denied',item=>{item.requestBodyDiagnostics.bodyError='access_denied'}],
  ['parse_failed',item=>{item.requestBodyDiagnostics.parseError=true}],
  ['raw_present',item=>{item.requestBodyDiagnostics.rawPartCount=1}],
  ['read_failed',item=>{item.requestBodyDiagnostics.bodyError='read_failed'}],
  ['other',item=>{item.requestBodyDiagnostics.bodyError='secret-original-error-812934'}],
  ['no_raw',item=>{item.requestBodyDiagnostics.hasBeforeRequest=true}]
 ];
 for(const [expected,change] of cases){
  const h=harness({contract:true,mall:'999',capturePatch:item=>{
   item.headers.Authorization='secret-header-812934';item.requestPath+='?secret-query-812934';change(item);
  }});
  await assert.rejects(h.run(),error=>{
   const diagnostics=JSON.parse(error.technicalInfo);assertSafeDiagnostics(diagnostics);
   assert.equal(diagnostics.bodyStatus.overview,expected);assert.equal(diagnostics.bodyStatus.trend,expected);
   assert.equal(error.technicalInfo.includes('812934'),false);assert.equal(error.technicalInfo.includes('999'),false);
   assert.equal(error.message.includes('812934'),false);assert.equal(error.message.includes('{'),false);
   assert.equal(diagnostics.usContractEvidence.overviewExactPost,false);assert.equal(diagnostics.usContractEvidence.trendExactPost,false);
   return true;
  });
 }
});
